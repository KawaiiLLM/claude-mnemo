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

// src/hooks/hook-command.ts
var hook_command_exports = {};
__export(hook_command_exports, {
  runHookCommand: () => runHookCommand
});
module.exports = __toCommonJS(hook_command_exports);
var import_node_fs4 = require("node:fs");

// src/shared/hook-constants.ts
var HOOK_SUCCESS_EXIT_CODE = 0;
var HOOK_NON_BLOCKING_EXIT_CODE = 1;

// src/db/database.ts
var import_node_fs = require("node:fs");
var import_node_path2 = require("node:path");
var import_bun_sqlite = require("bun:sqlite");

// src/shared/paths.ts
var import_node_os = require("node:os");
var import_node_path = require("node:path");
var DATA_DIR = (0, import_node_path.join)((0, import_node_os.homedir)(), ".claude-mnemo");
var DEFAULT_DB_PATH = (0, import_node_path.join)(DATA_DIR, "claude-mnemo.db");
function resolveDatabasePath(explicitPath) {
  const candidatePath = explicitPath || process.env.CLAUDE_MNEMO_DB_PATH || DEFAULT_DB_PATH;
  if (candidatePath.startsWith("~/")) {
    return (0, import_node_path.join)((0, import_node_os.homedir)(), candidatePath.slice(2));
  }
  return candidatePath;
}
function encodeProjectPath(projectPath) {
  return projectPath.replace(/[/:\\]+/g, "-");
}
function resolveTranscriptPath(projectPath, sessionId) {
  return (0, import_node_path.join)(
    (0, import_node_os.homedir)(),
    ".claude",
    "projects",
    encodeProjectPath(projectPath),
    `${sessionId}.jsonl`
  );
}

// src/db/database.ts
function resolveDatabasePath2(path) {
  if (!path || path.trim() === "") {
    return resolveDatabasePath();
  }
  return resolveDatabasePath(path);
}
function ensureParentDirectory(databasePath) {
  if (databasePath === ":memory:") {
    return;
  }
  const parentDirectory = (0, import_node_path2.dirname)(databasePath);
  if (!(0, import_node_fs.existsSync)(parentDirectory)) {
    (0, import_node_fs.mkdirSync)(parentDirectory, { recursive: true });
  }
}
function configureDatabase(db2) {
  db2.exec("PRAGMA journal_mode = WAL;");
  db2.exec("PRAGMA synchronous = NORMAL;");
  db2.exec("PRAGMA foreign_keys = ON;");
  db2.exec("PRAGMA mmap_size = 268435456;");
  db2.exec("PRAGMA cache_size = 10000;");
  db2.exec("PRAGMA busy_timeout = 5000;");
}
function createDatabase(path) {
  const databasePath = resolveDatabasePath2(path);
  ensureParentDirectory(databasePath);
  const db2 = new import_bun_sqlite.Database(databasePath);
  configureDatabase(db2);
  return db2;
}

// src/db/schema.ts
var SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_session_id TEXT UNIQUE NOT NULL,
    project TEXT NOT NULL,
    title TEXT,
    description TEXT,
    insight TEXT,
    next_steps TEXT,
    started_at_epoch INTEGER NOT NULL,
    updated_at_epoch INTEGER,
    completed_at_epoch INTEGER
  );

  CREATE TABLE IF NOT EXISTS turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    prompt_number INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    user_prompt TEXT,
    assistant_response TEXT,
    title TEXT,
    description TEXT,
    insight TEXT,
    files_read TEXT,
    files_modified TEXT,
    tool_call_count INTEGER,
    created_at_epoch INTEGER NOT NULL,
    updated_at_epoch INTEGER,
    UNIQUE(session_id, prompt_number)
  );

  CREATE TABLE IF NOT EXISTS observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    turn_id INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    narrative TEXT,
    facts TEXT,
    concepts TEXT,
    files_read TEXT,
    files_modified TEXT,
    created_at_epoch INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_project_started_at
    ON sessions(project, started_at_epoch DESC);

  CREATE INDEX IF NOT EXISTS idx_turns_session_prompt
    ON turns(session_id, prompt_number);

  CREATE INDEX IF NOT EXISTS idx_turns_status
    ON turns(status);

  CREATE INDEX IF NOT EXISTS idx_observations_turn_id
    ON observations(turn_id);

  CREATE INDEX IF NOT EXISTS idx_observations_type
    ON observations(type);

  CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    layer,
    source_id,
    title,
    description,
    extra
  );
