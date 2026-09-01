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

export interface SegmentFtsRecord {
  id: number;
  title: string;
  /**
   * The `segments.content` column's STORED bytes, whatever they are. Whether
   * they reach the index is not this caller's decision — see
   * `tenantedSegmentContent` below and `impressionOrigin`.
   */
  content: string | null;
  /**
   * `segments.impression_origin`, the TENANCY of the `content` column above:
   * non-null means those bytes are the task-tier impression, NULL means they
   * are the pre-ticket-05 prose the main agent used to write there, which no
   * card renders and no reader reads (db/segments.ts).
   *
   * REQUIRED, not optional, and deliberately so: every caller that projects a
   * segment into FTS has to state the tenancy, so neither the incremental path
   * (`indexSegment`, db/segments.ts) nor the full rebuild below can quietly
   * omit it and get the old behaviour back.
   */
  impressionOrigin: string | null;
  /** Ticket 14 (spec K5): shares the `extra` slot with the facets below, exactly as a turn's own `insight` occupies that slot. */
  insight?: string | null;
  // Ticket 03 (spec.md:55 — "segment field rows as first-class search hits
  // beside turns"): the Working State fields join the same `extra` slot.
  // Optional so a caller that only ever touches the summary layer (none exist
  // today, but nothing should require restating three nulls) still type-checks.
  //
  // THREE, not six (lane-impressions ticket 05): `decisions`/`done`/
  // `next_steps` left the product, so they stop being indexed. Their columns
  // keep their text and their already-indexed FTS rows keep theirs until the
  // segment's next write or a full `rebuildSearchIndex` re-projects it — this
  // ticket switches fields off, it does not sweep storage.
  goal?: string | null;
  constraints?: string | null;
  reference?: string | null;
  /** JSON arrays as stored on the row; both go into the `extra` slot. */
  type: string | null;
  tags: string | null;
}

/**
 * Which turn statuses reach a reader (spec D11).
 *
 * FTS ingest stopped caring about status in ticket 06 — the index answers "was
 * this ever written down", which is a property of the text. Deciding what a
 * reader is SHOWN is this side's job, and it is the same answer the index used
 * to enforce by deleting rows: a `skipped`, `undone`, `failed` or still in-flight
 * turn is not a search hit. Its originals stay indexed and stay reachable by
 * direct address (`recall(id="S<n>/T<m>")`) and by replay.
 */
const RENDERED_TURN_STATUS_CLAUSE = "t.status = 'extracted'";

export interface SearchMemoryOptions {
  scope?: "sessions" | "turns" | "observations" | "segments";
  query?: string;
  project?: string;
  type?: string;
  file?: string;
  tag?: string;
  sessionId?: number;
  after?: number;
  before?: number;
  limit?: number;
  /** See `buildObservationStatusClause`. */
  eraCutoffEpoch?: number | null;
}

/**
 * Which observations a search is allowed to return, per era.
 *
 * Legacy: `extracted` only. There, `skipped` was a JUDGEMENT — the extraction
 * agent read the row and decided it was noise — so the ~70k skipped rows are
 * exactly the ones a reader should not be shown.
 *
 * Era: any status. The same word means something else now. Nothing summarizes
 * an observation any more, so every row ends `skipped` on completion and the
 * status carries no opinion about worth at all; filtering on it would hide the
 * whole layer. What makes an era observation findable is its own captured tool
 * input and output, indexed at capture (db/observations.ts).
 */
/**
 * A `note` call is the agent's bookkeeping ABOUT a turn, not work inside it, and
 * it is withheld from every reader-facing surface — recall's turn views, the
 * turn's tool-call count, the dream read tools. Search has to withhold it too.
 *
 * It used to be withheld by accident: a note observation never reached
 * `extracted`, so a filter on that status excluded it as a side effect. Once the
 * status filter stopped applying in the segment era, that accident stopped
 * protecting anything — and by then capture had begun indexing every
 * observation, note calls included, whose tool input is the note's full text.
 * The rule is now stated where it is meant, and it holds in both eras.
 */
const READER_FACING_OBSERVATION_CLAUSE = "o.excluded_from_extraction = 0";

function buildObservationStatusClause(eraCutoffEpoch: number | null | undefined): {
  clause: string;
  params: number[];
} {
  return eraCutoffEpoch === null || eraCutoffEpoch === undefined
    ? { clause: "o.status = 'extracted'", params: [] }
    : {
        clause: "(o.status = 'extracted' OR t.created_at_epoch >= ?)",
        params: [eraCutoffEpoch],
      };
}

