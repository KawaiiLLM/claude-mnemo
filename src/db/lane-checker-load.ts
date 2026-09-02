import type { Database } from "bun:sqlite";

import type { LaneCheckerTurnInput, LaneMemberTotal, LaneSegmentFacts } from "../shared/lane-checker";
import {
  canonicalTagSet,
  DEFAULT_SEGMENT,
  laneMembershipClaims,
  laneToken,
  type LaneEdgeInput,
  type LaneKey,
  type LaneOrderKey,
} from "../shared/lane-interpretation";
import { EDGE_RELATIONS } from "../shared/turn-phase";
import { relationClassBearingSql } from "../shared/relation-class";
import {
  type EdgeSide,
  type EdgeSideResolution,
  type EndpointLaneFacts,
  loadEndpointLaneFacts,
  resolveEdgeSide,
} from "./edge-side-resolution";
import { loadDeclaredLaneTags } from "./turn-tag-gate";
import { liveTurnSql } from "./turn-liveness";

/**
 * The lane checker's read-only DB adapter (rubric-v10 ticket 06). Translates
 * a scope request into the pure core's input shape
 * (`LaneTurnInput[]`/`LaneEdgeInput[]`, `shared/lane-interpretation.ts`) —
 * every id in both arrays is a `turns.id` (the same global, monotonically
 * increasing space `memory_edges.citing_id`/`cited_id` already use for
 * `citing_kind = 'turn'` rows), so no id translation happens anywhere in
 * this file: an edge row's `citing_id`/`cited_id` IS the `LaneTurnInput.id`
 * a caller needs, and `LaneTurnInput.id`'s own doc ("whatever id space the
 * caller addresses turns by, assumed order-comparable") is satisfied for
 * free by the fact that `turns.id` is assigned in insertion order.
 *
 * LAW 8 (indexes-rescope spec, `db/turn-liveness.ts`): every query below
 * that reads `memory_edges` joins both endpoints against `turns` and applies
 * `liveTurnSql` to each — a rolled-back or skipped turn is never a node,
 * never an edge endpoint, exactly like every other read side in this
 * codebase. This is enforced at the SQL layer, not filtered in JS after the
 * fact, so a dead/dormant turn never even reaches the widening logic below.
 *
 * MEMBERSHIP IS A NODE FACT (lane-model-v12 D5, ticket 10). Every turn this
 * file returns carries `laneTags` — the lanes it is a MEMBER of — resolved
 * here and nowhere else: its stored `turns.tags` INTERSECTED with the lanes
 * DECLARED in its OWNING segment (`turn-tag-gate.ts`'s `loadDeclaredLaneTags`,
 * the same vocabulary resolver the tags write gate consults, reused rather
 * than re-derived). Three values drop out of that intersection on purpose —
 * the segment's own tag, a legacy free-form word, and a lane declared in some
 * OTHER segment — because none of them is a lane this turn could belong to,
 * and admitting any of them would mint a phantom lane with hundreds of
 * members (the 7694 legacy free-form values, spec D3b). A HOMELESS turn (no
 * `segment_members` row) therefore has NO lane tags at all: D3e's "an unowned
 * turn cannot join any lane" is structural here, not a rule restated.
 *
 * WIDENING (requirement 1: "projection must widen beyond the requested range
 * to each involved lane's full live edges"). Read in four phases:
 *
 *   1. SEED — resolve the scope (a session's prompt-number range, a whole
 *      segment's members, an EXPLICIT turn-id set, or explicitly named lanes)
 *      into a starting turn-id set (empty for the `lanes` scope, whose seed
 *      IS the named lane).
 *   2. DISCOVER — for the three seeded scopes, find every LANE (segment + ONE
 *      tag: `LaneKey` is `{segment, tag}`, not `{segment, tagSet}`) the seed
 *      touches, from TWO sources since ticket 10:
 *        (a) every lane NAMED by an edge with either endpoint in the seed
 *            set. The pass selects on the SIDE columns (`tail_tag <> '' OR
 *            head_tag <> ''`) and mints ONE key per SETTLED SIDE — `(segment
 *            of citing, tail_tag)` and `(segment of cited, head_tag)`. On a
 *            CROSS-LANE row those are two genuinely different lanes, and on a
 *            CROSS-SEGMENT row they are the two lanes the edge crosses
 *            between (the pure core then registers the edge in NEITHER — see
 *            `lane-interpretation.ts`).
 *        (b) every lane a seed TURN ITSELF claims (its own resolved
 *            `laneTags`). Without this half a seed that carries a lane tag
 *            and has no edge yet would widen to nothing — and that turn is
 *            precisely the member v12 added, so the lane would be judged on
 *            an incomplete membership.
 *      The `lanes` scope skips discovery: its lane set is exactly what the
 *      caller named.
 *   3. WIDEN EDGES — for every involved lane, load its FULL edge set (every
 *      `memory_edges` row anywhere in the database carrying the lane's tag on
 *      EITHER SIDE — `memory_edge_side_tags`, ticket 06 — then filtered PER
 *      SIDE: the tail is kept only when the CITING turn is owned by the
 *      lane's segment, the head only when the CITED turn is), not merely the
 *      rows that happened to touch the seed range. This is what makes a lane
 *      declared long before or extended long after the requested window still
 *      resolve whole. The side index is the COMPLETE match on its own — no
 *      JS-side set comparison is layered on top (that filter's own
 *      collision-safety reasoning, round-5 review #14, is now `laneToken`'s
 *      own job — see `laneKeyToken`).
 *   4. WIDEN MEMBERS (ticket 10) — for every involved lane, every LIVE turn
 *      owned by that lane's segment whose own `tags` carry the lane's tag.
 *      Phase 3 reaches a member only through an edge, so on its own it loads
 *      exactly the membership v11 had; this phase is what makes the tagged,
 *      edgeless member visible — a full member of its lane with no edge of
 *      any kind. A DEFAULT_SEGMENT (homeless) lane has no
 *      members to load: see the membership paragraph above.
 *
 * A fourth pass loads the SUPPLEMENTARY edges the core's reports need beyond
 * a lane's own tagged edges: cross-phase citedness into lane members (report
 * 1), override touching a member, and the
 * SEGMENT-GLOBAL graph report 4b's transitive reduction is computed over
 * (round-4 review #4): every live turn owned by each involved lane's own
 * segment, plus every live `SEGMENT_GRAPH_RELATIONS_SQL` edge with BOTH
 * endpoints inside that segment-wide turn set.
 *
 * THE HOMELESS-LANE FIXPOINT CLOSURE IS DELETED (v12 ticket 11). A
 * default-segment (homeless) lane has no `segment_members` rows to widen from,
 * so it used to get an iterative BFS closure of its own. Ticket 10 made
 * membership a NODE fact resolved against the turn's OWNING segment, and a
 * homeless turn has no owning segment — so it claims no lane, and the pure core
 * never enumerates a DEFAULT_SEGMENT lane at all. The closure was loading edges
 * for a lane no report can reach. See the call site for the full reasoning.
 *
 * SKIP/ROLLBACK EXEMPTION (tag-mandate ticket 03). Error class E3 (empty or
 * out-of-vocabulary turn `type`) must not fire on a legally-SKIPPED turn.
 * That exemption needs no predicate in the checker: LAW 8 above is what
 * enforces it — `liveTurnSql` gates every query in this file, on the turn
 * table AND on both endpoints of every edge, so a `status = 'skipped'` (or
 * `was_rolled_back = 1`) turn never enters `turns` and can never be
 * classed. Any future load path added here that bypasses `liveTurnSql`
 * silently re-admits skipped turns as E3 errors and, through the commit
 * gate, would block a window on rows its agent is not even shown.
 *
 * THE TURN-ID SEED SCOPE (peer round T1466, finding P1-1). The settlement
 * window's writable set is an immutable, explicitly enumerated list of turn
 * ids — window ∪ declared lookback ∪ closure — which no prompt-number RANGE
 * can express: a lookback turn can sit anywhere in the session, and a range
 * seeded on `windowStart..windowEnd` alone never LOADS the lookback's own E1/
 * E3 stock, so filtering the resulting errors by anchor afterwards cannot
 * recover what never entered the projection. `{ kind: "turns", turnIds }` is
 * that missing seed: the frozen set goes in verbatim and every pass below —
 * DISCOVER, the stance stock pass, the supplementary passes, the seeds-always-
 * join step — reads the FULL set, exactly as the `range` scope's own seed
 * does. Two exemptions are deliberately NOT re-implemented here:
 *
 *   - LIVENESS/SKIP. The ids arrive unfiltered (a caller's frozen set is a
 *     claim about WRITABILITY, not about liveness) and stay unfiltered
 *     through the seed passes; `loadLiveTurns` is what decides which of them
 *     becomes a judgable row, and `liveTurnSql` on both endpoints of every
 *     edge query is what keeps a dead seed from dragging an edge in. A
 *     skipped or rolled-back id in the frozen set therefore loads NOTHING —
 *     the same law-8 outcome the `range` scope gets from filtering at seed
 *     time, reached one layer later.
 *   - DE-DUPLICATION/ORDER. The set is deduped and sorted ascending so the
 *     projection is a pure function of the id SET, never of the caller's
 *     array order.
 *
 * OUT-OF-VOCABULARY EDGES REACHING OUTSIDE THE SCOPE (same finding). E2
 * anchors at an edge's CITING turn, so an out-of-vocabulary row written FROM
 * a seed turn is that seed's own repairable defect even when its cited turn
 * sits outside everything else this projection loaded. The among-both-
 * endpoints pass alone made such a row invisible, so a second, seed-scoped
 * pass loads every out-of-vocabulary edge whose CITING side is in the seed
 * set and JOINS the far endpoint into the loaded turn set (the
 * no-dangling-edge invariant is preserved by construction, not by luck). The
 * citing-side direction is exactly the anchor rule: a row whose citing side
 * is OUTSIDE the seed anchors outside this window, blocks a different one,
 * and is deliberately still not loaded.
 *
 * SEGMENT-WIDE FACTS (lane-declaration ticket 09, D9). One further pass,
 * `loadSegmentFacts`, answers a question none of the above can: how many
 * lanes a SEGMENT has declared and how many live turns it owns. Both come
 * from the `lanes` registry and `segment_members`, never from the projection
 * assembled above — a projection is a window's shape, and the proliferation
 * warning must read the same verdict from a 4-turn window as from a 100-turn
 * one (peer P1-11). It is carried on its own `segmentFacts` field, straight
 * into `checkLanes`'s fourth parameter.
 *
 * COVERAGE (requirement 1's other half). The core's own report 1
 * (`LaneStatsReport.coverage`) is the honest signal: it is populated
 * whenever a lane member id appears as a tagged edge's endpoint with no
 * matching entry in the `turns` array handed to `checkLanes`. This adapter
 * never fabricates a placeholder turn for an id it could not resolve, so
 * that field reports exactly what this file actually managed to load —
 * nothing here manufactures false completeness.
 *
 * That answered a NARROWER question than it read, and once the judgment
 * narrowing below landed, the gap became misleading rather than merely
 * incomplete: a reader of a narrowed lane saw 195 members where the lane has
 * 295, under the word `whole`. So `laneMemberTotals` (settlement-gate-taxonomy
 * ticket 04) carries the denominator only this file can measure — each widened
 * lane's whole `segment_members` count, captured BEFORE the narrowing is
 * applied to it — and `LaneCoverage` answers one question over both halves.
 *
 * THE ASYMMETRY, AND WHY IT IS CLOSED (settlement-gate-taxonomy tickets
 * 01/02). Until ticket 02 the two halves above covered DIFFERENT lane sets:
 * `laneTags` was resolved for EVERY turn that landed in the projection, while
 * phases 3/4 widened only the lanes the SEED discovered. Between them sat the
 * segment-global pass, which pulls in every live turn of every involved lane's
 * SEGMENT through `SEGMENT_GRAPH_RELATIONS_SQL` alone. So a lane nobody asked
 * about materialised with its FULL membership and a TRUNCATED edge set — on
 * the production lane `E60/execution-repair` it kept 33 edges and lost all 20
 * `indexes` rows, the very relation an index turn uses to claim its lane —
 * and read as severed into one island per member. The commit gate then
 * demanded dispositions for fractures that do not exist, on a lane the run had
 * never touched: job 166 burned 81 minutes and 21 refused commits on exactly
 * that, and was abandoned.
 *
 * The invariant that replaces it, held by `membersByLaneToken` below: **a lane
 * that is REPORTED is a lane whose edges were WIDENED.** `laneTags` is no
 * longer "the turn's own tags ∩ its segment's declared lanes" but that
 * intersection RESTRICTED to the lanes this projection actually widened, and
 * (under a judgment window, below) to the members it actually emitted for
 * them. The pure core enumerates lanes from `laneTags` alone, so a lane whose
 * edges were not widened now has no member, is not enumerated, and appears in
 * no report, no count and no gate — by construction rather than by a
 * downstream filter.
 *
 * THE THREE ROLES (settlement-gate-taxonomy spec, "One evaluator, one scope
 * definition, two evaluations"; ticket 02). A settlement caller declares a
 * JUDGMENT WINDOW (`LaneJudgmentWindow`) and the projection's turns split into
 * three roles that are never collapsed back into one id set:
 *
 *   - JUDGMENT ANCHORS — the window's own prompt numbers plus the
 *     `JUDGMENT_LOOKBACK_PROMPTS` immediately preceding prompt numbers of the
 *     SAME session. PROMPT numbers, deliberately not "the lane's own preceding
 *     50 members": a sparse lane spans thousands of prompts (E60's
 *     `milestone-design` runs from prompt 139 to prompt 2264 of one session),
 *     so a member-counted lookback would drag in two years of history and
 *     defeat the ruling it is supposed to express. Findings may anchor only
 *     here.
 *   - EVIDENCE CLOSURE — everything else this projection had to load to
 *     EXPLAIN those anchors: the far endpoint of an edge a judgment anchor
 *     writes, a seed turn the caller's writable set carried in from outside
 *     the window's own prompt range, one structural hop out of the loaded set
 *     so report 4b's detours stay computable. Readable; its own older findings
 *     enter neither the report nor the gate.
 *   - BOUNDARY WITNESS — per lane component the judgment anchors touch,
 *     exactly ONE nearest component they do not, as a stitch target. Scanning
 *     the whole lane to FIND that one is allowed and is what
 *     `narrowLaneToJudgment` does; emitting more than that one is not.
 *
 * BOUND HERE, NOT AT THE RENDER. Filtering downstream leaves the full
 * membership and edge set loaded and the components computed over all of it —
 * the cost is fully paid and only the printing shrinks. So the narrowing runs
 * inside the WIDEN block, before `memberIdList` is frozen, and the
 * segment-global pass's domain shrinks with it.
 */

