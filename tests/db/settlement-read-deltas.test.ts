import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { insertLane } from "../../src/db/lanes";
import { getOutgoingEdges } from "../../src/db/memory-edges";
import {
  claimNextNoteSettlementJob,
  enqueueNoteSettlementWindows,
  resetNoteSettlementJobToStageOne,
  transitionNoteSettlementJobToEdges,
  type NoteSettlementJob,
} from "../../src/db/note-settlement";
import {
  computeSettlementReadDeltas,
  readNoteSettlementDeclarationEndpointSnapshot,
  readNoteSettlementWritableSnapshot,
  settlementWritePermissions,
  writeNoteSettlementTransitionSnapshots,
} from "../../src/db/note-settlement-snapshots";
import { initializeSchema } from "../../src/db/schema";
import { addSegmentMembers, createSegment, writeMembershipTags } from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { claimWriterId } from "../../src/db/write-gate";
import { recallMemory } from "../../src/mcp/recall";
import { createSettlementDirectWriteEngine } from "../../src/worker/note-settlement-direct-write";
import { installSettlementEdgesScope } from "../../src/worker/note-settlement-edges-scope";
import { renderUnifiedFinalizeDataResult } from "../../src/worker/note-settlement-sdk-query";
import {
  buildSettlementWorklistRendering,
  readSettlementFrozenScope,
} from "../../src/worker/note-settlement-shape-numbers";
import {
  settlementTurnWriteInputSchema,
  type SettlementTurnFacadeContext,
} from "../../src/worker/note-settlement-turn-facade";

/**
 * MAIN-AGENT-EDGES TICKET 06 — THE STAGE-2 READ DELTAS (read-once spec D6,
 * rewritten by main-agent-edges spec §Consequences).
 *
 * `finalize` computes, inside the transition transaction and AFTER every
 * stage-1 write:
 *
 *   declarationEndpointIds = endpoints(live outgoing rows whose citer ∈ writableIds)
 *   contextDelta      = (⋃ laneMembers(post-write) ∪ declarationEndpointIds)
 *                       − initialWritableIds                          (one hop)
 *
 * MAIN-AGENT-EDGES TICKET 14 removed the twin. `writableDelta` was
 * `finalWritableIds − initialWritableIds`, the citers the two side-citer
 * closures admitted for RELATIONS ONLY so they could repair a side stage 1 made
 * unattributable; ruling S15069/T2465-T2466 abolished that repair channel, so
 * `finalWritableIds = initialWritableIds` and the difference is empty by
 * construction. The tests that pinned the delta's membership and its
 * relations-only authority are REPLACED below by their opposite: no citer is
 * admitted, and no line is printed for one.
 *
 * The remaining cases are the tests of the first describe; the second pins that
 * the delta is a pure function of PERSISTED rows (a retry prints what the
 * transition printed) and that the two renderers print it from that one
 * snapshot.
 */

const NOW = 1_800_000_000;
const ERA = 1;
const TASK = "delta-task";

