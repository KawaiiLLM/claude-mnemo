import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema, migrateSchema } from "../../src/db/schema";

describe("initializeSchema", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  test("creates the core tables and FTS table", () => {
    initializeSchema(db);

    const tableNames = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual table')",
      )
      .all()
      .map((row) => row.name);

    expect(tableNames).toContain("sessions");
    expect(tableNames).toContain("turns");
    expect(tableNames).toContain("observations");
    expect(tableNames).toContain("memory_fts");
  });

  test("creates the expected columns on sessions", () => {
    initializeSchema(db);

    const columns = db
      .query<{ name: string }, []>("PRAGMA table_info(sessions)")
      .all()
      .map((row) => row.name);

    expect(columns).toEqual([
      "id",
      "content_session_id",
      "project",
      "title",
      "description",
      "insight",
      "next_steps",
      "started_at_epoch",
      "updated_at_epoch",
      "completed_at_epoch",
    ]);
  });

  test("enforces unique prompt numbers per session", () => {
    initializeSchema(db);

    db.query(
      "INSERT INTO sessions (content_session_id, project, started_at_epoch) VALUES (?, ?, ?)",
    ).run("session-1", "claude-mnemo", 1);

    const session = db
      .query<{ id: number }, []>("SELECT id FROM sessions WHERE content_session_id = ?")
      .get("session-1");

    db.query(
      "INSERT INTO turns (session_id, prompt_number, status, created_at_epoch) VALUES (?, ?, ?, ?)",
    ).run(session.id, 1, "pending", 1);

    expect(() => {
      db.query(
        "INSERT INTO turns (session_id, prompt_number, status, created_at_epoch) VALUES (?, ?, ?, ?)",
      ).run(session.id, 1, "pending", 2);
    }).toThrow();
  });

  test("cascades deletes from sessions to turns and observations", () => {
    initializeSchema(db);

    db.query(
      "INSERT INTO sessions (content_session_id, project, started_at_epoch) VALUES (?, ?, ?)",
    ).run("session-2", "claude-mnemo", 1);

    const session = db
      .query<{ id: number }, []>("SELECT id FROM sessions WHERE content_session_id = ?")
      .get("session-2");

    db.query(
      "INSERT INTO turns (session_id, prompt_number, status, created_at_epoch) VALUES (?, ?, ?, ?)",
    ).run(session.id, 1, "extracted", 1);

    const turn = db
      .query<{ id: number }, []>(
        "SELECT id FROM turns WHERE session_id = ? AND prompt_number = ?",
      )
      .get(session.id, 1);

    db.query(
      "INSERT INTO observations (turn_id, type, title, created_at_epoch) VALUES (?, ?, ?, ?)",
    ).run(turn.id, "discovery", "found behavior", 1);

    db.query("DELETE FROM sessions WHERE id = ?").run(session.id);

    const turnCount = db
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM turns")
      .get().count;
    const observationCount = db
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM observations")
      .get().count;

    expect(turnCount).toBe(0);
    expect(observationCount).toBe(0);
  });

  test("is idempotent when run more than once", () => {
    initializeSchema(db);
    initializeSchema(db);

    const turnColumns = db
      .query<{ name: string }, []>("PRAGMA table_info(turns)")
      .all()
      .map((row) => row.name);

    expect(turnColumns).toContain("user_prompt");
    expect(turnColumns).toContain("assistant_response");
    expect(turnColumns).toContain("files_read");
    expect(turnColumns).toContain("files_modified");
  });

  test("migrates sessions and turns to add next_steps and tool_call_count", () => {
    db.exec(`
      CREATE TABLE sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_session_id TEXT UNIQUE NOT NULL,
        project TEXT NOT NULL,
        title TEXT,
        description TEXT,
        insight TEXT,
        started_at_epoch INTEGER NOT NULL,
        updated_at_epoch INTEGER,
        completed_at_epoch INTEGER
      );

      CREATE TABLE turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        prompt_number INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        user_prompt TEXT,
        assistant_response TEXT,
        title TEXT,
        description TEXT,
        insight TEXT,
        files_read TEXT,
        files_modified TEXT,
        created_at_epoch INTEGER NOT NULL,
        updated_at_epoch INTEGER,
        UNIQUE(session_id, prompt_number)
      );
    `);

    initializeSchema(db);
    migrateSchema(db);
    expect(() => migrateSchema(db)).not.toThrow();

    const sessionColumns = db
      .query<{ name: string }, []>("PRAGMA table_info(sessions)")
      .all()
      .map((row) => row.name);
    const turnColumns = db
      .query<{ name: string }, []>("PRAGMA table_info(turns)")
      .all()
      .map((row) => row.name);

    expect(sessionColumns).toContain("next_steps");
    expect(turnColumns).toContain("tool_call_count");
  });
});
