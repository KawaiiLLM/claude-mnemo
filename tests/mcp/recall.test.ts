import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { getObservationsForTurn } from "../../src/db/observations";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { getTurn, saveTurn } from "../../src/db/turns";
import { recallMemory } from "../../src/mcp/recall";

describe("recallMemory", () => {
  let db: Database;
  let baselineSessionId: number;
  let authSessionId: number;
  let authTurnId: number;
  let authObservationId: number;
  let bigSessionId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);

    const baseline = upsertSession(db, {
      contentSessionId: "session-1",
      project: "claude-mnemo",
      title: "Auth baseline",
      description: "Initial auth investigation",
      insight: "- baseline captured",
      startedAtEpoch: 100,
      updatedAtEpoch: 110,
      completedAtEpoch: 120,
    });
    baselineSessionId = baseline.id;

    const authSession = upsertSession(db, {
      contentSessionId: "session-2",
      project: "claude-mnemo",
      title: "Auth race fix",
      description: "Fixes the refresh race",
      insight: "- mutex avoids overlap",
      nextSteps: "verify refresh under load",
      startedAtEpoch: 200,
      updatedAtEpoch: 210,
      completedAtEpoch: 220,
    });
    authSessionId = authSession.id;

    saveTurn(db, {
      sessionId: authSession.id,
      promptNumber: 1,
      userPrompt: "Why am I getting 401 errors?",
      assistantResponse: "There is a race condition in token refresh.",
      title: "Diagnose auth race",
      description: "Refresh overlap diagnosed",
      insight: "- concurrent refreshes collide",
      filesRead: ["src/auth.ts"],
      filesModified: ["src/auth.ts", "tests/auth.test.ts"],
      createdAtEpoch: 230,
      updatedAtEpoch: 240,
      observations: [
        {
          type: "bugfix",
          title: "Auth mutex",
          description: "Guards refresh",
          narrative: "Serialized refresh work with a shared promise.",
          facts: ["mutex added", "race resolved"],
          concepts: ["problem-solution", "trade-off"],
          filesRead: ["src/auth.ts"],
          filesModified: ["src/auth.ts"],
        },
        {
          type: "decision",
          title: "Add regression test",
          description: "Protects overlap path",
          narrative: "Regression coverage now checks parallel refresh calls.",
          facts: ["Promise.all test added"],
          concepts: ["pattern"],
          filesRead: ["tests/auth.test.ts"],
          filesModified: ["tests/auth.test.ts"],
        },
      ],
    });

    const authTurn = getTurn(db, authSession.id, 1)!;
    authTurnId = authTurn.id;
    authObservationId = getObservationsForTurn(db, authTurn.id)[0]!.id;

    const bigSession = upsertSession(db, {
      contentSessionId: "session-big",
      project: "claude-mnemo",
      title: "Large timeline",
      description: "For omission coverage",
      insight: null,
      startedAtEpoch: 300,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });
    bigSessionId = bigSession.id;

    const insertTurn = db.query(`
      INSERT INTO turns (
        session_id,
        prompt_number,
        status,
        user_prompt,
        assistant_response,
        title,
        description,
        insight,
        files_read,
        files_modified,
        tool_call_count,
        created_at_epoch,
        updated_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (let promptNumber = 1; promptNumber <= 60; promptNumber += 1) {
      const status =
        promptNumber === 12
          ? "pending"
          : promptNumber === 20
            ? "stale"
            : "extracted";

      insertTurn.run(
        bigSession.id,
        promptNumber,
        status,
        `Prompt ${promptNumber}`,
        `Response ${promptNumber}`,
        `Turn ${promptNumber}`,
        `Description ${promptNumber}`,
        null,
        JSON.stringify([]),
        JSON.stringify([]),
        0,
        300 + promptNumber,
        300 + promptNumber,
      );
    }
  });

  afterEach(() => {
    db.close();
  });

  test("renders scoped sessions and intersects time filters", () => {
    const output = recallMemory(db, {
      scope: "sessions",
      time: "1970-01-01..1970-01-01",
      after: 150,
      before: 250,
    });

    expect(output).toContain("[S2] Auth race fix");
    expect(output).not.toContain("[S1] Auth baseline");
    expect(output).not.toContain("[S3] Large timeline");
  });

  test("parses turn range selectors and expands selected turns", () => {
    const output = recallMemory(db, {
      scope: "turns",
      session: authSessionId,
      turn: "1..1",
      depth: "expanded",
    });

    expect(output).toContain("- [S2] Auth race fix");
    expect(output).toContain("- [S2][T1] Diagnose auth race | 💡2 📖1 ✏️2 [extracted]");
    expect(output).toContain('prompt: "Why am I getting 401 errors?"');
    expect(output).toContain('response: "There is a race condition in token refresh."');
    expect(output).toContain("- [O");
  });

  test("accepts array selectors for sessions", () => {
    const output = recallMemory(db, {
      scope: "sessions",
      session: [authSessionId, baselineSessionId],
    });

    expect(output).toContain("[S2] Auth race fix");
    expect(output).toContain("[S1] Auth baseline");
  });

  test("rejects turns that do not belong to the selected session", () => {
    const output = recallMemory(db, {
      scope: "turns",
      session: baselineSessionId,
      turn: 1,
    });

    expect(output).toContain("Parameter error:");
    expect(output).toContain("does not belong to session");
  });

  test("rejects observations that do not belong to the selected session", () => {
    const output = recallMemory(db, {
      scope: "observations",
      session: baselineSessionId,
      obs: authObservationId,
    });

    expect(output).toContain("Parameter error:");
    expect(output).toContain("does not belong to session");
  });

  test("renders observation scope with parent headers when session and turn are selected", () => {
    const output = recallMemory(db, {
      scope: "observations",
      session: authSessionId,
      turn: 1,
      obs: authObservationId,
      depth: "expanded",
    });

    expect(output).toContain("- [S2] Auth race fix");
    expect(output).toContain("- [S2][T1] Diagnose auth race");
    expect(output).toContain("- [O1] 🔴 Auth mutex");
    expect(output).toContain("  - desc: Guards refresh");
  });

  test("keeps pending and stale turns out of omission sampling", () => {
    const output = recallMemory(db, {
      scope: "turns",
      session: bigSessionId,
    });

    expect(output).toContain("... ");
    expect(output).toContain("[pending]");
    expect(output).toContain("[stale]");
  });
});
