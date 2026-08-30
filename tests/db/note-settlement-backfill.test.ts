import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import {
  advanceNoteSettlementCursor,
  completeNoteSettlementJob,
  enqueueBackfillNoteSettlementJob,
  enqueueNoteSettlementWindows,
  enqueueResidualNoteSettlementJob,
  getNoteSettlementCursor,
  listNoteSettlementJobs,
  listResidualNoteSettlementCandidates,
  NOTE_SETTLEMENT_BACKFILL_MAX_TURNS,
  NOTE_SETTLEMENT_WINDOW_CAP_TURNS,
  planNoteSettlementWindows,
  type NoteSettlementJob,
} from "../../src/db/note-settlement";
import { createNoteSettlementScheduler } from "../../src/worker/note-settlement";
import { SETTLEMENT_ENABLED_CONFIG } from "../support/settlement-config";

/**
 * The settlement BACKFILL path: an explicitly named window that is allowed to
 * revisit ground the monotonic floor has already covered.
 *
 * `insertJob`'s floor is `max(cursor, MAX(window_end), era floor) + 1`, and
 * `MAX(window_end)` is read from the jobs table itself — so the floor only ever
 * rises and a historical window is unexpressible, returning null with no error.
 * `backfill` is the one trigger type exempt from it. What stays hard for every
 * type: the era boundary (pre-cutoff turns were graded under legacy semantics
 * that must never mix into a post-era window) and an inverted range.
 */

const ERA_CUTOFF_EPOCH = 1_000;
const NOW = 5_000;

function seedSession(db: Database, contentSessionId: string): number {
  return upsertSession(db, {
    contentSessionId,
    project: "/tmp/project-note-settlement-backfill",
    title: null,
    content: null,
    insight: null,
    createdAtEpoch: 1,
    updatedAtEpoch: 2_000,
    completedAtEpoch: null,
  }).id;
}

