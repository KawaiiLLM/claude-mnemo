import { MEMORY_TYPES, type MemoryType } from "./type-vocabulary";

/**
 * Turn phases and the edge-relation vocabulary they license (flow-relations
 * spec, `.scratch/flow-relations/spec.md`; ticket 02). Importance is not
 * assigned here — this module only says which relations a turn's `type` list
 * licenses, through exactly three phases:
 *
 *   evidence (research/measure)              -> a fact
 *   decision (design/discuss/correction)      -> a decision
 *   delivery (implement/refactor/fix/         -> a work product carrying a
 *             delegate/review/ops)               decision (spec/ADR/ticket/
 *                                                 commit/release included —
 *                                                 anything that "carries a
 *                                                 decision-bearing artifact"
 *                                                 counts as delivery, ticket
 *                                                 splitting included).
 *
 * One shared module (this file), not duplicated per consumer, so every reader
 * of a turn's phase or a relation's legality derives it from the SAME table.
 *
 * Direction convention ([S15069/T930]): an edge is recorded from the CITING
 * (later) turn to its CITED predecessor — `memory_edges.citing_id` is always
 * the turn being written now, `cited_id` the turn it points at.
 *
 * ## The eight-word vocabulary (flow-relations spec, "六行律")
 *
 * ADR-0010's nine-cell grammar (phase as the only axis) is retired: relations
 * live on two orthogonal axes, PHASE and LAYER (aggregation: decision flow ->
 * ticket -> release), and the nine-cell table had no home for cross-layer-
 * same-phase relations (release -> commit) and welded a cross-layer word
 * (`encodes`) onto a cross-phase cell by coincidence. The six-row law that
 * replaces it, machine-checkable per relation:
 *
 *   override           same phase; flow- and layer-unlimited
 *   narrows / extends   both ends decision-phase; same flow (definitional —
 *                       the edge itself is what BUILDS the flow, so there is
 *                       nothing separate to check at write time)
 *   indexes             same phase; SAME-PHASE AGGREGATION — this node
 *                       gathers and represents these same-phase nodes
 *                       carrying its effective content, readers reach them
 *                       through it. Renamed from `collects`, whose one
 *                       graph-state hard check (own-branch terminus/
 *                       membership) RETIRES (indexes-rescope spec law 2,
 *                       [S15069/T1232]) — `indexes` carries no graph-state
 *                       gate of its own; the self-`grounds` settlement+
 *                       implementer condition below is the vocabulary's
 *                       ONE remaining graph-state rejection
 *   consume             same phase; cross-flow (descriptive, never a
 *                       write-time graph-fact check)
 *   grounds              cross-phase ONLY — some (source, target) pairing
 *                       with source ≠ target (user retightening
 *                       [S15069/T1209]; within a phase, dependency is
 *                       continuation or usage — the stance words and
 *                       `consume` own it. The self case is cross-phase by
 *                       construction: settlement + implementer entails both
 *                       a decision and a delivery half)
 *   verifies / refutes  source must carry an evidence phase; target must
 *                       carry a decision or delivery phase — never evidence
 *                       (user ruling [S15069/T1215]: evidence's object is
 *                       the WORLD, not another turn's claim — a re-measure
 *                       that agrees is just the same fact measured twice, a
 *                       re-measure that disagrees is `override`. Every
 *                       cross-phase word is now strictly cross-phase, every
 *                       same-phase word strictly same-phase)
 *
 * Splits and merges vs the retired seven-word set: `refines` -> `extends` +
 * `narrows`; `depends-on` -> `consume` + `indexes` (born `collects`; renamed
 * and widened to same-phase aggregation by the indexes-rescope amendment,
 * [S15069/T1231]); `encodes` merges into `grounds` alongside `grounded-on`;
 * `evidence-for`/`evidence-against` rename to `verifies`/`refutes`;
 * `override` survives with its flow/layer limit REMOVED. `supersedes` stays
 * frozen-readable storage only (`db/citations.ts`'s `CITATION_RELATIONS`),
 * never a member of this module's write vocabulary.
 *
 * ## Self-citation (rubric-v10 ticket 02; round-4 review #1 hardened Gate C)
 *
 * The old phase-spanning self rule (a multi-phase turn could self-cite with
 * any CROSS-PHASE word) retires with the vocabulary it was built for. Exactly
 * one relation may ever cite the citing turn itself: `grounds`. Legality
 * rests on TWO conditions — the old flow-derived "settlement + implementer"
 * reading survives as a composite-node requirement even though the lane
 * model retires the flow DERIVATION itself:
 *
 *   - the IMPLEMENTER half, checked HERE (structural, pre-write): the citing
 *     turn's own phase set must include `delivery` — a decision-only turn
 *     can never self-ground. This needs nothing the write has not already
 *     told this module (`citingPhases` is a pre-write fact), so it is part
 *     of `validateRelationTarget`'s ordinary verdict, not deferred.
 *   - the SETTLEMENT half, checked AFTER the write lands (Gate C, graph-
 *     state): the citing turn must be the CURRENT terminus of a lane it
 *     declared via a TAGGED `indexes` edge of its own (declared in this same
 *     call, in either order relative to the `grounds` field, or already
 *     stored from an earlier call) — a LATER tagged override (that lane
 *     reopens) or untagged override (that turn's conclusion is repudiated
 *     globally) unseats a stale declaration, and a self-`grounds` resting on
 *     one is refused. This half needs the post-transaction graph (and the
 *     lane's full event history to detect a later override), which this
 *     DB-free module cannot read — it is `checkSelfGroundsTerminus` below, a
 *     SEPARATE function callers invoke only after their write has landed,
 *     fed evidence THEY compute (typically via `shared/lane-interpretation.ts`'s
 *     `deriveLaneInterpretation`) rather than derived here.
 *
 * `validateRelationTarget` therefore treats a self-`grounds` as PHASE-PAIR
 * legal unconditionally (the ordinary same/cross-phase pairing does not
 * apply to a self target anyway) but still enforces the implementer half
 * inline; the terminus half stays Gate C, post-transaction only.
 *
 * Every other relation refuses a self target outright, whatever the phase.
 *
 * ## Lane tags (lane-declaration spec D2, rubric v11's 八词 section)
 *
 * ALL EIGHT words may carry a lane-tag set, and NONE requires one. A lane is
 * not a phase-local concept: a tagged `grounds`/`verifies`/`refutes` is how a
 * lane continues across a phase boundary, which is what makes a
 * design→delivery line ONE lane instead of two hinged halves ([S15069/T1562]).
 * One edge may carry SEVERAL tags — the lanes converge there — and each tag
 * is judged independently.
 *
 * Per tag, in this order, each refusal naming the specific gap:
 *
 *   1. CANONICAL FORM. A lane tag is stored only as NFC, trimmed, lowercase,
 *      non-empty, no interior whitespace (`db/lanes.ts`'s
 *      `checkCanonicalLaneTag`, which `remember(declare)` refuses against
 *      rather than normalizing). Checked first because a non-canonical value
 *      can never have been declared, so reporting "not declared" for it would
 *      send the writer to declare a tag `declare` itself refuses.
 *   2. DECLARED IN EVERY ENDPOINT'S SEGMENT. A lane's identity is
 *      `(segment, ONE tag)` and it must be declared BEFORE it is used, so a
 *      tagged edge may name only a lane declared in the segment of EVERY
 *      endpoint turn. A HOMELESS endpoint (a turn in no segment) is never
 *      legal — the refusal says which turn. A CROSS-SEGMENT edge is legal
 *      exactly when both segments declared the tag; the refusal names the
 *      segment missing it.
 *   3. THE SUBSET INVARIANT (unchanged, rubric-v10 ticket 02's Gate B): every
 *      tag on the edge already exists on BOTH endpoint turns' own stored
 *      `tags` — violation names which tag and which endpoint is missing it.
 *
 * Then two structural refusals that are not per-tag:
 *
 *   - A SELF edge (citing === cited) may not carry a tag AT ALL. A tag names
 *     a lane and a lane has at least two nodes, so a one-node self-loop is
 *     not one; a tagged self-`grounds` would otherwise enter the lane's DAG
 *     as a self-loop the shape report reads as 0 sources / 0 sinks and passes
 *     in silence.
 *   - TWO ROWS FOR THE SAME (pair, relation) WHOSE TAG SETS INTERSECT. Row
 *     identity is (pair, relation, EXACT tag set), so `extends{a}` and
 *     `extends{a,b}` both persist and lane `a` then reads the same logical
 *     edge twice — double-counting edge totals, milestone in-degree and
 *     console edges. The way to widen an edge's lanes is retract-and-rewrite
 *     with the UNION, which the refusal says.
 *
 * This module reads no database. Checks 1, 2 and the intersection test are
 * all GRAPH/REGISTRY facts, so they arrive as `laneRegistry` — evidence the
 * CALLER computes (`db/lane-edge-gate.ts`'s `collectLaneRegistryFacts`) and
 * this module only judges, the same contract `citingPhases`/`citedPhases`/
 * `citingTurnTags` already have, and the same shape Gate C's
 * `checkSelfGroundsTerminus` uses for its own post-write graph fact. Ordering
 * them here rather than in the adapter is what keeps ONE order for BOTH write
 * paths: a caller running its registry checks around this function would put
 * the subset invariant in a different place than its peer.
 *
 * ## The tag mandate is WITHDRAWN ([S15069/T1548], lane-declaration D2)
 *
 * `extends`/`narrows` used to have no untagged form: continuation was held to
 * name its lane, so the two words whose semantics IS continuation were
 * required to carry a tag. Measured live, that mandate is what MINTED the
 * lanes it was meant to name — 72 lanes over 380 tagged edges, 30 of them
 * two-member and 14 literally one edge, because every related pair had to
 * invent a tag at the moment of its first edge. Lane membership is a
 * hindsight judgment, so ownership moved to settlement instead: the main
 * agent MAY carry lane tags and is never required to, settlement declares and
 * tags, and the checker replaces the refusal with pressure (an unattributed
 * cluster, a proliferating segment — warnings, never refusals).
 *
 * Nothing here is word-level any more: every one of the eight words has a
 * legal bare form and a legal tagged form, and `TAGGABLE_RELATIONS` below is
 * the whole word-level story.
 */

