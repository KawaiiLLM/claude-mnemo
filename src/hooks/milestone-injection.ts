import type { Database } from "bun:sqlite";

import {
  buildTimelineView,
  renderTimeline,
  DEFAULT_TITLE_CAP,
  type TimelineView,
} from "../mcp/timeline";

/**
 * Whole-output token ceiling for the SessionStart milestones section (spec §D).
 * The renderer's own budget fitter enforces it — lowest-score units lose their
 * desc, then the unit itself, while always-keep anchors degrade but never
 * disappear. Nothing re-budgets on top of this.
 */
export const MILESTONE_INJECTION_TOKEN_BUDGET = 2_500;

/**
 * The injection renders the arc (`milestones`) view exactly as the MCP tool
 * would, with two injection-internal knobs (spec §D): a 100-character title cap
 * — the same one every view uses, never an injection-only reduced cap — and the
 * global token budget. The old four-stage silent degradation (80 → strip shape
 * signals → strip `↳` rows → 50-char titles) and its post-render string surgery
 * are gone: they re-rendered the whole view once per candidate, which is
 * quadratic in the milestone count, and they cut titles mid-clause.
 */
export interface RenderMilestoneInjectionOptions {
  tokenBudget?: number;
  /**
   * P2 era boundary (spec D11). Set, the injection's arc becomes the segment
   * spine for the era side of the session and the legacy arc for the rest —
   * under this same token budget, which is the existing contract and is not
   * renegotiated here.
   */
  eraCutoffEpoch?: number | null;
}

export function renderMilestoneInjection(
  view: TimelineView,
  options: RenderMilestoneInjectionOptions = {},
): string {
  return renderTimeline(view, {
    titleCap: DEFAULT_TITLE_CAP,
    tokenBudget: options.tokenBudget ?? MILESTONE_INJECTION_TOKEN_BUDGET,
    // The injection is not a paged surface: an "earlier" pointer would name a
    // window the reader never asked for.
    showEarlierHint: false,
  });
}

export function renderSessionMilestoneInjection(
  db: Database,
  sessionId: number,
  options: RenderMilestoneInjectionOptions = {},
): string {
  const view = buildTimelineView(db, {
    id: `S${sessionId}`,
    view: "milestones",
    // One page holding every selected row: the token budget, not pagination, is
    // what sizes the injection.
    pageSize: Number.MAX_SAFE_INTEGER,
    eraCutoffEpoch: options.eraCutoffEpoch ?? null,
  });
  return renderMilestoneInjection(view, options);
}