/** Turns [from, from+count), decided, at `createdAtEpoch` (era side by clock). */
function seedTurns(
  db: Database,
  sessionDbId: number,
  from: number,
  count: number,
  createdAtEpoch: number,
): void {
  for (let promptNumber = from; promptNumber < from + count; promptNumber += 1) {
    const turnId = db
      .query<{ id: number }, [number, number, number]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, user_prompt,
           assistant_response, created_at_epoch
         ) VALUES (?, ?, 'failed', 'prompt', 'reply', ?)
         RETURNING id`,
      )
      .get(sessionDbId, promptNumber, createdAtEpoch)!.id;
    db.query<unknown, [number, number, number, number, number]>(
      `INSERT INTO note_debt (
         turn_id, session_id, prompt_number, status,
         opened_at_epoch, updated_at_epoch
       ) VALUES (?, ?, ?, 'noted', ?, ?)`,
    ).run(turnId, sessionDbId, promptNumber, createdAtEpoch, createdAtEpoch);
  }
  db.query<unknown, [number, number]>(
    `INSERT INTO note_debt_cursor (
       session_id, last_classified_prompt_number, updated_at_epoch
     ) VALUES (?, ?, 2000)
     ON CONFLICT(session_id) DO UPDATE SET
       last_classified_prompt_number = excluded.last_classified_prompt_number`,
  ).run(sessionDbId, from + count - 1);
}

function setJobStatus(db: Database, jobId: number, status: string): void {
  db.query<unknown, [string, number]>(
    "UPDATE note_settlement_jobs SET status = ? WHERE id = ?",
  ).run(status, jobId);
}

describe("note settlement backfill windows", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  test("a backfill lands below the cursor and below MAX(window_end); the same window as a compact does not", () => {
    const sessionDbId = seedSession(db, "backfill-below-floor");
    seedTurns(db, sessionDbId, 1, 60, 2_000);

    // An ordinary window, settled: the cursor sits at 50 and the jobs table's
    // own MAX(window_end) is 50, so the monotonic floor is 51.
    const [settled] = enqueueNoteSettlementWindows(
      db,
      [
        {
          sessionId: sessionDbId,
          windowStart: 1,
          windowEnd: 50,
          triggerType: "consecutive",
        },
      ],
      NOW,
      ERA_CUTOFF_EPOCH,
    );
    setJobStatus(db, settled!.id, "done");
    expect(advanceNoteSettlementCursor(db, sessionDbId, NOW)).toBe(50);

    const refusedAsCompact = enqueueNoteSettlementWindows(
      db,
      [
        {
          sessionId: sessionDbId,
          windowStart: 10,
          windowEnd: 20,
          triggerType: "compact",
        },
      ],
      NOW,
      ERA_CUTOFF_EPOCH,
    );
    expect(refusedAsCompact).toEqual([]);

    const backfilled = enqueueBackfillNoteSettlementJob(
      db,
      sessionDbId,
      10,
      20,
      NOW,
      ERA_CUTOFF_EPOCH,
    );
    expect(backfilled.ok).toBe(true);
    const job = (backfilled as { ok: true; job: NoteSettlementJob }).job;
    expect(job).toMatchObject({
      sessionId: sessionDbId,
      windowStart: 10,
      windowEnd: 20,
      triggerType: "backfill",
      status: "pending",
      attempts: 0,
    });
  });

  test("the era boundary is refused even for a backfill", () => {
    const sessionDbId = seedSession(db, "backfill-era-floor");
    // Turns 1-10 are legacy (before the cutoff), 11-30 are in the era.
    seedTurns(db, sessionDbId, 1, 10, ERA_CUTOFF_EPOCH - 500);
    seedTurns(db, sessionDbId, 11, 20, ERA_CUTOFF_EPOCH + 500);

    expect(
      enqueueBackfillNoteSettlementJob(db, sessionDbId, 1, 30, NOW, ERA_CUTOFF_EPOCH),
    ).toEqual({ ok: false, reason: "below_era_floor" });
    // The last legacy prompt itself is still legacy: the floor is one PAST it.
    expect(
      enqueueBackfillNoteSettlementJob(db, sessionDbId, 10, 30, NOW, ERA_CUTOFF_EPOCH),
    ).toEqual({ ok: false, reason: "below_era_floor" });
    expect(listNoteSettlementJobs(db, sessionDbId)).toEqual([]);

    const accepted = enqueueBackfillNoteSettlementJob(
      db,
      sessionDbId,
      11,
      30,
      NOW,
      ERA_CUTOFF_EPOCH,
    );
    expect(accepted.ok).toBe(true);
  });

  test("allow_pre_era — the exact literal true, nothing weaker — crosses the era floor", () => {
    const sessionDbId = seedSession(db, "backfill-era-override");
    seedTurns(db, sessionDbId, 1, 10, ERA_CUTOFF_EPOCH - 500);
    seedTurns(db, sessionDbId, 11, 20, ERA_CUTOFF_EPOCH + 500);

    // An empty options object changes nothing: the floor still stands.
    expect(
      enqueueBackfillNoteSettlementJob(
        db, sessionDbId, 1, 30, NOW, ERA_CUTOFF_EPOCH, {},
      ),
    ).toEqual({ ok: false, reason: "below_era_floor" });

    const crossed = enqueueBackfillNoteSettlementJob(
      db, sessionDbId, 1, 30, NOW, ERA_CUTOFF_EPOCH, { allowPreEra: true },
    );
    expect(crossed.ok).toBe(true);
    expect((crossed as { ok: true; job: NoteSettlementJob }).job).toMatchObject({
      windowStart: 1,
      windowEnd: 30,
      triggerType: "backfill",
      status: "pending",
    });

    // The override lifts ONLY the era floor: the range guards still hold.
    expect(
      enqueueBackfillNoteSettlementJob(
        db, sessionDbId, 40, 39, NOW, ERA_CUTOFF_EPOCH, { allowPreEra: true },
      ),
    ).toEqual({ ok: false, reason: "inverted_range" });
  });

  test("an inverted range is refused for a backfill too", () => {
    const sessionDbId = seedSession(db, "backfill-inverted");
    seedTurns(db, sessionDbId, 1, 30, 2_000);

    expect(
      enqueueBackfillNoteSettlementJob(db, sessionDbId, 20, 19, NOW, ERA_CUTOFF_EPOCH),
    ).toEqual({ ok: false, reason: "inverted_range" });
    expect(listNoteSettlementJobs(db, sessionDbId)).toEqual([]);
  });

  test("the same backfill window twice is a named duplicate, not a second job", () => {
    const sessionDbId = seedSession(db, "backfill-duplicate");
    seedTurns(db, sessionDbId, 1, 30, 2_000);

    expect(
      enqueueBackfillNoteSettlementJob(db, sessionDbId, 5, 15, NOW, ERA_CUTOFF_EPOCH).ok,
    ).toBe(true);
    expect(
      enqueueBackfillNoteSettlementJob(db, sessionDbId, 5, 25, NOW, ERA_CUTOFF_EPOCH),
    ).toEqual({ ok: false, reason: "duplicate_window" });
    expect(listNoteSettlementJobs(db, sessionDbId)).toHaveLength(1);
  });

  test("a backfill never moves the cursor — not on insert, not on resolution", () => {
    const sessionDbId = seedSession(db, "backfill-cursor");
    // A legacy prefix, so a cursor born at the era boundary would be VISIBLY
    // non-zero (10) rather than indistinguishable from "no row".
    seedTurns(db, sessionDbId, 1, 10, ERA_CUTOFF_EPOCH - 500);
    seedTurns(db, sessionDbId, 11, 90, ERA_CUTOFF_EPOCH + 500);

    expect(
      enqueueBackfillNoteSettlementJob(db, sessionDbId, 20, 90, NOW, ERA_CUTOFF_EPOCH).ok,
    ).toBe(true);
    // No cursor row was born: the cursor says "everything at or below here is
    // resolved" and a backfill asserts nothing of the kind.
    expect(getNoteSettlementCursor(db, sessionDbId)).toBe(0);
    expect(
      db
        .query<{ count: number }, [number]>(
          "SELECT COUNT(*) AS count FROM note_settlement_cursors WHERE session_id = ?",
        )
        .get(sessionDbId)!.count,
    ).toBe(0);

    // Now the automatic sequence: 11-60 resolved, 61-100 still pending. The
    // backfill above spans 20-90 and is done — resolving it must not carry the
    // cursor over 61-90, which no automatic window has settled.
    const created = enqueueNoteSettlementWindows(
      db,
      [
        {
          sessionId: sessionDbId,
          windowStart: 11,
          windowEnd: 60,
          triggerType: "consecutive",
        },
        {
          sessionId: sessionDbId,
          windowStart: 61,
          windowEnd: 100,
          triggerType: "compact",
        },
      ],
      NOW,
      ERA_CUTOFF_EPOCH,
    );
    expect(created).toHaveLength(2);
    setJobStatus(db, created[0]!.id, "done");
    const backfillJob = listNoteSettlementJobs(db, sessionDbId).find(
      (job) => job.triggerType === "backfill",
    )!;
    setJobStatus(db, backfillJob.id, "done");

    expect(advanceNoteSettlementCursor(db, sessionDbId, NOW)).toBe(60);
    expect(getNoteSettlementCursor(db, sessionDbId)).toBe(60);
  });

  test("a backfill is claimed and dispatched by the existing path", async () => {
    const sessionDbId = seedSession(db, "backfill-dispatch");
    seedTurns(db, sessionDbId, 1, 60, ERA_CUTOFF_EPOCH + 500);

    const settledFirst = enqueueNoteSettlementWindows(
      db,
      [
        {
          sessionId: sessionDbId,
          windowStart: 1,
          windowEnd: 50,
          triggerType: "consecutive",
        },
      ],
      NOW,
      ERA_CUTOFF_EPOCH,
    );
    setJobStatus(db, settledFirst[0]!.id, "done");
    advanceNoteSettlementCursor(db, sessionDbId, NOW);

    expect(
      enqueueBackfillNoteSettlementJob(db, sessionDbId, 1, 50, NOW, ERA_CUTOFF_EPOCH).ok,
    ).toBe(true);

    const dispatched: NoteSettlementJob[] = [];
    // Ticket 04: one dispatch per claim — this job's claim starts on stage
    // `topics`, so the payload under test (the real settling work, here a
    // bare recorder) goes in `stage1Dispatch`; there is no more same-drain
    // chain into a separate `dispatch` for the scheduler to complete it
    // through.
    const scheduler = createNoteSettlementScheduler({
      db,
      config: { ...SETTLEMENT_ENABLED_CONFIG, eraCutoffEpoch: ERA_CUTOFF_EPOCH },
      now: () => NOW,
      nowMs: () => NOW * 1_000,
      stage1Dispatch: async ({ job }) => {
        dispatched.push(job);
        // Ticket 12 Part B: the scheduler no longer completes a claim on
        // trust — this stub must terminalize before reporting `ok: true`.
        completeNoteSettlementJob(db, job.id, NOW, job.claimGeneration);
        return { ok: true };
      },
    });

    // The ordinary leak — no backfill-specific entry point anywhere.
    const drained = await scheduler.leakDueSessions();

    expect(dispatched.map((job) => job.triggerType)).toEqual(["backfill"]);
    expect(drained.map((job) => job.id)).toEqual(dispatched.map((job) => job.id));
    expect(dispatched[0]!.attempts).toBe(1);
    const backfillRow = listNoteSettlementJobs(db, sessionDbId).find(
      (job) => job.triggerType === "backfill",
    )!;
    expect(backfillRow.status).toBe("done");
    // Committing it still leaves the cursor where the automatic sequence put it.
    expect(getNoteSettlementCursor(db, sessionDbId)).toBe(50);
  });

  test("no automatic planner ever produces a backfill", async () => {
    const sessionDbId = seedSession(db, "backfill-never-planned");
    seedTurns(
      db,
      sessionDbId,
      1,
      NOTE_SETTLEMENT_WINDOW_CAP_TURNS * 2 + 10,
      ERA_CUTOFF_EPOCH + 500,
    );

    // Ticket 04 ([S15069/T963]): turn-stop planning is the ONLY automatic
    // trigger, and `NoteSettlementWindowPlan.triggerType` is pinned to the
    // literal `"consecutive"` — this assertion is now a redundant runtime
    // check of a compile-time fact, kept as a regression guard.
    const plannedTriggers = planNoteSettlementWindows(db, sessionDbId, {
      eraCutoffEpoch: ERA_CUTOFF_EPOCH,
    }).map((plan) => plan.triggerType);
    expect(plannedTriggers.length).toBeGreaterThan(0);
    expect(plannedTriggers).not.toContain("backfill");
    expect(new Set(plannedTriggers)).toEqual(new Set(["consecutive"]));

    // The one enqueue path that does not go through `planNoteSettlementWindows`
    // at all: the closed-session residual scan. (SessionEnd's own synchronous
    // enqueue is retired along with `compact`/`sessionend` planning — ticket 04.)
    const idleSessionDbId = seedSession(db, "backfill-never-planned-idle");
    seedTurns(db, idleSessionDbId, 1, 40, ERA_CUTOFF_EPOCH + 500);
    const residualNowEpoch = 2_000 + 10 * 24 * 60 * 60;
    const candidates = listResidualNoteSettlementCandidates(db, {
      activeSessionIds: new Set<number>(),
      nowEpoch: residualNowEpoch,
      eraCutoffEpoch: ERA_CUTOFF_EPOCH,
    });
    const residualJobs = candidates
      .map((candidate) =>
        enqueueResidualNoteSettlementJob(
          db,
          candidate,
          residualNowEpoch,
          ERA_CUTOFF_EPOCH,
        ),
      )
      .filter((job): job is NoteSettlementJob => job !== null);
    expect(residualJobs.length).toBeGreaterThan(0);
    expect(residualJobs.map((job) => job.triggerType)).not.toContain("backfill");

    // And end to end through the scheduler's own (sole) automatic trigger.
    // Ticket 04: one dispatch per claim — see the comment above.
    const scheduler = createNoteSettlementScheduler({
      db,
      config: { ...SETTLEMENT_ENABLED_CONFIG, eraCutoffEpoch: ERA_CUTOFF_EPOCH },
      now: () => residualNowEpoch,
      nowMs: () => residualNowEpoch * 1_000,
      stage1Dispatch: async () => ({ ok: true }),
    });
    const fromTriggers = (await scheduler.onTurnStop(sessionDbId)).created;
    expect(fromTriggers.map((job) => job.triggerType)).not.toContain("backfill");

    const everyTriggerTypeWritten = db
      .query<{ triggerType: string }, []>(
        "SELECT DISTINCT trigger_type AS triggerType FROM note_settlement_jobs",
      )
      .all()
      .map((row) => row.triggerType);
    expect(everyTriggerTypeWritten).not.toContain("backfill");
  });

  test("a backfill wider than the 100-turn cap is refused; exactly 100 is accepted (ticket 04)", () => {
    const sessionDbId = seedSession(db, "backfill-cap");
    seedTurns(db, sessionDbId, 1, 200, ERA_CUTOFF_EPOCH + 500);

    const tooWide = enqueueBackfillNoteSettlementJob(
      db,
      sessionDbId,
      1,
      NOTE_SETTLEMENT_BACKFILL_MAX_TURNS + 1,
      NOW,
      ERA_CUTOFF_EPOCH,
    );
    expect(tooWide).toEqual({ ok: false, reason: "backfill_too_large" });
    expect(listNoteSettlementJobs(db, sessionDbId)).toEqual([]);

    const exactlyAtCap = enqueueBackfillNoteSettlementJob(
      db,
      sessionDbId,
      1,
      NOTE_SETTLEMENT_BACKFILL_MAX_TURNS,
      NOW,
      ERA_CUTOFF_EPOCH,
    );
    expect(exactlyAtCap.ok).toBe(true);
    expect(listNoteSettlementJobs(db, sessionDbId)).toHaveLength(1);
  });
});
