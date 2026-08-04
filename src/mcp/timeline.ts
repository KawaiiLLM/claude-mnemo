import type { Database } from "bun:sqlite";
import {
  getSessionEffectiveCitations,
  parseInlineCitations,
  type EffectiveCitations,
} from "../db/citations";
import { getSession, type SessionRecord } from "../db/sessions";
import { getFirstTurn, getTurnById, getTurnsForSession, type TurnRecord } from "../db/turns";
import { estimateDiaryTokens } from "../diary/domain";
import { resolveSessionTranscriptPath } from "../shared/paths";
import { isKnownSystemInjectedContent } from "../shared/transcript-parser";
import { isTaskCausalityEra } from "../task-causality-era";

export interface TimelineInput {
  id: string;
  page?: number;
  pageSize?: number;
  view?: TimelineViewKind;
  /**
   * Milestones only: show the trailing `pageSize` kept milestones (the most
   * recent end) instead of front-aligned page 1. Selection still runs over the
   * full window; only the displayed slice changes. Used by the SessionStart
   * context render so compact/clear surface the recent milestone arc.
   */
  milestoneTail?: boolean;
}

export type TimelineViewKind = "turns" | "milestones" | "phases";

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
  /**
   * Every ↳ antecedent the kept rows pull in (spec §C ⑤), for the whole selection
   * rather than the current page — a renderer places one under its
   * `citedByPromptNumber` row when that row is on the page. Empty outside the
   * milestones view.
   */
  milestonePulled: PulledAntecedent[];
  /**
   * effGrade per turn DB id (spec §C truth table, after victim demotion and
   * corrector promotion), so every view can print the grade column. Turns with
   * no main-row candidacy at all (compact markers) are absent.
   */
  turnEffGrades: ReadonlyMap<number, number>;
  milestoneDayGroups: MilestoneDayGroup[];
  pagedPhases: Phase[];
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
}

export interface RenderTimelineOptions {
  promptCap?: number;
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
export const PROMPT_COLUMN_CAP = 100;
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
const MILESTONE_DESC_INDENT = "        ";
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
  type: string | null;
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

export interface TypesDistribution {
  bugfix: number;
  feature: number;
  refactor: number;
  change: number;
  discovery: number;
  decision: number;
  compact: number;
  pending: number;
}

type TypedTurnKind = Exclude<keyof TypesDistribution, "pending">;

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
  /** effGrade + tie-break (spec §C). Ordering only; never crosses a grade tier. */
  score: number;
  /** The truth-table grade AFTER victim demotion / corrector promotion. */
  effGrade: number;
  /** Kept for a structural reason, so a budget may degrade it but never drop it. */
  alwaysKeep: boolean;
  /** Admitted on grade alone (effGrade ≥ 3), as opposed to structurally. */
  spine: boolean;
  marker: MilestoneMarker;
  /**
   * Prompt numbers of the turns that superseded this one, ascending. Present
   * only on a kept row that is itself a victim (a victim can still be kept as a
   * window endpoint); the renderer turns it into the `→被T<n>推翻` back-link.
   */
  supersededBy?: number[];
}

/**
 * A turn pulled in under a kept main row because that row cites it (spec §C ⑤):
 * effGrade ≤ 2 — including `status = 'skipped'` rows, which have no main-row
 * candidacy at all — rendered as an indented `↳` line beneath its citer.
 */
