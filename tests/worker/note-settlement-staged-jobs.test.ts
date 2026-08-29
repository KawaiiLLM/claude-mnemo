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
  createTransitionOnlyStageOneDispatch,
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
 * ownership + §Retry law), proved at the job-table and scheduler seams.
 *
 * Stage 1 is a STUB in this release — it writes the transition and nothing
 * else — and the settlement run that has always settled a window is mounted as
 * stage 2. So every assertion here is about the MACHINE: who owns the row,
 * what the transition writes and refuses, how the scheduler tells a transition
 * from a completion and from a failure, and where a reclaimant resumes. The
 * behaviour-equivalence claim is the last test in the file, plus the rest of
 * the settlement suite staying green.
 */

const CLOCK_START_MS = 1_700_000_000_000;

/**
 * FINAL REVIEW, RE-RULING 10: the scheduler's own stage-1 default is a
 * DETERMINISTIC FAILURE now — a worker that mounted no topic pass cannot
 * settle a window, and the transition-only fallback that used to stand there
 * published a run that was neither the old monolith nor a staged one. The
 * helper itself survives for exactly this: a test proving a SCHEDULER
 * property (chaining, the post-hoc truth rule, attempt accounting, resume)
 * needs a stage 1 whose verdict it can dictate, and now says so at the call
 * site instead of inheriting it from a silence.
 */
function schedulerWithStubStageOne(
  deps: Parameters<typeof createNoteSettlementScheduler>[0],
): ReturnType<typeof createNoteSettlementScheduler> {
  return createNoteSettlementScheduler({
    stage1Dispatch: createTransitionOnlyStageOneDispatch(
      deps.db,
      deps.now ?? (() => Math.floor(Date.now() / 1000)),
    ),
    ...deps,
  });
}

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

