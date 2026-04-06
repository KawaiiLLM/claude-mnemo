import { existsSync } from "node:fs";

import type { Database } from "bun:sqlite";

import { getSession } from "../db/sessions";
import { parseReplayTranscript } from "../shared/transcript-parser";
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

function formatTurnOverview(
  turns: ReturnType<typeof parseReplayTranscript>,
): string {
  return turns
    .map(
      (turn) =>
        `[T${turn.promptNumber}] #${turn.promptNumber} ${turn.userPrompt}`,
    )
    .join("\n");
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

function formatTurnDetail(
  turn: ReturnType<typeof parseReplayTranscript>[number],
  full = false,
): string {
  const lines = [
    `[T${turn.promptNumber}] #${turn.promptNumber}`,
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

  const turns = parseReplayTranscript(transcriptPath);

  if (input.turn === undefined) {
    return formatTurnOverview(turns);
  }

  const turn = turns.find((candidate) => candidate.promptNumber === input.turn);

  if (!turn) {
    return "Turn not found.";
  }

  if (input.tool !== undefined) {
    const toolCall = turn.toolCalls[input.tool - 1];

    if (!toolCall) {
      return "Tool call not found.";
    }

    return formatToolBlock(input.tool, toolCall, input.full);
  }

  return formatTurnDetail(turn, input.full);
}
