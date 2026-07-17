import type { Database } from "bun:sqlite";
import { join } from "node:path";

import type { DiaryStateStore } from "../../db/diary-state";
import {
  getRecentSessions,
  getSessionByContentId,
  upsertSession,
  type SessionRecord,
} from "../../db/sessions";
import * as formatModule from "../../mcp/format";
import { resolveTurnPointers } from "../../mcp/turn-pointers";
import type {
  FormattedSession,
} from "../../mcp/format";
import {
  renderCurrentSessionOutput,
  type CurrentSessionTimelineRenderer,
} from "../../mcp/session-output";
import { parseMarkdownSections } from "../../shared/markdown-sections";
import { resolveTranscriptPath } from "../../shared/paths";
import type { HookResult, NormalizedHookInput } from "../types";
import { recoverStrandedTurns } from "../../db/recover-stranded";
import { diaryDayOf } from "../../diary/domain";
import type { DiaryFileStore } from "../../diary/file-store";
import type { DreamMemoryStore } from "../../diary/memory-store";
import {
  renderPersonaDocumentInjection,
  renderSessionStartExperienceInjection,
  renderSessionStartPersonaInjection,
  SESSION_INJECTION_TOKEN_BUDGET,
} from "../../diary/persona-render";
import { dreamTriggerWindow } from "../../diary/calendar";
import { markSessionRunStart } from "../../db/session-run";

export interface ReadOnlyContextHandlerDependencies {
  fileStore?: Pick<
    DiaryFileStore,
    "readIndex"
  >;
  memoryStore?: Pick<
    DreamMemoryStore,
    "dataRoot" | "readInjectionDocuments"
  >;
}

export interface ContextHandlerDependencies
  extends ReadOnlyContextHandlerDependencies {
  db: Database;
  timelineRenderer?: CurrentSessionTimelineRenderer;
  diaryStateStore?: Pick<
    DiaryStateStore,
    | "initializeBootstrap"
    | "reconcileBacklog"
  >;
  nowEpoch?: () => number;
  dreamSchedule?: {
    hour: number;
    timeZone: string;
    backlogLimit: number;
  };
  readLastSuccessfulDate?: () => Promise<string | null>;
}

export type ContextSection = "sessions" | "persona" | "experience";
export type ReadOnlyContextSection = Exclude<ContextSection, "sessions">;

const EMPTY_CONTEXT_FALLBACK = "claude-mnemo memory available via recall() and the mnemo-replay skill.";

function hasDocumentBody(document: string): boolean {
  return parseMarkdownSections(document).some((section) =>
    section.bodyLines.some((line) => line.trim().length > 0)
  );
}

async function readPersonaContext(
  memoryStore: Pick<DreamMemoryStore, "dataRoot" | "readInjectionDocuments">,
): Promise<string | undefined> {
  try {
    const memory = await memoryStore.readInjectionDocuments();
    if (!hasDocumentBody(memory.userProfile)) {
      return undefined;
    }
    return renderSessionStartPersonaInjection({
      userProfile: memory.userProfile,
      path: join(memoryStore.dataRoot, "memory", "user-profile.md"),
    });
  } catch {
    return undefined;
  }
}

async function readExperienceContext(
  memoryStore: Pick<DreamMemoryStore, "dataRoot" | "readInjectionDocuments">,
  fileStore: Pick<DiaryFileStore, "readIndex">,
): Promise<string | undefined> {
  try {
    const [memory, indexBytes] = await Promise.all([
      memoryStore.readInjectionDocuments(),
      fileStore.readIndex(),
    ]);
    const diaryIndex = new TextDecoder("utf-8", { fatal: true })
      .decode(indexBytes);
    if (!hasDocumentBody(memory.experience)) {
      return undefined;
    }
    return renderSessionStartExperienceInjection({
      experience: memory.experience,
      diaryIndex,
      paths: {
        experience: join(memoryStore.dataRoot, "memory", "experience.md"),
        diaryIndex: join(memoryStore.dataRoot, "diary", "INDEX.md"),
      },
    });
  } catch {
    return undefined;
  }
}

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
  db: Database,
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
    decision: resolveTurnPointers(db, session.id, session.decision),
    done: resolveTurnPointers(db, session.id, session.done),
    current: session.current,
    reference: session.reference,
    turnCount: metrics?.turnCount ?? 0,
    observationCount: metrics?.observationCount ?? 0,
    jsonlPath: resolveTranscriptPath(session.project, session.contentSessionId),
  };
}

function classifyTimeGroup(epochSeconds: number, now: Date): string {
  const target = new Date(epochSeconds * 1000);
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart.getTime() - 86400_000);
  const weekStart = new Date(todayStart.getTime() - 6 * 86400_000);

  if (target >= todayStart) {
    return "Today";
  }

  if (target >= yesterdayStart) {
    return "Yesterday";
  }

  if (target >= weekStart) {
    return "Last 7 days";
  }

  return "Earlier";
}

function isHuskSession(
  session: SessionRecord,
  sessionMetrics: Map<number, { turnCount: number; observationCount: number }>,
): boolean {
  const untitled = !session.title || session.title.trim().length === 0;
  const turnCount = sessionMetrics.get(session.id)?.turnCount ?? 0;
  return untitled && turnCount === 0;
}

