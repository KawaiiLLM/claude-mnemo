import type { Database } from "bun:sqlite";
import { parseInlineCitations } from "../db/citations";
import { loadLaneCheckScope } from "../db/lane-checker-load";
import { listLanesForSegment, type LaneRecord } from "../db/lanes";
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
import { getSegment, type SegmentRecord } from "../db/segments";
import { getSession, type SessionRecord } from "../db/sessions";
import { getFirstTurn, getTurnById, getTurnsForSession, type TurnRecord } from "../db/turns";
import { estimateDiaryTokens } from "../diary/domain";
import { isSegmentEra } from "../segment-era";
import type { LaneCheckerTurnInput } from "../shared/lane-checker";
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
  electMilestones,
  type LaneEdgeInput,
  type MilestoneCandidate,
  type MilestoneTier,
  type MilestoneTurnInput,
} from "../shared/milestone-election";
import { resolveSessionTranscriptPath } from "../shared/paths";
import { isKnownSystemInjectedContent } from "../shared/transcript-parser";
import { EDGE_RELATIONS } from "../shared/turn-phase";
import {
  LEGACY_TYPE_GLYPH,
  MEMORY_TYPES,
  typeListGlyph,
  typeListsEqual,
  typeWordGlyph,
} from "../shared/type-vocabulary";

