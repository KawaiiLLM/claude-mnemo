import { dirname, basename } from "node:path";
import { existsSync } from "node:fs";

import type { Database } from "bun:sqlite";

import { getSession } from "../db/sessions";
import { getTurn, getTurnsForSession, type TurnRecord } from "../db/turns";
import {
  renderNode,
  type FormattedSession,
  type FormattedToolCall,
  type FormattedTurn,
  type RenderDepth,
} from "./format";
import { expandNumericSelector } from "./selectors";
import { parseReplayTranscript } from "../shared/transcript-parser";
import { resolveTranscriptPath } from "../shared/paths";

export interface ReplayInput {
  id?: string;
  depth?: RenderDepth;
  transcriptPath?: string;
}

type ReplayTranscriptTurn = ReturnType<typeof parseReplayTranscript>[number];

type RoutedReplayId =
  | { kind: "session"; sessionId: number }
  | { kind: "turns"; sessionId: number; promptNumbers?: number[] }
  | { kind: "tools"; sessionId: number; promptNumber: number; toolNumbers?: number[] };

function parseReplayId(id: string): RoutedReplayId | null {
  const trimmed = id.trim();

  const toolMatch = /^S(\d+)\/T(\d+)\/Tool(\*|\d+)$/i.exec(trimmed);
  if (toolMatch) {
    const toolNumbers = toolMatch[3] === "*" ? [] : [Number(toolMatch[3])];
    return {
      kind: "tools",
      sessionId: Number(toolMatch[1]),
      promptNumber: Number(toolMatch[2]),
      toolNumbers,
    };
  }

  const turnMatch = /^S(\d+)\/T(\*|\d+|\d+\.\.\d+)$/i.exec(trimmed);
  if (turnMatch) {
    const promptNumbers = expandNumericSelector(turnMatch[2]!);
    if (promptNumbers === null) {
      return null;
    }

    return {
      kind: "turns",
      sessionId: Number(turnMatch[1]),
      promptNumbers,
    };
  }

  const sessionMatch = /^S(\d+)$/i.exec(trimmed);
  if (sessionMatch) {
    return {
      kind: "session",
      sessionId: Number(sessionMatch[1]),
    };
  }

  return null;
}

function formatParameterError(message: string): string {
  return `Parameter error: ${message}`;
}

function resolveReplayTranscriptPath(
  db: Database,
  sessionId: number,
  transcriptPath?: string,
): string | null {
  if (transcriptPath) {
    return transcriptPath;
  }

  const session = getSession(db, sessionId);
  if (!session) {
    return null;
  }

  return resolveTranscriptPath(session.project, session.contentSessionId);
}

function buildToolCalls(turn: ReplayTranscriptTurn): FormattedToolCall[] {
  return turn.toolCalls.map((toolCall) => ({
    name: toolCall.name,
    input: toolCall.input,
    result: toolCall.result,
  }));
}

function buildReplaySessionView(
  sessionId: number,
  transcriptPath: string,
  transcriptTurns: ReplayTranscriptTurn[],
  db: Database,
): FormattedSession {
  const session = getSession(db, sessionId);

  if (session) {
    return {
      id: session.id,
      title: session.title,
      project: session.project,
      createdAtEpoch: session.createdAtEpoch,
      content: session.content,
      insight: [],
      nextSteps: session.nextSteps,
      turnCount: transcriptTurns.length,
    };
  }

  return {
    id: sessionId,
    title: "Untitled",
    project: dirname(dirname(transcriptPath)),
    createdAtEpoch: Math.floor(Date.now() / 1000),
    content: `Transcript: ${basename(transcriptPath)}`,
    turnCount: transcriptTurns.length,
  };
}

function buildReplayTurnView(
  promptNumber: number,
  transcriptTurn: ReplayTranscriptTurn,
  dbTurn: TurnRecord | null,
): FormattedTurn {
  return {
    id: dbTurn?.id ?? promptNumber,
    promptNumber,
    title: dbTurn?.title ?? null,
    createdAtEpoch: dbTurn?.createdAtEpoch ?? null,
    content: dbTurn?.content ?? null,
    observationCount: 0,
    toolCallCount: transcriptTurn.toolCalls.length,
    filesReadCount: dbTurn?.filesRead.length ?? 0,
    filesModifiedCount: dbTurn?.filesModified.length ?? 0,
    status: dbTurn?.status,
    promptPreview: transcriptTurn.userPrompt,
    responsePreview: transcriptTurn.assistantText,
    insight: dbTurn?.insight
      ? dbTurn.insight
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => line.replace(/^-+\s*/, ""))
      : [],
    filesRead: dbTurn?.filesRead ?? [],
    filesModified: dbTurn?.filesModified ?? [],
    toolCalls: buildToolCalls(transcriptTurn),
  };
}

function findReplayTurn(
  dbTurns: TurnRecord[],
  transcriptTurns: ReplayTranscriptTurn[],
  promptNumber: number,
): { transcriptTurn: ReplayTranscriptTurn; dbTurn: TurnRecord | null } | null {
  const dbTurn = dbTurns.find((turn) => turn.promptNumber === promptNumber) ?? null;
  const transcriptTurn =
    (dbTurn?.contentPromptId
      ? transcriptTurns.find((candidate) => candidate.promptId === dbTurn.contentPromptId)
      : undefined) ??
    transcriptTurns.find((candidate) => candidate.promptNumber === promptNumber) ??
    null;

  if (!transcriptTurn) {
    return null;
  }

  return { transcriptTurn, dbTurn };
}

