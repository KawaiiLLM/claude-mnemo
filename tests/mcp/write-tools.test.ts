import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { getObservationsForTurn } from "../../src/db/observations";
import { createDatabase } from "../../src/db/database";
import { getMemory, listMemories } from "../../src/db/memories";
import { initializeDatabase } from "../../src/db/schema";
import { getSession, upsertSession } from "../../src/db/sessions";
import { getTurn } from "../../src/db/turns";
import { rememberTool } from "../../src/mcp/remember";

describe("MCP write tools", () => {
  let db: Database;
  let sessionId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeDatabase(db);

    sessionId = upsertSession(db, {
      contentSessionId: "session-write-tools",
      project: "claude-mnemo",
      title: "Before update",
      content: "Initial session summary",
      insight: "- initial insight",
      createdAtEpoch: 100,
      updatedAtEpoch: 110,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  test("rememberTool persists extracted turns through a session parent", () => {
    const result = rememberTool(db, {
      parent: `S${sessionId}`,
      prompt_number: 1,
      title: "Fix auth race",
      content: "Persists the extracted turn",
      insight: "- regression covered",
      files_read: ["src/auth.ts"],
      files_modified: ["src/auth.ts", "tests/auth.test.ts"],
    });

    const turn = getTurn(db, sessionId, 1)!;

    expect(result.content[0]?.text).toContain("Saved turn #1");
    expect(turn.status).toBe("extracted");
    expect(turn.title).toBe("Fix auth race");
    expect(turn.content).toBe("Persists the extracted turn");
  });

  test("rememberTool uses skip semantics when content is empty", () => {
    rememberTool(db, {
      parent: `S${sessionId}`,
      prompt_number: 2,
    });

    const turn = getTurn(db, sessionId, 2)!;

    expect(turn.status).toBe("skipped");
    expect(getObservationsForTurn(db, turn.id)).toHaveLength(0);
  });

  test("rememberTool supports explicit undone status", () => {
    rememberTool(db, {
      parent: `S${sessionId}`,
      prompt_number: 3,
      title: "Temporary branch",
      content: "Will be cleared",
    });

    const result = rememberTool(db, {
      parent: `S${sessionId}`,
      prompt_number: 3,
      status: "undone",
    });

    const turn = getTurn(db, sessionId, 3)!;

    expect(result.content[0]?.text).toContain("status undone");
    expect(turn.status).toBe("undone");
    expect(getObservationsForTurn(db, turn.id)).toHaveLength(0);
  });

  test("rememberTool updates the session summary by id route", () => {
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

  test("rememberTool routes a session parent to the next pending turn", () => {
    db.query(
      "INSERT INTO turns (session_id, prompt_number, status, user_prompt, created_at_epoch) VALUES (?, ?, 'pending', ?, ?)",
    ).run(sessionId, 4, "Capture the final fix", 320);

    const result = rememberTool(db, {
      parent: `S${sessionId}`,
      title: "Capture the final fix",
      content: "Summarize the mutex fix and regression coverage.",
      insight: "- lock serializes refresh work",
      updated_at_epoch: 330,
    });

    const turn = getTurn(db, sessionId, 4)!;

    expect(result.content[0]?.text).toContain("Saved turn #4");
    expect(turn.status).toBe("extracted");
    expect(turn.content).toBe("Summarize the mutex fix and regression coverage.");
  });

  test("rememberTool routes a turn parent to an observation child", () => {
    db.query(
      "INSERT INTO turns (session_id, prompt_number, status, title, content, created_at_epoch) VALUES (?, ?, 'extracted', ?, ?, ?)",
    ).run(sessionId, 5, "Auth fix", "Existing extracted turn", 340);

    const result = rememberTool(db, {
      parent: `S${sessionId}/T5`,
      type: "bugfix",
      title: "Auth mutex",
      content: "auth.ts now locks refresh work.",
      insight: "Concurrent requests now share one refresh promise.",
      tags: ["auth", "concurrency"],
      files_read: ["src/auth.ts"],
      files_modified: ["src/auth.ts"],
    });

    const turn = getTurn(db, sessionId, 5)!;
    const observations = getObservationsForTurn(db, turn.id);

    expect(result.content[0]?.text).toContain("Saved observation");
    expect(observations).toHaveLength(1);
    expect(observations[0]?.content).toBe("auth.ts now locks refresh work.");
    expect(observations[0]?.insight).toBe(
      "Concurrent requests now share one refresh promise.",
    );
    expect(observations[0]?.tags).toEqual(["auth", "concurrency"]);
  });

  test("rememberTool routes a session id to session summary updates", () => {
    const result = rememberTool(db, {
      id: `S${sessionId}`,
      title: "After remember update",
      content: "Updated through the remember tool.",
      insight: "- session updated",
    });

    const session = getSession(db, sessionId)!;

    expect(result.content[0]?.text).toContain(`Updated session ${sessionId}`);
    expect(session.content).toBe("Updated through the remember tool.");
    expect(session.insight).toBe("- session updated");
  });

  test("rememberTool creates and updates memories", () => {
    const createResult = rememberTool(db, {
      type: "feedback",
      scope: "global",
      title: "Prefer real DB tests",
      content: "Use the real database for concurrency integration tests.",
      reasoning: "Mocks hide transaction boundaries.",
      application: "When testing lock-sensitive code paths.",
      tags: ["testing", "database"],
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
});
