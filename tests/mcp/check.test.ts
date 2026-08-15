import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { updateTurnById } from "../../src/db/turns";
import { upsertSession } from "../../src/db/sessions";
import { checkTool } from "../../src/mcp/check";

function resultText(result: { content: Array<{ text: string }> }): string {
  return result.content[0]!.text;
}

interface SeedTurnInput {
  promptNumber: number;
  status?: "active" | "provisional" | "extracted" | "skipped" | "failed" | "undone";
  userPrompt?: string | null;
  title?: string | null;
  content?: string | null;
  type?: string[];
  significanceGrade?: number | null;
}

describe("check tool (spec G8/G9, ticket 08)", () => {
  let db: Database;
  let sessionId: number;
  let nextEpoch = 100;

  function seedTurn(input: SeedTurnInput): number {
    nextEpoch += 1;
    return db
      .query<
        { id: number },
        [number, number, string, string | null, string | null, string | null, string, number | null]
      >(
        `INSERT INTO turns (
           session_id, prompt_number, status, user_prompt, title, content, type,
           significance_grade, created_at_epoch
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id`,
      )
      .get(
        sessionId,
        input.promptNumber,
        input.status ?? "active",
        input.userPrompt ?? "do the thing",
        input.title ?? null,
        input.content ?? null,
        JSON.stringify(input.type ?? []),
        input.significanceGrade ?? null,
        nextEpoch,
      )!.id;
  }

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "check-session",
      project: "claude-mnemo",
      title: "Check session",
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  test("rejects a missing or malformed id", () => {
    expect(resultText(checkTool(db, {}))).toStartWith("Parameter error:");
    expect(resultText(checkTool(db, { id: 42 }))).toStartWith("Parameter error:");
    expect(resultText(checkTool(db, { id: "not-an-address" }))).toStartWith(
      "Parameter error:",
    );
  });

  test("reports nothing owed when every eligible turn is typed or skipped", () => {
    seedTurn({ promptNumber: 1, type: ["design"] });
    seedTurn({ promptNumber: 2, status: "skipped" });
    seedTurn({ promptNumber: 3, userPrompt: "/compact", type: ["compact"] });

    const text = resultText(checkTool(db, { id: `S${sessionId}` }));
    expect(text).toContain("nothing owed");
  });

  // Acceptance criterion 5: reports WHAT is missing, never why.
  test("reports missing turns as bare addresses, without explaining why any of them is a gap", () => {
    seedTurn({ promptNumber: 1, type: ["design"] }); // covered
    seedTurn({ promptNumber: 2 }); // gap: empty type
    seedTurn({ promptNumber: 3, status: "undone" }); // gap: eligible sidechain, empty type

    const text = resultText(checkTool(db, { id: `S${sessionId}` }));

    expect(text).toContain(`S${sessionId}/T2`);
    expect(text).toContain(`S${sessionId}/T3`);
    expect(text).not.toContain(`S${sessionId}/T1`);
    expect(text).toContain("2");

    // "Never why": no mechanism word leaks into the report. The agent already
    // knows why a turn is a gap; this tool states only which ones are.
    for (const mechanismWord of ["empty", "type field", "declined", "mechanical", "floor"]) {
      expect(text.toLowerCase()).not.toContain(mechanismWord.toLowerCase());
    }
  });

  test("excludes a compact marker and a no-reply slash command, includes a sidechain turn", () => {
    seedTurn({ promptNumber: 1, userPrompt: "/compact", type: ["compact"] });
    seedTurn({
      promptNumber: 2,
      userPrompt: "<local-command-stdout>ok</local-command-stdout>",
    });
    seedTurn({ promptNumber: 3, status: "undone" });

    const text = resultText(checkTool(db, { id: `S${sessionId}` }));

    expect(text).not.toContain(`T1`);
    expect(text).not.toContain(`T2`);
    expect(text).toContain(`S${sessionId}/T3`);
  });

  test("a filled type clears a previously reported gap", () => {
    const turnId = seedTurn({ promptNumber: 1 });
    expect(resultText(checkTool(db, { id: `S${sessionId}` }))).toContain(
      `S${sessionId}/T1`,
    );

    updateTurnById(db, turnId, { type: ["fix"], updatedAtEpoch: nextEpoch });

    expect(resultText(checkTool(db, { id: `S${sessionId}` }))).toContain("nothing owed");
  });

  // Acceptance criterion 6 (spec G9): the per-grade histogram must not be
  // visible to the grading agent at any point in its run — including here.
  test("the per-grade histogram appears nowhere in the check tool's output", () => {
    // A distinct, non-degenerate distribution: if a histogram leaked into the
    // report in any recognisable shape, one of these counts or grade labels
    // would show up in the text.
    seedTurn({ promptNumber: 1, significanceGrade: 0, type: ["fix"] });
    seedTurn({ promptNumber: 2, significanceGrade: 1 }); // gap
    seedTurn({ promptNumber: 3, significanceGrade: 1 }); // gap
    seedTurn({ promptNumber: 4, significanceGrade: 2 }); // gap
    seedTurn({ promptNumber: 5, significanceGrade: 4, type: ["design"] });

    const text = resultText(checkTool(db, { id: `S${sessionId}` }));

    expect(text.toLowerCase()).not.toContain("histogram");
    expect(text.toLowerCase()).not.toContain("grade");
    // No "G<n>: <count>" shape for any grade.
    for (let grade = 0; grade <= 4; grade += 1) {
      expect(text).not.toContain(`G${grade}:`);
      expect(text).not.toContain(`G${grade} `);
    }
    // The gap addresses themselves are still expected — this is not a claim
    // that check reports nothing, only that it never reports the histogram.
    expect(text).toContain(`S${sessionId}/T2`);
    expect(text).toContain(`S${sessionId}/T3`);
    expect(text).toContain(`S${sessionId}/T4`);
  });
});
