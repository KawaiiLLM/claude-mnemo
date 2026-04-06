import type { Database } from "bun:sqlite";

import { indexObservationToFTS, indexTurnToFTS } from "./search";

export interface ObservationInput {
  type: string;
  title: string;
  description: string | null;
  narrative: string | null;
  facts: string[];
  concepts: string[];
  filesRead: string[];
  filesModified: string[];
}

export interface SaveTurnInput {
  sessionId: number;
  promptNumber: number;
  userPrompt: string | null;
  assistantResponse: string | null;
  title: string | null;
  description: string | null;
  insight: string | null;
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
  status: string;
  userPrompt: string | null;
  assistantResponse: string | null;
  title: string | null;
  description: string | null;
  insight: string | null;
  filesRead: string[];
  filesModified: string[];
  createdAtEpoch: number;
  updatedAtEpoch: number | null;
}

interface TurnRow {
  id: number;
  sessionId: number;
  promptNumber: number;
  status: string;
  userPrompt: string | null;
  assistantResponse: string | null;
  title: string | null;
  description: string | null;
  insight: string | null;
  filesRead: string | null;
  filesModified: string | null;
  createdAtEpoch: number;
  updatedAtEpoch: number | null;
}

const TURN_SELECT = `
  SELECT
    id,
    session_id AS sessionId,
    prompt_number AS promptNumber,
    status,
    user_prompt AS userPrompt,
    assistant_response AS assistantResponse,
    title,
    description,
    insight,
    files_read AS filesRead,
    files_modified AS filesModified,
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
    filesRead: parseJsonArray(row.filesRead),
    filesModified: parseJsonArray(row.filesModified),
  };
}

function hasExtractedContent(input: SaveTurnInput): boolean {
  return Boolean(
    input.title ||
      input.description ||
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
  const status = hasExtractedContent(input) ? "extracted" : "skipped";

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
             description = ?,
             insight = ?,
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
        input.description,
        input.insight,
        filesRead,
        filesModified,
        input.createdAtEpoch,
        input.updatedAtEpoch,
        existingTurn.id,
      );

      turnId = existingTurn.id;
    } else {
      const insertedTurn = db
        .query<{ id: number }, [number, number, string, string | null, string | null, string | null, string | null, string | null, string, string, number, number | null]>(`
          INSERT INTO turns (
            session_id,
            prompt_number,
            status,
            user_prompt,
            assistant_response,
            title,
            description,
            insight,
            files_read,
            files_modified,
            created_at_epoch,
            updated_at_epoch
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          RETURNING id
        `)
        .get(
          input.sessionId,
          input.promptNumber,
          status,
          input.userPrompt,
          input.assistantResponse,
          input.title,
          input.description,
          input.insight,
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

      const insertObservationStatement = db.query<
        { id: number },
        [number, string, string, string | null, string | null, string, string, string, string, number]
      >(`
        INSERT INTO observations (
          turn_id,
          type,
          title,
          description,
          narrative,
          facts,
          concepts,
          files_read,
          files_modified,
          created_at_epoch
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING id
      `);

      for (const observation of input.observations) {
        const insertedObservation = insertObservationStatement.get(
          turnId,
          observation.type,
          observation.title,
          observation.description,
          observation.narrative,
          stringifyArray(observation.facts),
          stringifyArray(observation.concepts),
          stringifyArray(observation.filesRead),
          stringifyArray(observation.filesModified),
          input.updatedAtEpoch ?? input.createdAtEpoch,
        );

        if (!insertedObservation) {
          throw new Error("Failed to insert observation.");
        }

        indexObservationToFTS(db, {
          id: insertedObservation.id,
          title: observation.title,
          description: observation.description,
          narrative: observation.narrative,
          facts: observation.facts,
          concepts: observation.concepts,
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

export function getTurnById(db: Database, turnId: number): TurnRecord | null {
  return mapTurnRow(
    db.query<TurnRow, [number]>(`${TURN_SELECT} WHERE id = ?`).get(turnId) ??
      null,
  );
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

export function getPendingTurns(
  db: Database,
  sessionId: number,
): TurnRecord[] {
  return db
    .query<TurnRow, [number]>(
      `${TURN_SELECT} WHERE session_id = ? AND status IN ('pending', 'stale') ORDER BY prompt_number ASC`,
    )
    .all(sessionId)
    .map((row) => mapTurnRow(row))
    .filter((turn): turn is TurnRecord => turn !== null);
}

export function markTurnsStale(
  db: Database,
  sessionId: number,
  promptNumbers: number[],
): void {
  if (promptNumbers.length === 0) {
    return;
  }

  const placeholders = promptNumbers.map(() => "?").join(", ");

  const now = Math.floor(Date.now() / 1000);

  db.query(
    `UPDATE turns
     SET status = 'stale', updated_at_epoch = ?
     WHERE session_id = ?
       AND prompt_number IN (${placeholders})
       AND status IN ('extracted', 'skipped')`,
  ).run(now, sessionId, ...promptNumbers);
}
