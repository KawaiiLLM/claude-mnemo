import type { ReplayParseResult, ReplayParseTurn } from "./parser";

export interface FieldContext {
  compactAfterSet: Set<number>;
  compactInfoMap: Map<number, string>;
}

export interface FieldDef {
  name: string;
  type: "number" | "string";
  description: string;
  defaultCap?: number;
  extract: (turn: ReplayParseTurn, ctx: FieldContext) => string | number;
}

export interface SelectedField {
  def: FieldDef;
  cap: number | null;
}

export interface QueryFilters {
  first?: number;
  last?: number;
  range?: { start: number; end: number };
  all?: boolean;
  grep?: string;
  ignoreCase?: boolean;
}

const fieldRegistry: FieldDef[] = [
  {
    name: "promptNumber",
    type: "number",
    description: "Turn number (= recall/timeline T<n>)",
    extract: (turn) => turn.promptNumber,
  },
  {
    name: "lineStart",
    type: "number",
    description: "JSONL 1-based line number",
    extract: (turn) => turn.lineStart,
  },
  {
    name: "localTime",
    type: "string",
    description: "Local time HH:MM",
    defaultCap: 5,
    extract: (turn) => turn.localTime,
  },
  {
    name: "timestamp",
    type: "string",
    description: "ISO timestamp",
    defaultCap: 120,
    extract: (turn) => turn.timestamp ?? "",
  },
  {
    name: "durationMs",
    type: "number",
    description: "Turn duration in ms",
    extract: (turn) => turn.durationMs ?? 0,
  },
  {
    name: "userPrompt",
    type: "string",
    description: "Full user prompt text",
    defaultCap: 120,
    extract: (turn) => turn.userPrompt,
  },
  {
    name: "assistantText",
    type: "string",
    description: "Assistant text blocks concatenated",
    defaultCap: 120,
    extract: (turn) => turn.assistantText,
  },
  {
    name: "toolCount",
    type: "number",
    description: "Total tool_use calls",
    extract: (turn) => turn.toolCalls.length,
  },
  {
    name: "readCount",
    type: "number",
    description: "Read tool calls",
    extract: (turn) => turn.toolCalls.filter((call) => call.name.toLowerCase() === "read").length,
  },
  {
    name: "editCount",
    type: "number",
    description: "Edit/Write tool calls",
    extract: (turn) =>
      turn.toolCalls.filter((call) => {
        const name = call.name.toLowerCase();
        return name === "edit" || name === "write";
      }).length,
  },
  {
    name: "toolNames",
    type: "string",
    description: "Unique tool names (comma-sep)",
    defaultCap: 80,
    extract: (turn) => [...new Set(turn.toolCalls.map((call) => call.name))].join(","),
  },
  {
    name: "usage.input",
    type: "number",
    description: "Input tokens",
    extract: (turn) => turn.usage.inputTokens,
  },
  {
    name: "usage.output",
    type: "number",
    description: "Output tokens",
    extract: (turn) => turn.usage.outputTokens,
  },
  {
    name: "usage.cacheRead",
    type: "number",
    description: "Cache read tokens",
    extract: (turn) => turn.usage.cacheReadTokens,
  },
  {
    name: "usage.cacheCr",
    type: "number",
    description: "Cache creation tokens",
    extract: (turn) => turn.usage.cacheCreationTokens,
  },
  {
    name: "messageCount",
    type: "number",
    description: "Raw message count in turn",
    extract: (turn) => turn.messages.length,
  },
  {
    name: "compactAfter",
    type: "number",
    description: "1 if compact follows this turn, 0 otherwise",
    extract: (turn, ctx) => (ctx.compactAfterSet.has(turn.promptNumber) ? 1 : 0),
  },
  {
    name: "compactInfo",
    type: "string",
    description: "Compact metadata or empty",
    defaultCap: 60,
    extract: (turn, ctx) => ctx.compactInfoMap.get(turn.promptNumber) ?? "",
  },
];

const fieldByName = new Map(fieldRegistry.map((field) => [field.name, field] as const));

export function getFieldRegistry(): FieldDef[] {
  return fieldRegistry;
}

export function getFieldContext(result: ReplayParseResult): FieldContext {
  const compactAfterSet = new Set<number>();
  const compactInfoMap = new Map<number, string>();

  for (const compact of result.compacts) {
    compactAfterSet.add(compact.afterPromptNumber);
    compactInfoMap.set(
      compact.afterPromptNumber,
      `${formatCompactTokens(compact.preTokens)} tokens, ${compact.trigger}`,
    );
  }

  return { compactAfterSet, compactInfoMap };
}

export function parseFieldSpec(spec: string): SelectedField[] {
  const tokens = spec
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);

  if (tokens.length === 0) {
    throw new Error("Usage: replay-parse query <jsonl> -f \"field[:cap],...\"");
  }

  return tokens.map((token) => {
    const [name, capSpec] = token.split(":", 2);
    const field = fieldByName.get(name);
    if (!field) {
      throw new Error(`Unknown field: ${name}`);
    }

    if (capSpec === undefined) {
      return {
        def: field,
        cap: field.type === "string" ? field.defaultCap ?? null : null,
      };
    }

    const cap = Number.parseInt(capSpec, 10);
    if (!Number.isInteger(cap) || cap < 0) {
      throw new Error(`Invalid cap for ${name}: ${capSpec}`);
    }

    return {
      def: field,
      cap: cap === 0 ? null : cap,
    };
  });
}

export function renderQueryCell(value: string | number, cap: number | null): string {
  if (typeof value === "number") {
    return String(value);
  }

  const escaped = escapeTsvString(value);
  if (cap === null || escaped.length <= cap) {
    return escaped;
  }

  return `${escaped.slice(0, Math.max(0, cap - 1))}…`;
}

export function escapeTsvString(value: string): string {
  return value.replaceAll("\n", "\\n").replaceAll("\t", "\\t");
}

export function formatCompactTokens(preTokens: number): string {
  if (preTokens >= 1_000_000) {
    return `${Math.floor(preTokens / 100_000) / 10}M`;
  }

  return `${Math.floor(preTokens / 1_000)}k`;
}

export function filterReplayTurns(
  result: ReplayParseResult,
  options: QueryFilters,
): ReplayParseTurn[] {
  let turns = result.turns;

  if (options.grep) {
    turns = turns.filter((turn) => matchesGrep(turn, options.grep!, options.ignoreCase ?? false));
  }

  if (options.all) {
    return turns;
  }

  if (options.range) {
    return turns.filter(
      (turn) =>
        turn.promptNumber >= options.range!.start &&
        turn.promptNumber <= options.range!.end,
    );
  }

  if (options.first !== undefined) {
    return turns.slice(0, options.first);
  }

  return turns.slice(-1 * (options.last ?? 30));
}

function matchesGrep(turn: ReplayParseTurn, pattern: string, ignoreCase: boolean): boolean {
  const haystack = buildSearchText(turn);
  return ignoreCase
    ? haystack.toLowerCase().includes(pattern.toLowerCase())
    : haystack.includes(pattern);
}

function buildSearchText(turn: ReplayParseTurn): string {
  const toolCallText = turn.toolCalls
    .map((call) => `${call.name}\n${JSON.stringify(call.input ?? {})}\n${call.result ?? ""}`)
    .join("\n");

  return [
    turn.userPrompt,
    turn.assistantText,
    toolCallText,
  ].join("\n");
}
