import type { Database } from "bun:sqlite";

import { getObservation, getObservationsForTurn } from "../db/observations";
import { searchMemory } from "../db/search";
import { getRecentSessions, getSession } from "../db/sessions";
import { getTurn, getTurnById, getTurnsForSession, type TurnRecord } from "../db/turns";
import {
  formatObservationCollapsed,
  formatObservationExpanded,
  formatSessionCollapsed,
  formatSessionExpanded,
  formatTree,
  formatTurnCollapsed,
  formatTurnExpanded,
  type FormattedObservation,
  type FormattedSession,
  type FormattedTurn,
} from "./format";

export interface RecallInput {
  query?: string;
  session?: number;
  turn?: number;
  observation?: number;
  expandTurns?: number[];
  around?: string;
  before?: number;
  after?: number;
  file?: string;
  type?: string;
  project?: string;
  fromEpoch?: number;
  toEpoch?: number;
}

function validateRecallInput(input: RecallInput): string | null {
  if (input.observation !== undefined) {
    const hasOtherSelector =
      input.session !== undefined ||
      input.turn !== undefined ||
      (input.expandTurns?.length ?? 0) > 0 ||
      input.query !== undefined ||
      input.around !== undefined ||
      input.before !== undefined ||
      input.after !== undefined ||
      input.file !== undefined ||
      input.type !== undefined ||
      input.project !== undefined ||
      input.fromEpoch !== undefined ||
      input.toEpoch !== undefined;

    if (hasOtherSelector) {
      return "Parameter error: observation cannot be combined with other selectors.";
    }
  }

  if (input.turn !== undefined && input.session === undefined) {
    return "Parameter error: turn requires session; use recall(session=142, turn=3).";
  }

  if ((input.expandTurns?.length ?? 0) > 0 && input.session === undefined) {
    return "Parameter error: expand_turns requires session; use recall(session=142, expand_turns=[1]).";
  }

  return null;
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

function buildFormattedTurn(
  db: Database,
  turn: TurnRecord,
  expand = false,
): FormattedTurn {
  const observations = getObservationsForTurn(db, turn.id);
  const formattedTurn: FormattedTurn = {
    id: turn.id,
    promptNumber: turn.promptNumber,
    title: turn.title,
    description: turn.description,
    observationCount: observations.length,
    toolCallCount: turn.toolCallCount,
    filesReadCount: turn.filesRead.length,
    filesModifiedCount: turn.filesModified.length,
  };

  if (expand) {
    formattedTurn.promptPreview = turn.userPrompt;
    formattedTurn.responsePreview = turn.assistantResponse;
    formattedTurn.insight = splitInsight(turn.insight);
    formattedTurn.filesRead = turn.filesRead;
    formattedTurn.filesModified = turn.filesModified;
    formattedTurn.observations = observations.map<FormattedObservation>(
      (observation) => ({
        id: observation.id,
        type: observation.type,
        title: observation.title,
        description: observation.description,
        narrative: observation.narrative,
        facts: observation.facts,
        concepts: observation.concepts,
        filesRead: observation.filesRead,
        filesModified: observation.filesModified,
      }),
    );
  }

  return formattedTurn;
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

  const turns = getTurnsForSession(db, session.id).map((turn) => {
    return buildFormattedTurn(db, turn, expandTurns.includes(turn.promptNumber));
  });

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

function formatSearchResults(db: Database, input: RecallInput): string {
  const results = searchMemory(db, input);

  return results
    .map((result) => {
      if (result.layer === "session") {
        const session = getSession(db, result.sessionId);

        if (!session) {
          return null;
        }

        const turns = getTurnsForSession(db, session.id);

        return formatSessionCollapsed({
          id: session.id,
          title: session.title,
          project: session.project,
          startedAtEpoch: session.startedAtEpoch,
          description: session.description,
          insight: splitInsight(session.insight),
          nextSteps: session.nextSteps,
          turnCount: turns.length,
          observationCount: turns.reduce(
            (sum, turn) => sum + getObservationsForTurn(db, turn.id).length,
            0,
          ),
        });
      }

      if (result.layer === "turn" && result.turnId !== null) {
        const turn = getTurnById(db, result.turnId);

        if (!turn) {
          return null;
        }

        return formatTurnCollapsed({
          ...buildFormattedTurn(db, turn),
        }, { indent: "", sessionId: result.sessionId });
      }

      if (result.layer === "observation" && result.observationId !== null) {
        const observation = getObservation(db, result.observationId);

        if (!observation) {
          return null;
        }

        return formatObservationCollapsed({
          id: observation.id,
          type: observation.type,
          title: observation.title,
          description: observation.description,
        });
      }

      return null;
    })
    .filter((line): line is string => line !== null)
    .join("\n");
}

function formatTurnObservations(
  db: Database,
  sessionId: number,
  promptNumber: number,
): string {
  const turn = getTurn(db, sessionId, promptNumber);

  if (!turn) {
    return "Turn not found.";
  }

  const lines = [
    formatTurnExpanded(
      {
        ...buildFormattedTurn(db, turn, true),
        promptPreview: turn.userPrompt,
        responsePreview: turn.assistantResponse,
      },
      { indent: "" },
    ),
  ];

  for (const observation of getObservationsForTurn(db, turn.id)) {
    lines.push(
      formatObservationCollapsed({
        id: observation.id,
        type: observation.type,
        title: observation.title,
        description: observation.description,
      }, { indent: "  " }),
    );
  }

  return lines.join("\n");
}

function formatObservationDetail(db: Database, observationId: number): string {
  const observation = getObservation(db, observationId);

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

function formatTimeline(db: Database, anchor: string, before = 0, after = 0): string {
  const sessions = getRecentSessions(db, { limit: 1_000 }).sort(
    (left, right) => left.startedAtEpoch - right.startedAtEpoch,
  );

  if (sessions.length === 0) {
    return "Anchor session not found.";
  }

  const anchorId = Number(anchor.replace(/^S/i, ""));
  let anchorIndex = /^S\d+$/i.test(anchor)
    ? sessions.findIndex((session) => session.id === anchorId)
    : -1;

  if (anchorIndex === -1) {
    const dateMatch = anchor.match(/^(\d{4})-(\d{2})-(\d{2})$/);

    if (dateMatch) {
      const [, year, month, day] = dateMatch;
      const anchorEpoch = Math.floor(
        Date.UTC(Number(year), Number(month) - 1, Number(day)) / 1000,
      );

      if (!Number.isNaN(anchorEpoch)) {
        anchorIndex = sessions.findIndex(
          (session) => session.startedAtEpoch >= anchorEpoch,
        );

        if (anchorIndex === -1) {
          anchorIndex = sessions.length - 1;
        }
      }
    }
  }

  if (anchorIndex === -1) {
    return "Anchor session not found.";
  }

  const startIndex = Math.max(0, anchorIndex - before);
  const endIndex = Math.min(sessions.length, anchorIndex + after + 1);

  return sessions
    .slice(startIndex, endIndex)
    .map((session) => {
      const turns = getTurnsForSession(db, session.id);

      return formatSessionCollapsed({
        id: session.id,
        title: session.title,
        project: session.project,
        startedAtEpoch: session.startedAtEpoch,
        description: session.description,
        insight: splitInsight(session.insight),
        nextSteps: session.nextSteps,
        turnCount: turns.length,
        observationCount: turns.reduce(
          (sum, turn) => sum + getObservationsForTurn(db, turn.id).length,
          0,
        ),
      });
    })
    .join("\n");
}

export function recallMemory(db: Database, input: RecallInput): string {
  const validationError = validateRecallInput(input);

  if (validationError) {
    return validationError;
  }

  if (input.observation !== undefined) {
    return formatObservationDetail(db, input.observation);
  }

  if (input.session !== undefined && input.turn !== undefined) {
    return formatTurnObservations(db, input.session, input.turn);
  }

  if (input.session !== undefined) {
    const formattedSession = buildFormattedSession(
      db,
      input.session,
      input.expandTurns ?? [],
    );

    if (!formattedSession) {
      return "Session not found.";
    }

    if ((input.expandTurns?.length ?? 0) > 0) {
      return formatTree([formattedSession]);
    }

    return [
      formatSessionExpanded(formattedSession),
      ...formattedSession.turns!.map((turn) => formatTurnCollapsed(turn)),
    ].join("\n");
  }

  if (input.around) {
    return formatTimeline(db, input.around, input.before, input.after);
  }

  if (
    input.query ||
    input.file ||
    input.type ||
    input.project ||
    input.fromEpoch !== undefined ||
    input.toEpoch !== undefined
  ) {
    return formatSearchResults(db, input);
  }

  return getRecentSessions(db)
    .map((session) => buildFormattedSession(db, session.id))
    .filter((session): session is FormattedSession => session !== null)
    .map((session) => formatSessionCollapsed(session))
    .join("\n");
}
