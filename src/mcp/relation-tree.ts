import {
  compareOrderKeyAcrossSessions,
  type LaneOrderKey,
} from "../shared/lane-interpretation";

/**
 * Edge-atom spec (ticket 11) + recall/lane-view tree specs (tickets 12/13):
 * the pieces genuinely shared between the lane chain's single-route walk
 * (`mcp/timeline.ts`'s `selectLaneChainPath`) and the two tree renderers —
 * kept in one small, DB-free module so neither tree has to reimplement the
 * lane chain's own rules, and the lane chain's own tests keep pinning the
 * exact same code the trees run.
 */

/**
 * The single edge-atom renderer (edge-atom spec, ticket 11 decision 1):
 * (words, crossLane) -> the labeled arrow. One word: `-word->`. Several: the
 * pair's FULL list, comma-joined: `-word1,word2->`. None (a bare,
 * unclassified pair): `->` — note the SINGLE leading stroke, not doubled;
 * there is nothing between the strokes to bracket.
 *
 * `crossLane` swaps every `-` for `=`, EXCEPT that the bare case gains a
 * LEADING `=` it does not have in the single-stroke form (`==>`, not `=>`):
 * a bare cross-lane pair rendered as plain `=>` would be byte-identical to
 * the now-retired "`=>` means indexes" glyph this same ticket deletes from
 * the lane chain — `==>` keeps "this edge crosses lanes" visually distinct
 * from that dead convention rather than accidentally resurrecting it.
 *
 * Moved here from `mcp/timeline.ts` (unchanged) so the recall relations tree
 * (ticket 12) and the lane-view island trees (ticket 13) share the exact
 * producer every other `↳`/lane-chain surface already uses, rather than
 * minting a second one.
 */
export function formatRelationArrow(words: readonly string[], crossLane: boolean): string {
  const stroke = crossLane ? "=" : "-";
  const label = words.length > 0 ? words.join(",") : "";
  const lead = label !== "" || crossLane ? stroke : "";
  return `${lead}${label}${stroke}>`;
}

/**
 * D8's own tie-break order — ONLY consulted between two candidates of
 * otherwise EQUAL coverage, and a DISPLAY tie-break rather than a score.
 *
 * main-agent-edges ticket 02 makes it EXPLICIT and class-keyed:
 *
 *   `correct(full)` > `correct(partial)` > `verify` > `use`
 *
 * i.e. the class precedence's own order, strongest claim first. The retired
 * seven-word ladder it replaced was not that order — it ranked `extends` and
 * `narrows` together at the bottom and put `indexes`/`consume` above them —
 * because it had grown one word at a time around what a chain renderer
 * happened to encounter. Three classes have one obvious order and no reason
 * to disagree with the precedence every other surface teaches.
 *
 * Anything else — a legacy row still rendering its stored word, an
 * out-of-vocabulary value — falls through to the same defensive last rank it
 * always did.
 */
const RELATION_RANK_ORDER: readonly string[] = [
  "correct(full)",
  "correct(partial)",
  "verify",
  "use",
];

export function defaultRelationRank(relation: string): number {
  const at = RELATION_RANK_ORDER.indexOf(relation);
  return at === -1 ? RELATION_RANK_ORDER.length : at;
}

/** One raw edge into/out of a hop's source node, side tags carried verbatim (`''` unsettled) — the common shape both `Lane.taggedEdges` (citing/cited ids) and `TurnRelationEdgeView` (pre-joined `otherTurnId`) reduce to once the caller has already picked "the other end" as `targetId`. */
export interface RawHopEdge {
  targetId: number;
  relation: string;
  tailTag: string;
  headTag: string;
}

/** One hop's combined edge facts — every distinct relation word ANY edge to `targetId` carries (edge-atom spec, ticket 11 decision 4's "a pair renders every word once" rule, generalized from milestone `↳` rows to tree hops), the single best-RANKED word among them (tie-break key only, never rendered on its own), and whether any PLACED row among them crosses lanes. */
export interface GroupedHop {
  targetId: number;
  /** Best-ranked (`defaultRelationRank`) word among this hop's edges — the tie-break key `rankChainCandidates` reads, not itself rendered. */
  relation: string;
  /** Every distinct relation word, alphabetical — what `formatRelationArrow` renders. */
  words: string[];
  crossLane: boolean;
  /** Representative side tags for the lane suffix (recall's relations field only, ticket 12 decision 5): the crossing row's own tags when `crossLane`, else the first same-lane PLACED row's tags, else `''`/`''` (unplaced). */
  tailTag: string;
  headTag: string;
}

