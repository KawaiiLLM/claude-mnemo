import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createDatabase,
  isSqliteBusy,
  runWriteTransaction,
} from "../../src/db/database";
import {
  assertNoteSettlementJobClaimed,
  completeNoteSettlementJobIfSegmented,
  computeElectionCeilingViolations,
  computeNoteSettlementMembershipGapSegmentIds,
  hasNoteSettlementMembershipActivity,
  NoteSettlementJobFenceError,
  recordNoteSettlementMembershipActivity,
} from "../../src/db/note-settlement-completion";
import {
  claimNextNoteSettlementJob,
  enqueueNoteSettlementWindows,
  getNoteSettlementCursor,
  getNoteSettlementJob,
  type NoteSettlementJob,
} from "../../src/db/note-settlement";
import { initializeSchema } from "../../src/db/schema";
import { addSegmentMembers, attachSegmentToSession, createSegment } from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { upsertShadowNote } from "../../src/db/shadow-notes";
import { getTurnById, updateTurnById } from "../../src/db/turns";
import { SETTLEMENT_ERA_CUTOFF_EPOCH } from "../support/settlement-config";

/**
 * Ticket 09 (spec G6/G7): the segmentation completion gate, its anti-join,
 * and the ownership fence it shares with ticket 10's (not-yet-built) write
 * tools. See src/db/note-settlement-completion.ts for the design; this file
 * proves the four load-bearing claims: the exclusion record is job-scoped,
 * the anti-join treats a missing row as a gap in both directions, the
 * anti-join and the completion compare-and-set are one transaction, and a
 * stale claim generation cannot commit past the fence.
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

/** Give every turn in `turnIds` a stated type, so `computeCoverageGaps` is clean. */
function markTyped(turnIds: readonly number[]): void {
  for (const turnId of turnIds) {
    updateTurnById(db, turnId, { type: ["discuss"] });
  }
}

/** Give every turn in `turnIds` a note, so `computeNoteSettlementNoteGaps` (duty 2) is clean. */
function markNoted(turnIds: readonly number[]): void {
  for (const turnId of turnIds) {
    upsertShadowNote(db, {
      turnId,
      title: "fixture title",
      content: "fixture content",
      nowEpoch: NOW,
    });
  }
}

describe("note_settlement_membership_activity — the record itself (ticket 08)", () => {
  test("records a job-scoped membership-engaged fact, idempotently", () => {
    const sessionDbId = seedSession();
    const job = claimWindow(sessionDbId, 1, 1);

    recordNoteSettlementMembershipActivity(db, job.id, NOW);
    recordNoteSettlementMembershipActivity(db, job.id, NOW + 5);

    expect(hasNoteSettlementMembershipActivity(db, job.id)).toBe(true);
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM note_settlement_membership_activity",
        )
        .get()?.count,
    ).toBe(1);
  });

  test("cascades when the job is deleted", () => {
    const sessionDbId = seedSession();
    const job = claimWindow(sessionDbId, 1, 1);
    recordNoteSettlementMembershipActivity(db, job.id, NOW);

    db.query<unknown, [number]>("DELETE FROM note_settlement_jobs WHERE id = ?").run(job.id);

    expect(hasNoteSettlementMembershipActivity(db, job.id)).toBe(false);
  });
});

