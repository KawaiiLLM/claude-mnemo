import type { Database } from "bun:sqlite";

import { runWriteTransaction } from "./database";

/**
 * Two-phase grading, persistence half (spec §A). Extraction assigns a
 * PROVISIONAL grade the moment a turn lands; task causality is retrospective, so
 * the grade only becomes trustworthy once the arc it belongs to has run its
 * course. Settlement is that second pass, and it is a durable work unit rather
 * than a side effect of extraction: a crashed or half-finished settle must be
 * resumable, must never publish a partial rewrite, and must never re-grade a
 * cohort that has drifted under it.
 *
 * Three invariants carry that:
 *
 *   - the cohort is FROZEN at enqueue (`frozen_member_ids`), so a turn that
 *     finalizes after the boundary was crossed joins the NEXT window, never this
 *     one — otherwise the same job would grade a different set on every retry;
 *   - at most one job per session is `claimed`, and jobs are claimed in
 *     ASCENDING boundary order, so commits are ordered by construction. A lease
 *     makes that recoverable rather than permanent, and `claim_generation` is
 *     what keeps it SAFE: the reclaimed row gets a new generation, and the
 *     displaced worker's completion CASes against the old one and matches
 *     nothing, so a slow attempt can never overwrite the attempt that replaced
 *     it;
 *   - the cursor advances ONLY inside the success transaction and only across
 *     CONSECUTIVE RESOLVED boundaries, so a gap left by a retryable failure
 *     holds the cursor back instead of stranding work behind a high-water mark.
 */

/** Extracted/skipped turns between two settlements (spec §A). */
export const SETTLEMENT_BOUNDARY_INTERVAL = 50;

/** Trailing window (in extracted/skipped turns) a settlement job re-reads. */
export const SETTLEMENT_WINDOW_TURNS = 100;

/**
 * A `claimed` job older than this is presumed dead (worker crash, hard exit)
 * and returns to `pending`. Ten minutes is comfortably longer than a settle
 * inference and short enough that a crash does not park a session's grading for
 * a whole working day.
 */
export const SETTLEMENT_LEASE_MS = 10 * 60 * 1000;

/** A job that has consumed this many attempts is terminal — never reclaimed. */
export const SETTLEMENT_MAX_ATTEMPTS = 3;

export type SettlementJobStatus = "pending" | "claimed" | "done" | "failed";

