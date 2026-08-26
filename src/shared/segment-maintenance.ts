import { SEGMENT_EDITABLE_FIELDS, type SegmentEditableField } from "./segment-fields";

/**
 * Per-field segment maintenance reminders (`.scratch/memory-guidance/spec.md`
 * D2/D3/D4; ticket 01, `.scratch/memory-guidance/issues/01-per-field-reminder-selector.md`).
 *
 * WHY THIS EXISTS. The reminder that shipped before this ticket forwarded
 * judgment to the Memory Rubric ("judgment lives in the Memory Rubric, not
 * here") — but the rubric's action principles (measured at 6060 characters)
 * hold no section on constraints, Working State, or maintenance at all. A
 * reader sent there finds nothing and falls back to a field list that says
 * what each field HOLDS, not what DESERVES to be written down. The measured
 * cost of that gap: in one real session the only rules that changed the
 * agent's behaviour came from injected `constraints` rows, while a lesson
 * ("never `git restore`") written into five worker briefs never reached that
 * field and died with the session — nothing had ever told the agent THAT
 * field was where it belonged. So the criterion for each field has to travel
 * WITH the reminder, not through a pointer to a document that does not carry
 * it. This module is that text.
 *
 * A single global "20 turns since anything was written" timer also trains its
 * reader to ignore the channel: `goal` sitting untouched for a long stretch
 * is the CORRECT state for a stable task, and a reminder that fires without
 * cause discredits the reminders that do have one (D2). So the timer is
 * PER FIELD, tiered by how often each field is expected to move (D2), only
 * the single most-overdue field is ever surfaced at once — injection is
 * budgeted, and six reminders persuade less than one (D4) — and a field that
 * has never been written ranks as owing the MOST, never as freshly written
 * (a naive zero-default would permanently silence it).
 *
 * PURE FUNCTION, unwired. No database import, no clock read: "turns since
 * last write" is supplied by the caller (`write_gate_stamps`, per D1, is the
 * existing source ticket 02 will read it from). Nothing in `src/` calls this
 * module yet — reading the real stamps and rendering this into a hook slot is
 * ticket 02's job, deliberately kept separate from this one.
 */

// ---------------------------------------------------------------------------
// D2 — three tiers. Numbers are a JUDGMENT call (spec: "数字是判断,不是测量"),
// re-tunable after real trigger-frequency data comes in; the STRUCTURE (three
// tiers, high < mid < low) is the part this ticket pins.
// ---------------------------------------------------------------------------

/** `next_steps` / `constraints` / `decisions` — live state, changes daily. */
export const SEGMENT_MAINTENANCE_HIGH_FREQUENCY_INTERVAL_TURNS = 20;

/** `done` / `content` / `insight` — settles in stages, not every turn. */
export const SEGMENT_MAINTENANCE_MID_FREQUENCY_INTERVAL_TURNS = 60;

/** `reference` / `goal` — long-lived anchors; silence here is normal. */
export const SEGMENT_MAINTENANCE_LOW_FREQUENCY_INTERVAL_TURNS = 120;

/**
 * The one map every other function in this file reads its tier boundary
 * from. Collapsing two of the three interval CONSTANTS above to the same
 * number collapses this map's tiering too (it is built from those constants,
 * not a second hard-coded copy) — the failure mode `selectSegmentMaintenanceReminder`'s
 * own tests pin: with two tiers merged, the field with the largest raw turn
 * count wins regardless of which tier it belongs to, which is exactly the
 * "single interval" bug D2 exists to prevent.
 */
export const SEGMENT_FIELD_MAINTENANCE_INTERVAL_TURNS: Readonly<
  Record<SegmentEditableField, number>
> = {
  next_steps: SEGMENT_MAINTENANCE_HIGH_FREQUENCY_INTERVAL_TURNS,
  constraints: SEGMENT_MAINTENANCE_HIGH_FREQUENCY_INTERVAL_TURNS,
  decisions: SEGMENT_MAINTENANCE_HIGH_FREQUENCY_INTERVAL_TURNS,
  done: SEGMENT_MAINTENANCE_MID_FREQUENCY_INTERVAL_TURNS,
  content: SEGMENT_MAINTENANCE_MID_FREQUENCY_INTERVAL_TURNS,
  insight: SEGMENT_MAINTENANCE_MID_FREQUENCY_INTERVAL_TURNS,
  reference: SEGMENT_MAINTENANCE_LOW_FREQUENCY_INTERVAL_TURNS,
  goal: SEGMENT_MAINTENANCE_LOW_FREQUENCY_INTERVAL_TURNS,
};

// ---------------------------------------------------------------------------
// D3 — the criterion travels with the reminder. One sentence per field
// answering "what makes THIS worth writing", not "what this field holds"
// (that list already exists on `remember`'s own `.describe()` in
// `mcp/definitions.ts` and is not duplicated here). `constraints` additionally
// carries the three-way split this batch's whole product is: the judgment
// nobody was routing anywhere.
//
// The split's third leg ("holds only for this turn") names a DIFFERENT
// field than the one this reminder is about: the per-turn `insight` a `note`
// call writes on the CURRENT turn, not this module's own `insight` tier
// (SEGMENT_EDITABLE_FIELDS carries both, on two different entities, under
// the same name — see segment-fields.ts). The text says "via note" so the
// two are never read as the same field.
// ---------------------------------------------------------------------------

