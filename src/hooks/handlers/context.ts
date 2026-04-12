import type { Database } from "bun:sqlite";

import { listMemories, type MemoryRecord } from "../../db/memories";
import {
  getRecentSessions,
  getSessionByContentId,
  upsertSession,
  type SessionRecord,
} from "../../db/sessions";
import * as formatModule from "../../mcp/format";
import { buildContextTimelineView, renderTimeline } from "../../mcp/timeline";
import type {
  FormattedMemory,
  FormattedSession,
} from "../../mcp/format";
import { resolveTranscriptPath } from "../../shared/paths";
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

function buildHeader(db: Database, primarySessionId?: number): string {
  const sessionCount =
    db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM sessions")
      .get()?.count ?? 0;
  const observationCount =
    db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM observations")
      .get()?.count ?? 0;

  return [
    `claude-mnemo: ${sessionCount} sessions, ${observationCount} observations${primarySessionId ? ` | current: S${primarySessionId}` : ""}`,
    "Axes: recall (content) · timeline (temporal) · mnemo-replay (raw)",
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
    jsonlPath: resolveTranscriptPath(session.project, session.contentSessionId),
  };
}

function buildCurrentSessionOutput(
  db: Database,
  session: FormattedSession,
  sessionRecord: SessionRecord,
): string {
  const lines = [`[S${session.id}] ${session.title ?? "(untitled session)"}`];
  const insightLines = session.insight ?? [];

  if (insightLines.length > 0) {
    lines.push("  insight:");
    for (const line of insightLines) {
      lines.push(`  - ${line}`);
    }
  }

  const timelineView = buildContextTimelineView(db, sessionRecord.id);
  lines.push("");
  lines.push(
    renderTimeline(timelineView, {
      promptCap: 80,
      lastPage: true,
      windowPhasesOnly: true,
    }),
  );

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
        { depth: "collapsed", truncate: 120, mode: "unified" },
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
  if (input.sessionId && !getSessionByContentId(db, input.sessionId)) {
    upsertSession(db, {
      contentSessionId: input.sessionId,
      project: input.cwd ?? "",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: Math.floor(Date.now() / 1000),
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });
  }

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
  const memories = buildMemoriesOutput(
    db,
    primarySessionRecord.project,
  );

  const recentSessionOutputs = buildRecentSessionsOutput(
    recentSessions,
    sessionMetrics,
    primarySessionRecord.id,
  );

  const primaryTurnCount = sessionMetrics.get(primarySessionRecord.id)?.turnCount ?? 0;
  const includeCurrentSession =
    input.source !== "startup" && primaryTurnCount > 0;

  return [
    buildHeader(db, input.sessionId ? primarySessionRecord.id : undefined),
    "",
    ...memories,
    ...(memories.length > 0 ? [""] : []),
    ...(includeCurrentSession
      ? [
          "## Current Session",
          "",
          buildCurrentSessionOutput(db, primarySession, primarySessionRecord),
          "",
        ]
      : []),
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
