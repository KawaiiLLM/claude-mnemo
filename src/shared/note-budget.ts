import { estimateTokens } from "../utils/token-estimate";

/**
 * The note-length budget, in one place because two surfaces have to agree
 * about it: the note-taking instructions injected at session start state these
 * numbers to the agent, and the `note` receipt measures the write against
 * them. Split across two modules they would drift, and a budget the receipt
 * does not enforce is a budget nobody keeps — measured on S15069, sixteen
 * consecutive notes ran 1.5×–2.5× over a budget stated only in the prompt.
 */
export const NOTE_TOKEN_BUDGET = {
  title: 20,
  content: 100,
  insight: 60,
} as const;

export interface NoteBudgetFields {
  title: string;
  content: string;
  insight?: string | null;
}

/**
 * The receipt's budget line: per-field estimates against their budgets, then
 * the total and how far past it the write landed. `insight` is counted only
 * when one was written — an absent insight is the documented default, not an
 * underspend to report.
 *
 * Measured with `estimateTokens`, the estimator for text an agent writes: four
 * characters per token for English, a token per CJK character for the quoted
 * user phrases the instructions allow. The diary's weighting is not reused here
 * — it sizes an injection against a hard cap and reads ~3x high on English, so
 * every note would report as over budget.
 */
export function formatNoteBudget(fields: NoteBudgetFields): string {
  const title = estimateTokens(fields.title);
  const content = estimateTokens(fields.content);
  const insight = fields.insight ? estimateTokens(fields.insight) : 0;
  const hasInsight = insight > 0;

  const segments = [
    `title ${title}/${NOTE_TOKEN_BUDGET.title}`,
    `content ${content}/${NOTE_TOKEN_BUDGET.content}`,
  ];
  if (hasInsight) {
    segments.push(`insight ${insight}/${NOTE_TOKEN_BUDGET.insight}`);
  }

  const total = title + content + insight;
  const budget =
    NOTE_TOKEN_BUDGET.title +
    NOTE_TOKEN_BUDGET.content +
    (hasInsight ? NOTE_TOKEN_BUDGET.insight : 0);

  return `${segments.join(" · ")} → ${total}/${budget} (${formatRatio(total, budget)}×).`;
}

/**
 * One decimal is right for the case this line exists to expose — 2.3× is the
 * whole message — but it rounds every write under 5% of the budget to "0.0",
 * which reads as "nothing was written" rather than "you have room to spare".
 * A well-under write says so as an inequality instead: no false precision, and
 * no number that contradicts the counts printed next to it.
 */
function formatRatio(total: number, budget: number): string {
  const ratio = total / budget;

  return ratio < 0.05 ? "<0.1" : ratio.toFixed(1);
}

/**
 * Ticket 01 (field-semantics spec, "01 — 字段定义进注入,预算硬拒改为回执提醒";
 * [S15069/T1074]): the former 2× hard rejection — nothing stored past the
 * line — is RETIRED outright. `content`'s new duty (every useful decision
 * this turn produced, not a compressed single conclusion) collides with a
 * gate that discards the whole write for running long; a field over budget
 * is now always stored.
 *
 * What replaces it is a standing receipt warning, not a softer gate: past
 * `BUDGET_WARNING_MULTIPLE`, `formatBudgetWarning` below adds a line to
 * EVERY call that still lands over the line, with no memory of earlier
 * calls — the user's own reasoning for "every time, not once": "如果只提醒
 * 一次无法抑制一直超写" (a warning that only fires once cannot suppress a
 * standing habit of writing over). Building any state to suppress a repeat
 * warning would defeat the ruling outright.
 */
export const BUDGET_WARNING_MULTIPLE = 1.5;

/**
 * The receipt's warning line — separate from `formatNoteBudget`'s ratio line
 * above, which stays exactly as it was (`content 168/100 → 191/120 (1.6×)`).
 * Checks every field this receipt already measures (`title`/`content`, plus
 * `insight` when one was written) against `BUDGET_WARNING_MULTIPLE`, and
 * names every field currently over it — not just the field a given call
 * happened to touch, so an inherited oversized field keeps surfacing until
 * it is actually trimmed. Returns `null` when nothing is over the line, so a
 * caller can push the line into the receipt conditionally without an empty
 * string appearing.
 *
 * Wording is deliberate: an occasional overage costs nothing (that is what
 * the advisory band below `BUDGET_WARNING_MULTIPLE` already tolerates), a
 * standing pattern of it does — the line says so rather than just restating
 * the ratio a second time.
 */
export function formatBudgetWarning(fields: NoteBudgetFields): string | null {
  const over: string[] = [];
  if (estimateTokens(fields.title) > NOTE_TOKEN_BUDGET.title * BUDGET_WARNING_MULTIPLE) {
    over.push("title");
  }
  if (estimateTokens(fields.content) > NOTE_TOKEN_BUDGET.content * BUDGET_WARNING_MULTIPLE) {
    over.push("content");
  }
  if (
    fields.insight &&
    estimateTokens(fields.insight) > NOTE_TOKEN_BUDGET.insight * BUDGET_WARNING_MULTIPLE
  ) {
    over.push("insight");
  }
  if (over.length === 0) {
    return null;
  }
  // render-boilerplate-trim ticket 02: the sentence compresses — field names
  // (as before) plus the fixed threshold, nothing else. Still fires on EVERY
  // over-1.5× call (protected ruling above), only its wording shrank.
  return `${over.join(", ")} over ${BUDGET_WARNING_MULTIPLE}× — occasional is fine, a standing pattern is not.`;
}
