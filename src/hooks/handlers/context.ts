import type { Database } from "bun:sqlite";
import { basename } from "node:path";

import { listMemories, type MemoryRecord } from "../../db/memories";
import {
  getRecentSessions,
  getSessionByContentId,
  type SessionRecord,
} from "../../db/sessions";
import {
  buildCollapsedTurnsForSession,
  buildSessionSummary,
} from "../../mcp/recall";
import {
  formatSessionCollapsed,
  formatSessionExpanded,
  formatMemoryCollapsed,
  formatTurnCollapsed,
  type FormattedMemory,
  type FormattedSession,
  type FormattedTurn,
} from "../../mcp/format";
import type { HookResult, NormalizedHookInput } from "../types";

export interface ContextHandlerDependencies {
  db: Database;
}

const EMPTY_CONTEXT_FALLBACK = "claude-mnemo memory available via recall() and replay().";

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
    'Expand: recall(scope="turns", session=x, turn=y) | Raw: replay(session=x, turn=y)',
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

function buildCurrentSessionOutput(
  session: FormattedSession,
  turns: FormattedTurn[],
): string {
  const lines = [formatSessionExpanded(session)];

  for (const turn of turns) {
    lines.push(formatTurnCollapsed(turn));
  }

  return lines.join("\n");
}

function buildRecentSessionsOutput(
  db: Database,
  recentSessions: SessionRecord[],
  primarySessionId: number,
): string[] {
  const others = recentSessions.filter((session) => session.id !== primarySessionId).slice(0, 4);

  return others
    .map((session) => buildSessionSummary(db, session.id))
    .filter((session): session is FormattedSession => session !== null)
    .map((session) => formatSessionCollapsed(session));
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
    ...memories.map((memory) => formatMemoryCollapsed(buildMemoryView(memory))),
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

  const primarySession = buildSessionSummary(db, primarySessionRecord.id);
  if (!primarySession) {
    return EMPTY_CONTEXT_FALLBACK;
  }
  const primaryTurns = buildCollapsedTurnsForSession(db, primarySessionRecord.id);
  const memories = buildMemoriesOutput(
    db,
    basename(primarySessionRecord.project),
  );

  const recentSessionOutputs = buildRecentSessionsOutput(
    db,
    recentSessions,
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
