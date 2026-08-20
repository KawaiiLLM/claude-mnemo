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

  test("ticket 06 — widens status to accept 'abandoned', adds failure_class, and migrates existing 'failed' rows as deterministic", () => {
    const sessionDbId = upsertSession(db, {
      contentSessionId: "pre-retry-schema-note-settlement",
      project: "/tmp/project-note-settlement-migration",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;

    // This database already carries the CURRENT (post-ticket-06) DDL from
    // `initializeSchema` in `beforeEach` — downgrade it to what a
    // pre-ticket-06 install would have (has 'backfill', no 'abandoned', no
    // failure_class), the same rename-and-rebuild shape the OTHER downgrade
    // fixtures in this file use.
    db.exec("PRAGMA foreign_keys = OFF;");
    db.exec(`
      CREATE TABLE note_settlement_jobs_downgrade (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        window_start INTEGER NOT NULL,
        window_end INTEGER NOT NULL,
        trigger_type TEXT NOT NULL CHECK (
          trigger_type IN ('consecutive', 'compact', 'residual', 'sessionend', 'backfill')
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

    const pendingJobId = seedJob(db, sessionDbId, 1, 50, "consecutive");
    // A legacy `failed` row, as the OLD claim-increments-attempts + uniform-
    // backoff + cap-3 machinery would have left one (attempts=1 of the old
    // cap 3 — still short of it, a live retry candidate under either regime).
    const failedJobId = seedJob(db, sessionDbId, 51, 100, "consecutive");
    db.query<unknown, [number]>(
      `UPDATE note_settlement_jobs SET status = 'failed', attempts = 1,
         last_error = 'legacy boom', retry_at_epoch = 20 WHERE id = ?`,
    ).run(failedJobId);

    expect(() =>
      db.exec(
        `UPDATE note_settlement_jobs SET status = 'abandoned' WHERE id = ${failedJobId}`,
      ),
    ).toThrow();

    initializeSchema(db);

    // The widened CHECK now accepts 'abandoned'.
    expect(() =>
      db.exec(`UPDATE note_settlement_jobs SET status = 'abandoned' WHERE id = ${pendingJobId}`),
    ).not.toThrow();

    // The pre-existing 'failed' row survived VERBATIM (status/attempts/
    // retry_at_epoch untouched — this migration tags CLASS, it does not
    // force-terminalise a legacy row) except for the new failure_class
    // backfill.
    const migrated = db
      .query<
        { status: string; attempts: number; failureClass: string | null; retryAtEpoch: number },
        [number]
      >(
        `SELECT status, attempts, failure_class AS failureClass, retry_at_epoch AS retryAtEpoch
         FROM note_settlement_jobs WHERE id = ?`,
      )
      .get(failedJobId);
    expect(migrated).toEqual({
      status: "failed",
      attempts: 1,
      failureClass: "deterministic",
      retryAtEpoch: 20,
    });

    // A row that never failed gets no failure_class at all.
    const untouched = db
      .query<{ failureClass: string | null }, [number]>(
        `SELECT failure_class AS failureClass FROM note_settlement_jobs WHERE id = ?`,
      )
      .get(pendingJobId);
    expect(untouched!.failureClass).toBeNull();

    // The index and the dependent FK both survived the rebuild.
    expect(
      db
        .query<{ name: string }, []>(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_note_settlement_jobs_claim'`,
        )
        .get() ?? null,
    ).not.toBeNull();

    // Idempotent — running it again changes nothing further.
    const ddlAfterFirst = db
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
    ).toBe(ddlAfterFirst);
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

/**
 * The one-time settlement transition watermark (edge-mechanism-revision spec
 * D8, ticket 05, [S15069/T1124]). `note_settlement_watermark_state`'s
 * `CREATE TABLE IF NOT EXISTS` ships inside `SCHEMA_SQL` itself, so the TABLE
 * exists from a fixture's very first `initializeSchema` call (`beforeEach`
 * below) same as every other test file in this suite — what varies, and what
 * these tests simulate by deleting the row, is whether the single ROW this
 * migration writes has landed yet. That is the same distinction the OTHER
 * describe block in this file draws by rewriting `note_settlement_jobs`'s
 * shape: there, the pre-migration state is a different table shape; here, it
 * is simply an empty table.
 */
describe("note settlement transition watermark migration (ticket 05, D8)", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  function seedTurn(
    db: Database,
    sessionDbId: number,
    promptNumber: number,
    createdAtEpoch = 10,
  ): number {
    return db
      .query<{ id: number }, [number, number, number]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, user_prompt,
           assistant_response, created_at_epoch
         ) VALUES (?, ?, 'active', 'prompt', 'reply', ?)
         RETURNING id`,
      )
      .get(sessionDbId, promptNumber, createdAtEpoch)!.id;
  }

  function watermarkRow(): { watermarkTurnId: number; recordedAtEpoch: number } | null {
    return (
      db
        .query<{ watermarkTurnId: number; recordedAtEpoch: number }, []>(
          `SELECT watermark_turn_id AS watermarkTurnId, recorded_at_epoch AS recordedAtEpoch
           FROM note_settlement_watermark_state WHERE id = 1`,
        )
        .get() ?? null
    );
  }

  function jobRow(
    id: number,
  ): {
    status: string;
    claimedAtEpoch: number | null;
    failureClass: string | null;
    lastError: string | null;
  } | null {
    return (
      db
        .query<
          {
            status: string;
            claimedAtEpoch: number | null;
            failureClass: string | null;
            lastError: string | null;
          },
          [number]
        >(
          `SELECT status, claimed_at_epoch AS claimedAtEpoch,
                  failure_class AS failureClass, last_error AS lastError
           FROM note_settlement_jobs WHERE id = ?`,
        )
        .get(id) ?? null
    );
  }

  test("the beforeEach install (no turns yet) stamps the watermark at 0", () => {
    // Every other test file's `beforeEach` calls `initializeSchema` before it
    // ever seeds a turn — this is the shape that makes the whole watermark
    // design safe against the rest of the suite: a fresh test database always
    // reads as "nothing existed yet", so every turn a fixture seeds afterward
    // is unconditionally post-watermark.
    expect(watermarkRow()).toEqual({ watermarkTurnId: 0, recordedAtEpoch: expect.any(Number) });
  });

  test("stamps the watermark at the current MAX(turns.id) the first time the row is missing, and never restamps it", () => {
    const sessionDbId = upsertSession(db, {
      contentSessionId: "watermark-migration",
      project: "/tmp/project-note-settlement-watermark",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;

    seedTurn(db, sessionDbId, 1);
    seedTurn(db, sessionDbId, 2);
    const lastPreMigrationTurnId = seedTurn(db, sessionDbId, 3);

    // Simulate an install that has never run this migration: the row is
    // absent (the table itself already exists — every `initializeSchema`
    // call, this one's own `beforeEach` included, creates it unconditionally
    // via `CREATE TABLE IF NOT EXISTS` — only the row is what a pre-ticket-05
    // database lacks).
    db.exec("DELETE FROM note_settlement_watermark_state");

    initializeSchema(db);

    expect(watermarkRow()?.watermarkTurnId).toBe(lastPreMigrationTurnId);

    // More turns land, and the process restarts (initializeSchema reruns, as
    // it does on every boot) — the watermark must not move.
    seedTurn(db, sessionDbId, 4);
    seedTurn(db, sessionDbId, 5);
    const stampedAfterFirstRun = watermarkRow();

    initializeSchema(db);
    initializeSchema(db);

    expect(watermarkRow()).toEqual(stampedAfterFirstRun);
  });

  test("a job enqueued AFTER the watermark is stamped is never swept by a later initializeSchema call", () => {
    const sessionDbId = upsertSession(db, {
      contentSessionId: "watermark-no-sweep",
      project: "/tmp/project-note-settlement-watermark",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;

    // The watermark is already stamped (at 0, from this describe's own
    // beforeEach) — this is the ordinary post-migration steady state, not a
    // simulated upgrade.
    const freshJobId = seedJob(db, sessionDbId, 1, 50, "consecutive");

    // Every later process boot re-runs initializeSchema. None of them may
    // touch a job that was enqueued in the ordinary course of business after
    // the migration already ran — the disposal pass is gated to the SAME
    // one-shot moment as the watermark stamp itself.
    initializeSchema(db);
    initializeSchema(db);

    expect(jobRow(freshJobId)?.status).toBe("pending");
  });

  test("disposes queued-but-unrun automatic jobs into 'abandoned' at the same moment it stamps the watermark, and leaves backfill/resolved jobs untouched", () => {
    const sessionDbId = upsertSession(db, {
      contentSessionId: "watermark-disposal",
      project: "/tmp/project-note-settlement-watermark",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;

    const pendingConsecutive = seedJob(db, sessionDbId, 1, 50, "consecutive");
    const claimedResidual = seedJob(db, sessionDbId, 51, 80, "residual");
    db.exec(
      `UPDATE note_settlement_jobs SET status = 'claimed', claimed_at_epoch = 20
       WHERE id = ${claimedResidual}`,
    );
    const retriableFailed = seedJob(db, sessionDbId, 81, 130, "consecutive");
    db.exec(
      `UPDATE note_settlement_jobs SET status = 'failed', attempts = 1,
         retry_at_epoch = 999999999 WHERE id = ${retriableFailed}`,
    );
    const doneConsecutive = seedJob(db, sessionDbId, 131, 180, "consecutive");
    db.exec(`UPDATE note_settlement_jobs SET status = 'done' WHERE id = ${doneConsecutive}`);
    const alreadyAbandoned = seedJob(db, sessionDbId, 181, 230, "residual");
    db.exec(
      `UPDATE note_settlement_jobs SET status = 'abandoned', failure_class = 'deterministic'
       WHERE id = ${alreadyAbandoned}`,
    );
    const pendingBackfill = seedJob(db, sessionDbId, 500, 520, "backfill");

    // Force this to read as the first-ever run of the migration (same
    // technique as the test above).
    db.exec("DELETE FROM note_settlement_watermark_state");

    initializeSchema(db);

    for (const id of [pendingConsecutive, claimedResidual, retriableFailed]) {
      const row = jobRow(id)!;
      expect(row.status).toBe("abandoned");
      expect(row.claimedAtEpoch).toBeNull();
      expect(row.failureClass).toBe("deterministic");
      expect(row.lastError).toContain("watermark");
    }

    // Already-resolved jobs are untouched.
    expect(jobRow(doneConsecutive)?.status).toBe("done");
    const abandonedRow = jobRow(alreadyAbandoned)!;
    expect(abandonedRow.status).toBe("abandoned");
    expect(abandonedRow.lastError).toBeNull();

    // Backfill is exempt by trigger type — it is the operator's own explicit
    // request, not queued automatic work.
    expect(jobRow(pendingBackfill)?.status).toBe("pending");

    // The watermark itself landed alongside the disposal.
    expect(watermarkRow()).not.toBeNull();
  });
});
