import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { insertLane } from "../../src/db/lanes";
import {
  MAIN_AGENT_EDGES_CUTOVER_EDGE_ARCHIVE,
  MAIN_AGENT_EDGES_CUTOVER_RECEIPT,
  MAIN_AGENT_EDGES_CUTOVER_WRITER,
  MAIN_AGENT_EDGES_TURN_TAGS_RECEIPT,
  readMainAgentEdgesCutoverState,
  type MainAgentEdgesCutoverReceipt,
  type TurnTagsNormalisationReceipt,
} from "../../src/db/main-agent-edges-cutover";
import {
  getOutgoingEdges,
  memoryEdgesPredatesCutover,
  selectLogicalEdgeRow,
  writeMemoryEdges,
  type MemoryEdge,
} from "../../src/db/memory-edges";
import { claimNextNoteSettlementJob } from "../../src/db/note-settlement";
import { ensureNoteSettlementSnapshotTables } from "../../src/db/note-settlement-snapshots";
import {
  initializeSchema,
  normaliseTurnTagsInvariant,
  planMainAgentEdgesCutover,
  runMainAgentEdgesCutover,
} from "../../src/db/schema";
import { addSegmentMembers, createSegment } from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { getFieldStamp } from "../../src/db/write-gate";
import {
  downgradeToPreCutoverShape,
  seedPreCutoverEdge,
} from "../support/pre-cutover-edge-shape";
import { wordEdgeClass } from "../support/edge-row-fixtures";

/**
 * MAIN-AGENT-EDGES TICKET 01 — THE CUTOVER (spec D9, RULED T2419 + T2421).
 *
 * One receipt-guarded one-shot, one write transaction: the durable claim
 * fence -> the receipts -> transforms 2–4 and 6 -> foreign-key check ->
 * side-index verification -> the completion marker LAST. Transform 1 (the
 * tags values) runs BEFORE all of it and outside the fence, in
 * `normaliseTurnTagsInvariant` (ticket 12); transform 5 does not exist —
 * an ambiguous side is KEPT, not deleted (ruled S15069/T2466). Every fixture
 * here is built on
 * `downgradeToPreCutoverShape`: `initializeSchema` now leaves a database in
 * the FINAL shape, so a test that wants the legacy stock the cutover exists to
 * fold, clear and delete has to put the old shape back and seed it by hand.
 *
 * The numbers every assertion reads come off the receipt
 * (`migration_receipts`, `main-agent-edges-cutover`) — the same numbers the
 * clone report states — and off the archive, which holds every old row with
 * the disposition the cutover gave it.
 */
