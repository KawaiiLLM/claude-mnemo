import type { Database } from "bun:sqlite";

import {
  CITATION_RELATIONS,
  isCitationRelation,
  type CitationRelation,
} from "./citations";
import { runWriteTransaction } from "./database";
import { liveTurnSql } from "./turn-liveness";
import { EDGE_RELATIONS } from "../shared/turn-phase";

/**
 * The universal citation graph (spec D7). One table for every edge the system
 * knows, whatever the endpoints are: turn→turn, turn→segment, segment→segment,
 * session→turn, session→segment.
 *
 * Three things are deliberately separate here:
 *
 *   - the PAIR, identified by (citing node, cited node) — the fact that one
 *     thing cites another, whether or not anyone has classified WHY yet;
 *   - its RELATION. Edge-mechanism-revision D2 widens identity to
 *     (pair, relation): ONE ROW PER RELATION, so a landing turn can say it
 *     both `depends-on` a plan and `encodes` a ruling about the same target.
 *     A pair may additionally hold ONE BARE row (`relation IS NULL`, a partial
 *     unique index enforces the "at most one"), which records nothing except
 *     that the pair exists. The bare row is therefore the pair's existence
 *     record OF LAST RESORT: a bare write onto a pair that already has any row
 *     is a no-op, and a relation write onto a pair that still carries a bare
 *     row REPLACES it, because the relation row already records the same
 *     existence fact and a second copy of it is noise every reader would have
 *     to de-duplicate. That replacement is why RETRACTING the relation has to
 *     hand the existence question back to prose rather than just deleting a
 *     row (ticket 10, `restoreBareRowsForEmptiedPairs` in db/citations.ts):
 *     the bare row it displaced was the body's own record, and the retraction
 *     said nothing about the body.
 *   - its PROVENANCE, how the system learned it (spec C12: it must tell apart
 *     the main agent's own assertion from a bare textual reference from a
 *     settlement attribution — three of `EDGE_PROVENANCES`' five values).
 *
 * What is GONE (D2): the old "a non-null relation overwrites whatever the pair
 * stored" upsert. A relation write can only ADD a row now; a wrong relation is
 * corrected by RETRACTING it (`retractMemoryEdges`, D3) and writing the right
 * one, so a correction is two auditable acts rather than a silent overwrite.
 * BARE self-loops are refused twice over: at the write path (below, with a
 * reported reason) and by a table-level CHECK, so no SQL path can mint one.
 * A RELATION-carrying self row is a different fact (relation-matrix spec,
 * "自引用", ticket 05): storable here and at the table CHECK unconditionally
 * — this primitive has no `type`/phase information to judge it by, so the
 * phase-scoped legality (which relations, and only when the citing turn's own
 * `type` list spans two phases) is entirely the CALLER's job (`db/citations.ts`,
 * `mcp/note.ts`), the same trust model phase-pair legality for ordinary edges
 * already has here.
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
  /**
   * rubric-v10 ticket 01 ("边的身份"): the surrogate row id. Identity is
   * (citing, cited, relation, tail tag, head tag) — lane-model-v12 ticket 09
   * replaced the merged tag SET component with the arc's two ends — so a
   * pair/relation may legally hold several rows and something has to name ONE
   * of them precisely: this is that name.
   */
  id: number;
  citing: CitingNode;
  cited: EdgeNode;
  /** D2: part of the row's identity. Null = the pair's bare, unattributed citation row. */
  relation: CitationRelation | null;
  /**
   * lane-model-v12 D1: the CITING side's lane, `''` when unsettled. Joins
   * `relation` and `headTag` in the row's identity — a second write of the
   * same (pair, relation) under a DIFFERENT side combination is a second,
   * independent row; the same combination is an idempotent restatement of
   * this one.
   */
  tailTag: string;
  /** lane-model-v12 D1: the CITED side's lane, `''` when unsettled. Identity-bearing, like `tailTag`. */
  headTag: string;
  provenance: EdgeProvenance;
  createdAtEpoch: number;
}

