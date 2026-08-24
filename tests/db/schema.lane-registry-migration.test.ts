import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  getLane,
  LANE_REGISTRY_M0_CLASSIFY_RECEIPT,
  LANE_REGISTRY_M2_SEED_RECEIPT,
  listLanesForSegment,
  runLaneRegistryMigration,
  type LaneMigrationClassification,
  type LaneMigrationSeedReceipt,
} from "../../src/db/lanes";
import { initializeSchema } from "../../src/db/schema";
import { createSegment } from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";

/**
 * Lane-declaration ticket 01 (spec D6/M0-M2). `runLaneRegistryMigration`
 * runs automatically as the LAST step of `initializeSchema` (schema.ts), so
 * `beforeEach`'s own bootstrap call already consumes both phases against an
 * EMPTY graph (no sessions/turns/segments exist yet) — that is itself a
 * fixture worth pinning (a fresh install seeds nothing and is not an error).
 * Every test that wants to exercise M0/M2 against REAL fixture data resets
 * the two receipt rows first (`resetLaneMigrationReceipts`) — the same
 * "reset the gate, not the schema" idiom `schema.note-settlement-migration.
 * test.ts` uses via its own `downgradeToPre...` fixtures, adapted to a
 * receipt-row gate instead of a schema-shape gate.
 */
