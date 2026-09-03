import type { Database } from "bun:sqlite";

import { runWriteTransaction } from "./database";
import { liveTurnSql } from "./turn-liveness";
import {
  checkRelationCoverage,
  displayEdgeRelation,
  edgeRelationClass,
  isRelationClass,
  isRelationCoverage,
  NO_RELATION_CLASS,
  NO_RELATION_COVERAGE,
  type RelationClass,
  relationClassBearingSql,
  type RelationClassValue,
  type RelationCoverageValue,
} from "../shared/relation-class";

/**
 * The universal citation graph (spec D7). One table for every edge the system
 * knows, whatever the endpoints are: turn→turn, turn→segment, segment→segment,
 * session→turn, session→segment.
 *
 * Three things are deliberately separate here:
 *
 *   - the PAIR, identified by (citing node, cited node) — and, since
 *     main-agent-edges D5, THE WHOLE OF A ROW'S IDENTITY. **One pair, one
 *     row.** The (pair, relation, tail, head) identity D2 and lane-model-v12
 *     built up is retired here: a second class on a pair PROMOTES the row it
 *     already has (`writeMemoryEdges` below), a second side placement changes
 *     nothing, and no write path can mint a second physical row for one
 *     logical edge. Since ticket 01's cutover the physical UNIQUE key IS the
 *     pair, so the table refuses what this layer never writes.
 *   - its CLASS and COVERAGE — `correct`/`verify`/`use`, plus `full`/`partial`
 *     on a `correct`. This is what a writer asserts, and what a promotion
 *     rewrites in place. (The seven-word `relation` column that used to spell
 *     the same judgment was dropped at the cutover, ticket 01.)
 *   - its PROVENANCE, how the system learned it (spec C12: it must tell apart
 *     the main agent's own assertion from a settlement attribution). Preserved
 *     across a promotion: the row records who FIRST filed the claim.
 *
 * WORDLESS (BARE) ROWS ARE RETIRED (main-agent-edges D1, T2419/T2421). Every
 * input carries a class — the "existence record of last resort" the pair used
 * to keep for prose that names a target without classifying it is a fact
 * nothing acts on, and the readers that used to consume it
 * (`getEffectiveCitations`' union, the `↳` pull-through) still see the prose
 * through `parseInlineCitations`. The cutover (ticket 01) deleted the stored
 * ones; in the deferral window before it runs a relation write onto such a
 * pair still drops the stale row it displaces, so bare and relation rows never
 * coexist on the way out.
 *
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
//
// This is the table's HISTORICAL capacity — what the retired bare rows held.
// container-unification D10 narrowed the relation-carrying population to
// `(turn, turn)`, and since the cutover (ticket 01) every row is one: the
// post-cutover CHECK refuses any other kind. The wider kind lists stay in the
// TypeScript vocabulary so a receipt row that copied an old bare row still
// types, and nothing else.
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
   * rubric-v10 ticket 01 ("边的身份"): the surrogate row id — what the side
   * index and a declaration address. Since the cutover the pair itself is
   * UNIQUE, so the id and the pair name the same row.
   */
  id: number;
  citing: CitingNode;
  cited: EdgeNode;
  /**
   * lane-model-v12 D1: the CITING side's stored DECLARATION, `''` when none.
   * Not identity-bearing since the cutover: it means "this endpoint is in
   * several lanes and this is the one" (spec D2), and which lane a side
   * attributes to is `db/edge-side-resolution.ts`'s answer.
   */
  tailTag: string;
  /** lane-model-v12 D1: the CITED side's stored declaration, `''` when none. See `tailTag`. */
  headTag: string;
  /**
   * The THREE-CLASS value — `correct`, `verify`, `use`. NOT NULL and CHECKed
   * on the post-cutover table; `''` is reachable only for a row read in the
   * deferral window (`shared/relation-class.ts`, module header), which every
   * reader treats as "not an edge".
   */
  relationClass: RelationClassValue;
  /** relation-vocabulary-v13 ticket 02: `full`/`partial` on a `correct` row, `''` everywhere else. The STORED bit a reader asks "can I still rely on the cited claim". */
  relationCoverage: RelationCoverageValue;
  provenance: EdgeProvenance;
  createdAtEpoch: number;
}

