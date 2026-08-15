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
 * A relative ordering over `EdgeProvenance`, used ONLY by the one-time legacy
 * `turn_citations` collapse in schema.ts (`pickWinningLegacyRelation`) to pick
 * a deterministic winner among several rows the OLD five-column-key schema
 * let the same pair hold at once. It plays NO role in `writeMemoryEdges`'s
 * live upsert below.
 *
 * It used to: a first implementation gated the live upsert on this order, so
 * a relation an `asserted` write set could never be corrected by a `judged`
 * settlement pass — which made spec C7 (settlement corrects with hindsight)
 * unimplementable, and inverted C6 besides, since the bodyless structured
 * write stamps every entry `asserted` regardless of whether any prose cites
 * the target. Spec C14 removes the rank test from the write path entirely:
 * eligibility belongs to each write path (ticket 07), not to a global
 * ordering — a source ranking has no say in whether a relation may be
 * corrected.
 */
const PROVENANCE_RANK: Record<EdgeProvenance, number> = {
  retrieval: 0,
  rollback: 1,
  "text-ref": 2,
  judged: 3,
  asserted: 4,
};

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
 * second row (spec C5): a non-null incoming relation REPLACES the stored
 * relation AND the provenance recording where it came from, unconditionally —
 * no source ranking stands between an authorised write and the relation it
 * sets (spec C14). Eligibility — whether THIS call is entitled to set or
 * correct a relation on THIS pair — is not this function's job; it belongs to
 * each write path (ticket 07: a main-agent write needs the target cited in
 * its own body's post-state, a settlement write needs the pair already
 * present in its transaction's pre-state). A relation of `null` (a bare
 * reference) never clears or relabels an existing relation, and never touches
 * its provenance either — a citation in prose says the pair exists and says
 * nothing about its relation, so relation and provenance move as one unit,
 * driven only by a write that actually carries a relation. `created_at_epoch`
 * stays at the first sighting so "when did this edge appear" stays
 * answerable.
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
 * membership derivation) already hold rows. Endpoint DELETION is handled
 * downstream of this function: spec C15's kind-aware `AFTER DELETE` triggers
 * on `turns`/`segments`/`sessions` (schema.ts) remove an edge the moment
 * either endpoint disappears, so this function never has to reason about
 * dangling ids.
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
          -- Spec C14: no rank test between an authorised write and the
          -- relation it sets. A relation-bearing write replaces relation AND
          -- provenance together, unconditionally; a bare write (relation
          -- NULL) touches neither — it can create a pair but never modify a
          -- relation one already carries.
          relation = CASE
            WHEN excluded.relation IS NOT NULL THEN excluded.relation
            ELSE memory_edges.relation
          END,
          provenance = CASE
            WHEN excluded.relation IS NOT NULL THEN excluded.provenance
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
