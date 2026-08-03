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

// src/replay/fields.ts
var fieldRegistry = [
  {
    name: "promptNumber",
    type: "number",
    description: "Turn number (= recall/timeline T<n>)",
    extract: (turn) => turn.promptNumber
  },
  {
    name: "lineStart",
    type: "number",
    description: "JSONL 1-based line number",
    extract: (turn) => turn.lineStart
  },
  {
    name: "localTime",
    type: "string",
    description: "Local time HH:MM",
    defaultCap: 5,
    extract: (turn) => turn.localTime
  },
  {
    name: "timestamp",
    type: "string",
    description: "ISO timestamp",
    defaultCap: 120,
    extract: (turn) => turn.timestamp ?? ""
  },
  {
    name: "durationMs",
    type: "number",
    description: "Turn duration in ms",
    extract: (turn) => turn.durationMs ?? 0
  },
  {
    name: "userPrompt",
    type: "string",
    description: "Full user prompt text",
    defaultCap: 120,
    extract: (turn) => turn.userPrompt
  },
  {
    name: "assistantText",
    type: "string",
    description: "Assistant text blocks concatenated",
    defaultCap: 120,
    extract: (turn) => turn.assistantText
  },
  {
    name: "toolCount",
    type: "number",
    description: "Total tool_use calls",
    extract: (turn) => turn.toolCalls.length
  },
  {
    name: "readCount",
    type: "number",
    description: "Read tool calls",
    extract: (turn) => turn.toolCalls.filter((call) => call.name.toLowerCase() === "read").length
  },
  {
    name: "editCount",
    type: "number",
    description: "Edit/Write tool calls",
    extract: (turn) => turn.toolCalls.filter((call) => {
      const name = call.name.toLowerCase();
      return name === "edit" || name === "write";
    }).length
  },
  {
    name: "toolNames",
    type: "string",
    description: "Unique tool names (comma-sep)",
    defaultCap: 80,
    extract: (turn) => [...new Set(turn.toolCalls.map((call) => call.name))].join(",")
  },
  {
    name: "usage.input",
    type: "number",
    description: "Input tokens",
    extract: (turn) => turn.usage.inputTokens
  },
  {
    name: "usage.output",
    type: "number",
    description: "Output tokens",
    extract: (turn) => turn.usage.outputTokens
  },
  {
    name: "usage.cacheRead",
    type: "number",
    description: "Cache read tokens",
    extract: (turn) => turn.usage.cacheReadTokens
  },
  {
    name: "usage.cacheCr",
    type: "number",
    description: "Cache creation tokens",
    extract: (turn) => turn.usage.cacheCreationTokens
  },
  {
    name: "messageCount",
    type: "number",
    description: "Raw message count in turn",
    extract: (turn) => turn.messages.length
  },
  {
    name: "compactAfter",
    type: "number",
    description: "1 if compact follows this turn, 0 otherwise",
    extract: (turn, ctx) => ctx.compactAfterSet.has(turn.promptNumber) ? 1 : 0
  },
  {
    name: "compactInfo",
    type: "string",
    description: "Compact metadata or empty",
    defaultCap: 60,
    extract: (turn, ctx) => ctx.compactInfoMap.get(turn.promptNumber) ?? ""
  }
];
var fieldByName = new Map(fieldRegistry.map((field) => [field.name, field]));
function getFieldRegistry() {
  return fieldRegistry;
}
function getFieldContext(result) {
  const compactAfterSet = /* @__PURE__ */ new Set();
  const compactInfoMap = /* @__PURE__ */ new Map();
  for (const compact of result.compacts) {
    compactAfterSet.add(compact.afterPromptNumber);
    compactInfoMap.set(
      compact.afterPromptNumber,
      `${formatCompactTokens(compact.preTokens)} tokens, ${compact.trigger}`
    );
  }
  return { compactAfterSet, compactInfoMap };
}
function parseFieldSpec(spec) {
  const tokens = spec.split(",").map((token) => token.trim()).filter(Boolean);
  if (tokens.length === 0) {
    throw new Error('Usage: replay-parse query <jsonl> -f "field[:cap],..."');
  }
  return tokens.map((token) => {
    const [name, capSpec] = token.split(":", 2);
    const field = fieldByName.get(name);
    if (!field) {
      throw new Error(`Unknown field: ${name}`);
    }
    if (capSpec === void 0) {
      return {
        def: field,
        cap: field.type === "string" ? field.defaultCap ?? null : null
      };
    }
    const cap = Number.parseInt(capSpec, 10);
    if (!Number.isInteger(cap) || cap < 0) {
      throw new Error(`Invalid cap for ${name}: ${capSpec}`);
    }
    return {
      def: field,
      cap: cap === 0 ? null : cap
    };
  });
}
function renderQueryCell(value, cap) {
  if (typeof value === "number") {
    return String(value);
  }
  const escaped = escapeTsvString(value);
  if (cap === null || escaped.length <= cap) {
    return escaped;
  }
  return `${escaped.slice(0, Math.max(0, cap - 1))}\u2026`;
}
function escapeTsvString(value) {
  return value.replaceAll("\n", "\\n").replaceAll("	", "\\t");
}
function formatCompactTokens(preTokens) {
  if (preTokens >= 1e6) {
    return `${Math.floor(preTokens / 1e5) / 10}M`;
  }
  return `${Math.floor(preTokens / 1e3)}k`;
}
function filterReplayTurns(result, options) {
  let turns = result.turns;
  if (options.grep) {
    turns = turns.filter((turn) => matchesGrep(turn, options.grep, options.ignoreCase ?? false));
  }
  if (options.all) {
    return turns;
  }
  if (options.range) {
    return turns.filter(
      (turn) => turn.promptNumber >= options.range.start && turn.promptNumber <= options.range.end
    );
  }
  if (options.first !== void 0) {
    return turns.slice(0, options.first);
  }
  return turns.slice(-1 * (options.last ?? 30));
}
function matchesGrep(turn, pattern, ignoreCase) {
  const haystack = buildSearchText(turn);
  return ignoreCase ? haystack.toLowerCase().includes(pattern.toLowerCase()) : haystack.includes(pattern);
}
function buildSearchText(turn) {
  const toolCallText = turn.toolCalls.map((call) => `${call.name}
${JSON.stringify(call.input ?? {})}
${call.result ?? ""}`).join("\n");
  return [
    turn.userPrompt,
    turn.assistantText,
    toolCallText
  ].join("\n");
}

