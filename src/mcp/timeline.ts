import type { Database } from "bun:sqlite";
import { parseInlineCitations } from "../db/citations";
import { loadLaneCheckScope, loadLaneTagsForTurns } from "../db/lane-checker-load";
import { checkCanonicalLaneTag, listLanesForSegment, type LaneRecord } from "../db/lanes";
import { getRelationEdgesAmongTurns, getRolledBackCiterIds } from "../db/memory-edges";
import {
  getSegmentMembershipForTurns,
  listOrphanAnchorTurns,
  listSegmentSpineForSession,
  type OrphanAnchorRow,
  type RankedSegmentMember,
  type SegmentSpineRow,
} from "../db/segment-rank";
import { liveTurnSql } from "../db/turn-liveness";
import type { QueryOutcome } from "./query-outcome";
import { getSegment, type SegmentRecord } from "../db/segments";
import { getSession, type SessionRecord } from "../db/sessions";
import { getFirstTurn, getTurn, getTurnById, getTurnsForSession, type TurnRecord } from "../db/turns";
import { estimateDiaryTokens } from "../diary/domain";
import { isSegmentEra } from "../segment-era";
import {
  buildComponentReport,
  MIN_REPORTED_LANE_MEMBERS,
  type LaneCheckerTurnInput,
  type LaneIsland,
} from "../shared/lane-checker";
import {
  compareOrderKeyAcrossSessions,
  deriveLaneInterpretation,
  laneToken,
  type Lane,
  type LaneInterpretation,
  type LaneKey,
  type LaneOrderKey,
} from "../shared/lane-interpretation";
import {
  DECISION_TIER_SHARE_WARN_THRESHOLD,
  electMilestones,
  type LaneEdgeInput,
  type MilestoneCandidate,
  type MilestoneTier,
  type MilestoneTurnInput,
} from "../shared/milestone-election";
import { createLogger } from "../shared/logger";
import { resolveSessionTranscriptPath } from "../shared/paths";
import { isKnownSystemInjectedContent } from "../shared/transcript-parser";
import {
  LEGACY_TYPE_GLYPH,
  MEMORY_TYPES,
  typeListGlyph,
  typeListsEqual,
  typeWordGlyph,
} from "../shared/type-vocabulary";
import { CJK_CHARACTER, estimateTokens } from "../utils/token-estimate";
import {
  defaultRelationRank,
  formatRelationArrow,
  groupHopEdges,
  rankChainCandidates,
  renderRelationTree,
  type GroupedHop,
  type RawHopEdge,
  type RelationTree,
  type TreeHop,
  type TreeSpine,
} from "./relation-tree";
import { buildTurnRelationView } from "./relations-view";

import {
  appendNavigationLegend,
  cachedFormatter,
  createTruncationSignal,
  formatDuration,
  formatGap,
  formatLocalDate,
  formatLocalMonthDay,
  formatLocalTime,
  NAVIGATION_LEGEND,
  RENDER_INDENT_STEP,
  renderSessionTransitionLine,
  renderTurnAddress,
  truncateText,
  type TruncationSignal,
} from "./format";
// Ticket 10 (write-mode-edit-semantics spec): these four re-exports keep
// existing external imports (tests/mcp/timeline.test.ts) resolving from
// "./timeline" unchanged — the functions themselves now live in format.ts
// (composeTurnMetadata's own dependency chain, moved there to avoid a
// format.ts -> timeline.ts import cycle) alongside `cachedFormatter` and
// `formatLocalMonthDay`, which this module still uses locally but nothing
// outside it imports.
export { formatDuration, formatGap, formatLocalDate, formatLocalTime };
import {
  hasFilterCriteria,
  parseMemoryFilter,
  turnMatchesFilter,
  type MemoryFilterInput,
} from "./memory-filter";
import { chronologicalSegmentMembers } from "./segment-card";
import {
  legacyEraHeader,
  renderSegmentSpineBlock,
} from "./segment-spine";
import {
  recordReadGrants,
  snapshotWriteGateSequence,
  type ReadGrantEntry,
} from "../db/write-gate";

/**
 * The ONE prefix every internal timeline failure funnels through — the
 * final catch-all's own literal, restated here as a named export so
 * `timelineQueryOutcome` (ticket 16 scope addition) can detect "this render
 * failed" structurally, by a stable code-owned marker, rather than by
 * pattern-matching whatever prose follows it.
 */
export const TIMELINE_ERROR_PREFIX = "timeline error: ";

export interface TimelineInput {
  id: string;
  page?: number;
  /** `turns`/`lane` views only (page-budget-is-the-seat-count spec, decision 2) — paginates those views' own pages. No effect on the `milestones` view any more: `pageBudget` below is what sizes it, and election ranks every candidate regardless of this value. */
  pageSize?: number;
  /**
   * Ticket 07 (lane-declaration spec D8): `"lane"` is accepted here (the
   * schema-level literal the tool surface exposes, `mcp/definitions.ts`) so
   * the exact call the spec names — `timeline(id="E60/L*", view="lane")` —
   * does not fail `.strict()` validation. It is otherwise INERT: routing to
   * the lane view is driven entirely by the id's own `E<n>/L*`/`E<n>/L<n>`
   * suffix (`parseSegmentLaneId`), never by this field, so a bare `E<n>` (or
   * `S<n>`) id with `view: "lane"` falls back to that route's ordinary
   * default view — `timelineQuery`'s own `narrowToBaseView` is what strips
   * it back to `undefined` before either of the other two routes ever reads
   * it, keeping `buildTimelineView`/`buildSegmentTimelineView`'s own
   * `TimelineViewKind` switch exactly as narrow as before this ticket.
   */
  view?: TimelineViewKind | "lane";
  /**
   * P2 era boundary (spec D11). Turns created at or after it render as the
   * segment spine; earlier turns keep the legacy arc, in the same view. `null`
   * or omitted — the product default until ticket 09 — puts every turn on the
   * legacy path, so the output is byte-identical to the pre-segment renderer.
   */
  eraCutoffEpoch?: number | null;
  /**
   * Ticket 04 (spec "Tools"): the same structured filter grammar `recall`
   * carries — {type, tag, session, time, file} — AND-composed with the id
   * selector's range. Narrows `windowTurns` (the display candidate set) right
   * after the range does, before the turn table, milestone selection, and
   * shape signals consume it; the citation-resolution universe
   * (`legacySessionTurns`/`eraSessionTurns`) stays unfiltered, same as it
   * already ignores the range — a filtered-out turn can still be cited as an
   * antecedent.
   */
  filter?: MemoryFilterInput;
  /**
   * Ticket 05 (spec "Budgets"): the `E<n>` route's turn view's per-page token
   * ceiling (`SegmentTimelineInput.pageBudget`), default
   * `DEFAULT_MILESTONE_PAGE_BUDGET` (1000, ADR-0006's per-segment share).
   *
   * Page-budget-is-the-seat-count spec, decision 1: this IS every
   * MILESTONES-view surface's admission budget now — the standalone `E<n>`
   * route, the `S<n>` era spine's own nested per-segment rows
   * (`selectSegmentMilestonesByEdgeSignals`, shared by both — see
   * `TimelineView.segmentMilestoneSelection`, which reuses this same default
   * per segment), AND the `S<n>` legacy (pre-era) milestone body
   * (`RenderTimelineOptions.tokenBudget` takes precedence when set — the
   * SessionStart injection's own internal knob — otherwise this falls back to
   * it, `renderTimeline`'s own `effectiveBudget`). `pageSize` plays no part
   * in any of these any more (decision 2) — only in the `S<n>`/`E<n>` `turns`
   * view's own item-count pagination. Bounded-read-surfaces ticket 01: this
   * is ALSO the `S<n>` era spine's own LINE-count ceiling (`shedSpineToBudget`)
   * and the `E<n>/L*` lane-list route's own page budget
   * (`buildSegmentLaneListView`) — every one of these defaults to
   * `DEFAULT_MILESTONE_PAGE_BUDGET` when omitted.
   */
  pageBudget?: number;
  /**
   * Write gate (ticket 01, read-write-contract spec): same seam as
   * `RecallInput.readerId` — the writer identity whose read grant this
   * render should record for whatever it ends up showing. Absent/null
   * records nothing.
   */
  readerId?: string | null;
  /** Test seam for the read-grant timestamp; defaults to the real clock. */
  now?: () => number;
  /**
   * Forwarded to `SegmentTimelineInput.taskCausalityEraCutoffEpoch` on the
   * standalone `E<n>` route, and threaded into the `S<n>` era spine's own
   * nested per-segment milestone rows (`selectSegmentMilestonesByEdgeSignals`,
   * shared with the `E<n>` route). Milestone-election spec, ticket 03: era
   * gating retired from candidacy on both routes — this field is now
   * accepted-but-unread for schema stability (see
   * `SegmentTimelineInput.taskCausalityEraCutoffEpoch`'s own doc comment).
   * The turns-view/legacy-milestone-body path (`selectMilestoneTurns`) never
   * took this field at all, unchanged.
   */
  taskCausalityEraCutoffEpoch?: number;
}

// Ticket 04 (spec "Tools"): `phases` retired — a parse error at the schema
// layer (definitions.ts's `timelineInputShape`); its renderer is deleted
// below rather than left reachable dead code.
export type TimelineViewKind = "turns" | "milestones";

export interface TimelineView {
  view: TimelineViewKind;
  session: SessionRecord;
  totalTurns: number;
  firstPromptNumber: number;
  lastPromptNumber: number;
  totalToolCalls: number;
  typesDistribution: TypesDistribution;
  compactBoundaries: number[];
  window: ResolvedWindow;
  windowTurns: TurnRecord[];
  pageTurns: TurnRecord[];
  pagedMilestones: KeptMilestone[];
  milestoneDayGroups: MilestoneDayGroup[];
  viewItemTotal: number;
  pageAnchorEpoch: number | null;
  page: number;
  pageSize: number;
  pageCount: number;
  windowSignals: ShapeSignals;
  jsonlPath: string | null;
  tz: { name: string; offsetLabel: string };
  hasEarlier: boolean;
  /** Fork-lineage breadcrumb string, or null for root sessions. */
  breadcrumb: string | null;
  /** The era boundary this view was built against; null = everything legacy. */
  eraCutoffEpoch: number | null;
  /**
   * Window turns on the era side. The legacy selection never sees these — a
   * turn is read under exactly one set of semantics — and their presence is
   * what makes the renderer emit both blocks.
   */
  eraWindowTurns: TurnRecord[];
  /** Segment rows for the era side of this session (arc view only). */
  segmentSpine: SegmentSpineRow[];
  /** Era turns with hard mechanical signals that no segment claimed. */
  orphanAnchors: OrphanAnchorRow[];
  /**
   * Ticket 05/12: the era spine's NESTED per-segment milestone selection —
   * computed EAGERLY here (`buildTimelineView` has `db`), via the same
   * election-based selection (`selectSegmentMilestonesByEdgeSignals`, now
   * `shared/milestone-election.ts`'s `electMilestones` under the hood —
   * milestone-election spec, ticket 03) the standalone `E<n>` route uses, so the render-time step
   * (`renderEraMilestoneLines`) stays a pure function of `TimelineView` the
   * way every other render step is. Keyed by segment id; only entries for
   * segments in `segmentSpine`. Empty with no era cutoff.
   */
  segmentMilestoneSelection: ReadonlyMap<number, SegmentMilestoneEdgeSelection>;
  /**
   * Turn DB id → owning segment id, scoped to `eraWindowTurns` (spec D8:
   * membership is exclusive in practice, so this is a plain map, not a
   * multimap). A kept era row absent from this map belongs to no segment and
   * renders no nested row (spec D9) — it may still surface as an orphan
   * anchor, which is a separate, pre-existing mechanism.
   */
  eraSegmentIdByTurnId: ReadonlyMap<number, number>;
  /**
   * Ticket 05: `↳` antecedents for `pageTurns`, resolved eagerly here
   * (`resolveTurnRowLinks`) so the render step stays a pure function of
   * `TimelineView` like every other one. Keyed by turn DB id; empty outside
   * the turns view.
   */
  turnRowLinks: ReadonlyMap<number, TurnRowLinks>;
}

export interface RenderTimelineOptions {
  showEarlierHint?: boolean;
  /**
   * Character ceiling on any rendered title, in every view (spec §D). Replaces
   * the old per-view 80/90-char constants. NOT part of the public MCP schema:
   * the tool surface sizes itself by pagination alone, and this knob exists for
   * the SessionStart injection.
   */
  titleCap?: number;
  /**
   * Whole-output token budget (spec §D), the SessionStart injection's own
   * internal-only knob — takes precedence over `pageBudget` below when set.
   * Page-budget-is-the-seat-count spec, decision 1: EVERY milestones render
   * is budget-bounded now (this, or else `pageBudget`, or else
   * `DEFAULT_MILESTONE_PAGE_BUDGET` — `renderTimeline`'s own
   * `effectiveBudget`) — there is no unbounded "every MCP view" path left.
   * The fitter degrades lowest-election-rank render units first (desc →
   * drop the unit) until the output fits, cutting in election-rank order
   * (decision 3); a set that still overruns after every unit is gone is
   * rendered in full with one overflow note appended.
   */
  tokenBudget?: number;
  /**
   * See `TimelineInput.pageBudget`. Page-budget-is-the-seat-count spec,
   * decision 1: this IS the `S<n>` era spine's NESTED per-segment rows'
   * admission budget too now (selection happens eagerly in
   * `buildTimelineView`, keyed on `DEFAULT_MILESTONE_PAGE_BUDGET` — see
   * `TimelineView.segmentMilestoneSelection`), alongside its own pre-existing
   * job (bounded-read-surfaces ticket 01) as the era spine's OWN size ceiling
   * — the segment/orphan LINE list itself (`shedSpineToBudget`) — on every
   * MCP milestones-view call, since `tokenBudget` above is an internal-only
   * knob (the SessionStart injection) no MCP caller ever sets, and the spine
   * carries a session's whole era history with no count cap of its own.
   */
  pageBudget?: number;
}

export interface SystemTimezoneSource {
  timeZone?: string;
  resolveTimeZoneName?: (
    referenceEpochSeconds: number,
    timeZone: string,
  ) => string;
  resolveOffsetMinutes?: (referenceEpochSeconds: number) => number;
}

export const DEFAULT_TIMELINE_PAGE_SIZE = 30;
export const BROKEN_PROMPT_MIN_PREFIX = 20;

/**
 * phase-connectivity ticket 03, decision 2 (share sentinel): the only
 * structured-log channel this file writes to, reused rather than threading a
 * new logger dependency through the hook/MCP call chains that reach
 * `selectSegmentMilestonesByEdgeSignals` — same `createLogger` convention
 * `hooks/hook-command.ts` and `diary/memory-store.ts` already use, this
 * file's own unused `"MCP"` component.
 */
const timelineLogger = createLogger("MCP");
export const BROKEN_PROMPT_MAX_GAP_MS = 5 * 60 * 1000;
export const TOOL_BURST_TOP_N = 3;

/**
 * Default for `RenderTimelineOptions.titleCap` — the single character ceiling on
 * a rendered title, shared by every view (spec §D). The old split caps (80 in the
 * turn table, 90 in the milestone digest, and a 50-char injection-only stage) cut
 * real titles mid-clause: measured title P50 is 72 characters.
 */
export const DEFAULT_TITLE_CAP = 100;

/**
 * Hard per-render-unit token ceiling (spec §D). A unit is one spine row plus the
 * `↳` antecedents homed under it; `estimateDiaryTokens` measures it. This is a
 * ceiling, not a quota — a full spine row costs about 70-85 tokens.
 *
 * 150 and not 100: the earlier 100 was estimated off the spine row ALONE and
 * forgot that the `↳` rows count against the same unit. A 70-88-token spine row
 * plus even one 25-32-token antecedent already breaches 100, so every unit that
 * pulled anything would have folded its antecedents away and the pull-through
 * mechanism would have been decorative. 150 lets "spine + 2 antecedents" survive
 * intact; total output size stays bounded by the global `tokenBudget`.
 */
export const MILESTONE_UNIT_TOKEN_CAP = 150;
/**
 * Ticket 05 (spec "Budgets"/ADR-0006): default `pageBudget` — a segment's
 * nested/standalone milestone list admits state-cited ∪ A-tier rows
 * unconditionally and fills whatever is left with B-tier rows. ADR-0006 pins
 * this exact number as one segment's SessionStart milestone share.
 */
export const DEFAULT_MILESTONE_PAGE_BUDGET = 1000;
/** Max `↳` rows rendered under one spine row; the rest fold into `↳ +N 前件`. */
export const MILESTONE_UNIT_PULLED_CAP = 4;
/**
 * Character budget for the user-prompt prefix carried on a spine row. Kept well
 * under the title cap on purpose: the prefix is a turn-of-phrase signal, and the
 * unit's token cap sacrifices the TITLE before the prefix, so a generous prefix
 * would let the user's opening words crowd out the conclusion they led to.
 */
export const MILESTONE_PROMPT_PREFIX_CAP = 32;
/** Max `✏️` basenames on a spine row before the tail collapses to `+N`. */
export const MILESTONE_FILE_BASENAME_CAP = 3;
/** What a harness-injected prompt (task notification, command envelope) collapses to. */
export const MILESTONE_NOTIFICATION_MARKER = "⟨notify⟩";
/**
 * Appended when the always-keep units alone overrun `tokenBudget`. Anchors are
 * never dropped silently: the reader is told the budget was exceeded instead.
 */
export const MILESTONE_OVER_BUDGET_NOTE =
  "  ⚠ over budget: anchor rows kept in full";
const MILESTONE_DESC_INDENT = "            ";
const MILESTONE_DESC_WRAP_CHARS = 92;

export const OUTCOME_TAGS = new Set([
  "merged",
  "shipped",
  "released",
  // `release` (singular/imperative stem) is how release turns tag themselves;
  // `released`/`shipped` are already present. Do NOT add the bare verbs
  // `push`/`pushed`/`merge`/`ship` — those occur mid-work and would mint false
  // always-keep outcome markers.
  "release",
  "ready-to-merge",
  "approved",
  "finalized",
]);

const REVERSED_ROLE_TAGS = new Set(["rolled-back"]);

// Version-bump file set, per the project release ritual: package.json plus the
// marketplace/plugin manifests. Matched on path suffix because stored paths may
// be relative or absolute.
const PLUGIN_MANIFEST_SUFFIXES = [
  "marketplace.json",
  "plugin/.claude-plugin/plugin.json",
  ".claude-plugin/plugin.json",
];

/**
 * Version-file backstop for outcome detection: a turn that modifies the
 * version-bump file set (a `package.json` AND at least one plugin/marketplace
 * manifest) is a release even when it carries no outcome tag. Suffix-matched so
 * relative and absolute stored paths both resolve.
 */
export function isVersionBumpTurn(filesModified: string[]): boolean {
  const hasPackageJson = filesModified.some((path) =>
    path.endsWith("package.json"),
  );
  if (!hasPackageJson) {
    return false;
  }

  return filesModified.some((path) =>
    PLUGIN_MANIFEST_SUFFIXES.some((suffix) => path.endsWith(suffix)),
  );
}

// Reversal-keyword tags for the optional, decision-gated reversal detection in
// milestoneMarker (the enableReversalKeyword knob, off by default).
export const REVERSAL_KEYWORD_TAGS = new Set([
  "reversal",
  "reversed",
  "superseded",
  "supersede",
  "reframed",
  "reframe",
  "design-pivot",
  "pivot",
]);

export type MilestoneMarker = "invalidated" | "reversed" | "outcome" | null;

export type RangeSpec =
  | { kind: "none" }
  | { kind: "all" }
  | { kind: "closed"; start: number; end: number }
  | { kind: "openStart"; end: number }
  | { kind: "openEnd"; start: number };

export interface ParsedId {
  sessionId: number;
  range: RangeSpec;
}

export interface ResolvedWindow {
  startPromptNumber: number;
  endPromptNumber: number;
  totalTurns: number;
}

export interface Phase {
  kind: "typed" | "pending";
  /** Multi-valued (ticket 02, spec B5); `[]` for a "pending" phase. */
  type: string[];
  emoji: string;
  startPromptNumber: number;
  endPromptNumber: number;
  startEpoch: number;
  endEpoch: number;
  turnCount: number;
  totalToolCalls: number;
  totalFilesRead: number;
  totalFilesModified: number;
  durationMs: number;
  externalInputs: string[];
}

/**
 * The session-wide activity summary (the `types:` header line).
 *
 * Open, not a closed record. It used to be seven fixed legacy buckets read off
 * `type[0]`, which ticket 02 turned into a silent regression rather than a
 * stale nicety: a session written in the current vocabulary counted toward NO
 * bucket at all — not even the empty one, since those turns do state a word —
 * so the line rendered zeros for exactly the sessions it was meant to describe.
 * Keying on the word itself is what stops the summary needing an edit every
 * time the vocabulary does.
 */
export interface TypesDistribution {
  /**
   * How many live turns stated each activity word. A multi-valued turn
   * contributes once to EACH of its words, so these sum to more than the live
   * turn count — the line answers "how much of each activity happened", not
   * "how do the turns partition".
   */
  words: Record<string, number>;
  /** Live turns that stated no activity word at all (spec B7's empty). */
  none: number;
}

export interface ShapeSignals {
  fastestGap: { afterPromptNumber: number; ms: number } | null;
  longestGap: { afterPromptNumber: number; ms: number } | null;
  toolBursts: Array<{ promptNumber: number; toolCallCount: number }>;
  toolBurstMedian: number;
  toolBurstThreshold: number;
  brokenPromptPairs: Array<{ first: number; second: number }>;
  undoneTurns: number[];
  externalInputs: Array<{ promptNumber: number; source: string }>;
}

/**
 * One `↳` entry (page-budget-is-the-seat-count spec, decision 5): the cited
 * turn's own DB id alongside its pre-formatted display text. Selection now
 * admits every window candidate unbounded, so a row's antecedent can name a
 * turn the RENDER-TIME budget fitter later drops — `turnId` is what lets
 * `createMilestoneBodyModel`'s `removeUnit` find and strip exactly that entry
 * from every surviving citer, so a `↳` line never outlives the row it points
 * at (a bare formatted string could not be traced back to its target without
 * re-parsing it).
 */
export interface MilestoneAntecedentRef {
  turnId: number;
  /** `T<n>(word,word2)` (edge-read-surface spec, ticket 01) — `()` omitted when the pair carries no relation word. */
  address: string;
}

export interface KeptMilestone {
  turn: TurnRecord;
  /**
   * Strict election-rank ordinal, higher is better (milestone-election spec,
   * ticket 03): monotonically decreasing with `electMilestones`'s own
   * tier/in-degree/out-degree/order rank, so ties never occur among a
   * selection's own rows. Degradation order only (`compareMilestoneRank`,
   * `milestoneDegradationOrder`) — DISPLAY order is always chronological
   * (spec step 5), never this.
   */
  score: number;
  /** The election tier `electMilestones` assigned this row (1 highest .. 5 lowest) — informational, never rendered as a badge (no grade/tier label survives on any surface). */
  tier: MilestoneTier;
  marker: MilestoneMarker;
  /**
   * `↳` addresses (spec step 5): this row's OWN cited turns that are
   * themselves in the (now unbounded) selection — ascending by the cited
   * turn's prompt number. An uncited or excluded turn is omitted entirely,
   * never pulled in as a separate row; the line's rendering (and
   * token-budget) cost is folded into THIS row's own unit — no separate
   * pulled-antecedent object survives this ticket (contrast the retired
   * `PulledAntecedent`). Page-budget-is-the-seat-count spec, decision 5: this
   * is the SELECTION-time set (every elected citation); the RENDER-time
   * fitter narrows it further to entries whose target still survives — see
   * `MilestoneAntecedentRef`.
   */
  antecedents: MilestoneAntecedentRef[];
}

export interface OverflowHint {
  date: string;
  count: number;
  firstPrompt: number;
  lastPrompt: number;
  /**
   * Epoch of the day's first hidden turn. A day whose turns were ALL hidden owns
   * no kept row to take a label epoch from, and it still has to render its count
   * — so the hint carries its own anchor for the weekday format.
   */
  labelEpoch: number;
}

export interface MilestoneSelection {
  /**
   * Page-budget-is-the-seat-count spec (decision 1): EVERY non-excluded
   * window candidate, no admission cap — re-sorted to TIME order (spec step 5
   * — "elected rows render in TIME order, never score order"). Identical
   * membership to `ranked`, below; only the sort order differs. Which of
   * these actually RENDER is a render-time question now — the token-budget
   * fitter (`fitMilestoneBodyToBudget`) decides survival, cutting in election
   * rank order, lowest first.
   */
  kept: KeptMilestone[];
  /**
   * Every non-excluded window candidate, election-rank order (best first).
   * `compareMilestoneRank` sorts with this array's own order (via `score`);
   * the renderer's degradation ladder reads it in reverse to decide what a
   * `tokenBudget` sheds first. Shares object identity with `kept` — same
   * members, sorted differently.
   */
  ranked: KeptMilestone[];
  /**
   * Always empty (page-budget-is-the-seat-count spec): selection no longer
   * excludes any non-excluded candidate for admission reasons, so there is
   * nothing left to attribute to a day here. Kept on the interface — rather
   * than deleted — because `buildMilestoneDayGroups`/`createMilestoneBodyModel`
   * still read it defensively; the render-time fitter's own per-day
   * `hiddenCount` (via `removeUnit`) is the live overflow signal now.
   */
  overflowByDay: OverflowHint[];
}

export interface MilestoneDayGroup {
  date: string;
  labelEpoch: number; // local-date epoch anchor for formatting (createdAtEpoch of first row)
  promptLo: number; // full-day range, not page-local
  promptHi: number;
  keptCount: number; // full-day kept count, not page-local
  rows: KeptMilestone[]; // this page's slice
  continued: boolean; // true when this is not the day's first slice
  isFinalSliceForDay: boolean;
  overflow: OverflowHint | null; // attached only on the final slice
}

export const PENDING_EMOJI = "⏳";

// The turn TABLE is dissolved (spec 补充裁决 "turns 表溶解"). There is no
// tabular surface left on any read path and no `T# | time | gap | stats | G |
// prompt → title` header: the turn view renders the ONE row form every other
// surface renders, plus the `metadata` field slot, which is where the table's
// time/gap/stats columns went. The `G` column left with the grade DISPLAY
// retirement — the grading machinery itself is ticket 02's scope.

/** The hierarchy rungs this view renders at: `[S]` → `[T]` → field rows. */
const TIMELINE_SESSION_INDENT = RENDER_INDENT_STEP;
const TIMELINE_TURN_INDENT = `${RENDER_INDENT_STEP}${RENDER_INDENT_STEP}`;
const TIMELINE_FIELD_INDENT = `${RENDER_INDENT_STEP}${RENDER_INDENT_STEP}${RENDER_INDENT_STEP}`;

/**
 * Ticket 10 (the-card-is-turn-rows-and-nothing-else), decision 6: the
 * injected card's own reserve, replacing `HEADER_AND_POINTER_RESERVE_TOKENS`
 * (120) + the legend reserve (~40) for `cardMode` selections only. The card
 * has no header line to reserve for any more (deleted by this ticket) and no
 * Legend (also deleted — decision 6 sets that reserve to exactly 0), so the
 * only thing left is the trailing `renderMilestoneDemotedPointer` line's own
 * worst case: `estimateTokens("        … +999999 more")` — a 6-digit
 * demoted count, comfortably past any real segment's live-member count —
 * prices at 6 honest tokens (the pointer's ASCII chrome costs a quarter-token
 * per char; a 3- through 6-digit count all land at 5-6 tokens under that
 * weighting, so digit width barely moves the number). 10 leaves a 4-token
 * margin over that measured worst case.
 */
const CARD_POINTER_RESERVE_TOKENS = 10;

/**
 * The glyph for a turn's type list (ticket 02, spec B5): `[]` — no type
 * stated — is the pending placeholder, never a positive value (spec B7);
 * otherwise `typeListGlyph` resolves current AND legacy vocabulary words
 * alike, joining more than one into a multi-glyph read.
 */
function typeEmoji(type: readonly string[]): string {
  if (type.length === 0) {
    return PENDING_EMOJI;
  }
  return typeListGlyph(type);
}

/**
 * The milestone row's SINGLE emoji (row-slimming ticket 01, decision 3): the
 * FIRST stored type's glyph only, never the whole-list cluster `typeEmoji`
 * builds for the `turns` view and lane headers — that cluster is exactly the
 * fat this row sheds. The empty-type case is unchanged from `typeEmoji`:
 * `PENDING_EMOJI`, never an invented placeholder.
 */
function firstTypeEmoji(type: readonly string[]): string {
  if (type.length === 0) {
    return PENDING_EMOJI;
  }
  return typeWordGlyph(type[0]!);
}

type PaginatedItems<T> = { items: T[]; total: number; pageCount: number };

function paginateItems<T>(
  items: T[],
  page: number,
  pageSize: number,
): PaginatedItems<T> {
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const offset = (page - 1) * pageSize;

  return {
    items: items.slice(offset, offset + pageSize),
    total,
    pageCount,
  };
}

function emptyPaginatedItems<T>(total: number, pageSize: number): PaginatedItems<T> {
  return {
    items: [],
    total,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export function parseTimelineId(id: string): ParsedId {
  const trimmed = id.trim();
  if (!trimmed) {
    throw new Error("timeline id is empty");
  }

  const match = trimmed.match(/^S(\d+)(?:\/T(.+))?$/i);
  if (!match) {
    throw new Error(`timeline id does not match 'S<n>' or 'S<n>/T...': ${id}`);
  }

  const sessionId = Number(match[1]);
  const rangeValue = match[2];

  if (rangeValue === undefined) {
    return { sessionId, range: { kind: "none" } };
  }

  if (rangeValue === "*") {
    return { sessionId, range: { kind: "all" } };
  }

  // `T19..T21` is as legal as `T19..21` — see selectors.ts ([S15069/T1021]).
  const closed = rangeValue.match(/^(\d+)\.\.T?(\d+)$/i);
  if (closed) {
    const start = parsePositiveBound(closed[1], id);
    const end = parsePositiveBound(closed[2], id);
    if (start > end) {
      throw new Error(`timeline range start must be <= end: ${id}`);
    }
    return {
      sessionId,
      range: { kind: "closed", start, end },
    };
  }

  const openStart = rangeValue.match(/^\.\.(\d+)$/);
  if (openStart) {
    const end = parsePositiveBound(openStart[1], id);
    return {
      sessionId,
      range: { kind: "openStart", end },
    };
  }

  const openEnd = rangeValue.match(/^(\d+)\.\.$/);
  if (openEnd) {
    const start = parsePositiveBound(openEnd[1], id);
    return {
      sessionId,
      range: { kind: "openEnd", start },
    };
  }

  if (/^\d+$/.test(rangeValue)) {
    throw new Error(
      `timeline does not accept single turn forms; use recall(id='S${sessionId}/T${rangeValue}') instead`,
    );
  }

  throw new Error(`timeline range syntax not recognized: T${rangeValue}`);
}

/**
 * `S<n>/T<m>` — a single, legal turn address, no range operator (ticket 13
 * decision 5's node selector). Deliberately narrow: anything that does not
 * match this EXACT shape (a malformed grammar, a range, `T*`, …) returns
 * `null` and falls through to the existing routes below, `parseTimelineId`'s
 * own established error messages included — this function only ever
 * INTERCEPTS the one shape that used to be a hard rejection.
 */
export function parseTurnNodeId(id: string): { sessionId: number; promptNumber: number } | null {
  const match = id.trim().match(/^S(\d+)\/T(\d+)$/i);
  if (!match) {
    return null;
  }
  return { sessionId: Number(match[1]), promptNumber: Number(match[2]) };
}

export interface PromptNumberBounds {
  first: number;
  last: number;
}

export function resolveWindow(
  range: RangeSpec,
  totalTurns: number,
  bounds: PromptNumberBounds = { first: 1, last: totalTurns },
): ResolvedWindow {
  const { first, last } = bounds;

  if (totalTurns === 0) {
    return {
      startPromptNumber: first,
      endPromptNumber: first - 1,
      totalTurns: 0,
    };
  }

  if (range.kind === "none" || range.kind === "all") {
    return {
      startPromptNumber: first,
      endPromptNumber: last,
      totalTurns,
    };
  }

  if (range.kind === "closed") {
    validateClosedRange(range);
    const startPromptNumber = Math.max(first, range.start);
    if (startPromptNumber > last) {
      throw new Error(
        `timeline range starts beyond session end: start prompt ${startPromptNumber} exceeds last prompt T${last}`,
      );
    }

    return {
      startPromptNumber,
      endPromptNumber: Math.min(range.end, last),
      totalTurns,
    };
  }

  if (range.kind === "openEnd") {
    validateOpenEndRange(range);
    const startPromptNumber = Math.max(first, range.start);
    if (startPromptNumber > last) {
      throw new Error(
        `timeline range starts beyond session end: start prompt ${startPromptNumber} exceeds last prompt T${last}`,
      );
    }

    return {
      startPromptNumber,
      endPromptNumber: last,
      totalTurns,
    };
  }

  if (range.kind === "openStart") {
    validateOpenStartRange(range);
    const endPromptNumber = Math.min(range.end, last);

    return {
      startPromptNumber: first,
      endPromptNumber,
      totalTurns,
    };
  }

  throw new Error(`Unknown range kind: ${(range as { kind: string }).kind}`);
}

/**
 * The `/name` inside a slash-command envelope, or null when there is none.
 * Shared by the turn table and the arc rows so a `/compact`-style prompt reads
 * the same on both surfaces: the envelope is harness-injected XML, but the
 * command name inside it IS what the user typed and must survive the
 * injected-content collapse.
 */
export function extractCommandName(raw: string): string | null {
  const match = raw.match(/<command-name>\s*([^<]+?)\s*<\/command-name>/);
  return match ? match[1]!.trim() : null;
}

export function cleanPromptForLabel(raw: string | null): string {
  if (raw === null) {
    return "";
  }

  const commandName = extractCommandName(raw);
  if (commandName !== null) {
    return commandName;
  }

  const stripped = raw
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, "")
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, "")
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, "")
    .replace(/<command-args>[\s\S]*?<\/command-args>/g, "");

  const firstLine =
    stripped
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";

  return firstLine.replace(/\s+/g, " ").trim();
}

