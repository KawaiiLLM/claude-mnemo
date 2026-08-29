import type { Database } from "bun:sqlite";

import { runWriteTransaction } from "./database";
import {
  advanceNoteSettlementCursor,
  completeNoteSettlementJob,
  getNoteSettlementJob,
  NOTE_SETTLEMENT_MAX_ATTEMPTS,
  type NoteSettlementJob,
  type NoteSettlementStage,
} from "./note-settlement";

/**
 * The settlement completion gate (ticket 05, "settlement demolition" —
 * ownership-and-note-cadence spec's 所有权 section).
 *
 * BEFORE this ticket, completion was a four-way anti-join: a per-job
 * membership fact (segmentation-incomplete), a note-debt anti-join
 * (note-incomplete), a coverage anti-join (coverage-incomplete) and an
 * election seat-ceiling validator (election-ceiling-exceeded) all had to
 * clear before the CAS below could run. All four are GONE:
 *
 *   - segmentation-incomplete (and its table, `note_settlement_membership_activity`)
 *     went with the membership gate — settlement's `assign` action is dead,
 *     membership is no longer a completion condition, and `propose` (the one
 *     surviving membership verb) never gated completion even before this
 *     ticket;
 *   - note-incomplete went with duty 2 (note reconstruction) — settlement no
 *     longer writes turn prose at all, so there is no reconstruction gap left
 *     to anti-join against;
 *   - election-ceiling-exceeded went with duty 1 (election/grading) —
 *     settlement no longer assigns a tier or a grade, so there is no seat
 *     ceiling left to validate.
 *
 * What is left is the OWNERSHIP FENCE (spec G6/G7, unchanged by this ticket)
 * plus the completion CAS itself: an empty window — one where settlement
 * found nothing to correct — completes exactly as cleanly as a window where
 * it staged real work, because nothing in this gate distinguishes the two
 * any more. This is deliberately an EMPTY SHELL: ticket 08
 * (settlement-four-field-correction) is what re-populates it with a real
 * check for the four structured fields (type/tags/membership/edges) it
 * corrects under the edge spec's rubric — until then, "checked, nothing to
 * correct" and "checked nothing at all" are indistinguishable to this gate on
 * purpose, because neither is a fact settlement can currently produce.
 */

export type NoteSettlementJobFenceReason =
  | "not-claimed"
  | "generation-mismatch"
  /**
   * Staged settlement: the row is still claimed under this caller's own
   * generation, but it has moved to a different STAGE than the one the caller
   * is working. A stale stage-1 context asserting `topics` against a row that
   * has already transitioned to `edges` lands here — its generation is
   * perfectly valid, and the generation fence alone would wave it through to
   * write over stage 2's work.
   */
  | "stage-mismatch";

/**
 * Thrown by `assertNoteSettlementJobClaimed`. Exported as a typed class
 * (rather than a bare Error) so a caller that wraps this in a broader
 * try/catch — `completeNoteSettlementJobIfSegmented` below, and the
 * settlement write facades — can tell a lost lease apart from a genuine bug
 * without string-matching a message, the same reason `UnfilledGapError` and
 * `UnknownTurnAddressError` were typed back when the write-back still existed.
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
 * The ownership fence (spec G6): the job named by `jobId` must still be
 * `claimed` under exactly `claimGeneration`, or nothing downstream of this
 * call is allowed to run. Wired into every settlement write tool as the
 * FIRST statement of that tool's own write transaction, called with a job id
 * and claim generation the in-process server closure injects — never a value
 * the model supplies, per G6.
 *
 * Throws rather than returning a refusal object. A caller running this as
 * literally the first statement inside `runWriteTransaction`'s callback gets
 * the whole transaction rolled back for free on any thrown error, so nothing
 * executed AFTER this call in the same transaction can ever commit once the
 * lease has moved — that guarantee falls out of the throw rather than
 * needing to be re-implemented at every call site.
 *
 * `expectedStage` is the THIRD member of the ownership tuple `(job,
 * claimGeneration, stage)` (staged-settlement spec Rev 5). Optional, and
 * unchecked when omitted: a caller that predates staging, or one whose write
 * is legal on either pass, asks exactly the question it used to ask. A caller
 * that DOES name its stage gets the fence a generation cannot give it —
 * because the generation deliberately does not move at the transition, a
 * stale stage-1 context's generation stays valid forever and only the stage
 * tells it apart from the stage-2 context that replaced it.
 */
