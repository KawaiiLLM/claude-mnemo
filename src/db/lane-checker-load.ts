import type { Database } from "bun:sqlite";

import type { LaneCheckerTurnInput, LaneSegmentFacts } from "../shared/lane-checker";
import {
  canonicalTagSet,
  DEFAULT_SEGMENT,
  laneToken,
  type LaneEdgeInput,
  type LaneKey,
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
 *      segment's members, an EXPLICIT turn-id set, or explicitly named lanes)
 *      into a starting turn-id set (empty for the `lanes` scope, whose seed
 *      IS the named lane).
 *   2. DISCOVER — for the three seeded scopes, find every LANE (segment + ONE
 *      tag: `LaneKey` is `{segment, tag}`, not `{segment, tagSet}`) NAMED by
 *      an edge with either endpoint in the seed set. Since ticket 06 the
 *      pass selects on the SIDE columns (`tail_tag <> '' OR head_tag <> ''`)
 *      and mints ONE key per SETTLED SIDE — `(segment of citing, tail_tag)`
 *      and `(segment of cited, head_tag)`. On today's stock (`tail === head`)
 *      those are exactly the two keys the old per-tag × per-endpoint-segment
 *      fan-out produced, so nothing moves; on a CROSS-LANE row they are two
 *      genuinely different lanes, and on a CROSS-SEGMENT row they are the two
 *      lanes the edge crosses between (the pure core then registers the edge
 *      in NEITHER — see `lane-interpretation.ts`). The `lanes` scope skips
 *      this: its lane set is exactly what the caller named.
 *   3. WIDEN — for every involved lane, load its FULL edge set (every
 *      `memory_edges` row anywhere in the database carrying the lane's tag on
 *      EITHER SIDE — `memory_edge_side_tags`, ticket 06 — then filtered PER
 *      SIDE: the tail is kept only when the CITING turn is owned by the
 *      lane's segment, the head only when the CITED turn is), not merely the
 *      rows that happened to touch the seed range. This is what makes a lane
 *      declared long before or extended long after the requested window still
 *      resolve whole. The side index is the COMPLETE match on its own — no
 *      JS-side set comparison is layered on top (that filter's own
 *      collision-safety reasoning, round-5 review #14, is now `laneToken`'s
 *      own job — see `laneKeyToken`).
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
 * SKIP/ROLLBACK EXEMPTION (tag-mandate ticket 03). Error class E3 (empty or
 * out-of-vocabulary turn `type`) must not fire on a legally-SKIPPED turn.
 * That exemption needs no predicate in the checker: LAW 8 above is what
 * enforces it — `liveTurnSql` gates every query in this file, on the turn
 * table AND on both endpoints of every edge, so a `status = 'skipped'` (or
 * `was_rolled_back = 1`) turn never enters `turns` and can never be
 * classed. Any future load path added here that bypasses `liveTurnSql`
 * silently re-admits skipped turns as E3 errors and, through the commit
 * gate, would block a window on rows its agent is not even shown.
 *
 * THE TURN-ID SEED SCOPE (peer round T1466, finding P1-1). The settlement
 * window's writable set is an immutable, explicitly enumerated list of turn
 * ids — window ∪ declared lookback ∪ closure — which no prompt-number RANGE
 * can express: a lookback turn can sit anywhere in the session, and a range
 * seeded on `windowStart..windowEnd` alone never LOADS the lookback's own E1/
 * E3 stock, so filtering the resulting errors by anchor afterwards cannot
 * recover what never entered the projection. `{ kind: "turns", turnIds }` is
 * that missing seed: the frozen set goes in verbatim and every pass below —
 * DISCOVER, the stance stock pass, the supplementary passes, the seeds-always-
 * join step — reads the FULL set, exactly as the `range` scope's own seed
 * does. Two exemptions are deliberately NOT re-implemented here:
 *
 *   - LIVENESS/SKIP. The ids arrive unfiltered (a caller's frozen set is a
 *     claim about WRITABILITY, not about liveness) and stay unfiltered
 *     through the seed passes; `loadLiveTurns` is what decides which of them
 *     becomes a judgable row, and `liveTurnSql` on both endpoints of every
 *     edge query is what keeps a dead seed from dragging an edge in. A
 *     skipped or rolled-back id in the frozen set therefore loads NOTHING —
 *     the same law-8 outcome the `range` scope gets from filtering at seed
 *     time, reached one layer later.
 *   - DE-DUPLICATION/ORDER. The set is deduped and sorted ascending so the
 *     projection is a pure function of the id SET, never of the caller's
 *     array order.
 *
 * OUT-OF-VOCABULARY EDGES REACHING OUTSIDE THE SCOPE (same finding). E2
 * anchors at an edge's CITING turn, so an out-of-vocabulary row written FROM
 * a seed turn is that seed's own repairable defect even when its cited turn
 * sits outside everything else this projection loaded. The among-both-
 * endpoints pass alone made such a row invisible, so a second, seed-scoped
 * pass loads every out-of-vocabulary edge whose CITING side is in the seed
 * set and JOINS the far endpoint into the loaded turn set (the
 * no-dangling-edge invariant is preserved by construction, not by luck). The
 * citing-side direction is exactly the anchor rule: a row whose citing side
 * is OUTSIDE the seed anchors outside this window, blocks a different one,
 * and is deliberately still not loaded.
 *
 * SEGMENT-WIDE FACTS (lane-declaration ticket 09, D9). One further pass,
 * `loadSegmentFacts`, answers a question none of the above can: how many
 * lanes a SEGMENT has declared and how many live turns it owns. Both come
 * from the `lanes` registry and `segment_members`, never from the projection
 * assembled above — a projection is a window's shape, and the proliferation
 * warning must read the same verdict from a 4-turn window as from a 100-turn
 * one (peer P1-11). It is carried on its own `segmentFacts` field, straight
 * into `checkLanes`'s fourth parameter.
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
  /**
   * An EXPLICIT turn-id set as the seed (peer round T1466, finding P1-1) —
   * the shape the settlement window's immutable writable set (window ∪
   * declared lookback ∪ closure) actually has, which no prompt-number range
   * can express. See the module header's "THE TURN-ID SEED SCOPE": the ids
   * are taken verbatim (deduped, ascending), liveness is applied by
   * `loadLiveTurns`/`liveTurnSql` rather than at seed time, and every pass
   * seeds from the FULL set.
   */
  | { kind: "turns"; turnIds: readonly number[] }
  | { kind: "lanes"; laneKeys: readonly LaneKey[] };

export interface LaneCheckProjection {
  /**
   * `LaneCheckerTurnInput`, not the bare `LaneTurnInput` the pure
   * interpretation core takes: the extra field is the turn's own `tags`,
   * which error class E4 (the subset invariant over stock) needs on BOTH
   * endpoints of every tagged edge. This is the ONE type-only import this
   * file takes from `shared/lane-checker.ts` — it adds no runtime
   * dependency (the import is erased), which is what the peer-not-wrapper
   * stance below is actually protecting.
   */
  turns: LaneCheckerTurnInput[];
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
  /**
   * D9 proliferation (lane-declaration ticket 09, peer P1-11) — THE one place
   * the segment-wide counts come from. Per REAL segment this scope asked
   * about (every seed turn's owning segment, plus every involved lane key's
   * segment, so a `lanes`-scoped call is covered too): `COUNT(*)` over the
   * `lanes` REGISTRY, `COUNT(DISTINCT turn_id)` over live `segment_members`,
   * and (ticket 14) the NAMES of the declared lanes with no live member —
   * the removable part of a numerator that would otherwise pad the ratio
   * invisibly.
   *
   * Neither number is ever inferred from `turns`/`edges` above: those are a
   * PROJECTION of a window, and inferring from them is exactly what made the
   * same segment yield a different verdict from a 4-turn settlement window
   * than from a 100-turn one. Feed this to `checkLanes`'s fourth parameter;
   * a caller that does not gets no proliferation verdict rather than one
   * computed off the window's shape.
   */
  segmentFacts: LaneSegmentFacts[];
}

interface TurnLiteRow {
  id: number;
  type: string;
  /** `turns.tags` verbatim — a nullable JSON array column. tag-mandate ticket 03: the E4 subset invariant's second input. */
  tags: string | null;
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
  /** `memory_edges.tail_tag` verbatim — the CITING side's lane, `''` when unsettled (lane-model-v12 spec D1). Since ticket 06 this is what the DISCOVERY and WIDEN passes select BY, not `tags`; it is also what the projection's consumers (the console payload, the timeline's lane chain) read. */
  tailTag: string;
  /** `memory_edges.head_tag` verbatim — the CITED side's lane. See `tailTag`. */
  headTag: string;
}

const CROSS_PHASE_CITEDNESS_RELATIONS = ["grounds", "verifies", "refutes"] as const;
/** Same word set `lane-checker.ts`'s `LANE_COMPONENT_RELATIONS` reads — stance (narrows/extends) + consume + grounds. Redeclared as a plain SQL `IN` list rather than importing that constant, so this file never depends on `lane-checker.ts` (only on the pure-data types `lane-interpretation.ts` exports) — the adapter is a peer of the checker, not a wrapper around one of its internals. */
const LANE_COMPONENT_RELATIONS_SQL = [...STANCE_RELATIONS, "consume", "grounds"] as const;

/**
 * The cross-pass dedupe key. Since ticket 09 it mirrors the STORAGE identity
 * key `(citing, cited, relation, tail_tag, head_tag)` EXACTLY (lane-model-v12
 * spec D1) — the merged `tags` component the expand step still carried left
 * with the column. Two rows that differ only in which lane each END names are
 * two DIFFERENT edges, so a key blind to the sides would silently fold one
 * into the other.
 *
 * `JSON.stringify` of the field TUPLE rather than a delimiter join, for
 * `laneToken`'s own reason (round-5 review #14): JSON self-delimits every
 * element through its own quoting, so no field value can imitate the
 * separator and merge two different tuples. It also removes the last
 * separator-byte question from this file — there is no delimiter left to
 * choose, control byte or otherwise.
 */
function edgeKey(row: EdgeLiteRow): string {
  return JSON.stringify([row.citingId, row.citedId, row.relation, row.tailTag, row.headTag]);
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
 * D5, v11: `key.tag` is now the whole of a lane's non-segment identity, no
 * canonical-SET encoding needed on this side either.
 */
function laneKeyToken(key: LaneKey): string {
  return laneToken(key.segment, key.tag);
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
  scope: Extract<LaneCheckScope, { kind: "range" | "segment" | "turns" }>,
): number[] {
  if (scope.kind === "turns") {
    // Verbatim, deduped, ascending — no liveness query here on purpose
    // (module header, "THE TURN-ID SEED SCOPE"): a dead or skipped id in the
    // caller's frozen set is dropped by `loadLiveTurns` at the end and can
    // never carry an edge in, since `liveTurnSql` gates both endpoints of
    // every edge query below.
    return [...new Set(scope.turnIds)].sort((a, b) => a - b);
  }

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

/**
 * Every live, ATTRIBUTED, relation-carrying turn-turn edge touching any of
 * `turnIds` (either endpoint) — the DISCOVERY pass's raw material.
 *
 * "Attributed" is now a SIDE fact (lane-model-v12 D1, ticket 06): at least
 * one of `tail_tag`/`head_tag` settled, i.e. not the `''` sentinel. This
 * replaces `me.tags != '[]'`, which since v12 answers a different question —
 * a cross-lane edge stores `tags = '[]'` (the merged set cannot express two
 * different ends at all, spec problem 2) and would be invisible to a
 * `tags`-keyed discovery pass while genuinely naming two lanes.
 */
function loadTaggedEdgesTouching(db: Database, turnIds: readonly number[]): EdgeLiteRow[] {
  if (turnIds.length === 0) {
    return [];
  }
  const placeholders = turnIds.map(() => "?").join(",");
  return db
    .query<EdgeLiteRow, number[]>(
      `SELECT me.citing_id AS citingId, me.cited_id AS citedId, me.relation,
              me.tail_tag AS tailTag, me.head_tag AS headTag
       FROM memory_edges me
       JOIN turns tc ON tc.id = me.citing_id
       JOIN turns td ON td.id = me.cited_id
       WHERE (me.citing_id IN (${placeholders}) OR me.cited_id IN (${placeholders}))
         AND me.citing_kind = 'turn' AND me.cited_kind = 'turn'
         AND me.relation IS NOT NULL
         AND (me.tail_tag <> '' OR me.head_tag <> '')
         AND ${liveTurnSql("tc")} AND ${liveTurnSql("td")}`,
    )
    .all(...turnIds, ...turnIds);
}

/**
 * Every live, relation-carrying turn-turn edge anywhere in the database with
 * `tag` on EITHER SIDE — the WIDEN pass (lane-model-v12 D1, ticket 06). The
 * index is `memory_edge_side_tags` (`(side, tag, edge_row_id)`), not
 * `memory_edge_tags`: the two agree row-for-row on today's stock, where a
 * single-tag write puts the same tag on both sides, and disagree on exactly
 * the two shapes v12 introduced — a CROSS-LANE row (`tags = '[]'`, so the
 * old index holds nothing for it, yet both sides are settled and it names
 * two lanes) and a legacy MULTI-TAG row (the old index holds every tag,
 * while `deriveSideTags` leaves both sides unsettled because the two-sided
 * model has no single-valued form for it — spec M-A splits those into one
 * row per tag).
 *
 * Both sides are loaded here and the SIDE is discriminated by the caller's
 * own segment filter (`loadLaneCheckScope`'s WIDEN block), which needs the
 * row anyway to decide whether the tail's segment or the head's is the lane
 * being asked about.
 */
function loadEdgesForTag(db: Database, tag: string): EdgeLiteRow[] {
  return db
    .query<EdgeLiteRow, [string]>(
      `SELECT me.citing_id AS citingId, me.cited_id AS citedId, me.relation,
              me.tail_tag AS tailTag, me.head_tag AS headTag
       FROM memory_edges me
       JOIN turns tc ON tc.id = me.citing_id
       JOIN turns td ON td.id = me.cited_id
       WHERE me.id IN (SELECT edge_row_id FROM memory_edge_side_tags WHERE tag = ?)
         AND me.citing_kind = 'turn' AND me.cited_kind = 'turn'
         AND me.relation IS NOT NULL
         AND ${liveTurnSql("tc")} AND ${liveTurnSql("td")}`,
    )
    .all(tag);
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
      `SELECT me.citing_id AS citingId, me.cited_id AS citedId, me.relation,
              me.tail_tag AS tailTag, me.head_tag AS headTag
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
      `SELECT me.citing_id AS citingId, me.cited_id AS citedId, me.relation,
              me.tail_tag AS tailTag, me.head_tag AS headTag
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
 * lane membership. `loadLaneCheckScope` calls this with the whole loaded turn
 * set, so both endpoints of everything it returns are already present among
 * the turns this projection returns — no dangling-edge risk. Its seed-scoped
 * sibling below is the one pass that CAN name a turn not yet loaded, and it
 * joins that endpoint in explicitly.
 */
function loadOutOfVocabularyEdgesAmong(db: Database, turnIds: readonly number[]): EdgeLiteRow[] {
  if (turnIds.length === 0) {
    return [];
  }
  const idPlaceholders = turnIds.map(() => "?").join(",");
  const relationPlaceholders = EDGE_RELATIONS.map(() => "?").join(",");
  return db
    .query<EdgeLiteRow, (number | string)[]>(
      `SELECT me.citing_id AS citingId, me.cited_id AS citedId, me.relation,
              me.tail_tag AS tailTag, me.head_tag AS headTag
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

/**
 * The seed-scoped counterpart of the pass above (peer round T1466, finding
 * P1-1): every live out-of-vocabulary edge whose CITING side is one of
 * `turnIds`, whatever its cited side is. E2 anchors at the citing turn, so
 * such a row is the seed's own repairable defect and must be visible to the
 * window that owns it even when its cited turn joined no other pass; the
 * among-BOTH-endpoints pass alone hid exactly those rows. The reverse case
 * (cited side in scope, citing side outside) is deliberately NOT loaded: it
 * anchors outside this scope and blocks a different window.
 *
 * `loadLaneCheckScope` joins the cited endpoints this returns into the final
 * turn set, so the projection still cannot carry an edge whose endpoint it
 * never loaded.
 */
function loadOutOfVocabularyEdgesFromCiting(db: Database, turnIds: readonly number[]): EdgeLiteRow[] {
  if (turnIds.length === 0) {
    return [];
  }
  const idPlaceholders = turnIds.map(() => "?").join(",");
  const relationPlaceholders = EDGE_RELATIONS.map(() => "?").join(",");
  return db
    .query<EdgeLiteRow, (number | string)[]>(
      `SELECT me.citing_id AS citingId, me.cited_id AS citedId, me.relation,
              me.tail_tag AS tailTag, me.head_tag AS headTag
       FROM memory_edges me
       JOIN turns tc ON tc.id = me.citing_id
       JOIN turns td ON td.id = me.cited_id
       WHERE me.citing_id IN (${idPlaceholders})
         AND me.citing_kind = 'turn' AND me.cited_kind = 'turn'
         AND me.relation IS NOT NULL AND me.relation NOT IN (${relationPlaceholders})
         AND ${liveTurnSql("tc")} AND ${liveTurnSql("td")}`,
    )
    .all(...turnIds, ...EDGE_RELATIONS);
}

/**
 * D9 proliferation's two segment-wide counts (ticket 09, peer P1-11) — the
 * ONLY place either number is produced. The declared count comes from the
 * `lanes` REGISTRY, not from the tags this projection happened to load: a
 * lane declared and never used still counts against the budget, and a window
 * that loaded three of a segment's sixty-three lanes must not report three.
 * The member count comes from `segment_members`, LIVE-filtered like every
 * other read in this file (LAW 8) so a skipped or rolled-back turn neither
 * inflates the denominator nor silently changes a verdict when it is skipped.
 *
 * The `lanes` table is checked for EXISTENCE first. It is created by
 * `db/schema.ts`, but this module is also read by hard-`readonly` callers
 * (`scripts/lane-check.ts`) that cannot create it, and a production database
 * that has never been opened by a writer since the registry shipped genuinely
 * does not have it — verified read-only on the live database, where `lanes`
 * is still absent. A missing registry means zero declared lanes, which can
 * never trip a `> max(1, …)` test, so the honest answer and the safe one
 * coincide; throwing there would take the whole checker down over a warning.
 *
 * EMPTY LANES (ticket 14). `declaredLaneCount` stays `COUNT(*)` — every
 * declared lane counts against the budget, used or not (the rule and its
 * reasoning live on `LaneSegmentFacts.emptyLaneTags`). What this pass adds is
 * the NAMES of the declared lanes with no live member, so a tripped ratio can
 * never be silently padded by lanes no reader can see. "No member" is the
 * checker's own membership rule read straight off the registry: no live
 * turn↔turn relation-carrying edge (LAW 8 on BOTH endpoints, same as every
 * query above) names the tag ON A SIDE whose own endpoint's OWNING segment —
 * `MIN(segment_id)`, `getOwningSegmentId`'s own tie-break, not mere
 * membership — is this one. Ticket 06 moved this third `memory_edge_tags`
 * reader onto `memory_edge_side_tags`, with each side matched against ITS
 * OWN endpoint: that is exactly the WIDEN pass's per-side segment filter
 * expressed in SQL, and on today's stock (`tail === head`) it selects the
 * same rows the either-endpoint form did.
 */
function loadSegmentFacts(db: Database, segmentIds: readonly number[]): LaneSegmentFacts[] {
  const ids = [...new Set(segmentIds)].sort((a, b) => a - b);
  if (ids.length === 0) {
    return [];
  }
  const placeholders = ids.map(() => "?").join(",");
  const hasLanesTable =
    db
      .query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'lanes'`)
      .all().length > 0;
  const declaredBySegment = new Map<number, number>();
  const emptyLanesBySegment = new Map<number, string[]>();
  if (hasLanesTable) {
    for (const row of db
      .query<{ segmentId: number; laneCount: number }, number[]>(
        `SELECT segment_id AS segmentId, COUNT(*) AS laneCount
         FROM lanes WHERE segment_id IN (${placeholders}) GROUP BY segment_id`,
      )
      .all(...ids)) {
      declaredBySegment.set(row.segmentId, row.laneCount);
    }
    for (const row of db
      .query<{ segmentId: number; tag: string }, number[]>(
        `SELECT l.segment_id AS segmentId, l.tag AS tag
         FROM lanes l
         WHERE l.segment_id IN (${placeholders})
           AND NOT EXISTS (
             SELECT 1
             FROM memory_edge_side_tags mest
             JOIN memory_edges me ON me.id = mest.edge_row_id
             JOIN turns tc ON tc.id = me.citing_id
             JOIN turns td ON td.id = me.cited_id
             WHERE mest.tag = l.tag
               AND me.citing_kind = 'turn' AND me.cited_kind = 'turn'
               AND me.relation IS NOT NULL
               AND ${liveTurnSql("tc")} AND ${liveTurnSql("td")}
               AND (
                 (mest.side = 'tail'
                   AND (SELECT MIN(sm.segment_id) FROM segment_members sm WHERE sm.turn_id = me.citing_id) = l.segment_id)
                 OR (mest.side = 'head'
                   AND (SELECT MIN(sm.segment_id) FROM segment_members sm WHERE sm.turn_id = me.cited_id) = l.segment_id)
               )
           )
         ORDER BY l.segment_id ASC, l.tag ASC`,
      )
      .all(...ids)) {
      const bucket = emptyLanesBySegment.get(row.segmentId);
      if (bucket === undefined) {
        emptyLanesBySegment.set(row.segmentId, [row.tag]);
      } else {
        bucket.push(row.tag);
      }
    }
  }
  const memberCountBySegment = new Map<number, number>();
  for (const row of db
    .query<{ segmentId: number; memberCount: number }, number[]>(
      `SELECT sm.segment_id AS segmentId, COUNT(DISTINCT sm.turn_id) AS memberCount
       FROM segment_members sm
       JOIN turns t ON t.id = sm.turn_id
       WHERE sm.segment_id IN (${placeholders}) AND ${liveTurnSql("t")}
       GROUP BY sm.segment_id`,
    )
    .all(...ids)) {
    memberCountBySegment.set(row.segmentId, row.memberCount);
  }
  return ids.map((segmentId) => ({
    segment: String(segmentId),
    declaredLaneCount: declaredBySegment.get(segmentId) ?? 0,
    memberTurnCount: memberCountBySegment.get(segmentId) ?? 0,
    // Always present from THIS loader (`[]` when every declared lane has a
    // live member, and when the registry table is absent entirely — zero
    // declared lanes have zero empty ones). `undefined` is reserved for a
    // caller that builds facts by hand and loaded no such field at all.
    emptyLaneTags: emptyLanesBySegment.get(segmentId) ?? [],
  }));
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
        `SELECT me.citing_id AS citingId, me.cited_id AS citedId, me.relation,
              me.tail_tag AS tailTag, me.head_tag AS headTag
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
      `SELECT id, type, tags, session_id AS sessionId, prompt_number AS promptNumber, created_at_epoch AS createdAtEpoch
       FROM turns WHERE id IN (${placeholders}) AND ${liveTurnSql()}`,
    )
    .all(...ids);
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * `turns.tags` -> the checker's `LaneCheckerTurnInput.tags` (tag-mandate
 * ticket 03, E4). The three cases are deliberately NOT collapsed:
 *
 *   - `NULL` -> `[]`. The column is nullable with no default, so a turn
 *     written before it carried tags, or written with none, reads NULL —
 *     that IS "this turn carries no tags", a real E4 verdict for every
 *     tagged edge touching it, not an unknown.
 *   - a valid JSON array -> its canonical set.
 *   - anything else (malformed JSON, a JSON non-array — `turns.tags` has no
 *     `json_valid` CHECK, so both are storable; see `db/schema.ts`'s own
 *     note) -> `undefined`, i.e. NOT LOADED, so the checker issues no E4
 *     verdict for this turn's side of any edge. A parse failure is
 *     ignorance, and ignorance must never manufacture an error the commit
 *     gate would then refuse a window over.
 */
function parseTurnTags(raw: string | null): readonly string[] | undefined {
  if (raw === null) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    return undefined;
  }
  return canonicalTagSet(parsed as string[]);
}

/** Row -> the core's input shape. The two side columns are the whole lane surface since ticket 09 retired the merged set (spec D1 — `''` on a side means UNSETTLED, never a lane named `''`). */
function toEdgeInput(row: EdgeLiteRow): LaneEdgeInput {
  return {
    citingId: row.citingId,
    citedId: row.citedId,
    relation: row.relation,
    tailTag: row.tailTag,
    headTag: row.headTag,
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
      // ONE key per SETTLED SIDE (lane-model-v12 D1, ticket 06): the arc's
      // TAIL names a lane in the CITING turn's segment, its HEAD one in the
      // CITED turn's. On today's stock (`tail === head`) this yields exactly
      // the two keys the per-tag × per-segment fan-out yielded before — the
      // citing side's copy and the cited side's — so discovery is unchanged
      // row for row. On a CROSS-LANE row the two keys are genuinely
      // different lanes, which is the fact the merged set could not carry.
      if (row.tailTag !== "") {
        const citingKey: LaneKey = { segment: segmentKeyFor(owningSegments, row.citingId), tag: row.tailTag };
        seen.set(laneKeyToken(citingKey), citingKey);
      }
      if (row.headTag !== "") {
        const citedKey: LaneKey = { segment: segmentKeyFor(owningSegments, row.citedId), tag: row.headTag };
        seen.set(laneKeyToken(citedKey), citedKey);
      }
    }
    involvedLaneKeys = [...seen.values()];
  }

  // ---- WIDEN: each involved lane's full tagged edge set, its own segment only ----
  const widenedByKey = new Map<string, EdgeLiteRow[]>();
  for (const laneKey of involvedLaneKeys) {
    const candidates = loadEdgesForTag(db, laneKey.tag);
    if (candidates.length === 0) {
      widenedByKey.set(laneKeyToken(laneKey), []);
      continue;
    }
    const owningSegments = loadOwningSegments(
      db,
      candidates.flatMap((row) => [row.citingId, row.citedId]),
    );
    // Match from EITHER endpoint's segment, but PER SIDE (ticket 06): the
    // TAIL only ever names a lane in the CITING turn's segment and the HEAD
    // only in the CITED turn's, so a row belongs to lane `(S, T)` when its
    // tail is `T` and its citing turn is owned by `S`, or its head is `T`
    // and its cited turn is. On today's stock (`tail === head === T`) this
    // is exactly round-5 review #13's "either endpoint's segment" filter,
    // row for row; it diverges only where the two sides carry different
    // tags, and there the segment that matters is the one belonging to the
    // side that actually names the lane.
    widenedByKey.set(
      laneKeyToken(laneKey),
      candidates.filter(
        (row) =>
          (row.tailTag === laneKey.tag &&
            segmentKeyFor(owningSegments, row.citingId) === laneKey.segment) ||
          (row.headTag === laneKey.tag &&
            segmentKeyFor(owningSegments, row.citedId) === laneKey.segment),
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
  // UNTAGGED STANCE PASS. Every pass above seeds from DISCOVERED lane
  // members, so a neighbourhood holding only UNTAGGED stance edges loads
  // nothing at all. Stance edges touching the scope's own SEED turns load
  // unconditionally instead; tagged rows arriving here are harmless
  // duplicates the edgeMap already dedupes.
  //
  // This pass was built for E1 (the tag mandate's untagged-continuation
  // error), which lane-declaration ticket 02 retired — an untagged stance
  // edge is an ordinary legal edge now. It stays because its DOMAIN outlived
  // its original consumer: an untagged stance edge is a `LANE_COMPONENT_
  // RELATIONS` bridge, so reports 2/3 and `computeInterfaces`/`computeBypass`
  // read it, and D9's unattributed-cluster warning (ticket 09) is defined
  // over exactly these rows. Dropping the pass with E1 would have starved
  // both while looking like pure cleanup.
  if (seedTurnIds.length > 0) {
    for (const row of loadEdgesByRelationTouching(db, seedTurnIds, [...STANCE_RELATIONS])) {
      edgeMap.set(edgeKey(row), row);
    }
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
  // The scope's own SEED turns always join the projection (the untagged-stance
  // pass's sibling repair): without this, an edge-less laneless window loads
  // zero turns and E3 on its own rows would be invisible. `loadLiveTurns`
  // below keeps the liveness/skip exemptions — a dead or skipped seed still
  // never becomes a judgable row.
  for (const id of seedTurnIds) {
    allTurnIds.add(id);
  }

  // OUT-OF-VOCABULARY EDGES (semantic-conformance ticket 02), from two
  // passes: the among-BOTH-endpoints one over everything loaded so far, and
  // the seed-scoped CITING-side one (peer round T1466, finding P1-1 — module
  // header, "OUT-OF-VOCABULARY EDGES REACHING OUTSIDE THE SCOPE") whose far
  // endpoint may not be in `allTurnIds` yet and is joined in right below, so
  // the no-dangling-endpoint invariant survives. Deduplicated by the same
  // `edgeKey` the edge map uses; a row both passes return is carried once.
  //
  // Kept on its OWN field — never merged into `edgeMap`/`edges` — so
  // `mcp/note.ts`'s Gate C self-`grounds` terminus check, the one OTHER
  // reader of `projection.edges` in this codebase, never has its own
  // `deriveLaneInterpretation` re-derivation widened by a relation it was
  // never scoped to see (`LaneCheckProjection`'s own doc comment).
  // `checkLanes` (`shared/lane-checker.ts`) is what keeps these OUT of every
  // graph computation once they DO reach it, through its own third parameter.
  const outOfVocabularyRows = new Map<string, EdgeLiteRow>();
  for (const row of loadOutOfVocabularyEdgesAmong(db, [...allTurnIds])) {
    outOfVocabularyRows.set(edgeKey(row), row);
  }
  for (const row of loadOutOfVocabularyEdgesFromCiting(db, seedTurnIds)) {
    outOfVocabularyRows.set(edgeKey(row), row);
  }
  // The far endpoints join the projection (never the reverse — this pass
  // widens the TURN set only, never re-runs the among-pass over the widened
  // set: an out-of-vocabulary row is a reported fact, not a lane input, so
  // one round is the whole of it).
  for (const row of outOfVocabularyRows.values()) {
    allTurnIds.add(row.citingId);
    allTurnIds.add(row.citedId);
  }
  const outOfVocabularyEdges = [...outOfVocabularyRows.values()]
    .map(toEdgeInput)
    .sort((a, b) => {
      if (a.citingId !== b.citingId) return a.citingId - b.citingId;
      if (a.citedId !== b.citedId) return a.citedId - b.citedId;
      return a.relation.localeCompare(b.relation);
    });

  const turnRows = loadLiveTurns(db, [...allTurnIds]);
  const owningSegmentsForTurns = loadOwningSegments(db, [...allTurnIds]);

  const turns: LaneCheckerTurnInput[] = [...turnRows.values()]
    .map((row) => {
      const segmentId = owningSegmentsForTurns.get(row.id);
      const input: LaneCheckerTurnInput = {
        id: row.id,
        type: JSON.parse(row.type) as string[],
        order: turnOrderKey(row.sessionId, row.promptNumber),
        createdAtEpoch: row.createdAtEpoch,
      };
      if (segmentId !== undefined) {
        input.segment = String(segmentId);
      }
      // Omitted (rather than set to `[]`) only when the stored value is
      // unparseable — see `parseTurnTags`: absent means "no E4 verdict".
      const tags = parseTurnTags(row.tags);
      if (tags !== undefined) {
        input.tags = tags;
      }
      return input;
    })
    .sort((a, b) => a.id - b.id);

  const edges: LaneEdgeInput[] = [...edgeMap.values()].map(toEdgeInput).sort((a, b) => {
    if (a.citingId !== b.citingId) return a.citingId - b.citingId;
    if (a.citedId !== b.citedId) return a.citedId - b.citedId;
    return a.relation.localeCompare(b.relation);
  });

  // D9 proliferation (ticket 09): the REAL segments this scope actually asked
  // about — every seed turn's owning segment, plus every involved lane key's
  // own segment so the seed-less `lanes` scope is covered too. Deliberately
  // NOT "every segment among the loaded turns": the segment-global component
  // pass and cross-segment citations both drag in neighbours this caller
  // never asked a question about, and each would otherwise get a per-segment
  // verdict of its own in a window that merely brushed against it.
  const scopeSegmentIds = new Set<number>();
  for (const id of seedTurnIds) {
    const segmentId = owningSegmentsForTurns.get(id);
    if (segmentId !== undefined) {
      scopeSegmentIds.add(segmentId);
    }
  }
  for (const laneKey of involvedLaneKeys) {
    if (laneKey.segment !== DEFAULT_SEGMENT) {
      scopeSegmentIds.add(Number(laneKey.segment));
    }
  }
  const segmentFacts = loadSegmentFacts(db, [...scopeSegmentIds]);

  return { turns, edges, involvedLaneKeys, outOfVocabularyEdges, segmentFacts };
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
