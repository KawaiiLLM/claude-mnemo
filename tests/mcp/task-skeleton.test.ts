import { describe, expect, test } from "bun:test";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import type { TurnRecord } from "../../src/db/turns";
import { estimateDiaryTokens } from "../../src/diary/domain";
import {
  buildTaskCausalityReprime,
  renderTaskCausalityReprime,
} from "../../src/mcp/task-skeleton";

function turn(overrides: Partial<TurnRecord>): TurnRecord {
  return {
    id: 1,
    sessionId: 1,
    promptNumber: 1,
    contentPromptId: null,
    transcriptLineStart: null,
    wasInterrupted: false,
    wasRolledBack: false,
    extractionStallAttempts: 0,
    extractionStallRetryAtMs: null,
    extractionStallRetryAfterSeq: null,
    extractionStallRetryMode: null,
    status: "extracted",
    userPrompt: null,
    assistantResponse: null,
    assistantTranscript: null,
    title: "anchor",
    content: null,
    insight: null,
    type: "decision",
    significanceGrade: 3,
    tags: [],
    filesRead: [],
    filesModified: [],
    toolCallCount: 0,
    parentTurnId: null,
    citesRecorded: false,
    createdAtEpoch: 200,
    updatedAtEpoch: null,
    ...overrides,
  };
}

