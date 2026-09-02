/**
 * WHAT THE FROZEN ELECTIONS READ OFF AN EDGE, keyed on the THREE CLASSES
 * (relation-vocabulary-v13, ticket 05a).
 *
 * Two elections were keyed on the seven retired words:
 *
 *   - `shared/milestone-election.ts` — `IN_DEGREE_RELATIONS` (six words), the
 *     convergence tiers ①/②/④ (`indexes`), and the tier-⑤ corrector
 *     (`override`);
 *   - `mcp/timeline.ts`'s frontier section — `FRONTIER_OUT_EDGE_WEIGHTS` /
 *     `FRONTIER_IN_EDGE_WEIGHTS`, the lane-local numeric weights.
 *
 * Both are correct TODAY only through `shared/relation-class.ts`'s INTERIM
 * table: a three-class write also lands a representative seven-word value in
 * `memory_edges.relation`, so a `use` row reads back here as `extends`. This
 * module re-keys them onto `(class, coverage)` so that equivalence stops being
 * load-bearing. It does NOT delete the interim fill — that is a later commit,
 * after the user rules on `use`'s weight.
 *
 * ## Three of the four keys are FORCED; `use` is not
 *
 * `correct`/`full` inherits `override`'s weights, `correct`/`partial`
 * inherits `narrows`', `verify` inherits `verifies`' — each class has exactly
 * one source word, so the re-key cannot change what those rows score.
 *
 * `use` absorbed FOUR words that scored FOUR different ways:
 *
 *   | word      | out | in | tier ①/②/④ | edge-signals |
 *   |-----------|-----|----|------------|--------------|
 *   | `extends` |  0  | 0  | no         | refines      |
 *   | `consume` |  0  | 0  | no         | (nothing)    |
 *   | `grounds` |  1  | 2  | no         | encodes      |
 *   | `indexes` |  2  | 1  | YES, alone | encodes      |
 *
 * There is no forced answer, and the spec forbids inventing one: "no fan-out
 * threshold may be chosen until the corpus is re-annotated under the final
 * rules" (spec, Out of scope), and ruling S15069/T2306 makes out-degree a
 * milestone RANKING PROXY rather than a recovered representation. So `use`'s
 * weight and the convergence rule are PARAMETERS
 * (`ElectionRelationParameters`), defaulting to the exact behaviour the
 * interim table produces today.
 *
 * ## The retired-word residue
 *
 * `FROZEN_ELECTION_RELATION_PARAMETERS` reproduces today by reading each
 * RETIRED WORD's own frozen weight (`RETIRED_USE_WORD_WEIGHTS`) instead of one
 * class-wide number. That residue is corpus HISTORY, not live vocabulary: no
 * write surface can produce `grounds`, `consume` or `indexes` any more
 * (`shared/relation-class.ts`'s `RETIRED_RELATION_FIELDS` refuses them at both
 * write surfaces, and `interimLegacyRelation` maps `use` to `extends`), so a
 * row carrying one is necessarily pre-v13 stock. A NEW `use` row — whatever
 * the interim fill leaves in `relation`, including nothing once it is deleted
 * — takes the class-wide value, which under the frozen parameters is
 * `extends`'s 0/0, exactly what the interim produces.
 *
 * That is what makes "default = today" true on the existing corpus AND on
 * every new write, without either half of the vocabulary being special-cased
 * at a call site.
 */

import {
  edgeRelationClass,
  NO_RELATION_CLASS,
  NO_RELATION_COVERAGE,
  type RelationClass,
  type RelationClassValue,
  type RelationCoverageValue,
} from "./relation-class";

/**
 * An edge as every reader in this module reads it: the stored word (which may
 * be absent), plus the two class columns (which may be absent on a caller's
 * fixture that predates them). Exactly `LaneEdgeInput`'s own relation triple
 * and `FrontierEdge`'s, so neither needs an adapter.
 */
export interface ElectionEdgeRelation {
  relation: string | null;
  relationClass?: RelationClassValue;
  relationCoverage?: RelationCoverageValue;
}

/** Out/in weight pair — the frontier's two lane-local tables, read as one value per class. */
export interface EdgeWeightPair {
  out: number;
  in: number;
}

/**
 * How a `use` edge is weighted. `retired-words` is today: each retired word
 * keeps its own frozen pair and anything else (a NEW `use` row) takes
 * `extends`'s 0/0. `uniform` is the class-wide answer a ruling would install.
 */
