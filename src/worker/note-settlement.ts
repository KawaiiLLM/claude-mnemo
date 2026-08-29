import type { Database } from "bun:sqlite";

import { runWriteTransaction } from "../db/database";
import { resolveEraCutoff } from "../db/era";
import {
  advanceNoteSettlementCursor,
  claimNextNoteSettlementJob,
  completeNoteSettlementJob,
  enqueueResidualNoteSettlementJob,
  failNoteSettlementJob,
  getNoteSettlementJob,
  listDispatchableNoteSettlementSessions,
  listResidualNoteSettlementCandidates,
  NOTE_SETTLEMENT_RESIDUAL_PER_TRIGGER,
  planAndEnqueueNoteSettlementWindows,
  planNoteSettlementWindows,
  releaseNoteSettlementJobClaim,
  transitionNoteSettlementJobToEdges,
  type NoteSettlementFailureClass,
  type NoteSettlementJob,
  type NoteSettlementStage,
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
       * The TRANSITION VERDICT (staged-settlement spec Rev 5): this dispatch
       * ended stage 1 by landing the stage transition, and the job is now
       * stage 2's to run. It is NOT a completion: the window is not settled,
       * the cursor does not move, no failure is recorded, the claim is not
       * released and no attempt is spent — the scheduler launches stage 2 in
       * the SAME drain, under the same claim.
       *
       * Advisory, not authoritative. The scheduler decides by re-reading the
       * row (the post-hoc truth rule), because a transition that committed
       * and then lost its verdict to a crash is indistinguishable from this
       * value never having been returned.
       */
      transition?: "edges";
    }
  | { ok: false; reason: string; failureClass: NoteSettlementFailureClass };

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

/**
 * A TEST INSTRUMENT, no longer a production default (final review, re-ruling
 * 10). It lands the transition and nothing else — no topic words, no
 * projection, no snapshots — which is precisely why it may not stand in for a
 * missing stage 1 any more: the run it produces is neither the 0.25.0
 * monolith nor a real staged run, and it publishes that fiction as a settled
 * window. Production now records a deterministic failure instead (see
 * `missingStageOneDispatch` below).
 *
 * What it is still FOR: the scheduler's own properties — same-drain chaining,
 * the post-hoc truth rule, attempt accounting, stage resume — are properties
 * of a scheduler, not of a model, and proving them needs a stage 1 whose
 * verdict a test can dictate. Every such test now passes this explicitly, so
 * "this job ran a stubbed stage 1" is a fact stated at the call site rather
 * than a silence.
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
   * STAGE 2 — the edge pass, and the payload that owns the terminal commit.
   * This is the seam the real settlement run has always plugged into; staging
   * did not move it, it only put a stage in front of it.
   */
  dispatch?: NoteSettlementDispatch;
  /**
   * STAGE 1 — the topic pass. The real one is
   * `createNoteSettlementStageOneDispatch` (`note-settlement-stage1.ts`),
   * supplied by the assembly site along with its query seam.
   *
   * The default is `missingStageOneDispatch`: a deterministic failure, not a
   * bare transition (final review, re-ruling 10). Injectable for the same
   * reason `dispatch` is — the scheduler's own properties (chaining, the
   * post-hoc truth rule, attempt accounting) are provable only against a stage
   * 1 whose verdict, failure and throw a test can dictate, and those tests now
   * pass `createTransitionOnlyStageOneDispatch` by name.
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

/**
 * What one STAGE's dispatch resolved to — the three row-level resolutions
 * above, plus the one outcome that is not a resolution at all:
 *
 *   - `chain` — the row transitioned to `edges` under this same claim. The
 *     job is neither settled nor failed; it is halfway, and the next stage
 *     runs immediately against the row this verdict carries. No completion,
 *     no failure record, no re-claim, no attempt spent.
 */
type NoteSettlementStageVerdict =
  | { kind: NoteSettlementResolution }
  | { kind: "chain"; job: NoteSettlementJob };

/**
 * A claim runs at most this many stages before the drain stops asking. The
 * stage vocabulary is `topics` → `edges` and the transition's own fence
 * refuses a second one, so two is the true ceiling — this constant is a
 * structural guard against a future third stage silently looping, not a
 * tuning knob.
 */
