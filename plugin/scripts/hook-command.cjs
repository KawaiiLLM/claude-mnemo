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
  createDefaultHookHandlers: () => createDefaultHookHandlers,
  runHookCommand: () => runHookCommand
});
module.exports = __toCommonJS(hook_command_exports);
var import_node_fs9 = require("node:fs");
var import_bun_sqlite2 = require("bun:sqlite");

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
function transcriptRootPath() {
  return (0, import_node_path.join)((0, import_node_os.homedir)(), ".claude", "projects");
}
function resolveTranscriptPath(projectPath, sessionId) {
  return (0, import_node_path.join)(
    transcriptRootPath(),
    encodeProjectPath(projectPath),
    `${sessionId}.jsonl`
  );
}
function resolveSessionTranscriptPath(session) {
  return session.transcriptPath ?? resolveTranscriptPath(session.project, session.contentSessionId);
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
function genericWriteBackoffMs(attempt) {
  return Math.min(25, 5 * (attempt + 1));
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
function runWriteTransaction(db, fn, attempts = 3) {
  const txn = db.transaction(fn);
  const maxAttempts = Math.max(1, Math.floor(attempts));
  for (let attempt = 0; ; attempt += 1) {
    try {
      return txn.immediate();
    } catch (err) {
      if (attempt >= maxAttempts - 1 || !isSqliteBusy(err)) {
        throw err;
      }
      syncSleep(genericWriteBackoffMs(attempt));
    }
  }
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

// src/shared/config.ts
var import_node_fs2 = require("node:fs");
var import_node_os2 = require("node:os");
var import_node_path3 = require("node:path");

// src/segment-era.ts
function isSegmentEra(createdAtEpoch, cutoffEpoch) {
  return cutoffEpoch !== null && cutoffEpoch !== void 0 && createdAtEpoch >= cutoffEpoch;
}
function normalizeEraCutoffEpoch(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

// src/shared/config.ts
var KNOWN_DREAM_AGENT_MODELS = [
  "opus",
  "sonnet",
  "haiku",
  "claude-opus-4-8",
  "claude-opus-4-6",
  "claude-opus-4-5",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-haiku-4-5"
];
var DEFAULT_DREAM_AGENT_MODEL = "opus";
var DEFAULT_DREAM_AGENT_TIME_ZONE = "Asia/Shanghai";
var DEFAULT_DREAM_AGENT_TIMEOUT_MS = 30 * 60 * 1e3;
var DEFAULT_DREAM_AGENT_IDLE_WATCHDOG_MS = 10 * 60 * 1e3;
var DEFAULT_DREAM_AGENT_HOUR = 4;
var DEFAULT_HARD_EXIT_TIMEOUT_MS = 7e4;
var DEFAULT_CONFIG = {
  hardExitTimeoutMs: DEFAULT_HARD_EXIT_TIMEOUT_MS,
  // On by default because it is a kill switch, not the cutover switch: with no
  // era cutoff configured this changes nothing at all.
  settlementEnabled: true,
  eraCutoffEpoch: null,
  dreamAgentEnabled: false,
  dreamAgentModel: DEFAULT_DREAM_AGENT_MODEL,
  dreamAgentTimeoutMs: DEFAULT_DREAM_AGENT_TIMEOUT_MS,
  dreamAgentIdleWatchdogMs: DEFAULT_DREAM_AGENT_IDLE_WATCHDOG_MS,
  dreamAgentHour: DEFAULT_DREAM_AGENT_HOUR,
  dreamAgentTimeZone: DEFAULT_DREAM_AGENT_TIME_ZONE,
  dreamAgentBacklogLimit: 1
};
function resolveConfigPath(homePath = (0, import_node_os2.homedir)()) {
  return (0, import_node_path3.join)(homePath, ".claude-mnemo", "config.json");
}
function resolveDreamAgentModel(value, logger) {
  if (typeof value === "string" && KNOWN_DREAM_AGENT_MODELS.includes(value)) {
    return value;
  }
  logger.warn(
    `[claude-mnemo] Invalid dreamAgentModel ${JSON.stringify(value)}; using ${DEFAULT_DREAM_AGENT_MODEL}.`
  );
  return DEFAULT_DREAM_AGENT_MODEL;
}
function resolveDreamAgentTimeZone(value, logger) {
  if (typeof value === "string") {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value }).format(0);
      return value;
    } catch {
    }
  }
  logger.warn(
    `[claude-mnemo] Invalid dreamAgentTimeZone ${JSON.stringify(value)}; using ${DEFAULT_DREAM_AGENT_TIME_ZONE}.`
  );
  return DEFAULT_DREAM_AGENT_TIME_ZONE;
}
function resolveBoolean(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}
function clampInteger(value, min, max, fallback) {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    return fallback;
  }
  return Math.min(Math.max(value, min), max);
}
function clampConfig(config2, rawDreamAgentModel, rawDreamAgentTimeZone, logger) {
  return {
    hardExitTimeoutMs: clampInteger(
      config2.hardExitTimeoutMs,
      1e3,
      3e5,
      DEFAULT_CONFIG.hardExitTimeoutMs
    ),
    settlementEnabled: resolveBoolean(
      config2.settlementEnabled,
      DEFAULT_CONFIG.settlementEnabled
    ),
    // Anything that is not a positive whole epoch reads as "no era yet" rather
    // than as an epoch of 0, which would put every turn on the new path.
    eraCutoffEpoch: normalizeEraCutoffEpoch(config2.eraCutoffEpoch),
    dreamAgentEnabled: resolveBoolean(
      config2.dreamAgentEnabled,
      DEFAULT_CONFIG.dreamAgentEnabled
    ),
    dreamAgentModel: resolveDreamAgentModel(rawDreamAgentModel, logger),
    dreamAgentTimeoutMs: clampInteger(
      config2.dreamAgentTimeoutMs,
      6e4,
      864e5,
      DEFAULT_CONFIG.dreamAgentTimeoutMs
    ),
    dreamAgentIdleWatchdogMs: clampInteger(
      config2.dreamAgentIdleWatchdogMs,
      3e4,
      36e5,
      DEFAULT_CONFIG.dreamAgentIdleWatchdogMs
    ),
    dreamAgentHour: clampInteger(
      config2.dreamAgentHour,
      0,
      23,
      DEFAULT_CONFIG.dreamAgentHour
    ),
    dreamAgentTimeZone: resolveDreamAgentTimeZone(
      rawDreamAgentTimeZone,
      logger
    ),
    dreamAgentBacklogLimit: clampInteger(
      config2.dreamAgentBacklogLimit,
      1,
      366,
      DEFAULT_CONFIG.dreamAgentBacklogLimit
    )
  };
}
function loadConfig(homePath = (0, import_node_os2.homedir)(), logger = { warn: (message) => console.warn(message) }) {
  const path2 = resolveConfigPath(homePath);
  if (!(0, import_node_fs2.existsSync)(path2)) {
    return DEFAULT_CONFIG;
  }
  try {
    const raw = JSON.parse((0, import_node_fs2.readFileSync)(path2, "utf8"));
    const configuredDreamModel = Object.prototype.hasOwnProperty.call(
      raw,
      "dreamAgentModel"
    ) ? raw.dreamAgentModel : DEFAULT_DREAM_AGENT_MODEL;
    const configuredDreamTimeZone = Object.prototype.hasOwnProperty.call(
      raw,
      "dreamAgentTimeZone"
    ) ? raw.dreamAgentTimeZone : DEFAULT_DREAM_AGENT_TIME_ZONE;
    return clampConfig({
      ...DEFAULT_CONFIG,
      ...raw
    }, configuredDreamModel, configuredDreamTimeZone, logger);
  } catch {
    return DEFAULT_CONFIG;
  }
}

// src/db/era.ts
function getRecordedEraCutoff(db) {
  const row = db.query(
    "SELECT cutoff_epoch AS cutoffEpoch FROM era_state WHERE id = 1"
  ).get();
  return row && Number.isFinite(row.cutoffEpoch) ? row.cutoffEpoch : null;
}
function ensureRecordedEraCutoff(db, nowEpoch) {
  const configured = loadConfigEraCutoff();
  if (configured !== null) {
    settledBoundary.set(db, configured);
    return configured;
  }
  db.query(
    `INSERT OR IGNORE INTO era_state (id, cutoff_epoch, recorded_at_epoch)
     VALUES (1, ?, ?)`
  ).run(nowEpoch, nowEpoch);
  const recorded = getRecordedEraCutoff(db);
  if (recorded !== null) {
    settledBoundary.set(db, recorded);
  }
  return recorded;
}
var settledBoundary = /* @__PURE__ */ new WeakMap();
function resolveEraCutoff(db) {
  const settled = settledBoundary.get(db);
  if (settled !== void 0) {
    return settled;
  }
  const resolved = loadConfigEraCutoff() ?? getRecordedEraCutoff(db);
  if (resolved !== null) {
    settledBoundary.set(db, resolved);
  }
  return resolved;
}
function loadConfigEraCutoff() {
  try {
    return loadConfig().eraCutoffEpoch;
  } catch {
    return null;
  }
}

// src/db/citations.ts
var CITATION_RELATIONS = [
  "evidence-for",
  "evidence-against",
  "supersedes",
  "depends-on"
];
function isCitationRelation(value) {
  return typeof value === "string" && CITATION_RELATIONS.includes(value);
}
var INLINE_RANGE_EXPANSION_CAP = 8;
var RANGE_PATTERN = /^T(\d+)\s*-\s*T(\d+)$/;
var LIST_PATTERN = /^T\d+(?:\s*,\s*T\d+)+$/;
var LIST_ELEMENT_PATTERN = /T(\d+)/g;
var SINGLE_PATTERN = /^T(\d+)$/;
var ANNOTATED_PATTERN = /^T(\d+)\s+(?![,\-])\S/;
function parsePositiveId(digits) {
  const id = Number.parseInt(digits, 10);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
function* citationBracketBodies(content) {
  let index = 0;
  while (index < content.length) {
    const open2 = content.indexOf("[", index);
    if (open2 === -1) {
      return;
    }
    const close = content.indexOf("]", open2 + 1);
    if (close === -1) {
      return;
    }
    const body = content.slice(open2 + 1, close);
    index = close + 1;
    if (body.includes("[")) {
      continue;
    }
    yield body;
  }
}
function expandBracketBody(body) {
  if (/[\n\r]/.test(body)) {
    return [];
  }
  const inner = body.trim();
  const range = RANGE_PATTERN.exec(inner);
  if (range) {
    const start = parsePositiveId(range[1]);
    const end = parsePositiveId(range[2]);
    if (start === null || end === null || end < start) {
      return [];
    }
    const span = end - start + 1;
    if (span > INLINE_RANGE_EXPANSION_CAP) {
      return [start, end];
    }
    const ids = [];
    for (let id = start; id <= end; id += 1) {
      ids.push(id);
    }
    return ids;
  }
  if (LIST_PATTERN.test(inner)) {
    const ids = [];
    LIST_ELEMENT_PATTERN.lastIndex = 0;
    let element;
    while ((element = LIST_ELEMENT_PATTERN.exec(inner)) !== null) {
      const id = parsePositiveId(element[1]);
      if (id === null) {
        return [];
      }
      ids.push(id);
    }
    return ids;
  }
  const single = SINGLE_PATTERN.exec(inner);
  if (single) {
    const id = parsePositiveId(single[1]);
    return id === null ? [] : [id];
  }
  const annotated = ANNOTATED_PATTERN.exec(inner);
  if (annotated) {
    const id = parsePositiveId(annotated[1]);
    return id === null ? [] : [id];
  }
  return [];
}
function parseInlineCitations(content, maxRefs) {
  if (!content) {
    return [];
  }
  const cap = maxRefs ?? Number.POSITIVE_INFINITY;
  if (cap <= 0) {
    return [];
  }
  const ids = [];
  const seen = /* @__PURE__ */ new Set();
  for (const body of citationBracketBodies(content)) {
    for (const id of expandBracketBody(body)) {
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      ids.push(id);
      if (ids.length >= cap) {
        return ids;
      }
    }
  }
  return ids;
}
function dedupeCitedIds(edges) {
  const citedTurnIds = [];
  const seen = /* @__PURE__ */ new Set();
  for (const edge of edges) {
    if (seen.has(edge.citedTurnId)) {
      continue;
    }
    seen.add(edge.citedTurnId);
    citedTurnIds.push(edge.citedTurnId);
  }
  return citedTurnIds;
}
function getSessionEffectiveCitations(db, sessionId) {
  const turns = db.query(
    `SELECT id, content, cites_recorded AS citesRecorded
       FROM turns
       WHERE session_id = ?
       ORDER BY prompt_number ASC, id ASC`
  ).all(sessionId);
  const sessionTurnIds = new Set(turns.map((turn) => turn.id));
  const edgesByCiter = /* @__PURE__ */ new Map();
  const edgeRows = db.query(
    `SELECT
         e.citing_id AS citingTurnId,
         e.cited_id AS citedTurnId,
         e.relation,
         e.created_at_epoch AS createdAtEpoch
       FROM memory_edges e
       JOIN turns citing ON citing.id = e.citing_id AND e.citing_kind = 'turn'
       JOIN turns cited ON cited.id = e.cited_id AND e.cited_kind = 'turn'
       WHERE citing.session_id = ? AND cited.session_id = ?
         AND e.relation IS NOT NULL
       ORDER BY e.citing_id ASC, e.cited_id ASC, e.relation ASC`
  ).all(sessionId, sessionId);
  for (const edge of edgeRows) {
    if (edge.citedTurnId === edge.citingTurnId) {
      continue;
    }
    const bucket = edgesByCiter.get(edge.citingTurnId);
    if (bucket) {
      bucket.push(edge);
    } else {
      edgesByCiter.set(edge.citingTurnId, [edge]);
    }
  }
  const effective = /* @__PURE__ */ new Map();
  for (const turn of turns) {
    if (turn.citesRecorded === 1) {
      const edges = edgesByCiter.get(turn.id) ?? [];
      effective.set(turn.id, {
        source: "structured",
        citedTurnIds: dedupeCitedIds(edges),
        edges
      });
      continue;
    }
    effective.set(turn.id, {
      source: "inline",
      citedTurnIds: parseInlineCitations(turn.content).filter(
        (id) => id !== turn.id && sessionTurnIds.has(id)
      ),
      edges: []
    });
  }
  return effective;
}

// src/db/memory-edges.ts
var PROVENANCE_RANK = {
  retrieval: 0,
  rollback: 1,
  "text-ref": 2,
  judged: 3,
  asserted: 4
};
function rankEdgeProvenance(provenance) {
  return PROVENANCE_RANK[provenance];
}

// src/db/search.ts
var OBSERVATION_ORIGINAL_INDEX_CHARS = 500;
function truncateOriginal(value) {
  if (!value) {
    return null;
  }
  return value.length > OBSERVATION_ORIGINAL_INDEX_CHARS ? value.slice(0, OBSERVATION_ORIGINAL_INDEX_CHARS) : value;
}
function normalizeTrigramText(value) {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/gu, " ").trim();
}
function indexFtsRecord(db, layer, sourceId, title, content, extra, prompt, response) {
  db.query("DELETE FROM memory_fts WHERE layer = ? AND source_id = ?").run(
    layer,
    sourceId
  );
  db.query(
    "INSERT INTO memory_fts (layer, source_id, title, content, extra, prompt, response) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(layer, sourceId, title, content, extra, prompt ?? "", response ?? "");
}
function indexRuleToFTS(db, rule) {
  indexFtsRecord(
    db,
    "rule",
    rule.id,
    rule.name,
    normalizeTrigramText(rule.claim),
    "",
    null,
    null
  );
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
function reindexTurnFromDb(db, turnId) {
  const turn = db.query(
    `SELECT
         id,
         title,
         content,
         insight,
         user_prompt AS userPrompt,
         assistant_response AS assistantResponse
       FROM turns
       WHERE id = ?`
  ).get(turnId);
  if (turn) {
    indexTurnToFTS(db, turn);
  }
}
function indexObservationToFTS(db, observation) {
  indexFtsRecord(
    db,
    "observation",
    observation.id,
    observation.title,
    observation.content,
    "",
    truncateOriginal(observation.toolInput),
    truncateOriginal(observation.toolResult)
  );
}
function indexSegmentToFTS(db, segment) {
  const facets = [segment.type, segment.tags].flatMap((value) => {
    if (!value) {
      return [];
    }
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
    } catch {
      return [];
    }
  }).join(" ");
  indexFtsRecord(
    db,
    "segment",
    segment.id,
    segment.title,
    segment.content,
    facets,
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
          substr(tool_input, 1, ${OBSERVATION_ORIGINAL_INDEX_CHARS}) AS toolInput,
          substr(tool_result, 1, ${OBSERVATION_ORIGINAL_INDEX_CHARS}) AS toolResult
        FROM observations
      `
  ).all();
  for (const observation of observationRows) {
    indexObservationToFTS(db, observation);
  }
  const segmentRows = db.query(
    "SELECT id, title, content, type, tags FROM segments ORDER BY id"
  ).all();
  for (const segment of segmentRows) {
    indexSegmentToFTS(db, segment);
  }
  const ruleRows = db.query("SELECT id, name, claim FROM rules ORDER BY id").all();
  for (const rule of ruleRows) {
    indexRuleToFTS(db, rule);
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
var NOTE_DEBT_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS note_debt (
    turn_id INTEGER PRIMARY KEY REFERENCES turns(id) ON DELETE CASCADE,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    prompt_number INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
      status IN ('pending', 'noted', 'skipped')
    ),
    -- Only a skipped debt carries a reason (D4's status vocabulary). 'closed'
    -- is residual settlement's claim-time write (D9): the session is gone, so
    -- the debt is written off rather than left blocking its window forever.
    -- 'declined' is the agent's own answer (\u88C1\u51B3 24) \u2014 nothing worth noting, or
    -- the material has left its context \u2014 and is the only reason it writes.
    reason TEXT CHECK (
      reason IS NULL OR reason IN ('aged', 'rolled-back', 'closed', 'declined')
    ),
    opened_at_epoch INTEGER NOT NULL,
    closed_at_epoch INTEGER,
    updated_at_epoch INTEGER NOT NULL,
    reminded_at_epoch INTEGER
  );
`;
var NOTE_DEBT_INDEX_DDL = `
  CREATE INDEX IF NOT EXISTS idx_note_debt_open
    ON note_debt(session_id, status, prompt_number);
`;
var NOTE_SETTLEMENT_JOBS_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS note_settlement_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    -- Inclusive prompt_number bounds, FROZEN at enqueue. A turn that is decided
    -- after the window was cut joins the next window, never this one, so a retry
    -- settles the same set the first attempt saw.
    window_start INTEGER NOT NULL,
    window_end INTEGER NOT NULL,
    trigger_type TEXT NOT NULL CHECK (
      trigger_type IN ('consecutive', 'compact', 'residual', 'sessionend')
    ),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
      status IN ('pending', 'claimed', 'done', 'failed')
    ),
    attempts INTEGER NOT NULL DEFAULT 0,
    -- Exponential backoff by TIMESTAMP COMPARISON, not by timer: the worker owns
    -- no clock for settlement, so a due retry is noticed in passing by the next
    -- trigger event rather than woken by anything.
    retry_at_epoch INTEGER NOT NULL DEFAULT 0,
    claimed_at_epoch INTEGER,
    -- Ownership fence, bumped on every successful claim (settlement_jobs idiom).
    -- A dispatch whose lease expired CASes on the generation it was claimed
    -- under and so writes nothing over the attempt that displaced it.
    claim_generation INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at_epoch INTEGER NOT NULL,
    updated_at_epoch INTEGER NOT NULL,
    UNIQUE(session_id, window_start, trigger_type)
  );
`;
var NOTE_SETTLEMENT_JOBS_INDEX_DDL = `
  CREATE INDEX IF NOT EXISTS idx_note_settlement_jobs_claim
    ON note_settlement_jobs(session_id, status, window_start);
`;
var SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_session_id TEXT UNIQUE NOT NULL,
    project TEXT NOT NULL,
    transcript_path TEXT,
    title TEXT,
    content TEXT,
    insight TEXT,
    next_steps TEXT,
    decision TEXT,
    done TEXT,
    current TEXT,
    reference TEXT,
    last_compact_turn INTEGER,
    summary_updated_at_epoch INTEGER,
    scan_cursor_byte_offset INTEGER NOT NULL DEFAULT 0,
    scan_cursor_line INTEGER NOT NULL DEFAULT 0,
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
    assistant_transcript TEXT,
    title TEXT,
    content TEXT,
    insight TEXT,
    type TEXT,
    significance_grade INTEGER CHECK (
      significance_grade IS NULL OR significance_grade BETWEEN 0 AND 4
    ),
    tags TEXT,
    files_read TEXT,
    files_modified TEXT,
    tool_call_count INTEGER,
    transcript_line_start INTEGER,
    cites_recorded INTEGER NOT NULL DEFAULT 0,
    -- Which stored records this turn's recall/replay calls actually hit (D4).
    -- JSON array of {ref, strength}, where ref is a type-prefixed global id
    -- (turn:8942, session:15069, obs:77, segment:4) so the namespace stays
    -- unambiguous when a later pass turns these into retrieval edges.
    consulted_memories TEXT,
    compact_boundary_uuid TEXT,
    created_at_epoch INTEGER NOT NULL,
    updated_at_epoch INTEGER,
    UNIQUE(session_id, prompt_number)
  );

  -- Process \u2192 mnemo-session identity map (spec D1, note guardrails ticket).
  -- The key is an environment-derived identity key, namespaced by the variable
  -- it came from (see deriveProcessIdentityKeys) \u2014 never the id mnemo keys
  -- sessions on (sessions.content_session_id, the hook payload's session_id),
  -- which no MCP process ever sees. UserPromptSubmit upserts one row per key it
  -- can derive, every turn, so the MCP entry point can turn "which process am
  -- I" into "which mnemo session is this". Several keys therefore name the same
  -- mnemo session \u2014 that redundancy is the point, since the reading process
  -- holds an environment snapshot taken at ITS spawn and shares only some of
  -- them. Superseded rows are left in place rather than cleaned up; a stale row
  -- is overwritten by the next session to claim that key, before any of that
  -- session's tool calls can read it.
  CREATE TABLE IF NOT EXISTS process_session_map (
    process_session_id TEXT PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    updated_at_epoch INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settlement_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    boundary INTEGER NOT NULL,
    frozen_member_ids TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
      status IN ('pending', 'claimed', 'done', 'failed')
    ),
    attempts INTEGER NOT NULL DEFAULT 0,
    claimed_at_epoch INTEGER,
    -- Ownership fence. Bumped on EVERY successful claim, including a lease
    -- reclaim, so a worker whose lease expired can be told apart from the one
    -- that holds the row now: completion and failure both CAS on the generation
    -- they were claimed under, and a stale owner's write matches nothing.
    claim_generation INTEGER NOT NULL DEFAULT 0,
    change_summary TEXT,
    last_error TEXT,
    created_at_epoch INTEGER NOT NULL,
    updated_at_epoch INTEGER NOT NULL,
    UNIQUE(session_id, boundary)
  );

  CREATE INDEX IF NOT EXISTS idx_settlement_jobs_session_status
    ON settlement_jobs(session_id, status, boundary);

  CREATE TABLE IF NOT EXISTS settlement_cursors (
    session_id INTEGER PRIMARY KEY
      REFERENCES sessions(id) ON DELETE CASCADE,
    last_settled_boundary INTEGER NOT NULL DEFAULT 0,
    updated_at_epoch INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS session_run_state (
    session_db_id INTEGER PRIMARY KEY
      REFERENCES sessions(id) ON DELETE CASCADE,
    start_turn_id INTEGER NOT NULL
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
    -- Captured for the raw axis, withheld from the extraction pipeline: the
    -- row is never enqueued and never counted as work. See shared/note-tool.ts
    -- for why a note call must not become material for the old pipeline.
    excluded_from_extraction INTEGER NOT NULL DEFAULT 0,
    created_at_epoch INTEGER NOT NULL
  );

  -- P1 shadow store (spec D12). The main agent's own notes live entirely
  -- outside the turns table: nothing in the legacy extraction pipeline reads
  -- this table, and its text is deliberately NOT indexed into memory_fts. The
  -- trial compares agent-written notes against pipeline-written summaries
  -- offline, so a leak either way would invalidate the comparison it exists for.
  --
  -- turn_id is the PRIMARY KEY, which carries both invariants at once: one
  -- note per turn, and overwrite (not accumulate) on a repeat write \u2014 a note is
  -- rewritten whole, the way a session summary is.
  CREATE TABLE IF NOT EXISTS shadow_notes (
    turn_id INTEGER PRIMARY KEY REFERENCES turns(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    insight TEXT,
    -- Mechanical provenance (D4), never caller-supplied. writer_model is NULL
    -- when the environment does not expose a model identity; ride_turn_id is
    -- the turn the session was on when the note was written, which is what makes
    -- "how long did this note wait" a fact rather than a reconstruction.
    writer_model TEXT,
    ride_turn_id INTEGER REFERENCES turns(id) ON DELETE SET NULL,
    -- Who authored this note. 'agent' is the main agent writing its own turn
    -- (the only P1 writer); 'settlement' is the P2 settlement pass reconstructing
    -- an INTERIOR HOLE \u2014 a turn whose debt was written off at residual-claim time
    -- but which later turns in the same window still depend on (spec D9, \u88C1\u51B3 20).
    -- The column exists so the P1 measurements never mistake a hindsight
    -- reconstruction for the agent's own compliance: every metric that counts
    -- notes filters on 'agent'.
    writer_origin TEXT NOT NULL DEFAULT 'agent' CHECK (
      writer_origin IN ('agent', 'settlement')
    ),
    created_at_epoch INTEGER NOT NULL,
    updated_at_epoch INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_shadow_notes_ride_turn
    ON shadow_notes(ride_turn_id);

  -- P1 note-debt ledger (spec D2/D3), shadow side like shadow_notes: it records
  -- which turns still owe a note and how each debt ended, and it never touches a
  -- turns row or its status \u2014 the legacy pipeline keeps sole ownership of those.
  --
  -- turn_id is the PRIMARY KEY: one debt per turn, and re-running the completion
  -- classification is an INSERT that loses the race rather than a second debt.
  -- A trivial turn (no substantive tool call) gets NO row at all \u2014 "not in the
  -- ledger" is the representation of "owes nothing", so the ledger's size tracks
  -- real debt rather than session length.
  ${NOTE_DEBT_TABLE_DDL}
  ${NOTE_DEBT_INDEX_DDL}

  -- How far the completion classification has already walked, per session. It is
  -- what keeps the sweep O(new turns) instead of O(session): without it, every
  -- trivial turn \u2014 which by design leaves no ledger row \u2014 would be re-examined
  -- on every tool call for the life of the session.
  --
  -- last_relief_prompt_number is the re-arm state of the backlog-relief
  -- injection (\u88C1\u51B3 21): the turn the last relief rode, 0 when it has never
  -- fired. It lives here rather than in its own table because it is the same
  -- kind of fact as the classification cursor \u2014 one per-session watermark the
  -- ledger reads to decide what to do next \u2014 and because eligibility compares
  -- the two in one row read.
  CREATE TABLE IF NOT EXISTS note_debt_cursor (
    session_id INTEGER PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    last_classified_prompt_number INTEGER NOT NULL DEFAULT 0,
    last_relief_prompt_number INTEGER NOT NULL DEFAULT 0,
    updated_at_epoch INTEGER NOT NULL
  );

  -- Exposure ledger (spec D7): every turn id this session has actually shown the
  -- main agent, and the turn it was shown during. P2's citation check reads it \u2014
  -- a note may cite only ids its writer was shown \u2014 so a row must mean "rendered
  -- into the model's context", never "was in the ledger at the time".
  --
  -- Keyed by (ride_turn_id, exposed_turn_id): re-showing an id in a later turn
  -- adds a row, which is also the "a reminder already fired this turn" fact the
  -- at-most-once-per-turn rule reads.
  CREATE TABLE IF NOT EXISTS note_id_exposures (
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    ride_turn_id INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
    exposed_turn_id INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
    source TEXT NOT NULL CHECK (source IN ('reminder', 'injection')),
    created_at_epoch INTEGER NOT NULL,
    PRIMARY KEY (session_id, ride_turn_id, exposed_turn_id, source)
  );

  CREATE INDEX IF NOT EXISTS idx_note_id_exposures_exposed
    ON note_id_exposures(session_id, exposed_turn_id);

  -- P2 note settlement jobs (spec D9, ticket 05). Deliberately a SEPARATE table
  -- from settlement_jobs: that one is the 0.8.4 two-phase GRADING settlement,
  -- keyed by an extracted-turn boundary ordinal and still live on the legacy
  -- path, while this one is keyed by a prompt-number window and is what D13
  -- retires the grading settlement in favour of. Sharing a table would couple a
  -- machine being retired to the machine retiring it.
  --
  -- Identity is (session, window_start, trigger_type): the enqueue is idempotent
  -- under replay, and the two triggers can each own a window that starts at the
  -- same place without one silently swallowing the other.
  ${NOTE_SETTLEMENT_JOBS_TABLE_DDL}
  ${NOTE_SETTLEMENT_JOBS_INDEX_DDL}

  CREATE TABLE IF NOT EXISTS note_settlement_cursors (
    session_id INTEGER PRIMARY KEY
      REFERENCES sessions(id) ON DELETE CASCADE,
    -- Highest prompt_number such that every window at or below it is RESOLVED.
    -- A terminally failed window resolves too (terminal-state-must-abandon-and-
    -- continue): holding the cursor at it would wedge the session forever.
    last_settled_prompt_number INTEGER NOT NULL DEFAULT 0,
    updated_at_epoch INTEGER NOT NULL
  );

  -- Topic registry (spec D6): the one place a theme's name and its alternate
  -- spellings live, so "continuous work on the same theme reuses the same word"
  -- is enforceable rather than aspirational. The aliases column is a JSON array of
  -- the other names the same theme has been written as; the settlement pass folds
  -- new spellings in here instead of minting a near-duplicate topic.
  CREATE TABLE IF NOT EXISTS topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    aliases TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(aliases)),
    status TEXT NOT NULL DEFAULT 'active' CHECK (
      status IN ('active', 'dormant', 'retired')
    ),
    created_at_epoch INTEGER NOT NULL,
    updated_at_epoch INTEGER NOT NULL
  );

  -- Segments (spec D6): one coherent chapter of work on one topic. Same field
  -- shape as a turn \u2014 title / content / type / tag / status \u2014 because the
  -- reading surfaces (recall's type:/tag: filters, FTS, the glyph) are meant to
  -- work across granularities without a second vocabulary.
  --
  -- Deliberately NOT bound to a session: a topic outruns any one session, and a
  -- segment that had to name one would have to pick arbitrarily among its
  -- members' sessions. Membership (segment_members) carries that relation.
  --
  -- type and tags are JSON arrays (multi-value; a segment's type is the
  -- union of its members'). revision is the write fence: an open segment is a
  -- living document that concurrent settlements may both want to rewrite, so
  -- every write CASes on the revision it read (see db/segments.ts).
  CREATE TABLE IF NOT EXISTS segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_id INTEGER REFERENCES topics(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    content TEXT,
    type TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(type)),
    tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),
    -- open = still accepting members and rewrites; delivered = closed by a
    -- shipped/merged/settled outcome; abandoned = went silent. Only open
    -- segments are writable \u2014 a closed one is frozen and gets overturned by an
    -- edge, never by a rewrite (spec D6: freeze history, not the present).
    status TEXT NOT NULL DEFAULT 'open' CHECK (
      status IN ('open', 'delivered', 'abandoned')
    ),
    revision INTEGER NOT NULL DEFAULT 1,
    created_at_epoch INTEGER NOT NULL,
    updated_at_epoch INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_segments_topic_status
    ON segments(topic_id, status, updated_at_epoch);

  CREATE INDEX IF NOT EXISTS idx_segments_status_updated
    ON segments(status, updated_at_epoch);

  -- Segment membership (spec D6). Many-to-many on purpose: member turns need
  -- not be contiguous, and one turn can legitimately belong to two segments
  -- (a fix that also closes a review). The pair is the primary key, so
  -- re-asserting a membership is idempotent.
  CREATE TABLE IF NOT EXISTS segment_members (
    segment_id INTEGER NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
    turn_id INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
    created_at_epoch INTEGER NOT NULL,
    PRIMARY KEY (segment_id, turn_id)
  );

  CREATE INDEX IF NOT EXISTS idx_segment_members_turn
    ON segment_members(turn_id);

  CREATE INDEX IF NOT EXISTS idx_turns_session_prompt
    ON turns(session_id, prompt_number);

  -- Ordered (status, created_at_epoch) rather than status alone: the stranded
  -- repair's derivation scan (worker/turn-liveness.ts listStrandedRepairDates)
  -- has no date bound at all \u2014 it reads the whole history looking for turns
  -- still in a live status \u2014 so without this it degrades to a table scan that
  -- grows with the corpus. Live turns are a small minority of the table, so
  -- seeking the two live statuses and reading created_at_epoch straight off the
  -- index turns that scan into a bounded one. A plain (status) index is a strict
  -- prefix of this one and would only add write cost.
  CREATE INDEX IF NOT EXISTS idx_turns_status_created
    ON turns(status, created_at_epoch);

  CREATE INDEX IF NOT EXISTS idx_turns_created_at
    ON turns(created_at_epoch);

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

  CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_queue_diary_target
    ON pending_queue(kind, target_id) WHERE kind = 'diary';

  -- "does this turn already have a turn-stop queued" is asked once per candidate
  -- by the stranded scan and once per Stop by the hook, and without an index each
  -- ask scans the whole queue.
  CREATE INDEX IF NOT EXISTS idx_pending_queue_kind_target
    ON pending_queue(kind, target_id);

  CREATE TABLE IF NOT EXISTS diary_day_state (
    date TEXT PRIMARY KEY,
    watermark TEXT,
    settled_at_epoch INTEGER,
    needs_regen INTEGER NOT NULL DEFAULT 0,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_epoch INTEGER,
    terminal INTEGER NOT NULL DEFAULT 0,
    retry_disposition TEXT CHECK (
      retry_disposition IS NULL OR
      retry_disposition IN ('transient', 'permanent')
    ),
    last_error TEXT
  );

  -- Ledger for one-time, resumable data repairs. Keyed by a VERSIONED name so a
  -- future revision of the same repair is a new row rather than a re-run of the
  -- old one. The cursor is a session-id high-water mark: every examined row
  -- crosses it, including the ones the repair could not fix, so nothing is
  -- permanently re-selected and no row is counted twice.
  --
  -- The row doubles as the repair's lock. claim_generation / claimed_at_epoch
  -- are the same lease-and-fence idiom settlement_jobs uses: claiming bumps the
  -- generation, every later write CASes on it, so a displaced runner writes
  -- nothing instead of double-counting. deferred_until_epoch /
  -- deferral_attempts hold the backoff for a repair that cannot run yet (an
  -- unreadable transcript root) WITHOUT marking it done \u2014 the one-shot repair
  -- stays available for whenever the environment recovers.
  CREATE TABLE IF NOT EXISTS repair_ledger (
    name TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('running', 'done')),
    cursor_id INTEGER NOT NULL DEFAULT 0,
    filled_count INTEGER NOT NULL DEFAULT 0,
    unresolved_count INTEGER NOT NULL DEFAULT 0,
    ambiguous_count INTEGER NOT NULL DEFAULT 0,
    claim_generation INTEGER NOT NULL DEFAULT 0,
    claimed_at_epoch INTEGER,
    deferred_until_epoch INTEGER,
    deferral_attempts INTEGER NOT NULL DEFAULT 0,
    started_at_epoch INTEGER NOT NULL,
    completed_at_epoch INTEGER
  );

  CREATE TABLE IF NOT EXISTS diary_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- When the P2 era began (db/era.ts). One row, written once, by whichever
  -- production process looks first: the boundary has to survive restarts and
  -- clock changes because turns are already written against it.
  CREATE TABLE IF NOT EXISTS era_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    cutoff_epoch INTEGER NOT NULL,
    recorded_at_epoch INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    claim TEXT NOT NULL CHECK (length(claim) <= 300),
    rationale TEXT NOT NULL,
    scope TEXT NOT NULL,
    trigger_kind TEXT NOT NULL CHECK (
      trigger_kind IN ('prompt', 'tool', 'result', 'none')
    ),
    trigger_spec TEXT CHECK (
      (trigger_kind = 'none' AND trigger_spec IS NULL) OR
      (trigger_kind != 'none' AND trigger_spec IS NOT NULL AND json_valid(trigger_spec))
    ),
    status TEXT NOT NULL CHECK (
      status IN ('provisional', 'confirmed', 'refuted', 'retired', 'digest_only')
    ),
    evidence TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence)),
    created_at_epoch INTEGER NOT NULL,
    updated_at_epoch INTEGER NOT NULL,
    last_evidence_at_epoch INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rule_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_uid TEXT UNIQUE NOT NULL,
    rule_id INTEGER NOT NULL REFERENCES rules(id),
    event_kind TEXT NOT NULL,
    source_event_id INTEGER REFERENCES rule_events(id),
    turn_ref TEXT,
    label TEXT,
    rationale TEXT,
    adjustment_json TEXT CHECK (
      adjustment_json IS NULL OR json_valid(adjustment_json)
    ),
    status_before TEXT CHECK (
      status_before IS NULL OR
      status_before IN ('provisional', 'confirmed', 'refuted', 'retired', 'digest_only')
    ),
    status_after TEXT CHECK (
      status_after IS NULL OR
      status_after IN ('provisional', 'confirmed', 'refuted', 'retired', 'digest_only')
    ),
    created_at_epoch INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_rules_scope_status
    ON rules(scope, status);

  CREATE INDEX IF NOT EXISTS idx_rule_events_rule_created
    ON rule_events(rule_id, created_at_epoch, id);

  CREATE UNIQUE INDEX IF NOT EXISTS idx_rule_events_one_judgment_per_hit
    ON rule_events(source_event_id) WHERE event_kind = 'judgment';

  CREATE TRIGGER IF NOT EXISTS rules_no_hard_delete
    BEFORE DELETE ON rules
    BEGIN
      SELECT RAISE(ABORT, 'rules are append-only; retire or refute instead');
    END;

  CREATE TRIGGER IF NOT EXISTS rules_validate_trigger_spec_insert
    BEFORE INSERT ON rules
    WHEN NEW.trigger_kind != 'none' AND (
      length(CAST(NEW.trigger_spec AS BLOB)) > 1024 OR
      json_type(NEW.trigger_spec, '$.kind') IS NOT 'text' OR
      json_extract(NEW.trigger_spec, '$.kind') IS NOT NEW.trigger_kind OR
      (NEW.trigger_kind = 'prompt' AND (
        json_type(NEW.trigger_spec, '$.keywords') IS NOT 'array' OR
        json_array_length(NEW.trigger_spec, '$.keywords') NOT BETWEEN 1 AND 8 OR
        EXISTS (
          SELECT 1 FROM json_each(NEW.trigger_spec, '$.keywords')
          WHERE type != 'text' OR length(value) < 3
        ) OR
        (json_type(NEW.trigger_spec, '$.match') IS NOT NULL AND (
         json_type(NEW.trigger_spec, '$.match') IS NOT 'text' OR
         json_extract(NEW.trigger_spec, '$.match') NOT IN ('any', 'all')
        )) OR
        EXISTS (
          SELECT 1 FROM json_each(NEW.trigger_spec)
          WHERE key NOT IN ('kind', 'keywords', 'match')
        )
      )) OR
      (NEW.trigger_kind = 'tool' AND (
        json_type(NEW.trigger_spec, '$.tool') IS NOT 'text' OR
        length(json_extract(NEW.trigger_spec, '$.tool')) = 0 OR
        (json_type(NEW.trigger_spec, '$.require_param') IS NOT NULL AND
         (json_type(NEW.trigger_spec, '$.require_param') != 'text' OR
          length(json_extract(NEW.trigger_spec, '$.require_param')) = 0)) OR
        (json_type(NEW.trigger_spec, '$.param_absent') IS NOT NULL AND
         (json_type(NEW.trigger_spec, '$.param_absent') != 'text' OR
          length(json_extract(NEW.trigger_spec, '$.param_absent')) = 0)) OR
        (json_type(NEW.trigger_spec, '$.path_glob') IS NOT NULL AND
         (json_type(NEW.trigger_spec, '$.path_glob') != 'text' OR
          length(json_extract(NEW.trigger_spec, '$.path_glob')) = 0)) OR
        (json_type(NEW.trigger_spec, '$.command_prefix') IS NOT NULL AND (
          json_type(NEW.trigger_spec, '$.command_prefix') != 'array' OR
          json_array_length(NEW.trigger_spec, '$.command_prefix') NOT BETWEEN 1 AND 4 OR
          EXISTS (
            SELECT 1 FROM json_each(NEW.trigger_spec, '$.command_prefix')
            WHERE type != 'text' OR length(value) = 0
          )
        )) OR
        EXISTS (
          SELECT 1 FROM json_each(NEW.trigger_spec)
          WHERE key NOT IN (
            'kind', 'tool', 'require_param', 'param_absent',
            'command_prefix', 'path_glob'
          )
        )
      )) OR
      (NEW.trigger_kind = 'result' AND (
        (json_type(NEW.trigger_spec, '$.tool') IS NOT NULL AND
         (json_type(NEW.trigger_spec, '$.tool') != 'text' OR
          length(json_extract(NEW.trigger_spec, '$.tool')) = 0)) OR
        json_type(NEW.trigger_spec, '$.patterns') IS NOT 'array' OR
        json_array_length(NEW.trigger_spec, '$.patterns') NOT BETWEEN 1 AND 4 OR
        EXISTS (
          SELECT 1 FROM json_each(NEW.trigger_spec, '$.patterns')
          WHERE type != 'text' OR length(value) NOT BETWEEN 1 AND 64
        ) OR
        EXISTS (
          SELECT 1 FROM json_each(NEW.trigger_spec)
          WHERE key NOT IN ('kind', 'tool', 'patterns')
        )
      ))
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid trigger_spec');
    END;

  CREATE TRIGGER IF NOT EXISTS rules_validate_trigger_spec_update
    BEFORE UPDATE OF trigger_kind, trigger_spec ON rules
    WHEN NEW.trigger_kind != 'none' AND (
      length(CAST(NEW.trigger_spec AS BLOB)) > 1024 OR
      json_type(NEW.trigger_spec, '$.kind') IS NOT 'text' OR
      json_extract(NEW.trigger_spec, '$.kind') IS NOT NEW.trigger_kind OR
      (NEW.trigger_kind = 'prompt' AND (
        json_type(NEW.trigger_spec, '$.keywords') IS NOT 'array' OR
        json_array_length(NEW.trigger_spec, '$.keywords') NOT BETWEEN 1 AND 8 OR
        EXISTS (SELECT 1 FROM json_each(NEW.trigger_spec, '$.keywords') WHERE type != 'text' OR length(value) < 3) OR
        (json_type(NEW.trigger_spec, '$.match') IS NOT NULL AND (json_type(NEW.trigger_spec, '$.match') IS NOT 'text' OR json_extract(NEW.trigger_spec, '$.match') NOT IN ('any', 'all'))) OR
        EXISTS (SELECT 1 FROM json_each(NEW.trigger_spec) WHERE key NOT IN ('kind', 'keywords', 'match'))
      )) OR
      (NEW.trigger_kind = 'tool' AND (
        json_type(NEW.trigger_spec, '$.tool') IS NOT 'text' OR length(json_extract(NEW.trigger_spec, '$.tool')) = 0 OR
        (json_type(NEW.trigger_spec, '$.require_param') IS NOT NULL AND (json_type(NEW.trigger_spec, '$.require_param') != 'text' OR length(json_extract(NEW.trigger_spec, '$.require_param')) = 0)) OR
        (json_type(NEW.trigger_spec, '$.param_absent') IS NOT NULL AND (json_type(NEW.trigger_spec, '$.param_absent') != 'text' OR length(json_extract(NEW.trigger_spec, '$.param_absent')) = 0)) OR
        (json_type(NEW.trigger_spec, '$.path_glob') IS NOT NULL AND (json_type(NEW.trigger_spec, '$.path_glob') != 'text' OR length(json_extract(NEW.trigger_spec, '$.path_glob')) = 0)) OR
        (json_type(NEW.trigger_spec, '$.command_prefix') IS NOT NULL AND (json_type(NEW.trigger_spec, '$.command_prefix') != 'array' OR json_array_length(NEW.trigger_spec, '$.command_prefix') NOT BETWEEN 1 AND 4 OR EXISTS (SELECT 1 FROM json_each(NEW.trigger_spec, '$.command_prefix') WHERE type != 'text' OR length(value) = 0))) OR
        EXISTS (SELECT 1 FROM json_each(NEW.trigger_spec) WHERE key NOT IN ('kind', 'tool', 'require_param', 'param_absent', 'command_prefix', 'path_glob'))
      )) OR
      (NEW.trigger_kind = 'result' AND (
        (json_type(NEW.trigger_spec, '$.tool') IS NOT NULL AND (json_type(NEW.trigger_spec, '$.tool') != 'text' OR length(json_extract(NEW.trigger_spec, '$.tool')) = 0)) OR
        json_type(NEW.trigger_spec, '$.patterns') IS NOT 'array' OR
        json_array_length(NEW.trigger_spec, '$.patterns') NOT BETWEEN 1 AND 4 OR
        EXISTS (SELECT 1 FROM json_each(NEW.trigger_spec, '$.patterns') WHERE type != 'text' OR length(value) NOT BETWEEN 1 AND 64) OR
        EXISTS (SELECT 1 FROM json_each(NEW.trigger_spec) WHERE key NOT IN ('kind', 'tool', 'patterns'))
      ))
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid trigger_spec');
    END;

  CREATE TRIGGER IF NOT EXISTS rule_events_validate_source
    BEFORE INSERT ON rule_events
    WHEN
      (NEW.event_kind = 'judgment' AND (
        NEW.source_event_id IS NULL OR NOT EXISTS (
          SELECT 1 FROM rule_events source
          WHERE source.id = NEW.source_event_id
            AND source.rule_id = NEW.rule_id
            AND source.event_kind = 'hit'
        )
      )) OR
      (NEW.event_kind != 'judgment' AND NEW.source_event_id IS NOT NULL)
    BEGIN
      SELECT RAISE(ABORT, 'source_event_id must link a judgment to a hit for the same rule');
    END;

  CREATE TRIGGER IF NOT EXISTS rule_events_no_update
    BEFORE UPDATE ON rule_events
    BEGIN
      SELECT RAISE(ABORT, 'rule_events is append-only');
    END;

  CREATE TRIGGER IF NOT EXISTS rule_events_no_delete
    BEFORE DELETE ON rule_events
    BEGIN
      SELECT RAISE(ABORT, 'rule_events is append-only');
    END;

  ${MEMORY_FTS_DDL}
`;
var MEMORY_EDGES_DDL = `
  CREATE TABLE IF NOT EXISTS memory_edges (
    citing_kind TEXT NOT NULL CHECK (citing_kind IN ('turn', 'segment', 'session')),
    citing_id INTEGER NOT NULL,
    cited_kind TEXT NOT NULL CHECK (cited_kind IN ('turn', 'segment')),
    cited_id INTEGER NOT NULL,
    relation TEXT CHECK (
      relation IS NULL OR
      relation IN ('evidence-for', 'evidence-against', 'supersedes', 'depends-on')
    ),
    provenance TEXT NOT NULL CHECK (
      provenance IN ('retrieval', 'text-ref', 'rollback', 'judged', 'asserted')
    ),
    created_at_epoch INTEGER NOT NULL,
    PRIMARY KEY (citing_kind, citing_id, cited_kind, cited_id)
  );

  CREATE INDEX IF NOT EXISTS idx_memory_edges_cited
    ON memory_edges(cited_kind, cited_id, relation);
`;
function hasTable(db, table) {
  return db.query(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(table) !== null;
}
function remapLegacyRelation(relation) {
  if (relation === "implements") {
    return "depends-on";
  }
  if (relation === "builds-on") {
    return null;
  }
  return isCitationRelation(relation) ? relation : null;
}
function pickWinningLegacyRelation(candidates) {
  const remapped = candidates.map((candidate) => ({
    relation: remapLegacyRelation(candidate.relation),
    provenance: candidate.provenance,
    createdAtEpoch: candidate.createdAtEpoch
  }));
  const winner = [...remapped].sort((left, right) => {
    const leftHasRelation = left.relation !== null ? 1 : 0;
    const rightHasRelation = right.relation !== null ? 1 : 0;
    if (leftHasRelation !== rightHasRelation) {
      return rightHasRelation - leftHasRelation;
    }
    const rankDiff = rankEdgeProvenance(right.provenance) - rankEdgeProvenance(left.provenance);
    if (rankDiff !== 0) {
      return rankDiff;
    }
    if (left.relation !== right.relation) {
      return (left.relation ?? "").localeCompare(right.relation ?? "");
    }
    return left.createdAtEpoch - right.createdAtEpoch;
  })[0];
  return {
    relation: winner.relation,
    // The winning candidate's OWN provenance travels with its relation — the
    // same discipline a live upsert keeps (relation and provenance never come
    // from two different rows). Only the timestamp is pooled across the whole
    // group, preserving "when did this edge first appear" through the collapse.
    provenance: winner.provenance,
    createdAtEpoch: Math.min(...remapped.map((candidate) => candidate.createdAtEpoch))
  };
}
function memoryEdgesSchemaIsStale(db) {
  const storedDdl = db.query(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_edges'"
  ).get()?.sql ?? null;
  return storedDdl !== null && !storedDdl.includes("'depends-on'");
}
function collapseAndRebuildMemoryEdges(db) {
  db.exec("ALTER TABLE memory_edges RENAME TO memory_edges_pre_pair_identity");
  db.exec(MEMORY_EDGES_DDL);
  const legacyRows = db.query(
    `SELECT
         citing_kind AS citingKind, citing_id AS citingId,
         cited_kind AS citedKind, cited_id AS citedId,
         relation, provenance, created_at_epoch AS createdAtEpoch
       FROM memory_edges_pre_pair_identity`
  ).all();
  const groups = /* @__PURE__ */ new Map();
  for (const row of legacyRows) {
    const key = `${row.citingKind} ${row.citingId} ${row.citedKind} ${row.citedId}`;
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(row);
    } else {
      groups.set(key, [row]);
    }
  }
  const insert = db.query(
    `INSERT INTO memory_edges (
       citing_kind, citing_id, cited_kind, cited_id,
       relation, provenance, created_at_epoch
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const bucket of groups.values()) {
    const sample = bucket[0];
    const winner = pickWinningLegacyRelation(bucket);
    insert.run(
      sample.citingKind,
      sample.citingId,
      sample.citedKind,
      sample.citedId,
      winner.relation,
      winner.provenance,
      winner.createdAtEpoch
    );
  }
  db.exec("DROP TABLE memory_edges_pre_pair_identity");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memory_edges_cited
      ON memory_edges(cited_kind, cited_id, relation);
  `);
}
function ensureMemoryEdgesPairIdentity(db) {
  if (!memoryEdgesSchemaIsStale(db)) {
    return;
  }
  runWriteTransaction(db, () => {
    if (!memoryEdgesSchemaIsStale(db)) {
      return;
    }
    collapseAndRebuildMemoryEdges(db);
  });
}
function ensureMemoryEdgesSchema(db) {
  const isFirstCreation = !hasTable(db, "memory_edges");
  if (!isFirstCreation) {
    ensureMemoryEdgesPairIdentity(db);
  }
  db.exec(MEMORY_EDGES_DDL);
  if (isFirstCreation) {
    migrateTurnCitationsToEdges(db);
  }
}
function migrateTurnCitationsToEdges(db) {
  if (!hasTable(db, "turn_citations") || !hasTable(db, "memory_edges")) {
    return 0;
  }
  const rows = db.query(
    `SELECT citing_turn_id AS citingTurnId, cited_turn_id AS citedTurnId,
              relation, created_at_epoch AS createdAtEpoch
       FROM turn_citations`
  ).all();
  if (rows.length === 0) {
    return 0;
  }
  const groups = /* @__PURE__ */ new Map();
  for (const row of rows) {
    const key = `${row.citingTurnId}:${row.citedTurnId}`;
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(row);
    } else {
      groups.set(key, [row]);
    }
  }
  const insert = db.query(
    `INSERT INTO memory_edges (
       citing_kind, citing_id, cited_kind, cited_id,
       relation, provenance, created_at_epoch
     ) VALUES ('turn', ?, 'turn', ?, ?, ?, ?)
     ON CONFLICT (citing_kind, citing_id, cited_kind, cited_id) DO NOTHING
     RETURNING 1 AS inserted`
  );
  let migrated = 0;
  for (const bucket of groups.values()) {
    const sample = bucket[0];
    const winner = pickWinningLegacyRelation(
      bucket.map((row) => ({
        relation: row.relation,
        provenance: "judged",
        createdAtEpoch: row.createdAtEpoch
      }))
    );
    if (insert.get(
      sample.citingTurnId,
      sample.citedTurnId,
      winner.relation,
      winner.provenance,
      winner.createdAtEpoch
    )) {
      migrated += 1;
    }
  }
  return migrated;
}
function retireLegacyTurnCitationsTable(db) {
  if (!hasTable(db, "turn_citations")) {
    return;
  }
  migrateTurnCitationsToEdges(db);
  db.exec("DROP TABLE turn_citations");
}
function initializeSchema(db) {
  db.exec(SCHEMA_SQL);
  ensureDiaryDayStateTerminalColumn(db);
  ensureDiaryDayStateRetryDispositionColumn(db);
  ensureSessionTranscriptPathColumn(db);
  ensureSessionSummaryUpdatedAtEpochColumn(db);
  ensureSessionSummaryFieldColumns(db);
  ensureTurnTranscriptLineStartColumn(db);
  ensureTurnAssistantTranscriptColumn(db);
  ensureTurnInvalidationColumns(db);
  ensureTurnSignificanceGradeColumn(db);
  ensureTurnCitationsSchema(db);
  ensureTurnConsultedMemoriesColumn(db);
  ensureMemoryEdgesSchema(db);
  retireLegacyTurnCitationsTable(db);
  ensureSessionScanCursorColumns(db);
  ensureTurnCompactBoundarySchema(db);
  dropRetiredMaintenanceState(db);
  ensureForkLineageColumns(db);
  ensureSearchIndexSchema(db);
  ensureSessionProjectIndex(db);
  ensureTurnPromptIdIndex(db);
  ensureSettlementClaimGenerationColumn(db);
  ensureRepairLedgerClaimColumns(db);
  ensureObservationExtractionExclusionColumn(db);
  ensureShadowNoteWriterOriginColumn(db);
  ensureNoteDebtReasonVocabulary(db);
  ensureNoteDebtRemindedColumn(db);
  ensureNoteDebtCursorReliefColumn(db);
  retireLegacyPendingNoteDebts(db);
  ensureNoteSettlementSessionEndTrigger(db);
  dropLegacyMemoriesTable(db);
}
function noteDebtReasonVocabularyIsStale(db) {
  const storedDdl = db.query(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'note_debt'"
  ).get()?.sql ?? null;
  return storedDdl !== null && !storedDdl.includes("'declined'");
}
function ensureNoteDebtReasonVocabulary(db) {
  if (!noteDebtReasonVocabularyIsStale(db)) {
    return;
  }
  runWriteTransaction(db, () => {
    if (!noteDebtReasonVocabularyIsStale(db)) {
      return;
    }
    db.exec("ALTER TABLE note_debt RENAME TO note_debt_pre_closed_reason");
    db.exec(NOTE_DEBT_TABLE_DDL);
    const carried = hasColumn(
      db,
      "note_debt_pre_closed_reason",
      "reminded_at_epoch"
    ) ? ", reminded_at_epoch" : "";
    db.exec(
      `INSERT INTO note_debt (
         turn_id, session_id, prompt_number, status, reason,
         opened_at_epoch, closed_at_epoch, updated_at_epoch${carried}
       )
       SELECT turn_id, session_id, prompt_number, status, reason,
              opened_at_epoch, closed_at_epoch, updated_at_epoch${carried}
       FROM note_debt_pre_closed_reason`
    );
    db.exec("DROP TABLE note_debt_pre_closed_reason");
    db.exec(NOTE_DEBT_INDEX_DDL);
  });
}
function ensureNoteDebtRemindedColumn(db) {
  addColumnIfMissing(db, "note_debt", "reminded_at_epoch", "INTEGER");
}
function ensureNoteDebtCursorReliefColumn(db) {
  addColumnIfMissing(
    db,
    "note_debt_cursor",
    "last_relief_prompt_number",
    "INTEGER NOT NULL DEFAULT 0"
  );
}
function retireLegacyPendingNoteDebts(db) {
  const nowEpoch = Math.floor(Date.now() / 1e3);
  return db.query(
    `UPDATE note_debt
       SET status = 'skipped', reason = 'closed',
           closed_at_epoch = ?, updated_at_epoch = ?
       WHERE status = 'pending'`
  ).run(nowEpoch, nowEpoch).changes;
}
function noteSettlementTriggerVocabularyIsStale(db) {
  const storedDdl = db.query(
    `SELECT sql FROM sqlite_master
         WHERE type = 'table' AND name = 'note_settlement_jobs'`
  ).get()?.sql ?? null;
  return storedDdl !== null && !storedDdl.includes("'sessionend'");
}
function ensureNoteSettlementSessionEndTrigger(db) {
  if (!noteSettlementTriggerVocabularyIsStale(db)) {
    return;
  }
  runWriteTransaction(db, () => {
    if (!noteSettlementTriggerVocabularyIsStale(db)) {
      return;
    }
    db.exec(
      "ALTER TABLE note_settlement_jobs RENAME TO note_settlement_jobs_pre_sessionend"
    );
    db.exec(NOTE_SETTLEMENT_JOBS_TABLE_DDL);
    db.exec(
      `INSERT INTO note_settlement_jobs (
         id, session_id, window_start, window_end, trigger_type, status,
         attempts, retry_at_epoch, claimed_at_epoch, claim_generation,
         last_error, created_at_epoch, updated_at_epoch
       )
       SELECT
         id, session_id, window_start, window_end, trigger_type, status,
         attempts, retry_at_epoch, claimed_at_epoch, claim_generation,
         last_error, created_at_epoch, updated_at_epoch
       FROM note_settlement_jobs_pre_sessionend`
    );
    db.exec("DROP TABLE note_settlement_jobs_pre_sessionend");
    db.exec(NOTE_SETTLEMENT_JOBS_INDEX_DDL);
  });
}
function ensureObservationExtractionExclusionColumn(db) {
  addColumnIfMissing(
    db,
    "observations",
    "excluded_from_extraction",
    "INTEGER NOT NULL DEFAULT 0"
  );
}
function ensureShadowNoteWriterOriginColumn(db) {
  if (!hasColumn(db, "shadow_notes", "writer_origin")) {
    db.exec(
      "ALTER TABLE shadow_notes ADD COLUMN writer_origin TEXT NOT NULL DEFAULT 'agent'"
    );
  }
}
function ensureRepairLedgerClaimColumns(db) {
  const columns = [
    ["claim_generation", "INTEGER NOT NULL DEFAULT 0"],
    ["claimed_at_epoch", "INTEGER"],
    ["deferred_until_epoch", "INTEGER"],
    ["deferral_attempts", "INTEGER NOT NULL DEFAULT 0"]
  ];
  for (const [column, definition] of columns) {
    addColumnIfMissing(db, "repair_ledger", column, definition);
  }
}
function ensureSettlementClaimGenerationColumn(db) {
  addColumnIfMissing(
    db,
    "settlement_jobs",
    "claim_generation",
    "INTEGER NOT NULL DEFAULT 0"
  );
}
function ensureDiaryDayStateTerminalColumn(db) {
  addColumnIfMissing(
    db,
    "diary_day_state",
    "terminal",
    "INTEGER NOT NULL DEFAULT 0"
  );
}
function ensureDiaryDayStateRetryDispositionColumn(db) {
  addColumnIfMissing(
    db,
    "diary_day_state",
    "retry_disposition",
    `TEXT CHECK (
       retry_disposition IS NULL OR
       retry_disposition IN ('transient', 'permanent')
     )`
  );
  db.exec(
    `UPDATE diary_day_state
     SET retry_disposition = 'permanent'
     WHERE terminal = 1 AND retry_disposition IS NULL`
  );
}
function dropRetiredMaintenanceState(db) {
  db.exec("DROP TABLE IF EXISTS persona_operation_state");
  db.exec("DROP INDEX IF EXISTS idx_turns_status");
}
function ensureSessionTranscriptPathColumn(db) {
  addColumnIfMissing(db, "sessions", "transcript_path", "TEXT");
}
function ensureSessionSummaryUpdatedAtEpochColumn(db) {
  addColumnIfMissing(db, "sessions", "summary_updated_at_epoch", "INTEGER");
}
function ensureSessionSummaryFieldColumns(db) {
  for (const column of ["decision", "done", "current", "reference"]) {
    addColumnIfMissing(db, "sessions", column, "TEXT");
  }
}
function ensureTurnTranscriptLineStartColumn(db) {
  addColumnIfMissing(db, "turns", "transcript_line_start", "INTEGER");
}
function ensureTurnAssistantTranscriptColumn(db) {
  addColumnIfMissing(db, "turns", "assistant_transcript", "TEXT");
}
function ensureTurnInvalidationColumns(db) {
  addColumnIfMissing(db, "turns", "was_interrupted", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "turns", "was_rolled_back", "INTEGER NOT NULL DEFAULT 0");
}
function ensureTurnSignificanceGradeColumn(db) {
  addColumnIfMissing(
    db,
    "turns",
    "significance_grade",
    "INTEGER CHECK (significance_grade IS NULL OR significance_grade BETWEEN 0 AND 4)"
  );
}
function ensureTurnCitationsSchema(db) {
  addColumnIfMissing(db, "turns", "cites_recorded", "INTEGER NOT NULL DEFAULT 0");
}
function ensureTurnConsultedMemoriesColumn(db) {
  addColumnIfMissing(db, "turns", "consulted_memories", "TEXT");
}
function ensureSessionScanCursorColumns(db) {
  addColumnIfMissing(
    db,
    "sessions",
    "scan_cursor_byte_offset",
    "INTEGER NOT NULL DEFAULT 0"
  );
  addColumnIfMissing(
    db,
    "sessions",
    "scan_cursor_line",
    "INTEGER NOT NULL DEFAULT 0"
  );
}
function ensureTurnCompactBoundarySchema(db) {
  addColumnIfMissing(db, "turns", "compact_boundary_uuid", "TEXT");
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_turns_compact_boundary_uuid
      ON turns(session_id, compact_boundary_uuid)
      WHERE compact_boundary_uuid IS NOT NULL
  `);
}
function ensureForkLineageColumns(db) {
  if (addColumnIfMissing(db, "turns", "parent_turn_id", "INTEGER")) {
    backfillAllIntraChains(db);
  }
  addColumnIfMissing(db, "sessions", "parent_session_id", "INTEGER");
  addColumnIfMissing(
    db,
    "sessions",
    "lineage_status",
    "TEXT NOT NULL DEFAULT 'unchecked'"
  );
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
function isDuplicateColumnError(error48) {
  const message = error48 instanceof Error ? error48.message : String(error48);
  return /duplicate column name/i.test(message);
}
function addColumnIfMissing(db, table, column, definition) {
  if (hasColumn(db, table, column)) {
    return false;
  }
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN "${column}" ${definition}`);
  } catch (error48) {
    if (!isDuplicateColumnError(error48)) {
      throw error48;
    }
  }
  return true;
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
    { table: "segments", layer: "segment" },
    { table: "rules", layer: "rule" }
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
  db.exec("DROP TRIGGER IF EXISTS rule_events_validate_source");
  db.exec("DROP TRIGGER IF EXISTS rules_validate_trigger_spec_update");
  db.exec("DROP TRIGGER IF EXISTS rules_validate_trigger_spec_insert");
  db.exec("DROP TRIGGER IF EXISTS rule_events_no_delete");
  db.exec("DROP TRIGGER IF EXISTS rule_events_no_update");
  db.exec("DROP TRIGGER IF EXISTS rules_no_hard_delete");
  db.exec("DROP TABLE IF EXISTS rule_events");
  db.exec("DROP TABLE IF EXISTS rules");
  db.exec("DROP TABLE IF EXISTS persona_operation_state");
  db.exec("DROP TABLE IF EXISTS diary_state");
  db.exec("DROP TABLE IF EXISTS diary_day_state");
  db.exec("DROP TABLE IF EXISTS pending_queue");
  db.exec("DROP TABLE IF EXISTS repair_ledger");
  db.exec("DROP TABLE IF EXISTS diary_day_state");
  db.exec("DROP TABLE IF EXISTS memories");
  db.exec("DROP TABLE IF EXISTS shadow_notes");
  db.exec("DROP TABLE IF EXISTS note_id_exposures");
  db.exec("DROP TABLE IF EXISTS note_settlement_jobs");
  db.exec("DROP TABLE IF EXISTS note_settlement_cursors");
  db.exec("DROP TABLE IF EXISTS note_debt_cursor");
  db.exec("DROP TABLE IF EXISTS note_debt");
  db.exec("DROP TABLE IF EXISTS note_debt_pre_closed_reason");
  db.exec("DROP TABLE IF EXISTS observations");
  db.exec("DROP TABLE IF EXISTS segment_members");
  db.exec("DROP TABLE IF EXISTS segments");
  db.exec("DROP TABLE IF EXISTS topics");
  db.exec("DROP TABLE IF EXISTS memory_edges");
  db.exec("DROP TABLE IF EXISTS turn_citations");
  db.exec("DROP TABLE IF EXISTS settlement_jobs");
  db.exec("DROP TABLE IF EXISTS settlement_cursors");
  db.exec("DROP TABLE IF EXISTS turns");
  db.exec("DROP TABLE IF EXISTS session_run_state");
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

// src/shared/logger.ts
var import_node_fs3 = require("node:fs");
var import_node_path4 = require("node:path");

// src/shared/error-sanitizer.ts
var REDACTED = "[REDACTED]";
var SENSITIVE_ENV_KEY = /(?:API[_-]?KEY|AUTH|TOKEN|SECRET|PASSWORD|COOKIE|CUSTOM[_-]?HEADERS|(?:^|_)PROXY$)/i;
var BUILTIN_HEADER_NAMES = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key"
];
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function collectSensitiveValues(env) {
  const values = /* @__PURE__ */ new Set();
  for (const [key, value] of Object.entries(env)) {
    if (!value || !SENSITIVE_ENV_KEY.test(key)) {
      continue;
    }
    if (value.length >= 4) {
      values.add(value);
    }
    try {
      const url2 = new URL(value);
      if (url2.username.length >= 1) {
        values.add(decodeURIComponent(url2.username));
      }
      if (url2.password.length >= 1) {
        values.add(decodeURIComponent(url2.password));
      }
    } catch {
    }
  }
  return [...values].sort((left, right) => right.length - left.length);
}
function collectCustomHeaderNames(env) {
  const names = new Set(BUILTIN_HEADER_NAMES);
  for (const [key, value] of Object.entries(env)) {
    if (!value || !/CUSTOM[_-]?HEADERS/i.test(key)) {
      continue;
    }
    for (const line of value.split(/\r?\n/)) {
      const separator = line.indexOf(":");
      if (separator > 0) {
        names.add(line.slice(0, separator).trim().toLowerCase());
      }
    }
  }
  return [...names].filter((name) => name !== "");
}
function sanitizeSecretString(input, sensitiveEnv = process.env) {
  let sanitized = input;
  for (const value of collectSensitiveValues(sensitiveEnv)) {
    sanitized = sanitized.replaceAll(value, REDACTED);
  }
  sanitized = sanitized.replace(
    /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+)(?::([^/\s@]*))?@/gi,
    `$1${REDACTED}@`
  );
  for (const headerName of collectCustomHeaderNames(sensitiveEnv)) {
    const escaped = escapeRegExp(headerName);
    sanitized = sanitized.replace(
      new RegExp(`("${escaped}"\\s*:\\s*")[^"]*(")`, "gi"),
      `$1${REDACTED}$2`
    );
    sanitized = sanitized.replace(
      new RegExp(`(^|[\\r\\n,;{]\\s*)(${escaped}\\s*[:=]\\s*)[^\\r\\n,;}]+`, "gi"),
      `$1$2${REDACTED}`
    );
  }
  return sanitized;
}
function sensitiveObjectKey(key, customHeaders) {
  return SENSITIVE_ENV_KEY.test(key) || customHeaders.has(key.toLowerCase());
}
function sanitizeLogValue(value, sensitiveEnv = process.env) {
  const seen = /* @__PURE__ */ new WeakSet();
  const customHeaders = new Set(collectCustomHeaderNames(sensitiveEnv));
  const visit = (current) => {
    if (typeof current === "string") {
      return sanitizeSecretString(current, sensitiveEnv);
    }
    if (current === null || current === void 0 || typeof current === "number" || typeof current === "boolean") {
      return current;
    }
    if (typeof current === "bigint") {
      return current.toString();
    }
    if (typeof current !== "object") {
      return String(current);
    }
    if (seen.has(current)) {
      return "[Circular]";
    }
    seen.add(current);
    if (current instanceof Error) {
      const error48 = current;
      const summary = {
        name: error48.name,
        message: sanitizeSecretString(error48.message, sensitiveEnv)
      };
      for (const key of [
        "type",
        "status",
        "requestId",
        "request_id",
        "code",
        "retryInMs",
        "retryAfter"
      ]) {
        const field = error48[key];
        if (field !== void 0 && field !== null) {
          summary[key] = visit(field);
        }
      }
      return summary;
    }
    if (Array.isArray(current)) {
      return current.map(visit);
    }
    const result = {};
    for (const [key, field] of Object.entries(current)) {
      result[key] = sensitiveObjectKey(key, customHeaders) ? REDACTED : visit(field);
    }
    return result;
  };
  return visit(value);
}

// src/shared/logger.ts
var LOG_PATH = (0, import_node_path4.join)(DATA_DIR, "claude-mnemo.log");
var dirEnsured = false;
function ensureLogDir() {
  if (!dirEnsured) {
    (0, import_node_fs3.mkdirSync)(DATA_DIR, { recursive: true });
    dirEnsured = true;
  }
}
function writeLog(level, component, message, context, sensitiveEnv = process.env) {
  const line = JSON.stringify({
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    level,
    component,
    message: sanitizeSecretString(message, sensitiveEnv),
    context: context ? sanitizeLogValue(context, sensitiveEnv) : null
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
function createLogger(component, options = {}) {
  const sensitiveEnv = options.sensitiveEnv ?? process.env;
  return {
    debug(message, context) {
      writeLog("debug", component, message, context, sensitiveEnv);
    },
    info(message, context) {
      writeLog("info", component, message, context, sensitiveEnv);
    },
    warn(message, context) {
      writeLog("warn", component, message, context, sensitiveEnv);
    },
    error(message, context) {
      writeLog("error", component, message, context, sensitiveEnv);
    }
  };
}

// src/diary/file-store.ts
var import_promises = require("node:fs/promises");
var import_node_path5 = require("node:path");
var DiaryFileStore = class {
  constructor(dataRoot) {
    this.dataRoot = dataRoot;
  }
  dataRoot;
  async readIndex() {
    const diaryRoot = (0, import_node_path5.join)(this.dataRoot, "diary");
    try {
      const rootMetadata = await (0, import_promises.lstat)(diaryRoot);
      if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
        throw new Error(`Diary root must be a real directory: ${diaryRoot}`);
      }
    } catch (error48) {
      if (error48.code !== "ENOENT") throw error48;
    }
    const indexPath = (0, import_node_path5.join)(diaryRoot, "INDEX.md");
    try {
      const indexMetadata = await (0, import_promises.lstat)(indexPath);
      if (indexMetadata.isSymbolicLink() || !indexMetadata.isFile()) {
        throw new Error(`Diary index must be a regular file: ${indexPath}`);
      }
    } catch (error48) {
      if (error48.code !== "ENOENT") throw error48;
    }
    return (0, import_promises.readFile)(indexPath);
  }
};

// src/diary/memory-store.ts
var import_node_crypto = require("node:crypto");
var import_promises2 = require("node:fs/promises");
var import_node_path6 = require("node:path");

// src/shared/markdown-sections.ts
var FENCE_START = /^ {0,3}(`{3,}|~{3,})/;
var ATX_HEADING = /^ {0,3}(#{1,6})[ \t]+(.*)$/;
function splitDocumentLines(document) {
  if (document.length === 0) return [];
  const lines = document.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}
function openingFence(line) {
  const match = FENCE_START.exec(line);
  if (!match) return null;
  const run = match[1];
  return {
    marker: run[0],
    length: run.length
  };
}
function closesFence(line, fence) {
  const match = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
  return Boolean(
    match && match[1][0] === fence.marker && match[1].length >= fence.length
  );
}
function parseMarkdownSections(document) {
  const lines = splitDocumentLines(document);
  if (lines.length === 0) return [];
  const sections = [];
  let current = null;
  let fence = null;
  for (const line of lines) {
    if (fence) {
      current ??= { title: "", level: 0, bodyLines: [] };
      current.bodyLines.push(line);
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    const nextFence = openingFence(line);
    if (nextFence) {
      current ??= { title: "", level: 0, bodyLines: [] };
      current.bodyLines.push(line);
      fence = nextFence;
      continue;
    }
    const heading = ATX_HEADING.exec(line);
    if (heading) {
      if (current) sections.push(current);
      current = {
        title: heading[2],
        level: heading[1].length,
        bodyLines: []
      };
      continue;
    }
    current ??= { title: "", level: 0, bodyLines: [] };
    current.bodyLines.push(line);
  }
  if (current) sections.push(current);
  return sections;
}

// src/diary/diary-index.ts
var openingFence2 = (line) => {
  const run = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
  return run ? { marker: run[0], length: run.length } : null;
};
var closesFence2 = (line, fence) => {
  const run = /^ {0,3}(`+|~+)[ \t]*$/.exec(line)?.[1];
  return Boolean(
    run && run[0] === fence.marker && run.length >= fence.length
  );
};
function datedDiaryIndexLines(lines) {
  const entries = [];
  let fence = null;
  let inDiaryIndex = false;
  lines.forEach((line, lineIndex) => {
    if (fence) {
      if (closesFence2(line, fence)) fence = null;
      return;
    }
    const nextFence = openingFence2(line);
    if (nextFence) {
      fence = nextFence;
      return;
    }
    const heading = /^ {0,3}(#{1,6})[ \t]+(.*)$/.exec(line);
    if (heading) {
      if (heading[1] === "#") inDiaryIndex = heading[2].trim() === "Diary Index";
      return;
    }
    if (!inDiaryIndex) return;
    const date5 = /^-\s+(\d{4}-\d{2}-\d{2})(?:：|:)/.exec(line)?.[1];
    if (date5) entries.push({ line, date: date5, order: entries.length, lineIndex });
  });
  return entries;
}
function sortDiaryIndexRecentFirst(document) {
  const hasTrailingNewline = document.endsWith("\n");
  const lines = document.replaceAll("\r\n", "\n").split("\n");
  if (hasTrailingNewline) lines.pop();
  const entries = datedDiaryIndexLines(lines);
  const entryLineIndexes = new Set(entries.map((entry) => entry.lineIndex));
  const blocks = entries.map((entry) => {
    let endLineIndex = entry.lineIndex + 1;
    while (endLineIndex < lines.length && !entryLineIndexes.has(endLineIndex) && (lines[endLineIndex].trim() === "" || /^[ \t]+/.test(lines[endLineIndex]))) {
      endLineIndex += 1;
    }
    return {
      ...entry,
      lines: lines.slice(entry.lineIndex, endLineIndex),
      endLineIndex
    };
  });
  const sortedBlocks = blocks.slice().sort(
    (left, right) => right.date.localeCompare(left.date) || left.order - right.order
  );
  const blocksByStart = new Map(
    blocks.map((block) => [block.lineIndex, block])
  );
  const sorted = [];
  let sortedIndex = 0;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const originalBlock = blocksByStart.get(lineIndex);
    if (!originalBlock) {
      sorted.push(lines[lineIndex]);
      continue;
    }
    sorted.push(...sortedBlocks[sortedIndex++].lines);
    lineIndex = originalBlock.endLineIndex - 1;
  }
  return `${sorted.join("\n")}${hasTrailingNewline ? "\n" : ""}`;
}

// src/diary/memory-store.ts
var DEFAULT_MEMORY_HISTORY_RETENTION = {
  newest: 30,
  monthly: true
};
var EMPTY_PROFILE_DOCUMENT = "# User Profile\n";
var EMPTY_ARCHIVE_DOCUMENT = "# Memory Archive\n";
var MEMORY_FILES = [
  "user-profile.md",
  "archive.md"
];
var SNAPSHOT_MANIFEST_FILE = "manifest.json";
var LegacyPersonaUnavailableError = class extends Error {
};
var encoder = new TextEncoder();
var decoder = new TextDecoder("utf-8", { fatal: true });
function assertDiaryDate(date5) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date5)) {
    throw new Error(`Invalid dream date: ${date5}`);
  }
}
function sha256(bytes) {
  return (0, import_node_crypto.createHash)("sha256").update(bytes).digest("hex");
}
function decodeUtf8(bytes, label) {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}
function assertParseableMarkdown(label, document) {
  if (!parseMarkdownSections(document).some((section) => section.level >= 1)) {
    throw new Error(`${label} must contain at least one Markdown ATX heading`);
  }
}
function defaultCurrentMemory() {
  return {
    userProfile: EMPTY_PROFILE_DOCUMENT,
    archive: EMPTY_ARCHIVE_DOCUMENT
  };
}
function documentForFilename(documents, filename) {
  switch (filename) {
    case "user-profile.md":
      return documents.userProfile;
    case "archive.md":
      return documents.archive;
  }
}
function snapshotId(now) {
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  return `${timestamp}-${(0, import_node_crypto.randomUUID)()}`;
}
function assertSafeId(id) {
  if (!/^[A-Za-z0-9_-]+$/.test(id) || id.startsWith(".")) {
    throw new Error(`Invalid memory snapshot id: ${id}`);
  }
}
function isWithin(root, target) {
  const pathFromRoot = (0, import_node_path6.relative)(root, target);
  return pathFromRoot === "" || pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${import_node_path6.sep}`) && !pathFromRoot.startsWith(import_node_path6.sep);
}
var DreamMemoryStore = class {
  constructor(dataRoot, options = {}) {
    this.dataRoot = dataRoot;
    this.retention = {
      newest: options.retention?.newest ?? DEFAULT_MEMORY_HISTORY_RETENTION.newest,
      monthly: options.retention?.monthly ?? DEFAULT_MEMORY_HISTORY_RETENTION.monthly
    };
    if (!Number.isSafeInteger(this.retention.newest) || this.retention.newest < 0) {
      throw new Error("Memory history retention newest must be a non-negative integer");
    }
    this.now = options.now ?? (() => /* @__PURE__ */ new Date());
    this.logger = options.logger ?? createLogger("MNEMOSYNE");
    this.faultInjector = options.faultInjector;
  }
  dataRoot;
  retention;
  now;
  logger;
  faultInjector;
  /**
   * Atomically publishes the complete output of one dream run.
   *
   * Snapshot and validation order is part of the public contract. The success
   * marker is deliberately separate and last: without it the date is unprocessed.
   */
  async commitNight(input) {
    assertDiaryDate(input.date);
    await this.recoverIncompleteTransactions();
    await this.assertWorkspaceRootsAreSafe();
    const previous = await this.readCurrentMemoryWithoutRecovery();
    const snapshot = await this.createSnapshot(input.date, previous);
    await this.injectFault("after-snapshot");
    const normalizedInput = {
      ...input,
      diaryIndex: sortDiaryIndexRecentFirst(input.diaryIndex)
    };
    this.validateCommitDocuments(normalizedInput);
    const transaction = await this.prepareTransaction("commit", input.date, {
      "memory/user-profile.md": normalizedInput.userProfile,
      "memory/archive.md": normalizedInput.archive,
      "memory/migration-state.json": this.serializeMigrationState(false),
      [`diary/${input.date}.md`]: normalizedInput.diary,
      "diary/INDEX.md": normalizedInput.diaryIndex
    });
    try {
      await this.injectFault("after-staging");
      await this.publishTransaction(transaction);
      await this.injectFault("after-publish");
      await this.injectFault("before-success-marker");
      await this.writeSuccessMarker(input.date, transaction.id);
    } catch (error48) {
      const marker = await this.readSuccessMarkerWithoutRecovery().catch(
        () => null
      );
      if (marker?.transactionId !== transaction.id) {
        try {
          await this.rollbackTransaction(transaction);
        } catch (rollbackError) {
          throw new AggregateError(
            [error48, rollbackError],
            `Dream commit failed and rollback could not complete for ${input.date}`
          );
        }
        throw error48;
      } else {
        await (0, import_promises2.rm)(transaction.root, { recursive: true, force: true }).catch(
          () => void 0
        );
      }
    }
    await (0, import_promises2.rm)(transaction.root, { recursive: true, force: true });
    await this.syncDirectory(this.transactionsRoot()).catch(() => void 0);
    await this.applyRetention().catch((error48) => {
      this.logger.warn("Memory snapshot retention failed after a successful commit", {
        date: input.date,
        error: error48 instanceof Error ? error48.message : String(error48)
      });
    });
    return { snapshot, lastSuccessfulDate: input.date };
  }
  async readCurrentMemory() {
    await this.recoverIncompleteTransactions();
    await this.assertWorkspaceRootsAreSafe();
    return this.readCurrentMemoryWithoutRecovery();
  }
  async readInjectionDocuments() {
    await this.assertWorkspaceRootsAreSafe({ createDataRoot: false });
    const userProfile = await this.readMemoryDocument("user-profile.md", "");
    return { userProfile };
  }
  async requiresInitialFullFill() {
    await this.recoverIncompleteTransactions();
    return (await this.readMigrationStateWithoutRecovery())?.requires_full_fill ?? false;
  }
  async readLastSuccessfulDate() {
    await this.recoverIncompleteTransactions();
    return this.readLastSuccessfulDateWithoutRecovery();
  }
  async listSnapshots() {
    await this.recoverIncompleteTransactions();
    return this.listSnapshotsWithoutRecovery();
  }
  async verifySnapshot(id) {
    await this.recoverIncompleteTransactions();
    return this.verifySnapshotWithoutRecovery(id);
  }
  async restoreSnapshot(id) {
    await this.recoverIncompleteTransactions();
    await this.assertWorkspaceRootsAreSafe();
    const snapshot = await this.verifySnapshotWithoutRecovery(id);
    const transaction = await this.prepareTransaction("restore", snapshot.date, {
      "memory/user-profile.md": snapshot.documents.userProfile,
      "memory/archive.md": snapshot.documents.archive
    });
    await this.executeTransaction(
      transaction,
      `Memory snapshot restore failed and rollback could not complete: ${id}`
    );
  }
  /**
   * One-time cutover adapter. It reads the old published snapshot once, copies
   * it into the single-current dream layout, then removes the old layout.
   */
  async migrateLegacyPersona() {
    await this.recoverIncompleteTransactions();
    await this.assertWorkspaceRootsAreSafe();
    const hasProfile = await this.pathExists(this.memoryPath("user-profile.md"));
    if (hasProfile) {
      const migrationState = await this.readMigrationStateWithoutRecovery();
      if (!await this.pathExists(this.memoryPath("archive.md")) || migrationState === null) {
        await this.publishMigrationDocumentsAtomically(
          await this.readCurrentMemoryWithoutRecovery(),
          migrationState?.requires_full_fill ?? false
        );
      }
      await this.retireLegacyPersonaLayout();
      return { status: "already-current" };
    }
    let legacy = null;
    try {
      legacy = await this.loadLegacyCurrentPersona();
    } catch (error48) {
      if (!(error48 instanceof LegacyPersonaUnavailableError)) throw error48;
      this.logger.warn(
        "Legacy persona CURRENT is missing or invalid; starting dream memory from empty documents",
        { error: error48 instanceof Error ? error48.message : String(error48) }
      );
    }
    if (legacy === null) {
      await this.publishMigrationDocumentsAtomically(defaultCurrentMemory(), true);
      await this.retireLegacyPersonaLayout();
      return { status: "empty", reason: "legacy-current-unavailable" };
    }
    await this.publishMigrationDocumentsAtomically(legacy.documents, false);
    await this.retireLegacyPersonaLayout();
    return { status: "migrated", generation: legacy.generation };
  }
  validateCommitDocuments(input) {
    assertParseableMarkdown("userProfile", input.userProfile);
    assertParseableMarkdown("archive", input.archive);
    assertParseableMarkdown("diary", input.diary);
    assertParseableMarkdown("diaryIndex", input.diaryIndex);
  }
  async injectFault(point) {
    await this.faultInjector?.(point);
  }
  memoryRoot() {
    return (0, import_node_path6.join)(this.dataRoot, "memory");
  }
  memoryPath(filename) {
    return (0, import_node_path6.join)(this.memoryRoot(), filename);
  }
  historyRoot() {
    return (0, import_node_path6.join)(this.memoryRoot(), "history");
  }
  transactionsRoot() {
    return (0, import_node_path6.join)(this.memoryRoot(), ".transactions");
  }
  successMarkerPath() {
    return (0, import_node_path6.join)(this.memoryRoot(), "last-successful.json");
  }
  migrationStatePath() {
    return (0, import_node_path6.join)(this.memoryRoot(), "migration-state.json");
  }
  async assertWorkspaceRootsAreSafe(options = {}) {
    if (options.createDataRoot !== false) {
      await (0, import_promises2.mkdir)(this.dataRoot, { recursive: true });
    }
    for (const root of [this.dataRoot, this.memoryRoot(), (0, import_node_path6.join)(this.dataRoot, "diary")]) {
      try {
        const metadata = await (0, import_promises2.lstat)(root);
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
          throw new Error(`Dream workspace root must be a real directory: ${root}`);
        }
      } catch (error48) {
        if (error48.code !== "ENOENT") throw error48;
      }
    }
  }
  async assertFileIsSafe(path2) {
    const absoluteRoot = (0, import_node_path6.resolve)(this.dataRoot);
    const absolutePath = (0, import_node_path6.resolve)(path2);
    if (!isWithin(absoluteRoot, absolutePath)) {
      throw new Error(`Dream workspace path is outside data root: ${path2}`);
    }
    try {
      const metadata = await (0, import_promises2.lstat)(path2);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error(`Dream workspace document must be a regular file: ${path2}`);
      }
    } catch (error48) {
      if (error48.code !== "ENOENT") throw error48;
    }
  }
  async readCurrentMemoryWithoutRecovery() {
    const defaults = defaultCurrentMemory();
    const [userProfile, archive] = await Promise.all([
      this.readMemoryDocument("user-profile.md", defaults.userProfile),
      this.readMemoryDocument("archive.md", defaults.archive)
    ]);
    return { userProfile, archive };
  }
  async readMemoryDocument(filename, fallback) {
    const path2 = this.memoryPath(filename);
    await this.assertFileIsSafe(path2);
    try {
      return decodeUtf8(await (0, import_promises2.readFile)(path2), `memory/${filename}`);
    } catch (error48) {
      if (error48.code === "ENOENT") return fallback;
      throw error48;
    }
  }
  async createSnapshot(date5, documents) {
    const createdAt = this.now().toISOString();
    const id = snapshotId(new Date(createdAt));
    const historyRoot = this.historyRoot();
    const finalRoot = (0, import_node_path6.join)(historyRoot, id);
    const temporaryRoot = (0, import_node_path6.join)(historyRoot, `.${id}.tmp`);
    await (0, import_promises2.mkdir)(historyRoot, { recursive: true });
    await (0, import_promises2.mkdir)(temporaryRoot);
    try {
      const files = {};
      for (const filename of MEMORY_FILES) {
        const bytes = encoder.encode(documentForFilename(documents, filename));
        await this.writeFileSynced((0, import_node_path6.join)(temporaryRoot, filename), bytes);
        files[filename] = sha256(bytes);
      }
      const manifest = {
        version: 1,
        id,
        date: date5,
        created_at: createdAt,
        files
      };
      await this.writeFileSynced(
        (0, import_node_path6.join)(temporaryRoot, SNAPSHOT_MANIFEST_FILE),
        encoder.encode(`${JSON.stringify(manifest, null, 2)}
`)
      );
      await this.syncDirectory(temporaryRoot);
      await (0, import_promises2.rename)(temporaryRoot, finalRoot);
      await this.syncDirectory(historyRoot);
      return { id, date: date5, createdAt };
    } catch (error48) {
      await (0, import_promises2.rm)(temporaryRoot, { recursive: true, force: true }).catch(
        () => void 0
      );
      throw error48;
    }
  }
  async listSnapshotsWithoutRecovery() {
    let entries;
    try {
      entries = await (0, import_promises2.readdir)(this.historyRoot(), { withFileTypes: true });
    } catch (error48) {
      if (error48.code === "ENOENT") return [];
      throw error48;
    }
    const snapshots = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error(`Invalid entry in memory history: ${entry.name}`);
      }
      const manifest = await this.readSnapshotManifest(entry.name);
      snapshots.push({
        id: manifest.id,
        date: manifest.date,
        createdAt: manifest.created_at
      });
    }
    return snapshots.sort(
      (left, right) => right.date.localeCompare(left.date) || right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)
    );
  }
  async readSnapshotManifest(id) {
    assertSafeId(id);
    const root = (0, import_node_path6.join)(this.historyRoot(), id);
    const metadata = await (0, import_promises2.lstat)(root);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`Memory snapshot is not a real directory: ${id}`);
    }
    let manifest;
    try {
      manifest = JSON.parse(
        decodeUtf8(
          await (0, import_promises2.readFile)((0, import_node_path6.join)(root, SNAPSHOT_MANIFEST_FILE)),
          `memory snapshot manifest ${id}`
        )
      );
    } catch (error48) {
      if (error48 instanceof SyntaxError) {
        throw new Error(`Invalid memory snapshot manifest: ${id}`);
      }
      throw error48;
    }
    if (manifest.version !== 1 || manifest.id !== id || typeof manifest.created_at !== "string" || Number.isNaN(Date.parse(manifest.created_at)) || typeof manifest.files !== "object" || manifest.files === null) {
      throw new Error(`Invalid memory snapshot manifest: ${id}`);
    }
    assertDiaryDate(manifest.date);
    for (const filename of MEMORY_FILES) {
      if (!/^[a-f0-9]{64}$/.test(manifest.files[filename] ?? "")) {
        throw new Error(`Invalid memory snapshot manifest hash: ${id}/${filename}`);
      }
    }
    return manifest;
  }
  async verifySnapshotWithoutRecovery(id) {
    const manifest = await this.readSnapshotManifest(id);
    const root = (0, import_node_path6.join)(this.historyRoot(), id);
    const loaded = {};
    for (const filename of MEMORY_FILES) {
      const path2 = (0, import_node_path6.join)(root, filename);
      const metadata = await (0, import_promises2.lstat)(path2);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error(`Invalid memory snapshot document: ${id}/${filename}`);
      }
      const bytes = await (0, import_promises2.readFile)(path2);
      if (sha256(bytes) !== manifest.files[filename]) {
        throw new Error(`Memory snapshot hash mismatch: ${id}/${filename}`);
      }
      loaded[filename] = decodeUtf8(bytes, `memory snapshot ${id}/${filename}`);
    }
    return {
      id,
      date: manifest.date,
      createdAt: manifest.created_at,
      documents: {
        userProfile: loaded["user-profile.md"],
        archive: loaded["archive.md"]
      }
    };
  }
  async applyRetention() {
    const snapshots = await this.listSnapshotsWithoutRecovery();
    const keep = new Set(
      snapshots.slice(0, this.retention.newest).map((snapshot) => snapshot.id)
    );
    if (this.retention.monthly) {
      const seenMonths = /* @__PURE__ */ new Set();
      for (const snapshot of snapshots.slice(this.retention.newest)) {
        const month = snapshot.date.slice(0, 7);
        if (!seenMonths.has(month)) {
          seenMonths.add(month);
          keep.add(snapshot.id);
        }
      }
    }
    for (const snapshot of snapshots) {
      if (!keep.has(snapshot.id)) {
        await (0, import_promises2.rm)((0, import_node_path6.join)(this.historyRoot(), snapshot.id), {
          recursive: true,
          force: true
        });
      }
    }
    await this.syncDirectory(this.historyRoot());
  }
  async prepareTransaction(kind, date5, documents) {
    if (date5 !== null) assertDiaryDate(date5);
    const id = (0, import_node_crypto.randomUUID)();
    const root = (0, import_node_path6.join)(this.transactionsRoot(), id);
    await (0, import_promises2.mkdir)((0, import_node_path6.join)(root, "backups"), { recursive: true });
    await (0, import_promises2.mkdir)((0, import_node_path6.join)(root, "staged"), { recursive: true });
    const targets = [];
    try {
      for (const [relativePath, document] of Object.entries(documents)) {
        this.assertTransactionPath(relativePath);
        const finalPath = (0, import_node_path6.join)(this.dataRoot, relativePath);
        await this.assertFileIsSafe(finalPath);
        let existed = true;
        try {
          const bytes = await (0, import_promises2.readFile)(finalPath);
          await this.writeFileSynced((0, import_node_path6.join)(root, "backups", relativePath), bytes);
        } catch (error48) {
          if (error48.code !== "ENOENT") throw error48;
          existed = false;
        }
        await this.writeFileSynced(
          (0, import_node_path6.join)(root, "staged", relativePath),
          encoder.encode(document)
        );
        targets.push({ path: relativePath, existed });
      }
      const manifest = { version: 1, id, kind, date: date5, targets };
      await this.writeFileSynced(
        (0, import_node_path6.join)(root, "manifest.json"),
        encoder.encode(`${JSON.stringify(manifest, null, 2)}
`)
      );
      await this.syncDirectory(root);
      return { id, root, manifest };
    } catch (error48) {
      await (0, import_promises2.rm)(root, { recursive: true, force: true }).catch(() => void 0);
      throw error48;
    }
  }
  async publishTransaction(transaction) {
    for (const target of transaction.manifest.targets) {
      const finalPath = (0, import_node_path6.join)(this.dataRoot, target.path);
      await (0, import_promises2.mkdir)((0, import_node_path6.dirname)(finalPath), { recursive: true });
      await (0, import_promises2.rename)((0, import_node_path6.join)(transaction.root, "staged", target.path), finalPath);
      await this.syncDirectory((0, import_node_path6.dirname)(finalPath));
    }
  }
  async rollbackTransaction(transaction) {
    for (const target of transaction.manifest.targets) {
      const finalPath = (0, import_node_path6.join)(this.dataRoot, target.path);
      if (target.existed) {
        const backup = await (0, import_promises2.readFile)((0, import_node_path6.join)(transaction.root, "backups", target.path));
        await this.writeAtomically(finalPath, backup);
      } else {
        await (0, import_promises2.unlink)(finalPath).catch((error48) => {
          if (error48.code !== "ENOENT") throw error48;
        });
        await this.syncDirectory((0, import_node_path6.dirname)(finalPath)).catch(() => void 0);
      }
    }
    await (0, import_promises2.rm)(transaction.root, { recursive: true, force: true });
  }
  async executeTransaction(transaction, rollbackFailureMessage) {
    try {
      await this.publishTransaction(transaction);
    } catch (error48) {
      try {
        await this.rollbackTransaction(transaction);
      } catch (rollbackError) {
        throw new AggregateError(
          [error48, rollbackError],
          rollbackFailureMessage
        );
      }
      throw error48;
    }
    await (0, import_promises2.rm)(transaction.root, { recursive: true, force: true });
  }
  async recoverIncompleteTransactions() {
    let entries;
    try {
      entries = await (0, import_promises2.readdir)(this.transactionsRoot(), { withFileTypes: true });
    } catch (error48) {
      if (error48.code === "ENOENT") return;
      throw error48;
    }
    const marker = await this.readSuccessMarkerWithoutRecovery().catch(
      () => null
    );
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error(`Invalid dream transaction entry: ${entry.name}`);
      }
      const root = (0, import_node_path6.join)(this.transactionsRoot(), entry.name);
      let manifest;
      try {
        manifest = JSON.parse(
          decodeUtf8(await (0, import_promises2.readFile)((0, import_node_path6.join)(root, "manifest.json")), "dream transaction manifest")
        );
      } catch (error48) {
        if (error48.code === "ENOENT") {
          await (0, import_promises2.rm)(root, { recursive: true, force: true });
          continue;
        }
        throw new Error(`Invalid dream transaction manifest: ${entry.name}`);
      }
      this.validateTransactionManifest(manifest);
      const transaction = { id: manifest.id, root, manifest };
      if (manifest.kind === "commit" && marker?.transactionId === manifest.id) {
        await (0, import_promises2.rm)(root, { recursive: true, force: true });
      } else {
        await this.rollbackTransaction(transaction);
      }
    }
  }
  validateTransactionManifest(manifest) {
    if (manifest.version !== 1 || typeof manifest.id !== "string" || !["commit", "restore", "migration"].includes(manifest.kind) || !Array.isArray(manifest.targets) || manifest.date !== null && typeof manifest.date !== "string") {
      throw new Error("Invalid dream transaction manifest");
    }
    assertSafeId(manifest.id);
    if (manifest.date !== null) assertDiaryDate(manifest.date);
    for (const target of manifest.targets) {
      if (typeof target?.path !== "string" || typeof target.existed !== "boolean") {
        throw new Error("Invalid dream transaction target");
      }
      this.assertTransactionPath(target.path);
    }
  }
  assertTransactionPath(path2) {
    if (path2.includes("\0") || path2.startsWith("/") || !path2.startsWith("memory/") && !path2.startsWith("diary/") || !isWithin((0, import_node_path6.resolve)(this.dataRoot), (0, import_node_path6.resolve)(this.dataRoot, path2))) {
      throw new Error(`Invalid dream transaction path: ${path2}`);
    }
  }
  async writeSuccessMarker(date5, transactionId) {
    const previous = await this.readSuccessMarkerWithoutRecovery();
    const lastSuccessfulDate = previous !== null && previous.lastSuccessfulDate > date5 ? previous.lastSuccessfulDate : date5;
    await this.writeAtomically(
      this.successMarkerPath(),
      encoder.encode(
        `${JSON.stringify({
          last_successful_date: lastSuccessfulDate,
          transaction_id: transactionId
        }, null, 2)}
`
      )
    );
  }
  async readLastSuccessfulDateWithoutRecovery() {
    return (await this.readSuccessMarkerWithoutRecovery())?.lastSuccessfulDate ?? null;
  }
  async readSuccessMarkerWithoutRecovery() {
    try {
      const value = JSON.parse(
        decodeUtf8(await (0, import_promises2.readFile)(this.successMarkerPath()), "dream success marker")
      );
      if (typeof value.last_successful_date !== "string" || typeof value.transaction_id !== "string") {
        throw new Error("Invalid dream success marker");
      }
      assertDiaryDate(value.last_successful_date);
      assertSafeId(value.transaction_id);
      return {
        lastSuccessfulDate: value.last_successful_date,
        transactionId: value.transaction_id
      };
    } catch (error48) {
      if (error48.code === "ENOENT") return null;
      throw error48;
    }
  }
  serializeMigrationState(requiresFullFill) {
    return `${JSON.stringify({
      version: 1,
      requires_full_fill: requiresFullFill
    }, null, 2)}
`;
  }
  async readMigrationStateWithoutRecovery() {
    try {
      const value = JSON.parse(
        decodeUtf8(await (0, import_promises2.readFile)(this.migrationStatePath()), "dream migration state")
      );
      if (value.version !== 1 || typeof value.requires_full_fill !== "boolean") {
        throw new Error("Invalid dream migration state");
      }
      return value;
    } catch (error48) {
      if (error48.code === "ENOENT") return null;
      throw error48;
    }
  }
  async publishMigrationDocumentsAtomically(documents, requiresFullFill) {
    assertParseableMarkdown("userProfile", documents.userProfile);
    assertParseableMarkdown("archive", documents.archive);
    const transaction = await this.prepareTransaction("migration", null, {
      "memory/user-profile.md": documents.userProfile,
      "memory/archive.md": documents.archive,
      "memory/migration-state.json": this.serializeMigrationState(requiresFullFill)
    });
    await this.executeTransaction(
      transaction,
      "Memory migration failed and rollback could not complete"
    );
  }
  async loadLegacyCurrentPersona() {
    const personaRoot = (0, import_node_path6.join)(this.dataRoot, "persona");
    await this.assertLegacyPersonaRootIsSafe();
    const currentBytes = await this.readLegacyFile(
      (0, import_node_path6.join)(personaRoot, "CURRENT"),
      "persona CURRENT"
    );
    let current;
    try {
      current = JSON.parse(
        decodeUtf8(currentBytes, "legacy persona CURRENT")
      );
    } catch {
      throw new LegacyPersonaUnavailableError("Invalid legacy persona CURRENT manifest");
    }
    if (!Number.isSafeInteger(current.generation) || current.generation < 1) {
      throw new LegacyPersonaUnavailableError("Invalid legacy persona CURRENT generation");
    }
    const generationRoot = (0, import_node_path6.join)(
      personaRoot,
      "generations",
      String(current.generation)
    );
    const [manifestBytes, profileBytes, experienceBytes] = await Promise.all([
      this.readLegacyFile((0, import_node_path6.join)(generationRoot, "manifest.json"), "generation manifest"),
      this.readLegacyFile((0, import_node_path6.join)(generationRoot, "user-profile.md"), "user profile"),
      this.readLegacyFile((0, import_node_path6.join)(generationRoot, "experience.md"), "experience")
    ]);
    if (manifestBytes.length !== currentBytes.length || !manifestBytes.every((byte, index) => byte === currentBytes[index])) {
      throw new LegacyPersonaUnavailableError(
        "Legacy persona generation manifest does not match CURRENT"
      );
    }
    if (!/^[a-f0-9]{64}$/.test(current.user_profile_sha256 ?? "") || sha256(profileBytes) !== current.user_profile_sha256 || !/^[a-f0-9]{64}$/.test(current.experience_sha256 ?? "") || sha256(experienceBytes) !== current.experience_sha256) {
      throw new LegacyPersonaUnavailableError("Legacy persona generation hash mismatch");
    }
    let userProfile;
    let experience;
    try {
      userProfile = decodeUtf8(profileBytes, "legacy persona user profile");
      experience = decodeUtf8(experienceBytes, "legacy persona experience");
    } catch (error48) {
      throw new LegacyPersonaUnavailableError(
        error48 instanceof Error ? error48.message : "Invalid legacy persona UTF-8"
      );
    }
    if (!parseMarkdownSections(userProfile).some((section) => section.level >= 1)) {
      throw new LegacyPersonaUnavailableError("Legacy user profile is not parseable Markdown");
    }
    if (!parseMarkdownSections(experience).some((section) => section.level >= 1)) {
      throw new LegacyPersonaUnavailableError("Legacy experience is not parseable Markdown");
    }
    return {
      generation: current.generation,
      documents: {
        userProfile,
        archive: EMPTY_ARCHIVE_DOCUMENT
      }
    };
  }
  async retireLegacyPersonaLayout() {
    const personaRoot = (0, import_node_path6.join)(this.dataRoot, "persona");
    await this.assertLegacyPersonaRootIsSafe();
    await (0, import_promises2.rm)((0, import_node_path6.join)(personaRoot, "generations"), { recursive: true, force: true });
    await (0, import_promises2.unlink)((0, import_node_path6.join)(personaRoot, "CURRENT")).catch((error48) => {
      if (error48.code !== "ENOENT") throw error48;
    });
    if (await this.pathExists(personaRoot)) {
      await this.syncDirectory(personaRoot);
    }
  }
  async assertLegacyPersonaRootIsSafe() {
    const personaRoot = (0, import_node_path6.join)(this.dataRoot, "persona");
    try {
      const metadata = await (0, import_promises2.lstat)(personaRoot);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error(`Legacy persona root must be a real directory: ${personaRoot}`);
      }
    } catch (error48) {
      if (error48.code === "ENOENT") return;
      throw error48;
    }
  }
  async readLegacyFile(path2, label) {
    try {
      const metadata = await (0, import_promises2.lstat)(path2);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new LegacyPersonaUnavailableError(
          `Legacy ${label} is not a regular file`
        );
      }
      return await (0, import_promises2.readFile)(path2);
    } catch (error48) {
      if (error48 instanceof LegacyPersonaUnavailableError) throw error48;
      const code = error48.code;
      if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") {
        throw new LegacyPersonaUnavailableError(`Legacy ${label} is unavailable`);
      }
      throw error48;
    }
  }
  async pathExists(path2) {
    try {
      await (0, import_promises2.lstat)(path2);
      return true;
    } catch (error48) {
      if (error48.code === "ENOENT") return false;
      throw error48;
    }
  }
  async writeFileSynced(path2, bytes) {
    await (0, import_promises2.mkdir)((0, import_node_path6.dirname)(path2), { recursive: true });
    const file2 = await (0, import_promises2.open)(path2, "wx");
    try {
      await file2.writeFile(bytes);
      await file2.sync();
    } finally {
      await file2.close();
    }
  }
  async writeAtomically(path2, bytes) {
    await this.assertFileIsSafe(path2);
    const parent = (0, import_node_path6.dirname)(path2);
    const temporary = (0, import_node_path6.join)(
      parent,
      `.${(0, import_node_path6.basename)(path2)}.${process.pid}.${(0, import_node_crypto.randomUUID)()}.tmp`
    );
    await (0, import_promises2.mkdir)(parent, { recursive: true });
    try {
      await this.writeFileSynced(temporary, bytes);
      await (0, import_promises2.rename)(temporary, path2);
      await this.syncDirectory(parent);
    } catch (error48) {
      await (0, import_promises2.unlink)(temporary).catch(() => void 0);
      throw error48;
    }
  }
  async syncDirectory(path2) {
    const directory = await (0, import_promises2.open)(path2, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
};

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
    case "PreToolUse":
    case "PostToolUse":
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
    agentId: getString(raw, ["agent_id", "agentId"]),
    cwd: getString(raw, ["cwd", "workspace_path", "workspacePath"]),
    prompt: getString(raw, ["prompt", "user_prompt", "userPrompt"]),
    toolName: getString(raw, ["tool_name", "toolName"]),
    toolUseId: getString(raw, ["tool_use_id", "toolUseId"]),
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
    transcript_path AS transcriptPath,
    title,
    content,
    insight,
    next_steps AS nextSteps,
    decision,
    done,
    "current" AS current,
    "reference" AS reference,
    last_compact_turn AS lastCompactTurn,
    summary_updated_at_epoch AS summaryUpdatedAtEpoch,
    scan_cursor_byte_offset AS scanCursorByteOffset,
    scan_cursor_line AS scanCursorLine,
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
        transcript_path,
        title,
        content,
        insight,
        next_steps,
        last_compact_turn,
        summary_updated_at_epoch,
        created_at_epoch,
        updated_at_epoch,
        completed_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(content_session_id) DO UPDATE SET
        project = excluded.project,
        -- First-non-NULL, and deliberately the reverse of project's
        -- last-writer-wins: the transcript directory is fixed at the session's
        -- STARTING cwd, so a later upsert from a different cwd must not move it.
        transcript_path = COALESCE(sessions.transcript_path, excluded.transcript_path),
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
        transcript_path AS transcriptPath,
        title,
        content,
        insight,
        next_steps AS nextSteps,
        decision,
        done,
        "current" AS current,
        "reference" AS reference,
        last_compact_turn AS lastCompactTurn,
            summary_updated_at_epoch AS summaryUpdatedAtEpoch,
        scan_cursor_byte_offset AS scanCursorByteOffset,
        scan_cursor_line AS scanCursorLine,
        parent_session_id AS parentSessionId,
        lineage_status AS lineageStatus,
        created_at_epoch AS createdAtEpoch,
        updated_at_epoch AS updatedAtEpoch,
        completed_at_epoch AS completedAtEpoch
    `).get(
    input.contentSessionId,
    input.project,
    input.transcriptPath ?? null,
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
function compareAndSetScanCursor(db, sessionId, byteOffset, lineNumber, observedByteOffset) {
  const result = db.query(
    `UPDATE sessions
       SET scan_cursor_byte_offset = ?,
           scan_cursor_line = ?
       WHERE id = ?
         AND scan_cursor_byte_offset = ?`
  ).run(byteOffset, lineNumber, sessionId, observedByteOffset);
  return result.changes > 0;
}
function updateSessionScanCursor(db, sessionId, byteOffset, lineNumber, observedByteOffset) {
  return compareAndSetScanCursor(
    db,
    sessionId,
    byteOffset,
    lineNumber,
    observedByteOffset
  );
}
function rewindSessionScanCursor(db, sessionId, byteOffset, lineNumber, observedByteOffset) {
  return compareAndSetScanCursor(
    db,
    sessionId,
    byteOffset,
    lineNumber,
    observedByteOffset
  );
}
function setSessionTranscriptPathIfAbsent(db, sessionId, transcriptPath) {
  return db.query(
    `UPDATE sessions
         SET transcript_path = ?
         WHERE id = ? AND transcript_path IS NULL`
  ).run(transcriptPath, sessionId).changes > 0;
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
var import_node_fs4 = require("node:fs");
var import_node_path7 = require("node:path");

// src/shared/build-id.ts
var BUILD_ID = true ? "0.10.0-msu9xw9c" : "dev";

// src/mnemosyne/env.ts
var CAPTURED_SESSION_ENV_KEYS = [
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "NODE_EXTRA_CA_CERTS",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "http_proxy",
  "HTTP_PROXY",
  "https_proxy",
  "HTTPS_PROXY",
  "all_proxy",
  "ALL_PROXY",
  "no_proxy",
  "NO_PROXY"
];
function captureSessionEnv(sourceEnv = process.env) {
  const captured = {};
  for (const key of CAPTURED_SESSION_ENV_KEYS) {
    const value = sourceEnv[key];
    if (value !== void 0) {
      captured[key] = value;
    }
  }
  return captured;
}

// src/worker/client.ts
var WORKER_PORT = 37778;
var WORKER_BASE_URL = `http://127.0.0.1:${WORKER_PORT}`;
var WAKE_TIMEOUT_MS = 500;
var FLUSH_TIMEOUT_MS = 500;
var COMPACT_TIMEOUT_MS = 5e3;
function buildWorkerTriggerPayload(input, env = process.env) {
  return {
    action: input.action,
    content_session_id: input.contentSessionId,
    ...input.sessionDbId === void 0 ? {} : { session_id: input.sessionDbId },
    ...input.transcriptPath === void 0 ? {} : { transcript_path: input.transcriptPath },
    env: captureSessionEnv(env)
  };
}
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
  const currentDir = (0, import_node_path7.dirname)(__filename);
  if (currentDir.endsWith("/plugin/scripts") || currentDir.endsWith("\\plugin\\scripts")) {
    return (0, import_node_path7.resolve)(currentDir, "..");
  }
  return (0, import_node_path7.resolve)(currentDir, "..", "..", "plugin");
}
function resolveWorkerScriptPaths(env = process.env) {
  const pluginRoot = resolvePluginRoot(env);
  return {
    bunRunnerPath: (0, import_node_path7.join)(pluginRoot, "scripts", "bun-runner.js"),
    workerPath: (0, import_node_path7.join)(pluginRoot, "scripts", "worker.cjs")
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
  const existsSyncImpl = deps.existsSyncImpl ?? import_node_fs4.existsSync;
  if (!existsSyncImpl(pidPath)) {
    return null;
  }
  try {
    const pid = Number((0, import_node_fs4.readFileSync)(pidPath, "utf8").trim());
    if (Number.isInteger(pid) && pid > 0) {
      return pid;
    }
  } catch {
  }
  return null;
}
function killWorkerPid(pid, killImpl = process.kill) {
  try {
    killImpl(pid, "SIGTERM");
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
  const existsSyncImpl = deps.existsSyncImpl ?? import_node_fs4.existsSync;
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
async function notifyWorkerFlush(sessionDbId, contentSessionId, deps = {}, env = process.env) {
  await notifyWorkerTrigger(
    { action: "finish", contentSessionId, sessionDbId },
    deps,
    env,
    FLUSH_TIMEOUT_MS
  );
}
async function notifyWorkerCompact(sessionDbId, contentSessionId, transcriptPath, deps = {}, env = process.env) {
  await notifyWorkerTrigger(
    {
      action: "compact",
      contentSessionId,
      sessionDbId,
      transcriptPath
    },
    deps,
    env,
    COMPACT_TIMEOUT_MS,
    true
  );
}
async function notifyWorkerTrigger(input, deps = {}, env = process.env, timeoutMs = WAKE_TIMEOUT_MS, throwOnFailure = false) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const status = await ensureCompatibleWorker(deps);
  if (status === "unrecoverable-stale") {
    logUnrecoverableStaleWorker();
    if (throwOnFailure) {
      throw new Error("Stale worker detected but no pid handle is available for restart.");
    }
    return;
  }
  if (status === "down") {
    spawnWorkerProcess(deps, env);
    const ready = await waitForCompatibleWorker(deps);
    if (!ready) {
      if (throwOnFailure) {
        throw new Error("Worker did not become ready before trigger request.");
      }
      return;
    }
  }
  try {
    const response = await fetchImpl(`${WORKER_BASE_URL}/trigger`, {
      method: "POST",
      body: JSON.stringify(buildWorkerTriggerPayload(input, env)),
      signal: createAbortSignal(timeoutMs)
    });
    if (!response.ok && throwOnFailure) {
      throw new Error(`Worker trigger request failed with status ${response.status}.`);
    }
  } catch (error48) {
    if (throwOnFailure) {
      throw error48;
    }
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
      session.contentSessionId,
      input.transcriptPath,
      dependencies.workerClientDeps,
      dependencies.workerEnv
    );
    return { continue: true };
  };
}

// src/hooks/handlers/context.ts
var import_node_path12 = require("node:path");

// src/shared/file-tree.ts
var import_node_path8 = __toESM(require("node:path"), 1);
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
  for (const file2 of [...node.files].sort((left, right) => left.localeCompare(right))) {
    lines.push(`${indent}  ${file2}`);
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
    const relative2 = import_node_path8.default.posix.relative(root, value);
    if (!relative2 || relative2 === "") {
      continue;
    }
    const segments = relative2.split("/").filter(Boolean);
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
  for (const file2 of [...tree.files].sort((left, right) => left.localeCompare(right))) {
    lines.push(file2);
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

// src/mcp/tool-projection.ts
var AGENT_REPORT_ELSEWHERE = "report not stored with this call \u2014 it arrives later as a turn-level notification";
function parsePayload(raw) {
  if (raw === null || raw === void 0 || raw.trim() === "") {
    return void 0;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
function asRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}
function stringField(record2, key) {
  const value = record2?.[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}
function numberField(record2, key) {
  const value = record2?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function toLines(text) {
  return text.split("\n").map((line) => line.replace(/\s+$/u, "")).filter((line) => line !== "");
}
var LINE_BREAK_MARK = "\u21B5";
function singleLine(text) {
  return text.split("\n").map((line) => line.replace(/\s+/gu, " ").trim()).filter((line) => line !== "").join(LINE_BREAK_MARK);
}
function basename2(filePath) {
  const segments = filePath.split("/").filter((segment) => segment !== "");
  return segments[segments.length - 1] ?? filePath;
}
function contentArrayText(value) {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  const texts = [];
  for (const item of value) {
    const record2 = asRecord(item);
    if (!record2 || typeof record2.text !== "string") {
      return null;
    }
    texts.push(record2.text);
  }
  return texts.join("\n");
}
function isEmptyValue(value) {
  if (value === null || value === void 0 || value === false || value === "") {
    return true;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  const record2 = asRecord(value);
  return record2 !== null && Object.keys(record2).length === 0;
}
function valueText(value) {
  return typeof value === "string" ? value : JSON.stringify(value) ?? "";
}
function genericLines(value) {
  if (value === void 0) {
    return [];
  }
  const unwrapped = contentArrayText(value);
  if (unwrapped !== null) {
    return toLines(unwrapped);
  }
  if (typeof value === "string") {
    return toLines(value);
  }
  const record2 = asRecord(value);
  if (record2) {
    const entries = Object.entries(record2).filter(
      ([, entryValue]) => !isEmptyValue(entryValue)
    );
    if (entries.length === 0) {
      return [];
    }
    if (entries.length === 1) {
      return toLines(valueText(entries[0][1]));
    }
    return entries.map(
      ([key, entryValue]) => `${key}: ${singleLine(valueText(entryValue))}`
    );
  }
  return isEmptyValue(value) ? [] : toLines(valueText(value));
}
function genericDetail(input, result) {
  return {
    // Joined by the line mark for the reason `singleLine` carries one: these
    // were separate lines or separate fields, and a space claims they were one.
    argument: genericLines(input).map(singleLine).join(LINE_BREAK_MARK),
    body: genericLines(result)
  };
}
var PROJECTION_RULES = {
  /**
   * 61% of every observation recorded since the cutover. Header from the input,
   * body from the result — the case the header/body interface exists for.
   * `description` is left out: it restates the command that is already there.
   */
  Bash: (input, result) => {
    const command = stringField(asRecord(input), "command");
    if (!command) {
      return null;
    }
    const output = asRecord(result);
    const stdout = output && typeof output.stdout === "string" ? output.stdout : null;
    const stderr = output && typeof output.stderr === "string" ? output.stderr : "";
    if (stdout === null && stderr === "") {
      return { argument: singleLine(command), body: genericLines(result) };
    }
    const body = toLines(stdout ?? "");
    if (stderr.trim() !== "") {
      body.push(`stderr: ${singleLine(stderr)}`);
    }
    return { argument: singleLine(command), body };
  },
  /**
   * The single largest saving in the change. An `Edit` result is a verbatim
   * duplicate of its input — `oldString`/`newString`/`filePath` matched in 62 of
   * 62 sampled rows — plus `originalFile`, the entire pre-edit file, at a median
   * of 23,494 characters against `old_string`'s median of 172. It therefore
   * contributes nothing: everything worth reading is in the call.
   */
  Edit: (input) => {
    const record2 = asRecord(input);
    const filePath = stringField(record2, "file_path");
    const oldString = record2 && typeof record2.old_string === "string" ? record2.old_string : null;
    const newString = record2 && typeof record2.new_string === "string" ? record2.new_string : null;
    if (!filePath || oldString === null || newString === null) {
      return null;
    }
    return {
      argument: basename2(filePath),
      body: [
        ...toLines(oldString).map((line) => `- ${line}`),
        ...toLines(newString).map((line) => `+ ${line}`)
      ]
    };
  },
  /**
   * Body from the input, which is also what makes a create render correctly:
   * `originalFile` is `null` on 24 of 30 sampled rows, so anything reaching for
   * the pre-edit file renders empty on the majority case.
   */
  Write: (input) => {
    const record2 = asRecord(input);
    const filePath = stringField(record2, "file_path");
    const content = record2 && typeof record2.content === "string" ? record2.content : null;
    if (!filePath || content === null) {
      return null;
    }
    return { argument: basename2(filePath), body: toLines(content) };
  },
  /**
   * The one tool whose result is pure bulk relative to its call: the input is a
   * median 98 characters and the result a median 1,366, all of it the file slice
   * the reader already has in context from the read itself. What they do not
   * have is which part of the file it was.
   */
  Read: (input, result) => {
    const filePath = stringField(asRecord(input), "file_path");
    if (!filePath) {
      return null;
    }
    const file2 = asRecord(asRecord(result)?.file);
    const numLines = numberField(file2, "numLines");
    if (numLines === null) {
      return null;
    }
    const startLine = numberField(file2, "startLine");
    const totalLines = numberField(file2, "totalLines");
    const range = startLine === null ? null : `${startLine}\u2013${startLine + numLines - 1}${totalLines === null ? "" : ` of ${totalLines}`}`;
    return {
      argument: basename2(filePath),
      body: [range === null ? `${numLines} lines` : `${numLines} lines (${range})`]
    };
  },
  /**
   * The task's own description, never the prompt — the prompt is a median 2,923
   * characters of instructions the reader wrote and does not need read back.
   * The result is genuinely two shapes gated on how the agent was dispatched.
   */
  Agent: (input, result) => {
    const description = stringField(asRecord(input), "description");
    if (!description) {
      return null;
    }
    const record2 = asRecord(result);
    const report = contentArrayText(record2?.content);
    if (report !== null) {
      return { argument: description, body: toLines(report) };
    }
    return stringField(record2, "status") === "async_launched" ? { argument: description, body: [AGENT_REPORT_ELSEWHERE] } : { argument: description, body: genericLines(result) };
  },
  /**
   * Keyed on the whole tool name, server prefix included, because that is what
   * says whose payload this is. `note` is a common enough word that another
   * server will have one, and a rule matched on the trailing segment handed
   * `mcp__other_server__note` this projection — which reads its `turn` and its
   * `title` and drops everything else, exactly the "keyed on a name rather than
   * on the tool" error the survey's key-collision evidence forbids. The cost is
   * that a marketplace rename stops matching; what happens then is the generic
   * rule, verbose and true, which is the trade this projection makes everywhere
   * else too.
   *
   * The call's point is which turn it wrote about and what it claimed; the note
   * body itself is a median 1,170 characters that the turn's own fields carry.
   */
  "mcp__plugin_claude-mnemo_mnemo__note": (input, result) => {
    const record2 = asRecord(input);
    const turn = stringField(record2, "turn");
    const title = stringField(record2, "title");
    if (!turn) {
      return null;
    }
    const receipt = contentArrayText(result);
    return {
      argument: [turn, title].filter(Boolean).join(" "),
      body: receipt === null ? genericLines(result) : toLines(receipt)
    };
  }
};
function composeHeader(toolName, argument) {
  if (!toolName) {
    return argument;
  }
  return argument ? `${toolName}(${argument})` : toolName;
}
function projectToolCall(toolName, toolInput, toolResult) {
  const input = parsePayload(toolInput);
  const result = parsePayload(toolResult);
  const rule = PROJECTION_RULES[toolName];
  const detail = (rule ? rule(input, result) : null) ?? genericDetail(input, result);
  return { header: composeHeader(toolName, detail.argument), body: detail.body };
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
var FIELD_TRUNCATION_SUFFIX = "\u2026";
var DEFAULT_TRUNCATE = 200;
var MAX_TRUNCATE = 2e3;
var DEFAULT_PREVIEW_COUNT = 5;
function createTruncationSignal() {
  return { truncated: false };
}
function markTruncated(signal) {
  if (signal) {
    signal.truncated = true;
  }
}
var NAVIGATION_LEGEND = 'Legend: text ending in an ellipsis was truncated \u2014 read it in full with the mnemo-replay skill, addressing it by the bracketed ids on that line; a "+N more" count is reachable with timeline(id="S<n>", view="turns").';
function appendNavigationLegend(output, signal) {
  if (!signal.truncated) {
    return output;
  }
  return output ? `${output}

${NAVIGATION_LEGEND}` : NAVIGATION_LEGEND;
}
function formatEpoch(epoch) {
  const date5 = new Date(epoch * 1e3);
  const year = date5.getUTCFullYear();
  const month = String(date5.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date5.getUTCDate()).padStart(2, "0");
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
function collapseToSingleLine(text) {
  return text.replace(/\s+/g, " ").trim();
}
function truncateText(text, {
  limit,
  signal
}) {
  const boundedLimit = Math.max(limit, 1);
  if (text.length <= boundedLimit) {
    return text;
  }
  markTruncated(signal);
  const window = text.slice(0, boundedLimit);
  if (/\s/.test(text.charAt(boundedLimit))) {
    return `${window}${FIELD_TRUNCATION_SUFFIX}`;
  }
  const wordEnd = window.lastIndexOf(" ");
  if (wordEnd >= boundedLimit * 0.8) {
    return `${window.slice(0, wordEnd)}${FIELD_TRUNCATION_SUFFIX}`;
  }
  return `${window}${FIELD_TRUNCATION_SUFFIX}`;
}
function truncateLines(lines, {
  limit,
  signal,
  lineLimit
}) {
  const boundedLimit = Math.max(limit, 1);
  const content = lines.filter((line) => line.trim() !== "");
  const kept = [];
  let used = 0;
  for (const line of content) {
    const capped = lineLimit === void 0 ? line : truncateText(line, { limit: lineLimit, signal });
    const nextUsed = used + capped.length + (kept.length > 0 ? 1 : 0);
    if (kept.length > 0 && nextUsed > boundedLimit) {
      break;
    }
    kept.push(capped);
    used = nextUsed;
  }
  const omitted = content.length - kept.length;
  if (omitted <= 0) {
    return kept;
  }
  markTruncated(signal);
  return [...kept, `${FIELD_TRUNCATION_SUFFIX} +${omitted} lines`];
}
function truncateCallHeader(header, { limit, signal }) {
  if (header.length <= limit) {
    return header;
  }
  const open2 = header.indexOf("(");
  if (open2 <= 0 || !header.endsWith(")")) {
    return truncateText(header, { limit, signal });
  }
  const toolName = header.slice(0, open2);
  const argument = header.slice(open2 + 1, -1);
  const argumentBudget = limit - toolName.length - 3;
  if (argumentBudget < 1) {
    markTruncated(signal);
    return toolName;
  }
  return `${toolName}(${truncateText(argument, { limit: argumentBudget, signal })})`;
}
function resolveExplicitTruncate(truncate, truncateCap = MAX_TRUNCATE) {
  return Math.min(Math.max(truncate ?? DEFAULT_TRUNCATE, 1), truncateCap);
}
function formatStatus(status) {
  return status ? ` [${status}]` : "";
}
function extractKeyParam(name, input) {
  if (!input || typeof input !== "object") {
    return null;
  }
  const record2 = input;
  const valueForKey = (...keys) => {
    for (const key of keys) {
      const value = record2[key];
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
      for (const value of Object.values(record2)) {
        if (typeof value === "string" && value.trim() !== "") {
          return value;
        }
      }
      return null;
  }
}
function formatSessionCollapsedWithMode(session, mode, truncate, truncateCap, signal) {
  const limit = resolveExplicitTruncate(truncate, truncateCap);
  const stats = formatSessionStats(session);
  const statsSegment = stats ? ` | ${stats}` : "";
  const lines = [
    `- [S${session.id}] ${session.title ?? "Untitled"}${statsSegment} | ${formatEpoch(session.createdAtEpoch)} | ${session.project}`
  ];
  if (session.content) {
    lines.push(
      `  - desc: ${truncateText(session.content, { limit, signal })}`
    );
  }
  return lines.join("\n");
}
function formatSessionExpandedWithMode(session, mode, truncate, truncateCap, signal) {
  const limit = resolveExplicitTruncate(truncate, truncateCap);
  const lines = [
    formatSessionCollapsedWithMode(session, mode, truncate, truncateCap, signal)
  ];
  const pushField = (label, value) => {
    if (!value) {
      return;
    }
    lines.push(`  - ${label}: ${truncateText(value, { limit, signal })}`);
  };
  const pushBulletField = (label, value) => {
    if (!value) {
      return;
    }
    const items = splitBulletField(truncateText(value, { limit, signal }));
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
      session.insight.map((line) => truncateText(line, { limit, signal }))
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
  depth = "collapsed",
  truncate,
  truncateCap,
  includeDbTurnIds = false,
  signal
} = {}) {
  const turnId = turn.transcriptLineStart === null ? `T${turn.promptNumber}` : `T${turn.promptNumber}:L${turn.transcriptLineStart}`;
  const prefix = sessionId === void 0 ? `${indent}- [${turnId}]` : `${indent}- [S${sessionId}][${turnId}]`;
  const stats = formatTurnStats(turn);
  const statsSegment = stats ? ` | ${stats}` : "";
  const rawTitle = turn.title ?? turn.promptPreview ?? "Untitled";
  const limit = resolveExplicitTruncate(truncate, truncateCap);
  const title = turn.title === null && turn.promptPreview ? (
    // The title slot is one line by construction. A prompt standing in for
    // a missing note need not be: a task notification or a pasted payload
    // carries newlines, and they reached the layout intact, spilling one
    // turn's label across four lines. Collapse before measuring, so the
    // truncation budget is spent on content rather than on line breaks.
    `"${truncateText(collapseToSingleLine(turn.promptPreview), {
      limit,
      signal
    })}"`
  ) : truncateText(rawTitle, { limit, signal });
  const dbIdSegment = includeDbTurnIds ? ` dbid:T${turn.id}` : "";
  return `${prefix} ${title}${statsSegment}${formatStatus(turn.status)}${dbIdSegment}`;
}
function formatTurnCollapsedWithMode(turn, options = {}) {
  const { indent = "  ", mode = "legacy", signal } = options;
  const limit = resolveExplicitTruncate(options.truncate, options.truncateCap);
  const lines = [
    formatTurnLabel(turn, {
      ...options,
      mode,
      depth: "collapsed"
    })
  ];
  if (turn.content) {
    lines.push(
      `${indent}  - desc: ${truncateText(turn.content, { limit, signal })}`
    );
  }
  return lines.join("\n");
}
function formatToolCallLabel(toolCall, { indent = "    ", truncate, truncateCap, signal } = {}) {
  const limit = resolveExplicitTruncate(truncate, truncateCap);
  const keyParam = toolCall.keyParam ?? extractKeyParam(toolCall.name, toolCall.input);
  const suffix = keyParam ? ` ${truncateText(keyParam, { limit, signal })}` : "";
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
  const { indent = "    ", truncate, signal } = options;
  const limit = resolveExplicitTruncate(truncate, options.truncateCap);
  const detailIndent = `${indent}  `;
  const lines = [
    formatToolCallLabel(toolCall, {
      ...options,
      depth: "expanded",
      truncate
    })
  ];
  if (toolCall.input !== void 0) {
    lines.push(
      `${detailIndent}- in: ${truncateText(JSON.stringify(toolCall.input), {
        limit,
        signal
      })}`
    );
  }
  if (toolCall.result) {
    lines.push(
      `${detailIndent}- out: ${truncateText(toolCall.result, { limit, signal })}`
    );
  }
  return lines.join("\n");
}
function renderTurnChildren(turn, depth, options = {}) {
  if (depth === "collapsed") {
    return "";
  }
  const { indent = "  ", sessionId, mode = "legacy", truncate, signal } = options;
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
          truncate,
          signal
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
          truncate,
          signal
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
    includeChildren = mode === "unified",
    signal
  } = options;
  const detailIndent = `${indent}  `;
  const limit = resolveExplicitTruncate(options.truncate, options.truncateCap);
  const lines = [formatTurnCollapsedWithMode(turn, { ...options, mode })];
  if (turn.promptPreview) {
    lines.push(
      `${detailIndent}- prompt: "${truncateText(collapseToSingleLine(turn.promptPreview), { limit, signal })}"`
    );
  }
  if (turn.responsePreview) {
    lines.push(
      `${detailIndent}- response: "${truncateText(collapseToSingleLine(turn.responsePreview), { limit, signal })}"`
    );
  }
  if (turn.insight && turn.insight.length > 0) {
    lines.push(`${detailIndent}- insight:`);
    pushBullets(
      lines,
      `${detailIndent}  `,
      turn.insight.map((line) => truncateText(line, { limit, signal }))
    );
  }
  if (mode === "unified" && turn.filesRead && turn.filesRead.length > 0) {
    lines.push(`${detailIndent}- files_read:`);
    pushBullets(
      lines,
      `${detailIndent}  `,
      truncateLines(renderFileTree(turn.filesRead).split("\n"), { limit, signal })
    );
  }
  if (mode === "unified" && turn.filesModified && turn.filesModified.length > 0) {
    lines.push(`${detailIndent}- files_modified:`);
    pushBullets(
      lines,
      `${detailIndent}  `,
      truncateLines(renderFileTree(turn.filesModified).split("\n"), {
        limit,
        signal
      })
    );
  }
  const childBlock = includeChildren ? renderTurnChildren(turn, depth, { ...options, mode }) : "";
  if (childBlock) {
    lines.push(childBlock);
  }
  return lines.join("\n");
}
function formatObservationLabel(observation, { indent = "" } = {}, header) {
  return `${indent}- [O${observation.id}] ${header ?? observation.title}`;
}
var OBSERVATION_BODY_INDENT = "    ";
function projectObservation(observation) {
  if (!observation.toolInput && !observation.toolResult) {
    return null;
  }
  return projectToolCall(
    observation.toolName ?? "",
    observation.toolInput,
    observation.toolResult
  );
}
function formatObservationCollapsedWithMode(observation, options = {}) {
  const { indent = "", signal } = options;
  const limit = resolveExplicitTruncate(options.truncate, options.truncateCap);
  const projection = projectObservation(observation);
  const headerIsLabel = projection !== null && observation.title === observation.toolName;
  const lines = [
    formatObservationLabel(
      observation,
      options,
      headerIsLabel ? truncateCallHeader(projection.header, { limit, signal }) : void 0
    )
  ];
  if (observation.content) {
    lines.push(
      `${indent}  - desc: ${truncateText(observation.content, { limit, signal })}`
    );
  }
  const toolLine = projection ? headerIsLabel ? null : projection.header : observation.toolName && observation.toolName !== observation.title ? observation.toolName : null;
  if (toolLine) {
    lines.push(
      `${indent}  - tool: \u{1F527} ${truncateCallHeader(toolLine, { limit, signal })}`
    );
  }
  if (projection) {
    for (const line of truncateLines(projection.body, {
      limit,
      signal,
      lineLimit: limit
    })) {
      lines.push(`${indent}${OBSERVATION_BODY_INDENT}${line}`);
    }
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
  const effectiveOptions = options;
  switch (node.type) {
    case "session":
      return effectiveOptions.depth === "collapsed" ? formatSessionCollapsedWithMode(
        node.value,
        mode,
        effectiveOptions.truncate,
        effectiveOptions.truncateCap,
        effectiveOptions.signal
      ) : formatSessionExpandedWithMode(
        node.value,
        mode,
        effectiveOptions.truncate,
        effectiveOptions.truncateCap,
        effectiveOptions.signal
      );
    case "turn":
      return effectiveOptions.depth === "collapsed" ? formatTurnCollapsedWithMode(node.value, { ...effectiveOptions, mode }) : formatTurnExpandedWithMode(node.value, { ...effectiveOptions, mode });
    case "observation":
      return effectiveOptions.depth === "collapsed" ? formatObservationCollapsedWithMode(node.value, { ...effectiveOptions, mode }) : formatObservationExpandedWithMode(node.value, { ...effectiveOptions, mode });
    case "toolCall":
      return effectiveOptions.depth === "collapsed" ? formatToolCallCollapsedWithMode(node.value, { ...effectiveOptions, mode }) : formatToolCallExpandedWithMode(node.value, { ...effectiveOptions, mode });
  }
}

// src/diary/calendar.ts
var dateFormatters = /* @__PURE__ */ new Map();
function dateFormatter(timeZone) {
  let formatter = dateFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    });
    dateFormatters.set(timeZone, formatter);
  }
  return formatter;
}
function partNumber(parts, type) {
  const value = parts.find((part) => part.type === type)?.value;
  if (value === void 0) throw new Error(`Missing ${type} calendar part`);
  return Number.parseInt(value, 10);
}
function calendarDateAt(epochSeconds, timeZone) {
  const parts = dateFormatter(timeZone).formatToParts(epochSeconds * 1e3);
  const year = String(partNumber(parts, "year")).padStart(4, "0");
  const month = String(partNumber(parts, "month")).padStart(2, "0");
  const day = String(partNumber(parts, "day")).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
function contentDateAt(epochSeconds, timeZone, boundaryHour) {
  return calendarDateAt(epochSeconds - boundaryHour * 3600, timeZone);
}

// src/db/diary-state.ts
function readDreamCalendarBoundary(db) {
  const timeZone = db.query(
    "SELECT value FROM diary_state WHERE key = 'dream_timezone'"
  ).get()?.value ?? DEFAULT_DREAM_AGENT_TIME_ZONE;
  const boundaryHour = Number(
    db.query(
      "SELECT value FROM diary_state WHERE key = 'dream_hour'"
    ).get()?.value ?? DEFAULT_DREAM_AGENT_HOUR
  );
  return { timeZone, boundaryHour };
}
function markSettledDiaryDayStaleForTurn(db, createdAtEpoch) {
  const { timeZone, boundaryHour } = readDreamCalendarBoundary(db);
  const date5 = contentDateAt(createdAtEpoch, timeZone, boundaryHour);
  db.query(
    `UPDATE diary_day_state
     SET needs_regen = 1,
         attempt_count = 0,
         next_attempt_epoch = NULL,
         retry_disposition = NULL,
         last_error = NULL
     WHERE date = ?
       AND settled_at_epoch IS NOT NULL
       AND date >= COALESCE(
         (SELECT value FROM diary_state WHERE key = 'cutover_date'),
         '9999-12-31'
       )`
  ).run(date5);
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
    assistant_transcript AS assistantTranscript,
    title,
    content,
    insight,
    type,
    significance_grade AS significanceGrade,
    tags,
    files_read AS filesRead,
    files_modified AS filesModified,
    tool_call_count AS toolCallCount,
    parent_turn_id AS parentTurnId,
    cites_recorded AS citesRecorded,
    compact_boundary_uuid AS compactBoundaryUuid,
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
    parentTurnId: row.parentTurnId ?? null,
    citesRecorded: row.citesRecorded === 1
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
function resolveNullable(value, existing) {
  return value === void 0 ? existing : value;
}
function updateTurnById(db, turnId, input) {
  const existing = getTurnById(db, turnId);
  if (!existing) {
    return null;
  }
  const mergedTitle = resolveNullable(input.title, existing.title);
  const mergedContent = resolveNullable(input.content, existing.content);
  const mergedInsight = resolveNullable(input.insight, existing.insight);
  const mergedType = resolveNullable(input.type, existing.type);
  const mergedGrade = resolveNullable(
    input.significanceGrade,
    existing.significanceGrade
  );
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
            significance_grade = ?,
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
            assistant_transcript AS assistantTranscript,
            title,
            content,
            insight,
            type,
            significance_grade AS significanceGrade,
            transcript_line_start AS transcriptLineStart,
            tags,
            files_read AS filesRead,
            files_modified AS filesModified,
            tool_call_count AS toolCallCount,
            parent_turn_id AS parentTurnId,
            cites_recorded AS citesRecorded,
            compact_boundary_uuid AS compactBoundaryUuid,
            created_at_epoch AS createdAtEpoch,
            updated_at_epoch AS updatedAtEpoch
        `
    ).get(
      nextStatus,
      input.wasInterrupted ?? existing.wasInterrupted ? 1 : 0,
      input.wasRolledBack ?? existing.wasRolledBack ? 1 : 0,
      mergedTitle,
      mergedContent,
      mergedInsight,
      mergedType,
      mergedGrade,
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
  indexTurnToFTS(db, updated);
  if (existing.status !== updated.status || existing.userPrompt !== updated.userPrompt || existing.assistantResponse !== updated.assistantResponse || existing.title !== updated.title || existing.content !== updated.content || existing.insight !== updated.insight) {
    markSettledDiaryDayStaleForTurn(db, updated.createdAtEpoch);
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
  reindexTurnFromDb(db, turnId);
  if (existing.status !== "active" || existing.title !== null || existing.content !== null || existing.insight !== null) {
    markSettledDiaryDayStaleForTurn(db, existing.createdAtEpoch);
  }
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
function getMaxTurnId(db, sessionId) {
  const row = db.query(
    "SELECT MAX(id) AS max FROM turns WHERE session_id = ?"
  ).get(sessionId);
  return row?.max ?? null;
}
function updateTurnBackfill(db, turnId, assistantResponse, toolCallCount, contentPromptId, transcriptLineStart, assistantTranscript) {
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
         assistant_transcript = COALESCE(?, assistant_transcript),
         tool_call_count = ?,
         content_prompt_id = COALESCE(content_prompt_id, ?),
         transcript_line_start = COALESCE(?, transcript_line_start)
     WHERE id = ?`
  ).run(
    assistantResponse,
    assistantTranscript ?? null,
    toolCallCount,
    safeContentPromptId,
    transcriptLineStart ?? null,
    turnId
  );
  if (existing.assistantResponse !== assistantResponse) {
    markSettledDiaryDayStaleForTurn(db, existing.createdAtEpoch);
  }
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
  return text.replace(TURN_POINTER_PATTERN, (literal2, idDigits) => {
    const turn = getTurnById(db, Number.parseInt(idDigits, 10));
    if (!turn || turn.sessionId !== sessionId || turn.status === "undone") {
      return literal2;
    }
    return `[S${sessionId}/T${turn.promptNumber}] "${turn.title ?? "untitled"}"`;
  });
}

// src/diary/domain.ts
var UTC_PLUS_EIGHT_SECONDS = 8 * 60 * 60;
function estimateDiaryTokens(text) {
  let weightedCodePoints = 0;
  for (const codePoint of text) {
    weightedCodePoints += new RegExp("\\p{Script=Han}", "u").test(codePoint) ? 1.1 : 0.6;
  }
  return Math.ceil(weightedCodePoints * 1.2);
}

// src/mcp/session-output.ts
var CURRENT_SESSION_STATE_TOKEN_BUDGET = 2e3;
function capCodePoints(value, max) {
  if (!value) {
    return value;
  }
  const codePoints = Array.from(value);
  return codePoints.length <= max ? value : `${codePoints.slice(0, Math.max(0, max - 1)).join("")}\u2026`;
}
function buildSessionStateLines(input, capPriorityFields = false, includeHistoricalFields = true) {
  const title = (capPriorityFields ? capCodePoints(input.title, 100) : input.title) ?? "(untitled session)";
  const lines = [
    `[S${input.id}] ${title}`
  ];
  const pushField = (label, value, cap) => {
    const rendered = capPriorityFields && cap ? capCodePoints(value ?? null, cap) : value;
    if (rendered) {
      lines.push(`  ${label}: ${rendered}`);
    }
  };
  const pushBulletField = (label, value) => {
    const items = splitBulletField(value);
    if (items.length === 0) {
      return;
    }
    lines.push(`  ${label}:`);
    for (const item of items) {
      lines.push(`    - ${item}`);
    }
  };
  pushField("content", input.content, 400);
  pushField("current", input.current, 400);
  pushField("next", input.nextSteps, 200);
  if (!includeHistoricalFields) {
    return lines;
  }
  if (input.decision) {
    pushBulletField("decision", input.decision);
  } else if ((input.legacyInsight?.length ?? 0) > 0) {
    lines.push("  insight:");
    for (const item of input.legacyInsight ?? []) {
      lines.push(`    - ${item}`);
    }
  }
  pushBulletField("done", input.done);
  pushBulletField("reference", input.reference);
  return lines;
}
function renderSessionStateOutput(input) {
  return buildSessionStateLines(input).join("\n");
}
function renderBoundedSessionStateOutput(input) {
  const full = renderSessionStateOutput(input);
  if (estimateDiaryTokens(full) <= CURRENT_SESSION_STATE_TOKEN_BUDGET) {
    return full;
  }
  const pointer = `  \u2026 state truncated; full summary: recall(id="S${input.id}")`;
  const uncappedStateLines = buildSessionStateLines(input, false, false);
  const stateFitsUncapped = estimateDiaryTokens([...uncappedStateLines, pointer].join("\n")) <= CURRENT_SESSION_STATE_TOKEN_BUDGET;
  const lines = buildSessionStateLines(input, !stateFitsUncapped);
  const included = [];
  for (let index = 0; index < lines.length; index += 1) {
    const candidate = [
      ...included,
      lines[index],
      pointer
    ].join("\n");
    if (estimateDiaryTokens(candidate) > CURRENT_SESSION_STATE_TOKEN_BUDGET) {
      break;
    }
    included.push(lines[index]);
  }
  const withPointer = [...included, pointer].join("\n");
  if (estimateDiaryTokens(withPointer) <= CURRENT_SESSION_STATE_TOKEN_BUDGET) {
    return withPointer;
  }
  return included.join("\n");
}
function renderCurrentSessionStateOutput(session, sessionRecord) {
  return renderBoundedSessionStateOutput({
    id: sessionRecord.id,
    title: session.title ?? null,
    content: session.content ?? null,
    // context.ts currently resolves pointers on FormattedSession. Read raw
    // storage here so state injection keeps compact [T<n>] coordinates.
    decision: sessionRecord.decision ?? session.decision ?? null,
    done: sessionRecord.done ?? session.done ?? null,
    current: session.current ?? null,
    nextSteps: session.nextSteps ?? null,
    reference: session.reference ?? null,
    legacyInsight: session.insight
  });
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
function recoverStrandedTurns(db, sessionDbId, nowEpoch, eraCutoffEpoch = null) {
  const stranded = getStrandedTurns(db, sessionDbId);
  let recovered = 0;
  for (const turn of stranded) {
    if (queueItemExistsForTurn(db, "turn-stop", turn.id)) {
      continue;
    }
    if (!isSegmentEra(turn.createdAtEpoch, eraCutoffEpoch)) {
      resetTurnExtractionFields(db, turn.id, nowEpoch);
    }
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
function recoverStrandedAncestors(db, childSessionId, nowEpoch, eraCutoffEpoch = null, maxDepth = 16) {
  let recovered = 0;
  const visited = /* @__PURE__ */ new Set([childSessionId]);
  let current = getSession(db, childSessionId)?.parentSessionId ?? null;
  let depth = 0;
  while (current != null && depth < maxDepth && !visited.has(current)) {
    visited.add(current);
    recovered += recoverStrandedTurns(db, current, nowEpoch, eraCutoffEpoch);
    current = getSession(db, current)?.parentSessionId ?? null;
    depth += 1;
  }
  return recovered;
}

// src/diary/persona-render.ts
var import_node_path9 = require("node:path");
var PROFILE_INJECTION_TOKEN_BUDGET = 2e3;
var DIARY_INDEX_INJECTION_TOKEN_BUDGET = 1e3;
var SESSION_INJECTION_TOKEN_BUDGET = 2e3;
var sectionPointer = (remainingLines, displayPath) => `\uFF08\u672C\u8282\u8FD8\u6709 ${remainingLines} \u884C\uFF0C\u5B8C\u6574\u89C1 ${displayPath}\uFF09`;
var documentPointer = (remainingLines, displayPath) => `\uFF08\u5176\u4F59 ${remainingLines} \u884C\u7701\u7565\uFF0C\u5B8C\u6574\u89C1 ${displayPath}\uFF09`;
function headingLine(section) {
  return section.level === 0 ? null : `${"#".repeat(section.level)} ${section.title}`;
}
function renderSections(sections, includedLineCounts, displayPath, options, reserveEveryPointer = false) {
  const lines = [];
  let documentRemainingLines = 0;
  sections.forEach((section, index) => {
    const heading = headingLine(section);
    if (heading !== null) lines.push(heading);
    const included = includedLineCounts[index] ?? 0;
    lines.push(...section.bodyLines.slice(0, included));
    const remaining = section.bodyLines.length - included;
    if (remaining <= 0 && !reserveEveryPointer) {
      return;
    }
    const pointerTarget = options.sectionDisplayPaths?.[index] ?? displayPath;
    if (pointerTarget !== displayPath) {
      if (remaining > 0) {
        lines.push(sectionPointer(remaining, pointerTarget));
      }
      return;
    }
    documentRemainingLines += Math.max(remaining, 0);
  });
  if (documentRemainingLines > 0) {
    lines.push(documentPointer(documentRemainingLines, displayPath));
  }
  return lines.join("\n");
}
function fallbackPointerLines(sections, displayPath, options) {
  const remainingByTarget = /* @__PURE__ */ new Map();
  sections.forEach((section, index) => {
    if (section.bodyLines.length === 0) {
      return;
    }
    const target = options.sectionDisplayPaths?.[index] ?? displayPath;
    remainingByTarget.set(
      target,
      (remainingByTarget.get(target) ?? 0) + section.bodyLines.length
    );
  });
  const hasDistinctTarget = [...remainingByTarget.keys()].some(
    (target) => target !== displayPath
  );
  if (!hasDistinctTarget) {
    return [`\uFF08\u5185\u5BB9\u7701\u7565\uFF0C\u5B8C\u6574\u89C1 ${displayPath}\uFF09`];
  }
  return [...remainingByTarget].map(
    ([target, remainingLines]) => documentPointer(remainingLines, target)
  );
}
function renderPersonaDocumentInjection(document, injectionTokenBudget, displayPath, options = {}) {
  const sections = parseMarkdownSections(document);
  if (sections.length === 0) return "";
  const includedLineCounts = sections.map(() => 0);
  const skeleton = renderSections(
    sections,
    includedLineCounts,
    displayPath,
    options,
    true
  );
  if (estimateDiaryTokens(skeleton) <= injectionTokenBudget) {
    outer: for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex += 1) {
      const section = sections[sectionIndex];
      for (let lineIndex = 0; lineIndex < section.bodyLines.length; lineIndex += 1) {
        includedLineCounts[sectionIndex] = lineIndex + 1;
        const candidate = renderSections(
          sections,
          includedLineCounts,
          displayPath,
          options
        );
        if (estimateDiaryTokens(candidate) > injectionTokenBudget) {
          includedLineCounts[sectionIndex] = lineIndex;
          break outer;
        }
      }
    }
    return renderSections(sections, includedLineCounts, displayPath, options);
  }
  const topLevelHeadings = sections.filter((section) => section.level === 1).map((section) => headingLine(section));
  const fallbackPointers = fallbackPointerLines(
    sections,
    displayPath,
    options
  );
  const headingFallback = [...topLevelHeadings, ...fallbackPointers].join("\n");
  if (estimateDiaryTokens(headingFallback) <= injectionTokenBudget) {
    return headingFallback;
  }
  const distinctTargets = [
    ...new Set(
      (options.sectionDisplayPaths ?? []).filter((target) => Boolean(target)).filter((target) => target !== displayPath)
    )
  ];
  const alternateTargets = distinctTargets.length > 0 ? `\uFF1B\u53E6\u89C1 ${distinctTargets.join("\u3001")}` : "";
  return `\uFF08${(0, import_node_path9.basename)(displayPath)} \u8FC7\u5927\uFF0C\u5B8C\u6574\u89C1 ${displayPath}${alternateTargets}\uFF09`;
}
function renderBoundedInjectionBlock(input) {
  for (let documentBudget = input.tokenBudget; documentBudget >= 0; documentBudget -= 1) {
    const documentView = renderPersonaDocumentInjection(
      input.document,
      documentBudget,
      input.displayPath
    );
    const block = [
      input.heading,
      ...documentView ? ["", documentView] : []
    ].join("\n");
    if (estimateDiaryTokens(block) <= input.tokenBudget) return block;
  }
  return input.heading;
}
function renderSessionStartPersonaInjection(input) {
  return renderBoundedInjectionBlock({
    heading: "## Persona",
    document: input.userProfile,
    displayPath: input.path,
    tokenBudget: PROFILE_INJECTION_TOKEN_BUDGET
  });
}
function renderSessionStartDiaryIndex(input) {
  return renderPersonaDocumentInjection(
    sortDiaryIndexRecentFirst(input.diaryIndex),
    DIARY_INDEX_INJECTION_TOKEN_BUDGET,
    input.path
  );
}
function renderSessionStartRecentSessionsInjection(input) {
  const diaryIndex = renderSessionStartDiaryIndex({
    diaryIndex: input.diaryIndex,
    path: input.paths.diaryIndex
  });
  const separator = input.recentSessions.trim().length > 0 && diaryIndex ? "\n\n" : "";
  const diaryTokens = estimateDiaryTokens(`${separator}${diaryIndex}`);
  let recentBudget = Math.max(
    0,
    SESSION_INJECTION_TOKEN_BUDGET - diaryTokens
  );
  while (recentBudget >= 0) {
    const recentSessions = input.recentSessions.trim().length > 0 ? renderBoundedInjectionBlock({
      heading: "## Recent Sessions",
      document: input.recentSessions,
      displayPath: input.paths.recentSessions,
      tokenBudget: recentBudget
    }) : "";
    const combined = `${recentSessions}${separator}${diaryIndex}`;
    if (estimateDiaryTokens(combined) <= SESSION_INJECTION_TOKEN_BUDGET) {
      return combined;
    }
    recentBudget -= 1;
  }
  return diaryIndex;
}

// src/db/session-run.ts
function markSessionRunStart(db, sessionDbId) {
  db.query(
    `INSERT INTO session_run_state (session_db_id, start_turn_id)
     VALUES (
       ?,
       COALESCE((SELECT MAX(id) FROM turns WHERE session_id = ?), 0)
     )
     ON CONFLICT(session_db_id) DO UPDATE SET
       start_turn_id = excluded.start_turn_id`
  ).run(sessionDbId, sessionDbId);
}
function hasNewTurnSinceSessionRunStart(db, sessionDbId) {
  return db.query(
    `SELECT EXISTS(
           SELECT 1
           FROM session_run_state r
           JOIN turns t
             ON t.session_id = r.session_db_id
            AND t.id > r.start_turn_id
           WHERE r.session_db_id = ?
         ) AS hasNewTurn`
  ).get(sessionDbId)?.hasNewTurn === 1;
}

// src/db/rules.ts
var import_node_path10 = require("node:path");

// node_modules/zod/v4/classic/external.js
var external_exports = {};
__export(external_exports, {
  $brand: () => $brand,
  $input: () => $input,
  $output: () => $output,
  NEVER: () => NEVER,
  TimePrecision: () => TimePrecision,
  ZodAny: () => ZodAny,
  ZodArray: () => ZodArray,
  ZodBase64: () => ZodBase64,
  ZodBase64URL: () => ZodBase64URL,
  ZodBigInt: () => ZodBigInt,
  ZodBigIntFormat: () => ZodBigIntFormat,
  ZodBoolean: () => ZodBoolean,
  ZodCIDRv4: () => ZodCIDRv4,
  ZodCIDRv6: () => ZodCIDRv6,
  ZodCUID: () => ZodCUID,
  ZodCUID2: () => ZodCUID2,
  ZodCatch: () => ZodCatch,
  ZodCodec: () => ZodCodec,
  ZodCustom: () => ZodCustom,
  ZodCustomStringFormat: () => ZodCustomStringFormat,
  ZodDate: () => ZodDate,
  ZodDefault: () => ZodDefault,
  ZodDiscriminatedUnion: () => ZodDiscriminatedUnion,
  ZodE164: () => ZodE164,
  ZodEmail: () => ZodEmail,
  ZodEmoji: () => ZodEmoji,
  ZodEnum: () => ZodEnum,
  ZodError: () => ZodError,
  ZodExactOptional: () => ZodExactOptional,
  ZodFile: () => ZodFile,
  ZodFirstPartyTypeKind: () => ZodFirstPartyTypeKind,
  ZodFunction: () => ZodFunction,
  ZodGUID: () => ZodGUID,
  ZodIPv4: () => ZodIPv4,
  ZodIPv6: () => ZodIPv6,
  ZodISODate: () => ZodISODate,
  ZodISODateTime: () => ZodISODateTime,
  ZodISODuration: () => ZodISODuration,
  ZodISOTime: () => ZodISOTime,
  ZodIntersection: () => ZodIntersection,
  ZodIssueCode: () => ZodIssueCode,
  ZodJWT: () => ZodJWT,
  ZodKSUID: () => ZodKSUID,
  ZodLazy: () => ZodLazy,
  ZodLiteral: () => ZodLiteral,
  ZodMAC: () => ZodMAC,
  ZodMap: () => ZodMap,
  ZodNaN: () => ZodNaN,
  ZodNanoID: () => ZodNanoID,
  ZodNever: () => ZodNever,
  ZodNonOptional: () => ZodNonOptional,
  ZodNull: () => ZodNull,
  ZodNullable: () => ZodNullable,
  ZodNumber: () => ZodNumber,
  ZodNumberFormat: () => ZodNumberFormat,
  ZodObject: () => ZodObject,
  ZodOptional: () => ZodOptional,
  ZodPipe: () => ZodPipe,
  ZodPrefault: () => ZodPrefault,
  ZodPromise: () => ZodPromise,
  ZodReadonly: () => ZodReadonly,
  ZodRealError: () => ZodRealError,
  ZodRecord: () => ZodRecord,
  ZodSet: () => ZodSet,
  ZodString: () => ZodString,
  ZodStringFormat: () => ZodStringFormat,
  ZodSuccess: () => ZodSuccess,
  ZodSymbol: () => ZodSymbol,
  ZodTemplateLiteral: () => ZodTemplateLiteral,
  ZodTransform: () => ZodTransform,
  ZodTuple: () => ZodTuple,
  ZodType: () => ZodType,
  ZodULID: () => ZodULID,
  ZodURL: () => ZodURL,
  ZodUUID: () => ZodUUID,
  ZodUndefined: () => ZodUndefined,
  ZodUnion: () => ZodUnion,
  ZodUnknown: () => ZodUnknown,
  ZodVoid: () => ZodVoid,
  ZodXID: () => ZodXID,
  ZodXor: () => ZodXor,
  _ZodString: () => _ZodString,
  _default: () => _default2,
  _function: () => _function,
  any: () => any,
  array: () => array,
  base64: () => base642,
  base64url: () => base64url2,
  bigint: () => bigint2,
  boolean: () => boolean2,
  catch: () => _catch2,
  check: () => check,
  cidrv4: () => cidrv42,
  cidrv6: () => cidrv62,
  clone: () => clone,
  codec: () => codec,
  coerce: () => coerce_exports,
  config: () => config,
  core: () => core_exports2,
  cuid: () => cuid3,
  cuid2: () => cuid22,
  custom: () => custom,
  date: () => date3,
  decode: () => decode2,
  decodeAsync: () => decodeAsync2,
  describe: () => describe2,
  discriminatedUnion: () => discriminatedUnion,
  e164: () => e1642,
  email: () => email2,
  emoji: () => emoji2,
  encode: () => encode2,
  encodeAsync: () => encodeAsync2,
  endsWith: () => _endsWith,
  enum: () => _enum2,
  exactOptional: () => exactOptional,
  file: () => file,
  flattenError: () => flattenError,
  float32: () => float32,
  float64: () => float64,
  formatError: () => formatError,
  fromJSONSchema: () => fromJSONSchema,
  function: () => _function,
  getErrorMap: () => getErrorMap,
  globalRegistry: () => globalRegistry,
  gt: () => _gt,
  gte: () => _gte,
  guid: () => guid2,
  hash: () => hash,
  hex: () => hex2,
  hostname: () => hostname2,
  httpUrl: () => httpUrl,
  includes: () => _includes,
  instanceof: () => _instanceof,
  int: () => int,
  int32: () => int32,
  int64: () => int64,
  intersection: () => intersection,
  ipv4: () => ipv42,
  ipv6: () => ipv62,
  iso: () => iso_exports,
  json: () => json,
  jwt: () => jwt,
  keyof: () => keyof,
  ksuid: () => ksuid2,
  lazy: () => lazy,
  length: () => _length,
  literal: () => literal,
  locales: () => locales_exports,
  looseObject: () => looseObject,
  looseRecord: () => looseRecord,
  lowercase: () => _lowercase,
  lt: () => _lt,
  lte: () => _lte,
  mac: () => mac2,
  map: () => map,
  maxLength: () => _maxLength,
  maxSize: () => _maxSize,
  meta: () => meta2,
  mime: () => _mime,
  minLength: () => _minLength,
  minSize: () => _minSize,
  multipleOf: () => _multipleOf,
  nan: () => nan,
  nanoid: () => nanoid2,
  nativeEnum: () => nativeEnum,
  negative: () => _negative,
  never: () => never,
  nonnegative: () => _nonnegative,
  nonoptional: () => nonoptional,
  nonpositive: () => _nonpositive,
  normalize: () => _normalize,
  null: () => _null3,
  nullable: () => nullable,
  nullish: () => nullish2,
  number: () => number2,
  object: () => object,
  optional: () => optional,
  overwrite: () => _overwrite,
  parse: () => parse2,
  parseAsync: () => parseAsync2,
  partialRecord: () => partialRecord,
  pipe: () => pipe,
  positive: () => _positive,
  prefault: () => prefault,
  preprocess: () => preprocess,
  prettifyError: () => prettifyError,
  promise: () => promise,
  property: () => _property,
  readonly: () => readonly,
  record: () => record,
  refine: () => refine,
  regex: () => _regex,
  regexes: () => regexes_exports,
  registry: () => registry,
  safeDecode: () => safeDecode2,
  safeDecodeAsync: () => safeDecodeAsync2,
  safeEncode: () => safeEncode2,
  safeEncodeAsync: () => safeEncodeAsync2,
  safeParse: () => safeParse2,
  safeParseAsync: () => safeParseAsync2,
  set: () => set,
  setErrorMap: () => setErrorMap,
  size: () => _size,
  slugify: () => _slugify,
  startsWith: () => _startsWith,
  strictObject: () => strictObject,
  string: () => string2,
  stringFormat: () => stringFormat,
  stringbool: () => stringbool,
  success: () => success,
  superRefine: () => superRefine,
  symbol: () => symbol,
  templateLiteral: () => templateLiteral,
  toJSONSchema: () => toJSONSchema,
  toLowerCase: () => _toLowerCase,
  toUpperCase: () => _toUpperCase,
  transform: () => transform,
  treeifyError: () => treeifyError,
  trim: () => _trim,
  tuple: () => tuple,
  uint32: () => uint32,
  uint64: () => uint64,
  ulid: () => ulid2,
  undefined: () => _undefined3,
  union: () => union,
  unknown: () => unknown,
  uppercase: () => _uppercase,
  url: () => url,
  util: () => util_exports,
  uuid: () => uuid2,
  uuidv4: () => uuidv4,
  uuidv6: () => uuidv6,
  uuidv7: () => uuidv7,
  void: () => _void2,
  xid: () => xid2,
  xor: () => xor
});

// node_modules/zod/v4/core/index.js
var core_exports2 = {};
__export(core_exports2, {
  $ZodAny: () => $ZodAny,
  $ZodArray: () => $ZodArray,
  $ZodAsyncError: () => $ZodAsyncError,
  $ZodBase64: () => $ZodBase64,
  $ZodBase64URL: () => $ZodBase64URL,
  $ZodBigInt: () => $ZodBigInt,
  $ZodBigIntFormat: () => $ZodBigIntFormat,
  $ZodBoolean: () => $ZodBoolean,
  $ZodCIDRv4: () => $ZodCIDRv4,
  $ZodCIDRv6: () => $ZodCIDRv6,
  $ZodCUID: () => $ZodCUID,
  $ZodCUID2: () => $ZodCUID2,
  $ZodCatch: () => $ZodCatch,
  $ZodCheck: () => $ZodCheck,
  $ZodCheckBigIntFormat: () => $ZodCheckBigIntFormat,
  $ZodCheckEndsWith: () => $ZodCheckEndsWith,
  $ZodCheckGreaterThan: () => $ZodCheckGreaterThan,
  $ZodCheckIncludes: () => $ZodCheckIncludes,
  $ZodCheckLengthEquals: () => $ZodCheckLengthEquals,
  $ZodCheckLessThan: () => $ZodCheckLessThan,
  $ZodCheckLowerCase: () => $ZodCheckLowerCase,
  $ZodCheckMaxLength: () => $ZodCheckMaxLength,
  $ZodCheckMaxSize: () => $ZodCheckMaxSize,
  $ZodCheckMimeType: () => $ZodCheckMimeType,
  $ZodCheckMinLength: () => $ZodCheckMinLength,
  $ZodCheckMinSize: () => $ZodCheckMinSize,
  $ZodCheckMultipleOf: () => $ZodCheckMultipleOf,
  $ZodCheckNumberFormat: () => $ZodCheckNumberFormat,
  $ZodCheckOverwrite: () => $ZodCheckOverwrite,
  $ZodCheckProperty: () => $ZodCheckProperty,
  $ZodCheckRegex: () => $ZodCheckRegex,
  $ZodCheckSizeEquals: () => $ZodCheckSizeEquals,
  $ZodCheckStartsWith: () => $ZodCheckStartsWith,
  $ZodCheckStringFormat: () => $ZodCheckStringFormat,
  $ZodCheckUpperCase: () => $ZodCheckUpperCase,
  $ZodCodec: () => $ZodCodec,
  $ZodCustom: () => $ZodCustom,
  $ZodCustomStringFormat: () => $ZodCustomStringFormat,
  $ZodDate: () => $ZodDate,
  $ZodDefault: () => $ZodDefault,
  $ZodDiscriminatedUnion: () => $ZodDiscriminatedUnion,
  $ZodE164: () => $ZodE164,
  $ZodEmail: () => $ZodEmail,
  $ZodEmoji: () => $ZodEmoji,
  $ZodEncodeError: () => $ZodEncodeError,
  $ZodEnum: () => $ZodEnum,
  $ZodError: () => $ZodError,
  $ZodExactOptional: () => $ZodExactOptional,
  $ZodFile: () => $ZodFile,
  $ZodFunction: () => $ZodFunction,
  $ZodGUID: () => $ZodGUID,
  $ZodIPv4: () => $ZodIPv4,
  $ZodIPv6: () => $ZodIPv6,
  $ZodISODate: () => $ZodISODate,
  $ZodISODateTime: () => $ZodISODateTime,
  $ZodISODuration: () => $ZodISODuration,
  $ZodISOTime: () => $ZodISOTime,
  $ZodIntersection: () => $ZodIntersection,
  $ZodJWT: () => $ZodJWT,
  $ZodKSUID: () => $ZodKSUID,
  $ZodLazy: () => $ZodLazy,
  $ZodLiteral: () => $ZodLiteral,
  $ZodMAC: () => $ZodMAC,
  $ZodMap: () => $ZodMap,
  $ZodNaN: () => $ZodNaN,
  $ZodNanoID: () => $ZodNanoID,
  $ZodNever: () => $ZodNever,
  $ZodNonOptional: () => $ZodNonOptional,
  $ZodNull: () => $ZodNull,
  $ZodNullable: () => $ZodNullable,
  $ZodNumber: () => $ZodNumber,
  $ZodNumberFormat: () => $ZodNumberFormat,
  $ZodObject: () => $ZodObject,
  $ZodObjectJIT: () => $ZodObjectJIT,
  $ZodOptional: () => $ZodOptional,
  $ZodPipe: () => $ZodPipe,
  $ZodPrefault: () => $ZodPrefault,
  $ZodPromise: () => $ZodPromise,
  $ZodReadonly: () => $ZodReadonly,
  $ZodRealError: () => $ZodRealError,
  $ZodRecord: () => $ZodRecord,
  $ZodRegistry: () => $ZodRegistry,
  $ZodSet: () => $ZodSet,
  $ZodString: () => $ZodString,
  $ZodStringFormat: () => $ZodStringFormat,
  $ZodSuccess: () => $ZodSuccess,
  $ZodSymbol: () => $ZodSymbol,
  $ZodTemplateLiteral: () => $ZodTemplateLiteral,
  $ZodTransform: () => $ZodTransform,
  $ZodTuple: () => $ZodTuple,
  $ZodType: () => $ZodType,
  $ZodULID: () => $ZodULID,
  $ZodURL: () => $ZodURL,
  $ZodUUID: () => $ZodUUID,
  $ZodUndefined: () => $ZodUndefined,
  $ZodUnion: () => $ZodUnion,
  $ZodUnknown: () => $ZodUnknown,
  $ZodVoid: () => $ZodVoid,
  $ZodXID: () => $ZodXID,
  $ZodXor: () => $ZodXor,
  $brand: () => $brand,
  $constructor: () => $constructor,
  $input: () => $input,
  $output: () => $output,
  Doc: () => Doc,
  JSONSchema: () => json_schema_exports,
  JSONSchemaGenerator: () => JSONSchemaGenerator,
  NEVER: () => NEVER,
  TimePrecision: () => TimePrecision,
  _any: () => _any,
  _array: () => _array,
  _base64: () => _base64,
  _base64url: () => _base64url,
  _bigint: () => _bigint,
  _boolean: () => _boolean,
  _catch: () => _catch,
  _check: () => _check,
  _cidrv4: () => _cidrv4,
  _cidrv6: () => _cidrv6,
  _coercedBigint: () => _coercedBigint,
  _coercedBoolean: () => _coercedBoolean,
  _coercedDate: () => _coercedDate,
  _coercedNumber: () => _coercedNumber,
  _coercedString: () => _coercedString,
  _cuid: () => _cuid,
  _cuid2: () => _cuid2,
  _custom: () => _custom,
  _date: () => _date,
  _decode: () => _decode,
  _decodeAsync: () => _decodeAsync,
  _default: () => _default,
  _discriminatedUnion: () => _discriminatedUnion,
  _e164: () => _e164,
  _email: () => _email,
  _emoji: () => _emoji2,
  _encode: () => _encode,
  _encodeAsync: () => _encodeAsync,
  _endsWith: () => _endsWith,
  _enum: () => _enum,
  _file: () => _file,
  _float32: () => _float32,
  _float64: () => _float64,
  _gt: () => _gt,
  _gte: () => _gte,
  _guid: () => _guid,
  _includes: () => _includes,
  _int: () => _int,
  _int32: () => _int32,
  _int64: () => _int64,
  _intersection: () => _intersection,
  _ipv4: () => _ipv4,
  _ipv6: () => _ipv6,
  _isoDate: () => _isoDate,
  _isoDateTime: () => _isoDateTime,
  _isoDuration: () => _isoDuration,
  _isoTime: () => _isoTime,
  _jwt: () => _jwt,
  _ksuid: () => _ksuid,
  _lazy: () => _lazy,
  _length: () => _length,
  _literal: () => _literal,
  _lowercase: () => _lowercase,
  _lt: () => _lt,
  _lte: () => _lte,
  _mac: () => _mac,
  _map: () => _map,
  _max: () => _lte,
  _maxLength: () => _maxLength,
  _maxSize: () => _maxSize,
  _mime: () => _mime,
  _min: () => _gte,
  _minLength: () => _minLength,
  _minSize: () => _minSize,
  _multipleOf: () => _multipleOf,
  _nan: () => _nan,
  _nanoid: () => _nanoid,
  _nativeEnum: () => _nativeEnum,
  _negative: () => _negative,
  _never: () => _never,
  _nonnegative: () => _nonnegative,
  _nonoptional: () => _nonoptional,
  _nonpositive: () => _nonpositive,
  _normalize: () => _normalize,
  _null: () => _null2,
  _nullable: () => _nullable,
  _number: () => _number,
  _optional: () => _optional,
  _overwrite: () => _overwrite,
  _parse: () => _parse,
  _parseAsync: () => _parseAsync,
  _pipe: () => _pipe,
  _positive: () => _positive,
  _promise: () => _promise,
  _property: () => _property,
  _readonly: () => _readonly,
  _record: () => _record,
  _refine: () => _refine,
  _regex: () => _regex,
  _safeDecode: () => _safeDecode,
  _safeDecodeAsync: () => _safeDecodeAsync,
  _safeEncode: () => _safeEncode,
  _safeEncodeAsync: () => _safeEncodeAsync,
  _safeParse: () => _safeParse,
  _safeParseAsync: () => _safeParseAsync,
  _set: () => _set,
  _size: () => _size,
  _slugify: () => _slugify,
  _startsWith: () => _startsWith,
  _string: () => _string,
  _stringFormat: () => _stringFormat,
  _stringbool: () => _stringbool,
  _success: () => _success,
  _superRefine: () => _superRefine,
  _symbol: () => _symbol,
  _templateLiteral: () => _templateLiteral,
  _toLowerCase: () => _toLowerCase,
  _toUpperCase: () => _toUpperCase,
  _transform: () => _transform,
  _trim: () => _trim,
  _tuple: () => _tuple,
  _uint32: () => _uint32,
  _uint64: () => _uint64,
  _ulid: () => _ulid,
  _undefined: () => _undefined2,
  _union: () => _union,
  _unknown: () => _unknown,
  _uppercase: () => _uppercase,
  _url: () => _url,
  _uuid: () => _uuid,
  _uuidv4: () => _uuidv4,
  _uuidv6: () => _uuidv6,
  _uuidv7: () => _uuidv7,
  _void: () => _void,
  _xid: () => _xid,
  _xor: () => _xor,
  clone: () => clone,
  config: () => config,
  createStandardJSONSchemaMethod: () => createStandardJSONSchemaMethod,
  createToJSONSchemaMethod: () => createToJSONSchemaMethod,
  decode: () => decode,
  decodeAsync: () => decodeAsync,
  describe: () => describe,
  encode: () => encode,
  encodeAsync: () => encodeAsync,
  extractDefs: () => extractDefs,
  finalize: () => finalize,
  flattenError: () => flattenError,
  formatError: () => formatError,
  globalConfig: () => globalConfig,
  globalRegistry: () => globalRegistry,
  initializeContext: () => initializeContext,
  isValidBase64: () => isValidBase64,
  isValidBase64URL: () => isValidBase64URL,
  isValidJWT: () => isValidJWT,
  locales: () => locales_exports,
  meta: () => meta,
  parse: () => parse,
  parseAsync: () => parseAsync,
  prettifyError: () => prettifyError,
  process: () => process2,
  regexes: () => regexes_exports,
  registry: () => registry,
  safeDecode: () => safeDecode,
  safeDecodeAsync: () => safeDecodeAsync,
  safeEncode: () => safeEncode,
  safeEncodeAsync: () => safeEncodeAsync,
  safeParse: () => safeParse,
  safeParseAsync: () => safeParseAsync,
  toDotPath: () => toDotPath,
  toJSONSchema: () => toJSONSchema,
  treeifyError: () => treeifyError,
  util: () => util_exports,
  version: () => version
});

// node_modules/zod/v4/core/core.js
var NEVER = Object.freeze({
  status: "aborted"
});
// @__NO_SIDE_EFFECTS__
function $constructor(name, initializer3, params) {
  function init(inst, def) {
    if (!inst._zod) {
      Object.defineProperty(inst, "_zod", {
        value: {
          def,
          constr: _,
          traits: /* @__PURE__ */ new Set()
        },
        enumerable: false
      });
    }
    if (inst._zod.traits.has(name)) {
      return;
    }
    inst._zod.traits.add(name);
    initializer3(inst, def);
    const proto = _.prototype;
    const keys = Object.keys(proto);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (!(k in inst)) {
        inst[k] = proto[k].bind(inst);
      }
    }
  }
  const Parent = params?.Parent ?? Object;
  class Definition extends Parent {
  }
  Object.defineProperty(Definition, "name", { value: name });
  function _(def) {
    var _a2;
    const inst = params?.Parent ? new Definition() : this;
    init(inst, def);
    (_a2 = inst._zod).deferred ?? (_a2.deferred = []);
    for (const fn of inst._zod.deferred) {
      fn();
    }
    return inst;
  }
  Object.defineProperty(_, "init", { value: init });
  Object.defineProperty(_, Symbol.hasInstance, {
    value: (inst) => {
      if (params?.Parent && inst instanceof params.Parent)
        return true;
      return inst?._zod?.traits?.has(name);
    }
  });
  Object.defineProperty(_, "name", { value: name });
  return _;
}
var $brand = /* @__PURE__ */ Symbol("zod_brand");
var $ZodAsyncError = class extends Error {
  constructor() {
    super(`Encountered Promise during synchronous parse. Use .parseAsync() instead.`);
  }
};
var $ZodEncodeError = class extends Error {
  constructor(name) {
    super(`Encountered unidirectional transform during encode: ${name}`);
    this.name = "ZodEncodeError";
  }
};
var globalConfig = {};
function config(newConfig) {
  if (newConfig)
    Object.assign(globalConfig, newConfig);
  return globalConfig;
}

// node_modules/zod/v4/core/util.js
var util_exports = {};
__export(util_exports, {
  BIGINT_FORMAT_RANGES: () => BIGINT_FORMAT_RANGES,
  Class: () => Class,
  NUMBER_FORMAT_RANGES: () => NUMBER_FORMAT_RANGES,
  aborted: () => aborted,
  allowsEval: () => allowsEval,
  assert: () => assert,
  assertEqual: () => assertEqual,
  assertIs: () => assertIs,
  assertNever: () => assertNever,
  assertNotEqual: () => assertNotEqual,
  assignProp: () => assignProp,
  base64ToUint8Array: () => base64ToUint8Array,
  base64urlToUint8Array: () => base64urlToUint8Array,
  cached: () => cached,
  captureStackTrace: () => captureStackTrace,
  cleanEnum: () => cleanEnum,
  cleanRegex: () => cleanRegex,
  clone: () => clone,
  cloneDef: () => cloneDef,
  createTransparentProxy: () => createTransparentProxy,
  defineLazy: () => defineLazy,
  esc: () => esc,
  escapeRegex: () => escapeRegex,
  extend: () => extend,
  finalizeIssue: () => finalizeIssue,
  floatSafeRemainder: () => floatSafeRemainder,
  getElementAtPath: () => getElementAtPath,
  getEnumValues: () => getEnumValues,
  getLengthableOrigin: () => getLengthableOrigin,
  getParsedType: () => getParsedType,
  getSizableOrigin: () => getSizableOrigin,
  hexToUint8Array: () => hexToUint8Array,
  isObject: () => isObject,
  isPlainObject: () => isPlainObject,
  issue: () => issue,
  joinValues: () => joinValues,
  jsonStringifyReplacer: () => jsonStringifyReplacer,
  merge: () => merge,
  mergeDefs: () => mergeDefs,
  normalizeParams: () => normalizeParams,
  nullish: () => nullish,
  numKeys: () => numKeys,
  objectClone: () => objectClone,
  omit: () => omit,
  optionalKeys: () => optionalKeys,
  parsedType: () => parsedType,
  partial: () => partial,
  pick: () => pick,
  prefixIssues: () => prefixIssues,
  primitiveTypes: () => primitiveTypes,
  promiseAllObject: () => promiseAllObject,
  propertyKeyTypes: () => propertyKeyTypes,
  randomString: () => randomString,
  required: () => required,
  safeExtend: () => safeExtend,
  shallowClone: () => shallowClone,
  slugify: () => slugify,
  stringifyPrimitive: () => stringifyPrimitive,
  uint8ArrayToBase64: () => uint8ArrayToBase64,
  uint8ArrayToBase64url: () => uint8ArrayToBase64url,
  uint8ArrayToHex: () => uint8ArrayToHex,
  unwrapMessage: () => unwrapMessage
});
function assertEqual(val) {
  return val;
}
function assertNotEqual(val) {
  return val;
}
function assertIs(_arg) {
}
function assertNever(_x) {
  throw new Error("Unexpected value in exhaustive check");
}
function assert(_) {
}
function getEnumValues(entries) {
  const numericValues = Object.values(entries).filter((v) => typeof v === "number");
  const values = Object.entries(entries).filter(([k, _]) => numericValues.indexOf(+k) === -1).map(([_, v]) => v);
  return values;
}
function joinValues(array2, separator = "|") {
  return array2.map((val) => stringifyPrimitive(val)).join(separator);
}
function jsonStringifyReplacer(_, value) {
  if (typeof value === "bigint")
    return value.toString();
  return value;
}
function cached(getter) {
  const set2 = false;
  return {
    get value() {
      if (!set2) {
        const value = getter();
        Object.defineProperty(this, "value", { value });
        return value;
      }
      throw new Error("cached value already set");
    }
  };
}
function nullish(input) {
  return input === null || input === void 0;
}
function cleanRegex(source) {
  const start = source.startsWith("^") ? 1 : 0;
  const end = source.endsWith("$") ? source.length - 1 : source.length;
  return source.slice(start, end);
}
function floatSafeRemainder(val, step) {
  const valDecCount = (val.toString().split(".")[1] || "").length;
  const stepString = step.toString();
  let stepDecCount = (stepString.split(".")[1] || "").length;
  if (stepDecCount === 0 && /\d?e-\d?/.test(stepString)) {
    const match = stepString.match(/\d?e-(\d?)/);
    if (match?.[1]) {
      stepDecCount = Number.parseInt(match[1]);
    }
  }
  const decCount = valDecCount > stepDecCount ? valDecCount : stepDecCount;
  const valInt = Number.parseInt(val.toFixed(decCount).replace(".", ""));
  const stepInt = Number.parseInt(step.toFixed(decCount).replace(".", ""));
  return valInt % stepInt / 10 ** decCount;
}
var EVALUATING = /* @__PURE__ */ Symbol("evaluating");
function defineLazy(object2, key, getter) {
  let value = void 0;
  Object.defineProperty(object2, key, {
    get() {
      if (value === EVALUATING) {
        return void 0;
      }
      if (value === void 0) {
        value = EVALUATING;
        value = getter();
      }
      return value;
    },
    set(v) {
      Object.defineProperty(object2, key, {
        value: v
        // configurable: true,
      });
    },
    configurable: true
  });
}
function objectClone(obj) {
  return Object.create(Object.getPrototypeOf(obj), Object.getOwnPropertyDescriptors(obj));
}
function assignProp(target, prop, value) {
  Object.defineProperty(target, prop, {
    value,
    writable: true,
    enumerable: true,
    configurable: true
  });
}
function mergeDefs(...defs) {
  const mergedDescriptors = {};
  for (const def of defs) {
    const descriptors = Object.getOwnPropertyDescriptors(def);
    Object.assign(mergedDescriptors, descriptors);
  }
  return Object.defineProperties({}, mergedDescriptors);
}
function cloneDef(schema) {
  return mergeDefs(schema._zod.def);
}
function getElementAtPath(obj, path2) {
  if (!path2)
    return obj;
  return path2.reduce((acc, key) => acc?.[key], obj);
}
function promiseAllObject(promisesObj) {
  const keys = Object.keys(promisesObj);
  const promises = keys.map((key) => promisesObj[key]);
  return Promise.all(promises).then((results) => {
    const resolvedObj = {};
    for (let i = 0; i < keys.length; i++) {
      resolvedObj[keys[i]] = results[i];
    }
    return resolvedObj;
  });
}
function randomString(length = 10) {
  const chars = "abcdefghijklmnopqrstuvwxyz";
  let str = "";
  for (let i = 0; i < length; i++) {
    str += chars[Math.floor(Math.random() * chars.length)];
  }
  return str;
}
function esc(str) {
  return JSON.stringify(str);
}
function slugify(input) {
  return input.toLowerCase().trim().replace(/[^\w\s-]/g, "").replace(/[\s_-]+/g, "-").replace(/^-+|-+$/g, "");
}
var captureStackTrace = "captureStackTrace" in Error ? Error.captureStackTrace : (..._args) => {
};
function isObject(data) {
  return typeof data === "object" && data !== null && !Array.isArray(data);
}
var allowsEval = cached(() => {
  if (typeof navigator !== "undefined" && navigator?.userAgent?.includes("Cloudflare")) {
    return false;
  }
  try {
    const F = Function;
    new F("");
    return true;
  } catch (_) {
    return false;
  }
});
function isPlainObject(o) {
  if (isObject(o) === false)
    return false;
  const ctor = o.constructor;
  if (ctor === void 0)
    return true;
  if (typeof ctor !== "function")
    return true;
  const prot = ctor.prototype;
  if (isObject(prot) === false)
    return false;
  if (Object.prototype.hasOwnProperty.call(prot, "isPrototypeOf") === false) {
    return false;
  }
  return true;
}
function shallowClone(o) {
  if (isPlainObject(o))
    return { ...o };
  if (Array.isArray(o))
    return [...o];
  return o;
}
function numKeys(data) {
  let keyCount = 0;
  for (const key in data) {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      keyCount++;
    }
  }
  return keyCount;
}
var getParsedType = (data) => {
  const t = typeof data;
  switch (t) {
    case "undefined":
      return "undefined";
    case "string":
      return "string";
    case "number":
      return Number.isNaN(data) ? "nan" : "number";
    case "boolean":
      return "boolean";
    case "function":
      return "function";
    case "bigint":
      return "bigint";
    case "symbol":
      return "symbol";
    case "object":
      if (Array.isArray(data)) {
        return "array";
      }
      if (data === null) {
        return "null";
      }
      if (data.then && typeof data.then === "function" && data.catch && typeof data.catch === "function") {
        return "promise";
      }
      if (typeof Map !== "undefined" && data instanceof Map) {
        return "map";
      }
      if (typeof Set !== "undefined" && data instanceof Set) {
        return "set";
      }
      if (typeof Date !== "undefined" && data instanceof Date) {
        return "date";
      }
      if (typeof File !== "undefined" && data instanceof File) {
        return "file";
      }
      return "object";
    default:
      throw new Error(`Unknown data type: ${t}`);
  }
};
var propertyKeyTypes = /* @__PURE__ */ new Set(["string", "number", "symbol"]);
var primitiveTypes = /* @__PURE__ */ new Set(["string", "number", "bigint", "boolean", "symbol", "undefined"]);
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function clone(inst, def, params) {
  const cl = new inst._zod.constr(def ?? inst._zod.def);
  if (!def || params?.parent)
    cl._zod.parent = inst;
  return cl;
}
function normalizeParams(_params) {
  const params = _params;
  if (!params)
    return {};
  if (typeof params === "string")
    return { error: () => params };
  if (params?.message !== void 0) {
    if (params?.error !== void 0)
      throw new Error("Cannot specify both `message` and `error` params");
    params.error = params.message;
  }
  delete params.message;
  if (typeof params.error === "string")
    return { ...params, error: () => params.error };
  return params;
}
function createTransparentProxy(getter) {
  let target;
  return new Proxy({}, {
    get(_, prop, receiver) {
      target ?? (target = getter());
      return Reflect.get(target, prop, receiver);
    },
    set(_, prop, value, receiver) {
      target ?? (target = getter());
      return Reflect.set(target, prop, value, receiver);
    },
    has(_, prop) {
      target ?? (target = getter());
      return Reflect.has(target, prop);
    },
    deleteProperty(_, prop) {
      target ?? (target = getter());
      return Reflect.deleteProperty(target, prop);
    },
    ownKeys(_) {
      target ?? (target = getter());
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(_, prop) {
      target ?? (target = getter());
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
    defineProperty(_, prop, descriptor) {
      target ?? (target = getter());
      return Reflect.defineProperty(target, prop, descriptor);
    }
  });
}
function stringifyPrimitive(value) {
  if (typeof value === "bigint")
    return value.toString() + "n";
  if (typeof value === "string")
    return `"${value}"`;
  return `${value}`;
}
function optionalKeys(shape) {
  return Object.keys(shape).filter((k) => {
    return shape[k]._zod.optin === "optional" && shape[k]._zod.optout === "optional";
  });
}
var NUMBER_FORMAT_RANGES = {
  safeint: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  int32: [-2147483648, 2147483647],
  uint32: [0, 4294967295],
  float32: [-34028234663852886e22, 34028234663852886e22],
  float64: [-Number.MAX_VALUE, Number.MAX_VALUE]
};
var BIGINT_FORMAT_RANGES = {
  int64: [/* @__PURE__ */ BigInt("-9223372036854775808"), /* @__PURE__ */ BigInt("9223372036854775807")],
  uint64: [/* @__PURE__ */ BigInt(0), /* @__PURE__ */ BigInt("18446744073709551615")]
};
function pick(schema, mask) {
  const currDef = schema._zod.def;
  const checks = currDef.checks;
  const hasChecks = checks && checks.length > 0;
  if (hasChecks) {
    throw new Error(".pick() cannot be used on object schemas containing refinements");
  }
  const def = mergeDefs(schema._zod.def, {
    get shape() {
      const newShape = {};
      for (const key in mask) {
        if (!(key in currDef.shape)) {
          throw new Error(`Unrecognized key: "${key}"`);
        }
        if (!mask[key])
          continue;
        newShape[key] = currDef.shape[key];
      }
      assignProp(this, "shape", newShape);
      return newShape;
    },
    checks: []
  });
  return clone(schema, def);
}
function omit(schema, mask) {
  const currDef = schema._zod.def;
  const checks = currDef.checks;
  const hasChecks = checks && checks.length > 0;
  if (hasChecks) {
    throw new Error(".omit() cannot be used on object schemas containing refinements");
  }
  const def = mergeDefs(schema._zod.def, {
    get shape() {
      const newShape = { ...schema._zod.def.shape };
      for (const key in mask) {
        if (!(key in currDef.shape)) {
          throw new Error(`Unrecognized key: "${key}"`);
        }
        if (!mask[key])
          continue;
        delete newShape[key];
      }
      assignProp(this, "shape", newShape);
      return newShape;
    },
    checks: []
  });
  return clone(schema, def);
}
function extend(schema, shape) {
  if (!isPlainObject(shape)) {
    throw new Error("Invalid input to extend: expected a plain object");
  }
  const checks = schema._zod.def.checks;
  const hasChecks = checks && checks.length > 0;
  if (hasChecks) {
    const existingShape = schema._zod.def.shape;
    for (const key in shape) {
      if (Object.getOwnPropertyDescriptor(existingShape, key) !== void 0) {
        throw new Error("Cannot overwrite keys on object schemas containing refinements. Use `.safeExtend()` instead.");
      }
    }
  }
  const def = mergeDefs(schema._zod.def, {
    get shape() {
      const _shape = { ...schema._zod.def.shape, ...shape };
      assignProp(this, "shape", _shape);
      return _shape;
    }
  });
  return clone(schema, def);
}
function safeExtend(schema, shape) {
  if (!isPlainObject(shape)) {
    throw new Error("Invalid input to safeExtend: expected a plain object");
  }
  const def = mergeDefs(schema._zod.def, {
    get shape() {
      const _shape = { ...schema._zod.def.shape, ...shape };
      assignProp(this, "shape", _shape);
      return _shape;
    }
  });
  return clone(schema, def);
}
function merge(a, b) {
  const def = mergeDefs(a._zod.def, {
    get shape() {
      const _shape = { ...a._zod.def.shape, ...b._zod.def.shape };
      assignProp(this, "shape", _shape);
      return _shape;
    },
    get catchall() {
      return b._zod.def.catchall;
    },
    checks: []
    // delete existing checks
  });
  return clone(a, def);
}
function partial(Class2, schema, mask) {
  const currDef = schema._zod.def;
  const checks = currDef.checks;
  const hasChecks = checks && checks.length > 0;
  if (hasChecks) {
    throw new Error(".partial() cannot be used on object schemas containing refinements");
  }
  const def = mergeDefs(schema._zod.def, {
    get shape() {
      const oldShape = schema._zod.def.shape;
      const shape = { ...oldShape };
      if (mask) {
        for (const key in mask) {
          if (!(key in oldShape)) {
            throw new Error(`Unrecognized key: "${key}"`);
          }
          if (!mask[key])
            continue;
          shape[key] = Class2 ? new Class2({
            type: "optional",
            innerType: oldShape[key]
          }) : oldShape[key];
        }
      } else {
        for (const key in oldShape) {
          shape[key] = Class2 ? new Class2({
            type: "optional",
            innerType: oldShape[key]
          }) : oldShape[key];
        }
      }
      assignProp(this, "shape", shape);
      return shape;
    },
    checks: []
  });
  return clone(schema, def);
}
function required(Class2, schema, mask) {
  const def = mergeDefs(schema._zod.def, {
    get shape() {
      const oldShape = schema._zod.def.shape;
      const shape = { ...oldShape };
      if (mask) {
        for (const key in mask) {
          if (!(key in shape)) {
            throw new Error(`Unrecognized key: "${key}"`);
          }
          if (!mask[key])
            continue;
          shape[key] = new Class2({
            type: "nonoptional",
            innerType: oldShape[key]
          });
        }
      } else {
        for (const key in oldShape) {
          shape[key] = new Class2({
            type: "nonoptional",
            innerType: oldShape[key]
          });
        }
      }
      assignProp(this, "shape", shape);
      return shape;
    }
  });
  return clone(schema, def);
}
function aborted(x, startIndex = 0) {
  if (x.aborted === true)
    return true;
  for (let i = startIndex; i < x.issues.length; i++) {
    if (x.issues[i]?.continue !== true) {
      return true;
    }
  }
  return false;
}
function prefixIssues(path2, issues) {
  return issues.map((iss) => {
    var _a2;
    (_a2 = iss).path ?? (_a2.path = []);
    iss.path.unshift(path2);
    return iss;
  });
}
function unwrapMessage(message) {
  return typeof message === "string" ? message : message?.message;
}
function finalizeIssue(iss, ctx, config2) {
  const full = { ...iss, path: iss.path ?? [] };
  if (!iss.message) {
    const message = unwrapMessage(iss.inst?._zod.def?.error?.(iss)) ?? unwrapMessage(ctx?.error?.(iss)) ?? unwrapMessage(config2.customError?.(iss)) ?? unwrapMessage(config2.localeError?.(iss)) ?? "Invalid input";
    full.message = message;
  }
  delete full.inst;
  delete full.continue;
  if (!ctx?.reportInput) {
    delete full.input;
  }
  return full;
}
function getSizableOrigin(input) {
  if (input instanceof Set)
    return "set";
  if (input instanceof Map)
    return "map";
  if (input instanceof File)
    return "file";
  return "unknown";
}
function getLengthableOrigin(input) {
  if (Array.isArray(input))
    return "array";
  if (typeof input === "string")
    return "string";
  return "unknown";
}
function parsedType(data) {
  const t = typeof data;
  switch (t) {
    case "number": {
      return Number.isNaN(data) ? "nan" : "number";
    }
    case "object": {
      if (data === null) {
        return "null";
      }
      if (Array.isArray(data)) {
        return "array";
      }
      const obj = data;
      if (obj && Object.getPrototypeOf(obj) !== Object.prototype && "constructor" in obj && obj.constructor) {
        return obj.constructor.name;
      }
    }
  }
  return t;
}
function issue(...args) {
  const [iss, input, inst] = args;
  if (typeof iss === "string") {
    return {
      message: iss,
      code: "custom",
      input,
      inst
    };
  }
  return { ...iss };
}
function cleanEnum(obj) {
  return Object.entries(obj).filter(([k, _]) => {
    return Number.isNaN(Number.parseInt(k, 10));
  }).map((el) => el[1]);
}
function base64ToUint8Array(base643) {
  const binaryString = atob(base643);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}
function uint8ArrayToBase64(bytes) {
  let binaryString = "";
  for (let i = 0; i < bytes.length; i++) {
    binaryString += String.fromCharCode(bytes[i]);
  }
  return btoa(binaryString);
}
function base64urlToUint8Array(base64url3) {
  const base643 = base64url3.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - base643.length % 4) % 4);
  return base64ToUint8Array(base643 + padding);
}
function uint8ArrayToBase64url(bytes) {
  return uint8ArrayToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
function hexToUint8Array(hex3) {
  const cleanHex = hex3.replace(/^0x/, "");
  if (cleanHex.length % 2 !== 0) {
    throw new Error("Invalid hex string length");
  }
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < cleanHex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(cleanHex.slice(i, i + 2), 16);
  }
  return bytes;
}
function uint8ArrayToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
var Class = class {
  constructor(..._args) {
  }
};

// node_modules/zod/v4/core/errors.js
var initializer = (inst, def) => {
  inst.name = "$ZodError";
  Object.defineProperty(inst, "_zod", {
    value: inst._zod,
    enumerable: false
  });
  Object.defineProperty(inst, "issues", {
    value: def,
    enumerable: false
  });
  inst.message = JSON.stringify(def, jsonStringifyReplacer, 2);
  Object.defineProperty(inst, "toString", {
    value: () => inst.message,
    enumerable: false
  });
};
var $ZodError = $constructor("$ZodError", initializer);
var $ZodRealError = $constructor("$ZodError", initializer, { Parent: Error });
function flattenError(error48, mapper = (issue2) => issue2.message) {
  const fieldErrors = {};
  const formErrors = [];
  for (const sub of error48.issues) {
    if (sub.path.length > 0) {
      fieldErrors[sub.path[0]] = fieldErrors[sub.path[0]] || [];
      fieldErrors[sub.path[0]].push(mapper(sub));
    } else {
      formErrors.push(mapper(sub));
    }
  }
  return { formErrors, fieldErrors };
}
function formatError(error48, mapper = (issue2) => issue2.message) {
  const fieldErrors = { _errors: [] };
  const processError = (error49) => {
    for (const issue2 of error49.issues) {
      if (issue2.code === "invalid_union" && issue2.errors.length) {
        issue2.errors.map((issues) => processError({ issues }));
      } else if (issue2.code === "invalid_key") {
        processError({ issues: issue2.issues });
      } else if (issue2.code === "invalid_element") {
        processError({ issues: issue2.issues });
      } else if (issue2.path.length === 0) {
        fieldErrors._errors.push(mapper(issue2));
      } else {
        let curr = fieldErrors;
        let i = 0;
        while (i < issue2.path.length) {
          const el = issue2.path[i];
          const terminal = i === issue2.path.length - 1;
          if (!terminal) {
            curr[el] = curr[el] || { _errors: [] };
          } else {
            curr[el] = curr[el] || { _errors: [] };
            curr[el]._errors.push(mapper(issue2));
          }
          curr = curr[el];
          i++;
        }
      }
    }
  };
  processError(error48);
  return fieldErrors;
}
function treeifyError(error48, mapper = (issue2) => issue2.message) {
  const result = { errors: [] };
  const processError = (error49, path2 = []) => {
    var _a2, _b;
    for (const issue2 of error49.issues) {
      if (issue2.code === "invalid_union" && issue2.errors.length) {
        issue2.errors.map((issues) => processError({ issues }, issue2.path));
      } else if (issue2.code === "invalid_key") {
        processError({ issues: issue2.issues }, issue2.path);
      } else if (issue2.code === "invalid_element") {
        processError({ issues: issue2.issues }, issue2.path);
      } else {
        const fullpath = [...path2, ...issue2.path];
        if (fullpath.length === 0) {
          result.errors.push(mapper(issue2));
          continue;
        }
        let curr = result;
        let i = 0;
        while (i < fullpath.length) {
          const el = fullpath[i];
          const terminal = i === fullpath.length - 1;
          if (typeof el === "string") {
            curr.properties ?? (curr.properties = {});
            (_a2 = curr.properties)[el] ?? (_a2[el] = { errors: [] });
            curr = curr.properties[el];
          } else {
            curr.items ?? (curr.items = []);
            (_b = curr.items)[el] ?? (_b[el] = { errors: [] });
            curr = curr.items[el];
          }
          if (terminal) {
            curr.errors.push(mapper(issue2));
          }
          i++;
        }
      }
    }
  };
  processError(error48);
  return result;
}
function toDotPath(_path) {
  const segs = [];
  const path2 = _path.map((seg) => typeof seg === "object" ? seg.key : seg);
  for (const seg of path2) {
    if (typeof seg === "number")
      segs.push(`[${seg}]`);
    else if (typeof seg === "symbol")
      segs.push(`[${JSON.stringify(String(seg))}]`);
    else if (/[^\w$]/.test(seg))
      segs.push(`[${JSON.stringify(seg)}]`);
    else {
      if (segs.length)
        segs.push(".");
      segs.push(seg);
    }
  }
  return segs.join("");
}
function prettifyError(error48) {
  const lines = [];
  const issues = [...error48.issues].sort((a, b) => (a.path ?? []).length - (b.path ?? []).length);
  for (const issue2 of issues) {
    lines.push(`\u2716 ${issue2.message}`);
    if (issue2.path?.length)
      lines.push(`  \u2192 at ${toDotPath(issue2.path)}`);
  }
  return lines.join("\n");
}

// node_modules/zod/v4/core/parse.js
var _parse = (_Err) => (schema, value, _ctx, _params) => {
  const ctx = _ctx ? Object.assign(_ctx, { async: false }) : { async: false };
  const result = schema._zod.run({ value, issues: [] }, ctx);
  if (result instanceof Promise) {
    throw new $ZodAsyncError();
  }
  if (result.issues.length) {
    const e = new (_params?.Err ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
    captureStackTrace(e, _params?.callee);
    throw e;
  }
  return result.value;
};
var parse = /* @__PURE__ */ _parse($ZodRealError);
var _parseAsync = (_Err) => async (schema, value, _ctx, params) => {
  const ctx = _ctx ? Object.assign(_ctx, { async: true }) : { async: true };
  let result = schema._zod.run({ value, issues: [] }, ctx);
  if (result instanceof Promise)
    result = await result;
  if (result.issues.length) {
    const e = new (params?.Err ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
    captureStackTrace(e, params?.callee);
    throw e;
  }
  return result.value;
};
var parseAsync = /* @__PURE__ */ _parseAsync($ZodRealError);
var _safeParse = (_Err) => (schema, value, _ctx) => {
  const ctx = _ctx ? { ..._ctx, async: false } : { async: false };
  const result = schema._zod.run({ value, issues: [] }, ctx);
  if (result instanceof Promise) {
    throw new $ZodAsyncError();
  }
  return result.issues.length ? {
    success: false,
    error: new (_Err ?? $ZodError)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
  } : { success: true, data: result.value };
};
var safeParse = /* @__PURE__ */ _safeParse($ZodRealError);
var _safeParseAsync = (_Err) => async (schema, value, _ctx) => {
  const ctx = _ctx ? Object.assign(_ctx, { async: true }) : { async: true };
  let result = schema._zod.run({ value, issues: [] }, ctx);
  if (result instanceof Promise)
    result = await result;
  return result.issues.length ? {
    success: false,
    error: new _Err(result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
  } : { success: true, data: result.value };
};
var safeParseAsync = /* @__PURE__ */ _safeParseAsync($ZodRealError);
var _encode = (_Err) => (schema, value, _ctx) => {
  const ctx = _ctx ? Object.assign(_ctx, { direction: "backward" }) : { direction: "backward" };
  return _parse(_Err)(schema, value, ctx);
};
var encode = /* @__PURE__ */ _encode($ZodRealError);
var _decode = (_Err) => (schema, value, _ctx) => {
  return _parse(_Err)(schema, value, _ctx);
};
var decode = /* @__PURE__ */ _decode($ZodRealError);
var _encodeAsync = (_Err) => async (schema, value, _ctx) => {
  const ctx = _ctx ? Object.assign(_ctx, { direction: "backward" }) : { direction: "backward" };
  return _parseAsync(_Err)(schema, value, ctx);
};
var encodeAsync = /* @__PURE__ */ _encodeAsync($ZodRealError);
var _decodeAsync = (_Err) => async (schema, value, _ctx) => {
  return _parseAsync(_Err)(schema, value, _ctx);
};
var decodeAsync = /* @__PURE__ */ _decodeAsync($ZodRealError);
var _safeEncode = (_Err) => (schema, value, _ctx) => {
  const ctx = _ctx ? Object.assign(_ctx, { direction: "backward" }) : { direction: "backward" };
  return _safeParse(_Err)(schema, value, ctx);
};
var safeEncode = /* @__PURE__ */ _safeEncode($ZodRealError);
var _safeDecode = (_Err) => (schema, value, _ctx) => {
  return _safeParse(_Err)(schema, value, _ctx);
};
var safeDecode = /* @__PURE__ */ _safeDecode($ZodRealError);
var _safeEncodeAsync = (_Err) => async (schema, value, _ctx) => {
  const ctx = _ctx ? Object.assign(_ctx, { direction: "backward" }) : { direction: "backward" };
  return _safeParseAsync(_Err)(schema, value, ctx);
};
var safeEncodeAsync = /* @__PURE__ */ _safeEncodeAsync($ZodRealError);
var _safeDecodeAsync = (_Err) => async (schema, value, _ctx) => {
  return _safeParseAsync(_Err)(schema, value, _ctx);
};
var safeDecodeAsync = /* @__PURE__ */ _safeDecodeAsync($ZodRealError);

// node_modules/zod/v4/core/regexes.js
var regexes_exports = {};
__export(regexes_exports, {
  base64: () => base64,
  base64url: () => base64url,
  bigint: () => bigint,
  boolean: () => boolean,
  browserEmail: () => browserEmail,
  cidrv4: () => cidrv4,
  cidrv6: () => cidrv6,
  cuid: () => cuid,
  cuid2: () => cuid2,
  date: () => date,
  datetime: () => datetime,
  domain: () => domain,
  duration: () => duration,
  e164: () => e164,
  email: () => email,
  emoji: () => emoji,
  extendedDuration: () => extendedDuration,
  guid: () => guid,
  hex: () => hex,
  hostname: () => hostname,
  html5Email: () => html5Email,
  idnEmail: () => idnEmail,
  integer: () => integer,
  ipv4: () => ipv4,
  ipv6: () => ipv6,
  ksuid: () => ksuid,
  lowercase: () => lowercase,
  mac: () => mac,
  md5_base64: () => md5_base64,
  md5_base64url: () => md5_base64url,
  md5_hex: () => md5_hex,
  nanoid: () => nanoid,
  null: () => _null,
  number: () => number,
  rfc5322Email: () => rfc5322Email,
  sha1_base64: () => sha1_base64,
  sha1_base64url: () => sha1_base64url,
  sha1_hex: () => sha1_hex,
  sha256_base64: () => sha256_base64,
  sha256_base64url: () => sha256_base64url,
  sha256_hex: () => sha256_hex,
  sha384_base64: () => sha384_base64,
  sha384_base64url: () => sha384_base64url,
  sha384_hex: () => sha384_hex,
  sha512_base64: () => sha512_base64,
  sha512_base64url: () => sha512_base64url,
  sha512_hex: () => sha512_hex,
  string: () => string,
  time: () => time,
  ulid: () => ulid,
  undefined: () => _undefined,
  unicodeEmail: () => unicodeEmail,
  uppercase: () => uppercase,
  uuid: () => uuid,
  uuid4: () => uuid4,
  uuid6: () => uuid6,
  uuid7: () => uuid7,
  xid: () => xid
});
var cuid = /^[cC][^\s-]{8,}$/;
var cuid2 = /^[0-9a-z]+$/;
var ulid = /^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/;
var xid = /^[0-9a-vA-V]{20}$/;
var ksuid = /^[A-Za-z0-9]{27}$/;
var nanoid = /^[a-zA-Z0-9_-]{21}$/;
var duration = /^P(?:(\d+W)|(?!.*W)(?=\d|T\d)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+([.,]\d+)?S)?)?)$/;
var extendedDuration = /^[-+]?P(?!$)(?:(?:[-+]?\d+Y)|(?:[-+]?\d+[.,]\d+Y$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:(?:[-+]?\d+W)|(?:[-+]?\d+[.,]\d+W$))?(?:(?:[-+]?\d+D)|(?:[-+]?\d+[.,]\d+D$))?(?:T(?=[\d+-])(?:(?:[-+]?\d+H)|(?:[-+]?\d+[.,]\d+H$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:[-+]?\d+(?:[.,]\d+)?S)?)??$/;
var guid = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
var uuid = (version2) => {
  if (!version2)
    return /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;
  return new RegExp(`^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-${version2}[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$`);
};
var uuid4 = /* @__PURE__ */ uuid(4);
var uuid6 = /* @__PURE__ */ uuid(6);
var uuid7 = /* @__PURE__ */ uuid(7);
var email = /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/;
var html5Email = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
var rfc5322Email = /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
var unicodeEmail = /^[^\s@"]{1,64}@[^\s@]{1,255}$/u;
var idnEmail = unicodeEmail;
var browserEmail = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
var _emoji = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
function emoji() {
  return new RegExp(_emoji, "u");
}
var ipv4 = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
var ipv6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/;
var mac = (delimiter) => {
  const escapedDelim = escapeRegex(delimiter ?? ":");
  return new RegExp(`^(?:[0-9A-F]{2}${escapedDelim}){5}[0-9A-F]{2}$|^(?:[0-9a-f]{2}${escapedDelim}){5}[0-9a-f]{2}$`);
};
var cidrv4 = /^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/([0-9]|[1-2][0-9]|3[0-2])$/;
var cidrv6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|::|([0-9a-fA-F]{1,4})?::([0-9a-fA-F]{1,4}:?){0,6})\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
var base64 = /^$|^(?:[0-9a-zA-Z+/]{4})*(?:(?:[0-9a-zA-Z+/]{2}==)|(?:[0-9a-zA-Z+/]{3}=))?$/;
var base64url = /^[A-Za-z0-9_-]*$/;
var hostname = /^(?=.{1,253}\.?$)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[-0-9a-zA-Z]{0,61}[0-9a-zA-Z])?)*\.?$/;
var domain = /^([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
var e164 = /^\+[1-9]\d{6,14}$/;
var dateSource = `(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))`;
var date = /* @__PURE__ */ new RegExp(`^${dateSource}$`);
function timeSource(args) {
  const hhmm = `(?:[01]\\d|2[0-3]):[0-5]\\d`;
  const regex = typeof args.precision === "number" ? args.precision === -1 ? `${hhmm}` : args.precision === 0 ? `${hhmm}:[0-5]\\d` : `${hhmm}:[0-5]\\d\\.\\d{${args.precision}}` : `${hhmm}(?::[0-5]\\d(?:\\.\\d+)?)?`;
  return regex;
}
function time(args) {
  return new RegExp(`^${timeSource(args)}$`);
}
function datetime(args) {
  const time3 = timeSource({ precision: args.precision });
  const opts = ["Z"];
  if (args.local)
    opts.push("");
  if (args.offset)
    opts.push(`([+-](?:[01]\\d|2[0-3]):[0-5]\\d)`);
  const timeRegex = `${time3}(?:${opts.join("|")})`;
  return new RegExp(`^${dateSource}T(?:${timeRegex})$`);
}
var string = (params) => {
  const regex = params ? `[\\s\\S]{${params?.minimum ?? 0},${params?.maximum ?? ""}}` : `[\\s\\S]*`;
  return new RegExp(`^${regex}$`);
};
var bigint = /^-?\d+n?$/;
var integer = /^-?\d+$/;
var number = /^-?\d+(?:\.\d+)?$/;
var boolean = /^(?:true|false)$/i;
var _null = /^null$/i;
var _undefined = /^undefined$/i;
var lowercase = /^[^A-Z]*$/;
var uppercase = /^[^a-z]*$/;
var hex = /^[0-9a-fA-F]*$/;
function fixedBase64(bodyLength, padding) {
  return new RegExp(`^[A-Za-z0-9+/]{${bodyLength}}${padding}$`);
}
function fixedBase64url(length) {
  return new RegExp(`^[A-Za-z0-9_-]{${length}}$`);
}
var md5_hex = /^[0-9a-fA-F]{32}$/;
var md5_base64 = /* @__PURE__ */ fixedBase64(22, "==");
var md5_base64url = /* @__PURE__ */ fixedBase64url(22);
var sha1_hex = /^[0-9a-fA-F]{40}$/;
var sha1_base64 = /* @__PURE__ */ fixedBase64(27, "=");
var sha1_base64url = /* @__PURE__ */ fixedBase64url(27);
var sha256_hex = /^[0-9a-fA-F]{64}$/;
var sha256_base64 = /* @__PURE__ */ fixedBase64(43, "=");
var sha256_base64url = /* @__PURE__ */ fixedBase64url(43);
var sha384_hex = /^[0-9a-fA-F]{96}$/;
var sha384_base64 = /* @__PURE__ */ fixedBase64(64, "");
var sha384_base64url = /* @__PURE__ */ fixedBase64url(64);
var sha512_hex = /^[0-9a-fA-F]{128}$/;
var sha512_base64 = /* @__PURE__ */ fixedBase64(86, "==");
var sha512_base64url = /* @__PURE__ */ fixedBase64url(86);

// node_modules/zod/v4/core/checks.js
var $ZodCheck = /* @__PURE__ */ $constructor("$ZodCheck", (inst, def) => {
  var _a2;
  inst._zod ?? (inst._zod = {});
  inst._zod.def = def;
  (_a2 = inst._zod).onattach ?? (_a2.onattach = []);
});
var numericOriginMap = {
  number: "number",
  bigint: "bigint",
  object: "date"
};
var $ZodCheckLessThan = /* @__PURE__ */ $constructor("$ZodCheckLessThan", (inst, def) => {
  $ZodCheck.init(inst, def);
  const origin = numericOriginMap[typeof def.value];
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    const curr = (def.inclusive ? bag.maximum : bag.exclusiveMaximum) ?? Number.POSITIVE_INFINITY;
    if (def.value < curr) {
      if (def.inclusive)
        bag.maximum = def.value;
      else
        bag.exclusiveMaximum = def.value;
    }
  });
  inst._zod.check = (payload) => {
    if (def.inclusive ? payload.value <= def.value : payload.value < def.value) {
      return;
    }
    payload.issues.push({
      origin,
      code: "too_big",
      maximum: typeof def.value === "object" ? def.value.getTime() : def.value,
      input: payload.value,
      inclusive: def.inclusive,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckGreaterThan = /* @__PURE__ */ $constructor("$ZodCheckGreaterThan", (inst, def) => {
  $ZodCheck.init(inst, def);
  const origin = numericOriginMap[typeof def.value];
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    const curr = (def.inclusive ? bag.minimum : bag.exclusiveMinimum) ?? Number.NEGATIVE_INFINITY;
    if (def.value > curr) {
      if (def.inclusive)
        bag.minimum = def.value;
      else
        bag.exclusiveMinimum = def.value;
    }
  });
  inst._zod.check = (payload) => {
    if (def.inclusive ? payload.value >= def.value : payload.value > def.value) {
      return;
    }
    payload.issues.push({
      origin,
      code: "too_small",
      minimum: typeof def.value === "object" ? def.value.getTime() : def.value,
      input: payload.value,
      inclusive: def.inclusive,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckMultipleOf = /* @__PURE__ */ $constructor("$ZodCheckMultipleOf", (inst, def) => {
  $ZodCheck.init(inst, def);
  inst._zod.onattach.push((inst2) => {
    var _a2;
    (_a2 = inst2._zod.bag).multipleOf ?? (_a2.multipleOf = def.value);
  });
  inst._zod.check = (payload) => {
    if (typeof payload.value !== typeof def.value)
      throw new Error("Cannot mix number and bigint in multiple_of check.");
    const isMultiple = typeof payload.value === "bigint" ? payload.value % def.value === BigInt(0) : floatSafeRemainder(payload.value, def.value) === 0;
    if (isMultiple)
      return;
    payload.issues.push({
      origin: typeof payload.value,
      code: "not_multiple_of",
      divisor: def.value,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckNumberFormat = /* @__PURE__ */ $constructor("$ZodCheckNumberFormat", (inst, def) => {
  $ZodCheck.init(inst, def);
  def.format = def.format || "float64";
  const isInt = def.format?.includes("int");
  const origin = isInt ? "int" : "number";
  const [minimum, maximum] = NUMBER_FORMAT_RANGES[def.format];
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.format = def.format;
    bag.minimum = minimum;
    bag.maximum = maximum;
    if (isInt)
      bag.pattern = integer;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    if (isInt) {
      if (!Number.isInteger(input)) {
        payload.issues.push({
          expected: origin,
          format: def.format,
          code: "invalid_type",
          continue: false,
          input,
          inst
        });
        return;
      }
      if (!Number.isSafeInteger(input)) {
        if (input > 0) {
          payload.issues.push({
            input,
            code: "too_big",
            maximum: Number.MAX_SAFE_INTEGER,
            note: "Integers must be within the safe integer range.",
            inst,
            origin,
            inclusive: true,
            continue: !def.abort
          });
        } else {
          payload.issues.push({
            input,
            code: "too_small",
            minimum: Number.MIN_SAFE_INTEGER,
            note: "Integers must be within the safe integer range.",
            inst,
            origin,
            inclusive: true,
            continue: !def.abort
          });
        }
        return;
      }
    }
    if (input < minimum) {
      payload.issues.push({
        origin: "number",
        input,
        code: "too_small",
        minimum,
        inclusive: true,
        inst,
        continue: !def.abort
      });
    }
    if (input > maximum) {
      payload.issues.push({
        origin: "number",
        input,
        code: "too_big",
        maximum,
        inclusive: true,
        inst,
        continue: !def.abort
      });
    }
  };
});
var $ZodCheckBigIntFormat = /* @__PURE__ */ $constructor("$ZodCheckBigIntFormat", (inst, def) => {
  $ZodCheck.init(inst, def);
  const [minimum, maximum] = BIGINT_FORMAT_RANGES[def.format];
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.format = def.format;
    bag.minimum = minimum;
    bag.maximum = maximum;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    if (input < minimum) {
      payload.issues.push({
        origin: "bigint",
        input,
        code: "too_small",
        minimum,
        inclusive: true,
        inst,
        continue: !def.abort
      });
    }
    if (input > maximum) {
      payload.issues.push({
        origin: "bigint",
        input,
        code: "too_big",
        maximum,
        inclusive: true,
        inst,
        continue: !def.abort
      });
    }
  };
});
var $ZodCheckMaxSize = /* @__PURE__ */ $constructor("$ZodCheckMaxSize", (inst, def) => {
  var _a2;
  $ZodCheck.init(inst, def);
  (_a2 = inst._zod.def).when ?? (_a2.when = (payload) => {
    const val = payload.value;
    return !nullish(val) && val.size !== void 0;
  });
  inst._zod.onattach.push((inst2) => {
    const curr = inst2._zod.bag.maximum ?? Number.POSITIVE_INFINITY;
    if (def.maximum < curr)
      inst2._zod.bag.maximum = def.maximum;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    const size = input.size;
    if (size <= def.maximum)
      return;
    payload.issues.push({
      origin: getSizableOrigin(input),
      code: "too_big",
      maximum: def.maximum,
      inclusive: true,
      input,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckMinSize = /* @__PURE__ */ $constructor("$ZodCheckMinSize", (inst, def) => {
  var _a2;
  $ZodCheck.init(inst, def);
  (_a2 = inst._zod.def).when ?? (_a2.when = (payload) => {
    const val = payload.value;
    return !nullish(val) && val.size !== void 0;
  });
  inst._zod.onattach.push((inst2) => {
    const curr = inst2._zod.bag.minimum ?? Number.NEGATIVE_INFINITY;
    if (def.minimum > curr)
      inst2._zod.bag.minimum = def.minimum;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    const size = input.size;
    if (size >= def.minimum)
      return;
    payload.issues.push({
      origin: getSizableOrigin(input),
      code: "too_small",
      minimum: def.minimum,
      inclusive: true,
      input,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckSizeEquals = /* @__PURE__ */ $constructor("$ZodCheckSizeEquals", (inst, def) => {
  var _a2;
  $ZodCheck.init(inst, def);
  (_a2 = inst._zod.def).when ?? (_a2.when = (payload) => {
    const val = payload.value;
    return !nullish(val) && val.size !== void 0;
  });
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.minimum = def.size;
    bag.maximum = def.size;
    bag.size = def.size;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    const size = input.size;
    if (size === def.size)
      return;
    const tooBig = size > def.size;
    payload.issues.push({
      origin: getSizableOrigin(input),
      ...tooBig ? { code: "too_big", maximum: def.size } : { code: "too_small", minimum: def.size },
      inclusive: true,
      exact: true,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckMaxLength = /* @__PURE__ */ $constructor("$ZodCheckMaxLength", (inst, def) => {
  var _a2;
  $ZodCheck.init(inst, def);
  (_a2 = inst._zod.def).when ?? (_a2.when = (payload) => {
    const val = payload.value;
    return !nullish(val) && val.length !== void 0;
  });
  inst._zod.onattach.push((inst2) => {
    const curr = inst2._zod.bag.maximum ?? Number.POSITIVE_INFINITY;
    if (def.maximum < curr)
      inst2._zod.bag.maximum = def.maximum;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    const length = input.length;
    if (length <= def.maximum)
      return;
    const origin = getLengthableOrigin(input);
    payload.issues.push({
      origin,
      code: "too_big",
      maximum: def.maximum,
      inclusive: true,
      input,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckMinLength = /* @__PURE__ */ $constructor("$ZodCheckMinLength", (inst, def) => {
  var _a2;
  $ZodCheck.init(inst, def);
  (_a2 = inst._zod.def).when ?? (_a2.when = (payload) => {
    const val = payload.value;
    return !nullish(val) && val.length !== void 0;
  });
  inst._zod.onattach.push((inst2) => {
    const curr = inst2._zod.bag.minimum ?? Number.NEGATIVE_INFINITY;
    if (def.minimum > curr)
      inst2._zod.bag.minimum = def.minimum;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    const length = input.length;
    if (length >= def.minimum)
      return;
    const origin = getLengthableOrigin(input);
    payload.issues.push({
      origin,
      code: "too_small",
      minimum: def.minimum,
      inclusive: true,
      input,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckLengthEquals = /* @__PURE__ */ $constructor("$ZodCheckLengthEquals", (inst, def) => {
  var _a2;
  $ZodCheck.init(inst, def);
  (_a2 = inst._zod.def).when ?? (_a2.when = (payload) => {
    const val = payload.value;
    return !nullish(val) && val.length !== void 0;
  });
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.minimum = def.length;
    bag.maximum = def.length;
    bag.length = def.length;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    const length = input.length;
    if (length === def.length)
      return;
    const origin = getLengthableOrigin(input);
    const tooBig = length > def.length;
    payload.issues.push({
      origin,
      ...tooBig ? { code: "too_big", maximum: def.length } : { code: "too_small", minimum: def.length },
      inclusive: true,
      exact: true,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckStringFormat = /* @__PURE__ */ $constructor("$ZodCheckStringFormat", (inst, def) => {
  var _a2, _b;
  $ZodCheck.init(inst, def);
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.format = def.format;
    if (def.pattern) {
      bag.patterns ?? (bag.patterns = /* @__PURE__ */ new Set());
      bag.patterns.add(def.pattern);
    }
  });
  if (def.pattern)
    (_a2 = inst._zod).check ?? (_a2.check = (payload) => {
      def.pattern.lastIndex = 0;
      if (def.pattern.test(payload.value))
        return;
      payload.issues.push({
        origin: "string",
        code: "invalid_format",
        format: def.format,
        input: payload.value,
        ...def.pattern ? { pattern: def.pattern.toString() } : {},
        inst,
        continue: !def.abort
      });
    });
  else
    (_b = inst._zod).check ?? (_b.check = () => {
    });
});
var $ZodCheckRegex = /* @__PURE__ */ $constructor("$ZodCheckRegex", (inst, def) => {
  $ZodCheckStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    def.pattern.lastIndex = 0;
    if (def.pattern.test(payload.value))
      return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "regex",
      input: payload.value,
      pattern: def.pattern.toString(),
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckLowerCase = /* @__PURE__ */ $constructor("$ZodCheckLowerCase", (inst, def) => {
  def.pattern ?? (def.pattern = lowercase);
  $ZodCheckStringFormat.init(inst, def);
});
var $ZodCheckUpperCase = /* @__PURE__ */ $constructor("$ZodCheckUpperCase", (inst, def) => {
  def.pattern ?? (def.pattern = uppercase);
  $ZodCheckStringFormat.init(inst, def);
});
var $ZodCheckIncludes = /* @__PURE__ */ $constructor("$ZodCheckIncludes", (inst, def) => {
  $ZodCheck.init(inst, def);
  const escapedRegex = escapeRegex(def.includes);
  const pattern = new RegExp(typeof def.position === "number" ? `^.{${def.position}}${escapedRegex}` : escapedRegex);
  def.pattern = pattern;
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.patterns ?? (bag.patterns = /* @__PURE__ */ new Set());
    bag.patterns.add(pattern);
  });
  inst._zod.check = (payload) => {
    if (payload.value.includes(def.includes, def.position))
      return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "includes",
      includes: def.includes,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckStartsWith = /* @__PURE__ */ $constructor("$ZodCheckStartsWith", (inst, def) => {
  $ZodCheck.init(inst, def);
  const pattern = new RegExp(`^${escapeRegex(def.prefix)}.*`);
  def.pattern ?? (def.pattern = pattern);
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.patterns ?? (bag.patterns = /* @__PURE__ */ new Set());
    bag.patterns.add(pattern);
  });
  inst._zod.check = (payload) => {
    if (payload.value.startsWith(def.prefix))
      return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "starts_with",
      prefix: def.prefix,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckEndsWith = /* @__PURE__ */ $constructor("$ZodCheckEndsWith", (inst, def) => {
  $ZodCheck.init(inst, def);
  const pattern = new RegExp(`.*${escapeRegex(def.suffix)}$`);
  def.pattern ?? (def.pattern = pattern);
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.patterns ?? (bag.patterns = /* @__PURE__ */ new Set());
    bag.patterns.add(pattern);
  });
  inst._zod.check = (payload) => {
    if (payload.value.endsWith(def.suffix))
      return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "ends_with",
      suffix: def.suffix,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
function handleCheckPropertyResult(result, payload, property) {
  if (result.issues.length) {
    payload.issues.push(...prefixIssues(property, result.issues));
  }
}
var $ZodCheckProperty = /* @__PURE__ */ $constructor("$ZodCheckProperty", (inst, def) => {
  $ZodCheck.init(inst, def);
  inst._zod.check = (payload) => {
    const result = def.schema._zod.run({
      value: payload.value[def.property],
      issues: []
    }, {});
    if (result instanceof Promise) {
      return result.then((result2) => handleCheckPropertyResult(result2, payload, def.property));
    }
    handleCheckPropertyResult(result, payload, def.property);
    return;
  };
});
var $ZodCheckMimeType = /* @__PURE__ */ $constructor("$ZodCheckMimeType", (inst, def) => {
  $ZodCheck.init(inst, def);
  const mimeSet = new Set(def.mime);
  inst._zod.onattach.push((inst2) => {
    inst2._zod.bag.mime = def.mime;
  });
  inst._zod.check = (payload) => {
    if (mimeSet.has(payload.value.type))
      return;
    payload.issues.push({
      code: "invalid_value",
      values: def.mime,
      input: payload.value.type,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckOverwrite = /* @__PURE__ */ $constructor("$ZodCheckOverwrite", (inst, def) => {
  $ZodCheck.init(inst, def);
  inst._zod.check = (payload) => {
    payload.value = def.tx(payload.value);
  };
});

// node_modules/zod/v4/core/doc.js
var Doc = class {
  constructor(args = []) {
    this.content = [];
    this.indent = 0;
    if (this)
      this.args = args;
  }
  indented(fn) {
    this.indent += 1;
    fn(this);
    this.indent -= 1;
  }
  write(arg) {
    if (typeof arg === "function") {
      arg(this, { execution: "sync" });
      arg(this, { execution: "async" });
      return;
    }
    const content = arg;
    const lines = content.split("\n").filter((x) => x);
    const minIndent = Math.min(...lines.map((x) => x.length - x.trimStart().length));
    const dedented = lines.map((x) => x.slice(minIndent)).map((x) => " ".repeat(this.indent * 2) + x);
    for (const line of dedented) {
      this.content.push(line);
    }
  }
  compile() {
    const F = Function;
    const args = this?.args;
    const content = this?.content ?? [``];
    const lines = [...content.map((x) => `  ${x}`)];
    return new F(...args, lines.join("\n"));
  }
};

// node_modules/zod/v4/core/versions.js
var version = {
  major: 4,
  minor: 3,
  patch: 6
};

// node_modules/zod/v4/core/schemas.js
var $ZodType = /* @__PURE__ */ $constructor("$ZodType", (inst, def) => {
  var _a2;
  inst ?? (inst = {});
  inst._zod.def = def;
  inst._zod.bag = inst._zod.bag || {};
  inst._zod.version = version;
  const checks = [...inst._zod.def.checks ?? []];
  if (inst._zod.traits.has("$ZodCheck")) {
    checks.unshift(inst);
  }
  for (const ch of checks) {
    for (const fn of ch._zod.onattach) {
      fn(inst);
    }
  }
  if (checks.length === 0) {
    (_a2 = inst._zod).deferred ?? (_a2.deferred = []);
    inst._zod.deferred?.push(() => {
      inst._zod.run = inst._zod.parse;
    });
  } else {
    const runChecks = (payload, checks2, ctx) => {
      let isAborted = aborted(payload);
      let asyncResult;
      for (const ch of checks2) {
        if (ch._zod.def.when) {
          const shouldRun = ch._zod.def.when(payload);
          if (!shouldRun)
            continue;
        } else if (isAborted) {
          continue;
        }
        const currLen = payload.issues.length;
        const _ = ch._zod.check(payload);
        if (_ instanceof Promise && ctx?.async === false) {
          throw new $ZodAsyncError();
        }
        if (asyncResult || _ instanceof Promise) {
          asyncResult = (asyncResult ?? Promise.resolve()).then(async () => {
            await _;
            const nextLen = payload.issues.length;
            if (nextLen === currLen)
              return;
            if (!isAborted)
              isAborted = aborted(payload, currLen);
          });
        } else {
          const nextLen = payload.issues.length;
          if (nextLen === currLen)
            continue;
          if (!isAborted)
            isAborted = aborted(payload, currLen);
        }
      }
      if (asyncResult) {
        return asyncResult.then(() => {
          return payload;
        });
      }
      return payload;
    };
    const handleCanaryResult = (canary, payload, ctx) => {
      if (aborted(canary)) {
        canary.aborted = true;
        return canary;
      }
      const checkResult = runChecks(payload, checks, ctx);
      if (checkResult instanceof Promise) {
        if (ctx.async === false)
          throw new $ZodAsyncError();
        return checkResult.then((checkResult2) => inst._zod.parse(checkResult2, ctx));
      }
      return inst._zod.parse(checkResult, ctx);
    };
    inst._zod.run = (payload, ctx) => {
      if (ctx.skipChecks) {
        return inst._zod.parse(payload, ctx);
      }
      if (ctx.direction === "backward") {
        const canary = inst._zod.parse({ value: payload.value, issues: [] }, { ...ctx, skipChecks: true });
        if (canary instanceof Promise) {
          return canary.then((canary2) => {
            return handleCanaryResult(canary2, payload, ctx);
          });
        }
        return handleCanaryResult(canary, payload, ctx);
      }
      const result = inst._zod.parse(payload, ctx);
      if (result instanceof Promise) {
        if (ctx.async === false)
          throw new $ZodAsyncError();
        return result.then((result2) => runChecks(result2, checks, ctx));
      }
      return runChecks(result, checks, ctx);
    };
  }
  defineLazy(inst, "~standard", () => ({
    validate: (value) => {
      try {
        const r = safeParse(inst, value);
        return r.success ? { value: r.data } : { issues: r.error?.issues };
      } catch (_) {
        return safeParseAsync(inst, value).then((r) => r.success ? { value: r.data } : { issues: r.error?.issues });
      }
    },
    vendor: "zod",
    version: 1
  }));
});
var $ZodString = /* @__PURE__ */ $constructor("$ZodString", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = [...inst?._zod.bag?.patterns ?? []].pop() ?? string(inst._zod.bag);
  inst._zod.parse = (payload, _) => {
    if (def.coerce)
      try {
        payload.value = String(payload.value);
      } catch (_2) {
      }
    if (typeof payload.value === "string")
      return payload;
    payload.issues.push({
      expected: "string",
      code: "invalid_type",
      input: payload.value,
      inst
    });
    return payload;
  };
});
var $ZodStringFormat = /* @__PURE__ */ $constructor("$ZodStringFormat", (inst, def) => {
  $ZodCheckStringFormat.init(inst, def);
  $ZodString.init(inst, def);
});
var $ZodGUID = /* @__PURE__ */ $constructor("$ZodGUID", (inst, def) => {
  def.pattern ?? (def.pattern = guid);
  $ZodStringFormat.init(inst, def);
});
var $ZodUUID = /* @__PURE__ */ $constructor("$ZodUUID", (inst, def) => {
  if (def.version) {
    const versionMap = {
      v1: 1,
      v2: 2,
      v3: 3,
      v4: 4,
      v5: 5,
      v6: 6,
      v7: 7,
      v8: 8
    };
    const v = versionMap[def.version];
    if (v === void 0)
      throw new Error(`Invalid UUID version: "${def.version}"`);
    def.pattern ?? (def.pattern = uuid(v));
  } else
    def.pattern ?? (def.pattern = uuid());
  $ZodStringFormat.init(inst, def);
});
var $ZodEmail = /* @__PURE__ */ $constructor("$ZodEmail", (inst, def) => {
  def.pattern ?? (def.pattern = email);
  $ZodStringFormat.init(inst, def);
});
var $ZodURL = /* @__PURE__ */ $constructor("$ZodURL", (inst, def) => {
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    try {
      const trimmed = payload.value.trim();
      const url2 = new URL(trimmed);
      if (def.hostname) {
        def.hostname.lastIndex = 0;
        if (!def.hostname.test(url2.hostname)) {
          payload.issues.push({
            code: "invalid_format",
            format: "url",
            note: "Invalid hostname",
            pattern: def.hostname.source,
            input: payload.value,
            inst,
            continue: !def.abort
          });
        }
      }
      if (def.protocol) {
        def.protocol.lastIndex = 0;
        if (!def.protocol.test(url2.protocol.endsWith(":") ? url2.protocol.slice(0, -1) : url2.protocol)) {
          payload.issues.push({
            code: "invalid_format",
            format: "url",
            note: "Invalid protocol",
            pattern: def.protocol.source,
            input: payload.value,
            inst,
            continue: !def.abort
          });
        }
      }
      if (def.normalize) {
        payload.value = url2.href;
      } else {
        payload.value = trimmed;
      }
      return;
    } catch (_) {
      payload.issues.push({
        code: "invalid_format",
        format: "url",
        input: payload.value,
        inst,
        continue: !def.abort
      });
    }
  };
});
var $ZodEmoji = /* @__PURE__ */ $constructor("$ZodEmoji", (inst, def) => {
  def.pattern ?? (def.pattern = emoji());
  $ZodStringFormat.init(inst, def);
});
var $ZodNanoID = /* @__PURE__ */ $constructor("$ZodNanoID", (inst, def) => {
  def.pattern ?? (def.pattern = nanoid);
  $ZodStringFormat.init(inst, def);
});
var $ZodCUID = /* @__PURE__ */ $constructor("$ZodCUID", (inst, def) => {
  def.pattern ?? (def.pattern = cuid);
  $ZodStringFormat.init(inst, def);
});
var $ZodCUID2 = /* @__PURE__ */ $constructor("$ZodCUID2", (inst, def) => {
  def.pattern ?? (def.pattern = cuid2);
  $ZodStringFormat.init(inst, def);
});
var $ZodULID = /* @__PURE__ */ $constructor("$ZodULID", (inst, def) => {
  def.pattern ?? (def.pattern = ulid);
  $ZodStringFormat.init(inst, def);
});
var $ZodXID = /* @__PURE__ */ $constructor("$ZodXID", (inst, def) => {
  def.pattern ?? (def.pattern = xid);
  $ZodStringFormat.init(inst, def);
});
var $ZodKSUID = /* @__PURE__ */ $constructor("$ZodKSUID", (inst, def) => {
  def.pattern ?? (def.pattern = ksuid);
  $ZodStringFormat.init(inst, def);
});
var $ZodISODateTime = /* @__PURE__ */ $constructor("$ZodISODateTime", (inst, def) => {
  def.pattern ?? (def.pattern = datetime(def));
  $ZodStringFormat.init(inst, def);
});
var $ZodISODate = /* @__PURE__ */ $constructor("$ZodISODate", (inst, def) => {
  def.pattern ?? (def.pattern = date);
  $ZodStringFormat.init(inst, def);
});
var $ZodISOTime = /* @__PURE__ */ $constructor("$ZodISOTime", (inst, def) => {
  def.pattern ?? (def.pattern = time(def));
  $ZodStringFormat.init(inst, def);
});
var $ZodISODuration = /* @__PURE__ */ $constructor("$ZodISODuration", (inst, def) => {
  def.pattern ?? (def.pattern = duration);
  $ZodStringFormat.init(inst, def);
});
var $ZodIPv4 = /* @__PURE__ */ $constructor("$ZodIPv4", (inst, def) => {
  def.pattern ?? (def.pattern = ipv4);
  $ZodStringFormat.init(inst, def);
  inst._zod.bag.format = `ipv4`;
});
var $ZodIPv6 = /* @__PURE__ */ $constructor("$ZodIPv6", (inst, def) => {
  def.pattern ?? (def.pattern = ipv6);
  $ZodStringFormat.init(inst, def);
  inst._zod.bag.format = `ipv6`;
  inst._zod.check = (payload) => {
    try {
      new URL(`http://[${payload.value}]`);
    } catch {
      payload.issues.push({
        code: "invalid_format",
        format: "ipv6",
        input: payload.value,
        inst,
        continue: !def.abort
      });
    }
  };
});
var $ZodMAC = /* @__PURE__ */ $constructor("$ZodMAC", (inst, def) => {
  def.pattern ?? (def.pattern = mac(def.delimiter));
  $ZodStringFormat.init(inst, def);
  inst._zod.bag.format = `mac`;
});
var $ZodCIDRv4 = /* @__PURE__ */ $constructor("$ZodCIDRv4", (inst, def) => {
  def.pattern ?? (def.pattern = cidrv4);
  $ZodStringFormat.init(inst, def);
});
var $ZodCIDRv6 = /* @__PURE__ */ $constructor("$ZodCIDRv6", (inst, def) => {
  def.pattern ?? (def.pattern = cidrv6);
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    const parts = payload.value.split("/");
    try {
      if (parts.length !== 2)
        throw new Error();
      const [address, prefix] = parts;
      if (!prefix)
        throw new Error();
      const prefixNum = Number(prefix);
      if (`${prefixNum}` !== prefix)
        throw new Error();
      if (prefixNum < 0 || prefixNum > 128)
        throw new Error();
      new URL(`http://[${address}]`);
    } catch {
      payload.issues.push({
        code: "invalid_format",
        format: "cidrv6",
        input: payload.value,
        inst,
        continue: !def.abort
      });
    }
  };
});
function isValidBase64(data) {
  if (data === "")
    return true;
  if (data.length % 4 !== 0)
    return false;
  try {
    atob(data);
    return true;
  } catch {
    return false;
  }
}
var $ZodBase64 = /* @__PURE__ */ $constructor("$ZodBase64", (inst, def) => {
  def.pattern ?? (def.pattern = base64);
  $ZodStringFormat.init(inst, def);
  inst._zod.bag.contentEncoding = "base64";
  inst._zod.check = (payload) => {
    if (isValidBase64(payload.value))
      return;
    payload.issues.push({
      code: "invalid_format",
      format: "base64",
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
function isValidBase64URL(data) {
  if (!base64url.test(data))
    return false;
  const base643 = data.replace(/[-_]/g, (c) => c === "-" ? "+" : "/");
  const padded = base643.padEnd(Math.ceil(base643.length / 4) * 4, "=");
  return isValidBase64(padded);
}
var $ZodBase64URL = /* @__PURE__ */ $constructor("$ZodBase64URL", (inst, def) => {
  def.pattern ?? (def.pattern = base64url);
  $ZodStringFormat.init(inst, def);
  inst._zod.bag.contentEncoding = "base64url";
  inst._zod.check = (payload) => {
    if (isValidBase64URL(payload.value))
      return;
    payload.issues.push({
      code: "invalid_format",
      format: "base64url",
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodE164 = /* @__PURE__ */ $constructor("$ZodE164", (inst, def) => {
  def.pattern ?? (def.pattern = e164);
  $ZodStringFormat.init(inst, def);
});
function isValidJWT(token, algorithm = null) {
  try {
    const tokensParts = token.split(".");
    if (tokensParts.length !== 3)
      return false;
    const [header] = tokensParts;
    if (!header)
      return false;
    const parsedHeader = JSON.parse(atob(header));
    if ("typ" in parsedHeader && parsedHeader?.typ !== "JWT")
      return false;
    if (!parsedHeader.alg)
      return false;
    if (algorithm && (!("alg" in parsedHeader) || parsedHeader.alg !== algorithm))
      return false;
    return true;
  } catch {
    return false;
  }
}
var $ZodJWT = /* @__PURE__ */ $constructor("$ZodJWT", (inst, def) => {
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    if (isValidJWT(payload.value, def.alg))
      return;
    payload.issues.push({
      code: "invalid_format",
      format: "jwt",
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCustomStringFormat = /* @__PURE__ */ $constructor("$ZodCustomStringFormat", (inst, def) => {
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    if (def.fn(payload.value))
      return;
    payload.issues.push({
      code: "invalid_format",
      format: def.format,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodNumber = /* @__PURE__ */ $constructor("$ZodNumber", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = inst._zod.bag.pattern ?? number;
  inst._zod.parse = (payload, _ctx) => {
    if (def.coerce)
      try {
        payload.value = Number(payload.value);
      } catch (_) {
      }
    const input = payload.value;
    if (typeof input === "number" && !Number.isNaN(input) && Number.isFinite(input)) {
      return payload;
    }
    const received = typeof input === "number" ? Number.isNaN(input) ? "NaN" : !Number.isFinite(input) ? "Infinity" : void 0 : void 0;
    payload.issues.push({
      expected: "number",
      code: "invalid_type",
      input,
      inst,
      ...received ? { received } : {}
    });
    return payload;
  };
});
var $ZodNumberFormat = /* @__PURE__ */ $constructor("$ZodNumberFormat", (inst, def) => {
  $ZodCheckNumberFormat.init(inst, def);
  $ZodNumber.init(inst, def);
});
var $ZodBoolean = /* @__PURE__ */ $constructor("$ZodBoolean", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = boolean;
  inst._zod.parse = (payload, _ctx) => {
    if (def.coerce)
      try {
        payload.value = Boolean(payload.value);
      } catch (_) {
      }
    const input = payload.value;
    if (typeof input === "boolean")
      return payload;
    payload.issues.push({
      expected: "boolean",
      code: "invalid_type",
      input,
      inst
    });
    return payload;
  };
});
var $ZodBigInt = /* @__PURE__ */ $constructor("$ZodBigInt", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = bigint;
  inst._zod.parse = (payload, _ctx) => {
    if (def.coerce)
      try {
        payload.value = BigInt(payload.value);
      } catch (_) {
      }
    if (typeof payload.value === "bigint")
      return payload;
    payload.issues.push({
      expected: "bigint",
      code: "invalid_type",
      input: payload.value,
      inst
    });
    return payload;
  };
});
var $ZodBigIntFormat = /* @__PURE__ */ $constructor("$ZodBigIntFormat", (inst, def) => {
  $ZodCheckBigIntFormat.init(inst, def);
  $ZodBigInt.init(inst, def);
});
var $ZodSymbol = /* @__PURE__ */ $constructor("$ZodSymbol", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (typeof input === "symbol")
      return payload;
    payload.issues.push({
      expected: "symbol",
      code: "invalid_type",
      input,
      inst
    });
    return payload;
  };
});
var $ZodUndefined = /* @__PURE__ */ $constructor("$ZodUndefined", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = _undefined;
  inst._zod.values = /* @__PURE__ */ new Set([void 0]);
  inst._zod.optin = "optional";
  inst._zod.optout = "optional";
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (typeof input === "undefined")
      return payload;
    payload.issues.push({
      expected: "undefined",
      code: "invalid_type",
      input,
      inst
    });
    return payload;
  };
});
var $ZodNull = /* @__PURE__ */ $constructor("$ZodNull", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = _null;
  inst._zod.values = /* @__PURE__ */ new Set([null]);
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (input === null)
      return payload;
    payload.issues.push({
      expected: "null",
      code: "invalid_type",
      input,
      inst
    });
    return payload;
  };
});
var $ZodAny = /* @__PURE__ */ $constructor("$ZodAny", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload) => payload;
});
var $ZodUnknown = /* @__PURE__ */ $constructor("$ZodUnknown", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload) => payload;
});
var $ZodNever = /* @__PURE__ */ $constructor("$ZodNever", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, _ctx) => {
    payload.issues.push({
      expected: "never",
      code: "invalid_type",
      input: payload.value,
      inst
    });
    return payload;
  };
});
var $ZodVoid = /* @__PURE__ */ $constructor("$ZodVoid", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (typeof input === "undefined")
      return payload;
    payload.issues.push({
      expected: "void",
      code: "invalid_type",
      input,
      inst
    });
    return payload;
  };
});
var $ZodDate = /* @__PURE__ */ $constructor("$ZodDate", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, _ctx) => {
    if (def.coerce) {
      try {
        payload.value = new Date(payload.value);
      } catch (_err) {
      }
    }
    const input = payload.value;
    const isDate = input instanceof Date;
    const isValidDate = isDate && !Number.isNaN(input.getTime());
    if (isValidDate)
      return payload;
    payload.issues.push({
      expected: "date",
      code: "invalid_type",
      input,
      ...isDate ? { received: "Invalid Date" } : {},
      inst
    });
    return payload;
  };
});
function handleArrayResult(result, final, index) {
  if (result.issues.length) {
    final.issues.push(...prefixIssues(index, result.issues));
  }
  final.value[index] = result.value;
}
var $ZodArray = /* @__PURE__ */ $constructor("$ZodArray", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!Array.isArray(input)) {
      payload.issues.push({
        expected: "array",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    payload.value = Array(input.length);
    const proms = [];
    for (let i = 0; i < input.length; i++) {
      const item = input[i];
      const result = def.element._zod.run({
        value: item,
        issues: []
      }, ctx);
      if (result instanceof Promise) {
        proms.push(result.then((result2) => handleArrayResult(result2, payload, i)));
      } else {
        handleArrayResult(result, payload, i);
      }
    }
    if (proms.length) {
      return Promise.all(proms).then(() => payload);
    }
    return payload;
  };
});
function handlePropertyResult(result, final, key, input, isOptionalOut) {
  if (result.issues.length) {
    if (isOptionalOut && !(key in input)) {
      return;
    }
    final.issues.push(...prefixIssues(key, result.issues));
  }
  if (result.value === void 0) {
    if (key in input) {
      final.value[key] = void 0;
    }
  } else {
    final.value[key] = result.value;
  }
}
function normalizeDef(def) {
  const keys = Object.keys(def.shape);
  for (const k of keys) {
    if (!def.shape?.[k]?._zod?.traits?.has("$ZodType")) {
      throw new Error(`Invalid element at key "${k}": expected a Zod schema`);
    }
  }
  const okeys = optionalKeys(def.shape);
  return {
    ...def,
    keys,
    keySet: new Set(keys),
    numKeys: keys.length,
    optionalKeys: new Set(okeys)
  };
}
function handleCatchall(proms, input, payload, ctx, def, inst) {
  const unrecognized = [];
  const keySet = def.keySet;
  const _catchall = def.catchall._zod;
  const t = _catchall.def.type;
  const isOptionalOut = _catchall.optout === "optional";
  for (const key in input) {
    if (keySet.has(key))
      continue;
    if (t === "never") {
      unrecognized.push(key);
      continue;
    }
    const r = _catchall.run({ value: input[key], issues: [] }, ctx);
    if (r instanceof Promise) {
      proms.push(r.then((r2) => handlePropertyResult(r2, payload, key, input, isOptionalOut)));
    } else {
      handlePropertyResult(r, payload, key, input, isOptionalOut);
    }
  }
  if (unrecognized.length) {
    payload.issues.push({
      code: "unrecognized_keys",
      keys: unrecognized,
      input,
      inst
    });
  }
  if (!proms.length)
    return payload;
  return Promise.all(proms).then(() => {
    return payload;
  });
}
var $ZodObject = /* @__PURE__ */ $constructor("$ZodObject", (inst, def) => {
  $ZodType.init(inst, def);
  const desc = Object.getOwnPropertyDescriptor(def, "shape");
  if (!desc?.get) {
    const sh = def.shape;
    Object.defineProperty(def, "shape", {
      get: () => {
        const newSh = { ...sh };
        Object.defineProperty(def, "shape", {
          value: newSh
        });
        return newSh;
      }
    });
  }
  const _normalized = cached(() => normalizeDef(def));
  defineLazy(inst._zod, "propValues", () => {
    const shape = def.shape;
    const propValues = {};
    for (const key in shape) {
      const field = shape[key]._zod;
      if (field.values) {
        propValues[key] ?? (propValues[key] = /* @__PURE__ */ new Set());
        for (const v of field.values)
          propValues[key].add(v);
      }
    }
    return propValues;
  });
  const isObject2 = isObject;
  const catchall = def.catchall;
  let value;
  inst._zod.parse = (payload, ctx) => {
    value ?? (value = _normalized.value);
    const input = payload.value;
    if (!isObject2(input)) {
      payload.issues.push({
        expected: "object",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    payload.value = {};
    const proms = [];
    const shape = value.shape;
    for (const key of value.keys) {
      const el = shape[key];
      const isOptionalOut = el._zod.optout === "optional";
      const r = el._zod.run({ value: input[key], issues: [] }, ctx);
      if (r instanceof Promise) {
        proms.push(r.then((r2) => handlePropertyResult(r2, payload, key, input, isOptionalOut)));
      } else {
        handlePropertyResult(r, payload, key, input, isOptionalOut);
      }
    }
    if (!catchall) {
      return proms.length ? Promise.all(proms).then(() => payload) : payload;
    }
    return handleCatchall(proms, input, payload, ctx, _normalized.value, inst);
  };
});
var $ZodObjectJIT = /* @__PURE__ */ $constructor("$ZodObjectJIT", (inst, def) => {
  $ZodObject.init(inst, def);
  const superParse = inst._zod.parse;
  const _normalized = cached(() => normalizeDef(def));
  const generateFastpass = (shape) => {
    const doc = new Doc(["shape", "payload", "ctx"]);
    const normalized = _normalized.value;
    const parseStr = (key) => {
      const k = esc(key);
      return `shape[${k}]._zod.run({ value: input[${k}], issues: [] }, ctx)`;
    };
    doc.write(`const input = payload.value;`);
    const ids = /* @__PURE__ */ Object.create(null);
    let counter = 0;
    for (const key of normalized.keys) {
      ids[key] = `key_${counter++}`;
    }
    doc.write(`const newResult = {};`);
    for (const key of normalized.keys) {
      const id = ids[key];
      const k = esc(key);
      const schema = shape[key];
      const isOptionalOut = schema?._zod?.optout === "optional";
      doc.write(`const ${id} = ${parseStr(key)};`);
      if (isOptionalOut) {
        doc.write(`
        if (${id}.issues.length) {
          if (${k} in input) {
            payload.issues = payload.issues.concat(${id}.issues.map(iss => ({
              ...iss,
              path: iss.path ? [${k}, ...iss.path] : [${k}]
            })));
          }
        }
        
        if (${id}.value === undefined) {
          if (${k} in input) {
            newResult[${k}] = undefined;
          }
        } else {
          newResult[${k}] = ${id}.value;
        }
        
      `);
      } else {
        doc.write(`
        if (${id}.issues.length) {
          payload.issues = payload.issues.concat(${id}.issues.map(iss => ({
            ...iss,
            path: iss.path ? [${k}, ...iss.path] : [${k}]
          })));
        }
        
        if (${id}.value === undefined) {
          if (${k} in input) {
            newResult[${k}] = undefined;
          }
        } else {
          newResult[${k}] = ${id}.value;
        }
        
      `);
      }
    }
    doc.write(`payload.value = newResult;`);
    doc.write(`return payload;`);
    const fn = doc.compile();
    return (payload, ctx) => fn(shape, payload, ctx);
  };
  let fastpass;
  const isObject2 = isObject;
  const jit = !globalConfig.jitless;
  const allowsEval2 = allowsEval;
  const fastEnabled = jit && allowsEval2.value;
  const catchall = def.catchall;
  let value;
  inst._zod.parse = (payload, ctx) => {
    value ?? (value = _normalized.value);
    const input = payload.value;
    if (!isObject2(input)) {
      payload.issues.push({
        expected: "object",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    if (jit && fastEnabled && ctx?.async === false && ctx.jitless !== true) {
      if (!fastpass)
        fastpass = generateFastpass(def.shape);
      payload = fastpass(payload, ctx);
      if (!catchall)
        return payload;
      return handleCatchall([], input, payload, ctx, value, inst);
    }
    return superParse(payload, ctx);
  };
});
function handleUnionResults(results, final, inst, ctx) {
  for (const result of results) {
    if (result.issues.length === 0) {
      final.value = result.value;
      return final;
    }
  }
  const nonaborted = results.filter((r) => !aborted(r));
  if (nonaborted.length === 1) {
    final.value = nonaborted[0].value;
    return nonaborted[0];
  }
  final.issues.push({
    code: "invalid_union",
    input: final.value,
    inst,
    errors: results.map((result) => result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
  });
  return final;
}
var $ZodUnion = /* @__PURE__ */ $constructor("$ZodUnion", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "optin", () => def.options.some((o) => o._zod.optin === "optional") ? "optional" : void 0);
  defineLazy(inst._zod, "optout", () => def.options.some((o) => o._zod.optout === "optional") ? "optional" : void 0);
  defineLazy(inst._zod, "values", () => {
    if (def.options.every((o) => o._zod.values)) {
      return new Set(def.options.flatMap((option) => Array.from(option._zod.values)));
    }
    return void 0;
  });
  defineLazy(inst._zod, "pattern", () => {
    if (def.options.every((o) => o._zod.pattern)) {
      const patterns = def.options.map((o) => o._zod.pattern);
      return new RegExp(`^(${patterns.map((p) => cleanRegex(p.source)).join("|")})$`);
    }
    return void 0;
  });
  const single = def.options.length === 1;
  const first = def.options[0]._zod.run;
  inst._zod.parse = (payload, ctx) => {
    if (single) {
      return first(payload, ctx);
    }
    let async = false;
    const results = [];
    for (const option of def.options) {
      const result = option._zod.run({
        value: payload.value,
        issues: []
      }, ctx);
      if (result instanceof Promise) {
        results.push(result);
        async = true;
      } else {
        if (result.issues.length === 0)
          return result;
        results.push(result);
      }
    }
    if (!async)
      return handleUnionResults(results, payload, inst, ctx);
    return Promise.all(results).then((results2) => {
      return handleUnionResults(results2, payload, inst, ctx);
    });
  };
});
function handleExclusiveUnionResults(results, final, inst, ctx) {
  const successes = results.filter((r) => r.issues.length === 0);
  if (successes.length === 1) {
    final.value = successes[0].value;
    return final;
  }
  if (successes.length === 0) {
    final.issues.push({
      code: "invalid_union",
      input: final.value,
      inst,
      errors: results.map((result) => result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
    });
  } else {
    final.issues.push({
      code: "invalid_union",
      input: final.value,
      inst,
      errors: [],
      inclusive: false
    });
  }
  return final;
}
var $ZodXor = /* @__PURE__ */ $constructor("$ZodXor", (inst, def) => {
  $ZodUnion.init(inst, def);
  def.inclusive = false;
  const single = def.options.length === 1;
  const first = def.options[0]._zod.run;
  inst._zod.parse = (payload, ctx) => {
    if (single) {
      return first(payload, ctx);
    }
    let async = false;
    const results = [];
    for (const option of def.options) {
      const result = option._zod.run({
        value: payload.value,
        issues: []
      }, ctx);
      if (result instanceof Promise) {
        results.push(result);
        async = true;
      } else {
        results.push(result);
      }
    }
    if (!async)
      return handleExclusiveUnionResults(results, payload, inst, ctx);
    return Promise.all(results).then((results2) => {
      return handleExclusiveUnionResults(results2, payload, inst, ctx);
    });
  };
});
var $ZodDiscriminatedUnion = /* @__PURE__ */ $constructor("$ZodDiscriminatedUnion", (inst, def) => {
  def.inclusive = false;
  $ZodUnion.init(inst, def);
  const _super = inst._zod.parse;
  defineLazy(inst._zod, "propValues", () => {
    const propValues = {};
    for (const option of def.options) {
      const pv = option._zod.propValues;
      if (!pv || Object.keys(pv).length === 0)
        throw new Error(`Invalid discriminated union option at index "${def.options.indexOf(option)}"`);
      for (const [k, v] of Object.entries(pv)) {
        if (!propValues[k])
          propValues[k] = /* @__PURE__ */ new Set();
        for (const val of v) {
          propValues[k].add(val);
        }
      }
    }
    return propValues;
  });
  const disc = cached(() => {
    const opts = def.options;
    const map2 = /* @__PURE__ */ new Map();
    for (const o of opts) {
      const values = o._zod.propValues?.[def.discriminator];
      if (!values || values.size === 0)
        throw new Error(`Invalid discriminated union option at index "${def.options.indexOf(o)}"`);
      for (const v of values) {
        if (map2.has(v)) {
          throw new Error(`Duplicate discriminator value "${String(v)}"`);
        }
        map2.set(v, o);
      }
    }
    return map2;
  });
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!isObject(input)) {
      payload.issues.push({
        code: "invalid_type",
        expected: "object",
        input,
        inst
      });
      return payload;
    }
    const opt = disc.value.get(input?.[def.discriminator]);
    if (opt) {
      return opt._zod.run(payload, ctx);
    }
    if (def.unionFallback) {
      return _super(payload, ctx);
    }
    payload.issues.push({
      code: "invalid_union",
      errors: [],
      note: "No matching discriminator",
      discriminator: def.discriminator,
      input,
      path: [def.discriminator],
      inst
    });
    return payload;
  };
});
var $ZodIntersection = /* @__PURE__ */ $constructor("$ZodIntersection", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    const left = def.left._zod.run({ value: input, issues: [] }, ctx);
    const right = def.right._zod.run({ value: input, issues: [] }, ctx);
    const async = left instanceof Promise || right instanceof Promise;
    if (async) {
      return Promise.all([left, right]).then(([left2, right2]) => {
        return handleIntersectionResults(payload, left2, right2);
      });
    }
    return handleIntersectionResults(payload, left, right);
  };
});
function mergeValues(a, b) {
  if (a === b) {
    return { valid: true, data: a };
  }
  if (a instanceof Date && b instanceof Date && +a === +b) {
    return { valid: true, data: a };
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const bKeys = Object.keys(b);
    const sharedKeys = Object.keys(a).filter((key) => bKeys.indexOf(key) !== -1);
    const newObj = { ...a, ...b };
    for (const key of sharedKeys) {
      const sharedValue = mergeValues(a[key], b[key]);
      if (!sharedValue.valid) {
        return {
          valid: false,
          mergeErrorPath: [key, ...sharedValue.mergeErrorPath]
        };
      }
      newObj[key] = sharedValue.data;
    }
    return { valid: true, data: newObj };
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return { valid: false, mergeErrorPath: [] };
    }
    const newArray = [];
    for (let index = 0; index < a.length; index++) {
      const itemA = a[index];
      const itemB = b[index];
      const sharedValue = mergeValues(itemA, itemB);
      if (!sharedValue.valid) {
        return {
          valid: false,
          mergeErrorPath: [index, ...sharedValue.mergeErrorPath]
        };
      }
      newArray.push(sharedValue.data);
    }
    return { valid: true, data: newArray };
  }
  return { valid: false, mergeErrorPath: [] };
}
function handleIntersectionResults(result, left, right) {
  const unrecKeys = /* @__PURE__ */ new Map();
  let unrecIssue;
  for (const iss of left.issues) {
    if (iss.code === "unrecognized_keys") {
      unrecIssue ?? (unrecIssue = iss);
      for (const k of iss.keys) {
        if (!unrecKeys.has(k))
          unrecKeys.set(k, {});
        unrecKeys.get(k).l = true;
      }
    } else {
      result.issues.push(iss);
    }
  }
  for (const iss of right.issues) {
    if (iss.code === "unrecognized_keys") {
      for (const k of iss.keys) {
        if (!unrecKeys.has(k))
          unrecKeys.set(k, {});
        unrecKeys.get(k).r = true;
      }
    } else {
      result.issues.push(iss);
    }
  }
  const bothKeys = [...unrecKeys].filter(([, f]) => f.l && f.r).map(([k]) => k);
  if (bothKeys.length && unrecIssue) {
    result.issues.push({ ...unrecIssue, keys: bothKeys });
  }
  if (aborted(result))
    return result;
  const merged = mergeValues(left.value, right.value);
  if (!merged.valid) {
    throw new Error(`Unmergable intersection. Error path: ${JSON.stringify(merged.mergeErrorPath)}`);
  }
  result.value = merged.data;
  return result;
}
var $ZodTuple = /* @__PURE__ */ $constructor("$ZodTuple", (inst, def) => {
  $ZodType.init(inst, def);
  const items = def.items;
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!Array.isArray(input)) {
      payload.issues.push({
        input,
        inst,
        expected: "tuple",
        code: "invalid_type"
      });
      return payload;
    }
    payload.value = [];
    const proms = [];
    const reversedIndex = [...items].reverse().findIndex((item) => item._zod.optin !== "optional");
    const optStart = reversedIndex === -1 ? 0 : items.length - reversedIndex;
    if (!def.rest) {
      const tooBig = input.length > items.length;
      const tooSmall = input.length < optStart - 1;
      if (tooBig || tooSmall) {
        payload.issues.push({
          ...tooBig ? { code: "too_big", maximum: items.length, inclusive: true } : { code: "too_small", minimum: items.length },
          input,
          inst,
          origin: "array"
        });
        return payload;
      }
    }
    let i = -1;
    for (const item of items) {
      i++;
      if (i >= input.length) {
        if (i >= optStart)
          continue;
      }
      const result = item._zod.run({
        value: input[i],
        issues: []
      }, ctx);
      if (result instanceof Promise) {
        proms.push(result.then((result2) => handleTupleResult(result2, payload, i)));
      } else {
        handleTupleResult(result, payload, i);
      }
    }
    if (def.rest) {
      const rest = input.slice(items.length);
      for (const el of rest) {
        i++;
        const result = def.rest._zod.run({
          value: el,
          issues: []
        }, ctx);
        if (result instanceof Promise) {
          proms.push(result.then((result2) => handleTupleResult(result2, payload, i)));
        } else {
          handleTupleResult(result, payload, i);
        }
      }
    }
    if (proms.length)
      return Promise.all(proms).then(() => payload);
    return payload;
  };
});
function handleTupleResult(result, final, index) {
  if (result.issues.length) {
    final.issues.push(...prefixIssues(index, result.issues));
  }
  final.value[index] = result.value;
}
var $ZodRecord = /* @__PURE__ */ $constructor("$ZodRecord", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!isPlainObject(input)) {
      payload.issues.push({
        expected: "record",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    const proms = [];
    const values = def.keyType._zod.values;
    if (values) {
      payload.value = {};
      const recordKeys = /* @__PURE__ */ new Set();
      for (const key of values) {
        if (typeof key === "string" || typeof key === "number" || typeof key === "symbol") {
          recordKeys.add(typeof key === "number" ? key.toString() : key);
          const result = def.valueType._zod.run({ value: input[key], issues: [] }, ctx);
          if (result instanceof Promise) {
            proms.push(result.then((result2) => {
              if (result2.issues.length) {
                payload.issues.push(...prefixIssues(key, result2.issues));
              }
              payload.value[key] = result2.value;
            }));
          } else {
            if (result.issues.length) {
              payload.issues.push(...prefixIssues(key, result.issues));
            }
            payload.value[key] = result.value;
          }
        }
      }
      let unrecognized;
      for (const key in input) {
        if (!recordKeys.has(key)) {
          unrecognized = unrecognized ?? [];
          unrecognized.push(key);
        }
      }
      if (unrecognized && unrecognized.length > 0) {
        payload.issues.push({
          code: "unrecognized_keys",
          input,
          inst,
          keys: unrecognized
        });
      }
    } else {
      payload.value = {};
      for (const key of Reflect.ownKeys(input)) {
        if (key === "__proto__")
          continue;
        let keyResult = def.keyType._zod.run({ value: key, issues: [] }, ctx);
        if (keyResult instanceof Promise) {
          throw new Error("Async schemas not supported in object keys currently");
        }
        const checkNumericKey = typeof key === "string" && number.test(key) && keyResult.issues.length;
        if (checkNumericKey) {
          const retryResult = def.keyType._zod.run({ value: Number(key), issues: [] }, ctx);
          if (retryResult instanceof Promise) {
            throw new Error("Async schemas not supported in object keys currently");
          }
          if (retryResult.issues.length === 0) {
            keyResult = retryResult;
          }
        }
        if (keyResult.issues.length) {
          if (def.mode === "loose") {
            payload.value[key] = input[key];
          } else {
            payload.issues.push({
              code: "invalid_key",
              origin: "record",
              issues: keyResult.issues.map((iss) => finalizeIssue(iss, ctx, config())),
              input: key,
              path: [key],
              inst
            });
          }
          continue;
        }
        const result = def.valueType._zod.run({ value: input[key], issues: [] }, ctx);
        if (result instanceof Promise) {
          proms.push(result.then((result2) => {
            if (result2.issues.length) {
              payload.issues.push(...prefixIssues(key, result2.issues));
            }
            payload.value[keyResult.value] = result2.value;
          }));
        } else {
          if (result.issues.length) {
            payload.issues.push(...prefixIssues(key, result.issues));
          }
          payload.value[keyResult.value] = result.value;
        }
      }
    }
    if (proms.length) {
      return Promise.all(proms).then(() => payload);
    }
    return payload;
  };
});
var $ZodMap = /* @__PURE__ */ $constructor("$ZodMap", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!(input instanceof Map)) {
      payload.issues.push({
        expected: "map",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    const proms = [];
    payload.value = /* @__PURE__ */ new Map();
    for (const [key, value] of input) {
      const keyResult = def.keyType._zod.run({ value: key, issues: [] }, ctx);
      const valueResult = def.valueType._zod.run({ value, issues: [] }, ctx);
      if (keyResult instanceof Promise || valueResult instanceof Promise) {
        proms.push(Promise.all([keyResult, valueResult]).then(([keyResult2, valueResult2]) => {
          handleMapResult(keyResult2, valueResult2, payload, key, input, inst, ctx);
        }));
      } else {
        handleMapResult(keyResult, valueResult, payload, key, input, inst, ctx);
      }
    }
    if (proms.length)
      return Promise.all(proms).then(() => payload);
    return payload;
  };
});
function handleMapResult(keyResult, valueResult, final, key, input, inst, ctx) {
  if (keyResult.issues.length) {
    if (propertyKeyTypes.has(typeof key)) {
      final.issues.push(...prefixIssues(key, keyResult.issues));
    } else {
      final.issues.push({
        code: "invalid_key",
        origin: "map",
        input,
        inst,
        issues: keyResult.issues.map((iss) => finalizeIssue(iss, ctx, config()))
      });
    }
  }
  if (valueResult.issues.length) {
    if (propertyKeyTypes.has(typeof key)) {
      final.issues.push(...prefixIssues(key, valueResult.issues));
    } else {
      final.issues.push({
        origin: "map",
        code: "invalid_element",
        input,
        inst,
        key,
        issues: valueResult.issues.map((iss) => finalizeIssue(iss, ctx, config()))
      });
    }
  }
  final.value.set(keyResult.value, valueResult.value);
}
var $ZodSet = /* @__PURE__ */ $constructor("$ZodSet", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!(input instanceof Set)) {
      payload.issues.push({
        input,
        inst,
        expected: "set",
        code: "invalid_type"
      });
      return payload;
    }
    const proms = [];
    payload.value = /* @__PURE__ */ new Set();
    for (const item of input) {
      const result = def.valueType._zod.run({ value: item, issues: [] }, ctx);
      if (result instanceof Promise) {
        proms.push(result.then((result2) => handleSetResult(result2, payload)));
      } else
        handleSetResult(result, payload);
    }
    if (proms.length)
      return Promise.all(proms).then(() => payload);
    return payload;
  };
});
function handleSetResult(result, final) {
  if (result.issues.length) {
    final.issues.push(...result.issues);
  }
  final.value.add(result.value);
}
var $ZodEnum = /* @__PURE__ */ $constructor("$ZodEnum", (inst, def) => {
  $ZodType.init(inst, def);
  const values = getEnumValues(def.entries);
  const valuesSet = new Set(values);
  inst._zod.values = valuesSet;
  inst._zod.pattern = new RegExp(`^(${values.filter((k) => propertyKeyTypes.has(typeof k)).map((o) => typeof o === "string" ? escapeRegex(o) : o.toString()).join("|")})$`);
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (valuesSet.has(input)) {
      return payload;
    }
    payload.issues.push({
      code: "invalid_value",
      values,
      input,
      inst
    });
    return payload;
  };
});
var $ZodLiteral = /* @__PURE__ */ $constructor("$ZodLiteral", (inst, def) => {
  $ZodType.init(inst, def);
  if (def.values.length === 0) {
    throw new Error("Cannot create literal schema with no valid values");
  }
  const values = new Set(def.values);
  inst._zod.values = values;
  inst._zod.pattern = new RegExp(`^(${def.values.map((o) => typeof o === "string" ? escapeRegex(o) : o ? escapeRegex(o.toString()) : String(o)).join("|")})$`);
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (values.has(input)) {
      return payload;
    }
    payload.issues.push({
      code: "invalid_value",
      values: def.values,
      input,
      inst
    });
    return payload;
  };
});
var $ZodFile = /* @__PURE__ */ $constructor("$ZodFile", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (input instanceof File)
      return payload;
    payload.issues.push({
      expected: "file",
      code: "invalid_type",
      input,
      inst
    });
    return payload;
  };
});
var $ZodTransform = /* @__PURE__ */ $constructor("$ZodTransform", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      throw new $ZodEncodeError(inst.constructor.name);
    }
    const _out = def.transform(payload.value, payload);
    if (ctx.async) {
      const output = _out instanceof Promise ? _out : Promise.resolve(_out);
      return output.then((output2) => {
        payload.value = output2;
        return payload;
      });
    }
    if (_out instanceof Promise) {
      throw new $ZodAsyncError();
    }
    payload.value = _out;
    return payload;
  };
});
function handleOptionalResult(result, input) {
  if (result.issues.length && input === void 0) {
    return { issues: [], value: void 0 };
  }
  return result;
}
var $ZodOptional = /* @__PURE__ */ $constructor("$ZodOptional", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.optin = "optional";
  inst._zod.optout = "optional";
  defineLazy(inst._zod, "values", () => {
    return def.innerType._zod.values ? /* @__PURE__ */ new Set([...def.innerType._zod.values, void 0]) : void 0;
  });
  defineLazy(inst._zod, "pattern", () => {
    const pattern = def.innerType._zod.pattern;
    return pattern ? new RegExp(`^(${cleanRegex(pattern.source)})?$`) : void 0;
  });
  inst._zod.parse = (payload, ctx) => {
    if (def.innerType._zod.optin === "optional") {
      const result = def.innerType._zod.run(payload, ctx);
      if (result instanceof Promise)
        return result.then((r) => handleOptionalResult(r, payload.value));
      return handleOptionalResult(result, payload.value);
    }
    if (payload.value === void 0) {
      return payload;
    }
    return def.innerType._zod.run(payload, ctx);
  };
});
var $ZodExactOptional = /* @__PURE__ */ $constructor("$ZodExactOptional", (inst, def) => {
  $ZodOptional.init(inst, def);
  defineLazy(inst._zod, "values", () => def.innerType._zod.values);
  defineLazy(inst._zod, "pattern", () => def.innerType._zod.pattern);
  inst._zod.parse = (payload, ctx) => {
    return def.innerType._zod.run(payload, ctx);
  };
});
var $ZodNullable = /* @__PURE__ */ $constructor("$ZodNullable", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "optin", () => def.innerType._zod.optin);
  defineLazy(inst._zod, "optout", () => def.innerType._zod.optout);
  defineLazy(inst._zod, "pattern", () => {
    const pattern = def.innerType._zod.pattern;
    return pattern ? new RegExp(`^(${cleanRegex(pattern.source)}|null)$`) : void 0;
  });
  defineLazy(inst._zod, "values", () => {
    return def.innerType._zod.values ? /* @__PURE__ */ new Set([...def.innerType._zod.values, null]) : void 0;
  });
  inst._zod.parse = (payload, ctx) => {
    if (payload.value === null)
      return payload;
    return def.innerType._zod.run(payload, ctx);
  };
});
var $ZodDefault = /* @__PURE__ */ $constructor("$ZodDefault", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.optin = "optional";
  defineLazy(inst._zod, "values", () => def.innerType._zod.values);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      return def.innerType._zod.run(payload, ctx);
    }
    if (payload.value === void 0) {
      payload.value = def.defaultValue;
      return payload;
    }
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then((result2) => handleDefaultResult(result2, def));
    }
    return handleDefaultResult(result, def);
  };
});
function handleDefaultResult(payload, def) {
  if (payload.value === void 0) {
    payload.value = def.defaultValue;
  }
  return payload;
}
var $ZodPrefault = /* @__PURE__ */ $constructor("$ZodPrefault", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.optin = "optional";
  defineLazy(inst._zod, "values", () => def.innerType._zod.values);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      return def.innerType._zod.run(payload, ctx);
    }
    if (payload.value === void 0) {
      payload.value = def.defaultValue;
    }
    return def.innerType._zod.run(payload, ctx);
  };
});
var $ZodNonOptional = /* @__PURE__ */ $constructor("$ZodNonOptional", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "values", () => {
    const v = def.innerType._zod.values;
    return v ? new Set([...v].filter((x) => x !== void 0)) : void 0;
  });
  inst._zod.parse = (payload, ctx) => {
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then((result2) => handleNonOptionalResult(result2, inst));
    }
    return handleNonOptionalResult(result, inst);
  };
});
function handleNonOptionalResult(payload, inst) {
  if (!payload.issues.length && payload.value === void 0) {
    payload.issues.push({
      code: "invalid_type",
      expected: "nonoptional",
      input: payload.value,
      inst
    });
  }
  return payload;
}
var $ZodSuccess = /* @__PURE__ */ $constructor("$ZodSuccess", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      throw new $ZodEncodeError("ZodSuccess");
    }
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then((result2) => {
        payload.value = result2.issues.length === 0;
        return payload;
      });
    }
    payload.value = result.issues.length === 0;
    return payload;
  };
});
var $ZodCatch = /* @__PURE__ */ $constructor("$ZodCatch", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "optin", () => def.innerType._zod.optin);
  defineLazy(inst._zod, "optout", () => def.innerType._zod.optout);
  defineLazy(inst._zod, "values", () => def.innerType._zod.values);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      return def.innerType._zod.run(payload, ctx);
    }
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then((result2) => {
        payload.value = result2.value;
        if (result2.issues.length) {
          payload.value = def.catchValue({
            ...payload,
            error: {
              issues: result2.issues.map((iss) => finalizeIssue(iss, ctx, config()))
            },
            input: payload.value
          });
          payload.issues = [];
        }
        return payload;
      });
    }
    payload.value = result.value;
    if (result.issues.length) {
      payload.value = def.catchValue({
        ...payload,
        error: {
          issues: result.issues.map((iss) => finalizeIssue(iss, ctx, config()))
        },
        input: payload.value
      });
      payload.issues = [];
    }
    return payload;
  };
});
var $ZodNaN = /* @__PURE__ */ $constructor("$ZodNaN", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, _ctx) => {
    if (typeof payload.value !== "number" || !Number.isNaN(payload.value)) {
      payload.issues.push({
        input: payload.value,
        inst,
        expected: "nan",
        code: "invalid_type"
      });
      return payload;
    }
    return payload;
  };
});
var $ZodPipe = /* @__PURE__ */ $constructor("$ZodPipe", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "values", () => def.in._zod.values);
  defineLazy(inst._zod, "optin", () => def.in._zod.optin);
  defineLazy(inst._zod, "optout", () => def.out._zod.optout);
  defineLazy(inst._zod, "propValues", () => def.in._zod.propValues);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      const right = def.out._zod.run(payload, ctx);
      if (right instanceof Promise) {
        return right.then((right2) => handlePipeResult(right2, def.in, ctx));
      }
      return handlePipeResult(right, def.in, ctx);
    }
    const left = def.in._zod.run(payload, ctx);
    if (left instanceof Promise) {
      return left.then((left2) => handlePipeResult(left2, def.out, ctx));
    }
    return handlePipeResult(left, def.out, ctx);
  };
});
function handlePipeResult(left, next, ctx) {
  if (left.issues.length) {
    left.aborted = true;
    return left;
  }
  return next._zod.run({ value: left.value, issues: left.issues }, ctx);
}
var $ZodCodec = /* @__PURE__ */ $constructor("$ZodCodec", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "values", () => def.in._zod.values);
  defineLazy(inst._zod, "optin", () => def.in._zod.optin);
  defineLazy(inst._zod, "optout", () => def.out._zod.optout);
  defineLazy(inst._zod, "propValues", () => def.in._zod.propValues);
  inst._zod.parse = (payload, ctx) => {
    const direction = ctx.direction || "forward";
    if (direction === "forward") {
      const left = def.in._zod.run(payload, ctx);
      if (left instanceof Promise) {
        return left.then((left2) => handleCodecAResult(left2, def, ctx));
      }
      return handleCodecAResult(left, def, ctx);
    } else {
      const right = def.out._zod.run(payload, ctx);
      if (right instanceof Promise) {
        return right.then((right2) => handleCodecAResult(right2, def, ctx));
      }
      return handleCodecAResult(right, def, ctx);
    }
  };
});
function handleCodecAResult(result, def, ctx) {
  if (result.issues.length) {
    result.aborted = true;
    return result;
  }
  const direction = ctx.direction || "forward";
  if (direction === "forward") {
    const transformed = def.transform(result.value, result);
    if (transformed instanceof Promise) {
      return transformed.then((value) => handleCodecTxResult(result, value, def.out, ctx));
    }
    return handleCodecTxResult(result, transformed, def.out, ctx);
  } else {
    const transformed = def.reverseTransform(result.value, result);
    if (transformed instanceof Promise) {
      return transformed.then((value) => handleCodecTxResult(result, value, def.in, ctx));
    }
    return handleCodecTxResult(result, transformed, def.in, ctx);
  }
}
function handleCodecTxResult(left, value, nextSchema, ctx) {
  if (left.issues.length) {
    left.aborted = true;
    return left;
  }
  return nextSchema._zod.run({ value, issues: left.issues }, ctx);
}
var $ZodReadonly = /* @__PURE__ */ $constructor("$ZodReadonly", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "propValues", () => def.innerType._zod.propValues);
  defineLazy(inst._zod, "values", () => def.innerType._zod.values);
  defineLazy(inst._zod, "optin", () => def.innerType?._zod?.optin);
  defineLazy(inst._zod, "optout", () => def.innerType?._zod?.optout);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      return def.innerType._zod.run(payload, ctx);
    }
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then(handleReadonlyResult);
    }
    return handleReadonlyResult(result);
  };
});
function handleReadonlyResult(payload) {
  payload.value = Object.freeze(payload.value);
  return payload;
}
var $ZodTemplateLiteral = /* @__PURE__ */ $constructor("$ZodTemplateLiteral", (inst, def) => {
  $ZodType.init(inst, def);
  const regexParts = [];
  for (const part of def.parts) {
    if (typeof part === "object" && part !== null) {
      if (!part._zod.pattern) {
        throw new Error(`Invalid template literal part, no pattern found: ${[...part._zod.traits].shift()}`);
      }
      const source = part._zod.pattern instanceof RegExp ? part._zod.pattern.source : part._zod.pattern;
      if (!source)
        throw new Error(`Invalid template literal part: ${part._zod.traits}`);
      const start = source.startsWith("^") ? 1 : 0;
      const end = source.endsWith("$") ? source.length - 1 : source.length;
      regexParts.push(source.slice(start, end));
    } else if (part === null || primitiveTypes.has(typeof part)) {
      regexParts.push(escapeRegex(`${part}`));
    } else {
      throw new Error(`Invalid template literal part: ${part}`);
    }
  }
  inst._zod.pattern = new RegExp(`^${regexParts.join("")}$`);
  inst._zod.parse = (payload, _ctx) => {
    if (typeof payload.value !== "string") {
      payload.issues.push({
        input: payload.value,
        inst,
        expected: "string",
        code: "invalid_type"
      });
      return payload;
    }
    inst._zod.pattern.lastIndex = 0;
    if (!inst._zod.pattern.test(payload.value)) {
      payload.issues.push({
        input: payload.value,
        inst,
        code: "invalid_format",
        format: def.format ?? "template_literal",
        pattern: inst._zod.pattern.source
      });
      return payload;
    }
    return payload;
  };
});
var $ZodFunction = /* @__PURE__ */ $constructor("$ZodFunction", (inst, def) => {
  $ZodType.init(inst, def);
  inst._def = def;
  inst._zod.def = def;
  inst.implement = (func) => {
    if (typeof func !== "function") {
      throw new Error("implement() must be called with a function");
    }
    return function(...args) {
      const parsedArgs = inst._def.input ? parse(inst._def.input, args) : args;
      const result = Reflect.apply(func, this, parsedArgs);
      if (inst._def.output) {
        return parse(inst._def.output, result);
      }
      return result;
    };
  };
  inst.implementAsync = (func) => {
    if (typeof func !== "function") {
      throw new Error("implementAsync() must be called with a function");
    }
    return async function(...args) {
      const parsedArgs = inst._def.input ? await parseAsync(inst._def.input, args) : args;
      const result = await Reflect.apply(func, this, parsedArgs);
      if (inst._def.output) {
        return await parseAsync(inst._def.output, result);
      }
      return result;
    };
  };
  inst._zod.parse = (payload, _ctx) => {
    if (typeof payload.value !== "function") {
      payload.issues.push({
        code: "invalid_type",
        expected: "function",
        input: payload.value,
        inst
      });
      return payload;
    }
    const hasPromiseOutput = inst._def.output && inst._def.output._zod.def.type === "promise";
    if (hasPromiseOutput) {
      payload.value = inst.implementAsync(payload.value);
    } else {
      payload.value = inst.implement(payload.value);
    }
    return payload;
  };
  inst.input = (...args) => {
    const F = inst.constructor;
    if (Array.isArray(args[0])) {
      return new F({
        type: "function",
        input: new $ZodTuple({
          type: "tuple",
          items: args[0],
          rest: args[1]
        }),
        output: inst._def.output
      });
    }
    return new F({
      type: "function",
      input: args[0],
      output: inst._def.output
    });
  };
  inst.output = (output) => {
    const F = inst.constructor;
    return new F({
      type: "function",
      input: inst._def.input,
      output
    });
  };
  return inst;
});
var $ZodPromise = /* @__PURE__ */ $constructor("$ZodPromise", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    return Promise.resolve(payload.value).then((inner) => def.innerType._zod.run({ value: inner, issues: [] }, ctx));
  };
});
var $ZodLazy = /* @__PURE__ */ $constructor("$ZodLazy", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "innerType", () => def.getter());
  defineLazy(inst._zod, "pattern", () => inst._zod.innerType?._zod?.pattern);
  defineLazy(inst._zod, "propValues", () => inst._zod.innerType?._zod?.propValues);
  defineLazy(inst._zod, "optin", () => inst._zod.innerType?._zod?.optin ?? void 0);
  defineLazy(inst._zod, "optout", () => inst._zod.innerType?._zod?.optout ?? void 0);
  inst._zod.parse = (payload, ctx) => {
    const inner = inst._zod.innerType;
    return inner._zod.run(payload, ctx);
  };
});
var $ZodCustom = /* @__PURE__ */ $constructor("$ZodCustom", (inst, def) => {
  $ZodCheck.init(inst, def);
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, _) => {
    return payload;
  };
  inst._zod.check = (payload) => {
    const input = payload.value;
    const r = def.fn(input);
    if (r instanceof Promise) {
      return r.then((r2) => handleRefineResult(r2, payload, input, inst));
    }
    handleRefineResult(r, payload, input, inst);
    return;
  };
});
function handleRefineResult(result, payload, input, inst) {
  if (!result) {
    const _iss = {
      code: "custom",
      input,
      inst,
      // incorporates params.error into issue reporting
      path: [...inst._zod.def.path ?? []],
      // incorporates params.error into issue reporting
      continue: !inst._zod.def.abort
      // params: inst._zod.def.params,
    };
    if (inst._zod.def.params)
      _iss.params = inst._zod.def.params;
    payload.issues.push(issue(_iss));
  }
}

// node_modules/zod/v4/locales/index.js
var locales_exports = {};
__export(locales_exports, {
  ar: () => ar_default,
  az: () => az_default,
  be: () => be_default,
  bg: () => bg_default,
  ca: () => ca_default,
  cs: () => cs_default,
  da: () => da_default,
  de: () => de_default,
  en: () => en_default,
  eo: () => eo_default,
  es: () => es_default,
  fa: () => fa_default,
  fi: () => fi_default,
  fr: () => fr_default,
  frCA: () => fr_CA_default,
  he: () => he_default,
  hu: () => hu_default,
  hy: () => hy_default,
  id: () => id_default,
  is: () => is_default,
  it: () => it_default,
  ja: () => ja_default,
  ka: () => ka_default,
  kh: () => kh_default,
  km: () => km_default,
  ko: () => ko_default,
  lt: () => lt_default,
  mk: () => mk_default,
  ms: () => ms_default,
  nl: () => nl_default,
  no: () => no_default,
  ota: () => ota_default,
  pl: () => pl_default,
  ps: () => ps_default,
  pt: () => pt_default,
  ru: () => ru_default,
  sl: () => sl_default,
  sv: () => sv_default,
  ta: () => ta_default,
  th: () => th_default,
  tr: () => tr_default,
  ua: () => ua_default,
  uk: () => uk_default,
  ur: () => ur_default,
  uz: () => uz_default,
  vi: () => vi_default,
  yo: () => yo_default,
  zhCN: () => zh_CN_default,
  zhTW: () => zh_TW_default
});

// node_modules/zod/v4/locales/ar.js
var error = () => {
  const Sizable = {
    string: { unit: "\u062D\u0631\u0641", verb: "\u0623\u0646 \u064A\u062D\u0648\u064A" },
    file: { unit: "\u0628\u0627\u064A\u062A", verb: "\u0623\u0646 \u064A\u062D\u0648\u064A" },
    array: { unit: "\u0639\u0646\u0635\u0631", verb: "\u0623\u0646 \u064A\u062D\u0648\u064A" },
    set: { unit: "\u0639\u0646\u0635\u0631", verb: "\u0623\u0646 \u064A\u062D\u0648\u064A" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const FormatDictionary = {
    regex: "\u0645\u062F\u062E\u0644",
    email: "\u0628\u0631\u064A\u062F \u0625\u0644\u0643\u062A\u0631\u0648\u0646\u064A",
    url: "\u0631\u0627\u0628\u0637",
    emoji: "\u0625\u064A\u0645\u0648\u062C\u064A",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "\u062A\u0627\u0631\u064A\u062E \u0648\u0648\u0642\u062A \u0628\u0645\u0639\u064A\u0627\u0631 ISO",
    date: "\u062A\u0627\u0631\u064A\u062E \u0628\u0645\u0639\u064A\u0627\u0631 ISO",
    time: "\u0648\u0642\u062A \u0628\u0645\u0639\u064A\u0627\u0631 ISO",
    duration: "\u0645\u062F\u0629 \u0628\u0645\u0639\u064A\u0627\u0631 ISO",
    ipv4: "\u0639\u0646\u0648\u0627\u0646 IPv4",
    ipv6: "\u0639\u0646\u0648\u0627\u0646 IPv6",
    cidrv4: "\u0645\u062F\u0649 \u0639\u0646\u0627\u0648\u064A\u0646 \u0628\u0635\u064A\u063A\u0629 IPv4",
    cidrv6: "\u0645\u062F\u0649 \u0639\u0646\u0627\u0648\u064A\u0646 \u0628\u0635\u064A\u063A\u0629 IPv6",
    base64: "\u0646\u064E\u0635 \u0628\u062A\u0631\u0645\u064A\u0632 base64-encoded",
    base64url: "\u0646\u064E\u0635 \u0628\u062A\u0631\u0645\u064A\u0632 base64url-encoded",
    json_string: "\u0646\u064E\u0635 \u0639\u0644\u0649 \u0647\u064A\u0626\u0629 JSON",
    e164: "\u0631\u0642\u0645 \u0647\u0627\u062A\u0641 \u0628\u0645\u0639\u064A\u0627\u0631 E.164",
    jwt: "JWT",
    template_literal: "\u0645\u062F\u062E\u0644"
  };
  const TypeDictionary = {
    nan: "NaN"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type": {
        const expected = TypeDictionary[issue2.expected] ?? issue2.expected;
        const receivedType = parsedType(issue2.input);
        const received = TypeDictionary[receivedType] ?? receivedType;
        if (/^[A-Z]/.test(issue2.expected)) {
          return `\u0645\u062F\u062E\u0644\u0627\u062A \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644\u0629: \u064A\u0641\u062A\u0631\u0636 \u0625\u062F\u062E\u0627\u0644 instanceof ${issue2.expected}\u060C \u0648\u0644\u0643\u0646 \u062A\u0645 \u0625\u062F\u062E\u0627\u0644 ${received}`;
        }
        return `\u0645\u062F\u062E\u0644\u0627\u062A \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644\u0629: \u064A\u0641\u062A\u0631\u0636 \u0625\u062F\u062E\u0627\u0644 ${expected}\u060C \u0648\u0644\u0643\u0646 \u062A\u0645 \u0625\u062F\u062E\u0627\u0644 ${received}`;
      }
      case "invalid_value":
        if (issue2.values.length === 1)
          return `\u0645\u062F\u062E\u0644\u0627\u062A \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644\u0629: \u064A\u0641\u062A\u0631\u0636 \u0625\u062F\u062E\u0627\u0644 ${stringifyPrimitive(issue2.values[0])}`;
        return `\u0627\u062E\u062A\u064A\u0627\u0631 \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644: \u064A\u062A\u0648\u0642\u0639 \u0627\u0646\u062A\u0642\u0627\u0621 \u0623\u062D\u062F \u0647\u0630\u0647 \u0627\u0644\u062E\u064A\u0627\u0631\u0627\u062A: ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return ` \u0623\u0643\u0628\u0631 \u0645\u0646 \u0627\u0644\u0644\u0627\u0632\u0645: \u064A\u0641\u062A\u0631\u0636 \u0623\u0646 \u062A\u0643\u0648\u0646 ${issue2.origin ?? "\u0627\u0644\u0642\u064A\u0645\u0629"} ${adj} ${issue2.maximum.toString()} ${sizing.unit ?? "\u0639\u0646\u0635\u0631"}`;
        return `\u0623\u0643\u0628\u0631 \u0645\u0646 \u0627\u0644\u0644\u0627\u0632\u0645: \u064A\u0641\u062A\u0631\u0636 \u0623\u0646 \u062A\u0643\u0648\u0646 ${issue2.origin ?? "\u0627\u0644\u0642\u064A\u0645\u0629"} ${adj} ${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `\u0623\u0635\u063A\u0631 \u0645\u0646 \u0627\u0644\u0644\u0627\u0632\u0645: \u064A\u0641\u062A\u0631\u0636 \u0644\u0640 ${issue2.origin} \u0623\u0646 \u064A\u0643\u0648\u0646 ${adj} ${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `\u0623\u0635\u063A\u0631 \u0645\u0646 \u0627\u0644\u0644\u0627\u0632\u0645: \u064A\u0641\u062A\u0631\u0636 \u0644\u0640 ${issue2.origin} \u0623\u0646 \u064A\u0643\u0648\u0646 ${adj} ${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `\u0646\u064E\u0635 \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644: \u064A\u062C\u0628 \u0623\u0646 \u064A\u0628\u062F\u0623 \u0628\u0640 "${issue2.prefix}"`;
        if (_issue.format === "ends_with")
          return `\u0646\u064E\u0635 \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644: \u064A\u062C\u0628 \u0623\u0646 \u064A\u0646\u062A\u0647\u064A \u0628\u0640 "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `\u0646\u064E\u0635 \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644: \u064A\u062C\u0628 \u0623\u0646 \u064A\u062A\u0636\u0645\u0651\u064E\u0646 "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `\u0646\u064E\u0635 \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644: \u064A\u062C\u0628 \u0623\u0646 \u064A\u0637\u0627\u0628\u0642 \u0627\u0644\u0646\u0645\u0637 ${_issue.pattern}`;
        return `${FormatDictionary[_issue.format] ?? issue2.format} \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644`;
      }
      case "not_multiple_of":
        return `\u0631\u0642\u0645 \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644: \u064A\u062C\u0628 \u0623\u0646 \u064A\u0643\u0648\u0646 \u0645\u0646 \u0645\u0636\u0627\u0639\u0641\u0627\u062A ${issue2.divisor}`;
      case "unrecognized_keys":
        return `\u0645\u0639\u0631\u0641${issue2.keys.length > 1 ? "\u0627\u062A" : ""} \u063A\u0631\u064A\u0628${issue2.keys.length > 1 ? "\u0629" : ""}: ${joinValues(issue2.keys, "\u060C ")}`;
      case "invalid_key":
        return `\u0645\u0639\u0631\u0641 \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644 \u0641\u064A ${issue2.origin}`;
      case "invalid_union":
        return "\u0645\u062F\u062E\u0644 \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644";
      case "invalid_element":
        return `\u0645\u062F\u062E\u0644 \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644 \u0641\u064A ${issue2.origin}`;
      default:
        return "\u0645\u062F\u062E\u0644 \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644";
    }
  };
};
function ar_default() {
  return {
    localeError: error()
  };
}

// node_modules/zod/v4/locales/az.js
var error2 = () => {
  const Sizable = {
    string: { unit: "simvol", verb: "olmal\u0131d\u0131r" },
    file: { unit: "bayt", verb: "olmal\u0131d\u0131r" },
    array: { unit: "element", verb: "olmal\u0131d\u0131r" },
    set: { unit: "element", verb: "olmal\u0131d\u0131r" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const FormatDictionary = {
    regex: "input",
    email: "email address",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO datetime",
    date: "ISO date",
    time: "ISO time",
    duration: "ISO duration",
    ipv4: "IPv4 address",
    ipv6: "IPv6 address",
    cidrv4: "IPv4 range",
    cidrv6: "IPv6 range",
    base64: "base64-encoded string",
    base64url: "base64url-encoded string",
    json_string: "JSON string",
    e164: "E.164 number",
    jwt: "JWT",
    template_literal: "input"
  };
  const TypeDictionary = {
    nan: "NaN"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type": {
        const expected = TypeDictionary[issue2.expected] ?? issue2.expected;
        const receivedType = parsedType(issue2.input);
        const received = TypeDictionary[receivedType] ?? receivedType;
        if (/^[A-Z]/.test(issue2.expected)) {
          return `Yanl\u0131\u015F d\u0259y\u0259r: g\xF6zl\u0259nil\u0259n instanceof ${issue2.expected}, daxil olan ${received}`;
        }
        return `Yanl\u0131\u015F d\u0259y\u0259r: g\xF6zl\u0259nil\u0259n ${expected}, daxil olan ${received}`;
      }
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Yanl\u0131\u015F d\u0259y\u0259r: g\xF6zl\u0259nil\u0259n ${stringifyPrimitive(issue2.values[0])}`;
        return `Yanl\u0131\u015F se\xE7im: a\u015Fa\u011F\u0131dak\u0131lardan biri olmal\u0131d\u0131r: ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `\xC7ox b\xF6y\xFCk: g\xF6zl\u0259nil\u0259n ${issue2.origin ?? "d\u0259y\u0259r"} ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "element"}`;
        return `\xC7ox b\xF6y\xFCk: g\xF6zl\u0259nil\u0259n ${issue2.origin ?? "d\u0259y\u0259r"} ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `\xC7ox ki\xE7ik: g\xF6zl\u0259nil\u0259n ${issue2.origin} ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        return `\xC7ox ki\xE7ik: g\xF6zl\u0259nil\u0259n ${issue2.origin} ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Yanl\u0131\u015F m\u0259tn: "${_issue.prefix}" il\u0259 ba\u015Flamal\u0131d\u0131r`;
        if (_issue.format === "ends_with")
          return `Yanl\u0131\u015F m\u0259tn: "${_issue.suffix}" il\u0259 bitm\u0259lidir`;
        if (_issue.format === "includes")
          return `Yanl\u0131\u015F m\u0259tn: "${_issue.includes}" daxil olmal\u0131d\u0131r`;
        if (_issue.format === "regex")
          return `Yanl\u0131\u015F m\u0259tn: ${_issue.pattern} \u015Fablonuna uy\u011Fun olmal\u0131d\u0131r`;
        return `Yanl\u0131\u015F ${FormatDictionary[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Yanl\u0131\u015F \u0259d\u0259d: ${issue2.divisor} il\u0259 b\xF6l\xFCn\u0259 bil\u0259n olmal\u0131d\u0131r`;
      case "unrecognized_keys":
        return `Tan\u0131nmayan a\xE7ar${issue2.keys.length > 1 ? "lar" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `${issue2.origin} daxilind\u0259 yanl\u0131\u015F a\xE7ar`;
      case "invalid_union":
        return "Yanl\u0131\u015F d\u0259y\u0259r";
      case "invalid_element":
        return `${issue2.origin} daxilind\u0259 yanl\u0131\u015F d\u0259y\u0259r`;
      default:
        return `Yanl\u0131\u015F d\u0259y\u0259r`;
    }
  };
};
function az_default() {
  return {
    localeError: error2()
  };
}

// node_modules/zod/v4/locales/be.js
function getBelarusianPlural(count, one, few, many) {
  const absCount = Math.abs(count);
  const lastDigit = absCount % 10;
  const lastTwoDigits = absCount % 100;
  if (lastTwoDigits >= 11 && lastTwoDigits <= 19) {
    return many;
  }
  if (lastDigit === 1) {
    return one;
  }
  if (lastDigit >= 2 && lastDigit <= 4) {
    return few;
  }
  return many;
}
var error3 = () => {
  const Sizable = {
    string: {
      unit: {
        one: "\u0441\u0456\u043C\u0432\u0430\u043B",
        few: "\u0441\u0456\u043C\u0432\u0430\u043B\u044B",
        many: "\u0441\u0456\u043C\u0432\u0430\u043B\u0430\u045E"
      },
      verb: "\u043C\u0435\u0446\u044C"
    },
    array: {
      unit: {
        one: "\u044D\u043B\u0435\u043C\u0435\u043D\u0442",
        few: "\u044D\u043B\u0435\u043C\u0435\u043D\u0442\u044B",
        many: "\u044D\u043B\u0435\u043C\u0435\u043D\u0442\u0430\u045E"
      },
      verb: "\u043C\u0435\u0446\u044C"
    },
    set: {
      unit: {
        one: "\u044D\u043B\u0435\u043C\u0435\u043D\u0442",
        few: "\u044D\u043B\u0435\u043C\u0435\u043D\u0442\u044B",
        many: "\u044D\u043B\u0435\u043C\u0435\u043D\u0442\u0430\u045E"
      },
      verb: "\u043C\u0435\u0446\u044C"
    },
    file: {
      unit: {
        one: "\u0431\u0430\u0439\u0442",
        few: "\u0431\u0430\u0439\u0442\u044B",
        many: "\u0431\u0430\u0439\u0442\u0430\u045E"
      },
      verb: "\u043C\u0435\u0446\u044C"
    }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const FormatDictionary = {
    regex: "\u0443\u0432\u043E\u0434",
    email: "email \u0430\u0434\u0440\u0430\u0441",
    url: "URL",
    emoji: "\u044D\u043C\u043E\u0434\u0437\u0456",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO \u0434\u0430\u0442\u0430 \u0456 \u0447\u0430\u0441",
    date: "ISO \u0434\u0430\u0442\u0430",
    time: "ISO \u0447\u0430\u0441",
    duration: "ISO \u043F\u0440\u0430\u0446\u044F\u0433\u043B\u0430\u0441\u0446\u044C",
    ipv4: "IPv4 \u0430\u0434\u0440\u0430\u0441",
    ipv6: "IPv6 \u0430\u0434\u0440\u0430\u0441",
    cidrv4: "IPv4 \u0434\u044B\u044F\u043F\u0430\u0437\u043E\u043D",
    cidrv6: "IPv6 \u0434\u044B\u044F\u043F\u0430\u0437\u043E\u043D",
    base64: "\u0440\u0430\u0434\u043E\u043A \u0443 \u0444\u0430\u0440\u043C\u0430\u0446\u0435 base64",
    base64url: "\u0440\u0430\u0434\u043E\u043A \u0443 \u0444\u0430\u0440\u043C\u0430\u0446\u0435 base64url",
    json_string: "JSON \u0440\u0430\u0434\u043E\u043A",
    e164: "\u043D\u0443\u043C\u0430\u0440 E.164",
    jwt: "JWT",
    template_literal: "\u0443\u0432\u043E\u0434"
  };
  const TypeDictionary = {
    nan: "NaN",
    number: "\u043B\u0456\u043A",
    array: "\u043C\u0430\u0441\u0456\u045E"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type": {
        const expected = TypeDictionary[issue2.expected] ?? issue2.expected;
        const receivedType = parsedType(issue2.input);
        const received = TypeDictionary[receivedType] ?? receivedType;
        if (/^[A-Z]/.test(issue2.expected)) {
          return `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B \u045E\u0432\u043E\u0434: \u0447\u0430\u043A\u0430\u045E\u0441\u044F instanceof ${issue2.expected}, \u0430\u0442\u0440\u044B\u043C\u0430\u043D\u0430 ${received}`;
        }
        return `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B \u045E\u0432\u043E\u0434: \u0447\u0430\u043A\u0430\u045E\u0441\u044F ${expected}, \u0430\u0442\u0440\u044B\u043C\u0430\u043D\u0430 ${received}`;
      }
      case "invalid_value":
        if (issue2.values.length === 1)
          return `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B \u045E\u0432\u043E\u0434: \u0447\u0430\u043A\u0430\u043B\u0430\u0441\u044F ${stringifyPrimitive(issue2.values[0])}`;
        return `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B \u0432\u0430\u0440\u044B\u044F\u043D\u0442: \u0447\u0430\u043A\u0430\u045E\u0441\u044F \u0430\u0434\u0437\u0456\u043D \u0437 ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          const maxValue = Number(issue2.maximum);
          const unit = getBelarusianPlural(maxValue, sizing.unit.one, sizing.unit.few, sizing.unit.many);
          return `\u0417\u0430\u043D\u0430\u0434\u0442\u0430 \u0432\u044F\u043B\u0456\u043A\u0456: \u0447\u0430\u043A\u0430\u043B\u0430\u0441\u044F, \u0448\u0442\u043E ${issue2.origin ?? "\u0437\u043D\u0430\u0447\u044D\u043D\u043D\u0435"} \u043F\u0430\u0432\u0456\u043D\u043D\u0430 ${sizing.verb} ${adj}${issue2.maximum.toString()} ${unit}`;
        }
        return `\u0417\u0430\u043D\u0430\u0434\u0442\u0430 \u0432\u044F\u043B\u0456\u043A\u0456: \u0447\u0430\u043A\u0430\u043B\u0430\u0441\u044F, \u0448\u0442\u043E ${issue2.origin ?? "\u0437\u043D\u0430\u0447\u044D\u043D\u043D\u0435"} \u043F\u0430\u0432\u0456\u043D\u043D\u0430 \u0431\u044B\u0446\u044C ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          const minValue = Number(issue2.minimum);
          const unit = getBelarusianPlural(minValue, sizing.unit.one, sizing.unit.few, sizing.unit.many);
          return `\u0417\u0430\u043D\u0430\u0434\u0442\u0430 \u043C\u0430\u043B\u044B: \u0447\u0430\u043A\u0430\u043B\u0430\u0441\u044F, \u0448\u0442\u043E ${issue2.origin} \u043F\u0430\u0432\u0456\u043D\u043D\u0430 ${sizing.verb} ${adj}${issue2.minimum.toString()} ${unit}`;
        }
        return `\u0417\u0430\u043D\u0430\u0434\u0442\u0430 \u043C\u0430\u043B\u044B: \u0447\u0430\u043A\u0430\u043B\u0430\u0441\u044F, \u0448\u0442\u043E ${issue2.origin} \u043F\u0430\u0432\u0456\u043D\u043D\u0430 \u0431\u044B\u0446\u044C ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B \u0440\u0430\u0434\u043E\u043A: \u043F\u0430\u0432\u0456\u043D\u0435\u043D \u043F\u0430\u0447\u044B\u043D\u0430\u0446\u0446\u0430 \u0437 "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B \u0440\u0430\u0434\u043E\u043A: \u043F\u0430\u0432\u0456\u043D\u0435\u043D \u0437\u0430\u043A\u0430\u043D\u0447\u0432\u0430\u0446\u0446\u0430 \u043D\u0430 "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B \u0440\u0430\u0434\u043E\u043A: \u043F\u0430\u0432\u0456\u043D\u0435\u043D \u0437\u043C\u044F\u0448\u0447\u0430\u0446\u044C "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B \u0440\u0430\u0434\u043E\u043A: \u043F\u0430\u0432\u0456\u043D\u0435\u043D \u0430\u0434\u043F\u0430\u0432\u044F\u0434\u0430\u0446\u044C \u0448\u0430\u0431\u043B\u043E\u043D\u0443 ${_issue.pattern}`;
        return `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B ${FormatDictionary[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B \u043B\u0456\u043A: \u043F\u0430\u0432\u0456\u043D\u0435\u043D \u0431\u044B\u0446\u044C \u043A\u0440\u0430\u0442\u043D\u044B\u043C ${issue2.divisor}`;
      case "unrecognized_keys":
        return `\u041D\u0435\u0440\u0430\u0441\u043F\u0430\u0437\u043D\u0430\u043D\u044B ${issue2.keys.length > 1 ? "\u043A\u043B\u044E\u0447\u044B" : "\u043A\u043B\u044E\u0447"}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B \u043A\u043B\u044E\u0447 \u0443 ${issue2.origin}`;
      case "invalid_union":
        return "\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B \u045E\u0432\u043E\u0434";
      case "invalid_element":
        return `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u0430\u0435 \u0437\u043D\u0430\u0447\u044D\u043D\u043D\u0435 \u045E ${issue2.origin}`;
      default:
        return `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B \u045E\u0432\u043E\u0434`;
    }
  };
};
function be_default() {
  return {
    localeError: error3()
  };
}

// node_modules/zod/v4/locales/bg.js
var error4 = () => {
  const Sizable = {
    string: { unit: "\u0441\u0438\u043C\u0432\u043E\u043B\u0430", verb: "\u0434\u0430 \u0441\u044A\u0434\u044A\u0440\u0436\u0430" },
    file: { unit: "\u0431\u0430\u0439\u0442\u0430", verb: "\u0434\u0430 \u0441\u044A\u0434\u044A\u0440\u0436\u0430" },
    array: { unit: "\u0435\u043B\u0435\u043C\u0435\u043D\u0442\u0430", verb: "\u0434\u0430 \u0441\u044A\u0434\u044A\u0440\u0436\u0430" },
    set: { unit: "\u0435\u043B\u0435\u043C\u0435\u043D\u0442\u0430", verb: "\u0434\u0430 \u0441\u044A\u0434\u044A\u0440\u0436\u0430" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const FormatDictionary = {
    regex: "\u0432\u0445\u043E\u0434",
    email: "\u0438\u043C\u0435\u0439\u043B \u0430\u0434\u0440\u0435\u0441",
    url: "URL",
    emoji: "\u0435\u043C\u043E\u0434\u0436\u0438",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO \u0432\u0440\u0435\u043C\u0435",
    date: "ISO \u0434\u0430\u0442\u0430",
    time: "ISO \u0432\u0440\u0435\u043C\u0435",
    duration: "ISO \u043F\u0440\u043E\u0434\u044A\u043B\u0436\u0438\u0442\u0435\u043B\u043D\u043E\u0441\u0442",
    ipv4: "IPv4 \u0430\u0434\u0440\u0435\u0441",
    ipv6: "IPv6 \u0430\u0434\u0440\u0435\u0441",
    cidrv4: "IPv4 \u0434\u0438\u0430\u043F\u0430\u0437\u043E\u043D",
    cidrv6: "IPv6 \u0434\u0438\u0430\u043F\u0430\u0437\u043E\u043D",
    base64: "base64-\u043A\u043E\u0434\u0438\u0440\u0430\u043D \u043D\u0438\u0437",
    base64url: "base64url-\u043A\u043E\u0434\u0438\u0440\u0430\u043D \u043D\u0438\u0437",
    json_string: "JSON \u043D\u0438\u0437",
    e164: "E.164 \u043D\u043E\u043C\u0435\u0440",
    jwt: "JWT",
    template_literal: "\u0432\u0445\u043E\u0434"
  };
  const TypeDictionary = {
    nan: "NaN",
    number: "\u0447\u0438\u0441\u043B\u043E",
    array: "\u043C\u0430\u0441\u0438\u0432"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type": {
        const expected = TypeDictionary[issue2.expected] ?? issue2.expected;
        const receivedType = parsedType(issue2.input);
        const received = TypeDictionary[receivedType] ?? receivedType;
        if (/^[A-Z]/.test(issue2.expected)) {
          return `\u041D\u0435\u0432\u0430\u043B\u0438\u0434\u0435\u043D \u0432\u0445\u043E\u0434: \u043E\u0447\u0430\u043A\u0432\u0430\u043D instanceof ${issue2.expected}, \u043F\u043E\u043B\u0443\u0447\u0435\u043D ${received}`;
        }
        return `\u041D\u0435\u0432\u0430\u043B\u0438\u0434\u0435\u043D \u0432\u0445\u043E\u0434: \u043E\u0447\u0430\u043A\u0432\u0430\u043D ${expected}, \u043F\u043E\u043B\u0443\u0447\u0435\u043D ${received}`;
      }
      case "invalid_value":
        if (issue2.values.length === 1)
          return `\u041D\u0435\u0432\u0430\u043B\u0438\u0434\u0435\u043D \u0432\u0445\u043E\u0434: \u043E\u0447\u0430\u043A\u0432\u0430\u043D ${stringifyPrimitive(issue2.values[0])}`;
        return `\u041D\u0435\u0432\u0430\u043B\u0438\u0434\u043D\u0430 \u043E\u043F\u0446\u0438\u044F: \u043E\u0447\u0430\u043A\u0432\u0430\u043D\u043E \u0435\u0434\u043D\u043E \u043E\u0442 ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `\u0422\u0432\u044A\u0440\u0434\u0435 \u0433\u043E\u043B\u044F\u043C\u043E: \u043E\u0447\u0430\u043A\u0432\u0430 \u0441\u0435 ${issue2.origin ?? "\u0441\u0442\u043E\u0439\u043D\u043E\u0441\u0442"} \u0434\u0430 \u0441\u044A\u0434\u044A\u0440\u0436\u0430 ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "\u0435\u043B\u0435\u043C\u0435\u043D\u0442\u0430"}`;
        return `\u0422\u0432\u044A\u0440\u0434\u0435 \u0433\u043E\u043B\u044F\u043C\u043E: \u043E\u0447\u0430\u043A\u0432\u0430 \u0441\u0435 ${issue2.origin ?? "\u0441\u0442\u043E\u0439\u043D\u043E\u0441\u0442"} \u0434\u0430 \u0431\u044A\u0434\u0435 ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `\u0422\u0432\u044A\u0440\u0434\u0435 \u043C\u0430\u043B\u043A\u043E: \u043E\u0447\u0430\u043A\u0432\u0430 \u0441\u0435 ${issue2.origin} \u0434\u0430 \u0441\u044A\u0434\u044A\u0440\u0436\u0430 ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `\u0422\u0432\u044A\u0440\u0434\u0435 \u043C\u0430\u043B\u043A\u043E: \u043E\u0447\u0430\u043A\u0432\u0430 \u0441\u0435 ${issue2.origin} \u0434\u0430 \u0431\u044A\u0434\u0435 ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `\u041D\u0435\u0432\u0430\u043B\u0438\u0434\u0435\u043D \u043D\u0438\u0437: \u0442\u0440\u044F\u0431\u0432\u0430 \u0434\u0430 \u0437\u0430\u043F\u043E\u0447\u0432\u0430 \u0441 "${_issue.prefix}"`;
        }
        if (_issue.format === "ends_with")
          return `\u041D\u0435\u0432\u0430\u043B\u0438\u0434\u0435\u043D \u043D\u0438\u0437: \u0442\u0440\u044F\u0431\u0432\u0430 \u0434\u0430 \u0437\u0430\u0432\u044A\u0440\u0448\u0432\u0430 \u0441 "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `\u041D\u0435\u0432\u0430\u043B\u0438\u0434\u0435\u043D \u043D\u0438\u0437: \u0442\u0440\u044F\u0431\u0432\u0430 \u0434\u0430 \u0432\u043A\u043B\u044E\u0447\u0432\u0430 "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `\u041D\u0435\u0432\u0430\u043B\u0438\u0434\u0435\u043D \u043D\u0438\u0437: \u0442\u0440\u044F\u0431\u0432\u0430 \u0434\u0430 \u0441\u044A\u0432\u043F\u0430\u0434\u0430 \u0441 ${_issue.pattern}`;
        let invalid_adj = "\u041D\u0435\u0432\u0430\u043B\u0438\u0434\u0435\u043D";
        if (_issue.format === "emoji")
          invalid_adj = "\u041D\u0435\u0432\u0430\u043B\u0438\u0434\u043D\u043E";
        if (_issue.format === "datetime")
          invalid_adj = "\u041D\u0435\u0432\u0430\u043B\u0438\u0434\u043D\u043E";
        if (_issue.format === "date")
          invalid_adj = "\u041D\u0435\u0432\u0430\u043B\u0438\u0434\u043D\u0430";
        if (_issue.format === "time")
          invalid_adj = "\u041D\u0435\u0432\u0430\u043B\u0438\u0434\u043D\u043E";
        if (_issue.format === "duration")
          invalid_adj = "\u041D\u0435\u0432\u0430\u043B\u0438\u0434\u043D\u0430";
        return `${invalid_adj} ${FormatDictionary[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `\u041D\u0435\u0432\u0430\u043B\u0438\u0434\u043D\u043E \u0447\u0438\u0441\u043B\u043E: \u0442\u0440\u044F\u0431\u0432\u0430 \u0434\u0430 \u0431\u044A\u0434\u0435 \u043A\u0440\u0430\u0442\u043D\u043E \u043D\u0430 ${issue2.divisor}`;
      case "unrecognized_keys":
        return `\u041D\u0435\u0440\u0430\u0437\u043F\u043E\u0437\u043D\u0430\u0442${issue2.keys.length > 1 ? "\u0438" : ""} \u043A\u043B\u044E\u0447${issue2.keys.length > 1 ? "\u043E\u0432\u0435" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `\u041D\u0435\u0432\u0430\u043B\u0438\u0434\u0435\u043D \u043A\u043B\u044E\u0447 \u0432 ${issue2.origin}`;
      case "invalid_union":
        return "\u041D\u0435\u0432\u0430\u043B\u0438\u0434\u0435\u043D \u0432\u0445\u043E\u0434";
      case "invalid_element":
        return `\u041D\u0435\u0432\u0430\u043B\u0438\u0434\u043D\u0430 \u0441\u0442\u043E\u0439\u043D\u043E\u0441\u0442 \u0432 ${issue2.origin}`;
      default:
        return `\u041D\u0435\u0432\u0430\u043B\u0438\u0434\u0435\u043D \u0432\u0445\u043E\u0434`;
    }
  };
};
function bg_default() {
  return {
    localeError: error4()
  };
}

// node_modules/zod/v4/locales/ca.js
var error5 = () => {
  const Sizable = {
    string: { unit: "car\xE0cters", verb: "contenir" },
    file: { unit: "bytes", verb: "contenir" },
    array: { unit: "elements", verb: "contenir" },
    set: { unit: "elements", verb: "contenir" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const FormatDictionary = {
    regex: "entrada",
    email: "adre\xE7a electr\xF2nica",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "data i hora ISO",
    date: "data ISO",
    time: "hora ISO",
    duration: "durada ISO",
    ipv4: "adre\xE7a IPv4",
    ipv6: "adre\xE7a IPv6",
    cidrv4: "rang IPv4",
    cidrv6: "rang IPv6",
    base64: "cadena codificada en base64",
    base64url: "cadena codificada en base64url",
    json_string: "cadena JSON",
    e164: "n\xFAmero E.164",
    jwt: "JWT",
    template_literal: "entrada"
  };
  const TypeDictionary = {
    nan: "NaN"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type": {
        const expected = TypeDictionary[issue2.expected] ?? issue2.expected;
        const receivedType = parsedType(issue2.input);
        const received = TypeDictionary[receivedType] ?? receivedType;
        if (/^[A-Z]/.test(issue2.expected)) {
          return `Tipus inv\xE0lid: s'esperava instanceof ${issue2.expected}, s'ha rebut ${received}`;
        }
        return `Tipus inv\xE0lid: s'esperava ${expected}, s'ha rebut ${received}`;
      }
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Valor inv\xE0lid: s'esperava ${stringifyPrimitive(issue2.values[0])}`;
        return `Opci\xF3 inv\xE0lida: s'esperava una de ${joinValues(issue2.values, " o ")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "com a m\xE0xim" : "menys de";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Massa gran: s'esperava que ${issue2.origin ?? "el valor"} contingu\xE9s ${adj} ${issue2.maximum.toString()} ${sizing.unit ?? "elements"}`;
        return `Massa gran: s'esperava que ${issue2.origin ?? "el valor"} fos ${adj} ${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? "com a m\xEDnim" : "m\xE9s de";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Massa petit: s'esperava que ${issue2.origin} contingu\xE9s ${adj} ${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `Massa petit: s'esperava que ${issue2.origin} fos ${adj} ${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `Format inv\xE0lid: ha de comen\xE7ar amb "${_issue.prefix}"`;
        }
        if (_issue.format === "ends_with")
          return `Format inv\xE0lid: ha d'acabar amb "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Format inv\xE0lid: ha d'incloure "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Format inv\xE0lid: ha de coincidir amb el patr\xF3 ${_issue.pattern}`;
        return `Format inv\xE0lid per a ${FormatDictionary[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `N\xFAmero inv\xE0lid: ha de ser m\xFAltiple de ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Clau${issue2.keys.length > 1 ? "s" : ""} no reconeguda${issue2.keys.length > 1 ? "s" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Clau inv\xE0lida a ${issue2.origin}`;
      case "invalid_union":
        return "Entrada inv\xE0lida";
      // Could also be "Tipus d'unió invàlid" but "Entrada invàlida" is more general
      case "invalid_element":
        return `Element inv\xE0lid a ${issue2.origin}`;
      default:
        return `Entrada inv\xE0lida`;
    }
  };
};
function ca_default() {
  return {
    localeError: error5()
  };
}

// node_modules/zod/v4/locales/cs.js
var error6 = () => {
  const Sizable = {
    string: { unit: "znak\u016F", verb: "m\xEDt" },
    file: { unit: "bajt\u016F", verb: "m\xEDt" },
    array: { unit: "prvk\u016F", verb: "m\xEDt" },
    set: { unit: "prvk\u016F", verb: "m\xEDt" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const FormatDictionary = {
    regex: "regul\xE1rn\xED v\xFDraz",
    email: "e-mailov\xE1 adresa",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "datum a \u010Das ve form\xE1tu ISO",
    date: "datum ve form\xE1tu ISO",
    time: "\u010Das ve form\xE1tu ISO",
    duration: "doba trv\xE1n\xED ISO",
    ipv4: "IPv4 adresa",
    ipv6: "IPv6 adresa",
    cidrv4: "rozsah IPv4",
    cidrv6: "rozsah IPv6",
    base64: "\u0159et\u011Bzec zak\xF3dovan\xFD ve form\xE1tu base64",
    base64url: "\u0159et\u011Bzec zak\xF3dovan\xFD ve form\xE1tu base64url",
    json_string: "\u0159et\u011Bzec ve form\xE1tu JSON",
    e164: "\u010D\xEDslo E.164",
    jwt: "JWT",
    template_literal: "vstup"
  };
  const TypeDictionary = {
    nan: "NaN",
    number: "\u010D\xEDslo",
    string: "\u0159et\u011Bzec",
    function: "funkce",
    array: "pole"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type": {
        const expected = TypeDictionary[issue2.expected] ?? issue2.expected;
        const receivedType = parsedType(issue2.input);
        const received = TypeDictionary[receivedType] ?? receivedType;
        if (/^[A-Z]/.test(issue2.expected)) {
          return `Neplatn\xFD vstup: o\u010Dek\xE1v\xE1no instanceof ${issue2.expected}, obdr\u017Eeno ${received}`;
        }
        return `Neplatn\xFD vstup: o\u010Dek\xE1v\xE1no ${expected}, obdr\u017Eeno ${received}`;
      }
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Neplatn\xFD vstup: o\u010Dek\xE1v\xE1no ${stringifyPrimitive(issue2.values[0])}`;
        return `Neplatn\xE1 mo\u017Enost: o\u010Dek\xE1v\xE1na jedna z hodnot ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Hodnota je p\u0159\xEDli\u0161 velk\xE1: ${issue2.origin ?? "hodnota"} mus\xED m\xEDt ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "prvk\u016F"}`;
        }
        return `Hodnota je p\u0159\xEDli\u0161 velk\xE1: ${issue2.origin ?? "hodnota"} mus\xED b\xFDt ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Hodnota je p\u0159\xEDli\u0161 mal\xE1: ${issue2.origin ?? "hodnota"} mus\xED m\xEDt ${adj}${issue2.minimum.toString()} ${sizing.unit ?? "prvk\u016F"}`;
        }
        return `Hodnota je p\u0159\xEDli\u0161 mal\xE1: ${issue2.origin ?? "hodnota"} mus\xED b\xFDt ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Neplatn\xFD \u0159et\u011Bzec: mus\xED za\u010D\xEDnat na "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Neplatn\xFD \u0159et\u011Bzec: mus\xED kon\u010Dit na "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Neplatn\xFD \u0159et\u011Bzec: mus\xED obsahovat "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Neplatn\xFD \u0159et\u011Bzec: mus\xED odpov\xEDdat vzoru ${_issue.pattern}`;
        return `Neplatn\xFD form\xE1t ${FormatDictionary[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Neplatn\xE9 \u010D\xEDslo: mus\xED b\xFDt n\xE1sobkem ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Nezn\xE1m\xE9 kl\xED\u010De: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Neplatn\xFD kl\xED\u010D v ${issue2.origin}`;
      case "invalid_union":
        return "Neplatn\xFD vstup";
      case "invalid_element":
        return `Neplatn\xE1 hodnota v ${issue2.origin}`;
      default:
        return `Neplatn\xFD vstup`;
    }
  };
};
function cs_default() {
  return {
    localeError: error6()
  };
}

// node_modules/zod/v4/locales/da.js
var error7 = () => {
  const Sizable = {
    string: { unit: "tegn", verb: "havde" },
    file: { unit: "bytes", verb: "havde" },
    array: { unit: "elementer", verb: "indeholdt" },
    set: { unit: "elementer", verb: "indeholdt" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const FormatDictionary = {
    regex: "input",
    email: "e-mailadresse",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO dato- og klokkesl\xE6t",
    date: "ISO-dato",
    time: "ISO-klokkesl\xE6t",
    duration: "ISO-varighed",
    ipv4: "IPv4-omr\xE5de",
    ipv6: "IPv6-omr\xE5de",
    cidrv4: "IPv4-spektrum",
    cidrv6: "IPv6-spektrum",
    base64: "base64-kodet streng",
    base64url: "base64url-kodet streng",
    json_string: "JSON-streng",
    e164: "E.164-nummer",
    jwt: "JWT",
    template_literal: "input"
  };
  const TypeDictionary = {
    nan: "NaN",
    string: "streng",
    number: "tal",
    boolean: "boolean",
    array: "liste",
    object: "objekt",
    set: "s\xE6t",
    file: "fil"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type": {
        const expected = TypeDictionary[issue2.expected] ?? issue2.expected;
        const receivedType = parsedType(issue2.input);
        const received = TypeDictionary[receivedType] ?? receivedType;
        if (/^[A-Z]/.test(issue2.expected)) {
          return `Ugyldigt input: forventede instanceof ${issue2.expected}, fik ${received}`;
        }
        return `Ugyldigt input: forventede ${expected}, fik ${received}`;
      }
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Ugyldig v\xE6rdi: forventede ${stringifyPrimitive(issue2.values[0])}`;
        return `Ugyldigt valg: forventede en af f\xF8lgende ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        const origin = TypeDictionary[issue2.origin] ?? issue2.origin;
        if (sizing)
          return `For stor: forventede ${origin ?? "value"} ${sizing.verb} ${adj} ${issue2.maximum.toString()} ${sizing.unit ?? "elementer"}`;
        return `For stor: forventede ${origin ?? "value"} havde ${adj} ${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        const origin = TypeDictionary[issue2.origin] ?? issue2.origin;
        if (sizing) {
          return `For lille: forventede ${origin} ${sizing.verb} ${adj} ${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `For lille: forventede ${origin} havde ${adj} ${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Ugyldig streng: skal starte med "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Ugyldig streng: skal ende med "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Ugyldig streng: skal indeholde "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Ugyldig streng: skal matche m\xF8nsteret ${_issue.pattern}`;
        return `Ugyldig ${FormatDictionary[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Ugyldigt tal: skal v\xE6re deleligt med ${issue2.divisor}`;
      case "unrecognized_keys":
        return `${issue2.keys.length > 1 ? "Ukendte n\xF8gler" : "Ukendt n\xF8gle"}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Ugyldig n\xF8gle i ${issue2.origin}`;
      case "invalid_union":
        return "Ugyldigt input: matcher ingen af de tilladte typer";
      case "invalid_element":
        return `Ugyldig v\xE6rdi i ${issue2.origin}`;
      default:
        return `Ugyldigt input`;
    }
  };
};
function da_default() {
  return {
    localeError: error7()
  };
}

// node_modules/zod/v4/locales/de.js
var error8 = () => {
  const Sizable = {
    string: { unit: "Zeichen", verb: "zu haben" },
    file: { unit: "Bytes", verb: "zu haben" },
    array: { unit: "Elemente", verb: "zu haben" },
    set: { unit: "Elemente", verb: "zu haben" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const FormatDictionary = {
    regex: "Eingabe",
    email: "E-Mail-Adresse",
    url: "URL",
    emoji: "Emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO-Datum und -Uhrzeit",
    date: "ISO-Datum",
    time: "ISO-Uhrzeit",
    duration: "ISO-Dauer",
    ipv4: "IPv4-Adresse",
    ipv6: "IPv6-Adresse",
    cidrv4: "IPv4-Bereich",
    cidrv6: "IPv6-Bereich",
    base64: "Base64-codierter String",
    base64url: "Base64-URL-codierter String",
    json_string: "JSON-String",
    e164: "E.164-Nummer",
    jwt: "JWT",
    template_literal: "Eingabe"
  };
  const TypeDictionary = {
    nan: "NaN",
    number: "Zahl",
    array: "Array"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type": {
        const expected = TypeDictionary[issue2.expected] ?? issue2.expected;
        const receivedType = parsedType(issue2.input);
        const received = TypeDictionary[receivedType] ?? receivedType;
        if (/^[A-Z]/.test(issue2.expected)) {
          return `Ung\xFCltige Eingabe: erwartet instanceof ${issue2.expected}, erhalten ${received}`;
        }
        return `Ung\xFCltige Eingabe: erwartet ${expected}, erhalten ${received}`;
      }
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Ung\xFCltige Eingabe: erwartet ${stringifyPrimitive(issue2.values[0])}`;
        return `Ung\xFCltige Option: erwartet eine von ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Zu gro\xDF: erwartet, dass ${issue2.origin ?? "Wert"} ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "Elemente"} hat`;
        return `Zu gro\xDF: erwartet, dass ${issue2.origin ?? "Wert"} ${adj}${issue2.maximum.toString()} ist`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Zu klein: erwartet, dass ${issue2.origin} ${adj}${issue2.minimum.toString()} ${sizing.unit} hat`;
        }
        return `Zu klein: erwartet, dass ${issue2.origin} ${adj}${issue2.minimum.toString()} ist`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Ung\xFCltiger String: muss mit "${_issue.prefix}" beginnen`;
        if (_issue.format === "ends_with")
          return `Ung\xFCltiger String: muss mit "${_issue.suffix}" enden`;
        if (_issue.format === "includes")
          return `Ung\xFCltiger String: muss "${_issue.includes}" enthalten`;
        if (_issue.format === "regex")
          return `Ung\xFCltiger String: muss dem Muster ${_issue.pattern} entsprechen`;
        return `Ung\xFCltig: ${FormatDictionary[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Ung\xFCltige Zahl: muss ein Vielfaches von ${issue2.divisor} sein`;
      case "unrecognized_keys":
        return `${issue2.keys.length > 1 ? "Unbekannte Schl\xFCssel" : "Unbekannter Schl\xFCssel"}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Ung\xFCltiger Schl\xFCssel in ${issue2.origin}`;
      case "invalid_union":
        return "Ung\xFCltige Eingabe";
      case "invalid_element":
        return `Ung\xFCltiger Wert in ${issue2.origin}`;
      default:
        return `Ung\xFCltige Eingabe`;
    }
  };
};
function de_default() {
  return {
    localeError: error8()
  };
}

// node_modules/zod/v4/locales/en.js
var error9 = () => {
  const Sizable = {
    string: { unit: "characters", verb: "to have" },
    file: { unit: "bytes", verb: "to have" },
    array: { unit: "items", verb: "to have" },
    set: { unit: "items", verb: "to have" },
    map: { unit: "entries", verb: "to have" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const FormatDictionary = {
    regex: "input",
    email: "email address",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO datetime",
    date: "ISO date",
    time: "ISO time",
    duration: "ISO duration",
    ipv4: "IPv4 address",
    ipv6: "IPv6 address",
    mac: "MAC address",
    cidrv4: "IPv4 range",
    cidrv6: "IPv6 range",
    base64: "base64-encoded string",
    base64url: "base64url-encoded string",
    json_string: "JSON string",
    e164: "E.164 number",
    jwt: "JWT",
    template_literal: "input"
  };
  const TypeDictionary = {
    // Compatibility: "nan" -> "NaN" for display
    nan: "NaN"
    // All other type names omitted - they fall back to raw values via ?? operator
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type": {
        const expected = TypeDictionary[issue2.expected] ?? issue2.expected;
        const receivedType = parsedType(issue2.input);
        const received = TypeDictionary[receivedType] ?? receivedType;
        return `Invalid input: expected ${expected}, received ${received}`;
      }
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Invalid input: expected ${stringifyPrimitive(issue2.values[0])}`;
        return `Invalid option: expected one of ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Too big: expected ${issue2.origin ?? "value"} to have ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "elements"}`;
        return `Too big: expected ${issue2.origin ?? "value"} to be ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Too small: expected ${issue2.origin} to have ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `Too small: expected ${issue2.origin} to be ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `Invalid string: must start with "${_issue.prefix}"`;
        }
        if (_issue.format === "ends_with")
          return `Invalid string: must end with "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Invalid string: must include "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Invalid string: must match pattern ${_issue.pattern}`;
        return `Invalid ${FormatDictionary[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Invalid number: must be a multiple of ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Unrecognized key${issue2.keys.length > 1 ? "s" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Invalid key in ${issue2.origin}`;
      case "invalid_union":
        return "Invalid input";
      case "invalid_element":
        return `Invalid value in ${issue2.origin}`;
      default:
        return `Invalid input`;
    }
  };
};
function en_default() {
  return {
    localeError: error9()
  };
}

// node_modules/zod/v4/locales/eo.js
var error10 = () => {
  const Sizable = {
    string: { unit: "karaktrojn", verb: "havi" },
    file: { unit: "bajtojn", verb: "havi" },
    array: { unit: "elementojn", verb: "havi" },
    set: { unit: "elementojn", verb: "havi" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const FormatDictionary = {
    regex: "enigo",
    email: "retadreso",
    url: "URL",
    emoji: "emo\u011Dio",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO-datotempo",
    date: "ISO-dato",
    time: "ISO-tempo",
    duration: "ISO-da\u016Dro",
    ipv4: "IPv4-adreso",
    ipv6: "IPv6-adreso",
    cidrv4: "IPv4-rango",
    cidrv6: "IPv6-rango",
    base64: "64-ume kodita karaktraro",
    base64url: "URL-64-ume kodita karaktraro",
    json_string: "JSON-karaktraro",
    e164: "E.164-nombro",
    jwt: "JWT",
    template_literal: "enigo"
  };
  const TypeDictionary = {
    nan: "NaN",
    number: "nombro",
    array: "tabelo",
    null: "senvalora"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type": {
        const expected = TypeDictionary[issue2.expected] ?? issue2.expected;
        const receivedType = parsedType(issue2.input);
        const received = TypeDictionary[receivedType] ?? receivedType;
        if (/^[A-Z]/.test(issue2.expected)) {
          return `Nevalida enigo: atendi\u011Dis instanceof ${issue2.expected}, ricevi\u011Dis ${received}`;
        }
        return `Nevalida enigo: atendi\u011Dis ${expected}, ricevi\u011Dis ${received}`;
      }
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Nevalida enigo: atendi\u011Dis ${stringifyPrimitive(issue2.values[0])}`;
        return `Nevalida opcio: atendi\u011Dis unu el ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Tro granda: atendi\u011Dis ke ${issue2.origin ?? "valoro"} havu ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "elementojn"}`;
        return `Tro granda: atendi\u011Dis ke ${issue2.origin ?? "valoro"} havu ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Tro malgranda: atendi\u011Dis ke ${issue2.origin} havu ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `Tro malgranda: atendi\u011Dis ke ${issue2.origin} estu ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Nevalida karaktraro: devas komenci\u011Di per "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Nevalida karaktraro: devas fini\u011Di per "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Nevalida karaktraro: devas inkluzivi "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Nevalida karaktraro: devas kongrui kun la modelo ${_issue.pattern}`;
        return `Nevalida ${FormatDictionary[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Nevalida nombro: devas esti oblo de ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Nekonata${issue2.keys.length > 1 ? "j" : ""} \u015Dlosilo${issue2.keys.length > 1 ? "j" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Nevalida \u015Dlosilo en ${issue2.origin}`;
      case "invalid_union":
        return "Nevalida enigo";
      case "invalid_element":
        return `Nevalida valoro en ${issue2.origin}`;
      default:
        return `Nevalida enigo`;
    }
  };
};
function eo_default() {
  return {
    localeError: error10()
  };
}

// node_modules/zod/v4/locales/es.js
var error11 = () => {
  const Sizable = {
    string: { unit: "caracteres", verb: "tener" },
    file: { unit: "bytes", verb: "tener" },
    array: { unit: "elementos", verb: "tener" },
    set: { unit: "elementos", verb: "tener" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const FormatDictionary = {
    regex: "entrada",
    email: "direcci\xF3n de correo electr\xF3nico",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "fecha y hora ISO",
    date: "fecha ISO",
    time: "hora ISO",
    duration: "duraci\xF3n ISO",
    ipv4: "direcci\xF3n IPv4",
    ipv6: "direcci\xF3n IPv6",
    cidrv4: "rango IPv4",
    cidrv6: "rango IPv6",
    base64: "cadena codificada en base64",
    base64url: "URL codificada en base64",
    json_string: "cadena JSON",
    e164: "n\xFAmero E.164",
    jwt: "JWT",
    template_literal: "entrada"
  };
  const TypeDictionary = {
    nan: "NaN",
    string: "texto",
    number: "n\xFAmero",
    boolean: "booleano",
    array: "arreglo",
    object: "objeto",
    set: "conjunto",
    file: "archivo",
    date: "fecha",
    bigint: "n\xFAmero grande",
    symbol: "s\xEDmbolo",
    undefined: "indefinido",
    null: "nulo",
    function: "funci\xF3n",
    map: "mapa",
    record: "registro",
    tuple: "tupla",
    enum: "enumeraci\xF3n",
    union: "uni\xF3n",
    literal: "literal",
    promise: "promesa",
    void: "vac\xEDo",
    never: "nunca",
    unknown: "desconocido",
    any: "cualquiera"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type": {
        const expected = TypeDictionary[issue2.expected] ?? issue2.expected;
        const receivedType = parsedType(issue2.input);
        const received = TypeDictionary[receivedType] ?? receivedType;
        if (/^[A-Z]/.test(issue2.expected)) {
          return `Entrada inv\xE1lida: se esperaba instanceof ${issue2.expected}, recibido ${received}`;
        }
        return `Entrada inv\xE1lida: se esperaba ${expected}, recibido ${received}`;
      }
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Entrada inv\xE1lida: se esperaba ${stringifyPrimitive(issue2.values[0])}`;
        return `Opci\xF3n inv\xE1lida: se esperaba una de ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        const origin = TypeDictionary[issue2.origin] ?? issue2.origin;
        if (sizing)
          return `Demasiado grande: se esperaba que ${origin ?? "valor"} tuviera ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "elementos"}`;
        return `Demasiado grande: se esperaba que ${origin ?? "valor"} fuera ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        const origin = TypeDictionary[issue2.origin] ?? issue2.origin;
        if (sizing) {
          return `Demasiado peque\xF1o: se esperaba que ${origin} tuviera ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `Demasiado peque\xF1o: se esperaba que ${origin} fuera ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Cadena inv\xE1lida: debe comenzar con "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Cadena inv\xE1lida: debe terminar en "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Cadena inv\xE1lida: debe incluir "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Cadena inv\xE1lida: debe coincidir con el patr\xF3n ${_issue.pattern}`;
        return `Inv\xE1lido ${FormatDictionary[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `N\xFAmero inv\xE1lido: debe ser m\xFAltiplo de ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Llave${issue2.keys.length > 1 ? "s" : ""} desconocida${issue2.keys.length > 1 ? "s" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Llave inv\xE1lida en ${TypeDictionary[issue2.origin] ?? issue2.origin}`;
      case "invalid_union":
        return "Entrada inv\xE1lida";
      case "invalid_element":
        return `Valor inv\xE1lido en ${TypeDictionary[issue2.origin] ?? issue2.origin}`;
      default:
        return `Entrada inv\xE1lida`;
    }
  };
};
function es_default() {
  return {
    localeError: error11()
  };
}

// node_modules/zod/v4/locales/fa.js
var error12 = () => {
  const Sizable = {
    string: { unit: "\u06A9\u0627\u0631\u0627\u06A9\u062A\u0631", verb: "\u062F\u0627\u0634\u062A\u0647 \u0628\u0627\u0634\u062F" },
    file: { unit: "\u0628\u0627\u06CC\u062A", verb: "\u062F\u0627\u0634\u062A\u0647 \u0628\u0627\u0634\u062F" },
    array: { unit: "\u0622\u06CC\u062A\u0645", verb: "\u062F\u0627\u0634\u062A\u0647 \u0628\u0627\u0634\u062F" },
    set: { unit: "\u0622\u06CC\u062A\u0645", verb: "\u062F\u0627\u0634\u062A\u0647 \u0628\u0627\u0634\u062F" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const FormatDictionary = {
    regex: "\u0648\u0631\u0648\u062F\u06CC",
    email: "\u0622\u062F\u0631\u0633 \u0627\u06CC\u0645\u06CC\u0644",
    url: "URL",
    emoji: "\u0627\u06CC\u0645\u0648\u062C\u06CC",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "\u062A\u0627\u0631\u06CC\u062E \u0648 \u0632\u0645\u0627\u0646 \u0627\u06CC\u0632\u0648",
    date: "\u062A\u0627\u0631\u06CC\u062E \u0627\u06CC\u0632\u0648",
    time: "\u0632\u0645\u0627\u0646 \u0627\u06CC\u0632\u0648",
    duration: "\u0645\u062F\u062A \u0632\u0645\u0627\u0646 \u0627\u06CC\u0632\u0648",
    ipv4: "IPv4 \u0622\u062F\u0631\u0633",
    ipv6: "IPv6 \u0622\u062F\u0631\u0633",
    cidrv4: "IPv4 \u062F\u0627\u0645\u0646\u0647",
    cidrv6: "IPv6 \u062F\u0627\u0645\u0646\u0647",
    base64: "base64-encoded \u0631\u0634\u062A\u0647",
    base64url: "base64url-encoded \u0631\u0634\u062A\u0647",
    json_string: "JSON \u0631\u0634\u062A\u0647",
    e164: "E.164 \u0639\u062F\u062F",
    jwt: "JWT",
    template_literal: "\u0648\u0631\u0648\u062F\u06CC"
  };
  const TypeDictionary = {
    nan: "NaN",
    number: "\u0639\u062F\u062F",
    array: "\u0622\u0631\u0627\u06CC\u0647"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type": {
        const expected = TypeDictionary[issue2.expected] ?? issue2.expected;
        const receivedType = parsedType(issue2.input);
        const received = TypeDictionary[receivedType] ?? receivedType;
        if (/^[A-Z]/.test(issue2.expected)) {
          return `\u0648\u0631\u0648\u062F\u06CC \u0646\u0627\u0645\u0639\u062A\u0628\u0631: \u0645\u06CC\u200C\u0628\u0627\u06CC\u0633\u062A instanceof ${issue2.expected} \u0645\u06CC\u200C\u0628\u0648\u062F\u060C ${received} \u062F\u0631\u06CC\u0627\u0641\u062A \u0634\u062F`;
        }
        return `\u0648\u0631\u0648\u062F\u06CC \u0646\u0627\u0645\u0639\u062A\u0628\u0631: \u0645\u06CC\u200C\u0628\u0627\u06CC\u0633\u062A ${expected} \u0645\u06CC\u200C\u0628\u0648\u062F\u060C ${received} \u062F\u0631\u06CC\u0627\u0641\u062A \u0634\u062F`;
      }
      case "invalid_value":
        if (issue2.values.length === 1) {
          return `\u0648\u0631\u0648\u062F\u06CC \u0646\u0627\u0645\u0639\u062A\u0628\u0631: \u0645\u06CC\u200C\u0628\u0627\u06CC\u0633\u062A ${stringifyPrimitive(issue2.values[0])} \u0645\u06CC\u200C\u0628\u0648\u062F`;
        }
        return `\u06AF\u0632\u06CC\u0646\u0647 \u0646\u0627\u0645\u0639\u062A\u0628\u0631: \u0645\u06CC\u200C\u0628\u0627\u06CC\u0633\u062A \u06CC\u06A9\u06CC \u0627\u0632 ${joinValues(issue2.values, "|")} \u0645\u06CC\u200C\u0628\u0648\u062F`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `\u062E\u06CC\u0644\u06CC \u0628\u0632\u0631\u06AF: ${issue2.origin ?? "\u0645\u0642\u062F\u0627\u0631"} \u0628\u0627\u06CC\u062F ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "\u0639\u0646\u0635\u0631"} \u0628\u0627\u0634\u062F`;
        }
        return `\u062E\u06CC\u0644\u06CC \u0628\u0632\u0631\u06AF: ${issue2.origin ?? "\u0645\u0642\u062F\u0627\u0631"} \u0628\u0627\u06CC\u062F ${adj}${issue2.maximum.toString()} \u0628\u0627\u0634\u062F`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `\u062E\u06CC\u0644\u06CC \u06A9\u0648\u0686\u06A9: ${issue2.origin} \u0628\u0627\u06CC\u062F ${adj}${issue2.minimum.toString()} ${sizing.unit} \u0628\u0627\u0634\u062F`;
        }
        return `\u062E\u06CC\u0644\u06CC \u06A9\u0648\u0686\u06A9: ${issue2.origin} \u0628\u0627\u06CC\u062F ${adj}${issue2.minimum.toString()} \u0628\u0627\u0634\u062F`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `\u0631\u0634\u062A\u0647 \u0646\u0627\u0645\u0639\u062A\u0628\u0631: \u0628\u0627\u06CC\u062F \u0628\u0627 "${_issue.prefix}" \u0634\u0631\u0648\u0639 \u0634\u0648\u062F`;
        }
        if (_issue.format === "ends_with") {
          return `\u0631\u0634\u062A\u0647 \u0646\u0627\u0645\u0639\u062A\u0628\u0631: \u0628\u0627\u06CC\u062F \u0628\u0627 "${_issue.suffix}" \u062A\u0645\u0627\u0645 \u0634\u0648\u062F`;
        }
        if (_issue.format === "includes") {
          return `\u0631\u0634\u062A\u0647 \u0646\u0627\u0645\u0639\u062A\u0628\u0631: \u0628\u0627\u06CC\u062F \u0634\u0627\u0645\u0644 "${_issue.includes}" \u0628\u0627\u0634\u062F`;
        }
        if (_issue.format === "regex") {
          return `\u0631\u0634\u062A\u0647 \u0646\u0627\u0645\u0639\u062A\u0628\u0631: \u0628\u0627\u06CC\u062F \u0628\u0627 \u0627\u0644\u06AF\u0648\u06CC ${_issue.pattern} \u0645\u0637\u0627\u0628\u0642\u062A \u062F\u0627\u0634\u062A\u0647 \u0628\u0627\u0634\u062F`;
        }
        return `${FormatDictionary[_issue.format] ?? issue2.format} \u0646\u0627\u0645\u0639\u062A\u0628\u0631`;
      }
      case "not_multiple_of":
        return `\u0639\u062F\u062F \u0646\u0627\u0645\u0639\u062A\u0628\u0631: \u0628\u0627\u06CC\u062F \u0645\u0636\u0631\u0628 ${issue2.divisor} \u0628\u0627\u0634\u062F`;
      case "unrecognized_keys":
        return `\u06A9\u0644\u06CC\u062F${issue2.keys.length > 1 ? "\u0647\u0627\u06CC" : ""} \u0646\u0627\u0634\u0646\u0627\u0633: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `\u06A9\u0644\u06CC\u062F \u0646\u0627\u0634\u0646\u0627\u0633 \u062F\u0631 ${issue2.origin}`;
      case "invalid_union":
        return `\u0648\u0631\u0648\u062F\u06CC \u0646\u0627\u0645\u0639\u062A\u0628\u0631`;
      case "invalid_element":
        return `\u0645\u0642\u062F\u0627\u0631 \u0646\u0627\u0645\u0639\u062A\u0628\u0631 \u062F\u0631 ${issue2.origin}`;
      default:
        return `\u0648\u0631\u0648\u062F\u06CC \u0646\u0627\u0645\u0639\u062A\u0628\u0631`;
    }
  };
};
function fa_default() {
  return {
    localeError: error12()
  };
}

// node_modules/zod/v4/locales/fi.js
var error13 = () => {
  const Sizable = {
    string: { unit: "merkki\xE4", subject: "merkkijonon" },
    file: { unit: "tavua", subject: "tiedoston" },
    array: { unit: "alkiota", subject: "listan" },
    set: { unit: "alkiota", subject: "joukon" },
    number: { unit: "", subject: "luvun" },
    bigint: { unit: "", subject: "suuren kokonaisluvun" },
    int: { unit: "", subject: "kokonaisluvun" },
    date: { unit: "", subject: "p\xE4iv\xE4m\xE4\xE4r\xE4n" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const FormatDictionary = {
    regex: "s\xE4\xE4nn\xF6llinen lauseke",
    email: "s\xE4hk\xF6postiosoite",
    url: "URL-osoite",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO-aikaleima",
    date: "ISO-p\xE4iv\xE4m\xE4\xE4r\xE4",
    time: "ISO-aika",
    duration: "ISO-kesto",
    ipv4: "IPv4-osoite",
    ipv6: "IPv6-osoite",
    cidrv4: "IPv4-alue",
    cidrv6: "IPv6-alue",
    base64: "base64-koodattu merkkijono",
    base64url: "base64url-koodattu merkkijono",
    json_string: "JSON-merkkijono",
    e164: "E.164-luku",
    jwt: "JWT",
    template_literal: "templaattimerkkijono"
  };
  const TypeDictionary = {
    nan: "NaN"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type": {
        const expected = TypeDictionary[issue2.expected] ?? issue2.expected;
        const receivedType = parsedType(issue2.input);
        const received = TypeDictionary[receivedType] ?? receivedType;
        if (/^[A-Z]/.test(issue2.expected)) {
          return `Virheellinen tyyppi: odotettiin instanceof ${issue2.expected}, oli ${received}`;
        }
        return `Virheellinen tyyppi: odotettiin ${expected}, oli ${received}`;
      }
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Virheellinen sy\xF6te: t\xE4ytyy olla ${stringifyPrimitive(issue2.values[0])}`;
        return `Virheellinen valinta: t\xE4ytyy olla yksi seuraavista: ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Liian suuri: ${sizing.subject} t\xE4ytyy olla ${adj}${issue2.maximum.toString()} ${sizing.unit}`.trim();
        }
        return `Liian suuri: arvon t\xE4ytyy olla ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Liian pieni: ${sizing.subject} t\xE4ytyy olla ${adj}${issue2.minimum.toString()} ${sizing.unit}`.trim();
        }
        return `Liian pieni: arvon t\xE4ytyy olla ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Virheellinen sy\xF6te: t\xE4ytyy alkaa "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Virheellinen sy\xF6te: t\xE4ytyy loppua "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Virheellinen sy\xF6te: t\xE4ytyy sis\xE4lt\xE4\xE4 "${_issue.includes}"`;
        if (_issue.format === "regex") {
          return `Virheellinen sy\xF6te: t\xE4ytyy vastata s\xE4\xE4nn\xF6llist\xE4 lauseketta ${_issue.pattern}`;
        }
        return `Virheellinen ${FormatDictionary[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Virheellinen luku: t\xE4ytyy olla luvun ${issue2.divisor} monikerta`;
      case "unrecognized_keys":
        return `${issue2.keys.length > 1 ? "Tuntemattomat avaimet" : "Tuntematon avain"}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return "Virheellinen avain tietueessa";
      case "invalid_union":
        return "Virheellinen unioni";
      case "invalid_element":
        return "Virheellinen arvo joukossa";
      default:
        return `Virheellinen sy\xF6te`;
    }
  };
};
function fi_default() {
  return {
    localeError: error13()
  };
}

// node_modules/zod/v4/locales/fr.js
var error14 = () => {
  const Sizable = {
    string: { unit: "caract\xE8res", verb: "avoir" },
    file: { unit: "octets", verb: "avoir" },
    array: { unit: "\xE9l\xE9ments", verb: "avoir" },
    set: { unit: "\xE9l\xE9ments", verb: "avoir" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const FormatDictionary = {
    regex: "entr\xE9e",
    email: "adresse e-mail",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "date et heure ISO",
    date: "date ISO",
    time: "heure ISO",
    duration: "dur\xE9e ISO",
    ipv4: "adresse IPv4",
    ipv6: "adresse IPv6",
    cidrv4: "plage IPv4",
    cidrv6: "plage IPv6",
    base64: "cha\xEEne encod\xE9e en base64",
    base64url: "cha\xEEne encod\xE9e en base64url",
    json_string: "cha\xEEne JSON",
    e164: "num\xE9ro E.164",
    jwt: "JWT",
    template_literal: "entr\xE9e"
  };
  const TypeDictionary = {
    nan: "NaN",
    number: "nombre",
    array: "tableau"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type": {
        const expected = TypeDictionary[issue2.expected] ?? issue2.expected;
        const receivedType = parsedType(issue2.input);
        const received = TypeDictionary[receivedType] ?? receivedType;
        if (/^[A-Z]/.test(issue2.expected)) {
          return `Entr\xE9e invalide : instanceof ${issue2.expected} attendu, ${received} re\xE7u`;
        }
        return `Entr\xE9e invalide : ${expected} attendu, ${received} re\xE7u`;
      }
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Entr\xE9e invalide : ${stringifyPrimitive(issue2.values[0])} attendu`;
        return `Option invalide : une valeur parmi ${joinValues(issue2.values, "|")} attendue`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Trop grand : ${issue2.origin ?? "valeur"} doit ${sizing.verb} ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "\xE9l\xE9ment(s)"}`;
        return `Trop grand : ${issue2.origin ?? "valeur"} doit \xEAtre ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Trop petit : ${issue2.origin} doit ${sizing.verb} ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `Trop petit : ${issue2.origin} doit \xEAtre ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Cha\xEEne invalide : doit commencer par "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Cha\xEEne invalide : doit se terminer par "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Cha\xEEne invalide : doit inclure "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Cha\xEEne invalide : doit correspondre au mod\xE8le ${_issue.pattern}`;
        return `${FormatDictionary[_issue.format] ?? issue2.format} invalide`;
      }
      case "not_multiple_of":
        return `Nombre invalide : doit \xEAtre un multiple de ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Cl\xE9${issue2.keys.length > 1 ? "s" : ""} non reconnue${issue2.keys.length > 1 ? "s" : ""} : ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Cl\xE9 invalide dans ${issue2.origin}`;
      case "invalid_union":
        return "Entr\xE9e invalide";
      case "invalid_element":
        return `Valeur invalide dans ${issue2.origin}`;
      default:
        return `Entr\xE9e invalide`;
    }
  };
};
function fr_default() {
  return {
    localeError: error14()
  };
}

// node_modules/zod/v4/locales/fr-CA.js
var error15 = () => {
  const Sizable = {
    string: { unit: "caract\xE8res", verb: "avoir" },
    file: { unit: "octets", verb: "avoir" },
    array: { unit: "\xE9l\xE9ments", verb: "avoir" },
    set: { unit: "\xE9l\xE9ments", verb: "avoir" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const FormatDictionary = {
    regex: "entr\xE9e",
    email: "adresse courriel",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "date-heure ISO",
    date: "date ISO",
    time: "heure ISO",
    duration: "dur\xE9e ISO",
    ipv4: "adresse IPv4",
    ipv6: "adresse IPv6",
    cidrv4: "plage IPv4",
    cidrv6: "plage IPv6",
    base64: "cha\xEEne encod\xE9e en base64",
    base64url: "cha\xEEne encod\xE9e en base64url",
    json_string: "cha\xEEne JSON",
    e164: "num\xE9ro E.164",
    jwt: "JWT",
    template_literal: "entr\xE9e"
  };
  const TypeDictionary = {
    nan: "NaN"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type": {
        const expected = TypeDictionary[issue2.expected] ?? issue2.expected;
        const receivedType = parsedType(issue2.input);
        const received = TypeDictionary[receivedType] ?? receivedType;
        if (/^[A-Z]/.test(issue2.expected)) {
          return `Entr\xE9e invalide : attendu instanceof ${issue2.expected}, re\xE7u ${received}`;
        }
        return `Entr\xE9e invalide : attendu ${expected}, re\xE7u ${received}`;
      }
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Entr\xE9e invalide : attendu ${stringifyPrimitive(issue2.values[0])}`;
        return `Option invalide : attendu l'une des valeurs suivantes ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "\u2264" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Trop grand : attendu que ${issue2.origin ?? "la valeur"} ait ${adj}${issue2.maximum.toString()} ${sizing.unit}`;
        return `Trop grand : attendu que ${issue2.origin ?? "la valeur"} soit ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? "\u2265" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Trop petit : attendu que ${issue2.origin} ait ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `Trop petit : attendu que ${issue2.origin} soit ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `Cha\xEEne invalide : doit commencer par "${_issue.prefix}"`;
        }
        if (_issue.format === "ends_with")
          return `Cha\xEEne invalide : doit se terminer par "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Cha\xEEne invalide : doit inclure "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Cha\xEEne invalide : doit correspondre au motif ${_issue.pattern}`;
        return `${FormatDictionary[_issue.format] ?? issue2.format} invalide`;
      }
      case "not_multiple_of":
        return `Nombre invalide : doit \xEAtre un multiple de ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Cl\xE9${issue2.keys.length > 1 ? "s" : ""} non reconnue${issue2.keys.length > 1 ? "s" : ""} : ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Cl\xE9 invalide dans ${issue2.origin}`;
      case "invalid_union":
        return "Entr\xE9e invalide";
      case "invalid_element":
        return `Valeur invalide dans ${issue2.origin}`;
      default:
        return `Entr\xE9e invalide`;
    }
  };
};
function fr_CA_default() {
  return {
    localeError: error15()
  };
}

// node_modules/zod/v4/locales/he.js
var error16 = () => {
  const TypeNames = {
    string: { label: "\u05DE\u05D7\u05E8\u05D5\u05D6\u05EA", gender: "f" },
    number: { label: "\u05DE\u05E1\u05E4\u05E8", gender: "m" },
    boolean: { label: "\u05E2\u05E8\u05DA \u05D1\u05D5\u05DC\u05D9\u05D0\u05E0\u05D9", gender: "m" },
    bigint: { label: "BigInt", gender: "m" },
    date: { label: "\u05EA\u05D0\u05E8\u05D9\u05DA", gender: "m" },
    array: { label: "\u05DE\u05E2\u05E8\u05DA", gender: "m" },
    object: { label: "\u05D0\u05D5\u05D1\u05D9\u05D9\u05E7\u05D8", gender: "m" },
    null: { label: "\u05E2\u05E8\u05DA \u05E8\u05D9\u05E7 (null)", gender: "m" },
    undefined: { label: "\u05E2\u05E8\u05DA \u05DC\u05D0 \u05DE\u05D5\u05D2\u05D3\u05E8 (undefined)", gender: "m" },
    symbol: { label: "\u05E1\u05D9\u05DE\u05D1\u05D5\u05DC (Symbol)", gender: "m" },
    function: { label: "\u05E4\u05D5\u05E0\u05E7\u05E6\u05D9\u05D4", gender: "f" },
    map: { label: "\u05DE\u05E4\u05D4 (Map)", gender: "f" },
    set: { label: "\u05E7\u05D1\u05D5\u05E6\u05D4 (Set)", gender: "f" },
    file: { label: "\u05E7\u05D5\u05D1\u05E5", gender: "m" },
    promise: { label: "Promise", gender: "m" },
    NaN: { label: "NaN", gender: "m" },
    unknown: { label: "\u05E2\u05E8\u05DA \u05DC\u05D0 \u05D9\u05D3\u05D5\u05E2", gender: "m" },
    value: { label: "\u05E2\u05E8\u05DA", gender: "m" }
  };
  const Sizable = {
    string: { unit: "\u05EA\u05D5\u05D5\u05D9\u05DD", shortLabel: "\u05E7\u05E6\u05E8", longLabel: "\u05D0\u05E8\u05D5\u05DA" },
    file: { unit: "\u05D1\u05D9\u05D9\u05D8\u05D9\u05DD", shortLabel: "\u05E7\u05D8\u05DF", longLabel: "\u05D2\u05D3\u05D5\u05DC" },
    array: { unit: "\u05E4\u05E8\u05D9\u05D8\u05D9\u05DD", shortLabel: "\u05E7\u05D8\u05DF", longLabel: "\u05D2\u05D3\u05D5\u05DC" },
    set: { unit: "\u05E4\u05E8\u05D9\u05D8\u05D9\u05DD", shortLabel: "\u05E7\u05D8\u05DF", longLabel: "\u05D2\u05D3\u05D5\u05DC" },
    number: { unit: "", shortLabel: "\u05E7\u05D8\u05DF", longLabel: "\u05D2\u05D3\u05D5\u05DC" }
    // no unit
  };
  const typeEntry = (t) => t ? TypeNames[t] : void 0;
  const typeLabel = (t) => {
    const e = typeEntry(t);
    if (e)
      return e.label;
    return t ?? TypeNames.unknown.label;
  };
  const withDefinite = (t) => `\u05D4${typeLabel(t)}`;
  const verbFor = (t) => {
    const e = typeEntry(t);
    const gender = e?.gender ?? "m";
    return gender === "f" ? "\u05E6\u05E8\u05D9\u05DB\u05D4 \u05DC\u05D4\u05D9\u05D5\u05EA" : "\u05E6\u05E8\u05D9\u05DA \u05DC\u05D4\u05D9\u05D5\u05EA";
  };
  const getSizing = (origin) => {
    if (!origin)
      return null;
    return Sizable[origin] ?? null;
  };
  const FormatDictionary = {
    regex: { label: "\u05E7\u05DC\u05D8", gender: "m" },
    email: { label: "\u05DB\u05EA\u05D5\u05D1\u05EA \u05D0\u05D9\u05DE\u05D9\u05D9\u05DC", gender: "f" },
    url: { label: "\u05DB\u05EA\u05D5\u05D1\u05EA \u05E8\u05E9\u05EA", gender: "f" },
    emoji: { label: "\u05D0\u05D9\u05DE\u05D5\u05D2'\u05D9", gender: "m" },
    uuid: { label: "UUID", gender: "m" },
    nanoid: { label: "nanoid", gender: "m" },
    guid: { label: "GUID", gender: "m" },
    cuid: { label: "cuid", gender: "m" },
    cuid2: { label: "cuid2", gender: "m" },
    ulid: { label: "ULID", gender: "m" },
    xid: { label: "XID", gender: "m" },
    ksuid: { label: "KSUID", gender: "m" },
    datetime: { label: "\u05EA\u05D0\u05E8\u05D9\u05DA \u05D5\u05D6\u05DE\u05DF ISO", gender: "m" },
    date: { label: "\u05EA\u05D0\u05E8\u05D9\u05DA ISO", gender: "m" },
    time: { label: "\u05D6\u05DE\u05DF ISO", gender: "m" },
    duration: { label: "\u05DE\u05E9\u05DA \u05D6\u05DE\u05DF ISO", gender: "m" },
    ipv4: { label: "\u05DB\u05EA\u05D5\u05D1\u05EA IPv4", gender: "f" },
    ipv6: { label: "\u05DB\u05EA\u05D5\u05D1\u05EA IPv6", gender: "f" },
    cidrv4: { label: "\u05D8\u05D5\u05D5\u05D7 IPv4", gender: "m" },
    cidrv6: { label: "\u05D8\u05D5\u05D5\u05D7 IPv6", gender: "m" },
    base64: { label: "\u05DE\u05D7\u05E8\u05D5\u05D6\u05EA \u05D1\u05D1\u05E1\u05D9\u05E1 64", gender: "f" },
    base64url: { label: "\u05DE\u05D7\u05E8\u05D5\u05D6\u05EA \u05D1\u05D1\u05E1\u05D9\u05E1 64 \u05DC\u05DB\u05EA\u05D5\u05D1\u05D5\u05EA \u05E8\u05E9\u05EA", gender: "f" },
    json_string: { label: "\u05DE\u05D7\u05E8\u05D5\u05D6\u05EA JSON", gender: "f" },
    e164: { label: "\u05DE\u05E1\u05E4\u05E8 E.164", gender: "m" },
    jwt: { label: "JWT", gender: "m" },
    ends_with: { label: "\u05E7\u05DC\u05D8", gender: "m" },
    includes: { label: "\u05E7\u05DC\u05D8", gender: "m" },
    lowercase: { label: "\u05E7\u05DC\u05D8", gender: "m" },
    starts_with: { label: "\u05E7\u05DC\u05D8", gender: "m" },
    uppercase: { label: "\u05E7\u05DC\u05D8", gender: "m" }
  };
  const TypeDictionary = {
    nan: "NaN"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type": {
        const expectedKey = issue2.expected;
        const expected = TypeDictionary[expectedKey ?? ""] ?? typeLabel(expectedKey);
        const receivedType = parsedType(issue2.input);
        const received = TypeDictionary[receivedType] ?? TypeNames[receivedType]?.label ?? receivedType;
        if (/^[A-Z]/.test(issue2.expected)) {
          return `\u05E7\u05DC\u05D8 \u05DC\u05D0 \u05EA\u05E7\u05D9\u05DF: \u05E6\u05E8\u05D9\u05DA \u05DC\u05D4\u05D9\u05D5\u05EA instanceof ${issue2.expected}, \u05D4\u05EA\u05E7\u05D1\u05DC ${received}`;
        }
        return `\u05E7\u05DC\u05D8 \u05DC\u05D0 \u05EA\u05E7\u05D9\u05DF: \u05E6\u05E8\u05D9\u05DA \u05DC\u05D4\u05D9\u05D5\u05EA ${expected}, \u05D4\u05EA\u05E7\u05D1\u05DC ${received}`;
      }
      case "invalid_value": {
        if (issue2.values.length === 1) {
          return `\u05E2\u05E8\u05DA \u05DC\u05D0 \u05EA\u05E7\u05D9\u05DF: \u05D4\u05E2\u05E8\u05DA \u05D7\u05D9\u05D9\u05D1 \u05DC\u05D4\u05D9\u05D5\u05EA ${stringifyPrimitive(issue2.values[0])}`;
        }
        const stringified = issue2.values.map((v) => stringifyPrimitive(v));
        if (issue2.values.length === 2) {
          return `\u05E2\u05E8\u05DA \u05DC\u05D0 \u05EA\u05E7\u05D9\u05DF: \u05D4\u05D0\u05E4\u05E9\u05E8\u05D5\u05D9\u05D5\u05EA \u05D4\u05DE\u05EA\u05D0\u05D9\u05DE\u05D5\u05EA \u05D4\u05DF ${stringified[0]} \u05D0\u05D5 ${stringified[1]}`;
        }
        const lastValue = stringified[stringified.length - 1];
        const restValues = stringified.slice(0, -1).join(", ");
        return `\u05E2\u05E8\u05DA \u05DC\u05D0 \u05EA\u05E7\u05D9\u05DF: \u05D4\u05D0\u05E4\u05E9\u05E8\u05D5\u05D9\u05D5\u05EA \u05D4\u05DE\u05EA\u05D0\u05D9\u05DE\u05D5\u05EA \u05D4\u05DF ${restValues} \u05D0\u05D5 ${lastValue}`;
      }
      case "too_big": {
        const sizing = getSizing(issue2.origin);
        const subject = withDefinite(issue2.origin ?? "value");
        if (issue2.origin === "string") {
          return `${sizing?.longLabel ?? "\u05D0\u05E8\u05D5\u05DA"} \u05DE\u05D3\u05D9: ${subject} \u05E6\u05E8\u05D9\u05DB\u05D4 \u05DC\u05D4\u05DB\u05D9\u05DC ${issue2.maximum.toString()} ${sizing?.unit ?? ""} ${issue2.inclusive ? "\u05D0\u05D5 \u05E4\u05D7\u05D5\u05EA" : "\u05DC\u05DB\u05DC \u05D4\u05D9\u05D5\u05EA\u05E8"}`.trim();
        }
        if (issue2.origin === "number") {
          const comparison = issue2.inclusive ? `\u05E7\u05D8\u05DF \u05D0\u05D5 \u05E9\u05D5\u05D5\u05D4 \u05DC-${issue2.maximum}` : `\u05E7\u05D8\u05DF \u05DE-${issue2.maximum}`;
          return `\u05D2\u05D3\u05D5\u05DC \u05DE\u05D3\u05D9: ${subject} \u05E6\u05E8\u05D9\u05DA \u05DC\u05D4\u05D9\u05D5\u05EA ${comparison}`;
        }
        if (issue2.origin === "array" || issue2.origin === "set") {
          const verb = issue2.origin === "set" ? "\u05E6\u05E8\u05D9\u05DB\u05D4" : "\u05E6\u05E8\u05D9\u05DA";
          const comparison = issue2.inclusive ? `${issue2.maximum} ${sizing?.unit ?? ""} \u05D0\u05D5 \u05E4\u05D7\u05D5\u05EA` : `\u05E4\u05D7\u05D5\u05EA \u05DE-${issue2.maximum} ${sizing?.unit ?? ""}`;
          return `\u05D2\u05D3\u05D5\u05DC \u05DE\u05D3\u05D9: ${subject} ${verb} \u05DC\u05D4\u05DB\u05D9\u05DC ${comparison}`.trim();
        }
        const adj = issue2.inclusive ? "<=" : "<";
        const be = verbFor(issue2.origin ?? "value");
        if (sizing?.unit) {
          return `${sizing.longLabel} \u05DE\u05D3\u05D9: ${subject} ${be} ${adj}${issue2.maximum.toString()} ${sizing.unit}`;
        }
        return `${sizing?.longLabel ?? "\u05D2\u05D3\u05D5\u05DC"} \u05DE\u05D3\u05D9: ${subject} ${be} ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const sizing = getSizing(issue2.origin);
        const subject = withDefinite(issue2.origin ?? "value");
        if (issue2.origin === "string") {
          return `${sizing?.shortLabel ?? "\u05E7\u05E6\u05E8"} \u05DE\u05D3\u05D9: ${subject} \u05E6\u05E8\u05D9\u05DB\u05D4 \u05DC\u05D4\u05DB\u05D9\u05DC ${issue2.minimum.toString()} ${sizing?.unit ?? ""} ${issue2.inclusive ? "\u05D0\u05D5 \u05D9\u05D5\u05EA\u05E8" : "\u05DC\u05E4\u05D7\u05D5\u05EA"}`.trim();
        }
        if (issue2.origin === "number") {
          const comparison = issue2.inclusive ? `\u05D2\u05D3\u05D5\u05DC \u05D0\u05D5 \u05E9\u05D5\u05D5\u05D4 \u05DC-${issue2.minimum}` : `\u05D2\u05D3\u05D5\u05DC \u05DE-${issue2.minimum}`;
          return `\u05E7\u05D8\u05DF \u05DE\u05D3\u05D9: ${subject} \u05E6\u05E8\u05D9\u05DA \u05DC\u05D4\u05D9\u05D5\u05EA ${comparison}`;
        }
        if (issue2.origin === "array" || issue2.origin === "set") {
          const verb = issue2.origin === "set" ? "\u05E6\u05E8\u05D9\u05DB\u05D4" : "\u05E6\u05E8\u05D9\u05DA";
          if (issue2.minimum === 1 && issue2.inclusive) {
            const singularPhrase = issue2.origin === "set" ? "\u05DC\u05E4\u05D7\u05D5\u05EA \u05E4\u05E8\u05D9\u05D8 \u05D0\u05D7\u05D3" : "\u05DC\u05E4\u05D7\u05D5\u05EA \u05E4\u05E8\u05D9\u05D8 \u05D0\u05D7\u05D3";
            return `\u05E7\u05D8\u05DF \u05DE\u05D3\u05D9: ${subject} ${verb} \u05DC\u05D4\u05DB\u05D9\u05DC ${singularPhrase}`;
          }
          const comparison = issue2.inclusive ? `${issue2.minimum} ${sizing?.unit ?? ""} \u05D0\u05D5 \u05D9\u05D5\u05EA\u05E8` : `\u05D9\u05D5\u05EA\u05E8 \u05DE-${issue2.minimum} ${sizing?.unit ?? ""}`;
          return `\u05E7\u05D8\u05DF \u05DE\u05D3\u05D9: ${subject} ${verb} \u05DC\u05D4\u05DB\u05D9\u05DC ${comparison}`.trim();
        }
        const adj = issue2.inclusive ? ">=" : ">";
        const be = verbFor(issue2.origin ?? "value");
        if (sizing?.unit) {
          return `${sizing.shortLabel} \u05DE\u05D3\u05D9: ${subject} ${be} ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `${sizing?.shortLabel ?? "\u05E7\u05D8\u05DF"} \u05DE\u05D3\u05D9: ${subject} ${be} ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `\u05D4\u05DE\u05D7\u05E8\u05D5\u05D6\u05EA \u05D7\u05D9\u05D9\u05D1\u05EA \u05DC\u05D4\u05EA\u05D7\u05D9\u05DC \u05D1 "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `\u05D4\u05DE\u05D7\u05E8\u05D5\u05D6\u05EA \u05D7\u05D9\u05D9\u05D1\u05EA \u05DC\u05D4\u05E1\u05EA\u05D9\u05D9\u05DD \u05D1 "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `\u05D4\u05DE\u05D7\u05E8\u05D5\u05D6\u05EA \u05D7\u05D9\u05D9\u05D1\u05EA \u05DC\u05DB\u05DC\u05D5\u05DC "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `\u05D4\u05DE\u05D7\u05E8\u05D5\u05D6\u05EA \u05D7\u05D9\u05D9\u05D1\u05EA \u05DC\u05D4\u05EA\u05D0\u05D9\u05DD \u05DC\u05EA\u05D1\u05E0\u05D9\u05EA ${_issue.pattern}`;
        const nounEntry = FormatDictionary[_issue.format];
        const noun = nounEntry?.label ?? _issue.format;
        const gender = nounEntry?.gender ?? "m";
        const adjective = gender === "f" ? "\u05EA\u05E7\u05D9\u05E0\u05D4" : "\u05EA\u05E7\u05D9\u05DF";
        return `${noun} \u05DC\u05D0 ${adjective}`;
      }
      case "not_multiple_of":
        return `\u05DE\u05E1\u05E4\u05E8 \u05DC\u05D0 \u05EA\u05E7\u05D9\u05DF: \u05D7\u05D9\u05D9\u05D1 \u05DC\u05D4\u05D9\u05D5\u05EA \u05DE\u05DB\u05E4\u05DC\u05D4 \u05E9\u05DC ${issue2.divisor}`;
      case "unrecognized_keys":
        return `\u05DE\u05E4\u05EA\u05D7${issue2.keys.length > 1 ? "\u05D5\u05EA" : ""} \u05DC\u05D0 \u05DE\u05D6\u05D5\u05D4${issue2.keys.length > 1 ? "\u05D9\u05DD" : "\u05D4"}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key": {
        return `\u05E9\u05D3\u05D4 \u05DC\u05D0 \u05EA\u05E7\u05D9\u05DF \u05D1\u05D0\u05D5\u05D1\u05D9\u05D9\u05E7\u05D8`;
      }
      case "invalid_union":
        return "\u05E7\u05DC\u05D8 \u05DC\u05D0 \u05EA\u05E7\u05D9\u05DF";
      case "invalid_element": {
        const place = withDefinite(issue2.origin ?? "array");
        return `\u05E2\u05E8\u05DA \u05DC\u05D0 \u05EA\u05E7\u05D9\u05DF \u05D1${place}`;
      }
      default:
        return `\u05E7\u05DC\u05D8 \u05DC\u05D0 \u05EA\u05E7\u05D9\u05DF`;
    }
  };
};
function he_default() {
  return {
    localeError: error16()
  };
}

// node_modules/zod/v4/locales/hu.js
var error17 = () => {
  const Sizable = {
    string: { unit: "karakter", verb: "legyen" },
    file: { unit: "byte", verb: "legyen" },
    array: { unit: "elem", verb: "legyen" },
    set: { unit: "elem", verb: "legyen" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const FormatDictionary = {
    regex: "bemenet",
    email: "email c\xEDm",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO id\u0151b\xE9lyeg",
    date: "ISO d\xE1tum",
    time: "ISO id\u0151",
    duration: "ISO id\u0151intervallum",
    ipv4: "IPv4 c\xEDm",
    ipv6: "IPv6 c\xEDm",
    cidrv4: "IPv4 tartom\xE1ny",
    cidrv6: "IPv6 tartom\xE1ny",
    base64: "base64-k\xF3dolt string",
    base64url: "base64url-k\xF3dolt string",
    json_string: "JSON string",
    e164: "E.164 sz\xE1m",
    jwt: "JWT",
    template_literal: "bemenet"
  };
  const TypeDictionary = {
    nan: "NaN",
    number: "sz\xE1m",
    array: "t\xF6mb"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type": {
        const expected = TypeDictionary[issue2.expected] ?? issue2.expected;
        const receivedType = parsedType(issue2.input);
        const received = TypeDictionary[receivedType] ?? receivedType;
        if (/^[A-Z]/.test(issue2.expected)) {
          return `\xC9rv\xE9nytelen bemenet: a v\xE1rt \xE9rt\xE9k instanceof ${issue2.expected}, a kapott \xE9rt\xE9k ${received}`;
        }
        return `\xC9rv\xE9nytelen bemenet: a v\xE1rt \xE9rt\xE9k ${expected}, a kapott \xE9rt\xE9k ${received}`;
      }
      case "invalid_value":
        if (issue2.values.length === 1)
          return `\xC9rv\xE9nytelen bemenet: a v\xE1rt \xE9rt\xE9k ${stringifyPrimitive(issue2.values[0])}`;
        return `\xC9rv\xE9nytelen opci\xF3: valamelyik \xE9rt\xE9k v\xE1rt ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `T\xFAl nagy: ${issue2.origin ?? "\xE9rt\xE9k"} m\xE9rete t\xFAl nagy ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "elem"}`;
        return `T\xFAl nagy: a bemeneti \xE9rt\xE9k ${issue2.origin ?? "\xE9rt\xE9k"} t\xFAl nagy: ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `T\xFAl kicsi: a bemeneti \xE9rt\xE9k ${issue2.origin} m\xE9rete t\xFAl kicsi ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `T\xFAl kicsi: a bemeneti \xE9rt\xE9k ${issue2.origin} t\xFAl kicsi ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `\xC9rv\xE9nytelen string: "${_issue.prefix}" \xE9rt\xE9kkel kell kezd\u0151dnie`;
        if (_issue.format === "ends_with")
          return `\xC9rv\xE9nytelen string: "${_issue.suffix}" \xE9rt\xE9kkel kell v\xE9gz\u0151dnie`;
        if (_issue.format === "includes")
          return `\xC9rv\xE9nytelen string: "${_issue.includes}" \xE9rt\xE9ket kell tartalmaznia`;
        if (_issue.format === "regex")
          return `\xC9rv\xE9nytelen string: ${_issue.pattern} mint\xE1nak kell megfelelnie`;
        return `\xC9rv\xE9nytelen ${FormatDictionary[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `\xC9rv\xE9nytelen sz\xE1m: ${issue2.divisor} t\xF6bbsz\xF6r\xF6s\xE9nek kell lennie`;
      case "unrecognized_keys":
        return `Ismeretlen kulcs${issue2.keys.length > 1 ? "s" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `\xC9rv\xE9nytelen kulcs ${issue2.origin}`;
      case "invalid_union":
        return "\xC9rv\xE9nytelen bemenet";
      case "invalid_element":
        return `\xC9rv\xE9nytelen \xE9rt\xE9k: ${issue2.origin}`;
      default:
        return `\xC9rv\xE9nytelen bemenet`;
    }
  };
};
function hu_default() {
  return {
    localeError: error17()
  };
}

// node_modules/zod/v4/locales/hy.js
function getArmenianPlural(count, one, many) {
  return Math.abs(count) === 1 ? one : many;
}
function withDefiniteArticle(word) {
  if (!word)
    return "";
  const vowels = ["\u0561", "\u0565", "\u0568", "\u056B", "\u0578", "\u0578\u0582", "\u0585"];
  const lastChar = word[word.length - 1];
  return word + (vowels.includes(lastChar) ? "\u0576" : "\u0568");
}
var error18 = () => {
  const Sizable = {
    string: {
      unit: {
        one: "\u0576\u0577\u0561\u0576",
        many: "\u0576\u0577\u0561\u0576\u0576\u0565\u0580"
      },
      verb: "\u0578\u0582\u0576\u0565\u0576\u0561\u056C"
    },
    file: {
      unit: {
        one: "\u0562\u0561\u0575\u0569",
        many: "\u0562\u0561\u0575\u0569\u0565\u0580"
      },
      verb: "\u0578\u0582\u0576\u0565\u0576\u0561\u056C"
    },
    array: {
      unit: {
        one: "\u057F\u0561\u0580\u0580",
        many: "\u057F\u0561\u0580\u0580\u0565\u0580"
      },
      verb: "\u0578\u0582\u0576\u0565\u0576\u0561\u056C"
    },
    set: {
      unit: {
        one: "\u057F\u0561\u0580\u0580",
        many: "\u057F\u0561\u0580\u0580\u0565\u0580"
      },
      verb: "\u0578\u0582\u0576\u0565\u0576\u0561\u056C"
    }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const FormatDictionary = {
    regex: "\u0574\u0578\u0582\u057F\u0584",
    email: "\u0567\u056C. \u0570\u0561\u057D\u0581\u0565",
    url: "URL",
    emoji: "\u0567\u0574\u0578\u057B\u056B",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO \u0561\u0574\u057D\u0561\u0569\u056B\u057E \u0587 \u056A\u0561\u0574",
    date: "ISO \u0561\u0574\u057D\u0561\u0569\u056B\u057E",
    time: "ISO \u056A\u0561\u0574",
    duration: "ISO \u057F\u0587\u0578\u0572\u0578\u0582\u0569\u0575\u0578\u0582\u0576",
    ipv4: "IPv4 \u0570\u0561\u057D\u0581\u0565",
    ipv6: "IPv6 \u0570\u0561\u057D\u0581\u0565",
    cidrv4: "IPv4 \u0574\u056B\u057B\u0561\u056F\u0561\u0575\u0584",
    cidrv6: "IPv6 \u0574\u056B\u057B\u0561\u056F\u0561\u0575\u0584",
    base64: "base64 \u0571\u0587\u0561\u0579\u0561\u0583\u0578\u057E \u057F\u0578\u0572",
    base64url: "base64url \u0571\u0587\u0561\u0579\u0561\u0583\u0578\u057E \u057F\u0578\u0572",
    json_string: "JSON \u057F\u0578\u0572",
    e164: "E.164 \u0570\u0561\u0574\u0561\u0580",
    jwt: "JWT",
    template_literal: "\u0574\u0578\u0582\u057F\u0584"
  };
  const TypeDictionary = {
    nan: "NaN",
    number: "\u0569\u056B\u057E",
    array: "\u0566\u0561\u0576\u0563\u057E\u0561\u056E"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type": {
        const expected = TypeDictionary[issue2.expected] ?? issue2.expected;
        const receivedType = parsedType(issue2.input);
        const received = TypeDictionary[receivedType] ?? receivedType;
        if (/^[A-Z]/.test(issue2.expected)) {
          return `\u054D\u056D\u0561\u056C \u0574\u0578\u0582\u057F\u0584\u0561\u0563\u0580\u0578\u0582\u0574\u2024 \u057D\u057A\u0561\u057D\u057E\u0578\u0582\u0574 \u0567\u0580 instanceof ${issue2.expected}, \u057D\u057F\u0561\u0581\u057E\u0565\u056C \u0567 ${received}`;
        }
        return `\u054D\u056D\u0561\u056C \u0574\u0578\u0582\u057F\u0584\u0561\u0563\u0580\u0578\u0582\u0574\u2024 \u057D\u057A\u0561\u057D\u057E\u0578\u0582\u0574 \u0567\u0580 ${expected}, \u057D\u057F\u0561\u0581\u057E\u0565\u056C \u0567 ${received}`;
      }
      case "invalid_value":
        if (issue2.values.length === 1)
          return `\u054D\u056D\u0561\u056C \u0574\u0578\u0582\u057F\u0584\u0561\u0563\u0580\u0578\u0582\u0574\u2024 \u057D\u057A\u0561\u057D\u057E\u0578\u0582\u0574 \u0567\u0580 ${stringifyPrimitive(issue2.values[1])}`;
        return `\u054D\u056D\u0561\u056C \u057F\u0561\u0580\u0562\u0565\u0580\u0561\u056F\u2024 \u057D\u057A\u0561\u057D\u057E\u0578\u0582\u0574 \u0567\u0580 \u0570\u0565\u057F\u0587\u0575\u0561\u056C\u0576\u0565\u0580\u056B\u0581 \u0574\u0565\u056F\u0568\u055D ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          const maxValue = Number(issue2.maximum);
          const unit = getArmenianPlural(maxValue, sizing.unit.one, sizing.unit.many);
          return `\u0549\u0561\u0583\u0561\u0566\u0561\u0576\u0581 \u0574\u0565\u056E \u0561\u0580\u056A\u0565\u0584\u2024 \u057D\u057A\u0561\u057D\u057E\u0578\u0582\u0574 \u0567, \u0578\u0580 ${withDefiniteArticle(issue2.origin ?? "\u0561\u0580\u056A\u0565\u0584")} \u056F\u0578\u0582\u0576\u0565\u0576\u0561 ${adj}${issue2.maximum.toString()} ${unit}`;
        }
        return `\u0549\u0561\u0583\u0561\u0566\u0561\u0576\u0581 \u0574\u0565\u056E \u0561\u0580\u056A\u0565\u0584\u2024 \u057D\u057A\u0561\u057D\u057E\u0578\u0582\u0574 \u0567, \u0578\u0580 ${withDefiniteArticle(issue2.origin ?? "\u0561\u0580\u056A\u0565\u0584")} \u056C\u056B\u0576\u056B ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          const minValue = Number(issue2.minimum);
          const unit = getArmenianPlural(minValue, sizing.unit.one, sizing.unit.many);
          return `\u0549\u0561\u0583\u0561\u0566\u0561\u0576\u0581 \u0583\u0578\u0584\u0580 \u0561\u0580\u056A\u0565\u0584\u2024 \u057D\u057A\u0561\u057D\u057E\u0578\u0582\u0574 \u0567, \u0578\u0580 ${withDefiniteArticle(issue2.origin)} \u056F\u0578\u0582\u0576\u0565\u0576\u0561 ${adj}${issue2.minimum.toString()} ${unit}`;
        }
        return `\u0549\u0561\u0583\u0561\u0566\u0561\u0576\u0581 \u0583\u0578\u0584\u0580 \u0561\u0580\u056A\u0565\u0584\u2024 \u057D\u057A\u0561\u057D\u057E\u0578\u0582\u0574 \u0567, \u0578\u0580 ${withDefiniteArticle(issue2.origin)} \u056C\u056B\u0576\u056B ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `\u054D\u056D\u0561\u056C \u057F\u0578\u0572\u2024 \u057A\u0565\u057F\u0584 \u0567 \u057D\u056F\u057D\u057E\u056B "${_issue.prefix}"-\u0578\u057E`;
        if (_issue.format === "ends_with")
          return `\u054D\u056D\u0561\u056C \u057F\u0578\u0572\u2024 \u057A\u0565\u057F\u0584 \u0567 \u0561\u057E\u0561\u0580\u057F\u057E\u056B "${_issue.suffix}"-\u0578\u057E`;
        if (_issue.format === "includes")
          return `\u054D\u056D\u0561\u056C \u057F\u0578\u0572\u2024 \u057A\u0565\u057F\u0584 \u0567 \u057A\u0561\u0580\u0578\u0582\u0576\u0561\u056F\u056B "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `\u054D\u056D\u0561\u056C \u057F\u0578\u0572\u2024 \u057A\u0565\u057F\u0584 \u0567 \u0570\u0561\u0574\u0561\u057A\u0561\u057F\u0561\u057D\u056D\u0561\u0576\u056B ${_issue.pattern} \u0571\u0587\u0561\u0579\u0561\u0583\u056B\u0576`;
        return `\u054D\u056D\u0561\u056C ${FormatDictionary[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `\u054D\u056D\u0561\u056C \u0569\u056B\u057E\u2024 \u057A\u0565\u057F\u0584 \u0567 \u0562\u0561\u0566\u0574\u0561\u057A\u0561\u057F\u056B\u056F \u056C\u056B\u0576\u056B ${issue2.divisor}-\u056B`;
      case "unrecognized_keys":
        return `\u0549\u0573\u0561\u0576\u0561\u0579\u057E\u0561\u056E \u0562\u0561\u0576\u0561\u056C\u056B${issue2.keys.length > 1 ? "\u0576\u0565\u0580" : ""}. ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `\u054D\u056D\u0561\u056C \u0562\u0561\u0576\u0561\u056C\u056B ${withDefiniteArticle(issue2.origin)}-\u0578\u0582\u0574`;
      case "invalid_union":
        return "\u054D\u056D\u0561\u056C \u0574\u0578\u0582\u057F\u0584\u0561\u0563\u0580\u0578\u0582\u0574";
      case "invalid_element":
        return `\u054D\u056D\u0561\u056C \u0561\u0580\u056A\u0565\u0584 ${withDefiniteArticle(issue2.origin)}-\u0578\u0582\u0574`;
      default:
        return `\u054D\u056D\u0561\u056C \u0574\u0578\u0582\u057F\u0584\u0561\u0563\u0580\u0578\u0582\u0574`;
    }
  };
};
function hy_default() {
  return {
    localeError: error18()
  };
}

// node_modules/zod/v4/locales/id.js
var error19 = () => {
  const Sizable = {
    string: { unit: "karakter", verb: "memiliki" },
    file: { unit: "byte", verb: "memiliki" },
    array: { unit: "item", verb: "memiliki" },
    set: { unit: "item", verb: "memiliki" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const FormatDictionary = {
    regex: "input",
    email: "alamat email",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "tanggal dan waktu format ISO",
    date: "tanggal format ISO",
    time: "jam format ISO",
    duration: "durasi format ISO",
    ipv4: "alamat IPv4",
    ipv6: "alamat IPv6",
    cidrv4: "rentang alamat IPv4",
    cidrv6: "rentang alamat IPv6",
    base64: "string dengan enkode base64",
    base64url: "string dengan enkode base64url",
    json_string: "string JSON",
    e164: "angka E.164",
    jwt: "JWT",
    template_literal: "input"
  };
  const TypeDictionary = {
    nan: "NaN"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type": {
        const expected = TypeDictionary[issue2.expected] ?? issue2.expected;
        const receivedType = parsedType(issue2.input);
        const received = TypeDictionary[receivedType] ?? receivedType;
        if (/^[A-Z]/.test(issue2.expected)) {
          return `Input tidak valid: diharapkan instanceof ${issue2.expected}, diterima ${received}`;
        }
        return `Input tidak valid: diharapkan ${expected}, diterima ${received}`;
      }
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Input tidak valid: diharapkan ${stringifyPrimitive(issue2.values[0])}`;
        return `Pilihan tidak valid: diharapkan salah satu dari ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Terlalu besar: diharapkan ${issue2.origin ?? "value"} memiliki ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "elemen"}`;
        return `Terlalu besar: diharapkan ${issue2.origin ?? "value"} menjadi ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Terlalu kecil: diharapkan ${issue2.origin} memiliki ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `Terlalu kecil: diharapkan ${issue2.origin} menjadi ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `String tidak valid: harus dimulai dengan "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `String tidak valid: harus berakhir dengan "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `String tidak valid: harus menyertakan "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `String tidak valid: harus sesuai pola ${_issue.pattern}`;
        return `${FormatDictionary[_issue.format] ?? issue2.format} tidak valid`;
      }
      case "not_multiple_of":
        return `Angka tidak valid: harus kelipatan dari ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Kunci tidak dikenali ${issue2.keys.length > 1 ? "s" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Kunci tidak valid di ${issue2.origin}`;
      case "invalid_union":
        return "Input tidak valid";
      case "invalid_element":
        return `Nilai tidak valid di ${issue2.origin}`;
      default:
        return `Input tidak valid`;
    }
  };
};
function id_default() {
  return {
    localeError: error19()
  };
}

// node_modules/zod/v4/locales/is.js
var error20 = () => {
  const Sizable = {
    string: { unit: "stafi", verb: "a\xF0 hafa" },
    file: { unit: "b\xE6ti", verb: "a\xF0 hafa" },
    array: { unit: "hluti", verb: "a\xF0 hafa" },
    set: { unit: "hluti", verb: "a\xF0 hafa" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const FormatDictionary = {
    regex: "gildi",
    email: "netfang",
    url: "vefsl\xF3\xF0",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO dagsetning og t\xEDmi",
    date: "ISO dagsetning",
    time: "ISO t\xEDmi",
    duration: "ISO t\xEDmalengd",
    ipv4: "IPv4 address",
    ipv6: "IPv6 address",
    cidrv4: "IPv4 range",
    cidrv6: "IPv6 range",
    base64: "base64-encoded strengur",
    base64url: "base64url-encoded strengur",
    json_string: "JSON strengur",
    e164: "E.164 t\xF6lugildi",
    jwt: "JWT",
    template_literal: "gildi"
  };
  const TypeDictionary = {
    nan: "NaN",
    number: "n\xFAmer",
    array: "fylki"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type": {
        const expected = TypeDictionary[issue2.expected] ?? issue2.expected;
        const receivedType = parsedType(issue2.input);
        const received = TypeDictionary[receivedType] ?? receivedType;
        if (/^[A-Z]/.test(issue2.expected)) {
          return `Rangt gildi: \xDE\xFA sl\xF3st inn ${received} \xFEar sem \xE1 a\xF0 vera instanceof ${issue2.expected}`;
        }
        return `Rangt gildi: \xDE\xFA sl\xF3st inn ${received} \xFEar sem \xE1 a\xF0 vera ${expected}`;
      }
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Rangt gildi: gert r\xE1\xF0 fyrir ${stringifyPrimitive(issue2.values[0])}`;
        return `\xD3gilt val: m\xE1 vera eitt af eftirfarandi ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Of st\xF3rt: gert er r\xE1\xF0 fyrir a\xF0 ${issue2.origin ?? "gildi"} hafi ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "hluti"}`;
        return `Of st\xF3rt: gert er r\xE1\xF0 fyrir a\xF0 ${issue2.origin ?? "gildi"} s\xE9 ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Of l\xEDti\xF0: gert er r\xE1\xF0 fyrir a\xF0 ${issue2.origin} hafi ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `Of l\xEDti\xF0: gert er r\xE1\xF0 fyrir a\xF0 ${issue2.origin} s\xE9 ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `\xD3gildur strengur: ver\xF0ur a\xF0 byrja \xE1 "${_issue.prefix}"`;
        }
        if (_issue.format === "ends_with")
          return `\xD3gildur strengur: ver\xF0ur a\xF0 enda \xE1 "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `\xD3gildur strengur: ver\xF0ur a\xF0 innihalda "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `\xD3gildur strengur: ver\xF0ur a\xF0 fylgja mynstri ${_issue.pattern}`;
        return `Rangt ${FormatDictionary[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `R\xF6ng tala: ver\xF0ur a\xF0 vera margfeldi af ${issue2.divisor}`;
      case "unrecognized_keys":
        return `\xD3\xFEekkt ${issue2.keys.length > 1 ? "ir lyklar" : "ur lykill"}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Rangur lykill \xED ${issue2.origin}`;
      case "invalid_union":
        return "Rangt gildi";
      case "invalid_element":
        return `Rangt gildi \xED ${issue2.origin}`;
      default:
        return `Rangt gildi`;
    }
  };
};
function is_default() {
  return {
    localeError: error20()
  };
}

// node_modules/zod/v4/locales/it.js
var error21 = () => {
  const Sizable = {
    string: { unit: "caratteri", verb: "avere" },
    file: { unit: "byte", verb: "avere" },
    array: { unit: "elementi", verb: "avere" },
    set: { unit: "elementi", verb: "avere" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const FormatDictionary = {
    regex: "input",
    email: "indirizzo email",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "data e ora ISO",
    date: "data ISO",
    time: "ora ISO",
    duration: "durata ISO",
    ipv4: "indirizzo IPv4",
    ipv6: "indirizzo IPv6",
    cidrv4: "intervallo IPv4",
    cidrv6: "intervallo IPv6",
    base64: "stringa codificata in base64",
    base64url: "URL codificata in base64",
    json_string: "stringa JSON",
    e164: "numero E.164",
    jwt: "JWT",
    template_literal: "input"
  };
  const TypeDictionary = {
    nan: "NaN",
    number: "numero",
    array: "vettore"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type": {
        const expected = TypeDictionary[issue2.expected] ?? issue2.expected;
        const receivedType = parsedType(issue2.input);
        const received = TypeDictionary[receivedType] ?? receivedType;
        if (/^[A-Z]/.test(issue2.expected)) {
          return `Input non valido: atteso instanceof ${issue2.expected}, ricevuto ${received}`;
        }
        return `Input non valido: atteso ${expected}, ricevuto ${received}`;
      }
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Input non valido: atteso ${stringifyPrimitive(issue2.values[0])}`;
        return `Opzione non valida: atteso uno tra ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Troppo grande: ${issue2.origin ?? "valore"} deve avere ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "elementi"}`;
        return `Troppo grande: ${issue2.origin ?? "valore"} deve essere ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Troppo piccolo: ${issue2.origin} deve avere ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `Troppo piccolo: ${issue2.origin} deve essere ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Stringa non valida: deve iniziare con "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Stringa non valida: deve terminare con "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Stringa non valida: deve includere "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Stringa non valida: deve corrispondere al pattern ${_issue.pattern}`;
        return `Invalid ${FormatDictionary[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Numero non valido: deve essere un multiplo di ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Chiav${issue2.keys.length > 1 ? "i" : "e"} non riconosciut${issue2.keys.length > 1 ? "e" : "a"}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Chiave non valida in ${issue2.origin}`;
      case "invalid_union":
        return "Input non valido";
      case "invalid_element":
        return `Valore non valido in ${issue2.origin}`;
      default:
        return `Input non valido`;
    }
  };
};
function it_default() {
  return {
    localeError: error21()
  };
}

// node_modules/zod/v4/locales/ja.js
var error22 = () => {
  const Sizable = {
    string: { unit: "\u6587\u5B57", verb: "\u3067\u3042\u308B" },
    file: { unit: "\u30D0\u30A4\u30C8", verb: "\u3067\u3042\u308B" },
    array: { unit: "\u8981\u7D20", verb: "\u3067\u3042\u308B" },
    set: { unit: "\u8981\u7D20", verb: "\u3067\u3042\u308B" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const FormatDictionary = {
    regex: "\u5165\u529B\u5024",
    email: "\u30E1\u30FC\u30EB\u30A2\u30C9\u30EC\u30B9",
    url: "URL",
    emoji: "\u7D75\u6587\u5B57",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO\u65E5\u6642",
    date: "ISO\u65E5\u4ED8",
    time: "ISO\u6642\u523B",
    duration: "ISO\u671F\u9593",
    ipv4: "IPv4\u30A2\u30C9\u30EC\u30B9",
    ipv6: "IPv6\u30A2\u30C9\u30EC\u30B9",
    cidrv4: "IPv4\u7BC4\u56F2",
    cidrv6: "IPv6\u7BC4\u56F2",
    base64: "base64\u30A8\u30F3\u30B3\u30FC\u30C9\u6587\u5B57\u5217",
    base64url: "base64url\u30A8\u30F3\u30B3\u30FC\u30C9\u6587\u5B57\u5217",
    json_string: "JSON\u6587\u5B57\u5217",
    e164: "E.164\u756A\u53F7",
    jwt: "JWT",
    template_literal: "\u5165\u529B\u5024"
  };
  const TypeDictionary = {
    nan: "NaN",
    number: "\u6570\u5024",
    array: "\u914D\u5217"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type": {
        const expected = TypeDictionary[issue2.expected] ?? issue2.expected;
        const receivedType = parsedType(issue2.input);
        const received = TypeDictionary[receivedType] ?? receivedType;
        if (/^[A-Z]/.test(issue2.expected)) {
          return `\u7121\u52B9\u306A\u5165\u529B: instanceof ${issue2.expected}\u304C\u671F\u5F85\u3055\u308C\u307E\u3057\u305F\u304C\u3001${received}\u304C\u5165\u529B\u3055\u308C\u307E\u3057\u305F`;
        }
        return `\u7121\u52B9\u306A\u5165\u529B: ${expected}\u304C\u671F\u5F85\u3055\u308C\u307E\u3057\u305F\u304C\u3001${received}\u304C\u5165\u529B\u3055\u308C\u307E\u3057\u305F`;
      }
      case "invalid_value":
        if (issue2.values.length === 1)
          return `\u7121\u52B9\u306A\u5165\u529B: ${stringifyPrimitive(issue2.values[0])}\u304C\u671F\u5F85\u3055\u308C\u307E\u3057\u305F`;
        return `\u7121\u52B9\u306A\u9078\u629E: ${joinValues(issue2.values, "\u3001")}\u306E\u3044\u305A\u308C\u304B\u3067\u3042\u308B\u5FC5\u8981\u304C\u3042\u308A\u307E\u3059`;
      case "too_big": {
        const adj = issue2.inclusive ? "\u4EE5\u4E0B\u3067\u3042\u308B" : "\u3088\u308A\u5C0F\u3055\u3044";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `\u5927\u304D\u3059\u304E\u308B\u5024: ${issue2.origin ?? "\u5024"}\u306F${issue2.maximum.toString()}${sizing.unit ?? "\u8981\u7D20"}${adj}\u5FC5\u8981\u304C\u3042\u308A\u307E\u3059`;
        return `\u5927\u304D\u3059\u304E\u308B\u5024: ${issue2.origin ?? "\u5024"}\u306F${issue2.maximum.toString()}${adj}\u5FC5\u8981\u304C\u3042\u308A\u307E\u3059`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? "\u4EE5\u4E0A\u3067\u3042\u308B" : "\u3088\u308A\u5927\u304D\u3044";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `\u5C0F\u3055\u3059\u304E\u308B\u5024: ${issue2.origin}\u306F${issue2.minimum.toString()}${sizing.unit}${adj}\u5FC5\u8981\u304C\u3042\u308A\u307E\u3059`;
        return `\u5C0F\u3055\u3059\u304E\u308B\u5024: ${issue2.origin}\u306F${issue2.minimum.toString()}${adj}\u5FC5\u8981\u304C\u3042\u308A\u307E\u3059`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `\u7121\u52B9\u306A\u6587\u5B57\u5217: "${_issue.prefix}"\u3067\u59CB\u307E\u308B\u5FC5\u8981\u304C\u3042\u308A\u307E\u3059`;
        if (_issue.format === "ends_with")
          return `\u7121\u52B9\u306A\u6587\u5B57\u5217: "${_issue.suffix}"\u3067\u7D42\u308F\u308B\u5FC5\u8981\u304C\u3042\u308A\u307E\u3059`;
        if (_issue.format === "includes")
          return `\u7121\u52B9\u306A\u6587\u5B57\u5217: "${_issue.includes}"\u3092\u542B\u3080\u5FC5\u8981\u304C\u3042\u308A\u307E\u3059`;
        if (_issue.format === "regex")
          return `\u7121\u52B9\u306A\u6587\u5B57\u5217: \u30D1\u30BF\u30FC\u30F3${_issue.pattern}\u306B\u4E00\u81F4\u3059\u308B\u5FC5\u8981\u304C\u3042\u308A\u307E\u3059`;
        return `\u7121\u52B9\u306A${FormatDictionary[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `\u7121\u52B9\u306A\u6570\u5024: ${issue2.divisor}\u306E\u500D\u6570\u3067\u3042\u308B\u5FC5\u8981\u304C\u3042\u308A\u307E\u3059`;
      case "unrecognized_keys":
        return `\u8A8D\u8B58\u3055\u308C\u3066\u3044\u306A\u3044\u30AD\u30FC${issue2.keys.length > 1 ? "\u7FA4" : ""}: ${joinValues(issue2.keys, "\u3001")}`;
      case "invalid_key":
        return `${issue2.origin}\u5185\u306E\u7121\u52B9\u306A\u30AD\u30FC`;
      case "invalid_union":
        return "\u7121\u52B9\u306A\u5165\u529B";
      case "invalid_element":
        return `${issue2.origin}\u5185\u306E\u7121\u52B9\u306A\u5024`;
      default:
        return `\u7121\u52B9\u306A\u5165\u529B`;
    }
  };
};
function ja_default() {
  return {
    localeError: error22()
  };
}

// node_modules/zod/v4/locales/ka.js
var error23 = () => {
  const Sizable = {
    string: { unit: "\u10E1\u10D8\u10DB\u10D1\u10DD\u10DA\u10DD", verb: "\u10E3\u10DC\u10D3\u10D0 \u10E8\u10D4\u10D8\u10EA\u10D0\u10D5\u10D3\u10D4\u10E1" },
    file: { unit: "\u10D1\u10D0\u10D8\u10E2\u10D8", verb: "\u10E3\u10DC\u10D3\u10D0 \u10E8\u10D4\u10D8\u10EA\u10D0\u10D5\u10D3\u10D4\u10E1" },
    array: { unit: "\u10D4\u10DA\u10D4\u10DB\u10D4\u10DC\u10E2\u10D8", verb: "\u10E3\u10DC\u10D3\u10D0 \u10E8\u10D4\u10D8\u10EA\u10D0\u10D5\u10D3\u10D4\u10E1" },
    set: { unit: "\u10D4\u10DA\u10D4\u10DB\u10D4\u10DC\u10E2\u10D8", verb: "\u10E3\u10DC\u10D3\u10D0 \u10E8\u10D4\u10D8\u10EA\u10D0\u10D5\u10D3\u10D4\u10E1" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const FormatDictionary = {
    regex: "\u10E8\u10D4\u10E7\u10D5\u10D0\u10DC\u10D0",
    email: "\u10D4\u10DA-\u10E4\u10DD\u10E1\u10E2\u10D8\u10E1 \u10DB\u10D8\u10E1\u10D0\u10DB\u10D0\u10E0\u10D7\u10D8",
    url: "URL",
    emoji: "\u10D4\u10DB\u10DD\u10EF\u10D8",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "\u10D7\u10D0\u10E0\u10D8\u10E6\u10D8-\u10D3\u10E0\u10DD",
    date: "\u10D7\u10D0\u10E0\u10D8\u10E6\u10D8",
    time: "\u10D3\u10E0\u10DD",
    duration: "\u10EE\u10D0\u10DC\u10D2\u10E0\u10EB\u10DA\u10D8\u10D5\u10DD\u10D1\u10D0",
    ipv4: "IPv4 \u10DB\u10D8\u10E1\u10D0\u10DB\u10D0\u10E0\u10D7\u10D8",
    ipv6: "IPv6 \u10DB\u10D8\u10E1\u10D0\u10DB\u10D0\u10E0\u10D7\u10D8",
    cidrv4: "IPv4 \u10D3\u10D8\u10D0\u10DE\u10D0\u10D6\u10DD\u10DC\u10D8",
    cidrv6: "IPv6 \u10D3\u10D8\u10D0\u10DE\u10D0\u10D6\u10DD\u10DC\u10D8",
    base64: "base64-\u10D9\u10DD\u10D3\u10D8\u10E0\u10D4\u10D1\u10E3\u10DA\u10D8 \u10E1\u10E2\u10E0\u10D8\u10DC\u10D2\u10D8",
    base64url: "base64url-\u10D9\u10DD\u10D3\u10D8\u10E0\u10D4\u10D1\u10E3\u10DA\u10D8 \u10E1\u10E2\u10E0\u10D8\u10DC\u10D2\u10D8",
    json_string: "JSON \u10E1\u10E2\u10E0\u10D8\u10DC\u10D2\u10D8",
    e164: "E.164 \u10DC\u10DD\u10DB\u10D4\u10E0\u10D8",
    jwt: "JWT",
    template_literal: "\u10E8\u10D4\u10E7\u10D5\u10D0\u10DC\u10D0"
  };
  const TypeDictionary = {
    nan: "NaN",
    number: "\u10E0\u10D8\u10EA\u10EE\u10D5\u10D8",
    string: "\u10E1\u10E2\u10E0\u10D8\u10DC\u10D2\u10D8",
    boolean: "\u10D1\u10E3\u10DA\u10D4\u10D0\u10DC\u10D8",
    function: "\u10E4\u10E3\u10DC\u10E5\u10EA\u10D8\u10D0",
    array: "\u10DB\u10D0\u10E1\u10D8\u10D5\u10D8"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type": {
        const expected = TypeDictionary[issue2.expected] ?? issue2.expected;
        const receivedType = parsedType(issue2.input);
        const received = TypeDictionary[receivedType] ?? receivedType;
        if (/^[A-Z]/.test(issue2.expected)) {
          return `\u10D0\u10E0\u10D0\u10E1\u10EC\u10DD\u10E0\u10D8 \u10E8\u10D4\u10E7\u10D5\u10D0\u10DC\u10D0: \u10DB\u10DD\u10E1\u10D0\u10DA\u10DD\u10D3\u10DC\u10D4\u10DA\u10D8 instanceof ${issue2.expected}, \u10DB\u10D8\u10E6\u10D4\u10D1\u10E3\u10DA\u10D8 ${received}`;
        }
        return `\u10D0\u10E0\u10D0\u10E1\u10EC\u10DD\u10E0\u10D8 \u10E8\u10D4\u10E7\u10D5\u10D0\u10DC\u10D0: \u10DB\u10DD\u10E1\u10D0\u10DA\u10DD\u10D3\u10DC\u10D4\u10DA\u10D8 ${expected}, \u10DB\u10D8\u10E6\u10D4\u10D1\u10E3\u10DA\u10D8 ${received}`;
      }
      case "invalid_value":
        if (issue2.values.length === 1)
          return `\u10D0\u10E0\u10D0\u10E1\u10EC\u10DD\u10E0\u10D8 \u10E8\u10D4\u10E7\u10D5\u10D0\u10DC\u10D0: \u10DB\u10DD\u10E1\u10D0\u10DA\u10DD\u10D3\u10DC\u10D4\u10DA\u10D8 ${stringifyPrimitive(issue2.values[0])}`;
        return `\u10D0\u10E0\u10D0\u10E1\u10EC\u10DD\u10E0\u10D8 \u10D5\u10D0\u10E0\u10D8\u10D0\u10DC\u10E2\u10D8: \u10DB\u10DD\u10E1\u10D0\u10DA\u10DD\u10D3\u10DC\u10D4\u10DA\u10D8\u10D0 \u10D4\u10E0\u10D7-\u10D4\u10E0\u10D7\u10D8 ${joinValues(issue2.values, "|")}-\u10D3\u10D0\u10DC`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `\u10D6\u10D4\u10D3\u10DB\u10D4\u10E2\u10D0\u10D3 \u10D3\u10D8\u10D3\u10D8: \u10DB\u10DD\u10E1\u10D0\u10DA\u10DD\u10D3\u10DC\u10D4\u10DA\u10D8 ${issue2.origin ?? "\u10DB\u10DC\u10D8\u10E8\u10D5\u10DC\u10D4\u10DA\u10DD\u10D1\u10D0"} ${sizing.verb} ${adj}${issue2.maximum.toString()} ${sizing.unit}`;
        return `\u10D6\u10D4\u10D3\u10DB\u10D4\u10E2\u10D0\u10D3 \u10D3\u10D8\u10D3\u10D8: \u10DB\u10DD\u10E1\u10D0\u10DA\u10DD\u10D3\u10DC\u10D4\u10DA\u10D8 ${issue2.origin ?? "\u10DB\u10DC\u10D8\u10E8\u10D5\u10DC\u10D4\u10DA\u10DD\u10D1\u10D0"} \u10D8\u10E7\u10DD\u10E1 ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `\u10D6\u10D4\u10D3\u10DB\u10D4\u10E2\u10D0\u10D3 \u10DE\u10D0\u10E2\u10D0\u10E0\u10D0: \u10DB\u10DD\u10E1\u10D0\u10DA\u10DD\u10D3\u10DC\u10D4\u10DA\u10D8 ${issue2.origin} ${sizing.verb} ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `\u10D6\u10D4\u10D3\u10DB\u10D4\u10E2\u10D0\u10D3 \u10DE\u10D0\u10E2\u10D0\u10E0\u10D0: \u10DB\u10DD\u10E1\u10D0\u10DA\u10DD\u10D3\u10DC\u10D4\u10DA\u10D8 ${issue2.origin} \u10D8\u10E7\u10DD\u10E1 ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `\u10D0\u10E0\u10D0\u10E1\u10EC\u10DD\u10E0\u10D8 \u10E1\u10E2\u10E0\u10D8\u10DC\u10D2\u10D8: \u10E3\u10DC\u10D3\u10D0 \u10D8\u10EC\u10E7\u10D4\u10D1\u10DD\u10D3\u10D4\u10E1 "${_issue.prefix}"-\u10D8\u10D7`;
        }
        if (_issue.format === "ends_with")
          return `\u10D0\u10E0\u10D0\u10E1\u10EC\u10DD\u10E0\u10D8 \u10E1\u10E2\u10E0\u10D8\u10DC\u10D2\u10D8: \u10E3\u10DC\u10D3\u10D0 \u10DB\u10D7\u10D0\u10D5\u10E0\u10D3\u10D4\u10D1\u10DD\u10D3\u10D4\u10E1 "${_issue.suffix}"-\u10D8\u10D7`;
        if (_issue.format === "includes")
          return `\u10D0\u10E0\u10D0\u10E1\u10EC\u10DD\u10E0\u10D8 \u10E1\u10E2\u10E0\u10D8\u10DC\u10D2\u10D8: \u10E3\u10DC\u10D3\u10D0 \u10E8\u10D4\u10D8\u10EA\u10D0\u10D5\u10D3\u10D4\u10E1 "${_issue.includes}"-\u10E1`;
        if (_issue.format === "regex")
          return `\u10D0\u10E0\u10D0\u10E1\u10EC\u10DD\u10E0\u10D8 \u10E1\u10E2\u10E0\u10D8\u10DC\u10D2\u10D8: \u10E3\u10DC\u10D3\u10D0 \u10E8\u10D4\u10D4\u10E1\u10D0\u10D1\u10D0\u10DB\u10D4\u10D1\u10DD\u10D3\u10D4\u10E1 \u10E8\u10D0\u10D1\u10DA\u10DD\u10DC\u10E1 ${_issue.pattern}`;
        return `\u10D0\u10E0\u10D0\u10E1\u10EC\u10DD\u10E0\u10D8 ${FormatDictionary[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `\u10D0\u10E0\u10D0\u10E1\u10EC\u10DD\u10E0\u10D8 \u10E0\u10D8\u10EA\u10EE\u10D5\u10D8: \u10E3\u10DC\u10D3\u10D0 \u10D8\u10E7\u10DD\u10E1 ${issue2.divisor}-\u10D8\u10E1 \u10EF\u10D4\u10E0\u10D0\u10D3\u10D8`;
      case "unrecognized_keys":
        return `\u10E3\u10EA\u10DC\u10DD\u10D1\u10D8 \u10D2\u10D0\u10E1\u10D0\u10E6\u10D4\u10D1${issue2.keys.length > 1 ? "\u10D4\u10D1\u10D8" : "\u10D8"}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `\u10D0\u10E0\u10D0\u10E1\u10EC\u10DD\u10E0\u10D8 \u10D2\u10D0\u10E1\u10D0\u10E6\u10D4\u10D1\u10D8 ${issue2.origin}-\u10E8\u10D8`;
      case "invalid_union":
        return "\u10D0\u10E0\u10D0\u10E1\u10EC\u10DD\u10E0\u10D8 \u10E8\u10D4\u10E7\u10D5\u10D0\u10DC\u10D0";
      case "invalid_element":
        return `\u10D0\u10E0\u10D0\u10E1\u10EC\u10DD\u10E0\u10D8 \u10DB\u10DC\u10D8\u10E8\u10D5\u10DC\u10D4\u10DA\u10DD\u10D1\u10D0 ${issue2.origin}-\u10E8\u10D8`;
      default:
        return `\u10D0\u10E0\u10D0\u10E1\u10EC\u10DD\u10E0\u10D8 \u10E8\u10D4\u10E7\u10D5\u10D0\u10DC\u10D0`;
    }
  };
};
function ka_default() {
  return {
    localeError: error23()
  };
}

// node_modules/zod/v4/locales/km.js
var error24 = () => {
  const Sizable = {
    string: { unit: "\u178F\u17BD\u17A2\u1780\u17D2\u179F\u179A", verb: "\u1782\u17BD\u179A\u1798\u17B6\u1793" },
    file: { unit: "\u1794\u17C3", verb: "\u1782\u17BD\u179A\u1798\u17B6\u1793" },
    array: { unit: "\u1792\u17B6\u178F\u17BB", verb: "\u1782\u17BD\u179A\u1798\u17B6\u1793" },
    set: { unit: "\u1792\u17B6\u178F\u17BB", verb: "\u1782\u17BD\u179A\u1798\u17B6\u1793" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const FormatDictionary = {
    regex: "\u1791\u17B7\u1793\u17D2\u1793\u1793\u17D0\u1799\u1794\u1789\u17D2\u1785\u17BC\u179B",
    email: "\u17A2\u17B6\u179F\u1799\u178A\u17D2\u178B\u17B6\u1793\u17A2\u17CA\u17B8\u1798\u17C2\u179B",
    url: "URL",
    emoji: "\u179F\u1789\u17D2\u1789\u17B6\u17A2\u17B6\u179A\u1798\u17D2\u1798\u178E\u17CD",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "\u1780\u17B6\u179B\u1794\u179A\u17B7\u1785\u17D2\u1786\u17C1\u1791 \u1793\u17B7\u1784\u1798\u17C9\u17C4\u1784 ISO",
    date: "\u1780\u17B6\u179B\u1794\u179A\u17B7\u1785\u17D2\u1786\u17C1\u1791 ISO",
    time: "\u1798\u17C9\u17C4\u1784 ISO",
    duration: "\u179A\u1799\u17C8\u1796\u17C1\u179B ISO",
    ipv4: "\u17A2\u17B6\u179F\u1799\u178A\u17D2\u178B\u17B6\u1793 IPv4",
    ipv6: "\u17A2\u17B6\u179F\u1799\u178A\u17D2\u178B\u17B6\u1793 IPv6",
    cidrv4: "\u178A\u17C2\u1793\u17A2\u17B6\u179F\u1799\u178A\u17D2\u178B\u17B6\u1793 IPv4",
    cidrv6: "\u178A\u17C2\u1793\u17A2\u17B6\u179F\u1799\u178A\u17D2\u178B\u17B6\u1793 IPv6",
    base64: "\u1781\u17D2\u179F\u17C2\u17A2\u1780\u17D2\u179F\u179A\u17A2\u17CA\u17B7\u1780\u17BC\u178A base64",
    base64url: "\u1781\u17D2\u179F\u17C2\u17A2\u1780\u17D2\u179F\u179A\u17A2\u17CA\u17B7\u1780\u17BC\u178A base64url",
    json_string: "\u1781\u17D2\u179F\u17C2\u17A2\u1780\u17D2\u179F\u179A JSON",
    e164: "\u179B\u17C1\u1781 E.164",
    jwt: "JWT",
    template_literal: "\u1791\u17B7\u1793\u17D2\u1793\u1793\u17D0\u1799\u1794\u1789\u17D2\u1785\u17BC\u179B"
  };
  const TypeDictionary = {
    nan: "NaN",
    number: "\u179B\u17C1\u1781",
    array: "\u17A2\u17B6\u179A\u17C1 (Array)",
    null: "\u1782\u17D2\u1798\u17B6\u1793\u178F\u1798\u17D2\u179B\u17C3 (null)"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type": {
        const expected = TypeDictionary[issue2.expected] ?? issue2.expected;
        const receivedType = parsedType(issue2.input);
        const received = TypeDictionary[receivedType] ?? receivedType;
        if (/^[A-Z]/.test(issue2.expected)) {
          return `\u1791\u17B7\u1793\u17D2\u1793\u1793\u17D0\u1799\u1794\u1789\u17D2\u1785\u17BC\u179B\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u1780\u17B6\u179A instanceof ${issue2.expected} \u1794\u17C9\u17BB\u1793\u17D2\u178F\u17C2\u1791\u1791\u17BD\u179B\u1794\u17B6\u1793 ${received}`;
        }
        return `\u1791\u17B7\u1793\u17D2\u1793\u1793\u17D0\u1799\u1794\u1789\u17D2\u1785\u17BC\u179B\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u1780\u17B6\u179A ${expected} \u1794\u17C9\u17BB\u1793\u17D2\u178F\u17C2\u1791\u1791\u17BD\u179B\u1794\u17B6\u1793 ${received}`;
      }
      case "invalid_value":
        if (issue2.values.length === 1)
          return `\u1791\u17B7\u1793\u17D2\u1793\u1793\u17D0\u1799\u1794\u1789\u17D2\u1785\u17BC\u179B\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u1780\u17B6\u179A ${stringifyPrimitive(issue2.values[0])}`;
        return `\u1787\u1798\u17D2\u179A\u17BE\u179F\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u1787\u17B6\u1798\u17BD\u1799\u1780\u17D2\u1793\u17BB\u1784\u1785\u17C6\u178E\u17C4\u1798 ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `\u1792\u17C6\u1796\u17C1\u1780\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u1780\u17B6\u179A ${issue2.origin ?? "\u178F\u1798\u17D2\u179B\u17C3"} ${adj} ${issue2.maximum.toString()} ${sizing.unit ?? "\u1792\u17B6\u178F\u17BB"}`;
        return `\u1792\u17C6\u1796\u17C1\u1780\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u1780\u17B6\u179A ${issue2.origin ?? "\u178F\u1798\u17D2\u179B\u17C3"} ${adj} ${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `\u178F\u17BC\u1785\u1796\u17C1\u1780\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u1780\u17B6\u179A ${issue2.origin} ${adj} ${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `\u178F\u17BC\u1785\u1796\u17C1\u1780\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u1780\u17B6\u179A ${issue2.origin} ${adj} ${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `\u1781\u17D2\u179F\u17C2\u17A2\u1780\u17D2\u179F\u179A\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u1785\u17B6\u1794\u17CB\u1795\u17D2\u178F\u17BE\u1798\u178A\u17C4\u1799 "${_issue.prefix}"`;
        }
        if (_issue.format === "ends_with")
          return `\u1781\u17D2\u179F\u17C2\u17A2\u1780\u17D2\u179F\u179A\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u1794\u1789\u17D2\u1785\u1794\u17CB\u178A\u17C4\u1799 "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `\u1781\u17D2\u179F\u17C2\u17A2\u1780\u17D2\u179F\u179A\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u1798\u17B6\u1793 "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `\u1781\u17D2\u179F\u17C2\u17A2\u1780\u17D2\u179F\u179A\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u178F\u17C2\u1795\u17D2\u1782\u17BC\u1795\u17D2\u1782\u1784\u1793\u17B9\u1784\u1791\u1798\u17D2\u179A\u1784\u17CB\u178A\u17C2\u179B\u1794\u17B6\u1793\u1780\u17C6\u178E\u178F\u17CB ${_issue.pattern}`;
        return `\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C\u17D6 ${FormatDictionary[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `\u179B\u17C1\u1781\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u178F\u17C2\u1787\u17B6\u1796\u17A0\u17BB\u1782\u17BB\u178E\u1793\u17C3 ${issue2.divisor}`;
      case "unrecognized_keys":
        return `\u179A\u1780\u1783\u17BE\u1789\u179F\u17C4\u1798\u17B7\u1793\u179F\u17D2\u1782\u17B6\u179B\u17CB\u17D6 ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `\u179F\u17C4\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C\u1793\u17C5\u1780\u17D2\u1793\u17BB\u1784 ${issue2.origin}`;
      case "invalid_union":
        return `\u1791\u17B7\u1793\u17D2\u1793\u1793\u17D0\u1799\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C`;
      case "invalid_element":
        return `\u1791\u17B7\u1793\u17D2\u1793\u1793\u17D0\u1799\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C\u1793\u17C5\u1780\u17D2\u1793\u17BB\u1784 ${issue2.origin}`;
      default:
        return `\u1791\u17B7\u1793\u17D2\u1793\u1793\u17D0\u1799\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C`;
    }
  };
};
function km_default() {
  return {
    localeError: error24()
  };
}

// node_modules/zod/v4/locales/kh.js
function kh_default() {
  return km_default();
}

// node_modules/zod/v4/locales/ko.js
var error25 = () => {
  const Sizable = {
    string: { unit: "\uBB38\uC790", verb: "to have" },
    file: { unit: "\uBC14\uC774\uD2B8", verb: "to have" },
    array: { unit: "\uAC1C", verb: "to have" },
    set: { unit: "\uAC1C", verb: "to have" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const FormatDictionary = {
    regex: "\uC785\uB825",
    email: "\uC774\uBA54\uC77C \uC8FC\uC18C",
    url: "URL",
    emoji: "\uC774\uBAA8\uC9C0",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO \uB0A0\uC9DC\uC2DC\uAC04",
    date: "ISO \uB0A0\uC9DC",
    time: "ISO \uC2DC\uAC04",
    duration: "ISO \uAE30\uAC04",
    ipv4: "IPv4 \uC8FC\uC18C",
    ipv6: "IPv6 \uC8FC\uC18C",
    cidrv4: "IPv4 \uBC94\uC704",
    cidrv6: "IPv6 \uBC94\uC704",
    base64: "base64 \uC778\uCF54\uB529 \uBB38\uC790\uC5F4",
    base64url: "base64url \uC778\uCF54\uB529 \uBB38\uC790\uC5F4",
    json_string: "JSON \uBB38\uC790\uC5F4",
    e164: "E.164 \uBC88\uD638",
    jwt: "JWT",
    template_literal: "\uC785\uB825"
  };
  const TypeDictionary = {
    nan: "NaN"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type": {
        const expected = TypeDictionary[issue2.expected] ?? issue2.expected;
        const receivedType = parsedType(issue2.input);
        const received = TypeDictionary[receivedType] ?? receivedType;
        if (/^[A-Z]/.test(issue2.expected)) {
          return `\uC798\uBABB\uB41C \uC785\uB825: \uC608\uC0C1 \uD0C0\uC785\uC740 instanceof ${issue2.expected}, \uBC1B\uC740 \uD0C0\uC785\uC740 ${received}\uC785\uB2C8\uB2E4`;
        }
        return `\uC798\uBABB\uB41C \uC785\uB825: \uC608\uC0C1 \uD0C0\uC785\uC740 ${expected}, \uBC1B\uC740 \uD0C0\uC785\uC740 ${received}\uC785\uB2C8\uB2E4`;
      }
      case "invalid_value":
        if (issue2.values.length === 1)
          return `\uC798\uBABB\uB41C \uC785\uB825: \uAC12\uC740 ${stringifyPrimitive(issue2.values[0])} \uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4`;
        return `\uC798\uBABB\uB41C \uC635\uC158: ${joinValues(issue2.values, "\uB610\uB294 ")} \uC911 \uD558\uB098\uC5EC\uC57C \uD569\uB2C8\uB2E4`;
      case "too_big": {
        const adj = issue2.inclusive ? "\uC774\uD558" : "\uBBF8\uB9CC";
        const suffix = adj === "\uBBF8\uB9CC" ? "\uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4" : "\uC5EC\uC57C \uD569\uB2C8\uB2E4";
        const sizing = getSizing(issue2.origin);
        const unit = sizing?.unit ?? "\uC694\uC18C";
        if (sizing)
          return `${issue2.origin ?? "\uAC12"}\uC774 \uB108\uBB34 \uD07D\uB2C8\uB2E4: ${issue2.maximum.toString()}${unit} ${adj}${suffix}`;
        return `${issue2.origin ?? "\uAC12"}\uC774 \uB108\uBB34 \uD07D\uB2C8\uB2E4: ${issue2.maximum.toString()} ${adj}${suffix}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? "\uC774\uC0C1" : "\uCD08\uACFC";
        const suffix = adj === "\uC774\uC0C1" ? "\uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4" : "\uC5EC\uC57C \uD569\uB2C8\uB2E4";
        const sizing = getSizing(issue2.origin);
        const unit = sizing?.unit ?? "\uC694\uC18C";
        if (sizing) {
          return `${issue2.origin ?? "\uAC12"}\uC774 \uB108\uBB34 \uC791\uC2B5\uB2C8\uB2E4: ${issue2.minimum.toString()}${unit} ${adj}${suffix}`;
        }
        return `${issue2.origin ?? "\uAC12"}\uC774 \uB108\uBB34 \uC791\uC2B5\uB2C8\uB2E4: ${issue2.minimum.toString()} ${adj}${suffix}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `\uC798\uBABB\uB41C \uBB38\uC790\uC5F4: "${_issue.prefix}"(\uC73C)\uB85C \uC2DC\uC791\uD574\uC57C \uD569\uB2C8\uB2E4`;
        }
        if (_issue.format === "ends_with")
          return `\uC798\uBABB\uB41C \uBB38\uC790\uC5F4: "${_issue.suffix}"(\uC73C)\uB85C \uB05D\uB098\uC57C \uD569\uB2C8\uB2E4`;
        if (_issue.format === "includes")
          return `\uC798\uBABB\uB41C \uBB38\uC790\uC5F4: "${_issue.includes}"\uC744(\uB97C) \uD3EC\uD568\uD574\uC57C \uD569\uB2C8\uB2E4`;
        if (_issue.format === "regex")
          return `\uC798\uBABB\uB41C \uBB38\uC790\uC5F4: \uC815\uADDC\uC2DD ${_issue.pattern} \uD328\uD134\uACFC \uC77C\uCE58\uD574\uC57C \uD569\uB2C8\uB2E4`;
        return `\uC798\uBABB\uB41C ${FormatDictionary[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `\uC798\uBABB\uB41C \uC22B\uC790: ${issue2.divisor}\uC758 \uBC30\uC218\uC5EC\uC57C \uD569\uB2C8\uB2E4`;
      case "unrecognized_keys":
        return `\uC778\uC2DD\uD560 \uC218 \uC5C6\uB294 \uD0A4: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `\uC798\uBABB\uB41C \uD0A4: ${issue2.origin}`;
      case "invalid_union":
        return `\uC798\uBABB\uB41C \uC785\uB825`;
      case "invalid_element":
        return `\uC798\uBABB\uB41C \uAC12: ${issue2.origin}`;
      default:
        return `\uC798\uBABB\uB41C \uC785\uB825`;
    }
  };
};
function ko_default() {
  return {
    localeError: error25()
  };
}

// node_modules/zod/v4/locales/lt.js
var capitalizeFirstCharacter = (text) => {
  return text.charAt(0).toUpperCase() + text.slice(1);
};
function getUnitTypeFromNumber(number4) {
  const abs = Math.abs(number4);
  const last = abs % 10;
  const last2 = abs % 100;
  if (last2 >= 11 && last2 <= 19 || last === 0)
    return "many";
  if (last === 1)
    return "one";
  return "few";
}
var error26 = () => {
  const Sizable = {
    string: {
      unit: {
        one: "simbolis",
        few: "simboliai",
        many: "simboli\u0173"
      },
      verb: {
        smaller: {
          inclusive: "turi b\u016Bti ne ilgesn\u0117 kaip",
          notInclusive: "turi b\u016Bti trumpesn\u0117 kaip"
        },
        bigger: {
          inclusive: "turi b\u016Bti ne trumpesn\u0117 kaip",
          notInclusive: "turi b\u016Bti ilgesn\u0117 kaip"
        }
      }
    },
    file: {
      unit: {
        one: "baitas",
        few: "baitai",
        many: "bait\u0173"
      },
      verb: {
        smaller: {
          inclusive: "turi b\u016Bti ne didesnis kaip",
          notInclusive: "turi b\u016Bti ma\u017Eesnis kaip"
        },
        bigger: {
          inclusive: "turi b\u016Bti ne ma\u017Eesnis kaip",
          notInclusive: "turi b\u016Bti didesnis kaip"
        }
      }
    },
    array: {
      unit: {
        one: "element\u0105",
        few: "elementus",
        many: "element\u0173"
      },
      verb: {
        smaller: {
          inclusive: "turi tur\u0117ti ne daugiau kaip",
          notInclusive: "turi tur\u0117ti ma\u017Eiau kaip"
        },
        bigger: {
          inclusive: "turi tur\u0117ti ne ma\u017Eiau kaip",
          notInclusive: "turi tur\u0117ti daugiau kaip"
        }
      }
    },
    set: {
      unit: {
        one: "element\u0105",
        few: "elementus",
        many: "element\u0173"
      },
      verb: {
        smaller: {
          inclusive: "turi tur\u0117ti ne daugiau kaip",
          notInclusive: "turi tur\u0117ti ma\u017Eiau kaip"
        },
        bigger: {
          inclusive: "turi tur\u0117ti ne ma\u017Eiau kaip",
          notInclusive: "turi tur\u0117ti daugiau kaip"
        }
      }
    }
  };
  function getSizing(origin, unitType, inclusive, targetShouldBe) {
    const result = Sizable[origin] ?? null;
    if (result === null)
      return result;
    return {
      unit: result.unit[unitType],
      verb: result.verb[targetShouldBe][inclusive ? "inclusive" : "notInclusive"]
    };
  }
  const FormatDictionary = {
    regex: "\u012Fvestis",
    email: "el. pa\u0161to adresas",
    url: "URL",
    emoji: "jaustukas",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO data ir laikas",
    date: "ISO data",
    time: "ISO laikas",
    duration: "ISO trukm\u0117",
    ipv4: "IPv4 adresas",
    ipv6: "IPv6 adresas",
    cidrv4: "IPv4 tinklo prefiksas (CIDR)",
    cidrv6: "IPv6 tinklo prefiksas (CIDR)",
    base64: "base64 u\u017Ekoduota eilut\u0117",
    base64url: "base64url u\u017Ekoduota eilut\u0117",
    json_string: "JSON eilut\u0117",
    e164: "E.164 numeris",
    jwt: "JWT",
    template_literal: "\u012Fvestis"
  };
  const TypeDictionary = {
    nan: "NaN",
    number: "skai\u010Dius",
    bigint: "sveikasis skai\u010Dius",
    string: "eilut\u0117",
    boolean: "login\u0117 reik\u0161m\u0117",
    undefined: "neapibr\u0117\u017Eta reik\u0161m\u0117",
    function: "funkcija",
    symbol: "simbolis",
    array: "masyvas",
    object: "objektas",
    null: "nulin\u0117 reik\u0161m\u0117"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type": {
        const expected = TypeDictionary[issue2.expected] ?? issue2.expected;
        const receivedType = parsedType(issue2.input);
        const received = TypeDictionary[receivedType] ?? receivedType;
        if (/^[A-Z]/.test(issue2.expected)) {
          return `Gautas tipas ${received}, o tik\u0117tasi - instanceof ${issue2.expected}`;
        }
        return `Gautas tipas ${received}, o tik\u0117tasi - ${expected}`;
      }
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Privalo b\u016Bti ${stringifyPrimitive(issue2.values[0])}`;
        return `Privalo b\u016Bti vienas i\u0161 ${joinValues(issue2.values, "|")} pasirinkim\u0173`;
      case "too_big": {
        const origin = TypeDictionary[issue2.origin] ?? issue2.origin;
        const sizing = getSizing(issue2.origin, getUnitTypeFromNumber(Number(issue2.maximum)), issue2.inclusive ?? false, "smaller");
        if (sizing?.verb)
          return `${capitalizeFirstCharacter(origin ?? issue2.origin ?? "reik\u0161m\u0117")} ${sizing.verb} ${issue2.maximum.toString()} ${sizing.unit ?? "element\u0173"}`;
        const adj = issue2.inclusive ? "ne didesnis kaip" : "ma\u017Eesnis kaip";
        return `${capitalizeFirstCharacter(origin ?? issue2.origin ?? "reik\u0161m\u0117")} turi b\u016Bti ${adj} ${issue2.maximum.toString()} ${sizing?.unit}`;
      }
      case "too_small": {
        const origin = TypeDictionary[issue2.origin] ?? issue2.origin;
        const sizing = getSizing(issue2.origin, getUnitTypeFromNumber(Number(issue2.minimum)), issue2.inclusive ?? false, "bigger");
        if (sizing?.verb)
          return `${capitalizeFirstCharacter(origin ?? issue2.origin ?? "reik\u0161m\u0117")} ${sizing.verb} ${issue2.minimum.toString()} ${sizing.unit ?? "element\u0173"}`;
        const adj = issue2.inclusive ? "ne ma\u017Eesnis kaip" : "didesnis kaip";
        return `${capitalizeFirstCharacter(origin ?? issue2.origin ?? "reik\u0161m\u0117")} turi b\u016Bti ${adj} ${issue2.minimum.toString()} ${sizing?.unit}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `Eilut\u0117 privalo prasid\u0117ti "${_issue.prefix}"`;
        }
        if (_issue.format === "ends_with")
          return `Eilut\u0117 privalo pasibaigti "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Eilut\u0117 privalo \u012Ftraukti "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Eilut\u0117 privalo atitikti ${_issue.pattern}`;
        return `Neteisingas ${FormatDictionary[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Skai\u010Dius privalo b\u016Bti ${issue2.divisor} kartotinis.`;
      case "unrecognized_keys":
        return `Neatpa\u017Eint${issue2.keys.length > 1 ? "i" : "as"} rakt${issue2.keys.length > 1 ? "ai" : "as"}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return "Rastas klaidingas raktas";
      case "invalid_union":
        return "Klaidinga \u012Fvestis";
      case "invalid_element": {
        const origin = TypeDictionary[issue2.origin] ?? issue2.origin;
        return `${capitalizeFirstCharacter(origin ?? issue2.origin ?? "reik\u0161m\u0117")} turi klaiding\u0105 \u012Fvest\u012F`;
      }
      default:
        return "Klaidinga \u012Fvestis";
    }
  };
};
function lt_default() {
  return {
    localeError: error26()
  };
}

// node_modules/zod/v4/locales/mk.js
var error27 = () => {
  const Sizable = {
    string: { unit: "\u0437\u043D\u0430\u0446\u0438", verb: "\u0434\u0430 \u0438\u043C\u0430\u0430\u0442" },
    file: { unit: "\u0431\u0430\u0458\u0442\u0438", verb: "\u0434\u0430 \u0438\u043C\u0430\u0430\u0442" },
    array: { unit: "\u0441\u0442\u0430\u0432\u043A\u0438", verb: "\u0434\u0430 \u0438\u043C\u0430\u0430\u0442" },
    set: { unit: "\u0441\u0442\u0430\u0432\u043A\u0438", verb: "\u0434\u0430 \u0438\u043C\u0430\u0430\u0442" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const FormatDictionary = {
    regex: "\u0432\u043D\u0435\u0441",
    email: "\u0430\u0434\u0440\u0435\u0441\u0430 \u043D\u0430 \u0435-\u043F\u043E\u0448\u0442\u0430",
    url: "URL",
    emoji: "\u0435\u043C\u043E\u045F\u0438",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO \u0434\u0430\u0442\u0443\u043C \u0438 \u0432\u0440\u0435\u043C\u0435",
    date: "ISO \u0434\u0430\u0442\u0443\u043C",
    time: "ISO \u0432\u0440\u0435\u043C\u0435",
    duration: "ISO \u0432\u0440\u0435\u043C\u0435\u0442\u0440\u0430\u0435\u045A\u0435",
    ipv4: "IPv4 \u0430\u0434\u0440\u0435\u0441\u0430",
    ipv6: "IPv6 \u0430\u0434\u0440\u0435\u0441\u0430",
    cidrv4: "IPv4 \u043E\u043F\u0441\u0435\u0433",
    cidrv6: "IPv6 \u043E\u043F\u0441\u0435\u0433",
    base64: "base64-\u0435\u043D\u043A\u043E\u0434\u0438\u0440\u0430\u043D\u0430 \u043D\u0438\u0437\u0430",
    base64url: "base64url-\u0435\u043D\u043A\u043E\u0434\u0438\u0440\u0430\u043D\u0430 \u043D\u0438\u0437\u0430",
    json_string: "JSON \u043D\u0438\u0437\u0430",
    e164: "E.164 \u0431\u0440\u043E\u0458",
    jwt: "JWT",
    template_literal: "\u0432\u043D\u0435\u0441"
  };
  const TypeDictionary = {
    nan: "NaN",
    number: "\u0431\u0440\u043E\u0458",
    array: "\u043D\u0438\u0437\u0430"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type": {
        const expected = TypeDictionary[issue2.expected] ?? issue2.expected;
        const receivedType = parsedType(issue2.input);
        const received = TypeDictionary[receivedType] ?? receivedType;
        if (/^[A-Z]/.test(issue2.expected)) {
          return `\u0413\u0440\u0435\u0448\u0435\u043D \u0432\u043D\u0435\u0441: \u0441\u0435 \u043E\u0447\u0435\u043A\u0443\u0432\u0430 instanceof ${issue2.expected}, \u043F\u0440\u0438\u043C\u0435\u043D\u043E ${received}`;
        }
        return `\u0413\u0440\u0435\u0448\u0435\u043D \u0432\u043D\u0435\u0441: \u0441\u0435 \u043E\u0447\u0435\u043A\u0443\u0432\u0430 ${expected}, \u043F\u0440\u0438\u043C\u0435\u043D\u043E ${received}`;
      }
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Invalid input: expected ${stringifyPrimitive(issue2.values[0])}`;
        return `\u0413\u0440\u0435\u0448\u0430\u043D\u0430 \u043E\u043F\u0446\u0438\u0458\u0430: \u0441\u0435 \u043E\u0447\u0435\u043A\u0443\u0432\u0430 \u0435\u0434\u043D\u0430 ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `\u041F\u0440\u0435\u043C\u043D\u043E\u0433\u0443 \u0433\u043E\u043B\u0435\u043C: \u0441\u0435 \u043E\u0447\u0435\u043A\u0443\u0432\u0430 ${issue2.origin ?? "\u0432\u0440\u0435\u0434\u043D\u043E\u0441\u0442\u0430"} \u0434\u0430 \u0438\u043C\u0430 ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "\u0435\u043B\u0435\u043C\u0435\u043D\u0442\u0438"}`;
        return `\u041F\u0440\u0435\u043C\u043D\u043E\u0433\u0443 \u0433\u043E\u043B\u0435\u043C: \u0441\u0435 \u043E\u0447\u0435\u043A\u0443\u0432\u0430 ${issue2.origin ?? "\u0432\u0440\u0435\u0434\u043D\u043E\u0441\u0442\u0430"} \u0434\u0430 \u0431\u0438\u0434\u0435 ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `\u041F\u0440\u0435\u043C\u043D\u043E\u0433\u0443 \u043C\u0430\u043B: \u0441\u0435 \u043E\u0447\u0435\u043A\u0443\u0432\u0430 ${issue2.origin} \u0434\u0430 \u0438\u043C\u0430 ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `\u041F\u0440\u0435\u043C\u043D\u043E\u0433\u0443 \u043C\u0430\u043B: \u0441\u0435 \u043E\u0447\u0435\u043A\u0443\u0432\u0430 ${issue2.origin} \u0434\u0430 \u0431\u0438\u0434\u0435 ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `\u041D\u0435\u0432\u0430\u0436\u0435\u0447\u043A\u0430 \u043D\u0438\u0437\u0430: \u043C\u043E\u0440\u0430 \u0434\u0430 \u0437\u0430\u043F\u043E\u0447\u043D\u0443\u0432\u0430 \u0441\u043E "${_issue.prefix}"`;
        }
        if (_issue.format === "ends_with")
          return `\u041D\u0435\u0432\u0430\u0436\u0435\u0447\u043A\u0430 \u043D\u0438\u0437\u0430: \u043C\u043E\u0440\u0430 \u0434\u0430 \u0437\u0430\u0432\u0440\u0448\u0443\u0432\u0430 \u0441\u043E "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `\u041D\u0435\u0432\u0430\u0436\u0435\u0447\u043A\u0430 \u043D\u0438\u0437\u0430: \u043C\u043E\u0440\u0430 \u0434\u0430 \u0432\u043A\u043B\u0443\u0447\u0443\u0432\u0430 "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `\u041D\u0435\u0432\u0430\u0436\u0435\u0447\u043A\u0430 \u043D\u0438\u0437\u0430: \u043C\u043E\u0440\u0430 \u0434\u0430 \u043E\u0434\u0433\u043E\u0430\u0440\u0430 \u043D\u0430 \u043F\u0430\u0442\u0435\u0440\u043D\u043E\u0442 ${_issue.pattern}`;
        return `Invalid ${FormatDictionary[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `\u0413\u0440\u0435\u0448\u0435\u043D \u0431\u0440\u043E\u0458: \u043C\u043E\u0440\u0430 \u0434\u0430 \u0431\u0438\u0434\u0435 \u0434\u0435\u043B\u0438\u0432 \u0441\u043E ${issue2.divisor}`;
      case "unrecognized_keys":
        return `${issue2.keys.length > 1 ? "\u041D\u0435\u043F\u0440\u0435\u043F\u043E\u0437\u043D\u0430\u0435\u043D\u0438 \u043A\u043B\u0443\u0447\u0435\u0432\u0438" : "\u041D\u0435\u043F\u0440\u0435\u043F\u043E\u0437\u043D\u0430\u0435\u043D \u043A\u043B\u0443\u0447"}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `\u0413\u0440\u0435\u0448\u0435\u043D \u043A\u043B\u0443\u0447 \u0432\u043E ${issue2.origin}`;
      case "invalid_union":
        return "\u0413\u0440\u0435\u0448\u0435\u043D \u0432\u043D\u0435\u0441";
      case "invalid_element":
        return `\u0413\u0440\u0435\u0448\u043D\u0430 \u0432\u0440\u0435\u0434\u043D\u043E\u0441\u0442 \u0432\u043E ${issue2.origin}`;
      default:
        return `\u0413\u0440\u0435\u0448\u0435\u043D \u0432\u043D\u0435\u0441`;
    }
  };
};
function mk_default() {
  return {
    localeError: error27()
  };
}

// node_modules/zod/v4/locales/ms.js
var error28 = () => {
  const Sizable = {
    string: { unit: "aksara", verb: "mempunyai" },
    file: { unit: "bait", verb: "mempunyai" },
    array: { unit: "elemen", verb: "mempunyai" },
    set: { unit: "elemen", verb: "mempunyai" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const FormatDictionary = {
    regex: "input",
    email: "alamat e-mel",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "tarikh masa ISO",
    date: "tarikh ISO",
    time: "masa ISO",
    duration: "tempoh ISO",
    ipv4: "alamat IPv4",
    ipv6: "alamat IPv6",
    cidrv4: "julat IPv4",
    cidrv6: "julat IPv6",
    base64: "string dikodkan base64",
    base64url: "string dikodkan base64url",
    json_string: "string JSON",
    e164: "nombor E.164",
    jwt: "JWT",
    template_literal: "input"
  };
  const TypeDictionary = {
    nan: "NaN",
    number: "nombor"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type": {
        const expected = TypeDictionary[issue2.expected] ?? issue2.expected;
        const receivedType = parsedType(issue2.input);
        const received = TypeDictionary[receivedType] ?? receivedType;
        if (/^[A-Z]/.test(issue2.expected)) {
          return `Input tidak sah: dijangka instanceof ${issue2.expected}, diterima ${received}`;
        }
        return `Input tidak sah: dijangka ${expected}, diterima ${received}`;
      }
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Input tidak sah: dijangka ${stringifyPrimitive(issue2.values[0])}`;
        return `Pilihan tidak sah: dijangka salah satu daripada ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Terlalu besar: dijangka ${issue2.origin ?? "nilai"} ${sizing.verb} ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "elemen"}`;
        return `Terlalu besar: dijangka ${issue2.origin ?? "nilai"} adalah ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Terlalu kecil: dijangka ${issue2.origin} ${sizing.verb} ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `Terlalu kecil: dijangka ${issue2.origin} adalah ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `String tidak sah: mesti bermula dengan "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `String tidak sah: mesti berakhir dengan "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `String tidak sah: mesti mengandungi "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `String tidak sah: mesti sepadan dengan corak ${_issue.pattern}`;
        return `${FormatDictionary[_issue.format] ?? issue2.format} tidak sah`;
      }
      case "not_multiple_of":
        return `Nombor tidak sah: perlu gandaan ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Kunci tidak dikenali: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Kunci tidak sah dalam ${issue2.origin}`;
      case "invalid_union":
        return "Input tidak sah";
      case "invalid_element":
        return `Nilai tidak sah dalam ${issue2.origin}`;
      default:
        return `Input tidak sah`;
    }
  };
};
function ms_default() {
  return {
    localeError: error28()
  };
}

// node_modules/zod/v4/locales/nl.js
var error29 = () => {
  const Sizable = {
    string: { unit: "tekens", verb: "heeft" },
    file: { unit: "bytes", verb: "heeft" },
    array: { unit: "elementen", verb: "heeft" },
    set: { unit: "elementen", verb: "heeft" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const FormatDictionary = {
    regex: "invoer",
    email: "emailadres",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO datum en tijd",
    date: "ISO datum",
    time: "ISO tijd",
    duration: "ISO duur",
    ipv4: "IPv4-adres",
    ipv6: "IPv6-adres",
    cidrv4: "IPv4-bereik",
    cidrv6: "IPv6-bereik",
    base64: "base64-gecodeerde tekst",
    base64url: "base64 URL-gecodeerde tekst",
    json_string: "JSON string",
    e164: "E.164-nummer",
    jwt: "JWT",
    template_literal: "invoer"
  };
  const TypeDictionary = {
    nan: "NaN",
    number: "getal"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type": {
        const expected = TypeDictionary[issue2.expected] ?? issue2.expected;
        const receivedType = parsedType(issue2.input);
        const received = TypeDictionary[receivedType] ?? receivedType;
        if (/^[A-Z]/.test(issue2.expected)) {
          return `Ongeldige invoer: verwacht instanceof ${issue2.expected}, ontving ${received}`;
        }
        return `Ongeldige invoer: verwacht ${expected}, ontving ${received}`;
      }
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Ongeldige invoer: verwacht ${stringifyPrimitive(issue2.values[0])}`;
        return `Ongeldige optie: verwacht \xE9\xE9n van ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        const longName = issue2.origin === "date" ? "laat" : issue2.origin === "string" ? "lang" : "groot";
        if (sizing)
          return `Te ${longName}: verwacht dat ${issue2.origin ?? "waarde"} ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "elementen"} ${sizing.verb}`;
        return `Te ${longName}: verwacht dat ${issue2.origin ?? "waarde"} ${adj}${issue2.maximum.toString()} is`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        const shortName = issue2.origin === "date" ? "vroeg" : issue2.origin === "string" ? "kort" : "klein";
        if (sizing) {
          return `Te ${shortName}: verwacht dat ${issue2.origin} ${adj}${issue2.minimum.toString()} ${sizing.unit} ${sizing.verb}`;
        }
        return `Te ${shortName}: verwacht dat ${issue2.origin} ${adj}${issue2.minimum.toString()} is`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `Ongeldige tekst: moet met "${_issue.prefix}" beginnen`;
        }
        if (_issue.format === "ends_with")
          return `Ongeldige tekst: moet op "${_issue.suffix}" eindigen`;
        if (_issue.format === "includes")
          return `Ongeldige tekst: moet "${_issue.includes}" bevatten`;
        if (_issue.format === "regex")
          return `Ongeldige tekst: moet overeenkomen met patroon ${_issue.pattern}`;
        return `Ongeldig: ${FormatDictionary[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Ongeldig getal: moet een veelvoud van ${issue2.divisor} zijn`;
      case "unrecognized_keys":
        return `Onbekende key${issue2.keys.length > 1 ? "s" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Ongeldige key in ${issue2.origin}`;
      case "invalid_union":
        return "Ongeldige invoer";
      case "invalid_element":
        return `Ongeldige waarde in ${issue2.origin}`;
      default:
        return `Ongeldige invoer`;
    }
  };
};
function nl_default() {
  return {
    localeError: error29()
  };
}

// node_modules/zod/v4/locales/no.js
var error30 = () => {
  const Sizable = {
    string: { unit: "tegn", verb: "\xE5 ha" },
    file: { unit: "bytes", verb: "\xE5 ha" },
    array: { unit: "elementer", verb: "\xE5 inneholde" },
    set: { unit: "elementer", verb: "\xE5 inneholde" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const FormatDictionary = {
    regex: "input",
    email: "e-postadresse",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO dato- og klokkeslett",
    date: "ISO-dato",
    time: "ISO-klokkeslett",
    duration: "ISO-varighet",
    ipv4: "IPv4-omr\xE5de",
    ipv6: "IPv6-omr\xE5de",
    cidrv4: "IPv4-spekter",
    cidrv6: "IPv6-spekter",
    base64: "base64-enkodet streng",
    base64url: "base64url-enkodet streng",
    json_string: "JSON-streng",
    e164: "E.164-nummer",
    jwt: "JWT",
    template_literal: "input"
  };
  const TypeDictionary = {
    nan: "NaN",
    number: "tall",
    array: "liste"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type": {
        const expected = TypeDictionary[issue2.expected] ?? issue2.expected;
        const receivedType = parsedType(issue2.input);
        const received = TypeDictionary[receivedType] ?? receivedType;
        if (/^[A-Z]/.test(issue2.expected)) {
          return `Ugyldig input: forventet instanceof ${issue2.expected}, fikk ${received}`;
        }
        return `Ugyldig input: forventet ${expected}, fikk ${received}`;
      }
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Ugyldig verdi: forventet ${stringifyPrimitive(issue2.values[0])}`;
        return `Ugyldig valg: forventet en av ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `For stor(t): forventet ${issue2.origin ?? "value"} til \xE5 ha ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "elementer"}`;
        return `For stor(t): forventet ${issue2.origin ?? "value"} til \xE5 ha ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `For lite(n): forventet ${issue2.origin} til \xE5 ha ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `For lite(n): forventet ${issue2.origin} til \xE5 ha ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Ugyldig streng: m\xE5 starte med "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Ugyldig streng: m\xE5 ende med "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Ugyldig streng: m\xE5 inneholde "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Ugyldig streng: m\xE5 matche m\xF8nsteret ${_issue.pattern}`;
        return `Ugyldig ${FormatDictionary[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Ugyldig tall: m\xE5 v\xE6re et multiplum av ${issue2.divisor}`;
      case "unrecognized_keys":
        return `${issue2.keys.length > 1 ? "Ukjente n\xF8kler" : "Ukjent n\xF8kkel"}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Ugyldig n\xF8kkel i ${issue2.origin}`;
      case "invalid_union":
        return "Ugyldig input";
      case "invalid_element":
        return `Ugyldig verdi i ${issue2.origin}`;
      default:
        return `Ugyldig input`;
    }
  };
};
function no_default() {
  return {
    localeError: error30()
  };
}

// node_modules/zod/v4/locales/ota.js
var error31 = () => {
  const Sizable = {
    string: { unit: "harf", verb: "olmal\u0131d\u0131r" },
    file: { unit: "bayt", verb: "olmal\u0131d\u0131r" },
    array: { unit: "unsur", verb: "olmal\u0131d\u0131r" },
    set: { unit: "unsur", verb: "olmal\u0131d\u0131r" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const FormatDictionary = {
    regex: "giren",
    email: "epostag\xE2h",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO heng\xE2m\u0131",
    date: "ISO tarihi",
    time: "ISO zaman\u0131",
    duration: "ISO m\xFCddeti",
    ipv4: "IPv4 ni\u015F\xE2n\u0131",
    ipv6: "IPv6 ni\u015F\xE2n\u0131",
    cidrv4: "IPv4 menzili",
    cidrv6: "IPv6 menzili",
    base64: "base64-\u015Fifreli metin",
    base64url: "base64url-\u015Fifreli metin",
    json_string: "JSON metin",
    e164: "E.164 say\u0131s\u0131",
    jwt: "JWT",
    template_literal: "giren"
  };
  const TypeDictionary = {
    nan: "NaN",
    number: "numara",
    array: "saf",
    null: "gayb"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type": {
        const expected = TypeDictionary[issue2.expected] ?? issue2.expected;
        const receivedType = parsedType(issue2.input);
        const received = TypeDictionary[receivedType] ?? receivedType;
        if (/^[A-Z]/.test(issue2.expected)) {
          return `F\xE2sit giren: umulan instanceof ${issue2.expected}, al\u0131nan ${received}`;
        }
        return `F\xE2sit giren: umulan ${expected}, al\u0131nan ${received}`;
      }
      case "invalid_value":
        if (issue2.values.length === 1)
          return `F\xE2sit giren: umulan ${stringifyPrimitive(issue2.values[0])}`;
        return `F\xE2sit tercih: m\xFBteberler ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Fazla b\xFCy\xFCk: ${issue2.origin ?? "value"}, ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "elements"} sahip olmal\u0131yd\u0131.`;
        return `Fazla b\xFCy\xFCk: ${issue2.origin ?? "value"}, ${adj}${issue2.maximum.toString()} olmal\u0131yd\u0131.`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Fazla k\xFC\xE7\xFCk: ${issue2.origin}, ${adj}${issue2.minimum.toString()} ${sizing.unit} sahip olmal\u0131yd\u0131.`;
        }
        return `Fazla k\xFC\xE7\xFCk: ${issue2.origin}, ${adj}${issue2.minimum.toString()} olmal\u0131yd\u0131.`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `F\xE2sit metin: "${_issue.prefix}" ile ba\u015Flamal\u0131.`;
        if (_issue.format === "ends_with")
          return `F\xE2sit metin: "${_issue.suffix}" ile bitmeli.`;
        if (_issue.format === "includes")
          return `F\xE2sit metin: "${_issue.includes}" ihtiv\xE2 etmeli.`;
        if (_issue.format === "regex")
          return `F\xE2sit metin: ${_issue.pattern} nak\u015F\u0131na uymal\u0131.`;
        return `F\xE2sit ${FormatDictionary[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `F\xE2sit say\u0131: ${issue2.divisor} kat\u0131 olmal\u0131yd\u0131.`;
      case "unrecognized_keys":
        return `Tan\u0131nmayan anahtar ${issue2.keys.length > 1 ? "s" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `${issue2.origin} i\xE7in tan\u0131nmayan anahtar var.`;
      case "invalid_union":
        return "Giren tan\u0131namad\u0131.";
      case "invalid_element":
        return `${issue2.origin} i\xE7in tan\u0131nmayan k\u0131ymet var.`;
      default:
        return `K\u0131ymet tan\u0131namad\u0131.`;
    }
  };
};
function ota_default() {
  return {
    localeError: error31()
  };
}

// node_modules/zod/v4/locales/ps.js
var error32 = () => {
  const Sizable = {
    string: { unit: "\u062A\u0648\u06A9\u064A", verb: "\u0648\u0644\u0631\u064A" },
    file: { unit: "\u0628\u0627\u06CC\u067C\u0633", verb: "\u0648\u0644\u0631\u064A" },
    array: { unit: "\u062A\u0648\u06A9\u064A", verb: "\u0648\u0644\u0631\u064A" },
    set: { unit: "\u062A\u0648\u06A9\u064A", verb: "\u0648\u0644\u0631\u064A" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const FormatDictionary = {
    regex: "\u0648\u0631\u0648\u062F\u064A",
    email: "\u0628\u0631\u06CC\u069A\u0646\u0627\u0644\u06CC\u06A9",
    url: "\u06CC\u0648 \u0622\u0631 \u0627\u0644",
    emoji: "\u0627\u06CC\u0645\u0648\u062C\u064A",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "\u0646\u06CC\u067C\u0647 \u0627\u0648 \u0648\u062E\u062A",
    date: "\u0646\u06D0\u067C\u0647",
    time: "\u0648\u062E\u062A",
    duration: "\u0645\u0648\u062F\u0647",
    ipv4: "\u062F IPv4 \u067E\u062A\u0647",
    ipv6: "\u062F IPv6 \u067E\u062A\u0647",
    cidrv4: "\u062F IPv4 \u0633\u0627\u062D\u0647",
    cidrv6: "\u062F IPv6 \u0633\u0627\u062D\u0647",
    base64: "base64-encoded \u0645\u062A\u0646",
    base64url: "base64url-encoded \u0645\u062A\u0646",
    json_string: "JSON \u0645\u062A\u0646",
    e164: "\u062F E.164 \u0634\u0645\u06D0\u0631\u0647",
    jwt: "JWT",
    template_literal: "\u0648\u0631\u0648\u062F\u064A"
  };
  const TypeDictionary = {
    nan: "NaN",
    number: "\u0639\u062F\u062F",
    array: "\u0627\u0631\u06D0"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type": {
        const expected = TypeDictionary[issue2.expected] ?? issue2.expected;
        const receivedType = parsedType(issue2.input);
        const received = TypeDictionary[receivedType] ?? receivedType;
        if (/^[A-Z]/.test(issue2.expected)) {
          return `\u0646\u0627\u0633\u0645 \u0648\u0631\u0648\u062F\u064A: \u0628\u0627\u06CC\u062F instanceof ${issue2.expected} \u0648\u0627\u06CC, \u0645\u06AB\u0631 ${received} \u062A\u0631\u0644\u0627\u0633\u0647 \u0634\u0648`;
        }
        return `\u0646\u0627\u0633\u0645 \u0648\u0631\u0648\u062F\u064A: \u0628\u0627\u06CC\u062F ${expected} \u0648\u0627\u06CC, \u0645\u06AB\u0631 ${received} \u062A\u0631\u0644\u0627\u0633\u0647 \u0634\u0648`;
      }
      case "invalid_value":
        if (issue2.values.length === 1) {
          return `\u0646\u0627\u0633\u0645 \u0648\u0631\u0648\u062F\u064A: \u0628\u0627\u06CC\u062F ${stringifyPrimitive(issue2.values[0])} \u0648\u0627\u06CC`;
        }
        return `\u0646\u0627\u0633\u0645 \u0627\u0646\u062A\u062E\u0627\u0628: \u0628\u0627\u06CC\u062F \u06CC\u0648 \u0644\u0647 ${joinValues(issue2.values, "|")} \u0685\u062E\u0647 \u0648\u0627\u06CC`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `\u0689\u06CC\u0631 \u0644\u0648\u06CC: ${issue2.origin ?? "\u0627\u0631\u0632\u069A\u062A"} \u0628\u0627\u06CC\u062F ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "\u0639\u0646\u0635\u0631\u0648\u0646\u0647"} \u0648\u0644\u0631\u064A`;
        }
        return `\u0689\u06CC\u0631 \u0644\u0648\u06CC: ${issue2.origin ?? "\u0627\u0631\u0632\u069A\u062A"} \u0628\u0627\u06CC\u062F ${adj}${issue2.maximum.toString()} \u0648\u064A`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `\u0689\u06CC\u0631 \u06A9\u0648\u0686\u0646\u06CC: ${issue2.origin} \u0628\u0627\u06CC\u062F ${adj}${issue2.minimum.toString()} ${sizing.unit} \u0648\u0644\u0631\u064A`;
        }
        return `\u0689\u06CC\u0631 \u06A9\u0648\u0686\u0646\u06CC: ${issue2.origin} \u0628\u0627\u06CC\u062F ${adj}${issue2.minimum.toString()} \u0648\u064A`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `\u0646\u0627\u0633\u0645 \u0645\u062A\u0646: \u0628\u0627\u06CC\u062F \u062F "${_issue.prefix}" \u0633\u0631\u0647 \u067E\u06CC\u0644 \u0634\u064A`;
        }
        if (_issue.format === "ends_with") {
          return `\u0646\u0627\u0633\u0645 \u0645\u062A\u0646: \u0628\u0627\u06CC\u062F \u062F "${_issue.suffix}" \u0633\u0631\u0647 \u067E\u0627\u06CC \u062A\u0647 \u0648\u0631\u0633\u064A\u0696\u064A`;
        }
        if (_issue.format === "includes") {
          return `\u0646\u0627\u0633\u0645 \u0645\u062A\u0646: \u0628\u0627\u06CC\u062F "${_issue.includes}" \u0648\u0644\u0631\u064A`;
        }
        if (_issue.format === "regex") {
          return `\u0646\u0627\u0633\u0645 \u0645\u062A\u0646: \u0628\u0627\u06CC\u062F \u062F ${_issue.pattern} \u0633\u0631\u0647 \u0645\u0637\u0627\u0628\u0642\u062A \u0648\u0644\u0631\u064A`;
        }
        return `${FormatDictionary[_issue.format] ?? issue2.format} \u0646\u0627\u0633\u0645 \u062F\u06CC`;
      }
      case "not_multiple_of":
        return `\u0646\u0627\u0633\u0645 \u0639\u062F\u062F: \u0628\u0627\u06CC\u062F \u062F ${issue2.divisor} \u0645\u0636\u0631\u0628 \u0648\u064A`;
      case "unrecognized_keys":
        return `\u0646\u0627\u0633\u0645 ${issue2.keys.length > 1 ? "\u06A9\u0644\u06CC\u0689\u0648\u0646\u0647" : "\u06A9\u0644\u06CC\u0689"}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `\u0646\u0627\u0633\u0645 \u06A9\u0644\u06CC\u0689 \u067E\u0647 ${issue2.origin} \u06A9\u06D0`;
      case "invalid_union":
        return `\u0646\u0627\u0633\u0645\u0647 \u0648\u0631\u0648\u062F\u064A`;
      case "invalid_element":
        return `\u0646\u0627\u0633\u0645 \u0639\u0646\u0635\u0631 \u067E\u0647 ${issue2.origin} \u06A9\u06D0`;
      default:
        return `\u0646\u0627\u0633\u0645\u0647 \u0648\u0631\u0648\u062F\u064A`;
    }
  };
};
function ps_default() {
  return {
    localeError: error32()
  };
}

// node_modules/zod/v4/locales/pl.js
var error33 = () => {
  const Sizable = {
    string: { unit: "znak\xF3w", verb: "mie\u0107" },
    file: { unit: "bajt\xF3w", verb: "mie\u0107" },
    array: { unit: "element\xF3w", verb: "mie\u0107" },
    set: { unit: "element\xF3w", verb: "mie\u0107" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const FormatDictionary = {
    regex: "wyra\u017Cenie",
    email: "adres email",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "data i godzina w formacie ISO",
    date: "data w formacie ISO",
    time: "godzina w formacie ISO",
    duration: "czas trwania ISO",
    ipv4: "adres IPv4",
    ipv6: "adres IPv6",
    cidrv4: "zakres IPv4",
    cidrv6: "zakres IPv6",
    base64: "ci\u0105g znak\xF3w zakodowany w formacie base64",
    base64url: "ci\u0105g znak\xF3w zakodowany w formacie base64url",
    json_string: "ci\u0105g znak\xF3w w formacie JSON",
    e164: "liczba E.164",
    jwt: "JWT",
    template_literal: "wej\u015Bcie"
  };
  const TypeDictionary = {
    nan: "NaN",
    number: "liczba",
    array: "tablica"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type": {
        const expected = TypeDictionary[issue2.expected] ?? issue2.expected;
        const receivedType = parsedType(issue2.input);
        const received = TypeDictionary[receivedType] ?? receivedType;
        if (/^[A-Z]/.test(issue2.expected)) {
          return `Nieprawid\u0142owe dane wej\u015Bciowe: oczekiwano instanceof ${issue2.expected}, otrzymano ${received}`;
        }
        return `Nieprawid\u0142owe dane wej\u015Bciowe: oczekiwano ${expected}, otrzymano ${received}`;
      }
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Nieprawid\u0142owe dane wej\u015Bciowe: oczekiwano ${stringifyPrimitive(issue2.values[0])}`;
        return `Nieprawid\u0142owa opcja: oczekiwano jednej z warto\u015Bci ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Za du\u017Ca warto\u015B\u0107: oczekiwano, \u017Ce ${issue2.origin ?? "warto\u015B\u0107"} b\u0119dzie mie\u0107 ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "element\xF3w"}`;
        }
        return `Zbyt du\u017C(y/a/e): oczekiwano, \u017Ce ${issue2.origin ?? "warto\u015B\u0107"} b\u0119dzie wynosi\u0107 ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Za ma\u0142a warto\u015B\u0107: oczekiwano, \u017Ce ${issue2.origin ?? "warto\u015B\u0107"} b\u0119dzie mie\u0107 ${adj}${issue2.minimum.toString()} ${sizing.unit ?? "element\xF3w"}`;
        }
        return `Zbyt ma\u0142(y/a/e): oczekiwano, \u017Ce ${issue2.origin ?? "warto\u015B\u0107"} b\u0119dzie wynosi\u0107 ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Nieprawid\u0142owy ci\u0105g znak\xF3w: musi zaczyna\u0107 si\u0119 od "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Nieprawid\u0142owy ci\u0105g znak\xF3w: musi ko\u0144czy\u0107 si\u0119 na "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Nieprawid\u0142owy ci\u0105g znak\xF3w: musi zawiera\u0107 "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Nieprawid\u0142owy ci\u0105g znak\xF3w: musi odpowiada\u0107 wzorcowi ${_issue.pattern}`;
        return `Nieprawid\u0142ow(y/a/e) ${FormatDictionary[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Nieprawid\u0142owa liczba: musi by\u0107 wielokrotno\u015Bci\u0105 ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Nierozpoznane klucze${issue2.keys.length > 1 ? "s" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Nieprawid\u0142owy klucz w ${issue2.origin}`;
      case "invalid_union":
        return "Nieprawid\u0142owe dane wej\u015Bciowe";
      case "invalid_element":
        return `Nieprawid\u0142owa warto\u015B\u0107 w ${issue2.origin}`;
      default:
        return `Nieprawid\u0142owe dane wej\u015Bciowe`;
    }
  };
};
function pl_default() {
  return {
    localeError: error33()
  };
}

// node_modules/zod/v4/locales/pt.js
var error34 = () => {
  const Sizable = {
    string: { unit: "caracteres", verb: "ter" },
    file: { unit: "bytes", verb: "ter" },
    array: { unit: "itens", verb: "ter" },
    set: { unit: "itens", verb: "ter" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const FormatDictionary = {
    regex: "padr\xE3o",
    email: "endere\xE7o de e-mail",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "data e hora ISO",
    date: "data ISO",
    time: "hora ISO",
    duration: "dura\xE7\xE3o ISO",
    ipv4: "endere\xE7o IPv4",
    ipv6: "endere\xE7o IPv6",
    cidrv4: "faixa de IPv4",
    cidrv6: "faixa de IPv6",
    base64: "texto codificado em base64",
    base64url: "URL codificada em base64",
    json_string: "texto JSON",
    e164: "n\xFAmero E.164",
    jwt: "JWT",
    template_literal: "entrada"
  };
  const TypeDictionary = {
    nan: "NaN",
    number: "n\xFAmero",
    null: "nulo"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type": {
        const expected = TypeDictionary[issue2.expected] ?? issue2.expected;
        const receivedType = parsedType(issue2.input);
        const received = TypeDictionary[receivedType] ?? receivedType;
        if (/^[A-Z]/.test(issue2.expected)) {
          return `Tipo inv\xE1lido: esperado instanceof ${issue2.expected}, recebido ${received}`;
        }
        return `Tipo inv\xE1lido: esperado ${expected}, recebido ${received}`;
      }
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Entrada inv\xE1lida: esperado ${stringifyPrimitive(issue2.values[0])}`;
        return `Op\xE7\xE3o inv\xE1lida: esperada uma das ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Muito grande: esperado que ${issue2.origin ?? "valor"} tivesse ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "elementos"}`;
        return `Muito grande: esperado que ${issue2.origin ?? "valor"} fosse ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Muito pequeno: esperado que ${issue2.origin} tivesse ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `Muito pequeno: esperado que ${issue2.origin} fosse ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Texto inv\xE1lido: deve come\xE7ar com "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Texto inv\xE1lido: deve terminar com "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Texto inv\xE1lido: deve incluir "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Texto inv\xE1lido: deve corresponder ao padr\xE3o ${_issue.pattern}`;
        return `${FormatDictionary[_issue.format] ?? issue2.format} inv\xE1lido`;
      }
      case "not_multiple_of":
        return `N\xFAmero inv\xE1lido: deve ser m\xFAltiplo de ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Chave${issue2.keys.length > 1 ? "s" : ""} desconhecida${issue2.keys.length > 1 ? "s" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Chave inv\xE1lida em ${issue2.origin}`;
      case "invalid_union":
        return "Entrada inv\xE1lida";
      case "invalid_element":
        return `Valor inv\xE1lido em ${issue2.origin}`;
      default:
        return `Campo inv\xE1lido`;
    }
  };
};
function pt_default() {
  return {
    localeError: error34()
  };
}

// node_modules/zod/v4/locales/ru.js
function getRussianPlural(count, one, few, many) {
  const absCount = Math.abs(count);
  const lastDigit = absCount % 10;
  const lastTwoDigits = absCount % 100;
  if (lastTwoDigits >= 11 && lastTwoDigits <= 19) {
    return many;
  }
  if (lastDigit === 1) {
    return one;
  }
  if (lastDigit >= 2 && lastDigit <= 4) {
    return few;
  }
  return many;
}
var error35 = () => {
  const Sizable = {
    string: {
      unit: {
        one: "\u0441\u0438\u043C\u0432\u043E\u043B",
        few: "\u0441\u0438\u043C\u0432\u043E\u043B\u0430",
        many: "\u0441\u0438\u043C\u0432\u043E\u043B\u043E\u0432"
      },
      verb: "\u0438\u043C\u0435\u0442\u044C"
    },
    file: {
      unit: {
        one: "\u0431\u0430\u0439\u0442",
        few: "\u0431\u0430\u0439\u0442\u0430",
        many: "\u0431\u0430\u0439\u0442"
      },
      verb: "\u0438\u043C\u0435\u0442\u044C"
    },
    array: {
      unit: {
        one: "\u044D\u043B\u0435\u043C\u0435\u043D\u0442",
        few: "\u044D\u043B\u0435\u043C\u0435\u043D\u0442\u0430",
        many: "\u044D\u043B\u0435\u043C\u0435\u043D\u0442\u043E\u0432"
      },
      verb: "\u0438\u043C\u0435\u0442\u044C"
    },
    set: {
      unit: {
        one: "\u044D\u043B\u0435\u043C\u0435\u043D\u0442",
        few: "\u044D\u043B\u0435\u043C\u0435\u043D\u0442\u0430",
        many: "\u044D\u043B\u0435\u043C\u0435\u043D\u0442\u043E\u0432"
      },
      verb: "\u0438\u043C\u0435\u0442\u044C"
    }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const FormatDictionary = {
    regex: "\u0432\u0432\u043E\u0434",
    email: "email \u0430\u0434\u0440\u0435\u0441",
    url: "URL",
    emoji: "\u044D\u043C\u043E\u0434\u0437\u0438",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO \u0434\u0430\u0442\u0430 \u0438 \u0432\u0440\u0435\u043C\u044F",
    date: "ISO \u0434\u0430\u0442\u0430",
    time: "ISO \u0432\u0440\u0435\u043C\u044F",
    duration: "ISO \u0434\u043B\u0438\u0442\u0435\u043B\u044C\u043D\u043E\u0441\u0442\u044C",
    ipv4: "IPv4 \u0430\u0434\u0440\u0435\u0441",
    ipv6: "IPv6 \u0430\u0434\u0440\u0435\u0441",
    cidrv4: "IPv4 \u0434\u0438\u0430\u043F\u0430\u0437\u043E\u043D",
    cidrv6: "IPv6 \u0434\u0438\u0430\u043F\u0430\u0437\u043E\u043D",
    base64: "\u0441\u0442\u0440\u043E\u043A\u0430 \u0432 \u0444\u043E\u0440\u043C\u0430\u0442\u0435 base64",
    base64url: "\u0441\u0442\u0440\u043E\u043A\u0430 \u0432 \u0444\u043E\u0440\u043C\u0430\u0442\u0435 base64url",
    json_string: "JSON \u0441\u0442\u0440\u043E\u043A\u0430",
    e164: "\u043D\u043E\u043C\u0435\u0440 E.164",
    jwt: "JWT",
    template_literal: "\u0432\u0432\u043E\u0434"
  };
  const TypeDictionary = {
    nan: "NaN",
    number: "\u0447\u0438\u0441\u043B\u043E",
    array: "\u043C\u0430\u0441\u0441\u0438\u0432"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type": {
        const expected = TypeDictionary[issue2.expected] ?? issue2.expected;
        const receivedType = parsedType(issue2.input);
        const received = TypeDictionary[receivedType] ?? receivedType;
        if (/^[A-Z]/.test(issue2.expected)) {
          return `\u041D\u0435\u0432\u0435\u0440\u043D\u044B\u0439 \u0432\u0432\u043E\u0434: \u043E\u0436\u0438\u0434\u0430\u043B\u043E\u0441\u044C instanceof ${issue2.expected}, \u043F\u043E\u043B\u0443\u0447\u0435\u043D\u043E ${received}`;
        }
        return `\u041D\u0435\u0432\u0435\u0440\u043D\u044B\u0439 \u0432\u0432\u043E\u0434: \u043E\u0436\u0438\u0434\u0430\u043B\u043E\u0441\u044C ${expected}, \u043F\u043E\u043B\u0443\u0447\u0435\u043D\u043E ${received}`;
      }
      case "invalid_value":
        if (issue2.values.length === 1)
          return `\u041D\u0435\u0432\u0435\u0440\u043D\u044B\u0439 \u0432\u0432\u043E\u0434: \u043E\u0436\u0438\u0434\u0430\u043B\u043E\u0441\u044C ${stringifyPrimitive(issue2.values[0])}`;
        return `\u041D\u0435\u0432\u0435\u0440\u043D\u044B\u0439 \u0432\u0430\u0440\u0438\u0430\u043D\u0442: \u043E\u0436\u0438\u0434\u0430\u043B\u043E\u0441\u044C \u043E\u0434\u043D\u043E \u0438\u0437 ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          const maxValue = Number(issue2.maximum);
          const unit = getRussianPlural(maxValue, sizing.unit.one, sizing.unit.few, sizing.unit.many);
          return `\u0421\u043B\u0438\u0448\u043A\u043E\u043C \u0431\u043E\u043B\u044C\u0448\u043E\u0435 \u0437\u043D\u0430\u0447\u0435\u043D\u0438\u0435: \u043E\u0436\u0438\u0434\u0430\u043B\u043E\u0441\u044C, \u0447\u0442\u043E ${issue2.origin ?? "\u0437\u043D\u0430\u0447\u0435\u043D\u0438\u0435"} \u0431\u0443\u0434\u0435\u0442 \u0438\u043C\u0435\u0442\u044C ${adj}${issue2.maximum.toString()} ${unit}`;
        }
        return `\u0421\u043B\u0438\u0448\u043A\u043E\u043C \u0431\u043E\u043B\u044C\u0448\u043E\u0435 \u0437\u043D\u0430\u0447\u0435\u043D\u0438\u0435: \u043E\u0436\u0438\u0434\u0430\u043B\u043E\u0441\u044C, \u0447\u0442\u043E ${issue2.origin ?? "\u0437\u043D\u0430\u0447\u0435\u043D\u0438\u0435"} \u0431\u0443\u0434\u0435\u0442 ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          const minValue = Number(issue2.minimum);
          const unit = getRussianPlural(minValue, sizing.unit.one, sizing.unit.few, sizing.unit.many);
          return `\u0421\u043B\u0438\u0448\u043A\u043E\u043C \u043C\u0430\u043B\u0435\u043D\u044C\u043A\u043E\u0435 \u0437\u043D\u0430\u0447\u0435\u043D\u0438\u0435: \u043E\u0436\u0438\u0434\u0430\u043B\u043E\u0441\u044C, \u0447\u0442\u043E ${issue2.origin} \u0431\u0443\u0434\u0435\u0442 \u0438\u043C\u0435\u0442\u044C ${adj}${issue2.minimum.toString()} ${unit}`;
        }
        return `\u0421\u043B\u0438\u0448\u043A\u043E\u043C \u043C\u0430\u043B\u0435\u043D\u044C\u043A\u043E\u0435 \u0437\u043D\u0430\u0447\u0435\u043D\u0438\u0435: \u043E\u0436\u0438\u0434\u0430\u043B\u043E\u0441\u044C, \u0447\u0442\u043E ${issue2.origin} \u0431\u0443\u0434\u0435\u0442 ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `\u041D\u0435\u0432\u0435\u0440\u043D\u0430\u044F \u0441\u0442\u0440\u043E\u043A\u0430: \u0434\u043E\u043B\u0436\u043D\u0430 \u043D\u0430\u0447\u0438\u043D\u0430\u0442\u044C\u0441\u044F \u0441 "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `\u041D\u0435\u0432\u0435\u0440\u043D\u0430\u044F \u0441\u0442\u0440\u043E\u043A\u0430: \u0434\u043E\u043B\u0436\u043D\u0430 \u0437\u0430\u043A\u0430\u043D\u0447\u0438\u0432\u0430\u0442\u044C\u0441\u044F \u043D\u0430 "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `\u041D\u0435\u0432\u0435\u0440\u043D\u0430\u044F \u0441\u0442\u0440\u043E\u043A\u0430: \u0434\u043E\u043B\u0436\u043D\u0430 \u0441\u043E\u0434\u0435\u0440\u0436\u0430\u0442\u044C "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `\u041D\u0435\u0432\u0435\u0440\u043D\u0430\u044F \u0441\u0442\u0440\u043E\u043A\u0430: \u0434\u043E\u043B\u0436\u043D\u0430 \u0441\u043E\u043E\u0442\u0432\u0435\u0442\u0441\u0442\u0432\u043E\u0432\u0430\u0442\u044C \u0448\u0430\u0431\u043B\u043E\u043D\u0443 ${_issue.pattern}`;
        return `\u041D\u0435\u0432\u0435\u0440\u043D\u044B\u0439 ${FormatDictionary[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `\u041D\u0435\u0432\u0435\u0440\u043D\u043E\u0435 \u0447\u0438\u0441\u043B\u043E: \u0434\u043E\u043B\u0436\u043D\u043E \u0431\u044B\u0442\u044C \u043A\u0440\u0430\u0442\u043D\u044B\u043C ${issue2.divisor}`;
      case "unrecognized_keys":
        return `\u041D\u0435\u0440\u0430\u0441\u043F\u043E\u0437\u043D\u0430\u043D\u043D${issue2.keys.length > 1 ? "\u044B\u0435" : "\u044B\u0439"} \u043A\u043B\u044E\u0447${issue2.keys.length > 1 ? "\u0438" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `\u041D\u0435\u0432\u0435\u0440\u043D\u044B\u0439 \u043A\u043B\u044E\u0447 \u0432 ${issue2.origin}`;
      case "invalid_union":
        return "\u041D\u0435\u0432\u0435\u0440\u043D\u044B\u0435 \u0432\u0445\u043E\u0434\u043D\u044B\u0435 \u0434\u0430\u043D\u043D\u044B\u0435";
      case "invalid_element":
        return `\u041D\u0435\u0432\u0435\u0440\u043D\u043E\u0435 \u0437\u043D\u0430\u0447\u0435\u043D\u0438\u0435 \u0432 ${issue2.origin}`;
      default:
        return `\u041D\u0435\u0432\u0435\u0440\u043D\u044B\u0435 \u0432\u0445\u043E\u0434\u043D\u044B\u0435 \u0434\u0430\u043D\u043D\u044B\u0435`;
    }
  };
};
function ru_default() {
  return {
    localeError: error35()
  };
}

// node_modules/zod/v4/locales/sl.js
var error36 = () => {
  const Sizable = {
    string: { unit: "znakov", verb: "imeti" },
    file: { unit: "bajtov", verb: "imeti" },
    array: { unit: "elementov", verb: "imeti" },
    set: { unit: "elementov", verb: "imeti" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const FormatDictionary = {
    regex: "vnos",
    email: "e-po\u0161tni naslov",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO datum in \u010Das",
    date: "ISO datum",
    time: "ISO \u010Das",
    duration: "ISO trajanje",
    ipv4: "IPv4 naslov",
    ipv6: "IPv6 naslov",
    cidrv4: "obseg IPv4",
    cidrv6: "obseg IPv6",
    base64: "base64 kodiran niz",
    base64url: "base64url kodiran niz",
    json_string: "JSON niz",
    e164: "E.164 \u0161tevilka",
    jwt: "JWT",
    template_literal: "vnos"
  };
  const TypeDictionary = {
    nan: "NaN",
    number: "\u0161tevilo",
    array: "tabela"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type": {
        const expected = TypeDictionary[issue2.expected] ?? issue2.expected;
        const receivedType = parsedType(issue2.input);
        const received = TypeDictionary[receivedType] ?? receivedType;
        if (/^[A-Z]/.test(issue2.expected)) {
          return `Neveljaven vnos: pri\u010Dakovano instanceof ${issue2.expected}, prejeto ${received}`;
        }
        return `Neveljaven vnos: pri\u010Dakovano ${expected}, prejeto ${received}`;
      }
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Neveljaven vnos: pri\u010Dakovano ${stringifyPrimitive(issue2.values[0])}`;
        return `Neveljavna mo\u017Enost: pri\u010Dakovano eno izmed ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Preveliko: pri\u010Dakovano, da bo ${issue2.origin ?? "vrednost"} imelo ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "elementov"}`;
        return `Preveliko: pri\u010Dakovano, da bo ${issue2.origin ?? "vrednost"} ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Premajhno: pri\u010Dakovano, da bo ${issue2.origin} imelo ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `Premajhno: pri\u010Dakovano, da bo ${issue2.origin} ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `Neveljaven niz: mora se za\u010Deti z "${_issue.prefix}"`;
        }
        if (_issue.format === "ends_with")
          return `Neveljaven niz: mora se kon\u010Dati z "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Neveljaven niz: mora vsebovati "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Neveljaven niz: mora ustrezati vzorcu ${_issue.pattern}`;
        return `Neveljaven ${FormatDictionary[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Neveljavno \u0161tevilo: mora biti ve\u010Dkratnik ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Neprepoznan${issue2.keys.length > 1 ? "i klju\u010Di" : " klju\u010D"}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Neveljaven klju\u010D v ${issue2.origin}`;
      case "invalid_union":
        return "Neveljaven vnos";
      case "invalid_element":
        return `Neveljavna vrednost v ${issue2.origin}`;
      default:
        return "Neveljaven vnos";
    }
  };
};
function sl_default() {
  return {
    localeError: error36()
  };
}

// node_modules/zod/v4/locales/sv.js
var error37 = () => {
  const Sizable = {
    string: { unit: "tecken", verb: "att ha" },
    file: { unit: "bytes", verb: "att ha" },
    array: { unit: "objekt", verb: "att inneh\xE5lla" },
    set: { unit: "objekt", verb: "att inneh\xE5lla" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const FormatDictionary = {
    regex: "regulj\xE4rt uttryck",
    email: "e-postadress",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO-datum och tid",
    date: "ISO-datum",
    time: "ISO-tid",
    duration: "ISO-varaktighet",
    ipv4: "IPv4-intervall",
    ipv6: "IPv6-intervall",
    cidrv4: "IPv4-spektrum",
    cidrv6: "IPv6-spektrum",
    base64: "base64-kodad str\xE4ng",
    base64url: "base64url-kodad str\xE4ng",
    json_string: "JSON-str\xE4ng",
    e164: "E.164-nummer",
    jwt: "JWT",
    template_literal: "mall-literal"
  };
  const TypeDictionary = {
    nan: "NaN",
    number: "antal",
    array: "lista"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type": {
        const expected = TypeDictionary[issue2.expected] ?? issue2.expected;
        const receivedType = parsedType(issue2.input);
        const received = TypeDictionary[receivedType] ?? receivedType;
        if (/^[A-Z]/.test(issue2.expected)) {
          return `Ogiltig inmatning: f\xF6rv\xE4ntat instanceof ${issue2.expected}, fick ${received}`;
        }
        return `Ogiltig inmatning: f\xF6rv\xE4ntat ${expected}, fick ${received}`;
      }
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Ogiltig inmatning: f\xF6rv\xE4ntat ${stringifyPrimitive(issue2.values[0])}`;
        return `Ogiltigt val: f\xF6rv\xE4ntade en av ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `F\xF6r stor(t): f\xF6rv\xE4ntade ${issue2.origin ?? "v\xE4rdet"} att ha ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "element"}`;
        }
        return `F\xF6r stor(t): f\xF6rv\xE4ntat ${issue2.origin ?? "v\xE4rdet"} att ha ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `F\xF6r lite(t): f\xF6rv\xE4ntade ${issue2.origin ?? "v\xE4rdet"} att ha ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `F\xF6r lite(t): f\xF6rv\xE4ntade ${issue2.origin ?? "v\xE4rdet"} att ha ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `Ogiltig str\xE4ng: m\xE5ste b\xF6rja med "${_issue.prefix}"`;
        }
        if (_issue.format === "ends_with")
          return `Ogiltig str\xE4ng: m\xE5ste sluta med "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Ogiltig str\xE4ng: m\xE5ste inneh\xE5lla "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Ogiltig str\xE4ng: m\xE5ste matcha m\xF6nstret "${_issue.pattern}"`;
        return `Ogiltig(t) ${FormatDictionary[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Ogiltigt tal: m\xE5ste vara en multipel av ${issue2.divisor}`;
      case "unrecognized_keys":
        return `${issue2.keys.length > 1 ? "Ok\xE4nda nycklar" : "Ok\xE4nd nyckel"}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Ogiltig nyckel i ${issue2.origin ?? "v\xE4rdet"}`;
      case "invalid_union":
        return "Ogiltig input";
      case "invalid_element":
        return `Ogiltigt v\xE4rde i ${issue2.origin ?? "v\xE4rdet"}`;
      default:
        return `Ogiltig input`;
    }
  };
};
function sv_default() {
  return {
    localeError: error37()
  };
}

// node_modules/zod/v4/locales/ta.js
var error38 = () => {
  const Sizable = {
    string: { unit: "\u0B8E\u0BB4\u0BC1\u0BA4\u0BCD\u0BA4\u0BC1\u0B95\u0BCD\u0B95\u0BB3\u0BCD", verb: "\u0B95\u0BCA\u0BA3\u0BCD\u0B9F\u0BBF\u0BB0\u0BC1\u0B95\u0BCD\u0B95 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD" },
    file: { unit: "\u0BAA\u0BC8\u0B9F\u0BCD\u0B9F\u0BC1\u0B95\u0BB3\u0BCD", verb: "\u0B95\u0BCA\u0BA3\u0BCD\u0B9F\u0BBF\u0BB0\u0BC1\u0B95\u0BCD\u0B95 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD" },
    array: { unit: "\u0B89\u0BB1\u0BC1\u0BAA\u0BCD\u0BAA\u0BC1\u0B95\u0BB3\u0BCD", verb: "\u0B95\u0BCA\u0BA3\u0BCD\u0B9F\u0BBF\u0BB0\u0BC1\u0B95\u0BCD\u0B95 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD" },
    set: { unit: "\u0B89\u0BB1\u0BC1\u0BAA\u0BCD\u0BAA\u0BC1\u0B95\u0BB3\u0BCD", verb: "\u0B95\u0BCA\u0BA3\u0BCD\u0B9F\u0BBF\u0BB0\u0BC1\u0B95\u0BCD\u0B95 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const FormatDictionary = {
    regex: "\u0B89\u0BB3\u0BCD\u0BB3\u0BC0\u0B9F\u0BC1",
    email: "\u0BAE\u0BBF\u0BA9\u0BCD\u0BA9\u0B9E\u0BCD\u0B9A\u0BB2\u0BCD \u0BAE\u0BC1\u0B95\u0BB5\u0BB0\u0BBF",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO \u0BA4\u0BC7\u0BA4\u0BBF \u0BA8\u0BC7\u0BB0\u0BAE\u0BCD",
    date: "ISO \u0BA4\u0BC7\u0BA4\u0BBF",
    time: "ISO \u0BA8\u0BC7\u0BB0\u0BAE\u0BCD",
    duration: "ISO \u0B95\u0BBE\u0BB2 \u0B85\u0BB3\u0BB5\u0BC1",
    ipv4: "IPv4 \u0BAE\u0BC1\u0B95\u0BB5\u0BB0\u0BBF",
    ipv6: "IPv6 \u0BAE\u0BC1\u0B95\u0BB5\u0BB0\u0BBF",
    cidrv4: "IPv4 \u0BB5\u0BB0\u0BAE\u0BCD\u0BAA\u0BC1",
    cidrv6: "IPv6 \u0BB5\u0BB0\u0BAE\u0BCD\u0BAA\u0BC1",
    base64: "base64-encoded \u0B9A\u0BB0\u0BAE\u0BCD",
    base64url: "base64url-encoded \u0B9A\u0BB0\u0BAE\u0BCD",
    json_string: "JSON \u0B9A\u0BB0\u0BAE\u0BCD",
    e164: "E.164 \u0B8E\u0BA3\u0BCD",
    jwt: "JWT",
    template_literal: "input"
  };
  const TypeDictionary = {
    nan: "NaN",
    number: "\u0B8E\u0BA3\u0BCD",
    array: "\u0B85\u0BA3\u0BBF",
    null: "\u0BB5\u0BC6\u0BB1\u0BC1\u0BAE\u0BC8"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type": {
        const expected = TypeDictionary[issue2.expected] ?? issue2.expected;
        const receivedType = parsedType(issue2.input);
        const received = TypeDictionary[receivedType] ?? receivedType;
        if (/^[A-Z]/.test(issue2.expected)) {
          return `\u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0B89\u0BB3\u0BCD\u0BB3\u0BC0\u0B9F\u0BC1: \u0B8E\u0BA4\u0BBF\u0BB0\u0BCD\u0BAA\u0BBE\u0BB0\u0BCD\u0B95\u0BCD\u0B95\u0BAA\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F\u0BA4\u0BC1 instanceof ${issue2.expected}, \u0BAA\u0BC6\u0BB1\u0BAA\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F\u0BA4\u0BC1 ${received}`;
        }
        return `\u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0B89\u0BB3\u0BCD\u0BB3\u0BC0\u0B9F\u0BC1: \u0B8E\u0BA4\u0BBF\u0BB0\u0BCD\u0BAA\u0BBE\u0BB0\u0BCD\u0B95\u0BCD\u0B95\u0BAA\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F\u0BA4\u0BC1 ${expected}, \u0BAA\u0BC6\u0BB1\u0BAA\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F\u0BA4\u0BC1 ${received}`;
      }
      case "invalid_value":
        if (issue2.values.length === 1)
          return `\u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0B89\u0BB3\u0BCD\u0BB3\u0BC0\u0B9F\u0BC1: \u0B8E\u0BA4\u0BBF\u0BB0\u0BCD\u0BAA\u0BBE\u0BB0\u0BCD\u0B95\u0BCD\u0B95\u0BAA\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F\u0BA4\u0BC1 ${stringifyPrimitive(issue2.values[0])}`;
        return `\u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0BB5\u0BBF\u0BB0\u0BC1\u0BAA\u0BCD\u0BAA\u0BAE\u0BCD: \u0B8E\u0BA4\u0BBF\u0BB0\u0BCD\u0BAA\u0BBE\u0BB0\u0BCD\u0B95\u0BCD\u0B95\u0BAA\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F\u0BA4\u0BC1 ${joinValues(issue2.values, "|")} \u0B87\u0BB2\u0BCD \u0B92\u0BA9\u0BCD\u0BB1\u0BC1`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `\u0BAE\u0BBF\u0B95 \u0BAA\u0BC6\u0BB0\u0BBF\u0BAF\u0BA4\u0BC1: \u0B8E\u0BA4\u0BBF\u0BB0\u0BCD\u0BAA\u0BBE\u0BB0\u0BCD\u0B95\u0BCD\u0B95\u0BAA\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F\u0BA4\u0BC1 ${issue2.origin ?? "\u0BAE\u0BA4\u0BBF\u0BAA\u0BCD\u0BAA\u0BC1"} ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "\u0B89\u0BB1\u0BC1\u0BAA\u0BCD\u0BAA\u0BC1\u0B95\u0BB3\u0BCD"} \u0B86\u0B95 \u0B87\u0BB0\u0BC1\u0B95\u0BCD\u0B95 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD`;
        }
        return `\u0BAE\u0BBF\u0B95 \u0BAA\u0BC6\u0BB0\u0BBF\u0BAF\u0BA4\u0BC1: \u0B8E\u0BA4\u0BBF\u0BB0\u0BCD\u0BAA\u0BBE\u0BB0\u0BCD\u0B95\u0BCD\u0B95\u0BAA\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F\u0BA4\u0BC1 ${issue2.origin ?? "\u0BAE\u0BA4\u0BBF\u0BAA\u0BCD\u0BAA\u0BC1"} ${adj}${issue2.maximum.toString()} \u0B86\u0B95 \u0B87\u0BB0\u0BC1\u0B95\u0BCD\u0B95 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `\u0BAE\u0BBF\u0B95\u0B9A\u0BCD \u0B9A\u0BBF\u0BB1\u0BBF\u0BAF\u0BA4\u0BC1: \u0B8E\u0BA4\u0BBF\u0BB0\u0BCD\u0BAA\u0BBE\u0BB0\u0BCD\u0B95\u0BCD\u0B95\u0BAA\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F\u0BA4\u0BC1 ${issue2.origin} ${adj}${issue2.minimum.toString()} ${sizing.unit} \u0B86\u0B95 \u0B87\u0BB0\u0BC1\u0B95\u0BCD\u0B95 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD`;
        }
        return `\u0BAE\u0BBF\u0B95\u0B9A\u0BCD \u0B9A\u0BBF\u0BB1\u0BBF\u0BAF\u0BA4\u0BC1: \u0B8E\u0BA4\u0BBF\u0BB0\u0BCD\u0BAA\u0BBE\u0BB0\u0BCD\u0B95\u0BCD\u0B95\u0BAA\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F\u0BA4\u0BC1 ${issue2.origin} ${adj}${issue2.minimum.toString()} \u0B86\u0B95 \u0B87\u0BB0\u0BC1\u0B95\u0BCD\u0B95 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `\u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0B9A\u0BB0\u0BAE\u0BCD: "${_issue.prefix}" \u0B87\u0BB2\u0BCD \u0BA4\u0BCA\u0B9F\u0B99\u0BCD\u0B95 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD`;
        if (_issue.format === "ends_with")
          return `\u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0B9A\u0BB0\u0BAE\u0BCD: "${_issue.suffix}" \u0B87\u0BB2\u0BCD \u0BAE\u0BC1\u0B9F\u0BBF\u0BB5\u0B9F\u0BC8\u0BAF \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD`;
        if (_issue.format === "includes")
          return `\u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0B9A\u0BB0\u0BAE\u0BCD: "${_issue.includes}" \u0B90 \u0B89\u0BB3\u0BCD\u0BB3\u0B9F\u0B95\u0BCD\u0B95 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD`;
        if (_issue.format === "regex")
          return `\u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0B9A\u0BB0\u0BAE\u0BCD: ${_issue.pattern} \u0BAE\u0BC1\u0BB1\u0BC8\u0BAA\u0BBE\u0B9F\u0BCD\u0B9F\u0BC1\u0B9F\u0BA9\u0BCD \u0BAA\u0BCA\u0BB0\u0BC1\u0BA8\u0BCD\u0BA4 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD`;
        return `\u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 ${FormatDictionary[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `\u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0B8E\u0BA3\u0BCD: ${issue2.divisor} \u0B87\u0BA9\u0BCD \u0BAA\u0BB2\u0BAE\u0BBE\u0B95 \u0B87\u0BB0\u0BC1\u0B95\u0BCD\u0B95 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD`;
      case "unrecognized_keys":
        return `\u0B85\u0B9F\u0BC8\u0BAF\u0BBE\u0BB3\u0BAE\u0BCD \u0BA4\u0BC6\u0BB0\u0BBF\u0BAF\u0BBE\u0BA4 \u0BB5\u0BBF\u0B9A\u0BC8${issue2.keys.length > 1 ? "\u0B95\u0BB3\u0BCD" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `${issue2.origin} \u0B87\u0BB2\u0BCD \u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0BB5\u0BBF\u0B9A\u0BC8`;
      case "invalid_union":
        return "\u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0B89\u0BB3\u0BCD\u0BB3\u0BC0\u0B9F\u0BC1";
      case "invalid_element":
        return `${issue2.origin} \u0B87\u0BB2\u0BCD \u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0BAE\u0BA4\u0BBF\u0BAA\u0BCD\u0BAA\u0BC1`;
      default:
        return `\u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0B89\u0BB3\u0BCD\u0BB3\u0BC0\u0B9F\u0BC1`;
    }
  };
};
function ta_default() {
  return {
    localeError: error38()
  };
}

// node_modules/zod/v4/locales/th.js
var error39 = () => {
  const Sizable = {
    string: { unit: "\u0E15\u0E31\u0E27\u0E2D\u0E31\u0E01\u0E29\u0E23", verb: "\u0E04\u0E27\u0E23\u0E21\u0E35" },
    file: { unit: "\u0E44\u0E1A\u0E15\u0E4C", verb: "\u0E04\u0E27\u0E23\u0E21\u0E35" },
    array: { unit: "\u0E23\u0E32\u0E22\u0E01\u0E32\u0E23", verb: "\u0E04\u0E27\u0E23\u0E21\u0E35" },
    set: { unit: "\u0E23\u0E32\u0E22\u0E01\u0E32\u0E23", verb: "\u0E04\u0E27\u0E23\u0E21\u0E35" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const FormatDictionary = {
    regex: "\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E17\u0E35\u0E48\u0E1B\u0E49\u0E2D\u0E19",
    email: "\u0E17\u0E35\u0E48\u0E2D\u0E22\u0E39\u0E48\u0E2D\u0E35\u0E40\u0E21\u0E25",
    url: "URL",
    emoji: "\u0E2D\u0E34\u0E42\u0E21\u0E08\u0E34",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "\u0E27\u0E31\u0E19\u0E17\u0E35\u0E48\u0E40\u0E27\u0E25\u0E32\u0E41\u0E1A\u0E1A ISO",
    date: "\u0E27\u0E31\u0E19\u0E17\u0E35\u0E48\u0E41\u0E1A\u0E1A ISO",
    time: "\u0E40\u0E27\u0E25\u0E32\u0E41\u0E1A\u0E1A ISO",
    duration: "\u0E0A\u0E48\u0E27\u0E07\u0E40\u0E27\u0E25\u0E32\u0E41\u0E1A\u0E1A ISO",
    ipv4: "\u0E17\u0E35\u0E48\u0E2D\u0E22\u0E39\u0E48 IPv4",
    ipv6: "\u0E17\u0E35\u0E48\u0E2D\u0E22\u0E39\u0E48 IPv6",
    cidrv4: "\u0E0A\u0E48\u0E27\u0E07 IP \u0E41\u0E1A\u0E1A IPv4",
    cidrv6: "\u0E0A\u0E48\u0E27\u0E07 IP \u0E41\u0E1A\u0E1A IPv6",
    base64: "\u0E02\u0E49\u0E2D\u0E04\u0E27\u0E32\u0E21\u0E41\u0E1A\u0E1A Base64",
    base64url: "\u0E02\u0E49\u0E2D\u0E04\u0E27\u0E32\u0E21\u0E41\u0E1A\u0E1A Base64 \u0E2A\u0E33\u0E2B\u0E23\u0E31\u0E1A URL",
    json_string: "\u0E02\u0E49\u0E2D\u0E04\u0E27\u0E32\u0E21\u0E41\u0E1A\u0E1A JSON",
    e164: "\u0E40\u0E1A\u0E2D\u0E23\u0E4C\u0E42\u0E17\u0E23\u0E28\u0E31\u0E1E\u0E17\u0E4C\u0E23\u0E30\u0E2B\u0E27\u0E48\u0E32\u0E07\u0E1B\u0E23\u0E30\u0E40\u0E17\u0E28 (E.164)",
    jwt: "\u0E42\u0E17\u0E40\u0E04\u0E19 JWT",
    template_literal: "\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E17\u0E35\u0E48\u0E1B\u0E49\u0E2D\u0E19"
  };
  const TypeDictionary = {
    nan: "NaN",
    number: "\u0E15\u0E31\u0E27\u0E40\u0E25\u0E02",
    array: "\u0E2D\u0E32\u0E23\u0E4C\u0E40\u0E23\u0E22\u0E4C (Array)",
    null: "\u0E44\u0E21\u0E48\u0E21\u0E35\u0E04\u0E48\u0E32 (null)"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type": {
        const expected = TypeDictionary[issue2.expected] ?? issue2.expected;
        const receivedType = parsedType(issue2.input);
        const received = TypeDictionary[receivedType] ?? receivedType;
        if (/^[A-Z]/.test(issue2.expected)) {
          return `\u0E1B\u0E23\u0E30\u0E40\u0E20\u0E17\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07: \u0E04\u0E27\u0E23\u0E40\u0E1B\u0E47\u0E19 instanceof ${issue2.expected} \u0E41\u0E15\u0E48\u0E44\u0E14\u0E49\u0E23\u0E31\u0E1A ${received}`;
        }
        return `\u0E1B\u0E23\u0E30\u0E40\u0E20\u0E17\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07: \u0E04\u0E27\u0E23\u0E40\u0E1B\u0E47\u0E19 ${expected} \u0E41\u0E15\u0E48\u0E44\u0E14\u0E49\u0E23\u0E31\u0E1A ${received}`;
      }
      case "invalid_value":
        if (issue2.values.length === 1)
          return `\u0E04\u0E48\u0E32\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07: \u0E04\u0E27\u0E23\u0E40\u0E1B\u0E47\u0E19 ${stringifyPrimitive(issue2.values[0])}`;
        return `\u0E15\u0E31\u0E27\u0E40\u0E25\u0E37\u0E2D\u0E01\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07: \u0E04\u0E27\u0E23\u0E40\u0E1B\u0E47\u0E19\u0E2B\u0E19\u0E36\u0E48\u0E07\u0E43\u0E19 ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "\u0E44\u0E21\u0E48\u0E40\u0E01\u0E34\u0E19" : "\u0E19\u0E49\u0E2D\u0E22\u0E01\u0E27\u0E48\u0E32";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `\u0E40\u0E01\u0E34\u0E19\u0E01\u0E33\u0E2B\u0E19\u0E14: ${issue2.origin ?? "\u0E04\u0E48\u0E32"} \u0E04\u0E27\u0E23\u0E21\u0E35${adj} ${issue2.maximum.toString()} ${sizing.unit ?? "\u0E23\u0E32\u0E22\u0E01\u0E32\u0E23"}`;
        return `\u0E40\u0E01\u0E34\u0E19\u0E01\u0E33\u0E2B\u0E19\u0E14: ${issue2.origin ?? "\u0E04\u0E48\u0E32"} \u0E04\u0E27\u0E23\u0E21\u0E35${adj} ${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? "\u0E2D\u0E22\u0E48\u0E32\u0E07\u0E19\u0E49\u0E2D\u0E22" : "\u0E21\u0E32\u0E01\u0E01\u0E27\u0E48\u0E32";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `\u0E19\u0E49\u0E2D\u0E22\u0E01\u0E27\u0E48\u0E32\u0E01\u0E33\u0E2B\u0E19\u0E14: ${issue2.origin} \u0E04\u0E27\u0E23\u0E21\u0E35${adj} ${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `\u0E19\u0E49\u0E2D\u0E22\u0E01\u0E27\u0E48\u0E32\u0E01\u0E33\u0E2B\u0E19\u0E14: ${issue2.origin} \u0E04\u0E27\u0E23\u0E21\u0E35${adj} ${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `\u0E23\u0E39\u0E1B\u0E41\u0E1A\u0E1A\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07: \u0E02\u0E49\u0E2D\u0E04\u0E27\u0E32\u0E21\u0E15\u0E49\u0E2D\u0E07\u0E02\u0E36\u0E49\u0E19\u0E15\u0E49\u0E19\u0E14\u0E49\u0E27\u0E22 "${_issue.prefix}"`;
        }
        if (_issue.format === "ends_with")
          return `\u0E23\u0E39\u0E1B\u0E41\u0E1A\u0E1A\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07: \u0E02\u0E49\u0E2D\u0E04\u0E27\u0E32\u0E21\u0E15\u0E49\u0E2D\u0E07\u0E25\u0E07\u0E17\u0E49\u0E32\u0E22\u0E14\u0E49\u0E27\u0E22 "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `\u0E23\u0E39\u0E1B\u0E41\u0E1A\u0E1A\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07: \u0E02\u0E49\u0E2D\u0E04\u0E27\u0E32\u0E21\u0E15\u0E49\u0E2D\u0E07\u0E21\u0E35 "${_issue.includes}" \u0E2D\u0E22\u0E39\u0E48\u0E43\u0E19\u0E02\u0E49\u0E2D\u0E04\u0E27\u0E32\u0E21`;
        if (_issue.format === "regex")
          return `\u0E23\u0E39\u0E1B\u0E41\u0E1A\u0E1A\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07: \u0E15\u0E49\u0E2D\u0E07\u0E15\u0E23\u0E07\u0E01\u0E31\u0E1A\u0E23\u0E39\u0E1B\u0E41\u0E1A\u0E1A\u0E17\u0E35\u0E48\u0E01\u0E33\u0E2B\u0E19\u0E14 ${_issue.pattern}`;
        return `\u0E23\u0E39\u0E1B\u0E41\u0E1A\u0E1A\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07: ${FormatDictionary[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `\u0E15\u0E31\u0E27\u0E40\u0E25\u0E02\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07: \u0E15\u0E49\u0E2D\u0E07\u0E40\u0E1B\u0E47\u0E19\u0E08\u0E33\u0E19\u0E27\u0E19\u0E17\u0E35\u0E48\u0E2B\u0E32\u0E23\u0E14\u0E49\u0E27\u0E22 ${issue2.divisor} \u0E44\u0E14\u0E49\u0E25\u0E07\u0E15\u0E31\u0E27`;
      case "unrecognized_keys":
        return `\u0E1E\u0E1A\u0E04\u0E35\u0E22\u0E4C\u0E17\u0E35\u0E48\u0E44\u0E21\u0E48\u0E23\u0E39\u0E49\u0E08\u0E31\u0E01: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `\u0E04\u0E35\u0E22\u0E4C\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07\u0E43\u0E19 ${issue2.origin}`;
      case "invalid_union":
        return "\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07: \u0E44\u0E21\u0E48\u0E15\u0E23\u0E07\u0E01\u0E31\u0E1A\u0E23\u0E39\u0E1B\u0E41\u0E1A\u0E1A\u0E22\u0E39\u0E40\u0E19\u0E35\u0E22\u0E19\u0E17\u0E35\u0E48\u0E01\u0E33\u0E2B\u0E19\u0E14\u0E44\u0E27\u0E49";
      case "invalid_element":
        return `\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07\u0E43\u0E19 ${issue2.origin}`;
      default:
        return `\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07`;
    }
  };
};
function th_default() {
  return {
    localeError: error39()
  };
}

// node_modules/zod/v4/locales/tr.js
var error40 = () => {
  const Sizable = {
    string: { unit: "karakter", verb: "olmal\u0131" },
    file: { unit: "bayt", verb: "olmal\u0131" },
    array: { unit: "\xF6\u011Fe", verb: "olmal\u0131" },
    set: { unit: "\xF6\u011Fe", verb: "olmal\u0131" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const FormatDictionary = {
    regex: "girdi",
    email: "e-posta adresi",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO tarih ve saat",
    date: "ISO tarih",
    time: "ISO saat",
    duration: "ISO s\xFCre",
    ipv4: "IPv4 adresi",
    ipv6: "IPv6 adresi",
    cidrv4: "IPv4 aral\u0131\u011F\u0131",
    cidrv6: "IPv6 aral\u0131\u011F\u0131",
    base64: "base64 ile \u015Fifrelenmi\u015F metin",
    base64url: "base64url ile \u015Fifrelenmi\u015F metin",
    json_string: "JSON dizesi",
    e164: "E.164 say\u0131s\u0131",
    jwt: "JWT",
    template_literal: "\u015Eablon dizesi"
  };
  const TypeDictionary = {
    nan: "NaN"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type": {
        const expected = TypeDictionary[issue2.expected] ?? issue2.expected;
        const receivedType = parsedType(issue2.input);
        const received = TypeDictionary[receivedType] ?? receivedType;
        if (/^[A-Z]/.test(issue2.expected)) {
          return `Ge\xE7ersiz de\u011Fer: beklenen instanceof ${issue2.expected}, al\u0131nan ${received}`;
        }
        return `Ge\xE7ersiz de\u011Fer: beklenen ${expected}, al\u0131nan ${received}`;
      }
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Ge\xE7ersiz de\u011Fer: beklenen ${stringifyPrimitive(issue2.values[0])}`;
        return `Ge\xE7ersiz se\xE7enek: a\u015Fa\u011F\u0131dakilerden biri olmal\u0131: ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `\xC7ok b\xFCy\xFCk: beklenen ${issue2.origin ?? "de\u011Fer"} ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "\xF6\u011Fe"}`;
        return `\xC7ok b\xFCy\xFCk: beklenen ${issue2.origin ?? "de\u011Fer"} ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `\xC7ok k\xFC\xE7\xFCk: beklenen ${issue2.origin} ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        return `\xC7ok k\xFC\xE7\xFCk: beklenen ${issue2.origin} ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Ge\xE7ersiz metin: "${_issue.prefix}" ile ba\u015Flamal\u0131`;
        if (_issue.format === "ends_with")
          return `Ge\xE7ersiz metin: "${_issue.suffix}" ile bitmeli`;
        if (_issue.format === "includes")
          return `Ge\xE7ersiz metin: "${_issue.includes}" i\xE7ermeli`;
        if (_issue.format === "regex")
          return `Ge\xE7ersiz metin: ${_issue.pattern} desenine uymal\u0131`;
        return `Ge\xE7ersiz ${FormatDictionary[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Ge\xE7ersiz say\u0131: ${issue2.divisor} ile tam b\xF6l\xFCnebilmeli`;
      case "unrecognized_keys":
        return `Tan\u0131nmayan anahtar${issue2.keys.length > 1 ? "lar" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `${issue2.origin} i\xE7inde ge\xE7ersiz anahtar`;
      case "invalid_union":
        return "Ge\xE7ersiz de\u011Fer";
      case "invalid_element":
        return `${issue2.origin} i\xE7inde ge\xE7ersiz de\u011Fer`;
      default:
        return `Ge\xE7ersiz de\u011Fer`;
    }
  };
};
function tr_default() {
  return {
    localeError: error40()
  };
}

// node_modules/zod/v4/locales/uk.js
var error41 = () => {
  const Sizable = {
    string: { unit: "\u0441\u0438\u043C\u0432\u043E\u043B\u0456\u0432", verb: "\u043C\u0430\u0442\u0438\u043C\u0435" },
    file: { unit: "\u0431\u0430\u0439\u0442\u0456\u0432", verb: "\u043C\u0430\u0442\u0438\u043C\u0435" },
    array: { unit: "\u0435\u043B\u0435\u043C\u0435\u043D\u0442\u0456\u0432", verb: "\u043C\u0430\u0442\u0438\u043C\u0435" },
    set: { unit: "\u0435\u043B\u0435\u043C\u0435\u043D\u0442\u0456\u0432", verb: "\u043C\u0430\u0442\u0438\u043C\u0435" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const FormatDictionary = {
    regex: "\u0432\u0445\u0456\u0434\u043D\u0456 \u0434\u0430\u043D\u0456",
    email: "\u0430\u0434\u0440\u0435\u0441\u0430 \u0435\u043B\u0435\u043A\u0442\u0440\u043E\u043D\u043D\u043E\u0457 \u043F\u043E\u0448\u0442\u0438",
    url: "URL",
    emoji: "\u0435\u043C\u043E\u0434\u0437\u0456",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "\u0434\u0430\u0442\u0430 \u0442\u0430 \u0447\u0430\u0441 ISO",
    date: "\u0434\u0430\u0442\u0430 ISO",
    time: "\u0447\u0430\u0441 ISO",
    duration: "\u0442\u0440\u0438\u0432\u0430\u043B\u0456\u0441\u0442\u044C ISO",
    ipv4: "\u0430\u0434\u0440\u0435\u0441\u0430 IPv4",
    ipv6: "\u0430\u0434\u0440\u0435\u0441\u0430 IPv6",
    cidrv4: "\u0434\u0456\u0430\u043F\u0430\u0437\u043E\u043D IPv4",
    cidrv6: "\u0434\u0456\u0430\u043F\u0430\u0437\u043E\u043D IPv6",
    base64: "\u0440\u044F\u0434\u043E\u043A \u0443 \u043A\u043E\u0434\u0443\u0432\u0430\u043D\u043D\u0456 base64",
    base64url: "\u0440\u044F\u0434\u043E\u043A \u0443 \u043A\u043E\u0434\u0443\u0432\u0430\u043D\u043D\u0456 base64url",
    json_string: "\u0440\u044F\u0434\u043E\u043A JSON",
    e164: "\u043D\u043E\u043C\u0435\u0440 E.164",
    jwt: "JWT",
    template_literal: "\u0432\u0445\u0456\u0434\u043D\u0456 \u0434\u0430\u043D\u0456"
  };
  const TypeDictionary = {
    nan: "NaN",
    number: "\u0447\u0438\u0441\u043B\u043E",
    array: "\u043C\u0430\u0441\u0438\u0432"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type": {
        const expected = TypeDictionary[issue2.expected] ?? issue2.expected;
        const receivedType = parsedType(issue2.input);
        const received = TypeDictionary[receivedType] ?? receivedType;
        if (/^[A-Z]/.test(issue2.expected)) {
          return `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0456 \u0432\u0445\u0456\u0434\u043D\u0456 \u0434\u0430\u043D\u0456: \u043E\u0447\u0456\u043A\u0443\u0454\u0442\u044C\u0441\u044F instanceof ${issue2.expected}, \u043E\u0442\u0440\u0438\u043C\u0430\u043D\u043E ${received}`;
        }
        return `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0456 \u0432\u0445\u0456\u0434\u043D\u0456 \u0434\u0430\u043D\u0456: \u043E\u0447\u0456\u043A\u0443\u0454\u0442\u044C\u0441\u044F ${expected}, \u043E\u0442\u0440\u0438\u043C\u0430\u043D\u043E ${received}`;
      }
      case "invalid_value":
        if (issue2.values.length === 1)
          return `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0456 \u0432\u0445\u0456\u0434\u043D\u0456 \u0434\u0430\u043D\u0456: \u043E\u0447\u0456\u043A\u0443\u0454\u0442\u044C\u0441\u044F ${stringifyPrimitive(issue2.values[0])}`;
        return `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0430 \u043E\u043F\u0446\u0456\u044F: \u043E\u0447\u0456\u043A\u0443\u0454\u0442\u044C\u0441\u044F \u043E\u0434\u043D\u0435 \u0437 ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `\u0417\u0430\u043D\u0430\u0434\u0442\u043E \u0432\u0435\u043B\u0438\u043A\u0435: \u043E\u0447\u0456\u043A\u0443\u0454\u0442\u044C\u0441\u044F, \u0449\u043E ${issue2.origin ?? "\u0437\u043D\u0430\u0447\u0435\u043D\u043D\u044F"} ${sizing.verb} ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "\u0435\u043B\u0435\u043C\u0435\u043D\u0442\u0456\u0432"}`;
        return `\u0417\u0430\u043D\u0430\u0434\u0442\u043E \u0432\u0435\u043B\u0438\u043A\u0435: \u043E\u0447\u0456\u043A\u0443\u0454\u0442\u044C\u0441\u044F, \u0449\u043E ${issue2.origin ?? "\u0437\u043D\u0430\u0447\u0435\u043D\u043D\u044F"} \u0431\u0443\u0434\u0435 ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `\u0417\u0430\u043D\u0430\u0434\u0442\u043E \u043C\u0430\u043B\u0435: \u043E\u0447\u0456\u043A\u0443\u0454\u0442\u044C\u0441\u044F, \u0449\u043E ${issue2.origin} ${sizing.verb} ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `\u0417\u0430\u043D\u0430\u0434\u0442\u043E \u043C\u0430\u043B\u0435: \u043E\u0447\u0456\u043A\u0443\u0454\u0442\u044C\u0441\u044F, \u0449\u043E ${issue2.origin} \u0431\u0443\u0434\u0435 ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0438\u0439 \u0440\u044F\u0434\u043E\u043A: \u043F\u043E\u0432\u0438\u043D\u0435\u043D \u043F\u043E\u0447\u0438\u043D\u0430\u0442\u0438\u0441\u044F \u0437 "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0438\u0439 \u0440\u044F\u0434\u043E\u043A: \u043F\u043E\u0432\u0438\u043D\u0435\u043D \u0437\u0430\u043A\u0456\u043D\u0447\u0443\u0432\u0430\u0442\u0438\u0441\u044F \u043D\u0430 "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0438\u0439 \u0440\u044F\u0434\u043E\u043A: \u043F\u043E\u0432\u0438\u043D\u0435\u043D \u043C\u0456\u0441\u0442\u0438\u0442\u0438 "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0438\u0439 \u0440\u044F\u0434\u043E\u043A: \u043F\u043E\u0432\u0438\u043D\u0435\u043D \u0432\u0456\u0434\u043F\u043E\u0432\u0456\u0434\u0430\u0442\u0438 \u0448\u0430\u0431\u043B\u043E\u043D\u0443 ${_issue.pattern}`;
        return `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0438\u0439 ${FormatDictionary[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0435 \u0447\u0438\u0441\u043B\u043E: \u043F\u043E\u0432\u0438\u043D\u043D\u043E \u0431\u0443\u0442\u0438 \u043A\u0440\u0430\u0442\u043D\u0438\u043C ${issue2.divisor}`;
      case "unrecognized_keys":
        return `\u041D\u0435\u0440\u043E\u0437\u043F\u0456\u0437\u043D\u0430\u043D\u0438\u0439 \u043A\u043B\u044E\u0447${issue2.keys.length > 1 ? "\u0456" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0438\u0439 \u043A\u043B\u044E\u0447 \u0443 ${issue2.origin}`;
      case "invalid_union":
        return "\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0456 \u0432\u0445\u0456\u0434\u043D\u0456 \u0434\u0430\u043D\u0456";
      case "invalid_element":
        return `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0435 \u0437\u043D\u0430\u0447\u0435\u043D\u043D\u044F \u0443 ${issue2.origin}`;
      default:
        return `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0456 \u0432\u0445\u0456\u0434\u043D\u0456 \u0434\u0430\u043D\u0456`;
    }
  };
};
function uk_default() {
  return {
    localeError: error41()
  };
}

// node_modules/zod/v4/locales/ua.js
function ua_default() {
  return uk_default();
}

// node_modules/zod/v4/locales/ur.js
var error42 = () => {
  const Sizable = {
    string: { unit: "\u062D\u0631\u0648\u0641", verb: "\u06C1\u0648\u0646\u0627" },
    file: { unit: "\u0628\u0627\u0626\u0679\u0633", verb: "\u06C1\u0648\u0646\u0627" },
    array: { unit: "\u0622\u0626\u0679\u0645\u0632", verb: "\u06C1\u0648\u0646\u0627" },
    set: { unit: "\u0622\u0626\u0679\u0645\u0632", verb: "\u06C1\u0648\u0646\u0627" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const FormatDictionary = {
    regex: "\u0627\u0646 \u067E\u0679",
    email: "\u0627\u06CC \u0645\u06CC\u0644 \u0627\u06CC\u0688\u0631\u06CC\u0633",
    url: "\u06CC\u0648 \u0622\u0631 \u0627\u06CC\u0644",
    emoji: "\u0627\u06CC\u0645\u0648\u062C\u06CC",
    uuid: "\u06CC\u0648 \u06CC\u0648 \u0622\u0626\u06CC \u0688\u06CC",
    uuidv4: "\u06CC\u0648 \u06CC\u0648 \u0622\u0626\u06CC \u0688\u06CC \u0648\u06CC 4",
    uuidv6: "\u06CC\u0648 \u06CC\u0648 \u0622\u0626\u06CC \u0688\u06CC \u0648\u06CC 6",
    nanoid: "\u0646\u06CC\u0646\u0648 \u0622\u0626\u06CC \u0688\u06CC",
    guid: "\u062C\u06CC \u06CC\u0648 \u0622\u0626\u06CC \u0688\u06CC",
    cuid: "\u0633\u06CC \u06CC\u0648 \u0622\u0626\u06CC \u0688\u06CC",
    cuid2: "\u0633\u06CC \u06CC\u0648 \u0622\u0626\u06CC \u0688\u06CC 2",
    ulid: "\u06CC\u0648 \u0627\u06CC\u0644 \u0622\u0626\u06CC \u0688\u06CC",
    xid: "\u0627\u06CC\u06A9\u0633 \u0622\u0626\u06CC \u0688\u06CC",
    ksuid: "\u06A9\u06D2 \u0627\u06CC\u0633 \u06CC\u0648 \u0622\u0626\u06CC \u0688\u06CC",
    datetime: "\u0622\u0626\u06CC \u0627\u06CC\u0633 \u0627\u0648 \u0688\u06CC\u0679 \u0679\u0627\u0626\u0645",
    date: "\u0622\u0626\u06CC \u0627\u06CC\u0633 \u0627\u0648 \u062A\u0627\u0631\u06CC\u062E",
    time: "\u0622\u0626\u06CC \u0627\u06CC\u0633 \u0627\u0648 \u0648\u0642\u062A",
    duration: "\u0622\u0626\u06CC \u0627\u06CC\u0633 \u0627\u0648 \u0645\u062F\u062A",
    ipv4: "\u0622\u0626\u06CC \u067E\u06CC \u0648\u06CC 4 \u0627\u06CC\u0688\u0631\u06CC\u0633",
    ipv6: "\u0622\u0626\u06CC \u067E\u06CC \u0648\u06CC 6 \u0627\u06CC\u0688\u0631\u06CC\u0633",
    cidrv4: "\u0622\u0626\u06CC \u067E\u06CC \u0648\u06CC 4 \u0631\u06CC\u0646\u062C",
    cidrv6: "\u0622\u0626\u06CC \u067E\u06CC \u0648\u06CC 6 \u0631\u06CC\u0646\u062C",
    base64: "\u0628\u06CC\u0633 64 \u0627\u0646 \u06A9\u0648\u0688\u0688 \u0633\u0679\u0631\u0646\u06AF",
    base64url: "\u0628\u06CC\u0633 64 \u06CC\u0648 \u0622\u0631 \u0627\u06CC\u0644 \u0627\u0646 \u06A9\u0648\u0688\u0688 \u0633\u0679\u0631\u0646\u06AF",
    json_string: "\u062C\u06D2 \u0627\u06CC\u0633 \u0627\u0648 \u0627\u06CC\u0646 \u0633\u0679\u0631\u0646\u06AF",
    e164: "\u0627\u06CC 164 \u0646\u0645\u0628\u0631",
    jwt: "\u062C\u06D2 \u0688\u0628\u0644\u06CC\u0648 \u0679\u06CC",
    template_literal: "\u0627\u0646 \u067E\u0679"
  };
  const TypeDictionary = {
    nan: "NaN",
    number: "\u0646\u0645\u0628\u0631",
    array: "\u0622\u0631\u06D2",
    null: "\u0646\u0644"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type": {
        const expected = TypeDictionary[issue2.expected] ?? issue2.expected;
        const receivedType = parsedType(issue2.input);
        const received = TypeDictionary[receivedType] ?? receivedType;
        if (/^[A-Z]/.test(issue2.expected)) {
          return `\u063A\u0644\u0637 \u0627\u0646 \u067E\u0679: instanceof ${issue2.expected} \u0645\u062A\u0648\u0642\u0639 \u062A\u06BE\u0627\u060C ${received} \u0645\u0648\u0635\u0648\u0644 \u06C1\u0648\u0627`;
        }
        return `\u063A\u0644\u0637 \u0627\u0646 \u067E\u0679: ${expected} \u0645\u062A\u0648\u0642\u0639 \u062A\u06BE\u0627\u060C ${received} \u0645\u0648\u0635\u0648\u0644 \u06C1\u0648\u0627`;
      }
      case "invalid_value":
        if (issue2.values.length === 1)
          return `\u063A\u0644\u0637 \u0627\u0646 \u067E\u0679: ${stringifyPrimitive(issue2.values[0])} \u0645\u062A\u0648\u0642\u0639 \u062A\u06BE\u0627`;
        return `\u063A\u0644\u0637 \u0622\u067E\u0634\u0646: ${joinValues(issue2.values, "|")} \u0645\u06CC\u06BA \u0633\u06D2 \u0627\u06CC\u06A9 \u0645\u062A\u0648\u0642\u0639 \u062A\u06BE\u0627`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `\u0628\u06C1\u062A \u0628\u0691\u0627: ${issue2.origin ?? "\u0648\u06CC\u0644\u06CC\u0648"} \u06A9\u06D2 ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "\u0639\u0646\u0627\u0635\u0631"} \u06C1\u0648\u0646\u06D2 \u0645\u062A\u0648\u0642\u0639 \u062A\u06BE\u06D2`;
        return `\u0628\u06C1\u062A \u0628\u0691\u0627: ${issue2.origin ?? "\u0648\u06CC\u0644\u06CC\u0648"} \u06A9\u0627 ${adj}${issue2.maximum.toString()} \u06C1\u0648\u0646\u0627 \u0645\u062A\u0648\u0642\u0639 \u062A\u06BE\u0627`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `\u0628\u06C1\u062A \u0686\u06BE\u0648\u0679\u0627: ${issue2.origin} \u06A9\u06D2 ${adj}${issue2.minimum.toString()} ${sizing.unit} \u06C1\u0648\u0646\u06D2 \u0645\u062A\u0648\u0642\u0639 \u062A\u06BE\u06D2`;
        }
        return `\u0628\u06C1\u062A \u0686\u06BE\u0648\u0679\u0627: ${issue2.origin} \u06A9\u0627 ${adj}${issue2.minimum.toString()} \u06C1\u0648\u0646\u0627 \u0645\u062A\u0648\u0642\u0639 \u062A\u06BE\u0627`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `\u063A\u0644\u0637 \u0633\u0679\u0631\u0646\u06AF: "${_issue.prefix}" \u0633\u06D2 \u0634\u0631\u0648\u0639 \u06C1\u0648\u0646\u0627 \u0686\u0627\u06C1\u06CC\u06D2`;
        }
        if (_issue.format === "ends_with")
          return `\u063A\u0644\u0637 \u0633\u0679\u0631\u0646\u06AF: "${_issue.suffix}" \u067E\u0631 \u062E\u062A\u0645 \u06C1\u0648\u0646\u0627 \u0686\u0627\u06C1\u06CC\u06D2`;
        if (_issue.format === "includes")
          return `\u063A\u0644\u0637 \u0633\u0679\u0631\u0646\u06AF: "${_issue.includes}" \u0634\u0627\u0645\u0644 \u06C1\u0648\u0646\u0627 \u0686\u0627\u06C1\u06CC\u06D2`;
        if (_issue.format === "regex")
          return `\u063A\u0644\u0637 \u0633\u0679\u0631\u0646\u06AF: \u067E\u06CC\u0679\u0631\u0646 ${_issue.pattern} \u0633\u06D2 \u0645\u06CC\u0686 \u06C1\u0648\u0646\u0627 \u0686\u0627\u06C1\u06CC\u06D2`;
        return `\u063A\u0644\u0637 ${FormatDictionary[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `\u063A\u0644\u0637 \u0646\u0645\u0628\u0631: ${issue2.divisor} \u06A9\u0627 \u0645\u0636\u0627\u0639\u0641 \u06C1\u0648\u0646\u0627 \u0686\u0627\u06C1\u06CC\u06D2`;
      case "unrecognized_keys":
        return `\u063A\u06CC\u0631 \u062A\u0633\u0644\u06CC\u0645 \u0634\u062F\u06C1 \u06A9\u06CC${issue2.keys.length > 1 ? "\u0632" : ""}: ${joinValues(issue2.keys, "\u060C ")}`;
      case "invalid_key":
        return `${issue2.origin} \u0645\u06CC\u06BA \u063A\u0644\u0637 \u06A9\u06CC`;
      case "invalid_union":
        return "\u063A\u0644\u0637 \u0627\u0646 \u067E\u0679";
      case "invalid_element":
        return `${issue2.origin} \u0645\u06CC\u06BA \u063A\u0644\u0637 \u0648\u06CC\u0644\u06CC\u0648`;
      default:
        return `\u063A\u0644\u0637 \u0627\u0646 \u067E\u0679`;
    }
  };
};
function ur_default() {
  return {
    localeError: error42()
  };
}

// node_modules/zod/v4/locales/uz.js
var error43 = () => {
  const Sizable = {
    string: { unit: "belgi", verb: "bo\u2018lishi kerak" },
    file: { unit: "bayt", verb: "bo\u2018lishi kerak" },
    array: { unit: "element", verb: "bo\u2018lishi kerak" },
    set: { unit: "element", verb: "bo\u2018lishi kerak" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const FormatDictionary = {
    regex: "kirish",
    email: "elektron pochta manzili",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO sana va vaqti",
    date: "ISO sana",
    time: "ISO vaqt",
    duration: "ISO davomiylik",
    ipv4: "IPv4 manzil",
    ipv6: "IPv6 manzil",
    mac: "MAC manzil",
    cidrv4: "IPv4 diapazon",
    cidrv6: "IPv6 diapazon",
    base64: "base64 kodlangan satr",
    base64url: "base64url kodlangan satr",
    json_string: "JSON satr",
    e164: "E.164 raqam",
    jwt: "JWT",
    template_literal: "kirish"
  };
  const TypeDictionary = {
    nan: "NaN",
    number: "raqam",
    array: "massiv"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type": {
        const expected = TypeDictionary[issue2.expected] ?? issue2.expected;
        const receivedType = parsedType(issue2.input);
        const received = TypeDictionary[receivedType] ?? receivedType;
        if (/^[A-Z]/.test(issue2.expected)) {
          return `Noto\u2018g\u2018ri kirish: kutilgan instanceof ${issue2.expected}, qabul qilingan ${received}`;
        }
        return `Noto\u2018g\u2018ri kirish: kutilgan ${expected}, qabul qilingan ${received}`;
      }
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Noto\u2018g\u2018ri kirish: kutilgan ${stringifyPrimitive(issue2.values[0])}`;
        return `Noto\u2018g\u2018ri variant: quyidagilardan biri kutilgan ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Juda katta: kutilgan ${issue2.origin ?? "qiymat"} ${adj}${issue2.maximum.toString()} ${sizing.unit} ${sizing.verb}`;
        return `Juda katta: kutilgan ${issue2.origin ?? "qiymat"} ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Juda kichik: kutilgan ${issue2.origin} ${adj}${issue2.minimum.toString()} ${sizing.unit} ${sizing.verb}`;
        }
        return `Juda kichik: kutilgan ${issue2.origin} ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Noto\u2018g\u2018ri satr: "${_issue.prefix}" bilan boshlanishi kerak`;
        if (_issue.format === "ends_with")
          return `Noto\u2018g\u2018ri satr: "${_issue.suffix}" bilan tugashi kerak`;
        if (_issue.format === "includes")
          return `Noto\u2018g\u2018ri satr: "${_issue.includes}" ni o\u2018z ichiga olishi kerak`;
        if (_issue.format === "regex")
          return `Noto\u2018g\u2018ri satr: ${_issue.pattern} shabloniga mos kelishi kerak`;
        return `Noto\u2018g\u2018ri ${FormatDictionary[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Noto\u2018g\u2018ri raqam: ${issue2.divisor} ning karralisi bo\u2018lishi kerak`;
      case "unrecognized_keys":
        return `Noma\u2019lum kalit${issue2.keys.length > 1 ? "lar" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `${issue2.origin} dagi kalit noto\u2018g\u2018ri`;
      case "invalid_union":
        return "Noto\u2018g\u2018ri kirish";
      case "invalid_element":
        return `${issue2.origin} da noto\u2018g\u2018ri qiymat`;
      default:
        return `Noto\u2018g\u2018ri kirish`;
    }
  };
};
function uz_default() {
  return {
    localeError: error43()
  };
}

// node_modules/zod/v4/locales/vi.js
var error44 = () => {
  const Sizable = {
    string: { unit: "k\xFD t\u1EF1", verb: "c\xF3" },
    file: { unit: "byte", verb: "c\xF3" },
    array: { unit: "ph\u1EA7n t\u1EED", verb: "c\xF3" },
    set: { unit: "ph\u1EA7n t\u1EED", verb: "c\xF3" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const FormatDictionary = {
    regex: "\u0111\u1EA7u v\xE0o",
    email: "\u0111\u1ECBa ch\u1EC9 email",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ng\xE0y gi\u1EDD ISO",
    date: "ng\xE0y ISO",
    time: "gi\u1EDD ISO",
    duration: "kho\u1EA3ng th\u1EDDi gian ISO",
    ipv4: "\u0111\u1ECBa ch\u1EC9 IPv4",
    ipv6: "\u0111\u1ECBa ch\u1EC9 IPv6",
    cidrv4: "d\u1EA3i IPv4",
    cidrv6: "d\u1EA3i IPv6",
    base64: "chu\u1ED7i m\xE3 h\xF3a base64",
    base64url: "chu\u1ED7i m\xE3 h\xF3a base64url",
    json_string: "chu\u1ED7i JSON",
    e164: "s\u1ED1 E.164",
    jwt: "JWT",
    template_literal: "\u0111\u1EA7u v\xE0o"
  };
  const TypeDictionary = {
    nan: "NaN",
    number: "s\u1ED1",
    array: "m\u1EA3ng"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type": {
        const expected = TypeDictionary[issue2.expected] ?? issue2.expected;
        const receivedType = parsedType(issue2.input);
        const received = TypeDictionary[receivedType] ?? receivedType;
        if (/^[A-Z]/.test(issue2.expected)) {
          return `\u0110\u1EA7u v\xE0o kh\xF4ng h\u1EE3p l\u1EC7: mong \u0111\u1EE3i instanceof ${issue2.expected}, nh\u1EADn \u0111\u01B0\u1EE3c ${received}`;
        }
        return `\u0110\u1EA7u v\xE0o kh\xF4ng h\u1EE3p l\u1EC7: mong \u0111\u1EE3i ${expected}, nh\u1EADn \u0111\u01B0\u1EE3c ${received}`;
      }
      case "invalid_value":
        if (issue2.values.length === 1)
          return `\u0110\u1EA7u v\xE0o kh\xF4ng h\u1EE3p l\u1EC7: mong \u0111\u1EE3i ${stringifyPrimitive(issue2.values[0])}`;
        return `T\xF9y ch\u1ECDn kh\xF4ng h\u1EE3p l\u1EC7: mong \u0111\u1EE3i m\u1ED9t trong c\xE1c gi\xE1 tr\u1ECB ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Qu\xE1 l\u1EDBn: mong \u0111\u1EE3i ${issue2.origin ?? "gi\xE1 tr\u1ECB"} ${sizing.verb} ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "ph\u1EA7n t\u1EED"}`;
        return `Qu\xE1 l\u1EDBn: mong \u0111\u1EE3i ${issue2.origin ?? "gi\xE1 tr\u1ECB"} ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Qu\xE1 nh\u1ECF: mong \u0111\u1EE3i ${issue2.origin} ${sizing.verb} ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `Qu\xE1 nh\u1ECF: mong \u0111\u1EE3i ${issue2.origin} ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Chu\u1ED7i kh\xF4ng h\u1EE3p l\u1EC7: ph\u1EA3i b\u1EAFt \u0111\u1EA7u b\u1EB1ng "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Chu\u1ED7i kh\xF4ng h\u1EE3p l\u1EC7: ph\u1EA3i k\u1EBFt th\xFAc b\u1EB1ng "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Chu\u1ED7i kh\xF4ng h\u1EE3p l\u1EC7: ph\u1EA3i bao g\u1ED3m "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Chu\u1ED7i kh\xF4ng h\u1EE3p l\u1EC7: ph\u1EA3i kh\u1EDBp v\u1EDBi m\u1EABu ${_issue.pattern}`;
        return `${FormatDictionary[_issue.format] ?? issue2.format} kh\xF4ng h\u1EE3p l\u1EC7`;
      }
      case "not_multiple_of":
        return `S\u1ED1 kh\xF4ng h\u1EE3p l\u1EC7: ph\u1EA3i l\xE0 b\u1ED9i s\u1ED1 c\u1EE7a ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Kh\xF3a kh\xF4ng \u0111\u01B0\u1EE3c nh\u1EADn d\u1EA1ng: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Kh\xF3a kh\xF4ng h\u1EE3p l\u1EC7 trong ${issue2.origin}`;
      case "invalid_union":
        return "\u0110\u1EA7u v\xE0o kh\xF4ng h\u1EE3p l\u1EC7";
      case "invalid_element":
        return `Gi\xE1 tr\u1ECB kh\xF4ng h\u1EE3p l\u1EC7 trong ${issue2.origin}`;
      default:
        return `\u0110\u1EA7u v\xE0o kh\xF4ng h\u1EE3p l\u1EC7`;
    }
  };
};
function vi_default() {
  return {
    localeError: error44()
  };
}

// node_modules/zod/v4/locales/zh-CN.js
var error45 = () => {
  const Sizable = {
    string: { unit: "\u5B57\u7B26", verb: "\u5305\u542B" },
    file: { unit: "\u5B57\u8282", verb: "\u5305\u542B" },
    array: { unit: "\u9879", verb: "\u5305\u542B" },
    set: { unit: "\u9879", verb: "\u5305\u542B" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const FormatDictionary = {
    regex: "\u8F93\u5165",
    email: "\u7535\u5B50\u90AE\u4EF6",
    url: "URL",
    emoji: "\u8868\u60C5\u7B26\u53F7",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO\u65E5\u671F\u65F6\u95F4",
    date: "ISO\u65E5\u671F",
    time: "ISO\u65F6\u95F4",
    duration: "ISO\u65F6\u957F",
    ipv4: "IPv4\u5730\u5740",
    ipv6: "IPv6\u5730\u5740",
    cidrv4: "IPv4\u7F51\u6BB5",
    cidrv6: "IPv6\u7F51\u6BB5",
    base64: "base64\u7F16\u7801\u5B57\u7B26\u4E32",
    base64url: "base64url\u7F16\u7801\u5B57\u7B26\u4E32",
    json_string: "JSON\u5B57\u7B26\u4E32",
    e164: "E.164\u53F7\u7801",
    jwt: "JWT",
    template_literal: "\u8F93\u5165"
  };
  const TypeDictionary = {
    nan: "NaN",
    number: "\u6570\u5B57",
    array: "\u6570\u7EC4",
    null: "\u7A7A\u503C(null)"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type": {
        const expected = TypeDictionary[issue2.expected] ?? issue2.expected;
        const receivedType = parsedType(issue2.input);
        const received = TypeDictionary[receivedType] ?? receivedType;
        if (/^[A-Z]/.test(issue2.expected)) {
          return `\u65E0\u6548\u8F93\u5165\uFF1A\u671F\u671B instanceof ${issue2.expected}\uFF0C\u5B9E\u9645\u63A5\u6536 ${received}`;
        }
        return `\u65E0\u6548\u8F93\u5165\uFF1A\u671F\u671B ${expected}\uFF0C\u5B9E\u9645\u63A5\u6536 ${received}`;
      }
      case "invalid_value":
        if (issue2.values.length === 1)
          return `\u65E0\u6548\u8F93\u5165\uFF1A\u671F\u671B ${stringifyPrimitive(issue2.values[0])}`;
        return `\u65E0\u6548\u9009\u9879\uFF1A\u671F\u671B\u4EE5\u4E0B\u4E4B\u4E00 ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `\u6570\u503C\u8FC7\u5927\uFF1A\u671F\u671B ${issue2.origin ?? "\u503C"} ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "\u4E2A\u5143\u7D20"}`;
        return `\u6570\u503C\u8FC7\u5927\uFF1A\u671F\u671B ${issue2.origin ?? "\u503C"} ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `\u6570\u503C\u8FC7\u5C0F\uFF1A\u671F\u671B ${issue2.origin} ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `\u6570\u503C\u8FC7\u5C0F\uFF1A\u671F\u671B ${issue2.origin} ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `\u65E0\u6548\u5B57\u7B26\u4E32\uFF1A\u5FC5\u987B\u4EE5 "${_issue.prefix}" \u5F00\u5934`;
        if (_issue.format === "ends_with")
          return `\u65E0\u6548\u5B57\u7B26\u4E32\uFF1A\u5FC5\u987B\u4EE5 "${_issue.suffix}" \u7ED3\u5C3E`;
        if (_issue.format === "includes")
          return `\u65E0\u6548\u5B57\u7B26\u4E32\uFF1A\u5FC5\u987B\u5305\u542B "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `\u65E0\u6548\u5B57\u7B26\u4E32\uFF1A\u5FC5\u987B\u6EE1\u8DB3\u6B63\u5219\u8868\u8FBE\u5F0F ${_issue.pattern}`;
        return `\u65E0\u6548${FormatDictionary[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `\u65E0\u6548\u6570\u5B57\uFF1A\u5FC5\u987B\u662F ${issue2.divisor} \u7684\u500D\u6570`;
      case "unrecognized_keys":
        return `\u51FA\u73B0\u672A\u77E5\u7684\u952E(key): ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `${issue2.origin} \u4E2D\u7684\u952E(key)\u65E0\u6548`;
      case "invalid_union":
        return "\u65E0\u6548\u8F93\u5165";
      case "invalid_element":
        return `${issue2.origin} \u4E2D\u5305\u542B\u65E0\u6548\u503C(value)`;
      default:
        return `\u65E0\u6548\u8F93\u5165`;
    }
  };
};
function zh_CN_default() {
  return {
    localeError: error45()
  };
}

// node_modules/zod/v4/locales/zh-TW.js
var error46 = () => {
  const Sizable = {
    string: { unit: "\u5B57\u5143", verb: "\u64C1\u6709" },
    file: { unit: "\u4F4D\u5143\u7D44", verb: "\u64C1\u6709" },
    array: { unit: "\u9805\u76EE", verb: "\u64C1\u6709" },
    set: { unit: "\u9805\u76EE", verb: "\u64C1\u6709" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const FormatDictionary = {
    regex: "\u8F38\u5165",
    email: "\u90F5\u4EF6\u5730\u5740",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO \u65E5\u671F\u6642\u9593",
    date: "ISO \u65E5\u671F",
    time: "ISO \u6642\u9593",
    duration: "ISO \u671F\u9593",
    ipv4: "IPv4 \u4F4D\u5740",
    ipv6: "IPv6 \u4F4D\u5740",
    cidrv4: "IPv4 \u7BC4\u570D",
    cidrv6: "IPv6 \u7BC4\u570D",
    base64: "base64 \u7DE8\u78BC\u5B57\u4E32",
    base64url: "base64url \u7DE8\u78BC\u5B57\u4E32",
    json_string: "JSON \u5B57\u4E32",
    e164: "E.164 \u6578\u503C",
    jwt: "JWT",
    template_literal: "\u8F38\u5165"
  };
  const TypeDictionary = {
    nan: "NaN"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type": {
        const expected = TypeDictionary[issue2.expected] ?? issue2.expected;
        const receivedType = parsedType(issue2.input);
        const received = TypeDictionary[receivedType] ?? receivedType;
        if (/^[A-Z]/.test(issue2.expected)) {
          return `\u7121\u6548\u7684\u8F38\u5165\u503C\uFF1A\u9810\u671F\u70BA instanceof ${issue2.expected}\uFF0C\u4F46\u6536\u5230 ${received}`;
        }
        return `\u7121\u6548\u7684\u8F38\u5165\u503C\uFF1A\u9810\u671F\u70BA ${expected}\uFF0C\u4F46\u6536\u5230 ${received}`;
      }
      case "invalid_value":
        if (issue2.values.length === 1)
          return `\u7121\u6548\u7684\u8F38\u5165\u503C\uFF1A\u9810\u671F\u70BA ${stringifyPrimitive(issue2.values[0])}`;
        return `\u7121\u6548\u7684\u9078\u9805\uFF1A\u9810\u671F\u70BA\u4EE5\u4E0B\u5176\u4E2D\u4E4B\u4E00 ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `\u6578\u503C\u904E\u5927\uFF1A\u9810\u671F ${issue2.origin ?? "\u503C"} \u61C9\u70BA ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "\u500B\u5143\u7D20"}`;
        return `\u6578\u503C\u904E\u5927\uFF1A\u9810\u671F ${issue2.origin ?? "\u503C"} \u61C9\u70BA ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `\u6578\u503C\u904E\u5C0F\uFF1A\u9810\u671F ${issue2.origin} \u61C9\u70BA ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `\u6578\u503C\u904E\u5C0F\uFF1A\u9810\u671F ${issue2.origin} \u61C9\u70BA ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `\u7121\u6548\u7684\u5B57\u4E32\uFF1A\u5FC5\u9808\u4EE5 "${_issue.prefix}" \u958B\u982D`;
        }
        if (_issue.format === "ends_with")
          return `\u7121\u6548\u7684\u5B57\u4E32\uFF1A\u5FC5\u9808\u4EE5 "${_issue.suffix}" \u7D50\u5C3E`;
        if (_issue.format === "includes")
          return `\u7121\u6548\u7684\u5B57\u4E32\uFF1A\u5FC5\u9808\u5305\u542B "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `\u7121\u6548\u7684\u5B57\u4E32\uFF1A\u5FC5\u9808\u7B26\u5408\u683C\u5F0F ${_issue.pattern}`;
        return `\u7121\u6548\u7684 ${FormatDictionary[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `\u7121\u6548\u7684\u6578\u5B57\uFF1A\u5FC5\u9808\u70BA ${issue2.divisor} \u7684\u500D\u6578`;
      case "unrecognized_keys":
        return `\u7121\u6CD5\u8B58\u5225\u7684\u9375\u503C${issue2.keys.length > 1 ? "\u5011" : ""}\uFF1A${joinValues(issue2.keys, "\u3001")}`;
      case "invalid_key":
        return `${issue2.origin} \u4E2D\u6709\u7121\u6548\u7684\u9375\u503C`;
      case "invalid_union":
        return "\u7121\u6548\u7684\u8F38\u5165\u503C";
      case "invalid_element":
        return `${issue2.origin} \u4E2D\u6709\u7121\u6548\u7684\u503C`;
      default:
        return `\u7121\u6548\u7684\u8F38\u5165\u503C`;
    }
  };
};
function zh_TW_default() {
  return {
    localeError: error46()
  };
}

// node_modules/zod/v4/locales/yo.js
var error47 = () => {
  const Sizable = {
    string: { unit: "\xE0mi", verb: "n\xED" },
    file: { unit: "bytes", verb: "n\xED" },
    array: { unit: "nkan", verb: "n\xED" },
    set: { unit: "nkan", verb: "n\xED" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const FormatDictionary = {
    regex: "\u1EB9\u0300r\u1ECD \xECb\xE1w\u1ECDl\xE9",
    email: "\xE0d\xEDr\u1EB9\u0301s\xEC \xECm\u1EB9\u0301l\xEC",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "\xE0k\xF3k\xF2 ISO",
    date: "\u1ECDj\u1ECD\u0301 ISO",
    time: "\xE0k\xF3k\xF2 ISO",
    duration: "\xE0k\xF3k\xF2 t\xF3 p\xE9 ISO",
    ipv4: "\xE0d\xEDr\u1EB9\u0301s\xEC IPv4",
    ipv6: "\xE0d\xEDr\u1EB9\u0301s\xEC IPv6",
    cidrv4: "\xE0gb\xE8gb\xE8 IPv4",
    cidrv6: "\xE0gb\xE8gb\xE8 IPv6",
    base64: "\u1ECD\u0300r\u1ECD\u0300 t\xED a k\u1ECD\u0301 n\xED base64",
    base64url: "\u1ECD\u0300r\u1ECD\u0300 base64url",
    json_string: "\u1ECD\u0300r\u1ECD\u0300 JSON",
    e164: "n\u1ECD\u0301mb\xE0 E.164",
    jwt: "JWT",
    template_literal: "\u1EB9\u0300r\u1ECD \xECb\xE1w\u1ECDl\xE9"
  };
  const TypeDictionary = {
    nan: "NaN",
    number: "n\u1ECD\u0301mb\xE0",
    array: "akop\u1ECD"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type": {
        const expected = TypeDictionary[issue2.expected] ?? issue2.expected;
        const receivedType = parsedType(issue2.input);
        const received = TypeDictionary[receivedType] ?? receivedType;
        if (/^[A-Z]/.test(issue2.expected)) {
          return `\xCCb\xE1w\u1ECDl\xE9 a\u1E63\xEC\u1E63e: a n\xED l\xE1ti fi instanceof ${issue2.expected}, \xE0m\u1ECD\u0300 a r\xED ${received}`;
        }
        return `\xCCb\xE1w\u1ECDl\xE9 a\u1E63\xEC\u1E63e: a n\xED l\xE1ti fi ${expected}, \xE0m\u1ECD\u0300 a r\xED ${received}`;
      }
      case "invalid_value":
        if (issue2.values.length === 1)
          return `\xCCb\xE1w\u1ECDl\xE9 a\u1E63\xEC\u1E63e: a n\xED l\xE1ti fi ${stringifyPrimitive(issue2.values[0])}`;
        return `\xC0\u1E63\xE0y\xE0n a\u1E63\xEC\u1E63e: yan \u1ECD\u0300kan l\xE1ra ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `T\xF3 p\u1ECD\u0300 j\xF9: a n\xED l\xE1ti j\u1EB9\u0301 p\xE9 ${issue2.origin ?? "iye"} ${sizing.verb} ${adj}${issue2.maximum} ${sizing.unit}`;
        return `T\xF3 p\u1ECD\u0300 j\xF9: a n\xED l\xE1ti j\u1EB9\u0301 ${adj}${issue2.maximum}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `K\xE9r\xE9 ju: a n\xED l\xE1ti j\u1EB9\u0301 p\xE9 ${issue2.origin} ${sizing.verb} ${adj}${issue2.minimum} ${sizing.unit}`;
        return `K\xE9r\xE9 ju: a n\xED l\xE1ti j\u1EB9\u0301 ${adj}${issue2.minimum}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `\u1ECC\u0300r\u1ECD\u0300 a\u1E63\xEC\u1E63e: gb\u1ECD\u0301d\u1ECD\u0300 b\u1EB9\u0300r\u1EB9\u0300 p\u1EB9\u0300l\xFA "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `\u1ECC\u0300r\u1ECD\u0300 a\u1E63\xEC\u1E63e: gb\u1ECD\u0301d\u1ECD\u0300 par\xED p\u1EB9\u0300l\xFA "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `\u1ECC\u0300r\u1ECD\u0300 a\u1E63\xEC\u1E63e: gb\u1ECD\u0301d\u1ECD\u0300 n\xED "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `\u1ECC\u0300r\u1ECD\u0300 a\u1E63\xEC\u1E63e: gb\u1ECD\u0301d\u1ECD\u0300 b\xE1 \xE0p\u1EB9\u1EB9r\u1EB9 mu ${_issue.pattern}`;
        return `A\u1E63\xEC\u1E63e: ${FormatDictionary[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `N\u1ECD\u0301mb\xE0 a\u1E63\xEC\u1E63e: gb\u1ECD\u0301d\u1ECD\u0300 j\u1EB9\u0301 \xE8y\xE0 p\xEDp\xEDn ti ${issue2.divisor}`;
      case "unrecognized_keys":
        return `B\u1ECDt\xECn\xEC \xE0\xECm\u1ECD\u0300: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `B\u1ECDt\xECn\xEC a\u1E63\xEC\u1E63e n\xEDn\xFA ${issue2.origin}`;
      case "invalid_union":
        return "\xCCb\xE1w\u1ECDl\xE9 a\u1E63\xEC\u1E63e";
      case "invalid_element":
        return `Iye a\u1E63\xEC\u1E63e n\xEDn\xFA ${issue2.origin}`;
      default:
        return "\xCCb\xE1w\u1ECDl\xE9 a\u1E63\xEC\u1E63e";
    }
  };
};
function yo_default() {
  return {
    localeError: error47()
  };
}

// node_modules/zod/v4/core/registries.js
var _a;
var $output = /* @__PURE__ */ Symbol("ZodOutput");
var $input = /* @__PURE__ */ Symbol("ZodInput");
var $ZodRegistry = class {
  constructor() {
    this._map = /* @__PURE__ */ new WeakMap();
    this._idmap = /* @__PURE__ */ new Map();
  }
  add(schema, ..._meta) {
    const meta3 = _meta[0];
    this._map.set(schema, meta3);
    if (meta3 && typeof meta3 === "object" && "id" in meta3) {
      this._idmap.set(meta3.id, schema);
    }
    return this;
  }
  clear() {
    this._map = /* @__PURE__ */ new WeakMap();
    this._idmap = /* @__PURE__ */ new Map();
    return this;
  }
  remove(schema) {
    const meta3 = this._map.get(schema);
    if (meta3 && typeof meta3 === "object" && "id" in meta3) {
      this._idmap.delete(meta3.id);
    }
    this._map.delete(schema);
    return this;
  }
  get(schema) {
    const p = schema._zod.parent;
    if (p) {
      const pm = { ...this.get(p) ?? {} };
      delete pm.id;
      const f = { ...pm, ...this._map.get(schema) };
      return Object.keys(f).length ? f : void 0;
    }
    return this._map.get(schema);
  }
  has(schema) {
    return this._map.has(schema);
  }
};
function registry() {
  return new $ZodRegistry();
}
(_a = globalThis).__zod_globalRegistry ?? (_a.__zod_globalRegistry = registry());
var globalRegistry = globalThis.__zod_globalRegistry;

// node_modules/zod/v4/core/api.js
// @__NO_SIDE_EFFECTS__
function _string(Class2, params) {
  return new Class2({
    type: "string",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _coercedString(Class2, params) {
  return new Class2({
    type: "string",
    coerce: true,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _email(Class2, params) {
  return new Class2({
    type: "string",
    format: "email",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _guid(Class2, params) {
  return new Class2({
    type: "string",
    format: "guid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _uuid(Class2, params) {
  return new Class2({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _uuidv4(Class2, params) {
  return new Class2({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    version: "v4",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _uuidv6(Class2, params) {
  return new Class2({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    version: "v6",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _uuidv7(Class2, params) {
  return new Class2({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    version: "v7",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _url(Class2, params) {
  return new Class2({
    type: "string",
    format: "url",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _emoji2(Class2, params) {
  return new Class2({
    type: "string",
    format: "emoji",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _nanoid(Class2, params) {
  return new Class2({
    type: "string",
    format: "nanoid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _cuid(Class2, params) {
  return new Class2({
    type: "string",
    format: "cuid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _cuid2(Class2, params) {
  return new Class2({
    type: "string",
    format: "cuid2",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _ulid(Class2, params) {
  return new Class2({
    type: "string",
    format: "ulid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _xid(Class2, params) {
  return new Class2({
    type: "string",
    format: "xid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _ksuid(Class2, params) {
  return new Class2({
    type: "string",
    format: "ksuid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _ipv4(Class2, params) {
  return new Class2({
    type: "string",
    format: "ipv4",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _ipv6(Class2, params) {
  return new Class2({
    type: "string",
    format: "ipv6",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _mac(Class2, params) {
  return new Class2({
    type: "string",
    format: "mac",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _cidrv4(Class2, params) {
  return new Class2({
    type: "string",
    format: "cidrv4",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _cidrv6(Class2, params) {
  return new Class2({
    type: "string",
    format: "cidrv6",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _base64(Class2, params) {
  return new Class2({
    type: "string",
    format: "base64",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _base64url(Class2, params) {
  return new Class2({
    type: "string",
    format: "base64url",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _e164(Class2, params) {
  return new Class2({
    type: "string",
    format: "e164",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _jwt(Class2, params) {
  return new Class2({
    type: "string",
    format: "jwt",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
var TimePrecision = {
  Any: null,
  Minute: -1,
  Second: 0,
  Millisecond: 3,
  Microsecond: 6
};
// @__NO_SIDE_EFFECTS__
function _isoDateTime(Class2, params) {
  return new Class2({
    type: "string",
    format: "datetime",
    check: "string_format",
    offset: false,
    local: false,
    precision: null,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _isoDate(Class2, params) {
  return new Class2({
    type: "string",
    format: "date",
    check: "string_format",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _isoTime(Class2, params) {
  return new Class2({
    type: "string",
    format: "time",
    check: "string_format",
    precision: null,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _isoDuration(Class2, params) {
  return new Class2({
    type: "string",
    format: "duration",
    check: "string_format",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _number(Class2, params) {
  return new Class2({
    type: "number",
    checks: [],
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _coercedNumber(Class2, params) {
  return new Class2({
    type: "number",
    coerce: true,
    checks: [],
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _int(Class2, params) {
  return new Class2({
    type: "number",
    check: "number_format",
    abort: false,
    format: "safeint",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _float32(Class2, params) {
  return new Class2({
    type: "number",
    check: "number_format",
    abort: false,
    format: "float32",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _float64(Class2, params) {
  return new Class2({
    type: "number",
    check: "number_format",
    abort: false,
    format: "float64",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _int32(Class2, params) {
  return new Class2({
    type: "number",
    check: "number_format",
    abort: false,
    format: "int32",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _uint32(Class2, params) {
  return new Class2({
    type: "number",
    check: "number_format",
    abort: false,
    format: "uint32",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _boolean(Class2, params) {
  return new Class2({
    type: "boolean",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _coercedBoolean(Class2, params) {
  return new Class2({
    type: "boolean",
    coerce: true,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _bigint(Class2, params) {
  return new Class2({
    type: "bigint",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _coercedBigint(Class2, params) {
  return new Class2({
    type: "bigint",
    coerce: true,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _int64(Class2, params) {
  return new Class2({
    type: "bigint",
    check: "bigint_format",
    abort: false,
    format: "int64",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _uint64(Class2, params) {
  return new Class2({
    type: "bigint",
    check: "bigint_format",
    abort: false,
    format: "uint64",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _symbol(Class2, params) {
  return new Class2({
    type: "symbol",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _undefined2(Class2, params) {
  return new Class2({
    type: "undefined",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _null2(Class2, params) {
  return new Class2({
    type: "null",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _any(Class2) {
  return new Class2({
    type: "any"
  });
}
// @__NO_SIDE_EFFECTS__
function _unknown(Class2) {
  return new Class2({
    type: "unknown"
  });
}
// @__NO_SIDE_EFFECTS__
function _never(Class2, params) {
  return new Class2({
    type: "never",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _void(Class2, params) {
  return new Class2({
    type: "void",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _date(Class2, params) {
  return new Class2({
    type: "date",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _coercedDate(Class2, params) {
  return new Class2({
    type: "date",
    coerce: true,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _nan(Class2, params) {
  return new Class2({
    type: "nan",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _lt(value, params) {
  return new $ZodCheckLessThan({
    check: "less_than",
    ...normalizeParams(params),
    value,
    inclusive: false
  });
}
// @__NO_SIDE_EFFECTS__
function _lte(value, params) {
  return new $ZodCheckLessThan({
    check: "less_than",
    ...normalizeParams(params),
    value,
    inclusive: true
  });
}
// @__NO_SIDE_EFFECTS__
function _gt(value, params) {
  return new $ZodCheckGreaterThan({
    check: "greater_than",
    ...normalizeParams(params),
    value,
    inclusive: false
  });
}
// @__NO_SIDE_EFFECTS__
function _gte(value, params) {
  return new $ZodCheckGreaterThan({
    check: "greater_than",
    ...normalizeParams(params),
    value,
    inclusive: true
  });
}
// @__NO_SIDE_EFFECTS__
function _positive(params) {
  return /* @__PURE__ */ _gt(0, params);
}
// @__NO_SIDE_EFFECTS__
function _negative(params) {
  return /* @__PURE__ */ _lt(0, params);
}
// @__NO_SIDE_EFFECTS__
function _nonpositive(params) {
  return /* @__PURE__ */ _lte(0, params);
}
// @__NO_SIDE_EFFECTS__
function _nonnegative(params) {
  return /* @__PURE__ */ _gte(0, params);
}
// @__NO_SIDE_EFFECTS__
function _multipleOf(value, params) {
  return new $ZodCheckMultipleOf({
    check: "multiple_of",
    ...normalizeParams(params),
    value
  });
}
// @__NO_SIDE_EFFECTS__
function _maxSize(maximum, params) {
  return new $ZodCheckMaxSize({
    check: "max_size",
    ...normalizeParams(params),
    maximum
  });
}
// @__NO_SIDE_EFFECTS__
function _minSize(minimum, params) {
  return new $ZodCheckMinSize({
    check: "min_size",
    ...normalizeParams(params),
    minimum
  });
}
// @__NO_SIDE_EFFECTS__
function _size(size, params) {
  return new $ZodCheckSizeEquals({
    check: "size_equals",
    ...normalizeParams(params),
    size
  });
}
// @__NO_SIDE_EFFECTS__
function _maxLength(maximum, params) {
  const ch = new $ZodCheckMaxLength({
    check: "max_length",
    ...normalizeParams(params),
    maximum
  });
  return ch;
}
// @__NO_SIDE_EFFECTS__
function _minLength(minimum, params) {
  return new $ZodCheckMinLength({
    check: "min_length",
    ...normalizeParams(params),
    minimum
  });
}
// @__NO_SIDE_EFFECTS__
function _length(length, params) {
  return new $ZodCheckLengthEquals({
    check: "length_equals",
    ...normalizeParams(params),
    length
  });
}
// @__NO_SIDE_EFFECTS__
function _regex(pattern, params) {
  return new $ZodCheckRegex({
    check: "string_format",
    format: "regex",
    ...normalizeParams(params),
    pattern
  });
}
// @__NO_SIDE_EFFECTS__
function _lowercase(params) {
  return new $ZodCheckLowerCase({
    check: "string_format",
    format: "lowercase",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _uppercase(params) {
  return new $ZodCheckUpperCase({
    check: "string_format",
    format: "uppercase",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _includes(includes, params) {
  return new $ZodCheckIncludes({
    check: "string_format",
    format: "includes",
    ...normalizeParams(params),
    includes
  });
}
// @__NO_SIDE_EFFECTS__
function _startsWith(prefix, params) {
  return new $ZodCheckStartsWith({
    check: "string_format",
    format: "starts_with",
    ...normalizeParams(params),
    prefix
  });
}
// @__NO_SIDE_EFFECTS__
function _endsWith(suffix, params) {
  return new $ZodCheckEndsWith({
    check: "string_format",
    format: "ends_with",
    ...normalizeParams(params),
    suffix
  });
}
// @__NO_SIDE_EFFECTS__
function _property(property, schema, params) {
  return new $ZodCheckProperty({
    check: "property",
    property,
    schema,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _mime(types, params) {
  return new $ZodCheckMimeType({
    check: "mime_type",
    mime: types,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _overwrite(tx) {
  return new $ZodCheckOverwrite({
    check: "overwrite",
    tx
  });
}
// @__NO_SIDE_EFFECTS__
function _normalize(form) {
  return /* @__PURE__ */ _overwrite((input) => input.normalize(form));
}
// @__NO_SIDE_EFFECTS__
function _trim() {
  return /* @__PURE__ */ _overwrite((input) => input.trim());
}
// @__NO_SIDE_EFFECTS__
function _toLowerCase() {
  return /* @__PURE__ */ _overwrite((input) => input.toLowerCase());
}
// @__NO_SIDE_EFFECTS__
function _toUpperCase() {
  return /* @__PURE__ */ _overwrite((input) => input.toUpperCase());
}
// @__NO_SIDE_EFFECTS__
function _slugify() {
  return /* @__PURE__ */ _overwrite((input) => slugify(input));
}
// @__NO_SIDE_EFFECTS__
function _array(Class2, element, params) {
  return new Class2({
    type: "array",
    element,
    // get element() {
    //   return element;
    // },
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _union(Class2, options, params) {
  return new Class2({
    type: "union",
    options,
    ...normalizeParams(params)
  });
}
function _xor(Class2, options, params) {
  return new Class2({
    type: "union",
    options,
    inclusive: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _discriminatedUnion(Class2, discriminator, options, params) {
  return new Class2({
    type: "union",
    options,
    discriminator,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _intersection(Class2, left, right) {
  return new Class2({
    type: "intersection",
    left,
    right
  });
}
// @__NO_SIDE_EFFECTS__
function _tuple(Class2, items, _paramsOrRest, _params) {
  const hasRest = _paramsOrRest instanceof $ZodType;
  const params = hasRest ? _params : _paramsOrRest;
  const rest = hasRest ? _paramsOrRest : null;
  return new Class2({
    type: "tuple",
    items,
    rest,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _record(Class2, keyType, valueType, params) {
  return new Class2({
    type: "record",
    keyType,
    valueType,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _map(Class2, keyType, valueType, params) {
  return new Class2({
    type: "map",
    keyType,
    valueType,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _set(Class2, valueType, params) {
  return new Class2({
    type: "set",
    valueType,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _enum(Class2, values, params) {
  const entries = Array.isArray(values) ? Object.fromEntries(values.map((v) => [v, v])) : values;
  return new Class2({
    type: "enum",
    entries,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _nativeEnum(Class2, entries, params) {
  return new Class2({
    type: "enum",
    entries,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _literal(Class2, value, params) {
  return new Class2({
    type: "literal",
    values: Array.isArray(value) ? value : [value],
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _file(Class2, params) {
  return new Class2({
    type: "file",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _transform(Class2, fn) {
  return new Class2({
    type: "transform",
    transform: fn
  });
}
// @__NO_SIDE_EFFECTS__
function _optional(Class2, innerType) {
  return new Class2({
    type: "optional",
    innerType
  });
}
// @__NO_SIDE_EFFECTS__
function _nullable(Class2, innerType) {
  return new Class2({
    type: "nullable",
    innerType
  });
}
// @__NO_SIDE_EFFECTS__
function _default(Class2, innerType, defaultValue) {
  return new Class2({
    type: "default",
    innerType,
    get defaultValue() {
      return typeof defaultValue === "function" ? defaultValue() : shallowClone(defaultValue);
    }
  });
}
// @__NO_SIDE_EFFECTS__
function _nonoptional(Class2, innerType, params) {
  return new Class2({
    type: "nonoptional",
    innerType,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _success(Class2, innerType) {
  return new Class2({
    type: "success",
    innerType
  });
}
// @__NO_SIDE_EFFECTS__
function _catch(Class2, innerType, catchValue) {
  return new Class2({
    type: "catch",
    innerType,
    catchValue: typeof catchValue === "function" ? catchValue : () => catchValue
  });
}
// @__NO_SIDE_EFFECTS__
function _pipe(Class2, in_, out) {
  return new Class2({
    type: "pipe",
    in: in_,
    out
  });
}
// @__NO_SIDE_EFFECTS__
function _readonly(Class2, innerType) {
  return new Class2({
    type: "readonly",
    innerType
  });
}
// @__NO_SIDE_EFFECTS__
function _templateLiteral(Class2, parts, params) {
  return new Class2({
    type: "template_literal",
    parts,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _lazy(Class2, getter) {
  return new Class2({
    type: "lazy",
    getter
  });
}
// @__NO_SIDE_EFFECTS__
function _promise(Class2, innerType) {
  return new Class2({
    type: "promise",
    innerType
  });
}
// @__NO_SIDE_EFFECTS__
function _custom(Class2, fn, _params) {
  const norm = normalizeParams(_params);
  norm.abort ?? (norm.abort = true);
  const schema = new Class2({
    type: "custom",
    check: "custom",
    fn,
    ...norm
  });
  return schema;
}
// @__NO_SIDE_EFFECTS__
function _refine(Class2, fn, _params) {
  const schema = new Class2({
    type: "custom",
    check: "custom",
    fn,
    ...normalizeParams(_params)
  });
  return schema;
}
// @__NO_SIDE_EFFECTS__
function _superRefine(fn) {
  const ch = /* @__PURE__ */ _check((payload) => {
    payload.addIssue = (issue2) => {
      if (typeof issue2 === "string") {
        payload.issues.push(issue(issue2, payload.value, ch._zod.def));
      } else {
        const _issue = issue2;
        if (_issue.fatal)
          _issue.continue = false;
        _issue.code ?? (_issue.code = "custom");
        _issue.input ?? (_issue.input = payload.value);
        _issue.inst ?? (_issue.inst = ch);
        _issue.continue ?? (_issue.continue = !ch._zod.def.abort);
        payload.issues.push(issue(_issue));
      }
    };
    return fn(payload.value, payload);
  });
  return ch;
}
// @__NO_SIDE_EFFECTS__
function _check(fn, params) {
  const ch = new $ZodCheck({
    check: "custom",
    ...normalizeParams(params)
  });
  ch._zod.check = fn;
  return ch;
}
// @__NO_SIDE_EFFECTS__
function describe(description) {
  const ch = new $ZodCheck({ check: "describe" });
  ch._zod.onattach = [
    (inst) => {
      const existing = globalRegistry.get(inst) ?? {};
      globalRegistry.add(inst, { ...existing, description });
    }
  ];
  ch._zod.check = () => {
  };
  return ch;
}
// @__NO_SIDE_EFFECTS__
function meta(metadata) {
  const ch = new $ZodCheck({ check: "meta" });
  ch._zod.onattach = [
    (inst) => {
      const existing = globalRegistry.get(inst) ?? {};
      globalRegistry.add(inst, { ...existing, ...metadata });
    }
  ];
  ch._zod.check = () => {
  };
  return ch;
}
// @__NO_SIDE_EFFECTS__
function _stringbool(Classes, _params) {
  const params = normalizeParams(_params);
  let truthyArray = params.truthy ?? ["true", "1", "yes", "on", "y", "enabled"];
  let falsyArray = params.falsy ?? ["false", "0", "no", "off", "n", "disabled"];
  if (params.case !== "sensitive") {
    truthyArray = truthyArray.map((v) => typeof v === "string" ? v.toLowerCase() : v);
    falsyArray = falsyArray.map((v) => typeof v === "string" ? v.toLowerCase() : v);
  }
  const truthySet = new Set(truthyArray);
  const falsySet = new Set(falsyArray);
  const _Codec = Classes.Codec ?? $ZodCodec;
  const _Boolean = Classes.Boolean ?? $ZodBoolean;
  const _String = Classes.String ?? $ZodString;
  const stringSchema = new _String({ type: "string", error: params.error });
  const booleanSchema = new _Boolean({ type: "boolean", error: params.error });
  const codec2 = new _Codec({
    type: "pipe",
    in: stringSchema,
    out: booleanSchema,
    transform: ((input, payload) => {
      let data = input;
      if (params.case !== "sensitive")
        data = data.toLowerCase();
      if (truthySet.has(data)) {
        return true;
      } else if (falsySet.has(data)) {
        return false;
      } else {
        payload.issues.push({
          code: "invalid_value",
          expected: "stringbool",
          values: [...truthySet, ...falsySet],
          input: payload.value,
          inst: codec2,
          continue: false
        });
        return {};
      }
    }),
    reverseTransform: ((input, _payload) => {
      if (input === true) {
        return truthyArray[0] || "true";
      } else {
        return falsyArray[0] || "false";
      }
    }),
    error: params.error
  });
  return codec2;
}
// @__NO_SIDE_EFFECTS__
function _stringFormat(Class2, format, fnOrRegex, _params = {}) {
  const params = normalizeParams(_params);
  const def = {
    ...normalizeParams(_params),
    check: "string_format",
    type: "string",
    format,
    fn: typeof fnOrRegex === "function" ? fnOrRegex : (val) => fnOrRegex.test(val),
    ...params
  };
  if (fnOrRegex instanceof RegExp) {
    def.pattern = fnOrRegex;
  }
  const inst = new Class2(def);
  return inst;
}

// node_modules/zod/v4/core/to-json-schema.js
function initializeContext(params) {
  let target = params?.target ?? "draft-2020-12";
  if (target === "draft-4")
    target = "draft-04";
  if (target === "draft-7")
    target = "draft-07";
  return {
    processors: params.processors ?? {},
    metadataRegistry: params?.metadata ?? globalRegistry,
    target,
    unrepresentable: params?.unrepresentable ?? "throw",
    override: params?.override ?? (() => {
    }),
    io: params?.io ?? "output",
    counter: 0,
    seen: /* @__PURE__ */ new Map(),
    cycles: params?.cycles ?? "ref",
    reused: params?.reused ?? "inline",
    external: params?.external ?? void 0
  };
}
function process2(schema, ctx, _params = { path: [], schemaPath: [] }) {
  var _a2;
  const def = schema._zod.def;
  const seen = ctx.seen.get(schema);
  if (seen) {
    seen.count++;
    const isCycle = _params.schemaPath.includes(schema);
    if (isCycle) {
      seen.cycle = _params.path;
    }
    return seen.schema;
  }
  const result = { schema: {}, count: 1, cycle: void 0, path: _params.path };
  ctx.seen.set(schema, result);
  const overrideSchema = schema._zod.toJSONSchema?.();
  if (overrideSchema) {
    result.schema = overrideSchema;
  } else {
    const params = {
      ..._params,
      schemaPath: [..._params.schemaPath, schema],
      path: _params.path
    };
    if (schema._zod.processJSONSchema) {
      schema._zod.processJSONSchema(ctx, result.schema, params);
    } else {
      const _json = result.schema;
      const processor = ctx.processors[def.type];
      if (!processor) {
        throw new Error(`[toJSONSchema]: Non-representable type encountered: ${def.type}`);
      }
      processor(schema, ctx, _json, params);
    }
    const parent = schema._zod.parent;
    if (parent) {
      if (!result.ref)
        result.ref = parent;
      process2(parent, ctx, params);
      ctx.seen.get(parent).isParent = true;
    }
  }
  const meta3 = ctx.metadataRegistry.get(schema);
  if (meta3)
    Object.assign(result.schema, meta3);
  if (ctx.io === "input" && isTransforming(schema)) {
    delete result.schema.examples;
    delete result.schema.default;
  }
  if (ctx.io === "input" && result.schema._prefault)
    (_a2 = result.schema).default ?? (_a2.default = result.schema._prefault);
  delete result.schema._prefault;
  const _result = ctx.seen.get(schema);
  return _result.schema;
}
function extractDefs(ctx, schema) {
  const root = ctx.seen.get(schema);
  if (!root)
    throw new Error("Unprocessed schema. This is a bug in Zod.");
  const idToSchema = /* @__PURE__ */ new Map();
  for (const entry of ctx.seen.entries()) {
    const id = ctx.metadataRegistry.get(entry[0])?.id;
    if (id) {
      const existing = idToSchema.get(id);
      if (existing && existing !== entry[0]) {
        throw new Error(`Duplicate schema id "${id}" detected during JSON Schema conversion. Two different schemas cannot share the same id when converted together.`);
      }
      idToSchema.set(id, entry[0]);
    }
  }
  const makeURI = (entry) => {
    const defsSegment = ctx.target === "draft-2020-12" ? "$defs" : "definitions";
    if (ctx.external) {
      const externalId = ctx.external.registry.get(entry[0])?.id;
      const uriGenerator = ctx.external.uri ?? ((id2) => id2);
      if (externalId) {
        return { ref: uriGenerator(externalId) };
      }
      const id = entry[1].defId ?? entry[1].schema.id ?? `schema${ctx.counter++}`;
      entry[1].defId = id;
      return { defId: id, ref: `${uriGenerator("__shared")}#/${defsSegment}/${id}` };
    }
    if (entry[1] === root) {
      return { ref: "#" };
    }
    const uriPrefix = `#`;
    const defUriPrefix = `${uriPrefix}/${defsSegment}/`;
    const defId = entry[1].schema.id ?? `__schema${ctx.counter++}`;
    return { defId, ref: defUriPrefix + defId };
  };
  const extractToDef = (entry) => {
    if (entry[1].schema.$ref) {
      return;
    }
    const seen = entry[1];
    const { ref, defId } = makeURI(entry);
    seen.def = { ...seen.schema };
    if (defId)
      seen.defId = defId;
    const schema2 = seen.schema;
    for (const key in schema2) {
      delete schema2[key];
    }
    schema2.$ref = ref;
  };
  if (ctx.cycles === "throw") {
    for (const entry of ctx.seen.entries()) {
      const seen = entry[1];
      if (seen.cycle) {
        throw new Error(`Cycle detected: #/${seen.cycle?.join("/")}/<root>

Set the \`cycles\` parameter to \`"ref"\` to resolve cyclical schemas with defs.`);
      }
    }
  }
  for (const entry of ctx.seen.entries()) {
    const seen = entry[1];
    if (schema === entry[0]) {
      extractToDef(entry);
      continue;
    }
    if (ctx.external) {
      const ext = ctx.external.registry.get(entry[0])?.id;
      if (schema !== entry[0] && ext) {
        extractToDef(entry);
        continue;
      }
    }
    const id = ctx.metadataRegistry.get(entry[0])?.id;
    if (id) {
      extractToDef(entry);
      continue;
    }
    if (seen.cycle) {
      extractToDef(entry);
      continue;
    }
    if (seen.count > 1) {
      if (ctx.reused === "ref") {
        extractToDef(entry);
        continue;
      }
    }
  }
}
function finalize(ctx, schema) {
  const root = ctx.seen.get(schema);
  if (!root)
    throw new Error("Unprocessed schema. This is a bug in Zod.");
  const flattenRef = (zodSchema) => {
    const seen = ctx.seen.get(zodSchema);
    if (seen.ref === null)
      return;
    const schema2 = seen.def ?? seen.schema;
    const _cached = { ...schema2 };
    const ref = seen.ref;
    seen.ref = null;
    if (ref) {
      flattenRef(ref);
      const refSeen = ctx.seen.get(ref);
      const refSchema = refSeen.schema;
      if (refSchema.$ref && (ctx.target === "draft-07" || ctx.target === "draft-04" || ctx.target === "openapi-3.0")) {
        schema2.allOf = schema2.allOf ?? [];
        schema2.allOf.push(refSchema);
      } else {
        Object.assign(schema2, refSchema);
      }
      Object.assign(schema2, _cached);
      const isParentRef = zodSchema._zod.parent === ref;
      if (isParentRef) {
        for (const key in schema2) {
          if (key === "$ref" || key === "allOf")
            continue;
          if (!(key in _cached)) {
            delete schema2[key];
          }
        }
      }
      if (refSchema.$ref && refSeen.def) {
        for (const key in schema2) {
          if (key === "$ref" || key === "allOf")
            continue;
          if (key in refSeen.def && JSON.stringify(schema2[key]) === JSON.stringify(refSeen.def[key])) {
            delete schema2[key];
          }
        }
      }
    }
    const parent = zodSchema._zod.parent;
    if (parent && parent !== ref) {
      flattenRef(parent);
      const parentSeen = ctx.seen.get(parent);
      if (parentSeen?.schema.$ref) {
        schema2.$ref = parentSeen.schema.$ref;
        if (parentSeen.def) {
          for (const key in schema2) {
            if (key === "$ref" || key === "allOf")
              continue;
            if (key in parentSeen.def && JSON.stringify(schema2[key]) === JSON.stringify(parentSeen.def[key])) {
              delete schema2[key];
            }
          }
        }
      }
    }
    ctx.override({
      zodSchema,
      jsonSchema: schema2,
      path: seen.path ?? []
    });
  };
  for (const entry of [...ctx.seen.entries()].reverse()) {
    flattenRef(entry[0]);
  }
  const result = {};
  if (ctx.target === "draft-2020-12") {
    result.$schema = "https://json-schema.org/draft/2020-12/schema";
  } else if (ctx.target === "draft-07") {
    result.$schema = "http://json-schema.org/draft-07/schema#";
  } else if (ctx.target === "draft-04") {
    result.$schema = "http://json-schema.org/draft-04/schema#";
  } else if (ctx.target === "openapi-3.0") {
  } else {
  }
  if (ctx.external?.uri) {
    const id = ctx.external.registry.get(schema)?.id;
    if (!id)
      throw new Error("Schema is missing an `id` property");
    result.$id = ctx.external.uri(id);
  }
  Object.assign(result, root.def ?? root.schema);
  const defs = ctx.external?.defs ?? {};
  for (const entry of ctx.seen.entries()) {
    const seen = entry[1];
    if (seen.def && seen.defId) {
      defs[seen.defId] = seen.def;
    }
  }
  if (ctx.external) {
  } else {
    if (Object.keys(defs).length > 0) {
      if (ctx.target === "draft-2020-12") {
        result.$defs = defs;
      } else {
        result.definitions = defs;
      }
    }
  }
  try {
    const finalized = JSON.parse(JSON.stringify(result));
    Object.defineProperty(finalized, "~standard", {
      value: {
        ...schema["~standard"],
        jsonSchema: {
          input: createStandardJSONSchemaMethod(schema, "input", ctx.processors),
          output: createStandardJSONSchemaMethod(schema, "output", ctx.processors)
        }
      },
      enumerable: false,
      writable: false
    });
    return finalized;
  } catch (_err) {
    throw new Error("Error converting schema to JSON.");
  }
}
function isTransforming(_schema, _ctx) {
  const ctx = _ctx ?? { seen: /* @__PURE__ */ new Set() };
  if (ctx.seen.has(_schema))
    return false;
  ctx.seen.add(_schema);
  const def = _schema._zod.def;
  if (def.type === "transform")
    return true;
  if (def.type === "array")
    return isTransforming(def.element, ctx);
  if (def.type === "set")
    return isTransforming(def.valueType, ctx);
  if (def.type === "lazy")
    return isTransforming(def.getter(), ctx);
  if (def.type === "promise" || def.type === "optional" || def.type === "nonoptional" || def.type === "nullable" || def.type === "readonly" || def.type === "default" || def.type === "prefault") {
    return isTransforming(def.innerType, ctx);
  }
  if (def.type === "intersection") {
    return isTransforming(def.left, ctx) || isTransforming(def.right, ctx);
  }
  if (def.type === "record" || def.type === "map") {
    return isTransforming(def.keyType, ctx) || isTransforming(def.valueType, ctx);
  }
  if (def.type === "pipe") {
    return isTransforming(def.in, ctx) || isTransforming(def.out, ctx);
  }
  if (def.type === "object") {
    for (const key in def.shape) {
      if (isTransforming(def.shape[key], ctx))
        return true;
    }
    return false;
  }
  if (def.type === "union") {
    for (const option of def.options) {
      if (isTransforming(option, ctx))
        return true;
    }
    return false;
  }
  if (def.type === "tuple") {
    for (const item of def.items) {
      if (isTransforming(item, ctx))
        return true;
    }
    if (def.rest && isTransforming(def.rest, ctx))
      return true;
    return false;
  }
  return false;
}
var createToJSONSchemaMethod = (schema, processors = {}) => (params) => {
  const ctx = initializeContext({ ...params, processors });
  process2(schema, ctx);
  extractDefs(ctx, schema);
  return finalize(ctx, schema);
};
var createStandardJSONSchemaMethod = (schema, io, processors = {}) => (params) => {
  const { libraryOptions, target } = params ?? {};
  const ctx = initializeContext({ ...libraryOptions ?? {}, target, io, processors });
  process2(schema, ctx);
  extractDefs(ctx, schema);
  return finalize(ctx, schema);
};

// node_modules/zod/v4/core/json-schema-processors.js
var formatMap = {
  guid: "uuid",
  url: "uri",
  datetime: "date-time",
  json_string: "json-string",
  regex: ""
  // do not set
};
var stringProcessor = (schema, ctx, _json, _params) => {
  const json2 = _json;
  json2.type = "string";
  const { minimum, maximum, format, patterns, contentEncoding } = schema._zod.bag;
  if (typeof minimum === "number")
    json2.minLength = minimum;
  if (typeof maximum === "number")
    json2.maxLength = maximum;
  if (format) {
    json2.format = formatMap[format] ?? format;
    if (json2.format === "")
      delete json2.format;
    if (format === "time") {
      delete json2.format;
    }
  }
  if (contentEncoding)
    json2.contentEncoding = contentEncoding;
  if (patterns && patterns.size > 0) {
    const regexes = [...patterns];
    if (regexes.length === 1)
      json2.pattern = regexes[0].source;
    else if (regexes.length > 1) {
      json2.allOf = [
        ...regexes.map((regex) => ({
          ...ctx.target === "draft-07" || ctx.target === "draft-04" || ctx.target === "openapi-3.0" ? { type: "string" } : {},
          pattern: regex.source
        }))
      ];
    }
  }
};
var numberProcessor = (schema, ctx, _json, _params) => {
  const json2 = _json;
  const { minimum, maximum, format, multipleOf, exclusiveMaximum, exclusiveMinimum } = schema._zod.bag;
  if (typeof format === "string" && format.includes("int"))
    json2.type = "integer";
  else
    json2.type = "number";
  if (typeof exclusiveMinimum === "number") {
    if (ctx.target === "draft-04" || ctx.target === "openapi-3.0") {
      json2.minimum = exclusiveMinimum;
      json2.exclusiveMinimum = true;
    } else {
      json2.exclusiveMinimum = exclusiveMinimum;
    }
  }
  if (typeof minimum === "number") {
    json2.minimum = minimum;
    if (typeof exclusiveMinimum === "number" && ctx.target !== "draft-04") {
      if (exclusiveMinimum >= minimum)
        delete json2.minimum;
      else
        delete json2.exclusiveMinimum;
    }
  }
  if (typeof exclusiveMaximum === "number") {
    if (ctx.target === "draft-04" || ctx.target === "openapi-3.0") {
      json2.maximum = exclusiveMaximum;
      json2.exclusiveMaximum = true;
    } else {
      json2.exclusiveMaximum = exclusiveMaximum;
    }
  }
  if (typeof maximum === "number") {
    json2.maximum = maximum;
    if (typeof exclusiveMaximum === "number" && ctx.target !== "draft-04") {
      if (exclusiveMaximum <= maximum)
        delete json2.maximum;
      else
        delete json2.exclusiveMaximum;
    }
  }
  if (typeof multipleOf === "number")
    json2.multipleOf = multipleOf;
};
var booleanProcessor = (_schema, _ctx, json2, _params) => {
  json2.type = "boolean";
};
var bigintProcessor = (_schema, ctx, _json, _params) => {
  if (ctx.unrepresentable === "throw") {
    throw new Error("BigInt cannot be represented in JSON Schema");
  }
};
var symbolProcessor = (_schema, ctx, _json, _params) => {
  if (ctx.unrepresentable === "throw") {
    throw new Error("Symbols cannot be represented in JSON Schema");
  }
};
var nullProcessor = (_schema, ctx, json2, _params) => {
  if (ctx.target === "openapi-3.0") {
    json2.type = "string";
    json2.nullable = true;
    json2.enum = [null];
  } else {
    json2.type = "null";
  }
};
var undefinedProcessor = (_schema, ctx, _json, _params) => {
  if (ctx.unrepresentable === "throw") {
    throw new Error("Undefined cannot be represented in JSON Schema");
  }
};
var voidProcessor = (_schema, ctx, _json, _params) => {
  if (ctx.unrepresentable === "throw") {
    throw new Error("Void cannot be represented in JSON Schema");
  }
};
var neverProcessor = (_schema, _ctx, json2, _params) => {
  json2.not = {};
};
var anyProcessor = (_schema, _ctx, _json, _params) => {
};
var unknownProcessor = (_schema, _ctx, _json, _params) => {
};
var dateProcessor = (_schema, ctx, _json, _params) => {
  if (ctx.unrepresentable === "throw") {
    throw new Error("Date cannot be represented in JSON Schema");
  }
};
var enumProcessor = (schema, _ctx, json2, _params) => {
  const def = schema._zod.def;
  const values = getEnumValues(def.entries);
  if (values.every((v) => typeof v === "number"))
    json2.type = "number";
  if (values.every((v) => typeof v === "string"))
    json2.type = "string";
  json2.enum = values;
};
var literalProcessor = (schema, ctx, json2, _params) => {
  const def = schema._zod.def;
  const vals = [];
  for (const val of def.values) {
    if (val === void 0) {
      if (ctx.unrepresentable === "throw") {
        throw new Error("Literal `undefined` cannot be represented in JSON Schema");
      } else {
      }
    } else if (typeof val === "bigint") {
      if (ctx.unrepresentable === "throw") {
        throw new Error("BigInt literals cannot be represented in JSON Schema");
      } else {
        vals.push(Number(val));
      }
    } else {
      vals.push(val);
    }
  }
  if (vals.length === 0) {
  } else if (vals.length === 1) {
    const val = vals[0];
    json2.type = val === null ? "null" : typeof val;
    if (ctx.target === "draft-04" || ctx.target === "openapi-3.0") {
      json2.enum = [val];
    } else {
      json2.const = val;
    }
  } else {
    if (vals.every((v) => typeof v === "number"))
      json2.type = "number";
    if (vals.every((v) => typeof v === "string"))
      json2.type = "string";
    if (vals.every((v) => typeof v === "boolean"))
      json2.type = "boolean";
    if (vals.every((v) => v === null))
      json2.type = "null";
    json2.enum = vals;
  }
};
var nanProcessor = (_schema, ctx, _json, _params) => {
  if (ctx.unrepresentable === "throw") {
    throw new Error("NaN cannot be represented in JSON Schema");
  }
};
var templateLiteralProcessor = (schema, _ctx, json2, _params) => {
  const _json = json2;
  const pattern = schema._zod.pattern;
  if (!pattern)
    throw new Error("Pattern not found in template literal");
  _json.type = "string";
  _json.pattern = pattern.source;
};
var fileProcessor = (schema, _ctx, json2, _params) => {
  const _json = json2;
  const file2 = {
    type: "string",
    format: "binary",
    contentEncoding: "binary"
  };
  const { minimum, maximum, mime } = schema._zod.bag;
  if (minimum !== void 0)
    file2.minLength = minimum;
  if (maximum !== void 0)
    file2.maxLength = maximum;
  if (mime) {
    if (mime.length === 1) {
      file2.contentMediaType = mime[0];
      Object.assign(_json, file2);
    } else {
      Object.assign(_json, file2);
      _json.anyOf = mime.map((m) => ({ contentMediaType: m }));
    }
  } else {
    Object.assign(_json, file2);
  }
};
var successProcessor = (_schema, _ctx, json2, _params) => {
  json2.type = "boolean";
};
var customProcessor = (_schema, ctx, _json, _params) => {
  if (ctx.unrepresentable === "throw") {
    throw new Error("Custom types cannot be represented in JSON Schema");
  }
};
var functionProcessor = (_schema, ctx, _json, _params) => {
  if (ctx.unrepresentable === "throw") {
    throw new Error("Function types cannot be represented in JSON Schema");
  }
};
var transformProcessor = (_schema, ctx, _json, _params) => {
  if (ctx.unrepresentable === "throw") {
    throw new Error("Transforms cannot be represented in JSON Schema");
  }
};
var mapProcessor = (_schema, ctx, _json, _params) => {
  if (ctx.unrepresentable === "throw") {
    throw new Error("Map cannot be represented in JSON Schema");
  }
};
var setProcessor = (_schema, ctx, _json, _params) => {
  if (ctx.unrepresentable === "throw") {
    throw new Error("Set cannot be represented in JSON Schema");
  }
};
var arrayProcessor = (schema, ctx, _json, params) => {
  const json2 = _json;
  const def = schema._zod.def;
  const { minimum, maximum } = schema._zod.bag;
  if (typeof minimum === "number")
    json2.minItems = minimum;
  if (typeof maximum === "number")
    json2.maxItems = maximum;
  json2.type = "array";
  json2.items = process2(def.element, ctx, { ...params, path: [...params.path, "items"] });
};
var objectProcessor = (schema, ctx, _json, params) => {
  const json2 = _json;
  const def = schema._zod.def;
  json2.type = "object";
  json2.properties = {};
  const shape = def.shape;
  for (const key in shape) {
    json2.properties[key] = process2(shape[key], ctx, {
      ...params,
      path: [...params.path, "properties", key]
    });
  }
  const allKeys = new Set(Object.keys(shape));
  const requiredKeys = new Set([...allKeys].filter((key) => {
    const v = def.shape[key]._zod;
    if (ctx.io === "input") {
      return v.optin === void 0;
    } else {
      return v.optout === void 0;
    }
  }));
  if (requiredKeys.size > 0) {
    json2.required = Array.from(requiredKeys);
  }
  if (def.catchall?._zod.def.type === "never") {
    json2.additionalProperties = false;
  } else if (!def.catchall) {
    if (ctx.io === "output")
      json2.additionalProperties = false;
  } else if (def.catchall) {
    json2.additionalProperties = process2(def.catchall, ctx, {
      ...params,
      path: [...params.path, "additionalProperties"]
    });
  }
};
var unionProcessor = (schema, ctx, json2, params) => {
  const def = schema._zod.def;
  const isExclusive = def.inclusive === false;
  const options = def.options.map((x, i) => process2(x, ctx, {
    ...params,
    path: [...params.path, isExclusive ? "oneOf" : "anyOf", i]
  }));
  if (isExclusive) {
    json2.oneOf = options;
  } else {
    json2.anyOf = options;
  }
};
var intersectionProcessor = (schema, ctx, json2, params) => {
  const def = schema._zod.def;
  const a = process2(def.left, ctx, {
    ...params,
    path: [...params.path, "allOf", 0]
  });
  const b = process2(def.right, ctx, {
    ...params,
    path: [...params.path, "allOf", 1]
  });
  const isSimpleIntersection = (val) => "allOf" in val && Object.keys(val).length === 1;
  const allOf = [
    ...isSimpleIntersection(a) ? a.allOf : [a],
    ...isSimpleIntersection(b) ? b.allOf : [b]
  ];
  json2.allOf = allOf;
};
var tupleProcessor = (schema, ctx, _json, params) => {
  const json2 = _json;
  const def = schema._zod.def;
  json2.type = "array";
  const prefixPath = ctx.target === "draft-2020-12" ? "prefixItems" : "items";
  const restPath = ctx.target === "draft-2020-12" ? "items" : ctx.target === "openapi-3.0" ? "items" : "additionalItems";
  const prefixItems = def.items.map((x, i) => process2(x, ctx, {
    ...params,
    path: [...params.path, prefixPath, i]
  }));
  const rest = def.rest ? process2(def.rest, ctx, {
    ...params,
    path: [...params.path, restPath, ...ctx.target === "openapi-3.0" ? [def.items.length] : []]
  }) : null;
  if (ctx.target === "draft-2020-12") {
    json2.prefixItems = prefixItems;
    if (rest) {
      json2.items = rest;
    }
  } else if (ctx.target === "openapi-3.0") {
    json2.items = {
      anyOf: prefixItems
    };
    if (rest) {
      json2.items.anyOf.push(rest);
    }
    json2.minItems = prefixItems.length;
    if (!rest) {
      json2.maxItems = prefixItems.length;
    }
  } else {
    json2.items = prefixItems;
    if (rest) {
      json2.additionalItems = rest;
    }
  }
  const { minimum, maximum } = schema._zod.bag;
  if (typeof minimum === "number")
    json2.minItems = minimum;
  if (typeof maximum === "number")
    json2.maxItems = maximum;
};
var recordProcessor = (schema, ctx, _json, params) => {
  const json2 = _json;
  const def = schema._zod.def;
  json2.type = "object";
  const keyType = def.keyType;
  const keyBag = keyType._zod.bag;
  const patterns = keyBag?.patterns;
  if (def.mode === "loose" && patterns && patterns.size > 0) {
    const valueSchema = process2(def.valueType, ctx, {
      ...params,
      path: [...params.path, "patternProperties", "*"]
    });
    json2.patternProperties = {};
    for (const pattern of patterns) {
      json2.patternProperties[pattern.source] = valueSchema;
    }
  } else {
    if (ctx.target === "draft-07" || ctx.target === "draft-2020-12") {
      json2.propertyNames = process2(def.keyType, ctx, {
        ...params,
        path: [...params.path, "propertyNames"]
      });
    }
    json2.additionalProperties = process2(def.valueType, ctx, {
      ...params,
      path: [...params.path, "additionalProperties"]
    });
  }
  const keyValues = keyType._zod.values;
  if (keyValues) {
    const validKeyValues = [...keyValues].filter((v) => typeof v === "string" || typeof v === "number");
    if (validKeyValues.length > 0) {
      json2.required = validKeyValues;
    }
  }
};
var nullableProcessor = (schema, ctx, json2, params) => {
  const def = schema._zod.def;
  const inner = process2(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  if (ctx.target === "openapi-3.0") {
    seen.ref = def.innerType;
    json2.nullable = true;
  } else {
    json2.anyOf = [inner, { type: "null" }];
  }
};
var nonoptionalProcessor = (schema, ctx, _json, params) => {
  const def = schema._zod.def;
  process2(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
};
var defaultProcessor = (schema, ctx, json2, params) => {
  const def = schema._zod.def;
  process2(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
  json2.default = JSON.parse(JSON.stringify(def.defaultValue));
};
var prefaultProcessor = (schema, ctx, json2, params) => {
  const def = schema._zod.def;
  process2(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
  if (ctx.io === "input")
    json2._prefault = JSON.parse(JSON.stringify(def.defaultValue));
};
var catchProcessor = (schema, ctx, json2, params) => {
  const def = schema._zod.def;
  process2(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
  let catchValue;
  try {
    catchValue = def.catchValue(void 0);
  } catch {
    throw new Error("Dynamic catch values are not supported in JSON Schema");
  }
  json2.default = catchValue;
};
var pipeProcessor = (schema, ctx, _json, params) => {
  const def = schema._zod.def;
  const innerType = ctx.io === "input" ? def.in._zod.def.type === "transform" ? def.out : def.in : def.out;
  process2(innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = innerType;
};
var readonlyProcessor = (schema, ctx, json2, params) => {
  const def = schema._zod.def;
  process2(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
  json2.readOnly = true;
};
var promiseProcessor = (schema, ctx, _json, params) => {
  const def = schema._zod.def;
  process2(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
};
var optionalProcessor = (schema, ctx, _json, params) => {
  const def = schema._zod.def;
  process2(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
};
var lazyProcessor = (schema, ctx, _json, params) => {
  const innerType = schema._zod.innerType;
  process2(innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = innerType;
};
var allProcessors = {
  string: stringProcessor,
  number: numberProcessor,
  boolean: booleanProcessor,
  bigint: bigintProcessor,
  symbol: symbolProcessor,
  null: nullProcessor,
  undefined: undefinedProcessor,
  void: voidProcessor,
  never: neverProcessor,
  any: anyProcessor,
  unknown: unknownProcessor,
  date: dateProcessor,
  enum: enumProcessor,
  literal: literalProcessor,
  nan: nanProcessor,
  template_literal: templateLiteralProcessor,
  file: fileProcessor,
  success: successProcessor,
  custom: customProcessor,
  function: functionProcessor,
  transform: transformProcessor,
  map: mapProcessor,
  set: setProcessor,
  array: arrayProcessor,
  object: objectProcessor,
  union: unionProcessor,
  intersection: intersectionProcessor,
  tuple: tupleProcessor,
  record: recordProcessor,
  nullable: nullableProcessor,
  nonoptional: nonoptionalProcessor,
  default: defaultProcessor,
  prefault: prefaultProcessor,
  catch: catchProcessor,
  pipe: pipeProcessor,
  readonly: readonlyProcessor,
  promise: promiseProcessor,
  optional: optionalProcessor,
  lazy: lazyProcessor
};
function toJSONSchema(input, params) {
  if ("_idmap" in input) {
    const registry2 = input;
    const ctx2 = initializeContext({ ...params, processors: allProcessors });
    const defs = {};
    for (const entry of registry2._idmap.entries()) {
      const [_, schema] = entry;
      process2(schema, ctx2);
    }
    const schemas = {};
    const external = {
      registry: registry2,
      uri: params?.uri,
      defs
    };
    ctx2.external = external;
    for (const entry of registry2._idmap.entries()) {
      const [key, schema] = entry;
      extractDefs(ctx2, schema);
      schemas[key] = finalize(ctx2, schema);
    }
    if (Object.keys(defs).length > 0) {
      const defsSegment = ctx2.target === "draft-2020-12" ? "$defs" : "definitions";
      schemas.__shared = {
        [defsSegment]: defs
      };
    }
    return { schemas };
  }
  const ctx = initializeContext({ ...params, processors: allProcessors });
  process2(input, ctx);
  extractDefs(ctx, input);
  return finalize(ctx, input);
}

// node_modules/zod/v4/core/json-schema-generator.js
var JSONSchemaGenerator = class {
  /** @deprecated Access via ctx instead */
  get metadataRegistry() {
    return this.ctx.metadataRegistry;
  }
  /** @deprecated Access via ctx instead */
  get target() {
    return this.ctx.target;
  }
  /** @deprecated Access via ctx instead */
  get unrepresentable() {
    return this.ctx.unrepresentable;
  }
  /** @deprecated Access via ctx instead */
  get override() {
    return this.ctx.override;
  }
  /** @deprecated Access via ctx instead */
  get io() {
    return this.ctx.io;
  }
  /** @deprecated Access via ctx instead */
  get counter() {
    return this.ctx.counter;
  }
  set counter(value) {
    this.ctx.counter = value;
  }
  /** @deprecated Access via ctx instead */
  get seen() {
    return this.ctx.seen;
  }
  constructor(params) {
    let normalizedTarget = params?.target ?? "draft-2020-12";
    if (normalizedTarget === "draft-4")
      normalizedTarget = "draft-04";
    if (normalizedTarget === "draft-7")
      normalizedTarget = "draft-07";
    this.ctx = initializeContext({
      processors: allProcessors,
      target: normalizedTarget,
      ...params?.metadata && { metadata: params.metadata },
      ...params?.unrepresentable && { unrepresentable: params.unrepresentable },
      ...params?.override && { override: params.override },
      ...params?.io && { io: params.io }
    });
  }
  /**
   * Process a schema to prepare it for JSON Schema generation.
   * This must be called before emit().
   */
  process(schema, _params = { path: [], schemaPath: [] }) {
    return process2(schema, this.ctx, _params);
  }
  /**
   * Emit the final JSON Schema after processing.
   * Must call process() first.
   */
  emit(schema, _params) {
    if (_params) {
      if (_params.cycles)
        this.ctx.cycles = _params.cycles;
      if (_params.reused)
        this.ctx.reused = _params.reused;
      if (_params.external)
        this.ctx.external = _params.external;
    }
    extractDefs(this.ctx, schema);
    const result = finalize(this.ctx, schema);
    const { "~standard": _, ...plainResult } = result;
    return plainResult;
  }
};

// node_modules/zod/v4/core/json-schema.js
var json_schema_exports = {};

// node_modules/zod/v4/classic/schemas.js
var schemas_exports2 = {};
__export(schemas_exports2, {
  ZodAny: () => ZodAny,
  ZodArray: () => ZodArray,
  ZodBase64: () => ZodBase64,
  ZodBase64URL: () => ZodBase64URL,
  ZodBigInt: () => ZodBigInt,
  ZodBigIntFormat: () => ZodBigIntFormat,
  ZodBoolean: () => ZodBoolean,
  ZodCIDRv4: () => ZodCIDRv4,
  ZodCIDRv6: () => ZodCIDRv6,
  ZodCUID: () => ZodCUID,
  ZodCUID2: () => ZodCUID2,
  ZodCatch: () => ZodCatch,
  ZodCodec: () => ZodCodec,
  ZodCustom: () => ZodCustom,
  ZodCustomStringFormat: () => ZodCustomStringFormat,
  ZodDate: () => ZodDate,
  ZodDefault: () => ZodDefault,
  ZodDiscriminatedUnion: () => ZodDiscriminatedUnion,
  ZodE164: () => ZodE164,
  ZodEmail: () => ZodEmail,
  ZodEmoji: () => ZodEmoji,
  ZodEnum: () => ZodEnum,
  ZodExactOptional: () => ZodExactOptional,
  ZodFile: () => ZodFile,
  ZodFunction: () => ZodFunction,
  ZodGUID: () => ZodGUID,
  ZodIPv4: () => ZodIPv4,
  ZodIPv6: () => ZodIPv6,
  ZodIntersection: () => ZodIntersection,
  ZodJWT: () => ZodJWT,
  ZodKSUID: () => ZodKSUID,
  ZodLazy: () => ZodLazy,
  ZodLiteral: () => ZodLiteral,
  ZodMAC: () => ZodMAC,
  ZodMap: () => ZodMap,
  ZodNaN: () => ZodNaN,
  ZodNanoID: () => ZodNanoID,
  ZodNever: () => ZodNever,
  ZodNonOptional: () => ZodNonOptional,
  ZodNull: () => ZodNull,
  ZodNullable: () => ZodNullable,
  ZodNumber: () => ZodNumber,
  ZodNumberFormat: () => ZodNumberFormat,
  ZodObject: () => ZodObject,
  ZodOptional: () => ZodOptional,
  ZodPipe: () => ZodPipe,
  ZodPrefault: () => ZodPrefault,
  ZodPromise: () => ZodPromise,
  ZodReadonly: () => ZodReadonly,
  ZodRecord: () => ZodRecord,
  ZodSet: () => ZodSet,
  ZodString: () => ZodString,
  ZodStringFormat: () => ZodStringFormat,
  ZodSuccess: () => ZodSuccess,
  ZodSymbol: () => ZodSymbol,
  ZodTemplateLiteral: () => ZodTemplateLiteral,
  ZodTransform: () => ZodTransform,
  ZodTuple: () => ZodTuple,
  ZodType: () => ZodType,
  ZodULID: () => ZodULID,
  ZodURL: () => ZodURL,
  ZodUUID: () => ZodUUID,
  ZodUndefined: () => ZodUndefined,
  ZodUnion: () => ZodUnion,
  ZodUnknown: () => ZodUnknown,
  ZodVoid: () => ZodVoid,
  ZodXID: () => ZodXID,
  ZodXor: () => ZodXor,
  _ZodString: () => _ZodString,
  _default: () => _default2,
  _function: () => _function,
  any: () => any,
  array: () => array,
  base64: () => base642,
  base64url: () => base64url2,
  bigint: () => bigint2,
  boolean: () => boolean2,
  catch: () => _catch2,
  check: () => check,
  cidrv4: () => cidrv42,
  cidrv6: () => cidrv62,
  codec: () => codec,
  cuid: () => cuid3,
  cuid2: () => cuid22,
  custom: () => custom,
  date: () => date3,
  describe: () => describe2,
  discriminatedUnion: () => discriminatedUnion,
  e164: () => e1642,
  email: () => email2,
  emoji: () => emoji2,
  enum: () => _enum2,
  exactOptional: () => exactOptional,
  file: () => file,
  float32: () => float32,
  float64: () => float64,
  function: () => _function,
  guid: () => guid2,
  hash: () => hash,
  hex: () => hex2,
  hostname: () => hostname2,
  httpUrl: () => httpUrl,
  instanceof: () => _instanceof,
  int: () => int,
  int32: () => int32,
  int64: () => int64,
  intersection: () => intersection,
  ipv4: () => ipv42,
  ipv6: () => ipv62,
  json: () => json,
  jwt: () => jwt,
  keyof: () => keyof,
  ksuid: () => ksuid2,
  lazy: () => lazy,
  literal: () => literal,
  looseObject: () => looseObject,
  looseRecord: () => looseRecord,
  mac: () => mac2,
  map: () => map,
  meta: () => meta2,
  nan: () => nan,
  nanoid: () => nanoid2,
  nativeEnum: () => nativeEnum,
  never: () => never,
  nonoptional: () => nonoptional,
  null: () => _null3,
  nullable: () => nullable,
  nullish: () => nullish2,
  number: () => number2,
  object: () => object,
  optional: () => optional,
  partialRecord: () => partialRecord,
  pipe: () => pipe,
  prefault: () => prefault,
  preprocess: () => preprocess,
  promise: () => promise,
  readonly: () => readonly,
  record: () => record,
  refine: () => refine,
  set: () => set,
  strictObject: () => strictObject,
  string: () => string2,
  stringFormat: () => stringFormat,
  stringbool: () => stringbool,
  success: () => success,
  superRefine: () => superRefine,
  symbol: () => symbol,
  templateLiteral: () => templateLiteral,
  transform: () => transform,
  tuple: () => tuple,
  uint32: () => uint32,
  uint64: () => uint64,
  ulid: () => ulid2,
  undefined: () => _undefined3,
  union: () => union,
  unknown: () => unknown,
  url: () => url,
  uuid: () => uuid2,
  uuidv4: () => uuidv4,
  uuidv6: () => uuidv6,
  uuidv7: () => uuidv7,
  void: () => _void2,
  xid: () => xid2,
  xor: () => xor
});

// node_modules/zod/v4/classic/checks.js
var checks_exports2 = {};
__export(checks_exports2, {
  endsWith: () => _endsWith,
  gt: () => _gt,
  gte: () => _gte,
  includes: () => _includes,
  length: () => _length,
  lowercase: () => _lowercase,
  lt: () => _lt,
  lte: () => _lte,
  maxLength: () => _maxLength,
  maxSize: () => _maxSize,
  mime: () => _mime,
  minLength: () => _minLength,
  minSize: () => _minSize,
  multipleOf: () => _multipleOf,
  negative: () => _negative,
  nonnegative: () => _nonnegative,
  nonpositive: () => _nonpositive,
  normalize: () => _normalize,
  overwrite: () => _overwrite,
  positive: () => _positive,
  property: () => _property,
  regex: () => _regex,
  size: () => _size,
  slugify: () => _slugify,
  startsWith: () => _startsWith,
  toLowerCase: () => _toLowerCase,
  toUpperCase: () => _toUpperCase,
  trim: () => _trim,
  uppercase: () => _uppercase
});

// node_modules/zod/v4/classic/iso.js
var iso_exports = {};
__export(iso_exports, {
  ZodISODate: () => ZodISODate,
  ZodISODateTime: () => ZodISODateTime,
  ZodISODuration: () => ZodISODuration,
  ZodISOTime: () => ZodISOTime,
  date: () => date2,
  datetime: () => datetime2,
  duration: () => duration2,
  time: () => time2
});
var ZodISODateTime = /* @__PURE__ */ $constructor("ZodISODateTime", (inst, def) => {
  $ZodISODateTime.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function datetime2(params) {
  return _isoDateTime(ZodISODateTime, params);
}
var ZodISODate = /* @__PURE__ */ $constructor("ZodISODate", (inst, def) => {
  $ZodISODate.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function date2(params) {
  return _isoDate(ZodISODate, params);
}
var ZodISOTime = /* @__PURE__ */ $constructor("ZodISOTime", (inst, def) => {
  $ZodISOTime.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function time2(params) {
  return _isoTime(ZodISOTime, params);
}
var ZodISODuration = /* @__PURE__ */ $constructor("ZodISODuration", (inst, def) => {
  $ZodISODuration.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function duration2(params) {
  return _isoDuration(ZodISODuration, params);
}

// node_modules/zod/v4/classic/errors.js
var initializer2 = (inst, issues) => {
  $ZodError.init(inst, issues);
  inst.name = "ZodError";
  Object.defineProperties(inst, {
    format: {
      value: (mapper) => formatError(inst, mapper)
      // enumerable: false,
    },
    flatten: {
      value: (mapper) => flattenError(inst, mapper)
      // enumerable: false,
    },
    addIssue: {
      value: (issue2) => {
        inst.issues.push(issue2);
        inst.message = JSON.stringify(inst.issues, jsonStringifyReplacer, 2);
      }
      // enumerable: false,
    },
    addIssues: {
      value: (issues2) => {
        inst.issues.push(...issues2);
        inst.message = JSON.stringify(inst.issues, jsonStringifyReplacer, 2);
      }
      // enumerable: false,
    },
    isEmpty: {
      get() {
        return inst.issues.length === 0;
      }
      // enumerable: false,
    }
  });
};
var ZodError = $constructor("ZodError", initializer2);
var ZodRealError = $constructor("ZodError", initializer2, {
  Parent: Error
});

// node_modules/zod/v4/classic/parse.js
var parse2 = /* @__PURE__ */ _parse(ZodRealError);
var parseAsync2 = /* @__PURE__ */ _parseAsync(ZodRealError);
var safeParse2 = /* @__PURE__ */ _safeParse(ZodRealError);
var safeParseAsync2 = /* @__PURE__ */ _safeParseAsync(ZodRealError);
var encode2 = /* @__PURE__ */ _encode(ZodRealError);
var decode2 = /* @__PURE__ */ _decode(ZodRealError);
var encodeAsync2 = /* @__PURE__ */ _encodeAsync(ZodRealError);
var decodeAsync2 = /* @__PURE__ */ _decodeAsync(ZodRealError);
var safeEncode2 = /* @__PURE__ */ _safeEncode(ZodRealError);
var safeDecode2 = /* @__PURE__ */ _safeDecode(ZodRealError);
var safeEncodeAsync2 = /* @__PURE__ */ _safeEncodeAsync(ZodRealError);
var safeDecodeAsync2 = /* @__PURE__ */ _safeDecodeAsync(ZodRealError);

// node_modules/zod/v4/classic/schemas.js
var ZodType = /* @__PURE__ */ $constructor("ZodType", (inst, def) => {
  $ZodType.init(inst, def);
  Object.assign(inst["~standard"], {
    jsonSchema: {
      input: createStandardJSONSchemaMethod(inst, "input"),
      output: createStandardJSONSchemaMethod(inst, "output")
    }
  });
  inst.toJSONSchema = createToJSONSchemaMethod(inst, {});
  inst.def = def;
  inst.type = def.type;
  Object.defineProperty(inst, "_def", { value: def });
  inst.check = (...checks) => {
    return inst.clone(util_exports.mergeDefs(def, {
      checks: [
        ...def.checks ?? [],
        ...checks.map((ch) => typeof ch === "function" ? { _zod: { check: ch, def: { check: "custom" }, onattach: [] } } : ch)
      ]
    }), {
      parent: true
    });
  };
  inst.with = inst.check;
  inst.clone = (def2, params) => clone(inst, def2, params);
  inst.brand = () => inst;
  inst.register = ((reg, meta3) => {
    reg.add(inst, meta3);
    return inst;
  });
  inst.parse = (data, params) => parse2(inst, data, params, { callee: inst.parse });
  inst.safeParse = (data, params) => safeParse2(inst, data, params);
  inst.parseAsync = async (data, params) => parseAsync2(inst, data, params, { callee: inst.parseAsync });
  inst.safeParseAsync = async (data, params) => safeParseAsync2(inst, data, params);
  inst.spa = inst.safeParseAsync;
  inst.encode = (data, params) => encode2(inst, data, params);
  inst.decode = (data, params) => decode2(inst, data, params);
  inst.encodeAsync = async (data, params) => encodeAsync2(inst, data, params);
  inst.decodeAsync = async (data, params) => decodeAsync2(inst, data, params);
  inst.safeEncode = (data, params) => safeEncode2(inst, data, params);
  inst.safeDecode = (data, params) => safeDecode2(inst, data, params);
  inst.safeEncodeAsync = async (data, params) => safeEncodeAsync2(inst, data, params);
  inst.safeDecodeAsync = async (data, params) => safeDecodeAsync2(inst, data, params);
  inst.refine = (check2, params) => inst.check(refine(check2, params));
  inst.superRefine = (refinement) => inst.check(superRefine(refinement));
  inst.overwrite = (fn) => inst.check(_overwrite(fn));
  inst.optional = () => optional(inst);
  inst.exactOptional = () => exactOptional(inst);
  inst.nullable = () => nullable(inst);
  inst.nullish = () => optional(nullable(inst));
  inst.nonoptional = (params) => nonoptional(inst, params);
  inst.array = () => array(inst);
  inst.or = (arg) => union([inst, arg]);
  inst.and = (arg) => intersection(inst, arg);
  inst.transform = (tx) => pipe(inst, transform(tx));
  inst.default = (def2) => _default2(inst, def2);
  inst.prefault = (def2) => prefault(inst, def2);
  inst.catch = (params) => _catch2(inst, params);
  inst.pipe = (target) => pipe(inst, target);
  inst.readonly = () => readonly(inst);
  inst.describe = (description) => {
    const cl = inst.clone();
    globalRegistry.add(cl, { description });
    return cl;
  };
  Object.defineProperty(inst, "description", {
    get() {
      return globalRegistry.get(inst)?.description;
    },
    configurable: true
  });
  inst.meta = (...args) => {
    if (args.length === 0) {
      return globalRegistry.get(inst);
    }
    const cl = inst.clone();
    globalRegistry.add(cl, args[0]);
    return cl;
  };
  inst.isOptional = () => inst.safeParse(void 0).success;
  inst.isNullable = () => inst.safeParse(null).success;
  inst.apply = (fn) => fn(inst);
  return inst;
});
var _ZodString = /* @__PURE__ */ $constructor("_ZodString", (inst, def) => {
  $ZodString.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json2, params) => stringProcessor(inst, ctx, json2, params);
  const bag = inst._zod.bag;
  inst.format = bag.format ?? null;
  inst.minLength = bag.minimum ?? null;
  inst.maxLength = bag.maximum ?? null;
  inst.regex = (...args) => inst.check(_regex(...args));
  inst.includes = (...args) => inst.check(_includes(...args));
  inst.startsWith = (...args) => inst.check(_startsWith(...args));
  inst.endsWith = (...args) => inst.check(_endsWith(...args));
  inst.min = (...args) => inst.check(_minLength(...args));
  inst.max = (...args) => inst.check(_maxLength(...args));
  inst.length = (...args) => inst.check(_length(...args));
  inst.nonempty = (...args) => inst.check(_minLength(1, ...args));
  inst.lowercase = (params) => inst.check(_lowercase(params));
  inst.uppercase = (params) => inst.check(_uppercase(params));
  inst.trim = () => inst.check(_trim());
  inst.normalize = (...args) => inst.check(_normalize(...args));
  inst.toLowerCase = () => inst.check(_toLowerCase());
  inst.toUpperCase = () => inst.check(_toUpperCase());
  inst.slugify = () => inst.check(_slugify());
});
var ZodString = /* @__PURE__ */ $constructor("ZodString", (inst, def) => {
  $ZodString.init(inst, def);
  _ZodString.init(inst, def);
  inst.email = (params) => inst.check(_email(ZodEmail, params));
  inst.url = (params) => inst.check(_url(ZodURL, params));
  inst.jwt = (params) => inst.check(_jwt(ZodJWT, params));
  inst.emoji = (params) => inst.check(_emoji2(ZodEmoji, params));
  inst.guid = (params) => inst.check(_guid(ZodGUID, params));
  inst.uuid = (params) => inst.check(_uuid(ZodUUID, params));
  inst.uuidv4 = (params) => inst.check(_uuidv4(ZodUUID, params));
  inst.uuidv6 = (params) => inst.check(_uuidv6(ZodUUID, params));
  inst.uuidv7 = (params) => inst.check(_uuidv7(ZodUUID, params));
  inst.nanoid = (params) => inst.check(_nanoid(ZodNanoID, params));
  inst.guid = (params) => inst.check(_guid(ZodGUID, params));
  inst.cuid = (params) => inst.check(_cuid(ZodCUID, params));
  inst.cuid2 = (params) => inst.check(_cuid2(ZodCUID2, params));
  inst.ulid = (params) => inst.check(_ulid(ZodULID, params));
  inst.base64 = (params) => inst.check(_base64(ZodBase64, params));
  inst.base64url = (params) => inst.check(_base64url(ZodBase64URL, params));
  inst.xid = (params) => inst.check(_xid(ZodXID, params));
  inst.ksuid = (params) => inst.check(_ksuid(ZodKSUID, params));
  inst.ipv4 = (params) => inst.check(_ipv4(ZodIPv4, params));
  inst.ipv6 = (params) => inst.check(_ipv6(ZodIPv6, params));
  inst.cidrv4 = (params) => inst.check(_cidrv4(ZodCIDRv4, params));
  inst.cidrv6 = (params) => inst.check(_cidrv6(ZodCIDRv6, params));
  inst.e164 = (params) => inst.check(_e164(ZodE164, params));
  inst.datetime = (params) => inst.check(datetime2(params));
  inst.date = (params) => inst.check(date2(params));
  inst.time = (params) => inst.check(time2(params));
  inst.duration = (params) => inst.check(duration2(params));
});
function string2(params) {
  return _string(ZodString, params);
}
var ZodStringFormat = /* @__PURE__ */ $constructor("ZodStringFormat", (inst, def) => {
  $ZodStringFormat.init(inst, def);
  _ZodString.init(inst, def);
});
var ZodEmail = /* @__PURE__ */ $constructor("ZodEmail", (inst, def) => {
  $ZodEmail.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function email2(params) {
  return _email(ZodEmail, params);
}
var ZodGUID = /* @__PURE__ */ $constructor("ZodGUID", (inst, def) => {
  $ZodGUID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function guid2(params) {
  return _guid(ZodGUID, params);
}
var ZodUUID = /* @__PURE__ */ $constructor("ZodUUID", (inst, def) => {
  $ZodUUID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function uuid2(params) {
  return _uuid(ZodUUID, params);
}
function uuidv4(params) {
  return _uuidv4(ZodUUID, params);
}
function uuidv6(params) {
  return _uuidv6(ZodUUID, params);
}
function uuidv7(params) {
  return _uuidv7(ZodUUID, params);
}
var ZodURL = /* @__PURE__ */ $constructor("ZodURL", (inst, def) => {
  $ZodURL.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function url(params) {
  return _url(ZodURL, params);
}
function httpUrl(params) {
  return _url(ZodURL, {
    protocol: /^https?$/,
    hostname: regexes_exports.domain,
    ...util_exports.normalizeParams(params)
  });
}
var ZodEmoji = /* @__PURE__ */ $constructor("ZodEmoji", (inst, def) => {
  $ZodEmoji.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function emoji2(params) {
  return _emoji2(ZodEmoji, params);
}
var ZodNanoID = /* @__PURE__ */ $constructor("ZodNanoID", (inst, def) => {
  $ZodNanoID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function nanoid2(params) {
  return _nanoid(ZodNanoID, params);
}
var ZodCUID = /* @__PURE__ */ $constructor("ZodCUID", (inst, def) => {
  $ZodCUID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function cuid3(params) {
  return _cuid(ZodCUID, params);
}
var ZodCUID2 = /* @__PURE__ */ $constructor("ZodCUID2", (inst, def) => {
  $ZodCUID2.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function cuid22(params) {
  return _cuid2(ZodCUID2, params);
}
var ZodULID = /* @__PURE__ */ $constructor("ZodULID", (inst, def) => {
  $ZodULID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function ulid2(params) {
  return _ulid(ZodULID, params);
}
var ZodXID = /* @__PURE__ */ $constructor("ZodXID", (inst, def) => {
  $ZodXID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function xid2(params) {
  return _xid(ZodXID, params);
}
var ZodKSUID = /* @__PURE__ */ $constructor("ZodKSUID", (inst, def) => {
  $ZodKSUID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function ksuid2(params) {
  return _ksuid(ZodKSUID, params);
}
var ZodIPv4 = /* @__PURE__ */ $constructor("ZodIPv4", (inst, def) => {
  $ZodIPv4.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function ipv42(params) {
  return _ipv4(ZodIPv4, params);
}
var ZodMAC = /* @__PURE__ */ $constructor("ZodMAC", (inst, def) => {
  $ZodMAC.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function mac2(params) {
  return _mac(ZodMAC, params);
}
var ZodIPv6 = /* @__PURE__ */ $constructor("ZodIPv6", (inst, def) => {
  $ZodIPv6.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function ipv62(params) {
  return _ipv6(ZodIPv6, params);
}
var ZodCIDRv4 = /* @__PURE__ */ $constructor("ZodCIDRv4", (inst, def) => {
  $ZodCIDRv4.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function cidrv42(params) {
  return _cidrv4(ZodCIDRv4, params);
}
var ZodCIDRv6 = /* @__PURE__ */ $constructor("ZodCIDRv6", (inst, def) => {
  $ZodCIDRv6.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function cidrv62(params) {
  return _cidrv6(ZodCIDRv6, params);
}
var ZodBase64 = /* @__PURE__ */ $constructor("ZodBase64", (inst, def) => {
  $ZodBase64.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function base642(params) {
  return _base64(ZodBase64, params);
}
var ZodBase64URL = /* @__PURE__ */ $constructor("ZodBase64URL", (inst, def) => {
  $ZodBase64URL.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function base64url2(params) {
  return _base64url(ZodBase64URL, params);
}
var ZodE164 = /* @__PURE__ */ $constructor("ZodE164", (inst, def) => {
  $ZodE164.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function e1642(params) {
  return _e164(ZodE164, params);
}
var ZodJWT = /* @__PURE__ */ $constructor("ZodJWT", (inst, def) => {
  $ZodJWT.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function jwt(params) {
  return _jwt(ZodJWT, params);
}
var ZodCustomStringFormat = /* @__PURE__ */ $constructor("ZodCustomStringFormat", (inst, def) => {
  $ZodCustomStringFormat.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function stringFormat(format, fnOrRegex, _params = {}) {
  return _stringFormat(ZodCustomStringFormat, format, fnOrRegex, _params);
}
function hostname2(_params) {
  return _stringFormat(ZodCustomStringFormat, "hostname", regexes_exports.hostname, _params);
}
function hex2(_params) {
  return _stringFormat(ZodCustomStringFormat, "hex", regexes_exports.hex, _params);
}
function hash(alg, params) {
  const enc = params?.enc ?? "hex";
  const format = `${alg}_${enc}`;
  const regex = regexes_exports[format];
  if (!regex)
    throw new Error(`Unrecognized hash format: ${format}`);
  return _stringFormat(ZodCustomStringFormat, format, regex, params);
}
var ZodNumber = /* @__PURE__ */ $constructor("ZodNumber", (inst, def) => {
  $ZodNumber.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json2, params) => numberProcessor(inst, ctx, json2, params);
  inst.gt = (value, params) => inst.check(_gt(value, params));
  inst.gte = (value, params) => inst.check(_gte(value, params));
  inst.min = (value, params) => inst.check(_gte(value, params));
  inst.lt = (value, params) => inst.check(_lt(value, params));
  inst.lte = (value, params) => inst.check(_lte(value, params));
  inst.max = (value, params) => inst.check(_lte(value, params));
  inst.int = (params) => inst.check(int(params));
  inst.safe = (params) => inst.check(int(params));
  inst.positive = (params) => inst.check(_gt(0, params));
  inst.nonnegative = (params) => inst.check(_gte(0, params));
  inst.negative = (params) => inst.check(_lt(0, params));
  inst.nonpositive = (params) => inst.check(_lte(0, params));
  inst.multipleOf = (value, params) => inst.check(_multipleOf(value, params));
  inst.step = (value, params) => inst.check(_multipleOf(value, params));
  inst.finite = () => inst;
  const bag = inst._zod.bag;
  inst.minValue = Math.max(bag.minimum ?? Number.NEGATIVE_INFINITY, bag.exclusiveMinimum ?? Number.NEGATIVE_INFINITY) ?? null;
  inst.maxValue = Math.min(bag.maximum ?? Number.POSITIVE_INFINITY, bag.exclusiveMaximum ?? Number.POSITIVE_INFINITY) ?? null;
  inst.isInt = (bag.format ?? "").includes("int") || Number.isSafeInteger(bag.multipleOf ?? 0.5);
  inst.isFinite = true;
  inst.format = bag.format ?? null;
});
function number2(params) {
  return _number(ZodNumber, params);
}
var ZodNumberFormat = /* @__PURE__ */ $constructor("ZodNumberFormat", (inst, def) => {
  $ZodNumberFormat.init(inst, def);
  ZodNumber.init(inst, def);
});
function int(params) {
  return _int(ZodNumberFormat, params);
}
function float32(params) {
  return _float32(ZodNumberFormat, params);
}
function float64(params) {
  return _float64(ZodNumberFormat, params);
}
function int32(params) {
  return _int32(ZodNumberFormat, params);
}
function uint32(params) {
  return _uint32(ZodNumberFormat, params);
}
var ZodBoolean = /* @__PURE__ */ $constructor("ZodBoolean", (inst, def) => {
  $ZodBoolean.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json2, params) => booleanProcessor(inst, ctx, json2, params);
});
function boolean2(params) {
  return _boolean(ZodBoolean, params);
}
var ZodBigInt = /* @__PURE__ */ $constructor("ZodBigInt", (inst, def) => {
  $ZodBigInt.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json2, params) => bigintProcessor(inst, ctx, json2, params);
  inst.gte = (value, params) => inst.check(_gte(value, params));
  inst.min = (value, params) => inst.check(_gte(value, params));
  inst.gt = (value, params) => inst.check(_gt(value, params));
  inst.gte = (value, params) => inst.check(_gte(value, params));
  inst.min = (value, params) => inst.check(_gte(value, params));
  inst.lt = (value, params) => inst.check(_lt(value, params));
  inst.lte = (value, params) => inst.check(_lte(value, params));
  inst.max = (value, params) => inst.check(_lte(value, params));
  inst.positive = (params) => inst.check(_gt(BigInt(0), params));
  inst.negative = (params) => inst.check(_lt(BigInt(0), params));
  inst.nonpositive = (params) => inst.check(_lte(BigInt(0), params));
  inst.nonnegative = (params) => inst.check(_gte(BigInt(0), params));
  inst.multipleOf = (value, params) => inst.check(_multipleOf(value, params));
  const bag = inst._zod.bag;
  inst.minValue = bag.minimum ?? null;
  inst.maxValue = bag.maximum ?? null;
  inst.format = bag.format ?? null;
});
function bigint2(params) {
  return _bigint(ZodBigInt, params);
}
var ZodBigIntFormat = /* @__PURE__ */ $constructor("ZodBigIntFormat", (inst, def) => {
  $ZodBigIntFormat.init(inst, def);
  ZodBigInt.init(inst, def);
});
function int64(params) {
  return _int64(ZodBigIntFormat, params);
}
function uint64(params) {
  return _uint64(ZodBigIntFormat, params);
}
var ZodSymbol = /* @__PURE__ */ $constructor("ZodSymbol", (inst, def) => {
  $ZodSymbol.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json2, params) => symbolProcessor(inst, ctx, json2, params);
});
function symbol(params) {
  return _symbol(ZodSymbol, params);
}
var ZodUndefined = /* @__PURE__ */ $constructor("ZodUndefined", (inst, def) => {
  $ZodUndefined.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json2, params) => undefinedProcessor(inst, ctx, json2, params);
});
function _undefined3(params) {
  return _undefined2(ZodUndefined, params);
}
var ZodNull = /* @__PURE__ */ $constructor("ZodNull", (inst, def) => {
  $ZodNull.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json2, params) => nullProcessor(inst, ctx, json2, params);
});
function _null3(params) {
  return _null2(ZodNull, params);
}
var ZodAny = /* @__PURE__ */ $constructor("ZodAny", (inst, def) => {
  $ZodAny.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json2, params) => anyProcessor(inst, ctx, json2, params);
});
function any() {
  return _any(ZodAny);
}
var ZodUnknown = /* @__PURE__ */ $constructor("ZodUnknown", (inst, def) => {
  $ZodUnknown.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json2, params) => unknownProcessor(inst, ctx, json2, params);
});
function unknown() {
  return _unknown(ZodUnknown);
}
var ZodNever = /* @__PURE__ */ $constructor("ZodNever", (inst, def) => {
  $ZodNever.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json2, params) => neverProcessor(inst, ctx, json2, params);
});
function never(params) {
  return _never(ZodNever, params);
}
var ZodVoid = /* @__PURE__ */ $constructor("ZodVoid", (inst, def) => {
  $ZodVoid.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json2, params) => voidProcessor(inst, ctx, json2, params);
});
function _void2(params) {
  return _void(ZodVoid, params);
}
var ZodDate = /* @__PURE__ */ $constructor("ZodDate", (inst, def) => {
  $ZodDate.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json2, params) => dateProcessor(inst, ctx, json2, params);
  inst.min = (value, params) => inst.check(_gte(value, params));
  inst.max = (value, params) => inst.check(_lte(value, params));
  const c = inst._zod.bag;
  inst.minDate = c.minimum ? new Date(c.minimum) : null;
  inst.maxDate = c.maximum ? new Date(c.maximum) : null;
});
function date3(params) {
  return _date(ZodDate, params);
}
var ZodArray = /* @__PURE__ */ $constructor("ZodArray", (inst, def) => {
  $ZodArray.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json2, params) => arrayProcessor(inst, ctx, json2, params);
  inst.element = def.element;
  inst.min = (minLength, params) => inst.check(_minLength(minLength, params));
  inst.nonempty = (params) => inst.check(_minLength(1, params));
  inst.max = (maxLength, params) => inst.check(_maxLength(maxLength, params));
  inst.length = (len, params) => inst.check(_length(len, params));
  inst.unwrap = () => inst.element;
});
function array(element, params) {
  return _array(ZodArray, element, params);
}
function keyof(schema) {
  const shape = schema._zod.def.shape;
  return _enum2(Object.keys(shape));
}
var ZodObject = /* @__PURE__ */ $constructor("ZodObject", (inst, def) => {
  $ZodObjectJIT.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json2, params) => objectProcessor(inst, ctx, json2, params);
  util_exports.defineLazy(inst, "shape", () => {
    return def.shape;
  });
  inst.keyof = () => _enum2(Object.keys(inst._zod.def.shape));
  inst.catchall = (catchall) => inst.clone({ ...inst._zod.def, catchall });
  inst.passthrough = () => inst.clone({ ...inst._zod.def, catchall: unknown() });
  inst.loose = () => inst.clone({ ...inst._zod.def, catchall: unknown() });
  inst.strict = () => inst.clone({ ...inst._zod.def, catchall: never() });
  inst.strip = () => inst.clone({ ...inst._zod.def, catchall: void 0 });
  inst.extend = (incoming) => {
    return util_exports.extend(inst, incoming);
  };
  inst.safeExtend = (incoming) => {
    return util_exports.safeExtend(inst, incoming);
  };
  inst.merge = (other) => util_exports.merge(inst, other);
  inst.pick = (mask) => util_exports.pick(inst, mask);
  inst.omit = (mask) => util_exports.omit(inst, mask);
  inst.partial = (...args) => util_exports.partial(ZodOptional, inst, args[0]);
  inst.required = (...args) => util_exports.required(ZodNonOptional, inst, args[0]);
});
function object(shape, params) {
  const def = {
    type: "object",
    shape: shape ?? {},
    ...util_exports.normalizeParams(params)
  };
  return new ZodObject(def);
}
function strictObject(shape, params) {
  return new ZodObject({
    type: "object",
    shape,
    catchall: never(),
    ...util_exports.normalizeParams(params)
  });
}
function looseObject(shape, params) {
  return new ZodObject({
    type: "object",
    shape,
    catchall: unknown(),
    ...util_exports.normalizeParams(params)
  });
}
var ZodUnion = /* @__PURE__ */ $constructor("ZodUnion", (inst, def) => {
  $ZodUnion.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json2, params) => unionProcessor(inst, ctx, json2, params);
  inst.options = def.options;
});
function union(options, params) {
  return new ZodUnion({
    type: "union",
    options,
    ...util_exports.normalizeParams(params)
  });
}
var ZodXor = /* @__PURE__ */ $constructor("ZodXor", (inst, def) => {
  ZodUnion.init(inst, def);
  $ZodXor.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json2, params) => unionProcessor(inst, ctx, json2, params);
  inst.options = def.options;
});
function xor(options, params) {
  return new ZodXor({
    type: "union",
    options,
    inclusive: false,
    ...util_exports.normalizeParams(params)
  });
}
var ZodDiscriminatedUnion = /* @__PURE__ */ $constructor("ZodDiscriminatedUnion", (inst, def) => {
  ZodUnion.init(inst, def);
  $ZodDiscriminatedUnion.init(inst, def);
});
function discriminatedUnion(discriminator, options, params) {
  return new ZodDiscriminatedUnion({
    type: "union",
    options,
    discriminator,
    ...util_exports.normalizeParams(params)
  });
}
var ZodIntersection = /* @__PURE__ */ $constructor("ZodIntersection", (inst, def) => {
  $ZodIntersection.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json2, params) => intersectionProcessor(inst, ctx, json2, params);
});
function intersection(left, right) {
  return new ZodIntersection({
    type: "intersection",
    left,
    right
  });
}
var ZodTuple = /* @__PURE__ */ $constructor("ZodTuple", (inst, def) => {
  $ZodTuple.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json2, params) => tupleProcessor(inst, ctx, json2, params);
  inst.rest = (rest) => inst.clone({
    ...inst._zod.def,
    rest
  });
});
function tuple(items, _paramsOrRest, _params) {
  const hasRest = _paramsOrRest instanceof $ZodType;
  const params = hasRest ? _params : _paramsOrRest;
  const rest = hasRest ? _paramsOrRest : null;
  return new ZodTuple({
    type: "tuple",
    items,
    rest,
    ...util_exports.normalizeParams(params)
  });
}
var ZodRecord = /* @__PURE__ */ $constructor("ZodRecord", (inst, def) => {
  $ZodRecord.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json2, params) => recordProcessor(inst, ctx, json2, params);
  inst.keyType = def.keyType;
  inst.valueType = def.valueType;
});
function record(keyType, valueType, params) {
  return new ZodRecord({
    type: "record",
    keyType,
    valueType,
    ...util_exports.normalizeParams(params)
  });
}
function partialRecord(keyType, valueType, params) {
  const k = clone(keyType);
  k._zod.values = void 0;
  return new ZodRecord({
    type: "record",
    keyType: k,
    valueType,
    ...util_exports.normalizeParams(params)
  });
}
function looseRecord(keyType, valueType, params) {
  return new ZodRecord({
    type: "record",
    keyType,
    valueType,
    mode: "loose",
    ...util_exports.normalizeParams(params)
  });
}
var ZodMap = /* @__PURE__ */ $constructor("ZodMap", (inst, def) => {
  $ZodMap.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json2, params) => mapProcessor(inst, ctx, json2, params);
  inst.keyType = def.keyType;
  inst.valueType = def.valueType;
  inst.min = (...args) => inst.check(_minSize(...args));
  inst.nonempty = (params) => inst.check(_minSize(1, params));
  inst.max = (...args) => inst.check(_maxSize(...args));
  inst.size = (...args) => inst.check(_size(...args));
});
function map(keyType, valueType, params) {
  return new ZodMap({
    type: "map",
    keyType,
    valueType,
    ...util_exports.normalizeParams(params)
  });
}
var ZodSet = /* @__PURE__ */ $constructor("ZodSet", (inst, def) => {
  $ZodSet.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json2, params) => setProcessor(inst, ctx, json2, params);
  inst.min = (...args) => inst.check(_minSize(...args));
  inst.nonempty = (params) => inst.check(_minSize(1, params));
  inst.max = (...args) => inst.check(_maxSize(...args));
  inst.size = (...args) => inst.check(_size(...args));
});
function set(valueType, params) {
  return new ZodSet({
    type: "set",
    valueType,
    ...util_exports.normalizeParams(params)
  });
}
var ZodEnum = /* @__PURE__ */ $constructor("ZodEnum", (inst, def) => {
  $ZodEnum.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json2, params) => enumProcessor(inst, ctx, json2, params);
  inst.enum = def.entries;
  inst.options = Object.values(def.entries);
  const keys = new Set(Object.keys(def.entries));
  inst.extract = (values, params) => {
    const newEntries = {};
    for (const value of values) {
      if (keys.has(value)) {
        newEntries[value] = def.entries[value];
      } else
        throw new Error(`Key ${value} not found in enum`);
    }
    return new ZodEnum({
      ...def,
      checks: [],
      ...util_exports.normalizeParams(params),
      entries: newEntries
    });
  };
  inst.exclude = (values, params) => {
    const newEntries = { ...def.entries };
    for (const value of values) {
      if (keys.has(value)) {
        delete newEntries[value];
      } else
        throw new Error(`Key ${value} not found in enum`);
    }
    return new ZodEnum({
      ...def,
      checks: [],
      ...util_exports.normalizeParams(params),
      entries: newEntries
    });
  };
});
function _enum2(values, params) {
  const entries = Array.isArray(values) ? Object.fromEntries(values.map((v) => [v, v])) : values;
  return new ZodEnum({
    type: "enum",
    entries,
    ...util_exports.normalizeParams(params)
  });
}
function nativeEnum(entries, params) {
  return new ZodEnum({
    type: "enum",
    entries,
    ...util_exports.normalizeParams(params)
  });
}
var ZodLiteral = /* @__PURE__ */ $constructor("ZodLiteral", (inst, def) => {
  $ZodLiteral.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json2, params) => literalProcessor(inst, ctx, json2, params);
  inst.values = new Set(def.values);
  Object.defineProperty(inst, "value", {
    get() {
      if (def.values.length > 1) {
        throw new Error("This schema contains multiple valid literal values. Use `.values` instead.");
      }
      return def.values[0];
    }
  });
});
function literal(value, params) {
  return new ZodLiteral({
    type: "literal",
    values: Array.isArray(value) ? value : [value],
    ...util_exports.normalizeParams(params)
  });
}
var ZodFile = /* @__PURE__ */ $constructor("ZodFile", (inst, def) => {
  $ZodFile.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json2, params) => fileProcessor(inst, ctx, json2, params);
  inst.min = (size, params) => inst.check(_minSize(size, params));
  inst.max = (size, params) => inst.check(_maxSize(size, params));
  inst.mime = (types, params) => inst.check(_mime(Array.isArray(types) ? types : [types], params));
});
function file(params) {
  return _file(ZodFile, params);
}
var ZodTransform = /* @__PURE__ */ $constructor("ZodTransform", (inst, def) => {
  $ZodTransform.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json2, params) => transformProcessor(inst, ctx, json2, params);
  inst._zod.parse = (payload, _ctx) => {
    if (_ctx.direction === "backward") {
      throw new $ZodEncodeError(inst.constructor.name);
    }
    payload.addIssue = (issue2) => {
      if (typeof issue2 === "string") {
        payload.issues.push(util_exports.issue(issue2, payload.value, def));
      } else {
        const _issue = issue2;
        if (_issue.fatal)
          _issue.continue = false;
        _issue.code ?? (_issue.code = "custom");
        _issue.input ?? (_issue.input = payload.value);
        _issue.inst ?? (_issue.inst = inst);
        payload.issues.push(util_exports.issue(_issue));
      }
    };
    const output = def.transform(payload.value, payload);
    if (output instanceof Promise) {
      return output.then((output2) => {
        payload.value = output2;
        return payload;
      });
    }
    payload.value = output;
    return payload;
  };
});
function transform(fn) {
  return new ZodTransform({
    type: "transform",
    transform: fn
  });
}
var ZodOptional = /* @__PURE__ */ $constructor("ZodOptional", (inst, def) => {
  $ZodOptional.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json2, params) => optionalProcessor(inst, ctx, json2, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function optional(innerType) {
  return new ZodOptional({
    type: "optional",
    innerType
  });
}
var ZodExactOptional = /* @__PURE__ */ $constructor("ZodExactOptional", (inst, def) => {
  $ZodExactOptional.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json2, params) => optionalProcessor(inst, ctx, json2, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function exactOptional(innerType) {
  return new ZodExactOptional({
    type: "optional",
    innerType
  });
}
var ZodNullable = /* @__PURE__ */ $constructor("ZodNullable", (inst, def) => {
  $ZodNullable.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json2, params) => nullableProcessor(inst, ctx, json2, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function nullable(innerType) {
  return new ZodNullable({
    type: "nullable",
    innerType
  });
}
function nullish2(innerType) {
  return optional(nullable(innerType));
}
var ZodDefault = /* @__PURE__ */ $constructor("ZodDefault", (inst, def) => {
  $ZodDefault.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json2, params) => defaultProcessor(inst, ctx, json2, params);
  inst.unwrap = () => inst._zod.def.innerType;
  inst.removeDefault = inst.unwrap;
});
function _default2(innerType, defaultValue) {
  return new ZodDefault({
    type: "default",
    innerType,
    get defaultValue() {
      return typeof defaultValue === "function" ? defaultValue() : util_exports.shallowClone(defaultValue);
    }
  });
}
var ZodPrefault = /* @__PURE__ */ $constructor("ZodPrefault", (inst, def) => {
  $ZodPrefault.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json2, params) => prefaultProcessor(inst, ctx, json2, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function prefault(innerType, defaultValue) {
  return new ZodPrefault({
    type: "prefault",
    innerType,
    get defaultValue() {
      return typeof defaultValue === "function" ? defaultValue() : util_exports.shallowClone(defaultValue);
    }
  });
}
var ZodNonOptional = /* @__PURE__ */ $constructor("ZodNonOptional", (inst, def) => {
  $ZodNonOptional.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json2, params) => nonoptionalProcessor(inst, ctx, json2, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function nonoptional(innerType, params) {
  return new ZodNonOptional({
    type: "nonoptional",
    innerType,
    ...util_exports.normalizeParams(params)
  });
}
var ZodSuccess = /* @__PURE__ */ $constructor("ZodSuccess", (inst, def) => {
  $ZodSuccess.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json2, params) => successProcessor(inst, ctx, json2, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function success(innerType) {
  return new ZodSuccess({
    type: "success",
    innerType
  });
}
var ZodCatch = /* @__PURE__ */ $constructor("ZodCatch", (inst, def) => {
  $ZodCatch.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json2, params) => catchProcessor(inst, ctx, json2, params);
  inst.unwrap = () => inst._zod.def.innerType;
  inst.removeCatch = inst.unwrap;
});
function _catch2(innerType, catchValue) {
  return new ZodCatch({
    type: "catch",
    innerType,
    catchValue: typeof catchValue === "function" ? catchValue : () => catchValue
  });
}
var ZodNaN = /* @__PURE__ */ $constructor("ZodNaN", (inst, def) => {
  $ZodNaN.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json2, params) => nanProcessor(inst, ctx, json2, params);
});
function nan(params) {
  return _nan(ZodNaN, params);
}
var ZodPipe = /* @__PURE__ */ $constructor("ZodPipe", (inst, def) => {
  $ZodPipe.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json2, params) => pipeProcessor(inst, ctx, json2, params);
  inst.in = def.in;
  inst.out = def.out;
});
function pipe(in_, out) {
  return new ZodPipe({
    type: "pipe",
    in: in_,
    out
    // ...util.normalizeParams(params),
  });
}
var ZodCodec = /* @__PURE__ */ $constructor("ZodCodec", (inst, def) => {
  ZodPipe.init(inst, def);
  $ZodCodec.init(inst, def);
});
function codec(in_, out, params) {
  return new ZodCodec({
    type: "pipe",
    in: in_,
    out,
    transform: params.decode,
    reverseTransform: params.encode
  });
}
var ZodReadonly = /* @__PURE__ */ $constructor("ZodReadonly", (inst, def) => {
  $ZodReadonly.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json2, params) => readonlyProcessor(inst, ctx, json2, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function readonly(innerType) {
  return new ZodReadonly({
    type: "readonly",
    innerType
  });
}
var ZodTemplateLiteral = /* @__PURE__ */ $constructor("ZodTemplateLiteral", (inst, def) => {
  $ZodTemplateLiteral.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json2, params) => templateLiteralProcessor(inst, ctx, json2, params);
});
function templateLiteral(parts, params) {
  return new ZodTemplateLiteral({
    type: "template_literal",
    parts,
    ...util_exports.normalizeParams(params)
  });
}
var ZodLazy = /* @__PURE__ */ $constructor("ZodLazy", (inst, def) => {
  $ZodLazy.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json2, params) => lazyProcessor(inst, ctx, json2, params);
  inst.unwrap = () => inst._zod.def.getter();
});
function lazy(getter) {
  return new ZodLazy({
    type: "lazy",
    getter
  });
}
var ZodPromise = /* @__PURE__ */ $constructor("ZodPromise", (inst, def) => {
  $ZodPromise.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json2, params) => promiseProcessor(inst, ctx, json2, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function promise(innerType) {
  return new ZodPromise({
    type: "promise",
    innerType
  });
}
var ZodFunction = /* @__PURE__ */ $constructor("ZodFunction", (inst, def) => {
  $ZodFunction.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json2, params) => functionProcessor(inst, ctx, json2, params);
});
function _function(params) {
  return new ZodFunction({
    type: "function",
    input: Array.isArray(params?.input) ? tuple(params?.input) : params?.input ?? array(unknown()),
    output: params?.output ?? unknown()
  });
}
var ZodCustom = /* @__PURE__ */ $constructor("ZodCustom", (inst, def) => {
  $ZodCustom.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json2, params) => customProcessor(inst, ctx, json2, params);
});
function check(fn) {
  const ch = new $ZodCheck({
    check: "custom"
    // ...util.normalizeParams(params),
  });
  ch._zod.check = fn;
  return ch;
}
function custom(fn, _params) {
  return _custom(ZodCustom, fn ?? (() => true), _params);
}
function refine(fn, _params = {}) {
  return _refine(ZodCustom, fn, _params);
}
function superRefine(fn) {
  return _superRefine(fn);
}
var describe2 = describe;
var meta2 = meta;
function _instanceof(cls, params = {}) {
  const inst = new ZodCustom({
    type: "custom",
    check: "custom",
    fn: (data) => data instanceof cls,
    abort: true,
    ...util_exports.normalizeParams(params)
  });
  inst._zod.bag.Class = cls;
  inst._zod.check = (payload) => {
    if (!(payload.value instanceof cls)) {
      payload.issues.push({
        code: "invalid_type",
        expected: cls.name,
        input: payload.value,
        inst,
        path: [...inst._zod.def.path ?? []]
      });
    }
  };
  return inst;
}
var stringbool = (...args) => _stringbool({
  Codec: ZodCodec,
  Boolean: ZodBoolean,
  String: ZodString
}, ...args);
function json(params) {
  const jsonSchema = lazy(() => {
    return union([string2(params), number2(), boolean2(), _null3(), array(jsonSchema), record(string2(), jsonSchema)]);
  });
  return jsonSchema;
}
function preprocess(fn, schema) {
  return pipe(transform(fn), schema);
}

// node_modules/zod/v4/classic/compat.js
var ZodIssueCode = {
  invalid_type: "invalid_type",
  too_big: "too_big",
  too_small: "too_small",
  invalid_format: "invalid_format",
  not_multiple_of: "not_multiple_of",
  unrecognized_keys: "unrecognized_keys",
  invalid_union: "invalid_union",
  invalid_key: "invalid_key",
  invalid_element: "invalid_element",
  invalid_value: "invalid_value",
  custom: "custom"
};
function setErrorMap(map2) {
  config({
    customError: map2
  });
}
function getErrorMap() {
  return config().customError;
}
var ZodFirstPartyTypeKind;
/* @__PURE__ */ (function(ZodFirstPartyTypeKind2) {
})(ZodFirstPartyTypeKind || (ZodFirstPartyTypeKind = {}));

// node_modules/zod/v4/classic/from-json-schema.js
var z = {
  ...schemas_exports2,
  ...checks_exports2,
  iso: iso_exports
};
var RECOGNIZED_KEYS = /* @__PURE__ */ new Set([
  // Schema identification
  "$schema",
  "$ref",
  "$defs",
  "definitions",
  // Core schema keywords
  "$id",
  "id",
  "$comment",
  "$anchor",
  "$vocabulary",
  "$dynamicRef",
  "$dynamicAnchor",
  // Type
  "type",
  "enum",
  "const",
  // Composition
  "anyOf",
  "oneOf",
  "allOf",
  "not",
  // Object
  "properties",
  "required",
  "additionalProperties",
  "patternProperties",
  "propertyNames",
  "minProperties",
  "maxProperties",
  // Array
  "items",
  "prefixItems",
  "additionalItems",
  "minItems",
  "maxItems",
  "uniqueItems",
  "contains",
  "minContains",
  "maxContains",
  // String
  "minLength",
  "maxLength",
  "pattern",
  "format",
  // Number
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  // Already handled metadata
  "description",
  "default",
  // Content
  "contentEncoding",
  "contentMediaType",
  "contentSchema",
  // Unsupported (error-throwing)
  "unevaluatedItems",
  "unevaluatedProperties",
  "if",
  "then",
  "else",
  "dependentSchemas",
  "dependentRequired",
  // OpenAPI
  "nullable",
  "readOnly"
]);
function detectVersion(schema, defaultTarget) {
  const $schema = schema.$schema;
  if ($schema === "https://json-schema.org/draft/2020-12/schema") {
    return "draft-2020-12";
  }
  if ($schema === "http://json-schema.org/draft-07/schema#") {
    return "draft-7";
  }
  if ($schema === "http://json-schema.org/draft-04/schema#") {
    return "draft-4";
  }
  return defaultTarget ?? "draft-2020-12";
}
function resolveRef(ref, ctx) {
  if (!ref.startsWith("#")) {
    throw new Error("External $ref is not supported, only local refs (#/...) are allowed");
  }
  const path2 = ref.slice(1).split("/").filter(Boolean);
  if (path2.length === 0) {
    return ctx.rootSchema;
  }
  const defsKey = ctx.version === "draft-2020-12" ? "$defs" : "definitions";
  if (path2[0] === defsKey) {
    const key = path2[1];
    if (!key || !ctx.defs[key]) {
      throw new Error(`Reference not found: ${ref}`);
    }
    return ctx.defs[key];
  }
  throw new Error(`Reference not found: ${ref}`);
}
function convertBaseSchema(schema, ctx) {
  if (schema.not !== void 0) {
    if (typeof schema.not === "object" && Object.keys(schema.not).length === 0) {
      return z.never();
    }
    throw new Error("not is not supported in Zod (except { not: {} } for never)");
  }
  if (schema.unevaluatedItems !== void 0) {
    throw new Error("unevaluatedItems is not supported");
  }
  if (schema.unevaluatedProperties !== void 0) {
    throw new Error("unevaluatedProperties is not supported");
  }
  if (schema.if !== void 0 || schema.then !== void 0 || schema.else !== void 0) {
    throw new Error("Conditional schemas (if/then/else) are not supported");
  }
  if (schema.dependentSchemas !== void 0 || schema.dependentRequired !== void 0) {
    throw new Error("dependentSchemas and dependentRequired are not supported");
  }
  if (schema.$ref) {
    const refPath = schema.$ref;
    if (ctx.refs.has(refPath)) {
      return ctx.refs.get(refPath);
    }
    if (ctx.processing.has(refPath)) {
      return z.lazy(() => {
        if (!ctx.refs.has(refPath)) {
          throw new Error(`Circular reference not resolved: ${refPath}`);
        }
        return ctx.refs.get(refPath);
      });
    }
    ctx.processing.add(refPath);
    const resolved = resolveRef(refPath, ctx);
    const zodSchema2 = convertSchema(resolved, ctx);
    ctx.refs.set(refPath, zodSchema2);
    ctx.processing.delete(refPath);
    return zodSchema2;
  }
  if (schema.enum !== void 0) {
    const enumValues = schema.enum;
    if (ctx.version === "openapi-3.0" && schema.nullable === true && enumValues.length === 1 && enumValues[0] === null) {
      return z.null();
    }
    if (enumValues.length === 0) {
      return z.never();
    }
    if (enumValues.length === 1) {
      return z.literal(enumValues[0]);
    }
    if (enumValues.every((v) => typeof v === "string")) {
      return z.enum(enumValues);
    }
    const literalSchemas = enumValues.map((v) => z.literal(v));
    if (literalSchemas.length < 2) {
      return literalSchemas[0];
    }
    return z.union([literalSchemas[0], literalSchemas[1], ...literalSchemas.slice(2)]);
  }
  if (schema.const !== void 0) {
    return z.literal(schema.const);
  }
  const type = schema.type;
  if (Array.isArray(type)) {
    const typeSchemas = type.map((t) => {
      const typeSchema = { ...schema, type: t };
      return convertBaseSchema(typeSchema, ctx);
    });
    if (typeSchemas.length === 0) {
      return z.never();
    }
    if (typeSchemas.length === 1) {
      return typeSchemas[0];
    }
    return z.union(typeSchemas);
  }
  if (!type) {
    return z.any();
  }
  let zodSchema;
  switch (type) {
    case "string": {
      let stringSchema = z.string();
      if (schema.format) {
        const format = schema.format;
        if (format === "email") {
          stringSchema = stringSchema.check(z.email());
        } else if (format === "uri" || format === "uri-reference") {
          stringSchema = stringSchema.check(z.url());
        } else if (format === "uuid" || format === "guid") {
          stringSchema = stringSchema.check(z.uuid());
        } else if (format === "date-time") {
          stringSchema = stringSchema.check(z.iso.datetime());
        } else if (format === "date") {
          stringSchema = stringSchema.check(z.iso.date());
        } else if (format === "time") {
          stringSchema = stringSchema.check(z.iso.time());
        } else if (format === "duration") {
          stringSchema = stringSchema.check(z.iso.duration());
        } else if (format === "ipv4") {
          stringSchema = stringSchema.check(z.ipv4());
        } else if (format === "ipv6") {
          stringSchema = stringSchema.check(z.ipv6());
        } else if (format === "mac") {
          stringSchema = stringSchema.check(z.mac());
        } else if (format === "cidr") {
          stringSchema = stringSchema.check(z.cidrv4());
        } else if (format === "cidr-v6") {
          stringSchema = stringSchema.check(z.cidrv6());
        } else if (format === "base64") {
          stringSchema = stringSchema.check(z.base64());
        } else if (format === "base64url") {
          stringSchema = stringSchema.check(z.base64url());
        } else if (format === "e164") {
          stringSchema = stringSchema.check(z.e164());
        } else if (format === "jwt") {
          stringSchema = stringSchema.check(z.jwt());
        } else if (format === "emoji") {
          stringSchema = stringSchema.check(z.emoji());
        } else if (format === "nanoid") {
          stringSchema = stringSchema.check(z.nanoid());
        } else if (format === "cuid") {
          stringSchema = stringSchema.check(z.cuid());
        } else if (format === "cuid2") {
          stringSchema = stringSchema.check(z.cuid2());
        } else if (format === "ulid") {
          stringSchema = stringSchema.check(z.ulid());
        } else if (format === "xid") {
          stringSchema = stringSchema.check(z.xid());
        } else if (format === "ksuid") {
          stringSchema = stringSchema.check(z.ksuid());
        }
      }
      if (typeof schema.minLength === "number") {
        stringSchema = stringSchema.min(schema.minLength);
      }
      if (typeof schema.maxLength === "number") {
        stringSchema = stringSchema.max(schema.maxLength);
      }
      if (schema.pattern) {
        stringSchema = stringSchema.regex(new RegExp(schema.pattern));
      }
      zodSchema = stringSchema;
      break;
    }
    case "number":
    case "integer": {
      let numberSchema = type === "integer" ? z.number().int() : z.number();
      if (typeof schema.minimum === "number") {
        numberSchema = numberSchema.min(schema.minimum);
      }
      if (typeof schema.maximum === "number") {
        numberSchema = numberSchema.max(schema.maximum);
      }
      if (typeof schema.exclusiveMinimum === "number") {
        numberSchema = numberSchema.gt(schema.exclusiveMinimum);
      } else if (schema.exclusiveMinimum === true && typeof schema.minimum === "number") {
        numberSchema = numberSchema.gt(schema.minimum);
      }
      if (typeof schema.exclusiveMaximum === "number") {
        numberSchema = numberSchema.lt(schema.exclusiveMaximum);
      } else if (schema.exclusiveMaximum === true && typeof schema.maximum === "number") {
        numberSchema = numberSchema.lt(schema.maximum);
      }
      if (typeof schema.multipleOf === "number") {
        numberSchema = numberSchema.multipleOf(schema.multipleOf);
      }
      zodSchema = numberSchema;
      break;
    }
    case "boolean": {
      zodSchema = z.boolean();
      break;
    }
    case "null": {
      zodSchema = z.null();
      break;
    }
    case "object": {
      const shape = {};
      const properties = schema.properties || {};
      const requiredSet = new Set(schema.required || []);
      for (const [key, propSchema] of Object.entries(properties)) {
        const propZodSchema = convertSchema(propSchema, ctx);
        shape[key] = requiredSet.has(key) ? propZodSchema : propZodSchema.optional();
      }
      if (schema.propertyNames) {
        const keySchema = convertSchema(schema.propertyNames, ctx);
        const valueSchema = schema.additionalProperties && typeof schema.additionalProperties === "object" ? convertSchema(schema.additionalProperties, ctx) : z.any();
        if (Object.keys(shape).length === 0) {
          zodSchema = z.record(keySchema, valueSchema);
          break;
        }
        const objectSchema2 = z.object(shape).passthrough();
        const recordSchema = z.looseRecord(keySchema, valueSchema);
        zodSchema = z.intersection(objectSchema2, recordSchema);
        break;
      }
      if (schema.patternProperties) {
        const patternProps = schema.patternProperties;
        const patternKeys = Object.keys(patternProps);
        const looseRecords = [];
        for (const pattern of patternKeys) {
          const patternValue = convertSchema(patternProps[pattern], ctx);
          const keySchema = z.string().regex(new RegExp(pattern));
          looseRecords.push(z.looseRecord(keySchema, patternValue));
        }
        const schemasToIntersect = [];
        if (Object.keys(shape).length > 0) {
          schemasToIntersect.push(z.object(shape).passthrough());
        }
        schemasToIntersect.push(...looseRecords);
        if (schemasToIntersect.length === 0) {
          zodSchema = z.object({}).passthrough();
        } else if (schemasToIntersect.length === 1) {
          zodSchema = schemasToIntersect[0];
        } else {
          let result = z.intersection(schemasToIntersect[0], schemasToIntersect[1]);
          for (let i = 2; i < schemasToIntersect.length; i++) {
            result = z.intersection(result, schemasToIntersect[i]);
          }
          zodSchema = result;
        }
        break;
      }
      const objectSchema = z.object(shape);
      if (schema.additionalProperties === false) {
        zodSchema = objectSchema.strict();
      } else if (typeof schema.additionalProperties === "object") {
        zodSchema = objectSchema.catchall(convertSchema(schema.additionalProperties, ctx));
      } else {
        zodSchema = objectSchema.passthrough();
      }
      break;
    }
    case "array": {
      const prefixItems = schema.prefixItems;
      const items = schema.items;
      if (prefixItems && Array.isArray(prefixItems)) {
        const tupleItems = prefixItems.map((item) => convertSchema(item, ctx));
        const rest = items && typeof items === "object" && !Array.isArray(items) ? convertSchema(items, ctx) : void 0;
        if (rest) {
          zodSchema = z.tuple(tupleItems).rest(rest);
        } else {
          zodSchema = z.tuple(tupleItems);
        }
        if (typeof schema.minItems === "number") {
          zodSchema = zodSchema.check(z.minLength(schema.minItems));
        }
        if (typeof schema.maxItems === "number") {
          zodSchema = zodSchema.check(z.maxLength(schema.maxItems));
        }
      } else if (Array.isArray(items)) {
        const tupleItems = items.map((item) => convertSchema(item, ctx));
        const rest = schema.additionalItems && typeof schema.additionalItems === "object" ? convertSchema(schema.additionalItems, ctx) : void 0;
        if (rest) {
          zodSchema = z.tuple(tupleItems).rest(rest);
        } else {
          zodSchema = z.tuple(tupleItems);
        }
        if (typeof schema.minItems === "number") {
          zodSchema = zodSchema.check(z.minLength(schema.minItems));
        }
        if (typeof schema.maxItems === "number") {
          zodSchema = zodSchema.check(z.maxLength(schema.maxItems));
        }
      } else if (items !== void 0) {
        const element = convertSchema(items, ctx);
        let arraySchema = z.array(element);
        if (typeof schema.minItems === "number") {
          arraySchema = arraySchema.min(schema.minItems);
        }
        if (typeof schema.maxItems === "number") {
          arraySchema = arraySchema.max(schema.maxItems);
        }
        zodSchema = arraySchema;
      } else {
        zodSchema = z.array(z.any());
      }
      break;
    }
    default:
      throw new Error(`Unsupported type: ${type}`);
  }
  if (schema.description) {
    zodSchema = zodSchema.describe(schema.description);
  }
  if (schema.default !== void 0) {
    zodSchema = zodSchema.default(schema.default);
  }
  return zodSchema;
}
function convertSchema(schema, ctx) {
  if (typeof schema === "boolean") {
    return schema ? z.any() : z.never();
  }
  let baseSchema = convertBaseSchema(schema, ctx);
  const hasExplicitType = schema.type || schema.enum !== void 0 || schema.const !== void 0;
  if (schema.anyOf && Array.isArray(schema.anyOf)) {
    const options = schema.anyOf.map((s) => convertSchema(s, ctx));
    const anyOfUnion = z.union(options);
    baseSchema = hasExplicitType ? z.intersection(baseSchema, anyOfUnion) : anyOfUnion;
  }
  if (schema.oneOf && Array.isArray(schema.oneOf)) {
    const options = schema.oneOf.map((s) => convertSchema(s, ctx));
    const oneOfUnion = z.xor(options);
    baseSchema = hasExplicitType ? z.intersection(baseSchema, oneOfUnion) : oneOfUnion;
  }
  if (schema.allOf && Array.isArray(schema.allOf)) {
    if (schema.allOf.length === 0) {
      baseSchema = hasExplicitType ? baseSchema : z.any();
    } else {
      let result = hasExplicitType ? baseSchema : convertSchema(schema.allOf[0], ctx);
      const startIdx = hasExplicitType ? 0 : 1;
      for (let i = startIdx; i < schema.allOf.length; i++) {
        result = z.intersection(result, convertSchema(schema.allOf[i], ctx));
      }
      baseSchema = result;
    }
  }
  if (schema.nullable === true && ctx.version === "openapi-3.0") {
    baseSchema = z.nullable(baseSchema);
  }
  if (schema.readOnly === true) {
    baseSchema = z.readonly(baseSchema);
  }
  const extraMeta = {};
  const coreMetadataKeys = ["$id", "id", "$comment", "$anchor", "$vocabulary", "$dynamicRef", "$dynamicAnchor"];
  for (const key of coreMetadataKeys) {
    if (key in schema) {
      extraMeta[key] = schema[key];
    }
  }
  const contentMetadataKeys = ["contentEncoding", "contentMediaType", "contentSchema"];
  for (const key of contentMetadataKeys) {
    if (key in schema) {
      extraMeta[key] = schema[key];
    }
  }
  for (const key of Object.keys(schema)) {
    if (!RECOGNIZED_KEYS.has(key)) {
      extraMeta[key] = schema[key];
    }
  }
  if (Object.keys(extraMeta).length > 0) {
    ctx.registry.add(baseSchema, extraMeta);
  }
  return baseSchema;
}
function fromJSONSchema(schema, params) {
  if (typeof schema === "boolean") {
    return schema ? z.any() : z.never();
  }
  const version2 = detectVersion(schema, params?.defaultTarget);
  const defs = schema.$defs || schema.definitions || {};
  const ctx = {
    version: version2,
    defs,
    refs: /* @__PURE__ */ new Map(),
    processing: /* @__PURE__ */ new Set(),
    rootSchema: schema,
    registry: params?.registry ?? globalRegistry
  };
  return convertSchema(schema, ctx);
}

// node_modules/zod/v4/classic/coerce.js
var coerce_exports = {};
__export(coerce_exports, {
  bigint: () => bigint3,
  boolean: () => boolean3,
  date: () => date4,
  number: () => number3,
  string: () => string3
});
function string3(params) {
  return _coercedString(ZodString, params);
}
function number3(params) {
  return _coercedNumber(ZodNumber, params);
}
function boolean3(params) {
  return _coercedBoolean(ZodBoolean, params);
}
function bigint3(params) {
  return _coercedBigint(ZodBigInt, params);
}
function date4(params) {
  return _coercedDate(ZodDate, params);
}

// node_modules/zod/v4/classic/external.js
config(en_default());

// src/rules/schema.ts
var TRIGGER_INDEX_SLOT_LIMIT = 10;
var nonEmptyString = external_exports.string().min(1);
var promptTriggerSpecSchema = external_exports.object({
  kind: external_exports.literal("prompt"),
  keywords: external_exports.array(external_exports.string().min(3)).min(1).max(8),
  match: external_exports.enum(["any", "all"]).default("any")
}).strict();
var toolTriggerSpecSchema = external_exports.object({
  kind: external_exports.literal("tool"),
  tool: nonEmptyString,
  require_param: nonEmptyString.optional(),
  param_absent: nonEmptyString.optional(),
  command_prefix: external_exports.array(nonEmptyString).min(1).max(4).optional(),
  path_glob: nonEmptyString.optional()
}).strict();
var resultTriggerSpecSchema = external_exports.object({
  kind: external_exports.literal("result"),
  tool: nonEmptyString.optional(),
  patterns: external_exports.array(external_exports.string().min(1).max(64)).min(1).max(4)
}).strict();
var triggerSpecSchema = external_exports.discriminatedUnion("kind", [
  promptTriggerSpecSchema,
  toolTriggerSpecSchema,
  resultTriggerSpecSchema
]);
var ruleStatusSchema = external_exports.enum([
  "provisional",
  "confirmed",
  "refuted",
  "retired",
  "digest_only"
]);
var ruleEvidenceSchema = external_exports.object({
  ref: nonEmptyString,
  note: nonEmptyString,
  at: external_exports.number().int().nonnegative()
}).strict();
var triggerIndexRuleSchema = external_exports.object({
  id: external_exports.number().int().positive(),
  name: nonEmptyString,
  claim: external_exports.string().min(1).max(300),
  scope: nonEmptyString,
  trigger: triggerSpecSchema
}).strict();
var triggerIndexSchema = external_exports.object({
  version: external_exports.literal(1),
  // The shared file is a union of independent per-project pools. Runtime
  // dispatch filters to global + cwd and then enforces the ten-slot cap.
  rules: external_exports.array(triggerIndexRuleSchema)
}).strict();

// src/db/rules.ts
var MAX_TRIGGER_SPEC_BYTES = 1024;
var RULE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
var RULE_SELECT = `
  SELECT id, name, claim, rationale, scope,
         trigger_kind AS triggerKind, trigger_spec AS triggerSpec,
         status, evidence, created_at_epoch AS createdAtEpoch,
         updated_at_epoch AS updatedAtEpoch,
         last_evidence_at_epoch AS lastEvidenceAtEpoch
  FROM rules
`;
var RULE_RETURNING = `
  id, name, claim, rationale, scope,
  trigger_kind AS triggerKind, trigger_spec AS triggerSpec,
  status, evidence, created_at_epoch AS createdAtEpoch,
  updated_at_epoch AS updatedAtEpoch,
  last_evidence_at_epoch AS lastEvidenceAtEpoch
`;
function assertEpoch(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative epoch-second integer`);
  }
}
function validateRule(input) {
  if (!RULE_NAME.test(input.name)) throw new Error("name must be kebab-case");
  if (input.claim.length === 0 || input.claim.length > 300) {
    throw new Error("claim must contain at most 300 characters");
  }
  if (input.rationale.length === 0) throw new Error("rationale is required");
  if (input.scope !== "global" && !(0, import_node_path10.isAbsolute)(input.scope)) {
    throw new Error("scope must be global or an absolute project path");
  }
  ruleStatusSchema.parse(input.status);
  assertEpoch(input.createdAtEpoch, "createdAtEpoch");
  assertEpoch(input.updatedAtEpoch ?? input.createdAtEpoch, "updatedAtEpoch");
  assertEpoch(
    input.lastEvidenceAtEpoch ?? input.createdAtEpoch,
    "lastEvidenceAtEpoch"
  );
  let triggerSpecJson = null;
  if (input.triggerKind === "none") {
    if (input.triggerSpec !== null) {
      throw new Error("triggerSpec must be null when triggerKind is none");
    }
  } else {
    const parsed = triggerSpecSchema.parse(input.triggerSpec);
    if (parsed.kind !== input.triggerKind) {
      throw new Error("triggerKind must match triggerSpec.kind");
    }
    triggerSpecJson = JSON.stringify(parsed);
    if (Buffer.byteLength(triggerSpecJson, "utf8") > MAX_TRIGGER_SPEC_BYTES) {
      throw new Error("triggerSpec must be at most 1KB");
    }
  }
  const evidence = (input.evidence ?? []).map(
    (item) => ruleEvidenceSchema.parse(item)
  );
  return { triggerSpecJson, evidenceJson: JSON.stringify(evidence) };
}
function mapRule(row) {
  return {
    ...row,
    triggerSpec: row.triggerSpec === null ? null : triggerSpecSchema.parse(JSON.parse(row.triggerSpec)),
    evidence: ruleEvidenceSchema.array().parse(JSON.parse(row.evidence))
  };
}
function mapEvent(row) {
  const { adjustmentJson, ...event } = row;
  return {
    ...event,
    adjustment: adjustmentJson === null ? null : JSON.parse(adjustmentJson)
  };
}
function insertEvent(db, input) {
  assertEpoch(input.createdAtEpoch, "createdAtEpoch");
  if (input.eventKind === "judgment") {
    if (input.sourceEventId == null) {
      throw new Error("judgment events require sourceEventId");
    }
    const source = db.query(
      `SELECT event_kind AS eventKind, rule_id AS ruleId
       FROM rule_events WHERE id = ?`
    ).get(input.sourceEventId);
    if (source?.eventKind !== "hit" || source.ruleId !== input.ruleId) {
      throw new Error("sourceEventId must reference a hit for the same rule");
    }
  } else if (input.sourceEventId != null) {
    throw new Error("sourceEventId is only valid for judgment events");
  }
  const row = db.query(
    `INSERT INTO rule_events (
       event_uid, rule_id, event_kind, source_event_id, turn_ref, label,
       rationale, adjustment_json, status_before, status_after, created_at_epoch
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id, event_uid AS eventUid, rule_id AS ruleId,
       event_kind AS eventKind, source_event_id AS sourceEventId,
       turn_ref AS turnRef, label, rationale, adjustment_json AS adjustmentJson,
       status_before AS statusBefore, status_after AS statusAfter,
       created_at_epoch AS createdAtEpoch`
  ).get(
    input.eventUid,
    input.ruleId,
    input.eventKind,
    input.sourceEventId ?? null,
    input.turnRef ?? null,
    input.label ?? null,
    input.rationale ?? null,
    input.adjustment == null ? null : JSON.stringify(input.adjustment),
    input.statusBefore ?? null,
    input.statusAfter ?? null,
    input.createdAtEpoch
  );
  if (!row) throw new Error("failed to create rule event");
  return mapEvent(row);
}
function createRuleStore(db) {
  return {
    create(input) {
      const validated = validateRule(input);
      const updatedAt = input.updatedAtEpoch ?? input.createdAtEpoch;
      const lastEvidenceAt = input.lastEvidenceAtEpoch ?? input.createdAtEpoch;
      const row = db.query(
        `INSERT INTO rules (
           name, claim, rationale, scope, trigger_kind, trigger_spec, status,
           evidence, created_at_epoch, updated_at_epoch, last_evidence_at_epoch
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING ${RULE_RETURNING}`
      ).get(
        input.name,
        input.claim,
        input.rationale,
        input.scope,
        input.triggerKind,
        validated.triggerSpecJson,
        input.status,
        validated.evidenceJson,
        input.createdAtEpoch,
        updatedAt,
        lastEvidenceAt
      );
      if (!row) throw new Error("failed to create rule");
      const rule = mapRule(row);
      indexRuleToFTS(db, rule);
      return rule;
    },
    get(id) {
      const row = db.query(`${RULE_SELECT} WHERE id = ?`).get(id);
      return row ? mapRule(row) : null;
    },
    list() {
      return db.query(`${RULE_SELECT} ORDER BY id`).all().map(mapRule);
    },
    update(id, input) {
      return runWriteTransaction(db, () => {
        const current = this.get(id);
        if (!current) throw new Error(`rule ${id} not found`);
        const nextInput = {
          ...current,
          ...input,
          triggerSpec: input.triggerSpec === void 0 ? current.triggerSpec : input.triggerSpec,
          createdAtEpoch: current.createdAtEpoch,
          updatedAtEpoch: input.updatedAtEpoch,
          lastEvidenceAtEpoch: input.lastEvidenceAtEpoch ?? current.lastEvidenceAtEpoch
        };
        const validated = validateRule(nextInput);
        db.query(
          `UPDATE rules SET name = ?, claim = ?, rationale = ?, scope = ?,
             trigger_kind = ?, trigger_spec = ?, status = ?, evidence = ?,
             updated_at_epoch = ?, last_evidence_at_epoch = ?
           WHERE id = ?`
        ).run(
          nextInput.name,
          nextInput.claim,
          nextInput.rationale,
          nextInput.scope,
          nextInput.triggerKind,
          validated.triggerSpecJson,
          nextInput.status,
          validated.evidenceJson,
          input.updatedAtEpoch,
          nextInput.lastEvidenceAtEpoch ?? current.lastEvidenceAtEpoch,
          id
        );
        if (current.status !== nextInput.status) {
          if (!input.event) {
            throw new Error("status changes require a rule event");
          }
          insertEvent(db, {
            ...input.event,
            ruleId: id,
            statusBefore: current.status,
            statusAfter: nextInput.status,
            createdAtEpoch: input.updatedAtEpoch
          });
        }
        const updated = this.get(id);
        indexRuleToFTS(db, updated);
        return updated;
      });
    },
    createEvent(input) {
      return insertEvent(db, input);
    },
    getEventByUid(eventUid) {
      const row = db.query(
        `SELECT id, event_uid AS eventUid, rule_id AS ruleId,
           event_kind AS eventKind, source_event_id AS sourceEventId,
           turn_ref AS turnRef, label, rationale,
           adjustment_json AS adjustmentJson, status_before AS statusBefore,
           status_after AS statusAfter, created_at_epoch AS createdAtEpoch
         FROM rule_events WHERE event_uid = ?`
      ).get(eventUid);
      return row ? mapEvent(row) : null;
    },
    getJudgmentBySourceEventId(sourceEventId) {
      const row = db.query(
        `SELECT id, event_uid AS eventUid, rule_id AS ruleId,
           event_kind AS eventKind, source_event_id AS sourceEventId,
           turn_ref AS turnRef, label, rationale,
           adjustment_json AS adjustmentJson, status_before AS statusBefore,
           status_after AS statusAfter, created_at_epoch AS createdAtEpoch
         FROM rule_events
         WHERE event_kind = 'judgment' AND source_event_id = ?`
      ).get(sourceEventId);
      return row ? mapEvent(row) : null;
    },
    getLatestTombstoneReason(ruleId) {
      return db.query(
        `SELECT rationale
         FROM rule_events
         WHERE rule_id = ?
           AND status_after IN ('refuted', 'retired')
           AND rationale IS NOT NULL
           AND length(trim(rationale)) > 0
         ORDER BY id DESC LIMIT 1`
      ).get(ruleId)?.rationale ?? null;
    },
    listEvents(ruleId) {
      return db.query(
        `SELECT id, event_uid AS eventUid, rule_id AS ruleId,
           event_kind AS eventKind, source_event_id AS sourceEventId,
           turn_ref AS turnRef, label, rationale,
           adjustment_json AS adjustmentJson, status_before AS statusBefore,
           status_after AS statusAfter, created_at_epoch AS createdAtEpoch
         FROM rule_events WHERE rule_id = ? ORDER BY id`
      ).all(ruleId).map(mapEvent);
    }
  };
}

// src/rules/digest.ts
var import_node_path11 = require("node:path");
var RULE_DIGEST_TOKEN_BUDGET = 500;
var STATUS_PRIORITY = {
  confirmed: 0,
  provisional: 1,
  digest_only: 2
};
function describeTrigger(trigger) {
  if (trigger === null) {
    return "\u7531\u4F60\u6839\u636E\u89C4\u5219\u6B63\u6587\u4E2D\u7684\u6761\u4EF6\u81EA\u6211\u5339\u914D";
  }
  if (trigger.kind === "prompt") {
    const quantifier = trigger.match === "all" ? "\u5168\u90E8" : "\u4EFB\u4E00";
    return `\u7528\u6237\u8BF7\u6C42\u5305\u542B${quantifier}\u5173\u952E\u8BCD\uFF1A${trigger.keywords.join("\u3001")}`;
  }
  if (trigger.kind === "result") {
    const tool = trigger.tool ? `${trigger.tool} \u7684` : "\u5DE5\u5177";
    return `${tool}\u7ED3\u679C\u5305\u542B\u4EFB\u4E00\u7247\u6BB5\uFF1A${trigger.patterns.join("\u3001")}`;
  }
  const conditions = [`\u8C03\u7528 ${trigger.tool}`];
  if (trigger.require_param) conditions.push(`\u5B58\u5728\u53C2\u6570 ${trigger.require_param}`);
  if (trigger.param_absent) conditions.push(`\u7F3A\u5C11\u53C2\u6570 ${trigger.param_absent}`);
  if (trigger.command_prefix) {
    conditions.push(`\u547D\u4EE4\u524D\u7F00\u4E3A ${trigger.command_prefix.join(" ")}`);
  }
  if (trigger.path_glob) conditions.push(`\u8DEF\u5F84\u5339\u914D ${trigger.path_glob}`);
  return conditions.join("\uFF0C\u4E14");
}
function statusLabel(status) {
  if (status === "confirmed") return "\u5DF2\u786E\u8BA4";
  if (status === "provisional") return "\u5F85\u9A8C\u8BC1";
  return "\u6458\u8981\u89C4\u5219";
}
function renderItem(rule) {
  const scope = rule.scope === "global" ? "\u6240\u6709\u9879\u76EE" : "\u4EC5\u5F53\u524D\u9879\u76EE";
  return `- [${statusLabel(rule.status)}] **${rule.name}** \u2014 \u9002\u7528\u8303\u56F4\uFF1A${scope}\uFF1B\u60C5\u5883\uFF1A${describeTrigger(rule.triggerSpec)}\uFF1B\u89C4\u5219\uFF1A${rule.claim}`;
}
function compareRules(left, right) {
  const statusDelta = STATUS_PRIORITY[left.status] - STATUS_PRIORITY[right.status];
  if (statusDelta !== 0) return statusDelta;
  if (left.lastEvidenceAtEpoch !== right.lastEvidenceAtEpoch) {
    return right.lastEvidenceAtEpoch - left.lastEvidenceAtEpoch;
  }
  return left.id - right.id;
}
function renderRuleDigest(input) {
  const project = input.project ? (0, import_node_path11.resolve)(input.project) : null;
  const candidates = input.rules.filter(
    (rule) => ["confirmed", "provisional", "digest_only"].includes(rule.status) && (rule.triggerKind === "none" || rule.status === "digest_only") && (rule.scope === "global" || project !== null && (0, import_node_path11.resolve)(rule.scope) === project)
  ).sort(compareRules);
  if (candidates.length === 0) return "";
  const budget = input.tokenBudget ?? RULE_DIGEST_TOKEN_BUDGET;
  const lines = ["## Rule Digest"];
  for (const rule of candidates) {
    const candidate = [...lines, "", renderItem(rule)].join("\n");
    if (estimateDiaryTokens(candidate) > budget) break;
    lines.push("", renderItem(rule));
  }
  return lines.length > 1 ? lines.join("\n") : "";
}

// src/hooks/handlers/context.ts
var EMPTY_CONTEXT_FALLBACK = "claude-mnemo memory available via recall() and the mnemo-replay skill.";
function hasDocumentBody(document) {
  return parseMarkdownSections(document).some(
    (section) => section.bodyLines.some((line) => line.trim().length > 0)
  );
}
async function readPersonaContext(memoryStore) {
  try {
    const memory = await memoryStore.readInjectionDocuments();
    if (!hasDocumentBody(memory.userProfile)) {
      return void 0;
    }
    return renderSessionStartPersonaInjection({
      userProfile: memory.userProfile,
      path: (0, import_node_path12.join)(memoryStore.dataRoot, "memory", "user-profile.md")
    });
  } catch {
    return void 0;
  }
}
function splitInsight(insight) {
  if (!insight) {
    return [];
  }
  return insight.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => line.replace(/^-+\s*/, ""));
}
function buildHeader(db, primarySessionId) {
  const sessionCount = db.query("SELECT COUNT(*) AS count FROM sessions").get()?.count ?? 0;
  const observationCount = db.query(
    // Excluded rows (a `note` call's observation) are captured for the raw
    // axis only; counting them here would tell the reader a hidden call exists.
    "SELECT COUNT(*) AS count FROM observations WHERE excluded_from_extraction = 0"
  ).get()?.count ?? 0;
  return [
    `claude-mnemo: ${sessionCount} sessions, ${observationCount} observations${primarySessionId ? ` | current: S${primarySessionId}` : ""}`,
    "Axes: recall (content) \xB7 timeline (temporal) \xB7 mnemo-replay (raw)"
  ].join("\n");
}
function hasSessionRunStart(db, sessionId) {
  return db.query(
    "SELECT 1 AS present FROM session_run_state WHERE session_db_id = ?"
  ).get(sessionId) !== null;
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
         AND o.excluded_from_extraction = 0
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
    jsonlPath: resolveSessionTranscriptPath(session)
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
function isHuskSession(session, sessionMetrics) {
  const untitled = !session.title || session.title.trim().length === 0;
  const turnCount = sessionMetrics.get(session.id)?.turnCount ?? 0;
  return untitled && turnCount === 0;
}
function buildRecentSessionsOutput(db, recentSessions, sessionMetrics, currentSessionId) {
  const others = recentSessions.filter((session) => session.id !== currentSessionId).filter((session) => !isHuskSession(session, sessionMetrics)).slice(0, 10);
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
async function readRecentContext(db, fileStore, input) {
  try {
    const recentSessions = getRecentSessions(db, {
      project: input.cwd ?? void 0,
      limit: 20
    });
    const currentSession = input.sessionId ? getSessionByContentId(db, input.sessionId) : null;
    const sessionMetrics = buildSessionMetricMap(
      db,
      recentSessions.map((session) => session.id)
    );
    const recentSessionDocument = buildRecentSessionsOutput(
      db,
      recentSessions,
      sessionMetrics,
      currentSession?.id
    ).join("\n");
    let diaryIndex = "";
    if (fileStore) {
      try {
        diaryIndex = new TextDecoder("utf-8", { fatal: true }).decode(await fileStore.readIndex());
      } catch {
      }
    }
    if (recentSessionDocument.trim() === "" && !hasDocumentBody(diaryIndex)) {
      return void 0;
    }
    return renderSessionStartRecentSessionsInjection({
      recentSessions: recentSessionDocument,
      diaryIndex,
      paths: {
        recentSessions: "recall()",
        diaryIndex: fileStore?.dataRoot ? (0, import_node_path12.join)(fileStore.dataRoot, "diary", "INDEX.md") : "diary/INDEX.md"
      }
    });
  } catch {
    return void 0;
  }
}
function readRuleDigestContext(db, input) {
  try {
    return renderRuleDigest({
      rules: createRuleStore(db).list(),
      project: input.cwd ?? void 0
    }) || void 0;
  } catch {
    return void 0;
  }
}
function buildContextOutput(db, input, eraCutoffEpoch) {
  if (input.sessionId && !getSessionByContentId(db, input.sessionId)) {
    upsertSession(db, {
      contentSessionId: input.sessionId,
      project: input.cwd ?? "",
      transcriptPath: input.transcriptPath ?? null,
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: Math.floor(Date.now() / 1e3),
      updatedAtEpoch: null,
      completedAtEpoch: null
    });
  }
  const currentSession = input.sessionId ? getSessionByContentId(db, input.sessionId) : null;
  if (currentSession && input.transcriptPath) {
    setSessionTranscriptPathIfAbsent(
      db,
      currentSession.id,
      input.transcriptPath
    );
  }
  if (currentSession) {
    recoverStrandedTurns(
      db,
      currentSession.id,
      Math.floor(Date.now() / 1e3),
      eraCutoffEpoch
    );
  }
  if (input.source !== "resume" && input.source !== "compact") {
    return void 0;
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
  const sessionIds = Array.from(
    /* @__PURE__ */ new Set([...recentSessions.map((session) => session.id), primarySessionRecord.id])
  );
  const sessionMetrics = buildSessionMetricMap(db, sessionIds);
  const primarySession = buildSessionView(
    db,
    primarySessionRecord,
    sessionMetrics.get(primarySessionRecord.id)
  );
  const primaryTurnCount = sessionMetrics.get(primarySessionRecord.id)?.turnCount ?? 0;
  const includeCurrentSession = primaryTurnCount > 0;
  const header = buildHeader(
    db,
    input.sessionId ? primarySessionRecord.id : void 0
  );
  const sessionDocument = [
    ...includeCurrentSession ? [
      "## Current Session",
      "",
      renderCurrentSessionStateOutput(
        primarySession,
        primarySessionRecord
      ),
      ""
    ] : []
  ].join("\n");
  const boundedSessionDocument = sessionDocument ? renderPersonaDocumentInjection(
    sessionDocument,
    SESSION_INJECTION_TOKEN_BUDGET,
    `recall(id="S${primarySessionRecord.id}")`
  ) : "";
  return boundedSessionDocument ? [header, "", boundedSessionDocument].join("\n") : header;
}
function createReadOnlyContextHandler(dependencies, section) {
  return async function handleReadOnlyContextHook(_input) {
    if (section === "persona") {
      if (!dependencies.memoryStore) {
        return { continue: true };
      }
      const hookSpecificOutput2 = await readPersonaContext(
        dependencies.memoryStore
      );
      return hookSpecificOutput2 ? { continue: true, hookSpecificOutput: hookSpecificOutput2 } : { continue: true };
    }
    if (!dependencies.db) {
      return { continue: true };
    }
    if (section === "digest") {
      const hookSpecificOutput2 = readRuleDigestContext(
        dependencies.db,
        _input
      );
      return hookSpecificOutput2 ? { continue: true, hookSpecificOutput: hookSpecificOutput2 } : { continue: true };
    }
    const hookSpecificOutput = await readRecentContext(
      dependencies.db,
      dependencies.fileStore,
      _input
    );
    return hookSpecificOutput ? { continue: true, hookSpecificOutput } : { continue: true };
  };
}
function createContextHandler(dependencies, section = "sessions") {
  if (section !== "sessions") {
    return createReadOnlyContextHandler(dependencies, section);
  }
  const eraCutoffEpoch = dependencies.eraCutoffEpoch !== void 0 ? dependencies.eraCutoffEpoch : resolveEraCutoff(dependencies.db);
  return async function handleContextHook(input) {
    if (dependencies.enableSessionEnvCapture && input.sessionId) {
      void notifyWorkerTrigger(
        {
          action: "capture",
          contentSessionId: input.sessionId,
          sessionDbId: getSessionByContentId(dependencies.db, input.sessionId)?.id
        },
        dependencies.workerClientDeps,
        dependencies.workerEnv
      );
    }
    const hookSpecificOutput = buildContextOutput(
      dependencies.db,
      input,
      eraCutoffEpoch
    );
    if (input.sessionId) {
      const session = getSessionByContentId(dependencies.db, input.sessionId);
      if (session && (input.source !== "compact" || !hasSessionRunStart(dependencies.db, session.id))) {
        markSessionRunStart(dependencies.db, session.id);
      }
    }
    return hookSpecificOutput ? { continue: true, hookSpecificOutput } : { continue: true };
  };
}

// src/db/consulted-memories.ts
var ADDRESS_PATTERN = /S(\d+)(?:\s*\/\s*T(\d+)(?:\s*\/\s*O(\d+))?)?/g;
var REPLAY_COMMAND_PATTERN = /turn-detail\.sh[^\n]*?\bS(\d+)\s+(\d+)/g;
var RETRIEVAL_TOOL_PATTERN = /^mcp__(?:[A-Za-z0-9_-]*_)?mnemo__(?:recall|timeline)$/;
function isRetrievalToolName(toolName) {
  return RETRIEVAL_TOOL_PATTERN.test(toolName);
}
function parseId(digits) {
  if (digits === void 0) {
    return null;
  }
  const value = Number.parseInt(digits, 10);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}
function scanAddresses(text, strength) {
  if (!text) {
    return [];
  }
  const addresses = [];
  ADDRESS_PATTERN.lastIndex = 0;
  let match;
  while ((match = ADDRESS_PATTERN.exec(text)) !== null) {
    const sessionId = parseId(match[1]);
    if (sessionId === null) {
      continue;
    }
    const promptNumber = parseId(match[2]);
    const observationId = parseId(match[3]);
    if (observationId !== null) {
      addresses.push({ kind: "observation", observationId, strength });
      continue;
    }
    if (promptNumber !== null) {
      addresses.push({ kind: "turn", sessionId, promptNumber, strength });
      continue;
    }
    addresses.push({ kind: "session", sessionId, strength });
  }
  return addresses;
}
function isExpandedRead(toolInput) {
  return toolInput !== null && /"depth"\s*:\s*"expanded"/.test(toolInput);
}
function deriveConsultedAddresses(call) {
  if (!call.toolName) {
    return [];
  }
  if (isRetrievalToolName(call.toolName)) {
    const resultStrength = isExpandedRead(call.toolInput) ? "strong" : "weak";
    return [
      ...scanAddresses(call.toolInput, "strong"),
      ...scanAddresses(call.toolResult, resultStrength)
    ];
  }
  const command = call.toolInput;
  if (!command) {
    return [];
  }
  const addresses = [];
  REPLAY_COMMAND_PATTERN.lastIndex = 0;
  let match;
  while ((match = REPLAY_COMMAND_PATTERN.exec(command)) !== null) {
    const sessionId = parseId(match[1]);
    const promptNumber = parseId(match[2]);
    if (sessionId === null || promptNumber === null) {
      continue;
    }
    addresses.push({ kind: "turn", sessionId, promptNumber, strength: "strong" });
  }
  return addresses;
}
function parseConsultedColumn(value) {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (entry) => typeof entry === "object" && entry !== null && typeof entry.ref === "string" && (entry.strength === "weak" || entry.strength === "strong")
    );
  } catch {
    return [];
  }
}
function getConsultedMemories(db, turnId) {
  const row = db.query(
    "SELECT consulted_memories AS consultedMemories FROM turns WHERE id = ?"
  ).get(turnId);
  return parseConsultedColumn(row?.consultedMemories ?? null);
}
function recordConsultedMemories(db, turnId, addresses) {
  if (addresses.length === 0) {
    return getConsultedMemories(db, turnId);
  }
  const merged = /* @__PURE__ */ new Map();
  for (const entry of getConsultedMemories(db, turnId)) {
    merged.set(entry.ref, entry.strength);
  }
  const turnLookup = db.query(
    "SELECT id FROM turns WHERE session_id = ? AND prompt_number = ?"
  );
  const sessionLookup = db.query(
    "SELECT id FROM sessions WHERE id = ?"
  );
  const observationLookup = db.query(
    "SELECT id FROM observations WHERE id = ?"
  );
  let changed = false;
  const remember = (ref, strength) => {
    const current = merged.get(ref);
    if (current === strength || current === "strong") {
      return;
    }
    merged.set(ref, strength);
    changed = true;
  };
  for (const address of addresses) {
    if (address.kind === "turn") {
      const row2 = turnLookup.get(address.sessionId, address.promptNumber);
      if (row2 && row2.id !== turnId) {
        remember(`turn:${row2.id}`, address.strength);
      }
      continue;
    }
    if (address.kind === "session") {
      const row2 = sessionLookup.get(address.sessionId);
      if (row2) {
        remember(`session:${row2.id}`, address.strength);
      }
      continue;
    }
    const row = observationLookup.get(address.observationId);
    if (row) {
      remember(`obs:${row.id}`, address.strength);
    }
  }
  const result = [...merged.entries()].map(([ref, strength]) => ({ ref, strength })).sort((left, right) => left.ref.localeCompare(right.ref));
  if (changed) {
    db.query(
      "UPDATE turns SET consulted_memories = ? WHERE id = ?"
    ).run(JSON.stringify(result), turnId);
  }
  return result;
}
function captureConsultedMemories(db, turnId, call) {
  const addresses = deriveConsultedAddresses(call);
  if (addresses.length === 0) {
    return 0;
  }
  return recordConsultedMemories(db, turnId, addresses).length;
}

// src/db/note-debt.ts
function realPromptPredicate(alias = "t") {
  return `${alias}.status != 'undone' AND ${alias}.was_rolled_back = 0 AND (${alias}.type IS NULL OR ${alias}.type != 'compact')`;
}
var NOTE_DEBT_AGING_TURNS = 50;
function listOwedNoteTurns(db, sessionId, currentPromptNumber, options = {}) {
  const agingTurns = options.agingTurns ?? NOTE_DEBT_AGING_TURNS;
  return db.query(
    `SELECT
         t.id AS turnId,
         t.session_id AS sessionId,
         t.prompt_number AS promptNumber,
         t.user_prompt AS userPrompt
       FROM turns t
       WHERE t.session_id = ?
         AND t.prompt_number < ?
         AND t.prompt_number >= ?
         AND ${realPromptPredicate("t")}
         AND NOT EXISTS (
           SELECT 1 FROM shadow_notes n WHERE n.turn_id = t.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM note_debt d
           WHERE d.turn_id = t.id AND d.status = 'skipped'
         )
       ORDER BY t.prompt_number ASC`
  ).all(sessionId, currentPromptNumber, currentPromptNumber - agingTurns).map((row) => ({
    ...row,
    pendingTurns: currentPromptNumber - row.promptNumber
  }));
}
function recordNoteIdExposure(db, input) {
  const statement = db.query(
    `INSERT OR IGNORE INTO note_id_exposures (
       session_id, ride_turn_id, exposed_turn_id, source, created_at_epoch
     ) VALUES (?, ?, ?, ?, ?)`
  );
  let written = 0;
  for (const exposedTurnId of input.exposedTurnIds) {
    statement.run(
      input.sessionId,
      input.rideTurnId,
      exposedTurnId,
      input.source,
      input.nowEpoch
    );
    written += 1;
  }
  return written;
}

// src/db/observations.ts
var OBSERVATION_COLUMNS = `
  id,
  turn_id AS turnId,
  tool_name AS toolName,
  tool_input AS toolInput,
  tool_result AS toolResult,
  status,
  title,
  content,
  excluded_from_extraction AS excludedFromExtraction,
  created_at_epoch AS createdAtEpoch
`;
var OBSERVATION_SELECT = `
  SELECT ${OBSERVATION_COLUMNS}
  FROM observations
`;
function mapObservationRow(row) {
  if (!row) {
    return null;
  }
  return row;
}
function createObservation(db, input) {
  const inserted = db.query(
    `
        INSERT INTO observations (
          turn_id,
          tool_name,
          tool_input,
          tool_result,
          status,
          title,
          content,
          excluded_from_extraction,
          created_at_epoch
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING ${OBSERVATION_COLUMNS}
      `
  ).get(
    input.turnId,
    input.toolName ?? null,
    input.toolInput ?? null,
    input.toolResult ?? null,
    input.status ?? "pending",
    input.title ?? null,
    input.content ?? null,
    input.excludedFromExtraction ? 1 : 0,
    input.createdAtEpoch
  );
  const observation = mapObservationRow(inserted);
  if (!observation) {
    throw new Error("Failed to create observation.");
  }
  indexObservationToFTS(db, observation);
  return observation;
}
function getExtractableObservationsForTurn(db, turnId) {
  return db.query(
    `${OBSERVATION_SELECT} WHERE turn_id = ? AND excluded_from_extraction = 0 ORDER BY id ASC`
  ).all(turnId).map((row) => mapObservationRow(row)).filter((observation) => observation !== null);
}

// src/db/turn-completion.ts
function completionFloorStatus(turn, eraCutoffEpoch = null) {
  if (turn.title !== null || turn.content !== null) {
    return "extracted";
  }
  return isSegmentEra(turn.createdAtEpoch, eraCutoffEpoch) ? "skipped" : "failed";
}
function safeJsonParse(raw) {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}
function collectPathValues(input, key) {
  const value = input[key];
  if (typeof value === "string" && value.trim() !== "") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.filter(
      (item) => typeof item === "string" && item.trim() !== ""
    );
  }
  return [];
}
function aggregateTurnFiles(db, turnId) {
  const filesRead = /* @__PURE__ */ new Set();
  const filesModified = /* @__PURE__ */ new Set();
  const observations = getExtractableObservationsForTurn(db, turnId);
  for (const observation of observations) {
    const input = safeJsonParse(observation.toolInput);
    if (!input) {
      continue;
    }
    switch (observation.toolName) {
      case "Read":
      case "Grep":
      case "Glob":
        for (const path2 of [
          ...collectPathValues(input, "file_path"),
          ...collectPathValues(input, "path")
        ]) {
          filesRead.add(path2);
        }
        break;
      case "Write":
      case "Edit":
      case "MultiEdit":
        for (const path2 of collectPathValues(input, "file_path")) {
          filesModified.add(path2);
        }
        break;
      default:
        break;
    }
  }
  return {
    filesRead: [...filesRead],
    filesModified: [...filesModified],
    toolCallCount: observations.length
  };
}
function settleCompletedTurn(db, turnId, eraCutoffEpoch, nowEpoch) {
  const turn = getTurnById(db, turnId);
  if (!turn || turn.status !== "active" && turn.status !== "provisional") {
    return false;
  }
  const aggregate = aggregateTurnFiles(db, turnId);
  updateTurnById(db, turnId, {
    status: completionFloorStatus(turn, eraCutoffEpoch),
    filesRead: aggregate.filesRead,
    filesModified: aggregate.filesModified,
    toolCallCount: aggregate.toolCallCount,
    updatedAtEpoch: nowEpoch
  });
  db.query(
    `UPDATE observations SET status = 'skipped'
     WHERE turn_id = ? AND status = 'pending'`
  ).run(turnId);
  return true;
}

// src/db/turn-settlement.ts
var SETTLEMENT_CANDIDATE_SQL = `
  SELECT t.id AS id
  FROM turns t
  WHERE t.session_id = ?
    AND t.status IN ('active', 'provisional')
    AND (
      EXISTS (
        SELECT 1 FROM turns later
        WHERE later.session_id = t.session_id
          AND later.prompt_number > t.prompt_number
          AND ${realPromptPredicate("later")}
      )
      OR EXISTS (
        SELECT 1 FROM pending_queue q
        WHERE q.kind = 'turn-stop' AND q.target_id = t.id
      )
    )
  ORDER BY t.prompt_number ASC
`;
function listSettlementCandidateTurnIds(db, sessionId) {
  return db.query(SETTLEMENT_CANDIDATE_SQL).all(sessionId).map((row) => row.id);
}
function settleOutstandingTurns(db, sessionId, eraCutoffEpoch, nowEpoch) {
  const settled = [];
  for (const turnId of listSettlementCandidateTurnIds(db, sessionId)) {
    if (settleCompletedTurn(db, turnId, eraCutoffEpoch, nowEpoch)) {
      settled.push(turnId);
    }
  }
  return settled;
}

// src/shared/note-tool.ts
var NOTE_TOOL_NAME_PATTERN = /^mcp__(?:[A-Za-z0-9_-]*_)?mnemo__note$/;
function isNoteToolName(toolName) {
  return NOTE_TOOL_NAME_PATTERN.test(toolName);
}
function isExtractionExcludedToolName(toolName) {
  return isNoteToolName(toolName);
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
function getLatestTurn(db, sessionDbId) {
  const row = db.query(
    `SELECT id, status FROM turns WHERE session_id = ? ORDER BY prompt_number DESC LIMIT 1`
  ).get(sessionDbId);
  return row ?? null;
}
function createPostToolUseHandler(dependencies) {
  const now = dependencies.now ?? (() => Math.floor(Date.now() / 1e3));
  const writeTransaction = dependencies.runHookWriteTransaction ?? runHookWriteTransaction;
  const logger = dependencies.logger ?? console;
  const eraCutoffEpoch = dependencies.eraCutoffEpoch !== void 0 ? dependencies.eraCutoffEpoch : resolveEraCutoff(dependencies.db);
  return async function handlePostToolUseHook(input) {
    if (input.agentId !== void 0) {
      logger.warn?.("post-tool-use ignored", {
        sessionId: input.sessionId ?? null,
        reasonCode: "child-agent-sidechain"
      });
      return { continue: true };
    }
    if (!input.sessionId || !input.toolName) {
      return { continue: true };
    }
    const session = getSessionByContentId(dependencies.db, input.sessionId);
    if (!session) {
      return { continue: true };
    }
    const createdAtEpoch = now();
    const toolName = input.toolName;
    const toolInput = stringifyToolPayload(input.toolInput);
    const toolResult = stringifyToolPayload(input.toolResponse);
    const excludedFromExtraction = isExtractionExcludedToolName(toolName);
    const writeResult = writeTransaction(dependencies.db, () => {
      try {
        settleOutstandingTurns(
          dependencies.db,
          session.id,
          eraCutoffEpoch,
          createdAtEpoch
        );
      } catch (error48) {
        logger.warn?.("turn settlement failed", {
          sessionId: input.sessionId,
          reasonCode: "post-tool-use-sweep",
          error: error48 instanceof Error ? error48.message : String(error48)
        });
      }
      const latestTurn = getLatestTurn(dependencies.db, session.id);
      if (!latestTurn) {
        return { outcome: "no-root-turn", turnId: null };
      }
      if (latestTurn.status !== "active" && latestTurn.status !== "provisional") {
        return { outcome: "terminal-root-turn", turnId: latestTurn.id };
      }
      createObservation(dependencies.db, {
        turnId: latestTurn.id,
        toolName,
        toolInput,
        toolResult,
        excludedFromExtraction,
        createdAtEpoch
      });
      try {
        captureConsultedMemories(dependencies.db, latestTurn.id, {
          toolName,
          toolInput,
          toolResult
        });
      } catch (error48) {
        logger.warn?.("consulted memories capture failed", {
          sessionId: input.sessionId,
          turnId: latestTurn.id,
          reasonCode: "post-tool-use-consulted",
          error: error48 instanceof Error ? error48.message : String(error48)
        });
      }
      return { outcome: "captured", turnId: latestTurn.id };
    });
    if (writeResult.outcome !== "captured") {
      logger.warn?.("post-tool-use ignored", {
        sessionId: input.sessionId,
        turnId: writeResult.turnId,
        reasonCode: writeResult.outcome
      });
    }
    return { continue: true };
  };
}

// src/shared/type-vocabulary.ts
var MEMORY_TYPES = [
  "research",
  "design",
  "implement",
  "fix",
  "measure",
  "review",
  "write",
  "ops",
  "chat",
  "rolled-back"
];
var TYPE_GLYPH = {
  research: "\u{1F50D}",
  design: "\u2696\uFE0F",
  implement: "\u{1F527}",
  fix: "\u{1F534}",
  measure: "\u{1F4CA}",
  review: "\u2705",
  write: "\u270D\uFE0F",
  ops: "\u2699\uFE0F",
  chat: "\u{1F4AC}",
  "rolled-back": "\u21A9\uFE0F"
};
function isMemoryType(value) {
  return typeof value === "string" && MEMORY_TYPES.includes(value);
}
var TYPE_ALIASES = {
  research: [
    "research",
    "investigate",
    "explore",
    "survey",
    "study",
    "analyze",
    "analyse",
    "diagnose",
    "\u8C03\u7814",
    "\u7814\u7A76",
    "\u6392\u67E5",
    "\u5206\u6790",
    "\u63A2\u7D22",
    "\u8BCA\u65AD"
  ],
  design: [
    "design",
    "spec",
    "plan",
    "propose",
    "decide",
    "evaluate",
    "compare",
    "\u8BBE\u8BA1",
    "\u65B9\u6848",
    "\u89C4\u5212",
    "\u9009\u578B",
    "\u8BC4\u4F30",
    "\u5BF9\u6BD4",
    "\u5B9A\u6848",
    "\u88C1\u51B3"
  ],
  implement: [
    "implement",
    "add",
    "build",
    "create",
    "introduce",
    "wire",
    "ship",
    "support",
    "\u5B9E\u73B0",
    "\u65B0\u589E",
    "\u6784\u5EFA",
    "\u63A5\u5165",
    "\u843D\u5730",
    "\u4E0A\u7EBF",
    "\u8865\u5168"
  ],
  fix: [
    "fix",
    "repair",
    "resolve",
    "correct",
    "patch",
    "harden",
    "hotfix",
    "\u4FEE\u590D",
    "\u4FEE\u6B63",
    "\u89E3\u51B3",
    "\u7EA0\u6B63",
    "\u52A0\u56FA",
    "\u6B62\u8840"
  ],
  measure: [
    "measure",
    "benchmark",
    "profile",
    "count",
    "verify",
    "test",
    "validate",
    "\u5EA6\u91CF",
    "\u6D4B\u91CF",
    "\u7EDF\u8BA1",
    "\u57FA\u51C6",
    "\u9A8C\u8BC1",
    "\u5B9E\u6D4B",
    "\u538B\u6D4B"
  ],
  review: [
    "review",
    "audit",
    "check",
    "inspect",
    "assess",
    "critique",
    "\u8BC4\u5BA1",
    "\u5BA1\u67E5",
    "\u590D\u6838",
    "\u6838\u5BF9",
    "\u68C0\u67E5",
    "\u5BA1\u8BA1"
  ],
  write: [
    "write",
    "document",
    "draft",
    "record",
    "summarize",
    "note",
    "explain",
    "\u64B0\u5199",
    "\u7F16\u5199",
    "\u8BB0\u5F55",
    "\u6587\u6863",
    "\u603B\u7ED3",
    "\u8D77\u8349",
    "\u8BF4\u660E"
  ],
  ops: [
    "ops",
    "release",
    "deploy",
    "publish",
    "migrate",
    "upgrade",
    "bump",
    "configure",
    "clean",
    "\u53D1\u7248",
    "\u53D1\u5E03",
    "\u90E8\u7F72",
    "\u8FC1\u79FB",
    "\u5347\u7EA7",
    "\u914D\u7F6E",
    "\u6E05\u7406",
    "\u8FD0\u7EF4"
  ],
  chat: [
    "chat",
    "discuss",
    "ask",
    "answer",
    "reply",
    "clarify",
    "\u95F2\u804A",
    "\u8BA8\u8BBA",
    "\u8BE2\u95EE",
    "\u56DE\u7B54",
    "\u6F84\u6E05"
  ]
};
var SORTED_ALIASES = Object.entries(TYPE_ALIASES).flatMap(
  ([type, aliases]) => aliases.map((alias) => ({ alias: alias.toLowerCase(), type }))
).sort((left, right) => right.alias.length - left.alias.length);

// src/db/segments.ts
var SEGMENT_COLUMNS = `
  id,
  topic_id AS topicId,
  title,
  content,
  type,
  tags,
  status,
  revision,
  created_at_epoch AS createdAtEpoch,
  updated_at_epoch AS updatedAtEpoch
`;
function parseStringArray(value) {
  if (!value) {
    return [];
  }
  const parsed = JSON.parse(value);
  return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
}
function mapSegmentRow(row) {
  return row ? {
    ...row,
    type: parseStringArray(row.type),
    tags: parseStringArray(row.tags)
  } : null;
}
function getSegment(db, segmentId) {
  return mapSegmentRow(
    db.query(
      `SELECT ${SEGMENT_COLUMNS} FROM segments WHERE id = ?`
    ).get(segmentId) ?? null
  );
}

// src/db/segment-rank.ts
var RANK_FACT_COLUMNS = `
  t.id AS turnId,
  t.session_id AS sessionId,
  t.prompt_number AS promptNumber,
  t.title AS title,
  t.type AS type,
  t.status AS status,
  t.created_at_epoch AS createdAtEpoch,
  (EXISTS (
     SELECT 1 FROM memory_edges e
     WHERE e.citing_kind = 'turn' AND e.citing_id = t.id
       AND e.relation = 'supersedes'
   )) AS isCorrector,
  -- COALESCE, not a bare comparison: comparing NULL to a literal yields NULL,
  -- and SQLite sorts NULL FIRST under ASC \u2014 an untyped turn would have
  -- outranked every typed one on this key by accident of three-valued logic.
  (COALESCE(t.type, '') = 'rolled-back') AS isRolledBack,
  (SELECT COUNT(*) FROM (
     SELECT DISTINCT e.citing_kind, e.citing_id
     FROM memory_edges e
     WHERE e.cited_kind = 'turn' AND e.cited_id = t.id
   )) AS citedBy,
  (EXISTS (
     SELECT 1 FROM segment_members dm
     JOIN segments ds ON ds.id = dm.segment_id
     WHERE dm.turn_id = t.id AND ds.status = 'delivered'
   )) AS isDeliveryMember,
  (CASE WHEN json_valid(t.files_modified)
        THEN json_array_length(t.files_modified) ELSE 0 END) AS filesModifiedCount
`;
var DERIVED_RANK_ORDER = `
  ORDER BY isCorrector DESC,
           isRolledBack ASC,
           citedBy DESC,
           isDeliveryMember DESC,
           filesModifiedCount DESC,
           t.created_at_epoch DESC,
           t.id DESC
`;
function listSegmentSpineForSession(db, sessionId, eraCutoffEpoch, windowTurnIds) {
  if (eraCutoffEpoch === null) {
    return [];
  }
  const memberRows = db.query(
    `SELECT
         sm.segment_id AS segmentId,
         t.id AS turnId,
         t.session_id AS sessionId,
         t.prompt_number AS promptNumber,
         t.type AS type,
         t.created_at_epoch AS createdAtEpoch
       FROM segment_members sm
       JOIN turns t ON t.id = sm.turn_id
       WHERE t.created_at_epoch >= ?
         AND sm.segment_id IN (
           SELECT sm2.segment_id
           FROM segment_members sm2
           JOIN turns t2 ON t2.id = sm2.turn_id
           WHERE t2.session_id = ? AND t2.created_at_epoch >= ?
         )
       ORDER BY t.created_at_epoch ASC, t.id ASC`
  ).all(eraCutoffEpoch, sessionId, eraCutoffEpoch);
  const bySegment = /* @__PURE__ */ new Map();
  for (const row of memberRows) {
    const bucket = bySegment.get(row.segmentId) ?? [];
    bucket.push(row);
    bySegment.set(row.segmentId, bucket);
  }
  const rows = [];
  for (const [segmentId, members] of bySegment) {
    const segment = getSegment(db, segmentId);
    if (!segment) {
      continue;
    }
    const sessionMembers = members.filter((member) => member.sessionId === sessionId);
    if (windowTurnIds !== void 0 && !sessionMembers.some((member) => windowTurnIds.has(member.turnId))) {
      continue;
    }
    const prompts = sessionMembers.map((member) => member.promptNumber);
    rows.push({
      segment,
      dominantType: deriveDominantType(
        members.map((member) => member.type),
        segment.type
      ),
      memberCount: members.length,
      sessionMemberCount: sessionMembers.length,
      firstPromptNumber: prompts.length > 0 ? Math.min(...prompts) : null,
      lastPromptNumber: prompts.length > 0 ? Math.max(...prompts) : null,
      firstEpoch: members[0].createdAtEpoch,
      lastEpoch: members[members.length - 1].createdAtEpoch,
      phaseTrace: collapseRuns(
        members.map((member) => member.type).filter((type) => type !== null && type !== "")
      )
    });
  }
  return rows.sort((left, right) => {
    const leftPrompt = left.firstPromptNumber ?? Number.MAX_SAFE_INTEGER;
    const rightPrompt = right.firstPromptNumber ?? Number.MAX_SAFE_INTEGER;
    if (leftPrompt !== rightPrompt) {
      return leftPrompt - rightPrompt;
    }
    return left.segment.id - right.segment.id;
  });
}
function deriveDominantType(memberTypes, segmentTypes) {
  const counts = /* @__PURE__ */ new Map();
  for (const type of memberTypes) {
    if (type === null || type === "") {
      continue;
    }
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  let tied = false;
  for (const [type, count] of counts) {
    if (count > bestCount) {
      best = type;
      bestCount = count;
      tied = false;
    } else if (count === bestCount) {
      tied = true;
    }
  }
  if (best !== null && !tied) {
    return best;
  }
  return segmentTypes[0] ?? null;
}
function collapseRuns(values) {
  const out = [];
  for (const value of values) {
    if (out[out.length - 1] !== value) {
      out.push(value);
    }
  }
  return out;
}
function listOrphanAnchorTurns(db, sessionId, eraCutoffEpoch, windowTurnIds) {
  if (eraCutoffEpoch === null) {
    return [];
  }
  const rows = db.query(
    `SELECT ${RANK_FACT_COLUMNS}
       FROM turns t
       WHERE t.session_id = ?
         AND t.created_at_epoch >= ?
         AND t.status NOT IN ('skipped', 'undone')
         AND NOT EXISTS (
           SELECT 1 FROM segment_members sm WHERE sm.turn_id = t.id
         )
       ${DERIVED_RANK_ORDER}`
  ).all(sessionId, eraCutoffEpoch);
  return rows.filter((facts) => windowTurnIds === void 0 || windowTurnIds.has(facts.turnId)).map((facts) => ({ facts, signals: orphanSignals(facts) })).filter((row) => row.signals.length > 0);
}
function orphanSignals(facts) {
  const signals = [];
  if (facts.isCorrector) {
    signals.push("corrector");
  }
  if (facts.isRolledBack) {
    signals.push("rolled-back");
  }
  if (facts.citedBy > 0) {
    signals.push(`cited ${facts.citedBy}`);
  }
  return signals;
}
function getSegmentMembershipForTurns(db, turnIds) {
  const membership = /* @__PURE__ */ new Map();
  if (turnIds.length === 0) {
    return membership;
  }
  const placeholders = turnIds.map(() => "?").join(", ");
  const rows = db.query(
    `SELECT turn_id AS turnId, segment_id AS segmentId
       FROM segment_members
       WHERE turn_id IN (${placeholders})
       ORDER BY turn_id ASC, segment_id ASC`
  ).all(...turnIds);
  for (const row of rows) {
    if (!membership.has(row.turnId)) {
      membership.set(row.turnId, row.segmentId);
    }
  }
  return membership;
}

// src/shared/transcript-parser.ts
var import_node_fs5 = require("node:fs");
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
  if (!(0, import_node_fs5.existsSync)(transcriptPath)) {
    return [];
  }
  const rawTranscript = (0, import_node_fs5.readFileSync)(transcriptPath, "utf8");
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
    model: later.model ?? first.model,
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
    model: typeof message?.model === "string" ? message.model : void 0,
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
        wasInterrupted: entry.promptId !== void 0 && interruptedPromptIds.has(entry.promptId),
        assistantModel: null
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
    if (entry.model) {
      currentTurn.assistantModel = entry.model;
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

// src/task-causality-era.ts
var TASK_CAUSALITY_ERA_CUTOFF_EPOCH = 1784711427;
function isTaskCausalityEra(createdAtEpoch, cutoffEpoch = TASK_CAUSALITY_ERA_CUTOFF_EPOCH) {
  return createdAtEpoch >= cutoffEpoch;
}

// src/mcp/segment-spine.ts
var ORPHAN_GLYPH = "\u2691";
var SPINE_ROW_INDENT = "   ";
var SPINE_TAG_CAP = 2;
function segmentTypeGlyph(type) {
  if (!type) {
    return "\u2022";
  }
  if (isMemoryType(type)) {
    return TYPE_GLYPH[type];
  }
  return TYPE_EMOJI[type] ?? "\u2022";
}
function formatTags(tags) {
  if (tags.length === 0) {
    return "";
  }
  const shown = tags.slice(0, SPINE_TAG_CAP).map((tag) => `#${tag}`);
  const hidden = tags.length - shown.length;
  return `${shown.join(" ")}${hidden > 0 ? ` +${hidden}` : ""}`;
}
function sanitize(value) {
  return value.replaceAll("|", "/").replaceAll("\u2192", "->");
}
function formatPhaseTrace(phaseTrace) {
  return phaseTrace.map((type) => segmentTypeGlyph(type)).join("\u2192");
}
function formatSpan(row) {
  if (row.firstPromptNumber === null || row.lastPromptNumber === null) {
    return "";
  }
  return row.firstPromptNumber === row.lastPromptNumber ? `T${row.firstPromptNumber}` : `T${row.firstPromptNumber}\u2013T${row.lastPromptNumber}`;
}
function renderSpineRow(row, titleCap) {
  const { segment } = row;
  const parts = [
    `[E${segment.id}]`,
    segmentTypeGlyph(row.dominantType),
    formatTags(segment.tags),
    sanitize(truncateText(segment.title, { limit: titleCap })),
    `[${segment.status}]`
  ].filter((part) => part !== "");
  const facts = [
    `${row.memberCount} ${row.memberCount === 1 ? "turn" : "turns"}`,
    formatSpan(row),
    formatPhaseTrace(row.phaseTrace)
  ].filter((part) => part !== "");
  return `${SPINE_ROW_INDENT}${parts.join(" ")} \xB7 ${facts.join(" \xB7 ")}`.trimEnd();
}
function renderOrphanRow(row, titleCap) {
  const { facts } = row;
  const label = facts.title === null || facts.title.trim() === "" ? "(untitled)" : sanitize(truncateText(facts.title, { limit: titleCap }));
  return `${SPINE_ROW_INDENT}${ORPHAN_GLYPH} T${facts.promptNumber} ${segmentTypeGlyph(
    facts.type
  )} ${label} (${row.signals.join(", ")})`;
}
function renderSegmentSpineBlock(input) {
  const { spine, orphans, titleCap } = input;
  if (spine.length === 0 && orphans.length === 0) {
    return [];
  }
  const keptSegments = input.maxSegments === void 0 ? [...spine] : spine.slice(Math.max(0, spine.length - Math.max(0, input.maxSegments)));
  const droppedSegments = spine.length - keptSegments.length;
  const keptOrphans = input.maxOrphans === void 0 ? [...orphans] : orphans.slice(0, Math.max(0, input.maxOrphans));
  const droppedOrphans = orphans.length - keptOrphans.length;
  const headerParts = [
    `${spine.length} ${spine.length === 1 ? "segment" : "segments"}`
  ];
  if (orphans.length > 0) {
    headerParts.push(
      `${orphans.length} orphan ${orphans.length === 1 ? "anchor" : "anchors"}`
    );
  }
  const lines = ["", `\u2500\u2500 segment spine \xB7 ${headerParts.join(" \xB7 ")} \u2500\u2500`];
  if (droppedSegments > 0) {
    lines.push(
      `${SPINE_ROW_INDENT}\u2026 +${droppedSegments} earlier ${droppedSegments === 1 ? "segment" : "segments"}`
    );
  }
  for (const row of keptSegments) {
    lines.push(renderSpineRow(row, titleCap));
    const nested = input.milestoneLinesBySegmentId?.get(row.segment.id);
    if (nested !== void 0 && nested.length > 0) {
      lines.push(...nested);
    }
  }
  for (const row of keptOrphans) {
    lines.push(renderOrphanRow(row, titleCap));
  }
  if (droppedOrphans > 0) {
    lines.push(
      `${SPINE_ROW_INDENT}\u2026 +${droppedOrphans} orphan ${droppedOrphans === 1 ? "anchor" : "anchors"}`
    );
  }
  return lines;
}
function legacyEraHeader(firstPromptNumber, lastPromptNumber) {
  const span = firstPromptNumber === null || lastPromptNumber === null ? "" : ` \xB7 T${firstPromptNumber}\u2013T${lastPromptNumber}`;
  return `\u2500\u2500 legacy era${span} \u2500\u2500`;
}

// src/mcp/timeline.ts
var DEFAULT_TIMELINE_PAGE_SIZE = 30;
var PROMPT_COLUMN_CAP = 100;
var BROKEN_PROMPT_MIN_PREFIX = 20;
var BROKEN_PROMPT_MAX_GAP_MS = 5 * 60 * 1e3;
var TOOL_BURST_TOP_N = 3;
var DEFAULT_TITLE_CAP = 100;
var MILESTONE_UNIT_TOKEN_CAP = 150;
var MILESTONE_UNIT_PULLED_CAP = 4;
var MILESTONE_PROMPT_PREFIX_CAP = 32;
var MILESTONE_FILE_BASENAME_CAP = 3;
var MILESTONE_NOTIFICATION_MARKER = "\u27E8notify\u27E9";
var MILESTONE_OVER_BUDGET_NOTE = "  \u26A0 over budget: anchor rows kept in full";
var MILESTONE_DESC_INDENT = "        ";
var MILESTONE_DESC_WRAP_CHARS = 92;
var OUTCOME_TAGS = /* @__PURE__ */ new Set([
  "merged",
  "shipped",
  "released",
  // `release` (singular/imperative stem) is how release turns tag themselves;
  // `released`/`shipped` are already present. Do NOT add the bare verbs
  // `push`/`pushed`/`merge`/`ship` — those occur mid-work and would mint false
  // always-keep outcome markers.
  "release",
  "ready-to-merge",
  "approved",
  "finalized"
]);
var REVERSED_ROLE_TAGS = /* @__PURE__ */ new Set(["rolled-back"]);
var PLUGIN_MANIFEST_SUFFIXES = [
  "marketplace.json",
  "plugin/.claude-plugin/plugin.json",
  ".claude-plugin/plugin.json"
];
function isVersionBumpTurn(filesModified) {
  const hasPackageJson = filesModified.some(
    (path2) => path2.endsWith("package.json")
  );
  if (!hasPackageJson) {
    return false;
  }
  return filesModified.some(
    (path2) => PLUGIN_MANIFEST_SUFFIXES.some((suffix) => path2.endsWith(suffix))
  );
}
var REVERSAL_KEYWORD_TAGS = /* @__PURE__ */ new Set([
  "reversal",
  "reversed",
  "superseded",
  "supersede",
  "reframed",
  "reframe",
  "design-pivot",
  "pivot"
]);
var EMPTY_MILESTONE_SELECTION = {
  kept: [],
  ranked: [],
  pulled: [],
  overflowByDay: [],
  effGradeByTurnId: /* @__PURE__ */ new Map()
};
var EMPTY_TURN_ID_SET = /* @__PURE__ */ new Set();
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
var MISSING_GRADE_CELL = "\u2014";
var TURN_TABLE_HEADER = "T# | line | time | gap | stats | G | prompt \u2192 title";
function typeEmoji(type) {
  if (type === null) return PENDING_EMOJI;
  return TYPE_EMOJI_MAP[type] ?? "\u2022";
}
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
function tailItems(items, pageSize) {
  const start = Math.max(0, items.length - pageSize);
  return {
    items: items.slice(start),
    total: items.length,
    pageCount: Math.max(1, Math.ceil(items.length / pageSize))
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
function extractCommandName(raw) {
  const match = raw.match(/<command-name>\s*([^<]+?)\s*<\/command-name>/);
  return match ? match[1].trim() : null;
}
function cleanPromptForLabel(raw) {
  if (raw === null) {
    return "";
  }
  const commandName = extractCommandName(raw);
  if (commandName !== null) {
    return commandName;
  }
  const stripped = raw.replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, "").replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, "").replace(/<command-message>[\s\S]*?<\/command-message>/g, "").replace(/<command-args>[\s\S]*?<\/command-args>/g, "");
  const firstLine = stripped.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? "";
  return firstLine.replace(/\s+/g, " ").trim();
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
function milestoneMarker(turn, options = {}) {
  if (turn.status === "undone" || turn.wasInterrupted) {
    return "invalidated";
  }
  const keywordReversal = options.enableReversalKeyword === true && turn.type === "decision" && turn.tags.some((tag) => REVERSAL_KEYWORD_TAGS.has(tag));
  const roleReversal = turn.tags.some((tag) => REVERSED_ROLE_TAGS.has(tag));
  if (turn.wasRolledBack || roleReversal || keywordReversal) {
    return "reversed";
  }
  if (turn.tags.some((tag) => OUTCOME_TAGS.has(tag)) || isVersionBumpTurn(turn.filesModified)) {
    return "outcome";
  }
  return null;
}
var MILESTONE_LEGACY_TYPE_GRADE = {
  decision: 3,
  feature: 2,
  refactor: 2,
  bugfix: 2,
  change: 1,
  discovery: 1
};
var MILESTONE_LEGACY_GRADE_CAP = 3;
var MILESTONE_SPINE_MIN_EFF_GRADE = 3;
var MILESTONE_POOL_MIN_EFF_GRADE = 2;
var MILESTONE_PULL_MAX_EFF_GRADE = 2;
var MILESTONE_TIE_CITED_WEIGHT = 0.25;
var MILESTONE_TIE_CITED_CAP = 2;
var MILESTONE_TIE_INSIGHT_WEIGHT = 0.25;
var MILESTONE_TIE_PURE_SPEC_WEIGHT = 0.15;
var MILESTONE_TIE_BREAK_MAX = 0.9;
var MILESTONE_PURE_SPEC_RE = /^docs\/(?:plans|specs|superpowers)\/.*\.md$/;
var MILESTONE_VERSION_RE = /\b0\.\d+\.\d+\b/g;
var MILESTONE_PULLED_LABEL_CAP = 60;
function milestoneEffGrade(turn, taskCausalityEraCutoffEpoch) {
  if (isTaskCausalityEra(turn.createdAtEpoch, taskCausalityEraCutoffEpoch)) {
    const grade = turn.significanceGrade;
    if (grade === null || grade === void 0) {
      return 0;
    }
    return Math.max(0, Math.min(4, grade));
  }
  return legacyEffGrade(turn);
}
function legacyEffGrade(turn) {
  let grade = MILESTONE_LEGACY_TYPE_GRADE[turn.type ?? ""] ?? 0;
  if ((turn.type === "feature" || turn.type === "refactor" || turn.type === "change") && turn.filesModified.length === 0) {
    grade = 0;
  }
  if (hasMilestoneInsight(turn)) {
    grade += 1;
  }
  return Math.min(grade, MILESTONE_LEGACY_GRADE_CAP);
}
function hasMilestoneInsight(turn) {
  return typeof turn.insight === "string" && turn.insight.trim() !== "" && turn.insight !== "[]";
}
function isPureSpecTurn(turn) {
  return turn.filesModified.length > 0 && turn.filesModified.every((path2) => MILESTONE_PURE_SPEC_RE.test(path2));
}
function milestoneTieBreak(turn, citedBy = 0) {
  const raw = MILESTONE_TIE_CITED_WEIGHT * Math.min(Math.max(citedBy, 0), MILESTONE_TIE_CITED_CAP) + (hasMilestoneInsight(turn) ? MILESTONE_TIE_INSIGHT_WEIGHT : 0) + (isPureSpecTurn(turn) ? MILESTONE_TIE_PURE_SPEC_WEIGHT : 0);
  return Math.min(raw, MILESTONE_TIE_BREAK_MAX);
}
function inlineCitationFallback(turns) {
  const sessionTurnIds = new Set(turns.map((turn) => turn.id));
  const effective = /* @__PURE__ */ new Map();
  for (const turn of turns) {
    if (turn.citesRecorded) {
      effective.set(turn.id, { source: "structured", citedTurnIds: [], edges: [] });
      continue;
    }
    effective.set(turn.id, {
      source: "inline",
      citedTurnIds: parseInlineCitations(turn.content).filter(
        (id) => id !== turn.id && sessionTurnIds.has(id)
      ),
      edges: []
    });
  }
  return effective;
}
function citationInDegree(citations) {
  const inDegree = /* @__PURE__ */ new Map();
  for (const entry of citations.values()) {
    for (const citedTurnId of entry.citedTurnIds) {
      inDegree.set(citedTurnId, (inDegree.get(citedTurnId) ?? 0) + 1);
    }
  }
  return inDegree;
}
function extractMilestoneVersion(title) {
  if (!title) return null;
  const matches = [...title.matchAll(MILESTONE_VERSION_RE)];
  return matches.length > 0 ? matches[matches.length - 1][0] : null;
}
function demotedOutcomePrompts(seq) {
  const byDay = /* @__PURE__ */ new Map();
  for (const turn of seq) {
    if (milestoneMarker(turn) !== "outcome") {
      continue;
    }
    const day = formatLocalDate(turn.createdAtEpoch);
    const bucket = byDay.get(day) ?? [];
    bucket.push(turn);
    byDay.set(day, bucket);
  }
  const demoted = /* @__PURE__ */ new Set();
  const closeChain = (chain) => {
    for (const turn of chain.slice(0, -1)) {
      demoted.add(turn.promptNumber);
    }
  };
  for (const turns of byDay.values()) {
    const sorted = [...turns].sort((a, b) => a.promptNumber - b.promptNumber);
    let chain = [];
    for (const turn of sorted) {
      if (chain.length === 0) {
        chain = [turn];
        continue;
      }
      const previous = chain[chain.length - 1];
      const previousVersion = extractMilestoneVersion(previous.title);
      const currentVersion = extractMilestoneVersion(turn.title);
      const sameRelease = turn.promptNumber - previous.promptNumber <= 5 && !(previousVersion !== null && currentVersion !== null && previousVersion !== currentVersion);
      if (sameRelease) {
        chain.push(turn);
      } else {
        closeChain(chain);
        chain = [turn];
      }
    }
    closeChain(chain);
  }
  return demoted;
}
function buildCorrectionGraph(turns, options = {}) {
  const correctors = /* @__PURE__ */ new Set();
  const supersededVictims = /* @__PURE__ */ new Set();
  const supersedersByVictim = /* @__PURE__ */ new Map();
  const byDbId = /* @__PURE__ */ new Map();
  for (const turn of turns) {
    byDbId.set(turn.id, turn);
  }
  const citations = options.citations ?? inlineCitationFallback(turns);
  for (const corrector of turns) {
    const entry = citations.get(corrector.id);
    if (entry === void 0) {
      continue;
    }
    const supersededIds = /* @__PURE__ */ new Set();
    for (const edge of entry.edges) {
      if (edge.relation === "supersedes") {
        supersededIds.add(edge.citedTurnId);
      }
    }
    if (entry.source === "inline" && !isTaskCausalityEra(corrector.createdAtEpoch, options.taskCausalityEraCutoffEpoch)) {
      for (const citedTurnId of entry.citedTurnIds) {
        const cited = byDbId.get(citedTurnId) ?? options.resolveCited?.(citedTurnId);
        if (cited && milestoneMarker(cited) === "reversed") {
          supersededIds.add(citedTurnId);
        }
      }
    }
    for (const citedTurnId of supersededIds) {
      const victim = byDbId.get(citedTurnId) ?? options.resolveCited?.(citedTurnId);
      if (!victim || victim.sessionId !== corrector.sessionId || // Predecessor guard: a causal reference points backward.
      victim.promptNumber >= corrector.promptNumber) {
        continue;
      }
      correctors.add(corrector.id);
      supersededVictims.add(victim.id);
      const bucket = supersedersByVictim.get(victim.id) ?? [];
      bucket.push(corrector);
      supersedersByVictim.set(victim.id, bucket);
    }
  }
  const supersededBy = /* @__PURE__ */ new Map();
  for (const [victimId, superseders] of supersedersByVictim) {
    supersededBy.set(
      victimId,
      [...superseders].sort((left, right) => left.promptNumber - right.promptNumber).map((turn) => turn.id)
    );
  }
  return { correctors, supersededVictims, supersededBy };
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
    const emoji3 = typeEmoji(turn.type);
    if (current === null || current.kind !== kind || current.type !== turn.type) {
      if (current !== null) {
        current.durationMs = (currentEndEpoch - currentStartEpoch) * 1e3;
      }
      current = {
        kind,
        type: turn.type,
        emoji: emoji3,
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
function compareMilestoneRank(left, right) {
  if (left.score !== right.score) return right.score - left.score;
  return left.turn.promptNumber - right.turn.promptNumber;
}
function selectMilestoneTurns(view) {
  const eraCutoff = view.taskCausalityEraCutoffEpoch;
  const universe = view.sessionTurns ?? view.windowTurns;
  const seq = sortTurnsForAnalysis(view.windowTurns).filter(
    (turn) => turn.status !== "skipped" && turn.type !== "compact"
  );
  if (seq.length === 0) {
    return {
      kept: [],
      ranked: [],
      pulled: [],
      overflowByDay: [],
      effGradeByTurnId: /* @__PURE__ */ new Map()
    };
  }
  const citations = view.citations ?? inlineCitationFallback(universe);
  const inDegree = citationInDegree(citations);
  const universeById = new Map(universe.map((turn) => [turn.id, turn]));
  const inWindowById = new Map(seq.map((turn) => [turn.id, turn]));
  const graph = buildCorrectionGraph(seq, {
    citations,
    resolveCited: (id) => universeById.get(id),
    taskCausalityEraCutoffEpoch: eraCutoff
  });
  const effGradeOf = (turn) => {
    const raw = milestoneEffGrade(turn, eraCutoff);
    if (graph.supersededVictims.has(turn.id)) {
      return Math.min(raw, 1);
    }
    return graph.correctors.has(turn.id) ? Math.max(raw, 3) : raw;
  };
  const endpoints = /* @__PURE__ */ new Set([seq[0].id]);
  const lastTitled = [...seq].reverse().find((t) => t.title !== null && t.title !== "");
  endpoints.add((lastTitled ?? seq[seq.length - 1]).id);
  const demotedOutcomes = demotedOutcomePrompts(seq);
  const markerForSelection = (turn) => {
    const marker = milestoneMarker(turn);
    return marker === "outcome" && demotedOutcomes.has(turn.promptNumber) ? null : marker;
  };
  const isVictim = (turn) => graph.supersededVictims.has(turn.id);
  const isAlwaysKeep = (turn) => {
    if (endpoints.has(turn.id)) {
      return true;
    }
    if (isVictim(turn)) {
      return false;
    }
    if (graph.correctors.has(turn.id)) {
      return true;
    }
    if (milestoneMarker(turn) === "reversed") {
      return true;
    }
    return isTaskCausalityEra(turn.createdAtEpoch, eraCutoff) && effGradeOf(turn) === 4;
  };
  const promptNumbersOf = (turnIds) => turnIds.map((id) => universeById.get(id)?.promptNumber ?? inWindowById.get(id)?.promptNumber).filter((promptNumber) => promptNumber !== void 0);
  const keptIds = /* @__PURE__ */ new Set();
  const rows = [];
  const poolRows = [];
  for (const turn of seq) {
    const effGrade = effGradeOf(turn);
    const alwaysKeep = isAlwaysKeep(turn);
    const spine = !isVictim(turn) && effGrade >= MILESTONE_SPINE_MIN_EFF_GRADE;
    if (!alwaysKeep && !spine && effGrade < MILESTONE_POOL_MIN_EFF_GRADE) {
      continue;
    }
    const superseders = graph.supersededBy.get(turn.id);
    const row = {
      turn,
      score: effGrade + milestoneTieBreak(turn, inDegree.get(turn.id) ?? 0),
      effGrade,
      alwaysKeep,
      spine,
      marker: markerForSelection(turn),
      ...superseders ? { supersededBy: promptNumbersOf(superseders) } : {}
    };
    poolRows.push(row);
    if (alwaysKeep || spine) {
      keptIds.add(turn.id);
      rows.push(row);
    }
  }
  const ranked = [...poolRows].sort(compareMilestoneRank);
  const pulled = [];
  const pulledIds = /* @__PURE__ */ new Set();
  const pulledByTurnId = /* @__PURE__ */ new Map();
  for (const row of rows) {
    const entry = citations.get(row.turn.id);
    if (entry === void 0) {
      continue;
    }
    for (const citedTurnId of entry.citedTurnIds) {
      if (keptIds.has(citedTurnId)) {
        continue;
      }
      const already = pulledByTurnId.get(citedTurnId);
      if (already !== void 0) {
        if (!already.citerPromptNumbers.includes(row.turn.promptNumber)) {
          already.citerPromptNumbers.push(row.turn.promptNumber);
        }
        continue;
      }
      const cited = universeById.get(citedTurnId);
      if (cited === void 0 || cited.type === "compact" || cited.sessionId !== row.turn.sessionId || // Predecessor guard: a causal reference points backward.
      cited.promptNumber >= row.turn.promptNumber) {
        continue;
      }
      const effGrade = effGradeOf(cited);
      if (effGrade > MILESTONE_PULL_MAX_EFF_GRADE) {
        continue;
      }
      pulledIds.add(citedTurnId);
      const antecedent = {
        turn: cited,
        effGrade,
        citedByPromptNumber: row.turn.promptNumber,
        citerPromptNumbers: [row.turn.promptNumber],
        label: pulledAntecedentLabel(cited),
        supersededBy: promptNumbersOf(graph.supersededBy.get(citedTurnId) ?? [])
      };
      pulled.push(antecedent);
      pulledByTurnId.set(citedTurnId, antecedent);
    }
  }
  const overflowByDay = [];
  const droppedByDay = /* @__PURE__ */ new Map();
  for (const turn of seq) {
    if (keptIds.has(turn.id) || pulledIds.has(turn.id)) {
      continue;
    }
    const day = formatLocalDate(turn.createdAtEpoch);
    const bucket = droppedByDay.get(day) ?? [];
    bucket.push(turn);
    droppedByDay.set(day, bucket);
  }
  for (const [date5, dropped] of droppedByDay) {
    const byPrompt = [...dropped].sort((a, b) => a.promptNumber - b.promptNumber);
    overflowByDay.push({
      date: date5,
      count: byPrompt.length,
      firstPrompt: byPrompt[0].promptNumber,
      lastPrompt: byPrompt[byPrompt.length - 1].promptNumber,
      labelEpoch: byPrompt[0].createdAtEpoch
    });
  }
  const effGradeByTurnId = /* @__PURE__ */ new Map();
  for (const turn of seq) {
    effGradeByTurnId.set(turn.id, effGradeOf(turn));
  }
  return { kept: rows, ranked, pulled, overflowByDay, effGradeByTurnId };
}
function pulledAntecedentLabel(turn, signal) {
  if (turn.title !== null && turn.title.trim() !== "") {
    return turn.title;
  }
  const prompt = cleanPromptForLabel(turn.userPrompt);
  return prompt === "" ? "(untitled)" : truncateText(prompt, { limit: MILESTONE_PULLED_LABEL_CAP, signal });
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
function buildTimelineView(db, input, preloadedTurns, preloadedCitations) {
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
  const eraCutoffEpoch = input.eraCutoffEpoch ?? null;
  const isEra = (turn) => isSegmentEra(turn.createdAtEpoch, eraCutoffEpoch);
  const eraWindowTurns = eraCutoffEpoch === null ? [] : windowTurns.filter(isEra);
  const legacyWindowTurns = eraCutoffEpoch === null ? windowTurns : windowTurns.filter((turn) => !isEra(turn));
  const legacySessionTurns = eraCutoffEpoch === null ? allTurns : allTurns.filter((turn) => !isEra(turn));
  const eraSessionTurns = eraCutoffEpoch === null ? [] : allTurns.filter(isEra);
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
  const jsonlPath = resolveSessionTranscriptPath(session) ?? null;
  const tz = getSystemTimezone(session.createdAtEpoch);
  const breadcrumb = deriveTimelineBreadcrumb(db, session);
  const citations = preloadedCitations ?? getSessionEffectiveCitations(db, session.id);
  const milestoneSelection = selectMilestoneTurns({
    session,
    windowTurns: legacyWindowTurns,
    windowSignals,
    compactBoundaries,
    sessionTurns: legacySessionTurns,
    citations
  });
  const phases = segmentPhases(windowTurns);
  const nonSkippedTurns = windowTurns.filter((turn) => turn.status !== "skipped");
  const pagedTurns = viewKind === "turns" ? paginateItems(nonSkippedTurns, page, pageSize) : emptyPaginatedItems(nonSkippedTurns.length, pageSize);
  const milestoneTail = viewKind === "milestones" && input.milestoneTail === true;
  const pagedMilestones = viewKind === "milestones" ? milestoneTail ? tailItems(milestoneSelection.kept, pageSize) : paginateItems(milestoneSelection.kept, page, pageSize) : emptyPaginatedItems(milestoneSelection.kept.length, pageSize);
  const milestoneDayGroups = viewKind === "milestones" ? buildMilestoneDayGroups(
    pagedMilestones.items,
    milestoneSelection.kept,
    milestoneSelection.overflowByDay
  ) : [];
  const pagedPhases = viewKind === "phases" ? paginateItems(phases, page, pageSize) : emptyPaginatedItems(phases.length, pageSize);
  const renderSegments = viewKind === "milestones" && eraCutoffEpoch !== null;
  const eraWindowTurnIds = new Set(eraWindowTurns.map((turn) => turn.id));
  const segmentSpine = renderSegments ? listSegmentSpineForSession(db, session.id, eraCutoffEpoch, eraWindowTurnIds) : [];
  const orphanAnchors = renderSegments ? listOrphanAnchorTurns(db, session.id, eraCutoffEpoch, eraWindowTurnIds) : [];
  const eraMilestoneSelection = renderSegments ? selectMilestoneTurns({
    session,
    windowTurns: eraWindowTurns,
    windowSignals,
    compactBoundaries,
    sessionTurns: eraSessionTurns,
    citations
  }) : EMPTY_MILESTONE_SELECTION;
  const eraSegmentIdByTurnId = renderSegments ? getSegmentMembershipForTurns(db, eraWindowTurns.map((turn) => turn.id)) : /* @__PURE__ */ new Map();
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
    milestonePulled: viewKind === "milestones" ? milestoneSelection.pulled : [],
    turnEffGrades: milestoneSelection.effGradeByTurnId,
    milestoneDayGroups,
    pagedPhases: pagedPhases.items,
    viewItemTotal,
    pageAnchorEpoch,
    page,
    pageSize,
    pageCount,
    windowSignals,
    jsonlPath,
    tz,
    hasEarlier: milestoneTail ? pagedMilestones.items.length < milestoneSelection.kept.length : false,
    milestoneTail,
    breadcrumb,
    eraCutoffEpoch,
    eraWindowTurns,
    segmentSpine,
    orphanAnchors,
    eraKeptMilestones: eraMilestoneSelection.kept,
    eraMilestonePulled: eraMilestoneSelection.pulled,
    eraSegmentIdByTurnId
  };
}
function buildMilestoneDayGroups(pagedMilestones, allMilestones, overflowByDay) {
  if (pagedMilestones.length === 0) return [];
  const dayKey = (m) => formatLocalDate(m.turn.createdAtEpoch);
  const fullByDay = /* @__PURE__ */ new Map();
  for (const m of allMilestones) {
    const key = dayKey(m);
    const bucket = fullByDay.get(key) ?? [];
    bucket.push(m);
    fullByDay.set(key, bucket);
  }
  const overflowFor = new Map(overflowByDay.map((o) => [o.date, o]));
  const groups = [];
  for (const m of pagedMilestones) {
    const key = dayKey(m);
    let group = groups.length > 0 && groups[groups.length - 1].date === key ? groups[groups.length - 1] : null;
    if (group === null) {
      const full = fullByDay.get(key) ?? [];
      const fullPrompts = full.map((x) => x.turn.promptNumber);
      group = {
        date: key,
        labelEpoch: m.turn.createdAtEpoch,
        promptLo: Math.min(...fullPrompts),
        promptHi: Math.max(...fullPrompts),
        keptCount: full.length,
        rows: [],
        continued: false,
        isFinalSliceForDay: false,
        overflow: null
      };
      groups.push(group);
    }
    group.rows.push(m);
  }
  if (groups.length > 0) {
    const spanFrom = groups[0].date;
    const spanTo = groups[groups.length - 1].date;
    const groupedDates = new Set(groups.map((group) => group.date));
    let materialized = false;
    for (const hint of overflowByDay) {
      if (groupedDates.has(hint.date) || hint.date < spanFrom || hint.date > spanTo) {
        continue;
      }
      groups.push({
        date: hint.date,
        labelEpoch: hint.labelEpoch,
        promptLo: hint.firstPrompt,
        promptHi: hint.lastPrompt,
        keptCount: 0,
        rows: [],
        continued: false,
        isFinalSliceForDay: false,
        overflow: null
      });
      materialized = true;
    }
    if (materialized) {
      groups.sort((left, right) => left.labelEpoch - right.labelEpoch);
    }
  }
  for (const group of groups) {
    const full = fullByDay.get(group.date) ?? [];
    const dayFirstPrompt = full[0]?.turn.promptNumber ?? -1;
    const dayLastPrompt = full[full.length - 1]?.turn.promptNumber ?? -1;
    const firstRowPrompt = group.rows[0]?.turn.promptNumber ?? -1;
    const lastRowPrompt = group.rows[group.rows.length - 1]?.turn.promptNumber ?? -1;
    group.continued = firstRowPrompt !== dayFirstPrompt;
    group.isFinalSliceForDay = lastRowPrompt === dayLastPrompt;
    if (group.isFinalSliceForDay) {
      group.overflow = overflowFor.get(group.date) ?? null;
    }
  }
  return groups;
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
  if (view.milestoneTail) {
    return `${view.view} \xB7 last ${view.pagedMilestones.length}/${view.viewItemTotal}${anchor}`;
  }
  return `${view.view} \xB7 page ${view.page}/${view.pageCount} (${view.viewItemTotal})${anchor}`;
}
function renderTurnTable(view, promptCap, titleCap, signal) {
  const renderedTurns = view.pageTurns.map((turn) => ({
    turn,
    marker: null
  }));
  return renderTurnRows(view, renderedTurns, promptCap, titleCap, signal);
}
var MILESTONE_MARKER_GLYPH = {
  invalidated: "\u{1F6AB}",
  reversed: "\u21A9\uFE0F",
  outcome: "\u{1F3C1}"
};
function truncateToTokens(text, maxTokens) {
  if (maxTokens <= 0) {
    return "";
  }
  if (estimateDiaryTokens(text) <= maxTokens) {
    return text;
  }
  const points = [...text];
  let low = 0;
  let high = points.length;
  let best = "";
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = `${points.slice(0, mid).join("")}\u2026`;
    if (estimateDiaryTokens(candidate) <= maxTokens) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}
function wrapPlainText(text, width) {
  const points = [...text];
  const lines = [];
  let start = 0;
  while (start < points.length) {
    if (points.length - start <= width) {
      lines.push(points.slice(start).join(""));
      break;
    }
    const hardEnd = start + width;
    let breakAt = -1;
    for (let index = hardEnd; index > start; index -= 1) {
      if (points[index] === " ") {
        breakAt = index;
        break;
      }
    }
    if (breakAt > start) {
      lines.push(points.slice(start, breakAt).join(""));
      start = breakAt + 1;
    } else {
      lines.push(points.slice(start, hardEnd).join(""));
      start = hardEnd;
    }
  }
  return lines;
}
function pathBasename(path2) {
  const parts = path2.split("/");
  return parts[parts.length - 1] || path2;
}
function renderModifiedFilesTail(turn) {
  if (turn.filesModified.length === 0) {
    return "";
  }
  const shown = turn.filesModified.slice(0, MILESTONE_FILE_BASENAME_CAP).map(pathBasename);
  const hidden = turn.filesModified.length - shown.length;
  return `  \u270F\uFE0F${shown.join(",")}${hidden > 0 ? `+${hidden}` : ""}`;
}
function milestonePromptPrefix(turn, signal) {
  const raw = turn.userPrompt;
  if (raw === null) {
    return "";
  }
  const commandName = extractCommandName(raw);
  if (commandName === null && isKnownSystemInjectedContent(raw.trimStart())) {
    return MILESTONE_NOTIFICATION_MARKER;
  }
  return truncateText(cleanPromptForLabel(raw), {
    limit: MILESTONE_PROMPT_PREFIX_CAP,
    signal
  });
}
function initialUnitTrim(unit) {
  return {
    showDesc: true,
    descTokens: null,
    pulledShown: Math.min(unit.pulled.length, MILESTONE_UNIT_PULLED_CAP),
    pulledTitleTokens: null,
    titleTokens: null,
    promptTokens: null,
    showFiles: true
  };
}
function milestoneDescText(turn) {
  return (turn.content ?? "").replace(/\s+/g, " ").trim();
}
function renderUnitLines(unit, trim, titleCap, signal) {
  const { milestone } = unit;
  const glyph = milestone.marker === null ? "  " : MILESTONE_MARKER_GLYPH[milestone.marker];
  let prompt = sanitizeTimelineField(milestonePromptPrefix(milestone.turn, signal));
  if (trim.promptTokens !== null) {
    prompt = truncateToTokens(prompt, trim.promptTokens);
  }
  let title = sanitizeTimelineField(
    truncateText(milestone.turn.title ?? "(untitled)", { limit: titleCap, signal })
  );
  if (trim.titleTokens !== null) {
    title = truncateToTokens(title, trim.titleTokens);
  }
  const head = prompt !== "" && title !== "" ? `${prompt} \u2192 ${title}` : `${prompt}${title}`;
  const filesTail = trim.showFiles ? renderModifiedFilesTail(milestone.turn) : "";
  const lines = [
    `   ${glyph} T${milestone.turn.promptNumber} ${typeEmoji(milestone.turn.type)} G${milestone.effGrade} ${head}${filesTail}`.trimEnd()
  ];
  if (trim.showDesc) {
    const raw = milestoneDescText(milestone.turn);
    const desc = trim.descTokens === null ? raw : truncateToTokens(raw, trim.descTokens);
    if (desc !== "") {
      for (const line of wrapPlainText(desc, MILESTONE_DESC_WRAP_CHARS)) {
        lines.push(`${MILESTONE_DESC_INDENT}${line}`);
      }
    }
  }
  for (const antecedent of unit.pulled.slice(0, trim.pulledShown)) {
    const superseded = antecedent.supersededBy.length > 0;
    const reversalGlyph = superseded ? `${MILESTONE_MARKER_GLYPH.invalidated} ` : "";
    let label = sanitizeTimelineField(
      truncateText(pulledAntecedentLabel(antecedent.turn, signal), {
        limit: titleCap,
        signal
      })
    );
    if (trim.pulledTitleTokens !== null) {
      label = truncateToTokens(label, trim.pulledTitleTokens);
    }
    const backLink = superseded ? ` \u2192\u88ABT${antecedent.supersededBy.join("/T")}\u63A8\u7FFB` : "";
    lines.push(
      `      \u21B3 ${reversalGlyph}T${antecedent.turn.promptNumber} ${typeEmoji(antecedent.turn.type)} G${antecedent.effGrade} ${label}${backLink}`
    );
  }
  const foldedPulled = unit.pulled.length - trim.pulledShown;
  if (foldedPulled > 0) {
    lines.push(`      \u21B3 +${foldedPulled} \u524D\u4EF6`);
  }
  return lines;
}
function unitTokens(unit, trim, titleCap, signal) {
  return estimateDiaryTokens(renderUnitLines(unit, trim, titleCap, signal).join("\n"));
}
function largestFittingTokens(unit, trim, titleCap, cap, apply, signal) {
  let low = 0;
  let high = cap;
  let best = -1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    apply(mid);
    if (unitTokens(unit, trim, titleCap, signal) <= cap) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  apply(best < 0 ? 0 : best);
  return best;
}
function fitUnitTrim(unit, titleCap, cap, base, signal) {
  const trim = { ...base };
  if (unitTokens(unit, trim, titleCap, signal) <= cap) {
    return trim;
  }
  if (trim.showDesc && milestoneDescText(unit.milestone.turn) !== "") {
    const best = largestFittingTokens(
      unit,
      trim,
      titleCap,
      cap,
      (value) => {
        trim.descTokens = value;
      },
      signal
    );
    if (best <= 0) {
      trim.showDesc = false;
      trim.descTokens = null;
    } else {
      return trim;
    }
  }
  if (unitTokens(unit, trim, titleCap, signal) <= cap) {
    return trim;
  }
  while (trim.pulledShown > 0 && unitTokens(unit, trim, titleCap, signal) > cap) {
    trim.pulledShown -= 1;
  }
  if (unitTokens(unit, trim, titleCap, signal) <= cap) {
    return trim;
  }
  trim.showFiles = false;
  if (unitTokens(unit, trim, titleCap, signal) <= cap) {
    return trim;
  }
  if (trim.pulledShown > 0) {
    largestFittingTokens(
      unit,
      trim,
      titleCap,
      cap,
      (value) => {
        trim.pulledTitleTokens = value;
      },
      signal
    );
    if (unitTokens(unit, trim, titleCap, signal) <= cap) {
      return trim;
    }
  }
  largestFittingTokens(
    unit,
    trim,
    titleCap,
    cap,
    (value) => {
      trim.titleTokens = value;
    },
    signal
  );
  if (unitTokens(unit, trim, titleCap, signal) <= cap) {
    return trim;
  }
  largestFittingTokens(
    unit,
    trim,
    titleCap,
    cap,
    (value) => {
      trim.promptTokens = value;
    },
    signal
  );
  return trim;
}
function renderUnitFitted(unit, titleCap, descOff, signal) {
  const base = initialUnitTrim(unit);
  if (descOff) {
    base.showDesc = false;
  }
  const trim = fitUnitTrim(unit, titleCap, MILESTONE_UNIT_TOKEN_CAP, base, signal);
  const lines = renderUnitLines(unit, trim, titleCap, signal);
  if (estimateDiaryTokens(lines.join("\n")) <= MILESTONE_UNIT_TOKEN_CAP) {
    return lines;
  }
  return [truncateToTokens(lines[0] ?? "", MILESTONE_UNIT_TOKEN_CAP)];
}
var HAN_WEIGHT_TENTHS = 11;
var OTHER_WEIGHT_TENTHS = 6;
var NEWLINE_WEIGHT_TENTHS = OTHER_WEIGHT_TENTHS;
function textWeightTenths(text) {
  let total = 0;
  for (const codePoint of text) {
    total += new RegExp("\\p{Script=Han}", "u").test(codePoint) ? HAN_WEIGHT_TENTHS : OTHER_WEIGHT_TENTHS;
  }
  return total;
}
function tokensFromWeightTenths(tenths) {
  return Math.ceil(tenths * 12 / 100);
}
function createMilestoneBodyModel(view, titleCap, signal) {
  const pagedPrompts = new Set(
    view.pagedMilestones.map((milestone) => milestone.turn.promptNumber)
  );
  const milestoneByPrompt = new Map(
    view.pagedMilestones.map((milestone) => [milestone.turn.promptNumber, milestone])
  );
  const mainRowTurnIds = new Set(
    view.pagedMilestones.map((milestone) => milestone.turn.id)
  );
  const pullable = view.milestonePulled.filter(
    (antecedent) => !mainRowTurnIds.has(antecedent.turn.id)
  );
  const pullOrder = new Map(
    pullable.map((antecedent, index) => [antecedent, index])
  );
  const antecedentDates = new Map(
    pullable.map(
      (antecedent) => [antecedent, formatLocalDate(antecedent.turn.createdAtEpoch)]
    )
  );
  const retainedPrompts = new Set(pagedPrompts);
  const removed = /* @__PURE__ */ new Set();
  const descOff = /* @__PURE__ */ new Set();
  const homedPulled = /* @__PURE__ */ new Map();
  const unitEntries = /* @__PURE__ */ new Map();
  const sections = view.milestoneDayGroups.map((group) => ({
    date: group.date,
    labelEpoch: group.labelEpoch,
    group
  }));
  const groupedDates = new Set(sections.map((section) => section.date));
  const syntheticEpochs = /* @__PURE__ */ new Map();
  for (const antecedent of pullable) {
    const date5 = antecedentDates.get(antecedent);
    if (groupedDates.has(date5)) {
      continue;
    }
    const known = syntheticEpochs.get(date5);
    if (known === void 0 || antecedent.turn.createdAtEpoch < known) {
      syntheticEpochs.set(date5, antecedent.turn.createdAtEpoch);
    }
  }
  for (const [date5, labelEpoch] of syntheticEpochs) {
    sections.push({ date: date5, labelEpoch, group: null });
  }
  sections.sort((left, right) => left.labelEpoch - right.labelEpoch);
  const orderedStates = sections.map((section, index) => {
    const overflow = section.group?.overflow ?? null;
    return {
      section,
      index,
      rows: section.group === null ? [] : [...section.group.rows],
      droppedCount: 0,
      hiddenCount: overflow?.count ?? 0,
      hiddenLo: overflow?.firstPrompt ?? Number.POSITIVE_INFINITY,
      hiddenHi: overflow?.lastPrompt ?? Number.NEGATIVE_INFINITY,
      frameTenths: 0,
      unitTenths: 0,
      run: null
    };
  });
  const stateByDate = new Map(
    orderedStates.map((state) => [state.section.date, state])
  );
  const stateOfMilestone = /* @__PURE__ */ new Map();
  for (const state of orderedStates) {
    for (const milestone of state.rows) {
      stateOfMilestone.set(milestone, state);
    }
  }
  let totalTenths = 0;
  let priced = false;
  let framed = false;
  function lineTenths(line) {
    return textWeightTenths(line) + NEWLINE_WEIGHT_TENTHS;
  }
  function unitEntryFor(milestone) {
    const cached2 = unitEntries.get(milestone);
    if (cached2 !== void 0) {
      return cached2;
    }
    const pulled = [...homedPulled.get(milestone.turn.promptNumber) ?? []].sort(
      (left, right) => (pullOrder.get(left) ?? 0) - (pullOrder.get(right) ?? 0)
    );
    const lines = renderUnitFitted(
      { milestone, pulled },
      titleCap,
      descOff.has(milestone),
      signal
    );
    const entry = {
      lines,
      tenths: lines.reduce((sum, line) => sum + lineTenths(line), 0)
    };
    unitEntries.set(milestone, entry);
    return entry;
  }
  function invalidateUnit(milestone) {
    const previous = unitEntries.get(milestone);
    unitEntries.delete(milestone);
    const state = stateOfMilestone.get(milestone);
    if (!priced || state === void 0 || removed.has(milestone)) {
      return;
    }
    const delta = unitEntryFor(milestone).tenths - (previous?.tenths ?? 0);
    state.unitTenths += delta;
    totalTenths += delta;
  }
  function linesTenths(lines) {
    return lines.reduce((sum, line) => sum + lineTenths(line), 0);
  }
  function hiddenHint(hidden, promptLo, promptHi) {
    return `\u2026 +${hidden} more @ within T${promptLo}..T${promptHi}`;
  }
  function expandedFrameLines(state) {
    const group = state.section.group;
    const header = `\u2500\u2500 ${formatLocalDateWithWeekday(group.labelEpoch)} \xB7 T${group.promptLo}\u2013T${group.promptHi} \xB7 ${group.keptCount - state.droppedCount} kept${group.continued ? " (cont.)" : ""} \u2500\u2500`;
    if (state.hiddenCount === 0) {
      return [header];
    }
    return [
      header,
      `        ${hiddenHint(state.hiddenCount, state.hiddenLo, state.hiddenHi)}`
    ];
  }
  function runLines(run) {
    if (run.hidden === 0) {
      return [];
    }
    const from = formatLocalDateWithWeekday(run.first.section.labelEpoch);
    const to = formatLocalDateWithWeekday(run.last.section.labelEpoch);
    const span = run.first === run.last ? from : `${from}\u2013${to}`;
    return [
      `\u2500\u2500 ${span} \xB7 0 kept \xB7 ${hiddenHint(run.hidden, run.promptLo, run.promptHi)} \u2500\u2500`
    ];
  }
  function refreshExpandedFrame(state) {
    const tenths = linesTenths(expandedFrameLines(state));
    totalTenths += tenths - state.frameTenths;
    state.frameTenths = tenths;
  }
  function priceRun(run) {
    const tenths = linesTenths(runLines(run));
    totalTenths += tenths - run.tenths;
    run.tenths = tenths;
  }
  function collapseState(state) {
    totalTenths -= state.frameTenths;
    state.frameTenths = 0;
    const left = state.index > 0 ? orderedStates[state.index - 1].run : null;
    const right = state.index + 1 < orderedStates.length ? orderedStates[state.index + 1].run : null;
    const absorbed = [];
    let run;
    if (left === null && right === null) {
      run = {
        members: [],
        first: state,
        last: state,
        hidden: 0,
        promptLo: Number.POSITIVE_INFINITY,
        promptHi: Number.NEGATIVE_INFINITY,
        tenths: 0
      };
    } else if (left !== null && right !== null) {
      run = left.members.length >= right.members.length ? left : right;
      absorbed.push(run === left ? right : left);
    } else {
      run = left ?? right;
    }
    run.members.push(state);
    state.run = run;
    for (const other of absorbed) {
      totalTenths -= other.tenths;
      for (const member of other.members) {
        member.run = run;
        run.members.push(member);
      }
      run.hidden += other.hidden;
      run.promptLo = Math.min(run.promptLo, other.promptLo);
      run.promptHi = Math.max(run.promptHi, other.promptHi);
      if (other.first.index < run.first.index) {
        run.first = other.first;
      }
      if (other.last.index > run.last.index) {
        run.last = other.last;
      }
    }
    run.hidden += state.hiddenCount;
    run.promptLo = Math.min(run.promptLo, state.hiddenLo);
    run.promptHi = Math.max(run.promptHi, state.hiddenHi);
    if (state.index < run.first.index) {
      run.first = state;
    }
    if (state.index > run.last.index) {
      run.last = state;
    }
    priceRun(run);
  }
  function noteHidden(state, promptNumber) {
    state.hiddenCount += 1;
    state.hiddenLo = Math.min(state.hiddenLo, promptNumber);
    state.hiddenHi = Math.max(state.hiddenHi, promptNumber);
    if (!framed) {
      return;
    }
    const { run } = state;
    if (run === null) {
      refreshExpandedFrame(state);
      return;
    }
    run.hidden += 1;
    run.promptLo = Math.min(run.promptLo, promptNumber);
    run.promptHi = Math.max(run.promptHi, promptNumber);
    priceRun(run);
  }
  function homeAntecedent(antecedent) {
    const home = antecedent.citerPromptNumbers.find(
      (promptNumber) => retainedPrompts.has(promptNumber)
    );
    if (home !== void 0) {
      homedPulled.set(home, [...homedPulled.get(home) ?? [], antecedent]);
      const host = milestoneByPrompt.get(home);
      if (host !== void 0) {
        invalidateUnit(host);
      }
      return;
    }
    if (!antecedent.citerPromptNumbers.some((promptNumber) => pagedPrompts.has(promptNumber))) {
      return;
    }
    const state = stateByDate.get(antecedentDates.get(antecedent));
    if (state === void 0) {
      return;
    }
    noteHidden(state, antecedent.turn.promptNumber);
  }
  for (const antecedent of pullable) {
    homeAntecedent(antecedent);
  }
  for (const state of orderedStates) {
    state.unitTenths = state.rows.reduce(
      (sum, milestone) => sum + unitEntryFor(milestone).tenths,
      0
    );
    totalTenths += state.unitTenths;
  }
  priced = true;
  for (const state of orderedStates) {
    if (state.rows.length === 0) {
      collapseState(state);
    } else {
      refreshExpandedFrame(state);
    }
  }
  framed = true;
  totalTenths += NEWLINE_WEIGHT_TENTHS;
  return {
    disableDesc(milestone) {
      if (descOff.has(milestone) || removed.has(milestone)) {
        return;
      }
      descOff.add(milestone);
      invalidateUnit(milestone);
    },
    removeUnit(milestone) {
      if (removed.has(milestone)) {
        return;
      }
      const promptNumber = milestone.turn.promptNumber;
      removed.add(milestone);
      retainedPrompts.delete(promptNumber);
      const state = stateOfMilestone.get(milestone);
      if (state !== void 0) {
        const entry = unitEntryFor(milestone);
        state.unitTenths -= entry.tenths;
        totalTenths -= entry.tenths;
        state.rows = state.rows.filter((row) => row !== milestone);
        state.droppedCount += 1;
        state.hiddenCount += 1;
        state.hiddenLo = Math.min(state.hiddenLo, promptNumber);
        state.hiddenHi = Math.max(state.hiddenHi, promptNumber);
        if (state.rows.length === 0) {
          collapseState(state);
        } else {
          refreshExpandedFrame(state);
        }
      }
      unitEntries.delete(milestone);
      const orphaned = homedPulled.get(promptNumber) ?? [];
      homedPulled.delete(promptNumber);
      for (const antecedent of orphaned) {
        homeAntecedent(antecedent);
      }
    },
    weightTenths() {
      return totalTenths;
    },
    lines() {
      const out = [""];
      for (const state of orderedStates) {
        if (state.rows.length === 0) {
          const { run } = state;
          if (run !== null && run.first === state) {
            out.push(...runLines(run));
          }
          continue;
        }
        const frame = expandedFrameLines(state);
        out.push(frame[0]);
        for (const milestone of state.rows) {
          out.push(...unitEntryFor(milestone).lines);
        }
        if (frame[1] !== void 0) {
          out.push(frame[1]);
        }
      }
      return out;
    },
    hasHiddenTurns() {
      return orderedStates.some((state) => state.hiddenCount > 0);
    }
  };
}
function renderMilestoneBody(view, titleCap, signal) {
  if (view.milestoneDayGroups.length === 0) {
    return { lines: [], hiddenTurns: false };
  }
  const body = createMilestoneBodyModel(view, titleCap, signal);
  return { lines: body.lines(), hiddenTurns: body.hasHiddenTurns() };
}
function milestoneDegradationOrder(view) {
  return [...view.pagedMilestones].sort(compareMilestoneRank).reverse();
}
function fitMilestoneBodyToBudget(view, titleCap, tokenBudget, fixedWeightTenths, measure, signal) {
  const body = createMilestoneBodyModel(view, titleCap, signal);
  const fits = () => tokensFromWeightTenths(fixedWeightTenths + body.weightTenths()) <= tokenBudget && measure(body.lines(), body.hasHiddenTurns()) <= tokenBudget;
  const result = () => ({
    lines: body.lines(),
    hiddenTurns: body.hasHiddenTurns()
  });
  if (fits()) {
    return result();
  }
  for (const milestone of milestoneDegradationOrder(view)) {
    body.disableDesc(milestone);
    if (fits()) {
      return result();
    }
  }
  for (const milestone of milestoneDegradationOrder(view)) {
    if (milestone.alwaysKeep) {
      continue;
    }
    body.removeUnit(milestone);
    if (fits()) {
      return result();
    }
  }
  return { lines: [...body.lines(), MILESTONE_OVER_BUDGET_NOTE], hiddenTurns: body.hasHiddenTurns() };
}
function renderTurnRows(view, renderedTurns, promptCap, titleCap, signal) {
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
    TURN_TABLE_HEADER
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
        titleCap,
        view.turnEffGrades.get(turn.id),
        marker,
        signal
      )
    );
    previousRenderedEpoch = turn.createdAtEpoch;
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
function renderTurnRow(turn, prevEpoch, isBrokenPromptCandidate, promptCap, titleCap, effGrade, marker = null, signal) {
  const isUndone = turn.status === "undone";
  const compactMetadata = turn.type === "compact" ? getCompactMetadata(turn.tags) : null;
  const gapSuffix = isBrokenPromptCandidate ? " \u203B" : "";
  const sourceBadges = extractSourceTags(turn.tags).map((source) => `[ext:${source}]`).join(" ");
  const promptCore = turn.type === "compact" ? "/compact" : cleanPromptForLabel(turn.userPrompt);
  const promptWithBadges = turn.type === "compact" ? promptCore : sourceBadges.length > 0 ? `${sourceBadges} ${promptCore}` : promptCore;
  const promptText = sanitizeTimelineField(
    truncateText(promptWithBadges, { limit: promptCap, signal })
  );
  const renderedPrompt = isUndone ? `~~${promptText}~~` : promptText;
  const statusPrefix = isUndone ? "\u2A2F " : "";
  const titleText = sanitizeTimelineField(
    renderTitleCell(turn, isUndone, compactMetadata, titleCap, marker, signal)
  );
  return [
    `${statusPrefix}T${turn.promptNumber}`,
    formatTranscriptLineAnchor(turn.transcriptLineStart),
    formatLocalTime(turn.createdAtEpoch),
    `${formatGap(turn.createdAtEpoch, prevEpoch)}${gapSuffix}`,
    renderStats(turn),
    // Grade column (spec §D): the arc view and the turn table print the same
    // effGrade, so "how important" is read off the row instead of inferred from
    // the type icon. `—` is a turn with no main-row candidacy (a compact marker).
    effGrade === void 0 ? MISSING_GRADE_CELL : `G${effGrade}`,
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
function typeGlyph(type) {
  return (type === null ? void 0 : TYPE_EMOJI_MAP[type]) ?? "\u2022";
}
function renderTitleCell(turn, isUndone, compactMetadata, titleCap, marker = null, signal) {
  const markerPrefix = marker ? `${marker} ` : "";
  if (turn.type === "compact") {
    const preTokens = formatCompactTokenCount(compactMetadata?.preTokens ?? 0);
    const trigger = compactMetadata?.trigger ?? "manual";
    return `${markerPrefix}${TYPE_EMOJI_MAP.compact} /compact ${preTokens} tokens, ${trigger}`;
  }
  if (isUndone) {
    if (turn.title !== null) {
      const body = `${typeGlyph(turn.type)} ${truncateText(turn.title, { limit: titleCap, signal })}`;
      return `${markerPrefix}~~${body}~~`;
    }
    return `${markerPrefix}\u2A2F`.trim();
  }
  if (turn.status === "extracted" && turn.title !== null) {
    return `${markerPrefix}${typeGlyph(turn.type)} ${truncateText(turn.title, { limit: titleCap, signal })}`;
  }
  return `${markerPrefix}\u23F3`.trim();
}
function sanitizeTimelineField(value) {
  return value.replaceAll("|", "/").replaceAll("\u2192", "->");
}
function isTimelineLiveTurn(turn) {
  return turn.status !== "undone" && turn.status !== "skipped";
}
function renderPhases(view, titleCap, signal) {
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
    const leadTitle = sanitizeTimelineField(truncateText(leadText, { limit: titleCap, signal }));
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
  const upperBound = view.view === "milestones" && view.pagedMilestones.length > 0 ? view.pagedMilestones[0].turn.promptNumber - 1 : view.window.startPromptNumber - 1;
  return [
    "",
    `  earlier: timeline(id="S${view.session.id}/T${view.firstPromptNumber}..${upperBound}") or recall(id="S${view.session.id}")`
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
function withLegacyEraHeader(view, bodyLines, hasSpine) {
  if (!hasSpine || bodyLines.length === 0) {
    return bodyLines;
  }
  const legacyPrompts = view.windowTurns.filter((turn) => !isSegmentEra(turn.createdAtEpoch, view.eraCutoffEpoch)).map((turn) => turn.promptNumber);
  const header = legacyEraHeader(
    legacyPrompts.length > 0 ? Math.min(...legacyPrompts) : null,
    legacyPrompts.length > 0 ? Math.max(...legacyPrompts) : null
  );
  const [first, ...rest] = bodyLines;
  return first === "" ? ["", header, ...rest] : [header, ...bodyLines];
}
function renderEraMilestoneLines(view, titleCap, removed, descOff, signal) {
  const bySegment = /* @__PURE__ */ new Map();
  if (view.eraKeptMilestones.length === 0) {
    return bySegment;
  }
  const renderable = view.eraKeptMilestones.filter(
    (milestone) => !removed.has(milestone.turn.id) && view.eraSegmentIdByTurnId.has(milestone.turn.id)
  );
  const renderablePrompts = new Set(
    renderable.map((milestone) => milestone.turn.promptNumber)
  );
  const homedPulled = /* @__PURE__ */ new Map();
  for (const antecedent of view.eraMilestonePulled) {
    const home = antecedent.citerPromptNumbers.find(
      (promptNumber) => renderablePrompts.has(promptNumber)
    );
    if (home === void 0) {
      continue;
    }
    const bucket = homedPulled.get(home) ?? [];
    bucket.push(antecedent);
    homedPulled.set(home, bucket);
  }
  for (const milestone of renderable) {
    const segmentId = view.eraSegmentIdByTurnId.get(milestone.turn.id);
    const pulled = homedPulled.get(milestone.turn.promptNumber) ?? [];
    const lines = renderUnitFitted(
      { milestone, pulled },
      titleCap,
      descOff.has(milestone.turn.id),
      signal
    );
    const bucket = bySegment.get(segmentId) ?? [];
    bucket.push(...lines);
    bySegment.set(segmentId, bucket);
  }
  return bySegment;
}
function eraMilestoneDegradationOrder(kept) {
  return [...kept].sort(compareMilestoneRank).reverse();
}
function fitEraMilestonesToBudget(view, titleCap, tokenBudget, measure, signal) {
  if (view.eraKeptMilestones.length === 0) {
    return /* @__PURE__ */ new Map();
  }
  const removed = /* @__PURE__ */ new Set();
  const descOff = /* @__PURE__ */ new Set();
  const build = () => {
    const lines = renderEraMilestoneLines(view, titleCap, removed, descOff, signal);
    const spineLines = renderSegmentSpineBlock({
      spine: view.segmentSpine,
      orphans: view.orphanAnchors,
      titleCap,
      milestoneLinesBySegmentId: lines
    });
    return { lines, spineLines };
  };
  let current = build();
  if (measure(current.spineLines) <= tokenBudget) {
    return current.lines;
  }
  for (const milestone of eraMilestoneDegradationOrder(view.eraKeptMilestones)) {
    descOff.add(milestone.turn.id);
    current = build();
    if (measure(current.spineLines) <= tokenBudget) {
      return current.lines;
    }
  }
  for (const milestone of eraMilestoneDegradationOrder(view.eraKeptMilestones)) {
    removed.add(milestone.turn.id);
    current = build();
    if (measure(current.spineLines) <= tokenBudget) {
      return current.lines;
    }
  }
  return current.lines;
}
function renderTimeline(view, options = {}) {
  const promptCap = options.promptCap ?? PROMPT_COLUMN_CAP;
  const titleCap = options.titleCap ?? DEFAULT_TITLE_CAP;
  const signal = createTruncationSignal();
  const eraMilestoneLinesFull = view.view === "milestones" ? renderEraMilestoneLines(view, titleCap, EMPTY_TURN_ID_SET, EMPTY_TURN_ID_SET, signal) : /* @__PURE__ */ new Map();
  let spineLines = view.view === "milestones" ? renderSegmentSpineBlock({
    spine: view.segmentSpine,
    orphans: view.orphanAnchors,
    titleCap,
    milestoneLinesBySegmentId: eraMilestoneLinesFull
  }) : [];
  const assemble = (bodyLines, spineOverride = spineLines) => [
    ...renderSessionHeader(view),
    ...spineOverride,
    ...withLegacyEraHeader(view, bodyLines, spineOverride.length > 0),
    ...renderShapeSignals(view),
    ...renderEarlierHint(view, options),
    ...renderLineagePointer(view)
  ].join("\n");
  if (view.view === "phases") {
    return appendNavigationLegend(assemble(renderPhases(view, titleCap, signal)), {
      truncated: signal.truncated
    });
  }
  if (view.view !== "milestones") {
    return appendNavigationLegend(
      assemble(renderTurnTable(view, promptCap, titleCap, signal)),
      { truncated: signal.truncated }
    );
  }
  if (options.tokenBudget === void 0) {
    const body2 = renderMilestoneBody(view, titleCap, signal);
    return appendNavigationLegend(assemble(body2.lines), {
      truncated: body2.hiddenTurns || signal.truncated
    });
  }
  if (spineLines.length > 0) {
    const fittedMilestoneLines = fitEraMilestonesToBudget(
      view,
      titleCap,
      options.tokenBudget,
      (candidateSpineLines) => estimateDiaryTokens(assemble([], candidateSpineLines)),
      signal
    );
    spineLines = renderSegmentSpineBlock({
      spine: view.segmentSpine,
      orphans: view.orphanAnchors,
      titleCap,
      milestoneLinesBySegmentId: fittedMilestoneLines
    });
    shedSpineToBudget({
      view,
      titleCap,
      tokenBudget: options.tokenBudget,
      apply: (candidate) => {
        spineLines = candidate;
      },
      measure: () => estimateDiaryTokens(assemble([])),
      milestoneLinesBySegmentId: fittedMilestoneLines
    });
  }
  const body = fitMilestoneBodyToBudget(
    view,
    titleCap,
    options.tokenBudget,
    textWeightTenths(assemble([])),
    (bodyLines, hiddenTurns) => estimateDiaryTokens(
      appendNavigationLegend(assemble(bodyLines), {
        truncated: hiddenTurns || signal.truncated
      })
    ),
    signal
  );
  return appendNavigationLegend(assemble(body.lines), {
    truncated: body.hiddenTurns || signal.truncated
  });
}
function shedSpineToBudget(options) {
  const { view, titleCap, tokenBudget, apply, measure, milestoneLinesBySegmentId } = options;
  let segments = view.segmentSpine.length;
  let orphans = view.orphanAnchors.length;
  while (measure() > tokenBudget && (orphans > 0 || segments > 0)) {
    if (orphans > 0) {
      orphans -= 1;
    } else {
      segments -= 1;
    }
    apply(
      renderSegmentSpineBlock({
        spine: view.segmentSpine,
        orphans: view.orphanAnchors,
        titleCap,
        maxSegments: segments,
        maxOrphans: orphans,
        milestoneLinesBySegmentId
      })
    );
  }
}

// src/hooks/milestone-injection.ts
var MILESTONE_INJECTION_TOKEN_BUDGET = 2500;
function renderMilestoneInjection(view, options = {}) {
  return renderTimeline(view, {
    titleCap: DEFAULT_TITLE_CAP,
    tokenBudget: options.tokenBudget ?? MILESTONE_INJECTION_TOKEN_BUDGET,
    // The injection is not a paged surface: an "earlier" pointer would name a
    // window the reader never asked for.
    showEarlierHint: false
  });
}
function renderSessionMilestoneInjection(db, sessionId, options = {}) {
  const view = buildTimelineView(db, {
    id: `S${sessionId}`,
    view: "milestones",
    // One page holding every selected row: the token budget, not pagination, is
    // what sizes the injection.
    pageSize: Number.MAX_SAFE_INTEGER,
    eraCutoffEpoch: options.eraCutoffEpoch ?? null
  });
  return renderMilestoneInjection(view, options);
}

// src/hooks/handlers/context-milestones.ts
function sessionHasTurns(db, sessionId) {
  return db.query(
    "SELECT 1 AS present FROM turns WHERE session_id = ? LIMIT 1"
  ).get(sessionId) !== null;
}
function createMilestoneContextHandler(dependencies) {
  const eraCutoffEpoch = dependencies.eraCutoffEpoch !== void 0 ? dependencies.eraCutoffEpoch : resolveEraCutoff(dependencies.db);
  return async function handleMilestoneContextHook(input) {
    if (!input.sessionId || input.source !== "resume" && input.source !== "compact") {
      return { continue: true };
    }
    try {
      const session = getSessionByContentId(dependencies.db, input.sessionId);
      if (!session || !sessionHasTurns(dependencies.db, session.id)) {
        return { continue: true };
      }
      const hookSpecificOutput = dependencies.renderMilestoneInjection ? dependencies.renderMilestoneInjection(dependencies.db, session.id) : renderSessionMilestoneInjection(dependencies.db, session.id, {
        eraCutoffEpoch
      });
      return hookSpecificOutput ? { continue: true, hookSpecificOutput } : { continue: true };
    } catch {
      return { continue: true };
    }
  };
}

// src/hooks/handlers/context-note-taking.ts
var NOTE_TAKING_INSTRUCTIONS = `<mnemo-note-taking>
You keep notes on your own turns. The injected "mnemo current turn" line,
its owed suffix, and the backlog-relief block are the ONLY sources of a
note address \u2014 never recall one from memory, never invent one.
1. Each turn's first tool batch also settles owed turns \u2014 a note or a
   skip per address.
2. A turn's own note is written by a later turn, never by itself.
3. Never open a batch just for notes, except while the relief block is
   present or to correct a note already written.
Fields, budgets, the skip test, and replace live in the note tool's
description.
</mnemo-note-taking>`;
function createNoteTakingContextHandler() {
  return async function handleNoteTakingContextHook(input) {
    if (input.eventName !== "SessionStart") {
      return { continue: true };
    }
    return { continue: true, hookSpecificOutput: NOTE_TAKING_INSTRUCTIONS };
  };
}

// src/rules/pretooluse-dispatcher.ts
var import_node_fs7 = require("node:fs");
var import_node_crypto3 = require("node:crypto");
var import_node_path14 = require("node:path");

// src/rules/sidecar-protocol.ts
var import_node_crypto2 = require("node:crypto");
var import_node_fs6 = require("node:fs");
var import_node_path13 = require("node:path");
var SIDECAR_LOCK_WAIT_MS = 5e3;
var lockWaitArray = new Int32Array(new SharedArrayBuffer(4));
function isErrorCode(error48, code) {
  return error48 instanceof Error && "code" in error48 && error48.code === code;
}
function resolveHitSidecarLockPath(dataRoot) {
  return (0, import_node_path13.join)(dataRoot, "rules", "hits.lock");
}
function readLockOwner(path2) {
  try {
    const value = JSON.parse(
      (0, import_node_fs6.readFileSync)(path2, "utf8")
    );
    return Number.isInteger(value.pid) && value.pid > 0 && typeof value.token === "string" ? { pid: value.pid, token: value.token } : null;
  } catch {
    return null;
  }
}
function withHitSidecarLock(dataRoot, operation, options = {}) {
  const path2 = resolveHitSidecarLockPath(dataRoot);
  (0, import_node_fs6.mkdirSync)((0, import_node_path13.dirname)(path2), { recursive: true });
  const waitMs = options.waitMs ?? SIDECAR_LOCK_WAIT_MS;
  if (!Number.isFinite(waitMs) || waitMs < 0) {
    throw new Error("waitMs must be a non-negative finite number");
  }
  const owner = { pid: process.pid, token: (0, import_node_crypto2.randomUUID)() };
  const temporary = `${path2}.${owner.pid}.${owner.token}.tmp`;
  (0, import_node_fs6.writeFileSync)(temporary, JSON.stringify(owner), { mode: 384 });
  const deadline = performance.now() + waitMs;
  let acquired = false;
  try {
    while (performance.now() <= deadline) {
      try {
        (0, import_node_fs6.linkSync)(temporary, path2);
        acquired = true;
        break;
      } catch (error48) {
        if (!isErrorCode(error48, "EEXIST")) throw error48;
        Atomics.wait(lockWaitArray, 0, 0, 1);
      }
    }
    if (!acquired) {
      throw new Error("timed out waiting for the hit sidecar lock");
    }
    return operation();
  } finally {
    try {
      (0, import_node_fs6.unlinkSync)(temporary);
    } catch (error48) {
      if (!isErrorCode(error48, "ENOENT")) throw error48;
    }
    if (acquired && readLockOwner(path2)?.token === owner.token) {
      try {
        (0, import_node_fs6.unlinkSync)(path2);
      } catch (error48) {
        if (!isErrorCode(error48, "ENOENT")) throw error48;
      }
    }
  }
}

// src/rules/pretooluse-dispatcher.ts
var EVENT_HIT_LIMIT = 2;
var SESSION_LOCK_WAIT_MS = 35;
var STALE_SESSION_LOCK_MS = 3e4;
var lockWaitArray2 = new Int32Array(new SharedArrayBuffer(4));
function resolveTriggerIndexPath(dataRoot = DATA_DIR) {
  return (0, import_node_path14.join)(dataRoot, "rules", "trigger-index.json");
}
function resolveSessionStateDirectory(dataRoot = DATA_DIR) {
  return (0, import_node_path14.join)(dataRoot, "rules", "session-state");
}
function localDate(tsMs) {
  const date5 = new Date(tsMs);
  const year = date5.getFullYear();
  const month = String(date5.getMonth() + 1).padStart(2, "0");
  const day = String(date5.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
function resolveHitSidecarPath(dataRoot = DATA_DIR, tsMs = Date.now()) {
  return (0, import_node_path14.join)(dataRoot, "rules", `hits-${localDate(tsMs)}.jsonl`);
}
function sessionStatePath(dataRoot, sessionId) {
  const digest = (0, import_node_crypto3.createHash)("sha256").update(sessionId).digest("hex");
  return (0, import_node_path14.join)(resolveSessionStateDirectory(dataRoot), `${digest}.json`);
}
function readIndex(dataRoot) {
  try {
    return triggerIndexSchema.parse(
      JSON.parse((0, import_node_fs7.readFileSync)(resolveTriggerIndexPath(dataRoot), "utf8"))
    );
  } catch {
    return void 0;
  }
}
function readState(dataRoot, sessionId) {
  try {
    const parsed = JSON.parse(
      (0, import_node_fs7.readFileSync)(sessionStatePath(dataRoot, sessionId), "utf8")
    );
    if (parsed.version !== 1 || !Array.isArray(parsed.rule_ids)) return /* @__PURE__ */ new Set();
    return new Set(
      parsed.rule_ids.filter(
        (id) => Number.isInteger(id) && id > 0
      )
    );
  } catch {
    return /* @__PURE__ */ new Set();
  }
}
function writeState(dataRoot, sessionId, ruleIds) {
  const path2 = sessionStatePath(dataRoot, sessionId);
  (0, import_node_fs7.mkdirSync)((0, import_node_path14.dirname)(path2), { recursive: true });
  const temporary = `${path2}.${process.pid}.${(0, import_node_crypto3.randomUUID)()}.tmp`;
  (0, import_node_fs7.writeFileSync)(
    temporary,
    `${JSON.stringify({
      version: 1,
      rule_ids: [...ruleIds].sort((left, right) => left - right)
    })}
`,
    { mode: 384 }
  );
  (0, import_node_fs7.renameSync)(temporary, path2);
}
function acquireSessionLock(dataRoot, sessionId) {
  const statePath = sessionStatePath(dataRoot, sessionId);
  (0, import_node_fs7.mkdirSync)((0, import_node_path14.dirname)(statePath), { recursive: true });
  const path2 = `${statePath}.lock`;
  const deadline = performance.now() + SESSION_LOCK_WAIT_MS;
  while (performance.now() <= deadline) {
    try {
      return {
        descriptor: (0, import_node_fs7.openSync)(
          path2,
          import_node_fs7.constants.O_CREAT | import_node_fs7.constants.O_EXCL | import_node_fs7.constants.O_WRONLY,
          384
        ),
        path: path2
      };
    } catch (error48) {
      if (!(error48 instanceof Error) || !("code" in error48) || error48.code !== "EEXIST") {
        throw error48;
      }
      try {
        if (Date.now() - (0, import_node_fs7.statSync)(path2).mtimeMs > STALE_SESSION_LOCK_MS) {
          (0, import_node_fs7.unlinkSync)(path2);
          continue;
        }
      } catch {
        continue;
      }
      Atomics.wait(lockWaitArray2, 0, 0, 1);
    }
  }
  return void 0;
}
function releaseSessionLock(lock) {
  (0, import_node_fs7.closeSync)(lock.descriptor);
  try {
    (0, import_node_fs7.unlinkSync)(lock.path);
  } catch {
  }
}
function appendHits(path2, hits) {
  (0, import_node_fs7.mkdirSync)((0, import_node_path14.dirname)(path2), { recursive: true });
  const descriptor = (0, import_node_fs7.openSync)(
    path2,
    import_node_fs7.constants.O_APPEND | import_node_fs7.constants.O_CREAT | import_node_fs7.constants.O_WRONLY,
    384
  );
  try {
    (0, import_node_fs7.writeFileSync)(
      descriptor,
      `${hits.map((hit) => JSON.stringify(hit)).join("\n")}
`
    );
  } finally {
    (0, import_node_fs7.closeSync)(descriptor);
  }
}
function promptTriggerMatches(trigger, prompt) {
  const normalizedPrompt = prompt.toLowerCase();
  const matches = trigger.keywords.map(
    (keyword) => normalizedPrompt.includes(keyword.toLowerCase())
  );
  return trigger.match === "all" ? matches.every(Boolean) : matches.some(Boolean);
}
function triggerMatches(trigger, input) {
  return trigger.kind === "prompt" && promptTriggerMatches(trigger, input.prompt ?? "");
}
function hasRequiredIdentity(input) {
  return Boolean(input.sessionId && input.cwd && input.prompt);
}
function summarizePrompt(prompt) {
  return Array.from(prompt).slice(0, 200).join("");
}
function createHits(input, ruleIds, timestamp, randomUuid) {
  return ruleIds.map((ruleId) => ({
    hit_id: randomUuid(),
    content_session_id: input.sessionId,
    event_type: "UserPromptSubmit",
    ts_ms: timestamp,
    rule_id: ruleId,
    prompt_summary: summarizePrompt(input.prompt)
  }));
}
function createDispatcher(eventName, dependencies) {
  const dataRoot = dependencies.dataRoot ?? DATA_DIR;
  const nowMs = dependencies.nowMs ?? Date.now;
  const randomUuid = dependencies.randomUuid ?? import_node_crypto3.randomUUID;
  return (input) => {
    if (input.eventName !== eventName || !hasRequiredIdentity(input)) {
      return { continue: true };
    }
    const index = readIndex(dataRoot);
    if (!index) return { continue: true };
    const project = (0, import_node_path14.resolve)(input.cwd);
    const candidates = index.rules.filter(
      (rule) => rule.scope === "global" || (0, import_node_path14.resolve)(rule.scope) === project
    ).slice(0, TRIGGER_INDEX_SLOT_LIMIT).filter((rule) => triggerMatches(rule.trigger, input));
    if (candidates.length === 0) return { continue: true };
    const lock = acquireSessionLock(dataRoot, input.sessionId);
    if (!lock) return { continue: true };
    try {
      const pushed = readState(dataRoot, input.sessionId);
      const matches = candidates.filter((rule) => !pushed.has(rule.id)).slice(0, EVENT_HIT_LIMIT);
      if (matches.length === 0) return { continue: true };
      const timestamp = nowMs();
      const hits = createHits(
        input,
        matches.map((rule) => rule.id),
        timestamp,
        randomUuid
      );
      const previousPushed = new Set(pushed);
      for (const rule of matches) pushed.add(rule.id);
      writeState(dataRoot, input.sessionId, pushed);
      try {
        withHitSidecarLock(
          dataRoot,
          () => appendHits(resolveHitSidecarPath(dataRoot, timestamp), hits),
          { waitMs: 35 }
        );
      } catch (error48) {
        writeState(dataRoot, input.sessionId, previousPushed);
        throw error48;
      }
      return {
        continue: true,
        hookSpecificOutput: `## Mnemo Tips
${matches.map((rule) => `- ${rule.claim}`).join("\n")}`
      };
    } finally {
      releaseSessionLock(lock);
    }
  };
}
function createUserPromptSubmitDispatcher(dependencies = {}) {
  return createDispatcher("UserPromptSubmit", dependencies);
}

// src/hooks/handlers/prompt-dispatch.ts
function createPromptDispatchHandler(dependencies = {}) {
  const { logger: injectedLogger, ...dispatcherDependencies } = dependencies;
  const ruleDispatcher = createUserPromptSubmitDispatcher(dispatcherDependencies);
  const logger = injectedLogger ?? createLogger("HOOK");
  return async function handlePromptDispatch(input) {
    let rules;
    try {
      rules = await ruleDispatcher(input);
    } catch (error48) {
      logger.warn?.("prompt-dispatch section failed", {
        sessionId: input.sessionId ?? null,
        reasonCode: "rule-dispatch",
        error: error48 instanceof Error ? error48.message : String(error48)
      });
      rules = null;
    }
    return rules?.hookSpecificOutput ? { continue: true, hookSpecificOutput: rules.hookSpecificOutput } : { continue: true };
  };
}

// src/db/note-settlement.ts
var NOTE_SETTLEMENT_CONSECUTIVE_TURNS = 50;
var NOTE_SETTLEMENT_MIN_WINDOW_TURNS = 20;
var NOTE_SETTLEMENT_LEASE_MS = 10 * 60 * 1e3;
var NOTE_SETTLEMENT_RESIDUAL_IDLE_MS = 24 * 60 * 60 * 1e3;
var JOB_COLUMNS = `
    id,
    session_id AS sessionId,
    window_start AS windowStart,
    window_end AS windowEnd,
    trigger_type AS triggerType,
    status,
    attempts,
    retry_at_epoch AS retryAtEpoch,
    claimed_at_epoch AS claimedAtEpoch,
    claim_generation AS claimGeneration,
    last_error AS lastError,
    created_at_epoch AS createdAtEpoch,
    updated_at_epoch AS updatedAtEpoch`;
var JOB_SELECT = `SELECT${JOB_COLUMNS} FROM note_settlement_jobs`;
function getNoteSettlementCursor(db, sessionId) {
  return db.query(
    `SELECT last_settled_prompt_number AS cursor
         FROM note_settlement_cursors WHERE session_id = ?`
  ).get(sessionId)?.cursor ?? 0;
}
function getEraFloorPromptNumber(db, sessionId, eraCutoffEpoch) {
  return db.query(
    `SELECT MAX(prompt_number) AS floor FROM turns
         WHERE session_id = ? AND created_at_epoch < ?`
  ).get(sessionId, eraCutoffEpoch)?.floor ?? 0;
}
function getNoteSettlementWindowStart(db, sessionId, eraCutoffEpoch) {
  const highestEnqueued = db.query(
    `SELECT MAX(window_end) AS windowEnd FROM note_settlement_jobs
         WHERE session_id = ?`
  ).get(sessionId)?.windowEnd ?? 0;
  return Math.max(
    getNoteSettlementCursor(db, sessionId),
    highestEnqueued ?? 0,
    getEraFloorPromptNumber(db, sessionId, eraCutoffEpoch)
  ) + 1;
}
function ensureNoteSettlementCursor(db, sessionId, eraCutoffEpoch, nowEpoch) {
  db.query(
    `INSERT OR IGNORE INTO note_settlement_cursors (
       session_id, last_settled_prompt_number, updated_at_epoch
     )
     SELECT ?, COALESCE(
       (SELECT MAX(prompt_number) FROM turns
        WHERE session_id = ? AND created_at_epoch < ?), 0
     ), ?`
  ).run(sessionId, sessionId, eraCutoffEpoch, nowEpoch);
}
function getMaxPromptNumber2(db, sessionId) {
  return db.query(
    `SELECT MAX(t.prompt_number) AS maxPromptNumber FROM turns t
         WHERE t.session_id = ? AND ${realPromptPredicate("t")}`
  ).get(sessionId)?.maxPromptNumber ?? 0;
}
function getDecidedPrefixEnd(db, sessionId, windowStart) {
  const ended = getMaxPromptNumber2(db, sessionId) - 1;
  return Math.max(windowStart - 1, ended);
}
function getCompactBoundaryPromptNumber(db, sessionId) {
  return db.query(
    "SELECT last_compact_turn AS boundary FROM sessions WHERE id = ?"
  ).get(sessionId)?.boundary ?? null;
}
function planNoteSettlementWindows(db, sessionId, trigger, options) {
  const consecutiveTurns = options.consecutiveTurns ?? NOTE_SETTLEMENT_CONSECUTIVE_TURNS;
  const minWindowTurns = options.minWindowTurns ?? NOTE_SETTLEMENT_MIN_WINDOW_TURNS;
  let windowStart = getNoteSettlementWindowStart(
    db,
    sessionId,
    options.eraCutoffEpoch
  );
  let prefixEnd = getDecidedPrefixEnd(db, sessionId, windowStart);
  if (trigger === "compact") {
    const boundary = getCompactBoundaryPromptNumber(db, sessionId);
    if (boundary !== null) {
      prefixEnd = boundary;
    }
  } else if (trigger === "sessionend") {
    prefixEnd = getMaxPromptNumber2(db, sessionId);
  }
  const plans = [];
  while (prefixEnd - windowStart + 1 >= consecutiveTurns) {
    const windowEnd = windowStart + consecutiveTurns - 1;
    plans.push({
      sessionId,
      windowStart,
      windowEnd,
      triggerType: "consecutive"
    });
    windowStart = windowEnd + 1;
  }
  const remainderFloor = trigger === "sessionend" ? 1 : minWindowTurns;
  if ((trigger === "compact" || trigger === "sessionend") && prefixEnd - windowStart + 1 >= remainderFloor) {
    plans.push({
      sessionId,
      windowStart,
      windowEnd: prefixEnd,
      triggerType: trigger
    });
  }
  return plans;
}
function enqueueSessionEndNoteSettlementWindow(db, sessionId, nowEpoch, eraCutoffEpoch) {
  return planAndEnqueueNoteSettlementWindows(db, sessionId, "sessionend", nowEpoch, {
    eraCutoffEpoch
  });
}
function insertJob(db, sessionId, windowStart, windowEnd, triggerType, nowEpoch, eraCutoffEpoch) {
  if (windowStart < getNoteSettlementWindowStart(db, sessionId, eraCutoffEpoch)) {
    return null;
  }
  if (windowEnd < windowStart) {
    return null;
  }
  const job = db.query(
    `INSERT OR IGNORE INTO note_settlement_jobs (
           session_id, window_start, window_end, trigger_type,
           status, attempts, retry_at_epoch,
           created_at_epoch, updated_at_epoch
         ) VALUES (?, ?, ?, ?, 'pending', 0, 0, ?, ?)
         RETURNING${JOB_COLUMNS}`
  ).get(sessionId, windowStart, windowEnd, triggerType, nowEpoch, nowEpoch) ?? null;
  if (job) {
    ensureNoteSettlementCursor(db, sessionId, eraCutoffEpoch, nowEpoch);
  }
  return job;
}
function insertJobs(db, plans, nowEpoch, eraCutoffEpoch) {
  const created = [];
  for (const plan of plans) {
    const job = insertJob(
      db,
      plan.sessionId,
      plan.windowStart,
      plan.windowEnd,
      plan.triggerType,
      nowEpoch,
      eraCutoffEpoch
    );
    if (job) {
      created.push(job);
    }
  }
  return created;
}
function planAndEnqueueNoteSettlementWindows(db, sessionId, trigger, nowEpoch, options) {
  return runWriteTransaction(db, () => {
    const plans = planNoteSettlementWindows(db, sessionId, trigger, options);
    if (plans.length === 0) {
      return [];
    }
    return insertJobs(db, plans, nowEpoch, options.eraCutoffEpoch);
  });
}

// src/db/orphan-turns.ts
function getOrphanTurns(db, sessionDbId, beforeTurnId) {
  return db.query(
    `
        SELECT
          t.id,
          t.prompt_number AS promptNumber
        FROM turns t
        WHERE t.session_id = ?
          AND t.status IN ('active', 'provisional')
          AND t.id < ?
          AND t.assistant_response IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM pending_queue q
            WHERE q.kind = 'turn-stop' AND q.target_id = t.id
          )
        ORDER BY t.prompt_number ASC
      `
  ).all(sessionDbId, beforeTurnId ?? Number.MAX_SAFE_INTEGER);
}
function enqueueOrphanTurnStops(db, sessionDbId, nowEpoch, orphans) {
  for (const orphan of orphans) {
    db.query(
      `
        UPDATE turns
        SET updated_at_epoch = ?
        WHERE id = ?
      `
    ).run(nowEpoch, orphan.id);
    enqueueQueueItem(db, {
      kind: "turn-stop",
      targetId: orphan.id,
      sessionDbId,
      enqueuedAtEpoch: nowEpoch
    });
  }
  return orphans.length;
}
function skipOrphanTurns(db, sessionDbId, nowEpoch, orphans) {
  let processedCount = 0;
  for (const orphan of orphans) {
    const turn = db.query(
      "SELECT title, content FROM turns WHERE id = ? AND session_id = ?"
    ).get(orphan.id, sessionDbId);
    if (!turn) {
      continue;
    }
    const status = turn.title !== null || turn.content !== null ? "extracted" : "skipped";
    const result = db.query(
      `
        UPDATE turns
        SET status = ?, updated_at_epoch = ?
        WHERE id = ? AND status IN ('active', 'provisional')
      `
    ).run(status, nowEpoch, orphan.id);
    if (result.changes === 0) {
      continue;
    }
    updateTurnById(db, orphan.id, aggregateTurnFiles(db, orphan.id));
    db.query(
      `UPDATE observations SET status = 'skipped'
       WHERE turn_id = ? AND status = 'pending'`
    ).run(orphan.id);
    db.query(
      `DELETE FROM pending_queue
       WHERE kind = 'obs' AND target_id IN (
         SELECT id FROM observations WHERE turn_id = ?
       )`
    ).run(orphan.id);
    processedCount += result.changes;
  }
  return processedCount;
}

// src/hooks/transcript-scan.ts
var import_node_fs8 = require("node:fs");
var DEFAULT_SCAN_MAX_LINES = 5e3;
var DEFAULT_SCAN_MAX_BYTES = 5 * 1024 * 1024;
var NEWLINE_BYTE = 10;
function readRange(transcriptPath, start, length) {
  if (length <= 0) {
    return Buffer.alloc(0);
  }
  let fd = null;
  try {
    fd = (0, import_node_fs8.openSync)(transcriptPath, "r");
    const buffer = Buffer.alloc(length);
    const bytesRead = (0, import_node_fs8.readSync)(fd, buffer, 0, length, start);
    return buffer.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      (0, import_node_fs8.closeSync)(fd);
    }
  }
}
function scanTranscriptIncrementally(transcriptPath, cursor, options = {}) {
  if (!(0, import_node_fs8.existsSync)(transcriptPath)) {
    return null;
  }
  const maxLines = options.maxLines ?? DEFAULT_SCAN_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_SCAN_MAX_BYTES;
  let fileSize;
  try {
    fileSize = (0, import_node_fs8.statSync)(transcriptPath).size;
  } catch {
    return null;
  }
  const restarted = cursor.byteOffset > fileSize;
  const startOffset = restarted ? 0 : Math.max(0, cursor.byteOffset);
  const startLineNumber = restarted ? 0 : Math.max(0, cursor.lineNumber);
  if (startOffset >= fileSize) {
    return {
      entries: [],
      nextCursor: { byteOffset: startOffset, lineNumber: startLineNumber },
      truncated: false,
      restarted,
      lineStartOffsets: [],
      oversizedRecord: false
    };
  }
  const remaining = fileSize - startOffset;
  const buffer = readRange(
    transcriptPath,
    startOffset,
    Math.min(remaining, maxBytes)
  );
  if (buffer === null) {
    return null;
  }
  const oversizedRecord = !buffer.includes(NEWLINE_BYTE) && buffer.length < remaining;
  if (oversizedRecord) {
    options.log?.(
      `transcript scan: record at byte ${startOffset} exceeds the ${maxBytes}-byte window cap; holding the cursor before it and deferring`
    );
  }
  const newlineOffsets = [];
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === NEWLINE_BYTE) {
      newlineOffsets.push(index);
      if (newlineOffsets.length >= maxLines) {
        break;
      }
    }
  }
  if (newlineOffsets.length === 0) {
    return {
      entries: [],
      nextCursor: { byteOffset: startOffset, lineNumber: startLineNumber },
      truncated: false,
      restarted,
      lineStartOffsets: [],
      oversizedRecord
    };
  }
  const lastNewline = newlineOffsets[newlineOffsets.length - 1];
  const committedBytes = lastNewline + 1;
  const committed = buffer.subarray(0, committedBytes).toString("utf8");
  const lines = committed.split("\n");
  lines.pop();
  const lineStartOffsets = [];
  let lineStart = 0;
  for (const newlineOffset of newlineOffsets) {
    lineStartOffsets.push(startOffset + lineStart);
    lineStart = newlineOffset + 1;
  }
  const truncated = startOffset + buffer.length < fileSize || buffer.subarray(committedBytes).includes(NEWLINE_BYTE);
  return {
    entries: dedupeTranscriptEntries(
      parseTranscriptLineWindow(lines, startLineNumber + 1)
    ),
    nextCursor: {
      byteOffset: startOffset + committedBytes,
      lineNumber: startLineNumber + lines.length
    },
    truncated,
    restarted,
    lineStartOffsets,
    oversizedRecord
  };
}
function rewindCursorToLine(result, windowFirstLineNumber, lineNumber) {
  const index = lineNumber - windowFirstLineNumber;
  const byteOffset = result.lineStartOffsets[index];
  if (byteOffset === void 0) {
    return result.nextCursor;
  }
  return { byteOffset, lineNumber: lineNumber - 1 };
}

// src/hooks/capture-repair.ts
var defaultLog = (message) => {
  process.stderr.write(`[claude-mnemo] ${message}
`);
};
function rawContentText(content) {
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
function collectCompactBoundaryClaims(entries) {
  const claims = [];
  let pendingBoundaryLine = null;
  entries.forEach((entry, index) => {
    if (entry.type !== "system" || entry.subtype !== "compact_boundary" || !entry.uuid) {
      return;
    }
    const wrapper = entries[index + 1];
    if (!wrapper) {
      pendingBoundaryLine = entry.lineNumber;
      return;
    }
    if (wrapper.role !== "user" || wrapper.parentUuid !== entry.uuid || !wrapper.promptId) {
      return;
    }
    const summary = rawContentText(wrapper.content);
    if (!summary) {
      return;
    }
    const metadata = entry.compactMetadata;
    claims.push({
      uuid: entry.uuid,
      boundaryLineNumber: entry.lineNumber,
      promptId: wrapper.promptId,
      wrapperLineNumber: wrapper.lineNumber,
      summary,
      trigger: metadata?.trigger === "auto" ? "auto" : "manual",
      preCompactTokenCount: typeof metadata?.preCompactTokenCount === "number" ? metadata.preCompactTokenCount : typeof metadata?.pre_tokens === "number" ? metadata.pre_tokens : null
    });
  });
  return { claims, pendingBoundaryLine };
}
function compactMetadataTags(claim) {
  return [
    `compact:pre_tokens=${claim.preCompactTokenCount ?? 0}`,
    `compact:trigger=${claim.trigger}`
  ];
}
function convertOccupiedTurnToMarker(db, turnId, claim, nowEpoch) {
  db.query(
    `UPDATE turns
     SET type = 'compact',
         status = 'extracted',
         title = '/compact',
         compact_boundary_uuid = ?,
         updated_at_epoch = ?,
         tags = ?,
         cites_recorded = 1,
         content = NULL,
         insight = NULL,
         significance_grade = NULL,
         assistant_response = NULL,
         assistant_transcript = NULL,
         files_read = NULL,
         files_modified = NULL,
         tool_call_count = NULL,
         was_interrupted = 0,
         was_rolled_back = 0
     WHERE id = ?`
  ).run(
    claim.uuid,
    nowEpoch,
    JSON.stringify(compactMetadataTags(claim)),
    turnId
  );
  db.query(
    "DELETE FROM memory_edges WHERE citing_kind = 'turn' AND citing_id = ?"
  ).run(turnId);
  reindexTurnFromDb(db, turnId);
  db.query(
    `UPDATE observations SET status = 'skipped'
     WHERE turn_id = ? AND status = 'pending'`
  ).run(turnId);
  db.query(
    `DELETE FROM pending_queue
     WHERE kind = 'obs' AND target_id IN (
       SELECT id FROM observations WHERE turn_id = ?
     )`
  ).run(turnId);
  db.query(
    "DELETE FROM pending_queue WHERE kind = 'turn-stop' AND target_id = ?"
  ).run(turnId);
}
function claimCompactBoundaries(db, sessionId, claims, nowEpoch, log) {
  const outcome = {
    inserted: 0,
    converted: 0,
    adopted: 0,
    skipped: 0
  };
  for (const claim of claims) {
    const alreadyClaimed = db.query(
      `SELECT id FROM turns
         WHERE session_id = ? AND compact_boundary_uuid = ? LIMIT 1`
    ).get(sessionId, claim.uuid);
    if (alreadyClaimed) {
      outcome.skipped += 1;
      continue;
    }
    const owner = db.query(
      `SELECT id, type, compact_boundary_uuid AS compactBoundaryUuid
         FROM turns
         WHERE session_id = ? AND content_prompt_id = ? LIMIT 1`
    ).get(sessionId, claim.promptId);
    if (owner) {
      if (owner.compactBoundaryUuid !== null) {
        outcome.skipped += 1;
        log(
          `compact boundary ${claim.uuid}: promptId ${claim.promptId} already marks boundary ${owner.compactBoundaryUuid}; skipped`
        );
        continue;
      }
      if (owner.type === "compact") {
        db.query(
          `UPDATE turns SET compact_boundary_uuid = ?
           WHERE id = ? AND compact_boundary_uuid IS NULL`
        ).run(claim.uuid, owner.id);
        outcome.adopted += 1;
        continue;
      }
      convertOccupiedTurnToMarker(db, owner.id, claim, nowEpoch);
      outcome.converted += 1;
      log(
        `compact boundary ${claim.uuid}: converted turn ${owner.id} that had claimed promptId ${claim.promptId}`
      );
      continue;
    }
    const maxPromptNumber = getMaxPromptNumber(db, sessionId) ?? 0;
    const tags = compactMetadataTags(claim);
    db.query(
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
         compact_boundary_uuid,
         created_at_epoch
       ) VALUES (?, ?, ?, 'extracted', '/compact', ?, 'compact', ?, ?, '[]', '[]', 0, ?, ?)`
    ).run(
      sessionId,
      maxPromptNumber + 1,
      claim.promptId,
      claim.summary,
      claim.wrapperLineNumber,
      JSON.stringify(tags),
      claim.uuid,
      nowEpoch
    );
    outcome.inserted += 1;
  }
  return outcome;
}
function collectLinkCandidates(entries) {
  const candidates = [];
  const seen = /* @__PURE__ */ new Set();
  for (const entry of entries) {
    if (entry.role !== "user" || entry.isSidechain === true || !isChainParticipant(entry) || !entry.promptId || seen.has(entry.promptId) || isInterruptedUserMarker(entry) || !isRealUserPrompt(entry)) {
      continue;
    }
    const text = extractUserPrompt(entry);
    if (text === "") {
      continue;
    }
    seen.add(entry.promptId);
    candidates.push({
      promptId: entry.promptId,
      lineNumber: entry.lineNumber,
      text
    });
  }
  return candidates;
}
function reconcileTurnLinks(db, sessionId, entries, log) {
  const outcome = { linked: 0, skipped: 0 };
  const candidates = collectLinkCandidates(entries);
  if (candidates.length === 0) {
    return outcome;
  }
  const nullLinkTurns = db.query(
    `SELECT
         id,
         prompt_number AS promptNumber,
         user_prompt AS userPrompt,
         content_prompt_id AS contentPromptId,
         transcript_line_start AS transcriptLineStart
       FROM turns
       WHERE session_id = ?
         AND (content_prompt_id IS NULL OR transcript_line_start IS NULL)
       ORDER BY prompt_number ASC`
  ).all(sessionId);
  if (nullLinkTurns.length === 0) {
    return outcome;
  }
  const ownedPromptIds = new Set(
    db.query(
      `SELECT content_prompt_id AS contentPromptId FROM turns
         WHERE session_id = ? AND content_prompt_id IS NOT NULL`
    ).all(sessionId).map((row) => row.contentPromptId)
  );
  const writeLink = db.query(
    `UPDATE turns
     SET content_prompt_id = COALESCE(content_prompt_id, ?),
         transcript_line_start = COALESCE(transcript_line_start, ?)
     WHERE id = ?`
  );
  const candidateByPromptId = new Map(
    candidates.map((candidate) => [candidate.promptId, candidate])
  );
  const resolvedTurnIds = /* @__PURE__ */ new Set();
  for (const turn of nullLinkTurns) {
    if (turn.contentPromptId === null || turn.transcriptLineStart !== null) {
      continue;
    }
    const candidate = candidateByPromptId.get(turn.contentPromptId);
    if (!candidate) {
      continue;
    }
    writeLink.run(null, candidate.lineNumber, turn.id);
    resolvedTurnIds.add(turn.id);
    outcome.linked += 1;
  }
  const unlinkedTurns = nullLinkTurns.filter(
    (turn) => turn.contentPromptId === null && !resolvedTurnIds.has(turn.id)
  );
  if (unlinkedTurns.length === 0) {
    return outcome;
  }
  const turnTextCounts = /* @__PURE__ */ new Map();
  for (const turn of unlinkedTurns) {
    if (turn.userPrompt === null) {
      continue;
    }
    turnTextCounts.set(
      turn.userPrompt,
      (turnTextCounts.get(turn.userPrompt) ?? 0) + 1
    );
  }
  const candidateTextCounts = /* @__PURE__ */ new Map();
  for (const candidate of candidates) {
    candidateTextCounts.set(
      candidate.text,
      (candidateTextCounts.get(candidate.text) ?? 0) + 1
    );
  }
  const consumedTurnIds = /* @__PURE__ */ new Set();
  let lastLinkedPromptNumber = -1;
  for (const candidate of candidates) {
    if (ownedPromptIds.has(candidate.promptId)) {
      outcome.skipped += 1;
      log(
        `link reconcile: promptId ${candidate.promptId} (line ${candidate.lineNumber}) already owned by another turn; skipped`
      );
      continue;
    }
    const matches = unlinkedTurns.filter(
      (turn2) => turn2.userPrompt === candidate.text && !consumedTurnIds.has(turn2.id)
    );
    if (matches.length === 0) {
      continue;
    }
    if (matches.length > 1 || (turnTextCounts.get(candidate.text) ?? 0) > 1 || (candidateTextCounts.get(candidate.text) ?? 0) > 1) {
      outcome.skipped += 1;
      log(
        `link reconcile: ambiguous prompt text for promptId ${candidate.promptId} (line ${candidate.lineNumber}); skipped`
      );
      continue;
    }
    const turn = matches[0];
    if (turn.promptNumber <= lastLinkedPromptNumber) {
      outcome.skipped += 1;
      log(
        `link reconcile: transcript order and prompt order disagree for turn ${turn.id} (T${turn.promptNumber}); skipped`
      );
      continue;
    }
    writeLink.run(
      candidate.promptId,
      turn.transcriptLineStart === null ? candidate.lineNumber : null,
      turn.id
    );
    ownedPromptIds.add(candidate.promptId);
    consumedTurnIds.add(turn.id);
    lastLinkedPromptNumber = turn.promptNumber;
    outcome.linked += 1;
  }
  return outcome;
}
function applyCaptureRepair(db, sessionId, scan, observedCursor, options) {
  const log = options.log ?? defaultLog;
  const windowFirstLineNumber = (scan.restarted ? 0 : observedCursor.lineNumber) + 1;
  const { claims, pendingBoundaryLine } = collectCompactBoundaryClaims(
    scan.entries
  );
  const compact = claimCompactBoundaries(
    db,
    sessionId,
    claims,
    options.nowEpoch,
    log
  );
  const links = reconcileTurnLinks(db, sessionId, scan.entries, log);
  const cursor = pendingBoundaryLine === null ? scan.nextCursor : rewindCursorToLine(scan, windowFirstLineNumber, pendingBoundaryLine);
  const isRewind = pendingBoundaryLine !== null || scan.restarted;
  const writeCursor = isRewind ? rewindSessionScanCursor : updateSessionScanCursor;
  const committed = writeCursor(
    db,
    sessionId,
    cursor.byteOffset,
    cursor.lineNumber,
    observedCursor.byteOffset
  );
  if (!committed) {
    log(
      `capture repair: scan cursor for session ${sessionId} moved under us (observed ${observedCursor.byteOffset}); dropped this window's cursor write`
    );
  }
  return {
    compact,
    links,
    scannedEntries: scan.entries.length,
    truncated: scan.truncated,
    cursor,
    stoppedForDeadline: false
  };
}
function mergeOutcomes(first, next) {
  if (!first) {
    return next;
  }
  return {
    compact: {
      inserted: first.compact.inserted + next.compact.inserted,
      converted: first.compact.converted + next.compact.converted,
      adopted: first.compact.adopted + next.compact.adopted,
      skipped: first.compact.skipped + next.compact.skipped
    },
    links: {
      linked: first.links.linked + next.links.linked,
      skipped: first.links.skipped + next.links.skipped
    },
    scannedEntries: first.scannedEntries + next.scannedEntries,
    truncated: next.truncated,
    cursor: next.cursor,
    stoppedForDeadline: next.stoppedForDeadline
  };
}
function runCaptureRepair(db, session, transcriptPath, options) {
  if (!transcriptPath) {
    return null;
  }
  const log = options.log ?? defaultLog;
  const nowMs = options.nowMs ?? Date.now;
  const maxLines = options.maxLines ?? DEFAULT_SCAN_MAX_LINES;
  const batchLines = Math.max(1, options.batchLines ?? maxLines);
  let cursor = {
    byteOffset: session.scanCursorByteOffset ?? 0,
    lineNumber: session.scanCursorLine ?? 0
  };
  let remainingLines = maxLines;
  let aggregate = null;
  while (remainingLines > 0) {
    if (options.deadlineMs !== void 0 && nowMs() >= options.deadlineMs) {
      if (aggregate) {
        aggregate.stoppedForDeadline = true;
      }
      return aggregate;
    }
    const scan = scanTranscriptIncrementally(transcriptPath, cursor, {
      maxLines: Math.min(batchLines, remainingLines),
      maxBytes: options.maxBytes,
      log
    });
    if (!scan || scan.entries.length === 0 && scan.nextCursor.byteOffset === cursor.byteOffset && !scan.restarted) {
      return aggregate;
    }
    const observedCursor = cursor;
    const apply = () => applyCaptureRepair(db, session.id, scan, observedCursor, options);
    const outcome = options.writeTransaction ? options.writeTransaction(db, apply) : apply();
    aggregate = mergeOutcomes(aggregate, outcome);
    remainingLines -= Math.max(
      0,
      outcome.cursor.lineNumber - (scan.restarted ? 0 : cursor.lineNumber)
    );
    if (outcome.cursor.byteOffset <= cursor.byteOffset && !scan.restarted) {
      return aggregate;
    }
    cursor = outcome.cursor;
    if (!scan.truncated) {
      return aggregate;
    }
  }
  return aggregate;
}

// src/hooks/handlers/session-end.ts
function loadSettlementEnabled() {
  try {
    return loadConfig().settlementEnabled;
  } catch {
    return DEFAULT_CONFIG.settlementEnabled;
  }
}
var SESSION_END_SCAN_MAX_LINES = 500;
var SESSION_END_REPAIR_BUDGET_MS = 400;
var SESSION_END_SCAN_BATCH_LINES = 50;
var SESSION_END_REPAIR_MIN_BUDGET_MS = 40;
function createSessionEndHandler(dependencies) {
  const now = dependencies.now ?? (() => Math.floor(Date.now() / 1e3));
  const nowMs = dependencies.nowMs ?? Date.now;
  const writeTransaction = dependencies.runHookWriteTransaction ?? runHookWriteTransaction;
  const captureRepairRunner = dependencies.captureRepairRunner ?? runCaptureRepair;
  const eraCutoffEpoch = dependencies.eraCutoffEpoch !== void 0 ? dependencies.eraCutoffEpoch : resolveEraCutoff(dependencies.db);
  const settlementEnabled = dependencies.settlementEnabled ?? loadSettlementEnabled();
  return async function handleSessionEndHook(input) {
    if (!input.sessionId) {
      return { continue: true };
    }
    const repairDeadlineMs = nowMs() + SESSION_END_REPAIR_BUDGET_MS;
    const session = getSessionByContentId(dependencies.db, input.sessionId);
    if (!session) {
      return {
        continue: true,
        asyncWork: async () => {
          await notifyWorkerTrigger(
            {
              action: "finish",
              contentSessionId: input.sessionId
            },
            dependencies.workerClientDeps,
            dependencies.workerEnv
          );
        }
      };
    }
    const hadNewTurnBeforeRepair = hasNewTurnSinceSessionRunStart(
      dependencies.db,
      session.id
    );
    const maxTurnIdSnapshot = getMaxTurnId(dependencies.db, session.id);
    const transcriptPath = input.transcriptPath ?? resolveSessionTranscriptPath(session);
    const repairLog = dependencies.captureRepairLog ?? ((message) => process.stderr.write(`[claude-mnemo] ${message}
`));
    const maxLines = dependencies.captureRepairMaxLines ?? SESSION_END_SCAN_MAX_LINES;
    let repairTruncated = false;
    let repairStoppedForDeadline = false;
    const budgetBeforeRepairMs = repairDeadlineMs - nowMs();
    if (budgetBeforeRepairMs < SESSION_END_REPAIR_MIN_BUDGET_MS) {
      repairLog(
        `session-end capture repair skipped for session ${session.id}: only ${budgetBeforeRepairMs}ms of the ${SESSION_END_REPAIR_BUDGET_MS}ms budget left; deferred to the next resume`
      );
    } else {
      try {
        const outcome = captureRepairRunner(
          dependencies.db,
          session,
          transcriptPath,
          {
            nowEpoch: now(),
            log: repairLog,
            maxLines,
            batchLines: dependencies.captureRepairBatchLines ?? SESSION_END_SCAN_BATCH_LINES,
            deadlineMs: repairDeadlineMs,
            nowMs,
            writeTransaction: (db, work) => writeTransaction(db, work, {
              // The busy-retry budget is the SAME wall clock, not a second
              // one: a lock fight cannot push past the repair deadline.
              budgetMs: Math.max(0, repairDeadlineMs - nowMs())
            })
          }
        );
        repairTruncated = outcome?.truncated ?? false;
        repairStoppedForDeadline = outcome?.stoppedForDeadline ?? false;
      } catch (error48) {
        repairLog(
          `session-end capture repair failed for session ${session.id}: ${error48 instanceof Error ? error48.message : String(error48)}`
        );
      }
    }
    if (repairStoppedForDeadline) {
      repairLog(
        `session-end capture repair hit its ${SESSION_END_REPAIR_BUDGET_MS}ms budget for session ${session.id}; remainder deferred to the next resume`
      );
    } else if (repairTruncated) {
      repairLog(
        `session-end capture repair hit its ${maxLines}-line budget for session ${session.id}; remainder deferred to the next resume`
      );
    }
    if (hadNewTurnBeforeRepair && maxTurnIdSnapshot !== null) {
      const orphanTurns = getOrphanTurns(
        dependencies.db,
        session.id,
        maxTurnIdSnapshot + 1
      );
      if (orphanTurns.length > 0) {
        writeTransaction(dependencies.db, () => {
          skipOrphanTurns(dependencies.db, session.id, now(), orphanTurns);
        });
      }
    }
    if (settlementEnabled && eraCutoffEpoch !== null) {
      try {
        enqueueSessionEndNoteSettlementWindow(
          dependencies.db,
          session.id,
          now(),
          eraCutoffEpoch
        );
      } catch (error48) {
        repairLog(
          `session-end note settlement enqueue failed for session ${session.id}: ${error48 instanceof Error ? error48.message : String(error48)}`
        );
      }
    }
    return {
      continue: true,
      asyncWork: async () => {
        await notifyWorkerFlush(
          session.id,
          session.contentSessionId,
          dependencies.workerClientDeps,
          dependencies.workerEnv
        );
      }
    };
  };
}

// src/db/process-session-map.ts
var IDENTITY_KEY_SOURCES = [
  { namespace: "socket", envVar: "CLAUDE_CODE_MESSAGING_SOCKET" },
  { namespace: "session", envVar: "CLAUDE_CODE_SESSION_ID" }
];
function deriveProcessIdentityKeys(env) {
  const keys = [];
  for (const source of IDENTITY_KEY_SOURCES) {
    const value = env[source.envVar]?.trim();
    if (value) {
      keys.push(`${source.namespace}:${value}`);
    }
  }
  return keys;
}
function upsertProcessSessionMap(db, identityKey, sessionId, nowEpoch) {
  db.query(
    `INSERT INTO process_session_map (
       process_session_id, session_id, updated_at_epoch
     ) VALUES (?, ?, ?)
     ON CONFLICT(process_session_id) DO UPDATE SET
       session_id = excluded.session_id,
       updated_at_epoch = excluded.updated_at_epoch`
  ).run(identityKey, sessionId, nowEpoch);
}

// src/hooks/note-reminder.ts
var NOTE_REMINDER_DISPLAY_LIMIT = 5;
var NOTE_RELIEF_PENDING_THRESHOLD = 5;
var PROMPT_PREFIX_CHARACTERS = 40;
function formatTurnAddress(debt) {
  return `S${debt.sessionId}/T${debt.promptNumber}`;
}
var CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/gu;
function formatPromptPrefix(userPrompt) {
  const collapsed = (userPrompt ?? "").replace(/\s+/gu, " ").replace(CONTROL_CHARACTERS, "").replace(/"/gu, "'").replace(/</gu, "\u2039").replace(/>/gu, "\u203A").trim();
  if (collapsed === "") {
    return '""';
  }
  const characters = Array.from(collapsed);
  return characters.length > PROMPT_PREFIX_CHARACTERS ? `"${characters.slice(0, PROMPT_PREFIX_CHARACTERS).join("")}\u2026"` : `"${collapsed}"`;
}
function pendingSuffix(pendingTurns) {
  return pendingTurns === 1 ? "(pending 1 turn)" : `(pending ${pendingTurns} turns)`;
}
function formatDebtLine(turn) {
  return `  [${formatTurnAddress(turn)}] ${formatPromptPrefix(turn.userPrompt)} ${pendingSuffix(turn.pendingTurns)}`;
}
function formatOwedSuffix(owed) {
  if (owed.length === 0) {
    return "";
  }
  const newest = owed[owed.length - 1];
  const address = formatTurnAddress(newest);
  return owed.length === 1 ? ` \xB7 owed: ${address}` : ` \xB7 owed: ${address} +${owed.length - 1} older`;
}
function renderNoteBacklogRelief(owed, displayLimit = NOTE_REMINDER_DISPLAY_LIMIT) {
  const lines = ["mnemo pending notes (backlog relief):"];
  for (const turn of owed.slice(0, displayLimit)) {
    lines.push(formatDebtLine(turn));
  }
  lines.push(
    `${owed.length} turns are waiting for notes. Open a batch containing ONLY note or skip calls for the turns above \u2014 the standing rule against starting a tool call just to write notes is waived for that batch, and for nothing else in it.`
  );
  return lines.join("\n");
}

// src/worker/invalidation.ts
var INTERRUPT_PENDING_TAG = "invalidated:notify-pending:interrupt";
var INTERRUPT_NOTIFIED_TAG = "invalidated:notified:interrupt";
var ROLLBACK_PENDING_TAG = "invalidated:notify-pending:rollback";
var ROLLBACK_NOTIFIED_TAG = "invalidated:notified:rollback";
function addPendingTag(tags, pendingTag, notifiedTag) {
  if (tags.includes(pendingTag) || tags.includes(notifiedTag)) {
    return tags;
  }
  return [...tags, pendingTag];
}
function selectLatestMainLeaf(entries) {
  const parentSet = new Set(
    entries.map((entry) => entry.parentUuid).filter((uuid3) => Boolean(uuid3))
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
      nextTags = addPendingTag(nextTags, INTERRUPT_PENDING_TAG, INTERRUPT_NOTIFIED_TAG);
    }
    if (detectedRollback && !turn.wasRolledBack) {
      nextTags = addPendingTag(nextTags, ROLLBACK_PENDING_TAG, ROLLBACK_NOTIFIED_TAG);
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
function createPendingTurn(db, sessionId, promptNumber, prompt, createdAtEpoch, isSidechain) {
  const inserted = db.query(
    `INSERT INTO turns (
        session_id,
        prompt_number,
        status,
        tags,
        user_prompt,
        created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?)
      RETURNING id`
  ).get(
    sessionId,
    promptNumber,
    isSidechain ? "undone" : "active",
    isSidechain ? '["subagent:pending"]' : "[]",
    prompt,
    createdAtEpoch
  );
  if (inserted) {
    reindexTurnFromDb(db, inserted.id);
  }
  return inserted?.id ?? null;
}
function createSessionInitHandler(dependencies) {
  const now = dependencies.now ?? (() => Math.floor(Date.now() / 1e3));
  const writeTransaction = dependencies.runHookWriteTransaction ?? runHookWriteTransaction;
  const env = dependencies.env ?? process.env;
  return async function handleSessionInitHook(input) {
    if (!input.sessionId || !input.cwd || !input.prompt) {
      return {
        continue: true,
        suppressOutput: true
      };
    }
    const isSubagent = input.agentId !== void 0;
    const epoch = now();
    const contentSessionId = input.sessionId;
    const project = input.cwd;
    const prompt = input.prompt;
    const existingSession = getSessionByContentId(dependencies.db, contentSessionId);
    const transcriptEntries = input.transcriptPath ? readAllTranscriptEntries(input.transcriptPath) : null;
    const invalidationSets = transcriptEntries ? computeInvalidationSets(transcriptEntries) : null;
    const parsedTurns = transcriptEntries ? parseReplayTranscript(input.transcriptPath ?? "", transcriptEntries) : null;
    const transcriptPromptCount = transcriptEntries ? countUserPromptsInEntries(transcriptEntries) : null;
    const repairCursor = {
      byteOffset: existingSession?.scanCursorByteOffset ?? 0,
      lineNumber: existingSession?.scanCursorLine ?? 0
    };
    const repairScan = input.transcriptPath ? scanTranscriptIncrementally(input.transcriptPath, repairCursor, {
      maxLines: dependencies.captureRepairMaxLines ?? DEFAULT_SCAN_MAX_LINES,
      log: dependencies.captureRepairLog
    }) : null;
    const created = writeTransaction(dependencies.db, () => {
      const session = upsertSession(dependencies.db, {
        contentSessionId,
        project,
        // Registration path #2. First-non-NULL inside upsertSession, so a
        // prompt submitted after a `cd` updates project but never the path.
        transcriptPath: input.transcriptPath ?? null,
        title: existingSession?.title ?? null,
        content: existingSession?.content ?? null,
        insight: existingSession?.insight ?? null,
        createdAtEpoch: existingSession?.createdAtEpoch ?? epoch,
        updatedAtEpoch: epoch,
        completedAtEpoch: existingSession?.completedAtEpoch ?? null
      });
      for (const identityKey of deriveProcessIdentityKeys(env)) {
        upsertProcessSessionMap(dependencies.db, identityKey, session.id, epoch);
      }
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
      if (repairScan && (repairScan.entries.length > 0 || repairScan.restarted || repairScan.nextCursor.byteOffset !== repairCursor.byteOffset)) {
        applyCaptureRepair(dependencies.db, session.id, repairScan, repairCursor, {
          nowEpoch: epoch,
          log: dependencies.captureRepairLog
        });
      }
      const dbMaxPromptNumber = getMaxPromptNumber(dependencies.db, session.id);
      const promptNumber = dbMaxPromptNumber !== null ? dbMaxPromptNumber + 1 : transcriptPromptCount !== null ? transcriptPromptCount + 1 : 1;
      const turnId = createPendingTurn(
        dependencies.db,
        session.id,
        promptNumber,
        prompt,
        epoch,
        isSubagent
      );
      let owedSuffix = "";
      let reliefText = null;
      if (!isSubagent && turnId !== null) {
        const owed = listOwedNoteTurns(dependencies.db, session.id, promptNumber);
        owedSuffix = formatOwedSuffix(owed);
        const exposedTurnIds = /* @__PURE__ */ new Set();
        if (owed.length > 0) {
          exposedTurnIds.add(owed[owed.length - 1].turnId);
        }
        if (owed.length >= NOTE_RELIEF_PENDING_THRESHOLD) {
          reliefText = renderNoteBacklogRelief(owed);
          for (const turn of owed.slice(0, NOTE_REMINDER_DISPLAY_LIMIT)) {
            exposedTurnIds.add(turn.turnId);
          }
        }
        if (exposedTurnIds.size > 0) {
          recordNoteIdExposure(dependencies.db, {
            sessionId: session.id,
            rideTurnId: turnId,
            exposedTurnIds: [...exposedTurnIds],
            source: "injection",
            nowEpoch: epoch
          });
        }
      }
      return { sessionDbId: session.id, promptNumber, owedSuffix, reliefText };
    });
    if (isSubagent) {
      return {
        continue: true,
        suppressOutput: true
      };
    }
    const sections = [
      `mnemo current turn: S${created.sessionDbId}/T${created.promptNumber}${created.owedSuffix}`
    ];
    if (created.reliefText) {
      sections.push(created.reliefText);
    }
    return {
      continue: true,
      hookSpecificOutput: sections.join("\n\n")
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
function backfillShadowNoteWriterModels(db, sessionId, transcriptTurns) {
  const hasUnattributedNote = db.query(
    `SELECT 1 AS present
       FROM shadow_notes n
       JOIN turns t ON t.id = n.ride_turn_id
       WHERE t.session_id = ? AND n.writer_model IS NULL
       LIMIT 1`
  ).get(sessionId);
  if (!hasUnattributedNote) {
    return 0;
  }
  const byPromptId = db.query(
    "SELECT id FROM turns WHERE session_id = ? AND content_prompt_id = ?"
  );
  const byPromptNumber = db.query(
    "SELECT id FROM turns WHERE session_id = ? AND prompt_number = ?"
  );
  const update = db.query(
    `UPDATE shadow_notes SET writer_model = ?
     WHERE ride_turn_id = ? AND writer_model IS NULL`
  );
  let filled = 0;
  for (const transcriptTurn of transcriptTurns) {
    if (!transcriptTurn.assistantModel) {
      continue;
    }
    const rideTurn = (transcriptTurn.promptId ? byPromptId.get(sessionId, transcriptTurn.promptId) : null) ?? byPromptNumber.get(sessionId, transcriptTurn.promptNumber);
    if (!rideTurn) {
      continue;
    }
    filled += update.run(transcriptTurn.assistantModel, rideTurn.id)?.changes ?? 0;
  }
  return filled;
}
function backfillFromTranscript(db, pendingTurns, transcriptPath, lastAssistantMessage, transcriptTurns) {
  if (pendingTurns.length === 0) {
    return;
  }
  const replayTurns = transcriptTurns ?? (transcriptPath ? parseReplayTranscript(transcriptPath) : []);
  const lastPendingPromptNumber = pendingTurns[pendingTurns.length - 1]?.promptNumber;
  for (const pendingTurn of pendingTurns) {
    if (pendingTurn.type === "compact" || pendingTurn.assistantResponse || !pendingTurn.userPrompt) {
      continue;
    }
    const isLatestPendingTurn = pendingTurn.promptNumber === lastPendingPromptNumber;
    const transcriptTurn = isLatestPendingTurn ? replayTurns[replayTurns.length - 1] : replayTurns.find(
      (turn) => turn.promptNumber === pendingTurn.promptNumber
    );
    if (!transcriptTurn && !isLatestPendingTurn) {
      continue;
    }
    const transcriptText = transcriptTurn?.assistantText ? stripPrivateTags(transcriptTurn.assistantText) : "";
    const assistantResponse = isLatestPendingTurn && lastAssistantMessage !== void 0 ? lastAssistantMessage : transcriptText;
    const assistantTranscript = transcriptText || assistantResponse || null;
    const toolCallCount = transcriptTurn?.toolCalls.length ?? 0;
    const contentPromptId = isLatestPendingTurn && transcriptTurn?.promptId ? transcriptTurn.promptId : void 0;
    updateTurnBackfill(
      db,
      pendingTurn.id,
      assistantResponse,
      toolCallCount,
      contentPromptId,
      transcriptTurn?.transcriptLineStart,
      assistantTranscript
    );
  }
}

// src/hooks/handlers/stop.ts
function getLatestTurn2(db, sessionDbId) {
  const row = db.query(
    `
        SELECT
          id,
          prompt_number AS promptNumber,
          assistant_response AS assistantResponse,
          created_at_epoch AS createdAtEpoch
        FROM turns
        WHERE session_id = ?
        ORDER BY prompt_number DESC
        LIMIT 1
      `
  ).get(sessionDbId);
  return row ?? null;
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
  const logger = dependencies.logger ?? console;
  const eraCutoffEpoch = dependencies.eraCutoffEpoch !== void 0 ? dependencies.eraCutoffEpoch : resolveEraCutoff(dependencies.db);
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
    const turn = getLatestTurn2(dependencies.db, session.id);
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
      recoverStrandedAncestors(
        dependencies.db,
        session.id,
        epoch,
        eraCutoffEpoch
      );
      enqueueOrphanTurnStops(dependencies.db, session.id, epoch, orphanTurns);
      dependencies.db.query(
        `
            UPDATE turns
            SET assistant_response = COALESCE(?, assistant_response),
                updated_at_epoch = ?
            WHERE id = ?
          `
      ).run(assistantResponse, epoch, turn.id);
      reindexTurnFromDb(dependencies.db, turn.id);
      if (assistantResponse !== null && assistantResponse !== turn.assistantResponse) {
        markSettledDiaryDayStaleForTurn(
          dependencies.db,
          turn.createdAtEpoch
        );
      }
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
      try {
        settleOutstandingTurns(dependencies.db, session.id, eraCutoffEpoch, epoch);
        if (parsedTurns) {
          backfillShadowNoteWriterModels(
            dependencies.db,
            session.id,
            parsedTurns
          );
        }
      } catch (error48) {
        logger.warn?.("turn settlement failed", {
          sessionId: input.sessionId,
          reasonCode: "stop-completion",
          error: error48 instanceof Error ? error48.message : String(error48)
        });
      }
    });
    return {
      continue: true,
      exitCode: HOOK_SUCCESS_EXIT_CODE,
      asyncWork: async () => {
        await notifyWorkerTrigger(
          {
            action: "turn-stop",
            contentSessionId: session.contentSessionId,
            sessionDbId: session.id
          },
          dependencies.workerClientDeps,
          dependencies.workerEnv
        );
      }
    };
  };
}

// src/hooks/hook-command.ts
var defaultHandlers;
var defaultReadOnlyContextHandlers;
var defaultRecentContextHandler;
var defaultDigestContextHandler;
var defaultMilestoneContextHandler;
var defaultNoteTakingContextHandler;
var defaultUserPromptSubmitDispatcher;
var defaultHookDatabase;
var HOOK_DB_BUSY_TIMEOUT_MS = 800;
function createDefaultReadOnlyContextHandlers({
  dataRoot = DATA_DIR
} = {}) {
  const memoryStore = new DreamMemoryStore(dataRoot);
  const readOnlyDependencies = {
    memoryStore
  };
  return {
    "SessionStart:persona": createReadOnlyContextHandler(
      readOnlyDependencies,
      "persona"
    )
  };
}
function createDefaultHookHandlers({
  db,
  dataRoot = DATA_DIR,
  workerClientDeps,
  workerEnv,
  enableSessionEnvCapture = false
}) {
  const fileStore = new DiaryFileStore(dataRoot);
  const contextDependencies = {
    db,
    workerClientDeps,
    workerEnv,
    enableSessionEnvCapture
  };
  return {
    ...createDefaultReadOnlyContextHandlers({ dataRoot }),
    "SessionStart:recent": createReadOnlyContextHandler(
      { db, fileStore },
      "recent"
    ),
    "SessionStart:digest": createReadOnlyContextHandler({ db }, "digest"),
    "SessionStart:milestones": createMilestoneContextHandler({ db }),
    "SessionStart:notes": createNoteTakingContextHandler(),
    SessionStart: createContextHandler(contextDependencies),
    SessionEnd: createSessionEndHandler({ db, workerClientDeps, workerEnv }),
    PostToolUse: createPostToolUseHandler({ db }),
    PreCompact: createCompactHandler({ db, workerClientDeps, workerEnv }),
    UserPromptSubmit: createSessionInitHandler({ db }),
    Stop: createStopHandler({ db, workerClientDeps, workerEnv })
  };
}
function getDefaultHookDatabase() {
  if (!defaultHookDatabase) {
    defaultHookDatabase = createDatabase(void 0, {
      busyTimeoutMs: HOOK_DB_BUSY_TIMEOUT_MS
    });
    initializeDatabase(defaultHookDatabase);
    ensureRecordedEraCutoff(defaultHookDatabase, Math.floor(Date.now() / 1e3));
  }
  return defaultHookDatabase;
}
function getDefaultHandlers() {
  if (defaultHandlers) {
    return defaultHandlers;
  }
  defaultHandlers = createDefaultHookHandlers({
    db: getDefaultHookDatabase(),
    workerEnv: process.env,
    enableSessionEnvCapture: true
  });
  return defaultHandlers;
}
function getDefaultReadOnlyContextHandlers() {
  if (!defaultReadOnlyContextHandlers) {
    defaultReadOnlyContextHandlers = createDefaultReadOnlyContextHandlers();
  }
  return defaultReadOnlyContextHandlers;
}
function getDefaultRecentContextHandler() {
  if (defaultRecentContextHandler) {
    return defaultRecentContextHandler;
  }
  const databasePath = resolveDatabasePath();
  if (!(0, import_node_fs9.existsSync)(databasePath)) {
    defaultRecentContextHandler = async () => ({ continue: true });
    return defaultRecentContextHandler;
  }
  const db = new import_bun_sqlite2.Database(databasePath, {
    readonly: true,
    create: false
  });
  defaultRecentContextHandler = createReadOnlyContextHandler(
    { db, fileStore: new DiaryFileStore(DATA_DIR) },
    "recent"
  );
  return defaultRecentContextHandler;
}
function getDefaultMilestoneContextHandler() {
  if (defaultMilestoneContextHandler) {
    return defaultMilestoneContextHandler;
  }
  const databasePath = resolveDatabasePath();
  if (!(0, import_node_fs9.existsSync)(databasePath)) {
    defaultMilestoneContextHandler = async () => ({ continue: true });
    return defaultMilestoneContextHandler;
  }
  const db = new import_bun_sqlite2.Database(databasePath, {
    readonly: true,
    create: false
  });
  defaultMilestoneContextHandler = createMilestoneContextHandler({ db });
  return defaultMilestoneContextHandler;
}
function getDefaultDigestContextHandler() {
  if (defaultDigestContextHandler) {
    return defaultDigestContextHandler;
  }
  const databasePath = resolveDatabasePath();
  if (!(0, import_node_fs9.existsSync)(databasePath)) {
    defaultDigestContextHandler = async () => ({ continue: true });
    return defaultDigestContextHandler;
  }
  const db = new import_bun_sqlite2.Database(databasePath, {
    readonly: true,
    create: false
  });
  defaultDigestContextHandler = createReadOnlyContextHandler({ db }, "digest");
  return defaultDigestContextHandler;
}
function getDefaultUserPromptSubmitDispatcher() {
  if (!defaultUserPromptSubmitDispatcher) {
    defaultUserPromptSubmitDispatcher = createPromptDispatchHandler();
  }
  return defaultUserPromptSubmitDispatcher;
}
function getDefaultNoteTakingContextHandler() {
  if (!defaultNoteTakingContextHandler) {
    defaultNoteTakingContextHandler = createNoteTakingContextHandler();
  }
  return defaultNoteTakingContextHandler;
}
function getDefaultHandler(handlerKey) {
  if (handlerKey === "UserPromptSubmit:rule-dispatch") {
    return getDefaultUserPromptSubmitDispatcher();
  }
  if (handlerKey === "SessionStart:notes") {
    return getDefaultNoteTakingContextHandler();
  }
  if (handlerKey === "SessionStart:recent") {
    return getDefaultRecentContextHandler();
  }
  if (handlerKey === "SessionStart:digest") {
    return getDefaultDigestContextHandler();
  }
  if (handlerKey === "SessionStart:milestones") {
    return getDefaultMilestoneContextHandler();
  }
  if (handlerKey === "SessionStart:persona") {
    return getDefaultReadOnlyContextHandlers()[handlerKey];
  }
  return getDefaultHandlers()[handlerKey];
}
function readJsonFromStdin() {
  const input = (0, import_node_fs9.readFileSync)(0, "utf8").trim();
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
    case "prompt-dispatch":
      return "UserPromptSubmit";
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
function ruleDispatcherKeyFromCommandArgument(arg) {
  return arg === "prompt-dispatch" ? "UserPromptSubmit:rule-dispatch" : void 0;
}
function contextSectionFromCommandArguments(command, section) {
  if (command !== "context") {
    return "sessions";
  }
  return section === "persona" || section === "recent" || section === "digest" || section === "milestones" || section === "notes" ? section : "sessions";
}
function writeHookResult(result, eventName, stdout = process.stdout) {
  const output = {
    continue: result.continue
  };
  if (result.suppressOutput !== void 0) {
    output.suppressOutput = result.suppressOutput;
  }
  if (result.hookSpecificOutput !== void 0) {
    output.hookSpecificOutput = {
      hookEventName: eventName,
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
  const logger = dependencies.logger ?? createLogger("HOOK");
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
    const contextSection = contextSectionFromCommandArguments(argv[2], argv[3]);
    const handlerKey = ruleDispatcherKeyFromCommandArgument(argv[2]) ?? (normalizedInput.eventName === "SessionStart" && contextSection !== "sessions" ? `SessionStart:${contextSection}` : normalizedInput.eventName);
    const handler = dependencies.handlers ? dependencies.handlers[handlerKey] : getDefaultHandler(handlerKey);
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
    writeHookResult(result, normalizedInput.eventName, stdout);
    return result.exitCode ?? HOOK_SUCCESS_EXIT_CODE;
  } catch (error48) {
    const message = error48 instanceof Error ? error48.message : "Unknown hook failure";
    if (isSqliteBusy(error48)) {
      logger.warn("hook write lost to database contention", {
        command: argv[2] ?? null,
        reasonCode: "hook-write-contention",
        error: message
      });
      return HOOK_SUCCESS_EXIT_CODE;
    }
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
  createDefaultHookHandlers,
  runHookCommand
});