export const TURN_PHASES = ["evidence", "decision", "delivery"] as const;
export type TurnPhase = (typeof TURN_PHASES)[number];

/** `type` word -> the one phase it belongs to (spec's three-row table). */
export const TYPE_PHASE: Record<MemoryType, TurnPhase> = {
  research: "evidence",
  measure: "evidence",
  design: "decision",
  discuss: "decision",
  correction: "decision",
  implement: "delivery",
  refactor: "delivery",
  fix: "delivery",
  delegate: "delivery",
  review: "delivery",
  ops: "delivery",
};

/** The word a rejection message points a caller at to reach a given phase — the table's own first-listed word for that row. */
export const PHASE_CANONICAL_TYPE: Record<TurnPhase, MemoryType> = {
  evidence: "research",
  decision: "design",
  delivery: "implement",
};

/**
 * A turn's phase SET (not a single phase): a turn can carry multiple `type`
 * words, and legality is exists-based — a relation is legal iff SOME (source
 * phase, target phase) pair it admits matches the turn's own phase set, not
 * that every type word does. An unrecognised or legacy `type` word (nothing
 * in `MEMORY_TYPES`) contributes no phase, the same "unmapped input
 * strengthens nothing" rule `parseMemberFacetArray` (db/segments.ts) already
 * applies to a member's facet arrays.
 */