const MAX_STAGES_PER_CLAIM = 2;

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

      // The staged run (spec Rev 5). One CLAIM carries both passes: stage 1
      // (the topic pass) ends in a transition that leaves the job `claimed`
      // under the same generation, and stage 2 (the edge pass) then runs
      // immediately in this same drain against the transitioned row. A job
      // claimed at `edges` — a reclaim after a crash between the two — skips
      // stage 1 entirely and never re-sends judgment work that already landed.
      let stageJob: NoteSettlementJob = claimed;
      let outcome: NoteSettlementDispatchOutcome = { ok: true };
      let resolution: NoteSettlementResolution = "preempted";

      for (let stagesRun = 0; stagesRun < MAX_STAGES_PER_CLAIM; stagesRun += 1) {
        const dispatchStage: NoteSettlementStage = stageJob.stage;
        const stageDispatch =
          dispatchStage === "topics" ? stage1Dispatch : dispatch;
        try {
          outcome = await stageDispatch({ job: stageJob });
        } catch (error) {
          // A dispatch throwing OUT OF its own try/catch (note-settlement-
          // dispatch.ts already classifies every `runQuery` failure it sees)
          // is a defensive backstop for a bug in the dispatch layer itself,
          // not a classified network signal — deterministic by default so a
          // genuine bug here cannot retry forever under the transient path's
          // no-cap discipline.
          outcome = {
            ok: false,
            reason: `note settlement dispatch threw: ${
              error instanceof Error ? error.message : String(error)
            }`,
            failureClass: "deterministic",
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
        const verdict = runWriteTransaction(
          db,
          (): NoteSettlementStageVerdict => {
            const current = getNoteSettlementJob(db, claimed.id);
            if (!current || current.claimGeneration !== claimed.claimGeneration) {
              return { kind: "preempted" };
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
              return { kind: "settled" };
            }
            if (current.status !== "claimed") {
              return { kind: "preempted" };
            }

            // THE POST-HOC TRUTH RULE (spec Rev 5, round 3). Applied to EVERY
            // stage-1 return alike — transition verdict, reported failure, or a
            // throw this loop already turned into one — because all three are
            // the same question: did the transition COMMIT? The row answers it;
            // the verdict only claims to. A transition that landed and then lost
            // its verdict to a crash, a killed subprocess or a bug in the
            // dispatch layer is indistinguishable, from out here, from one that
            // never ran — so the row is asked, and the reported outcome is
            // DISCARDED whenever it disagrees.
            //
            // Same (job, generation), still `claimed`, stage advanced from this
            // dispatch's `topics` to `edges` ⇒ stage 1 is finished. No failure
            // accounting, no reclaim, no attempt spent, no completion: stage 2
            // launches against the row this verdict carries. Generation/status
            // mismatch is preemption, handled above exactly as it always was.
            // Stage still `topics` falls through and the outcome is handled as
            // reported.
            if (dispatchStage === "topics" && current.stage === "edges") {
              return { kind: "chain", job: current };
            }

            // A TOPICS DISPATCH MAY ONLY TRANSITION OR FAIL (final review,
            // finding 4). Reaching here with `ok: true` means the row is still
            // ours, still on stage 1, and its owner reported success — and
            // there are only two ways to say that, both false:
            //
            //   - it CLAIMED a transition the row never took, or
            //   - it reported a plain success, which for stage 1 means "I
            //     finished" about a pass whose only finish IS the transition.
            //
            // The second one used to fall through to the completion branch
            // below, which marked the job `done` and walked the cursor over a
            // window no stage 2 had ever run — the loudest possible version of
            // the bug the post-hoc truth rule exists to prevent. The row is the
            // truth; both shapes are recorded as the same deterministic
            // failure, because retrying a broken dispatch is exactly what must
            // not run unbounded.
            const reported: NoteSettlementDispatchOutcome =
              dispatchStage === "topics" && outcome.ok
                ? {
                    ok: false,
                    reason:
                      outcome.transition === "edges"
                        ? `note settlement stage 1 reported a transition that never landed (job ${claimed.id} is still on stage ${current.stage})`
                        : `note settlement stage 1 reported success without a transition (job ${claimed.id} is still on stage ${current.stage}) — a topics dispatch may only transition or fail`,
                    failureClass: "deterministic",
                  }
                : outcome;

            if (reported.ok) {
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
                return { kind: "preempted" };
              }
              advanceNoteSettlementCursor(
                db,
                claimed.sessionId,
                now(),
                claimOptions.maxAttempts,
              );
              return { kind: "settled" };
            }

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
              return { kind: "preempted" };
            }
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
            return { kind: "failed" };
          },
        );

        if (verdict.kind === "chain") {
          // Same drain, same claim, same generation — only the stage moved.
          stageJob = verdict.job;
          continue;
        }
        resolution = verdict.kind;
        break;
      }

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
