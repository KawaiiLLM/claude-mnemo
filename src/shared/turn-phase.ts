import { MEMORY_TYPES, type MemoryType } from "./type-vocabulary";

/**
 * Turn phases and the edge-relation vocabulary they license (turn-edge-
 * mechanism spec, ticket 01). Importance is no longer assigned (a 0-4 grade,
 * an A/B/C election) — it is DERIVED from edges, and which edges a turn may
 * carry is derived from its `type` list through exactly three phases:
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
 * One shared module (this file), not duplicated per consumer: ticket 01
 * (note's write-time validation) and ticket 07 (milestone scoring) both
 * derive a turn's phase and a relation's phase requirement from the SAME
 * table, so the two can never silently disagree about what a phase pair
 * licenses.
 *
 * Direction convention ([S15069/T930]): an edge is recorded from the CITING
 * (later) turn to its CITED predecessor — `memory_edges.citing_id` is always
 * the turn being written now, `cited_id` the turn it points at. Every
 * relation below reads in that direction; `grounded-on` (added [S15069/T935])
 * is no exception, even though English reads more naturally the other way
 * ("my decision is grounded on that finding" still stores citing=the
 * decision, cited=the finding).
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
 * words, and spec's multi-type rule is exists-based — a relation is legal iff
 * SOME (source phase, target phase) pair the turn's own type list admits
 * matches the relation's requirement, not that every type word does. An
 * unrecognised or legacy `type` word (nothing in `MEMORY_TYPES`) contributes
 * no phase, the same "unmapped input strengthens nothing" rule
 * `parseMemberFacetArray` (db/segments.ts) already applies to a member's
 * facet arrays.
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
 * The SEVEN-word closed set (turn-edge-mechanism spec: "关系词表收敛为七个词、
 * 五个语义类" — lineage, evidence, grounding, encoding, dependency).
 * `grounded-on` joined the original six as a [S15069/T935] mid-flight
 * amendment. `supersedes` is deliberately NOT a member: it retired from the
 * write vocabulary (a decision spec's own finding — none of 10 measured
 * `supersedes` edges actually invalidated a predecessor's WHOLE conclusion)
 * but stays a legal STORED value for reads (`db/citations.ts`'s
 * `CITATION_RELATIONS` keeps it) — this module governs only which relations a
 * NEW write may legally carry, and `supersedes` is not one of them any more.
 */
