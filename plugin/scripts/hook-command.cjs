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
var HOOK_HEALTH_TIMEOUT_MS = 3e3;
var HOOK_READINESS_TIMEOUT_MS = 3e4;
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
var WORKER_PID_PATH = (0, import_node_path.join)(DATA_DIR, "worker.pid");
var WORKER_STARTING_PATH = (0, import_node_path.join)(DATA_DIR, "worker.starting");
function resolveDatabasePath(explicitPath) {
  const candidatePath = explicitPath || process.env.CLAUDE_MNEMO_DB_PATH || DEFAULT_DB_PATH;
  if (candidatePath.startsWith("~/")) {
    return (0, import_node_path.join)((0, import_node_os.homedir)(), candidatePath.slice(2));
  }
  return candidatePath;
}
var SESSIONS_DIR = (0, import_node_path.join)(DATA_DIR, "sessions");

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
function configureDatabase(db) {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA mmap_size = 268435456;");
  db.exec("PRAGMA cache_size = 10000;");
  db.exec("PRAGMA busy_timeout = 5000;");
}
function createDatabase(path) {
  const databasePath = resolveDatabasePath2(path);
  ensureParentDirectory(databasePath);
  const db = new import_bun_sqlite.Database(databasePath);
  configureDatabase(db);
  return db;
}

// src/db/search.ts
function indexFtsRecord(db, layer, sourceId, title, content, extra) {
  db.query("DELETE FROM memory_fts WHERE layer = ? AND source_id = ?").run(
    layer,
    sourceId
  );
  db.query(
    "INSERT INTO memory_fts (layer, source_id, title, content, extra) VALUES (?, ?, ?, ?, ?)"
  ).run(layer, sourceId, title, content, extra);
}
function indexSessionToFTS(db, session) {
  indexFtsRecord(
    db,
    "session",
    session.id,
    session.title,
    session.content,
    session.insight ?? ""
  );
}
function indexTurnToFTS(db, turn) {
  indexFtsRecord(
    db,
    "turn",
    turn.id,
    turn.title,
    turn.content,
    turn.insight ?? ""
  );
}
function indexObservationToFTS(db, observation) {
  indexFtsRecord(
    db,
    "observation",
    observation.id,
    observation.title,
    observation.content,
    ""
  );
}
function indexMemoryToFTS(db, memory) {
  indexFtsRecord(
    db,
    "memory",
    memory.id,
    memory.title,
    memory.content,
    [memory.reasoning ?? "", memory.application ?? "", ...memory.tags].filter(Boolean).join("\n")
  );
}
function rebuildSearchIndex(db) {
  db.exec("DELETE FROM memory_fts");
  const sessionRows = db.query(
    `
        SELECT
          id,
          title,
          content,
          insight
        FROM sessions
      `
  ).all();
  for (const session of sessionRows) {
    indexSessionToFTS(db, session);
  }
  const turnRows = db.query(
    `
        SELECT
          id,
          title,
          content,
          insight
        FROM turns
        WHERE status = 'extracted'
      `
  ).all();
  for (const turn of turnRows) {
    indexTurnToFTS(db, turn);
  }
  const observationRows = db.query(
    `
        SELECT
          id,
          title,
          content,
          status
        FROM observations
        WHERE status = 'extracted'
      `
  ).all();
  for (const observation of observationRows) {
    indexObservationToFTS(db, {
      id: observation.id,
      title: observation.title,
      content: observation.content
    });
  }
  const memoryRows = db.query(
    `
        SELECT
          id,
          title,
          content,
          reasoning,
          application,
          tags
        FROM memories
      `
  ).all();
  for (const memory of memoryRows) {
    indexMemoryToFTS(db, {
      ...memory,
      tags: memory.tags ? JSON.parse(memory.tags) : []
    });
  }
}

// src/db/schema.ts
var SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_session_id TEXT UNIQUE NOT NULL,
    project TEXT NOT NULL,
    title TEXT,
    content TEXT,
    insight TEXT,
    next_steps TEXT,
    last_compact_turn INTEGER,
    created_at_epoch INTEGER NOT NULL,
    updated_at_epoch INTEGER,
    completed_at_epoch INTEGER
  );

  CREATE TABLE IF NOT EXISTS turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    prompt_number INTEGER NOT NULL,
    content_prompt_id TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    user_prompt TEXT,
    assistant_response TEXT,
    title TEXT,
    content TEXT,
    insight TEXT,
    type TEXT,
    tags TEXT,
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
    tool_name TEXT,
    tool_input TEXT,
    tool_result TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    title TEXT,
    content TEXT,
    created_at_epoch INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    scope TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    reasoning TEXT,
    application TEXT,
    tags TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    superseded_by INTEGER REFERENCES memories(id),
    expires_at_epoch INTEGER,
    source_turn_id INTEGER REFERENCES turns(id),
    created_at_epoch INTEGER NOT NULL,
    updated_at_epoch INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_turns_session_prompt
    ON turns(session_id, prompt_number);

  CREATE INDEX IF NOT EXISTS idx_turns_status
    ON turns(status);

  CREATE INDEX IF NOT EXISTS idx_observations_turn_id
    ON observations(turn_id);

  CREATE TABLE IF NOT EXISTS pending_queue (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    session_db_id INTEGER NOT NULL,
    claimed_at_epoch INTEGER,
    enqueued_at_epoch INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_pending_queue_unclaimed
    ON pending_queue(seq) WHERE claimed_at_epoch IS NULL;

  CREATE INDEX IF NOT EXISTS idx_pending_queue_session
    ON pending_queue(session_db_id, seq);

  CREATE INDEX IF NOT EXISTS idx_memories_scope
    ON memories(scope);

  CREATE INDEX IF NOT EXISTS idx_memories_type
    ON memories(type);

  CREATE INDEX IF NOT EXISTS idx_memories_status
    ON memories(status);

  CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    layer,
    source_id,
    title,
    content,
    extra
  );
