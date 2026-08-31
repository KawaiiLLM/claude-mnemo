import type { Database } from "bun:sqlite";
import { parseInlineCitations } from "../db/citations";
import { loadLaneTagsForTurns } from "../db/lane-checker-load";
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
import { getSegment, segmentTagOf, type SegmentRecord } from "../db/segments";
import { loadSettlementCoveredTurnIds } from "../db/note-settlement";
import { getSession, type SessionRecord } from "../db/sessions";
import { getFirstTurn, getTurn, getTurnById, getTurnsForSession, type TurnRecord } from "../db/turns";
import { estimateDiaryTokens } from "../diary/domain";
import { isSegmentEra } from "../segment-era";
import { type LaneKey } from "../shared/lane-interpretation";
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
// frontier-injection ticket 02: the o200k_base runtime tokenizer's first REAL
// call sites — `buildSegmentFrontierSection`'s single-pass fitter below. A
// NAMED import now, not ticket 01's bare tree-shake anchor: token-count.ts's
// own env-gated self-test is a module-level side effect esbuild cannot prove
// pure, so importing the module at all anchors countTokens → encoder → ranks
// into every bundle that hosts this file (mcp-server, worker, hook-command,
// settlement-child — the release-artifacts sentinel asserts the rank data
// arrived).
import { countTokens } from "../shared/token-count";
import { formatRelationArrow } from "./relation-tree";
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

  // Measures the REAL assembled body the renderer would produce for this row
  // set — not a per-row sum. A per-row sum misses the `[S<n>]`
  // session-transition lines `renderSegmentMilestoneLines` inserts whenever
  // the chronological row sequence crosses a session boundary, which a
  // segment spanning several sessions pays for on every crossing. Measuring
  // the whole assembled text once is both more accurate and simpler.
  function tokensFor(rows: readonly SegmentMilestoneRow[]): number {
    const lines = renderSegmentMilestoneLines(rows, SEGMENT_TIMELINE_TITLE_CAP);
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
  // (frontier-injection ticket 02 note: the injected card's `cardMode`
  // variant of this reserve retired with the split-card composer — the two
  // callers left, the MCP `E<n>` milestones view and the `S<n>` spine's
  // nested rows, both render a header and a legend and reserve for both.)
  const HEADER_AND_POINTER_RESERVE_TOKENS = 120;
  const legendReserveTokens = estimateTokens(`\n\n${NAVIGATION_LEGEND}`);
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

// ---------------------------------------------------------------------------
// The SessionStart FRONTIER SECTION (frontier-injection spec Rev 5, ticket 02)
// — the per-task milestone slot's producer, replacing the split-segment
// milestone card wholesale. One slot per attached task (slot machinery
// preserved — `hooks/session-composition.ts` still owns the slot IDs, order,
// config and cache coordinates; only the producer swapped): per-lane digest
// lines (the six pinned denominators + the latest-override pointer) followed
// by ELECTED rows under a frozen election config, fitted to the slot budget
// by the RUNTIME tokenizer (`countTokens`, USER RULED S15069/T2218).
//
// Every algorithm here is pinned by the spec (five design-review rounds):
// the FROZEN election weights, the virtual-finish-time candidate sequence
// (USER RULED T2220 — D'Hondt-family, house-monotone by construction), the
// single acceptance pass with permanent skips, the vocabulary floor over the
// hard budget (digests always render; the block ships over-budget with a
// self-including `[overflow +<n> tok]` marker before a lane's digest ever
// disappears), and the settled-coverage truth (`loadSettlementCoveredTurnIds`
// — the settlement ledger's own committed windows, never edge presence).
// ---------------------------------------------------------------------------

/** FROZEN election config (spec "Injected milestone block") — no retuning without a new spec. Multi-type SUMS. */
const FRONTIER_TYPE_WEIGHTS: Record<string, number> = {
  design: 3,
  correction: 2,
  measure: 1,
};

/** FROZEN lane-local OUT-edge weights (edge counted only where the edge's qualified TAIL lane is the scoring lane). `extends`/`consume` weigh 0 on both sides. */
const FRONTIER_OUT_EDGE_WEIGHTS: Record<string, number> = {
  override: 2,
  indexes: 2,
  grounds: 1,
  verifies: 1,
  narrows: 1,
};

/** FROZEN lane-local IN-edge weights (qualified HEAD lane is the scoring lane). Note `override` is deliberately ABSENT here — overrider signal lives in out-degree. */
const FRONTIER_IN_EDGE_WEIGHTS: Record<string, number> = {
  verifies: 2,
  grounds: 2,
  indexes: 1,
  narrows: 1,
};

/** Event-step recency: the lane's newest settled member gets +3, then +2, +1, 0 — `max(0, 3 − steps_from_lane_end)`. */
const FRONTIER_RECENCY_WINDOW = 3;

/** The hooks' compact-synthetic tag namespace — a turn carrying one is excluded from every frontier denominator and pool. */
const COMPACT_TAG_NAMESPACE_PREFIX = "compact:";

/**
 * One valid lane-relevant relation edge, endpoints resolved. "Valid" here is
 * the two-sided lane model's completed edge: `relation` non-null, BOTH side
 * tags settled (non-empty), both endpoint turns canonical (live per
 * `liveTurnSql` and not compact-synthetic). Qualification is ALWAYS the pair
 * `(owning segment, side tag)` — the same tag word under two tasks is two
 * lanes, so no comparison below ever reads a bare tag string alone.
 */
interface FrontierEdge {
  relation: string;
  tailTurnId: number;
  headTurnId: number;
  tailTag: string;
  headTag: string;
  /** The CITING turn's owning segment (`MIN(segment_id)`, the lane model's ownership tie-break) — null when it belongs to no segment. */
  tailSegmentId: number | null;
  headSegmentId: number | null;
  tailSessionId: number;
  tailPromptNumber: number;
  tailCreatedAtEpoch: number;
  headSessionId: number;
  headPromptNumber: number;
  /** Ticket 04 (lane view): the "newer target" half of the branch-order tie (`created_at_epoch desc, id desc` over the HEAD). */
  headCreatedAtEpoch: number;
}

/** One lane's assembled read-model — denominators, pointer, edge lists, and the score-ranked candidate list. Shared by the SessionStart frontier section (ticket 02) and the lane view (ticket 04). */
interface FrontierLane {
  tag: string;
  /** The lane record's own declaration epoch — a zero-settled lane's deterministic ordering fallback (ticket 04). */
  declaredAtEpoch: number;
  /** Canonical members (event order asc): live, non-compact, owned by THIS segment, own tags carry the lane tag. */
  members: RankedSegmentMember[];
  /** The settlement-covered subset of `members` (event order asc) — the election universe and every `settled` denominator. */
  settled: RankedSegmentMember[];
  /** Canonical LIVE members not settlement-covered. */
  frontierCount: number;
  /** ALL valid edges with qualified tail in this lane (cross-lane heads included) — the digest's `edges` denominator and the lane view's forward universe. */
  forwardEdges: FrontierEdge[];
  /** Valid edges whose qualified HEAD is this lane and whose tail lane DIFFERS, tail qualifiable (`tailSegmentId` non-null — ticket 02's adjudicated reading (b): an unqualifiable address is skipped where the qualified form is mandated). The lane view's `<=` mirror universe. */
  crossLaneInbound: FrontierEdge[];
  /** Connected components of size ≥ 2 over the BOTH-endpoints-in-lane graph on settled members. */
  islandCount: number;
  /** Settled members in no ≥2-member component. */
  singletonCount: number;
  /** The rendered `latest override …` digest field, or null when no qualifying edge exists. */
  pointer: string | null;
  /** Settled members, election-score desc, ties newer first (`created_at_epoch desc, id desc`). */
  candidates: RankedSegmentMember[];
}

/** One slot of the immutable candidate sequence: the member plus the lane whose j-slot seated it (rows render under that lane). */
interface FrontierSequenceEntry {
  laneTag: string;
  member: RankedSegmentMember;
}

function isCompactSyntheticTagList(tags: readonly string[]): boolean {
  return tags.some((tag) => tag.startsWith(COMPACT_TAG_NAMESPACE_PREFIX));
}

/** Defensive raw-tag parse (same posture as `db/lanes.ts`'s CASE guards): an unreadable column claims nothing. */
function parseRawTagList(raw: string | null): string[] {
  if (raw === null) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((tag): tag is string => typeof tag === "string")
      : [];
  } catch {
    return [];
  }
}

