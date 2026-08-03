import { describe, expect, test } from "bun:test";

import { createDatabase } from "../../src/db/database";
import { replaceTurnCitations } from "../../src/db/citations";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { getTurn } from "../../src/db/turns";
import { estimateDiaryTokens } from "../../src/diary/domain";
import {
  renderMilestoneInjection,
  renderSessionMilestoneInjection,
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

const ERA_BASE = 1_785_000_000;

/** A four-row arc with one pulled antecedent, seeded straight into SQLite. */
function seedInjectionArc(db: ReturnType<typeof createDatabase>): number {
  initializeSchema(db);
  const session = upsertSession(db, {
    contentSessionId: "injection-arc",
    project: "/tmp/claude-mnemo-test",
    title: "injection arc",
    insight: null,
    createdAtEpoch: ERA_BASE,
    updatedAtEpoch: ERA_BASE + 240,
    completedAtEpoch: null,
  });
  const insert = db.query(
    `INSERT INTO turns (
       session_id, prompt_number, status, user_prompt, title, content, type,
       significance_grade, cites_recorded, tool_call_count, created_at_epoch,
       tags, files_read, files_modified
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, '[]', '[]', ?)`,
  );
  const rows: Array<[number, string, string, string, string | null, string, number, number, string]> = [
    [1, "extracted", "卷号锚定要解决什么", "Framed the slicing problem", "Opened the arc and named the downstream consumer.", "decision", 4, 0, '["src/slicing.md"]'],
    [2, "skipped", "取证", "Measured a 12-14% error", null, "discovery", 2, 3, "[]"],
    [3, "extracted", "没有卷数怎么办", "Adopted cursor slicing", "Weighed the evidence and switched the anchor.", "decision", 3, 5, '["src/cursor.ts"]'],
    [4, "extracted", "发布", "0.9.0 released", "Cut the release.", "feature", 2, 1, '["package.json"]'],
  ];
  for (const [promptNumber, status, prompt, title, content, type, grade, tools, files] of rows) {
    insert.run(
      session.id, promptNumber, status, prompt, title, content, type, grade, tools,
      ERA_BASE + promptNumber * 60, files,
    );
  }
  const turnId = (promptNumber: number) => getTurn(db, session.id, promptNumber)!.id;
  replaceTurnCitations(db, turnId(3), [{ id: turnId(2), relation: "evidence-for" }], ERA_BASE);
  return session.id;
}

/**
 * Before-state for ticket 04. The hook's DEFAULT renderer is already the unified
 * one, so SessionStart emits the new row shape today — an accepted deviation,
 * not a regression to undo. Every other test in this file injects a fake
 * renderer and therefore says nothing about what actually ships; this one pins
 * the real combined behavior shallowly, so ticket 04's replacement has something
 * to diff against. It stays deliberately small: the ladder re-renders the whole
 * view once per candidate count, which is quadratic in the milestone count.
 */
describe("renderMilestoneInjection with the real renderer (ticket 04 before-state)", () => {
  test("emits unified spine rows and still walks the degradation ladder", () => {
    const db = createDatabase(":memory:");
    const sessionId = seedInjectionArc(db);

    const roomy = renderSessionMilestoneInjection(db, sessionId, {
      tokenBudget: 4_000,
    });

    // Unified rows: T# · type emoji · grade · prompt → title, plus a ↳ row for
    // the pulled antecedent and the ✏️ file tail. None of this existed on the
    // pre-ticket-03 injection path.
    expect(roomy).toContain("T1 ⚖️ G4 卷号锚定要解决什么 → Framed the slicing problem");
    expect(roomy).toContain("↳ T2 🔵 G2 Measured a 12-14% error");
    expect(roomy).toContain("✏️");
    // Stage 1 fits, so nothing is stripped and no pointer is appended.
    expect(roomy).toContain("shape signals");
    expect(roomy).not.toContain("更多里程碑见");

    // A budget that stage 1 cannot meet drops the shape signals and appends the
    // pointer — the ladder is still the outer mechanism.
    const tight = renderSessionMilestoneInjection(db, sessionId, {
      tokenBudget: 400,
    });
    expect(tight).not.toContain("shape signals");
    expect(tight).toContain('（更多里程碑见 timeline(id="S1")）');
    expect(tight).toContain("T1 ⚖️ G4");
    expect(estimateDiaryTokens(tight)).toBeLessThanOrEqual(400);
  });
});
