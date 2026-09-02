import type { Database, Statement } from "bun:sqlite";

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
  const matchedTurnIds = new Set<number>();
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

    matchedTurnIds.add(rideTurn.id);
    filled += update.run(transcriptTurn.assistantModel, rideTurn.id)
      ?.changes ?? 0;
  }

  filled += backfillOrphanedRideTurns(db, sessionId, transcriptTurns, matchedTurnIds, update);

  return filled;
}

/**
 * Ride turns whose OWN `content_prompt_id` is NULL can never be reached by the
 * loop above: nothing in the transcript is ever looked up "by promptNumber
 * unclaimed by a promptId" — whichever transcript entry happens to sit at that
 * numeric position almost always carries its own promptId and gets diverted to
 * a different, correctly-addressed row first (`byPromptId` wins the `??`
 * before `byPromptNumber` is ever consulted for that position). A turn ends up
 * with a NULL `content_prompt_id` when it was never the LATEST pending turn at
 * the moment its own Stop cycle ran (`backfillFromTranscript` only captures
 * `content_prompt_id` for that one turn, deliberately — a positional match for
 * an older turn is exactly the drift this comment is about, so recording it
 * there would risk stamping the WRONG id onto content downstream readers treat
 * as authoritative). A cross-session-message delivery is the reproducible
 * case: Claude Code echoes it into the transcript, but the turn it created can
 * still be superseded as "latest" before Stop ever captures its id, and once
 * turn-number drift has accumulated anywhere earlier in a long session, no
 * later Stop closes the gap either.
 *
 * `writer_model` carries none of `content_prompt_id`'s downstream weight (it
 * is P1 measurement metadata, not a correlator other systems key off), so a
 * lower-confidence correlator is an acceptable trade here specifically: the
 * turn's own stored `user_prompt` is exactly what a synthetic delivery still
 * shares verbatim with its transcript echo (Claude Code may prefix it, e.g.
 * "Another Claude session sent a message:\n", but never rewrites the payload
 * itself), so a substring match recovers the same transcript entry the
 * position-based loop above could never reach.
 */
function backfillOrphanedRideTurns(
  db: Database,
  sessionId: number,
  transcriptTurns: ParsedReplayTurn[],
  matchedTurnIds: Set<number>,
  update: Statement<unknown, [string, number]>,
): number {
  const orphanedRideTurns = db
    .query<{ id: number; userPrompt: string }, [number]>(
      `SELECT DISTINCT t.id, t.user_prompt AS userPrompt
       FROM shadow_notes n
       JOIN turns t ON t.id = n.ride_turn_id
       WHERE t.session_id = ?
         AND n.writer_model IS NULL
         AND t.content_prompt_id IS NULL
         AND t.user_prompt IS NOT NULL
         AND t.user_prompt != ''`,
    )
    .all(sessionId);

  let filled = 0;
  for (const rideTurn of orphanedRideTurns) {
    if (matchedTurnIds.has(rideTurn.id)) {
      continue;
    }

    // A short prefix risks matching a generic opening line shared by unrelated
    // prompts; the full text risks never matching if the transcript's copy
    // diverges past that length for an unrelated reason. 200 chars is long
    // enough to carry a cross-session message's unique socket path and enough
    // of its payload to be practically unique, short enough that a harmless
    // prefix (e.g. Claude Code's own "Another Claude session sent a
    // message:\n" wrapper) never eats the whole anchor.
    const anchor = rideTurn.userPrompt.slice(0, 200);
    const transcriptTurn = transcriptTurns.find(
      (turn) => turn.assistantModel && turn.userPrompt.includes(anchor),
    );
    if (!transcriptTurn?.assistantModel) {
      continue;
    }

    matchedTurnIds.add(rideTurn.id);
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
