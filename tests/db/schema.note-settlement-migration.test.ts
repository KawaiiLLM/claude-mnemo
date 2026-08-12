import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";

/**
 * `note_settlement_jobs.trigger_type` shipped (arc-spine-redesign, 0.8.4) with
 * a three-value CHECK. Spec note-prompt-clock D7 (ticket 05) adds a fourth,
 * `sessionend` — a CHECK constraint cannot be ALTERed, and
 * `CREATE TABLE IF NOT EXISTS` is a no-op on a database that already has the
 * table, so widening it is a REBUILD, same idiom as note_debt's reason
 * vocabulary migration.
 */
function downgradeToPreSessionEndVocabulary(db: Database): void {
  db.exec(`
    ALTER TABLE note_settlement_jobs RENAME TO note_settlement_jobs_old;
    CREATE TABLE note_settlement_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      window_start INTEGER NOT NULL,
      window_end INTEGER NOT NULL,
      trigger_type TEXT NOT NULL CHECK (
        trigger_type IN ('consecutive', 'compact', 'residual')
      ),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'claimed', 'done', 'failed')
      ),
      attempts INTEGER NOT NULL DEFAULT 0,
      retry_at_epoch INTEGER NOT NULL DEFAULT 0,
      claimed_at_epoch INTEGER,
      claim_generation INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at_epoch INTEGER NOT NULL,
      updated_at_epoch INTEGER NOT NULL,
      UNIQUE(session_id, window_start, trigger_type)
    );
    INSERT INTO note_settlement_jobs (
      id, session_id, window_start, window_end, trigger_type, status,
      attempts, retry_at_epoch, claimed_at_epoch, claim_generation,
      last_error, created_at_epoch, updated_at_epoch
    )
    SELECT
      id, session_id, window_start, window_end, trigger_type, status,
      attempts, retry_at_epoch, claimed_at_epoch, claim_generation,
      last_error, created_at_epoch, updated_at_epoch
    FROM note_settlement_jobs_old;
    DROP TABLE note_settlement_jobs_old;
    CREATE INDEX IF NOT EXISTS idx_note_settlement_jobs_claim
      ON note_settlement_jobs(session_id, status, window_start);
  `);
}

function seedJob(
  db: Database,
  sessionDbId: number,
  windowStart: number,
  windowEnd: number,
  triggerType: string,
): number {
  return db
    .query<{ id: number }, [number, number, number, string, number, number]>(
      `INSERT INTO note_settlement_jobs (
         session_id, window_start, window_end, trigger_type,
         status, attempts, retry_at_epoch, created_at_epoch, updated_at_epoch
       ) VALUES (?, ?, ?, ?, 'pending', 0, 0, ?, ?)
       RETURNING id`,
    )
    .get(sessionDbId, windowStart, windowEnd, triggerType, 10, 10)!.id;
}

describe("note_settlement_jobs trigger vocabulary migration", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  test("widens the trigger_type CHECK in place and keeps every existing job", () => {
    const sessionDbId = upsertSession(db, {
      contentSessionId: "legacy-note-settlement",
      project: "/tmp/project-note-settlement-migration",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;

    downgradeToPreSessionEndVocabulary(db);
    const consecutiveJobId = seedJob(db, sessionDbId, 1, 50, "consecutive");

    expect(() =>
      db.exec(
        `INSERT INTO note_settlement_jobs (
           session_id, window_start, window_end, trigger_type,
           status, attempts, retry_at_epoch, created_at_epoch, updated_at_epoch
         ) VALUES (${sessionDbId}, 51, 55, 'sessionend', 'pending', 0, 0, 10, 10)`,
      ),
    ).toThrow();

    initializeSchema(db);

    // The pre-existing job survived the rebuild untouched.
    expect(
      db
        .query<{ triggerType: string; windowStart: number; windowEnd: number }, [number]>(
          "SELECT trigger_type AS triggerType, window_start AS windowStart, window_end AS windowEnd FROM note_settlement_jobs WHERE id = ?",
        )
        .get(consecutiveJobId),
    ).toEqual({ triggerType: "consecutive", windowStart: 1, windowEnd: 50 });

    // The widened CHECK now accepts `sessionend`.
    expect(() =>
      seedJob(db, sessionDbId, 51, 55, "sessionend"),
    ).not.toThrow();
    expect(
      db
        .query<{ count: number }, [number]>(
          "SELECT COUNT(*) AS count FROM note_settlement_jobs WHERE session_id = ?",
        )
        .get(sessionDbId)!.count,
    ).toBe(2);

    // The index followed the renamed table and had to come back with it.
    expect(
      db
        .query<{ name: string }, []>(
          `SELECT name FROM sqlite_master
           WHERE type = 'index' AND name = 'idx_note_settlement_jobs_claim'`,
        )
        .get() ?? null,
    ).not.toBeNull();
    // And the rebuild scaffolding is gone.
    expect(
      db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE name = 'note_settlement_jobs_pre_sessionend'",
        )
        .get() ?? null,
    ).toBeNull();
  });

  test("is idempotent — running the migration twice changes nothing further", () => {
    const sessionDbId = upsertSession(db, {
      contentSessionId: "legacy-note-settlement-idempotent",
      project: "/tmp/project-note-settlement-migration",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;
    downgradeToPreSessionEndVocabulary(db);
    seedJob(db, sessionDbId, 1, 30, "compact");

    initializeSchema(db);
    const afterFirst = db
      .query<{ sql: string }, []>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'note_settlement_jobs'",
      )
      .get()!.sql;
    const rowsAfterFirst = db
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM note_settlement_jobs",
      )
      .get()!.count;

    initializeSchema(db);
    initializeSchema(db);

    expect(
      db
        .query<{ sql: string }, []>(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'note_settlement_jobs'",
        )
        .get()!.sql,
    ).toBe(afterFirst);
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM note_settlement_jobs",
        )
        .get()!.count,
    ).toBe(rowsAfterFirst);
  });

  test("is a no-op on a database already carrying the current DDL", () => {
    const before = db
      .query<{ sql: string }, []>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'note_settlement_jobs'",
      )
      .get()!.sql;

    initializeSchema(db);

    expect(
      db
        .query<{ sql: string }, []>(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'note_settlement_jobs'",
        )
        .get()!.sql,
    ).toBe(before);
    expect(before).toContain("'sessionend'");
  });
});
