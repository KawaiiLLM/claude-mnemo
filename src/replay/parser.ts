import {
  normalizeAssistantText,
  parseReplayTranscript,
  readAllTranscriptEntries,
  type ReplayToolCall,
  type TranscriptContentBlock,
  type TranscriptEntryWithLineNumber,
} from "../shared/transcript-parser";

export interface TurnMessage {
  type: "user" | "assistant" | "tool_use" | "tool_result" | "thinking";
  line: number;
  content: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
}

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface ReplayParseTurn {
  promptNumber: number;
  promptId: string | null;
  lineStart: number;
  timestamp: string | null;
  localTime: string;
  durationMs: number | null;
  messageCount: number | null;
  userPrompt: string;
  assistantText: string;
  toolCalls: ReplayToolCall[];
  messages: TurnMessage[];
  usage: TurnUsage;
}

export interface CompactBoundary {
  afterPromptNumber: number;
  line: number;
  trigger: string;
  preTokens: number;
}

export interface ReplayParseResult {
  turns: ReplayParseTurn[];
  compacts: CompactBoundary[];
  timeRange: { start: string; end: string } | null;
}

function getContentBlocks(entry: TranscriptEntryWithLineNumber): TranscriptContentBlock[] {
  return Array.isArray(entry.content) ? entry.content : [];
}

function extractUserPrompt(entry: TranscriptEntryWithLineNumber): string {
  if (typeof entry.content === "string") {
    return entry.content.trim();
  }

  return getContentBlocks(entry)
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n")
    .trim();
}

function stringifyContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }

        if (item && typeof item === "object" && "text" in item) {
          const text = (item as { text?: unknown }).text;
          return typeof text === "string" ? text : JSON.stringify(item);
        }

        return JSON.stringify(item);
      })
      .join("\n");
  }

  if (content === undefined) {
    return "";
  }

  return JSON.stringify(content);
}

function formatLocalTime(timestamp: string | null): string {
  if (!timestamp) {
    return "--:--";
  }

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "--:--";
  }

  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function createEmptyUsage(): TurnUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
}

function mergeUsage(target: TurnUsage, entry: TranscriptEntryWithLineNumber): void {
  target.inputTokens += entry.usage?.inputTokens ?? 0;
  target.outputTokens += entry.usage?.outputTokens ?? 0;
  target.cacheReadTokens += entry.usage?.cacheReadTokens ?? 0;
  target.cacheCreationTokens += entry.usage?.cacheCreationTokens ?? 0;
}

export function parseReplayFile(transcriptPath: string): ReplayParseResult {
  const entries = readAllTranscriptEntries(transcriptPath);
  const replayTurns = parseReplayTranscript(transcriptPath, entries);

  if (replayTurns.length === 0) {
    return {
      turns: [],
      compacts: [],
      timeRange: null,
    };
  }

  const turns: ReplayParseTurn[] = replayTurns.map((turn) => ({
    promptNumber: turn.promptNumber,
    promptId: turn.promptId,
    lineStart: turn.transcriptLineStart ?? 0,
    timestamp: null,
    localTime: "--:--",
    durationMs: null,
    messageCount: null,
    userPrompt: turn.userPrompt,
    assistantText: turn.assistantText,
    toolCalls: turn.toolCalls,
    messages: [],
    usage: createEmptyUsage(),
  }));

  const turnByPromptId = new Map<string, ReplayParseTurn>();
  const turnByLine = new Map<number, ReplayParseTurn>();
  for (const turn of turns) {
    if (turn.promptId) {
      turnByPromptId.set(turn.promptId, turn);
    }
    turnByLine.set(turn.lineStart, turn);
  }

  const compacts: CompactBoundary[] = [];
  let currentTurn: ReplayParseTurn | null = null;
  let currentPromptNumber = 0;

  for (const entry of entries) {
    const startedTurn = turnByLine.get(entry.lineNumber);
    if (startedTurn) {
      currentTurn = startedTurn;
      currentPromptNumber = startedTurn.promptNumber;
      currentTurn.timestamp = entry.timestamp ?? null;
      currentTurn.localTime = formatLocalTime(currentTurn.timestamp);
      currentTurn.messages.push({
        type: "user",
        line: entry.lineNumber,
        content: extractUserPrompt(entry),
      });
      continue;
    }

    if (!currentTurn) {
      if (entry.subtype === "compact_boundary" && currentPromptNumber > 0) {
        compacts.push({
          afterPromptNumber: currentPromptNumber,
          line: entry.lineNumber,
          trigger: entry.compactMetadata?.trigger ?? "unknown",
          preTokens:
            entry.compactMetadata?.pre_tokens ??
            entry.compactMetadata?.preCompactTokenCount ??
            0,
        });
      }
      continue;
    }

    if (entry.subtype === "turn_duration") {
      currentTurn.durationMs = entry.durationMs ?? null;
      currentTurn.messageCount = entry.messageCount ?? null;
      continue;
    }

    if (entry.subtype === "compact_boundary") {
      compacts.push({
        afterPromptNumber: currentTurn.promptNumber,
        line: entry.lineNumber,
        trigger: entry.compactMetadata?.trigger ?? "unknown",
        preTokens:
          entry.compactMetadata?.pre_tokens ??
          entry.compactMetadata?.preCompactTokenCount ??
          0,
      });
      continue;
    }

    if (entry.role === "assistant") {
      mergeUsage(currentTurn.usage, entry);
      for (const block of getContentBlocks(entry)) {
        if (block.type === "thinking" && block.text) {
          currentTurn.messages.push({
            type: "thinking",
            line: entry.lineNumber,
            content: block.text,
          });
          continue;
        }

        if (block.type === "text" && block.text?.trim()) {
          currentTurn.messages.push({
            type: "assistant",
            line: entry.lineNumber,
            content: normalizeAssistantText(block.text),
          });
          continue;
        }

        if (block.type === "tool_use" && typeof block.name === "string") {
          currentTurn.messages.push({
            type: "tool_use",
            line: entry.lineNumber,
            content: JSON.stringify(block.input ?? {}),
            toolName: block.name,
            toolInput:
              block.input && typeof block.input === "object"
                ? (block.input as Record<string, unknown>)
                : undefined,
          });
        }
      }

      continue;
    }

    if (entry.role === "user") {
      const toolResultBlocks = getContentBlocks(entry).filter(
        (block) => block.type === "tool_result",
      );
      for (const block of toolResultBlocks) {
        currentTurn.messages.push({
          type: "tool_result",
          line: entry.lineNumber,
          content: stringifyContent(block.content),
        });
      }
    }
  }

  return {
    turns,
    compacts,
    timeRange: {
      start: turns[0]?.timestamp ?? "",
      end: turns[turns.length - 1]?.timestamp ?? "",
    },
  };
}
