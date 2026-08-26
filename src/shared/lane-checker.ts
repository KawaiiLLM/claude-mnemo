/**
 * v12 lane-model CHECKER (lane-model-v12 spec D6, ticket 11). Built on
 * `lane-interpretation.ts`'s pure enumeration/reduction — this module adds the
 * report shapes and nothing else: no rendering, no candidate-edge suggestions,
 * no advisory text. Numbers, names, states only; the CLI/settlement-tool
 * renderers (`lane-checker-render.ts`) are the only consumers that turn this
 * into prose or a digraph.
 *
 * `LaneKey` is `{segment, tag}`, not `{segment, tagSet}`.
 *
 * ## MEMBERSHIP IS A NODE FACT (lane-model-v12 D5, ticket 10)
 *
 * A turn is a member of the lanes its OWN tags name — `LaneTurnInput.laneTags`,
 * resolved by `db/lane-checker-load.ts` against the segment's declared lanes.
 * Nothing in this module enumerates a member from an edge endpoint. Edges are
 * only ATTRIBUTED to lanes; `Lane.latestMember` is what `deriveLaneStates`
 * reads for closed/open, so a lane whose newest member merely carries the tag
 * is OPEN however long ago its terminus was declared.
 *
 * ## THIS MODULE NEVER READS `edge.tags` (lane-model-v12 D1, ticket 06)
 *
 * Every lane fact about an EDGE comes off its two SIDE tags, through the two
 * predicates `lane-interpretation.ts` owns:
 *
 *   - `laneMembershipClaims` — which lane an edge belongs to (never which lane
 *     a NODE belongs to; the name predates ticket 10). Consumed INDIRECTLY,
 *     via `deriveLaneInterpretation`'s `lanes`/`taggedEdges`.
 *   - `laneEdgeTags` — the tags an edge NAMES, as a canonical set. The display
 *     form (`LaneTimeOrderViolation.tags`, `LaneSubsetInvariantError.tags`) and
 *     the "is this edge attributed at all" test (D9's cluster warning).
 *
 * One place takes NEITHER, on purpose: `subsetObligations` (E4), which needs to
 * know WHICH side owes a tag, and `laneKeyOfSide` (report 3's coupling count),
 * which needs each side's own `(segment, tag)` pair rather than a merged set —
 * a cross-lane edge is exactly the shape a merged set cannot express.
 *
 * ## The reports, after ticket 11's retarget
 *
 *   1. LANE STATISTICS (`LaneStatsReport`) — members, phases, per-word edge
 *      counts, declaration/state, lane-wide cited-ness, coverage. Unchanged.
 *   2. CONNECTIVITY (`LaneComponentReport`) — RETARGETED. The domain is now
 *      "edges whose two sides both name THIS lane", i.e. the lane's own
 *      `taggedEdges`, and nothing else: no tag-agnostic bridge word-set, no
 *      global union-find, no segment-wide neighbourhood. A lane's members are
 *      connected or they are not, judged on the lane's own edges. Provisional
 *      lanes (0 or 1 member, legal under D3 — "连通性原则对 provisional lane
 *      不适用") are NOT reported at all rather than reported as trivially
 *      whole. The report gains one line: whether a CLOSED lane's terminus is
 *      cited from outside the lane (`terminusCitedness`), the convergence
 *      question report 1's lane-wide cited-ness cannot answer.
 *   3. CROSS-LANE COUPLING (`LaneCouplingReport`) — per lane, its cross-lane
 *      edges counted in the three groups the ticket names
 *      (verify/override/narrow/extend | ground | consume/index). COUNTS ONLY:
 *      no verdict, no threshold. "较少" has neither a denominator nor a bar,
 *      and inventing one is on this spec's explicit do-not list. This REUSES
 *      report 3's slot, type position and render section — the deleted
 *      shared-components report's — so the report set gains no new category.
 *   4b. STRUCTURAL BYPASS CANDIDATES (`LaneBypassCandidate`) — transitive
 *      reduction over the SEGMENT's whole graph (`SEGMENT_GRAPH_RELATIONS`),
 *      not over one lane's own edges: a direct edge `u -> v` for which the
 *      same graph also holds a path `u -> … -> v` of two hops or more. The
 *      output names BOTH the direct edge and the alternative path and
 *      DELIBERATELY does not say which to remove: rubric's three dispositions
 *      (drop the direct edge, drop the detour, keep both) turn on what each
 *      route CONTRIBUTES, which is content this module cannot see.
 *   4c. TIME-ORDER VIOLATIONS (`computeTimeOrderViolations`) — the DAG
 *      guarantee, unchanged. Every edge among the loaded turns, ALL SEVEN
 *      relation words, must have its citing turn postdate its cited turn.
 *      Same-session pairs compare `LaneOrderKey`'s own `[session_id,
 *      prompt_number]` tuple (never ACROSS sessions — a `session_id` is an
 *      auto-increment id with no wall-clock meaning relative to another
 *      session's, the "tuple-order trap"); cross-session pairs compare
 *      `LaneTurnInput.createdAtEpoch` instead. Per-edge, not a cycle search: a
 *      forward edge is corrupt on its own the moment it is written.
 *
 * ### What ticket 11 DELETED, and why each deletion is not a narrowing
 *
 *   - REPORT 3 (shared components / multi-lane entanglement) and REPORT 4a
 *     (inter-lane interfaces + per-lane bypass) chased v11 principles the
 *     rubric no longer states (spec D6). Report 3's slot carries the coupling
 *     count now; 4a is gone outright, and with it `computeInterfaces`,
 *     `computeBypass` and `edgeIsInternalToTag`.
 *   - REPORT 4b's PATH COUNTS, the fold, and the fork/join node lists. The
 *     report identity moved from "how many start-to-terminus routes" to "which
 *     direct edges have an alternative route", and none of the old machinery
 *     (`countPaths`, the merged fold graph, `LANE_PATH_RELATIONS`) answers the
 *     new question.
 *   - The GLOBAL, tag-agnostic union-find reports 2/3 shared, and with it
 *     `unionsLaneComponentGraph`. Connectivity is now a question about a lane's
 *     own edges, so a tag-agnostic bridge domain has nobody left to serve.
 *   - E5 (a lane with more than one source or sink) — deleted earlier, by
 *     ticket 04.
 *   - E2 (an out-of-vocabulary relation word) — see "Errors" below.
 *
 * ## Report domains — the two word-sets that survive
 *
 * `SEGMENT_GRAPH_RELATIONS` (stance + consume + grounds) is the TAG-AGNOSTIC
 * structural graph of a SEGMENT, and report 4b's transitive reduction is its
 * ONE consumer. `indexes` is out (a declaration is not a step of a path, and a
 * bypass candidate must never propose dropping a convergence marker) and
 * `override` is out (a graph-STATE event, not a structural join); testimony
 * (`verifies`) is out because a probe is a fact about a node, not a route
 * between two.
 *
 * A lane's OWN graph — report 2's whole domain — reads no word-set at all. It
 * is `lane.taggedEdges`: every edge whose two sides settle to THIS lane's tag
 * inside THIS lane's segment (`laneMembershipClaims`), whatever the relation
 * word. That is the ticket's "两侧 tag 同为该 lane 的边", stated once, with no
 * second predicate to drift from it. An `indexes` edge included: under v12 the
 * index is how a lane converges, and excluding it would sever a closed lane's
 * terminus from the members it just aggregated.
 *
 * ## Vocabulary conformance — reported, never enforced
 *
 * `vocabularyConformance` carries two fact lists computed from the same inputs
 * as everything above: turns whose `type` is EMPTY or outside the closed
 * `MEMORY_TYPES` vocabulary (`shared/type-vocabulary.ts`), and edges whose
 * `relation` lies outside the seven-word `EDGE_RELATIONS` vocabulary
 * (`shared/turn-phase.ts`). The edge half is NEVER ADMITTED into any graph or
 * report computation: `checkLanes` partitions its own `edges` argument by
 * `EDGE_RELATIONS` membership FIRST, before `deriveLaneInterpretation` or any
 * report's graph builder ever sees it. Each list is capped at
 * `MAX_VOCABULARY_REPORT_ENTRIES`; `count` is always the true total.
 *
 * ## Attribution warnings (D9, ticket 09; ticket 11 retargeted the first)
 *
 * Nothing forces a tag. These two WARNINGS are the whole of what keeps lanes
 * from either disappearing (nobody attributes anything) or multiplying
 * (everybody declares their own). Neither is an error, neither blocks a commit.
 *
 *   (1) UNATTRIBUTED CLUSTER (`computeUnattributedClusters`) — RETARGETED by
 *       ticket 11. The cluster is now defined by its EDGES: 4+ turns joined by
 *       edges with BOTH sides unsettled (`''`). That set is exactly
 *       settlement's own to-do queue — spec D2 makes "both sides tagged or
 *       neither" the law, so a both-sides-empty edge is by construction a row
 *       nobody has settled yet — and clustering it is what turns a queue into
 *       a workflow a reader can act on. Three or fewer is silence: a short
 *       exchange is not a workflow.
 *
 *       WHAT THIS REPLACED. Under v11 the cluster was defined by its NODES
 *       ("turns carrying no lane tag"), connected by untagged edges drawn from
 *       a named word-set, with untagged-`indexes`-aggregated members excused
 *       out as "free aggregation". All three parts go: the subject is the
 *       unsettled EDGE now, not the unattributed turn, so a member's own
 *       unsettled edge is debt exactly like an orphan's; every relation word
 *       counts, because settlement owes every unsettled row a decision; and
 *       "free aggregation" was a v11 reading of an untagged `indexes` that v12
 *       replaced outright — an unsettled edge is unsettled, not free.
 *
 *   (2) LANE PROLIFERATION (`computeLaneProliferation`) — UNCHANGED. A segment
 *       whose DECLARED lane count exceeds `max(1, 0.05 × its member turn
 *       count)`, both numbers named. The 0.05 is the user's ruling; the
 *       `max(1, …)` keeps a 19-turn segment's single legitimate lane quiet.
 *       Both counts arrive from the DB adapter's `LaneCheckProjection.
 *       segmentFacts`, never inferred from this projection's own lanes/turns —
 *       otherwise the same segment yields different verdicts from a 4-turn
 *       settlement window and a 100-turn one. A declared lane with NO live
 *       member still counts, and the warning NAMES those lanes
 *       (`emptyLaneTags`) as the removable part of the count.
 *
 * ## ERRORS vs WARNINGS
 *
 * Every finding above is a WARNING — connectivity, coupling, bypass
 * candidates, time-order, attribution. `errors` is the separate list: states
 * the GRAMMAR FORBIDS. TWO classes ship, E3 and E4.
 *
 * **E1 IS RETIRED** (lane-declaration ticket 02): the tag mandate is withdrawn,
 * so an untagged stance edge is an ordinary legal edge. **E5 IS DELETED**
 * (v12 ticket 04): it enforced "one start, one end", a clause rubric v11 had
 * already removed. **E2 IS DELETED AS A CLASS** by this ticket, and the reason
 * is worth stating because the FACT it classed survives:
 *
 *   E2 was "an out-of-vocabulary relation word". Ticket 03 moved `supersedes`
 *   and `refutes` out of the schema CHECK and no write face can produce a word
 *   outside the seven, so on any database a WRITER has opened, no such row can
 *   exist and none can be created. `errors` has exactly one machine consumer —
 *   the settlement commit gate — and that gate only ever runs against a
 *   migrated, writable database. A class whose only mechanism is unreachable,
 *   while the teaching surfaces enumerate the classes as a CLOSED list, teaches
 *   a refusal that will never arrive.
 *
 *   The FACT is NOT unreachable, which is why it stays as a WARNING rather than
 *   being deleted with the class: `scripts/lane-check.ts` opens hard-`readonly`
 *   and can be pointed at a database that never ran the v12 edge migration —
 *   the same case `loadSegmentFacts`/`createLaneTagResolver` already guard for
 *   with their missing-`lanes`-table check. Such a file genuinely holds
 *   pre-migration `refutes`/`supersedes` rows, and since
 *   `partitionEdgesByVocabulary` structurally excludes them from every graph, a
 *   reader who is not TOLD about them would silently see an under-reported
 *   scope. `vocabularyConformance.outOfVocabularyEdges` is that telling, and
 *   the renderer prints it on the warning side.
 *
 * The class NUMBERS do not shift. E3/E4 keep the identifiers every prompt,
 * refusal line and test already spells, and a retired number is cheaper than
 * two renamed ones.
 *
 *   - **E3** an EMPTY or out-of-vocabulary turn `type`. Compact markers are
 *     skipped here, and legally-SKIPPED / rolled-back turns never reach this
 *     module at all (`db/turn-liveness.ts`'s `liveTurnSql`, applied by every
 *     query in `db/lane-checker-load.ts` — the exemption is structural at the
 *     loader, not a predicate restated here).
 *   - **E4** an edge one of whose SIDE tags is absent from that side's own
 *     endpoint turn's `tags` — PER SIDE (v12 D2 rule 3): `tailTag` against the
 *     CITING turn, `headTag` against the CITED one. The subset invariant
 *     `turn-phase.ts`'s Gate B enforces at write time, checked again over STOCK
 *     because a later tag EDIT on an endpoint turn can orphan a row the gate
 *     once passed.
 *
 * ### The ANCHOR (spec "Anchoring and repairability") — the load-bearing field
 *
 * Every error instance carries `anchorId`: an EDGE error anchors at its CITING
 * turn and a TYPE error at the turn itself. The settlement commit gate counts
 * only instances anchored inside the window's writable scope, so an error
 * anchored outside blocks its OWN window and never this one. Two properties
 * make the anchor trustworthy and MUST hold through any change here:
 *
 *   1. `anchorId` is always a turn id the repairing agent can address — never
 *      an edge row id, never a lane token — and for an edge error it is the
 *      CITING side, because retract/re-add is the citing turn's own act.
 *   2. `errors` is UNCAPPED. Every other list in this module caps its entries
 *      for display; a capped ERROR list would let an instance past the commit
 *      gate simply by sorting late, and the window would commit dirty. The
 *      RENDER caps; the data never does.
 *
 * ### Turn tags (E4's second input)
 *
 * `LaneCheckerTurnInput` widens `LaneTurnInput` with the turn's own stored
 * `tags`. It is OPTIONAL and the two absent-ish values mean different things:
 * `undefined` = not loaded, so E4 yields NO verdict for any edge touching the
 * turn; `[]` = the turn genuinely carries no tags, so every tagged edge
 * touching it IS an E4 violation.
 */

