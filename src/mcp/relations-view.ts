import type { Database } from "bun:sqlite";

import {
  getTurnRelationEdges,
  type TurnRelationEdgeView,
} from "../db/memory-edges";

/**
 * Edge-read-surface spec, ticket 01: the `relations` recall field's
 * rendering half. `db/memory-edges.ts`'s `getTurnRelationEdges` supplies the
 * Law-8-filtered raw edges (both directions, relation-carrying only); this
 * module turns them into the ruled display lines — `→ <word> T<n>
 * {lane}` outbound, `← <word> from T<n> {lane}` inbound, `{tail→head}` for an
 * edge crossing two lanes, and no brace suffix at all for an unsettled one
 * (`formatLaneSuffix`). Kept separate from `format.ts` (the DB-free
 * pure renderer) and from `recall.ts`/`segment-card.ts` (so neither has to
 * duplicate this format) — every "turn block" render site that honours
 * `filter.fields` imports `buildTurnRelationLines` from here.
 */

function formatRelationAddress(
  currentSessionId: number,
  otherSessionId: number,
  otherPromptNumber: number,
): string {
  return currentSessionId === otherSessionId
    ? `T${otherPromptNumber}`
    : `S${otherSessionId}/T${otherPromptNumber}`;
}

/**
 * lane-model-v12 ticket 08: the lane suffix, read PER SIDE now that an edge
 * can legally cross two lanes.
 *
 *   - both sides on the same lane: `{lane}` — byte-identical to what the
 *     pre-v12 single-tag row already rendered, which is every tagged row that
 *     exists today.
 *   - a CROSSING (two different lanes, the shape v11 could not store at all):
 *     `{tail→head}`, so the display says which lane the reference comes FROM
 *     and which it points AT rather than collapsing them into one set.
 *   - neither side settled: fall back to the legacy `tags` column, which is
 *     empty for every row a v12 write path produced and non-empty only for a
 *     pre-M-A multi-tag row. Ticket 09 deletes that arm with the column.
 *
 * A HALF-settled edge cannot occur — the write gate refuses one — so no arm
 * here has to invent a display for half a lane.
 */
function formatLaneSuffix(edge: TurnRelationEdgeView): string {
  if (edge.tailTag !== "" && edge.tailTag === edge.headTag) {
    return ` {${edge.tailTag}}`;
  }
  if (edge.tailTag !== "" && edge.headTag !== "") {
    return ` {${edge.tailTag}→${edge.headTag}}`;
  }
  return edge.tags.length > 0 ? ` {${edge.tags.join("+")}}` : "";
}

function formatRelationLine(
  direction: "outbound" | "inbound",
  edge: TurnRelationEdgeView,
  currentSessionId: number,
): string {
  const address = formatRelationAddress(
    currentSessionId,
    edge.otherSessionId,
    edge.otherPromptNumber,
  );
  const tagSuffix = formatLaneSuffix(edge);
  return direction === "outbound"
    ? `→ ${edge.relation} ${address}${tagSuffix}`
    : `← ${edge.relation} from ${address}${tagSuffix}`;
}

/**
 * Both directions of one turn's tagged edges, pre-formatted — outbound lines
 * before inbound, ruled order matching the ticket's own example. `[]` when
 * the turn neither cites nor is cited by anything (relation-carrying,
 * Law-8-live). Callers gate the QUERY itself on whether `relations` was
 * actually requested (`filter.fields`) — this function has no opinion on
 * that, so "costs nothing when not requested" is each caller's own job, not
 * this one's.
 */
export function buildTurnRelationLines(
  db: Database,
  turn: { id: number; sessionId: number },
): string[] {
  const edges = getTurnRelationEdges(db, turn.id);
  return [
    ...edges.outbound.map((edge) => formatRelationLine("outbound", edge, turn.sessionId)),
    ...edges.inbound.map((edge) => formatRelationLine("inbound", edge, turn.sessionId)),
  ];
}
