import { MEMORY_TYPES, type MemoryType } from "./type-vocabulary";

/**
 * The edge-relation vocabulary, and the turn phases that other readers derive
 * from a turn's `type` list. The two are INDEPENDENT since lane-model v12
 * (`.scratch/lane-model-v12/spec.md`, ticket 02): a relation's meaning has
 * nothing to do with either endpoint's phase, so nothing here licenses a
 * relation by phase any more. The three phases survive because other modules
 * still bucket turns by them (`db/edge-signals.ts`, `shared/lane-checker.ts`):
 *
 *   evidence (research/measure)              -> a fact
 *   decision (design/discuss/correction)      -> a decision
 *   delivery (implement/refactor/fix/         -> a work product carrying a
 *             delegate/review/ops)               decision (spec/ADR/ticket/
 *                                                 commit/release included).
 *
 * One shared module (this file), not duplicated per consumer, so every reader
 * of a turn's phase or a relation's legality derives it from the SAME table.
 *
 * Direction convention ([S15069/T930]): an edge is recorded from the CITING
 * (later) turn to its CITED predecessor — `memory_edges.citing_id` is always
 * the turn being written now, `cited_id` the turn it points at.
 *
 * ## The seven-word vocabulary (lane-model v12, rubric-v12's 七种关系)
 *
 * Each word says what the CITED node's main result becomes in light of this
 * node; none of them constrains either end's phase:
 *
 *   verifies   the cited main result is verified/supported by this node
 *   override   the cited main result is overturned, WITHDRAWN or REPLACED by
 *              this node — one word for disproof, retraction, abandonment and
 *              replacement alike, because the reader's question ("must I still
 *              read the cited result?") gets the same answer from all four
 *   narrows    the cited main result still applies; this node corrects or
 *              limits a detail
 *   extends    the cited main result still applies; this node adds to it
 *   grounds    this node's work depends on the cited standing — if the cited
 *              falls, this node falls with it
 *   consume    uses another node's output, taking no liability for it
 *   indexes    this node converges a stage, pointing at several nodes to
 *              express aggregation/index of what survives of the work before
 *
 * v11 -> v12, and why (measured, spec's 问题 section): `refutes` MERGES into
 * `override` — its meaning was already a subset of "the cited result is
 * overturned", and keeping both forced a writer to guess which. And the PHASE
 * AXIS leaves the vocabulary entirely. It was never load-bearing: with the
 * "any legal pairing on a multi-phase turn wins" escape hatch open, exactly
 * ONE live hand-written edge in the whole database failed the phase gate;
 * close the hatch and 309/609 (51%) failed. What made the graph legal was the
 * escape hatch, not the axis. The evidence-type condition that used to ride on
 * `verifies`/`refutes` goes with it: 19/20 asserted rows already complied, and
 * the single genuine violation it caught is legal under the merged semantics.
 *
 * Splits and merges vs the retired pre-v11 sets: `refines` -> `extends` +
 * `narrows`; `depends-on` -> `consume` + `indexes`; `encodes` merges into
 * `grounds` alongside `grounded-on`; `evidence-for` renames to `verifies` and
 * `evidence-against` (briefly `refutes`) lands in `override`. `supersedes`
 * stays frozen-readable storage only (`db/citations.ts`'s
 * `CITATION_RELATIONS`), never a member of this module's write vocabulary —
 * and `refutes` joins it there, readable on stored rows, unwritable.
 *
 * ## Self edges are refused, always (lane-model-v12 D2, ticket 04)
 *
 * An edge's two ends must be DIFFERENT nodes. There is no exception and no
 * conditional permission: the citing turn's own address is not a legal
 * relation target for any word.
 *
 * The whole conditional apparatus this replaces is DELETED, not narrowed.
 * `grounds` used to be allowed to cite its own turn under two conditions —
 * an IMPLEMENTER half (the citing turn's type had to carry a delivery-phase
 * word) checked inline, and a SETTLEMENT half (the citing turn had to be the
 * CURRENT terminus of a lane it declared via its own tagged `indexes` edge)
 * checked post-transaction as a separate "Gate C" function fed a graph fact
 * the caller computed. Both halves, their two rejection reasons, the
 * post-write gate and its evidence type are gone.
 *
 * The user's reasoning for the flat ban: connectivity's unit is the NODE, and
 * design plus delivery inside one turn never needed splitting into two. The
 * one self edge in the live database is an artifact of the retired
 * cross-phase gate, retracted by migration.
 *
 * A self edge also short-circuits every later check, tags included — the
 * refusal is about the SHAPE of the edge, so there is nothing about its tags
 * worth reporting on top.
 *
 * ## Lane tags: ONE PER SIDE (lane-model-v12 spec D1/D2, ticket 08)
 *
 * An edge carries at most TWO lane tags — one per side. `tailTag` is the
 * CITING side (which lane the reference comes FROM), `headTag` the CITED side
 * (which lane it points AT); the words are the rubric's own (弧尾 / 弧头).
 * The v11 tag SET is gone: a lane's identity is the PAIR `(segment, tag)`, so
 * a many-to-many relation is expressed as SEVERAL EDGES rather than as one
 * edge holding several tags.
 *
 * `''` on a side means UNSETTLED — no one has placed that end in a lane yet.
 * It is not a lane named `''` (see `UNSETTLED_SIDE_TAG`, db/memory-edges.ts).
 *
 * AN EDGE WITH EITHER SIDE UNSETTLED IS A DRAFT, AND A DRAFT IS LEGAL HERE
 * (ticket 20, the user's ruling: "边上只要任意一侧没有 tag 就是草稿形态,计算时
 * 视为无边,但结算的 commit 和检查工具应该出 error 提示"). Both sides empty and
 * exactly ONE side empty are the same shape to this module — a row settlement
 * has not finished — and neither is refused. The checks below judge only the
 * sides that ARE placed.
 *
 * The refusal ticket 08 put here did not disappear; it MOVED. A draft edge is
 * error class E6 in the settlement checker (`shared/lane-checker.ts`), and
 * `commit` refuses while one anchors inside the window's writable set. Those
 * are two different questions with two different answers: "may this row be
 * written" (yes — a writer who cannot yet place an end must still be able to
 * record the relation) and "may this window finish owing it" (no).
 *
 * Per SIDE, for each PLACED side, in this order, each refusal naming the
 * specific side and gap:
 *
 *   1. CANONICAL FORM. A lane tag is stored only as NFC, trimmed, lowercase,
 *      non-empty, no interior whitespace (`db/lanes.ts`'s
 *      `checkCanonicalLaneTag`, which `remember(declare)` refuses against
 *      rather than normalizing). Checked first because a non-canonical value
 *      can never have been declared, so reporting "not declared" for it would
 *      send the writer to declare a tag `declare` itself refuses.
 *   2. DECLARED IN THE SEGMENT THAT SIDE'S ENDPOINT BELONGS TO. A lane's
 *      identity is `(segment, tag)`, and each side is judged against ITS OWN
 *      endpoint's segment — never against the other's. THE CONSEQUENCE WORTH
 *      STATING OUT LOUD: two sides carrying the SAME LITERAL WORD while their
 *      endpoints sit in DIFFERENT segments is a legal CROSS-LANE edge, since
 *      those are two different lanes. A HOMELESS endpoint (a turn carrying no
 *      segment tag, so belonging to no segment) has nowhere for a lane to have
 *      been declared — refused, naming that turn.
 *   3. THE SUBSET INVARIANT, now per side: the side's tag is also in THAT
 *      side's endpoint turn's own stored `tags`. Membership comes from a
 *      node's own tags (spec 解法 4), so an edge may only name a lane its
 *      endpoint actually belongs to.
 *
 * Then ONE structural refusal that is not per-side:
 *
 *   - A SELF edge (citing === cited) is refused outright, before any of the
 *     above — see the self-edge section above. Implemented by ticket 04.
 *
 * WHAT TICKET 20 RETIRES: the `lane-half-settled` refusal (exactly ONE side
 * settled), shipped by ticket 08 on the reasoning that such a row "would enter
 * no lane's connectivity and no settlement queue, so nothing would ever look at
 * it again". The first half is still true and is now the POINT — a draft edge
 * IS invisible to every lane computation (`laneMembershipClaims` returns no
 * claim the moment either side is `''`) — and the second half is what changed:
 * settlement's checker looks at it, every time, as E6.
 *
 * WHAT TICKET 08 RETIRED: the v11 `lane-tags-intersect` refusal (two rows
 * for one (pair, relation) whose SETS overlapped, so a lane read the same
 * logical edge twice). It has no premise left — a side holds ONE value, so
 * two rows on one (pair, relation) differ in at least one side's lane and
 * neither lane can read both as its own internal edge.
 *
 * This module reads no database. Checks 1 and 2 are REGISTRY facts and check 3
 * needs each endpoint's own tags, so all of it arrives as `laneSides` —
 * evidence the CALLER computes (`db/lane-edge-gate.ts`'s
 * `collectEdgeSideFacts`) and this module only judges, the same contract
 * `citingPhases` already had. Ordering the checks here rather than in the
 * adapter is what keeps ONE order for every write path.
 *
 * ## The tag mandate is WITHDRAWN ([S15069/T1548], lane-declaration D2)
 *
 * `extends`/`narrows` used to have no untagged form: continuation was held to
 * name its lane, so the two words whose semantics IS continuation were
 * required to carry a tag. Measured live, that mandate is what MINTED the
 * lanes it was meant to name — 72 lanes over 380 tagged edges, 30 of them
 * two-member and 14 literally one edge, because every related pair had to
 * invent a tag at the moment of its first edge. Lane membership is a
 * hindsight judgment, so ownership moved to settlement instead — and
 * lane-model-v12 ticket 08 (ruling [S15069/T1651]) moved edge-writing PRACTICE
 * with it: the main agent's `note` still carries all seven relation fields —
 * that ruling's own words are 「工具上保留这些能力」, and ticket 08's removal of
 * them was reverted by main-agent-edge-capability ticket 01 — but it is taught
 * not to reach for them, so settlement is in practice the writer here. The
 * checker replaces the old refusal with pressure (an unattributed cluster, a
 * proliferating segment — warnings, never refusals).
 *
 * Nothing here is word-level any more: every one of the seven words has a
 * legal bare form and a legal tagged form, and `TAGGABLE_RELATIONS` below is
 * the whole word-level story.
 */

