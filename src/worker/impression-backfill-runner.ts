import type { Database } from "bun:sqlite";

import { runWriteTransaction } from "../db/database";
import {
  claimNextPendingImpressionBackfillJob,
  completeImpressionBackfillJob,
  enqueueImpressionBackfillJob,
  failImpressionBackfillJob,
  getImpressionBackfillJobForSegment,
  listImpressionBackfillJobs,
  requeueImpressionBackfillJob,
  type ImpressionBackfillJobRecord,
} from "../db/impressions";
import { sanitizeSecretString } from "../shared/error-sanitizer";

import {
  assembleBackfillInput,
  commitImpressionBackfill,
  ImpressionBackfillRefused,
  listTasksCarryingLegacyFields,
  type BackfillTaskInput,
  type BackfillUnresolvedClaim,
} from "./impression-backfill";

/**
 * THE MIGRATION JOB RUNNER (lane-impressions spec Rev 8, "Job lifecycle"):
 * durable pending/claimed/done/failed rows, bounded retry, idempotent re-claim,
 * and — the sentence that shapes this whole module — "A MODEL JOB CANNOT RUN
 * INSIDE A SCHEMA MIGRATION. IT RUNS ASYNCHRONOUSLY AFTER DEPLOYMENT."
 *
 * SO THE MODEL IS A SEAM, NOT AN IMPORT. `ImpressionBackfillGenerator` is
 * supplied by whoever drives the backfill; nothing in this file, or anything it
 * reaches, so much as names a model client. That is not tidiness — the worker
 * core is guarded by a substring scan over its own reachable imports
 * (tests/worker/server.note-settlement-triggers.test.ts), and settlement's own
 * model client had to cross a process boundary to satisfy it. A backfill driven
 * through this seam can be hosted in whatever process its driver chooses
 * without this module ever becoming the reason a bundle grows an SDK.
 *
 * IDEMPOTENT RE-CLAIM IS RE-READING, NOT RESUMING. Every attempt calls
 * `assembleBackfillInput` again, so a re-claimed job regenerates FROM SCRATCH
 * against the current fields, roster and index — there is no cached half-state
 * to resume, and the atomic output batch makes a half-migrated task impossible
 * in the first place.
 */

/**
 * How many times ONE job may generate before its failure stops being
 * repairable. Three, matching the settlement dispatch's own attempt cap and the
 * impression payload's regeneration budget — the same number this subsystem
 * already uses for "you have had your chances".
 *
 * The budget is spent on REGENERABLE refusals only (a moved source snapshot, a
 * malformed batch, an undeclared lane, an inadmissible anchor, a validator
 * rejection). An `unresolved` report and a lost row consume the whole budget at
 * once, because neither can be repaired by asking the same question again.
 */
export const IMPRESSION_BACKFILL_MAX_ATTEMPTS = 3;

/**
 * How long a `claimed` row may sit untouched before another runner may take it
 * back. A job is claimed inside this process and released — as `done` or
 * `failed` — in the same call, so the only way a row stays `claimed` is a
 * process that died holding it. Without this, such a row would be stranded
 * forever: `requeueImpressionBackfillJob` moves `failed` rows only, by design.
 *
 * Fifteen minutes: comfortably longer than any single generation, short enough
 * that a crashed run is not a permanent hole in the coverage.
 */
export const IMPRESSION_BACKFILL_CLAIM_LEASE_SECONDS = 15 * 60;

/**
 * The model call, as this module sees it: a prompt-shaped INPUT and the
 * previous refusal (if this is a regeneration) in, the writer's raw batch out.
 *
 * It returns `unknown` deliberately. Parsing and rejecting the batch is
 * `commitImpressionBackfill`'s job, inside the transaction, so a generator that
 * pre-validates cannot accidentally become a second, laxer validator.
 */
export type ImpressionBackfillGenerator = (request: {
  input: BackfillTaskInput;
  /** The previous attempt's refusal text, or `null` on the first attempt. */
  feedback: string | null;
  /** 1-based. */
  attempt: number;
}) => Promise<unknown>;

