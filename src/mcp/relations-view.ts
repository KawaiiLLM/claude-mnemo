import type { Database } from "bun:sqlite";

import {
  getTurnRelationEdges,
  type TurnRelationEdgeView,
} from "../db/memory-edges";
import {
  defaultRelationRank,
  groupHopEdges,
  rankChainCandidates,
  renderRelationTree,
  type GroupedHop,
  type RelationTree,
  type TreeHop,
  type TreeSpine,
} from "./relation-tree";

/**
 * Edge-read-surface spec, ticket 01, RESHAPED by fork-tree ticket 12: the
 * `relations` recall field's rendering half. `db/memory-edges.ts`'s
 * `getTurnRelationEdges` supplies the Law-8-filtered raw edges (both
 * directions, relation-carrying only); this module turns them into a TREE —
 * the root's own address, its main out-chain extended transitively, every
 * other out-edge and every in-edge as its own `└` branch — reusing the
 * shared tree data model + renderer (`./relation-tree`, tickets 12/13's
 * common ground) rather than the old flat `→`/`←` one-hop lines. Kept
 * separate from `format.ts` (the DB-free pure renderer) and from
 * `recall.ts`/`segment-card.ts` (so neither has to duplicate this format) —
 * every "turn block" render site that honours `filter.fields` imports
 * `buildTurnRelationLines` from here, and `timeline.ts`'s node selector
 * (`timeline(id="S<n>/T<m>")`, ticket 13 decision 5) imports it too, for the
 * exact same tree bytes under its own header row.
 */

function formatRelationAddress(
  currentSessionId: number,
  otherSessionId: number,
  otherPromptNumber: number,
): string {
  return currentSessionId === otherSessionId
    ? `T${otherPromptNumber}`
    : `S${otherSessionId}/T${otherPromptNumber}`;
}

/**
 * lane-model-v12 ticket 08 / edge-atom ticket 11 decision 5: the lane
 * suffix, read off a tree hop's own (combined, representative) side tags.
 *
 *   - both sides settle to the same lane: `{lane}`.
 *   - a CROSSING (two different lanes): `{tail→head}`, tail first — which
 *     lane the reference comes FROM, which it points AT.
 *   - neither side settled: no brace suffix at all.
 *
 * A HALF-settled edge cannot occur — the write gate refuses one — so no arm
 * here has to invent a display for half a lane. `GroupedHop.tailTag`/
 * `headTag` (`./relation-tree`'s pair-combine step) already picked the
 * right representative row when a hop combines more than one parallel edge.
 */
function formatLaneSuffix(hop: { tailTag: string; headTag: string }): string {
  if (hop.tailTag !== "" && hop.tailTag === hop.headTag) {
    return ` {${hop.tailTag}}`;
  }
  if (hop.tailTag !== "" && hop.headTag !== "") {
    return ` {${hop.tailTag}→${hop.headTag}}`;
  }
  return "";
}

/**
 * Out-branch extension depth (ticket 12 decision 2): 3 visible hops past
 * the branch's own first hop, then `-> ..`. Applies to the main chain and
 * to every other out-branch alike — "extended the same way".
 */
const MAX_TREE_HOPS = 3;

/**
 * Branch-line cap (ticket 12 decision 6): matches the sibling `↳`
 * antecedent-row cap recall's milestone rows already use
 * (`mcp/timeline.ts`'s `MILESTONE_UNIT_PULLED_CAP`, currently 4) — the same
 * "how many related-turn addresses is one row worth" judgement, reused
 * rather than picked fresh, so the two related-turn surfaces stay
 * consistent. Counts every branch (other out-edges plus every in-edge)
 * together; the main chain is exempt (it is the ONE thing this field always
 * shows in full, capped only by its own 3-hop depth).
 */
export const RELATION_TREE_BRANCH_CAP = 4;

type AddressedHop = GroupedHop & { otherSessionId: number; otherPromptNumber: number };

/** `getTurnRelationEdges`'s one-directional row list, grouped into one `AddressedHop` per distinct target (edge-atom ticket 11 decision 4's pair-combine, `./relation-tree`'s `groupHopEdges`), each carrying the address its own rows already joined. */
function buildCandidates(rows: readonly TurnRelationEdgeView[]): AddressedHop[] {
  const addressOf = new Map<number, { sessionId: number; promptNumber: number }>();
  for (const row of rows) {
    if (!addressOf.has(row.otherTurnId)) {
      addressOf.set(row.otherTurnId, { sessionId: row.otherSessionId, promptNumber: row.otherPromptNumber });
    }
  }
  const grouped = groupHopEdges(
    rows.map((row) => ({
      targetId: row.otherTurnId,
      relation: row.relation,
      tailTag: row.tailTag,
      headTag: row.headTag,
    })),
  );
  return grouped.map((hop) => {
    const address = addressOf.get(hop.targetId)!;
    return { ...hop, otherSessionId: address.sessionId, otherPromptNumber: address.promptNumber };
  });
}

function candidateOrderOf(candidates: readonly AddressedHop[]) {
  return (targetId: number) => {
    const found = candidates.find((candidate) => candidate.targetId === targetId)!;
    return { order: [found.otherSessionId, found.otherPromptNumber] as const };
  };
}

