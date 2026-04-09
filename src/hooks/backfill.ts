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
  const consumed = new Set<number>();

  for (const pendingTurn of pendingTurns) {
    if (pendingTurn.assistantResponse || !pendingTurn.userPrompt) {
      continue;
    }

    let matchIndex = replayTurns.findIndex(
      (turn, index) =>
        !consumed.has(index) && turn.userPrompt === pendingTurn.userPrompt,
    );

    if (matchIndex < 0) {
      matchIndex = replayTurns.findIndex(
        (turn, index) =>
          !consumed.has(index) &&
          turn.promptNumber === pendingTurn.promptNumber,
      );
    }

    const transcriptTurn = matchIndex >= 0 ? replayTurns[matchIndex] : undefined;
    const assistantResponse =
      pendingTurn.promptNumber === lastPendingPromptNumber &&
      lastAssistantMessage !== undefined
        ? lastAssistantMessage
        : transcriptTurn?.assistantText ?? "";
    const toolCallCount = transcriptTurn?.toolCalls.length ?? 0;

    if (matchIndex >= 0) {
      consumed.add(matchIndex);
    }

    updateTurnBackfill(
      db,
      pendingTurn.id,
      assistantResponse,
      toolCallCount,
      transcriptTurn?.promptId,
    );
  }
}
