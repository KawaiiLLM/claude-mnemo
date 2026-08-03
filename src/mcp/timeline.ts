import type { Database } from "bun:sqlite";
import {
  getSessionEffectiveCitations,
  parseInlineCitations,
  type EffectiveCitations,
} from "../db/citations";
import { getSession, type SessionRecord } from "../db/sessions";
import { getFirstTurn, getTurnById, getTurnsForSession, type TurnRecord } from "../db/turns";
import { resolveTranscriptPath } from "../shared/paths";
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
export const TITLE_COLUMN_CAP = 80;
export const BROKEN_PROMPT_MIN_PREFIX = 20;
export const BROKEN_PROMPT_MAX_GAP_MS = 5 * 60 * 1000;
export const TOOL_BURST_TOP_N = 3;

export const MILESTONE_TITLE_CAP = 90;
/** Max causal references rendered as sub-lines under a single milestone. */
export const MILESTONE_REFERENCE_CAP = 2;
/**
 * Max raw `[T<n>]` candidates parsed out of one milestone's content before
 * validation. Higher than the display cap so that invalid leading refs
 * (cross-session, self/future, missing) don't crowd out valid predecessors —
 * the resolver validates these candidates and keeps the first
 * `MILESTONE_REFERENCE_CAP` that survive. Bounds work on pathological content.
 */
export const MILESTONE_REFERENCE_PARSE_CAP = 8;

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

/**
 * A causal reference cited in a milestone's `content` as `[T<dbid>]`, resolved
 * to its driver turn. The renderer shows these as indented `↳` sub-lines so the
 * "why" rides on the marker rather than competing for a per-day milestone slot.
 * Resolution is done in the query layer (where `db` is available); the renderer
 * stays pure and only formats the pre-resolved data.
 */
export interface CitedReference {
  /** The driver's user-facing prompt number (for display). */
  promptNumber: number;
  /** The driver's title (already resolved; truncated at render time). */
  title: string;
  /** The driver's milestone marker, used to flag a rolled-back/invalidated cause. */
  marker: MilestoneMarker;
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
  /**
   * Resolved causal references parsed from `turn.content` (`[T<dbid>]`), ≤2.
   * Populated in the query layer via `resolveMilestoneReferences`; absent (or
   * empty) when the milestone cites nothing resolvable in-session.
   *
   * INTERIM: this is the pre-redesign ↳ path that the current renderer still
   * consumes. `MilestoneSelection.pulled` is the systematic replacement (spec
   * §C ⑤); the unified row renderer (ticket 03) switches over and this field
   * goes away with it.
   */
  references?: CitedReference[];
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

export function cleanPromptForLabel(raw: string | null): string {
  if (raw === null) {
    return "";
  }

  const commandName = raw.match(/<command-name>\s*([^<]+?)\s*<\/command-name>/);
  if (commandName) {
    return commandName[1].trim();
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
    return { kept: [], ranked: [], pulled: [], overflowByDay: [] };
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

  const ranked = [...poolRows].sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score;
    const leftTools = left.turn.toolCallCount ?? 0;
    const rightTools = right.turn.toolCallCount ?? 0;
    if (leftTools !== rightTools) return rightTools - leftTools;
    return left.turn.promptNumber - right.turn.promptNumber;
  });

  // ⑤ pull-through. Rows are already in prompt order, so the first row to claim
  // an antecedent IS its earliest citer — a shared antecedent renders once.
  const pulled: PulledAntecedent[] = [];
  const pulledIds = new Set<number>();
  for (const row of rows) {
    const entry = citations.get(row.turn.id);
    if (entry === undefined) {
      continue;
    }
    for (const citedTurnId of entry.citedTurnIds) {
      if (pulledIds.has(citedTurnId) || keptIds.has(citedTurnId)) {
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
      pulled.push({
        turn: cited,
        effGrade,
        citedByPromptNumber: row.turn.promptNumber,
        label: pulledAntecedentLabel(cited),
        supersededBy: promptNumbersOf(graph.supersededBy.get(citedTurnId) ?? []),
      });
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
    });
  }

