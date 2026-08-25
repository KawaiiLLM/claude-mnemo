/**
 * Milestone election v2 — lane-first structural election
 * (`.scratch/milestone-election/spec.md`, ticket 02). Pure derivation over
 * plain arrays, the same "turns + edges in, judged output out" contract
 * `lane-checker.ts` follows: no database, no I/O, no module-level state, no
 * rendering. This module supersedes the effGrade + edge-signal election
 * chain in `mcp/timeline.ts` wholesale (spec's own framing) — but that
 * retirement is out of THIS ticket's territory; this file only adds the new
 * election, it does not touch the old one.
 *
 * ## The election, in one pass over the spec's five steps
 *
 * 0. **Eligibility boundary** (R1 #1, pre-release repair — a gate BEFORE
 *    step 1, not part of it): a node may only ever become a candidate if it
 *    is present in the supplied `turns[]` with `eligible !== false`. An edge
 *    endpoint absent from `turns[]` altogether, or present but explicitly
 *    marked `eligible: false` (the adapters' channel for an EXTERNAL node —
 *    one an OR-scoped edge touches without being a window member itself,
 *    `db/memory-edges.ts`'s `getRelationEdgesAmongTurns` doc comment), is a
 *    GRAPH node but never a CANDIDATE: its own edges still contribute to
 *    every other node's in-/out-degree, it still participates in
 *    `deriveLaneInterpretation`'s reduction (with its REAL `order`/
 *    `createdAtEpoch` whenever the caller supplies them — never a fabricated
 *    `[0, id]`), and its own `indexes` edges can still seed tier ③ for
 *    another node once it is elected. It just never itself seats, never
 *    counts toward the tier-③ stage-1 budget, and never seeds the elected
 *    boundary tier ③ reads. (It can no longer EXCLUDE another node either —
 *    no edge excludes anything now; see step 1.) Every other numbered step
 *    below operates ONLY on this eligible pool.
 * 1. **Invalid nodes leave candidacy** (uniform, within the eligible pool): a
 *    rolled-back turn (`MilestoneTurnInput.wasRolledBack`) or a skipped turn
 *    (`MilestoneTurnInput.skipped`) is rubric-v12's 无效节点 — "a skipped /
 *    rewound turn, all of whose edges are void" — and never seats.
 *
 *    **The REPUDIATION arm of this step is DELETED** (lane-model-v12, ticket
 *    04). A node cited by an UNTAGGED `override` used to leave candidacy
 *    entirely, on the reading that an untagged override was a GLOBAL
 *    repudiation that killed the node. v12 has no node death and no global
 *    repudiation: an untagged override is an unsettled edge, and rubric-v12
 *    says an unsettled edge takes no part in any lane computation at all. So
 *    an overridden node stays an ordinary candidate, ranked by whatever
 *    signal it earns — measured on the live database at deletion time, 21
 *    live turns re-enter candidacy this way (spec D5 said 18; the corpus grew
 *    between the measurement and the ticket). Nothing replaces the arm: there
 *    is no successor rule that reads override edges into candidacy.
 *
 *    Excluded nodes are NOT removed from the graph: their own edges still
 *    contribute to every OTHER node's in-/out-degree, and
 *    `deriveLaneInterpretation` still reduces over the full, unfiltered
 *    input — exclusion only prunes the final CANDIDATE list.
 * 2. **Identity tiers**, computed via `lane-interpretation.ts`'s shared
 *    reduction + its additive `deriveLaneStates` helper — no parallel lane
 *    derivation in this module:
 *      ① untagged-`indexes` writers (cross-lane aggregation — releases);
 *      ② a CLOSED lane's terminus, and nothing else. Ticket 04 deleted BOTH
 *        of this tier's old refinements: the closed lane's own quality
 *        verdict (a closed lane used to seat its terminus only if the lane
 *        still held a living node — node death is gone, so every closed lane
 *        seats its terminus), and the second seat an OPEN lane used to give
 *        its most recent declaring turn. An open lane now seats nobody: v12 has no
 *        reopen mechanism for a lost declaration to be recovered from — a
 *        lane is open exactly when its newest member is not an index, which
 *        says nothing about any earlier declaration;
 *      ③ nodes INDEXED (any tag state) by a tier-①/② node that made the
 *        `budget`-bounded stage-1 cut — a genuine TWO-STAGE fill: stage 1
 *        ranks every tier-①/② candidate and takes the top `budget`; only
 *        THAT "elected" subset's own `indexes` edges grant tier ③, so a
 *        tier-①/② candidate that qualifies but loses the stage-1 cut grants
 *        no tier-③ seats to anyone (spec's own measured case: 913, ownership's
 *        terminus, ranks below budget and so never seeds tier ③ even though
 *        it is itself a legitimate closed lane's terminus, still returned
 *        here at its true tier ②, just ranked low);
 *      ④ correctors — a node that wrote an `override` edge, or that cites
 *        (any relation) a turn with `wasRolledBack: true`;
 *      ⑤ everything else.
 *    `budget` is used ONLY to define this stage-1/"elected" boundary for
 *    tier ③ — it never truncates this module's own return value. The
 *    renderer (ticket 03) decides the final displayed row count, which may
 *    or may not reuse the same number.
 * 3. **Within a tier**: positive in-degree over six words — `narrows`,
 *    `extends`, `consume`, `indexes`, `grounds`, `verifies` — +1 PER EDGE,
 *    self-edges included (no `citingId !== citedId` filter anywhere below;
 *    T1180's self-`grounds` prices a real declared convergence). Ties break
 *    by out-degree (ALL eight relation words, unfiltered). Remaining ties
 *    break by the LATER turn (`LaneOrderKey` compare, never raw `id` alone —
 *    same backfill-safety discipline `lane-interpretation.ts` already
 *    established).
 * 4. **Return shape**: the FULL ordered candidacy (every ELIGIBLE,
 *    non-excluded node — step 0's boundary; a graph-only or explicitly
 *    ineligible node never appears here, however much it shaped the ranking
 *    that produced it), in ELECTION RANK order — tier ascending,
 *    then the within-tier rule above. This is NOT display/time order; a
 *    caller wanting the spec's step-5 "elected rows render in time order"
 *    takes `candidates.slice(0, displayBudget)` and re-sorts that slice by
 *    `order` itself (the renderer's job, ticket 03) — budget CUTTING is
 *    deliberately not this module's concern even though a `budget` number is
 *    one of its own parameters (see point 2 above: that number feeds tier
 *    ③'s internal two-stage fill, a different question from "how many rows
 *    does the UI show").
 * 5. Degradation to recency on an edgeless window needs no special-cased
 *    branch: with zero edges, every surviving node is tier ⑤ with
 *    in-/out-degree 0, so the tier/degree keys of the sort all tie and the
 *    LATER-TURN tiebreak alone decides the order — which IS recency
 *    ordering. `deriveLaneInterpretation` also degrades for free (zero
 *    tagged edges enumerates zero lanes).
 */

