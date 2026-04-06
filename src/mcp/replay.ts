import { existsSync } from "node:fs";

import type { Database } from "bun:sqlite";

import { getSession } from "../db/sessions";
import { getTurnsForSession } from "../db/turns";
import {
  parseReplayTranscript,
} from "../shared/transcript-parser";
import { resolveTranscriptPath } from "../shared/paths";

const TOOL_RESULT_PREVIEW_LIMIT = 500;

export interface ReplayInput {
  session: number;
  turn?: number;
  tool?: number;
  full?: boolean;
  transcriptPath?: string;
}

function truncate(text: string, full = false): string {
  if (full || text.length <= TOOL_RESULT_PREVIEW_LIMIT) {
    return text;
  }

  return `${text.slice(0, TOOL_RESULT_PREVIEW_LIMIT)}...`;
}

function resolveReplayTranscriptPath(
  db: Database,
  input: ReplayInput,
): string | null {
  if (input.transcriptPath) {
    return input.transcriptPath;
  }

  const session = getSession(db, input.session);

  if (!session) {
    return null;
  }

  return resolveTranscriptPath(session.project, session.contentSessionId);
}

function formatToolBlock(
  index: number,
  toolCall: ReturnType<typeof parseReplayTranscript>[number]["toolCalls"][number],
  full = false,
): string {
  return [
    `[Tool ${index}] ${toolCall.name}`,
    `input: ${JSON.stringify(toolCall.input)}`,
    `result: ${truncate(toolCall.result, full)}`,
  ].join("\n");
}

function formatTurnOverviewLine(
  promptNumber: number,
  userPrompt: string,
  status?: string,
): string {
  const label =
    status === "undone"
      ? `[T${promptNumber}][undone] #${promptNumber}`
      : `[T${promptNumber}] #${promptNumber}`;

  return `${label} ${userPrompt}`;
}

function formatTurnDetail(
  turn: ReturnType<typeof parseReplayTranscript>[number],
  promptNumber: number,
  status?: string,
  full = false,
): string {
  const header =
    status === "undone"
      ? `[T${promptNumber}][undone] #${promptNumber}`
      : `[T${promptNumber}] #${promptNumber}`;
  const lines = [
    header,
    `prompt: "${turn.userPrompt}"`,
    `response: "${turn.assistantText}"`,
  ];

  turn.toolCalls.forEach((toolCall, index) => {
    lines.push(formatToolBlock(index + 1, toolCall, full));
  });

  return lines.join("\n");
}

export function replayMemory(db: Database, input: ReplayInput): string {
  const transcriptPath = resolveReplayTranscriptPath(db, input);

  if (!transcriptPath || !existsSync(transcriptPath)) {
    return "Transcript not found.";
  }

  const transcriptTurns = parseReplayTranscript(transcriptPath);
  const session = getSession(db, input.session);
  const dbTurns = session ? getTurnsForSession(db, session.id) : [];
  const statusByPromptNumber = new Map(
    dbTurns.map((turn) => [turn.promptNumber, turn.status]),
  );

  if (input.turn === undefined) {
    return transcriptTurns
      .map((turn) =>
        formatTurnOverviewLine(
          turn.promptNumber,
          turn.userPrompt,
          statusByPromptNumber.get(turn.promptNumber),
        ),
      )
      .join("\n");
  }

  const resolvedTurn =
    transcriptTurns.find((candidate) => candidate.promptNumber === input.turn) ??
    null;

  if (!resolvedTurn) {
    return "Turn not found.";
  }

  if (input.tool !== undefined) {
    const toolCall = resolvedTurn.toolCalls[input.tool - 1];

    if (!toolCall) {
      return "Tool call not found.";
    }

    return formatToolBlock(input.tool, toolCall, input.full);
  }

  return formatTurnDetail(
    resolvedTurn,
    input.turn,
    statusByPromptNumber.get(input.turn),
    input.full,
  );
}