export const TURN_PHASES = ["evidence", "decision", "delivery"] as const;
export type TurnPhase = (typeof TURN_PHASES)[number];

/** `type` word -> the one phase it belongs to (spec's three-row table). */
export const TYPE_PHASE: Record<MemoryType, TurnPhase> = {
  research: "evidence",
  measure: "evidence",
  design: "decision",
  discuss: "decision",
  correction: "decision",
  implement: "delivery",
  refactor: "delivery",
  fix: "delivery",
  delegate: "delivery",
  review: "delivery",
  ops: "delivery",
};

/**
 * A turn's phase SET (not a single phase): a turn can carry multiple `type`
 * words, so its phase is a set rather than a value. An unrecognised or legacy
 * `type` word (nothing in `MEMORY_TYPES`) contributes no phase, the same
 * "unmapped input strengthens nothing" rule `parseMemberFacetArray`
 * (db/segments.ts) already applies to a member's facet arrays.
 */
export function phasesForTypes(types: readonly string[]): Set<TurnPhase> {
  const phases = new Set<TurnPhase>();
  for (const raw of types) {
    const phase = TYPE_PHASE[raw as MemoryType];
    if (phase !== undefined) {
      phases.add(phase);
    }
  }
  return phases;
}

/**
 * The SEVEN-word closed set a NEW write may legally carry (lane-model v12,
 * rubric-v12's 七种关系). Membership is the WHOLE write-time word test — no
 * phase pairing, no per-word evidence requirement, nothing derived from either
 * endpoint's `type`.
 *
 * `supersedes` and `refutes` are deliberately not members — frozen legacy,
 * `db/citations.ts`'s `CITATION_RELATIONS` is where they survive as
 * storage-level, read-only values. `refutes` rows written before v12 stay
 * readable and retractable; their meaning is now `override`'s (ticket 03
 * migrates the stored rows).
 */
