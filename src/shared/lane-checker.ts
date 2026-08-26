/**
 * v11 lane-model FOUR-REPORT CHECKER (rubric-v10 ticket 05, issue's "Report
 * domains" paragraph, T1300/T1321/T1323; identity narrowed to ONE tag per
 * lane by lane-declaration spec Rev 2, D5). Built on `lane-interpretation.ts`'s
 * pure enumeration/reduction — this module adds the four report shapes and
 * nothing else: no rendering, no candidate-edge suggestions, no advisory
 * text. Numbers, names, states only; the CLI/settlement-tool renderers
 * (ticket 06) are the only consumers that turn this into prose or a digraph.
 *
 * `LaneKey` is `{segment, tag}`, not `{segment, tagSet}`.
 *
 * ## MEMBERSHIP IS A NODE FACT (lane-model-v12 D5, ticket 10)
 *
 * A turn is a member of the lanes its OWN tags name — `LaneTurnInput.laneTags`,
 * resolved by `db/lane-checker-load.ts` against the segment's declared lanes.
 * Nothing in this module enumerates a member from an edge endpoint any more.
 * Two reports read that change directly and neither needed new code, only a
 * corrected doctrine:
 *
 *   - report 1's `members`/`phases`, which now include a turn that carries
 *     the lane's tag and has no edge at all — the member v11 could not see;
 *   - the D9 unattributed-cluster warning, whose "carries no lane tag" test
 *     is now exactly what its name says (see its own section below, where the
 *     old EDGE-fact reading and the reason it is retired are recorded).
 *
 * `Lane.latestMember` is the third: it is what `deriveLaneStates` reads for
 * closed/open, so a lane whose newest member merely carries the tag is OPEN
 * however long ago its terminus was declared.
 *
 * ## THIS MODULE NEVER READS `edge.tags` (lane-model-v12 D1/D6, ticket 06)
 *
 * Every lane fact about an EDGE comes off its two SIDE tags, through exactly
 * two predicates that `lane-interpretation.ts` owns:
 *
 *   - `laneMembershipClaims` — which lane an edge belongs to (never which
 *     lane a NODE belongs to; the name predates ticket 10). Consumed
 *     INDIRECTLY, via `deriveLaneInterpretation`'s `lanes`/`taggedEdges`;
 *     nothing here re-derives attribution.
 *   - `laneEdgeTags` — the tags an edge NAMES, as a canonical set. The
 *     drop-in for the old `canonicalTagSet(edge.tags)` at the display sites
 *     (`LaneBypassEdge.tags`, `LaneTimeOrderViolation.tags`,
 *     `LaneSubsetInvariantError.tags`) and at the "is this edge attributed at
 *     all" sites (`unionsLaneComponentGraph`, D9's cluster warning).
 *
 * Two places do NOT take `laneEdgeTags`, on purpose, because collapsing two
 * sides into one set gives the wrong answer there: `edgeIsInternalToTag`
 * (report 4(a)'s exclusion, which needs "both sides agree", not "either side
 * mentions") and `subsetObligations` (E4, which needs to know WHICH side owes
 * a tag). Both carry their own reasoning at the definition.
 *
 * The switch moves NO report number on today's stock: every stored edge has
 * `tail === head` (a single-tag write) or two sentinels (untagged), so
 * `laneEdgeTags` returns exactly what the merged set did. The shapes that
 * differ — a cross-lane edge, a cross-segment edge — could not be stored at
 * all before v12.
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
 *       an edge INTERNAL to either lane (`edgeIsInternalToTag` — a lane's own
 *       structural edge is never counted as crossing INTO itself; a
 *       CROSS-LANE edge is not internal to either and IS counted, which is
 *       the whole point of the report). Per DECLARED lane, bypass counts an incoming same-domain
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
 * ## Report domains — a lane's own graph vs the external structure (lane-declaration ticket 12, P1-7)
 *
 * Every lane-shaped question a lane's OWN graph asks — membership
 * (`lane-interpretation.ts`, word-agnostic: its grouping loop keys on the
 * two SIDE tags alone, never `edge.relation`), component (report
 * 2/3, below) and path (report 4(b), `LANE_PATH_RELATIONS`) — reads the SAME
 * predicate: an edge belongs to lane X's own structural graph exactly when
 * it CLAIMS X (`laneMembershipClaims`), whatever the relation word is. Two words are excluded
 * regardless of tag, for reasons unrelated to phase and unchanged by this
 * ticket: `indexes` (rubric: "indexes 不参与连通性计算" — a declaration is not
 * a step of the path/component) and `override` (a graph-STATE event read by
 * `lane-interpretation.ts`'s reduction, not a structural join). Every other
 * word — narrows/extends/consume (same-phase) and, since the user's ruling
 * [T1562] widened which words may carry a tag, grounds/verifies/refutes
 * (cross-phase) alike — is structural for whichever lane(s) its own tag set
 * names.
 *
 * This is a SEPARATE question from the EXTERNAL structure, which keeps
 * asking its own (AC2): `LANE_COMPONENT_RELATIONS` (stance + consume +
 * grounds) is the TAG-AGNOSTIC word-set reports 2/3's shared global graph
 * and `computeInterfaces`/`computeBypass` read, UNCHANGED by this ticket —
 * an UNTAGGED `grounds` edge legitimately bridges two lanes' neighbourhoods
 * here, exactly as it always has (that behaviour predates the tag-widening
 * and is not this ticket's concern). `verifies`/`refutes` are deliberately
 * NOT added to this word-set even now: an untagged testimony edge stays a
 * pure citedness fact (report 1) and never bridges a component or counts as
 * an interface/bypass crossing — admitting it tag-agnostically here is
 * exactly the "naive widening" the ticket rejects. A TAGGED `verifies`/
 * `refutes` (or `grounds`) edge still reaches reports 2/3's shared graph,
 * but through the OTHER predicate — `checkLanes`'s own union step ORs
 * `LANE_COMPONENT_RELATIONS` membership with "this edge carries some lane's
 * own tag and is not indexes/override" (`unionsLaneComponentGraph` below):
 * two predicates, never one relation-set union. `computeInterfaces`/
 * `computeBypass` deliberately do NOT gain this second predicate — both
 * select on `edge.relation` alone (the side tags enter `computeInterfaces`
 * only through its own EXCLUSION, `edgeIsInternalToTag`), so a tagged
 * testimony edge takes the identical (excluded) code path an untagged one
 * already does. They
 * measure the crossing BETWEEN two different lanes, which is exactly the
 * domain AC2 says keeps asking its own question, and nothing in the ticket
 * asks it to widen.
 *
 * Report 4 counts NODE paths (parallel relations on one pair are ONE route,
 * the T1241 precedent — enforced by de-duplicating the adjacency into a
 * `Set` per source node) over the lane's own tagged STRUCTURAL edges
 * (`LANE_PATH_RELATIONS` — every word except indexes/override; ticket 12
 * widened this from stance+consume alone). A TAGGED `grounds`/`verifies`/
 * `refutes` edge is now an ordinary member of this BASE graph — not routed
 * through the fold at all. The fold below still exists for what the tag
 * predicate can never cover: an UNTAGGED cross-phase citation from a turn
 * that is NOT a member of this lane. Because a tagged edge's citing turn is
 * always a member by construction (`lane-interpretation.ts`'s grouping), the
 * fold's own `!memberIds.has(citingId)` guard already keeps a lane's own
 * tagged cross-phase edges out of the fold, so admitting them into the base
 * graph creates no double-count. `verifies`/`refutes` citations still never
 * fold when UNTAGGED-and-external — they participate as cited-ness FACTS
 * (report 1, `citedness`) and coupling display but never add to path counts
 * (duplicate probes are legal fact multiplicity, not extra routes); that
 * half of the design is unchanged.
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
 * OPEN. `state` is the corrected reading: CLOSED or OPEN, and nothing else
 * (lane-model-v12 ticket 04 deleted the two refinements it used to carry —
 * a closed lane's own quality verdict, which asked a question about node death,
 * and an open lane's most-recent declarer, which was a seat v12 has no
 * reopen mechanism to justify).
 *
 * `usedFromNonMembers` sits alongside `groundsFromNonMembers`/
 * `testimonyFromNonMembers` in `citedness`, same lane-wide "target is ANY
 * member, citer is NOT a member" filter, for relation `consume` (any tag
 * state — a `consume` edge carrying THIS lane's own tag would already make
 * its citing turn a member by construction, so "citer is not a
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
 * ## Attribution warnings (lane-declaration D9, ticket 09) — the pressure that replaced the mandate
 *
 * E1 (an untagged `extends`/`narrows` is an error) is retired, so NOTHING
 * forces a tag any more. These two WARNINGS are the whole of what keeps lanes
 * from either disappearing (nobody attributes anything) or multiplying
 * (everybody declares their own). Neither is an error, neither blocks a
 * commit, and `lane_check` prints both.
 *
 *   (1) UNATTRIBUTED CLUSTER (`computeUnattributedClusters`) — 4+ turns that
 *       carry no lane tag AND are connected to EACH OTHER by untagged edges.
 *       Three or fewer is silence: a short exchange is not a workflow.
 *
 *       "CARRIES NO LANE TAG" IS A NODE FACT (lane-model-v12 D5, ticket 10).
 *       A turn carries a lane tag exactly when it is a MEMBER of some derived
 *       lane, and membership is now the turn's OWN resolved `laneTags` —
 *       still read through `lanes[].members`, so this computation is
 *       unchanged line for line, but the fact underneath it is the opposite
 *       one.
 *
 *       THE READING THIS REPLACED, and why it was right at the time (peer
 *       P1-8): under v11 a turn was attributed only by being the endpoint of
 *       an edge that CLAIMED a lane, and the turn's own `tags` column was
 *       deliberately NOT read, because the rubric then called it merely the
 *       ADMISSION condition ("节点自身的 tags 含该 tag 只是准入的必要条件,不
 *       构成成员"). Reading it as membership would have exempted exactly the
 *       turns nobody had wired up — the false negatives this warning exists
 *       to surface. v12 deletes that distinction at the model level: the
 *       column IS membership. What keeps the warning honest instead is that
 *       `laneTags` is registry-filtered, so an undeclared word still exempts
 *       nobody, and an unowned (segment-less) turn cannot claim its way out
 *       of a cluster either.
 *
 *       THE DOMAIN IS THE CLUSTER, NOT THE COMPONENT [S15069/T1553]. A
 *       component-level rule is measurably dead: `LANE_COMPONENT_RELATIONS`
 *       includes `grounds`, so on a mature segment nearly everything hangs
 *       off something tagged (one real E60 component holds 77 turns) and "no
 *       member of this component carries a tag" essentially never holds. The
 *       cluster is computed the other way round — attributed turns are
 *       REMOVED first, and connectivity is measured over what is left. A
 *       tagged member elsewhere in the same component therefore excuses
 *       nothing.
 *
 *       THE RELATION DOMAIN IS NAMED (`UNATTRIBUTED_CLUSTER_RELATIONS`), so
 *       an evidence line joined only by `verifies`/`refutes` cannot appear
 *       and disappear with a word-set chosen for some other report.
 *
 *       THE EXCUSE IS PER-MEMBER (peer P1-9). An untagged `indexes` is free
 *       aggregation — the rubric's own "无 tag = 自由聚合(如发布索引所运工件)"
 *       — so its CITED endpoints are excused and dropped, and the REST is
 *       re-evaluated as an induced subgraph, still warning at 4+. Excusing
 *       the whole cluster instead would let a release indexing two artifacts
 *       silence a hundred-turn orphan cluster; requiring two or more
 *       aggregated members before any excuse applies would make a legal
 *       four-turn one-off that ships a single artifact warn forever. (Spec
 *       D9's older "a cluster is EXCUSED when some node aggregates two or
 *       more of its members" phrasing is superseded by the ticket's
 *       induced-subgraph rule, which is what is implemented.)
 *
 *   (2) LANE PROLIFERATION (`computeLaneProliferation`) — a segment whose
 *       DECLARED lane count exceeds `max(1, 0.05 × its member turn count)`,
 *       both numbers named. The 0.05 is the user's ruling; the `max(1, …)`
 *       is peer P2-12 (without it a 19-turn segment's single legitimate lane
 *       warns forever and then falls silent at 20 turns).
 *
 *       This is a per-SEGMENT fact and both counts arrive from the DB
 *       adapter's `LaneCheckProjection.segmentFacts` (`db/lane-checker-
 *       load.ts`'s `loadSegmentFacts`: `COUNT(*)` over the `lanes` REGISTRY
 *       and `COUNT(DISTINCT turn_id)` over live `segment_members`), never
 *       inferred from the lanes/turns this projection happens to hold (peer
 *       P1-11) — otherwise the same segment yields different verdicts from a
 *       4-turn settlement window and a 100-turn one. A caller that supplies
 *       no facts (a hand-built fixture, a surface that never loaded them)
 *       gets no proliferation verdict at all rather than a fabricated one.
 *
 *       Ticket 14 reconciled the numerator with the registry: a declared
 *       lane with NO live member still counts (declare-before-use makes
 *       "unused" the normal birth state, so excluding it would exempt
 *       exactly the accumulation this budget exists to catch), and the
 *       warning NAMES those lanes (`emptyLaneTags`) as the removable part
 *       of the count. Silently padding the ratio with lanes no reader can
 *       see was the one outcome ruled out.
 *
 * ## ERRORS vs WARNINGS (tag-mandate ticket 03, spec "Error classes")
 *
 * Every finding above is a WARNING — the three principles' aspirational
 * facts (connectivity, entanglement, minimality, time-order, undeclared
 * lanes, terminus citedness). None of their computations changed with this
 * ticket; they were reclassified, not rewritten.
 *
 * `errors` is the new, separate list: states the GRAMMAR FORBIDS. Four
 * classes ship: E2-E4 (tag-mandate ticket 03).
 *
 * **E1 IS RETIRED** (lane-declaration ticket 02, [S15069/T1548]). It was "an
 * `extends`/`narrows` row carrying NO lane tags", the stock half of the tag
 * mandate. The mandate is withdrawn — no word requires a tag — so an untagged
 * stance edge is an ordinary legal edge and there is nothing left to report.
 * The class NUMBERS do not shift: E2-E4 keep the identifiers every prompt,
 * refusal line and test already spells, and a retired number is cheaper than
 * four renamed ones. The pressure that replaces E1 is D9's two WARNINGS
 * (unattributed cluster, lane proliferation — ticket 09), never a refusal.
 *
 *   - **E2** an out-of-vocabulary relation word (e.g. the frozen-legacy
 *     `supersedes`). Same raw facts `vocabularyConformance.outOfVocabularyEdges`
 *     reports — classed, not recomputed.
 *   - **E3** an EMPTY or out-of-vocabulary turn `type`. Same raw facts
 *     `vocabularyConformance.typeViolations` reports, exemptions carried
 *     over intact: compact markers are skipped here, and legally-SKIPPED /
 *     rolled-back turns never reach this module at all (`db/turn-liveness.ts`'s
 *     `liveTurnSql`, applied by every query in `db/lane-checker-load.ts` — the
 *     exemption is structural at the loader, not a predicate restated here).
 *   - **E4** an edge one of whose SIDE tags is absent from that side's own
 *     endpoint turn's `tags` — PER SIDE (v12 D2 rule 3): `tailTag` against
 *     the CITING turn, `headTag` against the CITED one. The subset invariant
 *     `turn-phase.ts`'s Gate B enforces at write time, checked again over
 *     STOCK because a later tag EDIT on an endpoint turn can orphan a row
 *     the gate once passed.
 * ### The ANCHOR (spec "Anchoring and repairability") — the load-bearing field
 *
 * Every error instance carries `anchorId`: an EDGE error anchors at its
 * CITING turn and a TYPE error at the turn itself. The settlement commit gate
 * (ticket 05) counts only instances anchored inside the window's writable
 * scope, so an error anchored outside blocks its OWN window and never this
 * one — without that scoping one bad out-of-window edge would pin a window
 * on a permanently failing commit. Two properties make the anchor
 * trustworthy and MUST hold through any change here:
 *
 *   1. `anchorId` is always a turn id the repairing agent can address —
 *      never an edge row id, never a lane token — and for an edge error it
 *      is the CITING side, because retract/re-add is the citing turn's own
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
  compareOrderKeyAcrossSessions,
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

/** `STANCE_RELATIONS` widened to `ReadonlySet<string>` so it can test a plain `LaneEdgeInput.relation` without a cast at each call site. */
const STANCE_RELATION_WORDS: ReadonlySet<string> = STANCE_RELATIONS;

