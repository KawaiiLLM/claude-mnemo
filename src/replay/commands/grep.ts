import type { ReplayParseResult, TurnMessage } from "../parser";
import { truncateText } from "../format";

export interface GrepOptions {
  type?: "user" | "assistant" | "tool";
  context?: number;
  preview?: number;
  ignoreCase?: boolean;
}

function isVisibleByDefault(message: TurnMessage): boolean {
  return (
    message.type === "user" ||
    message.type === "assistant" ||
    message.type === "tool_use" ||
    message.type === "tool_result"
  );
}

function isVisibleInOutput(message: TurnMessage): boolean {
  return isVisibleByDefault(message);
}

function matchesType(message: TurnMessage, type: GrepOptions["type"]): boolean {
  if (!type) {
    return isVisibleByDefault(message);
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
      return `  USER: ${truncateText(message.content, preview)}`;
    case "assistant":
      return `  ASST: ${truncateText(message.content, preview)}`;
    case "tool_use":
      return `  TOOL: ${message.toolName ?? "Tool"} ${truncateText(message.content, preview)}`;
    case "tool_result":
      return `  → ${truncateText(message.content, preview)}`;
    case "thinking":
      return `  THINK: ${truncateText(message.content, preview)}`;
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
  const context = options.context ?? 0;

  for (const turn of result.turns) {
    const visibleMessages = turn.messages
      .map((message, originalIndex) => ({ message, originalIndex }))
      .filter(({ message }) => isVisibleInOutput(message));

    const matchingIndexes = visibleMessages
      .map(({ message }, index) => ({ message, index }))
      .filter(
        ({ message }) =>
        matchesType(message, options.type) &&
        includesPattern(
          message.type === "tool_use"
            ? `${message.toolName ?? ""} ${message.content}`
            : message.content,
          pattern,
          options.ignoreCase,
        ),
      )
      .map(({ index }) => index);

    if (matchingIndexes.length === 0) {
      continue;
    }

    turnCount += 1;
    matchCount += matchingIndexes.length;

    const indexesToRender =
      context > 0
        ? Array.from(
            new Set(
              matchingIndexes.flatMap((index) =>
                visibleMessages
                  .map((_, candidateIndex) => candidateIndex)
                  .slice(Math.max(0, index - context), index + context + 1),
              ),
            ),
          )
        : matchingIndexes;

    sections.push(`T${String(turn.promptNumber).padStart(3, " ")}  L${turn.lineStart}   ${turn.localTime}`);
    for (const index of indexesToRender) {
      sections.push(renderMatchedMessage(visibleMessages[index]!.message, preview));
    }
    sections.push("");
  }

  return [`${matchCount} matches in ${turnCount} turns`, "", ...sections].join("\n").trimEnd();
}
