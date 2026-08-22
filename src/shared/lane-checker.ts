/**
 * v10 lane-model FOUR-REPORT CHECKER (rubric-v10 ticket 05; issue's "Report
 * domains" paragraph, T1300/T1321/T1323). Built on `lane-interpretation.ts`'s
 * pure enumeration/reduction — this module adds the four report shapes and
 * nothing else: no rendering, no candidate-edge suggestions, no advisory
 * text. Numbers, names, states only; the CLI/settlement-tool renderers
 * (ticket 06) are the only consumers that turn this into prose or a digraph.
 *
 * ## Report domains — three distinct participations, per word
 *
 * Reports 2/3 build their graph from **stance + consume + grounds** edges
 * only. `indexes` (aggregation) and `verifies`/`refutes` (testimony
 * adjudicates, it does not join) never enter component analysis — and
 * neither does `override`: an override edge is a graph-STATE event (read by
 * `lane-interpretation.ts`'s reduction), not a structural join, so it is
 * deliberately excluded from `LANE_COMPONENT_RELATIONS` even though it sits
 * same-phase alongside the words that are included. `STANCE_RELATIONS` is
 * imported from `flows.ts` rather than redeclared — the same two words mean
 * the same thing in both modules.
 *
 * Report 4 counts NODE paths (parallel relations on one pair are ONE route,
 * the T1241 precedent — enforced by de-duplicating the adjacency into a
 * `Set` per source node) over the lane's own tagged stance/consume edges
 * (`indexes` excluded — a declaration is not a step of the path). The
 * cross-phase fold splits by word: `grounds` citations fold in and count
 * toward path multiplicity; `verifies`/`refutes` citations participate as
 * cited-ness FACTS (report 1, `citedness`) and coupling display but never
 * add to path counts (duplicate probes are legal fact multiplicity, not
 * extra routes).
 *
 * PROVABLE INVARIANT (worth knowing before reading `buildPathReport`): a
 * folded grounds edge is added `citingId(external) -> citedId(member)`, and
 * "citing nodes included" only ever grants the EXTERNAL node a new outgoing
 * entry — never the member (a fold edge never touches a member's own
 * out-set), and the fold's own membership filter (`citer must be a
 * non-member`) means no member's out-set can transitively reach that
 * external node either. `countPaths` only sums over a node's OUTGOING
 * edges, so a folded external node is structurally UNREACHABLE from the
 * terminus's own traversal — folding can add entries to `citingTurnsFolded`
 * but can never change `pathCount` for ANY input, only prove it stayed
 * stable under the wider graph. This matches every declared lane in the
 * golden corpus (folded pathCount === base pathCount, all equal to 1) and is
 * the only reading consistent with those pinned numbers: the alternative —
 * reversing the fold edge to `member -> external` (mirroring `flows.ts`'s
 * inheritance-reversal precedent for `grounds`/`consume`/`indexes`) — would
 * have moved `{ownership}`'s folded count from 1 to 2, contradicting the
 * ticket's own pinned value, so that reversed reading is deliberately NOT
 * used here.
 *
 * Cited-ness (report 1) is LANE-WIDE, not terminus-only: an incoming
 * cross-phase `grounds`/`verifies`/`refutes` counts if its target is ANY
 * lane member, because a post-declaration settlement can be grounded
 * mid-member rather than at the terminus itself (the golden corpus's
 * `{ownership}`: T936 `grounds` T910, a member but not the T913 terminus —
 * a terminus-only reading would report this lane as never cited at all).
 * "From non-members" already excludes self-citation as a degenerate case: a
 * member citing itself is trivially cited by a member, so it can never pass
 * the "citing turn is NOT a lane member" filter.
 */

import { STANCE_RELATIONS } from "./flows";
import {
  canonicalTagSet,
  deriveLaneInterpretation,
  type Lane,
  type LaneDeclaration,
  type LaneEdgeInput,
  type LaneKey,
  type LaneMember,
  type LaneTurnInput,
  type TurnPhase,
} from "./lane-interpretation";
import { phasesForTypes } from "./turn-phase";

export type {
  LaneDeclaration,
  LaneDeclarationState,
  LaneEdgeInput,
  LaneKey,
  LaneMember,
  LaneTurnInput,
} from "./lane-interpretation";
export { DEFAULT_SEGMENT } from "./lane-interpretation";

