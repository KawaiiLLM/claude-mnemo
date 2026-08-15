import type { Database } from "bun:sqlite";

import {
  CITATION_RELATIONS,
  isCitationRelation,
  type CitationRelation,
} from "./citations";

/**
 * The universal citation graph (spec D7; identity narrowed by ticket 05/spec
 * C5). One table for every edge the system knows, whatever the endpoints are:
 * turn→turn, turn→segment, segment→segment, session→turn, session→segment.
 *
 * Three things are deliberately separate here:
 *
 *   - the PAIR, identified by (citing node, cited node) — the fact that one
 *     thing cites another, whether or not anyone has classified WHY yet;
 *   - its RELATION (spec C5), a nullable ATTRIBUTE of the pair rather than
 *     part of its identity — a bare/unattributed citation is a real, storable
 *     state, and correcting a relation updates the row instead of inserting
 *     a second one under the same pair;
 *   - its PROVENANCE, how the system learned it (spec C12: it must tell apart
 *     the main agent's own assertion from a bare textual reference from a
 *     settlement attribution — three of `EDGE_PROVENANCES`' five values).
 *     Spec D8 counts a pair ONCE no matter how many provenances fired, so
 *     provenance sits outside the key as an audit layer.
 */

export const EDGE_NODE_KINDS = ["turn", "segment"] as const;
export type EdgeNodeKind = (typeof EDGE_NODE_KINDS)[number];

// C10: `citing_kind` additionally admits `session`, so a session summary
// field can carry a citation. Nothing "flows trust" toward a container the
// way it does toward a turn or segment's conclusion (spec C1), so a session
// is never a citation TARGET — `cited_kind` stays turn/segment.
export const CITING_NODE_KINDS = ["turn", "segment", "session"] as const;
export type CitingNodeKind = (typeof CITING_NODE_KINDS)[number];

export const EDGE_PROVENANCES = [
  "retrieval",
  "text-ref",
  "rollback",
  "judged",
  "asserted",
] as const;
export type EdgeProvenance = (typeof EDGE_PROVENANCES)[number];

export { CITATION_RELATIONS, isCitationRelation };
export type { CitationRelation };

export interface EdgeNode {
  kind: EdgeNodeKind;
  id: number;
}

/** The citing side's node — wider than `EdgeNode` because C10 admits `session`. */
export interface CitingNode {
  kind: CitingNodeKind;
  id: number;
}

export interface MemoryEdge {
  citing: CitingNode;
  cited: EdgeNode;
  /** C5: an attribute of the pair, not part of its identity. Null = a bare, unattributed citation. */
  relation: CitationRelation | null;
  provenance: EdgeProvenance;
  createdAtEpoch: number;
}

export interface WriteEdgeInput {
  citing: CitingNode;
  cited: EdgeNode;
  relation: CitationRelation | null;
  provenance: EdgeProvenance;
  /**
   * Historical override for a one-time backfill (schema.ts's legacy
   * `turn_citations` retirement): the row being carried across already
   * happened at a real moment, and re-stamping it "now" would make "when did
   * this edge first appear" lie. Every live caller omits this and gets the
   * batch's own `nowEpoch`.
   */
  createdAtEpoch?: number;
}

/**
 * Authority order, used only to settle a conflict on a PAIR that already
 * exists. Re-reading a cited turn ('retrieval') is the weakest signal; a
 * mechanical rollback pairing is a notch stronger; a bare textual reference
 * ('text-ref') is stronger still because a human named the pair; a
 * settlement judgement ('judged') outranks all three because it is a
 * considered classification, not a byproduct of some other action.
 * `asserted` — the main agent naming a relation in the SAME call that writes
 * the citing prose (spec C7/C12) — outranks even that: the argument and the
 * claim arrive together, the strongest evidence this system ever has for a
 * relation. This is also why C7 lets settlement CORRECT a relation but never
 * MINT one on a pair it did not watch get created — hindsight outranks
 * nothing here, it only gets to act where authorship left a gap.
 *
 * An edge's provenance can therefore only ever move UP: re-reading a cited
 * turn must not demote an edge the settlement pass (or the main agent)
 * already classified.
 */
const PROVENANCE_RANK: Record<EdgeProvenance, number> = {
  retrieval: 0,
  rollback: 1,
  "text-ref": 2,
  judged: 3,
  asserted: 4,
};

/** `PROVENANCE_RANK` as a SQL expression, so the upgrade rule lives once. */
function rankExpression(column: string): string {
  const branches = Object.entries(PROVENANCE_RANK)
    .map(([value, rank]) => `WHEN '${value}' THEN ${rank}`)
    .join(" ");
  return `(CASE ${column} ${branches} ELSE -1 END)`;
}

/** `PROVENANCE_RANK`, exposed for the one-time legacy collapse in schema.ts — kept in one place so the two never drift. */
export function rankEdgeProvenance(provenance: EdgeProvenance): number {
  return PROVENANCE_RANK[provenance];
}

export function isEdgeNodeKind(value: unknown): value is EdgeNodeKind {
  return (
    typeof value === "string" && (EDGE_NODE_KINDS as readonly string[]).includes(value)
  );
}

