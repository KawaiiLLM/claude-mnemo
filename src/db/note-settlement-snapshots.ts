import type { Database } from "bun:sqlite";

import { resolveEraCutoff } from "./era";
import { relationClassBearingSql } from "../shared/relation-class";
import { liveTurnSql } from "./turn-liveness";
import { eraVisibleMemberSqlClause } from "../segment-era";

/**
 * THE THREE TRANSITION SNAPSHOTS (staged-settlement spec Rev 5, §Persisted
 * snapshots; ticket 04).
 *
 * The stage transition is the last moment stage 1's judgment exists as a live
 * computation. Everything stage 2 needs from it — whose turns it may write,
 * which `(task, lane)` pairs it owes work on, and which turns are the vertices
 * of each of those lanes — is frozen here, in the SAME fenced transaction that
 * moves the stage, and READ afterwards. Stage 2 re-derives none of it, and
 * neither does any retry of stage 2: a retry that recomputed the membership
 * would see whatever concurrent writes landed in between and would settle a
 * different graph than the one its own commit's shape numbers describe.
 *
 * The three tables below are the three snapshots, plus the removed-side debt
 * list that travels with the worklist:
 *
 *   1. `note_settlement_writable_turns` — the exact writable turn-id set, each
 *      id carrying its PROVENANCE CLASS.
 *   2. `note_settlement_worklist` (+ `note_settlement_removed_side_debts`) —
 *      the ORDERED `(task, lane)` worklist, including lanes stage 1 reused for
 *      a synonym and mutated not at all, plus the debts stage 1's own removals
 *      created.
 *   3. `note_settlement_lane_members` — per-worklist-lane member snapshots,
 *      under the ERA-INCLUSIVE rule documented at
 *      `snapshotLaneMembers` below.
 *
 * ## Why the rows carry no `transition_seq`, and no FK on `turn_id`
 *
 * Every table is keyed on `job_id` and cascades with the job (which itself
 * cascades with its session), so "which transition wrote this" is answered by
 * the job row's own `transition_seq` column — read OFF THE ROW
 * (`getNoteSettlementJob(db, jobId).transitionSeq`), never re-derived from a
 * `MAX()`: a job row is deletable, so a maximum re-issues a value once one goes,
 * and a sequence that repeats is not an ordering authority. Copying the value
 * onto every snapshot row would be a second, driftable copy of a fact the job
 * row already holds.
 *
 * `turn_id` deliberately carries NO foreign key. A snapshot is a FROZEN RECORD
 * of what the transition saw, not a live pointer into the graph; a cascade on
 * `turns` would silently shrink a frozen set, which is the one thing these
 * tables exist to make impossible. Cleanup rides on the `job_id` cascade
 * instead.
 */

/**
 * Why a turn id is in the writable set (spec Rev 5, §Persisted snapshots #1).
 *
 * The first three are the ORDINARY classes — the mutually exclusive three-way
 * `worker/note-settlement-context.ts`'s `resolveSettlementScopeProvenance`
 * already computes (window > lookback > closure precedence, kept here). They
 * carry FULL authority over their turn: note fields and relations alike.
 *
 * `removed-side-citer` is the fourth and it is NOT exclusive with the other
 * three — it is a permission the transition GRANTS ON TOP. Its authority is
 * RELATION WRITES ONLY: the job removed a lane from a turn this edge cites, so
 * the job owes the citing turn's edge a repair, and nothing about that debt
 * gives it any claim on the citer's note fields. A turn that is both an
 * ordinary member and a removed-side citer takes the UNION of the two
 * authorities — see `settlementWritePermissions`.
 */
export type SettlementWritableProvenance =
  | "window"
  | "lookback"
  | "closure"
  | "removed-side-citer";

const ORDINARY_PROVENANCES: readonly SettlementWritableProvenance[] = [
  "window",
  "lookback",
  "closure",
];

/**
 * What a turn's provenance SET authorizes, as a union — never a switch on one
 * class (spec Rev 5, §Further Notes, reviewer guardrail 1: "the new model needs
 * a permission UNION for ordinary + removed-side, never a reuse of the old
 * [mutually-exclusive] shape").
 *
 * This function states the rule; it enforces nothing. The terminal gate's own
 * per-provenance filter is a separate ticket and reads this.
 */
export interface SettlementWritePermissions {
  /** Note fields (`title`/`content`/`type`/`tags`/…). Ordinary provenance only. */
  fields: boolean;
  /** Relation writes. Every provenance class carries this, `removed-side-citer` included. */
  relations: boolean;
}

