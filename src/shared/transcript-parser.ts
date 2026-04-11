import { existsSync, readFileSync } from "node:fs";

interface TranscriptContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
}

interface TranscriptEntry {
  type?: string;
  role?: string;
  content?: TranscriptContentBlock[] | string;
  promptId?: string;
  permissionMode?: string;
  isSidechain?: boolean;
  isApiErrorMessage?: boolean;
  uuid?: string;
}

interface TranscriptEntryWithLineNumber extends TranscriptEntry {
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
}

interface RawTranscriptEntry {
  type?: unknown;
  role?: unknown;
  content?: unknown;
  message?: unknown;
  promptId?: unknown;
  permissionMode?: unknown;
  isSidechain?: unknown;
  isApiErrorMessage?: unknown;
  uuid?: unknown;
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

    const entry = normalizeEntry(JSON.parse(trimmedLine) as RawTranscriptEntry);

    if (entry.isApiErrorMessage) {
      return;
    }

    entries.push({
      ...entry,
      lineNumber: index + 1,
    });
  });

  const seenUuids = new Set<string>();
  const deduped: TranscriptEntryWithLineNumber[] = [];

  for (const entry of entries) {
    if (entry.uuid) {
      if (seenUuids.has(entry.uuid)) {
        continue;
      }
      seenUuids.add(entry.uuid);
    }

    deduped.push(entry);
  }

  return deduped;
}

function normalizeEntry(raw: RawTranscriptEntry): TranscriptEntry {
  const message =
    raw.message && typeof raw.message === "object"
      ? (raw.message as { role?: unknown; content?: unknown })
      : undefined;

  return {
    type: typeof raw.type === "string" ? raw.type : undefined,
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
    permissionMode:
      typeof raw.permissionMode === "string" ? raw.permissionMode : undefined,
    isSidechain: Boolean(raw.isSidechain),
    isApiErrorMessage: Boolean(raw.isApiErrorMessage),
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

export function parseReplayTranscript(transcriptPath: string): ParsedReplayTurn[] {
  const turns: ParsedReplayTurn[] = [];
  let promptNumber = 0;
  let currentTurn: ParsedReplayTurn | null = null;
  let currentPromptId: string | null = null;

  for (const entry of readAllTranscriptEntries(transcriptPath)) {
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