export interface SettlementJob {
  id: number;
  sessionId: number;
  /** Ordinal of the LAST extracted/skipped turn covered by this job. */
  boundary: number;
  /** DB turn ids frozen at enqueue, ascending by prompt order. */
  frozenMemberIds: number[];
  status: SettlementJobStatus;
  attempts: number;
  claimedAtEpoch: number | null;
  /**
   * Ownership fence, bumped on every successful claim. A worker carries the
   * generation it claimed under and CASes on it when it completes or fails the
   * job, so a stale lease owner writes nothing.
   */
  claimGeneration: number;
  changeSummary: string | null;
  lastError: string | null;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

interface SettlementJobRow {
  id: number;
  sessionId: number;
  boundary: number;
  frozenMemberIds: string;
  status: SettlementJobStatus;
  attempts: number;
  claimedAtEpoch: number | null;
  claimGeneration: number;
  changeSummary: string | null;
  lastError: string | null;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

/**
 * The column list every job read returns. `insertJob` and the claim UPDATE
 * repeat it as a RETURNING clause; all three must stay identical or a job read
 * one way loses a field it has the other way.
 */
const SETTLEMENT_JOB_COLUMNS = `
    id,
    session_id AS sessionId,
    boundary,
    frozen_member_ids AS frozenMemberIds,
    status,
    attempts,
    claimed_at_epoch AS claimedAtEpoch,
    claim_generation AS claimGeneration,
    change_summary AS changeSummary,
    last_error AS lastError,
    created_at_epoch AS createdAtEpoch,
    updated_at_epoch AS updatedAtEpoch`;

const SETTLEMENT_JOB_SELECT = `
  SELECT${SETTLEMENT_JOB_COLUMNS}
  FROM settlement_jobs
`;

function mapJobRow(row: SettlementJobRow | null): SettlementJob | null {
  if (!row) {
    return null;
  }
  let frozenMemberIds: number[] = [];
  try {
    const parsed = JSON.parse(row.frozenMemberIds) as unknown;
    if (Array.isArray(parsed)) {
      frozenMemberIds = parsed.filter(
        (value): value is number => Number.isSafeInteger(value) && value > 0,
      );
    }
  } catch {
    frozenMemberIds = [];
  }
  return { ...row, frozenMemberIds };
}

/**
 * Turns that count toward a boundary: the ones extraction has finished with.
 * `extracted` and `skipped` both count — a skipped turn is a decided turn, and
 * the calibration block denominators (spec §A) use the same population, so a
 * mismatch here would move the 15% evidence gate to a different trigger point.
 */
export function countSettlementTerminalTurns(
  db: Database,
  sessionId: number,
): number {
  return (
    db
      .query<{ count: number }, [number]>(
        `SELECT COUNT(*) AS count FROM turns
         WHERE session_id = ? AND status IN ('extracted', 'skipped')`,
      )
      .get(sessionId)?.count ?? 0
  );
}

/**
 * The frozen cohort for `boundary`: the trailing `windowTurns` extracted/skipped
 * turns ending at that ordinal. Boundary 150 with a 100-turn window covers
 * ordinals 51..150; boundary 50 covers 1..50 (a short window early on).
 */
export function listSettlementCohortIds(
  db: Database,
  sessionId: number,
  boundary: number,
  windowTurns: number = SETTLEMENT_WINDOW_TURNS,
): number[] {
  const offset = Math.max(0, boundary - windowTurns);
  const limit = Math.min(boundary, windowTurns);
  if (limit <= 0) {
    return [];
  }
  return db
    .query<{ id: number }, [number, number, number]>(
      `SELECT id FROM turns
       WHERE session_id = ? AND status IN ('extracted', 'skipped')
       ORDER BY prompt_number ASC, id ASC
       LIMIT ? OFFSET ?`,
    )
    .all(sessionId, limit, offset)
    .map((row) => row.id);
}

export function getSettlementCursor(db: Database, sessionId: number): number {
  return (
    db
      .query<{ boundary: number }, [number]>(
        `SELECT last_settled_boundary AS boundary FROM settlement_cursors
         WHERE session_id = ?`,
      )
      .get(sessionId)?.boundary ?? 0
  );
}

export function getSettlementJob(
  db: Database,
  jobId: number,
): SettlementJob | null {
  return mapJobRow(
    db
      .query<SettlementJobRow, [number]>(`${SETTLEMENT_JOB_SELECT} WHERE id = ?`)
      .get(jobId) ?? null,
  );
}

export function listSettlementJobs(
  db: Database,
  sessionId: number,
): SettlementJob[] {
  return db
    .query<SettlementJobRow, [number]>(
      `${SETTLEMENT_JOB_SELECT} WHERE session_id = ? ORDER BY boundary ASC`,
    )
    .all(sessionId)
    .map((row) => mapJobRow(row))
    .filter((job): job is SettlementJob => job !== null);
}

function insertJob(
  db: Database,
  sessionId: number,
  boundary: number,
  memberIds: number[],
  nowEpoch: number,
): SettlementJob | null {
  const inserted = db
    .query<SettlementJobRow, [number, number, string, number, number]>(
      `INSERT OR IGNORE INTO settlement_jobs (
         session_id, boundary, frozen_member_ids, status, attempts,
         created_at_epoch, updated_at_epoch
       ) VALUES (?, ?, ?, 'pending', 0, ?, ?)
       RETURNING${SETTLEMENT_JOB_COLUMNS}`,
    )
    .get(sessionId, boundary, JSON.stringify(memberIds), nowEpoch, nowEpoch);
  return mapJobRow(inserted ?? null);
}

export interface EnqueueSettlementOptions {
  interval?: number;
  windowTurns?: number;
}

/**
 * Enqueue every boundary the session has crossed but not yet enqueued.
 *
 * Extraction can jump several boundaries at once (a stalled batch that lands 100
 * turns in one flush, a backfill), so this ENUMERATES: crossing 49 → 151 with
 * K=50 produces jobs at 50, 100 and 150, each with its own frozen cohort. One
 * job for the newest boundary would silently drop two windows of grading.
 *
 * Idempotent through `UNIQUE(session_id, boundary)`: re-running after a partial
 * crash re-enqueues nothing, and an already-settled boundary is never revisited
 * because its row still exists.
 */
export function enqueueSettlementBoundaries(
  db: Database,
  sessionId: number,
  nowEpoch: number,
  options: EnqueueSettlementOptions = {},
): SettlementJob[] {
  const interval = options.interval ?? SETTLEMENT_BOUNDARY_INTERVAL;
  const windowTurns = options.windowTurns ?? SETTLEMENT_WINDOW_TURNS;
  if (interval <= 0) {
    return [];
  }

  return runWriteTransaction(db, () => {
    const terminalCount = countSettlementTerminalTurns(db, sessionId);
    if (terminalCount < interval) {
      return [];
    }
    const existing = new Set(
      db
        .query<{ boundary: number }, [number]>(
          "SELECT boundary FROM settlement_jobs WHERE session_id = ?",
        )
        .all(sessionId)
        .map((row) => row.boundary),
    );

    const created: SettlementJob[] = [];
    for (
      let boundary = interval;
      boundary <= terminalCount;
      boundary += interval
    ) {
      if (existing.has(boundary)) {
        continue;
      }
      const memberIds = listSettlementCohortIds(
        db,
        sessionId,
        boundary,
        windowTurns,
      );
      const job = insertJob(db, sessionId, boundary, memberIds, nowEpoch);
      if (job) {
        created.push(job);
      }
    }
    return created;
  });
}

/**
 * SessionEnd tail job (spec §A). A session that ends 30 turns past its last
 * settled boundary would otherwise never have those turns re-graded, because no
 * further extraction is coming to cross the next boundary.
 *
 * Two conditions, both required:
 *   - `hadActivity` — the PRE-repair activity snapshot taken by the SessionEnd
 *     handler. A bare resume glance writes no turns, and settling on it would
 *     spend an inference re-grading a window nothing changed in;
 *   - terminal count strictly above the last SUCCESSFULLY settled boundary —
 *     the cursor, not the highest enqueued boundary, so a failed job's window
 *     still gets a tail attempt.
 *
 * The job shares the `UNIQUE(session_id, boundary)` identity, so a tail landing
 * exactly on a K-multiple collapses into the ordinary job for that boundary.
 */
export function enqueueSessionEndSettlementJob(
  db: Database,
  sessionId: number,
  nowEpoch: number,
  hadActivity: boolean,
  options: EnqueueSettlementOptions = {},
): SettlementJob | null {
  if (!hadActivity) {
    return null;
  }
  const windowTurns = options.windowTurns ?? SETTLEMENT_WINDOW_TURNS;

  return runWriteTransaction(db, () => {
    const terminalCount = countSettlementTerminalTurns(db, sessionId);
    if (terminalCount <= 0) {
      return null;
    }
    if (terminalCount <= getSettlementCursor(db, sessionId)) {
      return null;
    }
    const memberIds = listSettlementCohortIds(
      db,
      sessionId,
      terminalCount,
      windowTurns,
    );
    return insertJob(db, sessionId, terminalCount, memberIds, nowEpoch);
  });
}

export interface ClaimSettlementJobOptions {
  /** Jobs already attempted in this pass; skipped so one pass burns one attempt. */
  excludeJobIds?: ReadonlySet<number>;
  leaseMs?: number;
  maxAttempts?: number;
}

/** A lease that expired with no attempts left; the row's terminal audit line. */
const LEASE_EXHAUSTED_ERROR =
  "settle lease expired with no attempts left (worker never reported back)";

/**
 * Claim this session's next settlement job, ascending by boundary.
 *
 * Reclamation runs first and is what makes a crash recoverable: a `claimed` row
 * whose lease expired, and a `failed` row with attempts left, both return to
 * `pending`. Attempts are consumed AT CLAIM, not at failure — a worker that dies
 * between claim and commit has still spent one, which is what bounds a crash
 * loop at three rather than forever. That bound only holds if reclamation
 * RESPECTS it: an expired lease already at `maxAttempts` goes durably to
 * `failed` instead of back to `pending`, or the third crash would be reclaimed
 * as a fourth attempt and the cap would mean nothing.
 *
 * Every successful claim bumps `claim_generation`. The returned job carries that
 * generation, and completion/failure CAS on it, so the worker this reclaim just
 * displaced cannot commit over the worker that replaced it.
 *
 * Returns null when another job of this session is still validly claimed: one
 * in-flight settle per session is what makes commit order match boundary order.
 */
export function claimNextSettlementJob(
  db: Database,
  sessionId: number,
  nowEpoch: number,
  nowMs: number,
  options: ClaimSettlementJobOptions = {},
): SettlementJob | null {
  const leaseMs = options.leaseMs ?? SETTLEMENT_LEASE_MS;
  const maxAttempts = options.maxAttempts ?? SETTLEMENT_MAX_ATTEMPTS;
  const leaseCutoffEpoch = Math.floor((nowMs - leaseMs) / 1000);
  const excluded = options.excludeJobIds ?? new Set<number>();

  return runWriteTransaction(db, () => {
    // An expired lease with attempts exhausted is a DEAD job, not a retryable
    // one: it burned all three and the last worker never came back to say why.
    // Recording that as terminal `failed` keeps `attempts` at the cap and gives
    // the audit trail a reason instead of a silent fourth claim.
    db.query<unknown, [string, number, number, number, number]>(
      `UPDATE settlement_jobs
       SET status = 'failed',
           claimed_at_epoch = NULL,
           last_error = COALESCE(last_error, ?),
           updated_at_epoch = ?
       WHERE session_id = ?
         AND status = 'claimed'
         AND (claimed_at_epoch IS NULL OR claimed_at_epoch <= ?)
         AND attempts >= ?`,
    ).run(
      LEASE_EXHAUSTED_ERROR,
      nowEpoch,
      sessionId,
      leaseCutoffEpoch,
      maxAttempts,
    );

    db.query<unknown, [number, number, number, number]>(
      `UPDATE settlement_jobs
       SET status = 'pending', claimed_at_epoch = NULL, updated_at_epoch = ?
       WHERE session_id = ?
         AND status = 'claimed'
         AND (claimed_at_epoch IS NULL OR claimed_at_epoch <= ?)
         AND attempts < ?`,
    ).run(nowEpoch, sessionId, leaseCutoffEpoch, maxAttempts);

    db.query<unknown, [number, number, number]>(
      `UPDATE settlement_jobs
       SET status = 'pending', claimed_at_epoch = NULL, updated_at_epoch = ?
       WHERE session_id = ? AND status = 'failed' AND attempts < ?`,
    ).run(nowEpoch, sessionId, maxAttempts);

    const stillClaimed = db
      .query<{ id: number }, [number]>(
        `SELECT id FROM settlement_jobs
         WHERE session_id = ? AND status = 'claimed' LIMIT 1`,
      )
      .get(sessionId);
    if (stillClaimed) {
      return null;
    }

    const excludedIds = [...excluded];
    const exclusionClause =
      excludedIds.length > 0
        ? ` AND id NOT IN (${excludedIds.map(() => "?").join(", ")})`
        : "";
    // `attempts < ?` is redundant with the transitions above (every path into
    // `pending` already checks it) and kept as the invariant's last line: a row
    // that somehow reached `pending` exhausted is skipped, not over-claimed.
    const candidate = db
      .query<{ id: number }, number[]>(
        `SELECT id FROM settlement_jobs
         WHERE session_id = ? AND status = 'pending' AND attempts < ?${exclusionClause}
         ORDER BY boundary ASC
         LIMIT 1`,
      )
      .get(sessionId, maxAttempts, ...excludedIds);
    if (!candidate) {
      return null;
    }

    const claimed = db
      .query<SettlementJobRow, [number, number, number]>(
        `UPDATE settlement_jobs
         SET status = 'claimed',
             attempts = attempts + 1,
             claim_generation = claim_generation + 1,
             claimed_at_epoch = ?,
             updated_at_epoch = ?
         WHERE id = ? AND status = 'pending'
         RETURNING${SETTLEMENT_JOB_COLUMNS}`,
      )
      .get(nowEpoch, nowEpoch, candidate.id);

    return mapJobRow(claimed ?? null);
  });
}

/**
 * Whole-batch rejection (spec §A): one malformed element fails the JOB, never
 * half of its turns. `attempts` is untouched here because the claim already
 * consumed it.
 *
 * Fenced on `claimGeneration`: a worker whose lease expired and whose row has
 * since been reclaimed must not fail the job out from under its new owner. A
 * fenced-out call writes nothing and returns null.
 */
export function failSettlementJob(
  db: Database,
  jobId: number,
  reason: string,
  nowEpoch: number,
  claimGeneration: number,
): SettlementJob | null {
  return runWriteTransaction(db, () => {
    const result = db
      .query<unknown, [string, number, number, number]>(
        `UPDATE settlement_jobs
         SET status = 'failed', claimed_at_epoch = NULL, last_error = ?,
             updated_at_epoch = ?
         WHERE id = ? AND claim_generation = ?`,
      )
      .run(reason.slice(0, 500), nowEpoch, jobId, claimGeneration);
    if (result.changes === 0) {
      return null;
    }
    return getSettlementJob(db, jobId);
  });
}

/**
 * The cursor is the highest boundary such that every enqueued boundary at or
 * below it is RESOLVED — not the highest done boundary. Boundary 100 finishing
 * before 50 must not advance past 50's still-open window, or 50's turns would
 * be permanently unsettled with nothing recording that.
 *
 * "Resolved" is deliberately wider than "succeeded": a `done` row OR a job that
 * burned all `maxAttempts` and is terminally `failed`. A terminal failure is a
 * durable disposition, and holding the cursor at it forever would wedge the
 * session's entire settlement behind one bad window — the same permanent
 * pipeline deadlock the diary's three-strike tombstone produced before it grew
 * a supersede path. Abandon and advance instead: later windows then grade
 * against an earlier half that stayed provisional, which is no worse than the
 * provisional grades settlement exists to replace, and the `failed` row with
 * `attempts = 3` and its `last_error` stays as the audit trail of the gap.
 *
 * Monotonic by construction: it never moves backwards even if a later job row
 * is somehow re-opened.
 */
export function advanceSettlementCursor(
  db: Database,
  sessionId: number,
  nowEpoch: number,
  maxAttempts: number = SETTLEMENT_MAX_ATTEMPTS,
): number {
  const rows = db
    .query<
      { boundary: number; status: SettlementJobStatus; attempts: number },
      [number]
    >(
      `SELECT boundary, status, attempts FROM settlement_jobs
       WHERE session_id = ? ORDER BY boundary ASC`,
    )
    .all(sessionId);

  let consecutive = 0;
  for (const row of rows) {
    const resolved =
      row.status === "done" ||
      (row.status === "failed" && row.attempts >= maxAttempts);
    if (!resolved) {
      break;
    }
    consecutive = row.boundary;
  }

  const current = getSettlementCursor(db, sessionId);
  const next = Math.max(current, consecutive);
  if (next !== current || rows.length === 0) {
    db.query<unknown, [number, number, number]>(
      `INSERT INTO settlement_cursors (session_id, last_settled_boundary, updated_at_epoch)
       VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         last_settled_boundary = excluded.last_settled_boundary,
         updated_at_epoch = excluded.updated_at_epoch`,
    ).run(sessionId, next, nowEpoch);
  }
  return next;
}

/**
 * Marks the job done. Called INSIDE the success transaction and before the
 * cursor advance, because the cursor is computed from job statuses: this row
 * must already read `done` for its own boundary to be consecutive.
 *
 * Returns false when the CAS on `claimGeneration` matches nothing — the lease
 * expired and someone else owns the row now. The caller must ROLL THE WHOLE
 * TRANSACTION BACK on false: this is the one point where a displaced worker is
 * detected, and everything it wrote before reaching here (grades, role tags)
 * belongs to a judgment the current owner never agreed to.
 */
export function markSettlementJobDone(
  db: Database,
  jobId: number,
  nowEpoch: number,
  claimGeneration: number,
): boolean {
  const result = db
    .query<unknown, [number, number, number]>(
      `UPDATE settlement_jobs
       SET status = 'done', claimed_at_epoch = NULL, last_error = NULL,
           updated_at_epoch = ?
       WHERE id = ? AND claim_generation = ?`,
    )
    .run(nowEpoch, jobId, claimGeneration);
  return result.changes > 0;
}

/** Stamps the job's old→new audit trail. Same transaction as the grade writes. */
export function recordSettlementChangeSummary(
  db: Database,
  jobId: number,
  changeSummary: string,
  nowEpoch: number,
): void {
  db.query<unknown, [string, number, number]>(
    `UPDATE settlement_jobs
     SET change_summary = ?, updated_at_epoch = ?
     WHERE id = ?`,
  ).run(changeSummary, nowEpoch, jobId);
}
