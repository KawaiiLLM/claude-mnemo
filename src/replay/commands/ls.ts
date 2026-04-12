import type { CompactBoundary, ReplayParseResult, ReplayParseTurn } from "../parser";

export interface LsOptions {
  last?: number;
  first?: number;
  range?: { start: number; end: number };
  all?: boolean;
  preview?: number;
  usage?: boolean;
  grep?: string;
}

function truncate(text: string, preview: number): string {
  if (preview === 0 || text.length <= preview) {
    return text;
  }

  return `${text.slice(0, Math.max(0, preview - 1))}…`;
}

function countToolStats(turn: ReplayParseTurn): { tool: number; read: number; write: number } {
  let tool = 0;
  let read = 0;
  let write = 0;

  for (const message of turn.messages) {
    if (message.type !== "tool_use") {
      continue;
    }
    const name = message.toolName ?? "";
    if (name === "Read") {
      read += 1;
    } else if (name === "Edit" || name === "Write") {
      write += 1;
    } else {
      tool += 1;
    }
  }

  return { tool, read, write };
}

function formatDuration(start: string, end: string): string {
  const startDate = new Date(start);
  const endDate = new Date(end);
  const totalMinutes = Math.max(
    0,
    Math.round((endDate.getTime() - startDate.getTime()) / 60000),
  );
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

function formatBoundary(boundary: CompactBoundary): string {
  const tokens =
    boundary.preTokens >= 1_000_000
      ? `${Math.floor(boundary.preTokens / 100_000) / 10}M`
      : `${Math.floor(boundary.preTokens / 1_000)}k`;
  return `── compact (${tokens} tokens, ${boundary.trigger}) ──`;
}

function selectTurns(turns: ReplayParseTurn[], options: LsOptions): ReplayParseTurn[] {
  let selected = turns;

  if (options.grep) {
    selected = selected.filter((turn) => turn.userPrompt.includes(options.grep!));
  }

  if (options.all) {
    return selected;
  }

  if (options.range) {
    return selected.filter(
      (turn) =>
        turn.promptNumber >= options.range!.start &&
        turn.promptNumber <= options.range!.end,
    );
  }

  if (options.first) {
    return selected.slice(0, options.first);
  }

  return selected.slice(-1 * (options.last ?? 30));
}

export function renderReplayLs(result: ReplayParseResult, options: LsOptions = {}): string {
  const preview = options.preview ?? 120;
  const selected = selectTurns(result.turns, options);
  const selectedPromptNumbers = new Set(selected.map((turn) => turn.promptNumber));
  const lines: string[] = [];

  if (result.timeRange) {
    lines.push(
      `${result.turns.length} turns | ${result.compacts.length} compacts | ${result.timeRange.start.slice(0, 16).replace("T", " ")} → ${result.timeRange.end.slice(11, 16)} (${formatDuration(result.timeRange.start, result.timeRange.end)})`,
    );
    lines.push("");
  }

  for (const turn of selected) {
    const stats = countToolStats(turn);
    const statParts = [
      stats.tool > 0 ? `🔧${stats.tool}` : "",
      stats.read > 0 ? `📖${stats.read}` : "",
      stats.write > 0 ? `✏️${stats.write}` : "",
    ].filter(Boolean);
    const usageSuffix = options.usage
      ? `    in=${turn.usage.inputTokens} out=${turn.usage.outputTokens} cache=${turn.usage.cacheReadTokens}`
      : "";
    lines.push(
      `T${String(turn.promptNumber).padStart(3, " ")}  L${turn.lineStart}    ${turn.localTime}  ${statParts.join(" ")}${statParts.length > 0 ? "  " : ""}${truncate(turn.userPrompt, preview)}${usageSuffix}`,
    );

    for (const boundary of result.compacts) {
      if (
        boundary.afterPromptNumber === turn.promptNumber &&
        selectedPromptNumbers.has(turn.promptNumber + 1)
      ) {
        lines.push(formatBoundary(boundary));
      }
    }
  }

  return lines.join("\n");
}