export interface PulledAntecedent {
  turn: TurnRecord;
  effGrade: number;
  /**
   * Prompt number of the main row this antecedent renders under: the EARLIEST
   * citer among the kept rows, so a shared antecedent appears exactly once.
   */
  citedByPromptNumber: number;
  /**
   * EVERY kept main row that cites this antecedent, ascending — `citedByPromptNumber`
   * is just the first. The renderer needs the full list because dropping a unit
   * under a token budget must re-home that unit's shared antecedents onto the
   * earliest still-rendered citer (spec §D); with only the earliest citer stored,
   * an antecedent cited three times would vanish the moment its first citer went.
   */
  citerPromptNumbers: number[];
  /**
   * Render-ready one-line label: the stored title when there is one, else a
   * ≤`MILESTONE_PULLED_LABEL_CAP`-char prefix of the user prompt. Existing
   * skipped rows carry no title at all (extraction only starts titling them in
   * ticket 05), and a pulled row that renders as `(untitled)` is dead weight.
   */
  label: string;
  /** Prompt numbers of the turns that superseded this one, ascending; empty when it is not a victim. */
  supersededBy: number[];
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
   * The main rows, in prompt order: spine (effGrade ≥ 3) ∪ always-keep. There is
   * no budget here — cutting is the unified renderer's job (spec §D / ticket 03),
   * which reads `ranked` for its degradation order.
   */
  kept: KeptMilestone[];
  /**
   * The scored pool, best first: every turn clearing the pool gate
   * (effGrade ≥ 2) plus the always-keep rows. A superset of `kept` — the G2 band
   * is scored and ordered but not admitted to the spine. Shares object identity
   * with `kept` for the rows in both.
   */
  ranked: KeptMilestone[];
  /** ↳ antecedents pulled in by the kept rows, in citer order then cite order. */
  pulled: PulledAntecedent[];
  overflowByDay: OverflowHint[];
  /**
   * effGrade for EVERY main-row candidate in the window, keyed by DB id — the
   * post-demotion/post-promotion value, not the stored grade. The turns view
   * renders a grade column off this, so its `G` cell agrees with the arc view
   * instead of re-deriving a raw grade that a supersession has already voided.
   */
  effGradeByTurnId: Map<number, number>;
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

export const TYPE_EMOJI_MAP: Record<string, string> = {
  bugfix: "🔴",
  feature: "🟣",
  refactor: "🔄",
  change: "✅",
  discovery: "🔵",
  decision: "⚖️",
  compact: "⏸",
};

export const PENDING_EMOJI = "⏳";
const MISSING_LINE_ANCHOR = "—";
const MISSING_GRADE_CELL = "—";

/** Turn-table column set. `G` is the grade column the arc view also renders. */
export const TURN_TABLE_HEADER =
  "T# | line | time | gap | stats | G | prompt → title";

function typeEmoji(type: string | null): string {
  if (type === null) return PENDING_EMOJI;
  return TYPE_EMOJI_MAP[type] ?? "•";
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

  const closed = rangeValue.match(/^(\d+)\.\.(\d+)$/);
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
      `timeline does not accept single turn forms; use recall(id='S${sessionId}/T${rangeValue}', depth='expanded') instead`,
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

export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars)}…`;
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    const seconds = totalSeconds % 60;
    return seconds === 0 ? `${totalMinutes}m` : `${totalMinutes}m${seconds}s`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

export function formatGap(
  currentEpochSeconds: number,
  previousEpochSeconds: number | null,
): string {
  if (previousEpochSeconds === null) {
    return "(start)";
  }

  return `+${formatDuration((currentEpochSeconds - previousEpochSeconds) * 1000)}`;
}

export function formatLocalTime(epochSeconds: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(epochSeconds * 1000));
}

export function formatLocalDate(epochSeconds: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(epochSeconds * 1000));
}

function formatLocalWeekday(epochSeconds: number): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
  }).format(new Date(epochSeconds * 1000));
}

function formatLocalDateWithWeekday(epochSeconds: number): string {
  return `${formatLocalDate(epochSeconds)} ${formatLocalWeekday(epochSeconds)}`;
}

function formatLocalMonthDay(epochSeconds: number): string {
  const [year, month, day] = formatLocalDate(epochSeconds).split("-");
  void year;
  return `${month}-${day}`;
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
    turn.type === "decision" &&
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

/**
 * Legacy type→grade map. This is the ONLY surviving use of the old type base
 * score table: it exists solely inside the pre-era effGrade fallback, because a
 * turn created before the task-causality cutoff carries a grade written under
 * the old "significance" semantics that must not be read as a task-causality
 * grade. Post-era turns never touch it.
 */
const MILESTONE_LEGACY_TYPE_GRADE: Readonly<Record<string, number>> = {
  decision: 3,
  feature: 2,
  refactor: 2,
  bugfix: 2,
  change: 1,
  discovery: 1,
};

/**
 * A legacy effGrade is capped here and therefore can never be 4 — G4 is the
 * always-keep anchor tier, and a pre-era turn must never claim it on the
 * strength of a type map alone.
 */
export const MILESTONE_LEGACY_GRADE_CAP = 3;

/** Spine admission (spec §C ④). */
export const MILESTONE_SPINE_MIN_EFF_GRADE = 3;
/**
 * Scored-pool gate (spec §C). On effGrade, NOT on the composite score: the
 * bonuses used to be able to lift a G2 turn past a G3 one, which is exactly the
 * inversion the redesign removes. Nothing a turn's content can do admits it to
 * a tier its grade did not earn.
 */
export const MILESTONE_POOL_MIN_EFF_GRADE = 2;
/** Pull-through ceiling (spec §C ⑤): antecedents are what the spine outranks. */
export const MILESTONE_PULL_MAX_EFF_GRADE = 2;

const MILESTONE_TIE_CITED_WEIGHT = 0.25;
const MILESTONE_TIE_CITED_CAP = 2;
const MILESTONE_TIE_INSIGHT_WEIGHT = 0.25;
const MILESTONE_TIE_PURE_SPEC_WEIGHT = 0.15;
/** Ceiling on the whole tie-break, so a score can never cross a grade tier. */
const MILESTONE_TIE_BREAK_MAX = 0.9;

const MILESTONE_PURE_SPEC_RE = /^docs\/(?:plans|specs|superpowers)\/.*\.md$/;
const MILESTONE_VERSION_RE = /\b0\.\d+\.\d+\b/g;

/** Character budget for the prompt-prefix pseudo-title of an untitled ↳ row. */
export const MILESTONE_PULLED_LABEL_CAP = 60;

/**
 * The effGrade truth table (spec §C).
 *
 *   - era turn, graded    → that grade (0-4)
 *   - era turn, ungraded  → 0, i.e. out of the pool until the settle pass grades it
 *   - pre-era (legacy)    → type map, zeroed for an artifact type that touched no
 *                           file, +1 for an insight, capped at 3
 *
 * Both halves are era-gated. The half-gate that shipped before this (base score
 * ungated, content score gated) let 761 stored legacy grades feed the base score
 * with pre-era semantics.
 */
export function milestoneEffGrade(
  turn: TurnRecord,
  taskCausalityEraCutoffEpoch?: number,
): number {
  if (isTaskCausalityEra(turn.createdAtEpoch, taskCausalityEraCutoffEpoch)) {
    const grade = turn.significanceGrade;
    if (grade === null || grade === undefined) {
      return 0;
    }
    return Math.max(0, Math.min(4, grade));
  }

  return legacyEffGrade(turn);
}

function legacyEffGrade(turn: TurnRecord): number {
  let grade = MILESTONE_LEGACY_TYPE_GRADE[turn.type ?? ""] ?? 0;
  if (
    (turn.type === "feature" || turn.type === "refactor" || turn.type === "change") &&
    turn.filesModified.length === 0
  ) {
    grade = 0;
  }
  if (hasMilestoneInsight(turn)) {
    grade += 1;
  }
  return Math.min(grade, MILESTONE_LEGACY_GRADE_CAP);
}

function hasMilestoneInsight(turn: TurnRecord): boolean {
  return typeof turn.insight === "string" && turn.insight.trim() !== "" && turn.insight !== "[]";
}

function isPureSpecTurn(turn: TurnRecord): boolean {
  return (
    turn.filesModified.length > 0 &&
    turn.filesModified.every((path) => MILESTONE_PURE_SPEC_RE.test(path))
  );
}

/**
 * Sub-unit ordering signal, bounded by `MILESTONE_TIE_BREAK_MAX` (< 1) so that
 * `effGrade + tieBreak` sorts strictly within a grade tier and never across one.
 * `citedBy` is the session-local DISTINCT-citer in-degree.
 */
export function milestoneTieBreak(turn: TurnRecord, citedBy = 0): number {
  const raw =
    MILESTONE_TIE_CITED_WEIGHT * Math.min(Math.max(citedBy, 0), MILESTONE_TIE_CITED_CAP) +
    (hasMilestoneInsight(turn) ? MILESTONE_TIE_INSIGHT_WEIGHT : 0) +
    (isPureSpecTurn(turn) ? MILESTONE_TIE_PURE_SPEC_WEIGHT : 0);
  return Math.min(raw, MILESTONE_TIE_BREAK_MAX);
}

/**
 * The in-memory stand-in for `getSessionEffectiveCitations` (spec §B), for
 * callers that hold turn records but no `Database` — the pure-function selection
 * seam the tests use. It reproduces the DB reader's contract exactly for a
 * session with no edge rows: `cites_recorded = 1` means the extractor spoke and
 * an empty edge set is authoritative; `0` falls back to the inline grammar,
 * dropping dangling, cross-session and self citations.
 *
 * Production always passes the real map, so structured edges are never lost to
 * this fallback.
 */
function inlineCitationFallback(
  turns: readonly TurnRecord[],
): Map<number, EffectiveCitations> {
  const sessionTurnIds = new Set(turns.map((turn) => turn.id));
  const effective = new Map<number, EffectiveCitations>();

  for (const turn of turns) {
    if (turn.citesRecorded) {
      effective.set(turn.id, { source: "structured", citedTurnIds: [], edges: [] });
      continue;
    }
    effective.set(turn.id, {
      source: "inline",
      citedTurnIds: parseInlineCitations(turn.content).filter(
        (id) => id !== turn.id && sessionTurnIds.has(id),
      ),
      edges: [],
    });
  }

  return effective;
}

/**
 * Session-local DISTINCT-citer in-degree, derived from the citation map the
 * caller already holds. Same result as `getSessionCitationInDegree`, without a
 * second pass over the DB — selection reads the map once and reuses it for
 * in-degree, victim demotion and pull-through alike.
 */
function citationInDegree(
  citations: ReadonlyMap<number, EffectiveCitations>,
): Map<number, number> {
  const inDegree = new Map<number, number>();
  for (const entry of citations.values()) {
    // citedTurnIds is de-duplicated per citer, so each citer contributes ≤ 1.
    for (const citedTurnId of entry.citedTurnIds) {
      inDegree.set(citedTurnId, (inDegree.get(citedTurnId) ?? 0) + 1);
    }
  }
  return inDegree;
}

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

export interface CorrectionGraph {
  /** DB ids of turns that supersede at least one resolvable predecessor. */
  correctors: Set<number>;
  /**
   * DB ids of superseded turns. A victim resolved from OUTSIDE the window is
   * included: it holds no main-row slot to lose, but its demoted grade still
   * decides whether pull-through revives it as a `↳` antecedent.
   */
  supersededVictims: Set<number>;
  /** Victim DB id → superseding DB ids, ascending by the superseder's prompt number. */
  supersededBy: Map<number, number[]>;
}

/**
 * Builds the supersession graph (spec §B/§C). A turn is a *corrector* when it
 * carries a `supersedes` edge to an earlier same-session turn; that turn is the
 * *victim*, which selection demotes to effGrade ≤ 1 and strips of spine
 * eligibility, and which the renderer marks with a `→被T<n>推翻` back-link.
 *
 * Victimhood comes off the EDGE, not off the victim's tags. The previous model
 * required the victim to already carry a `rolled-back` tag before any of this
 * fired, which meant a partial reversal (the common case — the corrector knows
 * what it overturned, the victim does not know it was overturned) produced
 * neither a demotion nor a back-link.
 *
 * The legacy adapter covers pre-era citers whose citations came from INLINE
 * prose, which carries no relation: for those, citing a turn that is *marked*
 * reversed (rolled-back tag or the rewind column) is read as a supersession,
 * which is precisely the old rule — an additional signal for pre-era turns only,
 * so era turns are governed by edges alone.
 *
 * BOTH gates are load-bearing. Era alone is not enough: a structured edge is
 * authoritative wherever it exists (spec §B), including on a turn created before
 * the cutoff and extracted after it. Such a turn's `builds-on` / `evidence-for`
 * edge states a relation, and that relation is not `supersedes`; reading the
 * victim's tag over it would invent a correction the extractor declined to
 * record, demoting the target and promoting a mere consumer.
 *
 * A cited victim is matched first against `turns`, then via `resolveCited` (the
 * full-session set), so a ranged view whose corrector cites a victim OUTSIDE the
 * window still promotes that corrector and still demotes that victim.
 */
export function buildCorrectionGraph(
  turns: readonly TurnRecord[],
  options: {
    citations?: ReadonlyMap<number, EffectiveCitations>;
    resolveCited?: (dbId: number) => TurnRecord | null | undefined;
    taskCausalityEraCutoffEpoch?: number;
  } = {},
): CorrectionGraph {
  const correctors = new Set<number>();
  const supersededVictims = new Set<number>();
  const supersedersByVictim = new Map<number, TurnRecord[]>();

  const byDbId = new Map<number, TurnRecord>();
  for (const turn of turns) {
    byDbId.set(turn.id, turn);
  }
  const citations = options.citations ?? inlineCitationFallback(turns);

  for (const corrector of turns) {
    const entry = citations.get(corrector.id);
    if (entry === undefined) {
      continue;
    }

    const supersededIds = new Set<number>();
    for (const edge of entry.edges) {
      if (edge.relation === "supersedes") {
        supersededIds.add(edge.citedTurnId);
      }
    }
    if (
      entry.source === "inline" &&
      !isTaskCausalityEra(corrector.createdAtEpoch, options.taskCausalityEraCutoffEpoch)
    ) {
      for (const citedTurnId of entry.citedTurnIds) {
        const cited = byDbId.get(citedTurnId) ?? options.resolveCited?.(citedTurnId);
        if (cited && milestoneMarker(cited) === "reversed") {
          supersededIds.add(citedTurnId);
        }
      }
    }

    for (const citedTurnId of supersededIds) {
      const victim = byDbId.get(citedTurnId) ?? options.resolveCited?.(citedTurnId);
      if (
        !victim ||
        victim.sessionId !== corrector.sessionId ||
        // Predecessor guard: a causal reference points backward.
        victim.promptNumber >= corrector.promptNumber
      ) {
        continue;
      }
      correctors.add(corrector.id);
      supersededVictims.add(victim.id);
      const bucket = supersedersByVictim.get(victim.id) ?? [];
      bucket.push(corrector);
      supersedersByVictim.set(victim.id, bucket);
    }
  }

  const supersededBy = new Map<number, number[]>();
  for (const [victimId, superseders] of supersedersByVictim) {
    supersededBy.set(
      victimId,
      [...superseders]
        .sort((left, right) => left.promptNumber - right.promptNumber)
        .map((turn) => turn.id),
    );
  }

  return { correctors, supersededVictims, supersededBy };
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

function formatTranscriptLineAnchor(lineNumber: number | null): string {
  return lineNumber === null ? MISSING_LINE_ANCHOR : `L${lineNumber}`;
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

    const kind: Phase["kind"] = turn.type === null ? "pending" : "typed";
    const emoji = typeEmoji(turn.type);

    if (current === null || current.kind !== kind || current.type !== turn.type) {
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
  const distribution: TypesDistribution = {
    bugfix: 0,
    feature: 0,
    refactor: 0,
    change: 0,
    discovery: 0,
    decision: 0,
    compact: 0,
    pending: 0,
  };

  for (const turn of turns) {
    if (!isTimelineLiveTurn(turn)) {
      continue;
    }

    if (turn.type === null) {
      distribution.pending += 1;
    } else if (isTypedTurnKind(turn.type)) {
      distribution[turn.type] += 1;
    }
  }

  return distribution;
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

function isTypedTurnKind(value: string): value is TypedTurnKind {
  return (
    value === "bugfix" ||
    value === "feature" ||
    value === "refactor" ||
    value === "change" ||
    value === "discovery" ||
    value === "decision" ||
    value === "compact"
  );
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
 * Grade-first milestone selection (spec §C). The six steps run in this order and
 * the order is load-bearing:
 *
 *   ① victim demotion (effGrade → ≤1, spine eligibility revoked)
 *   ② corrector promotion (effGrade → ≥3) — AFTER ①, so a corrector that was
 *     itself later overturned stays demoted rather than anchoring the arc
 *   ③ always-keep: endpoints ∪ non-victim correctors ∪ reversed-with-no-corrector
 *     ∪ era G4; `type='compact'` is in none of it and holds no kept slot
 *   ④ spine admission: effGrade ≥ 3
 *   ⑤ pull-through: effGrade ≤ 2 turns (INCLUDING skipped ones) cited by a kept
 *     row become its ↳ antecedents
 *   ⑥ budget/degradation — NOT here. Selection returns the whole eligible set
 *     plus `ranked`; the unified renderer (ticket 03) does the cutting.
 */
export function selectMilestoneTurns(view: {
  session?: SessionRecord;
  windowTurns: TurnRecord[];
  windowSignals: ShapeSignals;
  compactBoundaries: number[];
  /**
   * Full-session turns, used to resolve a citation whose target sits *outside* a
   * ranged `windowTurns` and to give pull-through the skipped rows the window
   * filter would hide. Omit for a full-window view.
   */
  sessionTurns?: TurnRecord[];
  taskCausalityEraCutoffEpoch?: number;
  /**
   * Session-local effective citations, read ONCE per selection by the caller
   * (`getSessionEffectiveCitations`) and reused here for in-degree, victim
   * derivation and pull-through. Omitted, selection falls back to the in-memory
   * inline-grammar reader — correct for legacy turns, blind to structured edges.
   */
  citations?: ReadonlyMap<number, EffectiveCitations>;
}): MilestoneSelection {
  const eraCutoff = view.taskCausalityEraCutoffEpoch;
  const universe = view.sessionTurns ?? view.windowTurns;
  // Main-row candidates: a skipped turn has no candidacy (it can still be pulled
  // in as an antecedent), and a compact marker is structural noise that the arc
  // view no longer spends a row on.
  const seq = sortTurnsForAnalysis(view.windowTurns).filter(
    (turn) => turn.status !== "skipped" && turn.type !== "compact",
  );
  if (seq.length === 0) {
    return {
      kept: [],
      ranked: [],
      pulled: [],
      overflowByDay: [],
      effGradeByTurnId: new Map(),
    };
  }

  const citations = view.citations ?? inlineCitationFallback(universe);
  const inDegree = citationInDegree(citations);
  const universeById = new Map(universe.map((turn) => [turn.id, turn]));
  const inWindowById = new Map(seq.map((turn) => [turn.id, turn]));

  const graph = buildCorrectionGraph(seq, {
    citations,
    resolveCited: (id) => universeById.get(id),
    taskCausalityEraCutoffEpoch: eraCutoff,
  });

  // ① + ②, in that order: a corrector that is itself a victim keeps the demotion.
  const effGradeOf = (turn: TurnRecord): number => {
    const raw = milestoneEffGrade(turn, eraCutoff);
    if (graph.supersededVictims.has(turn.id)) {
      return Math.min(raw, 1);
    }
    return graph.correctors.has(turn.id) ? Math.max(raw, 3) : raw;
  };

  // ③ endpoints: window first candidate + window last *titled* candidate.
  const endpoints = new Set<number>([seq[0]!.id]);
  const lastTitled = [...seq].reverse().find((t) => t.title !== null && t.title !== "");
  endpoints.add((lastTitled ?? seq[seq.length - 1]!).id);

  const demotedOutcomes = demotedOutcomePrompts(seq);
  const markerForSelection = (turn: TurnRecord): MilestoneMarker => {
    const marker = milestoneMarker(turn);
    return marker === "outcome" && demotedOutcomes.has(turn.promptNumber) ? null : marker;
  };

  const isVictim = (turn: TurnRecord): boolean => graph.supersededVictims.has(turn.id);
  const isAlwaysKeep = (turn: TurnRecord): boolean => {
    if (endpoints.has(turn.id)) {
      return true;
    }
    if (isVictim(turn)) {
      // A victim is already carried by its corrector's ↳ row; it never anchors.
      return false;
    }
    if (graph.correctors.has(turn.id)) {
      return true;
    }
    if (milestoneMarker(turn) === "reversed") {
      // Reversed with nobody correcting it: the dead end IS the record.
      return true;
    }
    return (
      isTaskCausalityEra(turn.createdAtEpoch, eraCutoff) && effGradeOf(turn) === 4
    );
  };

  const promptNumbersOf = (turnIds: readonly number[]): number[] =>
    turnIds
      .map((id) => universeById.get(id)?.promptNumber ?? inWindowById.get(id)?.promptNumber)
      .filter((promptNumber): promptNumber is number => promptNumber !== undefined);

  // ③ + ④: the eligible main rows, plus the wider scored pool for ticket 03.
  const keptIds = new Set<number>();
  const rows: KeptMilestone[] = [];
  const poolRows: KeptMilestone[] = [];
  for (const turn of seq) {
    const effGrade = effGradeOf(turn);
    const alwaysKeep = isAlwaysKeep(turn);
    const spine = !isVictim(turn) && effGrade >= MILESTONE_SPINE_MIN_EFF_GRADE;
    if (!alwaysKeep && !spine && effGrade < MILESTONE_POOL_MIN_EFF_GRADE) {
      continue;
    }

    const superseders = graph.supersededBy.get(turn.id);
    const row: KeptMilestone = {
      turn,
      score: effGrade + milestoneTieBreak(turn, inDegree.get(turn.id) ?? 0),
      effGrade,
      alwaysKeep,
      spine,
      marker: markerForSelection(turn),
      ...(superseders ? { supersededBy: promptNumbersOf(superseders) } : {}),
    };
    poolRows.push(row);
    if (alwaysKeep || spine) {
      keptIds.add(turn.id);
      rows.push(row);
    }
  }

  const ranked = [...poolRows].sort(compareMilestoneRank);

  // ⑤ pull-through. Rows are already in prompt order, so the first row to claim
  // an antecedent IS its earliest citer — a shared antecedent renders once.
  const pulled: PulledAntecedent[] = [];
  const pulledIds = new Set<number>();
  const pulledByTurnId = new Map<number, PulledAntecedent>();
  for (const row of rows) {
    const entry = citations.get(row.turn.id);
    if (entry === undefined) {
      continue;
    }
    for (const citedTurnId of entry.citedTurnIds) {
      if (keptIds.has(citedTurnId)) {
        continue;
      }
      const already = pulledByTurnId.get(citedTurnId);
      if (already !== undefined) {
        // Second and later citers of the same antecedent: the ↳ row still
        // renders once, under the earliest citer, but the renderer needs the
        // whole citer list to re-home it when that citer is dropped.
        if (!already.citerPromptNumbers.includes(row.turn.promptNumber)) {
          already.citerPromptNumbers.push(row.turn.promptNumber);
        }
        continue;
      }
      const cited = universeById.get(citedTurnId);
      if (
        cited === undefined ||
        cited.type === "compact" ||
        cited.sessionId !== row.turn.sessionId ||
        // Predecessor guard: a causal reference points backward.
        cited.promptNumber >= row.turn.promptNumber
      ) {
        continue;
      }
      const effGrade = effGradeOf(cited);
      if (effGrade > MILESTONE_PULL_MAX_EFF_GRADE) {
        continue;
      }
      pulledIds.add(citedTurnId);
      const antecedent: PulledAntecedent = {
        turn: cited,
        effGrade,
        citedByPromptNumber: row.turn.promptNumber,
        citerPromptNumbers: [row.turn.promptNumber],
        label: pulledAntecedentLabel(cited),
        supersededBy: promptNumbersOf(graph.supersededBy.get(citedTurnId) ?? []),
      };
      pulled.push(antecedent);
      pulledByTurnId.set(citedTurnId, antecedent);
    }
  }

  // `+N more` = this day's candidate turns that got NO rendered row at all
  // (spec §D). A pulled antecedent holds a ↳ row and is therefore already
  // visible to the reader: counting it here would both inflate `+N` and claim
  // a turn is hidden while it sits two lines above the hint.
  const overflowByDay: OverflowHint[] = [];
  const droppedByDay = new Map<string, TurnRecord[]>();
  for (const turn of seq) {
    if (keptIds.has(turn.id) || pulledIds.has(turn.id)) {
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

  const effGradeByTurnId = new Map<number, number>();
  for (const turn of seq) {
    effGradeByTurnId.set(turn.id, effGradeOf(turn));
  }

  return { kept: rows, ranked, pulled, overflowByDay, effGradeByTurnId };
}

/**
 * One-line label for a ↳ row. Existing skipped turns have no title at all — the
 * extraction prompt only starts titling them in ticket 05 — so a prompt prefix
 * stands in; without it a revived antecedent would render as `(untitled)` and
 * carry no information at all.
 */
function pulledAntecedentLabel(turn: TurnRecord): string {
  if (turn.title !== null && turn.title.trim() !== "") {
    return turn.title;
  }
  const prompt = cleanPromptForLabel(turn.userPrompt);
  return prompt === ""
    ? "(untitled)"
    : truncateText(prompt, MILESTONE_PULLED_LABEL_CAP);
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
  /**
   * Citation snapshot to render against, alongside the preloaded-turns seam.
   * Settlement derives its mechanical signals from one read of this map and then
   * renders the arc; passing that same map here is what keeps the two halves of
   * one settle describing the same graph when a citation write lands between
   * them.
   */
  preloadedCitations?: ReadonlyMap<number, EffectiveCitations>,
): TimelineView {
  const parsed = parseTimelineId(input.id);
  const viewKind = input.view ?? "turns";
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
  const windowTurns = sorted.filter(
    (turn) =>
      turn.promptNumber >= window.startPromptNumber &&
      turn.promptNumber <= window.endPromptNumber,
  );
  const page = Math.max(1, input.page ?? 1);
  const pageSize = Math.max(1, input.pageSize ?? DEFAULT_TIMELINE_PAGE_SIZE);
  const typesDistribution = computeTypesDistribution(allTurns);
  const windowSignals = detectShapeSignals(windowTurns);
  const compactBoundaries = [
    ...new Set(
      allTurns
        .filter((turn) => turn.type === "compact")
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
  const milestoneSelection = selectMilestoneTurns({
    session,
    windowTurns,
    windowSignals,
    compactBoundaries,
    sessionTurns: allTurns,
    // One read for the whole selection: in-degree, victim demotion and
    // pull-through all consume this map (spec §B). A caller that already read it
    // (settlement) hands its own snapshot in rather than paying for a second.
    citations: preloadedCitations ?? getSessionEffectiveCitations(db, session.id),
  });
  const phases = segmentPhases(windowTurns);
  const nonSkippedTurns = windowTurns.filter((turn) => turn.status !== "skipped");
  const pagedTurns =
    viewKind === "turns"
      ? paginateItems(nonSkippedTurns, page, pageSize)
      : emptyPaginatedItems<TurnRecord>(nonSkippedTurns.length, pageSize);
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
  const pagedPhases =
    viewKind === "phases"
      ? paginateItems(phases, page, pageSize)
      : emptyPaginatedItems<Phase>(phases.length, pageSize);
  const viewItemTotal =
    viewKind === "turns"
      ? pagedTurns.total
      : viewKind === "milestones"
        ? pagedMilestones.total
        : pagedPhases.total;
  const pageCount =
    viewKind === "turns"
      ? pagedTurns.pageCount
      : viewKind === "milestones"
        ? pagedMilestones.pageCount
        : pagedPhases.pageCount;
  const pageAnchorEpoch =
    viewKind === "turns"
      ? (pagedTurns.items[0]?.createdAtEpoch ?? null)
      : viewKind === "milestones"
        ? (pagedMilestones.items[0]?.turn.createdAtEpoch ?? null)
        : (pagedPhases.items[0]?.startEpoch ?? null);

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
    milestonePulled: viewKind === "milestones" ? milestoneSelection.pulled : [],
    turnEffGrades: milestoneSelection.effGradeByTurnId,
    milestoneDayGroups,
    pagedPhases: pagedPhases.items,
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
  };
}

export function buildContextTimelineView(
  db: Database,
  sessionId: number,
  view: TimelineViewKind = "turns",
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
    return buildTimelineView(db, { id: `S${sessionId}` });
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
  const typesParts: string[] = [];

  if (view.typesDistribution.bugfix > 0) {
    typesParts.push(`🔴${view.typesDistribution.bugfix}`);
  }
  if (view.typesDistribution.feature > 0) {
    typesParts.push(`🟣${view.typesDistribution.feature}`);
  }
  if (view.typesDistribution.refactor > 0) {
    typesParts.push(`🔄${view.typesDistribution.refactor}`);
  }
  if (view.typesDistribution.change > 0) {
    typesParts.push(`✅${view.typesDistribution.change}`);
  }
  if (view.typesDistribution.discovery > 0) {
    typesParts.push(`🔵${view.typesDistribution.discovery}`);
  }
  if (view.typesDistribution.decision > 0) {
    typesParts.push(`⚖️${view.typesDistribution.decision}`);
  }
  if (view.typesDistribution.compact > 0) {
    typesParts.push(`⏸${view.typesDistribution.compact}`);
  }
  if (view.typesDistribution.pending > 0) {
    typesParts.push(`⏳${view.typesDistribution.pending}`);
  }
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
  promptCap: number,
  titleCap: number,
): string[] {
  const renderedTurns = view.pageTurns.map((turn) => ({
    turn,
    marker: null as string | null,
  }));

  return renderTurnRows(view, renderedTurns, promptCap, titleCap);
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
function milestonePromptPrefix(turn: TurnRecord): string {
  const raw = turn.userPrompt;
  if (raw === null) {
    return "";
  }
  const commandName = extractCommandName(raw);
  if (commandName === null && isKnownSystemInjectedContent(raw.trimStart())) {
    return MILESTONE_NOTIFICATION_MARKER;
  }
  return truncateText(cleanPromptForLabel(raw), MILESTONE_PROMPT_PREFIX_CAP);
}

/** One spine row plus the `↳` antecedents homed under it — the budget unit (spec §D). */
interface MilestoneRenderUnit {
  milestone: KeptMilestone;
  pulled: PulledAntecedent[];
}

/**
 * How far one unit has been cut back. `null` on a token field means "uncut"; the
 * fields are applied in the spec's termination order by `fitUnitTrim`.
 */
interface MilestoneUnitTrim {
  showDesc: boolean;
  descTokens: number | null;
  pulledShown: number;
  pulledTitleTokens: number | null;
  titleTokens: number | null;
  promptTokens: number | null;
  showFiles: boolean;
}

function initialUnitTrim(unit: MilestoneRenderUnit): MilestoneUnitTrim {
  return {
    showDesc: true,
    descTokens: null,
    pulledShown: Math.min(unit.pulled.length, MILESTONE_UNIT_PULLED_CAP),
    pulledTitleTokens: null,
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
): string[] {
  const { milestone } = unit;
  const glyph =
    milestone.marker === null ? "  " : MILESTONE_MARKER_GLYPH[milestone.marker];

  let prompt = sanitizeTimelineField(milestonePromptPrefix(milestone.turn));
  if (trim.promptTokens !== null) {
    prompt = truncateToTokens(prompt, trim.promptTokens);
  }
  let title = sanitizeTimelineField(
    truncateText(milestone.turn.title ?? "(untitled)", titleCap),
  );
  if (trim.titleTokens !== null) {
    title = truncateToTokens(title, trim.titleTokens);
  }
  const head =
    prompt !== "" && title !== ""
      ? `${prompt} → ${title}`
      : `${prompt}${title}`;
  const filesTail = trim.showFiles ? renderModifiedFilesTail(milestone.turn) : "";

  const lines = [
    `   ${glyph} T${milestone.turn.promptNumber} ${typeEmoji(milestone.turn.type)} G${milestone.effGrade} ${head}${filesTail}`.trimEnd(),
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

  for (const antecedent of unit.pulled.slice(0, trim.pulledShown)) {
    const superseded = antecedent.supersededBy.length > 0;
    const reversalGlyph = superseded ? `${MILESTONE_MARKER_GLYPH.invalidated} ` : "";
    let label = sanitizeTimelineField(truncateText(antecedent.label, titleCap));
    if (trim.pulledTitleTokens !== null) {
      label = truncateToTokens(label, trim.pulledTitleTokens);
    }
    const backLink = superseded
      ? ` →被T${antecedent.supersededBy.join("/T")}推翻`
      : "";
    lines.push(
      `      ↳ ${reversalGlyph}T${antecedent.turn.promptNumber} ${typeEmoji(antecedent.turn.type)} G${antecedent.effGrade} ${label}${backLink}`,
    );
  }

  const foldedPulled = unit.pulled.length - trim.pulledShown;
  if (foldedPulled > 0) {
    lines.push(`      ↳ +${foldedPulled} 前件`);
  }

  return lines;
}

function unitTokens(
  unit: MilestoneRenderUnit,
  trim: MilestoneUnitTrim,
  titleCap: number,
): number {
  return estimateDiaryTokens(renderUnitLines(unit, trim, titleCap).join("\n"));
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
): number {
  let low = 0;
  let high = cap;
  let best = -1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    apply(mid);
    if (unitTokens(unit, trim, titleCap) <= cap) {
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
 *   ② fold `↳` rows into `+N 前件` until it fits
 *   ③ drop the `✏️` files tail
 *   ④ token-truncate the surviving `↳` titles
 *   ⑤ token-truncate the spine title
 *   ⑥ token-truncate the user-prompt prefix
 *   → (in `renderUnitFitted`) clamp the head line itself
 *
 * Decorative elements are sacrificed before load-bearing text, which is why ③
 * sits above the title steps: the file list is a pointer one `recall` away, its
 * basenames are uncapped in length, and a single pathological generated name can
 * outweigh everything the row is actually about. `titleCap` is a character
 * ceiling; ④-⑥ are what make the token cap a ceiling that a wall of Han
 * characters cannot breach, and the final clamp is the backstop for a row whose
 * fixed scaffolding alone would overrun.
 */
function fitUnitTrim(
  unit: MilestoneRenderUnit,
  titleCap: number,
  cap: number,
  base: MilestoneUnitTrim,
): MilestoneUnitTrim {
  const trim = { ...base };
  if (unitTokens(unit, trim, titleCap) <= cap) {
    return trim;
  }

  // ① truncate the desc, then drop it outright if trimming it is not enough.
  if (trim.showDesc && milestoneDescText(unit.milestone.turn) !== "") {
    const best = largestFittingTokens(unit, trim, titleCap, cap, (value) => {
      trim.descTokens = value;
    });
    if (best <= 0) {
      trim.showDesc = false;
      trim.descTokens = null;
    } else {
      return trim;
    }
  }
  if (unitTokens(unit, trim, titleCap) <= cap) {
    return trim;
  }

  // ② fold ↳ rows into `+N 前件` until it fits.
  while (trim.pulledShown > 0 && unitTokens(unit, trim, titleCap) > cap) {
    trim.pulledShown -= 1;
  }
  if (unitTokens(unit, trim, titleCap) <= cap) {
    return trim;
  }

  // ③ drop the `✏️` files tail: decoration goes before any load-bearing text is
  // cut, so a pathological basename can never cost the row its title.
  trim.showFiles = false;
  if (unitTokens(unit, trim, titleCap) <= cap) {
    return trim;
  }

  // ④ token-truncate the surviving ↳ titles, ⑤ then the spine's.
  if (trim.pulledShown > 0) {
    largestFittingTokens(unit, trim, titleCap, cap, (value) => {
      trim.pulledTitleTokens = value;
    });
    if (unitTokens(unit, trim, titleCap) <= cap) {
      return trim;
    }
  }
  largestFittingTokens(unit, trim, titleCap, cap, (value) => {
    trim.titleTokens = value;
  });
  if (unitTokens(unit, trim, titleCap) <= cap) {
    return trim;
  }
  // ⑥ token-truncate the user-prompt prefix.
  largestFittingTokens(unit, trim, titleCap, cap, (value) => {
    trim.promptTokens = value;
  });
  return trim;
}

function renderUnitFitted(
  unit: MilestoneRenderUnit,
  titleCap: number,
  descOff: boolean,
): string[] {
  const base = initialUnitTrim(unit);
  if (descOff) {
    base.showDesc = false;
  }
  const trim = fitUnitTrim(unit, titleCap, MILESTONE_UNIT_TOKEN_CAP, base);
  const lines = renderUnitLines(unit, trim, titleCap);
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
}

function createMilestoneBodyModel(
  view: TimelineView,
  titleCap: number,
): MilestoneBodyModel {
  const pagedPrompts = new Set(
    view.pagedMilestones.map((milestone) => milestone.turn.promptNumber),
  );
  const milestoneByPrompt = new Map(
    view.pagedMilestones.map((milestone) => [milestone.turn.promptNumber, milestone]),
  );
  // A turn holding a main row must never ALSO render as a ↳ row: `ranked` and
  // `pulled` overlap in the G2 band, so this guard is what keeps a G2 antecedent
  // that is itself kept from being drawn twice.
  const mainRowTurnIds = new Set(
    view.pagedMilestones.map((milestone) => milestone.turn.id),
  );
  const pullable = view.milestonePulled.filter(
    (antecedent) => !mainRowTurnIds.has(antecedent.turn.id),
  );
  // Selection order, so a re-homed antecedent lands where a from-scratch pass
  // would have put it rather than at the end of its new host's list.
  const pullOrder = new Map(
    pullable.map((antecedent, index) => [antecedent, index] as const),
  );
  // `formatLocalDate` builds an `Intl.DateTimeFormat` per call, so every date a
  // degradation step needs is resolved once here, never inside the step.
  const antecedentDates = new Map(
    pullable.map(
      (antecedent) =>
        [antecedent, formatLocalDate(antecedent.turn.createdAtEpoch)] as const,
    ),
  );

  const retainedPrompts = new Set(pagedPrompts);
  const removed = new Set<KeptMilestone>();
  const descOff = new Set<KeptMilestone>();
  const homedPulled = new Map<number, PulledAntecedent[]>();
  const unitEntries = new Map<KeptMilestone, MilestoneUnitEntry>();

  const sections: MilestoneBodySection[] = view.milestoneDayGroups.map((group) => ({
    date: group.date,
    labelEpoch: group.labelEpoch,
    group,
  }));
  const groupedDates = new Set(sections.map((section) => section.date));
  const syntheticEpochs = new Map<string, number>();
  for (const antecedent of pullable) {
    const date = antecedentDates.get(antecedent)!;
    if (groupedDates.has(date)) {
      continue;
    }
    const known = syntheticEpochs.get(date);
    if (known === undefined || antecedent.turn.createdAtEpoch < known) {
      syntheticEpochs.set(date, antecedent.turn.createdAtEpoch);
    }
  }
  for (const [date, labelEpoch] of syntheticEpochs) {
    sections.push({ date, labelEpoch, group: null });
  }
  // Stable sort: the real groups are already chronological, so only the
  // synthetic days move, into their place in the day sequence.
  sections.sort((left, right) => left.labelEpoch - right.labelEpoch);

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
  const stateByDate = new Map(
    orderedStates.map((state) => [state.section.date, state] as const),
  );
  const stateOfMilestone = new Map<KeptMilestone, MilestoneSectionState>();
  for (const state of orderedStates) {
    for (const milestone of state.rows) {
      stateOfMilestone.set(milestone, state);
    }
  }

  let totalTenths = 0;
  let priced = false;
  let framed = false;

  function lineTenths(line: string): number {
    return textWeightTenths(line) + NEWLINE_WEIGHT_TENTHS;
  }

  function unitEntryFor(milestone: KeptMilestone): MilestoneUnitEntry {
    const cached = unitEntries.get(milestone);
    if (cached !== undefined) {
      return cached;
    }
    const pulled = [...(homedPulled.get(milestone.turn.promptNumber) ?? [])].sort(
      (left, right) => (pullOrder.get(left) ?? 0) - (pullOrder.get(right) ?? 0),
    );
    const lines = renderUnitFitted(
      { milestone, pulled },
      titleCap,
      descOff.has(milestone),
    );
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
   * ends of a contiguous run.
   */
  function hiddenHint(hidden: number, promptLo: number, promptHi: number): string {
    return `… +${hidden} more → timeline(id="S${view.session.id}", view="turns") @ within T${promptLo}..T${promptHi}`;
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

  /** One more turn of this day renders nowhere; re-price whichever frame owns it. */
  function noteHidden(state: MilestoneSectionState, promptNumber: number): void {
    state.hiddenCount += 1;
    state.hiddenLo = Math.min(state.hiddenLo, promptNumber);
    state.hiddenHi = Math.max(state.hiddenHi, promptNumber);
    if (!framed) {
      return;
    }
    const { run } = state;
    if (run === null) {
      refreshExpandedFrame(state);
      return;
    }
    run.hidden += 1;
    run.promptLo = Math.min(run.promptLo, promptNumber);
    run.promptHi = Math.max(run.promptHi, promptNumber);
    priceRun(run);
  }

  function homeAntecedent(antecedent: PulledAntecedent): void {
    const home = antecedent.citerPromptNumbers.find((promptNumber) =>
      retainedPrompts.has(promptNumber),
    );
    if (home !== undefined) {
      homedPulled.set(home, [...(homedPulled.get(home) ?? []), antecedent]);
      const host = milestoneByPrompt.get(home);
      if (host !== undefined) {
        invalidateUnit(host);
      }
      return;
    }
    if (
      !antecedent.citerPromptNumbers.some((promptNumber) => pagedPrompts.has(promptNumber))
    ) {
      // Cited only from off-page rows: it was never this page's to render.
      return;
    }
    // Every citer of this antecedent on the page is gone, so it renders nowhere
    // and folds into its own day's hidden count — which is why that day gets a
    // section even when it owns no main row on this page. It is never also in
    // that day's base overflow: `overflowByDay` skips every pulled turn.
    const state = stateByDate.get(antecedentDates.get(antecedent)!);
    if (state === undefined) {
      return;
    }
    noteHidden(state, antecedent.turn.promptNumber);
  }

  for (const antecedent of pullable) {
    homeAntecedent(antecedent);
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
  framed = true;
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
      retainedPrompts.delete(promptNumber);
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
        // Settle the day's own frame BEFORE re-homing: an antecedent orphaned by
        // this removal can be homed on this very day, and it must land on the
        // frame the day now has, not the one it is about to lose.
        if (state.rows.length === 0) {
          collapseState(state);
        } else {
          refreshExpandedFrame(state);
        }
      }
      unitEntries.delete(milestone);
      const orphaned = homedPulled.get(promptNumber) ?? [];
      homedPulled.delete(promptNumber);
      for (const antecedent of orphaned) {
        homeAntecedent(antecedent);
      }
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
  };
}

/**
 * Renders the arc body with no budget applied: every selected unit in full.
 * `createMilestoneBodyModel` is the single implementation — the budget path is
 * the same model with degradation steps applied.
 */
function renderMilestoneBody(view: TimelineView, titleCap: number): string[] {
  if (view.milestoneDayGroups.length === 0) {
    return [];
  }
  return createMilestoneBodyModel(view, titleCap).lines();
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
 * desc first; if that is not enough, whole units go, lowest score first, and
 * always-keep units are exempt from removal however low they score. Day frames
 * follow the units down: a day that loses its last row collapses, and a run of
 * consecutive collapsed days costs one combined hint line rather than two lines
 * per day. When the anchors alone still overrun — frames already collapsed
 * around them — the body is rendered in full with one overflow note; an anchor
 * is never dropped silently.
 *
 * Two-tier measurement. The model's running weight prices every step in O(1),
 * but it is a LOWER bound on `estimateDiaryTokens` (that function's float
 * accumulation can round one token higher). So the cheap number gates the
 * expensive one: a step whose cheap price still overruns cannot possibly fit,
 * and the first step that might fit is confirmed with `measure`, which reports
 * the token cost of the WHOLE assembled output — header and signal blocks
 * included. The stopping point is therefore identical to re-measuring the full
 * output on every step, at a fraction of the work.
 */
function fitMilestoneBodyToBudget(
  view: TimelineView,
  titleCap: number,
  tokenBudget: number,
  fixedWeightTenths: number,
  measure: (bodyLines: string[]) => number,
): string[] {
  const body = createMilestoneBodyModel(view, titleCap);
  const fits = (): boolean =>
    tokensFromWeightTenths(fixedWeightTenths + body.weightTenths()) <= tokenBudget &&
    measure(body.lines()) <= tokenBudget;

  if (fits()) {
    return body.lines();
  }

  for (const milestone of milestoneDegradationOrder(view)) {
    body.disableDesc(milestone);
    if (fits()) {
      return body.lines();
    }
  }

  for (const milestone of milestoneDegradationOrder(view)) {
    if (milestone.alwaysKeep) {
      continue;
    }
    body.removeUnit(milestone);
    if (fits()) {
      return body.lines();
    }
  }

  return [...body.lines(), MILESTONE_OVER_BUDGET_NOTE];
}
function renderTurnRows(
  view: TimelineView,
  renderedTurns: Array<{ turn: TurnRecord; marker: string | null }>,
  promptCap: number,
  titleCap: number,
): string[] {
  if (renderedTurns.length === 0) {
    return [];
  }

  const brokenPromptCandidates = new Set<number>();
  for (const pair of view.windowSignals.brokenPromptPairs) {
    brokenPromptCandidates.add(pair.first);
    brokenPromptCandidates.add(pair.second);
  }

  const previousEpochByPrompt = computePreviousEpochByPrompt(view.windowTurns);

  const lines = [
    "",
    TURN_TABLE_HEADER,
  ];

  let previousRenderedEpoch: number | null = null;
  for (let index = 0; index < renderedTurns.length; index += 1) {
    const { turn, marker } = renderedTurns[index]!;

    if (
      previousRenderedEpoch !== null &&
      !sameLocalDate(previousRenderedEpoch, turn.createdAtEpoch)
    ) {
      lines.push(renderDayDivider(turn.createdAtEpoch, previousRenderedEpoch));
    }

    lines.push(
      renderTurnRow(
        turn,
        previousEpochByPrompt.get(turn.promptNumber) ?? null,
        brokenPromptCandidates.has(turn.promptNumber),
        promptCap,
        titleCap,
        view.turnEffGrades.get(turn.id),
        marker,
      ),
    );
    previousRenderedEpoch = turn.createdAtEpoch;
  }

  return lines;
}

function computePreviousEpochByPrompt(turns: TurnRecord[]): Map<number, number | null> {
  const out = new Map<number, number | null>();
  let previous: number | null = null;

  for (const turn of sortTurnsForAnalysis(turns)) {
    out.set(turn.promptNumber, previous);
    previous = turn.createdAtEpoch;
  }

  return out;
}

function renderDayDivider(currentEpoch: number, previousRenderedEpoch: number): string {
  return `── ${formatLocalDateWithWeekday(currentEpoch)} · ${formatGap(currentEpoch, previousRenderedEpoch)} idle ──`;
}

function renderTurnRow(
  turn: TurnRecord,
  prevEpoch: number | null,
  isBrokenPromptCandidate: boolean,
  promptCap: number,
  titleCap: number,
  effGrade: number | undefined,
  marker: string | null = null,
): string {
  const isUndone = turn.status === "undone";
  const compactMetadata = turn.type === "compact" ? getCompactMetadata(turn.tags) : null;
  const gapSuffix = isBrokenPromptCandidate ? " ※" : "";
  const sourceBadges = extractSourceTags(turn.tags)
    .map((source) => `[ext:${source}]`)
    .join(" ");
  const promptCore =
    turn.type === "compact" ? "/compact" : cleanPromptForLabel(turn.userPrompt);
  const promptWithBadges =
    turn.type === "compact"
      ? promptCore
      : sourceBadges.length > 0 ? `${sourceBadges} ${promptCore}` : promptCore;
  const promptText = sanitizeTimelineField(truncateText(promptWithBadges, promptCap));
  const renderedPrompt = isUndone ? `~~${promptText}~~` : promptText;
  const statusPrefix = isUndone ? "⨯ " : "";
  const titleText = sanitizeTimelineField(
    renderTitleCell(turn, isUndone, compactMetadata, titleCap, marker),
  );

  return [
    `${statusPrefix}T${turn.promptNumber}`,
    formatTranscriptLineAnchor(turn.transcriptLineStart),
    formatLocalTime(turn.createdAtEpoch),
    `${formatGap(turn.createdAtEpoch, prevEpoch)}${gapSuffix}`,
    renderStats(turn),
    // Grade column (spec §D): the arc view and the turn table print the same
    // effGrade, so "how important" is read off the row instead of inferred from
    // the type icon. `—` is a turn with no main-row candidacy (a compact marker).
    effGrade === undefined ? MISSING_GRADE_CELL : `G${effGrade}`,
    `${renderedPrompt} → ${titleText}`,
  ].join(" | ");
}

function renderStats(turn: TurnRecord): string {
  const stats: string[] = [];
  const toolCallCount = turn.toolCallCount ?? 0;

  if (toolCallCount > 0) {
    stats.push(`🔧${toolCallCount}`);
  }
  if (turn.filesRead.length > 0) {
    stats.push(`📖${turn.filesRead.length}`);
  }
  if (turn.filesModified.length > 0) {
    stats.push(`✏️${turn.filesModified.length}`);
  }

  return stats.length > 0 ? stats.join(" ") : "—";
}

function renderTitleCell(
  turn: TurnRecord,
  isUndone: boolean,
  compactMetadata: { preTokens: number; trigger: string } | null,
  titleCap: number,
  marker: string | null = null,
): string {
  const markerPrefix = marker ? `${marker} ` : "";

  if (turn.type === "compact") {
    const preTokens = formatCompactTokenCount(compactMetadata?.preTokens ?? 0);
    const trigger = compactMetadata?.trigger ?? "manual";
    return `${markerPrefix}${TYPE_EMOJI_MAP.compact} /compact ${preTokens} tokens, ${trigger}`;
  }

  if (isUndone) {
    if (turn.type !== null && turn.title !== null) {
      const body = `${TYPE_EMOJI_MAP[turn.type] ?? "•"} ${truncateText(turn.title, titleCap)}`;
      return `${markerPrefix}~~${body}~~`;
    }
    return `${markerPrefix}⨯`.trim();
  }

  if (turn.status === "extracted" && turn.type !== null && turn.title !== null) {
    return `${markerPrefix}${TYPE_EMOJI_MAP[turn.type] ?? "•"} ${truncateText(turn.title, titleCap)}`;
  }

  return `${markerPrefix}⏳`.trim();
}

function sanitizeTimelineField(value: string): string {
  return value.replaceAll("|", "/").replaceAll("→", "->");
}

function isTimelineLiveTurn(turn: TurnRecord): boolean {
  return turn.status !== "undone" && turn.status !== "skipped";
}

function renderPhases(
  view: TimelineView,
  titleCap: number,
): string[] {
  if (view.pagedPhases.length === 0) {
    return [];
  }

  const turnByPrompt = new Map(
    view.windowTurns.map((turn) => [turn.promptNumber, turn] as const),
  );
  const lines = [
    "",
    "  phases:",
    "  # | date | type | turns | span | work | lead title",
  ];

  let previousPhaseEpoch: number | null = null;
  const startIndex = (view.page - 1) * view.pageSize;

  for (const [index, phase] of view.pagedPhases.entries()) {
    if (
      previousPhaseEpoch !== null &&
      !sameLocalDate(previousPhaseEpoch, phase.startEpoch)
    ) {
      lines.push(`  ${renderDayDivider(phase.startEpoch, previousPhaseEpoch)}`);
    }

    const range =
      phase.startPromptNumber === phase.endPromptNumber
        ? `T${phase.startPromptNumber}`
        : `T${phase.startPromptNumber}-T${phase.endPromptNumber}`;
    const durationLabel =
      phase.durationMs > 0 ? `~${formatDuration(phase.durationMs)}` : "<1m";
    const countsLabel = `${phase.turnCount} ${phase.turnCount === 1 ? "turn" : "turns"}`;
    const stats: string[] = [];

    if (phase.totalFilesRead > 0) {
      stats.push(`📖${phase.totalFilesRead}`);
    }
    if (phase.totalFilesModified > 0) {
      stats.push(`✏️${phase.totalFilesModified}`);
    }
    if (phase.totalToolCalls > 0) {
      stats.push(`🔧${phase.totalToolCalls}`);
    }

    const extSuffix =
      phase.externalInputs.length > 0
        ? `  [ext:${phase.externalInputs.join(",")}]`
        : "";
    const dateLabel = sameLocalDate(phase.startEpoch, phase.endEpoch)
      ? formatLocalMonthDayWithWeekday(phase.startEpoch)
      : `${formatLocalMonthDay(phase.startEpoch)}→${formatLocalMonthDay(phase.endEpoch)}`;
    const leadTurn = turnByPrompt.get(phase.startPromptNumber);
    const leadTextCandidate =
      leadTurn?.title ??
      cleanPromptForLabel(leadTurn?.userPrompt ?? null);
    const leadText =
      leadTextCandidate.length > 0 ? leadTextCandidate : "(untitled)";
    const leadTitle = sanitizeTimelineField(truncateText(leadText, titleCap));

    lines.push(
      `  ${String(startIndex + index + 1).padStart(2)} | ${dateLabel.padEnd(11)} | ${phase.emoji} ${(phase.kind === "pending" ? "pending" : phase.type ?? "").padEnd(10)} | ${range.padEnd(8)} | ${durationLabel.padEnd(7)} | ${`${countsLabel} ${stats.join(" ")}`.trim().padEnd(16)} | ${leadTitle}${extSuffix}`.trimEnd(),
    );
    previousPhaseEpoch = phase.endEpoch;
  }

  return lines;
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

export function renderTimeline(
  view: TimelineView,
  options: RenderTimelineOptions = {},
): string {
  const promptCap = options.promptCap ?? PROMPT_COLUMN_CAP;
  const titleCap = options.titleCap ?? DEFAULT_TITLE_CAP;
  const assemble = (bodyLines: string[]): string =>
    [
      ...renderSessionHeader(view),
      ...bodyLines,
      ...renderShapeSignals(view),
      ...renderEarlierHint(view, options),
      ...renderLineagePointer(view),
    ].join("\n");

  if (view.view === "phases") {
    return assemble(renderPhases(view, titleCap));
  }
  if (view.view !== "milestones") {
    return assemble(renderTurnTable(view, promptCap, titleCap));
  }

  // Milestones. A budget is measured against the WHOLE assembled output, so the
  // header and signal blocks count against it too; without one (every MCP view)
  // the body renders in full and pagination is the only sizing mechanism.
  if (options.tokenBudget === undefined) {
    return assemble(renderMilestoneBody(view, titleCap));
  }
  // Everything outside the body is fixed, so its weight is measured once and the
  // fitter only has to price what it changes.
  return assemble(
    fitMilestoneBodyToBudget(
      view,
      titleCap,
      options.tokenBudget,
      textWeightTenths(assemble([])),
      (bodyLines) => estimateDiaryTokens(assemble(bodyLines)),
    ),
  );
}

export function timelineQuery(db: Database, input: TimelineInput): string {
  try {
    return renderTimeline(buildTimelineView(db, input));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `timeline error: ${message}`;
  }
}