describe("staged settlement: the scheduler's transition verdict", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  test("a stage-1 transition verdict launches stage 2 in the same drain, spending no attempt", async () => {
    const sessionDbId = seedSession(db, "content-same-drain");
    enqueueWindow(db, sessionDbId);
    const clock = createClock();
    const stage1 = recordStage();
    const stage2 = recordStage();
    const scheduler = schedulerWithStubStageOne({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: clock.now,
      nowMs: clock.nowMs,
      // The default stub stage 1 does the transition; wrap it so the call is
      // observable while its behaviour stays the production one.
      stage1Dispatch: async (input) => {
        stage1.calls.push(input.job);
        transitionNoteSettlementJobToEdges(
          db,
          input.job.id,
          input.job.claimGeneration,
          clock.now(),
        );
        return { ok: true, transition: "edges" };
      },
      dispatch: stage2.dispatch,
    });

    const dispatched = await scheduler.drainSession(sessionDbId);

    // ONE claim, TWO stages, in one pass.
    expect(dispatched).toHaveLength(1);
    expect(stage1.calls).toHaveLength(1);
    expect(stage1.calls[0]!.stage).toBe("topics");
    expect(stage2.calls).toHaveLength(1);
    expect(stage2.calls[0]!.stage).toBe("edges");
    // Same claim throughout: one generation, one attempt.
    expect(stage2.calls[0]!.claimGeneration).toBe(stage1.calls[0]!.claimGeneration);
    const settled = getNoteSettlementJob(db, dispatched[0]!.id)!;
    expect(settled.attempts).toBe(1);
    expect(settled.status).toBe("done");
    expect(settled.stage).toBe("edges");
    // No failure was recorded anywhere along the way.
    expect(settled.lastError).toBeNull();
    expect(settled.failureClass).toBeNull();
    expect(listNoteSettlementDebts(db)).toHaveLength(0);
  });

  test("post-hoc truth rule: a transition that landed survives its dispatch THROWING", async () => {
    const sessionDbId = seedSession(db, "content-lost-verdict-throw");
    enqueueWindow(db, sessionDbId);
    const clock = createClock();
    const stage2 = recordStage();
    const scheduler = schedulerWithStubStageOne({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: clock.now,
      nowMs: clock.nowMs,
      stage1Dispatch: async ({ job }) => {
        transitionNoteSettlementJobToEdges(
          db,
          job.id,
          job.claimGeneration,
          clock.now(),
        );
        // The verdict is LOST — a crash, a killed subprocess, a bug in the
        // dispatch layer. The row already says what happened.
        throw new Error("stage 1 died after its transition committed");
      },
      dispatch: stage2.dispatch,
    });

    const dispatched = await scheduler.drainSession(sessionDbId);

    expect(stage2.calls).toHaveLength(1);
    expect(stage2.calls[0]!.stage).toBe("edges");
    const settled = getNoteSettlementJob(db, dispatched[0]!.id)!;
    expect(settled.status).toBe("done");
    // The thrown failure is DISCARDED: no accounting of any kind.
    expect(settled.attempts).toBe(1);
    expect(settled.lastError).toBeNull();
    expect(settled.failureClass).toBeNull();
    expect(listNoteSettlementDebts(db)).toHaveLength(0);
  });

  test("post-hoc truth rule: a transition that landed survives its dispatch REPORTING A FAILURE", async () => {
    const sessionDbId = seedSession(db, "content-lost-verdict-failure");
    enqueueWindow(db, sessionDbId);
    const clock = createClock();
    const stage2 = recordStage();
    const scheduler = schedulerWithStubStageOne({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: clock.now,
      nowMs: clock.nowMs,
      stage1Dispatch: async ({ job }) => {
        transitionNoteSettlementJobToEdges(
          db,
          job.id,
          job.claimGeneration,
          clock.now(),
        );
        return {
          ok: false,
          reason: "stage 1 reported a failure it had already superseded",
          failureClass: "deterministic",
        };
      },
      dispatch: stage2.dispatch,
    });

    const dispatched = await scheduler.drainSession(sessionDbId);

    expect(stage2.calls).toHaveLength(1);
    const settled = getNoteSettlementJob(db, dispatched[0]!.id)!;
    expect(settled.status).toBe("done");
    expect(settled.attempts).toBe(1);
    expect(settled.lastError).toBeNull();
  });

  test("a stage-1 failure with NO transition is handled as reported: stage 2 never runs", async () => {
    const sessionDbId = seedSession(db, "content-stage1-failure");
    enqueueWindow(db, sessionDbId);
    const clock = createClock();
    const stage2 = recordStage();
    const scheduler = schedulerWithStubStageOne({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: clock.now,
      nowMs: clock.nowMs,
      stage1Dispatch: async () => ({
        ok: false,
        reason: "stage 1 could not draft the window's topic lines",
        failureClass: "deterministic",
      }),
      dispatch: stage2.dispatch,
    });

    const dispatched = await scheduler.drainSession(sessionDbId);

    expect(stage2.calls).toHaveLength(0);
    const failed = getNoteSettlementJob(db, dispatched[0]!.id)!;
    expect(failed.status).toBe("failed");
    expect(failed.stage).toBe("topics");
    expect(failed.attempts).toBe(1);
    expect(failed.failureClass).toBe("deterministic");
  });

  test("a transition verdict the row never took is a deterministic failure, not a chain", async () => {
    const sessionDbId = seedSession(db, "content-lying-verdict");
    enqueueWindow(db, sessionDbId);
    const clock = createClock();
    const stage2 = recordStage();
    const scheduler = schedulerWithStubStageOne({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: clock.now,
      nowMs: clock.nowMs,
      // Claims the transition without writing it.
      stage1Dispatch: async () => ({ ok: true, transition: "edges" }),
      dispatch: stage2.dispatch,
    });

    const dispatched = await scheduler.drainSession(sessionDbId);

    expect(stage2.calls).toHaveLength(0);
    const failed = getNoteSettlementJob(db, dispatched[0]!.id)!;
    // Emphatically NOT `done`: a verdict is never allowed to settle a window
    // the row does not agree was settled.
    expect(failed.status).toBe("failed");
    expect(failed.stage).toBe("topics");
    expect(failed.failureClass).toBe("deterministic");
    expect(failed.lastError).toContain("never landed");
  });

  // FINAL REVIEW, FINDING 4: the other half of the same law. A phantom
  // transition was already a failure; a topics dispatch reporting PLAIN
  // success — no `transition` field at all — fell straight through to the
  // completion branch and marked the job `done`, walking the cursor over a
  // window stage 2 never ran. A topics dispatch has exactly two legal
  // outcomes, and "I finished" is not one of them: its only finish IS the
  // transition, and the row is what says whether that landed.
  test("plain success on the topics stage is a deterministic failure, never a completion", async () => {
    const sessionDbId = seedSession(db, "content-plain-success");
    enqueueWindow(db, sessionDbId);
    const clock = createClock();
    const stage2 = recordStage();
    const scheduler = createNoteSettlementScheduler({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: clock.now,
      nowMs: clock.nowMs,
      // Reports success, transitions nothing, claims nothing.
      stage1Dispatch: async () => ({ ok: true }),
      dispatch: stage2.dispatch,
    });

    const dispatched = await scheduler.drainSession(sessionDbId);

    expect(stage2.calls).toHaveLength(0);
    const failed = getNoteSettlementJob(db, dispatched[0]!.id)!;
    expect(failed.status).not.toBe("done");
    expect(failed.stage).toBe("topics");
    expect(failed.failureClass).toBe("deterministic");
    expect(failed.lastError).toContain("may only transition or fail");
    expect(getNoteSettlementCursor(db, sessionDbId)).toBe(0);
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

  test("a job reclaimed on `edges` re-runs stage 2 only, and the reclaim still spends an attempt", async () => {
    const sessionDbId = seedSession(db, "content-resume-edges");
    enqueueWindow(db, sessionDbId);
    const clock = createClock();
    // The first claim dies between the transition and stage 2 — the kill this
    // whole stage column exists for.
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
    const stage2 = recordStage();
    const scheduler = schedulerWithStubStageOne({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: clock.now,
      nowMs: clock.nowMs,
      stage1Dispatch: stage1.dispatch,
      dispatch: stage2.dispatch,
    });
    await scheduler.drainSession(sessionDbId);

    // Finished judgment work is never resent.
    expect(stage1.calls).toHaveLength(0);
    expect(stage2.calls).toHaveLength(1);
    expect(stage2.calls[0]!.stage).toBe("edges");
    const settled = getNoteSettlementJob(db, first.id)!;
    expect(settled.status).toBe("done");
    // Standing reclaim law: a reclaim IS a new claim, and it costs an attempt.
    expect(settled.attempts).toBe(2);
    expect(settled.claimGeneration).toBeGreaterThan(first.claimGeneration);
    // The transition itself is not re-taken.
    expect(settled.transitionSeq).toBe(1);
  });

  test("a job reclaimed on `topics` re-runs stage 1", async () => {
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

    const stage1 = recordStage(async (job) => {
      transitionNoteSettlementJobToEdges(db, job.id, job.claimGeneration, clock.now());
      return { ok: true, transition: "edges" };
    });
    const stage2 = recordStage();
    const scheduler = schedulerWithStubStageOne({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: clock.now,
      nowMs: clock.nowMs,
      stage1Dispatch: stage1.dispatch,
      dispatch: stage2.dispatch,
    });
    await scheduler.drainSession(sessionDbId);

    expect(stage1.calls).toHaveLength(1);
    expect(stage1.calls[0]!.stage).toBe("topics");
    expect(stage2.calls).toHaveLength(1);
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

  test("deterministic 1+1=2 through the staged path: abandonment plus a debt row, stage 1 run once", async () => {
    const sessionDbId = seedSession(db, "content-retry-deterministic");
    const enqueued = enqueueWindow(db, sessionDbId);
    const clock = createClock();
    const stage1 = recordStage(async (job) => {
      transitionNoteSettlementJobToEdges(db, job.id, job.claimGeneration, clock.now());
      return { ok: true, transition: "edges" };
    });
    const stage2 = recordStage(async () => ({
      ok: false,
      reason: "stage 2 could not write the window's edges",
      failureClass: "deterministic",
    }));
    const scheduler = schedulerWithStubStageOne({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: clock.now,
      nowMs: clock.nowMs,
      stage1Dispatch: stage1.dispatch,
      dispatch: stage2.dispatch,
    });

    await scheduler.drainSession(sessionDbId);
    const afterFirst = getNoteSettlementJob(db, enqueued.id)!;
    expect(afterFirst.status).toBe("failed");
    expect(afterFirst.attempts).toBe(1);
    expect(listNoteSettlementDebts(db)).toHaveLength(0);

    // The backoff elapses and the job comes back for its ONE retry.
    clock.advance(NOTE_SETTLEMENT_RETRY_BASE_MS + 1_000);
    await scheduler.drainSession(sessionDbId);
    const afterSecond = getNoteSettlementJob(db, enqueued.id)!;

    expect(NOTE_SETTLEMENT_MAX_ATTEMPTS).toBe(2);
    expect(afterSecond.attempts).toBe(2);
    expect(afterSecond.status).toBe("abandoned");
    expect(listNoteSettlementDebts(db, sessionDbId)).toHaveLength(1);
    // Attempts are JOB-level; the stage only decides the resume point, so the
    // retry re-ran stage 2 alone and stage 1's finished work was never resent.
    expect(stage1.calls).toHaveLength(1);
    expect(stage2.calls).toHaveLength(2);
  });

  test("a transient failure refunds its attempt, uncapped, through the staged path", async () => {
    const sessionDbId = seedSession(db, "content-retry-transient");
    const enqueued = enqueueWindow(db, sessionDbId);
    const clock = createClock();
    const stage1 = recordStage(async (job) => {
      transitionNoteSettlementJobToEdges(db, job.id, job.claimGeneration, clock.now());
      return { ok: true, transition: "edges" };
    });
    const stage2 = recordStage(async () => ({
      ok: false,
      reason: "SQLITE_BUSY",
      failureClass: "transient",
    }));
    const scheduler = schedulerWithStubStageOne({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: clock.now,
      nowMs: clock.nowMs,
      stage1Dispatch: stage1.dispatch,
      dispatch: stage2.dispatch,
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
    expect(stage2.calls).toHaveLength(5);
    // Still only one transition, and the job stays parked on stage 2.
    expect(job.stage).toBe("edges");
    expect(job.transitionSeq).toBe(1);
    expect(stage1.calls).toHaveLength(1);
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

  test("with the DEFAULT stage 1, an ordinary window settles exactly as it did before staging", async () => {
    const sessionDbId = seedSession(db, "content-equivalence");
    const enqueued = enqueueWindow(db, sessionDbId);
    const clock = createClock();
    const stage2 = recordStage();
    const scheduler = schedulerWithStubStageOne({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: clock.now,
      nowMs: clock.nowMs,
      // The stub stage 1 is NAMED here (final review, re-ruling 10): it is a
      // test instrument, and this test asks what a window looks like when
      // stage 1 does nothing but transition — not what the production default
      // does, which is fail (see the test below).
      dispatch: stage2.dispatch,
    });

    const dispatched = await scheduler.drainSession(sessionDbId);

    // The payload is called ONCE, with the same window, on one attempt — the
    // pre-staging contract, verbatim.
    expect(dispatched).toHaveLength(1);
    expect(stage2.calls).toHaveLength(1);
    expect(stage2.calls[0]!.windowStart).toBe(enqueued.windowStart);
    expect(stage2.calls[0]!.windowEnd).toBe(enqueued.windowEnd);
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
