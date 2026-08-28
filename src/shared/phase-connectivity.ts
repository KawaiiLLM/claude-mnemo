/**
 * Phase connectivity (phase-connectivity ticket 01, USER RULING
 * [S15069/T1945][S15069/T1947][S15069/T1951]): settlement's SECOND
 * connectivity law, independent of the lane rule ticket 02 upgrades.
 *
 * THE PREDICATE (peer-corrected — module doc restates the ticket's own
 * wording rather than paraphrasing it, since the wording is load-bearing): a
 * live, landing-only node passes iff a DIRECTED walk along its OUT-edges
 * (citing -> cited, the graph's one direction) over commit-valid edges
 * reaches ANY basis-type node, at any depth, crossing lanes and tasks
 * freely. A compound node (landing + basis words in its own type) passes at
 * zero hops.
 *
 * TYPE SETS ARE RAW-TYPE SET MEMBERSHIP, NEVER `TYPE_PHASE`/`phasesForTypes`
 * (`turn-phase.ts`) — that table maps discuss -> decision and
 * review/ops/delegate -> delivery, which would let `implement+discuss`
 * self-pass (an ops/delegate/discuss turn contributes no phase a landing
 * turn could borrow at all, but `phasesForTypes` would still fold `review`
 * into "delivery" beside `implement`, erasing the very distinction this
 * predicate exists to keep). This module reads `type` arrays directly and
 * never imports `turn-phase.ts`'s phase table.
 *
 * DRAFT/E6-INVALID EDGES DO NOT CARRY (ticket 01's own text): the walk's
 * domain is edges whose BOTH lane-tag sides are settled — `db/basis-
 * reachability-load.ts` is what enforces that at the load boundary, so this
 * module never has to re-check a side tag; every edge in a
 * `PhaseConnectivityGraph` this module is handed is already commit-valid.
 *
 * PURE: no database, no I/O. `db/basis-reachability-load.ts` is the only
 * place that touches storage, translating rows into the two lookup maps this
 * module walks.
 */

const LANDING_TYPES: ReadonlySet<string> = new Set(["implement", "fix", "refactor"]);
const BASIS_TYPES: ReadonlySet<string> = new Set([
  "design",
  "correction",
  "measure",
  "research",
  "review",
]);

export function isLandingTypeSet(types: readonly string[]): boolean {
  return types.some((word) => LANDING_TYPES.has(word));
}

export function isBasisTypeSet(types: readonly string[]): boolean {
  return types.some((word) => BASIS_TYPES.has(word));
}

/** The basis words a type list carries, ascending — `[]` when none. */
export function basisWordsIn(types: readonly string[]): string[] {
  return types.filter((word) => BASIS_TYPES.has(word)).sort();
}

export { LANDING_TYPES, BASIS_TYPES };

export interface PhaseConnectivityOutEdge {
  citedId: number;
  relation: string;
}

/** turnId -> its live type list, as loaded (`db/basis-reachability-load.ts`). Absence means "not loaded" (never fabricated as `[]`). */
export type PhaseConnectivityTypeLookup = ReadonlyMap<number, readonly string[]>;

/** turnId -> its live, commit-valid out-edges (citing -> cited; one of the seven words; both lane-tag sides settled). Absence means "no out-edges were loaded for this node" — the loader's own fixpoint-load boundary, not a claim the node has none in the live database beyond it. */
export type PhaseConnectivityGraph = ReadonlyMap<number, readonly PhaseConnectivityOutEdge[]>;

/**
 * `"unresolved-at-cap"` (phase-connectivity ticket 06, decision 2) is NOT a
 * violation: it means the walk ran out of depth budget before it could
 * establish either a basis or a genuine dead end. `"unreached"` is reserved
 * for a walk whose frontier emptied ON ITS OWN — every reachable node was
 * visited and none carried a basis word — which is the only case a caller
 * may count against the violation total.
 */
export type PhaseConnectivityOutcome = "compound" | "reached" | "unreached" | "unresolved-at-cap";

export interface PhaseConnectivityFinding {
  turnId: number;
  outcome: PhaseConnectivityOutcome;
  /** Hops from `turnId` to `basisTurnId`; `0` for a compound self-pass; `null` when unreached or unresolved-at-cap. */
  hops: number | null;
  /** The basis-typed node the walk landed on; `turnId` itself for a compound pass; `null` when unreached or unresolved-at-cap. */
  basisTurnId: number | null;
  /** The (alphabetically first, when several) basis word the resolving node carries; `null` when unreached or unresolved-at-cap. */
  basisWord: string | null;
  /** The walked path `[turnId, …, basisTurnId]` inclusive; `[turnId]` for a compound pass; `[]` when unreached or unresolved-at-cap. */
  path: readonly number[];
}

