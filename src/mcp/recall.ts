import type { Database } from "bun:sqlite";

import {
  getObservation,
  getExtractableObservationsForTurn,
} from "../db/observations";
import { searchMemory, type SearchMemoryResult } from "../db/search";
import { getSession } from "../db/sessions";
import {
  getFirstTurn,
  getTurn,
  getTurnById,
  getTurnsForSession,
  type TurnRecord,
} from "../db/turns";
import { resolveSessionTranscriptPath } from "../shared/paths";

import {
  DEFAULT_TRUNCATE,
  renderNode,
  type FormattedObservation,
  type FormattedSession,
  type FormattedTurn,
} from "./format";
import { expandNumericSelector } from "./selectors";
import { resolveTurnPointers } from "./turn-pointers";

export interface RecallInput {
  id?: string;
  query?: string;
  time?: string;
  depth?: "collapsed" | "expanded";
  page?: number;
  pageSize?: number;
  truncate?: number;
  // Internal worker-only flag. When set, rendered turns append a `dbid:T<dbid>`
  // token so the memory worker can cite a turn it found via recall. NOT exposed
  // on the public `recallInputShape` (definitions.ts) — wired through the
  // handler-construction `audience` option (handlers.ts) instead.
  includeDbTurnIds?: boolean;
  // Internal audience rendering policy. Public/main callers leave this unset.
  truncateCap?: number;
}

interface ParsedTimeRange {
  after?: number;
  before?: number;
}

interface QueryFilters {
  text?: string;
  type?: string;
  file?: string;
  tag?: string;
  project?: string;
  session?: number;
}

const CHILD_PREVIEW_SIZE = 5;

type RoutedRecallId =
  | { kind: "sessions"; sessionIds?: number[] }
  | { kind: "turns"; sessionId: number; promptNumbers?: number[] }
  | { kind: "turn-by-id"; turnId: number }
  | { kind: "session-observation-list"; sessionId: number }
  | { kind: "observation-list"; sessionId: number; promptNumber: number }
  | { kind: "observation"; observationId: number };

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

// D4: the redesigned summary fields, with [T<n>] markers resolved to current
// turn titles. `insight` is carried for the legacy read-side fallback (old
// sessions whose `decision` is empty). decision/done hold the inline pointers.
function buildSessionSummaryFields(
  db: Database,
  session: NonNullable<ReturnType<typeof getSession>>,
): Pick<
  FormattedSession,
  "content" | "insight" | "nextSteps" | "decision" | "done" | "current" | "reference"
> {
  return {
    content: session.content,
    insight: splitInsight(session.insight),
    nextSteps: session.nextSteps,
    decision: resolveTurnPointers(db, session.id, session.decision),
    done: resolveTurnPointers(db, session.id, session.done),
    current: session.current,
    reference: session.reference,
  };
}

function formatParameterError(message: string): string {
  return `Parameter error: ${message}`;
}

function parseTimeInput(time: string | undefined): {
  range?: ParsedTimeRange;
  error?: string;
} {
  if (!time) {
    return {};
  }

  const trimmed = time.trim();
  if (!trimmed) {
    return {};
  }

  const rangeMatch = trimmed.match(
    /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/,
  );
  if (rangeMatch) {
    const start = parseUtcDate(rangeMatch[1]!);
    const end = parseUtcDate(rangeMatch[2]!);

    if (start === null || end === null) {
      return { error: `invalid time selector "${time}"` };
    }

    return {
      range: {
        after: start,
        before: end + 86_399,
      },
    };
  }

  const relativeMatch = trimmed.match(/^-([0-9]+)([dw])$/);
  if (relativeMatch) {
    const amount = Number(relativeMatch[1]);
    const unit = relativeMatch[2];
    const secondsPerUnit = unit === "d" ? 86_400 : 7 * 86_400;

    return {
      range: {
        after: Math.floor(Date.now() / 1000) - amount * secondsPerUnit,
      },
    };
  }

  const dateEpoch = parseUtcDate(trimmed);
  if (dateEpoch !== null) {
    return {
      range: {
        after: dateEpoch,
        before: dateEpoch + 86_399,
      },
    };
  }

  return { error: `invalid time selector "${time}"` };
}

function parseUtcDate(value: string): number | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return null;
  }

  const epoch = Math.floor(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 1000,
  );

  return Number.isNaN(epoch) ? null : epoch;
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

