/**
 * lane-model INTERPRETATION CORE (lane-model-v12 spec D1/D6,
 * `.scratch/lane-model-v12/spec.md`; supersedes lane-declaration spec Rev 2
 * D5 and rubric-v10 ticket 05's `.scratch/rubric-v10/draft-lane-model.md`,
 * "统一解读原则" + "校验体系"). Pure derivation over plain arrays — no
 * database, no I/O, no module-level state, the same contract
 * `shared/flows.ts`'s `deriveFlows` follows for the decision layer this
 * module supersedes at lane granularity.
 *
 * ## MEMBERSHIP COMES FROM THE NODE'S OWN TAGS (v12 D5, ticket 10)
 *
 * A turn belongs to lane `(segment, tag)` exactly when its OWN
 * `LaneTurnInput.laneTags` carries that tag and it is owned by that segment.
 * NOTHING here reads membership off an edge any more, and the lanes this
 * module enumerates are exactly the lanes some node claims.
 *
 * This inverts the v11 reading the rest of this header was written against.
 * Membership used to be enumerated from the ENDPOINTS of tagged edges, which
 * made a turn that carries a lane's tag but has not been wired into the graph
 * yet INVISIBLE — the ticket's own counter-example: T1/T2 in lane L with T2
 * `indexes` T1, plus T3 carrying L and no edge at all. The edge-derived
 * reading sees two members; the node-tag reading sees three, and the third is
 * a full member with no edge of any kind.
 *
 * Two consequences worth stating outright, because both look like losses
 * until the reason is read:
 *
 *   - **A lane no node claims does not exist here**, however many edges name
 *     it. Such an edge is attributed to nothing and joins no lane's
 *     `taggedEdges`; `lane-checker.ts`'s error class E4 (a side tag absent
 *     from that side's endpoint's own tags) is what names the inconsistency,
 *     and the separate "a lane exists in the graph but the registry never
 *     declared it" report stays DEFERRED (spec D6) rather than being smuggled
 *     in here as a phantom lane.
 *   - **A PROVISIONAL lane is legal** (v12 D3): a freshly declared lane may
 *     hold 0 or 1 members, declaration fixes no timepoint, and the
 *     connectivity principle does not apply to it. A 0-member lane is simply
 *     not enumerated (the registry, not this module, is where it lives — see
 *     `lane-checker.ts`'s `LaneSegmentFacts.emptyLaneTags`); a 1-member lane
 *     enumerates with one member, one component and no defect of any kind.
 *
 * The caller resolves `laneTags` (`db/lane-checker-load.ts` intersects a
 * turn's stored `tags` column with the lanes DECLARED in its owning segment,
 * through `db/turn-tag-gate.ts`'s own vocabulary resolvers). This module
 * trusts that resolution and never re-derives it: it has no registry and no
 * database.
 *
 * ## An edge carries TWO tags, one per side (v12 D1) — what an edge is still
 * the source of
 *
 * A lane's identity is `(segment, ONE tag)`. Which lane an EDGE belongs to —
 * whose structural graph it is part of, never who its members are — is read
 * off the arc's two ENDS: `tailTag` (the CITING side, the lane the reference
 * comes FROM) and `headTag` (the CITED side, the lane it points AT), through
 * `laneMembershipClaims` below.
 *
 * The predicate is deliberately narrow, and each of its three "no claim"
 * arms is a rule the merged set could not state:
 *
 *   - **both sides settled, SAME tag, SAME segment** -> ONE claim. This is
 *     an INTERNAL edge: it is attributed to that one lane on BOTH ends, and
 *     the lane's connectivity/convergence/path reports are built from it.
 *     (It does not MAKE its endpoints members — their own tags do. An
 *     internal edge whose endpoint does not carry the tag is exactly the
 *     inconsistency E4 reports.)
 *   - **both sides settled, DIFFERENT tags** -> NO claim. A CROSS-LANE edge
 *     (spec problem 2: "一条从 lane A 指向 lane B 的边只能写成无 tag,它跨了
 *     哪两条 lane 这个事实丢失"). It names two lanes and joins neither: it
 *     establishes no connectivity, and neither endpoint becomes a member
 *     through it.
 *   - **both sides settled, same LITERAL tag, DIFFERENT segments** -> NO
 *     claim either, for exactly the same reason: identity is `(segment,
 *     tag)`, so the same word in two segments is TWO lanes and the edge
 *     crosses between them. v11 registered such an edge in BOTH segments'
 *     copies of the lane ("dual appearance"); v12 registers it in neither.
 *     It is still reported in `warnings`, which is where a cross-segment
 *     fact is now named rather than silently doubled. (Production
 *     measurement at the time of the switch: 1 cross-segment edge among 507
 *     tagged ones.)
 *   - **either side UNSETTLED (`''`)** -> NO claim. An unsettled edge is
 *     settlement's own to-do queue (v12 D6) and rubric-v12's own rule is
 *     that it "takes no part in any connectivity, convergence or coupling
 *     computation". This subsumes v11's "untagged: forms no lane" rule
 *     unchanged, and adds the half-settled shape D2 refuses at write time.
 *
 * ## A LANE HAS NO STATE (lane-state-retirement ticket 01)
 *
 * A lane is its MEMBERS and the EDGES CLAIMING IT. Nothing here says whether
 * a lane is finished, at rest, or still moving, because nothing in a bounded
 * settlement window can know that — and because the reading that tried
 * (`closed` = "the lane's newest member is its terminus") is what forced
 * `index` to mean lane-death and left it used ONCE in 819 edges.
 *
 * FOUR THINGS WENT, TOGETHER, and none of them has a successor under another
 * name:
 *
 *   - `LaneClosure` / `LaneState` / `deriveLaneStates` — the `closed`/`open`
 *     verdict itself.
 *   - `laneClosureClaim` — the predicate that decided WHICH lane an `indexes`
 *     declared converged. With no lane state to declare, an `indexes` edge is
 *     an ordinary edge here: it is attributed by the same two-sided rule as
 *     every other word, and it moves nothing.
 *   - `LaneDeclaration` / `Lane.declaration` — `state` plus `terminus`. The
 *     terminus was a LATEST-WINS reduction, one seat per lane; under
 *     rubric-v12's own reading of `index` (阶段性收敛) a lane converges as
 *     often as it has phases, so "THE terminus" was never a fact about a lane
 *     with more than one wrap-up in it.
 *   - `Lane.latestMember` — the newest member in reduction order. It existed
 *     as closure's second input and had no other reader; the reduction order
 *     itself survives on `LaneOrderKey`/`compareOrderKeyAcrossSessions`, which
 *     other modules still rank by.
 *
 * WHAT A NODE THAT DECLARES AN INDEX IS NOW READ OFF: its own outgoing
 * `indexes` edges, at the reader that cares (the milestone election). Not a
 * lane-level seat computed here.
 *
 * ## The unified interpretation principle (draft-lane-model.md's own anchor,
 * carried over from v10, restated for the two-sided read)
 *
 * An edge acts on the lane it CLAIMS (above); an edge that claims no lane —
 * and an edge whose claimed lane no node joins — acts on no lane at all.
 * Every relation word reads this ONE rule and there is no longer a second
 * one: the ATTRIBUTION loop below keys on the two side tags alone and never
 * on `edge.relation`, so a `grounds`/`verifies` edge attaches to its claimed
 * lane exactly like a `narrows`/`extends` one, and an `indexes` exactly like
 * both. ATTRIBUTION is the whole of this module's edge reading. No word
 * carries lane state, because there is none: `override` never did (the v11
 * reopening came out with node death), and `indexes` stopped when lane state
 * did.
 *
 * ## There is no node death (lane-model-v12, ticket 04)
 *
 * A member is a member. `LaneMember` used to carry a `dead` flag — set by an
 * untagged "global kill" or an in-lane override — and `LaneState` used to
 * carry a `valid`/`invalid` reading derived from it. Both are DELETED: v12
 * has no global repudiation and no killed node. An override now moves
 * NOTHING in lane space at all (see the relation table above) — it leaves a
 * structural edge and, when its writer carries the lane's tag, a newer
 * member. Nothing in this module reads or produces a per-node status any
 * more, and nothing should re-derive one under another name.
 */

