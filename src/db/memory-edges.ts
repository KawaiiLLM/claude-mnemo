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

/**
 * The pair's identity string (spec C5): `(citing kind:id)>(cited kind:id)`,
 * independent of relation. Exported so a caller can build an ELIGIBILITY set
 * in the same currency `writeMemoryEdges` checks it against — ticket 07's
 * `eligibleForRelation` (below) and the settlement write-back's pre-state
 * snapshot (`getExistingEdgePairKeys`) both key off this, rather than each
 * inventing its own pair-identity string that could quietly drift from it.
 */
export function pairKey(edge: Pick<WriteEdgeInput, "citing" | "cited">): string {
  return `${edge.citing.kind}:${edge.citing.id}>${edge.cited.kind}:${edge.cited.id}`;
}

export interface WriteMemoryEdgesOptions {
  /**
   * Ticket 07 (spec C7/C14): pair keys (see `pairKey`) that MAY receive a
   * non-null relation on THIS call. Checked only against a relation-BEARING
   * write — a bare (`relation: null`) edge never needs to appear here,
   * because C6/C7's "settlement writing a body whose citations create bare
   * pairs stays legal" rule is about the pair, not about who classified it;
   * gating bare writes too would re-introduce the free-standing-edge problem
   * C6 already closed, just from the opposite direction.
   *
   * Omitted (the default) means NO eligibility check runs at all — every
   * caller that does not pass this keeps writing relations exactly as it did
   * before ticket 07 existed. This is deliberately OPT-IN rather than a
   * global default-deny: C14's own rule is that eligibility lives in each
   * write path, not in a property of the primitive every caller inherits
   * whether it asked for one or not, and a default-deny would have broken
   * every direct caller of this function that has no C7 stake at all
   * (schema-migration collapse, and this file's own test suite exercising
   * the upsert itself). The two callers ticket 07 actually gates — the main
   * agent's own relation fields (db/citations.ts's `attachTurnRelations`)
   * and the settlement write-back's judged edges — compute and pass this
   * explicitly.
   */
  eligibleForRelation?: ReadonlySet<string>;
}

/**
 * Idempotent edge write. A repeat of the same (citing, cited) pair is not a
 * second row (spec C5): a non-null incoming relation REPLACES the stored
 * relation AND the provenance recording where it came from, unconditionally —
 * no source ranking stands between an authorised write and the relation it
 * sets (spec C14). Eligibility — whether THIS call is entitled to set or
 * correct a relation on THIS pair — is `options.eligibleForRelation`: a
 * main-agent write needs the target cited in its own body's post-state, a
 * settlement write needs the pair already present in its transaction's
 * pre-state (ticket 07). Each caller computes its own set; this function only
 * enforces membership in whatever set it was handed. A relation of `null` (a
 * bare reference) never clears or relabels an existing relation, and never
 * touches its provenance either — a citation in prose says the pair exists
 * and says nothing about its relation, so relation and provenance move as one
 * unit, driven only by a write that actually carries a relation.
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
  options: WriteMemoryEdgesOptions = {},
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
    // Ticket 07 (spec C7/C14): only a relation-BEARING write is gated — a
    // bare write always passes, whatever `eligibleForRelation` contains,
    // which is what keeps a mechanically derived bare pair (segment anchors,
    // `reconcileCitedPairs`'s own recompute) legal regardless of who is
    // writing it.
    if (
      edge.relation !== null &&
      options.eligibleForRelation !== undefined &&
      !options.eligibleForRelation.has(pairKey(edge))
    ) {
      rejected.push({ input: edge, reason: "relation-ineligible" });
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

export interface ReconcileCitedPairsResult {
  /** The citing node's full outgoing set after reconciliation — new pairs and pairs that already existed alike. */
  written: MemoryEdge[];
  /** Pairs this call removed because no field supports them any more, relation included. */
  deleted: MemoryEdge[];
}

