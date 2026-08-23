/**
 * v10 lane-model FOUR-REPORT CHECKER (rubric-v10 ticket 05; issue's "Report
 * domains" paragraph, T1300/T1321/T1323). Built on `lane-interpretation.ts`'s
 * pure enumeration/reduction — this module adds the four report shapes and
 * nothing else: no rendering, no candidate-edge suggestions, no advisory
 * text. Numbers, names, states only; the CLI/settlement-tool renderers
 * (ticket 06) are the only consumers that turn this into prose or a digraph.
 *
 * ## Report 4 splits into three blocks (rubric-v10 ticket 08, T1343 ruling)
 *
 * The aspiration this report chases moves from "few in-lane paths" to "few
 * inter-lane edges, aimed at termini", plus an in-lane DAG guarantee — three
 * independently-computed blocks, none derived from the others:
 *
 *   (a) INTERFACES + BYPASS (`computeInterfaces`/`computeBypass`) — per
 *       unordered pair of reported lanes, the count of edges crossing
 *       between them over the SAME domain reports 2/3 already use
 *       (`LANE_COMPONENT_RELATIONS`: stance + consume + grounds), excluding
 *       an edge whose own tag set already equals either lane's exact set (a
 *       lane's own structural edge is never counted as crossing INTO
 *       itself). Per DECLARED lane, bypass counts an incoming same-domain
 *       edge from outside the lane that lands on a member OTHER than the
 *       lane's current (event-reduced) `declaration.terminus` — reusing
 *       that field directly, never re-deriving the reduction.
 *   (b) PATH COUNTS (`buildPathReport`, unchanged from ticket 05) — facts,
 *       no target: this block's own mechanics carry no aspiration framing,
 *       only the report identity itself moved (report 4 as a whole is no
 *       longer "the path report").
 *   (c) TIME-ORDER VIOLATIONS (`computeTimeOrderViolations`) — the DAG
 *       guarantee: every edge among the loaded turns, ALL EIGHT relation
 *       words (unlike (a)/(b), aggregation/testimony are not excluded here
 *       — a backfill-corrupt `indexes` or `verifies` edge is exactly as
 *       forward-pointing a defect as a stance edge), must have its citing
 *       turn postdate its cited turn. Same-session pairs compare
 *       `LaneOrderKey`'s own `[session_id, prompt_number]` tuple (never
 *       ACROSS sessions — a `session_id` is an auto-increment id with no
 *       wall-clock meaning relative to another session's, the "tuple-order
 *       trap"); cross-session pairs compare `LaneTurnInput.createdAtEpoch`
 *       instead, a field this report is the one and only reader of. Per-edge,
 *       not a cycle search: a forward edge is corrupt on its own the moment
 *       it is written (the backfill risk surface), before any cycle could
 *       even form — report 4(b)'s existing cycle guard (contributes 0, never
 *       hangs) stays exactly as-is underneath, unrelated to this check.
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
 * FOLD SEMANTICS (`buildPathReport`'s `folded` half — round-4 review #3
 * corrected an earlier draft's "folding never changes any count" reading,
 * which was provably true FOR THE WRONG REASON: the fold edge was added
 * `citingId(external) -> citedId(member)`, making the external node
 * structurally unreachable from the terminus's own traversal, so it could
 * only ever prove stability, never growth — an invariant that held for
 * every input but meant folding could never do the one thing it exists to
 * do). Corrected reading: 将两侧视为一个 lane, from every start-less node to
 * the lane's own starts. The MERGED graph is the lane's base structural
 * pairs plus, for every external grounds-citer of a member, its own entry
 * edge (citer -> member) — unchanged from the earlier draft. What changed
 * is which nodes COUNT: the folded count sums `countPaths` from EVERY node
 * with no incoming edge in the merged graph — the lane's own terminus (as
 * before) AND each external citer (new) — rather than from the terminus
 * alone. A citer with no incoming edge is a second, independent root the
 * merge introduces; summing its own path count is exactly "folding it into
 * the lane" (the citer's route to the lane's starts is now counted
 * alongside the terminus's own routes), while the terminus's OWN count is
 * untouched by the fold (a fold edge never grants a member a new outgoing
 * entry), so a lane with no external grounds still gets folded === base.
 *
 * Round-5 review #11 extended the merge one step further: "two lanes citing
 * across phases counted as one" means one merged GRAPH, not just one merged
 * ENTRY EDGE — when an external citer is itself a member of ANOTHER lane,
 * that lane's own path-domain (stance+consume) edges join the merged graph
 * too, so `countPaths` can walk the citer's own chain back to ITS lane's
 * starts, not just stop at the citer's bare entry point. Lane A `T2->T1`,
 * lane B `T4->T3`, `T4 grounds T2` (T4 external to A, but a B member):
 * folding in ONLY the entry edge `T4->T2` gives folded=1 (T4's own route to
 * T1 is invisible); folding in B's own `T4->T3` edge too gives folded=2
 * (`T4->T3` and `T4->T2->T1`) — the two lanes' shapes are genuinely merged,
 * not just bridged at one point. Guarded against double-counting a lane
 * folded in from more than one citer, or re-folding the lane's own edges
 * back into itself.
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
 *
 * ## Report 1 gains a state line and `used[...]` (milestone-election spec,
 * ticket 04)
 *
 * `LaneStatsReport.state` is `lane-interpretation.ts`'s `deriveLaneStates`
 * helper's own output for this lane, CONSUMED directly (`checkLanes` calls
 * it once, over the same `lanes`/`turns` it already has) — never
 * re-derived here. The raw `declaration.state` (declared/reopened/
 * undeclared) is the wrong axis to render as "the state": that helper's own
 * doc names the trap directly — a lane that kept living past its own
 * declaration (a narrows/extends continuation, no re-declaration) still
 * reports `declaration.state === "declared"` even though it is actually
 * OPEN. `state` is the corrected reading: closed-valid / closed-invalid /
 * open, with `lastDeclarer` naming an open lane's most recent declarer when
 * one exists (`null` for a lane that was never declared at all).
 *
 * `usedFromNonMembers` sits alongside `groundsFromNonMembers`/
 * `testimonyFromNonMembers` in `citedness`, same lane-wide "target is ANY
 * member, citer is NOT a member" filter, for relation `consume` (any tag
 * state — a `consume` edge tagged with THIS lane's own exact set would
 * already make its citing turn a member by construction, so "citer is not a
 * member" already excludes that case structurally, exactly like `grounds`
 * above). This is the T1351 trap fix: a lane adopted only through an
 * external `consume` citation used to render with an empty
 * "cited from outside" line, reading as unadopted when it was not — a
 * member's own IN-LANE consume edges (both endpoints members) and any
 * testimony relation never enter this field.
 *
 * ## Vocabulary conformance (semantic-conformance ticket 02) — reported, never enforced
 *
 * `checkLanes` gains one more fact block, `vocabularyConformance`, computed
 * from the SAME two inputs and touching nothing above: turns among the
 * loaded scope whose `type` is EMPTY or contains a word outside the closed
 * `MEMORY_TYPES` vocabulary (`shared/type-vocabulary.ts`) — the phase-empty,
 * nearly edge-illegal condition a title-typo or a pre-migration legacy word
 * produces — and edges among the loaded turns whose `relation` lies outside
 * the eight-word `EDGE_RELATIONS` vocabulary (`shared/turn-phase.ts`), e.g.
 * the frozen-legacy `supersedes` (`db/citations.ts`'s `CITATION_RELATIONS`
 * carries a ninth word this module's own write vocabulary never did). Both
 * halves are reported, never enforced, like every other fact this module
 * produces. The edge half is NEVER ADMITTED into any graph/report
 * computation above: `checkLanes` partitions its own `edges` argument by
 * `EDGE_RELATIONS` membership FIRST, before `deriveLaneInterpretation` or
 * any of reports 2/3/4's own graph builders ever see it — an out-of-
 * vocabulary edge cannot join a lane, cross a component, or count toward a
 * path, whatever tags it happens to carry. This is also why report 4(c)'s
 * own "ALL EIGHT relation words" domain (this module's own header, above)
 * is now enforced structurally rather than merely asserted in prose: it
 * only ever sees the filtered set. Each list is capped at
 * `MAX_VOCABULARY_REPORT_ENTRIES`; `count` is always the true total.
 *
 * ## ERRORS vs WARNINGS (tag-mandate ticket 03, spec "Error classes")
 *
 * Every finding above is a WARNING — the three principles' aspirational
 * facts (connectivity, entanglement, minimality, time-order, undeclared
 * lanes, terminus citedness). None of their computations changed with this
 * ticket; they were reclassified, not rewritten.
 *
 * `errors` is the new, separate list: states the GRAMMAR FORBIDS. Four
 * classes ship here (E5, lane shape, is ticket 04):
 *
 *   - **E1** an `extends`/`narrows` row carrying NO lane tags. Those two
 *     words' semantics IS continuation of a line of work, so using either
 *     means naming the line; the write gate refuses fresh ones, stock
 *     repairs at settlement.
 *   - **E2** an out-of-vocabulary relation word (e.g. the frozen-legacy
 *     `supersedes`). Same raw facts `vocabularyConformance.outOfVocabularyEdges`
 *     reports — classed, not recomputed.
 *   - **E3** an EMPTY or out-of-vocabulary turn `type`. Same raw facts
 *     `vocabularyConformance.typeViolations` reports, exemptions carried
 *     over intact: compact markers are skipped here, and legally-SKIPPED /
 *     rolled-back turns never reach this module at all (`db/turn-liveness.ts`'s
 *     `liveTurnSql`, applied by every query in `db/lane-checker-load.ts` — the
 *     exemption is structural at the loader, not a predicate restated here).
 *   - **E4** a tagged edge whose tag set is not a subset of BOTH endpoint
 *     turns' own `tags` — the subset invariant `turn-phase.ts`'s Gate B
 *     enforces at write time, checked again over STOCK because a later tag
 *     EDIT on an endpoint turn can orphan a row the gate once passed.
 *
 * ### The ANCHOR (spec "Anchoring and repairability") — the load-bearing field
 *
 * Every error instance carries `anchorId`: an EDGE error anchors at its
 * CITING turn, a TYPE error at the turn itself. The settlement commit gate
 * (ticket 05) counts only instances anchored inside the window's writable
 * scope, so an error anchored outside blocks its OWN window and never this
 * one — without that scoping one bad out-of-window edge would pin a window
 * on a permanently failing commit. Two properties make the anchor
 * trustworthy and MUST hold through any change here:
 *
 *   1. `anchorId` is always a turn id the repairing agent can address —
 *      never an edge row id, never a lane token — and for an edge error it
 *      is the CITING side, because retract/re-add is the citing turn's own
 *      power.
 *   2. `errors` is UNCAPPED. Every other list in this module caps its
 *      entries for display; a capped ERROR list would let an instance past
 *      the commit gate simply by sorting late, and the window would commit
 *      dirty. The RENDER caps; the data never does.
 *
 * ### Turn tags (E4's second input)
 *
 * `LaneCheckerTurnInput` widens `LaneTurnInput` with the turn's own stored
 * `tags`. It is OPTIONAL and the two absent-ish values mean different
 * things: `undefined` = not loaded, so E4 yields NO verdict for any edge
 * touching the turn (report 4(c)'s own "never fabricate a verdict" posture);
 * `[]` = the turn genuinely carries no tags, so every tagged edge touching
 * it IS an E4 violation.
 */