/** Reports 2/3's graph: stance (narrows/extends) + consume + grounds ONLY — see module header. Undirected. */
export const LANE_COMPONENT_RELATIONS: ReadonlySet<string> = new Set([
  ...STANCE_RELATIONS,
  "consume",
  "grounds",
]);

/** Report 4's base (unfolded) path graph: the lane's own tagged stance/consume edges — `indexes` excluded. */
export const LANE_PATH_RELATIONS: ReadonlySet<string> = new Set([...STANCE_RELATIONS, "consume"]);

// ---------------------------------------------------------------- Report 1

export interface LaneCitedFact {
  citingId: number;
  citedId: number;
}

export interface LaneTestimonyFact extends LaneCitedFact {
  relation: "verifies" | "refutes";
}

export interface LaneCoverage {
  status: "whole" | "partial";
  /** Member ids that appear as a tagged edge's endpoint but have no entry in the input `turns` array — the signal that the caller's projection was truncated (`lane-interpretation.ts` never drops such members, it just cannot resolve their `type`). */
  missingTurnIds: number[];
}

export interface LaneStatsReport {
  key: LaneKey;
  /** Union of `phasesForTypes` over every member (dead included — phase is a typological fact about the turn, independent of override status). Normally one entry; more than one is itself a finding (a lane's members should share a phase, draft: "lane 不跨相位"). */
  phases: TurnPhase[];
  members: readonly LaneMember[];
  /** Tally of this lane's OWN tagged edges by relation word. */
  edgeCountsByRelation: Record<string, number>;
  declaration: LaneDeclaration;
  citedness: {
    groundsFromNonMembers: LaneCitedFact[];
    testimonyFromNonMembers: LaneTestimonyFact[];
  };
  coverage: LaneCoverage;
}

// ---------------------------------------------------------------- Report 2

export interface LaneIsland {
  /** Smallest lane-member id in this global component — a deterministic, locally meaningful stand-in rather than dumping the whole (possibly large) component. */
  representative: number;
  /** This lane's own members that fall in the island, ascending. */
  memberIds: number[];
}

export interface LaneComponentReport {
  key: LaneKey;
  /** Distinct global components the lane's members (dead included) touch. Healthy = 1 (principle 1). */
  componentCount: number;
  islands: LaneIsland[];
}

// ---------------------------------------------------------------- Report 3

export interface MultiLaneComponent {
  /** Smallest turn id in the shared global component. */
  representative: number;
  lanes: LaneKey[];
}

// ---------------------------------------------------------------- Report 4

export interface LaneFoldedPaths {
  /** External (non-member) citing turns whose cross-phase `grounds` citation of a lane member was folded in. */
  citingTurnsFolded: number[];
  pathCount: number;
}

export interface LanePathReport {
  key: LaneKey;
  status: "ok" | "skipped";
  /** Present iff `status === "skipped"`. */
  skipReason?: "undeclared" | "reopened";
  /** Nodes with no outgoing edge in the lane's structural graph — potentially several (a fork shares one; "multi-start sums"). */
  starts: number[];
  terminus: number | null;
  /** `null` iff skipped. */
  pathCount: number | null;
  /** `null` iff skipped — folding a lane with no terminus has nothing to count paths TO. */
  folded: LaneFoldedPaths | null;
}

// -------------------------------------------------------------------------

export interface LaneCheckerResult {
  lanes: LaneStatsReport[];
  components: LaneComponentReport[];
  multiLaneComponents: MultiLaneComponent[];
  paths: LanePathReport[];
}

/** Union-find, path-compressed — local to one `checkLanes` call, shared across reports 2/3. */
class UnionFind {
  private readonly parent = new Map<number, number>();

  add(id: number): void {
    if (!this.parent.has(id)) {
      this.parent.set(id, id);
    }
  }

  find(id: number): number {
    const parent = this.parent.get(id);
    if (parent === undefined) {
      this.parent.set(id, id);
      return id;
    }
    if (parent === id) {
      return id;
    }
    const root = this.find(parent);
    this.parent.set(id, root);
    return root;
  }

  union(a: number, b: number): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) {
      this.parent.set(rootA, rootB);
    }
  }
}

