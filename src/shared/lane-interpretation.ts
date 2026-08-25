/**
 * v11 lane-model INTERPRETATION CORE (lane-declaration spec Rev 2, D5;
 * `.scratch/lane-declaration/spec.md`; supersedes rubric-v10 ticket 05's
 * `.scratch/rubric-v10/draft-lane-model.md`, "统一解读原则" + "校验体系"). Pure
 * derivation over plain arrays — no database, no I/O, no module-level state,
 * the same contract `shared/flows.ts`'s `deriveFlows` follows for the
 * decision layer this module supersedes at lane granularity (ticket 01 gave
 * an edge row an immutable canonical tag set; this module is the first
 * reader of that identity).
 *
 * ## Lane identity is now ONE tag (D5) — the merge
 *
 * A lane's identity USED TO BE `(segment, EXACT tag SET)`: `{a}`, `{b}` and
 * `{a,b}` were three independent lanes, none unioned. The user ruled MERGE
 * [T1541]: a lane is `(segment, ONE tag)`, so an edge carrying `["a","b"]` is
 * a member of lane `a` AND lane `b` at once — not a third lane of its own.
 * Mechanically, every tagged edge's own canonical tag SET (`db/lanes.ts`'s
 * ticket-01 invariant, unchanged — `memory_edges.tags` is still a sorted,
 * deduped JSON array) fans out into ONE membership/event PER TAG it carries,
 * crossed with the segment fan-out that already existed (a cross-segment edge
 * still dual-registers, once per side). A same-segment edge tagged `{a,b}`
 * therefore joins TWO lane groups from ONE segment, where it used to join
 * exactly one.
 *
 * This is not cosmetic: an `override` or `indexes` event on a multi-tag edge
 * now fires ONCE PER TAG, so a single write can act on a lane its own tag set
 * only partially names. The peer's own failure figure (spec "What this
 * CHANGES about existing verdicts"): `T2 --indexes{a}--> T1` declares lane
 * `a` (terminus T2); then `T3 --override{a,b}--> T2`. Under the OLD exact-set
 * identity, `{a,b}` was a third, untouched lane, so lane `a` stood
 * undisturbed. Under the merge, that same row is ALSO an event in lane `a`
 * (it carries tag `a`): since T2 was `a`'s terminus, lane `a` REOPENS — no
 * terminus until a fresh declaration. The identical row is simultaneously
 * lane `b`'s own first-ever event (the ordinary "override touched an
 * undeclared lane" case this module already handled for a single-tag edge).
 * This is accepted, not worked around (spec: "This is accepted, not worked
 * around").
 *
 * Three rubric clauses RETIRE with the old exact-set identity (spec D5, v11):
 * exact-set identity itself, superset BRANCH (a narrower tag set used to mint
 * a brand-new, unrelated lane instead of continuing one), and set REOPEN
 * (widening an edge's tag set used to be the only way to touch a second
 * lane's terminus at all). A tag SET is never compared as a whole anywhere in
 * this module any more — every lane-identity comparison is per-tag. Branching
 * is now a different lane related only by narration; reopening is simply a
 * tagged `override` naming the lane's own tag, which needs no set arithmetic.
 *
 * ## The unified interpretation principle (draft-lane-model.md's own anchor,
 * carried over from v10 with one wording fix: "the lane" -> "every lane named
 * by one of the tags")
 *
 * A TAGGED same-phase edge acts on EVERY LANE named by one of the tags in its
 * exact tag set; an UNTAGGED same-phase edge acts on the cited TURN itself
 * (global, free aggregation) — the five SAME-PHASE words (override/narrows/
 * extends/consume/indexes) read this ONE rule, no per-word special case
 * beyond the per-tag fan-out above. Only `indexes` and `override` carry
 * graph-STATE for a lane (a terminus); `narrows`/`extends`/`consume` are
 * structural — they matter to path counting (`lane-checker.ts`) but never
 * move a lane's terminus:
 *
 * The GROUPING loop below (which lane(s) an edge is a member of) was
 * already word-agnostic before this list existed — it keys on `edge.tags`
 * alone, never `edge.relation` — so the user's ruling [T1562] widening which
 * words may carry a tag to all eight needed NO change here: a tagged
 * `grounds`/`verifies`/`refutes` edge groups into its named lane(s) exactly
 * like a tagged same-phase edge already did. What the paragraph above does
 * NOT cover is the cross-phase words' UNTAGGED form: an untagged `grounds`/
 * `verifies`/`refutes` edge is a plain citedness/testimony fact (`lane-
 * checker.ts`'s report 1), never "free aggregation" the way an untagged
 * `indexes` is — the two cross-phase words never carried graph-state and
 * still don't; see `lane-checker.ts`'s module header ("Report domains",
 * lane-declaration ticket 12) for how the CHECKER'S OWN reports read a
 * cross-phase edge's tag state.
 *
 *   - tagged indexes     -> DECLARATION: the citing turn becomes the lane's
 *                           terminus. Latest wins, reduced in CITING-TURN
 *                           order — never edge array order, and never the
 *                           citing turn's raw `id` either when the caller
 *                           supplies a truer order (`LaneTurnInput.order`):
 *                           a backfill-inserted earlier turn can carry a
 *                           LATER row id, so `id` alone is not always
 *                           "later" (draft: "一切 lane 事件…按 turn 序归约").
 *                           `order` is a TWO-ELEMENT TUPLE compared
 *                           lexicographically (round-5 review #10) — a
 *                           scalar encoding of `(session_id, prompt_number)`
 *                           both collides (two distinct pairs hashing to the
 *                           same number) and loses precision at the sizes
 *                           this schema can reach; a tuple has neither
 *                           failure mode.
 *   - tagged override,    -> lane-local correction, once PER TAG the override
 *     carrying tag T          carries: if the cited turn WAS lane T's
 *                              terminus, lane T enters REOPENED state
 *                              (terminus-less until a new declaration) — this
 *                              is the merge (D5): an override tagged `{a,b}`
 *                              is TWO such events at once, one in lane `a`
 *                              and one in lane `b`, even though only one of
 *                              the two may have ever been declared. An
 *                              override elsewhere in the lane only advances
 *                              `latestEventTurn`.
 *   - untagged override  -> NO lane event at all. **Node death is deleted**
 *                           (lane-model-v12, ticket 04): there is no global
 *                           repudiation, so an untagged override is just an
 *                           UNSETTLED edge, and rubric-v12's own rule for
 *                           those is that they "take no part in any
 *                           connectivity, CONVERGENCE or coupling
 *                           computation" — closure is convergence, so an
 *                           untagged override may not unseat any lane's
 *                           terminus either. It is the same "untagged: forms
 *                           no lane" rule every other word already obeyed.
 *   - override tagged     -> indifferent to lane T — T is not among the
 *     with tags that do          tags this override carries, so it is that
 *     not include T             other lane's event entirely, not this one's.
 *
 * A lane never enumerates from an untagged or single-endpoint product: the
 * write-time self-edge gate (`turn-phase.ts`'s `validateRelationTarget`)
 * refuses an edge whose two ends are the same node outright (lane-model-v12
 * D2), so any edge always spans two DISTINCT turns — a lane born from any
 * edge structurally has >= 2 members, and a tag set with no edge at all is
 * simply never grouped. No "single-node lane" case needs handling here.
 *
 * ## declared / reopened / undeclared
 *
 * "收敛不因沉默成立" — convergence is never established by silence. A lane
 * reaches `"declared"` ONLY through an explicit tagged-indexes event; a
 * narrows/extends chain, however long, sets no terminus on its own.
 * `"reopened"` therefore requires a PRIOR declaration since overridden
 * (`everDeclared && terminus === null`). A lane that never declared at all
 * is `"undeclared"` — whether or not an override ever touched it: a
 * same-tag override on a lane's latest structural node, with no declaration
 * EVER made for that lane, creates no terminus to reopen FROM, because none
 * ever existed. `latestEventTurn` is what distinguishes the two undeclared
 * sub-cases for a caller that cares (`null` = no reduction event ever
 * touched the lane; a turn id = an override touched it without ever
 * declaring it — exactly this fixture's `{write-gate}`, T958's override of
 * T957 with no `indexes` ever tagged `write-gate`).
 *
 * ## There is no node death (lane-model-v12, ticket 04)
 *
 * A member is a member. `LaneMember` used to carry a `dead` flag — set by an
 * untagged "global kill" or an in-lane override — and `LaneState` used to
 * carry a `valid`/`invalid` reading derived from it. Both are DELETED: v12
 * has no global repudiation and no killed node, so the only thing an
 * override still moves is the lane's own terminus/latest-activity state.
 * Nothing in this module reads or produces a per-node status any more, and
 * nothing should re-derive one under another name.
 */

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

