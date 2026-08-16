import type { Database } from "bun:sqlite";

import { getTurnById, type TurnRecord } from "./turns";

/**
 * The coverage predicate (spec G1-G4, G8; ticket 08) — one implementation
 * shared by every caller that needs to know whether a window of turns still
 * owes review: the `check` tool below (pulled by the agent), the Stop hook
 * (ticket 11, pushed at stop), and the completion gate (ticket 09, inside the
 * completion compare-and-set). All three must call `computeCoverageGaps` and
 * nothing else — three separate re-implementations would drift, and drift
 * resolves toward whichever copy is loosest.
 *
 * Pure function: every read below is a SELECT. Nothing here writes, and
 * nothing here decides what a caller's "window" is — that is the caller's
 * job (a settlement job's frozen member ids, a live session's recent turns,
 * …); this module only answers, for a given list of turn ids, which of them
 * are gaps.
 */

export interface CoverageGap {
  turnId: number;
  sessionId: number;
  promptNumber: number;
}

const NO_REPLY_COMMAND_ENVELOPE_PREFIXES = [
  "<local-command-",
  "<command-name>",
  "<command-args>",
  "<command-message>",
] as const;

/**
 * A slash-command envelope the harness answered locally, with no model turn
 * (spec G4's "slash commands that need no model reply"). Mirrors
 * `mcp/timeline.ts`'s `milestonePromptPrefix`, which collapses the same shape
 * to its notification marker instead of spending row budget on it — the two
 * must agree on which envelope is a pure marker.
 *
 * A complete `<command-name>…</command-name>` tag ANYWHERE in the prompt (not
 * necessarily leading) means the command WAS routed to the model — a real
 * turn, kept eligible — matching `extractCommandName`'s own non-anchored
 * search. Only an envelope that opens one of the four command-related
 * prefixes and never states a command name is the local, no-reply shape.
 *
 * No production row currently exercises this branch: `turns.user_prompt` is
 * captured from the UserPromptSubmit hook's raw prompt text (e.g. "/to-tickets
 * ..."), not from the transcript's expanded envelope XML, so the envelope
 * forms this function checks are a defensive completion of the codebase's own
 * vocabulary for "a slash-command envelope" rather than something observed
 * live. `/compact` is excluded by a different, well-populated path — its
 * marker turn's `type` contains `"compact"` — handled by
 * `isCompactMarkerTurn` below, not by this function.
 */
export function isNoReplySlashCommandPrompt(userPrompt: string | null): boolean {
  if (userPrompt === null) {
    return false;
  }
  const trimmed = userPrompt.trimStart();
  const isCommandEnvelope = NO_REPLY_COMMAND_ENVELOPE_PREFIXES.some((prefix) =>
    trimmed.startsWith(prefix),
  );
  if (!isCommandEnvelope) {
    return false;
  }
  // A COMPLETE tag naming something, not the opener text:
  // `<local-command-stdout>… mentioning <command-name></local-command-stdout>`
  // states no command, and a bare `includes("<command-name>")` would read it
  // as model-routed and keep the envelope eligible. The pattern is
  // `mcp/timeline.ts`'s `extractCommandName` verbatim — mirrored rather than
  // imported, because a db-layer module must not depend on the MCP layer, and
  // the two disagreeing about what a command envelope is would be worse than
  // the duplication.
  return !/<command-name>\s*([^<]+?)\s*<\/command-name>/.test(trimmed);
}

/**
 * The PreCompact repair path's one mechanical marker row (spec D2 of the
 * note-prompt-clock spec; `MEMORY_TYPES`'s own doc comment). The same check
 * `db/note-debt.ts`'s `realPromptPredicate` and `mcp/note.ts`'s
 * `compactMarkerMessage` guard already apply. Not a turn to note or skip.
 */
export function isCompactMarkerTurn(turn: Pick<TurnRecord, "type">): boolean {
  return turn.type.includes("compact");
}

