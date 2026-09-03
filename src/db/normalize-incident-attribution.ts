/**
 * THE ONE POST-NORMALISATION SEAM (`.scratch/main-agent-edges/spec.md` D2 and
 * pinned decision P2, S15069/T2432).
 *
 * A stored lane side means exactly "this endpoint is in SEVERAL lanes and this
 * is the one" (`db/edge-side-resolution.ts`). That sentence is an INVARIANT,
 * not a write-time convention: the moment an endpoint's lane set changes —
 * lane clear, lane merge, lane retag, a membership add or remove, a task move
 * — every declaration incident to that endpoint may have stopped being true.
 * Peer finding R9-2: nothing in the design maintains it after the cutover
 * unless every attribution-changing verb re-resolves what it touched.
 *
 * So this is ONE function that every such verb calls, in ITS OWN transaction,
 * with the ids whose tags actually moved. It is deliberately not a trigger and
 * not a background reconciler: the rule has to be atomic with the mutation
 * that broke it, or a reader between the two sees a declaration the endpoint
 * no longer supports.
 *
 * ## The rule, in the order it is applied per incident side
 *
 * 1. A declaration NO LONGER AMONG the endpoint's tags (`invalid`) is
 *    CLEARED. The write that removed the tag is the newer statement.
 * 2. A declaration on an endpoint whose lane cardinality is now `< 2` is
 *    CLEARED as redundant — this is what keeps "stored means several lanes"
 *    true. The `#alpha + #beta` edge that declared `#alpha` becomes plain
 *    `derived` when `#beta` goes, never a stale `declared` that a later
 *    reader cannot distinguish from a real disambiguation.
 * 3. What resolves `ambiguous` AFTER 1-2 (endpoint in ≥ 2 lanes, no
 *    declaration survived) is LEFT EXACTLY AS IT IS. Ruling S15069/T2465-
 *    T2466: "a side that resolves `ambiguous` is a WARNING, nothing more."
 *    The edge is kept, nothing is deleted, no settlement job is reset and no
 *    repair authority is minted. A reader renders the side `ambiguous`, the
 *    checker reports it as E6, and settlement may declare it when it sees it.
 *    So this seam has exactly TWO effects — the two clears above — and the
 *    ambiguous outcome is a no-op with no hook to configure.
 *
 * ## What it never does
 *
 * It never touches `relation_class`, `relation_coverage`, provenance or row
 * identity. A lane lifecycle verb mutates ATTRIBUTION and nothing else — the
 * edge is a fact about two nodes, and a lane rename is not evidence about
 * whether one turn corrected another. `clearLane` in particular no longer
 * deletes relation rows or restores bare ones; that behaviour existed because
 * a side that lost its lane had nowhere to go under the stored-side model, and
 * under resolution it simply reads `none`.
 *
 * ## Why there is no lane-touch recording here (ticket 04, peer finding F3)
 *
 * Ticket 02 shipped an old/new qualified lane TOUCH pair on this seam, scoped
 * to a settlement job's `lane_run_touches` ledger. It was reachable from
 * nothing: no structural verb ever had a job id to give it, so the whole path
 * ran only under its own unit test. DELETED rather than wired up, per the
 * batch's own standing ruling (T2419).
 *
 * ## And why there is no PRE-STATE capture either (ticket 14)
 *
 * The caller's pre-mutation lane facts were captured here for ONE reader, the
 * derived-side closure, which existed to hand a newly-ambiguous side a repair
 * channel. The ruling removed the channel, so the capture, `ctx.settlementJobId`
 * and `ctx.previousLaneFacts` went with it: this seam no longer needs to know
 * what a side USED to resolve to, only what it resolves to now.
 */

import type { Database } from "bun:sqlite";

import {
  edgeSideStoredTag,
  loadEndpointLaneFacts,
  resolveEdgeSide,
  type EdgeSide,
  type EndpointLaneFacts,
  UNDECLARED_SIDE_TAG,
} from "./edge-side-resolution";
import { selectLogicalEdgeRow } from "./memory-edges";
import { stampTurnRelationsRevision } from "./write-gate";

/** One incident edge row, as this seam reads and reports it. */
export interface IncidentEdgeRow {
  id: number;
  citingKind: string;
  citingId: number;
  citedKind: string;
  citedId: number;
  relationClass: string;
  relationCoverage: string;
  tailTag: string;
  headTag: string;
}

export interface NormalizeIncidentAttributionContext {
  /**
   * The writer id the cleared/deleted citers' relations stamps carry — the
   * VERB's own id (`lane:clear`, `lane:merge`, …), never the acting caller's,
   * for the reason `db/write-gate.ts` gives at `LANE_MERGE_WRITER`: a stamp
   * bearing the caller's own id would let that caller keep writing edges on a
   * set its own structural verb just rewrote underneath it.
   */
  writer: string;
  nowEpoch: number;
}

export interface ClearedDeclaration {
  edgeId: number;
  side: EdgeSide;
  /** The tag that was stored, now `''`. */
  clearedTag: string;
  /** `invalid` — the tag left the endpoint; `redundant` — the endpoint is down to one lane or none. */
  reason: "invalid" | "redundant";
}

