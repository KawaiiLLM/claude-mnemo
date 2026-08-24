import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  getLane,
  LANE_REGISTRY_M0_CLASSIFY_RECEIPT,
  LANE_REGISTRY_M2_SEED_RECEIPT,
  LANE_REGISTRY_M3_MEMBERSHIP_RECEIPT,
  LANE_REGISTRY_M4_DISPOSAL_RECEIPT,
  listLanesForSegment,
  runLaneRegistryMigration,
  type LaneMigrationClassification,
  type LaneMigrationDisposalReceipt,
  type LaneMigrationMembershipReceipt,
  type LaneMigrationSeedReceipt,
} from "../../src/db/lanes";
import { rebuildMemoryEdgeTagsIndex } from "../../src/db/memory-edges";
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
    // Ticket 04 (M3/M4) added two more phase receipts to the same family —
    // 4, not ticket 01's own pin of 2.
    const receiptCountBefore = db
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM migration_receipts WHERE name LIKE 'lane-declaration-%'",
      )
      .get()!.count;
    expect(receiptCountBefore).toBe(4);

    initializeSchema(db);
    initializeSchema(db);

    const receiptCountAfter = db
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM migration_receipts WHERE name LIKE 'lane-declaration-%'",
      )
      .get()!.count;
    expect(receiptCountAfter).toBe(4);
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

/**
 * Lane-declaration ticket 04 (spec D6/M3-M4, issue
 * `04-repair-migrations.md`). Same "reset the gate, exercise against real
 * fixture data" idiom as the ticket 01 block above, widened to all FOUR
 * phase receipts — M3/M4 join the same `migration_receipts` family and the
 * same `runLaneRegistryMigration` entry point, so a test that wants to
 * exercise them from a clean slate must reset M0-M2 alongside them: M4 reads
 * `notPlaceable` off M0's OWN receipt, not off a live re-classification.
 */
