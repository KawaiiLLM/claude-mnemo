import { phasesForTypes } from "./turn-phase";

/**
 * Decision-layer FLOW derivation (flow-relations spec, `.scratch/flow-relations/
 * spec.md`, §Structures; ticket 01). A pure function over in-memory arrays —
 * no database, no I/O, no module-level state — because a flow is a DERIVED
 * VIEW, never stored:
 *
 *   - **Flow = a BRANCH of decisions joined by narrows/extends**, not a
 *     connected component. A fork produces separate flows (measured: T900
 *     forks into three, so the T900–T1001 window holds 24 branches where
 *     union-find over the same edges counts 22 components).
 *   - **Settlement (定案) = the branch node nothing further narrows/extends** —
 *     the branch's terminus. An `override` TERMINATES a branch: a terminus
 *     someone overrode is not a settlement, and its flow's settlement set is
 *     empty (measured: T954's branch, killed by T958's override of T957).
 *   - **Delivery and evidence turns hold no flow of their own.** They inherit
 *     membership through the `grounds`/`consume` edges THEY WROTE — inheritance
 *     runs from the cited turn back to the citing one (the reverse of the edge's
 *     stored direction), transitively to a fixpoint. A turn that reaches no
 *     flow this way is HOMELESS.
 *
 * A flow is IDENTIFIED BY ITS TERMINUS (`Flow.id` is the terminus turn id): a
 * branch is exactly the set of decisions that fed one end point, so naming it
 * by anything else (an index, a generated id) would invent an identity the
 * domain does not have — and a derived view must have no identity to corrupt.
 *
 * ## Why the upstream cone, not path enumeration
 *
 * A branch is materialised as "the terminus plus every decision reaching it
 * through narrows/extends". The alternative — enumerating every root→terminus
 * PATH — agrees on all data measured so far (neither the window nor the full
 * production graph has a merge on a forked branch) but is exponential in the
 * number of forks, and a derived view is recomputed on every read. The two
 * differ only when one turn narrows/extends TWO different targets (a MERGE, 2
 * such turns exist DB-wide): the cone reading says the flows merged and the
 * shared terminus names one flow; path enumeration would keep them separate.
 * The spec does not rule that case (narrows/extends "bind to one flow" is
 * definitional, so a merge is itself the anomaly) — the cone reading is chosen
 * for the O(1) flow-per-terminus bound, and it keeps the invariant that a flow
 * has at most ONE settlement candidate.
 *
 * ## Vocabulary
 *
 * Only the four words that carry flow STRUCTURE are read here — `narrows` and
 * `extends` (which build branches), `override` (which kills a terminus), and
 * `grounds`/`consume` (which carry inherited membership). The other words of
 * the eight-word vocabulary are deliberately inert in this module: `collects`
 * is a write-time membership CHECK (it consumes this derivation rather than
 * feeding it) and `verifies`/`refutes` confer no membership at all — an
 * evidence turn adjudicates a claim, it does not join the claim's flow. An
 * unrecognised relation string contributes nothing, the same "unmapped input
 * strengthens nothing" rule `phasesForTypes` applies to a turn's `type` list;
 * this module therefore does NOT re-declare the relation vocabulary, whose one
 * home is the write path.
 */

/** Relations that BUILD a branch. Both ends must be decision-phase turns (definitional, spec's six-row table). */
export const STANCE_RELATIONS: ReadonlySet<string> = new Set(["narrows", "extends"]);

/** The relation that TERMINATES a branch: an overridden terminus settles nothing. */
export const TERMINATING_RELATION = "override";

/** Relations through which a non-decision turn INHERITS the flow of the turn it cites. */
export const INHERITING_RELATIONS: ReadonlySet<string> = new Set(["grounds", "consume"]);

export interface FlowTurnInput {
  /** Turn id, in whatever id space the caller addresses turns by (row id, or a window's prompt numbers). */
  id: number;
  /** The turn's `type` list; its phase set is derived through the shared `turn-phase` table. */
  type: readonly string[];
}

/**
 * One relation edge, in the stored direction: `citingId` is the LATER turn
 * doing the citing, `citedId` its predecessor (`turn-phase.ts`'s direction
 * convention, [S15069/T930]). `relation` is a plain string on purpose — see
 * the module note on vocabulary.
 */