function loadRawTurnTags(
  db: Database,
  turnIds: readonly number[],
): Map<number, string[]> {
  const result = new Map<number, string[]>();
  if (turnIds.length === 0) {
    return result;
  }
  const placeholders = turnIds.map(() => "?").join(",");
  for (const row of db
    .query<{ id: number; tags: string | null }, number[]>(
      `SELECT id, tags FROM turns WHERE id IN (${placeholders})`,
    )
    .all(...turnIds)) {
    result.set(row.id, parseRawTagList(row.tags));
  }
  return result;
}

/**
 * Every valid relation edge touching any of `laneTags` by side-tag STRING,
 * endpoints joined and post-qualified in JS (`getSegmentMembershipForTurns`
 * batches the owning-segment resolution; a same-word lane in another segment
 * is separated there, never here). Compact-synthetic endpoints are dropped —
 * both endpoints must be canonical for the edge to count anywhere.
 */
function loadFrontierEdges(
  db: Database,
  laneTags: readonly string[],
): FrontierEdge[] {
  if (laneTags.length === 0) {
    return [];
  }
  const placeholders = laneTags.map(() => "?").join(",");
  interface Row {
    relation: string;
    tailTurnId: number;
    headTurnId: number;
    tailTag: string;
    headTag: string;
    tailSessionId: number;
    tailPromptNumber: number;
    tailCreatedAtEpoch: number;
    tailTags: string | null;
    headSessionId: number;
    headPromptNumber: number;
    headCreatedAtEpoch: number;
    headTags: string | null;
  }
  const rows = db
    .query<Row, string[]>(
      `SELECT e.relation AS relation,
              e.citing_id AS tailTurnId, e.cited_id AS headTurnId,
              e.tail_tag AS tailTag, e.head_tag AS headTag,
              tc.session_id AS tailSessionId, tc.prompt_number AS tailPromptNumber,
              tc.created_at_epoch AS tailCreatedAtEpoch, tc.tags AS tailTags,
              td.session_id AS headSessionId, td.prompt_number AS headPromptNumber,
              td.created_at_epoch AS headCreatedAtEpoch, td.tags AS headTags
         FROM memory_edges e
         JOIN turns tc ON tc.id = e.citing_id
         JOIN turns td ON td.id = e.cited_id
        WHERE e.citing_kind = 'turn' AND e.cited_kind = 'turn'
          AND e.relation IS NOT NULL
          AND e.tail_tag != '' AND e.head_tag != ''
          AND (e.tail_tag IN (${placeholders}) OR e.head_tag IN (${placeholders}))
          AND ${liveTurnSql("tc")} AND ${liveTurnSql("td")}
        ORDER BY e.id ASC`,
    )
    .all(...laneTags, ...laneTags);
  const canonicalRows = rows.filter(
    (row) =>
      !isCompactSyntheticTagList(parseRawTagList(row.tailTags)) &&
      !isCompactSyntheticTagList(parseRawTagList(row.headTags)),
  );
  const owning = getSegmentMembershipForTurns(db, [
    ...new Set(canonicalRows.flatMap((row) => [row.tailTurnId, row.headTurnId])),
  ]);
  return canonicalRows.map((row) => ({
    relation: row.relation,
    tailTurnId: row.tailTurnId,
    headTurnId: row.headTurnId,
    tailTag: row.tailTag,
    headTag: row.headTag,
    tailSegmentId: owning.get(row.tailTurnId) ?? null,
    headSegmentId: owning.get(row.headTurnId) ?? null,
    tailSessionId: row.tailSessionId,
    tailPromptNumber: row.tailPromptNumber,
    tailCreatedAtEpoch: row.tailCreatedAtEpoch,
    headSessionId: row.headSessionId,
    headPromptNumber: row.headPromptNumber,
    headCreatedAtEpoch: row.headCreatedAtEpoch,
  }));
}

/** The spec's ONE total order (`created_at_epoch desc, id desc`) — every "newer" tie in this section resolves through it. */
function compareFrontierNewerFirst(
  left: Pick<RankedSegmentMember, "createdAtEpoch" | "turnId">,
  right: Pick<RankedSegmentMember, "createdAtEpoch" | "turnId">,
): number {
  if (left.createdAtEpoch !== right.createdAtEpoch) {
    return right.createdAtEpoch - left.createdAtEpoch;
  }
  return right.turnId - left.turnId;
}