export interface RunImpressionBackfillOptions {
  generate: ImpressionBackfillGenerator;
  now?: () => number;
  /** Overridable for tests; production leaves it at `IMPRESSION_BACKFILL_MAX_ATTEMPTS`. */
  maxAttempts?: number;
  logger?: Pick<Console, "error">;
}

export type ImpressionBackfillJobResult =
  | { status: "done"; segmentId: number; jobId: number; seededLanes: number; batchBytes: number; attempts: number }
  | {
      status: "failed";
      segmentId: number;
      jobId: number;
      attempts: number;
      /** The operator-visible reason, exactly as stored in `last_error`. */
      error: string;
      /** Non-empty only when the refusal was `unresolved` — what could not be placed. */
      unresolved: readonly BackfillUnresolvedClaim[];
    };

// ---------------------------------------------------------------------------
// Enqueue — coverage, by query
// ---------------------------------------------------------------------------

export interface EnqueueImpressionBackfillResult {
  /** Every task the coverage query found, whether or not it already had a job row. */
  covered: number;
  /** Rows created by this call. */
  enqueued: number;
  jobs: ImpressionBackfillJobRecord[];
}

/**
 * ENQUEUE EVERY TASK CARRYING LEGACY FIELDS, open and closed alike, found by
 * `listTasksCarryingLegacyFields` — the one coverage predicate.
 *
 * NOT CALLED FROM `initializeSchema` OR ANY MIGRATION, and that is the point:
 * enqueueing is cheap and could live anywhere, but putting it beside the schema
 * would put the coverage decision on the process that opens the database — a
 * hook, usually — and the spec pins the whole job family to "after deployment".
 * This is an operator/driver entry point.
 *
 * Idempotent: `enqueueImpressionBackfillJob` returns the existing row untouched
 * whatever its state, so re-running never resets a `done` task and never
 * silently revives a `failed` one.
 */
export function enqueueImpressionBackfillJobsForLegacyTasks(
  db: Database,
  nowEpoch: number,
): EnqueueImpressionBackfillResult {
  const tasks = listTasksCarryingLegacyFields(db);
  const jobs: ImpressionBackfillJobRecord[] = [];
  let enqueued = 0;
  for (const task of tasks) {
    const existing = getImpressionBackfillJobForSegment(db, task.segmentId);
    const job = enqueueImpressionBackfillJob(db, task.segmentId, nowEpoch);
    if (existing === null) {
      enqueued += 1;
    }
    jobs.push(job);
  }
  return { covered: tasks.length, enqueued, jobs };
}

/**
 * Take back every job whose claim has outlived the lease — a runner that died
 * holding one. Returns the ids it requeued.
 *
 * `failImpressionBackfillJob` then `requeueImpressionBackfillJob`, in that
 * order, because both are `status`-fenced: `claimed -> failed -> pending` is the
 * only path the existing helpers admit, and going through `failed` also records
 * the reason and consumes a retry, which is exactly right — a crash is a failed
 * attempt, not a free one.
 */
export function requeueStaleImpressionBackfillClaims(
  db: Database,
  nowEpoch: number,
  leaseSeconds: number = IMPRESSION_BACKFILL_CLAIM_LEASE_SECONDS,
): number[] {
  const stale = listImpressionBackfillJobs(db, "claimed").filter(
    (job) => job.updatedAtEpoch <= nowEpoch - leaseSeconds,
  );
  const requeued: number[] = [];
  for (const job of stale) {
    const failed = failImpressionBackfillJob(
      db,
      job.id,
      nowEpoch,
      `claim expired after ${leaseSeconds}s — the runner holding it did not finish`,
    );
    if (failed && requeueImpressionBackfillJob(db, job.id, nowEpoch)) {
      requeued.push(job.id);
    }
  }
  return requeued;
}

// ---------------------------------------------------------------------------
// One job
// ---------------------------------------------------------------------------

/**
 * Run ONE already-claimed job to a terminal state. Async by construction — the
 * generator is awaited, and nothing here holds a transaction open across that
 * await: each attempt opens its own write transaction only to commit, so a slow
 * model never blocks another writer.
 */