`;
function initializeSchema(db) {
  db.exec(SCHEMA_SQL);
  ensureSessionProjectIndex(db);
  ensureTurnPromptIdIndex(db);
}
function ensureSessionProjectIndex(db) {
  if (hasColumn(db, "sessions", "created_at_epoch")) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_project_created_at
        ON sessions(project, created_at_epoch DESC)
    `);
    db.exec("DROP INDEX IF EXISTS idx_sessions_project_started_at");
    return;
  }
  if (hasColumn(db, "sessions", "started_at_epoch")) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_project_started_at
        ON sessions(project, started_at_epoch DESC)
    `);
  }
}
function ensureTurnPromptIdIndex(db) {
  if (!hasColumn(db, "turns", "content_prompt_id")) {
    return;
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_turns_session_prompt_id
      ON turns(session_id, content_prompt_id) WHERE content_prompt_id IS NOT NULL
  `);
}
function hasColumn(db, table, column) {
  const rows = db.query(`SELECT name FROM pragma_table_info('${table}')`).all();
  return rows.some((row) => row.name === column);
}
function hasRow(db, sql, params = []) {
  return db.query(
    `SELECT EXISTS(${sql}) AS hasRows`
  ).get(...params)?.hasRows === 1;
}
function shouldRebuildSearchIndex(db) {
  const sourceLayers = [
    { table: "sessions", layer: "session" },
    { table: "turns", layer: "turn" },
    { table: "observations", layer: "observation" },
    { table: "memories", layer: "memory" }
  ];
  const hasAnySourceRows = sourceLayers.some(
    ({ table }) => hasRow(db, `SELECT 1 FROM ${table} LIMIT 1`)
  );
  const hasAnyFtsRows = hasRow(db, "SELECT 1 FROM memory_fts LIMIT 1");
  if (!hasAnySourceRows && !hasAnyFtsRows) {
    return false;
  }
  if (hasAnySourceRows !== hasAnyFtsRows) {
    return true;
  }
  const indexedLayers = new Set(
    db.query("SELECT DISTINCT layer FROM memory_fts").all().map((row) => row.layer)
  );
  return sourceLayers.some(
    ({ table, layer }) => hasRow(db, `SELECT 1 FROM ${table} LIMIT 1`) && !indexedLayers.has(layer)
  );
}
function hasLegacySchema(db) {
  const sessionsLegacyColumns = ["description", "started_at_epoch"];
  const turnsLegacyColumns = ["description"];
  const observationsLegacyColumns = [
    "type",
    "description",
    "insight",
    "narrative",
    "facts",
    "tags",
    "concepts",
    "files_read",
    "files_modified"
  ];
  const observationsCurrentColumns = [
    "tool_name",
    "tool_input",
    "tool_result",
    "status",
    "content"
  ];
  const hasLegacyObservationColumns = observationsLegacyColumns.some(
    (column) => hasColumn(db, "observations", column)
  );
  const isMissingCurrentObservationColumns = observationsCurrentColumns.some(
    (column) => !hasColumn(db, "observations", column)
  );
  return sessionsLegacyColumns.some((column) => hasColumn(db, "sessions", column)) || turnsLegacyColumns.some((column) => hasColumn(db, "turns", column)) || hasLegacyObservationColumns && isMissingCurrentObservationColumns;
}
function resetSchema(db) {
  db.exec("DROP TABLE IF EXISTS pending_queue");
  db.exec("DROP TABLE IF EXISTS memories");
  db.exec("DROP TABLE IF EXISTS observations");
  db.exec("DROP TABLE IF EXISTS turns");
  db.exec("DROP TABLE IF EXISTS sessions");
  db.exec("DROP TABLE IF EXISTS memory_fts");
}
function initializeDatabase(db) {
  if (hasLegacySchema(db)) {
    console.warn("[claude-mnemo] legacy schema detected, resetting database");
    resetSchema(db);
  }
  initializeSchema(db);
  if (shouldRebuildSearchIndex(db)) {
    rebuildSearchIndex(db);
  }
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
    case "PostToolUse":
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

// src/db/sessions.ts
var SESSION_SELECT = `
  SELECT
    id,
    content_session_id AS contentSessionId,
    project,
    title,
    content,
    insight,
    next_steps AS nextSteps,
    last_compact_turn AS lastCompactTurn,
    created_at_epoch AS createdAtEpoch,
    updated_at_epoch AS updatedAtEpoch,
    completed_at_epoch AS completedAtEpoch
  FROM sessions
`;
function upsertSession(db, input) {
  const session = db.query(`
      INSERT INTO sessions (
        content_session_id,
        project,
        title,
        content,
        insight,
        next_steps,
        last_compact_turn,
        created_at_epoch,
        updated_at_epoch,
        completed_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(content_session_id) DO UPDATE SET
        project = excluded.project,
        title = COALESCE(excluded.title, sessions.title),
        content = COALESCE(excluded.content, sessions.content),
        insight = COALESCE(excluded.insight, sessions.insight),
        next_steps = COALESCE(excluded.next_steps, sessions.next_steps),
        last_compact_turn = COALESCE(excluded.last_compact_turn, sessions.last_compact_turn),
        created_at_epoch = excluded.created_at_epoch,
        updated_at_epoch = excluded.updated_at_epoch,
        completed_at_epoch = COALESCE(excluded.completed_at_epoch, sessions.completed_at_epoch)
      RETURNING
        id,
        content_session_id AS contentSessionId,
        project,
        title,
        content,
        insight,
        next_steps AS nextSteps,
        last_compact_turn AS lastCompactTurn,
        created_at_epoch AS createdAtEpoch,
        updated_at_epoch AS updatedAtEpoch,
        completed_at_epoch AS completedAtEpoch
    `).get(
    input.contentSessionId,
    input.project,
    input.title,
    input.content ?? null,
    input.insight,
    input.nextSteps ?? null,
    input.lastCompactTurn ?? null,
    input.createdAtEpoch,
    input.updatedAtEpoch,
    input.completedAtEpoch
  );
  if (!session) {
    throw new Error("Failed to upsert session.");
  }
  indexSessionToFTS(db, session);
  return session;
}
function getSessionByContentId(db, contentSessionId) {
  return db.query(
    `${SESSION_SELECT} WHERE content_session_id = ?`
  ).get(contentSessionId) ?? null;
}
function getRecentSessions(db, options = {}) {
  const clauses = [];
  const params = [];
  if (options.project) {
    clauses.push("project = ?");
    params.push(options.project);
  }
  const whereClause = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  const limit = options.limit ?? 20;
  return db.query(
    `${SESSION_SELECT}${whereClause} ORDER BY created_at_epoch DESC LIMIT ?`
  ).all(...params, limit);
}

// src/worker/client.ts
var import_node_child_process = require("node:child_process");
var import_node_fs2 = require("node:fs");
var import_node_path3 = require("node:path");
var WORKER_PORT = 37778;
var WORKER_BASE_URL = `http://127.0.0.1:${WORKER_PORT}`;
var WAKE_TIMEOUT_MS = 500;
var COMPACT_TIMEOUT_MS = 25e3;
function createAbortSignal(timeoutMs) {
  return AbortSignal.timeout(timeoutMs);
}
function sleep(ms, setTimeoutImpl = setTimeout) {
  return new Promise((resolvePromise) => {
    setTimeoutImpl(resolvePromise, ms);
  });
}
function resolvePluginRoot(env = process.env) {
  if (env.CLAUDE_PLUGIN_ROOT && env.CLAUDE_PLUGIN_ROOT.trim() !== "") {
    return env.CLAUDE_PLUGIN_ROOT;
  }
  const currentDir = (0, import_node_path3.dirname)(__filename);
  if (currentDir.endsWith("/plugin/scripts") || currentDir.endsWith("\\plugin\\scripts")) {
    return (0, import_node_path3.resolve)(currentDir, "..");
  }
  return (0, import_node_path3.resolve)(currentDir, "..", "..", "plugin");
}
function resolveWorkerScriptPaths(env = process.env) {
  const pluginRoot = resolvePluginRoot(env);
  return {
    bunRunnerPath: (0, import_node_path3.join)(pluginRoot, "scripts", "bun-runner.js"),
    workerPath: (0, import_node_path3.join)(pluginRoot, "scripts", "worker.cjs")
  };
}
async function isWorkerHealthy(fetchImpl, timeoutMs) {
  try {
    const response = await fetchImpl(`${WORKER_BASE_URL}/health`, {
      method: "GET",
      signal: createAbortSignal(timeoutMs)
    });
    return response.ok;
  } catch {
    return false;
  }
}
function spawnWorkerProcess(deps = {}, env = process.env) {
  const spawnImpl = deps.spawnImpl ?? import_node_child_process.spawn;
  const existsSyncImpl = deps.existsSyncImpl ?? import_node_fs2.existsSync;
  const { bunRunnerPath, workerPath } = resolveWorkerScriptPaths(env);
  if (!existsSyncImpl(bunRunnerPath) || !existsSyncImpl(workerPath)) {
    return;
  }
  const child = spawnImpl("node", [bunRunnerPath, workerPath], {
    detached: true,
    stdio: "ignore",
    env
  });
  child.unref();
}
async function notifyWorkerWake(deps = {}, env = process.env) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  void (async () => {
    try {
      await fetchImpl(`${WORKER_BASE_URL}/wake`, {
        method: "POST",
        body: "{}",
        signal: createAbortSignal(WAKE_TIMEOUT_MS)
      });
    } catch {
      spawnWorkerProcess(deps, env);
    }
  })();
}
async function waitForWorkerReadiness(deps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const setTimeoutImpl = deps.setTimeoutImpl ?? setTimeout;
  const startedAt = Date.now();
  while (Date.now() - startedAt < HOOK_READINESS_TIMEOUT_MS) {
    if (await isWorkerHealthy(fetchImpl, HOOK_HEALTH_TIMEOUT_MS)) {
      return true;
    }
    await sleep(100, setTimeoutImpl);
  }
  return false;
}
async function notifyWorkerCompact(sessionDbId, transcriptPath, deps = {}, env = process.env) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  if (!await isWorkerHealthy(fetchImpl, HOOK_HEALTH_TIMEOUT_MS)) {
    spawnWorkerProcess(deps, env);
    const ready = await waitForWorkerReadiness(deps);
    if (!ready) {
      throw new Error("Worker did not become ready before compact request.");
    }
  }
  const response = await fetchImpl(`${WORKER_BASE_URL}/compact`, {
    method: "POST",
    body: JSON.stringify({
      session_id: sessionDbId,
      transcript_path: transcriptPath ?? null
    }),
    signal: createAbortSignal(COMPACT_TIMEOUT_MS)
  });
  if (!response.ok) {
    throw new Error(`Worker compact request failed with status ${response.status}.`);
  }
}

