/**
 * STRUCTURAL INVALIDATION — ONE OPERATION (`.scratch/main-agent-edges/spec.md`
 * D9, "Concurrency with settlement"; peer findings R9-7 and R10-9).
 *
 * A lane or membership verb that makes an incident side `ambiguous` has two
 * possible answers, and which one is right depends on whether anybody is still
 * in a position to declare the side:
 *
 *   - a SETTLEMENT RUN whose scope covers the citing turn is exactly that
 *     somebody. Its stage 2 declares ambiguous sides for a living. So the edge
 *     is KEPT and the run is INVALIDATED — sent back to stage 1 so it re-judges
 *     a graph that moved under it, rather than committing shape numbers that
 *     describe a partition that no longer exists;
 *   - with NO live run, there is nobody to ask, and the spec's own answer
 *     (T2421) is subtraction: `normalizeIncidentAttribution` deletes the edge
 *     and receipts it.
 *
 * This module is the first half. It is deliberately NOT a scheduler call and
 * not a queue write: invalidation is a state reset on the job ROW plus the
 * deletion of everything stage 1 froze, so the next claim starts from the
 * window and derives a fresh judgment.
 *
 * ## Which rows are eligible, in the REAL vocabulary (R9-7)
 *
 * `pending | claimed | done | failed | abandoned`, with the stage a SEPARATE
 * column. Three of the five are invalidated:
 *
 *   - `pending` — not yet claimed, but it may be a job that kept `stage='edges'`
 *     and its snapshots through a lease loss (`db/note-settlement.ts`'s reclaim
 *     paths preserve the stage on purpose, which is right for an ordinary
 *     reclaim and exactly wrong here). Reset, or it resumes stage 2 against a
 *     frozen scope the graph has left behind.
 *   - `claimed` — in flight. The generation bump IS the cancellation: every
 *     write the running dispatch attempts is fenced on `(job, generation)`, and
 *     the claim monitor both dispatch shapes now arm re-reads the row and kills
 *     the child.
 *   - `failed` — RETRYABLE (R10-9): the backoff-elapsed branch of
 *     `claimNextNoteSettlementJob` returns it to `pending` untouched, so a
 *     failed row is a run that has not happened yet, not one that will never
 *     happen.
 *
 * `done` and `abandoned` are UNTOUCHED. Both are terminal — nothing will ever
 * claim them again, so a reset would produce a job that reruns a published
 * window. For those the caller's own `onAmbiguous` falls through to the DELETE
 * and its receipt, which is the same subtraction the cutover performs.
 *
 * ## What "overlap" means, and why a fourth scope had to be persisted
 *
 * A job's reach over turns is answered by four durable sources, and until this
 * ticket only three existed:
 *
 *   1. its WINDOW — `(session_id, window_start..window_end)` on the job row;
 *   2. its frozen WRITABLE set — `note_settlement_writable_turns`, written by
 *      the stage-1 transition;
 *   3. its frozen LANE MEMBERS — `note_settlement_lane_members`, the vertices
 *      stage 2's shape numbers are computed over;
 *   4. its CLAIM-TIME scope — `note_settlement_claim_scope`, NEW here.
 *
 * (2) and (3) exist only AFTER the transition. A job still on stage `topics`
 * carries a writable set that is computed live inside the dispatch and held in
 * that process (`note-settlement-sdk-query.ts`'s request, R10-7's own finding),
 * so an unrelated process running a lane verb could not see it and would delete
 * an edge a live topic pass was about to lane. `persistNoteSettlementClaimScope`
 * writes that set down at claim time, before the model exists, which is the one
 * moment it is both known and stable.
 *
 * ## Runs in the CALLER'S transaction
 *
 * Every statement below is unconditional SQL and this function opens no
 * transaction of its own — it is called from inside a lane verb's
 * `runWriteTransaction`, and the reset has to land or roll back together with
 * the attribution change that caused it.
 */