/**
 * The lookback the ruling fixes, in PROMPT NUMBERS of the judgment window's own
 * session (settlement-gate-taxonomy spec: "the window's 50 prompt numbers plus
 * the 50 immediately preceding prompt numbers of the SAME session … not the
 * lane's own preceding 50 members: on a sparse lane that spans thousands of
 * prompts and defeats the ruling's intent").
 */
export const JUDGMENT_LOOKBACK_PROMPTS = 50;

/**
 * A settlement dispatch's JUDGMENT WINDOW — the declaration that turns a bare
 * turn-id seed into the three roles (module header, "THE THREE ROLES"). It
 * names a session and the window's own prompt bounds; the lookback is
 * `JUDGMENT_LOOKBACK_PROMPTS`, applied HERE and nowhere else so no caller can
 * choose a different one.
 */
export interface LaneJudgmentWindow {
  /** `turns.session_id` — the judgment set never crosses a session, so a cross-session closure turn is EVIDENCE, never an anchor. */
  sessionId: number;
  /** The window's first prompt number (inclusive). */
  windowStart: number;
  /** The window's last prompt number (inclusive). */
  windowEnd: number;
}

/** One turn's role in a settlement projection (module header, "THE THREE ROLES"). The three sets partition the projection's own turns. */
export type LaneCheckTurnRole = "judgment" | "evidence" | "boundary";


/**
 * The projection's turns, partitioned by role. Disjoint and exhaustive over
 * `LaneCheckProjection.turns` by construction: a boundary witness lives in a
 * component NO judgment anchor touches (that is what makes it a witness), so
 * it can never also be an anchor, and `evidence` is defined as the remainder.
 *
 * With no judgment window declared, every loaded turn is a JUDGMENT anchor and
 * the other two sets are empty — the honest reading for a caller (the CLI, the
 * console, `mcp/note.ts`) that declared no window and therefore judges
 * everything it asked for.
 */
export interface LaneCheckRoles {
  judgment: ReadonlySet<number>;
  evidence: ReadonlySet<number>;
  boundary: ReadonlySet<number>;
}

/**
 * THE anchor predicate (spec: "Errors and warnings may anchor only here"). The
 * ONE place the question "may a finding anchored at this turn be reported or
 * gated on?" is answered — both settlement surfaces read it through
 * `checkWindowLanes`, so a preview and a verdict cannot disagree about it.
 */
export function anchorsInJudgment(roles: LaneCheckRoles, turnId: number): boolean {
  return roles.judgment.has(turnId);
}

export type LaneCheckScope =
  | { kind: "range"; sessionId: number; promptStart: number; promptEnd: number }
  | { kind: "segment"; segmentId: number }
  /**
   * An EXPLICIT turn-id set as the seed (peer round T1466, finding P1-1) —
   * the shape the settlement window's immutable writable set (window ∪
   * declared lookback ∪ closure) actually has, which no prompt-number range
   * can express. See the module header's "THE TURN-ID SEED SCOPE": the ids
   * are taken verbatim (deduped, ascending), liveness is applied by
   * `loadLiveTurns`/`liveTurnSql` rather than at seed time, and every pass
   * seeds from the FULL set.
   */
  | {
      kind: "turns";
      turnIds: readonly number[];
      /**
       * The settlement seam (ticket 02). Declaring it switches on the three
       * roles: findings may anchor only in the judgment set, each involved
       * lane is narrowed to the components those anchors touch plus ONE
       * boundary witness each, and the segment-global graph pass stops
       * scanning whole segments. OMITTED means "judge everything this seed
       * loads", which is what every non-settlement caller means.
       */
      judgment?: LaneJudgmentWindow;
    }
  | { kind: "lanes"; laneKeys: readonly LaneKey[] };

export interface LaneCheckProjection {
  /**
   * `LaneCheckerTurnInput`, not the bare `LaneTurnInput` the pure
   * interpretation core takes: the extra field is the turn's own RAW `tags`
   * column, which error class E4 (the subset invariant over stock) needs on
   * BOTH endpoints of every tagged edge. Its resolved sibling `laneTags`
   * (the core's own field — the raw column intersected with the segment's
   * declared lanes) is what carries MEMBERSHIP; the two are deliberately
   * separate, because E4 asks a question about the stored column and
   * membership asks one about the registry. This is the ONE type-only import this
   * file takes from `shared/lane-checker.ts` — it adds no runtime
   * dependency (the import is erased), which is what the peer-not-wrapper
   * stance below is actually protecting.
   */
  turns: LaneCheckerTurnInput[];
  edges: LaneEdgeInput[];
  /** The lanes this projection widened to cover — informational only, never fed back into the core (the core re-derives lanes from `turns`/`edges` itself). */
  involvedLaneKeys: LaneKey[];
  /**
   * Semantic-conformance ticket 02: edges among `turns` whose relation lies
   * outside `EDGE_RELATIONS` (e.g. the frozen-legacy `supersedes`) — a
   * SEPARATE field, deliberately never merged into `edges` above. Feed this
   * to `checkLanes`'s own third parameter, never straight into
   * `deriveLaneInterpretation`: `mcp/note.ts`'s Gate C self-`grounds`
   * terminus check reduces `projection.edges` directly with that function,
   * and merging an out-of-vocabulary relation into the shared `edges` array
   * would have widened THAT caller's graph too, not just the checker's own.
   */
  outOfVocabularyEdges: LaneEdgeInput[];
  /**
   * D9 proliferation (lane-declaration ticket 09, peer P1-11) — THE one place
   * the segment-wide counts come from. Per REAL segment this scope asked
   * about (every seed turn's owning segment, plus every involved lane key's
   * segment, so a `lanes`-scoped call is covered too): `COUNT(*)` over the
   * `lanes` REGISTRY, `COUNT(DISTINCT turn_id)` over live `segment_members`,
   * and (ticket 14) the NAMES of the declared lanes with no live member —
   * the removable part of a numerator that would otherwise pad the ratio
   * invisibly.
   *
   * Neither number is ever inferred from `turns`/`edges` above: those are a
   * PROJECTION of a window, and inferring from them is exactly what made the
   * same segment yield a different verdict from a 4-turn settlement window
   * than from a 100-turn one. Feed this to `checkLanes`'s fourth parameter;
   * a caller that does not gets no proliferation verdict rather than one
   * computed off the window's shape.
   */
  segmentFacts: LaneSegmentFacts[];
  /**
   * The three roles over `turns` (module header, "THE THREE ROLES"), computed
   * where the narrowing itself happens rather than re-derived by a reader. Its
   * ONE consumer question — "may a finding anchored here be reported?" — goes
   * through `anchorsInJudgment`, never through a second membership test.
   */
  roles: LaneCheckRoles;
  /**
   * Per widened lane, its WHOLE declared membership (`LaneMemberTotal`) — the
   * denominator report 1's coverage line needs to say that what a reader is
   * seeing is a SLICE. Feed it to `checkLanes`'s fifth parameter; a caller that
   * does not gets no membership verdict rather than a fabricated one.
   */
  laneMemberTotals: LaneMemberTotal[];
}

interface TurnLiteRow {
  id: number;
  type: string;
  /** `turns.tags` verbatim — a nullable JSON array column. tag-mandate ticket 03: the E4 subset invariant's second input. */
  tags: string | null;
  sessionId: number;
  promptNumber: number;
  /** rubric-v10 ticket 08: plumbed straight onto `LaneTurnInput.createdAtEpoch` — the ONLY reader is `lane-checker.ts`'s report-4(c) time-order check, for the cross-session half of that comparison (`order`'s `[session_id, prompt_number]` tuple is never compared across sessions — a `session_id` carries no wall-clock meaning relative to another session's). */
  createdAtEpoch: number;
}

