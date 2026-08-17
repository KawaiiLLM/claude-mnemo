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

/**
 * The vocabulary as ticket 05 left it — four values, no `backfill`.
 *
 * Written with SQLite's 12-step shape (build the replacement under a temporary
 * name, drop the original, rename into place) rather than the fixture above's
 * rename-the-original-away shape, because `note_settlement_segment_exclusions`
 * holds `REFERENCES note_settlement_jobs(id)`: with `PRAGMA foreign_keys = ON`
 * a rename REPOINTS that clause at the renamed table, and the fixture would then
 * be testing a database whose exclusions point at a name nothing answers to.
 */
function downgradeToPreBackfillVocabulary(db: Database): void {
  db.exec("PRAGMA foreign_keys = OFF;");
  db.exec(`
    CREATE TABLE note_settlement_jobs_downgrade (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      window_start INTEGER NOT NULL,
      window_end INTEGER NOT NULL,
      trigger_type TEXT NOT NULL CHECK (
        trigger_type IN ('consecutive', 'compact', 'residual', 'sessionend')
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
    INSERT INTO note_settlement_jobs_downgrade (
      id, session_id, window_start, window_end, trigger_type, status,
      attempts, retry_at_epoch, claimed_at_epoch, claim_generation,
      last_error, created_at_epoch, updated_at_epoch
    )
    SELECT
      id, session_id, window_start, window_end, trigger_type, status,
      attempts, retry_at_epoch, claimed_at_epoch, claim_generation,
      last_error, created_at_epoch, updated_at_epoch
    FROM note_settlement_jobs;
    DROP TABLE note_settlement_jobs;
    ALTER TABLE note_settlement_jobs_downgrade RENAME TO note_settlement_jobs;
    CREATE INDEX IF NOT EXISTS idx_note_settlement_jobs_claim
      ON note_settlement_jobs(session_id, status, window_start);
  `);
  db.exec("PRAGMA foreign_keys = ON;");
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

  /**
   * The `backfill` widening (settlement-backfill ticket). Same rebuild, one
   * value later — and the first one to run against databases that actually hold
   * `note_settlement_segment_exclusions` rows, which is why the rebuild had to
   * stop renaming the old table away: that shape repoints the exclusions' FK at
   * the renamed table and then cascade-deletes every exclusion row with the DROP.
   */
  test("widens the CHECK to accept backfill, keeping every row, index and dependent", () => {
    const sessionDbId = upsertSession(db, {
      contentSessionId: "pre-backfill-note-settlement",
      project: "/tmp/project-note-settlement-migration",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;

    downgradeToPreBackfillVocabulary(db);
    const consecutiveJobId = seedJob(db, sessionDbId, 1, 50, "consecutive");
    const sessionEndJobId = seedJob(db, sessionDbId, 51, 60, "sessionend");
    // A dependent row in the one table that REFERENCES this one.
    const turnId = db
      .query<{ id: number }, [number]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, user_prompt,
           assistant_response, created_at_epoch
         ) VALUES (?, 1, 'failed', 'prompt', 'reply', 10)
         RETURNING id`,
      )
      .get(sessionDbId)!.id;
    db.query<unknown, [number, number]>(
      `INSERT INTO note_settlement_segment_exclusions (
         job_id, turn_id, created_at_epoch
       ) VALUES (?, ?, 10)`,
    ).run(consecutiveJobId, turnId);

    expect(() =>
      seedJob(db, sessionDbId, 61, 70, "backfill"),
    ).toThrow();

    initializeSchema(db);

    // Every job row survived, verbatim.
    expect(
      db
        .query<
          { id: number; triggerType: string; windowStart: number; windowEnd: number },
          [number]
        >(
          `SELECT id, trigger_type AS triggerType, window_start AS windowStart,
                  window_end AS windowEnd
           FROM note_settlement_jobs WHERE session_id = ? ORDER BY id ASC`,
        )
        .all(sessionDbId),
    ).toEqual([
      { id: consecutiveJobId, triggerType: "consecutive", windowStart: 1, windowEnd: 50 },
      { id: sessionEndJobId, triggerType: "sessionend", windowStart: 51, windowEnd: 60 },
    ]);

    // …and so did the dependent row a cascade would have eaten.
    expect(
      db
        .query<{ jobId: number; turnId: number }, []>(
          `SELECT job_id AS jobId, turn_id AS turnId
           FROM note_settlement_segment_exclusions`,
        )
        .all(),
    ).toEqual([{ jobId: consecutiveJobId, turnId }]);
    // The FK still names the live table, so it is still enforced.
    expect(
      db
        .query<{ sql: string }, []>(
          `SELECT sql FROM sqlite_master
           WHERE type = 'table' AND name = 'note_settlement_segment_exclusions'`,
        )
        .get()!.sql,
    ).toContain("REFERENCES note_settlement_jobs(id)");

    // The widened CHECK takes `backfill` — and still refuses anything else.
    expect(() => seedJob(db, sessionDbId, 61, 70, "backfill")).not.toThrow();
    expect(() => seedJob(db, sessionDbId, 71, 80, "handwave")).toThrow();

    // The index belonged to the dropped table and had to come back with it.
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
          "SELECT name FROM sqlite_master WHERE name = 'note_settlement_jobs_trigger_rebuild'",
        )
        .get() ?? null,
    ).toBeNull();
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
