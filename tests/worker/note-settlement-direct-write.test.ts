import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase, runWriteTransaction } from "../../src/db/database";
import {
  claimNextNoteSettlementJob,
  enqueueNoteSettlementWindows,
  getNoteSettlementCursor,
  getNoteSettlementJob,
  type NoteSettlementJob,
} from "../../src/db/note-settlement";
import { listRecentSettlementProposals } from "../../src/db/note-settlement-proposals";
import { initializeSchema } from "../../src/db/schema";
import {
  addSegmentMembers,
  createSegment,
  getSegmentMemberTurnIds,
  listAttachedSegments,
  listOpenSegments,
} from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { getTurnById, updateTurnById } from "../../src/db/turns";
import { getOutgoingEdges, writeMemoryEdges } from "../../src/db/memory-edges";
import { createSettlementDirectWriteEngine } from "../../src/worker/note-settlement-direct-write";
import type { SettlementTurnFacadeContext } from "../../src/worker/note-settlement-turn-facade";
import { SETTLEMENT_ERA_CUTOFF_EPOCH } from "../support/settlement-config";

/**
 * The direct-write engine (ticket 05: `note`/`remember` land immediately;
 * ticket 06: `commit` is repurposed to claim validity + a run summary + the
 * job's terminal mark — this file covers each of those three duties with its
 * own test, plus the empty-handed-window acceptance criterion both tickets
 * name explicitly.
 */

const NOW = 1_800_000_000;

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
  initializeSchema(db);
});

afterEach(() => {
  db.close();
});

function seedSession(): number {
  return upsertSession(db, {
    contentSessionId: "settlement-direct-write-session",
    project: "/tmp/project-settlement-direct-write",
    title: "settlement direct-write fixture",
    content: null,
    insight: null,
    createdAtEpoch: NOW - 10_000,
    updatedAtEpoch: NOW - 10_000,
    completedAtEpoch: null,
  }).id;
}