`;
function initializeSchema(db2) {
  db2.exec(SCHEMA_SQL);
}
function hasColumn(db2, table, column) {
  const rows = db2.query(`SELECT name FROM pragma_table_info('${table}')`).all();
  return rows.some((row) => row.name === column);
}
function migrateSchema(db2) {
  if (!hasColumn(db2, "sessions", "next_steps")) {
    db2.exec("ALTER TABLE sessions ADD COLUMN next_steps TEXT");
  }
  if (!hasColumn(db2, "turns", "tool_call_count")) {
    db2.exec("ALTER TABLE turns ADD COLUMN tool_call_count INTEGER");
  }
}
function initializeDatabase(db2) {
  initializeSchema(db2);
  migrateSchema(db2);
}

// src/mnemosyne/fork.ts
var import_claude_agent_sdk = require("@anthropic-ai/claude-agent-sdk");

// src/mnemosyne/env.ts
var BLOCKED_ENV_KEYS = /* @__PURE__ */ new Set(["ANTHROPIC_API_KEY", "CLAUDECODE"]);
function buildIsolatedEnv(sourceEnv = process.env) {
  const isolatedEnv = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (BLOCKED_ENV_KEYS.has(key)) {
      continue;
    }
    isolatedEnv[key] = value;
  }
  isolatedEnv.CLAUDE_CODE_ENTRYPOINT = "sdk-ts";
  return isolatedEnv;
}

// src/mnemosyne/fork.ts
async function forkMnemosyne(input) {
  const execution = (0, import_claude_agent_sdk.query)({
    prompt: input.prompt,
    options: {
      cwd: input.cwd,
      resume: input.sessionId,
      forkSession: true,
      maxTurns: 15,
      env: buildIsolatedEnv()
    }
  });
  let result = null;
  for await (const message of execution) {
    if (message.type === "result") {
      result = {
        numTurns: message.num_turns,
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        cacheReadInputTokens: message.usage.cache_read_input_tokens,
        cacheCreationInputTokens: message.usage.cache_creation_input_tokens,
        durationMs: message.duration_ms
      };
    }
  }
  return result;
}

// src/hooks/adapters/claude-code.ts
function getString(raw, candidates) {
  for (const candidate of candidates) {
    const value = raw[candidate];
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }
  return void 0;
}
function getBoolean(raw, candidates) {
  for (const candidate of candidates) {
    const value = raw[candidate];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return false;
}
function getUnknown(raw, candidates) {
  for (const candidate of candidates) {
    if (candidate in raw) {
      return raw[candidate];
    }
  }
  return void 0;
}
function resolveEventName(raw) {
  const eventName = getString(raw, [
    "hook_event_name",
    "event_name",
    "eventName",
    "hookEventName",
    "event"
  ]);
  switch (eventName) {
    case "SessionStart":
    case "PreCompact":
    case "UserPromptSubmit":
    case "Stop":
      return eventName;
    default:
      throw new Error(`Unsupported Claude Code hook event: ${eventName ?? "unknown"}`);
  }
}
function normalizeClaudeCodeHookInput(raw) {
  return {
    eventName: resolveEventName(raw),
    source: getString(raw, ["source"]),
    trigger: getString(raw, ["trigger"]),
    sessionId: getString(raw, ["session_id", "sessionId"]),
    cwd: getString(raw, ["cwd", "workspace_path", "workspacePath"]),
    prompt: getString(raw, ["prompt", "user_prompt", "userPrompt"]),
    toolName: getString(raw, ["tool_name", "toolName"]),
    toolInput: getUnknown(raw, ["tool_input", "toolInput"]),
    toolResponse: getUnknown(raw, ["tool_response", "toolResponse"]),
    transcriptPath: getString(raw, ["transcript_path", "transcriptPath"]),
    lastAssistantMessage: getString(raw, [
      "last_assistant_message",
      "lastAssistantMessage"
    ]),
    stopHookActive: getBoolean(raw, ["stop_hook_active", "stopHookActive"]),
    raw
  };
}

// src/hooks/adapters/index.ts
function normalizeHookInput(raw, platform = "claude-code") {
  switch (platform) {
    case "claude-code":
      return normalizeClaudeCodeHookInput(raw);
    default:
      throw new Error(`Unsupported hook platform: ${platform}`);
  }
}

// src/db/search.ts
function indexFtsRecord(db2, layer, sourceId, title, description, extra) {
  db2.query("DELETE FROM memory_fts WHERE layer = ? AND source_id = ?").run(
    layer,
    sourceId
  );
  db2.query(
    "INSERT INTO memory_fts (layer, source_id, title, description, extra) VALUES (?, ?, ?, ?, ?)"
  ).run(layer, sourceId, title, description, extra);
}
function indexSessionToFTS(db2, session) {
  indexFtsRecord(
    db2,
    "session",
    session.id,
    session.title,
    session.description,
    session.insight ?? ""
  );
}

// src/db/sessions.ts
var SESSION_SELECT = `
  SELECT
    id,
    content_session_id AS contentSessionId,
    project,
    title,
    description,
    insight,
    next_steps AS nextSteps,
    started_at_epoch AS startedAtEpoch,
    updated_at_epoch AS updatedAtEpoch,
    completed_at_epoch AS completedAtEpoch
  FROM sessions