describe("lane registry migration (ticket 04, spec D6/M3-M4)", () => {
  let db: Database;
  let sessionId: number;

  function resetLaneMigrationReceipts(): void {
    db.query<unknown, [string, string, string, string]>(
      "DELETE FROM migration_receipts WHERE name IN (?, ?, ?, ?)",
    ).run(
      LANE_REGISTRY_M0_CLASSIFY_RECEIPT,
      LANE_REGISTRY_M2_SEED_RECEIPT,
      LANE_REGISTRY_M3_MEMBERSHIP_RECEIPT,
      LANE_REGISTRY_M4_DISPOSAL_RECEIPT,
    );
    db.exec("DELETE FROM lanes");
  }

  function seedTurn(promptNumber: number, tags?: string[] | null): number {
    return db
      .query<{ id: number }, [number, number, string | null, number]>(
        `INSERT INTO turns (session_id, prompt_number, status, tags, created_at_epoch)
         VALUES (?, ?, 'active', ?, ?) RETURNING id`,
      )
      .get(sessionId, promptNumber, tags === undefined ? null : tags === null ? null : JSON.stringify(tags), 100)!
      .id;
  }

  function getTurnTagsRaw(turnId: number): string | null {
    return db
      .query<{ tags: string | null }, [number]>("SELECT tags FROM turns WHERE id = ?")
      .get(turnId)!.tags;
  }

  function addMember(segmentId: number, turnId: number): void {
    db.query<unknown, [number, number, number]>(
      `INSERT INTO segment_members (segment_id, turn_id, created_at_epoch) VALUES (?, ?, ?)`,
    ).run(segmentId, turnId, 100);
  }

  /** Explicit `id` insert (`segments.id` is AUTOINCREMENT but accepts a caller-supplied value) — the only way to hit the real allowlist's segment id (60) from a fresh, otherwise-empty test database. */
  function createSegmentWithId(id: number, curatedTags: string[]): void {
    db.query<unknown, [number, string, string, number, number]>(
      `INSERT INTO segments (id, title, tags, created_at_epoch, updated_at_epoch)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, `segment ${id}`, JSON.stringify(curatedTags), 100, 100);
  }

  function writeEdge(
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

  function getEdgeById(
    edgeId: number,
  ): { relation: string; tags: string[] } | null {
    const row = db
      .query<{ relation: string; tags: string }, [number]>(
        "SELECT relation, tags FROM memory_edges WHERE id = ?",
      )
      .get(edgeId);
    return row ? { relation: row.relation, tags: JSON.parse(row.tags) } : null;
  }

  function tagIndexRowCount(edgeId: number): number {
    return db
      .query<{ count: number }, [number]>(
        "SELECT COUNT(*) AS count FROM memory_edge_tags WHERE edge_row_id = ?",
      )
      .get(edgeId)!.count;
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
      contentSessionId: "lane-migration-repair-session",
      project: "/tmp/project-lane-migration-repair",
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

  // -------------------------------------------------------------------------
  // M3 — allowlist stamp
  // -------------------------------------------------------------------------

  test("M3 stamps E60's tagless members by UNION, preserving their existing tags", () => {
    resetLaneMigrationReceipts();
    createSegmentWithId(60, ["claude-mnemo"]);
    const already = seedTurn(1, ["claude-mnemo"]);
    const tagless = seedTurn(2, ["existing-tag"]);
    addMember(60, already);
    addMember(60, tagless);

    runLaneRegistryMigration(db, 200);

    const receipt = readReceiptPayload<LaneMigrationMembershipReceipt>(
      LANE_REGISTRY_M3_MEMBERSHIP_RECEIPT,
    );
    expect(receipt.stamped).toEqual([
      { segmentId: 60, curatedTags: ["claude-mnemo"], stampedTurnIds: [tagless] },
    ]);
    expect(receipt.reported).toEqual([]);
    expect(receipt.malformed).toEqual([]);

    // Union, not replacement: the pre-existing tag survives alongside the stamp.
    expect(JSON.parse(getTurnTagsRaw(tagless)!)).toEqual(["existing-tag", "claude-mnemo"]);
    // A member that already carried the curated tag is untouched.
    expect(JSON.parse(getTurnTagsRaw(already)!)).toEqual(["claude-mnemo"]);
  });

  test("a segment NOT on the allowlist is reported, never stamped — even with only two curated tags (Rev 1's withdrawn heuristic)", () => {
    resetLaneMigrationReceipts();
    // Two curated tags: under Rev 1's "≤2 curated tags" heuristic this would
    // have been stamped. It must not be, because it is not on the reviewed
    // allowlist — a count is not provenance.
    const segment = createSegment(db, {
      title: "two-tag legacy segment",
      tags: ["derived-a", "derived-b"],
      nowEpoch: 100,
    });
    const tagless = seedTurn(1, []);
    addMember(segment.id, tagless);

    runLaneRegistryMigration(db, 200);

    const receipt = readReceiptPayload<LaneMigrationMembershipReceipt>(
      LANE_REGISTRY_M3_MEMBERSHIP_RECEIPT,
    );
    expect(receipt.stamped).toEqual([]);
    expect(receipt.reported).toEqual([
      { segmentId: segment.id, curatedTags: ["derived-a", "derived-b"], taglessMemberCount: 1 },
    ]);
    // Untouched — reported, not repaired.
    expect(JSON.parse(getTurnTagsRaw(tagless)!)).toEqual([]);
  });

  test("a 29-tag legacy segment (E53's live shape) is reported and its turns come out unchanged", () => {
    resetLaneMigrationReceipts();
    const derivedTags = Array.from({ length: 29 }, (_, i) => `derived-${i}`);
    const segment = createSegment(db, {
      title: "29-tag legacy segment",
      tags: derivedTags,
      nowEpoch: 100,
    });
    const member = seedTurn(1, ["derived-0"]); // has SOME, not all, curated tags
    addMember(segment.id, member);
    const before = getTurnTagsRaw(member);

    runLaneRegistryMigration(db, 200);

    const receipt = readReceiptPayload<LaneMigrationMembershipReceipt>(
      LANE_REGISTRY_M3_MEMBERSHIP_RECEIPT,
    );
    expect(receipt.stamped).toEqual([]);
    const reportedEntry = receipt.reported.find((r) => r.segmentId === segment.id);
    expect(reportedEntry?.curatedTags).toHaveLength(29);
    expect(reportedEntry?.taglessMemberCount).toBe(1);
    expect(getTurnTagsRaw(member)).toBe(before);
  });

  test("a malformed tags column on an E60 member is reported and skipped, never coerced to [] and overwritten", () => {
    resetLaneMigrationReceipts();
    createSegmentWithId(60, ["claude-mnemo"]);
    const malformedTurnId = seedTurn(1, []);
    // `turns.tags` carries no json_valid CHECK — unlike memory_edges/segments —
    // so this raw, unparseable value is directly storable.
    db.query<unknown, [string, number]>("UPDATE turns SET tags = ? WHERE id = ?").run(
      "[unterminated",
      malformedTurnId,
    );
    const nonArrayTurnId = seedTurn(2, []);
    db.query<unknown, [string, number]>("UPDATE turns SET tags = ? WHERE id = ?").run(
      '"just-a-string"',
      nonArrayTurnId,
    );
    addMember(60, malformedTurnId);
    addMember(60, nonArrayTurnId);

    runLaneRegistryMigration(db, 200);

    const receipt = readReceiptPayload<LaneMigrationMembershipReceipt>(
      LANE_REGISTRY_M3_MEMBERSHIP_RECEIPT,
    );
    expect(receipt.stamped).toEqual([]);
    expect(receipt.reported).toEqual([]);
    expect(receipt.malformed).toEqual(
      expect.arrayContaining([
        { turnId: malformedTurnId, segmentId: 60, rawTags: "[unterminated", reason: "malformed-tags-column" },
        { turnId: nonArrayTurnId, segmentId: 60, rawTags: '"just-a-string"', reason: "non-array-tags-column" },
      ]),
    );
    // Never coerced to `[]` and overwritten — the raw column is untouched.
    expect(getTurnTagsRaw(malformedTurnId)).toBe("[unterminated");
    expect(getTurnTagsRaw(nonArrayTurnId)).toBe('"just-a-string"');
  });

  test("a NULL tags column reads as tagless (not malformed) and is eligible for the stamp", () => {
    resetLaneMigrationReceipts();
    createSegmentWithId(60, ["claude-mnemo"]);
    const nullTagsTurn = seedTurn(1, null);
    addMember(60, nullTagsTurn);

    runLaneRegistryMigration(db, 200);

    const receipt = readReceiptPayload<LaneMigrationMembershipReceipt>(
      LANE_REGISTRY_M3_MEMBERSHIP_RECEIPT,
    );
    expect(receipt.malformed).toEqual([]);
    expect(receipt.stamped).toEqual([
      { segmentId: 60, curatedTags: ["claude-mnemo"], stampedTurnIds: [nullTagsTurn] },
    ]);
    expect(JSON.parse(getTurnTagsRaw(nullTagsTurn)!)).toEqual(["claude-mnemo"]);
  });

  // -------------------------------------------------------------------------
  // M4 — disposal by relation class
  // -------------------------------------------------------------------------

  test("an extends edge with a homeless endpoint is DELETED, not downgraded, and both addresses are recorded", () => {
    resetLaneMigrationReceipts();
    const segmentId = createSegment(db, { title: "owner", nowEpoch: 100 }).id;
    const owned = seedTurn(1);
    const homeless = seedTurn(2);
    addMember(segmentId, owned);
    const edgeId = writeEdge(homeless, owned, "extends", ["orphan-lane"]);

    runLaneRegistryMigration(db, 200);

    expect(getEdgeById(edgeId)).toBeNull();
    expect(tagIndexRowCount(edgeId)).toBe(0);
    const receipt = readReceiptPayload<LaneMigrationDisposalReceipt>(
      LANE_REGISTRY_M4_DISPOSAL_RECEIPT,
    );
    expect(receipt.deleted).toEqual([
      {
        edgeId,
        citingTurnId: homeless,
        citingAddress: `S${sessionId}/T2`,
        citedTurnId: owned,
        citedAddress: `S${sessionId}/T1`,
        relation: "extends",
        tags: ["orphan-lane"],
      },
    ]);
    expect(receipt.downgraded).toEqual([]);
  });

  test("a narrows edge with a homeless endpoint is DELETED too (same continuation class as extends)", () => {
    resetLaneMigrationReceipts();
    const segmentId = createSegment(db, { title: "owner", nowEpoch: 100 }).id;
    const owned = seedTurn(1);
    const homeless = seedTurn(2);
    addMember(segmentId, owned);
    const edgeId = writeEdge(homeless, owned, "narrows", ["orphan-lane"]);

    runLaneRegistryMigration(db, 200);

    expect(getEdgeById(edgeId)).toBeNull();
    const receipt = readReceiptPayload<LaneMigrationDisposalReceipt>(
      LANE_REGISTRY_M4_DISPOSAL_RECEIPT,
    );
    expect(receipt.deleted).toHaveLength(1);
    expect(receipt.deleted[0]!.relation).toBe("narrows");
  });

  test("a non-continuation relation with a homeless endpoint downgrades to untagged in place, and its tag index is cleared", () => {
    resetLaneMigrationReceipts();
    const segmentId = createSegment(db, { title: "owner", nowEpoch: 100 }).id;
    const owned = seedTurn(1);
    const homeless = seedTurn(2);
    addMember(segmentId, owned);
    const edgeId = writeEdge(homeless, owned, "override", ["orphan-lane"]);

    runLaneRegistryMigration(db, 200);

    expect(getEdgeById(edgeId)).toEqual({ relation: "override", tags: [] });
    expect(tagIndexRowCount(edgeId)).toBe(0);
    const receipt = readReceiptPayload<LaneMigrationDisposalReceipt>(
      LANE_REGISTRY_M4_DISPOSAL_RECEIPT,
    );
    expect(receipt.deleted).toEqual([]);
    expect(receipt.downgraded).toEqual([
      {
        edgeId,
        citingTurnId: homeless,
        citingAddress: `S${sessionId}/T2`,
        citedTurnId: owned,
        citedAddress: `S${sessionId}/T1`,
        relation: "override",
        tags: ["orphan-lane"],
        disposition: "downgraded",
      },
    ]);
  });

  test("a downgrade MERGES into a pre-existing untagged row for the same (pair, relation) rather than colliding with the UNIQUE key", () => {
    resetLaneMigrationReceipts();
    const segmentId = createSegment(db, { title: "owner", nowEpoch: 100 }).id;
    const owned = seedTurn(1);
    const homeless = seedTurn(2);
    addMember(segmentId, owned);
    // Pre-existing untagged row for the SAME pair + relation.
    const untaggedEdgeId = writeEdge(homeless, owned, "override", []);
    const taggedEdgeId = writeEdge(homeless, owned, "override", ["orphan-lane"]);

    runLaneRegistryMigration(db, 200);

    // The tagged row is gone; the pre-existing untagged row survives untouched.
    expect(getEdgeById(taggedEdgeId)).toBeNull();
    expect(getEdgeById(untaggedEdgeId)).toEqual({ relation: "override", tags: [] });
    const receipt = readReceiptPayload<LaneMigrationDisposalReceipt>(
      LANE_REGISTRY_M4_DISPOSAL_RECEIPT,
    );
    expect(receipt.downgraded).toEqual([
      {
        edgeId: taggedEdgeId,
        citingTurnId: homeless,
        citingAddress: `S${sessionId}/T2`,
        citedTurnId: owned,
        citedAddress: `S${sessionId}/T1`,
        relation: "override",
        tags: ["orphan-lane"],
        disposition: "merged",
        mergedIntoEdgeId: untaggedEdgeId,
      },
    ]);
  });

  test("two tagged homeless-endpoint rows on the SAME (pair, relation) collapse sequentially — the first downgrades in place, the second merges into it", () => {
    resetLaneMigrationReceipts();
    const segmentId = createSegment(db, { title: "owner", nowEpoch: 100 }).id;
    const owned = seedTurn(1);
    const homeless = seedTurn(2);
    addMember(segmentId, owned);
    // Neither row is untagged yet — both are illegal (homeless endpoint,
    // non-empty tags) and both are in M0's notPlaceable set. M4 must not
    // downgrade both in place: the second one to land would collide with the
    // first's own now-untagged row under the (pair, relation, tags) UNIQUE key.
    const firstEdgeId = writeEdge(homeless, owned, "grounds", ["orphan-a"]);
    const secondEdgeId = writeEdge(homeless, owned, "grounds", ["orphan-b"]);

    runLaneRegistryMigration(db, 200);

    const receipt = readReceiptPayload<LaneMigrationDisposalReceipt>(
      LANE_REGISTRY_M4_DISPOSAL_RECEIPT,
    );
    expect(receipt.deleted).toEqual([]);
    expect(receipt.downgraded).toHaveLength(2);
    // Which of the two processes first is an SQL row-order detail this test
    // does not pin — only that exactly one survives (downgraded in place)
    // and the other collapses into it (merged), never both downgrading and
    // colliding on the UNIQUE key.
    const survivor = receipt.downgraded.find((d) => d.disposition === "downgraded")!;
    const casualty = receipt.downgraded.find((d) => d.disposition === "merged")!;
    expect(survivor).toBeDefined();
    expect(casualty).toBeDefined();
    expect(new Set([survivor.edgeId, casualty.edgeId])).toEqual(
      new Set([firstEdgeId, secondEdgeId]),
    );
    expect(casualty.mergedIntoEdgeId).toBe(survivor.edgeId);
    // Exactly one surviving row for the pair, now untagged.
    expect(getEdgeById(survivor.edgeId)).toEqual({ relation: "grounds", tags: [] });
    expect(getEdgeById(casualty.edgeId)).toBeNull();
  });

  test("a placeable (both-owned) edge is untouched by M4 — only notPlaceable is disposed of", () => {
    resetLaneMigrationReceipts();
    const segmentId = createSegment(db, { title: "owner", nowEpoch: 100 }).id;
    const a = seedTurn(1);
    const b = seedTurn(2);
    addMember(segmentId, a);
    addMember(segmentId, b);
    const edgeId = writeEdge(b, a, "extends", ["write-gate"]);

    runLaneRegistryMigration(db, 200);

    expect(getEdgeById(edgeId)).toEqual({ relation: "extends", tags: ["write-gate"] });
    const receipt = readReceiptPayload<LaneMigrationDisposalReceipt>(
      LANE_REGISTRY_M4_DISPOSAL_RECEIPT,
    );
    expect(receipt.deleted).toEqual([]);
    expect(receipt.downgraded).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Second run is a no-op; the combined fixture mirroring the live shapes.
  // -------------------------------------------------------------------------

  // The tag index must not outlive the tags it indexes. M4 maintains
  // `memory_edge_tags` by hand — a full rebuild would need its own
  // transaction, which cannot nest inside this one — so the invariant it is
  // maintaining gets asserted directly rather than trusted per branch: after
  // the migration, no index row may claim a tag its edge no longer carries,
  // and no carried tag may be missing from the index.
  test("M4 leaves the tag index in exact agreement with the edges it indexes", () => {
    resetLaneMigrationReceipts();
    const segmentId = createSegment(db, { title: "index agreement", tags: [], nowEpoch: 100 }).id;
    const owned = seedTurn(1);
    const homeless = seedTurn(2);
    const other = seedTurn(3);
    addMember(segmentId, owned);
    addMember(segmentId, other);
    // One of each disposition class, all with a homeless endpoint so M4 acts:
    // a continuation edge (deleted), a non-continuation edge (downgraded), and
    // a legal edge that must be left completely alone.
    writeEdge(homeless, owned, "extends", ["gone"]);
    writeEdge(homeless, owned, "consume", ["downgraded-lane"]);
    writeEdge(other, owned, "extends", ["kept"]);
    // The fixture's raw INSERTs bypass the writer that maintains the index, so
    // put the database in the state a REAL one is in before asking M4 to keep
    // it that way. Without this the assertions below pass vacuously over an
    // empty index — which is exactly how an index-maintenance bug hides.
    rebuildMemoryEdgeTagsIndex(db);

    runLaneRegistryMigration(db, 200);

    const indexRows = db
      .query<{ edgeRowId: number; tag: string }, []>(
        "SELECT edge_row_id AS edgeRowId, tag FROM memory_edge_tags",
      )
      .all();
    const edges = db
      .query<{ id: number; tags: string }, []>("SELECT id, tags FROM memory_edges")
      .all();
    const tagsByEdge = new Map(edges.map((edge) => [edge.id, JSON.parse(edge.tags) as string[]]));
    // No index row without its tag on the edge (and none pointing at a gone edge).
    for (const row of indexRows) {
      expect(tagsByEdge.get(row.edgeRowId) ?? []).toContain(row.tag);
    }
    // No carried tag missing from the index.
    for (const [edgeId, tags] of tagsByEdge) {
      for (const tag of tags) {
        expect(indexRows.some((row) => row.edgeRowId === edgeId && row.tag === tag)).toBe(true);
      }
    }
    // And the shape M4 was supposed to produce, so a vacuously empty index
    // cannot pass the two loops above.
    expect(tagsByEdge.size).toBe(2);
    expect([...tagsByEdge.values()].map((tags) => tags.join(",")).sort()).toEqual(["", "kept"]);
  });

  test("M3 and M4 are both no-ops on a second run", () => {
    resetLaneMigrationReceipts();
    createSegmentWithId(60, ["claude-mnemo"]);
    const owned = seedTurn(1, []);
    const homeless = seedTurn(2);
    addMember(60, owned);
    writeEdge(homeless, owned, "extends", ["orphan-lane"]);

    runLaneRegistryMigration(db, 200);
    const m3After1 = readReceiptPayload<LaneMigrationMembershipReceipt>(
      LANE_REGISTRY_M3_MEMBERSHIP_RECEIPT,
    );
    const m4After1 = readReceiptPayload<LaneMigrationDisposalReceipt>(
      LANE_REGISTRY_M4_DISPOSAL_RECEIPT,
    );

    // Fixture changes AFTER the first run: if a second run incorrectly
    // re-classified or re-repaired, these would show up in the receipts.
    const latecomer = seedTurn(3, []);
    addMember(60, latecomer);
    const other = seedTurn(4);
    const laterHomeless = seedTurn(5);
    writeEdge(laterHomeless, other, "narrows", ["late-lane"]);

    runLaneRegistryMigration(db, 300);
    runLaneRegistryMigration(db, 300);

    const m3After2 = readReceiptPayload<LaneMigrationMembershipReceipt>(
      LANE_REGISTRY_M3_MEMBERSHIP_RECEIPT,
    );
    const m4After2 = readReceiptPayload<LaneMigrationDisposalReceipt>(
      LANE_REGISTRY_M4_DISPOSAL_RECEIPT,
    );
    expect(m3After2).toEqual(m3After1);
    expect(m4After2).toEqual(m4After1);
    // The latecomer member was never stamped, and the later illegal edge
    // was never disposed of — a second run is a true no-op, not a partial one.
    expect(JSON.parse(getTurnTagsRaw(latecomer)!)).toEqual([]);
  });

  test("combined fixture mirroring the live shapes: homeless endpoint, cross-segment edge, multi-tag edge, extends with no legal placement, a member lacking the segment tag, a 29-tag legacy segment, a malformed tags column", () => {
    resetLaneMigrationReceipts();

    // E60 allowlisted segment with a tagless member.
    createSegmentWithId(60, ["claude-mnemo"]);
    const e60Member = seedTurn(1, []);
    addMember(60, e60Member);

    // A 29-tag legacy segment, reported not stamped.
    const derivedTags = Array.from({ length: 29 }, (_, i) => `derived-${i}`);
    const legacySegment = createSegment(db, { title: "legacy", tags: derivedTags, nowEpoch: 100 });
    const legacyMember = seedTurn(2, []);
    addMember(legacySegment.id, legacyMember);

    // Cross-segment placeable edge — untouched by M3/M4, seeds lanes on both sides.
    const segA = createSegment(db, { title: "A", nowEpoch: 100 });
    const segB = createSegment(db, { title: "B", nowEpoch: 100 });
    const crossA = seedTurn(3, ["shared-lane"]);
    const crossB = seedTurn(4, ["shared-lane"]);
    addMember(segA.id, crossA);
    addMember(segB.id, crossB);
    const crossEdgeId = writeEdge(crossB, crossA, "override", ["shared-lane"]);

    // extends edge, homeless endpoint, multi-tag — deleted with both tags recorded.
    const homeless = seedTurn(5);
    const owned = seedTurn(6);
    addMember(segA.id, owned);
    const extendsEdgeId = writeEdge(homeless, owned, "extends", ["orphan-a", "orphan-b"]);

    // A member turn with a malformed tags column, inside the allowlisted segment.
    const malformedMember = seedTurn(7, []);
    db.query<unknown, [string, number]>("UPDATE turns SET tags = ? WHERE id = ?").run(
      "{not json",
      malformedMember,
    );
    addMember(60, malformedMember);

    runLaneRegistryMigration(db, 200);

    // M0/M2: the cross-segment edge is placeable and seeds both segments.
    const classification = readReceiptPayload<LaneMigrationClassification>(
      LANE_REGISTRY_M0_CLASSIFY_RECEIPT,
    );
    expect(classification.placeable.some((e) => e.edgeId === crossEdgeId)).toBe(true);
    expect(getLane(db, segA.id, "shared-lane")).not.toBeNull();
    expect(getLane(db, segB.id, "shared-lane")).not.toBeNull();

    // M3: E60's tagless member is stamped; the legacy segment is reported and
    // untouched; the malformed member is reported and untouched.
    const membershipReceipt = readReceiptPayload<LaneMigrationMembershipReceipt>(
      LANE_REGISTRY_M3_MEMBERSHIP_RECEIPT,
    );
    expect(membershipReceipt.stamped).toEqual([
      { segmentId: 60, curatedTags: ["claude-mnemo"], stampedTurnIds: [e60Member] },
    ]);
    expect(membershipReceipt.reported).toEqual([
      { segmentId: legacySegment.id, curatedTags: derivedTags, taglessMemberCount: 1 },
    ]);
    expect(membershipReceipt.malformed).toEqual([
      { turnId: malformedMember, segmentId: 60, rawTags: "{not json", reason: "malformed-tags-column" },
    ]);
    expect(JSON.parse(getTurnTagsRaw(e60Member)!)).toEqual(["claude-mnemo"]);
    expect(getTurnTagsRaw(legacyMember)).toBe("[]");
    expect(getTurnTagsRaw(malformedMember)).toBe("{not json");

    // M4: the extends edge is DELETED (not downgraded), both tags and both
    // addresses recorded; the cross-segment placeable edge is untouched.
    const disposalReceipt = readReceiptPayload<LaneMigrationDisposalReceipt>(
      LANE_REGISTRY_M4_DISPOSAL_RECEIPT,
    );
    expect(disposalReceipt.deleted).toEqual([
      {
        edgeId: extendsEdgeId,
        citingTurnId: homeless,
        citingAddress: `S${sessionId}/T5`,
        citedTurnId: owned,
        citedAddress: `S${sessionId}/T6`,
        relation: "extends",
        tags: ["orphan-a", "orphan-b"],
      },
    ]);
    expect(disposalReceipt.downgraded).toEqual([]);
    expect(getEdgeById(extendsEdgeId)).toBeNull();
    expect(getEdgeById(crossEdgeId)).toEqual({ relation: "override", tags: ["shared-lane"] });
  });
});
