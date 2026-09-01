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

export type ImpressionDisplay =
  /** Render NOTHING — no placeholder, no empty heading (spec "Display"). */
  | { kind: "none" }
  /** The stored text, byte-verbatim. */
  | { kind: "text"; text: string };

const NONE: ImpressionDisplay = { kind: "none" };

/**
 * THE display predicate, for a container whose text slot is impression-owned:
 * the stored text, byte-verbatim, or nothing at all when there is none.
 *
 * `impression_stale` IS NOT CONSULTED HERE, and its absence is ticket 07's
 * whole substance (the user's ruling at T2269). Rev 8 suppressed a STALE
 * container's prose behind an `[impression pending synthesis]` status line;
 * that marker is gone, together with the branch that produced it. A fold now
 * CONCATENATES the two sides' impressions into the survivor, so the text a
 * STALE container holds is not a description of something that no longer
 * exists — it is both descriptions, joined and readable, waiting for the next
 * settlement run to rewrite them into one.
 *
 * The flag keeps its OTHER job in full: `settleImpressions`
 * (worker/note-settlement-impressions.ts) still refuses a `retain` over it, so
 * the rewrite is owed. It lost only its display job.
 *
 * NOT for a task row whose `content` is still legacy field text — see
 * `readTaskImpressionSlot`, which asks the ownership question first.
 */
export function impressionDisplay(
  stored: StoredImpression | null,
): ImpressionDisplay {
  if (stored === null || stored.text === null) {
    return NONE;
  }
  return { kind: "text", text: stored.text };
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
 * The second direction is the one with a live case: `readSegmentTaskImpression`
 * nulls `text` when `origin` is null, so a card that consulted
 * `impressionDisplay` alone would render NOTHING in the slot for every
 * un-backfilled phase-1 task — deleting its real, live legacy `content` from
 * the only surface that shows it. This function turns that same fact into the
 * caller's branch instead.
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
 * `recall.ts` already performs). The response therefore grows by EXACTLY THE
 * STORED BYTES plus the blank line, and by nothing else.
 *
 * THAT IS THE WHOLE PROMISE — it is no longer "at most the 500-token cap"
 * (ticket 07). `impressionCapForLane` binds settlement REPLACEMENTS only, and
 * since the ruling at T2269 a container fold CONCATENATES two impressions
 * without a cap, so a lane folded N times before a settlement run reaches it
 * can hold up to N+1 cap-sized texts. The bound a reader can rely on is the
 * honest one: what is stored is what is spliced.
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
    case "text":
      return `${display.text}\n\n`;
  }
}