export function settlementWritePermissions(
  provenances: Iterable<SettlementWritableProvenance>,
): SettlementWritePermissions {
  let fields = false;
  let relations = false;
  for (const provenance of provenances) {
    relations = true;
    if (provenance !== "removed-side-citer") {
      fields = true;
    }
  }
  return { fields, relations };
}

/** One `(task, lane)` entry of the stage-2 worklist. A task IS a segment (ADR-0001). */
export interface NoteSettlementWorklistLane {
  segmentId: number;
  laneTag: string;
}

/**
 * One removed-side debt: an edge whose head side names a lane the final
 * projection took off the CITED turn, so the edge's own side attribution no
 * longer holds. Stage 2 discharges it — which is why the citing turn is in the
 * writable set with `removed-side-citer` provenance.
 */
export interface NoteSettlementRemovedSideDebt {
  edgeId: number;
  removedLaneTag: string;
  citingTurnId: number;
}

/** A `(turn, lane)` pair the final projection REMOVED under replacement semantics. */
export interface NoteSettlementRemovedLane {
  turnId: number;
  laneTag: string;
}

const WRITABLE_TURNS_DDL = `
  CREATE TABLE IF NOT EXISTS note_settlement_writable_turns (
    job_id INTEGER NOT NULL REFERENCES note_settlement_jobs(id) ON DELETE CASCADE,
    turn_id INTEGER NOT NULL,
    provenance TEXT NOT NULL CHECK (
      provenance IN ('window', 'lookback', 'closure', 'removed-side-citer')
    ),
    -- (job, turn, provenance), not (job, turn): the classes are a SET per turn,
    -- because 'removed-side-citer' stacks on top of an ordinary class rather
    -- than replacing it, and the union of the rows is the turn's authority.
    PRIMARY KEY (job_id, turn_id, provenance)
  );
`;

const WORKLIST_DDL = `
  CREATE TABLE IF NOT EXISTS note_settlement_worklist (
    job_id INTEGER NOT NULL REFERENCES note_settlement_jobs(id) ON DELETE CASCADE,
    -- The ORDER is part of the snapshot: stage 2 works the lanes in the order
    -- stage 1 judged them, and an ordering re-derived from ids or tags would be
    -- a different (and silently churning) worklist.
    ordinal INTEGER NOT NULL,
    segment_id INTEGER NOT NULL,
    lane_tag TEXT NOT NULL,
    PRIMARY KEY (job_id, ordinal),
    UNIQUE (job_id, segment_id, lane_tag)
  );
`;

const REMOVED_SIDE_DEBTS_DDL = `
  CREATE TABLE IF NOT EXISTS note_settlement_removed_side_debts (
    job_id INTEGER NOT NULL REFERENCES note_settlement_jobs(id) ON DELETE CASCADE,
    edge_id INTEGER NOT NULL,
    removed_lane_tag TEXT NOT NULL,
    citing_turn_id INTEGER NOT NULL,
    PRIMARY KEY (job_id, edge_id, removed_lane_tag)
  );
`;

const LANE_MEMBERS_DDL = `
  CREATE TABLE IF NOT EXISTS note_settlement_lane_members (
    job_id INTEGER NOT NULL REFERENCES note_settlement_jobs(id) ON DELETE CASCADE,
    segment_id INTEGER NOT NULL,
    lane_tag TEXT NOT NULL,
    turn_id INTEGER NOT NULL,
    PRIMARY KEY (job_id, segment_id, lane_tag, turn_id)
  );
`;

const INDEX_DDL = [
  `CREATE INDEX IF NOT EXISTS idx_note_settlement_writable_turns_job
     ON note_settlement_writable_turns(job_id);`,
  `CREATE INDEX IF NOT EXISTS idx_note_settlement_lane_members_job
     ON note_settlement_lane_members(job_id);`,
];

const SNAPSHOT_SCHEMA_READY = new WeakSet<Database>();

/**
 * Create the snapshot tables, additively, memoized per `Database`.
 *
 * Lives here rather than in `db/schema.ts`'s migration chain for the same
 * reason `ensureNoteSettlementStageSchema` does: `note_settlement_jobs` is
 * rebuilt whole by two of schema.ts's own migrations, and these tables carry a
 * foreign key into it. Created from the only module that reads or writes them —
 * one that cannot run before `initializeSchema` has finished — makes the
 * ordering a property of the call graph rather than a comment in a list.
 *
 * NOT memoized when `note_settlement_jobs` is absent: a database whose schema
 * has not been initialized yet must be able to pick these up on a later call
 * instead of being latched as "done" forever.
 */
