/**
 * THE ELECTION'S ONE WEIGHT TABLE (main-agent-edges spec D2, ruling T2421 —
 * "the election becomes a heuristic score").
 *
 * What this replaces: six identity TIERS keyed on the seven retired relation
 * words (`indexes` declared a convergence, `override` made a corrector, six
 * words fed a positive in-degree), plus the parameter table
 * `shared/election-relation-weights.ts` that re-keyed those tiers onto the
 * three classes while leaving the tier machinery standing. Both are deleted.
 * The lexicographic tier ladder is gone: a node's rank is ONE number now.
 *
 *   S(n) = w_out · outDeg(n)
 *        + Σ_{e ∈ out(n)} w_class(e)
 *        + w_rec · rec(n)
 *        + w_type · type(n)
 *
 * `outDeg(n)` counts n's LOGICAL edges — every outgoing relation row,
 * whatever it says. `w_class(e)` prices each of those edges by what it
 * claims. `rec(n)` is the node's position in the pool's own event order,
 * `type(n)` the strongest word in its own `type` array.
 *
 * ## Why the numbers are here and only here
 *
 * They are a TUNING KNOB, not a derivation: the spec names them "adjusted
 * only by looking at production". Keeping every one of them in a single
 * frozen object is what makes that possible — a retune moves one object, and
 * a reader asking "what does a partial correction buy" gets the answer in one
 * place instead of reconstructing it from a tier predicate, an in-degree
 * membership test and a numeric side table that disagreed about the same
 * edge.
 *
 * There is deliberately no `ElectionParameters` argument any more. The old
 * table existed because the seven-to-three re-key could not FORCE two of its
 * keys (`use`'s weight, what declares a convergence) and the ruling was still
 * open; T2421 closed it by deleting the question — `use` is priced like every
 * other class, and nothing declares a convergence because no tier reads one.
 */

import {
  edgeRelationClass,
  formatRelationClass,
  NO_RELATION_CLASS,
  NO_RELATION_COVERAGE,
  type RelationClassValue,
  type RelationCoverageValue,
} from "./relation-class";

/**
 * An edge as the scorer reads it: the two class columns, plus the stored word
 * that `edgeRelationClass` still falls back to for a row written before the
 * class columns existed (`shared/relation-class.ts` owns that bridge, and the
 * cutover ticket deletes it with the column). Exactly `LaneEdgeInput`'s own
 * relation triple, so no caller needs an adapter.
 */
export interface ElectionEdgeRelation {
  /** OPTIONAL, and absent on every caller that has already stopped carrying it — the column is dropped at the cutover (spec D1) and this field goes with it. */
  relation?: string | null;
  relationClass?: RelationClassValue;
  relationCoverage?: RelationCoverageValue;
}

/**
 * THE TABLE. Four coefficients and two keyed maps — everything the score
 * reads, nothing it does not.
 *
 * `class`: what one outgoing edge is worth, by the claim it makes. A full
 * correction (2.0) says the cited result may no longer be used as a premise;
 * a partial one (1.5) limits it; a verification (1.0) confirms it; a plain
 * use (0.5) only consumed it. The ordering is the class precedence's own,
 * priced.
 *
 * `turnType`: what the node's own stated work is worth. `design`/`correction`
 * (1.5) are the two the round-2 ablation measured as the only arm with an
 * effect; the reporting words (1.0) come next; the executing words (0.5)
 * below them; the incidental ones (0.25) barely register. A node whose `type`
 * is empty, or holds nothing in this table, scores 0 — absence is not
 * evidence of anything.
 */
export const ELECTION_WEIGHTS = Object.freeze({
  /** `w_out` — per outgoing logical edge, whatever it claims. */
  outDegree: 1,
  /** `w_rec` — the whole recency term's coefficient; `rec(n)` itself is already in [0, 1]. */
  recency: 1,
  /** `w_type` — the type term's coefficient. */
  type: 1,
  /** `w_class(e)`, keyed by `formatRelationClass` (`correct(full)`, `correct(partial)`, `verify`, `use`). */
  class: Object.freeze({
    "correct(full)": 2.0,
    "correct(partial)": 1.5,
    verify: 1.0,
    use: 0.5,
  } as Record<string, number>),
  /** `type(n)` = the MAX over the node's own type words. Absent word = 0. */
  turnType: Object.freeze({
    design: 1.5,
    correction: 1.5,
    measure: 1.0,
    research: 1.0,
    review: 1.0,
    implement: 0.5,
    fix: 0.5,
    refactor: 0.5,
    ops: 0.25,
    delegate: 0.25,
    discuss: 0.25,
  } as Record<string, number>),
});

