import { existsSync } from "node:fs";

import type { Database } from "bun:sqlite";

import { getSession } from "../db/sessions";
import { getObservationsForTurn } from "../db/observations";
import { getTurnsForSession, type TurnRecord } from "../db/turns";
import { buildSessionSummary } from "../mcp/recall";
import {
  renderNode,
  type FormattedToolCall,
  type FormattedTurn,
} from "../mcp/format";
import { parseReplayTranscript, type ParsedReplayTurn } from "../shared/transcript-parser";
import { resolveTranscriptPath } from "../shared/paths";

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
    promptPreview: turn.userPrompt,
  };
}

function buildToolCalls(turn: ParsedReplayTurn | undefined): FormattedToolCall[] {
  if (!turn) {
    return [];
  }

  return turn.toolCalls.map((toolCall) => ({
    name: toolCall.name,
    input: toolCall.input,
    result: toolCall.result,
  }));
}

function buildActionableTurnView(
  turn: TurnRecord,
  transcriptTurn: ParsedReplayTurn | undefined,
): FormattedTurn {
  return {
    id: turn.id,
    promptNumber: turn.promptNumber,
    title: turn.title,
    content: turn.content,
    observationCount: 0,
    toolCallCount: transcriptTurn?.toolCalls.length ?? turn.toolCallCount ?? 0,
    filesReadCount: turn.filesRead.length,
    filesModifiedCount: turn.filesModified.length,
    status: turn.status,
    promptPreview: turn.userPrompt,
    responsePreview: turn.assistantResponse,
    insight: turn.insight
      ? turn.insight
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => line.replace(/^-+\s*/, ""))
      : [],
    filesRead: turn.filesRead,
    filesModified: turn.filesModified,
    toolCalls: buildToolCalls(transcriptTurn),
  };
}

function resolveReplayTurns(
  session: NonNullable<ReturnType<typeof getSession>>,
): ParsedReplayTurn[] {
  const transcriptPath = resolveTranscriptPath(
    session.project,
    session.contentSessionId,
  );

  if (!existsSync(transcriptPath)) {
    return [];
  }

  return parseReplayTranscript(transcriptPath);
}

export function buildExtractionContextFromReplayTurns(
  db: Database,
  sessionId: number,
  replayTurns: ParsedReplayTurn[],
): string {
  const sessionSummary = buildSessionSummary(db, sessionId);

  if (!sessionSummary) {
    return "";
  }

  const session = getSession(db, sessionId);
  if (!session) {
    return "";
  }

  const replayByPromptId = new Map(
    replayTurns
      .filter((turn) => turn.promptId)
      .map((turn) => [turn.promptId as string, turn]),
  );
  const replayByPromptNumber = new Map(
    replayTurns.map((turn) => [turn.promptNumber, turn]),
  );

  const anchor = session.lastCompactTurn ?? 0;
  const turns = getTurnsForSession(db, sessionId).filter(
    (turn) => turn.promptNumber > anchor || isActionableStatus(turn.status),
  );

  const lines: string[] = [];

  for (const turn of turns) {
    if (isActionableStatus(turn.status)) {
      const transcriptTurn =
        (turn.contentPromptId
          ? replayByPromptId.get(turn.contentPromptId)
          : undefined) ?? replayByPromptNumber.get(turn.promptNumber);
      lines.push(
        renderNode(
          {
            type: "turn",
            value: buildActionableTurnView(turn, transcriptTurn),
          },
          {
            depth: "expanded",
            mode: "unified",
            sessionId,
          },
        ),
      );
      continue;
    }

    lines.push(
      renderNode(
        {
          type: "turn",
          value: buildCollapsedTurnView(
            turn,
            getObservationsForTurn(db, turn.id).length,
          ),
        },
        {
          depth: "collapsed",
          mode: "unified",
          sessionId,
        },
      ),
    );
  }

  lines.push(
    renderNode(
      { type: "session", value: sessionSummary },
      { depth: "expanded", mode: "unified" },
    ),
  );

  return lines.join("\n");
}

export function buildExtractionContext(db: Database, sessionId: number): string {
  const session = getSession(db, sessionId);

  if (!session) {
    return "";
  }

  return buildExtractionContextFromReplayTurns(
    db,
    sessionId,
    resolveReplayTurns(session),
  );
}