describe("task-causality re-prime skeleton", () => {
  test("groups live anchors by citations and trails legacy, pre-bridge, and casualty rows", () => {
    const cutoff = 200;
    const turns = [
      turn({ id: 1, promptNumber: 1, significanceGrade: 4, title: "legacy origin", createdAtEpoch: cutoff - 2 }),
      turn({ id: 2, promptNumber: 2, significanceGrade: 3, title: "legacy anchor", createdAtEpoch: cutoff - 1 }),
      turn({ id: 3, promptNumber: 3, significanceGrade: 3, title: "pre bridge", createdAtEpoch: cutoff, content: "No trusted foundation exists yet." }),
      turn({ id: 4, promptNumber: 4, significanceGrade: 4, title: "arc alpha", insight: "- Alpha motive and success criteria", createdAtEpoch: cutoff + 1 }),
      turn({ id: 5, promptNumber: 5, significanceGrade: 3, title: "alpha design", content: "Fallback semantic clause from content.", createdAtEpoch: cutoff + 2 }),
      turn({ id: 6, promptNumber: 6, significanceGrade: 4, title: "alpha re-founded", content: "Radically reframes [T4].", createdAtEpoch: cutoff + 3 }),
      turn({ id: 7, promptNumber: 7, significanceGrade: 4, title: "arc beta", createdAtEpoch: cutoff + 4 }),
      turn({ id: 8, promptNumber: 8, significanceGrade: 3, title: "resume alpha", content: "Resumes [T4].", createdAtEpoch: cutoff + 5 }),
      turn({ id: 9, promptNumber: 9, significanceGrade: 3, title: "beta design", createdAtEpoch: cutoff + 6 }),
      turn({ id: 10, promptNumber: 10, significanceGrade: 3, title: "overturned beta", tags: ["rolled-back"], createdAtEpoch: cutoff + 7 }),
    ];

    const output = renderTaskCausalityReprime({
      sessionId: 1,
      sessionState: "[S1] state",
      turns,
      taskCausalityEraCutoffEpoch: cutoff,
    });

    expect(output).toContain("Live G4 foundations:");
    expect(output).toContain("Arc T4 | [dbid:T4] G4 arc alpha — Alpha motive and success criteria");
    expect(output).toContain("Arc T4 | [dbid:T6] G4 re-foundation alpha re-founded");
    expect(output).toContain("Arc T7 | [dbid:T7] G4 arc beta");
    expect(output).toContain("Arc T4 | [dbid:T5] G3 alpha design — Fallback semantic clause from content.");
    expect(output).toContain("Arc T4 | [dbid:T8] G3 resume alpha");
    expect(output).toContain("Arc T7 | [dbid:T9] G3 beta design");
    expect(output).toContain("Legacy / casualties (not trusted backbone):");
    expect(output).toContain("[legacy] [dbid:T1] G4 legacy origin");
    expect(output).toContain("[legacy] [dbid:T2] G3 legacy anchor");
    expect(output).toContain("[pre-bridge] [dbid:T3] G3 pre bridge");
    expect(output).toContain("[casualty] [dbid:T10] G3 overturned beta");
    expect(output.indexOf("Legacy / casualties")).toBeGreaterThan(
      output.indexOf("Live G3 anchors"),
    );
  });

  test("keeps state, every live G4, and each arc's earliest and latest G3 under pressure", () => {
    const cutoff = 200;
    const turns: TurnRecord[] = [];
    let id = 1;
    for (let arc = 0; arc < 2; arc += 1) {
      const originId = id++;
      turns.push(turn({
        id: originId,
        promptNumber: originId,
        significanceGrade: 4,
        title: `origin ${arc}`,
        insight: `- ${"origin semantic ".repeat(8)}`,
        createdAtEpoch: cutoff + originId,
      }));
      for (let anchor = 0; anchor < 6; anchor += 1) {
        const anchorId = id++;
        turns.push(turn({
          id: anchorId,
          promptNumber: anchorId,
          significanceGrade: 3,
          title: `arc ${arc} anchor ${anchor}`,
          insight: `- ${"anchor semantic ".repeat(8)}`,
          createdAtEpoch: cutoff + anchorId,
        }));
      }
    }

    const output = renderTaskCausalityReprime({
      sessionId: 1,
      sessionState: "[S1] CURRENT STATE MUST SURVIVE",
      turns,
      taskCausalityEraCutoffEpoch: cutoff,
      tokenBudget: 800,
    });

    expect(estimateDiaryTokens(output)).toBeLessThanOrEqual(800);
    expect(output).toContain("CURRENT STATE MUST SURVIVE");
    expect(output).toContain("[dbid:T1] G4");
    expect(output).toContain("[dbid:T8] G4");
    expect(output).toContain("[dbid:T2] G3");
    expect(output).toContain("[dbid:T7] G3");
    expect(output).toContain("[dbid:T9] G3");
    expect(output).toContain("[dbid:T14] G3");
    expect(output).toContain('timeline(id="S1")');
  });

  test("jointly caps many mandatory G4s and per-arc G3 pairs with pointer space reserved", () => {
    const cutoff = 200;
    const turns: TurnRecord[] = [];
    const requiredIds: number[] = [];
    const g4Ids: number[] = [];
    let id = 1;
    for (let arc = 0; arc < 12; arc += 1) {
      const originId = id++;
      g4Ids.push(originId);
      turns.push(turn({
        id: originId,
        promptNumber: originId,
        significanceGrade: 4,
        title: `origin ${arc} ${"title ".repeat(12)}`,
        insight: `- ${"origin semantic ".repeat(12)}`,
        createdAtEpoch: cutoff + originId,
      }));
      for (let anchor = 0; anchor < 3; anchor += 1) {
        const anchorId = id++;
        if (anchor === 0 || anchor === 2) requiredIds.push(anchorId);
        turns.push(turn({
          id: anchorId,
          promptNumber: anchorId,
          significanceGrade: 3,
          title: `arc ${arc} anchor ${anchor} ${"title ".repeat(12)}`,
          insight: `- ${"anchor semantic ".repeat(12)}`,
          createdAtEpoch: cutoff + anchorId,
        }));
      }
    }

    const output = renderTaskCausalityReprime({
      sessionId: 1,
      sessionState: `[S1] ${"state ".repeat(400)}`,
      turns,
      taskCausalityEraCutoffEpoch: cutoff,
    });
    expect(estimateDiaryTokens(output)).toBeLessThanOrEqual(4_000);
    for (const g4Id of g4Ids) {
      expect(output).toContain(`[dbid:T${g4Id}] G4`);
    }
    for (const requiredId of requiredIds) {
      expect(output).toContain(`[dbid:T${requiredId}] G3`);
    }
    expect(output).toContain('timeline(id="S1")');
  });

  test("sends a bounded payload with one hundred mandatory live G4 foundations", () => {
    const cutoff = 200;
    const turns = Array.from({ length: 100 }, (_, index) =>
      turn({
        id: index + 1,
        promptNumber: index + 1,
        significanceGrade: 4,
        title: `origin ${index + 1} ${"title ".repeat(12)}`,
        insight: `- ${"semantic ".repeat(16)}`,
        createdAtEpoch: cutoff + index,
      }),
    );

    const output = renderTaskCausalityReprime({
      sessionId: 1,
      sessionState: `[S1] ${"state ".repeat(400)}`,
      turns,
      taskCausalityEraCutoffEpoch: cutoff,
    });
    expect(estimateDiaryTokens(output)).toBeLessThanOrEqual(4_000);
    for (const anchor of turns) {
      expect(output).toContain(`[dbid:T${anchor.id}] G4`);
    }
    expect(output).toContain('timeline(id="S1")');
  });

  test("queries the full session turn set so an early origin survives independently of timeline paging", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    try {
      const sessionId = Number(
        db.query(
          `INSERT INTO sessions (
             content_session_id, project, title, created_at_epoch, updated_at_epoch
           ) VALUES ('skeleton-source', '/tmp/project', 'source', 100, 100)
           RETURNING id`,
        ).get()!.id,
      );
      const insert = db.query(
        `INSERT INTO turns (
           session_id, prompt_number, status, title, content, significance_grade,
           created_at_epoch
         ) VALUES (?, ?, 'extracted', ?, ?, ?, ?)`,
      );
      for (let promptNumber = 1; promptNumber <= 80; promptNumber += 1) {
        insert.run(
          sessionId,
          promptNumber,
          promptNumber === 1 ? "early origin" : `routine ${promptNumber}`,
          `content ${promptNumber}`,
          promptNumber === 1 ? 4 : 1,
          200 + promptNumber,
        );
      }

      const output = buildTaskCausalityReprime(db, {
        sessionId,
        sessionState: `[S${sessionId}] state`,
        taskCausalityEraCutoffEpoch: 200,
      });
      expect(output).toContain("[dbid:T1] G4 early origin");
      expect(output).toContain("Recent turns (bare index):");
      expect(output).toContain("[dbid:T80] G1 routine 80");
      expect(output).not.toContain("content 80");
    } finally {
      db.close();
    }
  });

  test("legacy anchors keep their casualty marker", () => {
    const cutoff = 200;
    const turns = [
      turn({ id: 1, promptNumber: 1, significanceGrade: 4, title: "legacy origin", createdAtEpoch: cutoff - 2 }),
      turn({ id: 2, promptNumber: 2, significanceGrade: 3, title: "legacy overturned", tags: ["rolled-back"], createdAtEpoch: cutoff - 1 }),
      turn({ id: 3, promptNumber: 3, significanceGrade: 4, title: "bridge", createdAtEpoch: cutoff + 1 }),
    ];

    const output = renderTaskCausalityReprime({
      sessionId: 1,
      sessionState: "[S1] state",
      turns,
      taskCausalityEraCutoffEpoch: cutoff,
    });

    expect(output).toContain("[legacy] [dbid:T1] G4 legacy origin");
    expect(output).toContain("[legacy casualty] [dbid:T2] G3 legacy overturned");
  });

  test("compressed anchor rendering counts as omission and emits the pointer", () => {
    const cutoff = 200;
    const longTitle = "anchor title ".repeat(20).trim();
    const longInsight = "compressed semantic clause ".repeat(30).trim();
    const turns = [
      turn({ id: 1, promptNumber: 1, significanceGrade: 4, title: longTitle, insight: longInsight, createdAtEpoch: cutoff + 1 }),
      turn({ id: 2, promptNumber: 2, significanceGrade: 4, title: longTitle, insight: longInsight, createdAtEpoch: cutoff + 2 }),
      turn({ id: 3, promptNumber: 3, significanceGrade: 4, title: longTitle, insight: longInsight, createdAtEpoch: cutoff + 3 }),
    ];

    const output = renderTaskCausalityReprime({
      sessionId: 1,
      sessionState: "[S1] state",
      turns,
      taskCausalityEraCutoffEpoch: cutoff,
      tokenBudget: 160,
    });

    expect(output).toContain('More context: timeline(id="S1")');
  });
});
