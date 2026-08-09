import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";

/**
 * A CHECK constraint is part of a table's definition: it cannot be ALTERed, and
 * `CREATE TABLE IF NOT EXISTS` is a no-op on a database that already has the
 * table. So widening `note_debt.reason` for residual settlement's `closed` is a
 * REBUILD, and without it the first residual claim on any 0.9.0 database dies on
 * a constraint failure rather than doing nothing visible.
 */
function downgradeNoteDebtToPreClosedReason(db: Database): void {
  db.exec(`
    ALTER TABLE note_debt RENAME TO note_debt_old;
    CREATE TABLE note_debt (
      turn_id INTEGER PRIMARY KEY REFERENCES turns(id) ON DELETE CASCADE,
      session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      prompt_number INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'noted', 'skipped')
      ),
      reason TEXT CHECK (
        reason IS NULL OR reason IN ('aged', 'rolled-back')
      ),
      opened_at_epoch INTEGER NOT NULL,
      closed_at_epoch INTEGER,
      updated_at_epoch INTEGER NOT NULL
    );
    INSERT INTO note_debt (
      turn_id, session_id, prompt_number, status, reason,
      opened_at_epoch, closed_at_epoch, updated_at_epoch
    )
    SELECT turn_id, session_id, prompt_number, status, reason,
           opened_at_epoch, closed_at_epoch, updated_at_epoch
    FROM note_debt_old;
    DROP TABLE note_debt_old;
    CREATE INDEX IF NOT EXISTS idx_note_debt_open
      ON note_debt(session_id, status, prompt_number);
  `);
}

