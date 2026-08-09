import type { Database } from "bun:sqlite";

import { runWriteTransaction } from "../db/database";
import {
  advanceNoteSettlementCursor,
  claimNextNoteSettlementJob,
  completeNoteSettlementJob,
  enqueueNoteSettlementWindows,
  enqueueResidualNoteSettlementJob,
  failNoteSettlementJob,
  getNoteSettlementJob,
  listDispatchableNoteSettlementSessions,
  listResidualNoteSettlementCandidates,
  NOTE_SETTLEMENT_RESIDUAL_PER_TRIGGER,
  planNoteSettlementWindows,
  releaseNoteSettlementJobClaim,
  type NoteSettlementJob,
  type NoteSettlementTrigger,
  type NoteSettlementWindowPlan,
} from "../db/note-settlement";
import { DEFAULT_CONFIG, type MnemoConfig } from "../shared/config";

/**
 * P2 note settlement, scheduling half (spec D9, ticket 05).
 *
 * The worker hosts NO language model of its own (D10) — this module decides
 * WHEN a window is settled and hands the window to an injected payload. Ticket
 * 07 replaces that payload with the real Sonnet subprocess; nothing else about
 * the machinery moves, which is the reason the seam is a single async function
 * taking a frozen job and returning a verdict.
 *
 * There are exactly two triggers, and both are content events:
 *
 *   - `onTurnStop` fires a window only once 50 consecutive decided turns have
 *     accumulated. Below that it is a pure read and writes nothing;
 *   - `onCompact` is a trigger event in its own right (post-repair boundary),
 *     but its own window is subject to the minimum-window floor: under the floor
 *     no job is created and the turns roll forward to the next trigger.
 *
 * SessionEnd, resume, worker start and every timer are explicitly NOT triggers.
 * They are not non-triggers by omission — the worker never calls this module
 * from those paths, and the tests assert the absence.
 */

export interface NoteSettlementDispatchInput {
  /** The frozen window, including the generation the payload must CAS on. */
  job: NoteSettlementJob;
}

export type NoteSettlementDispatchOutcome =
  | { ok: true }
  | { ok: false; reason: string };

export type NoteSettlementDispatch = (
  input: NoteSettlementDispatchInput,
) => Promise<NoteSettlementDispatchOutcome>;

/**
 * The stub payload this ticket ships: it accepts the window and does nothing.
 * It exists so the job machinery can be exercised end to end without a model —
 * and so "the worker makes no LLM call anywhere in its lifecycle" stays a
 * property of the default wiring rather than of a configuration.
 */
export const noopNoteSettlementDispatch: NoteSettlementDispatch = async () => ({
  ok: true,
});

export interface NoteSettlementSchedulerDeps {
  db: Database;
  config?: MnemoConfig;
  /** Epoch seconds. */
  now?: () => number;
  /** Milliseconds; separate from `now` so leases can be tested on a fake clock. */
  nowMs?: () => number;
  dispatch?: NoteSettlementDispatch;
  /** Session db ids holding a live env registration (never residual). */
  activeSessionIds?: () => Iterable<number>;
  /**
   * True inside the graceful-exit window. Jobs are still RECORDED there — the
   * window they describe is real and a later trigger must not recut it — but
   * nothing is dispatched, because a payload started here would be killed
   * mid-flight and burn an attempt for nothing.
   */
  isGracefulExit?: () => boolean;
  logger?: Pick<Console, "warn" | "error">;
  consecutiveTurns?: number;
  minWindowTurns?: number;
  leaseMs?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
  residualIdleMs?: number;
  residualLimit?: number;
}

export interface NoteSettlementPassResult {
  /** Did this event count as a trigger at all? */
  triggered: boolean;
  created: NoteSettlementJob[];
  /** Jobs handed to the payload during this pass. */
  dispatched: NoteSettlementJob[];
  residualSessionIds: number[];
}

export interface NoteSettlementScheduler {
  onTurnStop(sessionDbId: number): Promise<NoteSettlementPassResult>;
  onCompact(sessionDbId: number): Promise<NoteSettlementPassResult>;
}

