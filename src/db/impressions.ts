import type { Database } from "bun:sqlite";

import type { ImpressionAnchorResolver } from "../shared/lane-impressions";
import {
  validateReferences,
  type ValidateReferencesOptions,
} from "./references";

/**
 * Typed access to the impression lifecycle-debt and backfill-job tables
 * (lane-impressions spec Rev 8, ticket 01 — schema.ts holds the tables and
 * their design comments). This module ships the KEY SEMANTICS only: the
 * writers that call these from remember operations and settlement runs are
 * tickets 02/03.
 */

// ---------------------------------------------------------------------------
// Stored impression rows — the LANE tier (ticket 02).
//
// The TASK tier's equivalents live in `db/segments.ts`
// (`readSegmentTaskImpression`/`replaceSegmentTaskImpression`), because its
// text is the segment's own `content` column and a write to it has to reindex
// FTS and reconcile the segment's citations through two helpers private to
// that module. Same shape, same fence, same origin mark on both sides.
// ---------------------------------------------------------------------------

export type ImpressionOrigin = "backfill" | "settlement";

/** One container's impression as stored — lane tier or task tier, same shape. */
export interface StoredImpression {
  /** NULL when nothing has been written yet (lane), or when `origin` is null (task: `content` is still legacy field text). */
  text: string | null;
  /** The CAS fence: what a writer must carry back as its `baseRevision`. */
  revision: number;
  origin: ImpressionOrigin | null;
  stale: boolean;
}

interface ImpressionRow {
  impression: string | null;
  revision: number;
  origin: ImpressionOrigin | null;
  stale: number;
}

function mapImpressionRow(row: ImpressionRow | null): StoredImpression | null {
  return row
    ? {
        text: row.impression,
        revision: row.revision,
        origin: row.origin,
        stale: row.stale === 1,
      }
    : null;
}

/** `null` iff no lane row exists for `(segmentId, tag)`. */
export function readLaneImpression(
  db: Database,
  segmentId: number,
  tag: string,
): StoredImpression | null {
  return mapImpressionRow(
    db
      .query<ImpressionRow, [number, string]>(
        `SELECT impression,
                impression_revision AS revision,
                impression_origin AS origin,
                impression_stale AS stale
           FROM lanes WHERE segment_id = ? AND tag = ?`,
      )
      .get(segmentId, tag) ?? null,
  );
}

export interface ReplaceLaneImpressionInput {
  segmentId: number;
  tag: string;
  /** The revision the writer READ — the whole point of the fence. */
  baseRevision: number;
  text: string;
  origin: ImpressionOrigin;
}

/**
 * The lane tier's whole-impression replacement, CAS-fenced on the revision the
 * writer read. FALSE means another writer moved the row (or the lane is gone)
 * — the caller's whole transaction must reject, never retry in place.
 *
 * A successful replacement CLEARS `impression_stale`: the spec's "the flag
 * clears only when a qualified run CAS-rewrites" is exactly this write, so the
 * clearing is a property of the update rather than a second call a caller
 * could forget.
 */
export function replaceLaneImpression(
  db: Database,
  input: ReplaceLaneImpressionInput,
): boolean {
  return (
    db
      .query<unknown, [string, string, number, string, number]>(
        `UPDATE lanes
            SET impression = ?,
                impression_revision = impression_revision + 1,
                impression_origin = ?,
                impression_stale = 0
          WHERE segment_id = ? AND tag = ? AND impression_revision = ?`,
      )
      .run(input.text, input.origin, input.segmentId, input.tag, input.baseRevision)
      .changes === 1
  );
}

/**
 * THE MERGE FAMILY'S STALE MARK (spec "Merge staleness", ticket 03): a lane
 * MERGE sets the SURVIVOR's flag in the merge's own transaction, because two
 * identities were fused and the stored prose no longer describes the result.
 * `false` means no such lane row (the caller's whole transaction should treat
 * that as the invariant break it is).
 *
 * IT BUMPS THE REVISION, and that is the load-bearing half. The spec's fence
 * fixture list demands that "a manual lifecycle write between a run's read and
 * commit likewise rejects" the whole commit — and an in-flight run that already
 * decided `replace` over the pre-merge text would otherwise sail through: the
 * terminal fence's STALE check only refuses a RETAIN. Moving the revision is
 * what makes the fused identity reach every decision, not just the lazy one.
 *
 * NO SECOND WRITE CLEARS IT: `replaceLaneImpression` above sets
 * `impression_stale = 0` as part of the replacement itself, so "only a
 * qualified CAS rewrite clears the flag" is a property of the update rather
 * than a call sequence a caller could get wrong.
 */