import {
  canonicalTagSet,
  compareOrderKeyAcrossSessions,
  deriveLaneInterpretation,
  deriveLaneStates,
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
 * dependency (same reasoning `lane-interpretation.ts`'s own header gives for
 * `canonicalTagSet`). Both default to `false`/absent when omitted — a plain
 * fixture that never marks either simply has nothing rolled back or skipped.
 *
 * R1 #1 (pre-release repair) adds `eligible`, the eligibility-boundary
 * switch (module header, step 0): `false` marks a GRAPH-ONLY entry — real
 * metadata for an edge endpoint the caller's own window does not contain (an
 * EXTERNAL node an OR-scoped edge touches, `db/memory-edges.ts`'s
 * `getRelationEdgesAmongTurns` doc comment). Such an entry still feeds
 * `orderOf`/`rolledBackOf`, still participates in
 * `deriveLaneInterpretation`'s reduction with its REAL `order`/
 * `createdAtEpoch` (never the `[0, id]` fallback), and its own edges still
 * count toward every other node's degree — it is simply never a candidate.
 * Omitted or `true` = eligible, the default every caller that predates this
 * field gets automatically.
 */
export interface MilestoneTurnInput extends LaneTurnInput {
  wasRolledBack?: boolean;
  skipped?: boolean;
  eligible?: boolean;
}

/** The five identity tiers, ascending — tier 1 is the highest ("lexicographic, highest wins"). */
export type MilestoneTier = 1 | 2 | 3 | 4 | 5;

/** Ticket 04 narrowed tier ②'s vocabulary to ONE reason: the old quality-qualified terminus reason lost its qualifier, and the reason naming an open lane's most recent declaring turn disappeared with that seat. */
export type MilestoneTierReason =
  | "release"
  | "closed-terminus"
  | "indexed-by-elected"
  | "corrector"
  | "other";

export interface MilestoneCandidate {
  id: number;
  tier: MilestoneTier;
  /** Which tier-qualification rule produced `tier` — informational; `tier` itself is what election rank reads. */
  reason: MilestoneTierReason;
  /** Positive in-degree, six words, self-edges included (point 3 above). */
  inDegree: number;
  /** Out-degree, all eight relation words, self-edges included. */
  outDegree: number;
  order: LaneOrderKey;
  /** `MilestoneTurnInput.createdAtEpoch`, informational — also what `rankCompare` falls back to for a cross-session `order` tie (R1 #6). `undefined` when the caller never supplied it. */
  epoch: number | undefined;
}