import type { Database } from "bun:sqlite";

import { relationClassBearingSql } from "../shared/relation-class";
import { liveTurnSql } from "./turn-liveness";

const CLAIM_SCOPE_DDL = `
  CREATE TABLE IF NOT EXISTS note_settlement_claim_scope (
    job_id INTEGER NOT NULL REFERENCES note_settlement_jobs(id) ON DELETE CASCADE,
    turn_id INTEGER NOT NULL,
    PRIMARY KEY (job_id, turn_id)
  );
`;

const CLAIM_SCOPE_INDEX_DDL = `
  CREATE INDEX IF NOT EXISTS idx_note_settlement_claim_scope_turn
    ON note_settlement_claim_scope(turn_id);
`;

const CLAIM_SCOPE_READY = new WeakSet<Database>();

/** `turn_id` carries no foreign key for the same reason the transition snapshots' does not: this is a frozen record of what a claim covered, not a live pointer. Cleanup rides the `job_id` cascade. */
export function ensureNoteSettlementClaimScopeTable(db: Database): void {
  if (CLAIM_SCOPE_READY.has(db)) {
    return;
  }
  if (!hasTable(db, "note_settlement_jobs")) {
    // Not memoized: a database whose schema has not been initialized yet must
    // pick this up on a later call rather than being latched as done forever.
    return;
  }
  db.exec(CLAIM_SCOPE_DDL);
  db.exec(CLAIM_SCOPE_INDEX_DDL);
  CLAIM_SCOPE_READY.add(db);
}

/**
 * Write down what this claim may reach, replacing whatever the previous claim
 * of the same job recorded.
 *
 * Called by BOTH dispatch shapes the instant `writableTurnIds` is resolved —
 * before the prompt is rendered and before the model exists — so the value
 * recorded is the same immutable set the range check, the commit gate and the
 * prompt's declaration all read.
 */
export function persistNoteSettlementClaimScope(
  db: Database,
  jobId: number,
  turnIds: Iterable<number>,
): void {
  ensureNoteSettlementClaimScopeTable(db);
  if (!hasTable(db, "note_settlement_claim_scope")) {
    return;
  }
  db.query<unknown, [number]>(
    `DELETE FROM note_settlement_claim_scope WHERE job_id = ?`,
  ).run(jobId);
  const insert = db.query<unknown, [number, number]>(
    `INSERT OR IGNORE INTO note_settlement_claim_scope (job_id, turn_id) VALUES (?, ?)`,
  );
  for (const turnId of turnIds) {
    insert.run(jobId, turnId);
  }
}

/** The ids one claim recorded, ascending. `[]` for a job that never ran under a dispatch that persists one. */
export function readNoteSettlementClaimScope(db: Database, jobId: number): number[] {
  ensureNoteSettlementClaimScopeTable(db);
  if (!hasTable(db, "note_settlement_claim_scope")) {
    return [];
  }
  return db
    .query<{ turnId: number }, [number]>(
      `SELECT turn_id AS turnId FROM note_settlement_claim_scope
        WHERE job_id = ? ORDER BY turn_id ASC`,
    )
    .all(jobId)
    .map((row) => row.turnId);
}

export interface InvalidateOverlappingSettlementJobsOptions {
  nowEpoch: number;
  /**
   * The job DOING the structural write, exempted from its own invalidation.
   *
   * Settlement's own stage-1 tag projection is an attribution-changing verb
   * like any other, and it runs through the same seam; without this a run
   * would reset itself the first time its own projection made a side
   * ambiguous. Its answer to an ambiguous side is stage 2, not a restart —
   * which is precisely what the derived-side closure exists to arrange.
   */
  excludeJobId?: number;
}

