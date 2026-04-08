import { existsSync, readFileSync } from "node:fs";

interface TranscriptContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
}

interface TranscriptEntry {
  role?: string;
  content?: TranscriptContentBlock[];
  isSidechain?: boolean;
  isApiErrorMessage?: boolean;
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
  userPrompt: string;
  assistantText: string;
  toolCalls: ReplayToolCall[];
  isSidechain: boolean;
}

function normalizeAssistantText(text: string): string {
  return text
    .replace(/<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function getContentBlocks(entry: TranscriptEntry): TranscriptContentBlock[] {
  return Array.isArray(entry.content) ? entry.content : [];
}

function extractUserPrompt(entry: TranscriptEntry): string {
  return getContentBlocks(entry)
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n")
    .trim();
}

function isCountedUserPrompt(entry: TranscriptEntry): boolean {
  return entry.role === "user" && extractUserPrompt(entry) !== "";
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

export function readAllTranscriptEntries(transcriptPath: string): TranscriptEntry[] {
  if (!existsSync(transcriptPath)) {
    return [];
  }

  const rawTranscript = readFileSync(transcriptPath, "utf8");

  if (rawTranscript.trim() === "") {
    return [];
  }

  return rawTranscript
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TranscriptEntry)
    .filter((entry) => !entry.isApiErrorMessage);
}

export function parseTranscript(transcriptPath: string): ParsedTurn[] {
  const turns: ParsedTurn[] = [];
  let promptNumber = 0;
  let currentTurn: ParsedTurn | null = null;

  for (const entry of readTranscriptEntries(transcriptPath)) {
    if (isCountedUserPrompt(entry)) {
      const userPrompt = extractUserPrompt(entry);

      promptNumber += 1;
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

  for (const entry of readAllTranscriptEntries(transcriptPath)) {
    if (isCountedUserPrompt(entry)) {
      const userPrompt = extractUserPrompt(entry);

      promptNumber += 1;
      currentTurn = {
        promptNumber,
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
  let count = 0;

  for (const entry of readAllTranscriptEntries(transcriptPath)) {
    if (isCountedUserPrompt(entry)) {
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
