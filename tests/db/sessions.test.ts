import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import {
  getRecentSessions,
  getSession,
  getSessionByContentId,
  updateCompactAnchor,
  upsertSession,
} from "../../src/db/sessions";

describe("session queries", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  test("upsert creates a new session and reads it back", () => {
    const session = upsertSession(db, {
      contentSessionId: "content-1",
      project: "claude-mnemo",
      title: "Auth fixes",
      content: "Investigated and fixed token refresh issues",
      insight: "- race condition reproduced",
      nextSteps: "- verify refresh token rotation",
      createdAtEpoch: 100,
      updatedAtEpoch: 110,
      completedAtEpoch: 120,
    });

    expect(session.id).toBeNumber();
    expect(getSession(db, session.id)).toEqual(session);
    expect(getSessionByContentId(db, "content-1")).toEqual(session);
  });

  test("upsert updates an existing session instead of inserting a second row", () => {
    const created = upsertSession(db, {
      contentSessionId: "content-2",
      project: "claude-mnemo",
      title: "Initial title",
      content: "Initial description",
      insight: "- first insight",
      nextSteps: "- draft follow-up",
      createdAtEpoch: 200,
      updatedAtEpoch: 210,
      completedAtEpoch: null,
    });

    const updated = upsertSession(db, {
      contentSessionId: "content-2",
      project: "claude-mnemo",
      title: "Updated title",
      content: "Updated description",
      insight: "- updated insight",
      createdAtEpoch: 200,
      updatedAtEpoch: 260,
      completedAtEpoch: 300,
    });

    const rowCount = db
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM sessions")
      .get().count;

    expect(updated.id).toBe(created.id);
    expect(updated.title).toBe("Updated title");
    expect(updated.content).toBe("Updated description");
    expect(updated.insight).toBe("- updated insight");
    expect(updated.updatedAtEpoch).toBe(260);
    expect(updated.completedAtEpoch).toBe(300);
    expect(rowCount).toBe(1);
  });

  test("preserves nextSteps when an update omits it", () => {
    const created = upsertSession(db, {
      contentSessionId: "content-8",
      project: "claude-mnemo",
      title: "Initial title",
      content: "Initial description",
      insight: "- first insight",
      nextSteps: "- keep working",
      createdAtEpoch: 300,
      updatedAtEpoch: 310,
      completedAtEpoch: null,
    });

    const updated = upsertSession(db, {
      contentSessionId: "content-8",
      project: "claude-mnemo",
      title: "Updated title",
      content: "Updated description",
      insight: "- updated insight",
      createdAtEpoch: 300,
      updatedAtEpoch: 360,
      completedAtEpoch: null,
    });

    expect(updated.id).toBe(created.id);
    expect(updated.nextSteps).toBe("- keep working");
  });

  test("getRecentSessions orders by createdAtEpoch descending", () => {
    upsertSession(db, {
      contentSessionId: "content-3",
      project: "claude-mnemo",
      title: "Earlier",
      content: "Earlier work",
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    upsertSession(db, {
      contentSessionId: "content-4",
      project: "claude-mnemo",
      title: "Latest",
      content: "Later work",
      insight: null,
      createdAtEpoch: 400,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    upsertSession(db, {
      contentSessionId: "content-5",
      project: "claude-mnemo",
      title: "Middle",
      content: "Middle work",
      insight: null,
      createdAtEpoch: 250,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    const sessions = getRecentSessions(db);

    expect(sessions.map((session) => session.contentSessionId)).toEqual([
      "content-4",
      "content-5",
      "content-3",
    ]);
  });

  test("getRecentSessions filters by project", () => {
    upsertSession(db, {
      contentSessionId: "content-6",
      project: "claude-mnemo",
      title: "Mnemo work",
      content: "Memory feature work",
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    upsertSession(db, {
      contentSessionId: "content-7",
      project: "other-project",
      title: "Other work",
      content: "Something else",
      insight: null,
      createdAtEpoch: 200,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    const sessions = getRecentSessions(db, { project: "claude-mnemo" });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.contentSessionId).toBe("content-6");
  });

  test("updateCompactAnchor ignores active turns and anchors on the latest finalized turn", () => {
    const session = upsertSession(db, {
      contentSessionId: "content-9",
      project: "claude-mnemo",
      title: "Anchor test",
      content: "Anchor content",
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, created_at_epoch
      ) VALUES
        (?, 1, 'extracted', 'first', 110),
        (?, 2, 'undone', 'second', 120),
        (?, 3, 'active', 'third', 130)`,
    ).run(session.id, session.id, session.id);

    updateCompactAnchor(db, session.id);

    expect(getSession(db, session.id)?.lastCompactTurn).toBe(2);
  });
});
