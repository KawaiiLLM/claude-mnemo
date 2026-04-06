import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import {
  getRecentSessions,
  getSession,
  getSessionByContentId,
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
      description: "Investigated and fixed token refresh issues",
      insight: "- race condition reproduced",
      startedAtEpoch: 100,
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
      description: "Initial description",
      insight: "- first insight",
      startedAtEpoch: 200,
      updatedAtEpoch: 210,
      completedAtEpoch: null,
    });

    const updated = upsertSession(db, {
      contentSessionId: "content-2",
      project: "claude-mnemo",
      title: "Updated title",
      description: "Updated description",
      insight: "- updated insight",
      startedAtEpoch: 200,
      updatedAtEpoch: 260,
      completedAtEpoch: 300,
    });

    const rowCount = db
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM sessions")
      .get().count;

    expect(updated.id).toBe(created.id);
    expect(updated.title).toBe("Updated title");
    expect(updated.description).toBe("Updated description");
    expect(updated.insight).toBe("- updated insight");
    expect(updated.updatedAtEpoch).toBe(260);
    expect(updated.completedAtEpoch).toBe(300);
    expect(rowCount).toBe(1);
  });

  test("getRecentSessions orders by startedAtEpoch descending", () => {
    upsertSession(db, {
      contentSessionId: "content-3",
      project: "claude-mnemo",
      title: "Earlier",
      description: "Earlier work",
      insight: null,
      startedAtEpoch: 100,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    upsertSession(db, {
      contentSessionId: "content-4",
      project: "claude-mnemo",
      title: "Latest",
      description: "Later work",
      insight: null,
      startedAtEpoch: 400,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    upsertSession(db, {
      contentSessionId: "content-5",
      project: "claude-mnemo",
      title: "Middle",
      description: "Middle work",
      insight: null,
      startedAtEpoch: 250,
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
      description: "Memory feature work",
      insight: null,
      startedAtEpoch: 100,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    upsertSession(db, {
      contentSessionId: "content-7",
      project: "other-project",
      title: "Other work",
      description: "Something else",
      insight: null,
      startedAtEpoch: 200,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    const sessions = getRecentSessions(db, { project: "claude-mnemo" });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.contentSessionId).toBe("content-6");
  });
});
