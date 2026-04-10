import type { Database } from "bun:sqlite";

import { indexObservationToFTS } from "./search";

export interface ObservationRecord {
  id: number;
  turnId: number;
  toolName: string | null;
  toolInput: string | null;
  toolResult: string | null;
  status: "pending" | "extracted" | "skipped";
  title: string | null;
  content: string | null;
  createdAtEpoch: number;
}

export interface CreateObservationInput {
  turnId: number;
  toolName?: string | null;
  toolInput?: string | null;
  toolResult?: string | null;
  status?: "pending" | "extracted" | "skipped";
  title?: string | null;
  content?: string | null;
  createdAtEpoch: number;
}

interface ObservationRow {
  id: number;
  turnId: number;
  toolName: string | null;
  toolInput: string | null;
  toolResult: string | null;
  status: "pending" | "extracted" | "skipped";
  title: string | null;
  content: string | null;
  createdAtEpoch: number;
}

const OBSERVATION_SELECT = `
  SELECT
    id,
    turn_id AS turnId,
    tool_name AS toolName,
    tool_input AS toolInput,
    tool_result AS toolResult,
    status,
    title,
    content,
    created_at_epoch AS createdAtEpoch
  FROM observations
`;

function mapObservationRow(row: ObservationRow | null): ObservationRecord | null {
  if (!row) {
    return null;
  }

  return row;
}

export function createObservation(
  db: Database,
  input: CreateObservationInput,
): ObservationRecord {
  const inserted = db
    .query<
      ObservationRow,
      [
        number,
        string | null,
        string | null,
        string | null,
        "pending" | "extracted" | "skipped",
        string | null,
        string | null,
        number,
      ]
    >(
      `
        INSERT INTO observations (
          turn_id,
          tool_name,
          tool_input,
          tool_result,
          status,
          title,
          content,
          created_at_epoch
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING
          id,
          turn_id AS turnId,
          tool_name AS toolName,
          tool_input AS toolInput,
          tool_result AS toolResult,
          status,
          title,
          content,
          created_at_epoch AS createdAtEpoch
      `,
    )
    .get(
      input.turnId,
      input.toolName ?? null,
      input.toolInput ?? null,
      input.toolResult ?? null,
      input.status ?? "pending",
      input.title ?? null,
      input.content ?? null,
      input.createdAtEpoch,
    );

  const observation = mapObservationRow(inserted);

  if (!observation) {
    throw new Error("Failed to create observation.");
  }

  if (observation.status === "extracted") {
    indexObservationToFTS(db, observation);
  }

  return observation;
}

export interface UpdateObservationInput {
  title?: string;
  content?: string | null;
  status?: "pending" | "extracted" | "skipped";
}

export function updateObservation(
  db: Database,
  observationId: number,
  input: UpdateObservationInput,
): ObservationRecord | null {
  const existing = getObservation(db, observationId);

  if (!existing) {
    return null;
  }

  const updated = mapObservationRow(
    db
      .query<
        ObservationRow,
        [string | null, string | null, "pending" | "extracted" | "skipped", number]
      >(
        `
          UPDATE observations
          SET
            title = ?,
            content = ?,
            status = ?
          WHERE id = ?
          RETURNING
            id,
            turn_id AS turnId,
            tool_name AS toolName,
            tool_input AS toolInput,
            tool_result AS toolResult,
            status,
            title,
            content,
            created_at_epoch AS createdAtEpoch
        `,
      )
      .get(
        input.title ?? existing.title,
        input.content ?? existing.content,
        input.status ?? existing.status,
        observationId,
      ) ?? null,
  );

  if (!updated) {
    return null;
  }

  if (updated.status === "extracted") {
    indexObservationToFTS(db, updated);
  } else {
    db.query(
      "DELETE FROM memory_fts WHERE layer = 'observation' AND source_id = ?",
    ).run(observationId);
  }

  return updated;
}

export function getObservationsForTurn(
  db: Database,
  turnId: number,
): ObservationRecord[] {
  return db
    .query<ObservationRow, [number]>(
      `${OBSERVATION_SELECT} WHERE turn_id = ? ORDER BY id ASC`,
    )
    .all(turnId)
    .map((row) => mapObservationRow(row))
    .filter((observation): observation is ObservationRecord => observation !== null);
}

export function getObservation(
  db: Database,
  observationId: number,
): ObservationRecord | null {
  return mapObservationRow(
    db
      .query<ObservationRow, [number]>(`${OBSERVATION_SELECT} WHERE id = ?`)
      .get(observationId) ?? null,
  );
}
