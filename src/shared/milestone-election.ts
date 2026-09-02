/**
 * Milestone election — a HEURISTIC SCORE over node facts
 * (`.scratch/main-agent-edges/spec.md` D2, ruling S15069/T2421). Pure
 * derivation over plain arrays, the same "turns + edges in, judged output
 * out" contract `lane-checker.ts` follows: no database, no I/O, no
 * module-level state, no rendering.
 *
 * ## What this replaced, and why
 *
 * Until this ticket the election was a LEXICOGRAPHIC TIER LADDER: six
 * identity tiers, keyed on the seven retired relation words — `indexes`
 * declared a convergence and seated tiers ①/②/④, `override` made a tier-⑤
 * corrector, six of the seven fed a positive in-degree, and out-degree broke
 * ties. `shared/election-relation-weights.ts` then re-keyed those predicates
 * onto (class, coverage) while leaving the ladder itself standing, with the
 * two choices the re-key could not force (`use`'s weight, what declares a
 * convergence) exposed as parameters.
 *
 * Three classes cannot carry that ladder. `indexes` — the ONLY feeder of
 * three of the six tiers — has no successor: convergence is no longer
 * declared at all, so tiers ①, ② and ④ have no input and a "use out-degree
 * proxy" for them would be inventing a threshold the corpus has never been
 * annotated for. What survives the collapse is not a smaller ladder but a
 * different shape: every signal the tiers were reaching for (how much this
 * node was built on, how strong its claims are, how recent it is, what kind
 * of work it states) is a MAGNITUDE, and lexicographic ordering over
 * magnitudes throws away every one of them below the first.
 *
 * So: ONE number per node, from ONE weight table
 * (`shared/election-weights.ts`).
 *
 *   S(n) = w_out · outDeg(n) + Σ_{e ∈ out(n)} w_class(e)
 *        + w_rec · rec(n) + w_type · type(n)
 *
 * ## The three steps
 *
 * 0. **Eligibility boundary**: a node may only become a candidate if it is
 *    present in `turns[]` with `eligible !== false`. An edge endpoint absent
 *    from `turns[]`, or present but explicitly marked `eligible: false` (the
 *    adapters' channel for an EXTERNAL node — one an OR-scoped edge touches
 *    without being a window member, `db/memory-edges.ts`'s
 *    `getRelationEdgesAmongTurns`), is a GRAPH node but never a CANDIDATE:
 *    its own edges still price every other node's out-degree and class sum,
 *    it just never itself seats. R10-4: the edge universe for degree
 *    therefore INCLUDES live edges to external endpoints — the score of a
 *    node that cited outside the window is the same number wherever it is
 *    computed.
 * 1. **Invalid nodes leave candidacy**: a rolled-back (`wasRolledBack`) or
 *    skipped (`skipped`) turn is rubric-v12's 无效节点 and never seats. No
 *    EDGE ever removes a node from candidacy — the untagged-override
 *    repudiation arm was deleted by lane-model-v12 ticket 04 and nothing
 *    replaced it. Excluded nodes are NOT removed from the graph: their edges
 *    still count toward every other node's score.
 * 2. **Score and order.** The pool is the candidate set — the SAME set
 *    `rank_age` is measured against, so `rec(n)` is a position within what
 *    this route is actually choosing among rather than within some wider
 *    load. `rank_age` is ZERO-BASED (R10-4): the newest candidate ranks 0
 *    and scores the full `w_rec`, the oldest ranks `|pool| − 1` and keeps
 *    `w_rec/|pool|`. Event order is `compareOrderKeyAcrossSessions` — the
 *    `[session, prompt]` tuple within a session, `createdAtEpoch` FIRST
 *    across sessions, because a session id carries no wall-clock meaning
 *    relative to another session.
 *
 * **Ties**: score desc, then event order desc (the later turn wins), then id
 * desc. Deterministic, and the same tuple at every cutoff — a route's token
 * fitter admits a prefix of THIS order and never has to break a tie of its
 * own.
 *
 * ## What this module does NOT do
 *
 * No budget, no K, no truncation. `candidates` is the FULL ordered candidacy;
 * the caller's own token fitter decides how many of them render (spec D2:
 * "K is whatever the fitter admits in score order under its budget"). Display
 * order stays chronological and is likewise the caller's, not this module's.
 *
 * Degradation to recency on an edgeless window needs no special-cased branch:
 * with zero edges and no typed turn, every candidate's score is exactly
 * `w_rec · rec(n)`, which is strictly decreasing in age — recency ordering,
 * out of the same formula.
 */