import type {
  RelationClassValue,
  RelationCoverageValue,
} from "./relation-class";
import type { TurnPhase } from "./turn-phase";

// Re-exported so a consumer that only wants the phase vocabulary need not
// also import turn-phase.ts directly (`flows.ts`'s convention).
export type { TurnPhase };

/** Segment sentinel a turn with no `segment` field shares — "the fixture has no segments" reads as one default scope. */
export const DEFAULT_SEGMENT = "\u0000default";

/**
 * One taggable input turn. `id` doubles as the turn-order key (ascending =
 * later) by default — `flows.ts`'s `FlowTurnInput` convention: "whatever id
 * space the caller addresses turns by", assumed order-comparable — UNLESS
 * `order` is supplied, in which case reduction sorts by `order` instead:
 * insertion id and true chronological position can diverge (a backfilled
 * turn gets a later row id for an earlier conversational position), so a
 * caller that knows the true order (the DB adapter, from `session_id` +
 * `prompt_number`) must be able to say so explicitly. A plain fixture whose
 * ids ARE already in true order needs no `order` field at all.
 */
/**
 * The reduction-order key: `[major, minor]`, compared lexicographically
 * (major first, then minor) — never collapsed into one scalar (round-5
 * review #10: `session_id * SPAN + prompt_number`-style encoding both
 * collides across distinct pairs and loses precision at realistic
 * magnitudes). The DB adapter supplies `[session_id, prompt_number]`
 * directly; a plain fixture that only cares about relative order may supply
 * `[0, n]` for a synthetic sequence `n`.
 */
