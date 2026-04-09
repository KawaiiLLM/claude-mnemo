import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

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
  let authObservationId: number;
  let bigSessionId: number;
  let floodSessionId: number;
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
      content: "Initial auth investigation",
      insight: "- baseline captured",
      createdAtEpoch: 100,
      updatedAtEpoch: 110,
      completedAtEpoch: 120,
    });
    baselineSessionId = baseline.id;

    const authSession = upsertSession(db, {
      contentSessionId: "session-2",
      project: "claude-mnemo",
      title: "Auth race fix",
      content: "Fixes the refresh race",
      insight: "- mutex avoids overlap",
      nextSteps: "verify refresh under load",
      createdAtEpoch: 86_600,
      updatedAtEpoch: 86_610,
      completedAtEpoch: 86_620,
    });
    authSessionId = authSession.id;

    saveTurn(db, {
      sessionId: authSession.id,
      promptNumber: 1,
      userPrompt: "Why am I getting 401 errors?",
      assistantResponse: "There is a race condition in token refresh.",
      title: "Diagnose auth race",
      content: "Refresh overlap diagnosed",
      insight: "- concurrent refreshes collide",
      filesRead: ["src/auth.ts"],
      filesModified: ["src/auth.ts", "tests/auth.test.ts"],
      createdAtEpoch: 86_630,
      updatedAtEpoch: 86_640,
      observations: [
        {
          type: "bugfix",
          title: "Auth mutex",
          content: "Guards refresh",
          insight: "Serialized refresh work with a shared promise.",
          tags: ["mutex", "race-resolved"],
          filesRead: ["src/auth.ts"],
          filesModified: ["src/auth.ts"],
        },
        {
          type: "decision",
          title: "Add regression test",
          content: "Protects overlap path",
          insight: "Regression coverage now checks parallel refresh calls.",
          tags: ["promise-all", "regression-test"],
          filesRead: ["tests/auth.test.ts"],
          filesModified: ["tests/auth.test.ts"],
        },
      ],
    });

    const authTurn = getTurn(db, authSession.id, 1)!;
    authObservationId = getObservationsForTurn(db, authTurn.id)[0]!.id;

    globalMemoryId = createMemory(db, {
      type: "feedback",
      scope: "global",
      title: "Use real DB integration tests",
      content: "Integration tests should use the real database layer.",
      reasoning: "Mocks hide locking and transaction behavior.",
      application: "When validating concurrency or persistence changes.",
      tags: ["testing", "database"],
      createdAtEpoch: 86_645,
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
      createdAtEpoch: 86_646,
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
      content: "This should stay out of scoped query results.",
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
      content: "For omission coverage",
      insight: null,
      createdAtEpoch: 172_800,
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
        content,
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
        172_800 + promptNumber,
        172_800 + promptNumber,
      );
    }

    const observationSession = upsertSession(db, {
      contentSessionId: "session-observations",
      project: "claude-mnemo",
      title: "Observation flood",
      content: "For direct observation omission coverage",
      insight: null,
      createdAtEpoch: 259_200,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });
    floodSessionId = observationSession.id;

    saveTurn(db, {
      sessionId: observationSession.id,
      promptNumber: 1,
      userPrompt: "Collect many observations",
      assistantResponse: "Collected many observations.",
      title: "Observation flood",
      content: "Many observations",
      insight: null,
      filesRead: [],
      filesModified: [],
      createdAtEpoch: 259_210,
      updatedAtEpoch: 259_220,
      observations: Array.from({ length: 60 }, (_, index) => ({
        type: "discovery",
        title: `Observation ${index + 1}`,
        content: `Description ${index + 1}`,
        insight: null,
        tags: [],
        filesRead: [],
        filesModified: [],
      })),
    });

    const floodTurn = getTurn(db, observationSession.id, 1)!;
    observationIds = getObservationsForTurn(db, floodTurn.id).map(
      (observation) => observation.id,
    );
  });

  afterEach(() => {
    db.close();
  });

  test("accepts only the simplified public recall parameters", () => {
    expect(() =>
      recallInputSchema.parse({
        id: "S1/T1",
        query: "type:bugfix auth",
        time: "1970-01-01",
        depth: "expanded",
        limit: 5,
      }),
    ).not.toThrow();

    expect(recallInputSchema.safeParse({ session: authSessionId }).success).toBe(false);
    expect(recallInputSchema.safeParse({ view: "sessions" }).success).toBe(false);
    expect(recallInputSchema.safeParse({ project: "claude-mnemo" }).success).toBe(false);
  });

  test("defaults to session listing and intersects time filters", () => {
    const defaultOutput = recallMemory(db, {});
    const filteredOutput = recallMemory(db, {
      time: "1970-01-02",
    });

    expect(defaultOutput).toContain(`[S${bigSessionId}] Large timeline`);
    expect(defaultOutput).toContain(`[S${authSessionId}] Auth race fix`);
    expect(filteredOutput).toContain(`[S${authSessionId}] Auth race fix`);
    expect(filteredOutput).not.toContain(`[S${bigSessionId}] Large timeline`);
    expect(filteredOutput).not.toContain(`[S${baselineSessionId}] Auth baseline`);
  });

  test("routes simplified ids for session, turn, observation, and memory detail", () => {
    const sessionOutput = recallMemory(db, {
      id: `S${authSessionId}`,
      depth: "expanded",
    });
    const turnOutput = recallMemory(db, {
      id: `S${authSessionId}/T1`,
      depth: "expanded",
    });
    const observationOutput = recallMemory(db, {
      id: `O${authObservationId}`,
      depth: "expanded",
    });
    const memoryOutput = recallMemory(db, {
      id: `M${projectMemoryId}`,
      depth: "expanded",
    });

    expect(sessionOutput).toContain(`[S${authSessionId}] Auth race fix`);
    expect(sessionOutput).toContain("[T1] Diagnose auth race");

    expect(turnOutput).toContain(`[T1] Diagnose auth race`);
    expect(turnOutput).toContain('prompt: "Why am I getting 401 errors?"');
    expect(turnOutput).toContain("[O1] 🔴 Auth mutex");

    expect(observationOutput).toContain(`[O${authObservationId}] 🔴 Auth mutex`);
    expect(observationOutput).toContain(
      "insight: Serialized refresh work with a shared promise.",
    );

    expect(memoryOutput).toContain(
      `[M${projectMemoryId}] project/claude-mnemo: Auth mutex policy`,
    );
    expect(memoryOutput).toContain(
      "content: Refresh token work must be serialized with a mutex.",
    );
  });

  test("supports wildcard and range ids with stable observation identity", () => {
    const turnsOutput = recallMemory(db, {
      id: `S${bigSessionId}/T11..20`,
    });
    const observationsOutput = recallMemory(db, {
      id: `S${authSessionId}/T1/O*`,
      depth: "expanded",
    });

    expect(turnsOutput).toContain(`[S${bigSessionId}] Large timeline`);
    expect(turnsOutput).toContain("[T12] Turn 12");
    expect(turnsOutput).toContain("[T20] Turn 20");
    expect(turnsOutput).not.toContain("[T10] Turn 10");

    expect(observationsOutput).toContain(`[O${authObservationId}] 🔴 Auth mutex`);
    expect(observationsOutput).toContain("desc: Guards refresh");
    expect(observationsOutput).toContain("[T1] Diagnose auth race");
    expect(recallMemory(db, { id: `S${authSessionId}/T1/O${authObservationId}` })).toContain(
      "invalid id selector",
    );
  });

  test("renders mixed query results with prefix filters, time, and limit", () => {
    const typeQuery = recallMemory(db, {
      query: "type:bugfix",
      depth: "expanded",
    });
    const projectScopedQuery = recallMemory(db, {
      query: "project:claude-mnemo auth",
      limit: 2,
    });
    const tagQuery = recallMemory(db, {
      query: "tag:concurrency",
    });
    const timeScopedQuery = recallMemory(db, {
      query: "auth",
      time: "1970-01-02",
      limit: 1,
    });

    expect(typeQuery).toContain(`[S${authSessionId}] Auth race fix`);
    expect(typeQuery).toContain(`[O${authObservationId}] 🔴 Auth mutex`);
    expect(typeQuery).not.toContain(`[M${projectMemoryId}]`);

    expect(projectScopedQuery).toContain("Auth race fix");
    expect(projectScopedQuery).toContain("Auth mutex policy");
    expect(projectScopedQuery).not.toContain("Other project note");

    expect(tagQuery).toContain("Auth mutex policy");
    expect(tagQuery).not.toContain("Use real DB integration tests");

    const hitCount = (timeScopedQuery.match(/\n- \[/g) ?? []).length + (timeScopedQuery.startsWith("- [") ? 1 : 0);
    expect(hitCount).toBe(1);
    expect(timeScopedQuery).toContain("Auth");
  });

  test("supports memory listing through simplified ids", () => {
    const output = recallMemory(db, {
      id: "M*",
    });

    expect(output).toContain(
      `[M${projectMemoryId}] project/claude-mnemo: Auth mutex policy`,
    );
    expect(output).toContain(
      `[M${globalMemoryId}] feedback/global: Use real DB integration tests`,
    );
    expect(output).toContain("Other project note");
    expect(output).not.toContain("Archived note");
  });

  test("applies omission sampling to direct observation browsing", () => {
    const output = recallMemory(db, {
      id: `S${floodSessionId}/T1/O*`,
      depth: "collapsed",
      limit: 60,
    });

    expect(output).toContain("... ");
    expect(output).toContain("[O");
    expect(output).toContain("[S");
  });

  test("rejects invalid time and legacy-style ids", () => {
    expect(recallMemory(db, { time: "yesterday" })).toContain("Parameter error:");
    expect(recallMemory(db, { id: "T1" })).toContain("Parameter error:");
  });
});
