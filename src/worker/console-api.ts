import type { LaneCheckScope } from "../db/lane-checker-load";
import { DEFAULT_SEGMENT, laneToken } from "../shared/lane-interpretation";
import type { LaneEdgeInput, LaneStatsReport, LaneTurnInput } from "../shared/lane-checker";
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
 * differently. The worst-case byte risk WAS checked: 1251 widened turns
 * (ticket 01's largest observed scope) each carrying a full 280-code-point
 * CJK content string adds up to ~1.05 MB of UTF-8 bytes on its own (3
 * bytes/code point worst case) — enough to push a scope that was "full"
 * under the old (no-content) measurement into `RESPONSE_BYTE_SOFT_MAX`
 * territory. That is not a reason to shrink the cap: `RESPONSE_BYTE_SOFT_MAX`
 * is an ADVISORY, POST-load cap this handler already enforces by truncating
 * turns/edges and reporting `stateCoverage: "partial"` (see
 * `applyGraphBounds` below) — the worst case degrades gracefully into a
 * correctly-labeled partial response instead of an oversized one, which is
 * exactly the contract the byte cap exists to keep.
 */
export const EXCERPT_CONTENT_CP = 280;
export const GRAPH_EDGE_MAX = 1000;
export const WIDEN_NODE_MAX = 2000;
export const RESPONSE_BYTE_SOFT_MAX = 1_000_000;
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
  title: string | null;
  promptExcerpt: string;
  contentExcerpt: string;
  /** `electMilestones`' per-turn tier over this same projection (`ELECTION_PREVIEW_BUDGET`); `null` for a turn that left candidacy entirely (excluded, not merely low-ranked). */
  electionTier: number | null;
  /** `LaneTurnInput.type` verbatim — already present on `run.turns`, no extra load. */
  type: readonly string[];
  /**
   * Ticket 04 (shell-and-matrix) additive field: the `token` (see
   * `ConsoleGraphLane.token`) of every lane this turn is a MEMBER of (dead
   * members included, mirroring `Lane.members`' own "never dropped" rule) —
   * the shell's own turn-detail panel and its focus/highlight machinery both
   * need this, and "delete client-side lane derivation" (spec) means the
   * server must ship the membership fact, never let the shell recompute it
   * from edges. `[]` for a laneless turn, never omitted (contract's own
   * "empty lists = []" rule, extended to this new field for consistency).
   */
  lanes: string[];
  /**
   * Ticket 04 additive field: true iff this turn IS `state.terminus` for at
   * least one lane in `lanes` below — the shell's terminus ring on a node
   * (and the panel's "◎ 已宣告终点" line) must come from the payload, not a
   * client-side scan of `lanes[].state.terminus` against `id` (spec: "lanes/
   * states/termini/dead flags ... come from the payload").
   */
  isTerminus: boolean;
  /**
   * Ticket 04 additive field: true iff this turn is `dead` in at least one
   * lane it is a member of (`LaneMember.dead` — a global kill or an in-lane
   * override; see `shared/lane-interpretation.ts`'s own "dead status is a
   * final-state snapshot" note). Same "ship the fact, do not let the shell
   * derive it" reasoning as `isTerminus`.
   */
  isDead: boolean;
}

export interface ConsoleGraphEdge {
  citingId: number;
  citedId: number;
  relation: string;
  tags: string[];
  /**
   * Ticket 04 additive field: the lane token this edge's own canonical tag
   * set names in the CITING turn's segment (`null` for an untagged edge —
   * untagged edges form no lane at all, `shared/lane-interpretation.ts`'s own
   * "untagged: forms no lane" rule). The citing side is used as the edge's
   * one "home" segment for this display field even on the rare cross-segment
   * dual-appearance edge (`LaneCrossSegmentWarning`) — the shell's own
   * highlight/dim logic only needs ONE token per edge to match against the
   * focused component's lane tokens, and the citing side is the edge's own
   * structural direction (`turn-phase.ts`'s "citing is always later"
   * convention). Restores the prototype's own pre-fetch `e.laneToken` field
   * (console-shell.html's `p.dataset.lane = e.tags.length ? e.laneToken :
   * ""`) so the shell can set that dataset attribute directly from the
   * payload instead of recomputing a lane token client-side.
   */
  laneToken: string | null;
}

