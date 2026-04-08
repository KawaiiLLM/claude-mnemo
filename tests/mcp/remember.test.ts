import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { listMemories } from "../../src/db/memories";
import { getObservationsForTurn } from "../../src/db/observations";
import { initializeSchema } from "../../src/db/schema";
import { getSession, upsertSession } from "../../src/db/sessions";
import { getTurn } from "../../src/db/turns";
import { rememberTool } from "../../src/mcp/remember";

describe("remember tool routing and validation", () => {
  let db: Database;
  let sessionId: number;

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
  });

  afterEach(() => {
    db.close();
  });

  test("honors an explicit prompt_number override for turn writes", () => {
    db.query(
      "INSERT INTO turns (session_id, prompt_number, status, user_prompt, created_at_epoch) VALUES (?, ?, 'pending', ?, ?)",
    ).run(sessionId, 1, "Existing pending turn", 120);

    const result = rememberTool(db, {
      parent: `S${sessionId}`,
      prompt_number: 7,
      title: "Explicit turn number",
      content: "Use the provided prompt number instead of deriving the next one.",
      insight: "- prompt number override respected",
    });

    const explicitTurn = getTurn(db, sessionId, 7);
    const pendingTurn = getTurn(db, sessionId, 1);

    expect(result.content[0]?.text).toContain("Saved turn #7");
    expect(explicitTurn?.status).toBe("extracted");
    expect(explicitTurn?.content).toBe(
      "Use the provided prompt number instead of deriving the next one.",
    );
    expect(pendingTurn?.status).toBe("pending");
  });

  test("rejects invalid statuses for turn writes", () => {
    const result = rememberTool(db, {
      parent: `S${sessionId}`,
      status: "active" as never,
      title: "Invalid status",
      content: "This should not be persisted.",
    });

    expect(result.content[0]?.text).toContain("Parameter error:");
    expect(result.content[0]?.text).toContain("turn remember");
    expect(getTurn(db, sessionId, 1)).toBeNull();
  });

  test("rejects invalid statuses for observation writes", () => {
    db.query(
      "INSERT INTO turns (session_id, prompt_number, status, user_prompt, created_at_epoch) VALUES (?, ?, 'extracted', ?, ?)",
    ).run(sessionId, 2, "Existing turn", 140);

    const result = rememberTool(db, {
      parent: `S${sessionId}/T2`,
      status: "active" as never,
      type: "bugfix",
      title: "Invalid observation",
      content: "This should not be recorded.",
    });

    const turn = getTurn(db, sessionId, 2)!;

    expect(result.content[0]?.text).toContain("Parameter error:");
    expect(result.content[0]?.text).toContain("observation remember");
    expect(getObservationsForTurn(db, turn.id)).toHaveLength(0);
  });

  test("rejects invalid statuses for session updates", () => {
    const result = rememberTool(db, {
      id: `S${sessionId}`,
      status: "skipped" as never,
      title: "Should not update",
      content: "This should be rejected.",
    });

    const session = getSession(db, sessionId)!;

    expect(result.content[0]?.text).toContain("Parameter error:");
    expect(result.content[0]?.text).toContain("session remember");
    expect(session.title).toBe("Before update");
    expect(session.content).toBe("Initial session summary");
  });

  test("rejects invalid statuses for memory writes", () => {
    const result = rememberTool(db, {
      type: "feedback",
      scope: "global",
      title: "Invalid memory",
      content: "This should not be written.",
      status: "skipped" as never,
    });

    expect(result.content[0]?.text).toContain("Parameter error:");
    expect(result.content[0]?.text).toContain("memory remember");
    expect(listMemories(db)).toHaveLength(0);
  });
});
