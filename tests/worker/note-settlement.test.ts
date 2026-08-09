import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { listNoteDebt } from "../../src/db/note-debt";
import {
  NOTE_SETTLEMENT_CONSECUTIVE_TURNS,
  NOTE_SETTLEMENT_LEASE_MS,
  NOTE_SETTLEMENT_MAX_ATTEMPTS,
  NOTE_SETTLEMENT_MIN_WINDOW_TURNS,
  NOTE_SETTLEMENT_RETRY_BASE_MS,
  advanceNoteSettlementCursor,
  claimNextNoteSettlementJob,
  completeNoteSettlementJob,
  countNoteSettlementJobs,
  enqueueNoteSettlementWindows,
  failNoteSettlementJob,
  getNoteSettlementCursor,
  getNoteSettlementJob,
  listNoteSettlementJobs,
  type NoteSettlementJob,
} from "../../src/db/note-settlement";
import {
  createNoteSettlementScheduler,
  type NoteSettlementDispatch,
} from "../../src/worker/note-settlement";
import { DEFAULT_CONFIG } from "../../src/shared/config";
import { SETTLEMENT_ENABLED_CONFIG } from "../support/settlement-config";

const DAY_SECONDS = 24 * 60 * 60;

function seedSession(
  db: Database,
  contentSessionId: string,
  updatedAtEpoch = 1_000,
): number {
  return upsertSession(db, {
    contentSessionId,
    project: "/tmp/project-note-settlement",
    title: null,
    content: null,
    insight: null,
    createdAtEpoch: 1,
    updatedAtEpoch,
    completedAtEpoch: null,
  }).id;
}

type DebtSeed = "noted" | "pending" | "trivial";

/**
 * Seed turns [from, from+count) and, unless they are trivial, a debt row for
 * each. Turn `status` is deliberately left at the legacy default: settlement
 * reads the note-debt ledger, never `turns.status` (P1 shadow isolation).
 */
function seedTurns(
  db: Database,
  sessionDbId: number,
  from: number,
  count: number,
  debt: DebtSeed = "noted",
  createdAtEpoch = 1_000,
): void {
  for (let promptNumber = from; promptNumber < from + count; promptNumber += 1) {
    const turnId = db
      .query<{ id: number }, [number, number, number]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, user_prompt,
           assistant_response, created_at_epoch
         ) VALUES (?, ?, 'active', 'prompt', 'reply', ?)
         RETURNING id`,
      )
      .get(sessionDbId, promptNumber, createdAtEpoch)!.id;
    if (debt === "trivial") {
      continue;
    }
    db.query<unknown, [number, number, number, string, number, number]>(
      `INSERT INTO note_debt (
         turn_id, session_id, prompt_number, status,
         opened_at_epoch, updated_at_epoch
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      turnId,
      sessionDbId,
      promptNumber,
      debt === "noted" ? "noted" : "pending",
      createdAtEpoch,
      createdAtEpoch,
    );
  }
  classifyThrough(db, sessionDbId, from + count - 1);
}

function classifyThrough(
  db: Database,
  sessionDbId: number,
  promptNumber: number,
): void {
  db.query<unknown, [number, number, number]>(
    `INSERT INTO note_debt_cursor (
       session_id, last_classified_prompt_number, updated_at_epoch
     ) VALUES (?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       last_classified_prompt_number = MAX(
         note_debt_cursor.last_classified_prompt_number, excluded.last_classified_prompt_number
       ),
       updated_at_epoch = excluded.updated_at_epoch`,
  ).run(sessionDbId, promptNumber, promptNumber);
}

function closeDebt(db: Database, sessionDbId: number, promptNumber: number): void {
  db.query<unknown, [number, number]>(
    `UPDATE note_debt SET status = 'noted', closed_at_epoch = 1000
     WHERE session_id = ? AND prompt_number = ?`,
  ).run(sessionDbId, promptNumber);
}

/** A fake clock the whole scheduler shares: epoch seconds derived from ms. */
function createClock(startMs = 1_700_000_000_000) {
  let ms = startMs;
  return {
    nowMs: () => ms,
    now: () => Math.floor(ms / 1000),
    advance(byMs: number) {
      ms += byMs;
    },
    set(atMs: number) {
      ms = atMs;
    },
  };
}

interface RecordingDispatch {
  dispatch: NoteSettlementDispatch;
  calls: NoteSettlementJob[];
}

function recordingDispatch(
  outcome: (job: NoteSettlementJob) => Promise<{ ok: true } | { ok: false; reason: string }> = async () => ({
    ok: true,
  }),
): RecordingDispatch {
  const calls: NoteSettlementJob[] = [];
  return {
    calls,
    dispatch: async ({ job }) => {
      calls.push(job);
      return outcome(job);
    },
  };
}