// src/replay/commands/query.ts
function renderReplayQuery(result, options = {}) {
  const fields = parseFieldSpec(options.fields ?? "");
  const turns = filterReplayTurns(result, options);
  const context = getFieldContext(result);
  const lines = [fields.map((field) => field.def.name).join("	")];
  for (const turn of turns) {
    lines.push(
      fields.map((field) => renderQueryCell(field.def.extract(turn, context), field.cap)).join("	")
    );
  }
  return lines.join("\n");
}

// src/replay/commands/schema.ts
function truncateSample(value, limit) {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, Math.max(0, limit - 1))}\u2026`;
}
function formatSampleValue(value) {
  if (value === null || value === void 0) {
    return `""`;
  }
  if (typeof value === "number") {
    return String(value);
  }
  return JSON.stringify(truncateSample(value, 60));
}
function formatTimeRange(result) {
  if (!result.timeRange) {
    return "(empty file)";
  }
  const start = result.timeRange.start.slice(0, 16).replace("T", " ");
  const end = result.timeRange.end.slice(11, 16);
  return `${start} \u2192 ${end}`;
}
function renderReplaySchema(result) {
  const lines = [];
  lines.push(
    `${result.turns.length} turns | ${result.compacts.length} compacts | ${formatTimeRange(result)}`
  );
  lines.push("");
  lines.push("Fields:");
  const sampleTurns = result.turns.slice(0, 3);
  const context = getFieldContext(result);
  for (const field of getFieldRegistry()) {
    const samples = sampleTurns.map((turn) => formatSampleValue(field.extract(turn, context)));
    const sampleText = samples.length > 0 ? samples.join(", ") : "(empty file)";
    lines.push(
      `  ${field.name.padEnd(15)} ${field.type.padEnd(6)} ${sampleText.padEnd(35)} ${field.description}`
    );
  }
  lines.push("");
  lines.push('Usage: replay-parse query <jsonl> -f "promptNumber,localTime,userPrompt:80" --last 10');
  return lines.join("\n");
}

// src/replay/format.ts
function truncateText(text, preview, raw = false) {
  if (raw || preview === 0 || text.length <= preview) {
    return text;
  }
  return `${text.slice(0, Math.max(0, preview - 1))}\u2026`;
}
function truncateJsonValue(value, preview = 60) {
  const stringified = JSON.stringify(value);
  if (stringified.length <= preview) {
    return stringified;
  }
  if (preview >= 4 && stringified.startsWith('"') && stringified.endsWith('"')) {
    const inner = stringified.slice(1, -1);
    return `"${inner.slice(0, preview - 3)}\u2026"`;
  }
  return truncateText(stringified, preview);
}

// src/replay/commands/show.ts
function formatToolInput(input) {
  if (!input) {
    return "";
  }
  return Object.entries(input).slice(0, 2).map(([key, value]) => `${key}=${truncateJsonValue(value, 60)}`).join(", ");
}
function renderMessage(message, options) {
  const preview = options.preview ?? 200;
  switch (message.type) {
    case "user":
      return ["USER:", truncateText(message.content, preview, options.raw), ""];
    case "assistant":
      return ["ASST:", truncateText(message.content, preview, options.raw), ""];
    case "thinking":
      if (!options.thinking) {
        return [];
      }
      return ["THINK:", truncateText(message.content, preview, options.raw), ""];
    case "tool_use":
      return [
        `TOOL: ${message.toolName}(${formatToolInput(message.toolInput)})`
      ];
    case "tool_result":
      return [
        options.noToolResult ? "  \u2192 (omitted)" : `  \u2192 ${truncateText(message.content, preview, options.raw)}`
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
function getFirstTextContent(entry) {
  if (typeof entry.content === "string") {
    return entry.content.trim();
  }
  const textBlock = getContentBlocks(entry).find((block) => block.type === "text");
  return typeof textBlock?.text === "string" ? textBlock.text.trim() : "";
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
function isInterruptedUserMarker(entry) {
  return entry.role === "user" && getFirstTextContent(entry).startsWith("[Request interrupted by user");
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
function collectInterruptedPromptIds(entries) {
  const interruptedPromptIds = /* @__PURE__ */ new Set();
  for (const entry of entries) {
    if (entry.promptId && isInterruptedUserMarker(entry)) {
      interruptedPromptIds.add(entry.promptId);
    }
  }
  return interruptedPromptIds;
}
function parseTranscriptLineWindow(lines, firstLineNumber) {
  const entries = [];
  lines.forEach((line, index) => {
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
      lineNumber: firstLineNumber + index
    });
  });
  return entries;
}
function dedupeTranscriptEntries(entries) {
  const uuidToIndex = /* @__PURE__ */ new Map();
  const deduped = [];
  for (const entry of entries) {
    if (entry.uuid) {
      const existingIndex = uuidToIndex.get(entry.uuid);
      if (existingIndex !== void 0) {
        deduped[existingIndex] = mergeTranscriptEntries(
          deduped[existingIndex],
          entry
        );
        continue;
      }
      uuidToIndex.set(entry.uuid, deduped.length);
    }
    deduped.push(entry);
  }
  return deduped;
}
function readAllTranscriptEntries(transcriptPath) {
  if (!(0, import_node_fs.existsSync)(transcriptPath)) {
    return [];
  }
  const rawTranscript = (0, import_node_fs.readFileSync)(transcriptPath, "utf8");
  if (rawTranscript.trim() === "") {
    return [];
  }
  return dedupeTranscriptEntries(
    parseTranscriptLineWindow(rawTranscript.split("\n"), 1)
  );
}
function mergeUsage(first, later) {
  if (!first && !later) {
    return void 0;
  }
  return {
    inputTokens: later?.inputTokens ?? first?.inputTokens,
    outputTokens: later?.outputTokens ?? first?.outputTokens,
    cacheReadTokens: later?.cacheReadTokens ?? first?.cacheReadTokens,
    cacheCreationTokens: later?.cacheCreationTokens ?? first?.cacheCreationTokens
  };
}
function mergeCompactMetadata(first, later) {
  if (!first && !later) {
    return void 0;
  }
  return {
    trigger: later?.trigger ?? first?.trigger,
    preCompactTokenCount: later?.preCompactTokenCount ?? first?.preCompactTokenCount,
    pre_tokens: later?.pre_tokens ?? first?.pre_tokens
  };
}
function mergeTranscriptEntries(first, later) {
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
    logicalParentUuid: later.logicalParentUuid ?? first.logicalParentUuid,
    timestamp: first.timestamp ?? later.timestamp,
    usage: mergeUsage(first.usage, later.usage),
    durationMs: later.durationMs ?? first.durationMs,
    messageCount: later.messageCount ?? first.messageCount,
    compactMetadata: mergeCompactMetadata(
      first.compactMetadata,
      later.compactMetadata
    ),
    lineNumber: first.lineNumber
  };
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
    logicalParentUuid: typeof raw.logicalParentUuid === "string" ? raw.logicalParentUuid : void 0,
    timestamp: typeof raw.timestamp === "string" ? raw.timestamp : void 0,
    permissionMode: typeof raw.permissionMode === "string" ? raw.permissionMode : void 0,
    // Preserve "absent" as undefined rather than false. The last-wins merge keeps
    // an earlier true flag only because mergeTranscriptEntries uses ??.
    isSidechain: typeof raw.isSidechain === "boolean" ? raw.isSidechain : void 0,
    isApiErrorMessage: typeof raw.isApiErrorMessage === "boolean" ? raw.isApiErrorMessage : void 0,
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
  const entries = preloadedEntries ?? readAllTranscriptEntries(transcriptPath);
  const interruptedPromptIds = collectInterruptedPromptIds(entries);
  let promptNumber = 0;
  let currentTurn = null;
  let currentPromptId = null;
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
        wasInterrupted: entry.promptId !== void 0 && interruptedPromptIds.has(entry.promptId)
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
function mergeUsage2(target, entry) {
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
      mergeUsage2(currentTurn.usage, entry);
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
    throw new Error("Usage: replay-parse <schema|query|show> <jsonl-path> ...");
  }
  const result = parseReplayFile(transcriptPath);
  if (subcommand === "schema") {
    return renderReplaySchema(result);
  }
  if (subcommand === "query") {
    const options = {};
    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index];
      if (token === "-f") {
        options.fields = rest[++index];
      } else if (token === "--all") {
        options.all = true;
      } else if (token === "--last") {
        options.last = parseNumber(rest[++index], "--last");
      } else if (token === "--first") {
        options.first = parseNumber(rest[++index], "--first");
      } else if (token === "--range") {
        options.range = parseRange(rest[++index]);
      } else if (token === "--grep") {
        options.grep = rest[++index];
      } else if (token === "-i") {
        options.ignoreCase = true;
      }
    }
    return renderReplayQuery(result, options);
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