function resolveTimeRange(
  time: string | undefined,
): { after?: number; before?: number; error?: string } {
  const parsedTime = parseTimeInput(time);
  if (parsedTime.error) {
    return { error: parsedTime.error };
  }

  return {
    after: parsedTime.range?.after,
    before: parsedTime.range?.before,
  };
}

function parseQueryFilters(query: string | undefined): QueryFilters {
  if (!query) {
    return {};
  }

  const filters: QueryFilters = {};
  const textTerms: string[] = [];

  for (const token of query.trim().split(/\s+/).filter(Boolean)) {
    if (token.startsWith("type:")) {
      filters.type = token.slice("type:".length);
      continue;
    }
    if (token.startsWith("file:")) {
      filters.file = token.slice("file:".length);
      continue;
    }
    if (token.startsWith("tag:")) {
      // Exact-match a stored tag (whole array element). The value keeps any
      // namespace prefix, so `tag:rolled-back` matches a bare role tag and
      // `tag:topic:svg-filter` matches a `topic:`-prefixed topic tag. An empty
      // value (`tag:` alone) is dropped, never searched as free text.
      const tag = token.slice("tag:".length);
      if (tag) {
        filters.tag = tag;
      }
      continue;
    }
    if (token.startsWith("project:")) {
      filters.project = token.slice("project:".length);
      continue;
    }
    if (token.startsWith("session:")) {
      // Accept both the `S<id>` form users see in output and a bare `<id>`.
      const raw = token.slice("session:".length).replace(/^[Ss]/, "");
      const sessionId = Number(raw);
      if (Number.isInteger(sessionId) && sessionId > 0) {
        filters.session = sessionId;
      }
      // Malformed session: tokens are dropped, never searched as free text.
      continue;
    }
    textTerms.push(token);
  }

  if (textTerms.length > 0) {
    filters.text = textTerms.join(" ");
  }

  return filters;
}

