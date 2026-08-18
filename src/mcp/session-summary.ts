import { estimateTokens } from "../utils/token-estimate";

/**
 * The session's remaining semantic fields: `title` and `content` (ticket
 * 01/09, spec "Session retirement" then "session 字段"). The other five —
 * insight/next_steps/decision/done/reference — retired with the segment
 * redesign: Working State and the summary layer now live on the segment
 * (`remember`), and a session carries no task memory of its own (root
 * CONTEXT.md).
 *
 * TICKET 09 (edge-ownership-impl, "结算顺手维护 session 叙事"):
 * `content` REJOINS this list as settlement's own field — a conversational
 * narrative increment, never task state — and the WRITER changes: neither
 * field has a main-agent writer any more (`mcp/note.ts`'s session address
 * retired outright), settlement is the session's sole writer through its
 * own staged-commit channel (`worker/note-settlement-turn-facade.ts`'s
 * `evaluateSettlementTurnWrite`, session branch), reusing THIS module's
 * field list and guidance values rather than a second hand-kept copy.
 * `title`'s own contract lives in `noteInputShape.title`'s `.describe()`
 * (mcp/definitions.ts) even though `note` no longer writes it — the prose
 * itself did not change, only who is allowed to write it.
 *
 * A guidance value is REPORTED (`formatSessionFieldUsage` below), advisory
 * only on the settlement path — unlike the retired main-agent path, nothing
 * here refuses an over-guidance write outright; settlement is a single
 * controlled call per window, not a surface an unbounded caller can spam.
 */
export const SESSION_FIELD_GUIDANCE = {
  title: 30,
  content: 200,
} as const;

export type SessionSummaryField = keyof typeof SESSION_FIELD_GUIDANCE;

/**
 * One ordered list (today: `["title", "content"]`), so a caller's accepted-
 * field set, its "at least one of…" error and the receipt cannot disagree
 * about what a session write may touch.
 */
export const SESSION_SUMMARY_FIELDS = Object.keys(
  SESSION_FIELD_GUIDANCE,
) as readonly SessionSummaryField[];

/**
 * One field's line in the receipt: its post-write total against its guidance
 * value, and — when it is over — a word saying so. The total is the value as
 * STORED after this write, not the delta this call supplied: a writer
 * appending 50 tokens at a time otherwise reaches 1000 without ever seeing a
 * number that grew (spec D8).
 */
export function formatSessionFieldUsage(
  field: SessionSummaryField,
  storedValue: string | null,
): string {
  if (storedValue === null) {
    return `${field} (cleared)`;
  }
  const used = estimateTokens(storedValue);
  const guidance = SESSION_FIELD_GUIDANCE[field];
  return `${field} ${used}/${guidance}${used > guidance ? " (over guidance)" : ""}`;
}
