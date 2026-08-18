import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase, runWriteTransaction } from "../../src/db/database";
import {
  assertNoteSettlementJobClaimed,
  completeNoteSettlementJobIfSegmented,
  NoteSettlementJobFenceError,
} from "../../src/db/note-settlement-completion";
import {
  claimNextNoteSettlementJob,
  enqueueNoteSettlementWindows,
  getNoteSettlementCursor,
  getNoteSettlementJob,
  type NoteSettlementJob,
} from "../../src/db/note-settlement";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { upsertShadowNote } from "../../src/db/shadow-notes";
import { updateTurnById } from "../../src/db/turns";
import { SETTLEMENT_ERA_CUTOFF_EPOCH } from "../support/settlement-config";

/**
 * The settlement completion gate (ownership-and-note-cadence spec, ticket
 * 05, "settlement demolition") — the ownership fence, and the CAS it guards.
 *
 * BEFORE this ticket, the gate was a four-way anti-join: a per-job
 * membership fact (segmentation-incomplete), a note-debt anti-join
 * (note-incomplete), a coverage anti-join (coverage-incomplete), and an
 * election seat-ceiling validator (election-ceiling-exceeded). All four are
 * GONE — see src/db/note-settlement-completion.ts's module doc comment.
 * This file now proves exactly what is left: the fence (a stale claim
 * generation or a job no longer claimed refuses), the CAS (a matching claim
 * completes and advances the cursor), and the one property the demolition
 * exists to prove — a window with NOTHING to correct completes exactly as
 * cleanly as one that had real work landed against it (checklist item 1:
 * "一个只含检查语义的窗口能正常完成").
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
    contentSessionId: "settlement-completion-session",
    project: "/tmp/project-settlement-completion",
    title: "settlement completion fixture",
    content: null,
    insight: null,
    createdAtEpoch: NOW - 10_000,
    updatedAtEpoch: NOW - 10_000,
    completedAtEpoch: null,
  }).id;
}

/** A plain, eligible turn: real prose, not a compact marker or a bare slash command. */
function seedTurn(sessionDbId: number, promptNumber: number): number {
  return db
    .query<{ id: number }, [number, number, string, string, number]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         created_at_epoch
       ) VALUES (?, ?, 'active', ?, ?, ?)
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

describe("assertNoteSettlementJobClaimed — the ownership fence", () => {
  test("a matching claim generation passes the fence", () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);

    expect(() =>
      runWriteTransaction(db, () => {
        assertNoteSettlementJobClaimed(db, job.id, job.claimGeneration);
      }),
    ).not.toThrow();
  });

  test("a stale claim generation, bumped from outside before the transaction opens, throws", () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const staleGeneration = job.claimGeneration;

    // "From outside": a competing dispatch reclaims the job in its own,
    // already-committed statement, bumping the generation before the stale
    // caller below ever opens its write transaction.
    db.query<unknown, [number]>(
      "UPDATE note_settlement_jobs SET claim_generation = claim_generation + 1 WHERE id = ?",
    ).run(job.id);

    expect(() =>
      runWriteTransaction(db, () => {
        assertNoteSettlementJobClaimed(db, job.id, staleGeneration);
      }),
    ).toThrow(NoteSettlementJobFenceError);
  });

  test("a job that is no longer claimed refuses the fence the same way", () => {
    const sessionDbId = seedSession();
    const job = claimWindow(sessionDbId, 1, 1);
    db.query<unknown, [number]>(
      "UPDATE note_settlement_jobs SET status = 'done' WHERE id = ?",
    ).run(job.id);

    expect(() =>
      runWriteTransaction(db, () => {
        assertNoteSettlementJobClaimed(db, job.id, job.claimGeneration);
      }),
    ).toThrow(NoteSettlementJobFenceError);
  });
});