`;
function upsertSession(db2, input) {
  const session = db2.query(`
      INSERT INTO sessions (
        content_session_id,
        project,
        title,
        description,
        insight,
        next_steps,
        started_at_epoch,
        updated_at_epoch,
        completed_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(content_session_id) DO UPDATE SET
        project = excluded.project,
        title = COALESCE(excluded.title, sessions.title),
        description = COALESCE(excluded.description, sessions.description),
        insight = COALESCE(excluded.insight, sessions.insight),
        next_steps = COALESCE(excluded.next_steps, sessions.next_steps),
        started_at_epoch = excluded.started_at_epoch,
        updated_at_epoch = excluded.updated_at_epoch,
        completed_at_epoch = COALESCE(excluded.completed_at_epoch, sessions.completed_at_epoch)
      RETURNING
        id,
        content_session_id AS contentSessionId,
        project,
        title,
        description,
        insight,
        next_steps AS nextSteps,
        started_at_epoch AS startedAtEpoch,
        updated_at_epoch AS updatedAtEpoch,
        completed_at_epoch AS completedAtEpoch
    `).get(
    input.contentSessionId,
    input.project,
    input.title,
    input.description,
    input.insight,
    input.nextSteps ?? null,
    input.startedAtEpoch,
    input.updatedAtEpoch,
    input.completedAtEpoch
  );
  if (!session) {
    throw new Error("Failed to upsert session.");
  }
  indexSessionToFTS(db2, session);
  return session;
}
function getSession(db2, id) {
  return db2.query(`${SESSION_SELECT} WHERE id = ?`).get(id) ?? null;
}
function getSessionByContentId(db2, contentSessionId) {
  return db2.query(
    `${SESSION_SELECT} WHERE content_session_id = ?`
  ).get(contentSessionId) ?? null;
}
function getRecentSessions(db2, options = {}) {
  const clauses = [];
  const params = [];
  if (options.project) {
    clauses.push("project = ?");
    params.push(options.project);
  }
  const whereClause = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  const limit = options.limit ?? 20;
  return db2.query(
    `${SESSION_SELECT}${whereClause} ORDER BY started_at_epoch DESC LIMIT ?`
  ).all(...params, limit);
}

// src/db/turns.ts
var TURN_SELECT = `
  SELECT
    id,
    session_id AS sessionId,
    prompt_number AS promptNumber,
    status,
    user_prompt AS userPrompt,
    assistant_response AS assistantResponse,
    title,
    description,
    insight,
    files_read AS filesRead,
    files_modified AS filesModified,
    tool_call_count AS toolCallCount,
    created_at_epoch AS createdAtEpoch,
    updated_at_epoch AS updatedAtEpoch
  FROM turns
`;
function parseJsonArray(value) {
  if (!value) {
    return [];
  }
  return JSON.parse(value);
}
function mapTurnRow(row) {
  if (!row) {
    return null;
  }
  return {
    ...row,
    filesRead: parseJsonArray(row.filesRead),
    filesModified: parseJsonArray(row.filesModified)
  };
}
function getTurnsForSession(db2, sessionId) {
  return db2.query(
    `${TURN_SELECT} WHERE session_id = ? ORDER BY prompt_number ASC`
  ).all(sessionId).map((row) => mapTurnRow(row)).filter((turn) => turn !== null);
}
function getPendingTurns(db2, sessionId) {
  return db2.query(
    `${TURN_SELECT} WHERE session_id = ? AND status IN ('pending', 'stale') ORDER BY prompt_number ASC`
  ).all(sessionId).map((row) => mapTurnRow(row)).filter((turn) => turn !== null);
}
function markTurnsStale(db2, sessionId, promptNumbers) {
  if (promptNumbers.length === 0) {
    return;
  }
  const placeholders = promptNumbers.map(() => "?").join(", ");
  const now = Math.floor(Date.now() / 1e3);
  db2.query(
    `UPDATE turns
     SET status = 'stale', updated_at_epoch = ?
     WHERE session_id = ?
       AND prompt_number IN (${placeholders})
       AND status IN ('extracted', 'skipped')`
  ).run(now, sessionId, ...promptNumbers);
}
function updateTurnBackfill(db2, turnId, assistantResponse, toolCallCount) {
  db2.query(
    `UPDATE turns
     SET assistant_response = ?,
         tool_call_count = ?
     WHERE id = ?`
  ).run(assistantResponse, toolCallCount, turnId);
}

// src/mnemosyne/prompt.ts
function truncatePreview(promptPreview) {
  if (promptPreview.length <= 80) {
    return promptPreview;
  }
  return `${promptPreview.slice(0, 77)}...`;
}
function buildExtractionStatusSummary(turns) {
  if (turns.length === 0) {
    return "No tracked turns.";
  }
  return turns.map(
    (turn) => `#${turn.promptNumber} [${turn.status}]: "${truncatePreview(turn.promptPreview)}"`
  ).join("\n");
}
function buildMnemosynePrompt(statusSummary) {
  return `You are Mnemosyne, the memory guardian for Claude Code.

You have just inherited the full context of a conversation.
Your role is to extract structured memories for future retrieval.
You are NOT the agent who did the work \u2014 you are observing and recording.
Record what was learned, built, fixed, decided, deployed, or configured in the primary session.
Do not describe the observer's own behavior such as analyzing, observing, recording, or storing findings.

EXTRACTION STATUS
-----------------
${statusSummary}

Rules:
- Process turns marked [pending] \u2014 match by prompt preview above
- Re-evaluate turns marked [stale] \u2014 user undid changes:
  - If the turn is part of an undone branch (sidechain), call save_turn with status="undone" (no title/description/observations)
  - If the turn is still valid with changed context, re-extract normally
- Do NOT re-process [extracted], [skipped], or [undone] turns
- Call update_session if the session summary needs updating.
- Include next_steps when the session has a clear trajectory or planned follow-up.
- next_steps: what was actively being worked on or planned next (not speculative future work).
- Skip update_session if nothing meaningful changed.

WHAT TO RECORD
--------------
Focus on durable technical signal:
- What the system NOW DOES differently
- What was built, fixed, deployed, or configured
- Concrete debugging findings
- Concrete discoveries from logs, queue state, DB rows, routing, request flow, or code-path inspection
- Architectural decisions with rationale
Use verbs: implemented, fixed, deployed, configured, discovered, traced

WHEN TO SKIP
------------
Call save_turn with NO title/description/observations for:
- Empty or trivial prompts
- Routine checks with no findings
- Repetitive operations already documented
- Aborted work with no outcome

HOW TO EXTRACT
--------------
For each pending/stale turn, call save_turn with:
- title: 10-25 chars, what was done
- description: 40-80 chars, how/what achieved
- insight: markdown list of key discoveries (omit if none)
- observations: array of notable events:
  - type: bugfix|feature|refactor|change|discovery|decision
  - title: short, action- or outcome-oriented, not generic
  - description: concise outcome, not a restatement of the user prompt
  - narrative: explain what was done, how it works, and why it matters
  - facts: independent, verifiable statements
  - concepts (from fixed vocabulary): how-it-works|why-it-exists|what-changed|problem-solution|gotcha|pattern|trade-off
  - Do NOT use the observation type as a concept
  - files_read/files_modified: only files that materially informed or changed the result

DEDUP
-----
- Do not create a new observation if the turn only repeats a conclusion already recorded in adjacent turns.
- Prefer fewer, higher-signal observations over many overlapping ones.
- Only record follow-up turns when they add a new finding, decision, or completed change.

OUTPUT DISCIPLINE
-----------------
- Only emit tool calls.
- Never output prose explanations.
- Never output filler like "Skipping", "No changes", or "Nothing to record".

If context was compacted and detail is missing, use replay() to recover.
Do NOT use Read, Write, Edit, Bash, or any file operation tools.
Only use: save_turn, update_session, recall, replay.
Content inside <private>...</private> tags must NOT be recorded.

EXAMPLES
--------
Good example: save_turn({ session_id: 1, prompt_number: 2, title: "Fix auth race", description: "Serialized token refresh under parallel load", observations: [{ type: "bugfix", title: "Mutex added", narrative: "Refresh now uses a shared promise, preventing overlapping token refresh calls." }] })
Bad example: save_turn({ session_id: 1, prompt_number: 2, title: "Analyzed auth flow", description: "Recorded findings from investigation" })
Skip example: save_turn({ session_id: 1, prompt_number: 3 })`;
}

