import type { Database } from "bun:sqlite";

import { createObservation } from "../../src/db/observations";
import { indexTurnToFTS } from "../../src/db/search";
import { getTurn, type TurnRecord } from "../../src/db/turns";

export interface ObservationFixtureInput {
  toolName?: string | null;
  toolInput?: string | null;
  toolResult?: string | null;
  status?: "pending" | "extracted" | "skipped";
  title?: string | null;
  content?: string | null;
}

export interface SaveTurnFixtureInput {
  sessionId: number;
  promptNumber: number;
  status?: "undone";
  userPrompt: string | null;
  assistantResponse: string | null;
  title: string | null;
  content?: string | null;
  insight: string | null;
  // Multi-valued in storage since ticket 02 (spec B5) — `turns.type` is now
  // `NOT NULL DEFAULT '[]'`. A single string is accepted as a convenience
  // (every pre-ticket-02 fixture call site passes one) and normalized to a
  // one-element array, matching exactly how the migration wraps a legacy
  // scalar; `null`/undefined/`[]` all normalize to `[]`.
  type?: string | string[] | null;
  tags?: string[];
  filesRead: string[];
  filesModified: string[];
  createdAtEpoch: number;
  updatedAtEpoch: number | null;
  observations: ObservationFixtureInput[];
}

function normalizeTypeInput(value: string | string[] | null | undefined): string[] {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function stringifyArray(values: string[]): string {
  return JSON.stringify(values);
}

function hasExtractedContent(input: SaveTurnFixtureInput): boolean {
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

export function saveTurnFixture(
  db: Database,
  input: SaveTurnFixtureInput,
): TurnRecord {
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
    const type = stringifyArray(normalizeTypeInput(input.type));

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
        type,
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
            string,
            string,
            string,
            string,
            number,
            number | null,
          ]
        >(
          `INSERT INTO turns (
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
           RETURNING id`,
        )
        .get(
          input.sessionId,
          input.promptNumber,
          status,
          input.userPrompt,
          input.assistantResponse,
          input.title,
          input.content ?? null,
          input.insight,
          type,
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

    // Status-blind, like the production capture path (spec D11): a turn is in
    // the index because it was captured, not because it was extracted.
    indexTurnToFTS(db, turn);

    if (status === "extracted") {
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