/** `EDGE_RELATIONS` (the eight-word write vocabulary) widened to `ReadonlySet<string>` — the ONE gate `checkLanes` partitions its raw `edges` argument through before any graph computation ever sees it (semantic-conformance ticket 02, module header). */
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
 * The EXTERNAL, tag-agnostic bridge domain reports 2/3's shared graph and
 * `computeInterfaces`/`computeBypass` read — stance (narrows/extends) +
 * consume + grounds, UNCHANGED by ticket 12's widening (module header,
 * "Report domains"). This is HALF of reports 2/3's own union test now: a
 * lane's own TAGGED structural edge (any word except indexes/override) is
 * the other half, checked directly against the edge's own tag set rather
 * than folded into this word-set (`unionsLaneComponentGraph` below) — the
 * two-predicate design that keeps an UNTAGGED `verifies`/`refutes` edge a
 * pure citedness fact, never a bridge. `computeInterfaces`/`computeBypass`
 * intentionally read ONLY this word-set, unchanged. Undirected.
 */
export const LANE_COMPONENT_RELATIONS: ReadonlySet<string> = new Set([
  ...STANCE_RELATIONS,
  "consume",
  "grounds",
]);

/**
 * Report 4's base (unfolded) path graph: the lane's own tagged STRUCTURAL
 * edges — every relation except `indexes` (a declaration is not a step of
 * the path) and `override` (a graph-state event, not a join). Ticket 12
 * widened this from stance+consume alone to admit a tagged `grounds`/
 * `verifies`/`refutes` edge as an ordinary hop: `lane.taggedEdges` (this
 * set's only ever caller) is already scoped to the lane's own tag, so there
 * is no untagged-testimony leak to guard against here (module header).
 */
