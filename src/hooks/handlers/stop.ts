import type { Database } from "bun:sqlite";

import { runHookWriteTransaction } from "../../db/database";
import { settleOutstandingTurns } from "../../db/turn-settlement";
import { getSessionByContentId, touchSessionCompletion } from "../../db/sessions";
import { enqueueQueueItem } from "../../db/pending-queue";
import {
  enqueueOrphanTurnStops,
  getOrphanTurns,
} from "../../db/orphan-turns";
import { relinkSessionLineageFromEntries } from "../../db/lineage";
import { recoverStrandedAncestors } from "../../db/recover-stranded";
import { reindexTurnFromDb } from "../../db/search";
import { getTurnsForSession } from "../../db/turns";
import {
  parseReplayTranscript,
  readAllTranscriptEntries,
} from "../../shared/transcript-parser";
import { stripPrivateTags } from "../../shared/tag-stripping";
import { notifyWorkerTrigger, type WorkerClientDeps } from "../../worker/client";
import {
  applyInvalidationSets,
  computeInvalidationSets,
} from "../../worker/invalidation";
import { detectAndCleanSubagentTurnsFromParsed } from "../../worker/subagent-filter";
import { resolveEraCutoff } from "../../db/era";
import { HOOK_SUCCESS_EXIT_CODE } from "../../shared/hook-constants";
import {
  backfillFromTranscript,
  backfillShadowNoteWriterModels,
} from "../backfill";
import type { HookResult, NormalizedHookInput } from "../types";

export interface StopHandlerDependencies {
  db: Database;
  now?: () => number;
  workerClientDeps?: WorkerClientDeps;
  workerEnv?: NodeJS.ProcessEnv;
  runHookWriteTransaction?: typeof runHookWriteTransaction;
  logger?: Pick<Console, "warn">;
  /**
   * P2 era boundary (spec D11), read once at handler construction. The ancestor
   * climb needs it so an era turn's promoted note survives the recovery.
   * Omitted, it comes from config, whose default (`null`) is the legacy path.
   */
  eraCutoffEpoch?: number | null;
}


function getLatestTurn(
  db: Database,
  sessionDbId: number,
): {
  id: number;
  promptNumber: number;
  assistantResponse: string | null;
  createdAtEpoch: number;
} | null {
  const row = db
    .query<
      {
        id: number;
        promptNumber: number;
        assistantResponse: string | null;
        createdAtEpoch: number;
      },
      [number]
    >(
      `
        SELECT
          id,
          prompt_number AS promptNumber,
          assistant_response AS assistantResponse,
          created_at_epoch AS createdAtEpoch
        FROM turns
        WHERE session_id = ?
        ORDER BY prompt_number DESC
        LIMIT 1
      `,
    )
    .get(sessionDbId);

  return row ?? null;
}

function hasTurnStopTask(db: Database, turnId: number): boolean {
  return (
    db
      .query<{ existsRow: number }, [number]>(
        `
          SELECT EXISTS(
            SELECT 1
            FROM pending_queue
            WHERE kind = 'turn-stop' AND target_id = ?
          ) AS existsRow
        `,
      )
      .get(turnId)?.existsRow === 1
  );
}

