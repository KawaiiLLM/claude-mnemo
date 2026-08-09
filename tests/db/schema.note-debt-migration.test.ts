import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

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
    INSERT INTO note_debt SELECT * FROM note_debt_old;
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
