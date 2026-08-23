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
 * ## Lane tags (rubric-v10 ticket 02: Gate B, the subset invariant)
 *
 * The five SAME-PHASE words (override/narrows/extends/consume/indexes) MAY
 * carry a lane-tag set; the three CROSS-PHASE words (grounds/verifies/
 * refutes) never do — lanes are phase-local, so a cross-phase word tagging
 * one would assert lane membership across a phase boundary the model does not
 * define. Two of the five MUST carry one — see the mandate below. A non-empty
 * tag set is legal only when EVERY tag it carries already
 * exists on BOTH endpoint turns' own stored `tags` (the subset invariant) —
 * violation is rejected here, naming which tag and which endpoint is missing
 * it. This module does not canonicalize the tag set itself (no DB-layer
 * dependency, same reasoning `db/memory-edges.ts`'s own doc comment gives for
 * leaving canonicalization to the write primitive) — callers pass an
 * already-canonical set, the same "caller pre-computes, this module only
 * judges" contract `citingPhases`/`citedPhases` already have.
 *
 * ## The tag mandate (tag-mandate spec, "Write gate")
 *
 * `extends` and `narrows` LOSE their untagged form: a new assertion carrying
 * either word and no tags is refused here. They are the only two words whose
 * semantics IS continuation of a line of work, so using one means naming the
 * line — continuation names its lane. The other six keep their legitimate
 * bare uses (override = global repudiation, consume = use, indexes = free
 * aggregation, grounds = dependency, verifies/refutes = testimony).
 *
 * Three boundaries the mandate deliberately does NOT cross:
 *
 *   - WORD-LEVEL ONLY. The check reads this edge's own relation and tag set,
 *     nothing about the graph — legality-of-state (an untagged row already in
 *     stock, a lane with two sources) belongs to the checker/commit ladder,
 *     which is what preserves the indexes-amendment ruling that retired
 *     graph-state write rejections.
 *   - ASSERTIONS ONLY. `retractExtends`/`retractNarrows` never reach this
 *     function (`mcp/note.ts`'s retraction path and the settlement facade's
 *     both skip legality outright — an edge that has BECOME illegal is
 *     exactly one a writer must still be able to remove), so legacy untagged
 *     rows stay deletable by their bare address.
 *   - NO CARVE-OUTS BY WRITER. Both write paths (main agent `note`,
 *     settlement facade) call `validateRelationTarget`, so the mandate lands
 *     on both from this one edit site.
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
 * it — same-phase is now the whole domain test for all five, and this same
 * list doubles as `TAGGABLE_RELATIONS` below (Gate B): the five words a lane
 * tag may ever attach to are exactly the five same-phase words, because a
 * lane is a phase-local concept.
 */
const SAME_PHASE_RELATIONS: readonly TurnEdgeRelation[] = [
  "override",
  "narrows",
  "extends",
  "indexes",
  "consume",
];

/**
 * rubric-v10 ticket 02 (Gate B): the words a lane tag may ever attach to —
 * identical to `SAME_PHASE_RELATIONS` because lanes are phase-local by
 * definition (draft-lane-model.md's 统一解读原则), not a coincidence two
 * separate lists could drift out of. A distinct exported name rather than a
 * bare re-export of `SAME_PHASE_RELATIONS` because the two questions ("what
 * phase domain does this word have" vs "may this word carry a lane tag") are
 * conceptually independent even though today's answer set is the same one —
 * a reader of Gate B's call site should not have to know that fact holds.
 */
export const TAGGABLE_RELATIONS: ReadonlySet<TurnEdgeRelation> = new Set(
  SAME_PHASE_RELATIONS,
);

export function isTaggableRelation(relation: TurnEdgeRelation): boolean {
  return TAGGABLE_RELATIONS.has(relation);
}

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

/**
 * The tag mandate (tag-mandate spec, "Write gate"): the words whose ASSERTION
 * form REQUIRES a non-empty lane-tag set — a strict subset of
 * `TAGGABLE_RELATIONS` (a word cannot be required to carry what it may not
 * carry).
 *
 * A direct ALIAS of `STANCE_RELATIONS`, not a hand-kept copy — and the
 * opposite call from `TAGGABLE_RELATIONS`' own deliberate non-aliasing of
 * `SAME_PHASE_RELATIONS`. There the two questions ("what phase domain" vs
 * "may this carry a tag") are conceptually independent and their answer sets
 * coincide by accident, so two names guard against a reader assuming the
 * identity holds. Here the identity IS the mandate's justification: the
 * stance words are the two whose meaning is continuation of a line of work,
 * and naming the line is what continuing one means. A third stance word
 * admitted tomorrow inherits the mandate by construction, which is the
 * correct outcome rather than a drift to catch.
 */
export const TAG_MANDATORY_RELATIONS: ReadonlySet<TurnEdgeRelation> = STANCE_RELATIONS;

export function isTagMandatoryRelation(relation: TurnEdgeRelation): boolean {
  return TAG_MANDATORY_RELATIONS.has(relation);
}

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

const TAG_NOT_TAGGABLE_DETAIL =
  "carries no lane tags — only override/narrows/extends/consume/indexes (same-phase words) may";

