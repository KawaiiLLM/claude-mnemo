import type { ReplayParseResult, ReplayParseTurn, TurnMessage } from "../parser";

export interface ShowOptions {
  preview?: number;
  noToolResult?: boolean;
  thinking?: boolean;
  raw?: boolean;
}

function truncate(text: string, preview: number, raw = false): string {
  if (raw || preview === 0 || text.length <= preview) {
    return text;
  }
  return `${text.slice(0, Math.max(0, preview - 1))}…`;
}

function formatToolInput(input: Record<string, unknown> | undefined): string {
  if (!input) {
    return "";
  }

  return Object.entries(input)
    .slice(0, 2)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(", ");
}

function renderMessage(message: TurnMessage, options: ShowOptions): string[] {
  const preview = options.preview ?? 200;
  switch (message.type) {
    case "user":
      return ["USER:", truncate(message.content, preview, options.raw), ""];
    case "assistant":
      return ["ASST:", truncate(message.content, preview, options.raw), ""];
    case "thinking":
      if (!options.thinking) {
        return [];
      }
      return ["THINK:", truncate(message.content, preview, options.raw), ""];
    case "tool_use":
      return [
        `TOOL: ${message.toolName}(${formatToolInput(message.toolInput)})`,
      ];
    case "tool_result":
      return [
        options.noToolResult
          ? "  → (omitted)"
          : `  → ${truncate(message.content, preview, options.raw)}`,
      ];
  }
}

function renderUsage(turn: ReplayParseTurn): string {
  return `usage: input=${turn.usage.inputTokens}  output=${turn.usage.outputTokens}  cache_read=${turn.usage.cacheReadTokens}`;
}

export function renderReplayShow(
  result: ReplayParseResult,
  promptNumber: number,
  options: ShowOptions = {},
): string {
  const turn = result.turns.find((candidate) => candidate.promptNumber === promptNumber);
  if (!turn) {
    throw new Error(`Unknown turn T${promptNumber}`);
  }

  const lines = [
    `T${turn.promptNumber}  L${turn.lineStart}  ${turn.localTime}  duration=${turn.durationMs ? Math.round(turn.durationMs / 1000) : 0}s  messages=${turn.messageCount ?? turn.messages.length}`,
    "",
  ];

  for (const message of turn.messages) {
    lines.push(...renderMessage(message, options));
  }

  lines.push(renderUsage(turn));
  return lines.join("\n");
}
