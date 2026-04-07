import type { Database } from "bun:sqlite";

import { getSessionByContentId, upsertSession } from "../../db/sessions";
import {
  getPendingTurns,
  getTurnsForSession,
  markTurnsStale,
} from "../../db/turns";
import { forkMnemosyne, type ForkMnemosyneResult } from "../../mnemosyne/fork";
import {
  buildExtractionStatusSummary,
  buildMnemosynePrompt,
} from "../../mnemosyne/prompt";
import {
  parseReplayTranscript,
  type ParsedReplayTurn,
} from "../../shared/transcript-parser";
import { HOOK_SUCCESS_EXIT_CODE } from "../../shared/hook-constants";
import { createLogger } from "../../shared/logger";
import { backfillFromTranscript } from "../backfill";
import type { HookResult, NormalizedHookInput } from "../types";

const log = createLogger("MNEMOSYNE");

export interface StopHandlerDependencies {
  db: Database;
  forkMnemosyne: typeof forkMnemosyne;
  stderr?: Pick<NodeJS.WriteStream, "write">;
  now?: () => number;
}

function buildStopPrompt(db: Database, sessionDbId: number): string {
  return buildMnemosynePrompt(
    buildExtractionStatusSummary(
      getTurnsForSession(db, sessionDbId).map((turn) => ({
        promptNumber: turn.promptNumber,
        status: turn.status as
          | "pending"
          | "stale"
          | "extracted"
          | "skipped"
          | "undone",
        promptPreview: turn.userPrompt ?? "",
      })),
    ),
  );
}

function detectUndoPromptNumbers(
  db: Database,
  sessionDbId: number,
  transcriptPath?: string,
  transcriptTurnsByPromptNumber?: Map<number, ParsedReplayTurn>,
): number[] {
  if (!transcriptPath) {
    return [];
  }

  const replayTurnsByPromptNumber =
    transcriptTurnsByPromptNumber ??
    new Map(
      parseReplayTranscript(transcriptPath).map((turn) => [turn.promptNumber, turn]),
    );

  return getTurnsForSession(db, sessionDbId)
    .filter(
      (turn) =>
        (turn.status === "extracted" || turn.status === "skipped") &&
        turn.userPrompt,
    )
    .filter((turn) => {
      const transcriptTurn = replayTurnsByPromptNumber.get(turn.promptNumber);

      if (!transcriptTurn) {
        return false;
      }

      if (transcriptTurn.isSidechain) {
        return true;
      }

      return transcriptTurn.assistantText !== (turn.assistantResponse ?? "");
    })
    .map((turn) => turn.promptNumber);
}

export function createStopHandler(dependencies: StopHandlerDependencies) {
  const now = dependencies.now ?? (() => Math.floor(Date.now() / 1000));
  const stderr = dependencies.stderr ?? process.stderr;

  return async function handleStopHook(
    input: NormalizedHookInput,
  ): Promise<HookResult> {
    if (input.stopHookActive) {
      return {
        continue: true,
        exitCode: HOOK_SUCCESS_EXIT_CODE,
      };
    }

    if (!input.sessionId) {
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

    const transcriptTurnsByPromptNumber = input.transcriptPath
      ? new Map(
          parseReplayTranscript(input.transcriptPath).map((turn) => [
            turn.promptNumber,
            turn,
          ]),
        )
      : undefined;

    backfillFromTranscript(
      dependencies.db,
      getPendingTurns(dependencies.db, session.id).filter(
        (turn) => turn.status === "pending",
      ),
      input.transcriptPath,
      input.lastAssistantMessage,
      transcriptTurnsByPromptNumber,
    );

    const stalePromptNumbers = detectUndoPromptNumbers(
      dependencies.db,
      session.id,
      input.transcriptPath,
      transcriptTurnsByPromptNumber,
    );

    markTurnsStale(dependencies.db, session.id, stalePromptNumbers);

    const pendingTurns = getPendingTurns(dependencies.db, session.id);

    if (pendingTurns.length > 0) {
      const result = await dependencies.forkMnemosyne({
        sessionId: input.sessionId,
        cwd: input.cwd,
        prompt: buildStopPrompt(dependencies.db, session.id),
      });

      if (result) {
        const cacheHitPct =
          result.inputTokens > 0
            ? Math.round(
                (result.cacheReadInputTokens / result.inputTokens) * 100,
              )
            : 0;
        log.info("extraction complete", {
          hook: "stop",
          turns: result.numTurns,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          cacheReadTokens: result.cacheReadInputTokens,
          cacheCreationTokens: result.cacheCreationInputTokens,
          cacheHitPct,
          durationMs: result.durationMs,
        });
      }
    }

    upsertSession(dependencies.db, {
      contentSessionId: session.contentSessionId,
      project: session.project,
      title: session.title,
      description: session.description,
      insight: session.insight,
      startedAtEpoch: session.startedAtEpoch,
      updatedAtEpoch: now(),
      completedAtEpoch: now(),
    });

    stderr.write(
      `Mnemosyne: ${pendingTurns.length} turns queued for extraction\n`,
    );

    return {
      continue: true,
      exitCode: HOOK_SUCCESS_EXIT_CODE,
    };
  };
}
