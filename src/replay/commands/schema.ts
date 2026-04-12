import type { ReplayParseResult } from "../parser";
import { getFieldRegistry, formatCompactTokens } from "../fields";

function truncateSample(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function formatSampleValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined) {
    return `""`;
  }

  if (typeof value === "number") {
    return String(value);
  }

  return JSON.stringify(truncateSample(value, 60));
}

function formatTimeRange(result: ReplayParseResult): string {
  if (!result.timeRange) {
    return "(empty file)";
  }

  const start = result.timeRange.start.slice(0, 16).replace("T", " ");
  const end = result.timeRange.end.slice(11, 16);
  return `${start} → ${end}`;
}

export function renderReplaySchema(result: ReplayParseResult): string {
  const lines: string[] = [];
  lines.push(
    `${result.turns.length} turns | ${result.compacts.length} compacts | ${formatTimeRange(result)}`,
  );
  lines.push("");
  lines.push("Fields:");

  const sampleTurns = result.turns.slice(0, 3);
  for (const field of getFieldRegistry()) {
    const samples = sampleTurns.map((turn) => formatSampleValue(field.extract(turn, {
      compactAfterSet: new Set(result.compacts.map((compact) => compact.afterPromptNumber)),
      compactInfoMap: new Map(
        result.compacts.map((compact) => [
          compact.afterPromptNumber,
          `${formatCompactTokens(compact.preTokens)} tokens, ${compact.trigger}`,
        ]),
      ),
    })));

    const sampleText = samples.length > 0 ? samples.join(", ") : "(empty file)";
    lines.push(
      `  ${field.name.padEnd(15)} ${field.type.padEnd(6)} ${sampleText.padEnd(35)} ${field.description}`,
    );
  }

  lines.push("");
  lines.push('Usage: replay-parse query <jsonl> -f "promptNumber,localTime,userPrompt:80" --last 10');
  return lines.join("\n");
}
