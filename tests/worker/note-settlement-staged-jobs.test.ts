import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import {
  NOTE_SETTLEMENT_LEASE_MS,
  NOTE_SETTLEMENT_MAX_ATTEMPTS,
  NOTE_SETTLEMENT_RETRY_BASE_MS,
  claimNextNoteSettlementJob,
  completeNoteSettlementJob,
  enqueueNoteSettlementWindows,
  getNoteSettlementCursor,
  getNoteSettlementJob,
  listNoteSettlementDebts,
  transitionNoteSettlementJobToEdges,
  type NoteSettlementJob,
} from "../../src/db/note-settlement";
import {
  NoteSettlementJobFenceError,
  assertNoteSettlementJobClaimed,
} from "../../src/db/note-settlement-completion";
import {
  createNoteSettlementScheduler,
  type NoteSettlementDispatch,
  type NoteSettlementDispatchOutcome,
} from "../../src/worker/note-settlement";
import { createSettlementStopHook } from "../../src/worker/note-settlement-stop-hook";
import {
  SETTLEMENT_ENABLED_CONFIG,
  SETTLEMENT_ERA_CUTOFF_EPOCH,
} from "../support/settlement-config";

/**
 * The staged job machinery (staged-settlement spec Rev 5, §State machine and
 * ownership + §Retry law + §Implementation decision 2 "One dispatch per
 * claim", ticket 04), proved at the job-table and scheduler seams.
 *
 * Every assertion here is about the MACHINE: who owns the row, what the
 * transition writes and refuses, how the scheduler judges ONE dispatch call
 * per claim by re-reading the row (the post-hoc truth rule, re-anchored at
 * the terminal end — a completion the row does not show is always a
 * failure), and where a reclaimant resumes. `createNoteSettlementScheduler`
 * is driven directly in every test below, with hand-written stubs standing
 * in for the real unified/resume dispatches — realistic enough to transition
 * and commit through the same `db/note-settlement.ts` functions a real
 * dispatch would call, which is what makes the post-hoc row re-read the
 * thing under test rather than a stub's own bookkeeping.
 */

const CLOCK_START_MS = 1_700_000_000_000;

function createClock(startMs = CLOCK_START_MS) {
  let ms = startMs;
  return {
    nowMs: () => ms,
    now: () => Math.floor(ms / 1000),
    advance(byMs: number) {
      ms += byMs;
    },
  };
}

function seedSession(db: Database, contentSessionId: string): number {
  return upsertSession(db, {
    contentSessionId,
    project: "/tmp/project-staged-settlement",
    title: null,
    content: null,
    insight: null,
    createdAtEpoch: 1,
    updatedAtEpoch: 1_000,
    completedAtEpoch: null,
  }).id;
}

/**
 * One window on the books, with no turns behind it. The staged machinery is
 * indifferent to a window's contents — every seam under test reads the JOB
 * ROW — so a fixture that seeded fifty turns would only be seeding noise.
 */
function enqueueWindow(
  db: Database,
  sessionDbId: number,
  windowStart = 1,
  windowEnd = 50,
): NoteSettlementJob {
  const [job] = enqueueNoteSettlementWindows(
    db,
    [{ sessionId: sessionDbId, windowStart, windowEnd, triggerType: "consecutive" }],
    1_000,
    SETTLEMENT_ERA_CUTOFF_EPOCH,
  );
  expect(job).toBeDefined();
  return job!;
}

interface StageRecorder {
  dispatch: NoteSettlementDispatch;
  calls: NoteSettlementJob[];
}

function recordStage(
  outcome: (job: NoteSettlementJob) => Promise<NoteSettlementDispatchOutcome> = async () => ({
    ok: true,
  }),
): StageRecorder {
  const calls: NoteSettlementJob[] = [];
  return {
    calls,
    dispatch: async ({ job }) => {
      calls.push(job);
      return outcome(job);
    },
  };
}