import { EDGE_RELATIONS, STANCE_RELATIONS } from "./turn-phase";
import { isMemoryType } from "./type-vocabulary";
import {
  canonicalTagSet,
  DEFAULT_SEGMENT,
  deriveLaneInterpretation,
  deriveLaneStates,
  laneEdgeTags,
  laneToken,
  UNSETTLED_LANE_TAG,
  type Lane,
  type LaneCrossSegmentWarning,
  type LaneDeclaration,
  type LaneEdgeInput,
  type LaneKey,
  type LaneMember,
  type LaneOrderKey,
  type LaneState,
  type LaneTurnInput,
  type TurnPhase,
} from "./lane-interpretation";
import { phasesForTypes } from "./turn-phase";

/** `EDGE_RELATIONS` (the seven-word write vocabulary) widened to `ReadonlySet<string>` — the ONE gate `checkLanes` partitions its raw `edges` argument through before any graph computation ever sees it (module header, "Vocabulary conformance"). */
const EDGE_RELATION_WORDS: ReadonlySet<string> = new Set(EDGE_RELATIONS);

/** Capped-list bound for `vocabularyConformance`'s two fact lists and D9's cluster list — `count` on each is always the true total even when `entries` is capped. */
const MAX_VOCABULARY_REPORT_ENTRIES = 20;

export type {
  LaneClosure,
  LaneCrossSegmentWarning,
  LaneDeclaration,
  LaneDeclarationState,
  LaneEdgeInput,
  LaneKey,
  LaneMember,
  LaneState,
  LaneTurnInput,
} from "./lane-interpretation";
export { DEFAULT_SEGMENT } from "./lane-interpretation";

