#!/usr/bin/env node
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/replay/cli.ts
var cli_exports = {};
__export(cli_exports, {
  runReplayParseCommand: () => runReplayParseCommand
});
module.exports = __toCommonJS(cli_exports);

// src/replay/commands/grep.ts
function truncate(text, preview) {
  if (preview === 0 || text.length <= preview) {
    return text;
  }
  return `${text.slice(0, Math.max(0, preview - 1))}\u2026`;
}
function matchesType(message, type) {
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
function includesPattern(value, pattern, ignoreCase = false) {
  if (ignoreCase) {
    return value.toLowerCase().includes(pattern.toLowerCase());
  }
  return value.includes(pattern);
}
function renderMatchedMessage(message, preview) {
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
function renderReplayGrep(result, pattern, options = {}) {
  const preview = options.preview ?? 120;
  const sections = [];
  let matchCount = 0;
  let turnCount = 0;
  for (const turn of result.turns) {
    const matchingMessages = turn.messages.filter(
      (message) => matchesType(message, options.type) && includesPattern(
        message.type === "tool_use" ? `${message.toolName ?? ""} ${message.content}` : message.content,
        pattern,
        options.ignoreCase
      )
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

// src/replay/commands/ls.ts
function truncate2(text, preview) {
  if (preview === 0 || text.length <= preview) {
    return text;
  }
  return `${text.slice(0, Math.max(0, preview - 1))}\u2026`;
}
function countToolStats(turn) {
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
function formatDuration(start, end) {
  const startDate = new Date(start);
  const endDate = new Date(end);
  const totalMinutes = Math.max(
    0,
    Math.round((endDate.getTime() - startDate.getTime()) / 6e4)
  );
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}
function formatBoundary(boundary) {
  const tokens = boundary.preTokens >= 1e6 ? `${Math.floor(boundary.preTokens / 1e5) / 10}M` : `${Math.floor(boundary.preTokens / 1e3)}k`;
  return `\u2500\u2500 compact (${tokens} tokens, ${boundary.trigger}) \u2500\u2500`;
}
function selectTurns(turns, options) {
  let selected = turns;
  if (options.grep) {
    selected = selected.filter((turn) => turn.userPrompt.includes(options.grep));
  }
  if (options.all) {
    return selected;
  }
  if (options.range) {
    return selected.filter(
      (turn) => turn.promptNumber >= options.range.start && turn.promptNumber <= options.range.end
    );
  }
  if (options.first) {
    return selected.slice(0, options.first);
  }
  return selected.slice(-1 * (options.last ?? 30));
}
function renderReplayLs(result, options = {}) {
  const preview = options.preview ?? 120;
  const selected = selectTurns(result.turns, options);
  const selectedPromptNumbers = new Set(selected.map((turn) => turn.promptNumber));
  const lines = [];
  if (result.timeRange) {
    lines.push(
      `${result.turns.length} turns | ${result.compacts.length} compacts | ${result.timeRange.start.slice(0, 16).replace("T", " ")} \u2192 ${result.timeRange.end.slice(11, 16)} (${formatDuration(result.timeRange.start, result.timeRange.end)})`
    );
    lines.push("");
  }
  for (const turn of selected) {
    const stats = countToolStats(turn);
    const statParts = [
      stats.tool > 0 ? `\u{1F527}${stats.tool}` : "",
      stats.read > 0 ? `\u{1F4D6}${stats.read}` : "",
      stats.write > 0 ? `\u270F\uFE0F${stats.write}` : ""
    ].filter(Boolean);
    const usageSuffix = options.usage ? `    in=${turn.usage.inputTokens} out=${turn.usage.outputTokens} cache=${turn.usage.cacheReadTokens}` : "";
    lines.push(
      `T${String(turn.promptNumber).padStart(3, " ")}  L${turn.lineStart}    ${turn.localTime}  ${statParts.join(" ")}${statParts.length > 0 ? "  " : ""}${truncate2(turn.userPrompt, preview)}${usageSuffix}`
    );
    for (const boundary of result.compacts) {
      if (boundary.afterPromptNumber === turn.promptNumber && selectedPromptNumbers.has(turn.promptNumber + 1)) {
        lines.push(formatBoundary(boundary));
      }
    }
  }
  return lines.join("\n");
}

// src/replay/commands/show.ts
function truncate3(text, preview, raw = false) {
  if (raw || preview === 0 || text.length <= preview) {
    return text;
  }
  return `${text.slice(0, Math.max(0, preview - 1))}\u2026`;
}
function formatToolInput(input) {
  if (!input) {
    return "";
  }
  return Object.entries(input).slice(0, 2).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(", ");
}
function renderMessage(message, options) {
  const preview = options.preview ?? 200;
  switch (message.type) {
    case "user":
      return ["USER:", truncate3(message.content, preview, options.raw), ""];
    case "assistant":
      return ["ASST:", truncate3(message.content, preview, options.raw), ""];
    case "thinking":
      if (!options.thinking) {
        return [];
      }
      return ["THINK:", truncate3(message.content, preview, options.raw), ""];
    case "tool_use":
      return [
        `TOOL: ${message.toolName}(${formatToolInput(message.toolInput)})`
      ];
    case "tool_result":
      return [
        options.noToolResult ? "  \u2192 (omitted)" : `  \u2192 ${truncate3(message.content, preview, options.raw)}`
      ];
  }
}
function renderUsage(turn) {
  return `usage: input=${turn.usage.inputTokens}  output=${turn.usage.outputTokens}  cache_read=${turn.usage.cacheReadTokens}`;
}
function renderReplayShow(result, promptNumber, options = {}) {
  const turn = result.turns.find((candidate) => candidate.promptNumber === promptNumber);
  if (!turn) {
    throw new Error(`Unknown turn T${promptNumber}`);
  }
  const lines = [
    `T${turn.promptNumber}  L${turn.lineStart}  ${turn.localTime}  duration=${turn.durationMs ? Math.round(turn.durationMs / 1e3) : 0}s  messages=${turn.messageCount ?? turn.messages.length}`,
    ""
  ];
  for (const message of turn.messages) {
    lines.push(...renderMessage(message, options));
  }
  lines.push(renderUsage(turn));
  return lines.join("\n");
}

// src/shared/transcript-parser.ts
var import_node_fs = require("node:fs");
function normalizeAssistantText(text) {
  return text.replace(/<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/g, "").replace(/\n{3,}/g, "\n\n").trim();
}
function getContentBlocks(entry) {
  return Array.isArray(entry.content) ? entry.content : [];
}
function extractUserPrompt(entry) {
  if (typeof entry.content === "string") {
    return entry.content.trim();
  }
  return getContentBlocks(entry).filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n").trim();
}
function isCountedUserPrompt(entry) {
  return entry.role === "user" && isRealUserPrompt(entry);
}
function isKnownSystemInjectedContent(content) {
  return content.startsWith("<task-notification>") || content.startsWith("<local-command-") || content.startsWith("<command-name>") || content.startsWith("<command-args>") || content.startsWith("<command-message>") || content.startsWith("\u23FA Ran ");
}
function isRealUserPrompt(entry) {
  const promptText = extractUserPrompt(entry);
  if (entry.permissionMode) {
    return true;
  }
  if (isKnownSystemInjectedContent(promptText)) {
    return false;
  }
  return promptText !== "";
}
function extractAssistantParts(entry) {
  const toolCalls = getContentBlocks(entry).filter((block) => block.type === "tool_use" && typeof block.name === "string").map((block) => ({
    name: block.name,
    input: block.input
  }));
  const assistantText = normalizeAssistantText(
    getContentBlocks(entry).filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n")
  );
  return { assistantText, toolCalls };
}
function stringifyToolResultContent(content) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (typeof item === "string") {
        return item;
      }
      if (item && typeof item === "object" && "text" in item) {
        const text = item.text;
        return typeof text === "string" ? text : JSON.stringify(item);
      }
      return JSON.stringify(item);
    }).join("\n");
  }
  if (content === void 0) {
    return "";
  }
  return JSON.stringify(content);
}
function readAllTranscriptEntries(transcriptPath) {
  if (!(0, import_node_fs.existsSync)(transcriptPath)) {
    return [];
  }
  const rawTranscript = (0, import_node_fs.readFileSync)(transcriptPath, "utf8");
  if (rawTranscript.trim() === "") {
    return [];
  }
  const entries = [];
  rawTranscript.split("\n").forEach((line, index) => {
    const trimmedLine = line.trim();
    if (!trimmedLine) {
      return;
    }
    let entry;
    try {
      entry = normalizeEntry(JSON.parse(trimmedLine));
    } catch {
      return;
    }
    if (entry.isApiErrorMessage) {
      return;
    }
    entries.push({
      ...entry,
      lineNumber: index + 1
    });
  });
  const seenUuids = /* @__PURE__ */ new Set();
  const deduped = [];
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
function normalizeEntry(raw) {
  const message = raw.message && typeof raw.message === "object" ? raw.message : void 0;
  return {
    type: typeof raw.type === "string" ? raw.type : void 0,
    subtype: typeof raw.subtype === "string" ? raw.subtype : void 0,
    role: typeof message?.role === "string" ? message.role : typeof raw.role === "string" ? raw.role : typeof raw.type === "string" ? raw.type : void 0,
    content: typeof message?.content === "string" || Array.isArray(message?.content) ? message.content : typeof raw.content === "string" || Array.isArray(raw.content) ? raw.content : void 0,
    promptId: typeof raw.promptId === "string" ? raw.promptId : void 0,
    uuid: typeof raw.uuid === "string" ? raw.uuid : void 0,
    parentUuid: typeof raw.parentUuid === "string" ? raw.parentUuid : void 0,
    timestamp: typeof raw.timestamp === "string" ? raw.timestamp : void 0,
    permissionMode: typeof raw.permissionMode === "string" ? raw.permissionMode : void 0,
    isSidechain: Boolean(raw.isSidechain),
    isApiErrorMessage: Boolean(raw.isApiErrorMessage),
    usage: message?.usage && typeof message.usage === "object" ? {
      inputTokens: typeof message.usage.input_tokens === "number" ? message.usage.input_tokens : void 0,
      outputTokens: typeof message.usage.output_tokens === "number" ? message.usage.output_tokens : void 0,
      cacheReadTokens: typeof message.usage.cache_read_input_tokens === "number" ? message.usage.cache_read_input_tokens : void 0,
      cacheCreationTokens: typeof message.usage.cache_creation_input_tokens === "number" ? message.usage.cache_creation_input_tokens : void 0
    } : void 0,
    durationMs: typeof raw.durationMs === "number" ? raw.durationMs : void 0,
    messageCount: typeof raw.messageCount === "number" ? raw.messageCount : void 0,
    compactMetadata: raw.compactMetadata && typeof raw.compactMetadata === "object" ? {
      trigger: typeof raw.compactMetadata.trigger === "string" ? raw.compactMetadata.trigger : void 0,
      preCompactTokenCount: typeof raw.compactMetadata.preCompactTokenCount === "number" ? raw.compactMetadata.preCompactTokenCount : void 0,
      pre_tokens: typeof raw.compactMetadata.pre_tokens === "number" ? raw.compactMetadata.pre_tokens : void 0
    } : void 0
  };
}
function startsNewTurn(entry, currentPromptId) {
  if (!isCountedUserPrompt(entry)) {
    return false;
  }
  if (entry.promptId) {
    return entry.promptId !== currentPromptId;
  }
  return extractUserPrompt(entry) !== "";
}
function parseReplayTranscript(transcriptPath, preloadedEntries) {
  const turns = [];
  let promptNumber = 0;
  let currentTurn = null;
  let currentPromptId = null;
  for (const entry of preloadedEntries ?? readAllTranscriptEntries(transcriptPath)) {
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
        isSidechain: Boolean(entry.isSidechain)
      };
      turns.push(currentTurn);
      continue;
    }
    if (entry.role === "user") {
      if (!currentTurn) {
        continue;
      }
      const unresolvedToolCalls = currentTurn.toolCalls.filter(
        (toolCall) => toolCall.result === ""
      );
      const toolResults = getContentBlocks(entry).filter((block) => block.type === "tool_result").map((block) => stringifyToolResultContent(block.content));
      for (let index = 0; index < unresolvedToolCalls.length; index += 1) {
        unresolvedToolCalls[index].result = toolResults[index] ?? "";
      }
      continue;
    }
    if (entry.role !== "assistant" || !currentTurn) {
      continue;
    }
    const { assistantText, toolCalls } = extractAssistantParts(entry);
    if (assistantText) {
      currentTurn.assistantText = currentTurn.assistantText ? `${currentTurn.assistantText}

${assistantText}` : assistantText;
    }
    currentTurn.toolCalls.push(
      ...toolCalls.map((toolCall) => ({
        ...toolCall,
        result: ""
      }))
    );
  }
  return turns.map((turn) => ({
    ...turn,
    assistantText: normalizeAssistantText(turn.assistantText)
  }));
}

// src/replay/parser.ts
function getContentBlocks2(entry) {
  return Array.isArray(entry.content) ? entry.content : [];
}
function extractUserPrompt2(entry) {
  if (typeof entry.content === "string") {
    return entry.content.trim();
  }
  return getContentBlocks2(entry).filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n").trim();
}
function stringifyContent(content) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (typeof item === "string") {
        return item;
      }
      if (item && typeof item === "object" && "text" in item) {
        const text = item.text;
        return typeof text === "string" ? text : JSON.stringify(item);
      }
      return JSON.stringify(item);
    }).join("\n");
  }
  if (content === void 0) {
    return "";
  }
  return JSON.stringify(content);
}
function formatLocalTime(timestamp) {
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
    hour12: false
  }).format(date);
}
function createEmptyUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0
  };
}
function mergeUsage(target, entry) {
  target.inputTokens += entry.usage?.inputTokens ?? 0;
  target.outputTokens += entry.usage?.outputTokens ?? 0;
  target.cacheReadTokens += entry.usage?.cacheReadTokens ?? 0;
  target.cacheCreationTokens += entry.usage?.cacheCreationTokens ?? 0;
}
function parseReplayFile(transcriptPath) {
  const entries = readAllTranscriptEntries(transcriptPath);
  const replayTurns = parseReplayTranscript(transcriptPath, entries);
  if (replayTurns.length === 0) {
    return {
      turns: [],
      compacts: [],
      timeRange: null
    };
  }
  const turns = replayTurns.map((turn) => ({
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
    usage: createEmptyUsage()
  }));
  const turnByPromptId = /* @__PURE__ */ new Map();
  const turnByLine = /* @__PURE__ */ new Map();
  for (const turn of turns) {
    if (turn.promptId) {
      turnByPromptId.set(turn.promptId, turn);
    }
    turnByLine.set(turn.lineStart, turn);
  }
  const compacts = [];
  let currentTurn = null;
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
        content: extractUserPrompt2(entry)
      });
      continue;
    }
    if (!currentTurn) {
      if (entry.subtype === "compact_boundary" && currentPromptNumber > 0) {
        compacts.push({
          afterPromptNumber: currentPromptNumber,
          line: entry.lineNumber,
          trigger: entry.compactMetadata?.trigger ?? "unknown",
          preTokens: entry.compactMetadata?.pre_tokens ?? entry.compactMetadata?.preCompactTokenCount ?? 0
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
        preTokens: entry.compactMetadata?.pre_tokens ?? entry.compactMetadata?.preCompactTokenCount ?? 0
      });
      continue;
    }
    if (entry.role === "assistant") {
      mergeUsage(currentTurn.usage, entry);
      for (const block of getContentBlocks2(entry)) {
        if (block.type === "thinking" && block.text) {
          currentTurn.messages.push({
            type: "thinking",
            line: entry.lineNumber,
            content: block.text
          });
          continue;
        }
        if (block.type === "text" && block.text?.trim()) {
          currentTurn.messages.push({
            type: "assistant",
            line: entry.lineNumber,
            content: normalizeAssistantText(block.text)
          });
          continue;
        }
        if (block.type === "tool_use" && typeof block.name === "string") {
          currentTurn.messages.push({
            type: "tool_use",
            line: entry.lineNumber,
            content: JSON.stringify(block.input ?? {}),
            toolName: block.name,
            toolInput: block.input && typeof block.input === "object" ? block.input : void 0
          });
        }
      }
      continue;
    }
    if (entry.role === "user") {
      const toolResultBlocks = getContentBlocks2(entry).filter(
        (block) => block.type === "tool_result"
      );
      for (const block of toolResultBlocks) {
        currentTurn.messages.push({
          type: "tool_result",
          line: entry.lineNumber,
          content: stringifyContent(block.content)
        });
      }
    }
  }
  return {
    turns,
    compacts,
    timeRange: {
      start: turns[0]?.timestamp ?? "",
      end: turns[turns.length - 1]?.timestamp ?? ""
    }
  };
}

