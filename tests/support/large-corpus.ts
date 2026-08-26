import type { Database } from "bun:sqlite";

import { insertLane } from "../../src/db/lanes";
import {
  addSegmentMembers,
  appendSegmentWorkingStateRows,
  createSegment,
} from "../../src/db/segments";
import type { SegmentEditableField } from "../../src/shared/segment-fields";

/**
 * Deterministic, loop-built corpora — bounded-read-surfaces ticket 01.
 *
 * "确定性大 fixture" (the ticket's own words, matching the identical
 * convention `tests/support/lane-checker-render-fixture.ts` already
 * established for the sibling `lane_check` fix, `6e668da`): not a live
 * production snapshot — the suite is HOME-sandboxed and must not touch a real
 * database (`tests/support/sandbox-home.preload.ts`) — and not a three-row
 * toy either, since a toy shape cannot reproduce a cap failure that only
 * shows up at volume. Every builder here goes through the real DB write path
 * (not hand-built typed objects, unlike the lane_check fixture, since the
 * three render paths this covers are DB-backed) but stays cheap: one batched
 * write for the Working State fixture, and plain loops over the same
 * prepared-statement shape `tests/mcp/timeline.test.ts`'s own
 * `seedLongSession` already uses for its bulk turn inserts.
 */

// ---------------------------------------------------------------------------
// `recall(id="E<n>", page>=2)` — segment-card.ts's overflow pagination.
// ---------------------------------------------------------------------------

/**
 * Large enough that the default `pageBudget` (1000 tokens,
 * `SEGMENT_CARD_DEFAULT_PAGE_BUDGET`) forces the un-elided page 2+ render
 * past ONE page — the exact shape of the production failure (169,362
 * characters against a 100,000-character cap, `pageBudget: 3000` explicit and
 * ignored).
 */
export const LARGE_WORKING_STATE_ROW_COUNT = 400;

/**
 * Appends `count` deterministic bullet rows to one Working State field in a
 * SINGLE write (`appendSegmentWorkingStateRows` takes the whole array in one
 * UPDATE), so the fixture is cheap despite its row count. Returns the exact
 * row texts written, for a test's own containment assertions.
 */
export function seedLargeWorkingStateField(
  db: Database,
  segmentId: number,
  field: SegmentEditableField,
  baseEpoch: number,
  count: number = LARGE_WORKING_STATE_ROW_COUNT,
): string[] {
  const rows = Array.from(
    { length: count },
    (_, index) => `bulk row ${String(index).padStart(4, "0")} padding-${"x".repeat(20)}`,
  );
  appendSegmentWorkingStateRows(db, segmentId, field, rows, baseEpoch);
  return rows;
}

// ---------------------------------------------------------------------------
// `timeline(id="E<n>/L*")` — the declared-lane list, unbounded at 103 lanes
// on the live E60 today (module doc, `mcp/timeline.ts`'s `buildSegmentLaneChain`
// section).
// ---------------------------------------------------------------------------

/**
 * Exceeds the live E60 example (103 declared lanes) and is large enough that
 * the default page budget (`DEFAULT_MILESTONE_PAGE_BUDGET`, 1000 tokens)
 * forces `/L*` past one page.
 */
export const LARGE_LANE_COUNT = 200;

/**
 * `count` declared lanes, deliberately MEMBERLESS (no edges, no member
 * turns): the bug this fixture exercises is in the LIST's own pagination —
 * independent of any one lane's own, already-bounded representative chain
 * (`DEFAULT_LANE_CHAIN_ITEM_BUDGET`) — so a memberless lane is a faithful,
 * far cheaper fixture unit than seeding turns and tagged edges for every one
 * of them. Returns the tags written, in insertion order.
 */
export function seedManyDeclaredLanes(
  db: Database,
  segmentId: number,
  baseEpoch: number,
  count: number = LARGE_LANE_COUNT,
): string[] {
  const tags: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const tag = `bulk-lane-${String(index).padStart(4, "0")}`;
    insertLane(db, segmentId, tag, baseEpoch + index);
    tags.push(tag);
  }
  return tags;
}

// ---------------------------------------------------------------------------
// `timeline(id="S<n>", view="milestones")` — the era SEGMENT SPINE, carrying
// a session's whole era history with no count cap of its own
// (`listSegmentSpineForSession`, db/segment-rank.ts).
// ---------------------------------------------------------------------------

/**
 * Large enough that `shedSpineToBudget`'s default budget
 * (`DEFAULT_MILESTONE_PAGE_BUDGET`, 1000 tokens) folds rows under the
 * default `renderTimeline` call (no explicit `tokenBudget`, which is what
 * every MCP `timeline()` caller does).
 */
export const LARGE_SPINE_SEGMENT_COUNT = 200;

/**
 * `count` segments, each carrying exactly one era-side member turn of
 * `sessionId` — the minimum `listSegmentSpineForSession` needs to admit a
 * spine row for it. One prepared statement for the turn inserts, looped —
 * the same shape `tests/mcp/timeline.test.ts`'s own `seedLongSession` uses
 * for its bulk fixture. Returns the created segment ids, in insertion order
 * (oldest first, matching the spine's own chronological-by-first-member
 * order).
 */
export function seedLargeEraSpine(
  db: Database,
  sessionId: number,
  baseEpoch: number,
  count: number = LARGE_SPINE_SEGMENT_COUNT,
): number[] {
  const insertTurn = db.query<{ id: number }, [number, number, string, number]>(
    `INSERT INTO turns (
       session_id, prompt_number, status, title, type, tags,
       created_at_epoch, user_prompt, assistant_response, files_read, files_modified
     ) VALUES (?, ?, 'extracted', ?, '[]', '[]', ?, 'p', 'r', '[]', '[]')
     RETURNING id`,
  );

  const segmentIds: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const epoch = baseEpoch + index;
    const segment = createSegment(db, {
      title: `bulk segment ${String(index).padStart(4, "0")}`,
      nowEpoch: epoch,
    });
    const turnId = insertTurn.get(sessionId, index + 1, `bulk turn ${index}`, epoch)!.id;
    addSegmentMembers(db, segment.id, [turnId], epoch);
    segmentIds.push(segment.id);
  }
  return segmentIds;
}