export const EDGE_RELATIONS = [
  "override",
  "narrows",
  "extends",
  "indexes",
  "consume",
  "grounds",
  "verifies",
] as const;
export type TurnEdgeRelation = (typeof EDGE_RELATIONS)[number];

export function isTurnEdgeRelation(value: unknown): value is TurnEdgeRelation {
  return typeof value === "string" && (EDGE_RELATIONS as readonly string[]).includes(value);
}

/**
 * The words a lane tag may attach to: ALL SEVEN ([S15069/T1562], rubric v12's
 * 七种关系). Derived from `EDGE_RELATIONS` rather than listed, so the set
 * cannot drift from the vocabulary it is defined as.
 *
 * It used to be the five same-phase words, on the reasoning that a lane is
 * phase-local and a tag spanning a phase boundary would assert membership
 * across a line the model did not define. The field study that tested that
 * reasoning is why it is gone: 46%/53% of already-legal edges joined turns
 * whose phase SETS differ, so "same phase" was never rigid; and of 29
 * boundary-spanning references only 13 broke a line, 12 of those from
 * dispatch/acceptance/release turns with no single sub-task identity anyway.
 * A tagged edge across that boundary is now the ORDINARY way a design line
 * continues into the delivery that ships it —
 * `实现 —consume{rubric-design}→ spec —grounds{rubric-design}→ 设计终点` is
 * one lane, not two hinged halves.
 *
 * With every word taggable this set is total, so there is no word-level tag
 * refusal left and no `isTaggableRelation` predicate to ask one: the surviving
 * tag refusals are all STRUCTURAL (a self edge, an undeclared lane, a
 * non-canonical tag, an intersecting stored row) and live in
 * `checkTagLegality` below. The name stays because it is the vocabulary
 * statement a reader greps for, and because an EIGHTH word admitted tomorrow
 * inherits taggability here by construction rather than by a second edit.
 *
 * NO WORD REQUIRES A TAG. The mandate that once forced one on
 * `extends`/`narrows` is withdrawn — see this module's header for the measured
 * reason — so there is no `TAG_MANDATORY_RELATIONS` counterpart to this set.
 */
