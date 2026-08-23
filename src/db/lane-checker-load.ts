import type { Database } from "bun:sqlite";

import {
  canonicalTagSet,
  DEFAULT_SEGMENT,
  laneToken,
  type LaneEdgeInput,
  type LaneKey,
  type LaneTurnInput,
} from "../shared/lane-interpretation";
import { EDGE_RELATIONS, STANCE_RELATIONS } from "../shared/turn-phase";
import { liveTurnSql } from "./turn-liveness";

/**
 * The lane checker's read-only DB adapter (rubric-v10 ticket 06). Translates
 * a scope request into the pure core's input shape
 * (`LaneTurnInput[]`/`LaneEdgeInput[]`, `shared/lane-interpretation.ts`) —
 * every id in both arrays is a `turns.id` (the same global, monotonically
 * increasing space `memory_edges.citing_id`/`cited_id` already use for
 * `citing_kind = 'turn'` rows), so no id translation happens anywhere in
 * this file: an edge row's `citing_id`/`cited_id` IS the `LaneTurnInput.id`
 * a caller needs, and `LaneTurnInput.id`'s own doc ("whatever id space the
 * caller addresses turns by, assumed order-comparable") is satisfied for
 * free by the fact that `turns.id` is assigned in insertion order.
 *
 * LAW 8 (indexes-rescope spec, `db/turn-liveness.ts`): every query below
 * that reads `memory_edges` joins both endpoints against `turns` and applies
 * `liveTurnSql` to each — a rolled-back or skipped turn is never a node,
 * never an edge endpoint, exactly like every other read side in this
 * codebase. This is enforced at the SQL layer, not filtered in JS after the
 * fact, so a dead/dormant turn never even reaches the widening logic below.
 *
 * WIDENING (requirement 1: "projection must widen beyond the requested range
 * to each involved lane's full live edges"). Read in three phases:
 *
 *   1. SEED — resolve the scope (a session's prompt-number range, a whole
 *      segment's members, or explicitly named lanes) into a starting turn-id
 *      set (empty for the `lanes` scope, whose seed IS the named lane).
 *   2. DISCOVER — for `range`/`segment` scopes, find every LANE (segment +
 *      exact canonical tag set) touched by a tagged edge with either
 *      endpoint in the seed set. The `lanes` scope skips this: its lane set
 *      is exactly what the caller named. BOTH endpoints' owning segments
 *      yield a lane key (round-5 review #13) — a cross-segment tagged edge
 *      is a real, legal shape (`lane-interpretation.ts`'s own dual
 *      appearance), so discovering only the citing side's copy would leave
 *      the cited side's own segment scan blind to a lane it is genuinely a
 *      member of.
 *   3. WIDEN — for every involved lane, load its FULL tagged edge set
 *      (every `memory_edges` row anywhere in the database whose canonical
 *      tag set matches exactly, filtered to match the lane's own segment
 *      from EITHER endpoint, round-5 review #13 — the same dual-appearance
 *      reasoning as DISCOVER, applied on the read-back side so a
 *      caller-named lane resolves regardless of which side of a
 *      cross-segment edge it names), not merely the rows that happened to
 *      touch the seed range. This is what makes a lane declared long before
 *      or extended long after the requested window still resolve whole.
 *
 * A fourth pass loads the SUPPLEMENTARY edges the core's reports need beyond
 * a lane's own tagged edges: cross-phase citedness into lane members
 * (report 1/4), untagged override touching a member (global kill, dead-node
 * detection), and the component graph report 2/3 needs. For a REAL segment
 * this is the SEGMENT-GLOBAL pass (round-4 review #4): every live turn owned
 * by each involved lane's own segment, plus every live
 * LANE_COMPONENT_RELATIONS edge with BOTH endpoints inside that segment-wide
 * turn set. A default-segment (homeless) lane has no `segment_members` rows
 * to widen from at all, so it instead gets an iterative FIXPOINT closure
 * (round-5 review #12) — BFS over LANE_COMPONENT_RELATIONS edges starting
 * from the lane's own members, one hop at a time, until no new turn is
 * discovered, bounded to the sessions the lane's own members already live
 * in (never a database-wide walk). This replaces the old one-hop-only
 * "touching" load, which saw only a member's immediate neighbours and lost
 * any bridge edge more than one hop away (a chain `T2->T1, T3->T2, T4->T3`
 * with only T1/T4 tagged would report the bridge severed at T2/T3, when the
 * true graph is one component) — no hop-count approximation remains
 * anywhere in report 2's graph.
 *
 * COVERAGE (requirement 1's other half). The core's own report 1
 * (`LaneStatsReport.coverage`) is the honest signal: it is populated
 * whenever a lane member id appears as a tagged edge's endpoint with no
 * matching entry in the `turns` array handed to `checkLanes`. This adapter
 * never fabricates a placeholder turn for an id it could not resolve, so
 * that field reports exactly what this file actually managed to load —
 * nothing here manufactures false completeness.
 */

