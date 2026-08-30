import type { Database } from "bun:sqlite";

import { runWriteTransaction } from "../db/database";
import { resolveEraCutoff } from "../db/era";
import {
  advanceNoteSettlementCursor,
  claimNextNoteSettlementJob,
  enqueueResidualNoteSettlementJob,
  failNoteSettlementJob,
  getNoteSettlementJob,
  listDispatchableNoteSettlementSessions,
  listResidualNoteSettlementCandidates,
  NOTE_SETTLEMENT_MAX_ATTEMPTS,
  NOTE_SETTLEMENT_RESIDUAL_PER_TRIGGER,
  planAndEnqueueNoteSettlementWindows,
  planNoteSettlementWindows,
  releaseNoteSettlementJobClaim,
  transitionNoteSettlementJobToEdges,
  type NoteSettlementFailureClass,
  type NoteSettlementJob,
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
 * `onTurnStop` is the ONLY automatic trigger left (ticket 04, [S15069/T963]):
 * it fires a window only once the threshold's worth of consecutive decided
 * turns have accumulated (25-50 turns, capped per run — see
 * `db/note-settlement.ts`'s window constants). Below the threshold it is a
 * pure read and writes nothing.
 *
 * Compact and SessionEnd/finish, resume, worker start and every timer are
 * explicitly NOT triggers. Settlement reads the database, never live context
 * — a compact's repaired boundary and a session's live end carry no
 * information this scheduler needs, and check-natured work does not need
 * either event's immediacy. They are not non-triggers by omission — the
 * worker never calls this module from those paths, and the tests assert the
 * absence. The accepted consequence: a session that ends with fewer than the
 * threshold's worth of undecided-tail turns leaves that tail unsettled until
 * a later trigger (this session's own next turn-stop, or the residual scan
 * once it reads as closed) pushes it over.
 *
 * The residual piggyback (closed-session settlement) still rides ONLY on
 * `onTurnStop` — never on compact or finish — same as before ticket 04, just
 * with one fewer event to ride.
 *
 * Two config values guard the whole module, and they are not the same guard
 * (ticket 14). `eraCutoffEpoch` is the cutover switch: with none set every turn
 * is legacy, a legacy turn's record belongs to the extraction agent, and there
 * is nothing to settle — so a null cutoff makes every path here inert no matter
 * what else is configured. `settlementEnabled` is the kill switch on top of a
 * live era, for stopping settlement without taking the era down with it.
 */

export interface NoteSettlementDispatchInput {
  /**
   * The frozen window, including the generation the payload must CAS on and
   * (staged settlement) the STAGE this dispatch is being run for. The stage is
   * read off the row at claim time, so a job reclaimed after its transition
   * arrives here at `edges` and the scheduler routes it straight to stage 2.
   */
  job: NoteSettlementJob;
}

/**
 * Ticket 06 (read-write-contract spec "重试"): a failed dispatch now states
 * WHICH of the two retry classes it belongs to — `failNoteSettlementJob`
 * (db/note-settlement.ts) branches its whole behaviour on this, so there is
 * no default a caller may safely omit. `note-settlement-dispatch.ts`'s
 * `classifySettlementFailure` is the only place this value is produced for
 * the real payload.
 */
export type NoteSettlementDispatchOutcome =
  | {
      ok: true;
      /**
       * VESTIGIAL (ticket 04 retired the chain verdict this field named — the
       * scheduler no longer reads it at all). Kept only because
       * `createTransitionOnlyStageOneDispatch` below still sets it and that
       * stub survives as a test instrument: a claim's whole answer is now
       * decided by re-reading the row after ONE dispatch call (the post-hoc
       * truth rule), never by a value a verdict carries.
       */
      transition?: "edges";
    }
  | { ok: false; reason: string; failureClass: NoteSettlementFailureClass };

export type NoteSettlementDispatch = (
  input: NoteSettlementDispatchInput,
) => Promise<NoteSettlementDispatchOutcome>;

/**
 * PART B (claim-monitor-repair ticket 01): the one greppable message a failed
 * attempt leaves behind, named rather than inlined so the test and the log
 * reader cannot drift from the producer. The row's `last_error` is current
 * state and a later success clears it; this line is the history.
 */
export const NOTE_SETTLEMENT_ATTEMPT_FAILED_MESSAGE =
  "note settlement attempt failed";

/**
 * The stub payload this ticket ships: it accepts the window and does nothing.
 * It exists so the job machinery can be exercised end to end without a model —
 * and so "the worker makes no LLM call anywhere in its lifecycle" stays a
 * property of the default wiring rather than of a configuration.
 */
export const noopNoteSettlementDispatch: NoteSettlementDispatch = async () => ({
  ok: true,
});

/**
 * A TEST INSTRUMENT, no longer a production default (final review, re-ruling
 * 10). It lands the transition and nothing else — no topic words, no
 * projection, no snapshots — which is precisely why it may not stand in for a
 * missing stage 1 any more: the run it produces is neither the 0.25.0
 * monolith nor a real staged run, and it publishes that fiction as a settled
 * window. Production now records a deterministic failure instead (see
 * `missingStageOneDispatch` below).
 *
 * What it is still FOR (narrowed by ticket 04): a claim that ALREADY sits on
 * stage `edges` when reclaimed — driving `dispatch` (the resume path) with a
 * known transition already on the row — proving resume/attempt-accounting
 * behaviour needs a stage 1 whose transition a test can pin without a model.
 * Used as `stage1Dispatch` on its own (a fresh, topics-stage claim) it now
 * produces a recorded FAILURE, same as any other topics dispatch that
 * transitions and does not commit — there is no more same-drain chain for a
 * bare transition to hand off to.
 *
 * A refused transition (`null`) means the row moved out from under this
 * dispatch. It is reported as a deterministic failure and then DISCARDED by
 * the scheduler's own re-read, which sees the preemption directly — the
 * failure text exists for the log, not for the accounting.
 */
export function createTransitionOnlyStageOneDispatch(
  db: Database,
  now: () => number,
): NoteSettlementDispatch {
  return async ({ job }) => {
    const transitioned = transitionNoteSettlementJobToEdges(
      db,
      job.id,
      job.claimGeneration,
      now(),
    );
    if (!transitioned) {
      return {
        ok: false,
        reason: `note settlement stage 1 could not transition job ${job.id} to edges (the row moved)`,
        failureClass: "deterministic",
      };
    }
    return { ok: true, transition: "edges" };
  };
}

/**
 * THE PRODUCTION DEFAULT (final review, re-ruling 10): a settlement-enabled
 * worker that was handed no stage-1 payload FAILS the dispatch, deterministically,
 * before touching the row.
 *
 * The transition-only fallback it replaces wrote zero snapshots, so stage 2
 * then read an empty worklist, an empty writable set and no debts — and
 * committed a window on that basis, marking it settled and walking the cursor
 * past it. Nothing downstream could tell that run from a real one; the only
 * honest reading of "no stage 1 is mounted" is that this window cannot be
 * settled yet, which is what a deterministic failure says. Deterministic
 * rather than transient because retrying an unmounted payload fails
 * identically — it is a wiring fault, and the attempt cap is what stops it
 * spinning.
 */
export const missingStageOneDispatch: NoteSettlementDispatch = async ({ job }) => ({
  ok: false,
  reason: `staged settlement requires a stage-1 dispatch (job ${job.id} was claimed by a worker that mounted none)`,
  failureClass: "deterministic",
});

export interface NoteSettlementSchedulerDeps {
  db: Database;
  config?: MnemoConfig;
  /** Epoch seconds. */
  now?: () => number;
  /** Milliseconds; separate from `now` so leases can be tested on a fake clock. */
  nowMs?: () => number;
  /**
   * THE RESUME DISPATCH — run for a claim that STARTS on stage `edges` (a
   * reclaim after a crash between the transition and the terminal commit).
   * `createNoteSettlementDispatch` (`note-settlement-dispatch.ts`) is the real
   * one: today's cold, stage-2-shaped session, unmodified — the one shape
   * that still crosses two separate SDK sessions, and only because the first
   * one already died (settlement-execution-repair spec Rev 5, "One dispatch
   * per claim").
   */
  dispatch?: NoteSettlementDispatch;
  /**
   * THE UNIFIED DISPATCH — run for a claim that STARTS on stage `topics`. The
   * real one is `createUnifiedNoteSettlementDispatch`
   * (`note-settlement-dispatch.ts`): ONE query call spanning both stages —
   * the topic pass and, once the run's own `finalize` succeeds, the edge pass
   * — supplied by the assembly site along with its query seam. There is no
   * further dispatch after this one for a claim that started here: a run that
   * transitions and then stops is this claim's whole answer, judged by
   * re-reading the row (the post-hoc truth rule) rather than chained into a
   * second session.
   *
   * The default is `missingStageOneDispatch`: a deterministic failure, not a
   * bare transition (final review, re-ruling 10). Injectable for the same
   * reason `dispatch` is — the scheduler's own properties (the post-hoc truth
   * rule, attempt accounting, resume) are provable only against a topics
   * dispatch whose verdict, failure and throw a test can dictate.
   * `createTransitionOnlyStageOneDispatch` (a stub that transitions and
   * nothing else) still exists for tests that want a claim ALREADY resting on
   * `edges` to drive into `dispatch` above — under this ticket's rule a
   * dispatch that only transitions is now, on its own, a recorded failure
   * (there is no more same-drain chain for it to hand off to).
   */
  stage1Dispatch?: NoteSettlementDispatch;
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
  thresholdTurns?: number;
  capTurns?: number;
  /** Floor for the RESIDUAL scan only (ticket 04 leaves this untouched). */
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
  /**
   * The leak point spec D7 (ticket 05) requires explicit rather than assumed:
   * one attempt at whatever OTHER session's job is due right now, independent
   * of whether the CALLING event triggered a window of its own. Any job whose
   * own trigger will not come back for it — a backed-off retry, a job left
   * `pending` by a graceful exit — relies on this. Ticket 04 (`[S15069/T963]`)
   * narrows WHERE it is called from: only after `onTurnStop`, never after
   * compact or flush/finishSession any more (see `worker/server.ts`) — but the
   * mechanism itself is unchanged, including the overwhelmingly common
   * below-threshold turn-stop that used to return before reaching any
   * cross-session scan at all.
   */
  leakDueSessions(excludeSessionDbId?: number): Promise<NoteSettlementJob[]>;
  /**
   * The manual-dispatch surface (`POST /settle`): claim and run this session's
   * due jobs right now, without any event's help. It exists because a manually
   * enqueued backfill for an ACTIVE session is otherwise unreachable — the
   * session's own turn-stops are threshold-gated (`plans.length === 0` returns
   * before the drain), and the leak excludes the triggering session by
   * contract — so the row would sit pending until 25 consecutive turns or
   * session end ([S15069/T1014]'s scheduling-blind-spot finding). Claim
   * serialization (one in-flight settle per session) still holds: a call that
   * lands while another drain is mid-job claims nothing and returns.
   */
  drainSession(
    sessionDbId: number,
    maxJobs?: number,
  ): Promise<NoteSettlementJob[]>;
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
  const stage1Dispatch = deps.stage1Dispatch ?? missingStageOneDispatch;
  const activeSessionIds = deps.activeSessionIds ?? (() => []);
  const isGracefulExit = deps.isGracefulExit ?? (() => false);
  const logger = deps.logger ?? console;
  // Deps override always wins over config (ticket 02) — a test's explicit
  // `thresholdTurns`/`capTurns` must not be shadowed by whatever config the
  // scheduler was also handed.
  const windowOptions = {
    thresholdTurns: deps.thresholdTurns ?? config.noteSettlementThresholdTurns,
    capTurns: deps.capTurns ?? config.noteSettlementCapTurns,
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

      // ONE DISPATCH PER CLAIM (spec Rev 5, "One dispatch per claim"; ticket
      // 04). The claim's STAGE AT CLAIM TIME selects the payload: `topics`
      // gets the unified dispatch (one query call spanning both stages,
      // transitioning through its own `finalize` mid-run when it gets that
      // far); `edges` gets the resume dispatch (today's cold, stage-2-shaped
      // session, unmodified) — the only shape that still crosses two separate
      // SDK sessions, and only because the first one already died between the
      // transition and the terminal commit. There is no scheduler-side
      // chaining any more: a dispatch that transitions and then stops is this
      // claim's whole answer, judged below by re-reading the row.
      const stageDispatch: NoteSettlementDispatch =
        claimed.stage === "topics" ? stage1Dispatch : dispatch;
      let outcome: NoteSettlementDispatchOutcome;
      try {
        outcome = await stageDispatch({ job: claimed });
      } catch (error) {
        // A dispatch throwing OUT OF its own try/catch (both
        // note-settlement-dispatch.ts dispatches already classify every
        // `runQuery` failure they see) is a defensive backstop for a bug in
        // the dispatch layer itself, not a classified network signal —
        // deterministic by default so a genuine bug here cannot retry
        // forever under the transient path's no-cap discipline.
        outcome = {
          ok: false,
          reason: `note settlement dispatch threw: ${
            error instanceof Error ? error.message : String(error)
          }`,
          failureClass: "deterministic",
        };
      }

      // THE THREE-WAY ROW RE-READ (spec Rev 5, "One dispatch per claim";
      // ticket 04). The verdict alone does not say what happened to the ROW —
      // a payload is allowed to settle its own window (ticket 07's write-back
      // marks the job `done` inside the same transaction that lands the
      // segments, because a crash must not be able to separate the two), so a
      // successful settlement hands the scheduler a row that has already left
      // `claimed`, and the completion CAS (fenced on `status = 'claimed'`)
      // then matches nothing.
      //
      // `done` under OUR generation is a settled window WHATEVER THE VERDICT
      // SAID (post-hoc truth). Still `claimed` — ticket 12 Part B (peer P1):
      // ANY row still `claimed` with `ok: true` is now ALWAYS a recorded
      // failure, regardless of stage or what the outcome claimed — "a
      // dispatch REPORTING completion the row does not show remains a
      // deterministic failure" (the post-hoc truth rule, re-anchored at the
      // terminal end). This scheduler never completes a claim on trust any
      // more: the ONLY legal path to `done` is `completeNoteSettlementJob`
      // itself, called either by the payload's own `commit`
      // (note-settlement-staging.ts) or by a dispatch's own empty-window
      // terminal exception (note-settlement-dispatch.ts's
      // `completeEmptyWindowSettlement`) — both write `done` BEFORE
      // returning `ok: true`, so a row that is still `claimed` here never had
      // one of those and this branch is unreachable for anything but a
      // phantom. An honest `ok: false` here carries the DISPATCH's own
      // composed diagnosis (stage marker + mechanical conclusion + the run's
      // final text) in `reason`, used verbatim — this scheduler never
      // re-derives or generic-replaces it.
      //
      // The re-read sits INSIDE the transaction that acts on it, and every
      // reclaim path is a BEGIN IMMEDIATE writer too, so nothing can move the
      // row between the classification and the write it authorises.
      //
      // PART B (claim-monitor-repair ticket 01): what the failure branch
      // below actually recorded, carried OUT of the transaction so it can be
      // logged after the write commits. The row's own `last_error` is a
      // CURRENT-STATE field — a later successful attempt clears it and the
      // failed attempt's diagnosis is then unrecoverable (job 162's first
      // attempt: `grep '"jobId":162'` matched nothing but the row). The log
      // is the history, so it is written at failure time and nothing ever
      // erases it. Logged outside the transaction deliberately: a logger that
      // throws must not roll back the accounting it is describing.
      let recordedFailure:
        | {
            failureClass: NoteSettlementFailureClass;
            reason: string;
            attempt: number;
            stage: NoteSettlementJob["stage"];
            resultingStatus: NoteSettlementJob["status"];
          }
        | null = null;
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

          const reported: NoteSettlementDispatchOutcome = outcome.ok
            ? {
                ok: false,
                reason: `note settlement reported a completion job ${claimed.id} does not show (still claimed at stage ${current.stage})`,
                failureClass: "deterministic",
              }
            : outcome;

          const failed = failNoteSettlementJob(
            db,
            claimed.id,
            reported.failureClass,
            reported.reason,
            now(),
            claimed.claimGeneration,
            { retryBaseMs: deps.retryBaseMs, maxAttempts: claimOptions.maxAttempts },
          );
          if (failed === null) {
            return "preempted";
          }
          recordedFailure = {
            failureClass: reported.failureClass,
            reason: reported.reason,
            // The attempt this claim consumed — incremented at claim time, so
            // `claimed.attempts` is THIS attempt's own number (1 = first).
            attempt: claimed.attempts,
            stage: current.stage,
            resultingStatus: failed.status,
          };
          // A terminal failure (deterministic, cap spent -> `abandoned`) must
          // not park the session forever: the cursor walks past it and the
          // audit trail stays on the row (plus, for that case, the debt row
          // `failNoteSettlementJob` itself wrote). A transient failure
          // resolves to `pending`, which this same advance already treats as
          // unresolved — the loop below breaks on any non-`settled`
          // resolution, so a transient failure simply ends this pass without
          // advancing anything, exactly as `pending` should.
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
      if (recordedFailure !== null) {
        // PART B's durable diagnosis, written AT FAILURE TIME. Everything an
        // operator needs to reconstruct a lost attempt after a later one
        // succeeded and cleared the row: which job, which attempt, which
        // retry class, where the row landed, and the DISPATCH's own composed
        // diagnosis (stage marker + mechanical conclusion + the run's final
        // assistant text — `composeSettlementDiagnosis`), used verbatim.
        const failure: {
          failureClass: NoteSettlementFailureClass;
          reason: string;
          attempt: number;
          stage: NoteSettlementJob["stage"];
          resultingStatus: NoteSettlementJob["status"];
        } = recordedFailure;
        logger.warn?.(NOTE_SETTLEMENT_ATTEMPT_FAILED_MESSAGE, {
          sessionDbId,
          jobId: claimed.id,
          attempt: failure.attempt,
          maxAttempts: claimOptions.maxAttempts ?? NOTE_SETTLEMENT_MAX_ATTEMPTS,
          stage: failure.stage,
          failureClass: failure.failureClass,
          resultingStatus: failure.resultingStatus,
          reason: failure.reason,
        });
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
    eraCutoffEpoch: number,
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
      eraCutoffEpoch,
      idleMs: deps.residualIdleMs,
      minWindowTurns: deps.minWindowTurns,
      limit,
    });

    const created: NoteSettlementJob[] = [];
    for (const candidate of candidates) {
      const job = enqueueResidualNoteSettlementJob(
        db,
        candidate,
        now(),
        eraCutoffEpoch,
      );
      if (job) {
        created.push(job);
      }
    }
    return created;
  }

  async function runTrigger(
    sessionDbId: number,
  ): Promise<NoteSettlementPassResult> {
    // The era is the switch: with no cutoff every turn is legacy, and a legacy
    // turn is settled by nothing. `settlementEnabled` only stops a live era.
    // The configured pin first, then the recorded boundary. Reading the config
    // ALONE left this permanently inert on every install that never pinned one
    // by hand — which is all of them, since the boundary is normally recorded by
    // the first process of a build rather than configured (db/era.ts).
    const eraCutoffEpoch = config.eraCutoffEpoch ?? resolveEraCutoff(db);
    if (!config.settlementEnabled || eraCutoffEpoch === null) {
      return inertPass();
    }

    let plans: NoteSettlementWindowPlan[];
    try {
      plans = planNoteSettlementWindows(db, sessionDbId, {
        ...windowOptions,
        eraCutoffEpoch,
      });
    } catch (error) {
      logger.error?.("note settlement planning failed", { sessionDbId, error });
      return inertPass();
    }

    // A turn-stop that has not filled a window is not a trigger: no job, no
    // residual scan, no claim — and, crucially, no write of any kind, so the
    // overwhelmingly common event stays free (ticket 04: this is now the ONLY
    // gate — compact used to be an unconditional trigger even under its own
    // floor, but compact is no longer a trigger at all).
    const triggered = plans.length > 0;
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
      // Re-plans INSIDE the same write transaction as the insert (spec D7,
      // P1-4) rather than reusing `plans` above, which was only ever a gate
      // read: a concurrent writer for this same session (another trigger,
      // racing in from a different process) could have landed a job in the
      // gap between that read and this write, and committing against the
      // stale `plans` would either refuse the whole window or double-count a
      // range the concurrent writer already claimed.
      created.push(
        ...planAndEnqueueNoteSettlementWindows(db, sessionDbId, now(), {
          ...windowOptions,
          eraCutoffEpoch,
        }),
      );
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
          eraCutoffEpoch,
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

  /**
   * The leak point (spec D7, ticket 05). Unlike `runTrigger`, this never plans
   * or enqueues anything — it only asks "what is due right now, for anyone
   * other than the caller" and drains one job each, using the SAME
   * `listDispatchableNoteSettlementSessions` primitive `runTrigger` already
   * uses for other sessions' backlog. That reuse is deliberate: it does not
   * discriminate by trigger type, so a `sessionend` job — which has no trigger
   * of its own — is drained by the same call that opportunistically clears a
   * stray `consecutive`/`compact`/`residual` job left un-dispatched by an
   * earlier graceful-exit window.
   *
   * Gated on the same era/kill-switch pair every other path checks: a leak
   * attempt on an inert install must cost nothing beyond the gate read itself.
   */
  async function leakDueSessions(
    excludeSessionDbId?: number,
  ): Promise<NoteSettlementJob[]> {
    const eraCutoffEpoch = config.eraCutoffEpoch ?? resolveEraCutoff(db);
    if (!config.settlementEnabled || eraCutoffEpoch === null) {
      return [];
    }
    if (isGracefulExit()) {
      return [];
    }

    const excluded = new Set<number>();
    if (excludeSessionDbId !== undefined) {
      excluded.add(excludeSessionDbId);
    }

    let dueSessionIds: number[];
    try {
      dueSessionIds = listDispatchableNoteSettlementSessions(db, {
        excludeSessionIds: excluded,
        nowEpoch: now(),
        nowMs: nowMs(),
        leaseMs: claimOptions.leaseMs,
        maxAttempts: claimOptions.maxAttempts,
        limit: deps.residualLimit ?? NOTE_SETTLEMENT_RESIDUAL_PER_TRIGGER,
      });
    } catch (error) {
      logger.error?.("note settlement leak scan failed", { error });
      return [];
    }

    const dispatched: NoteSettlementJob[] = [];
    for (const sessionDbId of dueSessionIds) {
      dispatched.push(...(await drainSession(sessionDbId, 1)));
    }
    return dispatched;
  }

  return {
    onTurnStop: (sessionDbId) => runTrigger(sessionDbId),
    leakDueSessions,
    drainSession: (sessionDbId, maxJobs = Number.MAX_SAFE_INTEGER) =>
      drainSession(sessionDbId, maxJobs),
  };
}
