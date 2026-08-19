import type { Database } from "bun:sqlite";

import { runHookWriteTransaction } from "../../db/database";
import { getSessionByContentId } from "../../db/sessions";
import { hasNewTurnSinceSessionRunStart } from "../../db/session-run";
import {
  getOrphanTurns,
  skipOrphanTurns,
} from "../../db/orphan-turns";
import {
  notifyWorkerFlush,
  notifyWorkerTrigger,
  type WorkerClientDeps,
} from "../../worker/client";
import { getMaxTurnId } from "../../db/turns";
import { resolveSessionTranscriptPath } from "../../shared/paths";
import {
  clearReadGrantsForWriter,
  sessionWriterId,
  sweepReadGrantsForCompletedSessions,
} from "../../db/write-gate";
import { runCaptureRepair, type CaptureRepairLog } from "../capture-repair";
import type { HookResult, NormalizedHookInput } from "../types";

/**
 * Read-write contract (ticket 01): how many OTHER completed sessions' read
 * grants a single SessionEnd call sweeps as its janitor backstop, beside
 * clearing its own. Small and bounded — this runs on every session's exit,
 * so it must never turn into a table scan; it only needs to catch up on a
 * rare miss (e.g. a crash between an earlier session's completion and its
 * own SessionEnd call), not clear a backlog in one pass.
 */
export const WRITE_GATE_JANITOR_SWEEP_LIMIT = 20;

/** SessionEnd runs under a 2s hook budget; the backstop scan stays well inside it. */
export const SESSION_END_SCAN_MAX_LINES = 500;

/**
 * Wall-clock budget for the whole repair, measured from handler entry. Well
 * under the 2s hook timeout so a slow scan or a busy database cannot starve
 * orphan finalization, which runs afterwards and is what unblocks the diary
 * readiness gate. Also caps the transaction's busy-retry budget, so the two can
 * never sum past this.
 */
export const SESSION_END_REPAIR_BUDGET_MS = 400;

/** Lines per deadline check — the repair stops between batches, not mid-batch. */
export const SESSION_END_SCAN_BATCH_LINES = 50;

/**
 * Below this much remaining budget the repair is skipped outright: starting a
 * batch we cannot finish spends the reserve on work that will be redone anyway.
 */
export const SESSION_END_REPAIR_MIN_BUDGET_MS = 40;

export interface SessionEndHandlerDependencies {
  db: Database;
  now?: () => number;
  /** Millisecond wall clock for the repair deadline; injectable for tests. */
  nowMs?: () => number;
  workerClientDeps?: WorkerClientDeps;
  workerEnv?: NodeJS.ProcessEnv;
  runHookWriteTransaction?: typeof runHookWriteTransaction;
  captureRepairLog?: CaptureRepairLog;
  captureRepairMaxLines?: number;
  captureRepairBatchLines?: number;
  /** Seam for the repair itself (default `runCaptureRepair`). */
  captureRepairRunner?: typeof runCaptureRepair;
}

