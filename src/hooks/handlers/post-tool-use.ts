import type { Database } from "bun:sqlite";

import { captureConsultedMemories } from "../../db/consulted-memories";
import { runHookWriteTransaction } from "../../db/database";
import { reconcileNoteDebt } from "../../db/note-debt";
import { getSessionByContentId } from "../../db/sessions";
import { resolveEraCutoff } from "../../db/era";
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
  /**
   * P2 era boundary (spec D11), read once at handler construction. The ledger's
   * classification sweep settles the turns it walks, and the era decides what an
   * un-noted one is settled to. Omitted, it comes from config (default `null` =
   * legacy).
   */
  eraCutoffEpoch?: number | null;
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
  const eraCutoffEpoch =
    dependencies.eraCutoffEpoch !== undefined
      ? dependencies.eraCutoffEpoch
      : resolveEraCutoff(dependencies.db);

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
      // Note-debt ownership (spec D2/D3): the asynchronous capture entry
      // maintains the ledger, the synchronous reminder entry only reads it.
      // Here it is a catch-up sweep — only turns older than the open one are
      // classified — and it costs one indexed query when nothing is new.
      //
      // It catches up on turns whose Stop was CAPTURED but whose reconcile did
      // not land. A turn whose Stop was never captured at all is stranded, not
      // finished, and the sweep stops at it rather than reading its half-landed
      // observations as a verdict; the liveness repair restores its turn-stop
      // and the next sweep walks on.
      //
      // Wrapped: the shadow ledger is a P1 trial artefact and must never be
      // able to abort the capture write it shares a transaction with.
      try {
        reconcileNoteDebt(dependencies.db, {
          sessionId: session.id,
          nowEpoch: createdAtEpoch,
          eraCutoffEpoch,
        });
      } catch (error) {
        logger.warn?.("note debt reconcile failed", {
          sessionId: input.sessionId,
          reasonCode: "post-tool-use-sweep",
          error: error instanceof Error ? error.message : String(error),
        });
      }

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

      // Mechanical retrieval provenance (spec D4/D7): which stored records this
      // turn's recall/replay calls actually reached. Wrapped like the note-debt
      // sweep — an observation about memory use must never abort the capture it
      // rides along with.
      try {
        captureConsultedMemories(dependencies.db, latestTurn.id, {
          toolName,
          toolInput,
          toolResult,
        });
      } catch (error) {
        logger.warn?.("consulted memories capture failed", {
          sessionId: input.sessionId,
          turnId: latestTurn.id,
          reasonCode: "post-tool-use-consulted",
          error: error instanceof Error ? error.message : String(error),
        });
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