describe("computeNoteSettlementMembershipGapSegmentIds — the re-keyed segmentation check (ticket 08)", () => {
  test("a session with zero attached segments needs no membership call — always satisfied", () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);

    expect(computeNoteSettlementMembershipGapSegmentIds(db, job.id, sessionDbId)).toEqual([]);
  });

  test("a session with an attached segment and NO membership activity yet is a gap, naming the attached segment", () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const segment = createSegment(db, { title: "chapter", nowEpoch: NOW });
    attachSegmentToSession(db, sessionDbId, segment.id, NOW);

    expect(computeNoteSettlementMembershipGapSegmentIds(db, job.id, sessionDbId)).toEqual([
      segment.id,
    ]);
  });

  test("recording membership activity for THIS job clears the gap", () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const segment = createSegment(db, { title: "chapter", nowEpoch: NOW });
    attachSegmentToSession(db, sessionDbId, segment.id, NOW);

    recordNoteSettlementMembershipActivity(db, job.id, NOW);

    expect(computeNoteSettlementMembershipGapSegmentIds(db, job.id, sessionDbId)).toEqual([]);
  });

  test("membership activity recorded for a DIFFERENT job does not clear this job's gap — job-scoped, not session-scoped", () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const jobA = enqueueNoteSettlementWindows(
      db,
      [{ sessionId: sessionDbId, windowStart: 1, windowEnd: 1, triggerType: "consecutive" }],
      NOW,
      SETTLEMENT_ERA_CUTOFF_EPOCH,
    )[0]!;
    const jobB = enqueueNoteSettlementWindows(
      db,
      [{ sessionId: sessionDbId, windowStart: 2, windowEnd: 2, triggerType: "consecutive" }],
      NOW,
      SETTLEMENT_ERA_CUTOFF_EPOCH,
    )[0]!;
    const segment = createSegment(db, { title: "chapter", nowEpoch: NOW });
    attachSegmentToSession(db, sessionDbId, segment.id, NOW);

    recordNoteSettlementMembershipActivity(db, jobB.id, NOW);

    expect(computeNoteSettlementMembershipGapSegmentIds(db, jobA.id, sessionDbId)).toEqual([
      segment.id,
    ]);
  });

  test("a homeless-everything window (no calls at all) with zero attachments is not blocked — homeless stays legal", () => {
    // The whole point of ticket 08's re-key: a window whose turns fit
    // nothing is legal WITHOUT any per-turn or per-job record, as long as
    // the session attached nothing to begin with — there is nothing to
    // engage.
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    seedTurn(sessionDbId, 2);
    const job = claimWindow(sessionDbId, 1, 2);

    expect(computeNoteSettlementMembershipGapSegmentIds(db, job.id, sessionDbId)).toEqual([]);
  });
});

describe("assertNoteSettlementJobClaimed — the ownership fence", () => {
  test("a matching claim generation passes the fence and the write commits", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);

    runWriteTransaction(db, () => {
      assertNoteSettlementJobClaimed(db, job.id, job.claimGeneration);
      recordNoteSettlementMembershipActivity(db, job.id, NOW);
    });

    expect(hasNoteSettlementMembershipActivity(db, job.id)).toBe(true);
    void t1;
  });

  test("a stale claim generation, bumped from outside before the transaction opens, cannot commit a write past the fence", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
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
        // The fence, as the FIRST statement of the caller's own transaction —
        // exactly the contract ticket 10's write tools must follow.
        assertNoteSettlementJobClaimed(db, job.id, staleGeneration);
        // Never reached: a write a real settlement write tool would perform.
        recordNoteSettlementMembershipActivity(db, job.id, NOW);
      }),
    ).toThrow(NoteSettlementJobFenceError);

    expect(hasNoteSettlementMembershipActivity(db, job.id)).toBe(false);
    void t1;
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

/**
 * Run `fire` the instant after the next SELECT matching `FROM turns` reads
 * its rows, then get out of the way. Copied from
 * tests/worker/note-settlement-writeback.test.ts's `fireAfterNextTurnRead`
 * (that file's own doc comment explains the underlying mechanism — a nested
 * savepoint that composes correctly with bun:sqlite's `.immediate()`
 * transactions), generalised to patch `.all` as well as `.get` because the
 * completion gate's window read is a `SELECT … .all(...)`, not a `.get(...)`.
 * Duplicated rather than imported, matching that file's own reasoning: each
 * fixture file owns its local seeding/interleave helpers.
 */
function fireAfterNextTurnsRead(target: Database, fire: () => void): void {
  const originalQuery = target.query.bind(target);
  let armed = true;
  (target as unknown as { query: (sql: string) => unknown }).query = (
    sql: string,
  ) => {
    const statement = originalQuery(sql) as unknown as {
      get: (...args: unknown[]) => unknown;
      all: (...args: unknown[]) => unknown;
    };
    if (!armed || !/^\s*SELECT/i.test(sql) || !/FROM turns/i.test(sql)) {
      return statement;
    }
    const originalGet = statement.get.bind(statement);
    const originalAll = statement.all.bind(statement);
    const disarmAndFire = () => {
      if (!armed) {
        return;
      }
      armed = false;
      statement.get = originalGet;
      statement.all = originalAll;
      (target as unknown as { query: unknown }).query = originalQuery;
      fire();
    };
    statement.get = (...args: unknown[]) => {
      const row = originalGet(...args);
      disarmAndFire();
      return row;
    };
    statement.all = (...args: unknown[]) => {
      const rows = originalAll(...args);
      disarmAndFire();
      return rows;
    };
    return statement;
  };
}

