import type { Database } from "bun:sqlite";

import { captureConsultedMemories } from "../../db/consulted-memories";
import { runHookWriteTransaction } from "../../db/database";
import { settleOutstandingTurns } from "../../db/turn-settlement";
import { createObservation } from "../../db/observations";
import { getSessionByContentId } from "../../db/sessions";
import { resolveEraCutoff } from "../../db/era";
import type { TurnStatus } from "../../db/turns";
import { isExtractionExcludedToolName } from "../../shared/note-tool";
import { stripPrivateTags } from "../../shared/tag-stripping";
import type { HookResult, NormalizedHookInput } from "../types";

export interface PostToolUseHandlerDependencies {
  db: Database;
  now?: () => number;
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
      // Settlement (ticket 02, spec D10): db/turn-settlement.ts is the only
      // caller of `settleCompletedTurn`, so a turn's terminal status, file
      // sets and tool count land here as a catch-up sweep — only turns still
      // `active`/`provisional` with completion evidence are touched, so this
      // costs one bounded indexed query when nothing is new.
      //
      // The note-debt ledger itself needs no sweep any more (spec D1): owed
      // turns are a derived query `session-init` runs at prompt time, not a
      // classification this hook maintains.
      //
      // Wrapped: settlement must never be able to abort the capture write it
      // shares a transaction with — a lost sweep costs a delayed terminal
      // status, not the observation this hook exists to record.
      try {
        settleOutstandingTurns(
          dependencies.db,
          session.id,
          eraCutoffEpoch,
          createdAtEpoch,
        );
      } catch (error) {
        logger.warn?.("turn settlement failed", {
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

      // Through `createObservation` rather than a second INSERT of its own, so
      // that capture goes through the writer that also indexes. This hook had
      // its own copy of the statement, which meant the row was written and
      // never indexed: the observation layer's search index was in fact being
      // filled later, by the extraction agent's writeback marking each row
      // `extracted`/`skipped`. Ticket 15 deleted that agent, and with it the
      // only thing that had ever put an observation into `memory_fts` — so the
      // layer stopped being searchable at all, rather than merely stopping at
      // the read filter.
      createObservation(dependencies.db, {
        turnId: latestTurn.id,
        toolName,
        toolInput,
        toolResult,
        excludedFromExtraction,
        createdAtEpoch,
      });

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

      // There used to be a fork here: an extraction-excluded call (`note`)
      // returned early to skip enqueueing it for the retired extraction
      // agent's input stream, while everything else went on to enqueue and
      // wake the worker (observation-queue-teardown ticket). Nothing past
      // this point reads that distinction any more, so both captures now
      // share the one outcome.
      return { outcome: "captured" as const, turnId: latestTurn.id };
    });

    if (writeResult.outcome !== "captured") {
      logger.warn?.("post-tool-use ignored", {
        sessionId: input.sessionId,
        turnId: writeResult.turnId,
        reasonCode: writeResult.outcome,
      });
    }

    return { continue: true };
  };
}