export interface FlowEdgeInput {
  citingId: number;
  citedId: number;
  relation: string;
}

export interface Flow {
  /** The flow's identity IS its terminus — the branch node nothing further narrows/extends. */
  id: number;
  /** Every decision turn reaching the terminus through narrows/extends, terminus included. Ascending. */
  members: number[];
  /**
   * The terminus, or `null` when an `override` terminated the branch — a dead
   * branch keeps its members (they were decided) but settles nothing.
   */
  settlement: number | null;
}

export interface FlowDerivation {
  /** Every branch, ordered by terminus id. */
  flows: Flow[];
  /** Terminus id -> flow, for callers that hold a settlement address. */
  flowById: ReadonlyMap<number, Flow>;
  /**
   * Turn id -> the flow ids it belongs to, ascending: its OWN branches for a
   * decision turn, plus everything inherited through the grounds/consume edges
   * it wrote. Only turns with at least one membership appear.
   */
  flowsByTurn: ReadonlyMap<number, number[]>;
  /** Input turns that reach no flow at all, ascending. */
  homeless: number[];
}

/**
 * Ticket 02 (flow-relations spec): is `turnId` itself a flow's SETTLEMENT —
 * its own branch's terminus, not overridden? `Flow.id` is the terminus id
 * (this module's own identity rule), so a turn is a settlement iff it keys a
 * flow AND that flow's `settlement` equals its own id (the alternative,
 * `settlement === null`, is the dead-branch case: a terminus someone
 * overrode). Used by the write-time self-citation gate — `grounds` is the one
 * relation that may cite the citing turn itself, and only when the citing
 * turn is both a settlement and that settlement's implementer (a phase-set
 * question the caller answers on its own, no derivation needed for that half).
 */
export function isFlowSettlement(derivation: FlowDerivation, turnId: number): boolean {
  return derivation.flowById.get(turnId)?.settlement === turnId;
}

/**
 * Ticket 02: is `turnId` an OWN STRUCTURAL member — never inherited — of the
 * branch terminating at `terminusId`? `collects`' one hard, write-time graph
 * check (the spec's constitutive-interface word, S15069/T1202): the citing
 * turn must itself be `terminusId`, and every target must satisfy this
 * predicate against that same flow. Deliberately reads `Flow.members`
 * (structural cone membership) and never `flowsByTurn` (which also carries
 * INHERITED membership through grounds/consume) — collects' depth is
 * exactly one hop of the branch itself, not the wider inheritance graph.
 */
export function isOwnFlowMember(
  derivation: FlowDerivation,
  terminusId: number,
  turnId: number,
): boolean {
  return derivation.flowById.get(terminusId)?.members.includes(turnId) ?? false;
}

/** The settlement(s) reachable from one turn: the settlements of every flow it belongs to, ascending, deduped. */
export function settlementsOfTurn(derivation: FlowDerivation, turnId: number): number[] {
  const settlements = new Set<number>();
  for (const flowId of derivation.flowsByTurn.get(turnId) ?? []) {
    const settlement = derivation.flowById.get(flowId)?.settlement;
    if (settlement !== null && settlement !== undefined) {
      settlements.add(settlement);
    }
  }
  return [...settlements].sort((a, b) => a - b);
}

function pushInto(index: Map<number, number[]>, key: number, value: number): void {
  const bucket = index.get(key);
  if (bucket === undefined) {
    index.set(key, [value]);
    return;
  }
  bucket.push(value);
}

/**
 * Derive the decision-layer flows of one turn set.
 *
 * Pure and stateless: the result is a SNAPSHOT of the arrays handed in, it
 * shares no structure with them and nothing is memoised anywhere, so "a
 * retraction invalidates the view" needs no invalidation protocol — a caller
 * that changed an edge simply calls this again (spec: flows are derived views,
 * recompute on read).
 *
 * Edges whose endpoints are not both in `turns` are ignored (a caller may pass
 * a window whose edges point outside it); stance edges with a non-decision
 * endpoint are ignored too (P2 — v1 derives the decision layer only), which is
 * a no-op on all production data measured so far.
 */
