import type { ReplayParseResult, TurnMessage } from "../parser";

export interface GrepOptions {
  type?: "user" | "assistant" | "tool";
  context?: number;
  preview?: number;
  ignoreCase?: boolean;
}

function truncate(text: string, preview: number): string {
  if (preview === 0 || text.length <= preview) {
    return text;
  }
  return `${text.slice(0, Math.max(0, preview - 1))}…`;
}

function matchesType(message: TurnMessage, type: GrepOptions["type"]): boolean {
  if (!type) {
    return true;
  }
  if (type === "user") {
    return message.type === "user";
  }
  if (type === "assistant") {
    return message.type === "assistant";
  }
  return message.type === "tool_use" || message.type === "tool_result";
}

function includesPattern(value: string, pattern: string, ignoreCase = false): boolean {
  if (ignoreCase) {
    return value.toLowerCase().includes(pattern.toLowerCase());
  }
  return value.includes(pattern);
}

function renderMatchedMessage(message: TurnMessage, preview: number): string {
  switch (message.type) {
    case "user":
      return `  USER: ${truncate(message.content, preview)}`;
    case "assistant":
      return `  ASST: ${truncate(message.content, preview)}`;
    case "tool_use":
      return `  TOOL: ${message.toolName ?? "Tool"} ${truncate(message.content, preview)}`;
    case "tool_result":
      return `  TOOL: ${truncate(message.content, preview)}`;
    case "thinking":
      return `  THINK: ${truncate(message.content, preview)}`;
  }
}

export function renderReplayGrep(
  result: ReplayParseResult,
  pattern: string,
  options: GrepOptions = {},
): string {
  const preview = options.preview ?? 120;
  const sections: string[] = [];
  let matchCount = 0;
  let turnCount = 0;

  for (const turn of result.turns) {
    const matchingMessages = turn.messages.filter(
      (message) =>
        matchesType(message, options.type) &&
        includesPattern(
          message.type === "tool_use"
            ? `${message.toolName ?? ""} ${message.content}`
            : message.content,
          pattern,
          options.ignoreCase,
        ),
    );

    if (matchingMessages.length === 0) {
      continue;
    }

    turnCount += 1;
    matchCount += matchingMessages.length;
    sections.push(`T${String(turn.promptNumber).padStart(3, " ")}  L${turn.lineStart}   ${turn.localTime}`);
    for (const message of matchingMessages) {
      sections.push(renderMatchedMessage(message, preview));
    }
    sections.push("");
  }

  return [`${matchCount} matches in ${turnCount} turns`, "", ...sections].join("\n").trimEnd();
}