describe("note settlement triggers", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  test("fires at exactly 50 consecutive decided turns, not before", async () => {
    const sessionDbId = seedSession(db, "content-consecutive");
    const clock = createClock();
    const { dispatch, calls } = recordingDispatch();
    const scheduler = createNoteSettlementScheduler({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: clock.now,
      nowMs: clock.nowMs,
      dispatch,
    });

    seedTurns(db, sessionDbId, 1, NOTE_SETTLEMENT_CONSECUTIVE_TURNS - 1);
    const short = await scheduler.onTurnStop(sessionDbId);

    expect(short.triggered).toBe(false);
    expect(calls).toHaveLength(0);
    // Below the threshold the trigger is a pure read: nothing durable at all.
    expect(countNoteSettlementJobs(db)).toBe(0);
    expect(getNoteSettlementCursor(db, sessionDbId)).toBe(0);

    seedTurns(db, sessionDbId, NOTE_SETTLEMENT_CONSECUTIVE_TURNS, 1);
    const full = await scheduler.onTurnStop(sessionDbId);

    expect(full.triggered).toBe(true);
    expect(full.created).toHaveLength(1);
    expect(full.created[0]!.windowStart).toBe(1);
    expect(full.created[0]!.windowEnd).toBe(NOTE_SETTLEMENT_CONSECUTIVE_TURNS);
    expect(full.created[0]!.triggerType).toBe("consecutive");
    expect(calls).toHaveLength(1);
    expect(getNoteSettlementCursor(db, sessionDbId)).toBe(
      NOTE_SETTLEMENT_CONSECUTIVE_TURNS,
    );
  });

  test("a still-pending debt inside the prefix holds the whole window back", async () => {
    const sessionDbId = seedSession(db, "content-pending-hole");
    const clock = createClock();
    const { dispatch, calls } = recordingDispatch();
    const scheduler = createNoteSettlementScheduler({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: clock.now,
      nowMs: clock.nowMs,
      dispatch,
    });

    seedTurns(db, sessionDbId, 1, 9);
    seedTurns(db, sessionDbId, 10, 1, "pending");
    seedTurns(db, sessionDbId, 11, 60);

    expect((await scheduler.onTurnStop(sessionDbId)).triggered).toBe(false);
    expect(countNoteSettlementJobs(db)).toBe(0);

    closeDebt(db, sessionDbId, 10);
    const after = await scheduler.onTurnStop(sessionDbId);

    expect(after.created).toHaveLength(1);
    expect(after.created[0]!.windowEnd).toBe(NOTE_SETTLEMENT_CONSECUTIVE_TURNS);
    expect(calls).toHaveLength(1);
  });

  test("trivial turns count as decided — they never owed a note", async () => {
    const sessionDbId = seedSession(db, "content-trivial");
    const clock = createClock();
    const { dispatch } = recordingDispatch();
    const scheduler = createNoteSettlementScheduler({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: clock.now,
      nowMs: clock.nowMs,
      dispatch,
    });

    seedTurns(db, sessionDbId, 1, 25);
    seedTurns(db, sessionDbId, 26, 25, "trivial");

    const pass = await scheduler.onTurnStop(sessionDbId);
    expect(pass.created).toHaveLength(1);
    expect(pass.created[0]!.windowEnd).toBe(50);
  });

  test("compact under the minimum window writes nothing and keeps accumulating", async () => {
    const sessionDbId = seedSession(db, "content-min-window");
    const clock = createClock();
    const { dispatch, calls } = recordingDispatch();
    const scheduler = createNoteSettlementScheduler({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: clock.now,
      nowMs: clock.nowMs,
      dispatch,
    });

    seedTurns(db, sessionDbId, 1, NOTE_SETTLEMENT_MIN_WINDOW_TURNS - 5);
    const firstCompact = await scheduler.onCompact(sessionDbId);

    // A compact IS a trigger event, but its own window is floored.
    expect(firstCompact.triggered).toBe(true);
    expect(firstCompact.created).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(countNoteSettlementJobs(db)).toBe(0);
    expect(getNoteSettlementCursor(db, sessionDbId)).toBe(0);

    // Time passes and a second compact lands one turn short — still nothing.
    clock.advance(60 * 60 * 1000);
    seedTurns(db, sessionDbId, NOTE_SETTLEMENT_MIN_WINDOW_TURNS - 4, 4);
    expect((await scheduler.onCompact(sessionDbId)).created).toHaveLength(0);
    expect(countNoteSettlementJobs(db)).toBe(0);

    // The turns were not lost: the next compact settles the ACCUMULATED window
    // from turn 1, not just the turns that arrived since the last compact.
    clock.advance(60 * 60 * 1000);
    seedTurns(db, sessionDbId, NOTE_SETTLEMENT_MIN_WINDOW_TURNS, 1);
    const third = await scheduler.onCompact(sessionDbId);

    expect(third.created).toHaveLength(1);
    expect(third.created[0]!.triggerType).toBe("compact");
    expect(third.created[0]!.windowStart).toBe(1);
    expect(third.created[0]!.windowEnd).toBe(NOTE_SETTLEMENT_MIN_WINDOW_TURNS);
    expect(calls).toHaveLength(1);
  });

  test("the graceful-exit window records jobs and dispatches nothing", async () => {
    const sessionDbId = seedSession(db, "content-graceful-exit");
    const clock = createClock();
    const { dispatch, calls } = recordingDispatch();
    let exiting = true;
    const scheduler = createNoteSettlementScheduler({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: clock.now,
      nowMs: clock.nowMs,
      dispatch,
      isGracefulExit: () => exiting,
    });

    seedTurns(db, sessionDbId, 1, NOTE_SETTLEMENT_CONSECUTIVE_TURNS);
    const during = await scheduler.onTurnStop(sessionDbId);

    expect(during.created).toHaveLength(1);
    expect(during.dispatched).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(listNoteSettlementJobs(db, sessionDbId)[0]!.status).toBe("pending");

    // The recorded job is picked up by the next ordinary trigger.
    exiting = false;
    seedTurns(db, sessionDbId, NOTE_SETTLEMENT_CONSECUTIVE_TURNS + 1, 50);
    const after = await scheduler.onTurnStop(sessionDbId);

    expect(calls).toHaveLength(2);
    expect(after.dispatched.map((job) => job.windowStart)).toEqual([1, 51]);
  });

  test("settlementEnabled=false leaves no write anywhere", async () => {
    const sessionDbId = seedSession(db, "content-disabled");
    const clock = createClock();
    const { dispatch, calls } = recordingDispatch();
    const scheduler = createNoteSettlementScheduler({
      db,
      config: DEFAULT_CONFIG,
      now: clock.now,
      nowMs: clock.nowMs,
      dispatch,
    });

    seedTurns(db, sessionDbId, 1, 120);
    const debtBefore = listNoteDebt(db, sessionDbId);

    expect((await scheduler.onTurnStop(sessionDbId)).triggered).toBe(false);
    expect((await scheduler.onCompact(sessionDbId)).triggered).toBe(false);

    expect(calls).toHaveLength(0);
    expect(countNoteSettlementJobs(db)).toBe(0);
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM note_settlement_cursors",
        )
        .get()!.count,
    ).toBe(0);
    expect(listNoteDebt(db, sessionDbId)).toEqual(debtBefore);
  });
});

