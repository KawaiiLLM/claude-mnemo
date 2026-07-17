import { describe, expect, test } from "bun:test";

import { estimateDiaryTokens } from "../../src/diary/domain";
import {
  renderMilestoneInjection,
  type MilestoneTimelineRenderer,
} from "../../src/hooks/milestone-injection";
import type {
  KeptMilestone,
  MilestoneDayGroup,
  TimelineView,
} from "../../src/mcp/timeline";

function kept(promptNumber: number): KeptMilestone {
  return {
    turn: { promptNumber } as KeptMilestone["turn"],
    score: 1,
    marker: null,
  };
}

function milestoneView(groups: number[][]): TimelineView {
  const milestoneDayGroups: MilestoneDayGroup[] = groups.map(
    (promptNumbers, index) => ({
      date: `2026-07-${String(index + 1).padStart(2, "0")}`,
      labelEpoch: 1_700_000_000 + index * 86_400,
      promptLo: promptNumbers[0]!,
      promptHi: promptNumbers.at(-1)!,
      keptCount: promptNumbers.length,
      rows: promptNumbers.map(kept),
      continued: false,
      isFinalSliceForDay: true,
      overflow: null,
    }),
  );
  const pagedMilestones = milestoneDayGroups.flatMap((group) => group.rows);

  return {
    session: { id: 42 },
    milestoneDayGroups,
    pagedMilestones,
  } as TimelineView;
}

const pointer = '（更多里程碑见 timeline(id="S42")）';

describe("renderMilestoneInjection degradation", () => {
  test("drops shape signals first", () => {
    const renderer: MilestoneTimelineRenderer = {
      renderTimeline: () => [
        "milestone core",
        "",
        "  shape signals (window T1-T4):",
        `    - tool bursts: ${"shape ".repeat(200)}`,
      ].join("\n"),
    };
    const budget = estimateDiaryTokens(`milestone core\n\n${pointer}`);

    const output = renderMilestoneInjection(milestoneView([[1, 2, 3, 4]]), {
      renderer,
      tokenBudget: budget,
    });

    expect(output).toBe(`milestone core\n\n${pointer}`);
  });

  test("drops casualty rows only after shape signals", () => {
    const renderer: MilestoneTimelineRenderer = {
      renderTimeline: () => [
        "milestone core",
        `      ↳ T1 ${"casualty ".repeat(200)}`,
        "",
        "  shape signals (window T1-T4):",
        "    - fastest gap: after T1 (+1s)",
      ].join("\n"),
    };
    const budget = estimateDiaryTokens(`milestone core\n\n${pointer}`);

    const output = renderMilestoneInjection(milestoneView([[1, 2, 3, 4]]), {
      renderer,
      tokenBudget: budget,
    });

    expect(output).toBe(`milestone core\n\n${pointer}`);
  });

  test("reduces milestone labels from 80 to 50 even when the renderer ignores promptCap", () => {
    const promptCaps: number[] = [];
    const longTitle = "x".repeat(80);
    const renderer: MilestoneTimelineRenderer = {
      renderTimeline: (_view, options) => {
        promptCaps.push(options.promptCap);
        return [1, 2, 3, 4]
          .map((promptNumber) => `   T${promptNumber} 🟣 ${longTitle}`)
          .join("\n");
      },
    };
    const cappedTitle = `${"x".repeat(50)}…`;
    const expectedCore = [1, 2, 3, 4]
      .map((promptNumber) => `   T${promptNumber} 🟣 ${cappedTitle}`)
      .join("\n");
    const budget = estimateDiaryTokens(`${expectedCore}\n\n${pointer}`);

    const output = renderMilestoneInjection(milestoneView([[1, 2, 3, 4]]), {
      renderer,
      tokenBudget: budget,
    });

    expect(output).toBe(`${expectedCore}\n\n${pointer}`);
    expect(promptCaps).toEqual([80, 80, 80, 50]);
  });

  test("uniformly reduces kept turns last while retaining the oldest day", () => {
    let lastView: TimelineView | undefined;
    const renderer: MilestoneTimelineRenderer = {
      renderTimeline: (view) => {
        lastView = view;
        const prompts = view.pagedMilestones.map(
          (milestone) => `T${milestone.turn.promptNumber}`,
        );
        return `${prompts.join(",")} ${"row ".repeat(prompts.length * 20)}`;
      },
    };
    const expectedCore = `T1,T4 ${"row ".repeat(40)}`.trimEnd();
    const budget = estimateDiaryTokens(`${expectedCore}\n\n${pointer}`);

    const output = renderMilestoneInjection(milestoneView([[1, 2], [3, 4]]), {
      renderer,
      tokenBudget: budget,
    });

    expect(output).toBe(`${expectedCore}\n\n${pointer}`);
    expect(output).toContain("T1");
    expect(output).toContain("T4");
    expect(lastView?.milestoneDayGroups.map((group) => ({
      keptCount: group.keptCount,
      promptLo: group.promptLo,
      promptHi: group.promptHi,
    }))).toEqual([
      { keptCount: 1, promptLo: 1, promptHi: 1 },
      { keptCount: 1, promptLo: 4, promptHi: 4 },
    ]);
  });
});
