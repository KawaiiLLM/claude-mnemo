import type { LaneCheckScope } from "../db/lane-checker-load";
import { DEFAULT_SEGMENT, laneToken, UNSETTLED_LANE_TAG } from "../shared/lane-interpretation";
import type {
  LaneComponentReport,
  LaneStatsReport,
  LaneTurnInput,
} from "../shared/lane-checker";
import { buildLaneAnchorAddresses, renderLaneCheckerReports } from "../shared/lane-checker-render";
import { electMilestones, type MilestoneTurnInput } from "../shared/milestone-election";

import type { ConsoleReader } from "./console-reader";
import { parseSessionsCursor } from "./console-reader";
import type { ConsoleRecallInput, ConsoleTimelineInput } from "./console-reader";

/**
 * The `/api/console/*` route handlers (memory-console spec API Contract;
 * ticket 03). Every handler is shaped `(reader, url, ctx) -> { status, body
 * }` — pure of any `Database`/`bun:sqlite` access (pinned by this module's
 * own source guard test, `tests/worker/console-api.test.ts`): all storage
 * reads happen through the `ConsoleReader` capability
 * (`console-reader.ts`), never here.
 *
 * `ctx` carries the two things a handler needs that are NOT a database read
 * — the running worker's own build id (`meta.workerBuildId`) and a clock
 * (`meta.asOf` on the three non-graph routes; the graph route instead uses
 * `ConsoleReader.runLaneCheck`'s own `asOf`, captured inside its read
 * transaction per the spec's "One projection" section). This is one
 * parameter wider than the ticket's own shorthand "(reader, url) -> payload"
 * — recorded here as a deliberate, minimal deviation: without it, either
 * every handler reaches for `Date.now()`/`BUILD_ID` directly (untestable,
 * and `BUILD_ID` is a `../shared/build-id` import this module would
 * otherwise have no reason to carry) or the caller has to reach INTO the
 * returned body to patch those two fields after the fact.
 */

// --------------------------------------------------------------- bounds ----

/**
 * Named bounds (spec API Contract; values from ticket 01's Recommended
 * Constants table, taken verbatim). Owned here rather than in
 * `shared/`/`db/` — this ticket's territory is `console-reader.ts` +
 * `console-api.ts` + `server.ts` route wiring only, and these constants have
 * exactly one consumer, this file.
 */
export const SESSIONS_PAGE_MAX = 50;
export const GRAPH_WINDOW_DEFAULT = 50;
export const GRAPH_WINDOW_MAX = 2000;
export const EXCERPT_PROMPT_CP = 280;
/**
 * Ticket 01 flagged this value as "not separately measured" — its own
 * measurement payload carried prompt excerpts + full titles only, no content
 * field, and recommended parity with `EXCERPT_PROMPT_CP` "on the same
 * order-of-magnitude reasoning", explicitly flagged for this ticket to
 * confirm once a content-bearing field actually enters the projection (this
 * ticket's `contentExcerpt` turn field, below).
 *
 * CONFIRMED at parity (280), not adjusted. Reasoning: `turns.content` is an
 * agent-written summary field, not raw conversational text — structurally
 * the same "prose, usually shorter than a full user prompt" shape
 * `EXCERPT_PROMPT_CP` already governs, so there is no basis to size it
 * differently. The worst-case byte risk WAS checked: a widened scope's own
 * turns each carrying a full 280-code-point CJK content string adds real
 * weight (3 bytes/code point worst case) — but that is not a reason to
 * shrink the cap: `RESPONSE_BYTE_SOFT_MAX` is an ADVISORY, POST-load budget
 * this handler already enforces via `applyGraphAutoInterval` below (ticket
 * 04, graph-byte-priority) — a worst case degrades gracefully into a
 * correctly-labeled, COMPLETE narrower interval instead of an oversized
 * response or an amputated one, which is exactly the contract the byte
 * budget exists to keep.
 */
export const EXCERPT_CONTENT_CP = 280;
/**
 * Ticket 04 (graph-byte-priority, T1496 ruling): 1000 → 10000. Never the
 * actual amputation culprit measured against segment-60 (its own 3400 edges
 * were cut to 1000 by THIS cap before the byte trim loop cut them again, to
 * 280 — the "graph with no edges" the user saw) — raised 10x so a session's
 * or segment's real edge count clears it without narrowing, leaving
 * `RESPONSE_BYTE_SOFT_MAX` (via the interval selector below) as the one
 * mechanism that actually narrows a response.
 *
 * Ticket 03 (peer P1-3/P2-7): moved to apply AFTER interval resolution, to
 * the RESOLVED edge set only — see `WIDEN_NODE_MAX`'s own doc for why
 * pre-cutting the full projection was the bug, and
 * `applyPostIntervalCountBounds` for the new mechanism.
 */
export const GRAPH_EDGE_MAX = 10_000;
/**
 * Ticket 04: 2000 → 10000, re-examined alongside `GRAPH_EDGE_MAX` (T1496
 * ruling: "re-examine WIDEN_NODE_MAX alongside"). Unlike `GRAPH_EDGE_MAX`,
 * this was NOT the culprit in the measured incident — segment-60's 1219
 * turns already cleared the old 2000 cap with room to spare — so this raise
 * is headroom parity with the other two caps rising 8-10x, not a repair of
 * an observed amputation. Kept as a real (if now rarely-triggered)
 * structural safety net.
 *
 * Ticket 03 (peer P1-3/P2-7): this cap now applies AFTER
 * `applyGraphAutoInterval` resolves its own interval, to the RESOLVED
 * turns/edges — never before. Applying it before (the original mechanism)
 * cut a stable OLDEST-first prefix of the FULL projection ahead of the
 * interval walk, so the walk closed over a damaged graph (an in-interval
 * edge could vanish because its endpoint's turn, or the edge row itself,
 * never survived the pre-cut) and, past this cap, the true newest turns
 * became permanently unreachable by any interval — the opposite of what a
 * "show me the newest" console should do. `applyPostIntervalCountBounds`
 * (below `applyGraphAutoInterval`) is the new mechanism: NEWEST-first (keeps
 * the tail of the ascending-sorted resolved turns, drops the older excess),
 * and it re-derives the reported interval boundary and re-filters edges to
 * endpoint closure against the smaller turn set when it fires, so the
 * "every in-interval edge survives" contract keeps holding even when this
 * safety net trims something.
 */
export const WIDEN_NODE_MAX = 10_000;
/**
 * Ticket 04 (T1496 ruling): 1MB → 8MB. The 1MB figure was advisory
 * guesswork (this constant's own former doc said so); segment-60's own
 * whole-scope measurement (~1.5MB total: ~920KB turns + 73KB laneCheckText
 * + edges) is the new sizing anchor — 8MB gives that real shape roughly 5x
 * headroom before the interval selector (`applyGraphAutoInterval`) ever
 * needs to narrow anything.
 */
export const RESPONSE_BYTE_SOFT_MAX = 8_000_000;
/**
 * Election preview budget (ticket 03: "budget = ... the renderer's default
 * milestone budget 30 (DEFAULT_TIMELINE_PAGE_SIZE precedent)"). Redeclared
 * as a local literal rather than importing `DEFAULT_TIMELINE_PAGE_SIZE` from
 * `mcp/timeline.ts`: that module is the MCP surface's own large renderer,
 * and nothing else in `src/worker/` depends on `src/mcp/` — pulling one
 * constant across that boundary would be a real (if small) new coupling for
 * a value this file can just state directly, with the precedent recorded
 * here instead of in an import graph.
 */
export const ELECTION_PREVIEW_BUDGET = 30;

/**
 * Ticket 16 scope addition (peer review finding P2): the console's own
 * `pageBudget`/`turn` params were weaker than the shared public contract
 * (`mcp/definitions.ts`'s `recallInputShape`/`timelineInputShape` — positive,
 * capped) — page=0/pageBudget=0/turn=0 all parsed, and neither ceiling was
 * enforced at all. Redeclared as local literals rather than imported, same
 * reasoning as `ELECTION_PREVIEW_BUDGET` above (mirrors `MAX_PAGE_BUDGET`
 * (25,000) / `MAX_TURN_BUDGET` (5,000) in `mcp/definitions.ts` verbatim).
 */
export const CONSOLE_MAX_PAGE_BUDGET = 25_000;
export const CONSOLE_MAX_TURN_BUDGET = 5_000;

// ---------------------------------------------------------------- shapes ---

export interface ConsoleAppliedBound {
  bound: string;
  requested: number;
  applied: number;
}

