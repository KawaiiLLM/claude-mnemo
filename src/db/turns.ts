import type { Database } from "bun:sqlite";

import { indexTurnToFTS } from "./search";

export interface TurnRecord {
  id: number;
  sessionId: number;
  promptNumber: number;
  contentPromptId: string | null;
  transcriptLineStart: number | null;
  status: string;
  userPrompt: string | null;
  assistantResponse: string | null;
  title: string | null;
  content: string | null;
  insight: string | null;
  type: string | null;
  tags: string[];
  filesRead: string[];
  filesModified: string[];
  toolCallCount: number | null;
  createdAtEpoch: number;
  updatedAtEpoch: number | null;
}

interface TurnRow {
  id: number;
  sessionId: number;
  promptNumber: number;
  contentPromptId: string | null;
  transcriptLineStart: number | null;
  status: string;
  userPrompt: string | null;
  assistantResponse: string | null;
  title: string | null;
  content: string | null;
  insight: string | null;
  type: string | null;
  tags: string | null;
  filesRead: string | null;
  filesModified: string | null;
  toolCallCount: number | null;
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
    status,
    user_prompt AS userPrompt,
    assistant_response AS assistantResponse,
    title,
    content,
    insight,
    type,
    tags,
    files_read AS filesRead,
    files_modified AS filesModified,
    tool_call_count AS toolCallCount,
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
    tags: parseJsonArray(row.tags),
    filesRead: parseJsonArray(row.filesRead),
    filesModified: parseJsonArray(row.filesModified),
  };
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

export interface UpdateTurnByIdInput {
  status?: "active" | "extracted" | "skipped" | "undone";
  title?: string | null;
  content?: string | null;
  insight?: string | null;
  type?: string | null;
  transcriptLineStart?: number | null;
  tags?: string[];
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

  const updated = mapTurnRow(
    db
      .query<
        TurnRow,
        [
          string,
          string | null,
          string | null,
          string | null,
          string | null,
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
            title = ?,
            content = ?,
            insight = ?,
            type = ?,
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
            status,
            user_prompt AS userPrompt,
            assistant_response AS assistantResponse,
            title,
            content,
            insight,
            type,
            transcript_line_start AS transcriptLineStart,
            tags,
            files_read AS filesRead,
            files_modified AS filesModified,
            tool_call_count AS toolCallCount,
            created_at_epoch AS createdAtEpoch,
            updated_at_epoch AS updatedAtEpoch
        `,
      )
      .get(
        input.status ?? existing.status,
        input.title ?? existing.title,
        input.content ?? existing.content,
        input.insight ?? existing.insight,
        input.type ?? existing.type,
        input.transcriptLineStart ?? existing.transcriptLineStart,
        stringifyArray(input.tags ?? existing.tags),
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

  if (updated.status === "extracted") {
    indexTurnToFTS(db, updated);
  } else {
    db.query(
      "DELETE FROM memory_fts WHERE layer = 'turn' AND source_id = ?",
    ).run(turnId);
  }

  return updated;
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

export function updateTurnBackfill(
  db: Database,
  turnId: number,
  assistantResponse: string,
  toolCallCount: number,
  contentPromptId?: string | null,
  transcriptLineStart?: number | null,
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
         tool_call_count = ?,
         content_prompt_id = COALESCE(content_prompt_id, ?),
         transcript_line_start = COALESCE(?, transcript_line_start)
     WHERE id = ?`,
  ).run(
    assistantResponse,
    toolCallCount,
    safeContentPromptId,
    transcriptLineStart ?? null,
    turnId,
  );
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