function formatLocalWeekday(epochSeconds: number): string {
  return cachedFormatter("weekday", "en-US", {
    weekday: "short",
  }).format(new Date(epochSeconds * 1000));
}

function formatLocalDateWithWeekday(epochSeconds: number): string {
  return `${formatLocalDate(epochSeconds)} ${formatLocalWeekday(epochSeconds)}`;
}

function formatLocalMonthDayWithWeekday(epochSeconds: number): string {
  return `${formatLocalMonthDay(epochSeconds)} ${formatLocalWeekday(epochSeconds)}`;
}

function sameLocalDate(leftEpoch: number, rightEpoch: number): boolean {
  return formatLocalDate(leftEpoch) === formatLocalDate(rightEpoch);
}

export function getSystemTimezone(
  referenceEpochSeconds = Math.floor(Date.now() / 1000),
  source: SystemTimezoneSource = {},
): { name: string; offsetLabel: string } {
  const ianaName = source.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const name = source.resolveTimeZoneName
    ? source.resolveTimeZoneName(referenceEpochSeconds, ianaName)
    : new Intl.DateTimeFormat("en-US", {
        timeZone: ianaName,
        timeZoneName: "short",
      })
        .formatToParts(new Date(referenceEpochSeconds * 1000))
        .find((part) => part.type === "timeZoneName")?.value ?? ianaName;

  const offsetMinutes = source.resolveOffsetMinutes
    ? source.resolveOffsetMinutes(referenceEpochSeconds)
    : -new Date(referenceEpochSeconds * 1000).getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteMinutes = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absoluteMinutes / 60)).padStart(2, "0");
  const minutes = String(absoluteMinutes % 60).padStart(2, "0");

  return {
    name,
    offsetLabel: `${sign}${hours}:${minutes}`,
  };
}

export function extractSourceTags(tags: string[]): string[] {
  return tags
    .filter((tag) => tag.startsWith("source:"))
    .map((tag) => tag.slice("source:".length));
}

export function milestoneMarker(
  turn: TurnRecord,
  options: { enableReversalKeyword?: boolean } = {},
): MilestoneMarker {
  if (turn.status === "undone" || turn.wasInterrupted) {
    return "invalidated";
  }

  const keywordReversal =
    options.enableReversalKeyword === true &&
    turn.type.includes("decision") &&
    turn.tags.some((tag) => REVERSAL_KEYWORD_TAGS.has(tag));
  const roleReversal = turn.tags.some((tag) => REVERSED_ROLE_TAGS.has(tag));

  if (turn.wasRolledBack || roleReversal || keywordReversal) {
    return "reversed";
  }

  if (
    turn.tags.some((tag) => OUTCOME_TAGS.has(tag)) ||
    isVersionBumpTurn(turn.filesModified)
  ) {
    return "outcome";
  }

  return null;
}

// The effGrade truth table, its tie-break, and the whole always-keep/
// correction-graph/pull-through machinery that used to live here (spec §C of
// the retired grade-first arc) are RETIRED (milestone-election spec, ticket
// 03): `selectMilestoneTurns`/`selectSegmentMilestonesByEdgeSignals` below
// delegate to `shared/milestone-election.ts`'s `electMilestones` instead.
// Grading itself is untouched — `significanceGrade`/`milestoneEffGrade`-style
// truth tables may still exist for OTHER consumers (settlement) — only their
// role in milestone ELECTION is gone. See
// `tests/mcp/timeline.election-retirement.test.ts` for the grep-guards
// pinning this.

const MILESTONE_VERSION_RE = /\b0\.\d+\.\d+\b/g;

function extractMilestoneVersion(title: string | null): string | null {
  if (!title) return null;
  const matches = [...title.matchAll(MILESTONE_VERSION_RE)];
  return matches.length > 0 ? matches[matches.length - 1]![0] : null;
}

function demotedOutcomePrompts(seq: TurnRecord[]): Set<number> {
  const byDay = new Map<string, TurnRecord[]>();
  for (const turn of seq) {
    if (milestoneMarker(turn) !== "outcome") {
      continue;
    }
    const day = formatLocalDate(turn.createdAtEpoch);
    const bucket = byDay.get(day) ?? [];
    bucket.push(turn);
    byDay.set(day, bucket);
  }

  const demoted = new Set<number>();
  const closeChain = (chain: TurnRecord[]): void => {
    for (const turn of chain.slice(0, -1)) {
      demoted.add(turn.promptNumber);
    }
  };

  for (const turns of byDay.values()) {
    const sorted = [...turns].sort((a, b) => a.promptNumber - b.promptNumber);
    let chain: TurnRecord[] = [];
    for (const turn of sorted) {
      if (chain.length === 0) {
        chain = [turn];
        continue;
      }
      const previous = chain[chain.length - 1]!;
      const previousVersion = extractMilestoneVersion(previous.title);
      const currentVersion = extractMilestoneVersion(turn.title);
      const sameRelease =
        turn.promptNumber - previous.promptNumber <= 5 &&
        !(previousVersion !== null && currentVersion !== null && previousVersion !== currentVersion);
      if (sameRelease) {
        chain.push(turn);
      } else {
        closeChain(chain);
        chain = [turn];
      }
    }
    closeChain(chain);
  }

  return demoted;
}

function getCompactMetadata(tags: string[]): {
  preTokens: number;
  trigger: string;
} | null {
  let preTokens = 0;
  let trigger = "manual";
  let sawCompactTag = false;

  for (const tag of tags) {
    if (tag.startsWith("compact:pre_tokens=")) {
      const rawValue = Number(tag.slice("compact:pre_tokens=".length));
      if (Number.isFinite(rawValue) && rawValue >= 0) {
        preTokens = rawValue;
      }
      sawCompactTag = true;
      continue;
    }

    if (tag.startsWith("compact:trigger=")) {
      trigger = tag.slice("compact:trigger=".length) || trigger;
      sawCompactTag = true;
    }
  }

  return sawCompactTag ? { preTokens, trigger } : null;
}

function formatCompactTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = Math.round((tokens / 1_000_000) * 10) / 10;
    return `${millions % 1 === 0 ? millions.toFixed(0) : millions.toFixed(1)}M`;
  }

  if (tokens >= 1_000) {
    return `${Math.round(tokens / 1_000)}k`;
  }

  return String(tokens);
}

export function segmentPhases(turns: TurnRecord[]): Phase[] {
  const sortedTurns = sortTurnsForAnalysis(turns);
  const phases: Phase[] = [];
  let current: Phase | null = null;
  let currentStartEpoch = 0;
  let currentEndEpoch = 0;

  for (const turn of sortedTurns) {
    if (!isTimelineLiveTurn(turn)) {
      continue;
    }

    const kind: Phase["kind"] = turn.type.length === 0 ? "pending" : "typed";
    const emoji = typeEmoji(turn.type);

    // ticket 02, spec B5: `type` is a list now, so a phase boundary is
    // identity over the WHOLE ordered list, not a scalar `!==` — two turns
    // share a phase iff their type lists are identical (`typeListsEqual`).
    if (
      current === null ||
      current.kind !== kind ||
      !typeListsEqual(current.type, turn.type)
    ) {
      if (current !== null) {
        current.durationMs = (currentEndEpoch - currentStartEpoch) * 1000;
      }

      current = {
        kind,
        type: turn.type,
        emoji,
        startPromptNumber: turn.promptNumber,
        endPromptNumber: turn.promptNumber,
        startEpoch: turn.createdAtEpoch,
        endEpoch: turn.createdAtEpoch,
        turnCount: 0,
        totalToolCalls: 0,
        totalFilesRead: 0,
        totalFilesModified: 0,
        durationMs: 0,
        externalInputs: [],
      };
      phases.push(current);
      currentStartEpoch = turn.createdAtEpoch;
    }

    current.endPromptNumber = turn.promptNumber;
    current.endEpoch = turn.createdAtEpoch;
    current.turnCount += 1;
    current.totalToolCalls += turn.toolCallCount ?? 0;
    current.totalFilesRead += turn.filesRead.length;
    current.totalFilesModified += turn.filesModified.length;
    currentEndEpoch = turn.createdAtEpoch;

    for (const source of extractSourceTags(turn.tags)) {
      if (!current.externalInputs.includes(source)) {
        current.externalInputs.push(source);
      }
    }
  }

  if (current !== null) {
    current.durationMs = (currentEndEpoch - currentStartEpoch) * 1000;
  }

  return phases;
}

export function computeTypesDistribution(turns: TurnRecord[]): TypesDistribution {
  const words: Record<string, number> = {};
  let none = 0;

  for (const turn of turns) {
    if (!isTimelineLiveTurn(turn)) {
      continue;
    }

    if (turn.type.length === 0) {
      none += 1;
      continue;
    }
    // Every stated word counts, current vocabulary or legacy. Reading only
    // `type[0]` would make a `["refactor","fix"]` turn look like pure
    // refactoring, which is the same "pick an arbitrary primary" move the
    // multi-glyph render already refused.
    for (const word of turn.type) {
      words[word] = (words[word] ?? 0) + 1;
    }
  }

  return { words, none };
}

/**
 * Render order for the `types:` line: current vocabulary first, then the
 * legacy-only words, then one bucket for anything neither vocabulary knows,
 * then the turns that stated nothing. Fixed rather than count-sorted so the
 * line reads the same way across sessions.
 *
 * Counts are aggregated by GLYPH, not by word. The two vocabularies share
 * glyphs on purpose — `design` and `decision` are both ⚖️, `review` and
 * `change` both ✅, `fix` and `bugfix` both 🔴 — precisely so a turn's glyph
 * does not change meaning across the migration, so a reader who sees ⚖️ twice
 * on one counting line learns nothing except that the line is confusing.
 * Merging says what the glyph already claims.
 *
 * An unrecognised word is rendered under `?` rather than `typeWordGlyph`'s `•`
 * fallback, because `•` already means "stated nothing" here — two different
 * facts must not share a glyph on a line whose whole job is counting.
 */
export function renderTypesDistribution(
  distribution: TypesDistribution,
): string[] {
  const byGlyph = new Map<string, number>();
  const counted = new Set<string>();

  const accumulate = (word: string): void => {
    if (counted.has(word)) {
      return;
    }
    counted.add(word);
    const count = distribution.words[word] ?? 0;
    if (count === 0) {
      return;
    }
    const glyph = typeWordGlyph(word);
    byGlyph.set(glyph, (byGlyph.get(glyph) ?? 0) + count);
  };

  for (const word of MEMORY_TYPES) {
    accumulate(word);
  }
  for (const word of Object.keys(LEGACY_TYPE_GLYPH)) {
    accumulate(word);
  }

  const parts = [...byGlyph].map(([glyph, count]) => `${glyph}${count}`);

  let unrecognised = 0;
  for (const [word, count] of Object.entries(distribution.words)) {
    if (!counted.has(word)) {
      unrecognised += count;
    }
  }
  if (unrecognised > 0) {
    parts.push(`?${unrecognised}`);
  }
  if (distribution.none > 0) {
    parts.push(`•${distribution.none}`);
  }

  return parts;
}

export function detectBrokenPromptPairs(
  turns: TurnRecord[],
): Array<{ first: number; second: number }> {
  const pairs: Array<{ first: number; second: number }> = [];
  const liveTurns = sortTurnsForAnalysis(turns).filter(
    isTimelineLiveTurn,
  );

  for (let index = 0; index < liveTurns.length - 1; index += 1) {
    const current = liveTurns[index];
    const next = liveTurns[index + 1];
    const currentPrompt = cleanPromptForLabel(current.userPrompt);
    const nextPrompt = cleanPromptForLabel(next.userPrompt);

    if (
      currentPrompt.length < BROKEN_PROMPT_MIN_PREFIX ||
      nextPrompt.length < BROKEN_PROMPT_MIN_PREFIX
    ) {
      continue;
    }

    if (
      sharedPrefixLength(currentPrompt, nextPrompt) <
      BROKEN_PROMPT_MIN_PREFIX
    ) {
      continue;
    }

    const gapMs = (next.createdAtEpoch - current.createdAtEpoch) * 1000;
    if (gapMs >= BROKEN_PROMPT_MAX_GAP_MS) {
      continue;
    }

    pairs.push({
      first: current.promptNumber,
      second: next.promptNumber,
    });
  }

  return pairs;
}

function sharedPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;

  while (index < limit && left[index] === right[index]) {
    index += 1;
  }

  return index;
}


function parsePositiveBound(raw: string, id: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`timeline range bounds must be positive integers: ${id}`);
  }

  return value;
}

export function detectShapeSignals(turns: TurnRecord[]): ShapeSignals {
  if (turns.length === 0) {
    return {
      fastestGap: null,
      longestGap: null,
      toolBursts: [],
      toolBurstMedian: 0,
      toolBurstThreshold: 0,
      brokenPromptPairs: [],
      undoneTurns: [],
      externalInputs: [],
    };
  }

  const sortedTurns = sortTurnsForAnalysis(turns);
  const liveTurns = sortedTurns.filter(isTimelineLiveTurn);
  let fastestGap: ShapeSignals["fastestGap"] = null;
  let longestGap: ShapeSignals["longestGap"] = null;

  for (let index = 0; index < liveTurns.length - 1; index += 1) {
    const current = liveTurns[index];
    const next = liveTurns[index + 1];
    const gapMs = (next.createdAtEpoch - current.createdAtEpoch) * 1000;
    if (fastestGap === null || gapMs < fastestGap.ms) {
      fastestGap = { afterPromptNumber: current.promptNumber, ms: gapMs };
    }
    if (longestGap === null || gapMs > longestGap.ms) {
      longestGap = { afterPromptNumber: current.promptNumber, ms: gapMs };
    }
  }

  const sortedToolCounts = liveTurns
    .map((turn) => turn.toolCallCount ?? 0)
    .sort((left, right) => left - right);

  let toolBurstMedian = 0;
  if (sortedToolCounts.length > 0) {
    const middle = Math.floor(sortedToolCounts.length / 2);
    toolBurstMedian =
      sortedToolCounts.length % 2 === 1
        ? sortedToolCounts[middle]
        : Math.round(
            (sortedToolCounts[middle - 1] + sortedToolCounts[middle]) / 2,
          );
  }

  const toolBurstThreshold = toolBurstMedian * 2;
  const toolBursts = liveTurns
    .map((turn) => ({
      promptNumber: turn.promptNumber,
      toolCallCount: turn.toolCallCount ?? 0,
    }))
    .filter((turn) => turn.toolCallCount > toolBurstThreshold)
    .sort((left, right) => right.toolCallCount - left.toolCallCount)
    .slice(0, TOOL_BURST_TOP_N);

  const undoneTurns = turns
    .filter((turn) => turn.status === "undone")
    .map((turn) => turn.promptNumber);

  const externalInputs = liveTurns.flatMap((turn) =>
    extractSourceTags(turn.tags).map((source) => ({
      promptNumber: turn.promptNumber,
      source,
    })),
  );

  return {
    fastestGap,
    longestGap,
    toolBursts,
    toolBurstMedian,
    toolBurstThreshold,
    brokenPromptPairs: detectBrokenPromptPairs(turns),
    undoneTurns,
    externalInputs,
  };
}

/**
 * The one retention ordering, best first: score, then the earlier prompt
 * (spec §C tie-break). `MilestoneSelection.ranked` sorts with it and the
 * renderer's budget degrades in its reverse, so "least valuable" means
 * exactly one thing across selection and rendering — and equal-score rows keep a
 * stable order instead of drifting with page position.
 *
 * A `toolCallCount` tier used to sit between score and prompt number. Removed:
 * measured AUC 0.63 against a gold set that had been shown the tool-call count
 * when labeling, i.e. partly self-fulfilling; against a control gold blind to
 * it, AUC collapsed to 0.53 — chance. A count of tool calls measures mechanical
 * volume, not decision value, and should not steer which rows survive budget
 * degradation. Do not re-add it as an "obvious" improvement without a gold set
 * that was blind to it.
 *
 * Total order: `promptNumber` is unique per session, so once score ties the
 * prompt-number comparison is a strict, antisymmetric, transitive tiebreak —
 * the two-tier comparator never returns 0 for distinct rows and is consistent
 * across all pairs (deterministic sort, no dependence on input order).
 */
export function compareMilestoneRank(
  left: KeptMilestone,
  right: KeptMilestone,
): number {
  if (left.score !== right.score) return right.score - left.score;
  return left.turn.promptNumber - right.turn.promptNumber;
}

/**
 * Ticket 06 (view-render-repair, ruling [S15069/T1084]): a turn excluded
 * from every timeline row — not greyed, not marked, absent. Two conditions,
 * each its own column, never conflated:
 *
 *   - rewind: `turns.was_rolled_back = 1`
 *   - skip:   `turns.status = 'skipped'`
 *
 * `status = 'undone'` is a THIRD state the ruling did not name and this
 * function does not touch — it stays exactly as visible as it was.
 *
 * Every caller that builds a candidate list for the turn table, milestone
 * election, gap/shape analysis, or citation pull-through runs its input
 * through this FIRST, at selection — never at render — so an excluded turn
 * consumes no page budget, joins no milestone election, and does not
 * disturb a neighbour's gap computation.
 */
function isTimelineExcludedTurn(turn: Pick<TurnRecord, "wasRolledBack" | "status">): boolean {
  return turn.wasRolledBack || turn.status === "skipped";
}

/**
 * `↳` addresses for the milestone views (milestone-election spec, ticket 03,
 * step 5): for every id in `electedIds`, its own OUTGOING `laneEdges` whose
 * target is ALSO in `electedIds` — an unelected cited turn is omitted
 * entirely, never promoted to a row of its own (contrast the retired
 * `PulledAntecedent`, which pulled a NON-elected turn in). Self-edges are
 * excluded (a row never lists itself). Reused by both `selectMilestoneTurns`
 * (S-view) and `selectSegmentMilestonesByEdgeSignals` (E-view) so the two
 * routes' `↳` semantics cannot drift apart.
 *
 * Edge-read-surface spec, ticket 01: the citedId bucket now maps to the
 * DISTINCT relation words `laneEdges` recorded for that exact pair
 * (alphabetical — this file's own `relation ASC` convention, see
 * `db/memory-edges.ts`), not just a bare id — a pair carrying several
 * relations (a landing turn that both `extends` and `indexes` the same
 * target) renders each word once on the `↳` line
 * (`T<n>(extends,indexes)`) instead of the address alone.
 */
/** One pair's aggregated edge facts: every distinct relation word its rows carry, and whether ANY placed row among them crosses lanes (edge-atom spec, ticket 11 decision 4). */
interface ElectedCitationEntry {
  words: string[];
  crossLane: boolean;
}

function buildElectedCitations(
  laneEdges: readonly LaneEdgeInput[],
  electedIds: ReadonlySet<number>,
): Map<number, Map<number, ElectedCitationEntry>> {
  const citedByTurn = new Map<number, Map<number, { words: Set<string>; crossLane: boolean }>>();
  for (const edge of laneEdges) {
    if (edge.citingId === edge.citedId) continue;
    if (!electedIds.has(edge.citingId) || !electedIds.has(edge.citedId)) continue;
    const bucket = citedByTurn.get(edge.citingId) ?? new Map<number, { words: Set<string>; crossLane: boolean }>();
    const entry = bucket.get(edge.citedId) ?? { words: new Set<string>(), crossLane: false };
    entry.words.add(edge.relation);
    // Ticket 11 decision 4: a PAIR crosses if ANY of its placed rows does —
    // one row placed both sides differently is enough, even if the pair also
    // carries other, unplaced or same-lane, rows.
    if (edge.tailTag !== "" && edge.headTag !== "" && edge.tailTag !== edge.headTag) {
      entry.crossLane = true;
    }
    bucket.set(edge.citedId, entry);
    citedByTurn.set(edge.citingId, bucket);
  }
  const result = new Map<number, Map<number, ElectedCitationEntry>>();
  for (const [citingId, bucket] of citedByTurn) {
    const wordsByCited = new Map<number, ElectedCitationEntry>();
    for (const [citedId, entry] of bucket) {
      wordsByCited.set(citedId, { words: [...entry.words].sort(), crossLane: entry.crossLane });
    }
    result.set(citingId, wordsByCited);
  }
  return result;
}

/** `T<n>` / `S<sid>/T<n>` prefixed by its labeled arrow (edge-atom spec, ticket 11 decision 2, golden form `-indexes-> T1265`) — `formatRelationArrow`'s output (relation-tree ticket 12/13: moved to `./relation-tree`, the tree renderers' own shared producer), a space, then the address. */
function formatAntecedentAddress(address: string, words: readonly string[], crossLane: boolean): string {
  return `${formatRelationArrow(words, crossLane)} ${address}`;
}

/**
 * R1 #1 (pre-release repair): real `order`/`createdAtEpoch`/`wasRolledBack`
 * for every id `laneEdges` touches OUTSIDE `windowIds` — an EXTERNAL node an
 * OR-scoped edge reaches without being a window member itself
 * (`getRelationEdgesAmongTurns`'s own doc comment: "an override/refutes
 * writer OUTSIDE turnIds must still be able to exclude a member"). Returned
 * as `eligible: false` entries for `electMilestones`'s `turns[]` — real
 * graph metadata (so `deriveLaneInterpretation`'s reduction and the rank
 * tie-break read the external node's TRUE position instead of the `[0, id]`
 * fallback a missing entry would force) that can never itself seat (the
 * eligibility boundary, milestone-election.ts module header step 0).
 *
 * A second, separate batch fetch by id — deliberately: `laneEdges` and
 * `windowTurns`/`liveMembers` are two different query scopes (one OR-scoped
 * over edges, one the caller's own resolved membership), and no single query
 * already in this file returns both at once.
 */
function fetchExternalElectionTurns(
  db: Database,
  laneEdges: readonly LaneEdgeInput[],
  windowIds: ReadonlySet<number>,
): MilestoneTurnInput[] {
  const externalIds = new Set<number>();
  for (const edge of laneEdges) {
    if (!windowIds.has(edge.citingId)) {
      externalIds.add(edge.citingId);
    }
    if (!windowIds.has(edge.citedId)) {
      externalIds.add(edge.citedId);
    }
  }
  if (externalIds.size === 0) {
    return [];
  }
  const ids = [...externalIds];
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .query<
      {
        id: number;
        sessionId: number;
        promptNumber: number;
        createdAtEpoch: number;
        wasRolledBack: number;
      },
      number[]
    >(
      `SELECT id, session_id AS sessionId, prompt_number AS promptNumber,
              created_at_epoch AS createdAtEpoch, was_rolled_back AS wasRolledBack
       FROM turns WHERE id IN (${placeholders})`,
    )
    .all(...ids);
  // MEMBERSHIP IS A NODE FACT (lane-model-v12 ticket 10): an external node
  // participates in `deriveLaneInterpretation`'s reduction, so it must carry
  // its own lane memberships too — otherwise it silently drops out of every
  // lane it belongs to and skews that lane's membership and edge attribution.
  const laneTagsById = loadLaneTagsForTurns(db, ids);
  return rows.map((row) => ({
    id: row.id,
    type: [] as string[],
    laneTags: laneTagsById.get(row.id) ?? [],
    order: [row.sessionId, row.promptNumber] as const,
    createdAtEpoch: row.createdAtEpoch,
    wasRolledBack: row.wasRolledBack === 1,
    eligible: false,
  }));
}

/**
 * The session-view milestone selection (milestone-election spec, ticket 03).
 * Delegates the whole election to `shared/milestone-election.ts`'s
 * `electMilestones` — the always-keep/effGrade/era-gate/pull-through chain
 * this function used to run itself is retired (see
 * `tests/mcp/timeline.election-retirement.test.ts`'s grep-guards). Three
 * steps, in order:
 *
 *   ① candidacy: `windowTurns`, minus every ticket-06-excluded (rolled-back/
 *     skipped) and `compact`-typed turn — unchanged from before this ticket.
 *   ② election: `electMilestones(electionTurns, laneEdges, budget)` ranks the
 *     candidates; the top `budget` (by rank) become `kept`, re-sorted to TIME
 *     order (spec step 5) — `budget` is the caller's OWN election-budget
 *     knob (see `buildTimelineView`'s call site for how it is derived from
 *     `pageSize`), decoupled from any later PAGINATION of `kept`.
 *   ③ `↳`: `buildElectedCitations` restricted to the `kept` set — a cited
 *     turn survives on a row's `↳` line only if it ALSO made the cut.
 *
 * R1 #1/#7 (pre-release repair): `externalTurns` and `rolledBackCiterIds`
 * are the caller's own two DB-backed facts this function stays free of —
 * real `order`/`createdAtEpoch`/`wasRolledBack` for an edge endpoint outside
 * `windowTurns` (`eligible: false` graph-only entries `electMilestones`
 * folds into its reduction/degree passes but never seats), and the set of
 * window ids that cite a rolled-back turn `laneEdges` itself cannot carry.
 * Both default to empty, so a caller that predates R1 (still just
 * `windowTurns`/`laneEdges`/`budget`) gets exactly the old behavior.
 */
export function selectMilestoneTurns(view: {
  windowTurns: TurnRecord[];
  /** Tagged + untagged turn↔turn edges among (at least) `windowTurns`' own ids — `db/memory-edges.ts`'s `getRelationEdgesAmongTurns`, precomputed by the caller so this function stays a pure, DB-free selection (the same seam `citations` used to be). */
  laneEdges?: readonly LaneEdgeInput[];
  /** R1 #1: graph-only (`eligible: false`) metadata for `laneEdges` endpoints OUTSIDE `windowTurns` — see this function's own doc comment. */
  externalTurns?: readonly MilestoneTurnInput[];
  /**
   * Each window turn's LANE MEMBERSHIPS (lane-model-v12 ticket 10) —
   * `db/lane-checker-load.ts`'s `loadLaneTagsForTurns`, the third DB-backed
   * fact this pure function stays free of. A turn belongs to the lanes its
   * OWN tags name. Since lane-state-retirement ticket 01 the election reads
   * no lane structure at all (tier ② seats nobody until ticket 02), so this
   * map currently feeds nothing there; it stays on the seam because ticket 02
   * and the lane checker both address lanes by exactly this fact. Absent = no
   * lane memberships known, which is what a caller with no database gets.
   */
  laneTagsByTurnId?: ReadonlyMap<number, readonly string[]>;
  /** R1 #7: window ids that cite a rolled-back turn — `db/memory-edges.ts`'s `getRolledBackCiterIds`, fed straight through to `electMilestones`. */
  rolledBackCiterIds?: readonly number[];
}): MilestoneSelection {
  // Main-row candidates: ticket 06's exclusion (rolled-back/skipped) plus a
  // compact marker, structural noise the arc view spends no row on.
  const seq = sortTurnsForAnalysis(view.windowTurns).filter(
    (turn) => !isTimelineExcludedTurn(turn) && !turn.type.includes("compact"),
  );
  if (seq.length === 0) {
    return { kept: [], ranked: [], overflowByDay: [] };
  }

  const laneEdges = view.laneEdges ?? [];
  const electionTurns: MilestoneTurnInput[] = seq.map((turn) => ({
    id: turn.id,
    type: turn.type,
    laneTags: view.laneTagsByTurnId?.get(turn.id) ?? [],
    order: [turn.sessionId, turn.promptNumber] as const,
    createdAtEpoch: turn.createdAtEpoch,
  }));
  // Page-budget-is-the-seat-count spec, decision 1: `electMilestones`'s own
  // `budget` argument feeds ONLY its internal tier-③ two-stage-fill boundary
  // (that function's own doc comment — never a truncation of its return). It
  // is no longer derived from any caller-supplied admission number: nothing
  // here truncates `kept` any more, so there is no "admission cut" left to
  // align it with. `DEFAULT_TIMELINE_PAGE_SIZE` is a fixed internal constant
  // now, decoupled from `pageSize`/`pageBudget` — for a caller that used to
  // pass the default `pageSize` (the common case pre-ticket), this is the
  // exact same number tier ③ always saw, so its population is unchanged; only
  // a caller that used to force a SMALL election via a small `pageSize` (the
  // golden-nine fixture) sees tier ③ computed against a wider boundary than
  // its old small budget — see this ticket's own test rewrite (decision 8).
  const { candidates } = electMilestones(
    [...electionTurns, ...(view.externalTurns ?? [])],
    laneEdges,
    DEFAULT_TIMELINE_PAGE_SIZE,
    view.rolledBackCiterIds ?? [],
  );
  const windowIds = new Set(seq.map((turn) => turn.id));
  // The election's own return spans every node its `laneEdges` touched; a
  // caller-supplied `laneEdges` scoped to `windowIds` (the documented
  // contract above) never produces an out-of-window candidate, but this
  // filter is the correctness guarantee, not an optimization.
  const windowCandidates = candidates.filter((candidate) => windowIds.has(candidate.id));

  const demotedOutcomes = demotedOutcomePrompts(seq);
  const markerForSelection = (turn: TurnRecord): MilestoneMarker => {
    const marker = milestoneMarker(turn);
    return marker === "outcome" && demotedOutcomes.has(turn.promptNumber) ? null : marker;
  };

  const turnById = new Map(seq.map((turn) => [turn.id, turn] as const));
  // Decision 1: every window candidate is "elected" for citation purposes now
  // — there is no admission cut left to scope `↳` addresses to at selection
  // time. Decision 5's narrower rule (a `↳` may only reference a row that
  // actually RENDERS) is enforced downstream, at render time, once the
  // token-budget fitter has decided what survives — `MilestoneAntecedentRef`
  // carries the cited turn's own id for exactly that pass to key on.
  const electedIds = new Set(windowCandidates.map((candidate) => candidate.id));
  const citedByTurn = buildElectedCitations(laneEdges, electedIds);
  const antecedentsOf = (turnId: number): MilestoneAntecedentRef[] => {
    const bucket = citedByTurn.get(turnId);
    if (!bucket) return [];
    return [...bucket.keys()]
      .sort((a, b) => turnById.get(a)!.promptNumber - turnById.get(b)!.promptNumber)
      .map((id) => {
        const entry = bucket.get(id)!;
        return {
          turnId: id,
          address: formatAntecedentAddress(
            `T${turnById.get(id)!.promptNumber}`,
            entry.words,
            entry.crossLane,
          ),
        };
      });
  };

  const rankedRows: KeptMilestone[] = windowCandidates.map((candidate) => {
    const turn = turnById.get(candidate.id)!;
    return {
      turn,
      score: 0,
      tier: candidate.tier,
      marker: markerForSelection(turn),
      antecedents: antecedentsOf(turn.id),
    };
  });
  // Strict rank order -> strict descending score, so `compareMilestoneRank`
  // (degradation order) recovers the exact election rank with no ties.
  rankedRows.forEach((row, index) => {
    row.score = rankedRows.length - index;
  });

  // No admission cut left (decision 1): `kept` is every ranked row, re-sorted
  // to display (chronological) order — spec step 5. Membership is IDENTICAL
  // to `ranked`; only the order differs.
  const kept = [...rankedRows].sort(
    (a, b) => a.turn.promptNumber - b.turn.promptNumber,
  );

  // Always empty now (decision 1: nothing is excluded for admission reasons
  // at selection time any more) — see `MilestoneSelection.overflowByDay`'s
  // own doc comment. The render-time fitter's per-day `hiddenCount` is the
  // live overflow signal.
  const overflowByDay: OverflowHint[] = [];

  return { kept, ranked: rankedRows, overflowByDay };
}