import {
  appendNavigationLegend,
  cachedFormatter,
  createTruncationSignal,
  formatDuration,
  formatGap,
  formatLocalDate,
  formatLocalMonthDay,
  formatLocalTime,
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

export interface TimelineInput {
  id: string;
  page?: number;
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
   * Milestones only: show the trailing `pageSize` kept milestones (the most
   * recent end) instead of front-aligned page 1. Selection still runs over the
   * full window; only the displayed slice changes. Used by the SessionStart
   * context render so compact/clear surface the recent milestone arc.
   */
  milestoneTail?: boolean;
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
   * Ticket 09/12: no longer either route's MILESTONES-view admission rule —
   * `pageSize` drives that now, on both the standalone `E<n>` route and the
   * `S<n>` era spine's own nested per-segment rows
   * (`selectSegmentMilestonesByEdgeSignals`, shared by both — see
   * `TimelineView.segmentMilestoneSelection`). The `S<n>` turn view paginates
   * by item count, not this budget, and the legacy (pre-era) milestone body
   * keeps its own `RenderTimelineOptions.tokenBudget` ladder.
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
  /** True when this milestone view shows the trailing slice (see TimelineInput.milestoneTail). */
  milestoneTail: boolean;
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
   * Ticket 05: `↳` antecedents and the self-corrector flag (⚑) for `pageTurns`
   * — the plain `S<n>` turns view has no `RankedSegmentMember` to read
   * `isCorrector` off (that concept exists only inside a segment), so this is
   * resolved eagerly here off the same `memory_edges` predicate
   * (`resolveTurnRowLinks`), keeping the render step a pure function of
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
   * Whole-output token budget (spec §D). Left undefined — which is what every
   * MCP view does — the renderer emits the full page and only pagination bounds
   * it. Set, the milestones body degrades lowest-score render units first
   * (desc → title-only → drop the unit) until the output fits; always-keep units
   * degrade but are never dropped, so an anchor-only set that still overruns is
   * rendered in full with one overflow note appended.
   */
  tokenBudget?: number;
  /**
   * See `TimelineInput.pageBudget`. Ticket 12: no longer consumed by
   * `renderTimeline` for the `S<n>` era spine's nested rows (selection now
   * happens eagerly in `buildTimelineView`, keyed on `pageSize` — see
   * `TimelineView.segmentMilestoneSelection`); kept on this type for schema
   * stability with callers that still set it.
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
   * themselves elected (present in the same selection's `kept` set) —
   * pre-formatted `T<n>(word,word2)` strings (edge-read-surface spec, ticket
   * 01: the relation word(s) that pair carries, alphabetical, each named
   * once), ascending by the cited turn's prompt number. An unelected cited
   * turn is omitted entirely, never pulled in as a separate row; the line's
   * rendering (and token-budget) cost is folded into THIS row's own unit —
   * no separate pulled-antecedent object survives this ticket (contrast the
   * retired `PulledAntecedent`).
   */
  antecedents: string[];
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
   * The election's own budget cut (milestone-election spec, ticket 03): the
   * top-`budget` window candidates by election rank, re-sorted to TIME order
   * (spec step 5 — "elected rows render in TIME order, never score order").
   * This is the display set; `ranked` (below) is the wider, unbounded pool a
   * degradation pass (a `tokenBudget`) still has to consult.
   */
  kept: KeptMilestone[];
  /**
   * Every non-excluded window candidate, election-rank order (best first),
   * UNBOUNDED by `budget` — a superset of `kept`. `compareMilestoneRank`
   * sorts with this array's own order (via `score`); the renderer's
   * degradation ladder reads it in reverse to decide what a `tokenBudget`
   * sheds first. Shares object identity with `kept` for the rows in both.
   */
  ranked: KeptMilestone[];
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

// Trailing slice: the last `pageSize` items (most recent end), never a short
// front-page artifact. `total`/`pageCount` stay honest so the showing line and
// earlier hint can report the full set.
function tailItems<T>(items: T[], pageSize: number): PaginatedItems<T> {
  const start = Math.max(0, items.length - pageSize);
  return {
    items: items.slice(start),
    total: items.length,
    pageCount: Math.max(1, Math.ceil(items.length / pageSize)),
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
function buildElectedCitations(
  laneEdges: readonly LaneEdgeInput[],
  electedIds: ReadonlySet<number>,
): Map<number, Map<number, string[]>> {
  const citedByTurn = new Map<number, Map<number, Set<string>>>();
  for (const edge of laneEdges) {
    if (edge.citingId === edge.citedId) continue;
    if (!electedIds.has(edge.citingId) || !electedIds.has(edge.citedId)) continue;
    const bucket = citedByTurn.get(edge.citingId) ?? new Map<number, Set<string>>();
    const words = bucket.get(edge.citedId) ?? new Set<string>();
    words.add(edge.relation);
    bucket.set(edge.citedId, words);
    citedByTurn.set(edge.citingId, bucket);
  }
  const result = new Map<number, Map<number, string[]>>();
  for (const [citingId, bucket] of citedByTurn) {
    const wordsByCited = new Map<number, string[]>();
    for (const [citedId, words] of bucket) {
      wordsByCited.set(citedId, [...words].sort());
    }
    result.set(citingId, wordsByCited);
  }
  return result;
}

/** `T<n>` / `S<sid>/T<n>` plus its `(word,word2)` suffix — `()` omitted when `words` is empty (a bare, unclassified pair — see the callers' own doc comments for when that happens). */
function formatAntecedentAddress(address: string, words: readonly string[]): string {
  return words.length > 0 ? `${address}(${words.join(",")})` : address;
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
  return rows.map((row) => ({
    id: row.id,
    type: [] as string[],
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
  /** R1 #7: window ids that cite a rolled-back turn — `db/memory-edges.ts`'s `getRolledBackCiterIds`, fed straight through to `electMilestones`. */
  rolledBackCiterIds?: readonly number[];
  /** The election's own budget (see this function's own doc comment) — bounds `kept`, and (via `electMilestones`) tier ③'s two-stage fill. */
  budget: number;
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
    order: [turn.sessionId, turn.promptNumber] as const,
    createdAtEpoch: turn.createdAtEpoch,
  }));
  const { candidates } = electMilestones(
    [...electionTurns, ...(view.externalTurns ?? [])],
    laneEdges,
    view.budget,
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
  const electedSlice = windowCandidates.slice(0, Math.max(0, view.budget));
  const electedIds = new Set(electedSlice.map((candidate) => candidate.id));
  const citedByTurn = buildElectedCitations(laneEdges, electedIds);
  const antecedentsOf = (turnId: number): string[] => {
    const bucket = citedByTurn.get(turnId);
    if (!bucket) return [];
    return [...bucket.keys()]
      .sort((a, b) => turnById.get(a)!.promptNumber - turnById.get(b)!.promptNumber)
      .map((id) =>
        formatAntecedentAddress(`T${turnById.get(id)!.promptNumber}`, bucket.get(id)!),
      );
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

  const kept = rankedRows
    .slice(0, Math.max(0, view.budget))
    .slice()
    .sort((a, b) => a.turn.promptNumber - b.turn.promptNumber);

  const keptIds = new Set(kept.map((row) => row.turn.id));
  const overflowByDay: OverflowHint[] = [];
  const droppedByDay = new Map<string, TurnRecord[]>();
  for (const turn of seq) {
    if (keptIds.has(turn.id)) {
      continue;
    }
    const day = formatLocalDate(turn.createdAtEpoch);
    const bucket = droppedByDay.get(day) ?? [];
    bucket.push(turn);
    droppedByDay.set(day, bucket);
  }
  for (const [date, dropped] of droppedByDay) {
    const byPrompt = [...dropped].sort((a, b) => a.promptNumber - b.promptNumber);
    overflowByDay.push({
      date,
      count: byPrompt.length,
      firstPrompt: byPrompt[0]!.promptNumber,
      lastPrompt: byPrompt[byPrompt.length - 1]!.promptNumber,
      labelEpoch: byPrompt[0]!.createdAtEpoch,
    });
  }

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
  // Milestone election (ticket 03): the election's own budget is `pageSize`
  // CLAMPED to the sensible default — never `pageSize` alone, because the
  // SessionStart injection asks for `pageSize: Number.MAX_SAFE_INTEGER` (no
  // pagination limit) and relies ENTIRELY on `RenderTimelineOptions.tokenBudget`
  // to size the output; an unclamped budget would hand `electMilestones` (and
  // so `kept`) an unbounded cut, defeating curation before the token-budget
  // ladder ever runs. A caller wanting a SMALLER election (the golden-nine
  // fixture: budget 9) still gets it, since the clamp only ever lowers, never
  // raises, an explicit small `pageSize`.
  const milestoneBudget = Math.min(pageSize, DEFAULT_TIMELINE_PAGE_SIZE);
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
    budget: milestoneBudget,
  });
  // `windowTurns` is already exclusion-filtered above (ticket 06), so no
  // second skip/rewind filter is needed here — the turns view's page budget
  // is spent only on turns that still exist for the timeline.
  const pagedTurns =
    viewKind === "turns"
      ? paginateItems(windowTurns, page, pageSize)
      : emptyPaginatedItems<TurnRecord>(windowTurns.length, pageSize);
  const milestoneTail = viewKind === "milestones" && input.milestoneTail === true;
  const pagedMilestones =
    viewKind === "milestones"
      ? milestoneTail
        ? tailItems(milestoneSelection.kept, pageSize)
        : paginateItems(milestoneSelection.kept, page, pageSize)
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
  // `undone`), but it has no column for the DB rewind flag — its
  // `MemberRankFacts.isRolledBack` is the unrelated edge-derived fact
  // (segment-rank.ts's own doc comment). Cross-referenced against `allTurns`
  // here instead of a second DB round trip.
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
  // Per-segment admission uses `DEFAULT_TIMELINE_PAGE_SIZE` — the same
  // default the standalone route falls back to with no explicit `pageSize`
  // — since `TimelineInput` carries no separate per-segment knob.
  const segmentMilestoneSelection = new Map<number, SegmentMilestoneEdgeSelection>();
  if (renderSegments) {
    for (const row of segmentSpine) {
      segmentMilestoneSelection.set(
        row.segment.id,
        selectSegmentMilestonesByEdgeSignals(
          db,
          chronologicalSegmentMembers(db, row.segment, eraCutoffEpoch),
          DEFAULT_TIMELINE_PAGE_SIZE,
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
  // Ticket 05: `↳`/`⚑` facts for the plain turns view's own rows — the same
  // `memory_edges` predicate `RankedSegmentMember.isCorrector` uses, resolved
  // directly since this view has no segment membership to read it off.
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
    hasEarlier: milestoneTail
      ? pagedMilestones.items.length < milestoneSelection.kept.length
      : false,
    milestoneTail,
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

  // Milestones: select over the full session (correct endpoints/budget/retention)
  // and display the trailing window of kept milestones — the recent arc, which is
  // what compact/clear want to restore. buildTimelineView sets hasEarlier itself.
  if (view === "milestones") {
    return buildTimelineView(db, {
      id: `S${sessionId}`,
      view: "milestones",
      pageSize: DEFAULT_TIMELINE_PAGE_SIZE,
      milestoneTail: true,
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
    `- [S${view.session.id}] ${startDate} ${formatLocalTime(sessionStart)} → ${endLabel} (${formatDuration((sessionEnd - sessionStart) * 1000)}${compactSuffix})`,
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

function formatShowingLine(view: TimelineView): string | null {
  if (view.viewItemTotal === 0 || view.viewItemTotal <= view.pageSize) {
    return null;
  }

  const anchor = view.pageAnchorEpoch === null
    ? ""
    : ` · ${formatLocalDateWithWeekday(view.pageAnchorEpoch)}`;
  if (view.milestoneTail) {
    return `${view.view} · last ${view.pagedMilestones.length}/${view.viewItemTotal}${anchor}`;
  }
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
    antecedentsShown: Math.min(unit.milestone.antecedents.length, MILESTONE_UNIT_PULLED_CAP),
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
  // (spec 补充裁决 2+3): `[T821] 08-17 18:19 ⚖️ title`. The user's own words,
  // the `✏️` file tail and the desc block below are budget-permitting
  // ENRICHMENTS — every one of them is already a trim knob, so a unit under
  // pressure lands exactly on the baseline and never below it. No `G<n>`, no
  // tier label, no back-link: an overridden/refuted victim never reaches a
  // row at all under the election (candidacy exclusion, milestone-election
  // spec step 1), so there is no row left to hang one on.
  const markerGlyph = milestone.marker === null ? "" : `${glyph} `;
  const promptTail = prompt === "" ? "" : ` · "${prompt}"`;
  const stamp = `${formatLocalMonthDay(milestone.turn.createdAtEpoch)} ${formatLocalTime(milestone.turn.createdAtEpoch)}`;
  const lines = [
    `${TIMELINE_TURN_INDENT}${markerGlyph}[T${milestone.turn.promptNumber}] ${stamp} ${typeEmoji(milestone.turn.type)} ${title}${promptTail}${filesTail}`.trimEnd(),
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
  // one titled row each — `milestone.antecedents` is already pre-formatted
  // `T<n>` addresses (milestone-election spec, ticket 03: only cited turns
  // that are themselves elected). Overflow past `trim.antecedentsShown` folds
  // into a trailing count, which is now the ONLY count form left on this
  // surface.
  const shown = milestone.antecedents.slice(0, trim.antecedentsShown);
  const foldedAntecedents = milestone.antecedents.length - trim.antecedentsShown;
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
 * Per-code-point token weight in TENTHS of a token, before the ×1.2 scale
 * `estimateDiaryTokens` applies. Integers on purpose: the budget fitter adds
 * thousands of these incrementally, and integer arithmetic makes the running
 * total independent of addition order.
 *
 * `estimateDiaryTokens` (diary/domain.ts) owns the 1.1/0.6 weights; these are
 * that scale ×10. The budget sweep test is what would catch them drifting apart.
 */
const HAN_WEIGHT_TENTHS = 11;
const OTHER_WEIGHT_TENTHS = 6;
/** One `\n` joins each body line to the rest of the output. */
const NEWLINE_WEIGHT_TENTHS = OTHER_WEIGHT_TENTHS;

function textWeightTenths(text: string): number {
  let total = 0;
  for (const codePoint of text) {
    total += /\p{Script=Han}/u.test(codePoint) ? HAN_WEIGHT_TENTHS : OTHER_WEIGHT_TENTHS;
  }
  return total;
}

/**
 * `estimateDiaryTokens` reconstructed from an already-summed weight. It is a
 * LOWER bound on the real thing: never above it, and at most one token below —
 * `estimateDiaryTokens` accumulates in floating point, so a total that lands
 * exactly on an integer rounds one token up there and not here. The fitter
 * therefore uses this to reject steps cheaply and confirms every stop with the
 * real measure.
 */
function tokensFromWeightTenths(tenths: number): number {
  return Math.ceil((tenths * 12) / 100);
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
  frameTenths: number;
  /** Summed weight of the rendered units, in tenths. */
  unitTenths: number;
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
  tenths: number;
}

interface MilestoneUnitEntry {
  lines: string[];
  tenths: number;
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
  /** Body weight in tenths, including the `\n` that joins each line. */
  weightTenths(): number;
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
      frameTenths: 0,
      unitTenths: 0,
      run: null,
    };
  });
  const stateOfMilestone = new Map<KeptMilestone, MilestoneSectionState>();
  for (const state of orderedStates) {
    for (const milestone of state.rows) {
      stateOfMilestone.set(milestone, state);
    }
  }

  let totalTenths = 0;
  let priced = false;

  function lineTenths(line: string): number {
    return textWeightTenths(line) + NEWLINE_WEIGHT_TENTHS;
  }

  function unitEntryFor(milestone: KeptMilestone): MilestoneUnitEntry {
    const cached = unitEntries.get(milestone);
    if (cached !== undefined) {
      return cached;
    }
    const lines = renderUnitFitted({ milestone }, titleCap, descOff.has(milestone), signal);
    const entry: MilestoneUnitEntry = {
      lines,
      tenths: lines.reduce((sum, line) => sum + lineTenths(line), 0),
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
    const delta = unitEntryFor(milestone).tenths - (previous?.tenths ?? 0);
    state.unitTenths += delta;
    totalTenths += delta;
  }

  function linesTenths(lines: string[]): number {
    return lines.reduce((sum, line) => sum + lineTenths(line), 0);
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
    const tenths = linesTenths(expandedFrameLines(state));
    totalTenths += tenths - state.frameTenths;
    state.frameTenths = tenths;
  }

  function priceRun(run: CollapsedRun): void {
    const tenths = linesTenths(runLines(run));
    totalTenths += tenths - run.tenths;
    run.tenths = tenths;
  }

  /**
   * Fold a day that holds no row into the collapsed run beside it, merging the
   * runs on either side when it closes the gap between them. The surviving
   * record is the larger of the two (union by size), so re-pointing members
   * stays near-linear across a whole removal ladder.
   */
  function collapseState(state: MilestoneSectionState): void {
    totalTenths -= state.frameTenths;
    state.frameTenths = 0;
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
        tenths: 0,
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
      totalTenths -= other.tenths;
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
    state.unitTenths = state.rows.reduce(
      (sum, milestone) => sum + unitEntryFor(milestone).tenths,
      0,
    );
    totalTenths += state.unitTenths;
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
  totalTenths += NEWLINE_WEIGHT_TENTHS;

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
        state.unitTenths -= entry.tenths;
        totalTenths -= entry.tenths;
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
    },
    weightTenths(): number {
      return totalTenths;
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
 * Renders the arc body with no budget applied: every selected unit in full.
 * `createMilestoneBodyModel` is the single implementation — the budget path is
 * the same model with degradation steps applied.
 */
function renderMilestoneBody(
  view: TimelineView,
  titleCap: number,
  signal?: TruncationSignal,
): MilestoneBodyResult {
  if (view.milestoneDayGroups.length === 0) {
    return { lines: [], hiddenTurns: false };
  }
  const body = createMilestoneBodyModel(view, titleCap, signal);
  return { lines: body.lines(), hiddenTurns: body.hasHiddenTurns() };
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
 * Two-tier measurement. The model's running weight prices every step in O(1),
 * but it is a LOWER bound on `estimateDiaryTokens` (that function's float
 * accumulation can round one token higher). So the cheap number gates the
 * expensive one: a step whose cheap price still overruns cannot possibly fit,
 * and the first step that might fit is confirmed with `measure`, which reports
 * the token cost of the WHOLE assembled output — header and signal blocks
 * included. The stopping point is therefore identical to re-measuring the full
 * output on every step, at a fraction of the work.
 *
 * `measure` also takes the model's CURRENT `hasHiddenTurns()` so the
 * expensive check prices the response-level legend the way it will actually
 * be assembled (spec D4): the legend is appended outside this function's
 * returned `lines`, so a check that ignored it could accept a candidate that
 * overruns once the caller adds it. The cheap tenths pre-check stays
 * legend-blind — it only ever gates the expensive one, never substitutes for
 * it, so under-pricing there costs a few redundant steps, not correctness.
 */
function fitMilestoneBodyToBudget(
  view: TimelineView,
  titleCap: number,
  tokenBudget: number,
  fixedWeightTenths: number,
  measure: (bodyLines: string[], hiddenTurns: boolean) => number,
  signal?: TruncationSignal,
): MilestoneBodyResult {
  const body = createMilestoneBodyModel(view, titleCap, signal);
  const fits = (): boolean =>
    tokensFromWeightTenths(fixedWeightTenths + body.weightTenths()) <= tokenBudget &&
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
 * renders, over a bare `TurnRecord` instead of a `RankedSegmentMember` — this
 * view has no segment, so there is no rank-facts row to read `isCorrector` off
 * (`links`, resolved eagerly in `buildTimelineView` via `resolveTurnRowLinks`,
 * supplies it and the `↳` addresses instead). `⨯`/strikethrough still mark an
 * undone turn (unrelated to this ticket's renderer merge, kept as-is).
 */
function renderPlainTurnRowLines(
  turn: TurnRecord,
  links: TurnRowLinks | undefined,
  titleCap: number,
  signal?: TruncationSignal,
): string[] {
  const isUndone = turn.status === "undone";
  const flag = links?.isCorrector ? "⚑ " : "";
  const statusPrefix = isUndone ? "⨯ " : "";
  const glyph = typeEmoji(turn.type);
  const label = sanitizeTimelineField(
    truncateText(resolveTurnRowLabel(turn), { limit: titleCap, signal }),
  );
  const titleText = isUndone ? `~~${label}~~` : label;
  const stamp = `${formatLocalMonthDay(turn.createdAtEpoch)} ${formatLocalTime(turn.createdAtEpoch)}`;
  const address = renderTurnAddress(turn.promptNumber, turn.sessionId, false);
  const lines = [
    `${DIRECT_TURN_INDENT}${flag}${statusPrefix}${address} ${stamp} ${glyph} ${titleText}`.trimEnd(),
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

/** `↳` antecedents plus the self-corrector fact for one turn (ticket 05). */
interface TurnRowLinks {
  antecedents: string[];
  isCorrector: boolean;
}

/**
 * `↳` addresses AND the self-corrector flag (⚑) for a SET of turns, off the
 * turn→turn edge table. Every outgoing edge counts toward `antecedents`:
 * an antecedent is a turn this row was built on, whatever relation the writer
 * named — the arrow is an index, not a claim about the relation (spec: "箭头
 * 标记是纯地址索引"). Deduplicated by cited turn, ordered by (session, prompt)
 * so a row's antecedent list is stable across renders. `isCorrector` is the
 * SAME predicate `RANK_FACT_COLUMNS`' `isCorrector` uses (an outgoing
 * `supersedes` edge) — a `RankedSegmentMember`-backed row reads it straight off
 * the member instead (already paid for), but the plain `S<n>` turns view (no
 * segment, no `RankedSegmentMember`) has no other way to learn it.
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
    result.set(turn.turnId, { antecedents: [], isCorrector: false });
  }
  if (turns.length === 0) {
    return result;
  }

  const citingIds = [...result.keys()];
  const placeholders = citingIds.map(() => "?").join(",");
  const edges = db
    .query<{ citingId: number; citedId: number; relation: string | null }, number[]>(
      // Law 8 (indexes-rescope spec): a deleted or dormant turn is not a node,
      // so it may not appear as a `↳` antecedent either — the index row is the
      // graph's most visible face. Filtered at BOTH ends here, at the source:
      // the cited lookup below then reads only ids this filter already passed.
      `SELECT DISTINCT e.citing_id AS citingId, e.cited_id AS citedId, e.relation AS relation
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

  for (const edge of edges) {
    if (edge.relation === "supersedes") {
      result.get(edge.citingId)!.isCorrector = true;
    }
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
  // of the cap's slots on one address. The relation detail is NOT dropped: the
  // ⚑ corrector test above still runs over every row, so a `supersedes`
  // alongside another relation on the same pair still raises the flag.
  //
  // Edge-read-surface spec, ticket 01: each pair entry additionally collects
  // the DISTINCT relation words its rows carry (a bare, relation-NULL row
  // contributes none), so the `↳` line can name them — `T<n>(word,word2)`
  // when the pair has words, plain `T<n>` for a pair whose only row is bare
  // (nothing to name).
  const byCiter = new Map<
    number,
    Array<{ sessionId: number; promptNumber: number; words: Set<string> }>
  >();
  const pairEntries = new Map<
    string,
    { sessionId: number; promptNumber: number; words: Set<string> }
  >();
  for (const edge of edges) {
    const cited = citedById.get(edge.citedId);
    if (!cited || !result.has(edge.citingId)) {
      continue;
    }
    const pair = `${edge.citingId}>${edge.citedId}`;
    let entry = pairEntries.get(pair);
    if (!entry) {
      entry = { sessionId: cited.sessionId, promptNumber: cited.promptNumber, words: new Set() };
      pairEntries.set(pair, entry);
      const bucket = byCiter.get(edge.citingId) ?? [];
      bucket.push(entry);
      byCiter.set(edge.citingId, bucket);
    }
    if (edge.relation !== null) {
      entry.words.add(edge.relation);
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
      return formatAntecedentAddress(address, [...entry.words].sort());
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
 * the rank-facts query at all — `segment-rank.ts`'s own `isRolledBack` is a
 * DIFFERENT, edge-derived fact (an inbound `supersedes` edge — see its own
 * doc comment), not the rewind column — so this reads it in one small
 * batched query instead of reaching into that module.
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
  /** Non-excluded candidates the pageSize (election budget) cap could not admit. */
  demotedCount: number;
}

/**
 * The segment-view milestone selection (milestone-election spec, ticket 03).
 * `pageSize` is BOTH the election's own budget (`electMilestones`'s tier-③
 * two-stage-fill boundary) and the hard admission cut. R1 #5 (pre-release
 * repair): `pageSize` is clamped to `DEFAULT_TIMELINE_PAGE_SIZE` here, the
 * same cap `buildTimelineView`'s own S-view call site applies to
 * `selectMilestoneTurns` — the earlier claim that "every caller already
 * passes a bounded `pageSize`" did not hold (the standalone `E<n>` route
 * forwards `input.pageSize` straight through, unclamped, so an explicit
 * `pageSize` above the default over-admitted).
 */
export function selectSegmentMilestonesByEdgeSignals(
  db: Database,
  members: readonly RankedSegmentMember[],
  pageSize: number,
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

  const admissionCap = Math.min(pageSize, DEFAULT_TIMELINE_PAGE_SIZE);
  const memberIds = new Set(liveMembers.map((member) => member.turnId));
  const laneEdges = getRelationEdgesAmongTurns(db, [...memberIds]);
  const electionTurns: MilestoneTurnInput[] = liveMembers.map((member) => ({
    id: member.turnId,
    type: member.type,
    order: [member.sessionId, member.promptNumber] as const,
    createdAtEpoch: member.createdAtEpoch,
  }));
  // R1 #1/#7 (pre-release repair): the same two DB-backed facts the S-view
  // call site supplies — see `fetchExternalElectionTurns`'s own doc comment.
  const externalElectionTurns = fetchExternalElectionTurns(db, laneEdges, memberIds);
  const rolledBackCiterIds = getRolledBackCiterIds(db, [...memberIds]);
  const { candidates } = electMilestones(
    [...electionTurns, ...externalElectionTurns],
    laneEdges,
    admissionCap,
    rolledBackCiterIds,
  );
  // The correctness guarantee (not an optimization) — see the identical
  // filter in `selectMilestoneTurns`.
  const windowCandidates = candidates.filter((candidate) => memberIds.has(candidate.id));
  const admittedList = windowCandidates.slice(0, Math.max(0, admissionCap));
  const admittedIds = new Set(admittedList.map((candidate) => candidate.id));

  const chronologicalOrdinals = new Map(liveMembers.map((member, index) => [member.turnId, index + 1]));
  const keptMembers = liveMembers.filter((member) => admittedIds.has(member.turnId));
  // Chronological (event) display order (spec step 5) — matches this
  // interface's own `kept` doc comment, unchanged by the election rewrite.
  const orderedKeptMembers = [...keptMembers].sort(
    (left, right) => chronologicalOrdinals.get(left.turnId)! - chronologicalOrdinals.get(right.turnId)!,
  );
  const memberById = new Map(liveMembers.map((member) => [member.turnId, member] as const));
  const citedByTurn = buildElectedCitations(laneEdges, admittedIds);
  const userPrompts = fetchUserPrompts(db, orderedKeptMembers.map((member) => member.turnId));
  const sessionTitles = new Map<number, string | null>();
  const kept: SegmentMilestoneRow[] = orderedKeptMembers.map((member) => {
    if (!sessionTitles.has(member.sessionId)) {
      sessionTitles.set(member.sessionId, getSession(db, member.sessionId)?.title ?? null);
    }
    // Pre-capped at selection time (unlike the S-view's `KeptMilestone.antecedents`):
    // a segment row carries no per-unit token-degradation ladder to fold
    // further (`renderEraMilestoneLines`'s own doc comment), so this is the
    // one and only place the `+N` fold happens.
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
      return formatAntecedentAddress(address, citedBucket!.get(id)!);
    });
    const folded = citedIds.length - shown.length;
    return {
      member,
      ordinal: chronologicalOrdinals.get(member.turnId)!,
      antecedents: folded > 0 ? [...shown, `+${folded}`] : shown,
      sessionTitle: sessionTitles.get(member.sessionId) ?? null,
      userPrompt: userPrompts.get(member.turnId) ?? null,
    };
  });

  return { kept, demotedCount: windowCandidates.length - kept.length };
}

/**
 * The milestone row (spec 金样例): `[T821] 08-17 18:19 ⚖️ title` — the
 * bracketed SESSION-PROMPT address (not the segment ordinal: `S<n>/T<m>` is
 * the only citation form, and the transition line above supplies the `S`
 * half), a per-row date and time, the type glyph, the title. No prompt
 * excerpt, no `G` value, no tier label. `⚑` survives as the one flag this
 * format keeps: a turn that is itself a corrector (an outgoing `supersedes`
 * edge), so a reader scanning the skeleton can still see where a reversal
 * happened without the row spending a column on it.
 */
function renderSegmentMilestoneRow(
  row: SegmentMilestoneRow,
  titleCap: number,
  includeSessionPrefix: boolean,
  signal?: TruncationSignal,
): string {
  const { member } = row;
  const flag = member.isCorrector ? "⚑ " : "";
  const glyph = typeEmoji(member.type);
  const title = sanitizeTimelineField(
    truncateText(titleOrPromptLabel(member.title, row.userPrompt), { limit: titleCap, signal }),
  );
  const stamp = `${formatLocalMonthDay(member.createdAtEpoch)} ${formatLocalTime(member.createdAtEpoch)}`;
  const address = renderTurnAddress(member.promptNumber, member.sessionId, includeSessionPrefix);
  return `${TIMELINE_TURN_INDENT}${flag}${address} ${stamp} ${glyph} ${title}`.trimEnd();
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
  // needed here, and `options.pageBudget` plays no role any more (see its
  // doc comment). Empty whenever there is no era cutoff or no admitted era
  // row, which is what keeps a session with no segmented era turns
  // byte-identical to the pre-nesting renderer (spec D6/D9).
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

  // Milestones. A budget is measured against the WHOLE assembled output, so the
  // header and signal blocks count against it too; without one (every MCP view)
  // the body renders in full and pagination is the only sizing mechanism.
  //
  // The response-level legend (spec D4, `appendNavigationLegend`) is appended
  // to `assemble`'s result rather than folded inside it: whether it is needed
  // is a fact about the body (did folding a day group hide a turn, OR did any
  // field truncate), so `assemble` stays a pure function of `bodyLines` and the
  // legend is layered on top by every caller that also needs it counted — see
  // the budgeted path below, where the fitter's `measure` does exactly that.
  if (options.tokenBudget === undefined) {
    const body = renderMilestoneBody(view, titleCap, signal);
    return appendNavigationLegend(assemble(body.lines), {
      truncated: body.hiddenTurns || signal.truncated,
    });
  }

  // The spine is the era's default view, so it is served first. Ticket 05:
  // each segment's nested milestone content is already self-bounded to
  // `pageBudget` above, so there is no row-level degradation left to run here
  // — the only thing an even tighter outer `tokenBudget` can still do is shed
  // whole segment/orphan LINES, which `shedSpineToBudget` already does (sheds
  // orphans first — the safety net, not the structure — then the oldest
  // segments), unchanged since before this ticket.
  if (spineLines.length > 0) {
    shedSpineToBudget({
      view,
      titleCap,
      tokenBudget: options.tokenBudget,
      apply: (candidate) => {
        spineLines = candidate;
      },
      measure: () => estimateDiaryTokens(assemble([])),
      milestoneLinesBySegmentId: eraMilestoneLines,
    });
  }

  // Everything outside the body is fixed, so its weight is measured once and the
  // fitter only has to price what it changes. The fitter's `measure` folds the
  // legend into the expensive check (not the cheap tenths pre-check) so the
  // candidate it settles on is the one whose ASSEMBLED-PLUS-LEGEND size is what
  // actually respects `tokenBudget`.
  const body = fitMilestoneBodyToBudget(
    view,
    titleCap,
    options.tokenBudget,
    textWeightTenths(assemble([])),
    (bodyLines, hiddenTurns) =>
      estimateDiaryTokens(
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
  pageSize?: number;
  /** See `TimelineInput.pageBudget`. Governs the turn view's per-page token ceiling. Ticket 09: no longer the milestones view's admission rule — see `pageSize` above and `selectSegmentMilestonesByEdgeSignals`. */
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
    // Ticket 09: `pageSize` (item count), not `pageBudget` (tokens), drives
    // this view's importance selection — the property the spec states as
    // "turn 视图与里程碑视图仅差 pageSize 驱动的重要性选择": both views are
    // governed by the SAME parameter, differing only in whether it merely
    // paginates (turns view above) or ALSO ranks (milestones view here).
    const milestonePageSize = Math.max(1, input.pageSize ?? DEFAULT_TIMELINE_PAGE_SIZE);
    const selection = selectSegmentMilestonesByEdgeSignals(
      db,
      members,
      milestonePageSize,
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
// `E<n>/L*` / `E<n>/L<n>` addressing (ticket 07, lane-declaration spec D8):
// a segment's declared lanes, each rendered as one header line plus one
// representative chain. `E<n>/L*` lists every declared lane, newest-first;
// `E<n>/L<n>` renders one, at the SAME 1-based ordinal the list itself would
// show it at — a navigation handle, not a stable id or a citation (a lane's
// own member turns, by contrast, are ALWAYS cited by their `S<session>/T<prompt>`
// home — one-address-grammar spec, ticket 10).
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

/**
 * D8's own chain domain — originally the five relation words the ticket's
 * own tie-break order names (`extends`/`narrows` > `indexes` > `consume` >
 * `override`). Lane-declaration ticket 12 (P1-7) widens this to ALL EIGHT: a
 * tagged `grounds`/`verifies`/`refutes` edge is now an ordinary hop, exactly
 * like the five structural/state words already here. This is safe without
 * the tag-vs-untagged split reports 2/3's shared graph needs
 * (`lane-checker.ts`'s `unionsLaneComponentGraph`): `chainEdges` below
 * filters `Lane.taggedEdges`, which is ALREADY scoped to THIS lane's own tag
 * (`lane-checker.ts`'s module header, "Report domains") — there is no
 * untagged-testimony leak to guard against on an already tag-scoped list.
 * Arrow choice (ticket 12, pinned by test): a tagged cross-phase hop renders
 * the same ordinary "->" every non-`indexes` relation already does
 * (`arrowIn` below) — `indexes` alone keeps its "=>" declaration glyph; no
 * new glyph for the three newly-admitted words.
 */
const LANE_CHAIN_RELATIONS: ReadonlySet<string> = new Set(EDGE_RELATIONS);

/** D8's own tie-break order — ONLY consulted between two branches of otherwise EQUAL node coverage (see `selectLaneChainPath`). `grounds`/`verifies`/`refutes` (ticket 12) fall through to the same defensive rank 4 as any relation this tie-break never ranked explicitly — lowest priority, so a same-phase structural/state hop wins over a cross-phase one whenever coverage ties. The fallback is otherwise unreachable now that `LANE_CHAIN_RELATIONS` spans the whole eight-word vocabulary — only a malformed stock relation could still reach it. */
function laneChainRelationRank(relation: string): number {
  if (relation === "extends" || relation === "narrows") return 0;
  if (relation === "indexes") return 1;
  if (relation === "consume") return 2;
  if (relation === "override") return 3;
  return 4;
}

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
      if (existing === undefined || laneChainRelationRank(child.relation) < laneChainRelationRank(existing)) {
        byTarget.set(child.citedId, child.relation);
      }
    }
    let bestTarget: number | null = null;
    let bestTargetCoverage = -1;
    let bestTargetRank = Number.POSITIVE_INFINITY;
    let bestTargetOrder: LaneOrderLookup = { order: [0, 0] };
    for (const [targetId, relation] of byTarget) {
      if (seen.has(targetId)) continue; // cycle guard on the CHOSEN path itself
      const targetCoverage = bestCoverage(targetId);
      const rank = laneChainRelationRank(relation);
      const order = laneMemberOrder(targetId, turnsById);
      const better =
        bestTarget === null ||
        targetCoverage > bestTargetCoverage ||
        (targetCoverage === bestTargetCoverage &&
          (rank < bestTargetRank ||
            (rank === bestTargetRank && compareOrderKeyAcrossSessions(order, bestTargetOrder) > 0)));
      if (better) {
        bestTarget = targetId;
        bestTargetCoverage = targetCoverage;
        bestTargetRank = rank;
        bestTargetOrder = order;
      }
    }
    if (bestTarget === null) {
      break;
    }
    current = bestTarget;
    relationIn = byTarget.get(bestTarget)!;
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

export interface SegmentLaneChainNode {
  turnId: number;
  /**
   * One-address-grammar spec (ticket 10): the turn's own `S<session>/T<prompt>`
   * home. Retires this chain's earlier locator scheme — bare within the
   * viewed segment, `E<seg>/` for a turn owned by ANOTHER segment, `S<session>/`
   * for a homeless one, with a trailing GLOBAL turn id — since a segment is
   * no longer part of any turn's address, only its scope. `renderLaneChainLine`
   * decides whether THIS node's own render needs the full `S<session>/T<prompt>`
   * form or the bare `T<prompt>` one (first node in the chain, or a session
   * change from the previous node, print full; otherwise bare).
   */
  sessionId: number;
  promptNumber: number;
  /** `null` on the chain's first (newest) node — no incoming edge is rendered for it. `"=>"` iff the edge INTO this node is a tagged `indexes` edge (D8); `"->"` otherwise. */
  arrowIn: "=>" | "->" | null;
  isTerminus: boolean;
}

export interface SegmentLaneView {
  key: LaneKey;
  /** 1-based, newest-first — the `[L<n>]` the header renders, stable across the list and a single-lane (`E<n>/L<n>`) render of the SAME lane. */
  laneIndex: number;
  /** The lane's newest member's `createdAtEpoch`; a declared-but-memberless lane falls back to its own `lanes.created_at_epoch`. */
  headerEpoch: number;
  headerEmoji: string;
  /** The lane's total member count — the chain's own trailing `(N)`, ALWAYS this number, whether or not the shown nodes were truncated. */
  memberCount: number;
  /** The selected path's nodes, sliced to `DEFAULT_LANE_CHAIN_ITEM_BUDGET`. */
  nodes: SegmentLaneChainNode[];
  /** `true` iff the SELECTED path itself had more nodes than the item budget could show — the ONLY condition that renders the `-> ...` truncation marker ahead of `(N)`. A fork whose branch was never followed appends nothing of its own (D8) — `(N)` alone (always present) already signals that the chain does not necessarily cover the whole lane. */
  truncated: boolean;
}

export interface SegmentLaneListView {
  segment: SegmentRecord;
  /** Already ordered/sliced per the request — every declared lane (newest-first) for `/L*`, or the one requested ordinal for `/L<n>`. */
  lanes: SegmentLaneView[];
  totalDeclaredCount: number;
}

function buildSegmentLaneChain(
  laneRecord: LaneRecord,
  interpretation: LaneInterpretation,
  turnsById: ReadonlyMap<number, LaneCheckerTurnInput>,
  itemBudget: number,
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
      nodes: [],
      truncated: false,
    };
  }

  const memberIds = lane.members.map((member) => member.id);
  const newestId = laneNewestMemberId(memberIds, turnsById) ?? memberIds[memberIds.length - 1]!;
  const headerEpoch = turnsById.get(newestId)?.createdAtEpoch ?? laneRecord.createdAtEpoch;
  const headerEmoji = laneModalTypeEmoji(memberIds, turnsById);

  const chainEdges = lane.taggedEdges.filter((edge) => LANE_CHAIN_RELATIONS.has(edge.relation));
  const edgesByCitingId = new Map<number, Array<{ citedId: number; relation: string }>>();
  for (const edge of chainEdges) {
    const bucket = edgesByCitingId.get(edge.citingId) ?? [];
    bucket.push({ citedId: edge.citedId, relation: edge.relation });
    edgesByCitingId.set(edge.citingId, bucket);
  }

  const fullPath = selectLaneChainPath(newestId, edgesByCitingId, turnsById);
  const truncated = fullPath.length > itemBudget;
  const shown = truncated ? fullPath.slice(0, itemBudget) : fullPath;

  const nodes: SegmentLaneChainNode[] = shown.map((step) => {
    // `order` is `[sessionId, promptNumber]` — see `db/lane-checker-load.ts`'s
    // `turnOrderKey`. A step this projection never loaded (defensive only —
    // see `laneMemberOrder`'s own comment on the identical fallback) reads as
    // session 0, promptNumber = its own global turn id — never fabricated as
    // a real session.
    const order = turnsById.get(step.turnId)?.order ?? [0, step.turnId];
    return {
      turnId: step.turnId,
      sessionId: order[0],
      promptNumber: order[1],
      arrowIn: step.relationIn === null ? null : step.relationIn === "indexes" ? "=>" : "->",
      isTerminus: lane.declaration.terminus !== null && step.turnId === lane.declaration.terminus,
    };
  });

  return {
    key,
    headerEpoch,
    headerEmoji,
    memberCount: lane.members.length,
    nodes,
    truncated,
  };
}

export function buildSegmentLaneListView(
  db: Database,
  segmentId: number,
  laneIndex: number | "all",
  itemBudget: number = DEFAULT_LANE_CHAIN_ITEM_BUDGET,
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
    view: buildSegmentLaneChain(laneRecord, interpretation, turnsById, itemBudget),
  }));
  // Newest-first (D8); a declared-but-memberless lane's fallback epoch (its
  // OWN declaration time) sorts it deterministically among the rest, tag
  // ascending breaking any exact-epoch tie.
  built.sort((a, b) => {
    if (a.view.headerEpoch !== b.view.headerEpoch) {
      return b.view.headerEpoch - a.view.headerEpoch;
    }
    return a.record.tag.localeCompare(b.record.tag);
  });
  const ordered: SegmentLaneView[] = built.map((entry, index) => ({
    ...entry.view,
    laneIndex: index + 1,
  }));

  if (laneIndex === "all") {
    return { segment, lanes: ordered, totalDeclaredCount: ordered.length };
  }

  if (laneIndex < 1 || laneIndex > ordered.length) {
    throw new Error(
      `timeline: lane ordinal L${laneIndex} out of range for E${segmentId} (${ordered.length} declared lane(s))`,
    );
  }
  return { segment, lanes: [ordered[laneIndex - 1]!], totalDeclaredCount: ordered.length };
}

function renderLaneHeaderLine(lane: SegmentLaneView): string {
  const time = `${formatLocalMonthDay(lane.headerEpoch)} ${formatLocalTime(lane.headerEpoch)}`;
  return `[L${lane.laneIndex}] ${time} ${lane.headerEmoji} ${sanitizeTimelineField(lane.key.tag)}`;
}

/**
 * One-address-grammar spec (ticket 10): every node renders `S<session>/T<prompt>`,
 * whole — but only for the FIRST node in the chain and again whenever the
 * SESSION changes from the previous node; every other node renders the bare
 * `T<prompt>`. That is what keeps a long same-session chain affordable while
 * a chain that crosses sessions still reads unambiguously at every hop.
 */
function renderLaneChainLine(lane: SegmentLaneView): string {
  if (lane.nodes.length === 0) {
    return `${RENDER_INDENT_STEP}(0)`;
  }
  let body = "";
  let runSessionId: number | null = null;
  lane.nodes.forEach((node, index) => {
    const address =
      index === 0 || node.sessionId !== runSessionId
        ? `S${node.sessionId}/T${node.promptNumber}`
        : `T${node.promptNumber}`;
    runSessionId = node.sessionId;
    const label = `${node.isTerminus ? "◎" : ""}${address}`;
    if (index === 0) {
      body = label;
      return;
    }
    body += `${node.arrowIn === "=>" ? " => " : " -> "}${label}`;
  });
  const tail = lane.truncated ? ` -> ...(${lane.memberCount})` : `(${lane.memberCount})`;
  return `${RENDER_INDENT_STEP}${body}${tail}`;
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
    lines.push(renderLaneChainLine(lane));
    truncatedAny = truncatedAny || lane.truncated;
  }
  return appendNavigationLegend(lines.join("\n"), { truncated: truncatedAny });
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
    if (laneRoute !== null) {
      const view = buildSegmentLaneListView(db, laneRoute.segmentId, laneRoute.laneIndex);
      // Write gate (ticket 01): the segment itself, plus every turn that
      // actually appears on a rendered chain (across every lane shown).
      const shownTurnIds = new Set<number>();
      for (const lane of view.lanes) {
        for (const node of lane.nodes) {
          shownTurnIds.add(node.turnId);
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
        `timeline error: timeline renders a whole segment — drop the trailing selector and pass "E<n>" ` +
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
    return `timeline error: ${message}`;
  }
}