/** Count NODE paths from `terminus` to any node in `starts`, over `out` (citing -> Set<cited>, already deduplicated per source — "parallel relations on one pair are one route"). Cycle-guarded: corrupt cyclic input contributes 0 from the cycle rather than hanging (`flows.ts`'s "a derived view must not hang on corrupt data" value). */
function countPaths(terminus: number, starts: ReadonlySet<number>, out: ReadonlyMap<number, ReadonlySet<number>>): number {
  const memo = new Map<number, number>();
  const inProgress = new Set<number>();
  const count = (node: number): number => {
    if (starts.has(node)) {
      return 1;
    }
    const cached = memo.get(node);
    if (cached !== undefined) {
      return cached;
    }
    if (inProgress.has(node)) {
      return 0;
    }
    inProgress.add(node);
    let sum = 0;
    for (const next of out.get(node) ?? []) {
      sum += count(next);
    }
    inProgress.delete(node);
    memo.set(node, sum);
    return sum;
  };
  return count(terminus);
}

interface PathGraph {
  starts: Set<number>;
  out: Map<number, Set<number>>;
}

function buildPathGraph(edgePairs: Iterable<readonly [number, number]>): PathGraph {
  const out = new Map<number, Set<number>>();
  const nodes = new Set<number>();
  for (const [citingId, citedId] of edgePairs) {
    nodes.add(citingId);
    nodes.add(citedId);
    let bucket = out.get(citingId);
    if (bucket === undefined) {
      bucket = new Set<number>();
      out.set(citingId, bucket);
    }
    bucket.add(citedId);
  }
  const starts = new Set<number>();
  for (const node of nodes) {
    if ((out.get(node)?.size ?? 0) === 0) {
      starts.add(node);
    }
  }
  return { starts, out };
}

/**
 * Run all four reports over one turn/edge set. Pure: no database, no I/O, no
 * write path imported — the DB adapter (ticket 06) is the only place this
 * touches storage, by translating rows into `LaneTurnInput`/`LaneEdgeInput`
 * and calling this function.
 */
export function checkLanes(
  turns: readonly LaneTurnInput[],
  edges: readonly LaneEdgeInput[],
): LaneCheckerResult {
  const { lanes } = deriveLaneInterpretation(turns, edges);
  const turnById = new Map<number, LaneTurnInput>();
  for (const turn of turns) {
    turnById.set(turn.id, turn);
  }

  // ---- shared global graph for reports 2/3 ----
  const uf = new UnionFind();
  for (const turn of turns) {
    uf.add(turn.id);
  }
  for (const edge of edges) {
    uf.add(edge.citingId);
    uf.add(edge.citedId);
    if (LANE_COMPONENT_RELATIONS.has(edge.relation)) {
      uf.union(edge.citingId, edge.citedId);
    }
  }

  const laneStats: LaneStatsReport[] = [];
  const componentReports: LaneComponentReport[] = [];
  const pathReports: LanePathReport[] = [];
  const componentLanes = new Map<number, LaneKey[]>();

  for (const lane of lanes) {
    const memberIds = new Set(lane.members.map((member) => member.id));

    // ---- Report 1 ----
    laneStats.push(buildLaneStats(lane, memberIds, turnById, edges));

    // ---- Report 2 (and feeding report 3) ----
    const islandsByRoot = new Map<number, number[]>();
    for (const id of memberIds) {
      const root = uf.find(id);
      const bucket = islandsByRoot.get(root);
      if (bucket === undefined) {
        islandsByRoot.set(root, [id]);
      } else {
        bucket.push(id);
      }
      const laneKeyList = componentLanes.get(root);
      if (laneKeyList === undefined) {
        componentLanes.set(root, [lane.key]);
      } else if (!laneKeyList.some((key) => sameLaneKey(key, lane.key))) {
        laneKeyList.push(lane.key);
      }
    }
    const islands: LaneIsland[] = [...islandsByRoot.entries()]
      .map(([, ids]) => {
        const sorted = ids.sort((a, b) => a - b);
        return { representative: sorted[0]!, memberIds: sorted };
      })
      .sort((a, b) => a.representative - b.representative);
    componentReports.push({ key: lane.key, componentCount: islands.length, islands });

    // ---- Report 4 ----
    pathReports.push(buildPathReport(lane, memberIds, edges));
  }

  const multiLaneComponents: MultiLaneComponent[] = [...componentLanes.entries()]
    .filter(([, laneKeys]) => laneKeys.length > 1)
    .map(([representative, laneKeys]) => ({ representative, lanes: laneKeys }))
    .sort((a, b) => a.representative - b.representative);

  return { lanes: laneStats, components: componentReports, multiLaneComponents, paths: pathReports };
}

