import type { Database } from "bun:sqlite";

export interface SessionFtsRecord {
  id: number;
  title: string | null;
  content: string | null;
  insight: string | null;
  decision?: string | null;
  done?: string | null;
  current?: string | null;
  nextSteps?: string | null;
  reference?: string | null;
}

export interface TurnFtsRecord {
  id: number;
  title: string | null;
  content: string | null;
  insight: string | null;
  userPrompt: string | null;
  assistantResponse: string | null;
}

export interface ObservationFtsRecord {
  id: number;
  title: string | null;
  content: string | null;
}

export interface SearchMemoryOptions {
  scope?: "sessions" | "turns" | "observations";
  query?: string;
  project?: string;
  type?: string;
  file?: string;
  after?: number;
  before?: number;
  limit?: number;
}

export interface SearchMemoryResult {
  layer: "session" | "turn" | "observation";
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
  layer: "session" | "turn" | "observation";
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

function combineClauses(clauses: string[]): string {
  const filtered = clauses.filter(Boolean);

  return filtered.length > 0 ? ` WHERE ${filtered.join(" AND ")}` : "";
}

function buildSafeFtsQuery(query?: string): string | undefined {
  const terms = query
    ?.trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => {
      const sanitized = term.replace(/["\*]/g, "");
      return sanitized ? `"${sanitized.replace(/"/g, '""')}"*` : null;
    })
    .filter(Boolean);

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
  content: string | null,
  extra: string,
  prompt: string,
  response: string,
): void {
  db.query("DELETE FROM memory_fts WHERE layer = ? AND source_id = ?").run(
    layer,
    sourceId,
  );

  db.query(
    "INSERT INTO memory_fts (layer, source_id, title, content, extra, prompt, response) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(layer, sourceId, title, content, extra, prompt, response);
}

export function indexSessionToFTS(db: Database, session: SessionFtsRecord): void {
  // D8: the redesigned summary fields go in the `extra` slot (freed by dropping
  // session insight). The legacy-vs-new decision keys ONLY on the new columns
  // (decision/done/current/reference) — NOT next_steps, which predates the
  // redesign. A legacy session (new columns NULL, insight set) keeps extra =
  // insight so its search behavior is unchanged; otherwise the redesigned
  // fields (including next) are indexed.
  const hasNewFields = [
    session.decision,
    session.done,
    session.current,
    session.reference,
  ].some((value) => Boolean(value && value.trim()));
  const hasLegacyInsight = Boolean(session.insight && session.insight.trim());

  const extra =
    !hasNewFields && hasLegacyInsight
      ? session.insight!
      : [
          session.decision,
          session.done,
          session.current,
          session.nextSteps,
          session.reference,
        ]
          .filter((value): value is string => Boolean(value && value.trim()))
          .join("\n");

  indexFtsRecord(
    db,
    "session",
    session.id,
    session.title,
    session.content,
    extra,
    "",
    "",
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
    turn.userPrompt ?? "",
    turn.assistantResponse ?? "",
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
    "",
    "",
  );
}

export function rebuildSearchIndex(db: Database): void {
  db.exec("DELETE FROM memory_fts");

  const sessionRows = db
    .query<
      {
        id: number;
        title: string | null;
        content: string | null;
        insight: string | null;
        decision: string | null;
        done: string | null;
        current: string | null;
        nextSteps: string | null;
        reference: string | null;
      },
      []
    >(
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
      `,
    )
    .all();

  for (const session of sessionRows) {
    indexSessionToFTS(db, session);
  }

  const turnRows = db
    .query<
      {
        id: number;
        title: string | null;
        content: string | null;
        insight: string | null;
        userPrompt: string | null;
        assistantResponse: string | null;
      },
      []
    >(
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
}

function queryRows(
  db: Database,
  sql: string,
  params: Array<string | number>,
): SearchMemoryResult[] {
  return db.query<SearchRow, Array<string | number>>(sql).all(...params).map(mapSearchRow);
}

function applyLimit(sql: string, limit?: number): string {
  return limit === undefined ? sql : `${sql}\n      LIMIT ?`;
}

function withLimit<T extends Array<string | number>>(params: T, limit?: number): Array<string | number> {
  return limit === undefined ? params : [...params, limit];
}

function queryRecentSessions(db: Database, options: SearchMemoryOptions): SearchMemoryResult[] {
  const projectClause = buildProjectClause(options.project);
  return queryRows(
    db,
    applyLimit(`
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
    `, options.limit),
    withLimit([...projectClause.params], options.limit),
  );
}

function queryRecentTurns(db: Database, options: SearchMemoryOptions): SearchMemoryResult[] {
  const projectClause = buildProjectClause(options.project);
  return queryRows(
    db,
    applyLimit(`
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
    `, options.limit),
    withLimit([...projectClause.params], options.limit),
  );
}

function queryRecentObservations(
  db: Database,
  options: SearchMemoryOptions,
): SearchMemoryResult[] {
  const projectClause = buildProjectClause(options.project);
  return queryRows(
    db,
    applyLimit(`
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
    `, options.limit),
    withLimit([...projectClause.params], options.limit),
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
          AND t.type = ?
      )`,
    );
    params.push(options.type);
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
    applyLimit(`
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
    `, options.limit),
    withLimit(params, options.limit),
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
    whereClauses.push("t.type = ?");
    params.push(options.type);
  }

  return queryRows(
    db,
    applyLimit(`
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
    `, options.limit),
    withLimit(params, options.limit),
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
    return [];
  }

  return queryRows(
    db,
    applyLimit(`
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
    `, options.limit),
    withLimit(params, options.limit),
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

    return results.sort((left, right) => right.timestampEpoch - left.timestampEpoch);
  }

  if (options.scope === "sessions") {
    return querySessionsByScope(db, options, query);
  }

  if (options.scope === "turns") {
    return queryTurnsByScope(db, options, query);
  }

  return queryObservationsByScope(db, options, query);
}
