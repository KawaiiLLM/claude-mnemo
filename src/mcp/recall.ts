import type { Database } from "bun:sqlite";

import {
  getObservation,
  getExtractableObservationsForTurn,
} from "../db/observations";
import { searchMemory, type SearchMemoryResult } from "../db/search";
import {
  deriveDominantType,
  rankSegmentMembers,
  resolveSegmentAnchorTurnIds,
  type RankedSegmentMember,
} from "../db/segment-rank";
import {
  countLiveSegments,
  getSegment,
  listLiveSegmentsByActivity,
  listSegmentsByActivity,
  SEGMENT_CONTAINER_ERA_CUTOFF_EPOCH,
  type SegmentRecord,
} from "../db/segments";
import { getSession } from "../db/sessions";
import {
  getFirstTurn,
  getTurn,
  getTurnById,
  getTurnsForSession,
  type TurnRecord,
} from "../db/turns";
import { isSegmentEra } from "../segment-era";
import { resolveSessionTranscriptPath } from "../shared/paths";
import { typeListsEqual } from "../shared/type-vocabulary";

import {
  appendNavigationLegend,
  createTruncationSignal,
  DEFAULT_TURN_RENDER_FIELDS,
  DEFAULT_TURN_TOKEN_BUDGET,
  RENDER_INDENT_STEP,
  REWIND_MARKER,
  renderNode,
  renderSessionTransitionLine,
  renderTurnAddress,
  resolveTurnFields,
  truncateText,
  type FormattedObservation,
  type FormattedSession,
  type FormattedTurn,
  type TruncationSignal,
  type TurnRenderFields,
} from "./format";
import {
  hasFilterCriteria,
  parseMemoryFilter,
  turnMatchesFilter,
  type MemoryFilterInput,
  type ParsedMemoryFilter,
  type RecallTurnField,
} from "./memory-filter";
import { estimateTokens } from "../utils/token-estimate";
import { renderSegmentHeaderLines } from "./segment-spine";
// The `metadata` field slot's one composer (spec 金样例 补充). It lives in
// `timeline.ts` because that module owns this codebase's local-time rendering;
// importing it is what keeps recall from growing a second one.
import { composeTurnMetadata } from "./timeline";
import {
  chronologicalSegmentMembers,
  renderSegmentCard,
  renderSegmentMembersByOrdinal,
  SEGMENT_CARD_DEFAULT_PAGE_BUDGET,
} from "./segment-card";
import { expandNumericSelector } from "./selectors";
import {
  recordReadGrants,
  snapshotWriteGateSequence,
  type ReadGrantEntry,
} from "../db/write-gate";

export interface RecallInput {
  id?: string;
  // Ticket 04 (spec "Tools"): pure full-text search — the in-query prefix
  // dialect (`type:`/`tag:`/`file:`/`session:`/`project:`) is cut, not
  // aliased. A query containing `tag:foo` searches those literal characters.
  query?: string;
  /**
   * Ticket 04: the structured filter grammar shared with `timeline` —
   * {type, tag, session, time, file}, AND-composed with each other, with
   * `id`, and with `query`. Replaces the retired top-level `time` param
   * (folded in as `filter.time`, same grammar) — no non-schema caller in
   * this repo used the old top-level field, so it was cut clean rather than
   * kept as a deprecated alias.
   */
  filter?: MemoryFilterInput;
  page?: number;
  pageSize?: number;
  /**
   * Ticket 03 (spec "Budgets"): the segment card's own token budget (default
   * `SEGMENT_CARD_DEFAULT_PAGE_BUDGET` = 1000). Named distinctly from `page`
   * (the pre-existing 1-indexed page NUMBER, unchanged and still governing
   * item-count pagination everywhere else) precisely so the two do not
   * collide — `page` already has a heavily-tested numeric meaning across
   * every other recall route, and repurposing it would silently break every
   * caller passing `page: 2` to mean "the second page of items". `page`
   * still selects the segment card's own overflow escape (page ≥ 2 disables
   * elision — see `segment-card.ts`'s "stable page 2").
   */
  pageBudget?: number;
  /**
   * Ticket 03/11: per-item token cap (spec "Budgets") — the SOLE size knob
   * left on every rendered session/turn/observation block, default
   * `DEFAULT_TURN_TOKEN_BUDGET` (150). Applies wherever a node renders
   * through `renderNode` (format.ts); word-boundary cut, never a char count.
   */
  turn?: number;
  // Internal worker-only flag. When set, rendered turns append a `dbid:T<dbid>`
  // token so the memory worker can cite a turn it found via recall. NOT exposed
  // on the public `recallInputShape` (definitions.ts) — wired through the
  // handler-construction `audience` option (handlers.ts) instead.
  includeDbTurnIds?: boolean;
  /**
   * P2 era boundary (spec D11). Observations created at or after it render
   * their mechanical fields (tool name + input/result prefixes) because nothing
   * summarizes them any more. `null` — the default — leaves every rendering on
   * the legacy path.
   */
  eraCutoffEpoch?: number | null;
  /**
   * Write gate (ticket 01, read-write-contract spec): the writer identity
   * (`session:<id>`, from `db/write-gate.ts`) whose read grant this render
   * should record for whatever it ends up showing — the "统一渲染器渲染即
   *记录" seam. `undefined`/`null` (every worker/test call site that has no
   * caller identity to attribute a grant to) means "record nothing", same
   * latitude `note`'s own `callerSessionId` gives an unknown caller.
   */
  readerId?: string | null;
  /** Test seam for the read-grant timestamp; defaults to the real clock. */
  now?: () => number;
}

const CHILD_PREVIEW_SIZE = 5;

type RoutedRecallId =
  | { kind: "sessions"; sessionIds?: number[] }
  | { kind: "turns"; sessionId: number; promptNumbers?: number[] }
  | { kind: "turn-by-id"; turnId: number }
  | { kind: "session-observation-list"; sessionId: number }
  | { kind: "observation-list"; sessionId: number; promptNumber: number }
  | { kind: "observation"; observationId: number }
  | { kind: "segments"; segmentIds?: number[] }
  // ticket 03 (spec D9): `E<n>/T<m>` — a segment-scoped member address, `<m>`
  // the member's 1-based EVENT-ORDER ordinal (see segment-card.ts), NOT a
  // session prompt number. Symmetric with `S<n>/T<m>` above, one segment id
  // only (unlike the bare `E` route, which accepts a range/wildcard) —
  // "E31/T5..7" names members within ONE segment, never a cross-segment span.
  | { kind: "segment-members"; segmentId: number; ordinals?: number[] };

function splitInsight(insight: string | null): string[] {
  if (!insight) {
    return [];
  }

  return insight
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^-+\s*/, ""));
}

// ownership-and-note-cadence spec, "session 字段" ([S15069/T910]-[T913]):
// session retires its six task-shaped fields — insight/next_steps/decision/
// done/reference — unconditionally, superseding the older era-gated partial
// retirement (semantic-container ticket 09, which still rendered them on a
// pre-cutoff session). `title` and `content` are the session's only two
// remaining semantic fields; `content` keeps its EXISTING read path
// (including the era gate below) untouched — this ticket does not touch any
// write path, and the settlement-side writer for `content` is a later ticket.
function buildSessionSummaryFields(
  session: NonNullable<ReturnType<typeof getSession>>,
  eraCutoffEpoch: number | null = null,
): Pick<FormattedSession, "content"> {
  if (isSegmentEra(session.createdAtEpoch, eraCutoffEpoch)) {
    return { content: null };
  }

  return { content: session.content };
}

function formatParameterError(message: string): string {
  return `Parameter error: ${message}`;
}

/**
 * Ticket 14 (spec "选择器多选"): echoed on a rejected comma-separated `id`
 * list — either an item that does not parse at all, or a list whose items
 * do not all share the same address kind.
 */
const ID_SELECTOR_GRAMMAR_HINT =
  'each item must be one address: "S<n>", "S<n>/T<m>" (also T*, Ta..b), "E<n>" (also E*, Ea..b), "E<n>/T<m>" (also T*, Ta..b), "T<n>" (global), "O<n>", "S<n>/T<m>/O*", or "S<n>/T*/O*" — every item in the list must be the SAME kind.';

function parseRoutedId(value: string): RoutedRecallId | null {
  const trimmed = value.trim();

  const sessionObservationListMatch = /^S(\d+)\/T\*\/O\*$/i.exec(trimmed);
  if (sessionObservationListMatch) {
    return {
      kind: "session-observation-list",
      sessionId: Number(sessionObservationListMatch[1]),
    };
  }

  const observationListMatch = /^S(\d+)\/T(\d+)\/O\*$/i.exec(trimmed);
  if (observationListMatch) {
    return {
      kind: "observation-list",
      sessionId: Number(observationListMatch[1]),
      promptNumber: Number(observationListMatch[2]),
    };
  }

  const turnMatch = /^S(\d+)\/T(\*|\d+|\d+\.\.[A-Za-z]?\d+)$/i.exec(trimmed);
  if (turnMatch) {
    const promptNumbers = expandNumericSelector(turnMatch[2]!, "T");
    if (promptNumbers === null) {
      return null;
    }

    return {
      kind: "turns",
      sessionId: Number(turnMatch[1]),
      promptNumbers,
    };
  }

  const observationMatch = /^O(\d+)$/i.exec(trimmed);
  if (observationMatch) {
    return {
      kind: "observation",
      observationId: Number(observationMatch[1]),
    };
  }

  // Segment-scoped member route (ticket 03, spec D9): `E31/T5` and
  // `E31/T3..7` — `<m>` is the member's 1-based EVENT-ORDER ordinal within
  // the segment, a navigation handle only (see segment-card.ts). Checked
  // BEFORE the bare segment route below, since that route's own pattern would
  // otherwise stop at the digits and leave a trailing `/T5` unmatched instead
  // of falling through to this one.
  const segmentMemberMatch = /^E(\d+)\/T(\*|\d+|\d+\.\.[A-Za-z]?\d+)$/i.exec(trimmed);
  if (segmentMemberMatch) {
    const ordinals = expandNumericSelector(segmentMemberMatch[2]!, "T");
    if (ordinals === null) {
      return null;
    }
    return {
      kind: "segment-members",
      segmentId: Number(segmentMemberMatch[1]),
      ordinals,
    };
  }

  // Segment route (spec D11): `E47`, and — symmetric with `S` — `E*` and
  // `E1..9`. `E` is the SAME token the write grammar uses (`[E47]`, see
  // db/references.ts), so a citation a settlement wrote is a working address a
  // reader can paste straight back into recall.
  const segmentMatch = /^E(\*|\d+|\d+\.\.[A-Za-z]?\d+)$/i.exec(trimmed);
  if (segmentMatch) {
    const segmentIds = expandNumericSelector(segmentMatch[1]!, "E");
    if (segmentIds === null) {
      return null;
    }

    return { kind: "segments", segmentIds };
  }

  // Global turn-by-DB-id route. Symmetric with `remember({ id: "T<n>" })` (which
  // also uses the DB id) and with the `<turn id="T<n>">` blocks the memory
  // worker sees, so the worker can recall a truncated turn it is extracting. The
  // main agent never uses bare `T<n>` — its output always scopes turns as
  // `S<id>/T<promptNumber>` — so this does not affect the session-scoped route.
  const turnByIdMatch = /^T(\d+)$/i.exec(trimmed);
  if (turnByIdMatch) {
    return {
      kind: "turn-by-id",
      turnId: Number(turnByIdMatch[1]),
    };
  }

  const sessionMatch = /^S(\*|\d+|\d+\.\.[A-Za-z]?\d+)$/i.exec(trimmed);
  if (sessionMatch) {
    const sessionIds = expandNumericSelector(sessionMatch[1]!, "S");
    if (sessionIds === null) {
      return null;
    }

    return {
      kind: "sessions",
      sessionIds,
    };
  }

  return null;
}

function buildSessionView(
  db: Database,
  session: NonNullable<ReturnType<typeof getSession>>,
  eraCutoffEpoch: number | null = null,
): FormattedSession {
  const turns = getTurnsForSession(db, session.id).map((turn) =>
    buildTurnView(db, turn, eraCutoffEpoch),
  );

  return {
    id: session.id,
    title: session.title,
    project: session.project,
    createdAtEpoch: session.createdAtEpoch,
    ...buildSessionSummaryFields(session, eraCutoffEpoch),
    turnCount: turns.length,
    observationCount: turns.reduce(
      (sum, turn) => sum + (turn.observationCount ?? 0),
      0,
    ),
    jsonlPath: resolveSessionTranscriptPath(session),
    turns,
  };
}