export function deriveFlows(
  turns: readonly FlowTurnInput[],
  edges: readonly FlowEdgeInput[],
): FlowDerivation {
  const isDecision = new Map<number, boolean>();
  for (const turn of turns) {
    isDecision.set(turn.id, phasesForTypes(turn.type).has("decision"));
  }

  // Branch graph, in the ADVANCE direction (older -> newer): `advance` holds
  // the turns that narrow/extend a node, `retreat` the ones it narrows/extends.
  const advance = new Map<number, number[]>();
  const retreat = new Map<number, number[]>();
  const overridden = new Set<number>();
  const inheritedFrom = new Map<number, number[]>(); // cited turn -> turns that cited it with grounds/consume

  for (const edge of edges) {
    const citingKnown = isDecision.has(edge.citingId);
    const citedKnown = isDecision.has(edge.citedId);
    if (!citingKnown || !citedKnown) continue;
    if (STANCE_RELATIONS.has(edge.relation)) {
      if (!isDecision.get(edge.citingId) || !isDecision.get(edge.citedId)) continue;
      if (edge.citingId === edge.citedId) continue;
      pushInto(advance, edge.citedId, edge.citingId);
      pushInto(retreat, edge.citingId, edge.citedId);
    } else if (edge.relation === TERMINATING_RELATION) {
      overridden.add(edge.citedId);
    } else if (INHERITING_RELATIONS.has(edge.relation)) {
      if (edge.citingId === edge.citedId) continue;
      pushInto(inheritedFrom, edge.citedId, edge.citingId);
    }
  }

  // A terminus is a decision turn nothing further narrows/extends — including
  // a decision turn with no stance edge at all, which is a one-node flow that
  // is its own settlement (spec: every decision turn holds a flow).
  const termini: number[] = [];
  for (const turn of turns) {
    if (!isDecision.get(turn.id)) continue;
    if ((advance.get(turn.id) ?? []).length === 0) termini.push(turn.id);
  }
  termini.sort((a, b) => a - b);

  const flows: Flow[] = [];
  const flowById = new Map<number, Flow>();
  const flowsByTurn = new Map<number, Set<number>>();

  for (const terminus of termini) {
    // The branch = the terminus' upstream cone through narrows/extends. The
    // visited set doubles as cycle protection: stored edges always run
    // newer->older so a cycle should be impossible, but a derived view must
    // not hang on corrupt data.
    const members = new Set<number>([terminus]);
    const stack = [terminus];
    while (stack.length > 0) {
      const node = stack.pop()!;
      for (const previous of retreat.get(node) ?? []) {
        if (members.has(previous)) continue;
        members.add(previous);
        stack.push(previous);
      }
    }
    const flow: Flow = {
      id: terminus,
      members: [...members].sort((a, b) => a - b),
      settlement: overridden.has(terminus) ? null : terminus,
    };
    flows.push(flow);
    flowById.set(terminus, flow);
    for (const member of flow.members) {
      const memberships = flowsByTurn.get(member) ?? new Set<number>();
      memberships.add(terminus);
      flowsByTurn.set(member, memberships);
    }
  }

  // Inheritance: a turn that WROTE a grounds/consume edge takes the flows of
  // the turn it cited — the reverse of the edge's direction — propagated to a
  // fixpoint so a delivery turn resting on another delivery turn still lands.
  // A decision turn inherits too (it keeps its own branch as well): a turn
  // typed both design and implement grounds on the flows it implements, and
  // dropping those would lose exactly the membership a release needs.
  const queue: number[] = [...flowsByTurn.keys()];
  while (queue.length > 0) {
    const cited = queue.pop()!;
    const source = flowsByTurn.get(cited);
    if (source === undefined) continue;
    for (const citing of inheritedFrom.get(cited) ?? []) {
      const target = flowsByTurn.get(citing) ?? new Set<number>();
      let grew = false;
      for (const flowId of source) {
        if (!target.has(flowId)) {
          target.add(flowId);
          grew = true;
        }
      }
      if (grew) {
        flowsByTurn.set(citing, target);
        queue.push(citing);
      }
    }
  }

  const membership = new Map<number, number[]>();
  for (const [turnId, flowIds] of flowsByTurn) {
    membership.set(turnId, [...flowIds].sort((a, b) => a - b));
  }
  const homeless = turns
    .filter((turn) => !membership.has(turn.id))
    .map((turn) => turn.id)
    .sort((a, b) => a - b);

  return { flows, flowById, flowsByTurn: membership, homeless };
}
