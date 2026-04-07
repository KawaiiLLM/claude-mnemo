import type { Database } from "bun:sqlite";

import { getObservation, getObservationsForTurn } from "../db/observations";
import { searchMemory, type SearchMemoryResult } from "../db/search";
import { getRecentSessions, getSession } from "../db/sessions";
import {
  getTurn,
  getTurnById,
  getTurnsForSession,
  type TurnRecord,
} from "../db/turns";
import { createLogger } from "../shared/logger";
import {
  formatObservationCollapsed,
  formatObservationExpanded,
  formatSessionCollapsed,
  formatSessionExpanded,
  formatTurnCollapsed,
  formatTurnExpanded,
  sampleWithOmissions,
  type FormattedObservation,
  type FormattedSession,
  type FormattedTurn,
} from "./format";

export type RecallScope = "sessions" | "turns" | "observations";
export type SelectorInput = number | number[] | string;

export interface RecallInput {
  scope?: RecallScope;
  session?: SelectorInput;
  turn?: SelectorInput;
  obs?: SelectorInput;
  query?: string;
  type?: string;
  file?: string;
  after?: number;
  before?: number;
  time?: string;
  depth?: "collapsed" | "expanded" | "full";
  observation?: number;
  expandTurns?: number[];
  around?: string;
  project?: string;
  fromEpoch?: number;
  toEpoch?: number;
}

interface ParsedTimeRange {
  after?: number;
  before?: number;
}

const log = createLogger("MCP");

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

function normalizeRecallInput(input: RecallInput): RecallInput {
  const normalized: RecallInput = { ...input };
  const legacyFields: string[] = [];

  if (normalized.observation !== undefined && normalized.obs === undefined) {
    normalized.obs = normalized.observation;
    legacyFields.push("observation");
  }

  if (normalized.fromEpoch !== undefined && normalized.after === undefined) {
    normalized.after = normalized.fromEpoch;
    legacyFields.push("from_epoch");
  }

  if (normalized.toEpoch !== undefined && normalized.before === undefined) {
    normalized.before = normalized.toEpoch;
    legacyFields.push("to_epoch");
  }

  if (normalized.expandTurns !== undefined) {
    legacyFields.push("expand_turns");
  }

  if (normalized.around !== undefined) {
    legacyFields.push("around");
  }

  if (normalized.scope === undefined) {
    legacyFields.push("scope");

    if (
      normalized.session !== undefined &&
      normalized.turn !== undefined &&
      normalized.query === undefined &&
      normalized.type === undefined &&
      normalized.file === undefined &&
      normalized.expandTurns === undefined &&
      normalized.around === undefined
    ) {
      normalized.scope = "turns";
      normalized.depth ??= "expanded";
    } else if (
      normalized.session !== undefined &&
      normalized.turn === undefined &&
      normalized.query === undefined &&
      normalized.type === undefined &&
      normalized.file === undefined &&
      normalized.expandTurns === undefined &&
      normalized.around === undefined
    ) {
      normalized.scope = "turns";
    } else if (
      normalized.obs !== undefined &&
      normalized.session === undefined &&
      normalized.turn === undefined &&
      normalized.query === undefined &&
      normalized.type === undefined &&
      normalized.file === undefined &&
      normalized.expandTurns === undefined &&
      normalized.around === undefined
    ) {
      normalized.scope = "observations";
    }
  }

  if (legacyFields.length > 0) {
    log.warn("legacy recall parameters normalized", {
      legacyFields,
      normalizedScope: normalized.scope ?? "legacy",
    });
  }

  return normalized;
}