export type LaneCheckScope =
  | { kind: "range"; sessionId: number; promptStart: number; promptEnd: number }
  | { kind: "segment"; segmentId: number }
  | { kind: "lanes"; laneKeys: readonly LaneKey[] };

export interface LaneCheckProjection {
  turns: LaneTurnInput[];
  edges: LaneEdgeInput[];
  /** The lanes this projection widened to cover — informational only, never fed back into the core (the core re-derives lanes from `turns`/`edges` itself). */
  involvedLaneKeys: LaneKey[];
  /**
   * Semantic-conformance ticket 02: edges among `turns` whose relation lies
   * outside `EDGE_RELATIONS` (e.g. the frozen-legacy `supersedes`) — a
   * SEPARATE field, deliberately never merged into `edges` above. Feed this
   * to `checkLanes`'s own third parameter, never straight into
   * `deriveLaneInterpretation`: `mcp/note.ts`'s Gate C self-`grounds`
   * terminus check reduces `projection.edges` directly with that function,
   * and merging an out-of-vocabulary relation into the shared `edges` array
   * would have widened THAT caller's graph too, not just the checker's own.
   */
  outOfVocabularyEdges: LaneEdgeInput[];
}

interface TurnLiteRow {
  id: number;
  type: string;
  sessionId: number;
  promptNumber: number;
  /** rubric-v10 ticket 08: plumbed straight onto `LaneTurnInput.createdAtEpoch` — the ONLY reader is `lane-checker.ts`'s report-4(c) time-order check, for the cross-session half of that comparison (`order`'s `[session_id, prompt_number]` tuple is never compared across sessions — a `session_id` carries no wall-clock meaning relative to another session's). */
  createdAtEpoch: number;
}

/**
 * The true reduction-order key (round-4 review #2): `(session_id,
 * prompt_number)` position, never the row's own `id` — a backfilled turn can
 * be inserted after (and so carry a higher row id than) turns that
 * chronologically follow it. `sessionId` is itself an auto-increment id
 * (monotonic in session-creation order), so this compound key is a total
 * order across sessions too, not just within one.
 *
 * Round-5 review #10: an EARLIER version of this file collapsed the pair
 * into one scalar (`sessionId * SPAN + promptNumber`). That both COLLIDES
 * (`1 * SPAN + SPAN === 2 * SPAN + 0` for any `SPAN`, whenever a smaller
 * `sessionId`'s `promptNumber` reaches exactly one `SPAN`) and LOSES
 * PRECISION at realistic magnitudes (`SPAN * SPAN + 0 === SPAN * SPAN + 1`
 * once the product exceeds `Number.MAX_SAFE_INTEGER`'s headroom, which a
 * `SPAN` of 1e8 already does the moment `sessionId` itself reaches 1e8).
 * `LaneTurnInput.order` is a TUPLE now (`shared/lane-interpretation.ts`'s
 * `LaneOrderKey`), compared lexicographically by the core — so the pair is
 * carried through unencoded, with neither failure mode.
 */
