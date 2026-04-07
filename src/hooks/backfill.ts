import type { Database } from "bun:sqlite";

import { updateTurnBackfill, type TurnRecord } from "../db/turns";
import {
  parseReplayTranscript,
  type ParsedReplayTurn,
} from "../shared/transcript-parser";

function buildReplayTurnLookup(
  transcriptTurns: ParsedReplayTurn[],
): Map<number, ParsedReplayTurn> {
  return new Map(transcriptTurns.map((turn) => [turn.promptNumber, turn]));
}

export function backfillFromTranscript(
  db: Database,
  pendingTurns: TurnRecord[],
  transcriptPath?: string,
  lastAssistantMessage?: string,
  transcriptTurnsByPromptNumber?: Map<number, ParsedReplayTurn>,
): void {
  if (pendingTurns.length === 0) {
    return;
  }

  const replayTurnsByPromptNumber =
    transcriptTurnsByPromptNumber ??
    buildReplayTurnLookup(
      transcriptPath ? parseReplayTranscript(transcriptPath) : [],
    );
  const lastPendingPromptNumber =
    pendingTurns[pendingTurns.length - 1]?.promptNumber;

  for (const pendingTurn of pendingTurns) {
    if (pendingTurn.assistantResponse || !pendingTurn.userPrompt) {
      continue;
    }

    const transcriptTurn = replayTurnsByPromptNumber.get(
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
