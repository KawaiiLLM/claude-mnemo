import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  getMnemoSessionIdForProcessSession,
  upsertProcessSessionMap,
} from "../../src/db/process-session-map";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";

describe("process-session identity map (spec D1)", () => {
  let db: Database;
  let sessionId: number;
  let otherSessionId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);

    sessionId = upsertSession(db, {
      contentSessionId: "content-a",
      project: "claude-mnemo",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 100,
      completedAtEpoch: null,
    }).id;
    otherSessionId = upsertSession(db, {
      contentSessionId: "content-b",
      project: "claude-mnemo",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 100,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  test("an unrecorded process id reads as unknown", () => {
    expect(getMnemoSessionIdForProcessSession(db, "never-seen")).toBeNull();
  });

  test("records a fresh mapping", () => {
    upsertProcessSessionMap(db, "proc-1", sessionId, 100);
    expect(getMnemoSessionIdForProcessSession(db, "proc-1")).toBe(sessionId);
  });

  test("re-upserting the same process id moves it to a different session", () => {
    // The one-process-id-to-one-session invariant: a later upsert for the
    // same key overwrites rather than erroring or accumulating.
    upsertProcessSessionMap(db, "proc-1", sessionId, 100);
    upsertProcessSessionMap(db, "proc-1", otherSessionId, 200);

    expect(getMnemoSessionIdForProcessSession(db, "proc-1")).toBe(
      otherSessionId,
    );
  });

  test("a session can be mapped from more than one process id (resume/compact)", () => {
    upsertProcessSessionMap(db, "proc-before", sessionId, 100);
    upsertProcessSessionMap(db, "proc-after", sessionId, 200);

    expect(getMnemoSessionIdForProcessSession(db, "proc-before")).toBe(
      sessionId,
    );
    expect(getMnemoSessionIdForProcessSession(db, "proc-after")).toBe(
      sessionId,
    );
  });

  test("a session's rows are dropped when the session is deleted", () => {
    upsertProcessSessionMap(db, "proc-1", sessionId, 100);
    db.query("DELETE FROM sessions WHERE id = ?").run(sessionId);

    expect(getMnemoSessionIdForProcessSession(db, "proc-1")).toBeNull();
  });
});