export interface WriteEdgeInput {
  citing: CitingNode;
  cited: EdgeNode;
  relation: CitationRelation | null;
  provenance: EdgeProvenance;
  /**
   * lane-model-v12 D1/D2 (ticket 08): the two sides this write places the edge
   * on — `tailTag` the CITING side, `headTag` the CITED side, `''` (or
   * omitted) meaning UNSETTLED. Storage only: this function does not check
   * that a tag is canonical, declared in that side's segment, or present on
   * that side's endpoint turn — that gate is ticket 08's
   * (`db/lane-edge-gate.ts` -> `shared/turn-phase.ts`), layered above this
   * primitive, the same trust model self-edge legality already has here.
   *
   * These two are now the ONLY lane surface a caller can state: ticket 09
   * deleted the legacy merged `tags` SET (column, index table and the
   * projection that kept them in step), so there is no second representation
   * left to disagree with them.
   *
   * Ignored on a BARE write (`relation: null`): the bare row is the pair's
   * "existence record of last resort" (see the docstring above
   * `EDGE_PROVENANCES`'s home in this file), capped at one per pair by
   * `idx_memory_edges_bare_pair` regardless of lanes, and a lane is a
   * RELATION-level fact.
   */
  tailTag?: string;
  headTag?: string;
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
 * rubric-v10 ticket 01: canonicalize a raw tag list — sorted, deduped,
 * non-string/empty entries dropped.
 *
 * MIGRATION-ERA as of lane-model-v12 ticket 09. It used to compute the row's
 * IMMUTABLE identity form for the merged `tags` column; that column is gone
 * and no live write path calls this any more. Its remaining caller is M-A
 * (`db/schema.ts`), which reads the OLD column off a pre-v12 database and has
 * to canonicalize whatever a release-old row happens to hold before splitting
 * it into one edge per tag.
 */
export function canonicalizeTagSet(tags: unknown): string[] {
  if (!Array.isArray(tags)) {
    return [];
  }
  const set = new Set<string>();
  for (const tag of tags) {
    if (typeof tag === "string" && tag.length > 0) {
      set.add(tag);
    }
  }
  return [...set].sort();
}

/**
 * lane-model-v12 ticket 05 (spec D1): the two ends of a directed edge, named.
 * `tail` is the CITING side (the subject — which lane the reference comes
 * FROM), `head` the CITED side (the object). The words are the rubric's own
 * (弧尾 / 弧头), not new vocabulary.
 */
export const EDGE_SIDES = ["tail", "head"] as const;
export type EdgeSide = (typeof EDGE_SIDES)[number];

/** `''` — the stored value of a side no one has settled yet. NOT NULL, so the identity key keeps de-duplicating; see the column comment in db/schema.ts. */
export const UNSETTLED_SIDE_TAG = "";

export interface EdgeSideTags {
  tailTag: string;
  headTag: string;
}

/**
 * M-A's projection of the OLD tag set onto the two side columns — the one
 * place that answers "what do the side columns say for a row that was written
 * in sets" (lane-model-v12 ticket 05).
 *
 * MIGRATION-ERA as of ticket 09, like `canonicalizeTagSet` above: the set it
 * translates FROM no longer exists on any table this process writes, so its
 * only caller is M-A in `db/schema.ts`, reading a pre-v12 row. Its inverse
 * (`projectSideTagsToTagSet`, the dual-write half) went with the column.
 *
 *   - ONE tag: both sides carry it. A same-lane edge is what a v11 tagged
 *     edge always meant — the tag had to be on both endpoints to be legal at
 *     all — so this is a restatement, not an interpretation.
 *   - NO tags: both sides unsettled. This is the main agent's ordinary write
 *     and, after ticket 08, its only one.
 *   - TWO OR MORE: both sides unsettled, and the set stays in `tags`. The
 *     two-sided model has no single-valued form for a multi-tag edge; its
 *     answer is SEVERAL EDGES, which is what M-A does to the 43 stored rows
 *     of that shape. A write path cannot mint several edges from one input
 *     without breaking `written`'s one-row-per-input contract, and inventing
 *     a winner among the tags would assert an attribution the caller never
 *     made — so it says "not settled", which is the truthful reading and
 *     leaves the row in settlement's own queue. Ticket 08 removes the write
 *     surface that can produce it; ticket 09 removes the set.
 */
export function deriveSideTags(tags: readonly string[]): EdgeSideTags {
  const only = tags.length === 1 ? tags[0]! : UNSETTLED_SIDE_TAG;
  return { tailTag: only, headTag: only };
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
  id,
  citing_kind AS citingKind,
  citing_id AS citingId,
  cited_kind AS citedKind,
  cited_id AS citedId,
  relation,
  provenance,
  tail_tag AS tailTag,
  head_tag AS headTag,
  created_at_epoch AS createdAtEpoch
`;

/**
 * The row ORDER every multi-row read in this file uses after `relation` —
 * lane-model-v12 ticket 09's replacement for the `tags ASC` tiebreak the
 * merged column used to supply. Identity ends in the two sides now, so the
 * two sides are what makes a same-relation group deterministic; ordering by
 * `relation` alone would leave two lane variants of one (pair, relation) in
 * whatever order the b-tree happened to hand back.
 */
const EDGE_IDENTITY_ORDER = "relation ASC, tail_tag ASC, head_tag ASC";

interface EdgeRow {
  id: number;
  citingKind: CitingNodeKind;
  citingId: number;
  citedKind: EdgeNodeKind;
  citedId: number;
  relation: CitationRelation | null;
  provenance: EdgeProvenance;
  tailTag: string;
  headTag: string;
  createdAtEpoch: number;
}

function mapEdgeRow(row: EdgeRow): MemoryEdge {
  return {
    id: row.id,
    citing: { kind: row.citingKind, id: row.citingId },
    cited: { kind: row.citedKind, id: row.citedId },
    relation: row.relation,
    // NOT NULL by schema, but a row read back from a database that predates
    // ticket 05's migration would answer `null` — the sentinel keeps every
    // reader on one convention rather than making each test for null.
    tailTag: row.tailTag ?? UNSETTLED_SIDE_TAG,
    headTag: row.headTag ?? UNSETTLED_SIDE_TAG,
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
 * independent of relation. Exported so every reader that has to talk about a
 * pair as one value — the bare-layer reconcile below, a test's own bookkeeping
 * — spells it the same way rather than inventing a second pair-identity string
 * that could quietly drift from this one. (Ticket 04 retired its largest
 * consumer, the C7 eligibility set; see the note under this function.)
 */
export function pairKey(edge: Pick<WriteEdgeInput, "citing" | "cited">): string {
  return `${edge.citing.kind}:${edge.citing.id}>${edge.cited.kind}:${edge.cited.id}`;
}

/**
 * Edge-mechanism-revision D1/D6 (ticket 04): `WriteMemoryEdgesOptions` and its
 * `eligibleForRelation` gate are GONE — deleted, not defaulted to permissive
 * (spec user story 18: "the C7-era co-occurrence machinery deleted, not
 * bypassed, so that the retired contract cannot half-fire").
 *
 * That option asked one question — "which pairs may receive a relation on this
 * call" — and that question WAS spec C7's pre-existence rule. Ticket 02
 * retired it for the main agent (`attachTurnRelations` answered
 * `"unrestricted"`), and this ticket retires settlement's own frozen
 * pre-run snapshot, which was its last real user. What remains would have been
 * a deny-by-default parameter with no caller able to deny anything: a future
 * writer that forgot it would silently lose its relations to a rule this
 * project no longer holds.
 *
 * Eligibility now lives entirely in each write path's own checks (D1: the
 * citing turn's write gate, address existence, phase legality, self-loop
 * refusal) — one layer, stated once, in `db/citations.ts` and the two tool
 * surfaces above it.
 */

/**
 * Additive, idempotent edge write (D2).
 *
 *   - A RELATION-bearing write inserts one row per (pair, relation). Two
 *     different relations on the same pair are two rows that coexist; a
 *     repeat of the same (pair, relation) changes nothing — neither the
 *     stored provenance nor `created_at_epoch`, both of which record the
 *     FIRST sighting of that particular claim. A relation is never
 *     overwritten by another relation: correcting one means retracting it
 *     (`retractMemoryEdges`) and writing the replacement.
 *   - A BARE write (`relation: null`) records only "this pair exists", so it
 *     is skipped entirely when the pair already holds ANY row. Conversely a
 *     relation write drops the pair's bare row, since the relation row now
 *     carries that same existence fact; the alternative (both rows) would
 *     hand every reader a duplicate to filter out, and would double the row
 *     count of the ordinary main-agent write, which cites a target in prose
 *     and classifies it in the same call.
 *
 * `written` holds exactly one row per ACCEPTED input, in input order: the row
 * that now satisfies it. For a relation input that is the row carrying that
 * relation; for a bare input it is whichever row records the pair (its own
 * bare row when it was inserted, otherwise the pair's first stored row). That
 * one-to-one shape is what callers depend on — `reconcileCitedPairs` returns
 * it as "the pairs this node cites", db/citations.ts turns it into the
 * eligibility set for the relations attached in the same call, and the tool
 * layer counts it into a receipt.
 *
 * Eligibility — whether a relation may attach to a pair at all — is NOT this
 * function's business any more (ticket 04, see the note above the options type
 * this used to take): every caller answers for it through its own address
 * resolution, phase legality and write gate, and this function writes what it
 * is handed.
 *
 * A BARE self-loop is rejected here with a reported reason, and again by the
 * table's own CHECK — an unclassified node confirming itself would inflate
 * its own in-degree with no claim behind it, so no write path (this one, a
 * migration, a hand-written statement) may mint one. A RELATION-carrying self
 * row is a narrower, DELIBERATE exception (ticket 05): the table CHECK admits
 * it unconditionally, and so does this function — the phase-scoped question
 * of WHICH relations may self-cite is answered one layer up, by callers that
 * actually know the citing turn's `type`.
 *
 * Existence of the endpoints is NOT checked here: callers that take
 * model-supplied ids validate through db/references.ts first, while
 * mechanical callers (rollback pairing, membership derivation) already hold
 * rows. Endpoint DELETION is handled downstream: spec C15's kind-aware
 * `AFTER DELETE` triggers on `turns`/`segments`/`sessions` (schema.ts) remove
 * an edge the moment either endpoint disappears, so this function never has
 * to reason about dangling ids.
 */
export function writeMemoryEdges(
  db: Database,
  edges: readonly WriteEdgeInput[],
  nowEpoch: number,
): WriteEdgesResult {
  const written: MemoryEdge[] = [];
  const rejected: WriteEdgesResult["rejected"] = [];

  const insertRelationRow = db.query<
    EdgeRow,
    [
      CitingNodeKind,
      number,
      EdgeNodeKind,
      number,
      string,
      string,
      string,
      string,
      number,
    ]
  >(
    `
      INSERT INTO memory_edges (
        citing_kind, citing_id, cited_kind, cited_id,
        relation, provenance, tail_tag, head_tag, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      -- lane-model-v12 ticket 09: the two SIDE columns are the conflict
      -- target's last two components — identity is (pair, relation, tail,
      -- head), so a DIFFERENT side combination on the same (pair, relation)
      -- is a fresh INSERT (a second, independent row), never a conflict
      -- against a row that names other lanes. The merged tag-set component
      -- ticket 01 put here left with the column. (No backticks in this
      -- template literal: a stray one closes the JS string, not the comment.)
      -- The clause has to name the WHOLE key — SQLite matches an ON CONFLICT
      -- target against a unique constraint by its exact column set, so a
      -- clause that named fewer would not prepare at all (the 2026-08-21
      -- incident, idx_memory_edges_legacy_pair in db/schema.ts).
      ON CONFLICT (
        citing_kind, citing_id, cited_kind, cited_id,
        relation, tail_tag, head_tag
      )
        -- D2: a repeat of the same claim is a NO-OP, not a correction. The
        -- assignment is deliberately the stored value itself: SQLite only
        -- runs RETURNING on a row the statement touched, and this write's
        -- contract is that every accepted input yields the row that now
        -- satisfies it, restatements included.
        DO UPDATE SET relation = memory_edges.relation
      RETURNING ${EDGE_COLUMNS}
    `,
  );

  // lane-model-v12 ticket 05: the query-index maintenance half of a
  // relation-carrying write, one row per SETTLED side, keyed on the edge's
  // own surrogate id. `OR IGNORE` makes this self-healing on a restatement
  // (the row's id is stable across a no-op conflict above, so its side rows
  // are already there) without a redundant existence check, and an unsettled
  // side inserts nothing at all — `''` is the absence of a lane, not a lane
  // (see MEMORY_EDGE_SIDE_TAGS_DDL, db/schema.ts). Ticket 09 removed the
  // second, merged index this used to maintain alongside it.
  const insertSideTagIndexRow = db.query<unknown, [number, EdgeSide, string]>(
    `INSERT OR IGNORE INTO memory_edge_side_tags (edge_row_id, side, tag) VALUES (?, ?, ?)`,
  );

  // The bare row is the pair's existence record of last resort, so it is
  // inserted only when nothing else already records the pair. The guard is a
  // WHERE NOT EXISTS rather than a conflict clause because "any row for this
  // pair" is wider than the partial unique index, which can only stop a
  // SECOND bare row.
  //
  // Neither lane column is named: a bare row is not a lane fact (see
  // `WriteEdgeInput.tailTag`), so both sides take the schema default — the
  // unsettled sentinel — and it contributes no side-index row.
  const insertBarePairRow = db.query<
    EdgeRow,
    [
      CitingNodeKind,
      number,
      EdgeNodeKind,
      number,
      string,
      number,
      CitingNodeKind,
      number,
      EdgeNodeKind,
      number,
    ]
  >(
    `
      INSERT INTO memory_edges (
        citing_kind, citing_id, cited_kind, cited_id,
        relation, provenance, created_at_epoch
      )
      SELECT ?, ?, ?, ?, NULL, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM memory_edges
        WHERE citing_kind = ? AND citing_id = ?
          AND cited_kind = ? AND cited_id = ?
      )
      RETURNING ${EDGE_COLUMNS}
    `,
  );

  const dropBarePairRow = db.query<
    unknown,
    [CitingNodeKind, number, EdgeNodeKind, number]
  >(
    `DELETE FROM memory_edges
     WHERE citing_kind = ? AND citing_id = ? AND cited_kind = ? AND cited_id = ?
       AND relation IS NULL`,
  );

  // NULLs sort first in SQLite's ASC, so a pair that still holds its bare row
  // reports that row, and one that does not reports its lowest-named
  // relation — deterministic either way.
  const readPairRow = db.query<
    EdgeRow,
    [CitingNodeKind, number, EdgeNodeKind, number]
  >(
    `SELECT ${EDGE_COLUMNS} FROM memory_edges
     WHERE citing_kind = ? AND citing_id = ? AND cited_kind = ? AND cited_id = ?
     ORDER BY ${EDGE_IDENTITY_ORDER}
     LIMIT 1`,
  );

  for (const edge of edges) {
    if (!isValidCitingNode(edge?.citing) || !isValidCitedNode(edge?.cited)) {
      rejected.push({ input: edge, reason: "invalid-node" });
      continue;
    }
    // Ticket 05: narrowed to the BARE case — a relation-carrying self row is
    // now a legal storable fact (the table CHECK admits it too), and whether
    // THIS relation may legally self-cite is a phase question this function
    // cannot ask (no `type` in scope), so it is left entirely to the caller.
    if (
      edge.citing.kind === edge.cited.kind &&
      edge.citing.id === edge.cited.id &&
      edge.relation === null
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
    const createdAtEpoch = edge.createdAtEpoch ?? nowEpoch;
    if (edge.relation !== null) {
      // Ticket 08/09: the SIDES are the input and the whole of the stored lane
      // fact — there is no second representation left to keep in step.
      const tailTag = edge.tailTag ?? UNSETTLED_SIDE_TAG;
      const headTag = edge.headTag ?? UNSETTLED_SIDE_TAG;
      const row = insertRelationRow.get(
        edge.citing.kind,
        edge.citing.id,
        edge.cited.kind,
        edge.cited.id,
        edge.relation,
        edge.provenance,
        tailTag,
        headTag,
        createdAtEpoch,
      );
      dropBarePairRow.run(
        edge.citing.kind,
        edge.citing.id,
        edge.cited.kind,
        edge.cited.id,
      );
      if (row) {
        written.push(mapEdgeRow(row));
        for (const side of EDGE_SIDES) {
          const tag = side === "tail" ? tailTag : headTag;
          if (tag !== UNSETTLED_SIDE_TAG) {
            insertSideTagIndexRow.run(row.id, side, tag);
          }
        }
      }
      continue;
    }

    const inserted = insertBarePairRow.get(
      edge.citing.kind,
      edge.citing.id,
      edge.cited.kind,
      edge.cited.id,
      edge.provenance,
      createdAtEpoch,
      edge.citing.kind,
      edge.citing.id,
      edge.cited.kind,
      edge.cited.id,
    );
    const row =
      inserted ??
      readPairRow.get(
        edge.citing.kind,
        edge.citing.id,
        edge.cited.kind,
        edge.cited.id,
      );
    if (row) {
      written.push(mapEdgeRow(row));
    }
  }

  return { written, rejected };
}

export interface RetractEdgeInput {
  citing: CitingNode;
  cited: EdgeNode;
  /**
   * The row to remove. `null` addresses the pair's BARE row specifically — it
   * is not a wildcard over the pair's relations, because "this citation was
   * never classified" and "this classification is wrong" are different
   * retractions and a caller that means one must not silently get the other.
   */
  relation: CitationRelation | null;
  /**
   * lane-model-v12 ticket 08: the two SIDES completing the row address —
   * identity is (pair, relation, tail, head), so a retraction addresses
   * exactly ONE row by naming both. Omitted means unsettled on that side,
   * which addresses the draft row — what every retraction addressed before
   * lanes existed at all.
   *
   * Ticket 09 took the merged `tags` component out of the address with the
   * column. That makes the address STRICTLY WIDER for exactly one legacy
   * shape: a pre-M-A multi-tag row (both sides unsettled, `tags` holding two
   * or more words) used to be unaddressable from here and now answers to the
   * both-sides-unsettled address like any draft row. Not a live concern —
   * M-A splits every such row into one edge per tag before this code can meet
   * one, and no write path can mint a new one — but it is a real difference
   * rather than a rename.
   */
  tailTag?: string;
  headTag?: string;
}

export interface RetractEdgesResult {
  deleted: MemoryEdge[];
  rejected: Array<{ input: RetractEdgeInput; reason: string }>;
}

/**
 * D3: hard-delete an edge, addressed by (pair, relation). Both writers (main
 * agent, settlement) have the same power here — a false assertion must not
 * outlive its refutation, and no tombstone is kept: the audit trail for edge
 * history is the existing database dump/backup, not a graveyard row that every
 * reader would then have to exclude.
 *
 * Retracting a pair's last relation leaves the pair with NO row at all, HERE.
 * This primitive never downgrades it to a bare row: resurrecting the pair as
 * "cited but unclassified" is a claim about the citing body, and this function
 * cannot read one — it is handed nodes, which may be turns, segments or
 * sessions. The caller that CAN read the body decides (ticket 10):
 * `retractTurnRelations` re-scans the citing turn's title/content/insight for
 * exactly the pairs this call emptied and restores the bare row for the ones
 * the prose still names. A caller with no body to scan gets the plain
 * hard-delete, which is the whole truth in that case.
 *
 * Rejected reasons mirror the write path's currency (`invalid-node`,
 * `invalid-relation`), plus `no-such-edge` for an address that resolved but
 * matched nothing — a caller reporting a retraction to a model needs to tell
 * "I removed it" apart from "there was nothing there", which a bare count
 * cannot express.
 */
export function retractMemoryEdges(
  db: Database,
  edges: readonly RetractEdgeInput[],
): RetractEdgesResult {
  const deleted: MemoryEdge[] = [];
  const rejected: RetractEdgesResult["rejected"] = [];

  // `relation IS ?` rather than `=`: null-safe equality, so one statement
  // addresses both a named relation and the bare row. The two SIDE columns
  // complete the row address (lane-model-v12 ticket 08/09): identity is
  // (pair, relation, tail, head), so this deletes exactly ONE row rather than
  // every row a wider (pair, relation) address used to match.
  // `memory_edge_side_tags`' ON DELETE CASCADE (schema.ts) keeps the side
  // index consistent with no code here having to clean it up.
  const del = db.query<
    EdgeRow,
    [CitingNodeKind, number, EdgeNodeKind, number, string | null, string, string]
  >(
    `DELETE FROM memory_edges
     WHERE citing_kind = ? AND citing_id = ? AND cited_kind = ? AND cited_id = ?
       AND relation IS ?
       AND tail_tag = ?
       AND head_tag = ?
     RETURNING ${EDGE_COLUMNS}`,
  );

  for (const edge of edges) {
    if (!isValidCitingNode(edge?.citing) || !isValidCitedNode(edge?.cited)) {
      rejected.push({ input: edge, reason: "invalid-node" });
      continue;
    }
    if (edge.relation !== null && !isCitationRelation(edge.relation)) {
      rejected.push({ input: edge, reason: "invalid-relation" });
      continue;
    }

    const tailTag = edge.tailTag ?? UNSETTLED_SIDE_TAG;
    const headTag = edge.headTag ?? UNSETTLED_SIDE_TAG;
    const rows = del.all(
      edge.citing.kind,
      edge.citing.id,
      edge.cited.kind,
      edge.cited.id,
      edge.relation,
      tailTag,
      headTag,
    );
    if (rows.length === 0) {
      rejected.push({ input: edge, reason: "no-such-edge" });
      continue;
    }
    for (const row of rows) {
      deleted.push(mapEdgeRow(row));
    }
  }

  return { deleted, rejected };
}

export function getOutgoingEdges(db: Database, citing: CitingNode): MemoryEdge[] {
  return db
    .query<EdgeRow, [CitingNodeKind, number]>(
      `SELECT ${EDGE_COLUMNS} FROM memory_edges
       WHERE citing_kind = ? AND citing_id = ?
       ORDER BY cited_kind ASC, cited_id ASC, ${EDGE_IDENTITY_ORDER}`,
    )
    .all(citing.kind, citing.id)
    .map(mapEdgeRow);
}

export function getIncomingEdges(db: Database, cited: EdgeNode): MemoryEdge[] {
  return db
    .query<EdgeRow, [EdgeNodeKind, number]>(
      `SELECT ${EDGE_COLUMNS} FROM memory_edges
       WHERE cited_kind = ? AND cited_id = ?
       ORDER BY citing_kind ASC, citing_id ASC, ${EDGE_IDENTITY_ORDER}`,
    )
    .all(cited.kind, cited.id)
    .map(mapEdgeRow);
}

/**
 * One relation-carrying edge from the perspective of the turn whose
 * `relations` recall field is being rendered (edge-read-surface spec, ticket
 * 01) — the OTHER endpoint's own session/prompt address, pre-joined so the
 * renderer needs no follow-up lookup.
 */
export interface TurnRelationEdgeView {
  relation: CitationRelation;
  /** lane-model-v12 ticket 08: the CITING side's lane, `''` unsettled — the renderer needs each side, since a crossing names two. */
  tailTag: string;
  /** The CITED side's lane, `''` unsettled. */
  headTag: string;
  otherTurnId: number;
  otherSessionId: number;
  otherPromptNumber: number;
}

export interface TurnRelationEdges {
  /** This turn is the citing side — `→ <relation> <other>`. */
  outbound: TurnRelationEdgeView[];
  /** This turn is the cited side — `← <relation> from <other>`. */
  inbound: TurnRelationEdgeView[];
}

interface TurnRelationEdgeRow {
  relation: CitationRelation;
  tailTag: string;
  headTag: string;
  otherTurnId: number;
  otherSessionId: number;
  otherPromptNumber: number;
}

function mapTurnRelationEdgeRow(row: TurnRelationEdgeRow): TurnRelationEdgeView {
  return {
    relation: row.relation,
    tailTag: row.tailTag ?? UNSETTLED_SIDE_TAG,
    headTag: row.headTag ?? UNSETTLED_SIDE_TAG,
    otherTurnId: row.otherTurnId,
    otherSessionId: row.otherSessionId,
    otherPromptNumber: row.otherPromptNumber,
  };
}

/**
 * Edge-read-surface spec, ticket 01: the `relations` recall field's ONLY data
 * source — BOTH directions of one turn's relation-carrying `turn`↔`turn`
 * edges (`relation IS NOT NULL`; a bare existence row has no word to render,
 * so it is excluded here the same way it is invisible to every other reader
 * that only cares about classified citations), Law-8 filtered at BOTH ends
 * the same discipline `mcp/timeline.ts`'s `resolveTurnRowLinks` already
 * applies to the `↳` line — a deleted or dormant endpoint never renders, on
 * either side of the pair. `EDGE_IDENTITY_ORDER` matches this file's own
 * ordering convention (`getOutgoingEdges`/`getIncomingEdges`), so the
 * `relations` field renders deterministically.
 *
 * A relation-carrying SELF row (ticket 05's deliberate exception to the
 * bare-only self-loop refusal) satisfies both queries at once — it is a real
 * edge in both directions on the same node, so it legitimately appears once
 * under `outbound` and once under `inbound`.
 */
export function getTurnRelationEdges(db: Database, turnId: number): TurnRelationEdges {
  const outbound = db
    .query<TurnRelationEdgeRow, [number]>(
      `SELECT e.relation AS relation,
              e.tail_tag AS tailTag, e.head_tag AS headTag,
              cited.id AS otherTurnId, cited.session_id AS otherSessionId,
              cited.prompt_number AS otherPromptNumber
         FROM memory_edges e
         JOIN turns citing ON citing.id = e.citing_id
         JOIN turns cited ON cited.id = e.cited_id
        WHERE e.citing_kind = 'turn' AND e.cited_kind = 'turn'
          AND e.relation IS NOT NULL
          AND e.citing_id = ?
          AND ${liveTurnSql("citing")}
          AND ${liveTurnSql("cited")}
        ORDER BY e.relation ASC, e.tail_tag ASC, e.head_tag ASC`,
    )
    .all(turnId)
    .map(mapTurnRelationEdgeRow);

  const inbound = db
    .query<TurnRelationEdgeRow, [number]>(
      `SELECT e.relation AS relation,
              e.tail_tag AS tailTag, e.head_tag AS headTag,
              citing.id AS otherTurnId, citing.session_id AS otherSessionId,
              citing.prompt_number AS otherPromptNumber
         FROM memory_edges e
         JOIN turns citing ON citing.id = e.citing_id
         JOIN turns cited ON cited.id = e.cited_id
        WHERE e.citing_kind = 'turn' AND e.cited_kind = 'turn'
          AND e.relation IS NOT NULL
          AND e.cited_id = ?
          AND ${liveTurnSql("citing")}
          AND ${liveTurnSql("cited")}
        ORDER BY e.relation ASC, e.tail_tag ASC, e.head_tag ASC`,
    )
    .all(turnId)
    .map(mapTurnRelationEdgeRow);

  return { outbound, inbound };
}

/** One `turn`↔`turn` edge, the shape `shared/milestone-election.ts`'s `LaneEdgeInput` wants — `relation` off the row plus both side columns (lane-model-v12 spec D1: `UNSETTLED_SIDE_TAG` on a side means no one has settled it, never a lane named `''`). */
export interface TurnRelationEdgeLite {
  citingId: number;
  citedId: number;
  relation: string;
  tailTag: string;
  headTag: string;
}

/**
 * Every live `turn`↔`turn` edge touching `turnIds` on EITHER end, current-
 * vocabulary relations only (`EDGE_RELATIONS` — the eight-word set a fresh
 * write may carry; excludes the frozen-legacy `supersedes` word and the bare,
 * relation-NULL existence row, neither of which the election module's own
 * vocabulary reads), each row's two lane sides carried verbatim.
 *
 * The milestone-election module's (`shared/milestone-election.ts`, ticket 02)
 * own DB feed — timeline.ts's `selectMilestoneTurns`/
 * `selectSegmentMilestonesByEdgeSignals` (ticket 03) call this once per
 * selection and hand the result straight to `electMilestones` as
 * `LaneEdgeInput[]`. Distinct from every existing edge reader here: unlike
 * `getOutgoingEdges`/`getIncomingEdges` (one node's own edges) or
 * `db/citations.ts`'s `getSessionEffectiveCitations` (session-scoped, no
 * tags — a citation reader, not a lane-tag reader), election needs the full
 * TAGGED graph touching an explicit, caller-resolved turn set — a session
 * window's turns or one segment's membership, either already resolved by the
 * caller — which is also why this takes a plain id list rather than a
 * session id: the caller (not this function) decides the scope.
 *
 * EITHER end, not both: an override/refutes writer OUTSIDE `turnIds` (a
 * segment's own membership, say) must still be able to exclude a member from
 * candidacy — `electMilestones`'s own contract is that an excluded node's
 * edges keep counting toward every OTHER node's degree even though the node
 * itself never displays, so the caller (`electMilestones`, via its
 * candidates ∩ window-ids filter) is what narrows this wider read back down
 * to the caller's own display scope, not this query.
 */
export function getRelationEdgesAmongTurns(
  db: Database,
  turnIds: readonly number[],
): TurnRelationEdgeLite[] {
  const ids = [...new Set(turnIds)];
  if (ids.length === 0) {
    return [];
  }
  const idPlaceholders = ids.map(() => "?").join(",");
  const relationPlaceholders = EDGE_RELATIONS.map(() => "?").join(",");
  return db
    .query<
      {
        citingId: number;
        citedId: number;
        relation: string;
        tailTag: string;
        headTag: string;
      },
      (number | string)[]
    >(
      `SELECT me.citing_id AS citingId, me.cited_id AS citedId, me.relation AS relation,
              me.tail_tag AS tailTag, me.head_tag AS headTag
       FROM memory_edges me
       JOIN turns tc ON tc.id = me.citing_id
       JOIN turns td ON td.id = me.cited_id
       WHERE (me.citing_id IN (${idPlaceholders}) OR me.cited_id IN (${idPlaceholders}))
         AND me.citing_kind = 'turn' AND me.cited_kind = 'turn'
         AND me.relation IN (${relationPlaceholders})
         AND ${liveTurnSql("tc")} AND ${liveTurnSql("td")}`,
    )
    .all(...ids, ...ids, ...EDGE_RELATIONS)
    .map((row) => ({
      citingId: row.citingId,
      citedId: row.citedId,
      relation: row.relation,
      tailTag: row.tailTag,
      headTag: row.headTag,
    }));
}

/**
 * Pre-release repair R1 #7: ids among `citingTurnIds` that cite (any of
 * `EDGE_RELATIONS`, any tag state) a turn currently `was_rolled_back = 1` —
 * the fact `getRelationEdgesAmongTurns` structurally CANNOT surface, because
 * its own live-turn-scoped SQL requires BOTH endpoints live and a
 * rolled-back cited turn fails that outright by design (it is meant to
 * vanish from the live edge feed). `shared/milestone-election.ts`'s
 * `electMilestones` already honors this fact for its tier-④ corrector rule
 * ("a node that cites, any relation, a turn with `wasRolledBack: true`") —
 * this is the adapter-side query that actually feeds it (its own
 * `rolledBackCiterIds` parameter), separate from the ordinary `laneEdges`
 * feed on purpose: folding it into that feed would mean re-admitting a
 * rolled-back node as a graph endpoint, which is exactly what the live-scope
 * filter exists to prevent.
 *
 * `citingTurnIds` is the caller's own candidate/window set (already known
 * live) — this never widens who MAY become a corrector, only supplies the
 * fact for those who already could be. Ascending, deduped via `DISTINCT`.
 */
export function getRolledBackCiterIds(
  db: Database,
  citingTurnIds: readonly number[],
): number[] {
  const ids = [...new Set(citingTurnIds)];
  if (ids.length === 0) {
    return [];
  }
  const idPlaceholders = ids.map(() => "?").join(",");
  const relationPlaceholders = EDGE_RELATIONS.map(() => "?").join(",");
  return db
    .query<{ citingId: number }, (number | string)[]>(
      `SELECT DISTINCT me.citing_id AS citingId
       FROM memory_edges me
       JOIN turns tc ON tc.id = me.citing_id
       JOIN turns td ON td.id = me.cited_id
       WHERE me.citing_id IN (${idPlaceholders})
         AND me.citing_kind = 'turn' AND me.cited_kind = 'turn'
         AND me.relation IN (${relationPlaceholders})
         AND ${liveTurnSql("tc")}
         AND td.was_rolled_back = 1
       ORDER BY me.citing_id ASC`,
    )
    .all(...ids, ...EDGE_RELATIONS)
    .map((row) => row.citingId);
}

/**
 * lane-model-v12 ticket 08: rows naming `tag` on EITHER SIDE — the side
 * index's own read-back, ordered by edge row id for determinism, and since
 * ticket 09 the ONLY "which rows name this lane" query in the system.
 *
 * It replaced a predecessor that looked up a MERGED tag set — "which lane is
 * this edge INSIDE" — and the difference was exactly a CROSSING: an edge
 * whose two sides name different lanes is inside NEITHER, so the old query
 * could not see it at all, while it plainly still names this lane on one of
 * its ends. A caller asking "is this lane still in use" needs this reading,
 * not that one (`countLaneMemberTurnsInSegment`, db/lanes.ts, whose
 * `undeclare` guard is where the miss had teeth). Ticket 09 deleted that
 * predecessor along with the column it read.
 *
 * The INDEX's read-back applies no liveness filter of its own: "which rows
 * name this lane" is a storage question, and Law 8 is a graph question its
 * callers answer one layer up. Never a second semantics source either —
 * every row it names is re-read from `memory_edges` (`mapEdgeRow` off the
 * `id IN` subquery), so a caller sees exactly the two sides the edge row
 * itself stores, not the index's own bookkeeping.
 */
export function getEdgesBySideTag(db: Database, tag: string): MemoryEdge[] {
  return db
    .query<EdgeRow, [string]>(
      `SELECT ${EDGE_COLUMNS} FROM memory_edges
       WHERE id IN (
         SELECT edge_row_id FROM memory_edge_side_tags WHERE tag = ?
       )
       ORDER BY id ASC`,
    )
    .all(tag)
    .map(mapEdgeRow);
}

/**
 * rubric-v10 ticket 01 ("A query index table... maintained on insert/delete
 * ... It must be rebuildable from the edge table"), inherited by the SIDE
 * index at ticket 05 and the only such rebuild left since ticket 09 deleted
 * the merged one: drop and regenerate `memory_edge_side_tags` from the edge
 * rows' own `tail_tag`/`head_tag` alone. That is what makes it a lookup
 * accelerator rather than a second source of truth — dropping it loses no
 * semantics, only speed, and this always converges to the same content as a
 * database that never lost it.
 *
 * The two `WHERE ... <> ''` arms are the sentinel convention, not an
 * optimisation: an unsettled side has no lane, so it has no row, and a
 * rebuild that materialised one would invent a lane named `''` in every
 * `(side, tag)` lookup.
 *
 * The `Core` half is the same statements WITHOUT the transaction, for a
 * caller that already holds one — M-A (db/schema.ts) rebuilds the index
 * inside the same transaction as the table it just rewrote, and nesting a
 * second `runWriteTransaction` inside an open one does not compose under
 * bun:sqlite's `.immediate()` (see `disposeIllegalEdges` in db/lanes.ts for
 * the same constraint stated at its other end).
 */
export function rebuildMemoryEdgeSideTagsIndexCore(db: Database): void {
  db.exec("DELETE FROM memory_edge_side_tags");
  db.exec(`
    INSERT INTO memory_edge_side_tags (edge_row_id, side, tag)
    SELECT id, 'tail', tail_tag FROM memory_edges WHERE tail_tag <> ''
    UNION ALL
    SELECT id, 'head', head_tag FROM memory_edges WHERE head_tag <> ''
  `);
}

export function rebuildMemoryEdgeSideTagsIndex(db: Database): void {
  runWriteTransaction(db, () => {
    rebuildMemoryEdgeSideTagsIndexCore(db);
  });
}

export interface ReconcileCitedPairsResult {
  /** The citing node's full outgoing set after reconciliation — new pairs and pairs that already existed alike. */
  written: MemoryEdge[];
  /** BARE rows this call removed because no field names them any more; relation rows never appear here (they outlive prose). */
  deleted: MemoryEdge[];
}

/**
 * Spec C6, narrowed by edge-mechanism-revision D1 to the BARE layer: a bare
 * pair row exists if and only if the citing node's body's post-state cites
 * it. `citedNodes` is that post-state, already parsed and resolved by the
 * caller (references.ts) — this function's only job is to make the bare rows
 * of `memory_edges` agree with it, for ONE citing node's outgoing set.
 *
 * Two halves:
 *
 *   - every pair in `citedNodes` is written bare (`relation: null`). For a
 *     pair that already holds any row this is a no-op (D2), so relations
 *     attached by another writer survive a rewrite that still cites the same
 *     target, and the pair is never recorded twice.
 *   - every pair this node currently cites that is NOT in `citedNodes` loses
 *     its BARE row only (edge-mechanism-revision D1, decoupling): the bare row
 *     is prose's own record, so prose withdrawing the mention withdraws it.
 *     RELATION rows are standalone claims declared through the relation
 *     parameters and survive any prose rewrite — deleting them here would let
 *     an ordinary note correction silently destroy edges nobody retracted.
 *     A wrong relation dies by retraction (`retractMemoryEdges`), never by
 *     prose drift.
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
    (edge) =>
      edge.relation === null &&
      !desired.has(`${edge.cited.kind}:${edge.cited.id}`),
  );

  const del = db.query<unknown, [CitingNodeKind, number, EdgeNodeKind, number]>(
    `DELETE FROM memory_edges
     WHERE citing_kind = ? AND citing_id = ? AND cited_kind = ? AND cited_id = ?
       AND relation IS NULL`,
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
 * The DISTINCT is load-bearing under D2's multi-relation storage — one citer
 * that declares two relations about this node is two rows and still one
 * citer — because in-degree answers "how many pieces of work consumed this",
 * not "how many claims were filed".
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