describe("completeNoteSettlementJobIfSegmented — the completion gate (ticket 05: an empty shell)", () => {
  test("refuses on a stale claim generation, leaving the job claimed", () => {
    const sessionDbId = seedSession();
    const job = claimWindow(sessionDbId, 1, 1);
    db.query<unknown, [number]>(
      "UPDATE note_settlement_jobs SET claim_generation = claim_generation + 1 WHERE id = ?",
    ).run(job.id);

    const result = completeNoteSettlementJobIfSegmented(
      db,
      job.id,
      job.claimGeneration,
      NOW,
    );

    expect(result).toEqual({ completed: false, reason: "generation-mismatch" });
    expect(getNoteSettlementJob(db, job.id)?.status).toBe("claimed");
  });

  test("refuses on a job that is no longer claimed", () => {
    const sessionDbId = seedSession();
    const job = claimWindow(sessionDbId, 1, 1);
    db.query<unknown, [number]>(
      "UPDATE note_settlement_jobs SET status = 'done' WHERE id = ?",
    ).run(job.id);

    const result = completeNoteSettlementJobIfSegmented(
      db,
      job.id,
      job.claimGeneration,
      NOW,
    );

    expect(result).toEqual({ completed: false, reason: "not-claimed" });
  });

  test("a window with NOTHING to correct completes cleanly — no note, no type, no segment, no election, nothing staged at all", () => {
    // The checklist's own scenario (ticket 05, item 1): "一个只含检查语义的窗口
    // 能正常完成" — a window this run only CHECKED, and found nothing wrong
    // with, completes exactly as cleanly as one where real work landed.
    // Duty 1 (grading), duty 2 (reconstruction) and the membership gate are
    // all gone, so an untyped, unnoted, unsegmented, ungraded turn is no
    // longer a completion gap of any kind.
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    seedTurn(sessionDbId, 2);
    const job = claimWindow(sessionDbId, 1, 2);

    const result = completeNoteSettlementJobIfSegmented(
      db,
      job.id,
      job.claimGeneration,
      NOW,
    );

    expect(result).toEqual({ completed: true, reason: null });
    expect(getNoteSettlementJob(db, job.id)?.status).toBe("done");
    expect(getNoteSettlementCursor(db, sessionDbId)).toBe(2);
  });

  test("a window where the main agent already typed and noted every turn ALSO completes cleanly — checking finds nothing to correct either way", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    updateTurnById(db, t1, { type: ["discuss"] });
    upsertShadowNote(db, { turnId: t1, title: "title", content: "content", nowEpoch: NOW });
    const job = claimWindow(sessionDbId, 1, 1);

    const result = completeNoteSettlementJobIfSegmented(
      db,
      job.id,
      job.claimGeneration,
      NOW,
    );

    expect(result.completed).toBe(true);
    expect(getNoteSettlementJob(db, job.id)?.status).toBe("done");
  });

  test("a second attempt against an already-`done` job refuses at the fence (not-claimed) rather than re-completing", () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);

    const first = completeNoteSettlementJobIfSegmented(db, job.id, job.claimGeneration, NOW);
    expect(first.completed).toBe(true);

    const second = completeNoteSettlementJobIfSegmented(
      db,
      job.id,
      job.claimGeneration,
      NOW + 1,
    );
    expect(second).toEqual({ completed: false, reason: "not-claimed" });
  });
});

// ---------------------------------------------------------------------------
// MUTATION DEMO (ticket 05, "settlement demolition"), actually run:
//
// BREAK: in `completeNoteSettlementJobIfSegmentedCore`
// (src/db/note-settlement-completion.ts), inserted
// `return { completed: false, reason: "not-claimed" as const };` immediately
// after the fence check — simulating the OLD gate still blocking completion
// the way segmentation/note/coverage/election-ceiling used to.
//
// RED, captured verbatim:
//
//   $ bun test tests/db/note-settlement-completion.test.ts -t "NOTHING to correct"
//   (fail) completeNoteSettlementJobIfSegmented — the completion gate (ticket 05: an empty shell) > a window with NOTHING to correct completes cleanly — no note, no type, no segment, no election, nothing staged at all
//   error: expect(received).toEqual(expected)
//   -   "completed": true,        +   "completed": false,
//   -   "reason": null,           +   "reason": "not-claimed",
//    0 pass / 1 fail
//
// RESTORE: removed the inserted line.
//
// GREEN, captured verbatim:
//
//   $ bun test tests/db/note-settlement-completion.test.ts
//   8 pass / 0 fail
//
// This is the ticket's own deliverable, not a pre-existing invariant: it
// proves the demolition actually happened — a window with nothing to
// correct really does complete cleanly now, and a reintroduced gate check
// (of any shape) would be caught by this test.
// ---------------------------------------------------------------------------