export function markLaneImpressionStale(
  db: Database,
  segmentId: number,
  tag: string,
): boolean {
  return (
    db
      .query<unknown, [number, string]>(
        `UPDATE lanes
            SET impression_stale = 1,
                impression_revision = impression_revision + 1
          WHERE segment_id = ? AND tag = ?`,
      )
      .run(segmentId, tag).changes === 1
  );
}

// ---------------------------------------------------------------------------
// Lifecycle debts.
// ---------------------------------------------------------------------------

export const IMPRESSION_DEBT_KINDS = [
  "declare",
  "rename",
  "merge",
  "task-merge",
  "task-retag",
] as const;

export type ImpressionDebtKind = (typeof IMPRESSION_DEBT_KINDS)[number];

export interface ImpressionDebtRecord {
  id: number;
  segmentId: number;
  /** NULL = a task-tier debt; non-null = the qualified lane's tag. */
  laneTag: string | null;
  kind: ImpressionDebtKind;
  createdAtEpoch: number;
  claimedAtEpoch: number | null;
  claimedByJobId: number | null;
  ackedAtEpoch: number | null;
}

const DEBT_COLUMNS = `
  id,
  segment_id AS segmentId,
  lane_tag AS laneTag,
  kind,
  created_at_epoch AS createdAtEpoch,
  claimed_at_epoch AS claimedAtEpoch,
  claimed_by_job_id AS claimedByJobId,
  acked_at_epoch AS ackedAtEpoch
`;

export interface InsertImpressionDebtInput {
  segmentId: number;
  /** null for a task-tier debt (task merge/retag). */
  laneTag: string | null;
  kind: ImpressionDebtKind;
  nowEpoch: number;
}

/**
 * One durable debt. The CALLER's transaction is the atomicity boundary — a
 * manual lifecycle operation inserts its debt in the SAME transaction as the
 * operation itself (spec: "atomically insert a debt in the same transaction"),
 * which is why this function opens none of its own.
 */
export function insertImpressionDebt(
  db: Database,
  input: InsertImpressionDebtInput,
): ImpressionDebtRecord {
  return db
    .query<ImpressionDebtRecord, [number, string | null, string, number]>(
      `INSERT INTO impression_debts (segment_id, lane_tag, kind, created_at_epoch)
       VALUES (?, ?, ?, ?)
       RETURNING ${DEBT_COLUMNS}`,
    )
    .get(input.segmentId, input.laneTag, input.kind, input.nowEpoch)!;
}

/** Every unacked debt of one task, oldest first (lane and task tier both). */
export function listOpenImpressionDebts(
  db: Database,
  segmentId: number,
): ImpressionDebtRecord[] {
  return db
    .query<ImpressionDebtRecord, [number]>(
      `SELECT ${DEBT_COLUMNS} FROM impression_debts
        WHERE segment_id = ? AND acked_at_epoch IS NULL
        ORDER BY id ASC`,
    )
    .all(segmentId);
}

/**
 * RENAME re-keys its debts to the new tag (spec "Lifecycle debts"). Only
 * UNACKED debts move: an acked row is an audit fact about work already done
 * under the old identity, and rewriting history is not what a rename means.
 * Claimed-but-unacked debts move too — the rename itself is a manual
 * lifecycle write, so any in-flight run holding the claim will fail its CAS
 * fence and re-read anyway. Returns the number of rows re-keyed.
 */
export function rekeyLaneImpressionDebts(
  db: Database,
  segmentId: number,
  fromTag: string,
  toTag: string,
): number {
  return db
    .query<unknown, [string, number, string]>(
      `UPDATE impression_debts SET lane_tag = ?
        WHERE segment_id = ? AND lane_tag = ? AND acked_at_epoch IS NULL`,
    )
    .run(toTag, segmentId, fromTag).changes;
}