/**
 * The true reduction-order key (round-4 review #2): `(session_id,
 * prompt_number)` position, never the row's own `id` — a backfilled turn can
 * be inserted after (and so carry a higher row id than) turns that
 * chronologically follow it. `sessionId` is itself an auto-increment id
 * (monotonic in session-creation order), so this compound key is a total
 * order across sessions too, not just within one.
 *
 * Round-5 review #10: an EARLIER version of this file collapsed the pair
 * into one scalar (`sessionId * SPAN + promptNumber`). That both COLLIDES
 * (`1 * SPAN + SPAN === 2 * SPAN + 0` for any `SPAN`, whenever a smaller
 * `sessionId`'s `promptNumber` reaches exactly one `SPAN`) and LOSES
 * PRECISION at realistic magnitudes (`SPAN * SPAN + 0 === SPAN * SPAN + 1`
 * once the product exceeds `Number.MAX_SAFE_INTEGER`'s headroom, which a
 * `SPAN` of 1e8 already does the moment `sessionId` itself reaches 1e8).
 * `LaneTurnInput.order` is a TUPLE now (`shared/lane-interpretation.ts`'s
 * `LaneOrderKey`), compared lexicographically by the core — so the pair is
 * carried through unencoded, with neither failure mode.
 */
function turnOrderKey(sessionId: number, promptNumber: number): readonly [number, number] {
  return [sessionId, promptNumber];
}

interface EdgeLiteRow {
  citingId: number;
  citedId: number;
  relation: string;
  /** `memory_edges.tail_tag` verbatim — the CITING side's STORED DECLARATION, `''` when the row declares nothing. Which lane the side actually attributes to is `resolveEdgeSide`'s answer, not this (main-agent-edges spec D2). */
  tailTag: string;
  /** `memory_edges.head_tag` verbatim — the CITED side's stored declaration. See `tailTag`. */
  headTag: string;
  /** The stored three-class value (`''` on a pre-v13 row) — what the checker's own vocabulary gate and every by-class tally read. */
  relationClass: string;
  /** `full`/`partial` on a `correct` row, `''` otherwise. */
  relationCoverage: string;
}

/**
 * THE SIDE RESOLVER for this loader (main-agent-edges spec D2), memoised over
 * one projection.
 *
 * The three passes below (DISCOVERY, WIDEN, SUPPLEMENTARY) each need the same
 * question answered about the same endpoints — "which lane does this side
 * attribute to" — and each used to answer a DIFFERENT, weaker question by
 * selecting on the stored word. One resolver, primed in batches, is what makes
 * them agree by construction rather than by three matching SQL predicates.
 */
interface ProjectionSideResolver {
  prime: (turnIds: readonly number[]) => void;
  facts: () => ReadonlyMap<number, EndpointLaneFacts>;
  resolve: (row: EdgeLiteRow, side: EdgeSide) => EdgeSideResolution;
}

function createProjectionSideResolver(db: Database): ProjectionSideResolver {
  const known = new Map<number, EndpointLaneFacts>();
  const prime = (turnIds: readonly number[]): void => {
    const missing = [...new Set(turnIds)].filter((id) => !known.has(id));
    if (missing.length === 0) {
      return;
    }
    for (const [id, entry] of loadEndpointLaneFacts(db, missing)) {
      known.set(id, entry);
    }
  };
  return {
    prime,
    facts: () => known,
    resolve: (row, side) => {
      prime([row.citingId, row.citedId]);
      return resolveEdgeSide(row, side, known);
    },
  };
}

/**
 * The cross-pass dedupe key. Since ticket 09 it mirrors the STORAGE identity
 * key `(citing, cited, relation, tail_tag, head_tag)` EXACTLY (lane-model-v12
 * spec D1) — the merged `tags` component the expand step still carried left
 * with the column. Two rows that differ only in which lane each END names are
 * two DIFFERENT edges, so a key blind to the sides would silently fold one
 * into the other.
 *
 * `JSON.stringify` of the field TUPLE rather than a delimiter join, for
 * `laneToken`'s own reason (round-5 review #14): JSON self-delimits every
 * element through its own quoting, so no field value can imitate the
 * separator and merge two different tuples. It also removes the last
 * separator-byte question from this file — there is no delimiter left to
 * choose, control byte or otherwise.
 */
function edgeKey(row: EdgeLiteRow): string {
  return JSON.stringify([row.citingId, row.citedId, row.relation, row.tailTag, row.headTag]);
}

function segmentKeyFor(owningSegmentByTurn: ReadonlyMap<number, number>, turnId: number): string {
  const segmentId = owningSegmentByTurn.get(turnId);
  return segmentId === undefined ? DEFAULT_SEGMENT : String(segmentId);
}

/**
 * The same-shape lookup key `deriveLaneInterpretation` uses internally,
 * reused directly rather than re-implemented (round-5 review #14: a
 * separately maintained delimiter join here drifted from the core's own
 * fix and reintroduced the identical collision — a tag containing the
 * delimiter character collides one tag set with a differently-split one).
 * D5, v11: `key.tag` is now the whole of a lane's non-segment identity, no
 * canonical-SET encoding needed on this side either.
 */
function laneKeyToken(key: LaneKey): string {
  return laneToken(key.segment, key.tag);
}

/** Every `segment_members` row's owning segment for the given turn ids, batched in one query (`MIN` mirrors `getOwningSegmentId`'s own "lowest id wins" tie-break for a legacy multi-membership row). */
function loadOwningSegments(db: Database, turnIds: readonly number[]): Map<number, number> {
  const ids = [...new Set(turnIds)];
  if (ids.length === 0) {
    return new Map();
  }
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .query<{ turnId: number; segmentId: number }, number[]>(
      `SELECT turn_id AS turnId, MIN(segment_id) AS segmentId
       FROM segment_members
       WHERE turn_id IN (${placeholders})
       GROUP BY turn_id`,
    )
    .all(...ids);
  return new Map(rows.map((row) => [row.turnId, row.segmentId]));
}

function resolveSeedTurnIds(
  db: Database,
  scope: Extract<LaneCheckScope, { kind: "range" | "segment" | "turns" }>,
): number[] {
  if (scope.kind === "turns") {
    // Verbatim, deduped, ascending — no liveness query here on purpose
    // (module header, "THE TURN-ID SEED SCOPE"): a dead or skipped id in the
    // caller's frozen set is dropped by `loadLiveTurns` at the end and can
    // never carry an edge in, since `liveTurnSql` gates both endpoints of
    // every edge query below.
    return [...new Set(scope.turnIds)].sort((a, b) => a - b);
  }

  if (scope.kind === "range") {
    return db
      .query<{ id: number }, [number, number, number]>(
        `SELECT id FROM turns
         WHERE session_id = ? AND prompt_number BETWEEN ? AND ?
           AND ${liveTurnSql()}
         ORDER BY prompt_number ASC`,
      )
      .all(scope.sessionId, scope.promptStart, scope.promptEnd)
      .map((row) => row.id);
  }

  return db
    .query<{ id: number }, [number]>(
      `SELECT t.id AS id
       FROM turns t
       JOIN segment_members sm ON sm.turn_id = t.id
       WHERE sm.segment_id = ? AND ${liveTurnSql("t")}
       ORDER BY t.created_at_epoch ASC, t.id ASC`,
    )
    .all(scope.segmentId)
    .map((row) => row.id);
}

/**
 * Every live, CLASS-CARRYING turn-turn edge touching any of `turnIds` (either
 * endpoint) — the one candidate loader all three passes share.
 *
 * THE `(tail_tag <> '' OR head_tag <> '')` PREDICATE IS GONE (main-agent-edges
 * spec D2). It selected edges by whether a WRITER had declared a side, which
 * on production excluded 69% of edges from their own lanes; attribution is
 * resolved from the endpoints' own membership now, so the candidate set is
 * "incident to these turns" and the resolver decides the rest. The relation
 * filter likewise moved off the seven words onto the class accessor's own SQL
 * form, so a bare prose row is still excluded and no word is named here.
 */
function loadClassEdgesTouching(db: Database, turnIds: readonly number[]): EdgeLiteRow[] {
  if (turnIds.length === 0) {
    return [];
  }
  const placeholders = turnIds.map(() => "?").join(",");
  return db
    .query<EdgeLiteRow, number[]>(
      `SELECT me.citing_id AS citingId, me.cited_id AS citedId, me.relation,
              me.tail_tag AS tailTag, me.head_tag AS headTag,
              COALESCE(me.relation_class, '') AS relationClass,
              COALESCE(me.relation_coverage, '') AS relationCoverage
       FROM memory_edges me
       JOIN turns tc ON tc.id = me.citing_id
       JOIN turns td ON td.id = me.cited_id
       WHERE (me.citing_id IN (${placeholders}) OR me.cited_id IN (${placeholders}))
         AND me.citing_kind = 'turn' AND me.cited_kind = 'turn'
         AND ${relationClassBearingSql("me")}
         AND ${liveTurnSql("tc")} AND ${liveTurnSql("td")}`,
    )
    .all(...turnIds, ...turnIds);
}

/**
 * WIDEN MEMBERS (ticket 10): every LIVE turn owned by `segmentId` whose own
 * `tags` column carries `tag` — the lane's membership, read where v12 says it
 * lives. `loadEdgesForTag` above finds only the members an edge already
 * reaches; this finds the ones nobody has wired up yet, which is the whole
 * difference between edge-derived membership and the node-fact reading.
 *
 * THE `CASE` IS NOT DECORATION. SQLite's `json_each` RAISES on a malformed
 * value rather than returning zero rows, and a raise inside a WHERE clause
 * fails the WHOLE statement — `turns.tags` carries no `json_valid` CHECK
 * (schema.ts), so one unreadable column would take the entire lane check
 * down. Asking `json_valid`/`json_type` FIRST inside a `CASE` (whose arms
 * evaluate lazily, unlike a bare `AND` chain) makes an unreadable column mean
 * "claims no lane", which is also the honest reading: a claim nobody can
 * parse is not a claim. Same shape `db/lanes.ts`'s M0 filter already uses.
 *
 * The `segment_members` JOIN is plain membership, not `MIN(segment_id)`
 * ownership, so a turn sitting in two segments is loaded for both. That is
 * deliberate: it only ever widens the TURN set, and `laneTags` is resolved
 * against the turn's OWNING segment afterwards, so such a turn still ends up
 * a member of exactly one segment's lane.
 */
function loadSegmentTurnIdsCarryingTag(db: Database, segmentId: number, tag: string): number[] {
  return db
    .query<{ id: number }, [number, string]>(
      `SELECT t.id AS id
       FROM turns t
       JOIN segment_members sm ON sm.turn_id = t.id
       WHERE sm.segment_id = ? AND ${liveTurnSql("t")}
         AND CASE
               WHEN json_valid(t.tags) AND json_type(t.tags) = 'array'
                 THEN EXISTS (SELECT 1 FROM json_each(t.tags) j WHERE j.value = ?)
               ELSE 0
             END`,
    )
    .all(segmentId, tag)
    .map((row) => row.id);
}

/** Every live turn id owned by `segmentId` — the SEGMENT-GLOBAL membership set (round-4 review #4a), not filtered to any particular lane's tagged edges. */
function loadSegmentTurnIds(db: Database, segmentId: number): number[] {
  return db
    .query<{ id: number }, [number]>(
      `SELECT t.id AS id
       FROM turns t
       JOIN segment_members sm ON sm.turn_id = t.id
       WHERE sm.segment_id = ? AND ${liveTurnSql("t")}`,
    )
    .all(segmentId)
    .map((row) => row.id);
}

