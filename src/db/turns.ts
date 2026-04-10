import type { Database } from "bun:sqlite";

import { createObservation } from "./observations";
import { indexTurnToFTS } from "./search";

export interface ObservationInput {
  toolName?: string | null;
  toolInput?: string | null;
  toolResult?: string | null;
  status?: "pending" | "extracted" | "skipped";
  title?: string | null;
  content?: string | null;
}

export interface SaveTurnInput {
  sessionId: number;
  promptNumber: number;
  status?: "undone";
  userPrompt: string | null;
  assistantResponse: string | null;
  title: string | null;
  content?: string | null;
  insight: string | null;
  type?: string | null;
  tags?: string[];
  filesRead: string[];
  filesModified: string[];
  createdAtEpoch: number;
  updatedAtEpoch: number | null;
  observations: ObservationInput[];
}

export interface TurnRecord {
  id: number;
  sessionId: number;
  promptNumber: number;
  contentPromptId: string | null;
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

function hasExtractedContent(input: SaveTurnInput): boolean {
  return Boolean(
    input.title ||
      input.content ||
      input.insight ||
      input.observations.length > 0,
  );
}

function deleteObservationFts(db: Database, turnId: number): void {
  const observationIds = db
    .query<{ id: number }, [number]>(
      "SELECT id FROM observations WHERE turn_id = ? ORDER BY id",
    )
    .all(turnId)
    .map((row) => row.id);

  const deleteObservationFtsStatement = db.query(
    "DELETE FROM memory_fts WHERE layer = 'observation' AND source_id = ?",
  );

  for (const observationId of observationIds) {
    deleteObservationFtsStatement.run(observationId);
  }
}

export function saveTurn(db: Database, input: SaveTurnInput): TurnRecord {
  const status =
    input.status === "undone"
      ? "undone"
      : hasExtractedContent(input)
        ? "extracted"
        : "skipped";
  db.exec("BEGIN");

  try {
    const existingTurn = getTurn(db, input.sessionId, input.promptNumber);
    const filesRead = stringifyArray(input.filesRead);
    const filesModified = stringifyArray(input.filesModified);

    let turnId: number;

    if (existingTurn) {
      deleteObservationFts(db, existingTurn.id);
      db.query(
        "DELETE FROM memory_fts WHERE layer = 'turn' AND source_id = ?",
      ).run(existingTurn.id);
      db.query("DELETE FROM observations WHERE turn_id = ?").run(existingTurn.id);

      db.query(
        `UPDATE turns
         SET status = ?,
             user_prompt = COALESCE(?, user_prompt),
             assistant_response = COALESCE(?, assistant_response),
            title = ?,
            content = ?,
            insight = ?,
            type = ?,
            tags = ?,
            files_read = ?,
             files_modified = ?,
             created_at_epoch = ?,
             updated_at_epoch = ?
         WHERE id = ?`,
      ).run(
        status,
        input.userPrompt,
        input.assistantResponse,
        input.title,
        input.content ?? null,
        input.insight,
        input.type ?? null,
        stringifyArray(input.tags ?? []),
        filesRead,
        filesModified,
        input.createdAtEpoch,
        input.updatedAtEpoch,
        existingTurn.id,
      );

      turnId = existingTurn.id;
    } else {
      const insertedTurn = db
        .query<
          { id: number },
        [
          number,
          number,
          string,
          string | null,
          string | null,
          string | null,
          string | null,
          string | null,
          string | null,
          string,
          string,
          string,
          number,
          number | null,
        ]
        >(`
          INSERT INTO turns (
            session_id,
            prompt_number,
            status,
            user_prompt,
            assistant_response,
            title,
            content,
            insight,
            type,
            tags,
          files_read,
          files_modified,
          created_at_epoch,
          updated_at_epoch
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          RETURNING id
        `)
        .get(
          input.sessionId,
          input.promptNumber,
          status,
          input.userPrompt,
          input.assistantResponse,
          input.title,
          input.content ?? null,
          input.insight,
          input.type ?? null,
          stringifyArray(input.tags ?? []),
          filesRead,
          filesModified,
          input.createdAtEpoch,
          input.updatedAtEpoch,
        );

      if (!insertedTurn) {
        throw new Error("Failed to insert turn.");
      }

      turnId = insertedTurn.id;
    }

    const turn = getTurn(db, input.sessionId, input.promptNumber);

    if (!turn) {
      throw new Error("Failed to reload saved turn.");
    }

    if (status === "extracted") {
      indexTurnToFTS(db, turn);

      for (const observation of input.observations) {
        createObservation(db, {
          turnId,
          toolName: observation.toolName ?? null,
          toolInput: observation.toolInput ?? null,
          toolResult: observation.toolResult ?? null,
          status: observation.status ?? "extracted",
          title: observation.title ?? null,
          content: observation.content ?? null,
          createdAtEpoch: input.updatedAtEpoch ?? input.createdAtEpoch,
        });
      }
    }

    db.exec("COMMIT");

    return turn;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
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
): void {
  db.query(
    `UPDATE turns
     SET assistant_response = ?,
         tool_call_count = ?,
         content_prompt_id = COALESCE(content_prompt_id, ?)
     WHERE id = ?`,
  ).run(assistantResponse, toolCallCount, contentPromptId ?? null, turnId);
}
