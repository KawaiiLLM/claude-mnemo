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
 * The three tables below are the three snapshots:
 *
 *   1. `note_settlement_writable_turns` — the exact writable turn-id set, each
 *      id carrying its PROVENANCE CLASS.
 *   2. `note_settlement_worklist` — the ORDERED `(task, lane)` worklist,
 *      including lanes stage 1 reused for a synonym and mutated not at all.
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
 * THERE IS NO FOURTH CLASS (main-agent-edges ticket 14). `removed-side-citer`
 * and `derived-side-citer` were relations-only permissions GRANTED ON TOP of
 * the three, and both existed for one purpose: to hand a side this job's own
 * projection had made `ambiguous` a repair channel. Ruling S15069/T2465-T2466
 * made an ambiguous side a WARNING and nothing more — no repair authority is
 * minted for one — so the two classes, their debt list, the PRE-resolution
 * scratch they read and the `writableDelta` they fed are all gone. The three
 * ordinary classes each carry FULL authority, so `settlementWritePermissions`
 * is now a union with nothing to subtract; it is kept because the shape it
 * answers in (`fields`/`relations`) is what every gate reads.
 */
export type SettlementWritableProvenance = "window" | "lookback" | "closure";

const ORDINARY_PROVENANCES: readonly SettlementWritableProvenance[] = [
  "window",
  "lookback",
  "closure",
];

/**
 * What a turn's provenance SET authorizes, as a union — never a switch on one
 * class (spec Rev 5, §Further Notes, reviewer guardrail 1: "the new model needs
 * a permission UNION […], never a reuse of the old [mutually-exclusive] shape").
 *
 * WITH THE TWO SIDE-CITER CLASSES GONE (ticket 14) every surviving class carries
 * both authorities, so the union has nothing left to discriminate on and this
 * answers `{fields, relations}` = true for any non-empty set. The SHAPE is kept
 * — it is what `settlementTurnPermissions` and every gate above it read, and a
 * class added tomorrow states its authority here rather than in a caller.
 *
 * This function states the rule; it enforces nothing. The terminal gate's own
 * per-provenance filter is a separate ticket and reads this.
 */
export interface SettlementWritePermissions {
  /** Note fields (`title`/`content`/`type`/`tags`/…). Ordinary provenance only. */
  fields: boolean;
  /** Relation writes. Every provenance class carries this. */
  relations: boolean;
}

export function settlementWritePermissions(
  provenances: Iterable<SettlementWritableProvenance>,
): SettlementWritePermissions {
  let fields = false;
  let relations = false;
  for (const _provenance of provenances) {
    relations = true;
    fields = true;
  }
  return { fields, relations };
}

/** One `(task, lane)` entry of the stage-2 worklist. A task IS a segment (ADR-0001). */
export interface NoteSettlementWorklistLane {
  segmentId: number;
  laneTag: string;
}

const WRITABLE_TURNS_DDL = `
  CREATE TABLE IF NOT EXISTS note_settlement_writable_turns (
    job_id INTEGER NOT NULL REFERENCES note_settlement_jobs(id) ON DELETE CASCADE,
    turn_id INTEGER NOT NULL,
    provenance TEXT NOT NULL CHECK (
      provenance IN ('window', 'lookback', 'closure')
    ),
    -- (job, turn, provenance), not (job, turn): the row shape is a SET per turn
    -- and the union of the rows is the turn's authority. The three surviving
    -- classes are mutually exclusive in practice (the writer applies a
    -- window > lookback > closure precedence), but the key is what makes the
    -- table state the union rather than assume it.
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

const LANE_MEMBERS_DDL = `
  CREATE TABLE IF NOT EXISTS note_settlement_lane_members (
    job_id INTEGER NOT NULL REFERENCES note_settlement_jobs(id) ON DELETE CASCADE,
    segment_id INTEGER NOT NULL,
    lane_tag TEXT NOT NULL,
    turn_id INTEGER NOT NULL,
    PRIMARY KEY (job_id, segment_id, lane_tag, turn_id)
  );