/** Islands over the both-endpoints-in-lane graph on settled members: `[components ≥ 2, singletons]`. */
function countFrontierIslands(
  settled: readonly RankedSegmentMember[],
  islandEdges: readonly FrontierEdge[],
): { islands: number; singletons: number } {
  const parent = new Map<number, number>();
  const find = (id: number): number => {
    let root = id;
    while (parent.get(root)! !== root) {
      root = parent.get(root)!;
    }
    let cursor = id;
    while (parent.get(cursor)! !== cursor) {
      const next = parent.get(cursor)!;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  for (const member of settled) {
    parent.set(member.turnId, member.turnId);
  }
  for (const edge of islandEdges) {
    if (!parent.has(edge.tailTurnId) || !parent.has(edge.headTurnId)) {
      continue;
    }
    parent.set(find(edge.tailTurnId), find(edge.headTurnId));
  }
  const sizes = new Map<number, number>();
  for (const member of settled) {
    const root = find(member.turnId);
    sizes.set(root, (sizes.get(root) ?? 0) + 1);
  }
  let islands = 0;
  let singletons = 0;
  for (const size of sizes.values()) {
    if (size >= 2) {
      islands += 1;
    } else {
      singletons += 1;
    }
  }
  return { islands, singletons };
}

/**
 * The IMMUTABLE candidate sequence (USER RULED T2220, virtual-finish-time
 * ordering): lane i's j-th candidate finishes at `j ÷ settledPoolSize(i)`;
 * all lanes merge sorted by finish time asc, ties → larger pool → tag
 * lexicographic. Dedupe resolves AT GENERATION: a turn already sequenced by
 * an earlier entry is dropped where encountered and that lane's later
 * candidates shift up one j-slot each (the skip below consumes a queue item
 * but never a j-slot). Every prefix is approximately proportional to pool
 * sizes with no floor; house-monotone by construction; extends to lane
 * exhaustion — no K₀, no quotas. Finish times compare as exact integer
 * cross-products, never floats.
 */
function buildFrontierCandidateSequence(
  lanes: readonly FrontierLane[],
): FrontierSequenceEntry[] {
  const states = lanes
    .filter((lane) => lane.settled.length > 0)
    .map((lane) => ({
      lane,
      pool: lane.settled.length,
      queue: [...lane.candidates],
      emitted: 0,
    }));
  const sequenced = new Set<number>();
  const sequence: FrontierSequenceEntry[] = [];
  for (;;) {
    const active = states.filter((state) => state.queue.length > 0);
    if (active.length === 0) {
      return sequence;
    }
    active.sort((a, b) => {
      const left = (a.emitted + 1) * b.pool;
      const right = (b.emitted + 1) * a.pool;
      if (left !== right) {
        return left - right;
      }
      if (a.pool !== b.pool) {
        return b.pool - a.pool;
      }
      return a.lane.tag < b.lane.tag ? -1 : 1;
    });
    const winner = active[0]!;
    while (winner.queue.length > 0) {
      const candidate = winner.queue.shift()!;
      if (sequenced.has(candidate.turnId)) {
        continue;
      }
      sequenced.add(candidate.turnId);
      sequence.push({ laneTag: winner.lane.tag, member: candidate });
      winner.emitted += 1;
      break;
    }
  }
}

/** Full-form `S<n>/T<m>` — digest pointers are jump targets read in isolation, never folded. */
function frontierFullAddress(sessionId: number, promptNumber: number): string {
  return `S${sessionId}/T${promptNumber}`;
}

/**
 * One lane's digest line: `#tag · <n> settled · <n> edges · islands <a>+<b>
 * · latest override <S/T tail> -> <S/T head> · frontier <k>` — pointer and
 * frontier omitted when none (`omitPointer` additionally drops the pointer on
 * the vocabulary-floor ladder, whole-field, never string-truncated).
 */
function renderFrontierDigestLine(lane: FrontierLane, omitPointer: boolean): string {
  const parts = [
    `#${lane.tag}`,
    `${lane.settled.length} settled`,
    `${lane.forwardEdges.length} edges`,
    `islands ${lane.islandCount}+${lane.singletonCount}`,
  ];
  if (lane.pointer !== null && !omitPointer) {
    parts.push(lane.pointer);
  }
  if (lane.frontierCount > 0) {
    parts.push(`frontier ${lane.frontierCount}`);
  }
  return parts.join(" · ");
}

/**
 * One elected row: `T<n> <MM-DD> <type words> <title>` — type WORDS
 * comma-joined (no emoji, spec user story 17), the existing per-field title
 * cap (`SEGMENT_TIMELINE_TITLE_CAP` — titles are prose, not jump targets),
 * and the run-length session-prefix fold (`S<n>/` renders when this row's
 * session differs from the lane's previously rendered row).
 */
function renderFrontierRow(
  member: RankedSegmentMember,
  userPrompt: string | null,
  includeSessionPrefix: boolean,
): string {
  const address = renderTurnAddress(member.promptNumber, member.sessionId, includeSessionPrefix);
  const stamp = formatLocalMonthDay(member.createdAtEpoch);
  const words = member.type.join(",");
  const title = sanitizeTimelineField(
    truncateText(titleOrPromptLabel(member.title, userPrompt), {
      limit: SEGMENT_TIMELINE_TITLE_CAP,
    }),
  );
  const head = words === "" ? `${address} ${stamp}` : `${address} ${stamp} ${words}`;
  return `${head} ${title}`.trimEnd();
}

/**
 * The shared lane read-model assembly (spec "Universe predicates and
 * denominators") — steps 1-3 of the frontier section's pipeline, extracted so
 * the lane view (ticket 04) reads the EXACT same universe: canonical members
 * (era-scoped, skipped/rewound excluded, `compact:` namespace excluded),
 * ownership-resolved lane membership over the member's OWN tags, settlement
 * COVERAGE as the settled truth, and the valid-edge model (both side tags
 * settled, both endpoints canonical — ticket 02's adjudicated reading (a)).
 */
function assembleFrontierLanes(
  db: Database,
  segment: SegmentRecord,
  eraCutoffEpoch: number | null,
): FrontierLane[] {
  const segmentId = segment.id;
  const laneRecords = listLanesForSegment(db, segmentId);

  // 1. The canonical member universe.
  const liveMembers = excludeTimelineHiddenMembers(
    db,
    chronologicalSegmentMembers(db, segment, eraCutoffEpoch),
  );
  const rawTagsById = loadRawTurnTags(db, liveMembers.map((member) => member.turnId));
  const canonicalMembers = liveMembers.filter(
    (member) => !isCompactSyntheticTagList(rawTagsById.get(member.turnId) ?? []),
  );
  const owningByTurn = getSegmentMembershipForTurns(
    db,
    canonicalMembers.map((member) => member.turnId),
  );
  const coveredIds = loadSettlementCoveredTurnIds(
    db,
    canonicalMembers.map((member) => ({
      turnId: member.turnId,
      sessionId: member.sessionId,
      promptNumber: member.promptNumber,
    })),
  );
  const edges = loadFrontierEdges(db, laneRecords.map((lane) => lane.tag));

  // 2-3. Per-lane denominators, pointer and candidate ranking.
  return laneRecords.map((laneRecord) => {
    const tag = laneRecord.tag;
    const members = canonicalMembers.filter(
      (member) =>
        owningByTurn.get(member.turnId) === segmentId &&
        (rawTagsById.get(member.turnId) ?? []).includes(tag),
    );
    const settled = members.filter((member) => coveredIds.has(member.turnId));
    const settledIds = new Set(settled.map((member) => member.turnId));
    const tailQualifies = (edge: FrontierEdge): boolean =>
      edge.tailTag === tag && edge.tailSegmentId === segmentId;
    const headQualifies = (edge: FrontierEdge): boolean =>
      edge.headTag === tag && edge.headSegmentId === segmentId;
    const forwardEdges = edges.filter(tailQualifies);
    const crossLaneInbound = edges.filter(
      (edge) => headQualifies(edge) && !tailQualifies(edge) && edge.tailSegmentId !== null,
    );
    const islandEdges = forwardEdges.filter(
      (edge) =>
        headQualifies(edge) &&
        settledIds.has(edge.tailTurnId) &&
        settledIds.has(edge.headTurnId),
    );
    const { islands, singletons } = countFrontierIslands(settled, islandEdges);

    // Latest override: newest-by-TAIL-event-order valid override edge whose
    // qualified HEAD is in this lane — same-lane or cross-lane tail; a
    // cross-lane tail renders its own qualified lane `(E<n>/#tag)`. A tail
    // owned by no segment cannot be qualified and is skipped.
    const overrideEdges = edges
      .filter(
        (edge) =>
          edge.relation === "override" &&
          headQualifies(edge) &&
          edge.tailSegmentId !== null,
      )
      .sort((left, right) => {
        if (left.tailCreatedAtEpoch !== right.tailCreatedAtEpoch) {
          return right.tailCreatedAtEpoch - left.tailCreatedAtEpoch;
        }
        return right.tailTurnId - left.tailTurnId;
      });
    const latestOverride = overrideEdges[0] ?? null;
    let pointer: string | null = null;
    if (latestOverride) {
      const crossLane = !tailQualifies(latestOverride);
      const tailAddress = frontierFullAddress(
        latestOverride.tailSessionId,
        latestOverride.tailPromptNumber,
      );
      const qualifier = crossLane
        ? `(E${latestOverride.tailSegmentId}/#${latestOverride.tailTag})`
        : "";
      const headAddress = frontierFullAddress(
        latestOverride.headSessionId,
        latestOverride.headPromptNumber,
      );
      pointer = `latest override ${tailAddress}${qualifier} -> ${headAddress}`;
    }

    // Election score over the settled pool. Recency is event-STEP based:
    // `settled` is event-ascending, so steps_from_lane_end = (n-1) - index.
    const scores = new Map<number, number>();
    settled.forEach((member, index) => {
      const steps = settled.length - 1 - index;
      let score = Math.max(0, FRONTIER_RECENCY_WINDOW - steps);
      for (const word of member.type) {
        score += FRONTIER_TYPE_WEIGHTS[word] ?? 0;
      }
      for (const edge of edges) {
        if (tailQualifies(edge) && edge.tailTurnId === member.turnId) {
          score += FRONTIER_OUT_EDGE_WEIGHTS[edge.relation] ?? 0;
        }
        if (headQualifies(edge) && edge.headTurnId === member.turnId) {
          score += FRONTIER_IN_EDGE_WEIGHTS[edge.relation] ?? 0;
        }
      }
      scores.set(member.turnId, score);
    });
    const candidates = [...settled].sort((left, right) => {
      const scoreLeft = scores.get(left.turnId)!;
      const scoreRight = scores.get(right.turnId)!;
      if (scoreLeft !== scoreRight) {
        return scoreRight - scoreLeft;
      }
      return compareFrontierNewerFirst(left, right);
    });

    return {
      tag,
      declaredAtEpoch: laneRecord.createdAtEpoch,
      members,
      settled,
      frontierCount: members.length - settled.length,
      forwardEdges,
      crossLaneInbound,
      islandCount: islands,
      singletonCount: singletons,
      pointer,
      candidates,
    };
  });
}

/** Frontier display order (spec): newest settled member desc (total order), ties tag-lex; zero-settled lanes last, tag-lex among themselves. */
function compareFrontierDisplayOrder(left: FrontierLane, right: FrontierLane): number {
  const newestLeft = left.settled[left.settled.length - 1] ?? null;
  const newestRight = right.settled[right.settled.length - 1] ?? null;
  if (newestLeft === null && newestRight === null) {
    return left.tag < right.tag ? -1 : 1;
  }
  if (newestLeft === null) {
    return 1;
  }
  if (newestRight === null) {
    return -1;
  }
  const byNewest = compareFrontierNewerFirst(newestLeft, newestRight);
  if (byNewest !== 0) {
    return byNewest;
  }
  return left.tag < right.tag ? -1 : 1;
}

/**
 * The SessionStart frontier section's own entry point (frontier-injection
 * spec Rev 5, ticket 02) — the milestone slot's producer, called by
 * `hooks/session-composition.ts` in the exact seat
 * `buildSplitSegmentMilestoneCard` used to fill. Deliberately NOT part of
 * `timelineQuery`: `timeline(id="E<n>", view="milestones")` keeps the old
 * scorer's single-election render untouched (spec "Scorer scope and
 * retirement" — the flat surfaces unify in a follow-up spec, not here).
 *
 * Assembly, in spec order:
 *
 *   1. universe — the segment's canonical members (era-scoped, then
 *      `excludeTimelineHiddenMembers` for skipped/rewound, then the
 *      `compact:` namespace exclusion); lane membership is the member's OWN
 *      tags ∩ this segment's declared lanes, ownership-resolved
 *      (`MIN(segment_id)` — a turn owned by another segment is that
 *      segment's member, whatever words it carries);
 *   2. settled — settlement COVERAGE (`loadSettlementCoveredTurnIds`), never
 *      edge presence; frontier = canonical live members not covered;
 *   3. election — frozen weights + event-step recency over each lane's
 *      settled members, ties newer first;
 *   4. sequence — `buildFrontierCandidateSequence` (virtual finish times,
 *      generation-time dedupe);
 *   5. acceptance — ONE ordered scan; a candidate is accepted iff the
 *      actually-rendered block (with it added) fits the slot budget by
 *      `countTokens`; a rejected candidate is PERMANENTLY skipped and the
 *      scan continues (a later cheaper candidate may still fit);
 *   6. vocabulary floor — if the digests alone exceed the budget: no rows,
 *      then override pointers omitted whole-field one lane at a time in
 *      REVERSE display order, then the block ships over-budget with a
 *      self-including `[overflow +<n> tok]` header marker (fixed point:
 *      compute, render, recount until stable — digit-width included).
 *
 * Lane display order: newest settled member desc (the pinned total order),
 * ties tag-lexicographic; zero-settled lanes last (tag-lex among themselves),
 * digest-only. Rows within a lane display time-ASCENDING.
 */
export function buildSegmentFrontierSection(
  db: Database,
  segmentId: number,
  eraCutoffEpoch: number | null,
  pageBudget: number,
  readerId?: string | null,
  now?: () => number,
): string {
  const sequence = snapshotWriteGateSequence(db);
  try {
    const segment = getSegment(db, segmentId);
    if (!segment) {
      throw new Error(`timeline: segment E${segmentId} not found`);
    }
    const lanes = assembleFrontierLanes(db, segment, eraCutoffEpoch);
    const displayLanes = [...lanes].sort(compareFrontierDisplayOrder);

    const taskTag = segmentTagOf(segment);
    const header = taskTag === null ? `E${segment.id}` : `E${segment.id} #${taskTag}`;
    const userPrompts = fetchUserPrompts(
      db,
      lanes.flatMap((lane) => lane.settled.map((member) => member.turnId)),
    );

    const renderBlock = (
      accepted: readonly FrontierSequenceEntry[],
      pointersOmittedFromEnd: number,
      overflowTokens: number | null,
    ): string => {
      const rowsByLane = new Map<string, RankedSegmentMember[]>();
      for (const entry of accepted) {
        const bucket = rowsByLane.get(entry.laneTag) ?? [];
        bucket.push(entry.member);
        rowsByLane.set(entry.laneTag, bucket);
      }
      for (const bucket of rowsByLane.values()) {
        // Display order within a lane: time-ascending (spec step 5).
        bucket.sort((left, right) => -compareFrontierNewerFirst(left, right));
      }
      const lines: string[] = [
        overflowTokens === null ? header : `${header} [overflow +${overflowTokens} tok]`,
      ];
      displayLanes.forEach((lane, index) => {
        const omitPointer = index >= displayLanes.length - pointersOmittedFromEnd;
        lines.push(renderFrontierDigestLine(lane, omitPointer));
        let previousSessionId: number | null = null;
        for (const member of rowsByLane.get(lane.tag) ?? []) {
          lines.push(
            renderFrontierRow(
              member,
              userPrompts.get(member.turnId) ?? null,
              member.sessionId !== previousSessionId,
            ),
          );
          previousSessionId = member.sessionId;
        }
      });
      return lines.join("\n");
    };

    const budget = Math.max(0, pageBudget);
    let text: string;
    let shownTurnIds: number[] = [];

    if (countTokens(renderBlock([], 0, null)) <= budget) {
      // 4-5. The ordinary branch: one acceptance scan over the immutable
      // sequence. Rejection is permanent and never stops the scan.
      const candidateSequence = buildFrontierCandidateSequence(lanes);
      const accepted: FrontierSequenceEntry[] = [];
      for (const entry of candidateSequence) {
        if (countTokens(renderBlock([...accepted, entry], 0, null)) <= budget) {
          accepted.push(entry);
        }
      }
      text = renderBlock(accepted, 0, null);
      shownTurnIds = accepted.map((entry) => entry.member.turnId);
    } else {
      // 6. Vocabulary floor: rows are already gone; omit pointers whole-field
      // one lane at a time in REVERSE display order.
      let shipped: string | null = null;
      for (let omitted = 1; omitted <= displayLanes.length; omitted += 1) {
        const trial = renderBlock([], omitted, null);
        if (countTokens(trial) <= budget) {
          shipped = trial;
          break;
        }
      }
      if (shipped === null) {
        // Over-budget with the self-including overflow marker. The fixed
        // point converges because the marker's cost moves only with its
        // digit count: recount until the rendered overage equals the number
        // the marker states (the digit-width boundary is exactly the case
        // that needs the second iteration).
        let marker = 1;
        for (let iteration = 0; iteration < 8; iteration += 1) {
          const trial = renderBlock([], displayLanes.length, marker);
          const over = countTokens(trial) - budget;
          if (over === marker) {
            shipped = trial;
            break;
          }
          marker = Math.max(1, over);
        }
        shipped ??= renderBlock([], displayLanes.length, marker);
      }
      text = shipped;
    }

    recordTimelineReadGrants(
      db,
      readerId,
      now,
      [
        { entityType: "segment", entityId: segment.id },
        ...shownTurnIds.map((turnId) => ({
          entityType: "turn" as const,
          entityId: turnId,
        })),
      ],
      sequence,
    );
    return text;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `${TIMELINE_ERROR_PREFIX}${message}`;
  }
}

// ---------------------------------------------------------------------------
// `E<n>/L*` / `E<n>/L<n>` addressing (ticket 07, lane-declaration spec D8):
// a segment's declared lanes, each rendered as one ruled adjacency page
// (frontier-injection ticket 04 — see the lane view section below).
// `E<n>/L*` lists every declared lane, OLDEST-first
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

// ---------------------------------------------------------------------------
// The lane view render (frontier-injection spec Rev 5, ticket 04) — the RULED
// ADJACENCY TABLE. The greedy spine machinery that used to live here (island
// coverage scoring, the bidirectional spine walk, the shared node budget and
// its `-> ..` truncation) is DELETED from this route wholesale (spec "Lane
// view", user story 19): what renders now is the adjacency list itself —
// every valid tail-in-lane edge exactly once as a FORWARD element, plus
// inbound cross-lane mirrors — over the SAME universe the frontier section
// reads (`assembleFrontierLanes`: settled canonical members, qualified
// `(task, tag)` identity everywhere).
//
// Single-page scope (ticket 04): a lane renders as ONE page; a lane whose
// full rendering exceeds the page budget ships over budget with an honest
// self-including `[overflow +<n> tok]` marker (the frontier block's own
// fixed-point rule). Real pagination — the greedy newest→oldest partition,
// pass-2 boundary caps, `<-` same-lane cross-page mirrors, `(p/N)` pointers —
// is ticket 05's; `buildLaneAdjacencyPages` below is the seam it slots into.
// ---------------------------------------------------------------------------

/**
 * The lane page's arrow legend — one line, the four arrows as DATA
 * (lane-locality × direction, spec "Notation"). `<-` (same-lane cross-page
 * inbound) cannot appear until ticket 05 paginates; the legend states all
 * four so the notation is learned once.
 */
const LANE_ARROW_LEGEND =
  "arrows: -> in-lane · => cross-lane out · <= cross-lane in · <- cross-page in";

/**
 * Branch ordering (USER RULED T2218): the election's OUT-edge weight TABLE
 * (`FRONTIER_OUT_EDGE_WEIGHTS` — override/indexes 2 > grounds/verifies/
 * narrows 1 > extends/consume 0), then newer TARGET under the pinned total
 * order (`created_at_epoch desc, id desc` over the head). The trailing
 * relation-word compare only ever fires on a same-weight multi-relation pair
 * over one (tail, head) — determinism, not a ranking claim.
 */
function compareLaneBranchEdges(left: FrontierEdge, right: FrontierEdge): number {
  const weightLeft = FRONTIER_OUT_EDGE_WEIGHTS[left.relation] ?? 0;
  const weightRight = FRONTIER_OUT_EDGE_WEIGHTS[right.relation] ?? 0;
  if (weightLeft !== weightRight) {
    return weightRight - weightLeft;
  }
  if (left.headCreatedAtEpoch !== right.headCreatedAtEpoch) {
    return right.headCreatedAtEpoch - left.headCreatedAtEpoch;
  }
  if (left.headTurnId !== right.headTurnId) {
    return right.headTurnId - left.headTurnId;
  }
  return left.relation < right.relation ? -1 : left.relation > right.relation ? 1 : 0;
}

/** Mirror ordering: the SAME weight table, newer SOURCE first (spec: "mirrors after all branches, same sort" — honestly named a reuse of the OUT-edge table, not the incoming scorer). */
function compareLaneMirrorEdges(left: FrontierEdge, right: FrontierEdge): number {
  const weightLeft = FRONTIER_OUT_EDGE_WEIGHTS[left.relation] ?? 0;
  const weightRight = FRONTIER_OUT_EDGE_WEIGHTS[right.relation] ?? 0;
  if (weightLeft !== weightRight) {
    return weightRight - weightLeft;
  }
  if (left.tailCreatedAtEpoch !== right.tailCreatedAtEpoch) {
    return right.tailCreatedAtEpoch - left.tailCreatedAtEpoch;
  }
  if (left.tailTurnId !== right.tailTurnId) {
    return right.tailTurnId - left.tailTurnId;
  }
  return left.relation < right.relation ? -1 : left.relation > right.relation ? 1 : 0;
}

/** One rendered lane page: the lines, the skeleton-shown members (write-gate grant set + title-table membership), and the overflow marker's stated count when the page shipped over budget. */
interface LaneAdjacencyPage {
  lines: string[];
  shownTurnIds: number[];
  overflowTokens: number | null;
}

/**
 * Ticket 05's pagination seam: the page PARTITION lives here (greedy
 * newest→oldest over the pinned total order, pass-2 persistent boundary caps,
 * `(p/N)` re-render). Single-page scope (this ticket): every settled member
 * lands on the one page, and a lane that cannot fit the budget ships as a
 * single over-budget page with the explicit `[overflow +<n> tok]` marker
 * rather than splitting — `renderLaneAdjacencyPage` already takes the page's
 * member subset as a parameter, so ticket 05 slots a real partition in front
 * of it without touching the render.
 */
function buildLaneAdjacencyPages(
  segment: SegmentRecord,
  lane: FrontierLane,
  userPrompts: ReadonlyMap<number, string | null>,
  pageBudget: number,
): LaneAdjacencyPage[] {
  return [renderLaneAdjacencyPage(segment, lane, lane.settled, userPrompts, pageBudget)];
}

/**
 * One lane page in the ruled adjacency form (spec "Lane view"):
 *
 *   - CHAIN DECOMPOSITION: roots processed newest-first (total order); a root
 *     renders ALL its not-yet-rendered out-edges, each starting its own
 *     BRANCH — the heaviest on the root's main line, every other as a `└`
 *     line; ONE continuation rule for every branch (a branch continues
 *     through its target only if the target is first-visit AND single-out AND
 *     mirror-free AND on this page); anything else is a terminal stub, `^`
 *     marking "expanded/rendered elsewhere" (an already-rendered node, or a
 *     fork/mirror-carrier that re-roots later). Forks, revisited nodes with
 *     unrendered edges, and mirror-carrying nodes thereby become their own
 *     roots — the newest-first member scan needs no separate root list.
 *   - FORWARD EXACTLY-ONCE: every valid tail-in-lane edge whose tail is on
 *     this page renders exactly once as a forward element (`->` in-lane,
 *     `=>` cross-lane stub with the mandatory `(E<n>/#tag)` qualifier — a
 *     head with no owning segment cannot be qualified and is skipped,
 *     ticket 02's adjudicated reading (b)).
 *   - MIRRORS: after all branches of their head's root block, `└ relation <=
 *     S<n>/T<m>^(E<n>/#tag)`, ordered by the same weight table (newer source
 *     first); same-relation mirrors fold onto ONE line, every source address
 *     individually rendered, full-form (jump targets read in isolation).
 *   - ADDRESS FOLD: within one chain line the session prefix run-length
 *     folds (a line's first address is always full; later addresses render
 *     bare `T<m>` while the session repeats). Cross-lane stubs and mirror
 *     sources never fold.
 *   - TITLE TABLE: time-ascending rows for skeleton-shown members only, the
 *     frontier block's own row form (`renderFrontierRow` — type WORDS,
 *     existing title cap, session-prefix fold down the table).
 *   - HEADER: qualified lane address + separately-named counts, each
 *     verifiable against this page's own rendered content; then the arrow
 *     legend. Over budget → the self-including overflow marker (fixed point:
 *     compute, render, recount until the rendered overage equals the stated
 *     number — the frontier block's rule).
 */
function renderLaneAdjacencyPage(
  segment: SegmentRecord,
  lane: FrontierLane,
  pageMembers: readonly RankedSegmentMember[],
  userPrompts: ReadonlyMap<number, string | null>,
  pageBudget: number,
): LaneAdjacencyPage {
  const memberById = new Map(pageMembers.map((member) => [member.turnId, member]));
  const inLane = (edge: FrontierEdge): boolean =>
    edge.headTag === lane.tag && edge.headSegmentId === segment.id;

  // The page's forward universe: valid tail-in-lane edges hosted by a member
  // of THIS page (the spec's "on its tail's page"), minus cross-lane edges
  // whose head cannot render the mandated qualified form (reading (b)).
  const forwardEdges = lane.forwardEdges.filter(
    (edge) =>
      memberById.has(edge.tailTurnId) && (inLane(edge) || edge.headSegmentId !== null),
  );
  const outByTail = new Map<number, FrontierEdge[]>();
  for (const edge of forwardEdges) {
    const bucket = outByTail.get(edge.tailTurnId) ?? [];
    bucket.push(edge);
    outByTail.set(edge.tailTurnId, bucket);
  }
  for (const bucket of outByTail.values()) {
    bucket.sort(compareLaneBranchEdges);
  }
  const mirrorsByHead = new Map<number, FrontierEdge[]>();
  for (const edge of lane.crossLaneInbound) {
    if (!memberById.has(edge.headTurnId)) {
      continue;
    }
    const bucket = mirrorsByHead.get(edge.headTurnId) ?? [];
    bucket.push(edge);
    mirrorsByHead.set(edge.headTurnId, bucket);
  }
  for (const bucket of mirrorsByHead.values()) {
    bucket.sort(compareLaneMirrorEdges);
  }

  const renderedEdges = new Set<FrontierEdge>();
  const appeared = new Set<number>();
  let mirrorCount = 0;

  /**
   * One branch, from its root out-edge to its terminal — the shared
   * continuation loop every branch (main-line and `└` alike) applies.
   * `previousSessionId` seeds the fold: the main line inherits the root's
   * session (the root address just rendered), a `└` line starts unfolded.
   */
  const renderBranch = (firstEdge: FrontierEdge, previousSessionId: number | null): string => {
    const parts: string[] = [];
    let edge = firstEdge;
    let previousSession = previousSessionId;
    for (;;) {
      renderedEdges.add(edge);
      if (!inLane(edge)) {
        parts.push(
          `${edge.relation} => S${edge.headSessionId}/T${edge.headPromptNumber}^` +
            `(E${edge.headSegmentId}/#${edge.headTag})`,
        );
        break;
      }
      const address =
        previousSession === edge.headSessionId
          ? `T${edge.headPromptNumber}`
          : `S${edge.headSessionId}/T${edge.headPromptNumber}`;
      previousSession = edge.headSessionId;
      const member = memberById.get(edge.headTurnId);
      const outs = member === undefined ? [] : outByTail.get(edge.headTurnId) ?? [];
      const mirrors = member === undefined ? [] : mirrorsByHead.get(edge.headTurnId) ?? [];
      const continuable =
        member !== undefined &&
        !appeared.has(edge.headTurnId) &&
        outs.length === 1 &&
        mirrors.length === 0;
      if (continuable) {
        parts.push(`${edge.relation} -> ${address}`);
        appeared.add(edge.headTurnId);
        edge = outs[0]!;
        continue;
      }
      // Terminal. `^` iff the node expands elsewhere: already rendered on an
      // earlier line, or it still owns unrendered content (a fork's out-edges,
      // a mirror fold) and therefore re-roots later in the scan. A first-visit
      // dead end renders plain — this line IS its render.
      const rendersElsewhere =
        appeared.has(edge.headTurnId) ||
        outs.some((out) => !renderedEdges.has(out)) ||
        mirrors.length > 0;
      if (!rendersElsewhere && member !== undefined) {
        appeared.add(edge.headTurnId);
      }
      parts.push(`${edge.relation} -> ${address}${rendersElsewhere ? "^" : ""}`);
      break;
    }
    return parts.join(" ");
  };

  const skeleton: string[] = [];
  const newestFirst = [...pageMembers].sort(compareFrontierNewerFirst);
  for (const member of newestFirst) {
    const pendingBranches = (outByTail.get(member.turnId) ?? []).filter(
      (edge) => !renderedEdges.has(edge),
    );
    const mirrors = mirrorsByHead.get(member.turnId) ?? [];
    if (pendingBranches.length === 0 && mirrors.length === 0) {
      // Continued-through, terminal-only, or a settled singleton — no block.
      // A zero-edge singleton stays a MEMBER (header counts it); it just
      // never earns a skeleton line (spec: singletons are counted, not
      // rendered).
      continue;
    }
    appeared.add(member.turnId);
    let mainLine = `S${member.sessionId}/T${member.promptNumber}`;
    if (pendingBranches.length > 0) {
      mainLine += ` ${renderBranch(pendingBranches[0]!, member.sessionId)}`;
    }
    skeleton.push(mainLine);
    for (const extra of pendingBranches.slice(1)) {
      skeleton.push(`└ ${renderBranch(extra, null)}`);
    }
    // Mirrors AFTER all branches. Grouped by relation FIRST (a same-weight
    // relation pair may interleave by source recency in the sorted list, and
    // a relation folds onto ONE line regardless), then the groups keep the
    // sorted order of their best member — weight desc, newest source first.
    const foldGroups = new Map<string, string[]>();
    for (const mirror of mirrors) {
      const sources = foldGroups.get(mirror.relation) ?? [];
      sources.push(
        `S${mirror.tailSessionId}/T${mirror.tailPromptNumber}^` +
          `(E${mirror.tailSegmentId}/#${mirror.tailTag})`,
      );
      foldGroups.set(mirror.relation, sources);
      mirrorCount += 1;
    }
    for (const [relation, sources] of foldGroups) {
      skeleton.push(`└ ${relation} <= ${sources.join(", ")}`);
    }
  }

  // Title table: time-ascending (pageMembers is already event-ascending),
  // skeleton-shown members only, the frontier block's own row form.
  const shownMembers = pageMembers.filter((member) => appeared.has(member.turnId));
  const titleRows: string[] = [];
  let previousSessionId: number | null = null;
  for (const member of shownMembers) {
    titleRows.push(
      renderFrontierRow(
        member,
        userPrompts.get(member.turnId) ?? null,
        member.sessionId !== previousSessionId,
      ),
    );
    previousSessionId = member.sessionId;
  }

  const headerBase = [
    `E${segment.id}/#${lane.tag}`,
    `${lane.settled.length} settled`,
    `${renderedEdges.size} forward`,
    `${mirrorCount} mirrors`,
    `islands ${lane.islandCount}+${lane.singletonCount}`,
    `frontier ${lane.frontierCount}`,
  ].join(" · ");

  const assemble = (overflow: number | null): string[] => {
    const headerLine =
      overflow === null ? headerBase : `${headerBase} [overflow +${overflow} tok]`;
    const lines = [headerLine, LANE_ARROW_LEGEND, ...skeleton];
    if (titleRows.length > 0) {
      lines.push("", ...titleRows);
    }
    return lines;
  };

  const budget = Math.max(0, pageBudget);
  let lines = assemble(null);
  let overflowTokens: number | null = null;
  if (countTokens(lines.join("\n")) > budget) {
    // The frontier block's self-including fixed point: the marker's cost
    // moves only with its digit count, so recount until the rendered overage
    // equals the number the marker states.
    let marker = 1;
    for (let iteration = 0; iteration < 8; iteration += 1) {
      const trial = assemble(marker);
      const over = countTokens(trial.join("\n")) - budget;
      if (over === marker) {
        lines = trial;
        overflowTokens = marker;
        break;
      }
      marker = Math.max(1, over);
    }
    if (overflowTokens === null) {
      lines = assemble(marker);
      overflowTokens = marker;
    }
  }

  return {
    lines,
    shownTurnIds: shownMembers.map((member) => member.turnId),
    overflowTokens,
  };
}

export interface SegmentLaneView {
  key: LaneKey;
  /** 1-based render position — the `E<n>/L<n>` interactive-picking handle, NOT a stable address (see the addressing comment above `parseSegmentLaneId`). */
  laneIndex: number;
  /** The lane's newest SETTLED member's `createdAtEpoch`; a zero-settled lane falls back to its own declaration epoch. */
  headerEpoch: number;
  /** The lane's rendered page (header · legend · skeleton · title table). */
  lines: string[];
  /** Skeleton-shown members — the write gate's grant set (a member the page never disclosed is not read). */
  shownTurnIds: number[];
  /** Non-null when the page shipped over budget: the `[overflow +<n> tok]` marker's own stated count. */
  overflowTokens: number | null;
}

export interface SegmentLaneListView {
  segment: SegmentRecord;
  /** Already ordered/sliced per the request — every declared lane for `/L*`, or the one requested lane. */
  lanes: SegmentLaneView[];
  totalDeclaredCount: number;
  /** `/L*` pages its LANE LIST by `pageBudget` (a page always holds at least one lane); a single-lane render is always `page: 1, pageCount: 1`. */
  page: number;
  pageCount: number;
}

/**
 * Ticket 16: `laneIndex` accepts a NAME (`{ tag }`) alongside the
 * render-position ordinal (`number`) and "every lane" (`"all"`). A tag
 * selector resolves against the SAME `ordered` array the ordinal form
 * indexes into, so `E<n>/#<tag>` and whichever `E<n>/L<n>` currently points
 * at that lane render byte-identical output — one build, two lookup keys.
 */
export type SegmentLaneSelector = number | "all" | { tag: string };

export function buildSegmentLaneListView(
  db: Database,
  segmentId: number,
  laneIndex: SegmentLaneSelector,
  page: number = 1,
  pageBudget: number = DEFAULT_MILESTONE_PAGE_BUDGET,
  eraCutoffEpoch: number | null = null,
): SegmentLaneListView {
  const segment = getSegment(db, segmentId);
  if (!segment) {
    throw new Error(`timeline: segment E${segmentId} not found`);
  }

  const lanes = assembleFrontierLanes(db, segment, eraCutoffEpoch);
  const userPrompts = fetchUserPrompts(
    db,
    lanes.flatMap((lane) => lane.settled.map((member) => member.turnId)),
  );
  const built = lanes.map((lane) => {
    const newest = lane.settled[lane.settled.length - 1] ?? null;
    return {
      lane,
      adjacency: buildLaneAdjacencyPages(segment, lane, userPrompts, pageBudget)[0]!,
      headerEpoch: newest === null ? lane.declaredAtEpoch : newest.createdAtEpoch,
    };
  });
  // Ticket 15 (user ruling [S15069/T1925] "timeline应该都是时间升序"): the
  // timeline is the narrative axis, so the lane LIST ascends — by newest
  // SETTLED member epoch now that settled coverage is the universe (a
  // zero-settled lane sorts by its declaration epoch), tag ascending breaking
  // exact-epoch ties. `[L<n>]` ordinals shift with the order; they were
  // always render positions, never stable addresses.
  built.sort((left, right) => {
    if (left.headerEpoch !== right.headerEpoch) {
      return left.headerEpoch - right.headerEpoch;
    }
    return left.lane.tag.localeCompare(right.lane.tag);
  });
  const ordered: SegmentLaneView[] = built.map((entry, index) => ({
    key: { segment: String(segmentId), tag: entry.lane.tag },
    laneIndex: index + 1,
    headerEpoch: entry.headerEpoch,
    lines: entry.adjacency.lines,
    shownTurnIds: entry.adjacency.shownTurnIds,
    overflowTokens: entry.adjacency.overflowTokens,
  }));

  if (typeof laneIndex === "object") {
    // Ticket 16: name lookup against the SAME `ordered` list the ordinal
    // branch below indexes into — `key.tag` is `laneRecord.tag` verbatim
    // (already canonical: `declare`/`retag` refuse anything else), so an
    // exact string match is correct with no case-folding of its own. An
    // unknown tag names the segment's declared lanes rather than a bare
    // "not found".
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
    // Token-budget packing over the LANE LIST (bounded-read-surfaces ticket
    // 01's contract, kept): consecutive lanes fill a page until `pageBudget`
    // would be exceeded — a page always holds at least one lane, so one
    // oversized lane can never stall pagination — and `page` clamps into
    // `[1, pageCount]`. Measured by the runtime tokenizer now (ticket 04):
    // the lane view is a frontier surface, and its budgets are real tokens.
    const paged = paginateByTokenBudget(
      ordered,
      page,
      ordered.length || 1, // no separate count cap — pageBudget alone bounds a page
      pageBudget,
      (lane) => countTokens(lane.lines.join("\n")),
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
  const blocks = view.lanes.map((lane) => lane.lines.join("\n"));
  const footer = laneListContinuationFooter(view.segment.id, view.page, view.pageCount);
  return appendNavigationLegend(blocks.join("\n\n") + footer, {
    truncated: view.pageCount > 1 || view.lanes.some((lane) => lane.overflowTokens !== null),
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
        input.page ?? 1,
        input.pageBudget ?? DEFAULT_MILESTONE_PAGE_BUDGET,
        input.eraCutoffEpoch ?? null,
      );
      // Write gate (ticket 01): the segment itself, plus every SKELETON-SHOWN
      // member of every rendered lane page — `shownTurnIds`, never a lane's
      // whole membership, since a settled singleton (or a member of an
      // unrendered page) was never actually disclosed.
      const shownTurnIds = new Set<number>();
      for (const lane of view.lanes) {
        for (const turnId of lane.shownTurnIds) {
          shownTurnIds.add(turnId);
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
  // TICKET 19, finding 4: FILTER VALIDITY IS INDEPENDENT OF RESOURCE
  // EXISTENCE, so it is decided before the existence-shaped classification
  // below ever runs. A malformed `filter` throws inside `timelineQuery`, and
  // that throw funnels into the same `TIMELINE_ERROR_PREFIX` every internal
  // failure uses — so for a RECOGNIZED id (`id=S1&time=not-a-date`) the
  // classifier below read it as "this session's render failed" and answered
  // 404, telling the caller the session is missing when the session is fine
  // and the request is not. Parsed here with the same function the render
  // itself uses, so the two can never disagree about what is malformed, and
  // the message is the parser's own — the identical prose the 404 carried.
  const { error: filterError } = parseMemoryFilter(input.filter);
  if (filterError) {
    return { status: 400, message: filterError };
  }
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