export type UseEdgeWeighting =
  | { kind: "retired-words" }
  | { kind: "uniform"; out: number; in: number };

/**
 * What DECLARES a convergence — the single feeder of milestone tiers ①
 * (unsettled cross-lane aggregation), ② (this node declares one) and ④ (the
 * nodes an elected declarer named).
 *
 * `retired-indexes` is today: only a stored `indexes` word declares, so the
 * tiers see NOTHING new once that word is retired. `use-out-degree` is ruling
 * T2306's ranking proxy: a node whose `use` out-degree reaches `threshold`
 * declares, and the nodes it cites are what it declared.
 */
export type ConvergenceDeclaration =
  | { kind: "retired-indexes" }
  | { kind: "use-out-degree"; threshold: number };

/** The two open knobs, in one place so a ruling moves one object, not five call sites. */
export interface ElectionRelationParameters {
  readonly use: UseEdgeWeighting;
  readonly convergence: ConvergenceDeclaration;
}

/**
 * DEFAULT = TODAY. Every election in the tree runs on this unless a caller
 * (a test, or `.scratch/relation-vocabulary-v13/experiments/05a`'s measurement
 * harness) passes something else. Changing this constant is a scoring ruling,
 * not a refactor.
 */
export const FROZEN_ELECTION_RELATION_PARAMETERS: ElectionRelationParameters = Object.freeze({
  use: Object.freeze({ kind: "retired-words" }),
  convergence: Object.freeze({ kind: "retired-indexes" }),
}) as ElectionRelationParameters;

/** The stored word every retired `use` source carried. Corpus history — unproducible by any write surface. */
export const RETIRED_USE_WORDS = ["extends", "consume", "grounds", "indexes"] as const;
export type RetiredUseWord = (typeof RETIRED_USE_WORDS)[number];

/**
 * The frozen frontier weights of the four words `use` absorbed. `extends` is
 * also the value a row with no retired word takes, because `extends` is what
 * the interim fill writes for `use`.
 */
export const RETIRED_USE_WORD_WEIGHTS: Record<RetiredUseWord, EdgeWeightPair> = Object.freeze({
  extends: Object.freeze({ out: 0, in: 0 }),
  consume: Object.freeze({ out: 0, in: 0 }),
  grounds: Object.freeze({ out: 1, in: 2 }),
  indexes: Object.freeze({ out: 2, in: 1 }),
}) as Record<RetiredUseWord, EdgeWeightPair>;

/** The retired word a `use` row carries, or null for a row written under the three classes. */
export function retiredUseWord(edge: ElectionEdgeRelation): RetiredUseWord | null {
  const word = edge.relation;
  return (RETIRED_USE_WORDS as readonly string[]).includes(word ?? "")
    ? (word as RetiredUseWord)
    : null;
}

/**
 * FORCED keys — `correct`/`full` from `override` (2 out, ABSENT in: the
 * overrider signal lives in out-degree), `correct`/`partial` from `narrows`
 * (1/1), `verify` from `verifies` (1 out, 2 in). One source word each, so
 * these numbers cannot have moved.
 */
const FORCED_CLASS_WEIGHTS: Record<string, EdgeWeightPair> = Object.freeze({
  "correct(full)": Object.freeze({ out: 2, in: 0 }),
  "correct(partial)": Object.freeze({ out: 1, in: 1 }),
  verify: Object.freeze({ out: 1, in: 2 }),
}) as Record<string, EdgeWeightPair>;

function classKeyOf(
  relationClass: RelationClass,
  relationCoverage: RelationCoverageValue,
): string {
  return relationCoverage === NO_RELATION_COVERAGE
    ? relationClass
    : `${relationClass}(${relationCoverage})`;
}

/**
 * The class of one edge, through `shared/relation-class.ts`'s ONE accessor —
 * never `relation_class` directly, because a database opened before ticket
 * 03's sweep runs still answers from the stored word. `null` for a bare row
 * and for a word outside the vocabulary, which is exactly what the retired
 * word-keyed tables did with those rows (absent key -> no weight, no tier).
 */
export function electionEdgeClass(
  edge: ElectionEdgeRelation,
): { relationClass: RelationClass; relationCoverage: RelationCoverageValue } | null {
  return edgeRelationClass({
    relation: edge.relation,
    relationClass: edge.relationClass ?? NO_RELATION_CLASS,
    relationCoverage: edge.relationCoverage ?? NO_RELATION_COVERAGE,
  });
}

