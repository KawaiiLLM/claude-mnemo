import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { getObservation } from "../../src/db/observations";
import { initializeDatabase } from "../../src/db/schema";
import { getSession, upsertSession } from "../../src/db/sessions";
import { getTurn, getTurnById } from "../../src/db/turns";
import { rememberTool } from "../../src/mcp/remember";

describe("MCP write tools", () => {
  let db: Database;
  let sessionId: number;
  let turnId: number;
  let observationId: number;

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

  test("rememberTool updates turns through T{id}", () => {
    const result = rememberTool(db, {
      id: `T${turnId}`,
      title: "Fix auth race",
      content: "Persists the extracted turn",
      insight: "- regression covered",
      type: "bugfix",
      tags: ["auth", "concurrency"],
    });

    const turn = getTurnById(db, turnId)!;

    expect(result.content[0]?.text).toContain(`Updated turn T${turnId}`);
    expect(turn.status).toBe("extracted");
    expect(turn.type).toBe("bugfix");
    expect(turn.tags).toEqual(["auth", "concurrency"]);
  });

  test("rememberTool updates observations through O{id}", () => {
    const result = rememberTool(db, {
      id: `O${observationId}`,
      title: "Read auth module",
      content: "auth.ts now locks refresh work.",
      status: "extracted",
    });

    const observation = getObservation(db, observationId)!;

    expect(result.content[0]?.text).toContain(`Updated observation O${observationId}`);
    expect(observation.status).toBe("extracted");
    expect(observation.content).toBe("auth.ts now locks refresh work.");
  });

  test("rememberTool rewrites the whole session summary by S{id}", () => {
    const result = rememberTool(db, {
      id: `S${sessionId}`,
      title: "After update",
      content: "Updated session summary",
      decision: "Chose a mutex over a channel",
      done: "Shipped the auth fix",
      current: "Awaiting review",
      next_steps: "Ship the follow-up cleanup",
      reference: "",
    });

    const session = getSession(db, sessionId)!;

    expect(result.content[0]?.text).toContain(`Updated session ${sessionId}`);
    expect(session.title).toBe("After update");
    expect(session.decision).toBe("Chose a mutex over a channel");
    expect(session.nextSteps).toBe("Ship the follow-up cleanup");
  });

  test("rememberTool keeps prompt-number lookup intact for existing turns", () => {
    rememberTool(db, {
      id: `T${turnId}`,
      title: "Updated title",
      content: "Updated through routed turn id.",
    });

    const turnByPromptNumber = getTurn(db, sessionId, 1)!;
    expect(turnByPromptNumber.id).toBe(turnId);
    expect(turnByPromptNumber.title).toBe("Updated title");
  });

  test("remember without an id returns a parameter error (memory creation removed)", () => {
    const result = rememberTool(db, { title: "x", content: "y" });
    expect(result.content[0]?.text).toContain("Parameter error");
    expect(result.content[0]?.text).toContain("O<n> (observation), T<n> (turn), or S<n> (session)");
  });

  test("remember rejects the removed memory-only statuses", () => {
    // `superseded` / `archived` only ever applied to M-layer memories.
    const result = rememberTool(db, { id: "T1", status: "superseded" as never });
    expect(result.content[0]?.text).toContain("Parameter error");
    expect(result.content[0]?.text).toContain("superseded");
  });

  test("remember rejects M<n> ids with a guided message (durable memory removed)", () => {
    const result = rememberTool(db, { id: "M5", title: "x", content: "y" });
    expect(result.content[0]?.text).toContain("Durable memory (M<n>) was removed");
    expect(result.content[0]?.text).toContain("O<n>");
  });
});