/**
 * Groups parallel edges toward the same `targetId` into one `GroupedHop`
 * each — the pair-combine step every hop needs before either ranking
 * (candidates that name the same target are ONE route, D8's own convention)
 * or rendering (`formatRelationArrow` wants the pair's FULL word list, not
 * just the tie-break winner). Input order decides which row's tags become
 * the representative on a tie — callers hand this rows already in the DB's
 * own `relation ASC, tail_tag ASC, head_tag ASC` order, so the choice is
 * deterministic.
 */
export function groupHopEdges(edges: readonly RawHopEdge[]): GroupedHop[] {
  interface Building {
    words: Set<string>;
    crossLane: boolean;
    tailTag: string;
    headTag: string;
    bestRank: number;
    bestRelation: string;
  }
  const byTarget = new Map<number, Building>();
  for (const edge of edges) {
    const entry: Building = byTarget.get(edge.targetId) ?? {
      words: new Set<string>(),
      crossLane: false,
      tailTag: "",
      headTag: "",
      bestRank: Number.POSITIVE_INFINITY,
      bestRelation: edge.relation,
    };
    entry.words.add(edge.relation);
    const crosses = edge.tailTag !== "" && edge.headTag !== "" && edge.tailTag !== edge.headTag;
    const placedSameLane = edge.tailTag !== "" && edge.tailTag === edge.headTag;
    if (crosses && !entry.crossLane) {
      // Ticket 11 decision 4: one crossing row is enough for the WHOLE pair
      // to cross, even if it also carries other, same-lane or unplaced,
      // rows — and the crossing's own tags are what a crossing pair shows.
      entry.crossLane = true;
      entry.tailTag = edge.tailTag;
      entry.headTag = edge.headTag;
    } else if (!entry.crossLane && placedSameLane && entry.tailTag === "") {
      entry.tailTag = edge.tailTag;
      entry.headTag = edge.headTag;
    }
    const rank = defaultRelationRank(edge.relation);
    if (rank < entry.bestRank) {
      entry.bestRank = rank;
      entry.bestRelation = edge.relation;
    }
    byTarget.set(edge.targetId, entry);
  }
  return [...byTarget.entries()].map(([targetId, entry]) => ({
    targetId,
    relation: entry.bestRelation,
    words: [...entry.words].sort(),
    crossLane: entry.crossLane,
    tailTag: entry.tailTag,
    headTag: entry.headTag,
  }));
}

/** The order/recency half of a chain candidate's tie-break — `compareOrderKeyAcrossSessions`'s own input shape, named locally so callers do not have to import both modules just to spell it. */
export interface ChainOrderLookup {
  order: LaneOrderKey;
  createdAtEpoch?: number;
}

/**
 * D8's own "NOT greedy" tie-break (peer finding P2-7): between two
 * candidates of otherwise EQUAL coverage, the higher-ranked relation word
 * wins (`relationRank`); a further tie goes to the MORE RECENT candidate
 * (`compareOrderKeyAcrossSessions`). Coverage itself is never second-guessed
 * here — `coverageOf` decides outright whenever it differs, exactly as
 * `selectLaneChainPath`'s own inline walk always did before this rule moved
 * out to be shared with the relation trees (tickets 12/13).
 *
 * `coverageOf` is deliberately a callback, not a value: the lane chain and
 * the island trees pass the classic unbounded reachable-node-count DP over
 * an already-loaded, lane-bounded graph; the recall tree (ticket 12) —
 * walking a live, otherwise-unbounded turn graph one lazy DB fetch at a
 * time — used to pass a DEPTH-BOUNDED variant instead, capped to the tree's
 * own 3-hop render cap. Ticket 16 decision 2 retired that cap for
 * SELECTION: a display limit had leaked into an admission decision (the
 * same seat-cap disease ticket 08 named for the milestones fitter), so a
 * genuinely deep thread could lose the main-spine race to a shallow one
 * whose bounded coverage merely LOOKED equal once both were truncated to
 * the same horizon. All three callers now pass the same unbounded DP, cycle
 * guard included (`mcp/timeline.ts`'s `selectLaneChainPath` own `visiting`
 * set: "corrupt input contributes 0, never hangs") — only the render/walk
 * depth still differs by caller, and that is a display fact this
 * comparator never sees.
 */
export function compareChainCandidates<T extends { targetId: number; relation: string }>(
  a: T,
  b: T,
  coverageOf: (targetId: number) => number,
  orderOf: (targetId: number) => ChainOrderLookup,
  relationRank: (relation: string) => number = defaultRelationRank,
): number {
  const coverageDiff = coverageOf(b.targetId) - coverageOf(a.targetId);
  if (coverageDiff !== 0) return coverageDiff;
  const rankDiff = relationRank(a.relation) - relationRank(b.relation);
  if (rankDiff !== 0) return rankDiff;
  return compareOrderKeyAcrossSessions(orderOf(b.targetId), orderOf(a.targetId));
}