export const TAGGABLE_RELATIONS: ReadonlySet<TurnEdgeRelation> = new Set(EDGE_RELATIONS);

/**
 * The two relations that build a decision BRANCH — `narrows`/`extends`.
 * Relocated here (rubric-v10 ticket 04) from the retired `shared/flows.ts`
 * (the decision-flow derivation, whose read-side callers all retire with
 * this ticket): this module is the vocabulary's one stated home (see
 * `flows.ts`'s own former header note, "this module therefore does NOT
 * re-declare the relation vocabulary, whose one home is the write path"),
 * so a constant naming a subset of that vocabulary belongs here rather than
 * in a new file. The one surviving reader is `shared/lane-checker.ts`
 * (ticket 05's checker), which needs the same two words for its own
 * component/path reports — unrelated to flow derivation, which no longer
 * exists anywhere in the tree.
 */
export const STANCE_RELATIONS: ReadonlySet<TurnEdgeRelation> = new Set(["narrows", "extends"]);

/**
 * The ONE self-edge refusal (lane-model-v12 D2, ticket 04) — replaces four
 * separate details the conditional self-`grounds` permission needed (wrong
 * relation, no delivery phase, no current terminus, tag on a self edge).
 *
 * RED LINE (the write-gate-hardening precedent, `shared/tool-call-syntax.ts`),
 * inherited from the retired mandate's own detail string: none of the details
 * in this module ever reproduces angle-bracket markup. They return straight
 * into the caller's own context, where any quoted call syntax becomes one more
 * exemplar for the attractor that produces malformed calls — so an entry form
 * is described in prose and by its field names, never shown as markup.
 * `containsToolCallSyntax` over every one of them must be false, pinned by
 * test.
 */
