import type { Database } from "bun:sqlite";

import {
  computeCoverageGaps,
  isEligibleCoverageTurn,
  type CoverageGap,
} from "./coverage";
import { runWriteTransaction } from "./database";
import {
  advanceNoteSettlementCursor,
  completeNoteSettlementJob,
  getNoteSettlementJob,
  NOTE_SETTLEMENT_MAX_ATTEMPTS,
  type NoteSettlementJob,
} from "./note-settlement";

/**
 * The segmentation completion gate and the ownership fence it runs under
 * (spec G6/G7, ticket 09).
 *
 * G7's problem: a window whose per-turn fields are all written but which
 * crashed before the segment tool has no EMPTY field anywhere, so a naive
 * "does every turn have a note" recheck sees nothing owed and would mark it
 * done, permanently unsegmented. What has to be proven is a state predicate
 * over the window, not a recorded event — and specifically NOT a
 * `segmentation_complete` flag, because a flag is the agent's own
 * attestation and G2's rule is that the completion gate trusts nobody.
 *
 * The positive fact (segment membership) is already persisted and add-only.
 * The one fact the data model could not express was the NEGATIVE verdict —
 * this turn was reviewed and belongs to no segment — so
 * `note_settlement_segment_exclusions` (schema.ts) records only that
 * exception, and `computeNoteSettlementSegmentationGaps` below is the
 * anti-join over it. Crash-after-membership semantics fall out rather than
 * being designed: membership written, the exclusion not yet, leaves the
 * anti-join short until a retry fills it.
 *
 * `completeNoteSettlementJobIfSegmented` is the second half: the anti-join,
 * the coverage recheck and the completion compare-and-set all run inside ONE
 * `runWriteTransaction` — G7's "run inside the same transaction as the
 * completion compare-and-set and therefore under G6's generation fence".
 * Splitting those into separate transactions would let the window between
 * them be exactly where a stale attempt's now-invalid check gets used to
 * justify a write nothing re-verifies; keeping the CAS as the LAST statement
 * of the same transaction that computed the check is what closes that gap,
 * because SQLite's `BEGIN IMMEDIATE` (via `runWriteTransaction`) holds the
 * write lock for the whole block, so nothing else can commit anything about
 * this job while it is open.
 */

export type NoteSettlementJobFenceReason = "not-claimed" | "generation-mismatch";

/**
 * Thrown by `assertNoteSettlementJobClaimed`. Exported as a typed class
 * (rather than a bare Error) so a caller that wraps this in a broader
 * try/catch — `completeNoteSettlementJobIfSegmented` below, and ticket 10's
 * write tools — can tell a lost lease apart from a genuine bug without
 * string-matching a message, the same reason `UnfilledGapError` and
 * `UnknownTurnAddressError` are typed in worker/note-settlement-writeback.ts.
 */
export class NoteSettlementJobFenceError extends Error {
  readonly jobId: number;
  readonly fenceReason: NoteSettlementJobFenceReason;

  constructor(
    jobId: number,
    fenceReason: NoteSettlementJobFenceReason,
    message: string,
  ) {
    super(message);
    this.name = "NoteSettlementJobFenceError";
    this.jobId = jobId;
    this.fenceReason = fenceReason;
  }
}

/**
 * The ownership fence (spec G6), generalised from the ad hoc check
 * `applyNoteSettlementWriteBackTransaction`
 * (worker/note-settlement-writeback.ts) already opens its transaction with —
 * this is that idiom made reusable, not a duplicate of it. Ticket 10 wires
 * this into every settlement write tool as the FIRST statement of that
 * tool's own write transaction, called with a job id and claim generation
 * the in-process server closure injects — never a value the model supplies,
 * per G6.
 *
 * Throws rather than returning a refusal object. A caller running this as
 * literally the first statement inside `runWriteTransaction`'s callback gets
 * the whole transaction rolled back for free on any thrown error (the same
 * discipline `db/note-settlement-writeback.ts`'s own thrown errors rely on),
 * so nothing executed AFTER this call in the same transaction can ever
 * commit once the lease has moved — that guarantee falls out of the throw
 * rather than needing to be re-implemented at every call site.
 */
export function assertNoteSettlementJobClaimed(
  db: Database,
  jobId: number,
  claimGeneration: number,
): NoteSettlementJob {
  const job = getNoteSettlementJob(db, jobId);
  if (!job || job.status !== "claimed") {
    throw new NoteSettlementJobFenceError(
      jobId,
      "not-claimed",
      `settlement job ${jobId}: not claimed (status ${job?.status ?? "missing"})`,
    );
  }
  if (job.claimGeneration !== claimGeneration) {
    throw new NoteSettlementJobFenceError(
      jobId,
      "generation-mismatch",
      `settlement job ${jobId}: claim generation ${claimGeneration} is stale (current ${job.claimGeneration})`,
    );
  }
  return job;
}

