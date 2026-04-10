import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { getMemory, listMemories } from "../../src/db/memories";
import { getObservation, getObservationsForTurn } from "../../src/db/observations";
import { initializeSchema } from "../../src/db/schema";
import { getSession, upsertSession } from "../../src/db/sessions";
import { getTurn } from "../../src/db/turns";
import { rememberInputSchema } from "../../src/mcp/definitions";
import { rememberTool } from "../../src/mcp/remember";

describe("remember tool routing and validation", () => {
  let db: Database;
  let sessionId: number;
  let turnId: number;
  let observationId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);

    sessionId = upsertSession(db, {
      contentSessionId: "remember-session",
      project: "claude-mnemo",
      title: "Before update",
      content: "Initial session summary",
      insight: "- initial insight",
      createdAtEpoch: 100,
      updatedAtEpoch: 110,
      completedAtEpoch: null,
    }).id;

    db.query(
      "INSERT INTO turns (session_id, prompt_number, status, user_prompt, created_at_epoch) VALUES (?, ?, 'active', ?, ?)",
    ).run(sessionId, 1, "Fix auth race", 120);

    turnId = db
      .query<{ id: number }, []>(
        "SELECT id FROM turns WHERE session_id = ? AND prompt_number = ?",
      )
      .get(sessionId, 1)!.id;

    db.query(
      "INSERT INTO observations (turn_id, tool_name, tool_input, tool_result, status, created_at_epoch) VALUES (?, ?, ?, ?, 'pending', ?)",
    ).run(
      turnId,
      "Read",
      "{\"file_path\":\"src/auth.ts\"}",
      "file contents",
      130,
    );

    observationId = db
      .query<{ id: number }, []>("SELECT id FROM observations WHERE turn_id = ?")
      .get(turnId)!.id;
  });

  afterEach(() => {
    db.close();
  });

  test("public schema rejects removed parent-based remember arguments", () => {
    expect(() =>
      rememberInputSchema.parse({
        parent: `S${sessionId}`,
        prompt_number: 1,
        title: "No longer supported",
      }),
    ).toThrow();
  });

  test("updates an existing turn by T{id}", () => {
    const result = rememberTool(db, {
      id: `T${turnId}`,
      title: "Fix auth race",
      content: "Persists the extracted turn through its stable DB id.",
      insight: "- mutex added",
      type: "bugfix",
      tags: ["auth", "concurrency"],
    });

    const turn = getTurn(db, sessionId, 1)!;

    expect(result.content[0]?.text).toContain(`Updated turn T${turnId}`);
    expect(turn.status).toBe("extracted");
    expect(turn.title).toBe("Fix auth race");
    expect(turn.content).toBe(
      "Persists the extracted turn through its stable DB id.",
    );
  });

  test("supports explicit skipped and undone turn statuses by id", () => {
    const skipped = rememberTool(db, {
      id: `T${turnId}`,
      status: "skipped",
    });

    expect(skipped.content[0]?.text).toContain("status skipped");
    expect(getTurn(db, sessionId, 1)?.status).toBe("skipped");

    const undone = rememberTool(db, {
      id: `T${turnId}`,
      status: "undone",
    });

    expect(undone.content[0]?.text).toContain("status undone");
    expect(getTurn(db, sessionId, 1)?.status).toBe("undone");
  });

  test("updates an existing observation by O{id}", () => {
    const result = rememberTool(db, {
      id: `O${observationId}`,
      title: "Read auth module",
      content: "Examined the token refresh flow and locking behavior.",
    });

    const observation = getObservation(db, observationId)!;

    expect(result.content[0]?.text).toContain(`Updated observation O${observationId}`);
    expect(observation.title).toBe("Read auth module");
    expect(observation.content).toBe(
      "Examined the token refresh flow and locking behavior.",
    );
  });

  test("rejects legacy observation fields on the O{id} route", () => {
    const result = rememberTool(db, {
      id: `O${observationId}`,
      title: "Read auth module",
      insight: "- legacy insight" as never,
    });

    expect(result.content[0]?.text).toContain("Parameter error:");
    expect(result.content[0]?.text).toContain(
      "observation remember only accepts title, content, and status.",
    );
  });

  test("rejects unsupported observation statuses", () => {
    const result = rememberTool(db, {
      id: `O${observationId}`,
      status: "active" as never,
    });

    expect(result.content[0]?.text).toContain("Parameter error:");
    expect(result.content[0]?.text).toContain("observation remember");
  });

  test("removes skipped observations and finalized skipped or undone turns from FTS", () => {
    rememberTool(db, {
      id: `T${turnId}`,
      title: "Fix auth race",
      content: "Persists the extracted turn through its stable DB id.",
      insight: "- mutex added",
      type: "bugfix",
      tags: ["auth", "concurrency"],
    });
    rememberTool(db, {
      id: `O${observationId}`,
      title: "Read auth module",
      content: "Examined the token refresh flow and locking behavior.",
    });

    expect(
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM memory_fts WHERE layer = 'turn' AND source_id = ?",
        )
        .get(turnId)?.count,
    ).toBe(1);
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM memory_fts WHERE layer = 'observation' AND source_id = ?",
        )
        .get(observationId)?.count,
    ).toBe(1);

    rememberTool(db, {
      id: `T${turnId}`,
      status: "undone",
    });
    rememberTool(db, {
      id: `O${observationId}`,
      status: "skipped",
    });

    expect(
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM memory_fts WHERE layer = 'turn' AND source_id = ?",
        )
        .get(turnId)?.count,
    ).toBe(0);
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM memory_fts WHERE layer = 'observation' AND source_id = ?",
        )
        .get(observationId)?.count,
    ).toBe(0);
  });

  test("updates the session summary by S{id}", () => {
    const result = rememberTool(db, {
      id: `S${sessionId}`,
      title: "After update",
      content: "Updated session summary",
      insight: "- updated insight",
      next_steps: "Ship the follow-up cleanup",
    });

    const session = getSession(db, sessionId)!;

    expect(result.content[0]?.text).toContain(`Updated session ${sessionId}`);
    expect(session.title).toBe("After update");
    expect(session.content).toBe("Updated session summary");
    expect(session.insight).toBe("- updated insight");
    expect(session.nextSteps).toBe("Ship the follow-up cleanup");
  });

  test("creates and updates memories via routed ids", () => {
    const createResult = rememberTool(db, {
      type: "feedback",
      scope: "global",
      title: "Prefer real DB tests",
      content: "Use the real database for concurrency integration tests.",
      reasoning: "Mocks hide transaction boundaries.",
      application: "When testing lock-sensitive code paths.",
      tags: ["testing", "database"],
      source: `T${turnId}`,
    });

    const created = listMemories(db)[0]!;

    const updateResult = rememberTool(db, {
      id: `M${created.id}`,
      content: "Use the real database for persistence integration tests.",
      status: "archived",
    });

    const updated = getMemory(db, created.id)!;

    expect(createResult.content[0]?.text).toContain("Created memory M");
    expect(updateResult.content[0]?.text).toContain(`Updated memory M${created.id}`);
    expect(updated.content).toBe(
      "Use the real database for persistence integration tests.",
    );
    expect(updated.status).toBe("archived");
  });

  test("does not create extra observations while updating O{id}", () => {
    rememberTool(db, {
      id: `O${observationId}`,
      title: "Updated observation",
      content: "Updated through routed observation remember.",
    });

    expect(getObservationsForTurn(db, turnId)).toHaveLength(1);
  });
});
