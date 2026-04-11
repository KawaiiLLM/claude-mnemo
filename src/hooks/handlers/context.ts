import type { Database } from "bun:sqlite";

import { listMemories, type MemoryRecord } from "../../db/memories";
import {
  getRecentSessions,
  getSessionByContentId,
  type SessionRecord,
} from "../../db/sessions";
import { getTurnsForSession } from "../../db/turns";
import * as formatModule from "../../mcp/format";
import type {
  FormattedMemory,
  FormattedSession,
  FormattedTurn,
} from "../../mcp/format";
import type { HookResult, NormalizedHookInput } from "../types";

export interface ContextHandlerDependencies {
  db: Database;
}

const EMPTY_CONTEXT_FALLBACK = "claude-mnemo memory available via recall() and the mnemo-replay skill.";

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

function buildHeader(db: Database): string {
  const sessionCount =
    db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM sessions")
      .get()?.count ?? 0;
  const observationCount =
    db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM observations")
      .get()?.count ?? 0;

  return [
    `claude-mnemo: ${sessionCount} sessions, ${observationCount} observations`,
    "Types: 🔴bugfix 🟣feature 🔄refactor ✅change 🔵discovery ⚖️decision",
    "Stats: 💬turns 💡observations 📖read ✏️modified 🔧tools",
    "Format:",
    "  - [Sx] title | 💬n 💡n | yyyy-mm-dd | project",
    "  - [Tx] title | 💡n 📖n ✏️n 🔧n",
    "  - [Ox] 🔵 title",
    "  - [Mx] type/scope: title | yyyy-mm-dd | sources",
    'Expand: recall(id="Sx/Ty", depth="expanded")',
  ].join("\n");
}

function resolvePrimarySessionRecord(
  db: Database,
  input: NormalizedHookInput,
  recentSessions: SessionRecord[],
): SessionRecord | null {
  const currentSession = input.sessionId
    ? getSessionByContentId(db, input.sessionId)
    : null;

  return currentSession ?? recentSessions[0] ?? null;
}

function buildSessionMetricMap(
  db: Database,
  sessionIds: number[],
): Map<number, { turnCount: number; observationCount: number }> {
  if (sessionIds.length === 0) {
    return new Map();
  }

  const placeholders = sessionIds.map(() => "?").join(", ");
  const metrics = new Map<number, { turnCount: number; observationCount: number }>();

  for (const sessionId of sessionIds) {
    metrics.set(sessionId, { turnCount: 0, observationCount: 0 });
  }

  const turnRows = db
    .query<{ sessionId: number; count: number }, number[]>(
      `SELECT session_id AS sessionId, COUNT(*) AS count
       FROM turns
       WHERE session_id IN (${placeholders})
       GROUP BY session_id`,
    )
    .all(...sessionIds);

  for (const row of turnRows) {
    const metric = metrics.get(row.sessionId);
    if (metric) {
      metric.turnCount = row.count;
    }
  }

  const observationRows = db
    .query<{ sessionId: number; count: number }, number[]>(
      `SELECT t.session_id AS sessionId, COUNT(*) AS count
       FROM observations o
       JOIN turns t ON t.id = o.turn_id
       WHERE t.session_id IN (${placeholders})
       GROUP BY t.session_id`,
    )
    .all(...sessionIds);

  for (const row of observationRows) {
    const metric = metrics.get(row.sessionId);
    if (metric) {
      metric.observationCount = row.count;
    }
  }

  return metrics;
}

