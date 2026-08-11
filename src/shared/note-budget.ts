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