export interface WriteEdgeInput {
  citing: CitingNode;
  cited: EdgeNode;
  /**
   * The class this write asserts — REQUIRED (main-agent-edges D1: the
   * wordless write path is retired; a caller with no class has nothing to
   * record). The class/coverage pairing is checked here as well as by the
   * table's CHECK and by `checkRelationCoverage` above this layer, so a
   * malformed pair is a named rejection rather than a thrown constraint.
   */
  relationClass: RelationClass;
  /** `full`/`partial` on a `correct` class, `''` (or omitted) on the other two. */
  relationCoverage?: RelationCoverageValue;
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
   * main-agent-edges D4/D5: THEY APPLY ONLY WHEN THIS WRITE CREATES THE ROW.
   * A write onto a pair that already holds a row PROMOTES that row's class and
   * coverage and leaves its sides exactly as stored — "a second side placement
   * → never a new row", and never a silent re-placement either. Changing a
   * stored side is `declareEdgeSides`' job (db/citations.ts): declaration is
   * an in-place patch with its own validation (the tag must be one of that
   * endpoint's current lane tags, and an endpoint in fewer than two lanes is
   * refused as derivable), none of which this storage primitive can run.
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
  provenance,
  tail_tag AS tailTag,
  head_tag AS headTag,
  relation_class AS relationClass,
  relation_coverage AS relationCoverage,
  created_at_epoch AS createdAtEpoch
`;

/**
 * The row ORDER every multi-row read in this file uses within a node's edges.
 * One pair holds one row (the cutover's UNIQUE key), so after the pair
 * columns there is nothing left to tie-break on but the id — and the id is
 * what keeps a read deterministic while the deferral window can still hold a
 * legacy multi-row pair.
 */
const EDGE_IDENTITY_ORDER = "id ASC";

interface EdgeRow {
  id: number;
  citingKind: CitingNodeKind;
  citingId: number;
  citedKind: EdgeNodeKind;
  citedId: number;
  provenance: EdgeProvenance;
  tailTag: string;
  headTag: string;
  relationClass: RelationClassValue | null;
  relationCoverage: RelationCoverageValue | null;
  createdAtEpoch: number;
}

function mapEdgeRow(row: EdgeRow): MemoryEdge {
  return {
    id: row.id,
    citing: { kind: row.citingKind, id: row.citingId },
    cited: { kind: row.citedKind, id: row.citedId },
    // NOT NULL by schema, but a row read back from a database that predates
    // ticket 05's migration would answer `null` — the sentinel keeps every
    // reader on one convention rather than making each test for null.
    tailTag: row.tailTag ?? UNSETTLED_SIDE_TAG,
    headTag: row.headTag ?? UNSETTLED_SIDE_TAG,
    // Same "one convention, not a null test per reader" rule the two sides
    // above follow: a row read back before ticket 02's ADD COLUMN migration
    // has run answers null, and `''` is what every reader is written against.
    relationClass: row.relationClass ?? NO_RELATION_CLASS,
    relationCoverage: row.relationCoverage ?? NO_RELATION_COVERAGE,
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
  /**
   * main-agent-edges D5: rows this call PROMOTED in place — a stronger class,
   * or a coverage change on a `correct`. Reported apart from `written` (which
   * carries every accepted input's resulting row, promoted rows included)
   * because a promotion is a real mutation the citing turn owes a relations
   * stamp for, while a weaker or identical restatement is not.
   */
  promoted: MemoryEdge[];
  rejected: Array<{ input: WriteEdgeInput; reason: string }>;
}

/**
 * main-agent-edges D5's precedence, as one number: `use` < `verify` <
 * `correct`. "Most specific" is the maximum of this rank, and a class strictly
 * below the stored one is the no-op case.
 *
 * COVERAGE IS NOT PART OF THE RANK, on purpose. `correct/full` and
 * `correct/partial` are the SAME specificity — one says the cited result is
 * wholly unusable as a premise, the other that a definite part still stands,
 * and neither is a stronger claim than the other. That is exactly why the two
 * of them on one pair in ONE call refuse the call by name (`db/citations.ts`)
 * instead of silently picking a winner, and why a LATER coverage change is a
 * promotion rather than a weaker no-op: it is a correction of the bit, not a
 * demotion of the class.
 */
export const RELATION_CLASS_SPECIFICITY: Record<RelationClass, number> = {
  use: 0,
  verify: 1,
  correct: 2,
};

/**
 * The pair's ONE row, most specific first (main-agent-edges D5). After the
 * cutover a pair holds exactly one row and this is a lookup; on the
 * pre-cutover stock the cutover's fold (`db/schema.ts`,
 * `runMainAgentEdgesCutover`) IMPORTS this function to choose the survivor,
 * and in the deferral window the write path meets the same legacy multi-row
 * pairs — so the write path and the migration cannot disagree about which row
 * IS the edge: most specific class, then the lowest row id (whose provenance
 * and creation time survive).
 *
 * Wordless rows (`relationClass === ''`, deferral window only) are excluded:
 * they are not edges (this module's header), and a relation write drops the
 * one it displaces rather than promoting it.
 *
 * GENERIC over anything that carries `id` plus a `relationClass` column
 * (main-agent-edges ticket 13, P1-3) — every collision site that has to
 * decide a survivor calls THIS function rather than growing its own
 * provenance/time comparator, and each reads a different row shape off raw
 * SQL (`MemoryEdge`, `lanes.ts`'s `LaneMergeEdgeRow`, `normalize-incident-
 * attribution.ts`'s `IncidentEdgeRow`) — most of them typed `relationClass:
 * string` rather than the narrower `RelationClassValue`, which is why the
 * bound below is the field this function actually reads rather than
 * `RelationClassBearingRow`: coverage plays no part in the rank (the module
 * header above explains why), so nothing here needs it.
 */
export function selectLogicalEdgeRow<T extends { id: number; relationClass: string }>(
  rows: readonly T[],
): T | null {
  let best: T | null = null;
  let bestRank = -1;
  for (const row of rows) {
    if (!isRelationClass(row.relationClass)) {
      continue;
    }
    const rank = RELATION_CLASS_SPECIFICITY[row.relationClass];
    if (best === null || rank > bestRank || (rank === bestRank && row.id < best.id)) {
      best = row;
      bestRank = rank;
    }
  }
  return best;
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
 * ONE PAIR, ONE ROW (main-agent-edges D5). A relation write either CREATES the
 * pair's row or PROMOTES the row it already has, in place:
 *
 *   - no row for the pair -> INSERT, with this call's class, coverage, sides
 *     and provenance;
 *   - a stored row of a STRICTLY LOWER class -> in-place UPDATE of
 *     `relation_class`/`relation_coverage`. The row id, provenance, creation
 *     time and both stored sides SURVIVE: the row records who first filed the
 *     claim and where the edge was placed, and a promotion revises WHAT is
 *     claimed, not who claimed it;
 *   - a stored row of the SAME class whose coverage this write changes (only
 *     `correct` has one) -> the same in-place UPDATE. A coverage change is a
 *     correction of the bit, not a demotion — see
 *     `RELATION_CLASS_SPECIFICITY`;
 *   - a stored row of the same or a HIGHER class, coverage unchanged -> NO-OP.
 *     Nothing is written, nothing is stamped; the caller sees the stored row
 *     in `written` and can tell the two apart through `promoted`.
 *
 * There is NO second row, ever — not for a second class, not for a second lane
 * placement. The post-cutover table's UNIQUE key is the pair (ticket 01), so
 * the schema refuses what this function never attempts; in the deferral window
 * the legacy `(pair, relation, tail, head)` key still stands and this function
 * is the only thing keeping one pair at one row.
 *
 * `written` holds exactly one row per ACCEPTED input, in input order: the row
 * that now satisfies it, whether this call inserted it, promoted it or found
 * it already sufficient. `promoted` is the subset this call actually mutated.
 *
 * Eligibility — whether a relation may attach to a pair at all — is NOT this
 * function's business (ticket 04, see the note above the options type this
 * used to take): every caller answers for it through its own address
 * resolution, phase legality and write gate, and this function writes what it
 * is handed. So is DECLARATION: changing a stored side is `declareEdgeSides`
 * (db/citations.ts), which owns the validation this layer cannot run.
 *
 * A self-loop is rejected here with a reported reason, and again by the
 * table's own CHECK, so no write path (this one, a migration, a hand-written
 * statement) may mint one.
 *
 * An edge whose two ends are not both `turn` is rejected the same way, for the
 * same reason (container-unification D10): the relation graph is turn->turn,
 * and no write path may mint an exception.
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
  const promoted: MemoryEdge[] = [];
  const rejected: WriteEdgesResult["rejected"] = [];

  const insertRelationRow = db.query<
    EdgeRow,
    [CitingNodeKind, number, EdgeNodeKind, number, string, string, string, string, string, number]
  >(
    `
      INSERT INTO memory_edges (
        citing_kind, citing_id, cited_kind, cited_id,
        provenance, tail_tag, head_tag,
        relation_class, relation_coverage, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING ${EDGE_COLUMNS}
    `,
  );

  // main-agent-edges D5: the promotion. Addressed BY ROW ID. The two assigned
  // columns are exactly what a promotion revises; `provenance`,
  // `created_at_epoch` and both side tags are absent from the SET list on
  // purpose, and that absence is the contract.
  const promoteRow = db.query<EdgeRow, [string, string, number]>(
    `UPDATE memory_edges
        SET relation_class = ?, relation_coverage = ?
      WHERE id = ?
      RETURNING ${EDGE_COLUMNS}`,
  );

  // lane-model-v12 ticket 05: the query-index maintenance half of a
  // relation-carrying write, one row per SETTLED side, keyed on the edge's
  // own surrogate id. `OR IGNORE` makes this self-healing on a restatement
  // (the row's id is stable across a promotion above, so its side rows are
  // already there) without a redundant existence check, and an unsettled side
  // inserts nothing at all — `''` is the absence of a lane, not a lane (see
  // MEMORY_EDGE_SIDE_TAGS_DDL, db/schema.ts).
  const insertSideTagIndexRow = db.query<unknown, [number, EdgeSide, string]>(
    `INSERT OR IGNORE INTO memory_edge_side_tags (edge_row_id, side, tag) VALUES (?, ?, ?)`,
  );

  // Deferral-window stock only (main-agent-edges D1): the cutover deletes
  // every wordless row, but until it has run on this database a relation row
  // on the same pair displaces the one it finds — bare and relation rows must
  // never coexist on the pair the way out is through. A no-op after the
  // cutover: the CHECK admits no classless row.
  const dropBarePairRow = db.query<
    unknown,
    [CitingNodeKind, number, EdgeNodeKind, number]
  >(
    `DELETE FROM memory_edges
     WHERE citing_kind = ? AND citing_id = ? AND cited_kind = ? AND cited_id = ?
       AND NOT ${relationClassBearingSql("memory_edges")}`,
  );

  const readPairRows = db.query<
    EdgeRow,
    [CitingNodeKind, number, EdgeNodeKind, number]
  >(
    `SELECT ${EDGE_COLUMNS} FROM memory_edges
     WHERE citing_kind = ? AND citing_id = ? AND cited_kind = ? AND cited_id = ?
     ORDER BY id ASC`,
  );

  for (const edge of edges) {
    if (!isValidCitingNode(edge?.citing) || !isValidCitedNode(edge?.cited)) {
      rejected.push({ input: edge, reason: "invalid-node" });
      continue;
    }
    // EVERY self row. Ticket 05 had narrowed this to the bare case, deferring
    // "may THIS word self-cite" to the caller as a phase question;
    // lane-model-v12 D2 (ticket 04) removes the question — an edge's two ends
    // must be different nodes, full stop, so there is nothing left for a
    // caller to know that this function does not. It refuses IN STEP with the
    // contracted table's own CHECK (`memoryEdgesTableDdl`, db/schema.ts)
    // rather than instead of it: the CHECK is what holds against SQL that
    // never comes through here, and this is what turns that into a named
    // rejection instead of a thrown SQLITE_CONSTRAINT mid-batch.
    if (edge.citing.kind === edge.cited.kind && edge.citing.id === edge.cited.id) {
      rejected.push({ input: edge, reason: "self-loop" });
      continue;
    }
    // The class is the relation (main-agent-edges D1). A caller still handing
    // this function no class — or a class/coverage pairing the vocabulary
    // refuses — has a stale model of what an edge is, and is told so by name
    // rather than by a constraint failure mid-batch.
    const relationCoverage = edge.relationCoverage ?? NO_RELATION_COVERAGE;
    if (
      !isRelationClass(edge.relationClass) ||
      (relationCoverage !== NO_RELATION_COVERAGE && !isRelationCoverage(relationCoverage)) ||
      checkRelationCoverage(edge.relationClass, relationCoverage) !== null
    ) {
      rejected.push({ input: edge, reason: "invalid-relation" });
      continue;
    }
    // container-unification D10: an edge's two ends must both be `turn` — the
    // relation graph is turn→turn, full stop. Same pairing as the self-loop
    // guard above: the table's own CHECK is what holds against SQL that never
    // comes through here, and this is what turns that into a named rejection
    // instead of a thrown SQLITE_CONSTRAINT mid-batch.
    if (edge.citing.kind !== "turn" || edge.cited.kind !== "turn") {
      rejected.push({ input: edge, reason: "relation-requires-turn-pair" });
      continue;
    }
    if (!isEdgeProvenance(edge.provenance)) {
      rejected.push({ input: edge, reason: "invalid-provenance" });
      continue;
    }

    const createdAtEpoch = edge.createdAtEpoch ?? nowEpoch;
    const tailTag = edge.tailTag ?? UNSETTLED_SIDE_TAG;
    const headTag = edge.headTag ?? UNSETTLED_SIDE_TAG;
    const wantsClass = edge.relationClass;

    const stored = selectLogicalEdgeRow(
      readPairRows
        .all(edge.citing.kind, edge.citing.id, edge.cited.kind, edge.cited.id)
        .map(mapEdgeRow),
    );

    if (stored === null) {
      dropBarePairRow.run(
        edge.citing.kind,
        edge.citing.id,
        edge.cited.kind,
        edge.cited.id,
      );
      const row = insertRelationRow.get(
        edge.citing.kind,
        edge.citing.id,
        edge.cited.kind,
        edge.cited.id,
        edge.provenance,
        tailTag,
        headTag,
        wantsClass,
        relationCoverage,
        createdAtEpoch,
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

    // The pair already has its row. D5's three outcomes, decided on the class
    // stored against the class this write asserts. `stored` always carries
    // one — `selectLogicalEdgeRow` admits nothing else.
    const storedClass = edgeRelationClass(stored)!;
    const storedRank = RELATION_CLASS_SPECIFICITY[storedClass.relationClass];
    const wantsRank = RELATION_CLASS_SPECIFICITY[wantsClass];
    const coverageChanges =
      storedClass.relationClass === wantsClass &&
      storedClass.relationCoverage !== relationCoverage;

    if (wantsRank > storedRank || coverageChanges) {
      const row = promoteRow.get(wantsClass, relationCoverage, stored.id);
      if (row) {
        const mapped = mapEdgeRow(row);
        written.push(mapped);
        promoted.push(mapped);
      }
      continue;
    }

    // Weaker, or identical: a NO-OP on the claim, and no stamp is owed for
    // something the row already carries at least as strongly (D5).
    written.push(stored);
  }

  return { written, promoted, rejected };
}

export interface RetractEdgeInput {
  citing: CitingNode;
  cited: EdgeNode;
}

export interface RetractEdgesResult {
  deleted: MemoryEdge[];
  rejected: Array<{ input: RetractEdgeInput; reason: string }>;
}

/**
 * D3, re-addressed by main-agent-edges D4/D5 and the T2432 P1 pin:
 * hard-delete THE LOGICAL EDGE, addressed by the PAIR alone. Both writers have
 * the same power here — a false assertion must not outlive its refutation, and
 * no tombstone is kept: the audit trail for edge history is the existing
 * database dump/backup, not a graveyard row every reader would then have to
 * exclude.
 *
 * WHY THE ADDRESS NARROWED TO THE PAIR. It used to be
 * (pair, relation, tail, head) — the physical row key — which made a
 * retraction's success depend on the caller knowing which of seven storage
 * words a class had landed under and which lanes somebody else had since
 * declared on it. Under one-pair-one-row there is exactly one edge to remove,
 * so the address that names it is the pair; the CLASS precondition a caller
 * may still want ("delete this only if it is still `correct`") is checked one
 * layer up, in `db/citations.ts`'s `retractTurnRelations`, where the class
 * vocabulary lives and where a stale precondition can be refused BY NAME
 * instead of silently matching nothing.
 *
 * Every row of the pair goes, including a pre-cutover wordless row: the pair
 * is the edge, and leaving a fragment of it behind is exactly the "the
 * classification is gone but something still records the pair" state D1
 * retires. Nothing is downgraded to a bare row on the way out — the bare layer
 * has no writer left.
 *
 * `memory_edge_side_tags`' ON DELETE CASCADE (schema.ts) keeps the side index
 * consistent with no code here having to clean it up.
 *
 * `no-such-edge` is reported for an address that resolved but matched nothing
 * — a caller reporting a retraction to a model needs to tell "I removed it"
 * apart from "there was nothing there", which a bare count cannot express.
 */
export function retractMemoryEdges(
  db: Database,
  edges: readonly RetractEdgeInput[],
): RetractEdgesResult {
  const deleted: MemoryEdge[] = [];
  const rejected: RetractEdgesResult["rejected"] = [];

  const del = db.query<EdgeRow, [CitingNodeKind, number, EdgeNodeKind, number]>(
    `DELETE FROM memory_edges
     WHERE citing_kind = ? AND citing_id = ? AND cited_kind = ? AND cited_id = ?
     RETURNING ${EDGE_COLUMNS}`,
  );

  for (const edge of edges) {
    if (!isValidCitingNode(edge?.citing) || !isValidCitedNode(edge?.cited)) {
      rejected.push({ input: edge, reason: "invalid-node" });
      continue;
    }

    const rows = del.all(
      edge.citing.kind,
      edge.citing.id,
      edge.cited.kind,
      edge.cited.id,
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
  /** The stored class — what the renderer prints (via `displayEdgeRelation`), so a writer reads back the vocabulary it was taught. */
  relationClass: RelationClassValue;
  /** relation-vocabulary-v13 ticket 02: `full`/`partial` on a `correct` row, `''` elsewhere. */
  relationCoverage: RelationCoverageValue;
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
  relationClass: RelationClassValue | null;
  relationCoverage: RelationCoverageValue | null;
  tailTag: string;
  headTag: string;
  otherTurnId: number;
  otherSessionId: number;
  otherPromptNumber: number;
}

function mapTurnRelationEdgeRow(row: TurnRelationEdgeRow): TurnRelationEdgeView {
  return {
    relationClass: row.relationClass ?? NO_RELATION_CLASS,
    relationCoverage: row.relationCoverage ?? NO_RELATION_COVERAGE,
    tailTag: row.tailTag ?? UNSETTLED_SIDE_TAG,
    headTag: row.headTag ?? UNSETTLED_SIDE_TAG,
    otherTurnId: row.otherTurnId,
    otherSessionId: row.otherSessionId,
    otherPromptNumber: row.otherPromptNumber,
  };
}

/**
 * Edge-read-surface spec, ticket 01: the `relations` recall field's ONLY data
 * source — BOTH directions of one turn's class-carrying `turn`↔`turn` edges
 * (`relationClassBearingSql`: a deferral-window bare row has no class to
 * render, so it is excluded here the same way it is invisible to every other
 * reader), Law-8 filtered at BOTH ends
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
      `SELECT e.relation_class AS relationClass, e.relation_coverage AS relationCoverage,
              e.tail_tag AS tailTag, e.head_tag AS headTag,
              cited.id AS otherTurnId, cited.session_id AS otherSessionId,
              cited.prompt_number AS otherPromptNumber
         FROM memory_edges e
         JOIN turns citing ON citing.id = e.citing_id
         JOIN turns cited ON cited.id = e.cited_id
        WHERE e.citing_kind = 'turn' AND e.cited_kind = 'turn'
          AND ${relationClassBearingSql("e")}
          AND e.citing_id = ?
          AND ${liveTurnSql("citing")}
          AND ${liveTurnSql("cited")}
        ORDER BY e.cited_id ASC, e.id ASC`,
    )
    .all(turnId)
    .map(mapTurnRelationEdgeRow);

  const inbound = db
    .query<TurnRelationEdgeRow, [number]>(
      `SELECT e.relation_class AS relationClass, e.relation_coverage AS relationCoverage,
              e.tail_tag AS tailTag, e.head_tag AS headTag,
              citing.id AS otherTurnId, citing.session_id AS otherSessionId,
              citing.prompt_number AS otherPromptNumber
         FROM memory_edges e
         JOIN turns citing ON citing.id = e.citing_id
         JOIN turns cited ON cited.id = e.cited_id
        WHERE e.citing_kind = 'turn' AND e.cited_kind = 'turn'
          AND ${relationClassBearingSql("e")}
          AND e.cited_id = ?
          AND ${liveTurnSql("citing")}
          AND ${liveTurnSql("cited")}
        ORDER BY e.citing_id ASC, e.id ASC`,
    )
    .all(turnId)
    .map(mapTurnRelationEdgeRow);

  return { outbound, inbound };
}

/** One `turn`↔`turn` edge, the shape `shared/milestone-election.ts`'s `LaneEdgeInput` wants — the class token as its `relation` label plus both side columns (lane-model-v12 spec D1: `UNSETTLED_SIDE_TAG` on a side means no one has settled it, never a lane named `''`). */
export interface TurnRelationEdgeLite {
  citingId: number;
  citedId: number;
  /** The class TOKEN (`correct(full)`, `verify`, …) — a display label, never a storage word. */
  relation: string;
  tailTag: string;
  headTag: string;
  /** The stored class — what the election scores on. */
  relationClass: RelationClassValue;
  /** `full`/`partial` on a `correct` row. */
  relationCoverage: RelationCoverageValue;
}

/**
 * Every live `turn`↔`turn` edge touching `turnIds` on EITHER end, CLASS-
 * carrying rows only (`relationClassBearingSql` — the one accessor's own SQL
 * form; excludes the frozen-legacy words and the bare, relation-NULL existence
 * row, neither of which resolves to a class), each row's two lane sides
 * carried verbatim.
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
  return db
    .query<
      {
        citingId: number;
        citedId: number;
        tailTag: string;
        headTag: string;
        relationClass: RelationClassValue | null;
        relationCoverage: RelationCoverageValue | null;
      },
      number[]
    >(
      `SELECT me.citing_id AS citingId, me.cited_id AS citedId,
              me.tail_tag AS tailTag, me.head_tag AS headTag,
              me.relation_class AS relationClass, me.relation_coverage AS relationCoverage
       FROM memory_edges me
       JOIN turns tc ON tc.id = me.citing_id
       JOIN turns td ON td.id = me.cited_id
       WHERE (me.citing_id IN (${idPlaceholders}) OR me.cited_id IN (${idPlaceholders}))
         AND me.citing_kind = 'turn' AND me.cited_kind = 'turn'
         AND ${relationClassBearingSql("me")}
         AND ${liveTurnSql("tc")} AND ${liveTurnSql("td")}`,
    )
    .all(...ids, ...ids)
    .map((row) => ({
      citingId: row.citingId,
      citedId: row.citedId,
      relation: displayEdgeRelation({
        relationClass: row.relationClass ?? NO_RELATION_CLASS,
        relationCoverage: row.relationCoverage ?? NO_RELATION_COVERAGE,
      }),
      tailTag: row.tailTag,
      headTag: row.headTag,
      relationClass: row.relationClass ?? NO_RELATION_CLASS,
      relationCoverage: row.relationCoverage ?? NO_RELATION_COVERAGE,
    }));
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
 * main-agent-edges D4: the storage half of a DECLARATION — set one row's two
 * side tags in place and rewrite its side-index rows to match.
 *
 * What it does NOT assign is the contract: `relation`, `relation_class`,
 * `relation_coverage`, `provenance` and `created_at_epoch` are absent from the
 * `SET` list, so a declaration cannot change what the edge claims, who claimed
 * it, or when. The row ID is the address, so nothing about the physical UNIQUE
 * key participates either.
 *
 * The JUDGMENT above it — is this tag one of the endpoint's own lane tags, is
 * the endpoint even ambiguous enough to need a declaration, is the class the
 * caller believed still the class — is `db/citations.ts`'s `declareEdgeSides`,
 * the same "storage writes what it is handed, the layer above decides" split
 * `writeMemoryEdges` already has.
 */
export function updateEdgeSides(
  db: Database,
  edgeRowId: number,
  sides: { tailTag: string; headTag: string },
): MemoryEdge | null {
  const row = db
    .query<EdgeRow, [string, string, number]>(
      `UPDATE memory_edges SET tail_tag = ?, head_tag = ? WHERE id = ?
       RETURNING ${EDGE_COLUMNS}`,
    )
    .get(sides.tailTag, sides.headTag, edgeRowId);
  if (!row) {
    return null;
  }

  // Rewritten rather than diffed: `memory_edge_side_tags` indexes EXPLICIT
  // declarations only (D1), so "delete both sides, re-insert the settled ones"
  // is the whole of it, and an unsettled side correctly leaves no row.
  db.query<unknown, [number]>(
    `DELETE FROM memory_edge_side_tags WHERE edge_row_id = ?`,
  ).run(edgeRowId);
  const insertSideTagIndexRow = db.query<unknown, [number, EdgeSide, string]>(
    `INSERT OR IGNORE INTO memory_edge_side_tags (edge_row_id, side, tag) VALUES (?, ?, ?)`,
  );
  for (const side of EDGE_SIDES) {
    const tag = side === "tail" ? sides.tailTag : sides.headTag;
    if (tag !== UNSETTLED_SIDE_TAG) {
      insertSideTagIndexRow.run(edgeRowId, side, tag);
    }
  }

  return mapEdgeRow(row);
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

// `reconcileCitedPairs` (spec C6's bare layer) is DELETED by main-agent-edges
// D1 / R10-2. It was the wordless population's production line: one bare row
// per `[S<n>/T<m>]` / `[E<n>]` a turn, segment or session body happened to
// name, reconciled on every prose write, for a fact nothing acts on. Its three
// call sites went with it — `recomputeTurnCitedPairs` (db/citations.ts) and
// the segment and session field rescans (db/segments.ts, db/sessions.ts).
//
// WHAT REPLACES IT: nothing, and nothing needs to. The two readers that
// consumed the bare row already union it with the PROSE they were derived
// from — `getEffectiveCitations` / `getSessionEffectiveCitations` parse
// `content` through `parseInlineCitations` and append what the edges did not
// already cover — so the `↳` pull-through and session in-degree read the same
// prose the bare row was a copy of. The one measurable narrowing is that
// prose in `title`/`insight` (which the bare recompute scanned and the inline
// grammar does not) stops contributing; that is the EXPECTED delta, recorded
// here rather than discovered later.

/**
 * De-duplicated in-degree (spec D8): how many DISTINCT nodes cite this one.
 * The DISTINCT is load-bearing only in the deferral window, where a legacy
 * pair may still hold several physical rows and one citer is still one citer;
 * after the cutover the pair is UNIQUE and the two counts coincide.
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
 * Does this database still carry the PRE-CUTOVER edge table (main-agent-edges
 * spec D9)? The probe is the retired `relation` column itself: the cutover's
 * rebuild drops it, and nothing else in this file's history ever did.
 *
 * Read by the settlement claim path (`db/note-settlement.ts`): while D9's
 * fence defers the migration, the NEW worker refuses to claim settlement work,
 * which is what makes the live claim set drain and the window finite.
 */
export function memoryEdgesPredatesCutover(db: Database): boolean {
  return (
    db
      .query<{ name: string }, []>(`SELECT name FROM pragma_table_info('memory_edges')`)
      .all()
      .some((column) => column.name === "relation")
  );
}

export function countMemoryEdges(db: Database): number {
  return (
    db
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM memory_edges")
      .get()?.count ?? 0
  );
}