describe("note settlement and the graceful-exit window", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  test("a shutdown arriving mid-drain stops the loop claiming anything more", async () => {
    const sessionDbId = seedSession(db, "content-exit-mid-drain");
    const clock = createClock();
    let exiting = false;
    const calls: NoteSettlementJob[] = [];
    const scheduler = createNoteSettlementScheduler({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: clock.now,
      nowMs: clock.nowMs,
      isGracefulExit: () => exiting,
      dispatch: async ({ job }) => {
        calls.push(job);
        // Shutdown lands while the first payload is still running.
        exiting = true;
        return { ok: true };
      },
    });

    // Three full windows are due at once, so the loop would otherwise claim and
    // dispatch all three in this single pass.
    seedTurns(db, sessionDbId, 1, 3 * NOTE_SETTLEMENT_CONSECUTIVE_TURNS);
    const pass = await scheduler.onTurnStop(sessionDbId);

    expect(pass.created).toHaveLength(3);
    expect(calls).toHaveLength(1);
    const jobs = listNoteSettlementJobs(db, sessionDbId);
    expect(jobs.map((job) => job.status)).toEqual([
      "done",
      "pending",
      "pending",
    ]);
    // Untouched means untouched: no attempt was spent on work exit prevented.
    expect(jobs[1]!.attempts).toBe(0);
    expect(jobs[2]!.attempts).toBe(0);
  });

  test("a claim the shutdown interrupts is handed back with its attempt refunded", async () => {
    const sessionDbId = seedSession(db, "content-exit-refund");
    const clock = createClock();
    const calls: NoteSettlementJob[] = [];
    // The flag flips between the loop's own check and the claim it guards.
    // Reads in order: runTrigger's pre-drain check, the loop's top-of-iteration
    // check, then the post-claim check — which is the one that must catch it.
    let reads = 0;
    const scheduler = createNoteSettlementScheduler({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: clock.now,
      nowMs: clock.nowMs,
      isGracefulExit: () => {
        reads += 1;
        return reads >= 3;
      },
      dispatch: async ({ job }) => {
        calls.push(job);
        return { ok: true };
      },
    });

    seedTurns(db, sessionDbId, 1, NOTE_SETTLEMENT_CONSECUTIVE_TURNS);
    const pass = await scheduler.onTurnStop(sessionDbId);

    expect(pass.created).toHaveLength(1);
    expect(pass.dispatched).toHaveLength(0);
    expect(calls).toHaveLength(0);

    const job = listNoteSettlementJobs(db, sessionDbId)[0]!;
    expect(job.status).toBe("pending");
    // The refund is the point: a payload that never started must leave the job
    // its full three lives for after the restart.
    expect(job.attempts).toBe(0);
    // Released is still a transition out of `claimed`, so the fence moved.
    expect(job.claimGeneration).toBeGreaterThan(1);
    expect(getNoteSettlementCursor(db, sessionDbId)).toBe(0);
  });
});

describe("note settlement compact boundary", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  function setCompactBoundary(sessionDbId: number, promptNumber: number): void {
    db.query<unknown, [number, number]>(
      "UPDATE sessions SET last_compact_turn = ? WHERE id = ?",
    ).run(promptNumber, sessionDbId);
  }

  test("a compact window stops at the repaired boundary marker", async () => {
    const sessionDbId = seedSession(db, "content-compact-boundary");
    const clock = createClock();
    const { dispatch, calls } = recordingDispatch();
    const scheduler = createNoteSettlementScheduler({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: clock.now,
      nowMs: clock.nowMs,
      dispatch,
    });

    // The ledger has decided 60 turns, but the compact only closed over 30:
    // the rest were classified by the queue drain that runs between the anchor
    // repair and this trigger.
    seedTurns(db, sessionDbId, 1, 60);
    setCompactBoundary(sessionDbId, 30);

    const first = await scheduler.onCompact(sessionDbId);

    expect(first.created).toHaveLength(1);
    expect(first.created[0]!.triggerType).toBe("compact");
    expect(first.created[0]!.windowStart).toBe(1);
    // Unbounded, the decided prefix would have cut a 50-turn block here.
    expect(first.created[0]!.windowEnd).toBe(30);
    expect(calls).toHaveLength(1);

    // The turns past the boundary are not lost, only deferred to the trigger
    // that owns them.
    setCompactBoundary(sessionDbId, 60);
    const second = await scheduler.onCompact(sessionDbId);

    expect(second.created).toHaveLength(1);
    expect(second.created[0]!.windowStart).toBe(31);
    expect(second.created[0]!.windowEnd).toBe(60);
  });

  test("a session that has never been compacted is not bounded by a missing marker", async () => {
    const sessionDbId = seedSession(db, "content-no-boundary");
    const clock = createClock();
    const { dispatch } = recordingDispatch();
    const scheduler = createNoteSettlementScheduler({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: clock.now,
      nowMs: clock.nowMs,
      dispatch,
    });

    seedTurns(db, sessionDbId, 1, 25);
    const pass = await scheduler.onCompact(sessionDbId);

    expect(pass.created).toHaveLength(1);
    expect(pass.created[0]!.windowEnd).toBe(25);
  });
});