/**
 * The eligible set (spec G4): the window's turns minus compact markers and
 * minus no-reply slash commands. A sidechain row (`status = 'undone'`) is
 * DELIBERATELY not excluded here — spec's Further Notes records that an
 * earlier draft assumed the note tool refused `undone` rows and found, on
 * inspection, that it does not; G4 settles the question the other way.
 */
export function isEligibleCoverageTurn(
  turn: Pick<TurnRecord, "type" | "userPrompt">,
): boolean {
  return !isCompactMarkerTurn(turn) && !isNoReplySlashCommandPrompt(turn.userPrompt);
}

/**
 * Which of `turnIds` carry a `note_debt` row recording the agent's own
 * real-time decline (`note(turn, skip: true)`, reason `declined`).
 *
 * Deliberately narrower than "any `note_debt.status = 'skipped'` row", which
 * is what the LIVE reminder ledger (`listOwedNoteTurns`) treats as answered.
 * `aged` / `closed` / `rolled-back` are the OLD reminder's own historical
 * write-offs, and settlement's own backfill predicate
 * (`listOwedNoteTurnsInRange`, same file) already treats those as still
 * owed — only `declined` excludes a turn there, specifically so settlement
 * can still reconstruct a note residual settlement wrote off. This predicate
 * must not disagree with the one settlement already trusts over the same
 * table, so it applies the identical narrowing.
 */
function declinedSkipTurnIds(db: Database, turnIds: readonly number[]): Set<number> {
  if (turnIds.length === 0) {
    return new Set();
  }
  const placeholders = turnIds.map(() => "?").join(", ");
  const rows = db
    .query<{ turnId: number }, number[]>(
      `SELECT turn_id AS turnId FROM note_debt
       WHERE status = 'skipped' AND reason = 'declined'
         AND turn_id IN (${placeholders})`,
    )
    .all(...turnIds);
  return new Set(rows.map((row) => row.turnId));
}

/**
 * Coverage (spec G1/G3/F4): an eligible turn is covered when it carries a
 * stated `type` (F4 — the empty-field check and the skip check are one
 * test), or when it was skipped. "Skipped" has to read BOTH signals a turn
 * can carry, because neither alone is complete against the live database:
 *
 *   - `turns.status = 'skipped'` is the mechanical floor
 *     (`db/turn-completion.ts`'s `completionFloorStatus`) written once a
 *     later prompt proves an unnoted turn is over. The large majority of
 *     skipped turns carry no `note_debt` row at all (a production check found
 *     2124 of 2245), so this branch alone covers them.
 *   - a `note_debt` row with `status = 'skipped', reason = 'declined'`
 *     catches what the floor cannot: a turn the agent has JUST declined,
 *     before any later prompt gives the floor an occasion to run, and a
 *     sidechain turn (`status = 'undone'`), which the floor never revisits at
 *     all — a sidechain row is born `undone` and stays that way; nothing
 *     mechanically promotes it (see `promoteTurnFromNote`). Without this
 *     branch a declined sidechain turn would never read as covered.
 */
export function isCoveredCoverageTurn(
  turn: Pick<TurnRecord, "type" | "status">,
  hasDeclinedSkip: boolean,
): boolean {
  return turn.type.length > 0 || turn.status === "skipped" || hasDeclinedSkip;
}

/**
 * The predicate itself (spec G8): database in, gap list out. Every eligible
 * turn among `turnIds` that is neither typed nor skipped is a gap. A `turnId`
 * absent from the database (a stale id in a caller's window, say) is silently
 * skipped rather than erroring.
 */
export function computeCoverageGaps(
  db: Database,
  turnIds: readonly number[],
): CoverageGap[] {
  const declined = declinedSkipTurnIds(db, turnIds);
  const gaps: CoverageGap[] = [];

  for (const turnId of turnIds) {
    const turn = getTurnById(db, turnId);
    if (!turn) {
      continue;
    }
    if (!isEligibleCoverageTurn(turn)) {
      continue;
    }
    if (isCoveredCoverageTurn(turn, declined.has(turnId))) {
      continue;
    }
    gaps.push({
      turnId: turn.id,
      sessionId: turn.sessionId,
      promptNumber: turn.promptNumber,
    });
  }

  return gaps;
}