export interface InvalidatedSettlementJob {
  jobId: number;
  /** The status the row held before the reset — `pending`, `claimed` or `failed`. */
  previousStatus: string;
  /** The stage it held before the reset. `edges` is the case the reset exists for. */
  previousStage: string;
  /** The generation AFTER the bump: the value a running dispatch's fence will now fail against. */
  claimGeneration: number;
}

/**
 * Invalidate every live settlement job whose scope reaches the affected turns.
 *
 * `turnIds` may be either the endpoints a verb moved or the citers whose rows
 * it invalidated: this function expands the set to "the ids given, plus the
 * CITING turn of every class-bearing turn→turn row incident to them", so both
 * calling conventions answer the same question. That expansion is the spec's
 * own "overlap defined through affected incident citers" (R10-9).
 *
 * Returns one entry per job actually reset — empty means nobody is in a
 * position to declare, which is what tells `normalizeIncidentAttribution` to
 * fall through to the deletion.
 */
export function invalidateOverlappingSettlementJobs(
  db: Database,
  turnIds: readonly number[],
  options: InvalidateOverlappingSettlementJobsOptions,
): InvalidatedSettlementJob[] {
  if (!hasTable(db, "note_settlement_jobs")) {
    return [];
  }
  const affected = expandToIncidentCiters(db, turnIds);
  if (affected.length === 0) {
    return [];
  }

  const candidates = new Set<number>();
  const placeholders = affected.map(() => "?").join(",");

  // 1. THE WINDOW, off the job row itself — the only scope a job has before it
  // is ever claimed.
  for (const row of db
    .query<{ id: number }, number[]>(
      `SELECT DISTINCT j.id AS id
         FROM note_settlement_jobs j
         JOIN turns t ON t.session_id = j.session_id
        WHERE t.id IN (${placeholders})
          AND t.prompt_number BETWEEN j.window_start AND j.window_end`,
    )
    .all(...affected)) {
    candidates.add(row.id);
  }

  // 2/3/4. The three turn-id ledgers, each present only once its own writer has
  // run. A missing table is a database that never reached that writer, never an
  // error.
  for (const [table, column] of [
    ["note_settlement_writable_turns", "turn_id"],
    ["note_settlement_lane_members", "turn_id"],
    ["note_settlement_claim_scope", "turn_id"],
  ] as const) {
    if (!hasTable(db, table)) {
      continue;
    }
    for (const row of db
      .query<{ id: number }, number[]>(
        `SELECT DISTINCT job_id AS id FROM ${table} WHERE ${column} IN (${placeholders})`,
      )
      .all(...affected)) {
      candidates.add(row.id);
    }
  }

  if (options.excludeJobId !== undefined) {
    candidates.delete(options.excludeJobId);
  }
  if (candidates.size === 0) {
    return [];
  }

  const hasStageColumns = hasColumn(db, "note_settlement_jobs", "stage");
  const readJob = db.query<
    { id: number; status: string; stage: string | null; claimGeneration: number },
    [number]
  >(
    `SELECT id, status, ${hasStageColumns ? "stage" : "NULL AS stage"} AS stage,
            claim_generation AS claimGeneration
       FROM note_settlement_jobs WHERE id = ?`,
  );
  // `stage`, `transition_seq` and `stage1_metrics` are added additively by
  // `ensureNoteSettlementStageSchema`; a database that has not reached it holds
  // no staged job at all, so the status/generation half of the reset is the
  // whole of it there.
  const resetStatement = db.query<unknown, [number, number]>(
    `UPDATE note_settlement_jobs
        SET status = 'pending',
            claimed_at_epoch = NULL,
            claim_generation = claim_generation + 1,
            ${hasStageColumns ? "stage = 'topics', transition_seq = NULL, stage1_metrics = NULL," : ""}
            updated_at_epoch = ?
      WHERE id = ?
        AND status IN ('pending', 'claimed', 'failed')`,
  );

  const invalidated: InvalidatedSettlementJob[] = [];
  for (const jobId of [...candidates].sort((a, b) => a - b)) {
    const job = readJob.get(jobId);
    if (
      !job ||
      (job.status !== "pending" && job.status !== "claimed" && job.status !== "failed")
    ) {
      // `done` and `abandoned` are terminal — see the module header.
      continue;
    }
    if (resetStatement.run(options.nowEpoch, jobId).changes === 0) {
      continue;
    }
    clearSettlementJobTransitionScratch(db, jobId);
    invalidated.push({
      jobId,
      previousStatus: job.status,
      previousStage: job.stage ?? "topics",
      claimGeneration: job.claimGeneration + 1,
    });
  }
  return invalidated;
}