describe("note settlement job state machine", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  test("failures back off on an exponential timetable read from the clock", async () => {
    const sessionDbId = seedSession(db, "content-backoff");
    const clock = createClock();
    let failures = 0;
    const { dispatch, calls } = recordingDispatch(async () => {
      failures += 1;
      return { ok: false, reason: `boom ${failures}` };
    });
    const scheduler = createNoteSettlementScheduler({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: clock.now,
      nowMs: clock.nowMs,
      dispatch,
    });

    seedTurns(db, sessionDbId, 1, 50);
    await scheduler.onTurnStop(sessionDbId);

    const afterFirst = listNoteSettlementJobs(db, sessionDbId)[0]!;
    expect(afterFirst.status).toBe("failed");
    expect(afterFirst.attempts).toBe(1);
    expect(afterFirst.lastError).toBe("boom 1");
    expect(afterFirst.retryAtEpoch).toBe(
      clock.now() + NOTE_SETTLEMENT_RETRY_BASE_MS / 1000,
    );

    // A trigger arriving before the backoff elapses does not re-dispatch.
    seedTurns(db, sessionDbId, 51, 50);
    await scheduler.onTurnStop(sessionDbId);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.windowStart).toBe(51);
    expect(listNoteSettlementJobs(db, sessionDbId)[0]!.attempts).toBe(1);

    // Past the backoff the same trigger picks it up in passing — no timer ran.
    clock.advance(NOTE_SETTLEMENT_RETRY_BASE_MS + 1_000);
    seedTurns(db, sessionDbId, 101, 50);
    await scheduler.onTurnStop(sessionDbId);

    const afterSecond = listNoteSettlementJobs(db, sessionDbId)[0]!;
    expect(afterSecond.attempts).toBe(2);
    // Second step doubles.
    expect(afterSecond.retryAtEpoch).toBe(
      clock.now() + (2 * NOTE_SETTLEMENT_RETRY_BASE_MS) / 1000,
    );
  });

  test("an expired lease consumes attempts, caps at three, and the cursor walks past", async () => {
    const sessionDbId = seedSession(db, "content-lease");
    const clock = createClock();
    const scheduler = createNoteSettlementScheduler({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: clock.now,
      nowMs: clock.nowMs,
      // Record only: the job is claimed by hand below to model a worker that
      // dies holding the lease and never reports back.
      isGracefulExit: () => true,
    });

    seedTurns(db, sessionDbId, 1, 50);
    await scheduler.onTurnStop(sessionDbId);

    let previousGeneration = 0;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const claimed = claimNextNoteSettlementJob(
        db,
        sessionDbId,
        clock.now(),
        clock.nowMs(),
      );
      expect(claimed?.attempts).toBe(attempt);
      // Generation counts OWNERSHIP CHANGES, not attempts: reclaiming the
      // expired lease invalidates the dead owner's fence, and the fresh claim
      // takes the next one, so it outruns `attempts` by one per reclaim.
      expect(claimed!.claimGeneration).toBeGreaterThan(previousGeneration);
      previousGeneration = claimed!.claimGeneration;
      clock.advance(NOTE_SETTLEMENT_LEASE_MS + 1_000);
    }

    const exhausted = claimNextNoteSettlementJob(
      db,
      sessionDbId,
      clock.now(),
      clock.nowMs(),
    );
    expect(exhausted).toBeNull();

    const terminal = listNoteSettlementJobs(db, sessionDbId)[0]!;
    expect(terminal.status).toBe("failed");
    expect(terminal.attempts).toBe(3);
    expect(terminal.lastError).toContain("lease expired");

    // terminal-state-must-abandon-and-continue: the next trigger advances the
    // cursor past the dead window instead of parking the session on it forever.
    seedTurns(db, sessionDbId, 51, 50);
    await scheduler.onTurnStop(sessionDbId);
    const withDispatch = createNoteSettlementScheduler({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: clock.now,
      nowMs: clock.nowMs,
    });
    seedTurns(db, sessionDbId, 101, 50);
    await withDispatch.onTurnStop(sessionDbId);

    expect(getNoteSettlementCursor(db, sessionDbId)).toBeGreaterThanOrEqual(50);
  });

  test("a late dispatch result is rejected by the claim generation", async () => {
    const sessionDbId = seedSession(db, "content-generation");
    const clock = createClock();
    let reclaimedGeneration = 0;
    const scheduler = createNoteSettlementScheduler({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: clock.now,
      nowMs: clock.nowMs,
      dispatch: async ({ job }) => {
        // The payload takes longer than its lease; a second worker reclaims the
        // row before this one reports success.
        clock.advance(NOTE_SETTLEMENT_LEASE_MS + 1_000);
        const reclaimed = claimNextNoteSettlementJob(
          db,
          job.sessionId,
          clock.now(),
          clock.nowMs(),
        );
        reclaimedGeneration = reclaimed?.claimGeneration ?? 0;
        return { ok: true };
      },
    });

    seedTurns(db, sessionDbId, 1, 50);
    await scheduler.onTurnStop(sessionDbId);

    // Claim (1) → reclaim of the expired lease (2) → the reclaimer's claim (3).
    expect(reclaimedGeneration).toBe(3);
    const job = listNoteSettlementJobs(db, sessionDbId)[0]!;
    // The stale owner's "done" wrote nothing: the row still belongs to the
    // reclaimer, and the cursor never learned of a settlement nobody committed.
    expect(job.status).toBe("claimed");
    expect(job.claimGeneration).toBe(3);
    expect(getNoteSettlementCursor(db, sessionDbId)).toBe(0);
  });

  /**
   * Ownership ends the moment the row leaves `claimed`, and these three cover
   * the ways it can leave without anyone taking it over. The fence has to hold
   * in that gap too: a job that has gone back to the queue, or gone terminal,
   * must not be writable by the owner it displaced — otherwise a dead worker
   * reporting late marks a window settled that nobody settled, and the cursor
   * walks over turns whose notes were never read.
   */
  function seedSingleJob(db: Database, contentSessionId: string, nowEpoch: number) {
    const sessionDbId = seedSession(db, contentSessionId);
    seedTurns(db, sessionDbId, 1, NOTE_SETTLEMENT_CONSECUTIVE_TURNS);
    const [job] = enqueueNoteSettlementWindows(
      db,
      [
        {
          sessionId: sessionDbId,
          windowStart: 1,
          windowEnd: NOTE_SETTLEMENT_CONSECUTIVE_TURNS,
          triggerType: "consecutive",
        },
      ],
      nowEpoch,
    );
    return { sessionDbId, job: job! };
  }

  test("a late success after the lease was reclaimed is discarded", () => {
    const clock = createClock();
    const { sessionDbId } = seedSingleJob(db, "content-late-reclaim", clock.now());

    const owner = claimNextNoteSettlementJob(
      db,
      sessionDbId,
      clock.now(),
      clock.nowMs(),
    )!;
    clock.advance(NOTE_SETTLEMENT_LEASE_MS + 1_000);
    // Reclaim without re-claiming, which is the window the bug lived in.
    claimNextNoteSettlementJob(db, sessionDbId, clock.now(), clock.nowMs(), {
      excludeJobIds: new Set([owner.id]),
    });
    expect(getNoteSettlementJob(db, owner.id)!.status).toBe("pending");

    expect(
      completeNoteSettlementJob(db, owner.id, clock.now(), owner.claimGeneration),
    ).toBe(false);
    expect(getNoteSettlementJob(db, owner.id)!.status).toBe("pending");
    expect(getNoteSettlementCursor(db, sessionDbId)).toBe(0);
  });

  test("a late success after the job went terminal cannot resurrect it", () => {
    const clock = createClock();
    const { sessionDbId } = seedSingleJob(db, "content-late-terminal", clock.now());

    let lastOwner: NoteSettlementJob | null = null;
    for (let attempt = 1; attempt <= NOTE_SETTLEMENT_MAX_ATTEMPTS; attempt += 1) {
      lastOwner = claimNextNoteSettlementJob(
        db,
        sessionDbId,
        clock.now(),
        clock.nowMs(),
      );
      clock.advance(NOTE_SETTLEMENT_LEASE_MS + 1_000);
    }
    // The claim that finds an exhausted expired lease terminalises it.
    expect(
      claimNextNoteSettlementJob(db, sessionDbId, clock.now(), clock.nowMs()),
    ).toBeNull();
    expect(getNoteSettlementJob(db, lastOwner!.id)!.status).toBe("failed");

    expect(
      completeNoteSettlementJob(
        db,
        lastOwner!.id,
        clock.now(),
        lastOwner!.claimGeneration,
      ),
    ).toBe(false);
    const terminal = getNoteSettlementJob(db, lastOwner!.id)!;
    expect(terminal.status).toBe("failed");
    expect(terminal.attempts).toBe(NOTE_SETTLEMENT_MAX_ATTEMPTS);
  });

  test("a late failure after the lease was reclaimed is discarded", () => {
    const clock = createClock();
    const { sessionDbId } = seedSingleJob(db, "content-late-failure", clock.now());

    const owner = claimNextNoteSettlementJob(
      db,
      sessionDbId,
      clock.now(),
      clock.nowMs(),
    )!;
    clock.advance(NOTE_SETTLEMENT_LEASE_MS + 1_000);
    claimNextNoteSettlementJob(db, sessionDbId, clock.now(), clock.nowMs(), {
      excludeJobIds: new Set([owner.id]),
    });

    expect(
      failNoteSettlementJob(
        db,
        owner.id,
        "late boom",
        clock.now(),
        owner.claimGeneration,
      ),
    ).toBeNull();
    const row = getNoteSettlementJob(db, owner.id)!;
    // Neither the status nor the backoff belongs to the displaced owner now.
    expect(row.status).toBe("pending");
    expect(row.lastError).toBeNull();
    expect(row.retryAtEpoch).toBe(0);
  });
});