`;

/**
 * THE DECLARATION ENDPOINTS (main-agent-edges ticket 06, spec D6 / read-once
 * D6): the other endpoint of every live outgoing edge of a writable citer, as
 * the transition saw it. The fourth frozen fact, and the only input of the
 * stage-2 read delta that the three snapshots above do not already hold — the
 * lane half of `contextDelta` is snapshot #3, but which turns a writable
 * citer's edges POINT AT is a fact about the live graph at transition time,
 * and a retry of stage 2 that re-read it live would read a different set
 * whenever an edge landed in between. Frozen here, the delta is a pure
 * function of persisted rows (`computeSettlementReadDeltas`).
 */
const DECLARATION_ENDPOINTS_DDL = `
  CREATE TABLE IF NOT EXISTS note_settlement_declaration_endpoints (
    job_id INTEGER NOT NULL REFERENCES note_settlement_jobs(id) ON DELETE CASCADE,
    turn_id INTEGER NOT NULL,
    PRIMARY KEY (job_id, turn_id)
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
  narrowWritableProvenanceCheck(db);
  db.exec(WORKLIST_DDL);
  db.exec(RETIRED_SIDE_CITER_SCRATCH_DDL);
  db.exec(LANE_MEMBERS_DDL);
  db.exec(DECLARATION_ENDPOINTS_DDL);
  for (const ddl of INDEX_DDL) {
    db.exec(ddl);
  }
  SNAPSHOT_SCHEMA_READY.add(db);
}

/**
 * THE TWO SIDE-CITER SCRATCH TABLES, DROPPED (main-agent-edges ticket 14).
 *
 * `note_settlement_removed_side_debts` held the removed-side debt list and
 * `note_settlement_pre_side_resolutions` the PRE resolutions the derived-side
 * closure read. Both existed only to hand an ambiguous side a repair channel,
 * which ruling S15069/T2465-T2466 abolished. Nothing reads either table, and a
 * table nobody reads is a second, drifting answer waiting for a reader — so it
 * is deleted rather than left as inert stock (T2419's subtract ruling). The
 * rows they carried were per-run scratch that a reset already discarded, so
 * there is nothing durable to preserve.
 */
const RETIRED_SIDE_CITER_SCRATCH_DDL = `
  DROP TABLE IF EXISTS note_settlement_removed_side_debts;
  DROP TABLE IF EXISTS note_settlement_pre_side_resolutions;
`;

/**
 * `CREATE TABLE IF NOT EXISTS` does nothing for a database that already has the
 * table, so a snapshot table created while the two side-citer classes existed
 * still carries the FIVE-value CHECK. Left alone it would silently keep
 * accepting a provenance the model no longer has — and, worse, keep GRANTING
 * relations authority to rows nobody can produce any more.
 *
 * Rebuilt the way ticket 04 built it up: copy, drop, rename, inside whatever
 * transaction the caller holds (`ensureNoteSettlementSnapshotTables` runs
 * before the transition opens one, and from `initializeSchema`). The copy is
 * FILTERED to the three surviving classes, which deletes exactly the rows whose
 * only authority was the retired repair channel — a turn that held nothing but
 * `removed-side-citer`/`derived-side-citer` loses its place in the writable set,
 * which IS the ruling ("no repair authority is minted"). A turn that also held
 * an ordinary class keeps that row and loses nothing.
 */
