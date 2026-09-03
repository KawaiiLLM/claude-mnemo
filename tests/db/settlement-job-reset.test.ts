import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { resetNoteSettlementJobToStageOne } from "../../src/db/note-settlement";

/**
 * The ADDITIVE (pre-stage) shape of `note_settlement_jobs`: the table as it
 * stood before `ensureNoteSettlementStageSchema` added `stage`,
 * `transition_seq` and `stage1_metrics`. `resetNoteSettlementJobToStageOne`
 * carries a branch for exactly this shape, and the branch shipped as
 * `NULL AS stage AS stage` — a syntax error, so the compatibility arm threw on
 * every database it existed to serve (ticket 12, P2-A). Building the old table
 * by hand is the only way to execute that arm: `initializeSchema` always
 * produces the staged shape.
 */
function preStageJobsDatabase(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE note_settlement_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_db_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      claim_generation INTEGER NOT NULL DEFAULT 0,
      claimed_at_epoch INTEGER,
      created_at_epoch INTEGER NOT NULL,
      updated_at_epoch INTEGER NOT NULL
    );
  `);
  return db;
}

function insertJob(db: Database, status: string): number {
  db.query<unknown, [string]>(
    `INSERT INTO note_settlement_jobs
       (session_db_id, status, claim_generation, claimed_at_epoch, created_at_epoch, updated_at_epoch)
     VALUES (1, ?, 3, 500, 100, 100)`,
  ).run(status);
  return db.query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get()!.id;
}

describe("resetNoteSettlementJobToStageOne on the additive (no-stage) shape", () => {
  test("a claimed job is reset to pending with the generation bumped and the claim released", () => {
    const db = preStageJobsDatabase();
    const jobId = insertJob(db, "claimed");

    const reset = resetNoteSettlementJobToStageOne(db, jobId, 900);

    expect(reset).toEqual({
      jobId,
      previousStatus: "claimed",
      // No `stage` column means no stage was ever recorded; the reset still
      // reports the stage it puts the job back to.
      previousStage: "topics",
      claimGeneration: 4,
    });
    const row = db
      .query<{ status: string; claimGeneration: number; claimedAtEpoch: number | null }, []>(
        `SELECT status, claim_generation AS claimGeneration, claimed_at_epoch AS claimedAtEpoch
           FROM note_settlement_jobs WHERE id = ${jobId}`,
      )
      .get()!;
    expect(row).toEqual({ status: "pending", claimGeneration: 4, claimedAtEpoch: null });
    db.close();
  });

  test("a terminal job is refused, and nothing on the row moves", () => {
    const db = preStageJobsDatabase();
    const jobId = insertJob(db, "done");

    expect(resetNoteSettlementJobToStageOne(db, jobId, 900)).toBeNull();
    expect(
      db
        .query<{ status: string; claimGeneration: number }, []>(
          `SELECT status, claim_generation AS claimGeneration
             FROM note_settlement_jobs WHERE id = ${jobId}`,
        )
        .get(),
    ).toEqual({ status: "done", claimGeneration: 3 });
    db.close();
  });
});