describe("staged settlement: the stage column and the transition", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  test("every job is born on stage `topics`, with no transition recorded", () => {
    const sessionDbId = seedSession(db, "content-birth-stage");
    const job = enqueueWindow(db, sessionDbId);

    expect(job.stage).toBe("topics");
    expect(job.transitionSeq).toBeNull();
    expect(job.stage1Metrics).toBeNull();
    // And the same row read back the ordinary way, so this is a column, not a
    // default that only the INSERT's RETURNING clause knows about.
    expect(getNoteSettlementJob(db, job.id)!.stage).toBe("topics");
  });

  test("the transition is fenced, non-terminal and writes exactly three things", () => {
    const sessionDbId = seedSession(db, "content-transition-shape");
    enqueueWindow(db, sessionDbId);
    const clock = createClock();
    const claimed = claimNextNoteSettlementJob(
      db,
      sessionDbId,
      clock.now(),
      clock.nowMs(),
    )!;
    expect(claimed.stage).toBe("topics");
    expect(claimed.attempts).toBe(1);

    const transitioned = transitionNoteSettlementJobToEdges(
      db,
      claimed.id,
      claimed.claimGeneration,
      clock.now(),
    );

    expect(transitioned).not.toBeNull();
    // Written: the stage, the sequence value, stage 1's own metrics (empty for
    // the stub, because the stub produced none).
    expect(transitioned!.stage).toBe("edges");
    expect(transitioned!.transitionSeq).toBe(1);
    expect(transitioned!.stage1Metrics).toBe("{}");
    // NOT written: the job stays claimed, the generation does not move (stage 2
    // inherits the claim), no attempt is spent, the cursor does not advance and
    // nothing goes `done`. The era grant and the final metrics ride the
    // terminal commit, which this transition never calls.
    expect(transitioned!.status).toBe("claimed");
    expect(transitioned!.claimGeneration).toBe(claimed.claimGeneration);
    expect(transitioned!.attempts).toBe(1);
    expect(transitioned!.claimedAtEpoch).toBe(claimed.claimedAtEpoch);
    expect(getNoteSettlementCursor(db, sessionDbId)).toBe(0);
  });

  test("the transition sequence is a monotonic global counter, not a per-job maximum", () => {
    const first = seedSession(db, "content-seq-a");
    const second = seedSession(db, "content-seq-b");
    enqueueWindow(db, first);
    enqueueWindow(db, second);
    const clock = createClock();

    const jobA = claimNextNoteSettlementJob(db, first, clock.now(), clock.nowMs())!;
    const movedA = transitionNoteSettlementJobToEdges(
      db,
      jobA.id,
      jobA.claimGeneration,
      clock.now(),
    )!;
    const jobB = claimNextNoteSettlementJob(db, second, clock.now(), clock.nowMs())!;
    const movedB = transitionNoteSettlementJobToEdges(
      db,
      jobB.id,
      jobB.claimGeneration,
      clock.now(),
    )!;

    expect(movedA.transitionSeq).toBe(1);
    expect(movedB.transitionSeq).toBe(2);

    // Deleting the highest-numbered job must not let the next transition
    // re-issue its value: a sequence that repeats is not an ordering
    // authority, which is why the counter is a row and not a MAX().
    db.query<unknown, [number]>(
      "DELETE FROM note_settlement_jobs WHERE id = ?",
    ).run(movedB.id);
    const third = seedSession(db, "content-seq-c");
    enqueueWindow(db, third);
    const jobC = claimNextNoteSettlementJob(db, third, clock.now(), clock.nowMs())!;
    const movedC = transitionNoteSettlementJobToEdges(
      db,
      jobC.id,
      jobC.claimGeneration,
      clock.now(),
    )!;

    expect(movedC.transitionSeq).toBe(3);
  });

  test("the transition refuses a stale generation, an unclaimed row and a second transition", () => {
    const sessionDbId = seedSession(db, "content-transition-fence");
    enqueueWindow(db, sessionDbId);
    const clock = createClock();
    const claimed = claimNextNoteSettlementJob(
      db,
      sessionDbId,
      clock.now(),
      clock.nowMs(),
    )!;

    expect(
      transitionNoteSettlementJobToEdges(
        db,
        claimed.id,
        claimed.claimGeneration + 1,
        clock.now(),
      ),
    ).toBeNull();
    expect(getNoteSettlementJob(db, claimed.id)!.stage).toBe("topics");

    expect(
      transitionNoteSettlementJobToEdges(
        db,
        claimed.id,
        claimed.claimGeneration,
        clock.now(),
      ),
    ).not.toBeNull();
    // Single-step and one-way: the same context cannot transition twice, so a
    // replayed stage-1 ending can never take a second sequence value.
    expect(
      transitionNoteSettlementJobToEdges(
        db,
        claimed.id,
        claimed.claimGeneration,
        clock.now(),
      ),
    ).toBeNull();
    expect(getNoteSettlementJob(db, claimed.id)!.transitionSeq).toBe(1);
  });

  test("the ownership tuple is (job, generation, stage): a stale `topics` context is refused after the transition", () => {
    const sessionDbId = seedSession(db, "content-ownership-tuple");
    enqueueWindow(db, sessionDbId);
    const clock = createClock();
    const claimed = claimNextNoteSettlementJob(
      db,
      sessionDbId,
      clock.now(),
      clock.nowMs(),
    )!;

    // Before the transition both stages' assertions answer honestly.
    expect(
      assertNoteSettlementJobClaimed(db, claimed.id, claimed.claimGeneration, "topics").stage,
    ).toBe("topics");

    transitionNoteSettlementJobToEdges(
      db,
      claimed.id,
      claimed.claimGeneration,
      clock.now(),
    );

    // The generation is UNCHANGED, so the generation fence alone would wave the
    // stale stage-1 context straight through onto stage 2's work. The stage is
    // what stops it.
    expect(
      assertNoteSettlementJobClaimed(db, claimed.id, claimed.claimGeneration).claimGeneration,
    ).toBe(claimed.claimGeneration);
    let thrown: unknown;
    try {
      assertNoteSettlementJobClaimed(db, claimed.id, claimed.claimGeneration, "topics");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(NoteSettlementJobFenceError);
    expect((thrown as NoteSettlementJobFenceError).fenceReason).toBe("stage-mismatch");

    // Stage 2's own context passes.
    expect(
      assertNoteSettlementJobClaimed(db, claimed.id, claimed.claimGeneration, "edges").stage,
    ).toBe("edges");
  });
});