function toTreeHop(candidate: AddressedHop, direction: "out" | "in", repeat: boolean): TreeHop {
  return {
    targetId: candidate.targetId,
    otherSessionId: candidate.otherSessionId,
    otherPromptNumber: candidate.otherPromptNumber,
    words: candidate.words,
    crossLane: candidate.crossLane,
    tailTag: candidate.tailTag,
    headTag: candidate.headTag,
    direction,
    repeat,
  };
}

/**
 * A candidate's own reachable-node coverage — UNBOUNDED (ticket 16 decision
 * 2, repairing a GPT peer review's P1 finding): this used to be
 * DEPTH-BOUNDED to `MAX_TREE_HOPS`, on the reasoning that a coverage
 * difference past what could ever render cannot change what the reader
 * sees. That reasoning was wrong for SELECTION, only right for DISPLAY — a
 * bounded coverage cannot tell a genuinely deep thread from a shallow one
 * once both are truncated to the same horizon, so ticket 12's own "reuses
 * the lane chain's one-route logic (coverage-greedy)" authority was
 * silently narrowed to a 3-hop lookahead (the same seat-cap disease ticket
 * 08 named for the milestones fitter: a display limit had leaked into an
 * admission decision). This walks a live, otherwise-unbounded turn graph
 * one lazy `getTurnRelationEdges` fetch at a time, so it needs its own
 * cycle guard rather than a depth cap — reused verbatim from
 * `mcp/timeline.ts`'s `selectLaneChainPath` (`visiting`: "corrupt input
 * contributes 0, never hangs"). `MAX_TREE_HOPS` still bounds what actually
 * RENDERS (`walkOutSpine`'s own loop) — a purely display fact, now fully
 * separate from this function.
 */
function outCoverage(
  db: Database,
  nodeId: number,
  cache: Map<number, number>,
  visiting: Set<number>,
): number {
  const cached = cache.get(nodeId);
  if (cached !== undefined) return cached;
  if (visiting.has(nodeId)) return 0; // cycle guard: corrupt input contributes 0, never hangs
  visiting.add(nodeId);
  const candidates = buildCandidates(getTurnRelationEdges(db, nodeId).outbound);
  let best = 0;
  for (const candidate of candidates) {
    best = Math.max(best, outCoverage(db, candidate.targetId, cache, visiting));
  }
  visiting.delete(nodeId);
  const result = 1 + best;
  cache.set(nodeId, result);
  return result;
}

/**
 * One out-branch's full walk (ticket 12 decisions 1/2): starts at `start`
 * (already the best-ranked candidate at its fork point), then repeatedly
 * picks the single best next hop (`rankChainCandidates`, D8's own rule) up
 * to `MAX_TREE_HOPS` total. Forking happens ONLY at the tree's root
 * (decision 1's "the first out-branch", decision 2's "every OTHER
 * out-edge") — a branch, once started, never forks again; a node with
 * several candidates past hop 1 simply has its non-chosen candidates
 * dropped, silently, the same way a lane-chain fork not taken renders
 * nothing of its own.
 *
 * `visited` is threaded across every branch of the SAME tree (mutated in
 * place) so a later branch reconverging on an earlier one's node renders
 * `^` and stops (decision 4) instead of walking straight through it again.
 */
function walkOutSpine(
  db: Database,
  start: AddressedHop,
  visited: Set<number>,
  coverageCache: Map<number, number>,
  coverageVisiting: Set<number>,
): TreeSpine {
  const startRepeat = visited.has(start.targetId);
  const hops: TreeHop[] = [toTreeHop(start, "out", startRepeat)];
  if (startRepeat) {
    return { hops, truncated: false };
  }
  visited.add(start.targetId);

  let cur = start.targetId;
  let hopCount = 1;
  let deadEnd = false;
  while (hopCount < MAX_TREE_HOPS) {
    const candidates = buildCandidates(getTurnRelationEdges(db, cur).outbound);
    if (candidates.length === 0) {
      deadEnd = true;
      break;
    }
    const ranked = rankChainCandidates(
      candidates,
      (id) => outCoverage(db, id, coverageCache, coverageVisiting),
      candidateOrderOf(candidates),
      defaultRelationRank,
    );
    const best = ranked[0]!;
    const bestRepeat = visited.has(best.targetId);
    hops.push(toTreeHop(best, "out", bestRepeat));
    if (bestRepeat) {
      return { hops, truncated: false };
    }
    visited.add(best.targetId);
    cur = best.targetId;
    hopCount += 1;
  }

  let truncated = false;
  if (!deadEnd && hopCount === MAX_TREE_HOPS) {
    // A further candidate existing right at the cap is what earns `-> ..`
    // (never the cap alone) — same "only mark truncated when something was
    // really cut" rule the old lane chain's `truncated` flag followed.
    truncated = buildCandidates(getTurnRelationEdges(db, cur).outbound).length > 0;
  }
  return { hops, truncated };
}

/**
 * The relations field's whole tree (ticket 12), or `null` when the turn
 * neither cites nor is cited by anything — the caller renders that as `[]`,
 * byte-identical to the pre-ticket-12 empty case (acceptance criterion 5).
 */