export function phasesForTypes(types: readonly string[]): Set<TurnPhase> {
  const phases = new Set<TurnPhase>();
  for (const raw of types) {
    const phase = TYPE_PHASE[raw as MemoryType];
    if (phase !== undefined) {
      phases.add(phase);
    }
  }
  return phases;
}

/**
 * The EIGHT-word closed set a NEW write may legally carry (flow-relations
 * spec's six-row law). `supersedes` is deliberately not a member — frozen
 * legacy, `db/citations.ts`'s `CITATION_RELATIONS` is where it survives as a
 * storage-level, read-only value.
 */
export const EDGE_RELATIONS = [
  "override",
  "narrows",
  "extends",
  "indexes",
  "consume",
  "grounds",
  "verifies",
  "refutes",
] as const;
export type TurnEdgeRelation = (typeof EDGE_RELATIONS)[number];

export function isTurnEdgeRelation(value: unknown): value is TurnEdgeRelation {
  return typeof value === "string" && (EDGE_RELATIONS as readonly string[]).includes(value);
}

export interface RelationPhasePair {
  source: TurnPhase;
  target: TurnPhase;
}

/**
 * `override`/`narrows`/`extends`/`indexes`/`consume`: legal in every SAME-phase
 * pair — evidence-evidence, decision-decision, delivery-delivery alike.
 *
 * rubric-v10 ticket 02 (spec "Vocabulary and validator"): `narrows`/`extends`
 * WIDEN into this group from their old decision-only cage — that cage was
 * built for the flow model's branch derivation (narrows/extends "bind to one
 * flow" definitionally), and the lane model retires flow identification from
 * the write path entirely (lanes are tag-derived, `checker`-side, ticket 05).
 * With no flow left to define, the narrower pair had nothing left protecting
 * it — same-phase is now the whole domain test for all five.
 *
 * This list is a PHASE domain and nothing else. It used to double as
 * `TAGGABLE_RELATIONS` below; lane-declaration D2 severed that link, because
 * a lane stopped being a phase-local concept.
 */
const SAME_PHASE_RELATIONS: readonly TurnEdgeRelation[] = [
  "override",
  "narrows",
  "extends",
  "indexes",
  "consume",
];

/**
 * The words a lane tag may attach to: ALL EIGHT ([S15069/T1562], rubric v11's
 * "八词（非自引边均可带 tag）"). Derived from `EDGE_RELATIONS` rather than
 * listed, so the set cannot drift from the vocabulary it is defined as.
 *
 * It used to be the five SAME-PHASE words, on the reasoning that a lane is
 * phase-local and a cross-phase tag would assert membership across a boundary
 * the model did not define. The field study that tested that reasoning is why
 * it is gone: 46%/53% of already-legal edges joined turns whose phase SETS
 * differ, so "same phase" was never rigid; and of 29 cross-phase references
 * only 13 broke a line, 12 of those from dispatch/acceptance/release turns
 * with no single sub-task identity anyway. A tagged cross-phase word is now
 * the ORDINARY way a design line continues into the delivery that ships it —
 * `实现 —consume{rubric-design}→ spec —grounds{rubric-design}→ 设计终点` is
 * one lane, not two hinged halves.
 *
 * With every word taggable this set is total, so there is no word-level tag
 * refusal left and no `isTaggableRelation` predicate to ask one: the surviving
 * tag refusals are all STRUCTURAL (a self edge, an undeclared lane, a
 * non-canonical tag, an intersecting stored row) and live in
 * `checkTagLegality` below. The name stays because it is the vocabulary
 * statement a reader greps for, and because a NINTH word admitted tomorrow
 * inherits taggability here by construction rather than by a second edit.
 *
 * NO WORD REQUIRES A TAG. The mandate that once forced one on
 * `extends`/`narrows` is withdrawn — see this module's header for the measured
 * reason — so there is no `TAG_MANDATORY_RELATIONS` counterpart to this set.
 */