/**
 * The SEGMENT's tag-agnostic structural graph — stance (narrows/extends) +
 * consume + grounds. Report 4b's transitive reduction is its ONE consumer
 * (module header, "Report domains"); it is deliberately NOT a lane-scoped
 * domain, because a bypass is a fact about the segment's whole shape and the
 * detour that makes a direct edge redundant routinely leaves the lane.
 *
 * It was called `LANE_COMPONENT_RELATIONS` while reports 2/3 shared a global
 * union-find over it. Ticket 11 retargeted connectivity onto each lane's OWN
 * edges, so the name would now point at a domain no component report reads.
 * Undirected for nobody: report 4b walks it DIRECTED (citing -> cited).
 */
export const SEGMENT_GRAPH_RELATIONS: ReadonlySet<string> = new Set([
  ...STANCE_RELATIONS,
  "consume",
  "grounds",
]);

/**
 * Report 3's three coupling groups, in the ticket's own order and spelling
 * (verify/override/narrow/extend | ground | consume/index) — the seven-word
 * vocabulary partitioned exactly once, so a reader can see at a glance that
 * every word is counted somewhere and none is counted twice.
 *
 * The grouping is the ticket's, not a derivation: the first group is the four
 * words that take a POSITION on the cited node's result, the second is the
 * single dependency word, the third is use and aggregation.
 */
export const LANE_COUPLING_GROUPS: readonly (readonly string[])[] = [
  ["verifies", "override", "narrows", "extends"],
  ["grounds"],
  ["consume", "indexes"],
];

/**
 * The cluster-size boundary (D9): 4+ warns, 3 or fewer is silence — "a short
 * exchange is not a workflow".
 */
const MIN_UNATTRIBUTED_CLUSTER_TURNS = 4;

/** Per-cluster display cap for the named turns; `LaneUnattributedCluster.turnCount` is always the TRUE total. */
const MAX_CLUSTER_TURN_ENTRIES = 20;

/**
 * A lane below this member count is PROVISIONAL (v12 D3: "允许 0/1 成员的
 * provisional lane … 连通性原则对 provisional lane 不适用") and gets no
 * connectivity report at all. Reporting it as trivially whole would be a
 * verdict on a lane the principle does not judge, and reporting it as severed
 * would be worse.
 */
const MIN_REPORTED_LANE_MEMBERS = 2;

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
  /**
   * Endpoints of this lane's OWN claiming edges that have no entry in the
   * input `turns` array — the signal that the caller's projection was
   * truncated. (`db/lane-checker-load.ts` structurally cannot produce one:
   * every edge it emits has both endpoints among the turns it emits.)
   */
  missingTurnIds: number[];
}

export interface LaneStatsReport {
  key: LaneKey;
  /** Union of `phasesForTypes` over every member. Normally one entry; more than one is itself a finding (a lane's members should share a phase). */
  phases: TurnPhase[];
  members: readonly LaneMember[];
  /** Tally of this lane's OWN tagged edges by relation word. */
  edgeCountsByRelation: Record<string, number>;
  declaration: LaneDeclaration;
  /** `lane-interpretation.ts`'s `deriveLaneStates` output for this lane, consumed directly. The corrected closed/open reading; never re-derive this from `declaration` here. */
  state: LaneState;
  citedness: {
    groundsFromNonMembers: LaneCitedFact[];
    usedFromNonMembers: LaneCitedFact[];
    testimonyFromNonMembers: LaneTestimonyFact[];
  };
  coverage: LaneCoverage;
}

// ------------------------------------------------- Report 2 (connectivity)

export interface LaneIsland {
  /** Smallest lane-member id in this island — a deterministic, locally meaningful stand-in. */
  representative: number;
  /** This lane's own members that fall in the island, ascending. */
  memberIds: number[];
}

/**
 * The connectivity report's new line (ticket 11): is a CLOSED lane's terminus
 * cited from OUTSIDE the lane at all?
 *
 * This is a different question from report 1's `citedness`, which is LANE-WIDE
 * ("does anything outside point at ANY member") and deliberately so. A closed
 * lane's terminus is its convergence: the thing a later reader is supposed to
 * pick up. Nobody citing it means the convergence went unused — a warning, and
 * only that, since the third possible cause is that the citing edge was simply
 * never written (spec's own validation note).
 */
export interface LaneTerminusCitedness {
  terminus: number;
  /** Distinct citing turns that are NOT members of this lane, ascending. Empty = nobody outside points at the convergence. */
  citedBy: number[];
}

export interface LaneComponentReport {
  key: LaneKey;
  /** Islands the lane's own members fall into under the lane's OWN claiming edges. Healthy = 1. */
  componentCount: number;
  islands: LaneIsland[];
  /** `null` for an OPEN lane — there is no converged terminus to ask the question about. */
  terminusCitedness: LaneTerminusCitedness | null;
}

// -------------------------------------------- Report 3 (cross-lane coupling)

/** One of `LANE_COUPLING_GROUPS`, counted for one lane. */
export interface LaneCouplingGroupCount {
  /** The relation words this group counts, exactly as `LANE_COUPLING_GROUPS` spells them. */
  relations: readonly string[];
  count: number;
}

/**
 * Report 3 (module header): one entry per reported lane, its cross-lane edges
 * counted in three groups. A cross-lane edge is one whose two SIDES settle to
 * two DIFFERENT lanes — the shape v11's merged tag set structurally could not
 * express — and it is counted for BOTH of the lanes it names.
 *
 * Every lane gets an entry and every entry carries all three groups, zeros
 * included: a missing group would read as "not measured" rather than "none".
 * There is no verdict field and there will not be one.
 */
export interface LaneCouplingReport {
  key: LaneKey;
  /** Always three, in `LANE_COUPLING_GROUPS` order. */
  groups: readonly LaneCouplingGroupCount[];
}

// ---------------------------------------- Report 4b (bypass candidates)

/**
 * One STRUCTURAL BYPASS CANDIDATE (module header): a direct edge `citingId ->
 * citedId` in a segment's own graph for which that same graph also holds a
 * longer route between the same two turns.
 *
 * IT NAMES NO DISPOSITION, and that is the point. rubric's three outcomes —
 * drop the direct edge, drop the detour, keep both — turn on what each route
 * CONTRIBUTES (does the intermediate turn add a fact the direct edge asserts
 * without, or merely restate it?), which is content, not shape. A checker that
 * printed "redundant" would be making a content claim from a shape fact.
 */
export interface LaneBypassCandidate {
  /** `LaneKey.segment` form — the graph a candidate is computed inside. */
  segment: string;
  citingId: number;
  citedId: number;
  /** The direct edge's relation word(s), ascending. Parallel words on ONE pair are ONE route (the T1241 precedent), so they share a candidate rather than making several. */
  relations: readonly string[];
  /** The alternative route, `[citingId, …, citedId]` — three nodes or more. SHORTEST; ties break on the smaller next-hop id, so the output is a pure function of the graph. */
  alternativePath: readonly number[];
}

// -------------------------------------------------------------- Report 4(c)

/** One forward-pointing edge — citing does not postdate cited. Self-citations are exempt and never appear here (a self edge has no time-order claim to violate). */
export interface LaneTimeOrderViolation {
  citingId: number;
  citedId: number;
  relation: string;
  /** `laneEdgeTags` — the tags the edge's two SIDES name; display only, this report has no tag domain. */
  tags: readonly string[];
}

// --------------------------------------------------- Vocabulary conformance

/** One turn among the loaded scope whose `type` is EMPTY or contains a word outside `MEMORY_TYPES`. */
export interface LaneTypeConformanceViolation {
  id: number;
  /** The turn's own type list, exactly as loaded — `[]` for the empty case. */
  types: readonly string[];
  /** The subset of `types` outside `MEMORY_TYPES` — `[]` when the sole violation is emptiness. */
  outsideVocabulary: readonly string[];
}

/** One edge among the loaded turns whose `relation` lies outside `EDGE_RELATIONS` — reported as a WARNING (module header, "E2 IS DELETED AS A CLASS"), never a graph input. */
export interface LaneOutOfVocabularyEdge {
  citingId: number;
  citedId: number;
  relation: string;
}

export interface LaneVocabularyConformance {
  /** Capped list, `count` always the true total — see `MAX_VOCABULARY_REPORT_ENTRIES`. */
  typeViolations: {
    count: number;
    entries: readonly LaneTypeConformanceViolation[];
  };
  /** Capped list, `count` always the true total. Never admitted into any graph/report computation above (module header). */
  outOfVocabularyEdges: {
    count: number;
    entries: readonly LaneOutOfVocabularyEdge[];
  };
}