import { EDGE_RELATIONS, STANCE_RELATIONS } from "./turn-phase";
import { isMemoryType } from "./type-vocabulary";
import {
  canonicalTagSet,
  DEFAULT_SEGMENT,
  deriveLaneInterpretation,
  deriveLaneStates,
  laneToken,
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

/** `STANCE_RELATIONS` widened to `ReadonlySet<string>` so it can test a plain `LaneEdgeInput.relation` without a cast at each call site. */
const STANCE_RELATION_WORDS: ReadonlySet<string> = STANCE_RELATIONS;

/** `EDGE_RELATIONS` (the eight-word write vocabulary) widened to `ReadonlySet<string>` — the ONE gate `checkLanes` partitions its raw `edges` argument through before any graph computation ever sees it (semantic-conformance ticket 02, module header). */
const EDGE_RELATION_WORDS: ReadonlySet<string> = new Set(EDGE_RELATIONS);

/** Capped-list bound for `vocabularyConformance`'s two fact lists — `count` on each is always the true total even when `entries` is capped. */
const MAX_VOCABULARY_REPORT_ENTRIES = 20;

/**
 * The words whose semantics IS continuation of a line of work, so the words
 * the mandate forbids an untagged form of (E1). Today's answer set is
 * `STANCE_RELATIONS` (narrows/extends) exactly, but it gets its own name for
 * the same reason `turn-phase.ts` names `TAGGABLE_RELATIONS` apart from
 * `SAME_PHASE_RELATIONS`: "which words build a branch" and "which words must
 * name their lane" are independent questions that happen to share an answer,
 * and a reader of E1 should not have to know that coincidence holds.
 */
const MANDATED_LANE_RELATIONS: ReadonlySet<string> = STANCE_RELATIONS;

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
  LaneValidity,
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
  /** `lane-interpretation.ts`'s `deriveLaneStates` output for this lane, consumed directly — see module header "Report 1 gains a state line". The corrected closed-valid/closed-invalid/open reading; never re-derive this from `declaration` here. */
  state: LaneState;
  citedness: {
    groundsFromNonMembers: LaneCitedFact[];
    /** Consume-class external citations (milestone-election ticket 04) — see module header. */
    usedFromNonMembers: LaneCitedFact[];
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

/** A node shared by >=1 of this component's lanes (round-4 review #7's diagnostic identity). */
export interface LaneSharedNode {
  id: number;
  /**
   * Every DISTINCT lane (among this component's own) this node touches via
   * one of ITS OWN STANCE (narrows/extends) tagged edges — either as the
   * CITED endpoint (a shared fork root several lanes' edges converge on) or
   * as the CITING endpoint (a merge node: this turn itself cites INTO two
   * different lanes, round-5 review #15). Both directions read as the same
   * "designed shape" signal; the field does not distinguish which direction
   * produced a given entry.
   */
  citingLanesByStance: LaneKey[];
  /** `citingLanesByStance.length >= 2` — a node several lanes' own stance edges converge on (from either direction) is a designed fork root or merge node, not an anomaly; fewer (0 or 1) surfaces the sharing for human judgment instead (e.g. only consume/grounds ties it in). */
  designedShape: boolean;
}

export interface MultiLaneComponent {
  /** Smallest turn id in the shared global component. */
  representative: number;
  lanes: LaneKey[];
  /** Nodes that are members of more than one of `lanes` — the fork-root/merge-node identity, annotated. */
  sharedNodes: LaneSharedNode[];
}

// -------------------------------------------------------------- Report 4(a)

/** One unordered pair of distinct reported lanes and the count of edges crossing between them — see module header block (a). Only pairs with `count > 0` are ever emitted (a sparse report, matching every other cross-lane list in this module — `MultiLaneComponent`, `LaneCrossSegmentWarning`). */
export interface LaneInterfacePair {
  laneA: LaneKey;
  laneB: LaneKey;
  count: number;
}

/** One bypass edge — an incoming same-domain citation from outside a declared lane landing on a member other than its current terminus. */
export interface LaneBypassEdge {
  citingId: number;
  citedId: number;
  relation: string;
  /** The edge's OWN canonical tag set — `[]` for untagged (a bypass edge is never one of the lane's own tagged edges, so this is almost always `[]` or a third lane's tag set, never the target lane's). */
  tags: readonly string[];
}

/** Per DECLARED lane (module header block (a)) — undeclared/reopened lanes (no current terminus to bypass) never appear here at all, rather than an entry with a meaningless zero. */
export interface LaneBypassReport {
  key: LaneKey;
  count: number;
  edges: LaneBypassEdge[];
}

// -------------------------------------------------------------- Report 4(b)

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
  /** Nodes with more than one distinct citer in the BASE structural graph — a shared origin several branches point at (round-4 review #7). Non-empty only when `pathCount` (or the base graph's own shape) exceeds 1. */
  forkNodes: number[];
  /** Nodes with more than one distinct outgoing structural edge — a node that cites (merges) more than one predecessor. Non-empty only when `pathCount` exceeds 1. */
  joinNodes: number[];
  /** `null` iff skipped — folding a lane with no terminus has nothing to count paths TO. */
  folded: LaneFoldedPaths | null;
}

// -------------------------------------------------------------- Report 4(c)

/** One forward-pointing edge (module header block (c)) — citing does not postdate cited. Self-citations are exempt and never appear here (a self edge has no time-order claim to violate). */
export interface LaneTimeOrderViolation {
  citingId: number;
  citedId: number;
  relation: string;
  tags: readonly string[];
}

// --------------------------------------------------- Vocabulary conformance

/** One turn among the loaded scope whose `type` is EMPTY or contains a word outside `MEMORY_TYPES` (semantic-conformance ticket 02, module header). */
export interface LaneTypeConformanceViolation {
  id: number;
  /** The turn's own type list, exactly as loaded — `[]` for the empty case. */
  types: readonly string[];
  /** The subset of `types` outside `MEMORY_TYPES` — `[]` when the sole violation is emptiness (a non-empty list of only recognized words is never a violation). */
  outsideVocabulary: readonly string[];
}

/** One edge among the loaded turns whose `relation` lies outside `EDGE_RELATIONS` (semantic-conformance ticket 02, module header) — reported only, never a graph input. */
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
  /** Capped list, `count` always the true total — see `MAX_VOCABULARY_REPORT_ENTRIES`. Never admitted into any graph/report computation above (module header). */
  outOfVocabularyEdges: {
    count: number;
    entries: readonly LaneOutOfVocabularyEdge[];
  };
}

