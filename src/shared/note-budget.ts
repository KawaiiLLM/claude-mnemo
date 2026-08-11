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
 * Reuses the plain four-characters-per-token estimate rather than the diary's
 * CJK-weighted one: note fields are English by rule, and the occasional quoted
 * user phrase is not worth a second estimator's worth of divergence.
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

  return `${segments.join(" · ")} → ${total}/${budget} (${(total / budget).toFixed(1)}×).`;
}
