/**
 * v10 lane-model INTERPRETATION CORE (rubric-v10 ticket 05; concept doc
 * `.scratch/rubric-v10/draft-lane-model.md`, "统一解读原则" + "校验体系"). Pure
 * derivation over plain arrays — no database, no I/O, no module-level state,
 * the same contract `shared/flows.ts`'s `deriveFlows` follows for the
 * decision layer this module supersedes at lane granularity (ticket 01 gave
 * an edge row an immutable canonical tag set; this module is the first
 * reader of that identity).
 *
 * ## The unified interpretation principle (the draft's own anchor)
 *
 * A TAGGED same-phase edge acts on the LANE its exact tag set identifies; an
 * UNTAGGED same-phase edge acts on the cited TURN itself (global, free
 * aggregation) — every taggable word (override/narrows/extends/consume/
 * indexes) reads this ONE rule, no per-word special case. Only `indexes` and
 * `override` carry graph-STATE for a lane (a terminus); `narrows`/`extends`/
 * `consume` are structural — they matter to path counting (`lane-checker.ts`)
 * but never move a lane's terminus:
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
 *   - tagged override,    -> lane-local correction: the cited turn loses its
 *     same tag as this        EFFECTIVE status in this lane (a dead node)
 *     lane                    regardless of whether it currently is the
 *                              terminus. If it WAS the terminus, the lane
 *                              enters REOPENED state (terminus-less until a
 *                              new declaration).
 *   - untagged override  -> GLOBAL kill: the cited turn dies in EVERY lane it
 *                           is a member of (not only where it terminates);
 *                           every lane it currently terminates loses that
 *                           terminus (reopened).
 *   - override tagged     -> indifferent to THIS lane — it is another lane's
 *     with a DIFFERENT         event entirely.
 *     lane's tag set
 *
 * A lane never enumerates from an untagged or single-endpoint product: the
 * write-time self-citation gate (`turn-phase.ts`'s `validateRelationTarget`)
 * already refuses every taggable (same-phase) relation a self target, so a
 * tagged edge always spans two DISTINCT turns — a lane born from any edge
 * structurally has >= 2 members, and a tag set with no edge at all is simply
 * never grouped. No separate "single-node lane" case needs handling here.
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
 * EVER made for that lane, still marks that node dead (it lost its
 * effective status) but creates no terminus to reopen FROM, because none
 * ever existed. `latestEventTurn` is what distinguishes the two undeclared
 * sub-cases for a caller that cares (`null` = no reduction event ever
 * touched the lane; a turn id = an override touched it without ever
 * declaring it — exactly this fixture's `{write-gate}`, T958's override of
 * T957 with no `indexes` ever tagged `write-gate`).
 *
 * ## dead status is a final-state snapshot, not an online flag
 *
 * `dead` only ever gets ADDED to (global kill, in-lane override), never
 * removed — so reading it after the whole reduction pass is equivalent to
 * reading it "as of" any later point; no per-event ordering subtlety exists
 * for membership status itself, only for the terminus/declaration state.
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

/** One edge assertion row (ticket 01's shape): `tags` is the row's own IMMUTABLE canonical tag set, `[]` for untagged. `citingId` is always the LATER turn (`turn-phase.ts`'s direction convention). */
export interface LaneEdgeInput {
  citingId: number;
  citedId: number;
  relation: string;
  tags: readonly string[];
}

export type LaneDeclarationState = "declared" | "reopened" | "undeclared";

/** A lane's machine identity: segment + exact canonical tag set. No subset/hierarchy is read here — that is a human layer over this exact-set data (draft: "层级是解读,不是机制"). */
export interface LaneKey {
  segment: string;
  /** Canonical: deduped, ascending. */
  tagSet: readonly string[];
}