export const TAGGABLE_RELATIONS: ReadonlySet<TurnEdgeRelation> = new Set(EDGE_RELATIONS);

/**
 * The two relations that build a decision BRANCH — `narrows`/`extends`.
 * Relocated here (rubric-v10 ticket 04) from the retired `shared/flows.ts`
 * (the decision-flow derivation, whose read-side callers all retire with
 * this ticket): this module is the vocabulary's one stated home (see
 * `flows.ts`'s own former header note, "this module therefore does NOT
 * re-declare the relation vocabulary, whose one home is the write path"),
 * so a constant naming a subset of that vocabulary belongs here rather than
 * in a new file. The one surviving reader is `shared/lane-checker.ts`
 * (ticket 05's checker), which needs the same two words for its own
 * component/path reports — unrelated to flow derivation, which no longer
 * exists anywhere in the tree.
 */
export const STANCE_RELATIONS: ReadonlySet<TurnEdgeRelation> = new Set(["narrows", "extends"]);

/** `verifies`/`refutes`: the SOURCE must be evidence-phase; the target decision- or delivery-phase — never evidence ([S15069/T1215]). */
const EVIDENCE_SOURCE_RELATIONS: readonly TurnEdgeRelation[] = ["verifies", "refutes"];

/**
 * `grounds`: every CROSS-phase pair (source ≠ target) — six pairs, generated
 * below like every other row. Retightened from "no restriction" by user
 * ruling [S15069/T1209]: within a phase, dependency reads as continuation or
 * usage (stance words / `consume`), so cross-kind footing is what `grounds`
 * alone asserts. A turn with an EMPTY phase set (untyped or legacy-typed)
 * admits no pair and is rejected — grounds regained a rejection channel,
 * dissolving the "never refused, warning is its only feedback" ledger note.
 */
function buildRelationPhaseRequirement(): Record<TurnEdgeRelation, RelationPhasePair[]> {
  const table = Object.fromEntries(
    EDGE_RELATIONS.map((relation) => [relation, [] as RelationPhasePair[]]),
  ) as Record<TurnEdgeRelation, RelationPhasePair[]>;

  for (const phase of TURN_PHASES) {
    for (const relation of SAME_PHASE_RELATIONS) {
      table[relation].push({ source: phase, target: phase });
    }
  }
  for (const source of TURN_PHASES) {
    for (const target of TURN_PHASES) {
      if (source !== target) {
        table.grounds.push({ source, target });
      }
    }
  }
  for (const relation of EVIDENCE_SOURCE_RELATIONS) {
    // T1215: the verdict pair is strictly cross-phase — evidence never
    // renders a verdict on evidence (its object is the world, not another
    // turn's claim; agreement = the same fact twice, disagreement = override).
    for (const phase of TURN_PHASES) {
      if (phase === "evidence") {
        continue;
      }
      table[relation].push({ source: "evidence", target: phase });
    }
  }
  return table;
}

export const RELATION_PHASE_REQUIREMENT: Record<
  TurnEdgeRelation,
  readonly RelationPhasePair[]
> = buildRelationPhaseRequirement();

/**
 * A relation is legal iff SOME (source phase, target phase) pair it admits
 * has its source in the citing turn's phase set and its target in the cited
 * turn's phase set — the exists-rule a multi-type turn gets for free.
 * `grounds` reads the same table as everyone else since [S15069/T1209]
 * (cross-phase pairs only — its old always-legal short-circuit is gone).
 */
export function isRelationLegalForPhases(
  relation: TurnEdgeRelation,
  citingPhases: ReadonlySet<TurnPhase>,
  citedPhases: ReadonlySet<TurnPhase>,
): boolean {
  return RELATION_PHASE_REQUIREMENT[relation].some(
    (pair) => citingPhases.has(pair.source) && citedPhases.has(pair.target),
  );
}

function phaseRequirementClause(
  side: "citing" | "cited" | "self",
  phases: readonly TurnPhase[],
): string {
  const options = phases.map(
    (phase) => `a ${phase}-phase type (e.g. \`${PHASE_CANONICAL_TYPE[phase]}\`)`,
  );
  const subject = side === "self" ? "this turn's own type list" : `the ${side} turn`;
  return `${subject} to carry ${options.join(" or ")}`;
}

/**
 * The rejection detail naming which HALF is missing (worked example: "verifies
 * needs the citing turn to carry an evidence-phase type, add research").
 * Since [S15069/T1209] `grounds` reaches here too: a same-phase grounds
 * reports the cited side's missing cross phases, and an untyped citing turn
 * reports its own.
 *
 * Reports the CITING side first: if no listed pair's source phase is present
 * at all, that is reported (the writer's own type is the more direct lever);
 * otherwise every pair whose source DID match contributes its target phase to
 * a combined "cited turn needs X or Y" clause.
 */