// ----------------------------------------------- Attribution warnings (D9)

/**
 * One cluster of 4+ turns joined by edges with BOTH sides unsettled (module
 * header, "Attribution warnings") — settlement's own to-do queue, clustered.
 * A WARNING: nothing refuses on it.
 */
export interface LaneUnattributedCluster {
  /** The cluster's turns, ascending — CAPPED at `MAX_CLUSTER_TURN_ENTRIES` for display. */
  turnIds: readonly number[];
  /** The TRUE size of the cluster, never capped — this is the number the 4+ boundary was judged on. */
  turnCount: number;
}

/**
 * One SEGMENT whose declared lane count exceeds `max(1, 0.05 × member turn
 * count)` (module header). Both counts come from `LaneSegmentFacts`, i.e. from
 * the registry and the membership table, never from this projection's own
 * lanes/turns.
 */
export interface LaneProliferationWarning {
  /** `LaneKey.segment` form — the stringified `segments.id`. */
  segment: string;
  declaredLaneCount: number;
  memberTurnCount: number;
  /** `max(1, 0.05 × memberTurnCount)` — carried so the render states the line the count was judged against. */
  allowance: number;
  /**
   * Ticket 14: the declared lanes among `declaredLaneCount` that have NO live
   * member — the removable remainder of the count that just tripped. Empty when
   * every declared lane is visible; absent when the caller's facts did not
   * carry the field at all.
   */
  emptyLaneTags?: readonly string[];
}

/**
 * The per-SEGMENT counts the proliferation warning is judged on, supplied by
 * the DB adapter (`db/lane-checker-load.ts`'s `loadSegmentFacts`) — NEVER
 * derived from the `turns`/`edges` this function receives (peer P1-11: the same
 * segment must not yield a different verdict from a 4-turn settlement window
 * than from a 100-turn one). A caller supplying none gets no proliferation
 * verdict, the same "never fabricate completeness" posture report 1's
 * `coverage` takes.
 */
export interface LaneSegmentFacts {
  /** `LaneKey.segment` form — the stringified `segments.id`. */
  segment: string;
  /** `COUNT(*)` over the `lanes` REGISTRY for this segment — EVERY declared lane, including one with no live member (see `emptyLaneTags`). */
  declaredLaneCount: number;
  /** `COUNT(DISTINCT turn_id)` over this segment's LIVE `segment_members`. */
  memberTurnCount: number;
  /**
   * Ticket 14 — the reconciliation between the numerator and the registry. The
   * declared lanes of this segment that no reader can see.
   *
   * THE RULE: such a lane STILL COUNTS in `declaredLaneCount`. A declared lane
   * is a real budget cost whether or not it has been used yet — the rubric
   * mandates declare-BEFORE-use, so "unused" is the normal birth state, and
   * excluding the unused from the numerator would let any number of them
   * accumulate free of exactly the budget that exists to catch them. The
   * inflation is answered by NAMING them instead.
   *
   * `undefined` = the caller supplied no such field (a hand-built fixture);
   * `[]` = supplied, and every declared lane has a live member.
   */
  emptyLaneTags?: readonly string[];
}

// ------------------------------------------------------ Errors (E3-E4)

/**
 * One taggable input turn, widened with the turn's OWN stored tag set —
 * `LaneTurnInput` (the pure interpretation core's input) carries `type` but
 * never `tags`, and E4's subset invariant needs both endpoints' tags. Every
 * existing caller that hands over plain `LaneTurnInput`s still typechecks (the
 * field is optional) and simply gets no E4 verdicts.
 */
export interface LaneCheckerTurnInput extends LaneTurnInput {
  /**
   * The turn's own stored tags, canonical — the RAW column, every value in it,
   * NOT the membership-resolved subset. `undefined` means NOT LOADED — E4
   * yields no verdict for any edge touching this turn. `[]` means the turn
   * genuinely carries no tags, which is a real E4 verdict for every tagged edge
   * touching it.
   *
   * DELIBERATELY NOT `LaneTurnInput.laneTags` (ticket 10), even though the two
   * overlap on every legal row. `laneTags` is the raw column INTERSECTED with
   * the segment's declared lanes, and E4 asks a question about the stored
   * column alone: "is this side's tag present on that side's own turn". Judging
   * it against the filtered set would silently re-file a DECLARATION defect (an
   * edge naming a lane the registry never declared — a gap spec D6 explicitly
   * defers) as a SUBSET defect, whose repair is a different act entirely.
   */
  tags?: readonly string[];
}

/**
 * The two classes of the spec's error table: E3-E4. E1 (an untagged
 * `extends`/`narrows`) is RETIRED with the tag mandate itself; E5 (a lane with
 * more than one source or sink) was DELETED by ticket 04; E2 (an
 * out-of-vocabulary relation word) is DELETED AS A CLASS by ticket 11 while its
 * fact survives as a warning. See this module's header for why the remaining
 * numbers do not shift down to close any of the three gaps.
 */
export type LaneErrorClass = "E3" | "E4";

interface LaneErrorAnchor {
  /**
   * The turn this instance anchors at — an EDGE error anchors at its CITING
   * turn, a TYPE error at the turn itself (module header, "The ANCHOR"). The
   * commit gate filters by THIS field alone and never needs per-class knowledge
   * to do it.
   */
  anchorId: number;
}

/** E3 — an EMPTY or out-of-vocabulary turn `type`. Anchor: the turn itself (so `anchorId === id`, kept as two fields because the gate reads only `anchorId`). Same rows `vocabularyConformance.typeViolations` carries. */
export interface LaneTypeVocabularyError extends LaneErrorAnchor {
  class: "E3";
  id: number;
  types: readonly string[];
  /** `[]` when the sole violation is emptiness. */
  outsideVocabulary: readonly string[];
}

/** One (tag, endpoint) pair — E4's obligation shape AND its miss shape, the same per-pair shape `turn-phase.ts`'s Gate B rejection message names. `endpoint` says WHICH side owes the tag: `citing` owes `tailTag`, `cited` owes `headTag` (v12 D2 rule 3). A same-lane edge whose tag is missing from BOTH endpoints appears twice, once per side. */
export interface LaneSubsetInvariantMiss {
  tag: string;
  endpoint: "citing" | "cited";
}

/** E4 — an edge one of whose SIDE tags is absent from that side's own endpoint turn's tags. Anchor: the citing turn. */
export interface LaneSubsetInvariantError extends LaneErrorAnchor {
  class: "E4";
  citingId: number;
  citedId: number;
  relation: string;
  /** `laneEdgeTags` — the tags the edge's two SIDES name. Display/tie-break only; `missing` is what says which side failed. */
  tags: readonly string[];
  /** Non-empty by construction — ascending by endpoint then tag. */
  missing: readonly LaneSubsetInvariantMiss[];
}

export type LaneCheckerError = LaneTypeVocabularyError | LaneSubsetInvariantError;

// -------------------------------------------------------------------------

export interface LaneCheckerResult {
  lanes: LaneStatsReport[];
  /** Report 2 — one entry per NON-provisional lane (module header). A lane with fewer than two members is absent, not zeroed. */
  components: LaneComponentReport[];
  /** Report 3 — cross-lane coupling counts, one entry per reported lane. Reuses the deleted shared-components report's slot. */
  coupling: LaneCouplingReport[];
  /** Report 4b — structural bypass candidates over each segment's whole graph. */
  bypassCandidates: LaneBypassCandidate[];
  /** Report 4c — see module header. */
  timeOrderViolations: LaneTimeOrderViolation[];
  /** Every cross-segment tagged edge in scope — legal, warned, never rejected. Passed through from `deriveLaneInterpretation` unchanged. */
  warnings: readonly LaneCrossSegmentWarning[];
  /**
   * Two capped fact lists. `typeViolations` is the raw source E3 is classed
   * from (uncapped internally) so the two never disagree about a fact;
   * `outOfVocabularyEdges` is a WARNING in its own right since ticket 11
   * deleted E2 (module header).
   */
  vocabularyConformance: LaneVocabularyConformance;
  /**
   * D9 warning 1 — clusters of 4+ turns joined by unsettled edges. Capped for
   * display like every other fact list here; `count` is the true number of
   * CLUSTERS and each entry's own `turnCount` the true size of that cluster. A
   * WARNING: no gate reads it.
   */
  unattributedClusters: { count: number; entries: readonly LaneUnattributedCluster[] };
  /**
   * D9 warning 2 — one entry per supplied segment that is OVER `max(1, 0.05 ×
   * member turns)`. Empty when the caller supplied no `segmentFacts` at all: no
   * facts, no verdict.
   */
  laneProliferation: readonly LaneProliferationWarning[];
  /**
   * States the grammar forbids, E3-E4, sorted by `anchorId` then class then
   * endpoints. UNCAPPED on purpose (module header, "The ANCHOR"): the
   * settlement commit gate filters this list by `anchorId` against the window's
   * writable scope, so a display cap here would let an instance past the gate
   * by sorting late.
   */
  errors: readonly LaneCheckerError[];
}