function getObservationCountByTurnId(
  db: Database,
  turnIds: number[],
): Map<number, number> {
  if (turnIds.length === 0) {
    return new Map();
  }

  const placeholders = turnIds.map(() => "?").join(", ");
  const rows = db
    .query<{ turnId: number; count: number }, number[]>(
      `SELECT turn_id AS turnId, COUNT(*) AS count
       FROM observations
       WHERE turn_id IN (${placeholders}) AND excluded_from_extraction = 0
       GROUP BY turn_id`,
    )
    .all(...turnIds);

  return new Map(rows.map((row) => [row.turnId, row.count]));
}

export function buildSessionSummary(
  db: Database,
  sessionId: number,
  eraCutoffEpoch: number | null = null,
): FormattedSession | null {
  const session = getSession(db, sessionId);
  if (!session) {
    return null;
  }

  const turnCount =
    db
      .query<{ count: number }, [number]>(
        "SELECT COUNT(*) AS count FROM turns WHERE session_id = ?",
      )
      .get(session.id)?.count ?? 0;
  const observationCount =
    db
      .query<{ count: number }, [number]>(
        `SELECT COUNT(*) AS count
         FROM observations o
         JOIN turns t ON t.id = o.turn_id
         WHERE t.session_id = ? AND o.excluded_from_extraction = 0`,
      )
      .get(session.id)?.count ?? 0;

  return {
    id: session.id,
    title: session.title,
    project: session.project,
    createdAtEpoch: session.createdAtEpoch,
    ...buildSessionSummaryFields(session, eraCutoffEpoch),
    turnCount,
    observationCount,
    jsonlPath: undefined,
  };
}

export function buildCollapsedTurnsForSession(
  db: Database,
  sessionId: number,
): FormattedTurn[] {
  const turns = getTurnsForSession(db, sessionId);
  const observationCounts = getObservationCountByTurnId(
    db,
    turns.map((turn) => turn.id),
  );

  return turns.map((turn) => ({
    id: turn.id,
    promptNumber: turn.promptNumber,
    title: turn.title,
    content: turn.content,
    observationCount: observationCounts.get(turn.id) ?? 0,
    toolCallCount: turn.toolCallCount,
    filesReadCount: turn.filesRead.length,
    filesModifiedCount: turn.filesModified.length,
    status: turn.status,
    wasRolledBack: turn.wasRolledBack,
  }));
}

export function buildFormattedSession(
  db: Database,
  sessionId: number,
  expandTurns: number[] = [],
  eraCutoffEpoch: number | null = null,
): FormattedSession | null {
  const session = getSession(db, sessionId);
  if (!session) {
    return null;
  }

  const turns = getTurnsForSession(db, session.id).map((turn) =>
    buildTurnView(db, turn, eraCutoffEpoch),
  );

  return {
    id: session.id,
    title: session.title,
    project: session.project,
    createdAtEpoch: session.createdAtEpoch,
    ...buildSessionSummaryFields(session, eraCutoffEpoch),
    turnCount: turns.length,
    observationCount: turns.reduce(
      (sum, turn) => sum + (turn.observationCount ?? 0),
      0,
    ),
    jsonlPath: resolveSessionTranscriptPath(session),
    turns: turns.map((turn) =>
      expandTurns.includes(turn.promptNumber)
        ? turn
        : {
            ...turn,
            promptPreview: undefined,
            responsePreview: undefined,
            insight: undefined,
            observations: undefined,
          },
    ),
  };
}

export function buildTurnView(
  db: Database,
  turn: TurnRecord,
  eraCutoffEpoch: number | null = null,
): FormattedTurn {
  // Excluded observations (a `note` call) stay out of every reader-facing view:
  // their count, their ids and their tool names are as much of a leak as their
  // payloads would be — the P1 comparison needs the note channel invisible to
  // the pipeline's own output, and an id here is an id the model can then fetch.
  const observations = getExtractableObservationsForTurn(db, turn.id);
  return {
    id: turn.id,
    promptNumber: turn.promptNumber,
    title: turn.title,
    content: turn.content,
    observationCount: observations.length,
    toolCallCount: turn.toolCallCount,
    filesReadCount: turn.filesRead.length,
    filesModifiedCount: turn.filesModified.length,
    status: turn.status,
    promptPreview: turn.userPrompt,
    responsePreview: turn.assistantResponse,
    insight: splitInsight(turn.insight),
    filesRead: turn.filesRead,
    filesModified: turn.filesModified,
    observations: observations.map((observation) =>
      buildObservationView(observation, turn.createdAtEpoch, eraCutoffEpoch),
    ),
    wasRolledBack: turn.wasRolledBack,
    // No previous-turn epoch here: recall addresses turns by selector, not as
    // a session-ordered walk, so there is no "previous" this builder can name
    // honestly. The gap belongs to timeline's own session-scoped turn view.
    metadata: composeTurnMetadata(turn, null),
  };
}

function previewItems<T>(items: T[], size = 5): { items: T[]; omittedCount: number } {
  return {
    items: items.slice(0, size),
    omittedCount: Math.max(0, items.length - size),
  };
}

function paginateItems<T>(
  items: T[],
  page: number,
  pageSize: number,
): { items: T[]; total: number; pageCount: number } {
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const offset = (page - 1) * pageSize;

  return {
    items: items.slice(offset, offset + pageSize),
    total,
    pageCount,
  };
}

/**
 * Packs `items` into pages by measuring a CANDIDATE page's actual rendered
 * cost via `renderPage`, rather than summing a per-item cost (ticket 03,
 * "pageBudget governs every listing surface at runtime"): several listing
 * surfaces in this file (`renderTurnScope`, `renderObservationScope`,
 * `renderGroupedSearchResults`) rebuild their own session/turn header fresh
 * from whatever items land on a given page, so one item's true marginal
 * cost depends on which page it joins and cannot be priced alone the way
 * `buildBrowseFeed`'s own per-unit packer prices a `BrowseUnit`. Same
 * "items or `pageBudget` tokens, whichever comes first" rule as that packer
 * (a page always holds at least one item, so a single oversized item can
 * never stall pagination) — ticket 03's pinned "one packing rule" applied
 * here with a measurement strategy suited to renderers that regroup a page
 * from scratch instead of rendering each item independently.
 *
 * `renderPage` MUST be side-effect-free: it runs multiple times per item
 * while probing for the boundary, so a caller whose real render records
 * read grants or mutates a `TruncationSignal` passes `readerId: null` /
 * `signal: undefined` here and performs the real, once-only render (with
 * the real values) against the chosen page's items afterward.
 */