/** Lexicographic tuple compare — the core's ONE ordering primitive (round-5 review #10): no scalar encoding of the pair anywhere. Exported (milestone-election spec, ticket 02) so a derived-view helper built ON this core's output (`deriveLaneStates` below, and any future one) never reimplements tuple comparison of its own. */
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
 * TWO tag surfaces live on this shape at once, deliberately, for the length
 * of lane-model-v12's expand/contract (spec D1):
 *
 *   - `tags` — ticket 01's IMMUTABLE canonical tag SET, `[]` for untagged.
 *     Still what `deriveLaneInterpretation` below groups and reduces by
 *     (ticket 06 moves that reduction onto the two sides; ticket 09 deletes
 *     the field).
 *   - `tailTag`/`headTag` — the arc's two ends, ONE lane tag each: `tail` is
 *     the CITING side (which lane the reference comes FROM), `head` the
 *     CITED side (which lane it points AT). `UNSETTLED_LANE_TAG` above is
 *     the "no one has settled this side yet" value. Ticket 07's readers —
 *     the election's tier ①, the console graph payload, the timeline's lane
 *     chain — read THESE, never `tags`.
 *
 * `tailTag !== headTag` with both settled is a CROSS-LANE edge: the fact the
 * single merged set structurally could not express (spec, problem 2 — "一条
 * 从 lane A 指向 lane B 的边只能写成无 tag,它跨了哪两条 lane 这个事实丢失").
 * A reader that collapses the two sides back into one set re-loses it.
 */
export interface LaneEdgeInput {
  citingId: number;
  citedId: number;
  relation: string;
  tags: readonly string[];
  tailTag: string;
  headTag: string;
}

export type LaneDeclarationState = "declared" | "reopened" | "undeclared";

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

export interface LaneDeclaration {
  state: LaneDeclarationState;
  /** The current terminus, or `null` when reopened/undeclared. */
  terminus: number | null;
  /**
   * citing turn id of the most recent lane event, in reduction order: a
   * declaration, an in-lane override, a global kill that closed the lane, OR
   * (once at least one of those three has ever touched the lane) a later
   * structural continuation (a tagged narrows/extends/consume edge) — a lane
   * keeps living after its declaration, and this field tracks that. `null`
   * iff NO declaration/override event ever touched the lane (the pure
   * "silence never establishes convergence" case) — a lane with only
   * continuation edges and no declaration/override stays `null` here even
   * though it has structural activity, preserving the undeclared/
   * override-touched distinction the module header documents.
   */
  latestEventTurn: number | null;
}

export interface Lane {
  key: LaneKey;
  /** Ascending by id. Every endpoint of the lane's own tagged edges, overridden ones included — an override never removes a node from its lane ("被推翻的节点留在图中,承载纠正叙事"). */
  members: readonly LaneMember[];
  declaration: LaneDeclaration;
  /** This lane's own tagged edges — every edge whose canonical tag set CONTAINS this lane's one tag (D5: "every live edge carrying that tag"), input order. A multi-tag edge appears here in EVERY lane it names, not just one. */
  taggedEdges: readonly LaneEdgeInput[];
}

/** One cross-segment tagged edge — legal (never rejected), always warned. */
export interface LaneCrossSegmentWarning {
  citingId: number;
  citedId: number;
  /** Canonical tag set the edge carries. */
  tagSet: readonly string[];
  citingSegment: string;
  citedSegment: string;
}

export interface LaneInterpretation {
  /**
   * Every enumerated lane, ordered by segment then tag — deterministic, not
   * input order. TWO independent fan-outs put one edge into several `lanes`
   * entries: a cross-segment tagged edge (citing and cited turns in
   * different segments) enumerates once per side's segment — "the lane is
   * enumerable from both sides' segment scans", both copies sharing the same
   * members/tagged edges/declaration state and differing only in
   * `key.segment` — and (D5, v11) a multi-tag edge enumerates once per tag it
   * carries, each a genuinely DIFFERENT lane with its own independent
   * declaration state (the merge).
   */
  lanes: readonly Lane[];
  laneByToken: ReadonlyMap<string, Lane>;
  /** Every cross-segment tagged edge, named (not merely reflected in the dual lane appearance above) — legal and warned, never rejected. */
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

interface MutableLaneGroup {
  segment: string;
  tag: string;
  edges: LaneEdgeInput[];
}

interface ReduceEvent {
  citingId: number;
  citedId: number;
  relation: "indexes" | "override";
  /** The lane token this event belongs to. Always a real token — an UNTAGGED edge names no lane and therefore produces no event at all (v12: no global repudiation). */
  token: string;
}

/**
 * Derive every lane's membership, tagged edges, and declaration state from
 * one turn/edge set. Pure and stateless — a caller that changed an edge
 * simply calls this again (same "derived view, recompute on read" contract
 * as `deriveFlows`).
 */
export function deriveLaneInterpretation(
  turns: readonly LaneTurnInput[],
  edges: readonly LaneEdgeInput[],
): LaneInterpretation {
  const segmentOf = new Map<number, string>();
  const orderOf = new Map<number, LaneOrderKey>();
  for (const turn of turns) {
    segmentOf.set(turn.id, turn.segment ?? DEFAULT_SEGMENT);
    orderOf.set(turn.id, turn.order ?? [0, turn.id]);
  }
  // A turn absent from `turns` (partial-coverage input, `lane-checker.ts`'s
  // coverage report) still needs a segment/order to group and sort by — it
  // falls back to its own id for both, so an incomplete projection degrades
  // to "one extra default scope, sorted by its own id" rather than throwing.
  const segmentFor = (id: number): string => segmentOf.get(id) ?? DEFAULT_SEGMENT;
  const orderFor = (id: number): LaneOrderKey => orderOf.get(id) ?? [0, id];

  // ---- lane enumeration: group by (a segment, ONE tag) — D5, v11 ----
  // TWO independent fan-outs put one edge into several groups: a
  // cross-segment tagged edge (citing/cited segments differ) is a real,
  // allowed shape (draft: "偶尔耦合允许") — DUAL APPEARANCE: it registers in
  // BOTH sides' segment groups, recorded once in `warnings` (legal, warned,
  // never rejected — the write gate's business is elsewhere, not this
  // module's); and (the merge) a multi-tag edge registers once PER TAG it
  // carries, in each applicable segment — `{a,b}` on a same-segment edge
  // joins TWO groups from that one segment, not one.
  const groups = new Map<string, MutableLaneGroup>();
  const warnings: LaneCrossSegmentWarning[] = [];
  function addToGroup(segment: string, tag: string, edge: LaneEdgeInput): string {
    const token = laneToken(segment, tag);
    let group = groups.get(token);
    if (group === undefined) {
      group = { segment, tag, edges: [] };
      groups.set(token, group);
    }
    group.edges.push(edge);
    return token;
  }
  for (const edge of edges) {
    const canon = canonicalTagSet(edge.tags);
    if (canon.length === 0) continue; // untagged: forms no lane (requirement 2)
    const citingSegment = segmentFor(edge.citingId);
    const citedSegment = segmentFor(edge.citedId);
    for (const tag of canon) {
      addToGroup(citingSegment, tag, edge);
      if (citedSegment !== citingSegment) {
        addToGroup(citedSegment, tag, edge);
      }
    }
    if (citedSegment !== citingSegment) {
      // Once per cross-segment EDGE, not per tag — the warning names the
      // edge's whole tag set informationally; it is not a lane identity.
      warnings.push({
        citingId: edge.citingId,
        citedId: edge.citedId,
        tagSet: canon,
        citingSegment,
        citedSegment,
      });
    }
  }

  // ---- unified event reduction, in TURN-ORDER (never edge array order, never raw id when `order` differs) ----
  // D5, v11: an `indexes`/`override` on a multi-tag edge pushes ONE event PER
  // TAG (crossed with the segment fan-out below) — this is the merge itself.
  // `T3 --override{a,b}--> T2` pushes an event into lane `a` AND lane `b`,
  // each reduced independently by the batch logic below exactly as if it had
  // been two separate single-tag override edges.
  const events: ReduceEvent[] = [];
  function pushEvent(citingId: number, citedId: number, relation: "indexes" | "override", token: string): void {
    events.push({ citingId, citedId, relation, token });
  }
  for (const edge of edges) {
    if (edge.relation !== "indexes" && edge.relation !== "override") continue;
    const canon = canonicalTagSet(edge.tags);
    if (canon.length === 0) {
      // UNTAGGED: no lane event at all, for EITHER word. An untagged
      // `indexes` is free aggregation; an untagged `override` used to be the
      // global kill and is now simply an unsettled edge (ticket 04 — see the
      // module header's own bullet).
      continue;
    }
    const citingSegment = segmentFor(edge.citingId);
    const citedSegment = segmentFor(edge.citedId);
    for (const tag of canon) {
      const citingToken = laneToken(citingSegment, tag);
      // defensive: every tagged indexes/override is itself a tagged edge, so
      // its group(s) always exist — kept for robustness against malformed input.
      if (groups.has(citingToken)) {
        pushEvent(edge.citingId, edge.citedId, edge.relation, citingToken);
      }
      if (citedSegment !== citingSegment) {
        const citedToken = laneToken(citedSegment, tag);
        if (groups.has(citedToken)) {
          pushEvent(edge.citingId, edge.citedId, edge.relation, citedToken);
        }
      }
    }
  }
  events.sort((a, b) => compareOrderKey(orderFor(a.citingId), orderFor(b.citingId)) || a.citingId - b.citingId);

  const terminusOf = new Map<string, number | null>();
  const everDeclared = new Map<string, boolean>();
  const latestEventTurn = new Map<string, number | null>();
  for (const token of groups.keys()) {
    terminusOf.set(token, null);
    everDeclared.set(token, false);
    latestEventTurn.set(token, null);
  }

  let index = 0;
  while (index < events.length) {
    const citingId = events[index]!.citingId;
    let end = index;
    while (end < events.length && events[end]!.citingId === citingId) {
      end += 1;
    }
    const batch = events.slice(index, end);
    index = end;

    // Phase 1 — overrides, effects computed against the state as of the
    // START of this turn's batch (same-turn events are on one axis, no
    // sub-order between them; see module header).
    for (const event of batch) {
      if (event.relation !== "override") continue;
      if (terminusOf.get(event.token) === event.citedId) {
        terminusOf.set(event.token, null);
      }
      latestEventTurn.set(event.token, citingId);
    }

    // Phase 2 — declarations. Latest wins; a turn declaring itself terminus
    // for the same lane twice in one batch (redundant `indexes` rows citing
    // different targets) is idempotent.
    for (const event of batch) {
      if (event.relation !== "indexes") continue;
      terminusOf.set(event.token, citingId);
      everDeclared.set(event.token, true);
      latestEventTurn.set(event.token, citingId);
    }
  }

  // ---- structural continuations advance latestEventTurn too, but only for
  // a lane that has ALREADY been touched by a declaration/override event —
  // an untouched lane's latestEventTurn stays `null` ("no reduction event
  // ever touched the lane"), preserving the two-undeclared-subcases contract
  // the module header documents; a touched lane keeps tracking its freshest
  // activity as the lane continues living past that event. ----
  for (const [token, group] of groups) {
    const current = latestEventTurn.get(token) ?? null;
    if (current === null) continue;
    let bestId = current;
    let bestOrder = orderFor(current);
    for (const edge of group.edges) {
      if (edge.relation === "indexes" || edge.relation === "override") continue; // already accounted above
      const order = orderFor(edge.citingId);
      const cmp = compareOrderKey(order, bestOrder);
      if (cmp > 0 || (cmp === 0 && edge.citingId > bestId)) {
        bestOrder = order;
        bestId = edge.citingId;
      }
    }
    latestEventTurn.set(token, bestId);
  }

  // ---- assemble lanes, deterministic order (segment, then tag key) ----
  const tokens = [...groups.keys()].sort();
  const lanes: Lane[] = [];
  const laneByToken = new Map<string, Lane>();
  for (const token of tokens) {
    const group = groups.get(token)!;
    const memberIds = new Set<number>();
    for (const edge of group.edges) {
      memberIds.add(edge.citingId);
      memberIds.add(edge.citedId);
    }
    const members: LaneMember[] = [...memberIds].sort((a, b) => a - b).map((id) => ({ id }));
    const terminus = terminusOf.get(token) ?? null;
    const state: LaneDeclarationState =
      terminus !== null ? "declared" : everDeclared.get(token) ? "reopened" : "undeclared";
    const lane: Lane = {
      key: { segment: group.segment, tag: group.tag },
      members,
      declaration: {
        state,
        terminus,
        latestEventTurn: latestEventTurn.get(token) ?? null,
      },
      taggedEdges: group.edges,
    };
    lanes.push(lane);
    laneByToken.set(token, lane);
  }

  return { lanes, laneByToken, warnings };
}

/**
 * ## Lane-state helper (milestone-election spec, ticket 02) — ADDITIVE ONLY
 *
 * `closed`/`open`, read straight off ONE `deriveLaneInterpretation` result —
 * no second reduction pass, no new event, nothing above this comment touched.
 * Two independent consumers share this: the election module
 * (`shared/milestone-election.ts`) for identity tier ②, and
 * `lane-checker.ts`'s report 1 (ticket 04) for its state line — "no parallel
 * derivations anywhere" (spec's implementation note).
 *
 * **Two of this helper's outputs are DELETED** (lane-model-v12, ticket 04).
 * One was a verdict on whether a closed lane's declared core still held a
 * living node — a question about node death, which no longer exists. The
 * other named an OPEN lane's most recent declaring turn, a seat v12 has no
 * reopen mechanism to justify (a lane is open exactly when its newest member
 * is not an index, which says nothing about any earlier declaration).
 * A lane's whole machine-readable state is closure plus terminus.
 *
 *   - **closed**: the declaration is CURRENTLY active (`state ===
 *     "declared"`) AND nothing has touched the lane since — the declaring
 *     turn is STILL the lane's freshest activity
 *     (`declaration.terminus === declaration.latestEventTurn`). A lane that
 *     kept living past its own declaration (a narrows/extends continuation
 *     with no re-declaration — `latestEventTurn` advances past `terminus`,
 *     see this module's own "structural continuations" pass above) is
 *     **open**, not closed, even though the raw reduction still reports
 *     `state: "declared"`: the spec's own test is "the lane's LATEST node
 *     is its terminus," not merely "a terminus currently exists." This is
 *     the one non-obvious fold in this helper — the mutation-detecting
 *     property a caller should probe first.
 *   - **open**: everything else — undeclared, reopened (override-nulled),
 *     or declared-but-continued (above).
 */

export type LaneClosure = "closed" | "open";

export interface LaneState {
  key: LaneKey;
  closure: LaneClosure;
  /** Mirrors `declaration.terminus` — `null` unless the lane is currently declared. */
  terminus: number | null;
}

/**
 * Derive `closed`/`open` for every lane in `lanes` (typically
 * `deriveLaneInterpretation(turns, edges).lanes`, passed straight through) —
 * pure, keyed by the same lane token `laneByToken` uses, so a caller already
 * holding one `deriveLaneInterpretation` result can look a lane's state up by
 * `laneToken(key.segment, key.tag)` with no re-derivation. This helper does
 * not read `deriveLaneInterpretation`'s own internal state, only its OUTPUT
 * (`Lane.declaration`).
 */
export function deriveLaneStates(lanes: readonly Lane[]): ReadonlyMap<string, LaneState> {
  const states = new Map<string, LaneState>();
  for (const lane of lanes) {
    const closed =
      lane.declaration.state === "declared" &&
      lane.declaration.terminus === lane.declaration.latestEventTurn;
    const token = laneToken(lane.key.segment, lane.key.tag);
    states.set(token, {
      key: lane.key,
      closure: closed ? "closed" : "open",
      terminus: lane.declaration.terminus,
    });
  }
  return states;
}