describe("staged settlement: one dispatch per claim (ticket 04)", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  test("happy path: one dispatch call — the run transitions and commits within it — settles the window", async () => {
    const sessionDbId = seedSession(db, "content-one-dispatch-happy");
    enqueueWindow(db, sessionDbId);
    const clock = createClock();
    const unified = recordStage(async (job) => {
      transitionNoteSettlementJobToEdges(db, job.id, job.claimGeneration, clock.now());
      completeNoteSettlementJob(db, job.id, clock.now(), job.claimGeneration);
      return { ok: true };
    });
    const resume = recordStage();
    const scheduler = createNoteSettlementScheduler({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: clock.now,
      nowMs: clock.nowMs,
      stage1Dispatch: unified.dispatch,
      dispatch: resume.dispatch,
    });

    const dispatched = await scheduler.drainSession(sessionDbId);

    expect(dispatched).toHaveLength(1);
    // ONE dispatch call for the whole claim — no same-drain chain into a
    // second one.
    expect(unified.calls).toHaveLength(1);
    expect(unified.calls[0]!.stage).toBe("topics");
    expect(resume.calls).toHaveLength(0);
    const settled = getNoteSettlementJob(db, dispatched[0]!.id)!;
    expect(settled.attempts).toBe(1);
    expect(settled.status).toBe("done");
    expect(settled.stage).toBe("edges");
    expect(settled.lastError).toBeNull();
    expect(settled.failureClass).toBeNull();
    expect(listNoteSettlementDebts(db)).toHaveLength(0);
  });

  test("post-hoc truth rule, re-anchored at the terminal end: a commit that landed survives its dispatch THROWING afterward", async () => {
    const sessionDbId = seedSession(db, "content-posthoc-throw");
    enqueueWindow(db, sessionDbId);
    const clock = createClock();
    const scheduler = createNoteSettlementScheduler({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: clock.now,
      nowMs: clock.nowMs,
      stage1Dispatch: async ({ job }) => {
        transitionNoteSettlementJobToEdges(db, job.id, job.claimGeneration, clock.now());
        completeNoteSettlementJob(db, job.id, clock.now(), job.claimGeneration);
        // The verdict is LOST — a crash, a killed subprocess, a bug in the
        // dispatch layer. The row already says what happened.
        throw new Error("the run died after its own commit had already landed");
      },
    });

    const dispatched = await scheduler.drainSession(sessionDbId);

    const settled = getNoteSettlementJob(db, dispatched[0]!.id)!;
    expect(settled.status).toBe("done");
    // The thrown failure is DISCARDED: no accounting of any kind.
    expect(settled.attempts).toBe(1);
    expect(settled.lastError).toBeNull();
    expect(settled.failureClass).toBeNull();
    expect(listNoteSettlementDebts(db)).toHaveLength(0);
  });

  test("post-hoc truth rule: a commit that landed survives its dispatch REPORTING A FAILURE", async () => {
    const sessionDbId = seedSession(db, "content-posthoc-failure");
    enqueueWindow(db, sessionDbId);
    const clock = createClock();
    const scheduler = createNoteSettlementScheduler({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: clock.now,
      nowMs: clock.nowMs,
      stage1Dispatch: async ({ job }) => {
        transitionNoteSettlementJobToEdges(db, job.id, job.claimGeneration, clock.now());
        completeNoteSettlementJob(db, job.id, clock.now(), job.claimGeneration);
        return {
          ok: false,
          reason: "the run reported a failure it had already superseded",
          failureClass: "deterministic",
        };
      },
    });

    const dispatched = await scheduler.drainSession(sessionDbId);

    const settled = getNoteSettlementJob(db, dispatched[0]!.id)!;
    expect(settled.status).toBe("done");
    expect(settled.attempts).toBe(1);
    expect(settled.lastError).toBeNull();
  });

  test("still claimed at `topics`, handled as reported: an honest failure records with its own reason, one call", async () => {
    const sessionDbId = seedSession(db, "content-topics-failure");
    enqueueWindow(db, sessionDbId);
    const clock = createClock();
    const dispatch = recordStage(async () => ({
      ok: false,
      reason: "stage topics: ended without reaching finalize — the run's own diagnosis text",
      failureClass: "deterministic",
    }));
    const scheduler = createNoteSettlementScheduler({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: clock.now,
      nowMs: clock.nowMs,
      stage1Dispatch: dispatch.dispatch,
    });

    const dispatched = await scheduler.drainSession(sessionDbId);

    expect(dispatch.calls).toHaveLength(1);
    const failed = getNoteSettlementJob(db, dispatched[0]!.id)!;
    expect(failed.status).toBe("failed");
    expect(failed.stage).toBe("topics");
    expect(failed.attempts).toBe(1);
    expect(failed.failureClass).toBe("deterministic");
    // Used VERBATIM — the scheduler never regenerates or replaces it.
    expect(failed.lastError).toBe(
      "stage topics: ended without reaching finalize — the run's own diagnosis text",
    );
  });

  // Ticket 04's own consequence, not a bug: with the chain retired, a topics
  // dispatch's `ok: true` is trusted exactly the way the pre-staging,
  // single-pass scheduler always trusted it — because a REAL production
  // dispatch only ever returns it once its own commit has already landed
  // (structurally guaranteed by both `createNoteSettlementDispatch` and
  // `createUnifiedNoteSettlementDispatch`, never merely promised). Unlike
  // `edges` below, `topics` grants that benefit of the doubt; the old
  // "a topics dispatch may only transition or fail" law dies with the chain
  // verdict it existed to police.
  test("still claimed at `topics`, handled as reported: `ok: true` completes the window even though nothing wrote `done`", async () => {
    const sessionDbId = seedSession(db, "content-topics-trusted-ok");
    enqueueWindow(db, sessionDbId);
    const clock = createClock();
    const scheduler = createNoteSettlementScheduler({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: clock.now,
      nowMs: clock.nowMs,
      stage1Dispatch: async () => ({ ok: true }),
    });

    const dispatched = await scheduler.drainSession(sessionDbId);

    const settled = getNoteSettlementJob(db, dispatched[0]!.id)!;
    expect(settled.status).toBe("done");
    expect(settled.attempts).toBe(1);
  });

  test("still claimed at `edges`: a transition that landed but did not commit is ALWAYS a recorded failure, whatever the outcome claimed", async () => {
    const sessionDbId = seedSession(db, "content-edges-always-fails");
    enqueueWindow(db, sessionDbId);
    const clock = createClock();
    const scheduler = createNoteSettlementScheduler({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: clock.now,
      nowMs: clock.nowMs,
      // Transitions, does NOT commit, and — dishonestly — reports success.
      // "A dispatch REPORTING completion the row does not show remains a
      // deterministic failure" (post-hoc truth, re-anchored at the terminal
      // end): unlike `topics`, `edges` grants no benefit of the doubt, since
      // the only legitimate way to leave `claimed` at `edges` is `commit`.
      stage1Dispatch: async ({ job }) => {
        transitionNoteSettlementJobToEdges(db, job.id, job.claimGeneration, clock.now());
        return { ok: true };
      },
    });

    const dispatched = await scheduler.drainSession(sessionDbId);

    const failed = getNoteSettlementJob(db, dispatched[0]!.id)!;
    // Emphatically NOT `done`: an outcome is never allowed to settle a window
    // the row does not agree was settled.
    expect(failed.status).toBe("failed");
    expect(failed.stage).toBe("edges");
    expect(failed.transitionSeq).toBe(1);
    expect(failed.failureClass).toBe("deterministic");
    expect(failed.lastError).toContain("does not show");
  });

  test("still claimed at `edges`: an honest failure keeps the dispatch's own composed diagnosis verbatim", async () => {
    const sessionDbId = seedSession(db, "content-edges-honest-failure");
    enqueueWindow(db, sessionDbId);
    const clock = createClock();
    const scheduler = createNoteSettlementScheduler({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: clock.now,
      nowMs: clock.nowMs,
      stage1Dispatch: async ({ job }) => {
        transitionNoteSettlementJobToEdges(db, job.id, job.claimGeneration, clock.now());
        return {
          ok: false,
          reason: "stage edges: stopped without commit — the run's own final diagnosis text",
          failureClass: "deterministic",
        };
      },
    });

    const dispatched = await scheduler.drainSession(sessionDbId);

    const failed = getNoteSettlementJob(db, dispatched[0]!.id)!;
    expect(failed.status).toBe("failed");
    expect(failed.stage).toBe("edges");
    expect(failed.lastError).toBe(
      "stage edges: stopped without commit — the run's own final diagnosis text",
    );
  });

  test("a throw after the transition landed is recorded as an `edges` failure with the thrown message", async () => {
    const sessionDbId = seedSession(db, "content-edges-throw");
    enqueueWindow(db, sessionDbId);
    const clock = createClock();
    const scheduler = createNoteSettlementScheduler({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: clock.now,
      nowMs: clock.nowMs,
      stage1Dispatch: async ({ job }) => {
        transitionNoteSettlementJobToEdges(db, job.id, job.claimGeneration, clock.now());
        throw new Error("the run crashed after its own transition, before it ever committed");
      },
    });

    const dispatched = await scheduler.drainSession(sessionDbId);

    const failed = getNoteSettlementJob(db, dispatched[0]!.id)!;
    expect(failed.status).toBe("failed");
    expect(failed.stage).toBe("edges");
    expect(failed.lastError).toContain("crashed after its own transition");
  });

  // Acceptance item 4: stop-without-terminal shapes.
  test("stop-without-terminal: before-transition stop is a `topics` failure as reported", async () => {
    const sessionDbId = seedSession(db, "content-stop-before-transition");
    enqueueWindow(db, sessionDbId);
    const clock = createClock();
    const scheduler = createNoteSettlementScheduler({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: clock.now,
      nowMs: clock.nowMs,
      // The run ENDED (no throw) without ever calling `finalize` — the stop
      // hook nudged once and the run's second stop stood as its answer.
      stage1Dispatch: async () => ({
        ok: false,
        reason: "stage topics: ended without reaching finalize (job status: claimed)",
        failureClass: "deterministic",
      }),
    });

    const dispatched = await scheduler.drainSession(sessionDbId);

    const failed = getNoteSettlementJob(db, dispatched[0]!.id)!;
    expect(failed.status).toBe("failed");
    expect(failed.stage).toBe("topics");
    expect(failed.transitionSeq).toBeNull();
  });

  test("stop-without-terminal: after-transition stop is an `edges`-kept failure", async () => {
    const sessionDbId = seedSession(db, "content-stop-after-transition");
    enqueueWindow(db, sessionDbId);
    const clock = createClock();
    const scheduler = createNoteSettlementScheduler({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: clock.now,
      nowMs: clock.nowMs,
      // The run's own `finalize` succeeded, then it stopped without `commit`.
      stage1Dispatch: async ({ job }) => {
        transitionNoteSettlementJobToEdges(db, job.id, job.claimGeneration, clock.now());
        return {
          ok: false,
          reason: "stage edges: stopped without commit (job status: claimed)",
          failureClass: "deterministic",
        };
      },
    });

    const dispatched = await scheduler.drainSession(sessionDbId);

    const failed = getNoteSettlementJob(db, dispatched[0]!.id)!;
    expect(failed.status).toBe("failed");
    expect(failed.stage).toBe("edges");
    // The stage is KEPT: the earlier transition still stands.
    expect(failed.transitionSeq).toBe(1);
  });
});

