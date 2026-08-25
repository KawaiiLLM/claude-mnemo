import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  getLane,
  isLaneRegistrySettled,
  LANE_MODEL_V12_VOCABULARY_MERGE_RECEIPT,
  LANE_REGISTRY_M0_CLASSIFY_RECEIPT,
  LANE_REGISTRY_M2_SEED_RECEIPT,
  LANE_REGISTRY_M3_MEMBERSHIP_RECEIPT,
  LANE_REGISTRY_M4_DISPOSAL_RECEIPT,
  LANE_REGISTRY_NOT_APPLICABLE_RECEIPT,
  LANE_REGISTRY_PHASE_RECEIPTS,
  LaneMigrationOrderError,
  runLaneRegistryMigration,
  type LaneMigrationClassification,
  type LaneRegistryNotApplicableReceipt,
} from "../../src/db/lanes";
import { initializeSchema, runLaneModelV12EdgeMigration } from "../../src/db/schema";
import { createSegment } from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";

/**
 * Lane-model-v12 ticket 01 (spec D4): the ORDER between the unreleased
 * lane-declaration registry migration and the v12 edge-column work is a
 * stated, tested guarantee rather than an accident of call order in
 * `initializeSchema`.
 *
 * The registry migration's M0/M4 read and write `memory_edges.tags`; v12
 * replaces that column. Land the column change first and the whole batch is
 * voided at the first open of a released build, silently — which is why
 * every assertion here is about what the code REFUSES to do, never about
 * which line number sits above which.
 */

interface ReceiptRow {
  name: string;
  payload: string;
}

function readLaneReceipts(db: Database): ReceiptRow[] {
  return db
    .query<ReceiptRow, []>(
      `SELECT name, payload FROM migration_receipts
       WHERE name LIKE 'lane-declaration-%' OR name = 'lane-registry-not-applicable'
       ORDER BY name`,
    )
    .all();
}

function readPhasePayloads(db: Database): ReceiptRow[] {
  return db
    .query<ReceiptRow, []>(
      `SELECT name, payload FROM migration_receipts
       WHERE name LIKE 'lane-declaration-%' ORDER BY name`,
    )
    .all();
}

function clearLaneReceipts(db: Database): void {
  db.exec(
    `DELETE FROM migration_receipts
     WHERE name LIKE 'lane-declaration-%' OR name = 'lane-registry-not-applicable'`,
  );
  db.exec("DELETE FROM lanes");
}

/** The repo's failpoint idiom (see `transcript-path-backfill.test.ts`): abort the phase that inserts THIS receipt. */
function installReceiptFailpoint(db: Database, receiptName: string): void {
  db.exec(
    `CREATE TRIGGER lane_migration_failpoint BEFORE INSERT ON migration_receipts
     WHEN NEW.name = '${receiptName}'
     BEGIN SELECT RAISE(ABORT, 'injected crash'); END`,
  );
}

function removeReceiptFailpoint(db: Database): void {
  db.exec("DROP TRIGGER lane_migration_failpoint");
}

