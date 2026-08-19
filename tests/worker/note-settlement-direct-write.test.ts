import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  claimNextNoteSettlementJob,
  enqueueNoteSettlementWindows,
  getNoteSettlementCursor,
  getNoteSettlementJob,
  type NoteSettlementJob,
} from "../../src/db/note-settlement";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { getTurnById, updateTurnById } from "../../src/db/turns";
import { pairKey, writeMemoryEdges } from "../../src/db/memory-edges";
import { createSettlementDirectWriteEngine } from "../../src/worker/note-settlement-direct-write";
import type { SettlementTurnFacadeContext } from "../../src/worker/note-settlement-turn-facade";
import { SETTLEMENT_ERA_CUTOFF_EPOCH } from "../support/settlement-config";

/**
 * The direct-write engine (ticket 05: `note`/`remember` land immediately;
 * ticket 06: `commit` is repurposed to claim validity + a run summary + the
 * job's terminal mark — this file covers each of those three duties with its
 * own test, plus the empty-handed-window acceptance criterion both tickets
 * name explicitly.
 */

const NOW = 1_800_000_000;

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
  initializeSchema(db);
});

afterEach(() => {
  db.close();
});

function seedSession(): number {
  return upsertSession(db, {
    contentSessionId: "settlement-direct-write-session",
    project: "/tmp/project-settlement-direct-write",
    title: "settlement direct-write fixture",
    content: null,
    insight: null,
    createdAtEpoch: NOW - 10_000,
    updatedAtEpoch: NOW - 10_000,
    completedAtEpoch: null,
  }).id;
}