function sameLaneKey(a: LaneKey, b: LaneKey): boolean {
  return a.segment === b.segment && a.tagSet.join("") === b.tagSet.join("");
}

function buildLaneStats(
  lane: Lane,
  memberIds: ReadonlySet<number>,
  turnById: ReadonlyMap<number, LaneTurnInput>,
  allEdges: readonly LaneEdgeInput[],
): LaneStatsReport {
  const phases = new Set<TurnPhase>();
  for (const member of lane.members) {
    const turn = turnById.get(member.id);
    if (turn === undefined) {
      continue;
    }
    for (const phase of phasesForTypes(turn.type)) {
      phases.add(phase);
    }
  }

  const edgeCountsByRelation: Record<string, number> = {};
  for (const edge of lane.taggedEdges) {
    edgeCountsByRelation[edge.relation] = (edgeCountsByRelation[edge.relation] ?? 0) + 1;
  }

  const groundsFromNonMembers: LaneCitedFact[] = [];
  const testimonyFromNonMembers: LaneTestimonyFact[] = [];
  for (const edge of allEdges) {
    if (!memberIds.has(edge.citedId) || memberIds.has(edge.citingId)) {
      continue; // lane-wide over the WHOLE input, "from non-members" excludes self-cite for free
    }
    if (edge.relation === "grounds") {
      groundsFromNonMembers.push({ citingId: edge.citingId, citedId: edge.citedId });
    } else if (edge.relation === "verifies" || edge.relation === "refutes") {
      testimonyFromNonMembers.push({ citingId: edge.citingId, citedId: edge.citedId, relation: edge.relation });
    }
  }

  const missingTurnIds = [...memberIds].filter((id) => !turnById.has(id)).sort((a, b) => a - b);

  return {
    key: lane.key,
    phases: [...phases],
    members: lane.members,
    edgeCountsByRelation,
    declaration: lane.declaration,
    citedness: { groundsFromNonMembers, testimonyFromNonMembers },
    coverage: { status: missingTurnIds.length > 0 ? "partial" : "whole", missingTurnIds },
  };
}

function buildPathReport(
  lane: Lane,
  memberIds: ReadonlySet<number>,
  allEdges: readonly LaneEdgeInput[],
): LanePathReport {
  const structuralPairs: Array<readonly [number, number]> = lane.taggedEdges
    .filter((edge) => LANE_PATH_RELATIONS.has(edge.relation))
    .map((edge) => [edge.citingId, edge.citedId] as const);
  const baseGraph = buildPathGraph(structuralPairs);

  if (lane.declaration.state !== "declared" || lane.declaration.terminus === null) {
    return {
      key: lane.key,
      status: "skipped",
      skipReason: lane.declaration.state === "reopened" ? "reopened" : "undeclared",
      starts: [...baseGraph.starts].sort((a, b) => a - b),
      terminus: null,
      pathCount: null,
      folded: null,
    };
  }

  const terminus = lane.declaration.terminus;
  const pathCount = countPaths(terminus, baseGraph.starts, baseGraph.out);

  const crossPhaseGrounds = allEdges.filter(
    (edge) => edge.relation === "grounds" && memberIds.has(edge.citedId) && !memberIds.has(edge.citingId),
  );
  const foldedGraph = buildPathGraph([
    ...structuralPairs,
    ...crossPhaseGrounds.map((edge) => [edge.citingId, edge.citedId] as const),
  ]);
  const foldedPathCount = countPaths(terminus, foldedGraph.starts, foldedGraph.out);

  return {
    key: lane.key,
    status: "ok",
    starts: [...baseGraph.starts].sort((a, b) => a - b),
    terminus,
    pathCount,
    folded: {
      citingTurnsFolded: [...new Set(crossPhaseGrounds.map((edge) => edge.citingId))].sort((a, b) => a - b),
      pathCount: foldedPathCount,
    },
  };
}

// Re-exported so a consumer that only wants tag-set canonicalisation need not
// also import lane-interpretation.ts directly.
export { canonicalTagSet };
