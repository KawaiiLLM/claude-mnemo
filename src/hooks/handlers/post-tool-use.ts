import type { Database } from "bun:sqlite";

import { getSessionByContentId } from "../../db/sessions";
import { stripPrivateTags } from "../../shared/tag-stripping";
import { notifyWorkerWake, type WorkerClientDeps } from "../../worker/client";
import type { HookResult, NormalizedHookInput } from "../types";

export interface PostToolUseHandlerDependencies {
  db: Database;
  now?: () => number;
  workerClientDeps?: WorkerClientDeps;
  workerEnv?: NodeJS.ProcessEnv;
}

function stringifyToolPayload(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }

  const normalized =
    typeof value === "string" ? value : JSON.stringify(value);
  return stripPrivateTags(normalized);
}

function getLatestTurnId(db: Database, sessionDbId: number): number | null {
  const row = db
    .query<{ id: number }, [number]>(
      `SELECT id FROM turns WHERE session_id = ? ORDER BY prompt_number DESC LIMIT 1`,
    )
    .get(sessionDbId);

  return row?.id ?? null;
}

export function createPostToolUseHandler(
  dependencies: PostToolUseHandlerDependencies,
) {
  const now = dependencies.now ?? (() => Math.floor(Date.now() / 1000));

  return async function handlePostToolUseHook(
    input: NormalizedHookInput,
  ): Promise<HookResult> {
    if (!input.sessionId || !input.toolName) {
      return { continue: true };
    }

    const session = getSessionByContentId(dependencies.db, input.sessionId);
    if (!session) {
      return { continue: true };
    }

    const latestTurnId = getLatestTurnId(dependencies.db, session.id);
    if (!latestTurnId) {
      return { continue: true };
    }

    const createdAtEpoch = now();
    const toolName = input.toolName;
    const toolInput = stringifyToolPayload(input.toolInput);
    const toolResult = stringifyToolPayload(input.toolResponse);

    dependencies.db.transaction(() => {
      const inserted = dependencies.db
        .query<
          { id: number },
          [
            number,
            string,
            string | null,
            string | null,
            number,
          ]
        >(
          `
            INSERT INTO observations (
              turn_id,
              tool_name,
              tool_input,
              tool_result,
              created_at_epoch
            ) VALUES (?, ?, ?, ?, ?)
            RETURNING id
          `,
        )
        .get(
          latestTurnId,
          toolName,
          toolInput,
          toolResult,
          createdAtEpoch,
        );

      if (!inserted) {
        throw new Error("Failed to enqueue observation for worker processing.");
      }

      dependencies.db
        .query<unknown, [number, number, number]>(
          `
            INSERT INTO pending_queue (
              kind,
              target_id,
              session_db_id,
              enqueued_at_epoch
            ) VALUES ('obs', ?, ?, ?)
          `,
        )
        .run(inserted.id, session.id, createdAtEpoch);
    })();

    return {
      continue: true,
      asyncWork: async () => {
        await notifyWorkerWake(
          dependencies.workerClientDeps,
          dependencies.workerEnv,
        );
      },
    };
  };
}