const CONSTRAINTS_CRITERION =
  "write it when this turn's takeaway will hold again in THIS PROJECT, not only for this task — " +
  "route whatever you are about to write by how far it reaches:\n" +
  "  holds again in this project  -> constraints\n" +
  "  holds only for this task     -> decisions\n" +
  "  holds only for this turn     -> stays in that turn's own insight (via note) — do not promote it here";

const SEGMENT_FIELD_MAINTENANCE_CRITERIA: Readonly<Record<SegmentEditableField, string>> = {
  goal: "write it when the task's real target has shifted or sharpened, not to reconfirm one that " +
    "still holds — long silence here is the correct state for a target that has not moved.",
  constraints: CONSTRAINTS_CRITERION,
  decisions: "write it when a ruling about THIS task gets settled and binding — true for this task, " +
    "not claimed to reach beyond it.",
  done: "write it when a piece of work is actually finished and verified, not merely attempted.",
  next_steps: "write it the moment what is waiting to be done changes — a new item queued, or a stale " +
    "one that should drop off.",
  reference: "write it when a new durable pointer appears — a source location, spec, PR, or URL worth " +
    "finding again later, not a plan or an intention.",
  content: "write it when the arc's overall impression should change — what this whole task is about " +
    "and how it is going — not a rehash of the latest turn.",
  insight: "write it when a lesson outlives this task itself — something a later, different task should " +
    "already know.",
};

// ---------------------------------------------------------------------------
// The input: field -> turns since its last write, `null` for never written.
// ---------------------------------------------------------------------------

/**
 * A TOTAL map — every one of the eight fields must be present, `null`
 * standing for "no stamp exists" (never written on this segment; D2's
 * "owes the most" case, see `overdueRank` below). This is deliberately not
 * `Partial`: an omitted key inviting silent "treat as fresh" or silent
 * "treat as never written" is exactly the ambiguity D2's rule exists to
 * rule out, so the type forces the caller (ticket 02, reading
 * `write_gate_stamps`) to say which one it means for every field, rather
 * than leaving a gap either reading could fill.
 */
export type SegmentFieldFreshness = Record<SegmentEditableField, number | null>;

export interface SegmentMaintenanceReminder {
  readonly field: SegmentEditableField;
  readonly text: string;
}

/**
 * D2's "never written" rule: a field with no stamp ranks as MORE overdue than
 * any finite turn count, never as zero. `Infinity` rather than some large
 * finite sentinel — it needs no calibration against real turn counts and it
 * cannot ever be tied by a legitimate value.
 */
function overdueRank(turnsSinceWrite: number | null): number {
  return turnsSinceWrite === null ? Number.POSITIVE_INFINITY : turnsSinceWrite;
}

/**
 * Every field sharing one tier interval, filtered to the ones actually due
 * (D2: due once turns-since-write reaches the tier's interval; never-written
 * is always due), then D4's within-tier tie-break: the most overdue one,
 * ties broken by `SEGMENT_EDITABLE_FIELDS`'s own declared order so the
 * result is deterministic without depending on object key iteration order.
 */
function mostOverdueDueFieldAtInterval(
  freshness: SegmentFieldFreshness,
  intervalTurns: number,
): { field: SegmentEditableField; turnsSinceWrite: number | null } | null {
  let best: { field: SegmentEditableField; turnsSinceWrite: number | null; rank: number } | null =
    null;

  for (const field of SEGMENT_EDITABLE_FIELDS) {
    if (SEGMENT_FIELD_MAINTENANCE_INTERVAL_TURNS[field] !== intervalTurns) {
      continue;
    }
    const turnsSinceWrite = freshness[field];
    const rank = overdueRank(turnsSinceWrite);
    if (rank < intervalTurns) {
      continue; // not due yet
    }
    if (best === null || rank > best.rank) {
      best = { field, turnsSinceWrite, rank };
    }
  }

  return best === null ? null : { field: best.field, turnsSinceWrite: best.turnsSinceWrite };
}

function renderFieldMaintenanceText(
  field: SegmentEditableField,
  turnsSinceWrite: number | null,
): string {
  const status =
    turnsSinceWrite === null
      ? `${field} has never been written on this segment`
      : `${field} has gone ${turnsSinceWrite} turn${turnsSinceWrite === 1 ? "" : "s"} without a write`;
  return `mnemo segment maintenance: ${status} — ${SEGMENT_FIELD_MAINTENANCE_CRITERIA[field]}`;
}

/**
 * D4 — one reminder per call, never a list. Scans tiers high -> mid -> low
 * (ascending interval; deduped, so collapsing two tier constants to the same
 * number correctly collapses them into one scan group rather than two) and
 * returns the first tier that has any due field, picking that tier's most
 * overdue one. A field belonging to a lower-priority tier is never reported
 * while a higher tier still has anything due — the six-fields-due case this
 * exists for reports exactly one, and it is always from the highest tier
 * that has anything owing.
 *
 * Returns `null` when nothing is due — "no need to remind", not an empty
 * reminder.
 */
export function selectSegmentMaintenanceReminder(
  freshness: SegmentFieldFreshness,
): SegmentMaintenanceReminder | null {
  const intervalsAscending = Array.from(
    new Set(SEGMENT_EDITABLE_FIELDS.map((field) => SEGMENT_FIELD_MAINTENANCE_INTERVAL_TURNS[field])),
  ).sort((a, b) => a - b);

  for (const intervalTurns of intervalsAscending) {
    const due = mostOverdueDueFieldAtInterval(freshness, intervalTurns);
    if (due !== null) {
      return { field: due.field, text: renderFieldMaintenanceText(due.field, due.turnsSinceWrite) };
    }
  }

  return null;
}
