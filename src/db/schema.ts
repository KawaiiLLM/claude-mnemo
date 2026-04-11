import type { Database } from "bun:sqlite";

import { rebuildSearchIndex } from "./search";

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_session_id TEXT UNIQUE NOT NULL,
    project TEXT NOT NULL,
    title TEXT,
    content TEXT,
    insight TEXT,
    next_steps TEXT,
    last_compact_turn INTEGER,
    last_agent_session_id TEXT,
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

export function initializeSchema(db: Database): void {
  db.exec(SCHEMA_SQL);
  ensureSessionLastAgentSessionIdColumn(db);
  ensureSessionProjectIndex(db);
  ensureTurnPromptIdIndex(db);
}

function ensureSessionLastAgentSessionIdColumn(db: Database): void {
  if (hasColumn(db, "sessions", "last_agent_session_id")) {
    return;
  }

  db.exec("ALTER TABLE sessions ADD COLUMN last_agent_session_id TEXT");
}

function ensureSessionProjectIndex(db: Database): void {
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

function ensureTurnPromptIdIndex(db: Database): void {
  if (!hasColumn(db, "turns", "content_prompt_id")) {
    return;
  }

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_turns_session_prompt_id
      ON turns(session_id, content_prompt_id) WHERE content_prompt_id IS NOT NULL
  `);
}

function hasColumn(db: Database, table: string, column: string): boolean {
  const rows = db
    .query<{ name: string }, []>(`SELECT name FROM pragma_table_info('${table}')`)
    .all();

  return rows.some((row) => row.name === column);
}

function hasRow(
  db: Database,
  sql: string,
  params: Array<string | number> = [],
): boolean {
  return (
    db.query<{ hasRows: number }, Array<string | number>>(
      `SELECT EXISTS(${sql}) AS hasRows`,
    ).get(...params)?.hasRows === 1
  );
}

function shouldRebuildSearchIndex(db: Database): boolean {
  const sourceLayers = [
    { table: "sessions", layer: "session" },
    { table: "turns", layer: "turn" },
    { table: "observations", layer: "observation" },
    { table: "memories", layer: "memory" },
  ] as const;

  const hasAnySourceRows = sourceLayers.some(({ table }) =>
    hasRow(db, `SELECT 1 FROM ${table} LIMIT 1`),
  );
  const hasAnyFtsRows = hasRow(db, "SELECT 1 FROM memory_fts LIMIT 1");

  if (!hasAnySourceRows && !hasAnyFtsRows) {
    return false;
  }

  if (hasAnySourceRows !== hasAnyFtsRows) {
    return true;
  }

  const indexedLayers = new Set(
    db
      .query<{ layer: string }, []>("SELECT DISTINCT layer FROM memory_fts")
      .all()
      .map((row) => row.layer),
  );

  return sourceLayers.some(
    ({ table, layer }) =>
      hasRow(db, `SELECT 1 FROM ${table} LIMIT 1`) &&
      !indexedLayers.has(layer),
  );
}

function hasLegacySchema(db: Database): boolean {
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
    "files_modified",
  ];
  const observationsCurrentColumns = [
    "tool_name",
    "tool_input",
    "tool_result",
    "status",
    "content",
  ];
  const hasLegacyObservationColumns = observationsLegacyColumns.some((column) =>
    hasColumn(db, "observations", column),
  );
  const isMissingCurrentObservationColumns = observationsCurrentColumns.some(
    (column) => !hasColumn(db, "observations", column),
  );

  return (
    sessionsLegacyColumns.some((column) => hasColumn(db, "sessions", column)) ||
    turnsLegacyColumns.some((column) => hasColumn(db, "turns", column)) ||
    (hasLegacyObservationColumns && isMissingCurrentObservationColumns)
  );
}

function resetSchema(db: Database): void {
  db.exec("DROP TABLE IF EXISTS pending_queue");
  db.exec("DROP TABLE IF EXISTS memories");
  db.exec("DROP TABLE IF EXISTS observations");
  db.exec("DROP TABLE IF EXISTS turns");
  db.exec("DROP TABLE IF EXISTS sessions");
  db.exec("DROP TABLE IF EXISTS memory_fts");
}

export function initializeDatabase(db: Database): void {
  if (hasLegacySchema(db)) {
    console.warn("[claude-mnemo] legacy schema detected, resetting database");
    resetSchema(db);
  }

  initializeSchema(db);

  if (shouldRebuildSearchIndex(db)) {
    rebuildSearchIndex(db);
  }
}
