import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  claimNextNoteSettlementJob,
  enqueueNoteSettlementWindows,
  type NoteSettlementJob,
} from "../../src/db/note-settlement";
import {
  hasNoteSettlementMembershipActivity,
  recordNoteSettlementMembershipActivity,
} from "../../src/db/note-settlement-completion";
import {
  listRecentSettlementProposals,
  recordNoteSettlementProposal,
} from "../../src/db/note-settlement-proposals";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { SETTLEMENT_ERA_CUTOFF_EPOCH } from "../support/settlement-config";

/**
 * Ticket 08 (ADR-0002): two brand-new tables — `note_settlement_membership_activity`
 * (the re-keyed completion gate's own positive fact) and
 * `note_settlement_proposals` (homeless-cluster proposals). Both are new
 * tables reached through `CREATE TABLE IF NOT EXISTS`, the same migration
 * shape `segment_attachments`/`note_settlement_segment_exclusions` used
 * (see schema.segment-working-state-migration.test.ts) — no 12-step rebuild,
 * because nothing existing is altered.
 */

const NOW = 1_800_000_000;

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

describe("note_settlement_membership_activity / note_settlement_proposals migration (ticket 08)", () => {
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

    // Idempotent: writing through both new surfaces, then re-running the
    // migration twice more, changes nothing.
    recordNoteSettlementMembershipActivity(db, job.id, NOW);
    recordNoteSettlementProposal(db, {
      jobId: job.id,
      sessionId,
      title: "a proposal surviving re-migration",
      addresses: [`S${sessionId}/T1`],
      nowEpoch: NOW,
    });

    initializeSchema(db);
    initializeSchema(db);

    expect(hasNoteSettlementMembershipActivity(db, job.id)).toBe(true);
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
    recordNoteSettlementMembershipActivity(db, job.id, NOW);
    recordNoteSettlementProposal(db, {
      jobId: job.id,
      sessionId,
      title: "cascades with its job",
      addresses: [`S${sessionId}/T1`],
      nowEpoch: NOW,
    });

    db.query<unknown, [number]>("DELETE FROM note_settlement_jobs WHERE id = ?").run(job.id);

    expect(hasNoteSettlementMembershipActivity(db, job.id)).toBe(false);
    expect(listRecentSettlementProposals(db, 3)).toHaveLength(0);
  });
});