describe("lane registry migration (ticket 01, spec D6/M0-M2)", () => {
  let db: Database;
  let sessionId: number;

  function resetLaneMigrationReceipts(): void {
    db.query<unknown, [string, string]>(
      "DELETE FROM migration_receipts WHERE name IN (?, ?)",
    ).run(LANE_REGISTRY_M0_CLASSIFY_RECEIPT, LANE_REGISTRY_M2_SEED_RECEIPT);
    db.exec("DELETE FROM lanes");
  }

  function seedTurn(promptNumber: number): number {
    return db
      .query<{ id: number }, [number, number, number]>(
        `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch)
         VALUES (?, ?, 'active', ?) RETURNING id`,
      )
      .get(sessionId, promptNumber, 100)!.id;
  }

  function addMember(segmentId: number, turnId: number): void {
    db.query<unknown, [number, number, number]>(
      `INSERT INTO segment_members (segment_id, turn_id, created_at_epoch) VALUES (?, ?, ?)`,
    ).run(segmentId, turnId, 100);
  }

  function writeTaggedEdge(
    citingId: number,
    citedId: number,
    relation: string,
    tags: string[],
  ): number {
    return db
      .query<{ id: number }, [number, number, string, string, number]>(
        `INSERT INTO memory_edges (
           citing_kind, citing_id, cited_kind, cited_id, relation, provenance, tags, created_at_epoch
         ) VALUES ('turn', ?, 'turn', ?, ?, 'asserted', ?, ?) RETURNING id`,
      )
      .get(citingId, citedId, relation, JSON.stringify(tags), 100)!.id;
  }

  function readReceiptPayload<T>(name: string): T {
    const row = db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM migration_receipts WHERE name = ?",
      )
      .get(name);
    expect(row).not.toBeNull();
    return JSON.parse(row!.payload) as T;
  }

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "lane-migration-session",
      project: "/tmp/project-lane-migration",
      title: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 100,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  test("M1: lanes and migration_receipts exist after schema init", () => {
    const laneTable = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'lanes'",
      )
      .get();
    const receiptTable = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migration_receipts'",
      )
      .get();
    expect(laneTable).not.toBeNull();
    expect(receiptTable).not.toBeNull();
  });

  test("M0/M2 receipts are written on the very first schema init, even against an empty graph", () => {
    const m0 = db
      .query<{ name: string }, [string]>("SELECT name FROM migration_receipts WHERE name = ?")
      .get(LANE_REGISTRY_M0_CLASSIFY_RECEIPT);
    const m2 = db
      .query<{ name: string }, [string]>("SELECT name FROM migration_receipts WHERE name = ?")
      .get(LANE_REGISTRY_M2_SEED_RECEIPT);
    expect(m0).not.toBeNull();
    expect(m2).not.toBeNull();
    const m0Payload = readReceiptPayload<LaneMigrationClassification>(
      LANE_REGISTRY_M0_CLASSIFY_RECEIPT,
    );
    expect(m0Payload).toEqual({ placeable: [], notPlaceable: [], rejected: [] });
    const m2Payload = readReceiptPayload<LaneMigrationSeedReceipt>(
      LANE_REGISTRY_M2_SEED_RECEIPT,
    );
    expect(m2Payload).toEqual({ perSegment: [], totalSeeded: 0 });
  });

  test("M0 classifies a same-segment tagged edge as placeable, and M2 seeds it", () => {
    resetLaneMigrationReceipts();
    const segmentId = createSegment(db, { title: "Same segment", nowEpoch: 100 }).id;
    const t1 = seedTurn(1);
    const t2 = seedTurn(2);
    addMember(segmentId, t1);
    addMember(segmentId, t2);
    writeTaggedEdge(t2, t1, "extends", ["write-gate"]);

    runLaneRegistryMigration(db, 200);

    const classification = readReceiptPayload<LaneMigrationClassification>(
      LANE_REGISTRY_M0_CLASSIFY_RECEIPT,
    );
    expect(classification.placeable).toHaveLength(1);
    expect(classification.placeable[0]!.tags).toEqual(["write-gate"]);
    expect(classification.notPlaceable).toEqual([]);

    const lane = getLane(db, segmentId, "write-gate");
    expect(lane).not.toBeNull();
    expect(lane?.segmentId).toBe(segmentId);
  });

  test("M0 classifies an edge with a homeless endpoint as NOT placeable, and M2 mints no lane for it", () => {
    resetLaneMigrationReceipts();
    const segmentId = createSegment(db, { title: "One-sided", nowEpoch: 100 }).id;
    const owned = seedTurn(1);
    const homeless = seedTurn(2);
    addMember(segmentId, owned);
    // `homeless` is deliberately never added to any segment.
    writeTaggedEdge(homeless, owned, "extends", ["orphan-lane"]);

    runLaneRegistryMigration(db, 200);

    const classification = readReceiptPayload<LaneMigrationClassification>(
      LANE_REGISTRY_M0_CLASSIFY_RECEIPT,
    );
    expect(classification.placeable).toEqual([]);
    expect(classification.notPlaceable).toHaveLength(1);
    expect(classification.notPlaceable[0]!.tags).toEqual(["orphan-lane"]);

    expect(getLane(db, segmentId, "orphan-lane")).toBeNull();
    expect(listLanesForSegment(db, segmentId)).toEqual([]);
  });

  test("a cross-segment edge is placeable and seeds a lane on BOTH segments (D2's 'consulted once per endpoint')", () => {
    resetLaneMigrationReceipts();
    const segmentA = createSegment(db, { title: "A", nowEpoch: 100 }).id;
    const segmentB = createSegment(db, { title: "B", nowEpoch: 100 }).id;
    const t1 = seedTurn(1);
    const t2 = seedTurn(2);
    addMember(segmentA, t1);
    addMember(segmentB, t2);
    writeTaggedEdge(t2, t1, "override", ["shared-lane"]);

    runLaneRegistryMigration(db, 200);

    expect(getLane(db, segmentA, "shared-lane")).not.toBeNull();
    expect(getLane(db, segmentB, "shared-lane")).not.toBeNull();
  });

  test("seeding receipt names the per-segment counts", () => {
    resetLaneMigrationReceipts();
    const segmentId = createSegment(db, { title: "Counted", nowEpoch: 100 }).id;
    const t1 = seedTurn(1);
    const t2 = seedTurn(2);
    const t3 = seedTurn(3);
    addMember(segmentId, t1);
    addMember(segmentId, t2);
    addMember(segmentId, t3);
    writeTaggedEdge(t2, t1, "extends", ["a"]);
    writeTaggedEdge(t3, t2, "extends", ["b"]);

    runLaneRegistryMigration(db, 200);

    const seedReceipt = readReceiptPayload<LaneMigrationSeedReceipt>(
      LANE_REGISTRY_M2_SEED_RECEIPT,
    );
    expect(seedReceipt).toEqual({
      perSegment: [{ segmentId, count: 2 }],
      totalSeeded: 2,
    });
  });

  test("a legacy mixed-case edge tag is best-effort canonicalized before seeding", () => {
    resetLaneMigrationReceipts();
    const segmentId = createSegment(db, { title: "Legacy case", nowEpoch: 100 }).id;
    const t1 = seedTurn(1);
    const t2 = seedTurn(2);
    addMember(segmentId, t1);
    addMember(segmentId, t2);
    // Predates the D1 canonical-tag predicate — stored mixed-case, as any
    // edge written before this ticket could be.
    writeTaggedEdge(t2, t1, "extends", ["Write-Gate"]);

    runLaneRegistryMigration(db, 200);

    expect(getLane(db, segmentId, "write-gate")).not.toBeNull();
    expect(getLane(db, segmentId, "Write-Gate")).toBeNull();
  });

  test("phase gating reads its OWN receipt row, never inferred from lanes having rows", () => {
    resetLaneMigrationReceipts();
    // A lane pre-exists for a segment/tag this test's own fixture never
    // touches — e.g. a manual `declare` call before this pass ran. If the
    // migration wrongly inferred "already ran" from `lanes` being non-empty,
    // it would skip and the fresh fixture below would never get seeded.
    const preexistingSegment = createSegment(db, { title: "Pre-existing", nowEpoch: 100 }).id;
    db.query<unknown, [number, string, number]>(
      "INSERT INTO lanes (segment_id, tag, created_at_epoch) VALUES (?, ?, ?)",
    ).run(preexistingSegment, "manual-lane", 50);

    const segmentId = createSegment(db, { title: "Fresh", nowEpoch: 100 }).id;
    const t1 = seedTurn(1);
    const t2 = seedTurn(2);
    addMember(segmentId, t1);
    addMember(segmentId, t2);
    writeTaggedEdge(t2, t1, "extends", ["fresh-lane"]);

    runLaneRegistryMigration(db, 200);

    expect(getLane(db, preexistingSegment, "manual-lane")).not.toBeNull();
    expect(getLane(db, segmentId, "fresh-lane")).not.toBeNull();
  });

  test("is idempotent — running the migration twice changes nothing further", () => {
    resetLaneMigrationReceipts();
    const segmentId = createSegment(db, { title: "Idempotent", nowEpoch: 100 }).id;
    const t1 = seedTurn(1);
    const t2 = seedTurn(2);
    addMember(segmentId, t1);
    addMember(segmentId, t2);
    writeTaggedEdge(t2, t1, "extends", ["stable-lane"]);

    runLaneRegistryMigration(db, 200);
    const receiptsAfterFirst = db
      .query<{ name: string; payload: string }, []>(
        "SELECT name, payload FROM migration_receipts WHERE name LIKE 'lane-declaration-%' ORDER BY name",
      )
      .all();

    // A NEW placeable tagged edge, added AFTER the first run: if a second
    // run incorrectly re-classified, it would seed this as a lane too.
    const t3 = seedTurn(3);
    addMember(segmentId, t3);
    writeTaggedEdge(t3, t2, "extends", ["late-lane"]);

    runLaneRegistryMigration(db, 300);
    runLaneRegistryMigration(db, 300);

    const receiptsAfterSecond = db
      .query<{ name: string; payload: string }, []>(
        "SELECT name, payload FROM migration_receipts WHERE name LIKE 'lane-declaration-%' ORDER BY name",
      )
      .all();
    expect(receiptsAfterSecond).toEqual(receiptsAfterFirst);
    expect(getLane(db, segmentId, "late-lane")).toBeNull();
    expect(getLane(db, segmentId, "stable-lane")).not.toBeNull();
  });

  test("end-to-end via the real entry point: initializeSchema run twice is a no-op for the lane registry", () => {
    const receiptCountBefore = db
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM migration_receipts WHERE name LIKE 'lane-declaration-%'",
      )
      .get()!.count;
    expect(receiptCountBefore).toBe(2);

    initializeSchema(db);
    initializeSchema(db);

    const receiptCountAfter = db
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM migration_receipts WHERE name LIKE 'lane-declaration-%'",
      )
      .get()!.count;
    expect(receiptCountAfter).toBe(2);
  });

  // Reported, never silently skipped (the same rule the spec states for M3's
  // malformed `tags` column, applied to M0's own reads). An edge whose tags
  // cannot be READ as lane tags belongs to neither bucket, so without a third
  // one it would vanish from the receipt entirely — and ticket 04 disposes of
  // edges by reading the receipt, not by re-deriving from the table.
  // The `malformed-tags-column` branch is DEFENSIVE, not reachable for a row
  // written today: `memory_edges` carries a CHECK that `tags` is valid JSON and
  // an array. It stays in the classifier for rows that predate that constraint,
  // and this test pins the reason it cannot be exercised directly — so a future
  // reader does not "simplify" the branch away on the grounds that no test
  // covers it.
  test("M0: the malformed-tags branch is unreachable for new rows — the schema CHECK refuses them first", () => {
    const segment = createSegment(db, { title: "seg", tags: [], nowEpoch: 100 });
    const a = seedTurn(1);
    const b = seedTurn(2);
    addMember(segment.id, a);
    addMember(segment.id, b);
    expect(() =>
      db
        .query<{ id: number }, [number, number, number]>(
          `INSERT INTO memory_edges (
             citing_kind, citing_id, cited_kind, cited_id, relation, provenance, tags, created_at_epoch
           ) VALUES ('turn', ?, 'turn', ?, 'extends', 'asserted', '["unterminated', ?) RETURNING id`,
        )
        .get(a, b, 100),
    ).toThrow(/CHECK constraint failed/);
  });

  test("M0: a tag no normalization can canonicalize is named in the receipt, and its edge still classifies on the survivors", () => {
    const segment = createSegment(db, { title: "seg", tags: [], nowEpoch: 100 });
    const a = seedTurn(3);
    const b = seedTurn(4);
    addMember(segment.id, a);
    addMember(segment.id, b);
    // "two words" survives trim/lowercase/NFC but still fails the predicate:
    // interior whitespace is never canonical.
    const edgeId = writeTaggedEdge(a, b, "extends", ["Rubric-V5", "two words"]);

    resetLaneMigrationReceipts();
    runLaneRegistryMigration(db, 200);

    const classification = readReceiptPayload<LaneMigrationClassification>(
      LANE_REGISTRY_M0_CLASSIFY_RECEIPT,
    );
    const placed = classification.placeable.find((entry) => entry.edgeId === edgeId);
    expect(placed?.tags).toEqual(["rubric-v5"]);
    const rejected = classification.rejected.find((entry) => entry.edgeId === edgeId);
    expect(rejected?.droppedTags).toEqual(["two words"]);
    expect(rejected?.reason).toBe("no-canonical-tag");
    // The survivor really did become a lane; the loss is recorded beside it.
    expect(getLane(db, segment.id, "rubric-v5")).not.toBeNull();
  });
});