describe("completeNoteSettlementJobIfSegmented — the completion gate", () => {
  test("refuses on a stale claim generation without evaluating segmentation at all", () => {
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

    expect(result).toEqual({
      completed: false,
      reason: "generation-mismatch",
      segmentationGaps: [],
      noteGaps: [],
      coverageGaps: [],
      electionCeilingViolations: [],
    });
    expect(getNoteSettlementJob(db, job.id)?.status).toBe("claimed");
  });

  test("refuses with note-incomplete when segmentation and type coverage are done but a turn still owes a note (spec G1a, duty 2)", () => {
    // The scenario G1a exists for: a turn can carry a stated type (duty 1,
    // `computeCoverageGaps`, done) and a segment membership (duty 3, done)
    // while the hole duty 2 existed to fill — a note — is still open. Before
    // this clause, the gate's only two checks would both read this window as
    // finished and mark it `done`, permanently unnoted.
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    markTyped([t1]);
    const segment = createSegment(db, { title: "chapter", nowEpoch: NOW });
    addSegmentMembers(db, segment.id, [t1], NOW);
    // Deliberately no `markNoted([t1])`.

    const result = completeNoteSettlementJobIfSegmented(
      db,
      job.id,
      job.claimGeneration,
      NOW,
    );

    expect(result).toEqual({
      completed: false,
      reason: "note-incomplete",
      segmentationGaps: [],
      noteGaps: [{ turnId: t1, sessionId: sessionDbId, promptNumber: 1 }],
      coverageGaps: [],
      electionCeilingViolations: [],
    });
    // G2: a refusal for ANY reason leaves the job exactly as it was.
    expect(getNoteSettlementJob(db, job.id)?.status).toBe("claimed");
    expect(getNoteSettlementCursor(db, sessionDbId)).toBe(0);

    // Writing the note (what ticket 10a's `note` tool does) closes duty 2,
    // and a retry then completes the window.
    markNoted([t1]);
    const retried = completeNoteSettlementJobIfSegmented(
      db,
      job.id,
      job.claimGeneration,
      NOW + 1,
    );
    expect(retried.completed).toBe(true);
    expect(getNoteSettlementJob(db, job.id)?.status).toBe("done");
  });

  test("a declined turn (agent's own real-time skip) owes no note under duty 2, but a system write-off still does", () => {
    // db/note-debt.ts's `listOwedNoteTurnsInRange`, the predicate this duty
    // adopts as-is: ONLY `note_debt.status='skipped', reason='declined'`
    // excludes a turn — a `closed`/`aged`/`rolled-back` reason (the SYSTEM
    // abandoning a dead session's ledger) does not, because settlement's own
    // reconstruction duty must still be able to backfill it. This mirrors
    // the runtime guard being replaced, which drew the identical line.
    const sessionDbId = seedSession();
    const declined = seedTurn(sessionDbId, 1);
    const writtenOff = seedTurn(sessionDbId, 2);
    const job = claimWindow(sessionDbId, 1, 2);
    markTyped([declined, writtenOff]);
    const segment = createSegment(db, { title: "chapter", nowEpoch: NOW });
    addSegmentMembers(db, segment.id, [declined, writtenOff], NOW);

    db.query<unknown, [number, number, number, string, string, number, number, number]>(
      `INSERT INTO note_debt (
         turn_id, session_id, prompt_number, status, reason,
         opened_at_epoch, closed_at_epoch, updated_at_epoch
       ) VALUES (?, ?, ?, 'skipped', 'declined', ?, ?, ?)`,
    ).run(declined, sessionDbId, 1, NOW, NOW, NOW);
    db.query<unknown, [number, number, number, string, string, number, number, number]>(
      `INSERT INTO note_debt (
         turn_id, session_id, prompt_number, status, reason,
         opened_at_epoch, closed_at_epoch, updated_at_epoch
       ) VALUES (?, ?, ?, 'skipped', 'closed', ?, ?, ?)`,
    ).run(writtenOff, sessionDbId, 2, NOW, NOW, NOW);

    const result = completeNoteSettlementJobIfSegmented(
      db,
      job.id,
      job.claimGeneration,
      NOW,
    );

    expect(result.reason).toBe("note-incomplete");
    expect(result.noteGaps.map((gap) => gap.turnId)).toEqual([writtenOff]);
  });

  test("refuses with coverage-incomplete when segmentation and duty 2 are done but a turn still has no stated type", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const segment = createSegment(db, { title: "chapter", nowEpoch: NOW });
    addSegmentMembers(db, segment.id, [t1], NOW);
    markNoted([t1]);
    // Deliberately no `markTyped([t1])`: segmentation and duty 2 (the note)
    // are satisfied, duty 1 (type) coverage is not.

    const result = completeNoteSettlementJobIfSegmented(
      db,
      job.id,
      job.claimGeneration,
      NOW,
    );

    expect(result.completed).toBe(false);
    expect(result.reason).toBe("coverage-incomplete");
    expect(result.coverageGaps.map((gap) => gap.turnId)).toEqual([t1]);
    expect(getNoteSettlementJob(db, job.id)?.status).toBe("claimed");
  });

  test("crash-before-membership-activity (ticket 08): an attached session with no recorded activity leaves the window incomplete; recording activity on retry completes it", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    markTyped([t1]);
    markNoted([t1]);

    // This session has an ATTACHED segment (the re-keyed gate's own trigger
    // condition) but the run crashed before any assign/propose landed.
    const segment = createSegment(db, { title: "chapter", nowEpoch: NOW });
    attachSegmentToSession(db, sessionDbId, segment.id, NOW);

    const firstAttempt = completeNoteSettlementJobIfSegmented(
      db,
      job.id,
      job.claimGeneration,
      NOW,
    );

    expect(firstAttempt.completed).toBe(false);
    expect(firstAttempt.reason).toBe("segmentation-incomplete");
    expect(firstAttempt.segmentationGaps).toEqual([segment.id]);
    // G2: the job stays claimed. It does NOT go to `failed` or `pending`.
    expect(getNoteSettlementJob(db, job.id)?.status).toBe("claimed");
    expect(getNoteSettlementCursor(db, sessionDbId)).toBe(0);

    // A retry engages the membership tool — the exact scenario the re-keyed
    // gate exists to require.
    recordNoteSettlementMembershipActivity(db, job.id, NOW + 1);

    const secondAttempt = completeNoteSettlementJobIfSegmented(
      db,
      job.id,
      job.claimGeneration,
      NOW + 2,
    );

    expect(secondAttempt).toEqual({
      completed: true,
      reason: null,
      segmentationGaps: [],
      noteGaps: [],
      coverageGaps: [],
      electionCeilingViolations: [],
    });
    expect(getNoteSettlementJob(db, job.id)?.status).toBe("done");
    expect(getNoteSettlementCursor(db, sessionDbId)).toBe(1);
  });
});