const SELF_EDGE_DETAIL =
  "is this turn's own address; an edge's two ends must be DIFFERENT turns, for every relation — " +
  "connectivity's unit is the turn, and design plus delivery inside one turn is one node, not two";

/**
 * The two ends of a directed edge, named — `tail` is the CITING side, `head`
 * the CITED side. Re-declared here rather than imported from
 * `db/memory-edges.ts`'s `EdgeSide` so this module stays free of any DB-layer
 * dependency; a test pins the two spellings against each other.
 */
export type EdgeSideName = "tail" | "head";

/** `''` — the value of a side no one has settled yet. See `UNSETTLED_SIDE_TAG` (db/memory-edges.ts), whose value this mirrors for the same DB-free reason as `EdgeSideName`. */
export const UNSETTLED_LANE_TAG = "";

/** How a refusal names a side: which end, and which turn sits there. */
function sideLabel(side: EdgeSideName, address: string): string {
  return side === "tail"
    ? `the tail side (the citing turn ${address})`
    : `the head side (the cited turn ${address})`;
}

/**
 * Check 1 (spec D2): a side's tag is not in canonical form. The registry's
 * OWN message is quoted verbatim (`db/lanes.ts`'s `checkCanonicalLaneTag`
 * builds it, and `remember(declare)` refuses against the same one) so the
 * writer reads the identical sentence whichever surface it hits first — and
 * so this DB-free module never has to own a second copy of the canonical rule.
 */
function laneTagNotCanonicalDetail(
  entries: readonly { side: EdgeSideName; address: string; message: string }[],
): string {
  const clauses = entries.map(
    (entry) => `on ${sideLabel(entry.side, entry.address)}: ${entry.message}`,
  );
  return (
    "carries a lane tag that is not in canonical form, so no segment could have declared it — " +
    clauses.join(" ")
  );
}

/**
 * Check 2 (spec D2): a side's tag is not declared in the segment ITS OWN
 * endpoint belongs to. Two message shapes because the two gaps take different
 * repairs — a HOMELESS endpoint has no segment to declare in (give that turn
 * its segment's tag first), while an endpoint whose segment simply never
 * declared the word names that segment.
 *
 * The refusal deliberately never speaks of "the other side": a lane's identity
 * is `(segment, tag)`, so each side answers to its own segment alone and the
 * same literal word on two sides in two segments is a legal CROSS-LANE edge,
 * not a gap to report.
 */
function laneNotDeclaredDetail(
  entries: readonly {
    tag: string;
    side: EdgeSideName;
    address: string;
    segment: string | null;
  }[],
): string {
  const clauses = entries.map((entry) =>
    entry.segment === null
      ? `${sideLabel(entry.side, entry.address)} belongs to NO segment, so lane "${entry.tag}" has nowhere to be declared there — put that segment's own tag on the turn first`
      : `${entry.segment}, the segment of ${sideLabel(entry.side, entry.address)}, has not declared lane "${entry.tag}" — declare it there first`,
  );
  return (
    "names a lane that is not declared where that side lives; a lane is declared before it is " +
    "used, and each side is judged against ITS OWN endpoint's segment (the same word in two " +
    `segments is two lanes, which is a legal crossing): ${clauses.join("; ")}`
  );
}