export type LaneOrderKey = readonly [number, number];

export interface LaneTurnInput {
  id: number;
  type: readonly string[];
  /** Lane identity's segment half. Omitted turns share `DEFAULT_SEGMENT`. */
  segment?: string;
  /**
   * THE membership fact (v12 D5, ticket 10, module header): the DECLARED lane
   * tags this turn's own `tags` column carries. This turn is a member of
   * `(segment, tag)` for each one, and of no other lane — no edge adds a
   * member and no edge removes one.
   *
   * It is the caller's RESOLVED set, not the raw column: `db/lane-checker-
   * load.ts` intersects `turns.tags` with the lanes declared in the turn's
   * OWNING segment (`db/turn-tag-gate.ts`'s `loadDeclaredLaneTags`, the same
   * vocabulary resolver the write gate uses), so the segment's own tag, a
   * legacy free-form word and a lane declared somewhere else all drop out
   * here rather than minting a phantom lane. A pure fixture states the set
   * directly.
   *
   * Omitted = the caller resolved no membership for this turn, which is the
   * same outcome as `[]`: a member of nothing. There is deliberately NO
   * "unknown, fall back to the edges" arm — that fallback IS the reading this
   * ticket replaced, and keeping it would leave both readings alive at once.
   */
  laneTags?: readonly string[];
  /** Explicit reduction-order key. Defaults to `[0, id]` when omitted. */
  order?: LaneOrderKey;
  /**
   * Wall-clock creation epoch (rubric-v10 ticket 08). Read by NOTHING in
   * this module's own reduction — `deriveLaneInterpretation` orders purely
   * by `order`/`id`, never by wall-clock time. The one reader is
   * `lane-checker.ts`'s report-4(c) time-order check, which needs an actual
   * clock (not the `[session_id, prompt_number]` tuple `order` carries) to
   * compare two turns from DIFFERENT sessions — a tuple's `session_id` half
   * is an auto-increment id with no wall-clock meaning across sessions, so
   * it can never stand in for `created_at_epoch` there. Optional: a plain
   * fixture that never sets it simply gets no per-edge time-order judgement
   * for any CROSS-session pair touching it (same-session pairs need only
   * `order`, so they are judged regardless).
   */
  createdAtEpoch?: number;
}