/**
 * MERGE leaves only the survivor's key (spec "Lifecycle debts"): every unacked
 * debt keyed by a merged-away tag re-keys to the survivor, then exact
 * UNCLAIMED duplicates under the survivor key (same kind) collapse to the
 * earliest row — two identical open obligations are one obligation. A CLAIMED
 * duplicate is never collapsed: its claim is a live lease, and the merge (a
 * manual lifecycle write) already invalidates that run's CAS fence.
 * Returns `{ rekeyed, collapsed }`.
 */
export function collapseImpressionDebtsToSurvivor(
  db: Database,
  segmentId: number,
  sourceTags: readonly string[],
  survivorTag: string,
): { rekeyed: number; collapsed: number } {
  const tags = sourceTags.filter((tag) => tag !== survivorTag);
  if (tags.length === 0) {
    return { rekeyed: 0, collapsed: 0 };
  }
  const placeholders = tags.map(() => "?").join(",");
  const rekeyed = db
    .query<unknown, [string, number, ...string[]]>(
      `UPDATE impression_debts SET lane_tag = ?
        WHERE segment_id = ? AND lane_tag IN (${placeholders})
          AND acked_at_epoch IS NULL`,
    )
    .run(survivorTag, segmentId, ...tags).changes;
  const collapsed = db
    .query<unknown, [number, string, number, string]>(
      `DELETE FROM impression_debts
        WHERE segment_id = ? AND lane_tag = ?
          AND acked_at_epoch IS NULL AND claimed_by_job_id IS NULL
          AND id NOT IN (
            SELECT MIN(id) FROM impression_debts
             WHERE segment_id = ? AND lane_tag = ?
               AND acked_at_epoch IS NULL AND claimed_by_job_id IS NULL
             GROUP BY kind
          )`,
    )
    .run(segmentId, survivorTag, segmentId, survivorTag).changes;
  return { rekeyed, collapsed };
}

/**
 * THE TASK MERGE's own re-key (spec "Lifecycle debts": "a MERGE leaves only the
 * survivor's key"), applied one tier up — the survivor is a different SEGMENT.
 *
 * `impression_debts.segment_id` cascades on `segments` (schema.ts), so every
 * open debt of a task being folded away would die the instant `mergeSegments`
 * deletes its row — including the debts of lanes that SURVIVED the merge by
 * relocating onto the survivor's registry. Those obligations are not extinct;
 * their container simply moved. Called from inside `mergeSegments`, BEFORE the
 * source row is deleted, because that is the only moment at which the choice
 * between "moved" and "cascaded away" still exists.
 *
 * Unacked rows only, claimed ones included, for `rekeyLaneImpressionDebts`'s
 * reasons verbatim: an acked row is an audit fact about the old identity, and a
 * live claim belongs to a run whose CAS fence this same merge already broke.
 * Returns the number of rows moved.
 */
export function rekeyImpressionDebtsToSegment(
  db: Database,
  fromSegmentId: number,
  toSegmentId: number,
): number {
  return db
    .query<unknown, [number, number]>(
      `UPDATE impression_debts SET segment_id = ?
        WHERE segment_id = ? AND acked_at_epoch IS NULL`,
    )
    .run(toSegmentId, fromSegmentId).changes;
}

/**
 * Everything ONE run currently holds a lease on — the read half of the claim,
 * and the reason a run may ask for its claimed set more than once without the
 * set shrinking under it.
 *
 * `claimOpenImpressionDebtsForSegments` returns only what THAT call newly
 * claimed (its `WHERE claimed_by_job_id IS NULL` makes the second call over the
 * same rows return nothing), so a run that claimed at start and re-read at
 * commit would see an empty set and drop the debts out of its own touched set —
 * a payload that no longer matches its coverage. This reader answers the
 * durable question instead: what does job `jobId` owe right now.
 *
 * It is also what makes a RECLAIMED attempt inherit its predecessor's claims:
 * the lease is stamped with the JOB id, which survives a claim-generation bump.
 */
