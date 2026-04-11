import type { Database } from "bun:sqlite";

import { getMemory } from "../db/memories";
import { getObservation, getObservationsForTurn } from "../db/observations";
import { searchMemory, type SearchMemoryResult } from "../db/search";
import { getRecentSessions, getSession } from "../db/sessions";
import {
  getTurn,
  getTurnById,
  getTurnsForSession,
  type TurnRecord,
} from "../db/turns";

import {
  DEFAULT_TRUNCATE,
  renderNode,
  type FormattedMemory,
  type FormattedObservation,
  type FormattedSession,
  type FormattedTurn,
} from "./format";
import { expandNumericSelector } from "./selectors";

export interface RecallInput {
  id?: string;
  query?: string;
  time?: string;
  depth?: "collapsed" | "expanded";
  page?: number;
  pageSize?: number;
  truncate?: number;
}

interface ParsedTimeRange {
  after?: number;
  before?: number;
}

interface QueryFilters {
  text?: string;
  type?: string;
  file?: string;
  project?: string;
  tag?: string;
}

const CHILD_PREVIEW_SIZE = 5;
const SESSION_SCAN_LIMIT = 10_000;
const SEARCH_SCAN_LIMIT = 5_000;

type RoutedRecallId =
  | { kind: "sessions"; sessionIds?: number[] }
  | { kind: "turns"; sessionId: number; promptNumbers?: number[] }
  | { kind: "session-observation-list"; sessionId: number }
  | { kind: "observation-list"; sessionId: number; promptNumber: number }
  | { kind: "observation"; observationId: number }
  | { kind: "memories"; memoryIds?: number[] }
  | { kind: "memory"; memoryId: number };

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

  const memoryListMatch = /^M(\*|\d+\.\.\d+)$/i.exec(trimmed);
  if (memoryListMatch) {
    const memoryIds = expandNumericSelector(memoryListMatch[1]!);
    if (memoryIds === null) {
      return null;
    }

    return {
      kind: "memories",
      memoryIds,
    };
  }

  const memoryMatch = /^M(\d+)$/i.exec(trimmed);
  if (memoryMatch) {
    return {
      kind: "memory",
      memoryId: Number(memoryMatch[1]),
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
    if (token.startsWith("project:")) {
      filters.project = token.slice("project:".length);
      continue;
    }
    if (token.startsWith("tag:")) {
      filters.tag = token.slice("tag:".length);
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
    content: session.content,
    insight: splitInsight(session.insight),
    nextSteps: session.nextSteps,
    turnCount: turns.length,
    observationCount: turns.reduce(
      (sum, turn) => sum + (turn.observationCount ?? 0),
      0,
    ),
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
       WHERE turn_id IN (${placeholders})
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
         WHERE t.session_id = ?`,
      )
      .get(session.id)?.count ?? 0;

  return {
    id: session.id,
    title: session.title,
    project: session.project,
    createdAtEpoch: session.createdAtEpoch,
    content: session.content,
    insight: splitInsight(session.insight),
    nextSteps: session.nextSteps,
    turnCount,
    observationCount,
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
    content: session.content,
    insight: splitInsight(session.insight),
    nextSteps: session.nextSteps,
    turnCount: turns.length,
    observationCount: turns.reduce(
      (sum, turn) => sum + (turn.observationCount ?? 0),
      0,
    ),
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
  const observations = getObservationsForTurn(db, turn.id);
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
    observations: observations.map((observation) => ({
      id: observation.id,
      title: observation.title ?? observation.toolName ?? `Observation ${observation.id}`,
      content: observation.content,
    })),
  };
}

function buildMemoryView(
  db: Database,
  memory: NonNullable<ReturnType<typeof getMemory>>,
): FormattedMemory {
  const sourceTurn = memory.sourceTurnId !== null
    ? getTurnById(db, memory.sourceTurnId)
    : null;

  return {
    id: memory.id,
    type: memory.type,
    scope: memory.scope,
    title: memory.title,
    content: memory.content,
    reasoning: memory.reasoning,
    application: memory.application,
    tags: memory.tags,
    createdAtEpoch: memory.createdAtEpoch,
    updatedAtEpoch: memory.updatedAtEpoch,
    sourceCount: memory.sourceTurnId !== null ? 1 : 0,
    source:
      sourceTurn !== null
        ? {
            sessionId: sourceTurn.sessionId,
            promptNumber: sourceTurn.promptNumber,
            title: sourceTurn.title,
            createdAtEpoch: sourceTurn.createdAtEpoch,
          }
        : null,
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

function joinPage(header: string, body: string): string {
  return body ? `${header}\n${body}` : header;
}

function renderSession(
  db: Database,
  session: NonNullable<ReturnType<typeof getSession>>,
  depth: "collapsed" | "expanded",
  truncate?: number,
  turnSelector?: Set<number>,
): string {
  const view = buildSessionSummary(db, session.id) ?? buildSessionView(db, session);
  const lines = [
    renderNode(
      { type: "session", value: view },
      {
        depth: depth === "collapsed" ? "collapsed" : "expanded",
        mode: "unified",
        truncate,
      },
    ),
  ];

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
): string {
  const lines: string[] = [];
  const grouped = new Map<number, TurnRecord[]>();
  for (const turn of turns) {
    const list = grouped.get(turn.sessionId) ?? [];
    list.push(turn);
    grouped.set(turn.sessionId, list);
  }

  const sessions = getRecentSessions(db, { limit: 1000 }).filter((session) =>
    grouped.has(session.id),
  );

  for (const session of sessions) {
    const view = buildSessionSummary(db, session.id);
    if (!view) {
      continue;
    }
    lines.push(
      renderNode(
        { type: "session", value: view },
        { depth: "collapsed", mode: "unified", truncate },
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
          },
        ),
      );
    }

    return lines.join("\n");
  }

  const sessions = getRecentSessions(db, { limit: 1000 }).filter((session) =>
    grouped.has(session.id),
  );

  for (const session of sessions) {
    const sessionView = buildSessionSummary(db, session.id);
    if (!sessionView) {
      continue;
    }
    lines.push(
      renderNode(
        { type: "session", value: sessionView },
        { depth: "collapsed", mode: "unified", truncate },
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
            },
          ),
        );
      }
    }
  }

  return lines.join("\n");
}

function renderMemoryScope(
  db: Database,
  memoryIds: number[],
  depth: "collapsed" | "expanded",
  truncate?: number,
): string {
  return memoryIds
    .map((memoryId) => getMemory(db, memoryId))
    .filter(
      (memory): memory is NonNullable<ReturnType<typeof getMemory>> => memory !== null,
    )
    .map((memory) => buildMemoryView(db, memory))
    .map((memory) =>
      renderNode(
        { type: "memory", value: memory },
        {
          depth: depth === "collapsed" ? "collapsed" : "expanded",
          mode: "unified",
          truncate,
        },
      ),
    )
    .join("\n");
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
): string {
  const session = getSession(db, sessionId);
  return session ? renderSession(db, session, depth, truncate) : "Session not found.";
}

function renderTurnDetail(
  db: Database,
  sessionId: number,
  promptNumber: number,
  depth: "collapsed" | "expanded",
  truncate?: number,
): string {
  const turn = getTurn(db, sessionId, promptNumber);
  return turn ? renderTurnScope(db, [turn], depth, truncate) : "Turn not found.";
}

function renderObservationDetail(
  db: Database,
  observationId: number,
  depth: "collapsed" | "expanded",
  truncate?: number,
): string {
  const observation = getObservation(db, observationId);
  if (!observation) {
    return "Observation not found.";
  }

  const view = buildObservationView(observation);
  return renderNode(
    { type: "observation", value: view },
    {
      depth: depth === "collapsed" ? "collapsed" : "expanded",
      mode: "unified",
      truncate,
    },
  );
}

function renderMemoryDetail(
  db: Database,
  memoryId: number,
  depth: "collapsed" | "expanded",
  truncate?: number,
): string {
  const memory = getMemory(db, memoryId);
  if (!memory) {
    return "Memory not found.";
  }

  const view = buildMemoryView(db, memory);
  return renderNode(
    { type: "memory", value: view },
    {
      depth: depth === "collapsed" ? "collapsed" : "expanded",
      mode: "unified",
      truncate,
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
    : getRecentSessions(db, { limit: SESSION_SCAN_LIMIT });

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

  const selected = new Set(promptNumbers);
  return turns.filter((turn) => selected.has(turn.promptNumber));
}

function filterResultsByTag(
  db: Database,
  results: SearchMemoryResult[],
  tag: string | undefined,
): SearchMemoryResult[] {
  if (!tag) {
    return results;
  }

  return results.filter((result) => {
    if (result.layer === "memory") {
      const memory = getMemory(db, result.sourceId);
      return memory?.tags.includes(tag) ?? false;
    }

    return false;
  });
}

function renderGroupedSearchResults(
  db: Database,
  results: SearchMemoryResult[],
  depth: "collapsed" | "expanded",
  truncate?: number,
): string {
  const memoryLines: string[] = [];
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
    if (result.layer === "memory") {
      const memory = getMemory(db, result.sourceId);
      if (memory) {
        const view = buildMemoryView(db, memory);
        memoryLines.push(
          renderNode(
            { type: "memory", value: view },
            {
              depth: depth === "collapsed" ? "collapsed" : "expanded",
              mode: "unified",
              truncate,
            },
          ),
        );
      }
      continue;
    }

    if (result.sessionId === null) {
      continue;
    }

    let group = sessionGroups.get(result.sessionId);
    if (!group) {
      group = {
        sessionHit: false,
        turnIds: new Set<number>(),
        observationIdsByTurnId: new Map<number, number[]>(),
      };
      sessionGroups.set(result.sessionId, group);
      sessionOrder.push(result.sessionId);
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
      return renderSession(db, session, depth, truncate);
    }

    const lines = [
      renderNode(
        {
          type: "session",
          value: buildSessionSummary(db, session.id) ?? buildSessionView(db, session),
        },
        { depth: "collapsed", mode: "unified", truncate },
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
            },
          ),
        );
      }
    }

    return lines.join("\n");
  });

  return [...memoryLines, ...sessionLines.filter(Boolean)].join("\n");
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
        .map((sessionId) => renderSessionDetail(db, sessionId, depth, truncate))
        .join("\n"),
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
      renderTurnScope(db, paged.items, depth, truncate),
    );
  }

  if (routed.kind === "observation-list") {
    const turn = getTurn(db, routed.sessionId, routed.promptNumber);
    if (!turn) {
      return "Turn not found.";
    }

    const observations = getObservationsForTurn(db, turn.id)
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
      renderObservationScope(db, paged.items, depth, true, truncate),
    );
  }

  if (routed.kind === "session-observation-list") {
    const observations = getTurnsForSession(db, routed.sessionId)
      .flatMap((turn) =>
        getObservationsForTurn(db, turn.id)
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
      renderObservationScope(db, paged.items, depth, true, truncate),
    );
  }

  if (routed.kind === "observation") {
    return renderObservationDetail(db, routed.observationId, depth, truncate);
  }

  if (routed.kind === "memories") {
    const memoryIds = routed.memoryIds && routed.memoryIds.length > 0
      ? routed.memoryIds
      : searchMemory(
          db,
          { scope: "memories", limit: SEARCH_SCAN_LIMIT, after, before },
        ).map((result) => result.sourceId);
    const paged = paginateItems(memoryIds, page, pageSize);
    return joinPage(
      formatPageHeader(page, paged.pageCount, paged.total),
      renderMemoryScope(db, paged.items, depth, truncate),
    );
  }

  return routed.kind === "memory"
    ? renderMemoryDetail(db, routed.memoryId, depth, truncate)
    : "";
}

function renderSessionList(
  db: Database,
  depth: "collapsed" | "expanded",
  page: number,
  pageSize: number,
  truncate?: number,
  after?: number,
  before?: number,
): string {
  const paged = paginateItems(
    listSessionIds(db, undefined, after, before),
    page,
    pageSize,
  );

  return joinPage(
    formatPageHeader(page, paged.pageCount, paged.total),
    paged.items
      .map((sessionId) => renderSessionDetail(db, sessionId, depth, truncate))
      .join("\n"),
  );
}

function searchQueryResults(
  db: Database,
  filters: QueryFilters,
  limit: number,
  after?: number,
  before?: number,
): SearchMemoryResult[] {
  if (
    filters.tag &&
    !filters.text &&
    !filters.type &&
    !filters.file &&
    !filters.project
  ) {
    return [
      ...searchMemory(db, {
        scope: "observations",
        after,
        before,
        limit,
      }),
      ...searchMemory(db, {
        scope: "memories",
        after,
        before,
        limit,
      }),
    ];
  }

  return searchMemory(db, {
    query: filters.text,
    type: filters.type,
    file: filters.file,
    project: filters.project,
    after,
    before,
    limit,
  });
}

export function recallMemory(db: Database, input: RecallInput): string {
  const depth = input.depth ?? "collapsed";
  const page = Math.max(1, input.page ?? 1);
  const pageSize = input.pageSize ?? (depth === "collapsed" ? 50 : 10);
  const truncate = input.truncate ?? DEFAULT_TRUNCATE;
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
    );
  }

  if (input.query) {
    const filters = parseQueryFilters(input.query);
    const results = filterResultsByTag(
      db,
      searchQueryResults(
        db,
        filters,
        SEARCH_SCAN_LIMIT,
        timeRange.after,
        timeRange.before,
      ),
      filters.tag,
    );
    const paged = paginateItems(results, page, pageSize);

    return joinPage(
      formatPageHeader(page, paged.pageCount, paged.total),
      renderGroupedSearchResults(db, paged.items, depth, truncate),
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
  );
}