export const LANE_PATH_RELATIONS: ReadonlySet<string> = new Set(
  EDGE_RELATIONS.filter((relation) => relation !== "indexes" && relation !== "override"),
);

/**
 * The relation domain of the unattributed-cluster warning's "connected to
 * each other by untagged edges" test (D9, ticket 09) — declared HERE, in its
 * own name, because the ticket requires it pinned: an evidence line joined
 * only by `verifies`/`refutes` must not appear and disappear with a word-set
 * chosen for some other report.
 *
 * The same six words `LANE_PATH_RELATIONS` holds (every relation except
 * `indexes` and `override`) and for the same reason, stated for THIS
 * question: the cluster test asks "would these turns have been one lane's
 * BODY, had anyone tagged them", so its connectivity domain is the one a
 * lane's body would itself have used. `indexes` is out because the rubric
 * keeps it out of connectivity ("indexes 不参与连通性计算") AND because an
 * untagged `indexes` plays the opposite role here — it EXCUSES what it
 * aggregates rather than connecting it. `override` is out because it is a
 * graph-STATE event, not a structural join.
 *
 * Deliberately NOT `LANE_COMPONENT_RELATIONS`: that is the tag-agnostic
 * EXTERNAL bridge domain (stance + consume + grounds), which both admits
 * `grounds` — the reason a component-level rule never fires on a mature
 * segment, where one real E60 component holds 77 turns — and excludes
 * testimony, which would drop an evidence-only line out of the judgment
 * entirely. Kept as its own constant rather than an alias so a future change
 * to one report's path domain cannot silently move this warning's boundary.
 */
