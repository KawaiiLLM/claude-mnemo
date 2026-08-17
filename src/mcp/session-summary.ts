import { estimateTokens } from "../utils/token-estimate";

/**
 * The session's one remaining semantic field (ticket 01/09, spec "Session
 * retirement"): `title`. The other six — content/insight/next_steps/decision/
 * done/reference — retired with the segment redesign: Working State and the
 * summary layer now live on the segment (`remember`), and a session carries
 * no semantic memory of its own (root CONTEXT.md). `title`'s own contract
 * lives in `noteInputShape.title`'s `.describe()` (mcp/definitions.ts), the
 * single home for both the turn and the session reading of that one shared
 * field.
 *
 * `current` retired earlier still (ticket 04) and is handled by its own
 * named constant below — a caller sending it gets a message naming its
 * replacement, unlike the six fields this ticket retires, which simply stop
 * being offered: `next_steps`/`decision`/`done`/`reference` are removed from
 * `noteInputShape` outright (a `.strict()` parse error, same treatment as the
 * removed `grade` parameter — there is nothing left to point the caller at,
 * the field left the session entirely); `content`/`insight` stay in the
 * shared schema (they are still valid TURN fields) but are refused by name on
 * a session address in `mcp/note.ts`.
 *
 * A guidance value is REPORTED, and — new in ticket 01 — enforced at 2×: a
 * write past twice this number is refused outright
 * (`budgetOverageRejection`, shared/note-budget.ts), the same hard line a
 * turn's title/content/insight now carries. Below that line nothing here
 * truncates: a write at or under 2× always stores everything it sent, over
 * guidance or not.
 */
export const SESSION_FIELD_GUIDANCE = {
  title: 30,
} as const;

export type SessionSummaryField = keyof typeof SESSION_FIELD_GUIDANCE;

/**
 * One ordered list (today: `["title"]`), so the tool's accepted-field set,
 * its "at least one of…" error and the receipt cannot disagree about what a
 * session write may touch.
 */
export const SESSION_SUMMARY_FIELDS = Object.keys(
  SESSION_FIELD_GUIDANCE,
) as readonly SessionSummaryField[];

/** The retired eighth field (D2, ticket 04) — unaffected by ticket 01's further retirement of the other six. */
export const RETIRED_SESSION_FIELD = "current";

export function retiredSessionFieldMessage(where: "field" | "mode"): string {
  const subject = where === "mode" ? `mode.${RETIRED_SESSION_FIELD}` : RETIRED_SESSION_FIELD;
  return (
    `${subject} no longer exists: the session summary's \`current\` field is deleted (spec D2).` +
    " It duplicated `content` at a different compression, so the two competed for the same" +
    " material. Nothing is left on the session address but `title` — the segment redesign" +
    " moved Working State and the summary layer to `remember`. Nothing was written."
  );
}

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

/**
 * The cadence figure (spec D8): how many turns have passed since the summary
 * was last updated. Of the two things the receipt carries this is the one that
 * names an action — "you wrote too much" implies something vague, "47 turns
 * since the last update" says what to do.
 *
 * It travels alone, without the band that would make it healthy by
 * construction (D8a). Do not add one.
 */
export function formatSummaryCadence(
  turnsSince: number,
  hadPreviousUpdate: boolean,
): string {
  const turns = `${turnsSince} turn${turnsSince === 1 ? "" : "s"}`;
  return hadPreviousUpdate
    ? `${turns} since the last summary update.`
    : `No previous summary update; ${turns} so far.`;
}
