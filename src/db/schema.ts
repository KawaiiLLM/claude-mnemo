import type { Database } from "bun:sqlite";

const SCHEMA_SQL = `
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

export function initializeSchema(db: Database): void {
  db.exec(SCHEMA_SQL);
}

function hasColumn(db: Database, table: string, column: string): boolean {
  const rows = db
    .query<{ name: string }, []>(`SELECT name FROM pragma_table_info('${table}')`)
    .all();

  return rows.some((row) => row.name === column);
}

export function migrateSchema(db: Database): void {
  if (!hasColumn(db, "sessions", "next_steps")) {
    db.exec("ALTER TABLE sessions ADD COLUMN next_steps TEXT");
  }

  if (!hasColumn(db, "turns", "tool_call_count")) {
    db.exec("ALTER TABLE turns ADD COLUMN tool_call_count INTEGER");
  }
}