function buildRelationTree(
  db: Database,
  turn: { id: number; sessionId: number; promptNumber: number },
): { tree: RelationTree; omittedBranchCount: number } | null {
  const edges = getTurnRelationEdges(db, turn.id);
  if (edges.outbound.length === 0 && edges.inbound.length === 0) {
    return null;
  }

  const visited = new Set<number>([turn.id]);
  // Ticket 16 decision 2: ONE unbounded-coverage cache/cycle-guard pair,
  // shared across the root ranking and every `walkOutSpine` call in this
  // tree — coverage is a property of the graph, not of which branch is
  // currently being walked, so the same memoization the lane chain's own
  // `bestCoverage` uses (module-scoped, reused call to call) applies here
  // too. `coverageVisiting` is always empty between top-level calls (each
  // recursion adds then deletes its own node), so sharing it is safe.
  const coverageCache = new Map<number, number>();
  const coverageVisiting = new Set<number>();

  const outCandidates = buildCandidates(edges.outbound);
  const rankedOut = rankChainCandidates(
    outCandidates,
    (id) => outCoverage(db, id, coverageCache, coverageVisiting),
    candidateOrderOf(outCandidates),
    defaultRelationRank,
  );

  const mainSpine: TreeSpine =
    rankedOut.length > 0
      ? walkOutSpine(db, rankedOut[0]!, visited, coverageCache, coverageVisiting)
      : { hops: [], truncated: false };
  const otherOutSpines = rankedOut
    .slice(1)
    .map((candidate) => walkOutSpine(db, candidate, visited, coverageCache, coverageVisiting));

  // Ticket 12 decision 3: in-edges are one hop, never extended — ranked by
  // the same rule for a deterministic, most-relevant-first order, but
  // `coverageOf` is a constant since a one-hop branch never looks further.
  const inCandidates = buildCandidates(edges.inbound);
  const rankedIn = rankChainCandidates(inCandidates, () => 1, candidateOrderOf(inCandidates), defaultRelationRank);
  const inSpines: TreeSpine[] = rankedIn.map((candidate) => {
    const repeat = visited.has(candidate.targetId);
    if (!repeat) {
      visited.add(candidate.targetId);
    }
    return { hops: [toTreeHop(candidate, "in", repeat)], truncated: false };
  });

  const allBranches = [...otherOutSpines, ...inSpines];
  const shownBranches = allBranches.slice(0, RELATION_TREE_BRANCH_CAP);
  const omittedBranchCount = allBranches.length - shownBranches.length;

  return {
    tree: {
      rootSessionId: turn.sessionId,
      rootPromptNumber: turn.promptNumber,
      mainSpine,
      branches: shownBranches,
    },
    omittedBranchCount,
  };
}

/**
 * Both directions of one turn's tagged edges, rendered as the tree (ticket
 * 12). `[]` when the turn neither cites nor is cited by anything
 * (relation-carrying, Law-8-live) — unchanged from the pre-ticket-12
 * behaviour. Callers gate the QUERY itself on whether `relations` was
 * actually requested (`filter.fields`) — this function has no opinion on
 * that, so "costs nothing when not requested" is each caller's own job, not
 * this one's.
 */
export function buildTurnRelationLines(
  db: Database,
  turn: { id: number; sessionId: number; promptNumber: number },
): string[] {
  return buildTurnRelationView(db, turn).lines;
}

function collectRelationTreeTurnIds(tree: RelationTree): number[] {
  const ids = new Set<number>();
  const addSpine = (spine: TreeSpine) => {
    for (const hop of spine.hops) {
      ids.add(hop.targetId);
    }
  };
  addSpine(tree.mainSpine);
  for (const branch of tree.branches) {
    addSpine(branch);
  }
  return [...ids];
}

/**
 * `buildTurnRelationLines`'s lines, PLUS the id of every turn the tree
 * actually shows (main chain, every branch, `^` repeats included — a
 * repeat still discloses that node's identity, so it counts as read too).
 * Ticket 13 decision 5's node selector (`timeline(id="S<n>/T<m>")`) is the
 * one caller that needs the ids, for its own read-grant recording; every
 * other caller (`recall.ts`, `segment-card.ts`) keeps using the plain
 * `buildTurnRelationLines` above.
 */
export function buildTurnRelationView(
  db: Database,
  turn: { id: number; sessionId: number; promptNumber: number },
): { lines: string[]; turnIds: number[] } {
  const built = buildRelationTree(db, turn);
  if (built === null) {
    return { lines: [], turnIds: [] };
  }
  const lines = renderRelationTree(
    built.tree,
    (sessionId, promptNumber) => formatRelationAddress(turn.sessionId, sessionId, promptNumber),
    formatLaneSuffix,
  );
  if (built.omittedBranchCount > 0) {
    const indent = " ".repeat(`S${turn.sessionId}/T${turn.promptNumber}`.length);
    lines.push(`${indent}… +${built.omittedBranchCount} more`);
  }
  return { lines, turnIds: collectRelationTreeTurnIds(built.tree) };
}