// ------------------------------------------------------ Errors (E1-E4)

/**
 * One taggable input turn, widened with the turn's OWN stored tag set —
 * `LaneTurnInput` (the pure interpretation core's input) carries `type` but
 * never `tags`, and E4's subset invariant needs both endpoints' tags. Every
 * existing caller that hands over plain `LaneTurnInput`s still typechecks
 * (the field is optional) and simply gets no E4 verdicts.
 */
export interface LaneCheckerTurnInput extends LaneTurnInput {
  /**
   * The turn's own stored tags, canonical. `undefined` means NOT LOADED — E4
   * yields no verdict for any edge touching this turn, the same "never
   * fabricate completeness" posture report 1's `coverage` and report 4(c)'s
   * cross-session comparison both take. `[]` means the turn genuinely
   * carries no tags, which is a real E4 verdict for every tagged edge
   * touching it.
   */
  tags?: readonly string[];
}

/** The four classes this ticket ships. E5 (lane shape) is ticket 04 and is deliberately absent from this union until then. */
export type LaneErrorClass = "E1" | "E2" | "E3" | "E4";

interface LaneErrorAnchor {
  /**
   * The turn this instance anchors at — an EDGE error anchors at its CITING
   * turn, a TYPE error at the turn itself (module header, "The ANCHOR").
   * The commit gate filters by THIS field alone and never needs per-class
   * knowledge to do it.
   */
  anchorId: number;
}

