import type { Database } from "bun:sqlite";

import { runWriteTransaction } from "./database";
import { markSettledDiaryDayStaleForTurn } from "./diary-state";

import { indexTurnToFTS, reindexTurnFromDb } from "./search";

export type TurnStatus =
  | "active"
  | "provisional"
  | "extracted"
  | "skipped"
  | "failed"
  | "undone";

export interface TurnRecord {
  id: number;
  sessionId: number;
  promptNumber: number;
  contentPromptId: string | null;
  transcriptLineStart: number | null;
  wasInterrupted: boolean;
  wasRolledBack: boolean;
  extractionStallAttempts: number;
  extractionStallRetryAtMs: number | null;
  extractionStallRetryAfterSeq: number | null;
  extractionStallRetryMode: ExtractionStallRetryMode | null;
  status: TurnStatus;
  userPrompt: string | null;
  assistantResponse: string | null;
  assistantTranscript: string | null;
  title: string | null;
  content: string | null;
  insight: string | null;
  type: string | null;
  significanceGrade: number | null;
  tags: string[];
  filesRead: string[];
  filesModified: string[];
  toolCallCount: number | null;
  parentTurnId: number | null;
  /**
   * True once an extraction supplied a structured `cites` array for this turn
   * (see db/citations.ts). It is the from-absent vs recorded-empty predicate:
   * false ⇒ fall back to parsing inline `[T<n>]` out of `content`.
   */
  citesRecorded: boolean;
  /**
   * Identity key of the `compact_boundary` transcript entry this marker turn
   * claims (spec §F). NULL on every ordinary turn; unique per session, which is
   * what makes boundary claiming idempotent across re-scans.
   */
  compactBoundaryUuid: string | null;
  createdAtEpoch: number;
  updatedAtEpoch: number | null;
}

interface TurnRow {
  id: number;
  sessionId: number;
  promptNumber: number;
  contentPromptId: string | null;
  transcriptLineStart: number | null;
  wasInterrupted: number;
  wasRolledBack: number;
  extractionStallAttempts: number;
  extractionStallRetryAtMs: number | null;
  extractionStallRetryAfterSeq: number | null;
  extractionStallRetryMode: ExtractionStallRetryMode | null;
  status: TurnStatus;
  userPrompt: string | null;
  assistantResponse: string | null;
  assistantTranscript: string | null;
  title: string | null;
  content: string | null;
  insight: string | null;
  type: string | null;
  significanceGrade: number | null;
  tags: string | null;
  filesRead: string | null;
  filesModified: string | null;
  toolCallCount: number | null;
  parentTurnId: number | null;
  citesRecorded: number;
  compactBoundaryUuid: string | null;
  createdAtEpoch: number;
  updatedAtEpoch: number | null;
}

