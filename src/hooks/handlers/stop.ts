import type { Database } from "bun:sqlite";

import { getSessionByContentId, upsertSession } from "../../db/sessions";
import {
  claimTurnsForExtraction,
  getPendingTurns,
  recoverStalledExtractions,
  getTurnsForSession,
  markTurnsStale,
} from "../../db/turns";
import { buildExtractionContext } from "../../mnemosyne/context";
import { forkMnemosyne } from "../../mnemosyne/fork";
import { buildMnemosynePrompt } from "../../mnemosyne/prompt";
import {
  normalizeAssistantText,
  parseReplayTranscript,
  type ParsedReplayTurn,
} from "../../shared/transcript-parser";
import { HOOK_SUCCESS_EXIT_CODE } from "../../shared/hook-constants";
import { backfillFromTranscript } from "../backfill";
import type { HookResult, NormalizedHookInput } from "../types";

export interface StopHandlerDependencies {
  db: Database;
  forkMnemosyne: typeof forkMnemosyne;
  stderr?: Pick<NodeJS.WriteStream, "write">;
  now?: () => number;
}

function buildStopPrompt(db: Database, sessionDbId: number): string {
  return buildMnemosynePrompt(buildExtractionContext(db, sessionDbId));
}

function detectUndoPromptNumbers(
  db: Database,
  sessionDbId: number,
  transcriptPath?: string,
  transcriptTurns?: ParsedReplayTurn[],
): number[] {
  if (!transcriptPath) {
    return [];
  }

  const replayTurns = transcriptTurns ?? parseReplayTranscript(transcriptPath);
  const replayTurnsByPromptNumber = new Map(
    replayTurns.map((turn) => [turn.promptNumber, turn]),
  );
  const replayTurnsByPromptId = new Map(
    replayTurns
      .filter((turn) => turn.promptId)
      .map((turn) => [turn.promptId as string, turn]),
  );

  return getTurnsForSession(db, sessionDbId)
    .filter(
      (turn) =>
        (turn.status === "extracted" || turn.status === "skipped") &&
        turn.userPrompt,
    )
    .filter((turn) => {
      const transcriptTurnByPromptId = turn.contentPromptId
        ? replayTurnsByPromptId.get(turn.contentPromptId)
        : undefined;
      const transcriptTurn =
        transcriptTurnByPromptId ??
        replayTurnsByPromptNumber.get(turn.promptNumber);

      if (!transcriptTurn) {
        return false;
      }

      if (transcriptTurn.isSidechain) {
        return true;
      }

      return transcriptTurn.assistantText !== normalizeAssistantText(turn.assistantResponse ?? "");
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

    const epoch = now();

    recoverStalledExtractions(dependencies.db, session.id, 300, epoch);

    const transcriptTurns = input.transcriptPath
      ? parseReplayTranscript(input.transcriptPath)
      : undefined;

    backfillFromTranscript(
      dependencies.db,
      getPendingTurns(dependencies.db, session.id).filter(
        (turn) => turn.status === "pending",
      ),
      input.transcriptPath,
      input.lastAssistantMessage,
      transcriptTurns,
    );

    const stalePromptNumbers = detectUndoPromptNumbers(
      dependencies.db,
      session.id,
      input.transcriptPath,
      transcriptTurns,
    );

    markTurnsStale(dependencies.db, session.id, stalePromptNumbers);

    const claimedCount = claimTurnsForExtraction(
      dependencies.db,
      session.id,
      epoch,
    );

    upsertSession(dependencies.db, {
      contentSessionId: session.contentSessionId,
      project: session.project,
      title: session.title,
      content: session.content,
      insight: session.insight,
      createdAtEpoch: session.createdAtEpoch,
      updatedAtEpoch: epoch,
      completedAtEpoch: epoch,
    });

    stderr.write(`Mnemosyne: ${claimedCount} turns queued for extraction\n`);

    if (claimedCount > 0) {
      const prompt = buildStopPrompt(dependencies.db, session.id);

      return {
        continue: true,
        exitCode: HOOK_SUCCESS_EXIT_CODE,
        asyncWork: async () => {
          await dependencies.forkMnemosyne({
            cwd: input.cwd,
            prompt,
            database: dependencies.db,
          });
        },
      };
    }

    return {
      continue: true,
      exitCode: HOOK_SUCCESS_EXIT_CODE,
    };
  };
}