import {
  electionClassWeight,
  electionTypeWeight,
  ELECTION_WEIGHTS,
} from "./election-weights";
import {
  compareOrderKeyAcrossSessions,
  type LaneEdgeInput,
  type LaneOrderKey,
  type LaneTurnInput,
} from "./lane-interpretation";

export type { LaneEdgeInput } from "./lane-interpretation";

/**
 * One taggable input turn, `lane-interpretation.ts`'s `LaneTurnInput` widened
 * with the two turn-level reversal flags candidacy exclusion (step 1) reads
 * — `mcp/timeline.ts`'s own `turns.was_rolled_back` / `status === 'skipped'`
 * naming, re-declared here so this module stays free of any DB-layer
 * dependency. Both default to `false`/absent.
 *
 * `eligible: false` marks a GRAPH-ONLY entry — real metadata for an edge
 * endpoint the caller's own window does not contain. Such an entry still
 * feeds the order/epoch maps and its own edges still price every other
 * node's score; it is simply never a candidate. Omitted or `true` = eligible.
 */
export interface MilestoneTurnInput extends LaneTurnInput {
  wasRolledBack?: boolean;
  skipped?: boolean;
  eligible?: boolean;
}

/**
 * One scored candidate. Every term of `S(n)` is carried separately as well as
 * summed: a retune of `shared/election-weights.ts` is judged by looking at
 * which term moved, and a caller that only wants the order reads `score`.
 */
export interface MilestoneCandidate {
  id: number;
  /** `S(n)` — the whole heuristic, what `candidates` is ordered by. */
  score: number;
  /** Every outgoing logical edge, self-edges included; reads no class at all. */
  outDegree: number;
  /** `Σ_{e ∈ out(n)} w_class(e)` — the claims this node's own edges make. */
  classScore: number;
  /** `rec(n) = 1 − rank_age/|pool|`, zero-based `rank_age`, newest = 1. */
  recency: number;
  /** `type(n)` — the max weight over the node's own `type` words. */
  typeWeight: number;
  order: LaneOrderKey;
  /** `MilestoneTurnInput.createdAtEpoch` — also what the tie-break falls back to for a cross-session `order` tie. `undefined` when the caller never supplied it. */
  epoch: number | undefined;
}

export interface MilestoneElectionResult {
  /**
   * Every ELIGIBLE, non-excluded node, in SCORE order (descending) — NOT
   * display/time order, and never truncated. A graph-only or explicitly
   * ineligible node never appears here, however much it shaped the scores
   * that produced it.
   */
  candidates: readonly MilestoneCandidate[];
  /** Node ids that left candidacy entirely (step 1) — ascending. */
  excluded: readonly number[];
}

interface AgeKey {
  id: number;
  order: LaneOrderKey;
  epoch: number | undefined;
}

/** Newest FIRST — the ordering `rank_age` counts down from (rank 0 = newest). Ties by id desc, so the ranking is total. */
function compareNewestFirst(a: AgeKey, b: AgeKey): number {
  const orderCmp = compareOrderKeyAcrossSessions(
    { order: b.order, createdAtEpoch: b.epoch },
    { order: a.order, createdAtEpoch: a.epoch },
  );
  if (orderCmp !== 0) return orderCmp;
  return b.id - a.id;
}

