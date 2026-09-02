/**
 * THE DERIVED-SIDE CLOSURE'S TWO HALVES (`.scratch/main-agent-edges/spec.md`
 * D6, "Derived removed-side closure"; peer findings R9-9 and R10-7).
 *
 * The removed-side closure that shipped with staged settlement answers one
 * narrow question: an edge's STORED head tag names a lane the job just took off
 * the cited turn. Under resolution (D2) most sides store nothing at all, so the
 * far commoner damage is invisible to it — a job's own tag projection puts a
 * SECOND lane on an endpoint, and every blank side resting on that endpoint
 * stops deriving and starts reading `ambiguous`. Nobody declared anything and
 * nobody removed anything; the attribution simply stopped being decidable.
 *
 * The spec's answer is a BEFORE/AFTER comparison, and the "before" is the part
 * that cannot be recovered later: once the projection has written the new
 * `tags`, what the side used to resolve to exists nowhere in the database. So:
 *
 *   1. RECORD, inside the attribution-mutation transaction. Stage 1's batch tag
 *      write and every structural verb reach
 *      `normalizeIncidentAttribution`, which already captures the caller's
 *      pre-state; when that call carries a settlement job id it writes each
 *      incident side's PRE resolution here. FIRST-WRITE-WINS per
 *      `(job, edge, side)` — a stage-1 pass writes tags many times, and only
 *      the FIRST record is the state the run inherited (R10-7). Later records
 *      would describe damage this same run had already done and turn every
 *      repair into a fresh debt.
 *   2. CLOSE, at finalize, against POST facts, inside the transition
 *      transaction. Only a PRE-GOOD → POST-BAD transition grants: a side that
 *      was already `ambiguous` or `invalid` before this run touched anything is
 *      somebody else's debt, and admitting its citer would let one job's
 *      writable set grow by the amount of pre-existing damage in its
 *      neighbourhood.
 *
 * The grant is `derived-side-citer`, a RELATIONS-ONLY provenance in the
 * permission union exactly like `removed-side-citer`
 * (`db/note-settlement-snapshots.ts`): the run owes this edge a declaration,
 * and owing an edge a declaration is no claim at all on the citer's note
 * fields.
 */

import type { Database } from "bun:sqlite";

import {
  loadEndpointLaneFacts,
  resolveEdgeSide,
  type EdgeSide,
  type EdgeSideOutcome,
  type EndpointLaneFacts,
  type ResolvableEdgeSides,
} from "./edge-side-resolution";
import { relationClassBearingSql } from "../shared/relation-class";
import { liveTurnSql } from "./turn-liveness";

const PRE_RESOLUTIONS_DDL = `
  CREATE TABLE IF NOT EXISTS note_settlement_pre_side_resolutions (
    job_id INTEGER NOT NULL REFERENCES note_settlement_jobs(id) ON DELETE CASCADE,
    edge_row_id INTEGER NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('tail', 'head')),
    citing_id INTEGER NOT NULL,
    cited_id INTEGER NOT NULL,
    outcome TEXT NOT NULL CHECK (
      outcome IN ('declared', 'derived', 'ambiguous', 'none', 'invalid')
    ),
    created_at_epoch INTEGER NOT NULL,
    -- FIRST-WRITE-WINS lives in this key plus the writer's INSERT OR IGNORE:
    -- the durability requirement (R10-7) is that a repeated stage-1 call cannot
    -- overwrite the state the run inherited, and a primary key is the only form
    -- of that rule a crash cannot lose.
    PRIMARY KEY (job_id, edge_row_id, side)
  );
`;

const PRE_RESOLUTIONS_INDEX_DDL = `
  CREATE INDEX IF NOT EXISTS idx_note_settlement_pre_side_resolutions_job
    ON note_settlement_pre_side_resolutions(job_id);
`;

const PRE_RESOLUTIONS_READY = new WeakSet<Database>();

/** Additive DDL, memoized per `Database` — and deliberately not memoized while `note_settlement_jobs` is absent, so an uninitialized database picks it up later. */
export function ensureNoteSettlementPreResolutionTable(db: Database): void {
  if (PRE_RESOLUTIONS_READY.has(db)) {
    return;
  }
  const table = db
    .query<{ name: string }, []>(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'note_settlement_jobs'`,
    )
    .get();
  if (!table) {
    return;
  }
  db.exec(PRE_RESOLUTIONS_DDL);
  db.exec(PRE_RESOLUTIONS_INDEX_DDL);
  PRE_RESOLUTIONS_READY.add(db);
}

/** An edge row addressed by its physical id — what the seam already holds when it re-resolves. */
export interface IdentifiedEdgeSides extends ResolvableEdgeSides {
  id: number;
}

export interface PreSideResolutionRecord {
  edgeRowId: number;
  side: EdgeSide;
  citingId: number;
  citedId: number;
  outcome: EdgeSideOutcome;
}

/**
 * A side's resolution BEFORE this run touched its endpoint. `declared`,
 * `derived` and `none` are all GOOD: each is an answer a reader can act on, and
 * `none` in particular is the perfectly legal "this endpoint is in no lane".
 * The two BAD outcomes are the two findings — E6 and E4.
 */
export function isGoodSideOutcome(outcome: EdgeSideOutcome): boolean {
  return outcome !== "ambiguous" && outcome !== "invalid";
}

/**
 * Record the PRE resolution of every side of every incident row, first-write-wins.
 *
 * `preFacts` must be the endpoint facts as they stood BEFORE the caller's
 * mutation — `normalizeIncidentAttribution` builds it by overlaying the
 * caller's captured pre-state onto the post-state of the endpoints nobody
 * moved, which is exact because an endpoint nobody moved has the same facts in
 * both.
 */
export function recordPreSideResolutions(
  db: Database,
  jobId: number,
  rows: readonly IdentifiedEdgeSides[],
  preFacts: ReadonlyMap<number, EndpointLaneFacts>,
  nowEpoch: number,
): void {
  ensureNoteSettlementPreResolutionTable(db);
  if (rows.length === 0) {
    return;
  }
  const insert = db.query<
    unknown,
    [number, number, string, number, number, string, number]
  >(
    `INSERT OR IGNORE INTO note_settlement_pre_side_resolutions
       (job_id, edge_row_id, side, citing_id, cited_id, outcome, created_at_epoch)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    for (const side of ["tail", "head"] as const) {
      insert.run(
        jobId,
        row.id,
        side,
        row.citingId,
        row.citedId,
        resolveEdgeSide(row, side, preFacts).outcome,
        nowEpoch,
      );
    }
  }
}