function turnOrderKey(sessionId: number, promptNumber: number): readonly [number, number] {
  return [sessionId, promptNumber];
}

interface EdgeLiteRow {
  citingId: number;
  citedId: number;
  relation: string;
  tags: string;
}

const CROSS_PHASE_CITEDNESS_RELATIONS = ["grounds", "verifies", "refutes"] as const;
/** Same word set `lane-checker.ts`'s `LANE_COMPONENT_RELATIONS` reads — stance (narrows/extends) + consume + grounds. Redeclared as a plain SQL `IN` list rather than importing that constant, so this file never depends on `lane-checker.ts` (only on the pure-data types `lane-interpretation.ts` exports) — the adapter is a peer of the checker, not a wrapper around one of its internals. */
const LANE_COMPONENT_RELATIONS_SQL = [...STANCE_RELATIONS, "consume", "grounds"] as const;

function edgeKey(row: EdgeLiteRow): string {
  return `${row.citingId}\u0000${row.citedId}\u0000${row.relation}\u0000${row.tags}`;
}

function segmentKeyFor(owningSegmentByTurn: ReadonlyMap<number, number>, turnId: number): string {
  const segmentId = owningSegmentByTurn.get(turnId);
  return segmentId === undefined ? DEFAULT_SEGMENT : String(segmentId);
}

/**
 * The same-shape lookup key `deriveLaneInterpretation` uses internally,
 * reused directly rather than re-implemented (round-5 review #14: a
 * separately maintained delimiter join here drifted from the core's own
 * fix and reintroduced the identical collision — a tag containing the
 * delimiter character collides one tag set with a differently-split one).
 */
function laneKeyToken(key: LaneKey): string {
  return laneToken(key.segment, key.tagSet);
}

/** Every `segment_members` row's owning segment for the given turn ids, batched in one query (`MIN` mirrors `getOwningSegmentId`'s own "lowest id wins" tie-break for a legacy multi-membership row). */
function loadOwningSegments(db: Database, turnIds: readonly number[]): Map<number, number> {
  const ids = [...new Set(turnIds)];
  if (ids.length === 0) {
    return new Map();
  }
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .query<{ turnId: number; segmentId: number }, number[]>(
      `SELECT turn_id AS turnId, MIN(segment_id) AS segmentId
       FROM segment_members
       WHERE turn_id IN (${placeholders})
       GROUP BY turn_id`,
    )
    .all(...ids);
  return new Map(rows.map((row) => [row.turnId, row.segmentId]));
}

function resolveSeedTurnIds(
  db: Database,
  scope: Extract<LaneCheckScope, { kind: "range" | "segment" }>,
): number[] {
  if (scope.kind === "range") {
    return db
      .query<{ id: number }, [number, number, number]>(
        `SELECT id FROM turns
         WHERE session_id = ? AND prompt_number BETWEEN ? AND ?
           AND ${liveTurnSql()}
         ORDER BY prompt_number ASC`,
      )
      .all(scope.sessionId, scope.promptStart, scope.promptEnd)
      .map((row) => row.id);
  }

  return db
    .query<{ id: number }, [number]>(
      `SELECT t.id AS id
       FROM turns t
       JOIN segment_members sm ON sm.turn_id = t.id
       WHERE sm.segment_id = ? AND ${liveTurnSql("t")}
       ORDER BY t.created_at_epoch ASC, t.id ASC`,
    )
    .all(scope.segmentId)
    .map((row) => row.id);
}

/** Every live, tagged, relation-carrying turn-turn edge touching any of `turnIds` (either endpoint) — the DISCOVERY pass's raw material. */
function loadTaggedEdgesTouching(db: Database, turnIds: readonly number[]): EdgeLiteRow[] {
  if (turnIds.length === 0) {
    return [];
  }
  const placeholders = turnIds.map(() => "?").join(",");
  return db
    .query<EdgeLiteRow, number[]>(
      `SELECT me.citing_id AS citingId, me.cited_id AS citedId, me.relation, me.tags
       FROM memory_edges me
       JOIN turns tc ON tc.id = me.citing_id
       JOIN turns td ON td.id = me.cited_id
       WHERE (me.citing_id IN (${placeholders}) OR me.cited_id IN (${placeholders}))
         AND me.citing_kind = 'turn' AND me.cited_kind = 'turn'
         AND me.relation IS NOT NULL AND me.tags != '[]'
         AND ${liveTurnSql("tc")} AND ${liveTurnSql("td")}`,
    )
    .all(...turnIds, ...turnIds);
}

