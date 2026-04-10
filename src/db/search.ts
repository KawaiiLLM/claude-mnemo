import type { Database } from "bun:sqlite";

export interface SessionFtsRecord {
  id: number;
  title: string | null;
  content: string | null;
  insight: string | null;
}

export interface TurnFtsRecord {
  id: number;
  title: string | null;
  content: string | null;
  insight: string | null;
}

export interface ObservationFtsRecord {
  id: number;
  title: string | null;
  content: string | null;
}

export interface MemoryFtsRecord {
  id: number;
  title: string;
  content: string;
  reasoning: string | null;
  application: string | null;
  tags: string[];
}

export interface SearchMemoryOptions {
  scope?: "sessions" | "turns" | "observations" | "memories";
  query?: string;
  project?: string;
  type?: string;
  file?: string;
  after?: number;
  before?: number;
  limit?: number;
}

export interface SearchMemoryResult {
  layer: "session" | "turn" | "observation" | "memory";
  sourceId: number;
  sessionId: number | null;
  turnId: number | null;
  observationId: number | null;
  sourceTurnId: number | null;
  project: string;
  title: string | null;
  content: string | null;
  type: string | null;
  filesRead: string[];
  filesModified: string[];
  timestampEpoch: number;
}

interface SearchRow {
  layer: "session" | "turn" | "observation" | "memory";
  sourceId: number;
  sessionId: number | null;
  turnId: number | null;
  observationId: number | null;
  sourceTurnId: number | null;
  project: string;
  title: string | null;
  content: string | null;
  type: string | null;
  filesRead: string | null;
  filesModified: string | null;
  timestampEpoch: number;
}

function parseJsonArray(value: string | null): string[] {
  if (!value) {
    return [];
  }

  return JSON.parse(value) as string[];
}

function mapSearchRow(row: SearchRow): SearchMemoryResult {
  return {
    ...row,
    filesRead: parseJsonArray(row.filesRead),
    filesModified: parseJsonArray(row.filesModified),
  };
}

function resolveEpochRange(options: SearchMemoryOptions): {
  after?: number;
  before?: number;
} {
  const lowerBounds = [options.after].filter(
    (value): value is number => value !== undefined,
  );
  const upperBounds = [options.before].filter(
    (value): value is number => value !== undefined,
  );

  return {
    after: lowerBounds.length > 0 ? Math.max(...lowerBounds) : undefined,
    before: upperBounds.length > 0 ? Math.min(...upperBounds) : undefined,
  };
}

function buildDateClause(
  column: string,
  options: SearchMemoryOptions,
): { clause: string; params: number[] } {
  const { after, before } = resolveEpochRange(options);
  const clauses: string[] = [];
  const params: number[] = [];

  if (after !== undefined) {
    clauses.push(`${column} >= ?`);
    params.push(after);
  }

  if (before !== undefined) {
    clauses.push(`${column} <= ?`);
    params.push(before);
  }

  return {
    clause: clauses.length > 0 ? clauses.join(" AND ") : "",
    params,
  };
}

function buildFileClause(
  readColumn: string,
  modifiedColumn: string,
  file?: string,
): { clause: string; params: string[] } {
  if (!file) {
    return { clause: "", params: [] };
  }

  return {
    clause: `(${readColumn} LIKE ? OR ${modifiedColumn} LIKE ?)`,
    params: [`%${file}%`, `%${file}%`],
  };
}

function buildProjectClause(project?: string): {
  clause: string;
  params: string[];
} {
  if (!project) {
    return { clause: "", params: [] };
  }

  return {
    clause: "s.project = ?",
    params: [project],
  };
}

function buildMemoryScopeClause(project?: string): {
  clause: string;
  params: string[];
} {
  if (!project) {
    return { clause: "", params: [] };
  }

  return {
    clause: "(m.scope = 'global' OR m.scope = ?)",
    params: [project],
  };
}

function combineClauses(clauses: string[]): string {
  const filtered = clauses.filter(Boolean);

  return filtered.length > 0 ? ` WHERE ${filtered.join(" AND ")}` : "";
}

