import { existsSync, readFileSync } from "node:fs";

export interface TranscriptContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
}

interface TranscriptUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

interface TranscriptEntry {
  type?: string;
  subtype?: string;
  role?: string;
  content?: TranscriptContentBlock[] | string;
  promptId?: string;
  permissionMode?: string;
  isSidechain?: boolean;
  isApiErrorMessage?: boolean;
  uuid?: string;
  parentUuid?: string;
  timestamp?: string;
  usage?: TranscriptUsage;
  durationMs?: number;
  messageCount?: number;
  compactMetadata?: {
    trigger?: string;
    preCompactTokenCount?: number;
    pre_tokens?: number;
  };
}

export interface TranscriptEntryWithLineNumber extends TranscriptEntry {
  lineNumber: number;
}

export interface TranscriptToolCall {
  name: string;
  input: unknown;
}

export interface ReplayToolCall extends TranscriptToolCall {
  result: string;
}

export interface ParsedTurn {
  promptNumber: number;
  userPrompt: string;
  assistantText: string;
  toolCalls: TranscriptToolCall[];
}

export interface ParsedReplayTurn {
  promptNumber: number;
  promptId: string | null;
  transcriptLineStart: number | null;
  userPrompt: string;
  assistantText: string;
  toolCalls: ReplayToolCall[];
  isSidechain: boolean;
  wasInterrupted: boolean;
}

interface RawTranscriptEntry {
  type?: unknown;
  subtype?: unknown;
  role?: unknown;
  content?: unknown;
  message?: unknown;
  promptId?: unknown;
  permissionMode?: unknown;
  isSidechain?: unknown;
  isApiErrorMessage?: unknown;
  uuid?: unknown;
  parentUuid?: unknown;
  timestamp?: unknown;
  durationMs?: unknown;
  messageCount?: unknown;
  compactMetadata?: unknown;
}

interface RawTranscriptMessage {
  role?: unknown;
  content?: unknown;
  usage?: unknown;
}

