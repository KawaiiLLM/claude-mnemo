import type { SessionRecord } from "../db/sessions";
import { estimateDiaryTokens } from "../diary/domain";
import type { FormattedSession } from "./format";

export const CURRENT_SESSION_STATE_TOKEN_BUDGET = 2_000;

// ownership-and-note-cadence spec, "session 字段" ([S15069/T910]-[T913]):
// decision/done/nextSteps/reference/insight retired from this input
// unconditionally — title and content are the session's only two remaining
// semantic fields, on every reader, legacy row or not.
export interface SessionStateRenderInput {
  id: number;
  title: string | null;
  content: string | null;
}

export interface SessionStateTokenReport {
  title: number;
  content: number;
  total: number;
}

function capCodePoints(value: string | null, max: number): string | null {
  if (!value) {
    return value;
  }
  const codePoints = Array.from(value);
  return codePoints.length <= max
    ? value
    : `${codePoints.slice(0, Math.max(0, max - 1)).join("")}…`;
}

function buildSessionStateLines(
  input: SessionStateRenderInput,
  capPriorityFields = false,
): string[] {
  const title =
    (capPriorityFields ? capCodePoints(input.title, 100) : input.title) ??
    "(untitled session)";
  const lines = [
    `[S${input.id}] ${title}`,
  ];
  const pushField = (
    label: string,
    value: string | null | undefined,
    cap?: number,
  ): void => {
    const rendered = capPriorityFields && cap ? capCodePoints(value ?? null, cap) : value;
    if (rendered) {
      lines.push(`  ${label}: ${rendered}`);
    }
  };

  // ownership-and-note-cadence spec ([S15069/T910]-[T913]): content is the
  // session's only remaining state field — decision/done/next/reference/
  // insight retired unconditionally (no more "drop trailing historical
  // fields" ladder; there is nothing left to drop).
  pushField("content", input.content, 400);
  return lines;
}

export function renderSessionStateOutput(input: SessionStateRenderInput): string {
  return buildSessionStateLines(input).join("\n");
}

export function measureSessionStateTokens(
  input: SessionStateRenderInput,
): SessionStateTokenReport {
  const fieldTokens = (label: string, value: string | null): number => {
    if (!value) {
      return 0;
    }
    return estimateDiaryTokens(`  ${label}: ${value}`);
  };
  const full = renderSessionStateOutput(input);
  return {
    title: estimateDiaryTokens(
      `[S${input.id}] ${input.title ?? "(untitled session)"}`,
    ),
    content: fieldTokens("content", input.content),
    total: estimateDiaryTokens(full),
  };
}

/**
 * The ONE place the injected state is cut, and every cut it makes is stated in
 * the output (ticket 04).
 *
 * The `tokenBudget` is a parameter rather than the constant because the caller
 * knows what else shares its block: SessionStart wraps this in a `## Current
 * Session` heading, and that heading's tokens have to come out of the same
 * ceiling. Before, they did not — the hook bounded this renderer's already
 * bounded output a SECOND time through the persona document renderer, and the
 * second cut deleted the first cut's "state truncated" pointer and replaced it
 * with a count of only the lines the second cut had itself dropped. The reader
 * was told two lines were missing when most of the summary was gone. One
 * budget, one owner, one marker.
 *
 * `tokenBudget` is a CEILING this function honours only down to a floor: the
 * truncation pointer itself (ticket 15 finding 9). A `tokenBudget` smaller
 * than the pointer's own token cost still gets the pointer back, and the
 * result then EXCEEDS `tokenBudget` — never an empty string, because a cut
 * that announces nothing is the defect requirement 6 exists to prevent (see
 * "the pointer is never the line that gets dropped" below). Enforcing the
 * ceiling all the way down to zero would mean silently dropping the one line
 * whose whole job is to not be silent, so this function does not attempt it
 * — keeping `tokenBudget` comfortably above the pointer's size is the
 * CALLER's job, not this renderer's to guard. Today both production callers
 * pass the ~2,000-token default (`renderMainAgentSessionInjection`,
 * hooks/session-injection.ts) minus a small fixed heading, dozens of tokens
 * above the pointer, so this floor is never actually hit in production — see
 * `tests/mcp/session-output.test.ts`'s "every truncation announces itself,
 * and the pointer survives an extreme budget" test, which pins the same
 * shape down to `budget: 5`.
 */
function renderBoundedSessionStateOutput(
  input: SessionStateRenderInput,
  tokenBudget: number = CURRENT_SESSION_STATE_TOKEN_BUDGET,
): string {
  const full = renderSessionStateOutput(input);
  if (estimateDiaryTokens(full) <= tokenBudget) {
    return full;
  }

  const pointer = `  … state truncated; full summary: recall(id="S${input.id}")`;
  const uncappedStateLines = buildSessionStateLines(input, false);
  const stateFitsUncapped =
    estimateDiaryTokens([...uncappedStateLines, pointer].join("\n")) <=
    tokenBudget;
  const lines = buildSessionStateLines(input, !stateFitsUncapped);
  const included: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const candidate = [
      ...included,
      lines[index]!,
      pointer,
    ].join("\n");
    if (estimateDiaryTokens(candidate) > tokenBudget) {
      break;
    }
    included.push(lines[index]!);
  }

  // The pointer is never the line that gets dropped to make room: content is
  // cut first, and a cut that says nothing is the defect this whole path
  // exists to avoid. `included` is built with the pointer already counted, so
  // reaching a state where it does not fit means even the pointer alone
  // overruns the budget — and then the pointer alone is still the right answer.
  return [...included, pointer].join("\n");
}

/**
 * The bounded session-state rendering for callers that hold the raw summary
 * fields rather than a `FormattedSession` — the P2 settlement context builder is
 * the first (spec D9's "session summary 沿用现有预算合同"). It exists so that
 * contract stays ONE implementation: the degradation ladder and the 2,000-token
 * ceiling are the same object SessionStart injects, not a second copy of them.
 */
export function renderSessionStateInjection(
  input: SessionStateRenderInput,
  tokenBudget?: number,
): string {
  return renderBoundedSessionStateOutput(input, tokenBudget);
}

/**
 * The `FormattedSession`-shaped door into the same bounded renderer. Ticket 11
 * moved its one production caller (the SessionStart hook) onto
 * `hooks/session-injection.ts`, which is now the single place the injected
 * field list is built for BOTH the main agent and the settlement subagent —
 * so this overload survives for `tests/mcp/session-output.test.ts`, which is
 * where the degradation ladder itself is proved. Adding a field to the
 * injection means adding it there, not here.
 *
 * ownership-and-note-cadence spec ([S15069/T910]-[T913]): `sessionRecord` is
 * accepted only for its `id` now — decision/done/next/reference/insight
 * retired unconditionally, so there is nothing left to prefer raw storage
 * over the formatted view for.
 */
export function renderCurrentSessionStateOutput(
  session: FormattedSession,
  sessionRecord: SessionRecord,
  tokenBudget?: number,
): string {
  return renderBoundedSessionStateOutput(
    {
      id: sessionRecord.id,
      title: session.title ?? null,
      content: session.content ?? null,
    },
    tokenBudget,
  );
}