/**
 * Record the negative verdict (spec G7): this turn was reviewed under THIS
 * job and deliberately assigned to no segment. `ON CONFLICT DO NOTHING`
 * matches `addSegmentMembers`' idempotent-assertion convention (db/
 * segments.ts) — a retry restating the same verdict is not a second fact.
 *
 * Deliberately does not itself call `assertNoteSettlementJobClaimed`: like
 * `addSegmentMembers`, this is a plain write meant to compose inside a
 * caller's own transaction, and the caller (ticket 10's write tool) is where
 * the fence belongs — checking it here too would just be a second place the
 * same check could drift from the first.
 */
export function recordNoteSettlementSegmentExclusion(
  db: Database,
  jobId: number,
  turnId: number,
  nowEpoch: number,
): void {
  db.query<unknown, [number, number, number]>(
    `INSERT INTO note_settlement_segment_exclusions (job_id, turn_id, created_at_epoch)
     VALUES (?, ?, ?)
     ON CONFLICT (job_id, turn_id) DO NOTHING`,
  ).run(jobId, turnId, nowEpoch);
}

/** Bulk form of `recordNoteSettlementSegmentExclusion` for a batch verdict. */
export function recordNoteSettlementSegmentExclusions(
  db: Database,
  jobId: number,
  turnIds: readonly number[],
  nowEpoch: number,
): void {
  for (const turnId of turnIds) {
    recordNoteSettlementSegmentExclusion(db, jobId, turnId, nowEpoch);
  }
}

/** This job's excluded turn ids — a test/inspection helper, not on the hot path. */
export function listNoteSettlementSegmentExclusions(
  db: Database,
  jobId: number,
): number[] {
  return db
    .query<{ turnId: number }, [number]>(
      `SELECT turn_id AS turnId FROM note_settlement_segment_exclusions
       WHERE job_id = ? ORDER BY turn_id ASC`,
    )
    .all(jobId)
    .map((row) => row.turnId);
}

export interface NoteSettlementSegmentationGap {
  turnId: number;
  sessionId: number;
  promptNumber: number;
}

interface WindowTurnEligibilityRow {
  id: number;
  sessionId: number;
  promptNumber: number;
  type: string;
  userPrompt: string | null;
  status: string;
}

function getWindowTurnRows(
  db: Database,
  sessionId: number,
  windowStart: number,
  windowEnd: number,
): WindowTurnEligibilityRow[] {
  return db
    .query<WindowTurnEligibilityRow, [number, number, number]>(
      `SELECT id, session_id AS sessionId, prompt_number AS promptNumber,
              type, user_prompt AS userPrompt, status
       FROM turns
       WHERE session_id = ? AND prompt_number BETWEEN ? AND ?
       ORDER BY prompt_number ASC`,
    )
    .all(sessionId, windowStart, windowEnd);
}

function getWindowTurnIds(
  db: Database,
  sessionId: number,
  windowStart: number,
  windowEnd: number,
): number[] {
  return db
    .query<{ id: number }, [number, number, number]>(
      `SELECT id FROM turns WHERE session_id = ? AND prompt_number BETWEEN ? AND ?
       ORDER BY prompt_number ASC`,
    )
    .all(sessionId, windowStart, windowEnd)
    .map((row) => row.id);
}

/**
 * The anti-join itself (spec G7): every segmentation-eligible turn in the
 * frozen window must be a segment member, carry a no-segment exclusion FOR
 * THIS JOB, or already be `status = 'skipped'`. Eligibility is
 * `isEligibleCoverageTurn` (db/coverage.ts), reused rather than re-derived —
 * G7's "segmentation-eligible" turn is the same set G4 already defines as
 * coverage-eligible, and the spec's whole reason for factoring that predicate
 * out is that a second copy is the one that drifts loosest.
 *
 * A turn absent from BOTH `segment_members` and
 * `note_settlement_segment_exclusions` is a GAP, never a pass — there is no
 * branch here that reads a missing row as a positive verdict, in either
 * direction. That is also why crash-after-membership falls out for free
 * rather than needing its own case: membership written, the exclusion not
 * yet, leaves this turn absent from both sets, which is exactly a gap.
 */