function seedDebts(db: Database): void {
  const sessionDbId = upsertSession(db, {
    contentSessionId: "legacy-note-debt",
    project: "/tmp/project-note-debt-migration",
    title: null,
    content: null,
    insight: null,
    createdAtEpoch: 1,
    updatedAtEpoch: 1,
    completedAtEpoch: null,
  }).id;

  for (const promptNumber of [1, 2]) {
    const turnId = db
      .query<{ id: number }, [number, number]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, user_prompt,
           assistant_response, created_at_epoch
         ) VALUES (?, ?, 'active', 'p', 'r', 1000)
         RETURNING id`,
      )
      .get(sessionDbId, promptNumber)!.id;
    db.query<unknown, [number, number, number]>(
      `INSERT INTO note_debt (
         turn_id, session_id, prompt_number, status, reason,
         opened_at_epoch, closed_at_epoch, updated_at_epoch
       ) VALUES (
         ?, ?, ?,
         CASE WHEN ? = 1 THEN 'skipped' ELSE 'pending' END,
         CASE WHEN ? = 1 THEN 'aged' ELSE NULL END,
         10, NULL, 10
       )`,
    ).run(turnId, sessionDbId, promptNumber, promptNumber, promptNumber);
  }
}

describe("note_debt reason vocabulary migration", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  test("widens the reason CHECK in place and keeps every existing debt", () => {
    seedDebts(db);
    downgradeNoteDebtToPreClosedReason(db);

    expect(() =>
      db.exec(
        "UPDATE note_debt SET status = 'skipped', reason = 'closed' WHERE prompt_number = 2",
      ),
    ).toThrow();

    initializeSchema(db);

    expect(
      db
        .query<{ promptNumber: number; status: string; reason: string | null }, []>(
          `SELECT prompt_number AS promptNumber, status, reason
           FROM note_debt ORDER BY prompt_number ASC`,
        )
        .all(),
    ).toEqual([
      { promptNumber: 1, status: "skipped", reason: "aged" },
      { promptNumber: 2, status: "pending", reason: null },
    ]);

    db.exec(
      "UPDATE note_debt SET status = 'skipped', reason = 'closed' WHERE prompt_number = 2",
    );
    expect(
      db
        .query<{ reason: string | null }, []>(
          "SELECT reason FROM note_debt WHERE prompt_number = 2",
        )
        .get()!.reason,
    ).toBe("closed");

    // The index followed the renamed table and had to come back with it.
    expect(
      db
        .query<{ name: string }, []>(
          `SELECT name FROM sqlite_master
           WHERE type = 'index' AND name = 'idx_note_debt_open'`,
        )
        .get() ?? null,
    ).not.toBeNull();
    // And the rebuild scaffolding is gone.
    expect(
      db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE name = 'note_debt_pre_closed_reason'",
        )
        .get() ?? null,
    ).toBeNull();
  });

  test("a second process rebuilding first leaves this one nothing to do", () => {
    // The same parallel-hook shape the column migrations were hardened against
    // (`session-init` and `prompt-dispatch` open the database on the very same
    // event), except this migration is a whole-table rebuild. Deciding outside
    // the write lock means the loser renames, copies and drops a ledger the
    // winner has already rebuilt — on a real `note_debt` that copy is long
    // enough to outlive the hook's 800ms busy timeout and take schema
    // initialisation, and the caller's real work, down with it.
    const directory = mkdtempSync(join(tmpdir(), "claude-mnemo-note-debt-"));
    const databasePath = join(directory, "mnemo.db");

    const fixture = createDatabase(databasePath);
    initializeSchema(fixture);
    seedDebts(fixture);
    downgradeNoteDebtToPreClosedReason(fixture);
    fixture.close();

    const winner = createDatabase(databasePath);
    const loser = createDatabase(databasePath);
    let overtaken = false;
    let loserRebuilds = 0;

    try {
      // The loser's eligibility read returns the stale DDL, and the winner
      // commits its whole rebuild in the gap that follows.
      const loserQuery = loser.query.bind(loser);
      (loser as unknown as { query: (sql: string) => unknown }).query = (
        sql: string,
      ) => {
        const statement = loserQuery(sql) as { get: (...args: unknown[]) => unknown };
        if (
          overtaken ||
          !sql.includes("sqlite_master") ||
          !sql.includes("'note_debt'")
        ) {
          return statement;
        }
        const get = statement.get.bind(statement);
        statement.get = (...args: unknown[]) => {
          const row = get(...args);
          if (!overtaken) {
            overtaken = true;
            statement.get = get;
            initializeSchema(winner);
          }
          return row;
        };
        return statement;
      };

      const loserExec = loser.exec.bind(loser);
      (loser as unknown as { exec: (sql: string, ...rest: unknown[]) => void }).exec =
        (sql: string, ...rest: unknown[]) => {
          if (sql.includes("RENAME TO note_debt_pre_closed_reason")) {
            loserRebuilds += 1;
          }
          (loserExec as (sql: string, ...rest: unknown[]) => void)(sql, ...rest);
        };

      expect(() => initializeSchema(loser)).not.toThrow();
      expect(overtaken).toBe(true);
      // The decision belongs under the write lock: by the time the loser holds
      // it the table already carries the widened vocabulary, so it copies
      // nothing.
      expect(loserRebuilds).toBe(0);

      for (const database of [winner, loser]) {
        expect(
          database
            .query<{ sql: string }, []>(
              "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'note_debt'",
            )
            .get()!.sql,
        ).toContain("'declined'");
        // Every debt survives exactly once, and no rebuild scaffolding is left.
        expect(
          database
            .query<{ promptNumber: number; status: string }, []>(
              `SELECT prompt_number AS promptNumber, status
               FROM note_debt ORDER BY prompt_number ASC`,
            )
            .all(),
        ).toEqual([
          { promptNumber: 1, status: "skipped" },
          { promptNumber: 2, status: "pending" },
        ]);
        expect(
          database
            .query<{ name: string }, []>(
              `SELECT name FROM sqlite_master
               WHERE name IN ('note_debt_pre_closed_reason', 'idx_note_debt_open')
               ORDER BY name`,
            )
            .all()
            .map((row) => row.name),
        ).toEqual(["idx_note_debt_open"]);
      }
    } finally {
      winner.close();
      loser.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("is a no-op on a database already carrying the current DDL", () => {
    const before = db
      .query<{ sql: string }, []>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'note_debt'",
      )
      .get()!.sql;

    initializeSchema(db);

    expect(
      db
        .query<{ sql: string }, []>(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'note_debt'",
        )
        .get()!.sql,
    ).toBe(before);
  });
});
