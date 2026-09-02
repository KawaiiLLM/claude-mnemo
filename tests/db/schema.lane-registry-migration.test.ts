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
import { initializeSchema } from "../../src/db/schema";
import { createSegment } from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { downgradeTurnsTagsToPreCutover } from "../support/pre-cutover-edge-shape";
import { downgradeToPreV12EdgeShape } from "../support/pre-v12-edge-shape";

/**
 * Regenerate the RETIRED merged tag index from the PRE-v12 `tags` column.
 *
 * A local fixture helper since lane-model-v12 ticket 09: the production
 * function it replaces (`rebuildMemoryEdgeTagsIndex`) left `db/memory-edges.ts`
 * with the column, because the storage layer must hold no reference to an
 * index whose last reader went at ticket 06. The fixtures below still need it,
 * since their raw INSERTs bypass the writer that used to maintain it and an
 * empty index is exactly how an index-maintenance bug hides.
 */
function rebuildLegacyTagIndex(db: Database): void {
  db.exec("DELETE FROM memory_edge_tags");
  db.exec(`
    INSERT INTO memory_edge_tags (edge_row_id, tag)
    SELECT memory_edges.id, tag_value.value
    FROM memory_edges, json_each(memory_edges.tags) AS tag_value
  `);
}

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

  /**
   * The migration as it can really be reached: against the PRE-v12 edge
   * shape. `initializeSchema` now ends with lane-model-v12 ticket 05's M-A,
   * so the bootstrap above leaves `memory_edges` two-sided — and ticket 01's
   * barrier refuses a PENDING registry phase against that shape, correctly:
   * no upgrade path produces it. The fixture data is built through the LIVE
   * write paths first (they need the new columns), and the shape moves back
   * immediately before the phases run.
   */
  function runRegistryMigration(nowEpoch: number): void {
    downgradeToPreV12EdgeShape(db);
    runLaneRegistryMigration(db, nowEpoch);
  }

  /** `options` (ticket 14) is how a test makes an endpoint DEAD by law 8 — `status: "skipped"` (dormant) or `wasRolledBack` (deleted). */
  function seedTurn(
    promptNumber: number,
    options: { status?: string; wasRolledBack?: boolean } = {},
  ): number {
    return db
      .query<{ id: number }, [number, number, string, number, number]>(
        `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch, was_rolled_back)
         VALUES (?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        sessionId,
        promptNumber,
        options.status ?? "active",
        100,
        options.wasRolledBack ? 1 : 0,
      )!.id;
  }

  function addMember(segmentId: number, turnId: number): void {
    db.query<unknown, [number, number, number]>(
      `INSERT INTO segment_members (segment_id, turn_id, created_at_epoch) VALUES (?, ?, ?)`,
    ).run(segmentId, turnId, 100);
  }

  /** Ticket 09: states the PRE-v12 column, so it owns the era switch — see `writeEdge` in the M3/M4 describe below for the full reasoning. */
  function writeTaggedEdge(
    citingId: number,
    citedId: number,
    relation: string,
    tags: string[],
  ): number {
    downgradeToPreV12EdgeShape(db);
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
    expect(m2Payload).toEqual({
      perSegment: [],
      totalSeeded: 0,
      skippedNamespaceCollisions: [],
    });
  });

  test("M0 classifies a same-segment tagged edge as placeable, and M2 seeds it", () => {
    resetLaneMigrationReceipts();
    const segmentId = createSegment(db, { title: "Same segment", nowEpoch: 100 }).id;
    const t1 = seedTurn(1);
    const t2 = seedTurn(2);
    addMember(segmentId, t1);
    addMember(segmentId, t2);
    writeTaggedEdge(t2, t1, "extends", ["write-gate"]);

    runRegistryMigration(200);

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

    runRegistryMigration(200);

    const classification = readReceiptPayload<LaneMigrationClassification>(
      LANE_REGISTRY_M0_CLASSIFY_RECEIPT,
    );
    expect(classification.placeable).toEqual([]);
    expect(classification.notPlaceable).toHaveLength(1);
    expect(classification.notPlaceable[0]!.tags).toEqual(["orphan-lane"]);

    expect(getLane(db, segmentId, "orphan-lane")).toBeNull();
    expect(listLanesForSegment(db, segmentId)).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // ticket 14 — law 8 on the migration path
  // -------------------------------------------------------------------------

  test("ticket 14: a tagged edge whose CITED endpoint is SKIPPED seeds no lane — M0 classifies it into no bucket at all", () => {
    resetLaneMigrationReceipts();
    const segmentId = createSegment(db, { title: "Skipped endpoint", nowEpoch: 100 }).id;
    const live = seedTurn(1);
    const skipped = seedTurn(2, { status: "skipped" });
    addMember(segmentId, live);
    addMember(segmentId, skipped);
    writeTaggedEdge(live, skipped, "extends", ["dormant-lane"]);

    runRegistryMigration(200);

    const classification = readReceiptPayload<LaneMigrationClassification>(
      LANE_REGISTRY_M0_CLASSIFY_RECEIPT,
    );
    // Both placement buckets AND `rejected`: a row that is not an edge needs
    // no disposition, and `skipped` is DORMANT — `promoteTurnFromNote`
    // restores the turn with its edges intact, so M4 must not strip a tag
    // that a reversible condition merely hid.
    expect(classification.placeable).toEqual([]);
    expect(classification.notPlaceable).toEqual([]);
    expect(classification.rejected).toEqual([]);
    expect(getLane(db, segmentId, "dormant-lane")).toBeNull();
    expect(listLanesForSegment(db, segmentId)).toEqual([]);
  });

  test("ticket 14: a tagged edge whose CITING endpoint is ROLLED BACK seeds no lane either", () => {
    resetLaneMigrationReceipts();
    const segmentId = createSegment(db, { title: "Rolled-back endpoint", nowEpoch: 100 }).id;
    const live = seedTurn(1);
    const rolledBack = seedTurn(2, { wasRolledBack: true });
    addMember(segmentId, live);
    addMember(segmentId, rolledBack);
    writeTaggedEdge(rolledBack, live, "extends", ["rewound-lane"]);

    runRegistryMigration(200);

    const classification = readReceiptPayload<LaneMigrationClassification>(
      LANE_REGISTRY_M0_CLASSIFY_RECEIPT,
    );
    expect(classification.placeable).toEqual([]);
    expect(classification.notPlaceable).toEqual([]);
    expect(classification.rejected).toEqual([]);
    expect(getLane(db, segmentId, "rewound-lane")).toBeNull();
  });

  test("ticket 14: a LIVE edge beside a dead-endpoint one still seeds — the filter narrows, it does not stall the phase", () => {
    resetLaneMigrationReceipts();
    const segmentId = createSegment(db, { title: "Mixed", nowEpoch: 100 }).id;
    const t1 = seedTurn(1);
    const t2 = seedTurn(2);
    const skipped = seedTurn(3, { status: "skipped" });
    addMember(segmentId, t1);
    addMember(segmentId, t2);
    addMember(segmentId, skipped);
    writeTaggedEdge(t2, t1, "extends", ["live-lane"]);
    writeTaggedEdge(skipped, t1, "extends", ["dead-lane"]);

    runRegistryMigration(200);

    expect(getLane(db, segmentId, "live-lane")).not.toBeNull();
    expect(getLane(db, segmentId, "dead-lane")).toBeNull();
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

    runRegistryMigration(200);

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

    runRegistryMigration(200);

    const seedReceipt = readReceiptPayload<LaneMigrationSeedReceipt>(
      LANE_REGISTRY_M2_SEED_RECEIPT,
    );
    expect(seedReceipt).toEqual({
      perSegment: [{ segmentId, count: 2 }],
      totalSeeded: 2,
      skippedNamespaceCollisions: [],
    });
  });

  /**
   * ONE NAMESPACE, AND A MIGRATION MAY NOT MINT WHAT IT OUTLAWS (lane-model-v12
   * D3e, peer A2). A legacy edge tag that happens to spell some segment's own
   * tag would become a lane whose word already means "member of that segment",
   * which is the exact state `insertLane` now refuses.
   *
   * The refusal is a THROW, and this loop runs inside `initializeSchema` — so
   * M2 asks the same question itself and SKIPS, naming the skip in its receipt.
   * Without the skip, one such tag on the live database would abort schema
   * initialisation for every process that opens it; without the receipt entry,
   * the tag would vanish with no record that it has no lane to be legal under.
   */
  test("M2 skips a legacy tag that is already some segment's own tag, and names the skip", () => {
    resetLaneMigrationReceipts();
    const segmentId = createSegment(db, { title: "Seeding", nowEpoch: 100 }).id;
    const holder = createSegment(db, {
      title: "Holds the word",
      tags: ["contested"],
      nowEpoch: 100,
    }).id;
    const t1 = seedTurn(1);
    const t2 = seedTurn(2);
    addMember(segmentId, t1);
    addMember(segmentId, t2);
    writeTaggedEdge(t2, t1, "extends", ["contested", "legal-lane"]);

    runRegistryMigration(200);

    expect(getLane(db, segmentId, "contested")).toBeNull();
    expect(getLane(db, segmentId, "legal-lane")).not.toBeNull();
    const seedReceipt = readReceiptPayload<LaneMigrationSeedReceipt>(
      LANE_REGISTRY_M2_SEED_RECEIPT,
    );
    expect(seedReceipt).toEqual({
      perSegment: [{ segmentId, count: 1 }],
      totalSeeded: 1,
      skippedNamespaceCollisions: [{ segmentId, tag: "contested", holderSegmentId: holder }],
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

    runRegistryMigration(200);

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

    runRegistryMigration(200);

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

    runRegistryMigration(200);
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

    runRegistryMigration(300);
    runRegistryMigration(300);

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
  // The `malformed-tags-column` branch is DEFENSIVE for rows written TODAY:
  // `memory_edges` carries a CHECK that `tags` is valid JSON and an array. It
  // stays in the classifier for rows that predate that constraint, and this
  // test pins WHY a normal INSERT cannot reach it — so a future reader does not
  // "simplify" the branch away. The branch itself is exercised end-to-end by
  // ticket 13's own tests below, which write such a row the only way one can
  // exist at all: with the CHECK suspended, exactly as a pre-CHECK row was.
  test("M0: the malformed-tags branch is unreachable for new rows — the schema CHECK refuses them first", () => {
    const segment = createSegment(db, { title: "seg", tags: [], nowEpoch: 100 });
    const a = seedTurn(1);
    const b = seedTurn(2);
    addMember(segment.id, a);
    addMember(segment.id, b);
    // The era switch has to be explicit here: this test asserts on the
    // PRE-v12 table's own CHECK, and ticket 09's contracted table has no such
    // column to refuse anything with.
    downgradeToPreV12EdgeShape(db);
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
    runRegistryMigration(200);

    const classification = readReceiptPayload<LaneMigrationClassification>(
      LANE_REGISTRY_M0_CLASSIFY_RECEIPT,
    );
    const placed = classification.placeable.find((entry) => entry.edgeId === edgeId);
    expect(placed?.tags).toEqual(["rubric-v5"]);
    const rejected = classification.rejected.find((entry) => entry.edgeId === edgeId);
    expect(rejected?.droppedTags).toEqual(["two words"]);
    // A PARTIAL loss, and named as one (ticket 13): the edge kept a canonical
    // tag and still classified, so this reason is precisely the one M4 must
    // not act on. `no-canonical-tag` now means a FULL rejection only.
    expect(rejected?.reason).toBe("partial-canonical-loss");
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

  /**
   * The migration as it can really be reached: against the PRE-v12 edge
   * shape. `initializeSchema` now ends with lane-model-v12 ticket 05's M-A,
   * so the bootstrap above leaves `memory_edges` two-sided — and ticket 01's
   * barrier refuses a PENDING registry phase against that shape, correctly:
   * no upgrade path produces it. The fixture data is built through the LIVE
   * write paths first (they need the new columns), and the shape moves back
   * immediately before the phases run.
   */
  function runRegistryMigration(nowEpoch: number): void {
    downgradeToPreV12EdgeShape(db);
    runLaneRegistryMigration(db, nowEpoch);
  }

  /**
   * M3 was written against a `turns.tags` that could be NULL or malformed —
   * the two states it reports and skips. The main-agent-edges cutover
   * normalised both away and put a trigger over the column, so these fixtures
   * cannot be seeded on the post-cutover shape at all; the turns table moves
   * back to the shape THIS migration actually ran against, exactly as
   * `downgradeToPreV12EdgeShape` moves the edge table back.
   */
  function seedTurn(promptNumber: number, tags?: string[] | null): number {
    downgradeTurnsTagsToPreCutover(db);
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

  /**
   * Ticket 09: `initializeSchema` now ends with M-E, so the table it hands
   * back has no `tags` column — while this fixture states that column
   * directly, and must, because the shapes it builds (a MULTI-tag set, a
   * payload that is not even a JSON array) have no two-sided form at all.
   * So the edge fixtures own the era switch: turns and segments are still
   * built through the LIVE write paths (which need the current shape), and
   * the table moves back to the era the phases under test actually run in at
   * the first edge write. Idempotent, so `runRegistryMigration`'s own call is
   * then a no-op.
   */
  function writeEdge(
    citingId: number,
    citedId: number,
    relation: string,
    tags: string[],
  ): number {
    downgradeToPreV12EdgeShape(db);
    return db
      .query<{ id: number }, [number, number, string, string, number]>(
        `INSERT INTO memory_edges (
           citing_kind, citing_id, cited_kind, cited_id, relation, provenance, tags, created_at_epoch
         ) VALUES ('turn', ?, 'turn', ?, ?, 'asserted', ?, ?) RETURNING id`,
      )
      .get(citingId, citedId, relation, JSON.stringify(tags), 100)!.id;
  }

  /**
   * The ONLY way a row whose `tags` is not a readable JSON array can come to
   * exist (ticket 13): `memory_edges.tags` has carried a
   * `json_valid(tags) AND json_type(tags) = 'array'` CHECK since long before
   * this ticket, so such a row can only PREDATE that constraint. Suspending
   * the CHECK for the one INSERT reproduces that history exactly; it is
   * restored immediately, so the migration under test still runs against a
   * fully constrained table.
   */
  function writeEdgeWithRawTags(
    citingId: number,
    citedId: number,
    relation: string,
    rawTags: string,
  ): number {
    downgradeToPreV12EdgeShape(db);
    db.exec("PRAGMA ignore_check_constraints = ON");
    try {
      return db
        .query<{ id: number }, [number, number, string, string, number]>(
          `INSERT INTO memory_edges (
             citing_kind, citing_id, cited_kind, cited_id, relation, provenance, tags, created_at_epoch
           ) VALUES ('turn', ?, 'turn', ?, ?, 'asserted', ?, ?) RETURNING id`,
        )
        .get(citingId, citedId, relation, rawTags, 100)!.id;
    } finally {
      db.exec("PRAGMA ignore_check_constraints = OFF");
    }
  }

  /** The `tags` column verbatim — the only assertion available for a row `getEdgeById` would throw on. */
  function getEdgeRawTags(edgeId: number): string | null {
    return (
      db
        .query<{ tags: string }, [number]>("SELECT tags FROM memory_edges WHERE id = ?")
        .get(edgeId)?.tags ?? null
    );
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

    runRegistryMigration(200);

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

    runRegistryMigration(200);

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

    runRegistryMigration(200);

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

    runRegistryMigration(200);

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

    runRegistryMigration(200);

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
  // M4 — disposal, downgrade to untagged (repair [S15069/T1566], peer P1-1:
  // the tag mandate that made an untagged `extends`/`narrows` illegal is
  // withdrawn, so M4 no longer deletes any relation class — every relation,
  // `extends`/`narrows` included, downgrades or merges like any other).
  // -------------------------------------------------------------------------

  test("an extends edge with a homeless endpoint downgrades to untagged in place — extends/narrows are no longer deleted", () => {
    resetLaneMigrationReceipts();
    const segmentId = createSegment(db, { title: "owner", nowEpoch: 100 }).id;
    const owned = seedTurn(1);
    const homeless = seedTurn(2);
    addMember(segmentId, owned);
    const edgeId = writeEdge(homeless, owned, "extends", ["orphan-lane"]);

    runRegistryMigration(200);

    expect(getEdgeById(edgeId)).toEqual({ relation: "extends", tags: [] });
    expect(tagIndexRowCount(edgeId)).toBe(0);
    const receipt = readReceiptPayload<LaneMigrationDisposalReceipt>(
      LANE_REGISTRY_M4_DISPOSAL_RECEIPT,
    );
    expect(receipt.downgraded).toEqual([
      {
        edgeId,
        citingTurnId: homeless,
        citingAddress: `S${sessionId}/T2`,
        citedTurnId: owned,
        citedAddress: `S${sessionId}/T1`,
        relation: "extends",
        tags: ["orphan-lane"],
        rawTags: '["orphan-lane"]',
        cause: "homeless-endpoint",
        disposition: "downgraded",
      },
    ]);
  });

  test("a narrows edge with a homeless endpoint also merges into a pre-existing untagged row — same as any other relation now (no continuation class left)", () => {
    resetLaneMigrationReceipts();
    const segmentId = createSegment(db, { title: "owner", nowEpoch: 100 }).id;
    const owned = seedTurn(1);
    const homeless = seedTurn(2);
    addMember(segmentId, owned);
    const untaggedEdgeId = writeEdge(homeless, owned, "narrows", []);
    const edgeId = writeEdge(homeless, owned, "narrows", ["orphan-lane"]);

    runRegistryMigration(200);

    expect(getEdgeById(edgeId)).toBeNull();
    expect(getEdgeById(untaggedEdgeId)).toEqual({ relation: "narrows", tags: [] });
    const receipt = readReceiptPayload<LaneMigrationDisposalReceipt>(
      LANE_REGISTRY_M4_DISPOSAL_RECEIPT,
    );
    expect(receipt.downgraded).toEqual([
      {
        edgeId,
        citingTurnId: homeless,
        citingAddress: `S${sessionId}/T2`,
        citedTurnId: owned,
        citedAddress: `S${sessionId}/T1`,
        relation: "narrows",
        tags: ["orphan-lane"],
        rawTags: '["orphan-lane"]',
        cause: "homeless-endpoint",
        disposition: "merged",
        mergedIntoEdgeId: untaggedEdgeId,
      },
    ]);
  });

  test("a relation with a homeless endpoint downgrades to untagged in place, and its tag index is cleared", () => {
    resetLaneMigrationReceipts();
    const segmentId = createSegment(db, { title: "owner", nowEpoch: 100 }).id;
    const owned = seedTurn(1);
    const homeless = seedTurn(2);
    addMember(segmentId, owned);
    const edgeId = writeEdge(homeless, owned, "override", ["orphan-lane"]);

    runRegistryMigration(200);

    expect(getEdgeById(edgeId)).toEqual({ relation: "override", tags: [] });
    expect(tagIndexRowCount(edgeId)).toBe(0);
    const receipt = readReceiptPayload<LaneMigrationDisposalReceipt>(
      LANE_REGISTRY_M4_DISPOSAL_RECEIPT,
    );
    expect(receipt.downgraded).toEqual([
      {
        edgeId,
        citingTurnId: homeless,
        citingAddress: `S${sessionId}/T2`,
        citedTurnId: owned,
        citedAddress: `S${sessionId}/T1`,
        relation: "override",
        tags: ["orphan-lane"],
        rawTags: '["orphan-lane"]',
        cause: "homeless-endpoint",
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

    runRegistryMigration(200);

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
        rawTags: '["orphan-lane"]',
        cause: "homeless-endpoint",
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

    runRegistryMigration(200);

    const receipt = readReceiptPayload<LaneMigrationDisposalReceipt>(
      LANE_REGISTRY_M4_DISPOSAL_RECEIPT,
    );
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

    runRegistryMigration(200);

    expect(getEdgeById(edgeId)).toEqual({ relation: "extends", tags: ["write-gate"] });
    const receipt = readReceiptPayload<LaneMigrationDisposalReceipt>(
      LANE_REGISTRY_M4_DISPOSAL_RECEIPT,
    );
    expect(receipt.downgraded).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // ticket 13 — M4 also disposes of the REJECTED edges no declaration could
  // ever legalize, and of nothing else in that bucket. `rejected` holds two
  // shapes: a FULL rejection (no canonical tag survived — the edge reaches no
  // other bucket, so nothing but this consumes it) and a PARTIAL loss (some
  // tags survived, the edge classifies on them and appears in a placement
  // bucket too). The reason field is the discriminator, on the receipt itself.
  // -------------------------------------------------------------------------

  test("ticket 13: a FULLY rejected edge — no tag survives canonicalization — is downgraded, its tag index cleared, and the receipt names the shape", () => {
    resetLaneMigrationReceipts();
    const segmentId = createSegment(db, { title: "owner", tags: [], nowEpoch: 100 }).id;
    const a = seedTurn(1, []);
    const b = seedTurn(2, []);
    addMember(segmentId, a);
    addMember(segmentId, b);
    // BOTH endpoints own a segment, so this edge is emphatically NOT
    // `notPlaceable`: the rejected bucket is the only path that can reach it,
    // which is the whole point of the test. "two words" survives
    // trim/lowercase/NFC and still fails D1 — interior whitespace is never
    // canonical — so no `declare` could ever name this lane.
    const edgeId = writeEdge(b, a, "extends", ["two words"]);
    rebuildLegacyTagIndex(db);
    expect(tagIndexRowCount(edgeId)).toBe(1);

    runRegistryMigration(200);

    const classification = readReceiptPayload<LaneMigrationClassification>(
      LANE_REGISTRY_M0_CLASSIFY_RECEIPT,
    );
    expect(classification.placeable).toEqual([]);
    expect(classification.notPlaceable).toEqual([]);
    expect(classification.rejected.map((entry) => [entry.edgeId, entry.reason])).toEqual([
      [edgeId, "no-canonical-tag"],
    ]);

    expect(getEdgeById(edgeId)).toEqual({ relation: "extends", tags: [] });
    // The derived lane is gone from the checker's own source too — leaving the
    // index row is what kept an undeclarable lane alive before this ticket.
    expect(tagIndexRowCount(edgeId)).toBe(0);
    expect(listLanesForSegment(db, segmentId)).toEqual([]);

    const receipt = readReceiptPayload<LaneMigrationDisposalReceipt>(
      LANE_REGISTRY_M4_DISPOSAL_RECEIPT,
    );
    expect(receipt.downgraded).toEqual([
      {
        edgeId,
        citingTurnId: b,
        citingAddress: `S${sessionId}/T2`,
        citedTurnId: a,
        citedAddress: `S${sessionId}/T1`,
        relation: "extends",
        tags: ["two words"],
        rawTags: '["two words"]',
        cause: "no-canonical-tag",
        disposition: "downgraded",
      },
    ]);
  });

  test("ticket 13: a fully rejected edge MERGES into a pre-existing untagged row for the same (pair, relation), carrying its own cause", () => {
    resetLaneMigrationReceipts();
    const segmentId = createSegment(db, { title: "owner", tags: [], nowEpoch: 100 }).id;
    const a = seedTurn(1, []);
    const b = seedTurn(2, []);
    addMember(segmentId, a);
    addMember(segmentId, b);
    // The disposal of a rejected edge takes the SAME two dispositions as a
    // homeless-endpoint one — this is the merge half, where clearing the tags
    // in place would collide with the (pair, relation, tags) UNIQUE key. The
    // untagged row itself is invisible to M0 (`json_array_length` is 0), so it
    // is never a disposal target of its own.
    const untaggedEdgeId = writeEdge(b, a, "consume", []);
    const edgeId = writeEdge(b, a, "consume", ["two words"]);

    runRegistryMigration(200);

    expect(getEdgeById(edgeId)).toBeNull();
    expect(getEdgeById(untaggedEdgeId)).toEqual({ relation: "consume", tags: [] });
    const receipt = readReceiptPayload<LaneMigrationDisposalReceipt>(
      LANE_REGISTRY_M4_DISPOSAL_RECEIPT,
    );
    expect(receipt.downgraded).toEqual([
      {
        edgeId,
        citingTurnId: b,
        citingAddress: `S${sessionId}/T2`,
        citedTurnId: a,
        citedAddress: `S${sessionId}/T1`,
        relation: "consume",
        tags: ["two words"],
        rawTags: '["two words"]',
        cause: "no-canonical-tag",
        disposition: "merged",
        mergedIntoEdgeId: untaggedEdgeId,
      },
    ]);
  });

  test("ticket 13: a PARTIAL loss keeps its surviving tags and is NEVER disposed of — the receipt names it as a different shape", () => {
    resetLaneMigrationReceipts();
    const segmentId = createSegment(db, { title: "owner", tags: [], nowEpoch: 100 }).id;
    const a = seedTurn(1, []);
    const b = seedTurn(2, []);
    addMember(segmentId, a);
    addMember(segmentId, b);
    // "keeper" is already canonical; "two words" can never be. The edge is in
    // `rejected` AND in `placeable` at the same time — the exact shape M4 must
    // keep its hands off.
    const edgeId = writeEdge(b, a, "extends", ["keeper", "two words"]);
    rebuildLegacyTagIndex(db);

    runRegistryMigration(200);

    const classification = readReceiptPayload<LaneMigrationClassification>(
      LANE_REGISTRY_M0_CLASSIFY_RECEIPT,
    );
    expect(classification.placeable.map((entry) => entry.tags)).toEqual([["keeper"]]);
    expect(
      classification.rejected.map((entry) => [entry.edgeId, entry.reason, entry.droppedTags]),
    ).toEqual([[edgeId, "partial-canonical-loss", ["two words"]]]);

    // The column comes out byte-identical, survivor included. Disposing of this
    // rejected entry would have destroyed "keeper" — a legal tag, on a lane M2
    // has just seeded, on an edge that is otherwise entirely fine.
    expect(getEdgeById(edgeId)).toEqual({ relation: "extends", tags: ["keeper", "two words"] });
    expect(tagIndexRowCount(edgeId)).toBe(2);
    expect(getLane(db, segmentId, "keeper")).not.toBeNull();

    const receipt = readReceiptPayload<LaneMigrationDisposalReceipt>(
      LANE_REGISTRY_M4_DISPOSAL_RECEIPT,
    );
    expect(receipt.downgraded).toEqual([]);
  });

  test("ticket 13: a partial loss on a HOMELESS-endpoint edge is disposed exactly once, under the illegality that actually condemned it", () => {
    resetLaneMigrationReceipts();
    const segmentId = createSegment(db, { title: "owner", tags: [], nowEpoch: 100 }).id;
    const owned = seedTurn(1, []);
    const homeless = seedTurn(2, []);
    addMember(segmentId, owned);
    const edgeId = writeEdge(homeless, owned, "extends", ["keeper", "two words"]);

    runRegistryMigration(200);

    const classification = readReceiptPayload<LaneMigrationClassification>(
      LANE_REGISTRY_M0_CLASSIFY_RECEIPT,
    );
    expect(classification.notPlaceable.map((entry) => entry.edgeId)).toEqual([edgeId]);
    expect(classification.rejected.map((entry) => entry.reason)).toEqual([
      "partial-canonical-loss",
    ]);

    const receipt = readReceiptPayload<LaneMigrationDisposalReceipt>(
      LANE_REGISTRY_M4_DISPOSAL_RECEIPT,
    );
    // ONE entry, not two. The same edge id reaching M4 from both buckets would
    // not merely double the receipt: the second pass would find the first
    // pass's own now-untagged row as the "pre-existing untagged row" to merge
    // into, and DELETE the row it had just repaired.
    expect(receipt.downgraded).toHaveLength(1);
    expect(receipt.downgraded[0]!.cause).toBe("homeless-endpoint");
    expect(receipt.downgraded[0]!.disposition).toBe("downgraded");
    expect(getEdgeById(edgeId)).toEqual({ relation: "extends", tags: [] });
  });

  test("ticket 13: a tags column that is not a readable JSON array is disposed of too, with the raw column carried verbatim", () => {
    resetLaneMigrationReceipts();
    const segmentId = createSegment(db, { title: "owner", tags: [], nowEpoch: 100 }).id;
    const a = seedTurn(1, []);
    const b = seedTurn(2, []);
    const c = seedTurn(3, []);
    addMember(segmentId, a);
    addMember(segmentId, b);
    addMember(segmentId, c);
    // Two ways to be unreadable AS AN ARRAY: not JSON at all, and JSON that is
    // not an array. Neither can be read by any lane surface, so both are
    // disposed of on the same grounds and under the same name.
    const brokenJson = writeEdgeWithRawTags(b, a, "extends", '["unterminated');
    const notAnArray = writeEdgeWithRawTags(c, a, "extends", '{"lane":"x"}');

    runRegistryMigration(200);

    const classification = readReceiptPayload<LaneMigrationClassification>(
      LANE_REGISTRY_M0_CLASSIFY_RECEIPT,
    );
    expect(
      classification.rejected.map((entry) => [entry.edgeId, entry.reason, entry.rawTags]),
    ).toEqual([
      [brokenJson, "malformed-tags-column", '["unterminated'],
      [notAnArray, "malformed-tags-column", '{"lane":"x"}'],
    ]);

    // Asserted on the RAW column: before the downgrade, `getEdgeById` cannot
    // even parse these rows.
    expect(getEdgeRawTags(brokenJson)).toBe("[]");
    expect(getEdgeRawTags(notAnArray)).toBe("[]");
    expect(listLanesForSegment(db, segmentId)).toEqual([]);

    const receipt = readReceiptPayload<LaneMigrationDisposalReceipt>(
      LANE_REGISTRY_M4_DISPOSAL_RECEIPT,
    );
    // `tags` is necessarily `[]` for these — `rawTags` is the ONLY record of
    // what the column held, which is why the downgrade has to carry it.
    expect(receipt.downgraded).toEqual([
      {
        edgeId: brokenJson,
        citingTurnId: b,
        citingAddress: `S${sessionId}/T2`,
        citedTurnId: a,
        citedAddress: `S${sessionId}/T1`,
        relation: "extends",
        tags: [],
        rawTags: '["unterminated',
        cause: "malformed-tags-column",
        disposition: "downgraded",
      },
      {
        edgeId: notAnArray,
        citingTurnId: c,
        citingAddress: `S${sessionId}/T3`,
        citedTurnId: a,
        citedAddress: `S${sessionId}/T1`,
        relation: "extends",
        tags: [],
        rawTags: '{"lane":"x"}',
        cause: "malformed-tags-column",
        disposition: "downgraded",
      },
    ]);
  });

  test("ticket 13: a rejected edge added AFTER the first run is left alone — the second run disposes of nothing further", () => {
    resetLaneMigrationReceipts();
    const segmentId = createSegment(db, { title: "owner", tags: [], nowEpoch: 100 }).id;
    const a = seedTurn(1, []);
    const b = seedTurn(2, []);
    addMember(segmentId, a);
    addMember(segmentId, b);
    const first = writeEdge(b, a, "extends", ["two words"]);

    runRegistryMigration(200);
    const afterFirst = readReceiptPayload<LaneMigrationDisposalReceipt>(
      LANE_REGISTRY_M4_DISPOSAL_RECEIPT,
    );
    expect(afterFirst.downgraded.map((entry) => entry.edgeId)).toEqual([first]);

    const c = seedTurn(3, []);
    addMember(segmentId, c);
    const late = writeEdge(c, a, "extends", ["three word tag"]);

    runRegistryMigration(300);
    runRegistryMigration(300);

    expect(
      readReceiptPayload<LaneMigrationDisposalReceipt>(LANE_REGISTRY_M4_DISPOSAL_RECEIPT),
    ).toEqual(afterFirst);
    expect(getEdgeById(late)).toEqual({ relation: "extends", tags: ["three word tag"] });
    expect(getEdgeById(first)).toEqual({ relation: "extends", tags: [] });
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
    // A pre-existing untagged row for (homeless, owned, extends): the tagged
    // sibling below must MERGE into it (deleted, cascading the tag index)
    // rather than downgrade in place and collide with the UNIQUE key.
    writeEdge(homeless, owned, "extends", []);
    // One of each remaining disposition: a merge collision (row deleted, tag
    // index cleared via ON DELETE CASCADE), a plain downgrade (tags cleared
    // in place, tag index cleared by hand), and a legal edge left completely
    // alone.
    writeEdge(homeless, owned, "extends", ["gone"]);
    writeEdge(homeless, owned, "consume", ["downgraded-lane"]);
    writeEdge(other, owned, "extends", ["kept"]);
    // The fixture's raw INSERTs bypass the writer that maintains the index, so
    // put the database in the state a REAL one is in before asking M4 to keep
    // it that way. Without this the assertions below pass vacuously over an
    // empty index — which is exactly how an index-maintenance bug hides.
    rebuildLegacyTagIndex(db);

    runRegistryMigration(200);

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
    // cannot pass the two loops above: the pre-existing untagged `extends` row
    // survives the merge, the `consume` row survives downgraded, and the
    // `extends`/`["kept"]` row is untouched.
    expect(tagsByEdge.size).toBe(3);
    expect([...tagsByEdge.values()].map((tags) => tags.join(",")).sort()).toEqual([
      "",
      "",
      "kept",
    ]);
  });

  test("M3 and M4 are both no-ops on a second run", () => {
    resetLaneMigrationReceipts();
    createSegmentWithId(60, ["claude-mnemo"]);
    const owned = seedTurn(1, []);
    const homeless = seedTurn(2);
    addMember(60, owned);
    writeEdge(homeless, owned, "extends", ["orphan-lane"]);

    runRegistryMigration(200);
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

    runRegistryMigration(300);
    runRegistryMigration(300);

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

    // extends edge, homeless endpoint, multi-tag — downgraded (not deleted:
    // repair [S15069/T1566]) with both tags recorded.
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

    runRegistryMigration(200);

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

    // M4: the extends edge is DOWNGRADED to untagged (no longer deleted —
    // extends/narrows lost their special-cased deletion), both tags and both
    // addresses recorded; the cross-segment placeable edge is untouched.
    const disposalReceipt = readReceiptPayload<LaneMigrationDisposalReceipt>(
      LANE_REGISTRY_M4_DISPOSAL_RECEIPT,
    );
    expect(disposalReceipt.downgraded).toEqual([
      {
        edgeId: extendsEdgeId,
        citingTurnId: homeless,
        citingAddress: `S${sessionId}/T5`,
        citedTurnId: owned,
        citedAddress: `S${sessionId}/T6`,
        relation: "extends",
        tags: ["orphan-a", "orphan-b"],
        rawTags: '["orphan-a","orphan-b"]',
        cause: "homeless-endpoint",
        disposition: "downgraded",
      },
    ]);
    expect(getEdgeById(extendsEdgeId)).toEqual({ relation: "extends", tags: [] });
    expect(getEdgeById(crossEdgeId)).toEqual({ relation: "override", tags: ["shared-lane"] });
  });
});
