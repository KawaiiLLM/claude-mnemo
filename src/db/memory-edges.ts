import type { Database } from "bun:sqlite";

import {
  CITATION_RELATIONS,
  isCitationRelation,
  type CitationRelation,
} from "./citations";

/**
 * The universal citation graph (spec D7). One table for every edge the system
 * knows, whatever the endpoints are: turn→turn, turn→segment, segment→segment.
 *
 * Two things are deliberately separate here:
 *
 *   - the EDGE, identified by (citing node, cited node, relation) — a claim
 *     that this thing builds on / implements / supersedes / is evidence for
 *     that thing;
 *   - its PROVENANCE, how the system learned it. Four sources feed the same
 *     edge (retrieval hit, text reference, rollback event, settlement
 *     judgement) and spec D8 counts a pair ONCE no matter how many of them
 *     fired, so provenance sits outside the key as an audit layer.
 */

export const EDGE_NODE_KINDS = ["turn", "segment"] as const;
export type EdgeNodeKind = (typeof EDGE_NODE_KINDS)[number];

export const EDGE_PROVENANCES = [
  "retrieval",
  "text-ref",
  "rollback",
  "judged",
] as const;
export type EdgeProvenance = (typeof EDGE_PROVENANCES)[number];

export { CITATION_RELATIONS, isCitationRelation };
export type { CitationRelation };

export interface EdgeNode {
  kind: EdgeNodeKind;
  id: number;
}

export interface MemoryEdge {
  citing: EdgeNode;
  cited: EdgeNode;
  relation: CitationRelation;
  provenance: EdgeProvenance;
  createdAtEpoch: number;
}

export interface WriteEdgeInput {
  citing: EdgeNode;
  cited: EdgeNode;
  relation: CitationRelation;
  provenance: EdgeProvenance;
}

/**
 * Authority order, used only to settle a conflict on an edge that already
 * exists. A settlement judgement outranks the author's own text reference,
 * which outranks a mechanical rollback pairing, which outranks the weakest
 * signal of all — "the writer had this on screen". An edge's provenance can
 * therefore only ever move UP: re-reading a cited turn must not demote an edge
 * the settlement pass classified.
 */
const PROVENANCE_RANK: Record<EdgeProvenance, number> = {
  retrieval: 0,
  rollback: 1,
  "text-ref": 2,
  judged: 3,
};

/** `PROVENANCE_RANK` as a SQL expression, so the upgrade rule lives once. */
function rankExpression(column: string): string {
  const branches = Object.entries(PROVENANCE_RANK)
    .map(([value, rank]) => `WHEN '${value}' THEN ${rank}`)
    .join(" ");
  return `(CASE ${column} ${branches} ELSE -1 END)`;
}

export function isEdgeNodeKind(value: unknown): value is EdgeNodeKind {
  return (
    typeof value === "string" && (EDGE_NODE_KINDS as readonly string[]).includes(value)
  );
}

export function isEdgeProvenance(value: unknown): value is EdgeProvenance {
  return (
    typeof value === "string" &&
    (EDGE_PROVENANCES as readonly string[]).includes(value)
  );
}

/** The type-prefixed global id (spec D7) — `turn:8942`, `segment:47`. */
export function formatNodeRef(node: EdgeNode): string {
  return `${node.kind}:${node.id}`;
}

export function parseNodeRef(ref: string): EdgeNode | null {
  const match = /^(turn|segment):(\d+)$/.exec(ref.trim());
  if (!match) {
    return null;
  }
  const id = Number.parseInt(match[2]!, 10);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return null;
  }
  return { kind: match[1] as EdgeNodeKind, id };
}

const EDGE_COLUMNS = `
  citing_kind AS citingKind,
  citing_id AS citingId,
  cited_kind AS citedKind,
  cited_id AS citedId,
  relation,
  provenance,
  created_at_epoch AS createdAtEpoch
`;

interface EdgeRow {
  citingKind: EdgeNodeKind;
  citingId: number;
  citedKind: EdgeNodeKind;
  citedId: number;
  relation: CitationRelation;
  provenance: EdgeProvenance;
  createdAtEpoch: number;
}

function mapEdgeRow(row: EdgeRow): MemoryEdge {
  return {
    citing: { kind: row.citingKind, id: row.citingId },
    cited: { kind: row.citedKind, id: row.citedId },
    relation: row.relation,
    provenance: row.provenance,
    createdAtEpoch: row.createdAtEpoch,
  };
}

function isValidNode(node: EdgeNode | undefined): node is EdgeNode {
  return (
    node !== undefined &&
    isEdgeNodeKind(node.kind) &&
    Number.isSafeInteger(node.id) &&
    node.id > 0
  );
}

