import type { Database } from "bun:sqlite";

import { createObservation } from "./observations";
import { indexTurnToFTS } from "./search";

export interface ObservationInput {
  type: string;
  title: string;
  content?: string | null;
  description?: string | null;
  insight?: string | null;
  narrative?: string | null;
  facts?: string[];
  tags?: string[];
  concepts?: string[];
  filesRead: string[];
  filesModified: string[];
}

export interface SaveTurnInput {
  sessionId: number;
  promptNumber: number;
  status?: "undone";
  userPrompt: string | null;
  assistantResponse: string | null;
  title: string | null;
  content?: string | null;
  description?: string | null;
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
  content: string | null;
  description: string | null;
  insight: string | null;
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
  status: string;
  userPrompt: string | null;
  assistantResponse: string | null;
  title: string | null;
  content: string | null;
  description: string | null;
  insight: string | null;
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
    status,
    user_prompt AS userPrompt,
    assistant_response AS assistantResponse,
    title,
    COALESCE(content, description) AS content,
    COALESCE(content, description) AS description,
    insight,
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

function resolveTurnContent(input: Pick<SaveTurnInput, "content" | "description">): string | null {
  return input.content ?? input.description ?? null;
}

function resolveObservationContent(
  observation: Pick<ObservationInput, "content" | "description">,
): string | null {
  return observation.content ?? observation.description ?? null;
}

function resolveObservationTags(
  observation: Pick<ObservationInput, "tags" | "concepts">,
): string[] {
  return observation.tags ?? observation.concepts ?? [];
}

function resolveObservationInsight(
  observation: Pick<ObservationInput, "insight" | "narrative" | "facts">,
): string | null {
  if (observation.insight) {
    return observation.insight;
  }

  const facts = observation.facts ?? [];

  if (observation.narrative && facts.length > 0) {
    return [observation.narrative, ...facts].join("\n");
  }

  return observation.narrative ?? (facts.length > 0 ? facts.join("\n") : null);
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
  const content = resolveTurnContent(input);
  return Boolean(
    input.title ||
      content ||
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
  const content = resolveTurnContent(input);

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
        content,
        content,
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
            description,
            insight,
            files_read,
            files_modified,
            created_at_epoch,
            updated_at_epoch
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          RETURNING id
        `)
        .get(
          input.sessionId,
          input.promptNumber,
          status,
          input.userPrompt,
          input.assistantResponse,
          input.title,
          content,
          content,
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

      for (const observation of input.observations) {
        createObservation(db, {
          turnId,
          type: observation.type,
          title: observation.title,
          content: resolveObservationContent(observation),
          description: resolveObservationContent(observation),
          insight: resolveObservationInsight(observation),
          narrative: observation.narrative ?? resolveObservationInsight(observation),
          facts: observation.facts ?? [],
          tags: resolveObservationTags(observation),
          concepts: resolveObservationTags(observation),
          filesRead: observation.filesRead,
          filesModified: observation.filesModified,
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

export function updateTurnBackfill(
  db: Database,
  turnId: number,
  assistantResponse: string,
  toolCallCount: number,
): void {
  db.query(
    `UPDATE turns
     SET assistant_response = ?,
         tool_call_count = ?
     WHERE id = ?`,
  ).run(assistantResponse, toolCallCount, turnId);
}
