/**
 * The Working State columns a segment carries beside its summary layer —
 * ADR-0001, ticket 02, NARROWED TO THREE by lane-impressions ticket 05. Each
 * is a markdown row list ("- " rows), uncapped, maintained by the main agent
 * through `remember`.
 *
 * THREE, NOT SIX (user ruling S15069/T2320: 别迁移了，直接删，初始印象不需要任何
 * 特殊机制). `decisions`, `done` and `next_steps` left the product outright:
 * what a task has settled, finished and still owes is what a settlement-
 * maintained IMPRESSION says — a lane's at `recall(id="E<n>/#<tag>")`, the
 * task's in the segment card's own impression row — and three hand-maintained
 * narrative fields were a second, drifting copy of it at the main agent's
 * expense. NOTHING WAS MIGRATED AND NOTHING WAS DELETED: their COLUMNS stay
 * (db/schema.ts), holding whatever text they held, read by nothing and written
 * by nothing. An impression starts EMPTY and settlement writes it the first
 * time it touches one of that task's lanes.
 *
 * One list, shared by `db/segments.ts` (the column/property mapping) and
 * `mcp/definitions.ts` (the `remember` tool's `field` enum), so the storage
 * layer and the write surface cannot describe two different field sets. The
 * literal spelling — snake_case, matching the stored column name exactly —
 * is what a `remember` caller types and what a rendered field label reads.
 */
export const SEGMENT_WORKING_STATE_FIELDS = [
  "goal",
  "constraints",
  "reference",
] as const;

export type SegmentWorkingStateField = (typeof SEGMENT_WORKING_STATE_FIELDS)[number];

/**
 * Every field the main agent may write on a segment: the three Working State
 * fields above plus `insight`, the summary layer's own prose field, under the
 * SAME append/replace write mechanism (ADR-0001; user ruling T821).
 *
 * `title` stays create-only — no ticket asks for it to gain an edit path, and
 * unlike the others it is not a row list but a one-line identity.
 *
 * `content` IS DELIBERATELY ABSENT (lane-impressions ticket 05). That column is
 * the TASK-TIER IMPRESSION's home, and settlement is its sole writer (spec user
 * story 9: "the main agent carries zero impression maintenance"). Leaving it on
 * this list would offer the main agent two ways to lose: writing it while no
 * impression exists puts bytes on a surface that renders none, and writing it
 * after settlement has been there clobbers an impression outside its CAS fence.
 *
 * A SEPARATE constant/type from `SEGMENT_WORKING_STATE_FIELDS` above, not a
 * widening of it in place: `mcp/segment-card.ts` renders that exact list under
 * a "Working State" heading, and `insight` belongs to the summary layer
 * (ADR-0001), a different reader-facing section of the same card.
 */
export const SEGMENT_EDITABLE_FIELDS = [
  ...SEGMENT_WORKING_STATE_FIELDS,
  "insight",
] as const;

export type SegmentEditableField = (typeof SEGMENT_EDITABLE_FIELDS)[number];