export async function runClaimedImpressionBackfillJob(
  db: Database,
  job: ImpressionBackfillJobRecord,
  options: RunImpressionBackfillOptions,
): Promise<ImpressionBackfillJobResult> {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const maxAttempts = Math.max(1, options.maxAttempts ?? IMPRESSION_BACKFILL_MAX_ATTEMPTS);
  const logger = options.logger ?? console;

  let feedback: string | null = null;
  let unresolved: readonly BackfillUnresolvedClaim[] = [];
  let lastError = "the migration job produced no result";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    // RE-READ EVERY ATTEMPT. This is what "a re-claimed job re-reads and
    // regenerates" means, and it is also what makes a snapshot-fence refusal
    // self-healing: the next attempt's input carries the CURRENT fields and the
    // snapshot that matches them.
    const input = assembleBackfillInput(db, job.segmentId);
    if (input === null) {
      lastError = `E${job.segmentId} no longer exists`;
      break;
    }

    let rawBatch: unknown;
    try {
      rawBatch = await options.generate({ input, feedback, attempt });
    } catch (error) {
      // A THROWING GENERATOR IS A FAILED ATTEMPT, NOT A CRASHED RUNNER. The
      // job must not be left `claimed` because a model call timed out, so the
      // throw is caught here and spends one attempt like any other refusal.
      lastError = `generation failed: ${sanitizeSecretString(
        error instanceof Error ? error.message : String(error),
      )}`;
      feedback = lastError;
      continue;
    }

    try {
      const outcome = runWriteTransaction(db, () =>
        commitImpressionBackfill(db, {
          segmentId: job.segmentId,
          snapshot: input.snapshot,
          rawBatch,
          nowEpoch: now(),
        }),
      );
      if (!completeImpressionBackfillJob(db, job.id, now())) {
        // The row was not `claimed` any more — another runner took it back
        // under the stale-claim lease while this one was generating. The
        // cutover itself HAS landed and is atomic; saying so is more honest
        // than pretending the work did not happen.
        logger.error?.(
          `[claude-mnemo] impression backfill job ${job.id} (E${job.segmentId}) committed its ` +
            "cutover but was no longer claimed — its claim had been taken back",
        );
      }
      return {
        status: "done",
        segmentId: job.segmentId,
        jobId: job.id,
        seededLanes: outcome.seededLanes,
        batchBytes: outcome.batchBytes,
        attempts: attempt,
      };
    } catch (error) {
      if (!(error instanceof ImpressionBackfillRefused)) {
        throw error;
      }
      lastError = error.message;
      unresolved = error.unresolved;
      if (!error.regenerable) {
        // TERMINAL. `unresolved` waits on a human or a better mapping and a
        // lost row waits on nothing at all; asking the same question again
        // cannot repair either, so the budget is not spent pretending.
        break;
      }
      feedback = error.message;
    }
  }

  failImpressionBackfillJob(db, job.id, now(), lastError);
  logger.error?.(
    `[claude-mnemo] impression backfill job ${job.id} (E${job.segmentId}) failed: ${lastError}`,
  );
  return {
    status: "failed",
    segmentId: job.segmentId,
    jobId: job.id,
    attempts: maxAttempts,
    error: lastError,
    unresolved,
  };
}

/**
 * Claim and run pending jobs, oldest first, until `limit` is reached or nothing
 * is pending. One at a time on purpose: a migration is a background repair, not
 * a throughput problem, and serial claiming keeps a single failing generator
 * from burning every job's retry budget at once.
 */
export async function runImpressionBackfillJobs(
  db: Database,
  options: RunImpressionBackfillOptions & { limit?: number },
): Promise<ImpressionBackfillJobResult[]> {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  const results: ImpressionBackfillJobResult[] = [];
  while (results.length < limit) {
    const job = claimNextPendingImpressionBackfillJob(db, now());
    if (job === null) {
      break;
    }
    results.push(await runClaimedImpressionBackfillJob(db, job, options));
  }
  return results;
}
