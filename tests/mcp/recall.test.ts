import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { getObservationsForTurn } from "../../src/db/observations";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { getTurn } from "../../src/db/turns";
import { saveTurn } from "../../src/db/turns";
import { recallMemory } from "../../src/mcp/recall";
import * as turnsModule from "../../src/db/turns";

describe("recallMemory", () => {
  let db: Database;
  let authSessionId: number;
  let authTurnId: number;
  let authObservationId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);

    upsertSession(db, {
      contentSessionId: "session-1",
      project: "claude-mnemo",
      title: "Auth baseline",
      description: "Initial auth investigation",
      insight: "- baseline captured",
      startedAtEpoch: 100,
      updatedAtEpoch: 110,
      completedAtEpoch: 120,
    });

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

    upsertSession(db, {
      contentSessionId: "session-3",
      project: "claude-mnemo",
      title: "UI cleanup",
      description: "Unrelated UI work",
      insight: null,
      startedAtEpoch: 300,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });
  });

  afterEach(() => {
    db.close();
  });

  test("returns recent sessions when called without filters", () => {
    const output = recallMemory(db, {});

    expect(output).toContain("- [S3] UI cleanup | 1970-01-01 | claude-mnemo");
    expect(output).toContain("  - desc: Unrelated UI work");
    expect(output).toContain("- [S2] Auth race fix | 💬1 💡2 | 1970-01-01 | claude-mnemo");
    expect(output.indexOf("[S3]")).toBeLessThan(output.indexOf("[S2]"));
  });

  test("searches by keyword across memory layers", () => {
    const output = recallMemory(db, { query: "race" });

    expect(output).toContain("- [S2] Auth race fix | 💬1 💡2 | 1970-01-01 | claude-mnemo");
    expect(output).toContain("- [S2][T1] Diagnose auth race | 💡2 📖1 ✏️2");
    expect(output).toContain("- [O1] 🔴 Auth mutex");
  });

  test("reuses one fetched turn list for session search stats", () => {
    const getTurnsForSessionSpy = spyOn(turnsModule, "getTurnsForSession");

    const output = recallMemory(db, { query: "race" });

    expect(output).toContain("- [S2] Auth race fix | 💬1 💡2 | 1970-01-01 | claude-mnemo");
    expect(getTurnsForSessionSpy).toHaveBeenCalledTimes(1);

    getTurnsForSessionSpy.mockRestore();
  });

  test("shows turns for a session", () => {
    const output = recallMemory(db, { session: authSessionId });

    expect(output).toContain("- [S2] Auth race fix | 💬1 💡2 | 1970-01-01 | claude-mnemo");
    expect(output).toContain("  - desc: Fixes the refresh race");
    expect(output).toContain("  - insight:");
    expect(output).toContain("  - next_steps:");
    expect(output).toContain("  - [T1] Diagnose auth race | 💡2 📖1 ✏️2");
    expect(output).toContain("    - desc: Refresh overlap diagnosed");
    expect(output).not.toContain("#1");
  });

  test("expands selected turns inside a session tree", () => {
    const output = recallMemory(db, {
      session: authSessionId,
      expandTurns: [1],
    });

    expect(output).toContain('  - prompt: "Why am I getting 401 errors?"');
    expect(output).toContain('  - response: "There is a race condition in token refresh."');
    expect(output).toContain("  - [O1] 🔴 Auth mutex");
    expect(output).toContain("      - narrative: Serialized refresh work with a shared promise.");
  });

  test("shows observations for a session-scoped turn prompt number", () => {
    const output = recallMemory(db, { session: authSessionId, turn: 1 });

    expect(output).toContain("- [T1] Diagnose auth race | 💡2 📖1 ✏️2");
    expect(output).toContain("  - desc: Refresh overlap diagnosed");
    expect(output).toContain("  - [O1] 🔴 Auth mutex");
    expect(output).toContain("  - [O2] ⚖️ Add regression test");
  });

  test("rejects turn lookup without session context", () => {
    const output = recallMemory(db, { turn: authTurnId });

    expect(output).toBe(
      "Parameter error: turn requires session; use recall(session=142, turn=3).",
    );
  });

  test("rejects expand_turns without session context", () => {
    const output = recallMemory(db, { expandTurns: [1] });

    expect(output).toBe(
      "Parameter error: expand_turns requires session; use recall(session=142, expand_turns=[1]).",
    );
  });

  test("shows full detail for a specific observation", () => {
    const output = recallMemory(db, { observation: authObservationId });

    expect(output).toContain("- [O1] 🔴 Auth mutex");
    expect(output).toContain("  - desc: Guards refresh");
    expect(output).toContain("  - narrative: Serialized refresh work with a shared promise.");
    expect(output).toContain("  - facts:");
    expect(output).toContain("    - mutex added");
    expect(output).toContain("    - race resolved");
  });

  test("rejects observation mixed with other selectors", () => {
    const output = recallMemory(db, {
      observation: authObservationId,
      query: "auth",
    });

    expect(output).toBe(
      "Parameter error: observation cannot be combined with other selectors.",
    );
  });

  test("returns a cross-session timeline around an anchor session", () => {
    const output = recallMemory(db, {
      around: `S${authSessionId}`,
      before: 1,
      after: 1,
    });

    expect(output).toContain("[S1] Auth baseline");
    expect(output).toContain("[S2] Auth race fix");
    expect(output).toContain("[S3] UI cleanup");
    expect(output.indexOf("[S1]")).toBeLessThan(output.indexOf("[S2]"));
    expect(output.indexOf("[S2]")).toBeLessThan(output.indexOf("[S3]"));
  });

  test("accepts a date anchor for the cross-session timeline", () => {
    const output = recallMemory(db, {
      around: "1970-01-01",
      before: 1,
      after: 1,
    });

    expect(output).toContain("[S1] Auth baseline");
    expect(output).toContain("[S2] Auth race fix");
    expect(output.indexOf("[S1]")).toBeLessThan(output.indexOf("[S2]"));
  });

  test("filters by file path", () => {
    const output = recallMemory(db, { file: "src/auth.ts" });

    expect(output).toContain("- [S2][T1] Diagnose auth race | 💡2 📖1 ✏️2");
    expect(output).toContain("- [O1] 🔴 Auth mutex");
  });

  test("filters by observation type", () => {
    const output = recallMemory(db, { type: "bugfix" });

    expect(output).toContain("- [O1] 🔴 Auth mutex");
    expect(output).not.toContain("- [O2] ⚖️ Add regression test");
  });
});
