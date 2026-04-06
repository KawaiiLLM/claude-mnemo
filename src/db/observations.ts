import type { Database } from "bun:sqlite";

export interface ObservationRecord {
  id: number;
  turnId: number;
  type: string;
  title: string;
  description: string | null;
  narrative: string | null;
  facts: string[];
  concepts: string[];
  filesRead: string[];
  filesModified: string[];
  createdAtEpoch: number;
}

interface ObservationRow {
  id: number;
  turnId: number;
  type: string;
  title: string;
  description: string | null;
  narrative: string | null;
  facts: string | null;
  concepts: string | null;
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
    description,
    narrative,
    facts,
    concepts,
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

function mapObservationRow(row: ObservationRow | null): ObservationRecord | null {
  if (!row) {
    return null;
  }

  return {
    ...row,
    facts: parseJsonArray(row.facts),
    concepts: parseJsonArray(row.concepts),
    filesRead: parseJsonArray(row.filesRead),
    filesModified: parseJsonArray(row.filesModified),
  };
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