export interface LaneMember {
  id: number;
  /** true when globally killed (untagged override) or lane-locally overridden (same-tag override) — see module header. */
  dead: boolean;
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
  /** Ascending by id, dead members included (separated by the `dead` flag, never dropped — "被推翻的节点留在图中,作为死节点承载纠正叙事"). */
  members: readonly LaneMember[];
  declaration: LaneDeclaration;
  /** This lane's own tagged edges (exact tag-set match), input order. */
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
   * Every enumerated lane, ordered by segment then canonical tag key —
   * deterministic, not input order. A cross-segment tagged edge (citing and
   * cited turns in different segments) enumerates its lane TWICE, once per
   * side's segment — "the lane is enumerable from both sides' segment
   * scans" — both copies share the same members/tagged edges/declaration
   * state, differing only in `key.segment`.
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
 * The token a lane is grouped and looked up by: segment + canonical tag set.
 * JSON-encoded as a `[segment, tagSet]` pair (round-5 review #14) -- the
 * former U+0000/U+0001-delimited join collided whenever a real tag happened
 * to CONTAIN the delimiter character itself: `["a","b"]` joined on U+0001
 * produces the identical string to the single tag `["a\u0001b"]` joined the
 * same way. `JSON.stringify` self-delimits every element via its own
 * quoting/escaping, so no input can ever produce two different
 * `[segment, tagSet]` pairs that serialize identically.
 */
export function laneToken(segment: string, tags: readonly string[]): string {
  return JSON.stringify([segment, canonicalTagSet(tags)]);
}

interface MutableLaneGroup {
  segment: string;
  tagSet: string[];
  edges: LaneEdgeInput[];
}

interface ReduceEvent {
  citingId: number;
  citedId: number;
  relation: "indexes" | "override";
  /** `null` for an untagged override (global-kill event); the lane token for every tagged event. */
  token: string | null;
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

  // ---- lane enumeration: group by (a segment, exact tag set) ----
  // A cross-segment tagged edge (citing/cited segments differ) is a real,
  // allowed shape (draft: "偶尔耦合允许") — DUAL APPEARANCE: it registers in
  // BOTH sides' segment groups, so a caller scanning either segment's lanes
  // finds it, and is recorded once in `warnings` (legal, warned, never
  // rejected — the write gate's business is elsewhere, not this module's).
  const groups = new Map<string, MutableLaneGroup>();
  const warnings: LaneCrossSegmentWarning[] = [];
  function addToGroup(segment: string, canon: readonly string[], edge: LaneEdgeInput): string {
    const token = laneToken(segment, canon);
    let group = groups.get(token);
    if (group === undefined) {
      group = { segment, tagSet: [...canon], edges: [] };
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
    addToGroup(citingSegment, canon, edge);
    if (citedSegment !== citingSegment) {
      addToGroup(citedSegment, canon, edge);
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
  const events: ReduceEvent[] = [];
  function pushEvent(citingId: number, citedId: number, relation: "indexes" | "override", token: string | null): void {
    events.push({ citingId, citedId, relation, token });
  }
  for (const edge of edges) {
    if (edge.relation !== "indexes" && edge.relation !== "override") continue;
    const canon = canonicalTagSet(edge.tags);
    if (canon.length === 0) {
      if (edge.relation === "override") {
        pushEvent(edge.citingId, edge.citedId, "override", null);
      }
      // an untagged indexes is free aggregation — no lane event at all.
      continue;
    }
    const citingSegment = segmentFor(edge.citingId);
    const citedSegment = segmentFor(edge.citedId);
    const citingToken = laneToken(citingSegment, canon);
    // defensive: every tagged indexes/override is itself a tagged edge, so
    // its group(s) always exist — kept for robustness against malformed input.
    if (groups.has(citingToken)) {
      pushEvent(edge.citingId, edge.citedId, edge.relation, citingToken);
    }
    if (citedSegment !== citingSegment) {
      const citedToken = laneToken(citedSegment, canon);
      if (groups.has(citedToken)) {
        pushEvent(edge.citingId, edge.citedId, edge.relation, citedToken);
      }
    }
  }
  events.sort((a, b) => compareOrderKey(orderFor(a.citingId), orderFor(b.citingId)) || a.citingId - b.citingId);

  const terminusOf = new Map<string, number | null>();
  const everDeclared = new Map<string, boolean>();
  const deadInLane = new Map<string, Set<number>>();
  const latestEventTurn = new Map<string, number | null>();
  for (const token of groups.keys()) {
    terminusOf.set(token, null);
    everDeclared.set(token, false);
    deadInLane.set(token, new Set());
    latestEventTurn.set(token, null);
  }
  const globallyDead = new Set<number>();

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
      if (event.token === null) {
        // untagged: GLOBAL kill.
        globallyDead.add(event.citedId);
        for (const [token, terminus] of terminusOf) {
          if (terminus === event.citedId) {
            terminusOf.set(token, null);
            latestEventTurn.set(token, citingId);
          }
        }
      } else {
        deadInLane.get(event.token)!.add(event.citedId);
        if (terminusOf.get(event.token) === event.citedId) {
          terminusOf.set(event.token, null);
        }
        latestEventTurn.set(event.token, citingId);
      }
    }

    // Phase 2 — declarations. Latest wins; a turn declaring itself terminus
    // for the same lane twice in one batch (redundant `indexes` rows citing
    // different targets) is idempotent.
    for (const event of batch) {
      if (event.relation !== "indexes" || event.token === null) continue;
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
    const dead = deadInLane.get(token)!;
    const members: LaneMember[] = [...memberIds]
      .sort((a, b) => a - b)
      .map((id) => ({ id, dead: globallyDead.has(id) || dead.has(id) }));
    const terminus = terminusOf.get(token) ?? null;
    const state: LaneDeclarationState =
      terminus !== null ? "declared" : everDeclared.get(token) ? "reopened" : "undeclared";
    const lane: Lane = {
      key: { segment: group.segment, tagSet: group.tagSet },
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
 * `closed`/`open`, `valid`/`invalid`, and each lane's `lastDeclarer`, read
 * straight off ONE `deriveLaneInterpretation` result — no second reduction
 * pass, no new event, nothing above this comment touched. Two independent
 * consumers share this: the election module (`shared/milestone-election.ts`)
 * for identity tier ②, and `lane-checker.ts`'s report 1 (ticket 04) for its
 * state line — "no parallel derivations anywhere" (spec's implementation
 * note).
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
 *   - **valid** (closed lanes only): the terminus's OWN tagged-`indexes`
 *     edges name its "declared core" (every citedId it indexes IN THIS
 *     LANE); valid iff at least one core member is not `dead` (the
 *     reduction's own override-driven flag) — the repudiate-then-declare
 *     ritual is "kill the wrong conclusions, THEN declare closure indexing
 *     the dead core," so an abandoned lane's core reads entirely dead.
 *     `null` for an open lane — validity is undefined before closure.
 *   - **lastDeclarer**: the citingId of the lane's own tagged-`indexes`
 *     edge with the LATEST order key (ties broken by the higher citingId,
 *     matching the reduction's own event-batch order) — `null` iff the
 *     lane was NEVER declared at all (no tagged `indexes` edge exists for
 *     it: "open, no declarer, no seat," this repo's `{write-gate}` fixture
 *     lane). Provably equals `declaration.terminus` whenever the lane is
 *     currently declared: the reduction's "latest wins" rule means the
 *     order-maximal declaration is always the standing terminus unless a
 *     later override RETARGETS it specifically. An override is free to
 *     target anything — a non-terminus member, an already-superseded
 *     earlier declaration, a plain continuation node with no declaration
 *     behind it at all — and stays perfectly legal without reopening
 *     anything: the reduction only nulls `terminusOf` when the override's
 *     own `citedId` equals the CURRENT terminus (the guard at this
 *     function's own reduction pass, `terminusOf.get(event.token) ===
 *     event.citedId`), so an override elsewhere in the lane leaves
 *     `declaration.terminus` untouched. The two fields diverge only in that
 *     one narrower case — an override that DOES target the terminus and
 *     reopens the lane — where `lastDeclarer` recovers the pre-override
 *     winner `declaration.terminus` no longer names.
 */

export type LaneClosure = "closed" | "open";
export type LaneValidity = "valid" | "invalid";

export interface LaneState {
  key: LaneKey;
  closure: LaneClosure;
  /** Only meaningful when `closure === "closed"`; `null` for an open lane — validity is undefined before closure. */
  validity: LaneValidity | null;
  /** Mirrors `declaration.terminus` — `null` unless the lane is currently declared. */
  terminus: number | null;
  /** `null` iff the lane was never declared at all (no tagged `indexes` edge exists for it anywhere in its history). */
  lastDeclarer: number | null;
}

function laneLastDeclarer(lane: Lane, orderFor: (id: number) => LaneOrderKey): number | null {
  let bestId: number | null = null;
  let bestOrder: LaneOrderKey = [0, 0];
  for (const edge of lane.taggedEdges) {
    if (edge.relation !== "indexes") continue;
    const order = orderFor(edge.citingId);
    const cmp = bestId === null ? 1 : compareOrderKey(order, bestOrder);
    if (cmp > 0 || (cmp === 0 && edge.citingId > bestId!)) {
      bestOrder = order;
      bestId = edge.citingId;
    }
  }
  return bestId;
}

/** `dead` per this lane's own members (global kill or in-lane override) — see module header, "dead status is a final-state snapshot." */
function laneValidity(lane: Lane): LaneValidity {
  const deadById = new Map(lane.members.map((member) => [member.id, member.dead] as const));
  const terminus = lane.declaration.terminus;
  const core = lane.taggedEdges
    .filter((edge) => edge.relation === "indexes" && edge.citingId === terminus)
    .map((edge) => edge.citedId);
  const anyLiving = core.some((id) => deadById.get(id) === false);
  return anyLiving ? "valid" : "invalid";
}

/**
 * Derive `closed`/`open`, `valid`/`invalid`, and `lastDeclarer` for every
 * lane in `lanes` (typically `deriveLaneInterpretation(turns, edges).lanes`,
 * passed straight through) — pure, keyed by the same lane token
 * `laneByToken` uses, so a caller already holding one `deriveLaneInterpretation`
 * result can look a lane's state up by `laneToken(key.segment, key.tagSet)`
 * with no re-derivation. `turns` is needed again here only for the same
 * `order` lookup `deriveLaneInterpretation` itself builds internally — this
 * helper does not read `deriveLaneInterpretation`'s own internal state, only
 * its OUTPUT (`Lane.declaration`/`Lane.members`/`Lane.taggedEdges`).
 */
export function deriveLaneStates(
  lanes: readonly Lane[],
  turns: readonly LaneTurnInput[],
): ReadonlyMap<string, LaneState> {
  const orderOf = new Map<number, LaneOrderKey>();
  for (const turn of turns) {
    orderOf.set(turn.id, turn.order ?? [0, turn.id]);
  }
  const orderFor = (id: number): LaneOrderKey => orderOf.get(id) ?? [0, id];

  const states = new Map<string, LaneState>();
  for (const lane of lanes) {
    const closed =
      lane.declaration.state === "declared" &&
      lane.declaration.terminus === lane.declaration.latestEventTurn;
    const token = laneToken(lane.key.segment, lane.key.tagSet);
    states.set(token, {
      key: lane.key,
      closure: closed ? "closed" : "open",
      validity: closed ? laneValidity(lane) : null,
      terminus: lane.declaration.terminus,
      lastDeclarer: laneLastDeclarer(lane, orderFor),
    });
  }
  return states;
}
