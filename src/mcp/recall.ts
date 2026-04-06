import type { Database } from "bun:sqlite";

import { getObservation, getObservationsForTurn } from "../db/observations";
import { searchMemory } from "../db/search";
import { getRecentSessions, getSession } from "../db/sessions";
import { getTurnById, getTurnsForSession } from "../db/turns";
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

function buildFormattedSession(
  db: Database,
  sessionId: number,
  expandTurns: number[] = [],
): FormattedSession | null {
  const session = getSession(db, sessionId);

  if (!session) {
    return null;
  }

  const turns = getTurnsForSession(db, session.id).map((turn) => {
    const observations = getObservationsForTurn(db, turn.id);
    const shouldExpand = expandTurns.includes(turn.promptNumber);

    const formattedTurn: FormattedTurn = {
      id: turn.id,
      promptNumber: turn.promptNumber,
      title: turn.title,
      observationCount: observations.length,
    };

    if (shouldExpand) {
      formattedTurn.promptPreview = turn.userPrompt;
      formattedTurn.responsePreview = turn.assistantResponse;
      formattedTurn.description = turn.description;
      formattedTurn.insight = splitInsight(turn.insight);
      formattedTurn.filesRead = turn.filesRead;
      formattedTurn.filesModified = turn.filesModified;
      formattedTurn.observations = observations.map<FormattedObservation>(
        (observation) => ({
          id: observation.id,
          type: observation.type,
          title: observation.title,
          description: observation.description,
        }),
      );
    }

    return formattedTurn;
  });

  return {
    id: session.id,
    title: session.title,
    project: session.project,
    startedAtEpoch: session.startedAtEpoch,
    description: session.description,
    insight: splitInsight(session.insight),
    turns,
  };
}

function formatSearchResults(db: Database, input: RecallInput): string {
  const results = searchMemory(db, input);

  return results
    .map((result) => {
      if (result.layer === "session") {
        return formatSessionCollapsed({
          id: result.sessionId,
          title: result.title,
          project: result.project,
          startedAtEpoch: result.timestampEpoch,
        });
      }

      if (result.layer === "turn" && result.turnId !== null) {
        const turn = getTurnById(db, result.turnId);

        if (!turn) {
          return null;
        }

        return formatTurnCollapsed({
          id: turn.id,
          promptNumber: turn.promptNumber,
          title: turn.title,
          observationCount: getObservationsForTurn(db, turn.id).length,
        });
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

function formatTurnObservations(db: Database, turnId: number): string {
  const turn = getTurnById(db, turnId);

  if (!turn) {
    return "Turn not found.";
  }

  const lines = [
    formatTurnExpanded({
      id: turn.id,
      promptNumber: turn.promptNumber,
      title: turn.title,
      observationCount: getObservationsForTurn(db, turn.id).length,
      promptPreview: turn.userPrompt,
      responsePreview: turn.assistantResponse,
      description: turn.description,
      insight: splitInsight(turn.insight),
      filesRead: turn.filesRead,
      filesModified: turn.filesModified,
    }),
  ];

  for (const observation of getObservationsForTurn(db, turn.id)) {
    lines.push(
      formatObservationCollapsed({
        id: observation.id,
        type: observation.type,
        title: observation.title,
        description: observation.description,
      }),
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
  const anchorId = Number(anchor.replace(/^S/i, ""));
  const sessions = getRecentSessions(db, { limit: 1_000 }).sort(
    (left, right) => left.startedAtEpoch - right.startedAtEpoch,
  );
  const anchorIndex = sessions.findIndex((session) => session.id === anchorId);

  if (anchorIndex === -1) {
    return "Anchor session not found.";
  }

  const startIndex = Math.max(0, anchorIndex - before);
  const endIndex = Math.min(sessions.length, anchorIndex + after + 1);

  return sessions
    .slice(startIndex, endIndex)
    .map((session) =>
      formatSessionCollapsed({
        id: session.id,
        title: session.title,
        project: session.project,
        startedAtEpoch: session.startedAtEpoch,
      }),
    )
    .join("\n");
}

export function recallMemory(db: Database, input: RecallInput): string {
  if (input.observation !== undefined) {
    return formatObservationDetail(db, input.observation);
  }

  if (input.turn !== undefined) {
    return formatTurnObservations(db, input.turn);
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
    .map((session) =>
      formatSessionCollapsed({
        id: session.id,
        title: session.title,
        project: session.project,
        startedAtEpoch: session.startedAtEpoch,
      }),
    )
    .join("\n");
}