export function ensureNoteSettlementSnapshotTables(db: Database): void {
  if (SNAPSHOT_SCHEMA_READY.has(db)) {
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
  db.exec(WRITABLE_TURNS_DDL);
  db.exec(WORKLIST_DDL);
  db.exec(REMOVED_SIDE_DEBTS_DDL);
  db.exec(LANE_MEMBERS_DDL);
  for (const ddl of INDEX_DDL) {
    db.exec(ddl);
  }
  SNAPSHOT_SCHEMA_READY.add(db);
}

// ---------------------------------------------------------------------------
// Writing — every function below assumes the caller already holds the
// transition's write transaction.
// ---------------------------------------------------------------------------

export interface NoteSettlementSnapshotInput {
  jobId: number;
  /** This job's own window turns. */
  window: Iterable<number>;
  /** The declared lookback (`context.priorTurns`). */
  lookback: Iterable<number>;
  /** The deadlock-guard closure's own additions. */
  closure: Iterable<number>;
  /** The ordered `(task, lane)` worklist, synonym-reused lanes included. */
  worklist: readonly NoteSettlementWorklistLane[];
  /**
   * The `(turn, lane)` pairs the final projection REMOVED. Supplied by stage 1,
   * never derived here: the projection has already written the post-removal
   * `tags` by the time the transition runs, so what was taken away exists
   * nowhere in the database to be read back.
   */
  removedLanes?: readonly NoteSettlementRemovedLane[];
  /** Defaults to `resolveEraCutoff(db)`. */
  eraCutoffEpoch?: number | null;
}

export interface NoteSettlementSnapshot {
  /** Every writable id with the full SET of classes that put it there. */
  writable: Map<number, Set<SettlementWritableProvenance>>;
  worklist: readonly NoteSettlementWorklistLane[];
  debts: readonly NoteSettlementRemovedSideDebt[];
  /** Keyed by `laneSnapshotKey`; ids ascending. */
  laneMembers: Map<string, number[]>;
}

/** The canonical lane address (`E<n>/#<tag>`), reused as the member-snapshot map key. */
export function laneSnapshotKey(segmentId: number, laneTag: string): string {
  return `E${segmentId}/#${laneTag}`;
}

/**
 * Write all three snapshots (plus the removed-side debt list) for one job, and
 * return what was written.
 *
 * The removed-side-citer CLOSURE runs here, inside the same transaction, per
 * spec: enumerating it later would mean a window whose diseased lane word
 * survives until some future window happens to own the citer.
 */
export function writeNoteSettlementTransitionSnapshots(
  db: Database,
  input: NoteSettlementSnapshotInput,
): NoteSettlementSnapshot {
  ensureNoteSettlementSnapshotTables(db);

  const writable = new Map<number, Set<SettlementWritableProvenance>>();
  const addProvenance = (
    turnId: number,
    provenance: SettlementWritableProvenance,
  ): void => {
    const existing = writable.get(turnId);
    if (existing) {
      existing.add(provenance);
      return;
    }
    writable.set(turnId, new Set([provenance]));
  };

  // Ordinary classes first, under the SAME precedence
  // `resolveSettlementScopeProvenance` applies (window > lookback > closure): a
  // turn already reachable by lookback is not filed as a closure endpoint, or
  // the record would misstate why it is writable.
  const ordinary = new Set<number>();
  const ordinarySources: ReadonlyArray<[SettlementWritableProvenance, Iterable<number>]> = [
    ["window", input.window],
    ["lookback", input.lookback],
    ["closure", input.closure],
  ];
  for (const [provenance, ids] of ordinarySources) {
    for (const id of ids) {
      if (ordinary.has(id)) {
        continue;
      }
      ordinary.add(id);
      addProvenance(id, provenance);
    }
  }

  const debts = enumerateRemovedSideCiters(db, input.removedLanes ?? []);
  for (const debt of debts) {
    addProvenance(debt.citingTurnId, "removed-side-citer");
  }

  const eraCutoffEpoch =
    input.eraCutoffEpoch !== undefined ? input.eraCutoffEpoch : resolveEraCutoff(db);
  const laneMembers = snapshotLaneMembers(
    db,
    input.worklist,
    ordinary,
    eraCutoffEpoch,
  );

  const insertWritable = db.query<unknown, [number, number, string]>(
    `INSERT INTO note_settlement_writable_turns (job_id, turn_id, provenance)
     VALUES (?, ?, ?)`,
  );
  for (const [turnId, provenances] of writable) {
    for (const provenance of provenances) {
      insertWritable.run(input.jobId, turnId, provenance);
    }
  }

  const insertLane = db.query<unknown, [number, number, number, string]>(
    `INSERT INTO note_settlement_worklist (job_id, ordinal, segment_id, lane_tag)
     VALUES (?, ?, ?, ?)`,
  );
  input.worklist.forEach((lane, index) => {
    insertLane.run(input.jobId, index + 1, lane.segmentId, lane.laneTag);
  });

  const insertDebt = db.query<unknown, [number, number, string, number]>(
    `INSERT INTO note_settlement_removed_side_debts
       (job_id, edge_id, removed_lane_tag, citing_turn_id)
     VALUES (?, ?, ?, ?)`,
  );
  for (const debt of debts) {
    insertDebt.run(input.jobId, debt.edgeId, debt.removedLaneTag, debt.citingTurnId);
  }

  const insertMember = db.query<unknown, [number, number, string, number]>(
    `INSERT INTO note_settlement_lane_members (job_id, segment_id, lane_tag, turn_id)
     VALUES (?, ?, ?, ?)`,
  );
  for (const lane of input.worklist) {
    const members = laneMembers.get(laneSnapshotKey(lane.segmentId, lane.laneTag)) ?? [];
    for (const turnId of members) {
      insertMember.run(input.jobId, lane.segmentId, lane.laneTag, turnId);
    }
  }

  return { writable, worklist: input.worklist, debts, laneMembers };
}

/**
 * THE REMOVED-SIDE-CITER CLOSURE (spec Rev 5, §Stage-1 final projection).
 *
 * The final projection removes lane words under replacement semantics. When the
 * turn it removed lane `L` from is the CITED endpoint of an edge whose HEAD
 * side names `L`, that edge's side attribution now points at a lane its own
 * endpoint has left — and only the edge's CITING turn can repair it (retract,
 * or re-add carrying a lane both endpoints hold). So the citing turn joins the
 * writable set, with relation-only authority.
 *
 * The TAIL direction needs no closure: a lane removed from a turn that is the
 * CITING side of an edge is a removal on a turn the projection was already
 * writing, so that turn is in the writable set by an ordinary class already.
 *
 * Boundaries, matching `computeSettlementWritableTurnIds`' own:
 *
 *   - turn→turn rows only. A non-turn citer has no turn id to admit, and the
 *     debt list's third field is a CITING TURN by definition.
 *   - LIVE endpoints on both sides (`db/turn-liveness.ts`, law 8): a
 *     rolled-back or skipped turn is never a node, so it can neither hold a
 *     debt nor be owed one.
 *   - CLASS-CARRYING rows only (`relationClassBearingSql`, main-agent-edges
 *     ticket 02 — it read `relation IS NOT NULL` before, the same test spelled
 *     against a column the cutover drops): a bare citation row carries no side
 *     attribution to be invalidated.
 */
function enumerateRemovedSideCiters(
  db: Database,
  removedLanes: readonly NoteSettlementRemovedLane[],
): NoteSettlementRemovedSideDebt[] {
  if (removedLanes.length === 0) {
    return [];
  }
  const statement = db.query<
    { edgeId: number; citingTurnId: number },
    [number, string]
  >(
    `SELECT me.id AS edgeId, me.citing_id AS citingTurnId
       FROM memory_edges me
       JOIN turns tc ON tc.id = me.citing_id
       JOIN turns td ON td.id = me.cited_id
      WHERE me.cited_id = ?
        AND me.head_tag = ?
        AND me.citing_kind = 'turn' AND me.cited_kind = 'turn'
        AND ${relationClassBearingSql("me")}
        AND ${liveTurnSql("tc")} AND ${liveTurnSql("td")}
      ORDER BY me.id ASC`,
  );

  const seen = new Set<string>();
  const debts: NoteSettlementRemovedSideDebt[] = [];
  for (const removed of removedLanes) {
    for (const row of statement.all(removed.turnId, removed.laneTag)) {
      const key = `${row.edgeId}:${removed.laneTag}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      debts.push({
        edgeId: row.edgeId,
        removedLaneTag: removed.laneTag,
        citingTurnId: row.citingTurnId,
      });
    }
  }
  debts.sort((a, b) => a.edgeId - b.edgeId || a.removedLaneTag.localeCompare(b.removedLaneTag));
  return debts;
}

interface WritableMemberRow {
  id: number;
  segmentId: number | null;
  tags: string | null;
}

/** SQLite's parameter ceiling is the only reason the writable-set read is chunked. */
const WRITABLE_ID_CHUNK = 400;

/**
 * PER-WORKLIST-LANE MEMBER SNAPSHOTS, under the ERA-INCLUSIVE rule (spec Rev 5,
 * §Persisted snapshots #3, rounds 3-4).
 *
 * A lane's frozen vertex set is the UNION of two halves:
 *
 *   A. this job's own final-projection members drawn from the writable set,
 *      REGARDLESS OF ERA; and
 *   B. the historical members already era-visible at transition time.
 *
 * Half A cannot be era-filtered, and that is the whole point. A pre-era
 * backfill window (`allow_pre_era`) freshly lanes turns that hold no era grant
 * — the grant is exclusive to stage 2's TERMINAL commit, because moving it
 * earlier would publish a half-settled window — so an era-visible-only snapshot
 * would freeze a vertex set missing every new member the job just created: the
 * T1964 deadlock shape. Those members are visible to stage 2 through this
 * snapshot (and direct S/T reads); GLOBAL visibility still lands at the
 * terminal commit, and ordinary lane recall correctly does not show them until
 * then.
 *
 * MEMBERSHIP IS A NODE FACT scoped to the OWNING task (lane-model-v12 D5): a
 * turn is a member of `(segment, tag)` only when its own `tags` carry the tag
 * AND its owning segment IS that segment. Admitting a turn that carries the
 * word while owned by another task would mint a phantom member — the same
 * reason `db/lane-checker-load.ts` intersects against the owning segment.
 *
 * Half B's era clause is `eraVisibleMemberSqlClause`, which is EMPTY when no
 * cutoff is recorded — the member reads' own standing rule ("with no boundary
 * there is nothing to filter"), not a special case invented here.
 */
function snapshotLaneMembers(
  db: Database,
  worklist: readonly NoteSettlementWorklistLane[],
  writableIds: ReadonlySet<number>,
  eraCutoffEpoch: number | null,
): Map<string, number[]> {
  const result = new Map<string, number[]>();
  if (worklist.length === 0) {
    return result;
  }

  // Half A, read ONCE for the whole writable set and then filtered per lane in
  // JS — a per-lane SQL pass would re-chunk the same ids for every lane.
  const writableRows: WritableMemberRow[] = [];
  const ids = [...writableIds];
  for (let offset = 0; offset < ids.length; offset += WRITABLE_ID_CHUNK) {
    const chunk = ids.slice(offset, offset + WRITABLE_ID_CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    writableRows.push(
      ...db
        .query<WritableMemberRow, number[]>(
          `SELECT t.id AS id,
                  (SELECT MIN(sm.segment_id) FROM segment_members sm
                    WHERE sm.turn_id = t.id) AS segmentId,
                  t.tags AS tags
             FROM turns t
            WHERE t.id IN (${placeholders})
              AND ${liveTurnSql("t")}`,
        )
        .all(...chunk),
    );
  }
  const writableByLane = new Map<string, number[]>();
  for (const row of writableRows) {
    if (row.segmentId === null) {
      continue;
    }
    for (const tag of parseTagArray(row.tags)) {
      const key = laneSnapshotKey(row.segmentId, tag);
      const bucket = writableByLane.get(key);
      if (bucket) {
        bucket.push(row.id);
      } else {
        writableByLane.set(key, [row.id]);
      }
    }
  }

  // Half B. The `CASE` around `json_each` is load-bearing for the same reason
  // `db/lanes.ts`'s member count states: `turns.tags` has no `json_valid`
  // CHECK, and `json_each` RAISES on a malformed value instead of returning
  // zero rows — one unreadable column would otherwise fail the whole
  // transition.
  const era = eraVisibleMemberSqlClause("t", eraCutoffEpoch);
  const historical = db.query<{ id: number }, (number | string)[]>(
    `SELECT t.id AS id
       FROM turns t
      WHERE (SELECT MIN(sm.segment_id) FROM segment_members sm
              WHERE sm.turn_id = t.id) = ?
        AND ${liveTurnSql("t")}
        ${era.clause ? `AND ${era.clause}` : ""}
        AND CASE
              WHEN json_valid(t.tags) AND json_type(t.tags) = 'array'
                THEN EXISTS (SELECT 1 FROM json_each(t.tags) j WHERE j.value = ?)
              ELSE 0
            END`,
  );

  for (const lane of worklist) {
    const key = laneSnapshotKey(lane.segmentId, lane.laneTag);
    if (result.has(key)) {
      continue;
    }
    const members = new Set<number>(writableByLane.get(key) ?? []);
    for (const row of historical.all(lane.segmentId, ...era.params, lane.laneTag)) {
      members.add(row.id);
    }
    result.set(key, [...members].sort((a, b) => a - b));
  }
  return result;
}

function parseTagArray(raw: string | null): string[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Reading — stage 2's ONLY view of stage 1's judgment.
// ---------------------------------------------------------------------------

/**
 * The writable set as stage 2 reads it: every id with the full set of classes
 * that put it there. Empty for a job that never transitioned.
 */
export function readNoteSettlementWritableSnapshot(
  db: Database,
  jobId: number,
): Map<number, Set<SettlementWritableProvenance>> {
  ensureNoteSettlementSnapshotTables(db);
  const byTurn = new Map<number, Set<SettlementWritableProvenance>>();
  const rows = db
    .query<{ turnId: number; provenance: SettlementWritableProvenance }, [number]>(
      `SELECT turn_id AS turnId, provenance
         FROM note_settlement_writable_turns
        WHERE job_id = ?
        ORDER BY turn_id ASC, provenance ASC`,
    )
    .all(jobId);
  for (const row of rows) {
    const existing = byTurn.get(row.turnId);
    if (existing) {
      existing.add(row.provenance);
    } else {
      byTurn.set(row.turnId, new Set([row.provenance]));
    }
  }
  return byTurn;
}

/** Only the ids — the flat set the range check takes, ascending. */
export function readNoteSettlementWritableTurnIds(
  db: Database,
  jobId: number,
): number[] {
  return [...readNoteSettlementWritableSnapshot(db, jobId).keys()].sort((a, b) => a - b);
}

export interface NoteSettlementWorklistSnapshot {
  /** In the order stage 1 judged them. */
  lanes: NoteSettlementWorklistLane[];
  debts: NoteSettlementRemovedSideDebt[];
}

export function readNoteSettlementWorklistSnapshot(
  db: Database,
  jobId: number,
): NoteSettlementWorklistSnapshot {
  ensureNoteSettlementSnapshotTables(db);
  const lanes = db
    .query<NoteSettlementWorklistLane, [number]>(
      `SELECT segment_id AS segmentId, lane_tag AS laneTag
         FROM note_settlement_worklist
        WHERE job_id = ?
        ORDER BY ordinal ASC`,
    )
    .all(jobId);
  const debts = db
    .query<NoteSettlementRemovedSideDebt, [number]>(
      `SELECT edge_id AS edgeId, removed_lane_tag AS removedLaneTag,
              citing_turn_id AS citingTurnId
         FROM note_settlement_removed_side_debts
        WHERE job_id = ?
        ORDER BY edge_id ASC, removed_lane_tag ASC`,
    )
    .all(jobId);
  return { lanes, debts };
}

/**
 * The frozen vertex sets, keyed by `laneSnapshotKey`. These are the shape
 * numbers' graph vertices and the denominator of every member count stage 2
 * reports — a member added concurrently after the transition is invisible to
 * them by definition.
 */
export function readNoteSettlementLaneMemberSnapshot(
  db: Database,
  jobId: number,
): Map<string, number[]> {
  ensureNoteSettlementSnapshotTables(db);
  const rows = db
    .query<{ segmentId: number; laneTag: string; turnId: number }, [number]>(
      `SELECT segment_id AS segmentId, lane_tag AS laneTag, turn_id AS turnId
         FROM note_settlement_lane_members
        WHERE job_id = ?
        ORDER BY segment_id ASC, lane_tag ASC, turn_id ASC`,
    )
    .all(jobId);
  const byLane = new Map<string, number[]>();
  for (const row of rows) {
    const key = laneSnapshotKey(row.segmentId, row.laneTag);
    const bucket = byLane.get(key);
    if (bucket) {
      bucket.push(row.turnId);
    } else {
      byLane.set(key, [row.turnId]);
    }
  }
  return byLane;
}
