import type { Database } from "bun:sqlite";

import { getTurnsForSession, type TurnRecord } from "../db/turns";
import { estimateDiaryTokens } from "../diary/domain";
import { isTaskCausalityEra } from "../task-causality-era";
import { parseContentReferences } from "./timeline";

export const TASK_CAUSALITY_REPRIME_TOKEN_BUDGET = 4_000;
const RECENT_TURN_LIMIT = 30;
const ANCHOR_TITLE_CODE_POINT_CAP = 72;
const ANCHOR_SEMANTIC_CODE_POINT_CAP = 120;
const ANCHOR_COMPRESSION_LEVELS = [
  { title: ANCHOR_TITLE_CODE_POINT_CAP, semantic: ANCHOR_SEMANTIC_CODE_POINT_CAP },
  { title: 32, semantic: 48 },
  { title: 1, semantic: 1 },
] as const;

export interface TaskCausalityReprimeInput {
  sessionId: number;
  sessionState: string;
  turns: TurnRecord[];
  taskCausalityEraCutoffEpoch?: number;
  tokenBudget?: number;
}

export type BuildTaskCausalityReprimeInput = Omit<
  TaskCausalityReprimeInput,
  "turns"
>;

interface LiveG4 {
  turn: TurnRecord;
  arcId: number;
  reFoundation: boolean;
}

interface LiveG3 {
  turn: TurnRecord;
  arcId: number;
}

interface TrailingAnchor {
  turn: TurnRecord;
  marker: "legacy" | "legacy casualty" | "pre-bridge" | "casualty";
}

function capCodePoints(value: string, max: number): string {
  const codePoints = Array.from(value);
  return codePoints.length <= max
    ? value
    : `${codePoints.slice(0, Math.max(0, max - 1)).join("")}…`;
}

function cleanInline(value: string): string {
  return value
    .split("\n")
    .map((line) => line.trim().replace(/^-\s*/, ""))
    .filter(Boolean)
    .join("; ")
    .replace(/\s+/g, " ")
    .trim();
}

type AnchorCompression = (typeof ANCHOR_COMPRESSION_LEVELS)[number];

function anchorSemantic(
  turn: TurnRecord,
  cap: number = ANCHOR_SEMANTIC_CODE_POINT_CAP,
): string {
  const insight = cleanInline(turn.insight ?? "");
  const fallback = cleanInline(turn.content ?? "");
  return capCodePoints(
    insight || fallback || "No compressed semantics stored.",
    cap,
  );
}

function anchorTitle(
  turn: TurnRecord,
  cap: number = ANCHOR_TITLE_CODE_POINT_CAP,
): string {
  return capCodePoints(
    cleanInline(turn.title ?? "") || "(untitled)",
    cap,
  );
}

function isCasualty(turn: TurnRecord): boolean {
  return (
    turn.wasInterrupted ||
    turn.wasRolledBack ||
    turn.status === "undone" ||
    turn.tags.includes("rolled-back")
  );
}

function renderAnchor(
  turn: TurnRecord,
  options: { arcId?: number; marker?: string } = {},
  compression: AnchorCompression = ANCHOR_COMPRESSION_LEVELS[0],
): string {
  const minimallyCompressed = compression.title === 1 && compression.semantic === 1;
  const arc = options.arcId === undefined
    ? ""
    : minimallyCompressed
      ? `A${options.arcId}|`
      : `Arc T${options.arcId} | `;
  const prefixMarker = options.marker?.startsWith("[")
    ? `${options.marker} `
    : "";
  const inlineMarker = options.marker && !options.marker.startsWith("[")
    ? `${minimallyCompressed ? "R" : options.marker} `
    : "";
  return `${arc}${prefixMarker}[dbid:T${turn.id}] G${turn.significanceGrade} ${inlineMarker}${anchorTitle(turn, compression.title)} — ${anchorSemantic(turn, compression.semantic)}`;
}

function findCitedTrustedFoundation(
  turn: TurnRecord,
  trustedG4ById: Map<number, TurnRecord>,
): TurnRecord | undefined {
  return parseContentReferences(turn.content, 8)
    .map((id) => trustedG4ById.get(id))
    .find((cited) => cited !== undefined && cited.promptNumber < turn.promptNumber);
}

