import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { getLane, insertLane } from "../../src/db/lanes";
import { writeMemoryEdges } from "../../src/db/memory-edges";
import { initializeSchema } from "../../src/db/schema";
import {
  addSegmentMembers,
  attachSegmentToSession,
  createSegment,
  getAttachedSegmentIds,
  getSegment,
  getSegmentMemberTurnIds,
  mergeSegments,
  SegmentMergeInvariantError,
} from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";

/**
 * `mergeSegments` — container-unification ticket 08, spec D6.
 *
 * The TASK tier of `remember(merge)`: `from` hands its members and its lanes
 * to `into`, then leaves the roster. Three properties are load-bearing —
 * each asserted against a state the database can actually be in:
 *
 *   1. OWNERSHIP, NOT TAG. `create(members=[...])` seeds `segment_members`
 *      without touching `turns.tags` at all — a member selected by tag would
 *      move NONE of those turns.
 *   2. ORDER. Lanes re-parent onto `into` BEFORE any member moves, because
 *      `reassignSegmentMembers`'s own lane-stranding gate refuses a member
 *      still tagged with a lane `into` has not yet declared.
 *   3. THE FINAL GUARD IS PAIRED WITH THE DELETE — the same shape
 *      `db/lanes.ts`'s `undeclareEmptiedLane` is.
 */