// src/hooks/handlers/compact.ts
function createCompactHandler(dependencies) {
  return async function handleCompactHook(input) {
    if (!input.sessionId) {
      return { continue: true };
    }
    const session = getSessionByContentId(dependencies.db, input.sessionId);
    if (!session) {
      return { continue: true };
    }
    await notifyWorkerCompact(
      session.id,
      input.transcriptPath,
      dependencies.workerClientDeps,
      dependencies.workerEnv
    );
    return { continue: true };
  };
}

// src/db/memories.ts
var MEMORY_SELECT = `
  SELECT
    id,
    type,
    scope,
    title,
    content,
    reasoning,
    application,
    tags,
    status,
    superseded_by AS supersededBy,
    expires_at_epoch AS expiresAtEpoch,
    source_turn_id AS sourceTurnId,
    created_at_epoch AS createdAtEpoch,
    updated_at_epoch AS updatedAtEpoch
  FROM memories
`;
function parseJsonArray(value) {
  if (!value) {
    return [];
  }
  return JSON.parse(value);
}
function mapMemoryRow(row) {
  if (!row) {
    return null;
  }
  return {
    ...row,
    tags: parseJsonArray(row.tags)
  };
}
function listMemories(db, options = {}) {
  const clauses = [];
  const params = [];
  if (options.scope) {
    clauses.push("scope = ?");
    params.push(options.scope);
  }
  if (options.type) {
    clauses.push("type = ?");
    params.push(options.type);
  }
  if (options.status) {
    clauses.push("status = ?");
    params.push(options.status);
  }
  const whereClause = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  const boundParams = [...params, options.limit ?? 50];
  return db.query(
    `${MEMORY_SELECT}${whereClause} ORDER BY COALESCE(updated_at_epoch, created_at_epoch) DESC, id DESC LIMIT ?`
  ).all(...boundParams).map((row) => mapMemoryRow(row)).filter((record) => record !== null);
}

// src/db/turns.ts
var TURN_SELECT = `
  SELECT
    id,
    session_id AS sessionId,
    prompt_number AS promptNumber,
    content_prompt_id AS contentPromptId,
    status,
    user_prompt AS userPrompt,
    assistant_response AS assistantResponse,
    title,
    content,
    insight,
    type,
    tags,
    files_read AS filesRead,
    files_modified AS filesModified,
    tool_call_count AS toolCallCount,
    created_at_epoch AS createdAtEpoch,
    updated_at_epoch AS updatedAtEpoch
  FROM turns
`;
function parseJsonArray2(value) {
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
    tags: parseJsonArray2(row.tags),
    filesRead: parseJsonArray2(row.filesRead),
    filesModified: parseJsonArray2(row.filesModified)
  };
}
function getTurnsForSession(db, sessionId) {
  return db.query(
    `${TURN_SELECT} WHERE session_id = ? ORDER BY prompt_number ASC`
  ).all(sessionId).map((row) => mapTurnRow(row)).filter((turn) => turn !== null);
}

