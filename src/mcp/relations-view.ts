import type { Database } from "bun:sqlite";

import {
  getTurnRelationEdges,
  type TurnRelationEdgeView,
} from "../db/memory-edges";
import { getOwningSegmentId } from "../db/segments";
import { displayEdgeRelation } from "../shared/relation-class";
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
 * Edge-read-surface spec, ticket 01, RESHAPED by fork-tree ticket 12 and
 * SPLIT IN TWO by settlement-read-once spec D8: the rendering half of every
 * surface that shows a turn's edges. `db/memory-edges.ts`'s
 * `getTurnRelationEdges` supplies the Law-8-filtered raw rows (both
 * directions, relation-carrying only) to both shapes this module now owns:
 *
 *   - `buildTurnRelationTreeLines` — the TREE (root address, main out-chain
 *     extended transitively, every other out-edge and every in-edge as its
 *     own `└` branch, 3 hops, 4 branches, `… +N more`), built on the shared
 *     tree data model + renderer (`./relation-tree`, tickets 12/13's common
 *     ground). One caller left: `timeline(id="S<n>/T<m>")`'s node route.
 *   - `buildTurnDirectRelationLines` — the DIRECT SET (spec D8): this node's
 *     own outgoing rows then its own incoming rows, both raw lane sides on
 *     each, nothing elided. This is what `recall`'s `relations` field and the
 *     task card's member blocks render.
 *
 * Kept separate from `format.ts` (the DB-free pure renderer) and from
 * `recall.ts`/`segment-card.ts` (so neither has to duplicate either format).
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
      // relation-vocabulary-v13 ticket 02: the tree renders the CLASS a row was
      // written under, and the stored seven-word value only for a row written
      // before that vocabulary existed (`displayEdgeRelation`). This is the
      // surface settlement reads its own edges back through, so a writer taught
      // `correct`/`verify`/`use` must not be shown `override`/`extends` for
      // what it just wrote.
      relation: displayEdgeRelation(row),
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
 * Both directions of one turn's tagged edges, rendered as the TREE (ticket
 * 12). `[]` when the turn neither cites nor is cited by anything
 * (relation-carrying, Law-8-live).
 *
 * Settlement-read-once spec D8 narrowed this function's audience to ONE
 * caller: `timeline(id="S<n>/T<m>")`'s node route, which keeps the tree
 * (spec user story 17). It was named `buildTurnRelationLines` while it was
 * also `recall`'s `relations` field; that field now renders the direct edge
 * set below, and a bare "the relation lines" name over one of two shapes
 * would send the next reader to whichever one they guessed. Both are spelled
 * out instead.
 */
