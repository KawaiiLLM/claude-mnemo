import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { insertLane } from "../../src/db/lanes";
import { normalizeIncidentAttribution } from "../../src/db/normalize-incident-attribution";
import {
  claimNextNoteSettlementJob,
  enqueueNoteSettlementWindows,
  ensureNoteSettlementStageSchema,
  getNoteSettlementJob,
  type NoteSettlementJob,
} from "../../src/db/note-settlement";
import {
  enumerateDerivedSideCiters,
  readPreSideResolutions,
} from "../../src/db/note-settlement-pre-resolutions";
import {
  readNoteSettlementWritableSnapshot,
  settlementWritePermissions,
  writeNoteSettlementTransitionSnapshots,
} from "../../src/db/note-settlement-snapshots";
import { initializeSchema } from "../../src/db/schema";
import { addSegmentMembers, createSegment, writeMembershipTags } from "../../src/db/segments";
import {
  invalidateOverlappingSettlementJobs,
  persistNoteSettlementClaimScope,
  readNoteSettlementClaimScope,
} from "../../src/db/settlement-job-invalidation";
import { upsertSession } from "../../src/db/sessions";

/**
 * MAIN-AGENT-EDGES TICKET 04 — the derived-side closure and structural
 * invalidation (spec D6 and D9; peer findings R9-2, R9-7, R9-9, R10-6, R10-7,
 * R10-9).
 *
 * The two halves are tested together because they are the two answers to ONE
 * question. A verb makes an incident side `ambiguous`; either a live settlement
 * run can still declare it (invalidate that run, keep the edge — and if the run
 * is the one DOING the write, its own stage 2 declares it, which is what the
 * closure grants authority for) or nobody can (delete it, receipted).
 */

const NOW = 1_800_000_000;
const ERA = 1;

