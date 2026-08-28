import type { Database } from "bun:sqlite";

/**
 * `phase_retype_audits` (phase-connectivity ticket 01, spec "Compound-retype
 * is not a free pass"): the persistent record a compound retype owes —
 * `{job, turn, old_types, new_types, basis_word, reason}`, a structured slot
 * rather than a line in `commit`'s transient report. Written from
 * `worker/note-settlement-turn-facade.ts`, the one place a turn's `type`
 * field actually lands.
 */
export interface PhaseRetypeAuditRecord {
  jobId: number;
  turnId: number;
  oldTypes: readonly string[];
  newTypes: readonly string[];
  basisWord: string;
  reason: string;
  createdAtEpoch: number;
}

export function recordPhaseRetypeAudit(db: Database, record: PhaseRetypeAuditRecord): void {
  db.query(
    `INSERT INTO phase_retype_audits
       (job_id, turn_id, old_types, new_types, basis_word, reason, created_at_epoch)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.jobId,
    record.turnId,
    JSON.stringify(record.oldTypes),
    JSON.stringify(record.newTypes),
    record.basisWord,
    record.reason,
    record.createdAtEpoch,
  );
}

export interface PhaseRetypeAuditRow extends PhaseRetypeAuditRecord {
  id: number;
}

interface PhaseRetypeAuditDbRow {
  id: number;
  jobId: number;
  turnId: number;
  oldTypes: string;
  newTypes: string;
  basisWord: string;
  reason: string;
  createdAtEpoch: number;
}

/** Every retype audit row for one turn, ascending by id — test/inspection surface. */
export function loadPhaseRetypeAuditsForTurn(db: Database, turnId: number): PhaseRetypeAuditRow[] {
  return db
    .query<PhaseRetypeAuditDbRow, [number]>(
      `SELECT id, job_id AS jobId, turn_id AS turnId, old_types AS oldTypes,
              new_types AS newTypes, basis_word AS basisWord, reason, created_at_epoch AS createdAtEpoch
       FROM phase_retype_audits WHERE turn_id = ? ORDER BY id ASC`,
    )
    .all(turnId)
    .map((row) => ({
      id: row.id,
      jobId: row.jobId,
      turnId: row.turnId,
      oldTypes: JSON.parse(row.oldTypes) as string[],
      newTypes: JSON.parse(row.newTypes) as string[],
      basisWord: row.basisWord,
      reason: row.reason,
      createdAtEpoch: row.createdAtEpoch,
    }));
}