/**
 * The payload settles its own window (ticket 07): the write-back marks the job
 * `done` inside the very transaction that lands the segments, because the two
 * must not be separable by a crash. That makes `done` a state the scheduler
 * finds ALREADY SET when the verdict comes back — and the completion CAS, which
 * is fenced on `status = 'claimed'`, then matches nothing.
 *
 * "Matches nothing" used to be read as one thing only — somebody else owns this
 * row now — and the drain stopped. These two tests pin the distinction the
 * scheduler has to draw instead: a row that is `done` under OUR generation is a
 * settled window, not a stolen one.
 */
describe("note settlement drain past a self-settling payload", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  /** What ticket 07's write-back does, minus the model and the segments. */
  function settleInsideDispatch(
    job: NoteSettlementJob,
    nowEpoch: number,
  ): void {
    completeNoteSettlementJob(db, job.id, nowEpoch, job.claimGeneration);
    advanceNoteSettlementCursor(db, job.sessionId, nowEpoch);
  }

  test("a payload that completes its own job does not strand the rest of the drain", async () => {
    const sessionDbId = seedSession(db, "content-self-settling");
    const clock = createClock();
    const calls: NoteSettlementJob[] = [];
    const scheduler = createNoteSettlementScheduler({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: clock.now,
      nowMs: clock.nowMs,
      dispatch: async ({ job }) => {
        calls.push(job);
        settleInsideDispatch(job, clock.now());
        return { ok: true };
      },
    });

    // Three full windows come due in one trigger — a backfill, or a session that
    // ran 150 turns between compacts.
    seedTurns(db, sessionDbId, 1, 3 * NOTE_SETTLEMENT_CONSECUTIVE_TURNS);
    const pass = await scheduler.onTurnStop(sessionDbId);

    expect(pass.created).toHaveLength(3);
    expect(calls).toHaveLength(3);
    expect(pass.dispatched.map((job) => job.windowStart)).toEqual([1, 51, 101]);
    expect(listNoteSettlementJobs(db, sessionDbId).map((job) => job.status)).toEqual([
      "done",
      "done",
      "done",
    ]);
    expect(getNoteSettlementCursor(db, sessionDbId)).toBe(
      3 * NOTE_SETTLEMENT_CONSECUTIVE_TURNS,
    );
  });

  test("a payload that commits and then errors leaves the window done and keeps draining", async () => {
    const sessionDbId = seedSession(db, "content-commit-then-error");
    const clock = createClock();
    const calls: NoteSettlementJob[] = [];
    const scheduler = createNoteSettlementScheduler({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: clock.now,
      nowMs: clock.nowMs,
      dispatch: async ({ job }) => {
        calls.push(job);
        settleInsideDispatch(job, clock.now());
        // The write-back committed; a step AFTER it — a CAS replay round, the
        // metrics sink — blew up. The verdict is a failure, the window is not.
        if (calls.length === 1) {
          return { ok: false, reason: "segment replay exploded after commit" };
        }
        return { ok: true };
      },
    });

    seedTurns(db, sessionDbId, 1, 3 * NOTE_SETTLEMENT_CONSECUTIVE_TURNS);
    await scheduler.onTurnStop(sessionDbId);

    expect(calls).toHaveLength(3);
    const jobs = listNoteSettlementJobs(db, sessionDbId);
    expect(jobs.map((job) => job.status)).toEqual(["done", "done", "done"]);
    // No failure was written over the committed row: `done` is the truth, and a
    // `failed` stamp here would hand the window a retry whose writes already
    // landed once.
    expect(jobs[0]!.lastError).toBeNull();
    expect(jobs[0]!.retryAtEpoch).toBe(0);
    expect(jobs[0]!.attempts).toBe(1);
    expect(getNoteSettlementCursor(db, sessionDbId)).toBe(
      3 * NOTE_SETTLEMENT_CONSECUTIVE_TURNS,
    );
  });
});