/** Lexicographic tuple compare — the core's ONE ordering primitive (round-5 review #10): no scalar encoding of the pair anywhere. Exported (milestone-election spec, ticket 02) so a reader built ON this core's output never reimplements tuple comparison of its own. This module itself no longer orders anything: the one ordered pass it had was the declaration reduction, deleted with lane state. */
export function compareOrderKey(a: LaneOrderKey, b: LaneOrderKey): number {
  return a[0] - b[0] || a[1] - b[1];
}

/**
 * `compareOrderKey`, but safe for a pair that may sit in DIFFERENT sessions
 * (pre-release repair R1 #6). A same-session pair (`order[0]` equal) still
 * compares the `[major, minor]` tuple directly — both halves are meaningful
 * there. A CROSS-session pair falls back to `createdAtEpoch` instead of the
 * tuple's `order[0]` (session-id) half, which carries no wall-clock meaning
 * relative to another session (this module's own doc comment on
 * `LaneTurnInput.createdAtEpoch`) — the exact "tuple-order trap"
 * `lane-checker.ts`'s report-4(c) `computeTimeOrderViolations` already
 * avoids for its own judgement; this is the same fix applied to an ORDERING
 * comparator rather than a violation check. If either side's epoch is
 * missing, the tuple compare is the only signal available and is used as a
 * last resort — a caller building a total order (the election's rank
 * tie-break) still needs a deterministic answer, unlike report 4(c)'s own
 * "no fabricated verdict" posture, which can afford to skip a pair outright.
 */
export function compareOrderKeyAcrossSessions(
  a: { order: LaneOrderKey; createdAtEpoch?: number },
  b: { order: LaneOrderKey; createdAtEpoch?: number },
): number {
  if (a.order[0] === b.order[0]) {
    return compareOrderKey(a.order, b.order);
  }
  if (a.createdAtEpoch !== undefined && b.createdAtEpoch !== undefined) {
    return a.createdAtEpoch - b.createdAtEpoch;
  }
  return compareOrderKey(a.order, b.order);
}

/**
 * `''` — a side no one has settled yet, NOT a lane whose tag is the empty
 * string. Mirrors `db/memory-edges.ts`'s `UNSETTLED_SIDE_TAG` (redeclared
 * here so this module stays free of any DB-layer dependency, the same
 * convention `canonicalTagSet` already follows for `canonicalizeTagSet`).
 * The sentinel is an empty STRING rather than `null` because the storage
 * identity key `(citing, cited, relation, tail_tag, head_tag)` is a SQLite
 * UNIQUE, and SQLite treats NULLs in a unique key as distinct — nullable
 * side columns would let the same unsettled edge be inserted twice
 * (lane-model-v12 spec D1).
 */
export const UNSETTLED_LANE_TAG = "";

/**
 * One edge assertion row. `citingId` is always the LATER turn
 * (`turn-phase.ts`'s direction convention).
 *
 * ONE tag surface, since ticket 09 closed the expand/contract (spec D1):
 * `tailTag`/`headTag`, the arc's two ends, ONE lane tag each. `tail` is the
 * CITING side (which lane the reference comes FROM), `head` the CITED side
 * (which lane it points AT); `UNSETTLED_LANE_TAG` above is the "no one has
 * settled this side yet" value. Every lane question in this module and in
 * `lane-checker.ts` resolves through `laneMembershipClaims`/`laneEdgeTags`
 * below, and so through these two fields alone.
 *
 * The merged `tags` SET that used to ride alongside them is GONE — ticket 06
 * moved the last reader off it, ticket 09 deleted the column, the index table
 * and this field together. A reader tempted to re-add it should read the next
 * paragraph first: the set is not a compression of the two sides, it is a
 * strictly weaker statement than they are.
 *
 * `tailTag !== headTag` with both settled is a CROSS-LANE edge: the fact the
 * single merged set structurally could not express (spec, problem 2 — "一条
 * 从 lane A 指向 lane B 的边只能写成无 tag,它跨了哪两条 lane 这个事实丢失").
 * A reader that collapses the two sides back into one set re-loses it —
 * which is why `laneEdgeTags` exists ONLY for the display/"is this edge
 * attributed at all" questions, and why membership goes through
 * `laneMembershipClaims` instead.
 */
