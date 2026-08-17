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