/**
 * Parses inline DB-id causal references out of a turn's content, in order,
 * de-duplicated, capped at `cap`. These are DB turn ids (the agent's id space,
 * the same id passed to `remember()`), NOT user-facing prompt numbers — the
 * caller resolves them and maps id → prompt number for display.
 *
 * The grammar lives in db/citations.ts (`parseInlineCitations`) and is shared
 * with the structured-citation fallback, so no two consumers can disagree about
 * what a legacy turn cites. It covers the single `[T8501]` form plus the
 * comma-list, inclusive range, and annotated forms.
 *
 * The grammar itself is uncapped and `cap` is required: it is the caller's own
 * ceiling on pathological content, and there is no longer a milestone-display
 * default to inherit — the arc view takes its `↳` rows from the structured
 * pull-through set (spec §C ⑤), not from a re-parse of prose.
 */
export function parseContentReferences(
  content: string | null,
  cap: number,
): number[] {
  return parseInlineCitations(content, cap);
}

function sortTurnsForAnalysis(turns: TurnRecord[]): TurnRecord[] {
  return [...turns].sort((left, right) => {
    if (left.promptNumber !== right.promptNumber) {
      return left.promptNumber - right.promptNumber;
    }

    if (left.createdAtEpoch !== right.createdAtEpoch) {
      return left.createdAtEpoch - right.createdAtEpoch;
    }

    return left.id - right.id;
  });
}

function validateClosedRange(range: Extract<RangeSpec, { kind: "closed" }>): void {
  if (
    !Number.isInteger(range.start) ||
    !Number.isInteger(range.end) ||
    range.start < 1 ||
    range.end < 1 ||
    range.start > range.end
  ) {
    throw new Error(
      `timeline range is invalid: closed ranges require positive integers with start <= end`,
    );
  }
}

function validateOpenStartRange(
  range: Extract<RangeSpec, { kind: "openStart" }>,
): void {
  if (!Number.isInteger(range.end) || range.end < 1) {
    throw new Error(
      `timeline range is invalid: open-start ranges require a positive integer end`,
    );
  }
}

function validateOpenEndRange(range: Extract<RangeSpec, { kind: "openEnd" }>): void {
  if (!Number.isInteger(range.start) || range.start < 1) {
    throw new Error(
      `timeline range is invalid: open-end ranges require a positive integer start`,
    );
  }
}

/**
 * Derives the fork-lineage breadcrumb for a session. Returns null for root
 * sessions. Null-tolerant: if the fork turn cannot be resolved the
 * parenthetical is omitted.
 */
function deriveTimelineBreadcrumb(
  db: Database,
  session: SessionRecord,
): string | null {
  if (session.parentSessionId === null) {
    return null;
  }

  const parentRef = `S${session.parentSessionId}`;
  const firstTurn = getFirstTurn(db, session.id);
  if (firstTurn !== null && firstTurn.parentTurnId !== null) {
    const forkTurn = getTurnById(db, firstTurn.parentTurnId);
    if (forkTurn !== null) {
      return `continues from ${parentRef} (forked at T${forkTurn.promptNumber})`;
    }
  }

  return `continues from ${parentRef}`;
}

export function buildTimelineView(
  db: Database,
  input: TimelineInput,
  preloadedTurns?: TurnRecord[],
): TimelineView {
  const parsed = parseTimelineId(input.id);
  // Ticket 07: `"lane"` is a segment-scoped concept with no meaning on a
  // plain `S<n>` session id — see `narrowToBaseView`'s own doc comment.
  const viewKind = narrowToBaseView(input.view) ?? "turns";
  const session = getSession(db, parsed.sessionId);

  if (!session) {
    throw new Error(`timeline: session S${parsed.sessionId} not found`);
  }

  const allTurns = preloadedTurns ?? getTurnsForSession(db, session.id);
  const totalTurns = allTurns.length;
  const totalToolCalls = allTurns.reduce(
    (sum, turn) => sum + (turn.toolCallCount ?? 0),
    0,
  );
  const sorted = [...allTurns].sort((a, b) => a.promptNumber - b.promptNumber);
  const bounds: PromptNumberBounds = totalTurns > 0
    ? { first: sorted[0].promptNumber, last: sorted[totalTurns - 1].promptNumber }
    : { first: 1, last: 0 };
  const window = resolveWindow(parsed.range, totalTurns, bounds);
  const rangeWindowTurns = sorted.filter(
    (turn) =>
      turn.promptNumber >= window.startPromptNumber &&
      turn.promptNumber <= window.endPromptNumber,
  );
  // Ticket 04 (spec "Tools"): the shared filter grammar AND-composes with the
  // range above — same subset semantics `recall`'s `turns` id-route applies
  // to a turn (`turnMatchesFilter`, memory-filter.ts). Narrows the display
  // candidate set ONLY: the citation-resolution universe below
  // (`legacySessionTurns`, from `allTurns`) stays unfiltered, same as it
  // already ignores the range narrowing above — a filtered-out turn can still
  // be cited as an antecedent.
  const { parsed: memoryFilter, error: filterError } = parseMemoryFilter(input.filter);
  if (filterError) {
    throw new Error(filterError);
  }
  const filteredWindowTurns = hasFilterCriteria(memoryFilter)
    ? rangeWindowTurns.filter((turn) => turnMatchesFilter(turn, memoryFilter))
    : rangeWindowTurns;
  // Ticket 06 (view-render-repair, ruling [S15069/T1084]): a rolled-back or
  // skipped turn leaves the display candidate set HERE, unconditionally —
  // unlike the `filter` input above, this narrowing is NOT paired with an
  // unfiltered citation universe below; `selectMilestoneTurns` (fed
  // `legacySessionTurns`/`legacyWindowTurns`, both derived from `windowTurns`
  // or `allTurns`) and `selectSegmentMilestonesByEdgeSignals` (fed segment
  // members separately) each re-apply the same exclusion to their own wider
  // citation-resolution universe, so the turn cannot resurface as a pulled
  // antecedent either. `status = 'undone'` is untouched.
  const windowTurns = filteredWindowTurns.filter((turn) => !isTimelineExcludedTurn(turn));
  // Era split (spec D11, R2#7). The legacy selection runs over the pre-cutoff
  // turns ALONE — including the universe it resolves citations against — so no
  // era turn can be pulled into the legacy block as an antecedent and read under
  // grade semantics it was never written with. With no cutoff the two arrays are
  // the originals and nothing downstream changes.
  const eraCutoffEpoch = input.eraCutoffEpoch ?? null;
  const isEra = (turn: TurnRecord): boolean =>
    isSegmentEra(turn.createdAtEpoch, eraCutoffEpoch);
  const eraWindowTurns = eraCutoffEpoch === null ? [] : windowTurns.filter(isEra);
  const legacyWindowTurns =
    eraCutoffEpoch === null ? windowTurns : windowTurns.filter((turn) => !isEra(turn));
  const legacySessionTurns =
    eraCutoffEpoch === null ? allTurns : allTurns.filter((turn) => !isEra(turn));
  const page = Math.max(1, input.page ?? 1);
  const pageSize = Math.max(1, input.pageSize ?? DEFAULT_TIMELINE_PAGE_SIZE);
  const typesDistribution = computeTypesDistribution(allTurns);
  const windowSignals = detectShapeSignals(windowTurns);
  const compactBoundaries = [
    ...new Set(
      allTurns
        .filter((turn) => turn.type.includes("compact"))
        .map((turn) => turn.promptNumber),
    ),
  ].sort((a, b) => a - b);
  if (
    compactBoundaries.length === 0 &&
    session.lastCompactTurn !== null
  ) {
    compactBoundaries.push(session.lastCompactTurn);
  }
  const jsonlPath = resolveSessionTranscriptPath(session) ?? null;
  const tz = getSystemTimezone(session.createdAtEpoch);
  const breadcrumb = deriveTimelineBreadcrumb(db, session);
  // Page-budget-is-the-seat-count spec, decision 1/2: `pageSize` no longer
  // sizes the milestone election at all — election ranks EVERY window
  // candidate, and `page`/`pageSize` keep their meaning on the `turns` view
  // only. A render-time token budget (`RenderTimelineOptions.tokenBudget`/
  // `pageBudget`, defaulting to `DEFAULT_MILESTONE_PAGE_BUDGET`) decides how
  // many of these candidates actually render — see `renderTimeline`.
  const legacyWindowIds = new Set(legacyWindowTurns.map((turn) => turn.id));
  const laneEdges = getRelationEdgesAmongTurns(db, [...legacyWindowIds]);
  // R1 #1/#7 (pre-release repair): the two DB-backed facts `selectMilestoneTurns`
  // itself stays free of — see that function's own doc comment.
  const externalElectionTurns = fetchExternalElectionTurns(db, laneEdges, legacyWindowIds);
  const rolledBackCiterIds = getRolledBackCiterIds(db, [...legacyWindowIds]);
  const milestoneSelection = selectMilestoneTurns({
    windowTurns: legacyWindowTurns,
    laneEdges,
    externalTurns: externalElectionTurns,
    rolledBackCiterIds,
    // Ticket 10: the election's lanes come from the turns' own tags now.
    laneTagsByTurnId: loadLaneTagsForTurns(db, [...legacyWindowIds]),
  });
  // `windowTurns` is already exclusion-filtered above (ticket 06), so no
  // second skip/rewind filter is needed here — the turns view's page budget
  // is spent only on turns that still exist for the timeline.
  const pagedTurns =
    viewKind === "turns"
      ? paginateItems(windowTurns, page, pageSize)
      : emptyPaginatedItems<TurnRecord>(windowTurns.length, pageSize);
  // Page-budget-is-the-seat-count spec, decision 2: no pagination left on
  // this view — every election candidate is shown here; `renderTimeline`'s
  // token-budget fitter decides which of them survive to the output.
  const pagedMilestones: PaginatedItems<KeptMilestone> =
    viewKind === "milestones"
      ? {
          items: milestoneSelection.kept,
          total: milestoneSelection.kept.length,
          pageCount: 1,
        }
      : emptyPaginatedItems<KeptMilestone>(milestoneSelection.kept.length, pageSize);
  const milestoneDayGroups =
    viewKind === "milestones"
      ? buildMilestoneDayGroups(
          pagedMilestones.items,
          milestoneSelection.kept,
          milestoneSelection.overflowByDay,
        )
      : [];
  // The spine is the arc view's business only: the turn table is a flat
  // ledger of raw rows, so it never changes semantics at the boundary.
  const renderSegments = viewKind === "milestones" && eraCutoffEpoch !== null;
  // The era side answers to the same window the legacy body does: a range view
  // shows the chapters its turns belong to and nothing else.
  const eraWindowTurnIds = new Set(eraWindowTurns.map((turn) => turn.id));
  const segmentSpine = renderSegments
    ? listSegmentSpineForSession(db, session.id, eraCutoffEpoch, eraWindowTurnIds)
    : [];
  // Ticket 06: `listOrphanAnchorTurns`'s own SQL already drops `skipped` (and
  // `undone`), but it has no column for the DB rewind flag at all (the
  // edge-derived `isRolledBack` fact that used to sit beside it went with the
  // `supersedes` word — lane-model-v12 ticket 03 — and was never this flag
  // anyway). Cross-referenced against `allTurns` here instead of a second DB
  // round trip.
  const rolledBackTurnIds = new Set(
    allTurns.filter((turn) => turn.wasRolledBack).map((turn) => turn.id),
  );
  const orphanAnchors = renderSegments
    ? listOrphanAnchorTurns(db, session.id, eraCutoffEpoch, eraWindowTurnIds).filter(
        (row) => !rolledBackTurnIds.has(row.facts.turnId),
      )
    : [];
  // Ticket 05/12: each spine segment's NESTED milestone rows — selected
  // eagerly here (this function has `db`) via the SAME election-based
  // selection (`selectSegmentMilestonesByEdgeSignals`, milestone-election
  // spec ticket 03) the standalone `E<n>` route uses, so a given fixture selects identically
  // through either route (this ticket's own acceptance criterion) and
  // render-time stays pure. One extra read per segment in the spine; the
  // spine itself is "a few dozen" rows (segment-spine.ts), so this is not a
  // meaningfully larger query load than the spine fetch it rides beside.
  // Per-segment admission uses `DEFAULT_MILESTONE_PAGE_BUDGET` — the same
  // default the standalone route falls back to with no explicit `pageBudget`
  // (that constant's own doc comment: "one segment's SessionStart milestone
  // share" covers both this NESTED use and the standalone `E<n>` route) —
  // since `TimelineInput` carries no separate per-segment knob.
  const segmentMilestoneSelection = new Map<number, SegmentMilestoneEdgeSelection>();
  if (renderSegments) {
    for (const row of segmentSpine) {
      segmentMilestoneSelection.set(
        row.segment.id,
        selectSegmentMilestonesByEdgeSignals(
          db,
          chronologicalSegmentMembers(db, row.segment, eraCutoffEpoch),
          DEFAULT_MILESTONE_PAGE_BUDGET,
          input.taskCausalityEraCutoffEpoch,
        ),
      );
    }
  }
  const eraSegmentIdByTurnId = renderSegments
    ? getSegmentMembershipForTurns(db, eraWindowTurns.map((turn) => turn.id))
    : new Map<number, number>();
  const viewItemTotal =
    viewKind === "turns" ? pagedTurns.total : pagedMilestones.total;
  const pageCount =
    viewKind === "turns" ? pagedTurns.pageCount : pagedMilestones.pageCount;
  const pageAnchorEpoch =
    viewKind === "turns"
      ? (pagedTurns.items[0]?.createdAtEpoch ?? null)
      : (pagedMilestones.items[0]?.turn.createdAtEpoch ?? null);
  // Ticket 05: `↳` facts for the plain turns view's own rows.
  const turnRowLinks =
    viewKind === "turns"
      ? resolveTurnRowLinks(
          db,
          pagedTurns.items.map((turn) => ({ turnId: turn.id, sessionId: turn.sessionId })),
        )
      : new Map<number, TurnRowLinks>();

  return {
    view: viewKind,
    session,
    totalTurns,
    firstPromptNumber: bounds.first,
    lastPromptNumber: bounds.last,
    totalToolCalls,
    typesDistribution,
    compactBoundaries,
    window,
    windowTurns,
    pageTurns: pagedTurns.items,
    pagedMilestones: pagedMilestones.items,
    milestoneDayGroups,
    viewItemTotal,
    pageAnchorEpoch,
    page,
    pageSize,
    pageCount,
    windowSignals,
    jsonlPath,
    tz,
    // Page-budget-is-the-seat-count spec, decision 2: `milestoneTail`
    // retired along with the pagination it belonged to — every election
    // candidate is already in `pagedMilestones`, so there is no "earlier"
    // page left to point at from here (`buildContextTimelineView`'s own
    // `hasEarlier` override, for the `turns` view, is unaffected).
    hasEarlier: false,
    breadcrumb,
    eraCutoffEpoch,
    eraWindowTurns,
    segmentSpine,
    orphanAnchors,
    segmentMilestoneSelection,
    eraSegmentIdByTurnId,
    turnRowLinks,
  };
}

export function buildContextTimelineView(
  db: Database,
  sessionId: number,
  view: TimelineViewKind = "turns",
  eraCutoffEpoch: number | null = null,
): TimelineView {
  const session = getSession(db, sessionId);
  if (!session) {
    throw new Error(`timeline: session S${sessionId} not found`);
  }

  const sortedTurns = getTurnsForSession(db, sessionId).sort((a, b) => {
    if (a.promptNumber !== b.promptNumber) {
      return a.promptNumber - b.promptNumber;
    }
    if (a.createdAtEpoch !== b.createdAtEpoch) {
      return a.createdAtEpoch - b.createdAtEpoch;
    }
    return a.id - b.id;
  });

  if (sortedTurns.length === 0) {
    return buildTimelineView(db, { id: `S${sessionId}`, eraCutoffEpoch });
  }

  // Milestones: select over the full session — `page`/`pageSize` have no
  // effect on this view any more (page-budget-is-the-seat-count spec,
  // decision 2), so there is no trailing-window knob left to ask for; the
  // caller's own token budget (`RenderTimelineOptions.tokenBudget`/
  // `pageBudget`, defaulting to `DEFAULT_MILESTONE_PAGE_BUDGET`) is what
  // decides how many of the ranked candidates actually render.
  if (view === "milestones") {
    return buildTimelineView(db, {
      id: `S${sessionId}`,
      view: "milestones",
      eraCutoffEpoch,
    }, sortedTurns);
  }

  // Turns/phases: keep the recent 30-turn window (granular detail near the head).
  const windowTurns = sortedTurns.slice(-DEFAULT_TIMELINE_PAGE_SIZE);
  const firstPromptNumber = windowTurns[0]!.promptNumber;
  const lastPromptNumber = windowTurns[windowTurns.length - 1]!.promptNumber;
  const timelineView = buildTimelineView(db, {
    id: `S${sessionId}/T${firstPromptNumber}..${lastPromptNumber}`,
    pageSize: DEFAULT_TIMELINE_PAGE_SIZE,
    view,
    eraCutoffEpoch,
  }, sortedTurns);

  return {
    ...timelineView,
    hasEarlier: firstPromptNumber !== sortedTurns[0]!.promptNumber,
  };
}

function buildMilestoneDayGroups(
  pagedMilestones: KeptMilestone[],
  allMilestones: KeptMilestone[],
  overflowByDay: OverflowHint[],
): MilestoneDayGroup[] {
  if (pagedMilestones.length === 0) return [];

  const dayKey = (m: KeptMilestone) => formatLocalDate(m.turn.createdAtEpoch);

  // Full-day stats from the complete kept set.
  const fullByDay = new Map<string, KeptMilestone[]>();
  for (const m of allMilestones) {
    const key = dayKey(m);
    const bucket = fullByDay.get(key) ?? [];
    bucket.push(m);
    fullByDay.set(key, bucket);
  }
  const overflowFor = new Map(overflowByDay.map((o) => [o.date, o]));

  // Precondition: pagedMilestones is in ascending promptNumber order (a contiguous
  // slice of the prompt-sorted kept set), and prompt order tracks creation order, so
  // same-day rows are always adjacent. The "append to last group if same day" merge
  // below relies on that — a day can never appear as two non-consecutive groups.
  const groups: MilestoneDayGroup[] = [];
  for (const m of pagedMilestones) {
    const key = dayKey(m);
    let group = groups.length > 0 && groups[groups.length - 1]!.date === key
      ? groups[groups.length - 1]!
      : null;
    if (group === null) {
      const full = fullByDay.get(key) ?? [];
      const fullPrompts = full.map((x) => x.turn.promptNumber);
      group = {
        date: key,
        labelEpoch: m.turn.createdAtEpoch,
        promptLo: Math.min(...fullPrompts),
        promptHi: Math.max(...fullPrompts),
        keptCount: full.length,
        rows: [],
        continued: false,
        isFinalSliceForDay: false,
        overflow: null,
      };
      groups.push(group);
    }
    group.rows.push(m);
  }

  // A calendar day inside the page's span whose every candidate turn was hidden
  // owns no kept row, so the loop above gives it no group — and without one its
  // `+N` has nowhere to render and the turns vanish from the ledger. Materialize
  // it as a row-less group; the body model collapses it like any other zero-row
  // day. Bounded to the page's own date span on purpose: days outside it belong
  // to another page, and dumping the whole session's day inventory onto every
  // page is what `hasEarlier` already answers.
  if (groups.length > 0) {
    const spanFrom = groups[0]!.date;
    const spanTo = groups[groups.length - 1]!.date;
    const groupedDates = new Set(groups.map((group) => group.date));
    let materialized = false;
    for (const hint of overflowByDay) {
      if (groupedDates.has(hint.date) || hint.date < spanFrom || hint.date > spanTo) {
        continue;
      }
      groups.push({
        date: hint.date,
        labelEpoch: hint.labelEpoch,
        promptLo: hint.firstPrompt,
        promptHi: hint.lastPrompt,
        keptCount: 0,
        rows: [],
        continued: false,
        isFinalSliceForDay: false,
        overflow: null,
      });
      materialized = true;
    }
    if (materialized) {
      // Stable sort: the row-bearing groups are already chronological, so only
      // the materialized days move into their place in the day sequence.
      groups.sort((left, right) => left.labelEpoch - right.labelEpoch);
    }
  }

  // continued = this page-slice does not start at the day's overall-first kept milestone;
  // isFinalSliceForDay = this slice ends at the day's overall-last kept milestone.
  for (const group of groups) {
    const full = fullByDay.get(group.date) ?? [];
    const dayFirstPrompt = full[0]?.turn.promptNumber ?? -1;
    const dayLastPrompt = full[full.length - 1]?.turn.promptNumber ?? -1;
    const firstRowPrompt = group.rows[0]?.turn.promptNumber ?? -1;
    const lastRowPrompt = group.rows[group.rows.length - 1]?.turn.promptNumber ?? -1;
    group.continued = firstRowPrompt !== dayFirstPrompt;
    group.isFinalSliceForDay = lastRowPrompt === dayLastPrompt;
    if (group.isFinalSliceForDay) {
      group.overflow = overflowFor.get(group.date) ?? null;
    }
  }

  return groups;
}

function renderSessionHeader(view: TimelineView): string[] {
  const sessionStart = view.session.createdAtEpoch;
  const sessionEnd =
    view.session.updatedAtEpoch ??
    view.session.completedAtEpoch ??
    view.session.createdAtEpoch;
  const compactSuffix =
    view.compactBoundaries.length > 0
      ? `, compact at ${view.compactBoundaries.map((n) => `T${n}`).join(", ")}`
      : "";
  const typesParts = renderTypesDistribution(view.typesDistribution);
  const startDate = formatLocalDate(sessionStart);
  const endDate = formatLocalDate(sessionEnd);
  const endLabel =
    startDate === endDate
      ? formatLocalTime(sessionEnd)
      : `${endDate} ${formatLocalTime(sessionEnd)}`;

  const lines = [
    `- S${view.session.id} ${startDate} ${formatLocalTime(sessionStart)} → ${endLabel} (${formatDuration((sessionEnd - sessionStart) * 1000)}${compactSuffix})`,
    `  ${view.session.project} | ${view.totalTurns} turns | ${view.totalToolCalls} tool_calls`,
    `  types: ${typesParts.join(" ")} (session-wide)`,
    `  tz: ${view.tz.name} (${view.tz.offsetLabel})`,
    `  raw: ${view.jsonlPath ?? "(unresolved)"}`,
  ];

  const showingLine = formatShowingLine(view);
  if (showingLine) {
    lines.splice(3, 0, `  showing: ${showingLine}`);
  }

  if (view.breadcrumb !== null) {
    lines.push(`  ${view.breadcrumb}`);
  }

  return lines;
}

/**
 * Page-budget-is-the-seat-count spec, decision 2: `page`/`pageSize` have no
 * effect on the `milestones` view any more, so this "showing: page X/Y" line
 * — a pagination artifact — no longer applies there; a milestones render
 * reports its own overflow through the per-day `+N more` hints and the
 * navigation legend instead. The `turns` view keeps its pagination unchanged.
 */
function formatShowingLine(view: TimelineView): string | null {
  if (view.view !== "turns") {
    return null;
  }
  if (view.viewItemTotal === 0 || view.viewItemTotal <= view.pageSize) {
    return null;
  }

  const anchor = view.pageAnchorEpoch === null
    ? ""
    : ` · ${formatLocalDateWithWeekday(view.pageAnchorEpoch)}`;
  return `${view.view} · page ${view.page}/${view.pageCount} (${view.viewItemTotal})${anchor}`;
}

function renderTurnTable(
  view: TimelineView,
  titleCap: number,
  signal?: TruncationSignal,
): string[] {
  return renderTurnRows(view, titleCap, signal);
}

const MILESTONE_MARKER_GLYPH: Record<Exclude<MilestoneMarker, null>, string> = {
  invalidated: "🚫",
  reversed: "↩️",
  outcome: "🏁",
};

/**
 * Han-aware token-level truncation: the longest code-point prefix of `text`
 * whose rendering (plus an ellipsis) costs at most `maxTokens` under
 * `estimateDiaryTokens`. This is what makes the per-unit token cap a HARD cap —
 * `titleCap` only bounds characters, and 100 Han characters cost ~132 tokens.
 * Returns "" when not even the ellipsis fits.
 */
export function truncateToTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) {
    return "";
  }
  if (estimateDiaryTokens(text) <= maxTokens) {
    return text;
  }

  const points = [...text];
  let low = 0;
  let high = points.length;
  let best = "";
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = `${points.slice(0, mid).join("")}…`;
    if (estimateDiaryTokens(candidate) <= maxTokens) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

/**
 * Greedy soft wrap on code points, preferring a space break inside the window so
 * Latin prose does not split mid-word; a CJK run with no spaces breaks at the
 * width. Display width is approximated by code-point count.
 */
function wrapPlainText(text: string, width: number): string[] {
  const points = [...text];
  const lines: string[] = [];
  let start = 0;

  while (start < points.length) {
    if (points.length - start <= width) {
      lines.push(points.slice(start).join(""));
      break;
    }
    const hardEnd = start + width;
    let breakAt = -1;
    for (let index = hardEnd; index > start; index -= 1) {
      if (points[index] === " ") {
        breakAt = index;
        break;
      }
    }
    if (breakAt > start) {
      lines.push(points.slice(start, breakAt).join(""));
      start = breakAt + 1;
    } else {
      lines.push(points.slice(start, hardEnd).join(""));
      start = hardEnd;
    }
  }

  return lines;
}

function pathBasename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

/**
 * The `✏️` tail of a spine row: basenames of the files the turn modified, capped
 * at `MILESTONE_FILE_BASENAME_CAP` with a `+N` remainder. Basenames, not paths —
 * the row is a pointer, and the full paths are one `recall` away.
 */
function renderModifiedFilesTail(turn: TurnRecord): string {
  if (turn.filesModified.length === 0) {
    return "";
  }
  const shown = turn.filesModified
    .slice(0, MILESTONE_FILE_BASENAME_CAP)
    .map(pathBasename);
  const hidden = turn.filesModified.length - shown.length;
  return `  ✏️${shown.join(",")}${hidden > 0 ? `+${hidden}` : ""}`;
}

/**
 * The user's own words on a spine row (spec §D user story 6). A harness-injected
 * prompt — task notification, `⏺ Ran ` echo — collapses to
 * `MILESTONE_NOTIFICATION_MARKER` rather than spending row budget on envelope
 * text the user never typed. Detection is the shared
 * `isKnownSystemInjectedContent`, the same predicate prompt counting uses.
 *
 * A slash-command envelope is the one exception (spec §D): it is injected XML,
 * but `/compact` or `/review-pr` is a real user act and the reader needs to see
 * WHICH command ran. The command name is extracted with the same label cleaning
 * the turns view uses, so both surfaces agree; only an envelope with no command
 * name left in it falls through to the marker.
 */
function milestonePromptPrefix(turn: TurnRecord, signal?: TruncationSignal): string {
  const raw = turn.userPrompt;
  if (raw === null) {
    return "";
  }
  const commandName = extractCommandName(raw);
  if (commandName === null && isKnownSystemInjectedContent(raw.trimStart())) {
    return MILESTONE_NOTIFICATION_MARKER;
  }
  return truncateText(cleanPromptForLabel(raw), {
    limit: MILESTONE_PROMPT_PREFIX_CAP,
    signal,
  });
}

/**
 * The unified row's identifying text (ticket 05, spec 补充裁决 "行标签取
 * title,无题时才回退 prompt"): the stored title when there is one, else a
 * prompt-derived label, matching `milestonePromptPrefix`'s own injected-content
 * handling (a `<task-notification>`/`<cross-session-message>` envelope collapses
 * to `MILESTONE_NOTIFICATION_MARKER` rather than dumping raw harness XML; a
 * slash-command envelope keeps its command name) — the empirical basis pinning
 * this fallback (a 40-turn window where 15 prompts said nothing about what
 * happened) is exactly the noise this collapsing already guards against
 * elsewhere. Uncapped: the caller truncates against ITS OWN `titleCap`, which
 * varies per render call (recall's SessionStart injection uses a smaller one).
 */
function titleOrPromptLabel(title: string | null, rawPrompt: string | null): string {
  if (title !== null && title.trim() !== "") {
    return title;
  }
  if (rawPrompt === null) {
    return "(untitled)";
  }
  const commandName = extractCommandName(rawPrompt);
  if (commandName === null && isKnownSystemInjectedContent(rawPrompt.trimStart())) {
    return MILESTONE_NOTIFICATION_MARKER;
  }
  const prompt = cleanPromptForLabel(rawPrompt);
  return prompt === "" ? "(untitled)" : prompt;
}

/** One spine row plus its own `↳` addresses (spec step 5: budget cost attributed to the citing row) — the budget unit (spec §D). */
interface MilestoneRenderUnit {
  milestone: KeptMilestone;
  /**
   * The EFFECTIVE `↳` list for this render pass — page-budget-is-the-seat-count
   * spec, decision 5: defaults to `milestone.antecedents` (selection's full
   * set) but narrows whenever the budget fitter has already removed one of
   * the cited rows (`createMilestoneBodyModel`'s `removeUnit`), so a
   * surviving citer never renders a `↳` entry pointing at a row that is no
   * longer in the output.
   */
  antecedents: readonly MilestoneAntecedentRef[];
}

/**
 * How far one unit has been cut back. `null` on a token field means "uncut"; the
 * fields are applied in the spec's termination order by `fitUnitTrim`.
 */
interface MilestoneUnitTrim {
  showDesc: boolean;
  descTokens: number | null;
  antecedentsShown: number;
  titleTokens: number | null;
  promptTokens: number | null;
  showFiles: boolean;
}

function initialUnitTrim(unit: MilestoneRenderUnit): MilestoneUnitTrim {
  return {
    showDesc: true,
    descTokens: null,
    antecedentsShown: Math.min(unit.antecedents.length, MILESTONE_UNIT_PULLED_CAP),
    titleTokens: null,
    promptTokens: null,
    showFiles: true,
  };
}

function milestoneDescText(turn: TurnRecord): string {
  return (turn.content ?? "").replace(/\s+/g, " ").trim();
}

function renderUnitLines(
  unit: MilestoneRenderUnit,
  trim: MilestoneUnitTrim,
  titleCap: number,
  signal?: TruncationSignal,
): string[] {
  const { milestone } = unit;
  const glyph =
    milestone.marker === null ? "  " : MILESTONE_MARKER_GLYPH[milestone.marker];

  let prompt = sanitizeTimelineField(milestonePromptPrefix(milestone.turn, signal));
  if (trim.promptTokens !== null) {
    prompt = truncateToTokens(prompt, trim.promptTokens);
  }
  let title = sanitizeTimelineField(
    truncateText(milestone.turn.title ?? "(untitled)", { limit: titleCap, signal }),
  );
  if (trim.titleTokens !== null) {
    title = truncateToTokens(title, trim.titleTokens);
  }
  const filesTail = trim.showFiles ? renderModifiedFilesTail(milestone.turn) : "";

  // The sample's milestone row is the BASELINE this ladder degrades back to
  // (spec 补充裁决 2+3, slimmed by row-slimming ticket 01): `T821 08-17 ⚖️
  // title` — `MM-DD` only, one emoji (address unbracketed since ticket 11,
  // USER RULING S15069/T2016). The user's own words,
  // the `✏️` file tail and the desc block below are budget-permitting
  // ENRICHMENTS — every one of them is already a trim knob, so a unit under
  // pressure lands exactly on the baseline and never below it. No `G<n>`, no
  // tier label, no back-link: an overridden/refuted victim never reaches a
  // row at all under the election (candidacy exclusion, milestone-election
  // spec step 1), so there is no row left to hang one on.
  const markerGlyph = milestone.marker === null ? "" : `${glyph} `;
  const promptTail = prompt === "" ? "" : ` · "${prompt}"`;
  const stamp = formatLocalMonthDay(milestone.turn.createdAtEpoch);
  const lines = [
    `${TIMELINE_TURN_INDENT}${markerGlyph}T${milestone.turn.promptNumber} ${stamp} ${firstTypeEmoji(milestone.turn.type)} ${title}${promptTail}${filesTail}`.trimEnd(),
  ];

  if (trim.showDesc) {
    const raw = milestoneDescText(milestone.turn);
    const desc =
      trim.descTokens === null ? raw : truncateToTokens(raw, trim.descTokens);
    if (desc !== "") {
      for (const line of wrapPlainText(desc, MILESTONE_DESC_WRAP_CHARS)) {
        lines.push(`${MILESTONE_DESC_INDENT}${line}`);
      }
    }
  }

  // `↳` is a pure ADDRESS INDEX (spec 金样例 `↳ T811, T812`; [S15069/T876]:
  // "箭头标记是纯地址索引"), one line for the whole antecedent set rather than
  // one titled row each. `unit.antecedents` (not `milestone.antecedents`,
  // page-budget-is-the-seat-count spec decision 5) is this render pass's
  // EFFECTIVE list — already narrowed to targets that still survive the
  // token-budget fitter. Overflow past `trim.antecedentsShown` folds into a
  // trailing count, which is now the ONLY count form left on this surface.
  const shown = unit.antecedents.slice(0, trim.antecedentsShown).map((ref) => ref.address);
  const foldedAntecedents = unit.antecedents.length - trim.antecedentsShown;
  if (shown.length > 0 || foldedAntecedents > 0) {
    const addresses = [
      ...shown,
      ...(foldedAntecedents > 0 ? [`+${foldedAntecedents}`] : []),
    ];
    lines.push(`${TIMELINE_FIELD_INDENT}↳ ${addresses.join(", ")}`);
  }

  return lines;
}

