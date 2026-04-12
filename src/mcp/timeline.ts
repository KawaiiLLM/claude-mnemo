import type { Database } from "bun:sqlite";
import { getSession, type SessionRecord } from "../db/sessions";
import { getTurnsForSession, type TurnRecord } from "../db/turns";
import { resolveTranscriptPath } from "../shared/paths";

export interface TimelineInput {
  id: string;
}

export interface TimelineView {
  session: SessionRecord;
  totalTurns: number;
  totalToolCalls: number;
  typesDistribution: TypesDistribution;
  compactBoundaries: number[];
  phases: Phase[];
  window: ResolvedWindow;
  windowTurns: TurnRecord[];
  windowSignals: ShapeSignals;
  jsonlPath: string | null;
  tz: { name: string; offsetLabel: string };
}

export const TIMELINE_WINDOW_CAP = 30;
export const PROMPT_COLUMN_CAP = 200;
export const TITLE_COLUMN_CAP = 40;
export const BROKEN_PROMPT_MIN_PREFIX = 20;
export const BROKEN_PROMPT_MAX_GAP_MS = 5 * 60 * 1000;
export const TOOL_BURST_TOP_N = 3;

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
  requestedEnd: number | null;
  hadExplicitEnd: boolean;
  totalTurns: number;
}