function buildRecentSessionsOutput(
  db: Database,
  recentSessions: SessionRecord[],
  sessionMetrics: Map<number, { turnCount: number; observationCount: number }>,
  primarySessionId: number,
): string[] {
  const others = recentSessions
    .filter((session) => session.id !== primarySessionId)
    .filter((session) => !isHuskSession(session, sessionMetrics))
    .slice(0, 10);

  if (others.length === 0) {
    return [];
  }

  const now = new Date();
  const lines: string[] = [];
  let currentGroup = "";

  for (const session of others) {
    const group = classifyTimeGroup(session.createdAtEpoch, now);
    if (group !== currentGroup) {
      currentGroup = group;
      lines.push(`### ${group}`);
    }

    lines.push(
      formatModule.renderNode(
        { type: "session", value: buildSessionView(db, session, sessionMetrics.get(session.id)) },
        { depth: "collapsed", truncate: 120, mode: "unified" },
      ),
    );
  }

  return lines;
}

function buildContextOutput(
  db: Database,
  input: NormalizedHookInput,
  timelineRenderer?: CurrentSessionTimelineRenderer,
): string {
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

  const recentSessions = getRecentSessions(db, {
    project: input.cwd ?? undefined,
    limit: 20,
  });
  const primarySessionRecord = resolvePrimarySessionRecord(
    db,
    input,
    recentSessions,
  );

  if (!primarySessionRecord) {
    return EMPTY_CONTEXT_FALLBACK;
  }

  if (input.source === "resume" || input.source === "compact") {
    recoverStrandedTurns(
      db,
      primarySessionRecord.id,
      Math.floor(Date.now() / 1000),
    );
  }

  const sessionIds = Array.from(
    new Set([...recentSessions.map((session) => session.id), primarySessionRecord.id]),
  );
  const sessionMetrics = buildSessionMetricMap(db, sessionIds);
  const primarySession = buildSessionView(
    db,
    primarySessionRecord,
    sessionMetrics.get(primarySessionRecord.id),
  );

  const recentSessionOutputs = buildRecentSessionsOutput(
    db,
    recentSessions,
    sessionMetrics,
    primarySessionRecord.id,
  );

  const primaryTurnCount = sessionMetrics.get(primarySessionRecord.id)?.turnCount ?? 0;
  const includeCurrentSession =
    input.source !== "startup" && primaryTurnCount > 0;

  const header = buildHeader(
    db,
    input.sessionId ? primarySessionRecord.id : undefined,
  );
  const sessionDocument = [
    ...(includeCurrentSession
      ? [
          "## Current Session",
          "",
          renderCurrentSessionOutput(
            db,
            primarySession,
            primarySessionRecord,
            timelineRenderer,
          ),
          "",
        ]
      : []),
    "## Recent Sessions",
    "",
    ...recentSessionOutputs,
  ].join("\n");
  const boundedSessionDocument = renderPersonaDocumentInjection(
    sessionDocument,
    SESSION_INJECTION_TOKEN_BUDGET,
    `recall(id="S${primarySessionRecord.id}")`,
  );

  return [header, "", boundedSessionDocument].join("\n");
}

export function createReadOnlyContextHandler(
  dependencies: ReadOnlyContextHandlerDependencies,
  section: ReadOnlyContextSection,
) {
  return async function handleReadOnlyContextHook(
    _input: NormalizedHookInput,
  ): Promise<HookResult> {
    if (section === "persona") {
      if (!dependencies.memoryStore) {
        return { continue: true };
      }
      const hookSpecificOutput = await readPersonaContext(
        dependencies.memoryStore,
      );
      return hookSpecificOutput
        ? { continue: true, hookSpecificOutput }
        : { continue: true };
    }

    if (!dependencies.memoryStore || !dependencies.fileStore) {
      return { continue: true };
    }
    const hookSpecificOutput = await readExperienceContext(
      dependencies.memoryStore,
      dependencies.fileStore,
    );
    return hookSpecificOutput
      ? { continue: true, hookSpecificOutput }
      : { continue: true };
  };
}

export function createContextHandler(
  dependencies: ContextHandlerDependencies,
  section: ContextSection = "sessions",
) {
  if (section !== "sessions") {
    return createReadOnlyContextHandler(dependencies, section);
  }

  return async function handleContextHook(
    input: NormalizedHookInput,
  ): Promise<HookResult> {
    const hookSpecificOutput = buildContextOutput(
      dependencies.db,
      input,
      dependencies.timelineRenderer,
    );
    if (input.sessionId && input.source !== "compact") {
      const session = getSessionByContentId(dependencies.db, input.sessionId);
      if (session) {
        markSessionRunStart(dependencies.db, session.id);
      }
    }
    const nowEpoch =
      dependencies.nowEpoch?.() ?? Math.floor(Date.now() / 1_000);
    const triggerWindow = dependencies.dreamSchedule
      ? dreamTriggerWindow({
          nowEpoch,
          timeZone: dependencies.dreamSchedule.timeZone,
          triggerHour: dependencies.dreamSchedule.hour,
        })
      : null;
    const today = triggerWindow?.today ?? diaryDayOf(nowEpoch);

    try {
      if (dependencies.diaryStateStore) {
        const bootstrap = dependencies.diaryStateStore.initializeBootstrap(today);
        if (triggerWindow?.hasPassedTrigger) {
          dependencies.diaryStateStore.reconcileBacklog({
            today,
            cutoverDate: bootstrap.cutoverDate,
            lastSuccessfulDate:
              await dependencies.readLastSuccessfulDate?.() ?? null,
            maxDays: dependencies.dreamSchedule!.backlogLimit,
            timeZone: dependencies.dreamSchedule!.timeZone,
            boundaryHour: dependencies.dreamSchedule!.hour,
            enqueuedAtEpoch: nowEpoch,
          });
        }
      }
    } catch {
      // Diary backfill is best-effort: SessionStart context must still be returned.
    }

    return {
      continue: true,
      hookSpecificOutput,
    };
  };
}
