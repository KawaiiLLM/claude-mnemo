import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { getEffectiveCitations } from "../../src/db/citations";
import { createDatabase } from "../../src/db/database";
import { getOutgoingEdges, writeMemoryEdges } from "../../src/db/memory-edges";
import {
  backfillAllIntraChains,
  initializeDatabase,
  initializeSchema,
} from "../../src/db/schema";
import { createSegment } from "../../src/db/segments";
import { getSession, upsertSession } from "../../src/db/sessions";
import { getShadowNote, upsertShadowNote } from "../../src/db/shadow-notes";
import { runTranscriptPathBackfill } from "../../src/db/transcript-path-backfill";
import { getTurn, getTurnById } from "../../src/db/turns";
import * as searchModule from "../../src/db/search";
import {
  resolveSessionTranscriptPath,
  resolveTranscriptPath,
} from "../../src/shared/paths";
import { buildTimelineView, renderTimeline } from "../../src/mcp/timeline";

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
    expect(tableNames).toContain("session_run_state");
    expect(tableNames).toContain("observations");
    expect(tableNames).toContain("shadow_notes");
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
      "terminal",
      "retry_disposition",
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
      "transcript_path",
      "title",
      "content",
      "insight",
      "next_steps",
      "decision",
      "done",
      "current",
      "reference",
      "last_compact_turn",
      "summary_updated_at_epoch",
      "scan_cursor_byte_offset",
      "scan_cursor_line",
      "last_remember_turn_id",
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

  test("creates a nullable, range-constrained significance grade on turns", () => {
    initializeSchema(db);

    const columns = db
      .query<{ name: string }, []>("PRAGMA table_info(turns)")
      .all()
      .map((row) => row.name);
    expect(columns).toContain("significance_grade");

    const sessionId = db
      .query<{ id: number }, []>(
        "INSERT INTO sessions (content_session_id, project, created_at_epoch) VALUES ('grade-schema', 'claude-mnemo', 1) RETURNING id",
      )
      .get()!.id;
    expect(() =>
      db.query(
        "INSERT INTO turns (session_id, prompt_number, significance_grade, created_at_epoch) VALUES (?, 1, NULL, 2)",
      ).run(sessionId),
    ).not.toThrow();
    expect(() =>
      db.query(
        "INSERT INTO turns (session_id, prompt_number, significance_grade, created_at_epoch) VALUES (?, 2, 5, 3)",
      ).run(sessionId),
    ).toThrow();
  });

  test("adds significance_grade to an existing turns table without backfilling old rows", () => {
    // `content_prompt_id`/`user_prompt`/`title`/`content`/`insight`/`type`/
    // `tags`/`files_read`/`files_modified`/`tool_call_count` are day-one
    // columns with no ALTER migration anywhere in this file (unlike
    // `significance_grade`, which this test exercises) — no real database
    // has ever existed without them, so they are included here even though
    // this fixture predates every OTHER later column. Ticket 02's
    // `ensureTurnTypeMultiValueColumn` runs unconditionally as part of
    // `initializeSchema` and rebuilds `turns` from an explicit column list;
    // omitting a day-one column here would fail that rebuild for a schema
    // shape no real installation has.
    db.exec(`
      CREATE TABLE sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_session_id TEXT UNIQUE NOT NULL,
        project TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL
      );
      CREATE TABLE turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL,
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
        updated_at_epoch INTEGER
      );
      INSERT INTO sessions (content_session_id, project, created_at_epoch)
      VALUES ('grade-migration', 'claude-mnemo', 1);
      INSERT INTO turns (session_id, prompt_number, status, created_at_epoch)
      VALUES (1, 1, 'extracted', 2);
    `);

    initializeSchema(db);

    const row = db
      .query<{ grade: number | null }, []>(
        "SELECT significance_grade AS grade FROM turns WHERE id = 1",
      )
      .get();
    expect(row?.grade).toBeNull();
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
      "excluded_from_extraction",
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
      "excluded_from_extraction",
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
      "transcript_path",
      "title",
      "content",
      "insight",
      "next_steps",
      "decision",
      "done",
      "current",
      "reference",
      "last_compact_turn",
      "summary_updated_at_epoch",
      "scan_cursor_byte_offset",
      "scan_cursor_line",
      "last_remember_turn_id",
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
      "excluded_from_extraction",
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

  test("rebuilds the search index when segments are missing from FTS", () => {
    // Segments are indexed row-by-row at write time, so a commit that lands
    // while the index write fails leaves a segment nothing can find. Drift
    // detection is the only thing that ever notices, and it has to know the
    // layer exists.
    initializeSchema(db);
    const segment = createSegment(db, {
      title: "implement the segment spine",
      type: ["implement"],
      nowEpoch: 10,
    });
    db.query("DELETE FROM memory_fts WHERE layer = 'segment'").run();

    const rebuildSpy = spyOn(searchModule, "rebuildSearchIndex");

    initializeDatabase(db);

    expect(rebuildSpy).toHaveBeenCalledTimes(1);
    expect(
      db
        .query<{ count: number }, [number]>(
          "SELECT COUNT(*) AS count FROM memory_fts WHERE layer = 'segment' AND source_id = ?",
        )
        .get(segment.id).count,
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

  test("creates the universal edge table with its cited-id index, and never creates the retired turn_citations table (spec C13)", () => {
    initializeSchema(db);

    const tableNames = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table'",
      )
      .all()
      .map((row) => row.name);
    expect(tableNames).toContain("memory_edges");
    expect(tableNames).not.toContain("turn_citations");

    const indexNames = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'memory_edges'",
      )
      .all()
      .map((row) => row.name);
    expect(indexNames).toContain("idx_memory_edges_cited");

    const columns = db
      .query<{ name: string }, []>("PRAGMA table_info(turns)")
      .all()
      .map((row) => row.name);
    // Ticket 10c: `cites_recorded` is retired — a fresh database built from
    // the current DDL never had it.
    expect(columns).not.toContain("cites_recorded");
  });

  test("reopening a pre-ticket-05 database retires turn_citations and its rows land in memory_edges (spec C13)", () => {
    // A REAL pre-ticket-05 database: turn_citations still exists under its
    // old four-value CHECK (the shape SCHEMA_SQL no longer creates), written
    // to a file, closed, then reopened through the production open path.
    const directory = mkdtempSync(join(tmpdir(), "mnemo-turn-citations-retire-"));
    const path = join(directory, "memory.db");

    try {
      const before = createDatabase(path);
      initializeSchema(before);
      before.exec(`
        CREATE TABLE turn_citations (
          citing_turn_id INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
          cited_turn_id INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
          relation TEXT NOT NULL CHECK (
            relation IN ('builds-on', 'implements', 'supersedes', 'evidence-for')
          ),
          created_at_epoch INTEGER NOT NULL,
          PRIMARY KEY (citing_turn_id, cited_turn_id, relation)
        );
      `);
      const sessionId = upsertSession(before, {
        contentSessionId: "cites-migration",
        project: "claude-mnemo",
        title: "legacy session",
        insight: null,
        createdAtEpoch: 1,
        updatedAtEpoch: 1,
        completedAtEpoch: null,
      }).id;
      const citedId = before
        .query<{ id: number }, [number]>(
          `INSERT INTO turns (session_id, prompt_number, status, title, created_at_epoch)
           VALUES (?, 1, 'extracted', 'the cited decision', 2) RETURNING id`,
        )
        .get(sessionId)!.id;
      const citerId = before
        .query<{ id: number }, [number, string]>(
          `INSERT INTO turns (session_id, prompt_number, status, title, content, created_at_epoch)
           VALUES (?, 2, 'extracted', 'legacy turn', ?, 3) RETURNING id`,
        )
        .get(sessionId, `reverses [T${citedId}]`)!.id;
      before
        .query<unknown, [number, number]>(
          `INSERT INTO turn_citations (citing_turn_id, cited_turn_id, relation, created_at_epoch)
           VALUES (?, ?, 'supersedes', 4)`,
        )
        .run(citerId, citedId);
      before.close();

      const migrated = createDatabase(path);
      try {
        initializeDatabase(migrated);
        // Idempotent: a second open must not re-migrate, re-throw, or
        // resurrect the legacy table.
        initializeDatabase(migrated);

        const tableNames = migrated
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type = 'table'",
          )
          .all()
          .map((row) => row.name);
        expect(tableNames).not.toContain("turn_citations");

        // No extraction field is rewritten by the retirement.
        const row = getTurnById(migrated, citerId);
        expect(row?.title).toBe("legacy turn");
        expect(row?.content).toBe(`reverses [T${citedId}]`);

        // The legacy row survived the retirement, relation intact — it was
        // already legal in the new four-value vocabulary.
        const edge = migrated
          .query<{ relation: string | null }, [number, number]>(
            `SELECT relation FROM memory_edges
             WHERE citing_kind = 'turn' AND citing_id = ?
               AND cited_kind = 'turn' AND cited_id = ?`,
          )
          .get(citerId, citedId);
        expect(edge?.relation).toBe("supersedes");

        // End to end after the retirement: the folded-in edge and the prose
        // name the same pair, so the union resolves to one id backed by one
        // edge. Under the retired `cites_recorded` gate this turn's flag was
        // never set, so the edge the migration had just created was invisible
        // here — the assertion used to read `edges: []`.
        expect(getEffectiveCitations(migrated, row!)).toEqual({
          citedTurnIds: [citedId],
          edges: [
            {
              citingTurnId: citerId,
              citedTurnId: citedId,
              relation: "supersedes",
              createdAtEpoch: 4,
            },
          ],
        });
      } finally {
        migrated.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("reopening a pre-transcript-path database adds the column, and the worker-hosted repair fills what it can", () => {
    // A real pre-ticket database — the current schema minus exactly what this
    // ticket adds — reopened through the production path (initializeDatabase).
    const directory = mkdtempSync(join(tmpdir(), "mnemo-transcript-path-"));
    const path = join(directory, "memory.db");
    const transcriptDir = join(
      homedir(),
      ".claude",
      "projects",
      "-Users-me-alpha",
    );
    mkdirSync(transcriptDir, { recursive: true });
    const transcript = join(transcriptDir, "drifted-uuid.jsonl");
    writeFileSync(transcript, "{}\n");

    const insertLegacySession = (
      database: Database,
      contentSessionId: string,
    ): number =>
      database
        .query<{ id: number }, [string]>(
          `INSERT INTO sessions (content_session_id, project, created_at_epoch)
           VALUES (?, '/Users/me/beta', 1) RETURNING id`,
        )
        .get(contentSessionId)!.id;

    try {
      const before = createDatabase(path);
      initializeSchema(before);
      before.exec("ALTER TABLE sessions DROP COLUMN transcript_path");
      before.exec("DROP TABLE repair_ledger");
      // Registered in alpha, `project` later overwritten with the beta cwd.
      const driftedId = insertLegacySession(before, "drifted-uuid");
      const missingId = insertLegacySession(before, "no-transcript-uuid");
      before.close();

      const migrated = createDatabase(path);
      try {
        initializeDatabase(migrated);
        // Idempotent: a second open must not re-migrate or throw.
        initializeDatabase(migrated);

        // Opening the database must NOT repair. Every hook process runs this,
        // so a filesystem scan hosted here would sit on the hook critical path
        // and race itself across processes; the worker owns the repair instead.
        expect(getSession(migrated, driftedId)?.transcriptPath).toBeNull();
        expect(
          migrated
            .query<{ count: number }, []>(
              "SELECT COUNT(*) AS count FROM repair_ledger",
            )
            .get()?.count,
        ).toBe(0);

        // Reader fallback holds while the repair has not run.
        expect(
          resolveSessionTranscriptPath(getSession(migrated, driftedId)!),
        ).toBe(resolveTranscriptPath("/Users/me/beta", "drifted-uuid"));

        // What the worker tick does, driven directly.
        runTranscriptPathBackfill(migrated);

        expect(getSession(migrated, driftedId)?.transcriptPath).toBe(transcript);
        // No file anywhere under the root → stays NULL, and the reader falls
        // back to the legacy derivation instead of throwing.
        const missing = getSession(migrated, missingId)!;
        expect(missing.transcriptPath).toBeNull();
        expect(resolveSessionTranscriptPath(missing)).toBe(
          resolveTranscriptPath("/Users/me/beta", "no-transcript-uuid"),
        );

        const ledger = migrated
          .query<{ status: string; filled_count: number; unresolved_count: number }, []>(
            "SELECT * FROM repair_ledger WHERE name = 'transcript-path-backfill-v1'",
          )
          .get()!;
        expect(ledger).toMatchObject({
          status: "done",
          filled_count: 1,
          unresolved_count: 1,
        });

        // Completed means completed: a later run does not rescan, even when a
        // row it already crossed goes back to NULL.
        migrated
          .query<unknown, [number]>(
            "UPDATE sessions SET transcript_path = NULL WHERE id = ?",
          )
          .run(driftedId);
        expect(runTranscriptPathBackfill(migrated).status).toBe("skipped");
        expect(getSession(migrated, driftedId)?.transcriptPath).toBeNull();
      } finally {
        migrated.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
      rmSync(transcriptDir, { recursive: true, force: true });
    }
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

  test("a column migration survives a second process running it at the same moment", () => {
    // Claude Code starts an event's hooks with Promise.all, so `session-init`
    // and `prompt-dispatch` open the same database at the same instant. On a
    // database that still predates a column, both read "missing" and both issue
    // the ALTER; the one SQLite serialises second gets "duplicate column name".
    // Before the guard that failure propagated out of schema initialisation,
    // and `session-init`'s non-blocking error path then dropped the turn row of
    // the prompt being submitted.
    const directory = mkdtempSync(join(tmpdir(), "claude-mnemo-migration-"));
    const databasePath = join(directory, "mnemo.db");
    const columnsOf = (database: Database, table: string): string[] =>
      database
        .query<{ name: string }, []>(
          `SELECT name FROM pragma_table_info('${table}')`,
        )
        .all()
        .map((row) => row.name);

    const fixture = createDatabase(databasePath);
    initializeSchema(fixture);
    // Back out one migration to get a pre-0.9.1 database.
    fixture.exec(
      "ALTER TABLE note_debt_cursor DROP COLUMN last_relief_prompt_number",
    );
    expect(columnsOf(fixture, "note_debt_cursor")).not.toContain(
      "last_relief_prompt_number",
    );
    fixture.close();

    const winner = createDatabase(databasePath);
    const loser = createDatabase(databasePath);
    let overtaken = false;

    try {
      // The loser has already read "column missing"; the winner's ALTER lands
      // in the gap before the loser's own runs.
      const loserExec = loser.exec.bind(loser);
      (loser as unknown as { exec: (sql: string, ...rest: unknown[]) => void }).exec =
        (sql: string, ...rest: unknown[]) => {
          if (
            !overtaken &&
            sql.includes("ADD COLUMN") &&
            sql.includes("last_relief_prompt_number")
          ) {
            overtaken = true;
            initializeSchema(winner);
          }
          (loserExec as (sql: string, ...rest: unknown[]) => void)(sql, ...rest);
        };

      expect(() => initializeSchema(loser)).not.toThrow();
      expect(overtaken).toBe(true);

      // Both connections end up on the same, correct schema — one column, with
      // the legacy reading (never relieved) as its default.
      for (const database of [winner, loser]) {
        const columns = columnsOf(database, "note_debt_cursor");
        expect(
          columns.filter((name) => name === "last_relief_prompt_number"),
        ).toEqual(["last_relief_prompt_number"]);
      }

      const session = upsertSession(loser, {
        contentSessionId: "session-migration-race",
        project: "/tmp/project",
        title: null,
        insight: null,
        createdAtEpoch: 100,
        updatedAtEpoch: null,
        completedAtEpoch: null,
      }).id;
      loser
        .query<unknown, [number]>(
          `INSERT INTO note_debt_cursor (
             session_id, last_classified_prompt_number, updated_at_epoch
           ) VALUES (?, 3, 100)`,
        )
        .run(session);
      expect(
        winner
          .query<{ lastRelief: number }, [number]>(
            `SELECT last_relief_prompt_number AS lastRelief
             FROM note_debt_cursor WHERE session_id = ?`,
          )
          .get(session)?.lastRelief,
      ).toBe(0);

      // And re-opening either of them changes nothing.
      expect(() => initializeSchema(loser)).not.toThrow();
      expect(() => initializeSchema(winner)).not.toThrow();
      expect(columnsOf(winner, "note_debt_cursor")).toEqual(
        columnsOf(loser, "note_debt_cursor"),
      );
    } finally {
      winner.close();
      loser.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("the reminded marker arrives by ALTER, reading NULL on legacy debts", () => {
    // 裁决 22 makes the ordinary reminder once-per-debt, which needs a marker on
    // `note_debt` — and CREATE TABLE IF NOT EXISTS is a no-op on a database that
    // already has the table, so every 0.9.x database would throw "no such
    // column" on the first prompt without this migration.
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const sessionId = upsertSession(db, {
      contentSessionId: "session-note-debt-marker",
      project: "/tmp/project",
      title: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;
    const turnId = db
      .query<{ id: number }, [number]>(
        `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch)
         VALUES (?, 3, 'active', 100) RETURNING id`,
      )
      .get(sessionId)!.id;
    db.exec("ALTER TABLE note_debt DROP COLUMN reminded_at_epoch");
    db.query<unknown, [number, number]>(
      `INSERT INTO note_debt (
         turn_id, session_id, prompt_number, status,
         opened_at_epoch, updated_at_epoch
       ) VALUES (?, ?, 3, 'pending', 100, 100)`,
    ).run(turnId, sessionId);

    expect(() => initializeSchema(db)).not.toThrow();

    const columns = db
      .query<{ name: string }, []>(
        "SELECT name FROM pragma_table_info('note_debt')",
      )
      .all()
      .map((row) => row.name);
    expect(columns).toContain("reminded_at_epoch");
    // Never asked is the correct legacy reading: the old channel's record of
    // what it had shown lived in `note_id_exposures`, not on the debt.
    expect(
      db
        .query<{ reminded: number | null }, [number]>(
          "SELECT reminded_at_epoch AS reminded FROM note_debt WHERE turn_id = ?",
        )
        .get(turnId)?.reminded,
    ).toBeNull();
    db.close();
  });

  test("the pre-'closed' rebuild brings the reminded marker with it", () => {
    // The two note_debt migrations run in sequence and the first REBUILDS the
    // table from the current DDL. Order matters: if the rebuild ran after the
    // ALTER it would drop the marker again, and a rebuild that copied into a
    // table without the column would fail outright.
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const sessionId = upsertSession(db, {
      contentSessionId: "session-note-debt-rebuild",
      project: "/tmp/project",
      title: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;
    const turnId = db
      .query<{ id: number }, [number]>(
        `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch)
         VALUES (?, 4, 'active', 100) RETURNING id`,
      )
      .get(sessionId)!.id;

    // Back the table out to its 0.9.0 shape: two reasons, no marker.
    db.exec("DROP TABLE note_debt");
    db.exec(`
      CREATE TABLE note_debt (
        turn_id INTEGER PRIMARY KEY REFERENCES turns(id) ON DELETE CASCADE,
        session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        prompt_number INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (
          status IN ('pending', 'noted', 'skipped')
        ),
        reason TEXT CHECK (reason IS NULL OR reason IN ('aged', 'rolled-back')),
        opened_at_epoch INTEGER NOT NULL,
        closed_at_epoch INTEGER,
        updated_at_epoch INTEGER NOT NULL
      );
    `);
    db.query<unknown, [number, number]>(
      `INSERT INTO note_debt (
         turn_id, session_id, prompt_number, status,
         opened_at_epoch, updated_at_epoch
       ) VALUES (?, ?, 4, 'pending', 100, 100)`,
    ).run(turnId, sessionId);

    initializeSchema(db);

    const columns = db
      .query<{ name: string }, []>(
        "SELECT name FROM pragma_table_info('note_debt')",
      )
      .all()
      .map((row) => row.name);
    expect(columns).toContain("reminded_at_epoch");
    expect(
      db
        .query<{ turnId: number; reminded: number | null }, []>(
          `SELECT turn_id AS turnId, reminded_at_epoch AS reminded
           FROM note_debt`,
        )
        .all(),
    ).toEqual([{ turnId, reminded: null }]);
    // The widened reason vocabulary survived the extra column.
    expect(() =>
      db
        .query<unknown, [number]>(
          "UPDATE note_debt SET status = 'skipped', reason = 'closed' WHERE turn_id = ?",
        )
        .run(turnId),
    ).not.toThrow();
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

/**
 * ticket 02 (spec B5) — widens `turns.type` from a nullable scalar to a JSON
 * array. A CHECK constraint cannot be ALTERed, so this is a table rebuild
 * (`ensureTurnTypeMultiValueColumn`); it must value-preserve every existing
 * scalar, including the legacy `compact` sentinel the mechanical PreCompact
 * marker depends on, and its render surface (⏸) must survive unchanged.
 */
describe("ensureTurnTypeMultiValueColumn (ticket 02, spec B5)", () => {
  test("wraps every legacy scalar into a one-element array, preserves gapped ids and their dependents, recreates the endpoint-deletion trigger, tightens the CHECK to array-only, and a migrated compact row still renders its ⏸ marker (peer review items 4a-4c)", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const sessionId = upsertSession(db, {
      contentSessionId: "session-type-migration",
      project: "/tmp/project",
      title: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;

    // Back `turns` out to its pre-widening shape: every OTHER migration has
    // already run against it (this is what a real installation looks like
    // the moment before this one lands), only `type` is still the old
    // nullable scalar with no CHECK.
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("DROP TABLE turns");
    db.exec(`
      CREATE TABLE turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        prompt_number INTEGER NOT NULL,
        content_prompt_id TEXT,
        was_interrupted INTEGER NOT NULL DEFAULT 0,
        was_rolled_back INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        user_prompt TEXT,
        assistant_response TEXT,
        assistant_transcript TEXT,
        title TEXT,
        content TEXT,
        insight TEXT,
        type TEXT,
        significance_grade INTEGER,
        tags TEXT,
        files_read TEXT,
        files_modified TEXT,
        tool_call_count INTEGER,
        transcript_line_start INTEGER,
        consulted_memories TEXT,
        compact_boundary_uuid TEXT,
        parent_turn_id INTEGER,
        created_at_epoch INTEGER NOT NULL,
        updated_at_epoch INTEGER,
        UNIQUE(session_id, prompt_number)
      );
    `);
    // Explicit, GAPPED ids (1, 3, 5, 7 — 2/4/6 never exist), not consecutive
    // AUTOINCREMENT ones: a copy list that dropped `id` from the rebuild's
    // INSERT/SELECT would still pass on consecutive fixture ids, because
    // AUTOINCREMENT would happen to regenerate the same numbers by
    // coincidence (peer review mutation-check item 4c).
    const insert = db.query<
      { id: number },
      [
        number,
        number,
        number,
        string | null,
        string,
        number | null,
        number,
      ]
    >(
      `INSERT INTO turns (
         id, session_id, prompt_number, status, type, title,
         parent_turn_id, created_at_epoch
       ) VALUES (?, ?, ?, 'extracted', ?, ?, ?, ?)
       RETURNING id`,
    );
    const discoveryId = insert.get(1, sessionId, 1, "discovery", "legacy discovery row", null, 100)!.id;
    const compactId = insert.get(3, sessionId, 2, "compact", "/compact", null, 200)!.id;
    const nullId = insert.get(5, sessionId, 3, null, "never typed", discoveryId, 300)!.id;
    const emptyId = insert.get(7, sessionId, 4, "", "empty string typed", null, 400)!.id;
    expect([discoveryId, compactId, nullId, emptyId]).toEqual([1, 3, 5, 7]);

    // A dependent row in ANOTHER table (peer review mutation-check item
    // 4c): a copy list that dropped `id` would remap ids and silently
    // orphan or misdirect this FK reference instead of failing loudly.
    upsertShadowNote(db, {
      turnId: discoveryId,
      title: "shadow title",
      content: "shadow content",
      nowEpoch: 100,
    });

    // A structured citation edge (peer review mutation-check item 4b): proves
    // the separate `memory_edges` table — and its endpoint-deletion trigger —
    // survive the `turns` rebuild untouched, since the edge lives in a
    // different table entirely.
    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: discoveryId },
          cited: { kind: "turn", id: compactId },
          relation: "depends-on",
          provenance: "asserted",
        },
      ],
      100,
      { eligibleForRelation: "unrestricted" },
    );
    db.exec("PRAGMA foreign_keys = ON");

    // The rebuild runs as part of the ordinary migration chain.
    initializeSchema(db);

    expect(getTurnById(db, discoveryId)!.type).toEqual(["discovery"]);
    expect(getTurnById(db, compactId)!.type).toEqual(["compact"]);
    expect(getTurnById(db, nullId)!.type).toEqual([]);
    expect(getTurnById(db, emptyId)!.type).toEqual([]);

    // Identity itself survived unchanged, not merely each row's contents.
    expect(getTurnById(db, 1)!.id).toBe(1);
    expect(getTurnById(db, 3)!.id).toBe(3);
    expect(getTurnById(db, 5)!.id).toBe(5);
    expect(getTurnById(db, 7)!.id).toBe(7);
    // The intra-`turns` reference still resolves to the RIGHT row rather
    // than to whatever an id remap happened to land on.
    expect(getTurnById(db, nullId)!.parentTurnId).toBe(discoveryId);
    // The cross-TABLE dependent row still resolves too.
    expect(getShadowNote(db, discoveryId)?.title).toBe("shadow title");

    // The edge survived the rebuild, which is what this assertion is for.
    const discoveryTurn = getTurnById(db, discoveryId)!;
    const effective = getEffectiveCitations(db, discoveryTurn);
    expect(effective.citedTurnIds).toEqual([compactId]);
    expect(effective.edges.map((edge) => edge.citedTurnId)).toEqual([compactId]);

    // The CHECK constraint is live going forward and now array-only (peer
    // review P2): a raw non-JSON scalar is rejected, as before, and so are
    // the two shapes that used to pass the RETIRED, looser `json_valid`
    // CHECK — a bare JSON string and a JSON object are both valid JSON but
    // not arrays. Only a JSON array is accepted.
    expect(() =>
      db
        .query("UPDATE turns SET type = 'not-json-array' WHERE id = ?")
        .run(discoveryId),
    ).toThrow();
    expect(() =>
      db.query(`UPDATE turns SET type = '"fix"' WHERE id = ?`).run(discoveryId),
    ).toThrow();
    expect(() =>
      db.query(`UPDATE turns SET type = '{"a":1}' WHERE id = ?`).run(discoveryId),
    ).toThrow();
    expect(() =>
      db
        .query(`UPDATE turns SET type = '["refactor"]' WHERE id = ?`)
        .run(discoveryId),
    ).not.toThrow();
    db.query(`UPDATE turns SET type = '["discovery"]' WHERE id = ?`).run(discoveryId);

    // The migrated compact row still renders its ⏸ marker — the timeline's
    // whole reason for reading `type` at all on this row.
    const view = buildTimelineView(db, { id: `S${sessionId}`, view: "turns" });
    const rendered = renderTimeline(view);
    expect(rendered).toContain("⏸ /compact");

    expect(getTurn(db, sessionId, 2)!.type).toEqual(["compact"]);

    // The endpoint-deletion trigger (spec C15) was recreated on the
    // REBUILT table rather than silently lost with the dropped one (peer
    // review mutation-check item 4a): deleting an edge's endpoint after the
    // rebuild must still prune the edge, not orphan it.
    expect(getOutgoingEdges(db, { kind: "turn", id: discoveryId })).toHaveLength(1);
    db.query("DELETE FROM turns WHERE id = ?").run(compactId);
    expect(getOutgoingEdges(db, { kind: "turn", id: discoveryId })).toEqual([]);

    db.close();
  });

  test("a database already migrated to the retired looser json_valid(type) CHECK is rebuilt again to json_type(type) = 'array', and a third initializeSchema call is a no-op (peer review item 4, staleness detects the loose form too)", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const sessionId = upsertSession(db, {
      contentSessionId: "session-type-loose-check",
      project: "/tmp/project",
      title: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;

    // Back `turns` out to the shape ticket 02 ORIGINALLY shipped — already
    // widened to a JSON array, but under the retired, looser
    // `json_valid(type)` CHECK rather than `json_type(type) = 'array'` —
    // what a real installation that already ran the ticket 02 migration
    // looks like the moment before this fix lands.
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("DROP TABLE turns");
    db.exec(`
      CREATE TABLE turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        prompt_number INTEGER NOT NULL,
        content_prompt_id TEXT,
        was_interrupted INTEGER NOT NULL DEFAULT 0,
        was_rolled_back INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        user_prompt TEXT,
        assistant_response TEXT,
        assistant_transcript TEXT,
        title TEXT,
        content TEXT,
        insight TEXT,
        type TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(type)),
        significance_grade INTEGER,
        tags TEXT,
        files_read TEXT,
        files_modified TEXT,
        tool_call_count INTEGER,
        transcript_line_start INTEGER,
        consulted_memories TEXT,
        compact_boundary_uuid TEXT,
        parent_turn_id INTEGER,
        created_at_epoch INTEGER NOT NULL,
        updated_at_epoch INTEGER,
        UNIQUE(session_id, prompt_number)
      );
    `);
    const insert = db.query<{ id: number }, [number, number, string, number]>(
      `INSERT INTO turns (session_id, prompt_number, status, type, created_at_epoch)
       VALUES (?, ?, 'extracted', ?, ?)
       RETURNING id`,
    );
    const fixId = insert.get(sessionId, 1, '["fix"]', 100)!.id;
    db.exec("PRAGMA foreign_keys = ON");

    // Rebuild #1: loose CHECK -> strict CHECK.
    initializeSchema(db);

    const ddlAfterFirstRebuild = db
      .query<{ sql: string | null }, []>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'turns'",
      )
      .get()?.sql;
    expect(ddlAfterFirstRebuild).toContain("json_type(type) = 'array'");
    // The already-array-shaped value survived un-double-wrapped.
    expect(getTurnById(db, fixId)!.type).toEqual(["fix"]);

    // The strict CHECK is live: the shapes the OLD, looser CHECK admitted
    // are rejected now.
    expect(() =>
      db.query(`UPDATE turns SET type = '"fix"' WHERE id = ?`).run(fixId),
    ).toThrow();
    expect(() =>
      db.query(`UPDATE turns SET type = '{"a":1}' WHERE id = ?`).run(fixId),
    ).toThrow();
    db.query(`UPDATE turns SET type = '["fix"]' WHERE id = ?`).run(fixId);

    // Calls #2 and #3: proven, not just assumed, to be no-ops — spying on
    // the connection catches a rebuild that silently re-ran and still
    // happened to leave the data alone, which a value-level assertion alone
    // cannot tell apart from "never ran again".
    const execSpy = spyOn(db, "exec");
    initializeSchema(db);
    initializeSchema(db);
    const rebuildExecCalls = execSpy.mock.calls.filter(
      ([sql]) => typeof sql === "string" && sql.includes("DROP TABLE turns"),
    );
    expect(rebuildExecCalls).toHaveLength(0);
    execSpy.mockRestore();

    expect(getTurnById(db, fixId)!.type).toEqual(["fix"]);

    db.close();
  });
});

/**
 * Ticket 10c — `cites_recorded` is retired outright: nothing has read it since
 * ticket 06 made the citation read path an unconditional union (spec §B),
 * and it is `NOT NULL`, so the retirement is a table rebuild
 * (`retireTurnCitesRecordedColumn`), same idiom as `ensureTurnTypeMultiValueColumn`.
 */
describe("retireTurnCitesRecordedColumn (ticket 10c)", () => {
  test("drops cites_recorded from an existing populated database, preserving every other column and row, and is idempotent", () => {
    // A REAL pre-ticket-10c database: current schema (from `initializeSchema`)
    // plus the retired column bolted back on by hand, the shape a production
    // database in the wild carries today.
    const directory = mkdtempSync(join(tmpdir(), "mnemo-cites-recorded-retire-"));
    const path = join(directory, "memory.db");

    try {
      const before = createDatabase(path);
      initializeSchema(before);
      before.exec(
        "ALTER TABLE turns ADD COLUMN cites_recorded INTEGER NOT NULL DEFAULT 0",
      );

      const sessionId = upsertSession(before, {
        contentSessionId: "cites-recorded-retirement",
        project: "claude-mnemo",
        title: "legacy session",
        insight: null,
        createdAtEpoch: 1,
        updatedAtEpoch: 1,
        completedAtEpoch: null,
      }).id;

      // One row a writer flagged (`cites_recorded = 1`) and one it never
      // touched (`= 0`, the NOT NULL default) — both real states production
      // carries, and both must survive the rebuild with everything but the
      // flag intact.
      const insert = before.query<
        { id: number },
        [number, number, string, string, number]
      >(
        `INSERT INTO turns (
           session_id, prompt_number, status, title, content, type, tags,
           files_read, files_modified, significance_grade, cites_recorded,
           created_at_epoch, updated_at_epoch
         ) VALUES (?, ?, 'extracted', ?, ?, '["decision"]', '["fixture-tag"]',
           '["a.ts"]', '["b.ts"]', 3, ?, 100, 200)
         RETURNING id`,
      );
      const recordedId = insert.get(
        sessionId,
        1,
        "recorded row",
        "cites [T2]",
        1,
      )!.id;
      const legacyId = insert.get(
        sessionId,
        2,
        "legacy row",
        "cites [T1]",
        0,
      )!.id;

      before.close();

      const migrated = createDatabase(path);
      try {
        initializeDatabase(migrated);

        const columns = migrated
          .query<{ name: string }, []>("PRAGMA table_info(turns)")
          .all()
          .map((row) => row.name);
        expect(columns).not.toContain("cites_recorded");

        const rowCount = migrated
          .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM turns")
          .get()?.count;
        expect(rowCount).toBe(2);

        expect(getTurnById(migrated, recordedId)).toMatchObject({
          id: recordedId,
          sessionId,
          promptNumber: 1,
          status: "extracted",
          title: "recorded row",
          content: "cites [T2]",
          type: ["decision"],
          tags: ["fixture-tag"],
          filesRead: ["a.ts"],
          filesModified: ["b.ts"],
          significanceGrade: 3,
          createdAtEpoch: 100,
          updatedAtEpoch: 200,
        });
        expect(getTurnById(migrated, legacyId)).toMatchObject({
          id: legacyId,
          promptNumber: 2,
          title: "legacy row",
          content: "cites [T1]",
        });

        // Idempotent: a second open must not re-rebuild, throw, or touch data.
        const execSpy = spyOn(migrated, "exec");
        initializeDatabase(migrated);
        const rebuildExecCalls = execSpy.mock.calls.filter(
          ([sql]) => typeof sql === "string" && sql.includes("DROP TABLE turns"),
        );
        expect(rebuildExecCalls).toHaveLength(0);
        execSpy.mockRestore();

        expect(getTurnById(migrated, recordedId)?.title).toBe("recorded row");
      } finally {
        migrated.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("a fresh database, which never had the column, is unaffected", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);

    const columns = db
      .query<{ name: string }, []>("PRAGMA table_info(turns)")
      .all()
      .map((row) => row.name);
    expect(columns).not.toContain("cites_recorded");

    db.close();
  });

  // Found running THIS migration against a copy of the real production
  // database (ticket 10c's testing discipline): production's `turns` still
  // carries four `extraction_stall_*` columns from a fully-removed feature
  // (zero references anywhere in `src/`), and this rebuild's column list —
  // written against what `schema.ts` currently declares — does not mention
  // them. An explicit `INSERT ... SELECT` column list only copies what it
  // names, so without this fix the columns (and their data) would vanish the
  // moment this rebuild fired for real, on the next reload. Retiring them is
  // a decision for their own ticket (`.scratch/extraction-redesign/`
  // already names them for one), not a side effect of retiring an unrelated
  // column.
  test("carries retired-but-still-present extraction_stall_* columns through untouched", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const sessionId = upsertSession(db, {
      contentSessionId: "session-stall-columns",
      project: "/tmp/project",
      title: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;

    // Back `turns` out to a shape carrying BOTH the retired column this
    // ticket drops AND a column family this ticket has never heard of —
    // exactly what the real production database looks like today.
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec(
      "ALTER TABLE turns ADD COLUMN cites_recorded INTEGER NOT NULL DEFAULT 0",
    );
    db.exec(
      "ALTER TABLE turns ADD COLUMN extraction_stall_attempts INTEGER NOT NULL DEFAULT 0",
    );
    db.exec(
      "ALTER TABLE turns ADD COLUMN extraction_stall_retry_at_ms INTEGER",
    );
    db.exec(
      "ALTER TABLE turns ADD COLUMN extraction_stall_retry_after_seq INTEGER",
    );
    db.exec("ALTER TABLE turns ADD COLUMN extraction_stall_retry_mode TEXT");
    db.exec("PRAGMA foreign_keys = ON");

    const turnId = db
      .query<{ id: number }, [number]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, title, cites_recorded,
           extraction_stall_attempts, extraction_stall_retry_at_ms,
           extraction_stall_retry_after_seq, extraction_stall_retry_mode,
           created_at_epoch
         ) VALUES (?, 1, 'extracted', 'stall fixture', 1, 3, 5000, 42, 'resume', 100)
         RETURNING id`,
      )
      .get(sessionId)!.id;

    initializeSchema(db);

    const columns = db
      .query<{ name: string }, []>("PRAGMA table_info(turns)")
      .all()
      .map((row) => row.name);
    expect(columns).not.toContain("cites_recorded");
    expect(columns).toContain("extraction_stall_attempts");
    expect(columns).toContain("extraction_stall_retry_at_ms");
    expect(columns).toContain("extraction_stall_retry_after_seq");
    expect(columns).toContain("extraction_stall_retry_mode");

    const row = db
      .query<
        {
          attempts: number;
          retryAtMs: number | null;
          retryAfterSeq: number | null;
          retryMode: string | null;
        },
        [number]
      >(
        `SELECT extraction_stall_attempts AS attempts,
                extraction_stall_retry_at_ms AS retryAtMs,
                extraction_stall_retry_after_seq AS retryAfterSeq,
                extraction_stall_retry_mode AS retryMode
         FROM turns WHERE id = ?`,
      )
      .get(turnId);
    expect(row).toEqual({
      attempts: 3,
      retryAtMs: 5000,
      retryAfterSeq: 42,
      retryMode: "resume",
    });

    db.close();
  });

  // The safety net for the class of bug the test above fixes: a column this
  // codebase has never heard of, on a database whose `type` is ALSO stale —
  // so `ensureTurnTypeMultiValueColumn` fires — must fail loudly rather than
  // silently vanish.
  test("ensureTurnTypeMultiValueColumn refuses to silently drop a column it does not recognise", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    upsertSession(db, {
      contentSessionId: "session-unknown-column-guard",
      project: "/tmp/project",
      title: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("DROP TABLE turns");
    db.exec(`
      CREATE TABLE turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        prompt_number INTEGER NOT NULL,
        content_prompt_id TEXT,
        was_interrupted INTEGER NOT NULL DEFAULT 0,
        was_rolled_back INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        user_prompt TEXT,
        assistant_response TEXT,
        assistant_transcript TEXT,
        title TEXT,
        content TEXT,
        insight TEXT,
        type TEXT,
        significance_grade INTEGER,
        tags TEXT,
        files_read TEXT,
        files_modified TEXT,
        tool_call_count INTEGER,
        transcript_line_start INTEGER,
        consulted_memories TEXT,
        compact_boundary_uuid TEXT,
        parent_turn_id INTEGER,
        a_column_nobody_told_this_rebuild_about TEXT,
        created_at_epoch INTEGER NOT NULL,
        updated_at_epoch INTEGER,
        UNIQUE(session_id, prompt_number)
      );
    `);
    db.exec("PRAGMA foreign_keys = ON");

    expect(() => initializeSchema(db)).toThrow(
      /a_column_nobody_told_this_rebuild_about/,
    );

    db.close();
  });

  // Ticket 15 finding 7: the guard's own blind spot. `PRAGMA table_info` OMITS
  // generated columns entirely, so a database carrying one would slip past the
  // guard and be dropped by the rebuild exactly like the `extraction_stall_*`
  // family nearly was; `table_xinfo` is the pragma that reports them.
  test("the unknown-column guard sees a GENERATED column, which table_info hides", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    upsertSession(db, {
      contentSessionId: "session-generated-column-guard",
      project: "/tmp/project",
      title: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("DROP TABLE turns");
    db.exec(`
      CREATE TABLE turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        prompt_number INTEGER NOT NULL,
        content_prompt_id TEXT,
        was_interrupted INTEGER NOT NULL DEFAULT 0,
        was_rolled_back INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        user_prompt TEXT,
        assistant_response TEXT,
        assistant_transcript TEXT,
        title TEXT,
        content TEXT,
        insight TEXT,
        type TEXT,
        significance_grade INTEGER,
        tags TEXT,
        files_read TEXT,
        files_modified TEXT,
        tool_call_count INTEGER,
        transcript_line_start INTEGER,
        consulted_memories TEXT,
        compact_boundary_uuid TEXT,
        parent_turn_id INTEGER,
        a_generated_column_nobody_told_this_rebuild_about TEXT
          GENERATED ALWAYS AS (title || '!') VIRTUAL,
        created_at_epoch INTEGER NOT NULL,
        updated_at_epoch INTEGER,
        UNIQUE(session_id, prompt_number)
      );
    `);
    db.exec("PRAGMA foreign_keys = ON");

    // The premise, asserted rather than assumed: the pragma the guard used to
    // read cannot see this column at all.
    expect(
      db
        .query<{ name: string }, []>("PRAGMA table_info(turns)")
        .all()
        .map((row) => row.name),
    ).not.toContain("a_generated_column_nobody_told_this_rebuild_about");

    expect(() => initializeSchema(db)).toThrow(
      /a_generated_column_nobody_told_this_rebuild_about/,
    );

    db.close();
  });

  /**
   * Ticket 15 finding 4: SQLite's 12-step ALTER TABLE procedure runs
   * `foreign_key_check` at step 10 and COMMITs at step 11. Both rebuilds ran it
   * after their transaction closed, which inverts those two: the violation
   * threw over a swap that was already durable, and because the swap made the
   * staleness predicate read false, the next reload skipped the rebuild — the
   * failure announced itself once and then had no repair path at all.
   */
  test("a foreign key violation rolls the turns rebuild back and leaves the migration pending", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const sessionId = upsertSession(db, {
      contentSessionId: "session-fk-rollback",
      project: "/tmp/project",
      title: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;

    // A child row pointing at a turn that does not exist. Only storable with
    // enforcement off, which is exactly the state a rebuild runs in.
    db.exec("PRAGMA foreign_keys = OFF");
    db.query(
      `INSERT INTO note_debt (turn_id, session_id, prompt_number, opened_at_epoch, updated_at_epoch)
       VALUES (999999, ?, 1, 100, 100)`,
    ).run(sessionId);
    // Back `turns` out to the pre-ticket-02 scalar `type`, so the rebuild fires.
    db.exec("ALTER TABLE turns RENAME TO turns_stale_source");
    db.exec(`
      CREATE TABLE turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        prompt_number INTEGER NOT NULL,
        content_prompt_id TEXT,
        was_interrupted INTEGER NOT NULL DEFAULT 0,
        was_rolled_back INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        user_prompt TEXT,
        assistant_response TEXT,
        assistant_transcript TEXT,
        title TEXT,
        content TEXT,
        insight TEXT,
        type TEXT,
        significance_grade INTEGER,
        tags TEXT,
        files_read TEXT,
        files_modified TEXT,
        tool_call_count INTEGER,
        transcript_line_start INTEGER,
        consulted_memories TEXT,
        compact_boundary_uuid TEXT,
        parent_turn_id INTEGER,
        created_at_epoch INTEGER NOT NULL,
        updated_at_epoch INTEGER,
        UNIQUE(session_id, prompt_number)
      );
    `);
    db.exec("DROP TABLE turns_stale_source");
    db.query(
      `INSERT INTO turns (session_id, prompt_number, status, type, created_at_epoch)
       VALUES (?, 1, 'extracted', 'discovery', 100)`,
    ).run(sessionId);
    db.exec("PRAGMA foreign_keys = ON");

    expect(() => initializeSchema(db)).toThrow(/foreign key violation/);

    // The swap did NOT survive the throw: the stored DDL is still the stale
    // one, so the staleness predicate still reads true and the next reload
    // retries instead of skipping a table it never finished migrating.
    const storedDdl = db
      .query<{ sql: string | null }, []>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'turns'",
      )
      .get()?.sql;
    expect(storedDdl).not.toContain("CHECK (json_type(type) = 'array')");
    expect(
      db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM turns").get()
        .count,
    ).toBe(1);
    // And no half-built table left standing under the rebuild's temporary name.
    expect(
      db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'turns_pre_%'",
        )
        .all(),
    ).toEqual([]);
    // Enforcement is restored even on the failing path (the `finally`).
    expect(
      db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()
        ?.foreign_keys,
    ).toBe(1);

    db.close();
  });
});

/**
 * ticket 02 (spec B6) — the `topic:` namespace is retired, so the prefix is
 * stripped off stored tags once rather than translated on every read. The
 * three machinery namespaces that remain (`compact:`, `invalidated:`,
 * `delivery:`) are untouched: after this runs, a bare tag is what the turn was
 * about and a prefixed one is bookkeeping.
 */
describe("stripRetiredTopicTagNamespace (ticket 02, spec B6)", () => {
  function seed(db: ReturnType<typeof createDatabase>, tags: string[][]) {
    const sessionId = upsertSession(db, {
      contentSessionId: "session-topic-strip",
      project: "/tmp/project",
      title: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;
    const insert = db.query<{ id: number }, [number, number, string, number]>(
      `INSERT INTO turns (session_id, prompt_number, status, tags, created_at_epoch)
       VALUES (?, ?, 'extracted', ?, ?)
       RETURNING id`,
    );
    return tags.map(
      (value, index) =>
        insert.get(sessionId, index + 1, JSON.stringify(value), 100 + index)!.id,
    );
  }

  function tagsOf(db: ReturnType<typeof createDatabase>, id: number): string[] {
    return JSON.parse(
      db
        .query<{ tags: string }, [number]>("SELECT tags FROM turns WHERE id = ?")
        .get(id)!.tags,
    );
  }

  test("strips the prefix, keeps machinery namespaces, and de-duplicates a turn that carried both spellings", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const [plain, machinery, collided, bareOnly] = seed(db, [
      ["topic:svg-filter", "topic:tokenomics"],
      ["topic:vram", "compact:auto", "invalidated:stale", "delivery:dropped"],
      // The one shape that makes stripping lossy if done naively: both
      // spellings of one word already present on the same turn.
      ["topic:cache-hit", "cache-hit", "topic:vram"],
      ["already-bare"],
    ]);

    initializeSchema(db);

    expect(tagsOf(db, plain!)).toEqual(["svg-filter", "tokenomics"]);
    // Only `topic:` goes. The machinery namespaces are the reason a prefix
    // still means something after this.
    expect(tagsOf(db, machinery!)).toEqual([
      "vram",
      "compact:auto",
      "invalidated:stale",
      "delivery:dropped",
    ]);
    // First-occurrence order survives and the duplicate collapses to one.
    expect(tagsOf(db, collided!)).toEqual(["cache-hit", "vram"]);
    expect(tagsOf(db, bareOnly!)).toEqual(["already-bare"]);

    db.close();
  });

  test("is idempotent — a second pass finds nothing prefixed left to strip", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const [only] = seed(db, [["topic:svg-filter", "compact:auto"]]);

    initializeSchema(db);
    const afterFirst = tagsOf(db, only!);
    initializeSchema(db);

    expect(tagsOf(db, only!)).toEqual(afterFirst);
    expect(afterFirst).toEqual(["svg-filter", "compact:auto"]);

    db.close();
  });

  // Peer review P1 on ticket 02: `tags` carries no `json_valid` CHECK, so a
  // malformed row is storable, and the candidate SELECT used to call
  // `json_each(turns.tags)` unguarded — SQLite throws `malformed JSON` out of
  // `.all()` itself, BEFORE the `JSON.parse` try/catch in the update loop
  // ever runs, aborting `initializeSchema` for every caller over one bad row.
  test("a malformed turns.tags row does not abort initializeSchema, and is left exactly as stored (peer review item 1)", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const sessionId = upsertSession(db, {
      contentSessionId: "session-malformed-tags",
      project: "/tmp/project",
      title: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;

    // `tags` has no CHECK constraint, so raw SQL can store non-JSON text —
    // exactly the row shape this guard exists for.
    const malformedId = db
      .query<{ id: number }, [number, number, string, number]>(
        `INSERT INTO turns (session_id, prompt_number, status, tags, created_at_epoch)
         VALUES (?, ?, 'extracted', ?, ?)
         RETURNING id`,
      )
      .get(sessionId, 1, "{not valid json", 100)!.id;
    // A well-formed sibling row, prefixed, in the SAME migration pass — the
    // malformed row must not take this one down with it.
    const wellFormedId = db
      .query<{ id: number }, [number, number, string, number]>(
        `INSERT INTO turns (session_id, prompt_number, status, tags, created_at_epoch)
         VALUES (?, ?, 'extracted', ?, ?)
         RETURNING id`,
      )
      .get(sessionId, 2, JSON.stringify(["topic:reopen"]), 200)!.id;

    // Reopening (a fresh initializeSchema call, the same shape every hook
    // process's entry point takes) must not throw.
    expect(() => initializeSchema(db)).not.toThrow();

    // The malformed row is left exactly as stored — un-strippable, since it
    // cannot be safely parsed, but not corrupted or dropped either.
    expect(
      db
        .query<{ tags: string }, [number]>(
          "SELECT tags FROM turns WHERE id = ?",
        )
        .get(malformedId)!.tags,
    ).toBe("{not valid json");
    // The well-formed sibling row in the same pass still gets stripped
    // normally — the guard excludes only the row it cannot read.
    expect(tagsOf(db, wellFormedId)).toEqual(["reopen"]);

    db.close();
  });
});