describe("the derived-side closure — PRE recorded at the mutation, closed at finalize", () => {
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

  const addEdge = (
    citingId: number,
    citedId: number,
    tailTag = "",
    headTag = "",
  ): number =>
    db
      .query<{ id: number }, [number, number, string, string, number]>(
        `INSERT INTO memory_edges
           (citing_kind, citing_id, cited_kind, cited_id, provenance,
            tail_tag, head_tag, relation_class, relation_coverage, created_at_epoch)
         VALUES ('turn', ?, 'turn', ?, 'judged', ?, ?, 'use', '', ?)
         RETURNING id`,
      )
      .get(citingId, citedId, tailTag, headTag, NOW)!.id;

  /** The projection, through the SAME primitive stage 1's batch tag write uses. */
  const project = (turnId: number, tags: string[], jobId: number = job.id) =>
    writeMembershipTags(db, {
      operation: "normal",
      writes: [{ turnId, tags }],
      writer: "settlement",
      nowEpoch: NOW,
      settlementJobId: jobId,
    });

  const transition = () =>
    writeNoteSettlementTransitionSnapshots(db, {
      jobId: job.id,
      window: [],
      lookback: [],
      closure: [],
      worklist: [],
      eraCutoffEpoch: null,
    });

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "derived-side-closure",
      project: "derived-side-closure",
      title: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;
    segmentId = createSegment(db, { title: "Task", tags: ["the-task"], nowEpoch: 10 }).id;
    insertLane(db, segmentId, "alpha", 10);
    insertLane(db, segmentId, "beta", 10);
    enqueueNoteSettlementWindows(
      db,
      [{ sessionId, windowStart: 1, windowEnd: 9, triggerType: "consecutive" }],
      NOW,
      ERA,
    );
    job = claimNextNoteSettlementJob(db, sessionId, NOW, NOW * 1000)!;
  });
  afterEach(() => db.close());

  test("a run's own projection turns a DERIVED side ambiguous, and the closure grants its citer relations-only authority", () => {
    const citing = addTurn(1, ["the-task", "alpha"]);
    const cited = addTurn(2, ["the-task", "alpha"]);
    addSegmentMembers(db, segmentId, [citing, cited], 10);
    const edgeId = addEdge(citing, cited);

    // PRE: both sides DERIVE `alpha`. The projection puts the citer in a second
    // lane — nobody removed anything and nobody declared anything, and the tail
    // side has stopped being decidable.
    project(citing, ["the-task", "alpha", "beta"]);

    expect(readPreSideResolutions(db, job.id)).toEqual([
      { edgeRowId: edgeId, side: "head", citingId: citing, citedId: cited, outcome: "derived" },
      { edgeRowId: edgeId, side: "tail", citingId: citing, citedId: cited, outcome: "derived" },
    ]);
    // KEPT, not deleted: the acting job is exempt from its own invalidation, so
    // the seam leaves the edge for that job's stage 2 to declare.
    expect(
      db.query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM memory_edges WHERE id = ?").get(edgeId)?.n,
    ).toBe(1);

    expect(enumerateDerivedSideCiters(db, job.id)).toEqual([
      { edgeId, side: "tail", outcome: "ambiguous", citingTurnId: citing },
    ]);

    const snapshot = transition();
    expect([...(snapshot.writable.get(citing) ?? [])]).toEqual(["derived-side-citer"]);
    expect([...(readNoteSettlementWritableSnapshot(db, job.id).get(citing) ?? [])]).toEqual([
      "derived-side-citer",
    ]);
    // RELATIONS ONLY, exactly like `removed-side-citer` (spec D6, R9-9).
    expect(settlementWritePermissions(["derived-side-citer"])).toEqual({
      fields: false,
      relations: true,
    });
    // A turn that is ALSO an ordinary member keeps the union's full authority.
    expect(settlementWritePermissions(["window", "derived-side-citer"])).toEqual({
      fields: true,
      relations: true,
    });
  });

  test("a PRE-BAD side is NOT granted — pre-existing damage is somebody else's debt", () => {
    // The citer is ALREADY in two lanes with a blank tail: the side reads
    // `ambiguous` before this run does anything at all.
    const citing = addTurn(1, ["the-task", "alpha", "beta"]);
    const cited = addTurn(2, ["the-task", "alpha"]);
    addSegmentMembers(db, segmentId, [citing, cited], 10);
    addEdge(citing, cited);

    // A projection that touches the citer without repairing the side.
    project(citing, ["the-task", "alpha", "beta", "topic:x"]);

    expect(
      readPreSideResolutions(db, job.id).find((row) => row.side === "tail")?.outcome,
    ).toBe("ambiguous");
    expect(enumerateDerivedSideCiters(db, job.id)).toEqual([]);
    expect(transition().writable.size).toBe(0);
  });

  test("PRE is FIRST-WRITE-WINS: a repeated stage-1 call cannot overwrite the state the run inherited", () => {
    const citing = addTurn(1, ["the-task", "alpha"]);
    const cited = addTurn(2, ["the-task", "alpha"]);
    addSegmentMembers(db, segmentId, [citing, cited], 10);
    const edgeId = addEdge(citing, cited);

    project(citing, ["the-task", "alpha", "beta"]);
    // A SECOND call over the same turn. Its own pre-state is `ambiguous` — the
    // damage the first call did. Recording it would turn the run's own repair
    // into a fresh debt and hide the transition that matters.
    project(citing, ["the-task", "alpha", "beta", "topic:x"]);

    const recorded = readPreSideResolutions(db, job.id);
    expect(recorded.filter((row) => row.edgeRowId === edgeId)).toHaveLength(2);
    expect(recorded.find((row) => row.side === "tail")?.outcome).toBe("derived");
    // …and the grant survives the repeat, which it would not if the second
    // record had won.
    expect(enumerateDerivedSideCiters(db, job.id)).toEqual([
      { edgeId, side: "tail", outcome: "ambiguous", citingTurnId: citing },
    ]);
  });

  test("the INVALID path grants too: a declaration whose lane left the registry is E4, not a derivation", () => {
    const citing = addTurn(1, ["the-task", "alpha", "beta"]);
    const cited = addTurn(2, ["the-task", "alpha"]);
    addSegmentMembers(db, segmentId, [citing, cited], 10);
    const edgeId = addEdge(citing, cited, "beta", "");

    // PRE: a live declaration on a genuinely ambiguous endpoint — the one thing
    // a stored side is for. Recorded by a projection that leaves it alone.
    project(citing, ["the-task", "alpha", "beta", "topic:x"]);
    expect(readPreSideResolutions(db, job.id).find((row) => row.side === "tail")?.outcome).toBe(
      "declared",
    );

    // The lane is undeclared in the task. The turn still CARRIES the word, so
    // the declaration is not blank — it is a contradiction between two writes,
    // which `resolveEdgeSide` answers `invalid` and never `derived`.
    db.query("DELETE FROM lanes WHERE segment_id = ? AND tag = 'beta'").run(segmentId);

    expect(enumerateDerivedSideCiters(db, job.id)).toEqual([
      { edgeId, side: "tail", outcome: "invalid", citingTurnId: citing },
    ]);
    expect([...(transition().writable.get(citing) ?? [])]).toEqual(["derived-side-citer"]);
  });

  test("a REMOTE citer — outside the window, cited into it — enters the persisted final snapshot", () => {
    const remote = addTurn(1, ["the-task", "alpha"]);
    const windowTurn = addTurn(2, ["the-task", "alpha"]);
    addSegmentMembers(db, segmentId, [remote, windowTurn], 10);
    // The REMOTE turn cites the window turn, and its own HEAD side derives
    // `alpha` from the window turn's single lane.
    const edgeId = addEdge(remote, windowTurn);

    project(windowTurn, ["the-task", "alpha", "beta"]);

    expect(enumerateDerivedSideCiters(db, job.id)).toEqual([
      { edgeId, side: "head", outcome: "ambiguous", citingTurnId: remote },
    ]);
    const snapshot = transition();
    // The run's window never named this turn; the closure is the ONLY reason it
    // is writable, and the persisted snapshot is where stage 2 reads it.
    expect([...(readNoteSettlementWritableSnapshot(db, job.id).keys())]).toEqual([remote]);
    expect([...(snapshot.writable.get(remote) ?? [])]).toEqual(["derived-side-citer"]);
  });

  test("a STALE grant is refused: an edge a structural verb removed contributes nothing at finalize", () => {
    const citing = addTurn(1, ["the-task", "alpha"]);
    const cited = addTurn(2, ["the-task", "alpha"]);
    addSegmentMembers(db, segmentId, [citing, cited], 10);
    const edgeId = addEdge(citing, cited);

    project(citing, ["the-task", "alpha", "beta"]);
    expect(enumerateDerivedSideCiters(db, job.id)).toHaveLength(1);

    // The edge set moved between the record and the finalize — a retraction, or
    // a structural verb's own subtraction. The PRE row still names it.
    db.query("DELETE FROM memory_edges WHERE id = ?").run(edgeId);

    expect(enumerateDerivedSideCiters(db, job.id)).toEqual([]);
    expect(transition().writable.size).toBe(0);
  });

  test("a run OUTSIDE settlement records no PRE state at all — the closure is a settlement construct", () => {
    const citing = addTurn(1, ["the-task", "alpha"]);
    const cited = addTurn(2, ["the-task", "alpha"]);
    addSegmentMembers(db, segmentId, [citing, cited], 10);
    addEdge(citing, cited);

    writeMembershipTags(db, {
      operation: "normal",
      writes: [{ turnId: citing, tags: ["the-task", "alpha", "beta"] }],
      nowEpoch: NOW,
    });
    expect(readPreSideResolutions(db, job.id)).toEqual([]);
  });
});