/**
 * Check 3 (spec D2, the subset invariant now read per side): the side's tag
 * is also in THAT side's endpoint turn's own tags. Both sides are checked, so
 * an edge failing on both is told both at once rather than discovering the
 * second gap only on a retry.
 */
function tagMissingDetail(
  missing: readonly { tag: string; side: EdgeSideName; address: string }[],
): string {
  const clauses = missing.map(
    (entry) => `"${entry.tag}" is missing from the tags of ${sideLabel(entry.side, entry.address)}`,
  );
  return (
    "names a lane its own endpoint does not belong to — membership comes from a turn's own tags, " +
    `so a side's tag has to be on that side's turn: ${clauses.join("; ")}`
  );
}

/**
 * A relation target's node kind, as `db/references.ts`'s address parser
 * already distinguishes it — re-declared here rather than imported so this
 * module stays free of any DB-layer dependency.
 */
export type RelationTargetKind = "turn" | "segment";

/**
 * ONE SIDE of an edge, as the caller reads it out of the database
 * (`db/lane-edge-gate.ts`'s `collectEdgeSideFacts`) — this module judges it
 * and never fetches it. Every field describes the side's OWN endpoint, which
 * is what makes each side judgeable against its own segment alone.
 */
export interface EdgeSideFact {
  /** The endpoint's own `S<session>/T<prompt>` address, so a refusal can say WHICH turn. */
  address: string;
  /** `E<n>` of the segment this endpoint belongs to (derived from its own tags), or `null` when it carries no segment tag. */
  segment: string | null;
  /** The tags that segment has DECLARED as lanes. Empty for a homeless endpoint, which has no segment to declare in. */
  declaredTags: ReadonlySet<string>;
  /** The endpoint turn's OWN stored tags — check 3's whole evidence. */
  turnTags: ReadonlySet<string>;
  /** The registry's own canonical-form message when this side's tag is not canonical; `null` when it is (or when the side is unsettled). */
  nonCanonicalMessage: string | null;
}

/**
 * spec D2: the per-side evidence the three checks need, pre-computed by the
 * caller for the same reason `citingPhases` is — this module reads no
 * database. Absent means the caller supplied no evidence and NO verdict is
 * fabricated about the tags (the "never fabricate a verdict" posture the
 * checker's own missing-evidence case takes). Since ticket 20 retired the
 * both-or-neither refusal, "no evidence" means no tag verdict at all: every
 * surviving refusal is per side and every one of them reads a field here.
 */
export interface EdgeSideRegistryFacts {
  /** The CITING side. A self edge is refused before any side check runs, so the two facts always describe two different turns. */
  tail: EdgeSideFact;
  /** The CITED side. */
  head: EdgeSideFact;
}

export interface RelationTargetValidationInput {
  relation: TurnEdgeRelation;
  /**
   * The citing turn's own phase set. NOT a legality input any more: lane-model
   * v12 retired phase pairing (ticket 02) and deleted the self-`grounds`
   * implementer half (ticket 04), which between them were this field's only
   * two readers. Kept on the input shape so the write path keeps passing the
   * same evidence bundle; nothing in this module reads it.
   */
  citingPhases: ReadonlySet<TurnPhase>;
  targetKind: RelationTargetKind;
  /** True when the resolved target IS the citing turn — refused outright, for every relation and whatever the phase or tag state (lane-model-v12 D2; see this module's header). */
  isSelfReference?: boolean;
  /**
   * lane-model-v12 D1: this edge's CITING-side lane tag. `''` or omitted =
   * unsettled. An edge with EITHER side unsettled is a legal DRAFT (ticket 20)
   * — the unsettled side is skipped and only the placed side is judged; with
   * both sides unsettled there is nothing left to judge at all.
   */
  tailTag?: string;
  /** lane-model-v12 D1: this edge's CITED-side lane tag. `''` or omitted = unsettled. */
  headTag?: string;
  /** spec D2: the per-side evidence the three checks are judged against. See `EdgeSideRegistryFacts`. */
  laneSides?: EdgeSideRegistryFacts;
}

