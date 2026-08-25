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
 * ## Lane tags (lane-declaration spec D2, rubric v11's 八词 section)
 *
 * ALL SEVEN words may carry a lane-tag set, and NONE requires one. A lane is
 * not phase-local: a tagged edge is how a lane continues from the decisions
 * that shaped it into the delivery that ships it, which is what makes a
 * design→delivery line ONE lane instead of two hinged halves ([S15069/T1562]).
 * One edge may carry SEVERAL tags — the lanes converge there — and each tag
 * is judged independently.
 *
 * Per tag, in this order, each refusal naming the specific gap:
 *
 *   1. CANONICAL FORM. A lane tag is stored only as NFC, trimmed, lowercase,
 *      non-empty, no interior whitespace (`db/lanes.ts`'s
 *      `checkCanonicalLaneTag`, which `remember(declare)` refuses against
 *      rather than normalizing). Checked first because a non-canonical value
 *      can never have been declared, so reporting "not declared" for it would
 *      send the writer to declare a tag `declare` itself refuses.
 *   2. DECLARED IN EVERY ENDPOINT'S SEGMENT. A lane's identity is
 *      `(segment, ONE tag)` and it must be declared BEFORE it is used, so a
 *      tagged edge may name only a lane declared in the segment of EVERY
 *      endpoint turn. A HOMELESS endpoint (a turn in no segment) is never
 *      legal — the refusal says which turn. A CROSS-SEGMENT edge is legal
 *      exactly when both segments declared the tag; the refusal names the
 *      segment missing it.
 *   3. THE SUBSET INVARIANT (unchanged, rubric-v10 ticket 02's Gate B): every
 *      tag on the edge already exists on BOTH endpoint turns' own stored
 *      `tags` — violation names which tag and which endpoint is missing it.
 *
 * Then two structural refusals that are not per-tag:
 *
 *   - A SELF edge (citing === cited) may not carry a tag AT ALL. A tag names
 *     a lane and a lane has at least two nodes, so a one-node self-loop is
 *     not one; a tagged self-`grounds` would otherwise enter the lane's DAG
 *     as a self-loop the shape report reads as 0 sources / 0 sinks and passes
 *     in silence.
 *   - TWO ROWS FOR THE SAME (pair, relation) WHOSE TAG SETS INTERSECT. Row
 *     identity is (pair, relation, EXACT tag set), so `extends{a}` and
 *     `extends{a,b}` both persist and lane `a` then reads the same logical
 *     edge twice — double-counting edge totals, milestone in-degree and
 *     console edges. The way to widen an edge's lanes is retract-and-rewrite
 *     with the UNION, which the refusal says.
 *
 * This module reads no database. Checks 1, 2 and the intersection test are
 * all GRAPH/REGISTRY facts, so they arrive as `laneRegistry` — evidence the
 * CALLER computes (`db/lane-edge-gate.ts`'s `collectLaneRegistryFacts`) and
 * this module only judges, the same contract `citingTurnTags`/`citedTurnTags`
 * already have. Ordering them here rather than in the adapter is what keeps
 * ONE order for BOTH write paths: a caller running its registry checks around
 * this function would put the subset invariant in a different place than its
 * peer.
 *
 * ## The tag mandate is WITHDRAWN ([S15069/T1548], lane-declaration D2)
 *
 * `extends`/`narrows` used to have no untagged form: continuation was held to
 * name its lane, so the two words whose semantics IS continuation were
 * required to carry a tag. Measured live, that mandate is what MINTED the
 * lanes it was meant to name — 72 lanes over 380 tagged edges, 30 of them
 * two-member and 14 literally one edge, because every related pair had to
 * invent a tag at the moment of its first edge. Lane membership is a
 * hindsight judgment, so ownership moved to settlement instead: the main
 * agent MAY carry lane tags and is never required to, settlement declares and
 * tags, and the checker replaces the refusal with pressure (an unattributed
 * cluster, a proliferating segment — warnings, never refusals).
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
 * Check 1 (lane-declaration D2): a tag not in canonical form. The registry's
 * OWN message is quoted verbatim (`db/lanes.ts`'s `checkCanonicalLaneTag`
 * builds it, and `remember(declare)` refuses against the same one) so the
 * writer reads the identical sentence whichever surface it hits first — and
 * so this DB-free module never has to own a second copy of the canonical rule.
 */
function laneTagNotCanonicalDetail(
  entries: readonly { tag: string; message: string }[],
): string {
  return (
    "carries a lane tag that is not in canonical form, so no segment could have declared it — " +
    entries.map((entry) => entry.message).join(" ")
  );
}

/** One endpoint's registry standing, as `laneNotDeclaredDetail` words it. */
type LaneEndpointSide = "citing" | "cited";

/**
 * Check 2 (lane-declaration D2): a tag whose lane is not declared where it is
 * used. Two message shapes because the two gaps take different repairs — a
 * HOMELESS endpoint has no segment to declare in (assign it first), while a
 * declared-on-one-side-only cross-segment edge names the segment that is
 * missing the declaration. Both name the TURN, so "which endpoint" is never
 * left to inference.
 */
function laneNotDeclaredDetail(
  entries: readonly {
    tag: string;
    endpoint: LaneEndpointSide;
    address: string;
    segment: string | null;
  }[],
): string {
  const clauses = entries.map((entry) =>
    entry.segment === null
      ? `the ${entry.endpoint} turn ${entry.address} belongs to NO segment, so lane "${entry.tag}" has nowhere to be declared — assign that turn to a segment first`
      : `${entry.segment}, the segment owning the ${entry.endpoint} turn ${entry.address}, has not declared lane "${entry.tag}" — declare it there first`,
  );
  return (
    "names a lane that is not declared at every endpoint; a lane is declared before it is used, " +
    "and a tagged edge names one in the segment of BOTH endpoint turns (a cross-segment edge is " +
    `legal exactly when both segments declared the tag): ${clauses.join("; ")}`
  );
}

/**
 * The intersecting-stored-row refusal (peer finding P1-4). Row identity is
 * (pair, relation, EXACT tag set), so `extends{a}` and `extends{a,b}` both
 * persist and lane `a` reads the same logical edge TWICE — double-counting
 * that lane's edge total, its members' milestone in-degree and the console's
 * edge counts. The refusal names the stored set, the overlap, and the one
 * legal way to widen an edge's lanes.
 */
function laneTagsIntersectDetail(
  tags: readonly string[],
  relation: string,
  rows: readonly { tags: readonly string[]; shared: readonly string[] }[],
): string {
  const clauses = rows.map(
    (row) => `a \`${relation}\` row tagged {${row.tags.join(",")}} (shared: ${row.shared.map((tag) => `"${tag}"`).join(", ")})`,
  );
  return (
    `carries lane tags {${tags.join(",")}} while this same pair already stores ${clauses.join("; ")} — ` +
    "each shared tag's lane would read the same edge twice. Widen an existing edge's lanes by " +
    "RETRACTING that row and re-writing it once with the UNION of both sets, never by adding a " +
    "second overlapping row"
  );
}

/**
 * rubric-v10 ticket 02 (Gate B): builds the "tag X missing from the Y turn's
 * tags" clause, one entry per (tag, endpoint) that fails the subset
 * invariant — both endpoints are checked for every tag, so a tag missing
 * from both is named twice, once per endpoint, rather than only the first
 * failure found (a caller fixing one endpoint and re-submitting should not
 * discover the second gap only on a second rejection).
 */
function tagMissingDetail(missing: readonly { tag: string; endpoint: "citing" | "cited" }[]): string {
  const clauses = missing.map(
    (entry) => `"${entry.tag}" is missing from the ${entry.endpoint} turn's tags`,
  );
  return `carries a tag that fails the subset invariant — ${clauses.join("; ")}`;
}

/**
 * A relation target's node kind, as `db/references.ts`'s address parser
 * already distinguishes it — re-declared here rather than imported so this
 * module stays free of any DB-layer dependency.
 */
export type RelationTargetKind = "turn" | "segment";

/**
 * One endpoint turn's REGISTRY standing, as the caller reads it out of the
 * database (`db/lane-edge-gate.ts`'s `collectLaneRegistryFacts`) — this module
 * judges it and never fetches it.
 */
export interface LaneEndpointRegistryFact {
  /** The endpoint's own `S<session>/T<prompt>` address, so a refusal can say WHICH turn. */
  address: string;
  /** `E<n>` of the segment that owns this endpoint, or `null` when the turn belongs to no segment (homeless). */
  segment: string | null;
  /** The tags that segment has DECLARED as lanes. Empty for a homeless endpoint, which has no segment to declare in. */
  declaredTags: ReadonlySet<string>;
}

/**
 * lane-declaration D2: the registry/graph evidence the per-tag checks need,
 * pre-computed by the caller for the same reason `citingPhases` and
 * `citingTurnTags` are — this module reads no database. Absent means the
 * caller supplied no evidence, and checks 1/2 and the intersection test yield
 * NO verdict (the "never fabricate a verdict" posture the checker's own
 * `tags: undefined` case takes); the subset invariant still runs. Both live
 * write paths — `mcp/note.ts` and `worker/note-settlement-turn-facade.ts` —
 * always supply it, which is what makes the gate uniform across writers.
 */
export interface LaneRegistryFacts {
  citing: LaneEndpointRegistryFact;
  /** A self edge is refused before any tag check runs, so both sides here always describe two different turns. */
  cited: LaneEndpointRegistryFact;
  /** Tag -> the registry's own canonical-form message, for each tag of THIS write that is not canonical. */
  nonCanonical: ReadonlyMap<string, string>;
  /**
   * Stored rows for the SAME (pair, relation) whose tag set INTERSECTS this
   * write's set without being IDENTICAL to it — an identical set is an
   * idempotent restatement of the very row being written and stays legal.
   */
  intersectingRows: readonly { tags: readonly string[]; shared: readonly string[] }[];
}

export interface RelationTargetValidationInput {
  relation: TurnEdgeRelation;
  /**
   * The citing turn's own phase set. NOT a legality input any more: lane-model
   * v12 retired phase pairing (ticket 02) and deleted the self-`grounds`
   * implementer half (ticket 04), which between them were this field's only
   * two readers. Kept on the input shape so both write paths keep passing the
   * same evidence bundle; nothing in this module reads it.
   */
  citingPhases: ReadonlySet<TurnPhase>;
  targetKind: RelationTargetKind;
  /** True when the resolved target IS the citing turn — refused outright, for every relation and whatever the phase or tag state (lane-model-v12 D2; see this module's header). */
  isSelfReference?: boolean;
  /**
   * This edge's own lane-tag set, already canonicalized by the caller (sorted,
   * deduped — `db/memory-edges.ts`'s `canonicalizeTagSet`). Omitted or empty
   * means untagged, which is legal for ALL SEVEN words: no word requires a tag
   * ([S15069/T1548] — see this module's header for the mandate's withdrawal),
   * and there is nothing to check when there is no tag to check.
   */
  tags?: readonly string[];
  /** Gate B: the citing turn's own stored `tags`, canonicalized. Required only when `tags` is non-empty. */
  citingTurnTags?: ReadonlySet<string>;
  /** Gate B: the cited turn's own stored `tags`, canonicalized. Ignored for a segment target or a self-reference (both endpoints are the same turn there). */
  citedTurnTags?: ReadonlySet<string>;
  /** lane-declaration D2: the registry evidence checks 1/2 and the intersection test are judged against. See `LaneRegistryFacts`. */
  laneRegistry?: LaneRegistryFacts;
}

export type RelationTargetRejectionReason =
  | "segment-target"
  /** lane-model-v12 D2 (ticket 04): the target IS the citing turn. The ONE self-edge reason — the three narrower ones the conditional self-`grounds` permission needed are deleted with it. */
  | "self-edge"
  /** lane-declaration D2, check 1: a tag not in the registry's canonical form, so no segment could have declared it. */
  | "lane-tag-not-canonical"
  /** lane-declaration D2, check 2: a tag whose lane is not declared in some endpoint's segment (a homeless endpoint included). */
  | "lane-not-declared"
  | "tag-missing"
  /** lane-declaration D2 (peer P1-4): a second row for the same (pair, relation) whose tag set intersects a stored one. */
  | "lane-tags-intersect";

export type RelationTargetValidationResult =
  | { ok: true }
  | { ok: false; reason: RelationTargetRejectionReason; detail: string };

const SEGMENT_TARGET_DETAIL =
  "is a segment address — relation targets are turn-only; a segment tie goes through " +
  "ownership (e.g. remember's assign/attach) or a bare cites reference, never a relation";

/**
 * The tag-legality half of `validateRelationTarget`, factored out because it
 * runs identically whether the target was the citing turn itself or another
 * turn.
 *
 * The UNTAGGED case is uniformly legal again ([S15069/T1548]): no word
 * requires a tag, so an empty set short-circuits every check below. The
 * WORD-level case is gone with it — all seven words are taggable, so what
 * remains is structural, in the order this module's header states: a self
 * edge, then per tag canonical form, then per tag declaration, then the
 * subset invariant, then the intersecting-stored-row test.
 *
 * The order is here rather than at the two call sites deliberately. Each
 * write path would otherwise sequence its own registry reads around this
 * function and the two would drift — which is the same "NO CARVE-OUTS BY
 * WRITER" property the retired mandate's own doc comment claimed and the one
 * part of it worth keeping.
 */
function checkTagLegality(input: RelationTargetValidationInput): RelationTargetValidationResult {
  const tags = input.tags ?? [];
  if (tags.length === 0) {
    return { ok: true };
  }
  const registry = input.laneRegistry;
  if (registry) {
    const nonCanonical = tags
      .filter((tag) => registry.nonCanonical.has(tag))
      .map((tag) => ({ tag, message: registry.nonCanonical.get(tag)! }));
    if (nonCanonical.length > 0) {
      return {
        ok: false,
        reason: "lane-tag-not-canonical",
        detail: laneTagNotCanonicalDetail(nonCanonical),
      };
    }
    // Both endpoints, every tag — the same "name every gap, not the first
    // one found" rule `tagMissingDetail` follows, so a writer repairing one
    // side does not discover the other only on a retry.
    const undeclared: {
      tag: string;
      endpoint: LaneEndpointSide;
      address: string;
      segment: string | null;
    }[] = [];
    for (const tag of tags) {
      for (const endpoint of ["citing", "cited"] as const) {
        const fact = registry[endpoint];
        if (fact.segment === null || !fact.declaredTags.has(tag)) {
          undeclared.push({ tag, endpoint, address: fact.address, segment: fact.segment });
        }
      }
    }
    if (undeclared.length > 0) {
      return { ok: false, reason: "lane-not-declared", detail: laneNotDeclaredDetail(undeclared) };
    }
  }
  const citingTags = input.citingTurnTags ?? new Set<string>();
  const citedTags = input.citedTurnTags ?? new Set<string>();
  const missing: { tag: string; endpoint: "citing" | "cited" }[] = [];
  for (const tag of tags) {
    if (!citingTags.has(tag)) {
      missing.push({ tag, endpoint: "citing" });
    }
    if (!citedTags.has(tag)) {
      missing.push({ tag, endpoint: "cited" });
    }
  }
  if (missing.length > 0) {
    return { ok: false, reason: "tag-missing", detail: tagMissingDetail(missing) };
  }
  if (registry && registry.intersectingRows.length > 0) {
    return {
      ok: false,
      reason: "lane-tags-intersect",
      detail: laneTagsIntersectDetail(tags, input.relation, registry.intersectingRows),
    };
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
  return checkTagLegality(input);
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