export const UNATTRIBUTED_CLUSTER_RELATIONS: ReadonlySet<string> = new Set(
  EDGE_RELATIONS.filter((relation) => relation !== "indexes" && relation !== "override"),
);

/**
 * The cluster-size boundary (D9): 4+ warns, 3 or fewer is silence — "a short
 * exchange is not a workflow".
 */
const MIN_UNATTRIBUTED_CLUSTER_TURNS = 4;

/** Per-cluster display cap for the named turns; `LaneUnattributedCluster.turnCount` is always the TRUE total. */
const MAX_CLUSTER_TURN_ENTRIES = 20;

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
   *
   * TICKET 10 MOVED WHAT THIS COUNTS, to keep it from becoming a field that
   * can never be non-empty. It used to be "MEMBER ids missing from `turns`",
   * which was reachable only while members were enumerated FROM edges;
   * membership is now the turn's own `laneTags`, so a member is by
   * construction a loaded turn and that reading is vacuously always-empty.
   * The truncation it was watching for is real either way, and an edge
   * endpoint is where it now shows.
   */
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
  /** `lane-interpretation.ts`'s `deriveLaneStates` output for this lane, consumed directly — see module header "Report 1 gains a state line". The corrected closed/open reading; never re-derive this from `declaration` here. */
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
  /** `laneEdgeTags` — the tags the edge's two SIDES name, `[]` when unsettled (a bypass edge is never one of the lane's own internal edges, so this is almost always `[]`, a third lane's tag, or a cross-lane pair, never the target lane's own). */
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
  /** `laneEdgeTags` — the tags the edge's two SIDES name; display only, this report has no tag domain. */
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