export interface MilestoneElectionResult {
  /**
   * Every ELIGIBLE, non-excluded node (module header step 0: a `turns[]`
   * entry with `eligible !== false`), in ELECTION RANK order (tier
   * ascending, then the within-tier rule) — NOT display/time order. A
   * graph-only or explicitly ineligible node never appears here, however
   * much it shaped the ranking that produced it (R1 #1). Budget cutting and
   * time-order display are the renderer's job (ticket 03); this array is
   * never truncated to `budget`.
   */
  candidates: readonly MilestoneCandidate[];
  /** Node ids that left candidacy entirely (step 1) — ascending. */
  excluded: readonly number[];
}

/** The spec's "six words" — positive in-degree domain. `override`/`refutes` stay out of it (they are corrections, not endorsements), but they are no longer candidacy killers either: ticket 04 deleted the repudiation arm entirely. */
const IN_DEGREE_RELATIONS: ReadonlySet<string> = new Set([
  "narrows",
  "extends",
  "consume",
  "indexes",
  "grounds",
  "verifies",
]);

interface RankKey {
  tier: MilestoneTier;
  inDegree: number;
  outDegree: number;
  order: LaneOrderKey;
  /** R1 #6: carried alongside `order` so the tie-break can fall back to wall-clock time for a cross-session pair — see `rankCompare`. */
  epoch: number | undefined;
  id: number;
}

/**
 * Tier ascending, then in-degree desc, then out-degree desc, then the LATER
 * turn wins, then id desc as a final deterministic fallback. R1 #6: the
 * order tie-break itself is cross-session-aware — `compareOrderKeyAcrossSessions`
 * falls back to `createdAtEpoch` for a pair from different sessions (the
 * `order[0]` session-id half carries no wall-clock meaning across sessions,
 * the same "tuple-order trap" `lane-checker.ts`'s report-4(c)
 * `computeTimeOrderViolations` already avoids) rather than the raw tuple
 * `compareOrderKey` alone would use.
 */
function rankCompare(a: RankKey, b: RankKey): number {
  if (a.tier !== b.tier) return a.tier - b.tier;
  if (a.inDegree !== b.inDegree) return b.inDegree - a.inDegree;
  if (a.outDegree !== b.outDegree) return b.outDegree - a.outDegree;
  const orderCmp = compareOrderKeyAcrossSessions(
    { order: b.order, createdAtEpoch: b.epoch },
    { order: a.order, createdAtEpoch: a.epoch },
  ); // later order sorts first
  if (orderCmp !== 0) return orderCmp;
  return b.id - a.id;
}

/**
 * Run the election over one turn/edge set. `budget` bounds the tier-③
 * two-stage fill's "elected ①②" boundary only (point 2 above) — it never
 * truncates the returned `candidates` array.
 *
 * `rolledBackCiterIds` (R1 #7, optional, default none): ids — already known
 * to be real, eligible turns — that cite (any relation) a rolled-back turn
 * whose own edge `getRelationEdgesAmongTurns` never surfaces into `edges` at
 * all (its live-turn-scoped SQL requires BOTH endpoints live, and a
 * rolled-back cited turn fails that outright). This is the adapter's own
 * separate channel (`db/memory-edges.ts`'s `getRolledBackCiterIds`) for a
 * fact `edges` structurally cannot carry. Every id here becomes a tier-④
 * corrector outright, exactly as if its own citing edge had been visible.
 */