export interface DeletedIncidentEdge {
  edgeId: number;
  citingId: number;
  citedId: number;
  side: EdgeSide;
}

export interface NormalizeIncidentAttributionResult {
  clearedDeclarations: readonly ClearedDeclaration[];
  deletedEdges: readonly DeletedIncidentEdge[];
  /** Citing turns whose relations revision this call stamped — ascending, deduped. */
  stampedCiterIds: readonly number[];
}

const SIDES: readonly EdgeSide[] = ["tail", "head"];

/**
 * Re-resolve every side incident to `turnIds` and repair it. Runs in the
 * CALLER'S transaction — every write below is unconditional SQL, so a throw
 * anywhere leaves the caller's `runWriteTransaction` to unwind the whole verb.
 */
export function normalizeIncidentAttribution(
  db: Database,
  turnIds: readonly number[],
  ctx: NormalizeIncidentAttributionContext,
): NormalizeIncidentAttributionResult {
  const ids = [...new Set(turnIds)];
  const empty: NormalizeIncidentAttributionResult = {
    clearedDeclarations: [],
    deletedEdges: [],
    stampedCiterIds: [],
  };
  if (ids.length === 0) {
    return empty;
  }

  const placeholders = ids.map(() => "?").join(",");
  const incident = db
    .query<IncidentEdgeRow, number[]>(
      `SELECT id,
              citing_kind AS citingKind, citing_id AS citingId,
              cited_kind AS citedKind, cited_id AS citedId,
              relation_class AS relationClass, relation_coverage AS relationCoverage,
              tail_tag AS tailTag, head_tag AS headTag
         FROM memory_edges
        WHERE citing_kind = 'turn' AND cited_kind = 'turn'
          AND (citing_id IN (${placeholders}) OR cited_id IN (${placeholders}))
        ORDER BY id ASC`,
    )
    .all(...ids, ...ids);
  if (incident.length === 0) {
    return empty;
  }

  // Both endpoints of every incident row, not just the moved ones: a side is
  // resolved against ITS OWN endpoint, and the far end's facts are what say
  // whether the far side is `derived` or `ambiguous`.
  const endpointIds = new Set<number>();
  for (const row of incident) {
    endpointIds.add(row.citingId);
    endpointIds.add(row.citedId);
  }
  const facts = loadEndpointLaneFacts(db, [...endpointIds]);
  const moved = new Set(ids);

  const clearSide = {
    tail: db.query<unknown, [number]>(`UPDATE memory_edges SET tail_tag = '' WHERE id = ?`),
    head: db.query<unknown, [number]>(`UPDATE memory_edges SET head_tag = '' WHERE id = ?`),
  } as const;
  // THE COLLISION THIS CLEAR CAN CAUSE, and why it is a FOLD rather than an
  // error. DEFERRAL-WINDOW ONLY: until the cutover (main-agent-edges ticket
  // 01) has rebuilt the table on the pair alone, storage identity is still
  // `(pair, relation, tail, head)`, so two rows that differed ONLY by which
  // lane each declared become the same row the moment both declarations are
  // cleared. The UPDATE would raise a raw `SQLITE_CONSTRAINT` in the middle of
  // a lane verb; what it MEANS is that the two rows were always one logical
  // edge, so the loser is deleted into the receipt exactly as the cutover's
  // own fold does it. After the cutover a pair holds one row and this finds
  // nothing.
  //
  // WHICH ONE IS THE LOSER (main-agent-edges ticket 13, P1-3): `me` — the row
  // this loop is currently clearing — is NOT automatically it. The survivor is
  // `selectLogicalEdgeRow`'s row over the pair, exactly the rule the write path
  // and the cutover's own fold use, so a `correct/full` row can never be
  // dropped in favour of a `use` sibling merely because the sibling already
  // has the lowest id.
  const collidingSibling = db.query<
    { id: number; relationClass: string; relationCoverage: string },
    [string, string, number]
  >(
    `SELECT other.id AS id,
            other.relation_class AS relationClass,
            other.relation_coverage AS relationCoverage
       FROM memory_edges me
       JOIN memory_edges other
         ON other.citing_kind = me.citing_kind AND other.citing_id = me.citing_id
        AND other.cited_kind = me.cited_kind AND other.cited_id = me.cited_id
        AND other.tail_tag = ? AND other.head_tag = ?
        AND other.id <> me.id
      WHERE me.id = ?
      ORDER BY other.id ASC
      LIMIT 1`,
  );
  const dropSideIndexRow = db.query<unknown, [number, EdgeSide]>(
    `DELETE FROM memory_edge_side_tags WHERE edge_row_id = ? AND side = ?`,
  );
  const dropAllSideIndexRows = db.query<unknown, [number]>(
    `DELETE FROM memory_edge_side_tags WHERE edge_row_id = ?`,
  );
  const deleteEdge = db.query<unknown, [number]>(`DELETE FROM memory_edges WHERE id = ?`);
  const insertReceipt = db.query<
    unknown,
    [number, string, string, number, number, string, string, string, string, string, number]
  >(
    `INSERT INTO edge_attribution_receipts
       (edge_row_id, action, side, citing_id, cited_id,
        relation_class, relation_coverage, tail_tag, head_tag, writer, created_at_epoch)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const clearedDeclarations: ClearedDeclaration[] = [];
  const deletedEdges: DeletedIncidentEdge[] = [];
  const stampedCiterIds = new Set<number>();

  for (const row of incident) {
    // The row's live view of its own sides, mutated in place as this loop
    // clears them, so the second side resolves against the first's result.
    const live = { ...row };
    let deleted = false;

    for (const side of SIDES) {
      if (deleted) break;
      const endpointId = side === "tail" ? row.citingId : row.citedId;
      // Only sides whose OWN endpoint moved are re-judged. The far side of an
      // edge whose far endpoint nobody touched is not this verb's business,
      // and re-judging it would let one lane's clear delete another lane's
      // perfectly good edge.
      if (!moved.has(endpointId)) continue;

      const resolved = resolveEdgeSide(live, side, facts);
      const storedTag = edgeSideStoredTag(live, side);

      if (storedTag !== UNDECLARED_SIDE_TAG) {
        const reason: ClearedDeclaration["reason"] | null =
          resolved.outcome === "invalid"
            ? "invalid"
            : resolved.laneCardinality < 2
              ? "redundant"
              : null;
        if (reason === null) {
          // A live declaration on a genuinely ambiguous endpoint: exactly what
          // a stored side is FOR. Left alone.
          continue;
        }
        const nextTail = side === "tail" ? UNDECLARED_SIDE_TAG : live.tailTag;
        const nextHead = side === "head" ? UNDECLARED_SIDE_TAG : live.headTag;
        const sibling = collidingSibling.get(nextTail, nextHead, row.id);
        if (sibling !== null) {
          // The two rows fold. main-agent-edges ticket 13 (P1-3): the
          // survivor is `selectLogicalEdgeRow`'s row over the pair — the SAME
          // rule the write path and the cutover's own fold use — never
          // whichever row happens to be `me` in this loop.
          const winner = selectLogicalEdgeRow([
            { id: row.id, relationClass: row.relationClass },
            sibling,
          ])!;
          if (winner.id === sibling.id) {
            // The sibling survives: this row goes, receipted, and the
            // surviving sibling already carries the cleared shape.
            dropAllSideIndexRows.run(row.id);
            deleteEdge.run(row.id);
            insertReceipt.run(
              row.id,
              "delete-edge",
              side,
              row.citingId,
              row.citedId,
              row.relationClass,
              row.relationCoverage,
              row.tailTag,
              row.headTag,
              ctx.writer,
              ctx.nowEpoch,
            );
            deletedEdges.push({ edgeId: row.id, citingId: row.citingId, citedId: row.citedId, side });
            stampedCiterIds.add(row.citingId);
            deleted = true;
            continue;
          }
          // This row survives instead: its own clear proceeds below, and the
          // sibling — which already carries the exact shape this row is about
          // to take — is the one that goes.
          dropAllSideIndexRows.run(sibling.id);
          deleteEdge.run(sibling.id);
          insertReceipt.run(
            sibling.id,
            "delete-edge",
            side,
            row.citingId,
            row.citedId,
            sibling.relationClass,
            sibling.relationCoverage,
            nextTail,
            nextHead,
            ctx.writer,
            ctx.nowEpoch,
          );
          deletedEdges.push({ edgeId: sibling.id, citingId: row.citingId, citedId: row.citedId, side });
          stampedCiterIds.add(row.citingId);
        }
        clearSide[side].run(row.id);
        dropSideIndexRow.run(row.id, side);
        insertReceipt.run(
          row.id,
          "clear-declaration",
          side,
          row.citingId,
          row.citedId,
          row.relationClass,
          row.relationCoverage,
          row.tailTag,
          row.headTag,
          ctx.writer,
          ctx.nowEpoch,
        );
        clearedDeclarations.push({ edgeId: row.id, side, clearedTag: storedTag, reason });
        stampedCiterIds.add(row.citingId);
        if (side === "tail") {
          live.tailTag = UNDECLARED_SIDE_TAG;
        } else {
          live.headTag = UNDECLARED_SIDE_TAG;
        }
      }

      // AND THAT IS THE WHOLE RULE. A side that resolves `ambiguous` after the
      // clear — or was already ambiguous and had nothing to clear — is left
      // exactly as it is (ruling S15069/T2465-T2466). There is deliberately no
      // re-resolve here and nothing to decide: the edge is kept, the reader
      // renders the side `ambiguous`, and the checker reports it as the E6
      // warning it now is.
    }
  }

  // One revision per citing turn per event, not one per row — the same
  // discipline `clearLane` already kept for its own bulk delete.
  for (const citerId of [...stampedCiterIds].sort((a, b) => a - b)) {
    stampTurnRelationsRevision(db, citerId, ctx.writer, ctx.nowEpoch);
  }

  return {
    clearedDeclarations,
    deletedEdges,
    stampedCiterIds: [...stampedCiterIds].sort((a, b) => a - b),
  };
}