/**
 * What the row says happened, after the dispatch has had its say.
 *
 *   - `settled`   — the window is durably resolved and the drain goes on;
 *   - `failed`    — the window is unresolved and the pass stops, so a later
 *                   window is never settled ahead of an earlier one;
 *   - `preempted` — the row no longer belongs to this dispatch; whatever it
 *                   wanted to write is discarded and the pass stops.
 */
type NoteSettlementResolution = "settled" | "failed" | "preempted";

const INERT_PASS: NoteSettlementPassResult = {
  triggered: false,
  created: [],
  dispatched: [],
  residualSessionIds: [],
};

function inertPass(): NoteSettlementPassResult {
  return { ...INERT_PASS, created: [], dispatched: [], residualSessionIds: [] };
}

export function createNoteSettlementScheduler(
  deps: NoteSettlementSchedulerDeps,
): NoteSettlementScheduler {
  const db = deps.db;
  const config = deps.config ?? DEFAULT_CONFIG;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const nowMs = deps.nowMs ?? (() => Date.now());
  const dispatch = deps.dispatch ?? noopNoteSettlementDispatch;
  const activeSessionIds = deps.activeSessionIds ?? (() => []);
  const isGracefulExit = deps.isGracefulExit ?? (() => false);
  const logger = deps.logger ?? console;
  const windowOptions = {
    consecutiveTurns: deps.consecutiveTurns,
    minWindowTurns: deps.minWindowTurns,
  };
  const claimOptions = {
    leaseMs: deps.leaseMs,
    maxAttempts: deps.maxAttempts,
  };

  /**
   * Claim, dispatch and resolve up to `maxJobs` of one session's due jobs.
   *
   * A pass attempts each job at most once (`attempted`): a transient failure
   * returns the job to a later trigger instead of burning all three attempts in
   * one loop. A failure also ENDS the pass — settling a later window while an
   * earlier one is unresolved would read an arc whose first half is missing.
   * "Unresolved" is a property of the ROW, not of the verdict: a payload whose
   * write-back committed has resolved its window even if it then reported a
   * failure, and the drain carries on past it.
   *
   * The graceful-exit flag is read on EVERY iteration, not once on the way in.
   * Shutdown arrives asynchronously and a drain can run for minutes, so a flag
   * consulted only at entry would let the loop keep launching payloads that exit
   * is about to kill — and since an attempt is consumed at claim, each of those
   * kills would spend one of the job's three lives on work that never ran.
   */
  async function drainSession(
    sessionDbId: number,
    maxJobs: number,
  ): Promise<NoteSettlementJob[]> {
    const attempted = new Set<number>();
    const dispatched: NoteSettlementJob[] = [];

    while (dispatched.length < maxJobs) {
      if (isGracefulExit()) {
        break;
      }
      let job: NoteSettlementJob | null = null;
      try {
        job = claimNextNoteSettlementJob(db, sessionDbId, now(), nowMs(), {
          ...claimOptions,
          excludeJobIds: attempted,
        });
      } catch (error) {
        logger.error?.("note settlement claim failed", { sessionDbId, error });
        break;
      }
      if (!job) {
        break;
      }
      // Bound to a const: the completion transaction below is a closure, and a
      // `let` would widen back to nullable inside it.
      const claimed = job;
      attempted.add(claimed.id);

      // Shutdown that landed between the check above and the claim: hand the
      // claim back and refund its attempt. A job killed before its payload ever
      // started did no work and must not be charged as if it had.
      if (isGracefulExit()) {
        try {
          releaseNoteSettlementJobClaim(
            db,
            claimed.id,
            now(),
            claimed.claimGeneration,
          );
        } catch (error) {
          logger.error?.("note settlement claim release failed", {
            sessionDbId,
            jobId: claimed.id,
            error,
          });
        }
        break;
      }

      dispatched.push(claimed);

      let outcome: NoteSettlementDispatchOutcome;
      try {
        outcome = await dispatch({ job: claimed });
      } catch (error) {
        outcome = {
          ok: false,
          reason: `note settlement dispatch threw: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }

      // The verdict alone does not say what happened to the ROW. A payload is
      // allowed to settle its own window — ticket 07's write-back marks the job
      // `done` inside the same transaction that lands the segments, because a
      // crash must not be able to separate the two — so a successful settlement
      // hands the scheduler a row that has already left `claimed`, and the
      // completion CAS (fenced on `status = 'claimed'`) then matches nothing.
      //
      // Reading "matches nothing" as "somebody else owns this row" is what used
      // to stop the drain on its first success and strand every later window
      // until an unrelated trigger came along. So the row is re-read and three
      // cases are told apart: `done` under OUR generation is a settled window
      // whatever the verdict said; `claimed` under our generation is a window
      // the verdict still decides; anything else is genuine preemption.
      //
      // The re-read sits INSIDE the transaction that acts on it, and every
      // reclaim path is a BEGIN IMMEDIATE writer too, so nothing can move the
      // row between the classification and the write it authorises.
      const resolution = runWriteTransaction(
        db,
        (): NoteSettlementResolution => {
          const current = getNoteSettlementJob(db, claimed.id);
          if (!current || current.claimGeneration !== claimed.claimGeneration) {
            return "preempted";
          }
          if (current.status === "done") {
            // The window's effects are durable regardless of the verdict: a
            // payload that committed and then threw on a later step (a segment
            // CAS replay, the metrics sink) has still settled this window, and
            // stamping a failure over the `done` row would license a retry of
            // writes that already landed.
            advanceNoteSettlementCursor(
              db,
              claimed.sessionId,
              now(),
              claimOptions.maxAttempts,
            );
            return "settled";
          }
          if (current.status !== "claimed") {
            return "preempted";
          }

          if (outcome.ok) {
            // Completion and cursor advance share one transaction: the cursor
            // is derived from job statuses, so a crash between them would leave
            // a resolved window the cursor never learned about.
            if (
              !completeNoteSettlementJob(
                db,
                claimed.id,
                now(),
                claimed.claimGeneration,
              )
            ) {
              return "preempted";
            }
            advanceNoteSettlementCursor(
              db,
              claimed.sessionId,
              now(),
              claimOptions.maxAttempts,
            );
            return "settled";
          }

          const failed = failNoteSettlementJob(
            db,
            claimed.id,
            outcome.reason,
            now(),
            claimed.claimGeneration,
            { retryBaseMs: deps.retryBaseMs },
          );
          if (failed === null) {
            return "preempted";
          }
          // A terminal failure must not park the session forever: the cursor
          // walks past it and the audit trail stays on the row.
          advanceNoteSettlementCursor(
            db,
            claimed.sessionId,
            now(),
            claimOptions.maxAttempts,
          );
          return "failed";
        },
      );

      if (resolution === "settled") {
        if (!outcome.ok) {
          logger.warn?.(
            "note settlement payload reported a failure after committing its window",
            {
              sessionDbId,
              jobId: claimed.id,
              reason: outcome.reason,
            },
          );
        }
        continue;
      }
      if (resolution === "preempted") {
        logger.warn?.("note settlement result discarded, job was reclaimed", {
          sessionDbId,
          jobId: claimed.id,
          claimGeneration: claimed.claimGeneration,
          ok: outcome.ok,
        });
      }
      break;
    }

    // A pass that dispatched nothing may still have RESOLVED something: an
    // expired lease at the attempt cap turns terminal inside the claim, and the
    // claim then returns null with no one left to advance the cursor. Skipped
    // during exit, where the whole point is to write as little as possible.
    if (dispatched.length === 0 && !isGracefulExit()) {
      try {
        runWriteTransaction(db, () =>
          advanceNoteSettlementCursor(
            db,
            sessionDbId,
            now(),
            claimOptions.maxAttempts,
          ),
        );
      } catch (error) {
        logger.error?.("note settlement cursor advance failed", {
          sessionDbId,
          error,
        });
      }
    }

    return dispatched;
  }

  /**
   * Closed-session residual settlement (裁决 11). Runs only on a real trigger,
   * at most `residualLimit` sessions, oldest first, one job each, never mixed
   * into another session's window.
   */
  function enqueueResiduals(
    excludeSessionDbIds: Iterable<number>,
    limit: number,
  ): NoteSettlementJob[] {
    if (limit <= 0) {
      return [];
    }
    const active = new Set<number>(activeSessionIds());
    for (const sessionDbId of excludeSessionDbIds) {
      active.add(sessionDbId);
    }
    const candidates = listResidualNoteSettlementCandidates(db, {
      activeSessionIds: active,
      nowEpoch: now(),
      idleMs: deps.residualIdleMs,
      minWindowTurns: deps.minWindowTurns,
      limit,
    });

    const created: NoteSettlementJob[] = [];
    for (const candidate of candidates) {
      const job = enqueueResidualNoteSettlementJob(db, candidate, now());
      if (job) {
        created.push(job);
      }
    }
    return created;
  }

  async function runTrigger(
    sessionDbId: number,
    trigger: Exclude<NoteSettlementTrigger, "residual">,
  ): Promise<NoteSettlementPassResult> {
    if (!config.settlementEnabled) {
      return inertPass();
    }

    let plans: NoteSettlementWindowPlan[];
    try {
      plans = planNoteSettlementWindows(db, sessionDbId, trigger, windowOptions);
    } catch (error) {
      logger.error?.("note settlement planning failed", { sessionDbId, error });
      return inertPass();
    }

    // A turn-stop that has not filled a window is not a trigger: no job, no
    // residual scan, no claim — and, crucially, no write of any kind, so the
    // overwhelmingly common event stays free. A compact is a trigger even when
    // the floor suppresses its own window.
    const triggered = trigger === "compact" || plans.length > 0;
    if (!triggered) {
      return inertPass();
    }

    const otherSessionBudget =
      deps.residualLimit ?? NOTE_SETTLEMENT_RESIDUAL_PER_TRIGGER;

    const created: NoteSettlementJob[] = [];
    // Jobs another session ALREADY has on the books, due now. They come first
    // and they spend the same budget as freshly derived residuals: a job the
    // graceful-exit window recorded, or one whose backoff has come due, has no
    // trigger of its own to come back for it, so if this pass overlooks it in
    // favour of newly derived work it is overlooked forever.
    let dueSessionIds: number[] = [];
    try {
      created.push(...enqueueNoteSettlementWindows(db, plans, now()));
      dueSessionIds = listDispatchableNoteSettlementSessions(db, {
        excludeSessionIds: new Set([sessionDbId]),
        nowEpoch: now(),
        nowMs: nowMs(),
        leaseMs: claimOptions.leaseMs,
        maxAttempts: claimOptions.maxAttempts,
        limit: otherSessionBudget,
      });
      created.push(
        ...enqueueResiduals(
          [sessionDbId, ...dueSessionIds],
          otherSessionBudget - dueSessionIds.length,
        ),
      );
    } catch (error) {
      logger.error?.("note settlement enqueue failed", { sessionDbId, error });
    }

    const residualSessionIds = created
      .filter((job) => job.triggerType === "residual")
      .map((job) => job.sessionId);

    if (isGracefulExit()) {
      // Jobs are durable; the next trigger claims them.
      return { triggered, created, dispatched: [], residualSessionIds };
    }

    const dispatched = await drainSession(
      sessionDbId,
      Number.MAX_SAFE_INTEGER,
    );
    // Disjoint by construction: the residual scan was told to skip every session
    // already carrying a due job.
    for (const otherSessionId of [...dueSessionIds, ...residualSessionIds]) {
      dispatched.push(...(await drainSession(otherSessionId, 1)));
    }

    return { triggered, created, dispatched, residualSessionIds };
  }

  return {
    onTurnStop: (sessionDbId) => runTrigger(sessionDbId, "consecutive"),
    onCompact: (sessionDbId) => runTrigger(sessionDbId, "compact"),
  };
}