// src/mcp/format.ts
var FIELD_TRUNCATION_SUFFIX = "...";
var LEGACY_TRUNCATION_LIMIT = 200;
var UNIFIED_TRUNCATION_LIMITS = {
  collapsed: 120,
  expanded: 300,
  full: 1e3
};
function formatEpoch(epoch) {
  const date = new Date(epoch * 1e3);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
function formatSourceCount(value) {
  const count = normalizeCount(value);
  if (count === 0) {
    return "";
  }
  return `${count} source${count === 1 ? "" : "s"}`;
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
function joinHint(sessionId, turnPromptNumber) {
  if (sessionId === void 0 && turnPromptNumber === void 0) {
    return "";
  }
  if (sessionId === void 0) {
    return "";
  }
  if (turnPromptNumber === void 0) {
    return `replay(id="S${sessionId}", depth="expanded")`;
  }
  return `replay(id="S${sessionId}/T${turnPromptNumber}", depth="expanded")`;
}
function resolveTruncationLimit(depth, mode) {
  if (mode === "legacy") {
    return LEGACY_TRUNCATION_LIMIT;
  }
  return UNIFIED_TRUNCATION_LIMITS[depth];
}
function truncateText(text, {
  depth,
  mode = "legacy",
  sessionId,
  turnPromptNumber
}) {
  const limit = resolveTruncationLimit(depth, mode);
  if (text.length <= limit) {
    return text;
  }
  const hint = mode === "legacy" ? joinHint(sessionId, turnPromptNumber) : "";
  return `${text.slice(0, limit)}${FIELD_TRUNCATION_SUFFIX}${hint ? ` [use ${hint} for full content]` : ""}`;
}
function formatStatus(status) {
  return status ? ` [${status}]` : "";
}
function extractKeyParam(name, input) {
  if (!input || typeof input !== "object") {
    return null;
  }
  const record = input;
  const valueForKey = (...keys) => {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && value.trim() !== "") {
        return value;
      }
    }
    return null;
  };
  switch (name) {
    case "Edit":
    case "Read":
    case "Write":
    case "Glob":
      return valueForKey("file_path", "path");
    case "Bash":
      return valueForKey("command");
    case "Grep": {
      const pattern = valueForKey("pattern");
      const path = valueForKey("path");
      if (pattern && path) {
        return `${pattern} ${path}`;
      }
      return pattern ?? path;
    }
    case "Agent":
      return valueForKey("description");
    default:
      for (const value of Object.values(record)) {
        if (typeof value === "string" && value.trim() !== "") {
          return value;
        }
      }
      return null;
  }
}
function formatSessionCollapsedWithMode(session, mode) {
  const stats = formatSessionStats(session);
  const statsSegment = stats ? ` | ${stats}` : "";
  const lines = [
    `- [S${session.id}] ${session.title ?? "Untitled"}${statsSegment} | ${formatEpoch(session.createdAtEpoch)} | ${session.project}`
  ];
  if (session.content) {
    lines.push(
      `  - desc: ${truncateText(session.content, {
        depth: "collapsed",
        mode,
        sessionId: session.id
      })}`
    );
  }
  return lines.join("\n");
}
function formatSessionExpandedWithMode(session, mode) {
  const lines = [formatSessionCollapsedWithMode(session, mode)];
  if (session.insight && session.insight.length > 0) {
    lines.push("  - insight:");
    pushBullets(
      lines,
      "    ",
      session.insight.map(
        (line) => truncateText(line, {
          depth: "expanded",
          mode,
          sessionId: session.id
        })
      )
    );
  }
  if (session.nextSteps) {
    lines.push("  - next_steps:");
    lines.push(
      `    - ${truncateText(session.nextSteps, {
        depth: "expanded",
        mode,
        sessionId: session.id
      })}`
    );
  }
  return lines.join("\n");
}
function formatTurnLabel(turn, {
  indent = "  ",
  sessionId,
  mode = "legacy",
  depth = "collapsed"
} = {}) {
  const prefix = sessionId === void 0 ? `${indent}- [T${turn.promptNumber}]` : `${indent}- [S${sessionId}][T${turn.promptNumber}]`;
  const stats = formatTurnStats(turn);
  const statsSegment = stats ? ` | ${stats}` : "";
  const rawTitle = turn.title ?? turn.promptPreview ?? "Untitled";
  const title = turn.title === null && turn.promptPreview ? `"${truncateText(turn.promptPreview, {
    depth,
    mode,
    sessionId,
    turnPromptNumber: turn.promptNumber
  })}"` : truncateText(rawTitle, {
    depth,
    mode,
    sessionId,
    turnPromptNumber: turn.promptNumber
  });
  return `${prefix} ${title}${statsSegment}${formatStatus(turn.status)}`;
}
function formatTurnCollapsedWithMode(turn, options = {}) {
  const { indent = "  ", mode = "legacy" } = options;
  const lines = [
    formatTurnLabel(turn, {
      ...options,
      mode,
      depth: "collapsed"
    })
  ];
  if (turn.content) {
    lines.push(
      `${indent}  - desc: ${truncateText(turn.content, {
        depth: "collapsed",
        mode,
        sessionId: options.sessionId,
        turnPromptNumber: turn.promptNumber
      })}`
    );
  }
  return lines.join("\n");
}
function formatToolCallLabel(toolCall, { indent = "    ", mode = "unified", depth = "collapsed" } = {}) {
  const keyParam = toolCall.keyParam ?? extractKeyParam(toolCall.name, toolCall.input);
  const suffix = keyParam ? ` ${truncateText(keyParam, { depth, mode })}` : "";
  return `${indent}- \u{1F527} ${toolCall.name}${suffix}`;
}
function formatToolCallCollapsedWithMode(toolCall, options = {}) {
  return formatToolCallLabel(toolCall, {
    ...options,
    mode: options.mode,
    depth: "collapsed"
  });
}
function formatToolCallExpandedWithMode(toolCall, options = {}) {
  const { indent = "    ", mode = "unified", depth = "expanded" } = options;
  const detailIndent = `${indent}  `;
  const lines = [
    formatToolCallLabel(toolCall, {
      ...options,
      mode,
      depth: depth === "full" ? "full" : "expanded"
    })
  ];
  if (toolCall.input !== void 0) {
    lines.push(
      `${detailIndent}- in: ${truncateText(JSON.stringify(toolCall.input), {
        depth,
        mode
      })}`
    );
  }
  if (toolCall.result) {
    lines.push(
      `${detailIndent}- out: ${truncateText(toolCall.result, {
        depth,
        mode
      })}`
    );
  }
  return lines.join("\n");
}
function renderTurnChildren(turn, depth, options = {}) {
  if (depth === "collapsed") {
    return "";
  }
  const { indent = "  ", sessionId, mode = "legacy" } = options;
  const childIndent = `${indent}  `;
  const childDepth = depth === "full" ? "full" : "expanded";
  const childLines = [];
  if (turn.observations && turn.observations.length > 0) {
    for (const observation of turn.observations) {
      childLines.push(
        childDepth === "full" ? formatObservationExpandedWithMode(observation, {
          indent: childIndent,
          sessionId,
          turnPromptNumber: turn.promptNumber,
          mode,
          depth: "full"
        }) : formatObservationCollapsedWithMode(observation, {
          indent: childIndent,
          sessionId,
          turnPromptNumber: turn.promptNumber,
          mode
        })
      );
    }
    return childLines.join("\n");
  }
  if (turn.toolCalls && turn.toolCalls.length > 0) {
    for (const toolCall of turn.toolCalls) {
      childLines.push(
        formatToolCallExpandedWithMode(toolCall, {
          indent: childIndent,
          sessionId,
          turnPromptNumber: turn.promptNumber,
          mode,
          depth: childDepth
        })
      );
    }
  }
  return childLines.join("\n");
}
function formatTurnExpandedWithMode(turn, options = {}) {
  const {
    indent = "  ",
    mode = "legacy",
    depth = "expanded",
    includeChildren = mode === "unified"
  } = options;
  const detailIndent = `${indent}  `;
  const lines = [formatTurnCollapsedWithMode(turn, { ...options, mode })];
  if (turn.promptPreview) {
    lines.push(
      `${detailIndent}- prompt: "${truncateText(
        turn.promptPreview,
        {
          depth,
          mode,
          sessionId: options.sessionId,
          turnPromptNumber: turn.promptNumber
        }
      )}"`
    );
  }
  if (turn.responsePreview) {
    lines.push(
      `${detailIndent}- response: "${truncateText(
        turn.responsePreview,
        {
          depth,
          mode,
          sessionId: options.sessionId,
          turnPromptNumber: turn.promptNumber
        }
      )}"`
    );
  }
  if (turn.insight && turn.insight.length > 0) {
    lines.push(`${detailIndent}- insight:`);
    pushBullets(
      lines,
      `${detailIndent}  `,
      turn.insight.map(
        (line) => truncateText(line, {
          depth,
          mode,
          sessionId: options.sessionId,
          turnPromptNumber: turn.promptNumber
        })
      )
    );
  }
  if (mode === "unified" && turn.filesRead && turn.filesRead.length > 0) {
    lines.push(
      `${detailIndent}- files_read: ${truncateText(turn.filesRead.join(", "), {
        depth,
        mode,
        sessionId: options.sessionId,
        turnPromptNumber: turn.promptNumber
      })}`
    );
  }
  if (mode === "unified" && turn.filesModified && turn.filesModified.length > 0) {
    lines.push(
      `${detailIndent}- files_modified: ${truncateText(
        turn.filesModified.join(", "),
        {
          depth,
          mode,
          sessionId: options.sessionId,
          turnPromptNumber: turn.promptNumber
        }
      )}`
    );
  }
  const childBlock = includeChildren ? renderTurnChildren(turn, depth, { ...options, mode }) : "";
  if (childBlock) {
    lines.push(childBlock);
  }
  return lines.join("\n");
}
function formatObservationLabel(observation, { indent = "" } = {}) {
  return `${indent}- [O${observation.id}] ${observation.title}`;
}
function formatMemoryLabel(memory, { includeSourceCount = true } = {}) {
  const parts = [
    `- [M${memory.id}] ${memory.type}/${memory.scope}: ${memory.title}`,
    formatEpoch(memory.updatedAtEpoch ?? memory.createdAtEpoch)
  ];
  const sourceCount = includeSourceCount ? formatSourceCount(memory.sourceCount) : "";
  if (sourceCount) {
    parts.push(sourceCount);
  }
  return parts.join(" | ");
}
function formatMemoryCollapsedWithMode(memory, mode) {
  return formatMemoryLabel(memory);
}
function formatMemoryExpandedWithMode(memory, mode) {
  const lines = [formatMemoryLabel(memory, { includeSourceCount: false })];
  lines.push(
    `  - content: ${truncateText(memory.content, {
      depth: "expanded",
      mode
    })}`
  );
  if (memory.reasoning) {
    lines.push(
      `  - reasoning: ${truncateText(memory.reasoning, {
        depth: "expanded",
        mode
      })}`
    );
  }
  if (memory.application) {
    lines.push(
      `  - application: ${truncateText(memory.application, {
        depth: "expanded",
        mode
      })}`
    );
  }
  if (memory.tags && memory.tags.length > 0) {
    lines.push(
      `  - tags: [${truncateText(memory.tags.join(", "), {
        depth: "expanded",
        mode
      })}]`
    );
  }
  if (memory.source) {
    lines.push(
      `  - source: [S${memory.source.sessionId}/T${memory.source.promptNumber}] ${memory.source.title ?? "Untitled"} | ${formatEpoch(memory.source.createdAtEpoch)}`
    );
  }
  return lines.join("\n");
}
function formatObservationCollapsedWithMode(observation, options = {}) {
  const { indent = "", mode = "legacy" } = options;
  const lines = [formatObservationLabel(observation, options)];
  if (observation.content) {
    lines.push(
      `${indent}  - desc: ${truncateText(
        observation.content,
        {
          depth: "collapsed",
          mode,
          sessionId: options.sessionId,
          turnPromptNumber: options.turnPromptNumber
        }
      )}`
    );
  }
  return lines.join("\n");
}
function formatObservationExpandedWithMode(observation, options = {}) {
  const mode = options.mode ?? "legacy";
  const lines = [formatObservationCollapsedWithMode(observation, { ...options, mode })];
  return lines.join("\n");
}
function renderNode(node, options) {
  const mode = options.mode ?? "unified";
  switch (node.type) {
    case "session":
      return options.depth === "collapsed" ? formatSessionCollapsedWithMode(node.value, mode) : formatSessionExpandedWithMode(node.value, mode);
    case "turn":
      return options.depth === "collapsed" ? formatTurnCollapsedWithMode(node.value, options) : formatTurnExpandedWithMode(node.value, options);
    case "observation":
      return options.depth === "collapsed" ? formatObservationCollapsedWithMode(node.value, options) : formatObservationExpandedWithMode(node.value, options);
    case "memory":
      return options.depth === "collapsed" ? formatMemoryCollapsedWithMode(node.value, mode) : formatMemoryExpandedWithMode(node.value, mode);
    case "toolCall":
      return options.depth === "collapsed" ? formatToolCallCollapsedWithMode(node.value, options) : formatToolCallExpandedWithMode(node.value, options);
  }
}