const TURN_SELECT = `
  SELECT
    id,
    session_id AS sessionId,
    prompt_number AS promptNumber,
    content_prompt_id AS contentPromptId,
    transcript_line_start AS transcriptLineStart,
    was_interrupted AS wasInterrupted,
    was_rolled_back AS wasRolledBack,
    extraction_stall_attempts AS extractionStallAttempts,
    extraction_stall_retry_at_ms AS extractionStallRetryAtMs,
    extraction_stall_retry_after_seq AS extractionStallRetryAfterSeq,
    extraction_stall_retry_mode AS extractionStallRetryMode,
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

function stringifyArray(values: string[]): string {
  return JSON.stringify(values);
}

function parseJsonArray(value: string | null): string[] {
  if (!value) {
    return [];
  }

  return JSON.parse(value) as string[];
}

function mapTurnRow(row: TurnRow | null): TurnRecord | null {
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
    citesRecorded: row.citesRecorded === 1,
  };
}

function mergeTags(
  existingTags: string[],
  nextTags: string[] | undefined,
): string[] {
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

export function getTurn(
  db: Database,
  sessionId: number,
  promptNumber: number,
): TurnRecord | null {
  return mapTurnRow(
    db
      .query<TurnRow, [number, number]>(
        `${TURN_SELECT} WHERE session_id = ? AND prompt_number = ?`,
      )
      .get(sessionId, promptNumber) ?? null,
  );
}

export function getTurnById(
  db: Database,
  turnId: number,
): TurnRecord | null {
  return mapTurnRow(
    db.query<TurnRow, [number]>(`${TURN_SELECT} WHERE id = ?`).get(turnId) ?? null,
  );
}

export type ExtractionStallRetryMode = "resume" | "forceFresh";

export interface ExtractionStallRetryRecord {
  turnId: number;
  sessionDbId: number;
  attempts: number;
  retryAtMs: number;
  retryAfterSeq: number;
  nextMode: ExtractionStallRetryMode;
}

/** Atomically consume a stall attempt and persist its next retry gate/mode. */
export function recordExtractionStalls(
  db: Database,
  turnIds: Iterable<number>,
  retryAtMs: number,
  retryAfterSeq: number,
): Map<number, { attempts: number; nextMode: ExtractionStallRetryMode | null }> {
  const uniqueTurnIds = [...new Set(turnIds)];
  return runWriteTransaction(db, () => {
    const attemptsByTurnId = new Map<
      number,
      { attempts: number; nextMode: ExtractionStallRetryMode | null }
    >();
    const statement = db.query<
      { attempts: number; nextMode: ExtractionStallRetryMode | null },
      [number, number, number]
    >(
      `UPDATE turns
       SET extraction_stall_attempts = extraction_stall_attempts + 1,
           extraction_stall_retry_at_ms = CASE
             WHEN extraction_stall_attempts + 1 < 3 THEN ? ELSE NULL END,
           extraction_stall_retry_after_seq = CASE
             WHEN extraction_stall_attempts + 1 < 3 THEN ? ELSE NULL END,
           extraction_stall_retry_mode = CASE extraction_stall_attempts + 1
             WHEN 1 THEN 'resume'
             WHEN 2 THEN 'forceFresh'
             ELSE NULL
           END
       WHERE id = ?
       RETURNING
         extraction_stall_attempts AS attempts,
         extraction_stall_retry_mode AS nextMode`,
    );
    for (const turnId of uniqueTurnIds) {
      const updated = statement.get(retryAtMs, retryAfterSeq, turnId);
      if (updated) {
        attemptsByTurnId.set(turnId, updated);
      }
    }
    return attemptsByTurnId;
  });
}

export function clearExtractionStallRetries(
  db: Database,
  turnIds: Iterable<number>,
): void {
  const uniqueTurnIds = [...new Set(turnIds)];
  if (uniqueTurnIds.length === 0) {
    return;
  }
  const placeholders = uniqueTurnIds.map(() => "?").join(", ");
  db.query<unknown, number[]>(
    `UPDATE turns
     SET extraction_stall_retry_at_ms = NULL,
         extraction_stall_retry_after_seq = NULL,
         extraction_stall_retry_mode = NULL
     WHERE id IN (${placeholders})`,
  ).run(...uniqueTurnIds);
}

export function listExtractionStallRetries(
  db: Database,
): ExtractionStallRetryRecord[] {
  const columns = new Set(
    db
      .query<{ name: string }, []>("SELECT name FROM pragma_table_info('turns')")
      .all()
      .map((row) => row.name),
  );
  if (
    !columns.has("extraction_stall_attempts") ||
    !columns.has("extraction_stall_retry_at_ms") ||
    !columns.has("extraction_stall_retry_after_seq") ||
    !columns.has("extraction_stall_retry_mode")
  ) {
    return [];
  }
  return db
    .query<ExtractionStallRetryRecord, []>(
      `SELECT
         id AS turnId,
         session_id AS sessionDbId,
         extraction_stall_attempts AS attempts,
         extraction_stall_retry_at_ms AS retryAtMs,
         extraction_stall_retry_after_seq AS retryAfterSeq,
         extraction_stall_retry_mode AS nextMode
       FROM turns
       WHERE extraction_stall_retry_at_ms IS NOT NULL
         AND extraction_stall_retry_after_seq IS NOT NULL
         AND extraction_stall_retry_mode IS NOT NULL
       ORDER BY session_id ASC, id ASC`,
    )
    .all();
}

export interface UpdateTurnByIdInput {
  status?: TurnStatus;
  wasInterrupted?: boolean;
  wasRolledBack?: boolean;
  title?: string | null;
  content?: string | null;
  insight?: string | null;
  type?: string | null;
  significanceGrade?: number;
  transcriptLineStart?: number | null;
  tags?: string[];
  replaceTags?: string[];
  filesRead?: string[];
  filesModified?: string[];
  toolCallCount?: number | null;
  updatedAtEpoch?: number | null;
}

export function updateTurnById(
  db: Database,
  turnId: number,
  input: UpdateTurnByIdInput,
): TurnRecord | null {
  const existing = getTurnById(db, turnId);

  if (!existing) {
    return null;
  }

  const mergedTitle = input.title ?? existing.title;
  const mergedContent = input.content ?? existing.content;
  const hasSubstance = mergedTitle !== null || mergedContent !== null;
  const nextStatus =
    input.status ??
    (existing.status === "active" && hasSubstance
      ? "extracted"
      : existing.status);
  const nextTags = input.replaceTags ?? mergeTags(existing.tags, input.tags);

  const updated = mapTurnRow(
    db
      .query<
        TurnRow,
        [
          string,
          number,
          number,
          string | null,
          string | null,
          string | null,
          string | null,
          number | null,
          number | null,
          string,
          string,
          string,
          number | null,
          number | null,
          number,
        ]
      >(
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
            extraction_stall_attempts AS extractionStallAttempts,
            extraction_stall_retry_at_ms AS extractionStallRetryAtMs,
            extraction_stall_retry_after_seq AS extractionStallRetryAfterSeq,
            extraction_stall_retry_mode AS extractionStallRetryMode,
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
        `,
      )
      .get(
        nextStatus,
        input.wasInterrupted ?? existing.wasInterrupted ? 1 : 0,
        input.wasRolledBack ?? existing.wasRolledBack ? 1 : 0,
        input.title ?? existing.title,
        input.content ?? existing.content,
        input.insight ?? existing.insight,
        input.type ?? existing.type,
        input.significanceGrade ?? existing.significanceGrade,
        input.transcriptLineStart ?? existing.transcriptLineStart,
        stringifyArray(nextTags),
        stringifyArray(input.filesRead ?? existing.filesRead),
        stringifyArray(input.filesModified ?? existing.filesModified),
        input.toolCallCount ?? existing.toolCallCount,
        input.updatedAtEpoch ?? existing.updatedAtEpoch,
        turnId,
      ) ?? null,
  );

  if (!updated) {
    return null;
  }

  // Status-blind (spec D11): the row is re-indexed as it now stands, whatever
  // status the write left it in. A skipped or undone turn keeps its originals
  // findable; what a reader is SHOWN is decided at render time.
  indexTurnToFTS(db, updated);

  if (
    existing.status !== updated.status ||
    existing.userPrompt !== updated.userPrompt ||
    existing.assistantResponse !== updated.assistantResponse ||
    existing.title !== updated.title ||
    existing.content !== updated.content ||
    existing.insight !== updated.insight
  ) {
    markSettledDiaryDayStaleForTurn(db, updated.createdAtEpoch);
  }

  return updated;
}