export interface WriteEdgesResult {
  written: MemoryEdge[];
  rejected: Array<{ input: WriteEdgeInput; reason: string }>;
}

/**
 * Idempotent edge write. A repeat of the same (citing, cited, relation) is not
 * a second row: it upgrades the stored provenance when the new source has more
 * authority and otherwise changes nothing, keeping `created_at_epoch` at the
 * first sighting so "when did this edge appear" stays answerable.
 *
 * Self-loops are rejected — a node confirming itself would inflate its own
 * in-degree, the one mechanical confirmation signal the ranking has. Existence
 * of the endpoints is NOT checked here: callers that take model-supplied ids
 * validate through db/references.ts first, while mechanical callers (rollback
 * pairing, membership derivation) already hold rows.
 */
export function writeMemoryEdges(
  db: Database,
  edges: readonly WriteEdgeInput[],
  nowEpoch: number,
): WriteEdgesResult {
  const written: MemoryEdge[] = [];
  const rejected: WriteEdgesResult["rejected"] = [];

  const upsert = db.query<
    EdgeRow,
    [EdgeNodeKind, number, EdgeNodeKind, number, string, string, number]
  >(
    `
      INSERT INTO memory_edges (
        citing_kind, citing_id, cited_kind, cited_id,
        relation, provenance, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (citing_kind, citing_id, cited_kind, cited_id, relation)
        DO UPDATE SET provenance =
          CASE WHEN ${rankExpression("excluded.provenance")}
                    > ${rankExpression("memory_edges.provenance")}
               THEN excluded.provenance
               ELSE memory_edges.provenance
          END
      RETURNING ${EDGE_COLUMNS}
    `,
  );

  for (const edge of edges) {
    if (!isValidNode(edge?.citing) || !isValidNode(edge?.cited)) {
      rejected.push({ input: edge, reason: "invalid-node" });
      continue;
    }
    if (
      edge.citing.kind === edge.cited.kind &&
      edge.citing.id === edge.cited.id
    ) {
      rejected.push({ input: edge, reason: "self-loop" });
      continue;
    }
    if (!isCitationRelation(edge.relation)) {
      rejected.push({ input: edge, reason: "invalid-relation" });
      continue;
    }
    if (!isEdgeProvenance(edge.provenance)) {
      rejected.push({ input: edge, reason: "invalid-provenance" });
      continue;
    }

    const row = upsert.get(
      edge.citing.kind,
      edge.citing.id,
      edge.cited.kind,
      edge.cited.id,
      edge.relation,
      edge.provenance,
      nowEpoch,
    );
    if (row) {
      written.push(mapEdgeRow(row));
    }
  }

  return { written, rejected };
}

export function getOutgoingEdges(db: Database, citing: EdgeNode): MemoryEdge[] {
  return db
    .query<EdgeRow, [EdgeNodeKind, number]>(
      `SELECT ${EDGE_COLUMNS} FROM memory_edges
       WHERE citing_kind = ? AND citing_id = ?
       ORDER BY cited_kind ASC, cited_id ASC, relation ASC`,
    )
    .all(citing.kind, citing.id)
    .map(mapEdgeRow);
}

export function getIncomingEdges(db: Database, cited: EdgeNode): MemoryEdge[] {
  return db
    .query<EdgeRow, [EdgeNodeKind, number]>(
      `SELECT ${EDGE_COLUMNS} FROM memory_edges
       WHERE cited_kind = ? AND cited_id = ?
       ORDER BY citing_kind ASC, citing_id ASC, relation ASC`,
    )
    .all(cited.kind, cited.id)
    .map(mapEdgeRow);
}

/**
 * De-duplicated in-degree (spec D8): how many DISTINCT nodes cite this one.
 * Two relations between the same pair, or the same pair seen through two
 * provenances, count once — in-degree answers "how many pieces of work
 * consumed this", not "how many claims were filed".
 */
export function getEdgeInDegree(db: Database, cited: EdgeNode): number {
  return (
    db
      .query<{ count: number }, [EdgeNodeKind, number]>(
        `SELECT COUNT(*) AS count FROM (
           SELECT DISTINCT citing_kind, citing_id
           FROM memory_edges
           WHERE cited_kind = ? AND cited_id = ?
         )`,
      )
      .get(cited.kind, cited.id)?.count ?? 0
  );
}

export function countMemoryEdges(db: Database): number {
  return (
    db
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM memory_edges")
      .get()?.count ?? 0
  );
}