// ----------------------------------------------- Attribution warnings (D9)

/**
 * One cluster of 4+ turns carrying no lane tag, connected to each other by
 * untagged `UNATTRIBUTED_CLUSTER_RELATIONS` edges after every untagged-
 * `indexes`-aggregated member has been excused out (module header,
 * "Attribution warnings"). A WARNING: nothing refuses on it.
 */
export interface LaneUnattributedCluster {
  /** The cluster's turns, ascending — CAPPED at `MAX_CLUSTER_TURN_ENTRIES` for display. */
  turnIds: readonly number[];
  /** The TRUE size of the cluster, never capped — this is the number the 4+ boundary was judged on. */
  turnCount: number;
}

/**
 * One SEGMENT whose declared lane count exceeds `max(1, 0.05 × member turn
 * count)` (module header). Both counts come from `LaneSegmentFacts`, i.e.
 * from the registry and the membership table, never from this projection's
 * own lanes/turns.
 */
export interface LaneProliferationWarning {
  /** `LaneKey.segment` form — the stringified `segments.id`. */
  segment: string;
  declaredLaneCount: number;
  memberTurnCount: number;
  /** `max(1, 0.05 × memberTurnCount)` — carried so the render states the line the count was judged against, rather than recomputing it. */
  allowance: number;
  /**
   * Ticket 14: the declared lanes among `declaredLaneCount` that have NO live
   * member — the removable remainder of the count that just tripped. Empty
   * when every declared lane is visible; absent when the caller's facts did
   * not carry the field at all (see `LaneSegmentFacts.emptyLaneTags`).
   */
  emptyLaneTags?: readonly string[];
}

/**
 * The per-SEGMENT counts the proliferation warning is judged on, supplied by
 * the DB adapter (`db/lane-checker-load.ts`'s `loadSegmentFacts`, which fills
 * `LaneCheckProjection.segmentFacts`) — NEVER derived from the `turns`/
 * `edges` this function receives (peer P1-11: the same segment must not yield
 * a different verdict from a 4-turn settlement window than from a 100-turn
 * one). A caller supplying none gets no proliferation verdict, the same
 * "never fabricate completeness" posture report 1's `coverage` takes.
 */