export function explainRelationPhaseRejection(
  relation: TurnEdgeRelation,
  citingPhases: ReadonlySet<TurnPhase>,
  citedPhases: ReadonlySet<TurnPhase>,
): string {
  const pairs = RELATION_PHASE_REQUIREMENT[relation];
  const sourceSatisfiedPairs = pairs.filter((pair) => citingPhases.has(pair.source));
  if (sourceSatisfiedPairs.length === 0) {
    const sourcePhases = [...new Set(pairs.map((pair) => pair.source))];
    return `needs ${phaseRequirementClause("citing", sourcePhases)}`;
  }
  const targetPhases = [...new Set(sourceSatisfiedPairs.map((pair) => pair.target))];
  return `needs ${phaseRequirementClause("cited", targetPhases)}`;
}

const SELF_NOT_GROUNDS_DETAIL =
  "is this turn's own address, and only `grounds` may ever cite the citing turn itself — " +
  "every other relation compares two DIFFERENT turns, so citing itself with one of them is a tautology, not a claim";

/** round-4 review #1: the implementer-half rejection — checked inline, pre-write, since it needs only the citing turn's own already-known phase set. */
const SELF_NOT_DELIVERY_DETAIL =
  "is this turn's own address; a self-`grounds` additionally needs this turn's own type to carry a " +
  "delivery-phase word (e.g. `implement`) — the implementer half of settlement+implementer; a " +
  "decision-only turn cannot self-ground";

/**
 * rubric-v10 ticket 02 (Gate C, post-transaction): the detail both
 * `checkSelfGroundsTerminus` below (a rejection AFTER the write) and a
 * caller's own pre-write message (if it chooses to explain the requirement
 * before attempting the write) can share verbatim.
 */
export const SELF_GROUNDS_NO_TERMINUS_DETAIL =
  "is this turn's own address; a self-`grounds` is legal only when, after every edge this call " +
  "writes has landed, this turn is CURRENTLY the terminus of a lane it declared via a TAGGED " +
  "`indexes` edge of its own — declared in this same call (either order relative to grounds) or " +
  "already stored from an earlier one, and NOT since reopened (a later tagged override) or " +
  "repudiated (a later untagged override)";

/**
 * The SELF-edge tag refusal (lane-declaration ticket 02, peer finding P1-3).
 *
 * RED LINE (the write-gate-hardening precedent, `shared/tool-call-syntax.ts`),
 * inherited from the retired mandate's own detail string: none of the tag
 * details below ever reproduces angle-bracket markup. They return straight
 * into the caller's own context, where any quoted call syntax becomes one more
 * exemplar for the attractor that produces malformed calls — so an entry form
 * is described in prose and by its field names, never shown as markup.
 * `containsToolCallSyntax` over every one of them must be false, pinned by
 * test.
 */
const TAG_ON_SELF_EDGE_DETAIL =
  "is this turn's own address AND carries a lane tag; a self edge never carries one — a tag names " +
  "a lane, a lane has at least two nodes, and a one-node self-loop is not a lane. Send the " +
  "self-`grounds` as a bare address instead. (Left tagged it would enter the lane's own graph as a " +
  "self-loop the shape report reads as no start and no end, and pass in silence.)";

/**
 * Check 1 (lane-declaration D2): a tag not in canonical form. The registry's
 * OWN message is quoted verbatim (`db/lanes.ts`'s `checkCanonicalLaneTag`
 * builds it, and `remember(declare)` refuses against the same one) so the
 * writer reads the identical sentence whichever surface it hits first — and
 * so this DB-free module never has to own a second copy of the canonical rule.
 */
function laneTagNotCanonicalDetail(
  entries: readonly { tag: string; message: string }[],
): string {
  return (
    "carries a lane tag that is not in canonical form, so no segment could have declared it — " +
    entries.map((entry) => entry.message).join(" ")
  );
}

/** One endpoint's registry standing, as `laneNotDeclaredDetail` words it. */
type LaneEndpointSide = "citing" | "cited";

/**
 * Check 2 (lane-declaration D2): a tag whose lane is not declared where it is
 * used. Two message shapes because the two gaps take different repairs — a
 * HOMELESS endpoint has no segment to declare in (assign it first), while a
 * declared-on-one-side-only cross-segment edge names the segment that is
 * missing the declaration. Both name the TURN, so "which endpoint" is never
 * left to inference.
 */
function laneNotDeclaredDetail(
  entries: readonly {
    tag: string;
    endpoint: LaneEndpointSide;
    address: string;
    segment: string | null;
  }[],
): string {
  const clauses = entries.map((entry) =>
    entry.segment === null
      ? `the ${entry.endpoint} turn ${entry.address} belongs to NO segment, so lane "${entry.tag}" has nowhere to be declared — assign that turn to a segment first`
      : `${entry.segment}, the segment owning the ${entry.endpoint} turn ${entry.address}, has not declared lane "${entry.tag}" — declare it there first`,
  );
  return (
    "names a lane that is not declared at every endpoint; a lane is declared before it is used, " +
    "and a tagged edge names one in the segment of BOTH endpoint turns (a cross-segment edge is " +
    `legal exactly when both segments declared the tag): ${clauses.join("; ")}`
  );
}

/**
 * The intersecting-stored-row refusal (peer finding P1-4). Row identity is
 * (pair, relation, EXACT tag set), so `extends{a}` and `extends{a,b}` both
 * persist and lane `a` reads the same logical edge TWICE — double-counting
 * that lane's edge total, its members' milestone in-degree and the console's
 * edge counts. The refusal names the stored set, the overlap, and the one
 * legal way to widen an edge's lanes.
 */