/**
 * The class of one edge, through `shared/relation-class.ts`'s ONE accessor —
 * never a stored word directly. `null` for a bare row and for a word outside
 * the vocabulary, which the score treats as worth nothing (the row still
 * counts toward out-degree, exactly as the retired tally did: out-degree
 * never read a relation at all).
 */
export function electionEdgeClass(
  edge: ElectionEdgeRelation,
): { relationClass: string; relationCoverage: RelationCoverageValue } | null {
  return edgeRelationClass({
    relation: edge.relation ?? null,
    relationClass: edge.relationClass ?? NO_RELATION_CLASS,
    relationCoverage: edge.relationCoverage ?? NO_RELATION_COVERAGE,
  });
}

/** `w_class(e)` — 0 for a row that resolves to no class at all. */
export function electionClassWeight(edge: ElectionEdgeRelation): number {
  const resolved = electionEdgeClass(edge);
  if (resolved === null) {
    return 0;
  }
  return (
    ELECTION_WEIGHTS.class[
      formatRelationClass(
        resolved.relationClass as never,
        resolved.relationCoverage,
      )
    ] ?? 0
  );
}

/**
 * THE FRONTIER'S OWN LANE-LOCAL WEIGHTS — a DIFFERENT scorer from `S(n)`
 * above, kept here because it is the other place in the tree that prices an
 * edge by what it claims, and two weight tables in two files is exactly how
 * they drifted last time.
 *
 * `mcp/timeline.ts`'s frontier section ranks the members of ONE lane, so it
 * scores an edge twice — once at its tail (this member cited something) and
 * once at its head (this member was cited) — where the milestone score has
 * only the out side. The numbers are the frozen ones, re-keyed off the
 * retired words exactly as ticket 05a re-keyed them: a full correction is a
 * strong OUT signal and deliberately weightless IN (the overrider signal
 * lives in out-degree), a verification is the mirror of that, a partial
 * correction is symmetric.
 *
 * `use` is 0/0. That is the value the interim word fill produced for every
 * `use` row written under v13 (it landed as `extends`, weighted 0/0), so this
 * is a no-change for current stock. It IS a change for pre-v13 rows that
 * still carry `grounds` (was 1/2) or `indexes` (was 2/1): the retired-word
 * residue is deleted with the parameter table, and those rows now weigh what
 * their class weighs. That delta is listed in this ticket's own expected-delta
 * manifest — it is the price of having one number per class instead of four
 * per class.
 */
export const FRONTIER_EDGE_WEIGHTS: Readonly<Record<string, { out: number; in: number }>> =
  Object.freeze({
    "correct(full)": Object.freeze({ out: 2, in: 0 }),
    "correct(partial)": Object.freeze({ out: 1, in: 1 }),
    verify: Object.freeze({ out: 1, in: 2 }),
    use: Object.freeze({ out: 0, in: 0 }),
  } as Record<string, { out: number; in: number }>);

function frontierWeights(edge: ElectionEdgeRelation): { out: number; in: number } {
  const resolved = electionEdgeClass(edge);
  if (resolved === null) {
    return { out: 0, in: 0 };
  }
  return (
    FRONTIER_EDGE_WEIGHTS[
      formatRelationClass(resolved.relationClass as never, resolved.relationCoverage)
    ] ?? { out: 0, in: 0 }
  );
}

/** The frontier's lane-local OUT weight for one edge. */
export function frontierOutEdgeWeight(edge: ElectionEdgeRelation): number {
  return frontierWeights(edge).out;
}

/** The frontier's lane-local IN weight for one edge. */
export function frontierInEdgeWeight(edge: ElectionEdgeRelation): number {
  return frontierWeights(edge).in;
}

/** Is this edge a FULL correction? The `latest override` pointer's own filter, re-keyed off the retired word. */
export function isFullCorrectionEdge(edge: ElectionEdgeRelation): boolean {
  const resolved = electionEdgeClass(edge);
  return (
    resolved !== null &&
    resolved.relationClass === "correct" &&
    resolved.relationCoverage === "full"
  );
}

/** `type(n)` — the MAX weight over the node's own type words; 0 for a node whose types name nothing in the table. */
export function electionTypeWeight(types: readonly string[] | undefined): number {
  let best = 0;
  for (const word of types ?? []) {
    const weight = ELECTION_WEIGHTS.turnType[word];
    if (weight !== undefined && weight > best) {
      best = weight;
    }
  }
  return best;
}