export interface ConsoleMeta {
  scope: unknown;
  counts: { turns: number; edges: number; lanes: number };
  asOf: string;
  workerBuildId: string;
  stateCoverage: "full" | "partial";
  appliedBounds: ConsoleAppliedBound[];
  /**
   * Ticket R2 #11: election tiers (`ConsoleGraphTurn.electionTier`) are
   * computed by `electMilestones` over the FULL projection (`run.turns`/
   * `run.edges`), strictly BEFORE any post-load turn/edge trimming — a
   * visible turn's tier can be granted by a hidden (trimmed-out) turn or
   * edge the response itself never ships. This field names that fact
   * explicitly rather than leaving it implicit: always `"full-snapshot"`
   * today (there is no other election scope this worker computes yet).
   * Constant across every route, including the three that carry no
   * election tiers at all (sessions/segments/segment) — one uniform field
   * on the shared `ConsoleMeta` shape is simpler than a graph-route-only
   * one, and cheap since it never varies.
   */
  electionCoverage: "full-snapshot";
  /**
   * Ticket 04 (graph-byte-priority, T1498 ruling): the turn-id interval this
   * graph response actually renders — `null` on the three non-graph routes
   * (sessions/segments/segment; same "one uniform field, cheap since it
   * never varies" posture as `electionCoverage` above) and on a graph
   * response carrying zero turns (nothing to bound). Populated on every
   * other graph response, WHETHER OR NOT the interval selector had to
   * narrow anything — `isOldest`/`isNewest` are what the range bar (the
   * shell) reads to decide whether "较早"/"最新" navigation is even
   * possible, not `stateCoverage` alone (a `stateCoverage: "partial"` graph
   * response can still be `isOldest: true` — e.g. the user has paged all
   * the way back to the earliest turn a segment's own widened lane
   * structure ever touched).
   */
  interval: ConsoleGraphInterval | null;
}

export interface ConsoleApiResult {
  status: number;
  body: unknown;
}

export interface ConsoleRequestContext {
  buildId: string;
  nowMs: () => number;
}

export interface ConsoleGraphTurn {
  id: number;
  sessionId: number;
  promptNumber: number;
  /**
   * The address every console surface renders for this turn — server-formatted
   * once here so the shell never assembles one (T1524 ruling, superseded by
   * [S15069/T1557] — ticket 10 "one address grammar"). ALWAYS
   * `S<sessionId>/T<promptNumber>`, under every scope including segment: a
   * turn has exactly one address, and a segment is a SCOPE in front of it
   * (`meta.scope`'s own `E<segmentId>`), never a second address namespace.
   * Retires the segment-scoped `E<segmentId>/T<k>` this field used to carry
   * under two prior, now-superseded rulings — a roster ordinal (T1524) and
   * then the turn's own global id (T1532) — both of which made the address
   * mean something different depending on where a reader pasted it.
   */
  address: string;
  title: string | null;
  promptExcerpt: string;
  contentExcerpt: string;
  /** `electMilestones`' per-turn tier over this same projection (`ELECTION_PREVIEW_BUDGET`); `null` for a turn that left candidacy entirely (excluded, not merely low-ranked). */
  electionTier: number | null;
  /** `LaneTurnInput.type` verbatim — already present on `run.turns`, no extra load. */
  type: readonly string[];
  /**
   * The turn's RAW stored `tags` ([S15069/T1696]) — every word in the column,
   * NOT `laneMemberships`' resolved lane set. The two answer different
   * questions and the panel shows both: `laneMemberships` is what the model
   * recognises, `tags` is what the turn actually carries. On the live segment
   * the gap is most of the data — 1798 member turns, 682 with a declared lane
   * — so a panel showing only the resolved set has nothing at all to display
   * for the majority, and the legacy vocabulary those turns still carry
   * (`observation-pipeline`, `rubric`, `rolled-back`, …) is invisible exactly
   * where a reader is deciding which lane the turn belongs in.
   */
  tags: readonly string[];
  /**
   * PER-LANE membership, replacing ticket 04's turn-scoped `lanes: string[]`.
   *
   * One entry per lane this turn is a MEMBER of, each naming that lane's
   * `token` (see `ConsoleGraphLane.token`) and the component it falls in —
   * `[]` for a laneless turn, never omitted (contract's own "empty lists = []"
   * rule).
   *
   * BOTH of this entry's booleans are now gone. Ticket 04 removed the
   * per-turn, per-lane node-death flag (node death does not exist in v12);
   * lane-state-retirement ticket 01 removed `isTerminus` (a lane has no
   * terminus). The console must not publish either under any name.
   */
  laneMemberships: readonly ConsoleTurnLaneMembership[];
}

/**
 * One turn's membership in ONE lane — see `ConsoleGraphTurn.laneMemberships`.
 *
 * lane-state-retirement ticket 01 removed this entry's `isTerminus` boolean.
 * It published "this turn is THE terminus of that lane", a latest-wins seat
 * the model no longer computes; the shell's `◎` ring and per-lane chip mark
 * went with it rather than being re-pointed at some other fact.
 */
export interface ConsoleTurnLaneMembership {
  /** This lane's own `token` (`ConsoleGraphLane.token`) — never re-derived client-side. */
  token: string;
  /**
   * Which of THIS lane's connected components this turn falls in
   * ([S15069/T1696] ruling) — `${token}#${island.representative}`, built from
   * report 2's own island, whose representative is already the smallest
   * member id in it. The token prefix is what keeps the id single-lane by
   * construction: two lanes can never name the same component even when their
   * islands share a representative turn, which is exactly the case a turn
   * belonging to several lanes creates.
   *
   * A turn in two lanes therefore carries two memberships with two component
   * ids, and focusing it lights both — one component per lane, never a merged
   * one. An isolated member (no edge carries this lane's tag on both sides at
   * it) is its own island, so this field is never absent for a member.
   */
  componentId: string;
}

export interface ConsoleGraphEdge {
  citingId: number;
  citedId: number;
  relation: string;
  /**
   * lane-model-v12 ticket 07 (spec D1): the arc's TWO ENDS, one lane tag
   * each, REPLACING the single merged `tags: string[]` this field used to
   * publish. `tailTag` is the CITING side (which lane the reference comes
   * FROM), `headTag` the CITED side (which lane it points AT); `""` on a
   * side is the UNSETTLED sentinel — no one has attributed that end yet —
   * never a lane whose tag is the empty string.
   *
   * This is the ONE deliberate payload change in ticket 07, and the reason
   * the merged set had to go: a CROSS-LANE edge (`tailTag !== headTag`, both
   * settled) is a crossing between two NAMED lanes, and the old single set
   * had no way to say which end named which — `{a,b}` could equally have
   * meant "this edge is in lane a and lane b at once" (the v11 merge
   * reading). Every other console field is a byte-for-byte source swap.
   */
  tailTag: string;
  headTag: string;
  /**
   * Each side's own lane token (`ConsoleGraphLane.token`), or `null` when
   * that side is unsettled — the plural `laneTokens: string[]` this replaces
   * could only ever carry ONE segment (the citing turn's) for every tag on
   * the edge, which is wrong for the head end of a cross-segment edge.
   *
   * A lane's identity is `(segment, tag)`, so each side resolves in its OWN
   * endpoint's segment: `tailLaneToken` in the CITING turn's, `headLaneToken`
   * in the CITED turn's. For the overwhelmingly common same-segment,
   * same-lane edge the two are the identical string, which is exactly the
   * single token the old field published.
   */
  tailLaneToken: string | null;
  headLaneToken: string | null;
}

/**
 * A lane in the console's graph payload: its identity, how many members it
 * has, the phases those members carry, and how many connected components they
 * fall into. NO STATE — lane-state-retirement ticket 01.
 *
 * WHAT LEFT THIS CONTRACT, and why nothing replaced it. Three fields went
 * together: `state` (the corrected `closed`/`open` verdict plus the terminus
 * and its address), and the RAW pair `declarationState`/`declarationTerminus`
 * beside it. They existed because the two answered different questions — "what
 * should the UI call this lane" versus "what does the raw reduction say" — and
 * a lane that kept living past its own declaration was the case that forced
 * both onto the wire. The model now answers NEITHER question: `closed`/`open`
 * cannot be told apart from inside a bounded window, and the single per-lane
 * terminus was a latest-wins seat that a lane converging several times never
 * had. A console that kept publishing any of the three would keep teaching the
 * retired model, exactly as ticket 04 said of the two fields it deleted.
 *
 * `componentCount` ([S15069/T1696] ruling): how many connected components
 * this lane's own members fall into — `LaneCheckerResult.components`' own
 * `componentCount`, republished, never recomputed. Healthy is 1; a larger
 * number is the lane saying its members are not yet joined by edges.
 *
 * REPLACES `membershipComponentId`, a SECOND connectivity notion this file
 * used to compute for itself: lanes unioned by sharing a member turn. The
 * user's ruling makes connectivity mean exactly one thing — two member turns
 * are connected when an edge between them carries THIS lane's tag on BOTH
 * sides — and that is report 2's domain, computed per lane over turn nodes.
 * Under it a component belongs to exactly one lane by construction (the node
 * set never leaves the lane), and one lane may hold several. The old domain
 * inverted both halves of that: it made one component span many lanes (76
 * lanes collapsed into 25 groups on the live segment, the largest holding 43)
 * and could not express a lane split across several. Nothing derives lane-to-
 * lane connectivity any more; a turn in two lanes simply carries two
 * memberships, each with its own component.
 */