/**
 * The gate's transaction boundary (spec G7), on a FILE database with a second
 * connection — the only shape that can test it.
 *
 * The first version of this test ran on one `:memory:` connection and fired a
 * `claim_generation` bump between the anti-join's read and the
 * compare-and-set. A cross-session review showed it proved nothing: the CAS
 * re-verifies the generation on its own, so removing `runWriteTransaction`
 * entirely left the test green. Worse, a same-connection write lands INSIDE
 * the gate's own transaction, so no single-connection fixture can distinguish
 * "these reads and this write share a transaction" from "they do not".
 *
 * What `BEGIN IMMEDIATE` actually buys is stated directly here: while the gate
 * is deciding, nobody else can change the facts it decided on. The competing
 * write is a coverage REGRESSION (clearing a turn's type) carrying no
 * generation change, so the CAS cannot catch it — the lock is the only thing
 * that can.
 */
describe("the completion gate holds its window while it decides (spec G7)", () => {
  let directory: string;
  let other: Database;

  beforeEach(() => {
    // The outer hook made a `:memory:` database; two connections need a file.
    db.close();
    directory = mkdtempSync(join(tmpdir(), "mnemo-completion-txn-"));
    db = createDatabase(join(directory, "mnemo.sqlite"));
    initializeSchema(db);
    // `busyTimeoutMs: 0` so the competing write fails immediately instead of
    // blocking on the lock for the default timeout.
    other = createDatabase(join(directory, "mnemo.sqlite"), { busyTimeoutMs: 0 });
  });

  afterEach(() => {
    other.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("a competing connection cannot clear a turn's type between the coverage read and the compare-and-set", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    markTyped([t1]);
    markNoted([t1]);
    const segment = createSegment(db, { title: "chapter", nowEpoch: NOW });
    addSegmentMembers(db, segment.id, [t1], NOW);

    let competingWriteLanded = false;
    fireAfterNextTurnsRead(db, () => {
      try {
        other
          .query<unknown, [number]>("UPDATE turns SET type = '[]' WHERE id = ?")
          .run(t1);
        competingWriteLanded = true;
      } catch (error) {
        if (!isSqliteBusy(error)) {
          throw error;
        }
      }
    });

    const result = completeNoteSettlementJobIfSegmented(
      db,
      job.id,
      job.claimGeneration,
      NOW + 10,
    );

    // The load-bearing assertion: the write was locked out. Without
    // `runWriteTransaction` it lands, and the gate then completes a window
    // whose coverage no longer holds — with the generation untouched, so
    // nothing downstream would notice.
    expect(competingWriteLanded).toBe(false);
    expect(result.completed).toBe(true);
    expect(
      db
        .query<{ type: string }, [number]>("SELECT type FROM turns WHERE id = ?")
        .get(t1)?.type,
    ).toBe(JSON.stringify(["discuss"]));
    expect(getNoteSettlementJob(db, job.id)?.status).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// ADR-0003 — the election ceiling validator: seats are ceilings, never
// targets. A window that stages more A or B tiers than floor(share·N)
// refuses commit, naming the ceiling and the count; the gate never demotes
// anyone itself.
// ---------------------------------------------------------------------------

describe("computeElectionCeilingViolations — the ceiling validator (ADR-0003)", () => {
  /** N=10 window turns → ceiling(A) = floor(0.1*10) = 1, ceiling(B) = floor(0.3*10) = 3. */
  function seedTenTurnWindow(sessionDbId: number): number[] {
    const turnIds: number[] = [];
    for (let promptNumber = 1; promptNumber <= 10; promptNumber += 1) {
      turnIds.push(seedTurn(sessionDbId, promptNumber));
    }
    return turnIds;
  }

  test("an empty election (0 A, 0 B) is never a violation, whatever N is", () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    seedTurn(sessionDbId, 2);
    seedTurn(sessionDbId, 3);

    // N=3 → ceiling(A) = ceiling(B) = 0 — a ceiling of zero is legal, and an
    // election that elects nothing at all must still pass it.
    expect(computeElectionCeilingViolations(db, sessionDbId, 1, 3)).toEqual([]);
  });

  test("an A-tier count exactly at the ceiling passes", () => {
    const sessionDbId = seedSession();
    const turnIds = seedTenTurnWindow(sessionDbId);
    updateTurnById(db, turnIds[0]!, { electionTier: "A" });

    expect(computeElectionCeilingViolations(db, sessionDbId, 1, 10)).toEqual([]);
  });

  test("an A-tier count one over the ceiling is a violation naming the ceiling and the count", () => {
    const sessionDbId = seedSession();
    const turnIds = seedTenTurnWindow(sessionDbId);
    updateTurnById(db, turnIds[0]!, { electionTier: "A" });
    updateTurnById(db, turnIds[1]!, { electionTier: "A" });

    expect(computeElectionCeilingViolations(db, sessionDbId, 1, 10)).toEqual([
      { tier: "A", ceiling: 1, count: 2, windowTurns: 10 },
    ]);
  });

  test("a B-tier count over the ceiling is a violation, independent of A", () => {
    const sessionDbId = seedSession();
    const turnIds = seedTenTurnWindow(sessionDbId);
    for (let index = 0; index < 4; index += 1) {
      updateTurnById(db, turnIds[index]!, { electionTier: "B" });
    }

    expect(computeElectionCeilingViolations(db, sessionDbId, 1, 10)).toEqual([
      { tier: "B", ceiling: 3, count: 4, windowTurns: 10 },
    ]);
  });

  test("A and B can both violate their ceilings in the same window", () => {
    const sessionDbId = seedSession();
    const turnIds = seedTenTurnWindow(sessionDbId);
    updateTurnById(db, turnIds[0]!, { electionTier: "A" });
    updateTurnById(db, turnIds[1]!, { electionTier: "A" });
    for (let index = 2; index < 6; index += 1) {
      updateTurnById(db, turnIds[index]!, { electionTier: "B" });
    }

    expect(computeElectionCeilingViolations(db, sessionDbId, 1, 10)).toEqual([
      { tier: "A", ceiling: 1, count: 2, windowTurns: 10 },
      { tier: "B", ceiling: 3, count: 4, windowTurns: 10 },
    ]);
  });

  test("a tier assigned to a turn OUTSIDE the frozen window is not counted", () => {
    const sessionDbId = seedSession();
    const turnIds = seedTenTurnWindow(sessionDbId);
    const outside = seedTurn(sessionDbId, 11);
    updateTurnById(db, outside, { electionTier: "A" });

    expect(computeElectionCeilingViolations(db, sessionDbId, 1, 10)).toEqual([]);
    void turnIds;
  });
});

describe("completeNoteSettlementJobIfSegmented — the election ceiling gate refuses commit (ADR-0003)", () => {
  /**
   * Every OTHER duty satisfied for a 10-turn window: typed, noted. This
   * fixture's session attaches no segment, so the re-keyed segmentation
   * check (ticket 08) is trivially satisfied without any membership call —
   * the ONLY gap this whole describe block ever probes is the election
   * ceiling.
   */
  function satisfyEveryDutyExceptElection(
    sessionDbId: number,
    job: NoteSettlementJob,
  ): number[] {
    const turnIds: number[] = [];
    for (let promptNumber = 1; promptNumber <= 10; promptNumber += 1) {
      turnIds.push(seedTurn(sessionDbId, promptNumber));
    }
    markTyped(turnIds);
    markNoted(turnIds);
    return turnIds;
  }

  test("a commit-shaped over-ceiling window refuses with election-ceiling-exceeded, naming the ceiling and the count, and leaves the job claimed", () => {
    const sessionDbId = seedSession();
    const job = claimWindow(sessionDbId, 1, 10);
    const turnIds = satisfyEveryDutyExceptElection(sessionDbId, job);
    // Ceiling(A) = 1 at N=10 — two A-tier turns is one over.
    updateTurnById(db, turnIds[0]!, { electionTier: "A" });
    updateTurnById(db, turnIds[1]!, { electionTier: "A" });

    const result = completeNoteSettlementJobIfSegmented(db, job.id, job.claimGeneration, NOW);

    expect(result.completed).toBe(false);
    expect(result.reason).toBe("election-ceiling-exceeded");
    expect(result.electionCeilingViolations).toEqual([
      { tier: "A", ceiling: 1, count: 2, windowTurns: 10 },
    ]);
    // Every OTHER gap array stays empty — this is the ONLY thing blocking.
    expect(result.segmentationGaps).toEqual([]);
    expect(result.noteGaps).toEqual([]);
    expect(result.coverageGaps).toEqual([]);
    // G2: a refusal for ANY reason leaves the job exactly as it was.
    expect(getNoteSettlementJob(db, job.id)?.status).toBe("claimed");
  });

  test("re-ranking down to the ceiling and retrying completes the window — the gate never demotes anyone itself", () => {
    const sessionDbId = seedSession();
    const job = claimWindow(sessionDbId, 1, 10);
    const turnIds = satisfyEveryDutyExceptElection(sessionDbId, job);
    updateTurnById(db, turnIds[0]!, { electionTier: "A" });
    updateTurnById(db, turnIds[1]!, { electionTier: "A" });

    const firstAttempt = completeNoteSettlementJobIfSegmented(db, job.id, job.claimGeneration, NOW);
    expect(firstAttempt.reason).toBe("election-ceiling-exceeded");

    // The subagent re-ranks: T2 stands down to C (cleared), never
    // mechanically demoted by the gate itself.
    updateTurnById(db, turnIds[1]!, { electionTier: null });

    const retried = completeNoteSettlementJobIfSegmented(db, job.id, job.claimGeneration, NOW + 1);
    expect(retried.completed).toBe(true);
    expect(retried.reason).toBeNull();
    expect(getNoteSettlementJob(db, job.id)?.status).toBe("done");
    expect(getTurnById(db, turnIds[0]!)?.electionTier).toBe("A");
    expect(getTurnById(db, turnIds[1]!)?.electionTier).toBeNull();
  });

  test("an empty or sparse election passes the gate — ceilings are never targets", () => {
    const sessionDbId = seedSession();
    const job = claimWindow(sessionDbId, 1, 10);
    satisfyEveryDutyExceptElection(sessionDbId, job);
    // Nobody elected at all.

    const result = completeNoteSettlementJobIfSegmented(db, job.id, job.claimGeneration, NOW);

    expect(result.completed).toBe(true);
    expect(result.electionCeilingViolations).toEqual([]);
  });
});