function unitTokens(
  unit: MilestoneRenderUnit,
  trim: MilestoneUnitTrim,
  titleCap: number,
  signal?: TruncationSignal,
): number {
  return estimateDiaryTokens(renderUnitLines(unit, trim, titleCap, signal).join("\n"));
}

/**
 * Largest value of one trim knob that still fits `cap`, by binary search over
 * `[0, cap]`. Every knob is monotone (more tokens allowed → a longer render), so
 * the search is well defined; -1 means not even 0 fits.
 */
function largestFittingTokens(
  unit: MilestoneRenderUnit,
  trim: MilestoneUnitTrim,
  titleCap: number,
  cap: number,
  apply: (value: number) => void,
  signal?: TruncationSignal,
): number {
  let low = 0;
  let high = cap;
  let best = -1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    apply(mid);
    if (unitTokens(unit, trim, titleCap, signal) <= cap) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  apply(best < 0 ? 0 : best);
  return best;
}

/**
 * The per-unit hard cap (spec §D). The full ladder, in order:
 *
 *   ① truncate the desc (drop it outright if trimming cannot fit)
 *   ② fold `↳` addresses into a trailing `+N` until it fits
 *   ③ drop the `✏️` files tail
 *   ④ token-truncate the spine title
 *   ⑤ token-truncate the user-prompt prefix
 *   → (in `renderUnitFitted`) clamp the head line itself
 *
 * Decorative elements are sacrificed before load-bearing text, which is why ③
 * sits above the title steps: the file list is a pointer one `recall` away, its
 * basenames are uncapped in length, and a single pathological generated name can
 * outweigh everything the row is actually about. `titleCap` is a character
 * ceiling; ④-⑤ are what make the token cap a ceiling that a wall of Han
 * characters cannot breach, and the final clamp is the backstop for a row whose
 * fixed scaffolding alone would overrun.
 */
function fitUnitTrim(
  unit: MilestoneRenderUnit,
  titleCap: number,
  cap: number,
  base: MilestoneUnitTrim,
  signal?: TruncationSignal,
): MilestoneUnitTrim {
  const trim = { ...base };
  if (unitTokens(unit, trim, titleCap, signal) <= cap) {
    return trim;
  }

  // ① truncate the desc, then drop it outright if trimming it is not enough.
  if (trim.showDesc && milestoneDescText(unit.milestone.turn) !== "") {
    const best = largestFittingTokens(
      unit,
      trim,
      titleCap,
      cap,
      (value) => {
        trim.descTokens = value;
      },
      signal,
    );
    if (best <= 0) {
      trim.showDesc = false;
      trim.descTokens = null;
    } else {
      return trim;
    }
  }
  if (unitTokens(unit, trim, titleCap, signal) <= cap) {
    return trim;
  }

  // ② fold ↳ addresses into `+N` until it fits.
  while (trim.antecedentsShown > 0 && unitTokens(unit, trim, titleCap, signal) > cap) {
    trim.antecedentsShown -= 1;
  }
  if (unitTokens(unit, trim, titleCap, signal) <= cap) {
    return trim;
  }

  // ③ drop the `✏️` files tail: decoration goes before any load-bearing text is
  // cut, so a pathological basename can never cost the row its title.
  trim.showFiles = false;
  if (unitTokens(unit, trim, titleCap, signal) <= cap) {
    return trim;
  }

  // ④ token-truncate the spine title. (The old step that truncated each `↳`
  // row's TITLE is gone with the titles themselves — a `↳` line is addresses
  // now, and step ② already folds addresses into a count.)
  largestFittingTokens(
    unit,
    trim,
    titleCap,
    cap,
    (value) => {
      trim.titleTokens = value;
    },
    signal,
  );
  if (unitTokens(unit, trim, titleCap, signal) <= cap) {
    return trim;
  }
  // ⑤ token-truncate the user-prompt prefix.
  largestFittingTokens(
    unit,
    trim,
    titleCap,
    cap,
    (value) => {
      trim.promptTokens = value;
    },
    signal,
  );
  return trim;
}

function renderUnitFitted(
  unit: MilestoneRenderUnit,
  titleCap: number,
  descOff: boolean,
  signal?: TruncationSignal,
): string[] {
  const base = initialUnitTrim(unit);
  if (descOff) {
    base.showDesc = false;
  }
  const trim = fitUnitTrim(unit, titleCap, MILESTONE_UNIT_TOKEN_CAP, base, signal);
  const lines = renderUnitLines(unit, trim, titleCap, signal);
  if (estimateDiaryTokens(lines.join("\n")) <= MILESTONE_UNIT_TOKEN_CAP) {
    return lines;
  }
  // Backstop: a spine row whose scaffolding alone overruns still cannot breach
  // the hard cap — everything below the head line goes and the head is clamped.
  return [truncateToTokens(lines[0] ?? "", MILESTONE_UNIT_TOKEN_CAP)];
}

/**
 * Per-code-point token weight in QUARTERS of a token. Integers on purpose: the
 * budget fitter adds thousands of these incrementally, and integer arithmetic
 * makes the running total independent of addition order.
 *
 * Honest-token-pricing ticket (04): this scale reprices the milestones fitter
 * off the diary's conservative estimator and onto `estimateTokens` semantics
 * (`src/utils/token-estimate.ts`) — a CJK character (`CJK_CHARACTER`: Han,
 * Hiragana, Katakana, Hangul, the SAME class `estimateTokens` tests, not
 * Han-only) costs 1 token, everything else 1/4. Quarters, not the old scheme's
 * tenths: a quarter-token is the smallest unit `estimateTokens`'s own
 * 1/4-per-char rate needs to stay an integer, which is what makes
 * `tokensFromWeightQuarters` below an EXACT reconstruction of `estimateTokens`
 * rather than the old scheme's lower bound — see that function's own doc
 * comment.
 */
const CJK_WEIGHT_QUARTERS = 4;
const OTHER_WEIGHT_QUARTERS = 1;
/** One whole token, in quarters — a CJK character's own weight, and (ticket 14) a space run's flat price; both are "one token", just for different reasons, so they share the value rather than each defining their own constant. */
const QUARTERS_PER_TOKEN = CJK_WEIGHT_QUARTERS;
/**
 * One `\n` joins each body line to the rest of the output; `\n` is not a CJK
 * character. Whitespace-runs-price-as-one-token ticket 14 deliberately does
 * NOT fold this into the space-run rule below even though `\n`+indent often
 * collapses to one real BPE token too — the newline stays priced separately,
 * a touch conservative on purpose (see `estimateTokens`'s own doc comment).
 */
const NEWLINE_WEIGHT_QUARTERS = OTHER_WEIGHT_QUARTERS;
/** `estimateTokens`'s own space-run pattern — kept in lockstep so the two measures price a run identically. See that module's own doc comment for the rule and its rationale. */
const SPACE_RUN = / {2,}/g;

/**
 * Ticket 14: a maximal run of ≥2 spaces cannot be priced inside the single
 * per-code-point loop that used to be the whole of this function — pricing a
 * character needs to know whether it belongs to a run, which needs
 * lookahead the loop does not have. This restructures the cheap gate into
 * two passes instead: the per-code-point CJK/other split (unchanged), then a
 * pre-pass over `SPACE_RUN` matches that backs each run's own characters out
 * of the "other" pool and prices the run as one flat `QUARTERS_PER_TOKEN`
 * instead — the same "back it out, then re-add flat" shape
 * `estimateTokens` uses, so the two stay an EXACT match (ticket 04's
 * invariant), not merely within rounding.
 */
function textWeightQuarters(text: string): number {
  let cjkQuarters = 0;
  let otherChars = 0;
  for (const codePoint of text) {
    if (CJK_CHARACTER.test(codePoint)) {
      cjkQuarters += CJK_WEIGHT_QUARTERS;
    } else {
      otherChars += 1;
    }
  }
  let spaceRunChars = 0;
  let spaceRunTokens = 0;
  for (const run of text.match(SPACE_RUN) ?? []) {
    spaceRunChars += run.length;
    spaceRunTokens += 1;
  }
  const plainOtherChars = otherChars - spaceRunChars;
  return (
    cjkQuarters +
    plainOtherChars * OTHER_WEIGHT_QUARTERS +
    spaceRunTokens * QUARTERS_PER_TOKEN
  );
}

/**
 * `estimateTokens` reconstructed from an already-summed quarter-token weight.
 * Unlike the old tenths scheme (which reconstructed `estimateDiaryTokens`'s
 * FLOATING-POINT 1.1×/0.6× accumulation from an integer approximation, and so
 * was only ever a lower bound, at most one token under), this is an EXACT
 * match: `quarters` is always `4 × cjkCount + 1 × otherCount`, so
 * `quarters / 4 === cjkCount + otherCount / 4` bit-for-bit (dividing by 4 is
 * exact in IEEE-754 — only the exponent shifts), which is precisely the sum
 * `estimateTokens` itself ceils. The fitter still confirms every stop against
 * the real `measure` rather than trusting this alone — cheap to keep, and it
 * catches anything this reconstruction does not model (the legend, the
 * session header) — but the two no longer merely agree within rounding, they
 * agree exactly on the text this function prices.
 */
function tokensFromWeightQuarters(quarters: number): number {
  return Math.ceil(quarters / 4);
}

/**
 * The milestones fitter's own cheap per-character measure, exposed ONLY so
 * honest-token-pricing ticket 04's own test
 * (tests/mcp/timeline.honest-token-pricing.test.ts) can assert directly that
 * it agrees with `estimateTokens` — no other caller needs this; the fitter
 * itself uses `textWeightQuarters`/`tokensFromWeightQuarters` internally, and
 * every render-time consumer measures the real assembled output with
 * `estimateTokens` directly, never through this reconstruction.
 */
export function milestoneFitterTokenEstimate(text: string): number {
  return tokensFromWeightQuarters(textWeightQuarters(text));
}

/**
 * One rendered day block: an existing day group, or a synthetic day that exists
 * only to carry hidden-turn counts.
 *
 * The synthetic kind is what keeps `+N more` conservation total. A pulled
 * antecedent can live on a day that owns no main row on this page; when the
 * budget removes every citer that was hosting it, the antecedent renders
 * nowhere, and with only paged-row day groups to iterate there would be no
 * bucket left to count it in — the turn would silently vanish from the ledger.
 * (The other row-less case — a day whose every candidate turn was hidden —
 * arrives already materialized as a row-less group from
 * `buildMilestoneDayGroups`, which is where the base overflow count lives.)
 */
interface MilestoneBodySection {
  date: string;
  labelEpoch: number;
  /** null for a synthetic day: it has no rows, only a hidden count. */
  group: MilestoneDayGroup | null;
}

interface MilestoneSectionState {
  section: MilestoneBodySection;
  /** Position in `orderedStates`. A collapsed run is a contiguous index span. */
  index: number;
  /** Rows still rendered, in page order. */
  rows: KeptMilestone[];
  /** How many of this day's rows the budget dropped. */
  droppedCount: number;
  /**
   * Turns of this day that render nowhere at all: the day's base overflow, plus
   * every row the budget dropped, plus every antecedent homed here that lost all
   * its citers. `Lo`/`Hi` are that set's min and max prompt number, maintained
   * incrementally so refreshing a frame never rescans the set.
   */
  hiddenCount: number;
  hiddenLo: number;
  hiddenHi: number;
  /** Weight of the day header + `+N more` hint while the day still shows rows. */
  frameQuarters: number;
  /** Summed weight of the rendered units, in quarters. */
  unitQuarters: number;
  /** Set once the day holds no row: the collapsed run it belongs to. */
  run: CollapsedRun | null;
}

/**
 * A maximal run of consecutive zero-row days, rendered as ONE combined line
 * (spec §D: 日框架参与降级). Day frames have to be degradable for the same reason
 * units are — a month-long session pays ~2,400 tokens for 31 headers and 31
 * hints, so an un-collapsible frame would spend the whole injection budget on
 * scaffolding rather than content.
 *
 * The aggregates are maintained incrementally rather than recomputed from
 * `members`: the fitter re-prices a run on every removal step, and rebuilding
 * one per step would make the removal ladder quadratic in the day count.
 */
interface CollapsedRun {
  members: MilestoneSectionState[];
  /** Lowest- and highest-index member: the run's date-range endpoints. */
  first: MilestoneSectionState;
  last: MilestoneSectionState;
  hidden: number;
  promptLo: number;
  promptHi: number;
  quarters: number;
}

interface MilestoneUnitEntry {
  lines: string[];
  quarters: number;
}

/**
 * Mutable model of the arc body: the single place that knows how a milestones
 * page turns into lines, driven both by the plain render (no budget) and by the
 * budget fitter.
 *
 * The fitter takes thousands of degradation steps on a long session, so every
 * step is incremental: a step re-fits at most the units it actually touched,
 * updates one day's header/hint, and adds the delta into a running token weight.
 * Re-rendering and re-measuring the whole body per step is quadratic in the page
 * milestone count and was measurably slow at SessionStart.
 *
 * Antecedent homing follows the same rule as a from-scratch pass: an antecedent
 * lives under the earliest retained row that cites it. A home depends only on
 * the retained set and the retained set never depends on a home, so re-homing
 * the antecedents of the row just removed is already the fixpoint.
 */
interface MilestoneBodyModel {
  /** Strip one unit's desc block. */
  disableDesc(milestone: KeptMilestone): void;
  /** Drop one unit, re-homing only the antecedents it was hosting. */
  removeUnit(milestone: KeptMilestone): void;
  /** Body weight in quarters, including the `\n` that joins each line. */
  weightQuarters(): number;
  lines(): string[];
  /**
   * Whether any day section hides a turn count — a structural read of
   * `hiddenCount` (spec D4), never a scan of the rendered `lines()` text, so a
   * user-authored "…" in a title cannot be mistaken for one of these. Decides
   * whether the response-level legend (`appendNavigationLegend`) is worth
   * appending.
   */
  hasHiddenTurns(): boolean;
}

function createMilestoneBodyModel(
  view: TimelineView,
  titleCap: number,
  signal?: TruncationSignal,
): MilestoneBodyModel {
  const removed = new Set<KeptMilestone>();
  const descOff = new Set<KeptMilestone>();
  const unitEntries = new Map<KeptMilestone, MilestoneUnitEntry>();

  // No synthetic (row-less-but-hosting-an-antecedent) days: every `↳` address
  // (milestone-election spec, ticket 03, step 5) names an ALSO-elected turn,
  // which is either itself a main row on some day group already in
  // `view.milestoneDayGroups`, or off this page entirely — a `↳` line is
  // never the ONLY reason a day exists any more (contrast the retired
  // `PulledAntecedent`, which could).
  const sections: MilestoneBodySection[] = view.milestoneDayGroups.map((group) => ({
    date: group.date,
    labelEpoch: group.labelEpoch,
    group,
  }));

  const orderedStates: MilestoneSectionState[] = sections.map((section, index) => {
    const overflow = section.group?.overflow ?? null;
    return {
      section,
      index,
      rows: section.group === null ? [] : [...section.group.rows],
      droppedCount: 0,
      hiddenCount: overflow?.count ?? 0,
      hiddenLo: overflow?.firstPrompt ?? Number.POSITIVE_INFINITY,
      hiddenHi: overflow?.lastPrompt ?? Number.NEGATIVE_INFINITY,
      frameQuarters: 0,
      unitQuarters: 0,
      run: null,
    };
  });
  const stateOfMilestone = new Map<KeptMilestone, MilestoneSectionState>();
  for (const state of orderedStates) {
    for (const milestone of state.rows) {
      stateOfMilestone.set(milestone, state);
    }
  }

  // Page-budget-is-the-seat-count spec, decision 5: a `↳` entry may only
  // point at a row that actually renders. `liveAntecedents` is the EFFECTIVE
  // (possibly narrowed) antecedent list per milestone — defaults to the
  // selection's full `milestone.antecedents` until `removeUnit` below drops
  // one of its targets. `citersByCitedTurnId` is the reverse index that lets
  // a removal find, in O(its own citer count), every row that needs its `↳`
  // line re-priced — built once, over every row this render could show.
  const liveAntecedents = new Map<KeptMilestone, readonly MilestoneAntecedentRef[]>();
  const citersByCitedTurnId = new Map<number, KeptMilestone[]>();
  for (const milestone of stateOfMilestone.keys()) {
    liveAntecedents.set(milestone, milestone.antecedents);
    for (const ref of milestone.antecedents) {
      const bucket = citersByCitedTurnId.get(ref.turnId) ?? [];
      bucket.push(milestone);
      citersByCitedTurnId.set(ref.turnId, bucket);
    }
  }

  let totalQuarters = 0;
  let priced = false;

  function lineQuarters(line: string): number {
    return textWeightQuarters(line) + NEWLINE_WEIGHT_QUARTERS;
  }

  function unitEntryFor(milestone: KeptMilestone): MilestoneUnitEntry {
    const cached = unitEntries.get(milestone);
    if (cached !== undefined) {
      return cached;
    }
    const lines = renderUnitFitted(
      { milestone, antecedents: liveAntecedents.get(milestone) ?? milestone.antecedents },
      titleCap,
      descOff.has(milestone),
      signal,
    );
    const entry: MilestoneUnitEntry = {
      lines,
      quarters: lines.reduce((sum, line) => sum + lineQuarters(line), 0),
    };
    unitEntries.set(milestone, entry);
    return entry;
  }

  /** Re-fit one unit and fold the size change into the running totals. */
  function invalidateUnit(milestone: KeptMilestone): void {
    const previous = unitEntries.get(milestone);
    unitEntries.delete(milestone);
    const state = stateOfMilestone.get(milestone);
    if (!priced || state === undefined || removed.has(milestone)) {
      return;
    }
    const delta = unitEntryFor(milestone).quarters - (previous?.quarters ?? 0);
    state.unitQuarters += delta;
    totalQuarters += delta;
  }

  function linesQuarters(lines: string[]): number {
    return lines.reduce((sum, line) => sum + lineQuarters(line), 0);
  }

  /**
   * The pointer every hidden-turn count carries. `within` and not a dash range
   * on purpose: the hidden set is sparse, so these are its min and max, not the
   * ends of a contiguous run. The drill-down command and session id used to
   * repeat here on every occurrence (spec D4) — the session id is already in
   * the header above, the command is now said once in the response-level
   * legend (`appendNavigationLegend`), and only the count and range are a
   * per-occurrence variable worth repeating.
   */
  function hiddenHint(hidden: number, promptLo: number, promptHi: number): string {
    return `… +${hidden} more @ within T${promptLo}..T${promptHi}`;
  }

  /** The frame of a day that still shows rows: header, plus its hint if it hides anything. */
  function expandedFrameLines(state: MilestoneSectionState): string[] {
    // A row-less section never takes this path, and only a section with a group
    // can hold rows.
    const group = state.section.group!;
    const header = `── ${formatLocalDateWithWeekday(group.labelEpoch)} · T${group.promptLo}–T${
      group.promptHi
    } · ${group.keptCount - state.droppedCount} kept${
      group.continued ? " (cont.)" : ""
    } ──`;
    if (state.hiddenCount === 0) {
      return [header];
    }
    return [
      header,
      `        ${hiddenHint(state.hiddenCount, state.hiddenLo, state.hiddenHi)}`,
    ];
  }

  /**
   * The single line a whole run of consecutive zero-row days collapses to: the
   * run's date range and the summed count, with the standard hint pointer. A run
   * of one day is still one line — a header saying `0 kept` above a hint saying
   * how much is hidden is two lines making one statement.
   */
  function runLines(run: CollapsedRun): string[] {
    if (run.hidden === 0) {
      // Nothing hidden anywhere in the run: it has nothing to say.
      return [];
    }
    const from = formatLocalDateWithWeekday(run.first.section.labelEpoch);
    const to = formatLocalDateWithWeekday(run.last.section.labelEpoch);
    const span = run.first === run.last ? from : `${from}–${to}`;
    return [
      `── ${span} · 0 kept · ${hiddenHint(run.hidden, run.promptLo, run.promptHi)} ──`,
    ];
  }

  function refreshExpandedFrame(state: MilestoneSectionState): void {
    const quarters = linesQuarters(expandedFrameLines(state));
    totalQuarters += quarters - state.frameQuarters;
    state.frameQuarters = quarters;
  }

  function priceRun(run: CollapsedRun): void {
    const quarters = linesQuarters(runLines(run));
    totalQuarters += quarters - run.quarters;
    run.quarters = quarters;
  }

  /**
   * Fold a day that holds no row into the collapsed run beside it, merging the
   * runs on either side when it closes the gap between them. The surviving
   * record is the larger of the two (union by size), so re-pointing members
   * stays near-linear across a whole removal ladder.
   */
  function collapseState(state: MilestoneSectionState): void {
    totalQuarters -= state.frameQuarters;
    state.frameQuarters = 0;
    const left = state.index > 0 ? orderedStates[state.index - 1]!.run : null;
    const right =
      state.index + 1 < orderedStates.length
        ? orderedStates[state.index + 1]!.run
        : null;
    const absorbed: CollapsedRun[] = [];
    let run: CollapsedRun;
    if (left === null && right === null) {
      run = {
        members: [],
        first: state,
        last: state,
        hidden: 0,
        promptLo: Number.POSITIVE_INFINITY,
        promptHi: Number.NEGATIVE_INFINITY,
        quarters: 0,
      };
    } else if (left !== null && right !== null) {
      run = left.members.length >= right.members.length ? left : right;
      absorbed.push(run === left ? right : left);
    } else {
      run = (left ?? right)!;
    }
    run.members.push(state);
    state.run = run;
    for (const other of absorbed) {
      totalQuarters -= other.quarters;
      for (const member of other.members) {
        member.run = run;
        run.members.push(member);
      }
      run.hidden += other.hidden;
      run.promptLo = Math.min(run.promptLo, other.promptLo);
      run.promptHi = Math.max(run.promptHi, other.promptHi);
      if (other.first.index < run.first.index) {
        run.first = other.first;
      }
      if (other.last.index > run.last.index) {
        run.last = other.last;
      }
    }
    run.hidden += state.hiddenCount;
    run.promptLo = Math.min(run.promptLo, state.hiddenLo);
    run.promptHi = Math.max(run.promptHi, state.hiddenHi);
    if (state.index < run.first.index) {
      run.first = state;
    }
    if (state.index > run.last.index) {
      run.last = state;
    }
    priceRun(run);
  }

  for (const state of orderedStates) {
    state.unitQuarters = state.rows.reduce(
      (sum, milestone) => sum + unitEntryFor(milestone).quarters,
      0,
    );
    totalQuarters += state.unitQuarters;
  }
  priced = true;
  // Frames last, and in index order: `collapseState` reads its neighbours' runs,
  // so every day to its left has already settled and every day to its right is
  // still uncollapsed — each fold is a single left-append, never a merge.
  for (const state of orderedStates) {
    if (state.rows.length === 0) {
      collapseState(state);
    } else {
      refreshExpandedFrame(state);
    }
  }
  // The blank line the body opens with.
  totalQuarters += NEWLINE_WEIGHT_QUARTERS;

  return {
    disableDesc(milestone: KeptMilestone): void {
      if (descOff.has(milestone) || removed.has(milestone)) {
        return;
      }
      descOff.add(milestone);
      invalidateUnit(milestone);
    },
    removeUnit(milestone: KeptMilestone): void {
      if (removed.has(milestone)) {
        return;
      }
      const promptNumber = milestone.turn.promptNumber;
      removed.add(milestone);
      const state = stateOfMilestone.get(milestone);
      if (state !== undefined) {
        const entry = unitEntryFor(milestone);
        state.unitQuarters -= entry.quarters;
        totalQuarters -= entry.quarters;
        state.rows = state.rows.filter((row) => row !== milestone);
        state.droppedCount += 1;
        state.hiddenCount += 1;
        state.hiddenLo = Math.min(state.hiddenLo, promptNumber);
        state.hiddenHi = Math.max(state.hiddenHi, promptNumber);
        if (state.rows.length === 0) {
          collapseState(state);
        } else {
          refreshExpandedFrame(state);
        }
      }
      unitEntries.delete(milestone);

      // Decision 5: this row no longer renders, so strip it from every
      // surviving citer's `↳` line — a citer whose OWN removal is still to
      // come gets re-priced here too (harmless: it is priced again, or
      // dropped outright, when its own turn comes).
      const citers = citersByCitedTurnId.get(milestone.turn.id);
      if (citers) {
        for (const citer of citers) {
          if (removed.has(citer)) {
            continue;
          }
          const current = liveAntecedents.get(citer) ?? citer.antecedents;
          const next = current.filter((ref) => ref.turnId !== milestone.turn.id);
          if (next.length !== current.length) {
            liveAntecedents.set(citer, next);
            invalidateUnit(citer);
          }
        }
      }
    },
    weightQuarters(): number {
      return totalQuarters;
    },
    lines(): string[] {
      const out: string[] = [""];
      for (const state of orderedStates) {
        if (state.rows.length === 0) {
          // A collapsed run emits its one line at its first member, once.
          const { run } = state;
          if (run !== null && run.first === state) {
            out.push(...runLines(run));
          }
          continue;
        }
        const frame = expandedFrameLines(state);
        out.push(frame[0]!);
        for (const milestone of state.rows) {
          out.push(...unitEntryFor(milestone).lines);
        }
        if (frame[1] !== undefined) {
          out.push(frame[1]);
        }
      }
      return out;
    },
    hasHiddenTurns(): boolean {
      // Every hidden turn is recorded on SOME state's `hiddenCount` at the
      // moment it is hidden (initial overflow, a budget removal, or an
      // orphaned antecedent) — folding a state into a run only moves that
      // count onto the run, it never clears the state's own tally.
      return orderedStates.some((state) => state.hiddenCount > 0);
    },
  };
}

/** The arc body's lines plus whether any day section hides a turn count. */
interface MilestoneBodyResult {
  lines: string[];
  hiddenTurns: boolean;
}

/**
 * Score-ascending degradation order over the rows on this page: the same
 * comparator that orders `MilestoneSelection.ranked`, reversed, so the row the
 * selection ranks last is the first one a budget cuts. Ties resolve stably
 * (score → prompt number) rather than by page position.
 */
function milestoneDegradationOrder(view: TimelineView): KeptMilestone[] {
  return [...view.pagedMilestones]
    .sort(compareMilestoneRank)
    .reverse();
}

/**
 * Fits the arc body into `tokenBudget` (spec §D). Lowest-score units lose their
 * desc first; if that is not enough, whole units go, lowest election rank
 * first — every row is droppable now (milestone-election spec, ticket 03:
 * always-keep retired from the election path, so nothing is structurally
 * exempt from a `tokenBudget` any more). Day frames follow the units down: a
 * day that loses its last row collapses, and a run of consecutive collapsed
 * days costs one combined hint line rather than two lines per day. When the
 * whole selection still overruns — frames already collapsed around it — the
 * body is rendered in full with one overflow note.
 *
 * Two-tier measurement. The model's running weight prices every step in O(1)
 * and (honest-token-pricing ticket 04) now matches `estimateTokens` EXACTLY
 * on the text it prices, not merely a lower bound — see
 * `tokensFromWeightQuarters`'s own doc comment. So the cheap number gates the
 * expensive one: a step whose cheap price still overruns cannot possibly fit,
 * and the first step that might fit is confirmed with `measure`, which reports
 * the token cost of the WHOLE assembled output — header and signal blocks
 * included, which the cheap number does not price. The stopping point is
 * therefore identical to re-measuring the full output on every step, at a
 * fraction of the work.
 *
 * `measure` also takes the model's CURRENT `hasHiddenTurns()` so the
 * expensive check prices the response-level legend the way it will actually
 * be assembled (spec D4): the legend is appended outside this function's
 * returned `lines`, so a check that ignored it could accept a candidate that
 * overruns once the caller adds it. The cheap quarters pre-check stays
 * legend-blind — it only ever gates the expensive one, never substitutes for
 * it, so under-pricing there costs a few redundant steps, not correctness.
 */
function fitMilestoneBodyToBudget(
  view: TimelineView,
  titleCap: number,
  tokenBudget: number,
  fixedWeightQuarters: number,
  measure: (bodyLines: string[], hiddenTurns: boolean) => number,
  signal?: TruncationSignal,
): MilestoneBodyResult {
  // A zero-day-group view (no election candidates at all) has no body to fit
  // — `createMilestoneBodyModel`'s own `lines()` would otherwise still emit
  // the body's opening blank line for nothing.
  if (view.milestoneDayGroups.length === 0) {
    return { lines: [], hiddenTurns: false };
  }
  const body = createMilestoneBodyModel(view, titleCap, signal);
  const fits = (): boolean =>
    tokensFromWeightQuarters(fixedWeightQuarters + body.weightQuarters()) <= tokenBudget &&
    measure(body.lines(), body.hasHiddenTurns()) <= tokenBudget;
  const result = (): MilestoneBodyResult => ({
    lines: body.lines(),
    hiddenTurns: body.hasHiddenTurns(),
  });

  if (fits()) {
    return result();
  }

  for (const milestone of milestoneDegradationOrder(view)) {
    body.disableDesc(milestone);
    if (fits()) {
      return result();
    }
  }

  for (const milestone of milestoneDegradationOrder(view)) {
    body.removeUnit(milestone);
    if (fits()) {
      return result();
    }
  }

  return { lines: [...body.lines(), MILESTONE_OVER_BUDGET_NOTE], hiddenTurns: body.hasHiddenTurns() };
}
/**
 * The `[S<n>]` → `[T<n>]` → `↳` hierarchy for the DIRECT `S<n>` route, one
 * indent step shallower than the segment-nested one
 * (`TIMELINE_SESSION_INDENT`/`TIMELINE_TURN_INDENT`/`TIMELINE_FIELD_INDENT`):
 * addressed directly, a session has no `[E<n>]` ancestor above it, so its own
 * transition line sits at column 0 (spec 金样例 `[S15069] title`, not
 * `    [S15069] title`) and every rung below it shifts up by one step too.
 * The `E<n>` route's rows (and the `S<n>` arc view's era-nested rows, still
 * under a spine `[E<n>]`) keep the deeper constants — unchanged, sample 1's
 * own nesting depth.
 */
const DIRECT_TURN_INDENT = RENDER_INDENT_STEP;
const DIRECT_FIELD_INDENT = `${RENDER_INDENT_STEP}${RENDER_INDENT_STEP}`;

function renderTurnRows(
  view: TimelineView,
  titleCap: number,
  signal?: TruncationSignal,
): string[] {
  if (view.pageTurns.length === 0) {
    return [];
  }

  // The session transition line the whole page's rows hang under (spec 金样
  // 例): one session per `S<n>` view, so it is emitted once, with its title,
  // at column 0 (this route's own top-level bracket — see DIRECT_TURN_INDENT).
  const lines = ["", renderSessionTransitionLine(view.session.id, view.session.title, "")];

  let previousRenderedEpoch: number | null = null;
  for (const turn of view.pageTurns) {
    if (
      previousRenderedEpoch !== null &&
      !sameLocalDate(previousRenderedEpoch, turn.createdAtEpoch)
    ) {
      lines.push(renderDayDivider(turn.createdAtEpoch, previousRenderedEpoch));
    }

    lines.push(
      ...renderPlainTurnRowLines(turn, view.turnRowLinks.get(turn.id), titleCap, signal),
    );
    previousRenderedEpoch = turn.createdAtEpoch;
  }

  return lines;
}