/** Every live, relation-carrying turn-turn edge anywhere in the database whose canonical tag set is exactly `tagSet` — the WIDEN pass. `memory_edge_tags` (indexed on `tag`) narrows the scan to candidates carrying one of the set's own tags before the exact-set filter runs in JS. */
function loadEdgesForExactTagSet(db: Database, tagSet: readonly string[]): EdgeLiteRow[] {
  if (tagSet.length === 0) {
    return [];
  }
  const rows = db
    .query<EdgeLiteRow, [string]>(
      `SELECT me.citing_id AS citingId, me.cited_id AS citedId, me.relation, me.tags
       FROM memory_edges me
       JOIN turns tc ON tc.id = me.citing_id
       JOIN turns td ON td.id = me.cited_id
       WHERE me.id IN (SELECT edge_row_id FROM memory_edge_tags WHERE tag = ?)
         AND me.citing_kind = 'turn' AND me.cited_kind = 'turn'
         AND me.relation IS NOT NULL
         AND ${liveTurnSql("tc")} AND ${liveTurnSql("td")}`,
    )
    .all(tagSet[0]!);
  const wanted = canonicalTagSet(tagSet).join("\u0001");
  return rows.filter((row) => canonicalTagSet(JSON.parse(row.tags) as string[]).join("\u0001") === wanted);
}

/** Every live turn-turn edge touching any of `turnIds` (either endpoint) whose relation is one of `relations` — the SUPPLEMENTARY pass (cross-phase citedness, untagged override, the component neighbourhood). */
function loadEdgesByRelationTouching(
  db: Database,
  turnIds: readonly number[],
  relations: readonly string[],
): EdgeLiteRow[] {
  if (turnIds.length === 0 || relations.length === 0) {
    return [];
  }
  const idPlaceholders = turnIds.map(() => "?").join(",");
  const relationPlaceholders = relations.map(() => "?").join(",");
  return db
    .query<EdgeLiteRow, (number | string)[]>(
      `SELECT me.citing_id AS citingId, me.cited_id AS citedId, me.relation, me.tags
       FROM memory_edges me
       JOIN turns tc ON tc.id = me.citing_id
       JOIN turns td ON td.id = me.cited_id
       WHERE (me.citing_id IN (${idPlaceholders}) OR me.cited_id IN (${idPlaceholders}))
         AND me.citing_kind = 'turn' AND me.cited_kind = 'turn'
         AND me.relation IN (${relationPlaceholders})
         AND ${liveTurnSql("tc")} AND ${liveTurnSql("td")}`,
    )
    .all(...turnIds, ...turnIds, ...relations);
}

/** Every live turn id owned by `segmentId` — the SEGMENT-GLOBAL membership set (round-4 review #4a), not filtered to any particular lane's tagged edges. */
function loadSegmentTurnIds(db: Database, segmentId: number): number[] {
  return db
    .query<{ id: number }, [number]>(
      `SELECT t.id AS id
       FROM turns t
       JOIN segment_members sm ON sm.turn_id = t.id
       WHERE sm.segment_id = ? AND ${liveTurnSql("t")}`,
    )
    .all(segmentId)
    .map((row) => row.id);
}

