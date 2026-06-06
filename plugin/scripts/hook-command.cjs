#!/usr/bin/env node
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
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
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
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
function encodeProjectPath(projectPath) {
  return projectPath.replace(/[/:\\.]/g, "-");
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
var DEFAULT_BUSY_TIMEOUT_MS = 5e3;
var DEFAULT_HOOK_TRANSACTION_BUDGET_MS = 2500;
function resolveDatabasePath2(path2) {
  if (!path2 || path2.trim() === "") {
    return resolveDatabasePath();
  }
  return resolveDatabasePath(path2);
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
function normalizeNonNegativeMilliseconds(value, name) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number`);
  }
  return Math.floor(value);
}
function syncSleep(ms) {
  if (ms <= 0) {
    return;
  }
  const wakeSignal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(wakeSignal, 0, 0, ms);
}
function hookWriteBackoffMs(attempt) {
  return Math.min(100, 25 * 2 ** attempt);
}
function configureDatabase(db, options) {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA mmap_size = 268435456;");
  db.exec("PRAGMA cache_size = 10000;");
  db.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs};`);
}
function createDatabase(path2, options = {}) {
  const databasePath = resolveDatabasePath2(path2);
  const busyTimeoutMs = normalizeNonNegativeMilliseconds(
    options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
    "busyTimeoutMs"
  );
  ensureParentDirectory(databasePath);
  const db = new import_bun_sqlite.Database(databasePath);
  configureDatabase(db, { busyTimeoutMs });
  return db;
}
function isSqliteBusy(err) {
  const code = typeof err === "object" && err !== null && "code" in err ? String(err.code) : "";
  if (code === "SQLITE_BUSY" || code === "SQLITE_BUSY_SNAPSHOT") {
    return true;
  }
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return /\bSQLITE_BUSY(?:_SNAPSHOT)?\b/.test(message) || /\bdatabase is locked\b/i.test(message) || /\bdatabase table is locked\b/i.test(message);
}
function runHookWriteTransaction(db, fn, options = {}) {
  const txn = db.transaction(fn);
  const budgetMs = normalizeNonNegativeMilliseconds(
    options.budgetMs ?? DEFAULT_HOOK_TRANSACTION_BUDGET_MS,
    "budgetMs"
  );
  const now = options.now ?? Date.now;
  const sleep2 = options.sleep ?? syncSleep;
  const backoffMs = options.backoffMs ?? ((attempt) => hookWriteBackoffMs(attempt));
  const start = now();
  for (let attempt = 0; ; attempt += 1) {
    try {
      return txn.immediate();
    } catch (err) {
      if (!isSqliteBusy(err)) {
        throw err;
      }
      const elapsedMs = Math.max(0, now() - start);
      if (elapsedMs >= budgetMs) {
        throw err;
      }
      const delayMs = normalizeNonNegativeMilliseconds(
        backoffMs(attempt, elapsedMs),
        "backoffMs"
      );
      const remainingMs = budgetMs - elapsedMs;
      if (delayMs >= remainingMs) {
        throw err;
      }
      sleep2(delayMs);
    }
  }
}

// src/db/search.ts
function indexFtsRecord(db, layer, sourceId, title, content, extra, prompt, response) {
  db.query("DELETE FROM memory_fts WHERE layer = ? AND source_id = ?").run(
    layer,
    sourceId
  );
  db.query(
    "INSERT INTO memory_fts (layer, source_id, title, content, extra, prompt, response) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(layer, sourceId, title, content, extra, prompt ?? "", response ?? "");
}
function indexSessionToFTS(db, session) {
  const hasNewFields = [
    session.decision,
    session.done,
    session.current,
    session.reference
  ].some((value) => Boolean(value && value.trim()));
  const hasLegacyInsight = Boolean(session.insight && session.insight.trim());
  const extra = !hasNewFields && hasLegacyInsight ? session.insight : [
    session.decision,
    session.done,
    session.current,
    session.nextSteps,
    session.reference
  ].filter((value) => Boolean(value && value.trim())).join("\n");
  indexFtsRecord(
    db,
    "session",
    session.id,
    session.title,
    session.content,
    extra,
    null,
    null
  );
}
function indexTurnToFTS(db, turn) {
  indexFtsRecord(
    db,
    "turn",
    turn.id,
    turn.title,
    turn.content,
    turn.insight ?? "",
    turn.userPrompt,
    turn.assistantResponse
  );
}
function indexObservationToFTS(db, observation) {
  indexFtsRecord(
    db,
    "observation",
    observation.id,
    observation.title,
    observation.content,
    "",
    null,
    null
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
          insight,
          decision,
          done,
          "current" AS current,
          next_steps AS nextSteps,
          "reference" AS reference
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
          insight,
          user_prompt AS userPrompt,
          assistant_response AS assistantResponse
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
}

// src/db/schema.ts
var MEMORY_FTS_DDL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    layer UNINDEXED,
    source_id UNINDEXED,
    title,
    content,
    extra,
    prompt,
    response,
    tokenize = 'trigram'
  );
`;
var SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_session_id TEXT UNIQUE NOT NULL,
    project TEXT NOT NULL,
    title TEXT,
    content TEXT,
    insight TEXT,
    next_steps TEXT,
    decision TEXT,
    done TEXT,
    current TEXT,
    reference TEXT,
    last_compact_turn INTEGER,
    last_agent_session_id TEXT,
    summary_updated_at_epoch INTEGER,
    created_at_epoch INTEGER NOT NULL,
    updated_at_epoch INTEGER,
    completed_at_epoch INTEGER
  );

  CREATE TABLE IF NOT EXISTS turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    prompt_number INTEGER NOT NULL,
    content_prompt_id TEXT,
    was_interrupted INTEGER NOT NULL DEFAULT 0,
    was_rolled_back INTEGER NOT NULL DEFAULT 0,
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
    transcript_line_start INTEGER,
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

  ${MEMORY_FTS_DDL}
`;
function initializeSchema(db) {
  db.exec(SCHEMA_SQL);
  ensureSessionLastAgentSessionIdColumn(db);
  ensureSessionSummaryUpdatedAtEpochColumn(db);
  ensureSessionSummaryFieldColumns(db);
  ensureTurnTranscriptLineStartColumn(db);
  ensureTurnInvalidationColumns(db);
  ensureForkLineageColumns(db);
  ensureSearchIndexSchema(db);
  ensureSessionProjectIndex(db);
  ensureTurnPromptIdIndex(db);
  dropLegacyMemoriesTable(db);
}
function ensureSessionLastAgentSessionIdColumn(db) {
  if (hasColumn(db, "sessions", "last_agent_session_id")) {
    return;
  }
  db.exec("ALTER TABLE sessions ADD COLUMN last_agent_session_id TEXT");
}
function ensureSessionSummaryUpdatedAtEpochColumn(db) {
  if (hasColumn(db, "sessions", "summary_updated_at_epoch")) {
    return;
  }
  db.exec("ALTER TABLE sessions ADD COLUMN summary_updated_at_epoch INTEGER");
}
function ensureSessionSummaryFieldColumns(db) {
  for (const column of ["decision", "done", "current", "reference"]) {
    if (!hasColumn(db, "sessions", column)) {
      db.exec(`ALTER TABLE sessions ADD COLUMN "${column}" TEXT`);
    }
  }
}
function ensureTurnTranscriptLineStartColumn(db) {
  if (hasColumn(db, "turns", "transcript_line_start")) {
    return;
  }
  db.exec("ALTER TABLE turns ADD COLUMN transcript_line_start INTEGER");
}
function ensureTurnInvalidationColumns(db) {
  if (!hasColumn(db, "turns", "was_interrupted")) {
    db.exec(
      "ALTER TABLE turns ADD COLUMN was_interrupted INTEGER NOT NULL DEFAULT 0"
    );
  }
  if (!hasColumn(db, "turns", "was_rolled_back")) {
    db.exec(
      "ALTER TABLE turns ADD COLUMN was_rolled_back INTEGER NOT NULL DEFAULT 0"
    );
  }
}
function ensureForkLineageColumns(db) {
  if (!hasColumn(db, "turns", "parent_turn_id")) {
    db.exec("ALTER TABLE turns ADD COLUMN parent_turn_id INTEGER");
    backfillAllIntraChains(db);
  }
  if (!hasColumn(db, "sessions", "parent_session_id"))
    db.exec("ALTER TABLE sessions ADD COLUMN parent_session_id INTEGER");
  if (!hasColumn(db, "sessions", "lineage_status"))
    db.exec("ALTER TABLE sessions ADD COLUMN lineage_status TEXT NOT NULL DEFAULT 'unchecked'");
}
function backfillAllIntraChains(db) {
  db.query(
    `UPDATE turns SET parent_turn_id = (
       SELECT p.id FROM turns p
       WHERE p.session_id = turns.session_id AND p.prompt_number < turns.prompt_number
       ORDER BY p.prompt_number DESC LIMIT 1
     )
     WHERE parent_turn_id IS NULL
       AND EXISTS (
         SELECT 1 FROM turns p
         WHERE p.session_id = turns.session_id AND p.prompt_number < turns.prompt_number
       )`
  ).run();
}
var EXPECTED_FTS_COLUMNS = [
  "layer",
  "source_id",
  "title",
  "content",
  "extra",
  "prompt",
  "response"
];
function ensureSearchIndexSchema(db) {
  const row = db.query(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_fts'"
  ).get();
  const isCurrent = row !== null && row.sql.includes("trigram") && EXPECTED_FTS_COLUMNS.every((column) => hasColumn(db, "memory_fts", column));
  if (isCurrent) {
    return;
  }
  db.exec("DROP TABLE IF EXISTS memory_fts");
  db.exec(MEMORY_FTS_DDL);
  rebuildSearchIndex(db);
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
function dropLegacyMemoriesTable(db) {
  db.exec("DROP TABLE IF EXISTS memories");
  db.exec("DELETE FROM memory_fts WHERE layer = 'memory'");
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
    { table: "observations", layer: "observation" }
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
    case "PostCompact":
    case "SessionStart":
    case "SessionEnd":
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
    decision,
    done,
    "current" AS current,
    "reference" AS reference,
    last_compact_turn AS lastCompactTurn,
    last_agent_session_id AS lastAgentSessionId,
    summary_updated_at_epoch AS summaryUpdatedAtEpoch,
    parent_session_id AS parentSessionId,
    lineage_status AS lineageStatus,
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
        summary_updated_at_epoch,
        created_at_epoch,
        updated_at_epoch,
        completed_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(content_session_id) DO UPDATE SET
        project = excluded.project,
        title = COALESCE(excluded.title, sessions.title),
        content = COALESCE(excluded.content, sessions.content),
        insight = COALESCE(excluded.insight, sessions.insight),
        next_steps = COALESCE(excluded.next_steps, sessions.next_steps),
        last_compact_turn = COALESCE(excluded.last_compact_turn, sessions.last_compact_turn),
        summary_updated_at_epoch = COALESCE(excluded.summary_updated_at_epoch, sessions.summary_updated_at_epoch),
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
        decision,
        done,
        "current" AS current,
        "reference" AS reference,
        last_compact_turn AS lastCompactTurn,
        last_agent_session_id AS lastAgentSessionId,
        summary_updated_at_epoch AS summaryUpdatedAtEpoch,
        parent_session_id AS parentSessionId,
        lineage_status AS lineageStatus,
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
    input.summaryUpdatedAtEpoch ?? null,
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
function getSession(db, id) {
  return db.query(`${SESSION_SELECT} WHERE id = ?`).get(id) ?? null;
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
function setSessionParent(db, sessionId, parentSessionId) {
  db.query(
    `UPDATE sessions SET parent_session_id = ? WHERE id = ?`
  ).run(parentSessionId, sessionId);
}
function setSessionLineageStatus(db, sessionId, status) {
  db.query(
    `UPDATE sessions SET lineage_status = ? WHERE id = ?`
  ).run(status, sessionId);
}

// src/worker/client.ts
var import_node_child_process = require("node:child_process");
var import_node_fs2 = require("node:fs");
var import_node_path3 = require("node:path");

// src/shared/build-id.ts
var BUILD_ID = true ? "0.2.28-mq2h0c4i" : "dev";

// src/worker/client.ts
var WORKER_PORT = 37778;
var WORKER_BASE_URL = `http://127.0.0.1:${WORKER_PORT}`;
var WAKE_TIMEOUT_MS = 500;
var FLUSH_TIMEOUT_MS = 500;
var COMPACT_TIMEOUT_MS = 5e3;
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
async function readWorkerHealth(fetchImpl, timeoutMs) {
  try {
    const response = await fetchImpl(`${WORKER_BASE_URL}/health`, {
      method: "GET",
      signal: createAbortSignal(timeoutMs)
    });
    if (!response.ok) {
      return { status: "down" };
    }
    let body;
    try {
      body = await response.json();
    } catch {
      return { status: "compatible" };
    }
    if (body.buildId && body.buildId !== BUILD_ID) {
      return {
        status: "stale",
        pid: typeof body.pid === "number" && body.pid > 0 ? body.pid : void 0
      };
    }
    return {
      status: "compatible",
      pid: typeof body.pid === "number" && body.pid > 0 ? body.pid : void 0
    };
  } catch {
    return { status: "down" };
  }
}
function readWorkerPidFallback(deps = {}) {
  const pidPath = deps.pidPath ?? WORKER_PID_PATH;
  const existsSyncImpl = deps.existsSyncImpl ?? import_node_fs2.existsSync;
  if (!existsSyncImpl(pidPath)) {
    return null;
  }
  try {
    const pid = Number((0, import_node_fs2.readFileSync)(pidPath, "utf8").trim());
    if (Number.isInteger(pid) && pid > 0) {
      return pid;
    }
  } catch {
  }
  return null;
}
function killWorkerPid(pid) {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
  }
}
function logUnrecoverableStaleWorker() {
  console.error("stale worker detected but no pid handle is available");
}
function resolveStaleWorkerPid(health, deps = {}) {
  if (health.status !== "stale") {
    return null;
  }
  if (typeof health.pid === "number") {
    return health.pid;
  }
  return readWorkerPidFallback(deps);
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
async function waitForWorkerDown(deps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const setTimeoutImpl = deps.setTimeoutImpl ?? setTimeout;
  const nowMs = deps.nowMsImpl ?? Date.now;
  const startedAt = nowMs();
  while (nowMs() - startedAt < HOOK_READINESS_TIMEOUT_MS) {
    const health = await readWorkerHealth(fetchImpl, HOOK_HEALTH_TIMEOUT_MS);
    if (health.status === "down") {
      return true;
    }
    await sleep(100, setTimeoutImpl);
  }
  return false;
}
async function waitForCompatibleWorker(deps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const setTimeoutImpl = deps.setTimeoutImpl ?? setTimeout;
  const nowMs = deps.nowMsImpl ?? Date.now;
  const startedAt = nowMs();
  while (nowMs() - startedAt < HOOK_READINESS_TIMEOUT_MS) {
    const health = await readWorkerHealth(fetchImpl, HOOK_HEALTH_TIMEOUT_MS);
    if (health.status === "compatible") {
      return true;
    }
    await sleep(100, setTimeoutImpl);
  }
  return false;
}
async function ensureCompatibleWorker(deps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const health = await readWorkerHealth(fetchImpl, HOOK_HEALTH_TIMEOUT_MS);
  if (health.status === "compatible") {
    return "compatible";
  }
  if (health.status === "down") {
    return "down";
  }
  const pid = resolveStaleWorkerPid(health, deps);
  if (!pid) {
    return "unrecoverable-stale";
  }
  killWorkerPid(pid);
  if (!await waitForWorkerDown(deps)) {
    return "unrecoverable-stale";
  }
  return "down";
}
async function notifyWorkerWake(deps = {}, env = process.env) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const status = await ensureCompatibleWorker(deps);
  if (status === "unrecoverable-stale") {
    logUnrecoverableStaleWorker();
    return;
  }
  if (status === "down") {
    spawnWorkerProcess(deps, env);
    if (!await waitForCompatibleWorker(deps)) {
      return;
    }
  }
  try {
    await fetchImpl(`${WORKER_BASE_URL}/wake`, {
      method: "POST",
      body: "{}",
      signal: createAbortSignal(WAKE_TIMEOUT_MS)
    });
  } catch {
    spawnWorkerProcess(deps, env);
  }
}
async function notifyWorkerFlush(sessionDbId, deps = {}, env = process.env) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const flushEnv = {
    ...env,
    CLAUDE_MNEMO_FLUSH_SESSION_ID: String(sessionDbId)
  };
  const status = await ensureCompatibleWorker(deps);
  if (status === "unrecoverable-stale") {
    logUnrecoverableStaleWorker();
    return;
  }
  if (status === "down") {
    spawnWorkerProcess(deps, flushEnv);
    return;
  }
  try {
    const response = await fetchImpl(`${WORKER_BASE_URL}/flush`, {
      method: "POST",
      body: JSON.stringify({
        session_id: sessionDbId
      }),
      signal: createAbortSignal(FLUSH_TIMEOUT_MS)
    });
    if (response.ok) {
      return;
    }
  } catch {
  }
  spawnWorkerProcess(deps, flushEnv);
}
async function notifyWorkerCompact(sessionDbId, transcriptPath, deps = {}, env = process.env) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const status = await ensureCompatibleWorker(deps);
  if (status === "unrecoverable-stale") {
    logUnrecoverableStaleWorker();
    throw new Error("Stale worker detected but no pid handle is available for restart.");
  }
  if (status === "down") {
    spawnWorkerProcess(deps, env);
    const ready = await waitForCompatibleWorker(deps);
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

// src/shared/file-tree.ts
var import_node_path4 = __toESM(require("node:path"), 1);
function createFileTreeNode() {
  return { files: [], dirs: /* @__PURE__ */ new Map() };
}
function commonPathPrefix(paths) {
  if (paths.length === 0) {
    return "";
  }
  if (paths.length === 1) {
    return paths[0] ?? "";
  }
  const allAbsolute = paths.every((value) => value.startsWith("/"));
  const splitPaths = paths.map((value) => value.split("/").filter(Boolean));
  const common = [];
  const limit = Math.min(...splitPaths.map((segments) => segments.length));
  for (let index = 0; index < limit; index += 1) {
    const segment = splitPaths[0]?.[index];
    if (!segment || splitPaths.some((segments) => segments[index] !== segment)) {
      break;
    }
    common.push(segment);
  }
  if (common.length === 0) {
    return allAbsolute ? "/" : ".";
  }
  const joined = common.join("/");
  return allAbsolute ? `/${joined}` : joined;
}
function renderTreeNode(name, node, indent) {
  if (node.files.length === 1 && node.dirs.size === 0) {
    return [`${indent}${name}/${node.files[0]}`];
  }
  if (node.files.length === 0 && node.dirs.size > 0) {
    const childEntries = [...node.dirs.entries()].sort(
      ([left], [right]) => left.localeCompare(right)
    );
    return childEntries.flatMap(
      ([childName, childNode]) => renderTreeNode(`${name}/${childName}`, childNode, indent)
    );
  }
  const lines = [`${indent}${name}/`];
  for (const file of [...node.files].sort((left, right) => left.localeCompare(right))) {
    lines.push(`${indent}  ${file}`);
  }
  for (const [childName, childNode] of [...node.dirs.entries()].sort(
    ([left], [right]) => left.localeCompare(right)
  )) {
    lines.push(...renderTreeNode(childName, childNode, `${indent}  `));
  }
  return lines;
}
function isFileLine(line, index) {
  return index > 0 && !line.endsWith("/");
}
function capRenderedTree(lines, totalFiles, maxChars) {
  const suffixBudget = `
  ...(+${totalFiles} more files)`.length;
  const lineBudget = Math.max(0, maxChars - suffixBudget);
  const kept = [];
  let keptFiles = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const candidate = kept.length === 0 ? line : `${kept.join("\n")}
${line}`;
    if (candidate.length > lineBudget) {
      break;
    }
    kept.push(line);
    if (isFileLine(line, index)) {
      keptFiles += 1;
    }
  }
  const omitted = totalFiles - keptFiles;
  if (omitted <= 0) {
    return lines.join("\n");
  }
  return `${kept.join("\n")}
  ...(+${omitted} more files)`;
}
function renderFileTree(paths, opts) {
  const uniquePaths = [...new Set(paths.filter((value) => value.trim() !== ""))].sort(
    (left, right) => left.localeCompare(right)
  );
  if (uniquePaths.length === 0) {
    return "(none)";
  }
  if (uniquePaths.length === 1) {
    const only = uniquePaths[0] ?? "(none)";
    if (opts?.maxChars !== void 0 && only.length > opts.maxChars) {
      const marker = "...";
      return `${only.slice(0, Math.max(0, opts.maxChars - marker.length))}${marker}`;
    }
    return only;
  }
  const root = commonPathPrefix(uniquePaths);
  const tree = createFileTreeNode();
  for (const value of uniquePaths) {
    const relative = import_node_path4.default.posix.relative(root, value);
    if (!relative || relative === "") {
      continue;
    }
    const segments = relative.split("/").filter(Boolean);
    if (segments.length === 0) {
      continue;
    }
    let node = tree;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index];
      let next = node.dirs.get(segment);
      if (!next) {
        next = createFileTreeNode();
        node.dirs.set(segment, next);
      }
      node = next;
    }
    node.files.push(segments[segments.length - 1]);
  }
  const lines = [root];
  for (const file of [...tree.files].sort((left, right) => left.localeCompare(right))) {
    lines.push(file);
  }
  for (const [childName, childNode] of [...tree.dirs.entries()].sort(
    ([left], [right]) => left.localeCompare(right)
  )) {
    lines.push(...renderTreeNode(childName, childNode, ""));
  }
  const rendered = lines.join("\n");
  if (opts?.maxChars !== void 0 && rendered.length > opts.maxChars) {
    return capRenderedTree(lines, uniquePaths.length, opts.maxChars);
  }
  return rendered;
}