/**
 * THE JUDGMENT ANCHOR SET (ticket 02, module header) — every LIVE turn of the
 * declared session whose PROMPT NUMBER falls in the window plus the
 * `JUDGMENT_LOOKBACK_PROMPTS` immediately preceding prompt numbers.
 *
 * Prompt numbers, and one session. Both halves are the ruling, not an
 * implementation convenience: a member-counted lookback ("the lane's own
 * preceding 50 members") walks a sparse lane back through thousands of prompts
 * — E60's `milestone-design` has 266 members spread from prompt 139 to prompt
 * 2264 of a single session — and a cross-session closure turn is by definition
 * not part of the arc this window is judging.
 *
 * LAW 8 applies here like everywhere else: a skipped or rolled-back turn is
 * not an anchor, so it can neither carry a finding nor make a lane component
 * count as touched.
 */
function loadJudgmentAnchorTurnIds(db: Database, window: LaneJudgmentWindow): number[] {
  const promptStart = Math.max(0, window.windowStart - JUDGMENT_LOOKBACK_PROMPTS);
  return db
    .query<{ id: number }, [number, number, number]>(
      `SELECT id FROM turns
       WHERE session_id = ? AND prompt_number BETWEEN ? AND ?
         AND ${liveTurnSql()}`,
    )
    .all(window.sessionId, promptStart, window.windowEnd)
    .map((row) => row.id);
}

/** One connected component of ONE lane, over that lane's own claiming edges — the same partition `shared/lane-checker.ts`'s `buildComponentReport` computes, with the same representative (smallest member id). */
interface LaneComponentSlice {
  /** Smallest member id — `LaneIsland.representative`, and the key `computeLaneFractures` walks islands in. */
  representative: number;
  memberIds: number[];
  /** Largest member id. With `representative` this is the span the boundary witness measures distance against. */
  max: number;
  /** `true` when any member is a JUDGMENT ANCHOR. */
  touched: boolean;
}

/**
 * Partition one lane's scanned membership by its own CLAIMING edges — the same
 * question `buildComponentReport` asks, asked here because the answer is what
 * decides how much of the lane this projection is allowed to emit, and that
 * decision has to be made before `memberIdList` freezes.
 *
 * The claiming predicate is `laneMembershipClaims`' and nobody else's: both
 * sides settled to THIS tag and both endpoints owned by THIS segment. An edge
 * that names two lanes claims neither, exactly as the core reads it, so the two
 * cannot drift into different component counts.
 */
function componentsOfLane(
  laneKey: LaneKey,
  memberIds: ReadonlySet<number>,
  laneEdges: readonly EdgeLiteRow[],
  owningSegments: ReadonlyMap<number, number>,
  judgmentIds: ReadonlySet<number>,
  resolver: ProjectionSideResolver,
): LaneComponentSlice[] {
  const parent = new Map<number, number>();
  const find = (id: number): number => {
    let root = id;
    while (parent.get(root) !== root) {
      root = parent.get(root)!;
    }
    let walk = id;
    while (parent.get(walk) !== root) {
      const next = parent.get(walk)!;
      parent.set(walk, root);
      walk = next;
    }
    return root;
  };
  for (const id of memberIds) {
    parent.set(id, id);
  }
  for (const row of laneEdges) {
    if (!memberIds.has(row.citingId) || !memberIds.has(row.citedId)) continue;
    const claims = laneMembershipClaims(
      toEdgeInput(row, resolver),
      segmentKeyFor(owningSegments, row.citingId),
      segmentKeyFor(owningSegments, row.citedId),
    );
    if (!claims.some((claim) => claim.segment === laneKey.segment && claim.tag === laneKey.tag)) {
      continue;
    }
    const a = find(row.citingId);
    const b = find(row.citedId);
    if (a !== b) {
      parent.set(a, b);
    }
  }
  const byRoot = new Map<number, number[]>();
  for (const id of memberIds) {
    const root = find(id);
    const bucket = byRoot.get(root);
    if (bucket === undefined) {
      byRoot.set(root, [id]);
    } else {
      bucket.push(id);
    }
  }
  return [...byRoot.values()]
    .map((ids) => {
      const sorted = ids.sort((a, b) => a - b);
      return {
        representative: sorted[0]!,
        memberIds: sorted,
        max: sorted[sorted.length - 1]!,
        touched: sorted.some((id) => judgmentIds.has(id)),
      };
    })
    .sort((a, b) => a.representative - b.representative);
}

/**
 * THE BOUNDARY WITNESS (ticket 02, module header): for ONE touched component,
 * the ONE nearest component the judgment anchors do not touch — or `null` when
 * the lane has none, which is the whole-lane case and needs no stitch target.
 *
 * DISTANCE IS THE GAP BETWEEN THE TWO COMPONENTS' MEMBER-ID SPANS, and the
 * tie-break is the smaller representative. Both are `computeLaneFractures`'
 * own key rather than a second one invented here: that function walks a lane's
 * islands in representative order and pairs each with the NEXT, so a witness
 * chosen by any other measure would be a stitch target the fracture list then
 * refuses to name. Overlapping spans score 0 and win, which is right — an
 * interleaved component is nearer than an adjacent one.
 */
function nearestUntouchedComponent(
  touched: LaneComponentSlice,
  components: readonly LaneComponentSlice[],
): LaneComponentSlice | null {
  let best: LaneComponentSlice | null = null;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const candidate of components) {
    if (candidate.touched) continue;
    const gap =
      touched.max < candidate.representative
        ? candidate.representative - touched.max
        : candidate.max < touched.representative
          ? touched.representative - candidate.max
          : 0;
    if (gap < bestGap || (gap === bestGap && best !== null && candidate.representative < best.representative)) {
      best = candidate;
      bestGap = gap;
    }
  }
  return best;
}

/**
 * Every live CLASS-CARRYING edge with BOTH endpoints inside `turnIds` — "all
 * structural edges among" a segment's own turns (round-4 review #4a), as
 * opposed to `loadClassEdgesTouching`'s one-hop-from-a-member "touching"
 * scope.
 *
 * The word list it used to filter by (stance + `consume` + `grounds`, five of
 * seven) is gone with the segment-graph word subset itself: under three
 * classes every relation states that this output stands on that one, which is
 * the whole of what a structural bypass is about (`shared/lane-checker.ts`'s
 * `isSegmentGraphEdge`).
 */
function loadComponentEdgesAmong(db: Database, turnIds: readonly number[]): EdgeLiteRow[] {
  if (turnIds.length === 0) {
    return [];
  }
  const idPlaceholders = turnIds.map(() => "?").join(",");
  return db
    .query<EdgeLiteRow, number[]>(
      `SELECT me.citing_id AS citingId, me.cited_id AS citedId, me.relation,
              me.tail_tag AS tailTag, me.head_tag AS headTag,
              COALESCE(me.relation_class, '') AS relationClass,
              COALESCE(me.relation_coverage, '') AS relationCoverage
       FROM memory_edges me
       JOIN turns tc ON tc.id = me.citing_id
       JOIN turns td ON td.id = me.cited_id
       WHERE me.citing_id IN (${idPlaceholders}) AND me.cited_id IN (${idPlaceholders})
         AND me.citing_kind = 'turn' AND me.cited_kind = 'turn'
         AND ${relationClassBearingSql("me")}
         AND ${liveTurnSql("tc")} AND ${liveTurnSql("td")}`,
    )
    .all(...turnIds, ...turnIds);
}

/**
 * Every live relation-carrying edge with BOTH endpoints inside `turnIds`
 * whose `relation` lies OUTSIDE `EDGE_RELATIONS` (semantic-conformance
 * ticket 02) — e.g. the frozen-legacy `supersedes`, still storable
 * (`db/citations.ts`'s `CITATION_RELATIONS` carries a ninth word this
 * module's own write vocabulary never did) but never surfaced by any of
 * this file's other passes, which all filter to specific IN-vocabulary
 * relation lists (or require `tags != '[]'`, and a frozen-legacy relation
 * predates the tag model and is never tagged). Scoped to turns ALREADY in
 * `turnIds` — never a reason to widen the loaded turn set further, since
 * these rows are reported as a bare fact by the checker, not resolved into
 * lane membership. `loadLaneCheckScope` calls this with the whole loaded turn
 * set, so both endpoints of everything it returns are already present among
 * the turns this projection returns — no dangling-edge risk. Its seed-scoped
 * sibling below is the one pass that CAN name a turn not yet loaded, and it
 * joins that endpoint in explicitly.
 */
function loadOutOfVocabularyEdgesAmong(db: Database, turnIds: readonly number[]): EdgeLiteRow[] {
  if (turnIds.length === 0) {
    return [];
  }
  const idPlaceholders = turnIds.map(() => "?").join(",");
  return db
    .query<EdgeLiteRow, number[]>(
      `SELECT me.citing_id AS citingId, me.cited_id AS citedId, me.relation,
              me.tail_tag AS tailTag, me.head_tag AS headTag,
              COALESCE(me.relation_class, '') AS relationClass,
              COALESCE(me.relation_coverage, '') AS relationCoverage
       FROM memory_edges me
       JOIN turns tc ON tc.id = me.citing_id
       JOIN turns td ON td.id = me.cited_id
       WHERE me.citing_id IN (${idPlaceholders}) AND me.cited_id IN (${idPlaceholders})
         AND me.citing_kind = 'turn' AND me.cited_kind = 'turn'
         AND me.relation IS NOT NULL AND NOT ${relationClassBearingSql("me")}
         AND ${liveTurnSql("tc")} AND ${liveTurnSql("td")}`,
    )
    .all(...turnIds, ...turnIds);
}

/**
 * The seed-scoped counterpart of the pass above (peer round T1466, finding
 * P1-1): every live out-of-vocabulary edge whose CITING side is one of
 * `turnIds`, whatever its cited side is. E2 anchors at the citing turn, so
 * such a row is the seed's own repairable defect and must be visible to the
 * window that owns it even when its cited turn joined no other pass; the
 * among-BOTH-endpoints pass alone hid exactly those rows. The reverse case
 * (cited side in scope, citing side outside) is deliberately NOT loaded: it
 * anchors outside this scope and blocks a different window.
 *
 * `loadLaneCheckScope` joins the cited endpoints this returns into the final
 * turn set, so the projection still cannot carry an edge whose endpoint it
 * never loaded.
 */
function loadOutOfVocabularyEdgesFromCiting(db: Database, turnIds: readonly number[]): EdgeLiteRow[] {
  if (turnIds.length === 0) {
    return [];
  }
  const idPlaceholders = turnIds.map(() => "?").join(",");
  return db
    .query<EdgeLiteRow, number[]>(
      `SELECT me.citing_id AS citingId, me.cited_id AS citedId, me.relation,
              me.tail_tag AS tailTag, me.head_tag AS headTag,
              COALESCE(me.relation_class, '') AS relationClass,
              COALESCE(me.relation_coverage, '') AS relationCoverage
       FROM memory_edges me
       JOIN turns tc ON tc.id = me.citing_id
       JOIN turns td ON td.id = me.cited_id
       WHERE me.citing_id IN (${idPlaceholders})
         AND me.citing_kind = 'turn' AND me.cited_kind = 'turn'
         AND me.relation IS NOT NULL AND NOT ${relationClassBearingSql("me")}
         AND ${liveTurnSql("tc")} AND ${liveTurnSql("td")}`,
    )
    .all(...turnIds);
}