export type RelationTargetRejectionReason =
  | "segment-target"
  /** lane-model-v12 D2 (ticket 04): the target IS the citing turn. The ONE self-edge reason — the three narrower ones the conditional self-`grounds` permission needed are deleted with it. */
  | "self-edge"
  /** lane-model-v12 D2, check 1: a side's tag is not in the registry's canonical form, so no segment could have declared it. */
  | "lane-tag-not-canonical"
  /** lane-model-v12 D2, check 2: a side's tag is not declared in the segment THAT side's endpoint belongs to (a homeless endpoint included). */
  | "lane-not-declared"
  /** lane-model-v12 D2, check 3: a side's tag is not on that side's own endpoint turn. */
  | "tag-missing";

export type RelationTargetValidationResult =
  | { ok: true }
  | { ok: false; reason: RelationTargetRejectionReason; detail: string };

const SEGMENT_TARGET_DETAIL =
  "is a segment address — relation targets are turn-only; a segment tie goes through " +
  "ownership (e.g. remember's assign/attach) or a bare cites reference, never a relation";

/**
 * The lane half of `validateRelationTarget` (lane-model-v12 D2, ticket 08),
 * factored out because it runs identically whatever the target was.
 *
 * The UNSETTLED case is uniformly legal ([S15069/T1548] withdrew the tag
 * mandate; ticket 20 makes EITHER side empty the DRAFT form), so an unsettled
 * side is dropped from the judgment rather than judged against a registry it
 * names nothing in — a `''` side has no tag to be non-canonical about, no lane
 * to have been declared and no subset obligation to owe. What remains is per
 * side, in the order this module's header states: canonical form, then
 * declaration, then the subset invariant.
 *
 * WITHIN each check every PLACED side is judged before any refusal is returned
 * — the same "name every gap, not the first one found" rule the detail builders
 * follow, so a writer repairing one side does not discover the other only on
 * a retry.
 *
 * The order lives here rather than at the call site deliberately: a write path
 * sequencing its own registry reads around this function would put the subset
 * invariant somewhere else than its peer the day a second write path appears.
 */
function checkSideTagLegality(
  input: RelationTargetValidationInput,
): RelationTargetValidationResult {
  const tailTag = input.tailTag ?? UNSETTLED_LANE_TAG;
  const headTag = input.headTag ?? UNSETTLED_LANE_TAG;

  // The legal draft: neither side placed. Nothing to check, and nothing the
  // caller could have got wrong.
  if (tailTag === UNSETTLED_LANE_TAG && headTag === UNSETTLED_LANE_TAG) {
    return { ok: true };
  }

  const sides = input.laneSides;
  if (!sides) {
    return { ok: true };
  }
  // Ticket 20: the PLACED sides are the whole domain. A half-settled edge is a
  // legal draft, so its `''` side is dropped here rather than carried into
  // checks 2 and 3, which would otherwise report the empty string as a lane
  // "not declared" and "not on the turn" — two refusals for a shape that is no
  // longer refused at all.
  const perSide = [
    { side: "tail" as const, tag: tailTag, fact: sides.tail },
    { side: "head" as const, tag: headTag, fact: sides.head },
  ].filter((entry) => entry.tag !== UNSETTLED_LANE_TAG);

  // Check 1 — canonical form. First, because a non-canonical value can never
  // have been declared, and reporting "not declared" for it would send the
  // writer to declare a tag `remember(declare)` itself refuses.
  const nonCanonical = perSide
    .filter((entry) => entry.fact.nonCanonicalMessage !== null)
    .map((entry) => ({
      side: entry.side,
      address: entry.fact.address,
      message: entry.fact.nonCanonicalMessage!,
    }));
  if (nonCanonical.length > 0) {
    return {
      ok: false,
      reason: "lane-tag-not-canonical",
      detail: laneTagNotCanonicalDetail(nonCanonical),
    };
  }

  // Check 2 — declared in the segment THIS side's endpoint belongs to. Each
  // side against its own segment: that is what makes the same literal word on
  // two sides in two segments a legal crossing rather than a refusal.
  const undeclared = perSide
    .filter((entry) => entry.fact.segment === null || !entry.fact.declaredTags.has(entry.tag))
    .map((entry) => ({
      tag: entry.tag,
      side: entry.side,
      address: entry.fact.address,
      segment: entry.fact.segment,
    }));
  if (undeclared.length > 0) {
    return { ok: false, reason: "lane-not-declared", detail: laneNotDeclaredDetail(undeclared) };
  }

  // Check 3 — the subset invariant, per side: the side's tag is on that
  // side's own endpoint turn, because membership comes from a node's tags.
  const missing = perSide
    .filter((entry) => !entry.fact.turnTags.has(entry.tag))
    .map((entry) => ({ tag: entry.tag, side: entry.side, address: entry.fact.address }));
  if (missing.length > 0) {
    return { ok: false, reason: "tag-missing", detail: tagMissingDetail(missing) };
  }

  return { ok: true };
}

