import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { createMemory } from "../../src/db/memories";
import {
  initializeDatabase,
  initializeSchema,
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
    expect(tableNames).toContain("pending_queue");
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
      "insight",
      "next_steps",
      "last_compact_turn",
      "last_agent_session_id",
      "summary_updated_at_epoch",
      "created_at_epoch",
      "updated_at_epoch",
      "completed_at_epoch",
    ]);
  });

  test("enforces unique prompt numbers per session", () => {
    initializeSchema(db);

    db.query(
      "INSERT INTO sessions (content_session_id, project, created_at_epoch) VALUES (?, ?, ?)",
    ).run("session-1", "claude-mnemo", 1);

    const session = db
      .query<{ id: number }, []>("SELECT id FROM sessions WHERE content_session_id = ?")
      .get("session-1");

    db.query(
      "INSERT INTO turns (session_id, prompt_number, status, created_at_epoch) VALUES (?, ?, ?, ?)",
    ).run(session.id, 1, "active", 1);

    expect(() => {
      db.query(
        "INSERT INTO turns (session_id, prompt_number, status, created_at_epoch) VALUES (?, ?, ?, ?)",
      ).run(session.id, 1, "active", 2);
    }).toThrow();
  });

  test("cascades deletes from sessions to turns and observations", () => {
    initializeSchema(db);

    db.query(
      "INSERT INTO sessions (content_session_id, project, created_at_epoch) VALUES (?, ?, ?)",
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
      "INSERT INTO observations (turn_id, tool_name, title, created_at_epoch) VALUES (?, ?, ?, ?)",
    ).run(turn.id, "Read", "found behavior", 1);

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

  test("allows worker-style observations with only tool payload and pending status", () => {
    initializeDatabase(db);

    const sessionId = db
      .query<{ id: number }, []>(
        "INSERT INTO sessions (content_session_id, project, created_at_epoch) VALUES ('schema-session', 'claude-mnemo', 1) RETURNING id",
      )
      .get()!.id;
    const turnId = db
      .query<{ id: number }, [number]>(
        "INSERT INTO turns (session_id, prompt_number, status, created_at_epoch) VALUES (?, 1, 'active', 2) RETURNING id",
      )
      .get(sessionId)!.id;

    db.query(
      `
        INSERT INTO observations (
          turn_id,
          tool_name,
          tool_input,
          tool_result,
          created_at_epoch
        ) VALUES (?, ?, ?, ?, ?)
      `,
    ).run(turnId, "Read", '{"file_path":"src/auth.ts"}', "file contents", 3);

    const inserted = db
      .query<
        { toolName: string | null; status: string; title: string | null },
        []
      >(
        `
          SELECT
            tool_name AS toolName,
            status,
            title
          FROM observations
        `,
      )
      .get()!;

    expect(inserted.toolName).toBe("Read");
    expect(inserted.status).toBe("pending");
    expect(inserted.title).toBeNull();
  });

  test("creates the expected columns on observations without legacy narrative fields", () => {
    initializeSchema(db);

    const columns = db
      .query<{ name: string }, []>("PRAGMA table_info(observations)")
      .all()
      .map((row) => row.name);

    expect(columns).toEqual([
      "id",
      "turn_id",
      "tool_name",
      "tool_input",
      "tool_result",
      "status",
      "title",
      "content",
      "created_at_epoch",
    ]);
  });

  test("initializeSchema adds summary_updated_at_epoch to an existing sessions table without resetting data", () => {
    db.exec(`
      CREATE TABLE sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_session_id TEXT UNIQUE NOT NULL,
        project TEXT NOT NULL,
        title TEXT,
        content TEXT,
        insight TEXT,
        next_steps TEXT,
        last_compact_turn INTEGER,
        last_agent_session_id TEXT,
        created_at_epoch INTEGER NOT NULL,
        updated_at_epoch INTEGER,
        completed_at_epoch INTEGER
      )
    `);

    db.query(
      `
        INSERT INTO sessions (
          content_session_id,
          project,
          title,
          created_at_epoch,
          updated_at_epoch
        ) VALUES (?, ?, ?, ?, ?)
      `,
    ).run("legacy-session", "claude-mnemo", "Legacy", 10, 20);

    initializeSchema(db);

    const columns = db
      .query<{ name: string }, []>("PRAGMA table_info(sessions)")
      .all()
      .map((row) => row.name);
    const session = db
      .query<
        {
          title: string | null;
          summaryUpdatedAtEpoch: number | null;
        },
        []
      >(
        `
          SELECT
            title,
            summary_updated_at_epoch AS summaryUpdatedAtEpoch
          FROM sessions
          WHERE content_session_id = ?
        `,
      )
      .get("legacy-session");

    expect(columns).toContain("summary_updated_at_epoch");
    expect(session).toEqual({
      title: "Legacy",
      summaryUpdatedAtEpoch: null,
    });
  });

  test("initializeDatabase keeps fresh observations schema free of legacy insight and tags columns", () => {
    initializeDatabase(db);

    const columns = db
      .query<{ name: string }, []>("PRAGMA table_info(observations)")
      .all()
      .map((row) => row.name);

    expect(columns).toEqual([
      "id",
      "turn_id",
      "tool_name",
      "tool_input",
      "tool_result",
      "status",
      "title",
      "content",
      "created_at_epoch",
    ]);
  });

  test("initializeDatabase drops legacy schema instead of migrating it in place", () => {
    db.exec(`
      CREATE TABLE sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_session_id TEXT UNIQUE NOT NULL,
        project TEXT NOT NULL,
        title TEXT,
        description TEXT,
        started_at_epoch INTEGER NOT NULL,
        updated_at_epoch INTEGER,
        completed_at_epoch INTEGER
      );

      CREATE TABLE turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL,
        prompt_number INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        user_prompt TEXT,
        assistant_response TEXT,
        title TEXT,
        description TEXT,
        created_at_epoch INTEGER NOT NULL,
        updated_at_epoch INTEGER
      );

      CREATE TABLE observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        turn_id INTEGER NOT NULL,
        type TEXT,
        title TEXT,
        description TEXT,
        insight TEXT,
        narrative TEXT,
        facts TEXT,
        tags TEXT,
        concepts TEXT,
        files_read TEXT,
        files_modified TEXT,
        created_at_epoch INTEGER NOT NULL
      );
    `);

    db.query(
      "INSERT INTO sessions (content_session_id, project, title, description, started_at_epoch) VALUES (?, ?, ?, ?, ?)",
    ).run("legacy-session", "claude-mnemo", "Legacy", "Old desc", 1);

    initializeDatabase(db);

    const sessionColumns = db
      .query<{ name: string }, []>("PRAGMA table_info(sessions)")
      .all()
      .map((row) => row.name);
    const observationColumns = db
      .query<{ name: string }, []>("PRAGMA table_info(observations)")
      .all()
      .map((row) => row.name);

    expect(sessionColumns).toEqual([
      "id",
      "content_session_id",
      "project",
      "title",
      "content",
      "insight",
      "next_steps",
      "last_compact_turn",
      "last_agent_session_id",
      "summary_updated_at_epoch",
      "created_at_epoch",
      "updated_at_epoch",
      "completed_at_epoch",
    ]);
    expect(observationColumns).toEqual([
      "id",
      "turn_id",
      "tool_name",
      "tool_input",
      "tool_result",
      "status",
      "title",
      "content",
      "created_at_epoch",
    ]);
    expect(
      db
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM sessions")
        .get().count,
    ).toBe(0);
  });

  test("initializeDatabase warns before resetting a legacy schema", () => {
    db.exec(`
      CREATE TABLE sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_session_id TEXT UNIQUE NOT NULL,
        project TEXT NOT NULL,
        description TEXT,
        started_at_epoch INTEGER NOT NULL
      );
    `);

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    initializeDatabase(db);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain(
      "legacy schema detected, resetting database",
    );

    warnSpy.mockRestore();
  });

  test("initializeDatabase does not reset a current observations schema just because an extra tags column exists", () => {
    initializeSchema(db);

    db.exec("ALTER TABLE observations ADD COLUMN tags TEXT");
    db.query(
      `
        INSERT INTO sessions (content_session_id, project, created_at_epoch)
        VALUES ('keep-current-schema', 'claude-mnemo', 1)
      `,
    ).run();

    initializeDatabase(db);

    expect(
      db
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM sessions")
        .get().count,
    ).toBe(1);
  });

  test("initializeSchema adds last_agent_session_id to an existing sessions table without resetting data", () => {
    db.exec(`
      CREATE TABLE sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_session_id TEXT UNIQUE NOT NULL,
        project TEXT NOT NULL,
        title TEXT,
        content TEXT,
        insight TEXT,
        next_steps TEXT,
        last_compact_turn INTEGER,
        created_at_epoch INTEGER NOT NULL,
        updated_at_epoch INTEGER,
        completed_at_epoch INTEGER
      );
    `);
    db.query(
      `
        INSERT INTO sessions (
          content_session_id,
          project,
          title,
          created_at_epoch
        ) VALUES (?, ?, ?, ?)
      `,
    ).run("existing-session", "claude-mnemo", "Existing", 1);

    initializeSchema(db);

    const columns = db
      .query<{ name: string }, []>("PRAGMA table_info(sessions)")
      .all()
      .map((row) => row.name);
    const session = db
      .query<
        { contentSessionId: string; lastAgentSessionId: string | null },
        []
      >(
        `
          SELECT
            content_session_id AS contentSessionId,
            last_agent_session_id AS lastAgentSessionId
          FROM sessions
        `,
      )
      .get();

    expect(columns).toContain("last_agent_session_id");
    expect(session).toEqual({
      contentSessionId: "existing-session",
      lastAgentSessionId: null,
    });
  });

  test("initializeSchema adds transcript_line_start to an existing turns table without resetting data", () => {
    db.exec(`
      CREATE TABLE sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_session_id TEXT UNIQUE NOT NULL,
        project TEXT NOT NULL,
        title TEXT,
        content TEXT,
        insight TEXT,
        next_steps TEXT,
        last_compact_turn INTEGER,
        last_agent_session_id TEXT,
        created_at_epoch INTEGER NOT NULL,
        updated_at_epoch INTEGER,
        completed_at_epoch INTEGER
      );

      CREATE TABLE turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        prompt_number INTEGER NOT NULL,
        content_prompt_id TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        user_prompt TEXT,
        assistant_response TEXT,
        title TEXT,
        content TEXT,
        insight TEXT,
        type TEXT,
        tags TEXT,
        files_read TEXT,
        files_modified TEXT,
        tool_call_count INTEGER,
        created_at_epoch INTEGER NOT NULL,
        updated_at_epoch INTEGER,
        UNIQUE(session_id, prompt_number)
      );
    `);
    db.query(
      `
        INSERT INTO sessions (
          content_session_id,
          project,
          created_at_epoch
        ) VALUES (?, ?, ?)
      `,
    ).run("existing-session", "claude-mnemo", 1);
    db.query(
      `
        INSERT INTO turns (
          session_id,
          prompt_number,
          status,
          created_at_epoch
        ) VALUES (
          (SELECT id FROM sessions WHERE content_session_id = ?),
          ?,
          ?,
          ?
        )
      `,
    ).run("existing-session", 1, "active", 2);

    initializeSchema(db);

    const columns = db
      .query<{ name: string }, []>("PRAGMA table_info(turns)")
      .all()
      .map((row) => row.name);
    const turnCount = db
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM turns")
      .get().count;
    const turn = db
      .query<
        { promptNumber: number; transcriptLineStart: number | null },
        []
      >(
        `
          SELECT
            prompt_number AS promptNumber,
            transcript_line_start AS transcriptLineStart
          FROM turns
        `,
      )
      .get();

    expect(columns).toContain("transcript_line_start");
    expect(turnCount).toBe(1);
    expect(turn).toEqual({
      promptNumber: 1,
      transcriptLineStart: null,
    });
  });

  test("creates the worker queue table with FIFO and claim columns", () => {
    initializeSchema(db);

    const queueColumns = db
      .query<{ name: string }, []>("PRAGMA table_info(pending_queue)")
      .all()
      .map((row) => row.name);
    const queueIndexes = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'pending_queue'",
      )
      .all()
      .map((row) => row.name);

    expect(queueColumns).toEqual([
      "seq",
      "kind",
      "target_id",
      "session_db_id",
      "claimed_at_epoch",
      "enqueued_at_epoch",
    ]);
    expect(queueIndexes).toContain("idx_pending_queue_unclaimed");
    expect(queueIndexes).toContain("idx_pending_queue_session");
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
      content: "Needs an indexed session row",
      insight: null,
      createdAtEpoch: 10,
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

});