/**
 * D9 proliferation's two segment-wide counts (ticket 09, peer P1-11) — the
 * ONLY place either number is produced. The declared count comes from the
 * `lanes` REGISTRY, not from the tags this projection happened to load: a
 * lane declared and never used still counts against the budget, and a window
 * that loaded three of a segment's sixty-three lanes must not report three.
 * The member count comes from `segment_members`, LIVE-filtered like every
 * other read in this file (LAW 8) so a skipped or rolled-back turn neither
 * inflates the denominator nor silently changes a verdict when it is skipped.
 *
 * The `lanes` table is checked for EXISTENCE first. It is created by
 * `db/schema.ts`, but this module is also read by hard-`readonly` callers
 * (`scripts/lane-check.ts`) that cannot create it, and a production database
 * that has never been opened by a writer since the registry shipped genuinely
 * does not have it — verified read-only on the live database, where `lanes`
 * is still absent. A missing registry means zero declared lanes, which can
 * never trip a `> max(1, …)` test, so the honest answer and the safe one
 * coincide; throwing there would take the whole checker down over a warning.
 *
 * EMPTY LANES (ticket 14). `declaredLaneCount` stays `COUNT(*)` — every
 * declared lane counts against the budget, used or not (the rule and its
 * reasoning live on `LaneSegmentFacts.emptyLaneTags`). What this pass adds is
 * the NAMES of the declared lanes no reader can see, so a tripped ratio can
 * never be silently padded by them.
 *
 * IT READS RESOLVED ATTRIBUTION NOW, NOT THE DECLARATION INDEX
 * (main-agent-edges spec D2). The retired form was a `NOT EXISTS` over
 * `memory_edge_side_tags` — the index of explicit DECLARATIONS — which since
 * resolution answers a strictly narrower question than "does any edge attribute
 * to this lane": an edge whose side derives its lane (69% of production) has
 * no row in that index at all, so a perfectly live lane read as empty and
 * padded the proliferation warning's own escape hatch. The replacement loads
 * every class-carrying edge incident to the segment's live members and asks the
 * resolver, per side, which qualified lane it attributes to; a declared lane no
 * side resolves to is empty.
 */
function loadSegmentFacts(db: Database, segmentIds: readonly number[]): LaneSegmentFacts[] {
  const ids = [...new Set(segmentIds)].sort((a, b) => a - b);
  if (ids.length === 0) {
    return [];
  }
  const placeholders = ids.map(() => "?").join(",");
  const hasLanesTable =
    db
      .query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'lanes'`)
      .all().length > 0;
  const declaredBySegment = new Map<number, number>();
  const emptyLanesBySegment = new Map<number, string[]>();
  if (hasLanesTable) {
    for (const row of db
      .query<{ segmentId: number; laneCount: number }, number[]>(
        `SELECT segment_id AS segmentId, COUNT(*) AS laneCount
         FROM lanes WHERE segment_id IN (${placeholders}) GROUP BY segment_id`,
      )
      .all(...ids)) {
      declaredBySegment.set(row.segmentId, row.laneCount);
    }
    const declaredTagsBySegment = new Map<number, string[]>();
    for (const row of db
      .query<{ segmentId: number; tag: string }, number[]>(
        `SELECT segment_id AS segmentId, tag AS tag
           FROM lanes WHERE segment_id IN (${placeholders})
          ORDER BY segment_id ASC, tag ASC`,
      )
      .all(...ids)) {
      const bucket = declaredTagsBySegment.get(row.segmentId);
      if (bucket === undefined) {
        declaredTagsBySegment.set(row.segmentId, [row.tag]);
      } else {
        bucket.push(row.tag);
      }
    }
    // The ATTRIBUTED set, per segment: every qualified lane some incident
    // edge's side resolves to. Seeded from the segment's own live members,
    // because an edge can only attribute to a lane through an endpoint that
    // is IN it.
    const attributedBySegment = new Map<number, Set<string>>();
    const resolver = createProjectionSideResolver(db);
    for (const segmentId of ids) {
      const attributed = new Set<string>();
      attributedBySegment.set(segmentId, attributed);
      const memberIds = loadSegmentTurnIds(db, segmentId);
      if (memberIds.length === 0) {
        continue;
      }
      const incident = loadClassEdgesTouching(db, memberIds);
      resolver.prime(incident.flatMap((row) => [row.citingId, row.citedId]));
      for (const row of incident) {
        for (const side of ["tail", "head"] as const) {
          const lane = resolver.resolve(row, side).lane;
          if (lane !== null && lane.segmentId === segmentId) {
            attributed.add(lane.tag);
          }
        }
      }
    }
    for (const [segmentId, tags] of declaredTagsBySegment) {
      const attributed = attributedBySegment.get(segmentId) ?? new Set<string>();
      const empty = tags.filter((tag) => !attributed.has(tag));
      if (empty.length > 0) {
        emptyLanesBySegment.set(segmentId, empty);
      }
    }
  }
  const memberCountBySegment = new Map<number, number>();
  for (const row of db
    .query<{ segmentId: number; memberCount: number }, number[]>(
      `SELECT sm.segment_id AS segmentId, COUNT(DISTINCT sm.turn_id) AS memberCount
       FROM segment_members sm
       JOIN turns t ON t.id = sm.turn_id
       WHERE sm.segment_id IN (${placeholders}) AND ${liveTurnSql("t")}
       GROUP BY sm.segment_id`,
    )
    .all(...ids)) {
    memberCountBySegment.set(row.segmentId, row.memberCount);
  }
  return ids.map((segmentId) => ({
    segment: String(segmentId),
    declaredLaneCount: declaredBySegment.get(segmentId) ?? 0,
    memberTurnCount: memberCountBySegment.get(segmentId) ?? 0,
    // Always present from THIS loader (`[]` when every declared lane has a
    // live member, and when the registry table is absent entirely — zero
    // declared lanes have zero empty ones). `undefined` is reserved for a
    // caller that builds facts by hand and loaded no such field at all.
    emptyLaneTags: emptyLanesBySegment.get(segmentId) ?? [],
  }));
}

function loadLiveTurns(db: Database, turnIds: readonly number[]): Map<number, TurnLiteRow> {
  const ids = [...new Set(turnIds)];
  if (ids.length === 0) {
    return new Map();
  }
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .query<TurnLiteRow, number[]>(
      `SELECT id, type, tags, session_id AS sessionId, prompt_number AS promptNumber, created_at_epoch AS createdAtEpoch
       FROM turns WHERE id IN (${placeholders}) AND ${liveTurnSql()}`,
    )
    .all(...ids);
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * `turns.tags` -> the checker's `LaneCheckerTurnInput.tags` (tag-mandate
 * ticket 03, E4). The three cases are deliberately NOT collapsed:
 *
 *   - `NULL` -> `[]`. The column is nullable with no default, so a turn
 *     written before it carried tags, or written with none, reads NULL —
 *     that IS "this turn carries no tags", a real E4 verdict for every
 *     tagged edge touching it, not an unknown.
 *   - a valid JSON array -> its canonical set.
 *   - anything else (malformed JSON, a JSON non-array — `turns.tags` has no
 *     `json_valid` CHECK, so both are storable; see `db/schema.ts`'s own
 *     note) -> `undefined`, i.e. NOT LOADED, so the checker issues no E4
 *     verdict for this turn's side of any edge. A parse failure is
 *     ignorance, and ignorance must never manufacture an error the commit
 *     gate would then refuse a window over.
 */
function parseTurnTags(raw: string | null): readonly string[] | undefined {
  if (raw === null) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    return undefined;
  }
  return canonicalTagSet(parsed as string[]);
}

/** Row -> the core's input shape. The two side columns are the whole lane surface since ticket 09 retired the merged set (spec D1 — `''` on a side means UNSETTLED, never a lane named `''`). */
function toEdgeInput(row: EdgeLiteRow, resolver: ProjectionSideResolver): LaneEdgeInput {
  const tail = resolver.resolve(row, "tail");
  const head = resolver.resolve(row, "head");
  return {
    citingId: row.citingId,
    citedId: row.citedId,
    relation: row.relation,
    relationClass: row.relationClass as LaneEdgeInput["relationClass"],
    relationCoverage: row.relationCoverage as LaneEdgeInput["relationCoverage"],
    // THE RESOLVED ATTRIBUTION (main-agent-edges spec D2), not the stored word
    // — `''` for a side that attributes to no lane. Every lane-keyed reader
    // downstream (`laneMembershipClaims`, the coupling report, the console
    // payload, the timeline's lane chain) asks the same question this answers.
    tailTag: tail.lane?.tag ?? "",
    headTag: head.lane?.tag ?? "",
    tailOutcome: tail.outcome,
    headOutcome: head.outcome,
    // The STORED declarations, carried alongside so an `invalid` finding can
    // name the word that stopped being true.
    storedTailTag: row.tailTag,
    storedHeadTag: row.headTag,
  };
}

/**
 * Load one scope into the core's input shape. Read-only: every statement in
 * this module and its helpers is a `SELECT`, and this function never opens
 * its own connection — the caller (the CLI, hard-`readonly`; the settlement
 * tool, the worker's own live handle) owns that decision.
 */
/**
 * THE membership rule (ticket 10, module header), as one reusable resolver:
 * a turn's stored `tags` INTERSECTED with the lanes DECLARED in its OWNING
 * segment. Homeless (`undefined` segment) or unreadable tags -> no
 * membership. Declared-lane sets are cached per segment for the resolver's
 * lifetime, so a whole projection costs one query per segment.
 *
 * The registry table is checked for EXISTENCE first, for `loadSegmentFacts`'
 * own reason (see its doc): `db/schema.ts` creates `lanes`, but this module
 * is also read by hard-`readonly` callers (`scripts/lane-check.ts`) that
 * cannot create it, and a production database not opened by a writer since
 * the registry shipped genuinely does not have it — verified read-only on the
 * live database. A missing registry means zero declared lanes, so no turn is a
 * member of anything and every report comes back empty; throwing would
 * instead take the whole checker down on an absent table.
 */
function createLaneTagResolver(
  db: Database,
): (segmentId: number | undefined, rawTags: string | null) => string[] {
  const hasLanesTable =
    db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'lanes'`,
      )
      .all().length > 0;
  const declaredLanesBySegment = new Map<number, Set<string>>();
  return (segmentId, rawTags) => {
    if (segmentId === undefined) {
      return [];
    }
    let declared = declaredLanesBySegment.get(segmentId);
    if (declared === undefined) {
      declared = hasLanesTable ? loadDeclaredLaneTags(db, segmentId) : new Set<string>();
      declaredLanesBySegment.set(segmentId, declared);
    }
    return (parseTurnTags(rawTags) ?? []).filter((tag) => declared!.has(tag));
  };
}

/**
 * `LaneTurnInput.laneTags` for an arbitrary turn-id set — the SAME rule
 * `loadLaneCheckScope` resolves its own projection by, exported for the
 * callers that build lane inputs WITHOUT going through a projection
 * (`mcp/timeline.ts`'s two election adapters). Membership is a node fact
 * since ticket 10, so an adapter that omits it hands `electMilestones` a
 * graph with no lanes in it at all and silently loses tier ② (a closed lane's
 * terminus). Turns absent from the map carry no lane.
 */