function buildSafeFtsQuery(query?: string): string | undefined {
  const terms = query
    ?.trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term.replace(/"/g, '""')}"`);

  if (!terms || terms.length === 0) {
    return undefined;
  }

  return terms.join(" AND ");
}

function indexFtsRecord(
  db: Database,
  layer: "session" | "turn" | "observation" | "memory",
  sourceId: number,
  title: string | null,
  content: string | null,
  extra: string,
): void {
  db.query("DELETE FROM memory_fts WHERE layer = ? AND source_id = ?").run(
    layer,
    sourceId,
  );

  db.query(
    "INSERT INTO memory_fts (layer, source_id, title, content, extra) VALUES (?, ?, ?, ?, ?)",
  ).run(layer, sourceId, title, content, extra);
}

export function indexSessionToFTS(db: Database, session: SessionFtsRecord): void {
  indexFtsRecord(
    db,
    "session",
    session.id,
    session.title,
    session.content,
    session.insight ?? "",
  );
}

export function indexTurnToFTS(db: Database, turn: TurnFtsRecord): void {
  indexFtsRecord(
    db,
    "turn",
    turn.id,
    turn.title,
    turn.content,
    turn.insight ?? "",
  );
}

export function indexObservationToFTS(
  db: Database,
  observation: ObservationFtsRecord,
): void {
  indexFtsRecord(
    db,
    "observation",
    observation.id,
    observation.title,
    observation.content,
    "",
  );
}

export function indexMemoryToFTS(
  db: Database,
  memory: MemoryFtsRecord,
): void {
  indexFtsRecord(
    db,
    "memory",
    memory.id,
    memory.title,
    memory.content,
    [memory.reasoning ?? "", memory.application ?? "", ...memory.tags]
      .filter(Boolean)
      .join("\n"),
  );
}

export function rebuildSearchIndex(db: Database): void {
  db.exec("DELETE FROM memory_fts");

  const sessionRows = db
    .query<
      { id: number; title: string | null; content: string | null; insight: string | null },
      []
    >(
      `
        SELECT
          id,
          title,
          content,
          insight
        FROM sessions
      `,
    )
    .all();

  for (const session of sessionRows) {
    indexSessionToFTS(db, session);
  }

  const turnRows = db
    .query<
      { id: number; title: string | null; content: string | null; insight: string | null },
      []
    >(
      `
        SELECT
          id,
          title,
          content,
          insight
        FROM turns
        WHERE status = 'extracted'
      `,
    )
    .all();

  for (const turn of turnRows) {
    indexTurnToFTS(db, turn);
  }

  const observationRows = db
    .query<
      {
        id: number;
        title: string | null;
        content: string | null;
        status: string;
      },
      []
    >(
      `
        SELECT
          id,
          title,
          content,
          status
        FROM observations
        WHERE status = 'extracted'
      `,
    )
    .all();

  for (const observation of observationRows) {
    indexObservationToFTS(db, {
      id: observation.id,
      title: observation.title,
      content: observation.content,
    });
  }

  const memoryRows = db
    .query<
      {
        id: number;
        title: string;
        content: string;
        reasoning: string | null;
        application: string | null;
        tags: string | null;
      },
      []
    >(
      `
        SELECT
          id,
          title,
          content,
          reasoning,
          application,
          tags
        FROM memories
      `,
    )
    .all();

  for (const memory of memoryRows) {
    indexMemoryToFTS(db, {
      ...memory,
      tags: memory.tags ? (JSON.parse(memory.tags) as string[]) : [],
    });
  }
}

function queryRows(
  db: Database,
  sql: string,
  params: Array<string | number>,
): SearchMemoryResult[] {
  return db.query<SearchRow, Array<string | number>>(sql).all(...params).map(mapSearchRow);
}

function queryRecentSessions(db: Database, options: SearchMemoryOptions): SearchMemoryResult[] {
  const projectClause = buildProjectClause(options.project);
  return queryRows(
    db,
    `
      SELECT
        'session' AS layer,
        s.id AS sourceId,
        s.id AS sessionId,
        NULL AS turnId,
        NULL AS observationId,
        NULL AS sourceTurnId,
        s.project AS project,
        s.title AS title,
        s.content AS content,
        NULL AS type,
        NULL AS filesRead,
        NULL AS filesModified,
        s.created_at_epoch AS timestampEpoch
      FROM sessions s
      ${combineClauses([projectClause.clause])}
      ORDER BY s.created_at_epoch DESC
      LIMIT ?
    `,
    [...projectClause.params, options.limit ?? 20],
  );
}

function queryRecentTurns(db: Database, options: SearchMemoryOptions): SearchMemoryResult[] {
  const projectClause = buildProjectClause(options.project);
  return queryRows(
    db,
    `
      SELECT
        'turn' AS layer,
        t.id AS sourceId,
        t.session_id AS sessionId,
        t.id AS turnId,
        NULL AS observationId,
        NULL AS sourceTurnId,
        s.project AS project,
        t.title AS title,
        t.content AS content,
        NULL AS type,
        t.files_read AS filesRead,
        t.files_modified AS filesModified,
        t.created_at_epoch AS timestampEpoch
      FROM turns t
      JOIN sessions s ON s.id = t.session_id
      ${combineClauses([projectClause.clause])}
      ORDER BY t.created_at_epoch DESC
      LIMIT ?
    `,
    [...projectClause.params, options.limit ?? 20],
  );
}

function queryRecentObservations(
  db: Database,
  options: SearchMemoryOptions,
): SearchMemoryResult[] {
  const projectClause = buildProjectClause(options.project);
  return queryRows(
    db,
    `
      SELECT
        'observation' AS layer,
        o.id AS sourceId,
        t.session_id AS sessionId,
        t.id AS turnId,
        o.id AS observationId,
        NULL AS sourceTurnId,
        s.project AS project,
        o.title AS title,
        o.content AS content,
        NULL AS type,
        NULL AS filesRead,
        NULL AS filesModified,
        o.created_at_epoch AS timestampEpoch
      FROM observations o
      JOIN turns t ON t.id = o.turn_id
      JOIN sessions s ON s.id = t.session_id
      ${combineClauses(["o.status = 'extracted'", projectClause.clause])}
      ORDER BY o.created_at_epoch DESC
      LIMIT ?
    `,
    [...projectClause.params, options.limit ?? 20],
  );
}

function queryRecentMemories(
  db: Database,
  options: SearchMemoryOptions,
): SearchMemoryResult[] {
  const scopeClause = buildMemoryScopeClause(options.project);
  const dateClause = buildDateClause(
    "COALESCE(m.updated_at_epoch, m.created_at_epoch)",
    options,
  );

  return queryRows(
    db,
    `
      SELECT
        'memory' AS layer,
        m.id AS sourceId,
        NULL AS sessionId,
        NULL AS turnId,
        NULL AS observationId,
        m.source_turn_id AS sourceTurnId,
        m.scope AS project,
        m.title AS title,
        m.content AS content,
        m.type AS type,
        NULL AS filesRead,
        NULL AS filesModified,
        COALESCE(m.updated_at_epoch, m.created_at_epoch) AS timestampEpoch
      FROM memories m
      ${combineClauses(["m.status = 'active'", scopeClause.clause, dateClause.clause])}
      ORDER BY COALESCE(m.updated_at_epoch, m.created_at_epoch) DESC, m.id DESC
      LIMIT ?
    `,
    [...scopeClause.params, ...dateClause.params, options.limit ?? 20],
  );
}

function querySessionsByScope(
  db: Database,
  options: SearchMemoryOptions,
  query?: string,
): SearchMemoryResult[] {
  const projectClause = buildProjectClause(options.project);
  const dateClause = buildDateClause("s.created_at_epoch", options);
  const whereClauses = [projectClause.clause, dateClause.clause];
  const params: Array<string | number> = [...projectClause.params, ...dateClause.params];

  if (query) {
    whereClauses.push("f.memory_fts MATCH ?");
    params.push(query);
  }

  if (options.type) {
    whereClauses.push(
      `EXISTS (
        SELECT 1
        FROM turns t
        WHERE t.session_id = s.id
          AND (
            t.type = ?
            OR EXISTS (
              SELECT 1
              FROM observations o
              WHERE o.turn_id = t.id
                AND o.type = ?
            )
          )
      )`,
    );
    params.push(options.type, options.type);
  }

  if (options.file) {
    whereClauses.push(
      `EXISTS (
        SELECT 1
        FROM turns t
        WHERE t.session_id = s.id
          AND (t.files_read LIKE ? OR t.files_modified LIKE ?)
      )`,
    );
    params.push(`%${options.file}%`, `%${options.file}%`);
  }

  return queryRows(
    db,
    `
      SELECT
        'session' AS layer,
        s.id AS sourceId,
        s.id AS sessionId,
        NULL AS turnId,
        NULL AS observationId,
        NULL AS sourceTurnId,
        s.project AS project,
        s.title AS title,
        s.content AS content,
        NULL AS type,
        NULL AS filesRead,
        NULL AS filesModified,
        s.created_at_epoch AS timestampEpoch
      FROM sessions s
      ${query ? "JOIN memory_fts f ON f.layer = 'session' AND f.source_id = s.id" : ""}
      ${combineClauses(whereClauses)}
      ORDER BY s.created_at_epoch DESC
      LIMIT ?
    `,
    [...params, options.limit ?? 20],
  );
}

function queryTurnsByScope(
  db: Database,
  options: SearchMemoryOptions,
  query?: string,
): SearchMemoryResult[] {
  const projectClause = buildProjectClause(options.project);
  const dateClause = buildDateClause("t.created_at_epoch", options);
  const fileClause = buildFileClause("t.files_read", "t.files_modified", options.file);
  const whereClauses = ["1 = 1", projectClause.clause, dateClause.clause, fileClause.clause];
  const params: Array<string | number> = [...projectClause.params, ...dateClause.params, ...fileClause.params];

  if (query) {
    whereClauses.push("f.memory_fts MATCH ?");
    params.push(query);
  }

  if (options.type) {
    whereClauses.push(
      `(t.type = ? OR EXISTS (
        SELECT 1
        FROM observations o
        WHERE o.turn_id = t.id
          AND o.type = ?
      ))`,
    );
    params.push(options.type, options.type);
  }

  return queryRows(
    db,
    `
      SELECT
        'turn' AS layer,
        t.id AS sourceId,
        t.session_id AS sessionId,
        t.id AS turnId,
        NULL AS observationId,
        NULL AS sourceTurnId,
        s.project AS project,
        t.title AS title,
        t.content AS content,
        NULL AS type,
        t.files_read AS filesRead,
        t.files_modified AS filesModified,
        t.created_at_epoch AS timestampEpoch
      FROM turns t
      JOIN sessions s ON s.id = t.session_id
      ${query ? "JOIN memory_fts f ON f.layer = 'turn' AND f.source_id = t.id" : ""}
      ${combineClauses(whereClauses)}
      ORDER BY t.created_at_epoch DESC
      LIMIT ?
    `,
    [...params, options.limit ?? 20],
  );
}

function queryObservationsByScope(
  db: Database,
  options: SearchMemoryOptions,
  query?: string,
): SearchMemoryResult[] {
  if (options.file) {
    return [];
  }

  const projectClause = buildProjectClause(options.project);
  const dateClause = buildDateClause("o.created_at_epoch", options);
  const whereClauses = ["o.status = 'extracted'", projectClause.clause, dateClause.clause];
  const params: Array<string | number> = [...projectClause.params, ...dateClause.params];

  if (query) {
    whereClauses.push("f.memory_fts MATCH ?");
    params.push(query);
  }

  if (options.type) {
    whereClauses.push("o.type = ?");
    params.push(options.type);
  }

  return queryRows(
    db,
    `
      SELECT
        'observation' AS layer,
        o.id AS sourceId,
        t.session_id AS sessionId,
        t.id AS turnId,
        o.id AS observationId,
        NULL AS sourceTurnId,
        s.project AS project,
        o.title AS title,
        o.content AS content,
        NULL AS type,
        NULL AS filesRead,
        NULL AS filesModified,
        o.created_at_epoch AS timestampEpoch
      FROM observations o
      JOIN turns t ON t.id = o.turn_id
      JOIN sessions s ON s.id = t.session_id
      ${query ? "JOIN memory_fts f ON f.layer = 'observation' AND f.source_id = o.id" : ""}
      ${combineClauses(whereClauses)}
      ORDER BY o.created_at_epoch DESC
      LIMIT ?
    `,
    [...params, options.limit ?? 20],
  );
}

function queryMemoriesByScope(
  db: Database,
  options: SearchMemoryOptions,
  query?: string,
): SearchMemoryResult[] {
  if (options.file) {
    return [];
  }

  const scopeClause = buildMemoryScopeClause(options.project);
  const dateClause = buildDateClause(
    "COALESCE(m.updated_at_epoch, m.created_at_epoch)",
    options,
  );
  const whereClauses = ["m.status = 'active'", scopeClause.clause, dateClause.clause];
  const params: Array<string | number> = [...scopeClause.params, ...dateClause.params];

  if (query) {
    whereClauses.push("f.memory_fts MATCH ?");
    params.push(query);
  }

  if (options.type) {
    whereClauses.push("m.type = ?");
    params.push(options.type);
  }

  return queryRows(
    db,
    `
      SELECT
        'memory' AS layer,
        m.id AS sourceId,
        NULL AS sessionId,
        NULL AS turnId,
        NULL AS observationId,
        m.source_turn_id AS sourceTurnId,
        m.scope AS project,
        m.title AS title,
        m.content AS content,
        m.type AS type,
        NULL AS filesRead,
        NULL AS filesModified,
        COALESCE(m.updated_at_epoch, m.created_at_epoch) AS timestampEpoch
      FROM memories m
      ${query ? "JOIN memory_fts f ON f.layer = 'memory' AND f.source_id = m.id" : ""}
      ${combineClauses(whereClauses)}
      ORDER BY COALESCE(m.updated_at_epoch, m.created_at_epoch) DESC, m.id DESC
      LIMIT ?
    `,
    [...params, options.limit ?? 20],
  );
}

export function searchMemory(
  db: Database,
  options: SearchMemoryOptions,
): SearchMemoryResult[] {
  const query = buildSafeFtsQuery(options.query);
  const hasFilters =
    Boolean(options.type) ||
    Boolean(options.file) ||
    options.after !== undefined ||
    options.before !== undefined;

  if (!query && !hasFilters) {
    if (options.scope === "memories") {
      return queryRecentMemories(db, options);
    }

    if (!options.scope || options.scope === "sessions") {
      return queryRecentSessions(db, options);
    }

    if (options.scope === "turns") {
      return queryRecentTurns(db, options);
    }

    return queryRecentObservations(db, options);
  }

  if (!options.scope) {
    const results: SearchMemoryResult[] = [];

    if (!options.file) {
      results.push(...querySessionsByScope(db, options, query));
    }

    results.push(...queryTurnsByScope(db, options, query));

    results.push(...queryObservationsByScope(db, options, query));

    if (!options.file) {
      results.push(...queryMemoriesByScope(db, options, query));
    }

    return results.sort((left, right) => right.timestampEpoch - left.timestampEpoch);
  }

  if (options.scope === "sessions") {
    return querySessionsByScope(db, options, query);
  }

  if (options.scope === "turns") {
    return queryTurnsByScope(db, options, query);
  }

  if (options.scope === "memories") {
    return queryMemoriesByScope(db, options, query);
  }

  return queryObservationsByScope(db, options, query);
}
