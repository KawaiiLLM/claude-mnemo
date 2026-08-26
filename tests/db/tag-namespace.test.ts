import { afterEach, beforeEach, expect, describe, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase, runWriteTransaction } from "../../src/db/database";
import { getLane, insertLane, listLanesForSegment } from "../../src/db/lanes";
import { initializeSchema } from "../../src/db/schema";
import {
  createSegment,
  findRetagLaneCollisions,
  getSegment,
  segmentTagOf,
  setSegmentTag,
} from "../../src/db/segments";
import {
  findTagNamespaceHolders,
  TagNamespaceCollisionError,
} from "../../src/db/tag-namespace";

/**
 * ONE NAMESPACE, TWO TABLES (lane-model-v12 spec D3e; peer review A2).
 *
 * A segment tag is globally unique and CARRYING IT IS MEMBERSHIP —
 * `deriveTurnSegmentMembership` reads a turn's own `tags` and takes the first
 * word naming a segment. A lane tag lives in that same column on that same
 * turn. So a lane in E2 spelled like E1's segment tag puts a turn in an
 * illegal double-membership state, or silently migrates it, with no write
 * anyone would call a move.
 *
 * WHERE THE INVARIANT IS ENFORCED is the whole point of this file.
 * `merge` creates no name — it folds one lane into a lane that must already
 * exist — so the only two places a colliding name can be BORN are the two
 * primitives that mint one: `insertLane` and `setSegmentTag`. Both directions
 * are asserted below, and both are asserted through a DIRECT primitive call,
 * because a facade pre-check is a message, not an invariant: a migration, a
 * repair script or any direct caller reaches the primitive without passing it.
 * (The facades' friendlier refusals are pinned in tests/mcp/remember.test.ts.)
 */
describe("one namespace across segment tags and lane tags (D3e, peer A2)", () => {
  const NOW = 1_800_000_000;

  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  function segment(title: string, tag?: string): number {
    return createSegment(db, {
      title,
      tags: tag === undefined ? [] : [tag],
      nowEpoch: NOW,
    }).id;
  }

  // -------------------------------------------------------------------------
  // Direction 1: a lane may not shadow ANY segment's tag
  // -------------------------------------------------------------------------

  /**
   * THE COLLISION THE PRE-v12 CHECKS COULD NOT SEE. Both facades asked only
   * about the declaring segment's own tags, so the cross-segment case — the
   * one that actually moves a turn between containers — was waved through.
   */
  test("AUTHORITY IS THE PRIMITIVE: a direct insertLane is refused when ANOTHER segment holds the word", () => {
    const holder = segment("Holder", "alpha");
    const declarer = segment("Declarer", "home");

    expect(() => insertLane(db, declarer, "alpha", NOW)).toThrow(TagNamespaceCollisionError);
    expect(() => insertLane(db, declarer, "alpha", NOW)).toThrow(
      `"alpha" is already E${holder}'s segment tag`,
    );
    expect(getLane(db, declarer, "alpha")).toBeNull();
    expect(listLanesForSegment(db, declarer)).toEqual([]);
  });

  test("a direct insertLane is refused when the declaring segment's OWN tag is the word", () => {
    const declarer = segment("Declarer", "home");

    expect(() => insertLane(db, declarer, "home", NOW)).toThrow(
      `"home" is already E${declarer}'s segment tag`,
    );
    expect(getLane(db, declarer, "home")).toBeNull();
  });

  test("a lane on a word no segment holds still lands", () => {
    const declarer = segment("Declarer", "home");
    expect(insertLane(db, declarer, "write-gate", NOW)).not.toBeNull();
    expect(getLane(db, declarer, "write-gate")).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // Direction 2: a segment may not take a word ANY lane already holds
  // -------------------------------------------------------------------------

  test("AUTHORITY IS THE PRIMITIVE: a direct setSegmentTag is refused when ANOTHER segment's lane holds the word", () => {
    const laneHome = segment("Lane home", "lane-home");
    insertLane(db, laneHome, "contested", NOW);
    const namee = segment("To be named");

    const result = setSegmentTag(db, namee, "contested", NOW);

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.message).toContain(
      `"contested" is already a lane declared on E${laneHome}`,
    );
    expect(getSegment(db, namee)?.tags).toEqual([]);
  });

  test("a direct setSegmentTag is refused when the segment's OWN lane holds the word", () => {
    const namee = segment("To be named");
    insertLane(db, namee, "contested", NOW);

    const result = setSegmentTag(db, namee, "contested", NOW);

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.message).toContain(
      `"contested" is already a lane declared on E${namee}`,
    );
    expect(getSegment(db, namee)?.tags).toEqual([]);
  });

  test("a segment tag on a word no lane holds still lands, and clearing is always legal", () => {
    const other = segment("Other");
    insertLane(db, other, "some-lane", NOW);
    const namee = segment("To be named");

    const named = setSegmentTag(db, namee, "free-word", NOW);
    expect(named.ok).toBe(true);
    expect(named.ok ? segmentTagOf(named.segment) : null).toBe("free-word");

    const cleared = setSegmentTag(db, namee, null, NOW);
    expect(cleared.ok).toBe(true);
    expect(cleared.ok ? cleared.segment.tags : null).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // The two properties that make the check an invariant rather than a lookup
  // -------------------------------------------------------------------------

  /**
   * The refusal happens INSIDE the caller's write transaction, so a batch that
   * hits one leaves nothing behind. A check performed before the transaction —
   * or a primitive that returned a falsy value instead of throwing — would let
   * the legal half of this batch land.
   */
  test("the refusal rolls the caller's whole write transaction back", () => {
    const holder = segment("Holder", "alpha");
    const declarer = segment("Declarer", "home");

    expect(() =>
      runWriteTransaction(db, () => {
        insertLane(db, declarer, "legal-lane", NOW);
        insertLane(db, declarer, "alpha", NOW);
      }),
    ).toThrow(TagNamespaceCollisionError);

    expect(listLanesForSegment(db, declarer)).toEqual([]);
    expect(segmentTagOf(getSegment(db, holder)!)).toBe("alpha");
  });

  /**
   * `remember(retag)`'s pre-check, widened from "this segment's lanes" to any
   * lane holder anywhere (peer A2). The mutation this answers is restoring the
   * `segment_id = ?` clause it used to carry: the same-segment case below still
   * passes, and the cross-segment one — the collision that breaks D3e — does
   * not.
   */
  test("findRetagLaneCollisions reports a lane holder in ANY segment, not only the retagged one", () => {
    const own = segment("Own");
    const elsewhere = segment("Elsewhere");
    insertLane(db, own, "mine", NOW);
    insertLane(db, elsewhere, "theirs", NOW);

    expect(findRetagLaneCollisions(db, ["mine"])).toEqual([
      { namespace: "lane", segmentId: own, tag: "mine" },
    ]);
    expect(findRetagLaneCollisions(db, ["theirs"])).toEqual([
      { namespace: "lane", segmentId: elsewhere, tag: "theirs" },
    ]);
    expect(findRetagLaneCollisions(db, ["unheld"])).toEqual([]);
  });

  test("the helper answers in the order the words were named, and ignores the empty word", () => {
    const first = segment("First", "one");
    const second = segment("Second", "two");

    expect(findTagNamespaceHolders(db, "lane", ["two", "one", "", "two"])).toEqual([
      { namespace: "segment", segmentId: second, tag: "two" },
      { namespace: "segment", segmentId: first, tag: "one" },
    ]);
    expect(findTagNamespaceHolders(db, "lane", [])).toEqual([]);
  });
});