export function loadLaneTagsForTurns(
  db: Database,
  turnIds: readonly number[],
): Map<number, string[]> {
  const ids = [...new Set(turnIds)];
  const resolved = new Map<number, string[]>();
  if (ids.length === 0) {
    return resolved;
  }
  const resolveLaneTags = createLaneTagResolver(db);
  const owningSegments = loadOwningSegments(db, ids);
  const placeholders = ids.map(() => "?").join(",");
  for (const row of db
    .query<{ id: number; tags: string | null }, number[]>(
      `SELECT id, tags FROM turns WHERE id IN (${placeholders})`,
    )
    .all(...ids)) {
    resolved.set(row.id, resolveLaneTags(owningSegments.get(row.id), row.tags));
  }
  return resolved;
}

export function loadLaneCheckScope(db: Database, scope: LaneCheckScope): LaneCheckProjection {
  let involvedLaneKeys: LaneKey[];
  let seedTurnIds: number[];

  // THE membership vocabulary (ticket 10, module header) — one resolver,
  // shared by the seed-lane discovery half and the final `laneTags`
  // resolution, reading the same registry `db/turn-tag-gate.ts` gates writes
  // against, so a read can never admit a tag the write side would refuse.
  const laneTagsFor = createLaneTagResolver(db);

  // THE ONE side resolver for this whole projection (main-agent-edges D2) —
  // discovery, widen and the final edge assembly all ask it, so no two passes
  // can disagree about which lane a side attributes to.
  const sideResolver = createProjectionSideResolver(db);

  // THE JUDGMENT WINDOW (ticket 02, module header). Absent for every caller
  // that declared none — the CLI, the console, `mcp/note.ts`, stage 1 — and
  // those callers keep loading exactly what they always did, minus the lanes
  // the asymmetry used to smuggle in.
  const judgmentWindow = scope.kind === "turns" ? scope.judgment : undefined;
  const judgmentIds: ReadonlySet<number> | undefined =
    judgmentWindow === undefined ? undefined : new Set(loadJudgmentAnchorTurnIds(db, judgmentWindow));

  if (scope.kind === "lanes") {
    involvedLaneKeys = [...scope.laneKeys];
    seedTurnIds = [];
  } else {
    seedTurnIds = resolveSeedTurnIds(db, scope);
    const discoveryRows = loadClassEdgesTouching(db, seedTurnIds);
    // Round-5 review #13: both endpoints' owning segments yield a lane key,
    // not just the citing side's — a cross-segment tagged edge dual-
    // registers under BOTH segments in the pure core, and discovery must
    // find both copies so either side's own segment scan sees its own
    // membership.
    const owningSegments = loadOwningSegments(
      db,
      discoveryRows.flatMap((row) => [row.citingId, row.citedId]),
    );
    const seen = new Map<string, LaneKey>();
    sideResolver.prime(discoveryRows.flatMap((row) => [row.citingId, row.citedId]));
    for (const row of discoveryRows) {
      // ONE key per RESOLVED SIDE (main-agent-edges spec D2). The arc's TAIL
      // attributes to a lane in the CITING turn's task, its HEAD to one in the
      // CITED turn's — declared where the row declares, DERIVED where the
      // endpoint is in exactly one lane. That second arm is the change: an
      // edge nobody had placed used to discover nothing, so its lane was
      // reachable only if some OTHER edge had been placed there.
      for (const side of ["tail", "head"] as const) {
        const lane = sideResolver.resolve(row, side).lane;
        if (lane === null) continue;
        const key: LaneKey = { segment: String(lane.segmentId), tag: lane.tag };
        seen.set(laneKeyToken(key), key);
      }
    }
    // DISCOVER (b), ticket 10: every lane a SEED TURN itself claims. A seed
    // that carries a lane tag and has written no edge yet names its lane
    // HERE and nowhere else — the edge pass above cannot see it, and without
    // it the widen below would never load that lane's other members, so the
    // lane would be reported on a truncated membership. Liveness
    // comes from `loadLiveTurns` (law 8), so a dead seed claims nothing.
    const seedTurnRows = loadLiveTurns(db, seedTurnIds);
    const seedOwningSegments = loadOwningSegments(db, seedTurnIds);
    for (const row of seedTurnRows.values()) {
      const segmentId = seedOwningSegments.get(row.id);
      for (const tag of laneTagsFor(segmentId, row.tags)) {
        const key: LaneKey = { segment: String(segmentId), tag };
        seen.set(laneKeyToken(key), key);
      }
    }
    involvedLaneKeys = [...seen.values()];
  }

  // ---- WIDEN: each involved lane's tagged edge set, its own segment only ----
  const widenedByKey = new Map<string, EdgeLiteRow[]>();
  // …and (ticket 10, phase 4) each involved lane's MEMBERSHIP, which no edge
  // pass can reach: a turn carrying the tag with no edge at all.
  const laneMemberIds = new Set<number>();
  /**
   * THE ONE MEMBERSHIP ANSWER (ticket 02, module header). `laneKeyToken` ->
   * the member ids this projection EMITTED for that lane. `laneTags` is
   * resolved against it below, so "the lanes membership is resolved for" and
   * "the lanes whose edges were widened" are the SAME set by construction, and
   * the per-member narrowing a judgment window applies cannot be undone by a
   * later pass re-admitting a dropped member through some other door.
   */
  const membersByLaneToken = new Map<string, Set<number>>();
  /** Members emitted only because they are somebody's BOUNDARY WITNESS — the third role. */
  const boundaryMemberIds = new Set<number>();
  /**
   * The DENOMINATOR (ticket 04): each widened lane's whole declared membership,
   * captured from the same `segment_members` scan the narrowing is applied to,
   * BEFORE it is applied. Recorded here rather than re-queried later because a
   * second query is a second answer.
   */
  const laneMemberTotals: LaneMemberTotal[] = [];
  for (const laneKey of involvedLaneKeys) {
    const token = laneKeyToken(laneKey);
    // The SCAN. A DEFAULT_SEGMENT (homeless) lane has no `segment_members`
    // rows and therefore no membership at all — see the module header.
    const scannedMembers = new Set<number>(
      laneKey.segment === DEFAULT_SEGMENT
        ? []
        : loadSegmentTurnIdsCarryingTag(db, Number(laneKey.segment), laneKey.tag),
    );
    // A homeless lane has no `segment_members` rows, so its `scannedMembers`
    // is empty by construction rather than by measurement — no entry, no
    // fabricated denominator.
    if (laneKey.segment !== DEFAULT_SEGMENT) {
      laneMemberTotals.push({ key: laneKey, declaredMemberCount: scannedMembers.size });
    }
    // THE CANDIDATE PREDICATE (main-agent-edges spec D2): edges INCIDENT TO A
    // MEMBER, not edges that STORE this lane's word. Membership is a node
    // fact, so the lane's own edges are addressable without any writer having
    // declared a side — which is the whole 69% the stored-side predicate was
    // dropping. The old `memory_edge_side_tags` lookup indexed declarations
    // only and structurally could not answer this question.
    const candidates = loadClassEdgesTouching(db, [...scannedMembers]);
    sideResolver.prime(candidates.flatMap((row) => [row.citingId, row.citedId]));
    // Then PER SIDE, through the resolver: a row belongs to lane `(S, T)` when
    // its tail resolves to `(S, T)` or its head does. The qualification is the
    // pair, never the bare word — the same tag in another task is another lane.
    const laneEdges = candidates.filter((row) =>
      (["tail", "head"] as const).some((side) => {
        const lane = sideResolver.resolve(row, side).lane;
        return lane !== null && String(lane.segmentId) === laneKey.segment && lane.tag === laneKey.tag;
      }),
    );

    if (judgmentIds === undefined) {
      // No window declared: the lane is emitted whole, exactly as before —
      // what changes for such a caller is only that a lane it never
      // discovered is no longer reported off a partial edge set.
      membersByLaneToken.set(token, scannedMembers);
      widenedByKey.set(token, laneEdges);
      for (const id of scannedMembers) {
        laneMemberIds.add(id);
      }
      continue;
    }

    // NARROW (ticket 02): the components the judgment anchors touch, plus ONE
    // nearest untouched component per touched one. The scan above found them;
    // only these are emitted.
    const laneEdgeOwningSegments =
      laneEdges.length === 0
        ? new Map<number, number>()
        : loadOwningSegments(db, laneEdges.flatMap((row) => [row.citingId, row.citedId]));
    const components = componentsOfLane(
      laneKey,
      scannedMembers,
      laneEdges,
      laneEdgeOwningSegments,
      judgmentIds,
      sideResolver,
    );
    const kept = new Map<number, LaneComponentSlice>();
    for (const component of components) {
      if (!component.touched) continue;
      kept.set(component.representative, component);
      const witness = nearestUntouchedComponent(component, components);
      if (witness !== null) {
        kept.set(witness.representative, witness);
      }
    }
    const emitted = new Set<number>();
    for (const component of kept.values()) {
      for (const id of component.memberIds) {
        emitted.add(id);
        if (!component.touched) {
          boundaryMemberIds.add(id);
        }
      }
    }
    membersByLaneToken.set(token, emitted);
    for (const id of emitted) {
      laneMemberIds.add(id);
    }
    // An edge is emitted when it still has an emitted endpoint. A CLAIMING
    // edge unions its two endpoints into one component, so it is kept or
    // dropped whole and can never dangle across the cut; what this admits
    // beyond those is the CROSS-LANE rows report 3 counts, whose far endpoint
    // then joins as EVIDENCE.
    widenedByKey.set(
      token,
      emitted.size === 0
        ? []
        : laneEdges.filter((row) => emitted.has(row.citingId) || emitted.has(row.citedId)),
    );
  }

  const edgeMap = new Map<string, EdgeLiteRow>();
  for (const rows of widenedByKey.values()) {
    for (const row of rows) {
      edgeMap.set(edgeKey(row), row);
    }
  }

  // ---- member set: every endpoint of every widened tagged edge, every turn
  // that CLAIMS an involved lane (ticket 10), plus the seed. The claiming
  // turns join here rather than at the end so the supplementary passes below
  // (citedness, override, the component neighbourhood) see them too: report
  // 1's citedness is lane-WIDE, and an edgeless member is still a member
  // something outside can ground. ----
  const memberIds = new Set<number>(seedTurnIds);
  for (const row of edgeMap.values()) {
    memberIds.add(row.citingId);
    memberIds.add(row.citedId);
  }
  for (const id of laneMemberIds) {
    memberIds.add(id);
  }
  const memberIdList = [...memberIds];

  // ---- SUPPLEMENTARY: the neighbourhood, in ONE pass ----
  //
  // This was THREE word-keyed passes: cross-phase citedness
  // (`grounds`/`verifies`/`refutes`), an untagged-`override` pass for the
  // retired global kill, and an untagged STANCE pass off the seed turns that
  // fed the component reports and D9's unattributed-cluster warning. Together
  // they covered six of the seven words; the difference between them was a
  // vocabulary distinction that no longer exists, and the citedness buckets
  // they fed are deleted outright (spec D2). One pass over every
  // class-carrying edge touching a member replaces all three — marginally
  // wider (`consume` and `indexes` rows now arrive too), and one predicate
  // instead of three that could disagree.
  for (const row of loadClassEdgesTouching(db, memberIdList)) {
    edgeMap.set(edgeKey(row), row);
  }
  if (seedTurnIds.length > 0) {
    // The SEED's own neighbourhood, unconditionally: every pass above seeds
    // from DISCOVERED lane members, so a scope whose seeds join no lane at all
    // would otherwise load nothing and D9's unattributed-cluster warning —
    // defined over exactly those lane-less edges — would have no input.
    for (const row of loadClassEdgesTouching(db, seedTurnIds)) {
      edgeMap.set(edgeKey(row), row);
    }
  }
  // THE HOMELESS-LANE FIXPOINT CLOSURE IS DELETED (v12 ticket 11). It walked
  // `SEGMENT_GRAPH_RELATIONS_SQL` outward from a DEFAULT_SEGMENT lane's own
  // edge endpoints, because a homeless lane had no `segment_members` rows to
  // widen from. Ticket 10 made membership a NODE fact resolved against the
  // OWNING segment's registry, and a homeless turn has no owning segment — so
  // it resolves no lane tags, joins no lane, and `deriveLaneInterpretation`
  // never enumerates a DEFAULT_SEGMENT lane at all. The closure was loading
  // edges for a lane the core cannot report, at a cost of one query per BFS
  // round. `db/turn-liveness.ts`'s law-8 gate is untouched by the removal.
  //
  // SEGMENT-GLOBAL graph (round-4 review #4a): every live turn owned by each
  // involved lane's own (real) segment, plus every live structural edge with
  // BOTH endpoints in that turn set. Since ticket 11 this is what report 4b's
  // transitive reduction ("段的全图") is computed over — report 2's
  // connectivity no longer reads it, since a lane's connectivity is now judged
  // on the lane's own claiming edges alone.
  //
  // UNDER A JUDGMENT WINDOW THAT DOMAIN IS THE EVIDENCE CLOSURE, NOT THE
  // SEGMENT (ticket 02). Scanning whole segments is the single largest cost
  // this loader pays and the reason a 50-prompt window loaded 1524 turns of
  // E60 and classed 435 errors on them: `loadSegmentTurnIds` returns every one
  // of a segment's 2225 live turns and `loadComponentEdgesAmong` then runs
  // with twice that many bound parameters. What report 4b actually needs is
  // the graph AROUND what this projection judges, so the domain becomes the
  // loaded set plus ONE structural hop out of it — which is exactly the
  // evidence closure's definition, and is enough to see every three-node
  // detour around a judged turn. A detour of four nodes or more that leaves
  // the closure entirely is given up on purpose; report 4b is a warning about
  // shape, and a warning anchored outside the judgment set may not be reported
  // anyway.
  const realSegmentIds = [...new Set(involvedLaneKeys.map((key) => key.segment).filter((s) => s !== DEFAULT_SEGMENT))];
  const segmentGraphDomain = new Set<number>();
  if (judgmentIds === undefined) {
    for (const segmentId of realSegmentIds) {
      for (const id of loadSegmentTurnIds(db, Number(segmentId))) {
        segmentGraphDomain.add(id);
      }
    }
  } else {
    for (const id of memberIdList) {
      segmentGraphDomain.add(id);
    }
    for (const row of loadClassEdgesTouching(db, memberIdList)) {
      segmentGraphDomain.add(row.citingId);
      segmentGraphDomain.add(row.citedId);
    }
  }
  for (const row of loadComponentEdgesAmong(db, [...segmentGraphDomain])) {
    edgeMap.set(edgeKey(row), row);
  }

  const allTurnIds = new Set(memberIdList);
  for (const row of edgeMap.values()) {
    allTurnIds.add(row.citingId);
    allTurnIds.add(row.citedId);
  }
  // The scope's own SEED turns always join the projection (the untagged-stance
  // pass's sibling repair): without this, an edge-less laneless window loads
  // zero turns and E3 on its own rows would be invisible. `loadLiveTurns`
  // below keeps the liveness/skip exemptions — a dead or skipped seed still
  // never becomes a judgable row.
  for (const id of seedTurnIds) {
    allTurnIds.add(id);
  }

  // OUT-OF-VOCABULARY EDGES (semantic-conformance ticket 02), from two
  // passes: the among-BOTH-endpoints one over everything loaded so far, and
  // the seed-scoped CITING-side one (peer round T1466, finding P1-1 — module
  // header, "OUT-OF-VOCABULARY EDGES REACHING OUTSIDE THE SCOPE") whose far
  // endpoint may not be in `allTurnIds` yet and is joined in right below, so
  // the no-dangling-endpoint invariant survives. Deduplicated by the same
  // `edgeKey` the edge map uses; a row both passes return is carried once.
  //
  // Kept on its OWN field — never merged into `edgeMap`/`edges` — so
  // `mcp/note.ts`'s Gate C self-`grounds` terminus check, the one OTHER
  // reader of `projection.edges` in this codebase, never has its own
  // `deriveLaneInterpretation` re-derivation widened by a relation it was
  // never scoped to see (`LaneCheckProjection`'s own doc comment).
  // `checkLanes` (`shared/lane-checker.ts`) is what keeps these OUT of every
  // graph computation once they DO reach it, through its own third parameter.
  const outOfVocabularyRows = new Map<string, EdgeLiteRow>();
  for (const row of loadOutOfVocabularyEdgesAmong(db, [...allTurnIds])) {
    outOfVocabularyRows.set(edgeKey(row), row);
  }
  for (const row of loadOutOfVocabularyEdgesFromCiting(db, seedTurnIds)) {
    outOfVocabularyRows.set(edgeKey(row), row);
  }
  // The far endpoints join the projection (never the reverse — this pass
  // widens the TURN set only, never re-runs the among-pass over the widened
  // set: an out-of-vocabulary row is a reported fact, not a lane input, so
  // one round is the whole of it).
  for (const row of outOfVocabularyRows.values()) {
    allTurnIds.add(row.citingId);
    allTurnIds.add(row.citedId);
  }
  sideResolver.prime([...outOfVocabularyRows.values()].flatMap((row) => [row.citingId, row.citedId]));
  const outOfVocabularyEdges = [...outOfVocabularyRows.values()]
    .map((row) => toEdgeInput(row, sideResolver))
    .sort((a, b) => {
      if (a.citingId !== b.citingId) return a.citingId - b.citingId;
      if (a.citedId !== b.citedId) return a.citedId - b.citedId;
      return a.relation.localeCompare(b.relation);
    });

  const turnRows = loadLiveTurns(db, [...allTurnIds]);
  const owningSegmentsForTurns = loadOwningSegments(db, [...allTurnIds]);

  /**
   * THE membership rule, closed (ticket 02, module header): the registry
   * intersection `createLaneTagResolver` computes, INTERSECTED with the
   * per-lane member sets this projection actually emitted. One predicate, one
   * place — the widening decided these sets and nothing downstream may widen
   * them back.
   */
  function emittedLaneTagsFor(
    turnId: number,
    segmentId: number | undefined,
    rawTags: string | null,
  ): string[] {
    if (segmentId === undefined) {
      return [];
    }
    const segment = String(segmentId);
    return laneTagsFor(segmentId, rawTags).filter((tag) =>
      membersByLaneToken.get(laneToken(segment, tag))?.has(turnId) ?? false,
    );
  }

  const turns: LaneCheckerTurnInput[] = [...turnRows.values()]
    .map((row) => {
      const segmentId = owningSegmentsForTurns.get(row.id);
      const input: LaneCheckerTurnInput = {
        id: row.id,
        type: JSON.parse(row.type) as string[],
        order: turnOrderKey(row.sessionId, row.promptNumber),
        createdAtEpoch: row.createdAtEpoch,
        // THE membership fact (ticket 10, module header). Always present from
        // this loader — `[]` is a real answer ("this turn joins no lane"),
        // never "not loaded", because the two inputs it needs (the turn's own
        // column and its segment's registry) are both read right here.
        //
        // TICKET 02 closes the asymmetry HERE: the registry intersection is
        // further restricted to the lanes this projection WIDENED, member by
        // member (`membersByLaneToken`). A turn dragged in by the
        // segment-global pass, or held only as a far edge endpoint, therefore
        // claims nothing — so the lane it happens to carry a tag for is never
        // enumerated off a truncated edge set. See the module header.
        laneTags: emittedLaneTagsFor(row.id, segmentId, row.tags),
      };
      if (segmentId !== undefined) {
        input.segment = String(segmentId);
      }
      // Omitted (rather than set to `[]`) only when the stored value is
      // unparseable — see `parseTurnTags`: absent means "no E4 verdict".
      const tags = parseTurnTags(row.tags);
      if (tags !== undefined) {
        input.tags = tags;
      }
      return input;
    })
    .sort((a, b) => a.id - b.id);

  sideResolver.prime([...edgeMap.values()].flatMap((row) => [row.citingId, row.citedId]));
  const edges: LaneEdgeInput[] = [...edgeMap.values()]
    .map((row) => toEdgeInput(row, sideResolver))
    .sort((a, b) => {
      if (a.citingId !== b.citingId) return a.citingId - b.citingId;
      if (a.citedId !== b.citedId) return a.citedId - b.citedId;
      return a.relation.localeCompare(b.relation);
    });

  // D9 proliferation (ticket 09): the REAL segments this scope actually asked
  // about — every seed turn's owning segment, plus every involved lane key's
  // own segment so the seed-less `lanes` scope is covered too. Deliberately
  // NOT "every segment among the loaded turns": the segment-global component
  // pass and cross-segment citations both drag in neighbours this caller
  // never asked a question about, and each would otherwise get a per-segment
  // verdict of its own in a window that merely brushed against it.
  const scopeSegmentIds = new Set<number>();
  for (const id of seedTurnIds) {
    const segmentId = owningSegmentsForTurns.get(id);
    if (segmentId !== undefined) {
      scopeSegmentIds.add(segmentId);
    }
  }
  for (const laneKey of involvedLaneKeys) {
    if (laneKey.segment !== DEFAULT_SEGMENT) {
      scopeSegmentIds.add(Number(laneKey.segment));
    }
  }
  const segmentFacts = loadSegmentFacts(db, [...scopeSegmentIds]);

  // THE THREE ROLES (ticket 02, module header), over the turns this projection
  // actually returns — disjoint and exhaustive. A boundary witness lives in a
  // component NO judgment anchor touches, so the two sets cannot overlap;
  // EVIDENCE is the remainder, defined by subtraction rather than by a third
  // membership query that could disagree with the other two.
  const judgment = new Set<number>();
  const boundary = new Set<number>();
  const evidence = new Set<number>();
  for (const turn of turns) {
    if (judgmentIds === undefined || judgmentIds.has(turn.id)) {
      judgment.add(turn.id);
    } else if (boundaryMemberIds.has(turn.id)) {
      boundary.add(turn.id);
    } else {
      evidence.add(turn.id);
    }
  }

  return {
    turns,
    edges,
    involvedLaneKeys,
    outOfVocabularyEdges,
    segmentFacts,
    roles: { judgment, evidence, boundary },
    laneMemberTotals,
  };
}