/**
 * Run the election over one turn/edge set.
 *
 * There is no `budget` and no `parameters` argument any more. `budget` fed
 * the retired tier-④ two-stage fill and nothing else; `parameters` existed
 * only because the seven-to-three re-key could not force `use`'s weight or
 * what declares a convergence, and T2421 closed both questions by deleting
 * the tiers that asked them. Every number the score reads is in
 * `shared/election-weights.ts`.
 */
export function electMilestones(
  turns: readonly MilestoneTurnInput[],
  edges: readonly LaneEdgeInput[],
): MilestoneElectionResult {
  const orderOf = new Map<number, LaneOrderKey>();
  const epochOf = new Map<number, number>();
  const typeOf = new Map<number, readonly string[]>();
  for (const turn of turns) {
    orderOf.set(turn.id, turn.order ?? [0, turn.id]);
    typeOf.set(turn.id, turn.type ?? []);
    if (turn.createdAtEpoch !== undefined) {
      epochOf.set(turn.id, turn.createdAtEpoch);
    }
  }
  const orderFor = (id: number): LaneOrderKey => orderOf.get(id) ?? [0, id];
  const epochFor = (id: number): number | undefined => epochOf.get(id);

  // ---- step 0: eligibility boundary ----
  const eligibleIds = new Set<number>();
  for (const turn of turns) {
    if (turn.eligible !== false) {
      eligibleIds.add(turn.id);
    }
  }

  // ---- step 1: invalid nodes leave candidacy ----
  // Rolled-back / skipped only. NO edge ever removes a node from candidacy,
  // which is why there is deliberately no loop over `edges` here.
  const excluded = new Set<number>();
  for (const turn of turns) {
    if (turn.wasRolledBack === true || turn.skipped === true) {
      excluded.add(turn.id);
    }
  }

  // ---- the two edge-derived terms, over the FULL, unfiltered edge set ----
  // R10-4: an edge to an endpoint OUTSIDE the caller's window is in this
  // universe like any other, so a node's out-degree and class sum do not
  // depend on how wide the caller's window happened to be.
  const outDegree = new Map<number, number>();
  const classScore = new Map<number, number>();
  for (const edge of edges) {
    outDegree.set(edge.citingId, (outDegree.get(edge.citingId) ?? 0) + 1);
    classScore.set(
      edge.citingId,
      (classScore.get(edge.citingId) ?? 0) + electionClassWeight(edge),
    );
  }

  const candidateIds = [...eligibleIds].filter((id) => !excluded.has(id));

  // ---- step 2: the pool's own age ranking, zero-based, newest = 0 ----
  const pool = candidateIds.map((id) => ({
    id,
    order: orderFor(id),
    epoch: epochFor(id),
  }));
  const byAge = [...pool].sort(compareNewestFirst);
  const rankAge = new Map<number, number>();
  byAge.forEach((entry, index) => rankAge.set(entry.id, index));
  const poolSize = pool.length;

  const candidates: MilestoneCandidate[] = pool.map((entry) => {
    const out = outDegree.get(entry.id) ?? 0;
    const claims = classScore.get(entry.id) ?? 0;
    // `poolSize` is never 0 here: `pool` is what we are mapping over.
    const recency = 1 - (rankAge.get(entry.id) ?? 0) / poolSize;
    const typeWeight = electionTypeWeight(typeOf.get(entry.id));
    return {
      id: entry.id,
      score:
        ELECTION_WEIGHTS.outDegree * out +
        claims +
        ELECTION_WEIGHTS.recency * recency +
        ELECTION_WEIGHTS.type * typeWeight,
      outDegree: out,
      classScore: claims,
      recency,
      typeWeight,
      order: entry.order,
      epoch: entry.epoch,
    };
  });

  // Ties: score desc, event order desc, id desc (spec D2).
  candidates.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return compareNewestFirst(a, b);
  });

  return {
    candidates,
    excluded: [...excluded].sort((a, b) => a - b),
  };
}