/** Every live `LANE_COMPONENT_RELATIONS_SQL` edge with BOTH endpoints inside `turnIds` — "all stance/consume/grounds edges among" a segment's own turns (round-4 review #4a), as opposed to `loadEdgesByRelationTouching`'s one-hop-from-a-member "touching" scope. */
function loadComponentEdgesAmong(db: Database, turnIds: readonly number[]): EdgeLiteRow[] {
  if (turnIds.length === 0) {
    return [];
  }
  const idPlaceholders = turnIds.map(() => "?").join(",");
  const relationPlaceholders = LANE_COMPONENT_RELATIONS_SQL.map(() => "?").join(",");
  return db
    .query<EdgeLiteRow, (number | string)[]>(
      `SELECT me.citing_id AS citingId, me.cited_id AS citedId, me.relation, me.tags
       FROM memory_edges me
       JOIN turns tc ON tc.id = me.citing_id
       JOIN turns td ON td.id = me.cited_id
       WHERE me.citing_id IN (${idPlaceholders}) AND me.cited_id IN (${idPlaceholders})
         AND me.citing_kind = 'turn' AND me.cited_kind = 'turn'
         AND me.relation IN (${relationPlaceholders})
         AND ${liveTurnSql("tc")} AND ${liveTurnSql("td")}`,
    )
    .all(...turnIds, ...turnIds, ...LANE_COMPONENT_RELATIONS_SQL);
}

/**
 * Every live relation-carrying edge with BOTH endpoints inside `turnIds`
 * whose `relation` lies OUTSIDE `EDGE_RELATIONS` (semantic-conformance
 * ticket 02) — e.g. the frozen-legacy `supersedes`, still storable
 * (`db/citations.ts`'s `CITATION_RELATIONS` carries a ninth word this
 * module's own write vocabulary never did) but never surfaced by any of
 * this file's other passes, which all filter to specific IN-vocabulary
 * relation lists (or require `tags != '[]'`, and a frozen-legacy relation
 * predates the tag model and is never tagged). Scoped to turns ALREADY in
 * `turnIds` — never a reason to widen the loaded turn set further, since
 * these rows are reported as a bare fact by the checker, not resolved into
 * lane membership. `loadLaneCheckScope` calls this with the FINAL
 * `allTurnIds` set, so both endpoints are guaranteed already present among
 * the turns this projection returns — no dangling-edge risk.
 */
function loadOutOfVocabularyEdgesAmong(db: Database, turnIds: readonly number[]): EdgeLiteRow[] {
  if (turnIds.length === 0) {
    return [];
  }
  const idPlaceholders = turnIds.map(() => "?").join(",");
  const relationPlaceholders = EDGE_RELATIONS.map(() => "?").join(",");
  return db
    .query<EdgeLiteRow, (number | string)[]>(
      `SELECT me.citing_id AS citingId, me.cited_id AS citedId, me.relation, me.tags
       FROM memory_edges me
       JOIN turns tc ON tc.id = me.citing_id
       JOIN turns td ON td.id = me.cited_id
       WHERE me.citing_id IN (${idPlaceholders}) AND me.cited_id IN (${idPlaceholders})
         AND me.citing_kind = 'turn' AND me.cited_kind = 'turn'
         AND me.relation IS NOT NULL AND me.relation NOT IN (${relationPlaceholders})
         AND ${liveTurnSql("tc")} AND ${liveTurnSql("td")}`,
    )
    .all(...turnIds, ...turnIds, ...EDGE_RELATIONS);
}

/** Every DISTINCT session id the given turns belong to — the session bound `widenComponentClosure` (round-5 review #12) stays inside. */
function loadSessionIds(db: Database, turnIds: readonly number[]): number[] {
  const ids = [...new Set(turnIds)];
  if (ids.length === 0) {
    return [];
  }
  const placeholders = ids.map(() => "?").join(",");
  return db
    .query<{ sessionId: number }, number[]>(
      `SELECT DISTINCT session_id AS sessionId FROM turns WHERE id IN (${placeholders})`,
    )
    .all(...ids)
    .map((row) => row.sessionId);
}

