import type { Database } from "bun:sqlite";

import { indexObservationToFTS } from "./search";

export interface ObservationRecord {
  id: number;
  turnId: number;
  type: string;
  title: string;
  content: string | null;
  insight: string | null;
  tags: string[];
  filesRead: string[];
  filesModified: string[];
  createdAtEpoch: number;
}

export interface CreateObservationInput {
  turnId: number;
  type: string;
  title: string;
  content?: string | null;
  insight?: string | null;
  tags?: string[];
  filesRead?: string[];
  filesModified?: string[];
  createdAtEpoch: number;
}

interface ObservationRow {
  id: number;
  turnId: number;
  type: string;
  title: string;
  content: string | null;
  insight: string | null;
  tags: string | null;
  filesRead: string | null;
  filesModified: string | null;
  createdAtEpoch: number;
}

const OBSERVATION_SELECT = `
  SELECT
    id,
    turn_id AS turnId,
    type,
    title,
    content,
    insight,
    tags,
    files_read AS filesRead,
    files_modified AS filesModified,
    created_at_epoch AS createdAtEpoch
  FROM observations
`;

function parseJsonArray(value: string | null): string[] {
  if (!value) {
    return [];
  }

  return JSON.parse(value) as string[];
}

function stringifyJsonArray(values: string[]): string {
  return JSON.stringify(values);
}

function mapObservationRow(row: ObservationRow | null): ObservationRecord | null {
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

export function createObservation(
  db: Database,
  input: CreateObservationInput,
): ObservationRecord {
  const inserted = db
    .query<
      ObservationRow,
      [number, string, string, string | null, string | null, string, string, string, number]
    >(
      `
        INSERT INTO observations (
          turn_id,
          type,
          title,
          content,
          insight,
          tags,
          files_read,
          files_modified,
          created_at_epoch
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING
          id,
          turn_id AS turnId,
          type,
          title,
          content,
          insight,
          tags,
          files_read AS filesRead,
          files_modified AS filesModified,
          created_at_epoch AS createdAtEpoch
      `,
    )
    .get(
      input.turnId,
      input.type,
      input.title,
      input.content ?? null,
      input.insight ?? null,
      stringifyJsonArray(input.tags ?? []),
      stringifyJsonArray(input.filesRead ?? []),
      stringifyJsonArray(input.filesModified ?? []),
      input.createdAtEpoch,
    );

  const observation = mapObservationRow(inserted);

  if (!observation) {
    throw new Error("Failed to create observation.");
  }

  indexObservationToFTS(db, observation);

  return observation;
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
