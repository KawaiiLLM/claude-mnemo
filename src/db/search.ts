import type { Database } from "bun:sqlite";

export interface SessionFtsRecord {
  id: number;
  title: string | null;
  description: string | null;
  insight: string | null;
}

export interface TurnFtsRecord {
  id: number;
  title: string | null;
  description: string | null;
  insight: string | null;
}

export interface ObservationFtsRecord {
  id: number;
  title: string;
  description: string | null;
  narrative: string | null;
  facts: string[];
  concepts: string[];
}

export interface SearchMemoryOptions {
  query?: string;
  project?: string;
  type?: string;
  file?: string;
  fromEpoch?: number;
  toEpoch?: number;
  limit?: number;
}

export interface SearchMemoryResult {
  layer: "session" | "turn" | "observation";
  sourceId: number;
  sessionId: number;
  turnId: number | null;
  observationId: number | null;
  project: string;
  title: string | null;
  description: string | null;
  type: string | null;
  filesRead: string[];
  filesModified: string[];
  timestampEpoch: number;
}

interface SearchRow {
  layer: "session" | "turn" | "observation";
  sourceId: number;
  sessionId: number;
  turnId: number | null;
  observationId: number | null;
  project: string;
  title: string | null;
  description: string | null;
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

function buildDateClause(
  column: string,
  fromEpoch?: number,
  toEpoch?: number,
): { clause: string; params: number[] } {
  const clauses: string[] = [];
  const params: number[] = [];

  if (fromEpoch !== undefined) {
    clauses.push(`${column} >= ?`);
    params.push(fromEpoch);
  }

  if (toEpoch !== undefined) {
    clauses.push(`${column} <= ?`);
    params.push(toEpoch);
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
  layer: "session" | "turn" | "observation",
  sourceId: number,
  title: string | null,
  description: string | null,
  extra: string,
): void {
  db.query("DELETE FROM memory_fts WHERE layer = ? AND source_id = ?").run(
    layer,
    sourceId,
  );

  db.query(
    "INSERT INTO memory_fts (layer, source_id, title, description, extra) VALUES (?, ?, ?, ?, ?)",
  ).run(layer, sourceId, title, description, extra);
}

export function indexSessionToFTS(db: Database, session: SessionFtsRecord): void {
  indexFtsRecord(
    db,
    "session",
    session.id,
    session.title,
    session.description,
    session.insight ?? "",
  );
}

export function indexTurnToFTS(db: Database, turn: TurnFtsRecord): void {
  indexFtsRecord(
    db,
    "turn",
    turn.id,
    turn.title,
    turn.description,
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
    observation.description,
    [observation.narrative ?? "", ...observation.facts, ...observation.concepts]
      .filter(Boolean)
      .join("\n"),
  );
}

export function searchMemory(
  db: Database,
  options: SearchMemoryOptions,
): SearchMemoryResult[] {
  const limit = options.limit ?? 20;

  if (
    !options.query &&
    !options.type &&
    !options.file &&
    options.fromEpoch === undefined &&
    options.toEpoch === undefined
  ) {
    const projectClause = buildProjectClause(options.project);
    const whereClause = combineClauses([projectClause.clause]);

    return db
      .query<SearchRow, Array<string | number>>(`
        SELECT
          'session' AS layer,
          s.id AS sourceId,
          s.id AS sessionId,
          NULL AS turnId,
          NULL AS observationId,
          s.project AS project,
          s.title AS title,
          s.description AS description,
          NULL AS type,
          NULL AS filesRead,
          NULL AS filesModified,
          s.started_at_epoch AS timestampEpoch
        FROM sessions s
        ${whereClause}
        ORDER BY s.started_at_epoch DESC
        LIMIT ?
      `)
      .all(...projectClause.params, limit)
      .map(mapSearchRow);
  }

  const results: SearchMemoryResult[] = [];
  const query = buildSafeFtsQuery(options.query);

  const sessionProjectClause = buildProjectClause(options.project);
  const sessionDateClause = buildDateClause(
    "s.started_at_epoch",
    options.fromEpoch,
    options.toEpoch,
  );
  const sessionWhereClause = combineClauses([
    sessionProjectClause.clause,
    sessionDateClause.clause,
    query ? "f.memory_fts MATCH ?" : "",
  ]);

  if (!options.type && !options.file) {
    results.push(
      ...db
        .query<SearchRow, Array<string | number>>(`
          SELECT
            'session' AS layer,
            s.id AS sourceId,
            s.id AS sessionId,
            NULL AS turnId,
            NULL AS observationId,
            s.project AS project,
            s.title AS title,
            s.description AS description,
            NULL AS type,
            NULL AS filesRead,
            NULL AS filesModified,
            s.started_at_epoch AS timestampEpoch
          FROM sessions s
          ${query ? "JOIN memory_fts f ON f.layer = 'session' AND f.source_id = s.id" : ""}
          ${sessionWhereClause}
          ORDER BY s.started_at_epoch DESC
          LIMIT ?
        `)
        .all(
          ...sessionProjectClause.params,
          ...sessionDateClause.params,
          ...(query ? [query] : []),
          limit,
        )
        .map(mapSearchRow),
    );
  }

  const turnProjectClause = buildProjectClause(options.project);
  const turnDateClause = buildDateClause(
    "t.created_at_epoch",
    options.fromEpoch,
    options.toEpoch,
  );
  const turnFileClause = buildFileClause(
    "t.files_read",
    "t.files_modified",
    options.file,
  );
  const turnWhereClause = combineClauses([
    "t.status = 'extracted'",
    turnProjectClause.clause,
    turnDateClause.clause,
    turnFileClause.clause,
    query ? "f.memory_fts MATCH ?" : "",
  ]);

  if (!options.type) {
    results.push(
      ...db
        .query<SearchRow, Array<string | number>>(`
          SELECT
            'turn' AS layer,
            t.id AS sourceId,
            t.session_id AS sessionId,
            t.id AS turnId,
            NULL AS observationId,
            s.project AS project,
            t.title AS title,
            t.description AS description,
            NULL AS type,
            t.files_read AS filesRead,
            t.files_modified AS filesModified,
            t.created_at_epoch AS timestampEpoch
          FROM turns t
          JOIN sessions s ON s.id = t.session_id
          ${query ? "JOIN memory_fts f ON f.layer = 'turn' AND f.source_id = t.id" : ""}
          ${turnWhereClause}
          ORDER BY t.created_at_epoch DESC
          LIMIT ?
        `)
        .all(
          ...turnProjectClause.params,
          ...turnDateClause.params,
          ...turnFileClause.params,
          ...(query ? [query] : []),
          limit,
        )
        .map(mapSearchRow),
    );
  }

  const observationProjectClause = buildProjectClause(options.project);
  const observationDateClause = buildDateClause(
    "o.created_at_epoch",
    options.fromEpoch,
    options.toEpoch,
  );
  const observationFileClause = buildFileClause(
    "o.files_read",
    "o.files_modified",
    options.file,
  );
  const observationTypeClause = options.type ? "o.type = ?" : "";
  const observationWhereClause = combineClauses([
    observationProjectClause.clause,
    observationDateClause.clause,
    observationFileClause.clause,
    observationTypeClause,
    query ? "f.memory_fts MATCH ?" : "",
  ]);

  results.push(
    ...db
      .query<SearchRow, Array<string | number>>(`
        SELECT
          'observation' AS layer,
          o.id AS sourceId,
          t.session_id AS sessionId,
          t.id AS turnId,
          o.id AS observationId,
          s.project AS project,
          o.title AS title,
          o.description AS description,
          o.type AS type,
          o.files_read AS filesRead,
          o.files_modified AS filesModified,
          o.created_at_epoch AS timestampEpoch
        FROM observations o
        JOIN turns t ON t.id = o.turn_id
        JOIN sessions s ON s.id = t.session_id
        ${query ? "JOIN memory_fts f ON f.layer = 'observation' AND f.source_id = o.id" : ""}
        ${observationWhereClause}
        ORDER BY o.created_at_epoch DESC
        LIMIT ?
      `)
      .all(
        ...observationProjectClause.params,
        ...observationDateClause.params,
        ...observationFileClause.params,
        ...(options.type ? [options.type] : []),
        ...(query ? [query] : []),
        limit,
      )
      .map(mapSearchRow),
  );

  return results.sort((left, right) => right.timestampEpoch - left.timestampEpoch);
}