function seedTurn(sessionDbId: number, promptNumber: number): number {
  return db
    .query<{ id: number }, [number, number, string, string, number]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         tool_call_count, created_at_epoch
       ) VALUES (?, ?, 'active', ?, ?, 3, ?)
       RETURNING id`,
    )
    .get(
      sessionDbId,
      promptNumber,
      `prompt ${promptNumber}`,
      `response ${promptNumber}`,
      NOW - 1_000 + promptNumber,
    )!.id;
}

function claimWindow(
  sessionDbId: number,
  windowStart: number,
  windowEnd: number,
): NoteSettlementJob {
  enqueueNoteSettlementWindows(
    db,
    [{ sessionId: sessionDbId, windowStart, windowEnd, triggerType: "consecutive" }],
    NOW,
    SETTLEMENT_ERA_CUTOFF_EPOCH,
  );
  const job = claimNextNoteSettlementJob(db, sessionDbId, NOW, NOW * 1000);
  if (!job) {
    throw new Error("fixture failed to claim a settlement job");
  }
  return job;
}

function baseContext(
  job: NoteSettlementJob,
  overrides: Partial<SettlementTurnFacadeContext> = {},
): SettlementTurnFacadeContext {
  return {
    jobId: job.id,
    claimGeneration: job.claimGeneration,
    sessionId: job.sessionId,
    reviewableTurnIds: new Set(),
    contextBuiltAtEpoch: NOW,
    eligibleRelationPairKeys: new Set(),
    attachedSegmentIds: new Set(),
    ...overrides,
  };
}

describe("note/remember land immediately, before commit is ever called (ticket 05)", () => {
  test("writeNote lands the row right away", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const engine = createSettlementDirectWriteEngine({
      db,
      context: baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      now: () => NOW,
    });

    const receipt = engine.writeNote({ turn: `S${sessionDbId}/T1`, grade: 3, type: ["design"] });

    expect(receipt.content[0]!.text).toContain("Landed");
    expect(getTurnById(db, t1)!.significanceGrade).toBe(3);
    // The job is not yet marked done — only commit does that.
    expect(getNoteSettlementJob(db, job.id)!.status).toBe("claimed");
  });
});

describe("commit — three duties, each its own test (ticket 06)", () => {
  test("duty 1: claim validity — a reclaimed lease refuses commit and marks nothing done", () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const engine = createSettlementDirectWriteEngine({ db, context: baseContext(job), now: () => NOW });

    // The lease moves out from under this run (a reclaim, in production).
    db.query<unknown, [number]>(
      "UPDATE note_settlement_jobs SET claim_generation = claim_generation + 1 WHERE id = ?",
    ).run(job.id);

    const receipt = engine.commit();

    expect(receipt.content[0]!.text).toContain("Commit refused");
    expect(receipt.content[0]!.text).toContain("lease was reclaimed");
    expect(getNoteSettlementJob(db, job.id)!.status).toBe("claimed");
    expect(engine.getLastCommitMetrics()).toBeNull();
  });

  test("duty 2: a run summary counts exactly what THIS run wrote", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    const job = claimWindow(sessionDbId, 1, 2);
    const engine = createSettlementDirectWriteEngine({
      db,
      context: baseContext(job, { reviewableTurnIds: new Set([t1, t2]) }),
      now: () => NOW,
    });

    engine.writeNote({ turn: `S${sessionDbId}/T1`, grade: 2, type: ["design"] });
    engine.writeNote({ turn: `S${sessionDbId}/T2`, grade: 3 });
    engine.writeMembership({
      action: "propose",
      addresses: [`S${sessionDbId}/T1`, `S${sessionDbId}/T2`],
      title: "a cluster",
    });

    engine.commit();
    const metrics = engine.getLastCommitMetrics();

    expect(metrics).not.toBeNull();
    expect(metrics!.turnsReviewed).toBe(2);
    expect(metrics!.reviewsYieldedToLateNote).toBe(0);
    expect(metrics!.gradeHistogram).toEqual([0, 0, 1, 1, 0]);
    expect(metrics!.proposalsCreated).toBe(1);
  });

  test("duty 3: the terminal mark — the job goes done and the cursor advances", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const engine = createSettlementDirectWriteEngine({
      db,
      context: baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      now: () => NOW,
    });
    engine.writeNote({ turn: `S${sessionDbId}/T1`, grade: 1 });

    const receipt = engine.commit();

    expect(receipt.content[0]!.text).toContain("Committed");
    expect(getNoteSettlementJob(db, job.id)!.status).toBe("done");
    expect(getNoteSettlementCursor(db, sessionDbId)).toBe(1);
  });

  test("commit does not judge duty coverage — an empty-handed window (nothing written) completes exactly as cleanly", () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const engine = createSettlementDirectWriteEngine({ db, context: baseContext(job), now: () => NOW });

    // No writeNote/writeMembership call at all.
    const receipt = engine.commit();

    expect(receipt.content[0]!.text).toContain("Committed");
    expect(getNoteSettlementJob(db, job.id)!.status).toBe("done");
    expect(engine.getLastCommitMetrics()).toEqual({
      turnsReviewed: 0,
      reviewsYieldedToLateNote: 0,
      gradeHistogram: [0, 0, 0, 0, 0],
      relationsWritten: 0,
      proposalsCreated: 0,
      sessionNarrativeWritten: 0,
      membersReassigned: 0,
    });
  });

  test("a second commit call in the same run is idempotent, not a fence error", () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const engine = createSettlementDirectWriteEngine({ db, context: baseContext(job), now: () => NOW });

    expect(engine.commit().content[0]!.text).toContain("Committed");
    const second = engine.commit();

    expect(second.content[0]!.text).toContain("Already committed");
    expect(second.content[0]!.text).not.toContain("refused");
    expect(getNoteSettlementJob(db, job.id)!.status).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// Peer finding P1-1 (2026-08-19 commit review): each direct write must be
// check-write-stamp ATOMIC. A compound call whose relation half rejects
// AFTER its type half already applied must leave no partial state behind.
// ---------------------------------------------------------------------------

describe("a rejected direct write leaves no partial state (one transaction per call)", () => {
  test("type lands then the relation rejects: the whole call rolls back", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    updateTurnById(db, t1, { type: ["design"] });
    writeMemoryEdges(
      db,
      [{ citing: { kind: "turn", id: t2 }, cited: { kind: "turn", id: t1 }, relation: null, provenance: "text-ref" }],
      NOW - 500,
      { eligibleForRelation: "unrestricted" },
    );
    const job = claimWindow(sessionDbId, 1, 2);
    const engine = createSettlementDirectWriteEngine({
      db,
      context: baseContext(job, {
        reviewableTurnIds: new Set([t2]),
        eligibleRelationPairKeys: new Set([
          pairKey({ citing: { kind: "turn", id: t2 }, cited: { kind: "turn", id: t1 } }),
        ]),
      }),
      now: () => NOW,
    });

    // implement = delivery-only: refines demands a decision-phase citing turn,
    // so the relation half rejects — but only after the review half already
    // ran its UPDATE under apply:true.
    const receipt = engine.writeNote({
      turn: "S" + sessionDbId + "/T2",
      type: ["implement"],
      refines: ["S" + sessionDbId + "/T1"],
    });

    expect(receipt.content[0]!.text).toContain("Parameter error");
    expect(getTurnById(db, t2)!.type).toEqual([]);
    const stamp = db
      .query("SELECT writer FROM write_gate_stamps WHERE entity_type = 'turn' AND entity_id = ? AND field = 'type'")
      .get(t2);
    expect(stamp).toBeNull();
  });
});