function parseSelectorValue(
  value: SelectorInput | undefined,
  label: string,
): { values: number[]; error?: string } {
  if (value === undefined) {
    return { values: [] };
  }

  if (typeof value === "number") {
    return { values: [value] };
  }

  if (Array.isArray(value)) {
    return { values: [...new Set(value)].sort((left, right) => left - right) };
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return { values: [] };
  }

  const rangeMatch = trimmed.match(/^(\d+)\.\.(\d+)$/);
  if (rangeMatch) {
    const start = Number(rangeMatch[1]);
    const end = Number(rangeMatch[2]);
    const lower = Math.min(start, end);
    const upper = Math.max(start, end);
    const values: number[] = [];

    for (let index = lower; index <= upper; index += 1) {
      values.push(index);
    }

    return { values };
  }

  if (/^\d+$/.test(trimmed)) {
    return { values: [Number(trimmed)] };
  }

  return { values: [], error: `invalid ${label} selector "${value}"` };
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

function mergeTimeRanges(
  input: RecallInput,
): { after?: number; before?: number; error?: string } {
  const parsedTime = parseTimeInput(input.time);
  if (parsedTime.error) {
    return { error: parsedTime.error };
  }

  const lowerBounds = [input.after, input.fromEpoch, parsedTime.range?.after].filter(
    (value): value is number => value !== undefined,
  );
  const upperBounds = [input.before, input.toEpoch, parsedTime.range?.before].filter(
    (value): value is number => value !== undefined,
  );

  const after = lowerBounds.length > 0 ? Math.max(...lowerBounds) : undefined;
  const before = upperBounds.length > 0 ? Math.min(...upperBounds) : undefined;

  if (after !== undefined && before !== undefined && after > before) {
    return { error: "time filters do not overlap." };
  }

  return { after, before };
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
    startedAtEpoch: session.startedAtEpoch,
    description: session.description,
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
    startedAtEpoch: session.startedAtEpoch,
    description: session.description,
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

function buildTurnView(db: Database, turn: TurnRecord): FormattedTurn {
  const observations = getObservationsForTurn(db, turn.id);
  return {
    id: turn.id,
    promptNumber: turn.promptNumber,
    title: turn.title,
    description: turn.description,
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
      type: observation.type,
      title: observation.title,
      description: observation.description,
      narrative: observation.narrative,
      facts: observation.facts,
      concepts: observation.concepts,
      filesRead: observation.filesRead,
      filesModified: observation.filesModified,
    })),
  };
}

function selectSearchResults(
  db: Database,
  input: Required<Pick<RecallInput, "scope">> & RecallInput,
  after?: number,
  before?: number,
): SearchMemoryResult[] {
  return searchMemory(db, {
    scope: input.scope,
    query: input.query,
    project: input.project,
    type: input.type,
    file: input.file,
    after,
    before,
    fromEpoch: input.fromEpoch,
    toEpoch: input.toEpoch,
    limit: 200,
  });
}

function renderSession(
  db: Database,
  session: NonNullable<ReturnType<typeof getSession>>,
  depth: "collapsed" | "expanded" | "full",
  turnSelector?: Set<number>,
): string {
  const view = buildSessionView(db, session);
  const lines = [
    depth === "collapsed"
      ? formatSessionCollapsed(view)
      : formatSessionExpanded(view),
  ];

  if (depth === "collapsed") {
    return lines.join("\n");
  }

  const turns = getTurnsForSession(db, session.id).filter((turn) =>
    turnSelector ? turnSelector.has(turn.promptNumber) : true,
  );

  const sampledTurns = sampleWithOmissions(turns, (turn) =>
    turn.status === "pending" || turn.status === "stale",
  );

  for (const item of sampledTurns.items) {
    if ("omittedCount" in item) {
      lines.push(`  - ... ${item.omittedCount} omitted ...`);
      continue;
    }

    const turnView = buildTurnView(db, item);
    const turnLines = formatTurnExpanded(turnView, { sessionId: session.id });
    lines.push(turnLines);

    const observations = turnView.observations ?? [];
    if (depth === "expanded" || depth === "full") {
      const observationSample = sampleWithOmissions(observations);
      for (const observationItem of observationSample.items) {
        if ("omittedCount" in observationItem) {
          lines.push(`    - ... ${observationItem.omittedCount} omitted ...`);
          continue;
        }

        lines.push(
          depth === "full"
            ? formatObservationExpanded(observationItem, {
                indent: "    ",
                sessionId: session.id,
                turnPromptNumber: turnView.promptNumber,
              })
            : formatObservationCollapsed(observationItem, {
                indent: "    ",
                sessionId: session.id,
                turnPromptNumber: turnView.promptNumber,
              }),
        );
      }
    }
  }

  return lines.join("\n");
}

