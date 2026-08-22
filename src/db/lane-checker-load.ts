import type { Database } from "bun:sqlite";

import {
  canonicalTagSet,
  DEFAULT_SEGMENT,
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
 *      is exactly what the caller named.
 *   3. WIDEN — for every involved lane, load its FULL tagged edge set
 *      (every `memory_edges` row anywhere in the database whose canonical
 *      tag set matches exactly, filtered to the lane's own segment), not
 *      merely the rows that happened to touch the seed range. This is what
 *      makes a lane declared long before or extended long after the
 *      requested window still resolve whole.
 *
 * A fourth pass loads the SUPPLEMENTARY edges the core's reports need beyond
 * a lane's own tagged edges: cross-phase citedness into lane members
 * (report 1/4), untagged override touching a member (global kill, dead-node
 * detection), and the LANE_COMPONENT_RELATIONS neighbourhood one hop out
 * from every member (report 2/3's shared-component graph). This is a
 * ONE-HOP neighbourhood, not a full transitive closure — an honest, bounded
 * approximation the module comment above `loadLaneCheckScope` documents as
 * this adapter's own limit, not the core's.
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
}

interface TurnLiteRow {
  id: number;
  type: string;
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

function laneKeyToken(key: LaneKey): string {
  return `${key.segment}\u0000${key.tagSet.join("\u0001")}`;
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

function loadLiveTurns(db: Database, turnIds: readonly number[]): Map<number, TurnLiteRow> {
  const ids = [...new Set(turnIds)];
  if (ids.length === 0) {
    return new Map();
  }
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .query<TurnLiteRow, number[]>(
      `SELECT id, type FROM turns WHERE id IN (${placeholders}) AND ${liveTurnSql()}`,
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
    const citingIds = discoveryRows.map((row) => row.citingId);
    const owningSegments = loadOwningSegments(db, citingIds);
    const seen = new Map<string, LaneKey>();
    for (const row of discoveryRows) {
      const key: LaneKey = {
        segment: segmentKeyFor(owningSegments, row.citingId),
        tagSet: canonicalTagSet(JSON.parse(row.tags) as string[]),
      };
      seen.set(laneKeyToken(key), key);
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
      candidates.map((row) => row.citingId),
    );
    widenedByKey.set(
      laneKeyToken(laneKey),
      candidates.filter((row) => segmentKeyFor(owningSegments, row.citingId) === laneKey.segment),
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
  for (const row of loadEdgesByRelationTouching(db, memberIdList, [...LANE_COMPONENT_RELATIONS_SQL])) {
    edgeMap.set(edgeKey(row), row);
  }

  const allTurnIds = new Set(memberIdList);
  for (const row of edgeMap.values()) {
    allTurnIds.add(row.citingId);
    allTurnIds.add(row.citedId);
  }

  const turnRows = loadLiveTurns(db, [...allTurnIds]);
  const owningSegmentsForTurns = loadOwningSegments(db, [...allTurnIds]);

  const turns: LaneTurnInput[] = [...turnRows.values()]
    .map((row) => {
      const segmentId = owningSegmentsForTurns.get(row.id);
      const input: LaneTurnInput = {
        id: row.id,
        type: JSON.parse(row.type) as string[],
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

  return { turns, edges, involvedLaneKeys };
}

// Re-exported so a consumer (the CLI, the settlement tool) that only needs
// the relation vocabulary for validating a `--lane` argument's shape need
// not also import `turn-phase.ts` directly.
export { EDGE_RELATIONS };