// src/mcp/format.ts
var FIELD_TRUNCATION_SUFFIX = "...";
var DEFAULT_TRUNCATE = 200;
var MAX_TRUNCATE = 2e3;
var DEFAULT_PREVIEW_COUNT = 5;
function formatEpoch(epoch) {
  const date = new Date(epoch * 1e3);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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
function splitBulletField(value) {
  if (!value) {
    return [];
  }
  return value.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => line.replace(/^-+\s*/, ""));
}
function truncateText(text, {
  limit,
  mode = "legacy",
  hintId
}) {
  const boundedLimit = Math.min(Math.max(limit, 1), MAX_TRUNCATE);
  if (text.length <= boundedLimit) {
    return text;
  }
  return `${text.slice(0, boundedLimit)}${FIELD_TRUNCATION_SUFFIX}${mode === "unified" && hintId ? ` [use mnemo-replay skill \u2192 read ${hintId} for full content]` : ""}`;
}
function truncateFileTree(tree, {
  limit,
  mode = "legacy",
  hintId
}) {
  const boundedLimit = Math.min(Math.max(limit, 1), MAX_TRUNCATE);
  const lines = tree.split("\n");
  const kept = [];
  let used = 0;
  for (const line of lines) {
    const nextUsed = used + line.length + 1;
    if (kept.length > 0 && nextUsed > boundedLimit) {
      break;
    }
    kept.push(line);
    used = nextUsed;
  }
  const omitted = lines.length - kept.length;
  if (omitted <= 0) {
    return kept;
  }
  return [
    ...kept,
    `... +${omitted} lines${mode === "unified" && hintId ? ` [use mnemo-replay skill \u2192 read ${hintId} for full content]` : ""}`
  ];
}
function resolveExplicitTruncate(truncate) {
  return Math.min(Math.max(truncate ?? DEFAULT_TRUNCATE, 1), MAX_TRUNCATE);
}
function buildSessionHintId(sessionId) {
  return `S${sessionId}`;
}
function buildTurnHintId(sessionId, promptNumber) {
  return sessionId === void 0 ? void 0 : `S${sessionId}/T${promptNumber}`;
}
function buildObservationHintId(observationId, sessionId, turnPromptNumber) {
  if (sessionId === void 0 || turnPromptNumber === void 0) {
    return void 0;
  }
  return `S${sessionId}/T${turnPromptNumber}/O${observationId}`;
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
      const path2 = valueForKey("path");
      if (pattern && path2) {
        return `${pattern} ${path2}`;
      }
      return pattern ?? path2;
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
function formatSessionCollapsedWithMode(session, mode, truncate) {
  const limit = resolveExplicitTruncate(truncate);
  const stats = formatSessionStats(session);
  const statsSegment = stats ? ` | ${stats}` : "";
  const lines = [
    `- [S${session.id}] ${session.title ?? "Untitled"}${statsSegment} | ${formatEpoch(session.createdAtEpoch)} | ${session.project}`
  ];
  if (session.content) {
    lines.push(
      `  - desc: ${truncateText(session.content, {
        limit,
        mode,
        hintId: buildSessionHintId(session.id)
      })}`
    );
  }
  return lines.join("\n");
}
function formatSessionExpandedWithMode(session, mode, truncate) {
  const limit = resolveExplicitTruncate(truncate);
  const lines = [formatSessionCollapsedWithMode(session, mode, truncate)];
  const hintId = buildSessionHintId(session.id);
  const pushField = (label, value) => {
    if (!value) {
      return;
    }
    lines.push(`  - ${label}: ${truncateText(value, { limit, mode, hintId })}`);
  };
  const pushBulletField = (label, value) => {
    if (!value) {
      return;
    }
    const items = splitBulletField(
      truncateText(value, { limit, mode, hintId })
    );
    if (items.length === 0) {
      return;
    }
    lines.push(`  - ${label}:`);
    pushBullets(lines, "    ", items);
  };
  if (session.jsonlPath) {
    lines.push(`  raw: ${session.jsonlPath}`);
  }
  if (session.decision) {
    pushBulletField("decision", session.decision);
  } else if (session.insight && session.insight.length > 0) {
    lines.push("  - insight:");
    pushBullets(
      lines,
      "    ",
      session.insight.map((line) => truncateText(line, { limit, mode, hintId }))
    );
  }
  pushBulletField("done", session.done);
  pushField("current", session.current);
  pushField("next", session.nextSteps);
  pushBulletField("reference", session.reference);
  return lines.join("\n");
}
function formatTurnLabel(turn, {
  indent = "  ",
  sessionId,
  mode = "legacy",
  depth = "collapsed",
  truncate
} = {}) {
  const turnId = turn.transcriptLineStart === null ? `T${turn.promptNumber}` : `T${turn.promptNumber}:L${turn.transcriptLineStart}`;
  const prefix = sessionId === void 0 ? `${indent}- [${turnId}]` : `${indent}- [S${sessionId}][${turnId}]`;
  const stats = formatTurnStats(turn);
  const statsSegment = stats ? ` | ${stats}` : "";
  const rawTitle = turn.title ?? turn.promptPreview ?? "Untitled";
  const limit = resolveExplicitTruncate(truncate);
  const hintId = buildTurnHintId(sessionId, turn.promptNumber);
  const title = turn.title === null && turn.promptPreview ? `"${truncateText(turn.promptPreview, {
    limit,
    mode,
    hintId
  })}"` : truncateText(rawTitle, {
    limit,
    mode,
    hintId
  });
  return `${prefix} ${title}${statsSegment}${formatStatus(turn.status)}`;
}
function formatTurnCollapsedWithMode(turn, options = {}) {
  const { indent = "  ", mode = "legacy" } = options;
  const limit = resolveExplicitTruncate(options.truncate);
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
        limit,
        mode,
        hintId: buildTurnHintId(options.sessionId, turn.promptNumber)
      })}`
    );
  }
  return lines.join("\n");
}
function formatToolCallLabel(toolCall, { indent = "    ", mode = "unified", depth = "collapsed", truncate } = {}) {
  const limit = resolveExplicitTruncate(truncate);
  const keyParam = toolCall.keyParam ?? extractKeyParam(toolCall.name, toolCall.input);
  const suffix = keyParam ? ` ${truncateText(keyParam, { limit, mode })}` : "";
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
  const { indent = "    ", mode = "unified", depth = "expanded", truncate } = options;
  const limit = resolveExplicitTruncate(truncate);
  const detailIndent = `${indent}  `;
  const hintId = buildTurnHintId(options.sessionId, options.turnPromptNumber ?? 0);
  const lines = [
    formatToolCallLabel(toolCall, {
      ...options,
      mode,
      depth: "expanded",
      truncate
    })
  ];
  if (toolCall.input !== void 0) {
    lines.push(
      `${detailIndent}- in: ${truncateText(JSON.stringify(toolCall.input), {
        limit,
        mode,
        hintId
      })}`
    );
  }
  if (toolCall.result) {
    lines.push(
      `${detailIndent}- out: ${truncateText(toolCall.result, {
        limit,
        mode,
        hintId
      })}`
    );
  }
  return lines.join("\n");
}
function renderTurnChildren(turn, depth, options = {}) {
  if (depth === "collapsed") {
    return "";
  }
  const { indent = "  ", sessionId, mode = "legacy", truncate } = options;
  const childIndent = `${indent}  `;
  const childLines = [];
  if (turn.observations && turn.observations.length > 0) {
    for (const observation of turn.observations.slice(0, DEFAULT_PREVIEW_COUNT)) {
      childLines.push(
        formatObservationExpandedWithMode(observation, {
          indent: childIndent,
          sessionId,
          turnPromptNumber: turn.promptNumber,
          mode,
          depth: "expanded",
          truncate
        })
      );
    }
    if (turn.observations.length > DEFAULT_PREVIEW_COUNT) {
      childLines.push(`${childIndent}+${turn.observations.length - DEFAULT_PREVIEW_COUNT} more`);
    }
    return childLines.join("\n");
  }
  if (turn.toolCalls && turn.toolCalls.length > 0) {
    for (const toolCall of turn.toolCalls.slice(0, DEFAULT_PREVIEW_COUNT)) {
      childLines.push(
        formatToolCallExpandedWithMode(toolCall, {
          indent: childIndent,
          sessionId,
          turnPromptNumber: turn.promptNumber,
          mode,
          depth: "expanded",
          truncate
        })
      );
    }
    if (turn.toolCalls.length > DEFAULT_PREVIEW_COUNT) {
      childLines.push(`${childIndent}+${turn.toolCalls.length - DEFAULT_PREVIEW_COUNT} more`);
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
  const limit = resolveExplicitTruncate(options.truncate);
  const hintId = buildTurnHintId(options.sessionId, turn.promptNumber);
  const lines = [formatTurnCollapsedWithMode(turn, { ...options, mode })];
  if (turn.promptPreview) {
    lines.push(
      `${detailIndent}- prompt: "${truncateText(
        turn.promptPreview,
        {
          limit,
          mode,
          hintId
        }
      )}"`
    );
  }
  if (turn.responsePreview) {
    lines.push(
      `${detailIndent}- response: "${truncateText(
        turn.responsePreview,
        {
          limit,
          mode,
          hintId
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
          limit,
          mode,
          hintId
        })
      )
    );
  }
  if (mode === "unified" && turn.filesRead && turn.filesRead.length > 0) {
    lines.push(`${detailIndent}- files_read:`);
    pushBullets(
      lines,
      `${detailIndent}  `,
      truncateFileTree(renderFileTree(turn.filesRead), {
        limit,
        mode,
        hintId
      })
    );
  }
  if (mode === "unified" && turn.filesModified && turn.filesModified.length > 0) {
    lines.push(`${detailIndent}- files_modified:`);
    pushBullets(
      lines,
      `${detailIndent}  `,
      truncateFileTree(renderFileTree(turn.filesModified), {
        limit,
        mode,
        hintId
      })
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
function formatObservationCollapsedWithMode(observation, options = {}) {
  const { indent = "", mode = "legacy" } = options;
  const limit = resolveExplicitTruncate(options.truncate);
  const lines = [formatObservationLabel(observation, options)];
  if (observation.content) {
    lines.push(
      `${indent}  - desc: ${truncateText(
        observation.content,
        {
          limit,
          mode,
          hintId: buildObservationHintId(
            observation.id,
            options.sessionId,
            options.turnPromptNumber
          )
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
      return options.depth === "collapsed" ? formatSessionCollapsedWithMode(node.value, mode, options.truncate) : formatSessionExpandedWithMode(node.value, mode, options.truncate);
    case "turn":
      return options.depth === "collapsed" ? formatTurnCollapsedWithMode(node.value, { ...options, mode }) : formatTurnExpandedWithMode(node.value, { ...options, mode });
    case "observation":
      return options.depth === "collapsed" ? formatObservationCollapsedWithMode(node.value, { ...options, mode }) : formatObservationExpandedWithMode(node.value, { ...options, mode });
    case "toolCall":
      return options.depth === "collapsed" ? formatToolCallCollapsedWithMode(node.value, { ...options, mode }) : formatToolCallExpandedWithMode(node.value, { ...options, mode });
  }
}

// src/db/turns.ts
var TURN_SELECT = `
  SELECT
    id,
    session_id AS sessionId,
    prompt_number AS promptNumber,
    content_prompt_id AS contentPromptId,
    transcript_line_start AS transcriptLineStart,
    was_interrupted AS wasInterrupted,
    was_rolled_back AS wasRolledBack,
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
    parent_turn_id AS parentTurnId,
    created_at_epoch AS createdAtEpoch,
    updated_at_epoch AS updatedAtEpoch
  FROM turns
`;
function stringifyArray(values) {
  return JSON.stringify(values);
}
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
    wasInterrupted: row.wasInterrupted === 1,
    wasRolledBack: row.wasRolledBack === 1,
    tags: parseJsonArray(row.tags),
    filesRead: parseJsonArray(row.filesRead),
    filesModified: parseJsonArray(row.filesModified),
    parentTurnId: row.parentTurnId ?? null
  };
}
function mergeTags(existingTags, nextTags) {
  if (!nextTags) {
    return existingTags;
  }
  const merged = [...existingTags];
  for (const tag of nextTags) {
    if (!merged.includes(tag)) {
      merged.push(tag);
    }
  }
  return merged;
}
function getTurnById(db, turnId) {
  return mapTurnRow(
    db.query(`${TURN_SELECT} WHERE id = ?`).get(turnId) ?? null
  );
}
function updateTurnById(db, turnId, input) {
  const existing = getTurnById(db, turnId);
  if (!existing) {
    return null;
  }
  const mergedTitle = input.title ?? existing.title;
  const mergedContent = input.content ?? existing.content;
  const hasSubstance = mergedTitle !== null || mergedContent !== null;
  const nextStatus = input.status ?? (existing.status === "active" && hasSubstance ? "extracted" : existing.status);
  const nextTags = input.replaceTags ?? mergeTags(existing.tags, input.tags);
  const updated = mapTurnRow(
    db.query(
      `
          UPDATE turns
          SET
            status = ?,
            was_interrupted = ?,
            was_rolled_back = ?,
            title = ?,
            content = ?,
            insight = ?,
            type = ?,
            transcript_line_start = ?,
            tags = ?,
            files_read = ?,
            files_modified = ?,
            tool_call_count = ?,
            updated_at_epoch = ?
          WHERE id = ?
          RETURNING
            id,
            session_id AS sessionId,
            prompt_number AS promptNumber,
            content_prompt_id AS contentPromptId,
            was_interrupted AS wasInterrupted,
            was_rolled_back AS wasRolledBack,
            status,
            user_prompt AS userPrompt,
            assistant_response AS assistantResponse,
            title,
            content,
            insight,
            type,
            transcript_line_start AS transcriptLineStart,
            tags,
            files_read AS filesRead,
            files_modified AS filesModified,
            tool_call_count AS toolCallCount,
            parent_turn_id AS parentTurnId,
            created_at_epoch AS createdAtEpoch,
            updated_at_epoch AS updatedAtEpoch
        `
    ).get(
      nextStatus,
      input.wasInterrupted ?? existing.wasInterrupted ? 1 : 0,
      input.wasRolledBack ?? existing.wasRolledBack ? 1 : 0,
      input.title ?? existing.title,
      input.content ?? existing.content,
      input.insight ?? existing.insight,
      input.type ?? existing.type,
      input.transcriptLineStart ?? existing.transcriptLineStart,
      stringifyArray(nextTags),
      stringifyArray(input.filesRead ?? existing.filesRead),
      stringifyArray(input.filesModified ?? existing.filesModified),
      input.toolCallCount ?? existing.toolCallCount,
      input.updatedAtEpoch ?? existing.updatedAtEpoch,
      turnId
    ) ?? null
  );
  if (!updated) {
    return null;
  }
  if (updated.status === "extracted") {
    indexTurnToFTS(db, updated);
  } else {
    db.query(
      "DELETE FROM memory_fts WHERE layer = 'turn' AND source_id = ?"
    ).run(turnId);
  }
  return updated;
}
function resetTurnExtractionFields(db, turnId, updatedAtEpoch) {
  const existing = getTurnById(db, turnId);
  if (!existing) {
    return;
  }
  const keptTags = existing.tags.filter((tag) => tag.includes(":"));
  db.query(
    `UPDATE turns
       SET status = 'active',
           title = NULL,
           content = NULL,
           insight = NULL,
           type = NULL,
           tags = ?,
           updated_at_epoch = ?
       WHERE id = ?`
  ).run(stringifyArray(keptTags), updatedAtEpoch, turnId);
  db.query(
    "DELETE FROM memory_fts WHERE layer = 'turn' AND source_id = ?"
  ).run(turnId);
}
function getTurnsForSession(db, sessionId) {
  return db.query(
    `${TURN_SELECT} WHERE session_id = ? ORDER BY prompt_number ASC`
  ).all(sessionId).map((row) => mapTurnRow(row)).filter((turn) => turn !== null);
}
function getStrandedTurns(db, sessionId) {
  return db.query(
    `${TURN_SELECT}
       WHERE session_id = ?
         AND assistant_response IS NOT NULL
         AND ( status IN ('active','provisional')
               OR (status = 'extracted' AND title IS NULL AND content IS NULL) )
       ORDER BY prompt_number ASC`
  ).all(sessionId).map((row) => mapTurnRow(row)).filter((turn) => turn !== null);
}
function getFirstTurn(db, sessionId) {
  return mapTurnRow(
    db.query(
      `${TURN_SELECT} WHERE session_id = ? ORDER BY prompt_number ASC LIMIT 1`
    ).get(sessionId) ?? null
  );
}
function setTurnParent(db, turnId, parentTurnId) {
  db.query("UPDATE turns SET parent_turn_id = ? WHERE id = ?").run(
    parentTurnId,
    turnId
  );
}
function getMaxPromptNumber(db, sessionId) {
  const row = db.query(
    "SELECT MAX(prompt_number) AS max FROM turns WHERE session_id = ?"
  ).get(sessionId);
  return row?.max ?? null;
}
function updateTurnBackfill(db, turnId, assistantResponse, toolCallCount, contentPromptId, transcriptLineStart) {
  const existing = getTurnById(db, turnId);
  if (!existing) {
    return;
  }
  const safeContentPromptId = contentPromptId && !hasOtherTurnWithContentPromptId(
    db,
    existing.sessionId,
    turnId,
    contentPromptId
  ) ? contentPromptId : null;
  db.query(
    `UPDATE turns
     SET assistant_response = ?,
         tool_call_count = ?,
         content_prompt_id = COALESCE(content_prompt_id, ?),
         transcript_line_start = COALESCE(?, transcript_line_start)
     WHERE id = ?`
  ).run(
    assistantResponse,
    toolCallCount,
    safeContentPromptId,
    transcriptLineStart ?? null,
    turnId
  );
}
function hasOtherTurnWithContentPromptId(db, sessionId, turnId, contentPromptId) {
  return db.query(
    `
          SELECT id
          FROM turns
          WHERE session_id = ?
            AND content_prompt_id = ?
            AND id <> ?
          LIMIT 1
        `
  ).get(sessionId, contentPromptId, turnId) !== null;
}

// src/mcp/turn-pointers.ts
var TURN_POINTER_PATTERN = /\[T(\d+)\]/g;
function resolveTurnPointers(db, sessionId, text) {
  if (!text || !text.includes("[T")) {
    return text;
  }
  return text.replace(TURN_POINTER_PATTERN, (literal, idDigits) => {
    const turn = getTurnById(db, Number.parseInt(idDigits, 10));
    if (!turn || turn.sessionId !== sessionId || turn.status === "undone") {
      return literal;
    }
    return `[S${sessionId}/T${turn.promptNumber}] "${turn.title ?? "untitled"}"`;
  });
}

// src/mcp/timeline.ts
var DEFAULT_TIMELINE_PAGE_SIZE = 30;
var PROMPT_COLUMN_CAP = 100;
var TITLE_COLUMN_CAP = 40;
var BROKEN_PROMPT_MIN_PREFIX = 20;
var BROKEN_PROMPT_MAX_GAP_MS = 5 * 60 * 1e3;
var TOOL_BURST_TOP_N = 3;
var MILESTONE_TIER2_PER_DAY = 4;
var TYPE_EMOJI_MAP = {
  bugfix: "\u{1F534}",
  feature: "\u{1F7E3}",
  refactor: "\u{1F504}",
  change: "\u2705",
  discovery: "\u{1F535}",
  decision: "\u2696\uFE0F",
  compact: "\u23F8"
};
var PENDING_EMOJI = "\u23F3";
var MISSING_LINE_ANCHOR = "\u2014";
function paginateItems(items, page, pageSize) {
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const offset = (page - 1) * pageSize;
  return {
    items: items.slice(offset, offset + pageSize),
    total,
    pageCount
  };
}
function emptyPaginatedItems(total, pageSize) {
  return {
    items: [],
    total,
    pageCount: Math.max(1, Math.ceil(total / pageSize))
  };
}
function parseTimelineId(id) {
  const trimmed = id.trim();
  if (!trimmed) {
    throw new Error("timeline id is empty");
  }
  const match = trimmed.match(/^S(\d+)(?:\/T(.+))?$/i);
  if (!match) {
    throw new Error(`timeline id does not match 'S<n>' or 'S<n>/T...': ${id}`);
  }
  const sessionId = Number(match[1]);
  const rangeValue = match[2];
  if (rangeValue === void 0) {
    return { sessionId, range: { kind: "none" } };
  }
  if (rangeValue === "*") {
    return { sessionId, range: { kind: "all" } };
  }
  const closed = rangeValue.match(/^(\d+)\.\.(\d+)$/);
  if (closed) {
    const start = parsePositiveBound(closed[1], id);
    const end = parsePositiveBound(closed[2], id);
    if (start > end) {
      throw new Error(`timeline range start must be <= end: ${id}`);
    }
    return {
      sessionId,
      range: { kind: "closed", start, end }
    };
  }
  const openStart = rangeValue.match(/^\.\.(\d+)$/);
  if (openStart) {
    const end = parsePositiveBound(openStart[1], id);
    return {
      sessionId,
      range: { kind: "openStart", end }
    };
  }
  const openEnd = rangeValue.match(/^(\d+)\.\.$/);
  if (openEnd) {
    const start = parsePositiveBound(openEnd[1], id);
    return {
      sessionId,
      range: { kind: "openEnd", start }
    };
  }
  if (/^\d+$/.test(rangeValue)) {
    throw new Error(
      `timeline does not accept single turn forms; use recall(id='S${sessionId}/T${rangeValue}', depth='expanded') instead`
    );
  }
  throw new Error(`timeline range syntax not recognized: T${rangeValue}`);
}
function resolveWindow(range, totalTurns, bounds = { first: 1, last: totalTurns }) {
  const { first, last } = bounds;
  if (totalTurns === 0) {
    return {
      startPromptNumber: first,
      endPromptNumber: first - 1,
      totalTurns: 0
    };
  }
  if (range.kind === "none" || range.kind === "all") {
    return {
      startPromptNumber: first,
      endPromptNumber: last,
      totalTurns
    };
  }
  if (range.kind === "closed") {
    validateClosedRange(range);
    const startPromptNumber = Math.max(first, range.start);
    if (startPromptNumber > last) {
      throw new Error(
        `timeline range starts beyond session end: start prompt ${startPromptNumber} exceeds last prompt T${last}`
      );
    }
    return {
      startPromptNumber,
      endPromptNumber: Math.min(range.end, last),
      totalTurns
    };
  }
  if (range.kind === "openEnd") {
    validateOpenEndRange(range);
    const startPromptNumber = Math.max(first, range.start);
    if (startPromptNumber > last) {
      throw new Error(
        `timeline range starts beyond session end: start prompt ${startPromptNumber} exceeds last prompt T${last}`
      );
    }
    return {
      startPromptNumber,
      endPromptNumber: last,
      totalTurns
    };
  }
  if (range.kind === "openStart") {
    validateOpenStartRange(range);
    const endPromptNumber = Math.min(range.end, last);
    return {
      startPromptNumber: first,
      endPromptNumber,
      totalTurns
    };
  }
  throw new Error(`Unknown range kind: ${range.kind}`);
}
function cleanPromptForLabel(raw) {
  if (raw === null) {
    return "";
  }
  const commandName = raw.match(/<command-name>\s*([^<]+?)\s*<\/command-name>/);
  if (commandName) {
    return commandName[1].trim();
  }
  const stripped = raw.replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, "").replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, "").replace(/<command-message>[\s\S]*?<\/command-message>/g, "").replace(/<command-args>[\s\S]*?<\/command-args>/g, "");
  const firstLine = stripped.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? "";
  return firstLine.replace(/\s+/g, " ").trim();
}
function truncateText2(text, maxChars) {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\u2026`;
}
function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1e3);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    const seconds = totalSeconds % 60;
    return seconds === 0 ? `${totalMinutes}m` : `${totalMinutes}m${seconds}s`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}
function formatGap(currentEpochSeconds, previousEpochSeconds) {
  if (previousEpochSeconds === null) {
    return "(start)";
  }
  return `+${formatDuration((currentEpochSeconds - previousEpochSeconds) * 1e3)}`;
}
function formatLocalTime(epochSeconds) {
  return new Intl.DateTimeFormat(void 0, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(epochSeconds * 1e3));
}
function formatLocalDate(epochSeconds) {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(epochSeconds * 1e3));
}
function formatLocalWeekday(epochSeconds) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short"
  }).format(new Date(epochSeconds * 1e3));
}
function formatLocalDateWithWeekday(epochSeconds) {
  return `${formatLocalDate(epochSeconds)} ${formatLocalWeekday(epochSeconds)}`;
}
function formatLocalMonthDay(epochSeconds) {
  const [year, month, day] = formatLocalDate(epochSeconds).split("-");
  void year;
  return `${month}-${day}`;
}
function formatLocalMonthDayWithWeekday(epochSeconds) {
  return `${formatLocalMonthDay(epochSeconds)} ${formatLocalWeekday(epochSeconds)}`;
}
function sameLocalDate(leftEpoch, rightEpoch) {
  return formatLocalDate(leftEpoch) === formatLocalDate(rightEpoch);
}
function getSystemTimezone(referenceEpochSeconds = Math.floor(Date.now() / 1e3), source = {}) {
  const ianaName = source.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const name = source.resolveTimeZoneName ? source.resolveTimeZoneName(referenceEpochSeconds, ianaName) : new Intl.DateTimeFormat("en-US", {
    timeZone: ianaName,
    timeZoneName: "short"
  }).formatToParts(new Date(referenceEpochSeconds * 1e3)).find((part) => part.type === "timeZoneName")?.value ?? ianaName;
  const offsetMinutes = source.resolveOffsetMinutes ? source.resolveOffsetMinutes(referenceEpochSeconds) : -new Date(referenceEpochSeconds * 1e3).getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteMinutes = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absoluteMinutes / 60)).padStart(2, "0");
  const minutes = String(absoluteMinutes % 60).padStart(2, "0");
  return {
    name,
    offsetLabel: `${sign}${hours}:${minutes}`
  };
}
function extractSourceTags(tags) {
  return tags.filter((tag) => tag.startsWith("source:")).map((tag) => tag.slice("source:".length));
}
function extractReversalFlag(turn) {
  if (turn.type !== "decision") {
    return false;
  }
  const reversalTags = /* @__PURE__ */ new Set([
    "reversal",
    "reversed",
    "superseded",
    "supersede",
    "reframed",
    "reframe",
    "design-pivot",
    "pivot"
  ]);
  return turn.tags.some((tag) => reversalTags.has(tag));
}
function isInvalidatedTurn(turn) {
  return turn.status === "undone" || turn.wasRolledBack || turn.wasInterrupted || turn.tags.some((tag) => tag.startsWith("invalidated:"));
}
function milestoneCandidateTurn(turn) {
  if (turn.status === "skipped") {
    return false;
  }
  if (isInvalidatedTurn(turn)) {
    return turn.type === "decision";
  }
  return true;
}
function getCompactMetadata(tags) {
  let preTokens = 0;
  let trigger = "manual";
  let sawCompactTag = false;
  for (const tag of tags) {
    if (tag.startsWith("compact:pre_tokens=")) {
      const rawValue = Number(tag.slice("compact:pre_tokens=".length));
      if (Number.isFinite(rawValue) && rawValue >= 0) {
        preTokens = rawValue;
      }
      sawCompactTag = true;
      continue;
    }
    if (tag.startsWith("compact:trigger=")) {
      trigger = tag.slice("compact:trigger=".length) || trigger;
      sawCompactTag = true;
    }
  }
  return sawCompactTag ? { preTokens, trigger } : null;
}
function formatCompactTokenCount(tokens) {
  if (tokens >= 1e6) {
    const millions = Math.round(tokens / 1e6 * 10) / 10;
    return `${millions % 1 === 0 ? millions.toFixed(0) : millions.toFixed(1)}M`;
  }
  if (tokens >= 1e3) {
    return `${Math.round(tokens / 1e3)}k`;
  }
  return String(tokens);
}
function formatTranscriptLineAnchor(lineNumber) {
  return lineNumber === null ? MISSING_LINE_ANCHOR : `L${lineNumber}`;
}
function segmentPhases(turns) {
  const sortedTurns = sortTurnsForAnalysis(turns);
  const phases = [];
  let current = null;
  let currentStartEpoch = 0;
  let currentEndEpoch = 0;
  for (const turn of sortedTurns) {
    if (!isTimelineLiveTurn(turn)) {
      continue;
    }
    const kind = turn.type === null ? "pending" : "typed";
    const emoji = turn.type === null ? PENDING_EMOJI : TYPE_EMOJI_MAP[turn.type] ?? "\u2022";
    if (current === null || current.kind !== kind || current.type !== turn.type) {
      if (current !== null) {
        current.durationMs = (currentEndEpoch - currentStartEpoch) * 1e3;
      }
      current = {
        kind,
        type: turn.type,
        emoji,
        startPromptNumber: turn.promptNumber,
        endPromptNumber: turn.promptNumber,
        startEpoch: turn.createdAtEpoch,
        endEpoch: turn.createdAtEpoch,
        turnCount: 0,
        totalToolCalls: 0,
        totalFilesRead: 0,
        totalFilesModified: 0,
        durationMs: 0,
        externalInputs: []
      };
      phases.push(current);
      currentStartEpoch = turn.createdAtEpoch;
    }
    current.endPromptNumber = turn.promptNumber;
    current.endEpoch = turn.createdAtEpoch;
    current.turnCount += 1;
    current.totalToolCalls += turn.toolCallCount ?? 0;
    current.totalFilesRead += turn.filesRead.length;
    current.totalFilesModified += turn.filesModified.length;
    currentEndEpoch = turn.createdAtEpoch;
    for (const source of extractSourceTags(turn.tags)) {
      if (!current.externalInputs.includes(source)) {
        current.externalInputs.push(source);
      }
    }
  }
  if (current !== null) {
    current.durationMs = (currentEndEpoch - currentStartEpoch) * 1e3;
  }
  return phases;
}
function computeTypesDistribution(turns) {
  const distribution = {
    bugfix: 0,
    feature: 0,
    refactor: 0,
    change: 0,
    discovery: 0,
    decision: 0,
    compact: 0,
    pending: 0
  };
  for (const turn of turns) {
    if (!isTimelineLiveTurn(turn)) {
      continue;
    }
    if (turn.type === null) {
      distribution.pending += 1;
    } else if (isTypedTurnKind(turn.type)) {
      distribution[turn.type] += 1;
    }
  }
  return distribution;
}
function detectBrokenPromptPairs(turns) {
  const pairs = [];
  const liveTurns = sortTurnsForAnalysis(turns).filter(
    isTimelineLiveTurn
  );
  for (let index = 0; index < liveTurns.length - 1; index += 1) {
    const current = liveTurns[index];
    const next = liveTurns[index + 1];
    const currentPrompt = cleanPromptForLabel(current.userPrompt);
    const nextPrompt = cleanPromptForLabel(next.userPrompt);
    if (currentPrompt.length < BROKEN_PROMPT_MIN_PREFIX || nextPrompt.length < BROKEN_PROMPT_MIN_PREFIX) {
      continue;
    }
    if (sharedPrefixLength(currentPrompt, nextPrompt) < BROKEN_PROMPT_MIN_PREFIX) {
      continue;
    }
    const gapMs = (next.createdAtEpoch - current.createdAtEpoch) * 1e3;
    if (gapMs >= BROKEN_PROMPT_MAX_GAP_MS) {
      continue;
    }
    pairs.push({
      first: current.promptNumber,
      second: next.promptNumber
    });
  }
  return pairs;
}
function sharedPrefixLength(left, right) {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) {
    index += 1;
  }
  return index;
}
function isTypedTurnKind(value) {
  return value === "bugfix" || value === "feature" || value === "refactor" || value === "change" || value === "discovery" || value === "decision" || value === "compact";
}
function parsePositiveBound(raw, id) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`timeline range bounds must be positive integers: ${id}`);
  }
  return value;
}
function detectShapeSignals(turns) {
  if (turns.length === 0) {
    return {
      fastestGap: null,
      longestGap: null,
      toolBursts: [],
      toolBurstMedian: 0,
      toolBurstThreshold: 0,
      brokenPromptPairs: [],
      undoneTurns: [],
      externalInputs: []
    };
  }
  const sortedTurns = sortTurnsForAnalysis(turns);
  const liveTurns = sortedTurns.filter(isTimelineLiveTurn);
  let fastestGap = null;
  let longestGap = null;
  for (let index = 0; index < liveTurns.length - 1; index += 1) {
    const current = liveTurns[index];
    const next = liveTurns[index + 1];
    const gapMs = (next.createdAtEpoch - current.createdAtEpoch) * 1e3;
    if (fastestGap === null || gapMs < fastestGap.ms) {
      fastestGap = { afterPromptNumber: current.promptNumber, ms: gapMs };
    }
    if (longestGap === null || gapMs > longestGap.ms) {
      longestGap = { afterPromptNumber: current.promptNumber, ms: gapMs };
    }
  }
  const sortedToolCounts = liveTurns.map((turn) => turn.toolCallCount ?? 0).sort((left, right) => left - right);
  let toolBurstMedian = 0;
  if (sortedToolCounts.length > 0) {
    const middle = Math.floor(sortedToolCounts.length / 2);
    toolBurstMedian = sortedToolCounts.length % 2 === 1 ? sortedToolCounts[middle] : Math.round(
      (sortedToolCounts[middle - 1] + sortedToolCounts[middle]) / 2
    );
  }
  const toolBurstThreshold = toolBurstMedian * 2;
  const toolBursts = liveTurns.map((turn) => ({
    promptNumber: turn.promptNumber,
    toolCallCount: turn.toolCallCount ?? 0
  })).filter((turn) => turn.toolCallCount > toolBurstThreshold).sort((left, right) => right.toolCallCount - left.toolCallCount).slice(0, TOOL_BURST_TOP_N);
  const undoneTurns = turns.filter((turn) => turn.status === "undone").map((turn) => turn.promptNumber);
  const externalInputs = liveTurns.flatMap(
    (turn) => extractSourceTags(turn.tags).map((source) => ({
      promptNumber: turn.promptNumber,
      source
    }))
  );
  return {
    fastestGap,
    longestGap,
    toolBursts,
    toolBurstMedian,
    toolBurstThreshold,
    brokenPromptPairs: detectBrokenPromptPairs(turns),
    undoneTurns,
    externalInputs
  };
}
function selectMilestoneTurns(view) {
  const sorted = sortTurnsForAnalysis(view.windowTurns);
  const candidates = sorted.filter(milestoneCandidateTurn);
  const keptByPrompt = /* @__PURE__ */ new Map();
  const tier2Candidates = [];
  const phaseLeads = new Set(segmentPhases(view.windowTurns).map((phase) => phase.startPromptNumber));
  const firstCandidate = candidates[0]?.promptNumber ?? null;
  const lastCandidate = candidates[candidates.length - 1]?.promptNumber ?? null;
  const candidateByPrompt = new Map(candidates.map((turn, index) => [turn.promptNumber, { turn, index }]));
  const addKept = (turn, tier) => {
    const existing = keptByPrompt.get(turn.promptNumber);
    if (existing && existing.tier <= tier) {
      return;
    }
    keptByPrompt.set(turn.promptNumber, {
      turn,
      tier,
      invalidated: isInvalidatedTurn(turn),
      reversal: extractReversalFlag(turn)
    });
  };
  for (const turn of candidates) {
    const isEndpoint = turn.promptNumber === firstCandidate || turn.promptNumber === lastCandidate;
    const isDeliverable = (turn.type === "change" || turn.type === "feature" || turn.type === "refactor") && turn.filesModified.length > 0;
    if (isEndpoint || turn.type === "decision" || isDeliverable || turn.type === "compact") {
      addKept(turn, 1);
      continue;
    }
    if (turn.type === "bugfix") {
      const current = candidateByPrompt.get(turn.promptNumber);
      const next = current ? candidates[current.index + 1] : void 0;
      if (next?.type !== "bugfix") {
        tier2Candidates.push(turn);
      }
      continue;
    }
    if (turn.type === "discovery" && phaseLeads.has(turn.promptNumber)) {
      const current = candidateByPrompt.get(turn.promptNumber);
      const next = current ? candidates[current.index + 1] : void 0;
      const feedsLiveDecision = next?.type === "decision" && !isInvalidatedTurn(next);
      const isBurst = (turn.toolCallCount ?? 0) > view.windowSignals.toolBurstThreshold;
      if (feedsLiveDecision || isBurst) {
        tier2Candidates.push(turn);
      }
    }
  }
  const tier2ByDay = /* @__PURE__ */ new Map();
  for (const turn of tier2Candidates) {
    const day = formatLocalDate(turn.createdAtEpoch);
    const bucket = tier2ByDay.get(day) ?? [];
    bucket.push(turn);
    tier2ByDay.set(day, bucket);
  }
  const overflowByDay = [];
  for (const [date, turns] of tier2ByDay) {
    const ranked = [...turns].sort((left, right) => {
      const leftRank = left.type === "bugfix" ? 0 : 1;
      const rightRank = right.type === "bugfix" ? 0 : 1;
      if (leftRank !== rightRank) return leftRank - rightRank;
      const toolDiff = (right.toolCallCount ?? 0) - (left.toolCallCount ?? 0);
      if (toolDiff !== 0) return toolDiff;
      return left.promptNumber - right.promptNumber;
    });
    for (const turn of ranked.slice(0, MILESTONE_TIER2_PER_DAY)) {
      addKept(turn, 2);
    }
    const overflow = ranked.slice(MILESTONE_TIER2_PER_DAY);
    if (overflow.length > 0) {
      const byPrompt = [...overflow].sort((left, right) => left.promptNumber - right.promptNumber);
      const hasBugfix = overflow.some((turn) => turn.type === "bugfix");
      const hasDiscovery = overflow.some((turn) => turn.type === "discovery");
      overflowByDay.push({
        date,
        count: overflow.length,
        firstPrompt: byPrompt[0].promptNumber,
        lastPrompt: byPrompt[byPrompt.length - 1].promptNumber,
        lastKeptPrompt: 0,
        kind: hasBugfix && hasDiscovery ? "fixes/notes" : hasBugfix ? "fixes" : "notes"
      });
    }
  }
  const kept = [...keptByPrompt.values()].sort(
    (left, right) => left.turn.promptNumber - right.turn.promptNumber
  );
  const lastKeptPromptByDay = /* @__PURE__ */ new Map();
  for (const milestone of kept) {
    lastKeptPromptByDay.set(
      formatLocalDate(milestone.turn.createdAtEpoch),
      milestone.turn.promptNumber
    );
  }
  return {
    kept,
    overflowByDay: overflowByDay.map((overflow) => ({
      ...overflow,
      lastKeptPrompt: lastKeptPromptByDay.get(overflow.date) ?? 0
    })).sort(
      (left, right) => left.date === right.date ? left.firstPrompt - right.firstPrompt : left.date.localeCompare(right.date)
    )
  };
}
function sortTurnsForAnalysis(turns) {
  return [...turns].sort((left, right) => {
    if (left.promptNumber !== right.promptNumber) {
      return left.promptNumber - right.promptNumber;
    }
    if (left.createdAtEpoch !== right.createdAtEpoch) {
      return left.createdAtEpoch - right.createdAtEpoch;
    }
    return left.id - right.id;
  });
}
function validateClosedRange(range) {
  if (!Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 1 || range.end < 1 || range.start > range.end) {
    throw new Error(
      `timeline range is invalid: closed ranges require positive integers with start <= end`
    );
  }
}
function validateOpenStartRange(range) {
  if (!Number.isInteger(range.end) || range.end < 1) {
    throw new Error(
      `timeline range is invalid: open-start ranges require a positive integer end`
    );
  }
}
function validateOpenEndRange(range) {
  if (!Number.isInteger(range.start) || range.start < 1) {
    throw new Error(
      `timeline range is invalid: open-end ranges require a positive integer start`
    );
  }
}
function deriveTimelineBreadcrumb(db, session) {
  if (session.parentSessionId === null) {
    return null;
  }
  const parentRef = `S${session.parentSessionId}`;
  const firstTurn = getFirstTurn(db, session.id);
  if (firstTurn !== null && firstTurn.parentTurnId !== null) {
    const forkTurn = getTurnById(db, firstTurn.parentTurnId);
    if (forkTurn !== null) {
      return `continues from ${parentRef} (forked at T${forkTurn.promptNumber})`;
    }
  }
  return `continues from ${parentRef}`;
}
function buildTimelineView(db, input, preloadedTurns) {
  const parsed = parseTimelineId(input.id);
  const viewKind = input.view ?? "turns";
  const session = getSession(db, parsed.sessionId);
  if (!session) {
    throw new Error(`timeline: session S${parsed.sessionId} not found`);
  }
  const allTurns = preloadedTurns ?? getTurnsForSession(db, session.id);
  const totalTurns = allTurns.length;
  const totalToolCalls = allTurns.reduce(
    (sum, turn) => sum + (turn.toolCallCount ?? 0),
    0
  );
  const sorted = [...allTurns].sort((a, b) => a.promptNumber - b.promptNumber);
  const bounds = totalTurns > 0 ? { first: sorted[0].promptNumber, last: sorted[totalTurns - 1].promptNumber } : { first: 1, last: 0 };
  const window = resolveWindow(parsed.range, totalTurns, bounds);
  const windowTurns = sorted.filter(
    (turn) => turn.promptNumber >= window.startPromptNumber && turn.promptNumber <= window.endPromptNumber
  );
  const page = Math.max(1, input.page ?? 1);
  const pageSize = Math.max(1, input.pageSize ?? DEFAULT_TIMELINE_PAGE_SIZE);
  const typesDistribution = computeTypesDistribution(allTurns);
  const windowSignals = detectShapeSignals(windowTurns);
  const compactBoundaries = [
    ...new Set(
      allTurns.filter((turn) => turn.type === "compact").map((turn) => turn.promptNumber)
    )
  ].sort((a, b) => a - b);
  if (compactBoundaries.length === 0 && session.lastCompactTurn !== null) {
    compactBoundaries.push(session.lastCompactTurn);
  }
  const jsonlPath = resolveTranscriptPath(session.project, session.contentSessionId) ?? null;
  const tz = getSystemTimezone(session.createdAtEpoch);
  const breadcrumb = deriveTimelineBreadcrumb(db, session);
  const milestoneSelection = selectMilestoneTurns({
    session,
    windowTurns,
    windowSignals,
    compactBoundaries
  });
  const phases = segmentPhases(windowTurns);
  const nonSkippedTurns = windowTurns.filter((turn) => turn.status !== "skipped");
  const pagedTurns = viewKind === "turns" ? paginateItems(nonSkippedTurns, page, pageSize) : emptyPaginatedItems(nonSkippedTurns.length, pageSize);
  const pagedMilestones = viewKind === "milestones" ? paginateItems(milestoneSelection.kept, page, pageSize) : emptyPaginatedItems(milestoneSelection.kept.length, pageSize);
  const pagedPhases = viewKind === "phases" ? paginateItems(phases, page, pageSize) : emptyPaginatedItems(phases.length, pageSize);
  const viewItemTotal = viewKind === "turns" ? pagedTurns.total : viewKind === "milestones" ? pagedMilestones.total : pagedPhases.total;
  const pageCount = viewKind === "turns" ? pagedTurns.pageCount : viewKind === "milestones" ? pagedMilestones.pageCount : pagedPhases.pageCount;
  const pageAnchorEpoch = viewKind === "turns" ? pagedTurns.items[0]?.createdAtEpoch ?? null : viewKind === "milestones" ? pagedMilestones.items[0]?.turn.createdAtEpoch ?? null : pagedPhases.items[0]?.startEpoch ?? null;
  return {
    view: viewKind,
    session,
    totalTurns,
    firstPromptNumber: bounds.first,
    lastPromptNumber: bounds.last,
    totalToolCalls,
    typesDistribution,
    compactBoundaries,
    window,
    windowTurns,
    pageTurns: pagedTurns.items,
    pagedMilestones: pagedMilestones.items,
    pagedPhases: pagedPhases.items,
    milestoneOverflowByDay: milestoneSelection.overflowByDay,
    viewItemTotal,
    pageAnchorEpoch,
    page,
    pageSize,
    pageCount,
    windowSignals,
    jsonlPath,
    tz,
    hasEarlier: false,
    breadcrumb
  };
}
function buildContextTimelineView(db, sessionId, view = "turns") {
  const session = getSession(db, sessionId);
  if (!session) {
    throw new Error(`timeline: session S${sessionId} not found`);
  }
  const sortedTurns = getTurnsForSession(db, sessionId).sort((a, b) => {
    if (a.promptNumber !== b.promptNumber) {
      return a.promptNumber - b.promptNumber;
    }
    if (a.createdAtEpoch !== b.createdAtEpoch) {
      return a.createdAtEpoch - b.createdAtEpoch;
    }
    return a.id - b.id;
  });
  if (sortedTurns.length === 0) {
    return buildTimelineView(db, { id: `S${sessionId}` });
  }
  const windowTurns = sortedTurns.slice(-DEFAULT_TIMELINE_PAGE_SIZE);
  const firstPromptNumber = windowTurns[0].promptNumber;
  const lastPromptNumber = windowTurns[windowTurns.length - 1].promptNumber;
  const timelineView = buildTimelineView(db, {
    id: `S${sessionId}/T${firstPromptNumber}..${lastPromptNumber}`,
    pageSize: DEFAULT_TIMELINE_PAGE_SIZE,
    view
  }, sortedTurns);
  return {
    ...timelineView,
    hasEarlier: firstPromptNumber !== sortedTurns[0].promptNumber
  };
}
function renderSessionHeader(view) {
  const sessionStart = view.session.createdAtEpoch;
  const sessionEnd = view.session.updatedAtEpoch ?? view.session.completedAtEpoch ?? view.session.createdAtEpoch;
  const compactSuffix = view.compactBoundaries.length > 0 ? `, compact at ${view.compactBoundaries.map((n) => `T${n}`).join(", ")}` : "";
  const typesParts = [];
  if (view.typesDistribution.bugfix > 0) {
    typesParts.push(`\u{1F534}${view.typesDistribution.bugfix}`);
  }
  if (view.typesDistribution.feature > 0) {
    typesParts.push(`\u{1F7E3}${view.typesDistribution.feature}`);
  }
  if (view.typesDistribution.refactor > 0) {
    typesParts.push(`\u{1F504}${view.typesDistribution.refactor}`);
  }
  if (view.typesDistribution.change > 0) {
    typesParts.push(`\u2705${view.typesDistribution.change}`);
  }
  if (view.typesDistribution.discovery > 0) {
    typesParts.push(`\u{1F535}${view.typesDistribution.discovery}`);
  }
  if (view.typesDistribution.decision > 0) {
    typesParts.push(`\u2696\uFE0F${view.typesDistribution.decision}`);
  }
  if (view.typesDistribution.compact > 0) {
    typesParts.push(`\u23F8${view.typesDistribution.compact}`);
  }
  if (view.typesDistribution.pending > 0) {
    typesParts.push(`\u23F3${view.typesDistribution.pending}`);
  }
  const startDate = formatLocalDate(sessionStart);
  const endDate = formatLocalDate(sessionEnd);
  const endLabel = startDate === endDate ? formatLocalTime(sessionEnd) : `${endDate} ${formatLocalTime(sessionEnd)}`;
  const lines = [
    `- [S${view.session.id}] ${startDate} ${formatLocalTime(sessionStart)} \u2192 ${endLabel} (${formatDuration((sessionEnd - sessionStart) * 1e3)}${compactSuffix})`,
    `  ${view.session.project} | ${view.totalTurns} turns | ${view.totalToolCalls} tool_calls`,
    `  types: ${typesParts.join(" ")} (session-wide)`,
    `  tz: ${view.tz.name} (${view.tz.offsetLabel})`,
    `  raw: ${view.jsonlPath ?? "(unresolved)"}`
  ];
  const showingLine = formatShowingLine(view);
  if (showingLine) {
    lines.splice(3, 0, `  showing: ${showingLine}`);
  }
  if (view.breadcrumb !== null) {
    lines.push(`  ${view.breadcrumb}`);
  }
  return lines;
}
function formatShowingLine(view) {
  if (view.viewItemTotal === 0 || view.viewItemTotal <= view.pageSize) {
    return null;
  }
  const anchor = view.pageAnchorEpoch === null ? "" : ` \xB7 ${formatLocalDateWithWeekday(view.pageAnchorEpoch)}`;
  return `${view.view} \xB7 page ${view.page}/${view.pageCount} (${view.viewItemTotal})${anchor}`;
}
function renderTurnTable(view, promptCap = PROMPT_COLUMN_CAP) {
  const renderedTurns = view.pageTurns.map((turn) => ({
    turn,
    marker: null
  }));
  return renderTurnRows(view, renderedTurns, promptCap);
}
function renderMilestoneDigest(view, promptCap = PROMPT_COLUMN_CAP) {
  const renderedTurns = view.pagedMilestones.map((milestone) => ({
    turn: milestone.turn,
    marker: milestone.invalidated ? "\u{1F6AB}" : milestone.reversal ? "\u21A9\uFE0F" : null
  }));
  return renderTurnRows(view, renderedTurns, promptCap, view.milestoneOverflowByDay);
}
function renderTurnRows(view, renderedTurns, promptCap, overflowByDay = []) {
  if (renderedTurns.length === 0) {
    return [];
  }
  const brokenPromptCandidates = /* @__PURE__ */ new Set();
  for (const pair of view.windowSignals.brokenPromptPairs) {
    brokenPromptCandidates.add(pair.first);
    brokenPromptCandidates.add(pair.second);
  }
  const previousEpochByPrompt = computePreviousEpochByPrompt(view.windowTurns);
  const lines = [
    "",
    "T# | line | time | gap | stats | prompt \u2192 title"
  ];
  let previousRenderedEpoch = null;
  for (let index = 0; index < renderedTurns.length; index += 1) {
    const { turn, marker } = renderedTurns[index];
    if (previousRenderedEpoch !== null && !sameLocalDate(previousRenderedEpoch, turn.createdAtEpoch)) {
      lines.push(renderDayDivider(turn.createdAtEpoch, previousRenderedEpoch));
    }
    lines.push(
      renderTurnRow(
        turn,
        previousEpochByPrompt.get(turn.promptNumber) ?? null,
        brokenPromptCandidates.has(turn.promptNumber),
        promptCap,
        marker
      )
    );
    previousRenderedEpoch = turn.createdAtEpoch;
    for (const overflow of overflowByDay) {
      if (overflow.lastKeptPrompt === turn.promptNumber) {
        lines.push(renderOverflowHint(view.session.id, overflow));
      }
    }
  }
  return lines;
}
function computePreviousEpochByPrompt(turns) {
  const out = /* @__PURE__ */ new Map();
  let previous = null;
  for (const turn of sortTurnsForAnalysis(turns)) {
    out.set(turn.promptNumber, previous);
    previous = turn.createdAtEpoch;
  }
  return out;
}
function renderDayDivider(currentEpoch, previousRenderedEpoch) {
  return `\u2500\u2500 ${formatLocalDateWithWeekday(currentEpoch)} \xB7 ${formatGap(currentEpoch, previousRenderedEpoch)} idle \u2500\u2500`;
}
function renderOverflowHint(sessionId, overflow) {
  return `   \u2026 +${overflow.count} more ${overflow.kind} this day \u2192 timeline(id="S${sessionId}", view="turns") @ T${overflow.firstPrompt}\u2013T${overflow.lastPrompt}`;
}
function renderTurnRow(turn, prevEpoch, isBrokenPromptCandidate, promptCap, marker = null) {
  const isUndone = turn.status === "undone";
  const compactMetadata = turn.type === "compact" ? getCompactMetadata(turn.tags) : null;
  const gapSuffix = isBrokenPromptCandidate ? " \u203B" : "";
  const sourceBadges = extractSourceTags(turn.tags).map((source) => `[ext:${source}]`).join(" ");
  const promptCore = turn.type === "compact" ? "/compact" : cleanPromptForLabel(turn.userPrompt);
  const promptWithBadges = turn.type === "compact" ? promptCore : sourceBadges.length > 0 ? `${sourceBadges} ${promptCore}` : promptCore;
  const promptText = sanitizeTimelineField(truncateText2(promptWithBadges, promptCap));
  const renderedPrompt = isUndone ? `~~${promptText}~~` : promptText;
  const statusPrefix = isUndone ? "\u2A2F " : "";
  const titleText = sanitizeTimelineField(
    renderTitleCell(turn, isUndone, compactMetadata, marker)
  );
  return [
    `${statusPrefix}T${turn.promptNumber}`,
    formatTranscriptLineAnchor(turn.transcriptLineStart),
    formatLocalTime(turn.createdAtEpoch),
    `${formatGap(turn.createdAtEpoch, prevEpoch)}${gapSuffix}`,
    renderStats(turn),
    `${renderedPrompt} \u2192 ${titleText}`
  ].join(" | ");
}
function renderStats(turn) {
  const stats = [];
  const toolCallCount = turn.toolCallCount ?? 0;
  if (toolCallCount > 0) {
    stats.push(`\u{1F527}${toolCallCount}`);
  }
  if (turn.filesRead.length > 0) {
    stats.push(`\u{1F4D6}${turn.filesRead.length}`);
  }
  if (turn.filesModified.length > 0) {
    stats.push(`\u270F\uFE0F${turn.filesModified.length}`);
  }
  return stats.length > 0 ? stats.join(" ") : "\u2014";
}
function renderTitleCell(turn, isUndone, compactMetadata, marker = null) {
  const markerPrefix = marker ? `${marker} ` : "";
  if (turn.type === "compact") {
    const preTokens = formatCompactTokenCount(compactMetadata?.preTokens ?? 0);
    const trigger = compactMetadata?.trigger ?? "manual";
    return `${markerPrefix}${TYPE_EMOJI_MAP.compact} /compact ${preTokens} tokens, ${trigger}`;
  }
  if (isUndone) {
    if (turn.type !== null && turn.title !== null) {
      const body = `${TYPE_EMOJI_MAP[turn.type] ?? "\u2022"} ${truncateText2(turn.title, TITLE_COLUMN_CAP - 3)}`;
      return `${markerPrefix}~~${body}~~`;
    }
    return `${markerPrefix}\u2A2F`.trim();
  }
  if (turn.status === "extracted" && turn.type !== null && turn.title !== null) {
    return `${markerPrefix}${TYPE_EMOJI_MAP[turn.type] ?? "\u2022"} ${truncateText2(turn.title, TITLE_COLUMN_CAP - 3)}`;
  }
  return `${markerPrefix}\u23F3`.trim();
}
function sanitizeTimelineField(value) {
  return value.replaceAll("|", "/").replaceAll("\u2192", "->");
}
function isTimelineLiveTurn(turn) {
  return turn.status !== "undone" && turn.status !== "skipped";
}
function renderPhases(view) {
  if (view.pagedPhases.length === 0) {
    return [];
  }
  const turnByPrompt = new Map(
    view.windowTurns.map((turn) => [turn.promptNumber, turn])
  );
  const lines = [
    "",
    "  phases:",
    "  # | date | type | turns | span | work | lead title"
  ];
  let previousPhaseEpoch = null;
  const startIndex = (view.page - 1) * view.pageSize;
  for (const [index, phase] of view.pagedPhases.entries()) {
    if (previousPhaseEpoch !== null && !sameLocalDate(previousPhaseEpoch, phase.startEpoch)) {
      lines.push(`  ${renderDayDivider(phase.startEpoch, previousPhaseEpoch)}`);
    }
    const range = phase.startPromptNumber === phase.endPromptNumber ? `T${phase.startPromptNumber}` : `T${phase.startPromptNumber}-T${phase.endPromptNumber}`;
    const durationLabel = phase.durationMs > 0 ? `~${formatDuration(phase.durationMs)}` : "<1m";
    const countsLabel = `${phase.turnCount} ${phase.turnCount === 1 ? "turn" : "turns"}`;
    const stats = [];
    if (phase.totalFilesRead > 0) {
      stats.push(`\u{1F4D6}${phase.totalFilesRead}`);
    }
    if (phase.totalFilesModified > 0) {
      stats.push(`\u270F\uFE0F${phase.totalFilesModified}`);
    }
    if (phase.totalToolCalls > 0) {
      stats.push(`\u{1F527}${phase.totalToolCalls}`);
    }
    const extSuffix = phase.externalInputs.length > 0 ? `  [ext:${phase.externalInputs.join(",")}]` : "";
    const dateLabel = sameLocalDate(phase.startEpoch, phase.endEpoch) ? formatLocalMonthDayWithWeekday(phase.startEpoch) : `${formatLocalMonthDay(phase.startEpoch)}\u2192${formatLocalMonthDay(phase.endEpoch)}`;
    const leadTurn = turnByPrompt.get(phase.startPromptNumber);
    const leadTextCandidate = leadTurn?.title ?? cleanPromptForLabel(leadTurn?.userPrompt ?? null);
    const leadText = leadTextCandidate.length > 0 ? leadTextCandidate : "(untitled)";
    const leadTitle = sanitizeTimelineField(
      truncateText2(
        leadText,
        TITLE_COLUMN_CAP
      )
    );
    lines.push(
      `  ${String(startIndex + index + 1).padStart(2)} | ${dateLabel.padEnd(11)} | ${phase.emoji} ${(phase.kind === "pending" ? "pending" : phase.type ?? "").padEnd(10)} | ${range.padEnd(8)} | ${durationLabel.padEnd(7)} | ${`${countsLabel} ${stats.join(" ")}`.trim().padEnd(16)} | ${leadTitle}${extSuffix}`.trimEnd()
    );
    previousPhaseEpoch = phase.endEpoch;
  }
  return lines;
}
function renderShapeSignals(view) {
  const windowLabel = view.window.startPromptNumber === view.firstPromptNumber && view.window.endPromptNumber === view.lastPromptNumber ? " = full session" : "";
  const lines = [
    "",
    `  shape signals (window T${view.window.startPromptNumber}-T${view.window.endPromptNumber}${windowLabel}):`
  ];
  if (view.windowSignals.fastestGap !== null) {
    lines.push(
      `    - fastest gap:   after T${view.windowSignals.fastestGap.afterPromptNumber} (+${formatDuration(view.windowSignals.fastestGap.ms)})`
    );
  }
  if (view.windowSignals.longestGap !== null) {
    lines.push(
      `    - longest gap:   after T${view.windowSignals.longestGap.afterPromptNumber} (+${formatDuration(view.windowSignals.longestGap.ms)})`
    );
  }
  if (view.windowSignals.toolBursts.length > 0) {
    lines.push(
      `    - tool bursts:   ${view.windowSignals.toolBursts.map((burst) => `T${burst.promptNumber} \u{1F527}${burst.toolCallCount}`).join(", ")}   [median \u{1F527}${view.windowSignals.toolBurstMedian}, threshold >\u{1F527}${view.windowSignals.toolBurstThreshold}]`
    );
  }
  if (view.windowSignals.brokenPromptPairs.length > 0) {
    lines.push(
      `    - broken-prompt: ${view.windowSignals.brokenPromptPairs.map((pair) => `T${pair.first}\u2192T${pair.second}`).join(", ")}`
    );
  }
  if (view.windowSignals.undoneTurns.length > 0) {
    lines.push(
      `    - undone turns:  ${view.windowSignals.undoneTurns.map((turn) => `T${turn}`).join(", ")}`
    );
  }
  if (view.windowSignals.externalInputs.length > 0) {
    lines.push(
      `    - external inputs: ${view.windowSignals.externalInputs.map((input) => `T${input.promptNumber} [ext:${input.source}]`).join(", ")}`
    );
  }
  const withinWindow = view.compactBoundaries.filter(
    (boundary) => boundary >= view.window.startPromptNumber && boundary <= view.window.endPromptNumber
  );
  const outsideWindow = view.compactBoundaries.filter(
    (boundary) => !withinWindow.includes(boundary)
  );
  if (withinWindow.length > 0 || outsideWindow.length > 0) {
    lines.push(
      `    - compact boundary: ${[
        ...withinWindow.map((boundary) => `after T${boundary} (within window)`),
        ...outsideWindow.map((boundary) => `after T${boundary} (outside window)`)
      ].join("; ")}`
    );
  }
  return lines;
}
function renderEarlierHint(view, options = {}) {
  if (!options.showEarlierHint || !view.hasEarlier) {
    return [];
  }
  return [
    "",
    `  earlier: timeline(id="S${view.session.id}/T${view.firstPromptNumber}..${view.window.startPromptNumber - 1}") or recall(id="S${view.session.id}")`
  ];
}
function renderLineagePointer(view) {
  if (view.session.parentSessionId === null) {
    return [];
  }
  return [
    "",
    `  earlier: recall(id="S${view.session.parentSessionId}")`
  ];
}
function renderTimeline(view, options = {}) {
  const promptCap = options.promptCap ?? PROMPT_COLUMN_CAP;
  const body = view.view === "phases" ? renderPhases(view) : view.view === "milestones" ? renderMilestoneDigest(view, promptCap) : renderTurnTable(view, promptCap);
  return [
    ...renderSessionHeader(view),
    ...body,
    ...renderShapeSignals(view),
    ...renderEarlierHint(view, options),
    ...renderLineagePointer(view)
  ].join("\n");
}

// src/mcp/session-output.ts
var buildContextTimelineViewWithMode = buildContextTimelineView;
var defaultTimelineRenderer = {
  buildContextTimelineView: buildContextTimelineViewWithMode,
  renderTimeline
};
function renderCurrentSessionOutput(db, session, sessionRecord, timelineRenderer = defaultTimelineRenderer) {
  const lines = [`[S${session.id}] ${session.title ?? "(untitled session)"}`];
  const pushField = (label, value) => {
    if (value) {
      lines.push(`  ${label}: ${value}`);
    }
  };
  const pushBulletLines = (items) => {
    for (const item of items) {
      lines.push(`    - ${item}`);
    }
  };
  const pushBulletField = (label, value) => {
    const items = splitBulletField(value);
    if (items.length === 0) {
      return;
    }
    lines.push(`  ${label}:`);
    pushBulletLines(items);
  };
  pushField("content", session.content);
  if (session.decision) {
    pushBulletField("decision", session.decision);
  } else {
    const insightLines = session.insight ?? [];
    if (insightLines.length > 0) {
      lines.push("  insight:");
      pushBulletLines(insightLines);
    }
  }
  pushBulletField("done", session.done);
  pushField("current", session.current);
  pushField("next", session.nextSteps);
  pushBulletField("reference", session.reference);
  try {
    const timelineView = timelineRenderer.buildContextTimelineView(
      db,
      sessionRecord.id,
      "milestones"
    );
    lines.push("");
    lines.push(
      timelineRenderer.renderTimeline(timelineView, {
        promptCap: 80,
        showEarlierHint: true
      })
    );
  } catch {
  }
  return lines.join("\n");
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
function queueItemExistsForTurn(db, kind, targetId) {
  const row = db.query(
    "SELECT 1 AS one FROM pending_queue WHERE kind = ? AND target_id = ? LIMIT 1"
  ).get(kind, targetId);
  return row !== null;
}

// src/db/recover-stranded.ts
function recoverStrandedTurns(db, sessionDbId, nowEpoch) {
  const stranded = getStrandedTurns(db, sessionDbId);
  let recovered = 0;
  for (const turn of stranded) {
    if (queueItemExistsForTurn(db, "turn-stop", turn.id)) {
      continue;
    }
    resetTurnExtractionFields(db, turn.id, nowEpoch);
    enqueueQueueItem(db, {
      kind: "turn-stop",
      targetId: turn.id,
      sessionDbId,
      enqueuedAtEpoch: nowEpoch
    });
    recovered += 1;
  }
  return recovered;
}
function recoverStrandedAncestors(db, childSessionId, nowEpoch, maxDepth = 16) {
  let recovered = 0;
  const visited = /* @__PURE__ */ new Set([childSessionId]);
  let current = getSession(db, childSessionId)?.parentSessionId ?? null;
  let depth = 0;
  while (current != null && depth < maxDepth && !visited.has(current)) {
    visited.add(current);
    recovered += recoverStrandedTurns(db, current, nowEpoch);
    current = getSession(db, current)?.parentSessionId ?? null;
    depth += 1;
  }
  return recovered;
}

// src/hooks/handlers/context.ts
var EMPTY_CONTEXT_FALLBACK = "claude-mnemo memory available via recall() and the mnemo-replay skill.";
function splitInsight(insight) {
  if (!insight) {
    return [];
  }
  return insight.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => line.replace(/^-+\s*/, ""));
}
function buildHeader(db, primarySessionId) {
  const sessionCount = db.query("SELECT COUNT(*) AS count FROM sessions").get()?.count ?? 0;
  const observationCount = db.query("SELECT COUNT(*) AS count FROM observations").get()?.count ?? 0;
  return [
    `claude-mnemo: ${sessionCount} sessions, ${observationCount} observations${primarySessionId ? ` | current: S${primarySessionId}` : ""}`,
    "Axes: recall (content) \xB7 timeline (temporal) \xB7 mnemo-replay (raw)"
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
function buildSessionView(db, session, metrics) {
  return {
    id: session.id,
    title: session.title,
    project: session.project,
    createdAtEpoch: session.createdAtEpoch,
    content: session.content,
    insight: splitInsight(session.insight),
    nextSteps: session.nextSteps,
    decision: resolveTurnPointers(db, session.id, session.decision),
    done: resolveTurnPointers(db, session.id, session.done),
    current: session.current,
    reference: session.reference,
    turnCount: metrics?.turnCount ?? 0,
    observationCount: metrics?.observationCount ?? 0,
    jsonlPath: resolveTranscriptPath(session.project, session.contentSessionId)
  };
}
function classifyTimeGroup(epochSeconds, now) {
  const target = new Date(epochSeconds * 1e3);
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart.getTime() - 864e5);
  const weekStart = new Date(todayStart.getTime() - 6 * 864e5);
  if (target >= todayStart) {
    return "Today";
  }
  if (target >= yesterdayStart) {
    return "Yesterday";
  }
  if (target >= weekStart) {
    return "Last 7 days";
  }
  return "Earlier";
}
function buildRecentSessionsOutput(db, recentSessions, sessionMetrics, primarySessionId) {
  const others = recentSessions.filter((session) => session.id !== primarySessionId).slice(0, 10);
  if (others.length === 0) {
    return [];
  }
  const now = /* @__PURE__ */ new Date();
  const lines = [];
  let currentGroup = "";
  for (const session of others) {
    const group = classifyTimeGroup(session.createdAtEpoch, now);
    if (group !== currentGroup) {
      currentGroup = group;
      lines.push(`### ${group}`);
    }
    lines.push(
      renderNode(
        { type: "session", value: buildSessionView(db, session, sessionMetrics.get(session.id)) },
        { depth: "collapsed", truncate: 120, mode: "unified" }
      )
    );
  }
  return lines;
}
function buildContextOutput(db, input, timelineRenderer) {
  if (input.sessionId && !getSessionByContentId(db, input.sessionId)) {
    upsertSession(db, {
      contentSessionId: input.sessionId,
      project: input.cwd ?? "",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: Math.floor(Date.now() / 1e3),
      updatedAtEpoch: null,
      completedAtEpoch: null
    });
  }
  const recentSessions = getRecentSessions(db, {
    project: input.cwd ?? void 0,
    limit: 20
  });
  const primarySessionRecord = resolvePrimarySessionRecord(
    db,
    input,
    recentSessions
  );
  if (!primarySessionRecord) {
    return EMPTY_CONTEXT_FALLBACK;
  }
  if (input.source === "resume" || input.source === "compact") {
    recoverStrandedTurns(
      db,
      primarySessionRecord.id,
      Math.floor(Date.now() / 1e3)
    );
  }
  const sessionIds = Array.from(
    /* @__PURE__ */ new Set([...recentSessions.map((session) => session.id), primarySessionRecord.id])
  );
  const sessionMetrics = buildSessionMetricMap(db, sessionIds);
  const primarySession = buildSessionView(
    db,
    primarySessionRecord,
    sessionMetrics.get(primarySessionRecord.id)
  );
  const recentSessionOutputs = buildRecentSessionsOutput(
    db,
    recentSessions,
    sessionMetrics,
    primarySessionRecord.id
  );
  const primaryTurnCount = sessionMetrics.get(primarySessionRecord.id)?.turnCount ?? 0;
  const includeCurrentSession = input.source !== "startup" && primaryTurnCount > 0;
  return [
    buildHeader(db, input.sessionId ? primarySessionRecord.id : void 0),
    "",
    ...includeCurrentSession ? [
      "## Current Session",
      "",
      renderCurrentSessionOutput(
        db,
        primarySession,
        primarySessionRecord,
        timelineRenderer
      ),
      ""
    ] : [],
    "## Recent Sessions",
    "",
    ...recentSessionOutputs
  ].join("\n");
}
function createContextHandler(dependencies) {
  return async function handleContextHook(input) {
    return {
      continue: true,
      hookSpecificOutput: buildContextOutput(
        dependencies.db,
        input,
        dependencies.timelineRenderer
      )
    };
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
function isChainParticipant(entry) {
  return entry.type !== "progress";
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
function detectInterruptedPromptIdsInEntries(entries) {
  return collectInterruptedPromptIds(entries);
}
function readAllTranscriptEntries(transcriptPath) {
  if (!(0, import_node_fs3.existsSync)(transcriptPath)) {
    return [];
  }
  const rawTranscript = (0, import_node_fs3.readFileSync)(transcriptPath, "utf8");
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
function collectOrderedPromptIds(entries) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  entries.forEach((entry, index) => {
    if (entry.promptId && !seen.has(entry.promptId)) {
      seen.add(entry.promptId);
      out.push({ promptId: entry.promptId, index });
    }
  });
  return out;
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
function countUserPromptsInEntries(entries) {
  const seenPromptIds = /* @__PURE__ */ new Set();
  let count = 0;
  for (const entry of entries) {
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

// src/hooks/handlers/post-compact.ts
function getRawContentText(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content.filter((block) => {
    return Boolean(block) && typeof block === "object";
  }).filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n");
}
function findLatestCompactBoundary(entries) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type === "system" && entry.subtype === "compact_boundary" && entry.uuid) {
      return {
        uuid: entry.uuid,
        index,
        compactMetadata: entry.compactMetadata
      };
    }
  }
  return null;
}
function findSummaryWrapper(entries, boundary) {
  const nextEntry = entries[boundary.index + 1];
  if (!nextEntry || nextEntry.role !== "user" || nextEntry.parentUuid !== boundary.uuid || !nextEntry.promptId) {
    return null;
  }
  const content = getRawContentText(nextEntry.content);
  if (!content) {
    return null;
  }
  return {
    promptId: nextEntry.promptId,
    lineNumber: nextEntry.lineNumber,
    content
  };
}
function resolvePreCompactTokens(input, boundary) {
  const rawMetadata = input.raw.compact_metadata && typeof input.raw.compact_metadata === "object" ? input.raw.compact_metadata : null;
  if (typeof rawMetadata?.preCompactTokenCount === "number") {
    return rawMetadata.preCompactTokenCount;
  }
  if (typeof rawMetadata?.pre_tokens === "number") {
    return rawMetadata.pre_tokens;
  }
  if (typeof boundary.compactMetadata?.preCompactTokenCount === "number") {
    return boundary.compactMetadata.preCompactTokenCount;
  }
  if (typeof boundary.compactMetadata?.pre_tokens === "number") {
    return boundary.compactMetadata.pre_tokens;
  }
  return null;
}
function resolveTrigger(input, boundary) {
  if (input.trigger === "auto" || input.trigger === "manual") {
    return input.trigger;
  }
  if (boundary.compactMetadata?.trigger === "auto" || boundary.compactMetadata?.trigger === "manual") {
    return boundary.compactMetadata.trigger;
  }
  return "manual";
}
function createPostCompactHandler(dependencies) {
  const now = dependencies.now ?? (() => Math.floor(Date.now() / 1e3));
  return async function handlePostCompactHook(input) {
    if (!input.sessionId || !input.transcriptPath) {
      return { continue: true };
    }
    const session = getSessionByContentId(dependencies.db, input.sessionId);
    if (!session) {
      return { continue: true };
    }
    const entries = readAllTranscriptEntries(input.transcriptPath);
    const boundary = findLatestCompactBoundary(entries);
    if (!boundary) {
      return { continue: true };
    }
    const summaryWrapper = findSummaryWrapper(entries, boundary);
    if (!summaryWrapper) {
      return { continue: true };
    }
    const parsedTurns = parseReplayTranscript(input.transcriptPath, entries);
    const promptNumber = parsedTurns.find((turn) => turn.promptId === summaryWrapper.promptId)?.promptNumber ?? null;
    if (promptNumber === null) {
      return { continue: true };
    }
    const preCompactTokens = resolvePreCompactTokens(input, boundary);
    const trigger = resolveTrigger(input, boundary);
    const tags = [
      `compact:pre_tokens=${preCompactTokens ?? 0}`,
      `compact:trigger=${trigger}`
    ];
    dependencies.db.query(
      `INSERT OR IGNORE INTO turns (
          session_id,
          prompt_number,
          content_prompt_id,
          status,
          title,
          content,
          type,
          transcript_line_start,
          tags,
          files_read,
          files_modified,
          tool_call_count,
          created_at_epoch
        ) VALUES (?, ?, ?, 'extracted', ?, ?, ?, ?, ?, ?, ?, 0, ?)`
    ).run(
      session.id,
      promptNumber,
      summaryWrapper.promptId,
      "/compact",
      summaryWrapper.content,
      "compact",
      summaryWrapper.lineNumber,
      JSON.stringify(tags),
      "[]",
      "[]",
      now()
    );
    return { continue: true };
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
  const writeTransaction = dependencies.runHookWriteTransaction ?? runHookWriteTransaction;
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
    writeTransaction(dependencies.db, () => {
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
    });
    return {
      continue: true,
      asyncWork: async () => {
        await notifyWorkerWake(
          dependencies.workerClientDeps,
          dependencies.workerEnv
        );
      }
    };
  };
}

// src/hooks/handlers/session-end.ts
function createSessionEndHandler(dependencies) {
  return async function handleSessionEndHook(input) {
    if (!input.sessionId) {
      return { continue: true };
    }
    const session = getSessionByContentId(dependencies.db, input.sessionId);
    if (!session) {
      return { continue: true };
    }
    return {
      continue: true,
      asyncWork: async () => {
        await notifyWorkerFlush(
          session.id,
          dependencies.workerClientDeps,
          dependencies.workerEnv
        );
      }
    };
  };
}

// src/worker/invalidation.ts
var interruptReason = {
  key: "interrupt",
  pendingTag: "invalidated:notify-pending:interrupt",
  notifiedTag: "invalidated:notified:interrupt",
  qualifies: (turn) => turn.status === "extracted" || turn.status === "skipped",
  data: () => null,
  flagToken: () => "was_interrupted"
};
var rollbackReason = {
  key: "rollback",
  pendingTag: "invalidated:notify-pending:rollback",
  notifiedTag: "invalidated:notified:rollback",
  qualifies: (turn) => turn.status === "extracted" || turn.status === "skipped",
  data: (turn, ctx) => {
    const replacementPromptId = turn.contentPromptId ? ctx.replacementByPromptId.get(turn.contentPromptId) : void 0;
    return {
      replacementTurnId: replacementPromptId ? ctx.turnIdByPromptId.get(replacementPromptId) ?? null : null
    };
  },
  flagToken: () => "was_rolled_back",
  parenExtra: (_turn, data) => data.replacementTurnId !== null ? `replaced by T${data.replacementTurnId}` : null
};
function addPendingReason(tags, reason) {
  if (tags.includes(reason.pendingTag) || tags.includes(reason.notifiedTag)) {
    return tags;
  }
  return [...tags, reason.pendingTag];
}
function selectLatestMainLeaf(entries) {
  const parentSet = new Set(
    entries.map((entry) => entry.parentUuid).filter((uuid) => Boolean(uuid))
  );
  const leaves = entries.filter(
    (entry) => entry.uuid && !parentSet.has(entry.uuid) && entry.isSidechain !== true && isChainParticipant(entry)
  );
  if (leaves.length === 0) {
    return null;
  }
  return leaves.reduce((latest, entry) => {
    const latestTime = latest.timestamp ?? "";
    const entryTime = entry.timestamp ?? "";
    if (entryTime > latestTime) {
      return entry;
    }
    if (entryTime === latestTime && entry.lineNumber > latest.lineNumber) {
      return entry;
    }
    return latest;
  });
}
function detectRollbackTopologyFromEntries(entries) {
  if (entries.length === 0) {
    return {
      rolledBackPromptIds: /* @__PURE__ */ new Set(),
      replacementByPromptId: /* @__PURE__ */ new Map()
    };
  }
  const byUuid = new Map(
    entries.filter(
      (entry) => typeof entry.uuid === "string"
    ).map((entry) => [entry.uuid, entry])
  );
  const childrenByParent = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    if (!entry.parentUuid) {
      continue;
    }
    const children = childrenByParent.get(entry.parentUuid) ?? [];
    children.push(entry);
    childrenByParent.set(entry.parentUuid, children);
  }
  const tip = selectLatestMainLeaf(entries);
  if (!tip?.uuid) {
    return {
      rolledBackPromptIds: /* @__PURE__ */ new Set(),
      replacementByPromptId: /* @__PURE__ */ new Map()
    };
  }
  const mainChainUuids = /* @__PURE__ */ new Set();
  let cursor = tip;
  while (cursor?.uuid) {
    mainChainUuids.add(cursor.uuid);
    cursor = cursor.parentUuid ? byUuid.get(cursor.parentUuid) : void 0;
  }
  const rolledBackPromptIds = /* @__PURE__ */ new Set();
  const replacementByPromptId = /* @__PURE__ */ new Map();
  for (const children of childrenByParent.values()) {
    const userChildren = children.filter(
      (child) => child.role === "user" && child.promptId && child.isSidechain !== true && isChainParticipant(child)
    );
    if (userChildren.length < 2) {
      continue;
    }
    const mainChild = userChildren.find(
      (child) => mainChainUuids.has(child.uuid ?? "")
    );
    if (!mainChild?.promptId) {
      continue;
    }
    for (const child of userChildren) {
      const childPromptId = child.promptId;
      if (!childPromptId) {
        continue;
      }
      if (childPromptId === mainChild.promptId) {
        continue;
      }
      if (mainChainUuids.has(child.uuid ?? "")) {
        continue;
      }
      rolledBackPromptIds.add(childPromptId);
      replacementByPromptId.set(childPromptId, mainChild.promptId);
    }
  }
  return {
    rolledBackPromptIds,
    replacementByPromptId
  };
}
function computeInvalidationSets(entries) {
  const rollbackDetection = detectRollbackTopologyFromEntries(entries);
  return {
    interruptedPromptIds: detectInterruptedPromptIdsInEntries(entries),
    rolledBackPromptIds: rollbackDetection.rolledBackPromptIds,
    replacementByPromptId: rollbackDetection.replacementByPromptId
  };
}
function applyInvalidationSets(db, sessionDbId, invalidationSets, epoch) {
  const { interruptedPromptIds, rolledBackPromptIds } = invalidationSets;
  const turns = getTurnsForSession(db, sessionDbId);
  for (const turn of turns) {
    if (!turn.contentPromptId) {
      continue;
    }
    const detectedInterrupt = interruptedPromptIds.has(turn.contentPromptId);
    const detectedRollback = rolledBackPromptIds.has(turn.contentPromptId);
    const nextWasInterrupted = turn.wasInterrupted || detectedInterrupt;
    const nextWasRolledBack = turn.wasRolledBack || detectedRollback;
    let nextTags = turn.tags;
    if (detectedInterrupt && !turn.wasInterrupted) {
      nextTags = addPendingReason(nextTags, interruptReason);
    }
    if (detectedRollback && !turn.wasRolledBack) {
      nextTags = addPendingReason(nextTags, rollbackReason);
    }
    if (nextWasInterrupted === turn.wasInterrupted && nextWasRolledBack === turn.wasRolledBack && nextTags === turn.tags) {
      continue;
    }
    updateTurnById(db, turn.id, {
      status: turn.status,
      wasInterrupted: nextWasInterrupted,
      wasRolledBack: nextWasRolledBack,
      replaceTags: nextTags,
      updatedAtEpoch: epoch
    });
  }
}

// src/worker/subagent-filter.ts
var SUBAGENT_PENDING_TAG = "subagent:pending";
var SUBAGENT_NOTIFIED_TAG = "subagent:notified";
function addSubagentPendingTag(tags) {
  if (tags.includes(SUBAGENT_PENDING_TAG) || tags.includes(SUBAGENT_NOTIFIED_TAG)) {
    return tags;
  }
  return [...tags, SUBAGENT_PENDING_TAG];
}
function deleteObservationFtsRows(db, observationIds) {
  if (observationIds.length === 0) {
    return;
  }
  const deleteStatement = db.query(
    "DELETE FROM memory_fts WHERE layer = 'observation' AND source_id = ?"
  );
  for (const observationId of observationIds) {
    deleteStatement.run(observationId);
  }
}
function selectObservationIdsForTurns(db, turnIds) {
  if (turnIds.length === 0) {
    return [];
  }
  return db.query(
    `
        SELECT id
        FROM observations
        WHERE turn_id IN (${turnIds.map(() => "?").join(", ")})
        ORDER BY id ASC
      `
  ).all(...turnIds).map((row) => row.id);
}
function deleteTurnStopQueueItems(db, sessionDbId, turnIds) {
  if (turnIds.length === 0) {
    return;
  }
  db.query(
    `
      DELETE FROM pending_queue
      WHERE session_db_id = ?
        AND kind = 'turn-stop'
        AND target_id IN (${turnIds.map(() => "?").join(", ")})
    `
  ).run(sessionDbId, ...turnIds);
}
function deleteObservationQueueItems(db, sessionDbId, observationIds) {
  if (observationIds.length === 0) {
    return;
  }
  db.query(
    `
      DELETE FROM pending_queue
      WHERE session_db_id = ?
        AND kind = 'obs'
        AND target_id IN (${observationIds.map(() => "?").join(", ")})
    `
  ).run(sessionDbId, ...observationIds);
}
function deleteObservationsForTurns(db, turnIds) {
  if (turnIds.length === 0) {
    return;
  }
  db.query(
    `
      DELETE FROM observations
      WHERE turn_id IN (${turnIds.map(() => "?").join(", ")})
    `
  ).run(...turnIds);
}
function resolveSubagentTurnsFromParsedTurns(db, sessionDbId, parsedTurns) {
  const newestSubagentChain = [];
  for (let index = parsedTurns.length - 1; index >= 0; index -= 1) {
    const parsedTurn = parsedTurns[index];
    if (!parsedTurn.isSidechain) {
      break;
    }
    newestSubagentChain.unshift(parsedTurn);
  }
  if (newestSubagentChain.length === 0) {
    return [];
  }
  const liveTurns = getTurnsForSession(db, sessionDbId).filter(
    (turn) => turn.status !== "undone"
  );
  const byPromptId = new Map(
    liveTurns.filter((turn) => turn.contentPromptId).map((turn) => [turn.contentPromptId, turn])
  );
  const byPromptNumber = new Map(liveTurns.map((turn) => [turn.promptNumber, turn]));
  const matched = /* @__PURE__ */ new Map();
  for (const parsedTurn of newestSubagentChain) {
    const turn = (parsedTurn.promptId ? byPromptId.get(parsedTurn.promptId) : void 0) ?? byPromptNumber.get(parsedTurn.promptNumber);
    if (turn) {
      matched.set(turn.id, turn);
    }
  }
  return [...matched.values()].sort((left, right) => left.promptNumber - right.promptNumber);
}
function cleanSubagentTurns(db, sessionDbId, matchedTurns, updatedAtEpoch) {
  if (matchedTurns.length === 0) {
    return [];
  }
  const turnIds = matchedTurns.map((turn) => turn.id);
  const observationIds = selectObservationIdsForTurns(db, turnIds);
  deleteTurnStopQueueItems(db, sessionDbId, turnIds);
  deleteObservationQueueItems(db, sessionDbId, observationIds);
  deleteObservationFtsRows(db, observationIds);
  deleteObservationsForTurns(db, turnIds);
  for (const turn of matchedTurns) {
    updateTurnById(db, turn.id, {
      status: "undone",
      replaceTags: addSubagentPendingTag(turn.tags),
      updatedAtEpoch
    });
  }
  return matchedTurns.map((turn) => turn.promptNumber);
}
function detectAndCleanSubagentTurnsFromParsed(db, sessionDbId, parsedTurns, updatedAtEpoch) {
  return cleanSubagentTurns(
    db,
    sessionDbId,
    resolveSubagentTurnsFromParsedTurns(
      db,
      sessionDbId,
      parsedTurns
    ),
    updatedAtEpoch
  );
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
  const writeTransaction = dependencies.runHookWriteTransaction ?? runHookWriteTransaction;
  return async function handleSessionInitHook(input) {
    if (!input.sessionId || !input.cwd || !input.prompt) {
      return {
        continue: true,
        suppressOutput: true
      };
    }
    const epoch = now();
    const contentSessionId = input.sessionId;
    const project = input.cwd;
    const prompt = input.prompt;
    const existingSession = getSessionByContentId(dependencies.db, contentSessionId);
    const transcriptEntries = input.transcriptPath ? readAllTranscriptEntries(input.transcriptPath) : null;
    const invalidationSets = transcriptEntries ? computeInvalidationSets(transcriptEntries) : null;
    const parsedTurns = transcriptEntries ? parseReplayTranscript(input.transcriptPath ?? "", transcriptEntries) : null;
    const transcriptPromptCount = transcriptEntries ? countUserPromptsInEntries(transcriptEntries) : null;
    writeTransaction(dependencies.db, () => {
      const session = upsertSession(dependencies.db, {
        contentSessionId,
        project,
        title: existingSession?.title ?? null,
        content: existingSession?.content ?? null,
        insight: existingSession?.insight ?? null,
        createdAtEpoch: existingSession?.createdAtEpoch ?? epoch,
        updatedAtEpoch: epoch,
        completedAtEpoch: existingSession?.completedAtEpoch ?? null
      });
      if (transcriptEntries && invalidationSets && parsedTurns) {
        applyInvalidationSets(
          dependencies.db,
          session.id,
          invalidationSets,
          epoch
        );
        detectAndCleanSubagentTurnsFromParsed(
          dependencies.db,
          session.id,
          parsedTurns,
          epoch
        );
      }
      const dbMaxPromptNumber = getMaxPromptNumber(dependencies.db, session.id);
      const promptNumber = dbMaxPromptNumber !== null ? dbMaxPromptNumber + 1 : transcriptPromptCount !== null ? transcriptPromptCount + 1 : 1;
      createPendingTurn(
        dependencies.db,
        session.id,
        promptNumber,
        prompt,
        epoch
      );
    });
    return {
      continue: true,
      suppressOutput: true
    };
  };
}

// src/db/lineage.ts
function linkIntraSessionChain(db, sessionDbId) {
  db.query(
    `UPDATE turns SET parent_turn_id = (
       SELECT p.id FROM turns p
       WHERE p.session_id = turns.session_id AND p.prompt_number < turns.prompt_number
       ORDER BY p.prompt_number DESC LIMIT 1
     )
     WHERE session_id = ? AND parent_turn_id IS NULL
       AND EXISTS (
         SELECT 1 FROM turns p
         WHERE p.session_id = turns.session_id AND p.prompt_number < turns.prompt_number
       )`
  ).run(sessionDbId);
}
var OWNERSHIP_QUERY_CHUNK = 500;
function classifyPromptOwnership(db, childSessionId, promptIds) {
  const result = /* @__PURE__ */ new Map();
  for (const p of promptIds) result.set(p, { ownership: "unknown", owners: [] });
  if (promptIds.length === 0) return result;
  for (let start = 0; start < promptIds.length; start += OWNERSHIP_QUERY_CHUNK) {
    const chunk = promptIds.slice(start, start + OWNERSHIP_QUERY_CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = db.query(
      `SELECT content_prompt_id, session_id, id AS turn_id, prompt_number
         FROM turns
         WHERE content_prompt_id IN (${placeholders}) AND content_prompt_id IS NOT NULL`
    ).all(...chunk);
    for (const row of rows) {
      result.get(row.content_prompt_id).owners.push({
        sessionId: row.session_id,
        turnId: row.turn_id,
        promptNumber: row.prompt_number
      });
    }
  }
  for (const [, e] of result) {
    if (e.owners.length === 0) {
      e.ownership = "unknown";
    } else if (e.owners.some((o) => o.sessionId !== childSessionId)) {
      e.ownership = "foreign";
    } else {
      e.ownership = "child";
    }
  }
  return result;
}
function isContiguousRun(prefixOwnerships) {
  const first = prefixOwnerships.indexOf("foreign");
  if (first === -1) return false;
  let last = first;
  for (let i = first; i < prefixOwnerships.length; i += 1) {
    if (prefixOwnerships[i] === "foreign") last = i;
  }
  for (let i = first; i <= last; i += 1) {
    if (prefixOwnerships[i] !== "foreign") return false;
  }
  return true;
}
function pickForeignOwner(owners, overlapBySession, childCreated, db) {
  if (owners.length === 0) return null;
  if (owners.length === 1) return owners[0];
  const overlapMap = /* @__PURE__ */ new Map();
  for (const { sessionId, overlap } of overlapBySession) {
    overlapMap.set(sessionId, Math.max(overlapMap.get(sessionId) ?? 0, overlap));
  }
  let bestOverlap = -1;
  let overlapWinners = [];
  for (const owner of owners) {
    const ov = overlapMap.get(owner.sessionId) ?? 0;
    if (ov > bestOverlap) {
      bestOverlap = ov;
      overlapWinners = [owner];
    } else if (ov === bestOverlap) {
      overlapWinners.push(owner);
    }
  }
  if (bestOverlap > 0 && overlapWinners.length === 1) {
    return overlapWinners[0];
  }
  const contenders = bestOverlap > 0 ? overlapWinners : owners;
  if (db) {
    let best = null;
    let bestCreated = -1;
    let tied = false;
    for (const owner of contenders) {
      const session = getSession(db, owner.sessionId);
      const created = session?.createdAtEpoch;
      if (created === void 0 || created > childCreated) continue;
      if (created > bestCreated) {
        bestCreated = created;
        best = owner;
        tied = false;
      } else if (created === bestCreated) {
        tied = true;
      }
    }
    if (best && !tied) return best;
  }
  return null;
}
function resolveViaLogicalParentFromEntries(db, entries, childSessionId, ownership) {
  const byUuid = /* @__PURE__ */ new Map();
  for (const e of entries) {
    if (e.uuid && !byUuid.has(e.uuid)) byUuid.set(e.uuid, e);
  }
  for (const boundary of entries) {
    if (boundary.subtype !== "compact_boundary") continue;
    const targetUuid = boundary.logicalParentUuid;
    if (!targetUuid) continue;
    const target = byUuid.get(targetUuid);
    if (!target) continue;
    if (target.subtype === "compact_boundary") continue;
    const promptId = target.promptId;
    if (!promptId) continue;
    const own = ownership.get(promptId) ?? classifyPromptOwnership(db, childSessionId, [promptId]).get(promptId);
    if (!own || own.ownership !== "foreign") continue;
    const owner = pickForeignOwner(
      own.owners.filter((o) => o.sessionId !== childSessionId),
      [],
      getSession(db, childSessionId)?.createdAtEpoch ?? Number.MAX_SAFE_INTEGER,
      db
    );
    if (!owner) continue;
    return {
      status: "resolved",
      parentSessionId: owner.sessionId,
      forkTurnId: owner.turnId
    };
  }
  return null;
}
function resolveSessionLineageFromEntries(db, childSessionId, entries) {
  const ordered = collectOrderedPromptIds(entries);
  if (ordered.length === 0) return { status: "unresolved" };
  const own = classifyPromptOwnership(
    db,
    childSessionId,
    ordered.map((o) => o.promptId)
  );
  const hasBoundary = entries.some((e) => e.subtype === "compact_boundary");
  const ownershipOf = (promptId) => own.get(promptId)?.ownership ?? "unknown";
  let boundaryIndex = ordered.findIndex((o) => ownershipOf(o.promptId) === "child");
  if (boundaryIndex === -1) boundaryIndex = ordered.length;
  const prefix = ordered.slice(0, boundaryIndex);
  const prefixOwnerships = prefix.map((o) => ownershipOf(o.promptId));
  const foreignInPrefix = prefix.filter((o) => ownershipOf(o.promptId) === "foreign");
  const unknownInPrefix = prefix.filter((o) => ownershipOf(o.promptId) === "unknown");
  if (foreignInPrefix.length > 0 && isContiguousRun(prefixOwnerships)) {
    const latestForeign = foreignInPrefix[foreignInPrefix.length - 1];
    const entry = own.get(latestForeign.promptId);
    const foreignOwners = entry.owners.filter((o) => o.sessionId !== childSessionId);
    const overlapBySession = computePrefixOverlap(prefix, foreignOwners, own, childSessionId);
    const childCreated = getSession(db, childSessionId)?.createdAtEpoch ?? Number.MAX_SAFE_INTEGER;
    const owner = pickForeignOwner(foreignOwners, overlapBySession, childCreated, db);
    if (owner) {
      return {
        status: "resolved",
        parentSessionId: owner.sessionId,
        forkTurnId: owner.turnId
      };
    }
    return { status: "unresolved" };
  }
  const viaLogical = resolveViaLogicalParentFromEntries(db, entries, childSessionId, own);
  if (viaLogical) return viaLogical;
  if (!hasBoundary && foreignInPrefix.length === 0 && unknownInPrefix.length === 0) {
    return { status: "root" };
  }
  if (hasBoundary && foreignInPrefix.length === 0 && unknownInPrefix.length === 0) {
    return { status: "root" };
  }
  return { status: "unresolved" };
}
function relinkSessionLineageFromEntries(db, sessionDbId, entries, nowEpoch) {
  void nowEpoch;
  linkIntraSessionChain(db, sessionDbId);
  const session = getSession(db, sessionDbId);
  if (!session) return;
  if (session.lineageStatus === "resolved" || session.lineageStatus === "root") {
    return;
  }
  const res = entries === null ? { status: "unresolved" } : resolveSessionLineageFromEntries(db, sessionDbId, entries);
  db.transaction(() => {
    if (res.status === "resolved" && res.forkTurnId != null && res.parentSessionId != null) {
      const first = getFirstTurn(db, sessionDbId);
      if (first) setTurnParent(db, first.id, res.forkTurnId);
      setSessionParent(db, sessionDbId, res.parentSessionId);
      setSessionLineageStatus(db, sessionDbId, "resolved");
    } else if (res.status === "root") {
      setSessionLineageStatus(db, sessionDbId, "root");
    } else {
      setSessionLineageStatus(db, sessionDbId, "unresolved");
    }
  })();
}
function computePrefixOverlap(prefix, foreignOwners, ownership, childSessionId) {
  const candidateSessions = new Set(foreignOwners.map((o) => o.sessionId));
  const out = [];
  for (const sessionId of candidateSessions) {
    let overlap = 0;
    for (let i = prefix.length - 1; i >= 0; i -= 1) {
      const own = ownership.get(prefix[i].promptId);
      const ownedByCandidate = own?.owners.some(
        (o) => o.sessionId === sessionId && sessionId !== childSessionId
      ) ?? false;
      if (ownedByCandidate) overlap += 1;
      else break;
    }
    out.push({ sessionId, overlap });
  }
  return out;
}

// src/hooks/backfill.ts
function backfillFromTranscript(db, pendingTurns, transcriptPath, lastAssistantMessage, transcriptTurns) {
  if (pendingTurns.length === 0) {
    return;
  }
  const replayTurns = transcriptTurns ?? (transcriptPath ? parseReplayTranscript(transcriptPath) : []);
  const lastPendingPromptNumber = pendingTurns[pendingTurns.length - 1]?.promptNumber;
  for (const pendingTurn of pendingTurns) {
    if (pendingTurn.assistantResponse || !pendingTurn.userPrompt) {
      continue;
    }
    const isLatestPendingTurn = pendingTurn.promptNumber === lastPendingPromptNumber;
    const transcriptTurn = isLatestPendingTurn ? replayTurns[replayTurns.length - 1] : replayTurns.find(
      (turn) => turn.promptNumber === pendingTurn.promptNumber
    );
    if (!transcriptTurn && !isLatestPendingTurn) {
      continue;
    }
    const assistantResponse = isLatestPendingTurn && lastAssistantMessage !== void 0 ? lastAssistantMessage : transcriptTurn?.assistantText ?? "";
    const toolCallCount = transcriptTurn?.toolCalls.length ?? 0;
    const contentPromptId = isLatestPendingTurn && transcriptTurn?.promptId ? transcriptTurn.promptId : void 0;
    updateTurnBackfill(
      db,
      pendingTurn.id,
      assistantResponse,
      toolCallCount,
      contentPromptId,
      transcriptTurn?.transcriptLineStart
    );
  }
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
  const writeTransaction = dependencies.runHookWriteTransaction ?? runHookWriteTransaction;
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
    const transcriptEntries = input.transcriptPath ? readAllTranscriptEntries(input.transcriptPath) : null;
    const parsedTurns = transcriptEntries ? parseReplayTranscript(input.transcriptPath ?? "", transcriptEntries) : null;
    const invalidationSets = transcriptEntries ? computeInvalidationSets(transcriptEntries) : null;
    writeTransaction(dependencies.db, () => {
      const orphanTurns = getOrphanTurns(dependencies.db, session.id, turn.id);
      if (transcriptEntries && parsedTurns && invalidationSets) {
        const allTurns = getTurnsForSession(dependencies.db, session.id);
        backfillFromTranscript(
          dependencies.db,
          allTurns,
          void 0,
          assistantResponse ?? void 0,
          parsedTurns
        );
        applyInvalidationSets(
          dependencies.db,
          session.id,
          invalidationSets,
          epoch
        );
      }
      relinkSessionLineageFromEntries(
        dependencies.db,
        session.id,
        transcriptEntries,
        epoch
      );
      recoverStrandedAncestors(dependencies.db, session.id, epoch);
      for (const orphanTurn of orphanTurns) {
        dependencies.db.query(
          `
              UPDATE turns
              SET updated_at_epoch = ?
              WHERE id = ?
            `
        ).run(epoch, orphanTurn.id);
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
      if (parsedTurns) {
        detectAndCleanSubagentTurnsFromParsed(
          dependencies.db,
          session.id,
          parsedTurns,
          epoch
        );
      }
    });
    return {
      continue: true,
      exitCode: HOOK_SUCCESS_EXIT_CODE,
      asyncWork: async () => {
        await notifyWorkerWake(
          dependencies.workerClientDeps,
          dependencies.workerEnv
        );
      }
    };
  };
}

// src/hooks/hook-command.ts
var defaultHandlers;
var HOOK_DB_BUSY_TIMEOUT_MS = 800;
function getDefaultHandlers() {
  if (defaultHandlers) {
    return defaultHandlers;
  }
  const db = createDatabase(void 0, { busyTimeoutMs: HOOK_DB_BUSY_TIMEOUT_MS });
  initializeDatabase(db);
  defaultHandlers = {
    SessionStart: createContextHandler({ db }),
    SessionEnd: createSessionEndHandler({ db }),
    PostToolUse: createPostToolUseHandler({ db }),
    PostCompact: createPostCompactHandler({ db }),
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
    case "session-end":
      return "SessionEnd";
    case "tool-use":
      return "PostToolUse";
    case "post-compact":
      return "PostCompact";
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
