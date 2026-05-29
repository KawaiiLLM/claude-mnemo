import type { Database } from "bun:sqlite";

import { getTurnById } from "../db/turns";

const TURN_POINTER_PATTERN = /\[T(\d+)\]/g;

// D4: session summaries store milestone turns as inline [T<n>] markers, where
// <n> is the DB turn id the agent saw in a <turn id="T..."> block (NOT the
// session-scoped prompt number). Resolution happens on read so titles are
// always current — zero staleness, same contract as memory [[wikilinks]].
//
// A marker resolves to recall-style `[S<sid>/T<prompt_number>] "title"` only
// when the turn exists, belongs to this session, AND is not retracted. A
// hallucinated id, a cross-session id, a deleted turn, or an `undone` turn
// keeps the literal `[T<n>]` — never surface another session's turn or
// retracted work in a summary.
export function resolveTurnPointers(
  db: Database,
  sessionId: number,
  text: string | null,
): string | null {
  if (!text || !text.includes("[T")) {
    return text;
  }

  return text.replace(TURN_POINTER_PATTERN, (literal, idDigits: string) => {
    const turn = getTurnById(db, Number.parseInt(idDigits, 10));
    if (!turn || turn.sessionId !== sessionId || turn.status === "undone") {
      return literal;
    }

    return `[S${sessionId}/T${turn.promptNumber}] "${turn.title ?? "untitled"}"`;
  });
}