/**
 * The tag mandate's rejection — the teacher, per the spec's "Write gate": it
 * names the MANDATE (continuation names its lane) and the SUBSET requirement
 * (tag the edge; both endpoints carry the tag), so the correct tagged form is
 * one retry away rather than one rubric lookup away.
 *
 * RED LINE (the write-gate-hardening precedent, `shared/tool-call-syntax.ts`):
 * this string never reproduces angle-bracket markup. It returns straight into
 * the caller's own context, where any quoted call syntax becomes one more
 * exemplar for the attractor that produces malformed calls — so the entry
 * form is described in prose and by its field names, never shown as markup.
 * `containsToolCallSyntax` over this detail must be false, pinned by test.
 */
const TAG_REQUIRED_DETAIL =
  "carries no lane tags, and `extends`/`narrows` have no untagged form — continuation names its " +
  "lane: these two words mean this turn continues a line of work, so the edge has to say WHICH line. " +
  "Send the tagged entry form instead of a bare address (an object carrying `turn` plus a non-empty " +
  "`tags` list), and tag the edge with a set BOTH endpoints already carry — every tag on the edge must " +
  "be on this turn's own tags AND on the cited turn's, the same subset invariant every tagged edge " +
  "obeys. Retraction is unaffected: `retractNarrows`/`retractExtends` still take bare addresses, so an " +
  "untagged row already in stock stays deletable";

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
   * unconditionally (Gate C, the terminus-declaration requirement, is a
   * SEPARATE post-transaction check — `checkSelfGroundsTerminus` below).
   */
  isSelfReference?: boolean;
  /**
   * rubric-v10 ticket 02 (Gate B): this edge's own lane-tag set, already
   * canonicalized by the caller. Omitted or empty means untagged — legal for
   * six of the eight words (Gate B has nothing to check when there is no tag
   * to check), REFUSED for `extends`/`narrows` since the tag mandate
   * (`TAG_MANDATORY_RELATIONS`) took their untagged form away.
   */
  tags?: readonly string[];
  /** rubric-v10 ticket 02 (Gate B): the citing turn's own stored `tags`, canonicalized. Required only when `tags` is non-empty. */
  citingTurnTags?: ReadonlySet<string>;
  /** rubric-v10 ticket 02 (Gate B): the cited turn's own stored `tags`, canonicalized. Ignored for a segment target or a self-reference (both endpoints are the same turn there). */
  citedTurnTags?: ReadonlySet<string>;
}

export type RelationTargetRejectionReason =
  | "segment-target"
  | "phase-illegal"
  | "self-not-grounds"
  /** round-4 review #1: a self-`grounds` whose citing turn carries no delivery-phase type — the implementer half of the composite-node requirement, checked pre-write. */
  | "self-not-delivery"
  | "tag-not-taggable"
  | "tag-missing"
  /** tag-mandate spec ("Write gate"): a NEW `extends`/`narrows` assertion carrying no lane tags. Assertions only — the retraction mirrors never reach this validator. */
  | "tag-required"
  /** rubric-v10 ticket 02 (Gate C): only `checkSelfGroundsTerminus` ever returns this — a self-`grounds` with no CURRENT tagged-indexes terminus in the post-transaction graph. */
  | "self-not-terminus";

export type RelationTargetValidationResult =
  | { ok: true }
  | { ok: false; reason: RelationTargetRejectionReason; detail: string };

const SEGMENT_TARGET_DETAIL =
  "is a segment address — relation targets are turn-only; a segment tie goes through " +
  "ownership (e.g. remember's assign/attach) or a bare cites reference, never a relation";

/**
 * rubric-v10 ticket 02 (Gate B): the tag-legality half of `validateRelationTarget`,
 * factored out because it runs identically whether the phase side took the
 * self-reference branch or the ordinary phase-pair branch (a self-`grounds`
 * carrying tags is exactly as illegal as an ordinary `grounds` carrying them
 * — `grounds` is never taggable either way).
 *
 * tag-mandate spec ("Write gate"): the EMPTY case stopped being uniformly
 * legal here. An untagged `extends`/`narrows` is refused, every other word's
 * bare form passes untouched. The check is word-level and reads nothing but
 * this call's own relation and tag set, so it holds identically for both
 * write paths and needs no graph read.
 */
function checkTagLegality(input: RelationTargetValidationInput): RelationTargetValidationResult {
  const tags = input.tags ?? [];
  if (tags.length === 0) {
    if (isTagMandatoryRelation(input.relation)) {
      return { ok: false, reason: "tag-required", detail: TAG_REQUIRED_DETAIL };
    }
    return { ok: true };
  }
  if (!isTaggableRelation(input.relation)) {
    return { ok: false, reason: "tag-not-taggable", detail: TAG_NOT_TAGGABLE_DETAIL };
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
 * post-transaction, not here), then Gate B tag legality — run LAST and
 * regardless of which phase branch was taken, since a phase-legal edge can
 * still carry an illegal tag (or, under the tag mandate, no tag at all where
 * one is required). Gate B running last is why a phase-illegal untagged
 * `extends` reports its PHASE problem first: the writer's own type is the
 * more direct lever, and a caller told to tag an edge it may not write at
 * all would be sent to fix the wrong thing.
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
