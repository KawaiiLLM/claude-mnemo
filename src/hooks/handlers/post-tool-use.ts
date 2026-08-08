import type { Database } from "bun:sqlite";

import { runHookWriteTransaction } from "../../db/database";
import { getSessionByContentId } from "../../db/sessions";
import type { TurnStatus } from "../../db/turns";
import { isExtractionExcludedToolName } from "../../shared/note-tool";
import { stripPrivateTags } from "../../shared/tag-stripping";
import { notifyWorkerTrigger, type WorkerClientDeps } from "../../worker/client";
import type { HookResult, NormalizedHookInput } from "../types";

export interface PostToolUseHandlerDependencies {
  db: Database;
  now?: () => number;
  workerClientDeps?: WorkerClientDeps;
  workerEnv?: NodeJS.ProcessEnv;
  runHookWriteTransaction?: typeof runHookWriteTransaction;
  logger?: Pick<Console, "warn">;
}

function stringifyToolPayload(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }

  const normalized =
    typeof value === "string" ? value : JSON.stringify(value);
  return stripPrivateTags(normalized);
}

function getLatestTurn(
  db: Database,
  sessionDbId: number,
): { id: number; status: TurnStatus } | null {
  const row = db
    .query<{ id: number; status: TurnStatus }, [number]>(
      `SELECT id, status FROM turns WHERE session_id = ? ORDER BY prompt_number DESC LIMIT 1`,
    )
    .get(sessionDbId);

  return row ?? null;
}

export function createPostToolUseHandler(
  dependencies: PostToolUseHandlerDependencies,
) {
  const now = dependencies.now ?? (() => Math.floor(Date.now() / 1000));
  const writeTransaction = dependencies.runHookWriteTransaction ?? runHookWriteTransaction;
  const logger = dependencies.logger ?? console;

  return async function handlePostToolUseHook(
    input: NormalizedHookInput,
  ): Promise<HookResult> {
    if (input.agentId !== undefined) {
      logger.warn?.("post-tool-use ignored", {
        sessionId: input.sessionId ?? null,
        reasonCode: "child-agent-sidechain",
      });
      return { continue: true };
    }

    if (!input.sessionId || !input.toolName) {
      return { continue: true };
    }

    const session = getSessionByContentId(dependencies.db, input.sessionId);
    if (!session) {
      return { continue: true };
    }

    const createdAtEpoch = now();
    const toolName = input.toolName;
    const toolInput = stringifyToolPayload(input.toolInput);
    const toolResult = stringifyToolPayload(input.toolResponse);
    // A `note` call is the agent's bookkeeping about a turn, not work inside
    // it. Record it (the raw axis stays complete) but withhold it from the
    // extraction pipeline: mark the row and never enqueue it, so it reaches
    // neither the extraction agent's observation stream nor the turn's
    // tool_call_count. See shared/note-tool.ts.
    const excludedFromExtraction = isExtractionExcludedToolName(toolName);

    const writeResult = writeTransaction(dependencies.db, () => {
      const latestTurn = getLatestTurn(dependencies.db, session.id);
      if (!latestTurn) {
        return { outcome: "no-root-turn" as const, turnId: null };
      }
      if (latestTurn.status !== "active" && latestTurn.status !== "provisional") {
        return { outcome: "terminal-root-turn" as const, turnId: latestTurn.id };
      }

      const inserted = dependencies.db
        .query<
          { id: number },
          [
            number,
            string,
            string | null,
            string | null,
            number,
            number,
          ]
        >(
          `
            INSERT INTO observations (
              turn_id,
              tool_name,
              tool_input,
              tool_result,
              excluded_from_extraction,
              created_at_epoch
            ) VALUES (?, ?, ?, ?, ?, ?)
            RETURNING id
          `,
        )
        .get(
          latestTurn.id,
          toolName,
          toolInput,
          toolResult,
          excludedFromExtraction ? 1 : 0,
          createdAtEpoch,
        );

      if (!inserted) {
        throw new Error("Failed to enqueue observation for worker processing.");
      }

      if (excludedFromExtraction) {
        return { outcome: "excluded" as const, turnId: latestTurn.id };
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
      return { outcome: "inserted" as const, turnId: latestTurn.id };
    });

    // "excluded" is a successful capture, not a dropped one — it is only the
    // enqueue that is skipped, so it must not be logged as ignored.
    if (writeResult.outcome === "excluded") {
      return { continue: true };
    }

    if (writeResult.outcome !== "inserted") {
      logger.warn?.("post-tool-use ignored", {
        sessionId: input.sessionId,
        turnId: writeResult.turnId,
        reasonCode: writeResult.outcome,
      });
      return { continue: true };
    }

    return {
      continue: true,
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