function seedTurn(sessionDbId: number, promptNumber: number): number {
  return db
    .query<{ id: number }, [number, number, string, string, number]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         tool_call_count, created_at_epoch
       ) VALUES (?, ?, 'active', ?, ?, 3, ?)
       RETURNING id`,
    )
    .get(
      sessionDbId,
      promptNumber,
      `prompt ${promptNumber}`,
      `response ${promptNumber}`,
      NOW - 1_000 + promptNumber,
    )!.id;
}

function claimWindow(
  sessionDbId: number,
  windowStart: number,
  windowEnd: number,
): NoteSettlementJob {
  enqueueNoteSettlementWindows(
    db,
    [{ sessionId: sessionDbId, windowStart, windowEnd, triggerType: "consecutive" }],
    NOW,
    SETTLEMENT_ERA_CUTOFF_EPOCH,
  );
  const job = claimNextNoteSettlementJob(db, sessionDbId, NOW, NOW * 1000);
  if (!job) {
    throw new Error("fixture failed to claim a settlement job");
  }
  return job;
}

function baseContext(
  job: NoteSettlementJob,
  overrides: Partial<SettlementTurnFacadeContext> = {},
): SettlementTurnFacadeContext {
  return {
    jobId: job.id,
    claimGeneration: job.claimGeneration,
    sessionId: job.sessionId,
    reviewableTurnIds: new Set(),
    contextBuiltAtEpoch: NOW,
    ...overrides,
  };
}

describe("note/remember land immediately, before commit is ever called (ticket 05)", () => {
  test("writeNote lands the row right away", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const engine = createSettlementDirectWriteEngine({
      db,
      context: baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      now: () => NOW,
    });

    const receipt = engine.writeNote({ turn: `S${sessionDbId}/T1`, type: ["design"] });

    expect(receipt.content[0]!.text).toContain("Landed");
    expect(getTurnById(db, t1)!.type).toEqual(["design"]);
    // The job is not yet marked done — only commit does that.
    expect(getNoteSettlementJob(db, job.id)!.status).toBe("claimed");
  });
});

describe("commit — three duties, each its own test (ticket 06)", () => {
  test("duty 1: claim validity — a reclaimed lease refuses commit and marks nothing done", () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const engine = createSettlementDirectWriteEngine({ db, context: baseContext(job), now: () => NOW });

    // The lease moves out from under this run (a reclaim, in production).
    db.query<unknown, [number]>(
      "UPDATE note_settlement_jobs SET claim_generation = claim_generation + 1 WHERE id = ?",
    ).run(job.id);

    const receipt = engine.commit();

    expect(receipt.content[0]!.text).toContain("Commit refused");
    expect(receipt.content[0]!.text).toContain("lease was reclaimed");
    expect(getNoteSettlementJob(db, job.id)!.status).toBe("claimed");
    expect(engine.getLastCommitMetrics()).toBeNull();
  });

  test("duty 2: a run summary counts exactly what THIS run wrote", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    const job = claimWindow(sessionDbId, 1, 2);
    const engine = createSettlementDirectWriteEngine({
      db,
      context: baseContext(job, { reviewableTurnIds: new Set([t1, t2]) }),
      now: () => NOW,
    });

    engine.writeNote({ turn: `S${sessionDbId}/T1`, type: ["design"] });
    engine.writeNote({ turn: `S${sessionDbId}/T2`, type: ["research"] });
    engine.writeMembership({
      action: "propose",
      addresses: [`S${sessionDbId}/T1`, `S${sessionDbId}/T2`],
      title: "a cluster",
    });

    engine.commit();
    const metrics = engine.getLastCommitMetrics();

    expect(metrics).not.toBeNull();
    expect(metrics!.turnsReviewed).toBe(2);
    expect(metrics!.reviewsYieldedToLateNote).toBe(0);
    expect(metrics!.proposalsCreated).toBe(1);
  });

  test("duty 3: the terminal mark — the job goes done and the cursor advances", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const engine = createSettlementDirectWriteEngine({
      db,
      context: baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      now: () => NOW,
    });
    engine.writeNote({ turn: `S${sessionDbId}/T1`, type: ["design"] });

    const receipt = engine.commit();

    expect(receipt.content[0]!.text).toContain("Committed");
    expect(getNoteSettlementJob(db, job.id)!.status).toBe("done");
    expect(getNoteSettlementCursor(db, sessionDbId)).toBe(1);
  });

  test("commit does not judge duty coverage — an empty-handed window (nothing written) completes exactly as cleanly", () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const engine = createSettlementDirectWriteEngine({ db, context: baseContext(job), now: () => NOW });

    // No writeNote/writeMembership call at all.
    const receipt = engine.commit();

    expect(receipt.content[0]!.text).toContain("Committed");
    expect(getNoteSettlementJob(db, job.id)!.status).toBe("done");
    // Ticket 11 split the counts so a receipt can no longer report an act
    // that did not happen (a `create` used to land in the proposal bucket);
    // an empty-handed window states every one of them as zero.
    expect(engine.getLastCommitMetrics()).toEqual({
      turnsReviewed: 0,
      reviewsYieldedToLateNote: 0,
      proseWritten: 0,
      relationsWritten: 0,
      relationsRestated: 0,
      relationsRetracted: 0,
      segmentsCreated: 0,
      proposalsCreated: 0,
      sessionNarrativeWritten: 0,
      membersReassigned: 0,
    });
  });

  test("a second commit call in the same run is idempotent, not a fence error", () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const engine = createSettlementDirectWriteEngine({ db, context: baseContext(job), now: () => NOW });

    expect(engine.commit().content[0]!.text).toContain("Committed");
    const second = engine.commit();

    expect(second.content[0]!.text).toContain("Already committed");
    expect(second.content[0]!.text).not.toContain("refused");
    expect(getNoteSettlementJob(db, job.id)!.status).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// Peer finding P1-1 (2026-08-19 commit review): each direct write must be
// check-write-stamp ATOMIC. A compound call whose relation half rejects
// AFTER its type half already applied must leave no partial state behind.
// ---------------------------------------------------------------------------

describe("a rejected direct write leaves no partial state (one transaction per call)", () => {
  test("type lands then the relation rejects: the whole call rolls back", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    updateTurnById(db, t1, { type: ["design"] });
    writeMemoryEdges(
      db,
      [{ citing: { kind: "turn", id: t2 }, cited: { kind: "turn", id: t1 }, relation: null, provenance: "text-ref" }],
      NOW - 500,
    );
    const job = claimWindow(sessionDbId, 1, 2);
    const engine = createSettlementDirectWriteEngine({
      db,
      context: baseContext(job, {
        reviewableTurnIds: new Set([t2]),
      }),
      now: () => NOW,
    });

    // implement = delivery-only: extends demands a decision-phase citing
    // turn, so the relation half rejects. Ticket 04 moved every rejection
    // AHEAD of the first mutation inside `evaluateSettlementTurnWrite`, so
    // this now holds twice over — the evaluator writes nothing, and the
    // engine's own per-call transaction would have rolled it back anyway.
    // The assertion is kept as the outer guard: whichever layer changes, no
    // partial state.
    const receipt = engine.writeNote({
      turn: "S" + sessionDbId + "/T2",
      type: ["implement"],
      extends: ["S" + sessionDbId + "/T1"],
    });

    expect(receipt.content[0]!.text).toContain("Parameter error");
    expect(getTurnById(db, t2)!.type).toEqual([]);
    const stamp = db
      .query("SELECT writer FROM write_gate_stamps WHERE entity_type = 'turn' AND entity_id = ? AND field = 'type'")
      .get(t2);
    expect(stamp).toBeNull();
  });

  // rubric-v10 ticket 02 (Gate C, mutation-critical): UNLIKE the type/extends
  // case above, this rejection fires AFTER a real mutation — the self-
  // `grounds` edge itself is written by `attachTurnRelations` before
  // `evaluateSettlementTurnWrite` re-reads the graph and finds no tagged
  // terminus. This is therefore a genuine exercise of the per-call
  // transaction wrapper's rollback, not a vacuous one: if the wrapper (or
  // Gate C itself) were disabled, the self-`grounds` edge would survive.
  test("a self-grounds with no tagged-indexes terminus rolls back the edge it already wrote", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    // round-4 review #1: `implement` isolates Gate C (no current terminus)
    // from the separate pre-write delivery-phase gate (`self-not-delivery`).
    updateTurnById(db, t1, { type: ["design", "implement"] });
    const job = claimWindow(sessionDbId, 1, 1);
    const engine = createSettlementDirectWriteEngine({
      db,
      context: baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      now: () => NOW,
    });

    const receipt = engine.writeNote({
      turn: `S${sessionDbId}/T1`,
      grounds: [`S${sessionDbId}/T1`],
    });

    expect(receipt.content[0]!.text).toContain("Parameter error");
    expect(receipt.content[0]!.text).toContain("TAGGED");
    expect(getOutgoingEdges(db, { kind: "turn", id: t1 })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Ticket 08 (edge-mechanism-revision, peer 终审必改 5): the lease is checked at
// EVERY direct write, in that write's own transaction — not only at `commit`.
// The membership verbs are why: `create`/`reassign`/`propose` create state
// rather than overwrite a stamped field, so before this ticket a claimant that
// had already lost its lease could plant a segment on the session and only be
// told at `commit` — with the segment already visible to the next window.
// ---------------------------------------------------------------------------

function reclaimLease(jobId: number): void {
  db.query<unknown, [number]>(
    "UPDATE note_settlement_jobs SET claim_generation = claim_generation + 1 WHERE id = ?",
  ).run(jobId);
}

describe("a reclaimed lease refuses every direct write, naming the lease (ticket 08)", () => {
  test("note: the turn write is refused and the row is untouched", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const engine = createSettlementDirectWriteEngine({
      db,
      context: baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      now: () => NOW,
    });
    reclaimLease(job.id);

    const receipt = engine.writeNote({ turn: `S${sessionDbId}/T1`, type: ["design"] });

    expect(receipt.content[0]!.text).toContain("Write refused");
    expect(receipt.content[0]!.text).toContain("lease was reclaimed");
    // The reason is named, not merely alluded to — a stale generation reads
    // differently from a job that is no longer claimed at all.
    expect(receipt.content[0]!.text).toContain("claim generation");
    expect(getTurnById(db, t1)!.type).toEqual([]);
  });

  test("remember(create): no segment is minted and nothing attaches to the session", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const engine = createSettlementDirectWriteEngine({
      db,
      context: baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      now: () => NOW,
    });
    reclaimLease(job.id);

    const receipt = engine.writeMembership({
      action: "create",
      title: "planted by a lapsed claimant",
      turns: [`S${sessionDbId}/T1`],
    });

    expect(receipt.content[0]!.text).toContain("Write refused");
    expect(receipt.content[0]!.text).toContain("lease was reclaimed");
    expect(listOpenSegments(db)).toEqual([]);
    expect(listAttachedSegments(db, sessionDbId)).toEqual([]);
  });

  test("a create counts as a segment created, never as a proposal (ticket 11)", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const engine = createSettlementDirectWriteEngine({
      db,
      context: baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      now: () => NOW,
    });

    engine.writeMembership({
      action: "create",
      title: "a real segment",
      turns: [`S${sessionDbId}/T1`],
    });
    engine.commit();

    const metrics = engine.getLastCommitMetrics()!;
    // The defect ticket 11 names: `proposeAlreadyExisted` is undefined for a
    // create, so the old `!outcome.proposeAlreadyExisted` test swallowed it
    // into the proposal bucket and the receipt reported an act that never
    // happened. A receipt that over-reports is worse than one that
    // under-reports, so both halves are pinned.
    expect(metrics.segmentsCreated).toBe(1);
    expect(metrics.proposalsCreated).toBe(0);
  });

  test("remember(reassign): membership stays exactly where it was", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const home = createSegment(db, { title: "where T1 already lives", nowEpoch: NOW - 100 });
    const target = createSegment(db, { title: "the would-be new home", nowEpoch: NOW - 100 });
    addSegmentMembers(db, home.id, [t1], NOW - 100);
    const job = claimWindow(sessionDbId, 1, 1);
    const engine = createSettlementDirectWriteEngine({
      db,
      context: baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      now: () => NOW,
    });
    reclaimLease(job.id);

    const receipt = engine.writeMembership({
      action: "reassign",
      turns: [`S${sessionDbId}/T1`],
      id: `E${target.id}`,
    });

    expect(receipt.content[0]!.text).toContain("Write refused");
    expect(receipt.content[0]!.text).toContain("lease was reclaimed");
    // Neither half of the reassignment ran: not the eviction, not the add.
    expect(getSegmentMemberTurnIds(db, home.id)).toEqual([t1]);
    expect(getSegmentMemberTurnIds(db, target.id)).toEqual([]);
  });

  test("remember(propose): no proposal row is stored", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const engine = createSettlementDirectWriteEngine({
      db,
      context: baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      now: () => NOW,
    });
    reclaimLease(job.id);

    const receipt = engine.writeMembership({
      action: "propose",
      addresses: [`S${sessionDbId}/T1`],
      title: "a cluster nobody asked this run for",
    });

    expect(receipt.content[0]!.text).toContain("Write refused");
    expect(receipt.content[0]!.text).toContain("lease was reclaimed");
    expect(listRecentSettlementProposals(db, 3)).toEqual([]);
  });

  test("a job already marked done refuses with the not-claimed reason, not a generation mismatch", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const engine = createSettlementDirectWriteEngine({
      db,
      context: baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      now: () => NOW,
    });
    db.query<unknown, [number]>(
      "UPDATE note_settlement_jobs SET status = 'done' WHERE id = ?",
    ).run(job.id);

    const receipt = engine.writeNote({ turn: `S${sessionDbId}/T1`, type: ["design"] });

    expect(receipt.content[0]!.text).toContain("not claimed");
    expect(getTurnById(db, t1)!.type).toEqual([]);
  });
});

describe("the lease check and the write share one transaction (ticket 08)", () => {
  test("a reclaim landing INSIDE the write's own transaction takes the whole call with it", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const engine = createSettlementDirectWriteEngine({
      db,
      context: baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      now: () => NOW,
      // The competing reclaim runs after BEGIN IMMEDIATE and before the
      // engine's own body — the one interleaving that tells the two designs
      // apart. A fence evaluated OUTSIDE the transaction (at construction, or
      // ahead of the BEGIN) would still see the generation it captured, let
      // `create` through, and commit the reclaim and the new segment together.
      // Because the refusal rolls the transaction back, the injected reclaim
      // is rolled back with it — which is why the assertion below is about the
      // segment, not about the job row.
      runWriteTransaction: (database, fn) =>
        runWriteTransaction(database, () => {
          reclaimLease(job.id);
          return fn();
        }),
    });

    const receipt = engine.writeMembership({
      action: "create",
      title: "raced against a reclaim",
      turns: [`S${sessionDbId}/T1`],
    });

    expect(receipt.content[0]!.text).toContain("lease was reclaimed");
    expect(listOpenSegments(db)).toEqual([]);
    expect(listAttachedSegments(db, sessionDbId)).toEqual([]);
  });
});

describe("a valid claimant's direct writes are unchanged by the lease check (ticket 08)", () => {
  test("create and reassign both land, and commit still reports them", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    const job = claimWindow(sessionDbId, 1, 2);
    const engine = createSettlementDirectWriteEngine({
      db,
      context: baseContext(job, { reviewableTurnIds: new Set([t1, t2]) }),
      now: () => NOW,
    });

    const created = engine.writeMembership({
      action: "create",
      title: "a real task",
      turns: [`S${sessionDbId}/T1`],
    });
    expect(created.content[0]!.text).toContain("Landed create");

    const segments = listAttachedSegments(db, sessionDbId);
    expect(segments).toHaveLength(1);
    expect(getSegmentMemberTurnIds(db, segments[0]!.id)).toEqual([t1]);

    const reassigned = engine.writeMembership({
      action: "reassign",
      turns: [`S${sessionDbId}/T2`],
      id: `E${segments[0]!.id}`,
    });
    expect(reassigned.content[0]!.text).toContain("Landed reassign");
    expect(getSegmentMemberTurnIds(db, segments[0]!.id)).toEqual([t1, t2]);

    expect(engine.commit().content[0]!.text).toContain("Committed");
    expect(engine.getLastCommitMetrics()!.membersReassigned).toBe(1);
  });
});