function groupAnchors(
  turns: TurnRecord[],
  cutoffEpoch?: number,
): { liveG4: LiveG4[]; liveG3: LiveG3[]; trailing: TrailingAnchor[] } {
  const anchors = [...turns]
    .filter((turn) => turn.significanceGrade === 4 || turn.significanceGrade === 3)
    .sort((left, right) =>
      left.promptNumber !== right.promptNumber
        ? left.promptNumber - right.promptNumber
        : left.id - right.id,
    );
  const trustedG4ArcById = new Map<number, number>();
  const trustedG4ById = new Map<number, TurnRecord>();
  const liveG4: LiveG4[] = [];
  const liveG3Candidates: TurnRecord[] = [];
  const trailing: TrailingAnchor[] = [];

  for (const turn of anchors) {
    if (!isTaskCausalityEra(turn.createdAtEpoch, cutoffEpoch)) {
      trailing.push({
        turn,
        marker: isCasualty(turn) ? "legacy casualty" : "legacy",
      });
      continue;
    }
    if (isCasualty(turn)) {
      trailing.push({ turn, marker: "casualty" });
      continue;
    }
    if (turn.significanceGrade === 3) {
      liveG3Candidates.push(turn);
      continue;
    }

    const citedFoundation = findCitedTrustedFoundation(turn, trustedG4ById);
    const arcId = citedFoundation
      ? trustedG4ArcById.get(citedFoundation.id)!
      : turn.id;
    trustedG4ArcById.set(turn.id, arcId);
    trustedG4ById.set(turn.id, turn);
    liveG4.push({ turn, arcId, reFoundation: citedFoundation !== undefined });
  }

  const liveG3: LiveG3[] = [];
  for (const turn of liveG3Candidates) {
    const citedFoundation = findCitedTrustedFoundation(turn, trustedG4ById);
    const nearestFoundation = [...liveG4]
      .reverse()
      .find((foundation) => foundation.turn.promptNumber < turn.promptNumber);
    const arcId = citedFoundation
      ? trustedG4ArcById.get(citedFoundation.id)
      : nearestFoundation?.arcId;
    if (arcId === undefined) {
      trailing.push({ turn, marker: "pre-bridge" });
    } else {
      liveG3.push({ turn, arcId });
    }
  }

  trailing.sort((left, right) => left.turn.promptNumber - right.turn.promptNumber);
  return { liveG4, liveG3, trailing };
}

function renderSection(heading: string, lines: string[]): string {
  return [heading, ...lines.map((line) => `- ${line}`)].join("\n");
}

function joinParts(parts: string[]): string {
  return parts.filter(Boolean).join("\n\n");
}

function requiredG3Anchors(liveG3: LiveG3[]): LiveG3[] {
  const byArc = new Map<number, LiveG3[]>();
  for (const anchor of liveG3) {
    const entries = byArc.get(anchor.arcId) ?? [];
    entries.push(anchor);
    byArc.set(anchor.arcId, entries);
  }

  const required = new Map<number, LiveG3>();
  for (const anchors of byArc.values()) {
    required.set(anchors[0]!.turn.id, anchors[0]!);
    required.set(anchors[anchors.length - 1]!.turn.id, anchors[anchors.length - 1]!);
  }
  return [...required.values()].sort(
    (left, right) => left.turn.promptNumber - right.turn.promptNumber,
  );
}

function bareRecentTurnLine(turn: TurnRecord): string {
  const grade = turn.significanceGrade === null ? "?" : String(turn.significanceGrade);
  return `[dbid:T${turn.id}] G${grade} ${anchorTitle(turn)}`;
}