/**
 * How ONE side of an edge attributes to a lane (main-agent-edges spec D2).
 * Mirrors `db/edge-side-resolution.ts`'s `EdgeSideOutcome` verbatim,
 * redeclared here so this module stays free of any DB-layer dependency — the
 * same convention `UNSETTLED_LANE_TAG` already follows for
 * `db/memory-edges.ts`'s `UNSETTLED_SIDE_TAG`.
 */
export type LaneSideOutcome = "declared" | "derived" | "ambiguous" | "none" | "invalid";

export interface LaneEdgeInput {
  citingId: number;
  citedId: number;
  /**
   * The edge's class TOKEN (`correct(full)`, `correct(partial)`, `verify`,
   * `use` — `shared/relation-class.ts`'s `formatRelationClass`), a display
   * label used for renders, sorts and dedupe keys. Never a storage word: the
   * seven-word `relation` column left at the main-agent-edges cutover.
   */
  relation: string;
  /**
   * The lane this side ATTRIBUTES to (main-agent-edges D2), `''` for a side
   * that attributes to none.
   *
   * It used to be the row's STORED word and nothing else. Since resolution it
   * is what a DB loader resolved — the declaration when the row declares one,
   * the endpoint's single lane when it does not — so 69% of edges reach their
   * lane with no writer having said so. A pure fixture states the STORED side
   * here and is resolved before it reaches a reader that keys on outcomes
   * (`tests/support/lane-edge-fixtures.ts`'s `resolveLaneEdges`).
   */
  tailTag: string;
  headTag: string;
  /**
   * The RESOLVED outcome per side, supplied by a DB loader. OPTIONAL on this
   * base shape only because the election's own feed
   * (`db/memory-edges.ts`'s `getRelationEdgesAmongTurns`) hands over stored
   * side columns and never resolves them — the election reads neither side.
   * The lane checker REQUIRES both (`shared/lane-checker.ts`'s
   * `LaneCheckerEdgeInput`): no reader in the tree falls back to the tag
   * when the outcome is absent (ticket 02b deleted that branch).
   */
  tailOutcome?: LaneSideOutcome;
  headOutcome?: LaneSideOutcome;
  /** The side's STORED declaration, verbatim (`''` = undeclared) — what an `invalid` finding has to NAME. Required wherever the outcomes are. */
  storedTailTag?: string;
  storedHeadTag?: string;
  /**
   * relation-vocabulary-v13 ticket 02: the row's stored three-class value, when
   * the loader read it. OPTIONAL and absent-means-unclassified, so every
   * existing constructor of this shape (the lane checker's fixtures, the
   * election's own inputs) keeps compiling and keeps its meaning — the class is
   * a RENDERING and future-scoring fact, never a graph-shape one, and nothing
   * that computes lane structure reads either field.
   */
  relationClass?: RelationClassValue;
  /** relation-vocabulary-v13 ticket 02: `full`/`partial` on a `correct` row. */
  relationCoverage?: RelationCoverageValue;
}

/** A lane's machine identity (D5, v11): segment + ONE canonical tag — never a set. No subset/hierarchy is read here — that is a human layer over this per-tag data (draft: "层级是解读,不是机制"). */
export interface LaneKey {
  segment: string;
  /** Canonical (the write-time predicate `db/lanes.ts` enforces, D1) — this module trusts the caller's edge rows and never re-canonicalizes a single tag itself. */
  tag: string;
}

/** A lane member. Carries the node id and nothing else — v12 deleted node death, so there is no per-member status field (see module header, "There is no node death"). */
export interface LaneMember {
  id: number;
}

/**
 * A lane: its MEMBERS and the EDGES CLAIMING IT, and nothing else (module
 * header, "A LANE HAS NO STATE"). `tests/shared/lane-interpretation.test.ts`
 * pins this object's key list, which is how a re-added state field — a
 * closure verdict, a terminus, a newest-member seat — fails loudly instead of
 * arriving as a quiet third property.
 */