/** Union-find, path-compressed — local to one lane's connectivity report or one cluster pass. */
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

/** Segment + tag equality (D5) — via `laneToken`'s own escaped join (round-4 review #6's collision-avoidance reasoning, still load-bearing: a plain string concat can still merge a segment/tag pair with a different one). */
function sameLaneKey(a: LaneKey, b: LaneKey): boolean {
  return laneToken(a.segment, a.tag) === laneToken(b.segment, b.tag);
}

/**
 * One SIDE of an edge as a full `LaneKey`, or `null` when that side is
 * unsettled — report 3's whole input, and the one place a side's tag is paired
 * with its OWN endpoint's segment.
 *
 * This is deliberately not `laneEdgeTags` (which merges the two sides into a
 * set and drops the segments) and not `laneMembershipClaims` (which answers
 * "which ONE lane does this edge join" and returns nothing at all for exactly
 * the cross-lane edges this report exists to count). The coercion mirrors
 * `lane-interpretation.ts`'s own `settledSide`: `tsconfig.json` excludes
 * `tests/`, so an un-migrated fixture literal can still hand this an
 * `undefined` side, and left raw two `undefined`s would compare EQUAL and mint
 * a phantom same-lane verdict.
 */
function laneKeyOfSide(
  edge: LaneEdgeInput,
  side: "tail" | "head",
  segmentFor: (id: number) => string,
): LaneKey | null {
  const raw = side === "tail" ? edge.tailTag : edge.headTag;
  const tag = typeof raw === "string" ? raw : UNSETTLED_LANE_TAG;
  if (tag === UNSETTLED_LANE_TAG) {
    return null;
  }
  return { segment: segmentFor(side === "tail" ? edge.citingId : edge.citedId), tag };
}

/**
 * Report 2 (module header, "CONNECTIVITY"): the lane's members, partitioned by
 * the lane's OWN claiming edges, plus the closed-terminus citedness line.
 *
 * The domain is `lane.taggedEdges` and nothing else — "两侧 tag 同为该 lane 的
 * 边", which `laneMembershipClaims` has already decided. An edge whose endpoint
 * is not a member (the E4 inconsistency) unions nothing, because that endpoint
 * is not in the island set to begin with; the error report is where that shows.
 *
 * Returns `null` for a PROVISIONAL lane (`MIN_REPORTED_LANE_MEMBERS`).
 */
function buildComponentReport(
  lane: Lane,
  laneState: LaneState,
  memberIds: ReadonlySet<number>,
  allEdges: readonly LaneEdgeInput[],
): LaneComponentReport | null {
  if (lane.members.length < MIN_REPORTED_LANE_MEMBERS) {
    return null;
  }
  const uf = new UnionFind();
  for (const member of lane.members) {
    uf.add(member.id);
  }
  for (const edge of lane.taggedEdges) {
    if (!memberIds.has(edge.citingId) || !memberIds.has(edge.citedId)) continue;
    uf.union(edge.citingId, edge.citedId);
  }
  const islandsByRoot = new Map<number, number[]>();
  for (const member of lane.members) {
    const root = uf.find(member.id);
    const bucket = islandsByRoot.get(root);
    if (bucket === undefined) {
      islandsByRoot.set(root, [member.id]);
    } else {
      bucket.push(member.id);
    }
  }
  const islands: LaneIsland[] = [...islandsByRoot.values()]
    .map((ids) => {
      const sorted = ids.sort((a, b) => a - b);
      return { representative: sorted[0]!, memberIds: sorted };
    })
    .sort((a, b) => a.representative - b.representative);

  let terminusCitedness: LaneTerminusCitedness | null = null;
  if (laneState.closure === "closed" && laneState.terminus !== null) {
    const terminus = laneState.terminus;
    const citedBy = new Set<number>();
    for (const edge of allEdges) {
      if (edge.citedId !== terminus) continue;
      if (memberIds.has(edge.citingId)) continue; // an in-lane citation is not "from outside"
      citedBy.add(edge.citingId);
    }
    terminusCitedness = { terminus, citedBy: [...citedBy].sort((a, b) => a - b) };
  }

  return { key: lane.key, componentCount: islands.length, islands, terminusCitedness };
}

/**
 * Report 3 (module header): per lane, the cross-lane edges counted in
 * `LANE_COUPLING_GROUPS`.
 *
 * A CROSS-LANE edge is one whose two sides both settle and name two DIFFERENT
 * `(segment, tag)` lanes — including the same literal word in two segments,
 * which is two lanes by definition. An INTERNAL edge (both sides one lane) is
 * not a crossing and is never counted; an edge with either side unsettled names
 * no coupling at all and is settlement's debt instead (D9 warning 1).
 *
 * One crossing is counted for BOTH lanes it names. There is no denominator and
 * no threshold, on purpose.
 */
function computeCoupling(
  lanes: readonly Lane[],
  allEdges: readonly LaneEdgeInput[],
  segmentFor: (id: number) => string,
): LaneCouplingReport[] {
  const crossings: Array<{ tail: LaneKey; head: LaneKey; relation: string }> = [];
  for (const edge of allEdges) {
    const tail = laneKeyOfSide(edge, "tail", segmentFor);
    const head = laneKeyOfSide(edge, "head", segmentFor);
    if (tail === null || head === null) continue;
    if (sameLaneKey(tail, head)) continue; // internal to one lane, never a crossing
    crossings.push({ tail, head, relation: edge.relation });
  }
  return lanes.map((lane) => ({
    key: lane.key,
    groups: LANE_COUPLING_GROUPS.map((relations) => ({
      relations,
      count: crossings.filter(
        (crossing) =>
          relations.includes(crossing.relation) &&
          (sameLaneKey(crossing.tail, lane.key) || sameLaneKey(crossing.head, lane.key)),
      ).length,
    })),
  }));
}

/**
 * Shortest route from `from` to `to` that does NOT take the direct hop, over
 * an already-deduplicated adjacency (`citing -> Set<cited>`). Returns the node
 * list `[from, …, to]` (three nodes or more) or `null`.
 *
 * The direct hop is excluded only where it could be taken — the first step out
 * of `from` — and `from` itself is never revisited, so the direct edge cannot
 * sneak back into the route later. BFS level by level with both the frontier
 * and each node's neighbours in ascending id order, so among equally short
 * routes the answer is a pure function of the graph rather than of edge input
 * order. Cycle-safe by the visited set: corrupt cyclic input terminates.
 */
function shortestAlternativePath(
  out: ReadonlyMap<number, ReadonlySet<number>>,
  from: number,
  to: number,
): number[] | null {
  const previous = new Map<number, number>();
  const visited = new Set<number>([from]);
  const neighboursOf = (node: number): number[] => [...(out.get(node) ?? [])].sort((a, b) => a - b);

  const reconstruct = (last: number): number[] => {
    const path = [to];
    let cursor = last;
    while (cursor !== from) {
      path.push(cursor);
      cursor = previous.get(cursor)!;
    }
    path.push(from);
    return path.reverse();
  };

  let frontier: number[] = [];
  for (const next of neighboursOf(from)) {
    if (next === to) continue; // THE direct hop — the thing we are looking for an alternative to
    if (visited.has(next)) continue;
    visited.add(next);
    previous.set(next, from);
    frontier.push(next);
  }
  while (frontier.length > 0) {
    const nextFrontier: number[] = [];
    for (const node of frontier) {
      for (const next of neighboursOf(node)) {
        if (next === to) {
          return reconstruct(node);
        }
        if (visited.has(next)) continue;
        visited.add(next);
        previous.set(next, node);
        nextFrontier.push(next);
      }
    }
    frontier = nextFrontier.sort((a, b) => a - b);
  }
  return null;
}