describe("the finalize read deltas — set differences against what stage 1 read", () => {
  let db: Database;
  let sessionId: number;
  let segmentId: number;
  let job: NoteSettlementJob;

  const addTurn = (promptNumber: number, tags: string[]): number =>
    db
      .query<{ id: number }, [number, number, number, string]>(
        `INSERT INTO turns (session_id, prompt_number, status, user_prompt, assistant_response,
                            created_at_epoch, type, tags)
         VALUES (?, ?, 'active', 'p', 'r', ?, '["design"]', ?)
         RETURNING id`,
      )
      .get(sessionId, promptNumber, NOW - 100 + promptNumber, JSON.stringify(tags))!.id;

  const addEdge = (citingId: number, citedId: number, headTag = ""): number =>
    db
      .query<{ id: number }, [number, number, string, number]>(
        `INSERT INTO memory_edges
           (citing_kind, citing_id, cited_kind, cited_id, provenance,
            tail_tag, head_tag, relation_class, relation_coverage, created_at_epoch)
         VALUES ('turn', ?, 'turn', ?, 'judged', '', ?, 'use', '', ?)
         RETURNING id`,
      )
      .get(citingId, citedId, headTag, NOW)!.id;

  /** Stage 1's own batch tag write, through the SAME primitive it uses in production. */
  const project = (turnId: number, tags: string[]) =>
    writeMembershipTags(db, {
      operation: "normal",
      writes: [{ turnId, tags }],
      writer: "settlement",
      nowEpoch: NOW,
    });

  const address = (turnId: number): string => {
    const row = db
      .query<{ promptNumber: number }, [number]>(
        "SELECT prompt_number AS promptNumber FROM turns WHERE id = ?",
      )
      .get(turnId)!;
    return `S${sessionId}/T${row.promptNumber}`;
  };

  /**
   * THE FIXTURE, one graph every test reads:
   *
   *   window   = { w1, w2 }        lookback = { lb }        (the INITIAL set)
   *   w2 -> w1 (initial cites initial), w2 -> remote (a cited endpoint stage 1 never read)
   *   w1 -> both (a turn that is BOTH a lane member and a cited endpoint)
   *   member  : stage 1 tags it into #alpha — a lane member ADDED by stage 1
   *   derived : a remote citer of w1; stage 1 puts w1 in a second lane, so
   *             its head side stops deriving — the derived closure admits it
   *   derived -> far (one hop THROUGH a writable-delta citer)
   *   removed : cites w2 with a DECLARED head "gamma"; stage 1's projection
   *             takes gamma off w2 and leaves it in two lanes — the side goes
   *             declared -> ambiguous, and the derived closure admits the citer
   */
  interface Fixture {
    w1: number;
    w2: number;
    lb: number;
    remote: number;
    both: number;
    member: number;
    derived: number;
    far: number;
    removed: number;
  }

  function seedGraph(): Fixture {
    const w1 = addTurn(1, [TASK, "alpha"]);
    const w2 = addTurn(2, [TASK, "alpha", "gamma"]);
    const lb = addTurn(3, [TASK, "alpha"]);
    const remote = addTurn(4, [TASK]);
    const both = addTurn(5, [TASK, "alpha"]);
    const member = addTurn(6, [TASK]);
    const derived = addTurn(7, [TASK, "alpha"]);
    const far = addTurn(8, [TASK]);
    const removed = addTurn(9, [TASK, "alpha"]);
    addSegmentMembers(db, segmentId, [w1, w2, lb, remote, both, member, derived, far, removed], 10);
    addEdge(w2, w1);
    addEdge(w2, remote);
    addEdge(w1, both);
    addEdge(derived, w1);
    addEdge(derived, far);
    addEdge(removed, w2, "gamma");
    return { w1, w2, lb, remote, both, member, derived, far, removed };
  }

  /** Stage 1's writes, then the transition — the production order. */
  function stageOneThenTransition(fixture: Fixture) {
    project(fixture.member, [TASK, "alpha"]);
    project(fixture.w1, [TASK, "alpha", "beta"]);
    project(fixture.w2, [TASK, "alpha", "beta"]);
    return transitionNoteSettlementJobToEdges(db, job.id, job.claimGeneration, NOW, {
      snapshots: {
        window: [fixture.w1, fixture.w2],
        lookback: [fixture.lb],
        closure: [],
        worklist: [{ segmentId, laneTag: "alpha" }],
        eraCutoffEpoch: null,
      },
    });
  }

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "settlement-read-deltas",
      project: "settlement-read-deltas",
      title: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;
    segmentId = createSegment(db, { title: "Task", tags: [TASK], nowEpoch: 10 }).id;
    insertLane(db, segmentId, "alpha", 10);
    insertLane(db, segmentId, "beta", 10);
    insertLane(db, segmentId, "gamma", 10);
    enqueueNoteSettlementWindows(
      db,
      [{ sessionId, windowStart: 1, windowEnd: 2, triggerType: "consecutive" }],
      NOW,
      ERA,
    );
    job = claimNextNoteSettlementJob(db, sessionId, NOW, NOW * 1000)!;
  });
  afterEach(() => db.close());

  test("an initial-set address never appears in a delta, whatever else it is", () => {
    const fixture = seedGraph();
    expect(stageOneThenTransition(fixture)).not.toBeNull();
    const scope = readSettlementFrozenScope(db, job.id)!;

    // w1 is a lane member AND a cited endpoint AND the removed-side edge's
    // cited end; w2 is a lane member and a citer; lb is lookback. All three
    // were read by stage 1, so they are the INITIAL set and nothing else.
    expect(scope.readDeltas.initialWritableIds).toEqual(
      [fixture.w1, fixture.w2, fixture.lb].sort((a, b) => a - b),
    );
    for (const id of [fixture.w1, fixture.w2, fixture.lb]) {
      expect(scope.readDeltas.contextDelta).not.toContain(id);
    }
    // TICKET 14: `writableDelta` is gone, not empty — the shape carries one
    // list, so a reader cannot ask for the retired one at all.
    expect(Object.keys(scope.readDeltas).sort()).toEqual([
      "contextDelta",
      "initialWritableIds",
    ]);
  });

  test("a lane member added by stage 1 and a remote cited endpoint each appear in contextDelta once, and print once", () => {
    const fixture = seedGraph();
    const transitioned = stageOneThenTransition(fixture)!;
    const scope = readSettlementFrozenScope(db, job.id)!;

    const count = (list: readonly number[], id: number): number =>
      list.filter((entry) => entry === id).length;
    // The member stage 1's batch write ADDED to #alpha — never read by stage
    // 1, so it is context.
    expect(count(scope.readDeltas.contextDelta, fixture.member)).toBe(1);
    // The endpoint a window turn's edge points at, outside every lane.
    expect(count(scope.readDeltas.contextDelta, fixture.remote)).toBe(1);
    // A turn that qualifies BOTH ways — lane member and cited endpoint — is
    // one address, not two.
    expect(count(scope.readDeltas.contextDelta, fixture.both)).toBe(1);
    // ONE HOP is measured from the FINAL writable set, which is now exactly the
    // initial one: `derived` is no longer admitted (ticket 14), so `far` — the
    // turn only ITS edge points at — is no longer context either.
    expect(count(scope.readDeltas.contextDelta, fixture.far)).toBe(0);
    expect(new Set(scope.readDeltas.contextDelta).size).toBe(scope.readDeltas.contextDelta.length);

    // Printed once each, on the finalize data result and on the resume
    // prompt's worklist rendering — both read the SAME persisted snapshot.
    const holder = installSettlementEdgesScope(db, job.id, {
      writableTurnIds: new Set(),
      scopeProvenance: undefined,
    });
    const text = renderUnifiedFinalizeDataResult(
      db,
      job.id,
      transitioned.transitionSeq,
      holder.current,
    );
    const lines = text.split("\n");
    const contextHeaderIndex = lines.findIndex((line) => line.startsWith("context delta"));
    expect(lines[contextHeaderIndex]).toContain(`(${scope.readDeltas.contextDelta.length}):`);
    // The addresses are on the FOLLOWING line(s), through the bounded shared
    // renderer (ticket 14, P2-D) rather than joined onto the header.
    for (const id of scope.readDeltas.contextDelta) {
      expect(lines[contextHeaderIndex + 1]).toContain(address(id));
    }
    // TICKET 14: there is no `writable delta` line left to print.
    expect(text).not.toContain("writable delta");
    // Each context address occurs exactly once across the two SET blocks —
    // it is not in the frozen set, and it is not repeated inside its own.
    // (The worklist's per-lane member roster below those lines names `member`
    // and `both` again by design: that roster says which lane a turn is a
    // vertex of, the delta says what to read.)
    const setBlock = lines.slice(1, contextHeaderIndex + 2).join("\n");
    for (const id of [fixture.member, fixture.remote, fixture.both]) {
      expect(setBlock.split(`${address(id)}`).length - 1).toBe(1);
    }
    const rendering = buildSettlementWorklistRendering(db, job.id);
    expect(rendering.contextDelta).toEqual(scope.readDeltas.contextDelta.map(address));
    expect(rendering).not.toHaveProperty("writableDelta");
  });

  test("integrator pin (06): a NON-writable citer's endpoints are not declaration endpoints — the enumeration is over the final writable set only", () => {
    const fixture = seedGraph();
    // A citer nobody's authority reaches (no lane, not in the window, not
    // cited), pointing at a turn nothing else names. If the enumeration
    // walked every citer, `stranger` would appear in contextDelta.
    const outsider = addTurn(10, [TASK]);
    const stranger = addTurn(11, [TASK]);
    addSegmentMembers(db, segmentId, [outsider, stranger], 10);
    addEdge(outsider, stranger);
    stageOneThenTransition(fixture);
    const scope = readSettlementFrozenScope(db, job.id)!;
    expect(scope.readDeltas.contextDelta).not.toContain(stranger);
    expect(scope.readDeltas.contextDelta).not.toContain(outsider);
    // The positive control from the same fixture: a WINDOW citer's endpoint IS
    // there. (`far` is not: ticket 14 stopped admitting the citer that reached
    // it, so it is now on the same footing as `stranger`.)
    expect(scope.readDeltas.contextDelta).toContain(fixture.remote);
    expect(scope.readDeltas.contextDelta).not.toContain(fixture.far);
  });

  test("a contextDelta member refuses a relation write — it is judgment material, not authority", () => {
    const fixture = seedGraph();
    stageOneThenTransition(fixture);
    const scope = readSettlementFrozenScope(db, job.id)!;
    expect(scope.readDeltas.contextDelta).toContain(fixture.remote);

    const context: SettlementTurnFacadeContext = {
      jobId: job.id,
      claimGeneration: job.claimGeneration,
      stage: "edges",
      sessionId,
      reviewableTurnIds: scope.writableTurnIds,
      writableProvenance: scope.writableProvenance,
      contextBuiltAtEpoch: NOW,
    };
    const engine = createSettlementDirectWriteEngine({ db, context, now: () => NOW });
    recallMemory(db, {
      id: address(fixture.remote),
      filter: { fields: ["relations"] },
      readerId: claimWriterId(job.id, job.claimGeneration, "edges"),
    });

    const result = engine.writeNote(
      settlementTurnWriteInputSchema.parse({
        turn: address(fixture.remote),
        use: [address(fixture.w1)],
      }),
    );
    expect(result.content[0]!.text).toContain("outside this dispatch's reviewable window");
    expect(getOutgoingEdges(db, { kind: "turn", id: fixture.remote })).toHaveLength(0);
  });

  /**
   * REPLACED (main-agent-edges ticket 14). This test pinned that a
   * `writableDelta` member — a citer admitted by one of the two side-citer
   * closures — accepted a relation write and refused a note field. Ruling
   * S15069/T2465-T2466 abolished the admission, so what is pinned now is that
   * the citer is NOT admitted at all: its relation write is refused for being
   * outside the window, exactly like any other turn stage 1 never read.
   */
  test("a citer stage 1 left owing a side is NOT writable — no relations-only grant survives", () => {
    const fixture = seedGraph();
    stageOneThenTransition(fixture);
    const scope = readSettlementFrozenScope(db, job.id)!;

    // Both citers the projection left owing a side used to BE the writable
    // delta. Neither is in the writable set now, and no provenance names them.
    for (const id of [fixture.derived, fixture.removed]) {
      expect(scope.writableTurnIds.has(id)).toBe(false);
      expect(scope.writableProvenance.has(id)).toBe(false);
    }
    // Every id that IS writable carries FULL authority — the relations-only
    // class is gone, so the union has nothing left to subtract.
    for (const id of scope.writableTurnIds) {
      expect(settlementWritePermissions(scope.writableProvenance.get(id)!)).toEqual({
        fields: true,
        relations: true,
      });
    }

    const context: SettlementTurnFacadeContext = {
      jobId: job.id,
      claimGeneration: job.claimGeneration,
      stage: "edges",
      sessionId,
      reviewableTurnIds: scope.writableTurnIds,
      writableProvenance: scope.writableProvenance,
      contextBuiltAtEpoch: NOW,
    };
    const engine = createSettlementDirectWriteEngine({ db, context, now: () => NOW });
    recallMemory(db, {
      id: address(fixture.derived),
      filter: { fields: ["relations"] },
      readerId: claimWriterId(job.id, job.claimGeneration, "edges"),
    });

    const relation = engine.writeNote(
      settlementTurnWriteInputSchema.parse({
        turn: address(fixture.derived),
        use: [address(fixture.remote)],
      }),
    );
    expect(relation.content[0]!.text).toContain("outside this dispatch's reviewable window");
    expect(
      getOutgoingEdges(db, { kind: "turn", id: fixture.derived }).some(
        (edge) => edge.cited.id === fixture.remote,
      ),
    ).toBe(false);
  });
});

