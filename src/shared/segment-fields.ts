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