/** E1 — an `extends`/`narrows` row carrying no lane tags. Anchor: the citing turn (retract + tagged re-add is its own power). */
export interface LaneUntaggedContinuationError extends LaneErrorAnchor {
  class: "E1";
  citingId: number;
  citedId: number;
  /** `narrows` or `extends` — the only two words this class can ever name. */
  relation: string;
}

/** E2 — an out-of-vocabulary relation word (e.g. frozen-legacy `supersedes`). Anchor: the citing turn. Same rows `vocabularyConformance.outOfVocabularyEdges` carries, classed rather than recomputed. */
export interface LaneOutOfVocabularyRelationError extends LaneErrorAnchor {
  class: "E2";
  citingId: number;
  citedId: number;
  relation: string;
}

/** E3 — an EMPTY or out-of-vocabulary turn `type`. Anchor: the turn itself (so `anchorId === id`, kept as two fields because the gate reads only `anchorId`). Same rows `vocabularyConformance.typeViolations` carries. */
export interface LaneTypeVocabularyError extends LaneErrorAnchor {
  class: "E3";
  id: number;
  types: readonly string[];
  /** `[]` when the sole violation is emptiness. */
  outsideVocabulary: readonly string[];
}

/** One (tag, endpoint) pair that fails E4 — the same per-pair shape `turn-phase.ts`'s Gate B rejection message names, so a tag missing from BOTH endpoints appears twice, once per side. */
export interface LaneSubsetInvariantMiss {
  tag: string;
  endpoint: "citing" | "cited";
}

/** E4 — a tagged edge whose tag set is not a subset of both endpoints' own tags. Anchor: the citing turn. */
export interface LaneSubsetInvariantError extends LaneErrorAnchor {
  class: "E4";
  citingId: number;
  citedId: number;
  relation: string;
  /** The edge's own canonical tag set. */
  tags: readonly string[];
  /** Non-empty by construction — ascending by endpoint then tag. */
  missing: readonly LaneSubsetInvariantMiss[];
}

export type LaneCheckerError =
  | LaneUntaggedContinuationError
  | LaneOutOfVocabularyRelationError
  | LaneTypeVocabularyError
  | LaneSubsetInvariantError;

// -------------------------------------------------------------------------