describe("lane migration ordering (v12 ticket 01): upgrade path", () => {
  let db: Database;
  let sessionId: number;
  let segmentId: number;
  let edgeId: number;

  /**
   * A database shaped like a real PRE-v12 one: today's `memory_edges` (a
   * `tags` JSON column carrying the identity key), a segment whose two turns
   * are members, and a tagged edge between them — exactly the row M0 has to
   * read and M2 has to seed a lane from. Built by initializing the real
   * schema and then resetting the receipt gates, the same "reset the gate,
   * not the schema" idiom `schema.lane-registry-migration.test.ts` uses.
   */
  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "lane-ordering-session",
      project: "/tmp/project-lane-ordering",
      title: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 100,
      completedAtEpoch: null,
    }).id;
    segmentId = createSegment(db, { title: "Pre-v12 segment", nowEpoch: 100 }).id;
    const turnIds = [1, 2].map(
      (promptNumber) =>
        db
          .query<{ id: number }, [number, number, number]>(
            `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch, was_rolled_back)
             VALUES (?, ?, 'active', ?, 0) RETURNING id`,
          )
          .get(sessionId, promptNumber, 100)!.id,
    );
    for (const turnId of turnIds) {
      db.query<unknown, [number, number, number]>(
        `INSERT INTO segment_members (segment_id, turn_id, created_at_epoch) VALUES (?, ?, ?)`,
      ).run(segmentId, turnId, 100);
    }
    edgeId = db
      .query<{ id: number }, [number, number, number]>(
        `INSERT INTO memory_edges (
           citing_kind, citing_id, cited_kind, cited_id, relation, provenance, tags, created_at_epoch
         ) VALUES ('turn', ?, 'turn', ?, 'extends', 'asserted', '["write-gate"]', ?) RETURNING id`,
      )
      .get(turnIds[1]!, turnIds[0]!, 100)!.id;
    clearLaneReceipts(db);
  });

  afterEach(() => {
    db.close();
  });

  test("the registry migration reads the pre-v12 tags column and settles, through the real entry point", () => {
    initializeSchema(db);

    // It read the column: the lane exists only because M0 classified this
    // edge's `tags` and M2 seeded from that classification.
    const classification = JSON.parse(
      db
        .query<{ payload: string }, [string]>(
          "SELECT payload FROM migration_receipts WHERE name = ?",
        )
        .get(LANE_REGISTRY_M0_CLASSIFY_RECEIPT)!.payload,
    ) as LaneMigrationClassification;
    expect(classification.placeable.map((entry) => entry.edgeId)).toEqual([edgeId]);
    expect(classification.placeable[0]?.tags).toEqual(["write-gate"]);
    expect(getLane(db, segmentId, "write-gate")).not.toBeNull();

    // ...and it settled, which is the precondition the v12 phase slot gates on.
    expect(isLaneRegistrySettled(db)).toBe(true);
    expect(() => runLaneModelV12EdgeMigration(db)).not.toThrow();

    // A database that CARRIED data is never marked not-applicable.
    expect(
      db
        .query<{ name: string }, [string]>("SELECT name FROM migration_receipts WHERE name = ?")
        .get(LANE_REGISTRY_NOT_APPLICABLE_RECEIPT),
    ).toBeNull();
  });

  test("a pending phase against a v12-expanded memory_edges is refused, not run against the wrong shape", () => {
    // v12 ticket 05 (expand): the new side columns arrive while `tags` is
    // still there and still dual-written. Even so, M4 writing `tags = '[]'`
    // would leave the new columns saying something else.
    db.exec("ALTER TABLE memory_edges ADD COLUMN tail_tag TEXT NOT NULL DEFAULT ''");

    let thrown: unknown;
    try {
      runLaneRegistryMigration(db, 200);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(LaneMigrationOrderError);
    expect((thrown as Error).message).toContain("tail_tag");
    expect((thrown as Error).message).toContain("runLaneModelV12EdgeMigration");
    // Nothing ran: no half-migrated state left behind.
    expect(readLaneReceipts(db)).toEqual([]);
    expect(getLane(db, segmentId, "write-gate")).toBeNull();
  });

  test("a registry that settled BEFORE v12 opens cleanly once the edge shape has moved on", () => {
    initializeSchema(db);
    expect(isLaneRegistrySettled(db)).toBe(true);

    // The normal post-v12 world: the column work has landed, and every later
    // open must sail past the barrier rather than trip on it.
    db.exec("ALTER TABLE memory_edges ADD COLUMN tail_tag TEXT NOT NULL DEFAULT ''");
    expect(() => runLaneRegistryMigration(db, 300)).not.toThrow();
    expect(() => runLaneModelV12EdgeMigration(db)).not.toThrow();
  });

  test("failpoint: a crash between M0 and M2 leaves M0 durable and the reopen finishes it exactly once", () => {
    installReceiptFailpoint(db, LANE_REGISTRY_M2_SEED_RECEIPT);
    expect(() => runLaneRegistryMigration(db, 200)).toThrow(/injected crash/);

    // M0 committed in its own transaction; M2's whole transaction — the lane
    // seed AND its receipt — rolled back together.
    const afterCrash = readLaneReceipts(db);
    expect(afterCrash.map((row) => row.name)).toEqual([LANE_REGISTRY_M0_CLASSIFY_RECEIPT]);
    expect(getLane(db, segmentId, "write-gate")).toBeNull();

    removeReceiptFailpoint(db);
    runLaneRegistryMigration(db, 300);

    // M0 is NOT re-run: its receipt row is byte-identical, stamp included.
    const m0 = db
      .query<{ payload: string; appliedAtEpoch: number }, [string]>(
        "SELECT payload, applied_at_epoch AS appliedAtEpoch FROM migration_receipts WHERE name = ?",
      )
      .get(LANE_REGISTRY_M0_CLASSIFY_RECEIPT)!;
    expect(m0.appliedAtEpoch).toBe(200);
    expect(m0.payload).toBe(afterCrash[0]!.payload);
    expect(readLaneReceipts(db).map((row) => row.name)).toEqual([
      ...LANE_REGISTRY_PHASE_RECEIPTS,
    ]);

    // Seeded once, not twice.
    expect(
      db
        .query<{ count: number }, [number, string]>(
          "SELECT COUNT(*) AS count FROM lanes WHERE segment_id = ? AND tag = ?",
        )
        .get(segmentId, "write-gate")!.count,
    ).toBe(1);
    expect(isLaneRegistrySettled(db)).toBe(true);
  });
});