describe("staged settlement: recovery resumes by stage", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  test("a job reclaimed on `edges` re-runs the resume dispatch only, and the reclaim still spends an attempt", async () => {
    const sessionDbId = seedSession(db, "content-resume-edges");
    enqueueWindow(db, sessionDbId);
    const clock = createClock();
    // The first claim dies between the transition and the terminal commit —
    // the kill this whole stage column exists for.
    const first = claimNextNoteSettlementJob(
      db,
      sessionDbId,
      clock.now(),
      clock.nowMs(),
    )!;
    transitionNoteSettlementJobToEdges(
      db,
      first.id,
      first.claimGeneration,
      clock.now(),
    );
    clock.advance(NOTE_SETTLEMENT_LEASE_MS + 1_000);

    const stage1 = recordStage();
    // The RESUME dispatch's own commit is what marks the row `done` — a bare
    // recorder's `ok: true` is no longer trusted once the row is `edges`
    // (this describe block's whole subject).
    const resume = recordStage(async (job) => {
      completeNoteSettlementJob(db, job.id, clock.now(), job.claimGeneration);
      return { ok: true };
    });
    const scheduler = createNoteSettlementScheduler({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: clock.now,
      nowMs: clock.nowMs,
      stage1Dispatch: stage1.dispatch,
      dispatch: resume.dispatch,
    });
    await scheduler.drainSession(sessionDbId);

    // Finished judgment work is never resent.
    expect(stage1.calls).toHaveLength(0);
    expect(resume.calls).toHaveLength(1);
    expect(resume.calls[0]!.stage).toBe("edges");
    const settled = getNoteSettlementJob(db, first.id)!;
    expect(settled.status).toBe("done");
    // Standing reclaim law: a reclaim IS a new claim, and it costs an attempt.
    expect(settled.attempts).toBe(2);
    expect(settled.claimGeneration).toBeGreaterThan(first.claimGeneration);
    // The transition itself is not re-taken.
    expect(settled.transitionSeq).toBe(1);
  });

  test("a job reclaimed on `topics` re-runs the unified dispatch, one call settling the window", async () => {
    const sessionDbId = seedSession(db, "content-resume-topics");
    enqueueWindow(db, sessionDbId);
    const clock = createClock();
    const first = claimNextNoteSettlementJob(
      db,
      sessionDbId,
      clock.now(),
      clock.nowMs(),
    )!;
    expect(first.stage).toBe("topics");
    clock.advance(NOTE_SETTLEMENT_LEASE_MS + 1_000);

    const unified = recordStage(async (job) => {
      transitionNoteSettlementJobToEdges(db, job.id, job.claimGeneration, clock.now());
      completeNoteSettlementJob(db, job.id, clock.now(), job.claimGeneration);
      return { ok: true };
    });
    const resume = recordStage();
    const scheduler = createNoteSettlementScheduler({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: clock.now,
      nowMs: clock.nowMs,
      stage1Dispatch: unified.dispatch,
      dispatch: resume.dispatch,
    });
    await scheduler.drainSession(sessionDbId);

    expect(unified.calls).toHaveLength(1);
    expect(unified.calls[0]!.stage).toBe("topics");
    expect(resume.calls).toHaveLength(0);
    const settled = getNoteSettlementJob(db, first.id)!;
    expect(settled.status).toBe("done");
    expect(settled.attempts).toBe(2);
  });

  test("the stop hook reads the full tuple: a stage-1 context is let through once the row has transitioned", async () => {
    const sessionDbId = seedSession(db, "content-stop-hook-stage");
    enqueueWindow(db, sessionDbId);
    const clock = createClock();
    const claimed = claimNextNoteSettlementJob(
      db,
      sessionDbId,
      clock.now(),
      clock.nowMs(),
    )!;
    const stageOneHook = createSettlementStopHook({
      db,
      jobId: claimed.id,
      claimGeneration: claimed.claimGeneration,
      stage: "topics",
    });
    const stageTwoHook = createSettlementStopHook({
      db,
      jobId: claimed.id,
      claimGeneration: claimed.claimGeneration,
      stage: "edges",
    });

    // Before the transition: the stage-1 context owns the open window.
    expect((await stageOneHook()).decision).toBe("block");
    expect((await stageTwoHook()).decision).toBeUndefined();

    transitionNoteSettlementJobToEdges(
      db,
      claimed.id,
      claimed.claimGeneration,
      clock.now(),
    );

    // After it, the roles swap — under an UNCHANGED generation, which is
    // exactly what the generation fence alone cannot see.
    expect((await stageOneHook()).decision).toBeUndefined();
    expect((await stageTwoHook()).decision).toBe("block");
  });
});