function packItemsByRenderedPageCost<T>(
  items: readonly T[],
  pageSize: number,
  pageBudget: number,
  renderPage: (pageItems: T[]) => string,
): T[][] {
  const pages: T[][] = [];
  let current: T[] = [];

  for (const item of items) {
    const candidate = [...current, item];
    const overflowsCount = current.length >= pageSize;
    const overflowsBudget =
      current.length > 0 && estimateTokens(renderPage(candidate)) > pageBudget;

    if (current.length > 0 && (overflowsCount || overflowsBudget)) {
      pages.push(current);
      current = [item];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0 || pages.length === 0) {
    pages.push(current);
  }
  return pages;
}

/**
 * `paginateItems`'s pageBudget-aware sibling (ticket 03). Same offset
 * semantics as `paginateItems` — an out-of-range `page` yields an empty
 * slice, `pageCount` still the true page count, no clamping — but the page
 * boundary itself comes from `packItemsByRenderedPageCost` instead of a
 * pure `pageSize` cut.
 */
function paginateByRenderedPageCost<T>(
  items: readonly T[],
  page: number,
  pageSize: number,
  pageBudget: number,
  renderPage: (pageItems: T[]) => string,
): { items: T[]; total: number; pageCount: number } {
  const pages = packItemsByRenderedPageCost(items, pageSize, pageBudget, renderPage);
  const index = page - 1;
  return {
    items: index >= 0 && index < pages.length ? pages[index]! : [],
    total: items.length,
    pageCount: pages.length,
  };
}

function formatPageHeader(page: number, pageCount: number, total: number): string {
  return `page ${page} / ${pageCount} (total ${total})`;
}

function joinPage(header: string, body: string, pageCount: number): string {
  if (pageCount <= 1) {
    return body;
  }

  return body ? `${header}\n${body}` : header;
}

/**
 * Derives a fork-lineage breadcrumb string for a session with parentSessionId.
 * Returns null for root sessions. Null-tolerant: if the fork turn number cannot
 * be resolved the parenthetical is omitted (just "continues from S<id>").
 */
function deriveBreadcrumb(
  db: Database,
  session: NonNullable<ReturnType<typeof getSession>>,
): string | null {
  if (session.parentSessionId === null) {
    return null;
  }

  const parentRef = `S${session.parentSessionId}`;

  // Attempt to derive the fork turn: first turn of child → its parentTurnId →
  // look up that turn's promptNumber in the parent session.
  const firstTurn = getFirstTurn(db, session.id);
  if (firstTurn !== null && firstTurn.parentTurnId !== null) {
    const forkTurn = getTurnById(db, firstTurn.parentTurnId);
    if (forkTurn !== null) {
      return `continues from ${parentRef} (forked at T${forkTurn.promptNumber})`;
    }
  }

  return `continues from ${parentRef}`;
}

/**
 * `recall(id="S<n>")` — the one full session-DETAIL route. Ticket 11 retired
 * the collapsed/expanded depth switch that used to decide whether this
 * showed a turn preview at all: with no toggle left, it always does (bounded
 * by `CHILD_PREVIEW_SIZE` as before), and always includes the raw transcript
 * pointer — a caller after JUST the session's own summary line, with no
 * turns, uses `filter.fields` to render each previewed turn minimally rather
 * than suppressing the preview outright.
 */
interface RenderedSession {
  text: string;
  /**
   * Write gate (ticket 14, P1-2 fix): the turn ids this render pass actually
   * showed in its own preview — what `recall(id="S<n>")`'s "sessions" branch
   * needs to record grants for alongside the session itself (spec: "S<n>
   * 详情路由(含 turn 预览)... 记录其实际渲染实体的授权").
   */
  turnIds: number[];
}

function renderSession(
  db: Database,
  session: NonNullable<ReturnType<typeof getSession>>,
  fields: TurnRenderFields,
  turnSelector: Set<number> | undefined,
  includeDbTurnIds: boolean | undefined,
  eraCutoffEpoch: number | null = null,
  signal: TruncationSignal | undefined,
  turnBudget: number | undefined,
): RenderedSession {
  const view = buildSessionView(db, session, eraCutoffEpoch);
  const breadcrumb = deriveBreadcrumb(db, session);
  const lines = [
    renderNode(
      { type: "session", value: view },
      { includeRawPointer: true, turnBudget, signal },
    ),
  ];

  if (breadcrumb !== null) {
    lines.push(`${RENDER_INDENT_STEP}${breadcrumb}`);
  }

  const turns = getTurnsForSession(db, session.id).filter((turn) =>
    turnSelector ? turnSelector.has(turn.promptNumber) : true,
  );

  const preview = previewItems(turns, CHILD_PREVIEW_SIZE);
  const turnIds: number[] = [];
  for (const item of preview.items) {
    const turnView = buildTurnView(db, item, eraCutoffEpoch);
    const turnLines = renderNode(
      { type: "turn", value: turnView },
      {
        indent: RENDER_INDENT_STEP,
        fields,
        sessionId: session.id,
        includeDbTurnIds,
        turnBudget,
        signal,
      },
    );
    lines.push(turnLines);
    turnIds.push(item.id);
  }

  if (preview.omittedCount > 0) {
    lines.push(`${RENDER_INDENT_STEP}+${preview.omittedCount} more`);
  }

  return { text: lines.join("\n"), turnIds };
}

function renderTurnScope(
  db: Database,
  turns: TurnRecord[],
  fields: TurnRenderFields,
  includeDbTurnIds?: boolean,
  eraCutoffEpoch: number | null = null,
  signal?: TruncationSignal,
  turnBudget?: number,
): string {
  const lines: string[] = [];
  const grouped = new Map<number, TurnRecord[]>();
  for (const turn of turns) {
    const list = grouped.get(turn.sessionId) ?? [];
    list.push(turn);
    grouped.set(turn.sessionId, list);
  }

  const sessions = Array.from(grouped.keys())
    .map((sessionId) => getSession(db, sessionId))
    .filter(
      (session): session is NonNullable<ReturnType<typeof getSession>> =>
        session !== null,
    );

  for (const session of sessions) {
    const view = buildSessionSummary(db, session.id, eraCutoffEpoch);
    if (!view) {
      continue;
    }
    lines.push(
      renderNode({ type: "session", value: view }, { turnBudget, signal }),
    );

    const sessionTurns = grouped.get(session.id) ?? [];
    for (const item of sessionTurns) {
      const turnView = buildTurnView(db, item, eraCutoffEpoch);
      lines.push(
        renderNode(
          { type: "turn", value: turnView },
          {
            indent: RENDER_INDENT_STEP,
            fields,
            sessionId: session.id,
            includeDbTurnIds,
            signal,
            turnBudget,
          },
        ),
      );
    }
  }

  return lines.join("\n");
}

function renderObservationScope(
  db: Database,
  observations: Array<{ sessionId: number; turnId: number; observationId: number }>,
  includeParents: boolean,
  includeDbTurnIds?: boolean,
  eraCutoffEpoch: number | null = null,
  signal?: TruncationSignal,
  turnBudget?: number,
): string {
  const lines: string[] = [];
  const grouped = new Map<number, Map<number, number[]>>();

  for (const row of observations) {
    const turnMap = grouped.get(row.sessionId) ?? new Map<number, number[]>();
    const list = turnMap.get(row.turnId) ?? [];
    list.push(row.observationId);
    turnMap.set(row.turnId, list);
    grouped.set(row.sessionId, turnMap);
  }

  if (!includeParents) {
    for (const entry of observations) {
      const row = entry;
      const observation = getObservation(db, row.observationId);
      if (!observation) {
        continue;
      }

      const observationView = buildOwnedObservationView(
        db,
        observation,
        eraCutoffEpoch,
      );

      lines.push(
        renderNode(
          { type: "observation", value: observationView },
          { turnBudget, signal },
        ),
      );
    }

    return lines.join("\n");
  }

  const sessions = Array.from(grouped.keys())
    .map((sessionId) => getSession(db, sessionId))
    .filter(
      (session): session is NonNullable<ReturnType<typeof getSession>> =>
        session !== null,
    );

  for (const session of sessions) {
    const sessionView = buildSessionSummary(db, session.id, eraCutoffEpoch);
    if (!sessionView) {
      continue;
    }
    lines.push(
      renderNode({ type: "session", value: sessionView }, { turnBudget, signal }),
    );
    const turnMap = grouped.get(session.id) ?? new Map<number, number[]>();
    const turns = getTurnsForSession(db, session.id).filter((turn) =>
      turnMap.has(turn.id),
    );

    for (const turn of turns) {
      const turnView = buildTurnView(db, turn, eraCutoffEpoch);
      lines.push(
        renderNode(
          { type: "turn", value: turnView },
          {
            indent: RENDER_INDENT_STEP,
            sessionId: session.id,
            includeDbTurnIds,
            turnBudget,
            signal,
          },
        ),
      );

      const observationIds = turnMap.get(turn.id) ?? [];
      for (const observationEntry of observationIds) {
        const observationId = observationEntry;
        const observation = getObservation(db, observationId);
        if (!observation) {
          continue;
        }

        const observationView = buildObservationView(
          observation,
          turn.createdAtEpoch,
          eraCutoffEpoch,
        );

        lines.push(
          renderNode(
            { type: "observation", value: observationView },
            {
              indent: `${RENDER_INDENT_STEP}${RENDER_INDENT_STEP}`,
              sessionId: session.id,
              turnPromptNumber: turn.promptNumber,
              turnBudget,
              signal,
            },
          ),
        );
      }
    }
  }

  return lines.join("\n");
}

/**
 * One observation row. In the segment era the mechanical fields ride along
 * (spec D11): no pipeline summarizes an observation any more, so the tool name
 * and the head of its input and result ARE the row's content. Pre-era rows are
 * untouched — their summary is what they have.
 *
 * `toolName` itself is forwarded on BOTH sides (spec D3): the label/tool-name
 * dedup in format.ts needs to know the tool name regardless of era to decide
 * whether a `tool:` line would just repeat the label above it. It is a name,
 * not a raw call payload, so D5's "no raw tool fields on a legacy row" does not
 * cover it — only `toolInput`/`toolResult` (the actual raw fields) stay gated.
 *
 * The era is decided by `ownerCreatedAtEpoch`, the TURN's timestamp, never the
 * observation's own. An observation has no semantics of its own: whether
 * anything summarized it is a fact about the turn that produced it, and a
 * turn's tool calls straddle whatever instant the cutoff falls on. Reading the
 * observation's own stamp would leak era-only fields out of a legacy turn and
 * hide them inside an era one. A null owner (impossible under the foreign key)
 * reads as legacy — the safe half.
 */
function buildObservationView(
  observation: NonNullable<ReturnType<typeof getObservation>>,
  ownerCreatedAtEpoch: number | null,
  eraCutoffEpoch: number | null = null,
): FormattedObservation {
  const view: FormattedObservation = {
    id: observation.id,
    title: observation.title ?? observation.toolName ?? `Observation ${observation.id}`,
    content: observation.content,
  };

  if (
    ownerCreatedAtEpoch !== null &&
    isSegmentEra(ownerCreatedAtEpoch, eraCutoffEpoch)
  ) {
    view.toolName = observation.toolName;
    view.toolInput = observation.toolInput;
    view.toolResult = observation.toolResult;
  }

  return view;
}

/** `buildObservationView` for a caller that holds the observation but not its turn. */
function buildOwnedObservationView(
  db: Database,
  observation: NonNullable<ReturnType<typeof getObservation>>,
  eraCutoffEpoch: number | null,
): FormattedObservation {
  return buildObservationView(
    observation,
    getTurnById(db, observation.turnId)?.createdAtEpoch ?? null,
    eraCutoffEpoch,
  );
}

function renderSessionDetail(
  db: Database,
  sessionId: number,
  fields: TurnRenderFields,
  includeDbTurnIds: boolean | undefined,
  eraCutoffEpoch: number | null = null,
  signal: TruncationSignal | undefined,
  turnBudget: number | undefined,
): RenderedSession {
  const session = getSession(db, sessionId);
  return session
    ? renderSession(
        db,
        session,
        fields,
        undefined,
        includeDbTurnIds,
        eraCutoffEpoch,
        signal,
        turnBudget,
      )
    : { text: "Session not found.", turnIds: [] };
}

function renderObservationDetail(
  db: Database,
  observationId: number,
  eraCutoffEpoch: number | null = null,
  signal?: TruncationSignal,
  turnBudget?: number,
): string {
  const observation = getObservation(db, observationId);
  // Every listing route already drops excluded rows, so direct addressing must
  // read as "no such observation" too — otherwise the id a listing withheld is
  // still fetchable in full by guessing it.
  if (!observation || observation.excludedFromExtraction !== 0) {
    return "Observation not found.";
  }

  const view = buildOwnedObservationView(db, observation, eraCutoffEpoch);
  return renderNode({ type: "observation", value: view }, { turnBudget, signal });
}

/**
 * Facts a segment's header line reports, all derived from its members: the
 * dominant type (the member-type mode, spec D9's mechanical prior), the phase
 * trace, and the anchor addresses its own body designates.
 */
function buildSegmentFacts(
  db: Database,
  segment: SegmentRecord,
  eraCutoffEpoch: number | null = null,
): {
  memberCount: number;
  dominantType: string | null;
  phaseTrace: string[][];
  anchorRefs: string[];
  members: RankedSegmentMember[];
} {
  const members = rankSegmentMembers(db, segment.id, undefined, eraCutoffEpoch);
  const chronological = [...members].sort((left, right) => {
    if (left.createdAtEpoch !== right.createdAtEpoch) {
      return left.createdAtEpoch - right.createdAtEpoch;
    }
    return left.turnId - right.turnId;
  });

  // Flattened: a multi-valued member contributes every one of its own words
  // to the mode count (spec B5), not just a "first" pick — `deriveDominantType`
  // itself is untouched.
  const dominantType = deriveDominantType(
    chronological.flatMap((member) => member.type),
    segment.type,
  );

  // Consecutive runs of an IDENTICAL type list collapse to one entry (ticket
  // 02, spec B5) — same ordered-list rule the timeline's own phase grouping
  // applies (`typeListsEqual`), so the two "a function switch is not a
  // segment boundary" traces agree on what counts as a boundary.
  const phaseTrace: string[][] = [];
  for (const member of chronological) {
    if (member.type.length === 0) {
      continue;
    }
    const previous = phaseTrace[phaseTrace.length - 1];
    if (!previous || !typeListsEqual(previous, member.type)) {
      phaseTrace.push([...member.type]);
    }
  }

  const byTurnId = new Map(members.map((member) => [member.turnId, member] as const));
  const anchorRefs = resolveSegmentAnchorTurnIds(db, segment)
    .map((turnId) => byTurnId.get(turnId))
    .filter((member): member is RankedSegmentMember => member !== undefined)
    .map((member) => `S${member.sessionId}/T${member.promptNumber}`);

  return {
    memberCount: members.length,
    dominantType,
    phaseTrace,
    anchorRefs,
    members,
  };
}

/** One collapsed `[E<n>]` line, as a search hit renders it — `turnBudget` (tokens) converts to a char limit the same way the browse feed's own field cuts do. */
function renderSegmentSummary(
  db: Database,
  segmentId: number,
  turnBudget: number | undefined,
  eraCutoffEpoch: number | null = null,
): string | null {
  const segment = getSegment(db, segmentId);
  if (!segment) {
    return null;
  }
  const facts = buildSegmentFacts(db, segment, eraCutoffEpoch);
  return renderSegmentHeaderLines({
    segment,
    memberCount: facts.memberCount,
    dominantType: facts.dominantType,
    phaseTrace: facts.phaseTrace,
    anchorRefs: facts.anchorRefs,
    charLimit: Math.max(20, (turnBudget ?? DEFAULT_TURN_TOKEN_BUDGET) * BROWSE_CHARS_PER_TOKEN),
  }).join("\n");
}

function listSegmentIds(db: Database, segmentIds: number[] | undefined): number[] {
  // A single explicit id is a question about THAT segment, so a miss has to be
  // reported rather than silently yielding an empty page; a range or `*` is a
  // listing, where a gap is not an error.
  if (segmentIds && segmentIds.length === 1) {
    return segmentIds;
  }
  if (segmentIds && segmentIds.length > 0) {
    return segmentIds.filter((segmentId) => getSegment(db, segmentId) !== null);
  }
  return db
    .query<{ id: number }, []>("SELECT id FROM segments ORDER BY id DESC")
    .all()
    .map((row) => row.id);
}

/**
 * Ticket 04 (spec "Tools"): `type`/`tag`/`file`/`session` AND-compose with a
 * session-listing id selector (`S*`, `S1..9`, or bare `recall()`) the same
 * way `time` already did before this ticket. A session matches when at
 * least one of ITS turns does (`searchMemory`'s own session-facet clauses,
 * db/search.ts) — reused rather than re-implemented here, so the two
 * "does this session hold such a turn" answers can never drift apart. Plain
 * `after`/`before` narrowing (no other filter member set) keeps the original
 * simple JS-side filter, unchanged from before this ticket.
 */
function listSessionIds(
  db: Database,
  sessionIds: number[] | undefined,
  after?: number,
  before?: number,
  filter?: ParsedMemoryFilter,
): number[] {
  const hasExtraFilter =
    filter !== undefined &&
    (filter.type !== undefined ||
      filter.tag !== undefined ||
      filter.file !== undefined ||
      filter.sessionId !== undefined);

  if (hasExtraFilter) {
    const matched = new Set(
      searchMemory(db, {
        scope: "sessions",
        type: filter!.type,
        tag: filter!.tag,
        file: filter!.file,
        sessionId: filter!.sessionId,
        after,
        before,
      }).map((result) => result.sourceId),
    );
    const candidates =
      sessionIds && sessionIds.length > 0 ? sessionIds : [...matched];
    return candidates.filter((sessionId) => matched.has(sessionId));
  }

  const sessions = sessionIds && sessionIds.length > 0
    ? sessionIds
        .map((sessionId) => getSession(db, sessionId))
        .filter(
          (session): session is NonNullable<ReturnType<typeof getSession>> =>
            session !== null,
        )
    : db
        .query<{ id: number; createdAtEpoch: number }, []>(
          `SELECT id, created_at_epoch AS createdAtEpoch
           FROM sessions
           ORDER BY created_at_epoch DESC`,
        )
        .all()
        .map((row) => getSession(db, row.id))
        .filter(
          (session): session is NonNullable<ReturnType<typeof getSession>> =>
            session !== null,
        );

  return sessions
    .filter((session) => {
      if (after !== undefined && session.createdAtEpoch < after) {
        return false;
      }
      if (before !== undefined && session.createdAtEpoch > before) {
        return false;
      }
      return true;
    })
    .map((session) => session.id);
}

function applyTurnSelector(
  db: Database,
  sessionId: number,
  promptNumbers?: number[],
): TurnRecord[] {
  const turns = getTurnsForSession(db, sessionId);
  if (!promptNumbers || promptNumbers.length === 0) {
    return turns;
  }

  // `S<id>/T<n>` is strictly a session-scoped prompt_number selector. The worker
  // addresses turns by DB id, but it uses the separate global `T<n>` route for
  // that — never overload prompt numbers here (adopted sessions can start at
  // high/gapped prompt numbers, so a DB-id fallback would silently return the
  // wrong turn).
  const selected = new Set(promptNumbers);
  return turns.filter((turn) => selected.has(turn.promptNumber));
}

// ---------------------------------------------------------------------------
// Ticket 08 (read-write-contract spec, "一工具两形态" 搜索半边): matched-term
// bold + neighborhood, replacing the default even-split truncation for a
// search hit's content field. Score order (already `results`' own order —
// `searchQueryResults`/`searchMemory` sort by relevance) is what this
// section preserves through rendering, rather than re-sorting turns back to
// session-chronological order.
// ---------------------------------------------------------------------------

function extractQueryTerms(query: string): string[] {
  return query
    .trim()
    .split(/\s+/)
    .map((term) => term.replace(/["*]/g, ""))
    .filter(Boolean);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Bolds every occurrence of any term inside `text` — a reader scanning a hit sees every matched word, not only the one the window centered on. */
function boldAllTermOccurrences(text: string, terms: readonly string[]): string {
  const escaped = terms.map(escapeRegExp).filter(Boolean);
  if (escaped.length === 0) {
    return text;
  }
  const pattern = new RegExp(`(${escaped.join("|")})`, "gi");
  return text.replace(pattern, "**$1**");
}

/**
 * Matched-term bold + neighborhood (spec: "匹配词加粗+邻域优先展示,替代默认
 * 字段均摊截断;尾部词边界切、两侧均分"). Finds the EARLIEST case-insensitive
 * occurrence of any term; the window is centered there, `windowChars` split
 * evenly across both sides, each side's tail cut at a WORD BOUNDARY (mirrors
 * `truncateText`'s own boundary rule, applied independently left and right).
 * No term found in `text` at all (the FTS hit came from a different field)
 * falls back to the ordinary word-boundary truncate from the start.
 */
export function boldSearchSnippet(
  text: string,
  terms: readonly string[],
  windowChars: number,
  signal?: TruncationSignal,
): string {
  if (terms.length === 0) {
    return truncateText(text, { limit: windowChars, signal });
  }

  const lower = text.toLowerCase();
  let matchStart = -1;
  let matchLength = 0;
  for (const term of terms) {
    if (!term) continue;
    const idx = lower.indexOf(term.toLowerCase());
    if (idx !== -1 && (matchStart === -1 || idx < matchStart)) {
      matchStart = idx;
      matchLength = term.length;
    }
  }

  if (matchStart === -1) {
    return truncateText(text, { limit: windowChars, signal });
  }

  const halfWindow = Math.max(10, Math.floor(windowChars / 2));
  const leftStart = Math.max(0, matchStart - halfWindow);
  const rightEnd = Math.min(text.length, matchStart + matchLength + halfWindow);

  let left = text.slice(leftStart, matchStart);
  let right = text.slice(matchStart + matchLength, rightEnd);
  const matched = text.slice(matchStart, matchStart + matchLength);
  const leftTruncated = leftStart > 0;
  const rightTruncated = rightEnd < text.length;

  // Word-boundary cut on each side independently — keep the END of the left
  // window (adjacent to the match) and the START of the right window.
  if (leftTruncated) {
    const spaceIdx = left.indexOf(" ");
    if (spaceIdx !== -1 && spaceIdx <= left.length * 0.2) {
      left = left.slice(spaceIdx + 1);
    }
  }
  if (rightTruncated) {
    const spaceIdx = right.lastIndexOf(" ");
    if (spaceIdx !== -1 && spaceIdx >= right.length * 0.8) {
      right = right.slice(0, spaceIdx);
    }
  }

  if ((leftTruncated || rightTruncated) && signal) {
    signal.truncated = true;
  }

  const windowText = `${left}${matched}${right}`;
  const bolded = boldAllTermOccurrences(windowText, terms);
  return `${leftTruncated ? "…" : ""}${bolded}${rightTruncated ? "…" : ""}`;
}

/**
 * Shallow-clones a formatted view with its `title`/`content` replaced by a
 * bold+neighborhood snippet — the search-shape's own fields, never mutating
 * the source view. Shared by `FormattedSession` and `FormattedObservation`,
 * whose only indexed text fields are these two (ticket 14, P2-5 fix, spec
 * "搜索加粗覆盖全部被索引字段" — see `withTurnSearchSnippet` for the wider
 * turn shape).
 */
function withBasicSearchSnippet<T extends { title?: string | null; content?: string | null }>(
  view: T,
  terms: readonly string[],
  windowChars: number,
  signal?: TruncationSignal,
): T {
  if (terms.length === 0) {
    return view;
  }
  // `T` is generic — TS cannot prove a spread-and-override object literal is
  // still exactly `T`, so the cast makes explicit what is structurally true
  // (every property of `view` survives the spread; only the two named fields
  // narrow).
  return {
    ...view,
    title: view.title ? boldSearchSnippet(view.title, terms, windowChars, signal) : view.title,
    content: view.content ? boldSearchSnippet(view.content, terms, windowChars, signal) : view.content,
  } as T;
}

/**
 * `withBasicSearchSnippet`'s turn-shaped sibling (ticket 14, P2-5 fix): a
 * turn indexes more than title/content for FTS (`db/search.ts` also matches
 * `user_prompt`/`assistant_response`), and a hit whose matched term lives
 * ONLY in one of those fields used to render with no bold and no
 * neighborhood at all — the matched evidence was invisible. `insight` is a
 * list; each row gets its own independent snippet rather than one window
 * over the joined text, since a match in row 3 should not need rows 1-2's
 * text to eat into its window.
 */
function withTurnSearchSnippet(
  view: FormattedTurn,
  terms: readonly string[],
  windowChars: number,
  signal?: TruncationSignal,
): FormattedTurn {
  if (terms.length === 0) {
    return view;
  }
  return {
    ...view,
    title: view.title ? boldSearchSnippet(view.title, terms, windowChars, signal) : view.title,
    content: view.content ? boldSearchSnippet(view.content, terms, windowChars, signal) : view.content,
    promptPreview: view.promptPreview
      ? boldSearchSnippet(view.promptPreview, terms, windowChars, signal)
      : view.promptPreview,
    responsePreview: view.responsePreview
      ? boldSearchSnippet(view.responsePreview, terms, windowChars, signal)
      : view.responsePreview,
    insight: view.insight?.map((row) => boldSearchSnippet(row, terms, windowChars, signal)),
  };
}

// ---------------------------------------------------------------------------
// Ticket 04 (view-render-repair spec, "命中即展示"): the matched-field probe
// — a per-row check of whether the search's own terms landed inside a turn's
// PROMPT text, reusing the exact term set the bolding above computes. No FTS
// column-attribution machinery: this never asks which indexed column
// produced the FTS hit, only whether the term is present in the field's own
// text.
// ---------------------------------------------------------------------------

/**
 * Whether any of `terms` occurs in `text` at a WORD boundary — the match is
 * not glued to another alphanumeric character on either side. A CJK term has
 * no alphanumeric neighbours to begin with, so the check degrades to a plain
 * substring test there.
 */
function hasWordBoundaryMatch(text: string, terms: readonly string[]): boolean {
  const lower = text.toLowerCase();
  const isWordChar = (ch: string) => /[a-z0-9_]/i.test(ch);
  return terms.some((term) => {
    const needle = term.toLowerCase();
    if (!needle) return false;
    let from = 0;
    for (;;) {
      const idx = lower.indexOf(needle, from);
      if (idx === -1) return false;
      const before = idx > 0 ? lower[idx - 1]! : "";
      const after = idx + needle.length < lower.length ? lower[idx + needle.length]! : "";
      if (!isWordChar(before) && !isWordChar(after)) {
        return true;
      }
      from = idx + 1;
    }
  });
}

/**
 * Which of a turn's match-conditional fields (`format.ts`'s
 * `MATCH_CONDITIONAL_TURN_FIELDS`, currently just `prompt`) contain one of
 * the search's own terms — `turn.userPrompt` is the same raw text
 * `withTurnSearchSnippet` bolds into `promptPreview`. format.ts's own set is
 * the switch that decides which of these actually render; this probe simply
 * reports what matched, so it stays correct even if that set grows.
 */
function matchedTurnFields(turn: TurnRecord, terms: readonly string[]): TurnRenderFields {
  const matched = new Set<RecallTurnField>();
  if (turn.userPrompt && hasWordBoundaryMatch(turn.userPrompt, terms)) {
    matched.add("prompt");
  }
  return matched;
}

function renderGroupedSearchResults(
  db: Database,
  results: SearchMemoryResult[],
  fields: TurnRenderFields,
  turnBudget: number | undefined,
  includeDbTurnIds?: boolean,
  eraCutoffEpoch: number | null = null,
  signal?: TruncationSignal,
  queryText?: string,
  readerId?: string | null,
  now: () => number = () => Math.floor(Date.now() / 1000),
  // Ticket 14 (P1-3 fix): pre-render sequence snapshot, see `renderRoutedId`'s
  // own parameter of the same name.
  sequence: number = 0,
): string {
  const terms = queryText ? extractQueryTerms(queryText) : [];
  // Ticket 11: the snippet window used to be the retired `truncate` char
  // param directly; it is now derived from the `turn` TOKEN budget, same
  // 4-chars-per-token conversion the browse feed's own field cuts use.
  const snippetWindow = Math.max(20, (turnBudget ?? DEFAULT_TURN_TOKEN_BUDGET) * BROWSE_CHARS_PER_TOKEN);
  // Score order (spec: "分数序替代时序"): `results` already arrived in
  // relevance order (`searchQueryResults`) — this map lets turns within a
  // session group render in THAT order (best rank first) instead of
  // `getTurnsForSession`'s chronological one. Ties keep the first (best)
  // rank a turn was seen at, across its possible turn+observation hits.
  const relevanceRank = new Map<number, number>();
  results.forEach((result, index) => {
    if (result.turnId !== null && !relevanceRank.has(result.turnId)) {
      relevanceRank.set(result.turnId, index);
    }
  });
  const grants: ReadGrantEntry[] = [];
  // Segment hits lead: a `tag:` query returns the chapter AND its member turns
  // (spec user story 16), and the chapter is the index into the rest.
  const segmentLines = results
    .filter((result) => result.layer === "segment")
    .map((result) => {
      const line = renderSegmentSummary(db, result.sourceId, turnBudget, eraCutoffEpoch);
      if (line !== null) {
        grants.push({ entityType: "segment", entityId: result.sourceId });
      }
      return line;
    })
    .filter((line): line is string => line !== null);

  const sessionGroups = new Map<
    number,
    {
      sessionHit: boolean;
      turnIds: Set<number>;
      observationIdsByTurnId: Map<number, number[]>;
    }
  >();
  const sessionOrder: number[] = [];

  for (const result of results) {
    if (result.layer === "segment" || result.sessionId === null) {
      continue;
    }
    const sessionId = result.sessionId;
    let group = sessionGroups.get(sessionId);
    if (!group) {
      group = {
        sessionHit: false,
        turnIds: new Set<number>(),
        observationIdsByTurnId: new Map<number, number[]>(),
      };
      sessionGroups.set(sessionId, group);
      sessionOrder.push(sessionId);
    }

    if (result.layer === "session") {
      group.sessionHit = true;
      continue;
    }

    if (result.layer === "turn" && result.turnId !== null) {
      group.turnIds.add(result.turnId);
    }

    if (result.layer === "observation" && result.turnId !== null && result.observationId !== null) {
      const observationIds = group.observationIdsByTurnId.get(result.turnId) ?? [];
      observationIds.push(result.observationId);
      group.observationIdsByTurnId.set(result.turnId, observationIds);
    }
  }

  const sessionLines = sessionOrder.map((sessionId) => {
    const session = getSession(db, sessionId);
    const group = sessionGroups.get(sessionId);
    if (!session || !group) {
      return "";
    }
    grants.push({ entityType: "session", entityId: session.id });

    if (group.sessionHit && group.turnIds.size === 0) {
      // The session itself matched (its own title/content) with no specific
      // turn/observation hit — spec's "命中后的深入=用户用选择器自取,不做±N":
      // this renders the session's own snippet-bolded line, not every turn
      // dragged along underneath it (the old full nested render did).
      const sessionView = withBasicSearchSnippet(
        buildSessionSummary(db, session.id, eraCutoffEpoch) ??
          buildSessionView(db, session, eraCutoffEpoch),
        terms,
        snippetWindow,
        signal,
      );
      return renderNode(
        { type: "session", value: sessionView },
        { turnBudget, signal },
      );
    }

    const sessionView = withBasicSearchSnippet(
      buildSessionSummary(db, session.id, eraCutoffEpoch) ??
        buildSessionView(db, session, eraCutoffEpoch),
      terms,
      snippetWindow,
      signal,
    );
    const lines = [
      renderNode(
        { type: "session", value: sessionView },
        { turnBudget, signal },
      ),
    ];
    // Score order (spec: "分数序替代时序"): turns within this session group
    // render in RELEVANCE order (best rank first), not `getTurnsForSession`'s
    // chronological one — ties (a turn with no direct relevance entry, e.g.
    // pulled in only via an observation hit) fall back to prompt order.
    const turns = getTurnsForSession(db, session.id)
      .filter(
        (turn) =>
          group.turnIds.has(turn.id) || group.observationIdsByTurnId.has(turn.id),
      )
      .sort((left, right) => {
        const leftRank = relevanceRank.get(left.id) ?? Number.POSITIVE_INFINITY;
        const rightRank = relevanceRank.get(right.id) ?? Number.POSITIVE_INFINITY;
        if (leftRank !== rightRank) {
          return leftRank - rightRank;
        }
        return left.promptNumber - right.promptNumber;
      });

    for (const turn of turns) {
      grants.push({ entityType: "turn", entityId: turn.id });
      const turnView = withTurnSearchSnippet(
        buildTurnView(db, turn, eraCutoffEpoch),
        terms,
        snippetWindow,
        signal,
      );
      // A turn pulled in only via an observation hit (never itself a direct
      // turn-layer hit) renders at the DEFAULT field set regardless of what
      // the caller asked for — same "collapsed" floor the pre-ticket-11
      // depth switch gave it; a turn that WAS itself a direct hit gets the
      // caller's own field selection.
      const turnFields =
        group.observationIdsByTurnId.has(turn.id) && !group.turnIds.has(turn.id)
          ? DEFAULT_TURN_RENDER_FIELDS
          : fields;

      lines.push(
        renderNode(
          { type: "turn", value: turnView },
          {
            indent: RENDER_INDENT_STEP,
            fields: turnFields,
            matchedFields: matchedTurnFields(turn, terms),
            sessionId: session.id,
            includeDbTurnIds,
            turnBudget,
            signal,
          },
        ),
      );

      const observationIds = group.observationIdsByTurnId.get(turn.id) ?? [];
      for (const observationId of observationIds) {
        const observation = getObservation(db, observationId);
        if (!observation) {
          continue;
        }

        const observationView = withBasicSearchSnippet(
          buildObservationView(observation, turn.createdAtEpoch, eraCutoffEpoch),
          terms,
          snippetWindow,
          signal,
        );
        lines.push(
          renderNode(
            { type: "observation", value: observationView },
            {
              indent: `${RENDER_INDENT_STEP}${RENDER_INDENT_STEP}`,
              sessionId: session.id,
              turnPromptNumber: turn.promptNumber,
              turnBudget,
              signal,
            },
          ),
        );
      }
    }

    return lines.join("\n");
  });

  // Ticket 08 (read-write-contract spec): the flagged gap — a `query=` render
  // used to record no read grants at all. Every segment/session/turn shown
  // above earns the reader a grant, same as the routed-id paths.
  if (readerId && grants.length > 0) {
    recordReadGrants(db, readerId, grants, now(), sequence);
  }

  return [...segmentLines, ...sessionLines].filter(Boolean).join("\n");
}

function renderRoutedId(
  db: Database,
  routed: RoutedRecallId,
  fields: TurnRenderFields,
  page: number,
  pageSize: number,
  after?: number,
  before?: number,
  includeDbTurnIds?: boolean,
  eraCutoffEpoch: number | null = null,
  signal?: TruncationSignal,
  pageBudget?: number,
  turnBudget?: number,
  // Ticket 04 (spec "Tools"): type/tag/file/session AND-compose with the id
  // selector — wired into the two MULTI-item listing kinds (`sessions`,
  // `turns`) alongside the pre-existing time narrowing above. A single
  // explicit-id address (turn-by-id, one segment, one observation) stays
  // filter-transparent, matching this codebase's existing rule that a
  // direct address is a question about THAT record, never a listing a
  // filter can empty out (see the segment route's own single-id comment
  // below).
  filter: ParsedMemoryFilter = {},
  // Write gate (ticket 01): who this render's grants belong to, and the read
  // path's own time seam. `readerId` absent/null records nothing — see
  // `RecallInput.readerId`.
  readerId?: string | null,
  now: () => number = () => Math.floor(Date.now() / 1000),
  // Ticket 14 (P1-3 fix): the render pass's OWN pre-render sequence snapshot
  // (`snapshotWriteGateSequence`, captured by `recallMemoryBody` before any
  // row is read) — every grant this call records uses THIS value, never a
  // fresh lookup at record time.
  sequence: number = 0,
): string {
  const recordGrants = (entries: readonly ReadGrantEntry[]): void => {
    if (readerId && entries.length > 0) {
      recordReadGrants(db, readerId, entries, now(), sequence);
    }
  };

  if (routed.kind === "sessions") {
    const paged = paginateItems(
      listSessionIds(db, routed.sessionIds, after, before, filter),
      page,
      pageSize,
    );

    const rendered = paged.items.map((sessionId) => ({
      sessionId,
      ...renderSessionDetail(
        db,
        sessionId,
        fields,
        includeDbTurnIds,
        eraCutoffEpoch,
        signal,
        turnBudget,
      ),
    }));

    // Write gate (ticket 14, P1-2 fix): the session itself, plus whichever
    // turns its own preview actually rendered (spec: "S<n> 详情路由(含 turn
    // 预览)... 记录其实际渲染实体的授权" — the prior state recorded nothing
    // at all for this route).
    recordGrants(
      rendered.flatMap((entry) => [
        { entityType: "session" as const, entityId: entry.sessionId },
        ...entry.turnIds.map((turnId) => ({ entityType: "turn" as const, entityId: turnId })),
      ]),
    );

    return joinPage(
      formatPageHeader(page, paged.pageCount, paged.total),
      rendered.map((entry) => entry.text).join("\n"),
      paged.pageCount,
    );
  }

  if (routed.kind === "segments") {
    // A single explicit id (`E<n>`, not a range/wildcard): `page` is
    // reinterpreted for THIS one segment's own card — it selects between the
    // elided collapsed render (page 1) and the full, un-elided one (page 2+,
    // spec "Overflow ALWAYS paginates... stable page 2") — rather than
    // picking which of several records to show, since there is only one.
    if (routed.segmentIds && routed.segmentIds.length === 1) {
      recordGrants([{ entityType: "segment", entityId: routed.segmentIds[0]! }]);
      return renderSegmentCard(db, routed.segmentIds[0]!, {
        pageBudget,
        page,
        turnBudget,
        includeDbTurnIds,
        eraCutoffEpoch,
        signal,
      });
    }

    // `E*` / `E1..9`: the OUTER pagination (page/pageSize) still selects
    // WHICH segment records appear, unchanged from before ticket 03 — each
    // one then renders its own card at (elision) page 1.
    const paged = paginateItems(
      listSegmentIds(db, routed.segmentIds),
      page,
      pageSize,
    );
    recordGrants(paged.items.map((segmentId) => ({ entityType: "segment", entityId: segmentId })));

    return joinPage(
      formatPageHeader(page, paged.pageCount, paged.total),
      paged.items
        .map((segmentId) =>
          renderSegmentCard(db, segmentId, {
            pageBudget,
            page: 1,
            turnBudget,
            includeDbTurnIds,
            eraCutoffEpoch,
            signal,
          }),
        )
        .join("\n"),
      paged.pageCount,
    );
  }

  if (routed.kind === "segment-members") {
    const segment = getSegment(db, routed.segmentId);
    if (!segment) {
      return "Segment not found.";
    }
    // Paginate by MEMBER (never mid-turn by line): resolve the requested
    // ordinals up front — an empty selector means every member, matching the
    // `S<n>/T*` convention — then page that ordinal list itself, so a large
    // range (`E31/T1..80`) still respects `pageSize` the same way `S<n>/T*`
    // does.
    const chronologicalMembers = chronologicalSegmentMembers(db, segment, eraCutoffEpoch);
    const wantedOrdinals =
      routed.ordinals && routed.ordinals.length > 0
        ? routed.ordinals
        : chronologicalMembers.map((_member, index) => index + 1);
    const paged = paginateItems(wantedOrdinals, page, pageSize);
    // The segment itself, plus the specific member turns THIS page actually
    // shows — a reader can address those members individually via
    // `S<n>/T<m>` from here on.
    recordGrants([
      { entityType: "segment", entityId: segment.id },
      ...paged.items
        .map((ordinal) => chronologicalMembers[ordinal - 1])
        .filter((member): member is NonNullable<typeof member> => member !== undefined)
        .map((member) => ({ entityType: "turn" as const, entityId: member.turnId })),
    ]);

    // The member one slot BEFORE this page's first — what tells the renderer
    // whether the page opens mid-session-run (spec 补充裁决 "跨页引用自足").
    const firstOrdinal = paged.items[0];
    const precedingSessionId =
      firstOrdinal !== undefined && firstOrdinal > 1
        ? chronologicalMembers[firstOrdinal - 2]?.sessionId ?? null
        : null;

    return joinPage(
      formatPageHeader(page, paged.pageCount, paged.total),
      renderSegmentMembersByOrdinal(db, routed.segmentId, paged.items, {
        fields,
        includeDbTurnIds,
        turnBudget,
        eraCutoffEpoch,
        signal,
        precedingSessionId,
      }),
      paged.pageCount,
    );
  }

  if (routed.kind === "turns") {
    const turns = applyTurnSelector(db, routed.sessionId, routed.promptNumbers).filter((turn) => {
      if (after !== undefined && turn.createdAtEpoch < after) {
        return false;
      }
      if (before !== undefined && turn.createdAtEpoch > before) {
        return false;
      }
      return turnMatchesFilter(turn, filter);
    });
    // Ticket 03: pageBudget can now force an earlier split than `pageSize`
    // alone — measured by trial-rendering candidate pages with `signal`
    // suppressed (`renderTurnScope` has no other side effect), then the
    // real render below (with the real `signal`) runs once against the
    // chosen page's items.
    const paged = paginateByRenderedPageCost(
      turns,
      page,
      pageSize,
      pageBudget ?? SEGMENT_CARD_DEFAULT_PAGE_BUDGET,
      (pageItems) =>
        renderTurnScope(db, pageItems, fields, includeDbTurnIds, eraCutoffEpoch, undefined, turnBudget),
    );
    recordGrants(paged.items.map((turn) => ({ entityType: "turn" as const, entityId: turn.id })));
    return joinPage(
      formatPageHeader(page, paged.pageCount, paged.total),
      renderTurnScope(
        db,
        paged.items,
        fields,
        includeDbTurnIds,
        eraCutoffEpoch,
        signal,
        turnBudget,
      ),
      paged.pageCount,
    );
  }

  if (routed.kind === "turn-by-id") {
    const turn = getTurnById(db, routed.turnId);
    if (!turn) {
      return "Turn not found.";
    }
    recordGrants([{ entityType: "turn", entityId: turn.id }]);
    return renderTurnScope(
      db,
      [turn],
      fields,
      includeDbTurnIds,
      eraCutoffEpoch,
      signal,
      turnBudget,
    );
  }

  if (routed.kind === "observation-list") {
    const turn = getTurn(db, routed.sessionId, routed.promptNumber);
    if (!turn) {
      return "Turn not found.";
    }

    // Write gate (ticket 14, P1-2 fix): the O* route's own turn/session
    // context — not the observations themselves, which carry no gated entity
    // type (spec: "O* 观察路由(其 turn/session context)").
    recordGrants([
      { entityType: "turn", entityId: turn.id },
      { entityType: "session", entityId: routed.sessionId },
    ]);

    const observations = getExtractableObservationsForTurn(db, turn.id)
      .filter((observation) => {
        if (after !== undefined && observation.createdAtEpoch < after) {
          return false;
        }
        if (before !== undefined && observation.createdAtEpoch > before) {
          return false;
        }
        return true;
      })
      .map((observation) => ({
        sessionId: routed.sessionId,
        turnId: turn.id,
        observationId: observation.id,
      }));

    // Ticket 03: same trial-render / real-render split as the `turns` route
    // above — `renderObservationScope` has no side effect of its own to
    // suppress besides `signal`.
    const paged = paginateByRenderedPageCost(
      observations,
      page,
      pageSize,
      pageBudget ?? SEGMENT_CARD_DEFAULT_PAGE_BUDGET,
      (pageItems) =>
        renderObservationScope(db, pageItems, true, includeDbTurnIds, eraCutoffEpoch, undefined, turnBudget),
    );
    return joinPage(
      formatPageHeader(page, paged.pageCount, paged.total),
      renderObservationScope(
        db,
        paged.items,
        true,
        includeDbTurnIds,
        eraCutoffEpoch,
        signal,
        turnBudget,
      ),
      paged.pageCount,
    );
  }

  if (routed.kind === "session-observation-list") {
    const observations = getTurnsForSession(db, routed.sessionId)
      .flatMap((turn) =>
        getExtractableObservationsForTurn(db, turn.id)
          .filter((observation) => {
            if (after !== undefined && observation.createdAtEpoch < after) {
              return false;
            }
            if (before !== undefined && observation.createdAtEpoch > before) {
              return false;
            }
            return true;
          })
          .map((observation) => ({
            sessionId: routed.sessionId,
            turnId: turn.id,
            observationId: observation.id,
          })),
      );

    // Ticket 03: same trial-render / real-render split as the other two
    // routes above.
    const paged = paginateByRenderedPageCost(
      observations,
      page,
      pageSize,
      pageBudget ?? SEGMENT_CARD_DEFAULT_PAGE_BUDGET,
      (pageItems) =>
        renderObservationScope(db, pageItems, true, includeDbTurnIds, eraCutoffEpoch, undefined, turnBudget),
    );
    // Write gate (ticket 14, P1-2 fix): the session, plus exactly the turns
    // THIS page's own observation rows belong to — never every turn the
    // session has, since pagination may show only a slice of them.
    recordGrants([
      { entityType: "session", entityId: routed.sessionId },
      ...[...new Set(paged.items.map((entry) => entry.turnId))].map((turnId) => ({
        entityType: "turn" as const,
        entityId: turnId,
      })),
    ]);
    return joinPage(
      formatPageHeader(page, paged.pageCount, paged.total),
      renderObservationScope(
        db,
        paged.items,
        true,
        includeDbTurnIds,
        eraCutoffEpoch,
        signal,
        turnBudget,
      ),
      paged.pageCount,
    );
  }

  if (routed.kind === "observation") {
    // Write gate (ticket 14, P1-2 fix): the observation's own owning turn/
    // session context — the observation itself has no gated entity type
    // (only segment/turn/session are managed write surfaces). Mirrors
    // `renderObservationDetail`'s own "excluded reads as not found" rule so a
    // grant is never recorded for a row the render did not actually show.
    const observation = getObservation(db, routed.observationId);
    if (observation && observation.excludedFromExtraction === 0) {
      const owningTurn = getTurnById(db, observation.turnId);
      if (owningTurn) {
        recordGrants([
          { entityType: "turn", entityId: owningTurn.id },
          { entityType: "session", entityId: owningTurn.sessionId },
        ]);
      }
    }
    return renderObservationDetail(
      db,
      routed.observationId,
      eraCutoffEpoch,
      signal,
      turnBudget,
    );
  }

  routed satisfies never;
  return formatParameterError(`unrecognized id kind`);
}

// ---------------------------------------------------------------------------
// Ticket 07 (read-write-contract spec, "视图(读面)"): the browse shape — bare
// `recall()` (no `id`, no `query`, no SCOPING filter — see `hasFilterCriteria`)
// renders a GLOBAL chronological turn feed instead of session-grouped
// listing. A session's title shows only on its FIRST appearance ON THE PAGE
// (spec user story 16); an alternation back to an already-shown session does
// not repeat it. `pageBudget` bounds a page by TOKENS — overflow rolls to
// another page, never truncating a shown block (spec: "溢出→分页,绝不截断整
// 块"). `turn` is the one per-field knife: word-boundary cut, its budget
// split evenly across whichever fields `filter.fields` selected (default
// title+content, mirroring the retired collapsed field-set).
// ---------------------------------------------------------------------------

const DEFAULT_BROWSE_FIELDS: readonly RecallTurnField[] = ["title", "content"];

/**
 * Bounded working set fetched before packing into pages. Not a full-corpus
 * scan: this project's own comments elsewhere size a session/segment at "a
 * few dozen or a few hundred" turns, so 500 of the MOST RECENT turns is
 * generous headroom for the browse feed's own default page. A corpus beyond
 * this cap loses turns older than the 500th most recent to the browse feed
 * specifically — they stay fully reachable by `id=`/`query=` addressing.
 */
const BROWSE_CANDIDATE_CAP = 500;

/** Approximate chars-per-token used only to size the per-field WORD-BOUNDARY cut — a guidance ratio, not the hard pageBudget ceiling that actually governs overflow. */
const BROWSE_CHARS_PER_TOKEN = 4;

function browseFieldText(
  db: Database,
  turn: TurnRecord,
  field: RecallTurnField,
): string | null {
  switch (field) {
    case "title":
      return turn.title;
    case "content":
      return turn.content;
    case "prompt":
      return turn.userPrompt;
    case "response":
      return turn.assistantResponse;
    case "insight": {
      const lines = splitInsight(turn.insight);
      return lines.length > 0 ? lines.join("; ") : null;
    }
    case "files": {
      const files = [...turn.filesRead, ...turn.filesModified];
      return files.length > 0 ? files.join(", ") : null;
    }
    case "observations": {
      const count = getExtractableObservationsForTurn(db, turn.id).length;
      return count > 0 ? `${count} observation${count === 1 ? "" : "s"}` : null;
    }
    case "metadata":
      // No previous-turn epoch in a GLOBAL chronological feed: the unit before
      // this one is usually another session's turn, and a gap measured across
      // that boundary would be a number about nothing. The timeline's own turn
      // view, which is session-scoped, is where the gap belongs.
      return composeTurnMetadata(turn, null);
    default:
      return null;
  }
}

const BROWSE_TURN_INDENT = RENDER_INDENT_STEP;
const BROWSE_FIELD_INDENT = `${RENDER_INDENT_STEP}${RENDER_INDENT_STEP}`;

/**
 * The browse row's label (spec 金样例): the bracketed address, the turn's own
 * identifying text, then tail status markers. `title` never renders as a field
 * line here — it IS the row — so the label falls back to the prompt the same
 * way `format.ts`'s own turn label does when no title is stored.
 */
function formatBrowseTurnLabel(
  turn: TurnRecord,
  sessionId: number,
  includeSessionPrefix: boolean,
  includeDbTurnIds: boolean,
  titleText: string | null,
): string {
  const address = renderTurnAddress(turn.promptNumber, sessionId, includeSessionPrefix);
  const label = titleText ?? (turn.userPrompt ? `"${turn.userPrompt.replace(/\s+/g, " ").trim()}"` : "Untitled");
  const dbIdSegment = includeDbTurnIds ? ` dbid:T${turn.id}` : "";
  const statusSegment = turn.status ? ` [${turn.status}]` : "";
  const rewindSegment = turn.wasRolledBack ? REWIND_MARKER : "";
  return `${BROWSE_TURN_INDENT}${address} ${label}${statusSegment}${dbIdSegment}${rewindSegment}`;
}

/**
 * One turn's field-selected render (spec: "turn = 唯一刀,词边界截断,均摊 across
 * 选中字段"). `turnBudget` (tokens) is split evenly across however many of
 * the selected fields actually produced text; each field's own cut is
 * word-boundary (`truncateText`, reused — its own limit is characters, so
 * the token budget is converted via `BROWSE_CHARS_PER_TOKEN`).
 */
function renderBrowseTurnBlock(
  db: Database,
  turn: TurnRecord,
  sessionId: number,
  fields: readonly RecallTurnField[],
  includeSessionPrefix: boolean,
  includeDbTurnIds: boolean,
  turnBudget: number | undefined,
  signal: TruncationSignal | undefined,
): string {
  const titleText = fields.includes("title") ? turn.title : null;
  const label = formatBrowseTurnLabel(
    turn,
    sessionId,
    includeSessionPrefix,
    includeDbTurnIds,
    titleText,
  );
  // `title` never renders as a field line — it is the row label above.
  const values = fields.flatMap((field) => {
    if (field === "title") {
      return [];
    }
    const text = browseFieldText(db, turn, field);
    return text ? [{ field, text }] : [];
  });

  if (values.length === 0) {
    return label;
  }

  const perFieldCharLimit =
    turnBudget !== undefined
      ? Math.max(20, Math.floor((turnBudget * BROWSE_CHARS_PER_TOKEN) / values.length))
      : undefined;

  const fieldLines = values.map(({ field, text }) => {
    const rendered =
      perFieldCharLimit !== undefined
        ? truncateText(text, { limit: perFieldCharLimit, signal })
        : text;
    // `metadata` is the one unprefixed field line (spec 金样例 补充): it
    // annotates the row above rather than naming a stored field.
    return field === "metadata"
      ? `${BROWSE_FIELD_INDENT}${rendered}`
      : `${BROWSE_FIELD_INDENT}- ${field}: ${rendered}`;
  });

  return [label, ...fieldLines].join("\n");
}

function renderBrowseSessionHeader(
  session: NonNullable<ReturnType<typeof getSession>>,
  withTitle: boolean,
): string {
  return renderSessionTransitionLine(session.id, withTitle ? session.title : null);
}

/**
 * One browsable unit: a turn (the common case) or a SESSION WITH NO TURNS AT
 * ALL YET (a freshly created session that has not produced a turn). Without
 * this second kind, a turn-only feed would silently drop such a session from
 * discoverability entirely — the pre-ticket-07 session-grouped listing
 * always showed every session's own line regardless of turn count, and bare
 * `recall()` must keep that guarantee.
 */
type BrowseUnit =
  | { kind: "turn"; epoch: number; turn: TurnRecord }
  | { kind: "session"; epoch: number; session: NonNullable<ReturnType<typeof getSession>> };

interface BrowsePackedUnit {
  unit: BrowseUnit;
  rendered: string;
}

function browseUnitSessionId(unit: BrowseUnit): number {
  return unit.kind === "turn" ? unit.turn.sessionId : unit.session.id;
}

interface PagePackEntry<T> {
  item: T;
  rendered: string;
}

/**
 * Greedy token-budget page packer (ticket 03): consecutive items fill a
 * page until either `pageSize` items or `budgetTokens` tokens is reached,
 * whichever comes first — a page always holds at least one item, so a
 * single oversized item cannot stall pagination. `render(item, atPageTop)`
 * renders an item KNOWING whether it opens a fresh page, which is what lets
 * a caller give the opening row of a page its self-contained form (spec 补充
 * 裁决 "跨页引用自足") instead of a form that assumes the previous item is
 * still on screen. `onPageStart` resets any page-scoped render state (e.g.
 * "have we shown this session's title yet in THIS page") between pages;
 * `onItemPacked` runs exactly once per item, after it lands on a page
 * (never twice, even though `render` itself may run twice for an item that
 * turns out to open a new page).
 *
 * Extracted from `buildBrowseFeed`'s own inline loop — the ONE packing
 * mechanism this file has (ticket 03 pinned decision: "no second packing
 * algorithm"); `buildBrowseFeed` below is this function's first caller, not
 * a parallel implementation of the same rule.
 */
function packPagesByTokenBudget<T>(
  items: readonly T[],
  pageSize: number,
  budgetTokens: number,
  render: (item: T, atPageTop: boolean) => string,
  onPageStart: () => void,
  onItemPacked: (item: T) => void,
): PagePackEntry<T>[][] {
  const pages: PagePackEntry<T>[][] = [];
  let current: PagePackEntry<T>[] = [];
  let used = 0;

  for (const item of items) {
    let rendered = render(item, current.length === 0);
    let cost = estimateTokens(rendered);
    const overflowsCount = current.length >= pageSize;
    const overflowsBudget = current.length > 0 && used + cost > budgetTokens;

    if (current.length > 0 && (overflowsCount || overflowsBudget)) {
      pages.push(current);
      current = [];
      used = 0;
      onPageStart();
      rendered = render(item, true);
      cost = estimateTokens(rendered);
    }

    current.push({ item, rendered });
    used += cost;
    onItemPacked(item);
  }
  if (current.length > 0 || pages.length === 0) {
    pages.push(current);
  }
  return pages;
}

/**
 * Builds and paginates the global chronological feed. Greedy token-budget
 * packing (same shape as `timeline.ts`'s `paginateByTokenBudget`):
 * consecutive units (most-recent first) fill a page until either `pageSize`
 * items or `pageBudget` tokens is reached, whichever comes first — a page
 * always holds at least one item, so a single oversized turn cannot stall
 * pagination. Every packed page independently tracks its own
 * first-appearance set, which is what makes "session title on first
 * appearance, not repeated on alternation" a per-PAGE fact.
 */
function buildBrowseFeed(
  db: Database,
  page: number,
  pageSize: number,
  pageBudget: number,
  turnBudget: number | undefined,
  fields: readonly RecallTurnField[] | undefined,
  includeDbTurnIds: boolean,
  signal: TruncationSignal | undefined,
  readerId: string | null | undefined,
  now: () => number,
  // Ticket 14 (P1-3 fix): pre-render sequence snapshot.
  sequence: number,
): string {
  const turnIdRows = db
    .query<{ id: number }, [number]>(
      `SELECT id FROM turns ORDER BY created_at_epoch DESC, id DESC LIMIT ?`,
    )
    .all(BROWSE_CANDIDATE_CAP);
  const turnUnits: BrowseUnit[] = turnIdRows
    .map((row) => getTurnById(db, row.id))
    .filter((turn): turn is TurnRecord => turn !== null)
    .map((turn) => ({ kind: "turn", epoch: turn.createdAtEpoch, turn }));

  // Sessions with no turn at all yet — kept as their own browse unit so
  // discoverability matches the pre-ticket-07 listing exactly.
  const emptySessionRows = db
    .query<{ id: number; createdAtEpoch: number }, [number]>(
      `SELECT id, created_at_epoch AS createdAtEpoch FROM sessions
       WHERE id NOT IN (SELECT DISTINCT session_id FROM turns)
       ORDER BY created_at_epoch DESC LIMIT ?`,
    )
    .all(BROWSE_CANDIDATE_CAP);
  const sessionCache = new Map<number, ReturnType<typeof getSession>>();
  const sessionFor = (sessionId: number) => {
    if (!sessionCache.has(sessionId)) {
      sessionCache.set(sessionId, getSession(db, sessionId));
    }
    return sessionCache.get(sessionId) ?? null;
  };
  const emptySessionUnits: BrowseUnit[] = emptySessionRows.flatMap((row) => {
    const session = sessionFor(row.id);
    return session ? [{ kind: "session" as const, epoch: row.createdAtEpoch, session }] : [];
  });

  const units = [...turnUnits, ...emptySessionUnits].sort((left, right) => {
    if (left.epoch !== right.epoch) {
      return right.epoch - left.epoch;
    }
    return browseUnitSessionId(right) - browseUnitSessionId(left);
  });

  if (units.length === 0) {
    return joinPage(formatPageHeader(1, 1, 0), "", 1);
  }

  const resolvedFields = fields && fields.length > 0 ? fields : DEFAULT_BROWSE_FIELDS;

  /**
   * `carriedSessionId` is the session the PREVIOUS page ended inside. When
   * this page's first unit belongs to it, the run continues across the page
   * break: no transition line is repeated, and the row carries the full
   * `[S<n>][T<m>]` address instead, so the page stays self-contained for a
   * citation join (spec 补充裁决 "跨页引用自足").
   */
  /**
   * A transition line is emitted on every session CHANGE, carrying the title
   * only on that session's FIRST appearance in the page (spec 金样例) — an
   * alternation back to a session already shown gets a bare `[S<n>]`, which is
   * what keeps the reader's "whose turn is this" answer on-screen without
   * paying for the title twice.
   *
   * `runSessionId` is the session the previous unit belonged to; at the top of
   * a page it is the session the PREVIOUS PAGE ended inside, so a run that
   * spans the page break repeats no transition line and instead gives the
   * opening row the full `[S<n>][T<m>]` address (spec 补充裁决 "跨页引用自足").
   */
  const renderForPage = (
    unit: BrowseUnit,
    seenSessions: ReadonlySet<number>,
    runSessionId: number | null,
    atPageTop: boolean,
  ): string => {
    const sessionId = browseUnitSessionId(unit);
    const continuesRun = runSessionId === sessionId;
    const header = continuesRun
      ? null
      : renderBrowseSessionHeader(
          unit.kind === "session" ? unit.session : sessionFor(sessionId)!,
          !seenSessions.has(sessionId),
        );
    if (unit.kind === "session") {
      // The transition line IS the whole render for a turnless session — there
      // is no turn body to show.
      return header ?? "";
    }
    const session = sessionFor(unit.turn.sessionId);
    if (!session) {
      return "";
    }
    const block = renderBrowseTurnBlock(
      db,
      unit.turn,
      session.id,
      resolvedFields,
      continuesRun && atPageTop,
      includeDbTurnIds,
      turnBudget,
      signal,
    );
    return header === null ? block : `${header}\n${block}`;
  };

  const validUnits = units.filter(
    (unit) => !(unit.kind === "turn" && !sessionFor(unit.turn.sessionId)),
  );

  let seenInPage = new Set<number>();
  let runSessionId: number | null = null;

  // Ticket 03: the packing LOOP itself now lives in `packPagesByTokenBudget`
  // (extracted, byte-identical behavior) — this closure supplies only the
  // browse-specific per-page render state (`seenInPage`, `runSessionId`)
  // that decides title-on-first-appearance and the cross-page citation
  // escape.
  const packed = packPagesByTokenBudget(
    validUnits,
    pageSize,
    pageBudget,
    (unit, atPageTop) => renderForPage(unit, seenInPage, runSessionId, atPageTop),
    () => {
      seenInPage = new Set();
    },
    (unit) => {
      seenInPage.add(browseUnitSessionId(unit));
      runSessionId = browseUnitSessionId(unit);
    },
  );

  const pages: BrowsePackedUnit[][] = packed.map((pageEntries) =>
    pageEntries.map(({ item, rendered }) => ({ unit: item, rendered })),
  );

  const pageCount = pages.length;
  const clampedPage = Math.min(Math.max(1, page), pageCount);
  const pageItems = pages[clampedPage - 1] ?? [];

  if (readerId && pageItems.length > 0) {
    const grants: ReadGrantEntry[] = [];
    const grantedSessions = new Set<number>();
    for (const item of pageItems) {
      const sessionId = browseUnitSessionId(item.unit);
      if (item.unit.kind === "turn") {
        grants.push({ entityType: "turn", entityId: item.unit.turn.id });
      }
      if (!grantedSessions.has(sessionId)) {
        grantedSessions.add(sessionId);
        grants.push({ entityType: "session", entityId: sessionId });
      }
    }
    recordReadGrants(db, readerId, grants, now(), sequence);
  }

  return joinPage(
    formatPageHeader(clampedPage, pageCount, units.length),
    pageItems.map((item) => item.rendered).filter(Boolean).join("\n"),
    pageCount,
  );
}

/**
 * Bare `recall()` — no `id`, no `query` (ticket 03, spec user story 18):
 * segments lead, the browse turn feed follows. Segments are recency-ordered
 * by last member-or-state edit (`listSegmentsByActivity`, ADR-0005's roster
 * rule) and bounded by `pageSize`, same as the roster is budget-truncated;
 * the section only appears on page 1 — later pages are pure browse-feed
 * pagination, so a caller paging through turns never sees the segments
 * header repeat.
 *
 * Ticket 07 (read-write-contract spec): the sessions section retired in
 * favour of `buildBrowseFeed`'s global chronological turn feed — see that
 * function's own doc comment.
 */
function renderBareOverview(
  db: Database,
  page: number,
  pageSize: number,
  includeDbTurnIds?: boolean,
  eraCutoffEpoch: number | null = null,
  signal?: TruncationSignal,
  pageBudget?: number,
  turnBudget?: number,
  // Ticket 04: the segments section above is ticket 02/03/05 territory and
  // stays unfiltered — bare `recall()`'s roster-first behavior is unchanged.
  // Reached here only with no SCOPING criterion set (`hasFilterCriteria`
  // gates the caller before this function runs) — `filter.fields` is the
  // only member that can legitimately be set.
  filter: ParsedMemoryFilter = {},
  readerId?: string | null,
  now: () => number = () => Math.floor(Date.now() / 1000),
  // Ticket 14 (P1-3 fix): pre-render sequence snapshot.
  sequence: number = 0,
): string {
  const parts: string[] = [];

  if (page === 1) {
    const segments = listSegmentsByActivity(db, pageSize);
    if (segments.length > 0) {
      parts.push(`── segments (${segments.length}) ──`);
      for (const segment of segments) {
        if (readerId) {
          recordReadGrants(
            db,
            readerId,
            [{ entityType: "segment", entityId: segment.id }],
            now(),
            sequence,
          );
        }
        parts.push(
          renderSegmentCard(db, segment.id, {
            pageBudget,
            page: 1,
            turnBudget,
            includeDbTurnIds,
            eraCutoffEpoch,
            signal,
          }),
        );
      }
    }
  }

  parts.push(`── turns ──`);
  parts.push(
    buildBrowseFeed(
      db,
      page,
      pageSize,
      pageBudget ?? SEGMENT_CARD_DEFAULT_PAGE_BUDGET,
      turnBudget,
      filter.fields,
      includeDbTurnIds ?? false,
      signal,
      readerId,
      now,
      sequence,
    ),
  );

  return parts.join("\n");
}

// Ticket 04 (spec "Tools"): `query` is pure FTS text now (the prefix dialect
// is cut, not aliased); every non-text criterion comes from the structured
// `filter` object instead. `project` is deliberately absent — it left the
// grammar along with the rest of the old dialect.
function searchQueryResults(
  db: Database,
  text: string | undefined,
  filter: ParsedMemoryFilter,
  eraCutoffEpoch: number | null = null,
): SearchMemoryResult[] {
  return searchMemory(db, {
    query: text,
    type: filter.type,
    file: filter.file,
    tag: filter.tag,
    sessionId: filter.sessionId,
    after: filter.after,
    before: filter.before,
    // Only the observation layer reads this, and only to decide whether a
    // status still means anything (db/search.ts).
    eraCutoffEpoch,
    // A segment is not bound to a session (spec D6), so it legitimately carries
    // a null `sessionId`; only session-layer rows that lost their session are
    // dropped here.
  }).filter((r) => r.layer === "segment" || r.sessionId !== null);
}

// Response-scoped: one signal per call, threaded through every render helper
// below it, so "was anything truncated" is a fact about the WHOLE response
// (spec D1) rather than something each render site has to decide on its own.
export function recallMemory(db: Database, input: RecallInput): string {
  const signal = createTruncationSignal();
  return appendNavigationLegend(recallMemoryBody(db, input, signal), signal);
}

function recallMemoryBody(
  db: Database,
  input: RecallInput,
  signal: TruncationSignal,
): string {
  const page = Math.max(1, input.page ?? 1);
  const pageSize = input.pageSize ?? 10;
  const includeDbTurnIds = input.includeDbTurnIds ?? false;
  const eraCutoffEpoch = input.eraCutoffEpoch ?? null;
  const pageBudget = input.pageBudget ?? SEGMENT_CARD_DEFAULT_PAGE_BUDGET;
  // Ticket 11: no more depth-dependent default — every render always has a
  // finite per-item token budget (spec: "obs 恒截断，由 turn 预算驱动",
  // generalized to every node kind). A caller's explicit `turn` always wins.
  const turnBudget = input.turn ?? DEFAULT_TURN_TOKEN_BUDGET;
  // Ticket 11: `filter.fields` is the SOLE field-selection mechanism — no
  // more depth-driven default field set.
  const fields = resolveTurnFields(input.filter?.fields);
  // Ticket 04: the ONE structured filter, AND-composed with `id`, and (below)
  // with `query`. Replaces the retired top-level `time` param and the
  // in-query prefix dialect alike.
  const { parsed: filter, error: filterError } = parseMemoryFilter(input.filter);

  if (filterError) {
    return formatParameterError(filterError);
  }

  // Ticket 14 (P1-3 fix, spec "授权序列渲染前快照"): captured HERE, before
  // this render pass reads a single row — every grant this call ends up
  // recording (however many nested render functions it fans out through)
  // uses this one value, never a fresh lookup at record time.
  const sequence = snapshotWriteGateSequence(db);
  const now = input.now ?? (() => Math.floor(Date.now() / 1000));

  if (input.id) {
    // Ticket 14 (spec "选择器多选"): `id="E31, E32"` — a comma-separated
    // list, each item parsed by the EXISTING grammar above, rendered in
    // order, sharing this call's own page/turn budgets. A single item (the
    // overwhelmingly common case, and every pre-ticket-14 caller) takes the
    // untouched single-item path below unchanged.
    const idItems = input.id
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);

    if (idItems.length <= 1) {
      const routed = parseRoutedId(input.id.trim());
      if (!routed) {
        return formatParameterError(`invalid id selector "${input.id}"`);
      }

      return renderRoutedId(
        db,
        routed,
        fields,
        page,
        pageSize,
        filter.after,
        filter.before,
        includeDbTurnIds,
        eraCutoffEpoch,
        signal,
        pageBudget,
        turnBudget,
        filter,
        input.readerId,
        now,
        sequence,
      );
    }

    const routedItems: RoutedRecallId[] = [];
    for (const item of idItems) {
      const routed = parseRoutedId(item);
      if (!routed) {
        return formatParameterError(
          `invalid id selector "${item}" in comma list "${input.id}" — ${ID_SELECTOR_GRAMMAR_HINT}`,
        );
      }
      routedItems.push(routed);
    }

    const firstKind = routedItems[0]!.kind;
    if (routedItems.some((routed) => routed.kind !== firstKind)) {
      return formatParameterError(
        `mixed id kinds in comma list "${input.id}" — ${ID_SELECTOR_GRAMMAR_HINT}`,
      );
    }

    return routedItems
      .map((routed) =>
        renderRoutedId(
          db,
          routed,
          fields,
          page,
          pageSize,
          filter.after,
          filter.before,
          includeDbTurnIds,
          eraCutoffEpoch,
          signal,
          pageBudget,
          turnBudget,
          filter,
          input.readerId,
          now,
          sequence,
        ),
      )
      .join("\n\n");
  }

  // Ticket 04: a `filter` alone (no `query`) also runs the search/listing
  // path rather than falling through to the bare roster — mirrors the old
  // in-query dialect's own behavior, where a filter-only string (e.g. the
  // retired `type:discovery`) never fell back to an unfiltered overview.
  if (input.query || hasFilterCriteria(filter)) {
    // Ticket 04: `query` is pure FTS text — no in-string dialect. A query
    // containing `tag:foo` searches those literal characters; scoping comes
    // from `filter` alone now.
    const text = (input.query ?? "").trim();

    // A non-empty query that parses to nothing actionable (pure whitespace,
    // no filter member set) would otherwise silently run an unfiltered
    // search and surface recent sessions as if they matched. Reject it so an
    // empty-looking query reads as an error, not a false hit. A filter
    // member alone (no text) still counts as a criterion.
    const hasCriteria = text.length > 0 || hasFilterCriteria(filter);

    if (!hasCriteria) {
      return formatParameterError(
        `query "${input.query}" has no searchable terms or filters`,
      );
    }

    const results = searchQueryResults(
      db,
      text || undefined,
      filter,
      input.eraCutoffEpoch ?? null,
    );
    // Ticket 03: pageBudget can now force an earlier split than `pageSize`
    // alone — measured by trial-rendering candidate slices of `results`
    // with grant recording AND `signal` suppressed (`readerId: null`,
    // `signal: undefined`), since `renderGroupedSearchResults` records a
    // read grant for everything it renders and must never do so twice for
    // the same entity across trial passes. The real render below (with the
    // real `readerId`/`signal`) runs once against the chosen page's items.
    const paged = paginateByRenderedPageCost(results, page, pageSize, pageBudget, (pageItems) =>
      renderGroupedSearchResults(
        db,
        pageItems,
        fields,
        turnBudget,
        includeDbTurnIds,
        eraCutoffEpoch,
        undefined,
        text || undefined,
        null,
        now,
        sequence,
      ),
    );

    return joinPage(
      formatPageHeader(page, paged.pageCount, paged.total),
      renderGroupedSearchResults(
        db,
        paged.items,
        fields,
        turnBudget,
        includeDbTurnIds,
        eraCutoffEpoch,
        signal,
        text || undefined,
        input.readerId,
        now,
        sequence,
      ),
      paged.pageCount,
    );
  }

  return renderBareOverview(
    db,
    page,
    pageSize,
    includeDbTurnIds,
    eraCutoffEpoch,
    signal,
    pageBudget,
    turnBudget,
    filter,
    input.readerId,
    now,
    sequence,
  );
}

// ---------------------------------------------------------------------------
// Ticket 14 (read-write-contract spec, "roster 重建"): the SessionStart
// roster as a unified-renderer segment listing in its own right — the
// bespoke topic-grouped composer this replaces lived in
// hooks/session-composition.ts; this lives HERE because its own render pass
// now goes through the identical recordReadGrants/snapshotWriteGateSequence
// seam every other route in this file uses, rather than a second,
// independently-hand-kept grant recording site. Retires: topic grouping
// headers, the type facet glyph, the 40-segment cap (pagination replaces
// it), and character-cap title truncation (the item TOKEN budget's own
// word-boundary cut replaces it).
// ---------------------------------------------------------------------------

/** Item budget (spec: "item 100 tok"). */
export const DEFAULT_ROSTER_ITEM_BUDGET_TOKENS = 100;
/** Page budget (spec: "page 2000 tok"). */
export const DEFAULT_ROSTER_PAGE_BUDGET_TOKENS = 2_000;
/** Pagination here is TOKEN-driven, not count-driven — every live segment has to be fetched up front to pack pages correctly, so this is a generous headroom cap, not a display limit (mirrors `BROWSE_CANDIDATE_CAP`'s own role). */
const ROSTER_CANDIDATE_CAP = 500;

export interface SegmentRosterFeedOptions {
  /** 1-indexed; default 1 (spec: "分页默认展示第一页" — SessionStart always injects page 1). */
  page?: number;
  pageBudget?: number;
  itemBudget?: number;
  /**
   * Ticket 02's segment-era freeze. `undefined` (every production caller)
   * applies `SEGMENT_CONTAINER_ERA_CUTOFF_EPOCH` — a pre-redesign legacy
   * arc-segment never reaches the roster; an explicit `null` is era-blind
   * (status-only), for tests probing other roster properties.
   */
  segmentEraCutoffEpoch?: number | null;
  /** Segments attached to the CURRENT session but past the SessionStart block-slot pool — annotated with a recall pointer instead of a full block (spec: "挂靠溢出指路行为保留", equivalent wording). */
  overflowAttachedSegmentIds?: ReadonlySet<number>;
  readerId?: string | null;
  now?: () => number;
}

/** One roster row: `E<id> <title> — #tag #tag` (spec: "字段仅 title、tags"), word-boundary cut to the item's own token budget — the full line, not title alone (ticket 14 retires the old character-only title cap). */
function renderRosterLine(
  segment: Pick<SegmentRecord, "id" | "title" | "tags">,
  itemBudgetTokens: number,
  overflow: ReadonlySet<number>,
): string {
  const tagsText = segment.tags.length > 0 ? ` — ${segment.tags.map((tag) => `#${tag}`).join(" ")}` : "";
  const attachedNote = overflow.has(segment.id)
    ? ` (attached, not rendered here — recall(id="E${segment.id}"))`
    : "";
  const full = `- E${segment.id} ${segment.title}${tagsText}${attachedNote}`;
  const charLimit = Math.max(20, itemBudgetTokens * BROWSE_CHARS_PER_TOKEN);
  return truncateText(full, { limit: charLimit });
}

/**
 * The SessionStart roster block (ticket 14): live segments, activity-recency
 * ordered (`listLiveSegmentsByActivity`, unchanged ordering rule), each row
 * title+tags only, packed into pages by a TOKEN page budget (never a
 * segment-count cap) — a page always holds at least one item, so a single
 * oversized row cannot stall pagination. Records a read grant for every
 * segment the returned page actually shows, under its OWN pre-render
 * sequence snapshot (ticket 14, P1-3 fix) — this is its own independent
 * render pass, not nested inside another one.
 */
export function renderSegmentRosterFeed(
  db: Database,
  options: SegmentRosterFeedOptions = {},
): string {
  const page = Math.max(1, options.page ?? 1);
  const pageBudget = options.pageBudget ?? DEFAULT_ROSTER_PAGE_BUDGET_TOKENS;
  const itemBudget = options.itemBudget ?? DEFAULT_ROSTER_ITEM_BUDGET_TOKENS;
  const segmentEraCutoffEpoch =
    options.segmentEraCutoffEpoch === undefined
      ? SEGMENT_CONTAINER_ERA_CUTOFF_EPOCH
      : options.segmentEraCutoffEpoch;
  const overflow = options.overflowAttachedSegmentIds ?? new Set<number>();
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));

  // P1-3 discipline (peer round 2): the grant sequence is snapshotted at
  // render START, before ANY segment row is read — a foreign stamp landing
  // between these reads and the record call below must leave the grant
  // looking older than it, never fresher.
  const renderStartSequence = snapshotWriteGateSequence(db);

  const totalLive = countLiveSegments(db, segmentEraCutoffEpoch);
  const candidates = listLiveSegmentsByActivity(db, ROSTER_CANDIDATE_CAP, segmentEraCutoffEpoch);
  const header = `## Segment roster (${totalLive} live)`;

  if (candidates.length === 0) {
    return `${header}\n(no live segments yet — remember(create) mints one)`;
  }

  const rendered = candidates.map((entry) => ({
    segmentId: entry.id,
    text: renderRosterLine(entry, itemBudget, overflow),
  }));

  // Greedy token-budget packing into pages — same shape as `buildBrowseFeed`'s
  // own packer above.
  const pages: (typeof rendered)[] = [];
  let current: typeof rendered = [];
  let used = 0;
  for (const item of rendered) {
    const cost = estimateTokens(item.text) + 1;
    if (current.length > 0 && used + cost > pageBudget) {
      pages.push(current);
      current = [];
      used = 0;
    }
    current.push(item);
    used += cost;
  }
  if (current.length > 0 || pages.length === 0) {
    pages.push(current);
  }

  const pageCount = pages.length;
  const clampedPage = Math.min(Math.max(1, page), pageCount);
  const pageItems = pages[clampedPage - 1] ?? [];

  if (options.readerId && pageItems.length > 0) {
    recordReadGrants(
      db,
      options.readerId,
      pageItems.map((item) => ({ entityType: "segment" as const, entityId: item.segmentId })),
      now(),
      renderStartSequence,
    );
  }

  return joinPage(
    formatPageHeader(clampedPage, pageCount, totalLive),
    [header, ...pageItems.map((item) => item.text)].join("\n"),
    pageCount,
  );
}
