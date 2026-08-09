import type { Database } from "bun:sqlite";

/**
 * P1 shadow store for main-agent notes (spec D1/D12).
 *
 * Deliberately narrow: it writes and reads one table and touches nothing else.
 * No FTS indexing, no turn update, no queue enqueue — the isolation the trial
 * depends on is a property of this module having no other write targets, not of
 * every caller remembering to be careful.
 */

/**
 * Who authored a note. `agent` is the main agent writing up its own turn — the
 * only writer P1 has, and the only one its compliance and blind-pair metrics may
 * count. `settlement` is the P2 settlement pass reconstructing an interior hole
 * in hindsight (spec D9, 裁决 20): a real note about a real turn, but not
 * evidence that the agent wrote it.
 */
export const SHADOW_NOTE_ORIGINS = ["agent", "settlement"] as const;
export type ShadowNoteOrigin = (typeof SHADOW_NOTE_ORIGINS)[number];

/**
 * SQL predicate every P1 measurement puts on `shadow_notes`. The trial measures
 * whether the MAIN AGENT writes its notes, so a settlement-authored hole
 * reconstruction has to be invisible to it: counted, it would report compliance
 * the agent never earned.
 */
export function agentAuthoredNotePredicate(alias = "n"): string {
  return `${alias}.writer_origin = 'agent'`;
}

export interface ShadowNoteRecord {
  turnId: number;
  title: string;
  content: string;
  insight: string | null;
  writerModel: string | null;
  writerOrigin: ShadowNoteOrigin;
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
  /** Omitted → `agent`; only the settlement pass declares otherwise. */
  writerOrigin?: ShadowNoteOrigin;
  rideTurnId?: number | null;
  nowEpoch: number;
}

const SHADOW_NOTE_COLUMNS = `
  turn_id AS turnId,
  title,
  content,
  insight,
  writer_model AS writerModel,
  writer_origin AS writerOrigin,
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
        string,
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
          writer_origin,
          ride_turn_id,
          created_at_epoch,
          updated_at_epoch
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(turn_id) DO UPDATE SET
          title = excluded.title,
          content = excluded.content,
          insight = excluded.insight,
          writer_model = excluded.writer_model,
          writer_origin = excluded.writer_origin,
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
      input.writerOrigin ?? "agent",
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