function renderDayDivider(currentEpoch: number, previousRenderedEpoch: number): string {
  return `── ${formatLocalDateWithWeekday(currentEpoch)} · ${formatGap(currentEpoch, previousRenderedEpoch)} idle ──`;
}

/**
 * The turn view's identifying label, INCLUDING the compact special case (spec
 * 金样例): `titleOrPromptLabel`'s title-else-prompt-fallback for an ordinary
 * turn, or the compact marker's own token-count/trigger summary — which no
 * longer carries its own leading `⏸`, since the row's type glyph
 * (`typeEmoji`, resolving `compact` to the same glyph) already supplies it;
 * repeating it in the label would double it up.
 */
function resolveTurnRowLabel(turn: TurnRecord): string {
  if (turn.type.includes("compact")) {
    const compactMetadata = getCompactMetadata(turn.tags);
    const preTokens = formatCompactTokenCount(compactMetadata?.preTokens ?? 0);
    const trigger = compactMetadata?.trigger ?? "manual";
    return `/compact ${preTokens} tokens, ${trigger}`;
  }
  return titleOrPromptLabel(turn.title, turn.userPrompt);
}

/**
 * One row in the plain `S<n>` turns view (spec 金样例 `[T821] 08-17 18:19 ⚖️
 * title`, plus `↳ T811, T812`): the SAME row shape `renderSegmentMilestoneRow`
 * renders, over a bare `TurnRecord` instead of a `RankedSegmentMember`
 * (`links`, resolved eagerly in `buildTimelineView` via `resolveTurnRowLinks`,
 * supplies the `↳` addresses). `⨯`/strikethrough still mark an
 * undone turn (unrelated to this ticket's renderer merge, kept as-is).
 */
function renderPlainTurnRowLines(
  turn: TurnRecord,
  links: TurnRowLinks | undefined,
  titleCap: number,
  signal?: TruncationSignal,
): string[] {
  const isUndone = turn.status === "undone";
  const statusPrefix = isUndone ? "⨯ " : "";
  const glyph = typeEmoji(turn.type);
  const label = sanitizeTimelineField(
    truncateText(resolveTurnRowLabel(turn), { limit: titleCap, signal }),
  );
  const titleText = isUndone ? `~~${label}~~` : label;
  const stamp = `${formatLocalMonthDay(turn.createdAtEpoch)} ${formatLocalTime(turn.createdAtEpoch)}`;
  const address = renderTurnAddress(turn.promptNumber, turn.sessionId, false);
  const lines = [
    `${DIRECT_TURN_INDENT}${statusPrefix}${address} ${stamp} ${glyph} ${titleText}`.trimEnd(),
  ];
  const antecedents = links?.antecedents ?? [];
  if (antecedents.length > 0) {
    lines.push(`${DIRECT_FIELD_INDENT}↳ ${antecedents.join(", ")}`);
  }
  return lines;
}

function sanitizeTimelineField(value: string): string {
  return value.replaceAll("|", "/").replaceAll("→", "->");
}

// Ticket 06 (view-render-repair, ruling [S15069/T1084]): rolled-back joins
// skipped here, so a rewound turn is treated the same way for aggregate
// "liveness" purposes (the `types:` distribution, phase segmentation, gap
// detection) that skip already was. `undone` is unaffected — a different,
// pre-existing exclusion this ticket does not touch.
function isTimelineLiveTurn(turn: TurnRecord): boolean {
  return turn.status !== "undone" && !isTimelineExcludedTurn(turn);
}

function renderShapeSignals(
  view: TimelineView,
): string[] {
  const windowLabel =
    view.window.startPromptNumber === view.firstPromptNumber &&
    view.window.endPromptNumber === view.lastPromptNumber
      ? " = full session"
      : "";
  const lines = [
    "",
    `  shape signals (window T${view.window.startPromptNumber}-T${view.window.endPromptNumber}${windowLabel}):`,
  ];

  if (view.windowSignals.fastestGap !== null) {
    lines.push(
      `    - fastest gap:   after T${view.windowSignals.fastestGap.afterPromptNumber} (+${formatDuration(view.windowSignals.fastestGap.ms)})`,
    );
  }

  if (view.windowSignals.longestGap !== null) {
    lines.push(
      `    - longest gap:   after T${view.windowSignals.longestGap.afterPromptNumber} (+${formatDuration(view.windowSignals.longestGap.ms)})`,
    );
  }

  if (view.windowSignals.toolBursts.length > 0) {
    lines.push(
      `    - tool bursts:   ${view.windowSignals.toolBursts.map((burst) => `T${burst.promptNumber} 🔧${burst.toolCallCount}`).join(", ")}   [median 🔧${view.windowSignals.toolBurstMedian}, threshold >🔧${view.windowSignals.toolBurstThreshold}]`,
    );
  }

  if (view.windowSignals.brokenPromptPairs.length > 0) {
    lines.push(
      `    - broken-prompt: ${view.windowSignals.brokenPromptPairs.map((pair) => `T${pair.first}→T${pair.second}`).join(", ")}`,
    );
  }

  if (view.windowSignals.undoneTurns.length > 0) {
    lines.push(
      `    - undone turns:  ${view.windowSignals.undoneTurns.map((turn) => `T${turn}`).join(", ")}`,
    );
  }

  if (view.windowSignals.externalInputs.length > 0) {
    lines.push(
      `    - external inputs: ${view.windowSignals.externalInputs.map((input) => `T${input.promptNumber} [ext:${input.source}]`).join(", ")}`,
    );
  }

  const withinWindow = view.compactBoundaries.filter(
    (boundary) =>
      boundary >= view.window.startPromptNumber &&
      boundary <= view.window.endPromptNumber,
  );
  const outsideWindow = view.compactBoundaries.filter(
    (boundary) => !withinWindow.includes(boundary),
  );

  if (withinWindow.length > 0 || outsideWindow.length > 0) {
    lines.push(
      `    - compact boundary: ${[
        ...withinWindow.map((boundary) => `after T${boundary} (within window)`),
        ...outsideWindow.map((boundary) => `after T${boundary} (outside window)`),
      ].join("; ")}`,
    );
  }

  return lines;
}

function renderEarlierHint(
  view: TimelineView,
  options: RenderTimelineOptions = {},
): string[] {
  if (!options.showEarlierHint || !view.hasEarlier) {
    return [];
  }

  // Milestone views hide earlier *milestones*, not earlier turns: bound the hint
  // by the first shown milestone so it points at the truncated head, not the
  // (full-session) turn window start.
  const upperBound =
    view.view === "milestones" && view.pagedMilestones.length > 0
      ? view.pagedMilestones[0]!.turn.promptNumber - 1
      : view.window.startPromptNumber - 1;

  return [
    "",
    `  earlier: timeline(id="S${view.session.id}/T${view.firstPromptNumber}..${upperBound}") or recall(id="S${view.session.id}")`,
  ];
}

function renderLineagePointer(view: TimelineView): string[] {
  if (view.session.parentSessionId === null) {
    return [];
  }

  return [
    "",
    `  earlier: recall(id="S${view.session.parentSessionId}")`,
  ];
}

/**
 * Legacy-body lines with the era divider spliced in. The body model opens with a
 * blank line, so the divider goes AFTER it — the reader gets one blank, then the
 * "you are now in the old semantics" marker, then the day groups.
 */
function withLegacyEraHeader(
  view: TimelineView,
  bodyLines: string[],
  hasSpine: boolean,
): string[] {
  if (!hasSpine || bodyLines.length === 0) {
    return bodyLines;
  }
  const legacyPrompts = view.windowTurns
    .filter((turn) => !isSegmentEra(turn.createdAtEpoch, view.eraCutoffEpoch))
    .map((turn) => turn.promptNumber);
  const header = legacyEraHeader(
    legacyPrompts.length > 0 ? Math.min(...legacyPrompts) : null,
    legacyPrompts.length > 0 ? Math.max(...legacyPrompts) : null,
  );
  const [first, ...rest] = bodyLines;
  return first === "" ? ["", header, ...rest] : [header, ...bodyLines];
}

/** One admitted segment-milestone row: a member plus its 1-based event-order ordinal within the segment (a navigation handle, spec D9 — never the citation identity). */
export interface SegmentMilestoneRow {
  member: RankedSegmentMember;
  ordinal: number;
  /**
   * `↳` antecedent ADDRESSES (spec 金样例 `↳ T811(extends), T812(indexes)` —
   * edge-read-surface spec, ticket 01), resolved at selection time because
   * that is where `db` is. Session-qualified (`S15088/T21`) when the
   * antecedent lives in a DIFFERENT session from the row citing it — the
   * bare form is only unambiguous under the row's own transition line.
   */
  antecedents: string[];
  /** The owning session's title, for the transition line above the row. */
  sessionTitle: string | null;
  /**
   * Raw prompt text, for `titleOrPromptLabel`'s untitled fallback (ticket 05).
   * `RankedSegmentMember` carries no prompt column, so this rides alongside it.
   */
  userPrompt: string | null;
}

/** Max `↳` addresses on one row before the rest fold into a trailing `+N`. */
const MILESTONE_ANTECEDENT_CAP = MILESTONE_UNIT_PULLED_CAP;

/** `↳` antecedents for one turn (ticket 05). */
interface TurnRowLinks {
  antecedents: string[];
}

/**
 * `↳` addresses for a SET of turns, off the turn→turn edge table. Every
 * outgoing edge counts toward `antecedents`:
 * an antecedent is a turn this row was built on, whatever relation the writer
 * named — the arrow is an index, not a claim about the relation (spec: "箭头
 * 标记是纯地址索引"). Deduplicated by cited turn, ordered by (session, prompt)
 * so a row's antecedent list is stable across renders.
 *
 * It used to carry a second fact, the `⚑` corrector flag, read off the same
 * rows: `RANK_FACT_COLUMNS`' own outgoing-`supersedes` predicate, recomputed
 * here for the plain `S<n>` view that has no `RankedSegmentMember` to read it
 * from. Both went with the word (lane-model-v12 ticket 03 — `supersedes`
 * leaves the vocabulary and the table's CHECK, so the predicate can no longer
 * be true of any row); the `relation` column stays in the query because the
 * `↳` line names each pair's distinct relation words.
 *
 * Takes the narrow `{turnId, sessionId}` shape rather than
 * `RankedSegmentMember` itself, so a caller holding either can pass it in
 * without an adapter — a `RankedSegmentMember[]` still satisfies this
 * structurally.
 *
 * Two queries for the whole set, never one pair per row: the `S<n>` milestone
 * view resolves this for every segment on the spine, and an N+1 here is paid
 * once per rendered row on the SessionStart injection path.
 */
function resolveTurnRowLinks(
  db: Database,
  turns: readonly { turnId: number; sessionId: number }[],
): Map<number, TurnRowLinks> {
  const result = new Map<number, TurnRowLinks>();
  for (const turn of turns) {
    result.set(turn.turnId, { antecedents: [] });
  }
  if (turns.length === 0) {
    return result;
  }

  const citingIds = [...result.keys()];
  const placeholders = citingIds.map(() => "?").join(",");
  const edges = db
    .query<
      { citingId: number; citedId: number; relation: string | null; tailTag: string; headTag: string },
      number[]
    >(
      // Law 8 (indexes-rescope spec): a deleted or dormant turn is not a node,
      // so it may not appear as a `↳` antecedent either — the index row is the
      // graph's most visible face. Filtered at BOTH ends here, at the source:
      // the cited lookup below then reads only ids this filter already passed.
      `SELECT DISTINCT e.citing_id AS citingId, e.cited_id AS citedId, e.relation AS relation,
              e.tail_tag AS tailTag, e.head_tag AS headTag
         FROM memory_edges e
         JOIN turns citing ON citing.id = e.citing_id
         JOIN turns cited ON cited.id = e.cited_id
        WHERE e.citing_kind = 'turn' AND e.cited_kind = 'turn'
          AND ${liveTurnSql("citing")}
          AND ${liveTurnSql("cited")}
          AND e.citing_id IN (${placeholders})`,
    )
    .all(...citingIds);
  if (edges.length === 0) {
    return result;
  }

  const citedIds = [...new Set(edges.map((edge) => edge.citedId))];
  const citedPlaceholders = citedIds.map(() => "?").join(",");
  const citedRows = db
    .query<{ id: number; sessionId: number; promptNumber: number }, number[]>(
      `SELECT id, session_id AS sessionId, prompt_number AS promptNumber
         FROM turns WHERE id IN (${citedPlaceholders})`,
    )
    .all(...citedIds);
  const citedById = new Map(citedRows.map((row) => [row.id, row] as const));

  // Ticket 10: the aggregation is keyed on the PAIR, not the row. D2 lets one
  // pair hold several rows (one per relation), and the `↳` line is a pure
  // address index — an antecedent named twice because its citer declared both
  // `depends-on` and `encodes` about it rendered as `↳ T1 T1`, and burned two
  // of the cap's slots on one address. The relation detail is NOT dropped —
  // it is collected per pair below and named on the line.
  //
  // Edge-read-surface spec, ticket 01: each pair entry additionally collects
  // the DISTINCT relation words its rows carry (a bare, relation-NULL row
  // contributes none), so the `↳` line can name them — the labeled arrow
  // (edge-atom spec, ticket 11) when the pair has words, a bare `->` for a
  // pair whose only row is bare (nothing to name). It also tracks whether ANY
  // of the pair's rows crosses lanes (ticket 11 decision 4).
  const byCiter = new Map<
    number,
    Array<{ sessionId: number; promptNumber: number; words: Set<string>; crossLane: boolean }>
  >();
  const pairEntries = new Map<
    string,
    { sessionId: number; promptNumber: number; words: Set<string>; crossLane: boolean }
  >();
  for (const edge of edges) {
    const cited = citedById.get(edge.citedId);
    if (!cited || !result.has(edge.citingId)) {
      continue;
    }
    const pair = `${edge.citingId}>${edge.citedId}`;
    let entry = pairEntries.get(pair);
    if (!entry) {
      entry = {
        sessionId: cited.sessionId,
        promptNumber: cited.promptNumber,
        words: new Set(),
        crossLane: false,
      };
      pairEntries.set(pair, entry);
      const bucket = byCiter.get(edge.citingId) ?? [];
      bucket.push(entry);
      byCiter.set(edge.citingId, bucket);
    }
    if (edge.relation !== null) {
      entry.words.add(edge.relation);
    }
    if (edge.tailTag !== "" && edge.headTag !== "" && edge.tailTag !== edge.headTag) {
      entry.crossLane = true;
    }
  }

  for (const turn of turns) {
    const resolved = (byCiter.get(turn.turnId) ?? []).sort((left, right) =>
      left.sessionId !== right.sessionId
        ? left.sessionId - right.sessionId
        : left.promptNumber - right.promptNumber,
    );
    const shown = resolved.slice(0, MILESTONE_ANTECEDENT_CAP).map((entry) => {
      const address =
        entry.sessionId === turn.sessionId
          ? `T${entry.promptNumber}`
          : `S${entry.sessionId}/T${entry.promptNumber}`;
      return formatAntecedentAddress(address, [...entry.words].sort(), entry.crossLane);
    });
    const folded = resolved.length - shown.length;
    result.get(turn.turnId)!.antecedents = folded > 0 ? [...shown, `+${folded}`] : shown;
  }

  return result;
}

/**
 * Ticket 06 (view-render-repair, ruling [S15069/T1084]): drops a rolled-back
 * or skipped member before ordinal numbering, era eligibility or election
 * ranking ever sees it. `RankedSegmentMember.status` already carries the
 * skip half; the DB rewind flag (`turns.was_rolled_back`) does not ride on
 * the rank-facts query at all — the edge-derived `isRolledBack` fact that used
 * to sit there was a DIFFERENT thing (an inbound `supersedes` edge) and left
 * with that word (lane-model-v12 ticket 03) — so this reads the rewind column
 * in one small batched query instead of reaching into that module.
 */
function excludeTimelineHiddenMembers<T extends { turnId: number; status: string }>(
  db: Database,
  members: readonly T[],
): T[] {
  const notSkipped = members.filter((member) => member.status !== "skipped");
  if (notSkipped.length === 0) {
    return notSkipped;
  }
  const rolledBackIds = fetchRolledBackTurnIds(
    db,
    notSkipped.map((member) => member.turnId),
  );
  return rolledBackIds.size === 0
    ? notSkipped
    : notSkipped.filter((member) => !rolledBackIds.has(member.turnId));
}

function fetchRolledBackTurnIds(db: Database, turnIds: readonly number[]): Set<number> {
  if (turnIds.length === 0) {
    return new Set();
  }
  const placeholders = turnIds.map(() => "?").join(",");
  const rows = db
    .query<{ id: number }, number[]>(
      `SELECT id FROM turns WHERE id IN (${placeholders}) AND was_rolled_back = 1`,
    )
    .all(...turnIds);
  return new Set(rows.map((row) => row.id));
}

/**
 * Batch `user_prompt` fetch for `titleOrPromptLabel`'s fallback. `TurnRecord`
 * already carries this column when a caller holds one (the plain `S<n>` turns
 * view); this is for the `RankedSegmentMember`-backed paths, whose rank-facts
 * query never selected it.
 */