export function createSessionEndHandler(
  dependencies: SessionEndHandlerDependencies,
) {
  const now = dependencies.now ?? (() => Math.floor(Date.now() / 1000));
  const nowMs = dependencies.nowMs ?? Date.now;
  const writeTransaction =
    dependencies.runHookWriteTransaction ?? runHookWriteTransaction;
  const captureRepairRunner =
    dependencies.captureRepairRunner ?? runCaptureRepair;

  return async function handleSessionEndHook(
    input: NormalizedHookInput,
  ): Promise<HookResult> {
    if (!input.sessionId) {
      return { continue: true };
    }

    // Computed at entry, not at repair start: the gate read and path resolution
    // below are themselves work, and the deadline has to cover them for the
    // floor check to mean anything.
    const repairDeadlineMs = nowMs() + SESSION_END_REPAIR_BUDGET_MS;

    const session = getSessionByContentId(dependencies.db, input.sessionId);
    if (!session) {
      return {
        continue: true,
        asyncWork: async () => {
          await notifyWorkerTrigger(
            {
              action: "finish",
              contentSessionId: input.sessionId!,
            },
            dependencies.workerClientDeps,
            dependencies.workerEnv,
          );
        },
      };
    }

    // Snapshot the activity gate BEFORE any repair write. Repair-created marker
    // turns and link-only writes are not user activity; if the gate read them it
    // would classify a stale resume-glance as a live run and start finalizing a
    // previous run's orphans (the "glance leaves an older run's orphan turn
    // untouched" regression).
    const hadNewTurnBeforeRepair = hasNewTurnSinceSessionRunStart(
      dependencies.db,
      session.id,
    );
    // …and take a CONCRETE fence in the same breath. The boolean alone does not
    // bound what the later orphan pass may finalize: a UserPromptSubmit that
    // commits a live turn between here and there would otherwise be marked
    // skipped while still running. Turn ids are monotonic, so "id ≤ snapshot"
    // is exactly the set that existed at gate-read time — which also puts every
    // repair-inserted marker out of scope for free.
    const maxTurnIdSnapshot = getMaxTurnId(dependencies.db, session.id);

    // Bounded backstop scan (spec §F). Anything past the cap defers to the next
    // resume event for this content session; if no later event ever arrives the
    // remainder is accepted as lost — the explicit completeness limit.
    const transcriptPath =
      input.transcriptPath ?? resolveSessionTranscriptPath(session);
    const repairLog =
      dependencies.captureRepairLog ??
      ((message: string) => process.stderr.write(`[claude-mnemo] ${message}\n`));
    const maxLines =
      dependencies.captureRepairMaxLines ?? SESSION_END_SCAN_MAX_LINES;

    // Best effort, and strictly subordinate: repair runs in its own deadline-
    // bounded transaction and swallows its own failures, because orphan
    // finalization below is what unblocks the diary readiness gate. Sharing one
    // transaction (or letting a repair throw) would make a bad transcript
    // re-block it.
    let repairTruncated = false;
    let repairStoppedForDeadline = false;
    const budgetBeforeRepairMs = repairDeadlineMs - nowMs();

    if (budgetBeforeRepairMs < SESSION_END_REPAIR_MIN_BUDGET_MS) {
      repairLog(
        `session-end capture repair skipped for session ${session.id}: only ` +
          `${budgetBeforeRepairMs}ms of the ${SESSION_END_REPAIR_BUDGET_MS}ms ` +
          `budget left; deferred to the next resume`,
      );
    } else {
      try {
        const outcome = captureRepairRunner(
          dependencies.db,
          session,
          transcriptPath,
          {
            nowEpoch: now(),
            log: repairLog,
            maxLines,
            batchLines:
              dependencies.captureRepairBatchLines ??
              SESSION_END_SCAN_BATCH_LINES,
            deadlineMs: repairDeadlineMs,
            nowMs,
            writeTransaction: (db, work) =>
              writeTransaction(db, work, {
                // The busy-retry budget is the SAME wall clock, not a second
                // one: a lock fight cannot push past the repair deadline.
                budgetMs: Math.max(0, repairDeadlineMs - nowMs()),
              }),
          },
        );
        repairTruncated = outcome?.truncated ?? false;
        repairStoppedForDeadline = outcome?.stoppedForDeadline ?? false;
      } catch (error) {
        repairLog(
          `session-end capture repair failed for session ${session.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (repairStoppedForDeadline) {
      repairLog(
        `session-end capture repair hit its ${SESSION_END_REPAIR_BUDGET_MS}ms ` +
          `budget for session ${session.id}; remainder deferred to the next resume`,
      );
    } else if (repairTruncated) {
      repairLog(
        `session-end capture repair hit its ${maxLines}-line budget for ` +
          `session ${session.id}; remainder deferred to the next resume`,
      );
    }

    // A turn interrupted mid-response will never receive more content after
    // the session exits. Enqueueing a turn-stop here only works if the
    // session's env is still registered at the exact moment SessionEnd runs;
    // that precondition necessarily fails, stranding the queue item and
    // leaving the turn active forever, which permanently blocks the diary
    // readiness gate. Finalize these orphans directly without enqueueing.
    if (hadNewTurnBeforeRepair && maxTurnIdSnapshot !== null) {
      // `beforeTurnId` is exclusive, so +1 makes the fence "id ≤ snapshot".
      const orphanTurns = getOrphanTurns(
        dependencies.db,
        session.id,
        maxTurnIdSnapshot + 1,
      );
      if (orphanTurns.length > 0) {
        writeTransaction(dependencies.db, () => {
          skipOrphanTurns(dependencies.db, session.id, now(), orphanTurns);
        });
      }
    }

    // Write gate (ticket 01, read-write-contract spec "回收"): this session
    // is terminating, so its own read grants are cleared, plus an
    // opportunistic bounded sweep of any OTHER completed session's grants —
    // the janitor backstop for a miss (a crash between an earlier session's
    // completion and its own SessionEnd call). Best-effort and strictly
    // subordinate, same discipline as the repair above: a failure here must
    // never block orphan finalization, which the diary readiness gate is
    // waiting on.
    try {
      writeTransaction(dependencies.db, () => {
        clearReadGrantsForWriter(dependencies.db, sessionWriterId(session.id));
        sweepReadGrantsForCompletedSessions(
          dependencies.db,
          WRITE_GATE_JANITOR_SWEEP_LIMIT,
        );
      });
    } catch (error) {
      repairLog(
        `session-end write-gate cleanup failed for session ${session.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    // No settlement window is frozen or enqueued here any more (ticket 04,
    // [S15069/T963]): turn-stop planning is the only automatic trigger, and
    // settlement reads the database rather than live context, so SessionEnd
    // carries no urgency the next turn-stop (this session's own, or another
    // session's leak) cannot satisfy just as well. The accepted consequence:
    // a session that ends with an undecided tail under the threshold leaves
    // that tail unsettled until it accumulates into a later window.

    return {
      continue: true,
      asyncWork: async () => {
        await notifyWorkerFlush(
          session.id,
          session.contentSessionId,
          dependencies.workerClientDeps,
          dependencies.workerEnv,
        );
      },
    };
  };
}