/** Everything recorded for one job, ordered — the closure's input and the shape a test reads back. */
export function readPreSideResolutions(
  db: Database,
  jobId: number,
): PreSideResolutionRecord[] {
  ensureNoteSettlementPreResolutionTable(db);
  const table = db
    .query<{ name: string }, []>(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'note_settlement_pre_side_resolutions'`,
    )
    .get();
  if (!table) {
    return [];
  }
  return db
    .query<PreSideResolutionRecord, [number]>(
      `SELECT edge_row_id AS edgeRowId, side, citing_id AS citingId,
              cited_id AS citedId, outcome
         FROM note_settlement_pre_side_resolutions
        WHERE job_id = ?
        ORDER BY edge_row_id ASC, side ASC`,
    )
    .all(jobId);
}

/** One derived-side debt: a side this run turned from decidable into a finding, and the citer that alone can repair it. */
export interface DerivedSideDebt {
  edgeId: number;
  side: EdgeSide;
  /** The POST outcome — `ambiguous` (E6) or `invalid` (E4). Both are stage 2's to settle. */
  outcome: "ambiguous" | "invalid";
  citingTurnId: number;
}

/**
 * THE CLOSURE (spec D6). Run inside the stage-1 transition transaction, after
 * every stage-1 write, so the POST facts it resolves against are final.
 *
 * Boundaries, matching `enumerateRemovedSideCiters`' own: turn→turn rows only,
 * LIVE on both endpoints, CLASS-CARRYING only. An edge the run RETRACTED
 * between the record and the finalize is simply gone from `memory_edges` and
 * contributes nothing — there is no debt on a row that no longer exists.
 */
export function enumerateDerivedSideCiters(
  db: Database,
  jobId: number,
): DerivedSideDebt[] {
  const recorded = readPreSideResolutions(db, jobId);
  if (recorded.length === 0) {
    return [];
  }
  const edgeIds = [...new Set(recorded.map((row) => row.edgeRowId))];
  const live = new Map<number, ResolvableEdgeSides>();
  const CHUNK = 400;
  for (let offset = 0; offset < edgeIds.length; offset += CHUNK) {
    const chunk = edgeIds.slice(offset, offset + CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    for (const row of db
      .query<
        { id: number; citingId: number; citedId: number; tailTag: string; headTag: string },
        number[]
      >(
        `SELECT me.id AS id, me.citing_id AS citingId, me.cited_id AS citedId,
                me.tail_tag AS tailTag, me.head_tag AS headTag
           FROM memory_edges me
           JOIN turns tc ON tc.id = me.citing_id
           JOIN turns td ON td.id = me.cited_id
          WHERE me.id IN (${placeholders})
            AND me.citing_kind = 'turn' AND me.cited_kind = 'turn'
            AND ${relationClassBearingSql("me")}
            AND ${liveTurnSql("tc")} AND ${liveTurnSql("td")}`,
      )
      .all(...chunk)) {
      live.set(row.id, {
        citingId: row.citingId,
        citedId: row.citedId,
        tailTag: row.tailTag,
        headTag: row.headTag,
      });
    }
  }
  if (live.size === 0) {
    return [];
  }
  const endpointIds = new Set<number>();
  for (const row of live.values()) {
    endpointIds.add(row.citingId);
    endpointIds.add(row.citedId);
  }
  const facts = loadEndpointLaneFacts(db, [...endpointIds]);

  const debts: DerivedSideDebt[] = [];
  for (const record of recorded) {
    if (!isGoodSideOutcome(record.outcome)) {
      // PRE-BAD. Pre-existing damage is not this run's to answer for — the
      // whole reason the PRE state is recorded at all.
      continue;
    }
    const edge = live.get(record.edgeRowId);
    if (edge === undefined) {
      continue;
    }
    const post = resolveEdgeSide(edge, record.side, facts).outcome;
    if (post !== "ambiguous" && post !== "invalid") {
      continue;
    }
    debts.push({
      edgeId: record.edgeRowId,
      side: record.side,
      outcome: post,
      citingTurnId: edge.citingId,
    });
  }
  debts.sort((a, b) => a.edgeId - b.edgeId || a.side.localeCompare(b.side));
  return debts;
}