function buildSessionView(
  db: Database,
  session: NonNullable<ReturnType<typeof getSession>>,
): FormattedSession {
  const turns = getTurnsForSession(db, session.id).map((turn) =>
    buildTurnView(db, turn),
  );

  return {
    id: session.id,
    title: session.title,
    project: session.project,
    createdAtEpoch: session.createdAtEpoch,
    ...buildSessionSummaryFields(db, session),
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
    ...buildSessionSummaryFields(db, session),
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
): FormattedSession | null {
  const session = getSession(db, sessionId);
  if (!session) {
    return null;
  }

  const turns = getTurnsForSession(db, session.id).map((turn) =>
    buildTurnView(db, turn),
  );

  return {
    id: session.id,
    title: session.title,
    project: session.project,
    createdAtEpoch: session.createdAtEpoch,
    ...buildSessionSummaryFields(db, session),
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

export function buildTurnView(db: Database, turn: TurnRecord): FormattedTurn {
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
    observations: observations.map((observation) => ({
      id: observation.id,
      title: observation.title ?? observation.toolName ?? `Observation ${observation.id}`,
      content: observation.content,
    })),
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
): string {
  const view = depth === "expanded"
    ? buildSessionView(db, session)
    : buildSessionSummary(db, session.id) ?? buildSessionView(db, session);
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
    const turnView = buildTurnView(db, item);
    const turnLines = renderNode(
      { type: "turn", value: turnView },
      {
        depth: "collapsed",
        mode: "unified",
        sessionId: session.id,
        truncate,
        includeDbTurnIds,
        truncateCap,
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
    const view = buildSessionSummary(db, session.id);
    if (!view) {
      continue;
    }
    lines.push(
      renderNode(
        { type: "session", value: view },
        { depth: "collapsed", mode: "unified", truncate, truncateCap },
      ),
    );

    const sessionTurns = grouped.get(session.id) ?? [];
    for (const item of sessionTurns) {
      const turnView = buildTurnView(db, item);
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

      const observationView: FormattedObservation = {
        id: observation.id,
        title: observation.title ?? observation.toolName ?? `Observation ${observation.id}`,
        content: observation.content,
      };

      lines.push(
        renderNode(
          { type: "observation", value: observationView },
          {
            depth: depth === "collapsed" ? "collapsed" : "expanded",
            mode: "unified",
            truncate,
            truncateCap,
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
    const sessionView = buildSessionSummary(db, session.id);
    if (!sessionView) {
      continue;
    }
    lines.push(
      renderNode(
        { type: "session", value: sessionView },
        { depth: "collapsed", mode: "unified", truncate, truncateCap },
      ),
    );
    const turnMap = grouped.get(session.id) ?? new Map<number, number[]>();
    const turns = getTurnsForSession(db, session.id).filter((turn) =>
      turnMap.has(turn.id),
    );

    for (const turn of turns) {
      const turnView = buildTurnView(db, turn);
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

        const observationView: FormattedObservation = {
          id: observation.id,
          title: observation.title ?? observation.toolName ?? `Observation ${observation.id}`,
          content: observation.content,
        };

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
            },
          ),
        );
      }
    }
  }

  return lines.join("\n");
}

function buildObservationView(
  observation: NonNullable<ReturnType<typeof getObservation>>,
): FormattedObservation {
  return {
    id: observation.id,
    title: observation.title ?? observation.toolName ?? `Observation ${observation.id}`,
    content: observation.content,
  };
}

function renderSessionDetail(
  db: Database,
  sessionId: number,
  depth: "collapsed" | "expanded",
  truncate?: number,
  includeDbTurnIds?: boolean,
  truncateCap?: number,
): string {
  const session = getSession(db, sessionId);
  return session
    ? renderSession(db, session, depth, truncate, undefined, includeDbTurnIds, truncateCap)
    : "Session not found.";
}

function renderTurnDetail(
  db: Database,
  sessionId: number,
  promptNumber: number,
  depth: "collapsed" | "expanded",
  truncate?: number,
  includeDbTurnIds?: boolean,
  truncateCap?: number,
): string {
  const turn = getTurn(db, sessionId, promptNumber);
  return turn
    ? renderTurnScope(db, [turn], depth, truncate, includeDbTurnIds, truncateCap)
    : "Turn not found.";
}

function renderObservationDetail(
  db: Database,
  observationId: number,
  depth: "collapsed" | "expanded",
  truncate?: number,
  truncateCap?: number,
): string {
  const observation = getObservation(db, observationId);
  // Every listing route already drops excluded rows, so direct addressing must
  // read as "no such observation" too — otherwise the id a listing withheld is
  // still fetchable in full by guessing it.
  if (!observation || observation.excludedFromExtraction !== 0) {
    return "Observation not found.";
  }

  const view = buildObservationView(observation);
  return renderNode(
    { type: "observation", value: view },
    {
      depth: depth === "collapsed" ? "collapsed" : "expanded",
      mode: "unified",
      truncate,
      truncateCap,
    },
  );
}

function listSessionIds(
  db: Database,
  sessionIds: number[] | undefined,
  after?: number,
  before?: number,
): number[] {
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
): string {
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
    // searchQueryResults guarantees sessionId !== null; Map key requires number
    const sessionId = result.sessionId!;
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
      return renderSession(db, session, depth, truncate, undefined, includeDbTurnIds, truncateCap);
    }

    const lines = [
      renderNode(
        {
          type: "session",
          value: buildSessionSummary(db, session.id) ?? buildSessionView(db, session),
        },
        { depth: "collapsed", mode: "unified", truncate, truncateCap },
      ),
    ];
    const turns = getTurnsForSession(db, session.id).filter(
      (turn) =>
        group.turnIds.has(turn.id) || group.observationIdsByTurnId.has(turn.id),
    );

    for (const turn of turns) {
      const turnView = buildTurnView(db, turn);
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
          },
        ),
      );

      const observationIds = group.observationIdsByTurnId.get(turn.id) ?? [];
      for (const observationId of observationIds) {
        const observation = getObservation(db, observationId);
        if (!observation) {
          continue;
        }

        const observationView = buildObservationView(observation);
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
            },
          ),
        );
      }
    }

    return lines.join("\n");
  });

  return sessionLines.filter(Boolean).join("\n");
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
): string {
  if (routed.kind === "sessions") {
    const paged = paginateItems(
      listSessionIds(db, routed.sessionIds, after, before),
      page,
      pageSize,
    );

    return joinPage(
      formatPageHeader(page, paged.pageCount, paged.total),
      paged.items
        .map((sessionId) =>
          renderSessionDetail(db, sessionId, depth, truncate, includeDbTurnIds, truncateCap),
        )
        .join("\n"),
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
      return true;
    });
    const paged = paginateItems(turns, page, pageSize);
    return joinPage(
      formatPageHeader(page, paged.pageCount, paged.total),
      renderTurnScope(db, paged.items, depth, truncate, includeDbTurnIds, truncateCap),
      paged.pageCount,
    );
  }

  if (routed.kind === "turn-by-id") {
    const turn = getTurnById(db, routed.turnId);
    return turn
      ? renderTurnScope(db, [turn], depth, truncate, includeDbTurnIds, truncateCap)
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
      renderObservationScope(db, paged.items, depth, true, truncate, includeDbTurnIds, truncateCap),
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
      renderObservationScope(db, paged.items, depth, true, truncate, includeDbTurnIds, truncateCap),
      paged.pageCount,
    );
  }

  if (routed.kind === "observation") {
    return renderObservationDetail(db, routed.observationId, depth, truncate, truncateCap);
  }

  routed satisfies never;
  return formatParameterError(`unrecognized id kind`);
}