export function assertNoteSettlementJobClaimed(
  db: Database,
  jobId: number,
  claimGeneration: number,
  expectedStage?: NoteSettlementStage,
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
  if (expectedStage !== undefined && job.stage !== expectedStage) {
    throw new NoteSettlementJobFenceError(
      jobId,
      "stage-mismatch",
      `settlement job ${jobId}: stage ${expectedStage} is stale (current ${job.stage})`,
    );
  }
  return job;
}

export interface NoteSettlementCompletionResult {
  completed: boolean;
  /** Always fence-shaped now — see the module doc comment. `null` on success. */
  reason: NoteSettlementJobFenceReason | null;
}

export interface CompleteNoteSettlementJobIfSegmentedOptions {
  maxAttempts?: number;
}

/**
 * The completion gate's core (spec G7) — the fence and the CAS, as a plain
 * function with NO transaction of its own. Factored out so `commit`'s own
 * replay (worker/note-settlement-staging.ts) can run it as the LAST step of
 * the SAME transaction that lands a settlement run's staged writes (the gate
 * runs inside the commit transaction, under the fence) — nesting
 * `runWriteTransaction` inside another write transaction is not how
 * bun:sqlite's `.immediate()` composes, so the transaction boundary has to
 * live at the call site, not in here.
 *
 * `completeNoteSettlementJobIfSegmented` below wraps this in its OWN
 * transaction, unchanged, for every caller that is not already inside one.
 *
 * A refusal — lost ownership, or a generation mismatch caught at the CAS
 * itself — leaves the job exactly as it was: `completeNoteSettlementJob`'s
 * own CAS is the only statement in this whole function that can move
 * `status`, and the fence's own throw skips straight past it. That is what
 * makes a retry re-adjudicate the remainder rather than the job silently
 * going `failed` or `pending`.
 */
export function completeNoteSettlementJobIfSegmentedCore(
  db: Database,
  jobId: number,
  claimGeneration: number,
  nowEpoch: number,
  options: CompleteNoteSettlementJobIfSegmentedOptions = {},
): NoteSettlementCompletionResult {
  const job = assertNoteSettlementJobClaimed(db, jobId, claimGeneration);

  // The CAS re-verifies `claim_generation` on its own, independently of the
  // fence check above — that redundancy is deliberate, not belt-and-
  // suspenders filler. The fence lets a caller that has already lost its
  // lease fail fast, cheaply; the actual safety guarantee comes from THIS
  // statement re-checking generation at the instant of the write, inside the
  // same `BEGIN IMMEDIATE` block the fence ran in, so nothing else could have
  // moved it in between on a real connection.
  const done = completeNoteSettlementJob(db, jobId, nowEpoch, claimGeneration);
  if (!done) {
    return { completed: false, reason: "generation-mismatch" as const };
  }

  advanceNoteSettlementCursor(
    db,
    job.sessionId,
    nowEpoch,
    options.maxAttempts ?? NOTE_SETTLEMENT_MAX_ATTEMPTS,
  );

  return { completed: true, reason: null };
}

/**
 * `completeNoteSettlementJobIfSegmentedCore` wrapped in its own transaction,
 * for every caller that is not already inside one.
 */
export function completeNoteSettlementJobIfSegmented(
  db: Database,
  jobId: number,
  claimGeneration: number,
  nowEpoch: number,
  options: CompleteNoteSettlementJobIfSegmentedOptions = {},
): NoteSettlementCompletionResult {
  try {
    return runWriteTransaction(db, () =>
      completeNoteSettlementJobIfSegmentedCore(
        db,
        jobId,
        claimGeneration,
        nowEpoch,
        options,
      ),
    );
  } catch (error) {
    if (error instanceof NoteSettlementJobFenceError) {
      return { completed: false, reason: error.fenceReason };
    }
    throw error;
  }
}
