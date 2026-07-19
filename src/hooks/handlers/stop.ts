import type { Database } from "bun:sqlite";

import { runHookWriteTransaction } from "../../db/database";
import { markSettledDiaryDayStaleForTurn } from "../../db/diary-state";
import { getSessionByContentId, upsertSession } from "../../db/sessions";
import { enqueueQueueItem } from "../../db/pending-queue";
import {
  enqueueOrphanTurnStops,
  getOrphanTurns,
} from "../../db/orphan-turns";
import { relinkSessionLineageFromEntries } from "../../db/lineage";
import { recoverStrandedAncestors } from "../../db/recover-stranded";
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
import { HOOK_SUCCESS_EXIT_CODE } from "../../shared/hook-constants";
import { backfillFromTranscript } from "../backfill";
import type { HookResult, NormalizedHookInput } from "../types";

export interface StopHandlerDependencies {
  db: Database;
  now?: () => number;
  workerClientDeps?: WorkerClientDeps;
  workerEnv?: NodeJS.ProcessEnv;
  runHookWriteTransaction?: typeof runHookWriteTransaction;
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
      recoverStrandedAncestors(dependencies.db, session.id, epoch);

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

      if (
        assistantResponse !== null &&
        assistantResponse !== turn.assistantResponse
      ) {
        markSettledDiaryDayStaleForTurn(
          dependencies.db,
          turn.createdAtEpoch,
        );
      }

      if (!hasTurnStopTask(dependencies.db, turn.id)) {
        enqueueQueueItem(dependencies.db, {
          kind: "turn-stop",
          targetId: turn.id,
          sessionDbId: session.id,
          enqueuedAtEpoch: epoch,
        });
      }

      upsertSession(dependencies.db, {
        contentSessionId: session.contentSessionId,
        project: session.project,
        title: session.title,
        content: session.content,
        insight: session.insight,
        nextSteps: session.nextSteps,
        createdAtEpoch: session.createdAtEpoch,
        updatedAtEpoch: epoch,
        completedAtEpoch: epoch,
      });

      if (parsedTurns) {
        detectAndCleanSubagentTurnsFromParsed(
          dependencies.db,
          session.id,
          parsedTurns,
          epoch,
        );
      }
    });

    return {
      continue: true,
      exitCode: HOOK_SUCCESS_EXIT_CODE,
      asyncWork: async () => {
        await notifyWorkerTrigger(
          {
            action: "wake",
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