function laneTagsIntersectDetail(
  tags: readonly string[],
  relation: string,
  rows: readonly { tags: readonly string[]; shared: readonly string[] }[],
): string {
  const clauses = rows.map(
    (row) => `a \`${relation}\` row tagged {${row.tags.join(",")}} (shared: ${row.shared.map((tag) => `"${tag}"`).join(", ")})`,
  );
  return (
    `carries lane tags {${tags.join(",")}} while this same pair already stores ${clauses.join("; ")} — ` +
    "each shared tag's lane would read the same edge twice. Widen an existing edge's lanes by " +
    "RETRACTING that row and re-writing it once with the UNION of both sets, never by adding a " +
    "second overlapping row"
  );
}

/**
 * rubric-v10 ticket 02 (Gate B): builds the "tag X missing from the Y turn's
 * tags" clause, one entry per (tag, endpoint) that fails the subset
 * invariant — both endpoints are checked for every tag, so a tag missing
 * from both is named twice, once per endpoint, rather than only the first
 * failure found (a caller fixing one endpoint and re-submitting should not
 * discover the second gap only on a second rejection).
 */
function tagMissingDetail(missing: readonly { tag: string; endpoint: "citing" | "cited" }[]): string {
  const clauses = missing.map(
    (entry) => `"${entry.tag}" is missing from the ${entry.endpoint} turn's tags`,
  );
  return `carries a tag that fails the subset invariant — ${clauses.join("; ")}`;
}

/**
 * A relation target's node kind, as `db/references.ts`'s address parser
 * already distinguishes it — re-declared here rather than imported so this
 * module stays free of any DB-layer dependency.
 */
export type RelationTargetKind = "turn" | "segment";

/**
 * One endpoint turn's REGISTRY standing, as the caller reads it out of the
 * database (`db/lane-edge-gate.ts`'s `collectLaneRegistryFacts`) — this module
 * judges it and never fetches it.
 */
export interface LaneEndpointRegistryFact {
  /** The endpoint's own `S<session>/T<prompt>` address, so a refusal can say WHICH turn. */
  address: string;
  /** `E<n>` of the segment that owns this endpoint, or `null` when the turn belongs to no segment (homeless). */
  segment: string | null;
  /** The tags that segment has DECLARED as lanes. Empty for a homeless endpoint, which has no segment to declare in. */
  declaredTags: ReadonlySet<string>;
}

/**
 * lane-declaration D2: the registry/graph evidence the per-tag checks need,
 * pre-computed by the caller for the same reason `citingPhases` and
 * `citingTurnTags` are — this module reads no database. Absent means the
 * caller supplied no evidence, and checks 1/2 and the intersection test yield
 * NO verdict (the "never fabricate a verdict" posture the checker's own
 * `tags: undefined` case takes); the subset invariant still runs. Both live
 * write paths — `mcp/note.ts` and `worker/note-settlement-turn-facade.ts` —
 * always supply it, which is what makes the gate uniform across writers.
 */
export interface LaneRegistryFacts {
  citing: LaneEndpointRegistryFact;
  /** For a SELF edge both sides are the same turn; the tag refusal fires before this is read. */
  cited: LaneEndpointRegistryFact;
  /** Tag -> the registry's own canonical-form message, for each tag of THIS write that is not canonical. */
  nonCanonical: ReadonlyMap<string, string>;
  /**
   * Stored rows for the SAME (pair, relation) whose tag set INTERSECTS this
   * write's set without being IDENTICAL to it — an identical set is an
   * idempotent restatement of the very row being written and stays legal.
   */
  intersectingRows: readonly { tags: readonly string[]; shared: readonly string[] }[];
}

export interface RelationTargetValidationInput {
  relation: TurnEdgeRelation;
  citingPhases: ReadonlySet<TurnPhase>;
  targetKind: RelationTargetKind;
  /** Ignored when `targetKind` is `"segment"`, or when `isSelfReference` is true. */
  citedPhases: ReadonlySet<TurnPhase>;
  /**
   * True when the resolved target IS the citing turn. Only `grounds` may ever
   * legally self-cite (see this module's header) — every other relation is
   * refused outright, whatever the phase. A self-`grounds` is admitted here
   * on the PHASE side unconditionally (Gate C, the terminus-declaration
   * requirement, is a SEPARATE post-transaction check —
   * `checkSelfGroundsTerminus` below), but a self edge carrying any lane tag
   * is refused: see `TAG_ON_SELF_EDGE_DETAIL`.
   */
  isSelfReference?: boolean;
  /**
   * This edge's own lane-tag set, already canonicalized by the caller (sorted,
   * deduped — `db/memory-edges.ts`'s `canonicalizeTagSet`). Omitted or empty
   * means untagged, which is legal for ALL EIGHT words: no word requires a tag
   * ([S15069/T1548] — see this module's header for the mandate's withdrawal),
   * and there is nothing to check when there is no tag to check.
   */
  tags?: readonly string[];
  /** Gate B: the citing turn's own stored `tags`, canonicalized. Required only when `tags` is non-empty. */
  citingTurnTags?: ReadonlySet<string>;
  /** Gate B: the cited turn's own stored `tags`, canonicalized. Ignored for a segment target or a self-reference (both endpoints are the same turn there). */
  citedTurnTags?: ReadonlySet<string>;
  /** lane-declaration D2: the registry evidence checks 1/2 and the intersection test are judged against. See `LaneRegistryFacts`. */
  laneRegistry?: LaneRegistryFacts;
}