export function listClaimedImpressionDebtsForJob(
  db: Database,
  jobId: number,
): ImpressionDebtRecord[] {
  return db
    .query<ImpressionDebtRecord, [number]>(
      `SELECT ${DEBT_COLUMNS} FROM impression_debts
        WHERE claimed_by_job_id = ? AND acked_at_epoch IS NULL
        ORDER BY id ASC`,
    )
    .all(jobId);
}

/**
 * A settlement run CLAIMS the open, unclaimed debts of the tasks it is
 * attached to (attachment ELIGIBILITY is the caller's check — ticket 02 wires
 * it; this helper is the lease write). Returns the claimed records so the run
 * can fold them into its touched set.
 */
export function claimOpenImpressionDebtsForSegments(
  db: Database,
  segmentIds: readonly number[],
  jobId: number,
  nowEpoch: number,
): ImpressionDebtRecord[] {
  if (segmentIds.length === 0) {
    return [];
  }
  const placeholders = segmentIds.map(() => "?").join(",");
  return db
    .query<ImpressionDebtRecord, [number, number, ...number[]]>(
      `UPDATE impression_debts
          SET claimed_at_epoch = ?, claimed_by_job_id = ?
        WHERE segment_id IN (${placeholders})
          AND acked_at_epoch IS NULL AND claimed_by_job_id IS NULL
       RETURNING ${DEBT_COLUMNS}`,
    )
    .all(nowEpoch, jobId, ...segmentIds);
}

/** A failed run's claims release for retry (consumption is never read-and-delete). */
export function releaseImpressionDebtClaims(
  db: Database,
  jobId: number,
): number {
  return db
    .query<unknown, [number]>(
      `UPDATE impression_debts
          SET claimed_at_epoch = NULL, claimed_by_job_id = NULL
        WHERE claimed_by_job_id = ? AND acked_at_epoch IS NULL`,
    )
    .run(jobId).changes;
}

/**
 * The successful terminal commit ACKS the debts its run claimed — inside the
 * caller's terminal transaction. The claim stamp is kept on the acked row:
 * which run discharged the debt is the audit trail.
 */
export function ackClaimedImpressionDebts(
  db: Database,
  jobId: number,
  nowEpoch: number,
): number {
  return db
    .query<unknown, [number, number]>(
      `UPDATE impression_debts SET acked_at_epoch = ?
        WHERE claimed_by_job_id = ? AND acked_at_epoch IS NULL`,
    )
    .run(nowEpoch, jobId).changes;
}

// ---------------------------------------------------------------------------
// Backfill migration jobs.
// ---------------------------------------------------------------------------

export const IMPRESSION_BACKFILL_JOB_STATUSES = [
  "pending",
  "claimed",
  "done",
  "failed",
] as const;

export type ImpressionBackfillJobStatus =
  (typeof IMPRESSION_BACKFILL_JOB_STATUSES)[number];