/**
 * Spec C6: a pair exists if and only if the citing node's body's post-state
 * cites it. `citedNodes` is that post-state, already parsed and resolved by
 * the caller (references.ts) — this function's only job is to make
 * `memory_edges` agree with it, for ONE citing node's outgoing set.
 *
 * Two halves:
 *
 *   - every pair in `citedNodes` is upserted with `relation: null` — a bare,
 *     unattributed citation (spec C5). For a pair that already existed this is
 *     a no-op on relation/provenance: `writeMemoryEdges`'s null-relation
 *     upsert never touches either (spec C14), so a relation attached by
 *     another writer survives a rewrite that still cites the same target.
 *   - every pair this node currently cites that is NOT in `citedNodes` is
 *     DELETED outright, relation and all — a relation cannot outlive the pair
 *     that carries it, and there is no "keep the relation, drop the pair"
 *     state for it to fall back to.
 *
 * Whole-node rescan, not a per-field diff (spec C6's own text: turn, segment
 * and session field counts are all bounded, so re-deriving the full set on
 * every write and diffing it against what is already stored is simplest).
 */
export function reconcileCitedPairs(
  db: Database,
  citing: CitingNode,
  citedNodes: readonly EdgeNode[],
  nowEpoch: number,
  provenance: EdgeProvenance,
): ReconcileCitedPairsResult {
  const desired = new Map<string, EdgeNode>();
  for (const node of citedNodes) {
    if (isValidCitedNode(node)) {
      desired.set(`${node.kind}:${node.id}`, node);
    }
  }

  const existing = getOutgoingEdges(db, citing);
  const stale = existing.filter(
    (edge) => !desired.has(`${edge.cited.kind}:${edge.cited.id}`),
  );

  const del = db.query<unknown, [CitingNodeKind, number, EdgeNodeKind, number]>(
    `DELETE FROM memory_edges
     WHERE citing_kind = ? AND citing_id = ? AND cited_kind = ? AND cited_id = ?`,
  );
  for (const edge of stale) {
    del.run(citing.kind, citing.id, edge.cited.kind, edge.cited.id);
  }

  const { written } = writeMemoryEdges(
    db,
    [...desired.values()].map((cited) => ({
      citing,
      cited,
      relation: null,
      provenance,
    })),
    nowEpoch,
  );

  return { written, deleted: stale };
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

/**
 * Every stored pair, as `pairKey` strings (spec C7, ticket 07). The one
 * caller today is the settlement write-back's pre-state snapshot: a judged
 * relation is eligible only on a pair present BEFORE that transaction's own
 * writes land, and the snapshot has to be taken before ANY of them — a fresh
 * segment this same reply is about to create, its anchors, or an earlier
 * `edges` entry in the very same reply — because a snapshot taken even one
 * write later would see the call's own work and silently admit it.
 *
 * The whole table, not a query targeted at the reply's candidate pairs: the
 * candidates are only knowable after `edges`' tokens resolve, and a token
 * naming a segment THIS reply's own step 1 is about to mint cannot be
 * resolved before that step runs — so a targeted query would have to
 * reproduce the write-back's own ordering to get right, and get it wrong the
 * first time an ordering changed. Scanning the whole table sidesteps that
 * entirely and costs nothing worth optimising away at today's row counts.
 */
export function getExistingEdgePairKeys(db: Database): ReadonlySet<string> {
  return new Set(
    db
      .query<
        {
          citingKind: CitingNodeKind;
          citingId: number;
          citedKind: EdgeNodeKind;
          citedId: number;
        },
        []
      >(
        `SELECT citing_kind AS citingKind, citing_id AS citingId,
                cited_kind AS citedKind, cited_id AS citedId
         FROM memory_edges`,
      )
      .all()
      .map((row) =>
        pairKey({
          citing: { kind: row.citingKind, id: row.citingId },
          cited: { kind: row.citedKind, id: row.citedId },
        }),
      ),
  );
}

export function countMemoryEdges(db: Database): number {
  return (
    db
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM memory_edges")
      .get()?.count ?? 0
  );
}