/**
 * Iterative FIXPOINT closure over `LANE_COMPONENT_RELATIONS_SQL` edges
 * (round-5 review #12) — the replacement for the old one-hop "touching"
 * load, which only ever saw a member's immediate neighbours and lost any
 * bridge edge more than one hop away (`T2->T1, T3->T2, T4->T3` with only
 * T1/T4 tagged reported the chain severed at T2/T3). BFS one hop at a time
 * from `seedIds`, feeding each round's newly discovered turn ids back in as
 * the next round's frontier, until a round discovers nothing new. Bounded to
 * `sessionIds` — never a database-wide walk — so an edge whose far endpoint
 * sits outside the lane's own sessions is simply not traversed, the same
 * "declared boundary, not silently unbounded" posture `liveTurnSql`'s own
 * law-8 gate takes elsewhere in this file.
 */
function widenComponentClosure(
  db: Database,
  seedIds: readonly number[],
  sessionIds: readonly number[],
): EdgeLiteRow[] {
  if (seedIds.length === 0 || sessionIds.length === 0) {
    return [];
  }
  const sessionPlaceholders = sessionIds.map(() => "?").join(",");
  const relationPlaceholders = LANE_COMPONENT_RELATIONS_SQL.map(() => "?").join(",");
  const found = new Map<string, EdgeLiteRow>();
  const knownTurnIds = new Set<number>(seedIds);
  let frontier = new Set<number>(seedIds);
  while (frontier.size > 0) {
    const frontierIds = [...frontier];
    const idPlaceholders = frontierIds.map(() => "?").join(",");
    const rows = db
      .query<EdgeLiteRow, (number | string)[]>(
        `SELECT me.citing_id AS citingId, me.cited_id AS citedId, me.relation, me.tags
         FROM memory_edges me
         JOIN turns tc ON tc.id = me.citing_id
         JOIN turns td ON td.id = me.cited_id
         WHERE (me.citing_id IN (${idPlaceholders}) OR me.cited_id IN (${idPlaceholders}))
           AND me.citing_kind = 'turn' AND me.cited_kind = 'turn'
           AND me.relation IN (${relationPlaceholders})
           AND tc.session_id IN (${sessionPlaceholders}) AND td.session_id IN (${sessionPlaceholders})
           AND ${liveTurnSql("tc")} AND ${liveTurnSql("td")}`,
      )
      .all(...frontierIds, ...frontierIds, ...LANE_COMPONENT_RELATIONS_SQL, ...sessionIds, ...sessionIds);
    const nextFrontier = new Set<number>();
    for (const row of rows) {
      found.set(edgeKey(row), row);
      for (const id of [row.citingId, row.citedId]) {
        if (!knownTurnIds.has(id)) {
          knownTurnIds.add(id);
          nextFrontier.add(id);
        }
      }
    }
    frontier = nextFrontier;
  }
  return [...found.values()];
}

function loadLiveTurns(db: Database, turnIds: readonly number[]): Map<number, TurnLiteRow> {
  const ids = [...new Set(turnIds)];
  if (ids.length === 0) {
    return new Map();
  }
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .query<TurnLiteRow, number[]>(
      `SELECT id, type, session_id AS sessionId, prompt_number AS promptNumber, created_at_epoch AS createdAtEpoch
       FROM turns WHERE id IN (${placeholders}) AND ${liveTurnSql()}`,
    )
    .all(...ids);
  return new Map(rows.map((row) => [row.id, row]));
}

function toEdgeInput(row: EdgeLiteRow): LaneEdgeInput {
  return {
    citingId: row.citingId,
    citedId: row.citedId,
    relation: row.relation,
    tags: canonicalTagSet(JSON.parse(row.tags) as string[]),
  };
}

/**
 * Load one scope into the core's input shape. Read-only: every statement in
 * this module and its helpers is a `SELECT`, and this function never opens
 * its own connection — the caller (the CLI, hard-`readonly`; the settlement
 * tool, the worker's own live handle) owns that decision.
 */