function fetchUserPrompts(
  db: Database,
  turnIds: readonly number[],
): Map<number, string | null> {
  const result = new Map<number, string | null>();
  if (turnIds.length === 0) {
    return result;
  }
  const placeholders = turnIds.map(() => "?").join(",");
  const rows = db
    .query<{ id: number; userPrompt: string | null }, number[]>(
      `SELECT id, user_prompt AS userPrompt FROM turns WHERE id IN (${placeholders})`,
    )
    .all(...turnIds);
  for (const row of rows) {
    result.set(row.id, row.userPrompt);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Milestone-election spec, ticket 03: the segment timeline's
// (`timeline(id="E<n>")`) own milestone admission — and the `S<n>` session
// view's own nested per-segment rows, unified onto this SAME function since
// ticket 12 (`renderEraMilestoneLines` below calls it via
// `TimelineView.segmentMilestoneSelection`, computed eagerly in
// `buildTimelineView`) — now delegates to `shared/milestone-election.ts`'s
// `electMilestones`. The OLD lexicographic edge-signal rule (`overridden`
// exclusion, `encodesCount`/`refinesExcess` ranking, `getTurnEdgeSignals`,
// the `taskCausalityEraCutoffEpoch` candidacy gate) retires — see
// `tests/mcp/timeline.election-retirement.test.ts`'s grep-guards.
//
// "Edge-free graphs degrade to flat chronological" still holds, now for the
// same structural reason `selectMilestoneTurns` documents: with zero edges
// every candidate is tier ⑤ at zero degree, so only the LATER-turn tiebreak
// (election rank) discriminates — pure recency — and the KEPT set renders in
// EVENT order regardless (ranking decides membership, never display order).
// ---------------------------------------------------------------------------

export interface SegmentMilestoneEdgeSelection {
  /** Admitted rows, in EVENT order (chronological) — ranking decides membership, never display order. */
  kept: SegmentMilestoneRow[];
  /** Non-excluded candidates the token budget could not admit. */
  demotedCount: number;
}

/**
 * Ticket 10 (the-card-is-turn-rows-and-nothing-else): the ONLY caller that
 * sets `cardMode` is `buildSplitSegmentMilestoneCard`, the injected card's
 * own composer. Every other caller — `timelineQuery`'s `E<n>` milestones
 * route, the `S<n>` spine's per-segment nesting — leaves it unset and keeps
 * measuring/reserving exactly as before this ticket (their own
 * byte-identity acceptance criterion). `cardMode` changes two things
 * together, because they have to agree: the row body `tokensFor` measures
 * (card rows carry a bare `[S<n>]` marker with NO title, not the
 * title-carrying transition line `renderSegmentMilestoneLines` inserts — see
 * `renderSegmentMilestoneCardLines`) and the fixed reserve subtracted from
 * `pageBudget` before fitting (see `CARD_POINTER_RESERVE_TOKENS` below).
 */
export interface SegmentMilestoneSelectionOptions {
  cardMode?: boolean;
}

/**
 * The segment-view milestone selection (milestone-election spec, ticket 03;
 * page-budget-is-the-seat-count spec, decision 1, retires the item-count
 * admission cap). Election ranks EVERY live member — no numeric admission cap
 * — and `pageBudget` (a TOKEN budget now, not an item count) decides how many
 * of them actually render: the election ranking's top-K prefix, K = the
 * largest that fits, cut lowest rank first (decision 3). A minimal row
 * carries no desc block to fold (unlike the S-view's `KeptMilestone` unit),
 * so this fitter has exactly one degradation step — whole rows, in rank
 * order — rather than the S-view's desc-then-unit ladder.
 *
 * `electMilestones`'s own `budget` argument (its internal tier-③
 * two-stage-fill boundary — a different question, that function's own doc
 * comment) now reads a fixed constant, `DEFAULT_TIMELINE_PAGE_SIZE`,
 * decoupled from `pageBudget` — the same choice `selectMilestoneTurns` makes
 * for the S-view sibling, and for the same reason: there is no longer an
 * "admission number" to align it with.
 */
export function selectSegmentMilestonesByEdgeSignals(
  db: Database,
  members: readonly RankedSegmentMember[],
  pageBudget: number,
  /** Retired from candidacy (era gating leaves the election path) — accepted for schema stability with callers that still set it, never read. */
  _taskCausalityEraCutoffEpoch?: number,
  options?: SegmentMilestoneSelectionOptions,
): SegmentMilestoneEdgeSelection {
  // Ticket 06 (view-render-repair, ruling [S15069/T1084]): a rolled-back or
  // skipped member is dropped before ordinal numbering or election ever sees
  // it — it admits no seat, and a live neighbour's ordinal is numbered as if
  // it were never there.
  const liveMembers = excludeTimelineHiddenMembers(db, members);
  if (liveMembers.length === 0) {
    return { kept: [], demotedCount: 0 };
  }

  const memberIds = new Set(liveMembers.map((member) => member.turnId));
  const laneEdges = getRelationEdgesAmongTurns(db, [...memberIds]);
  // Ticket 10: a member's lanes are its own tags' business, not its edges'.
  const memberLaneTags = loadLaneTagsForTurns(db, [...memberIds]);
  const electionTurns: MilestoneTurnInput[] = liveMembers.map((member) => ({
    id: member.turnId,
    type: member.type,
    laneTags: memberLaneTags.get(member.turnId) ?? [],
    order: [member.sessionId, member.promptNumber] as const,
    createdAtEpoch: member.createdAtEpoch,
  }));
  // R1 #1/#7 (pre-release repair): the same two DB-backed facts the S-view
  // call site supplies — see `fetchExternalElectionTurns`'s own doc comment.
  const externalElectionTurns = fetchExternalElectionTurns(db, laneEdges, memberIds);
  const rolledBackCiterIds = getRolledBackCiterIds(db, [...memberIds]);
  const { candidates, decisionTierShare } = electMilestones(
    [...electionTurns, ...externalElectionTurns],
    laneEdges,
    DEFAULT_TIMELINE_PAGE_SIZE,
    rolledBackCiterIds,
  );
  // Share sentinel (phase-connectivity ticket 03, decision 2): one call to
  // this function IS one segment side (old/recent split, or the plain
  // single-election views that pass their whole member list through once) —
  // `electMilestones` stays pure and never logs itself, so the WARN lives
  // here, at the DB-touching call site.
  if (decisionTierShare > DECISION_TIER_SHARE_WARN_THRESHOLD) {
    timelineLogger.warn("milestone election decision-tier candidate share exceeds guard threshold", {
      share: decisionTierShare,
      threshold: DECISION_TIER_SHARE_WARN_THRESHOLD,
      memberCount: memberIds.size,
    });
  }
  // The correctness guarantee (not an optimization) — see the identical
  // filter in `selectMilestoneTurns`.
  const windowCandidates = candidates.filter((candidate) => memberIds.has(candidate.id));

  const chronologicalOrdinals = new Map(liveMembers.map((member, index) => [member.turnId, index + 1]));
  const memberById = new Map(liveMembers.map((member) => [member.turnId, member] as const));
  const userPrompts = fetchUserPrompts(db, liveMembers.map((member) => member.turnId));
  const sessionTitles = new Map<number, string | null>();
  const sessionTitleFor = (sessionId: number): string | null => {
    if (!sessionTitles.has(sessionId)) {
      sessionTitles.set(sessionId, getSession(db, sessionId)?.title ?? null);
    }
    return sessionTitles.get(sessionId) ?? null;
  };

  // The rows a given admitted-id set would render, in EVENT (chronological)
  // display order (spec step 5) — matches this function's own `kept` doc
  // comment. Decision 5: `↳` addresses are built from `admittedIds` itself
  // (`buildElectedCitations`), so a row never cites a turn outside this SAME
  // admitted set — the surviving set, once the caller picks it below.
  function buildRows(admittedIds: ReadonlySet<number>): SegmentMilestoneRow[] {
    const keptMembers = liveMembers.filter((member) => admittedIds.has(member.turnId));
    const orderedKeptMembers = [...keptMembers].sort(
      (left, right) => chronologicalOrdinals.get(left.turnId)! - chronologicalOrdinals.get(right.turnId)!,
    );
    const citedByTurn = buildElectedCitations(laneEdges, admittedIds);
    return orderedKeptMembers.map((member) => {
      // Pre-capped at selection time (unlike the S-view's
      // `KeptMilestone.antecedents`): a segment row carries no per-unit
      // token-degradation ladder to fold further (`renderEraMilestoneLines`'s
      // own doc comment), so this is the one and only place the `+N` fold
      // happens.
      const citedBucket = citedByTurn.get(member.turnId);
      const citedIds = citedBucket
        ? [...citedBucket.keys()].sort((a, b) => {
            const memberA = memberById.get(a)!;
            const memberB = memberById.get(b)!;
            return memberA.sessionId !== memberB.sessionId
              ? memberA.sessionId - memberB.sessionId
              : memberA.promptNumber - memberB.promptNumber;
          })
        : [];
      const shown = citedIds.slice(0, MILESTONE_ANTECEDENT_CAP).map((id) => {
        const cited = memberById.get(id)!;
        const address =
          cited.sessionId === member.sessionId
            ? `T${cited.promptNumber}`
            : `S${cited.sessionId}/T${cited.promptNumber}`;
        const entry = citedBucket!.get(id)!;
        return formatAntecedentAddress(address, entry.words, entry.crossLane);
      });
      const folded = citedIds.length - shown.length;
      return {
        member,
        ordinal: chronologicalOrdinals.get(member.turnId)!,
        antecedents: folded > 0 ? [...shown, `+${folded}`] : shown,
        sessionTitle: sessionTitleFor(member.sessionId),
        userPrompt: userPrompts.get(member.turnId) ?? null,
      };
    });
  }

  // Measures the REAL assembled body the matching renderer would produce for
  // this row set — not a per-row sum. A per-row sum under-counts the
  // non-`cardMode` shape: it misses the `[S<n>]` session-transition lines
  // `renderSegmentMilestoneLines` inserts whenever the chronological row
  // sequence crosses a session boundary, which a segment spanning several
  // sessions pays for on every crossing. Measuring the whole assembled text
  // once is both more accurate and simpler. `cardMode` (ticket 10) measures
  // against `renderSegmentMilestoneCardLines` instead — a bare, title-less
  // `[S<n>]` marker at each session switch rather than a title-carrying
  // transition line — because that is the shape `buildSplitSegmentMilestoneCard`
  // actually renders; fitting against the wrong shape's cost would admit a K
  // the card's own render then overruns.
  function tokensFor(rows: readonly SegmentMilestoneRow[]): number {
    const lines = options?.cardMode
      ? renderSegmentMilestoneCardLines(rows, SEGMENT_TIMELINE_TITLE_CAP)
      : renderSegmentMilestoneLines(rows, SEGMENT_TIMELINE_TITLE_CAP);
    return estimateTokens(lines.join("\n"));
  }

  // This function measures only the ROW BODY it builds — it has neither the
  // segment's own `[E<n>] title` header line (the caller's business —
  // `renderSegmentTimeline`/`renderEraMilestoneLines`, which this row set
  // feeds) nor the trailing "+N more" pointer, and cannot know in advance
  // whether the response-level navigation legend
  // (`appendNavigationLegend`) will fire. Reserving a fixed conservative
  // buffer for all three keeps the row body itself from being cut so close
  // to `pageBudget` that adding them back overruns it — under-utilizing the
  // budget slightly (the safe direction) rather than overshooting it.
  // Sized for the WORST case, not the typical one: a `titleCap`-length
  // (`SEGMENT_TIMELINE_TITLE_CAP`, 100 chars) title in Han script, plus a
  // 6-digit segment id and a 4-digit demoted-pointer count, costs 108 honest
  // tokens (`estimateTokens`'s 1×/char weight for a CJK title, ~1/4×/char for
  // the bracket/id/pointer chrome around it — re-measured for honest-token-
  // pricing ticket 04, superseding the 150-token reserve ticket 02 sized
  // against the old 1.1×/0.6×, ×1.2 diary weights, where the same worst case
  // priced at ~155). A smaller reserve tuned to a typical mixed-script title
  // (the real E70 header prices at 23 honest tokens) would UNDER-reserve and
  // let a max-length Han title overrun `pageBudget` again, which is the one
  // thing this reserve exists to rule out. 120 leaves a 12-token margin over
  // that 108-token worst case — unlike ticket 02's own margin, this one is
  // NOT free: on the real E70 fixture the honest currency prices individual
  // rows finely enough that the reserve's exact value shifts the row count
  // by a row or two (62 rows at reserve 90, 60 at reserve 120, 58 at 150 —
  // all comfortably clearing the ≥2×-of-23 bar), so 120 is a deliberate
  // small give-back for headroom, not a free lunch.
  //
  // Ticket 10 (the-card-is-turn-rows-and-nothing-else): `cardMode` reserves
  // for a DIFFERENT, much smaller worst case — the injected card carries no
  // per-side `[E<n>] title` header (deleted by this ticket) and no Legend
  // (also deleted; decision 6: "legend reserve → 0"), so the only thing left
  // to reserve headroom for is the trailing "… +N more" pointer line
  // (`CARD_POINTER_RESERVE_TOKENS`, module-level below). Non-card callers
  // (the MCP `E<n>` milestones view, the `S<n>` spine's nested rows) are
  // UNCHANGED — they still render a header and a legend and still reserve
  // for both.
  const HEADER_AND_POINTER_RESERVE_TOKENS = options?.cardMode
    ? CARD_POINTER_RESERVE_TOKENS
    : 120;
  const legendReserveTokens = options?.cardMode
    ? 0
    : estimateTokens(`\n\n${NAVIGATION_LEGEND}`);
  const rowBudget = Math.max(
    0,
    pageBudget - HEADER_AND_POINTER_RESERVE_TOKENS - legendReserveTokens,
  );

  // Page-budget-is-the-seat-count spec, decision 3: the surviving set is the
  // election ranking's top-K prefix, K = the max that fits `rowBudget`
  // tokens. Cost is USUALLY monotone in K — admitting one more candidate
  // usually only adds lines (its own row, plus any `↳` reference it newly
  // satisfies on an already-admitted row) — but NOT ALWAYS: a row's `↳`
  // antecedents are sorted by `(sessionId, promptNumber)` and then capped at
  // `MILESTONE_ANTECEDENT_CAP`, so admitting a new candidate can insert a
  // SHORT same-session address (`T<n>`) into an already-capped bucket and
  // displace a LONGER cross-session address (`S<n>/T<n>`) out into the `+N`
  // fold, while the fold counter's own digit width stays the same — making an
  // already-admitted row SHORTER as K grows (ticket 07, "the fitter stops
  // claiming a monotonicity it does not have"). A binary search over a
  // non-monotone predicate can settle on a K smaller than the true maximum
  // the budget affords, overstating `demotedCount` to match.
  //
  // The binary search is kept anyway, on measured evidence: a differential
  // run replacing it with an exhaustive scan over every K produced
  // BYTE-IDENTICAL output across all 70 live segments × 6 budgets
  // (2000/1500/1000/700/500/300) = 420 renders — no divergence anywhere in
  // the production corpus — while the exhaustive scan cost 638.8 ms per E70
  // card render against the binary search's 14.5 ms (44× slower), multiplied
  // by up to three attached segments and the demote ladder's re-renders.
  // Exactness is not worth buying at that price.
  //
  // What IS bought cheaply: once the binary search settles on `bestK`, a
  // bounded FORWARD PROBE (below) tries the next few K values and adopts the
  // LARGEST that still fits — never one that doesn't (under-filling stays the
  // safe direction; the probe uses the exact same `tokensFor(rows) <=
  // rowBudget` test the search does, so it can only recover seats, never
  // overshoot). This covers the realistic single-displacement case — the
  // only shape anyone has been able to construct — for the cost of a handful
  // of extra `buildRows` calls.
  let lo = 0;
  let hi = windowCandidates.length;
  let bestK = 0;
  let bestRows: SegmentMilestoneRow[] = [];
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const admittedIds = new Set(windowCandidates.slice(0, mid).map((candidate) => candidate.id));
    const rows = buildRows(admittedIds);
    if (tokensFor(rows) <= rowBudget) {
      bestK = mid;
      bestRows = rows;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  // A small fixed window, not a rescan: a single displacement event (one
  // candidate admitted, one bucket losing one entry to the fold) is the only
  // realistic case, so checking a couple of K's past `bestK` already covers
  // it with margin; 3 keeps the added cost at "a handful" of `buildRows`
  // calls regardless of window size. Deliberately does not `break` on the
  // first K that fails to fit — cost can dip again a few steps further out
  // (ticket 07 criterion 2's own fixture: bestK+1 fails, bestK+2 fits), so
  // every probed K is tried independently and the largest FITTING one wins.
  const MILESTONE_FITTER_FORWARD_PROBE_WINDOW = 3;
  const probeCeiling = Math.min(windowCandidates.length, bestK + MILESTONE_FITTER_FORWARD_PROBE_WINDOW);
  for (let probeK = bestK + 1; probeK <= probeCeiling; probeK += 1) {
    const admittedIds = new Set(windowCandidates.slice(0, probeK).map((candidate) => candidate.id));
    const rows = buildRows(admittedIds);
    if (tokensFor(rows) <= rowBudget) {
      bestK = probeK;
      bestRows = rows;
    }
  }

  return { kept: bestRows, demotedCount: windowCandidates.length - bestK };
}

/**
 * The milestone row (spec 金样例, slimmed by row-slimming ticket 01): `T821
 * 08-17 ⚖️ title` — the SESSION-PROMPT address, unbracketed since ticket 11
 * (USER RULING S15069/T2016) — not the segment
 * ordinal: `S<n>/T<m>` is the only citation form, and the transition line
 * above supplies the `S` half), a per-row date (`MM-DD`, no time-of-day — the
 * day frame already carries that context and the row stays self-describing
 * without one), ONE type glyph (the first stored type's — decision 3; the
 * whole-list cluster is what `turns`-view rows and lane headers still show),
 * the title. No prompt excerpt, no `G` value, no tier label, and — since
 * lane-model-v12 ticket 03 — no flag either: the `⚑` corrector marker read an
 * outgoing `supersedes` edge, and that word no longer exists in the
 * vocabulary or in the table's CHECK, so the marker could only ever be
 * absent. It is deleted rather than re-pointed at `override`, which would
 * flag rows nobody measured as corrections (see `db/segment-rank.ts`'s
 * header).
 *
 * Ticket 10 (the-card-is-turn-rows-and-nothing-else) considered, then
 * rejected on cost, qualifying this address per row (`S<n>/T<m>`) for the
 * injected card — user ruling [S15069/T1910] measured the two forms side by
 * side and kept the cheaper one: a bare `S<n>` marker line at each session
 * switch instead (`renderSegmentMilestoneCardLines` below), so this
 * function's own row shape is UNCHANGED, minus the brackets ticket 11 later
 * dropped, for every caller including the card.
 */
function renderSegmentMilestoneRow(
  row: SegmentMilestoneRow,
  titleCap: number,
  includeSessionPrefix: boolean,
  signal?: TruncationSignal,
): string {
  const { member } = row;
  const glyph = firstTypeEmoji(member.type);
  const title = sanitizeTimelineField(
    truncateText(titleOrPromptLabel(member.title, row.userPrompt), { limit: titleCap, signal }),
  );
  const stamp = formatLocalMonthDay(member.createdAtEpoch);
  const address = renderTurnAddress(member.promptNumber, member.sessionId, includeSessionPrefix);
  return `${TIMELINE_TURN_INDENT}${address} ${stamp} ${glyph} ${title}`.trimEnd();
}

/**
 * Ticket 13 decision 5: the node selector's own header row — `S<n>/T<m>
 * MM-DD <emoji> <title>`, the SAME milestone-row shape
 * `renderSegmentMilestoneRow` renders (unbracketed address since ticket 11,
 * `MM-DD` only, one type glyph, the title), but over a bare `TurnRecord` and
 * ALWAYS the full `S<n>/T<m>` address (this route has no segment/session
 * context to fall back to bare `T<m>` the way the milestone card's rows do).
 * Built from `renderTurnAddress` (format.ts) rather than a second hand-rolled
 * copy of the address form, so the two shapes cannot drift apart again.
 */
function renderTurnNodeHeaderLine(turn: TurnRecord, signal?: TruncationSignal): string {
  const glyph = firstTypeEmoji(turn.type);
  const title = sanitizeTimelineField(
    truncateText(titleOrPromptLabel(turn.title, turn.userPrompt), { limit: DEFAULT_TITLE_CAP, signal }),
  );
  const stamp = formatLocalMonthDay(turn.createdAtEpoch);
  const address = renderTurnAddress(turn.promptNumber, turn.sessionId, true);
  return `${address} ${stamp} ${glyph} ${title}`;
}

/** One milestone row plus its `↳` antecedent line, if it has any (spec 金样例). Shared by every caller that renders a single unit — the milestone body loop below and the `E<n>` turns view's per-item token-cost estimator alike. */
function renderSegmentMilestoneUnitLines(
  row: SegmentMilestoneRow,
  titleCap: number,
  signal?: TruncationSignal,
): string[] {
  const lines = [renderSegmentMilestoneRow(row, titleCap, false, signal)];
  if (row.antecedents.length > 0) {
    lines.push(`${TIMELINE_FIELD_INDENT}↳ ${row.antecedents.join(", ")}`);
  }
  return lines;
}

/**
 * A run of milestone rows in the one hierarchy: a `[S<n>]` transition line
 * whenever the run changes session (title on the session's first appearance
 * only), the rows, and each row's `↳` address line beneath it.
 */
function renderSegmentMilestoneLines(
  rows: readonly SegmentMilestoneRow[],
  titleCap: number,
  signal?: TruncationSignal,
): string[] {
  const lines: string[] = [];
  const seenSessionIds = new Set<number>();
  let runSessionId: number | null = null;

  for (const row of rows) {
    const sessionId = row.member.sessionId;
    if (sessionId !== runSessionId) {
      lines.push(
        renderSessionTransitionLine(
          sessionId,
          seenSessionIds.has(sessionId) ? null : row.sessionTitle,
          TIMELINE_SESSION_INDENT,
        ),
      );
      seenSessionIds.add(sessionId);
      runSessionId = sessionId;
    }
    lines.push(...renderSegmentMilestoneUnitLines(row, titleCap, signal));
  }

  return lines;
}

/**
 * Ticket 10 (the-card-is-turn-rows-and-nothing-else), decision 3 as AMENDED
 * by user ruling [S15069/T1910]: the injected card's own row body — bare
 * `[T<m>]` rows (unchanged from `renderSegmentMilestoneUnitLines`'s default
 * shape), each run of consecutive same-session rows opened by a bare
 * `[S<n>]` marker — address only, no title, ever (not even on a session's
 * first appearance — `renderSegmentMilestoneLines`'s `seenSessionIds`
 * first-appearance-gets-a-title carve-out is deliberately NOT reused here).
 * A marker is re-emitted at every session switch, including a switch back to
 * a session already seen earlier in the list (an interleaved OLD/RECENT
 * concatenation can revisit a session id), so the loop below tracks only the
 * IMMEDIATELY PRECEDING row's session, never a seen-before set. Citing a row
 * means joining the nearest marker above with the row (decision 3:
 * `[S15069]` + `[T1898]` -> `S15069/T1898`) — the full per-row qualification
 * this ticket originally shipped (`[S<n>/T<m>]` on every row) was offered
 * alongside this shape and declined on cost ([S15069/T1909]: ~2 tok per
 * switch here vs ~1.75 tok per row there, and a card has far fewer switches
 * than rows). `↳` sub-rows are untouched (decision 4): bare `T<m>` reads
 * against the marker's session, cross-session cites are already qualified.
 */
function renderSegmentMilestoneCardLines(
  rows: readonly SegmentMilestoneRow[],
  titleCap: number,
  signal?: TruncationSignal,
): string[] {
  const lines: string[] = [];
  let runSessionId: number | null = null;
  for (const row of rows) {
    const sessionId = row.member.sessionId;
    if (sessionId !== runSessionId) {
      lines.push(renderSessionTransitionLine(sessionId, null, TIMELINE_SESSION_INDENT));
      runSessionId = sessionId;
    }
    lines.push(...renderSegmentMilestoneUnitLines(row, titleCap, signal));
  }
  return lines;
}

/** The overflow pointer (spec's own phrase: "the overflow pointer stays"). `null` when nothing was demoted. */
function renderMilestoneDemotedPointer(demotedCount: number): string | null {
  if (demotedCount <= 0) {
    return null;
  }
  return `${TIMELINE_TURN_INDENT}… +${demotedCount} more`;
}

/**
 * Milestone rows nested beneath each segment line in the S<n> era spine (spec
 * "Session (S) views: same minimal milestone row, same per-view overflow") —
 * one call per segment, from its own pre-computed
 * `TimelineView.segmentMilestoneSelection` (selected EAGERLY in
 * `buildTimelineView` via `selectSegmentMilestonesByEdgeSignals`, the SAME
 * election and the SAME minimal row a standalone `E<n>` milestone view
 * renders — a segment's nested content is byte-identical to what addressing
 * it directly with the same `pageSize` would show). This function is now
 * purely a renderer: no admission decision happens here any more, matching
 * every other render step's "pure function of `TimelineView`" discipline.
 *
 * Replaces the pre-ticket-05 effGrade/day-budget nested renderer, and then
 * ticket-05's own state-citation/token-budget rule in turn: a minimal row
 * carries no desc block and no ↳ antecedents to fold, so the old two-phase
 * degradation ladder (fold desc, then drop whole units) has nothing left to
 * do — each segment is already bounded at selection time, and the surviving
 * outer-budget mechanism (`shedSpineToBudget`, unchanged) sheds whole
 * segment/orphan LINES when even that is not enough.
 */
function renderEraMilestoneLines(
  view: TimelineView,
  titleCap: number,
  signal?: TruncationSignal,
): Map<number, readonly string[]> {
  const bySegment = new Map<number, string[]>();
  for (const [segmentId, selection] of view.segmentMilestoneSelection) {
    const lines = renderSegmentMilestoneLines(selection.kept, titleCap, signal);
    const pointer = renderMilestoneDemotedPointer(selection.demotedCount);
    if (pointer !== null) {
      lines.push(pointer);
      // A demoted row is information loss exactly like a folded day group or a
      // truncated field (spec D1/D4) — the navigation legend has to know.
      if (signal) {
        signal.truncated = true;
      }
    }
    if (lines.length > 0) {
      bySegment.set(segmentId, lines);
    }
  }
  return bySegment;
}

export function renderTimeline(
  view: TimelineView,
  options: RenderTimelineOptions = {},
): string {
  const titleCap = options.titleCap ?? DEFAULT_TITLE_CAP;
  // One flag for the whole response (spec D1): every `truncateText` call this
  // render makes — turn table, phase list, or milestone body — reports into
  // it, so the day-fold `hiddenTurns` signal is no longer the only thing that
  // can trigger the navigation legend.
  const signal = createTruncationSignal();
  // Segment-nested milestone rows (ticket 05/12): already selected and
  // bounded (election ranking, `pageSize`-capped) in `buildTimelineView`,
  // so this is already the fully-fitted render — no further degradation pass
  // needed here for these NESTED rows specifically (`options.pageBudget`
  // governs the spine's own LINE count instead — see its doc comment and the
  // milestones branch below). Empty whenever there is no era cutoff or no
  // admitted era row, which is what keeps a session with no segmented era
  // turns byte-identical to the pre-nesting renderer (spec D6/D9).
  const eraMilestoneLines: ReadonlyMap<number, readonly string[]> =
    view.view === "milestones"
      ? renderEraMilestoneLines(view, titleCap, signal)
      : new Map();
  // Spine lines are recomputed whenever the outer token budget sheds a whole
  // segment/orphan line; everything else in `assemble` is fixed.
  let spineLines =
    view.view === "milestones"
      ? renderSegmentSpineBlock({
          spine: view.segmentSpine,
          orphans: view.orphanAnchors,
          titleCap,
          milestoneLinesBySegmentId: eraMilestoneLines,
        })
      : [];
  const assemble = (bodyLines: string[], spineOverride: string[] = spineLines): string =>
    [
      ...renderSessionHeader(view),
      ...spineOverride,
      ...withLegacyEraHeader(view, bodyLines, spineOverride.length > 0),
      ...renderShapeSignals(view),
      ...renderEarlierHint(view, options),
      ...renderLineagePointer(view),
    ].join("\n");

  if (view.view !== "milestones") {
    return appendNavigationLegend(
      assemble(renderTurnTable(view, titleCap, signal)),
      { truncated: signal.truncated },
    );
  }

  // Milestones (page-budget-is-the-seat-count spec, decision 1). Selection no
  // longer admits by count — `view.pagedMilestones` carries EVERY election
  // candidate — so every milestones render is now budget-bounded, with no
  // separate "unbudgeted" path left: a budget is measured against the WHOLE
  // assembled output (header and signal blocks count against it too), and
  // when the content already fits, the fitter below returns it unchanged —
  // identical to the old no-budget render, just no longer a separate code
  // path. `options.tokenBudget` (the SessionStart injection's own
  // internal-only knob) takes precedence when set; every other caller —
  // every MCP `timeline()` call — falls back to `options.pageBudget`
  // (`TimelineInput.pageBudget`), and that in turn to
  // `DEFAULT_MILESTONE_PAGE_BUDGET`. The SAME effective budget bounds the era
  // SPINE too (`shedSpineToBudget`, sheds whole segment/orphan lines —
  // `view.segmentSpine`/`view.orphanAnchors` carry a session's WHOLE era
  // history with no count cap of their own,
  // `listSegmentSpineForSession`/`listOrphanAnchorTurns`, db/segment-rank.ts).
  const effectiveBudget =
    options.tokenBudget ?? options.pageBudget ?? DEFAULT_MILESTONE_PAGE_BUDGET;

  // The spine is the era's default view, so it is served first. Ticket 05:
  // each segment's nested milestone content is already self-bounded (now to
  // `DEFAULT_MILESTONE_PAGE_BUDGET` tokens, page-budget-is-the-seat-count
  // spec) above, so there is no row-level degradation left to run here — the
  // only thing the outer budget can still do is shed whole segment/orphan
  // LINES, which `shedSpineToBudget` already does (sheds orphans first — the
  // safety net, not the structure — then the oldest segments).
  if (spineLines.length > 0) {
    shedSpineToBudget({
      view,
      titleCap,
      tokenBudget: effectiveBudget,
      apply: (candidate) => {
        spineLines = candidate;
      },
      measure: () => estimateTokens(assemble([])),
      milestoneLinesBySegmentId: eraMilestoneLines,
    });
  }

  // The response-level legend (spec D4, `appendNavigationLegend`) is appended
  // to `assemble`'s result rather than folded inside it: whether it is needed
  // is a fact about the body (did folding a day group hide a turn, OR did any
  // field truncate), so `assemble` stays a pure function of `bodyLines` and the
  // legend is layered on top here, where the fitter's `measure` folds it into
  // the expensive check (not the cheap quarters pre-check) so the candidate it
  // settles on is the one whose ASSEMBLED-PLUS-LEGEND size is what actually
  // respects the budget.
  const body = fitMilestoneBodyToBudget(
    view,
    titleCap,
    effectiveBudget,
    textWeightQuarters(assemble([])),
    (bodyLines, hiddenTurns) =>
      estimateTokens(
        appendNavigationLegend(assemble(bodyLines), {
          truncated: hiddenTurns || signal.truncated,
        }),
      ),
    signal,
  );
  return appendNavigationLegend(assemble(body.lines), {
    truncated: body.hiddenTurns || signal.truncated,
  });
}

interface ShedSpineOptions {
  view: TimelineView;
  titleCap: number;
  tokenBudget: number;
  /** Install a candidate so the caller's `measure` prices it. */
  apply: (lines: string[]) => void;
  /** Token cost of the whole assembled output with an EMPTY legacy body. */
  measure: () => number;
  /**
   * The already self-bounded (ticket 05) nested milestone rows per segment.
   * Carried through so a segment that survives this shedding still shows its
   * own rows, instead of losing them just because this re-renders the block.
   */
  milestoneLinesBySegmentId?: ReadonlyMap<number, readonly string[]>;
}

/**
 * Sheds spine rows until the header + spine alone fit the budget: orphan
 * anchors first (they are the safety net, not the structure), then the oldest
 * segments — the recent arc is what a resumed session needs restored. Each
 * candidate is installed through `apply` before `measure` prices it, so the
 * measurement is always of the output that would actually be emitted.
 */
function shedSpineToBudget(options: ShedSpineOptions): void {
  const { view, titleCap, tokenBudget, apply, measure, milestoneLinesBySegmentId } = options;
  let segments = view.segmentSpine.length;
  let orphans = view.orphanAnchors.length;

  while (measure() > tokenBudget && (orphans > 0 || segments > 0)) {
    if (orphans > 0) {
      orphans -= 1;
    } else {
      segments -= 1;
    }
    apply(
      renderSegmentSpineBlock({
        spine: view.segmentSpine,
        orphans: view.orphanAnchors,
        titleCap,
        maxSegments: segments,
        maxOrphans: orphans,
        milestoneLinesBySegmentId,
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// `E<n>` addressing (ticket 05, spec "Tools"/ADR-0006): `timeline` addressing
// a segment directly, symmetric with `recall(id="E<n>")` — same two view
// contracts as the `S<n>` route (milestones: lossy skeleton, demote-only;
// turns: lossless ledger, paginate-only), scoped to one segment's own
// chronological membership instead of one session's window. No range/wildcard
// route (unlike `S<n>`/recall's bare `E`): the segment id IS the scope.
// ---------------------------------------------------------------------------

export interface ParsedSegmentTimelineId {
  segmentId: number;
}

/**
 * Ticket 09 (read-write-contract spec): `E<n>/T...` — any trailing selector
 * — is EQUIVALENT to bare `E<n>` (spec: "`timeline(id="E31/T1...")` ≡
 * `timeline(id="E31")`"). The segment id is the scope; a trailing selector
 * has no separate meaning on this route (unlike `recall`'s own per-member
 * addressing, a different tool's own route).
 *
 * Ticket 10 + [S15069/T1564]: a trailing member selector is now REFUSED here
 * rather than accepted-and-ignored. This route renders the whole segment and
 * has no windowing of its own, so accepting `E31/S12/T3..S12/T9` and silently
 * returning everything hands the caller a view they did not ask for with
 * nothing saying so — the same silent-fallback shape ruled against for
 * `view: "lane"` and for the retired ordinal selector. `E*`/`E1..9` still
 * reject as before (range/wildcard forms on the segment id ITSELF), and
 * `E<n>/L...` never reaches here — the lane route parses first.
 */
export function parseSegmentTimelineId(id: string): ParsedSegmentTimelineId | null {
  const match = id.trim().match(/^E(\d+)(?:\/T\*)?$/i);
  if (!match) {
    return null;
  }
  return { segmentId: Number(match[1]) };
}

/** A segment id carrying a trailing member selector this route cannot honor — refused by `timelineQuery`, never silently widened to the whole segment. */
export function isSegmentIdWithMemberSelector(id: string): boolean {
  const trimmed = id.trim();
  // `E<n>/T*` is not a NARROWING selector — it names every member, which is
  // what this route already renders, so it stays equivalent to the bare form.
  return /^E\d+\/(?:T|S\d+\/T)/i.test(trimmed) && !/^E\d+\/T\*$/i.test(trimmed);
}

export interface SegmentTimelineInput {
  segmentId: number;
  view?: TimelineViewKind;
  page?: number;
  /** `turns` view only (page-budget-is-the-seat-count spec, decision 2) — paginates that view's own pages. No effect on the `milestones` view; `pageBudget` below is what sizes it. */
  pageSize?: number;
  /** See `TimelineInput.pageBudget`. Governs the `turns` view's per-page token ceiling AND (page-budget-is-the-seat-count spec, decision 1) the `milestones` view's own admission budget — `selectSegmentMilestonesByEdgeSignals`'s `pageBudget` argument, defaulting to `DEFAULT_MILESTONE_PAGE_BUDGET`. */
  pageBudget?: number;
  eraCutoffEpoch?: number | null;
  /** Retired from candidacy (milestone-election spec, ticket 03: era gating leaves the election path) — accepted for schema stability with callers that still set it, forwarded to `selectSegmentMilestonesByEdgeSignals` but never read there. */
  taskCausalityEraCutoffEpoch?: number;
}

export interface SegmentTimelineView {
  view: TimelineViewKind;
  segment: SegmentRecord;
  /** The segment's whole chronological (era-scoped) membership, whatever the page/budget shows. */
  totalMembers: number;
  pageBudget: number;
  titleCap: number;
  /**
   * turns view. Same `SegmentMilestoneRow` shape the milestones view below
   * builds — the turns view is now the whole segment, unfiltered, through the
   * ONE row renderer this ticket (05) unified: a member on both pages of this
   * view AND admitted into `keptMilestones` renders byte-identically either
   * way, since both read the same `RankedSegmentMember`/antecedents/userPrompt
   * facts into the same function (`renderSegmentMilestoneRow`).
   */
  pageMembers: SegmentMilestoneRow[];
  page: number;
  pageCount: number;
  // milestones view
  keptMilestones: SegmentMilestoneRow[];
  demotedCount: number;
}

const SEGMENT_TIMELINE_TITLE_CAP = DEFAULT_TITLE_CAP;

interface BudgetPaginated<T> {
  items: T[];
  page: number;
  pageCount: number;
}

/**
 * Greedy page-building over a token budget (spec's pinned "pagination budget
 * for the turn view"): consecutive items group into a page until either
 * `pageSize` items or `budgetTokens` is reached, whichever comes first. Every
 * item lands on EXACTLY one page — this only ever bounds a page's size, it
 * never drops an item — so paging through every `page` in range reaches the
 * whole list, matching the turn view's own "overflow paginates, never
 * filters" contract. `page` is clamped into `[1, pageCount]`.
 */
function paginateByTokenBudget<T>(
  items: readonly T[],
  page: number,
  pageSize: number,
  budgetTokens: number,
  measure: (item: T) => number,
): BudgetPaginated<T> {
  const pages: T[][] = [];
  let current: T[] = [];
  let used = 0;
  for (const item of items) {
    const cost = measure(item);
    const overflowsCount = current.length >= pageSize;
    const overflowsBudget = current.length > 0 && used + cost > budgetTokens;
    if (overflowsCount || overflowsBudget) {
      pages.push(current);
      current = [];
      used = 0;
    }
    current.push(item);
    used += cost;
  }
  if (current.length > 0 || pages.length === 0) {
    pages.push(current);
  }
  const pageCount = pages.length;
  const clampedPage = Math.min(Math.max(1, page), pageCount);
  return { items: pages[clampedPage - 1] ?? [], page: clampedPage, pageCount };
}

export function buildSegmentTimelineView(
  db: Database,
  input: SegmentTimelineInput,
): SegmentTimelineView {
  const segment = getSegment(db, input.segmentId);
  if (!segment) {
    throw new Error(`timeline: segment E${input.segmentId} not found`);
  }

  const eraCutoffEpoch = input.eraCutoffEpoch ?? null;
  const viewKind = input.view ?? "turns";
  const pageBudget = input.pageBudget ?? DEFAULT_MILESTONE_PAGE_BUDGET;
  // Ticket 06 (view-render-repair, ruling [S15069/T1084]): excluded once,
  // here — both branches below (turns view's `rows`, milestones view's own
  // call into `selectSegmentMilestonesByEdgeSignals`) read this SAME
  // already-live list, so a rolled-back or skipped member consumes no page
  // budget and enters no milestone election on either view.
  const members = excludeTimelineHiddenMembers(
    db,
    chronologicalSegmentMembers(db, segment, eraCutoffEpoch),
  );
  // The turns view needs only the event-order handle; the milestones view
  // builds its own fully-resolved rows in `selectSegmentMilestonesByEdgeSignals`.
  const rows = members.map((member, index) => ({ member, ordinal: index + 1 }));

  let pageMembers: SegmentMilestoneRow[] = [];
  let page = Math.max(1, input.page ?? 1);
  let pageCount = 1;
  let keptMilestones: SegmentMilestoneRow[] = [];
  let demotedCount = 0;

  if (viewKind === "turns") {
    // Ticket 05: the turns view is now the WHOLE segment through the same row
    // renderer the milestones view uses (`renderSegmentMilestoneRow`) — no
    // per-member `TurnRecord` fetch any more, since `RankedSegmentMember`
    // already carries every field that renderer reads (title, type, stamp,
    // address, `isCorrector`); only the prompt-fallback text and the `↳`
    // antecedents are extra, and both are cheap batch queries over the whole
    // membership rather than an N+1 per row.
    const pageSize = Math.max(1, input.pageSize ?? DEFAULT_TIMELINE_PAGE_SIZE);
    const sessionTitles = new Map<number, string | null>();
    for (const row of rows) {
      if (!sessionTitles.has(row.member.sessionId)) {
        sessionTitles.set(row.member.sessionId, getSession(db, row.member.sessionId)?.title ?? null);
      }
    }
    const userPrompts = fetchUserPrompts(db, rows.map((row) => row.member.turnId));
    const links = resolveTurnRowLinks(db, members);
    const candidateRows: SegmentMilestoneRow[] = rows.map((row) => ({
      member: row.member,
      ordinal: row.ordinal,
      antecedents: links.get(row.member.turnId)?.antecedents ?? [],
      sessionTitle: sessionTitles.get(row.member.sessionId) ?? null,
      userPrompt: userPrompts.get(row.member.turnId) ?? null,
    }));
    const paged = paginateByTokenBudget(
      candidateRows,
      page,
      pageSize,
      pageBudget,
      (row) =>
        estimateDiaryTokens(
          renderSegmentMilestoneUnitLines(row, SEGMENT_TIMELINE_TITLE_CAP).join("\n"),
        ),
    );
    pageMembers = paged.items;
    page = paged.page;
    pageCount = paged.pageCount;
  } else {
    // Page-budget-is-the-seat-count spec, decision 1/2: `pageSize` no longer
    // drives this view at all — election ranks EVERY live member, and
    // `pageBudget` (a TOKEN budget, already computed above) decides how many
    // actually render, cutting in election-rank order (decision 3).
    const selection = selectSegmentMilestonesByEdgeSignals(
      db,
      members,
      pageBudget,
      input.taskCausalityEraCutoffEpoch,
    );
    keptMilestones = selection.kept;
    demotedCount = selection.demotedCount;
  }

  return {
    view: viewKind,
    segment,
    totalMembers: members.length,
    pageBudget,
    titleCap: SEGMENT_TIMELINE_TITLE_CAP,
    pageMembers,
    page,
    pageCount,
    keptMilestones,
    demotedCount,
  };
}

export function renderSegmentTimeline(view: SegmentTimelineView): string {
  const signal = createTruncationSignal();
  // `[E<n>] title`, and nothing under it (spec 金样例): the `[status] · N
  // members` line went with the count badges. Those facts still render, once,
  // on the segment CARD's own `- stats:` row.
  const header = [
    `[E${view.segment.id}] ${sanitizeTimelineField(
      truncateText(view.segment.title, { limit: view.titleCap, signal }),
    )}`,
  ];

  if (view.view === "turns") {
    // Ticket 05: the SAME row-group renderer the milestones branch below uses
    // — a turn common to both pages of this view and the segment's kept
    // milestones renders byte-identically either way (spec's own acceptance
    // criterion). No more page≥2-gets-the-full-address special case: the
    // golden sample never qualifies a row with `[S<n>][T<n>]` — a session's
    // transition line is re-emitted at the top of every page already (`rows`
    // starts fresh per page), which is what a reader landing on page 2 sees.
    const lines = [
      ...header,
      ...renderSegmentMilestoneLines(view.pageMembers, view.titleCap, signal),
    ];
    if (view.pageCount > 1) {
      lines.push("", `  showing: turns · page ${view.page}/${view.pageCount}`);
    }
    return appendNavigationLegend(lines.join("\n"), { truncated: signal.truncated });
  }

  const lines = [
    ...header,
    ...renderSegmentMilestoneLines(view.keptMilestones, view.titleCap, signal),
  ];
  const pointer = renderMilestoneDemotedPointer(view.demotedCount);
  if (pointer !== null) {
    lines.push(pointer);
    signal.truncated = true;
  }
  return appendNavigationLegend(lines.join("\n"), { truncated: signal.truncated });
}

/** One rendered side of the split segment milestones card, plus the turn ids it actually showed (for the caller's own read-grant recording). */
interface SegmentMilestoneSideRender {
  text: string;
  turnIds: number[];
}

/**
 * One side's self-contained render — kept rows (bare `[T<m>]`, opened by a
 * bare `[S<n>]` marker on each session switch, decision 3) plus overflow
 * pointer, built from an ALREADY-ELECTED
 * `SegmentMilestoneEdgeSelection` (segment-card-recent-old-split spec,
 * ticket 03). No header line and no Legend (ticket 10,
 * the-card-is-turn-rows-and-nothing-else, decisions 1/2/6): the per-side
 * `[E<n>] title` header and the trailing Legend paragraph both went with
 * that ticket — the ONE header the rendered card carries is
 * `renderAttachedSegmentBlock`'s outer `[E<n>] · milestones` slot header,
 * added by the caller on top of BOTH sides' combined output, never once per
 * side. `selection` must itself have been elected with `{ cardMode: true }`
 * (`buildSplitSegmentMilestoneCard` below is this function's only caller) —
 * the row body this function renders (`renderSegmentMilestoneCardLines`) is
 * the SAME shape `cardMode`'s own `tokensFor` measured to fit `selection` to
 * its budget in the first place.
 */
/**
 * Ticket 16 decision 5 (repairing a GPT peer review's P2 finding, confirmed
 * live on E70's card): each side of the split card is rendered
 * independently (`renderSegmentMilestoneCardLines` always opens with a
 * `[S<n>]` marker before its own first row, since its own `runSessionId`
 * starts `null` with no knowledge of what the OTHER side just rendered) —
 * so a single session whose members straddle the OLD/RECENT boundary got
 * TWO adjacent, identical markers at the seam, one per side. The fix lives
 * at the JOIN, not in either side's own renderer: strip the RECENT text's
 * own leading marker line when it names the same session OLD's own last
 * row already opened. Safe to call unconditionally on any non-empty
 * `renderSegmentMilestoneSide` output — its first line is ALWAYS that bare
 * marker whenever the side seated at least one row.
 */
function stripLeadingSessionMarker(text: string): string {
  const newlineIndex = text.indexOf("\n");
  return newlineIndex === -1 ? "" : text.slice(newlineIndex + 1);
}

function renderSegmentMilestoneSide(
  selection: SegmentMilestoneEdgeSelection,
  titleCap: number,
): SegmentMilestoneSideRender {
  const signal = createTruncationSignal();
  const lines = renderSegmentMilestoneCardLines(selection.kept, titleCap, signal);
  const pointer = renderMilestoneDemotedPointer(selection.demotedCount);
  if (pointer !== null) {
    lines.push(pointer);
  }
  return {
    text: lines.join("\n"),
    turnIds: selection.kept.map((row) => row.member.turnId),
  };
}

/**
 * The SessionStart segment milestones CARD's own entry point
 * (segment-card-recent-old-split spec, ticket 03) — deliberately NOT part of
 * `timelineQuery`'s segmentRoute branch above (decision 7: `timeline(id="E<n>",
 * view="milestones")` stays untouched, byte-for-byte, as the single-election
 * render it always was). Two independent elections instead of one: the
 * segment's newest `recentMemberCount` LIVE members (by member time, cross-
 * session — a segment spanning sessions counts members, not prompt numbers)
 * are the RECENT side, everything earlier is the OLD side, each electing and
 * rendering under half `pageBudget` via the SAME budget-is-the-seat-count
 * fitter (`selectSegmentMilestonesByEdgeSignals`, page-budget-is-the-seat-
 * count spec) a single-sided call already uses — "post-ticket-02 semantics
 * apply within each side" falls out of reusing that function unchanged, twice.
 *
 * Reserve arithmetic (ticket 02's `HEADER_AND_POINTER_RESERVE_TOKENS` +
 * legend reserve, baked into `selectSegmentMilestonesByEdgeSignals` itself):
 * NOT doubled here. Each side is handed straight `pageBudget`/2 (or the full
 * `pageBudget` when the other side is empty) and reserves ITS OWN
 * header+pointer+legend headroom out of THAT half, exactly as the unsplit
 * card already reserves once out of the whole 2000 — invoking the same
 * per-call reserve twice, once per independent call, is not an extra
 * reservation layered on top; it is what each self-contained side needs for
 * its own header/pointer/legend, the same as the unsplit call needed for its
 * one.
 *
 * Ticket 10 (the-card-is-turn-rows-and-nothing-else) deletes the per-side
 * header AND the legend from this card's body — every
 * `selectSegmentMilestonesByEdgeSignals` call on this path now passes
 * `{ cardMode: true }`, which shrinks that reserve to
 * `CARD_POINTER_RESERVE_TOKENS` (the "+N more" pointer's own worst case,
 * ~10 tokens) and prices rows against `renderSegmentMilestoneCardLines`'s
 * session-qualified, transition-line-free shape instead. The freed budget
 * buys rows directly — this paragraph's "reserves ITS OWN header+pointer+
 * legend headroom" is now "reserves ITS OWN pointer headroom", a much
 * smaller number, per side.
 *
 * Work-conserving split (ticket 06, precedence-corrected by ticket 08 — "a
 * side that seats nothing yields everything"): `kept.length === 0` is
 * checked FIRST, before any yield/hungry pairing, and outranks it — a side
 * that seated zero rows contributes zero tokens no matter WHY it seated
 * zero (structurally no candidates, or candidates it could not clear the
 * fixed header/pointer/legend reserve for), so the OTHER side simply elects
 * at the FULL `pageBudget`. Folding "seated nothing" into the SAME flag as
 * "already satisfied" (ticket 06's original `oldYields`/`recentYields`
 * union) let both flags come true at once — a reserve-starved side (seated
 * nothing, but still has candidates wanting more budget) paired with a
 * genuinely satisfied other side (`demotedCount === 0`) — and neither of
 * ticket 06's two branches fires on a double-yield, so the reserve-starved
 * side keeps a half it cannot use and the card renders fewer rows than the
 * pre-06 "one side empty -> the other gets everything" branch this was
 * supposed to absorb. When BOTH sides seat zero, RECENT is tried first at
 * the full budget — the split exists to guarantee recency a share it cannot
 * be outbid for — and OLD then gets one shot (not a loop) at whatever
 * `pageBudget` minus RECENT's ACTUAL cost leaves, so a budget that fits both
 * still shows both.
 *
 * Only once both sides have seated at least one row does ticket 06's own
 * yield/hungry pairing apply: a side yields when more budget could not buy
 * it anything (`demotedCount === 0`), the hungry other side (rows seated AND
 * more candidates still waiting) RE-ELECTS at `pageBudget` minus the
 * yielding side's actual token cost rather than being topped up after the
 * fact — the surviving set must stay its own election ranking's top-K prefix
 * at the budget it actually received (page-budget-is-the-seat-count spec,
 * decision 3), and only a re-election gives that. Two hungry sides keep
 * their guaranteed halves untouched — the anti-starvation guarantee ticket
 * 03 shipped, intact. Two already-satisfied sides are left exactly as
 * elected: a re-election could not change either output once both are
 * saturated, so none is spent (ticket 06 decision 4 — the card simply comes
 * in under budget). A segment with `recentMemberCount` live members or fewer
 * (structurally no OLD side) stays byte-identical to the pre-split card
 * (decision 2) — the empty-OLD case above.
 *
 * The result stays ONE attachment: an old part and a recent part concatenated
 * — the caller (`hooks/session-composition.ts`'s `renderAttachedSegmentBlock`)
 * adds ONE `[E<n>] · milestones` header on top of this function's WHOLE
 * return value, never once per side.
 */
export function buildSplitSegmentMilestoneCard(
  db: Database,
  segmentId: number,
  eraCutoffEpoch: number | null,
  pageBudget: number,
  recentMemberCount: number,
  readerId?: string | null,
  now?: () => number,
): string {
  const sequence = snapshotWriteGateSequence(db);
  try {
    const segment = getSegment(db, segmentId);
    if (!segment) {
      throw new Error(`timeline: segment E${segmentId} not found`);
    }
    // Ticket 06 parity (view-render-repair, ruling [S15069/T1084]): excluded
    // ONCE, here, before the boundary is even computed — the same "drop
    // before ordinal numbering or election ever sees it" discipline
    // `buildSegmentTimelineView` applies, so the newest-`recentMemberCount`
    // boundary counts LIVE members, not raw membership rows.
    const liveMembers = excludeTimelineHiddenMembers(
      db,
      chronologicalSegmentMembers(db, segment, eraCutoffEpoch),
    );
    const boundaryIndex = Math.max(0, liveMembers.length - recentMemberCount);
    const oldMembers = liveMembers.slice(0, boundaryIndex);
    const recentMembers = liveMembers.slice(boundaryIndex);
    const half = Math.floor(pageBudget / 2);

    // Ticket 10 (the-card-is-turn-rows-and-nothing-else): every election on
    // this path runs `{ cardMode: true }` — the card's own tiny reserve
    // (`CARD_POINTER_RESERVE_TOKENS`, no header, no legend) and its own
    // qualified-row cost model (`renderSegmentMilestoneCardLines`), matching
    // exactly what `renderSegmentMilestoneSide` below actually renders. The
    // MCP `E<n>` milestones view and the `S<n>` spine's nested rows never set
    // this flag and keep the pre-ticket reserve/shape untouched.
    const oldSelection = selectSegmentMilestonesByEdgeSignals(db, oldMembers, half, undefined, {
      cardMode: true,
    });
    const recentSelection = selectSegmentMilestonesByEdgeSignals(db, recentMembers, half, undefined, {
      cardMode: true,
    });

    // Ticket 08 (a-side-that-seats-nothing-yields-everything): `kept.length
    // === 0` OUTRANKS the yield/hungry pairing below — checked first, not as
    // one more OR term inside it. Ticket 06's own `oldYields`/`recentYields`
    // union folded "seated nothing" and "already satisfied" into the SAME
    // flag, so a side that seated nothing because it is reserve-starved
    // (`kept.length === 0` but `demotedCount > 0` — it still has candidates
    // it wants) and a side that is genuinely satisfied (`demotedCount === 0`)
    // could BOTH end up flagged "yields" at once, and neither of ticket 06's
    // two branches fires on a double-yield — the reserve-starved side keeps
    // a half it structurally cannot use, and the card renders fewer rows
    // than the pre-06 "one side empty -> the other gets everything" branch
    // ticket 06 was supposed to absorb, not drop.
    const oldEmpty = oldSelection.kept.length === 0;
    const recentEmpty = recentSelection.kept.length === 0;

    let finalOld = oldSelection;
    let finalRecent = recentSelection;
    let cachedOldRendered: SegmentMilestoneSideRender | null = null;
    let cachedRecentRendered: SegmentMilestoneSideRender | null = null;

    if (oldEmpty && recentEmpty) {
      // Both sides seated zero. RECENT is tried FIRST, at the FULL
      // `pageBudget` — the split exists to guarantee recency a share it
      // cannot be outbid for, and when the budget can only serve one side
      // that is the side it must serve. OLD then gets ONE shot (decision 4:
      // not a loop) at whatever `pageBudget` minus RECENT's ACTUAL rendered
      // cost leaves over, so a budget that turns out to fit both still shows
      // both.
      finalRecent = selectSegmentMilestonesByEdgeSignals(db, recentMembers, pageBudget, undefined, {
        cardMode: true,
      });
      cachedRecentRendered =
        finalRecent.kept.length > 0
          ? renderSegmentMilestoneSide(finalRecent, SEGMENT_TIMELINE_TITLE_CAP)
          : null;
      const recentTokensUsed = cachedRecentRendered ? estimateTokens(cachedRecentRendered.text) : 0;
      finalOld = selectSegmentMilestonesByEdgeSignals(
        db,
        oldMembers,
        pageBudget - recentTokensUsed,
        undefined,
        { cardMode: true },
      );
    } else if (oldEmpty) {
      // OLD contributed nothing at all, so RECENT elects at the FULL
      // `pageBudget` unconditionally — there is nothing to subtract, and
      // this is decided BEFORE asking whether RECENT itself is hungry or
      // already satisfied (a satisfied RECENT re-electing at the full
      // budget re-seats the identical set it already had, so applying this
      // unconditionally is safe, not just convenient).
      finalRecent = selectSegmentMilestonesByEdgeSignals(db, recentMembers, pageBudget, undefined, {
        cardMode: true,
      });
    } else if (recentEmpty) {
      finalOld = selectSegmentMilestonesByEdgeSignals(db, oldMembers, pageBudget, undefined, {
        cardMode: true,
      });
    } else {
      // Both sides seated at least one row here — ticket 06's own rule,
      // UNCHANGED: a side yields when more budget could not buy it anything
      // (`demotedCount === 0`); a side with rows seated AND more candidates
      // still waiting (`demotedCount > 0`) is hungry and never yields.
      // Exactly one of these fires (a side cannot simultaneously yield and
      // be hungry) — at most one re-election, on the hungry side.
      const oldYields = oldSelection.demotedCount === 0;
      const recentYields = recentSelection.demotedCount === 0;

      if (oldYields && !recentYields) {
        cachedOldRendered = renderSegmentMilestoneSide(oldSelection, SEGMENT_TIMELINE_TITLE_CAP);
        const oldTokensUsed = estimateTokens(cachedOldRendered.text);
        finalRecent = selectSegmentMilestonesByEdgeSignals(
          db,
          recentMembers,
          pageBudget - oldTokensUsed,
          undefined,
          { cardMode: true },
        );
      } else if (recentYields && !oldYields) {
        cachedRecentRendered = renderSegmentMilestoneSide(recentSelection, SEGMENT_TIMELINE_TITLE_CAP);
        const recentTokensUsed = estimateTokens(cachedRecentRendered.text);
        finalOld = selectSegmentMilestonesByEdgeSignals(
          db,
          oldMembers,
          pageBudget - recentTokensUsed,
          undefined,
          { cardMode: true },
        );
      }
      // Both hungry, or both already satisfied: neither `final*` selection
      // changes from what was elected above (ticket 06 decision 4 —
      // "nothing happens").
    }

    const oldRendered =
      cachedOldRendered ??
      (finalOld.kept.length > 0
        ? renderSegmentMilestoneSide(finalOld, SEGMENT_TIMELINE_TITLE_CAP)
        : null);
    const recentRendered =
      cachedRecentRendered ??
      (finalRecent.kept.length > 0
        ? renderSegmentMilestoneSide(finalRecent, SEGMENT_TIMELINE_TITLE_CAP)
        : null);

    // A side that seated nothing contributes no block at all — the same
    // collapse the pre-ticket "one side empty" fallback produced (decision 5
    // absorbs it into this one general rule rather than keeping it beside it).
    // Ticket 10 decision 5: the two sides join on a SINGLE newline, the same
    // separator between any two adjacent rows within one side — no blank-line
    // gap, no boundary marker. OLD's members are strictly earlier than
    // RECENT's, so the joined result reads as one continuous chronological
    // list with nothing marking where the split happened.
    let rendered: SegmentMilestoneSideRender;
    if (oldRendered && recentRendered) {
      // Ticket 16 decision 5: dedupe the seam marker when RECENT's first
      // row is in the SAME session as OLD's own last row — `finalOld`/
      // `finalRecent` are each side's TRUE final election by this point,
      // regardless of which branch above computed them.
      const oldLastSessionId = finalOld.kept[finalOld.kept.length - 1]?.member.sessionId;
      const recentFirstSessionId = finalRecent.kept[0]?.member.sessionId;
      const recentText =
        oldLastSessionId !== undefined && oldLastSessionId === recentFirstSessionId
          ? stripLeadingSessionMarker(recentRendered.text)
          : recentRendered.text;
      rendered = {
        text: [oldRendered.text, recentText].join("\n"),
        turnIds: [...oldRendered.turnIds, ...recentRendered.turnIds],
      };
    } else if (oldRendered) {
      rendered = oldRendered;
    } else if (recentRendered) {
      rendered = recentRendered;
    } else {
      // Degenerate: both sides seated nothing (e.g. every live member
      // filtered out). Render RECENT's own selection so the caller still
      // gets a well-formed, if content-free, block.
      rendered = renderSegmentMilestoneSide(finalRecent, SEGMENT_TIMELINE_TITLE_CAP);
    }

    recordTimelineReadGrants(
      db,
      readerId,
      now,
      [
        { entityType: "segment", entityId: segment.id },
        ...rendered.turnIds.map((turnId) => ({ entityType: "turn" as const, entityId: turnId })),
      ],
      sequence,
    );
    return rendered.text;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `${TIMELINE_ERROR_PREFIX}${message}`;
  }
}

// ---------------------------------------------------------------------------
// `E<n>/L*` / `E<n>/L<n>` addressing (ticket 07, lane-declaration spec D8):
// a segment's declared lanes, each rendered as one header line plus one
// representative chain. `E<n>/L*` lists every declared lane, OLDEST-first
// (ticket 15, [S15069/T1925] — the narrative axis ascends);
// `E<n>/L<n>` renders one, at the SAME 1-based ordinal the list itself would
// show it at — a navigation handle, not a stable id or a citation (a lane's
// own member turns, by contrast, are ALWAYS cited by their `S<session>/T<prompt>`
// home — one-address-grammar spec, ticket 10).
//
// NOT A PASTEABLE ADDRESS (container-unification ticket 03, spec D2). `L<n>`
// is a RENDER POSITION — the same string can name a different lane on a
// later render, once a lane is declared or removed and the newest-first
// order shifts underneath it. That is the exact defect turn addressing was
// retired for TWICE (see the paragraph above). `L<n>` stays legal ONLY as an
// interactive-picking convenience — glance at a list, then act on the ONE
// lane it pointed at, in the same render pass. The CANONICAL, pasteable lane
// address is by NAME: `recall(id="E<n>/#<tag>")`, this lane's own `tag` from
// the header line — that is what a citation, a bookmark, or a later call
// must use instead.
// ---------------------------------------------------------------------------

export interface ParsedSegmentLaneId {
  segmentId: number;
  /** `"all"` for `/L*`; a 1-based ordinal for `/L<n>`. Syntax only — an out-of-range or zero ordinal is a builder-time error, not a parse failure, so the message stays on-topic ("lane ordinal out of range") rather than falling through to an unrelated id-grammar rejection. */
  laneIndex: number | "all";
}

export function parseSegmentLaneId(id: string): ParsedSegmentLaneId | null {
  const match = id.trim().match(/^E(\d+)\/L(\*|\d+)$/i);
  if (!match) {
    return null;
  }
  const segmentId = Number(match[1]);
  if (match[2] === "*") {
    return { segmentId, laneIndex: "all" };
  }
  return { segmentId, laneIndex: Number(match[2]) };
}

export interface ParsedSegmentLaneTagId {
  segmentId: number;
  tag: string;
}

/**
 * Ticket 16 (user findings S15069/T2031): `E<n>/#<tag>` — the CANONICAL,
 * pasteable lane address (container-unification ticket 03, spec D2) — now
 * parses HERE too, not only in `recall.ts`. The regex is the exact same
 * shape `recall.ts`'s `parseRoutedId`/`laneAddressRefusal` match
 * (`/^E(\d+)\/#(.*)$/i`) — reused verbatim rather than invented afresh, so
 * the two modules can never drift on what counts as this address's grammar.
 * Canonical-tag validation is the CALLER's job (`checkCanonicalLaneTag`,
 * `db/lanes.ts` — the same predicate `declare`/`retag`/`recall` all refuse a
 * bad tag against), checked BEFORE `buildSegmentLaneListView` runs, mirroring
 * `laneAddressRefusal`'s own wiring order. `.*` (not `.+`) still matches an
 * empty tag, same reasoning as `recall.ts`'s comment on its own lane match: a
 * caller that skips the canonical check gets routed to the "not a declared
 * lane" backstop below rather than falling through to an unrelated route.
 */
export function parseSegmentLaneTagId(id: string): ParsedSegmentLaneTagId | null {
  const match = /^E(\d+)\/#(.*)$/i.exec(id.trim());
  if (!match) {
    return null;
  }
  return { segmentId: Number(match[1]), tag: match[2]! };
}

/** D8's own tie-break order — ONLY consulted between two branches of otherwise EQUAL node coverage (see `selectLaneChainPath`). Moved to `./relation-tree` as `defaultRelationRank` (tickets 12/13's shared extraction) — this file uses that import everywhere it used to call its own copy. `grounds`/`verifies`/`refutes` (ticket 12) fall through to the same defensive rank 4 as any relation this tie-break never ranked explicitly — lowest priority, so a same-phase structural/state hop wins over a cross-phase one whenever coverage ties. The fallback is otherwise unreachable now that `LANE_CHAIN_RELATIONS` spans the whole eight-word vocabulary — only a malformed stock relation could still reach it. */

/** Per-lane-chain node cap (D8's own "within the item budget"). Not exposed on `TimelineInput` — the ticket asks for a bounded representative chain, not a caller-tunable one; a lane's own member count (always rendered) is what tells the reader how much more exists. */
export const DEFAULT_LANE_CHAIN_ITEM_BUDGET = 8;

interface LaneOrderLookup {
  order: LaneOrderKey;
  createdAtEpoch?: number;
}

function laneMemberOrder(
  id: number,
  turnsById: ReadonlyMap<number, LaneCheckerTurnInput>,
): LaneOrderLookup {
  const turn = turnsById.get(id);
  return { order: turn?.order ?? [0, id], createdAtEpoch: turn?.createdAtEpoch };
}

/**
 * D8's own "NOT greedy" path selection (peer finding P2-7, ticket text: "A
 * greedy walk that shows a two-hop branch while hiding a five-node one is a
 * failed acceptance"). A proper longest-node-count-path DP over the lane's
 * own structural (`LANE_CHAIN_RELATIONS`) tagged edges, walking BACKWARD in
 * time (citing -> cited) from `startId` — never a step-by-step "best
 * immediate relation, then recency" choice. `bestCoverage` memoizes, per
 * node, the most member turns reachable by continuing optimally from there;
 * the outer walk then greedily follows the argmax CHILD at each step, which
 * is sound (not merely locally greedy) precisely because that argmax already
 * accounts for everything reachable beneath it. The D8 relation-preference
 * order and recency apply ONLY when two candidate children have EQUAL
 * `bestCoverage` — never to choose a branch outright.
 *
 * The tie-break itself (coverage compare, then `defaultRelationRank`, then
 * recency) is `./relation-tree`'s `rankChainCandidates` — tickets 12/13's
 * relation trees rank their own branch candidates with the exact same call,
 * rather than reimplementing D8's rule a second and third time.
 *
 * NOT CALLED by any renderer as of ticket 13: `buildSegmentLaneChain`, its
 * one production caller, is retired along with the single representative
 * chain it built (island-view spec, ticket 13 decision 1 replaces it with
 * one tree per connected component, whose own walk — `buildOneIslandView`/
 * `walkIslandSpine` below — forks at every node and is bidirectional,
 * neither of which this single-route, out-only walk does). Left in place,
 * exported and still pinned by its own direct unit test, because nothing in
 * either ticket asks for its removal and its algorithm is still a correct,
 * independently meaningful contract; a reviewer may want it deleted in a
 * follow-up if nothing ever calls it again.
 */
export function selectLaneChainPath(
  startId: number,
  edgesByCitingId: ReadonlyMap<number, ReadonlyArray<{ citedId: number; relation: string }>>,
  turnsById: ReadonlyMap<number, LaneCheckerTurnInput>,
): Array<{ turnId: number; relationIn: string | null }> {
  const coverage = new Map<number, number>();
  const visiting = new Set<number>();

  function bestCoverage(nodeId: number): number {
    const cached = coverage.get(nodeId);
    if (cached !== undefined) return cached;
    if (visiting.has(nodeId)) return 0; // cycle guard: corrupt input contributes 0, never hangs
    visiting.add(nodeId);
    let best = 0;
    const targets = new Set((edgesByCitingId.get(nodeId) ?? []).map((edge) => edge.citedId));
    for (const target of targets) {
      best = Math.max(best, bestCoverage(target));
    }
    visiting.delete(nodeId);
    const result = 1 + best;
    coverage.set(nodeId, result);
    return result;
  }

  const path: Array<{ turnId: number; relationIn: string | null }> = [];
  const seen = new Set<number>();
  let current = startId;
  let relationIn: string | null = null;
  for (;;) {
    seen.add(current);
    path.push({ turnId: current, relationIn });
    const children = edgesByCitingId.get(current) ?? [];
    // Parallel relations into the SAME node are one route (lane-checker.ts's
    // own "one route" convention) — keep the best-RANKED relation among them
    // so the tie-break below (and the rendered arrow) sees the strongest one.
    const byTarget = new Map<number, string>();
    for (const child of children) {
      const existing = byTarget.get(child.citedId);
      if (existing === undefined || defaultRelationRank(child.relation) < defaultRelationRank(existing)) {
        byTarget.set(child.citedId, child.relation);
      }
    }
    const candidates = [...byTarget.entries()]
      .filter(([targetId]) => !seen.has(targetId)) // cycle guard on the CHOSEN path itself
      .map(([targetId, relation]) => ({ targetId, relation }));
    const ranked = rankChainCandidates(candidates, bestCoverage, (id) => laneMemberOrder(id, turnsById));
    const best = ranked[0] ?? null;
    if (best === null) {
      break;
    }
    current = best.targetId;
    relationIn = best.relation;
  }
  return path;
}

function laneNewestMemberId(
  memberIds: readonly number[],
  turnsById: ReadonlyMap<number, LaneCheckerTurnInput>,
): number | null {
  let bestId: number | null = null;
  let bestOrder: LaneOrderLookup | null = null;
  for (const id of memberIds) {
    if (!turnsById.has(id)) continue; // coverage gap — never fabricate a position for a turn this projection did not load
    const order = laneMemberOrder(id, turnsById);
    if (bestOrder === null || compareOrderKeyAcrossSessions(order, bestOrder) > 0) {
      bestOrder = order;
      bestId = id;
    }
  }
  return bestId;
}

/** The header's "modal TYPE emoji across its member turns" (D8): the single WORD stated by the most members (dead included — a typological fact about the turn, independent of override status), ties broken by `MEMORY_TYPES`' own order — "the rubric's own type order" the ticket names. `PENDING_EMOJI` when no member stated any word at all. */
function laneModalTypeEmoji(
  memberIds: readonly number[],
  turnsById: ReadonlyMap<number, LaneCheckerTurnInput>,
): string {
  const counts = new Map<string, number>();
  for (const id of memberIds) {
    const turn = turnsById.get(id);
    if (!turn) continue;
    for (const word of turn.type) {
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  const rubricOrder = MEMORY_TYPES as readonly string[];
  let bestWord: string | null = null;
  let bestCount = 0;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const [word, count] of counts) {
    const rank = rubricOrder.indexOf(word);
    const effectiveRank = rank === -1 ? rubricOrder.length : rank;
    if (bestWord === null || count > bestCount || (count === bestCount && effectiveRank < bestRank)) {
      bestWord = word;
      bestCount = count;
      bestRank = effectiveRank;
    }
  }
  return bestWord === null ? PENDING_EMOJI : typeWordGlyph(bestWord);
}

/**
 * One connected component of a lane's own graph (island-view spec, ticket
 * 13 decision 1) — `shared/lane-checker.ts`'s `buildComponentReport`, the
 * SAME connectivity `lane_check`'s own island warning counts, is what
 * partitions a lane's members into these.
 */
export interface SegmentLaneIslandView {
  /** This island's own members, ascending — `lines`' trailing `(k)` is always this array's length, whether or not the tree covers every one of them. */
  memberIds: readonly number[];
  /** The subset of `memberIds` the tree actually rendered (root, every branch, `^` repeats included) — what the write gate records as read, distinct from `memberIds` whenever the tree is `truncated`. */
  renderedTurnIds: readonly number[];
  /** The rendered tree: `[rootLine, ...branchLines]` (`./relation-tree`'s `renderRelationTree`), the LAST line carrying the trailing `-> ..(k)` / `(k)` tail. */
  lines: string[];
  /** `true` iff the shared node budget ran out before every member was reached — the ONLY condition that earns the leading `-> ..` on the tail (decision 4). */
  truncated: boolean;
}

export interface SegmentLaneView {
  key: LaneKey;
  /** 1-based, oldest-first (ticket 15 ascending ruling) — the `[L<n>]` the header renders, stable across the list and a single-lane (`E<n>/L<n>`) render of the SAME lane. */
  laneIndex: number;
  /** The lane's newest member's `createdAtEpoch`; a declared-but-memberless lane falls back to its own `lanes.created_at_epoch`. */
  headerEpoch: number;
  headerEmoji: string;
  /** The lane's total member count — the header's own concern (ticket 13 decision 4: unchanged), never an island's own `(k)`. */
  memberCount: number;
  /** One tree per connected component, roots ASCENDING in time (ticket 15, superseding ticket 13's newest-root-first); `[]` only for a declared-but-memberless lane. */
  islands: SegmentLaneIslandView[];
}

export interface SegmentLaneListView {
  segment: SegmentRecord;
  /** Already ordered/sliced per the request — every declared lane (newest-first) for `/L*`, or the one requested ordinal for `/L<n>`. */
  lanes: SegmentLaneView[];
  totalDeclaredCount: number;
  /**
   * bounded-read-surfaces ticket 01: `/L*` pages its lane list by
   * `pageBudget` (recall's own name and meaning) — a single-lane `/L<n>`
   * render is always `page: 1, pageCount: 1` (one lane is never split).
   */
  page: number;
  pageCount: number;
}

/** One edge, either direction, indexed by the node it hangs off of (island-view spec, ticket 13) — pre-split so `islandCandidatesOf` never re-scans the lane's whole edge list per node. */
interface IslandAdjacency {
  outByNode: Map<number, RawHopEdge[]>;
  inByNode: Map<number, RawHopEdge[]>;
}

/**
 * The island's own directed adjacency, restricted to `lane.taggedEdges`
 * edges whose BOTH endpoints are lane members — `shared/lane-checker.ts`'s
 * `buildComponentReport`'s exact domain (ticket 13 decision 1: "the same
 * connectivity `lane_check`'s own island warning counts"), so the tree
 * walk below can never reach a node the partition itself would not have
 * grouped into the same island.
 */
function buildIslandAdjacency(lane: Lane, memberIds: ReadonlySet<number>): IslandAdjacency {
  const outByNode = new Map<number, RawHopEdge[]>();
  const inByNode = new Map<number, RawHopEdge[]>();
  for (const edge of lane.taggedEdges) {
    if (!memberIds.has(edge.citingId) || !memberIds.has(edge.citedId)) continue;
    const raw: RawHopEdge = { targetId: edge.citedId, relation: edge.relation, tailTag: edge.tailTag, headTag: edge.headTag };
    const outBucket = outByNode.get(edge.citingId) ?? [];
    outBucket.push(raw);
    outByNode.set(edge.citingId, outBucket);
    const inRaw: RawHopEdge = { targetId: edge.citingId, relation: edge.relation, tailTag: edge.tailTag, headTag: edge.headTag };
    const inBucket = inByNode.get(edge.citedId) ?? [];
    inBucket.push(inRaw);
    inByNode.set(edge.citedId, inBucket);
  }
  return { outByNode, inByNode };
}

interface IslandCandidate extends GroupedHop {
  direction: "out" | "in";
}

/** Both directions of `nodeId`'s own edges, pair-combined (edge-atom ticket 11 decision 4's rule, `./relation-tree`'s `groupHopEdges`) — ticket 13 decision 3's "expansion is bidirectional": an out-edge and an in-edge are equally eligible candidates here, unlike the recall tree (ticket 12), which only ever asks this question at its own root. */
function islandCandidatesOf(nodeId: number, adjacency: IslandAdjacency): IslandCandidate[] {
  const out = groupHopEdges(adjacency.outByNode.get(nodeId) ?? []).map((hop) => ({ ...hop, direction: "out" as const }));
  const inbound = groupHopEdges(adjacency.inByNode.get(nodeId) ?? []).map((hop) => ({ ...hop, direction: "in" as const }));
  return [...out, ...inbound];
}

/**
 * Reachable-node coverage over the island's UNDIRECTED adjacency —
 * DELIBERATELY NOT `selectLaneChainPath`'s own `bestCoverage` DP
 * (longest-reachable-CHAIN, a MAX over children), generalized naively to
 * bidirectional candidates. That MAX-based definition answers "how long a
 * chain do I get if I COMMIT to one path from here", which only stays a
 * meaningful discriminator when a node can only ever go ONE further
 * direction (the lane chain's own out-only domain, where committing to a
 * path is literally what the chain does). Once candidates can also walk
 * BACKWARD (ticket 13's bidirectional expansion), that same MAX-based DP
 * stops answering a symmetric question: a LEAF sitting next to a hub can
 * SWEEP through the hub's other, unrelated branch on its own one committed
 * path and come out "longer" than a node actually INSIDE that branch,
 * which can only credit itself for continuing forward OR walking back
 * through the hub, never both at once. A real fixture hits exactly this
 * (a two-child hub, one child a bare leaf, the other the head of a five-
 * node chain — the leaf's own coverage sweeps hub+chain and comes out
 * LARGER than the chain head's own).
 *
 * This function answers a different, hop-symmetric question instead: the
 * size of the connected component reachable from `nodeId` at all — genuine
 * graph reachability, a plain visited-once walk, not a best-child DP. That
 * quantity is a stable INVARIANT of a connected island: from ANY member,
 * the whole island is eventually reachable, so this always returns the
 * island's own total size regardless which node it is called on. Ranking
 * root/branch candidates by it is therefore an HONEST TIE within one
 * island — `rankChainCandidates`'s own next tie-break (word rank, then
 * recency, D8's rule, ticket 12's extraction) is what actually decides in
 * practice, exactly as intended when two candidates' coverage is equal.
 */
function islandCoverage(nodeId: number, adjacency: IslandAdjacency): number {
  const visited = new Set<number>([nodeId]);
  const stack = [nodeId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    for (const candidate of islandCandidatesOf(id, adjacency)) {
      if (!visited.has(candidate.targetId)) {
        visited.add(candidate.targetId);
        stack.push(candidate.targetId);
      }
    }
  }
  return visited.size;
}

function toIslandTreeHop(
  candidate: IslandCandidate,
  turnsById: ReadonlyMap<number, LaneCheckerTurnInput>,
  repeat: boolean,
): TreeHop {
  const order = laneMemberOrder(candidate.targetId, turnsById).order;
  return {
    targetId: candidate.targetId,
    otherSessionId: order[0],
    otherPromptNumber: order[1],
    words: candidate.words,
    crossLane: candidate.crossLane,
    tailTag: candidate.tailTag,
    headTag: candidate.headTag,
    direction: candidate.direction,
    repeat,
  };
}

interface IslandBudget {
  remaining: number;
}

/** A branch not yet walked — `cameFromId` is the node THIS candidate's own edge hangs off of, so `walkIslandSpine` can exclude walking straight back the way it came (see its own doc comment), and (ticket 16 decision 1) the node its own rendered `└` line anchors at once that is not the tree's root. */
interface QueuedBranch {
  candidate: IslandCandidate;
  cameFromId: number;
}

/**
 * Ticket 16 decision 3 (repairing a GPT peer review's "triangle-plus-tail"
 * finding): a spine's next step prefers the best-ranked candidate NOT
 * already visited — a higher-ranked candidate that is already visited
 * becomes its own `^` branch instead of ending the spine early, as long as
 * some unvisited candidate is left among `ranked`. Only when EVERY
 * candidate is already visited does the top-ranked (visited) one win and
 * end the spine, exactly as before. Applied uniformly at the root's own
 * first fork and at every step inside `walkIslandSpine` — the same
 * question ("what continues this line, and what falls back to its own
 * branch") asked twice at two different call sites.
 */
function chooseContinuation<T extends { targetId: number }>(
  ranked: readonly T[],
  visited: ReadonlySet<number>,
): { continuation: T; rest: T[] } {
  const unvisitedIndex = ranked.findIndex((candidate) => !visited.has(candidate.targetId));
  const chosenIndex = unvisitedIndex === -1 ? 0 : unvisitedIndex;
  const continuation = ranked[chosenIndex]!;
  const rest = ranked.filter((_, index) => index !== chosenIndex);
  return { continuation, rest };
}

/**
 * One spine of an island's tree (ticket 13 decisions 2/3): FORK-AT-EVERY
 * NODE (unlike the recall tree's root-only fork, ticket 12 decision 2) —
 * every candidate PAST the one chosen to continue this line is pushed onto
 * `branchQueue` for its own later line, so an island's coverage keeps
 * growing past whatever any one spine happens to reach; the caller drains
 * that queue until the budget runs out. Consumes `budget.remaining`
 * (shared across the WHOLE tree, decision 4) rather than a per-branch hop
 * cap — an island tree has no depth limit of its own, only a node count.
 * Which candidate continues the line (vs. falls back to `branchQueue`) is
 * `chooseContinuation`'s call (ticket 16 decision 3), not simply the
 * top-ranked one.
 *
 * `cameFromId` is excluded from each step's own candidates: bidirectional
 * expansion means the edge just walked (say A `-extends->` C) is ALSO,
 * from C's own side, an inbound candidate pointing straight back at A — an
 * every-single-hop "look behind you" branch that is never new information
 * (A is trivially already visited) and would otherwise turn every ordinary
 * chain into a wall of redundant `^` lines. A genuinely NEW citer (the
 * `A→C←B` acceptance criterion's B) is never excluded by this rule, since
 * it is never the node a hop just came FROM.
 */
function walkIslandSpine(
  queued: QueuedBranch,
  turnsById: ReadonlyMap<number, LaneCheckerTurnInput>,
  adjacency: IslandAdjacency,
  visited: Set<number>,
  budget: IslandBudget,
  branchQueue: QueuedBranch[],
): TreeSpine {
  const start = queued.candidate;
  // Ticket 16 decision 1: the node this branch's own `└` line anchors at,
  // once that is not the tree's root — `cameFromId` already names it, this
  // just carries it in the shared renderer's own address shape.
  const parentOrder = laneMemberOrder(queued.cameFromId, turnsById).order;
  const parent = { sessionId: parentOrder[0], promptNumber: parentOrder[1] };
  const startRepeat = visited.has(start.targetId);
  const hops: TreeHop[] = [toIslandTreeHop(start, turnsById, startRepeat)];
  if (startRepeat) {
    return { hops, truncated: false, parent };
  }
  visited.add(start.targetId);
  budget.remaining -= 1;

  let cur = start.targetId;
  let cameFromId = queued.cameFromId;
  let deadEnd = false;
  while (budget.remaining > 0) {
    const candidates = islandCandidatesOf(cur, adjacency).filter((candidate) => candidate.targetId !== cameFromId);
    if (candidates.length === 0) {
      deadEnd = true;
      break;
    }
    const ranked = rankChainCandidates(
      candidates,
      (id) => islandCoverage(id, adjacency),
      (id) => laneMemberOrder(id, turnsById),
      defaultRelationRank,
    );
    // Ticket 16 decision 3: prefer the best-ranked UNVISITED candidate to
    // continue this line; every other candidate — including a higher-ranked
    // one that is already visited — falls back to its own queued branch
    // instead of silently ending the spine (the "triangle-plus-tail" fix).
    const { continuation: best, rest } = chooseContinuation(ranked, visited);
    for (const extra of rest) {
      branchQueue.push({ candidate: extra, cameFromId: cur });
    }
    const bestRepeat = visited.has(best.targetId);
    hops.push(toIslandTreeHop(best, turnsById, bestRepeat));
    if (bestRepeat) {
      return { hops, truncated: false, parent };
    }
    visited.add(best.targetId);
    budget.remaining -= 1;
    cameFromId = cur;
    cur = best.targetId;
  }

  let truncated = false;
  if (!deadEnd && budget.remaining === 0) {
    // Ticket 17 follow-up (sixth peer round, P1): when the budget runs out
    // AT the final node, that node's own candidates were never examined —
    // its ALREADY-VISITED ones are zero-cost `^` edges that must still
    // reach the queue (the same "a repeat consumes no node" rule the
    // dequeue loop honours), and only its UNVISITED remainder is genuinely
    // cut. Enqueueing the visited ones here is what keeps the local `-> ..`
    // marker and the tree-level completeness check telling the same story:
    // before this, an island whose spine spent the last seat on a node with
    // only visited neighbours rendered `-> ..` while the completeness check
    // said nothing was truncated — both half right, jointly a lie.
    const finalCandidates = islandCandidatesOf(cur, adjacency).filter(
      (candidate) => candidate.targetId !== cameFromId,
    );
    for (const candidate of finalCandidates) {
      if (visited.has(candidate.targetId)) {
        branchQueue.push({ candidate, cameFromId: cur });
      }
    }
    // Same "only mark truncated when something was really cut" rule the
    // old single-chain's `truncated` flag followed — a spine that happens
    // to run out of budget exactly at a natural dead end earns nothing,
    // and visited neighbours now queued as `^` branches are not a cut.
    truncated = finalCandidates.some((candidate) => !visited.has(candidate.targetId));
  }
  return { hops, truncated, parent };
}

/** One island's whole tree (ticket 13), root = the island's newest member (decision 2, "the existing chain's start convention, kept"). */
function buildOneIslandView(
  island: LaneIsland,
  turnsById: ReadonlyMap<number, LaneCheckerTurnInput>,
  adjacency: IslandAdjacency,
  nodeBudget: number,
): SegmentLaneIslandView {
  const rootId = laneNewestMemberId(island.memberIds, turnsById) ?? island.memberIds[0]!;
  const rootOrder = laneMemberOrder(rootId, turnsById).order;

  if (island.memberIds.length <= 1) {
    // A trivial (edgeless) island — `buildComponentReport` itself never
    // produces one on its own domain (an island always has >=1 member by
    // construction), but a whole LANE below `MIN_REPORTED_LANE_MEMBERS`
    // (2) never reaches it either (that gate is per-LANE, this caller's
    // own synthesized singleton below is per-ISLAND) — same bare-address
    // shape either way, no tree to walk.
    return {
      memberIds: island.memberIds,
      renderedTurnIds: island.memberIds,
      lines: [`S${rootOrder[0]}/T${rootOrder[1]}(1)`],
      truncated: false,
    };
  }

  const visited = new Set<number>([rootId]);
  const budget: IslandBudget = { remaining: nodeBudget - 1 };
  const branchQueue: QueuedBranch[] = [];
  const orderOf = (id: number) => laneMemberOrder(id, turnsById);
  const coverageOf = (id: number) => islandCoverage(id, adjacency);

  const rootCandidates = islandCandidatesOf(rootId, adjacency);
  const rankedRoot = rankChainCandidates(rootCandidates, coverageOf, orderOf, defaultRelationRank);
  // Ticket 16 decision 3, applied uniformly at the root's own first fork too
  // (in practice `visited` is just `{rootId}` here, so this only ever
  // differs from picking `rankedRoot[0]` on a malformed self-citing edge —
  // `chooseContinuation` is the SAME rule `walkIslandSpine`'s own steps use,
  // not a special case).
  const { continuation: rootContinuation, rest: rootRest } =
    rankedRoot.length > 0 ? chooseContinuation(rankedRoot, visited) : { continuation: null, rest: [] };
  const mainSpine: TreeSpine =
    rootContinuation !== null && budget.remaining > 0
      ? walkIslandSpine(
          { candidate: rootContinuation, cameFromId: rootId },
          turnsById,
          adjacency,
          visited,
          budget,
          branchQueue,
        )
      : { hops: [], truncated: false };
  for (const extra of rootRest) {
    branchQueue.push({ candidate: extra, cameFromId: rootId });
  }

  const branches: TreeSpine[] = [];
  // Ticket 17 (fifth peer round, P1): a queued branch whose head is ALREADY
  // visited renders as a single `^` edge and consumes NO node budget
  // (`walkIslandSpine` returns before decrementing for a repeat) — so the
  // budget gate must not drop it. Gating the whole dequeue on
  // `budget.remaining > 0` silently discarded queued repeat edges (including
  // an island's closing `^`) exactly when the spine had consumed the full
  // node budget, narrowing ticket 16 decision 3 to "becomes a `^` branch
  // only if a node seat is left". Unvisited heads still respect the budget;
  // dropping one leaves its node unvisited, which the completeness check
  // below already reports as truncation.
  while (branchQueue.length > 0) {
    const next = branchQueue.shift()!;
    if (!visited.has(next.candidate.targetId) && budget.remaining <= 0) {
      continue;
    }
    branches.push(walkIslandSpine(next, turnsById, adjacency, visited, budget, branchQueue));
  }

  const tree: RelationTree = {
    rootSessionId: rootOrder[0],
    rootPromptNumber: rootOrder[1],
    mainSpine,
    branches,
  };
  // Ticket 13 decision 5's own convention (bare arrows, no lane suffix) —
  // `suffixOf` is a no-op; hop addresses compare to the ISLAND's own root
  // session (the recall tree's convention, ticket 12), not the previous
  // token on the same rendered line — the old single-chain's "changes from
  // the PREVIOUS node" rule has no single natural generalization once a
  // tree can have more than one line, and comparing to the tree's own fixed
  // root is what the shared renderer's stateless per-hop callback can
  // express without restructuring it.
  const lines = renderRelationTree(
    tree,
    (sessionId, promptNumber) => (sessionId === rootOrder[0] ? `T${promptNumber}` : `S${sessionId}/T${promptNumber}`),
    () => "",
  );

  const overallTruncated = visited.size < island.memberIds.length;
  const lastIndex = lines.length - 1;
  const alreadyEndsWithEllipsis = lines[lastIndex]!.endsWith(" -> ..");
  const tailMarker = overallTruncated && !alreadyEndsWithEllipsis ? " -> .." : "";
  lines[lastIndex] = `${lines[lastIndex]}${tailMarker}(${island.memberIds.length})`;

  return {
    memberIds: island.memberIds,
    renderedTurnIds: [...visited],
    lines,
    truncated: overallTruncated,
  };
}

function buildSegmentLaneIslands(
  laneRecord: LaneRecord,
  interpretation: LaneInterpretation,
  turnsById: ReadonlyMap<number, LaneCheckerTurnInput>,
  nodeBudget: number,
): Omit<SegmentLaneView, "laneIndex"> {
  const key: LaneKey = { segment: String(laneRecord.segmentId), tag: laneRecord.tag };
  const lane: Lane | undefined = interpretation.laneByToken.get(laneToken(key.segment, key.tag));

  if (lane === undefined || lane.members.length === 0) {
    // Declared but no tagged edge has ever named it yet (`deriveLaneInterpretation`
    // only creates a group from an EDGE) — a real, legal state right after
    // `remember(verb="declare", ...)`, not an error.
    return {
      key,
      headerEpoch: laneRecord.createdAtEpoch,
      headerEmoji: PENDING_EMOJI,
      memberCount: 0,
      islands: [],
    };
  }

  const memberIds = lane.members.map((member) => member.id);
  const newestId = laneNewestMemberId(memberIds, turnsById) ?? memberIds[memberIds.length - 1]!;
  const headerEpoch = turnsById.get(newestId)?.createdAtEpoch ?? laneRecord.createdAtEpoch;
  const headerEmoji = laneModalTypeEmoji(memberIds, turnsById);

  const memberIdSet = new Set(memberIds);
  // Ticket 13 decision 1: the SAME connectivity `lane_check` itself counts
  // (`shared/lane-checker.ts`'s `buildComponentReport`, called directly
  // rather than re-deriving a second partition of the same graph).
  // `MIN_REPORTED_LANE_MEMBERS` (2) gates the WHOLE lane there, not any one
  // island — a 1-member LANE reads as `null` even though the answer (one
  // trivial island) is obvious, so that single-member case is synthesized
  // here instead of asking the report for it.
  const componentReport = buildComponentReport(lane, memberIdSet);
  // Ticket 16 decision 6 (hygiene): the fallback below covers exactly the
  // gap `MIN_REPORTED_LANE_MEMBERS` (2) leaves — a 1-member lane. Asserted,
  // not just commented, so raising that threshold in `shared/lane-checker.ts`
  // fails LOUDLY here instead of silently dropping every island of a lane
  // whose member count falls in the newly-widened gap (a >=2-member lane
  // this fallback was never built to synthesize would otherwise render `[]`
  // islands with no error at all).
  // Ticket 17 (fifth peer round, P2): the guard used to compare against
  // MIN_REPORTED_LANE_MEMBERS itself — but `buildComponentReport` returns
  // null exactly when the count is BELOW that threshold, so the two
  // conditions could never both hold and the tripwire was unreachable at
  // ANY threshold value. The gap it guards is "the report declined a lane
  // the single-member fallback cannot synthesize", i.e. any declined lane
  // with MORE than one member — test against the fallback's own limit.
  if (componentReport === null && memberIds.length > 1) {
    throw new Error(
      `timeline: buildComponentReport declined a ${memberIds.length}-member lane ` +
        `(MIN_REPORTED_LANE_MEMBERS=${MIN_REPORTED_LANE_MEMBERS}) that this view's own ` +
        "single-member fallback does not cover — extend the fallback before raising the threshold.",
    );
  }
  const islandsInput: LaneIsland[] =
    componentReport?.islands ??
    (memberIds.length === 1 ? [{ representative: memberIds[0]!, memberIds: [memberIds[0]!] }] : []);

  const adjacency = buildIslandAdjacency(lane, memberIdSet);

  // Ticket 15 (user ruling [S15069/T1925] "timeline应该都是时间升序"): the
  // timeline is the narrative axis, and every list on it reads oldest-first.
  // Islands ascend by their root's (newest member's) order — superseding
  // ticket 13 decision 1's newest-root-first, which had leaked in from the
  // lane LIST's old convention. A welcome side effect: zero-edge singleton
  // islands (freshly noted turns settlement has not reached) are the newest
  // members, so they sink to the BOTTOM and the real trees lead.
  const orderedIslands = [...islandsInput].sort((a, b) => {
    const aRoot = laneNewestMemberId(a.memberIds, turnsById) ?? a.memberIds[0]!;
    const bRoot = laneNewestMemberId(b.memberIds, turnsById) ?? b.memberIds[0]!;
    return compareOrderKeyAcrossSessions(laneMemberOrder(aRoot, turnsById), laneMemberOrder(bRoot, turnsById));
  });

  const islands = orderedIslands.map((island) => buildOneIslandView(island, turnsById, adjacency, nodeBudget));

  return {
    key,
    headerEpoch,
    headerEmoji,
    memberCount: lane.members.length,
    islands,
  };
}

/**
 * Ticket 16: `laneIndex` widens to accept a NAME too — `{ tag }` — alongside
 * the pre-existing render-position ordinal (`number`) and "every lane"
 * (`"all"`). A tag selector resolves against the SAME `ordered` array the
 * ordinal form indexes into, so `E<n>/#<tag>` and whichever `E<n>/L<n>` the
 * list currently assigns that lane render byte-identical output — one build,
 * two lookup keys, never two membership computations.
 */
export type SegmentLaneSelector = number | "all" | { tag: string };

export function buildSegmentLaneListView(
  db: Database,
  segmentId: number,
  laneIndex: SegmentLaneSelector,
  itemBudget: number = DEFAULT_LANE_CHAIN_ITEM_BUDGET,
  // bounded-read-surfaces ticket 01: `/L*` renders EVERY declared lane in one
  // call with no page/budget wired at all (E60 carries 103 today) — the same
  // "a renderer spreads an unbounded set flat and its budget parameter never
  // reaches the path" shape the segment card's own page >= 2 had. `page`/
  // `pageBudget` here are recall's own name and meaning, defaulted the same
  // way the sibling `E<n>` turns-view route already defaults them
  // (`DEFAULT_MILESTONE_PAGE_BUDGET`, `paginateByTokenBudget`).
  page: number = 1,
  pageBudget: number = DEFAULT_MILESTONE_PAGE_BUDGET,
): SegmentLaneListView {
  const segment = getSegment(db, segmentId);
  if (!segment) {
    throw new Error(`timeline: segment E${segmentId} not found`);
  }

  const declared = listLanesForSegment(db, segmentId);
  const projection = loadLaneCheckScope(db, {
    kind: "lanes",
    laneKeys: declared.map((lane) => ({ segment: String(segmentId), tag: lane.tag })),
  });
  const turnsById = new Map(projection.turns.map((turn) => [turn.id, turn]));
  const interpretation = deriveLaneInterpretation(projection.turns, projection.edges);

  const built = declared.map((laneRecord) => ({
    record: laneRecord,
    view: buildSegmentLaneIslands(laneRecord, interpretation, turnsById, itemBudget),
  }));
  // Ticket 15 (user ruling [S15069/T1925]): ASCENDING by newest-member epoch —
  // the timeline is the narrative axis and every list on it reads oldest-first
  // (supersedes D8's newest-first). `[L<n>]` ordinals shift accordingly; they
  // were always render positions, never stable addresses. A memberless lane's
  // fallback epoch (its own declaration time) still sorts it deterministically,
  // tag ascending breaking any exact-epoch tie.
  built.sort((a, b) => {
    if (a.view.headerEpoch !== b.view.headerEpoch) {
      return a.view.headerEpoch - b.view.headerEpoch;
    }
    return a.record.tag.localeCompare(b.record.tag);
  });
  const ordered: SegmentLaneView[] = built.map((entry, index) => ({
    ...entry.view,
    laneIndex: index + 1,
  }));

  if (typeof laneIndex === "object") {
    // Ticket 16: name lookup against the SAME `ordered` list the ordinal
    // branch below indexes into — `key.tag` is `laneRecord.tag` verbatim
    // (already canonical: `declare`/`retag` refuse anything else), so an
    // exact string match is correct with no case-folding of its own. An
    // unknown tag names the segment's declared lanes rather than a bare
    // "not found" — the same shape `recall.ts`'s "Lane not found" message
    // could usefully have named but does not; this route does.
    const found = ordered.find((lane) => lane.key.tag === laneIndex.tag);
    if (found === undefined) {
      const declaredTags = ordered.map((lane) => `#${lane.key.tag}`);
      throw new Error(
        `E${segmentId}/#${laneIndex.tag} is not a declared lane. ` +
          (declaredTags.length > 0
            ? `E${segmentId} declares: ${declaredTags.join(", ")}.`
            : `E${segmentId} declares no lanes.`),
      );
    }
    return {
      segment,
      lanes: [found],
      totalDeclaredCount: ordered.length,
      page: 1,
      pageCount: 1,
    };
  }

  if (laneIndex === "all") {
    // Token-budget packing, same shape as `paginateByTokenBudget` above (the
    // `E<n>` turns-view route): consecutive lanes fill a page until
    // `pageBudget` tokens would be exceeded — a page always holds at least
    // one lane, so one oversized chain can never stall pagination — and
    // `page` clamps into `[1, pageCount]` rather than erroring out of range.
    const paged = paginateByTokenBudget(
      ordered,
      page,
      ordered.length || 1, // no separate count cap — pageBudget alone bounds a page
      pageBudget,
      (lane) => estimateDiaryTokens([renderLaneHeaderLine(lane), ...renderLaneIslandLines(lane)].join("\n")),
    );
    return {
      segment,
      lanes: paged.items,
      totalDeclaredCount: ordered.length,
      page: paged.page,
      pageCount: paged.pageCount,
    };
  }

  if (laneIndex < 1 || laneIndex > ordered.length) {
    throw new Error(
      `timeline: lane ordinal L${laneIndex} out of range for E${segmentId} (${ordered.length} declared lane(s))`,
    );
  }
  return {
    segment,
    lanes: [ordered[laneIndex - 1]!],
    totalDeclaredCount: ordered.length,
    page: 1,
    pageCount: 1,
  };
}

function renderLaneHeaderLine(lane: SegmentLaneView): string {
  const time = `${formatLocalMonthDay(lane.headerEpoch)} ${formatLocalTime(lane.headerEpoch)}`;
  return `[L${lane.laneIndex}] ${time} ${lane.headerEmoji} ${sanitizeTimelineField(lane.key.tag)}`;
}

/**
 * Ticket 13 decision 1: one tree per island, blank-line separated, every
 * line prefixed the same `RENDER_INDENT_STEP` the old single-chain body
 * used (each island's own tree already carries its OWN internal `└`
 * indentation, relative to where its root address starts — prefixing every
 * line of every island with the SAME outer indent preserves that relative
 * alignment without any further adjustment). `(0)` survives unchanged for
 * a declared-but-memberless lane (no islands at all).
 */
function renderLaneIslandLines(lane: SegmentLaneView): string[] {
  if (lane.islands.length === 0) {
    return [`${RENDER_INDENT_STEP}(0)`];
  }
  const lines: string[] = [];
  lane.islands.forEach((island, index) => {
    if (index > 0) {
      lines.push("");
    }
    for (const line of island.lines) {
      lines.push(`${RENDER_INDENT_STEP}${line}`);
    }
  });
  return lines;
}

/**
 * Same shape as `lane_check`'s own continuation footer
 * (`shared/lane-checker-render.ts`): states how many pages remain and the
 * exact call that reaches the next one. A single-page list (the common case)
 * carries no footer at all — nothing to continue.
 */
function laneListContinuationFooter(segmentId: number, page: number, pageCount: number): string {
  if (pageCount <= 1) {
    return "";
  }
  const remaining = pageCount - page;
  const hint =
    remaining > 0
      ? `${remaining} more page(s) -- call timeline(id="E${segmentId}/L*", page=${page + 1}) for the next`
      : "this was the last page";
  return `\n\n-- page ${page}/${pageCount}: ${hint} --`;
}

export function renderSegmentLaneView(view: SegmentLaneListView): string {
  if (view.lanes.length === 0) {
    return appendNavigationLegend(`(no lanes declared for E${view.segment.id})`, {
      truncated: false,
    });
  }
  const lines: string[] = [];
  let truncatedAny = false;
  for (const lane of view.lanes) {
    lines.push(renderLaneHeaderLine(lane));
    lines.push(...renderLaneIslandLines(lane));
    truncatedAny = truncatedAny || lane.islands.some((island) => island.truncated);
  }
  const footer = laneListContinuationFooter(view.segment.id, view.page, view.pageCount);
  return appendNavigationLegend(lines.join("\n") + footer, {
    truncated: truncatedAny || view.pageCount > 1,
  });
}

function recordTimelineReadGrants(
  db: Database,
  readerId: string | null | undefined,
  now: (() => number) | undefined,
  entries: readonly ReadGrantEntry[],
  // Ticket 14 (P1-3 fix): the render pass's own pre-render sequence snapshot
  // — captured once by `timelineQuery` before either branch reads a row,
  // never looked up fresh here at record time.
  sequence: number,
): void {
  if (!readerId || entries.length === 0) {
    return;
  }
  recordReadGrants(db, readerId, entries, (now ?? (() => Math.floor(Date.now() / 1000)))(), sequence);
}

/**
 * Ticket 07: `"lane"` is a schema-level literal only (`TimelineInput.view`'s
 * own doc comment) — neither `buildSegmentTimelineView` nor `buildTimelineView`
 * knows the word. Anywhere the id's own `E<n>/L*`/`E<n>/L<n>` suffix did NOT
 * already route the call into the lane view below, a stray `view: "lane"` is
 * simply dropped back to `undefined` (that route's own default), rather than
 * widening either builder's `TimelineViewKind` switch to a case that would
 * make no sense on a plain session or segment id.
 */
function narrowToBaseView(view: TimelineViewKind | "lane" | undefined): TimelineViewKind | undefined {
  return view === "lane" ? undefined : view;
}

export function timelineQuery(db: Database, input: TimelineInput): string {
  // Ticket 14 (P1-3 fix, spec "授权序列渲染前快照"): captured before EITHER
  // branch below reads a single row.
  const sequence = snapshotWriteGateSequence(db);
  try {
    // Ticket 13 decision 5: `S<n>/T<m>` — a single, legal turn address with
    // NO range operator — becomes the node selector, rendering one header
    // row plus the exact tree recall's own relations field shows for that
    // turn (`relations-view.ts`'s `buildTurnRelationView`, ticket 12's
    // shared implementation). `parseTimelineId`'s own long-standing single-
    // turn rejection (`does not accept single turn forms`) never fires for
    // THIS exact grammar again — this check runs first — but stays exactly
    // as it was for anything else that still reaches it (an existing unit
    // test pins that message directly against `parseTimelineId`).
    const nodeRoute = input.id !== undefined ? parseTurnNodeId(input.id) : null;
    if (nodeRoute !== null) {
      const turnRecord = getTurn(db, nodeRoute.sessionId, nodeRoute.promptNumber);
      if (!turnRecord) {
        throw new Error(`timeline: turn S${nodeRoute.sessionId}/T${nodeRoute.promptNumber} not found`);
      }
      const { lines, turnIds } = buildTurnRelationView(db, turnRecord);
      const header = renderTurnNodeHeaderLine(turnRecord);
      const body = [header, ...lines].join("\n");
      recordTimelineReadGrants(
        db,
        input.readerId,
        input.now,
        [
          { entityType: "turn", entityId: turnRecord.id },
          ...turnIds.map((turnId) => ({ entityType: "turn" as const, entityId: turnId })),
        ],
        sequence,
      );
      const truncated = lines.some((line) => line.includes(" -> ..") || line.includes("more"));
      return appendNavigationLegend(body, { truncated });
    }
    // `view: "lane"` on a bare `E<n>` means the same thing as `E<n>/L*` — a
    // request the caller spelled the other way, not a request to silently
    // hand back the ordinary turns view. Falling back without a word is the
    // shape the user ruled against in S15069/T1529; routing it is the only
    // reading under which the parameter means anything at all.
    const laneRoute =
      parseSegmentLaneId(input.id) ??
      (input.view === "lane" && input.id !== undefined
        ? parseSegmentLaneId(`${input.id}/L*`)
        : null);
    // Ticket 16 (user findings S15069/T2031): `E<n>/#<tag>` — the canonical
    // lane address `recall` already resolves (`recall.ts`'s own lane route) —
    // now parses here too, checked only when the ordinal form above did not
    // match, so `E<n>/L<n>` keeps its own "ordinal out of range" message
    // rather than this branch's "not a declared lane" text ever shadowing
    // it. Canonical-tag validation runs BEFORE the lane list is built, the
    // same order `recall.ts`'s `laneAddressRefusal` checks it in.
    const laneTagRoute =
      laneRoute === null && input.id !== undefined ? parseSegmentLaneTagId(input.id) : null;
    if (laneTagRoute !== null) {
      const canonical = checkCanonicalLaneTag(laneTagRoute.tag);
      if (!canonical.ok) {
        throw new Error(`"${input.id}" is not a usable lane address — ${canonical.message}`);
      }
    }
    if (laneRoute !== null || laneTagRoute !== null) {
      const view = buildSegmentLaneListView(
        db,
        laneRoute !== null ? laneRoute.segmentId : laneTagRoute!.segmentId,
        laneRoute !== null ? laneRoute.laneIndex : { tag: laneTagRoute!.tag },
        DEFAULT_LANE_CHAIN_ITEM_BUDGET,
        input.page ?? 1,
        input.pageBudget ?? DEFAULT_MILESTONE_PAGE_BUDGET,
      );
      // Write gate (ticket 01): the segment itself, plus every turn that
      // actually appears on a rendered tree (across every island of every
      // lane shown) — `renderedTurnIds`, not `memberIds`, since a truncated
      // island's un-reached members were never actually disclosed.
      const shownTurnIds = new Set<number>();
      for (const lane of view.lanes) {
        for (const island of lane.islands) {
          for (const turnId of island.renderedTurnIds) {
            shownTurnIds.add(turnId);
          }
        }
      }
      recordTimelineReadGrants(
        db,
        input.readerId,
        input.now,
        [
          { entityType: "segment", entityId: view.segment.id },
          ...[...shownTurnIds].map((turnId) => ({ entityType: "turn" as const, entityId: turnId })),
        ],
        sequence,
      );
      return renderSegmentLaneView(view);
    }
    if (input.id !== undefined && isSegmentIdWithMemberSelector(input.id)) {
      return (
        `${TIMELINE_ERROR_PREFIX}timeline renders a whole segment — drop the trailing selector and pass "E<n>" ` +
        `(or "E<n>/L*" for its lanes). A member window is recall's: ` +
        `recall(id="E<n>/S<a>/T<b>..S<c>/T<d>").`
      );
    }
    const segmentRoute = parseSegmentTimelineId(input.id);
    if (segmentRoute !== null) {
      const view = buildSegmentTimelineView(db, {
        segmentId: segmentRoute.segmentId,
        view: narrowToBaseView(input.view),
        page: input.page,
        pageSize: input.pageSize,
        pageBudget: input.pageBudget,
        eraCutoffEpoch: input.eraCutoffEpoch,
        taskCausalityEraCutoffEpoch: input.taskCausalityEraCutoffEpoch,
      });
      // Write gate (ticket 01): the segment itself, plus whichever member
      // turns this page actually rendered — the turns view's `pageMembers`
      // or the milestones view's `keptMilestones`, never both (one is always
      // empty depending on `view.view`).
      recordTimelineReadGrants(
        db,
        input.readerId,
        input.now,
        [
          { entityType: "segment", entityId: view.segment.id },
          ...view.pageMembers.map((row) => ({ entityType: "turn" as const, entityId: row.member.turnId })),
          ...view.keptMilestones.map((row) => ({
            entityType: "turn" as const,
            entityId: row.member.turnId,
          })),
        ],
        sequence,
      );
      return renderSegmentTimeline(view);
    }
    const view = buildTimelineView(db, input);
    // Write gate (ticket 01; ticket 14 P1-2 fix adds the SESSION entity —
    // the prior state recorded only the turns this route showed, never the
    // session detail it renders alongside them).
    recordTimelineReadGrants(
      db,
      input.readerId,
      input.now,
      [
        { entityType: "session", entityId: view.session.id },
        ...view.pageTurns.map((turn) => ({ entityType: "turn" as const, entityId: turn.id })),
        ...view.pagedMilestones.map((row) => ({ entityType: "turn" as const, entityId: row.turn.id })),
      ],
      sequence,
    );
    return renderTimeline(view, { pageBudget: input.pageBudget });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `${TIMELINE_ERROR_PREFIX}${message}`;
  }
}

/**
 * Ticket 16 scope addition (peer review finding P2): does `id` match ANY
 * shape `timelineQuery`'s own dispatcher recognizes? Reuses the SAME
 * shape-recognition functions the dispatcher itself calls — `parseTurnNodeId`,
 * `parseSegmentLaneId`, `parseSegmentLaneTagId`, `parseSegmentTimelineId`,
 * and `parseTimelineId` (tried last, in a `try` purely to ask "does it throw"
 * — its own thrown message is never inspected here) — never a second
 * grammar. `isSegmentIdWithMemberSelector` is DELIBERATELY excluded: that
 * shape parses fine but names an operation this route refuses outright,
 * which is a bad-request condition ("you can't do that here"), not a
 * not-found one — leaving it out of "recognized" is what routes its refusal
 * to 400 instead of 404. A `parseSegmentLaneTagId` match ALSO needs its tag
 * to pass `checkCanonicalLaneTag` to count as recognized — a non-canonical
 * tag (wrong case, illegal character, ...) is a malformed ADDRESS, the same
 * bad-request shape `recall.ts`'s `laneAddressRefusal` treats it as, not a
 * well-formed address whose target happens to be missing.
 */
function isRecognizedTimelineShape(id: string): boolean {
  if (parseTurnNodeId(id) !== null) return true;
  if (parseSegmentLaneId(id) !== null) return true;
  const laneTagRoute = parseSegmentLaneTagId(id);
  if (laneTagRoute !== null) return checkCanonicalLaneTag(laneTagRoute.tag).ok;
  if (parseSegmentTimelineId(id) !== null) return true;
  try {
    parseTimelineId(id);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ticket 16 scope addition (peer review finding P2): the TYPED sibling of
 * `timelineQuery`, for the console API's HTTP status. `timelineQuery` itself
 * is called exactly once here — never a second render — and its result is
 * classified by `isRecognizedTimelineShape` (400 when nothing recognizes
 * `input.id`'s shape) and `TIMELINE_ERROR_PREFIX` (404 when a recognized
 * shape's render still failed — the prefix is a stable, code-owned marker
 * every internal failure funnels through, not a guess at what the message
 * that follows it means). See `query-outcome.ts` for why this coexists with,
 * rather than replaces, the plain-string `timelineQuery` contract.
 */
export function timelineQueryOutcome(db: Database, input: TimelineInput): QueryOutcome {
  const text = timelineQuery(db, input);
  const failed = text.startsWith(TIMELINE_ERROR_PREFIX);
  const message = failed ? text.slice(TIMELINE_ERROR_PREFIX.length) : "";
  if (!isRecognizedTimelineShape(input.id)) {
    return { status: 400, message: failed ? message : text };
  }
  if (failed) {
    return { status: 404, message };
  }
  return { status: 200, text };
}