// ------------------------------------------- ATTRIBUTION CONTROLS (ticket 13)

/**
 * The four reads the v12 ATTRIBUTION CONTROLS (`src/cli/lane-controls-cli.ts`,
 * ticket 13) are built on. Every one is a `SELECT`; nothing below opens a
 * connection, begins a transaction, or writes.
 *
 * WHY A CAPABILITY PROBE COMES FIRST. `scripts/lane-controls.ts` opens
 * hard-`readonly` and its default target is the production database, which has
 * NOT run the v12 edge migration — verified read-only while this ticket was
 * written: `memory_edges` still carries the merged `tags` column (its CHECK
 * still lists `refutes`/`supersedes`), and neither `memory_edge_side_tags` nor
 * `lanes` exists. Every query here that names `tail_tag` THROWS on such a file,
 * and a control that answered `0` instead would be reporting "the attribution
 * is finished" where the truth is "nothing could be measured" — exactly the
 * confusion ticket 13 exists to remove. `loadLaneControlCapability` is what
 * lets the caller print a reason in a number's place; the loaders below assume
 * it was consulted and do not re-check.
 */
export interface LaneControlCapability {
  /** `memory_edges.tail_tag`/`head_tag` — the two-sided lane storage spec M-A creates. Without it NO control can be measured at all. */
  edgeSideTagColumns: boolean;
  /** The `memory_edge_side_tags` index table — every WIDEN pass's own domain, and so the terminus sample's. */
  edgeSideTagIndex: boolean;
  /** The `lanes` REGISTRY — what makes a word a DECLARED lane rather than one of the 7694 legacy free-form values (spec D3b). Without it "declared" has no meaning to check against. */
  laneRegistry: boolean;
}

