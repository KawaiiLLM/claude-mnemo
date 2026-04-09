import type { Database } from "bun:sqlite";

import { getSession } from "../db/sessions";
import { getObservationsForTurn } from "../db/observations";
import { getTurnsForSession, type TurnRecord } from "../db/turns";
import { buildSessionSummary, buildTurnView } from "../mcp/recall";
import {
  formatObservationCollapsed,
  formatSessionExpanded,
  formatTurnCollapsed,
  formatTurnExpanded,
  type FormattedTurn,
} from "../mcp/format";

export function isActionableStatus(status: string | null | undefined): boolean {
  return (
    status === "pending" ||
    status === "stale" ||
    status === "extracting_pending" ||
    status === "extracting_stale"
  );
}

function buildCollapsedTurnView(
  turn: TurnRecord,
  observationCount: number,
): FormattedTurn {
  return {
    id: turn.id,
    promptNumber: turn.promptNumber,
    title: turn.title,
    content: turn.content,
    observationCount,
    toolCallCount: turn.toolCallCount,
    filesReadCount: turn.filesRead.length,
    filesModifiedCount: turn.filesModified.length,
    status: turn.status,
  };
}

export function buildExtractionContext(db: Database, sessionId: number): string {
  const sessionSummary = buildSessionSummary(db, sessionId);

  if (!sessionSummary) {
    return "";
  }

  const session = getSession(db, sessionId);
  const anchor = session?.lastCompactTurn ?? 0;
  const turns = getTurnsForSession(db, sessionId).filter(
    (turn) => turn.promptNumber > anchor || isActionableStatus(turn.status),
  );

  const lines = [formatSessionExpanded(sessionSummary)];

  for (const turn of turns) {
    if (isActionableStatus(turn.status)) {
      const view = buildTurnView(db, turn);
      lines.push(formatTurnExpanded(view, { sessionId }));

      for (const observation of view.observations ?? []) {
        lines.push(
          formatObservationCollapsed(observation, {
            indent: "    ",
            sessionId,
            turnPromptNumber: turn.promptNumber,
          }),
        );
      }

      continue;
    }

    lines.push(
      formatTurnCollapsed(
        buildCollapsedTurnView(turn, getObservationsForTurn(db, turn.id).length),
        { sessionId },
      ),
    );
  }

  return lines.join("\n");
}
