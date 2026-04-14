import type { Database } from "bun:sqlite";

import { updateTurnBackfill, type TurnRecord } from "../db/turns";
import {
  parseReplayTranscript,
  type ParsedReplayTurn,
} from "../shared/transcript-parser";

export function backfillFromTranscript(
  db: Database,
  pendingTurns: TurnRecord[],
  transcriptPath?: string,
  lastAssistantMessage?: string,
  transcriptTurns?: ParsedReplayTurn[],
): void {
  if (pendingTurns.length === 0) {
    return;
  }

  const replayTurns =
    transcriptTurns ??
    (transcriptPath ? parseReplayTranscript(transcriptPath) : []);
  const lastPendingPromptNumber =
    pendingTurns[pendingTurns.length - 1]?.promptNumber;

  for (const pendingTurn of pendingTurns) {
    if (pendingTurn.assistantResponse || !pendingTurn.userPrompt) {
      continue;
    }

    const isLatestPendingTurn =
      pendingTurn.promptNumber === lastPendingPromptNumber;
    const transcriptTurn = isLatestPendingTurn
      ? replayTurns[replayTurns.length - 1]
      : replayTurns.find(
          (turn) => turn.promptNumber === pendingTurn.promptNumber,
        );

    if (!transcriptTurn && !isLatestPendingTurn) {
      continue;
    }

    const assistantResponse =
      isLatestPendingTurn && lastAssistantMessage !== undefined
        ? lastAssistantMessage
        : transcriptTurn?.assistantText ?? "";
    const toolCallCount = transcriptTurn?.toolCalls.length ?? 0;
    const contentPromptId =
      isLatestPendingTurn && transcriptTurn?.promptId
        ? transcriptTurn.promptId
        : undefined;

    updateTurnBackfill(
      db,
      pendingTurn.id,
      assistantResponse,
      toolCallCount,
      contentPromptId,
      transcriptTurn?.transcriptLineStart,
    );
  }
}
