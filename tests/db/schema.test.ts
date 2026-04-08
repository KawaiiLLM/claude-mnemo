import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { createMemory } from "../../src/db/memories";
import {
  initializeDatabase,
  initializeSchema,
  migrateSchema,
} from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import * as searchModule from "../../src/db/search";

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
    expect(tableNames).toContain("memories");
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
      "content",
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
    expect(turnColumns).toContain("content");
    expect(turnColumns).toContain("assistant_response");
    expect(turnColumns).toContain("files_read");
    expect(turnColumns).toContain("files_modified");
  });

  test("creates the memory indexes and content-based observation columns", () => {
    initializeDatabase(db);

    const observationColumns = db
      .query<{ name: string }, []>("PRAGMA table_info(observations)")
      .all()
      .map((row) => row.name);
    const memoryIndexes = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'memories'",
      )
      .all()
      .map((row) => row.name);
    const ftsColumns = db
      .query<{ name: string }, []>("PRAGMA table_info(memory_fts)")
      .all()
      .map((row) => row.name);

    expect(observationColumns).toContain("content");
    expect(observationColumns).toContain("insight");
    expect(observationColumns).toContain("tags");
    expect(memoryIndexes).toContain("idx_memories_scope");
    expect(memoryIndexes).toContain("idx_memories_type");
    expect(memoryIndexes).toContain("idx_memories_status");
    expect(ftsColumns).toContain("content");
  });

  test("skips rebuilding the search index when the database is empty", () => {
    const rebuildSpy = spyOn(searchModule, "rebuildSearchIndex");

    initializeDatabase(db);

    expect(rebuildSpy).not.toHaveBeenCalled();

    rebuildSpy.mockRestore();
  });

  test("rebuilds the search index when a populated layer is missing from FTS", () => {
    initializeSchema(db);

    upsertSession(db, {
      contentSessionId: "session-fts-rebuild",
      project: "claude-mnemo",
      title: "FTS rebuild",
      description: "Needs an indexed session row",
      insight: null,
      startedAtEpoch: 10,
      updatedAtEpoch: 20,
      completedAtEpoch: null,
    });

    createMemory(db, {
      type: "feedback",
      scope: "global",
      title: "Rebuild FTS gate",
      content: "The startup gate should restore missing memory rows.",
      reasoning: null,
      application: null,
      tags: ["fts"],
      createdAtEpoch: 30,
      updatedAtEpoch: null,
      sourceTurnId: null,
      status: "active",
      supersededBy: null,
      expiresAtEpoch: null,
    });

    db.query("DELETE FROM memory_fts WHERE layer = 'memory'").run();

    const rebuildSpy = spyOn(searchModule, "rebuildSearchIndex");

    initializeDatabase(db);

    expect(rebuildSpy).toHaveBeenCalledTimes(1);
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM memory_fts WHERE layer = 'memory'",
        )
        .get().count,
    ).toBe(1);

    rebuildSpy.mockRestore();
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

  test("skips observation backfill rows that have no legacy source values", () => {
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

      CREATE TABLE observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        turn_id INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        narrative TEXT,
        facts TEXT,
        concepts TEXT,
        files_read TEXT,
        files_modified TEXT,
        created_at_epoch INTEGER NOT NULL
      );
    `);

    db.query(
      `INSERT INTO sessions (content_session_id, project, started_at_epoch)
       VALUES (?, ?, ?)`,
    ).run("legacy-session", "claude-mnemo", 1);

    const session = db
      .query<{ id: number }, []>("SELECT id FROM sessions WHERE content_session_id = ?")
      .get("legacy-session");

    db.query(
      `INSERT INTO turns (
        session_id,
        prompt_number,
        status,
        user_prompt,
        created_at_epoch
      ) VALUES (?, ?, ?, ?, ?)`,
    ).run(session.id, 1, "extracted", "Legacy turn", 2);

    const turn = db
      .query<{ id: number }, []>("SELECT id FROM turns WHERE session_id = ?")
      .get(session.id);

    db.query(
      `INSERT INTO observations (
        turn_id,
        type,
        title,
        description,
        narrative,
        facts,
        concepts,
        files_read,
        files_modified,
        created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      turn.id,
      "discovery",
      "No legacy source data",
      null,
      null,
      null,
      null,
      null,
      null,
      3,
    );

    db.query(
      `INSERT INTO observations (
        turn_id,
        type,
        title,
        description,
        narrative,
        facts,
        concepts,
        files_read,
        files_modified,
        created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      turn.id,
      "bugfix",
      "Legacy backfill data",
      "Legacy description",
      "Legacy narrative",
      JSON.stringify(["legacy fact"]),
      JSON.stringify(["legacy-tag"]),
      JSON.stringify(["src/legacy.ts"]),
      JSON.stringify(["src/legacy.ts"]),
      4,
    );

    initializeSchema(db);
    migrateSchema(db);

    const untouchedObservation = db
      .query<
        { content: string | null; insight: string | null; tags: string | null },
        [number]
      >("SELECT content, insight, tags FROM observations WHERE title = ?")
      .get("No legacy source data");
    const migratedObservation = db
      .query<
        { content: string | null; insight: string | null; tags: string | null },
        [number]
      >("SELECT content, insight, tags FROM observations WHERE title = ?")
      .get("Legacy backfill data");

    expect(untouchedObservation).toEqual({
      content: null,
      insight: null,
      tags: null,
    });
    expect(migratedObservation).toEqual({
      content: "Legacy description",
      insight: "Legacy narrative",
      tags: JSON.stringify(["legacy-tag"]),
    });
  });

  test("initializeDatabase applies schema creation and migrations together", () => {
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

    initializeDatabase(db);

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