describe("note settlement window disjointness", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  test("a second plan overlapping a live job's range is refused, not layered", () => {
    const sessionDbId = seedSession(db, "content-overlap");
    seedTurns(db, sessionDbId, 1, 60);
    const nowEpoch = 1_000;

    const first = enqueueNoteSettlementWindows(
      db,
      [
        {
          sessionId: sessionDbId,
          windowStart: 1,
          windowEnd: 30,
          triggerType: "compact",
        },
      ],
      nowEpoch,
    );
    expect(first).toHaveLength(1);

    // A plan of a DIFFERENT trigger type starting at the same place: the UNIQUE
    // key does not collide, so only the range guard can stop it.
    const second = enqueueNoteSettlementWindows(
      db,
      [
        {
          sessionId: sessionDbId,
          windowStart: 1,
          windowEnd: 50,
          triggerType: "consecutive",
        },
      ],
      nowEpoch,
    );
    expect(second).toHaveLength(0);
    expect(listNoteSettlementJobs(db, sessionDbId)).toHaveLength(1);

    // 先到先得 costs the loser nothing but a trigger: its turns are still
    // unowned and the next plan cut from the new bound lands normally.
    const third = enqueueNoteSettlementWindows(
      db,
      [
        {
          sessionId: sessionDbId,
          windowStart: 31,
          windowEnd: 60,
          triggerType: "consecutive",
        },
      ],
      nowEpoch,
    );
    expect(third).toHaveLength(1);
    expect(third[0]!.windowStart).toBe(31);
  });

  test("plans inside one batch see each other, so a stale second window is dropped", () => {
    const sessionDbId = seedSession(db, "content-overlap-batch");
    seedTurns(db, sessionDbId, 1, 60);

    const created = enqueueNoteSettlementWindows(
      db,
      [
        {
          sessionId: sessionDbId,
          windowStart: 1,
          windowEnd: 50,
          triggerType: "consecutive",
        },
        {
          sessionId: sessionDbId,
          windowStart: 40,
          windowEnd: 60,
          triggerType: "compact",
        },
      ],
      1_000,
    );

    expect(created).toHaveLength(1);
    expect(created[0]!.windowEnd).toBe(50);
  });
});