export function isCitingNodeKind(value: unknown): value is CitingNodeKind {
  return (
    typeof value === "string" &&
    (CITING_NODE_KINDS as readonly string[]).includes(value)
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
  citingKind: CitingNodeKind;
  citingId: number;
  citedKind: EdgeNodeKind;
  citedId: number;
  relation: CitationRelation | null;
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

function isValidCitingNode(node: CitingNode | undefined): node is CitingNode {
  return (
    node !== undefined &&
    isCitingNodeKind(node.kind) &&
    Number.isSafeInteger(node.id) &&
    node.id > 0
  );
}

function isValidCitedNode(node: EdgeNode | undefined): node is EdgeNode {
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

function pairKey(edge: Pick<WriteEdgeInput, "citing" | "cited">): string {
  return `${edge.citing.kind}:${edge.citing.id}>${edge.cited.kind}:${edge.cited.id}`;
}

/**
 * Idempotent edge write. A repeat of the same (citing, cited) pair is not a
 * second row (spec C5): it upgrades the stored provenance when the new
 * source has more authority, and — independently — it lets a non-null
 * incoming relation REPLACE the stored one whenever the incoming provenance's
 * authority is at least the stored provenance's, which is what makes
 * "correcting a relation" a same-row update rather than a new insert. A
 * relation of `null` (a bare reference) never clears an existing relation:
 * weaker or merely-repeated information cannot retract a classification.
 * `created_at_epoch` stays at the first sighting so "when did this edge
 * appear" stays answerable.
 *
 * Self-loops are rejected — a node confirming itself would inflate its own
 * in-degree, the one mechanical confirmation signal the ranking has.
 * Naming the same target under two DIFFERENT non-null relations within one
 * call is also rejected — spec C5's "at most one current relation" — because
 * a single batch cannot express which of two claims about the same pair is
 * the correction and which is the mistake; both are dropped rather than
 * letting array order silently pick a winner. Existence of the endpoints is
 * NOT checked here: callers that take model-supplied ids validate through
 * db/references.ts first, while mechanical callers (rollback pairing,
 * membership derivation) already hold rows.
 */
export function writeMemoryEdges(
  db: Database,
  edges: readonly WriteEdgeInput[],
  nowEpoch: number,
): WriteEdgesResult {
  const written: MemoryEdge[] = [];
  const rejected: WriteEdgesResult["rejected"] = [];

  const relationsByPair = new Map<string, Set<CitationRelation>>();
  for (const edge of edges) {
    if (
      !isValidCitingNode(edge?.citing) ||
      !isValidCitedNode(edge?.cited) ||
      !isCitationRelation(edge.relation)
    ) {
      continue;
    }
    const key = pairKey(edge);
    const relations = relationsByPair.get(key) ?? new Set<CitationRelation>();
    relations.add(edge.relation);
    relationsByPair.set(key, relations);
  }
  const conflictingPairs = new Set(
    [...relationsByPair.entries()]
      .filter(([, relations]) => relations.size > 1)
      .map(([key]) => key),
  );

  const upsert = db.query<
    EdgeRow,
    [CitingNodeKind, number, EdgeNodeKind, number, string | null, string, number]
  >(
    `
      INSERT INTO memory_edges (
        citing_kind, citing_id, cited_kind, cited_id,
        relation, provenance, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (citing_kind, citing_id, cited_kind, cited_id)
        DO UPDATE SET
          relation = CASE
            WHEN excluded.relation IS NOT NULL
             AND ${rankExpression("excluded.provenance")}
                 >= ${rankExpression("memory_edges.provenance")}
            THEN excluded.relation
            ELSE memory_edges.relation
          END,
          provenance = CASE
            WHEN ${rankExpression("excluded.provenance")}
                 > ${rankExpression("memory_edges.provenance")}
            THEN excluded.provenance
            ELSE memory_edges.provenance
          END
      RETURNING ${EDGE_COLUMNS}
    `,
  );

  for (const edge of edges) {
    if (!isValidCitingNode(edge?.citing) || !isValidCitedNode(edge?.cited)) {
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
    if (edge.relation !== null && !isCitationRelation(edge.relation)) {
      rejected.push({ input: edge, reason: "invalid-relation" });
      continue;
    }
    if (!isEdgeProvenance(edge.provenance)) {
      rejected.push({ input: edge, reason: "invalid-provenance" });
      continue;
    }
    if (edge.relation !== null && conflictingPairs.has(pairKey(edge))) {
      rejected.push({ input: edge, reason: "conflicting-relation" });
      continue;
    }

    const row = upsert.get(
      edge.citing.kind,
      edge.citing.id,
      edge.cited.kind,
      edge.cited.id,
      edge.relation,
      edge.provenance,
      edge.createdAtEpoch ?? nowEpoch,
    );
    if (row) {
      written.push(mapEdgeRow(row));
    }
  }

  return { written, rejected };
}

export function getOutgoingEdges(db: Database, citing: CitingNode): MemoryEdge[] {
  return db
    .query<EdgeRow, [CitingNodeKind, number]>(
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
 * Two relations between the same pair cannot exist any more (spec C5), but a
 * pair seen through two provenances still counts once — in-degree answers
 * "how many pieces of work consumed this", not "how many claims were filed".
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