describe("main-agent-edges cutover (spec D9)", () => {
  const NOW = 1_800_000_000;
  const NOW_MS = NOW * 1000;

  let db: Database;
  let sessionId: number;
  let segmentId: number;
  let nextPrompt = 1;

  const addTurn = (tags: string[] | null): number =>
    db
      .query<{ id: number }, [number, number, number, string | null]>(
        `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch, type, tags)
         VALUES (?, ?, 'extracted', ?, '[]', ?)
         RETURNING id`,
      )
      .get(sessionId, nextPrompt, 100 + nextPrompt++, tags === null ? null : JSON.stringify(tags))!.id;

  const setRawTags = (turnId: number, raw: string | null) =>
    db.query<unknown, [string | null, number]>("UPDATE turns SET tags = ? WHERE id = ?").run(raw, turnId);

  const receipt = (): MainAgentEdgesCutoverReceipt =>
    JSON.parse(
      db
        .query<{ payload: string }, [string]>(
          "SELECT payload FROM migration_receipts WHERE name = ?",
        )
        .get(MAIN_AGENT_EDGES_CUTOVER_RECEIPT)!.payload,
    ) as MainAgentEdgesCutoverReceipt;

  const edgeRows = () =>
    db
      .query<
        {
          id: number;
          citingId: number;
          citedId: number;
          relationClass: string;
          relationCoverage: string;
          tailTag: string;
          headTag: string;
          provenance: string;
          createdAtEpoch: number;
        },
        []
      >(
        `SELECT id, citing_id AS citingId, cited_id AS citedId,
                relation_class AS relationClass, relation_coverage AS relationCoverage,
                tail_tag AS tailTag, head_tag AS headTag, provenance,
                created_at_epoch AS createdAtEpoch
           FROM memory_edges ORDER BY id`,
      )
      .all();

  const dispositionOf = (edgeId: number): string | undefined =>
    db
      .query<{ disposition: string }, [number]>(
        `SELECT disposition FROM ${MAIN_AGENT_EDGES_CUTOVER_EDGE_ARCHIVE} WHERE id = ?`,
      )
      .get(edgeId)?.disposition;

  /**
   * The migration ORDER `initializeSchema` runs, made explicit: the tags
   * normalisation first (unfenced, its own receipt), the one-shot after.
   * Calling the one-shot alone would leave a malformed value for the `turns`
   * rebuild to choke on — which is the whole point of the order.
   */
  const cutover = () => {
    normaliseTurnTagsInvariant(db, NOW);
    return runMainAgentEdgesCutover(db, NOW, NOW_MS);
  };

  const tagsReceipt = (): TurnTagsNormalisationReceipt =>
    JSON.parse(
      db
        .query<{ payload: string }, [string]>(
          "SELECT payload FROM migration_receipts WHERE name = ?",
        )
        .get(MAIN_AGENT_EDGES_TURN_TAGS_RECEIPT)!.payload,
    ) as TurnTagsNormalisationReceipt;

  let nextWindow = 1;
  const addJob = (status: string, stage: string, claimedAtEpoch: number | null, attempts = 0) =>
    db
      .query<{ id: number }, [number, number, number, string, string, number | null, number, number, number]>(
        `INSERT INTO note_settlement_jobs
           (session_id, window_start, window_end, trigger_type, status, stage, claimed_at_epoch,
            attempts, retry_at_epoch, created_at_epoch, updated_at_epoch)
         VALUES (?, ?, ?, 'consecutive', ?, ?, ?, ?, 0, ?, ?)
         RETURNING id`,
      )
      .get(sessionId, nextWindow, nextWindow++ + 1, status, stage, claimedAtEpoch, attempts, NOW, NOW)!.id;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    // `stage` and friends are added lazily by the claim path; the fixture needs them now.
    claimNextNoteSettlementJob(db, 1, NOW, NOW_MS);
    ensureNoteSettlementSnapshotTables(db);
    nextWindow = 1;
    sessionId = upsertSession(db, {
      contentSessionId: "cutover",
      project: "cutover",
      title: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;
    segmentId = createSegment(db, { title: "Task", tags: ["the-task"], nowEpoch: 10 }).id;
    insertLane(db, segmentId, "alpha", 10);
    insertLane(db, segmentId, "beta", 10);
    nextPrompt = 1;
    downgradeToPreCutoverShape(db);
    expect(memoryEdgesPredatesCutover(db)).toBe(true);
  });
  afterEach(() => db.close());

  // ------------------------------------------------------------ the shape

  test("a fresh database is born in the FINAL shape: no word column, pair UNIQUE, tags NOT NULL with the trigger, marker complete", () => {
    const fresh = createDatabase(":memory:");
    initializeSchema(fresh);
    expect(memoryEdgesPredatesCutover(fresh)).toBe(false);
    expect(readMainAgentEdgesCutoverState(fresh)?.status).toBe("complete");
    const tags = fresh
      .query<{ notnull: number; dflt_value: string }, []>(
        "SELECT \"notnull\", dflt_value FROM pragma_table_info('turns') WHERE name = 'tags'",
      )
      .get()!;
    expect(tags.notnull).toBe(1);
    expect(tags.dflt_value).toBe("'[]'");
    expect(
      fresh
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'turns_tags_string_array_%' ORDER BY name",
        )
        .all()
        .map((row) => row.name),
    ).toEqual(["turns_tags_string_array_insert", "turns_tags_string_array_update"]);
    // Idempotent: a second open neither re-runs nor errors on the legacy chain.
    initializeSchema(fresh);
    expect(
      fresh
        .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM migration_receipts WHERE name = ?")
        .get(MAIN_AGENT_EDGES_CUTOVER_RECEIPT)!.n,
    ).toBe(1);
    fresh.close();
  });

  test("the REBUILT table refuses a second row on a pair, a classless row, a non-turn end and a malformed tags value", () => {
    const a = addTurn(["the-task"]);
    const b = addTurn(["the-task"]);
    seedPreCutoverEdge(db, { citingId: a, citedId: b, relation: "extends", relationClass: "use" });
    expect(cutover().ran).toBe("cut-over");

    const insert = (citing: number, cited: number, relationClass: string, kind = "turn") =>
      db
        .query<unknown, [string, number, number, string]>(
          `INSERT INTO memory_edges
             (citing_kind, citing_id, cited_kind, cited_id, provenance, relation_class, created_at_epoch)
           VALUES (?, ?, 'turn', ?, 'asserted', ?, 1)`,
        )
        .run(kind, citing, cited, relationClass);
    expect(() => insert(a, b, "use")).toThrow(/UNIQUE constraint failed/);
    expect(() => insert(b, a, "")).toThrow(/CHECK constraint failed/);
    expect(() => insert(b, a, "use", "segment")).toThrow(/CHECK constraint failed/);
    expect(() => db.query("UPDATE turns SET tags = ? WHERE id = ?").run("[1]", a)).toThrow(
      /non-string member/,
    );
    expect(() => db.query("UPDATE turns SET tags = ? WHERE id = ?").run("{}", a)).toThrow(
      /not an array/,
    );
    expect(() => db.query("UPDATE turns SET tags = NULL WHERE id = ?").run(a)).toThrow();
    // An omitted tags column takes the default and passes.
    expect(() =>
      db
        .query<unknown, [number]>(
          "INSERT INTO turns (session_id, prompt_number, status, created_at_epoch) VALUES (?, 99, 'active', 1)",
        )
        .run(sessionId),
    ).not.toThrow();
  });

  // ------------------------------------------------------------ the fence

  test("FENCE: a live settlement claim defers the cutover, the claim path refuses, and the next open runs it once the claim drains", () => {
    const a = addTurn(["the-task"]);
    const b = addTurn(["the-task"]);
    const edgeId = seedPreCutoverEdge(db, { citingId: a, citedId: b, relation: "extends", relationClass: "use" });
    const jobId = addJob("claimed", "topics", NOW - 60);

    expect(cutover()).toEqual({ ran: "deferred", claimedJobs: 1 });
    expect(memoryEdgesPredatesCutover(db)).toBe(true);
    expect(readMainAgentEdgesCutoverState(db)).toBeNull();
    expect(
      db.query<{ relation: string }, [number]>("SELECT relation FROM memory_edges WHERE id = ?").get(edgeId),
    ).toEqual({ relation: "extends" });
    // The new worker claims nothing while deferred — this is what drains the set.
    addJob("pending", "topics", null);
    expect(claimNextNoteSettlementJob(db, sessionId, NOW, NOW_MS)).toBeNull();

    db.query<unknown, [number]>(
      "UPDATE note_settlement_jobs SET status = 'done', claimed_at_epoch = NULL WHERE id = ?",
    ).run(jobId);
    expect(cutover().ran).toBe("cut-over");
    expect(memoryEdgesPredatesCutover(db)).toBe(false);
    expect(claimNextNoteSettlementJob(db, sessionId, NOW, NOW_MS)).not.toBeNull();
  });

  test("FENCE (R10-8): an EXPIRED claim is reaped with a generation bump before the test, so a dead lease never blocks; at the cap it is abandoned", () => {
    const a = addTurn(["the-task"]);
    const b = addTurn(["the-task"]);
    seedPreCutoverEdge(db, { citingId: a, citedId: b, relation: "extends", relationClass: "use" });
    const expired = addJob("claimed", "topics", NOW - 3600, 0);
    const expiredAtCap = addJob("claimed", "topics", NOW - 3600, 2);

    const outcome = cutover();
    expect(outcome.ran).toBe("cut-over");
    expect(receipt().claimsReaped).toEqual({ abandoned: 1, returnedToPending: 1 });
    const jobs = db
      .query<{ id: number; status: string; gen: number }, []>(
        "SELECT id, status, claim_generation AS gen FROM note_settlement_jobs WHERE session_id = " + sessionId + " ORDER BY id",
      )
      .all();
    expect(jobs).toEqual([
      { id: expired, status: "pending", gen: 1 },
      { id: expiredAtCap, status: "abandoned", gen: 1 },
    ]);
  });

  test("FENCE: a pending job that kept stage='edges' is reset to stage 1 (generation bumped, scratch cleared) before the transforms", () => {
    const a = addTurn(["the-task"]);
    const b = addTurn(["the-task"]);
    seedPreCutoverEdge(db, { citingId: a, citedId: b, relation: "extends", relationClass: "use" });
    const jobId = addJob("pending", "edges", null);
    db.query<unknown, [number, number]>(
      "INSERT INTO note_settlement_worklist (job_id, ordinal, segment_id, lane_tag) VALUES (?, 0, ?, 'alpha')",
    ).run(jobId, segmentId);
    const untouched = addJob("done", "edges", null);

    expect(cutover().ran).toBe("cut-over");
    expect(receipt().edgesStageJobsReset).toBe(1);
    expect(
      db
        .query<{ stage: string; status: string; gen: number }, [number]>(
          "SELECT stage, status, claim_generation AS gen FROM note_settlement_jobs WHERE id = ?",
        )
        .get(jobId),
    ).toEqual({ stage: "topics", status: "pending", gen: 1 });
    expect(
      db.query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM note_settlement_worklist WHERE job_id = ?").get(jobId)!.n,
    ).toBe(0);
    expect(
      db.query<{ stage: string }, [number]>("SELECT stage FROM note_settlement_jobs WHERE id = ?").get(untouched),
    ).toEqual({ stage: "edges" });
  });

  // ------------------------------------------------------------ transform 1

  test("TRANSFORM 1 (BEFORE the one-shot, unfenced): NULL -> [], a non-array -> [], non-string members dropped; each counted, each turn stamped, old bytes archived", () => {
    const nullTurn = addTurn(null);
    const objectTurn = addTurn(["the-task"]);
    setRawTags(objectTurn, '{"a":1}');
    const junkTurn = addTurn(["the-task"]);
    setRawTags(junkTurn, "not json");
    const mixedTurn = addTurn(["the-task"]);
    setRawTags(mixedTurn, '["the-task", 7, "alpha"]');
    const cleanTurn = addTurn(["the-task"]);

    expect(cutover().ran).toBe("cut-over");
    expect(tagsReceipt()).toEqual({
      nullToEmpty: 1,
      nonArrayToEmpty: 2,
      nonStringMembersDropped: 1,
      turnsChanged: 4,
    });
    const tagsOf = (id: number) =>
      db.query<{ tags: string }, [number]>("SELECT tags FROM turns WHERE id = ?").get(id)!.tags;
    expect(tagsOf(nullTurn)).toBe("[]");
    expect(tagsOf(objectTurn)).toBe("[]");
    expect(tagsOf(junkTurn)).toBe("[]");
    expect(tagsOf(mixedTurn)).toBe('["the-task","alpha"]');
    expect(tagsOf(cleanTurn)).toBe('["the-task"]');
    for (const id of [nullTurn, objectTurn, junkTurn, mixedTurn]) {
      expect(getFieldStamp(db, "turn", id, "tags")?.writer).toBe(MAIN_AGENT_EDGES_CUTOVER_WRITER);
    }
    expect(getFieldStamp(db, "turn", cleanTurn, "tags")).toBeNull();
    expect(
      db
        .query<{ turnId: number; tags: string | null }, []>(
          "SELECT turn_id AS turnId, tags FROM main_agent_edges_cutover_turn_tags_archive ORDER BY turn_id",
        )
        .all(),
    ).toEqual([
      { turnId: nullTurn, tags: null },
      { turnId: objectTurn, tags: '{"a":1}' },
      { turnId: junkTurn, tags: "not json" },
      { turnId: mixedTurn, tags: '["the-task", 7, "alpha"]' },
    ]);
  });

  // ------------------------------------------------------------ transform 2

  test("TRANSFORM 2 (fold): the survivor is selectLogicalEdgeRow's row — the SAME function the write path uses — with D9's coverage and one-distinct-valid-declaration rules on top", () => {
    const citing = addTurn(["the-task", "alpha", "beta"]);
    const cited = addTurn(["the-task", "alpha", "beta"]);
    addSegmentMembers(db, segmentId, [citing, cited], 10);
    const useRow = seedPreCutoverEdge(db, { citingId: citing, citedId: cited, relation: "extends", relationClass: "use", tailTag: "alpha", headTag: "beta", createdAtEpoch: 100, provenance: "judged" });
    const partialRow = seedPreCutoverEdge(db, { citingId: citing, citedId: cited, relation: "narrows", relationClass: "correct", relationCoverage: "partial", tailTag: "alpha", headTag: "beta", createdAtEpoch: 200 });
    const fullRow = seedPreCutoverEdge(db, { citingId: citing, citedId: cited, relation: "override", relationClass: "correct", relationCoverage: "full", tailTag: "alpha", headTag: "", createdAtEpoch: 300 });

    // The pin (peer S15069/T2438): the fold's survivor IS the write path's choice.
    const asMemoryEdges: MemoryEdge[] = db
      .query<
        { id: number; tailTag: string; headTag: string; relationClass: string; relationCoverage: string; provenance: string; createdAtEpoch: number },
        []
      >(
        `SELECT id, tail_tag AS tailTag, head_tag AS headTag, relation_class AS relationClass,
                relation_coverage AS relationCoverage, provenance, created_at_epoch AS createdAtEpoch
           FROM memory_edges ORDER BY id`,
      )
      .all()
      .map((row) => ({
        id: row.id,
        citing: { kind: "turn", id: citing },
        cited: { kind: "turn", id: cited },
        tailTag: row.tailTag,
        headTag: row.headTag,
        relationClass: row.relationClass as MemoryEdge["relationClass"],
        relationCoverage: row.relationCoverage as MemoryEdge["relationCoverage"],
        provenance: row.provenance as MemoryEdge["provenance"],
        createdAtEpoch: row.createdAtEpoch,
      }));
    expect(selectLogicalEdgeRow(asMemoryEdges)!.id).toBe(partialRow);

    expect(cutover().ran).toBe("cut-over");
    const r = receipt();
    expect(r.foldedPairs).toBe(1);
    expect(r.foldedRowsDeleted).toBe(2);
    expect(r.foldedPairsByClass).toBe(1);
    expect(r.coveragePromoted).toBe(1);
    expect(edgeRows()).toEqual([
      {
        // The write path's row: most specific class (correct), lowest id
        // among the correct rows — the partial one, not the full one.
        id: partialRow,
        citingId: citing,
        citedId: cited,
        relationClass: "correct",
        // D9: any full -> full, on that row.
        relationCoverage: "full",
        // tail: every row said alpha -> ONE distinct valid declaration, kept
        // (both endpoints are in two lanes, so it is not redundant either).
        tailTag: "alpha",
        // head: beta / beta / '' -> the blank contributes nothing, so one
        // distinct valid declaration -> kept.
        headTag: "beta",
        // The survivor's own provenance and creation time.
        provenance: "asserted",
        createdAtEpoch: 200,
      },
    ]);
    expect(dispositionOf(partialRow)).toBe("rewritten");
    expect(dispositionOf(useRow)).toBe("folded");
    expect(dispositionOf(fullRow)).toBe("folded");
    expect(getFieldStamp(db, "turn", citing, "relations")?.writer).toBe(MAIN_AGENT_EDGES_CUTOVER_WRITER);
  });

  test("TRANSFORM 2 (fold): two DIFFERENT valid declarations on one side are an ambiguity, not a choice — the side folds to '' and the edge is KEPT with it blank", () => {
    const citing = addTurn(["the-task", "alpha", "beta"]);
    const cited = addTurn(["the-task", "alpha"]);
    addSegmentMembers(db, segmentId, [citing, cited], 10);
    const first = seedPreCutoverEdge(db, { citingId: citing, citedId: cited, relation: "extends", relationClass: "use", tailTag: "alpha", headTag: "" });
    const second = seedPreCutoverEdge(db, { citingId: citing, citedId: cited, relation: "consume", relationClass: "use", tailTag: "beta", headTag: "" });

    expect(cutover().ran).toBe("cut-over");
    // Ruled S15069/T2466: a blank side on a multi-lane endpoint already MEANS
    // ambiguous to every reader, so the row survives with the side blank.
    // Nothing is deleted for ambiguity and there is no count for it.
    expect(edgeRows().map((row) => [row.id, row.tailTag, row.headTag])).toEqual([
      [first, "", ""],
    ]);
    expect(dispositionOf(first)).toBe("rewritten");
    expect(dispositionOf(second)).toBe("folded");
    expect(receipt().rowsAfter).toBe(1);
  });

  test("TRANSFORM 2 (fold): identical duplicate declarations are ONE declaration; the survivor keeps its id, provenance and creation time", () => {
    const citing = addTurn(["the-task", "alpha", "beta"]);
    const cited = addTurn(["the-task", "alpha", "beta"]);
    addSegmentMembers(db, segmentId, [citing, cited], 10);
    const first = seedPreCutoverEdge(db, { citingId: citing, citedId: cited, relation: "extends", relationClass: "use", tailTag: "alpha", headTag: "beta", createdAtEpoch: 100, provenance: "judged" });
    const second = seedPreCutoverEdge(db, { citingId: citing, citedId: cited, relation: "consume", relationClass: "use", tailTag: "alpha", headTag: "beta", createdAtEpoch: 200 });

    expect(cutover().ran).toBe("cut-over");
    expect(receipt().foldedPairsBySidesOnly).toBe(1);
    expect(receipt().foldedPairsByClass).toBe(0);
    expect(edgeRows()).toEqual([
      {
        id: first,
        citingId: citing,
        citedId: cited,
        relationClass: "use",
        relationCoverage: "",
        tailTag: "alpha",
        headTag: "beta",
        provenance: "judged",
        createdAtEpoch: 100,
      },
    ]);
    expect(dispositionOf(second)).toBe("folded");
    // The plan names which predicate produced the fold count: same class,
    // same coverage, only the (identical) sides -> "by sides only".
    expect(receipt().foldedPairs).toBe(1);
  });

  // ------------------------------------------------------------ transforms 3–4

  test("TRANSFORMS 3/4: a redundant declaration is cleared, an invalid one is cleared, an unattributable side leaves the edge STANDING with the side blank, untouched edges are kept and NOT stamped", () => {
    const uniqueA = addTurn(["the-task", "alpha"]);
    const uniqueB = addTurn(["the-task", "alpha"]);
    const twoLaned = addTurn(["the-task", "alpha", "beta"]);
    const laneless = addTurn(["the-task"]);
    addSegmentMembers(db, segmentId, [uniqueA, uniqueB, twoLaned, laneless], 10);

    // redundant: both endpoints uniquely laned, both sides declared.
    const redundant = seedPreCutoverEdge(db, { citingId: uniqueA, citedId: uniqueB, relation: "extends", relationClass: "use", tailTag: "alpha", headTag: "alpha" });
    // invalid: a declaration the endpoint does not carry.
    const invalid = seedPreCutoverEdge(db, { citingId: uniqueB, citedId: uniqueA, relation: "verifies", relationClass: "verify", tailTag: "beta", headTag: "" });
    // ambiguous: blank tail on a two-lane endpoint. KEPT (S15069/T2466).
    const ambiguous = seedPreCutoverEdge(db, { citingId: twoLaned, citedId: uniqueA, relation: "extends", relationClass: "use" });
    // fine: a declaration on the two-lane endpoint, blank on the unique one.
    const declared = seedPreCutoverEdge(db, { citingId: uniqueA, citedId: twoLaned, relation: "override", relationClass: "correct", relationCoverage: "full", tailTag: "", headTag: "beta" });
    // untouched: no declarations, lane-less head.
    const kept = seedPreCutoverEdge(db, { citingId: uniqueB, citedId: laneless, relation: "extends", relationClass: "use" });

    expect(cutover().ran).toBe("cut-over");
    const r = receipt();
    expect(r.redundantCleared).toBe(2);
    expect(r.invalidCleared).toBe(1);
    expect(r.rowsBefore).toBe(5);
    // Nothing is deleted for an unattributable side: 5 in, 5 out.
    expect(r.rowsAfter).toBe(5);
    expect(edgeRows().map((row) => [row.id, row.tailTag, row.headTag])).toEqual([
      [redundant, "", ""],
      [invalid, "", ""],
      [ambiguous, "", ""],
      [declared, "", "beta"],
      [kept, "", ""],
    ]);
    expect(dispositionOf(redundant)).toBe("rewritten");
    expect(dispositionOf(invalid)).toBe("rewritten");
    expect(dispositionOf(ambiguous)).toBe("kept");
    expect(dispositionOf(declared)).toBe("kept");
    expect(dispositionOf(kept)).toBe("kept");
    // R10-10: every citer whose row was cleared or deleted is stamped; the
    // untouched citer of `declared`/`kept` (uniqueA writes `declared`, but
    // uniqueA also owns `redundant`) — check the one citer with nothing touched.
    expect(getFieldStamp(db, "turn", uniqueA, "relations")?.writer).toBe(MAIN_AGENT_EDGES_CUTOVER_WRITER);
    // `twoLaned`'s only row was neither folded nor rewritten — its side was
    // already blank and stays blank, so nothing about its relation set moved.
    expect(getFieldStamp(db, "turn", twoLaned, "relations")).toBeNull();
    expect(r.citersStamped).toBe(2);
    // The side index is exactly the surviving declarations.
    expect(
      db.query<{ edgeRowId: number; side: string; tag: string }, []>("SELECT edge_row_id AS edgeRowId, side, tag FROM memory_edge_side_tags").all(),
    ).toEqual([{ edgeRowId: declared, side: "head", tag: "beta" }]);
    expect(r.sideIndexRows).toBe(1);
  });

  test("D1: every wordless row is DELETED into the receipt — text-ref prose references and judged bare pairs alike, whatever the endpoint kinds", () => {
    const a = addTurn(["the-task"]);
    const b = addTurn(["the-task"]);
    const bare = seedPreCutoverEdge(db, { citingId: a, citedId: b, relation: null, provenance: "judged" });
    const prose = seedPreCutoverEdge(db, { citingId: segmentId, citingKind: "segment", citedId: b, relation: null, provenance: "text-ref" });
    const classed = seedPreCutoverEdge(db, { citingId: b, citedId: a, relation: "extends", relationClass: "use" });

    expect(cutover().ran).toBe("cut-over");
    expect(receipt().wordlessDeleted).toBe(2);
    expect(edgeRows().map((row) => row.id)).toEqual([classed]);
    expect(dispositionOf(bare)).toBe("deleted-wordless");
    expect(dispositionOf(prose)).toBe("deleted-wordless");
    // Deleting a wordless row is not a change to any citer's relation set.
    expect(getFieldStamp(db, "turn", a, "relations")).toBeNull();
  });

  test("the cutover refuses a database whose worded rows were never classified (the backfill receipt is a precondition)", () => {
    db.query("DELETE FROM migration_receipts WHERE name = 'relation-vocabulary-v13-relation-class-backfill'").run();
    expect(() => cutover()).toThrow(/backfill/);
    expect(memoryEdgesPredatesCutover(db)).toBe(true);
  });

  // ------------------------------------------------------------ atomicity

  test("ONE TRANSACTION: a refused survivor rolls everything back — old shape, old rows, no marker, no archive", () => {
    const a = addTurn(["the-task"]);
    const b = addTurn(["the-task"]);
    seedPreCutoverEdge(db, { citingId: a, citedId: b, relation: "extends", relationClass: "use" });
    // A class-bearing row whose citing end is a segment: legal under the old
    // CHECK (relation IS NULL), refused by the post-cutover table's
    // `citing_kind = 'turn'` — the transaction must take the whole cutover
    // down with it, marker included.
    seedPreCutoverEdge(db, { citingId: segmentId, citingKind: "segment", citedId: b, relation: null, relationClass: "use", provenance: "judged" });
    const nullTurn = addTurn(null);

    expect(() => cutover()).toThrow(/CHECK constraint failed/);
    expect(memoryEdgesPredatesCutover(db)).toBe(true);
    expect(readMainAgentEdgesCutoverState(db)).toBeNull();
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM memory_edges").get()!.n).toBe(2);
    expect(db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${MAIN_AGENT_EDGES_CUTOVER_EDGE_ARCHIVE}`).get()!.n).toBe(0);
    // The tags normalisation is its OWN transaction and its own step, and it
    // committed before the one-shot ever started (ticket 12) — so it is NOT
    // taken down with the one-shot, and must not be: it is what the fenced
    // deferral window needs even when the one-shot never runs at all.
    expect(db.query<{ tags: string | null }, [number]>("SELECT tags FROM turns WHERE id = ?").get(nullTurn)!.tags).toBe("[]");
    expect(
      db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM migration_receipts WHERE name = ?").get(MAIN_AGENT_EDGES_CUTOVER_RECEIPT)!.n,
    ).toBe(0);
  });

  // ------------------------------------------------------------ the receipt

  test("THE ARCHIVE IS THE RECEIPT: after the one-shot every pre-cutover row is in it byte for byte, with the DDL that held it — there is no rollback tool", () => {
    const citing = addTurn(["the-task", "alpha", "beta"]);
    const cited = addTurn(["the-task", "alpha"]);
    addSegmentMembers(db, segmentId, [citing, cited], 10);
    const nullTurn = addTurn(null);
    const folded = seedPreCutoverEdge(db, { citingId: citing, citedId: cited, relation: "extends", relationClass: "use", tailTag: "alpha", headTag: "alpha", createdAtEpoch: 400, provenance: "judged" });
    const loser = seedPreCutoverEdge(db, { citingId: citing, citedId: cited, relation: "override", relationClass: "correct", relationCoverage: "full", tailTag: "beta", headTag: "alpha", createdAtEpoch: 500 });
    const wordless = seedPreCutoverEdge(db, { citingId: cited, citedId: citing, relation: null, provenance: "judged" });
    const preTags = db
      .query<{ id: number; tags: string | null }, []>("SELECT id, tags FROM turns ORDER BY id")
      .all();
    const preDdl = db
      .query<{ sql: string }, []>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_edges'",
      )
      .get()!.sql;

    expect(cutover().ran).toBe("cut-over");

    // (1) every old row, all columns, with its disposition.
    expect(
      db
        .query<
          { id: number; relation: string | null; tailTag: string; headTag: string; relationClass: string; relationCoverage: string; provenance: string; createdAtEpoch: number; disposition: string },
          []
        >(
          `SELECT id, relation, tail_tag AS tailTag, head_tag AS headTag,
                  relation_class AS relationClass, relation_coverage AS relationCoverage,
                  provenance, created_at_epoch AS createdAtEpoch, disposition
             FROM ${MAIN_AGENT_EDGES_CUTOVER_EDGE_ARCHIVE} ORDER BY id`,
        )
        .all(),
    ).toEqual([
      { id: folded, relation: "extends", tailTag: "alpha", headTag: "alpha", relationClass: "use", relationCoverage: "", provenance: "judged", createdAtEpoch: 400, disposition: "folded" },
      { id: loser, relation: "override", tailTag: "beta", headTag: "alpha", relationClass: "correct", relationCoverage: "full", provenance: "asserted", createdAtEpoch: 500, disposition: "rewritten" },
      { id: wordless, relation: null, tailTag: "", headTag: "", relationClass: "", relationCoverage: "", provenance: "judged", createdAtEpoch: 400, disposition: "deleted-wordless" },
    ]);
    expect(db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${MAIN_AGENT_EDGES_CUTOVER_EDGE_ARCHIVE}`).get()!.n).toBe(3);

    // (2) the old `turns.tags` bytes of every turn the normalisation touched,
    //     NULL kept as NULL.
    expect(
      db
        .query<{ turnId: number; tags: string | null }, []>(
          "SELECT turn_id AS turnId, tags FROM main_agent_edges_cutover_turn_tags_archive ORDER BY turn_id",
        )
        .all(),
    ).toEqual([{ turnId: nullTurn, tags: null }]);
    expect(preTags.find((row) => row.id === nullTurn)!.tags).toBeNull();

    // (3) the DDL that held those rows, verbatim from `sqlite_master`.
    expect(
      db
        .query<{ sql: string }, []>(
          `SELECT sql FROM main_agent_edges_cutover_ddl_archive
            WHERE kind = 'table' AND name = 'memory_edges'`,
        )
        .get()!.sql,
    ).toBe(preDdl);

    // (4) the marker says `complete` and nothing else can be said: the
    //     rollback tool is DELETED (ruled S15069/T2464), so there is no
    //     `rolled_back` state and no `written-since` question to ask. A
    //     recovery is a hand-written one-shot over exactly these three tables.
    expect(readMainAgentEdgesCutoverState(db)).toEqual({
      status: "complete",
      appliedAtEpoch: NOW,
      writeGateSequence: expect.any(Number),
    });
  });

  // ------------------------------------------------------------ the plan, pure

  test("planMainAgentEdgesCutover names the fold population by its predicate: EVERY pair whose rows collapsed, wordless losers included, split (over the class rows) into class-differing and sides-only", () => {
    const facts = new Map([
      [1, { segmentId: 1, lanes: ["alpha", "beta"] }],
      [2, { segmentId: 1, lanes: ["alpha", "beta"] }],
      [3, { segmentId: 1, lanes: ["alpha"] }],
    ]);
    const row = (id: number, citingId: number, citedId: number, relationClass: string, relationCoverage: string, tailTag: string, headTag: string) => ({
      id, citingKind: "turn", citingId, citedKind: "turn", citedId, relation: null, provenance: "asserted",
      tailTag, headTag, relationClass, relationCoverage, createdAtEpoch: 1,
    });
    const plan = planMainAgentEdgesCutover(
      [
        // pair 1>2: two classes -> by class
        row(1, 1, 2, "use", "", "alpha", "alpha"),
        row(2, 1, 2, "verify", "", "alpha", "alpha"),
        // pair 2>1: same class, sides differ -> by sides only
        row(3, 2, 1, "use", "", "alpha", "beta"),
        row(4, 2, 1, "use", "", "alpha", "beta"),
        // pair 1>3: single row, wordless
        row(5, 1, 3, "", "", "", ""),
        // pair 3>1: single row, head blank on a two-lane endpoint -> KEPT
        row(6, 3, 1, "use", "", "", ""),
        // pair 2>3: ONE WORDLESS + ONE CLASS ROW. Two rows in, one out — a
        // pair the fold touched, and the count that used to report 0 for it
        // (ticket 12, P3). It is in neither split: "the rows differ in class"
        // is not a question you can ask of a row that carries none.
        row(7, 2, 3, "", "", "", ""),
        row(8, 2, 3, "use", "", "", ""),
      ],
      facts,
    );
    expect(plan.counts.foldedPairs).toBe(3);
    expect(plan.counts.foldedPairsByClass).toBe(1);
    expect(plan.counts.foldedPairsBySidesOnly).toBe(1);
    expect(plan.counts.redundantCleared).toBe(0);
    expect(plan.counts.invalidCleared).toBe(0);
    // Only the class-bearing losers; row 7 is counted once, as wordless.
    expect(plan.counts.foldedRowsDeleted).toBe(2);
    expect(plan.counts.wordlessDeleted).toBe(2);
    // Nothing is deleted for an unattributable side (S15069/T2466): rows 6 and
    // 8 both survive with their blank sides.
    expect(plan.survivors.map((s) => [s.id, s.relationClass, s.tailTag, s.headTag])).toEqual([
      [2, "verify", "alpha", "alpha"],
      [3, "use", "alpha", "beta"],
      [6, "use", "", ""],
      [8, "use", "", ""],
    ]);
    expect(plan.dispositions.get(7)).toBe("deleted-wordless");
    expect(plan.dispositions.get(8)).toBe("kept");
    expect([...plan.stampedCiters].sort()).toEqual([1, 2]);
  });
});
