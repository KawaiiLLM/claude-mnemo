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

  test("rejects an unsafe id and a session that does not exist", () => {
    // Matches the address pattern, parses to a DIFFERENT number.
    expect(resultText(checkTool(db, { id: "S9007199254740993" }))).toStartWith(
      "Parameter error:",
    );
    // Well-formed, absent: must not answer with a clean bill, which is what
    // the caller acts on.
    const absent = resultText(checkTool(db, { id: `S${sessionId + 4242}` }));
    expect(absent).toStartWith("Parameter error:");
    expect(absent).not.toContain("nothing owed");
  });

  test("reports nothing owed when every eligible turn is typed or skipped", () => {
    seedTurn({ promptNumber: 1, type: ["design"] });
    seedTurn({ promptNumber: 2, status: "skipped" });
    seedTurn({ promptNumber: 3, userPrompt: "/compact", type: ["compact"] });

    // Exact, not a substring: a report that ALSO listed one of these three as
    // owed would still contain "nothing owed" if the phrase were merely a
    // prefix.
    expect(resultText(checkTool(db, { id: `S${sessionId}` }))).toBe(
      `S${sessionId}: nothing owed — every eligible turn is typed or skipped.`,
    );
  });

  // Acceptance criterion 5: reports WHAT is missing, never why.
  test("reports missing turns as bare addresses, without explaining why any of them is a gap", () => {
    seedTurn({ promptNumber: 1, type: ["design"] }); // covered
    seedTurn({ promptNumber: 2 }); // gap: empty type
    seedTurn({ promptNumber: 3, status: "undone" }); // gap: eligible sidechain, empty type

    const text = resultText(checkTool(db, { id: `S${sessionId}` }));

    // The WHOLE report, not a substring and not a denylist of five words. A
    // denylist passes any explanation phrased differently, and a `toContain`
    // on the addresses passes a report that also listed T1 — so the test that
    // is supposed to enforce "what, never why" has to pin the entire string.
    expect(text).toBe(
      `S${sessionId}: 2 turn(s) still owe review: S${sessionId}/T2, S${sessionId}/T3.`,
    );
  });

  test("excludes a compact marker and a no-reply slash command, includes a sidechain turn", () => {
    seedTurn({ promptNumber: 1, userPrompt: "/compact", type: ["compact"] });
    seedTurn({
      promptNumber: 2,
      userPrompt: "<local-command-stdout>ok</local-command-stdout>",
    });
    seedTurn({ promptNumber: 3, status: "undone" });

    expect(resultText(checkTool(db, { id: `S${sessionId}` }))).toBe(
      `S${sessionId}: 1 turn(s) still owe review: S${sessionId}/T3.`,
    );
  });

  test("a filled type clears a previously reported gap", () => {
    const turnId = seedTurn({ promptNumber: 1 });
    expect(resultText(checkTool(db, { id: `S${sessionId}` }))).toBe(
      `S${sessionId}: 1 turn(s) still owe review: S${sessionId}/T1.`,
    );

    updateTurnById(db, turnId, { type: ["fix"], updatedAtEpoch: nextEpoch });

    expect(resultText(checkTool(db, { id: `S${sessionId}` }))).toBe(
      `S${sessionId}: nothing owed — every eligible turn is typed or skipped.`,
    );
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