export type RelationTargetRejectionReason =
  | "segment-target"
  | "phase-illegal"
  | "self-not-grounds"
  /** round-4 review #1: a self-`grounds` whose citing turn carries no delivery-phase type — the implementer half of the composite-node requirement, checked pre-write. */
  | "self-not-delivery"
  /** lane-declaration D2: a SELF edge carrying any lane tag — a one-node self-loop is not a lane. */
  | "tag-on-self-edge"
  /** lane-declaration D2, check 1: a tag not in the registry's canonical form, so no segment could have declared it. */
  | "lane-tag-not-canonical"
  /** lane-declaration D2, check 2: a tag whose lane is not declared in some endpoint's segment (a homeless endpoint included). */
  | "lane-not-declared"
  | "tag-missing"
  /** lane-declaration D2 (peer P1-4): a second row for the same (pair, relation) whose tag set intersects a stored one. */
  | "lane-tags-intersect"
  /** rubric-v10 ticket 02 (Gate C): only `checkSelfGroundsTerminus` ever returns this — a self-`grounds` with no CURRENT tagged-indexes terminus in the post-transaction graph. */
  | "self-not-terminus";

export type RelationTargetValidationResult =
  | { ok: true }
  | { ok: false; reason: RelationTargetRejectionReason; detail: string };

const SEGMENT_TARGET_DETAIL =
  "is a segment address — relation targets are turn-only; a segment tie goes through " +
  "ownership (e.g. remember's assign/attach) or a bare cites reference, never a relation";

/**
 * The tag-legality half of `validateRelationTarget`, factored out because it
 * runs identically whether the phase side took the self-reference branch or
 * the ordinary phase-pair branch.
 *
 * The UNTAGGED case is uniformly legal again ([S15069/T1548]): no word
 * requires a tag, so an empty set short-circuits every check below. The
 * WORD-level case is gone with it — all eight words are taggable, so what
 * remains is structural, in the order this module's header states: a self
 * edge, then per tag canonical form, then per tag declaration, then the
 * subset invariant, then the intersecting-stored-row test.
 *
 * The order is here rather than at the two call sites deliberately. Each
 * write path would otherwise sequence its own registry reads around this
 * function and the two would drift — which is the same "NO CARVE-OUTS BY
 * WRITER" property the retired mandate's own doc comment claimed and the one
 * part of it worth keeping.
 */
function checkTagLegality(input: RelationTargetValidationInput): RelationTargetValidationResult {
  const tags = input.tags ?? [];
  if (tags.length === 0) {
    return { ok: true };
  }
  if (input.isSelfReference) {
    return { ok: false, reason: "tag-on-self-edge", detail: TAG_ON_SELF_EDGE_DETAIL };
  }
  const registry = input.laneRegistry;
  if (registry) {
    const nonCanonical = tags
      .filter((tag) => registry.nonCanonical.has(tag))
      .map((tag) => ({ tag, message: registry.nonCanonical.get(tag)! }));
    if (nonCanonical.length > 0) {
      return {
        ok: false,
        reason: "lane-tag-not-canonical",
        detail: laneTagNotCanonicalDetail(nonCanonical),
      };
    }
    // Both endpoints, every tag — the same "name every gap, not the first
    // one found" rule `tagMissingDetail` follows, so a writer repairing one
    // side does not discover the other only on a retry.
    const undeclared: {
      tag: string;
      endpoint: LaneEndpointSide;
      address: string;
      segment: string | null;
    }[] = [];
    for (const tag of tags) {
      for (const endpoint of ["citing", "cited"] as const) {
        const fact = registry[endpoint];
        if (fact.segment === null || !fact.declaredTags.has(tag)) {
          undeclared.push({ tag, endpoint, address: fact.address, segment: fact.segment });
        }
      }
    }
    if (undeclared.length > 0) {
      return { ok: false, reason: "lane-not-declared", detail: laneNotDeclaredDetail(undeclared) };
    }
  }
  const citingTags = input.citingTurnTags ?? new Set<string>();
  const citedTags = input.citedTurnTags ?? new Set<string>();
  const missing: { tag: string; endpoint: "citing" | "cited" }[] = [];
  for (const tag of tags) {
    if (!citingTags.has(tag)) {
      missing.push({ tag, endpoint: "citing" });
    }
    if (!citedTags.has(tag)) {
      missing.push({ tag, endpoint: "cited" });
    }
  }
  if (missing.length > 0) {
    return { ok: false, reason: "tag-missing", detail: tagMissingDetail(missing) };
  }
  if (registry && registry.intersectingRows.length > 0) {
    return {
      ok: false,
      reason: "lane-tags-intersect",
      detail: laneTagsIntersectDetail(tags, input.relation, registry.intersectingRows),
    };
  }
  return { ok: true };
}

