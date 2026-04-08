import type { Database } from "bun:sqlite";

import { rebuildSearchIndex } from "./search";

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_session_id TEXT UNIQUE NOT NULL,
    project TEXT NOT NULL,
    title TEXT,
    content TEXT,
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
    content TEXT,
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
    content TEXT,
    description TEXT,
    insight TEXT,
    narrative TEXT,
    facts TEXT,
    tags TEXT,
    concepts TEXT,
    files_read TEXT,
    files_modified TEXT,
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

export function migrateSchema(db: Database): boolean {
  let searchIndexNeedsRebuild = false;

  if (!hasColumn(db, "sessions", "next_steps")) {
    db.exec("ALTER TABLE sessions ADD COLUMN next_steps TEXT");
  }

  if (!hasColumn(db, "sessions", "content")) {
    db.exec("ALTER TABLE sessions ADD COLUMN content TEXT");
  }

  if (!hasColumn(db, "turns", "tool_call_count")) {
    db.exec("ALTER TABLE turns ADD COLUMN tool_call_count INTEGER");
  }

  if (!hasColumn(db, "turns", "content")) {
    db.exec("ALTER TABLE turns ADD COLUMN content TEXT");
  }

  if (!hasColumn(db, "observations", "content")) {
    db.exec("ALTER TABLE observations ADD COLUMN content TEXT");
  }

  if (!hasColumn(db, "observations", "insight")) {
    db.exec("ALTER TABLE observations ADD COLUMN insight TEXT");
  }

  if (!hasColumn(db, "observations", "tags")) {
    db.exec("ALTER TABLE observations ADD COLUMN tags TEXT");
  }

  if (
    hasRow(
      db,
      "SELECT 1 FROM sessions WHERE content IS NULL AND description IS NOT NULL LIMIT 1",
    )
  ) {
    db.exec(`
      UPDATE sessions
      SET content = COALESCE(content, description)
      WHERE content IS NULL AND description IS NOT NULL
    `);
    searchIndexNeedsRebuild = true;
  }

  if (
    hasRow(
      db,
      "SELECT 1 FROM turns WHERE content IS NULL AND description IS NOT NULL LIMIT 1",
    )
  ) {
    db.exec(`
      UPDATE turns
      SET content = COALESCE(content, description)
      WHERE content IS NULL AND description IS NOT NULL
    `);
    searchIndexNeedsRebuild = true;
  }

  if (
    hasRow(
      db,
      `
        SELECT 1 FROM observations
        WHERE
          (content IS NULL AND description IS NOT NULL)
          OR (insight IS NULL AND narrative IS NOT NULL)
          OR (tags IS NULL AND concepts IS NOT NULL)
        LIMIT 1
      `,
    )
  ) {
    db.exec(`
      UPDATE observations
      SET
        content = COALESCE(content, description),
        insight = COALESCE(insight, narrative),
        tags = COALESCE(tags, concepts)
      WHERE
        (content IS NULL AND description IS NOT NULL)
        OR (insight IS NULL AND narrative IS NOT NULL)
        OR (tags IS NULL AND concepts IS NOT NULL)
    `);
    searchIndexNeedsRebuild = true;
  }

  const ftsColumns = db
    .query<{ name: string }, []>("SELECT name FROM pragma_table_info('memory_fts')")
    .all()
    .map((row) => row.name);

  if (ftsColumns.length > 0 && !ftsColumns.includes("content")) {
    db.exec("DROP TABLE IF EXISTS memory_fts");
    db.exec(`
      CREATE VIRTUAL TABLE memory_fts USING fts5(
        layer,
        source_id,
        title,
        content,
        extra
      )
    `);
    searchIndexNeedsRebuild = true;
  }

  return searchIndexNeedsRebuild;
}

export function initializeDatabase(db: Database): void {
  initializeSchema(db);
  const migrationNeedsRebuild = migrateSchema(db);

  if (migrationNeedsRebuild || shouldRebuildSearchIndex(db)) {
    rebuildSearchIndex(db);
  }
}