/**
 * A lane in the console's graph payload. `state` is `LaneStatsReport.state`
 * (the CORRECTED closed-valid/closed-invalid/open reading — see
 * `shared/lane-checker.ts`'s own module header, "Report 1 gains a state
 * line") with `key` stripped (already carried at this object's own top
 * level via `segment`/`tagSet`, so nesting it again would just duplicate the
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
 */
export interface ConsoleGraphLane {
  segment: string;
  tagSet: string[];
  state: { closure: string; validity: string | null; terminus: number | null; lastDeclarer: number | null };
  memberCount: number;
  phases: string[];
  declarationState: string;
  declarationTerminus: number | null;
  membershipComponentId: string;
  /**
   * Ticket 04 additive field: this lane's own stable identity key —
   * `laneToken(segment, tagSet)`, the same value already computed internally
   * (`tokenFor`) for `membershipComponentId`'s own union-find, now shipped
   * verbatim so the shell can build its `laneByToken` map directly from the
   * payload instead of recomputing the token client-side (spec: "the shell
   * renders; it derives nothing"). Distinct from `membershipComponentId`:
   * `token` identifies THIS lane; `membershipComponentId` identifies the
   * (possibly larger) group of lanes it belongs to.
   */
  token: string;
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
}): ConsoleMeta {
  return {
    scope: input.scope,
    counts: input.counts,
    asOf: input.asOf,
    workerBuildId: input.ctx.buildId,
    stateCoverage: input.stateCoverage,
    appliedBounds: input.appliedBounds,
    electionCoverage: "full-snapshot",
  };
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
      }),
    },
  };
}

// ------------------------------------------------------------------ graph --

