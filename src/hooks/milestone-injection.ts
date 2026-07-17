import type { Database } from "bun:sqlite";

import { estimateDiaryTokens } from "../diary/domain";
import {
  buildTimelineView,
  renderTimeline,
  truncateText,
  type KeptMilestone,
  type TimelineView,
} from "../mcp/timeline";

export const MILESTONE_INJECTION_TOKEN_BUDGET = 2_000;
const FULL_PROMPT_CAP = 80;
const REDUCED_PROMPT_CAP = 50;

export interface MilestoneTimelineRenderer {
  renderTimeline: (
    view: TimelineView,
    options: { promptCap: number; showEarlierHint: boolean },
  ) => string;
}

export interface RenderMilestoneInjectionOptions {
  renderer?: MilestoneTimelineRenderer;
  tokenBudget?: number;
}

const defaultRenderer: MilestoneTimelineRenderer = {
  renderTimeline,
};

function overflowPointer(sessionId: number): string {
  return `（更多里程碑见 timeline(id="S${sessionId}")）`;
}

function stripShapeSignals(output: string): string {
  const lines = output.split("\n");
  const kept: string[] = [];
  let insideShapeSignals = false;

  for (const line of lines) {
    if (line.startsWith("  shape signals (")) {
      if (kept.at(-1) === "") {
        kept.pop();
      }
      insideShapeSignals = true;
      continue;
    }
    if (insideShapeSignals && line.startsWith("    - ")) {
      continue;
    }
    if (insideShapeSignals) {
      insideShapeSignals = false;
    }
    kept.push(line);
  }

  return kept.join("\n").trimEnd();
}

function stripCasualtyRows(output: string): string {
  return output
    .split("\n")
    .filter((line) => !/^\s*↳\s/.test(line))
    .join("\n")
    .trimEnd();
}

function truncateMilestoneLabels(output: string, promptCap: number): string {
  return output
    .split("\n")
    .map((line) => {
      const match = line.match(
        /^(\s+(?:(?:🚫|↩️|🏁)\s+)?T\d+\s+\S+\s+)(.+)$/,
      );
      if (!match) {
        return line;
      }
      return `${match[1]}${truncateText(match[2]!, promptCap)}`;
    })
    .join("\n");
}

function appendOverflowPointer(output: string, sessionId: number): string {
  const core = output.trimEnd();
  const pointer = overflowPointer(sessionId);
  return core ? `${core}\n\n${pointer}` : pointer;
}

function evenlySpacedMilestones(
  milestones: readonly KeptMilestone[],
  count: number,
): KeptMilestone[] {
  if (count <= 0 || milestones.length === 0) {
    return [];
  }
  if (count >= milestones.length) {
    return [...milestones];
  }
  if (count === 1) {
    return [milestones[0]!];
  }

  return Array.from({ length: count }, (_, index) => {
    const sourceIndex = Math.round(
      index * (milestones.length - 1) / (count - 1),
    );
    return milestones[sourceIndex]!;
  });
}

function withMilestoneCount(view: TimelineView, count: number): TimelineView {
  const pagedMilestones = evenlySpacedMilestones(
    view.pagedMilestones,
    count,
  );
  const retained = new Set(pagedMilestones);
  const milestoneDayGroups = view.milestoneDayGroups
    .map((group) => {
      const rows = group.rows.filter((milestone) => retained.has(milestone));
      const prompts = rows.map((milestone) => milestone.turn.promptNumber);
      return {
        ...group,
        rows,
        keptCount: rows.length,
        promptLo: Math.min(...prompts),
        promptHi: Math.max(...prompts),
      };
    })
    .filter((group) => group.rows.length > 0);

  return {
    ...view,
    pagedMilestones,
    milestoneDayGroups,
  };
}

function renderCandidate(
  view: TimelineView,
  renderer: MilestoneTimelineRenderer,
  options: {
    promptCap: number;
    includeShapeSignals: boolean;
    includeCasualtyRows: boolean;
    includeOverflowPointer: boolean;
  },
): string {
  let output = renderer.renderTimeline(view, {
    promptCap: options.promptCap,
    showEarlierHint: false,
  });
  output = truncateMilestoneLabels(output, options.promptCap);
  if (!options.includeShapeSignals) {
    output = stripShapeSignals(output);
  }
  if (!options.includeCasualtyRows) {
    output = stripCasualtyRows(output);
  }
  return options.includeOverflowPointer
    ? appendOverflowPointer(output, view.session.id)
    : output;
}

export function renderMilestoneInjection(
  view: TimelineView,
  options: RenderMilestoneInjectionOptions = {},
): string {
  const renderer = options.renderer ?? defaultRenderer;
  const tokenBudget =
    options.tokenBudget ?? MILESTONE_INJECTION_TOKEN_BUDGET;
  const stages = [
    {
      promptCap: FULL_PROMPT_CAP,
      includeShapeSignals: true,
      includeCasualtyRows: true,
      includeOverflowPointer: false,
    },
    {
      promptCap: FULL_PROMPT_CAP,
      includeShapeSignals: false,
      includeCasualtyRows: true,
      includeOverflowPointer: true,
    },
    {
      promptCap: FULL_PROMPT_CAP,
      includeShapeSignals: false,
      includeCasualtyRows: false,
      includeOverflowPointer: true,
    },
    {
      promptCap: REDUCED_PROMPT_CAP,
      includeShapeSignals: false,
      includeCasualtyRows: false,
      includeOverflowPointer: true,
    },
  ] as const;

  for (const stage of stages) {
    const candidate = renderCandidate(view, renderer, stage);
    if (estimateDiaryTokens(candidate) <= tokenBudget) {
      return candidate;
    }
  }

  for (
    let count = view.pagedMilestones.length - 1;
    count >= 0;
    count -= 1
  ) {
    const candidate = renderCandidate(
      withMilestoneCount(view, count),
      renderer,
      stages[3],
    );
    if (estimateDiaryTokens(candidate) <= tokenBudget) {
      return candidate;
    }
  }

  const pointer = overflowPointer(view.session.id);
  return estimateDiaryTokens(pointer) <= tokenBudget ? pointer : "";
}

export function renderSessionMilestoneInjection(
  db: Database,
  sessionId: number,
  options: RenderMilestoneInjectionOptions = {},
): string {
  const view = buildTimelineView(db, {
    id: `S${sessionId}`,
    view: "milestones",
    pageSize: Number.MAX_SAFE_INTEGER,
  });
  return renderMilestoneInjection(view, options);
}