export interface ConsoleGraphLane {
  segment: string;
  /** D5, v11: a lane's identity is one tag, not a set — this field carries that one tag (never an array; `LaneKey.tag`'s own console mirror). */
  tag: string;
  /** lane-model-v12 ticket 04: TWO fields left this contract — a closed lane's quality verdict and an open lane's most-recent-declarer seat. Neither concept exists in v12, and a console that kept publishing them would keep teaching the retired model. */
  memberCount: number;
  phases: string[];
  componentCount: number;
  /**
   * Ticket 04 additive field: this lane's own stable identity key —
   * `laneToken(segment, tag)`, the same value already computed internally
   * (`tokenFor`), shipped verbatim so the shell can build its `laneByToken`
   * map directly from the payload instead of recomputing the token
   * client-side (spec: "the shell renders; it derives nothing").
   */
  token: string;
}

/**
 * Ticket 04 (graph-byte-priority): the interval selector's own render unit —
 * a contiguous (in id-sorted order) slice of a graph response's `turns`,
 * named by both its raw `turns.id` boundary (what the client sends back as
 * the next `interval` query param, T1498 ruling's own round-trip) and its
 * reader-facing "S<n>/T<m>" address (what the range bar actually prints —
 * floor-and-render-fidelity ticket 03's own address-form convention, S15069/
 * T1482). `isOldest`/`isNewest` compare against the FULL projection's own
 * boundary turns (computed once per request, BEFORE the `interval` query
 * param's own ceiling is applied AND before either post-load count cap —
 * ticket 03, peer P1-3/P2-7: the caps used to run first and could hide the
 * true newest turn from ever being reachable, which is exactly what this
 * comparison must not do) — so a response that is `isOldest: true` really
 * has nothing older left to page to, never merely "nothing older within
 * THIS request's own ceiling". A `WIDEN_NODE_MAX` post-cap can still flip a
 * PREVIOUSLY-true `isOldest` back to `false` on the same response (see
 * `applyPostIntervalCountBounds`) — it never touches `isNewest`, since it
 * only ever trims from the OLD end.
 */
export interface ConsoleGraphInterval {
  fromTurnId: number;
  toTurnId: number;
  fromAddress: string;
  toAddress: string;
  isOldest: boolean;
  isNewest: boolean;
}

// --------------------------------------------------------------- helpers ---