/**
 * Defensive depth ceiling only — the BFS below is already cycle-safe via its
 * own `visited` set, so "any depth" is honoured up to this bound. A walk
 * that would need more (a live chain longer than 500 directed hops) reports
 * `"unresolved-at-cap"` (ticket 06, decision 2) rather than hanging AND
 * rather than being counted as an established violation it never actually
 * established — the walk simply never got far enough to know. No real
 * settlement window has come close (measured paths are 1-2 hops); this
 * exists so a corrupt or adversarial graph cannot spin the checker.
 */
const MAX_WALK_DEPTH = 500;

/** One landing turn's own verdict — the whole predicate, for one node. */
export function evaluateTurnPhaseConnectivity(
  turnId: number,
  types: PhaseConnectivityTypeLookup,
  graph: PhaseConnectivityGraph,
): PhaseConnectivityFinding {
  const ownTypes = types.get(turnId) ?? [];
  const ownBasis = basisWordsIn(ownTypes)[0];
  if (ownBasis !== undefined) {
    return {
      turnId,
      outcome: "compound",
      hops: 0,
      basisTurnId: turnId,
      basisWord: ownBasis,
      path: [turnId],
    };
  }

  // Directed BFS, out-edges only, ALL SEVEN words (the loader already
  // narrowed `graph` to the seven-word, non-draft domain — this module adds
  // no second relation filter). `visited` is the cycle guard: a node is
  // enqueued at most once, so a cyclic graph terminates instead of looping.
  const visited = new Set<number>([turnId]);
  const previous = new Map<number, number>();
  let frontier: number[] = [turnId];
  let hops = 0;
  while (frontier.length > 0 && hops < MAX_WALK_DEPTH) {
    hops += 1;
    const nextFrontier: number[] = [];
    for (const node of frontier) {
      const outEdges = graph.get(node) ?? [];
      for (const edge of outEdges) {
        if (visited.has(edge.citedId)) continue;
        visited.add(edge.citedId);
        previous.set(edge.citedId, node);
        const citedTypes = types.get(edge.citedId) ?? [];
        const basisWord = basisWordsIn(citedTypes)[0];
        if (basisWord !== undefined) {
          const path: number[] = [edge.citedId];
          let cursor = edge.citedId;
          while (cursor !== turnId) {
            const step = previous.get(cursor)!;
            path.push(step);
            cursor = step;
          }
          path.reverse();
          return {
            turnId,
            outcome: "reached",
            hops,
            basisTurnId: edge.citedId,
            basisWord,
            path,
          };
        }
        nextFrontier.push(edge.citedId);
      }
    }
    frontier = nextFrontier;
  }
  // The loop above exits two ways: the frontier emptied on its own (a
  // genuine, established dead end — `"unreached"`), or `hops` hit the cap
  // while nodes it never got to expand were still queued (`frontier` is
  // still non-empty) — the walk ran out of budget, not out of graph, so this
  // is `"unresolved-at-cap"`, never a violation (ticket 06, decision 2).
  if (hops === MAX_WALK_DEPTH && frontier.length > 0) {
    return { turnId, outcome: "unresolved-at-cap", hops: null, basisTurnId: null, basisWord: null, path: [] };
  }
  return { turnId, outcome: "unreached", hops: null, basisTurnId: null, basisWord: null, path: [] };
}

/** Every landing turn's verdict, ascending by `turnId` — a pure function of the two lookups. */
export function evaluatePhaseConnectivity(
  landingTurnIds: readonly number[],
  types: PhaseConnectivityTypeLookup,
  graph: PhaseConnectivityGraph,
): PhaseConnectivityFinding[] {
  return [...landingTurnIds]
    .sort((a, b) => a - b)
    .map((turnId) => evaluateTurnPhaseConnectivity(turnId, types, graph));
}

export interface PhaseConnectivityRetype {
  /** The (alphabetically first, when several) basis word this write ADDED. */
  basisWord: string;
}

/**
 * Ticket 01 "Compound-retype is not a free pass": does this write turn a
 * landing-only turn (`oldTypes`) into a compound one by ADDING a basis word
 * absent from `oldTypes`? `null` for every other write (not landing-only to
 * begin with, or the retype adds no new basis word) — a caller that already
 * carries a basis word and merely reorders/re-asserts its type list, or a
 * landing turn whose type write adds no basis word at all, owes no audit
 * record.
 */
export function detectCompoundRetype(
  oldTypes: readonly string[],
  newTypes: readonly string[],
): PhaseConnectivityRetype | null {
  const wasLandingOnly = isLandingTypeSet(oldTypes) && !isBasisTypeSet(oldTypes);
  if (!wasLandingOnly) {
    return null;
  }
  const oldSet = new Set(oldTypes);
  const added = basisWordsIn(newTypes).filter((word) => !oldSet.has(word));
  if (added.length === 0) {
    return null;
  }
  return { basisWord: added[0]! };
}
