import type { Database } from "bun:sqlite";

import { readLaneImpression, type StoredImpression } from "../db/impressions";
import { readSegmentTaskImpression } from "../db/segments";

/**
 * Lane impressions — the DISPLAY tier (lane-impressions spec Rev 8, ticket 04).
 *
 * Ticket 01 stores impressions and ticket 02/03 write them; nothing here
 * writes. What lives here is the ONE answer to "what does this container show",
 * shared by the two — and only two — surfaces the spec admits (spec "Display",
 * "Display ownership, stated once"):
 *
 *   - the LANE tier renders on `recall(id="E<n>/#<tag>")`, as a bounded fixed
 *     preface at the head of PAGE 1, OUTSIDE the member paginator;
 *   - the TASK tier renders in the segment card's content slot.
 *
 * Everything else — the milestone block, the timeline lane view, the attach
 * receipt, `filter.tag` search hits — renders no impression at all. The
 * `filter.tag` refusal is the spec's own: a global exact-match cannot bind a
 * qualified lane, and a mixed result set under one lane's impression would
 * misattribute.
 */

/**
 * The mechanical status line a STALE container shows INSTEAD OF its old prose
 * (spec "Merge staleness"): a merge fused two identities, so the stored text no
 * longer describes the result. Suppression is not politeness — a reader absorbs
 * stale prose as domain belief, and the three-arm experiment measured exactly
 * that absorption. A status line cannot be absorbed the same way, and it lets a
 * reader tell "never had one" from "awaiting synthesis".
 */
export const IMPRESSION_PENDING_SYNTHESIS_LINE = "[impression pending synthesis]";

export type ImpressionDisplay =
  /** Render NOTHING — no placeholder, no empty heading (spec "Display"). */
  | { kind: "none" }
  /** Old prose fully suppressed; `IMPRESSION_PENDING_SYNTHESIS_LINE` in its place. */
  | { kind: "pending" }
  /** The stored text, byte-verbatim. */
  | { kind: "text"; text: string };

const NONE: ImpressionDisplay = { kind: "none" };
const PENDING: ImpressionDisplay = { kind: "pending" };

/**
 * THE display predicate, for a container whose text slot is impression-owned.
 * Both tiers route through it, so "is this stale" is asked in exactly one
 * place: STALE outranks the text (that is what suppression MEANS), and an
 * absent impression is nothing at all rather than an empty shell.
 *
 * NOT for a task row whose `content` is still legacy field text — see
 * `readTaskImpressionSlot`, which asks the ownership question first.
 */
export function impressionDisplay(
  stored: StoredImpression | null,
): ImpressionDisplay {
  if (stored === null) {
    return NONE;
  }
  if (stored.stale) {
    return PENDING;
  }
  return stored.text === null ? NONE : { kind: "text", text: stored.text };
}

/**
 * The LANE tier's display, for `(segmentId, tag)`. `lanes.impression` is
 * impression-owned by construction — the column has never held anything else —
 * so the ownership question the task tier must ask does not arise here.
 */
export function laneImpressionDisplay(
  db: Database,
  segmentId: number,
  tag: string,
): ImpressionDisplay {
  return impressionDisplay(readLaneImpression(db, segmentId, tag));
}

/**
 * The TASK tier's display, or `null` when the segment's `content` is STILL
 * LEGACY FIELD TEXT and this ticket's surfaces must leave it alone.
 *
 * `impression_origin IS NULL` is the mechanical discriminator ticket 01 pinned,
 * and it is asked HERE, once, ahead of `impressionDisplay` — deliberately, and
 * it is load-bearing in BOTH directions:
 *
 *   - a card must never render legacy content as an impression;
 *   - a card must never render an impression through the legacy path.
 *
 * The first direction has a live case, not a hypothetical one: `mergeSegments`
 * (ticket 03) sets `impression_stale` on the survivor unconditionally, so a
 * phase-1 task that has never been backfilled can carry STALE over ordinary
 * legacy prose. Consulting `impressionDisplay` without this gate would replace
 * that task's real, live `content` with a pending-synthesis marker — deleting
 * information from the card for an impression that does not exist yet. The flag
 * simply waits, exactly as the debt behind it does, until the backfill gives it
 * something to be stale ABOUT.
 *
 * `readSegmentTaskImpression` already nulls `text` when `origin` is null; this
 * function turns that same fact into the caller's branch.
 */
export function readTaskImpressionSlot(
  db: Database,
  segmentId: number,
): ImpressionDisplay | null {
  const stored = readSegmentTaskImpression(db, segmentId);
  if (stored === null || stored.origin === null) {
    return null;
  }
  return impressionDisplay(stored);
}

/**
 * THE LANE ROUTE'S PREFACE (spec "Display", pagination pinned to the SIMPLE
 * option): the lane's FULL impression at the head of PAGE 1, byte-verbatim,
 * separated from the page by one blank line — and nothing at all on any deeper
 * page, or when the lane has no impression.
 *
 * Returned as a STRING THE CALLER PREPENDS rather than as anything the member
 * renderer knows about, because "outside the member paginator" is the whole
 * point: the paginator's ordinal arithmetic, its page header, its receipt and
 * its per-member grants are computed exactly as before, and this text is
 * spliced in front of the finished page (the caller shifts its ledger offsets
 * by this string's length, the same splice arithmetic every composition site in
 * `recall.ts` already performs). The response therefore grows by the
 * impression's own bytes — bounded by the 500-token storage cap — plus the
 * blank line, and by nothing else.
 *
 * NO HEADING is emitted. Line 1 of an impression is the self-contained GLOBAL
 * IMPRESSION by ruling (T2260-T2261) and announces itself; a heading would add
 * bytes to a surface whose whole promise is "at most the storage cap", and an
 * absent impression must render no empty heading anyway.
 */
export function renderLaneImpressionPreface(
  db: Database,
  segmentId: number,
  tag: string,
  page: number,
): string {
  // "Which page is this" is asked once, here: the member paginator's own
  // `page` parameter, unmodified. Page 1 is the only page that carries a
  // preface — a deeper page repeats nothing.
  if (page !== 1) {
    return "";
  }
  const display = laneImpressionDisplay(db, segmentId, tag);
  switch (display.kind) {
    case "none":
      return "";
    case "pending":
      return `${IMPRESSION_PENDING_SYNTHESIS_LINE}\n\n`;
    case "text":
      return `${display.text}\n\n`;
  }
}