export function buildTurnRelationTreeLines(
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
 * `buildTurnRelationTreeLines`'s lines, PLUS the id of every turn the tree
 * actually shows (main chain, every branch, `^` repeats included — a
 * repeat still discloses that node's identity, so it counts as read too).
 * Ticket 13 decision 5's node selector (`timeline(id="S<n>/T<m>")`) is the
 * one caller that needs the ids, for its own read-grant recording; the tree
 * test suite uses the plain line accessor above. `recall.ts` and
 * `segment-card.ts` left both for the direct set (spec D8).
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

// ---------------------------------------------------------------------------
// The DIRECT edge set (settlement-read-once spec D8; user rulings T2388,
// T2404). Everything above this line is the TREE, and the tree now has
// exactly one reader left: `timeline(id="S<n>/T<m>")`'s node route.
// ---------------------------------------------------------------------------

/**
 * Spec D8: `recall`'s `relations` field stopped being a 3-hop tree and became
 * THIS NODE'S OWN EDGES — every outgoing row first, every incoming row after,
 * each showing both raw lane sides, nothing elided and nothing expanded.
 *
 * Why the tree left. The settlement writer is the field's real reader, and
 * what it must see before it may write an edge is the set the write gate
 * fences: this turn's own rows (D0). A tree answered a different question —
 * where does this thread go — at the price of hiding some of that set behind
 * a branch cap (`RELATION_TREE_BRANCH_CAP`) and a `… +N more` marker, while
 * spending atoms on DOWNSTREAM nodes whose edges the writer was not about to
 * touch. Under the 20-out / 20-in degree caps (D0) the direct set is at most
 * 40 atoms, so the field can carry all of it and the elision can go.
 *
 * What is borrowed from the lane view (`mcp/timeline.ts`'s
 * `renderSegmentLaneView`) is its NOTATION and nothing else — never its
 * adjacency data, which shows only qualified, visible, tail-in-lane rows of
 * one lane and would therefore under-report a node's edges. Concretely: the
 * `->`/`<-` direction strokes and the `E<n>/#tag` task qualifier. A CROSSING
 * is carried by the two-sided suffix, not by a second arrow glyph — spec D8's
 * own grammar spells a crossing `word -> T<n> (#tail -> #head)` with the
 * plain stroke, and T2388 ruled out inventing notation on top of it.
 */

/** One rendered row: a distinct (other endpoint, tailTag, headTag) placement, carrying every relation word stored on it. */
interface DirectRelationRow {
  otherTurnId: number;
  otherSessionId: number;
  otherPromptNumber: number;
  tailTag: string;
  headTag: string;
  words: string[];
}

/**
 * Rows grouped by `(other endpoint, tailTag, headTag)` — never by endpoint
 * pair alone (spec D8). Storage identity is `(relation, tail_tag, head_tag)`
 * and production holds 109 turn pairs carrying more than one PLACEMENT (e.g.
 * `extends #a->#a` beside `indexes #b->#b`); folding those onto one row would
 * have to pick one suffix and would lose which word sits where. Several
 * relations DO merge onto one row when their sides are identical, which is
 * the only case a single suffix describes truthfully.
 *
 * Output order is by ADDRESS first (`otherSessionId`, `otherPromptNumber`),
 * then by the placement's own two tags — so a pair's several placements land
 * adjacent and a reader scanning for one address finds all of it in one
 * place. The DB hands rows in `relation ASC, tail_tag ASC, head_tag ASC`
 * order, which is deterministic but scatters an endpoint across the block.
 */
function groupDirectRows(rows: readonly TurnRelationEdgeView[]): DirectRelationRow[] {
  const byPlacement = new Map<string, DirectRelationRow>();
  for (const row of rows) {
    const key = `${row.otherTurnId} ${row.tailTag} ${row.headTag}`;
    const existing = byPlacement.get(key);
    const word = displayEdgeRelation(row);
    if (existing) {
      if (!existing.words.includes(word)) {
        existing.words.push(word);
      }
      continue;
    }
    byPlacement.set(key, {
      otherTurnId: row.otherTurnId,
      otherSessionId: row.otherSessionId,
      otherPromptNumber: row.otherPromptNumber,
      tailTag: row.tailTag,
      headTag: row.headTag,
      words: [word],
    });
  }
  const grouped = [...byPlacement.values()];
  for (const group of grouped) {
    group.words.sort();
  }
  grouped.sort((left, right) => {
    if (left.otherSessionId !== right.otherSessionId) {
      return left.otherSessionId - right.otherSessionId;
    }
    if (left.otherPromptNumber !== right.otherPromptNumber) {
      return left.otherPromptNumber - right.otherPromptNumber;
    }
    if (left.tailTag !== right.tailTag) return left.tailTag < right.tailTag ? -1 : 1;
    if (left.headTag !== right.headTag) return left.headTag < right.headTag ? -1 : 1;
    return 0;
  });
  return grouped;
}

/**
 * The whole-row marker for a relation-carrying row whose BOTH sides hold the
 * `''` sentinel. The canonical word is "unplaced" (spec D8): not "draft",
 * which names a note's status, and not "bare", which this codebase already
 * uses for the relation-NULL prose row that never reaches this renderer.
 */
const UNPLACED_MARKER = "[unplaced]";

/** The one-character stand-in for a side nobody has settled, beside a partner that IS settled. */
const UNSETTLED_SIDE_MARK = "·";

/** The between-sides arrow inside a placement suffix — the same glyph the lane tag pair uses everywhere else in this codebase. */
const SIDE_ARROW = "→";

/**
 * One side's rendered lane, task-qualified when the endpoint owning that side
 * sits in a task other than the viewed turn's own.
 *
 * The qualifier is exactly the lane view's `E<n>/#tag` form and carries the
 * same meaning: a bare `#tag` is only an address inside ONE task, so a side
 * belonging to another task has to name it or the reader cannot resolve it.
 * A homeless endpoint has no task to name, so the bare tag is all that can
 * honestly be printed.
 */
function formatSide(
  tag: string,
  endpointTaskId: number | null,
  viewerTaskId: number | null,
): string | null {
  if (tag === "") {
    return null;
  }
  if (endpointTaskId !== null && endpointTaskId !== viewerTaskId) {
    return `E${endpointTaskId}/#${tag}`;
  }
  return `#${tag}`;
}

/** The row's trailing side clause: `[unplaced]`, `(#lane)`, `(#tail -> ·)`, `(· -> #head)` or `(#tail -> #head)`. */
function formatSides(tail: string | null, head: string | null): string {
  if (tail === null && head === null) {
    return UNPLACED_MARKER;
  }
  if (tail !== null && tail === head) {
    return `(${tail})`;
  }
  return `(${tail ?? UNSETTLED_SIDE_MARK} ${SIDE_ARROW} ${head ?? UNSETTLED_SIDE_MARK})`;
}

/**
 * The ONE legend line a response carries for this field (spec D8: "one legend
 * line per response"), appended once by the response assembler rather than
 * repeated under every turn block.
 *
 * Its last clause is D0's own advisory line, and it is load-bearing rather
 * than decorative: the write gate fences a turn's OUTGOING ROWS. The lane
 * sides shown here are the rows' stored tags, but the `E<n>/` qualifier in
 * front of one is resolved from the endpoint's CURRENT owning task at read
 * time and is not fenced — a task merge or a membership move re-resolves it
 * without staling anything. A reader who mistook the qualifier for part of
 * the fenced fact would re-read for nothing.
 */
export const RELATIONS_FIELD_LEGEND =
  "relations legend: `<words> -> <addr>` is an edge this turn cites OUT, `<- <addr> <words>` one cited IN; " +
  "this turn's own direct edges only, both directions whole, nothing elided and nothing expanded. " +
  "The trailing `(#tail → #head)` is the edge's two stored lane sides — `(#lane)` when both settle in one, " +
  "`·` a side nobody settled, `[unplaced]` neither. An `E<n>/` before a lane names that endpoint's " +
  "CURRENT task, resolved at read time and advisory: it is not part of what an edge write is checked against.";

/**
 * The turn's direct edge set as rendered lines (spec D8) — outgoing first,
 * incoming after, one line per `(other endpoint, tailTag, headTag)`
 * placement, `[]` when the turn neither cites nor is cited by anything
 * (relation-carrying and Law-8-live; a `relation IS NULL` prose row is not an
 * edge and `getTurnRelationEdges` never hands one over).
 *
 * Never elides: no `… +N more`, no page ledger, no downstream hop. The COUNT
 * is bounded by the attach-side degree caps (20 out, 20 in), so the whole set
 * fits the field's budget at today's atom widths; a caller who nevertheless
 * hands a smaller budget gets a `cut` report from the render layer, and the
 * gate does not care (D0: delivered suffices, not delivered whole).
 *
 * Callers gate the QUERY on whether `relations` was actually requested
 * (`filter.fields`) — this function has no opinion on that, exactly as the
 * tree above never did.
 */
export function buildTurnDirectRelationLines(
  db: Database,
  turn: { id: number; sessionId: number; promptNumber: number },
): string[] {
  const edges = getTurnRelationEdges(db, turn.id);
  if (edges.outbound.length === 0 && edges.inbound.length === 0) {
    return [];
  }

  // One membership lookup per DISTINCT endpoint, memoized: a 40-atom node
  // whose edges land on far fewer distinct turns pays per turn, not per row.
  const taskCache = new Map<number, number | null>();
  const taskOf = (turnId: number): number | null => {
    const cached = taskCache.get(turnId);
    if (cached !== undefined) {
      return cached;
    }
    const resolved = getOwningSegmentId(db, turnId);
    taskCache.set(turnId, resolved);
    return resolved;
  };
  const viewerTaskId = taskOf(turn.id);

  const lines: string[] = [];
  for (const row of groupDirectRows(edges.outbound)) {
    // Outgoing: THIS turn is the citing side, so the tail is the viewer's own
    // side and the head belongs to the other endpoint.
    const sides = formatSides(
      formatSide(row.tailTag, viewerTaskId, viewerTaskId),
      formatSide(row.headTag, taskOf(row.otherTurnId), viewerTaskId),
    );
    const address = formatRelationAddress(turn.sessionId, row.otherSessionId, row.otherPromptNumber);
    lines.push(`${row.words.join(",")} -> ${address} ${sides}`);
  }
  for (const row of groupDirectRows(edges.inbound)) {
    // Incoming: the OTHER endpoint is the citing side, so the tail is theirs
    // and the head is the viewer's own.
    const sides = formatSides(
      formatSide(row.tailTag, taskOf(row.otherTurnId), viewerTaskId),
      formatSide(row.headTag, viewerTaskId, viewerTaskId),
    );
    const address = formatRelationAddress(turn.sessionId, row.otherSessionId, row.otherPromptNumber);
    lines.push(`<- ${address} ${row.words.join(",")} ${sides}`);
  }
  return lines;
}