function renderTurnScope(
  db: Database,
  turns: TurnRecord[],
  depth: "collapsed" | "expanded" | "full",
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
    const view = buildSessionView(db, session);
    lines.push(formatSessionCollapsed(view));

    const sessionTurns = grouped.get(session.id) ?? [];
    const sampledTurns = sampleWithOmissions(sessionTurns, (turn) =>
      turn.status === "pending" || turn.status === "stale",
    );

    for (const item of sampledTurns.items) {
      if ("omittedCount" in item) {
        lines.push(`  - ... ${item.omittedCount} omitted ...`);
        continue;
      }

      const turnView = buildTurnView(db, item);
      lines.push(
        depth === "collapsed"
          ? formatTurnCollapsed(turnView, { sessionId: session.id })
          : formatTurnExpanded(turnView, { sessionId: session.id }),
      );

      if (depth !== "collapsed") {
        const observationSample = sampleWithOmissions(turnView.observations ?? []);
        for (const observationItem of observationSample.items) {
          if ("omittedCount" in observationItem) {
            lines.push(`    - ... ${observationItem.omittedCount} omitted ...`);
            continue;
          }

          lines.push(
            depth === "full"
              ? formatObservationExpanded(observationItem, {
                  indent: "    ",
                  sessionId: session.id,
                  turnPromptNumber: turnView.promptNumber,
                })
              : formatObservationCollapsed(observationItem, {
                  indent: "    ",
                  sessionId: session.id,
                  turnPromptNumber: turnView.promptNumber,
                }),
          );
        }
      }
    }
  }

  return lines.join("\n");
}

function renderObservationScope(
  db: Database,
  observations: Array<{ sessionId: number; turnId: number; observationId: number }>,
  depth: "collapsed" | "expanded" | "full",
  includeParents: boolean,
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
    const sampledObservations = sampleWithOmissions(observations);
    for (const entry of sampledObservations.items) {
      if ("omittedCount" in entry) {
        lines.push(`- ... ${entry.omittedCount} omitted ...`);
        continue;
      }

      const row = entry;
      const observation = getObservation(db, row.observationId);
      if (!observation) {
        continue;
      }

      const observationView: FormattedObservation = {
        id: observation.id,
        type: observation.type,
        title: observation.title,
        description: observation.description,
        narrative: observation.narrative,
        facts: observation.facts,
        concepts: observation.concepts,
        filesRead: observation.filesRead,
        filesModified: observation.filesModified,
      };

      lines.push(
        depth === "collapsed"
          ? formatObservationCollapsed(observationView)
          : formatObservationExpanded(observationView),
      );
    }

    return lines.join("\n");
  }

  const sessions = getRecentSessions(db, { limit: 1000 }).filter((session) =>
    grouped.has(session.id),
  );

  for (const session of sessions) {
    const sessionView = buildSessionView(db, session);
    lines.push(formatSessionCollapsed(sessionView));
    const turnMap = grouped.get(session.id) ?? new Map<number, number[]>();
    const turns = getTurnsForSession(db, session.id).filter((turn) =>
      turnMap.has(turn.id),
    );

    for (const turn of turns) {
      const turnView = buildTurnView(db, turn);
      lines.push(
        depth === "collapsed"
          ? formatTurnCollapsed(turnView, { sessionId: session.id })
          : formatTurnExpanded(turnView, { sessionId: session.id }),
      );

      const observationIds = turnMap.get(turn.id) ?? [];
      const sampledObservations = sampleWithOmissions(observationIds);
      for (const observationEntry of sampledObservations.items) {
        if (
          typeof observationEntry === "object" &&
          observationEntry !== null &&
          "omittedCount" in observationEntry
        ) {
          lines.push(`    - ... ${observationEntry.omittedCount} omitted ...`);
          continue;
        }

        const observationId = observationEntry;
        const observation = getObservation(db, observationId);
        if (!observation) {
          continue;
        }

        const observationView: FormattedObservation = {
          id: observation.id,
          type: observation.type,
          title: observation.title,
          description: observation.description,
          narrative: observation.narrative,
          facts: observation.facts,
          concepts: observation.concepts,
          filesRead: observation.filesRead,
          filesModified: observation.filesModified,
        };

        lines.push(
          depth === "full"
            ? formatObservationExpanded(observationView, {
                indent: "    ",
                sessionId: session.id,
                turnPromptNumber: turn.promptNumber,
              })
            : formatObservationCollapsed(observationView, {
                indent: "    ",
                sessionId: session.id,
                turnPromptNumber: turn.promptNumber,
              }),
        );
      }
    }
  }

  return lines.join("\n");
}