describe("the deltas are a pure function of the persisted snapshot", () => {
  let db: Database;
  let sessionId: number;
  let segmentId: number;
  let job: NoteSettlementJob;

  const addTurn = (promptNumber: number, tags: string[]): number =>
    db
      .query<{ id: number }, [number, number, number, string]>(
        `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch, type, tags)
         VALUES (?, ?, 'extracted', ?, '["design"]', ?)
         RETURNING id`,
      )
      .get(sessionId, promptNumber, NOW - 100 + promptNumber, JSON.stringify(tags))!.id;

  const addEdge = (citingId: number, citedId: number): void => {
    db.query<unknown, [number, number, number]>(
      `INSERT INTO memory_edges
         (citing_kind, citing_id, cited_kind, cited_id, provenance,
          tail_tag, head_tag, relation_class, relation_coverage, created_at_epoch)
       VALUES ('turn', ?, 'turn', ?, 'judged', '', '', 'use', '', ?)`,
    ).run(citingId, citedId, NOW);
  };

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "settlement-read-deltas-pure",
      project: "settlement-read-deltas-pure",
      title: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;
    segmentId = createSegment(db, { title: "Task", tags: [TASK], nowEpoch: 10 }).id;
    insertLane(db, segmentId, "alpha", 10);
    enqueueNoteSettlementWindows(
      db,
      [{ sessionId, windowStart: 1, windowEnd: 1, triggerType: "consecutive" }],
      NOW,
      ERA,
    );
    job = claimNextNoteSettlementJob(db, sessionId, NOW, NOW * 1000)!;
  });
  afterEach(() => db.close());

  test("the declaration endpoints are frozen at the transition: an edge written afterwards changes nothing a retry reads", () => {
    const w = addTurn(1, [TASK, "alpha"]);
    const cited = addTurn(2, [TASK]);
    const later = addTurn(3, [TASK]);
    addSegmentMembers(db, segmentId, [w, cited, later], 10);
    addEdge(w, cited);

    const snapshot = writeNoteSettlementTransitionSnapshots(db, {
      jobId: job.id,
      window: [w],
      lookback: [],
      closure: [],
      worklist: [],
      eraCutoffEpoch: null,
    });
    expect(snapshot.declarationEndpointIds).toEqual([cited]);
    expect(snapshot.readDeltas).toEqual({
      initialWritableIds: [w],
      contextDelta: [cited],
    });
    expect(readNoteSettlementDeclarationEndpointSnapshot(db, job.id)).toEqual([cited]);

    // Stage 2 itself writes an edge to a third turn. The live graph moved;
    // the frozen snapshot — and so the deltas a retry prints — did not.
    addEdge(w, later);
    expect(readSettlementFrozenScope(db, job.id)!.readDeltas.contextDelta).toEqual([cited]);
    expect(
      computeSettlementReadDeltas({
        writable: readNoteSettlementWritableSnapshot(db, job.id),
        laneMembers: new Map(),
        declarationEndpointIds: readNoteSettlementDeclarationEndpointSnapshot(db, job.id),
      }).contextDelta,
    ).toEqual([cited]);
  });

  /**
   * TICKET 14: the caller that used to reach `clearSettlementJobTransitionScratch`
   * — `invalidateOverlappingSettlementJobs` — is deleted, and the helper is now
   * private to `db/note-settlement.ts` behind the ONE surviving caller, the
   * cutover fence's `resetNoteSettlementJobToStageOne`. So the clearing is
   * pinned through that entry point instead of through the deleted one.
   */
  test("a stage-one reset clears snapshot #4 with the other three", () => {
    const w = addTurn(1, [TASK, "alpha"]);
    const cited = addTurn(2, [TASK]);
    addSegmentMembers(db, segmentId, [w, cited], 10);
    addEdge(w, cited);
    writeNoteSettlementTransitionSnapshots(db, {
      jobId: job.id,
      window: [w],
      lookback: [],
      closure: [],
      worklist: [],
      eraCutoffEpoch: null,
    });
    expect(readNoteSettlementDeclarationEndpointSnapshot(db, job.id)).toEqual([cited]);

    expect(resetNoteSettlementJobToStageOne(db, job.id, NOW)).not.toBeNull();
    expect(readNoteSettlementDeclarationEndpointSnapshot(db, job.id)).toEqual([]);
    expect(readSettlementFrozenScope(db, job.id)).toBeNull();
  });

  test("a job that never transitioned hands stage 2 empty deltas", () => {
    const holder = installSettlementEdgesScope(db, job.id, {
      writableTurnIds: new Set([1]),
      scopeProvenance: undefined,
    });
    expect(holder.current.readDeltas).toEqual({
      initialWritableIds: [],
      contextDelta: [],
    });
    expect(buildSettlementWorklistRendering(db, job.id)).toEqual({
      lanes: [],
      homeless: [],
      contextDelta: [],
    });
  });
});