function matchDbTurn(
  transcriptTurn: ReplayTranscriptTurn,
  dbTurns: TurnRecord[],
): TurnRecord | null {
  return (
    (transcriptTurn.promptId
      ? dbTurns.find((candidate) => candidate.contentPromptId === transcriptTurn.promptId)
      : undefined) ??
    dbTurns.find((candidate) => candidate.promptNumber === transcriptTurn.promptNumber) ??
    null
  );
}

function renderReplaySession(
  session: FormattedSession,
  turns: FormattedTurn[],
  depth: RenderDepth,
): string {
  const lines = [
    renderNode(
      { type: "session", value: session },
      { depth: depth === "collapsed" ? "collapsed" : "expanded", mode: "unified" },
    ),
  ];

  for (const turn of turns) {
    lines.push(
      renderNode(
        { type: "turn", value: turn },
        {
          depth: depth === "full" ? "full" : "collapsed",
          mode: "unified",
          sessionId: session.id,
        },
      ),
    );
  }

  return lines.join("\n");
}

function renderReplayTurns(
  session: FormattedSession,
  turns: FormattedTurn[],
  depth: RenderDepth,
): string {
  const lines = [
    renderNode(
      { type: "session", value: session },
      { depth: "collapsed", mode: "unified" },
    ),
  ];

  for (const turn of turns) {
    lines.push(
      renderNode(
        { type: "turn", value: turn },
        {
          depth,
          mode: "unified",
          sessionId: session.id,
        },
      ),
    );
  }

  return lines.join("\n");
}

function renderReplayTools(
  session: FormattedSession,
  turn: FormattedTurn,
  toolCalls: FormattedToolCall[],
  depth: RenderDepth,
): string {
  const lines = [
    renderNode(
      { type: "session", value: session },
      { depth: "collapsed", mode: "unified" },
    ),
    renderNode(
      { type: "turn", value: turn },
      {
        depth: "collapsed",
        mode: "unified",
        sessionId: session.id,
      },
    ),
  ];

  for (const toolCall of toolCalls) {
    lines.push(
      renderNode(
        { type: "toolCall", value: toolCall },
        {
          depth,
          mode: "unified",
          indent: "    ",
          sessionId: session.id,
          turnPromptNumber: turn.promptNumber,
        },
      ),
    );
  }

  return lines.join("\n");
}

export function replayMemory(db: Database, input: ReplayInput): string {
  if (!input.id?.trim()) {
    return formatParameterError(
      'replay() requires id like "S1", "S1/T2", or "S1/T2/Tool3".',
    );
  }

  const routed = parseReplayId(input.id);
  if (!routed) {
    return formatParameterError(`invalid replay id "${input.id}"`);
  }

  const transcriptPath = resolveReplayTranscriptPath(
    db,
    routed.sessionId,
    input.transcriptPath,
  );

  if (!transcriptPath || !existsSync(transcriptPath)) {
    return "Transcript not found.";
  }

  const transcriptTurns = parseReplayTranscript(transcriptPath);
  const dbSession = getSession(db, routed.sessionId);
  const dbTurns = dbSession ? getTurnsForSession(db, dbSession.id) : [];
  const depth = input.depth ?? "collapsed";
  const sessionView = buildReplaySessionView(
    routed.sessionId,
    transcriptPath,
    transcriptTurns,
    db,
  );

  if (routed.kind === "session") {
    const turnViews = transcriptTurns.map((turn) =>
      buildReplayTurnView(turn.promptNumber, turn, matchDbTurn(turn, dbTurns)),
    );

    return renderReplaySession(sessionView, turnViews, depth);
  }

  const promptNumbers =
    routed.kind === "turns"
      ? routed.promptNumbers
      : [routed.promptNumber];

  const selectedTurns =
    promptNumbers && promptNumbers.length > 0
      ? promptNumbers
          .map((promptNumber) => findReplayTurn(dbTurns, transcriptTurns, promptNumber))
          .filter(
            (
              turn,
            ): turn is {
              transcriptTurn: ReplayTranscriptTurn;
              dbTurn: TurnRecord | null;
            } => turn !== null,
          )
      : transcriptTurns.map((turn) => ({
          transcriptTurn: turn,
          dbTurn: matchDbTurn(turn, dbTurns),
        }));

  if (selectedTurns.length === 0) {
    return "Turn not found.";
  }

  if (routed.kind === "turns") {
    return renderReplayTurns(
      sessionView,
      selectedTurns.map(({ transcriptTurn, dbTurn }) =>
        buildReplayTurnView(transcriptTurn.promptNumber, transcriptTurn, dbTurn),
      ),
      depth,
    );
  }

  const { transcriptTurn, dbTurn } = selectedTurns[0]!;
  const turnView = buildReplayTurnView(
    transcriptTurn.promptNumber,
    transcriptTurn,
    dbTurn,
  );
  const toolCalls =
    routed.toolNumbers && routed.toolNumbers.length > 0
      ? routed.toolNumbers
          .map((toolNumber) => turnView.toolCalls?.[toolNumber - 1] ?? null)
          .filter((toolCall): toolCall is FormattedToolCall => toolCall !== null)
      : (turnView.toolCalls ?? []);

  if (toolCalls.length === 0) {
    return "Tool call not found.";
  }

  return renderReplayTools(sessionView, turnView, toolCalls, depth);
}
