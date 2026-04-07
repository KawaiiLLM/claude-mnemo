import type { Database } from "bun:sqlite";

import { getRecentSessions, getSessionByContentId, type SessionRecord } from "../../db/sessions";
import { getTurnsForSession } from "../../db/turns";
import { buildFormattedSession } from "../../mcp/recall";
import {
  formatObservationCollapsed,
  formatObservationExpanded,
  formatSessionCollapsed,
  formatSessionExpanded,
  formatTurnCollapsed,
  formatTurnExpanded,
  type FormattedObservation,
  type FormattedSession,
  type FormattedTurn,
} from "../../mcp/format";
import type { HookResult, NormalizedHookInput } from "../types";

export interface ContextHandlerDependencies {
  db: Database;
}

const EMPTY_CONTEXT_FALLBACK = "claude-mnemo memory available via recall() and replay().";

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

function truncateSession(session: FormattedSession): FormattedSession {
  return {
    ...session,
    description: session.description ? truncate(session.description, 60) : null,
    insight: session.insight?.map((item) => truncate(item, 80)),
    nextSteps: session.nextSteps ? truncate(session.nextSteps, 80) : null,
    turns: session.turns?.map(truncateTurn),
  };
}

function truncateTurn(turn: FormattedTurn): FormattedTurn {
  return {
    ...turn,
    description: turn.description ? truncate(turn.description, 60) : null,
    promptPreview: turn.promptPreview ? truncate(turn.promptPreview, 120) : null,
    responsePreview: turn.responsePreview
      ? truncate(turn.responsePreview, 200)
      : null,
    insight: turn.insight?.map((item) => truncate(item, 80)),
    observations: turn.observations?.map(truncateObservation),
  };
}

function truncateObservation(
  observation: FormattedObservation,
): FormattedObservation {
  return {
    ...observation,
    description: observation.description
      ? truncate(observation.description, 60)
      : null,
  };
}

function isDetailedObservation(observation: FormattedObservation): boolean {
  return Boolean(
    observation.narrative ||
      (observation.facts && observation.facts.length > 0) ||
      (observation.concepts && observation.concepts.length > 0) ||
      (observation.filesRead && observation.filesRead.length > 0) ||
      (observation.filesModified && observation.filesModified.length > 0),
  );
}

function formatObservationContext(
  observation: FormattedObservation,
): string {
  return isDetailedObservation(observation)
    ? formatObservationExpanded(observation, { indent: "    " })
    : formatObservationCollapsed(observation, { indent: "    " });
}

function formatPrimarySession(session: FormattedSession): string {
  const lines = [formatSessionExpanded(truncateSession(session))];
  const turns = session.turns ?? [];
  const expandedTurnNumbers = new Set(
    turns.slice(Math.max(0, turns.length - 3)).map((turn) => turn.promptNumber),
  );

  for (const turn of turns) {
    const truncatedTurn = truncateTurn(turn);

    if (!expandedTurnNumbers.has(turn.promptNumber)) {
      lines.push(formatTurnCollapsed(truncatedTurn));
      continue;
    }

    lines.push(formatTurnExpanded(truncatedTurn));

    const observations = (turn.observations ?? []).slice(0, 3);

    for (const observation of observations) {
      lines.push(formatObservationContext(truncateObservation(observation)));
    }

    if ((turn.observations?.length ?? 0) > 3) {
      lines.push(`    - ... and ${turn.observations!.length - 3} more observations`);
    }
  }

  return lines.join("\n");
}

function formatRecentSession(session: FormattedSession): string {
  const lines = [formatSessionCollapsed(truncateSession(session))];
  const turns = (session.turns ?? []).slice(-5);

  for (const turn of turns) {
    lines.push(formatTurnCollapsed(truncateTurn(turn)));
  }

  if ((session.turns?.length ?? 0) > 5) {
    lines.push(`  - ... and ${session.turns!.length - 5} more turns`);
  }

  return lines.join("\n");
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
    "Expand: recall(session=x, turn=y) | Raw: replay(session=x, turn=y)",
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

function buildPrimarySession(
  db: Database,
  primarySessionRecord: SessionRecord | null,
): FormattedSession | null {
  if (!primarySessionRecord) {
    return null;
  }

  const expandTurnNumbers = getTurnsForSession(db, primarySessionRecord.id)
    .slice(-3)
    .map((turn) => turn.promptNumber);
  const primarySession = buildFormattedSession(
    db,
    primarySessionRecord.id,
    expandTurnNumbers,
  );

  return primarySession ? truncateSession(primarySession) : null;
}

function buildRecentSessions(
  db: Database,
  recentSessions: SessionRecord[],
  primarySession: FormattedSession | null,
): FormattedSession[] {
  if (!primarySession) {
    return [];
  }

  const primaryId = primarySession.id;
  const others = recentSessions
    .filter((session) => session.id !== primaryId)
    .slice(0, 4);

  return others
    .map((session) => buildFormattedSession(db, session.id))
    .filter((session): session is FormattedSession => session !== null)
    .map(truncateSession);
}

function buildContextOutput(db: Database, input: NormalizedHookInput): string {
  const recentSessions = getRecentSessions(db, { limit: 5 });
  const primarySessionRecord = resolvePrimarySessionRecord(
    db,
    input,
    recentSessions,
  );
  const primarySession = buildPrimarySession(db, primarySessionRecord);
  const formattedRecentSessions = buildRecentSessions(
    db,
    recentSessions,
    primarySession,
  );

  if (!primarySession) {
    return EMPTY_CONTEXT_FALLBACK;
  }

  const nextTwoSessions = formattedRecentSessions.slice(0, 2);
  const lastTwoSessions = formattedRecentSessions.slice(2, 4);

  return [
    buildHeader(db),
    "",
    "## Current Session",
    "",
    formatPrimarySession(primarySession),
    "",
    "## Recent Sessions",
    "",
    ...nextTwoSessions.map((session) => formatRecentSession(session)),
    ...lastTwoSessions.map((session) => formatSessionCollapsed(session)),
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