export interface LaneSegmentFacts {
  /** `LaneKey.segment` form — the stringified `segments.id`. */
  segment: string;
  /** `COUNT(*)` over the `lanes` REGISTRY for this segment — EVERY declared lane, including one with no live member (see `emptyLaneTags`). */
  declaredLaneCount: number;
  /** `COUNT(DISTINCT turn_id)` over this segment's LIVE `segment_members`. */
  memberTurnCount: number;
  /**
   * Ticket 14 — the reconciliation between the numerator and the registry.
   * The declared lanes of this segment that no reader can see: no LIVE
   * tagged edge (both endpoints live, law 8) carries the tag with an
   * endpoint owned by this segment, so the lane has no member at all.
   *
   * THE RULE: such a lane STILL COUNTS in `declaredLaneCount`. A declared
   * lane is a real budget cost whether or not it has been used yet — the
   * rubric mandates declare-BEFORE-use, so "unused" is the normal birth
   * state, and excluding the unused from the numerator would let any number
   * of them accumulate free of exactly the budget that exists to catch them.
   * The inflation is answered by NAMING them instead: they ride into the
   * warning that trips, where they are the part of the count a reader can
   * act on (`undeclare` clears them, which ticket 14's own guard repair is
   * what actually made possible).
   *
   * Reported only THROUGH the proliferation warning, never as a standing
   * fact of its own: under declare-before-use an empty lane is a normal
   * transient, so an always-on report would fire on every fresh declare.
   *
   * `undefined` = the caller supplied no such field (a hand-built fixture) —
   * the same "never fabricate completeness" posture as `LaneCheckerTurnInput.
   * tags`; `[]` = supplied, and every declared lane has a live member.
   */
  emptyLaneTags?: readonly string[];
}

// ------------------------------------------------------ Errors (E2-E4)

/**
 * One taggable input turn, widened with the turn's OWN stored tag set —
 * `LaneTurnInput` (the pure interpretation core's input) carries `type` but
 * never `tags`, and E4's subset invariant needs both endpoints' tags. Every
 * existing caller that hands over plain `LaneTurnInput`s still typechecks
 * (the field is optional) and simply gets no E4 verdicts.
 */
export interface LaneCheckerTurnInput extends LaneTurnInput {
  /**
   * The turn's own stored tags, canonical — the RAW column, every value in
   * it, NOT the membership-resolved subset. `undefined` means NOT LOADED — E4
   * yields no verdict for any edge touching this turn, the same "never
   * fabricate completeness" posture report 1's `coverage` and report 4(c)'s
   * cross-session comparison both take. `[]` means the turn genuinely
   * carries no tags, which is a real E4 verdict for every tagged edge
   * touching it.
   *
   * DELIBERATELY NOT `LaneTurnInput.laneTags` (ticket 10), even though the
   * two overlap on every legal row. `laneTags` is the raw column INTERSECTED
   * with the segment's declared lanes, and E4 asks a question about the
   * stored column alone: "is this side's tag present on that side's own
   * turn". Judging it against the filtered set would silently re-file a
   * DECLARATION defect (an edge naming a lane the registry never declared —
   * a gap spec D6 explicitly defers) as a SUBSET defect, whose repair is a
   * different act entirely.
   */
  tags?: readonly string[];
}

/**
 * The three classes of the spec's error table: E2-E4 (tag-mandate ticket
 * 03). E1 (an untagged `extends`/`narrows`) is RETIRED with the tag mandate
 * itself, and E5 (a lane with more than one source or sink) is DELETED by
 * lane-model-v12 ticket 04 — it was a COMMIT-BLOCKING error enforcing "one
 * start, one end", a clause rubric v11 had already removed, so it blocked
 * settlement on a law the model no longer states. See this module's header
 * for why the remaining numbers do not shift down to close either gap.
 */
export type LaneErrorClass = "E2" | "E3" | "E4";

