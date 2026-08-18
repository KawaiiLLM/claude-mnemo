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
import { getSegment, listSegmentsByActivity, type SegmentRecord } from "../db/segments";
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
  DEFAULT_TRUNCATE,
  DEFAULT_TURN_TOKEN_BUDGET_COLLAPSED,
  renderNode,
  type FormattedObservation,
  type FormattedSession,
  type FormattedTurn,
  type TruncationSignal,
} from "./format";
import {
  hasFilterCriteria,
  parseMemoryFilter,
  turnMatchesFilter,
  type MemoryFilterInput,
  type ParsedMemoryFilter,
} from "./memory-filter";
import { renderSegmentHeaderLines } from "./segment-spine";
import {
  chronologicalSegmentMembers,
  renderSegmentCard,
  renderSegmentMembersByOrdinal,
  SEGMENT_CARD_DEFAULT_PAGE_BUDGET,
} from "./segment-card";
import { expandNumericSelector } from "./selectors";

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
  depth?: "collapsed" | "expanded";
  page?: number;
  pageSize?: number;
  // Ticket 04: retired from the PUBLIC schema (`recallInputSchema` rejects a
  // supplied `truncate` with a message naming its replacements) — this
  // internal field survives because the worker surface
  // (`workerRecallInputShape`) and every test calling `recallMemory`
  // directly still use it.
  truncate?: number;
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
   * Ticket 03: per-turn token cap (spec "Budgets": "a per-turn budget...
   * recall card-scale [default for collapsed], expanded default uncapped").
   * Applies wherever a turn renders through `renderNode` (format.ts).
   */
  turn?: number;
  // Internal worker-only flag. When set, rendered turns append a `dbid:T<dbid>`
  // token so the memory worker can cite a turn it found via recall. NOT exposed
  // on the public `recallInputShape` (definitions.ts) — wired through the
  // handler-construction `audience` option (handlers.ts) instead.
  includeDbTurnIds?: boolean;
  // Internal audience rendering policy. Public/main callers leave this unset.
  truncateCap?: number;
  /**
   * P2 era boundary (spec D11). Observations created at or after it render
   * their mechanical fields (tool name + input/result prefixes) because nothing
   * summarizes them any more. `null` — the default — leaves every rendering on
   * the legacy path.
   */
  eraCutoffEpoch?: number | null;
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

  const turnMatch = /^S(\d+)\/T(\*|\d+|\d+\.\.\d+)$/i.exec(trimmed);
  if (turnMatch) {
    const promptNumbers = expandNumericSelector(turnMatch[2]!);
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
  const segmentMemberMatch = /^E(\d+)\/T(\*|\d+|\d+\.\.\d+)$/i.exec(trimmed);
  if (segmentMemberMatch) {
    const ordinals = expandNumericSelector(segmentMemberMatch[2]!);
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
  const segmentMatch = /^E(\*|\d+|\d+\.\.\d+)$/i.exec(trimmed);
  if (segmentMatch) {
    const segmentIds = expandNumericSelector(segmentMatch[1]!);
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

  const sessionMatch = /^S(\*|\d+|\d+\.\.\d+)$/i.exec(trimmed);
  if (sessionMatch) {
    const sessionIds = expandNumericSelector(sessionMatch[1]!);
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
    transcriptLineStart: turn.transcriptLineStart,
    title: turn.title,
    content: turn.content,
    observationCount: observationCounts.get(turn.id) ?? 0,
    toolCallCount: turn.toolCallCount,
    filesReadCount: turn.filesRead.length,
    filesModifiedCount: turn.filesModified.length,
    status: turn.status,
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
    transcriptLineStart: turn.transcriptLineStart,
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

function renderSession(
  db: Database,
  session: NonNullable<ReturnType<typeof getSession>>,
  depth: "collapsed" | "expanded",
  truncate?: number,
  turnSelector?: Set<number>,
  includeDbTurnIds?: boolean,
  truncateCap?: number,
  eraCutoffEpoch: number | null = null,
  signal?: TruncationSignal,
): string {
  const view = depth === "expanded"
    ? buildSessionView(db, session, eraCutoffEpoch)
    : buildSessionSummary(db, session.id, eraCutoffEpoch) ??
      buildSessionView(db, session, eraCutoffEpoch);
  const breadcrumb = deriveBreadcrumb(db, session);
  const lines = [
    renderNode(
      { type: "session", value: view },
      {
        depth: depth === "collapsed" ? "collapsed" : "expanded",
        mode: "unified",
        truncate,
        includeDbTurnIds,
        truncateCap,
        signal,
      },
    ),
  ];

  if (breadcrumb !== null) {
    lines.push(`  ${breadcrumb}`);
  }

  if (depth === "collapsed") {
    return lines.join("\n");
  }

  const turns = getTurnsForSession(db, session.id).filter((turn) =>
    turnSelector ? turnSelector.has(turn.promptNumber) : true,
  );

  const preview = previewItems(turns, CHILD_PREVIEW_SIZE);
  for (const item of preview.items) {
    const turnView = buildTurnView(db, item, eraCutoffEpoch);
    const turnLines = renderNode(
      { type: "turn", value: turnView },
      {
        depth: "collapsed",
        mode: "unified",
        sessionId: session.id,
        truncate,
        includeDbTurnIds,
        truncateCap,
        signal,
      },
    );
    lines.push(turnLines);
  }

  if (preview.omittedCount > 0) {
    lines.push(`  +${preview.omittedCount} more`);
  }

  return lines.join("\n");
}

function renderTurnScope(
  db: Database,
  turns: TurnRecord[],
  depth: "collapsed" | "expanded",
  truncate?: number,
  includeDbTurnIds?: boolean,
  truncateCap?: number,
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
      renderNode(
        { type: "session", value: view },
        { depth: "collapsed", mode: "unified", truncate, truncateCap, signal },
      ),
    );

    const sessionTurns = grouped.get(session.id) ?? [];
    for (const item of sessionTurns) {
      const turnView = buildTurnView(db, item, eraCutoffEpoch);
      lines.push(
        renderNode(
          { type: "turn", value: turnView },
          {
            depth,
            mode: "unified",
            sessionId: session.id,
            truncate,
            includeDbTurnIds,
            truncateCap,
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
  depth: "collapsed" | "expanded",
  includeParents: boolean,
  truncate?: number,
  includeDbTurnIds?: boolean,
  truncateCap?: number,
  eraCutoffEpoch: number | null = null,
  signal?: TruncationSignal,
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
          {
            depth: depth === "collapsed" ? "collapsed" : "expanded",
            mode: "unified",
            truncate,
            truncateCap,
            signal,
          },
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
      renderNode(
        { type: "session", value: sessionView },
        { depth: "collapsed", mode: "unified", truncate, truncateCap, signal },
      ),
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
            depth: "collapsed",
            mode: "unified",
            sessionId: session.id,
            truncate,
            includeDbTurnIds,
            truncateCap,
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
              depth: depth === "collapsed" ? "collapsed" : "expanded",
              mode: "unified",
              indent: "    ",
              sessionId: session.id,
              turnPromptNumber: turn.promptNumber,
              truncate,
              truncateCap,
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
  depth: "collapsed" | "expanded",
  truncate?: number,
  includeDbTurnIds?: boolean,
  truncateCap?: number,
  eraCutoffEpoch: number | null = null,
  signal?: TruncationSignal,
): string {
  const session = getSession(db, sessionId);
  return session
    ? renderSession(
        db,
        session,
        depth,
        truncate,
        undefined,
        includeDbTurnIds,
        truncateCap,
        eraCutoffEpoch,
        signal,
      )
    : "Session not found.";
}

function renderObservationDetail(
  db: Database,
  observationId: number,
  depth: "collapsed" | "expanded",
  truncate?: number,
  truncateCap?: number,
  eraCutoffEpoch: number | null = null,
  signal?: TruncationSignal,
): string {
  const observation = getObservation(db, observationId);
  // Every listing route already drops excluded rows, so direct addressing must
  // read as "no such observation" too — otherwise the id a listing withheld is
  // still fetchable in full by guessing it.
  if (!observation || observation.excludedFromExtraction !== 0) {
    return "Observation not found.";
  }

  const view = buildOwnedObservationView(db, observation, eraCutoffEpoch);
  return renderNode(
    { type: "observation", value: view },
    {
      depth: depth === "collapsed" ? "collapsed" : "expanded",
      mode: "unified",
      truncate,
      truncateCap,
      signal,
    },
  );
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

/** One collapsed `[E<n>]` line, as a search hit renders it. */
function renderSegmentSummary(
  db: Database,
  segmentId: number,
  truncate?: number,
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
    truncate: truncate ?? DEFAULT_TRUNCATE,
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

function renderGroupedSearchResults(
  db: Database,
  results: SearchMemoryResult[],
  depth: "collapsed" | "expanded",
  truncate?: number,
  includeDbTurnIds?: boolean,
  truncateCap?: number,
  eraCutoffEpoch: number | null = null,
  signal?: TruncationSignal,
): string {
  // Segment hits lead: a `tag:` query returns the chapter AND its member turns
  // (spec user story 16), and the chapter is the index into the rest.
  const segmentLines = results
    .filter((result) => result.layer === "segment")
    .map((result) =>
      renderSegmentSummary(db, result.sourceId, truncate, eraCutoffEpoch),
    )
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

    if (group.sessionHit && group.turnIds.size === 0) {
      return renderSession(
        db,
        session,
        depth,
        truncate,
        undefined,
        includeDbTurnIds,
        truncateCap,
        eraCutoffEpoch,
        signal,
      );
    }

    const lines = [
      renderNode(
        {
          type: "session",
          value:
            buildSessionSummary(db, session.id, eraCutoffEpoch) ??
            buildSessionView(db, session, eraCutoffEpoch),
        },
        { depth: "collapsed", mode: "unified", truncate, truncateCap, signal },
      ),
    ];
    const turns = getTurnsForSession(db, session.id).filter(
      (turn) =>
        group.turnIds.has(turn.id) || group.observationIdsByTurnId.has(turn.id),
    );

    for (const turn of turns) {
      const turnView = buildTurnView(db, turn, eraCutoffEpoch);
      const turnDepth =
        group.observationIdsByTurnId.has(turn.id) && !group.turnIds.has(turn.id)
          ? "collapsed"
          : depth;

      lines.push(
        renderNode(
          { type: "turn", value: turnView },
          {
            depth: turnDepth,
            mode: "unified",
            sessionId: session.id,
            truncate,
            includeDbTurnIds,
            truncateCap,
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

        const observationView = buildObservationView(
          observation,
          turn.createdAtEpoch,
          eraCutoffEpoch,
        );
        lines.push(
          renderNode(
            { type: "observation", value: observationView },
            {
              depth: depth === "collapsed" ? "collapsed" : "expanded",
              mode: "unified",
              indent: "    ",
              sessionId: session.id,
              turnPromptNumber: turn.promptNumber,
              truncate,
              truncateCap,
              signal,
            },
          ),
        );
      }
    }

    return lines.join("\n");
  });

  return [...segmentLines, ...sessionLines].filter(Boolean).join("\n");
}

function renderRoutedId(
  db: Database,
  routed: RoutedRecallId,
  depth: "collapsed" | "expanded",
  page: number,
  pageSize: number,
  truncate?: number,
  after?: number,
  before?: number,
  includeDbTurnIds?: boolean,
  truncateCap?: number,
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
): string {
  if (routed.kind === "sessions") {
    const paged = paginateItems(
      listSessionIds(db, routed.sessionIds, after, before, filter),
      page,
      pageSize,
    );

    return joinPage(
      formatPageHeader(page, paged.pageCount, paged.total),
      paged.items
        .map((sessionId) =>
          renderSessionDetail(
            db,
            sessionId,
            depth,
            truncate,
            includeDbTurnIds,
            truncateCap,
            eraCutoffEpoch,
            signal,
          ),
        )
        .join("\n"),
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
      return renderSegmentCard(db, routed.segmentIds[0]!, {
        depth,
        pageBudget,
        page,
        turnBudget,
        truncate,
        truncateCap,
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

    return joinPage(
      formatPageHeader(page, paged.pageCount, paged.total),
      paged.items
        .map((segmentId) =>
          renderSegmentCard(db, segmentId, {
            depth,
            pageBudget,
            page: 1,
            turnBudget,
            truncate,
            truncateCap,
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
    const wantedOrdinals =
      routed.ordinals && routed.ordinals.length > 0
        ? routed.ordinals
        : chronologicalSegmentMembers(db, segment, eraCutoffEpoch).map((_member, index) => index + 1);
    const paged = paginateItems(wantedOrdinals, page, pageSize);

    return joinPage(
      formatPageHeader(page, paged.pageCount, paged.total),
      renderSegmentMembersByOrdinal(db, routed.segmentId, paged.items, {
        depth,
        truncate,
        truncateCap,
        includeDbTurnIds,
        turnBudget,
        eraCutoffEpoch,
        signal,
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
    const paged = paginateItems(turns, page, pageSize);
    return joinPage(
      formatPageHeader(page, paged.pageCount, paged.total),
      renderTurnScope(
        db,
        paged.items,
        depth,
        truncate,
        includeDbTurnIds,
        truncateCap,
        eraCutoffEpoch,
        signal,
        turnBudget,
      ),
      paged.pageCount,
    );
  }

  if (routed.kind === "turn-by-id") {
    const turn = getTurnById(db, routed.turnId);
    return turn
      ? renderTurnScope(
          db,
          [turn],
          depth,
          truncate,
          includeDbTurnIds,
          truncateCap,
          eraCutoffEpoch,
          signal,
          turnBudget,
        )
      : "Turn not found.";
  }

  if (routed.kind === "observation-list") {
    const turn = getTurn(db, routed.sessionId, routed.promptNumber);
    if (!turn) {
      return "Turn not found.";
    }

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

    const paged = paginateItems(observations, page, pageSize);
    return joinPage(
      formatPageHeader(page, paged.pageCount, paged.total),
      renderObservationScope(
        db,
        paged.items,
        depth,
        true,
        truncate,
        includeDbTurnIds,
        truncateCap,
        eraCutoffEpoch,
        signal,
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

    const paged = paginateItems(observations, page, pageSize);
    return joinPage(
      formatPageHeader(page, paged.pageCount, paged.total),
      renderObservationScope(
        db,
        paged.items,
        depth,
        true,
        truncate,
        includeDbTurnIds,
        truncateCap,
        eraCutoffEpoch,
        signal,
      ),
      paged.pageCount,
    );
  }

  if (routed.kind === "observation") {
    return renderObservationDetail(
      db,
      routed.observationId,
      depth,
      truncate,
      truncateCap,
      eraCutoffEpoch,
      signal,
    );
  }

  routed satisfies never;
  return formatParameterError(`unrecognized id kind`);
}

/**
 * Bare `recall()` — no `id`, no `query` (ticket 03, spec user story 18):
 * segments lead, sessions follow. Segments are recency-ordered by last
 * member-or-state edit (`listSegmentsByActivity`, ADR-0005's roster rule)
 * and bounded by `pageSize`, same as the roster is budget-truncated; the
 * section only appears on page 1 — later pages are pure session-listing
 * pagination, unchanged from before this ticket, so a caller paging through
 * sessions never sees the segments header repeat.
 */
function renderBareOverview(
  db: Database,
  depth: "collapsed" | "expanded",
  page: number,
  pageSize: number,
  truncate?: number,
  after?: number,
  before?: number,
  includeDbTurnIds?: boolean,
  truncateCap?: number,
  eraCutoffEpoch: number | null = null,
  signal?: TruncationSignal,
  pageBudget?: number,
  turnBudget?: number,
  // Ticket 04: narrows the sessions section the same way the `S*` listing
  // kind does (`listSessionIds`, shared). The segments section above is
  // ticket 02/03/05 territory and stays unfiltered — bare `recall()`'s
  // roster-first behavior is unchanged.
  filter: ParsedMemoryFilter = {},
): string {
  const parts: string[] = [];

  if (page === 1) {
    const segments = listSegmentsByActivity(db, pageSize);
    if (segments.length > 0) {
      parts.push(`── segments (${segments.length}) ──`);
      for (const segment of segments) {
        parts.push(
          renderSegmentCard(db, segment.id, {
            depth,
            pageBudget,
            page: 1,
            turnBudget,
            truncate,
            truncateCap,
            includeDbTurnIds,
            eraCutoffEpoch,
            signal,
          }),
        );
      }
    }
  }

  const paged = paginateItems(
    listSessionIds(db, undefined, after, before, filter),
    page,
    pageSize,
  );
  if (paged.total > 0) {
    parts.push(`── sessions ──`);
  }
  parts.push(
    joinPage(
      formatPageHeader(page, paged.pageCount, paged.total),
      paged.items
        .map((sessionId) =>
          renderSessionDetail(
            db,
            sessionId,
            depth,
            truncate,
            includeDbTurnIds,
            truncateCap,
            eraCutoffEpoch,
            signal,
          ),
        )
        .join("\n"),
      paged.pageCount,
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
  const depth = input.depth ?? "collapsed";
  const page = Math.max(1, input.page ?? 1);
  const pageSize = input.pageSize ?? 10;
  const includeDbTurnIds = input.includeDbTurnIds ?? false;
  const truncate = input.truncate ?? DEFAULT_TRUNCATE;
  const truncateCap = input.truncateCap;
  const eraCutoffEpoch = input.eraCutoffEpoch ?? null;
  const pageBudget = input.pageBudget ?? SEGMENT_CARD_DEFAULT_PAGE_BUDGET;
  // "default card-scale for collapsed, uncapped for expanded" (spec
  // "Budgets") — a caller's explicit `turn` always wins; only the DEFAULT
  // (nothing supplied) depends on depth.
  const turnBudget = input.turn ?? (depth === "collapsed" ? DEFAULT_TURN_TOKEN_BUDGET_COLLAPSED : undefined);
  // Ticket 04: the ONE structured filter, AND-composed with `id`, and (below)
  // with `query`. Replaces the retired top-level `time` param and the
  // in-query prefix dialect alike.
  const { parsed: filter, error: filterError } = parseMemoryFilter(input.filter);

  if (filterError) {
    return formatParameterError(filterError);
  }

  if (input.id) {
    const routed = parseRoutedId(input.id);
    if (!routed) {
      return formatParameterError(`invalid id selector "${input.id}"`);
    }

    return renderRoutedId(
      db,
      routed,
      depth,
      page,
      pageSize,
      truncate,
      filter.after,
      filter.before,
      includeDbTurnIds,
      truncateCap,
      eraCutoffEpoch,
      signal,
      pageBudget,
      turnBudget,
      filter,
    );
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
    const paged = paginateItems(results, page, pageSize);

    return joinPage(
      formatPageHeader(page, paged.pageCount, paged.total),
      renderGroupedSearchResults(
        db,
        paged.items,
        depth,
        truncate,
        includeDbTurnIds,
        truncateCap,
        eraCutoffEpoch,
        signal,
      ),
      paged.pageCount,
    );
  }

  return renderBareOverview(
    db,
    depth,
    page,
    pageSize,
    truncate,
    filter.after,
    filter.before,
    includeDbTurnIds,
    truncateCap,
    eraCutoffEpoch,
    signal,
    pageBudget,
    turnBudget,
    filter,
  );
}