export interface Phase {
  kind: "typed" | "pending";
  type: string | null;
  emoji: string;
  startPromptNumber: number;
  endPromptNumber: number;
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

export function resolveWindow(
  range: RangeSpec,
  totalTurns: number,
): ResolvedWindow {
  if (totalTurns === 0) {
    return {
      startPromptNumber: 1,
      endPromptNumber: 0,
      requestedEnd: null,
      hadExplicitEnd: false,
      totalTurns: 0,
    };
  }

  if (range.kind === "none" || range.kind === "all") {
    return {
      startPromptNumber: 1,
      endPromptNumber: Math.min(TIMELINE_WINDOW_CAP, totalTurns),
      requestedEnd: null,
      hadExplicitEnd: false,
      totalTurns,
    };
  }

  if (range.kind === "closed") {
    validateClosedRange(range);
    const startPromptNumber = Math.max(1, range.start);
    if (startPromptNumber > totalTurns) {
      throw new Error(
        `timeline range starts beyond session end: start prompt ${startPromptNumber} exceeds session length ${totalTurns}`,
      );
    }
    const endPromptNumber = Math.min(
      range.end,
      startPromptNumber + TIMELINE_WINDOW_CAP - 1,
      totalTurns,
    );

    return {
      startPromptNumber,
      endPromptNumber,
      requestedEnd: endPromptNumber < range.end ? range.end : null,
      hadExplicitEnd: true,
      totalTurns,
    };
  }

  if (range.kind === "openEnd") {
    validateOpenEndRange(range);
    const startPromptNumber = Math.max(1, range.start);
    if (startPromptNumber > totalTurns) {
      throw new Error(
        `timeline range starts beyond session end: start prompt ${startPromptNumber} exceeds session length ${totalTurns}`,
      );
    }

    return {
      startPromptNumber,
      endPromptNumber: Math.min(
        startPromptNumber + TIMELINE_WINDOW_CAP - 1,
        totalTurns,
      ),
      requestedEnd: null,
      hadExplicitEnd: false,
      totalTurns,
    };
  }

  if (range.kind === "openStart") {
    validateOpenStartRange(range);
    const endPromptNumber = Math.min(range.end, TIMELINE_WINDOW_CAP, totalTurns);

    return {
      startPromptNumber: 1,
      endPromptNumber,
      requestedEnd: endPromptNumber < range.end ? range.end : null,
      hadExplicitEnd: true,
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

export function getSystemTimezone(): { name: string; offsetLabel: string } {
  const ianaName = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ianaName,
    timeZoneName: "short",
  }).formatToParts(new Date());
  const name = parts.find((part) => part.type === "timeZoneName")?.value ?? ianaName;

  const offsetMinutes = -new Date().getTimezoneOffset();
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

export function segmentPhases(turns: TurnRecord[]): Phase[] {
  const sortedTurns = sortTurnsForAnalysis(turns);
  const phases: Phase[] = [];
  let current: Phase | null = null;
  let currentStartEpoch = 0;
  let currentEndEpoch = 0;

  for (const turn of sortedTurns) {
    if (turn.status === "undone") {
      continue;
    }

    const kind: Phase["kind"] = turn.type === null ? "pending" : "typed";
    const emoji =
      turn.type === null ? PENDING_EMOJI : (TYPE_EMOJI_MAP[turn.type] ?? "•");

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
    if (turn.status === "undone") {
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
    (turn) => turn.status !== "undone",
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
  const liveTurns = sortedTurns.filter((turn) => turn.status !== "undone");
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

export function buildTimelineView(
  db: Database,
  input: TimelineInput,
): TimelineView {
  const parsed = parseTimelineId(input.id);
  const session = getSession(db, parsed.sessionId);

  if (!session) {
    throw new Error(`timeline: session S${parsed.sessionId} not found`);
  }

  const allTurns = getTurnsForSession(db, session.id);
  const totalTurns = allTurns.length;
  const totalToolCalls = allTurns.reduce(
    (sum, turn) => sum + (turn.toolCallCount ?? 0),
    0,
  );
  const window = resolveWindow(parsed.range, totalTurns);
  const windowTurns = allTurns.filter(
    (turn) =>
      turn.promptNumber >= window.startPromptNumber &&
      turn.promptNumber <= window.endPromptNumber,
  );
  const phases = segmentPhases(allTurns);
  const typesDistribution = computeTypesDistribution(allTurns);
  const windowSignals = detectShapeSignals(windowTurns);
  const compactBoundaries =
    session.lastCompactTurn === null ? [] : [session.lastCompactTurn];
  const jsonlPath =
    resolveTranscriptPath(session.project, session.contentSessionId) ?? null;
  const tz = getSystemTimezone();

  return {
    session,
    totalTurns,
    totalToolCalls,
    typesDistribution,
    compactBoundaries,
    phases,
    window,
    windowTurns,
    windowSignals,
    jsonlPath,
    tz,
  };
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

  return [
    `- [S${view.session.id}] ${formatLocalDate(sessionStart)} ${formatLocalTime(sessionStart)} → ${formatLocalTime(sessionEnd)} (${formatDuration((sessionEnd - sessionStart) * 1000)}${compactSuffix})`,
    `  ${view.session.project} | ${view.totalTurns} turns | ${view.totalToolCalls} tool_calls`,
    `  types: ${typesParts.join(" ")} (session-wide)`,
    `  showing: ${formatShowingLine(view)}`,
    `  tz: ${view.tz.name} (${view.tz.offsetLabel})`,
    `  raw: ${view.jsonlPath ?? "(unresolved)"}`,
  ];
}

function formatShowingLine(view: TimelineView): string {
  if (view.totalTurns === 0) {
    return "T0-T0 of 0 (empty)";
  }

  const base = `T${view.window.startPromptNumber}-T${view.window.endPromptNumber} of ${view.totalTurns}`;
  const atEnd = view.window.endPromptNumber >= view.totalTurns;

  if (view.window.requestedEnd !== null) {
    const rows = view.window.endPromptNumber - view.window.startPromptNumber + 1;
    const nextParts =
      atEnd
        ? []
        : [
            `next: T${view.window.endPromptNumber + 1}..${Math.min(view.window.endPromptNumber + TIMELINE_WINDOW_CAP, view.totalTurns)}`,
          ];

    return `${base} (requested T${view.window.startPromptNumber}..${view.window.requestedEnd}, truncated to ${rows} rows${nextParts.length > 0 ? `; ${nextParts[0]}` : ""})`;
  }

  if (atEnd) {
    return `${base} (end)`;
  }

  const nextStart = view.window.endPromptNumber + 1;
  const nextEnd = Math.min(nextStart + TIMELINE_WINDOW_CAP - 1, view.totalTurns);
  return `${base} (next: T${nextStart}..${nextEnd})`;
}

function renderTurnTable(view: TimelineView): string[] {
  if (view.windowTurns.length === 0) {
    return [];
  }

  const brokenPromptCandidates = new Set<number>();
  for (const pair of view.windowSignals.brokenPromptPairs) {
    brokenPromptCandidates.add(pair.first);
    brokenPromptCandidates.add(pair.second);
  }

  const lines = [
    "",
    "  T#    time    gap          stats          prompt                                                                                                                                                                                                          title",
    "  ───   ─────   ─────────    ────────────   ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────   ────────────────────────────────────────",
  ];

  let prevEpoch: number | null = null;
  for (const turn of view.windowTurns) {
    lines.push(
      renderTurnRow(
        turn,
        prevEpoch,
        brokenPromptCandidates.has(turn.promptNumber),
      ),
    );
    prevEpoch = turn.createdAtEpoch;
  }

  return lines;
}

function renderTurnRow(
  turn: TurnRecord,
  prevEpoch: number | null,
  isBrokenPromptCandidate: boolean,
): string {
  const isUndone = turn.status === "undone";
  const gapSuffix = isBrokenPromptCandidate ? " ※" : "";
  const sourceBadges = extractSourceTags(turn.tags)
    .map((source) => `[ext:${source}]`)
    .join(" ");
  const promptCore = cleanPromptForLabel(turn.userPrompt);
  const promptWithBadges =
    sourceBadges.length > 0 ? `${sourceBadges} ${promptCore}` : promptCore;
  const promptText = truncateText(promptWithBadges, PROMPT_COLUMN_CAP);
  const renderedPrompt = isUndone ? `~~${promptText}~~` : promptText;

  return `  ${`${isUndone ? "⨯ " : ""}T${turn.promptNumber}`.padEnd(4)}  ${formatLocalTime(turn.createdAtEpoch)}   ${`${formatGap(turn.createdAtEpoch, prevEpoch)}${gapSuffix}`.padEnd(12)} ${renderStats(turn).padEnd(14)}   ${renderedPrompt.padEnd(PROMPT_COLUMN_CAP)}   ${renderTitleCell(turn, isUndone)}`;
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

function renderTitleCell(turn: TurnRecord, isUndone: boolean): string {
  if (turn.type !== null && turn.title !== null) {
    const body = `${TYPE_EMOJI_MAP[turn.type] ?? "•"} ${truncateText(turn.title, TITLE_COLUMN_CAP - 3)}`;
    return isUndone ? `~~${body}~~` : body;
  }

  return isUndone ? "⨯" : "⏳";
}

function renderPhases(view: TimelineView): string[] {
  if (view.phases.length === 0) {
    return [];
  }

  const lines = ["", "  phases (session-wide):"];

  for (const [index, phase] of view.phases.entries()) {
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

    lines.push(
      `    ${String(index + 1)}. ${phase.emoji} ${(phase.kind === "pending" ? "pending" : phase.type ?? "").padEnd(10)} ${range.padEnd(8)} ${durationLabel.padEnd(7)} ${countsLabel.padEnd(7)} ${stats.join(" ").padEnd(14)}${extSuffix}`.trimEnd(),
    );
  }

  return lines;
}

function renderShapeSignals(view: TimelineView): string[] {
  const windowLabel =
    view.window.startPromptNumber === 1 &&
    view.window.endPromptNumber === view.window.totalTurns
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

export function renderTimeline(view: TimelineView): string {
  return [
    ...renderSessionHeader(view),
    ...renderTurnTable(view),
    ...renderPhases(view),
    ...renderShapeSignals(view),
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