describe("lane migration ordering (v12 ticket 01): the barrier against a contracted edge table", () => {
  /**
   * v12 ticket 09 (contract) DROPS `tags`. That shape cannot be produced by
   * `ALTER TABLE ... DROP COLUMN` on the real table — the column is part of
   * the edge identity's UNIQUE constraint and SQLite refuses — so the shape
   * is built directly. Only the three things the barrier and its two gates
   * read are needed: the receipt table (empty, so phases are pending), a
   * non-empty `turns` (so the not-applicable gate does not short-circuit),
   * and a `memory_edges` with no `tags`.
   */
  function contractedDatabase(): Database {
    const db = createDatabase(":memory:");
    db.exec(`
      CREATE TABLE migration_receipts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        applied_at_epoch INTEGER NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload))
      );
      CREATE TABLE turns (id INTEGER PRIMARY KEY AUTOINCREMENT);
      INSERT INTO turns DEFAULT VALUES;
      CREATE TABLE memory_edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        -- The endpoint columns a CONTRACTED table still has: contraction
        -- replaces the lane columns only. v12 ticket 04's M-C phase reads
        -- these (it retracts self edges) and must not be the thing that makes
        -- this ordering fixture throw.
        citing_kind TEXT NOT NULL DEFAULT 'turn',
        citing_id INTEGER NOT NULL DEFAULT 0,
        cited_kind TEXT NOT NULL DEFAULT 'turn',
        cited_id INTEGER NOT NULL DEFAULT 0,
        relation TEXT,
        provenance TEXT NOT NULL DEFAULT 'asserted',
        tail_tag TEXT NOT NULL DEFAULT '',
        head_tag TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE memory_edge_tags (
        edge_row_id INTEGER NOT NULL,
        tag TEXT NOT NULL,
        PRIMARY KEY (edge_row_id, tag)
      );
    `);
    return db;
  }

  test("a pending phase against a memory_edges with no tags column is refused with a named error", () => {
    const db = contractedDatabase();
    try {
      let thrown: unknown;
      try {
        runLaneRegistryMigration(db, 200);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(LaneMigrationOrderError);
      // The failure a bare SQL error would have hidden: "no such column: tags"
      // names the symptom, this names the rule that was broken.
      expect((thrown as Error).message).toContain("no `tags` column");
      expect((thrown as Error).message).toContain("lane-model-v12 spec D4");
    } finally {
      db.close();
    }
  });

  test("the same database passes once every phase receipt is present — settled databases are never blocked", () => {
    const db = contractedDatabase();
    try {
      // The v12 vocabulary merge (ticket 03's M-B) belongs in this list for
      // the same reason the four registry phases do: a table that has ALREADY
      // taken the contracted shape is one the whole v12 slot has run against,
      // and M-B — which merges on an identity key ending in the tag payload —
      // is one of the phases that had to run BEFORE the columns changed. A
      // fixture claiming the contracted shape without its receipt is claiming
      // a state no upgrade path produces, and M-B says so by name.
      for (const name of [
        ...LANE_REGISTRY_PHASE_RECEIPTS,
        LANE_MODEL_V12_VOCABULARY_MERGE_RECEIPT,
      ]) {
        db.query<unknown, [string]>(
          "INSERT INTO migration_receipts (name, applied_at_epoch, payload) VALUES (?, 200, '{}')",
        ).run(name);
      }
      expect(() => runLaneRegistryMigration(db, 300)).not.toThrow();
      expect(() => runLaneModelV12EdgeMigration(db)).not.toThrow();
    } finally {
      db.close();
    }
  });
});

describe("lane migration ordering (v12 ticket 01): the not-applicable path", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  test("a database with nothing to migrate carries an explicit not-applicable row, not a missing one", () => {
    const receipt = db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM migration_receipts WHERE name = ?",
      )
      .get(LANE_REGISTRY_NOT_APPLICABLE_RECEIPT);
    expect(receipt).not.toBeNull();
    expect(JSON.parse(receipt!.payload) as LaneRegistryNotApplicableReceipt).toEqual({
      reason: "nothing-to-migrate",
    });
    // The four phase receipts are still written, so every reader that asks
    // "has this phase settled?" keeps getting the same answer as before.
    expect(readPhasePayloads(db).map((row) => row.name)).toEqual([
      ...LANE_REGISTRY_PHASE_RECEIPTS,
    ]);
    expect(isLaneRegistrySettled(db)).toBe(true);
  });

  test("no observable behaviour change: the skip writes exactly what running the phases writes", () => {
    const skipped = readPhasePayloads(db);

    // Same empty graph, but with one turn present, so the not-applicable gate
    // does not fire and the REAL phase bodies run end to end.
    const ran = createDatabase(":memory:");
    try {
      initializeSchema(ran);
      clearLaneReceipts(ran);
      const sessionId = upsertSession(ran, {
        contentSessionId: "lane-ordering-equivalence",
        project: "/tmp/project-lane-ordering-equivalence",
        title: null,
        insight: null,
        createdAtEpoch: 100,
        updatedAtEpoch: 100,
        completedAtEpoch: null,
      }).id;
      ran
        .query<{ id: number }, [number, number]>(
          `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch, was_rolled_back)
           VALUES (?, 1, 'active', ?, 0) RETURNING id`,
        )
        .get(sessionId, 100);

      runLaneRegistryMigration(ran, 200);

      expect(readPhasePayloads(ran)).toEqual(skipped);
      // ...and that database is NOT marked not-applicable: it had input to
      // read. A later reader can tell the two apart, which is the whole point
      // of the row.
      expect(
        ran
          .query<{ name: string }, [string]>(
            "SELECT name FROM migration_receipts WHERE name = ?",
          )
          .get(LANE_REGISTRY_NOT_APPLICABLE_RECEIPT),
      ).toBeNull();
    } finally {
      ran.close();
    }
  });

  test("edges without turns are still input — a table full of edges is never stamped 'nothing to migrate'", () => {
    clearLaneReceipts(db);
    // No FK ties `memory_edges` to `turns` (the endpoint is polymorphic:
    // kind + id), so edges outliving their turns is a storable shape. M0
    // JOINs `turns`, so it classifies none of them — but the receipt would
    // then be asserting "this database never carried anything this migration
    // reads", which is false about the very table M0 reads.
    db.exec(
      `INSERT INTO memory_edges (
         citing_kind, citing_id, cited_kind, cited_id, relation, provenance, tags, created_at_epoch
       ) VALUES ('turn', 9001, 'turn', 9002, 'extends', 'asserted', '["orphan-lane"]', 100)`,
    );

    runLaneRegistryMigration(db, 200);

    expect(
      db
        .query<{ name: string }, [string]>("SELECT name FROM migration_receipts WHERE name = ?")
        .get(LANE_REGISTRY_NOT_APPLICABLE_RECEIPT),
    ).toBeNull();
    expect(readPhasePayloads(db).map((row) => row.name)).toEqual([
      ...LANE_REGISTRY_PHASE_RECEIPTS,
    ]);
  });

  test("failpoint: a crash mid-skip leaves nothing behind, and the reopen writes the whole disposition once", () => {
    clearLaneReceipts(db);
    installReceiptFailpoint(db, LANE_REGISTRY_M3_MEMBERSHIP_RECEIPT);
    expect(() => runLaneRegistryMigration(db, 200)).toThrow(/injected crash/);

    // All five rows are one transaction: the two that had already been
    // inserted rolled back with it, so there is no database anywhere carrying
    // half a disposition.
    expect(readLaneReceipts(db)).toEqual([]);

    removeReceiptFailpoint(db);
    runLaneRegistryMigration(db, 300);
    const after = readLaneReceipts(db);
    expect(after.map((row) => row.name)).toEqual([
      ...LANE_REGISTRY_PHASE_RECEIPTS,
      LANE_REGISTRY_NOT_APPLICABLE_RECEIPT,
    ]);

    // Reopening again changes nothing — no double execution, no second row.
    runLaneRegistryMigration(db, 400);
    expect(readLaneReceipts(db)).toEqual(after);
  });
});

describe("lane migration ordering (v12 ticket 01): the v12 phase slot", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  test("the slot refuses to run while any registry phase is still pending", () => {
    db.query<unknown, [string]>("DELETE FROM migration_receipts WHERE name = ?").run(
      LANE_REGISTRY_M4_DISPOSAL_RECEIPT,
    );

    let thrown: unknown;
    try {
      runLaneModelV12EdgeMigration(db);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(LaneMigrationOrderError);
    expect((thrown as Error).message).toContain(LANE_REGISTRY_M4_DISPOSAL_RECEIPT);
    expect((thrown as Error).message).toContain("lane-model-v12 edge-shape migration");
  });

  test("the slot passes once every phase has settled", () => {
    expect(isLaneRegistrySettled(db)).toBe(true);
    expect(() => runLaneModelV12EdgeMigration(db)).not.toThrow();
  });
});
