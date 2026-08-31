import type { Database } from "bun:sqlite";

import { renderSegmentLaneDigestLines } from "./timeline";

/**
 * The lane VOCABULARY render — the attach receipt's answer to "which lane
 * tags may this turn carry", shared by both attach paths
 * (`remember(attach)` and `note`'s auto-attach).
 *
 * Frontier-injection ticket 03 (vocabulary succession): the frontier digest
 * lines are the ONE authoritative lane-vocabulary surface — every declared
 * lane of an attached task renders one digest line, zero-settled lanes
 * included — and the roster's `- lanes:` line retired with its consumers.
 * This module survives the succession for the same reason it existed (peer
 * review A4): injection blocks are emitted on SessionStart alone
 * (`plugin/hooks/hooks.json`), so between a mid-session attach and the next
 * SessionStart the digest lines do not exist in context yet, and the attach
 * receipt is the only channel that can carry the words the write gate is
 * about to judge the caller against. It renders the digest lines VERBATIM
 * (`renderSegmentLaneDigestLines`, the injected block's own assembly and
 * line renderer), so the receipt and the SessionStart block are one
 * vocabulary, never two spellings of it.
 */

/**
 * The attach receipt's vocabulary block: one digest line per declared lane
 * (the frontier section's display order, denominators and pointers intact),
 * under a header and over the sentence that makes the list actionable — the
 * write gate accepts these lane tags plus the segment's own tag and refuses
 * everything else, so a caller that reads this block has seen the entire
 * legal vocabulary for the turn it is about to write.
 *
 * Always renders, including the zero-lane case: a segment with no declared
 * lane is not a rendering gap, it is the answer (the caller just asked what
 * it may write, and "nothing but the segment tag" must be SAID, not omitted).
 *
 * `eraCutoffEpoch: null` deliberately — the same era-blind render as the
 * segment card beside it in both receipts (`renderSegmentCard(db, id,
 * { eraCutoffEpoch: null })`): one receipt, one universe.
 */
export function renderSegmentLaneVocabulary(db: Database, segmentId: number): string {
  const digestLines = renderSegmentLaneDigestLines(db, segmentId, null);
  if (digestLines.length === 0) {
    return `Lane vocabulary: (none declared yet) — with E${segmentId}'s own tag, that is the whole vocabulary a turn's \`tags\` may draw from here.`;
  }
  return [
    "Lane vocabulary (one digest line per declared lane):",
    ...digestLines,
    `With E${segmentId}'s own tag, these #tags are the whole vocabulary a turn's \`tags\` may draw from here.`,
  ].join("\n");
}