/** `compareChainCandidates`, applied to a whole candidate list — sorted BEST FIRST. The lane chain's own walk keeps just `[0]` each step; the relation trees (tickets 12/13) keep the WHOLE order, since every candidate past `[0]` becomes its own branch. */
export function rankChainCandidates<T extends { targetId: number; relation: string }>(
  candidates: readonly T[],
  coverageOf: (targetId: number) => number,
  orderOf: (targetId: number) => ChainOrderLookup,
  relationRank: (relation: string) => number = defaultRelationRank,
): T[] {
  return [...candidates].sort((a, b) => compareChainCandidates(a, b, coverageOf, orderOf, relationRank));
}

// ---------------------------------------------------------------------------
// The tree shape (tickets 12/13): recall's relations field replaces its flat
// one-hop lines with a tree rooted at the viewed turn, and the lane view
// replaces its single representative chain with one tree per island. Both
// trees are built by their own caller-specific walkers (root-only forking,
// 3-hop cap, lazy per-node fetch for recall; fork-at-every-node, shared
// node budget, pre-loaded lane graph for islands — the two shapes decision
// text and acceptance criteria actually pin), but they share this same data
// model and the same renderer below.
// ---------------------------------------------------------------------------

export type HopDirection = "out" | "in";

/** One rendered edge in a tree — `direction: "in"` reads right-to-left into whatever node took this hop (`formatRelationArrowInbound`), matching a citer→cited edge shown FROM the cited side. */
export interface TreeHop {
  targetId: number;
  otherSessionId: number;
  otherPromptNumber: number;
  words: string[];
  crossLane: boolean;
  /** Carried through from `GroupedHop` for `suffixOf` callbacks that want the lane suffix (recall's relations field, ticket 12 decision 5); the bare island trees (ticket 13) ignore both. */
  tailTag: string;
  headTag: string;
  direction: HopDirection;
  /** True iff `targetId` had already been rendered elsewhere in this tree when this hop was taken (ticket 12 decision 4 / ticket 13 decision 3: "render the edge, mark `^`, never re-expand"). Always the LAST hop of its spine when true — the walk stops right after. */
  repeat: boolean;
}

/** One continuous line of hops — the root's own main chain, or one `└` branch. A branch's first hop IS the edge off its parent; there is no separate "start" hop to record, since the parent is whatever line spawned this one. */
export interface TreeSpine {
  hops: TreeHop[];
  /** True iff the spine stopped at its hop/budget cap with a further, un-rendered candidate still available — the ONLY condition that earns the trailing `-> ..` (a natural dead end or a `repeat` stop earns neither). */
  truncated: boolean;
  /**
   * The node this branch actually forked from (ticket 16 decision 1) —
   * omitted (or equal to the tree's own root) when the branch forks straight
   * off the root itself, which is the ONLY case that renders bare
   * `└-word->`. A caller whose branches only ever fork at the root (recall's
   * tree, ticket 12 decision 2 — forking happens ONLY at the root) never
   * needs to set this; a caller that forks at every node (the island trees,
   * ticket 13 decision 3) always knows it — the walk already carries
   * `cameFromId`. Meaningless on a `mainSpine` (never rendered via the
   * branch path below).
   */
  parent?: { sessionId: number; promptNumber: number };
}

export interface RelationTree {
  rootSessionId: number;
  rootPromptNumber: number;
  /** The root's first (best-ranked) out-branch, extended — empty hops when the root has no out-edges at all. */
  mainSpine: TreeSpine;
  /** Every other branch (root's remaining out-edges, plus in-edges per the caller's own extension rule), in render order. */
  branches: TreeSpine[];
}

/**
 * `formatRelationArrow`'s mirror image for an IN-edge hop (ticket 12
 * decision 3: "the arrow still points citer→cited, so an in-edge reads
 * right-to-left into the root") — `<-word-`/`<=word=`/`<-`/`<==`, the exact
 * character-reversal of the outbound glyph so a reader sees the same pair
 * either way the tree happens to have reached it.
 */
export function formatRelationArrowInbound(words: readonly string[], crossLane: boolean): string {
  const stroke = crossLane ? "=" : "-";
  const label = words.length > 0 ? words.join(",") : "";
  const trail = label !== "" || crossLane ? stroke : "";
  return `<${stroke}${label}${trail}`;
}

