import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  backfillAllIntraChains,
  initializeDatabase,
  initializeSchema,
} from "../../src/db/schema";
import { getSession, upsertSession } from "../../src/db/sessions";
import { getTurnById } from "../../src/db/turns";
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
    expect(tableNames).toContain("pending_queue");
    expect(tableNames).toContain("memory_fts");
  });

  test("creates only the dream scheduling columns for each date", () => {
    initializeSchema(db);
    const columns = db
      .query<{ name: string }, []>("PRAGMA table_info(diary_day_state)")
      .all()
      .map((row) => row.name);
    expect(columns).toEqual([
      "date",
      "watermark",
      "settled_at_epoch",
      "needs_regen",
      "attempt_count",
      "next_attempt_epoch",
      "last_error",
    ]);
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
      "decision",
      "done",
      "current",
      "reference",
      "last_compact_turn",
      "last_agent_session_id",
      "summary_updated_at_epoch",
      "created_at_epoch",
      "updated_at_epoch",
      "completed_at_epoch",
      "parent_session_id",
      "lineage_status",
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
    expect(turnColumns).toContain("was_interrupted");
    expect(turnColumns).toContain("was_rolled_back");
  });

  test("creates invalidation columns on turns", () => {
    initializeSchema(db);

    const columns = db
      .query<{ name: string }, []>("PRAGMA table_info(turns)")
      .all()
      .map((row) => row.name);

    expect(columns).toContain("was_interrupted");
    expect(columns).toContain("was_rolled_back");
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
      "decision",
      "done",
      "current",
      "reference",
      "last_compact_turn",
      "last_agent_session_id",
      "summary_updated_at_epoch",
      "created_at_epoch",
      "updated_at_epoch",
      "completed_at_epoch",
      "parent_session_id",
      "lineage_status",
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

  test("initializeSchema adds assistant_transcript to an existing turns table without resetting data", () => {
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
          assistant_response,
          created_at_epoch
        ) VALUES (
          (SELECT id FROM sessions WHERE content_session_id = ?),
          ?,
          ?,
          ?,
          ?
        )
      `,
    ).run("existing-session", 1, "extracted", "Final block", 2);

    initializeSchema(db);

    const columns = db
      .query<{ name: string }, []>("PRAGMA table_info(turns)")
      .all()
      .map((row) => row.name);
    const turn = db
      .query<
        { assistantResponse: string | null; assistantTranscript: string | null },
        []
      >(
        `
          SELECT
            assistant_response AS assistantResponse,
            assistant_transcript AS assistantTranscript
          FROM turns
        `,
      )
      .get();

    expect(columns).toContain("assistant_transcript");
    // Pre-existing data preserved; the new column defaults to NULL (forward-only).
    expect(turn).toEqual({
      assistantResponse: "Final block",
      assistantTranscript: null,
    });
  });

  test("initializeSchema adds invalidation columns to an existing turns table without resetting data", () => {
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
        transcript_line_start INTEGER,
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
          user_prompt,
          created_at_epoch,
          updated_at_epoch
        ) VALUES (
          (SELECT id FROM sessions WHERE content_session_id = ?),
          ?,
          ?,
          ?,
          ?,
          ?
        )
      `,
    ).run("existing-session", 1, "active", "Legacy turn", 2, 3);

    initializeSchema(db);

    const columns = db
      .query<{ name: string }, []>("PRAGMA table_info(turns)")
      .all()
      .map((row) => row.name);
    const turn = db
      .query<
        {
          userPrompt: string | null;
          wasInterrupted: number;
          wasRolledBack: number;
        },
        []
      >(
        `
          SELECT
            user_prompt AS userPrompt,
            was_interrupted AS wasInterrupted,
            was_rolled_back AS wasRolledBack
          FROM turns
        `,
      )
      .get();

    expect(columns).toContain("was_interrupted");
    expect(columns).toContain("was_rolled_back");
    expect(turn).toEqual({
      userPrompt: "Legacy turn",
      wasInterrupted: 0,
      wasRolledBack: 0,
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

  test("creates dream persistence without the retired persona state machine", () => {
    initializeSchema(db);

    const tableNames = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type = 'table'`,
      )
      .all()
      .map((row) => row.name);
    const indexNames = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type = 'index'`,
      )
      .all()
      .map((row) => row.name);

    expect(tableNames).toContain("diary_state");
    expect(tableNames).toContain("diary_day_state");
    expect(tableNames).not.toContain("persona_operation_state");
    expect(indexNames).toContain("idx_turns_created_at");
    expect(indexNames).toContain("idx_pending_queue_diary_target");
    expect(indexNames).not.toContain("idx_persona_operation_active");
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

    db.query("DELETE FROM memory_fts WHERE layer = 'session'").run();

    const rebuildSpy = spyOn(searchModule, "rebuildSearchIndex");

    initializeDatabase(db);

    expect(rebuildSpy).toHaveBeenCalledTimes(1);
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM memory_fts WHERE layer = 'session'",
        )
        .get().count,
    ).toBe(1);

    rebuildSpy.mockRestore();
  });

  test("initializeSchema drops a legacy memories table and recreates the FTS as trigram", () => {
    const db = createDatabase(":memory:");
    db.exec(
      `CREATE TABLE memories (id INTEGER PRIMARY KEY, type TEXT, scope TEXT,
         title TEXT, content TEXT, created_at_epoch INTEGER NOT NULL);`,
    );
    db.exec(
      `CREATE VIRTUAL TABLE memory_fts USING fts5(layer, source_id, title, content, extra);`,
    );
    db.exec(
      `INSERT INTO memory_fts (layer, source_id, title, content, extra)
         VALUES ('memory', 1, 't', 'c', '');`,
    );

    initializeSchema(db);

    const table = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='memories'")
      .get();
    expect(table).toBeNull();

    const ddl = db
      .query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE name = 'memory_fts'")
      .get()!.sql;
    expect(ddl).toContain("trigram");

    const memRows = db
      .query<{ n: number }, []>("SELECT count(*) AS n FROM memory_fts WHERE layer='memory'")
      .get()!;
    expect(memRows.n).toBe(0);

    db.close();
  });

  test("memory_fts uses the trigram tokenizer with prompt/response columns", () => {
    initializeSchema(db);

    const ddl = db
      .query<{ sql: string }, []>(
        "SELECT sql FROM sqlite_master WHERE name = 'memory_fts'",
      )
      .get()!.sql;
    expect(ddl).toContain("trigram");

    const columns = db
      .query<{ name: string }, []>("PRAGMA table_info(memory_fts)")
      .all()
      .map((row) => row.name);
    expect(columns).toContain("prompt");
    expect(columns).toContain("response");
  });

  test("migrates an old 5-col FTS on a pre-summary-field DB without no-such-column", () => {
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
      CREATE VIRTUAL TABLE memory_fts USING fts5(layer, source_id, title, content, extra);
    `);
    db.query(
      "INSERT INTO sessions (content_session_id, project, title, created_at_epoch) VALUES (?, ?, ?, ?)",
    ).run("legacy-session", "claude-mnemo", "Legacy", 1);

    expect(() => initializeSchema(db)).not.toThrow();

    const ddl = db
      .query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE name = 'memory_fts'")
      .get()!.sql;
    expect(ddl).toContain("trigram");

    const sessionColumns = db
      .query<{ name: string }, []>("PRAGMA table_info(sessions)")
      .all()
      .map((row) => row.name);
    expect(sessionColumns).toContain("decision");

    const ftsCount = db
      .query<{ n: number }, []>(
        "SELECT count(*) AS n FROM memory_fts WHERE layer = 'session'",
      )
      .get()!;
    expect(ftsCount.n).toBe(1);
  });

  test("lineage columns exist with defaults", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const turnCols = db.query<{ name: string }, []>(`SELECT name FROM pragma_table_info('turns')`).all().map((r) => r.name);
    const sessCols = db.query<{ name: string }, []>(`SELECT name FROM pragma_table_info('sessions')`).all().map((r) => r.name);
    expect(turnCols).toContain("parent_turn_id");
    expect(sessCols).toContain("parent_session_id");
    expect(sessCols).toContain("lineage_status");
    const sid = upsertSession(db, { contentSessionId: "c1", project: "p", title: null, insight: null, createdAtEpoch: 1, updatedAtEpoch: null, completedAtEpoch: null }).id;
    expect(getSession(db, sid)?.lineageStatus).toBe("unchecked");
    db.close();
  });

  test("recreates an FTS table that has trigram+prompt but is missing the response column", () => {
    const db = createDatabase(":memory:");
    // Partial/intermediate schema: trigram + prompt, but NO response column.
    db.exec(`
      CREATE VIRTUAL TABLE memory_fts USING fts5(
        layer UNINDEXED, source_id UNINDEXED, title, content, extra, prompt,
        tokenize = 'trigram'
      );
    `);

    initializeSchema(db);

    const columns = db
      .query<{ name: string }, []>("PRAGMA table_info(memory_fts)")
      .all()
      .map((r) => r.name);
    expect(columns).toContain("response");

    // A subsequent index write must not throw "no column named response".
    expect(() =>
      upsertSession(db, {
        contentSessionId: "partial-schema",
        project: "claude-mnemo",
        title: "x",
        content: "y",
        insight: null,
        createdAtEpoch: 1,
        updatedAtEpoch: null,
        completedAtEpoch: null,
      }),
    ).not.toThrow();

    db.close();
  });

  test("backfillAllIntraChains links every session's intra-session chain", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);

    // Seed session A
    const sidA = db
      .query<{ id: number }, []>(
        "INSERT INTO sessions (content_session_id, project, created_at_epoch) VALUES ('sess-a', 'p', 1) RETURNING id",
      )
      .get()!.id;
    const a1 = db
      .query<{ id: number }, []>(
        `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch) VALUES (${sidA}, 1, 'active', 10) RETURNING id`,
      )
      .get()!.id;
    const a2 = db
      .query<{ id: number }, []>(
        `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch) VALUES (${sidA}, 2, 'active', 11) RETURNING id`,
      )
      .get()!.id;
    const a3 = db
      .query<{ id: number }, []>(
        `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch) VALUES (${sidA}, 3, 'active', 12) RETURNING id`,
      )
      .get()!.id;

    // Seed session B
    const sidB = db
      .query<{ id: number }, []>(
        "INSERT INTO sessions (content_session_id, project, created_at_epoch) VALUES ('sess-b', 'p', 2) RETURNING id",
      )
      .get()!.id;
    const b1 = db
      .query<{ id: number }, []>(
        `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch) VALUES (${sidB}, 1, 'active', 20) RETURNING id`,
      )
      .get()!.id;
    const b2 = db
      .query<{ id: number }, []>(
        `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch) VALUES (${sidB}, 2, 'active', 21) RETURNING id`,
      )
      .get()!.id;
    const b3 = db
      .query<{ id: number }, []>(
        `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch) VALUES (${sidB}, 3, 'active', 22) RETURNING id`,
      )
      .get()!.id;

    backfillAllIntraChains(db);

    // Session A: each non-first turn links to predecessor; first turn stays NULL
    expect(getTurnById(db, a1)!.parentTurnId).toBeNull();
    expect(getTurnById(db, a2)!.parentTurnId).toBe(a1);
    expect(getTurnById(db, a3)!.parentTurnId).toBe(a2);

    // Session B: same, no cross-session links
    expect(getTurnById(db, b1)!.parentTurnId).toBeNull();
    expect(getTurnById(db, b2)!.parentTurnId).toBe(b1);
    expect(getTurnById(db, b3)!.parentTurnId).toBe(b2);

    // No cross-session contamination: a-series and b-series are disjoint
    // (already guaranteed by b2→b1, not b1→a3 etc., but explicit check)
    expect(getTurnById(db, b2)!.parentTurnId).not.toBe(a1);
    expect(getTurnById(db, b2)!.parentTurnId).not.toBe(a2);

    // Idempotent: re-running changes nothing
    backfillAllIntraChains(db);
    expect(getTurnById(db, a2)!.parentTurnId).toBe(a1);
    expect(getTurnById(db, a3)!.parentTurnId).toBe(a2);
    expect(getTurnById(db, b2)!.parentTurnId).toBe(b1);

    db.close();
  });

});