function errorResult(status: number, code: string, message: string): ConsoleApiResult {
  return { status, body: { error: { code, message } } };
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** Code-point excerpt, never `.slice()` — a UTF-16 code-unit slice cuts mid-surrogate-pair on CJK (ticket 01's own methodology note). */
function codePointExcerpt(text: string | null, maxCodePoints: number): string {
  if (!text) {
    return "";
  }
  const codePoints = [...text];
  return codePoints.length <= maxCodePoints ? text : codePoints.slice(0, maxCodePoints).join("");
}

type ParsedIntParam =
  | { ok: true; value: number | undefined }
  | { ok: false };

/**
 * Absent -> `{ ok: true, value: undefined }`; present, a non-negative
 * integer, and (when `bounds` names one) inside `[min, max]` -> `{ ok: true,
 * value }`; anything else (non-digits, too large to be a safe integer, or
 * out of `bounds`) -> `{ ok: false }`, the route's own signal to 400.
 * `bounds` defaults to open (every EXISTING caller — `limit`/`id`/`session`/
 * `segment`/`from`/`to`/`interval` — keeps today's non-negative-only check,
 * unchanged); recall/timeline's `page`/`pageBudget`/`turn` are the two
 * callers that now pass one (ticket 16 scope addition, peer review finding
 * P2: these three used to accept 0 and had no ceiling at all, weaker than
 * the shared public contract's own `.positive().max(...)`).
 */
function parseOptionalIntParam(
  url: URL,
  name: string,
  bounds: { min?: number; max?: number } = {},
): ParsedIntParam {
  const raw = url.searchParams.get(name);
  if (raw === null) {
    return { ok: true, value: undefined };
  }
  if (!/^\d+$/.test(raw)) {
    return { ok: false };
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    return { ok: false };
  }
  if (bounds.min !== undefined && value < bounds.min) {
    return { ok: false };
  }
  if (bounds.max !== undefined && value > bounds.max) {
    return { ok: false };
  }
  return { ok: true, value };
}

function buildMeta(input: {
  scope: unknown;
  counts: { turns: number; edges: number; lanes: number };
  asOf: string;
  ctx: ConsoleRequestContext;
  stateCoverage: "full" | "partial";
  appliedBounds: ConsoleAppliedBound[];
  interval: ConsoleGraphInterval | null;
}): ConsoleMeta {
  return {
    scope: input.scope,
    counts: input.counts,
    asOf: input.asOf,
    workerBuildId: input.ctx.buildId,
    stateCoverage: input.stateCoverage,
    appliedBounds: input.appliedBounds,
    electionCoverage: "full-snapshot",
    interval: input.interval,
  };
}

/**
 * The turn's own rendered address — `ConsoleGraphTurn.address`, decided once
 * at projection time (in `handleGraphRoute`, below) so the interval label and
 * the row it points at can never disagree about what a turn is called. The
 * `S<sessionId>/T<promptNumber>` fallback stands only for a turn built without
 * that field (floor-and-render-fidelity ticket 03's original form).
 *
 * ONE address grammar under every scope ([S15069/T1557] — ticket 10): the
 * segment-scoped `E<segmentId>/T<k>` this used to read under a `segment`
 * scope is retired, along with the per-segment computation that produced it
 * (formerly `graphAddressesFor`, T1524/T1532). A segment is a SCOPE, named
 * separately by `meta.scope`'s own `E<segmentId>`, never folded into a
 * turn's own address.
 */
function turnAddress(turn: ConsoleGraphTurn): string {
  return turn.address || `S${turn.sessionId}/T${turn.promptNumber}`;
}

// ------------------------------------------------------------- sessions ----

export function handleSessionsRoute(
  reader: ConsoleReader,
  url: URL,
  ctx: ConsoleRequestContext,
): ConsoleApiResult {
  const limitParam = parseOptionalIntParam(url, "limit");
  if (!limitParam.ok || limitParam.value === 0) {
    return errorResult(400, "bad_request", "limit must be a positive integer");
  }
  const requestedLimit = limitParam.value ?? SESSIONS_PAGE_MAX;
  const appliedBounds: ConsoleAppliedBound[] = [];
  let limit = requestedLimit;
  if (requestedLimit > SESSIONS_PAGE_MAX) {
    appliedBounds.push({ bound: "SESSIONS_PAGE_MAX", requested: requestedLimit, applied: SESSIONS_PAGE_MAX });
    limit = SESSIONS_PAGE_MAX;
  }

  const cursorRaw = url.searchParams.get("cursor");
  let cursor: { epoch: number; id: number } | null = null;
  if (cursorRaw !== null) {
    const parsed = parseSessionsCursor(cursorRaw);
    if (!parsed) {
      return errorResult(400, "bad_request", "cursor is malformed");
    }
    cursor = parsed;
  }

  const page = reader.listSessionsPage({ cursor, limit });

  return {
    status: 200,
    body: {
      sessions: page.sessions,
      ...(page.nextCursor !== null ? { nextCursor: page.nextCursor } : {}),
      meta: buildMeta({
        scope: { kind: "sessions", cursor: cursorRaw, limit },
        counts: { turns: 0, edges: 0, lanes: 0 },
        asOf: new Date(ctx.nowMs()).toISOString(),
        ctx,
        stateCoverage: "full",
        appliedBounds,
        interval: null,
      }),
    },
  };
}

// ------------------------------------------------------------- segments ----

export function handleSegmentsRoute(
  reader: ConsoleReader,
  _url: URL,
  ctx: ConsoleRequestContext,
): ConsoleApiResult {
  const segments = reader.listAllSegmentCards();
  return {
    status: 200,
    body: {
      segments,
      meta: buildMeta({
        scope: { kind: "segments" },
        counts: { turns: 0, edges: 0, lanes: 0 },
        asOf: new Date(ctx.nowMs()).toISOString(),
        ctx,
        stateCoverage: "full",
        appliedBounds: [],
        interval: null,
      }),
    },
  };
}

// ---------------------------------------------------------- segment card ---

export function handleSegmentCardRoute(
  reader: ConsoleReader,
  url: URL,
  ctx: ConsoleRequestContext,
): ConsoleApiResult {
  const idParam = parseOptionalIntParam(url, "id");
  if (!idParam.ok || idParam.value === undefined) {
    return errorResult(400, "bad_request", "id is required and must be a positive integer");
  }
  const detail = reader.getSegmentCardDetail(idParam.value);
  if (!detail) {
    return errorResult(404, "not_found", `no segment ${idParam.value}`);
  }

  return {
    status: 200,
    body: {
      card: detail.segment,
      members: detail.memberAddresses,
      meta: buildMeta({
        scope: { kind: "segment", segmentId: idParam.value },
        // Not zero-filled like sessions/segments above: a segment card's own
        // `members` ARE turns, so `counts.turns` reporting how many is the
        // literal, non-fabricated reading of the field for this route.
        counts: { turns: detail.memberAddresses.length, edges: 0, lanes: 0 },
        asOf: new Date(ctx.nowMs()).toISOString(),
        ctx,
        stateCoverage: "full",
        appliedBounds: [],
        interval: null,
      }),
    },
  };
}

// ---------------------------------------------------------- recall/timeline

/**
 * `{type, tag, session, time, file}` from query params — the structured
 * filter grammar `recall`/`timeline` share (`MemoryFilterInput`,
 * `mcp/memory-filter.ts`), named here only STRUCTURALLY: this module imports
 * nothing from `src/mcp/` (the same "handlers touch storage ONLY through
 * `ConsoleReader`" posture the module header states, and the same reasoning
 * `ELECTION_PREVIEW_BUDGET`'s own doc gives for not importing a constant
 * across that boundary) — the object literal below is checked against
 * `ConsoleRecallInput["filter"]`/`ConsoleTimelineInput["filter"]` purely by
 * shape at the call site. `undefined` when the request names none of the
 * five fields, so a plain recall/timeline call passes no `filter` at all
 * (matching every existing MCP caller's own "omit what you don't need").
 *
 * `filter.fields` (per-turn render-field selection) is deliberately NOT
 * exposed as a query param — this ticket's territory is the demo LOOK, and a
 * field-selection control is exactly the "speculative chrome" the ticket
 * asks this surface to skip.
 */
function parseFilterParams(url: URL): {
  type?: string;
  tag?: string;
  session?: string;
  time?: string;
  file?: string;
} | undefined {
  const type = url.searchParams.get("type") ?? undefined;
  const tag = url.searchParams.get("tag") ?? undefined;
  const session = url.searchParams.get("session") ?? undefined;
  const time = url.searchParams.get("time") ?? undefined;
  const file = url.searchParams.get("file") ?? undefined;
  if (
    type === undefined &&
    tag === undefined &&
    session === undefined &&
    time === undefined &&
    file === undefined
  ) {
    return undefined;
  }
  return { type, tag, session, time, file };
}

/**
 * `GET /api/console/recall` — a thin adapter over
 * `ConsoleReader.runRecallOutcome`, itself a thin (read-only-by-construction
 * — see `ConsoleRecallInput`'s own doc) wrapper over the SAME `recallMemory`
 * the `recall` MCP tool calls.
 *
 * Ticket 13 (spec item 1): params map from the query string — `query`, `id`,
 * `page`, `pageBudget`, `turn`, plus the structured filter fields
 * (`parseFilterParams`). `pageSize` is deliberately NOT exposed: the
 * ticket's own pagination item names exactly "the functions' own
 * page/pageBudget params" as what a pagination control maps to, and adding
 * an un-requested third knob here would be the same speculative-chrome the
 * styling item warns against. `eraCutoffEpoch` and `readerId`/`now` are not
 * reachable from this route at all — the last two cannot be (see
 * `ConsoleRecallInput`), and the first is an internal era-gating knob no
 * console caller has a reason to set.
 *
 * Ticket 16 scope addition (peer review finding P2): this used to return 200
 * with prose error text for a garbage `id` or a filter/parameter mistake —
 * `runRecallOutcome`'s TYPED result (`mcp/query-outcome.ts`) is what now
 * drives a real 400/404, never a string match on the rendered text. The same
 * finding also flagged `page`/`pageBudget`/`turn` as weaker than the shared
 * public contract (accepted 0, no ceiling) — they now share that contract's
 * own bounds (`CONSOLE_MAX_PAGE_BUDGET`/`CONSOLE_MAX_TURN_BUDGET` above,
 * mirroring `mcp/definitions.ts`'s `MAX_PAGE_BUDGET`/`MAX_TURN_BUDGET`).
 */
export function handleRecallRoute(
  reader: ConsoleReader,
  url: URL,
  ctx: ConsoleRequestContext,
): ConsoleApiResult {
  const pageParam = parseOptionalIntParam(url, "page", { min: 1 });
  const pageBudgetParam = parseOptionalIntParam(url, "pageBudget", {
    min: 1,
    max: CONSOLE_MAX_PAGE_BUDGET,
  });
  const turnParam = parseOptionalIntParam(url, "turn", { min: 1, max: CONSOLE_MAX_TURN_BUDGET });
  if (!pageParam.ok || !pageBudgetParam.ok || !turnParam.ok) {
    return errorResult(
      400,
      "bad_request",
      `page must be a positive integer; pageBudget must be 1..${CONSOLE_MAX_PAGE_BUDGET}; turn must be 1..${CONSOLE_MAX_TURN_BUDGET}`,
    );
  }

  const id = url.searchParams.get("id") ?? undefined;
  const query = url.searchParams.get("query") ?? undefined;
  const filter = parseFilterParams(url);

  const input: ConsoleRecallInput = {
    id,
    query,
    filter,
    page: pageParam.value,
    pageBudget: pageBudgetParam.value,
    turn: turnParam.value,
  };
  const outcome = reader.runRecallOutcome(input);
  const scope = { kind: "recall", id: id ?? null, query: query ?? null, filter: filter ?? null };

  if (outcome.status !== 200) {
    return errorResult(
      outcome.status,
      outcome.status === 400 ? "bad_request" : "not_found",
      outcome.message,
    );
  }

  return {
    status: 200,
    body: {
      text: outcome.text,
      meta: buildMeta({
        scope,
        counts: { turns: 0, edges: 0, lanes: 0 },
        asOf: new Date(ctx.nowMs()).toISOString(),
        ctx,
        stateCoverage: "full",
        appliedBounds: [],
        interval: null,
      }),
    },
  };
}

const TIMELINE_VIEWS = new Set(["turns", "milestones", "lane"]);

/**
 * `GET /api/console/timeline` — a thin adapter over
 * `ConsoleReader.runTimelineOutcome`, the same render-only wrapper posture as
 * `handleRecallRoute` above, over the SAME `timelineQuery` the `timeline`
 * MCP tool calls.
 *
 * `id` is REQUIRED (`TimelineInput.id` itself is non-optional) — 400 when
 * absent, the same discipline `handleSegmentCardRoute`'s own `id` check
 * already follows. `view` is accepted (`"turns"`/`"milestones"`/`"lane"`)
 * beyond the ticket's own literal param list — the ticket's shell item asks
 * for "a timeline pane reachable from a session/lane context", and a lane
 * context IS `view` routing to the segment's lane list
 * (`timelineQuery`'s own `E<n>/L*`/`view:"lane"` handling) — there is no
 * other way to reach it from this route's params.
 *
 * Ticket 16 scope addition (peer review finding P2): this used to return 200
 * with prose error text ("timeline error: ...") for an unrecognized id or a
 * missing target alike — `runTimelineOutcome`'s TYPED result
 * (`mcp/query-outcome.ts`) now drives a real 400/404. `page`/`pageBudget`
 * share the shared public contract's own bounds, same fix as
 * `handleRecallRoute` above.
 */
export function handleTimelineRoute(
  reader: ConsoleReader,
  url: URL,
  ctx: ConsoleRequestContext,
): ConsoleApiResult {
  const id = url.searchParams.get("id");
  if (!id) {
    return errorResult(400, "bad_request", "id is required");
  }

  const pageParam = parseOptionalIntParam(url, "page", { min: 1 });
  const pageBudgetParam = parseOptionalIntParam(url, "pageBudget", {
    min: 1,
    max: CONSOLE_MAX_PAGE_BUDGET,
  });
  if (!pageParam.ok || !pageBudgetParam.ok) {
    return errorResult(
      400,
      "bad_request",
      `page must be a positive integer; pageBudget must be 1..${CONSOLE_MAX_PAGE_BUDGET}`,
    );
  }

  const rawView = url.searchParams.get("view");
  if (rawView !== null && !TIMELINE_VIEWS.has(rawView)) {
    return errorResult(400, "bad_request", `view must be one of: ${[...TIMELINE_VIEWS].join(", ")}`);
  }
  // `null` (param absent) becomes `undefined`, never carried through as
  // `null` — `TimelineInput.view` is `TimelineViewKind | "lane" | undefined`,
  // and a literal `null` would not match that type at runtime even though a
  // careless `as` cast could paper over it at compile time.
  const view = rawView === null ? undefined : (rawView as "turns" | "milestones" | "lane");

  const filter = parseFilterParams(url);

  const input: ConsoleTimelineInput = {
    id,
    view,
    page: pageParam.value,
    pageBudget: pageBudgetParam.value,
    filter,
  };
  const outcome = reader.runTimelineOutcome(input);
  const scope = { kind: "timeline", id, view: rawView ?? null, filter: filter ?? null };

  if (outcome.status !== 200) {
    return errorResult(
      outcome.status,
      outcome.status === 400 ? "bad_request" : "not_found",
      outcome.message,
    );
  }

  return {
    status: 200,
    body: {
      text: outcome.text,
      meta: buildMeta({
        scope,
        counts: { turns: 0, edges: 0, lanes: 0 },
        asOf: new Date(ctx.nowMs()).toISOString(),
        ctx,
        stateCoverage: "full",
        appliedBounds: [],
        interval: null,
      }),
    },
  };
}

// ------------------------------------------------------------------ graph --

/** Segment + tag (D5, v11) — the same token `shared/lane-interpretation.ts`'s own `laneToken` computes, re-derived here only for the union-find key (that function is already imported for the payload's own use). */
function tokenFor(lane: Pick<LaneStatsReport, "key">): string {
  return laneToken(lane.key.segment, lane.key.tag);
}

/**
 * Report 2's per-lane islands, indexed for the payload ([S15069/T1696]) —
 * `Map<laneToken, Map<turnId, componentId>>`.
 *
 * This function COMPUTES NOTHING. Connectivity has one definition and
 * `shared/lane-checker.ts` already applies it (a lane's own members, joined by
 * the edges carrying that lane's tag on both sides); republishing its islands
 * is the whole job. A second traversal here is exactly the drift the retired
 * `membershipComponentId` was — see `ConsoleGraphLane.componentCount`.
 */
function indexLaneComponentIds(
  components: readonly LaneComponentReport[],
): Map<string, Map<number, string>> {
  const byToken = new Map<string, Map<number, string>>();
  for (const report of components) {
    const token = laneToken(report.key.segment, report.key.tag);
    const byTurnId = new Map<number, string>();
    for (const island of report.islands) {
      // Token-prefixed, so a component id names ONE lane even when two lanes'
      // islands share a representative turn — the case a turn belonging to
      // several lanes creates, and the one the focus model now depends on.
      const componentId = `${token}#${island.representative}`;
      for (const memberId of island.memberIds) {
        byTurnId.set(memberId, componentId);
      }
    }
    byToken.set(token, byTurnId);
  }
  return byToken;
}

/**
 * The per-turn, PER-LANE membership fact the shell renders
 * (`ConsoleGraphTurn.laneMemberships` — see that field's own doc) computed
 * ONCE from `run.result.lanes`, the SAME single projection (spec "One
 * projection") `indexLaneComponentIds` already reads. Deliberately
 * over the FULL (untruncated) lane set, mirroring that function: a turn's own
 * lane membership and terminus standing is a fact about the lane structure,
 * independent of which OTHER turns a later post-load bound happens to
 * truncate out of the response.
 *
 * Each lane contributes its OWN entry (the ticket-04 bug this replaces OR'd a
 * per-turn terminus flag across every lane at once; ticket 01 deleted the flag
 * outright, so there is nothing left to collapse).
 *
 * `componentIdsByToken` is report 2's index. The `?? ` fallback below covers
 * exactly one shape: a lane the components report did not describe at all, in
 * which case every member stands alone and its own id IS its island's
 * representative — the same string report 2 would have produced. It is a
 * fallback, never a second definition.
 */
function computePerTurnLaneMemberships(
  lanes: readonly LaneStatsReport[],
  componentIdsByToken: Map<string, Map<number, string>>,
): Map<number, ConsoleTurnLaneMembership[]> {
  const byTurnId = new Map<number, ConsoleTurnLaneMembership[]>();
  for (const lane of lanes) {
    const token = tokenFor(lane);
    const componentIds = componentIdsByToken.get(token);
    for (const member of lane.members) {
      const entry: ConsoleTurnLaneMembership = {
        token,
        componentId: componentIds?.get(member.id) ?? `${token}#${member.id}`,
      };
      const bucket = byTurnId.get(member.id);
      if (bucket) {
        bucket.push(entry);
      } else {
        byTurnId.set(member.id, [entry]);
      }
    }
  }
  return byTurnId;
}

function sortTurnsById(turns: readonly LaneTurnInput[]): LaneTurnInput[] {
  return [...turns].sort((a, b) => a.id - b.id);
}

/** Same `(citingId, citedId, relation)` order `db/lane-checker-load.ts` already sorts its own output by — kept identical here so the "stable prefix" truncation below cuts the SAME prefix a caller reading `loadLaneCheckScope` directly would see. */
function sortEdgesForDisplay<
  T extends { citingId: number; citedId: number; relation: string },
>(edges: readonly T[]): T[] {
  return [...edges].sort((a, b) => {
    if (a.citingId !== b.citingId) return a.citingId - b.citingId;
    if (a.citedId !== b.citedId) return a.citedId - b.citedId;
    return a.relation.localeCompare(b.relation);
  });
}

interface GraphScopeResolution {
  scope: LaneCheckScope;
  scopeDescriptor: Record<string, unknown>;
}

/** Resolves `session`+`from`/`to` XOR `segment` into a `LaneCheckScope`, applying the default window and the `GRAPH_WINDOW_MAX` pre-load clamp. Returns an error result directly on any 400/404; the caller checks `"error" in result`. */
function resolveGraphScope(
  reader: ConsoleReader,
  url: URL,
  appliedBounds: ConsoleAppliedBound[],
): GraphScopeResolution | { error: ConsoleApiResult } {
  const sessionParam = parseOptionalIntParam(url, "session");
  const segmentParam = parseOptionalIntParam(url, "segment");
  if (!sessionParam.ok || !segmentParam.ok) {
    return { error: errorResult(400, "bad_request", "session and segment must be positive integers") };
  }
  const hasSession = sessionParam.value !== undefined;
  const hasSegment = segmentParam.value !== undefined;
  if (hasSession === hasSegment) {
    return {
      error: errorResult(
        400,
        "bad_request",
        hasSession
          ? "session and segment are mutually exclusive"
          : "exactly one of session or segment is required",
      ),
    };
  }

  if (hasSegment) {
    const segmentId = segmentParam.value!;
    const segment = reader.findSegment(segmentId);
    if (!segment) {
      return { error: errorResult(404, "not_found", `no segment ${segmentId}`) };
    }
    return {
      scope: { kind: "segment", segmentId },
      scopeDescriptor: { kind: "segment", segmentId },
    };
  }

  const sessionId = sessionParam.value!;
  const session = reader.findSession(sessionId);
  if (!session) {
    return { error: errorResult(404, "not_found", `no session ${sessionId}`) };
  }

  const fromParam = parseOptionalIntParam(url, "from");
  const toParam = parseOptionalIntParam(url, "to");
  if (!fromParam.ok || !toParam.ok) {
    return { error: errorResult(400, "bad_request", "from and to must be positive integers") };
  }
  if (
    fromParam.value !== undefined &&
    toParam.value !== undefined &&
    fromParam.value > toParam.value
  ) {
    return { error: errorResult(400, "bad_request", "from must not be greater than to") };
  }

  // Lazy: only asked when a default actually needs it — a request that
  // states BOTH `from` and `to` explicitly costs no `getSessionMaxPromptNumber`
  // round trip at all.
  const maxPromptNumber = () => reader.getSessionMaxPromptNumber(sessionId) ?? 0;
  let to = toParam.value ?? maxPromptNumber();
  let from = fromParam.value ?? Math.max(1, to - GRAPH_WINDOW_DEFAULT + 1);
  // Only reachable via auto-defaulting on a turn-less (or very short)
  // session — an explicit user-supplied inversion already 400'd above.
  if (from > to) {
    from = to;
  }

  const requestedWidth = to - from + 1;
  if (requestedWidth > GRAPH_WINDOW_MAX) {
    appliedBounds.push({ bound: "GRAPH_WINDOW_MAX", requested: requestedWidth, applied: GRAPH_WINDOW_MAX });
    from = to - GRAPH_WINDOW_MAX + 1;
  }

  return {
    scope: { kind: "range", sessionId, promptStart: from, promptEnd: to },
    scopeDescriptor: { kind: "range", sessionId, from, to },
  };
}

/**
 * Measures the bytes of the REAL envelope this route ships for a given
 * (turns, edges) pair — `{turns, edges, lanes, laneCheckText, meta}`, meta
 * included. Ticket R2 #2: the reviewer's repro measured a cheaper stand-in
 * (`{turns, edges, lanes, laneCheckText}` alone, no `meta`) that read
 * 999,797 bytes internally while the real wire response — `meta` appended
 * AFTER that measurement — was 1,000,001 bytes. This helper is the one place
 * that measures what actually goes over the wire, so that gap cannot recur.
 */
function envelopeBytes(
  turns: ConsoleGraphTurn[],
  edges: ConsoleGraphEdge[],
  lanes: ConsoleGraphLane[],
  laneCheckText: string,
  meta: ConsoleMeta,
): number {
  return byteLength(JSON.stringify({ turns, edges, lanes, laneCheckText, meta }));
}

/**
 * Ticket 04 (graph-byte-priority, T1496/T1498 rulings): the interval
 * selector. REPLACES the old `applyGraphByteBound` drop-edges-then-turns
 * loop — that mechanism is RETIRED; this is its one, unified successor.
 * `turns`/`edges` are the FULL projection, display-loaded, sorted ascending
 * by id — ticket 03 (peer P1-3/P2-7): NEITHER `WIDEN_NODE_MAX` nor
 * `GRAPH_EDGE_MAX` has run yet at this point. Those two caps used to trim a
 * stable OLDEST-first prefix of the full projection BEFORE this selector
 * ever saw it, which (a) could silently remove an edge whose both endpoints
 * this selector would otherwise have kept inside its own chosen interval,
 * and (b) made every turn past the cap permanently unreachable by any
 * interval, including the newest ones a "show me the latest" console exists
 * to surface. This selector now always walks the true full index; the two
 * count caps apply AFTER it resolves, to its OWN output —
 * `applyPostIntervalCountBounds`, below.
 *
 * `intervalCeilingId` is the `interval` query param — every turn with `id >
 * intervalCeilingId` is excluded from candidacy before anything else runs.
 * `null` (the param absent) means no ceiling: candidacy is the newest turn
 * in the whole projection. This is how "requesting an older interval"
 * round-trips (T1498 ruling): the client re-issues the identical request
 * with `interval` set to one less than the earliest turn id its OWN last
 * response returned (`ConsoleGraphInterval.fromTurnId - 1`), and the walk
 * below reconstructs the immediately-older budget-filling interval from
 * that ceiling — the SAME algorithm, SAME budget, every time ("every
 * request is budget-guarded the same way").
 *
 * FAST PATH: does the entire ceiling-eligible set already fit
 * `RESPONSE_BYTE_SOFT_MAX`? If so, return it whole — segment-60's own shape
 * at the raised caps ("Today's whole-segment scope renders complete with
 * zero narrowing").
 *
 * WALK (only reached when it does not): newest eligible turn first,
 * backward, one turn at a time. Each turn is added ATOMICALLY WITH its own
 * induced edges — every edge among `edges` whose OTHER endpoint has already
 * joined the walk (walking strictly newest-to-oldest, an edge's other
 * endpoint, if it is ever included at all, was necessarily visited in an
 * EARLIER, newer step) — never a turn without its edges, never an edge
 * before both its endpoints. The walk stops the INSTANT the next atomic
 * addition would push the envelope over budget; the interval boundary is
 * exactly the last turn that DID fit. Because every edge is only ever added
 * in the same step as whichever endpoint is added SECOND, the endpoint-
 * closure invariant (every returned edge's both endpoints are among the
 * returned turns — the old ticket R2 #3 property) holds BY CONSTRUCTION
 * here, with no separate post-filter pass required (a WIDEN_NODE_MAX-
 * trimmed turn's own dangling edge, still present in `edges`, can never
 * find its missing endpoint "already included" — that endpoint is never
 * even a walk candidate).
 *
 * UNFITTABLE (ticket 04: "the unfittable refusal envelope survives only for
 * the degenerate case an interval of one turn still overflows") falls out
 * of the SAME loop with no separate check: if even the single newest
 * eligible turn cannot be added without exceeding budget, the walk's first
 * iteration rejects it and `included` stays empty — the caller (`
 * handleGraphRoute`) reads that as `unfittable`. This is also how a huge
 * lane tag alone (zero turns, R2 #2's own repro) still triggers the refusal:
 * a one-turn attempt is strictly bigger than a zero-turn one, so if even
 * that fails every smaller attempt already failed too.
 */
function applyGraphAutoInterval(input: {
  turns: ConsoleGraphTurn[];
  edges: ConsoleGraphEdge[];
  lanes: ConsoleGraphLane[];
  laneCheckText: string;
  scope: unknown;
  asOf: string;
  ctx: ConsoleRequestContext;
  preTrimAppliedBounds: ConsoleAppliedBound[];
  preTrimStateCoverage: "full" | "partial";
  intervalCeilingId: number | null;
}): {
  turns: ConsoleGraphTurn[];
  edges: ConsoleGraphEdge[];
  interval: ConsoleGraphInterval | null;
  appliedBounds: ConsoleAppliedBound[];
  stateCoverage: "full" | "partial";
  unfittable: boolean;
} {
  const { lanes, laneCheckText, scope, asOf, ctx, preTrimAppliedBounds, preTrimStateCoverage, intervalCeilingId } = input;

  const fullOldestId = input.turns[0]?.id ?? null;
  const fullNewestId = input.turns[input.turns.length - 1]?.id ?? null;

  const intervalFor = (turns: ConsoleGraphTurn[]): ConsoleGraphInterval | null => {
    if (turns.length === 0) return null;
    const first = turns[0]!;
    const last = turns[turns.length - 1]!;
    return {
      fromTurnId: first.id,
      toTurnId: last.id,
      fromAddress: turnAddress(first),
      toAddress: turnAddress(last),
      isOldest: first.id === fullOldestId,
      isNewest: last.id === fullNewestId,
    };
  };
  const coverageFor = (interval: ConsoleGraphInterval | null): "full" | "partial" =>
    preTrimStateCoverage === "partial" || !interval || !(interval.isOldest && interval.isNewest)
      ? "partial"
      : "full";

  const eligible =
    intervalCeilingId === null ? input.turns : input.turns.filter((t) => t.id <= intervalCeilingId);
  if (eligible.length === 0) {
    // Zero candidate turns — either the whole widened projection carries
    // none, or `intervalCeilingId` excluded all of them. Still must check
    // the baseline (lanes/laneCheckText/meta alone, R2 #2's own huge-lane-
    // tag repro): a zero-turn envelope is the SMALLEST this route can ever
    // ship, so if even that overflows, every non-empty attempt would too —
    // unfittable, not a silent empty-but-fine response.
    const baselineMeta = buildMeta({
      scope,
      counts: { turns: 0, edges: 0, lanes: lanes.length },
      asOf,
      ctx,
      stateCoverage: preTrimStateCoverage,
      appliedBounds: preTrimAppliedBounds,
      interval: null,
    });
    const baselineBytes = envelopeBytes([], [], lanes, laneCheckText, baselineMeta);
    if (baselineBytes > RESPONSE_BYTE_SOFT_MAX) {
      const appliedBound: ConsoleAppliedBound = {
        bound: "RESPONSE_BYTE_SOFT_MAX",
        requested: baselineBytes,
        applied: RESPONSE_BYTE_SOFT_MAX,
      };
      return {
        turns: [],
        edges: [],
        interval: null,
        appliedBounds: [...preTrimAppliedBounds, appliedBound],
        stateCoverage: "partial",
        unfittable: true,
      };
    }
    return {
      turns: [],
      edges: [],
      interval: null,
      appliedBounds: preTrimAppliedBounds,
      stateCoverage: preTrimStateCoverage,
      unfittable: false,
    };
  }

  const eligibleIds = new Set(eligible.map((t) => t.id));
  const eligibleEdges = input.edges.filter(
    (e) => eligibleIds.has(e.citingId) && eligibleIds.has(e.citedId),
  );
  const eligibleInterval = intervalFor(eligible);
  const eligibleCoverage = coverageFor(eligibleInterval);
  const fastMeta = buildMeta({
    scope,
    counts: { turns: eligible.length, edges: eligibleEdges.length, lanes: lanes.length },
    asOf,
    ctx,
    stateCoverage: eligibleCoverage,
    appliedBounds: preTrimAppliedBounds,
    interval: eligibleInterval,
  });
  const fastBytes = envelopeBytes(eligible, eligibleEdges, lanes, laneCheckText, fastMeta);
  if (fastBytes <= RESPONSE_BYTE_SOFT_MAX) {
    return {
      turns: eligible,
      edges: eligibleEdges,
      interval: eligibleInterval,
      appliedBounds: preTrimAppliedBounds,
      stateCoverage: eligibleCoverage,
      unfittable: false,
    };
  }

  // Over budget: every edge touching ANY turn, indexed once — the walk
  // below looks up "edges touching the turn just added" at each step.
  // `new Set([citingId, citedId])` (peer P2-4): a self-edge (`citingId ===
  // citedId`, a real shape — Gate C self-`grounds` writes one) has only ONE
  // distinct endpoint turn, so it must be bucketed once, not twice — the
  // plain two-element array this replaced pushed the SAME edge object into
  // the SAME bucket twice for a self-edge, which would have doubled it in
  // `inducedEdges` below.
  const edgesByTurnId = new Map<number, ConsoleGraphEdge[]>();
  for (const edge of input.edges) {
    for (const turnId of new Set([edge.citingId, edge.citedId])) {
      const bucket = edgesByTurnId.get(turnId);
      if (bucket) bucket.push(edge);
      else edgesByTurnId.set(turnId, [edge]);
    }
  }

  const appliedBound: ConsoleAppliedBound = {
    bound: "RESPONSE_BYTE_SOFT_MAX",
    requested: fastBytes,
    applied: RESPONSE_BYTE_SOFT_MAX,
  };
  const finalAppliedBounds = [...preTrimAppliedBounds, appliedBound];

  const included: ConsoleGraphTurn[] = []; // accumulates NEWEST first; reversed once at the end
  const includedIds = new Set<number>();
  const includedEdges: ConsoleGraphEdge[] = [];
  let newestIncluded: ConsoleGraphTurn | null = null;

  for (let i = eligible.length - 1; i >= 0; i -= 1) {
    const candidateTurn = eligible[i]!;
    const inducedEdges: ConsoleGraphEdge[] = [];
    for (const edge of edgesByTurnId.get(candidateTurn.id) ?? []) {
      // A self-edge (peer P2-4): `otherId` resolves to `candidateTurn.id`
      // itself, which is not yet in `includedIds` at this point in the loop
      // (it is only added after this block, below) — the plain
      // `includedIds.has(otherId)` check this replaces therefore never rode
      // a self-edge in with its own turn. `otherId === candidateTurn.id`
      // holds true if and only if the edge is a genuine self-edge (for any
      // other edge touching this turn, `otherId` is the OTHER endpoint by
      // construction), so it is the exact, minimal condition to special-case.
      const otherId = edge.citingId === candidateTurn.id ? edge.citedId : edge.citingId;
      const isSelfEdge = otherId === candidateTurn.id;
      if (isSelfEdge || includedIds.has(otherId)) inducedEdges.push(edge);
    }
    const candidateTurns = [candidateTurn, ...included];
    const candidateEdges = [...includedEdges, ...inducedEdges];
    const candidateInterval: ConsoleGraphInterval = {
      fromTurnId: candidateTurn.id,
      toTurnId: (newestIncluded ?? candidateTurn).id,
      fromAddress: turnAddress(candidateTurn),
      toAddress: turnAddress(newestIncluded ?? candidateTurn),
      isOldest: candidateTurn.id === fullOldestId,
      isNewest: (newestIncluded ?? candidateTurn).id === fullNewestId,
    };
    const candidateMeta = buildMeta({
      scope,
      counts: { turns: candidateTurns.length, edges: candidateEdges.length, lanes: lanes.length },
      asOf,
      ctx,
      stateCoverage: "partial", // guaranteed: reached only because the whole eligible set did NOT fit
      appliedBounds: finalAppliedBounds,
      interval: candidateInterval,
    });
    const candidateBytes = envelopeBytes(candidateTurns, candidateEdges, lanes, laneCheckText, candidateMeta);
    if (candidateBytes > RESPONSE_BYTE_SOFT_MAX) {
      break; // this turn (and every older one) would overflow — the interval boundary is set
    }
    included.push(candidateTurn);
    includedIds.add(candidateTurn.id);
    includedEdges.push(...inducedEdges);
    if (!newestIncluded) newestIncluded = candidateTurn;
  }

  if (included.length === 0) {
    return {
      turns: [],
      edges: [],
      interval: null,
      appliedBounds: finalAppliedBounds,
      stateCoverage: "partial",
      unfittable: true,
    };
  }

  included.reverse();
  return {
    turns: included,
    edges: sortEdgesForDisplay(includedEdges),
    interval: intervalFor(included),
    appliedBounds: finalAppliedBounds,
    stateCoverage: "partial",
    unfittable: false,
  };
}

/**
 * The POST-load boundary rule's COUNT half (ticket 01), relocated here by
 * ticket 03 (peer P1-3/P2-7): applied AFTER `applyGraphAutoInterval` has
 * already resolved its own byte-budgeted interval, to THAT interval's own
 * `turns`/`edges` — never before, and never to the full projection (see
 * `WIDEN_NODE_MAX`'s own doc for why running these caps first was the bug).
 * `RESPONSE_BYTE_SOFT_MAX` is the primary narrowing mechanism; these two
 * remain rarely-triggered structural safety nets for the case a resolved
 * interval's turn/edge COUNT is itself pathological even though its bytes
 * fit (many small turns/edges).
 *
 * Both arrays arrive already sorted ascending by id (the invariant
 * `applyGraphAutoInterval` returns), so "NEWEST-first" trimming — the
 * direction fix itself, replacing the old oldest-first prefix cut — is
 * simply keeping the TAIL: `.slice(-N)` instead of `.slice(0, N)`.
 *
 * A `WIDEN_NODE_MAX` firing does three things atomically, not just an array
 * slice: (1) trims `turns` to its own newest `WIDEN_NODE_MAX`; (2)
 * re-filters `edges` to endpoint closure against that SMALLER turn set —
 * without this, an edge naming a turn this trim just dropped would ship
 * with a dangling endpoint, the exact R2 #3 defect ticket 04 already closed
 * once; (3) re-derives the reported `interval`'s `fromTurnId`/`fromAddress`/
 * `isOldest` from the new oldest surviving turn — an interval whose own
 * metadata still claimed the OLD (now-trimmed) boundary would be lying
 * about what the response actually carries. `isNewest` never changes: this
 * trim only ever removes from the old end.
 *
 * `GRAPH_EDGE_MAX` fires independently, on whatever `edges` remains after
 * the `WIDEN_NODE_MAX` step (if any) — a pure edge-count cap, so it never
 * touches `turns`/`interval` itself.
 */
function applyPostIntervalCountBounds(input: {
  turns: ConsoleGraphTurn[];
  edges: ConsoleGraphEdge[];
  interval: ConsoleGraphInterval | null;
  appliedBounds: ConsoleAppliedBound[];
  stateCoverage: "full" | "partial";
}): {
  turns: ConsoleGraphTurn[];
  edges: ConsoleGraphEdge[];
  interval: ConsoleGraphInterval | null;
  appliedBounds: ConsoleAppliedBound[];
  stateCoverage: "full" | "partial";
} {
  let turns = input.turns;
  let edges = input.edges;
  let interval = input.interval;
  const appliedBounds = [...input.appliedBounds];
  let stateCoverage = input.stateCoverage;

  const turnsOverCap = turns.length > WIDEN_NODE_MAX;
  if (turnsOverCap) {
    appliedBounds.push({ bound: "WIDEN_NODE_MAX", requested: turns.length, applied: WIDEN_NODE_MAX });
    turns = turns.slice(-WIDEN_NODE_MAX);
    const keptIds = new Set(turns.map((t) => t.id));
    edges = edges.filter((e) => keptIds.has(e.citingId) && keptIds.has(e.citedId));
    if (interval && turns.length > 0) {
      const newOldest = turns[0]!;
      interval = { ...interval, fromTurnId: newOldest.id, fromAddress: turnAddress(newOldest), isOldest: false };
    }
    stateCoverage = "partial";
  }

  const edgesOverCap = edges.length > GRAPH_EDGE_MAX;
  if (edgesOverCap) {
    appliedBounds.push({ bound: "GRAPH_EDGE_MAX", requested: edges.length, applied: GRAPH_EDGE_MAX });
    edges = edges.slice(-GRAPH_EDGE_MAX);
    stateCoverage = "partial";
  }

  return { turns, edges, interval, appliedBounds, stateCoverage };
}

/**
 * Ticket 04's refusal-with-summary path (spec "Budgets and coverage": a
 * scope the budgets cannot hold returns EITHER a refusal-with-summary
 * ("413-style 200 envelope naming the bound") OR a partial graph — this is
 * the first arm). Reached only when `applyGraphAutoInterval` could not fit
 * even a single-turn interval (see that function's own "UNFITTABLE" doc).
 * Ships the contract's own four keys, never omitted, just emptied (`turns:
 * [] edges: [] lanes: [] laneCheckText: ""`) plus an `error` field naming
 * the bound — never the oversized lanes/laneCheckText themselves, which is
 * exactly the "payload larger than the bound carrying an applied-bound
 * claim" ticket R2 rules out. `counts` reports the emptied arrays' own
 * lengths (0/0/0) — same "counts is the literal length of what this
 * response actually carries" convention every other route in this file
 * already follows (see `handleSegmentCardRoute`'s own doc on that point).
 */
function buildUnfittableGraphResult(input: {
  scope: unknown;
  asOf: string;
  ctx: ConsoleRequestContext;
  appliedBounds: ConsoleAppliedBound[];
}): ConsoleApiResult {
  return {
    status: 200,
    body: {
      turns: [],
      edges: [],
      lanes: [],
      laneCheckText: "",
      error: {
        code: "graph_exceeds_byte_bound",
        message:
          `graph scope exceeds RESPONSE_BYTE_SOFT_MAX (${RESPONSE_BYTE_SOFT_MAX} bytes) even for a single-turn interval; narrow the session range or choose a segment and retry`,
      },
      meta: buildMeta({
        scope: input.scope,
        counts: { turns: 0, edges: 0, lanes: 0 },
        asOf: input.asOf,
        ctx: input.ctx,
        stateCoverage: "partial",
        appliedBounds: input.appliedBounds,
        interval: null,
      }),
    },
  };
}

export function handleGraphRoute(
  reader: ConsoleReader,
  url: URL,
  ctx: ConsoleRequestContext,
): ConsoleApiResult {
  // Ticket 04 (graph-byte-priority, T1498 ruling): the interval selector's
  // own ceiling — a turn id, validated FIRST (before any reader call at
  // all, same discipline `resolveGraphScope` itself follows for session/
  // segment/from/to) even though it is only consumed much later
  // (`applyGraphAutoInterval`, after the projection loads).
  const intervalParam = parseOptionalIntParam(url, "interval");
  if (!intervalParam.ok) {
    return errorResult(400, "bad_request", "interval must be a non-negative integer");
  }

  const preLoadAppliedBounds: ConsoleAppliedBound[] = [];
  const resolution = resolveGraphScope(reader, url, preLoadAppliedBounds);
  if ("error" in resolution) {
    return resolution.error;
  }
  const { scope, scopeDescriptor } = resolution;

  // ONE `loadLaneCheckScope` -> `checkLanes` call (spec "One projection") —
  // `ConsoleReader.runLaneCheck` is that exactly-once boundary; everything
  // below only PROJECTS from `run.result`/`run.turns`/`run.edges`, never
  // re-derives.
  const run = reader.runLaneCheck(scope);
  // floor-and-render-fidelity ticket 03: `laneCheckText` is reader-facing
  // (it ships in the console payload) and gets the same address form every
  // other lane_check surface does, built from this exact projection's own
  // turns — no second load. It is a FULL-SNAPSHOT fact over this whole-scope
  // projection, never narrowed to whichever interval `applyGraphAutoInterval`
  // later selects. (Ticket 03 hoisted it to a local so the lane payload's own
  // terminus address could share the map; that field left with lane state in
  // ticket 01, and `laneCheckText` is the one reader again.)
  const laneAddresses = buildLaneAnchorAddresses(run.turns);
  const laneCheckText = renderLaneCheckerReports(run.result, laneAddresses);

  // Election preview (ticket 03): per-turn tier from the pure election
  // module, over the SAME projection inputs `checkLanes` just consumed.
  const election = electMilestones(
    run.turns as MilestoneTurnInput[],
    run.edges,
    ELECTION_PREVIEW_BUDGET,
  );
  const tierByTurnId = new Map(election.candidates.map((candidate) => [candidate.id, candidate.tier]));

  const componentIdsByToken = indexLaneComponentIds(run.result.components);
  const laneMembershipsByTurnId = computePerTurnLaneMemberships(
    run.result.lanes,
    componentIdsByToken,
  );
  // Report 2 carries one entry per lane it describes; a lane it did not
  // describe reports its member count, since with no islands recorded every
  // member stands alone — the same number report 2 itself would print.
  const componentCountByToken = new Map(
    run.result.components.map((report) => [
      laneToken(report.key.segment, report.key.tag),
      report.componentCount,
    ]),
  );
  const lanes: ConsoleGraphLane[] = run.result.lanes.map((lane) => ({
    segment: lane.key.segment,
    tag: lane.key.tag,
    memberCount: lane.members.length,
    phases: [...lane.phases],
    componentCount: componentCountByToken.get(tokenFor(lane)) ?? lane.members.length,
    token: tokenFor(lane),
  }));

  // Every live turn's own segment (defaulting the same way `LaneTurnInput`
  // itself does) — the one extra fact `ConsoleGraphEdge`'s two side tokens
  // need beyond what `run.edges` already carries, over the SAME `run.turns`
  // this handler already has in hand (no new reader call). BOTH endpoints are
  // looked up now, not just the citing one: each side's lane lives in its own
  // endpoint's segment.
  const segmentByTurnId = new Map(run.turns.map((turn) => [turn.id, turn.segment ?? DEFAULT_SEGMENT]));

  const sortedTurns = sortTurnsById(run.turns);
  const sortedEdges = sortEdgesForDisplay(run.edges);

  // Display-load EVERY turn in the full projection (ticket 03, peer
  // P1-3/P2-7) — no pre-interval WIDEN_NODE_MAX cap narrows this set first
  // anymore (see `WIDEN_NODE_MAX`'s own doc). `applyGraphAutoInterval` below
  // needs each turn's real excerpt/title bytes to measure its own envelope
  // correctly, and the interval it selects must be able to reach any turn in
  // the true full index, including the newest ones past 10000.
  const displayFields = reader.loadTurnDisplayFields(sortedTurns.map((turn) => turn.id));
  const turnsPayload: ConsoleGraphTurn[] = sortedTurns.map((turn) => {
    const fields = displayFields.get(turn.id);
    const sessionId = fields?.sessionId ?? turn.order?.[0] ?? 0;
    const promptNumber = fields?.promptNumber ?? turn.order?.[1] ?? 0;
    return {
      id: turn.id,
      sessionId,
      promptNumber,
      // ONE address grammar under every scope ([S15069/T1557] — ticket 10):
      // always `S<sessionId>/T<promptNumber>`, never a per-segment form.
      address: `S${sessionId}/T${promptNumber}`,
      title: fields?.title ?? null,
      promptExcerpt: codePointExcerpt(fields?.userPrompt ?? null, EXCERPT_PROMPT_CP),
      contentExcerpt: codePointExcerpt(fields?.content ?? null, EXCERPT_CONTENT_CP),
      electionTier: tierByTurnId.get(turn.id) ?? null,
      type: [...turn.type],
      tags: [...(fields?.tags ?? [])],
      laneMemberships: laneMembershipsByTurnId.get(turn.id) ?? [],
    };
  });
  // Each SIDE resolves its lane token in its OWN endpoint's segment (ticket
  // 07): the tail in the citing turn's, the head in the cited turn's. An
  // unsettled side names no lane and so gets `null`, never a token built over
  // the empty tag.
  const sideLaneToken = (turnId: number, tag: string): string | null =>
    tag === UNSETTLED_LANE_TAG
      ? null
      : laneToken(segmentByTurnId.get(turnId) ?? DEFAULT_SEGMENT, tag);
  const edgesPayload: ConsoleGraphEdge[] = sortedEdges.map((edge) => ({
    citingId: edge.citingId,
    citedId: edge.citedId,
    relation: edge.relation,
    tailTag: edge.tailTag,
    headTag: edge.headTag,
    tailLaneToken: sideLaneToken(edge.citingId, edge.tailTag),
    headLaneToken: sideLaneToken(edge.citedId, edge.headTag),
  }));

  // Interval selection, over the FULL display payload (ticket 04,
  // T1496/T1498 rulings; ticket 03 fix: no pre-cap ahead of this anymore —
  // see this function's own doc). Replaces the old byte-trim loop entirely.
  // See `applyGraphAutoInterval`'s own doc for why it must measure the FINAL
  // envelope (meta included), never a `{turns,edges,lanes,laneCheckText}`
  // stand-in (ticket R2 #2, preserved through the rewrite), and for why its
  // own construction already satisfies ticket R2 #3's endpoint-closure
  // invariant with no separate post-filter pass.
  const autoInterval = applyGraphAutoInterval({
    turns: turnsPayload,
    edges: edgesPayload,
    lanes,
    laneCheckText,
    scope: scopeDescriptor,
    asOf: run.asOf,
    ctx,
    preTrimAppliedBounds: preLoadAppliedBounds,
    preTrimStateCoverage: "full",
    intervalCeilingId: intervalParam.value ?? null,
  });

  if (autoInterval.unfittable) {
    return buildUnfittableGraphResult({
      scope: scopeDescriptor,
      asOf: run.asOf,
      ctx,
      appliedBounds: autoInterval.appliedBounds,
    });
  }

  // COUNT caps LAST (ticket 03, peer P1-3/P2-7): applied to the RESOLVED
  // interval's own turns/edges, never before — see
  // `applyPostIntervalCountBounds`'s own doc for the newest-first direction
  // and why a turns trim also re-derives `interval`/re-filters `edges`.
  const postCount = applyPostIntervalCountBounds({
    turns: autoInterval.turns,
    edges: autoInterval.edges,
    interval: autoInterval.interval,
    appliedBounds: autoInterval.appliedBounds,
    stateCoverage: autoInterval.stateCoverage,
  });

  return {
    status: 200,
    body: {
      turns: postCount.turns,
      edges: postCount.edges,
      lanes,
      laneCheckText,
      meta: buildMeta({
        scope: scopeDescriptor,
        counts: { turns: postCount.turns.length, edges: postCount.edges.length, lanes: lanes.length },
        asOf: run.asOf,
        ctx,
        stateCoverage: postCount.stateCoverage,
        appliedBounds: postCount.appliedBounds,
        interval: postCount.interval,
      }),
    },
  };
}

// --------------------------------------------------------------- routing ---

const CONSOLE_API_PREFIX = "/api/console/";

/** `null` when `pathname` is not under `/api/console/` at all — the caller's signal to fall through to whatever else handles the request (e.g. the eventual `/console` shell route, out of this ticket's scope). Any OTHER unrecognized path under the prefix gets the console's own 404 envelope, per spec ("404 ... unknown route under /api/console/"). */
export function routeConsoleApiRequest(
  pathname: string,
  reader: ConsoleReader,
  url: URL,
  ctx: ConsoleRequestContext,
): ConsoleApiResult | null {
  if (!pathname.startsWith(CONSOLE_API_PREFIX)) {
    return null;
  }
  switch (pathname) {
    case "/api/console/sessions":
      return handleSessionsRoute(reader, url, ctx);
    case "/api/console/segments":
      return handleSegmentsRoute(reader, url, ctx);
    case "/api/console/graph":
      return handleGraphRoute(reader, url, ctx);
    case "/api/console/segment":
      return handleSegmentCardRoute(reader, url, ctx);
    case "/api/console/recall":
      return handleRecallRoute(reader, url, ctx);
    case "/api/console/timeline":
      return handleTimelineRoute(reader, url, ctx);
    default:
      return errorResult(404, "not_found", `unknown console API route ${pathname}`);
  }
}

/**
 * `{status, body}` -> a real `Response`, with the JSON headers the spec
 * requires on every console response: `application/json; charset=utf-8`,
 * `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`. Built with
 * `new Response(JSON.stringify(...), {headers})` rather than `Response.json`
 * — this codebase's own existing `/health` route (`server.ts`) already
 * takes that route for full, unambiguous control of the exact
 * `content-type` header value, and `Response.json`'s own default
 * (`application/json`, no explicit charset) is not byte-identical to what
 * the spec names.
 */
export function toConsoleApiResponse(result: ConsoleApiResult): Response {
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  });
}

// Re-exported so a caller wiring routes (server.ts) or a scope-shaped test
// need not also import `db/lane-checker-load.ts` directly for the type.
export type { LaneCheckScope };