export function loadLaneCheckScope(db: Database, scope: LaneCheckScope): LaneCheckProjection {
  let involvedLaneKeys: LaneKey[];
  let seedTurnIds: number[];

  if (scope.kind === "lanes") {
    involvedLaneKeys = [...scope.laneKeys];
    seedTurnIds = [];
  } else {
    seedTurnIds = resolveSeedTurnIds(db, scope);
    const discoveryRows = loadTaggedEdgesTouching(db, seedTurnIds);
    // Round-5 review #13: both endpoints' owning segments yield a lane key,
    // not just the citing side's — a cross-segment tagged edge dual-
    // registers under BOTH segments in the pure core, and discovery must
    // find both copies so either side's own segment scan sees its own
    // membership.
    const owningSegments = loadOwningSegments(
      db,
      discoveryRows.flatMap((row) => [row.citingId, row.citedId]),
    );
    const seen = new Map<string, LaneKey>();
    for (const row of discoveryRows) {
      const tagSet = canonicalTagSet(JSON.parse(row.tags) as string[]);
      const citingKey: LaneKey = { segment: segmentKeyFor(owningSegments, row.citingId), tagSet };
      const citedKey: LaneKey = { segment: segmentKeyFor(owningSegments, row.citedId), tagSet };
      seen.set(laneKeyToken(citingKey), citingKey);
      seen.set(laneKeyToken(citedKey), citedKey);
    }
    involvedLaneKeys = [...seen.values()];
  }

  // ---- WIDEN: each involved lane's full tagged edge set, its own segment only ----
  const widenedByKey = new Map<string, EdgeLiteRow[]>();
  for (const laneKey of involvedLaneKeys) {
    const candidates = loadEdgesForExactTagSet(db, laneKey.tagSet);
    if (candidates.length === 0) {
      widenedByKey.set(laneKeyToken(laneKey), []);
      continue;
    }
    const owningSegments = loadOwningSegments(
      db,
      candidates.flatMap((row) => [row.citingId, row.citedId]),
    );
    // Round-5 review #13: match from EITHER endpoint's segment — a named
    // lane's own dual-registered cross-segment copy must resolve regardless
    // of which side of the edge carries the segment being asked about
    // (the pure core dual-registers once the edge is loaded either way).
    widenedByKey.set(
      laneKeyToken(laneKey),
      candidates.filter(
        (row) =>
          segmentKeyFor(owningSegments, row.citingId) === laneKey.segment ||
          segmentKeyFor(owningSegments, row.citedId) === laneKey.segment,
      ),
    );
  }

  const edgeMap = new Map<string, EdgeLiteRow>();
  for (const rows of widenedByKey.values()) {
    for (const row of rows) {
      edgeMap.set(edgeKey(row), row);
    }
  }

  // ---- member set: every endpoint of every widened tagged edge, plus the seed ----
  const memberIds = new Set<number>(seedTurnIds);
  for (const row of edgeMap.values()) {
    memberIds.add(row.citingId);
    memberIds.add(row.citedId);
  }
  const memberIdList = [...memberIds];

  // ---- SUPPLEMENTARY: citedness, global-kill override, the component neighbourhood ----
  for (const row of loadEdgesByRelationTouching(db, memberIdList, [...CROSS_PHASE_CITEDNESS_RELATIONS])) {
    edgeMap.set(edgeKey(row), row);
  }
  for (const row of loadEdgesByRelationTouching(db, memberIdList, ["override"])) {
    edgeMap.set(edgeKey(row), row);
  }
  // HOMELESS-LANE FIXPOINT CLOSURE (round-5 review #12): a default-segment
  // lane has no `segment_members` to widen from at all, so its own members
  // get an iterative BFS closure over LANE_COMPONENT_RELATIONS edges instead
  // of the old one-hop "touching" load — bounded to the sessions those
  // members already live in.
  const homelessMemberIds = new Set<number>();
  for (const laneKey of involvedLaneKeys) {
    if (laneKey.segment !== DEFAULT_SEGMENT) continue;
    for (const row of widenedByKey.get(laneKeyToken(laneKey)) ?? []) {
      homelessMemberIds.add(row.citingId);
      homelessMemberIds.add(row.citedId);
    }
  }
  if (homelessMemberIds.size > 0) {
    const homelessSessionIds = loadSessionIds(db, [...homelessMemberIds]);
    for (const row of widenComponentClosure(db, [...homelessMemberIds], homelessSessionIds)) {
      edgeMap.set(edgeKey(row), row);
    }
  }
  // SEGMENT-GLOBAL component graph (round-4 review #4a): every live turn
  // owned by each involved lane's own (real) segment, plus every live
  // component-relation edge with BOTH endpoints in that turn set.
  const realSegmentIds = [...new Set(involvedLaneKeys.map((key) => key.segment).filter((s) => s !== DEFAULT_SEGMENT))];
  const segmentTurnIds = new Set<number>();
  for (const segmentId of realSegmentIds) {
    for (const id of loadSegmentTurnIds(db, Number(segmentId))) {
      segmentTurnIds.add(id);
    }
  }
  for (const row of loadComponentEdgesAmong(db, [...segmentTurnIds])) {
    edgeMap.set(edgeKey(row), row);
  }

  const allTurnIds = new Set(memberIdList);
  for (const row of edgeMap.values()) {
    allTurnIds.add(row.citingId);
    allTurnIds.add(row.citedId);
  }

  // OUT-OF-VOCABULARY EDGES (semantic-conformance ticket 02): both endpoints
  // are already members of `allTurnIds` by the query's own WHERE clause, so
  // this cannot introduce a new turn id. Kept on its OWN field — never
  // merged into `edgeMap`/`edges` — so `mcp/note.ts`'s Gate C self-`grounds`
  // terminus check, the one OTHER reader of `projection.edges` in this
  // codebase, never has its own `deriveLaneInterpretation` re-derivation
  // widened by a relation it was never scoped to see (`LaneCheckProjection`'s
  // own doc comment). `checkLanes` (`shared/lane-checker.ts`) is what keeps
  // these OUT of every graph computation once they DO reach it, through its
  // own third parameter.
  const outOfVocabularyEdges = loadOutOfVocabularyEdgesAmong(db, [...allTurnIds])
    .map(toEdgeInput)
    .sort((a, b) => {
      if (a.citingId !== b.citingId) return a.citingId - b.citingId;
      if (a.citedId !== b.citedId) return a.citedId - b.citedId;
      return a.relation.localeCompare(b.relation);
    });

  const turnRows = loadLiveTurns(db, [...allTurnIds]);
  const owningSegmentsForTurns = loadOwningSegments(db, [...allTurnIds]);

  const turns: LaneTurnInput[] = [...turnRows.values()]
    .map((row) => {
      const segmentId = owningSegmentsForTurns.get(row.id);
      const input: LaneTurnInput = {
        id: row.id,
        type: JSON.parse(row.type) as string[],
        order: turnOrderKey(row.sessionId, row.promptNumber),
        createdAtEpoch: row.createdAtEpoch,
      };
      if (segmentId !== undefined) {
        input.segment = String(segmentId);
      }
      return input;
    })
    .sort((a, b) => a.id - b.id);

  const edges: LaneEdgeInput[] = [...edgeMap.values()].map(toEdgeInput).sort((a, b) => {
    if (a.citingId !== b.citingId) return a.citingId - b.citingId;
    if (a.citedId !== b.citedId) return a.citedId - b.citedId;
    return a.relation.localeCompare(b.relation);
  });

  return { turns, edges, involvedLaneKeys, outOfVocabularyEdges };
}

// Re-exported so a consumer (the CLI, the settlement tool) that only needs
// the relation vocabulary for validating a `--lane` argument's shape need
// not also import `turn-phase.ts` directly.
export { EDGE_RELATIONS };

// Re-exported so a consumer (`mcp/note.ts`'s settlement `lane_check` tool)
// that names a lane by its own `LaneKey` need not also import
// `shared/lane-interpretation.ts` directly — pre-existing gap, not part of
// this batch's own defect set, fixed in passing since it lives in this
// module's own export surface.
export type { LaneKey };
