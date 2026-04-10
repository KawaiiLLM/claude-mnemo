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
