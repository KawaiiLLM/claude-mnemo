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
  /** 1 = captured for the raw axis but withheld from extraction. */
  excludedFromExtraction: number;
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
  excludedFromExtraction?: boolean;
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
  excludedFromExtraction: number;
  createdAtEpoch: number;
}

const OBSERVATION_COLUMNS = `
  id,
  turn_id AS turnId,
  tool_name AS toolName,
  tool_input AS toolInput,
  tool_result AS toolResult,
  status,
  title,
  content,
  excluded_from_extraction AS excludedFromExtraction,
  created_at_epoch AS createdAtEpoch
`;

const OBSERVATION_SELECT = `
  SELECT ${OBSERVATION_COLUMNS}
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
          excluded_from_extraction,
          created_at_epoch
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING ${OBSERVATION_COLUMNS}
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
      input.excludedFromExtraction ? 1 : 0,
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
          RETURNING ${OBSERVATION_COLUMNS}
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

/**
 * Observations the extraction pipeline is allowed to read as work content.
 * Excluded rows stay in the table for the raw axis but are invisible here, so
 * the turn's tool aggregation and file sets cannot count a `note` call.
 */
export function getExtractableObservationsForTurn(
  db: Database,
  turnId: number,
): ObservationRecord[] {
  return db
    .query<ObservationRow, [number]>(
      `${OBSERVATION_SELECT} WHERE turn_id = ? AND excluded_from_extraction = 0 ORDER BY id ASC`,
    )
    .all(turnId)
    .map((row) => mapObservationRow(row))
    .filter((observation): observation is ObservationRecord => observation !== null);
}

// A turn has at least one skipped observation iff a mini-turn for it was
// already delivered (obs are skipped only by applyMiniTurnSideEffects). This
// survives a worker restart (recoverFromCrash resets queue claims, not obs
// status), so it is the durable "already streamed/delivered" signal.
//
// Excluded rows are filtered out: they never entered the queue, but the terminal
// finalizers retire every *pending* observation on a turn wholesale, so an
// excluded row would otherwise flip to 'skipped' and forge this signal for a
// turn no mini-turn was ever built for.
export function hasSkippedObservationsForTurn(
  db: Database,
  turnId: number,
): boolean {
  const row = db
    .query<{ count: number }, [number]>(
      `SELECT COUNT(*) AS count FROM observations
       WHERE turn_id = ? AND status = 'skipped' AND excluded_from_extraction = 0`,
    )
    .get(turnId);
  return (row?.count ?? 0) > 0;
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