/** Segment + exact canonical tag set — the same token `shared/lane-interpretation.ts`'s own `laneToken` computes, re-derived here only for the union-find key (that function is already imported for the payload's own use). */
function tokenFor(lane: Pick<LaneStatsReport, "key">): string {
  return laneToken(lane.key.segment, lane.key.tagSet);
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
 * Ticket 04 (shell-and-matrix): the three per-turn facts the shell renders
 * (`ConsoleGraphTurn.lanes`/`isTerminus`/`isDead` — see each field's own
 * doc) computed ONCE from `run.result.lanes`, the SAME single projection
 * (spec "One projection") `computeMembershipComponentIds` already reads.
 * Deliberately over the FULL (untruncated) lane set, mirroring that
 * function: a turn's own lane-membership/terminus/dead status is a fact
 * about the lane structure, independent of which OTHER turns a later
 * post-load bound happens to truncate out of the response.
 */
function computePerTurnLaneFacts(lanes: readonly LaneStatsReport[]): {
  lanesByTurnId: Map<number, string[]>;
  terminusTurnIds: Set<number>;
  deadTurnIds: Set<number>;
} {
  const lanesByTurnId = new Map<number, string[]>();
  const terminusTurnIds = new Set<number>();
  const deadTurnIds = new Set<number>();
  for (const lane of lanes) {
    const token = tokenFor(lane);
    if (lane.state.terminus !== null) {
      terminusTurnIds.add(lane.state.terminus);
    }
    for (const member of lane.members) {
      const bucket = lanesByTurnId.get(member.id);
      if (bucket) {
        bucket.push(token);
      } else {
        lanesByTurnId.set(member.id, [token]);
      }
      if (member.dead) {
        deadTurnIds.add(member.id);
      }
    }
  }
  return { lanesByTurnId, terminusTurnIds, deadTurnIds };
}

function sortTurnsById(turns: readonly LaneTurnInput[]): LaneTurnInput[] {
  return [...turns].sort((a, b) => a.id - b.id);
}

/** Same `(citingId, citedId, relation)` order `db/lane-checker-load.ts` already sorts its own output by — kept identical here so the "stable prefix" truncation below cuts the SAME prefix a caller reading `loadLaneCheckScope` directly would see. */
function sortEdgesForDisplay(edges: readonly LaneEdgeInput[]): LaneEdgeInput[] {
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
 * The POST-load boundary rule's COUNT half, verbatim from ticket 01:
 * widened-turn-count <= WIDEN_NODE_MAX AND widened-edge-count <=
 * GRAPH_EDGE_MAX, each truncated to a stable prefix (both arrays already
 * sorted) independently when exceeded. Operates on the bare projection rows
 * — BEFORE display fields are loaded — so a turn beyond `WIDEN_NODE_MAX`
 * never costs a `loadTurnDisplayFields` lookup it will not appear in the
 * response to justify.
 */
function applyGraphCountBounds(
  sortedTurns: LaneTurnInput[],
  sortedEdges: LaneEdgeInput[],
): {
  turns: LaneTurnInput[];
  edges: LaneEdgeInput[];
  overCap: boolean;
  appliedBounds: ConsoleAppliedBound[];
} {
  const appliedBounds: ConsoleAppliedBound[] = [];

  const turnsOverCap = sortedTurns.length > WIDEN_NODE_MAX;
  if (turnsOverCap) {
    appliedBounds.push({ bound: "WIDEN_NODE_MAX", requested: sortedTurns.length, applied: WIDEN_NODE_MAX });
  }
  const turns = turnsOverCap ? sortedTurns.slice(0, WIDEN_NODE_MAX) : sortedTurns;

  const edgesOverCap = sortedEdges.length > GRAPH_EDGE_MAX;
  if (edgesOverCap) {
    appliedBounds.push({ bound: "GRAPH_EDGE_MAX", requested: sortedEdges.length, applied: GRAPH_EDGE_MAX });
  }
  const edges = edgesOverCap ? sortedEdges.slice(0, GRAPH_EDGE_MAX) : sortedEdges;

  return { turns, edges, overCap: turnsOverCap || edgesOverCap, appliedBounds };
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
 * The POST-load boundary rule's BYTE half, ticket R2 #2 repair: measures the
 * FINAL serialized envelope (meta included — see `envelopeBytes`'s own doc,
 * never the `{turns,edges,lanes,laneCheckText}` stand-in the reviewer's
 * repro caught) and truncates turns/edges further as a stable prefix (edges
 * first, then turns — the same discipline `applyGraphCountBounds` uses),
 * one item at a time, because bytes (unlike counts) cannot be pre-computed
 * per item without re-serializing.
 *
 * Chicken-and-egg (ticket R2 #2): `meta.appliedBounds` itself changes the
 * byte count once a `RESPONSE_BYTE_SOFT_MAX` entry is added to it, and
 * `meta.counts` changes on every trim step. This does NOT chase a true
 * fixed point over `meta`'s own encoded size — the ticket's own allowance
 * ("measure with the final meta included conservatively, document the
 * approach") is what this takes: the INITIAL fits-or-not check measures with
 * the byte-bound entry ABSENT (it is not yet known one is needed). The
 * instant a trim is confirmed necessary, the byte-bound entry and
 * `stateCoverage: "partial"` are fixed for the REST of this call — every
 * subsequent measurement (through to the eventual response) uses that SAME
 * final `appliedBounds` array; only `counts.turns`/`counts.edges` vary
 * step to step, a cheap two-integer diff, never a second pass over the
 * byte-bound entry's own encoding. The one deliberately approximate number
 * is that entry's own `requested` field: the bytes of the PRE-trim envelope
 * measured WITHOUT the entry describing itself (informational provenance —
 * "how big before cutting started" — not a value the bound's own
 * enforcement depends on).
 *
 * If turns AND edges both trim to empty and the envelope STILL exceeds the
 * bound (`unfittable: true`) — lanes/laneCheckText are large enough on their
 * own to blow it (ticket R2 #2's 600KB-lane-tag repro: turns/edges fully
 * trimmed, ~2.4MB shipped while claiming `applied: 1MB`) — the caller must
 * NOT ship `{turns: [], edges: [], lanes, laneCheckText}` (still oversized):
 * `handleGraphRoute` switches to the refusal-with-summary envelope instead
 * (`buildUnfittableGraphResult`; spec "Budgets and coverage": "413-style 200
 * envelope naming the bound").
 */
function applyGraphByteBound(input: {
  turns: ConsoleGraphTurn[];
  edges: ConsoleGraphEdge[];
  lanes: ConsoleGraphLane[];
  laneCheckText: string;
  scope: unknown;
  asOf: string;
  ctx: ConsoleRequestContext;
  preTrimAppliedBounds: ConsoleAppliedBound[];
  preTrimStateCoverage: "full" | "partial";
}): { turns: ConsoleGraphTurn[]; edges: ConsoleGraphEdge[]; appliedBound: ConsoleAppliedBound | null; unfittable: boolean } {
  const { lanes, laneCheckText, scope, asOf, ctx, preTrimAppliedBounds, preTrimStateCoverage } = input;
  let turns = input.turns;
  let edges = input.edges;

  const noByteTrimMeta = buildMeta({
    scope,
    counts: { turns: turns.length, edges: edges.length, lanes: lanes.length },
    asOf,
    ctx,
    stateCoverage: preTrimStateCoverage,
    appliedBounds: preTrimAppliedBounds,
  });
  const requestedBytes = envelopeBytes(turns, edges, lanes, laneCheckText, noByteTrimMeta);
  if (requestedBytes <= RESPONSE_BYTE_SOFT_MAX) {
    return { turns, edges, appliedBound: null, unfittable: false };
  }

  const appliedBound: ConsoleAppliedBound = {
    bound: "RESPONSE_BYTE_SOFT_MAX",
    requested: requestedBytes,
    applied: RESPONSE_BYTE_SOFT_MAX,
  };
  const finalAppliedBounds = [...preTrimAppliedBounds, appliedBound];
  const metaFor = (t: ConsoleGraphTurn[], e: ConsoleGraphEdge[]): ConsoleMeta =>
    buildMeta({
      scope,
      counts: { turns: t.length, edges: e.length, lanes: lanes.length },
      asOf,
      ctx,
      stateCoverage: "partial",
      appliedBounds: finalAppliedBounds,
    });

  // Trim from the END of each already-sorted array — a stable prefix, one
  // item at a time, re-measuring the FULL envelope (meta included) at every
  // step.
  let bytes = envelopeBytes(turns, edges, lanes, laneCheckText, metaFor(turns, edges));
  while (bytes > RESPONSE_BYTE_SOFT_MAX && edges.length > 0) {
    edges = edges.slice(0, -1);
    bytes = envelopeBytes(turns, edges, lanes, laneCheckText, metaFor(turns, edges));
  }
  while (bytes > RESPONSE_BYTE_SOFT_MAX && turns.length > 0) {
    turns = turns.slice(0, -1);
    bytes = envelopeBytes(turns, edges, lanes, laneCheckText, metaFor(turns, edges));
  }

  return { turns, edges, appliedBound, unfittable: bytes > RESPONSE_BYTE_SOFT_MAX };
}

/**
 * Ticket R2 #2's refusal-with-summary path (spec "Budgets and coverage": a
 * scope the budgets cannot hold returns EITHER a refusal-with-summary
 * ("413-style 200 envelope naming the bound") OR a partial graph — this is
 * the first arm). Reached only when `applyGraphByteBound` trimmed turns AND
 * edges to nothing and the envelope STILL exceeds `RESPONSE_BYTE_SOFT_MAX`:
 * lanes/laneCheckText alone are big enough to blow the bound. Ships the
 * contract's own four keys, never omitted, just emptied (`turns: [] edges:
 * [] lanes: [] laneCheckText: ""`) plus an `error` field naming the bound —
 * never the oversized lanes/laneCheckText themselves, which is exactly the
 * "payload larger than the bound carrying an applied-bound claim" ticket R2
 * rules out. `counts` reports the emptied arrays' own lengths (0/0/0) —
 * same "counts is the literal length of what this response actually
 * carries" convention every other route in this file already follows
 * (see `handleSegmentCardRoute`'s own doc on that point).
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
          `graph scope exceeds RESPONSE_BYTE_SOFT_MAX (${RESPONSE_BYTE_SOFT_MAX} bytes) even with turns and edges fully trimmed; narrow the session range or choose a segment and retry`,
      },
      meta: buildMeta({
        scope: input.scope,
        counts: { turns: 0, edges: 0, lanes: 0 },
        asOf: input.asOf,
        ctx: input.ctx,
        stateCoverage: "partial",
        appliedBounds: input.appliedBounds,
      }),
    },
  };
}

export function handleGraphRoute(
  reader: ConsoleReader,
  url: URL,
  ctx: ConsoleRequestContext,
): ConsoleApiResult {
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
  // turns — no second load.
  const laneCheckText = renderLaneCheckerReports(run.result, buildLaneAnchorAddresses(run.turns));

  // Election preview (ticket 03): per-turn tier from the pure election
  // module, over the SAME projection inputs `checkLanes` just consumed.
  const election = electMilestones(
    run.turns as MilestoneTurnInput[],
    run.edges,
    ELECTION_PREVIEW_BUDGET,
  );
  const tierByTurnId = new Map(election.candidates.map((candidate) => [candidate.id, candidate.tier]));

  const membershipComponentIdByToken = computeMembershipComponentIds(run.result.lanes);
  const { lanesByTurnId, terminusTurnIds, deadTurnIds } = computePerTurnLaneFacts(run.result.lanes);
  const lanes: ConsoleGraphLane[] = run.result.lanes.map((lane) => ({
    segment: lane.key.segment,
    tagSet: [...lane.key.tagSet],
    state: {
      closure: lane.state.closure,
      validity: lane.state.validity,
      terminus: lane.state.terminus,
      lastDeclarer: lane.state.lastDeclarer,
    },
    memberCount: lane.members.length,
    phases: [...lane.phases],
    declarationState: lane.declaration.state,
    declarationTerminus: lane.declaration.terminus,
    membershipComponentId: membershipComponentIdByToken.get(tokenFor(lane))!,
    token: tokenFor(lane),
  }));

  // Every live turn's own segment (defaulting the same way `LaneTurnInput`
  // itself does) — the one extra fact `ConsoleGraphEdge.laneToken` needs
  // beyond what `run.edges` already carries, over the SAME `run.turns` this
  // handler already has in hand (no new reader call).
  const segmentByTurnId = new Map(run.turns.map((turn) => [turn.id, turn.segment ?? DEFAULT_SEGMENT]));

  const sortedTurns = sortTurnsById(run.turns);
  const sortedEdges = sortEdgesForDisplay(run.edges);

  // COUNT caps first, on the bare projection rows — cheapest to check, and
  // shrinks the set `loadTurnDisplayFields` below has to resolve.
  const countBounded = applyGraphCountBounds(sortedTurns, sortedEdges);

  const displayFields = reader.loadTurnDisplayFields(countBounded.turns.map((turn) => turn.id));
  const countCappedTurnsPayload: ConsoleGraphTurn[] = countBounded.turns.map((turn) => {
    const fields = displayFields.get(turn.id);
    return {
      id: turn.id,
      sessionId: fields?.sessionId ?? turn.order?.[0] ?? 0,
      promptNumber: fields?.promptNumber ?? turn.order?.[1] ?? 0,
      title: fields?.title ?? null,
      promptExcerpt: codePointExcerpt(fields?.userPrompt ?? null, EXCERPT_PROMPT_CP),
      contentExcerpt: codePointExcerpt(fields?.content ?? null, EXCERPT_CONTENT_CP),
      electionTier: tierByTurnId.get(turn.id) ?? null,
      type: [...turn.type],
      lanes: lanesByTurnId.get(turn.id) ?? [],
      isTerminus: terminusTurnIds.has(turn.id),
      isDead: deadTurnIds.has(turn.id),
    };
  });
  const countCappedEdgesPayload: ConsoleGraphEdge[] = countBounded.edges.map((edge) => ({
    citingId: edge.citingId,
    citedId: edge.citedId,
    relation: edge.relation,
    tags: [...edge.tags],
    laneToken:
      edge.tags.length > 0
        ? laneToken(segmentByTurnId.get(edge.citingId) ?? DEFAULT_SEGMENT, edge.tags)
        : null,
  }));

  // BYTE cap second, on the fully-built display payload — see
  // `applyGraphByteBound`'s own doc for why it must measure the FINAL
  // envelope (meta included), never a `{turns,edges,lanes,laneCheckText}`
  // stand-in (ticket R2 #2).
  const preByteAppliedBounds = [...preLoadAppliedBounds, ...countBounded.appliedBounds];
  const byteBounded = applyGraphByteBound({
    turns: countCappedTurnsPayload,
    edges: countCappedEdgesPayload,
    lanes,
    laneCheckText,
    scope: scopeDescriptor,
    asOf: run.asOf,
    ctx,
    preTrimAppliedBounds: preByteAppliedBounds,
    preTrimStateCoverage: countBounded.overCap ? "partial" : "full",
  });

  if (byteBounded.unfittable) {
    return buildUnfittableGraphResult({
      scope: scopeDescriptor,
      asOf: run.asOf,
      ctx,
      appliedBounds: [...preByteAppliedBounds, byteBounded.appliedBound!],
    });
  }

  // Ticket R2 #3: endpoint-closed projection. Count caps and byte trims
  // each independently truncate turns/edges (a turn beyond WIDEN_NODE_MAX
  // can drop while the edge naming it survives GRAPH_EDGE_MAX untouched —
  // the reviewer's 2001-turn repro) — this is the ONE place, after every
  // trim path above has run, that restores the invariant: every returned
  // edge's both endpoints exist among returned turns. Filtering here only
  // ever REMOVES edges, so it cannot push the envelope back over the byte
  // bound `applyGraphByteBound` already confirmed above.
  const retainedTurnIds = new Set(byteBounded.turns.map((turn) => turn.id));
  const turnsPayload = byteBounded.turns;
  const edgesPayload = byteBounded.edges.filter(
    (edge) => retainedTurnIds.has(edge.citingId) && retainedTurnIds.has(edge.citedId),
  );

  const appliedBounds = [
    ...preByteAppliedBounds,
    ...(byteBounded.appliedBound ? [byteBounded.appliedBound] : []),
  ];
  // A pre-load `GRAPH_WINDOW_MAX` clamp alone (no post-load overage) still
  // reads as `stateCoverage: "full"`: the CLAMPED request was fully loaded
  // and fully returned — only a post-load truncation drops the
  // lane_check-equivalence claim (spec's own boundary rule is stated
  // entirely in terms of the actual loaded result, never the request shape).
  const stateCoverage: "full" | "partial" =
    countBounded.overCap || byteBounded.appliedBound !== null ? "partial" : "full";

  return {
    status: 200,
    body: {
      turns: turnsPayload,
      edges: edgesPayload,
      lanes,
      laneCheckText,
      meta: buildMeta({
        scope: scopeDescriptor,
        counts: { turns: turnsPayload.length, edges: edgesPayload.length, lanes: lanes.length },
        asOf: run.asOf,
        ctx,
        stateCoverage,
        appliedBounds,
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
