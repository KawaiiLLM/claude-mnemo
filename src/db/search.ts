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
  toolInput?: string | null;
  toolResult?: string | null;
}

/**
 * How much of an observation's raw tool input and output reaches the index
 * (spec D11). The full corpus is ~1.3 GB and cannot be indexed; the head of a
 * payload is where the identifying material lives (the path, the command, the
 * first error line), so a truncated original buys most of the recall at a
 * fraction of the size.
 */
export const OBSERVATION_ORIGINAL_INDEX_CHARS = 500;

function truncateOriginal(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  return value.length > OBSERVATION_ORIGINAL_INDEX_CHARS
    ? value.slice(0, OBSERVATION_ORIGINAL_INDEX_CHARS)
    : value;
}

export interface RuleFtsRecord {
  id: number;
  name: string;
  claim: string;
}

export function normalizeTrigramText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/\s+/gu, " ")
    .trim();
}

export interface SearchMemoryOptions {
  scope?: "sessions" | "turns" | "observations";
  query?: string;
  project?: string;
  type?: string;
  file?: string;
  tag?: string;
  sessionId?: number;
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
  relevance: number | null;
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
  relevance: number | null;
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

// Exact-match a single tag value against the JSON-array `tags` column via
// json_each, so the match is on a whole array ELEMENT — not a substring. This
// makes `tag:` truly exact and immune to LIKE-wildcard pitfalls: `tag:%`
// matches only a literal `%` tag (not everything), `topic:svg` never matches
// `topic:svg-filter`, and a NULL or `[]` tags column simply yields no rows.
function buildTagClause(
  column: string,
  tag?: string,
): { clause: string; params: string[] } {
  if (!tag) {
    return { clause: "", params: [] };
  }

  return {
    clause: `EXISTS (SELECT 1 FROM json_each(${column}) WHERE value = ?)`,
    params: [tag],
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

function buildSessionClause(
  column: string,
  sessionId?: number,
): { clause: string; params: number[] } {
  if (sessionId === undefined) {
    return { clause: "", params: [] };
  }

  return {
    clause: `${column} = ?`,
    params: [sessionId],
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
      const sanitized = term.replace(/["*]/g, "");
      return sanitized ? `"${sanitized.replace(/"/g, '""')}"` : null;
    })
    .filter(Boolean);

  if (!terms || terms.length === 0) {
    return undefined;
  }

  return terms.join(" OR ");
}

function indexFtsRecord(
  db: Database,
  layer: "session" | "turn" | "observation" | "rule",
  sourceId: number,
  title: string | null,
  content: string | null,
  extra: string,
  prompt: string | null,
  response: string | null,
): void {
  db.query("DELETE FROM memory_fts WHERE layer = ? AND source_id = ?").run(
    layer,
    sourceId,
  );

  db.query(
    "INSERT INTO memory_fts (layer, source_id, title, content, extra, prompt, response) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(layer, sourceId, title, content, extra, prompt ?? "", response ?? "");
}

export function indexRuleToFTS(db: Database, rule: RuleFtsRecord): void {
  indexFtsRecord(
    db,
    "rule",
    rule.id,
    rule.name,
    normalizeTrigramText(rule.claim),
    "",
    null,
    null,
  );
}

export function searchRuleClaimCandidates(
  db: Database,
  trigrams: readonly string[],
): number[] {
  if (trigrams.length === 0) {
    return [];
  }
  const query = [...new Set(trigrams)]
    .map((trigram) => `"${trigram.replaceAll('"', '""')}"`)
    .join(" OR ");
  return db
    .query<{ sourceId: number }, [string]>(
      `SELECT CAST(source_id AS INTEGER) AS sourceId
       FROM memory_fts
       WHERE memory_fts MATCH ? AND layer = 'rule'
       ORDER BY bm25(memory_fts, 0.0, 0.0, 1.0) ASC, sourceId ASC`,
    )
    .all(query)
    .map(({ sourceId }) => sourceId);
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
    null,
    null,
  );
}

/**
 * Index a turn. Called at MECHANICAL CAPTURE time and again on every content
 * write, with no reference to the turn's status (spec D11, R1#5/R2#4).
 *
 * The index and the rendering answer different questions. "Was this ever
 * written down" is a property of the text; "is this worth showing you" is a
 * judgement that changes as a turn is extracted, skipped or aged. Binding the
 * index to the judgement is what made a `skipped` turn's own prompt
 * unfindable — the one artefact whose wording the user is most likely to
 * remember. Status filtering now lives entirely on the rendering side.
 */
export function indexTurnToFTS(db: Database, turn: TurnFtsRecord): void {
  indexFtsRecord(
    db,
    "turn",
    turn.id,
    turn.title,
    turn.content,
    turn.insight ?? "",
    turn.userPrompt,
    turn.assistantResponse,
  );
}

/** Re-index a turn from its current row; a no-op if the turn is gone. */
export function reindexTurnFromDb(db: Database, turnId: number): void {
  const turn = db
    .query<TurnFtsRecord, [number]>(
      `SELECT
         id,
         title,
         content,
         insight,
         user_prompt AS userPrompt,
         assistant_response AS assistantResponse
       FROM turns
       WHERE id = ?`,
    )
    .get(turnId);

  if (turn) {
    indexTurnToFTS(db, turn);
  }
}

/**
 * Index an observation, likewise status-blind. The raw tool input and output go
 * into the prompt/response slots truncated (see
 * OBSERVATION_ORIGINAL_INDEX_CHARS) so a tool call is findable by what it
 * actually did, whether or not anything ever summarized it.
 */
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
    truncateOriginal(observation.toolInput),
    truncateOriginal(observation.toolResult),
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
        toolInput: string | null;
        toolResult: string | null;
      },
      []
    >(
      `
        SELECT
          id,
          title,
          content,
          substr(tool_input, 1, ${OBSERVATION_ORIGINAL_INDEX_CHARS}) AS toolInput,
          substr(tool_result, 1, ${OBSERVATION_ORIGINAL_INDEX_CHARS}) AS toolResult
        FROM observations
      `,
    )
    .all();

  for (const observation of observationRows) {
    indexObservationToFTS(db, observation);
  }

  const ruleRows = db
    .query<RuleFtsRecord, []>("SELECT id, name, claim FROM rules ORDER BY id")
    .all();
  for (const rule of ruleRows) {
    indexRuleToFTS(db, rule);
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
        s.created_at_epoch AS timestampEpoch,
        NULL AS relevance
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
        t.created_at_epoch AS timestampEpoch,
        NULL AS relevance
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
        o.created_at_epoch AS timestampEpoch,
        NULL AS relevance
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
  const sessionClause = buildSessionClause("s.id", options.sessionId);

  if (query) {
    const whereClauses = ["memory_fts.layer = 'session'", "memory_fts MATCH ?", projectClause.clause, sessionClause.clause, dateClause.clause];
    const params: Array<string | number> = [query, ...projectClause.params, ...sessionClause.params, ...dateClause.params];

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

    if (options.tag) {
      whereClauses.push(
        `EXISTS (
          SELECT 1
          FROM turns t
          WHERE t.session_id = s.id
            AND EXISTS (SELECT 1 FROM json_each(t.tags) WHERE value = ?)
        )`,
      );
      params.push(options.tag);
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
          s.created_at_epoch AS timestampEpoch,
          bm25(memory_fts, 0.0, 0.0, 10.0, 5.0, 5.0, 3.0, 1.0) AS relevance
        FROM memory_fts
        JOIN sessions s ON s.id = memory_fts.source_id
        ${combineClauses(whereClauses)}
        ORDER BY relevance ASC
      `, options.limit),
      withLimit(params, options.limit),
    );
  }

  const whereClauses = [projectClause.clause, sessionClause.clause, dateClause.clause];
  const params: Array<string | number> = [...projectClause.params, ...sessionClause.params, ...dateClause.params];

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

  if (options.tag) {
    whereClauses.push(
      `EXISTS (
        SELECT 1
        FROM turns t
        WHERE t.session_id = s.id
          AND EXISTS (SELECT 1 FROM json_each(t.tags) WHERE value = ?)
      )`,
    );
    params.push(options.tag);
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
        s.created_at_epoch AS timestampEpoch,
        NULL AS relevance
      FROM sessions s
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
  const tagClause = buildTagClause("t.tags", options.tag);
  const sessionClause = buildSessionClause("t.session_id", options.sessionId);

  if (query) {
    const whereClauses = ["memory_fts.layer = 'turn'", "memory_fts MATCH ?", projectClause.clause, sessionClause.clause, dateClause.clause, fileClause.clause, tagClause.clause];
    const params: Array<string | number> = [query, ...projectClause.params, ...sessionClause.params, ...dateClause.params, ...fileClause.params, ...tagClause.params];

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
          t.created_at_epoch AS timestampEpoch,
          bm25(memory_fts, 0.0, 0.0, 10.0, 5.0, 5.0, 3.0, 1.0) AS relevance
        FROM memory_fts
        JOIN turns t ON t.id = memory_fts.source_id
        JOIN sessions s ON s.id = t.session_id
        ${combineClauses(whereClauses)}
        ORDER BY relevance ASC
      `, options.limit),
      withLimit(params, options.limit),
    );
  }

  const whereClauses = ["1 = 1", projectClause.clause, sessionClause.clause, dateClause.clause, fileClause.clause, tagClause.clause];
  const params: Array<string | number> = [...projectClause.params, ...sessionClause.params, ...dateClause.params, ...fileClause.params, ...tagClause.params];

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
        t.created_at_epoch AS timestampEpoch,
        NULL AS relevance
      FROM turns t
      JOIN sessions s ON s.id = t.session_id
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

  if (options.type) {
    return [];
  }

  // Tags live on turns, not observations — a tag filter excludes the obs layer.
  if (options.tag) {
    return [];
  }

  const projectClause = buildProjectClause(options.project);
  const dateClause = buildDateClause("o.created_at_epoch", options);
  const sessionClause = buildSessionClause("t.session_id", options.sessionId);

  if (query) {
    const whereClauses = ["memory_fts.layer = 'observation'", "memory_fts MATCH ?", "o.status = 'extracted'", projectClause.clause, sessionClause.clause, dateClause.clause];
    const params: Array<string | number> = [query, ...projectClause.params, ...sessionClause.params, ...dateClause.params];

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
          o.created_at_epoch AS timestampEpoch,
          bm25(memory_fts, 0.0, 0.0, 10.0, 5.0, 5.0, 3.0, 1.0) AS relevance
        FROM memory_fts
        JOIN observations o ON o.id = memory_fts.source_id
        JOIN turns t ON t.id = o.turn_id
        JOIN sessions s ON s.id = t.session_id
        ${combineClauses(whereClauses)}
        ORDER BY relevance ASC
      `, options.limit),
      withLimit(params, options.limit),
    );
  }

  const whereClauses = ["o.status = 'extracted'", projectClause.clause, sessionClause.clause, dateClause.clause];
  const params: Array<string | number> = [...projectClause.params, ...sessionClause.params, ...dateClause.params];

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
        o.created_at_epoch AS timestampEpoch,
        NULL AS relevance
      FROM observations o
      JOIN turns t ON t.id = o.turn_id
      JOIN sessions s ON s.id = t.session_id
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
    Boolean(options.tag) ||
    options.sessionId !== undefined ||
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

    if (query) {
      return results.sort((left, right) => {
        const leftRank = left.relevance ?? Number.POSITIVE_INFINITY;
        const rightRank = right.relevance ?? Number.POSITIVE_INFINITY;
        if (leftRank !== rightRank) {
          return leftRank - rightRank;
        }
        return right.timestampEpoch - left.timestampEpoch;
      });
    }

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