export function createStopHandler(dependencies: StopHandlerDependencies) {
  const now = dependencies.now ?? (() => Math.floor(Date.now() / 1000));
  const writeTransaction = dependencies.runHookWriteTransaction ?? runHookWriteTransaction;
  const logger = dependencies.logger ?? console;
  const eraCutoffEpoch =
    dependencies.eraCutoffEpoch !== undefined
      ? dependencies.eraCutoffEpoch
      : resolveEraCutoff(dependencies.db);

  return async function handleStopHook(
    input: NormalizedHookInput,
  ): Promise<HookResult> {
    if (input.stopHookActive || !input.sessionId) {
      return {
        continue: true,
        exitCode: HOOK_SUCCESS_EXIT_CODE,
      };
    }

    const session = getSessionByContentId(dependencies.db, input.sessionId);
    if (!session) {
      return {
        continue: true,
        exitCode: HOOK_SUCCESS_EXIT_CODE,
      };
    }

    const turn = getLatestTurn(dependencies.db, session.id);
    if (!turn) {
      return {
        continue: true,
        exitCode: HOOK_SUCCESS_EXIT_CODE,
      };
    }

    const epoch = now();
    const assistantResponse =
      input.lastAssistantMessage !== undefined
        ? stripPrivateTags(input.lastAssistantMessage)
        : null;
    const transcriptEntries = input.transcriptPath
      ? readAllTranscriptEntries(input.transcriptPath)
      : null;
    const parsedTurns = transcriptEntries
      ? parseReplayTranscript(input.transcriptPath ?? "", transcriptEntries)
      : null;
    const invalidationSets = transcriptEntries
      ? computeInvalidationSets(transcriptEntries)
      : null;

    writeTransaction(dependencies.db, () => {
      const orphanTurns = getOrphanTurns(dependencies.db, session.id, turn.id);

      if (transcriptEntries && parsedTurns && invalidationSets) {
        const allTurns = getTurnsForSession(dependencies.db, session.id);
        backfillFromTranscript(
          dependencies.db,
          allTurns,
          undefined,
          assistantResponse ?? undefined,
          parsedTurns,
        );
        applyInvalidationSets(
          dependencies.db,
          session.id,
          invalidationSets,
          epoch,
        );
      }

      // Relink this session's lineage (resolves parent_session_id) BEFORE the
      // ancestor climb, then re-enqueue any stranded ancestor tails so a forked
      // child's reopening recovers its parent's stranded work (spec §4/§5).
      // Runs on EVERY Stop (even without a transcript): relinkSessionLineage's
      // Step A maintains the intra-session parent_turn_id chain unconditionally,
      // while Step B harmlessly leaves the session "unresolved" (retryable) when
      // there is no transcript to resolve a parent from.
      relinkSessionLineageFromEntries(
        dependencies.db,
        session.id,
        transcriptEntries,
        epoch,
      );
      recoverStrandedAncestors(
        dependencies.db,
        session.id,
        epoch,
        eraCutoffEpoch,
      );

      enqueueOrphanTurnStops(dependencies.db, session.id, epoch, orphanTurns);

      dependencies.db
        .query<unknown, [string | null, number, number]>(
          `
            UPDATE turns
            SET assistant_response = COALESCE(?, assistant_response),
                updated_at_epoch = ?
            WHERE id = ?
          `,
        )
        .run(assistantResponse, epoch, turn.id);

      // The response is the second half of the turn's original text; index it
      // now, at capture, rather than when (or if) an extraction runs.
      reindexTurnFromDb(dependencies.db, turn.id);

      if (!hasTurnStopTask(dependencies.db, turn.id)) {
        enqueueQueueItem(dependencies.db, {
          kind: "turn-stop",
          targetId: turn.id,
          sessionDbId: session.id,
          enqueuedAtEpoch: epoch,
        });
      }

      // Write gate (ticket 03, read-write-contract spec "受管写者含 hook"):
      // narrow update — completedAtEpoch/updatedAtEpoch are Stop's own
      // fields, never a whole-row upsert of title/content/insight/nextSteps
      // re-read from the stale `session` snapshot captured at hook entry
      // (see `touchSessionCompletion`'s own doc for the TOCTOU this closes).
      touchSessionCompletion(dependencies.db, session.id, epoch, epoch);

      if (parsedTurns) {
        detectAndCleanSubagentTurnsFromParsed(
          dependencies.db,
          session.id,
          parsedTurns,
          epoch,
        );
      }

      // Settlement (ticket 02, spec D10): db/turn-settlement.ts is the only
      // caller of `settleCompletedTurn`, so this turn's terminal status, file
      // sets and tool count land here. The note-debt ledger needs no event of
      // its own any more (spec D1) — a turn owes a note the moment a later
      // prompt exists, which `session-init` reads as a derived query at
      // prompt time, not as something Stop classifies.
      //
      // Wrapped: a P1 trial artefact (the writer-model backfill) must never
      // abort the capture transaction it shares, and settlement inherits the
      // same tolerance.
      try {
        settleOutstandingTurns(dependencies.db, session.id, eraCutoffEpoch, epoch);

        if (parsedTurns) {
          backfillShadowNoteWriterModels(
            dependencies.db,
            session.id,
            parsedTurns,
          );
        }
      } catch (error) {
        logger.warn?.("turn settlement failed", {
          sessionId: input.sessionId,
          reasonCode: "stop-completion",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    return {
      continue: true,
      exitCode: HOOK_SUCCESS_EXIT_CODE,
      asyncWork: async () => {
        await notifyWorkerTrigger(
          {
            action: "turn-stop",
            contentSessionId: session.contentSessionId,
            sessionDbId: session.id,
          },
          dependencies.workerClientDeps,
          dependencies.workerEnv,
        );
      },
    };
  };
}