/**
 * Report 4b (module header): transitive reduction over each SEGMENT's whole
 * graph. A direct edge whose two endpoints are also joined by a longer route is
 * a candidate; the report names the direct edge AND the route and stops there.
 *
 * The graph is per SEGMENT (`segmentFor` on both endpoints, equal), over
 * `SEGMENT_GRAPH_RELATIONS`, over turns this projection actually loaded — an
 * endpoint the projection never saw is not invented as a node, the same posture
 * D9's cluster warning takes. Parallel relation words on one pair collapse into
 * one adjacency entry (the T1241 precedent: parallel relations on one pair are
 * ONE route) and into one candidate carrying every word.
 */
function computeBypassCandidates(
  turns: readonly LaneCheckerTurnInput[],
  allEdges: readonly LaneEdgeInput[],
  segmentFor: (id: number) => string,
): LaneBypassCandidate[] {
  const loaded = new Set(turns.map((turn) => turn.id));
  const graphs = new Map<string, Map<number, Set<number>>>();
  const directs = new Map<string, { segment: string; citingId: number; citedId: number; relations: Set<string> }>();
  for (const edge of allEdges) {
    if (!SEGMENT_GRAPH_RELATIONS.has(edge.relation)) continue;
    if (edge.citingId === edge.citedId) continue;
    if (!loaded.has(edge.citingId) || !loaded.has(edge.citedId)) continue;
    const segment = segmentFor(edge.citingId);
    if (segment !== segmentFor(edge.citedId)) continue; // a segment's graph, not the database's
    let graph = graphs.get(segment);
    if (graph === undefined) {
      graph = new Map();
      graphs.set(segment, graph);
    }
    let bucket = graph.get(edge.citingId);
    if (bucket === undefined) {
      bucket = new Set();
      graph.set(edge.citingId, bucket);
    }
    bucket.add(edge.citedId);
    const key = laneToken(segment, `${edge.citingId}>${edge.citedId}`);
    const direct = directs.get(key);
    if (direct === undefined) {
      directs.set(key, {
        segment,
        citingId: edge.citingId,
        citedId: edge.citedId,
        relations: new Set([edge.relation]),
      });
    } else {
      direct.relations.add(edge.relation);
    }
  }

  const candidates: LaneBypassCandidate[] = [];
  for (const direct of directs.values()) {
    const graph = graphs.get(direct.segment)!;
    const alternativePath = shortestAlternativePath(graph, direct.citingId, direct.citedId);
    if (alternativePath === null) continue;
    candidates.push({
      segment: direct.segment,
      citingId: direct.citingId,
      citedId: direct.citedId,
      relations: [...direct.relations].sort(),
      alternativePath,
    });
  }
  return candidates.sort(
    (a, b) =>
      a.segment.localeCompare(b.segment) || a.citingId - b.citingId || a.citedId - b.citedId,
  );
}

/**
 * Report 4c (module header): every edge among the loaded turns, ALL SEVEN
 * relation words (no domain filter — aggregation/testimony included), must have
 * its citing turn postdate its cited turn. Self-citations are exempt.
 * Same-session pairs (`order[0]` equal) compare `order[1]` (`prompt_number`)
 * strictly greater; cross-session pairs never compare the `order` tuple at all
 * (the tuple-order trap) and instead compare `createdAtEpoch`, violating only
 * when the citing turn's epoch is STRICTLY LESS than the cited turn's (ties
 * pass). A turn missing from `turnById`, or missing the epoch a cross-session
 * comparison needs, yields no judgement for edges touching it — the same "never
 * fabricate completeness" posture report 1's `coverage` already takes.
 */
function computeTimeOrderViolations(
  turnById: ReadonlyMap<number, LaneTurnInput>,
  allEdges: readonly LaneEdgeInput[],
): LaneTimeOrderViolation[] {
  // Same fallback `lane-interpretation.ts`'s own internal `orderFor` uses: a
  // turn absent from the input, or one that never set `order`, defaults to
  // `[0, id]`.
  const orderFor = (id: number): LaneOrderKey => turnById.get(id)?.order ?? [0, id];

  const violations: LaneTimeOrderViolation[] = [];
  for (const edge of allEdges) {
    if (edge.citingId === edge.citedId) continue; // self-citation exempt
    const citingOrder = orderFor(edge.citingId);
    const citedOrder = orderFor(edge.citedId);
    let violated: boolean;
    if (citingOrder[0] === citedOrder[0]) {
      violated = !(citingOrder[1] > citedOrder[1]);
    } else {
      const citingEpoch = turnById.get(edge.citingId)?.createdAtEpoch;
      const citedEpoch = turnById.get(edge.citedId)?.createdAtEpoch;
      if (citingEpoch === undefined || citedEpoch === undefined) continue; // cannot judge — no fabricated verdict
      violated = citingEpoch < citedEpoch;
    }
    if (violated) {
      violations.push({
        citingId: edge.citingId,
        citedId: edge.citedId,
        relation: edge.relation,
        tags: laneEdgeTags(edge),
      });
    }
  }
  violations.sort(
    (a, b) => a.citingId - b.citingId || a.citedId - b.citedId || a.relation.localeCompare(b.relation),
  );
  return violations;
}

/**
 * Turns among `turns` whose `type` is EMPTY or carries a word outside
 * `MEMORY_TYPES`. Ascending by id, UNCAPPED — `checkLanes` caps its own
 * `vocabularyConformance` copy for display, while E3 reads this full list
 * (module header, "The ANCHOR": a capped error list would let an instance past
 * the commit gate).
 */
function computeTypeViolations(turns: readonly LaneCheckerTurnInput[]): LaneTypeConformanceViolation[] {
  const violations: LaneTypeConformanceViolation[] = [];
  for (const turn of turns) {
    // Compact MARKER rows are exempt: they are infrastructure, not annotations
    // — the settlement facade refuses every write addressed at one, so listing
    // them would be permanent, non-actionable noise in every window that
    // contains a /compact.
    //
    // The OTHER exemption the spec names — legally-skipped turns — needs no
    // predicate here: `db/turn-liveness.ts`'s `liveTurnSql` keeps a skipped (or
    // rolled-back) turn out of every query in `db/lane-checker-load.ts`.
    if (turn.type.includes("compact")) {
      continue;
    }
    const outsideVocabulary = turn.type.filter((word) => !isMemoryType(word));
    if (turn.type.length === 0 || outsideVocabulary.length > 0) {
      violations.push({ id: turn.id, types: turn.type, outsideVocabulary });
    }
  }
  violations.sort((a, b) => a.id - b.id);
  return violations;
}

/** `{ count, entries }` from one uncapped, already-sorted fact list — the shared shape both `vocabularyConformance` halves and D9's `unattributedClusters` use, `count` always the TRUE total. */
function cappedFactList<T>(all: readonly T[]): { count: number; entries: readonly T[] } {
  return { count: all.length, entries: all.slice(0, MAX_VOCABULARY_REPORT_ENTRIES) };
}

/**
 * The ONE gate (module header, "Vocabulary conformance"): every edge
 * `checkLanes` receives is sorted here, BEFORE `deriveLaneInterpretation` or any
 * report's own graph builder runs, into the in-vocabulary set (passed on to
 * every graph computation) and the out-of-vocabulary set (reported only). This
 * is what makes "never admitted" structural rather than a convention each graph
 * builder would otherwise have to separately honour.
 */
function partitionEdgesByVocabulary(
  edges: readonly LaneEdgeInput[],
): { inVocabulary: LaneEdgeInput[]; outOfVocabulary: LaneOutOfVocabularyEdge[] } {
  const inVocabulary: LaneEdgeInput[] = [];
  const outOfVocabulary: LaneOutOfVocabularyEdge[] = [];
  for (const edge of edges) {
    if (EDGE_RELATION_WORDS.has(edge.relation)) {
      inVocabulary.push(edge);
    } else {
      outOfVocabulary.push({ citingId: edge.citingId, citedId: edge.citedId, relation: edge.relation });
    }
  }
  outOfVocabulary.sort(
    (a, b) => a.citingId - b.citingId || a.citedId - b.citedId || a.relation.localeCompare(b.relation),
  );
  return { inVocabulary, outOfVocabulary };
}

