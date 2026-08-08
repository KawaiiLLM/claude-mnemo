import type { Database } from "bun:sqlite";

/**
 * P1 shadow store for main-agent notes (spec D1/D12).
 *
 * Deliberately narrow: it writes and reads one table and touches nothing else.
 * No FTS indexing, no turn update, no queue enqueue — the isolation the trial
 * depends on is a property of this module having no other write targets, not of
 * every caller remembering to be careful.
 */

export interface ShadowNoteRecord {
  turnId: number;
  title: string;
  content: string;
  insight: string | null;
  writerModel: string | null;
  rideTurnId: number | null;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

export interface UpsertShadowNoteInput {
  turnId: number;
  title: string;
  content: string;
  insight?: string | null;
  writerModel?: string | null;
  rideTurnId?: number | null;
  nowEpoch: number;
}

const SHADOW_NOTE_COLUMNS = `
  turn_id AS turnId,
  title,
  content,
  insight,
  writer_model AS writerModel,
  ride_turn_id AS rideTurnId,
  created_at_epoch AS createdAtEpoch,
  updated_at_epoch AS updatedAtEpoch
`;

/**
 * Write-or-replace a turn's note. `created_at_epoch` survives a rewrite (it is
 * when the turn was FIRST noted, a fact about note latency the trial measures),
 * while every authored field and every mechanical field is replaced — a rewrite
 * that kept a stale writer_model or ride_turn would attribute the new text to
 * the old author.
 */
export function upsertShadowNote(
  db: Database,
  input: UpsertShadowNoteInput,
): ShadowNoteRecord {
  const written = db
    .query<
      ShadowNoteRecord,
      [
        number,
        string,
        string,
        string | null,
        string | null,
        number | null,
        number,
        number,
      ]
    >(
      `
        INSERT INTO shadow_notes (
          turn_id,
          title,
          content,
          insight,
          writer_model,
          ride_turn_id,
          created_at_epoch,
          updated_at_epoch
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(turn_id) DO UPDATE SET
          title = excluded.title,
          content = excluded.content,
          insight = excluded.insight,
          writer_model = excluded.writer_model,
          ride_turn_id = excluded.ride_turn_id,
          updated_at_epoch = excluded.updated_at_epoch
        RETURNING ${SHADOW_NOTE_COLUMNS}
      `,
    )
    .get(
      input.turnId,
      input.title,
      input.content,
      input.insight ?? null,
      input.writerModel ?? null,
      input.rideTurnId ?? null,
      input.nowEpoch,
      input.nowEpoch,
    );

  if (!written) {
    throw new Error(`Failed to write shadow note for turn ${input.turnId}.`);
  }

  return written;
}

export function getShadowNote(
  db: Database,
  turnId: number,
): ShadowNoteRecord | null {
  return (
    db
      .query<ShadowNoteRecord, [number]>(
        `SELECT ${SHADOW_NOTE_COLUMNS} FROM shadow_notes WHERE turn_id = ?`,
      )
      .get(turnId) ?? null
  );
}

export function countShadowNotes(db: Database): number {
  return (
    db
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM shadow_notes")
      .get()?.count ?? 0
  );
}
