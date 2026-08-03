import type { Database } from "bun:sqlite";

import { updateTurnBackfill, type TurnRecord } from "../db/turns";
import { stripPrivateTags } from "../shared/tag-stripping";
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
    // A compact marker is immutable once claimed (spec §F). It normally has no
    // user_prompt and so falls out here anyway — but the occupied-promptId
    // CONVERSION deliberately preserves user_prompt while clearing
    // assistant_response, which is exactly this predicate's "backfillable"
    // shape. Without the type guard the next Stop would write a derived
    // response and tool count back onto the marker.
    if (
      pendingTurn.type === "compact" ||
      pendingTurn.assistantResponse ||
      !pendingTurn.userPrompt
    ) {
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

    // Parser output is raw — strip <private> before it can reach the DB. The
    // Stop hook already strips lastAssistantMessage; the transcript-derived
    // branches (orphan response + the full transcript) must do the same.
    const transcriptText = transcriptTurn?.assistantText
      ? stripPrivateTags(transcriptTurn.assistantText)
      : "";
    const assistantResponse =
      isLatestPendingTurn && lastAssistantMessage !== undefined
        ? lastAssistantMessage
        : transcriptText;
    // Full interleaved narration (every assistant text block) for replay. Treat
    // blank parser output as missing so we fall back to the (already-stripped)
    // final message instead of overwriting with an empty string.
    const assistantTranscript = transcriptText || assistantResponse || null;
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
      assistantTranscript,
    );
  }
}