describe("mergeSegments — one task folded into another (ticket 08)", () => {
  const NOW = 1_800_000_000;

  let db: Database;
  let sessionId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "segments-merge-session",
      project: "/tmp/project-segments-merge",
      title: null,
      insight: null,
      createdAtEpoch: NOW,
      updatedAtEpoch: NOW,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  function seedTurn(promptNumber: number, tags: string[] = []): number {
    return db
      .query<{ id: number }, [number, number, string, number]>(
        `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch, tags)
         VALUES (?, ?, 'active', ?, ?) RETURNING id`,
      )
      .get(sessionId, promptNumber, NOW, JSON.stringify(tags))!.id;
  }

  function tagsOf(turnId: number): string[] {
    return JSON.parse(
      db.query<{ tags: string }, [number]>("SELECT tags FROM turns WHERE id = ?").get(turnId)!.tags,
    ) as string[];
  }

  function owningSegments(turnId: number): number[] {
    return db
      .query<{ segmentId: number }, [number]>(
        "SELECT segment_id AS segmentId FROM segment_members WHERE turn_id = ?",
      )
      .all(turnId)
      .map((row) => row.segmentId);
  }

  // -------------------------------------------------------------------------
  // The ordinary fold
  // -------------------------------------------------------------------------

  test("members move by ownership, a declared lane re-parents, and `from` leaves the roster", () => {
    const from = createSegment(db, { title: "From", tags: ["from-seg"], nowEpoch: NOW }).id;
    const into = createSegment(db, { title: "Into", tags: ["into-seg"], nowEpoch: NOW }).id;
    insertLane(db, from, "shared-work", NOW);
    const t1 = seedTurn(1, ["from-seg", "shared-work"]);
    addSegmentMembers(db, from, [t1], NOW);

    const outcome = mergeSegments(db, from, into, NOW);

    expect(outcome.kind).toBe("merged");
    if (outcome.kind !== "merged") throw new Error("unreachable");
    expect(outcome.receipt).toEqual({ from, into, membersMoved: 1, lanesMoved: 1 });

    expect(getSegment(db, from)).toBeNull();
    expect(getLane(db, from, "shared-work")).toBeNull();
    expect(getLane(db, into, "shared-work")).not.toBeNull();
    expect(owningSegments(t1)).toEqual([into]);
    expect(tagsOf(t1)).toEqual(["into-seg", "shared-work"]);
  });

  // -------------------------------------------------------------------------
  // Order: lanes before members
  // -------------------------------------------------------------------------

  /**
   * `into` declares NO lane at merge time — the destination for the tagged
   * edge only exists because step 1 re-parents `shared-work` onto it BEFORE
   * step 2 tries to move the member. `reassignSegmentMembers`'s own
   * `findMembershipLaneStrandings` gate is what enforces this: swap the two
   * steps in `mergeSegments` and this same fixture makes the member move
   * fail (`kind: "members-blocked"`), because `into` does not yet declare
   * "shared-work" at the moment the gate asks.
   */
  test("a lane-tagged edge survives the merge with NEITHER side rewritten — the endpoint's ownership resolves it", () => {
    const from = createSegment(db, { title: "From", tags: ["from-seg2"], nowEpoch: NOW }).id;
    const into = createSegment(db, { title: "Into", tags: ["into-seg2"], nowEpoch: NOW }).id;
    insertLane(db, from, "shared-work", NOW);
    const t1 = seedTurn(1, ["from-seg2", "shared-work"]);
    const t2 = seedTurn(2, ["from-seg2", "shared-work"]);
    addSegmentMembers(db, from, [t1, t2], NOW);
    const written = writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: t2 },
          cited: { kind: "turn", id: t1 },
          relation: "extends",
          provenance: "asserted",
          tailTag: "shared-work",
          headTag: "shared-work",
        },
      ],
      NOW,
    );
    const edgeId = written.written[0]!.id;

    const outcome = mergeSegments(db, from, into, NOW);
    expect(outcome.kind).toBe("merged");

    const sides = db
      .query<{ tailTag: string; headTag: string }, [number]>(
        "SELECT tail_tag AS tailTag, head_tag AS headTag FROM memory_edges WHERE id = ?",
      )
      .get(edgeId)!;
    // Untouched: the tag STRING never changes on a task-tier merge, only the
    // lane's owning segment does — the edge resolves through each endpoint's
    // OWNING segment, which is now `into` for both sides.
    expect(sides).toEqual({ tailTag: "shared-work", headTag: "shared-work" });
    expect(owningSegments(t1)).toEqual([into]);
    expect(owningSegments(t2)).toEqual([into]);
  });

  // -------------------------------------------------------------------------
  // Members selected by OWNERSHIP, never by tag
  // -------------------------------------------------------------------------

  /**
   * Mirrors `create(members=[...])`'s own write shape exactly:
   * `addSegmentMembers` alone, no tag ever written onto the turn. A
   * selection keyed off `turns.tags` would see nothing here and move zero
   * members, then `deleteEmptiedSegment`'s own guard would catch the
   * leftover `segment_members` row and throw rather than silently losing it.
   */
  test("a member seeded WITHOUT the segment's own tag still moves, and is backfilled", () => {
    const from = createSegment(db, { title: "From", tags: ["from-seg3"], nowEpoch: NOW }).id;
    const into = createSegment(db, { title: "Into", tags: ["into-seg3"], nowEpoch: NOW }).id;
    const t1 = seedTurn(1, []);
    addSegmentMembers(db, from, [t1], NOW);
    expect(tagsOf(t1)).toEqual([]);

    const outcome = mergeSegments(db, from, into, NOW);

    expect(outcome.kind).toBe("merged");
    if (outcome.kind !== "merged") throw new Error("unreachable");
    expect(outcome.receipt.membersMoved).toBe(1);
    expect(owningSegments(t1)).toEqual([into]);
    // Backfilled: both stores now agree the turn belongs to `into`.
    expect(tagsOf(t1)).toEqual(["into-seg3"]);
  });

  // -------------------------------------------------------------------------
  // Session attachments do not migrate
  // -------------------------------------------------------------------------

  test("a session attachment to `from` does not migrate — it cascades away with the row", () => {
    const from = createSegment(db, { title: "From", tags: ["from-seg4"], nowEpoch: NOW }).id;
    const into = createSegment(db, { title: "Into", tags: ["into-seg4"], nowEpoch: NOW }).id;
    attachSegmentToSession(db, sessionId, from, NOW);
    expect(getAttachedSegmentIds(db, sessionId)).toEqual([from]);

    mergeSegments(db, from, into, NOW);

    expect(getAttachedSegmentIds(db, sessionId)).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Same-name lane collision (ticket 10's branch): refuse the WHOLE merge
  // -------------------------------------------------------------------------

  test("a same-name lane collision refuses the whole merge — nothing moves", () => {
    const from = createSegment(db, { title: "From", tags: ["from-seg5"], nowEpoch: NOW }).id;
    const into = createSegment(db, { title: "Into", tags: ["into-seg5"], nowEpoch: NOW }).id;
    insertLane(db, from, "contested", NOW);
    insertLane(db, into, "contested", NOW);
    const t1 = seedTurn(1, ["from-seg5", "contested"]);
    addSegmentMembers(db, from, [t1], NOW);

    const outcome = mergeSegments(db, from, into, NOW);

    expect(outcome).toEqual({ kind: "lane-collision", tags: ["contested"] });
    expect(getSegment(db, from)).not.toBeNull();
    expect(getLane(db, from, "contested")).not.toBeNull();
    expect(owningSegments(t1)).toEqual([from]);
    expect(tagsOf(t1)).toEqual(["from-seg5", "contested"]);
  });

  // -------------------------------------------------------------------------
  // The final guard, paired with the delete
  // -------------------------------------------------------------------------

  /**
   * ORDER, pinned from the inside. This test states the invariant the guard
   * enforces — zero members and zero lanes for `from` at the moment it is
   * removed. The MUTATION it answers is moving `deleteEmptiedSegment`'s call
   * above the lane/member steps in `mergeSegments`: every merge test in this
   * file then throws `SegmentMergeInvariantError` instead of landing, because
   * the guard is evaluated while `from` still owns what it is about to hand
   * over.
   */
  test("the delete answers to its own guard — zero members and zero lanes BEFORE `from` leaves the roster", () => {
    const from = createSegment(db, { title: "From", tags: ["from-seg6"], nowEpoch: NOW }).id;
    const into = createSegment(db, { title: "Into", tags: ["into-seg6"], nowEpoch: NOW }).id;
    insertLane(db, from, "shared-work6", NOW);
    const t1 = seedTurn(1, ["from-seg6", "shared-work6"]);
    addSegmentMembers(db, from, [t1], NOW);
    expect(getSegmentMemberTurnIds(db, from)).toEqual([t1]);

    mergeSegments(db, from, into, NOW);

    expect(getSegmentMemberTurnIds(db, from)).toEqual([]);
    expect(getSegment(db, from)).toBeNull();
    expect(SegmentMergeInvariantError.prototype).toBeInstanceOf(Error);
  });
});