export interface LaneCheckerResult {
  lanes: LaneStatsReport[];
  components: LaneComponentReport[];
  multiLaneComponents: MultiLaneComponent[];
  /** Report 4(a) — see module header. Sparse: only crossing pairs with `count > 0`. */
  interfaces: LaneInterfacePair[];
  /** Report 4(a) — see module header. One entry per DECLARED lane only. */
  bypass: LaneBypassReport[];
  /** Report 4(b), mechanics unchanged from ticket 05. */
  paths: LanePathReport[];
  /** Report 4(c) — see module header. */
  timeOrderViolations: LaneTimeOrderViolation[];
  /** Every cross-segment tagged edge in scope — legal, warned, never rejected (round-4 review #5). Passed through from `deriveLaneInterpretation` unchanged. */
  warnings: readonly LaneCrossSegmentWarning[];
  /**
   * Semantic-conformance ticket 02 — see module header. Still computed and
   * capped exactly as before; tag-mandate ticket 03 made it the RAW SOURCE
   * the E2/E3 halves of `errors` are classed from (uncapped) rather than a
   * report of its own, so the two never disagree about a fact.
   */
  vocabularyConformance: LaneVocabularyConformance;
  /**
   * Tag-mandate ticket 03 — states the grammar forbids, E1-E4, sorted by
   * `anchorId` then class then endpoints. UNCAPPED on purpose (module
   * header, "The ANCHOR"): the settlement commit gate filters this list by
   * `anchorId` against the window's writable scope, so a display cap here
   * would let an instance past the gate by sorting late.
   */
  errors: readonly LaneCheckerError[];
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

/** Every node with NO incoming edge among `nodes`/`out` — the fold's "source" set (round-4 review #3): the lane's own terminus (nothing structural cites it) plus, once folded in, each external grounds-citer (nothing in the merged graph ever cites a citer). */
function zeroIndegreeNodes(out: ReadonlyMap<number, ReadonlySet<number>>, nodes: ReadonlySet<number>): number[] {
  const hasIncoming = new Set<number>();
  for (const targets of out.values()) {
    for (const target of targets) {
      hasIncoming.add(target);
    }
  }
  return [...nodes].filter((node) => !hasIncoming.has(node)).sort((a, b) => a - b);
}

/** Fork (shared origin, in-degree > 1) and join/merge (multiple predecessors, out-degree > 1) nodes in a structural graph (round-4 review #7's report-4 diagnostic identity). */
function findForkJoinNodes(out: ReadonlyMap<number, ReadonlySet<number>>): { forkNodes: number[]; joinNodes: number[] } {
  const inDegree = new Map<number, number>();
  const joinNodes: number[] = [];
  for (const [citingId, targets] of out) {
    if (targets.size > 1) {
      joinNodes.push(citingId);
    }
    for (const target of targets) {
      inDegree.set(target, (inDegree.get(target) ?? 0) + 1);
    }
  }
  const forkNodes = [...inDegree.entries()]
    .filter(([, degree]) => degree > 1)
    .map(([id]) => id)
    .sort((a, b) => a - b);
  joinNodes.sort((a, b) => a - b);
  return { forkNodes, joinNodes };
}

/** Exact tag-SET equality (both pre-canonicalized: deduped, ascending) — deliberately NOT `sameLaneKey`/`laneToken`, which also fold in a segment; an edge carries no segment of its own, only its two endpoint turns do, so the interfaces exclusion (module header block (a)) compares tag arrays alone. */
function tagSetEqualsExact(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((tag, index) => tag === b[index]);
}

/**
 * Report 4(a), interfaces half (module header): for each unordered pair of
 * reported `lanes`, the count of `LANE_COMPONENT_RELATIONS` edges in the
 * FULL edge set with one endpoint a member of one lane and the other a
 * member of the other, excluding an edge whose own canonical tag set already
 * equals either lane's exact set — that edge is one of the lane's OWN
 * tagged edges (by `deriveLaneInterpretation`'s own grouping, an edge tagged
 * with a lane's exact set makes both its endpoints members of THAT lane,
 * never merely "the other side" of a crossing), not a crossing between two
 * distinct lanes. Only pairs with `count > 0` are emitted — a sparse report.
 */
function computeInterfaces(lanes: readonly Lane[], allEdges: readonly LaneEdgeInput[]): LaneInterfacePair[] {
  const memberSets = lanes.map((lane) => new Set(lane.members.map((member) => member.id)));
  const componentEdges = allEdges.filter((edge) => LANE_COMPONENT_RELATIONS.has(edge.relation));
  const pairs: LaneInterfacePair[] = [];
  for (let i = 0; i < lanes.length; i += 1) {
    for (let j = i + 1; j < lanes.length; j += 1) {
      const laneA = lanes[i]!;
      const laneB = lanes[j]!;
      const membersA = memberSets[i]!;
      const membersB = memberSets[j]!;
      let count = 0;
      for (const edge of componentEdges) {
        const crosses =
          (membersA.has(edge.citingId) && membersB.has(edge.citedId)) ||
          (membersB.has(edge.citingId) && membersA.has(edge.citedId));
        if (!crosses) continue;
        const edgeTagSet = canonicalTagSet(edge.tags);
        if (tagSetEqualsExact(edgeTagSet, laneA.key.tagSet) || tagSetEqualsExact(edgeTagSet, laneB.key.tagSet)) {
          continue;
        }
        count += 1;
      }
      if (count > 0) {
        pairs.push({ laneA: laneA.key, laneB: laneB.key, count });
      }
    }
  }
  return pairs;
}

/**
 * Report 4(a), bypass half (module header): per DECLARED lane (skipped
 * lanes have no current terminus to bypass), a `LANE_COMPONENT_RELATIONS`
 * edge whose citing turn is OUTSIDE the lane and whose cited turn IS a
 * member but is NOT `lane.declaration.terminus` — the event-reduced
 * terminus `lane-interpretation.ts` already computed, read here directly,
 * never re-derived. No tag-set exclusion is needed here (unlike the
 * interfaces half): an edge tagged with the lane's own exact set would make
 * its citing turn a member of the lane by construction, so "citing turn
 * outside the lane" already rules that case out structurally.
 */
function computeBypass(lanes: readonly Lane[], allEdges: readonly LaneEdgeInput[]): LaneBypassReport[] {
  const componentEdges = allEdges.filter((edge) => LANE_COMPONENT_RELATIONS.has(edge.relation));
  const reports: LaneBypassReport[] = [];
  for (const lane of lanes) {
    if (lane.declaration.state !== "declared" || lane.declaration.terminus === null) {
      continue;
    }
    const terminus = lane.declaration.terminus;
    const memberIds = new Set(lane.members.map((member) => member.id));
    const bypassEdges: LaneBypassEdge[] = [];
    for (const edge of componentEdges) {
      if (memberIds.has(edge.citingId)) continue; // must arrive from OUTSIDE the lane
      if (!memberIds.has(edge.citedId)) continue; // must land ON a member
      if (edge.citedId === terminus) continue; // landing on the terminus itself is not a bypass
      bypassEdges.push({
        citingId: edge.citingId,
        citedId: edge.citedId,
        relation: edge.relation,
        tags: canonicalTagSet(edge.tags),
      });
    }
    bypassEdges.sort((a, b) => a.citingId - b.citingId || a.citedId - b.citedId || a.relation.localeCompare(b.relation));
    reports.push({ key: lane.key, count: bypassEdges.length, edges: bypassEdges });
  }
  return reports;
}

/**
 * Report 4(c) (module header): every edge among the loaded turns, ALL EIGHT
 * relation words (no domain filter — aggregation/testimony included), must
 * have its citing turn postdate its cited turn. Self-citations are exempt.
 * Same-session pairs (`order[0]` equal) compare `order[1]` (`prompt_number`)
 * strictly greater; cross-session pairs never compare the `order` tuple at
 * all (the tuple-order trap — a `session_id` carries no wall-clock meaning
 * relative to another session's) and instead compare `createdAtEpoch`,
 * violating only when the citing turn's epoch is STRICTLY LESS than the
 * cited turn's (ties pass). A turn missing from `turnById`, or missing the
 * epoch a cross-session comparison needs, yields no judgement for edges
 * touching it — the same "never fabricate completeness" posture report 1's
 * `coverage` already takes, rather than a false pass or false violation.
 */
function computeTimeOrderViolations(
  turnById: ReadonlyMap<number, LaneTurnInput>,
  allEdges: readonly LaneEdgeInput[],
): LaneTimeOrderViolation[] {
  // Same fallback `lane-interpretation.ts`'s own internal `orderFor` uses: a
  // turn absent from the input, or one that never set `order`, defaults to
  // `[0, id]` — every such turn shares session "0" and is compared by its
  // own id as a same-session stand-in for prompt_number.
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
        tags: canonicalTagSet(edge.tags),
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
 * `MEMORY_TYPES` (semantic-conformance ticket 02, module header). Ascending
 * by id, UNCAPPED — `checkLanes` caps its own `vocabularyConformance` copy
 * for display, while E3 reads this full list (module header, "The ANCHOR":
 * a capped error list would let an instance past the commit gate).
 *
 * The computation itself is byte-for-byte the one ticket 02 shipped, cap
 * aside: tag-mandate ticket 03 reclassifies these facts, it does not
 * recompute them.
 */
function computeTypeViolations(turns: readonly LaneCheckerTurnInput[]): LaneTypeConformanceViolation[] {
  const violations: LaneTypeConformanceViolation[] = [];
  for (const turn of turns) {
    // Compact MARKER rows are exempt (acceptance ruling on ticket 02's
    // stop-and-report): they are infrastructure, not annotations — the
    // settlement facade refuses every write addressed at one ("is a compact
    // marker, not a turn"), so listing them would be permanent,
    // non-actionable noise in every window that contains a /compact.
    //
    // The OTHER exemption the spec names — legally-skipped turns — needs no
    // predicate here: `db/turn-liveness.ts`'s `liveTurnSql` keeps a skipped
    // (or rolled-back) turn out of every query in `db/lane-checker-load.ts`,
    // so such a turn never reaches this module's `turns` argument at all.
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

/** `{ count, entries }` from one uncapped, already-sorted fact list — the shared shape both `vocabularyConformance` halves use, `count` always the TRUE total. */
function cappedFactList<T>(all: readonly T[]): { count: number; entries: readonly T[] } {
  return { count: all.length, entries: all.slice(0, MAX_VOCABULARY_REPORT_ENTRIES) };
}

/**
 * The ONE gate (semantic-conformance ticket 02, module header): every edge
 * `checkLanes` receives is sorted here, BEFORE `deriveLaneInterpretation` or
 * any of reports 2/3/4's own graph builders ever run, into the in-vocabulary
 * set (passed on to every graph computation exactly as before) and the
 * out-of-vocabulary set (reported only — `computeTypeViolations`'s edge
 * counterpart, never passed to any of those builders). This is what makes
 * "never admitted" structural rather than a convention each graph builder
 * would otherwise have to separately honour.
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
 * Combine the out-of-vocabulary edges caught defensively inside `edges`
 * itself with the loader's own separately-supplied `knownOutOfVocabularyEdges`
 * (`checkLanes`'s third parameter) into one deduplicated, sorted, UNCAPPED
 * fact list — a caller may legitimately supply the same edge through both
 * channels (unlikely, but never double-counted). `checkLanes` caps its own
 * `vocabularyConformance` copy for display; E2 reads this full list.
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
 * E1 (module header): every `extends`/`narrows` row among the IN-VOCABULARY
 * edges whose own canonical tag set is empty. Anchored at the citing turn —
 * the side that owns the retract + tagged re-add repair. Reads `vocabEdges`
 * rather than the raw argument so a row is never double-classed: an
 * out-of-vocabulary relation is E2 and only E2, whatever it looks like.
 */
function computeUntaggedContinuationErrors(edges: readonly LaneEdgeInput[]): LaneUntaggedContinuationError[] {
  const errors: LaneUntaggedContinuationError[] = [];
  for (const edge of edges) {
    if (!MANDATED_LANE_RELATIONS.has(edge.relation)) continue;
    if (canonicalTagSet(edge.tags).length > 0) continue;
    errors.push({
      class: "E1",
      anchorId: edge.citingId,
      citingId: edge.citingId,
      citedId: edge.citedId,
      relation: edge.relation,
    });
  }
  return errors;
}

/**
 * E4 (module header): every tagged IN-VOCABULARY edge whose tag set is not a
 * subset of BOTH endpoint turns' own `tags`. The per-(tag, endpoint) `missing`
 * shape mirrors `turn-phase.ts`'s Gate B rejection detail exactly — a tag
 * absent from both sides is named twice, once per endpoint, so an agent
 * repairing one side does not discover the second gap only on a retry.
 *
 * A turn whose `tags` is `undefined` (not loaded, or an endpoint missing
 * from `turns` entirely) yields NO verdict for its side of the edge: the
 * same "never fabricate a verdict" posture report 4(c) takes for a missing
 * epoch. `[]` is a real, loaded, empty tag set and DOES violate.
 */
function computeSubsetInvariantErrors(
  turnById: ReadonlyMap<number, LaneCheckerTurnInput>,
  edges: readonly LaneEdgeInput[],
): LaneSubsetInvariantError[] {
  const errors: LaneSubsetInvariantError[] = [];
  for (const edge of edges) {
    const tags = canonicalTagSet(edge.tags);
    if (tags.length === 0) continue;
    const citingTags = turnById.get(edge.citingId)?.tags;
    const citedTags = turnById.get(edge.citedId)?.tags;
    const missing: LaneSubsetInvariantMiss[] = [];
    for (const tag of tags) {
      if (citingTags !== undefined && !citingTags.includes(tag)) {
        missing.push({ tag, endpoint: "citing" });
      }
      if (citedTags !== undefined && !citedTags.includes(tag)) {
        missing.push({ tag, endpoint: "cited" });
      }
    }
    if (missing.length === 0) continue;
    missing.sort((a, b) => a.endpoint.localeCompare(b.endpoint) || a.tag.localeCompare(b.tag));
    errors.push({
      class: "E4",
      anchorId: edge.citingId,
      citingId: edge.citingId,
      citedId: edge.citedId,
      relation: edge.relation,
      tags,
      missing,
    });
  }
  return errors;
}

/** Endpoint/identity tie-break shared by every error class, after `anchorId` and `class` — deterministic output for a byte-comparable render. */
function compareErrors(a: LaneCheckerError, b: LaneCheckerError): number {
  if (a.anchorId !== b.anchorId) return a.anchorId - b.anchorId;
  if (a.class !== b.class) return a.class.localeCompare(b.class);
  const citedA = a.class === "E3" ? a.id : a.citedId;
  const citedB = b.class === "E3" ? b.id : b.citedId;
  if (citedA !== citedB) return citedA - citedB;
  const relationA = a.class === "E3" ? "" : a.relation;
  const relationB = b.class === "E3" ? "" : b.relation;
  if (relationA !== relationB) return relationA.localeCompare(relationB);
  const tagsA = a.class === "E4" ? a.tags.join(",") : "";
  const tagsB = b.class === "E4" ? b.tags.join(",") : "";
  return tagsA.localeCompare(tagsB);
}

/**
 * Run all four reports (plus the vocabulary-conformance fact block,
 * semantic-conformance ticket 02) over one turn/edge set. Pure: no database,
 * no I/O, no write path imported — the DB adapter (ticket 06) is the only
 * place this touches storage, by translating rows into
 * `LaneTurnInput`/`LaneEdgeInput` and calling this function.
 *
 * `knownOutOfVocabularyEdges` (semantic-conformance ticket 02) is a SEPARATE
 * third argument, not folded into `edges`, on purpose: `db/lane-checker-
 * load.ts`'s `LaneCheckProjection` carries these on their own field too, so
 * a consumer that reduces `projection.edges` directly with
 * `deriveLaneInterpretation` (`mcp/note.ts`'s Gate C self-`grounds`
 * terminus check is the one other reader of that field in this codebase)
 * never sees an out-of-vocabulary relation at all, whatever tags it happens
 * to carry — merging it into the shared `edges` array would have widened
 * THAT caller's own graph re-derivation too, not just this function's.
 * `edges` itself is still partitioned defensively below (any out-of-
 * vocabulary relation a caller passes there is caught and reported, never
 * silently admitted), but the loader's own dedicated pass is expected to
 * arrive through this parameter instead.
 */
export function checkLanes(
  turns: readonly LaneCheckerTurnInput[],
  edges: readonly LaneEdgeInput[],
  knownOutOfVocabularyEdges: readonly LaneEdgeInput[] = [],
): LaneCheckerResult {
  // Partition FIRST (module header, "Vocabulary conformance"): every graph
  // computation below reads `vocabEdges`, never the raw `edges` parameter —
  // an out-of-vocabulary relation can never reach `deriveLaneInterpretation`
  // or any of reports 2/3/4's own graph builders, whatever tags it carries.
  const { inVocabulary: vocabEdges, outOfVocabulary: outOfVocabularyFromEdges } = partitionEdgesByVocabulary(edges);
  // Both fact lists are UNCAPPED here — `vocabularyConformance` below caps
  // its own display copy, while the E2/E3 halves of `errors` read these
  // (module header, "The ANCHOR": a capped error list would let an instance
  // past the commit gate by sorting late).
  const outOfVocabularyEdges = mergeOutOfVocabularyEdges(
    outOfVocabularyFromEdges,
    knownOutOfVocabularyEdges,
  );
  const typeViolations = computeTypeViolations(turns);
  const { lanes, warnings } = deriveLaneInterpretation(turns, vocabEdges);
  // Ticket 04: the ONE `deriveLaneStates` call for this whole run — every
  // lane's report-1 `state` field below is a lookup into this map, never a
  // fresh derivation (module header "Report 1 gains a state line").
  const laneStates = deriveLaneStates(lanes, turns);
  const turnById = new Map<number, LaneCheckerTurnInput>();
  for (const turn of turns) {
    turnById.set(turn.id, turn);
  }
  // Same fallback convention `lane-interpretation.ts`'s own `segmentFor`
  // uses: a turn absent from `turns` (partial coverage) reads as DEFAULT_SEGMENT.
  const segmentFor = (id: number): string => turnById.get(id)?.segment ?? DEFAULT_SEGMENT;

  // ---- shared global graph for reports 2/3, PARTITIONED BY SEGMENT (round-4
  // review #4b): a stance/consume/grounds edge only unions its two endpoints
  // when they share a segment — a node in segment B can never bridge two
  // members of segment A, even via a legal cross-segment `grounds` citation.
  // Turn ids are globally unique, so a single un-namespaced UnionFind is
  // still safe to key components/islands by; only the UNION step itself
  // needs the segment gate. ----
  const uf = new UnionFind();
  for (const turn of turns) {
    uf.add(turn.id);
  }
  for (const edge of vocabEdges) {
    uf.add(edge.citingId);
    uf.add(edge.citedId);
    if (LANE_COMPONENT_RELATIONS.has(edge.relation) && segmentFor(edge.citingId) === segmentFor(edge.citedId)) {
      uf.union(edge.citingId, edge.citedId);
    }
  }

  const laneStats: LaneStatsReport[] = [];
  const componentReports: LaneComponentReport[] = [];
  const pathReports: LanePathReport[] = [];
  const componentLanes = new Map<number, LaneKey[]>();
  // root -> nodeId -> the set of (this component's) lane tokens that count the node a member — report 3's shared-node identity.
  const componentNodeLanes = new Map<number, Map<number, Set<string>>>();
  // citedId -> laneToken -> LaneKey, for every STANCE-tagged citation — report 3's designed-shape annotation.
  const stanceCitersByNode = new Map<number, Map<string, LaneKey>>();

  for (const lane of lanes) {
    const memberIds = new Set(lane.members.map((member) => member.id));
    const thisLaneToken = laneToken(lane.key.segment, lane.key.tagSet);
    // Guaranteed present: `deriveLaneStates` keys one entry per lane in
    // `lanes`, by that same lane's own token, and `lane` is drawn from that
    // identical `lanes` array — see `checkLanes`'s own `laneStates` call above.
    const laneState = laneStates.get(thisLaneToken)!;

    // ---- Report 1 ----
    laneStats.push(buildLaneStats(lane, laneState, memberIds, turnById, vocabEdges));

    for (const edge of lane.taggedEdges) {
      if (!STANCE_RELATION_WORDS.has(edge.relation)) continue;
      // Both directions register (round-5 review #15): a node CITED by a
      // stance edge is a shared fork root (the original reading), and a
      // node CITING via a stance edge into two different lanes is equally a
      // designed shape — a merge node, T3 --{left}--> T1 and T3 --{right}-->
      // T2 at once. Both read off the SAME map/field: `citingLanesByStance`
      // is "every distinct lane this node touches via one of its own stance
      // edges", not "cited-side only".
      for (const nodeId of [edge.citedId, edge.citingId]) {
        let bucket = stanceCitersByNode.get(nodeId);
        if (bucket === undefined) {
          bucket = new Map();
          stanceCitersByNode.set(nodeId, bucket);
        }
        bucket.set(thisLaneToken, lane.key);
      }
    }

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
      let nodeLaneMap = componentNodeLanes.get(root);
      if (nodeLaneMap === undefined) {
        nodeLaneMap = new Map();
        componentNodeLanes.set(root, nodeLaneMap);
      }
      let laneTokens = nodeLaneMap.get(id);
      if (laneTokens === undefined) {
        laneTokens = new Set();
        nodeLaneMap.set(id, laneTokens);
      }
      laneTokens.add(thisLaneToken);
    }
    const islands: LaneIsland[] = [...islandsByRoot.entries()]
      .map(([, ids]) => {
        const sorted = ids.sort((a, b) => a - b);
        return { representative: sorted[0]!, memberIds: sorted };
      })
      .sort((a, b) => a.representative - b.representative);
    componentReports.push({ key: lane.key, componentCount: islands.length, islands });

    // ---- Report 4 ----
    pathReports.push(buildPathReport(lane, memberIds, vocabEdges, lanes));
  }

  const multiLaneComponents: MultiLaneComponent[] = [...componentLanes.entries()]
    .filter(([, laneKeys]) => laneKeys.length > 1)
    .map(([representative, laneKeys]) => {
      const nodeLaneMap = componentNodeLanes.get(representative) ?? new Map<number, Set<string>>();
      const sharedNodes: LaneSharedNode[] = [...nodeLaneMap.entries()]
        .filter(([, laneTokens]) => laneTokens.size > 1)
        .map(([id]) => {
          const citers = stanceCitersByNode.get(id);
          const citingLanesByStance = citers ? [...citers.values()] : [];
          return { id, citingLanesByStance, designedShape: citingLanesByStance.length >= 2 };
        })
        .sort((a, b) => a.id - b.id);
      return { representative, lanes: laneKeys, sharedNodes };
    })
    .sort((a, b) => a.representative - b.representative);

  const interfaces = computeInterfaces(lanes, vocabEdges);
  const bypass = computeBypass(lanes, vocabEdges);
  const timeOrderViolations = computeTimeOrderViolations(turnById, vocabEdges);

  // ---- ERRORS (tag-mandate ticket 03, module header). E2/E3 are the SAME
  // uncapped fact lists `vocabularyConformance` caps for display, classed
  // rather than recomputed; E1/E4 are this ticket's own two computations.
  // The list stays uncapped — the commit gate filters it by `anchorId`. ----
  const errors: LaneCheckerError[] = [
    ...computeUntaggedContinuationErrors(vocabEdges),
    ...outOfVocabularyEdges.map(
      (edge): LaneOutOfVocabularyRelationError => ({
        class: "E2",
        anchorId: edge.citingId,
        citingId: edge.citingId,
        citedId: edge.citedId,
        relation: edge.relation,
      }),
    ),
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
    multiLaneComponents,
    interfaces,
    bypass,
    paths: pathReports,
    timeOrderViolations,
    warnings,
    vocabularyConformance: {
      typeViolations: cappedFactList(typeViolations),
      outOfVocabularyEdges: cappedFactList(outOfVocabularyEdges),
    },
    errors,
  };
}

/** Segment + exact canonical tag set equality — via `laneToken`'s own escaped join (round-4 review #6: a plain `tagSet.join("")` collides `{"a","bc"}` with `{"ab","c"}`). */
function sameLaneKey(a: LaneKey, b: LaneKey): boolean {
  return laneToken(a.segment, a.tagSet) === laneToken(b.segment, b.tagSet);
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

  const missingTurnIds = [...memberIds].filter((id) => !turnById.has(id)).sort((a, b) => a - b);

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

function buildPathReport(
  lane: Lane,
  memberIds: ReadonlySet<number>,
  allEdges: readonly LaneEdgeInput[],
  allLanes: readonly Lane[],
): LanePathReport {
  const structuralPairs: Array<readonly [number, number]> = lane.taggedEdges
    .filter((edge) => LANE_PATH_RELATIONS.has(edge.relation))
    .map((edge) => [edge.citingId, edge.citedId] as const);
  const baseGraph = buildPathGraph(structuralPairs);
  const { forkNodes, joinNodes } = findForkJoinNodes(baseGraph.out);

  if (lane.declaration.state !== "declared" || lane.declaration.terminus === null) {
    return {
      key: lane.key,
      status: "skipped",
      skipReason: lane.declaration.state === "reopened" ? "reopened" : "undeclared",
      starts: [...baseGraph.starts].sort((a, b) => a - b),
      terminus: null,
      pathCount: null,
      forkNodes,
      joinNodes,
      folded: null,
    };
  }

  const terminus = lane.declaration.terminus;
  const pathCount = countPaths(terminus, baseGraph.starts, baseGraph.out);

  // Fold (round-4 review #3): merged graph = the lane's own structural pairs
  // plus, for each external grounds-citer of a member, its own entry edge
  // (citer -> member). The folded count sums `countPaths` from EVERY node
  // with no incoming edge in that merged graph — the terminus (as always)
  // AND each external citer (new) — see the module header's FOLD SEMANTICS
  // note for why summing sources, not just re-walking from the terminus, is
  // the only reading under which folding can ever change anything.
  const crossPhaseGrounds = allEdges.filter(
    (edge) => edge.relation === "grounds" && memberIds.has(edge.citedId) && !memberIds.has(edge.citingId),
  );

  // Round-5 review #11: "two lanes citing across phases counted as one
  // merged graph" means the merge is of LANES, not just of the one grounds
  // edge — when an external citer is ITSELF a member of another lane, that
  // lane's own path-domain (stance+consume) edges join the merged graph
  // too, so the citer's own chain back to ITS lane's starts is reachable
  // and gets summed, not just the citer's bare entry edge into this lane.
  // Guarded against double-counting: a lane is folded in at most once even
  // if several citers share it, and this lane's own token is pre-seeded so
  // it can never be re-added to itself (a citer can never be a member of
  // `lane` — `crossPhaseGrounds` already filtered `!memberIds.has(citingId)`
  // — but the guard is kept explicit rather than relying on that exclusion
  // alone).
  const thisLaneToken = laneToken(lane.key.segment, lane.key.tagSet);
  const foldedInLanes = new Set<string>([thisLaneToken]);
  const citerLanePairs: Array<readonly [number, number]> = [];
  for (const citerId of new Set(crossPhaseGrounds.map((edge) => edge.citingId))) {
    for (const otherLane of allLanes) {
      const token = laneToken(otherLane.key.segment, otherLane.key.tagSet);
      if (foldedInLanes.has(token)) continue;
      if (!otherLane.members.some((member) => member.id === citerId)) continue;
      foldedInLanes.add(token);
      for (const edge of otherLane.taggedEdges) {
        if (LANE_PATH_RELATIONS.has(edge.relation)) {
          citerLanePairs.push([edge.citingId, edge.citedId]);
        }
      }
    }
  }

  const foldedPairs: Array<readonly [number, number]> = [
    ...structuralPairs,
    ...crossPhaseGrounds.map((edge) => [edge.citingId, edge.citedId] as const),
    ...citerLanePairs,
  ];
  const foldedGraph = buildPathGraph(foldedPairs);
  const foldedNodes = new Set<number>([terminus]);
  for (const [citingId, citedId] of foldedPairs) {
    foldedNodes.add(citingId);
    foldedNodes.add(citedId);
  }
  const foldedSources = zeroIndegreeNodes(foldedGraph.out, foldedNodes);
  const foldedPathCount = foldedSources.reduce(
    (sum, source) => sum + countPaths(source, foldedGraph.starts, foldedGraph.out),
    0,
  );

  return {
    key: lane.key,
    status: "ok",
    starts: [...baseGraph.starts].sort((a, b) => a - b),
    terminus,
    pathCount,
    forkNodes,
    joinNodes,
    folded: {
      citingTurnsFolded: [...new Set(crossPhaseGrounds.map((edge) => edge.citingId))].sort((a, b) => a - b),
      pathCount: foldedPathCount,
    },
  };
}

// Re-exported so a consumer that only wants tag-set canonicalisation need not
// also import lane-interpretation.ts directly.
export { canonicalTagSet };
