import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  LANE_MODEL_V12_SELF_EDGE_RETRACTION_RECEIPT,
  runLaneModelV12SelfEdgeRetraction,
  type LaneModelV12SelfEdgeRetractionReceipt,
} from "../../src/db/lanes";
import { initializeSchema } from "../../src/db/schema";
import { downgradeToPreV12EdgeShape } from "../support/pre-v12-edge-shape";

/**
 * lane-model-v12 M-C (spec D4, ticket 04): an edge's two ends must be
 * DIFFERENT nodes, so every stored self row is retracted once, at upgrade.
 *
 * The live database carries exactly ONE such row (`S15069/T1265 grounds
 * T1265`, untagged, `asserted`) — an artifact of the retired cross-phase
 * self-`grounds` permission this ticket deletes in the same batch. The phase
 * is written for N and records every row it removes: a receipt that only
 * proves "one row, as expected" cannot be read on a database that had two.
 */
describe("lane-model-v12 M-C — the self-edge retraction", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    // Ticket 09: `initializeSchema` now ends with M-E, so the table it hands
    // back has no `tags` column. M-C runs strictly earlier in the slot, on
    // the shape below — and these fixtures seed that column directly.
    downgradeToPreV12EdgeShape(db);
    // `initializeSchema` already ran the phase on this empty database, so
    // every test below starts from a fresh receipt name.
    db.query<unknown, [string]>("DELETE FROM migration_receipts WHERE name = ?").run(
      LANE_MODEL_V12_SELF_EDGE_RETRACTION_RECEIPT,
    );
  });

  afterEach(() => {
    db.close();
  });

  function seedTurn(sessionId: number, promptNumber: number): number {
    return db
      .query<{ id: number }, [number, number]>(
        `INSERT INTO turns (session_id, prompt_number, created_at_epoch, status)
         VALUES (?, ?, 100, 'extracted') RETURNING id`,
      )
      .get(sessionId, promptNumber)!.id;
  }

  function seedSession(): number {
    return db
      .query<{ id: number }, []>(
        `INSERT INTO sessions (content_session_id, project, created_at_epoch)
         VALUES ('u', '/tmp/p', 100) RETURNING id`,
      )
      .get()!.id;
  }

  function seedEdge(citingId: number, citedId: number, relation: string, tags = "[]"): number {
    return db
      .query<{ id: number }, [number, number, string, string]>(
        `INSERT INTO memory_edges
           (citing_kind, citing_id, cited_kind, cited_id, relation, provenance, tags, created_at_epoch)
         VALUES ('turn', ?, 'turn', ?, ?, 'asserted', ?, 100) RETURNING id`,
      )
      .get(citingId, citedId, relation, tags)!.id;
  }

  const receipt = (): LaneModelV12SelfEdgeRetractionReceipt =>
    JSON.parse(
      db
        .query<{ payload: string }, [string]>(
          "SELECT payload FROM migration_receipts WHERE name = ?",
        )
        .get(LANE_MODEL_V12_SELF_EDGE_RETRACTION_RECEIPT)!.payload,
    ) as LaneModelV12SelfEdgeRetractionReceipt;

  const edgeIds = (): number[] =>
    db.query<{ id: number }, []>("SELECT id FROM memory_edges ORDER BY id").all().map((r) => r.id);

  // The production row, reproduced: a bare (untagged) self-`grounds`, the one
  // shape the retired permission ever admitted.
  test("the live database's own shape — an untagged self-grounds — is deleted, and the receipt names it by address", () => {
    const sessionId = seedSession();
    const t1 = seedTurn(sessionId, 1265);
    const t2 = seedTurn(sessionId, 1266);
    const selfEdge = seedEdge(t1, t1, "grounds");
    const ordinary = seedEdge(t2, t1, "extends");

    runLaneModelV12SelfEdgeRetraction(db, 500);

    expect(edgeIds()).toEqual([ordinary]);
    const rows = receipt().retracted;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      edgeId: selfEdge,
      nodeKind: "turn",
      nodeId: t1,
      address: `S${sessionId}/T1265`,
      relation: "grounds",
      provenance: "asserted",
    });
  });

  // The receipt has to be readable on a database that had more than one, and
  // on rows the retired permission never produced — a TAGGED self edge, and a
  // self edge under some other word. Both are equally illegal now.
  test("every self row goes, whatever its word or tag state, and each is recorded", () => {
    const sessionId = seedSession();
    const t1 = seedTurn(sessionId, 1);
    const t2 = seedTurn(sessionId, 2);
    const selfGrounds = seedEdge(t1, t1, "grounds");
    const selfTagged = seedEdge(t2, t2, "extends", '["lane-a"]');
    const ordinary = seedEdge(t2, t1, "extends");
    // The tag index rows the retraction must take with it.
    db.query<unknown, [number]>(
      "INSERT INTO memory_edge_tags (edge_row_id, tag) VALUES (?, 'lane-a')",
    ).run(selfTagged);

    runLaneModelV12SelfEdgeRetraction(db, 500);

    expect(edgeIds()).toEqual([ordinary]);
    expect(receipt().retracted.map((row) => row.edgeId)).toEqual([selfGrounds, selfTagged]);
    // The side index is emptied of the retracted row, never orphaned.
    expect(
      db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM memory_edge_tags").get()!.n,
    ).toBe(0);
  });

  test("a database with no self row at all still writes a receipt, so the phase is provably settled", () => {
    const sessionId = seedSession();
    const t1 = seedTurn(sessionId, 1);
    const t2 = seedTurn(sessionId, 2);
    seedEdge(t2, t1, "extends");

    runLaneModelV12SelfEdgeRetraction(db, 500);

    expect(receipt().retracted).toEqual([]);
    expect(edgeIds()).toHaveLength(1);
  });

  // Idempotent by RECEIPT, and independently by PREDICATE: a second run finds
  // no self rows even if the receipt were lost. The second property is what
  // keeps a receipt-table restore from double-deleting an unrelated row.
  test("a second run is a no-op, and stays one even with the receipt removed", () => {
    const sessionId = seedSession();
    const t1 = seedTurn(sessionId, 1);
    const t2 = seedTurn(sessionId, 2);
    seedEdge(t1, t1, "grounds");
    const ordinary = seedEdge(t2, t1, "extends");

    runLaneModelV12SelfEdgeRetraction(db, 500);
    runLaneModelV12SelfEdgeRetraction(db, 600);
    expect(edgeIds()).toEqual([ordinary]);
    // The receipt keeps the FIRST run's epoch — the second inserted nothing.
    expect(
      db
        .query<{ applied: number }, [string]>(
          "SELECT applied_at_epoch AS applied FROM migration_receipts WHERE name = ?",
        )
        .get(LANE_MODEL_V12_SELF_EDGE_RETRACTION_RECEIPT)!.applied,
    ).toBe(500);

    db.query<unknown, [string]>("DELETE FROM migration_receipts WHERE name = ?").run(
      LANE_MODEL_V12_SELF_EDGE_RETRACTION_RECEIPT,
    );
    runLaneModelV12SelfEdgeRetraction(db, 700);
    expect(edgeIds()).toEqual([ordinary]);
  });

  /**
   * THE RECEIPT IS NOT THE GUARANTEE — the peer review of this batch is where
   * that gap was caught. "This phase ran once" and "no self row can exist" are
   * different statements, and a receipt-only gate silently conflates them: a
   * row RESTORED after the sweep (an operator dropping in an old
   * `memory_edges`, a fixture hand-building a pre-migration table) is then
   * skipped on every later open, forever.
   *
   * So the skip is gated on the TABLE'S OWN CHECK. While the table can still
   * admit a self row the sweep runs, receipt or not; once the contracted shape
   * bans them (see the next two tests) the scan is provably empty and is not
   * issued — which is the steady state, so this is not "rescan every open".
   *
   * The receipt still records the FIRST run only: a standing repair is a
   * repair, not a second migration.
   */
  test("a self row appearing AFTER the receipt is still retracted — the gate is the CHECK, not the receipt", () => {
    runLaneModelV12SelfEdgeRetraction(db, 500);
    expect(receipt().retracted).toEqual([]);

    const sessionId = seedSession();
    const t1 = seedTurn(sessionId, 1);
    const t2 = seedTurn(sessionId, 2);
    const late = seedEdge(t1, t1, "grounds");
    const ordinary = seedEdge(t2, t1, "extends");
    expect(edgeIds()).toEqual([late, ordinary]);

    runLaneModelV12SelfEdgeRetraction(db, 600);

    expect(edgeIds()).toEqual([ordinary]);
    expect(receipt().retracted).toEqual([]);
    expect(
      db
        .query<{ applied: number }, [string]>(
          "SELECT applied_at_epoch AS applied FROM migration_receipts WHERE name = ?",
        )
        .get(LANE_MODEL_V12_SELF_EDGE_RETRACTION_RECEIPT)!.applied,
    ).toBe(500);
  });

  /**
   * And the half a migration can never provide: the CONTRACTED table refuses
   * the row outright (lane-model-v12 D2, ticket 04), so there is nothing left
   * for a later sweep to miss. This is what makes the one-time sweep above
   * sufficient rather than merely current.
   */
  test("the contracted table itself refuses a self row, receipt or no receipt", () => {
    const migrated = createDatabase(":memory:");
    try {
      initializeSchema(migrated);
      expect(
        migrated
          .query<{ count: number }, [string]>(
            "SELECT COUNT(*) AS count FROM migration_receipts WHERE name = ?",
          )
          .get(LANE_MODEL_V12_SELF_EDGE_RETRACTION_RECEIPT)!.count,
      ).toBe(1);

      expect(() =>
        migrated
          .query(
            `INSERT INTO memory_edges
               (citing_kind, citing_id, cited_kind, cited_id, relation, provenance, created_at_epoch)
             VALUES ('turn', 7, 'turn', 7, 'grounds', 'asserted', 100)`,
          )
          .run(),
      ).toThrow(/CHECK constraint failed/);
    } finally {
      migrated.close();
    }
  });

  /**
   * The two halves together, on the path they were written for: a settled
   * database has an OLD `memory_edges` dropped into it, self row and all, and
   * is reopened. The open must COMPLETE — the contraction cannot copy a self
   * row into a table that bans one, so a sweep that skipped on its receipt
   * would turn this restore into a failed open rather than a repaired one.
   */
  test("an old table restored over a settled database reopens clean instead of failing the open", () => {
    const restored = createDatabase(":memory:");
    try {
      initializeSchema(restored);
      const sessionId = restored
        .query<{ id: number }, []>(
          `INSERT INTO sessions (content_session_id, project, created_at_epoch)
           VALUES ('restore', '/tmp/p', 100) RETURNING id`,
        )
        .get()!.id;
      const turnIds = [1, 2].map(
        (promptNumber) =>
          restored
            .query<{ id: number }, [number, number]>(
              `INSERT INTO turns (session_id, prompt_number, created_at_epoch, status)
               VALUES (?, ?, 100, 'extracted') RETURNING id`,
            )
            .get(sessionId, promptNumber)!.id,
      );

      // The restore: an old-shaped table, with a row the old shape allowed.
      downgradeToPreV12EdgeShape(restored);
      restored
        .query(
          `INSERT INTO memory_edges
             (citing_kind, citing_id, cited_kind, cited_id, relation, provenance, tags, created_at_epoch)
           VALUES ('turn', ?, 'turn', ?, 'grounds', 'asserted', '[]', 100)`,
        )
        .run(turnIds[0]!, turnIds[0]!);
      restored
        .query(
          `INSERT INTO memory_edges
             (citing_kind, citing_id, cited_kind, cited_id, relation, provenance, tags, created_at_epoch)
           VALUES ('turn', ?, 'turn', ?, 'extends', 'asserted', '[]', 100)`,
        )
        .run(turnIds[1]!, turnIds[0]!);

      expect(() => initializeSchema(restored)).not.toThrow();

      expect(
        restored
          .query<{ n: number }, []>(
            `SELECT COUNT(*) AS n FROM memory_edges
             WHERE citing_kind = cited_kind AND citing_id = cited_id`,
          )
          .get()!.n,
      ).toBe(0);
      // The ordinary row is untouched — the sweep is targeted, not a purge.
      expect(
        restored.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM memory_edges").get()!.n,
      ).toBe(1);
    } finally {
      restored.close();
    }
  });

  // The phase shares `runLaneModelV12EdgeMigration` with the expand/contract
  // work of v12 tickets 05/09, so its query must resolve on EITHER side of
  // that contraction. Reading a lane column would couple it to one side.
  test("the query reads no lane column — it resolves on a table with no `tags` at all", () => {
    const contracted = createDatabase(":memory:");
    try {
      contracted.exec(`
        CREATE TABLE migration_receipts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT UNIQUE NOT NULL,
          applied_at_epoch INTEGER NOT NULL,
          payload TEXT NOT NULL DEFAULT '{}'
        );
        -- The address helper reads these two columns; the row it looks up
        -- is absent here, so it falls back rather than throwing.
        CREATE TABLE turns (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id INTEGER,
          prompt_number INTEGER
        );
        CREATE TABLE memory_edge_tags (edge_row_id INTEGER NOT NULL, tag TEXT NOT NULL);
        CREATE TABLE memory_edges (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          citing_kind TEXT NOT NULL, citing_id INTEGER NOT NULL,
          cited_kind TEXT NOT NULL, cited_id INTEGER NOT NULL,
          relation TEXT, provenance TEXT NOT NULL,
          tail_tag TEXT NOT NULL DEFAULT '', head_tag TEXT NOT NULL DEFAULT ''
        );
        INSERT INTO memory_edges (citing_kind, citing_id, cited_kind, cited_id, relation, provenance)
          VALUES ('turn', 7, 'turn', 7, 'grounds', 'asserted');
      `);

      expect(() => runLaneModelV12SelfEdgeRetraction(contracted, 500)).not.toThrow();
      expect(
        contracted.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM memory_edges").get()!.n,
      ).toBe(0);
    } finally {
      contracted.close();
    }
  });
});