// src/hooks/handlers/context.ts
var EMPTY_CONTEXT_FALLBACK = "claude-mnemo memory available via recall() and replay().";
function splitInsight(insight) {
  if (!insight) {
    return [];
  }
  return insight.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => line.replace(/^-+\s*/, ""));
}
function buildHeader(db) {
  const sessionCount = db.query("SELECT COUNT(*) AS count FROM sessions").get()?.count ?? 0;
  const observationCount = db.query("SELECT COUNT(*) AS count FROM observations").get()?.count ?? 0;
  return [
    `claude-mnemo: ${sessionCount} sessions, ${observationCount} observations`,
    "Types: \u{1F534}bugfix \u{1F7E3}feature \u{1F504}refactor \u2705change \u{1F535}discovery \u2696\uFE0Fdecision",
    "Stats: \u{1F4AC}turns \u{1F4A1}observations \u{1F4D6}read \u270F\uFE0Fmodified \u{1F527}tools",
    "Format:",
    "  - [Sx] title | \u{1F4AC}n \u{1F4A1}n | yyyy-mm-dd | project",
    "  - [Tx] title | \u{1F4A1}n \u{1F4D6}n \u270F\uFE0Fn \u{1F527}n",
    "  - [Ox] \u{1F535} title",
    "  - [Mx] type/scope: title | yyyy-mm-dd | sources",
    'Expand: recall(id="Sx/Ty", depth="expanded") | Raw: replay(id="Sx/Ty", depth="expanded")'
  ].join("\n");
}
function resolvePrimarySessionRecord(db, input, recentSessions) {
  const currentSession = input.sessionId ? getSessionByContentId(db, input.sessionId) : null;
  return currentSession ?? recentSessions[0] ?? null;
}
function buildSessionMetricMap(db, sessionIds) {
  if (sessionIds.length === 0) {
    return /* @__PURE__ */ new Map();
  }
  const placeholders = sessionIds.map(() => "?").join(", ");
  const metrics = /* @__PURE__ */ new Map();
  for (const sessionId of sessionIds) {
    metrics.set(sessionId, { turnCount: 0, observationCount: 0 });
  }
  const turnRows = db.query(
    `SELECT session_id AS sessionId, COUNT(*) AS count
       FROM turns
       WHERE session_id IN (${placeholders})
       GROUP BY session_id`
  ).all(...sessionIds);
  for (const row of turnRows) {
    const metric = metrics.get(row.sessionId);
    if (metric) {
      metric.turnCount = row.count;
    }
  }
  const observationRows = db.query(
    `SELECT t.session_id AS sessionId, COUNT(*) AS count
       FROM observations o
       JOIN turns t ON t.id = o.turn_id
       WHERE t.session_id IN (${placeholders})
       GROUP BY t.session_id`
  ).all(...sessionIds);
  for (const row of observationRows) {
    const metric = metrics.get(row.sessionId);
    if (metric) {
      metric.observationCount = row.count;
    }
  }
  return metrics;
}
function buildSessionView(session, metrics) {
  return {
    id: session.id,
    title: session.title,
    project: session.project,
    createdAtEpoch: session.createdAtEpoch,
    content: session.content,
    insight: splitInsight(session.insight),
    nextSteps: session.nextSteps,
    turnCount: metrics?.turnCount ?? 0,
    observationCount: metrics?.observationCount ?? 0
  };
}
function getObservationCountByTurnId(db, turnIds) {
  if (turnIds.length === 0) {
    return /* @__PURE__ */ new Map();
  }
  const placeholders = turnIds.map(() => "?").join(", ");
  const rows = db.query(
    `SELECT turn_id AS turnId, COUNT(*) AS count
       FROM observations
       WHERE turn_id IN (${placeholders})
       GROUP BY turn_id`
  ).all(...turnIds);
  return new Map(rows.map((row) => [row.turnId, row.count]));
}
function buildCollapsedTurnViews(db, sessionId) {
  const turns = getTurnsForSession(db, sessionId);
  const observationCounts = getObservationCountByTurnId(
    db,
    turns.map((turn) => turn.id)
  );
  return turns.map((turn) => ({
    id: turn.id,
    promptNumber: turn.promptNumber,
    title: turn.title,
    content: turn.content,
    observationCount: observationCounts.get(turn.id) ?? 0,
    toolCallCount: turn.toolCallCount,
    filesReadCount: turn.filesRead.length,
    filesModifiedCount: turn.filesModified.length,
    status: turn.status
  }));
}
function buildCurrentSessionOutput(session, turns) {
  const lines = [
    renderNode(
      { type: "session", value: session },
      { depth: "expanded", mode: "legacy" }
    )
  ];
  for (const turn of turns) {
    lines.push(
      renderNode(
        { type: "turn", value: turn },
        { depth: "collapsed", mode: "legacy" }
      )
    );
  }
  return lines.join("\n");
}
function buildRecentSessionsOutput(recentSessions, sessionMetrics, primarySessionId) {
  const others = recentSessions.filter((session) => session.id !== primarySessionId).slice(0, 4);
  return others.map((session) => buildSessionView(session, sessionMetrics.get(session.id))).map(
    (session) => renderNode(
      { type: "session", value: session },
      { depth: "collapsed", mode: "legacy" }
    )
  );
}
function buildMemoryView(memory) {
  return {
    id: memory.id,
    type: memory.type,
    scope: memory.scope,
    title: memory.title,
    content: memory.content,
    reasoning: memory.reasoning,
    application: memory.application,
    tags: memory.tags,
    createdAtEpoch: memory.createdAtEpoch,
    updatedAtEpoch: memory.updatedAtEpoch,
    sourceCount: memory.sourceTurnId !== null ? 1 : 0,
    source: null
  };
}
function mergeMemoryLists(...memoryLists) {
  const seen = /* @__PURE__ */ new Set();
  const merged = [];
  for (const list of memoryLists) {
    for (const memory of list) {
      if (seen.has(memory.id)) {
        continue;
      }
      seen.add(memory.id);
      merged.push(memory);
    }
  }
  return merged.sort((left, right) => {
    const leftTimestamp = left.updatedAtEpoch ?? left.createdAtEpoch;
    const rightTimestamp = right.updatedAtEpoch ?? right.createdAtEpoch;
    if (rightTimestamp !== leftTimestamp) {
      return rightTimestamp - leftTimestamp;
    }
    return right.id - left.id;
  }).slice(0, 50);
}
function buildMemoriesOutput(db, projectScope) {
  const memories = mergeMemoryLists(
    listMemories(db, {
      scope: "global",
      status: "active",
      limit: 50
    }),
    projectScope ? listMemories(db, {
      scope: projectScope,
      status: "active",
      limit: 50
    }) : []
  );
  if (memories.length === 0) {
    return [];
  }
  return [
    "## Memories",
    "",
    ...memories.map(
      (memory) => renderNode(
        { type: "memory", value: buildMemoryView(memory) },
        { depth: "collapsed", mode: "legacy" }
      )
    )
  ];
}
function buildContextOutput(db, input) {
  const recentSessions = getRecentSessions(db, { limit: 5 });
  const primarySessionRecord = resolvePrimarySessionRecord(
    db,
    input,
    recentSessions
  );
  if (!primarySessionRecord) {
    return EMPTY_CONTEXT_FALLBACK;
  }
  const sessionIds = Array.from(
    /* @__PURE__ */ new Set([...recentSessions.map((session) => session.id), primarySessionRecord.id])
  );
  const sessionMetrics = buildSessionMetricMap(db, sessionIds);
  const primarySession = buildSessionView(
    primarySessionRecord,
    sessionMetrics.get(primarySessionRecord.id)
  );
  const primaryTurns = buildCollapsedTurnViews(db, primarySessionRecord.id);
  const memories = buildMemoriesOutput(
    db,
    primarySessionRecord.project
  );
  const recentSessionOutputs = buildRecentSessionsOutput(
    recentSessions,
    sessionMetrics,
    primarySessionRecord.id
  );
  return [
    buildHeader(db),
    "",
    ...memories,
    ...memories.length > 0 ? [""] : [],
    "## Current Session",
    "",
    buildCurrentSessionOutput(primarySession, primaryTurns),
    "",
    "## Recent Sessions",
    "",
    ...recentSessionOutputs
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

// src/shared/tag-stripping.ts
var MAX_TAG_OCCURRENCES = 100;
function stripTag(text, tagName) {
  const openTagPattern = new RegExp(`<${tagName}\\b`, "g");
  const matches = text.match(openTagPattern);
  if ((matches?.length ?? 0) > MAX_TAG_OCCURRENCES) {
    return text;
  }
  return text.replace(
    new RegExp(`<${tagName}\\b[^>]*>[\\s\\S]*?<\\/${tagName}>`, "g"),
    ""
  );
}
function stripPrivateTags(text) {
  return stripTag(text, "private");
}

// src/hooks/handlers/post-tool-use.ts
function stringifyToolPayload(value) {
  if (value === void 0) {
    return null;
  }
  const normalized = typeof value === "string" ? value : JSON.stringify(value);
  return stripPrivateTags(normalized);
}
function getLatestTurnId(db, sessionDbId) {
  const row = db.query(
    `SELECT id FROM turns WHERE session_id = ? ORDER BY prompt_number DESC LIMIT 1`
  ).get(sessionDbId);
  return row?.id ?? null;
}
function createPostToolUseHandler(dependencies) {
  const now = dependencies.now ?? (() => Math.floor(Date.now() / 1e3));
  return async function handlePostToolUseHook(input) {
    if (!input.sessionId || !input.toolName) {
      return { continue: true };
    }
    const session = getSessionByContentId(dependencies.db, input.sessionId);
    if (!session) {
      return { continue: true };
    }
    const latestTurnId = getLatestTurnId(dependencies.db, session.id);
    if (!latestTurnId) {
      return { continue: true };
    }
    const createdAtEpoch = now();
    const toolName = input.toolName;
    const toolInput = stringifyToolPayload(input.toolInput);
    const toolResult = stringifyToolPayload(input.toolResponse);
    dependencies.db.transaction(() => {
      const inserted = dependencies.db.query(
        `
            INSERT INTO observations (
              turn_id,
              tool_name,
              tool_input,
              tool_result,
              created_at_epoch
            ) VALUES (?, ?, ?, ?, ?)
            RETURNING id
          `
      ).get(
        latestTurnId,
        toolName,
        toolInput,
        toolResult,
        createdAtEpoch
      );
      if (!inserted) {
        throw new Error("Failed to enqueue observation for worker processing.");
      }
      dependencies.db.query(
        `
            INSERT INTO pending_queue (
              kind,
              target_id,
              session_db_id,
              enqueued_at_epoch
            ) VALUES ('obs', ?, ?, ?)
          `
      ).run(inserted.id, session.id, createdAtEpoch);
    })();
    await notifyWorkerWake(
      dependencies.workerClientDeps,
      dependencies.workerEnv
    );
    return { continue: true };
  };
}

// src/shared/transcript-parser.ts
var import_node_fs3 = require("node:fs");
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
function readTranscriptEntries(transcriptPath) {
  return readAllTranscriptEntries(transcriptPath).filter(
    (entry) => !entry.isSidechain && !entry.isApiErrorMessage
  );
}
function readAllTranscriptEntries(transcriptPath) {
  if (!(0, import_node_fs3.existsSync)(transcriptPath)) {
    return [];
  }
  const rawTranscript = (0, import_node_fs3.readFileSync)(transcriptPath, "utf8");
  if (rawTranscript.trim() === "") {
    return [];
  }
  const entries = rawTranscript.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => normalizeEntry(JSON.parse(line))).filter((entry) => !entry.isApiErrorMessage);
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
    role: typeof message?.role === "string" ? message.role : typeof raw.role === "string" ? raw.role : typeof raw.type === "string" ? raw.type : void 0,
    content: typeof message?.content === "string" || Array.isArray(message?.content) ? message.content : typeof raw.content === "string" || Array.isArray(raw.content) ? raw.content : void 0,
    promptId: typeof raw.promptId === "string" ? raw.promptId : void 0,
    uuid: typeof raw.uuid === "string" ? raw.uuid : void 0,
    permissionMode: typeof raw.permissionMode === "string" ? raw.permissionMode : void 0,
    isSidechain: Boolean(raw.isSidechain),
    isApiErrorMessage: Boolean(raw.isApiErrorMessage)
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
function parseTranscript(transcriptPath) {
  const turns = [];
  let promptNumber = 0;
  let currentTurn = null;
  let currentPromptId = null;
  for (const entry of readTranscriptEntries(transcriptPath)) {
    if (startsNewTurn(entry, currentPromptId)) {
      const userPrompt = extractUserPrompt(entry);
      promptNumber += 1;
      currentPromptId = entry.promptId ?? null;
      currentTurn = {
        promptNumber,
        userPrompt,
        assistantText: "",
        toolCalls: []
      };
      turns.push(currentTurn);
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
    currentTurn.toolCalls.push(...toolCalls);
  }
  return turns.map((turn) => ({
    ...turn,
    assistantText: normalizeAssistantText(turn.assistantText)
  }));
}
function countUserPromptsInTranscript(transcriptPath) {
  const seenPromptIds = /* @__PURE__ */ new Set();
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
function extractAssistantResponse(transcriptPath, userPromptPrefix, promptNumber) {
  const turns = parseTranscript(transcriptPath);
  const turn = (promptNumber !== void 0 ? turns.find((candidate) => candidate.promptNumber === promptNumber) : void 0) ?? turns.find((candidate) => candidate.userPrompt.startsWith(userPromptPrefix));
  return turn?.assistantText ?? "";
}

// src/hooks/handlers/session-init.ts
function createPendingTurn(db, sessionId, promptNumber, prompt, createdAtEpoch) {
  db.query(
    `INSERT INTO turns (
      session_id,
      prompt_number,
      status,
      user_prompt,
      created_at_epoch
    ) VALUES (?, ?, 'active', ?, ?)`
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
      content: existingSession?.content ?? null,
      insight: existingSession?.insight ?? null,
      createdAtEpoch: existingSession?.createdAtEpoch ?? now(),
      updatedAtEpoch: now(),
      completedAtEpoch: existingSession?.completedAtEpoch ?? null
    });
    const promptNumber = input.transcriptPath ? countUserPromptsInTranscript(input.transcriptPath) + 1 : getTurnsForSession(dependencies.db, session.id).length + 1;
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

// src/db/pending-queue.ts
function enqueueQueueItem(db, input) {
  const inserted = db.query(
    `
        INSERT INTO pending_queue (
          kind,
          target_id,
          session_db_id,
          enqueued_at_epoch
        ) VALUES (?, ?, ?, ?)
        RETURNING
          seq,
          kind,
          target_id AS targetId,
          session_db_id AS sessionDbId,
          claimed_at_epoch AS claimedAtEpoch,
          enqueued_at_epoch AS enqueuedAtEpoch
      `
  ).get(
    input.kind,
    input.targetId,
    input.sessionDbId,
    input.enqueuedAtEpoch
  );
  if (!inserted) {
    throw new Error("Failed to enqueue pending queue item.");
  }
  return inserted;
}

// src/hooks/handlers/stop.ts
function getLatestTurn(db, sessionDbId) {
  const row = db.query(
    `
        SELECT id, prompt_number AS promptNumber
        FROM turns
        WHERE session_id = ?
        ORDER BY prompt_number DESC
        LIMIT 1
      `
  ).get(sessionDbId);
  return row ?? null;
}
function getOrphanTurns(db, sessionDbId, currentTurnId) {
  return db.query(
    `
        SELECT
          t.id,
          t.prompt_number AS promptNumber,
          t.user_prompt AS userPrompt
        FROM turns t
        WHERE t.session_id = ?
          AND t.status = 'active'
          AND t.id < ?
          AND t.assistant_response IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM pending_queue q
            WHERE q.kind = 'turn-stop' AND q.target_id = t.id
          )
        ORDER BY t.prompt_number ASC
      `
  ).all(sessionDbId, currentTurnId);
}
function hasTurnStopTask(db, turnId) {
  return db.query(
    `
          SELECT EXISTS(
            SELECT 1
            FROM pending_queue
            WHERE kind = 'turn-stop' AND target_id = ?
          ) AS existsRow
        `
  ).get(turnId)?.existsRow === 1;
}
function createStopHandler(dependencies) {
  const now = dependencies.now ?? (() => Math.floor(Date.now() / 1e3));
  return async function handleStopHook(input) {
    if (input.stopHookActive || !input.sessionId) {
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
    const turn = getLatestTurn(dependencies.db, session.id);
    if (!turn) {
      return {
        continue: true,
        exitCode: HOOK_SUCCESS_EXIT_CODE
      };
    }
    const epoch = now();
    const assistantResponse = input.lastAssistantMessage !== void 0 ? stripPrivateTags(input.lastAssistantMessage) : null;
    const orphanTurns = getOrphanTurns(dependencies.db, session.id, turn.id);
    dependencies.db.transaction(() => {
      for (const orphanTurn of orphanTurns) {
        const orphanAssistantResponse = input.transcriptPath && orphanTurn.userPrompt ? extractAssistantResponse(
          input.transcriptPath,
          orphanTurn.userPrompt,
          orphanTurn.promptNumber
        ) : "";
        dependencies.db.query(
          `
              UPDATE turns
              SET assistant_response = ?,
                  updated_at_epoch = ?
              WHERE id = ?
            `
        ).run(orphanAssistantResponse, epoch, orphanTurn.id);
        enqueueQueueItem(dependencies.db, {
          kind: "turn-stop",
          targetId: orphanTurn.id,
          sessionDbId: session.id,
          enqueuedAtEpoch: epoch
        });
      }
      dependencies.db.query(
        `
            UPDATE turns
            SET assistant_response = COALESCE(?, assistant_response),
                updated_at_epoch = ?
            WHERE id = ?
          `
      ).run(assistantResponse, epoch, turn.id);
      if (!hasTurnStopTask(dependencies.db, turn.id)) {
        enqueueQueueItem(dependencies.db, {
          kind: "turn-stop",
          targetId: turn.id,
          sessionDbId: session.id,
          enqueuedAtEpoch: epoch
        });
      }
    })();
    upsertSession(dependencies.db, {
      contentSessionId: session.contentSessionId,
      project: session.project,
      title: session.title,
      content: session.content,
      insight: session.insight,
      nextSteps: session.nextSteps,
      createdAtEpoch: session.createdAtEpoch,
      updatedAtEpoch: epoch,
      completedAtEpoch: epoch
    });
    await notifyWorkerWake(
      dependencies.workerClientDeps,
      dependencies.workerEnv
    );
    return {
      continue: true,
      exitCode: HOOK_SUCCESS_EXIT_CODE
    };
  };
}

// src/hooks/hook-command.ts
var defaultHandlers;
function getDefaultHandlers() {
  if (defaultHandlers) {
    return defaultHandlers;
  }
  const db = createDatabase();
  initializeDatabase(db);
  defaultHandlers = {
    SessionStart: createContextHandler({ db }),
    PostToolUse: createPostToolUseHandler({ db }),
    PreCompact: createCompactHandler({ db }),
    UserPromptSubmit: createSessionInitHandler({ db }),
    Stop: createStopHandler({
      db
    })
  };
  return defaultHandlers;
}
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
    case "tool-use":
      return "PostToolUse";
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
function writeHookResult(result, stdout = process.stdout) {
  const output = {
    continue: result.continue
  };
  if (result.suppressOutput !== void 0) {
    output.suppressOutput = result.suppressOutput;
  }
  if (result.hookSpecificOutput !== void 0) {
    output.hookSpecificOutput = {
      hookEventName: "SessionStart",
      additionalContext: result.hookSpecificOutput
    };
  }
  if (Object.keys(output).length > 1 || output.continue !== true) {
    stdout.write(JSON.stringify(output));
  }
}
async function runHookCommand(dependencies = {}) {
  const env = dependencies.env ?? process.env;
  const argv = dependencies.argv ?? process.argv;
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const readJson = dependencies.readJsonFromStdin ?? readJsonFromStdin;
  const normalizeInput = dependencies.normalizeHookInputImpl ?? normalizeHookInput;
  if (env.CLAUDE_CODE_ENTRYPOINT === "sdk-ts") {
    return HOOK_SUCCESS_EXIT_CODE;
  }
  try {
    const rawInput = readJson();
    const eventNameOverride = eventNameFromCommandArgument(argv[2]);
    if (eventNameOverride && !("event_name" in rawInput) && !("hook_event_name" in rawInput)) {
      rawInput.event_name = eventNameOverride;
    }
    const normalizedInput = normalizeInput(rawInput);
    const handler = (dependencies.handlers ?? getDefaultHandlers())[normalizedInput.eventName];
    if (!handler) {
      return HOOK_SUCCESS_EXIT_CODE;
    }
    const result = await handler(normalizedInput);
    if (result.asyncWork) {
      stdout.write(`${JSON.stringify({ async: true })}
`);
      await result.asyncWork();
      return HOOK_SUCCESS_EXIT_CODE;
    }
    writeHookResult(result, stdout);
    return result.exitCode ?? HOOK_SUCCESS_EXIT_CODE;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown hook failure";
    stderr.write(`[HOOK] ${message}
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