describe("residual settlement of closed sessions", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  function seedClosedSession(
    contentSessionId: string,
    turns: number,
    lastActivityEpoch: number,
    pendingTail = 0,
  ): number {
    const sessionDbId = seedSession(db, contentSessionId, lastActivityEpoch);
    if (turns - pendingTail > 0) {
      seedTurns(db, sessionDbId, 1, turns - pendingTail, "noted", lastActivityEpoch);
    }
    if (pendingTail > 0) {
      seedTurns(
        db,
        sessionDbId,
        turns - pendingTail + 1,
        pendingTail,
        "pending",
        lastActivityEpoch,
      );
    }
    return sessionDbId;
  }

  test("picks the two oldest closed sessions, one job each, clearing debts at claim", async () => {
    const clock = createClock();
    const nowEpoch = clock.now();

    const live = seedSession(db, "content-live", nowEpoch);
    seedTurns(db, live, 1, 50, "noted", nowEpoch);

    // Idle for two days, one day and one day plus an hour respectively.
    const oldest = seedClosedSession("content-old", 40, nowEpoch - 3 * DAY_SECONDS, 12);
    const middle = seedClosedSession("content-mid", 30, nowEpoch - 2 * DAY_SECONDS, 5);
    const newest = seedClosedSession("content-new", 30, nowEpoch - 1.5 * DAY_SECONDS);
    // Registered right now: not closed however old its turns look.
    const registered = seedClosedSession(
      "content-registered",
      60,
      nowEpoch - 10 * DAY_SECONDS,
    );

    const { dispatch, calls } = recordingDispatch();
    const scheduler = createNoteSettlementScheduler({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: clock.now,
      nowMs: clock.nowMs,
      dispatch,
      activeSessionIds: () => [live, registered],
    });

    const pass = await scheduler.onTurnStop(live);

    expect(pass.residualSessionIds).toEqual([oldest, middle]);
    expect(pass.residualSessionIds).not.toContain(newest);
    expect(pass.residualSessionIds).not.toContain(registered);

    // One job per residual session, plus the triggering session's own window —
    // never mixed into one call.
    const residualJobs = calls.filter((job) => job.triggerType === "residual");
    expect(residualJobs).toHaveLength(2);
    expect(new Set(residualJobs.map((job) => job.sessionId)).size).toBe(2);
    expect(listNoteSettlementJobs(db, oldest)).toHaveLength(1);
    expect(listNoteSettlementJobs(db, oldest)[0]!.windowEnd).toBe(40);

    // Claim-time clearing: the closed session's open debts are written off, and
    // the live session's are untouched.
    const clearedTail = listNoteDebt(db, oldest).filter(
      (debt) => debt.reason === "closed",
    );
    expect(clearedTail).toHaveLength(12);
    expect(clearedTail.every((debt) => debt.status === "skipped")).toBe(true);
    expect(listNoteDebt(db, newest).some((debt) => debt.reason === "closed")).toBe(
      false,
    );
  });

  test("a closed session under the residual floor produces no job and no state write", async () => {
    const clock = createClock();
    const nowEpoch = clock.now();

    const live = seedSession(db, "content-live-small", nowEpoch);
    seedTurns(db, live, 1, 50, "noted", nowEpoch);

    const tiny = seedClosedSession(
      "content-tiny",
      NOTE_SETTLEMENT_MIN_WINDOW_TURNS - 1,
      nowEpoch - 5 * DAY_SECONDS,
      4,
    );
    const debtBefore = listNoteDebt(db, tiny);

    const { dispatch, calls } = recordingDispatch();
    const scheduler = createNoteSettlementScheduler({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: clock.now,
      nowMs: clock.nowMs,
      dispatch,
      activeSessionIds: () => [live],
    });

    const pass = await scheduler.onTurnStop(live);

    expect(pass.residualSessionIds).toHaveLength(0);
    expect(calls.every((job) => job.sessionId !== tiny)).toBe(true);
    expect(listNoteSettlementJobs(db, tiny)).toHaveLength(0);
    expect(getNoteSettlementCursor(db, tiny)).toBe(0);
    // Nothing was recorded about it being closed — the judgement is derived, so
    // the ledger must read exactly as it did before the scan.
    expect(listNoteDebt(db, tiny)).toEqual(debtBefore);

    // Reopening it puts it straight back on the live path: its debts are still
    // pending, so its own window accumulates from turn 1 as usual.
    seedTurns(db, tiny, NOTE_SETTLEMENT_MIN_WINDOW_TURNS, 40, "noted", nowEpoch);
    db.query<unknown, [number, number]>(
      `UPDATE note_debt SET status = 'noted', closed_at_epoch = ?
       WHERE session_id = ? AND status = 'pending'`,
    ).run(nowEpoch, tiny);
    const reopened = createNoteSettlementScheduler({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: clock.now,
      nowMs: clock.nowMs,
      dispatch,
      activeSessionIds: () => [live, tiny],
    });
    const livePass = await reopened.onTurnStop(tiny);

    expect(livePass.created).toHaveLength(1);
    expect(livePass.created[0]!.triggerType).toBe("consecutive");
    expect(livePass.created[0]!.windowStart).toBe(1);
    expect(
      listNoteDebt(db, tiny).some((debt) => debt.reason === "closed"),
    ).toBe(false);
  });

  /**
   * The residual scan derives candidates from TURNS and skips a session that
   * already has a job row, so once a residual job exists only a dispatch that
   * starts from the job table can ever run it. A closed session has no trigger
   * of its own; if this pass does not find its recorded job, nothing will.
   */
  test("a residual recorded during the graceful-exit window is dispatched at the next trigger", async () => {
    const clock = createClock();
    const nowEpoch = clock.now();

    const live = seedSession(db, "content-live-exit", nowEpoch);
    seedTurns(db, live, 1, NOTE_SETTLEMENT_CONSECUTIVE_TURNS, "noted", nowEpoch);
    const closed = seedClosedSession(
      "content-closed-exit",
      40,
      nowEpoch - 3 * DAY_SECONDS,
    );

    const { dispatch, calls } = recordingDispatch();
    let exiting = true;
    const scheduler = createNoteSettlementScheduler({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: clock.now,
      nowMs: clock.nowMs,
      dispatch,
      activeSessionIds: () => [live],
      isGracefulExit: () => exiting,
    });

    const during = await scheduler.onTurnStop(live);
    expect(during.residualSessionIds).toEqual([closed]);
    expect(calls).toHaveLength(0);
    expect(listNoteSettlementJobs(db, closed)).toHaveLength(1);
    expect(listNoteSettlementJobs(db, closed)[0]!.status).toBe("pending");

    // Next ordinary trigger. The residual DERIVATION now skips this session —
    // it already has a job — so only dispatching from the job row can reach it.
    exiting = false;
    const after = await scheduler.onCompact(live);

    expect(after.residualSessionIds).toEqual([]);
    expect(calls.map((job) => job.sessionId)).toContain(closed);
    expect(listNoteSettlementJobs(db, closed)[0]!.status).toBe("done");
  });

  test("a residual whose backoff has come due is re-dispatched, not stranded", async () => {
    const clock = createClock();
    const nowEpoch = clock.now();

    const live = seedSession(db, "content-live-retry", nowEpoch);
    seedTurns(db, live, 1, NOTE_SETTLEMENT_CONSECUTIVE_TURNS, "noted", nowEpoch);
    const closed = seedClosedSession(
      "content-closed-retry",
      40,
      nowEpoch - 3 * DAY_SECONDS,
    );

    const calls: NoteSettlementJob[] = [];
    let failNext = true;
    const scheduler = createNoteSettlementScheduler({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: clock.now,
      nowMs: clock.nowMs,
      activeSessionIds: () => [live],
      dispatch: async ({ job }) => {
        calls.push(job);
        if (job.sessionId === closed && failNext) {
          failNext = false;
          return { ok: false, reason: "transient" };
        }
        return { ok: true };
      },
    });

    await scheduler.onTurnStop(live);
    expect(listNoteSettlementJobs(db, closed)[0]!.status).toBe("failed");
    expect(listNoteSettlementJobs(db, closed)[0]!.attempts).toBe(1);

    // Before the backoff elapses nothing happens; after it, an unrelated
    // session's trigger picks the job up in passing. No timer was involved.
    const beforeBackoff = calls.length;
    await scheduler.onCompact(live);
    expect(calls).toHaveLength(beforeBackoff);

    clock.advance(NOTE_SETTLEMENT_RETRY_BASE_MS + 1_000);
    await scheduler.onCompact(live);

    expect(calls.filter((job) => job.sessionId === closed)).toHaveLength(2);
    expect(listNoteSettlementJobs(db, closed)[0]!.status).toBe("done");
  });

  test("recorded and freshly derived residuals share one per-trigger budget", async () => {
    const clock = createClock();
    const nowEpoch = clock.now();

    const live = seedSession(db, "content-live-budget", nowEpoch);
    seedTurns(db, live, 1, NOTE_SETTLEMENT_CONSECUTIVE_TURNS, "noted", nowEpoch);
    const oldest = seedClosedSession(
      "content-budget-old",
      40,
      nowEpoch - 5 * DAY_SECONDS,
    );
    const middle = seedClosedSession(
      "content-budget-mid",
      40,
      nowEpoch - 4 * DAY_SECONDS,
    );
    const newest = seedClosedSession(
      "content-budget-new",
      40,
      nowEpoch - 3 * DAY_SECONDS,
    );

    const { dispatch, calls } = recordingDispatch();
    let exiting = true;
    const scheduler = createNoteSettlementScheduler({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: clock.now,
      nowMs: clock.nowMs,
      dispatch,
      activeSessionIds: () => [live],
      isGracefulExit: () => exiting,
    });

    // Two recorded, none dispatched.
    const during = await scheduler.onTurnStop(live);
    expect(during.residualSessionIds).toEqual([oldest, middle]);

    // The next trigger owes those two a dispatch, and that debt spends the
    // whole budget: the third closed session waits its turn rather than making
    // the pass cost three inferences.
    exiting = false;
    const after = await scheduler.onCompact(live);

    expect(after.residualSessionIds).toEqual([]);
    expect(listNoteSettlementJobs(db, newest)).toHaveLength(0);
    expect(
      new Set(
        calls
          .filter((job) => job.triggerType === "residual")
          .map((job) => job.sessionId),
      ),
    ).toEqual(new Set([oldest, middle]));

    // With the backlog cleared, the budget is free for it.
    const next = await scheduler.onCompact(live);
    expect(next.residualSessionIds).toEqual([newest]);
    expect(calls.map((job) => job.sessionId)).toContain(newest);
  });
});
