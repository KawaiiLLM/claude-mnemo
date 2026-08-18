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
 * The phase pair(s) each relation requires (spec's relation table). Every
 * relation but one names exactly one pair: evidence -> decision (evidence-
 * for/against), decision -> decision (refines/override), delivery ->
 * decision (encodes), delivery -> delivery (depends-on). `grounded-on` is the
 * one exception — a decision-phase citing turn may ground itself on EITHER
 * an evidence-phase OR a delivery-phase predecessor (a review/audit finding
 * grounds a decision exactly as a research finding does), so it carries TWO
 * pairs and is legal if either matches (an OR, not an AND, across the list).
 */
export const RELATION_PHASE_REQUIREMENT: Record<
  TurnEdgeRelation,
  readonly RelationPhasePair[]
> = {
  "evidence-for": [{ source: "evidence", target: "decision" }],
  "evidence-against": [{ source: "evidence", target: "decision" }],
  "grounded-on": [
    { source: "decision", target: "evidence" },
    { source: "decision", target: "delivery" },
  ],
  refines: [{ source: "decision", target: "decision" }],
  override: [{ source: "decision", target: "decision" }],
  encodes: [{ source: "delivery", target: "decision" }],
  "depends-on": [{ source: "delivery", target: "delivery" }],
};

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
  side: "citing" | "cited",
  phases: readonly TurnPhase[],
): string {
  const options = phases.map(
    (phase) => `a ${phase}-phase type (e.g. \`${PHASE_CANONICAL_TYPE[phase]}\`)`,
  );
  return `the ${side} turn to carry ${options.join(" or ")}`;
}

/**
 * The rejection detail naming which HALF is missing (turn-edge-mechanism
 * spec's own worked example: "refines needs the source to carry a
 * decision-phase type, add design"). Only ever called once
 * `isRelationLegalForPhases` has already said no, so at least one clause is
 * always produced.
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
  /** Ignored when `targetKind` is `"segment"`. */
  citedPhases: ReadonlySet<TurnPhase>;
}

export type RelationTargetRejectionReason = "segment-target" | "phase-illegal";

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
 */
export function validateRelationTarget(
  input: RelationTargetValidationInput,
): RelationTargetValidationResult {
  if (input.targetKind === "segment") {
    return { ok: false, reason: "segment-target", detail: SEGMENT_TARGET_DETAIL };
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