function buildSessionView(
  session: SessionRecord,
  metrics: { turnCount: number; observationCount: number } | undefined,
): FormattedSession {
  return {
    id: session.id,
    title: session.title,
    project: session.project,
    createdAtEpoch: session.createdAtEpoch,
    content: session.content,
    insight: splitInsight(session.insight),
    nextSteps: session.nextSteps,
    turnCount: metrics?.turnCount ?? 0,
    observationCount: metrics?.observationCount ?? 0,
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

function buildCollapsedTurnViews(
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

function buildCurrentSessionOutput(
  session: FormattedSession,
  turns: FormattedTurn[],
): string {
  const lines = [
    formatModule.renderNode(
      { type: "session", value: session },
      { depth: "expanded", mode: "legacy" },
    ),
  ];

  for (const turn of turns) {
    lines.push(
      formatModule.renderNode(
        { type: "turn", value: turn },
        { depth: "collapsed", mode: "legacy" },
      ),
    );
  }

  return lines.join("\n");
}

function buildRecentSessionsOutput(
  recentSessions: SessionRecord[],
  sessionMetrics: Map<number, { turnCount: number; observationCount: number }>,
  primarySessionId: number,
): string[] {
  const others = recentSessions.filter((session) => session.id !== primarySessionId).slice(0, 4);

  return others
    .map((session) => buildSessionView(session, sessionMetrics.get(session.id)))
    .map((session) =>
      formatModule.renderNode(
        { type: "session", value: session },
        { depth: "collapsed", mode: "legacy" },
      ),
    );
}

function buildMemoryView(memory: MemoryRecord): FormattedMemory {
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
    source: null,
  };
}

function mergeMemoryLists(...memoryLists: MemoryRecord[][]): MemoryRecord[] {
  const seen = new Set<number>();
  const merged: MemoryRecord[] = [];

  for (const list of memoryLists) {
    for (const memory of list) {
      if (seen.has(memory.id)) {
        continue;
      }

      seen.add(memory.id);
      merged.push(memory);
    }
  }

  return merged
    .sort((left, right) => {
      const leftTimestamp = left.updatedAtEpoch ?? left.createdAtEpoch;
      const rightTimestamp = right.updatedAtEpoch ?? right.createdAtEpoch;

      if (rightTimestamp !== leftTimestamp) {
        return rightTimestamp - leftTimestamp;
      }

      return right.id - left.id;
    })
    .slice(0, 50);
}

function buildMemoriesOutput(
  db: Database,
  projectScope: string | undefined,
): string[] {
  const memories = mergeMemoryLists(
    listMemories(db, {
      scope: "global",
      status: "active",
      limit: 50,
    }),
    projectScope
      ? listMemories(db, {
          scope: projectScope,
          status: "active",
          limit: 50,
        })
      : [],
  );

  if (memories.length === 0) {
    return [];
  }

  return [
    "## Memories",
    "",
    ...memories.map((memory) =>
      formatModule.renderNode(
        { type: "memory", value: buildMemoryView(memory) },
        { depth: "collapsed", mode: "legacy" },
      ),
    ),
  ];
}

function buildContextOutput(db: Database, input: NormalizedHookInput): string {
  const recentSessions = getRecentSessions(db, { limit: 5 });
  const primarySessionRecord = resolvePrimarySessionRecord(
    db,
    input,
    recentSessions,
  );

  if (!primarySessionRecord) {
    return EMPTY_CONTEXT_FALLBACK;
  }

  const sessionIds = Array.from(
    new Set([...recentSessions.map((session) => session.id), primarySessionRecord.id]),
  );
  const sessionMetrics = buildSessionMetricMap(db, sessionIds);
  const primarySession = buildSessionView(
    primarySessionRecord,
    sessionMetrics.get(primarySessionRecord.id),
  );
  const primaryTurns = buildCollapsedTurnViews(db, primarySessionRecord.id);
  const memories = buildMemoriesOutput(
    db,
    primarySessionRecord.project,
  );

  const recentSessionOutputs = buildRecentSessionsOutput(
    recentSessions,
    sessionMetrics,
    primarySessionRecord.id,
  );

  return [
    buildHeader(db),
    "",
    ...memories,
    ...(memories.length > 0 ? [""] : []),
    "## Current Session",
    "",
    buildCurrentSessionOutput(primarySession, primaryTurns),
    "",
    "## Recent Sessions",
    "",
    ...recentSessionOutputs,
  ].join("\n");
}

export function createContextHandler(dependencies: ContextHandlerDependencies) {
  return async function handleContextHook(
    input: NormalizedHookInput,
  ): Promise<HookResult> {
    return {
      continue: true,
      hookSpecificOutput: buildContextOutput(dependencies.db, input),
    };
  };
}