function narrowWritableProvenanceCheck(db: Database): void {
  const ddl = db
    .query<{ sql: string | null }, []>(
      `SELECT sql FROM sqlite_master
        WHERE type = 'table' AND name = 'note_settlement_writable_turns'`,
    )
    .get();
  if (!ddl?.sql || !ddl.sql.includes("-side-citer")) {
    return;
  }
  db.exec(`
    CREATE TABLE note_settlement_writable_turns_new (
      job_id INTEGER NOT NULL REFERENCES note_settlement_jobs(id) ON DELETE CASCADE,
      turn_id INTEGER NOT NULL,
      provenance TEXT NOT NULL CHECK (
        provenance IN ('window', 'lookback', 'closure')
      ),
      PRIMARY KEY (job_id, turn_id, provenance)
    );
    INSERT INTO note_settlement_writable_turns_new (job_id, turn_id, provenance)
      SELECT job_id, turn_id, provenance FROM note_settlement_writable_turns
       WHERE provenance IN ('window', 'lookback', 'closure');
    DROP TABLE note_settlement_writable_turns;
    ALTER TABLE note_settlement_writable_turns_new
      RENAME TO note_settlement_writable_turns;
  `);
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
  /** Defaults to `resolveEraCutoff(db)`. */
  eraCutoffEpoch?: number | null;
}

export interface NoteSettlementSnapshot {
  /** Every writable id with the full SET of classes that put it there. */
  writable: Map<number, Set<SettlementWritableProvenance>>;
  worklist: readonly NoteSettlementWorklistLane[];
  /** Keyed by `laneSnapshotKey`; ids ascending. */
  laneMembers: Map<string, number[]>;
  /** Snapshot #4: the other endpoint of every live outgoing edge of a writable citer, ascending. */
  declarationEndpointIds: number[];
  /** The two stage-2 read lists, computed from the four snapshots above — see `computeSettlementReadDeltas`. */
  readDeltas: SettlementReadDeltas;
}

/**
 * THE STAGE-2 READ DELTAS (main-agent-edges ticket 06; read-once spec D6).
 *
 * ONE list now (main-agent-edges ticket 14). `writableDelta` was the set of
 * citers the two side-citer closures admitted for RELATIONS ONLY, and both
 * closures existed to repair an ambiguous side; with the ruling
 * (S15069/T2465-T2466) they are gone, so `finalWritableIds = initialWritableIds`
 * and the difference is empty by construction rather than by computation.
 *
 * `contextDelta` STAYS, and it is a SET DIFFERENCE against what stage 1 already
 * read, never a source category — a historical lane member may also be in the
 * lookback — so an address stage 1 read never appears in it:
 *
 *   initialWritableIds = the ids in snapshot #1, all of which carry an ORDINARY
 *                        class (window, lookback, closure) — exactly the
 *                        claim-time writable set stage 1's prompt printed;
 *   contextDelta       = (⋃ laneMembers ∪ declarationEndpointIds)
 *                        − initialWritableIds — read-only judgment material,
 *                        ONE HOP: a lane member's own edges are not followed
 *                        further.
 *
 * Pure over the persisted rows, so the finalize result, the resume prompt and
 * any retry print the SAME list.
 */
export interface SettlementReadDeltas {
  initialWritableIds: number[];
  contextDelta: number[];
}

export function computeSettlementReadDeltas(input: {
  writable: ReadonlyMap<number, ReadonlySet<SettlementWritableProvenance>>;
  laneMembers: ReadonlyMap<string, readonly number[]>;
  declarationEndpointIds: Iterable<number>;
}): SettlementReadDeltas {
  const initial = new Set<number>();
  for (const [turnId, provenances] of input.writable) {
    if (ORDINARY_PROVENANCES.some((provenance) => provenances.has(provenance))) {
      initial.add(turnId);
    }
  }
  const context = new Set<number>();
  const admit = (turnId: number): void => {
    if (!initial.has(turnId)) {
      context.add(turnId);
    }
  };
  for (const members of input.laneMembers.values()) {
    for (const turnId of members) {
      admit(turnId);
    }
  }
  for (const turnId of input.declarationEndpointIds) {
    admit(turnId);
  }
  const ascending = (ids: Iterable<number>): number[] => [...ids].sort((a, b) => a - b);
  return {
    initialWritableIds: ascending(initial),
    contextDelta: ascending(context),
  };
}

/** Empty deltas — what a job that never transitioned (or froze nothing) hands stage 2. */
export function emptySettlementReadDeltas(): SettlementReadDeltas {
  return { initialWritableIds: [], contextDelta: [] };
}