export const EDGE_RELATIONS = [
  "evidence-for",
  "evidence-against",
  "grounded-on",
  "refines",
  "override",
  "encodes",
  "depends-on",
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
 * The phase pair(s) each relation requires — the relation-matrix spec's
 * nine-cell grammar (S15069/T1163–T1171), which replaced the original seven
 * hand-carved single-pair rows with two reading rules:
 *
 *   Rule 1 — DIAGONAL (same phase on both ends): `refines`, `override` and
 *   `depends-on` are each legal in EVERY same-phase pair — evidence-
 *   >evidence and delivery->delivery exactly as much as decision->decision,
 *   not decision->decision only. Which of the three to use is a guarantee-
 *   strength judgment (override: predecessor wrong & replaceable; refines:
 *   predecessor right & improved on, not replaceable; depends-on: only a
 *   completion dependency, no correctness claim) that lives in the Memory
 *   Rubric, not in this phase-legality table.
 *
 *   Rule 2 — CROSS-PHASE (different phase on each end): the relation word is
 *   fixed by the citing (SOURCE) turn's own phase, and is admitted toward
 *   BOTH other phases — an evidence source always speaks `evidence-for`/
 *   `evidence-against` (toward decision OR delivery), a decision source
 *   always speaks `grounded-on` (toward evidence OR delivery, unchanged from
 *   the original table), a delivery source always speaks `encodes` (toward
 *   decision OR evidence).
 *
 * `DIAGONAL_RELATIONS` and `CROSS_PHASE_SOURCE` below are literally these two
 * rules as data; `RELATION_PHASE_REQUIREMENT` is their product, built once at
 * module load so every consumer keeps seeing one flat OR-list of pairs per
 * relation — `isRelationLegalForPhases`'s contract, and the shape of this
 * exported table, are unchanged by the rewrite.
 */
/**
 * Exported (relation-matrix spec, "自引用", ticket 05): a diagonal word
 * compares a turn against a DIFFERENT turn in the same phase by construction
 * — override/refines/depends-on always relate two distinct in-phase turns —
 * so a diagonal relation can never legally cite the citing turn itself,
 * whatever its phase set. `validateRelationTarget`'s self branch below reads
 * this list directly rather than re-deriving "which relations are diagonal"
 * from `RELATION_PHASE_REQUIREMENT`.
 */
export const DIAGONAL_RELATIONS: readonly TurnEdgeRelation[] = ["refines", "override", "depends-on"];

/** Rule 2's table: source phase -> the relation word(s) it speaks, and the two other phases each may target. */
const CROSS_PHASE_SOURCE: Record<
  TurnPhase,
  { relations: readonly TurnEdgeRelation[]; targets: readonly TurnPhase[] }
> = {
  evidence: {
    relations: ["evidence-for", "evidence-against"],
    targets: ["decision", "delivery"],
  },
  decision: { relations: ["grounded-on"], targets: ["evidence", "delivery"] },
  delivery: { relations: ["encodes"], targets: ["decision", "evidence"] },
};

function buildRelationPhaseRequirement(): Record<TurnEdgeRelation, RelationPhasePair[]> {
  const table = Object.fromEntries(
    EDGE_RELATIONS.map((relation) => [relation, [] as RelationPhasePair[]]),
  ) as Record<TurnEdgeRelation, RelationPhasePair[]>;

  for (const phase of TURN_PHASES) {
    for (const relation of DIAGONAL_RELATIONS) {
      table[relation].push({ source: phase, target: phase });
    }
  }
  for (const phase of TURN_PHASES) {
    const { relations, targets } = CROSS_PHASE_SOURCE[phase];
    for (const relation of relations) {
      for (const target of targets) {
        table[relation].push({ source: phase, target });
      }
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
 * turn's phase set — the exists-rule a multi-type turn gets for free (spec,
 * ticket 01): a `["design","ops"]` turn's phase set is {decision, delivery},
 * so it satisfies `refines`' source requirement (decision) AND `encodes`'
 * source requirement (delivery) at once. For `grounded-on` specifically, the
 * OR is across its own two listed pairs, not across turn types — a decision
 * grounded on either an evidence-phase or a delivery-phase predecessor is
 * equally legal.
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
 * The rejection detail naming which HALF is missing (worked example:
 * "encodes needs the citing turn to carry a delivery-phase type, add
 * implement"). Only ever called once `isRelationLegalForPhases` has already
 * said no, so at least one clause is always produced.
 *
 * Since the relation-matrix rewrite widened `refines`/`override`/
 * `depends-on` to all three diagonal phases, the CITING side of those three
 * is only ever reported missing for a turn with NO recognised phase at all
 * (an empty or fully-legacy `type` list) — any recognised type satisfies
 * SOME diagonal pair, so a same-relation cross-phase mismatch (e.g. a
 * delivery-phase turn pointing `refines` at a decision-phase target) is
 * reported on the CITED side instead.
 *
 * Reports the CITING side first: if no listed pair's source phase is present
 * at all, that is reported (the writer's own type is the more direct lever);
 * otherwise every pair whose source DID match contributes its target phase to
 * a combined "cited turn needs X or Y" clause — the shape `grounded-on`'s two
 * pairs need when the citing side is fine but the cited turn's phase does not
 * satisfy either.
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

/**
 * Same "missing-half" shape as `explainRelationPhaseRejection`, pointed at
 * the one type list a self-citation can actually fix — its OWN (relation-
 * matrix spec, "自引用", ticket 05). A self pair's cited phases are, by
 * definition, the citing turn's own phases (the address names the same row),
 * so this takes a single phase set rather than two, and the CITED-side clause
 * always reads "this turn's own type list" rather than "the cited turn" — the
 * latter would send a writer looking for a different target to cite instead
 * of telling it to widen its own `type` list, which is the only real fix.
 *
 * Only ever called for a relation `isRelationLegalForPhases` has already said
 * no to, evaluated with the SAME set on both sides (see the self branch of
 * `validateRelationTarget` below) — never for a diagonal relation, which is
 * rejected on sight regardless of phase.
 */
function explainSelfReferenceRejection(
  relation: TurnEdgeRelation,
  phases: ReadonlySet<TurnPhase>,
): string {
  const pairs = RELATION_PHASE_REQUIREMENT[relation];
  const sourceSatisfiedPairs = pairs.filter((pair) => phases.has(pair.source));
  if (sourceSatisfiedPairs.length === 0) {
    const sourcePhases = [...new Set(pairs.map((pair) => pair.source))];
    return `needs ${phaseRequirementClause("self", sourcePhases)}`;
  }
  const targetPhases = [...new Set(sourceSatisfiedPairs.map((pair) => pair.target))];
  return (
    `needs ${phaseRequirementClause("self", targetPhases)} IN ADDITION to what it already ` +
    "carries — a single-phase turn can never self-cite, only a turn whose own type list spans two phases"
  );
}

const SELF_DIAGONAL_DETAIL =
  "is a same-phase (diagonal) relation and cannot cite itself, whatever the phase — " +
  "refines/override/depends-on only ever compare two DIFFERENT turns in the same phase, " +
  "so citing itself with one of them is a tautology, not a claim";

/**
 * A relation target's node kind, as `db/references.ts`'s address parser
 * already distinguishes it — re-declared here rather than imported so this
 * module stays free of any DB-layer dependency (a future settlement
 * correction surface, ticket 08, may resolve an address through entirely
 * different plumbing and still owes this module only a kind + a phase set).
 */
export type RelationTargetKind = "turn" | "segment";

export interface RelationTargetValidationInput {
  relation: TurnEdgeRelation;
  citingPhases: ReadonlySet<TurnPhase>;
  targetKind: RelationTargetKind;
  /** Ignored when `targetKind` is `"segment"`, or when `isSelfReference` is true. */
  citedPhases: ReadonlySet<TurnPhase>;
  /**
   * True when the resolved target IS the citing turn (relation-matrix spec,
   * "自引用", ticket 05: a multi-phase turn may cite itself with a CROSS-PHASE
   * word — its own phase set has to span both the word's source phase and a
   * distinct legal target phase — never with a diagonal one). The address
   * names the SAME row in this case, so `citedPhases` is ignored in favour of
   * `citingPhases` on both sides; callers may pass an empty set for it.
   * Defaults to `false` — every caller predating ticket 05 is unaffected.
   */
  isSelfReference?: boolean;
}

export type RelationTargetRejectionReason =
  | "segment-target"
  | "phase-illegal"
  | "self-diagonal"
  | "self-single-phase";

export type RelationTargetValidationResult =
  | { ok: true }
  | { ok: false; reason: RelationTargetRejectionReason; detail: string };

const SEGMENT_TARGET_DETAIL =
  "is a segment address — relation targets are turn-only; a segment tie goes through " +
  "ownership (e.g. remember's assign/attach) or a bare cites reference, never a relation";

/**
 * THE shared judgment (2026-08 mid-flight amendment, [S15069/T939]): every
 * caller that may attach a relation — `mcp/note.ts` today, a future
 * settlement correction surface (ticket 08) tomorrow — asks this ONE
 * function "is this relation legal here", rather than each re-implementing
 * the segment-target refusal and the phase-pair check against its own copy
 * of the rules. Address parsing and DB lookups stay with the caller (this
 * module takes phase SETS and a target kind, never a raw address token or a
 * database handle) — what is shared is the DOMAIN judgment, not the
 * plumbing that feeds it.
 *
 * `detail` never carries a leading relation/address label or a trailing
 * period — callers compose those around it however their own message format
 * wants (`mcp/note.ts` prefixes `relation "raw"`; a future caller may not).
 *
 * Ticket 05's self branch runs BEFORE the ordinary phase-pair check, not
 * after it: feeding `citingPhases` in twice into the ordinary rule would get
 * the CROSS-PHASE case right on its own (a self pair's cited phases equal its
 * citing phases by definition), but would also wrongly ADMIT a diagonal
 * relation — same-phase-vs-itself trivially satisfies "same phase" — which is
 * exactly the tautology diagonal words must never express. The dedicated
 * branch excludes diagonal relations outright and only then falls back to the
 * ordinary phase machinery (with the same set on both sides) for the rest.
 */
export function validateRelationTarget(
  input: RelationTargetValidationInput,
): RelationTargetValidationResult {
  if (input.targetKind === "segment") {
    return { ok: false, reason: "segment-target", detail: SEGMENT_TARGET_DETAIL };
  }
  if (input.isSelfReference) {
    if (DIAGONAL_RELATIONS.includes(input.relation)) {
      return { ok: false, reason: "self-diagonal", detail: SELF_DIAGONAL_DETAIL };
    }
    if (isRelationLegalForPhases(input.relation, input.citingPhases, input.citingPhases)) {
      return { ok: true };
    }
    return {
      ok: false,
      reason: "self-single-phase",
      detail: explainSelfReferenceRejection(input.relation, input.citingPhases),
    };
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
 * word — the SAME map a schema (`mcp/definitions.ts`'s `noteInputShape`) and
 * a field-loop (`mcp/note.ts`'s `RELATION_FIELD_ENTRIES`) both derive from,
 * so the seven-word closed set and its parameter spelling cannot drift apart
 * (a `Record<TurnEdgeRelation, …>` is exhaustive at compile time: adding an
 * eighth relation to `EDGE_RELATIONS` without adding its entry here is a
 * type error, not a silent gap).
 */
export const RELATION_FIELD_NAME: Record<TurnEdgeRelation, string> = {
  "evidence-for": "evidenceFor",
  "evidence-against": "evidenceAgainst",
  "grounded-on": "groundedOn",
  refines: "refines",
  override: "override",
  encodes: "encodes",
  "depends-on": "dependsOn",
};

/**
 * Ticket 07 (milestone scoring) note: `grounded-on` is recorded like any
 * other relation but excluded from EVERY scoring surface ([S15069/T935]) —
 * importance still reads only override (zero), refines (above-baseline
 * in-degree) and encodes (uplift). A future scoring reader must not fold
 * `grounded-on`'s in-degree into any signal; this constant exists so that
 * exclusion is a lookup here rather than a relation string re-typed at the
 * scoring call site.
 */
export const UNSCORED_RELATIONS: ReadonlySet<TurnEdgeRelation> = new Set(["grounded-on"]);

// Re-exported so a consumer that only wants the vocabulary/type table need
// not also import type-vocabulary.ts directly.
export { MEMORY_TYPES };
export type { MemoryType };
