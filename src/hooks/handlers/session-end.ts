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
import { enqueueSessionEndSettlementJob } from "../../db/settlement";
import { resolveTranscriptPath } from "../../shared/paths";
import { runCaptureRepair, type CaptureRepairLog } from "../capture-repair";
import type { HookResult, NormalizedHookInput } from "../types";

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
      input.transcriptPath ??
      resolveTranscriptPath(session.project, session.contentSessionId);
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

    // Settlement tail gate (spec §A). A session that ends mid-window has no
    // further extraction coming to cross the next boundary, so its trailing
    // turns would keep their provisional grades forever. Gated on the SAME
    // pre-repair activity snapshot the orphan pass uses — a bare resume glance
    // must not spend an inference re-grading a window nothing changed in — and
    // on the terminal count having passed the last SUCCESSFULLY settled
    // boundary. Enqueue only: the settle itself runs in the worker, so this
    // stays a single INSERT inside the SessionEnd budget.
    //
    // Runs AFTER the orphan pass, deliberately. The tail's boundary and its
    // frozen cohort are both computed from the session's terminal turns, and an
    // orphan the line above just marked `skipped` is one of them. Enqueueing
    // first froze a cohort one short and set a boundary no later event will ever
    // cross again, leaving that last turn permanently provisional. The activity
    // SNAPSHOT still comes from before the repair — only this enqueue moved.
    try {
      enqueueSessionEndSettlementJob(
        dependencies.db,
        session.id,
        now(),
        hadNewTurnBeforeRepair,
      );
    } catch (error) {
      repairLog(
        `session-end settlement enqueue failed for session ${session.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

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