/** The canonical lane address (`E<n>/#<tag>`), reused as the member-snapshot map key. */
export function laneSnapshotKey(segmentId: number, laneTag: string): string {
  return `E${segmentId}/#${laneTag}`;
}

/**
 * Write all three snapshots for one job, and return what was written.
 *
 * The two side-citer CLOSURES used to run here, inside the same transaction.
 * Both are gone (main-agent-edges ticket 14): each existed to admit a citer for
 * relation writes so it could repair a side this run made `ambiguous`, and the
 * ruling (S15069/T2465-T2466) says an ambiguous side is a warning that nobody
 * is compelled to repair. The writable snapshot is therefore exactly the three
 * ordinary classes the caller hands in.
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

  const eraCutoffEpoch =
    input.eraCutoffEpoch !== undefined ? input.eraCutoffEpoch : resolveEraCutoff(db);
  const laneMembers = snapshotLaneMembers(
    db,
    input.worklist,
    ordinary,
    eraCutoffEpoch,
  );

  // SNAPSHOT #4 (ticket 06): the other endpoint of every live outgoing edge of
  // a writable citer, which stage 2 has to read before it can judge that
  // citer's edges.
  const declarationEndpointIds = enumerateDeclarationEndpoints(db, [...writable.keys()]);
  const readDeltas = computeSettlementReadDeltas({
    writable,
    laneMembers,
    declarationEndpointIds,
  });

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

  const insertEndpoint = db.query<unknown, [number, number]>(
    `INSERT INTO note_settlement_declaration_endpoints (job_id, turn_id)
     VALUES (?, ?)`,
  );
  for (const turnId of declarationEndpointIds) {
    insertEndpoint.run(input.jobId, turnId);
  }

  return {
    writable,
    worklist: input.worklist,
    laneMembers,
    declarationEndpointIds,
    readDeltas,
  };
}

/** SQLite's parameter ceiling is the only reason the endpoint read is chunked. */
const DECLARATION_ENDPOINT_ID_CHUNK = 400;

/**
 * The OTHER endpoint of every live outgoing edge of the given citers — the
 * turns stage 2 must have read before it can declare or review those edges.
 *
 * Same boundaries as the two closures: turn→turn rows, live on both ends,
 * carrying a class. The citer itself is returned only when it is the cited
 * end of another citer's edge (it is in the writable set already and the
 * delta subtracts it). Ascending, deduplicated.
 */
function enumerateDeclarationEndpoints(
  db: Database,
  citerTurnIds: readonly number[],
): number[] {
  const endpoints = new Set<number>();
  for (let offset = 0; offset < citerTurnIds.length; offset += DECLARATION_ENDPOINT_ID_CHUNK) {
    const chunk = citerTurnIds.slice(offset, offset + DECLARATION_ENDPOINT_ID_CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db
      .query<{ citedId: number }, number[]>(
        `SELECT DISTINCT me.cited_id AS citedId
           FROM memory_edges me
           JOIN turns tc ON tc.id = me.citing_id
           JOIN turns td ON td.id = me.cited_id
          WHERE me.citing_id IN (${placeholders})
            AND me.citing_kind = 'turn' AND me.cited_kind = 'turn'
            AND ${relationClassBearingSql("me")}
            AND ${liveTurnSql("tc")} AND ${liveTurnSql("td")}`,
      )
      .all(...chunk);
    for (const row of rows) {
      endpoints.add(row.citedId);
    }
  }
  return [...endpoints].sort((a, b) => a - b);
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
  return { lanes };
}

/** Snapshot #4, ascending: the other endpoint of every live outgoing edge of a writable citer at transition time. */
export function readNoteSettlementDeclarationEndpointSnapshot(
  db: Database,
  jobId: number,
): number[] {
  ensureNoteSettlementSnapshotTables(db);
  return db
    .query<{ turnId: number }, [number]>(
      `SELECT turn_id AS turnId
         FROM note_settlement_declaration_endpoints
        WHERE job_id = ?
        ORDER BY turn_id ASC`,
    )
    .all(jobId)
    .map((row) => row.turnId);
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