describe("staged settlement: the retry law is unchanged", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  // Spec Rev 5, §Testing decisions, retry path: "kill between transition and
  // commit ⇒ failure recorded with stage `edges` and the diagnosis in
  // `last_error`; the next claim runs a NEW generation, `queryImpl` called
  // once, edges-shaped". Attempt 1 is the unified dispatch transitioning and
  // then failing (still `claimed` at `edges` is ALWAYS a failure now — no
  // chain, no exception); attempt 2 is a fresh generation, claimed straight
  // onto `edges`, resolved by the resume dispatch alone.
  test("deterministic 1+1=2 through the staged path: abandonment plus a debt row, one dispatch call per attempt", async () => {
    const sessionDbId = seedSession(db, "content-retry-deterministic");
    const enqueued = enqueueWindow(db, sessionDbId);
    const clock = createClock();
    const unified = recordStage(async (job) => {
      transitionNoteSettlementJobToEdges(db, job.id, job.claimGeneration, clock.now());
      return {
        ok: false,
        reason: "stage edges: stopped without commit",
        failureClass: "deterministic",
      };
    });
    const resume = recordStage(async () => ({
      ok: false,
      reason: "stage edges: stopped without commit (second attempt)",
      failureClass: "deterministic",
    }));
    const scheduler = createNoteSettlementScheduler({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: clock.now,
      nowMs: clock.nowMs,
      stage1Dispatch: unified.dispatch,
      dispatch: resume.dispatch,
    });

    await scheduler.drainSession(sessionDbId);
    const afterFirst = getNoteSettlementJob(db, enqueued.id)!;
    expect(afterFirst.status).toBe("failed");
    expect(afterFirst.stage).toBe("edges");
    expect(afterFirst.attempts).toBe(1);
    expect(listNoteSettlementDebts(db)).toHaveLength(0);

    // The backoff elapses and the job comes back for its ONE retry, a NEW
    // generation claimed straight onto `edges`.
    clock.advance(NOTE_SETTLEMENT_RETRY_BASE_MS + 1_000);
    await scheduler.drainSession(sessionDbId);
    const afterSecond = getNoteSettlementJob(db, enqueued.id)!;

    expect(NOTE_SETTLEMENT_MAX_ATTEMPTS).toBe(2);
    expect(afterSecond.attempts).toBe(2);
    expect(afterSecond.status).toBe("abandoned");
    expect(listNoteSettlementDebts(db, sessionDbId)).toHaveLength(1);
    // The unified dispatch ran exactly once (attempt 1, transitioning); the
    // retry is the resume dispatch alone, also exactly once.
    expect(unified.calls).toHaveLength(1);
    expect(resume.calls).toHaveLength(1);
    expect(resume.calls[0]!.stage).toBe("edges");
    expect(resume.calls[0]!.claimGeneration).toBeGreaterThan(
      unified.calls[0]!.claimGeneration,
    );
  });

  test("a transient failure refunds its attempt, uncapped, through the staged path", async () => {
    const sessionDbId = seedSession(db, "content-retry-transient");
    const enqueued = enqueueWindow(db, sessionDbId);
    const clock = createClock();
    // The FIRST claim's own unified dispatch transitions and then fails
    // transiently within its one call; a transient failure sets the row back
    // to `pending` (not `claimed`), so every SUBSEQUENT claim starts fresh —
    // but the `stage` column, untouched by a failure, stays `edges`, so from
    // the second claim on the scheduler routes straight to the resume
    // dispatch and stage 1's finished work is never resent.
    const unified = recordStage(async (job) => {
      transitionNoteSettlementJobToEdges(db, job.id, job.claimGeneration, clock.now());
      return { ok: false, reason: "SQLITE_BUSY", failureClass: "transient" };
    });
    const resume = recordStage(async () => ({
      ok: false,
      reason: "SQLITE_BUSY",
      failureClass: "transient",
    }));
    const scheduler = createNoteSettlementScheduler({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: clock.now,
      nowMs: clock.nowMs,
      stage1Dispatch: unified.dispatch,
      dispatch: resume.dispatch,
    });

    // Five transient failures — well past the deterministic cap of two.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await scheduler.drainSession(sessionDbId);
    }

    const job = getNoteSettlementJob(db, enqueued.id)!;
    expect(job.attempts).toBe(0);
    expect(job.status).toBe("pending");
    expect(job.failureClass).toBe("transient");
    expect(listNoteSettlementDebts(db)).toHaveLength(0);
    // Still only one transition, and the job stays parked on `edges`.
    expect(job.stage).toBe("edges");
    expect(job.transitionSeq).toBe(1);
    expect(unified.calls).toHaveLength(1);
    expect(resume.calls).toHaveLength(4);
  });
});