function renderSessionList(
  db: Database,
  depth: "collapsed" | "expanded",
  page: number,
  pageSize: number,
  truncate?: number,
  after?: number,
  before?: number,
  includeDbTurnIds?: boolean,
  truncateCap?: number,
): string {
  const paged = paginateItems(
    listSessionIds(db, undefined, after, before),
    page,
    pageSize,
  );

  return joinPage(
    formatPageHeader(page, paged.pageCount, paged.total),
    paged.items
      .map((sessionId) =>
        renderSessionDetail(db, sessionId, depth, truncate, includeDbTurnIds, truncateCap),
      )
      .join("\n"),
    paged.pageCount,
  );
}

function searchQueryResults(
  db: Database,
  filters: QueryFilters,
  after?: number,
  before?: number,
): SearchMemoryResult[] {
  return searchMemory(db, {
    query: filters.text,
    type: filters.type,
    file: filters.file,
    tag: filters.tag,
    project: filters.project,
    sessionId: filters.session,
    after,
    before,
  }).filter((r) => r.sessionId !== null);
}

export function recallMemory(db: Database, input: RecallInput): string {
  const depth = input.depth ?? "collapsed";
  const page = Math.max(1, input.page ?? 1);
  const pageSize = input.pageSize ?? 10;
  const includeDbTurnIds = input.includeDbTurnIds ?? false;
  const truncate = input.truncate ?? DEFAULT_TRUNCATE;
  const truncateCap = input.truncateCap;
  const timeRange = resolveTimeRange(input.time);

  if (timeRange.error) {
    return formatParameterError(timeRange.error);
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
      timeRange.after,
      timeRange.before,
      includeDbTurnIds,
      truncateCap,
    );
  }

  if (input.query) {
    const filters = parseQueryFilters(input.query);

    // A non-empty query that parses to nothing actionable (e.g. a bare `tag:`,
    // `session:` with a malformed id, or whitespace) would otherwise silently
    // run an unfiltered search and surface recent sessions as if they matched.
    // Reject it so a typo'd filter reads as an error, not a false hit. A time
    // range still counts as a criterion, so `tag:` + `time:` stays valid.
    const hasCriteria =
      Boolean(filters.text) ||
      Boolean(filters.type) ||
      Boolean(filters.file) ||
      Boolean(filters.tag) ||
      Boolean(filters.project) ||
      filters.session !== undefined ||
      timeRange.after !== undefined ||
      timeRange.before !== undefined;

    if (!hasCriteria) {
      return formatParameterError(
        `query "${input.query}" has no searchable terms or filters`,
      );
    }

    const results = searchQueryResults(
      db,
      filters,
      timeRange.after,
      timeRange.before,
    );
    const paged = paginateItems(results, page, pageSize);

    return joinPage(
      formatPageHeader(page, paged.pageCount, paged.total),
      renderGroupedSearchResults(db, paged.items, depth, truncate, includeDbTurnIds, truncateCap),
      paged.pageCount,
    );
  }

  return renderSessionList(
    db,
    depth,
    page,
    pageSize,
    truncate,
    timeRange.after,
    timeRange.before,
    includeDbTurnIds,
    truncateCap,
  );
}
