import type { Database } from "bun:sqlite";

import {
  deriveFlows,
  type FlowDerivation,
  type FlowEdgeInput,
  type FlowTurnInput,
} from "../shared/flows";
import { liveTurnSql } from "./turn-liveness";

/**
 * The flow derivation's DB-facing half (flow-relations spec, ticket 02). Thin
 * on purpose (spec addenda: "keep the adapter thin and colocated with the
 * other db/ read helpers") — it loads the FULL turn universe of the given
 * session(s) (every turn's id and type list) and every turn-turn edge among
 * the structure-carrying relations `shared/flows.ts` actually reads
 * (narrows/extends/override/grounds/consume — the same set that module's own
 * header names load-bearing), and hands both arrays to the pure derivation
 * unfiltered. Consumers filter and orchestrate: `collects`' membership check,
 * the `grounds` self-citation settlement gate, and the `grounds` mid-flow
 * warning all live one layer up (`mcp/note.ts`,
 * `worker/note-settlement-turn-facade.ts`), not here.
 *
 * Deliberately imports NOTHING from `db/turns.ts` or `db/memory-edges.ts` —
 * both queries below are hand-written SQL against `turns`/`memory_edges`
 * directly. `db/` carries a circular-import trap around
 * turns/segments/memory-edges (ticket 02's own briefing); staying leaf-level
 * here is what keeps this module import-safe from every other db/ file.
 *
 * Session-SCOPED, not whole-DB. `sessionIds` is the caller's own notion of
 * "the relevant session(s)" — the citing turn's own session plus the session
 * of every relation target this call actually resolves for a field that
 * consumes a derivation (`collects`, `grounds`). A narrows/extends chain that
 * happens to reach into a session neither the citing turn nor any of this
 * call's own targets belong to is invisible to this call: an accepted scope,
 * not an oversight — the full derivation is cheap in isolation (spec.md:
 * 2.4ms over the whole production DB) but re-reading the entire
 * turns/memory_edges tables on every note() call is a cost this module does
 * not take on silently just because the spec measured it as affordable once.
 */
export function deriveFlowsForSessions(
  db: Database,
  sessionIds: readonly number[],
): FlowDerivation {
  const uniqueSessionIds = [...new Set(sessionIds)].filter(
    (id) => Number.isSafeInteger(id) && id > 0,
  );
  if (uniqueSessionIds.length === 0) {
    return deriveFlows([], []);
  }

  const sessionPlaceholders = uniqueSessionIds.map(() => "?").join(",");
  // Indexes-rescope spec law 8 / ticket 03: a rolled-back or skipped turn is
  // never a flow NODE. Excluding it here is sufficient for edges too, with no
  // separate filter on the edges query below — `deriveFlows` (shared/
  // flows.ts) already ignores any edge whose endpoint is not present in the
  // `turns` array it is handed (its own documented contract: "Edges whose
  // endpoints are not both in `turns` are ignored"), so a citing/cited id
  // excluded here drops every edge that touches it, regardless of relation.
  const turnRows = db
    .query<{ id: number; type: string | null }, number[]>(
      `SELECT id, type FROM turns
       WHERE session_id IN (${sessionPlaceholders}) AND ${liveTurnSql()}`,
    )
    .all(...uniqueSessionIds);

  const turns: FlowTurnInput[] = turnRows.map((row) => ({
    id: row.id,
    type: parseTurnTypeArray(row.type),
  }));
  const turnIds = turns.map((turn) => turn.id);
  if (turnIds.length === 0) {
    return deriveFlows([], []);
  }

  const turnPlaceholders = turnIds.map(() => "?").join(",");
  const edgeRows = db
    .query<{ citingId: number; citedId: number; relation: string }, number[]>(
      `SELECT citing_id AS citingId, cited_id AS citedId, relation
       FROM memory_edges
       WHERE citing_kind = 'turn' AND cited_kind = 'turn'
         AND relation IN ('narrows', 'extends', 'override', 'grounds', 'consume')
         AND (citing_id IN (${turnPlaceholders}) OR cited_id IN (${turnPlaceholders}))`,
    )
    .all(...turnIds, ...turnIds);

  const edges: FlowEdgeInput[] = edgeRows.map((row) => ({
    citingId: row.citingId,
    citedId: row.citedId,
    relation: row.relation,
  }));

  return deriveFlows(turns, edges);
}

function parseTurnTypeArray(value: string | null): string[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}