// src/replay/cli.ts
function parseNumber(value, flag) {
  if (!value) {
    throw new Error(`Missing value for ${flag}`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid value for ${flag}: ${value}`);
  }
  return parsed;
}
function parseRange(value) {
  if (!value) {
    throw new Error("Missing value for --range");
  }
  const match = /^T(\d+)\.\.T(\d+)$/.exec(value);
  if (!match) {
    throw new Error(`Invalid range: ${value}`);
  }
  return {
    start: Number.parseInt(match[1], 10),
    end: Number.parseInt(match[2], 10)
  };
}
function runReplayParseCommand(argv) {
  const [subcommand, transcriptPath, ...rest] = argv;
  if (!subcommand || !transcriptPath) {
    throw new Error("Usage: replay-parse <ls|show|grep> <jsonl-path> ...");
  }
  const result = parseReplayFile(transcriptPath);
  if (subcommand === "ls") {
    const options = {};
    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index];
      if (token === "--all") {
        options.all = true;
      } else if (token === "--usage") {
        options.usage = true;
      } else if (token === "--last") {
        options.last = parseNumber(rest[++index], "--last");
      } else if (token === "--first") {
        options.first = parseNumber(rest[++index], "--first");
      } else if (token === "--range") {
        options.range = parseRange(rest[++index]);
      } else if (token === "--preview") {
        options.preview = parseNumber(rest[++index], "--preview");
      } else if (token === "--grep") {
        options.grep = rest[++index];
      }
    }
    return renderReplayLs(result, options);
  }
  if (subcommand === "show") {
    const turnToken = rest.shift();
    const match = /^T(\d+)$/.exec(turnToken ?? "");
    if (!match) {
      throw new Error("Usage: replay-parse show <jsonl> T<n> [options]");
    }
    const options = {};
    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index];
      if (token === "--no-tool-result") {
        options.noToolResult = true;
      } else if (token === "--thinking") {
        options.thinking = true;
      } else if (token === "--raw") {
        options.raw = true;
      } else if (token === "--preview") {
        options.preview = parseNumber(rest[++index], "--preview");
      }
    }
    return renderReplayShow(result, Number.parseInt(match[1], 10), options);
  }
  if (subcommand === "grep") {
    const pattern = rest.shift();
    if (!pattern) {
      throw new Error("Usage: replay-parse grep <jsonl> <pattern> [options]");
    }
    const options = {};
    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index];
      if (token === "--type") {
        options.type = rest[++index];
      } else if (token === "--context") {
        options.context = parseNumber(rest[++index], "--context");
      } else if (token === "--preview") {
        options.preview = parseNumber(rest[++index], "--preview");
      } else if (token === "-i") {
        options.ignoreCase = true;
      }
    }
    return renderReplayGrep(result, pattern, options);
  }
  throw new Error(`Unknown subcommand: ${subcommand}`);
}
function isDirectExecution() {
  const argv1 = process.argv[1] ?? "";
  return argv1.endsWith("/replay-parse.cjs") || argv1.endsWith("/cli.ts");
}
if (isDirectExecution()) {
  const output = runReplayParseCommand(process.argv.slice(2));
  process.stdout.write(`${output}
`);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  runReplayParseCommand
});
