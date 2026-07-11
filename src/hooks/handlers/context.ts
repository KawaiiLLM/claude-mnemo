import type { Database } from "bun:sqlite";

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
import { resolveTranscriptPath } from "../../shared/paths";
import type { HookResult, NormalizedHookInput } from "../types";
import { recoverStrandedTurns } from "../../db/recover-stranded";
import { diaryDayOf, estimateDiaryTokens } from "../../diary/domain";
import type { DiaryFileStore } from "../../diary/file-store";
import {
  buildRollingRecentLines,
  isValidProfileInjectionSource,
  PROFILE_INJECTION_TOKEN_BUDGET,
  renderProfileInjection,
  renderTrimmedExperienceInjection,
  type RecentLine,
} from "../../diary/experience-render";
import { validateAndMarkStale } from "../../diary/validate-and-mark-stale";

export interface ContextHandlerDependencies {
  db: Database;
  timelineRenderer?: CurrentSessionTimelineRenderer;
  diaryStateStore?: Pick<
    DiaryStateStore,
    | "initializeBootstrap"
    | "reconcileBacklog"
    | "listSettledDays"
    | "nextIntegrityScanBatch"
    | "markDayStaleAndEnqueue"
    | "requestPersonaRebuild"
    | "listIndexRows"
  >;
  nowEpoch?: () => number;
  kickWorkerFast?: () => Promise<void>;
  fileStore?: Pick<
    DiaryFileStore,
    "loadCurrentPersona" | "ensureIndex" | "readIndex" | "readValidatedDiary"
  >;
}

const EMPTY_CONTEXT_FALLBACK = "claude-mnemo memory available via recall() and the mnemo-replay skill.";
const FAST_WORKER_KICK_BUDGET_MS = 500;

async function kickWorkerWithinBudget(
  kickWorkerFast: () => Promise<void>,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([
      kickWorkerFast(),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, FAST_WORKER_KICK_BUDGET_MS);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

async function appendDiaryContext(
  hookSpecificOutput: string,
  fileStore: Pick<DiaryFileStore, "loadCurrentPersona" | "ensureIndex" | "readIndex">,
  db: Database,
  today: string,
  requestRebuild: () => void,
  indexRows: ReturnType<DiaryStateStore["listIndexRows"]>,
): Promise<string> {
  let persona;
  try {
    persona = await fileStore.loadCurrentPersona();
  } catch {
    requestRebuild();
    return hookSpecificOutput;
  }
  let recentLines: RecentLine[] = [];
  const indexBytes = await fileStore.ensureIndex(indexRows).catch(() => null);
  if (indexBytes) {
    try {
      const indexText = new TextDecoder("utf-8", { fatal: true })
        .decode(indexBytes)
        .replace(/^# Diary Index(?:\r?\n|$)/, "")
        .trim();
      recentLines = buildRollingRecentLines(indexText, today);
    } catch {
      recentLines = [];
    }
  }
  const profileBlock = renderProfileInjection(persona.userProfile);
  if (
    !isValidProfileInjectionSource(persona.userProfile) ||
    estimateDiaryTokens(profileBlock) > PROFILE_INJECTION_TOKEN_BUDGET
  ) {
    requestRebuild();
    return hookSpecificOutput;
  }
  const experienceBlock = renderTrimmedExperienceInjection({
    db,
    experience: persona.experience,
    recentLines,
    profileBlock,
  });
  if (!experienceBlock) {
    requestRebuild();
    return hookSpecificOutput;
  }
  return [hookSpecificOutput, "", profileBlock, "", experienceBlock].join("\n");
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

  return [
    buildHeader(db, input.sessionId ? primarySessionRecord.id : undefined),
    "",
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
}

export function createContextHandler(dependencies: ContextHandlerDependencies) {
  return async function handleContextHook(
    input: NormalizedHookInput,
  ): Promise<HookResult> {
    let hookSpecificOutput = buildContextOutput(
      dependencies.db,
      input,
      dependencies.timelineRenderer,
    );
    const nowEpoch =
      dependencies.nowEpoch?.() ?? Math.floor(Date.now() / 1_000);
    const today = diaryDayOf(nowEpoch);

    try {
      if (dependencies.diaryStateStore) {
        const bootstrap = dependencies.diaryStateStore.initializeBootstrap(today);
        if (dependencies.fileStore) {
          const recentStart = new Date(
            Date.parse(`${today}T00:00:00Z`) - 14 * 86_400_000,
          )
            .toISOString()
            .slice(0, 10);
          const recentDays = dependencies.diaryStateStore
            .listSettledDays()
            .filter((day) => day.date >= recentStart && day.date < today);
          const integrityDays =
            dependencies.diaryStateStore.nextIntegrityScanBatch({
              beforeDate: today,
              limit: 10,
            });
          const validationDays = new Map(
            [...recentDays, ...integrityDays].map((day) => [day.date, day]),
          );
          for (const day of validationDays.values()) {
            try {
              await validateAndMarkStale(
                {
                  stateStore: dependencies.diaryStateStore,
                  fileStore: dependencies.fileStore,
                  nowEpoch: () => nowEpoch,
                },
                day,
              );
            } catch {
              // Invalid diary days are requeued by the canonical validation path.
            }
          }
        }
        const reconciledDates = dependencies.diaryStateStore.reconcileBacklog({
          today,
          cutoverDate: bootstrap.cutoverDate,
          enqueuedAtEpoch: nowEpoch,
        });

        if (reconciledDates.length > 0 && dependencies.kickWorkerFast) {
          await kickWorkerWithinBudget(dependencies.kickWorkerFast);
        }
      }
    } catch {
      // Diary backfill is best-effort: SessionStart context must still be returned.
    }

    if (dependencies.fileStore) {
      const requestRebuild = () => {
        const store = dependencies.diaryStateStore;
        if (!store) return;
        store.requestPersonaRebuild();
      };
      hookSpecificOutput = await appendDiaryContext(
        hookSpecificOutput,
        dependencies.fileStore,
        dependencies.db,
        today,
        requestRebuild,
        dependencies.diaryStateStore?.listIndexRows() ?? [],
      );
    }

    return {
      continue: true,
      hookSpecificOutput,
    };
  };
}