export function renderTaskCausalityReprime(
  input: TaskCausalityReprimeInput,
): string {
  const tokenBudget = input.tokenBudget ?? TASK_CAUSALITY_REPRIME_TOKEN_BUDGET;
  const pointer = `More context: timeline(id="S${input.sessionId}")`;
  const { liveG4, liveG3, trailing } = groupAnchors(
    input.turns,
    input.taskCausalityEraCutoffEpoch,
  );
  const parts = [input.sessionState];
  let omitted = false;
  const fitsWithReservedPointer = (candidateParts: string[]): boolean =>
    estimateDiaryTokens(joinParts([...candidateParts, pointer])) <= tokenBudget;

  const requiredG3 = requiredG3Anchors(liveG3);
  const renderG4Section = (compression: AnchorCompression): string =>
    renderSection(
      "Live G4 foundations:",
      liveG4.map((foundation) =>
        renderAnchor(
          foundation.turn,
          {
            arcId: foundation.arcId,
            marker: foundation.reFoundation ? "re-foundation" : undefined,
          },
          compression,
        ),
      ),
    );
  const renderG3Section = (
    anchors: LiveG3[],
    compression: AnchorCompression,
  ): string =>
    renderSection(
      "Live G3 anchors:",
      anchors.map((anchor) =>
        renderAnchor(anchor.turn, { arcId: anchor.arcId }, compression),
      ),
    );
  const mandatoryPartsFor = (compression: AnchorCompression): string[] => [
    input.sessionState,
    ...(liveG4.length > 0 ? [renderG4Section(compression)] : []),
    ...(requiredG3.length > 0
      ? [renderG3Section(requiredG3, compression)]
      : []),
  ];
  const compression = ANCHOR_COMPRESSION_LEVELS.find((level) =>
    fitsWithReservedPointer(mandatoryPartsFor(level)),
  );
  if (!compression) {
    throw new RangeError(
      `Task-causality re-prime mandatory state and anchors exceed ${tokenBudget} tokens.`,
    );
  }
  if (compression !== ANCHOR_COMPRESSION_LEVELS[0]) {
    // Compressed anchor text is omitted content: the pointer must appear.
    omitted = true;
  }

  if (liveG4.length > 0) {
    parts.push(renderG4Section(compression));
  }

  if (liveG3.length > 0) {
    const fullSection = renderG3Section(liveG3, compression);
    if (fitsWithReservedPointer([...parts, fullSection])) {
      parts.push(fullSection);
    } else {
      omitted = true;
      const selected = [...requiredG3];
      const requiredIds = new Set(selected.map((anchor) => anchor.turn.id));
      const extras = liveG3
        .filter((anchor) => !requiredIds.has(anchor.turn.id))
        .sort((left, right) => right.turn.promptNumber - left.turn.promptNumber);
      for (const anchor of extras) {
        const candidate = [...selected, anchor];
        if (
          fitsWithReservedPointer([
            ...parts,
            renderG3Section(candidate, compression),
          ])
        ) {
          selected.push(anchor);
        }
      }
      parts.push(renderG3Section(selected, compression));
    }
  }

  if (trailing.length > 0) {
    const selected: TrailingAnchor[] = [];
    const sectionFor = (anchors: TrailingAnchor[]): string =>
      renderSection(
        "Legacy / casualties (not trusted backbone):",
        anchors.map((anchor) =>
          renderAnchor(
            anchor.turn,
            { marker: `[${anchor.marker}]` },
            compression,
          ),
        ),
      );
    for (const anchor of trailing) {
      if (fitsWithReservedPointer([...parts, sectionFor([...selected, anchor])])) {
        selected.push(anchor);
      } else {
        omitted = true;
      }
    }
    if (selected.length > 0) {
      parts.push(sectionFor(selected));
    }
  }

  const recentTurns = [...input.turns]
    .sort((left, right) => left.promptNumber - right.promptNumber)
    .slice(-RECENT_TURN_LIMIT);
  if (recentTurns.length > 0) {
    const selected: TurnRecord[] = [];
    const sectionFor = (turns: TurnRecord[]): string =>
      renderSection("Recent turns (bare index):", turns.map(bareRecentTurnLine));
    for (const turn of [...recentTurns].reverse()) {
      if (fitsWithReservedPointer([...parts, sectionFor([...selected, turn])])) {
        selected.push(turn);
      } else {
        omitted = true;
      }
    }
    if (selected.length > 0) {
      selected.reverse();
      parts.push(sectionFor(selected));
    }
  }

  if (omitted) {
    parts.push(pointer);
  }
  return joinParts(parts);
}

export function buildTaskCausalityReprime(
  db: Database,
  input: BuildTaskCausalityReprimeInput,
): string {
  return renderTaskCausalityReprime({
    ...input,
    turns: getTurnsForSession(db, input.sessionId),
  });
}