export interface Lane {
  key: LaneKey;
  /** Ascending by id. Every turn whose OWN `laneTags` carry this lane's tag while it is owned by this lane's segment (v12 D5, ticket 10) — overridden ones included, since an override never removes a node from its lane ("被推翻的节点留在图中,承载纠正叙事"), and EDGELESS ones included, since an edge was never what made a turn a member. */
  members: readonly LaneMember[];
  /** This lane's own INTERNAL edges — every edge that CLAIMS this lane (`laneMembershipClaims`: both sides settled to this lane's tag, both endpoints in this lane's segment), input order. A cross-lane edge appears in NO lane's list, by construction: it names two and joins neither — an `indexes` that leaves its own lane included, since ticket 01 gave `indexes` no attribution rule of its own. An edge whose claimed lane has no member at all appears in none either (the lane is not enumerated). The field keeps its `taggedEdges` name for its readers' sake; "tagged" means "claiming", and it never meant "makes its endpoints members" — since ticket 10 that is the node's own tags alone. */
  taggedEdges: readonly LaneEdgeInput[];
}

/**
 * One cross-segment edge with at least one settled side — legal (never
 * rejected), always warned. Since v12 this is the ONLY trace such an edge
 * leaves in the interpretation: it crosses between two lanes (identity is
 * `(segment, tag)`, so the same literal word in two segments is two lanes)
 * and joins neither, where v11 registered it in both.
 */
export interface LaneCrossSegmentWarning {
  citingId: number;
  citedId: number;
  /** `laneEdgeTags` — the tags the edge's two SIDES name, as a canonical set. One entry when both sides agree on the word, two when they do not. */
  tagSet: readonly string[];
  citingSegment: string;
  citedSegment: string;
}

export interface LaneInterpretation {
  /**
   * Every enumerated lane, ordered by segment then tag — deterministic, not
   * input order. NO fan-out remains: one edge joins at most ONE lane
   * (`laneMembershipClaims`). Both of v11's fan-outs died with the two-sided
   * read — see the grouping loop's own comment.
   */
  lanes: readonly Lane[];
  laneByToken: ReadonlyMap<string, Lane>;
  /** Every cross-segment edge with a settled side, named — and, since v12, the ONLY place such an edge appears at all (it joins no lane). Legal and warned, never rejected. */
  warnings: readonly LaneCrossSegmentWarning[];
}

/** Dedupe + sort — the row's own canonical form (mirrors `db/memory-edges.ts`'s `canonicalizeTagSet`, redeclared here so this module stays free of any DB-layer dependency). */
export function canonicalTagSet(tags: readonly string[]): string[] {
  return [...new Set(tags)].sort();
}

/**
 * The token a lane is grouped and looked up by: segment + ONE tag (D5, v11 --
 * a lane's identity is no longer a whole set). JSON-encoded as a `[segment,
 * tag]` pair (round-5 review #14's own reasoning, carried over unchanged):
 * a plain delimited join collides whenever a real string happens to CONTAIN
 * the delimiter character itself -- `segment + tag` merges segment `"ab"` +
 * tag `"c"` with a DIFFERENT segment `"a"` + tag `"bc"`. `JSON.stringify`
 * self-delimits both elements via its own quoting/escaping, so no input can
 * ever produce two different `[segment, tag]` pairs that serialize
 * identically.
 */
export function laneToken(segment: string, tag: string): string {
  return JSON.stringify([segment, tag]);
}

/**
 * One side's tag, normalized. THE only place a side value is coerced, and it
 * exists for one reason: `tsconfig.json` excludes `tests/`, so an un-migrated
 * fixture object literal can still hand these readers `undefined` on a side
 * with nothing catching it at build time. Left raw, `undefined === undefined`
 * would make BOTH sides compare EQUAL and mint a phantom lane whose tag is
 * `undefined`; normalized, such an edge is simply UNSETTLED — it claims no
 * lane, disappears from every report, and the fixture's own assertions go red
 * rather than quietly asserting nonsense. `tests/support/lane-edge-fixtures.ts`
 * is the fix; this is the backstop that makes the omission loud.
 */