describe("invalidateOverlappingSettlementJobs — the live-job branch in front of the delete", () => {
  let db: Database;
  let sessionId: number;
  let segmentId: number;

  const addTurn = (promptNumber: number, tags: string[]): number =>
    db
      .query<{ id: number }, [number, number, number, string]>(
        `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch, type, tags)
         VALUES (?, ?, 'extracted', ?, '["design"]', ?)
         RETURNING id`,
      )
      .get(sessionId, promptNumber, NOW - 100 + promptNumber, JSON.stringify(tags))!.id;

  const addEdge = (citingId: number, citedId: number): number =>
    db
      .query<{ id: number }, [number, number]>(
        `INSERT INTO memory_edges
           (citing_kind, citing_id, cited_kind, cited_id, provenance,
            tail_tag, head_tag, relation_class, relation_coverage, created_at_epoch)
         VALUES ('turn', ?, 'turn', ?, 'judged', '', '', 'use', '', 1)
         RETURNING id`,
      )
      .get(citingId, citedId)!.id;

  /**
   * Rows written straight to the table rather than through
   * `enqueueNoteSettlementWindows`: this suite needs FIVE jobs whose windows
   * all cover one prompt, and the planner's own floors (`below_window_floor`,
   * `duplicate_window`) exist precisely to stop that being enqueued. Nothing
   * here is about how a window is planned — it is about what an invalidation
   * does to a row that already exists.
   */
  const enqueue = (windowStart: number, windowEnd: number): { id: number } =>
    db
      .query<{ id: number }, [number, number, number, number, number]>(
        `INSERT INTO note_settlement_jobs
           (session_id, window_start, window_end, trigger_type, status, attempts,
            retry_at_epoch, created_at_epoch, updated_at_epoch)
         VALUES (?, ?, ?, 'consecutive', 'pending', 0, 0, ?, ?)
         RETURNING id`,
      )
      .get(sessionId, windowStart, windowEnd, NOW, NOW)!;

  const setStatus = (jobId: number, status: string, stage = "topics") =>
    db
      .query<unknown, [string, string, number]>(
        "UPDATE note_settlement_jobs SET status = ?, stage = ? WHERE id = ?",
      )
      .run(status, stage, jobId);

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "invalidation",
      project: "invalidation",
      title: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;
    segmentId = createSegment(db, { title: "Task", tags: ["the-task"], nowEpoch: 10 }).id;
    insertLane(db, segmentId, "alpha", 10);
    insertLane(db, segmentId, "beta", 10);
    // The staged columns are additive and normally arrive with the first
    // enqueue; this suite writes its job rows directly, so it asks for them.
    ensureNoteSettlementStageSchema(db);
  });
  afterEach(() => db.close());

  test("`pending`, `claimed` and `failed` reset to pending/topics with the generation bumped; `done` and `abandoned` are untouched", () => {
    const turn = addTurn(5, ["the-task", "alpha"]);
    addEdge(turn, addTurn(6, ["the-task", "alpha"]));
    // Five windows, all of them covering prompt 5 — distinct only because
    // `(session, window_start, trigger)` is unique. Overlap is therefore
    // identical for all five and the STATUS is the only thing that differs.
    const jobs = {
      pending: enqueue(1, 5),
      claimed: enqueue(2, 5),
      failed: enqueue(3, 5),
      done: enqueue(4, 5),
      abandoned: enqueue(5, 5),
    };
    setStatus(jobs.claimed.id, "claimed", "edges");
    setStatus(jobs.failed.id, "failed", "edges");
    setStatus(jobs.done.id, "done", "edges");
    setStatus(jobs.abandoned.id, "abandoned", "edges");
    // A `pending` job that kept `stage='edges'` after a lease loss is exactly
    // the R9-7 case: reclaim preserves the stage on purpose, and here that is
    // precisely wrong.
    setStatus(jobs.pending.id, "pending", "edges");

    const invalidated = invalidateOverlappingSettlementJobs(db, [turn], { nowEpoch: NOW });
    expect(invalidated.map((entry) => entry.jobId).sort((a, b) => a - b)).toEqual(
      [jobs.pending.id, jobs.claimed.id, jobs.failed.id].sort((a, b) => a - b),
    );

    for (const id of [jobs.pending.id, jobs.claimed.id, jobs.failed.id]) {
      const row = getNoteSettlementJob(db, id)!;
      expect(row.status).toBe("pending");
      expect(row.stage).toBe("topics");
      expect(row.transitionSeq).toBeNull();
      expect(row.claimGeneration).toBe(1);
      expect(row.claimedAtEpoch).toBeNull();
    }
    for (const id of [jobs.done.id, jobs.abandoned.id]) {
      const row = getNoteSettlementJob(db, id)!;
      expect(row.stage).toBe("edges");
      expect(row.claimGeneration).toBe(0);
    }
    expect(getNoteSettlementJob(db, jobs.done.id)!.status).toBe("done");
    expect(getNoteSettlementJob(db, jobs.abandoned.id)!.status).toBe("abandoned");
  });

  test("every frozen scratch the transition wrote is cleared, and the impression lease goes back", () => {
    const turn = addTurn(1, ["the-task", "alpha"]);
    addEdge(turn, addTurn(2, ["the-task", "alpha"]));
    const job = enqueue(1, 1);
    setStatus(job.id, "claimed", "edges");

    writeNoteSettlementTransitionSnapshots(db, {
      jobId: job.id,
      window: [turn],
      lookback: [],
      closure: [],
      worklist: [{ segmentId, laneTag: "alpha" }],
      eraCutoffEpoch: null,
    });
    db.query<unknown, [number, number, number, number]>(
      `INSERT INTO note_settlement_pre_side_resolutions
         (job_id, edge_row_id, side, citing_id, cited_id, outcome, created_at_epoch)
       VALUES (?, 1, 'tail', ?, ?, 'derived', ?)`,
    ).run(job.id, turn, turn, NOW);
    db.query<unknown, [number, number]>(
      `INSERT INTO impression_debts (segment_id, lane_tag, kind, created_at_epoch,
                                     claimed_at_epoch, claimed_by_job_id)
       VALUES (?, 'alpha', 'merge', 1, 1, ?)`,
    ).run(segmentId, job.id);

    expect(readNoteSettlementWritableSnapshot(db, job.id).size).toBe(1);

    invalidateOverlappingSettlementJobs(db, [turn], { nowEpoch: NOW });

    expect(readNoteSettlementWritableSnapshot(db, job.id).size).toBe(0);
    for (const table of [
      "note_settlement_worklist",
      "note_settlement_lane_members",
      "note_settlement_pre_side_resolutions",
      "homeless_groups",
    ]) {
      expect(
        db.query<{ n: number }, [number]>(`SELECT COUNT(*) AS n FROM ${table} WHERE job_id = ?`).get(job.id)?.n,
      ).toBe(0);
    }
    expect(
      db
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM impression_debts WHERE claimed_by_job_id IS NOT NULL",
        )
        .get()?.n,
    ).toBe(0);
  });

  test("the CLAIM-TIME scope is what finds a topics-stage job — it has no frozen snapshot to be found by", () => {
    // A turn OUTSIDE every job's own window: only a persisted claim scope can
    // connect the two, which is the hole R10-7 named.
    const outside = addTurn(50, ["the-task", "alpha"]);
    addEdge(outside, addTurn(51, ["the-task", "alpha"]));
    const job = enqueue(1, 2);
    setStatus(job.id, "claimed", "topics");

    expect(invalidateOverlappingSettlementJobs(db, [outside], { nowEpoch: NOW })).toEqual([]);

    persistNoteSettlementClaimScope(db, job.id, [outside]);
    expect(readNoteSettlementClaimScope(db, job.id)).toEqual([outside]);

    expect(
      invalidateOverlappingSettlementJobs(db, [outside], { nowEpoch: NOW }).map((e) => e.jobId),
    ).toEqual([job.id]);
    // The scope record SURVIVES the reset: it is the only durable pointer left
    // until the next claim writes its own.
    expect(readNoteSettlementClaimScope(db, job.id)).toEqual([outside]);
  });

  test("overlap reaches through the affected turn's INCIDENT CITERS, not only the turn itself", () => {
    const citer = addTurn(1, ["the-task", "alpha"]);
    const cited = addTurn(2, ["the-task", "alpha"]);
    addEdge(citer, cited);
    // The job's window covers the CITER only; the verb moved the CITED turn.
    const job = enqueue(1, 1);
    setStatus(job.id, "claimed", "topics");

    expect(
      invalidateOverlappingSettlementJobs(db, [cited], { nowEpoch: NOW }).map((e) => e.jobId),
    ).toEqual([job.id]);
  });

  test("`excludeJobId` exempts the job doing the write — a run cannot reset itself over its own projection", () => {
    const turn = addTurn(1, ["the-task", "alpha"]);
    addEdge(turn, addTurn(2, ["the-task", "alpha"]));
    const job = enqueue(1, 1);
    setStatus(job.id, "claimed", "topics");

    expect(
      invalidateOverlappingSettlementJobs(db, [turn], { nowEpoch: NOW, excludeJobId: job.id }),
    ).toEqual([]);
    expect(getNoteSettlementJob(db, job.id)!.status).toBe("claimed");
  });

  test("a LIVE window's newly ambiguous edge is KEPT and its job invalidated; a DONE window's is DELETED and receipted", () => {
    const citing = addTurn(1, ["the-task", "alpha"]);
    const cited = addTurn(2, ["the-task", "alpha"]);
    addSegmentMembers(db, segmentId, [citing, cited], 10);
    const edgeId = addEdge(citing, cited);
    const live = enqueue(1, 2);
    setStatus(live.id, "claimed", "edges");

    // The citer joins a second lane: the tail side stops deriving.
    db.query("UPDATE turns SET tags = ? WHERE id = ?").run(
      JSON.stringify(["the-task", "alpha", "beta"]),
      citing,
    );
    const kept = normalizeIncidentAttribution(db, [citing], {
      writer: "lane:retag",
      nowEpoch: NOW,
    });
    expect(kept.deletedEdges).toEqual([]);
    expect(kept.invalidatedJobIds).toEqual([live.id]);
    expect(getNoteSettlementJob(db, live.id)!.status).toBe("pending");
    expect(
      db.query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM memory_edges WHERE id = ?").get(edgeId)?.n,
    ).toBe(1);

    // Now the same window is DONE. There is nobody left to declare, and the
    // spec's own answer (T2421) is subtraction.
    setStatus(live.id, "done", "edges");
    db.query("UPDATE turns SET tags = ? WHERE id = ?").run(
      JSON.stringify(["the-task", "alpha", "beta", "topic:x"]),
      citing,
    );
    const deleted = normalizeIncidentAttribution(db, [citing], {
      writer: "lane:retag",
      nowEpoch: NOW,
    });
    expect(deleted.deletedEdges).toEqual([
      { edgeId, citingId: citing, citedId: cited, side: "tail" },
    ]);
    expect(deleted.invalidatedJobIds).toEqual([]);
    expect(
      db
        .query<{ action: string; side: string; edgeRowId: number }, []>(
          "SELECT action, side, edge_row_id AS edgeRowId FROM edge_attribution_receipts ORDER BY id",
        )
        .all(),
    ).toEqual([{ action: "delete-edge", side: "tail", edgeRowId: edgeId }]);
  });
});
