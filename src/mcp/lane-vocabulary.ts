import type { Database } from "bun:sqlite";

import { listLanesForSegment } from "../db/lanes";

/**
 * The lane VOCABULARY line — the one rendering of "which lane tags may this
 * turn carry", shared by every surface that answers that question.
 *
 * lane-model-v12 ticket 18 moved the vocabulary off the segment card and onto
 * the SessionStart roster row, which left a hole this module fills (peer review
 * A4): injection blocks are emitted on SessionStart alone
 * (`plugin/hooks/hooks.json`), so between a mid-session attach and the next
 * SessionStart the roster row does not exist yet, and the attach receipt is the
 * only channel that can carry the words the write gate is about to judge the
 * caller against. Both attach paths — `remember(attach)` and `note`'s
 * auto-attach — therefore append this line to their receipt.
 *
 * ONE module rather than an export off `recall.ts` (where the roster row
 * lives): `note.ts`/`remember.ts` need the words, not the roster, and a shared
 * formatter is what keeps the receipt and the roster row from drifting into two
 * spellings of the same vocabulary.
 */

/** Roster and receipt join lane tags identically — a bare word list, no addresses. */
const LANE_VOCABULARY_SEPARATOR = " · ";

const LANE_VOCABULARY_PREFIX = "- lanes: ";

/**
 * `- lanes: a · b`, or `null` when the segment has declared none.
 *
 * `null` rather than an empty line because the two consumers want opposite
 * things from the empty case: the roster row OMITS it (an unexpanded row is
 * ordinary), while an attach receipt must SAY it (the caller just asked what it
 * may write, and "nothing but the segment tag" is the answer, not silence).
 */
export function formatLaneVocabularyLine(laneTags: readonly string[]): string | null {
  return laneTags.length > 0
    ? `${LANE_VOCABULARY_PREFIX}${laneTags.join(LANE_VOCABULARY_SEPARATOR)}`
    : null;
}

/**
 * The attach receipt's vocabulary line: the segment's declared lanes, in the
 * registry's own alphabetical order (`listLanesForSegment`), with the sentence
 * that makes the list actionable — the write gate accepts these plus the
 * segment's own tag and refuses everything else, so a caller that reads this
 * line has seen the entire legal vocabulary for the turn it is about to write.
 *
 * Always renders, including the zero-lane case: a segment with no declared lane
 * is not a rendering gap, it is the answer.
 */
export function renderSegmentLaneVocabulary(db: Database, segmentId: number): string {
  const tags = listLanesForSegment(db, segmentId).map((lane) => lane.tag);
  const line = formatLaneVocabularyLine(tags) ?? `${LANE_VOCABULARY_PREFIX}(none declared yet)`;
  return `${line} — with E${segmentId}'s own tag, that is the whole vocabulary a turn's \`tags\` may draw from here.`;
}
