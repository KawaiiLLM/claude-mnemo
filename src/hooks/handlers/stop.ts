import type { Database } from "bun:sqlite";

import { getSessionByContentId, upsertSession } from "../../db/sessions";
import { enqueueQueueItem } from "../../db/pending-queue";
import { stripPrivateTags } from "../../shared/tag-stripping";
import { extractAssistantResponse } from "../../shared/transcript-parser";
import { notifyWorkerWake, type WorkerClientDeps } from "../../worker/client";
import { detectAndCleanSidechainTurns } from "../../worker/rollback";
import { HOOK_SUCCESS_EXIT_CODE } from "../../shared/hook-constants";
import type { HookResult, NormalizedHookInput } from "../types";

export interface StopHandlerDependencies {
  db: Database;
  now?: () => number;
  workerClientDeps?: WorkerClientDeps;
  workerEnv?: NodeJS.ProcessEnv;
}

function getLatestTurn(
  db: Database,
  sessionDbId: number,
): { id: number; promptNumber: number } | null {
  const row = db
    .query<{ id: number; promptNumber: number }, [number]>(
      `
        SELECT id, prompt_number AS promptNumber
        FROM turns
        WHERE session_id = ?
        ORDER BY prompt_number DESC
        LIMIT 1
      `,
    )
    .get(sessionDbId);

  return row ?? null;
}

function getOrphanTurns(
  db: Database,
  sessionDbId: number,
  currentTurnId: number,
): Array<{ id: number; promptNumber: number; userPrompt: string | null }> {
  return db
    .query<
      { id: number; promptNumber: number; userPrompt: string | null },
      [number, number]
    >(
      `
        SELECT
          t.id,
          t.prompt_number AS promptNumber,
          t.user_prompt AS userPrompt
        FROM turns t
        WHERE t.session_id = ?
          AND t.status = 'active'
          AND t.id < ?
          AND t.assistant_response IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM pending_queue q
            WHERE q.kind = 'turn-stop' AND q.target_id = t.id
          )
        ORDER BY t.prompt_number ASC
      `,
    )
    .all(sessionDbId, currentTurnId);
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
    const orphanTurns = getOrphanTurns(dependencies.db, session.id, turn.id);

    dependencies.db.transaction(() => {
      for (const orphanTurn of orphanTurns) {
        const orphanAssistantResponse =
          input.transcriptPath && orphanTurn.userPrompt
            ? extractAssistantResponse(
                input.transcriptPath,
                orphanTurn.userPrompt,
                orphanTurn.promptNumber,
              )
            : "";

        dependencies.db
          .query<unknown, [string, number, number]>(
            `
              UPDATE turns
              SET assistant_response = ?,
                  updated_at_epoch = ?
              WHERE id = ?
            `,
          )
          .run(orphanAssistantResponse, epoch, orphanTurn.id);

        enqueueQueueItem(dependencies.db, {
          kind: "turn-stop",
          targetId: orphanTurn.id,
          sessionDbId: session.id,
          enqueuedAtEpoch: epoch,
        });
      }

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

      if (!hasTurnStopTask(dependencies.db, turn.id)) {
        enqueueQueueItem(dependencies.db, {
          kind: "turn-stop",
          targetId: turn.id,
          sessionDbId: session.id,
          enqueuedAtEpoch: epoch,
        });
      }
    })();

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

    if (input.transcriptPath) {
      detectAndCleanSidechainTurns(
        dependencies.db,
        session.id,
        input.transcriptPath,
        epoch,
      );
    }

    await notifyWorkerWake(
      dependencies.workerClientDeps,
      dependencies.workerEnv,
    );

    return {
      continue: true,
      exitCode: HOOK_SUCCESS_EXIT_CODE,
    };
  };
}