describe("staged settlement: behaviour equivalence under the stub stage 1", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  test("with a settling stage-1 payload, an ordinary window settles in one dispatch call, as it did before staging", async () => {
    const sessionDbId = seedSession(db, "content-equivalence");
    const enqueued = enqueueWindow(db, sessionDbId);
    const clock = createClock();
    // NAMED here (final review, re-ruling 10, updated by ticket 04): a test
    // instrument standing in for the unified run — it transitions AND
    // commits within its own one call, which is what a real run does.
    const unified = recordStage(async (job) => {
      transitionNoteSettlementJobToEdges(db, job.id, job.claimGeneration, clock.now());
      completeNoteSettlementJob(db, job.id, clock.now(), job.claimGeneration);
      return { ok: true };
    });
    const scheduler = createNoteSettlementScheduler({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: clock.now,
      nowMs: clock.nowMs,
      stage1Dispatch: unified.dispatch,
    });

    const dispatched = await scheduler.drainSession(sessionDbId);

    // The payload is called ONCE, with the same window, on one attempt — the
    // pre-staging contract, verbatim.
    expect(dispatched).toHaveLength(1);
    expect(unified.calls).toHaveLength(1);
    expect(unified.calls[0]!.windowStart).toBe(enqueued.windowStart);
    expect(unified.calls[0]!.windowEnd).toBe(enqueued.windowEnd);
    const settled = getNoteSettlementJob(db, enqueued.id)!;
    expect(settled.status).toBe("done");
    expect(settled.attempts).toBe(1);
    expect(getNoteSettlementCursor(db, sessionDbId)).toBe(enqueued.windowEnd);
    // The only NEW observable fact about the row.
    expect(settled.stage).toBe("edges");
    expect(settled.transitionSeq).toBe(1);
    expect(settled.stage1Metrics).toBe("{}");
  });

  // FINAL REVIEW, RE-RULING 10: the production default retires. The transition
  // -only fallback wrote zero snapshots, so stage 2 read an empty worklist, an
  // empty writable set and no debts, and committed the window on that basis —
  // a settled record of a judgment nobody made. A worker with no stage-1
  // payload now fails the dispatch instead, before the row is touched.
  test("with NO stage 1 mounted, the window fails deterministically and nothing transitions", async () => {
    const sessionDbId = seedSession(db, "content-missing-stage-1");
    const enqueued = enqueueWindow(db, sessionDbId);
    const clock = createClock();
    const stage2 = recordStage();
    const scheduler = createNoteSettlementScheduler({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: clock.now,
      nowMs: clock.nowMs,
      dispatch: stage2.dispatch,
    });

    await scheduler.drainSession(sessionDbId);

    // Stage 2 never ran: there was no transition to chain into.
    expect(stage2.calls).toHaveLength(0);
    const job = getNoteSettlementJob(db, enqueued.id)!;
    expect(job.status).not.toBe("done");
    expect(job.stage).toBe("topics");
    expect(job.transitionSeq).toBeNull();
    expect(job.failureClass).toBe("deterministic");
    expect(job.lastError).toContain("requires a stage-1 dispatch");
    expect(getNoteSettlementCursor(db, sessionDbId)).toBe(0);
  });
});