function settledSide(value: string): string {
  return typeof value === "string" ? value : UNSETTLED_LANE_TAG;
}

/**
 * The lane tags an edge NAMES, as a canonical set — the union of its settled
 * sides: `[]` when unsettled, `[T]` for an internal edge (`tail === head ===
 * T`), and `[A, B]` sorted for a CROSS-LANE edge. This is the drop-in for the
 * old `canonicalTagSet(edge.tags)` reads at the display and
 * "is-this-edge-attributed-at-all" sites, and on today's stock (every stored
 * edge has `tail === head` or two sentinels) it returns exactly what the
 * merged set did, which is why the switch moves no report number.
 *
 * It is deliberately NOT an attribution test: a cross-lane edge NAMES two
 * lanes and JOINS neither, and collapsing the two sides back into a set is
 * exactly how a reader re-loses that (see `LaneEdgeInput`'s own doc). Which
 * lane an edge joins goes through `laneMembershipClaims`; which lanes a NODE
 * joins goes through its own `LaneTurnInput.laneTags` and touches neither.
 */
export function laneEdgeTags(edge: LaneEdgeInput): readonly string[] {
  const tail = settledSide(edge.tailTag);
  const head = settledSide(edge.headTag);
  const tags: string[] = [];
  if (tail !== UNSETTLED_LANE_TAG) tags.push(tail);
  if (head !== UNSETTLED_LANE_TAG && head !== tail) tags.push(head);
  return tags.sort();
}

/**
 * THE lane-attribution predicate (lane-model-v12 D1/D6, ticket 06) — the ONE
 * place any "which lane does this EDGE belong to" question resolves, for this
 * module's attribution AND event reduction and for every reader in
 * `lane-checker.ts`. Returns at most ONE claim; see the module header for
 * each "no claim" arm and its reason.
 *
 * IT IS NOT A NODE-MEMBERSHIP TEST, and has not been one since ticket 10: a
 * turn is a member of the lanes its OWN `laneTags` name, so an edge claiming
 * lane L neither adds its endpoints to L nor needs them to already be there
 * (E4 is what reports the second case). The name is kept because every
 * reference to it — in this module, in `lane-checker.ts`, in the spec — spells
 * it, and a rename would cost more than the sentence you just read.
 *
 * The two segments are the endpoints' OWNING segments (`LaneTurnInput.segment`,
 * `DEFAULT_SEGMENT` when a turn has none) — passed in rather than looked up,
 * so this stays a pure function of one edge and keeps the caller's own
 * fallback convention for a turn the projection never loaded.
 */
export function laneMembershipClaims(
  edge: LaneEdgeInput,
  citingSegment: string,
  citedSegment: string,
): readonly LaneKey[] {
  const tail = settledSide(edge.tailTag);
  const head = settledSide(edge.headTag);
  // Unsettled or half-settled (the shape D2 refuses at write time): no lane.
  if (tail === UNSETTLED_LANE_TAG || head === UNSETTLED_LANE_TAG) return [];
  // Cross-lane by TAG, and cross-lane by SEGMENT — a lane's identity is the
  // PAIR, so the same literal word in two segments is two lanes.
  if (tail !== head || citingSegment !== citedSegment) return [];
  return [{ segment: citingSegment, tag: tail }];
}

interface MutableLaneGroup {
  segment: string;
  tag: string;
  /** Node ids whose OWN `laneTags` put them here — the whole of membership (ticket 10). */
  memberIds: Set<number>;
  edges: LaneEdgeInput[];
}

/**
 * Derive every lane's membership and tagged edges from one turn/edge set.
 * Pure and stateless — a caller that changed an edge simply calls this again
 * (same "derived view, recompute on read" contract as `deriveFlows`).
 *
 * There is NO third pass. Lane-state-retirement ticket 01 deleted the
 * declaration reduction that used to run here (`laneClosureClaim`, a
 * turn-ordered latest-wins fold into one terminus per lane) along with the
 * state it produced; a reader that wants "which turns declared an index" reads
 * the `indexes` edges themselves, which this function has never filtered.
 */