/**
 * Combine the out-of-vocabulary edges caught defensively inside `edges` itself
 * with the loader's own separately-supplied `knownOutOfVocabularyEdges`
 * (`checkLanes`'s third parameter) into one deduplicated, sorted fact list — a
 * caller may legitimately supply the same edge through both channels (unlikely,
 * but never double-counted).
 */
function mergeOutOfVocabularyEdges(
  fromEdges: readonly LaneOutOfVocabularyEdge[],
  known: readonly LaneEdgeInput[],
): LaneOutOfVocabularyEdge[] {
  if (known.length === 0) {
    return [...fromEdges];
  }
  const seen = new Map<string, LaneOutOfVocabularyEdge>();
  for (const entry of fromEdges) {
    seen.set(`${entry.citingId} ${entry.citedId} ${entry.relation}`, entry);
  }
  for (const edge of known) {
    const key = `${edge.citingId} ${edge.citedId} ${edge.relation}`;
    if (seen.has(key)) continue;
    seen.set(key, { citingId: edge.citingId, citedId: edge.citedId, relation: edge.relation });
  }
  return [...seen.values()].sort(
    (a, b) => a.citingId - b.citingId || a.citedId - b.citedId || a.relation.localeCompare(b.relation),
  );
}

/**
 * The (tag, endpoint) obligations an edge carries — the whole of E4's input, and
 * the one place the arc's DIRECTION is bound to an endpoint.
 *
 * v12 D2 rule 3 is PER SIDE: `tailTag` is the CITING turn's lane and is owed by
 * the CITING turn's own `tags`; `headTag` is the CITED turn's and is owed by the
 * CITED turn's. v11 had one merged tag set and checked EVERY tag against BOTH
 * ends, which is the same thing only because a stored edge always had `tail ===
 * head`; the moment the two sides can differ, "which side owes which tag"
 * becomes a real question with a wrong answer.
 *
 * Pointing either entry at the other endpoint is THE mutation for this function
 * — `tests/shared/lane-checker.test.ts`'s "E4 is per-SIDE" block is what goes
 * red.
 */
function subsetObligations(edge: LaneEdgeInput): LaneSubsetInvariantMiss[] {
  const obligations: LaneSubsetInvariantMiss[] = [];
  if (edge.tailTag !== UNSETTLED_LANE_TAG && edge.tailTag !== undefined) {
    obligations.push({ tag: edge.tailTag, endpoint: "citing" });
  }
  if (edge.headTag !== UNSETTLED_LANE_TAG && edge.headTag !== undefined) {
    obligations.push({ tag: edge.headTag, endpoint: "cited" });
  }
  return obligations;
}

/**
 * E4 (module header): every settled IN-VOCABULARY edge whose SIDE tag is not
 * present in that side's own endpoint turn's `tags`. The per-(tag, endpoint)
 * `missing` shape mirrors `turn-phase.ts`'s Gate B rejection detail exactly — a
 * same-lane edge whose tag is absent from both endpoints is named twice, once
 * per endpoint, so an agent repairing one side does not discover the second gap
 * only on a retry.
 *
 * A turn whose `tags` is `undefined` (not loaded, or an endpoint missing from
 * `turns` entirely) yields NO verdict for its side of the edge: the same "never
 * fabricate a verdict" posture report 4(c) takes for a missing epoch. `[]` is a
 * real, loaded, empty tag set and DOES violate.
 */
function computeSubsetInvariantErrors(
  turnById: ReadonlyMap<number, LaneCheckerTurnInput>,
  edges: readonly LaneEdgeInput[],
): LaneSubsetInvariantError[] {
  const errors: LaneSubsetInvariantError[] = [];
  for (const edge of edges) {
    const obligations = subsetObligations(edge);
    if (obligations.length === 0) continue;
    const tagsByEndpoint: Record<"citing" | "cited", readonly string[] | undefined> = {
      citing: turnById.get(edge.citingId)?.tags,
      cited: turnById.get(edge.citedId)?.tags,
    };
    const missing = obligations.filter((obligation) => {
      const owner = tagsByEndpoint[obligation.endpoint];
      return owner !== undefined && !owner.includes(obligation.tag);
    });
    if (missing.length === 0) continue;
    missing.sort((a, b) => a.endpoint.localeCompare(b.endpoint) || a.tag.localeCompare(b.tag));
    errors.push({
      class: "E4",
      anchorId: edge.citingId,
      citingId: edge.citingId,
      citedId: edge.citedId,
      relation: edge.relation,
      tags: laneEdgeTags(edge),
      missing,
    });
  }
  return errors;
}

/**
 * D9 warning 1, retargeted by ticket 11 (module header, "Attribution
 * warnings"): components of 4+ turns joined by edges with BOTH sides unsettled.
 *
 * ONE predicate, no exemptions. `laneEdgeTags(edge).length === 0` is exactly
 * "both sides are the `''` sentinel" (`lane-interpretation.ts`'s own
 * definition), which spec D2 makes synonymous with "settlement has not decided
 * this row yet" — the write gate refuses the half-settled shape, so an edge is
 * either fully attributed or fully unsettled. Every relation word counts,
 * because settlement owes a decision on every unsettled row regardless of the
 * word it carries.
 *
 * Only turns present in `turns` can be cluster members: an edge endpoint the
 * projection never loaded is not silently invented as a node.
 */
function computeUnattributedClusters(
  turns: readonly LaneCheckerTurnInput[],
  edges: readonly LaneEdgeInput[],
): LaneUnattributedCluster[] {
  const loaded = new Set(turns.map((turn) => turn.id));
  const uf = new UnionFind();
  const joined = new Set<number>();
  for (const edge of edges) {
    if (laneEdgeTags(edge).length > 0) continue; // some side names a lane: settled, not debt
    if (!loaded.has(edge.citingId) || !loaded.has(edge.citedId)) continue;
    uf.add(edge.citingId);
    uf.add(edge.citedId);
    uf.union(edge.citingId, edge.citedId);
    joined.add(edge.citingId);
    joined.add(edge.citedId);
  }
  if (joined.size < MIN_UNATTRIBUTED_CLUSTER_TURNS) {
    return [];
  }

  const byRoot = new Map<number, number[]>();
  for (const id of [...joined].sort((a, b) => a - b)) {
    const root = uf.find(id);
    const bucket = byRoot.get(root);
    if (bucket === undefined) {
      byRoot.set(root, [id]);
    } else {
      bucket.push(id);
    }
  }

  return [...byRoot.values()]
    .filter((ids) => ids.length >= MIN_UNATTRIBUTED_CLUSTER_TURNS)
    .map((ids) => ({ turnIds: ids.slice(0, MAX_CLUSTER_TURN_ENTRIES), turnCount: ids.length }))
    .sort((a, b) => a.turnIds[0]! - b.turnIds[0]!);
}

/**
 * D9 warning 2 (module header): a segment is over the line when its declared
 * lane count exceeds `max(1, 0.05 × member turn count)`.
 *
 * The test is written in INTEGER arithmetic — `declared > 1 && declared * 20 >
 * members` — which is exactly `declared > max(1, members / 20)` with no
 * floating-point boundary risk: `0.05 * 20` is not exactly `1` in IEEE-754 for
 * every magnitude, and this predicate's whole job is to be right AT the boundary
 * (a segment exactly at the ratio is silent). `allowance` is carried as the real
 * number purely so the render can print the line the count was judged against.
 */
function computeLaneProliferation(
  segmentFacts: readonly LaneSegmentFacts[],
): LaneProliferationWarning[] {
  const warnings: LaneProliferationWarning[] = [];
  for (const facts of segmentFacts) {
    if (facts.declaredLaneCount <= 1) continue; // the max(1, …) floor (peer P2-12)
    if (facts.declaredLaneCount * 20 <= facts.memberTurnCount) continue; // at or under 0.05 × members
    const warning: LaneProliferationWarning = {
      segment: facts.segment,
      declaredLaneCount: facts.declaredLaneCount,
      memberTurnCount: facts.memberTurnCount,
      allowance: Math.max(1, facts.memberTurnCount / 20),
    };
    // Omitted (rather than set to `[]`) when the caller supplied no such field:
    // absent means "not loaded", exactly as on the facts themselves.
    if (facts.emptyLaneTags !== undefined) {
      warning.emptyLaneTags = [...facts.emptyLaneTags];
    }
    warnings.push(warning);
  }
  return warnings.sort((a, b) => a.segment.localeCompare(b.segment));
}

