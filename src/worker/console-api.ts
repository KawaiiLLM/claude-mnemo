import type { LaneCheckScope } from "../db/lane-checker-load";
import { DEFAULT_SEGMENT, laneToken, UNSETTLED_LANE_TAG } from "../shared/lane-interpretation";
import type { LaneStatsReport, LaneTurnInput } from "../shared/lane-checker";
import { buildLaneAnchorAddresses, renderLaneCheckerReports } from "../shared/lane-checker-render";
import { electMilestones, type MilestoneTurnInput } from "../shared/milestone-election";

import type { ConsoleReader } from "./console-reader";
import { parseSessionsCursor } from "./console-reader";

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
   * PER-LANE member state, replacing ticket 04's turn-scoped
   * `lanes: string[]` + `isTerminus` boolean, which OR'd `state.terminus ===
   * id` across every lane a turn belongs to and so could not express "the
   * terminus of B, an ordinary member of A".
   *
   * One entry per lane this turn is a MEMBER of, each carrying that SPECIFIC
   * lane's own `isTerminus` fact alongside its `token` (see
   * `ConsoleGraphLane.token`) — `[]` for a laneless turn, never omitted
   * (contract's own "empty lists = []" rule).
   *
   * lane-model-v12 ticket 04 REMOVED this entry's second boolean, which
   * published a per-turn, per-lane node-death flag. Node death does not exist
   * in v12, so the console must not publish it under any name.
   */
  laneMemberships: readonly ConsoleTurnLaneMembership[];
}

/** One lane's own terminus fact about a specific turn — see `ConsoleGraphTurn.laneMemberships`. */
export interface ConsoleTurnLaneMembership {
  /** This lane's own `token` (`ConsoleGraphLane.token`) — never re-derived client-side. */
  token: string;
  /** `state.terminus === this turn's id` for THIS lane specifically. */
  isTerminus: boolean;
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
 * A lane in the console's graph payload. `state` is `LaneStatsReport.state`
 * (the CORRECTED closed/open reading — see
 * `shared/lane-checker.ts`'s own module header, "Report 1 gains a state
 * line") with `key` stripped (already carried at this object's own top
 * level via `segment`/`tag`, so nesting it again would just duplicate the
 * same two fields). `declarationState`/`declarationTerminus` are the RAW
 * `LaneDeclaration` facts alongside it — both are shipped because they
 * answer different questions: `state` is "what should the UI call this
 * lane", `declarationState`/`declarationTerminus` are "what does the raw
 * reduction say", and a lane that kept living past its own declaration
 * (`state.closure === "open"` while `declarationState === "declared"`) is
 * exactly the case `lane-checker.ts`'s own header names as the reason the
 * two must never be collapsed into one field.
 *
 * `membershipComponentId` (spec "Focus domain", peer #5): LANE-MEMBERSHIP
 * connectivity — lanes joined by sharing member turns, the prototype's
 * "tagged-edge component" domain — computed here from `checkLanes`' own
 * `lanes[].members`. This is DELIBERATELY NOT `LaneCheckerResult.components`/
 * `multiLaneComponents` (report 2/3's stance+consume+grounds structural-edge
 * domain over TURN nodes): two lanes can share zero structural edges yet
 * share a member turn (a turn adopted by one lane's `consume` and declared
 * by another), which report 2/3 would never connect but the focus domain
 * must. A stable, human-legible id — the lexicographically smallest lane
 * token in the component — rather than report 2's numeric turn-id
 * `representative`, so the two ID spaces can never be confused for one
 * another even by shape.
 *
 * `state.terminusAddress` (ticket 03, peer P2-5/P2-6): lanes/`laneCheckText`
 * are computed over the FULL lane-check scope, WHOLE-SNAPSHOT — never
 * projected down to whichever interval `applyGraphAutoInterval` happens to
 * be rendering (same posture as `ConsoleMeta.electionCoverage`, stated out
 * loud in the shell's own copy). A lane's terminus can therefore name a turn
 * OUTSIDE the currently-rendered interval's own `turns` array, so the shell
 * cannot resolve its address by looking the id up in `turns` (its `addrOf`
 * helper's own last-resort `"T"+id` fallback — exactly the bare-dbid text a
 * reader-facing surface must never print, floor-and-render-fidelity ticket
 * 03). This field ships the address the payload already has in hand
 * (`buildLaneAnchorAddresses(run.turns)`, the SAME map `laneCheckText`
 * itself renders through) so the shell never needs that fallback for a
 * terminus at all — `null` only when `state.terminus` itself is `null`.
 */
export interface ConsoleGraphLane {
  segment: string;
  /** D5, v11: a lane's identity is one tag, not a set — this field carries that one tag (never an array; `LaneKey.tag`'s own console mirror). */
  tag: string;
  /** lane-model-v12 ticket 04: TWO fields left this contract — a closed lane's quality verdict and an open lane's most-recent-declarer seat. Neither concept exists in v12, and a console that kept publishing them would keep teaching the retired model. */
  state: {
    closure: string;
    terminus: number | null;
    terminusAddress: string | null;
  };
  memberCount: number;
  phases: string[];
  declarationState: string;
  declarationTerminus: number | null;
  membershipComponentId: string;
  /**
   * Ticket 04 additive field: this lane's own stable identity key —
   * `laneToken(segment, tag)`, the same value already computed internally
   * (`tokenFor`) for `membershipComponentId`'s own union-find, now shipped
   * verbatim so the shell can build its `laneByToken` map directly from the
   * payload instead of recomputing the token client-side (spec: "the shell
   * renders; it derives nothing"). Distinct from `membershipComponentId`:
   * `token` identifies THIS lane; `membershipComponentId` identifies the
   * (possibly larger) group of lanes it belongs to.
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

/** Absent -> `{ ok: true, value: undefined }`; present and a non-negative integer -> `{ ok: true, value }`; anything else (non-digits, too large to be a safe integer) -> `{ ok: false }`, the route's own signal to 400. */
function parseOptionalIntParam(url: URL, name: string): ParsedIntParam {
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

// ------------------------------------------------------------------ graph --

/** Segment + tag (D5, v11) — the same token `shared/lane-interpretation.ts`'s own `laneToken` computes, re-derived here only for the union-find key (that function is already imported for the payload's own use). */
function tokenFor(lane: Pick<LaneStatsReport, "key">): string {
  return laneToken(lane.key.segment, lane.key.tag);
}

/** Path-compressed union-find over lane TOKENS (not turn ids) — the focus domain's own connectivity unit is "two lanes", not "two turns". Kept local: this is a different domain from `shared/lane-checker.ts`'s internal turn-id `UnionFind`, not a reuse candidate. */
class LaneTokenUnionFind {
  private readonly parent = new Map<string, string>();

  add(token: string): void {
    if (!this.parent.has(token)) {
      this.parent.set(token, token);
    }
  }

  find(token: string): string {
    this.add(token);
    let root = token;
    while (this.parent.get(root) !== root) {
      root = this.parent.get(root)!;
    }
    let cursor = token;
    while (cursor !== root) {
      const next = this.parent.get(cursor)!;
      this.parent.set(cursor, root);
      cursor = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) {
      this.parent.set(rootA, rootB);
    }
  }
}

/** See `ConsoleGraphLane.membershipComponentId`'s own doc — lane-membership connectivity, computed once per graph request over the FULL (untruncated) lane set. */
function computeMembershipComponentIds(
  lanes: readonly LaneStatsReport[],
): Map<string, string> {
  const uf = new LaneTokenUnionFind();
  for (const lane of lanes) {
    uf.add(tokenFor(lane));
  }

  const laneTokensByMember = new Map<number, string[]>();
  for (const lane of lanes) {
    const token = tokenFor(lane);
    for (const member of lane.members) {
      const bucket = laneTokensByMember.get(member.id);
      if (bucket) {
        bucket.push(token);
      } else {
        laneTokensByMember.set(member.id, [token]);
      }
    }
  }
  for (const tokens of laneTokensByMember.values()) {
    for (let index = 1; index < tokens.length; index += 1) {
      uf.union(tokens[0]!, tokens[index]!);
    }
  }

  const tokensByRoot = new Map<string, string[]>();
  for (const lane of lanes) {
    const token = tokenFor(lane);
    const root = uf.find(token);
    const bucket = tokensByRoot.get(root);
    if (bucket) {
      bucket.push(token);
    } else {
      tokensByRoot.set(root, [token]);
    }
  }
  const componentIdByRoot = new Map<string, string>();
  for (const [root, tokens] of tokensByRoot) {
    componentIdByRoot.set(root, [...tokens].sort()[0]!);
  }

  const componentIdByToken = new Map<string, string>();
  for (const lane of lanes) {
    const token = tokenFor(lane);
    componentIdByToken.set(token, componentIdByRoot.get(uf.find(token))!);
  }
  return componentIdByToken;
}

/**
 * The per-turn, PER-LANE membership fact the shell renders
 * (`ConsoleGraphTurn.laneMemberships` — see that field's own doc) computed
 * ONCE from `run.result.lanes`, the SAME single projection (spec "One
 * projection") `computeMembershipComponentIds` already reads. Deliberately
 * over the FULL (untruncated) lane set, mirroring that function: a turn's own
 * lane membership and terminus standing is a fact about the lane structure,
 * independent of which OTHER turns a later post-load bound happens to
 * truncate out of the response.
 *
 * Never collapses `isTerminus` across lanes (the ticket 04 bug this replaces)
 * — each lane contributes its OWN entry, straight from that lane's own
 * `state.terminus`, never OR'd together.
 */
function computePerTurnLaneMemberships(
  lanes: readonly LaneStatsReport[],
): Map<number, ConsoleTurnLaneMembership[]> {
  const byTurnId = new Map<number, ConsoleTurnLaneMembership[]>();
  for (const lane of lanes) {
    const token = tokenFor(lane);
    const terminus = lane.state.terminus;
    for (const member of lane.members) {
      const entry: ConsoleTurnLaneMembership = {
        token,
        isTerminus: member.id === terminus,
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
  // turns — no second load. Ticket 03 (peer P2-5/P2-6): hoisted to a local so
  // `ConsoleGraphLane.state.terminusAddress` below can reuse the SAME map —
  // both are FULL-SNAPSHOT facts over this whole-scope projection, never
  // narrowed to whichever interval `applyGraphAutoInterval` later selects.
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

  const membershipComponentIdByToken = computeMembershipComponentIds(run.result.lanes);
  const laneMembershipsByTurnId = computePerTurnLaneMemberships(run.result.lanes);
  const lanes: ConsoleGraphLane[] = run.result.lanes.map((lane) => ({
    segment: lane.key.segment,
    tag: lane.key.tag,
    state: {
      closure: lane.state.closure,
      terminus: lane.state.terminus,
      terminusAddress: lane.state.terminus !== null ? (laneAddresses.get(lane.state.terminus) ?? null) : null,
    },
    memberCount: lane.members.length,
    phases: [...lane.phases],
    declarationState: lane.declaration.state,
    declarationTerminus: lane.declaration.terminus,
    membershipComponentId: membershipComponentIdByToken.get(tokenFor(lane))!,
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
