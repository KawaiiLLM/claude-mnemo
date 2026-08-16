import type { Database } from "bun:sqlite";
import { join } from "node:path";

import {
  getRecentSessions,
  getSessionByContentId,
  setSessionTranscriptPathIfAbsent,
  upsertSession,
  type SessionRecord,
} from "../../db/sessions";
import * as formatModule from "../../mcp/format";
import { resolveTurnPointers } from "../../mcp/turn-pointers";
import type {
  FormattedSession,
} from "../../mcp/format";
import { renderCurrentSessionStateOutput } from "../../mcp/session-output";
import { resolveEraCutoff } from "../../db/era";
import { parseMarkdownSections } from "../../shared/markdown-sections";
import { resolveSessionTranscriptPath } from "../../shared/paths";
import type { HookResult, NormalizedHookInput } from "../types";
import { recoverStrandedTurns } from "../../db/recover-stranded";
import type { DiaryFileStore } from "../../diary/file-store";
import type { DreamMemoryStore } from "../../diary/memory-store";
import { estimateDiaryTokens } from "../../diary/domain";
import {
  renderSessionStartPersonaInjection,
  renderSessionStartRecentSessionsInjection,
  SESSION_INJECTION_TOKEN_BUDGET,
} from "../../diary/persona-render";
import { markSessionRunStart } from "../../db/session-run";
import { createRuleStore } from "../../db/rules";
import { renderRuleDigest } from "../../rules/digest";
import {
  notifyWorkerTrigger,
  type WorkerClientDeps,
} from "../../worker/client";

export interface ReadOnlyContextHandlerDependencies {
  db?: Database;
  fileStore?: Pick<DiaryFileStore, "readIndex"> &
    Partial<Pick<DiaryFileStore, "dataRoot">>;
  memoryStore?: Pick<
    DreamMemoryStore,
    "dataRoot" | "readInjectionDocuments"
  >;
}

export interface ContextHandlerDependencies
  extends ReadOnlyContextHandlerDependencies {
  db: Database;
  workerClientDeps?: WorkerClientDeps;
  workerEnv?: NodeJS.ProcessEnv;
  enableSessionEnvCapture?: boolean;
  /**
   * P2 era boundary (spec D11), read once at handler construction. The stranded
   * recovery below needs it to tell a turn whose record is the main agent's own
   * note from one whose extraction fields it may reset. Omitted, it comes from
   * config, whose default (`null`) makes every turn legacy.
   */
  eraCutoffEpoch?: number | null;
}

export type ContextSection = "sessions" | "persona" | "recent" | "digest";
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
    db.query<{ count: number }, []>(
      // Excluded rows (a `note` call's observation) are captured for the raw
      // axis only; counting them here would tell the reader a hidden call exists.
      "SELECT COUNT(*) AS count FROM observations WHERE excluded_from_extraction = 0",
    ).get()?.count ?? 0;

  return [
    `claude-mnemo: ${sessionCount} sessions, ${observationCount} observations${primarySessionId ? ` | current: S${primarySessionId}` : ""}`,
    "Axes: recall (content) · timeline (temporal) · mnemo-replay (raw)",
  ].join("\n");
}