/**
 * THE shared judgment: every caller that may attach a relation asks this ONE
 * function "is this relation legal here", rather than each re-implementing
 * the segment-target refusal, the phase-pair check, and the self-citation
 * gate against its own copy of the rules.
 *
 * `detail` never carries a leading relation/address label or a trailing
 * period — callers compose those around it however their own message format
 * wants.
 *
 * Three gates in order, each short-circuiting the next: segment-target,
 * then phase legality (self-reference short-circuits this to always-legal —
 * a self target for anything but `grounds` is refused on sight, whatever the
 * phase; self-`grounds`' actual terminus condition is Gate C, checked
 * post-transaction, not here), then tag legality — run LAST and regardless of
 * which phase branch was taken, since a phase-legal edge can still carry an
 * illegal tag. Tag legality running last is why a phase-illegal tagged
 * `extends` reports its PHASE problem first: the writer's own type is the
 * more direct lever, and a caller told to declare a lane for an edge it may
 * not write at all would be sent to fix the wrong thing.
 */
export function validateRelationTarget(
  input: RelationTargetValidationInput,
): RelationTargetValidationResult {
  if (input.targetKind === "segment") {
    return { ok: false, reason: "segment-target", detail: SEGMENT_TARGET_DETAIL };
  }
  if (input.isSelfReference) {
    if (input.relation !== "grounds") {
      return { ok: false, reason: "self-not-grounds", detail: SELF_NOT_GROUNDS_DETAIL };
    }
    // round-4 review #1 (the implementer half, checked here — see this
    // module's header): a decision-only turn can never self-ground, whether
    // or not it holds some lane's terminus.
    if (!input.citingPhases.has("delivery")) {
      return { ok: false, reason: "self-not-delivery", detail: SELF_NOT_DELIVERY_DETAIL };
    }
  } else if (!isRelationLegalForPhases(input.relation, input.citingPhases, input.citedPhases)) {
    return {
      ok: false,
      reason: "phase-illegal",
      detail: explainRelationPhaseRejection(input.relation, input.citingPhases, input.citedPhases),
    };
  }
  return checkTagLegality(input);
}

/**
 * rubric-v10 ticket 02 (Gate C): the self-`grounds` terminus check, run by the
 * caller AFTER every edge this call writes has landed (retractions and
 * attaches alike) — see this module's header for why the check cannot live
 * inside `validateRelationTarget` itself. `edges` is the citing turn's own
 * outgoing edges at that post-write moment, in the minimal shape this
 * DB-free module needs (structurally compatible with `db/memory-edges.ts`'s
 * `MemoryEdge`, so a caller can pass `getOutgoingEdges`' result straight
 * through with no mapping).
 */
export interface RelationEdgeFact {
  relation: string | null;
  tags: readonly string[];
  /**
   * round-4 review #1: whether the CITING turn is CURRENTLY this
   * declaration's lane terminus in the post-transaction graph. The caller
   * computes this by reducing the lane's full event history (typically
   * `shared/lane-interpretation.ts`'s `deriveLaneInterpretation`, in turn
   * order — never edge-write order) BEFORE building this fact, so a later
   * tagged override (reopen) or untagged override (repudiation) is already
   * folded in. Omitted or `false` FAILS CLOSED: a fact asserting only "this
   * relation is a tagged `indexes`", with no positive proof it still stands,
   * must never ground — that narrower fact being treated as sufficient was
   * exactly the stale-declaration bug this field closes.
   */
  isCurrentTerminus?: boolean;
}

export function hasTaggedTerminusDeclaration(
  edges: readonly RelationEdgeFact[],
): boolean {
  return edges.some(
    (edge) => edge.relation === "indexes" && edge.tags.length > 0 && edge.isCurrentTerminus === true,
  );
}

export function checkSelfGroundsTerminus(
  edges: readonly RelationEdgeFact[],
): RelationTargetValidationResult {
  if (hasTaggedTerminusDeclaration(edges)) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: "self-not-terminus",
    detail: SELF_GROUNDS_NO_TERMINUS_DETAIL,
  };
}

/**
 * The relation vocabulary's camelCase PARAMETER name, one per `EDGE_RELATIONS`
 * word. Every new word is already a single lowercase token, so this map is
 * the identity function in practice — it stays a `Record` (rather than
 * reusing the string directly) so a schema (`mcp/definitions.ts`'s
 * `noteInputShape`) and a field-loop (`mcp/note.ts`'s `RELATION_FIELD_ENTRIES`)
 * both derive from the SAME exhaustive table, and an eighth relation added to
 * `EDGE_RELATIONS` tomorrow without an entry here is a compile-time error.
 */
export const RELATION_FIELD_NAME: Record<TurnEdgeRelation, string> = {
  override: "override",
  narrows: "narrows",
  extends: "extends",
  indexes: "indexes",
  consume: "consume",
  grounds: "grounds",
  verifies: "verifies",
  refutes: "refutes",
};

// Re-exported so a consumer that only wants the vocabulary/type table need
// not also import type-vocabulary.ts directly.
export { MEMORY_TYPES };
export type { MemoryType };