export function normalizeAssistantText(text: string): string {
  return text
    .replace(/<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function getContentBlocks(entry: TranscriptEntry): TranscriptContentBlock[] {
  return Array.isArray(entry.content) ? entry.content : [];
}

function getFirstTextContent(entry: TranscriptEntry): string {
  if (typeof entry.content === "string") {
    return entry.content.trim();
  }

  const textBlock = getContentBlocks(entry).find((block) => block.type === "text");
  return typeof textBlock?.text === "string" ? textBlock.text.trim() : "";
}

function extractUserPrompt(entry: TranscriptEntry): string {
  if (typeof entry.content === "string") {
    return entry.content.trim();
  }

  return getContentBlocks(entry)
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n")
    .trim();
}

function isCountedUserPrompt(entry: TranscriptEntry): boolean {
  return entry.role === "user" && isRealUserPrompt(entry);
}

export function isInterruptedUserMarker(entry: TranscriptEntry): boolean {
  return (
    entry.role === "user" &&
    getFirstTextContent(entry).startsWith("[Request interrupted by user")
  );
}

function isKnownSystemInjectedContent(content: string): boolean {
  return (
    content.startsWith("<task-notification>") ||
    content.startsWith("<local-command-") ||
    content.startsWith("<command-name>") ||
    content.startsWith("<command-args>") ||
    content.startsWith("<command-message>") ||
    content.startsWith("⏺ Ran ")
  );
}

function isRealUserPrompt(entry: TranscriptEntry): boolean {
  const promptText = extractUserPrompt(entry);

  if (entry.permissionMode) {
    return true;
  }

  if (isKnownSystemInjectedContent(promptText)) {
    return false;
  }

  return promptText !== "";
}

function extractAssistantParts(entry: TranscriptEntry): {
  assistantText: string;
  toolCalls: TranscriptToolCall[];
} {
  const toolCalls = getContentBlocks(entry)
    .filter((block) => block.type === "tool_use" && typeof block.name === "string")
    .map((block) => ({
      name: block.name as string,
      input: block.input,
    }));

  const assistantText = normalizeAssistantText(
    getContentBlocks(entry)
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("\n"),
  );

  return { assistantText, toolCalls };
}

function stringifyToolResultContent(content: unknown): string {
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

export function readTranscriptEntries(transcriptPath: string): TranscriptEntry[] {
  return readAllTranscriptEntries(transcriptPath).filter(
    (entry) => !entry.isSidechain && !entry.isApiErrorMessage,
  );
}

// The most recent assistant turn's prompt size = the session's *current*
// context. Each API call's usage is a snapshot of the whole conversation
// prefix (input + cache_read + cache_creation all count toward that one
// request's prompt), so the last assistant entry's sum is the live context
// size — not a running total across calls. Returns null when no usage is found
// (missing/empty transcript), letting callers fall back to their default.
export function readLatestContextTokens(transcriptPath: string): number | null {
  const entries = readAllTranscriptEntries(transcriptPath);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.role === "assistant" && entry.usage) {
      const { inputTokens, cacheReadTokens, cacheCreationTokens } = entry.usage;
      return (
        (inputTokens ?? 0) +
        (cacheReadTokens ?? 0) +
        (cacheCreationTokens ?? 0)
      );
    }
  }
  return null;
}

export function isChainParticipant(entry: { type?: string }): boolean {
  return entry.type !== "progress";
}

function collectInterruptedPromptIds(
  entries: TranscriptEntry[],
): Set<string> {
  const interruptedPromptIds = new Set<string>();

  for (const entry of entries) {
    if (entry.promptId && isInterruptedUserMarker(entry)) {
      interruptedPromptIds.add(entry.promptId);
    }
  }

  return interruptedPromptIds;
}

export function detectInterruptedPromptIds(transcriptPath: string): Set<string> {
  return collectInterruptedPromptIds(readAllTranscriptEntries(transcriptPath));
}

export function readAllTranscriptEntries(
  transcriptPath: string,
): TranscriptEntryWithLineNumber[] {
  if (!existsSync(transcriptPath)) {
    return [];
  }

  const rawTranscript = readFileSync(transcriptPath, "utf8");

  if (rawTranscript.trim() === "") {
    return [];
  }

  const entries: TranscriptEntryWithLineNumber[] = [];

  rawTranscript.split("\n").forEach((line, index) => {
    const trimmedLine = line.trim();

    if (!trimmedLine) {
      return;
    }

    let entry: TranscriptEntry;
    try {
      entry = normalizeEntry(JSON.parse(trimmedLine) as RawTranscriptEntry);
    } catch {
      return;
    }

    if (entry.isApiErrorMessage) {
      return;
    }

    entries.push({
      ...entry,
      lineNumber: index + 1,
    });
  });

  const uuidToIndex = new Map<string, number>();
  const deduped: TranscriptEntryWithLineNumber[] = [];

  for (const entry of entries) {
    if (entry.uuid) {
      const existingIndex = uuidToIndex.get(entry.uuid);
      if (existingIndex !== undefined) {
        deduped[existingIndex] = mergeTranscriptEntries(
          deduped[existingIndex]!,
          entry,
        );
        continue;
      }
      uuidToIndex.set(entry.uuid, deduped.length);
    }

    deduped.push(entry);
  }

  return deduped;
}

function mergeUsage(
  first: TranscriptUsage | undefined,
  later: TranscriptUsage | undefined,
): TranscriptUsage | undefined {
  if (!first && !later) {
    return undefined;
  }

  return {
    inputTokens: later?.inputTokens ?? first?.inputTokens,
    outputTokens: later?.outputTokens ?? first?.outputTokens,
    cacheReadTokens: later?.cacheReadTokens ?? first?.cacheReadTokens,
    cacheCreationTokens: later?.cacheCreationTokens ?? first?.cacheCreationTokens,
  };
}

function mergeCompactMetadata(
  first: TranscriptEntry["compactMetadata"],
  later: TranscriptEntry["compactMetadata"],
): TranscriptEntry["compactMetadata"] {
  if (!first && !later) {
    return undefined;
  }

  return {
    trigger: later?.trigger ?? first?.trigger,
    preCompactTokenCount:
      later?.preCompactTokenCount ?? first?.preCompactTokenCount,
    pre_tokens: later?.pre_tokens ?? first?.pre_tokens,
  };
}

function mergeTranscriptEntries(
  first: TranscriptEntryWithLineNumber,
  later: TranscriptEntryWithLineNumber,
): TranscriptEntryWithLineNumber {
  return {
    type: later.type ?? first.type,
    subtype: later.subtype ?? first.subtype,
    role: later.role ?? first.role,
    content: later.content ?? first.content,
    promptId: first.promptId ?? later.promptId,
    permissionMode: later.permissionMode ?? first.permissionMode,
    // These flags must stay undefined when absent. mergeTranscriptEntries relies on
    // ?? so that a later partial snapshot cannot silently overwrite an earlier true.
    isSidechain: later.isSidechain ?? first.isSidechain,
    isApiErrorMessage: later.isApiErrorMessage ?? first.isApiErrorMessage,
    uuid: first.uuid ?? later.uuid,
    parentUuid: later.parentUuid ?? first.parentUuid,
    timestamp: first.timestamp ?? later.timestamp,
    usage: mergeUsage(first.usage, later.usage),
    durationMs: later.durationMs ?? first.durationMs,
    messageCount: later.messageCount ?? first.messageCount,
    compactMetadata: mergeCompactMetadata(
      first.compactMetadata,
      later.compactMetadata,
    ),
    lineNumber: first.lineNumber,
  };
}

function normalizeEntry(raw: RawTranscriptEntry): TranscriptEntry {
  const message =
    raw.message && typeof raw.message === "object"
      ? (raw.message as RawTranscriptMessage)
      : undefined;

  return {
    type: typeof raw.type === "string" ? raw.type : undefined,
    subtype: typeof raw.subtype === "string" ? raw.subtype : undefined,
    role:
      typeof message?.role === "string"
        ? message.role
        : typeof raw.role === "string"
          ? raw.role
          : typeof raw.type === "string"
            ? raw.type
            : undefined,
    content:
      typeof message?.content === "string" || Array.isArray(message?.content)
        ? message.content
        : typeof raw.content === "string" || Array.isArray(raw.content)
          ? raw.content
          : undefined,
    promptId: typeof raw.promptId === "string" ? raw.promptId : undefined,
    uuid: typeof raw.uuid === "string" ? raw.uuid : undefined,
    parentUuid: typeof raw.parentUuid === "string" ? raw.parentUuid : undefined,
    timestamp: typeof raw.timestamp === "string" ? raw.timestamp : undefined,
    permissionMode:
      typeof raw.permissionMode === "string" ? raw.permissionMode : undefined,
    // Preserve "absent" as undefined rather than false. The last-wins merge keeps
    // an earlier true flag only because mergeTranscriptEntries uses ??.
    isSidechain:
      typeof raw.isSidechain === "boolean" ? raw.isSidechain : undefined,
    isApiErrorMessage:
      typeof raw.isApiErrorMessage === "boolean"
        ? raw.isApiErrorMessage
        : undefined,
    usage:
      message?.usage && typeof message.usage === "object"
        ? {
            inputTokens:
              typeof (message.usage as { input_tokens?: unknown }).input_tokens ===
              "number"
                ? (message.usage as { input_tokens: number }).input_tokens
                : undefined,
            outputTokens:
              typeof (message.usage as { output_tokens?: unknown }).output_tokens ===
              "number"
                ? (message.usage as { output_tokens: number }).output_tokens
                : undefined,
            cacheReadTokens:
              typeof (message.usage as { cache_read_input_tokens?: unknown })
                .cache_read_input_tokens === "number"
                ? (message.usage as { cache_read_input_tokens: number })
                    .cache_read_input_tokens
                : undefined,
            cacheCreationTokens:
              typeof (message.usage as { cache_creation_input_tokens?: unknown })
                .cache_creation_input_tokens === "number"
                ? (message.usage as { cache_creation_input_tokens: number })
                    .cache_creation_input_tokens
                : undefined,
          }
        : undefined,
    durationMs: typeof raw.durationMs === "number" ? raw.durationMs : undefined,
    messageCount:
      typeof raw.messageCount === "number" ? raw.messageCount : undefined,
    compactMetadata:
      raw.compactMetadata && typeof raw.compactMetadata === "object"
        ? {
            trigger:
              typeof (raw.compactMetadata as { trigger?: unknown }).trigger === "string"
                ? (raw.compactMetadata as { trigger: string }).trigger
                : undefined,
            preCompactTokenCount:
              typeof (raw.compactMetadata as { preCompactTokenCount?: unknown })
                .preCompactTokenCount === "number"
                ? (raw.compactMetadata as { preCompactTokenCount: number })
                    .preCompactTokenCount
                : undefined,
            pre_tokens:
              typeof (raw.compactMetadata as { pre_tokens?: unknown }).pre_tokens ===
              "number"
                ? (raw.compactMetadata as { pre_tokens: number }).pre_tokens
                : undefined,
          }
        : undefined,
  };
}

export function buildPromptIdLineMap(transcriptPath: string): Map<string, number> {
  const promptIdLineMap = new Map<string, number>();

  for (const entry of readAllTranscriptEntries(transcriptPath)) {
    if (!entry.promptId || promptIdLineMap.has(entry.promptId)) {
      continue;
    }

    promptIdLineMap.set(entry.promptId, entry.lineNumber);
  }

  return promptIdLineMap;
}

function startsNewTurn(
  entry: TranscriptEntry,
  currentPromptId: string | null,
): boolean {
  if (!isCountedUserPrompt(entry)) {
    return false;
  }

  if (entry.promptId) {
    return entry.promptId !== currentPromptId;
  }

  return extractUserPrompt(entry) !== "";
}

export function parseTranscript(transcriptPath: string): ParsedTurn[] {
  const turns: ParsedTurn[] = [];
  let promptNumber = 0;
  let currentTurn: ParsedTurn | null = null;
  let currentPromptId: string | null = null;

  for (const entry of readTranscriptEntries(transcriptPath)) {
    if (startsNewTurn(entry, currentPromptId)) {
      const userPrompt = extractUserPrompt(entry);

      promptNumber += 1;
      currentPromptId = entry.promptId ?? null;
      currentTurn = {
        promptNumber,
        userPrompt,
        assistantText: "",
        toolCalls: [],
      };
      turns.push(currentTurn);
      continue;
    }

    if (entry.role !== "assistant" || !currentTurn) {
      continue;
    }

    const { assistantText, toolCalls } = extractAssistantParts(entry);

    if (assistantText) {
      currentTurn.assistantText = currentTurn.assistantText
        ? `${currentTurn.assistantText}\n\n${assistantText}`
        : assistantText;
    }

    currentTurn.toolCalls.push(...toolCalls);
  }

  return turns.map((turn) => ({
    ...turn,
    assistantText: normalizeAssistantText(turn.assistantText),
  }));
}

export function parseReplayTranscript(
  transcriptPath: string,
  preloadedEntries?: TranscriptEntryWithLineNumber[],
): ParsedReplayTurn[] {
  const turns: ParsedReplayTurn[] = [];
  const entries = preloadedEntries ?? readAllTranscriptEntries(transcriptPath);
  const interruptedPromptIds = collectInterruptedPromptIds(entries);
  let promptNumber = 0;
  let currentTurn: ParsedReplayTurn | null = null;
  let currentPromptId: string | null = null;

  for (const entry of entries) {
    if (startsNewTurn(entry, currentPromptId)) {
      const userPrompt = extractUserPrompt(entry);

      promptNumber += 1;
      currentPromptId = entry.promptId ?? null;
      currentTurn = {
        promptNumber,
        promptId: entry.promptId ?? null,
        transcriptLineStart: entry.lineNumber,
        userPrompt,
        assistantText: "",
        toolCalls: [],
        isSidechain: Boolean(entry.isSidechain),
        wasInterrupted:
          entry.promptId !== undefined && interruptedPromptIds.has(entry.promptId),
      };
      turns.push(currentTurn);
      continue;
    }

    if (entry.role === "user") {
      if (!currentTurn) {
        continue;
      }

      const unresolvedToolCalls = currentTurn.toolCalls.filter(
        (toolCall) => toolCall.result === "",
      );
      const toolResults = getContentBlocks(entry)
        .filter((block) => block.type === "tool_result")
        .map((block) => stringifyToolResultContent(block.content));

      for (let index = 0; index < unresolvedToolCalls.length; index += 1) {
        unresolvedToolCalls[index]!.result = toolResults[index] ?? "";
      }

      continue;
    }

    if (entry.role !== "assistant" || !currentTurn) {
      continue;
    }

    const { assistantText, toolCalls } = extractAssistantParts(entry);

    if (assistantText) {
      currentTurn.assistantText = currentTurn.assistantText
        ? `${currentTurn.assistantText}\n\n${assistantText}`
        : assistantText;
    }

    currentTurn.toolCalls.push(
      ...toolCalls.map((toolCall) => ({
        ...toolCall,
        result: "",
      })),
    );
  }

  return turns.map((turn) => ({
    ...turn,
    assistantText: normalizeAssistantText(turn.assistantText),
  }));
}

export function countUserPromptsInTranscript(transcriptPath: string): number {
  const seenPromptIds = new Set<string>();
  let count = 0;

  for (const entry of readAllTranscriptEntries(transcriptPath)) {
    if (!isCountedUserPrompt(entry)) {
      continue;
    }

    if (entry.promptId) {
      if (seenPromptIds.has(entry.promptId)) {
        continue;
      }

      seenPromptIds.add(entry.promptId);
      count += 1;
      continue;
    }

    if (extractUserPrompt(entry) !== "") {
      count += 1;
    }
  }

  return count;
}

export function extractAssistantResponse(
  transcriptPath: string,
  userPromptPrefix: string,
  promptNumber?: number,
): string {
  const turns = parseTranscript(transcriptPath);
  const turn =
    (promptNumber !== undefined
      ? turns.find((candidate) => candidate.promptNumber === promptNumber)
      : undefined) ??
    turns.find((candidate) => candidate.userPrompt.startsWith(userPromptPrefix));

  return turn?.assistantText ?? "";
}
