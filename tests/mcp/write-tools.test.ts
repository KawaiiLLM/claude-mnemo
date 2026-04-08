import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { getObservationsForTurn } from "../../src/db/observations";
import { createDatabase } from "../../src/db/database";
import { getMemory, listMemories } from "../../src/db/memories";
import { initializeDatabase } from "../../src/db/schema";
import { getSession, upsertSession } from "../../src/db/sessions";
import { getTurn } from "../../src/db/turns";
import { rememberTool } from "../../src/mcp/remember";
import { saveTurnTool } from "../../src/mcp/save-turn";
import { updateSessionTool } from "../../src/mcp/update-session";

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
      description: "Initial session summary",
      insight: "- initial insight",
      startedAtEpoch: 100,
      updatedAtEpoch: 110,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  test("saveTurnTool persists extracted content and observations", () => {
    const result = saveTurnTool(db, {
      session_id: sessionId,
      prompt_number: 1,
      user_prompt: "Fix the auth race",
      assistant_response: "Added a mutex and coverage.",
      title: "Fix auth race",
      description: "Persists the extracted turn",
      insight: "- regression covered",
      files_read: ["src/auth.ts"],
      files_modified: ["src/auth.ts", "tests/auth.test.ts"],
      created_at_epoch: 200,
      updated_at_epoch: 210,
      observations: [
        {
          type: "bugfix",
          title: "Auth mutex",
          description: "Guards refresh",
          narrative: "Refresh work now serializes correctly.",
          facts: ["mutex added"],
          concepts: ["problem-solution"],
          files_read: ["src/auth.ts"],
          files_modified: ["src/auth.ts"],
        },
      ],
    });

    const turn = getTurn(db, sessionId, 1)!;
    const observations = getObservationsForTurn(db, turn.id);

    expect(result.content[0]?.text).toContain("Saved turn #1");
    expect(turn.status).toBe("extracted");
    expect(turn.title).toBe("Fix auth race");
    expect(observations).toHaveLength(1);
    expect(observations[0]?.title).toBe("Auth mutex");
  });

  test("saveTurnTool uses skip semantics when content is empty", () => {
    saveTurnTool(db, {
      session_id: sessionId,
      prompt_number: 2,
      user_prompt: "Thanks",
      assistant_response: "You're welcome.",
      created_at_epoch: 220,
    });

    const turn = getTurn(db, sessionId, 2)!;

    expect(turn.status).toBe("skipped");
    expect(getObservationsForTurn(db, turn.id)).toHaveLength(0);
  });

  test("saveTurnTool supports explicit undone status", () => {
    saveTurnTool(db, {
      session_id: sessionId,
      prompt_number: 3,
      user_prompt: "Undone branch",
      assistant_response: "No longer part of the final path.",
      title: "Temporary branch",
      description: "Will be cleared",
      observations: [
        {
          type: "change",
          title: "Temporary change",
        },
      ],
      created_at_epoch: 230,
      updated_at_epoch: 235,
    });

    const result = saveTurnTool(db, {
      session_id: sessionId,
      prompt_number: 3,
      status: "undone",
      updated_at_epoch: 240,
    });

    const turn = getTurn(db, sessionId, 3)!;

    expect(result.content[0]?.text).toContain("status undone");
    expect(turn.status).toBe("undone");
    expect(getObservationsForTurn(db, turn.id)).toHaveLength(0);
  });

  test("updateSessionTool updates the session summary", () => {
    const result = updateSessionTool(db, {
      session_id: sessionId,
      title: "After update",
      description: "Updated session summary",
      insight: "- updated insight",
      completed_at_epoch: 300,
    });

    const session = getSession(db, sessionId)!;

    expect(result.content[0]?.text).toContain(`Updated session ${sessionId}`);
    expect(session.title).toBe("After update");
    expect(session.description).toBe("Updated session summary");
    expect(session.insight).toBe("- updated insight");
    expect(session.completedAtEpoch).toBe(300);
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
    expect(turn.description).toBe("Summarize the mutex fix and regression coverage.");
  });

  test("rememberTool routes a turn parent to an observation child", () => {
    db.query(
      "INSERT INTO turns (session_id, prompt_number, status, title, description, created_at_epoch) VALUES (?, ?, 'extracted', ?, ?, ?)",
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
      created_at_epoch: 350,
    });

    const turn = getTurn(db, sessionId, 5)!;
    const observations = getObservationsForTurn(db, turn.id);

    expect(result.content[0]?.text).toContain("Saved observation");
    expect(observations).toHaveLength(1);
    expect(observations[0]?.description).toBe("auth.ts now locks refresh work.");
    expect(observations[0]?.insight).toBe(
      "Concurrent requests now share one refresh promise.",
    );
    expect(observations[0]?.concepts).toEqual(["auth", "concurrency"]);
  });

  test("rememberTool routes a session id to session summary updates", () => {
    const result = rememberTool(db, {
      id: `S${sessionId}`,
      title: "After remember update",
      content: "Updated through the remember tool.",
      insight: "- session updated",
      completed_at_epoch: 360,
    });

    const session = getSession(db, sessionId)!;

    expect(result.content[0]?.text).toContain(`Updated session ${sessionId}`);
    expect(session.description).toBe("Updated through the remember tool.");
    expect(session.insight).toBe("- session updated");
    expect(session.completedAtEpoch).toBe(360);
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
      created_at_epoch: 370,
    });

    const created = listMemories(db)[0]!;

    const updateResult = rememberTool(db, {
      id: `M${created.id}`,
      content: "Use the real database for persistence integration tests.",
      status: "archived",
      updated_at_epoch: 380,
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
