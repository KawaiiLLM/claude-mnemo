import type { Database } from "bun:sqlite";

import { countTurnsSince } from "./sessions";
import { SEGMENT_EDITABLE_FIELDS } from "../shared/segment-fields";
import type { SegmentFieldFreshness } from "../shared/segment-maintenance";

/**
 * Per-field maintenance distance, read off the stamps that already exist
 * (`.scratch/memory-guidance/spec.md` D1; ticket 02).
 *
 * NO NEW STATE. `write_gate_stamps`'s primary key is already
 * `(entity_type, entity_id, field)`, so "when was THIS field last written"
 * is a row lookup, and "one write resets only its own field" is not something
 * this module implements — it is what the key already guarantees, because
 * `stampField` writes one row per field written. That is the ticket's whole
 * point and also the thing most easily broken by adding a second counter
 * beside it, so there is none.
 *
 * WHY EPOCHS ARE SAFE HERE, given 0.12.1's peer round retired an epoch anchor
 * for a turn id. That anchor fed a MODULO test (`turnsSince % 20 === 0`), so a
 * turn sharing the write's own second shifted the count by one and the
 * reminder skipped a whole 20-turn window — a miss that never healed. The
 * selector this feeds uses a THRESHOLD (`turnsSince >= interval`, see
 * `selectSegmentMaintenanceReminder`), so the same off-by-one can only delay a
 * reminder by one turn and never suppress it. `write_gate_stamps` carries no
 * turn id to key off instead, and adding one would be the new state this
 * ticket exists to avoid.
 */
export function readSegmentFieldFreshness(
  db: Database,
  segmentId: number,
  sessionId: number,
): SegmentFieldFreshness {
  const stamps = new Map<string, number>();
  for (const row of db
    .query<{ field: string; writtenAtEpoch: number }, [number]>(
      `SELECT field, written_at_epoch AS writtenAtEpoch
         FROM write_gate_stamps
        WHERE entity_type = 'segment' AND entity_id = ?`,
    )
    .all(segmentId)) {
    stamps.set(row.field, row.writtenAtEpoch);
  }

  // A NEVER-WRITTEN FIELD OWES FROM THE SEGMENT'S BIRTH, not from forever.
  // Ticket 01 modelled it as `null`, which its selector ranks `Infinity` — and
  // `Infinity >= interval` is true at turn one, so wiring that reading
  // literally made a freshly created segment demand `constraints` before it
  // had any. Measuring the debt from `created_at_epoch` fixes due-ness AND
  // keeps the ordering ticket 01 wanted for free: an old segment that never
  // wrote the field carries a count as large as its whole life, so it still
  // outranks everything, while a young one is simply not due yet. `null`
  // stays in the type as the "cannot be measured" case; nothing in production
  // produces it any more, which is the honest state — see the note in
  // `.scratch/memory-guidance/`.
  const segmentBirthEpoch =
    db
      .query<{ createdAtEpoch: number }, [number]>(
        "SELECT created_at_epoch AS createdAtEpoch FROM segments WHERE id = ?",
      )
      .get(segmentId)?.createdAtEpoch ?? null;

  const freshness = {} as SegmentFieldFreshness;
  for (const field of SEGMENT_EDITABLE_FIELDS) {
    const anchorEpoch = stamps.get(field) ?? segmentBirthEpoch;
    freshness[field] =
      anchorEpoch === null ? null : countTurnsSince(db, sessionId, anchorEpoch);
  }
  return freshness;
}

/**
 * The most recent write across a segment's own eight fields, or `null` when
 * none has ever been written.
 *
 * The segment card used to measure its "maintenance N turns ago" from
 * `segments.updated_at_epoch`, which every row write bumps — a retag, a status
 * toggle, a facet recompute — so a segment nobody had maintained in 200 turns
 * read as freshly maintained the moment its tag changed. This is the same
 * measure the reminder counts from, so the card and the reminder cannot
 * disagree about whether a segment has been looked after.
 */
export function latestSegmentFieldWriteEpoch(db: Database, segmentId: number): number | null {
  const placeholders = SEGMENT_EDITABLE_FIELDS.map(() => "?").join(",");
  const row = db
    .query<{ latest: number | null }, (number | string)[]>(
      `SELECT MAX(written_at_epoch) AS latest
         FROM write_gate_stamps
        WHERE entity_type = 'segment' AND entity_id = ?
          AND field IN (${placeholders})`,
    )
    .get(segmentId, ...SEGMENT_EDITABLE_FIELDS);
  return row?.latest ?? null;
}