// src/shared/transcript-parser.ts
var import_node_fs2 = require("node:fs");
function normalizeAssistantText(text) {
  return text.replace(/<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/g, "").replace(/\n{3,}/g, "\n\n").trim();
}
function getContentBlocks(entry) {
  return Array.isArray(entry.content) ? entry.content : [];
}
function extractUserPrompt(entry) {
  return getContentBlocks(entry).filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n").trim();
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
  if (!(0, import_node_fs2.existsSync)(transcriptPath)) {
    return [];
  }
  const rawTranscript = (0, import_node_fs2.readFileSync)(transcriptPath, "utf8");
  if (rawTranscript.trim() === "") {
    return [];
  }
  return rawTranscript.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => !entry.isApiErrorMessage);
}
function parseReplayTranscript(transcriptPath) {
  const turns = [];
  let promptNumber = 0;
  let currentTurn = null;
  for (const entry of readAllTranscriptEntries(transcriptPath)) {
    if (entry.role === "user") {
      const userPrompt = extractUserPrompt(entry);
      if (userPrompt !== "") {
        promptNumber += 1;
        currentTurn = {
          promptNumber,
          userPrompt,
          assistantText: "",
          toolCalls: [],
          isSidechain: Boolean(entry.isSidechain)
        };
        turns.push(currentTurn);
        continue;
      }
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

// src/hooks/backfill.ts
function buildReplayTurnLookup(transcriptTurns) {
  return new Map(transcriptTurns.map((turn) => [turn.promptNumber, turn]));
}
function backfillFromTranscript(db2, pendingTurns, transcriptPath, lastAssistantMessage, transcriptTurnsByPromptNumber) {
  if (pendingTurns.length === 0) {
    return;
  }
  const replayTurnsByPromptNumber = transcriptTurnsByPromptNumber ?? buildReplayTurnLookup(
    transcriptPath ? parseReplayTranscript(transcriptPath) : []
  );
  const lastPendingPromptNumber = pendingTurns[pendingTurns.length - 1]?.promptNumber;
  for (const pendingTurn of pendingTurns) {
    if (pendingTurn.assistantResponse || !pendingTurn.userPrompt) {
      continue;
    }
    const transcriptTurn = replayTurnsByPromptNumber.get(
      pendingTurn.promptNumber
    );
    const assistantResponse = pendingTurn.promptNumber === lastPendingPromptNumber && lastAssistantMessage !== void 0 ? lastAssistantMessage : transcriptTurn?.assistantText ?? "";
    const toolCallCount = transcriptTurn?.toolCalls.length ?? 0;
    updateTurnBackfill(
      db2,
      pendingTurn.id,
      assistantResponse,
      toolCallCount
    );
  }
}

// src/shared/logger.ts
var import_node_fs3 = require("node:fs");
var import_node_path3 = require("node:path");
var LOG_PATH = (0, import_node_path3.join)(DATA_DIR, "claude-mnemo.log");
var dirEnsured = false;
function ensureLogDir() {
  if (!dirEnsured) {
    (0, import_node_fs3.mkdirSync)(DATA_DIR, { recursive: true });
    dirEnsured = true;
  }
}
function writeLog(level, component, message, context) {
  const line = JSON.stringify({
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    level,
    component,
    message,
    context: context ?? null
  });
  try {
    ensureLogDir();
    (0, import_node_fs3.appendFileSync)(LOG_PATH, `${line}
`);
  } catch {
    process.stderr.write(`${line}
`);
  }
}
function createLogger(component) {
  return {
    debug(message, context) {
      writeLog("debug", component, message, context);
    },
    info(message, context) {
      writeLog("info", component, message, context);
    },
    warn(message, context) {
      writeLog("warn", component, message, context);
    },
    error(message, context) {
      writeLog("error", component, message, context);
    }
  };
}

// src/hooks/handlers/compact.ts
var log = createLogger("MNEMOSYNE");
function buildPrompt(db2, sessionDbId) {
  return buildMnemosynePrompt(
    buildExtractionStatusSummary(
      getTurnsForSession(db2, sessionDbId).map((turn) => ({
        promptNumber: turn.promptNumber,
        status: turn.status,
        promptPreview: turn.userPrompt ?? ""
      }))
    )
  );
}
function createCompactHandler(dependencies) {
  return async function handleCompactHook(input) {
    if (!input.sessionId) {
      return { continue: true };
    }
    const session = getSessionByContentId(dependencies.db, input.sessionId);
    if (!session) {
      return { continue: true };
    }
    const transcriptPath = input.transcriptPath || (input.cwd ? resolveTranscriptPath(input.cwd, input.sessionId) : void 0);
    const pendingTurns = getPendingTurns(dependencies.db, session.id);
    backfillFromTranscript(dependencies.db, pendingTurns, transcriptPath);
    if (pendingTurns.length > 0) {
      const result = await dependencies.forkMnemosyne({
        sessionId: input.sessionId,
        cwd: input.cwd,
        prompt: buildPrompt(dependencies.db, session.id)
      });
      if (result) {
        const cacheHitPct = result.inputTokens > 0 ? Math.round(
          result.cacheReadInputTokens / result.inputTokens * 100
        ) : 0;
        log.info("extraction complete", {
          hook: "compact",
          turns: result.numTurns,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          cacheReadTokens: result.cacheReadInputTokens,
          cacheCreationTokens: result.cacheCreationInputTokens,
          cacheHitPct,
          durationMs: result.durationMs
        });
      }
    }
    return {
      continue: true
    };
  };
}

// src/db/observations.ts
var OBSERVATION_SELECT = `
  SELECT
    id,
    turn_id AS turnId,
    type,
    title,
    description,
    narrative,
    facts,
    concepts,
    files_read AS filesRead,
    files_modified AS filesModified,
    created_at_epoch AS createdAtEpoch
  FROM observations
`;
function parseJsonArray2(value) {
  if (!value) {
    return [];
  }
  return JSON.parse(value);
}
function mapObservationRow(row) {
  if (!row) {
    return null;
  }
  return {
    ...row,
    facts: parseJsonArray2(row.facts),
    concepts: parseJsonArray2(row.concepts),
    filesRead: parseJsonArray2(row.filesRead),
    filesModified: parseJsonArray2(row.filesModified)
  };
}
function getObservationsForTurn(db2, turnId) {
  return db2.query(
    `${OBSERVATION_SELECT} WHERE turn_id = ? ORDER BY id ASC`
  ).all(turnId).map((row) => mapObservationRow(row)).filter((observation) => observation !== null);
}

// src/mcp/format.ts
var TYPE_EMOJI = {
  bugfix: "\u{1F534}",
  feature: "\u{1F7E3}",
  refactor: "\u{1F504}",
  change: "\u2705",
  discovery: "\u{1F535}",
  decision: "\u2696\uFE0F"
};
function formatEpoch(epoch) {
  const date = new Date(epoch * 1e3);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
function typeEmoji(type) {
  return TYPE_EMOJI[type] ?? type;
}
function normalizeCount(value) {
  if (!value || value < 0) {
    return 0;
  }
  return value;
}
function formatStats(parts) {
  return parts.join(" ");
}
function formatSessionStats(session) {
  const parts = [];
  const turnCount = normalizeCount(session.turnCount ?? session.turns?.length);
  const observationCount = normalizeCount(
    session.observationCount ?? session.turns?.reduce(
      (sum, turn) => sum + normalizeCount(turn.observationCount),
      0
    )
  );
  if (turnCount > 0) {
    parts.push(`\u{1F4AC}${turnCount}`);
  }
  if (observationCount > 0) {
    parts.push(`\u{1F4A1}${observationCount}`);
  }
  return formatStats(parts);
}
function formatTurnStats(turn) {
  const parts = [];
  const observationCount = normalizeCount(
    turn.observationCount ?? turn.observations?.length
  );
  const filesReadCount = normalizeCount(
    turn.filesReadCount ?? turn.filesRead?.length
  );
  const filesModifiedCount = normalizeCount(
    turn.filesModifiedCount ?? turn.filesModified?.length
  );
  const toolCallCount = normalizeCount(turn.toolCallCount);
  if (observationCount > 0) {
    parts.push(`\u{1F4A1}${observationCount}`);
  }
  if (filesReadCount > 0) {
    parts.push(`\u{1F4D6}${filesReadCount}`);
  }
  if (filesModifiedCount > 0) {
    parts.push(`\u270F\uFE0F${filesModifiedCount}`);
  }
  if (toolCallCount > 0) {
    parts.push(`\u{1F527}${toolCallCount}`);
  }
  return formatStats(parts);
}
function pushBullets(lines, indent, values) {
  for (const value of values) {
    lines.push(`${indent}- ${value}`);
  }
}
function formatSessionCollapsed(session) {
  const stats = formatSessionStats(session);
  const statsSegment = stats ? ` | ${stats}` : "";
  const lines = [
    `- [S${session.id}] ${session.title ?? "Untitled"}${statsSegment} | ${formatEpoch(session.startedAtEpoch)} | ${session.project}`
  ];
  if (session.description) {
    lines.push(`  - desc: ${session.description}`);
  }
  return lines.join("\n");
}
function formatSessionExpanded(session) {
  const lines = [formatSessionCollapsed(session)];
  if (session.insight && session.insight.length > 0) {
    lines.push("  - insight:");
    pushBullets(lines, "    ", session.insight);
  }
  if (session.nextSteps) {
    lines.push("  - next_steps:");
    lines.push(`    - ${session.nextSteps}`);
  }
  return lines.join("\n");
}
function formatTurnLabel(turn, { indent = "  ", sessionId } = {}) {
  const prefix = sessionId === void 0 ? `${indent}- [T${turn.promptNumber}]` : `${indent}- [S${sessionId}][T${turn.promptNumber}]`;
  const stats = formatTurnStats(turn);
  const statsSegment = stats ? ` | ${stats}` : "";
  return `${prefix} ${turn.title ?? "Untitled"}${statsSegment}`;
}
function formatTurnCollapsed(turn, options = {}) {
  const { indent = "  " } = options;
  const lines = [formatTurnLabel(turn, options)];
  if (turn.description) {
    lines.push(`${indent}  - desc: ${turn.description}`);
  }
  return lines.join("\n");
}
function formatTurnExpanded(turn, options = {}) {
  const { indent = "  " } = options;
  const detailIndent = `${indent}  `;
  const lines = [formatTurnCollapsed(turn, options)];
  if (turn.promptPreview) {
    lines.push(`${detailIndent}- prompt: "${turn.promptPreview}"`);
  }
  if (turn.responsePreview) {
    lines.push(`${detailIndent}- response: "${turn.responsePreview}"`);
  }
  if (turn.insight && turn.insight.length > 0) {
    lines.push(`${detailIndent}- insight:`);
    pushBullets(lines, `${detailIndent}  `, turn.insight);
  }
  return lines.join("\n");
}
function formatObservationLabel(observation, { indent = "" } = {}) {
  return `${indent}- [O${observation.id}] ${typeEmoji(observation.type)} ${observation.title}`;
}
function formatObservationCollapsed(observation, options = {}) {
  const { indent = "" } = options;
  const lines = [formatObservationLabel(observation, options)];
  if (observation.description) {
    lines.push(`${indent}  - desc: ${observation.description}`);
  }
  return lines.join("\n");
}
function formatObservationExpanded(observation, options = {}) {
  const { indent = "" } = options;
  const detailIndent = `${indent}  `;
  const lines = [formatObservationCollapsed(observation, options)];
  if (observation.narrative) {
    lines.push(`${detailIndent}- narrative: ${observation.narrative}`);
  }
  if (observation.facts && observation.facts.length > 0) {
    lines.push(`${detailIndent}- facts:`);
    pushBullets(lines, `${detailIndent}  `, observation.facts);
  }
  if (observation.concepts && observation.concepts.length > 0) {
    lines.push(`${detailIndent}- concepts: ${observation.concepts.join(", ")}`);
  }
  const filesParts = [];
  if (observation.filesRead && observation.filesRead.length > 0) {
    filesParts.push(`\u{1F4D6} ${observation.filesRead.join(", ")}`);
  }
  if (observation.filesModified && observation.filesModified.length > 0) {
    filesParts.push(`\u270F\uFE0F ${observation.filesModified.join(", ")}`);
  }
  if (filesParts.length > 0) {
    lines.push(`${detailIndent}- files: ${filesParts.join(" ")}`);
  }
  return lines.join("\n");
}

// src/mcp/recall.ts
function splitInsight(insight) {
  if (!insight) {
    return [];
  }
  return insight.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => line.replace(/^-+\s*/, ""));
}
function buildFormattedTurn(db2, turn, expand = false) {
  const observations = getObservationsForTurn(db2, turn.id);
  const formattedTurn = {
    id: turn.id,
    promptNumber: turn.promptNumber,
    title: turn.title,
    description: turn.description,
    observationCount: observations.length,
    toolCallCount: turn.toolCallCount,
    filesReadCount: turn.filesRead.length,
    filesModifiedCount: turn.filesModified.length
  };
  if (expand) {
    formattedTurn.promptPreview = turn.userPrompt;
    formattedTurn.responsePreview = turn.assistantResponse;
    formattedTurn.insight = splitInsight(turn.insight);
    formattedTurn.filesRead = turn.filesRead;
    formattedTurn.filesModified = turn.filesModified;
    formattedTurn.observations = observations.map(
      (observation) => ({
        id: observation.id,
        type: observation.type,
        title: observation.title,
        description: observation.description,
        narrative: observation.narrative,
        facts: observation.facts,
        concepts: observation.concepts,
        filesRead: observation.filesRead,
        filesModified: observation.filesModified
      })
    );
  }
  return formattedTurn;
}
function buildFormattedSession(db2, sessionId, expandTurns = []) {
  const session = getSession(db2, sessionId);
  if (!session) {
    return null;
  }
  const turns = getTurnsForSession(db2, session.id).map((turn) => {
    return buildFormattedTurn(db2, turn, expandTurns.includes(turn.promptNumber));
  });
  return {
    id: session.id,
    title: session.title,
    project: session.project,
    startedAtEpoch: session.startedAtEpoch,
    description: session.description,
    insight: splitInsight(session.insight),
    nextSteps: session.nextSteps,
    turnCount: turns.length,
    observationCount: turns.reduce(
      (sum, turn) => sum + (turn.observationCount ?? 0),
      0
    ),
    turns
  };
}

// src/hooks/handlers/context.ts
var EMPTY_CONTEXT_FALLBACK = "claude-mnemo memory available via recall() and replay().";
function truncate(value, maxLength) {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 3)}...`;
}
function truncateSession(session) {
  return {
    ...session,
    description: session.description ? truncate(session.description, 60) : null,
    insight: session.insight?.map((item) => truncate(item, 80)),
    nextSteps: session.nextSteps ? truncate(session.nextSteps, 80) : null,
    turns: session.turns?.map(truncateTurn)
  };
}
function truncateTurn(turn) {
  return {
    ...turn,
    description: turn.description ? truncate(turn.description, 60) : null,
    promptPreview: turn.promptPreview ? truncate(turn.promptPreview, 120) : null,
    responsePreview: turn.responsePreview ? truncate(turn.responsePreview, 200) : null,
    insight: turn.insight?.map((item) => truncate(item, 80)),
    observations: turn.observations?.map(truncateObservation)
  };
}
function truncateObservation(observation) {
  return {
    ...observation,
    description: observation.description ? truncate(observation.description, 60) : null
  };
}
function isDetailedObservation(observation) {
  return Boolean(
    observation.narrative || observation.facts && observation.facts.length > 0 || observation.concepts && observation.concepts.length > 0 || observation.filesRead && observation.filesRead.length > 0 || observation.filesModified && observation.filesModified.length > 0
  );
}
function formatObservationContext(observation) {
  return isDetailedObservation(observation) ? formatObservationExpanded(observation, { indent: "    " }) : formatObservationCollapsed(observation, { indent: "    " });
}
function formatPrimarySession(session) {
  const lines = [formatSessionExpanded(truncateSession(session))];
  const turns = session.turns ?? [];
  const expandedTurnNumbers = new Set(
    turns.slice(Math.max(0, turns.length - 3)).map((turn) => turn.promptNumber)
  );
  for (const turn of turns) {
    const truncatedTurn = truncateTurn(turn);
    if (!expandedTurnNumbers.has(turn.promptNumber)) {
      lines.push(formatTurnCollapsed(truncatedTurn));
      continue;
    }
    lines.push(formatTurnExpanded(truncatedTurn));
    const observations = (turn.observations ?? []).slice(0, 3);
    for (const observation of observations) {
      lines.push(formatObservationContext(truncateObservation(observation)));
    }
    if ((turn.observations?.length ?? 0) > 3) {
      lines.push(`    - ... and ${turn.observations.length - 3} more observations`);
    }
  }
  return lines.join("\n");
}
function formatRecentSession(session) {
  const lines = [formatSessionCollapsed(truncateSession(session))];
  const turns = (session.turns ?? []).slice(-5);
  for (const turn of turns) {
    lines.push(formatTurnCollapsed(truncateTurn(turn)));
  }
  if ((session.turns?.length ?? 0) > 5) {
    lines.push(`  - ... and ${session.turns.length - 5} more turns`);
  }
  return lines.join("\n");
}
function buildHeader(db2) {
  const sessionCount = db2.query("SELECT COUNT(*) AS count FROM sessions").get()?.count ?? 0;
  const observationCount = db2.query("SELECT COUNT(*) AS count FROM observations").get()?.count ?? 0;
  return [
    `claude-mnemo: ${sessionCount} sessions, ${observationCount} observations`,
    "Types: \u{1F534}bugfix \u{1F7E3}feature \u{1F504}refactor \u2705change \u{1F535}discovery \u2696\uFE0Fdecision",
    "Stats: \u{1F4AC}turns \u{1F4A1}observations \u{1F4D6}read \u270F\uFE0Fmodified \u{1F527}tools",
    "Format:",
    "  - [Sx] title | \u{1F4AC}n \u{1F4A1}n | yyyy-mm-dd | project",
    "  - [Tx] title | \u{1F4A1}n \u{1F4D6}n \u270F\uFE0Fn \u{1F527}n",
    "  - [Ox] \u{1F535} title",
    "Expand: recall(session=x, turn=y) | Raw: replay(session=x, turn=y)"
  ].join("\n");
}
function resolvePrimarySessionRecord(db2, input, recentSessions) {
  const currentSession = input.sessionId ? getSessionByContentId(db2, input.sessionId) : null;
  return currentSession ?? recentSessions[0] ?? null;
}
function buildPrimarySession(db2, primarySessionRecord) {
  if (!primarySessionRecord) {
    return null;
  }
  const expandTurnNumbers = getTurnsForSession(db2, primarySessionRecord.id).slice(-3).map((turn) => turn.promptNumber);
  const primarySession = buildFormattedSession(
    db2,
    primarySessionRecord.id,
    expandTurnNumbers
  );
  return primarySession ? truncateSession(primarySession) : null;
}
function buildRecentSessions(db2, recentSessions, primarySession) {
  if (!primarySession) {
    return [];
  }
  const primaryId = primarySession.id;
  const others = recentSessions.filter((session) => session.id !== primaryId).slice(0, 4);
  return others.map((session) => buildFormattedSession(db2, session.id)).filter((session) => session !== null).map(truncateSession);
}
function buildContextOutput(db2, input) {
  const recentSessions = getRecentSessions(db2, { limit: 5 });
  const primarySessionRecord = resolvePrimarySessionRecord(
    db2,
    input,
    recentSessions
  );
  const primarySession = buildPrimarySession(db2, primarySessionRecord);
  const formattedRecentSessions = buildRecentSessions(
    db2,
    recentSessions,
    primarySession
  );
  if (!primarySession) {
    return EMPTY_CONTEXT_FALLBACK;
  }
  const nextTwoSessions = formattedRecentSessions.slice(0, 2);
  const lastTwoSessions = formattedRecentSessions.slice(2, 4);
  return [
    buildHeader(db2),
    "",
    "## Current Session",
    "",
    formatPrimarySession(primarySession),
    "",
    "## Recent Sessions",
    "",
    ...nextTwoSessions.map((session) => formatRecentSession(session)),
    ...lastTwoSessions.map((session) => formatSessionCollapsed(session))
  ].join("\n");
}
function createContextHandler(dependencies) {
  return async function handleContextHook(input) {
    return {
      continue: true,
      hookSpecificOutput: buildContextOutput(dependencies.db, input)
    };
  };
}

// src/hooks/handlers/session-init.ts
function createPendingTurn(db2, sessionId, promptNumber, prompt, createdAtEpoch) {
  db2.query(
    `INSERT INTO turns (
      session_id,
      prompt_number,
      status,
      user_prompt,
      created_at_epoch
    ) VALUES (?, ?, 'pending', ?, ?)`
  ).run(sessionId, promptNumber, prompt, createdAtEpoch);
}
function createSessionInitHandler(dependencies) {
  const now = dependencies.now ?? (() => Math.floor(Date.now() / 1e3));
  return async function handleSessionInitHook(input) {
    if (!input.sessionId || !input.cwd || !input.prompt) {
      return {
        continue: true,
        suppressOutput: true
      };
    }
    const existingSession = getSessionByContentId(dependencies.db, input.sessionId);
    const session = upsertSession(dependencies.db, {
      contentSessionId: input.sessionId,
      project: input.cwd,
      title: existingSession?.title ?? null,
      description: existingSession?.description ?? null,
      insight: existingSession?.insight ?? null,
      startedAtEpoch: existingSession?.startedAtEpoch ?? now(),
      updatedAtEpoch: now(),
      completedAtEpoch: existingSession?.completedAtEpoch ?? null
    });
    const promptNumber = getTurnsForSession(dependencies.db, session.id).length + 1;
    createPendingTurn(
      dependencies.db,
      session.id,
      promptNumber,
      input.prompt,
      now()
    );
    return {
      continue: true,
      suppressOutput: true
    };
  };
}

// src/hooks/handlers/stop.ts
var log2 = createLogger("MNEMOSYNE");
function buildStopPrompt(db2, sessionDbId) {
  return buildMnemosynePrompt(
    buildExtractionStatusSummary(
      getTurnsForSession(db2, sessionDbId).map((turn) => ({
        promptNumber: turn.promptNumber,
        status: turn.status,
        promptPreview: turn.userPrompt ?? ""
      }))
    )
  );
}
function detectUndoPromptNumbers(db2, sessionDbId, transcriptPath, transcriptTurnsByPromptNumber) {
  if (!transcriptPath) {
    return [];
  }
  const replayTurnsByPromptNumber = transcriptTurnsByPromptNumber ?? new Map(
    parseReplayTranscript(transcriptPath).map((turn) => [turn.promptNumber, turn])
  );
  return getTurnsForSession(db2, sessionDbId).filter(
    (turn) => (turn.status === "extracted" || turn.status === "skipped") && turn.userPrompt
  ).filter((turn) => {
    const transcriptTurn = replayTurnsByPromptNumber.get(turn.promptNumber);
    if (!transcriptTurn) {
      return false;
    }
    if (transcriptTurn.isSidechain) {
      return true;
    }
    return transcriptTurn.assistantText !== (turn.assistantResponse ?? "");
  }).map((turn) => turn.promptNumber);
}
function createStopHandler(dependencies) {
  const now = dependencies.now ?? (() => Math.floor(Date.now() / 1e3));
  const stderr = dependencies.stderr ?? process.stderr;
  return async function handleStopHook(input) {
    if (input.stopHookActive) {
      return {
        continue: true,
        exitCode: HOOK_SUCCESS_EXIT_CODE
      };
    }
    if (!input.sessionId) {
      return {
        continue: true,
        exitCode: HOOK_SUCCESS_EXIT_CODE
      };
    }
    const session = getSessionByContentId(dependencies.db, input.sessionId);
    if (!session) {
      return {
        continue: true,
        exitCode: HOOK_SUCCESS_EXIT_CODE
      };
    }
    const transcriptTurnsByPromptNumber = input.transcriptPath ? new Map(
      parseReplayTranscript(input.transcriptPath).map((turn) => [
        turn.promptNumber,
        turn
      ])
    ) : void 0;
    backfillFromTranscript(
      dependencies.db,
      getPendingTurns(dependencies.db, session.id).filter(
        (turn) => turn.status === "pending"
      ),
      input.transcriptPath,
      input.lastAssistantMessage,
      transcriptTurnsByPromptNumber
    );
    const stalePromptNumbers = detectUndoPromptNumbers(
      dependencies.db,
      session.id,
      input.transcriptPath,
      transcriptTurnsByPromptNumber
    );
    markTurnsStale(dependencies.db, session.id, stalePromptNumbers);
    const pendingTurns = getPendingTurns(dependencies.db, session.id);
    if (pendingTurns.length > 0) {
      const result = await dependencies.forkMnemosyne({
        sessionId: input.sessionId,
        cwd: input.cwd,
        prompt: buildStopPrompt(dependencies.db, session.id)
      });
      if (result) {
        const cacheHitPct = result.inputTokens > 0 ? Math.round(
          result.cacheReadInputTokens / result.inputTokens * 100
        ) : 0;
        log2.info("extraction complete", {
          hook: "stop",
          turns: result.numTurns,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          cacheReadTokens: result.cacheReadInputTokens,
          cacheCreationTokens: result.cacheCreationInputTokens,
          cacheHitPct,
          durationMs: result.durationMs
        });
      }
    }
    upsertSession(dependencies.db, {
      contentSessionId: session.contentSessionId,
      project: session.project,
      title: session.title,
      description: session.description,
      insight: session.insight,
      startedAtEpoch: session.startedAtEpoch,
      updatedAtEpoch: now(),
      completedAtEpoch: now()
    });
    stderr.write(
      `Mnemosyne: ${pendingTurns.length} turns queued for extraction
`
    );
    return {
      continue: true,
      exitCode: HOOK_SUCCESS_EXIT_CODE
    };
  };
}

// src/hooks/hook-command.ts
var db = createDatabase();
initializeDatabase(db);
var HANDLERS = {
  SessionStart: createContextHandler({ db }),
  PreCompact: createCompactHandler({ db, forkMnemosyne }),
  UserPromptSubmit: createSessionInitHandler({ db }),
  Stop: createStopHandler({
    db,
    forkMnemosyne
  })
};
function readJsonFromStdin() {
  const input = (0, import_node_fs4.readFileSync)(0, "utf8").trim();
  if (input === "") {
    return {};
  }
  return JSON.parse(input);
}
function eventNameFromCommandArgument(arg) {
  switch (arg) {
    case "context":
      return "SessionStart";
    case "compact":
      return "PreCompact";
    case "session-init":
      return "UserPromptSubmit";
    case "stop":
      return "Stop";
    default:
      return void 0;
  }
}
function writeHookResult(result) {
  const output = {
    continue: result.continue
  };
  if (result.suppressOutput !== void 0) {
    output.suppressOutput = result.suppressOutput;
  }
  if (result.hookSpecificOutput !== void 0) {
    output.hookSpecificOutput = result.hookSpecificOutput;
  }
  if (Object.keys(output).length > 1 || output.continue !== true) {
    process.stdout.write(JSON.stringify(output));
  }
}
async function runHookCommand() {
  if (process.env.CLAUDE_CODE_ENTRYPOINT === "sdk-ts") {
    return HOOK_SUCCESS_EXIT_CODE;
  }
  try {
    const rawInput = readJsonFromStdin();
    const eventNameOverride = eventNameFromCommandArgument(process.argv[2]);
    if (eventNameOverride && !("event_name" in rawInput) && !("hook_event_name" in rawInput)) {
      rawInput.event_name = eventNameOverride;
    }
    const normalizedInput = normalizeHookInput(rawInput);
    const handler = HANDLERS[normalizedInput.eventName];
    if (!handler) {
      return HOOK_SUCCESS_EXIT_CODE;
    }
    const result = await handler(normalizedInput);
    writeHookResult(result);
    return result.exitCode ?? HOOK_SUCCESS_EXIT_CODE;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown hook failure";
    process.stderr.write(`[HOOK] ${message}
`);
    return HOOK_NON_BLOCKING_EXIT_CODE;
  }
}
function isDirectExecution() {
  const entry = process.argv[1] ?? "";
  return entry.endsWith("/hook-command.ts") || entry.endsWith("/hook-command.cjs");
}
if (isDirectExecution()) {
  void runHookCommand().then((exitCode) => {
    process.exit(exitCode);
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  runHookCommand
});
