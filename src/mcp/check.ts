import type { Database } from "bun:sqlite";

import { computeCoverageGaps } from "../db/coverage";

type ToolTextResult = {
  content: Array<{
    type: "text";
    text: string;
  }>;
};

function textResult(text: string): ToolTextResult {
  return { content: [{ type: "text", text }] };
}

function parameterError(message: string): ToolTextResult {
  return textResult(`Parameter error: ${message}`);
}

export interface CheckToolInput {
  id?: unknown;
}

const SESSION_ADDRESS_PATTERN = /^S(\d+)$/i;

/**
 * `check` — the coverage predicate exposed as a tool (spec G8, ticket 08).
 * One predicate, three callers, decreasing trust: this tool (pulled by the
 * agent at any time, trusting itself), the Stop hook (ticket 11, pushed at
 * stop, trusting the agent to act on what it lists), and the completion gate
 * (ticket 09, server-side inside the completion compare-and-set, trusting
 * nobody). All three call `computeCoverageGaps` and nothing else, so a fix to
 * the predicate reaches every caller at once instead of drifting between
 * three re-implementations.
 *
 * Reports what is missing, never why: a bare list of turn addresses. The
 * agent already knows why a turn is a gap — restating the reason here would
 * be a second, potentially disagreeing copy of the same judgement. The one
 * thing this tool must never add "for convenience" is a per-grade histogram
 * (spec G9): that comparison is for the operator, after the run, never for
 * the agent still producing the grades the histogram would count.
 */
export function checkTool(db: Database, rawInput: CheckToolInput): ToolTextResult {
  if (typeof rawInput.id !== "string") {
    return parameterError('id is required, e.g. "S15069".');
  }

  const match = SESSION_ADDRESS_PATTERN.exec(rawInput.id.trim());
  if (!match) {
    return parameterError(`id must be a "S<session>" address; got "${rawInput.id}".`);
  }

  const sessionId = Number.parseInt(match[1]!, 10);
  // `S9007199254740993` matches the pattern and parses to a value that is not
  // the number the caller typed; past that boundary the id silently becomes a
  // different one.
  if (!Number.isSafeInteger(sessionId) || sessionId <= 0) {
    return parameterError(`id must be a "S<session>" address; got "${rawInput.id}".`);
  }
  // An unknown session must not answer "nothing owed". Every other outcome of
  // this tool is a statement about turns that exist; a bare empty window is
  // indistinguishable from a clean one, and a clean bill is exactly what the
  // caller acts on — G8's whole value is that an agent can trust the answer
  // before it believes it has finished.
  const sessionExists = db
    .query<{ id: number }, [number]>("SELECT id FROM sessions WHERE id = ?")
    .get(sessionId);
  if (!sessionExists) {
    return parameterError(`S${sessionId} is not a session in this database.`);
  }

  const turnIds = db
    .query<{ id: number }, [number]>(
      "SELECT id FROM turns WHERE session_id = ? ORDER BY prompt_number ASC",
    )
    .all(sessionId)
    .map((row) => row.id);

  const gaps = computeCoverageGaps(db, turnIds);

  if (gaps.length === 0) {
    return textResult(
      `S${sessionId}: nothing owed — every eligible turn is typed or skipped.`,
    );
  }

  const addresses = gaps
    .map((gap) => `S${gap.sessionId}/T${gap.promptNumber}`)
    .join(", ");

  return textResult(
    `S${sessionId}: ${gaps.length} turn(s) still owe review: ${addresses}.`,
  );
}
