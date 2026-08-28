import type { Database } from "bun:sqlite";

import { EDGE_RELATIONS } from "../shared/turn-phase";
import { liveTurnSql } from "./turn-liveness";
import type { PhaseConnectivityGraph, PhaseConnectivityOutEdge } from "../shared/phase-connectivity";

/**
 * The basis-reachability DB adapter (phase-connectivity ticket 01,
 * prerequisite 1: "A dedicated basis-reachability loader"). Patching
 * `db/lane-checker-load.ts`'s `loadTaggedEdgesTouching` would emit false
 * ERRORs: that loader excludes edges with BOTH sides `''` and loads only
 * lanes discovered from a fixed seed, while the walk needs every live,
 * IN-VOCABULARY, BOTH-SIDES-SETTLED out-edge from whichever node the BFS
 * frontier reaches next — a domain this loader owns and nothing else does.
 *
 * DESIGN CHOICE (ticket 01 leaves the loader shape to the implementer): a
 * FIXPOINT SET LOAD, not a per-node lazy fetch with its own cycle guard. The
 * two are close in spirit — both are lazy in the sense of never touching a
 * node the walk cannot reach — but a fixpoint load lets one query per BFS
 * LEVEL (batched over every node newly discovered that level, via `IN`)
 * rather than one query per NODE, and the cycle guard is the same `visited`
 * set either way. `relations-view`'s `outCoverage` per-node fetch exists
 * because that reader visits one node at a time from the UI; this reader's
 * only caller is a settlement dispatch walking a handful of landing turns at
 * once, so batching by level is strictly cheaper for the one shape that
 * matters here. The walk is genuinely unbounded ("any depth", basis
 * endpoints may lie outside the writable window) — `MAX_WALK_DEPTH`
 * (`shared/phase-connectivity.ts`) is the only ceiling, shared by the pure
 * BFS and this loader's own expansion loop so neither can walk past what the
 * other is willing to judge.
 *
 * KNOWN OVER-FETCH (documented, not a defect): once a frontier node resolves
 * to a basis type, this loader still expands ONE further level past it
 * before the pure module (which does not run until the whole closure is
 * loaded) gets to say "stop, you already had your answer" — the loader has
 * no predicate of its own, on purpose (DB rows in, pure judgement out, the
 * same split every other loader in this codebase keeps). For a settlement
 * window's small landing-turn count this costs at most one extra query
 * batch per resolved node, not one extra graph traversal.
 */
export interface BasisReachabilityClosure {
  types: Map<number, string[]>;
  graph: Map<number, PhaseConnectivityOutEdge[]>;
}

// Mirrors shared/phase-connectivity.ts's own ceiling, and must (ticket 06,
// decision 2): this loader seeds its fixpoint with EVERY landing id in the
// same frontier-0 batch, so for any one landing turn the combined closure
// reaches a node in at most as many levels as that turn's own single-seed
// walk would need — never more. A cap hit here therefore never truncates a
// SPECIFIC landing turn's graph before its own `MAX_WALK_DEPTH`-hop reach is
// fully loaded; `evaluateTurnPhaseConnectivity`'s own cap detection (frontier
// still non-empty when its hop count reaches this same number) is what
// turns that into `"unresolved-at-cap"` rather than a false violation, and
// it can only do so correctly because the two ceilings are numerically the
// same value.
const MAX_WALK_DEPTH = 500;

interface TypeRow {
  id: number;
  type: string;
}

function loadTypesFor(db: Database, turnIds: readonly number[]): Map<number, string[]> {
  const result = new Map<number, string[]>();
  if (turnIds.length === 0) {
    return result;
  }
  const placeholders = turnIds.map(() => "?").join(",");
  for (const row of db
    .query<TypeRow, number[]>(
      `SELECT id, type FROM turns WHERE id IN (${placeholders}) AND ${liveTurnSql()}`,
    )
    .all(...turnIds)) {
    result.set(row.id, JSON.parse(row.type) as string[]);
  }
  return result;
}

interface OutEdgeRow {
  citingId: number;
  citedId: number;
  relation: string;
}

/**
 * Every live, IN-VOCABULARY, BOTH-SIDES-SETTLED out-edge from any of
 * `turnIds` — "commit-valid edges" in the ticket's own words. A draft
 * (either lane-tag side `''`, error class E6 in `shared/lane-checker.ts`)
 * does not carry the walk: `me.tail_tag <> '' AND me.head_tag <> ''` is that
 * exclusion, applied here rather than trusted to a caller, so this loader's
 * output needs no second filter before the pure module ever sees it.
 */