export interface SearchMemoryResult {
  /**
   * `segment` rows carry the segment id in `sourceId` and leave `sessionId`
   * null — a segment is not bound to a session (spec D6), so it enters the hit
   * set as a peer of the session rows rather than under one.
   */
  layer: "session" | "turn" | "observation" | "segment";
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
  layer: "session" | "turn" | "observation" | "segment";
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
// matches only a literal `%` tag (not everything), `svg` never matches
// `svg-filter`, and a NULL or `[]` tags column simply yields no rows.
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
  layer: "session" | "turn" | "observation" | "segment" | "rule",
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

/**
 * Index a segment, so the higher level of memory is searchable through the same
 * query a turn is (spec D6: a segment carries a turn's field shape precisely so
 * the read surfaces need no second vocabulary). `type` and `tags` share the
 * `extra` slot, the same slot a session's summary fields use.
 *
 * Ticket 03 (spec.md:55 — "segment field rows as first-class search hits
 * beside turns"): the Working State fields join the `extra` slot too.
 * Before this, `recall(query=...)` could only ever answer from a segment's
 * title/content/insight/facets — a wording that lived ONLY in `goal` was
 * invisible to search no matter how the segment's own injected fields read it,
 * which is the same gap ticket 05 closes for `content`/`insight`'s WRITE path
 * (this is that gap's read-side twin).
 */
/**
 * THE TENANCY PREDICATE, and the only copy of it (user ruling S15069/T2331,
 * 「已经退役的文本，不要参与检索」): retired text leaves retrieval.
 *
 * `segments.content` has one column and two possible tenants. Since
 * lane-impressions ticket 05 it is the task-tier impression's home — but only
 * once `impression_origin` is written, which is what CLAIMS the slot
 * (`replaceSegmentTaskImpression`, db/segments.ts). Until then the column still
 * holds the prose the main agent used to write there before ticket 05 took the
 * field off the write face, and `readSegmentTaskImpression` already answers
 * `text: null` for it, so no card renders a byte of it.
 *
 * Text no card will render is text no search may find. Without this, a
 * `recall(query=…)` hits a segment on words the product retired and then shows
 * a card that refuses to display them — the live path and the stored index
 * disagreeing, which is the one outcome the ruling forbids.
 *
 * It lives HERE, inside the single function both index paths funnel through,
 * rather than at either caller: `indexSegment` (the incremental path) and
 * `rebuildSearchIndex` (the full sweep) must never be able to answer the same
 * query differently depending on which last touched a row.
 *
 * SCOPE: the index only. The bytes stay in their column — clearing storage is
 * a separate, separately-irreversible decision (ticket "Out of scope").
 */
function tenantedSegmentContent(segment: SegmentFtsRecord): string | null {
  return segment.impressionOrigin === null ? null : segment.content;
}

export function indexSegmentToFTS(db: Database, segment: SegmentFtsRecord): void {
  const facets = [segment.type, segment.tags]
    .flatMap((value) => {
      if (!value) {
        return [];
      }
      try {
        const parsed = JSON.parse(value) as unknown;
        return Array.isArray(parsed)
          ? parsed.filter((item): item is string => typeof item === "string")
          : [];
      } catch {
        return [];
      }
    })
    .join(" ");

  const workingState = [
    segment.goal,
    segment.constraints,
    segment.reference,
  ]
    .filter((value): value is string => Boolean(value && value.trim()))
    .join("\n");

  indexFtsRecord(
    db,
    "segment",
    segment.id,
    segment.title,
    tenantedSegmentContent(segment),
    [segment.insight ?? "", workingState, facets]
      .filter((part) => part.trim() !== "")
      .join("\n"),
    null,
    null,
  );
}

/**
 * Re-project EVERY segment row into FTS.
 *
 * The segment layer of `rebuildSearchIndex` below, lifted out as its own
 * function so a caller that needs only THIS layer re-derived — a rule change
 * about segments, and nothing else — does not have to restate the column set,
 * and cannot restate it differently.
 *
 * Ticket 03: the same column set `indexSegment` (db/segments.ts) passes on the
 * incremental path. The full rebuild and the per-write reindex must never
 * answer a `type:`/`tag:`/text query differently depending on which path last
 * touched a given segment.
 *
 * `impression_origin` joins that set for exactly the same reason
 * (retired-text-leaves-retrieval ticket 01). It is not indexed itself; it is
 * the tenancy `tenantedSegmentContent` needs in order to decide whether
 * `content` holds an impression or retired prose. A sweep that omitted it would
 * re-admit every untenanted `content` the incremental path has just stopped
 * indexing — half the ruling, which is worse than none.
 *
 * Returns how many rows it re-projected.
 */
export function reindexAllSegments(db: Database): number {
  const segmentRows = db
    .query<SegmentFtsRecord, []>(
      `SELECT
         id, title, content, impression_origin AS impressionOrigin, insight,
         goal, constraints, reference,
         type, tags
       FROM segments ORDER BY id`,
    )
    .all();
  for (const segment of segmentRows) {
    indexSegmentToFTS(db, segment);
  }
  return segmentRows.length;
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

  reindexAllSegments(db);

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
  const statusClause = buildObservationStatusClause(options.eraCutoffEpoch);
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
      ${combineClauses([
        READER_FACING_OBSERVATION_CLAUSE,
        statusClause.clause,
        projectClause.clause,
      ])}
      ORDER BY o.created_at_epoch DESC
    `, options.limit),
    withLimit([...statusClause.params, ...projectClause.params], options.limit),
  );
}

/**
 * The `type:`/`file:`/`tag:` facets as a SESSION answers them: "does this
 * session hold such a turn". Written once for both the text and filter-only
 * paths — two copies of a predicate are two places for the status rule to go
 * missing, which is how a skipped turn came back as a session hit.
 *
 * Every one of them is scoped by `RENDERED_TURN_STATUS_CLAUSE`, so the turns a
 * session is judged by are exactly the turns the turn-scoped query would
 * return; otherwise a hidden turn re-enters the hit set one level up.
 */
function buildSessionTurnFacetClauses(options: SearchMemoryOptions): {
  clauses: string[];
  params: Array<string | number>;
} {
  const clauses: string[] = [];
  const params: Array<string | number> = [];

  if (options.type) {
    clauses.push(
      `EXISTS (
        SELECT 1
        FROM turns t
        WHERE t.session_id = s.id
          AND ${RENDERED_TURN_STATUS_CLAUSE}
          AND EXISTS (SELECT 1 FROM json_each(t.type) WHERE value = ?)
      )`,
    );
    params.push(options.type);
  }

  if (options.file) {
    clauses.push(
      `EXISTS (
        SELECT 1
        FROM turns t
        WHERE t.session_id = s.id
          AND ${RENDERED_TURN_STATUS_CLAUSE}
          AND (t.files_read LIKE ? OR t.files_modified LIKE ?)
      )`,
    );
    params.push(`%${options.file}%`, `%${options.file}%`);
  }

  if (options.tag) {
    clauses.push(
      `EXISTS (
        SELECT 1
        FROM turns t
        WHERE t.session_id = s.id
          AND ${RENDERED_TURN_STATUS_CLAUSE}
          AND EXISTS (SELECT 1 FROM json_each(t.tags) WHERE value = ?)
      )`,
    );
    params.push(options.tag);
  }

  return { clauses, params };
}

function querySessionsByScope(
  db: Database,
  options: SearchMemoryOptions,
  query?: string,
): SearchMemoryResult[] {
  const projectClause = buildProjectClause(options.project);
  const dateClause = buildDateClause("s.created_at_epoch", options);
  const sessionClause = buildSessionClause("s.id", options.sessionId);
  const facets = buildSessionTurnFacetClauses(options);

  if (query) {
    const whereClauses = ["memory_fts.layer = 'session'", "memory_fts MATCH ?", projectClause.clause, sessionClause.clause, dateClause.clause, ...facets.clauses];
    const params: Array<string | number> = [query, ...projectClause.params, ...sessionClause.params, ...dateClause.params, ...facets.params];

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

  const whereClauses = [projectClause.clause, sessionClause.clause, dateClause.clause, ...facets.clauses];
  const params: Array<string | number> = [...projectClause.params, ...sessionClause.params, ...dateClause.params, ...facets.params];

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
    const whereClauses = ["memory_fts.layer = 'turn'", "memory_fts MATCH ?", RENDERED_TURN_STATUS_CLAUSE, projectClause.clause, sessionClause.clause, dateClause.clause, fileClause.clause, tagClause.clause];
    const params: Array<string | number> = [query, ...projectClause.params, ...sessionClause.params, ...dateClause.params, ...fileClause.params, ...tagClause.params];

    if (options.type) {
      whereClauses.push("EXISTS (SELECT 1 FROM json_each(t.type) WHERE value = ?)");
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

  const whereClauses = [RENDERED_TURN_STATUS_CLAUSE, projectClause.clause, sessionClause.clause, dateClause.clause, fileClause.clause, tagClause.clause];
  const params: Array<string | number> = [...projectClause.params, ...sessionClause.params, ...dateClause.params, ...fileClause.params, ...tagClause.params];

  if (options.type) {
    whereClauses.push("EXISTS (SELECT 1 FROM json_each(t.type) WHERE value = ?)");
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

/**
 * Segment hits (spec D11's `E` selector). A segment answers `tag:` and `type:`
 * off its own JSON arrays, and answers `project:`/`session:` through its
 * MEMBERS — the only relation it has to a session at all. `file:` excludes the
 * layer outright: a segment records no file set of its own.
 */
function querySegmentsByScope(
  db: Database,
  options: SearchMemoryOptions,
  query?: string,
): SearchMemoryResult[] {
  if (options.file) {
    return [];
  }

  const dateClause = buildDateClause("g.created_at_epoch", options);
  const tagClause = buildTagClause("g.tags", options.tag);
  const whereClauses: string[] = [];
  const params: Array<string | number> = [];

  if (query) {
    whereClauses.push("memory_fts.layer = 'segment'", "memory_fts MATCH ?");
    params.push(query);
  }

  whereClauses.push(dateClause.clause, tagClause.clause);
  params.push(...dateClause.params, ...tagClause.params);

  if (options.type) {
    whereClauses.push("EXISTS (SELECT 1 FROM json_each(g.type) WHERE value = ?)");
    params.push(options.type);
  }

  if (options.project !== undefined) {
    whereClauses.push(
      `EXISTS (
         SELECT 1 FROM segment_members sm
         JOIN turns t ON t.id = sm.turn_id
         JOIN sessions s ON s.id = t.session_id
         WHERE sm.segment_id = g.id AND s.project = ?
       )`,
    );
    params.push(options.project);
  }

  if (options.sessionId !== undefined) {
    whereClauses.push(
      `EXISTS (
         SELECT 1 FROM segment_members sm
         JOIN turns t ON t.id = sm.turn_id
         WHERE sm.segment_id = g.id AND t.session_id = ?
       )`,
    );
    params.push(options.sessionId);
  }

  const selection = `
    SELECT
      'segment' AS layer,
      g.id AS sourceId,
      NULL AS sessionId,
      NULL AS turnId,
      NULL AS observationId,
      NULL AS sourceTurnId,
      '' AS project,
      g.title AS title,
      g.content AS content,
      g.type AS type,
      NULL AS filesRead,
      NULL AS filesModified,
      g.created_at_epoch AS timestampEpoch,
      ${query ? "bm25(memory_fts, 0.0, 0.0, 10.0, 5.0, 5.0, 3.0, 1.0)" : "NULL"} AS relevance
    ${
      query
        ? "FROM memory_fts JOIN segments g ON g.id = memory_fts.source_id"
        : "FROM segments g"
    }
    ${combineClauses(whereClauses)}
    ORDER BY ${query ? "relevance ASC" : "g.created_at_epoch DESC"}
  `;

  return queryRows(db, applyLimit(selection, options.limit), withLimit(params, options.limit));
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
  const statusClause = buildObservationStatusClause(options.eraCutoffEpoch);
  const dateClause = buildDateClause("o.created_at_epoch", options);
  const sessionClause = buildSessionClause("t.session_id", options.sessionId);

  if (query) {
    const whereClauses = ["memory_fts.layer = 'observation'", "memory_fts MATCH ?", READER_FACING_OBSERVATION_CLAUSE, statusClause.clause, projectClause.clause, sessionClause.clause, dateClause.clause];
    const params: Array<string | number> = [query, ...statusClause.params, ...projectClause.params, ...sessionClause.params, ...dateClause.params];

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

  const whereClauses = [READER_FACING_OBSERVATION_CLAUSE, statusClause.clause, projectClause.clause, sessionClause.clause, dateClause.clause];
  const params: Array<string | number> = [...statusClause.params, ...projectClause.params, ...sessionClause.params, ...dateClause.params];

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

    if (options.scope === "segments") {
      return querySegmentsByScope(db, options, query);
    }

    return queryRecentObservations(db, options);
  }

  if (!options.scope) {
    const results: SearchMemoryResult[] = [];

    if (!options.file) {
      results.push(...querySessionsByScope(db, options, query));
      // Segments sit beside sessions rather than under them: one `tag:` query
      // is meant to return the chapter AND its member turns in one pass
      // (spec D6 / user story 16), so the caller gets the hierarchy for free.
      results.push(...querySegmentsByScope(db, options, query));
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

  if (options.scope === "segments") {
    return querySegmentsByScope(db, options, query);
  }

  return queryObservationsByScope(db, options, query);
}