function renderHopToken(
  hop: TreeHop,
  formatAddress: (sessionId: number, promptNumber: number) => string,
  suffixOf: (hop: TreeHop) => string,
): string {
  const arrow =
    hop.direction === "out"
      ? formatRelationArrow(hop.words, hop.crossLane)
      : formatRelationArrowInbound(hop.words, hop.crossLane);
  const address = formatAddress(hop.otherSessionId, hop.otherPromptNumber);
  const repeatMark = hop.repeat ? " ^" : "";
  return `${arrow} ${address}${suffixOf(hop)}${repeatMark}`;
}

function renderSpineBody(
  spine: TreeSpine,
  formatAddress: (sessionId: number, promptNumber: number) => string,
  suffixOf: (hop: TreeHop) => string,
): string {
  const hopText = spine.hops.map((hop) => renderHopToken(hop, formatAddress, suffixOf)).join(" ");
  const tail = spine.truncated ? " -> .." : "";
  return hopText.length > 0 ? `${hopText}${tail}` : tail.trimStart();
}

/**
 * One branch's own `└` line (ticket 16 decision 1, repairing the flat-indent
 * defect a GPT peer review confirmed against the real card): a branch that
 * forks straight off the tree's own root renders exactly as before, bare
 * `└-word-> X` — both settled examples (T1898's recall tree, the
 * milestone-design island) only ever fork at the root, so neither shape
 * changes a single byte. A branch that forks DEEPER — `TreeSpine.parent` set
 * to some node other than the root — names that fork point first: `└ T54
 * -consume-> T49 -> ..`, the anchor address then a space then the branch's
 * own hops, so a reader can tell `R-extends->A, A-extends->B, A-indexes->C`
 * apart from the lie the old flat indent told (C rendered bare under R reads
 * as an R->C edge that does not exist; anchoring at A is the only honest
 * reading). The anchor address goes through the SAME `formatHopAddress`
 * every hop on the tree uses — root-relative, the surface's own hop-
 * qualification rule, unchanged by this repair.
 */
function renderBranchLine(
  branch: TreeSpine,
  tree: RelationTree,
  indent: string,
  formatHopAddress: (sessionId: number, promptNumber: number) => string,
  suffixOf: (hop: TreeHop) => string,
): string {
  const body = renderSpineBody(branch, formatHopAddress, suffixOf);
  const parent = branch.parent;
  const forksFromRoot =
    parent === undefined ||
    (parent.sessionId === tree.rootSessionId && parent.promptNumber === tree.rootPromptNumber);
  if (forksFromRoot) {
    return `${indent}└${body}`;
  }
  const anchor = formatHopAddress(parent.sessionId, parent.promptNumber);
  return `${indent}└ ${anchor} ${body}`;
}

/**
 * The one shared tree renderer (tickets 12/13): the root's own address, its
 * main chain inline, then one `└` line per branch — indented to align under
 * the ROOT's own address width regardless of where in the tree a branch
 * actually forked (the alignment column is fixed; only the branch's own
 * anchor prefix, `renderBranchLine` above, says where it really hangs off
 * the tree). `suffixOf` is the one other thing that differs by caller:
 * recall's lane braces (ticket 12 decision 5) or nothing at all (ticket 13's
 * bare island trees).
 *
 * The root's own address is always the FULL `S<n>/T<m>` form (both settled
 * examples render it that way regardless of surface) — only HOP addresses
 * (including a branch's own anchor) go through `formatHopAddress`, since the
 * bare-vs-qualified rule for a hop genuinely differs by caller (recall's
 * relations field compares every hop to the fixed root session; the lane
 * view's island trees do too, ticket 16 decision 4 having made that
 * explicit on both surfaces) — kept, not touched, by this shared renderer.
 *
 * Returns `[rootLine, ...branchLines]` — never empty; a tree with no edges
 * at all still returns the bare root address as its one line (callers that
 * want the ticket 12 "no edges renders nothing" behavior check for that
 * case themselves, since a lane-view island always has at least the root).
 */
export function renderRelationTree(
  tree: RelationTree,
  formatHopAddress: (sessionId: number, promptNumber: number) => string,
  suffixOf: (hop: TreeHop) => string,
): string[] {
  const rootAddress = `S${tree.rootSessionId}/T${tree.rootPromptNumber}`;
  const mainBody = renderSpineBody(tree.mainSpine, formatHopAddress, suffixOf);
  const rootLine = mainBody.length > 0 ? `${rootAddress} ${mainBody}` : rootAddress;
  const indent = " ".repeat(rootAddress.length);
  const branchLines = tree.branches.map((branch) =>
    renderBranchLine(branch, tree, indent, formatHopAddress, suffixOf),
  );
  return [rootLine, ...branchLines];
}