export interface ImpressionBackfillJobRecord {
  id: number;
  segmentId: number;
  status: ImpressionBackfillJobStatus;
  retryCount: number;
  lastError: string | null;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

const JOB_COLUMNS = `
  id,
  segment_id AS segmentId,
  status,
  retry_count AS retryCount,
  last_error AS lastError,
  created_at_epoch AS createdAtEpoch,
  updated_at_epoch AS updatedAtEpoch
`;

/**
 * One job per task, idempotent: re-enqueueing a task that already has a row
 * returns the existing row untouched (whatever its state — a `done` task owes
 * no second backfill; a `failed` one is `requeueImpressionBackfillJob`'s
 * business, not a silent reset).
 */
export function enqueueImpressionBackfillJob(
  db: Database,
  segmentId: number,
  nowEpoch: number,
): ImpressionBackfillJobRecord {
  db.query<unknown, [number, number, number]>(
    `INSERT INTO impression_backfill_jobs (segment_id, created_at_epoch, updated_at_epoch)
     VALUES (?, ?, ?)
     ON CONFLICT(segment_id) DO NOTHING`,
  ).run(segmentId, nowEpoch, nowEpoch);
  return getImpressionBackfillJobForSegment(db, segmentId)!;
}

export function getImpressionBackfillJobForSegment(
  db: Database,
  segmentId: number,
): ImpressionBackfillJobRecord | null {
  return (
    db
      .query<ImpressionBackfillJobRecord, [number]>(
        `SELECT ${JOB_COLUMNS} FROM impression_backfill_jobs WHERE segment_id = ?`,
      )
      .get(segmentId) ?? null
  );
}

export function listImpressionBackfillJobs(
  db: Database,
  status?: ImpressionBackfillJobStatus,
): ImpressionBackfillJobRecord[] {
  if (status === undefined) {
    return db
      .query<ImpressionBackfillJobRecord, []>(
        `SELECT ${JOB_COLUMNS} FROM impression_backfill_jobs ORDER BY id ASC`,
      )
      .all();
  }
  return db
    .query<ImpressionBackfillJobRecord, [string]>(
      `SELECT ${JOB_COLUMNS} FROM impression_backfill_jobs
        WHERE status = ? ORDER BY id ASC`,
    )
    .all(status);
}

/** Lease the oldest pending job, or null when none is pending. */
export function claimNextPendingImpressionBackfillJob(
  db: Database,
  nowEpoch: number,
): ImpressionBackfillJobRecord | null {
  return (
    db
      .query<ImpressionBackfillJobRecord, [number]>(
        `UPDATE impression_backfill_jobs
            SET status = 'claimed', updated_at_epoch = ?
          WHERE id = (
            SELECT id FROM impression_backfill_jobs
             WHERE status = 'pending' ORDER BY id ASC LIMIT 1
          )
         RETURNING ${JOB_COLUMNS}`,
      )
      .get(nowEpoch) ?? null
  );
}

/** claimed → done. FALSE when the row was not claimed (a stale caller). */
export function completeImpressionBackfillJob(
  db: Database,
  jobId: number,
  nowEpoch: number,
): boolean {
  return (
    db
      .query<unknown, [number, number]>(
        `UPDATE impression_backfill_jobs
            SET status = 'done', last_error = NULL, updated_at_epoch = ?
          WHERE id = ? AND status = 'claimed'`,
      )
      .run(nowEpoch, jobId).changes === 1
  );
}

/**
 * claimed → failed, one retry consumed, the reason operator-visible. The
 * BOUND on retries is the runner's law (spec: bounded retry; the runner
 * decides when a failed job may requeue and when it stays failed for the
 * operator).
 */
export function failImpressionBackfillJob(
  db: Database,
  jobId: number,
  nowEpoch: number,
  error: string,
): boolean {
  return (
    db
      .query<unknown, [string, number, number]>(
        `UPDATE impression_backfill_jobs
            SET status = 'failed', retry_count = retry_count + 1,
                last_error = ?, updated_at_epoch = ?
          WHERE id = ? AND status = 'claimed'`,
      )
      .run(error, nowEpoch, jobId).changes === 1
  );
}

/** failed → pending for another attempt; retry bookkeeping is preserved. */
export function requeueImpressionBackfillJob(
  db: Database,
  jobId: number,
  nowEpoch: number,
): boolean {
  return (
    db
      .query<unknown, [number, number]>(
        `UPDATE impression_backfill_jobs
            SET status = 'pending', updated_at_epoch = ?
          WHERE id = ? AND status = 'failed'`,
      )
      .run(nowEpoch, jobId).changes === 1
  );
}

// ---------------------------------------------------------------------------
// Anchor resolvability.
// ---------------------------------------------------------------------------

/**
 * The validator's DB-backed anchor resolver — resolvability THROUGH the
 * existing citation validation (spec "Validator": `validateReferences`,
 * db/references.ts, is the one lookup that already answers "does
 * `S<n>/T<m>` name a turn" for every citation writer). Runs fine inside the
 * caller's transaction: it is a read.
 */
export function dbImpressionAnchorResolver(
  db: Database,
  options: ValidateReferencesOptions = {},
): ImpressionAnchorResolver {
  return (sessionId, promptNumber) =>
    validateReferences(
      db,
      [
        {
          kind: "turn",
          raw: `S${sessionId}/T${promptNumber}`,
          sessionId,
          promptNumber,
        },
      ],
      options,
    ).accepted.length === 1;
}