/**
 * Everything a stage-1 transition froze for one job, deleted.
 *
 * The list is the spec's own (D9) plus R10-9's two additions: the three
 * transition snapshots and the removed-side debt list that travels with the
 * worklist; the PRE-resolution scratch the derived closure reads; the homeless
 * groups (their members and supersessions cascade) and the retraction audits;
 * and the impression-debt LEASE, released rather than deleted because the debt
 * itself belongs to the lane, not to the run.
 *
 * The CLAIM SCOPE is deliberately NOT cleared: it is the last durable record of
 * what this job reaches, and it is what lets a second structural verb, arriving
 * between this reset and the next claim, find this job at all.
 */
export function clearSettlementJobTransitionScratch(db: Database, jobId: number): void {
  for (const table of [
    "note_settlement_writable_turns",
    "note_settlement_worklist",
    "note_settlement_removed_side_debts",
    "note_settlement_lane_members",
    "note_settlement_pre_side_resolutions",
    "homeless_retraction_audits",
    "homeless_groups",
  ]) {
    if (!hasTable(db, table)) {
      continue;
    }
    db.query<unknown, [number]>(`DELETE FROM ${table} WHERE job_id = ?`).run(jobId);
  }
  if (hasTable(db, "impression_debts")) {
    db.query<unknown, [number]>(
      `UPDATE impression_debts
          SET claimed_at_epoch = NULL, claimed_by_job_id = NULL
        WHERE claimed_by_job_id = ? AND acked_at_epoch IS NULL`,
    ).run(jobId);
  }
}

/**
 * The ids given, plus the CITING turn of every live class-bearing turn→turn row
 * incident to one of them.
 *
 * Same boundaries as the removed-side closure's own enumeration: turn→turn
 * rows, live on both ends, carrying a class. A bare prose row has no attribution
 * to invalidate and a dead endpoint is not a node.
 */
function expandToIncidentCiters(db: Database, turnIds: readonly number[]): number[] {
  const ids = [...new Set(turnIds)].filter((id) => Number.isInteger(id));
  if (ids.length === 0) {
    return [];
  }
  if (!hasTable(db, "memory_edges")) {
    return ids.sort((a, b) => a - b);
  }
  const placeholders = ids.map(() => "?").join(",");
  const affected = new Set(ids);
  for (const row of db
    .query<{ citingId: number }, number[]>(
      `SELECT DISTINCT me.citing_id AS citingId
         FROM memory_edges me
         JOIN turns tc ON tc.id = me.citing_id
         JOIN turns td ON td.id = me.cited_id
        WHERE me.citing_kind = 'turn' AND me.cited_kind = 'turn'
          AND (me.citing_id IN (${placeholders}) OR me.cited_id IN (${placeholders}))
          AND ${relationClassBearingSql("me")}
          AND ${liveTurnSql("tc")} AND ${liveTurnSql("td")}`,
    )
    .all(...ids, ...ids)) {
    affected.add(row.citingId);
  }
  return [...affected].sort((a, b) => a - b);
}

function hasTable(db: Database, name: string): boolean {
  return (
    db
      .query<{ name: string }, [string]>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
      )
      .get(name) !== null
  );
}

function hasColumn(db: Database, table: string, column: string): boolean {
  return db
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .some((row) => row.name === column);
}