interface LaneErrorAnchor {
  /**
   * The turn this instance anchors at — an EDGE error anchors at its CITING
   * turn, a TYPE error at the turn itself (module header, "The ANCHOR").
   * The commit gate filters by THIS field alone and never needs per-class
   * knowledge to do it.
   */
  anchorId: number;
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

export type LaneCheckerError =
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
   * D9 warning 1 (ticket 09, module header "Attribution warnings") — clusters
   * of 4+ unattributed turns. Capped for display like every other fact list
   * here; `count` is the true number of CLUSTERS and each entry's own
   * `turnCount` the true size of that cluster. A WARNING: no gate reads it.
   */
  unattributedClusters: { count: number; entries: readonly LaneUnattributedCluster[] };
  /**
   * D9 warning 2 (ticket 09) — one entry per supplied segment that is OVER
   * `max(1, 0.05 × member turns)`. Empty when the caller supplied no
   * `segmentFacts` at all: no facts, no verdict.
   */
  laneProliferation: readonly LaneProliferationWarning[];
  /**
   * Tag-mandate ticket 03 — states the grammar forbids, E2-E4, sorted by
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

/**
 * Whether an edge is one of `tag`'s OWN INTERNAL edges — both sides settled
 * to that one tag (lane-model-v12 D1, ticket 06). This is the interfaces
 * exclusion's real premise, restated for the two-sided read: v11 excluded an
 * edge "carrying the lane's tag" because carrying it made BOTH endpoints
 * members of that lane, so the edge could not also be a crossing. Under v12
 * that implication holds only when the two sides AGREE — a cross-lane edge
 * (`tail !== head`) carries lane A's tag AND lane B's, is a member of
 * neither, and IS exactly the A<->B crossing the report exists to count.
 * Excluding it by "carries either tag" would blind report 4(a) to the one
 * shape v12 introduced.
 *
 * Deliberately NOT `laneMembershipClaims`/`sameLaneKey`, which also fold in a
 * segment: an edge carries no segment of its own, only its two endpoint turns
 * do, and this exclusion has always tested the tag alone. On today's stock
 * (every stored edge is `tail === head` or two sentinels) it agrees with the
 * old set-membership test row for row, which is why the switch moves no
 * count.
 */
function edgeIsInternalToTag(edge: LaneEdgeInput, tag: string): boolean {
  const tail = edge.tailTag;
  return tail !== UNSETTLED_LANE_TAG && tail === edge.headTag && tail === tag;
}

/**
 * Report 2/3's shared global graph union test (lane-declaration ticket 12,
 * P1-7 — module header "Report domains"). TWO predicates, ORed, never one
 * widened relation-set: `LANE_COMPONENT_RELATIONS` is the tag-agnostic
 * EXTERNAL bridge domain (unchanged); the second clause is "this edge
 * carries SOME lane's own tag and is not indexes/override" — a lane's own
 * tagged structural edge always keeps ITS OWN members connected, whatever
 * the relation word, without ever admitting an UNTAGGED `verifies`/
 * `refutes` edge (AC2's "must not leak"). `grounds` already satisfies the
 * first clause unconditionally (pre-dates this ticket), so a tagged
 * `grounds` edge matches both clauses — harmless, since this is an OR.
 */
function unionsLaneComponentGraph(edge: LaneEdgeInput): boolean {
  if (LANE_COMPONENT_RELATIONS.has(edge.relation)) {
    return true;
  }
  // "carries SOME lane's own tag" is now read off the two SIDES (ticket 06):
  // `laneEdgeTags` is non-empty exactly when at least one side is settled.
  return laneEdgeTags(edge).length > 0 && edge.relation !== "indexes" && edge.relation !== "override";
}

/**
 * Report 4(a), interfaces half (module header): for each unordered pair of
 * reported `lanes`, the count of `LANE_COMPONENT_RELATIONS` edges in the
 * FULL edge set with one endpoint a member of one lane and the other a
 * member of the other, excluding an edge INTERNAL to either lane
 * (`edgeIsInternalToTag` — both sides settled to that lane's tag; see its own
 * doc for why "either side mentions the tag" is the wrong test under v12).
 * An internal edge makes both its endpoints members of THAT lane, never
 * merely "the other side" of a crossing. Only pairs with `count > 0` are
 * emitted — a sparse report.
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
        if (edgeIsInternalToTag(edge, laneA.key.tag) || edgeIsInternalToTag(edge, laneB.key.tag)) {
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
 * interfaces half): an edge carrying the lane's own tag would make
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
        tags: laneEdgeTags(edge),
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

/** `{ count, entries }` from one uncapped, already-sorted fact list — the shared shape both `vocabularyConformance` halves and D9's `unattributedClusters` use, `count` always the TRUE total. */
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
 * The (tag, endpoint) obligations an edge carries — the whole of E4's input,
 * and the one place the arc's DIRECTION is bound to an endpoint.
 *
 * v12 D2 rule 3 is PER SIDE: `tailTag` is the CITING turn's lane and is owed
 * by the CITING turn's own `tags`; `headTag` is the CITED turn's and is owed
 * by the CITED turn's. v11 had one merged tag set and checked EVERY tag
 * against BOTH ends, which is the same thing only because a stored edge
 * always had `tail === head`; the moment the two sides can differ, "which
 * side owes which tag" becomes a real question with a wrong answer.
 *
 * Pointing either entry at the other endpoint is THE mutation for this
 * function (spec: "把某一侧的读取指向另一侧") — `tests/shared/lane-checker.test.ts`'s
 * "E4 is per-SIDE" block is what goes red.
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
 * `missing` shape mirrors `turn-phase.ts`'s Gate B rejection detail exactly —
 * a same-lane edge whose tag is absent from both endpoints is named twice,
 * once per endpoint, so an agent repairing one side does not discover the
 * second gap only on a retry.
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
 * D9 warning 1 (module header, "Attribution warnings"): clusters of 4+ turns
 * that carry no lane tag and are connected to EACH OTHER by untagged
 * `UNATTRIBUTED_CLUSTER_RELATIONS` edges.
 *
 * Three passes, in this order — the order is the whole design:
 *
 *   1. ATTRIBUTED OUT. A turn carries a lane tag exactly when it is a MEMBER
 *      of some derived lane — since ticket 10 a NODE fact, the turn's own
 *      resolved `laneTags` (module header). Those turns leave
 *      the domain entirely, which is what makes this a CLUSTER rule rather
 *      than the retired component rule: a tagged member elsewhere in the
 *      same component is simply not in this graph and excuses nothing.
 *   2. EXCUSED OUT. Every turn AGGREGATED by an untagged `indexes` (i.e. the
 *      CITED endpoint — the aggregator itself is not something it aggregates)
 *      leaves too, PER MEMBER (peer P1-9). Removing the excused nodes before
 *      the components are formed is exactly the ticket's "re-evaluate the
 *      REST as an induced subgraph": a remainder that splits into two
 *      four-turn pieces warns twice, and a six-turn cluster with two
 *      aggregated members still warns on the four that are left.
 *   3. COMPONENTS of what remains, over UNTAGGED edges only (a tagged edge's
 *      endpoints are attributed by construction, so this filter is belt-and-
 *      braces rather than load-bearing — kept because the ticket names the
 *      untagged edge as the connector).
 *
 * Only turns present in `turns` can be cluster members: an edge endpoint the
 * projection never loaded is not silently invented as a node.
 */
function computeUnattributedClusters(
  turns: readonly LaneCheckerTurnInput[],
  lanes: readonly Lane[],
  edges: readonly LaneEdgeInput[],
): LaneUnattributedCluster[] {
  const attributed = new Set<number>();
  for (const lane of lanes) {
    for (const member of lane.members) {
      attributed.add(member.id);
    }
  }

  const excused = new Set<number>();
  for (const edge of edges) {
    if (edge.relation !== "indexes") continue;
    if (laneEdgeTags(edge).length > 0) continue; // an ATTRIBUTED indexes declares convergence; only the fully unsettled one is free aggregation
    excused.add(edge.citedId);
  }

  const candidates = new Set<number>();
  for (const turn of turns) {
    if (attributed.has(turn.id) || excused.has(turn.id)) continue;
    candidates.add(turn.id);
  }
  if (candidates.size < MIN_UNATTRIBUTED_CLUSTER_TURNS) {
    return [];
  }

  const uf = new UnionFind();
  for (const id of candidates) {
    uf.add(id);
  }
  for (const edge of edges) {
    if (!UNATTRIBUTED_CLUSTER_RELATIONS.has(edge.relation)) continue;
    if (laneEdgeTags(edge).length > 0) continue;
    if (!candidates.has(edge.citingId) || !candidates.has(edge.citedId)) continue;
    uf.union(edge.citingId, edge.citedId);
  }

  const byRoot = new Map<number, number[]>();
  for (const id of [...candidates].sort((a, b) => a - b)) {
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
 * every magnitude, and this predicate's whole job is to be right AT the
 * boundary (a segment exactly at the ratio is silent). `allowance` is carried
 * as the real number purely so the render can print the line the count was
 * judged against.
 *
 * Ticket 14: the numerator is `declaredLaneCount` WHOLE — a lane with no live
 * member is not subtracted from it (`LaneSegmentFacts.emptyLaneTags` carries
 * that rule's full reasoning). It is instead carried onto the warning, so a
 * count inflated by lanes no reader can see always names them and is never
 * silent about the difference.
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
    // Omitted (rather than set to `[]`) when the caller supplied no such
    // field: absent means "not loaded", exactly as on the facts themselves.
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
  segmentFacts: readonly LaneSegmentFacts[] = [],
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
  const laneStates = deriveLaneStates(lanes);
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
    if (unionsLaneComponentGraph(edge) && segmentFor(edge.citingId) === segmentFor(edge.citedId)) {
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
    const thisLaneToken = laneToken(lane.key.segment, lane.key.tag);
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
  // ---- D9's two attribution WARNINGS (ticket 09, module header). Both read
  // only facts already computed above (`lanes` for membership) or supplied by
  // the loader (`segmentFacts`); neither participates in `errors` and no gate
  // reads either. ----
  const unattributedClusters = computeUnattributedClusters(turns, lanes, vocabEdges);
  const laneProliferation = computeLaneProliferation(segmentFacts);

  // ---- ERRORS (tag-mandate tickets 03/04, module header). E2/E3 are the
  // SAME uncapped fact lists `vocabularyConformance` caps for display,
  // classed rather than recomputed; E4 reads the in-vocabulary edge set;
  // The list stays uncapped — the commit gate filters it by `anchorId`. ----
  const errors: LaneCheckerError[] = [
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
    unattributedClusters: cappedFactList(unattributedClusters),
    laneProliferation,
    errors,
  };
}

/** Segment + tag equality (D5, v11 — a lane's identity is one tag, not a set) — via `laneToken`'s own escaped join (round-4 review #6's collision-avoidance reasoning, still load-bearing: a plain string concat can still merge a segment/tag pair with a different one). */
function sameLaneKey(a: LaneKey, b: LaneKey): boolean {
  return laneToken(a.segment, a.tag) === laneToken(b.segment, b.tag);
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
  const thisLaneToken = laneToken(lane.key.segment, lane.key.tag);
  const foldedInLanes = new Set<string>([thisLaneToken]);
  const citerLanePairs: Array<readonly [number, number]> = [];
  for (const citerId of new Set(crossPhaseGrounds.map((edge) => edge.citingId))) {
    for (const otherLane of allLanes) {
      const token = laneToken(otherLane.key.segment, otherLane.key.tag);
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