export function loadLaneControlCapability(db: Database): LaneControlCapability {
  const columns = new Set(
    db
      .query<{ name: string }, []>(`SELECT name FROM pragma_table_info('memory_edges')`)
      .all()
      .map((row) => row.name),
  );
  const tables = new Set(
    db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master
          WHERE type = 'table' AND name IN ('memory_edge_side_tags', 'lanes')`,
      )
      .all()
      .map((row) => row.name),
  );
  return {
    edgeSideTagColumns: columns.has("tail_tag") && columns.has("head_tag"),
    edgeSideTagIndex: tables.has("memory_edge_side_tags"),
    laneRegistry: tables.has("lanes"),
  };
}

/**
 * One live turn->turn edge with everything a control FINDING needs to be
 * judged by a human without a second query: both endpoints' addresses
 * (`order`), both endpoints' OWNING segment (the `LaneKey` segment halves),
 * both side tags, and both endpoints' own stored `tags` (the subset check's
 * second input).
 */
export interface LaneControlEdge {
  citingId: number;
  citedId: number;
  relation: string;
  /** `memory_edges.provenance` — carried as a DENOMINATOR fact only (which queue a row belongs to), never as a filter: the checker judges every relation-carrying live edge and so does every control. */
  provenance: string;
  /** `memory_edges.tail_tag` verbatim — `''` is UNSETTLED (spec D1), never a lane named `''`. */
  tailTag: string;
  /** `memory_edges.head_tag` verbatim. See `tailTag`. */
  headTag: string;
  /** `LaneKey.segment` form of the CITING turn's OWNING segment (`MIN(segment_id)`, `getOwningSegmentId`'s own tie-break); `DEFAULT_SEGMENT` when the turn is homeless. */
  citingSegment: string;
  /** `LaneKey.segment` form of the CITED turn's owning segment. */
  citedSegment: string;
  citingOrder: LaneOrderKey;
  citedOrder: LaneOrderKey;
  /** Wall-clock epoch of each endpoint — the honest downstream key (a `session_id` carries no meaning relative to another session's: the tuple-order trap). */
  citingEpoch: number;
  citedEpoch: number;
  /** The CITING turn's own stored tags, canonical. `undefined` = UNPARSEABLE, so no subset verdict for this side — `parseTurnTags`' own rule, restated nowhere. */
  citingTags?: readonly string[];
  /** The CITED turn's own stored tags. See `citingTags`. */
  citedTags?: readonly string[];
}

interface ControlEdgeRow {
  citingId: number;
  citedId: number;
  relation: string;
  provenance: string;
  tailTag: string;
  headTag: string;
  citingSession: number;
  citingPrompt: number;
  citingEpoch: number;
  citingTagsRaw: string | null;
  citedSession: number;
  citedPrompt: number;
  citedEpoch: number;
  citedTagsRaw: string | null;
}

/**
 * EVERY live relation-carrying turn->turn edge in the database — the controls'
 * whole domain, deliberately unfiltered in two ways a reader might expect:
 *
 *   - NO provenance filter. `judged` rows are lane rows exactly like `asserted`
 *     ones, and every one of them is something the checker's reports read.
 *   - NO seven-word vocabulary filter. On a MIGRATED database no such row can
 *     exist (ticket 03 took `refutes`/`supersedes` out of the CHECK and no
 *     write face can produce a word outside the seven), and on an unmigrated
 *     one the capability probe has already stopped every control — so a filter
 *     here would only be able to hide rows in a case that cannot arise.
 *
 * LAW 8 (`db/turn-liveness.ts`) applies to BOTH endpoints, like every other
 * read in this file: a rolled-back or skipped turn is never a node and never an
 * edge endpoint, so a dead row can neither inflate a control nor be reported as
 * unattributed debt nobody can repair.
 *
 * THROWS on a database with no `tail_tag`/`head_tag` — call
 * `loadLaneControlCapability` first.
 */
export function loadLaneControlEdges(db: Database): LaneControlEdge[] {
  const rows = db
    .query<ControlEdgeRow, []>(
      `SELECT me.citing_id AS citingId, me.cited_id AS citedId,
              me.relation AS relation, me.provenance AS provenance,
              me.tail_tag AS tailTag, me.head_tag AS headTag,
              tc.session_id AS citingSession, tc.prompt_number AS citingPrompt,
              tc.created_at_epoch AS citingEpoch, tc.tags AS citingTagsRaw,
              td.session_id AS citedSession, td.prompt_number AS citedPrompt,
              td.created_at_epoch AS citedEpoch, td.tags AS citedTagsRaw
         FROM memory_edges me
         JOIN turns tc ON tc.id = me.citing_id
         JOIN turns td ON td.id = me.cited_id
        WHERE me.citing_kind = 'turn' AND me.cited_kind = 'turn'
          AND me.relation IS NOT NULL
          AND ${liveTurnSql("tc")} AND ${liveTurnSql("td")}
        ORDER BY me.citing_id ASC, me.cited_id ASC, me.relation ASC,
                 me.tail_tag ASC, me.head_tag ASC`,
    )
    .all();
  const owningSegments = loadOwningSegments(
    db,
    rows.flatMap((row) => [row.citingId, row.citedId]),
  );
  return rows.map((row) => {
    const edge: LaneControlEdge = {
      citingId: row.citingId,
      citedId: row.citedId,
      relation: row.relation,
      provenance: row.provenance,
      tailTag: row.tailTag,
      headTag: row.headTag,
      citingSegment: segmentKeyFor(owningSegments, row.citingId),
      citedSegment: segmentKeyFor(owningSegments, row.citedId),
      citingOrder: turnOrderKey(row.citingSession, row.citingPrompt),
      citedOrder: turnOrderKey(row.citedSession, row.citedPrompt),
      citingEpoch: row.citingEpoch,
      citedEpoch: row.citedEpoch,
    };
    const citingTags = parseTurnTags(row.citingTagsRaw);
    if (citingTags !== undefined) {
      edge.citingTags = citingTags;
    }
    const citedTags = parseTurnTags(row.citedTagsRaw);
    if (citedTags !== undefined) {
      edge.citedTags = citedTags;
    }
    return edge;
  });
}

/**
 * The whole `lanes` REGISTRY as `LaneKey.segment` -> its declared tags — the
 * only thing "已声明" can be checked against, and the reason control 2 is not
 * simply error class E4 twice: E4 asks whether a side's tag is on that side's
 * own TURN, this map asks whether that tag was ever DECLARED where the turn
 * lives. Spec D6 defers the second question as a checker REPORT; a control is
 * not a report, and the whole point of ticket 13 is to answer it before the
 * reports are read.
 *
 * An absent registry table yields an EMPTY map rather than a throw — the same
 * posture `createLaneTagResolver`/`loadSegmentFacts` already take for a
 * hard-`readonly` caller that cannot create it. The caller must have consulted
 * `loadLaneControlCapability`; an empty map on a database with no registry
 * would otherwise read as "nothing is declared", which is a verdict rather than
 * an absence.
 */
export function loadDeclaredLaneRegistry(db: Database): Map<string, Set<string>> {
  const registry = new Map<string, Set<string>>();
  const hasLanesTable =
    db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'lanes'`,
      )
      .all().length > 0;
  if (!hasLanesTable) {
    return registry;
  }
  for (const row of db
    .query<{ segmentId: number; tag: string }, []>(
      `SELECT segment_id AS segmentId, tag FROM lanes ORDER BY segment_id ASC, tag ASC`,
    )
    .all()) {
    const segment = String(row.segmentId);
    const bucket = registry.get(segment);
    if (bucket === undefined) {
      registry.set(segment, new Set([row.tag]));
    } else {
      bucket.add(row.tag);
    }
  }
  return registry;
}

/** Every segment with at least one DECLARED lane, ascending — the terminus sample's scan list (a segment that declared nothing can hold no closed lane). Empty when the registry table is absent. */
export function loadSegmentsWithDeclaredLanes(db: Database): number[] {
  const hasLanesTable =
    db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'lanes'`,
      )
      .all().length > 0;
  if (!hasLanesTable) {
    return [];
  }
  return db
    .query<{ segmentId: number }, []>(
      `SELECT DISTINCT segment_id AS segmentId FROM lanes ORDER BY segment_id ASC`,
    )
    .all()
    .map((row) => row.segmentId);
}

/** One downstream turn's identity + address components (ticket 13, requirement 4). */
export interface LaneDownstreamTurn {
  id: number;
  order: LaneOrderKey;
  createdAtEpoch: number;
}

/**
 * The live turns of `segmentId` that POSTDATE `afterEpoch`, ascending, capped
 * at `limit` — the addresses requirement 4 needs exported so a human can read
 * the CONTENT and decide whether the outside really did refer to a closed
 * lane's terminus.
 *
 * WALL-CLOCK, not the `order` tuple, on purpose: "downstream" here means "was
 * written later", and a `session_id`'s numeric order carries no meaning
 * relative to another session's (the tuple-order trap `lane-checker.ts`'s
 * report 4c documents). The turn's own address is still returned as the tuple,
 * because that is what a reader types into a tool.
 */
export function loadDownstreamTurns(
  db: Database,
  segmentId: number,
  afterEpoch: number,
  limit: number,
): LaneDownstreamTurn[] {
  if (limit <= 0) {
    return [];
  }
  return db
    .query<
      { id: number; sessionId: number; promptNumber: number; createdAtEpoch: number },
      [number, number, number]
    >(
      `SELECT t.id AS id, t.session_id AS sessionId, t.prompt_number AS promptNumber,
              t.created_at_epoch AS createdAtEpoch
         FROM turns t
         JOIN segment_members sm ON sm.turn_id = t.id
        WHERE sm.segment_id = ? AND ${liveTurnSql("t")}
          AND t.created_at_epoch > ?
        ORDER BY t.created_at_epoch ASC, t.id ASC
        LIMIT ?`,
    )
    .all(segmentId, afterEpoch, limit)
    .map((row) => ({
      id: row.id,
      order: turnOrderKey(row.sessionId, row.promptNumber),
      createdAtEpoch: row.createdAtEpoch,
    }));
}

// Re-exported so a consumer (the CLI, the settlement tool) that only needs
// the relation vocabulary for validating a `--lane` argument's shape need
// not also import `turn-phase.ts` directly.
export { EDGE_RELATIONS };

// Re-exported so a consumer (`mcp/note.ts`'s settlement `lane_check` tool)
// that names a lane by its own `LaneKey` need not also import
// `shared/lane-interpretation.ts` directly — pre-existing gap, not part of
// this batch's own defect set, fixed in passing since it lives in this
// module's own export surface.
export type { LaneKey };