export function resetTurnExtractionFields(
  db: Database,
  turnId: number,
  updatedAtEpoch: number,
): void {
  const existing = getTurnById(db, turnId);
  if (!existing) {
    return;
  }
  // Keep colon-namespaced internal reminder tags; drop agent freeform tags.
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
       WHERE id = ?`,
  ).run(stringifyArray(keptTags), updatedAtEpoch, turnId);
  // Re-index rather than delete: the extraction fields are gone, but the
  // prompt and response this turn was captured with are still the record.
  reindexTurnFromDb(db, turnId);

  if (
    existing.status !== "active" ||
    existing.title !== null ||
    existing.content !== null ||
    existing.insight !== null
  ) {
    markSettledDiaryDayStaleForTurn(db, existing.createdAtEpoch);
  }
}

export function getTurnsForSession(
  db: Database,
  sessionId: number,
): TurnRecord[] {
  return db
    .query<TurnRow, [number]>(
      `${TURN_SELECT} WHERE session_id = ? ORDER BY prompt_number ASC`,
    )
    .all(sessionId)
    .map((row) => mapTurnRow(row))
    .filter((turn): turn is TurnRecord => turn !== null);
}

export function getStrandedTurns(
  db: Database,
  sessionId: number,
): TurnRecord[] {
  return db
    .query<TurnRow, [number]>(
      `${TURN_SELECT}
       WHERE session_id = ?
         AND assistant_response IS NOT NULL
         AND ( status IN ('active','provisional')
               OR (status = 'extracted' AND title IS NULL AND content IS NULL) )
       ORDER BY prompt_number ASC`,
    )
    .all(sessionId)
    .map((row) => mapTurnRow(row))
    .filter((turn): turn is TurnRecord => turn !== null);
}

export function getFirstTurn(
  db: Database,
  sessionId: number,
): TurnRecord | null {
  return mapTurnRow(
    db
      .query<TurnRow, [number]>(
        `${TURN_SELECT} WHERE session_id = ? ORDER BY prompt_number ASC LIMIT 1`,
      )
      .get(sessionId) ?? null,
  );
}

export function setTurnParent(
  db: Database,
  turnId: number,
  parentTurnId: number,
): void {
  db.query("UPDATE turns SET parent_turn_id = ? WHERE id = ?").run(
    parentTurnId,
    turnId,
  );
}

export function getMaxPromptNumber(
  db: Database,
  sessionId: number,
): number | null {
  const row = db
    .query<{ max: number | null }, [number]>(
      "SELECT MAX(prompt_number) AS max FROM turns WHERE session_id = ?",
    )
    .get(sessionId);

  return row?.max ?? null;
}

/**
 * Highest turn id in the session right now. SessionEnd snapshots it alongside
 * the activity gate so its later orphan pass is fenced to turns that already
 * existed — anything a concurrent UserPromptSubmit (or the repair itself)
 * inserts afterwards gets a larger id and is out of scope by construction.
 */
export function getMaxTurnId(db: Database, sessionId: number): number | null {
  const row = db
    .query<{ max: number | null }, [number]>(
      "SELECT MAX(id) AS max FROM turns WHERE session_id = ?",
    )
    .get(sessionId);

  return row?.max ?? null;
}

export function updateTurnBackfill(
  db: Database,
  turnId: number,
  assistantResponse: string,
  toolCallCount: number,
  contentPromptId?: string | null,
  transcriptLineStart?: number | null,
  assistantTranscript?: string | null,
): void {
  const existing = getTurnById(db, turnId);
  if (!existing) {
    return;
  }

  const safeContentPromptId =
    contentPromptId &&
    !hasOtherTurnWithContentPromptId(
      db,
      existing.sessionId,
      turnId,
      contentPromptId,
    )
      ? contentPromptId
      : null;

  db.query(
    `UPDATE turns
     SET assistant_response = ?,
         assistant_transcript = COALESCE(?, assistant_transcript),
         tool_call_count = ?,
         content_prompt_id = COALESCE(content_prompt_id, ?),
         transcript_line_start = COALESCE(?, transcript_line_start)
     WHERE id = ?`,
  ).run(
    assistantResponse,
    assistantTranscript ?? null,
    toolCallCount,
    safeContentPromptId,
    transcriptLineStart ?? null,
    turnId,
  );

  if (existing.assistantResponse !== assistantResponse) {
    markSettledDiaryDayStaleForTurn(db, existing.createdAtEpoch);
  }
}

function hasOtherTurnWithContentPromptId(
  db: Database,
  sessionId: number,
  turnId: number,
  contentPromptId: string,
): boolean {
  return (
    db
      .query<{ id: number }, [number, string, number]>(
        `
          SELECT id
          FROM turns
          WHERE session_id = ?
            AND content_prompt_id = ?
            AND id <> ?
          LIMIT 1
        `,
      )
      .get(sessionId, contentPromptId, turnId) !== null
  );
}