function legacyRecallMemory(db: Database, input: RecallInput): string {
  if (input.observation !== undefined) {
    const observation = getObservation(db, input.observation);
    if (!observation) {
      return "Observation not found.";
    }

    return formatObservationExpanded({
      id: observation.id,
      type: observation.type,
      title: observation.title,
      description: observation.description,
      narrative: observation.narrative,
      facts: observation.facts,
      concepts: observation.concepts,
      filesRead: observation.filesRead,
      filesModified: observation.filesModified,
    });
  }

  if (input.session !== undefined && input.turn !== undefined) {
    const sessionId = typeof input.session === "number" ? input.session : null;
    if (sessionId === null) {
      return formatParameterError("turn requires session; use recall(session=142, turn=3).");
    }

    const turn = getTurn(db, sessionId, input.turn as number);
    if (!turn) {
      return "Turn not found.";
    }

    const turnView = buildTurnView(db, turn);
    return [
      formatTurnExpanded(turnView, { sessionId }),
      ...turnView.observations!.map((observation) =>
        formatObservationCollapsed(observation, {
          indent: "  ",
          sessionId,
          turnPromptNumber: turn.promptNumber,
        }),
      ),
    ].join("\n");
  }

  if (input.session !== undefined) {
    const sessionId = typeof input.session === "number" ? input.session : null;
    if (sessionId === null) {
      return formatParameterError("session selector requires a numeric id in legacy mode.");
    }

    const session = getSession(db, sessionId);
    if (!session) {
      return "Session not found.";
    }

    return renderSession(db, session, input.depth ?? "collapsed");
  }

  if (input.around) {
    const sessions = getRecentSessions(db, { limit: 1000 }).sort(
      (left, right) => left.startedAtEpoch - right.startedAtEpoch,
    );

    if (sessions.length === 0) {
      return "Anchor session not found.";
    }

    const anchorId = Number(input.around.replace(/^S/i, ""));
    let anchorIndex = /^S\d+$/i.test(input.around)
      ? sessions.findIndex((session) => session.id === anchorId)
      : -1;

    if (anchorIndex === -1) {
      const dateEpoch = parseUtcDate(input.around);
      if (dateEpoch !== null) {
        anchorIndex = sessions.findIndex(
          (session) => session.startedAtEpoch >= dateEpoch,
        );
        if (anchorIndex === -1) {
          anchorIndex = sessions.length - 1;
        }
      }
    }

    if (anchorIndex === -1) {
      return "Anchor session not found.";
    }

    const startIndex = Math.max(0, anchorIndex - (input.before ?? 0));
    const endIndex = Math.min(sessions.length, anchorIndex + (input.after ?? 0) + 1);

    return sessions
      .slice(startIndex, endIndex)
      .map((session) => renderSession(db, session, "collapsed"))
      .join("\n");
  }

  const results = getRecentSessions(db, { limit: 20 });
  return results.map((session) => renderSession(db, session, "collapsed")).join("\n");
}

function shouldUseLegacyPath(input: RecallInput): boolean {
  return input.scope === undefined;
}

export function recallMemory(db: Database, input: RecallInput): string {
  const normalizedInput = normalizeRecallInput(input);

  if (shouldUseLegacyPath(normalizedInput)) {
    return legacyRecallMemory(db, normalizedInput);
  }

  const depth = normalizedInput.depth ?? "collapsed";
  const timeRange = mergeTimeRanges(normalizedInput);
  if (timeRange.error) {
    return formatParameterError(timeRange.error);
  }

  if (normalizedInput.query || normalizedInput.type || normalizedInput.file) {
    const results = selectSearchResults(
      db,
      { ...normalizedInput, scope: normalizedInput.scope! },
      timeRange.after,
      timeRange.before,
    );
    return renderSearchResults(
      db,
      normalizedInput as RecallInput & { scope: RecallScope },
      results,
      depth,
    );
  }

  return renderScopedMemory(
    db,
    normalizedInput as RecallInput & { scope: RecallScope },
    depth,
    timeRange.after,
    timeRange.before,
  );
}