/**
 * THE shared judgment: every caller that may attach a relation asks this ONE
 * function "is this relation legal here", rather than each re-implementing
 * the segment-target refusal and the self-target refusal against its own copy
 * of the rules.
 *
 * `detail` never carries a leading relation/address label or a trailing
 * period — callers compose those around it however their own message format
 * wants.
 *
 * Three gates in order, each short-circuiting the next: segment-target, then
 * the SELF-target refusal (lane-model-v12 D2, ticket 04 — an edge's two ends
 * must be different turns, so a self target is refused on sight and no later
 * gate runs for it), then tag legality.
 *
 * THE WORD ITSELF IS NEVER REFUSED HERE (lane-model v12, ticket 02). Phase
 * pairing and the evidence-type condition on `verifies` are gone, so a
 * relation is admitted on membership in `EDGE_RELATIONS` alone and every
 * surviving rejection is about the TARGET or the TAG, never about which word
 * a turn's `type` entitles it to write. The measurement behind that: with the
 * multi-phase escape hatch open the phase gate refused exactly one live
 * hand-written edge in the whole database, so it was ceremony charging every
 * writer a rule for one catch.
 */
export function validateRelationTarget(
  input: RelationTargetValidationInput,
): RelationTargetValidationResult {
  if (input.targetKind === "segment") {
    return { ok: false, reason: "segment-target", detail: SEGMENT_TARGET_DETAIL };
  }
  if (input.isSelfReference) {
    // lane-model-v12 D2 (ticket 04): flat refusal. No relation, phase or tag
    // state makes a self edge legal, so nothing below this line runs for one.
    return { ok: false, reason: "self-edge", detail: SELF_EDGE_DETAIL };
  }
  return checkSideTagLegality(input);
}

/**
 * The relation vocabulary's camelCase PARAMETER name, one per `EDGE_RELATIONS`
 * word. Every new word is already a single lowercase token, so this map is
 * the identity function in practice — it stays a `Record` (rather than
 * reusing the string directly) so a schema (`mcp/definitions.ts`'s
 * `noteInputShape`) and a field-loop (`mcp/note.ts`'s `RELATION_FIELD_ENTRIES`)
 * both derive from the SAME exhaustive table, and an eighth relation added to
 * `EDGE_RELATIONS` tomorrow without an entry here is a compile-time error.
 */
export const RELATION_FIELD_NAME: Record<TurnEdgeRelation, string> = {
  override: "override",
  narrows: "narrows",
  extends: "extends",
  indexes: "indexes",
  consume: "consume",
  grounds: "grounds",
  verifies: "verifies",
};

// Re-exported so a consumer that only wants the vocabulary/type table need
// not also import type-vocabulary.ts directly.
export { MEMORY_TYPES };
export type { MemoryType };