  return { kept: rows, ranked, pulled, overflowByDay };
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
 * Parses inline DB-id causal references out of a milestone's content, in order,
 * de-duplicated, capped at `MILESTONE_REFERENCE_CAP`. These are DB turn ids (the
 * agent's id space, the same id passed to `remember()`), NOT user-facing prompt
 * numbers — the caller resolves them via `getTurnById` and maps id → prompt
 * number for display.
 *
 * The grammar lives in db/citations.ts (`parseInlineCitations`) and is shared
 * with the structured-citation fallback, so the milestone view and the settle
 * path can never disagree about what a legacy turn cites. It covers the single
 * `[T8501]` form this function used to handle plus the comma-list, inclusive
 * range, and annotated forms — a strict superset, so no previously-recognised
 * citation stops resolving.
 *
 * The grammar itself is uncapped; `cap` is this consumer's own ceiling on how
 * many raw candidates the milestone path will validate, and it stays here rather
 * than in the shared parser so the settle/pull-through consumers see every id a
 * legacy turn actually cites.
 */
export function parseContentReferences(
  content: string | null,
  cap: number = MILESTONE_REFERENCE_CAP,
): number[] {
  return parseInlineCitations(content, cap);
}

/**
 * Resolves each kept milestone's `[T<dbid>]` causal references (≤2) against the
 * DB and attaches them as `references`. Resolution goes through `getTurnById`
 * (the durable DB id), NOT the in-memory window, so a kept milestone in a
 * ranged view can still cite a driver outside that window. A cite is rejected —
 * staying buried as raw `[T<n>]` in the undisplayed content — when it does not
 * resolve, resolves to a different session (session-id guard), or is not an
 * earlier turn in the same session (predecessor guard: a causal reference must
 * point backward, so self/future cites are inert). Candidates are parsed up to
 * `MILESTONE_REFERENCE_PARSE_CAP`, validated, then capped at the first
 * `MILESTONE_REFERENCE_CAP` survivors so invalid leading refs don't hide valid
 * predecessors. Mutates the milestones in place and returns them.
 */
export function resolveMilestoneReferences(
  db: Database,
  kept: KeptMilestone[],
): KeptMilestone[] {
  const keptPromptsByDay = new Map<string, Set<number>>();
  for (const milestone of kept) {
    const day = formatLocalDate(milestone.turn.createdAtEpoch);
    const prompts = keptPromptsByDay.get(day) ?? new Set<number>();
    prompts.add(milestone.turn.promptNumber);
    keptPromptsByDay.set(day, prompts);
  }

  for (const milestone of kept) {
    const ids = parseContentReferences(
      milestone.turn.content,
      MILESTONE_REFERENCE_PARSE_CAP,
    );
    if (ids.length === 0) {
      continue;
    }

    const references: CitedReference[] = [];
    for (const id of ids) {
      const cited = getTurnById(db, id);
      if (
        cited === null ||
        // Session-id guard: a cross-session (or missing) cite renders inert.
        cited.sessionId !== milestone.turn.sessionId ||
        // Predecessor guard: a causal reference points backward; a self/future
        // cite is not a driver and renders inert.
        cited.promptNumber >= milestone.turn.promptNumber
      ) {
        continue;
      }
      const milestoneDay = formatLocalDate(milestone.turn.createdAtEpoch);
      if (keptPromptsByDay.get(milestoneDay)?.has(cited.promptNumber) === true) {
        continue;
      }
      references.push({
        promptNumber: cited.promptNumber,
        title: cited.title ?? "(untitled)",
        marker: milestoneMarker(cited),
      });
      // Stop once we have enough valid survivors (display cap).
      if (references.length >= MILESTONE_REFERENCE_CAP) {
        break;
      }
    }

    if (references.length > 0) {
      milestone.references = references;
    }
  }

  return kept;
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
  const jsonlPath =
    resolveTranscriptPath(session.project, session.contentSessionId) ?? null;
  const tz = getSystemTimezone(session.createdAtEpoch);
  const breadcrumb = deriveTimelineBreadcrumb(db, session);
  const milestoneSelection = selectMilestoneTurns({
    session,
    windowTurns,
    windowSignals,
    compactBoundaries,
    sessionTurns: allTurns,
    // One read for the whole selection: in-degree, victim demotion and
    // pull-through all consume this map (spec §B).
    citations: getSessionEffectiveCitations(db, session.id),
  });
  // Resolve each kept milestone's `[T<dbid>]` causal references here, in the
  // query layer where `db` is available, so the renderer stays pure. Goes
  // through `getTurnById`, not the in-memory window, so a ranged view's kept
  // milestone can still resolve a driver that sits outside its window.
  if (viewKind === "milestones") {
    resolveMilestoneReferences(db, milestoneSelection.kept);
  }
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
  promptCap: number = PROMPT_COLUMN_CAP,
): string[] {
  const renderedTurns = view.pageTurns.map((turn) => ({
    turn,
    marker: null as string | null,
  }));

  return renderTurnRows(view, renderedTurns, promptCap);
}

const MILESTONE_MARKER_GLYPH: Record<Exclude<MilestoneMarker, null>, string> = {
  invalidated: "🚫",
  reversed: "↩️",
  outcome: "🏁",
};

/**
 * Renders a kept milestone's pre-resolved causal references as `↳` sub-lines,
 * indented to match the overflow-hint gutter. The cited turn is shown by its
 * prompt number (mapped from the stored DB id in the query layer); an
 * invalidated/reversed cause is prefixed with its marker glyph. Pure: it only
 * formats data already resolved in `resolveMilestoneReferences`.
 */
function renderMilestoneReferenceLines(references: CitedReference[]): string[] {
  return references.map((ref) => {
    const markerGlyph =
      ref.marker === "invalidated" || ref.marker === "reversed"
        ? `${MILESTONE_MARKER_GLYPH[ref.marker]} `
        : "";
    const title = sanitizeTimelineField(
      truncateText(ref.title, MILESTONE_TITLE_CAP),
    );
    return `      ↳ ${markerGlyph}T${ref.promptNumber} ${title}`;
  });
}

function renderMilestoneDigest(view: TimelineView): string[] {
  if (view.milestoneDayGroups.length === 0) {
    return [];
  }

  const lines: string[] = [""];
  for (const group of view.milestoneDayGroups) {
    const contSuffix = group.continued ? " (cont.)" : "";
    lines.push(
      `── ${formatLocalDateWithWeekday(group.labelEpoch)} · T${group.promptLo}–T${group.promptHi} · ${group.keptCount} kept${contSuffix} ──`,
    );
    for (const milestone of group.rows) {
      const glyph = milestone.marker === null ? "  " : MILESTONE_MARKER_GLYPH[milestone.marker];
      const emoji = typeEmoji(milestone.turn.type);
      const title = sanitizeTimelineField(
        truncateText(milestone.turn.title ?? "(untitled)", MILESTONE_TITLE_CAP),
      );
      lines.push(`   ${glyph} T${milestone.turn.promptNumber} ${emoji} ${title}`);
      lines.push(...renderMilestoneReferenceLines(milestone.references ?? []));
    }
    if (group.overflow !== null) {
      lines.push(
        `        … +${group.overflow.count} more → timeline(id="S${view.session.id}", view="turns") @ T${group.overflow.firstPrompt}–T${group.overflow.lastPrompt}`,
      );
    }
  }

  return lines;
}

function renderTurnRows(
  view: TimelineView,
  renderedTurns: Array<{ turn: TurnRecord; marker: string | null }>,
  promptCap: number,
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
    "T# | line | time | gap | stats | prompt → title",
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
    renderTitleCell(turn, isUndone, compactMetadata, marker),
  );

  return [
    `${statusPrefix}T${turn.promptNumber}`,
    formatTranscriptLineAnchor(turn.transcriptLineStart),
    formatLocalTime(turn.createdAtEpoch),
    `${formatGap(turn.createdAtEpoch, prevEpoch)}${gapSuffix}`,
    renderStats(turn),
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
      const body = `${TYPE_EMOJI_MAP[turn.type] ?? "•"} ${truncateText(turn.title, TITLE_COLUMN_CAP - 3)}`;
      return `${markerPrefix}~~${body}~~`;
    }
    return `${markerPrefix}⨯`.trim();
  }

  if (turn.status === "extracted" && turn.type !== null && turn.title !== null) {
    return `${markerPrefix}${TYPE_EMOJI_MAP[turn.type] ?? "•"} ${truncateText(turn.title, TITLE_COLUMN_CAP - 3)}`;
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
    const leadTitle = sanitizeTimelineField(
      truncateText(
        leadText,
        TITLE_COLUMN_CAP,
      ),
    );

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
  const body =
    view.view === "phases"
      ? renderPhases(view)
      : view.view === "milestones"
        ? renderMilestoneDigest(view)
        : renderTurnTable(view, promptCap);

  return [
    ...renderSessionHeader(view),
    ...body,
    ...renderShapeSignals(view),
    ...renderEarlierHint(view, options),
    ...renderLineagePointer(view),
  ].join("\n");
}

export function timelineQuery(db: Database, input: TimelineInput): string {
  try {
    return renderTimeline(buildTimelineView(db, input));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `timeline error: ${message}`;
  }
}