function loadOutEdgesFrom(db: Database, turnIds: readonly number[]): Map<number, PhaseConnectivityOutEdge[]> {
  const result = new Map<number, PhaseConnectivityOutEdge[]>();
  if (turnIds.length === 0) {
    return result;
  }
  const idPlaceholders = turnIds.map(() => "?").join(",");
  const relationPlaceholders = EDGE_RELATIONS.map(() => "?").join(",");
  const rows = db
    .query<OutEdgeRow, (number | string)[]>(
      `SELECT me.citing_id AS citingId, me.cited_id AS citedId, me.relation
       FROM memory_edges me
       JOIN turns tc ON tc.id = me.citing_id
       JOIN turns td ON td.id = me.cited_id
       WHERE me.citing_id IN (${idPlaceholders})
         AND me.citing_kind = 'turn' AND me.cited_kind = 'turn'
         AND me.relation IN (${relationPlaceholders})
         AND me.tail_tag <> '' AND me.head_tag <> ''
         AND ${liveTurnSql("tc")} AND ${liveTurnSql("td")}`,
    )
    .all(...turnIds, ...EDGE_RELATIONS);
  for (const id of turnIds) {
    result.set(id, []);
  }
  for (const row of rows) {
    const bucket = result.get(row.citingId);
    if (bucket === undefined) {
      result.set(row.citingId, [{ citedId: row.citedId, relation: row.relation }]);
    } else {
      bucket.push({ citedId: row.citedId, relation: row.relation });
    }
  }
  return result;
}

/**
 * Fixpoint-expand the directed closure reachable from `landingTurnIds`,
 * level by level, cycle-guarded by a monotonic `visited` set — the whole of
 * `shared/phase-connectivity.ts`'s input. Basis endpoints outside the
 * writable window are loaded exactly like any other reachable node (the
 * OBLIGATION anchor is `landingTurnIds`, never a bound on how far the walk
 * may travel — ticket 01, prerequisite 2); a dead or skipped node along the
 * way loads no type and no out-edges (`liveTurnSql`), which the pure module
 * reads as a dead end, not a violation of its own.
 */
export function loadBasisReachabilityClosure(
  db: Database,
  landingTurnIds: readonly number[],
): BasisReachabilityClosure {
  const types = new Map<number, string[]>();
  const graph = new Map<number, PhaseConnectivityOutEdge[]>();
  const visited = new Set<number>();
  let frontier = [...new Set(landingTurnIds)];
  let depth = 0;

  while (frontier.length > 0 && depth < MAX_WALK_DEPTH) {
    depth += 1;
    const unseen = frontier.filter((id) => !visited.has(id));
    for (const id of unseen) {
      visited.add(id);
    }
    if (unseen.length === 0) {
      break;
    }
    for (const [id, type] of loadTypesFor(db, unseen)) {
      types.set(id, type);
    }
    const edgesByCiting = loadOutEdgesFrom(db, unseen);
    const nextFrontier: number[] = [];
    for (const id of unseen) {
      const edges = edgesByCiting.get(id) ?? [];
      graph.set(id, edges);
      for (const edge of edges) {
        if (!visited.has(edge.citedId)) {
          nextFrontier.push(edge.citedId);
        }
      }
    }
    frontier = nextFrontier;
  }

  return { types, graph };
}

/** `loadBasisReachabilityClosure`'s two maps widened to the pure module's own `ReadonlyMap` lookup types — a thin, allocation-free view. */
export function closureAsPhaseConnectivityInput(closure: BasisReachabilityClosure): {
  types: ReadonlyMap<number, readonly string[]>;
  graph: PhaseConnectivityGraph;
} {
  return { types: closure.types, graph: closure.graph };
}

/** Every live landing-typed turn (type intersects implement/fix/refactor) among `turnIds` — the walk's seed AND ticket 01's obligation anchor is `windowTurnIds` passed in verbatim by the caller, never the writable lookback/closure set (prerequisite 2). */
export function selectLandingTurnIds(db: Database, turnIds: readonly number[]): number[] {
  const types = loadTypesFor(db, turnIds);
  const landing: number[] = [];
  for (const [id, type] of types) {
    if (type.some((word) => word === "implement" || word === "fix" || word === "refactor")) {
      landing.push(id);
    }
  }
  return landing.sort((a, b) => a - b);
}