export function computeNoteSettlementSegmentationGaps(
  db: Database,
  jobId: number,
  sessionId: number,
  windowStart: number,
  windowEnd: number,
): NoteSettlementSegmentationGap[] {
  const windowTurns = getWindowTurnRows(db, sessionId, windowStart, windowEnd);
  const eligible = windowTurns.filter((turn) =>
    isEligibleCoverageTurn({
      type: JSON.parse(turn.type) as string[],
      userPrompt: turn.userPrompt,
    }),
  );
  if (eligible.length === 0) {
    return [];
  }

  const turnIds = eligible.map((turn) => turn.id);
  const placeholders = turnIds.map(() => "?").join(", ");

  const memberIds = new Set(
    db
      .query<{ turnId: number }, number[]>(
        `SELECT DISTINCT turn_id AS turnId FROM segment_members
         WHERE turn_id IN (${placeholders})`,
      )
      .all(...turnIds)
      .map((row) => row.turnId),
  );
  // job-SCOPED (spec G7: "must not become a column on the turn"). This is the
  // one lookup in the whole predicate that is not just "does a row exist for
  // this turn" — it also has to be THIS job's row, so an exclusion some
  // OTHER job recorded over the same turn (a later repair job re-adjudicating
  // it, the case job-scoping exists to allow) never silently counts as this
  // job's verdict.
  const excludedIds = new Set(
    db
      .query<{ turnId: number }, [number, ...number[]]>(
        `SELECT turn_id AS turnId FROM note_settlement_segment_exclusions
         WHERE job_id = ? AND turn_id IN (${placeholders})`,
      )
      .all(jobId, ...turnIds)
      .map((row) => row.turnId),
  );

  return eligible
    .filter(
      (turn) =>
        turn.status !== "skipped" &&
        !memberIds.has(turn.id) &&
        !excludedIds.has(turn.id),
    )
    .map((turn) => ({
      turnId: turn.id,
      sessionId: turn.sessionId,
      promptNumber: turn.promptNumber,
    }));
}

export type NoteSettlementCompletionReason =
  | NoteSettlementJobFenceReason
  | "segmentation-incomplete"
  | "coverage-incomplete";

export interface NoteSettlementCompletionResult {
  completed: boolean;
  reason: NoteSettlementCompletionReason | null;
  /** Populated only when `reason === "segmentation-incomplete"`. */
  segmentationGaps: NoteSettlementSegmentationGap[];
  /** Populated only when `reason === "coverage-incomplete"`. */
  coverageGaps: CoverageGap[];
}

export interface CompleteNoteSettlementJobIfSegmentedOptions {
  maxAttempts?: number;
}

/**
 * The completion gate (spec G2/G7). See the module doc comment for why the
 * fence, the anti-join, the coverage recheck and the CAS all have to share
 * one transaction rather than being composed from separately-transacted
 * pieces.
 *
 * A refusal for ANY reason — lost ownership, a segmentation gap, a coverage
 * gap — leaves the job exactly as it was: `completeNoteSettlementJob`'s own
 * CAS is the only statement in this whole function that can move `status`,
 * and every early return above it skips straight past that statement. That
 * is what makes a retry re-adjudicate the remainder rather than the job
 * silently going `failed` or `pending` (spec G2: the completion gate trusts
 * nobody, and leaving the job claimed is what makes that trust-nobody stance
 * survive a retry rather than requiring one).
 */
export function completeNoteSettlementJobIfSegmented(
  db: Database,
  jobId: number,
  claimGeneration: number,
  nowEpoch: number,
  options: CompleteNoteSettlementJobIfSegmentedOptions = {},
): NoteSettlementCompletionResult {
  try {
    return runWriteTransaction(db, () => {
      const job = assertNoteSettlementJobClaimed(db, jobId, claimGeneration);

      const segmentationGaps = computeNoteSettlementSegmentationGaps(
        db,
        job.id,
        job.sessionId,
        job.windowStart,
        job.windowEnd,
      );
      if (segmentationGaps.length > 0) {
        return {
          completed: false,
          reason: "segmentation-incomplete" as const,
          segmentationGaps,
          coverageGaps: [],
        };
      }

      const windowTurnIds = getWindowTurnIds(
        db,
        job.sessionId,
        job.windowStart,
        job.windowEnd,
      );
      const coverageGaps = computeCoverageGaps(db, windowTurnIds);
      if (coverageGaps.length > 0) {
        return {
          completed: false,
          reason: "coverage-incomplete" as const,
          segmentationGaps: [],
          coverageGaps,
        };
      }

      // The CAS re-verifies `claim_generation` on its own, independently of
      // the fence check above — that redundancy is deliberate, not
      // belt-and-suspenders filler. The fence lets a caller that has already
      // lost its lease fail fast, cheaply, before paying for the anti-join
      // and coverage reads; the actual safety guarantee comes from THIS
      // statement re-checking generation at the instant of the write, inside
      // the same `BEGIN IMMEDIATE` block the reads above ran in, so nothing
      // else could have moved it in between on a real connection.
      const done = completeNoteSettlementJob(
        db,
        job.id,
        nowEpoch,
        claimGeneration,
      );
      if (!done) {
        return {
          completed: false,
          reason: "generation-mismatch" as const,
          segmentationGaps: [],
          coverageGaps: [],
        };
      }

      advanceNoteSettlementCursor(
        db,
        job.sessionId,
        nowEpoch,
        options.maxAttempts ?? NOTE_SETTLEMENT_MAX_ATTEMPTS,
      );

      return {
        completed: true,
        reason: null,
        segmentationGaps: [],
        coverageGaps: [],
      };
    });
  } catch (error) {
    if (error instanceof NoteSettlementJobFenceError) {
      return {
        completed: false,
        reason: error.fenceReason,
        segmentationGaps: [],
        coverageGaps: [],
      };
    }
    throw error;
  }
}