export function electMilestones(
  turns: readonly MilestoneTurnInput[],
  edges: readonly LaneEdgeInput[],
  budget: number,
  rolledBackCiterIds: readonly number[] = [],
): MilestoneElectionResult {
  const orderOf = new Map<number, LaneOrderKey>();
  const rolledBackOf = new Map<number, boolean>();
  const epochOf = new Map<number, number>();
  for (const turn of turns) {
    orderOf.set(turn.id, turn.order ?? [0, turn.id]);
    rolledBackOf.set(turn.id, turn.wasRolledBack === true);
    if (turn.createdAtEpoch !== undefined) {
      epochOf.set(turn.id, turn.createdAtEpoch);
    }
  }
  const orderFor = (id: number): LaneOrderKey => orderOf.get(id) ?? [0, id];
  const epochFor = (id: number): number | undefined => epochOf.get(id);

  // ---- step 0: eligibility boundary (R1 #1) — candidates are drawn
  // exclusively from `turns[]` entries with `eligible !== false`; an edge
  // endpoint absent from `turns[]`, or explicitly marked ineligible, is a
  // graph node (feeds the maps above and the degree/reduction passes below)
  // but never a candidate. ----
  const eligibleIds = new Set<number>();
  for (const turn of turns) {
    if (turn.eligible !== false) {
      eligibleIds.add(turn.id);
    }
  }

  // ---- step 1: invalid nodes leave candidacy ----
  // Rolled-back / skipped only. NO edge ever removes a node from candidacy:
  // the untagged-override repudiation arm is deleted (ticket 04, module
  // header step 1) and nothing took its place — there is deliberately no
  // loop over `edges` here.
  const excluded = new Set<number>();
  for (const turn of turns) {
    if (turn.wasRolledBack === true || turn.skipped === true) {
      excluded.add(turn.id);
    }
  }

  // ---- degree tallies over the FULL, unfiltered edge set ----
  const inDegree = new Map<number, number>();
  const outDegree = new Map<number, number>();
  for (const edge of edges) {
    if (IN_DEGREE_RELATIONS.has(edge.relation)) {
      inDegree.set(edge.citedId, (inDegree.get(edge.citedId) ?? 0) + 1);
    }
    outDegree.set(edge.citingId, (outDegree.get(edge.citingId) ?? 0) + 1);
  }

  // ---- tier ① — untagged-indexes writers ----
  const tier1 = new Set<number>();
  for (const edge of edges) {
    if (edge.relation === "indexes" && canonicalTagSet(edge.tags).length === 0) {
      tier1.add(edge.citingId);
    }
  }

  // ---- tier ② — CLOSED lanes' termini — via the shared lane-state helper, no parallel derivation ----
  // One seat, one rule. An OPEN lane seats nobody — the second seat this
  // loop used to hand an open lane's most recent declaring turn is deleted
  // (ticket 04), so there is deliberately no `else` branch here.
  const { lanes } = deriveLaneInterpretation(turns, edges);
  const laneStates = deriveLaneStates(lanes);
  const tier2 = new Map<number, MilestoneTierReason>();
  for (const state of laneStates.values()) {
    if (state.closure === "closed" && state.terminus !== null && !tier2.has(state.terminus)) {
      tier2.set(state.terminus, "closed-terminus");
    }
  }

  // R1 #1: `eligibleIds`, never `allIds` (the old union with every edge
  // endpoint) — an edge-only or explicitly ineligible node must never reach
  // this list, however qualified its tier signal looks.
  const candidateIds = [...eligibleIds].filter((id) => !excluded.has(id));

  const toRankKey = (id: number, tier: MilestoneTier): RankKey => ({
    tier,
    inDegree: inDegree.get(id) ?? 0,
    outDegree: outDegree.get(id) ?? 0,
    order: orderFor(id),
    epoch: epochFor(id),
    id,
  });

  // ---- stage 1: tier ①/② candidates, ranked ----
  const stage1: MilestoneCandidate[] = [];
  for (const id of candidateIds) {
    let tier: MilestoneTier | undefined;
    let reason: MilestoneTierReason = "other";
    if (tier1.has(id)) {
      tier = 1;
      reason = "release";
    } else if (tier2.has(id)) {
      tier = 2;
      reason = tier2.get(id)!;
    }
    if (tier === undefined) continue;
    stage1.push({ ...toRankKey(id, tier), reason });
  }
  stage1.sort(rankCompare);

  // ---- the stage-1/"elected" boundary tier ③ reads (budget-bounded, never a truncation of THIS module's return) ----
  const electedIds = new Set(stage1.slice(0, Math.max(0, budget)).map((c) => c.id));

  // ---- tier ③ — indexed by an elected ①/② node (any tag state) ----
  const indexedByElected = new Set<number>();
  for (const edge of edges) {
    if (edge.relation === "indexes" && electedIds.has(edge.citingId)) {
      indexedByElected.add(edge.citedId);
    }
  }

  // ---- tier ④ — correctors: override writers, or citers (any relation) of a rolled-back turn ----
  const correctors = new Set<number>();
  for (const edge of edges) {
    if (edge.relation === "override") {
      correctors.add(edge.citingId);
    }
    if (rolledBackOf.get(edge.citedId) === true) {
      correctors.add(edge.citingId);
    }
  }
  // R1 #7: the adapter's own separate fetch for the fact `edges` cannot
  // structurally carry (see this function's own doc comment) — folded in
  // exactly like an edge-derived corrector, no tier distinction.
  for (const id of rolledBackCiterIds) {
    correctors.add(id);
  }

  const stage1Ids = new Set(stage1.map((c) => c.id));
  const rest: MilestoneCandidate[] = [];
  for (const id of candidateIds) {
    if (stage1Ids.has(id)) continue; // already tier ①/② — the best tier already wins
    let tier: MilestoneTier;
    let reason: MilestoneTierReason;
    if (indexedByElected.has(id)) {
      tier = 3;
      reason = "indexed-by-elected";
    } else if (correctors.has(id)) {
      tier = 4;
      reason = "corrector";
    } else {
      tier = 5;
      reason = "other";
    }
    rest.push({ ...toRankKey(id, tier), reason });
  }
  rest.sort(rankCompare);

  return {
    candidates: [...stage1, ...rest],
    excluded: [...excluded].sort((a, b) => a - b),
  };
}
