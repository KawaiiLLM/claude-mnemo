import { estimateTokens } from "../utils/token-estimate";

/**
 * The session summary's seven fields, split by reader (spec D2), each with its
 * guidance value (spec D9).
 *
 * The split is the point: `title`/`content`/`insight` are a compressed global
 * view for ANOTHER session browsing this one; `next_steps`/`decision`/`done`/
 * `reference` are recent events for THIS session resuming itself. The retired
 * eighth field, `current`, duplicated `content` at a different compression, so
 * a writer had to guess which of the two to update — the note tool now refuses
 * it by name rather than dropping it silently.
 *
 * A guidance value is REPORTED, never enforced. `note`'s session receipt
 * measures each written field against its number and hands the result back;
 * nothing truncates, ever. Going over budget is a signal to the writer of the
 * NEXT write, not a loss to the reader — the reader always gets everything
 * that was written (spec D7).
 *
 * The numbers are corpus measurement, not taste (D9 records the mean/max chars
 * they came from: content 369/1473, decision 508/1371, done 392/864,
 * reference 309/746, insight 198/282, next_steps 148/611), counted in the
 * `estimateTokens` unit the receipt prints.
 *
 * Deliberately absent, and the absence is load-bearing: the update-cadence
 * band (D8a/D10). The receipt tells the writer how many turns have passed
 * since the last summary update and never what number is healthy, because a
 * writer who knows the target updates in order to reset the counter — the
 * diagnostic then reads healthy by construction and measures compliance with
 * itself instead of the thing it was built to detect. The band is
 * operator-side, which here means it does not exist in this module, in
 * `note.ts`, or in any string a writer can read.
 */
export const SESSION_FIELD_GUIDANCE = {
  title: 30,
  content: 250,
  insight: 80,
  next_steps: 250,
  decision: 300,
  done: 150,
  reference: 100,
} as const;

export type SessionSummaryField = keyof typeof SESSION_FIELD_GUIDANCE;

/**
 * One ordered list, so the tool's accepted-field set, its "at least one of…"
 * error and the receipt cannot disagree about what the seven fields are.
 */
export const SESSION_SUMMARY_FIELDS = Object.keys(
  SESSION_FIELD_GUIDANCE,
) as readonly SessionSummaryField[];

/** The retired eighth field (D2). Named so the refusal can say what to do instead. */
export const RETIRED_SESSION_FIELD = "current";

export function retiredSessionFieldMessage(where: "field" | "mode"): string {
  const subject = where === "mode" ? `mode.${RETIRED_SESSION_FIELD}` : RETIRED_SESSION_FIELD;
  return (
    `${subject} no longer exists: the session summary's \`current\` field is deleted (spec D2).` +
    " It duplicated `content` at a different compression, so the two competed for the same" +
    " material. Write `content` (the compressed view another session browsing this one reads)" +
    " or `next_steps` (what this session does next) instead. Nothing was written."
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