export function deriveLaneInterpretation(
  turns: readonly LaneTurnInput[],
  edges: readonly LaneEdgeInput[],
): LaneInterpretation {
  const segmentOf = new Map<number, string>();
  for (const turn of turns) {
    segmentOf.set(turn.id, turn.segment ?? DEFAULT_SEGMENT);
  }
  // A turn absent from `turns` (partial-coverage input, `lane-checker.ts`'s
  // coverage report) still needs a segment to group by — it falls back to the
  // default scope, so an incomplete projection degrades to "one extra default
  // scope" rather than throwing. It can never be a MEMBER of anything, though:
  // membership is a fact its own (unloaded) row would have had to carry.
  const segmentFor = (id: number): string => segmentOf.get(id) ?? DEFAULT_SEGMENT;

  // ---- lane enumeration: from the NODES' own tags (v12 D5, ticket 10) ----
  // A lane exists exactly where some turn claims it, and its members are
  // exactly the turns that claim it. An edge adds NO member here — the
  // edge loop below only ATTRIBUTES edges to lanes that already exist.
  const groups = new Map<string, MutableLaneGroup>();
  for (const turn of turns) {
    const segment = turn.segment ?? DEFAULT_SEGMENT;
    for (const tag of turn.laneTags ?? []) {
      const token = laneToken(segment, tag);
      let group = groups.get(token);
      if (group === undefined) {
        group = { segment, tag, memberIds: new Set(), edges: [] };
        groups.set(token, group);
      }
      group.memberIds.add(turn.id);
    }
  }

  // ---- edge attribution: ONE edge joins AT MOST ONE lane ----
  // (`laneMembershipClaims`). Both fan-outs v11 had here are gone with the
  // two-sided read: the per-TAG one (a merged set could name several lanes at
  // once — a side names exactly one), and the cross-segment DUAL APPEARANCE
  // (an edge whose endpoints sit in different segments used to register in
  // both sides' groups; under `(segment, tag)` identity it crosses BETWEEN
  // two lanes and joins neither). A cross-segment edge is still recorded once
  // in `warnings` — legal, warned, never rejected; the write gate's business
  // is elsewhere.
  //
  // An edge whose claimed lane NO node joins attaches to nothing and mints no
  // lane (ticket 10): a lane is a set of members, and an edge is not a member.
  // The inconsistency is E4's to report (`lane-checker.ts`), not this
  // module's to paper over with a memberless lane.
  const warnings: LaneCrossSegmentWarning[] = [];
  for (const edge of edges) {
    const citingSegment = segmentFor(edge.citingId);
    const citedSegment = segmentFor(edge.citedId);
    for (const claim of laneMembershipClaims(edge, citingSegment, citedSegment)) {
      groups.get(laneToken(claim.segment, claim.tag))?.edges.push(edge);
    }
    const sideTags = laneEdgeTags(edge);
    if (sideTags.length > 0 && citedSegment !== citingSegment) {
      // Once per cross-segment EDGE — the warning names the tags its two
      // sides carry, informationally; that pair is not a lane identity, and
      // since v12 the edge joins NEITHER of the lanes it names.
      warnings.push({
        citingId: edge.citingId,
        citedId: edge.citedId,
        tagSet: sideTags,
        citingSegment,
        citedSegment,
      });
    }
  }

  // ---- assemble lanes, deterministic order (segment, then tag key) ----
  const tokens = [...groups.keys()].sort();
  const lanes: Lane[] = [];
  const laneByToken = new Map<string, Lane>();
  for (const token of tokens) {
    const group = groups.get(token)!;
    const members: LaneMember[] = [...group.memberIds].sort((a, b) => a - b).map((id) => ({ id }));
    const lane: Lane = {
      key: { segment: group.segment, tag: group.tag },
      members,
      taggedEdges: group.edges,
    };
    lanes.push(lane);
    laneByToken.set(token, lane);
  }

  return { lanes, laneByToken, warnings };
}
