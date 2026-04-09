import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { buildExtractionContext } from "../../src/mnemosyne/context";

describe("buildExtractionContext", () => {
  let db: Database;
  let sessionId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);

    sessionId = upsertSession(db, {
      contentSessionId: "session-extraction-context",
      project: "/Users/zhaoqixuan/Projects/claude-mnemo",
      title: "Extraction context session",
      content: "Testing extraction context formatting",
      insight: "- session insight",
      nextSteps: "Ship async hooks",
      createdAtEpoch: 100,
      updatedAtEpoch: 110,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  test("expands actionable turns and collapses settled turns", () => {
    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, assistant_response, title, content, insight, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sessionId,
      1,
      "extracted",
      "Already done",
      "Settled response",
      "Settled turn",
      "Settled content",
      "- settled insight",
      120,
    );
    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, assistant_response, title, content, insight, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sessionId,
      2,
      "extracting_pending",
      "Pending work",
      "Fresh response",
      "Actionable turn",
      "Actionable content",
      "- actionable insight",
      130,
    );
    const turnId = db
      .query<{ id: number }, [number, number]>(
        "SELECT id FROM turns WHERE session_id = ? AND prompt_number = ?",
      )
      .get(sessionId, 2)!.id;
    db.query(
      `INSERT INTO observations (
        turn_id, type, title, content, insight, tags, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      turnId,
      "discovery",
      "Existing observation",
      "Observation content",
      "Observation insight",
      JSON.stringify(["tagged"]),
      131,
    );

    const context = buildExtractionContext(db, sessionId);

    expect(context).toContain(`[S${sessionId}][T1] Settled turn [extracted]`);
    expect(context).not.toContain('prompt: "Already done"');
    expect(context).toContain(`[S${sessionId}][T2] Actionable turn`);
    expect(context).toContain("[pending]");
    expect(context).toContain('prompt: "Pending work"');
    expect(context).toContain('response: "Fresh response"');
    expect(context).toContain("- actionable insight");
    expect(context).toContain("[O");
    expect(context).toContain("Existing observation");
    expect(context).toContain(`[S${sessionId}] Extraction context session`);
    expect(context.indexOf(`[S${sessionId}][T1] Settled turn [extracted]`)).toBeLessThan(
      context.indexOf(`[S${sessionId}] Extraction context session`),
    );
  });

  test("filters out turns at or before the compact anchor unless they are actionable", () => {
    db.query(
      `UPDATE sessions SET last_compact_turn = ? WHERE id = ?`,
    ).run(2, sessionId);
    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, title, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(sessionId, 1, "extracted", "Old turn", "Old turn", 120);
    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, title, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(sessionId, 2, "extracting_stale", "Old but actionable", "Old stale turn", 130);
    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, title, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(sessionId, 3, "extracted", "Recent turn", "Recent turn", 140);

    const context = buildExtractionContext(db, sessionId);

    expect(context).not.toContain("[T1] Old turn");
    expect(context).toContain("[T2] Old stale turn [stale]");
    expect(context).toContain("[T3] Recent turn [extracted]");
  });
});
