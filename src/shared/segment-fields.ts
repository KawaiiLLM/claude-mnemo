/**
 * The six Working State columns a segment carries beside its summary trio
 * (title/content/insight) — ADR-0001, ticket 02. Each is a markdown row list
 * ("- " rows), uncapped, maintained by the main agent through `remember`.
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
  "decisions",
  "done",
  "next_steps",
  "reference",
] as const;

export type SegmentWorkingStateField = (typeof SEGMENT_WORKING_STATE_FIELDS)[number];

/**
 * Ticket 05 (ADR-0001: "All fields are markdown row lists, edited by append
 * and replace(old,new)"; user ruling T821/"所有字段都是主 agent 维护，
 * remember 工具支持所有字段的不同模式的编辑"): `content`/`insight` — the
 * summary layer's own two prose fields beside `title` — join the six Working
 * State fields under the SAME append/replace write mechanism. `title` stays
 * create-only; no ticket asks for it to gain an edit path, and unlike the
 * other eight it is not a row list but a one-line identity.
 *
 * A SEPARATE constant/type from `SEGMENT_WORKING_STATE_FIELDS` above, not a
 * widening of it in place: `mcp/segment-card.ts` renders that exact list's
 * six entries under a "Working State" heading, and content/insight belong to
 * the summary layer (ADR-0001), a different reader-facing section of the
 * same card. Widening the six-field list itself would silently relabel
 * content/insight as Working State on the card. This list is for `remember`'s
 * own write-surface field enum only.
 */
export const SEGMENT_EDITABLE_FIELDS = [
  ...SEGMENT_WORKING_STATE_FIELDS,
  "content",
  "insight",
] as const;

export type SegmentEditableField = (typeof SEGMENT_EDITABLE_FIELDS)[number];

/**
 * THE CARD SLIMMING, as a field set (lane-impressions spec Rev 8, "Segment card
 * slimming"; ticket 05).
 *
 * Once a task's backfill job has committed — `segments.impression_origin` is
 * non-null, ticket 01's mechanical discriminator — three of the six Working
 * State fields are RETIRED: `done` retires outright, `decisions` dissolves into
 * the impressions' binding lines, and the `next_steps` NARRATIVE retires (what
 * is still owed lives in an impression's frontier lines). `goal`,
 * `constraints` and `reference` keep, and `insight` keeps beside them in the
 * summary layer; `content` becomes the task-tier impression.
 *
 * WHAT THIS LIST IS NOT: it does not remove anything from `remember`'s own
 * `field` enum. The spec pins that removal to a LATER release, after every task
 * carrying legacy fields has cut over — "a deleted enum before a completed
 * backfill would strand unmaintainable fields". This is the CARD's render set,
 * and nothing more.
 */
export const SEGMENT_FIELDS_RETIRED_BY_IMPRESSION_CUTOVER = [
  "decisions",
  "done",
  "next_steps",
] as const satisfies readonly SegmentWorkingStateField[];

const RETIRED_BY_CUTOVER = new Set<string>(
  SEGMENT_FIELDS_RETIRED_BY_IMPRESSION_CUTOVER,
);

/**
 * The Working State fields a CUT-OVER task's card still renders, in
 * `SEGMENT_WORKING_STATE_FIELDS`' own declared order — derived from the list
 * above rather than spelled a second time, so "which three retire" is one fact
 * with one home.
 */
export const SEGMENT_WORKING_STATE_FIELDS_AFTER_CUTOVER =
  SEGMENT_WORKING_STATE_FIELDS.filter(
    (field) => !RETIRED_BY_CUTOVER.has(field),
  ) as readonly SegmentWorkingStateField[];

/**
 * THE MIGRATION'S SOURCE FIELDS (spec "Legacy backfill": "inputs = the retiring
 * field contents (done/decisions/next_steps + current content)").
 *
 * FOUR, not three: `content` is a source of the TASK-TIER impression even
 * though it is not cleared — it is REPLACED by the impression it feeds, in the
 * same transaction. This list is what the source-snapshot fence digests, so it
 * has to name every input the model was shown, not only the ones that end up
 * NULL.
 */
export const SEGMENT_IMPRESSION_SOURCE_FIELDS = [
  ...SEGMENT_FIELDS_RETIRED_BY_IMPRESSION_CUTOVER,
  "content",
] as const satisfies readonly SegmentEditableField[];
