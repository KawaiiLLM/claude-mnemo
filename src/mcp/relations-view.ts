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
 * {tag+tag}` outbound, `← <word> from T<n> {tag+tag}` inbound, untagged
 * edges with no brace suffix. Kept separate from `format.ts` (the DB-free
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
  const tagSuffix = edge.tags.length > 0 ? ` {${edge.tags.join("+")}}` : "";
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