function useWeights(
  edge: ElectionEdgeRelation,
  parameters: ElectionRelationParameters,
): EdgeWeightPair {
  if (parameters.use.kind === "uniform") {
    return { out: parameters.use.out, in: parameters.use.in };
  }
  const word = retiredUseWord(edge);
  return word === null ? RETIRED_USE_WORD_WEIGHTS.extends : RETIRED_USE_WORD_WEIGHTS[word];
}

function weightsFor(
  edge: ElectionEdgeRelation,
  parameters: ElectionRelationParameters,
): EdgeWeightPair {
  const resolved = electionEdgeClass(edge);
  if (resolved === null) {
    return { out: 0, in: 0 };
  }
  if (resolved.relationClass === "use") {
    return useWeights(edge, parameters);
  }
  return (
    FORCED_CLASS_WEIGHTS[classKeyOf(resolved.relationClass, resolved.relationCoverage)] ?? {
      out: 0,
      in: 0,
    }
  );
}

/** The frontier's lane-local OUT weight for one edge (`FRONTIER_OUT_EDGE_WEIGHTS`, re-keyed). */
export function electionOutEdgeWeight(
  edge: ElectionEdgeRelation,
  parameters: ElectionRelationParameters = FROZEN_ELECTION_RELATION_PARAMETERS,
): number {
  return weightsFor(edge, parameters).out;
}

/** The frontier's lane-local IN weight for one edge (`FRONTIER_IN_EDGE_WEIGHTS`, re-keyed). */
export function electionInEdgeWeight(
  edge: ElectionEdgeRelation,
  parameters: ElectionRelationParameters = FROZEN_ELECTION_RELATION_PARAMETERS,
): number {
  return weightsFor(edge, parameters).in;
}

/**
 * The milestone election's POSITIVE in-degree domain (`IN_DEGREE_RELATIONS`,
 * re-keyed): every class EXCEPT a full correction. The six retired words map
 * onto it exactly — `narrows` is `correct`/`partial`, `verifies` is `verify`,
 * and all four of `extends`/`consume`/`grounds`/`indexes` are `use`, so this
 * key needs no parameter: the four sources agreed here.
 *
 * `override` stays out (a correction is not an endorsement) and is no longer a
 * candidacy killer either — lane-model-v12 ticket 04 deleted that arm.
 */
export function countsTowardInDegree(edge: ElectionEdgeRelation): boolean {
  const resolved = electionEdgeClass(edge);
  if (resolved === null) {
    return false;
  }
  return !(resolved.relationClass === "correct" && resolved.relationCoverage === "full");
}

/** The tier-⑤ corrector key (`override`, re-keyed): a FULL correction. */
export function isCorrectionEdge(edge: ElectionEdgeRelation): boolean {
  const resolved = electionEdgeClass(edge);
  return resolved !== null && resolved.relationClass === "correct" && resolved.relationCoverage === "full";
}

/** Is this edge a `use`? (the convergence proxy's own counting domain). */
export function isUseEdge(edge: ElectionEdgeRelation): boolean {
  return electionEdgeClass(edge)?.relationClass === "use";
}

/**
 * WHICH EDGES DECLARE A CONVERGENCE, for one edge set — tiers ①/②/④'s single
 * feeder, computed once per election because the proxy rule needs the whole
 * set (a node's `use` out-degree) before any single edge can be judged.
 *
 * Returns a predicate over the SAME edge objects the caller passed (identity,
 * not value) so a caller can ask it per edge in its existing loops.
 */
export function convergenceDeclarationPredicate<T extends ElectionEdgeRelation & { citingId: number }>(
  edges: readonly T[],
  parameters: ElectionRelationParameters = FROZEN_ELECTION_RELATION_PARAMETERS,
): (edge: T) => boolean {
  if (parameters.convergence.kind === "retired-indexes") {
    return (edge) => edge.relation === "indexes";
  }
  const threshold = parameters.convergence.threshold;
  const useOutDegree = new Map<number, number>();
  for (const edge of edges) {
    if (isUseEdge(edge)) {
      useOutDegree.set(edge.citingId, (useOutDegree.get(edge.citingId) ?? 0) + 1);
    }
  }
  return (edge) => isUseEdge(edge) && (useOutDegree.get(edge.citingId) ?? 0) >= threshold;
}
