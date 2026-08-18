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
 * `note_settlement_membership_activity` and `note_settlement_proposals`: two
 * tables reached through `CREATE TABLE IF NOT EXISTS`, the same migration
 * shape `segment_attachments` used — no 12-step rebuild, because nothing
 * existing is altered.
 *
 * TICKET 05 (ownership-and-note-cadence spec, "settlement demolition"): the
 * CODE that read/wrote `note_settlement_membership_activity`
 * (`recordNoteSettlementMembershipActivity`/`hasNoteSettlementMembershipActivity`,
 * `db/note-settlement-completion.ts`) is gone — the re-keyed completion gate
 * it served retired along with `assign` and duty 1/2. The table's DDL itself
 * is deliberately left in schema.ts (out of this ticket's authorised
 * territory: schema.ts is scoped to the turns-table `election_tier` region
 * only) — an orphaned, harmless table, exercised here directly through SQL
 * rather than through the deleted convenience functions, so this file still
 * proves the migration itself (creation, idempotency, cascade) rather than
 * asserting on code that no longer exists. `note_settlement_proposals`
 * (`propose`'s own storage) is UNCHANGED by ticket 05 and keeps its real
 * reader/writer functions.
 */

const NOW = 1_800_000_000;

function recordMembershipActivity(db: Database, jobId: number, nowEpoch: number): void {
  db.query<unknown, [number, number]>(
    `INSERT INTO note_settlement_membership_activity (job_id, recorded_at_epoch)
     VALUES (?, ?)
     ON CONFLICT (job_id) DO NOTHING`,
  ).run(jobId, nowEpoch);
}

function hasMembershipActivity(db: Database, jobId: number): boolean {
  return (
    db
      .query<{ jobId: number }, [number]>(
        "SELECT job_id AS jobId FROM note_settlement_membership_activity WHERE job_id = ?",
      )
      .get(jobId) !== null
  );
}

function downgrade(db: Database): void {
  db.exec(`
    DROP TABLE note_settlement_membership_activity;
    DROP TABLE note_settlement_proposals;
  `);
}

function tableExists(db: Database, name: string): boolean {
  return (
    db
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(name) !== null
  );
}

describe("note_settlement_membership_activity / note_settlement_proposals migration", () => {
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

  test("an existing database gains both tables; running the migration again is idempotent", () => {
    downgrade(db);
    expect(tableExists(db, "note_settlement_membership_activity")).toBe(false);
    expect(tableExists(db, "note_settlement_proposals")).toBe(false);

    initializeSchema(db);

    expect(tableExists(db, "note_settlement_membership_activity")).toBe(true);
    expect(tableExists(db, "note_settlement_proposals")).toBe(true);

    // Idempotent: writing through both surfaces, then re-running the
    // migration twice more, changes nothing.
    recordMembershipActivity(db, job.id, NOW);
    recordNoteSettlementProposal(db, {
      jobId: job.id,
      sessionId,
      title: "a proposal surviving re-migration",
      addresses: [`S${sessionId}/T1`],
      nowEpoch: NOW,
    });

    initializeSchema(db);
    initializeSchema(db);

    expect(hasMembershipActivity(db, job.id)).toBe(true);
    expect(listRecentSettlementProposals(db, 3)).toHaveLength(1);
  });

  test("a fresh database (no downgrade) already carries both tables from creation", () => {
    const fresh = createDatabase(":memory:");
    initializeSchema(fresh);
    expect(tableExists(fresh, "note_settlement_membership_activity")).toBe(true);
    expect(tableExists(fresh, "note_settlement_proposals")).toBe(true);
    fresh.close();
  });

  test("both rows cascade-delete when their job is deleted", () => {
    recordMembershipActivity(db, job.id, NOW);
    recordNoteSettlementProposal(db, {
      jobId: job.id,
      sessionId,
      title: "cascades with its job",
      addresses: [`S${sessionId}/T1`],
      nowEpoch: NOW,
    });

    db.query<unknown, [number]>("DELETE FROM note_settlement_jobs WHERE id = ?").run(job.id);

    expect(hasMembershipActivity(db, job.id)).toBe(false);
    expect(listRecentSettlementProposals(db, 3)).toHaveLength(0);
  });
});
