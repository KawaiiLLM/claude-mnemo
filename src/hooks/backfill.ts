import type { Database } from "bun:sqlite";

import { updateTurnBackfill, type TurnRecord } from "../db/turns";
import { parseReplayTranscript } from "../shared/transcript-parser";

export function backfillFromTranscript(
  db: Database,
  pendingTurns: TurnRecord[],
  transcriptPath?: string,
  lastAssistantMessage?: string,
): void {
  if (pendingTurns.length === 0) {
    return;
  }

  const transcriptTurns = transcriptPath
    ? parseReplayTranscript(transcriptPath)
    : [];
  const transcriptTurnsByPromptNumber = new Map(
    transcriptTurns.map((turn) => [turn.promptNumber, turn]),
  );
  const lastPendingPromptNumber =
    pendingTurns[pendingTurns.length - 1]?.promptNumber;

  for (const pendingTurn of pendingTurns) {
    const transcriptTurn = transcriptTurnsByPromptNumber.get(
      pendingTurn.promptNumber,
    );
    const assistantResponse =
      pendingTurn.promptNumber === lastPendingPromptNumber &&
      lastAssistantMessage !== undefined
        ? lastAssistantMessage
        : transcriptTurn?.assistantText ?? "";
    const toolCallCount = transcriptTurn?.toolCalls.length ?? 0;

    updateTurnBackfill(
      db,
      pendingTurn.id,
      assistantResponse,
      toolCallCount,
    );
  }
}
