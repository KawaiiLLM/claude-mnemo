import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import * as nodeFs from "node:fs";

import { createDatabase } from "../../src/db/database";
import { createMemory } from "../../src/db/memories";
import { getObservationsForTurn } from "../../src/db/observations";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { getTurn, saveTurn } from "../../src/db/turns";
import { recallInputSchema } from "../../src/mcp/definitions";
import { recallMemory } from "../../src/mcp/recall";

describe("recallMemory", () => {
  let db: Database;
  let baselineSessionId: number;
  let authSessionId: number;
  let authTurnId: number;
  let authObservationId: number;
  let bigSessionId: number;
  let globalMemoryId: number;
  let projectMemoryId: number;
  let observationIds: number[] = [];

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

    globalMemoryId = createMemory(db, {
      type: "feedback",
      scope: "global",
      title: "Use real DB integration tests",
      content: "Integration tests should use the real database layer.",
      reasoning: "Mocks hide locking and transaction behavior.",
      application: "When validating concurrency or persistence changes.",
      tags: ["testing", "database"],
      createdAtEpoch: 245,
      updatedAtEpoch: null,
      sourceTurnId: authTurn.id,
      status: "active",
      supersededBy: null,
      expiresAtEpoch: null,
    }).id;

    projectMemoryId = createMemory(db, {
      type: "project",
      scope: "claude-mnemo",
      title: "Auth mutex policy",
      content: "Refresh token work must be serialized with a mutex.",
      reasoning: "Concurrent refreshes overwrite shared auth state.",
      application: "When auth middleware touches refresh tokens.",
      tags: ["auth", "concurrency"],
      createdAtEpoch: 246,
      updatedAtEpoch: null,
      sourceTurnId: authTurn.id,
      status: "active",
      supersededBy: null,
      expiresAtEpoch: null,
    }).id;

    createMemory(db, {
      type: "project",
      scope: "other-project",
      title: "Other project note",
      content: "This should stay out of the default project memory list.",
      reasoning: null,
      application: null,
      tags: [],
      createdAtEpoch: 247,
      updatedAtEpoch: null,
      sourceTurnId: null,
      status: "active",
      supersededBy: null,
      expiresAtEpoch: null,
    });

    createMemory(db, {
      type: "feedback",
      scope: "claude-mnemo",
      title: "Archived note",
      content: "This should not appear in active memory recall.",
      reasoning: null,
      application: null,
      tags: [],
      createdAtEpoch: 248,
      updatedAtEpoch: null,
      sourceTurnId: null,
      status: "archived",
      supersededBy: null,
      expiresAtEpoch: null,
    });

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

    const observationSession = upsertSession(db, {
      contentSessionId: "session-observations",
      project: "claude-mnemo",
      title: "Observation flood",
      description: "For direct observation omission coverage",
      insight: null,
      startedAtEpoch: 400,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    saveTurn(db, {
      sessionId: observationSession.id,
      promptNumber: 1,
      userPrompt: "Collect many observations",
      assistantResponse: "Collected many observations.",
      title: "Observation flood",
      description: "Many observations",
      insight: null,
      filesRead: [],
      filesModified: [],
      createdAtEpoch: 410,
      updatedAtEpoch: 420,
      observations: Array.from({ length: 60 }, (_, index) => ({
        type: "discovery",
        title: `Observation ${index + 1}`,
        description: `Description ${index + 1}`,
        narrative: null,
        facts: [],
        concepts: [],
        filesRead: [],
        filesModified: [],
      })),
    });

    const floodTurn = getTurn(db, observationSession.id, 1)!;
    observationIds = getObservationsForTurn(db, floodTurn.id).map((observation) => observation.id);
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

  test("accepts legacy recall calls without scope in the schema", () => {
    expect(() => recallInputSchema.parse({ query: "auth" })).not.toThrow();
    expect(recallMemory(db, { session: authSessionId })).toContain("[S2] Auth race fix");
  });

  test("accepts memory scope and id selectors in the schema", () => {
    expect(() => recallInputSchema.parse({ scope: "memories" })).not.toThrow();
    expect(() => recallInputSchema.parse({ id: "M1" })).not.toThrow();
  });

  test("rejects ambiguous id and scope combinations", () => {
    const output = recallMemory(db, {
      id: `S${authSessionId}`,
      scope: "sessions",
    });

    expect(output).toContain("Parameter error:");
    expect(output).toContain("id cannot be combined");
  });

  test("normalizes legacy observation aliases and logs the migration warning", () => {
    const logSpy = spyOn(nodeFs, "appendFileSync").mockImplementation(() => {});

    const output = recallMemory(db, {
      observation: authObservationId,
    });

    expect(output).toContain("[O1] 🔴 Auth mutex");
    expect(
      logSpy.mock.calls.some(([, payload]) =>
        String(payload).includes("legacy recall parameters normalized"),
      ),
    ).toBe(true);

    logSpy.mockRestore();
  });

  test("keeps legacy query-only recall as cross-layer search", () => {
    const output = recallMemory(db, {
      query: "refresh",
    });

    expect(output).toContain(`[M${projectMemoryId}] project/claude-mnemo: Auth mutex policy`);
    expect(output).toContain("[S2] Auth race fix");
    expect(output).toContain("[T1] Diagnose auth race | S2");
    expect(output).toContain(`[O${authObservationId}] bugfix: Auth mutex | S2/T1`);
  });

  test("treats legacy type filters as unscoped search filters", () => {
    const output = recallMemory(db, {
      type: "bugfix",
    });

    expect(output).toContain(`[O${authObservationId}] bugfix: Auth mutex | S2/T1`);
    expect(output).not.toContain("[S2] Auth race fix");
  });

  test("lists active global and current-project memories", () => {
    const output = recallMemory(db, {
      scope: "memories",
    });

    expect(output).toContain(`[M${projectMemoryId}] project/claude-mnemo: Auth mutex policy`);
    expect(output).toContain(`[M${globalMemoryId}] feedback/global: Use real DB integration tests`);
    expect(output).not.toContain("Other project note");
    expect(output).not.toContain("Archived note");
  });

  test("renders memory detail by routed id", () => {
    const output = recallMemory(db, {
      id: `M${projectMemoryId}`,
    });

    expect(output).toContain(`[M${projectMemoryId}] project/claude-mnemo: Auth mutex policy`);
    expect(output).toContain("content: Refresh token work must be serialized with a mutex.");
    expect(output).toContain("reasoning: Concurrent refreshes overwrite shared auth state.");
    expect(output).toContain("application: When auth middleware touches refresh tokens.");
    expect(output).toContain("tags: [auth, concurrency]");
    expect(output).toContain(`[S${authSessionId}/T1] Diagnose auth race`);
  });

  test("routes session, turn, observation, and memory ids through the read path", () => {
    const sessionOutput = recallMemory(db, {
      id: `S${authSessionId}`,
    });
    const turnOutput = recallMemory(db, {
      id: `S${authSessionId}/T1`,
    });
    const observationOutput = recallMemory(db, {
      id: `O${authObservationId}`,
    });
    const memoryOutput = recallMemory(db, {
      id: `M${projectMemoryId}`,
    });

    expect(sessionOutput).toContain(`[S${authSessionId}] Auth race fix`);
    expect(sessionOutput).toContain(`[S${authSessionId}][T1] Diagnose auth race`);
    expect(sessionOutput).not.toContain('prompt: "Why am I getting 401 errors?"');

    expect(turnOutput).toContain(`[S${authSessionId}][T1] Diagnose auth race`);
    expect(turnOutput).toContain('prompt: "Why am I getting 401 errors?"');
    expect(turnOutput).toContain("[O1] 🔴 Auth mutex");

    expect(observationOutput).toContain(`[O${authObservationId}] 🔴 Auth mutex`);
    expect(observationOutput).toContain("narrative: Serialized refresh work with a shared promise.");

    expect(memoryOutput).toContain(`[M${projectMemoryId}] project/claude-mnemo: Auth mutex policy`);
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

  test("applies omission sampling to direct observation browsing", () => {
    const output = recallMemory(db, {
      scope: "observations",
      obs: `${observationIds[0]}..${observationIds[observationIds.length - 1]}`,
      depth: "collapsed",
    });

    expect(output).toContain("... ");
    expect(output).toContain("[O");
    expect(output).not.toContain("[S");
  });
});
