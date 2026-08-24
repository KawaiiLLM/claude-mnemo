import type { Database } from "bun:sqlite";

import { getMaxPromptNumber } from "../db/turns";
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
 *
 * Ticket 01 (injection-milestone-split spec): this is now the WHOLE-output
 * ceiling split across up to two calls (see `renderSessionMilestoneInjection`),
 * not a single call's own budget any more — the split is invisible at this
 * constant's own value.
 */
export const MILESTONE_INJECTION_TOKEN_BUDGET = 2_500;

/**
 * Ticket 01 (injection-milestone-split spec): the RECENT/OLD split boundary —
 * a turn with `promptNumber > lastPromptNumber - MILESTONE_INJECTION_RECENT_TURNS`
 * is the RECENT side, everything else is the OLD side. 200, not smaller: the
 * live E60 regression this ticket fixes showed a session whose newest ~700
 * turns were entirely swallowed by a handful of old high-score anchors under
 * one whole-session election + one fitter pass — the recent window has to be
 * wide enough to still carry an arc of its own once it elects independently.
 */
export const MILESTONE_INJECTION_RECENT_TURNS = 200;

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

/**
 * One milestones-view call scoped to a turn-range suffix (`""` for the whole
 * session, `"/T..<n>"`/`"/T<n>.."` for a half). Reuses the id string's OWN
 * range grammar (`parseTimelineId`/`resolveWindow` in `mcp/timeline.ts`,
 * already public — `"S12/T3..7"` — and already exercised against the
 * `milestones` view by `tests/mcp/timeline.election-retirement.test.ts:377`)
 * rather than a new knob: the range narrows `windowTurns` before election, in
 * both `turns` and `milestones` views alike, so no change to
 * `mcp/timeline.ts` is needed for this split.
 */
function buildMilestoneRangeView(
  db: Database,
  sessionId: number,
  rangeSuffix: string,
  eraCutoffEpoch: number | null,
): TimelineView {
  return buildTimelineView(db, {
    id: `S${sessionId}${rangeSuffix}`,
    view: "milestones",
    // One page holding every selected row: the token budget, not pagination, is
    // what sizes the injection.
    pageSize: Number.MAX_SAFE_INTEGER,
    eraCutoffEpoch,
  });
}

/**
 * True when a view carries no milestone content on EITHER of its two render
 * surfaces (spec D11's spine-vs-legacy split): the plain kept-milestone list
 * (pre-era body, `pagedMilestones`) AND the era side's segment spine/orphan
 * rows (`segmentSpine`/`orphanAnchors`, `renderSegmentSpineBlock`'s own
 * inputs). `pagedMilestones` alone under-reports emptiness for a view whose
 * range sits entirely inside the era cutoff, where the legacy body is empty
 * by construction and all the real content lives in the spine.
 */
function hasMilestoneRows(view: TimelineView): boolean {
  return (
    view.pagedMilestones.length > 0 ||
    view.segmentSpine.length > 0 ||
    view.orphanAnchors.length > 0
  );
}

/**
 * Ticket 01 (injection-milestone-split spec): the SessionStart arc renders as
 * TWO milestones-view calls, split at
 * `lastPromptNumber - MILESTONE_INJECTION_RECENT_TURNS`, each under half the
 * token budget — recency gets a guaranteed half instead of competing against
 * the whole session's history in one election + one fitter pass, where a
 * handful of old high-score anchors could starve the newest rows entirely
 * (the live E60 regression this ticket fixes: T900-1076 rows shown, the
 * newest ~700 turns swallowed into a "+676 more" tail).
 *
 * A `↳` sub-row is scoped by construction to elected rows WITHIN THE SAME
 * call's own window (`selectMilestoneTurns`'s `buildElectedCitations`: a
 * cited turn survives on a row's `↳` line only if it is ALSO elected in that
 * SAME selection) — an OLD row never lists a RECENT antecedent or vice versa,
 * so "sub-rows follow their parent" falls out of the existing per-call
 * election with no extra bookkeeping here. Cross-boundary citation edges are
 * not lost from ranking either: `getRelationEdgesAmongTurns` matches an edge
 * whose citing OR cited endpoint is in the call's own window, so a turn just
 * across the boundary still contributes its degree signal via
 * `fetchExternalElectionTurns`'s `eligible: false` entries — it just cannot
 * itself become a candidate, or a `↳` row, in the OTHER call.
 *
 * If one side's window yields no milestone rows at all (`hasMilestoneRows`),
 * the other side renders alone under the FULL budget rather than wasting its
 * unused half — this is also what keeps a session under
 * `MILESTONE_INJECTION_RECENT_TURNS` turns (no OLD side at all) byte-identical
 * to the pre-split single call.
 *
 * The result stays ONE attachment: an old part and a recent part concatenated
 * (spec's own framing of the one-slot-one-block rule [S15069/T990] — that
 * rule is about independently growing blocks, not sub-renders within one).
 * Each part still carries its own session header line — `renderTimeline` has
 * no cheap way to suppress it for a second call, and this ticket's territory
 * does not extend to adding one.
 */
export function renderSessionMilestoneInjection(
  db: Database,
  sessionId: number,
  options: RenderMilestoneInjectionOptions = {},
): string {
  const eraCutoffEpoch = options.eraCutoffEpoch ?? null;
  const fullBudget = options.tokenBudget ?? MILESTONE_INJECTION_TOKEN_BUDGET;
  const maxPromptNumber = getMaxPromptNumber(db, sessionId);

  // No turns yet — or no such session at all, in which case the whole-session
  // call below throws the same "session not found" error the pre-split single
  // call always did. Either way there is nothing to partition: one call.
  if (maxPromptNumber === null) {
    return renderMilestoneInjection(
      buildMilestoneRangeView(db, sessionId, "", eraCutoffEpoch),
      options,
    );
  }

  const boundary = maxPromptNumber - MILESTONE_INJECTION_RECENT_TURNS;
  const recentStart = Math.max(1, boundary + 1);

  const oldView =
    boundary >= 1
      ? buildMilestoneRangeView(db, sessionId, `/T..${boundary}`, eraCutoffEpoch)
      : null;
  const recentView = buildMilestoneRangeView(
    db,
    sessionId,
    `/T${recentStart}..`,
    eraCutoffEpoch,
  );

  if (oldView === null || !hasMilestoneRows(oldView)) {
    return renderMilestoneInjection(recentView, { ...options, tokenBudget: fullBudget });
  }
  if (!hasMilestoneRows(recentView)) {
    return renderMilestoneInjection(oldView, { ...options, tokenBudget: fullBudget });
  }

  const half = Math.floor(fullBudget / 2);
  const oldPart = renderMilestoneInjection(oldView, { ...options, tokenBudget: half });
  const recentPart = renderMilestoneInjection(recentView, { ...options, tokenBudget: half });
  return `${oldPart}\n\n${recentPart}`;
}