function renderSearchResults(
  db: Database,
  input: RecallInput & { scope: RecallScope },
  results: SearchMemoryResult[],
  depth: "collapsed" | "expanded" | "full",
): string {
  if (input.scope === "sessions") {
    const sessions = results
      .map((result) => getSession(db, result.sessionId))
      .filter(
        (session): session is NonNullable<ReturnType<typeof getSession>> =>
          session !== null,
      );
    return sessions.map((session) => renderSession(db, session, depth)).join("\n");
  }

  if (input.scope === "turns") {
    const turns = results
      .map((result) => getTurnById(db, result.turnId ?? -1))
      .filter((turn): turn is TurnRecord => turn !== null);
    return renderTurnScope(db, turns, depth);
  }

  const observations = results
    .filter((result) => result.observationId !== null)
    .map((result) => ({
      sessionId: result.sessionId,
      turnId: result.turnId!,
      observationId: result.observationId!,
    }));
  const includeParents = Boolean(input.session !== undefined || input.turn !== undefined);
  return renderObservationScope(db, observations, depth, includeParents);
}

function renderScopedMemory(
  db: Database,
  input: Required<Pick<RecallInput, "scope">> & RecallInput,
  depth: "collapsed" | "expanded" | "full",
  after?: number,
  before?: number,
): string {
  const sessionSelector = parseSelectorValue(input.session, "session");
  const turnSelector = parseSelectorValue(input.turn, "turn");
  const observationSelector = parseSelectorValue(
    input.obs ?? input.observation,
    "observation",
  );

  if (sessionSelector.error) {
    return formatParameterError(sessionSelector.error);
  }

  if (turnSelector.error) {
    return formatParameterError(turnSelector.error);
  }

  if (observationSelector.error) {
    return formatParameterError(observationSelector.error);
  }

  const sessionIds = sessionSelector.values;
  const turnNumbers = turnSelector.values;
  const observationIds = observationSelector.values;

  if (input.scope === "turns" && turnNumbers.length > 0 && sessionIds.length === 0) {
    return formatParameterError(
      'turn requires session; use recall(scope="turns", session=142, turn=3).',
    );
  }

  if (sessionIds.length > 0 && turnNumbers.length > 0) {
    for (const sessionId of sessionIds) {
      const turns = getTurnsForSession(db, sessionId);
      const promptNumbers = new Set(turns.map((turn) => turn.promptNumber));
      for (const promptNumber of turnNumbers) {
        if (!promptNumbers.has(promptNumber)) {
          return formatParameterError(
            `turn ${promptNumber} does not belong to session ${sessionId}.`,
          );
        }
      }
    }
  }

  if (sessionIds.length > 0 && observationIds.length > 0) {
    const sessionSet = new Set(sessionIds);
    for (const observationId of observationIds) {
      const observation = getObservation(db, observationId);
      if (!observation) {
        continue;
      }
      const turn = getTurnById(db, observation.turnId);
      if (!turn || !sessionSet.has(turn.sessionId)) {
        return formatParameterError(
          `observation ${observationId} does not belong to session ${sessionIds.join(", ")}.`,
        );
      }
    }
  }

  if (sessionIds.length > 0 && turnNumbers.length > 0 && observationIds.length > 0) {
    const turnSet = new Set(turnNumbers);
    for (const observationId of observationIds) {
      const observation = getObservation(db, observationId);
      if (!observation) {
        continue;
      }
      const turn = getTurnById(db, observation.turnId);
      if (!turn || !turnSet.has(turn.promptNumber)) {
        return formatParameterError(
          `observation ${observationId} does not belong to turn ${turnNumbers.join(", ")}.`,
        );
      }
    }
  }

  if (input.scope === "sessions") {
    const candidateSessions = sessionIds.length > 0
      ? sessionIds
          .map((sessionId) => getSession(db, sessionId))
          .filter(
            (session): session is NonNullable<ReturnType<typeof getSession>> =>
              session !== null,
          )
      : getRecentSessions(db, { limit: 1000 });

    const observationSessionIds = new Set<number>();
    if (observationIds.length > 0) {
      for (const observationId of observationIds) {
        const observation = getObservation(db, observationId);
        if (!observation) {
          continue;
        }
        const turn = getTurnById(db, observation.turnId);
        if (turn) {
          observationSessionIds.add(turn.sessionId);
        }
      }
    }

    const filtered = candidateSessions.filter((session) => {
      if (after !== undefined && session.startedAtEpoch < after) {
        return false;
      }
      if (before !== undefined && session.startedAtEpoch > before) {
        return false;
      }
      if (
        turnNumbers.length > 0 &&
        !getTurnsForSession(db, session.id).some((turn) =>
          turnNumbers.includes(turn.promptNumber),
        )
      ) {
        return false;
      }
      if (observationIds.length > 0 && !observationSessionIds.has(session.id)) {
        return false;
      }
      return true;
    });

    const turnSelector = turnNumbers.length > 0 ? new Set(turnNumbers) : undefined;
    return filtered
      .map((session) => renderSession(db, session, depth, turnSelector))
      .join("\n");
  }

  if (input.scope === "turns") {
    if (input.turn !== undefined && sessionIds.length === 0) {
      return formatParameterError("turn requires session; use recall(scope=\"turns\", session=142, turn=3).");
    }

    const sessions = sessionIds.length > 0
      ? sessionIds
          .map((sessionId) => getSession(db, sessionId))
          .filter(
            (session): session is NonNullable<ReturnType<typeof getSession>> =>
              session !== null,
          )
      : getRecentSessions(db, { limit: 1000 });

    const turns: TurnRecord[] = [];
    for (const session of sessions) {
      turns.push(
        ...getTurnsForSession(db, session.id).filter((turn) => {
          if (turnNumbers.length > 0 && !turnNumbers.includes(turn.promptNumber)) {
            return false;
          }
          if (after !== undefined && turn.createdAtEpoch < after) {
            return false;
          }
          if (before !== undefined && turn.createdAtEpoch > before) {
            return false;
          }
          return true;
        }),
      );
    }

    if (observationIds.length > 0) {
      const observationTurnIds = new Set<number>();
      for (const observationId of observationIds) {
        const observation = getObservation(db, observationId);
        if (!observation) {
          continue;
        }
        observationTurnIds.add(observation.turnId);
      }
      return renderTurnScope(db, turns.filter((turn) => observationTurnIds.has(turn.id)), depth);
    }

    return renderTurnScope(db, turns, depth);
  }

  if (observationIds.length > 0) {
    const observations = observationIds
      .map((observationId) => getObservation(db, observationId))
      .filter(
        (observation): observation is NonNullable<ReturnType<typeof getObservation>> =>
          observation !== null,
      )
      .map((observation) => ({
        sessionId: getTurnById(db, observation.turnId)?.sessionId ?? 0,
        turnId: observation.turnId,
        observationId: observation.id,
      }));
    return renderObservationScope(
      db,
      observations,
      depth,
      sessionIds.length > 0 || turnNumbers.length > 0,
    );
  }

  const sessions = sessionIds.length > 0
    ? sessionIds
        .map((sessionId) => getSession(db, sessionId))
        .filter(
          (session): session is NonNullable<ReturnType<typeof getSession>> =>
            session !== null,
        )
    : getRecentSessions(db, { limit: 1000 });
  const turnIds = new Set<number>();
  const observations: Array<{ sessionId: number; turnId: number; observationId: number }> = [];

  for (const session of sessions) {
    for (const turn of getTurnsForSession(db, session.id)) {
      if (turnNumbers.length > 0 && !turnNumbers.includes(turn.promptNumber)) {
        continue;
      }
      if (after !== undefined && turn.createdAtEpoch < after) {
        continue;
      }
      if (before !== undefined && turn.createdAtEpoch > before) {
        continue;
      }
      turnIds.add(turn.id);
      for (const observation of getObservationsForTurn(db, turn.id)) {
        observations.push({
          sessionId: session.id,
          turnId: turn.id,
          observationId: observation.id,
        });
      }
    }
  }

  const turnRecords = [...turnIds]
    .map((turnId) => getTurnById(db, turnId))
    .filter((turn): turn is TurnRecord => turn !== null);

  if (input.scope === "observations") {
    return renderObservationScope(
      db,
      observations,
      depth,
      sessionIds.length > 0 || turnNumbers.length > 0,
    );
  }

  return renderTurnScope(db, turnRecords, depth);
}
