import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  claimNextNoteSettlementJob,
  enqueueNoteSettlementWindows,
  type NoteSettlementJob,
} from "../../src/db/note-settlement";
import {
  listRecentSettlementProposals,
  recordNoteSettlementProposal,
} from "../../src/db/note-settlement-proposals";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { SETTLEMENT_ERA_CUTOFF_EPOCH } from "../support/settlement-config";

/**
 * `note_settlement_proposals` (propose's own storage — text-only, never a
 * segment, ticket 05 keeps it as the sole exception channel) is reached
 * through `CREATE TABLE IF NOT EXISTS`, no rebuild.
 *
 * `note_settlement_membership_activity` is RETIRED outright (edge-ownership
 * ticket 05): the membership gate it served died with settlement's `assign`
 * action. Its DDL left schema.ts, and `dropRetiredMaintenanceState` drops
 * the orphan a pre-demolition installation still carries — asserted here in
 * both directions (fresh installs never get it, legacy installs lose it).
 */

const NOW = 1_800_000_000;

function tableExists(db: Database, name: string): boolean {
  return (
    db
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(name) !== null
  );
}

describe("note_settlement_proposals migration and membership-activity retirement", () => {
  let db: Database;
  let sessionId: number;
  let job: NoteSettlementJob;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "membership-activity-migration",
      project: "/tmp/project-membership-activity-migration",
      title: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 100,
      completedAtEpoch: null,
    }).id;
    db.query<{ id: number }, [number, number]>(
      `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch)
       VALUES (?, ?, 'active', 100) RETURNING id`,
    ).get(sessionId, 1);
    enqueueNoteSettlementWindows(
      db,
      [{ sessionId, windowStart: 1, windowEnd: 1, triggerType: "consecutive" }],
      NOW,
      SETTLEMENT_ERA_CUTOFF_EPOCH,
    );
    job = claimNextNoteSettlementJob(db, sessionId, NOW, NOW * 1000)!;
  });

  afterEach(() => {
    db.close();
  });

  test("an existing database gains the proposals table; running the migration again is idempotent", () => {
    db.exec("DROP TABLE note_settlement_proposals");
    expect(tableExists(db, "note_settlement_proposals")).toBe(false);

    initializeSchema(db);
    expect(tableExists(db, "note_settlement_proposals")).toBe(true);

    recordNoteSettlementProposal(db, {
      jobId: job.id,
      sessionId,
      title: "a proposal surviving re-migration",
      addresses: [`S${sessionId}/T1`],
      nowEpoch: NOW,
    });

    initializeSchema(db);
    initializeSchema(db);
    expect(listRecentSettlementProposals(db, 3)).toHaveLength(1);
  });

  test("a fresh database carries proposals but NEVER the retired membership-activity table", () => {
    const fresh = createDatabase(":memory:");
    initializeSchema(fresh);
    expect(tableExists(fresh, "note_settlement_proposals")).toBe(true);
    expect(tableExists(fresh, "note_settlement_membership_activity")).toBe(false);
    fresh.close();
  });

  test("a pre-demolition database carrying the retired membership table has it dropped", () => {
    // The exact DDL a ticket-08-era installation still holds.
    db.exec(`
      CREATE TABLE IF NOT EXISTS note_settlement_membership_activity (
        job_id INTEGER PRIMARY KEY REFERENCES note_settlement_jobs(id) ON DELETE CASCADE,
        recorded_at_epoch INTEGER NOT NULL
      );
    `);
    expect(tableExists(db, "note_settlement_membership_activity")).toBe(true);

    initializeSchema(db);
    expect(tableExists(db, "note_settlement_membership_activity")).toBe(false);
  });

  test("a proposal row cascade-deletes when its job is deleted", () => {
    recordNoteSettlementProposal(db, {
      jobId: job.id,
      sessionId,
      title: "cascades with its job",
      addresses: [`S${sessionId}/T1`],
      nowEpoch: NOW,
    });

    db.query<unknown, [number]>("DELETE FROM note_settlement_jobs WHERE id = ?").run(job.id);
    expect(listRecentSettlementProposals(db, 3)).toHaveLength(0);
  });
});
