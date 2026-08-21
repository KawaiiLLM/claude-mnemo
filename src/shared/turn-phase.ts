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
 *   collects            same phase; the citing turn must itself be the
 *                       branch's TERMINUS and every target an OWN structural
 *                       member of that branch (the one graph-state
 *                       rejection — checked one layer up, using a flow
 *                       derivation; see `db/flows.ts`)
 *   consume             same phase; cross-flow (descriptive, not a write-time
 *                       check — P1: only `collects` gets a graph-fact reject)
 *   grounds              no restriction
 *   verifies / refutes  source must carry an evidence phase; target
 *                       unrestricted
 *
 * Splits and merges vs the retired seven-word set: `refines` -> `extends` +
 * `narrows`; `depends-on` -> `consume` + `collects`; `encodes` merges into
 * `grounds` alongside `grounded-on`; `evidence-for`/`evidence-against` rename
 * to `verifies`/`refutes`; `override` survives with its flow/layer limit
 * REMOVED. `supersedes` stays frozen-readable storage only (`db/citations.ts`'s
 * `CITATION_RELATIONS`), never a member of this module's write vocabulary.
 *
 * ## Self-citation
 *
 * The old phase-spanning self rule (a multi-phase turn could self-cite with
 * any CROSS-PHASE word) retires with the vocabulary it was built for. Exactly
 * one relation may ever cite the citing turn itself: `grounds`, and only when
 * that turn is BOTH a flow's settlement (a graph fact — its own branch's
 * terminus, unoverridden) AND that settlement's implementer (a local fact —
 * its own `type` list carries a delivery phase alongside the settled decision
 * half). Every other relation refuses a self target outright, whatever the
 * phase — this module cannot decide the settlement half on its own (no DB
 * access), so `validateRelationTarget`'s self branch below takes it as a
 * caller-supplied fact (`isSettlement`) rather than deriving it.
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
  "collects",
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

/** `override`/`collects`/`consume`: legal in every SAME-phase pair — evidence-evidence, decision-decision, delivery-delivery alike. */
const SAME_PHASE_RELATIONS: readonly TurnEdgeRelation[] = ["override", "collects", "consume"];

/** `narrows`/`extends`: legal ONLY decision-decision — narrower than the same-phase group above, definitional to a branch. */
const DECISION_ONLY_RELATIONS: readonly TurnEdgeRelation[] = ["narrows", "extends"];

/** `verifies`/`refutes`: the SOURCE must be evidence-phase; the target is unrestricted (all three phases, evidence included). */
const EVIDENCE_SOURCE_RELATIONS: readonly TurnEdgeRelation[] = ["verifies", "refutes"];

/**
 * `grounds` is handled OUTSIDE this table entirely (see
 * `isRelationLegalForPhases` below) — "no restriction" means legal even when
 * one or both phase sets are EMPTY (an untyped or legacy-typed turn), which a
 * pairs-based OR-list can never express (every pair requires SOME phase to be
 * present on each side). `RELATION_PHASE_REQUIREMENT.grounds` is therefore an
 * empty array, present only so the `Record<TurnEdgeRelation, …>` below stays
 * exhaustive at compile time — it is never consulted.
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
  for (const relation of DECISION_ONLY_RELATIONS) {
    table[relation].push({ source: "decision", target: "decision" });
  }
  for (const relation of EVIDENCE_SOURCE_RELATIONS) {
    for (const phase of TURN_PHASES) {
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
 * turn's phase set — the exists-rule a multi-type turn gets for free. `grounds`
 * short-circuits to always-legal ("no restriction", spec's own wording) —
 * the one relation whose legality this function never needs the pairs table
 * for at all.
 */
export function isRelationLegalForPhases(
  relation: TurnEdgeRelation,
  citingPhases: ReadonlySet<TurnPhase>,
  citedPhases: ReadonlySet<TurnPhase>,
): boolean {
  if (relation === "grounds") {
    return true;
  }
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
 * `grounds` never reaches here — `isRelationLegalForPhases` never says no to
 * it — so every call is against one of the other seven words.
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

const SELF_NOT_IMPLEMENTER_DETAIL =
  "is this turn's own address; a self-`grounds` needs this turn's own type list to carry a delivery-phase type " +
  "(e.g. `implement`) IN ADDITION to its decision-phase half — only a turn that is both the settlement and its own implementer may self-cite";

const SELF_NOT_SETTLEMENT_DETAIL =
  "is this turn's own address; a self-`grounds` needs this turn to itself be a flow's settlement — " +
  "the branch node nothing further narrows/extends — which it currently is not (mid-flow, overridden, or homeless)";

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
   * refused outright, whatever the phase.
   */
  isSelfReference?: boolean;
  /**
   * Only consulted when `isSelfReference` is true and `relation` is
   * `"grounds"`: is the citing turn itself a flow's settlement (its own
   * branch's terminus, unoverridden)? A GRAPH fact this module cannot derive
   * on its own — the caller supplies it from a flow derivation
   * (`db/flows.ts`'s `deriveFlowsForSessions`, `shared/flows.ts`'s
   * `isFlowSettlement`). Defaults to `false`, so a caller that never computed
   * a derivation (no `grounds` field in the call) correctly refuses rather
   * than silently admitting.
   */
  isSettlement?: boolean;
}

export type RelationTargetRejectionReason =
  | "segment-target"
  | "phase-illegal"
  | "self-not-grounds"
  | "self-not-implementer"
  | "self-not-settlement";

export type RelationTargetValidationResult =
  | { ok: true }
  | { ok: false; reason: RelationTargetRejectionReason; detail: string };

const SEGMENT_TARGET_DETAIL =
  "is a segment address — relation targets are turn-only; a segment tie goes through " +
  "ownership (e.g. remember's assign/attach) or a bare cites reference, never a relation";

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
 * The self branch runs BEFORE the ordinary phase-pair check: a self target
 * for anything but `grounds` is refused on sight (whatever the phase), and a
 * self-`grounds` needs two conditions this function takes as caller-supplied
 * facts (`isSettlement`) or derives locally (`isImplementer`, from
 * `citingPhases` itself — a self pair's cited phases equal its citing phases
 * by definition, so there is nothing to compute from `citedPhases` here).
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
    const isImplementer =
      input.citingPhases.has("decision") && input.citingPhases.has("delivery");
    if (!isImplementer) {
      return {
        ok: false,
        reason: "self-not-implementer",
        detail: SELF_NOT_IMPLEMENTER_DETAIL,
      };
    }
    if (!input.isSettlement) {
      return {
        ok: false,
        reason: "self-not-settlement",
        detail: SELF_NOT_SETTLEMENT_DETAIL,
      };
    }
    return { ok: true };
  }
  if (isRelationLegalForPhases(input.relation, input.citingPhases, input.citedPhases)) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: "phase-illegal",
    detail: explainRelationPhaseRejection(input.relation, input.citingPhases, input.citedPhases),
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
  collects: "collects",
  consume: "consume",
  grounds: "grounds",
  verifies: "verifies",
  refutes: "refutes",
};

// Re-exported so a consumer that only wants the vocabulary/type table need
// not also import type-vocabulary.ts directly.
export { MEMORY_TYPES };
export type { MemoryType };
