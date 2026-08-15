import type { Database } from "bun:sqlite";

import { updateTurnBackfill, type TurnRecord } from "../db/turns";
import { stripPrivateTags } from "../shared/tag-stripping";
import {
  parseReplayTranscript,
  type ParsedReplayTurn,
} from "../shared/transcript-parser";

/**
 * Fill `shadow_notes.writer_model` from the transcript (spec D4, ticket 03).
 *
 * The MCP process that writes a note cannot know which model is calling it —
 * Claude Code exposes no model identity to a tool server — so the note lands
 * with writer_model NULL and the capture side repairs it afterwards from
 * `message.model`, the only mechanical source there is.
 *
 * Keyed by `ride_turn_id`, not `turn_id`: writer_model answers "who wrote this
 * note", and the note was written during the ride turn, which is usually a later
 * turn than the one it is about (and, after a compact, can be much later). Only
 * NULL values are filled — a recorded model is a fact about a past write and a
 * re-parse must not restate it with today's model.
 */
export function backfillShadowNoteWriterModels(
  db: Database,
  sessionId: number,
  transcriptTurns: ParsedReplayTurn[],
): number {
  const hasUnattributedNote = db
    .query<{ present: number }, [number]>(
      `SELECT 1 AS present
       FROM shadow_notes n
       JOIN turns t ON t.id = n.ride_turn_id
       WHERE t.session_id = ? AND n.writer_model IS NULL
       LIMIT 1`,
    )
    .get(sessionId);
  if (!hasUnattributedNote) {
    return 0;
  }

  const byPromptId = db.query<{ id: number }, [number, string]>(
    "SELECT id FROM turns WHERE session_id = ? AND content_prompt_id = ?",
  );
  const byPromptNumber = db.query<{ id: number }, [number, number]>(
    "SELECT id FROM turns WHERE session_id = ? AND prompt_number = ?",
  );
  const update = db.query<unknown, [string, number]>(
    `UPDATE shadow_notes SET writer_model = ?
     WHERE ride_turn_id = ? AND writer_model IS NULL`,
  );

  let filled = 0;
  for (const transcriptTurn of transcriptTurns) {
    if (!transcriptTurn.assistantModel) {
      continue;
    }

    // content_prompt_id first: transcript prompt numbering and DB prompt
    // numbering drift (compact markers, recovered turns), while a prompt id is
    // the same identity on both sides wherever the capture recorded one.
    const rideTurn =
      (transcriptTurn.promptId
        ? byPromptId.get(sessionId, transcriptTurn.promptId)
        : null) ?? byPromptNumber.get(sessionId, transcriptTurn.promptNumber);
    if (!rideTurn) {
      continue;
    }

    filled += update.run(transcriptTurn.assistantModel, rideTurn.id)
      ?.changes ?? 0;
  }

  return filled;
}

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
      pendingTurn.type.includes("compact") ||
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