function hasSessionRunStart(db: Database, sessionId: number): boolean {
  return db.query<{ present: number }, [number]>(
    "SELECT 1 AS present FROM session_run_state WHERE session_db_id = ?",
  ).get(sessionId) !== null;
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
         AND o.excluded_from_extraction = 0
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

// Exported for the reader-seam test: `jsonlPath` is the only field here that is
// derived rather than copied, and the renderers this feeds (collapsed session
// list, current-session state) both drop it, so the returned view is the only
// place the resolution is observable.
export function buildSessionView(
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
    reference: session.reference,
    turnCount: metrics?.turnCount ?? 0,
    observationCount: metrics?.observationCount ?? 0,
    jsonlPath: resolveSessionTranscriptPath(session),
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
  currentSessionId?: number,
): string[] {
  const others = recentSessions
    .filter((session) => session.id !== currentSessionId)
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

async function readRecentContext(
  db: Database,
  fileStore: ReadOnlyContextHandlerDependencies["fileStore"],
  input: NormalizedHookInput,
): Promise<string | undefined> {
  try {
    const recentSessions = getRecentSessions(db, {
      project: input.cwd ?? undefined,
      limit: 20,
    });
    const currentSession = input.sessionId
      ? getSessionByContentId(db, input.sessionId)
      : null;
    const sessionMetrics = buildSessionMetricMap(
      db,
      recentSessions.map((session) => session.id),
    );
    const recentSessionDocument = buildRecentSessionsOutput(
      db,
      recentSessions,
      sessionMetrics,
      currentSession?.id,
    ).join("\n");

    let diaryIndex = "";
    if (fileStore) {
      try {
        diaryIndex = new TextDecoder("utf-8", { fatal: true })
          .decode(await fileStore.readIndex());
      } catch {
        // Recent sessions remain useful before the first diary index exists.
      }
    }

    if (recentSessionDocument.trim() === "" && !hasDocumentBody(diaryIndex)) {
      return undefined;
    }

    return renderSessionStartRecentSessionsInjection({
      recentSessions: recentSessionDocument,
      diaryIndex,
      paths: {
        recentSessions: "recall()",
        diaryIndex: fileStore?.dataRoot
          ? join(fileStore.dataRoot, "diary", "INDEX.md")
          : "diary/INDEX.md",
      },
    });
  } catch {
    return undefined;
  }
}

function readRuleDigestContext(
  db: Database,
  input: NormalizedHookInput,
): string | undefined {
  try {
    return renderRuleDigest({
      rules: createRuleStore(db).list(),
      project: input.cwd ?? undefined,
    }) || undefined;
  } catch {
    return undefined;
  }
}


function buildContextOutput(
  db: Database,
  input: NormalizedHookInput,
  eraCutoffEpoch: number | null,
): string | undefined {
  if (input.sessionId && !getSessionByContentId(db, input.sessionId)) {
    upsertSession(db, {
      contentSessionId: input.sessionId,
      project: input.cwd ?? "",
      transcriptPath: input.transcriptPath ?? null,
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: Math.floor(Date.now() / 1000),
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });
  }

  const currentSession = input.sessionId
    ? getSessionByContentId(db, input.sessionId)
    : null;
  // Registration path #1. Covers the already-registered case too (resume of a
  // session whose row predates the column), and the IS NULL guard keeps it
  // first-non-NULL: a resume from a different cwd cannot move the path.
  if (currentSession && input.transcriptPath) {
    setSessionTranscriptPathIfAbsent(
      db,
      currentSession.id,
      input.transcriptPath,
    );
  }
  if (currentSession) {
    recoverStrandedTurns(
      db,
      currentSession.id,
      Math.floor(Date.now() / 1000),
      eraCutoffEpoch,
    );
  }

  if (input.source !== "resume" && input.source !== "compact") {
    return undefined;
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

  const sessionIds = Array.from(
    new Set([...recentSessions.map((session) => session.id), primarySessionRecord.id]),
  );
  const sessionMetrics = buildSessionMetricMap(db, sessionIds);
  const primarySession = buildSessionView(
    db,
    primarySessionRecord,
    sessionMetrics.get(primarySessionRecord.id),
  );

  const primaryTurnCount = sessionMetrics.get(primarySessionRecord.id)?.turnCount ?? 0;
  const includeCurrentSession = primaryTurnCount > 0;

  const header = buildHeader(
    db,
    input.sessionId ? primarySessionRecord.id : undefined,
  );
  // ticket 04: one budget, one cut, and the cut says so.
  //
  // This block used to be bounded TWICE. The state renderer bounds itself to
  // 2,000 tokens and marks its own truncation with a `… state truncated; full
  // summary: recall(id="S<n>")` pointer; the result was then handed to
  // `renderPersonaDocumentInjection` against the same 2,000, which re-cut the
  // very same lines — the heading it added pushed the block over — and
  // replaced the state renderer's pointer with `（其余 N 行省略…）`, whose N
  // counts only the lines the SECOND pass dropped. A reader with half a
  // summary missing was told two lines were. The heading's tokens were the
  // only real work the second pass did, so they are reserved here instead.
  const headingLines = ["## Current Session", ""];
  const stateTokenBudget = Math.max(
    0,
    SESSION_INJECTION_TOKEN_BUDGET -
      estimateDiaryTokens([...headingLines, ""].join("\n")),
  );
  const sessionDocument = includeCurrentSession
    ? [
        ...headingLines,
        renderCurrentSessionStateOutput(
          primarySession,
          primarySessionRecord,
          stateTokenBudget,
        ),
        "",
      ].join("\n")
    : "";

  return sessionDocument ? [header, "", sessionDocument].join("\n") : header;
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

    if (!dependencies.db) {
      return { continue: true };
    }
    if (section === "digest") {
      const hookSpecificOutput = readRuleDigestContext(
        dependencies.db,
        _input,
      );
      return hookSpecificOutput
        ? { continue: true, hookSpecificOutput }
        : { continue: true };
    }
    const hookSpecificOutput = await readRecentContext(
      dependencies.db,
      dependencies.fileStore,
      _input,
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

  const eraCutoffEpoch =
    dependencies.eraCutoffEpoch !== undefined
      ? dependencies.eraCutoffEpoch
      : resolveEraCutoff(dependencies.db);

  return async function handleContextHook(
    input: NormalizedHookInput,
  ): Promise<HookResult> {
    if (dependencies.enableSessionEnvCapture && input.sessionId) {
      void notifyWorkerTrigger(
        {
          action: "capture",
          contentSessionId: input.sessionId,
          sessionDbId: getSessionByContentId(dependencies.db, input.sessionId)?.id,
        },
        dependencies.workerClientDeps,
        dependencies.workerEnv,
      );
    }
    const hookSpecificOutput = buildContextOutput(
      dependencies.db,
      input,
      eraCutoffEpoch,
    );
    if (input.sessionId) {
      const session = getSessionByContentId(dependencies.db, input.sessionId);
      // compact belongs to the current Claude run. Ensure a missing marker,
      // but never move an existing run boundary past turns created in that run.
      if (
        session &&
        (
          input.source !== "compact" ||
          !hasSessionRunStart(dependencies.db, session.id)
        )
      ) {
        markSessionRunStart(dependencies.db, session.id);
      }
    }
    return hookSpecificOutput
      ? { continue: true, hookSpecificOutput }
      : { continue: true };
  };
}