/** Endpoint/identity tie-break shared by every error class, after `anchorId` and `class` — deterministic output for a byte-comparable render. */
function compareErrors(a: LaneCheckerError, b: LaneCheckerError): number {
  if (a.anchorId !== b.anchorId) return a.anchorId - b.anchorId;
  if (a.class !== b.class) return a.class.localeCompare(b.class);
  const citedA = errorIdentity(a);
  const citedB = errorIdentity(b);
  if (citedA !== citedB) return citedA - citedB;
  const relationA = errorWord(a);
  const relationB = errorWord(b);
  if (relationA !== relationB) return relationA.localeCompare(relationB);
  return errorDetail(a).localeCompare(errorDetail(b));
}

/** The compare's second key: the counterpart turn for an edge class, the turn itself for E3. */
function errorIdentity(error: LaneCheckerError): number {
  if (error.class === "E3") return error.id;
  return error.citedId;
}

/** The compare's third key: the relation word for an edge class. */
function errorWord(error: LaneCheckerError): string {
  if (error.class === "E3") return "";
  return error.relation;
}

/** The compare's last key: E4's own tag set. */
function errorDetail(error: LaneCheckerError): string {
  if (error.class === "E4") return error.tags.join(",");
  return "";
}

/**
 * Run every report over one turn/edge set. Pure: no database, no I/O, no write
 * path imported — the DB adapter (`db/lane-checker-load.ts`) is the only place
 * this touches storage, by translating rows into `LaneTurnInput`/`LaneEdgeInput`
 * and calling this function.
 *
 * `knownOutOfVocabularyEdges` is a SEPARATE third argument, not folded into
 * `edges`, on purpose: `LaneCheckProjection` carries these on their own field
 * too, so a consumer that reduces `projection.edges` directly with
 * `deriveLaneInterpretation` never sees an out-of-vocabulary relation at all,
 * whatever tags it happens to carry. `edges` itself is still partitioned
 * defensively below.
 */
export function checkLanes(
  turns: readonly LaneCheckerTurnInput[],
  edges: readonly LaneEdgeInput[],
  knownOutOfVocabularyEdges: readonly LaneEdgeInput[] = [],
  segmentFacts: readonly LaneSegmentFacts[] = [],
): LaneCheckerResult {
  // Partition FIRST (module header, "Vocabulary conformance"): every graph
  // computation below reads `vocabEdges`, never the raw `edges` parameter — an
  // out-of-vocabulary relation can never reach `deriveLaneInterpretation` or any
  // report's own graph builder, whatever tags it carries.
  const { inVocabulary: vocabEdges, outOfVocabulary: outOfVocabularyFromEdges } = partitionEdgesByVocabulary(edges);
  const outOfVocabularyEdges = mergeOutOfVocabularyEdges(
    outOfVocabularyFromEdges,
    knownOutOfVocabularyEdges,
  );
  // UNCAPPED here — `vocabularyConformance` below caps its own display copy,
  // while E3 reads this list (module header, "The ANCHOR").
  const typeViolations = computeTypeViolations(turns);
  const { lanes, warnings } = deriveLaneInterpretation(turns, vocabEdges);
  // The ONE `deriveLaneStates` call for this whole run — every lane's report-1
  // `state` field and report 2's closed-terminus line are lookups into this
  // map, never a fresh derivation.
  const laneStates = deriveLaneStates(lanes);
  const turnById = new Map<number, LaneCheckerTurnInput>();
  for (const turn of turns) {
    turnById.set(turn.id, turn);
  }
  // Same fallback convention `lane-interpretation.ts`'s own `segmentFor` uses: a
  // turn absent from `turns` (partial coverage) reads as DEFAULT_SEGMENT.
  const segmentFor = (id: number): string => turnById.get(id)?.segment ?? DEFAULT_SEGMENT;

  const laneStats: LaneStatsReport[] = [];
  const componentReports: LaneComponentReport[] = [];

  for (const lane of lanes) {
    const memberIds = new Set(lane.members.map((member) => member.id));
    const thisLaneToken = laneToken(lane.key.segment, lane.key.tag);
    // Guaranteed present: `deriveLaneStates` keys one entry per lane in `lanes`,
    // by that same lane's own token, and `lane` is drawn from that identical
    // `lanes` array.
    const laneState = laneStates.get(thisLaneToken)!;

    laneStats.push(buildLaneStats(lane, laneState, memberIds, turnById, vocabEdges));

    const component = buildComponentReport(lane, laneState, memberIds, vocabEdges);
    if (component !== null) {
      componentReports.push(component);
    }
  }

  const coupling = computeCoupling(lanes, vocabEdges, segmentFor);
  const bypassCandidates = computeBypassCandidates(turns, vocabEdges, segmentFor);
  const timeOrderViolations = computeTimeOrderViolations(turnById, vocabEdges);
  // ---- D9's two attribution WARNINGS. Neither participates in `errors` and no
  // gate reads either. ----
  const unattributedClusters = computeUnattributedClusters(turns, vocabEdges);
  const laneProliferation = computeLaneProliferation(segmentFacts);

  // ---- ERRORS (module header). E3 is the SAME uncapped fact list
  // `vocabularyConformance` caps for display, classed rather than recomputed;
  // E4 reads the in-vocabulary edge set. The list stays uncapped — the commit
  // gate filters it by `anchorId`. ----
  const errors: LaneCheckerError[] = [
    ...typeViolations.map(
      (violation): LaneTypeVocabularyError => ({
        class: "E3",
        anchorId: violation.id,
        id: violation.id,
        types: violation.types,
        outsideVocabulary: violation.outsideVocabulary,
      }),
    ),
    ...computeSubsetInvariantErrors(turnById, vocabEdges),
  ].sort(compareErrors);

  return {
    lanes: laneStats,
    components: componentReports,
    coupling,
    bypassCandidates,
    timeOrderViolations,
    warnings,
    vocabularyConformance: {
      typeViolations: cappedFactList(typeViolations),
      outOfVocabularyEdges: cappedFactList(outOfVocabularyEdges),
    },
    unattributedClusters: cappedFactList(unattributedClusters),
    laneProliferation,
    errors,
  };
}

function buildLaneStats(
  lane: Lane,
  laneState: LaneState,
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
  const usedFromNonMembers: LaneCitedFact[] = [];
  const testimonyFromNonMembers: LaneTestimonyFact[] = [];
  for (const edge of allEdges) {
    if (!memberIds.has(edge.citedId) || memberIds.has(edge.citingId)) {
      continue; // lane-wide over the WHOLE input, "from non-members" excludes self-cite for free
    }
    if (edge.relation === "grounds") {
      groundsFromNonMembers.push({ citingId: edge.citingId, citedId: edge.citedId });
    } else if (edge.relation === "consume") {
      usedFromNonMembers.push({ citingId: edge.citingId, citedId: edge.citedId });
    } else if (edge.relation === "verifies" || edge.relation === "refutes") {
      testimonyFromNonMembers.push({ citingId: edge.citingId, citedId: edge.citedId, relation: edge.relation });
    }
  }

  const edgeEndpointIds = new Set<number>();
  for (const edge of lane.taggedEdges) {
    edgeEndpointIds.add(edge.citingId);
    edgeEndpointIds.add(edge.citedId);
  }
  const missingTurnIds = [...edgeEndpointIds].filter((id) => !turnById.has(id)).sort((a, b) => a - b);

  return {
    key: lane.key,
    phases: [...phases],
    members: lane.members,
    edgeCountsByRelation,
    declaration: lane.declaration,
    state: laneState,
    citedness: { groundsFromNonMembers, usedFromNonMembers, testimonyFromNonMembers },
    coverage: { status: missingTurnIds.length > 0 ? "partial" : "whole", missingTurnIds },
  };
}

// Re-exported so a consumer that only wants tag-set canonicalisation need not
// also import lane-interpretation.ts directly.
export { canonicalTagSet };
