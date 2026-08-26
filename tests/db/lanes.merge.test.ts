import { afterEach, beforeEach, expect, describe, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase, runWriteTransaction } from "../../src/db/database";
import {
  countLaneMemberTurnsInSegment,
  getLane,
  insertLane,
  LaneMergeInvariantError,
  mergeLaneTag,
} from "../../src/db/lanes";
import { writeMemoryEdges } from "../../src/db/memory-edges";
import { initializeSchema } from "../../src/db/schema";
import { addSegmentMembers, createSegment } from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";

/**
 * `mergeLaneTag` — lane-model-v12 spec D3d, ticket 15.
 *
 * The primitive under settlement's `merge` verb: fold lane A into lane B so
 * that A ceases to exist. Three properties are load-bearing and each is
 * asserted against a state the database can actually be in, never against a
 * comment:
 *
 *   1. ATOMICITY. The member retag, the edge-side rewrite and the undeclare
 *      commit or vanish together. A receipt row would not prove this — the
 *      failpoint below aborts the LAST statement and asserts the FIRST one is
 *      not there afterwards.
 *   2. ORDER. The lane leaves the registry only after its members are
 *      rewritten. `mergeLaneTag` re-asks `undeclare`'s own guard immediately
 *      before deleting, so an implementation that undeclared first throws
 *      `LaneMergeInvariantError` instead of leaving a half-merged database.
 *   3. IDENTITY. A lane is `(segment, tag)`, so the same word in another
 *      segment is another lane and is left alone; and folding two tags into
 *      one can land two edge rows on one identity key, which goes through the
 *      project's established merge rule rather than a fresh comparator.
 */
describe("mergeLaneTag — one lane folded into another (ticket 15)", () => {
  const NOW = 1_800_000_000;

  let db: Database;
  let sessionId: number;
  let segmentId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "lanes-merge-session",
      project: "/tmp/project-lanes-merge",
      title: null,
      insight: null,
      createdAtEpoch: NOW,
      updatedAtEpoch: NOW,
      completedAtEpoch: null,
    }).id;
    // The segment carries its OWN tag: membership is derived from it (D3e), so
    // a fixture whose member turns lack it would be exercising a state the
    // production write path cannot produce.
    segmentId = createSegment(db, { title: "Merge", tags: ["home"], nowEpoch: NOW }).id;
    insertLane(db, segmentId, "lane-a", NOW);
    insertLane(db, segmentId, "lane-b", NOW);
  });

  afterEach(() => {
    db.close();
  });

  function seedTurn(
    promptNumber: number,
    options: { tags?: string[]; status?: string; segment?: number } = {},
  ): number {
    const id = db
      .query<{ id: number }, [number, number, string, number, string]>(
        `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch, tags)
         VALUES (?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        sessionId,
        promptNumber,
        options.status ?? "active",
        NOW,
        JSON.stringify(options.tags ?? []),
      )!.id;
    addSegmentMembers(db, options.segment ?? segmentId, [id], NOW);
    return id;
  }

  function seedEdge(
    citing: number,
    cited: number,
    options: {
      relation?: string;
      provenance?: "asserted" | "judged";
      tailTag?: string;
      headTag?: string;
      createdAtEpoch?: number;
    } = {},
  ): number {
    const written = writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: citing },
          cited: { kind: "turn", id: cited },
          relation: (options.relation ?? "extends") as never,
          provenance: options.provenance ?? "asserted",
          tailTag: options.tailTag ?? "",
          headTag: options.headTag ?? "",
          ...(options.createdAtEpoch !== undefined
            ? { createdAtEpoch: options.createdAtEpoch }
            : {}),
        },
      ],
      NOW,
    );
    return written.written[0]!.id;
  }

  function tagsOf(turnId: number): string[] {
    return JSON.parse(
      db.query<{ tags: string }, [number]>("SELECT tags FROM turns WHERE id = ?").get(turnId)!.tags,
    ) as string[];
  }

  function edgeSides(edgeId: number): { tailTag: string; headTag: string } | null {
    return (
      db
        .query<{ tailTag: string; headTag: string }, [number]>(
          "SELECT tail_tag AS tailTag, head_tag AS headTag FROM memory_edges WHERE id = ?",
        )
        .get(edgeId) ?? null
    );
  }

  function sideIndexRows(): Array<{ edgeRowId: number; side: string; tag: string }> {
    return db
      .query<{ edgeRowId: number; side: string; tag: string }, []>(
        `SELECT edge_row_id AS edgeRowId, side, tag FROM memory_edge_side_tags
          ORDER BY edge_row_id ASC, side ASC`,
      )
      .all();
  }

  // -------------------------------------------------------------------------
  // The ordinary fold
  // -------------------------------------------------------------------------

  test("members are retagged, an already-tagged member DEDUPES rather than doubling", () => {
    const t1 = seedTurn(1, { tags: ["home", "lane-a"] });
    const t2 = seedTurn(2, { tags: ["home", "lane-a", "lane-b"] });
    const t3 = seedTurn(3, { tags: ["home", "lane-b"] });

    const receipt = mergeLaneTag(db, segmentId, "lane-a", "lane-b", NOW);

    expect(tagsOf(t1)).toEqual(["home", "lane-b"]);
    expect(tagsOf(t2)).toEqual(["home", "lane-b"]);
    expect(tagsOf(t3)).toEqual(["home", "lane-b"]);
    expect(receipt.turnsRetagged).toBe(2);
    expect(receipt.turnsDeduplicated).toBe(1);
    expect(getLane(db, segmentId, "lane-a")).toBeNull();
    expect(getLane(db, segmentId, "lane-b")).not.toBeNull();
  });

  test("an unrelated tag on a member survives the fold untouched", () => {
    const t1 = seedTurn(1, { tags: ["home", "lane-a"] });

    mergeLaneTag(db, segmentId, "lane-a", "lane-b", NOW);

    expect(tagsOf(t1)).toEqual(["home", "lane-b"]);
  });

  test("both sides of an intra-lane edge move, and the side index moves with them", () => {
    const t1 = seedTurn(1, { tags: ["home", "lane-a"] });
    const t2 = seedTurn(2, { tags: ["home", "lane-a"] });
    const edge = seedEdge(t2, t1, { tailTag: "lane-a", headTag: "lane-a" });

    const receipt = mergeLaneTag(db, segmentId, "lane-a", "lane-b", NOW);

    expect(edgeSides(edge)).toEqual({ tailTag: "lane-b", headTag: "lane-b" });
    // An edge tagged on both sides counts TWICE: the side is the unit the
    // identity key is made of, and a per-row count would hide a one-sided
    // rewrite that should have been two.
    expect(receipt.edgeSidesRewritten).toBe(2);
    expect(sideIndexRows()).toEqual([
      { edgeRowId: edge, side: "head", tag: "lane-b" },
      { edgeRowId: edge, side: "tail", tag: "lane-b" },
    ]);
  });

  test("a CROSSING edge has exactly the folded side rewritten", () => {
    const t1 = seedTurn(1, { tags: ["home", "lane-a"] });
    const t2 = seedTurn(2, { tags: ["home", "other"] });
    insertLane(db, segmentId, "other", NOW);
    const edge = seedEdge(t1, t2, { tailTag: "lane-a", headTag: "other" });

    const receipt = mergeLaneTag(db, segmentId, "lane-a", "lane-b", NOW);

    expect(edgeSides(edge)).toEqual({ tailTag: "lane-b", headTag: "other" });
    expect(receipt.edgeSidesRewritten).toBe(1);
  });

  test("an UNSETTLED edge (both sides empty) is not touched and contributes no index row", () => {
    const t1 = seedTurn(1, { tags: ["home", "lane-a"] });
    const t2 = seedTurn(2, { tags: ["home", "lane-a"] });
    const edge = seedEdge(t2, t1);

    const receipt = mergeLaneTag(db, segmentId, "lane-a", "lane-b", NOW);

    expect(edgeSides(edge)).toEqual({ tailTag: "", headTag: "" });
    expect(receipt.edgeSidesRewritten).toBe(0);
    expect(sideIndexRows()).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Identity: (segment, tag), not a bare word
  // -------------------------------------------------------------------------

  test("the SAME WORD in another segment is another lane — its members and edge sides are left alone", () => {
    const other = createSegment(db, { title: "Elsewhere", tags: ["elsewhere"], nowEpoch: NOW }).id;
    insertLane(db, other, "lane-a", NOW);
    const mine = seedTurn(1, { tags: ["home", "lane-a"] });
    const theirs = seedTurn(2, { tags: ["elsewhere", "lane-a"], segment: other });
    // A second turn in the OTHER segment, so this edge stays wholly inside it.
    // It used to be seeded `theirs -> theirs`, which lane-model-v12 D2 (ticket
    // 04) makes unstorable — and the self-ness was incidental to what the test
    // asserts (that the other segment's lane-a is untouched), never its point.
    const theirsToo = seedTurn(3, { tags: ["elsewhere", "lane-a"], segment: other });
    const theirEdge = seedEdge(theirs, theirsToo, {});
    const crossEdge = seedEdge(theirs, mine, { tailTag: "lane-a", headTag: "lane-a" });

    mergeLaneTag(db, segmentId, "lane-a", "lane-b", NOW);

    expect(tagsOf(mine)).toEqual(["home", "lane-b"]);
    expect(tagsOf(theirs)).toEqual(["elsewhere", "lane-a"]);
    expect(getLane(db, other, "lane-a")).not.toBeNull();
    // The tail belongs to the OTHER segment's lane-a and stays; only the head,
    // whose endpoint this segment owns, moves.
    expect(edgeSides(crossEdge)).toEqual({ tailTag: "lane-a", headTag: "lane-b" });
    expect(edgeSides(theirEdge)).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // Collisions
  // -------------------------------------------------------------------------

  test("two edges landing on ONE identity key fold through the established rule: asserted survives, judged goes", () => {
    const t1 = seedTurn(1, { tags: ["home", "lane-a", "lane-b"] });
    const t2 = seedTurn(2, { tags: ["home", "lane-a", "lane-b"] });
    const viaA = seedEdge(t2, t1, {
      tailTag: "lane-a",
      headTag: "lane-a",
      provenance: "judged",
      createdAtEpoch: NOW - 100,
    });
    const viaB = seedEdge(t2, t1, {
      tailTag: "lane-b",
      headTag: "lane-b",
      provenance: "asserted",
      createdAtEpoch: NOW,
    });

    const receipt = mergeLaneTag(db, segmentId, "lane-a", "lane-b", NOW);

    expect(receipt.collisions).toHaveLength(1);
    const collision = receipt.collisions[0]!;
    // The ASSERTED row survives even though it is the LATER one — provenance
    // outranks age, which is exactly what "asserted 的审计元数据存活" means.
    expect(collision.keptEdgeId).toBe(viaB);
    expect(collision.droppedEdgeId).toBe(viaA);
    expect(collision.rule).toBe("provenance");
    expect(collision.keptProvenance).toBe("asserted");
    expect(collision.droppedProvenance).toBe("judged");
    expect(edgeSides(viaA)).toBeNull();
    expect(edgeSides(viaB)).toEqual({ tailTag: "lane-b", headTag: "lane-b" });
    // The casualty's side-index rows go with it — a lookup row pointing at a
    // deleted edge would attribute a lane through a row nobody can read.
    expect(sideIndexRows().every((row) => row.edgeRowId !== viaA)).toBe(true);
  });

  test("EQUAL provenance keeps the EARLIER row, and the receipt says which clause decided", () => {
    const t1 = seedTurn(1, { tags: ["home", "lane-a", "lane-b"] });
    const t2 = seedTurn(2, { tags: ["home", "lane-a", "lane-b"] });
    const earlier = seedEdge(t2, t1, {
      tailTag: "lane-b",
      headTag: "lane-b",
      provenance: "asserted",
      createdAtEpoch: NOW - 500,
    });
    const later = seedEdge(t2, t1, {
      tailTag: "lane-a",
      headTag: "lane-a",
      provenance: "asserted",
      createdAtEpoch: NOW,
    });

    const receipt = mergeLaneTag(db, segmentId, "lane-a", "lane-b", NOW);

    expect(receipt.collisions).toHaveLength(1);
    expect(receipt.collisions[0]!.keptEdgeId).toBe(earlier);
    expect(receipt.collisions[0]!.droppedEdgeId).toBe(later);
    expect(receipt.collisions[0]!.rule).toBe("earlier");
  });

  test("a different RELATION on the same pair is a different key — nothing is folded", () => {
    const t1 = seedTurn(1, { tags: ["home", "lane-a", "lane-b"] });
    const t2 = seedTurn(2, { tags: ["home", "lane-a", "lane-b"] });
    const extendsEdge = seedEdge(t2, t1, { tailTag: "lane-a", headTag: "lane-a" });
    const groundsEdge = seedEdge(t2, t1, {
      relation: "grounds",
      tailTag: "lane-b",
      headTag: "lane-b",
    });

    const receipt = mergeLaneTag(db, segmentId, "lane-a", "lane-b", NOW);

    expect(receipt.collisions).toEqual([]);
    expect(edgeSides(extendsEdge)).toEqual({ tailTag: "lane-b", headTag: "lane-b" });
    expect(edgeSides(groundsEdge)).toEqual({ tailTag: "lane-b", headTag: "lane-b" });
  });

  // -------------------------------------------------------------------------
  // Atomicity and order
  // -------------------------------------------------------------------------

  /**
   * FAILPOINT. "The final state is right" does not prove the three mutations
   * share a transaction — they could have committed one at a time and simply
   * all succeeded. The trigger aborts the LAST of the three (the registry
   * delete), and the assertion is that the FIRST one (the member retag) is not
   * there afterwards. Restart, without the failpoint, finishes it exactly once.
   */
  test("failpoint: the retag, the edge rewrite and the undeclare commit together or not at all", () => {
    const t1 = seedTurn(1, { tags: ["home", "lane-a"] });
    const t2 = seedTurn(2, { tags: ["home", "lane-a"] });
    const edge = seedEdge(t2, t1, { tailTag: "lane-a", headTag: "lane-a" });

    db.exec(
      `CREATE TRIGGER lane_merge_failpoint BEFORE DELETE ON lanes
       WHEN OLD.tag = 'lane-a'
       BEGIN SELECT RAISE(ABORT, 'injected crash'); END`,
    );

    expect(() =>
      runWriteTransaction(db, () => mergeLaneTag(db, segmentId, "lane-a", "lane-b", NOW)),
    ).toThrow(/injected crash/);

    // Nothing landed: both members still carry the folded tag, the edge still
    // names it on both sides, and the lane is still declared.
    expect(tagsOf(t1)).toEqual(["home", "lane-a"]);
    expect(tagsOf(t2)).toEqual(["home", "lane-a"]);
    expect(edgeSides(edge)).toEqual({ tailTag: "lane-a", headTag: "lane-a" });
    expect(getLane(db, segmentId, "lane-a")).not.toBeNull();
    expect(sideIndexRows()).toEqual([
      { edgeRowId: edge, side: "head", tag: "lane-a" },
      { edgeRowId: edge, side: "tail", tag: "lane-a" },
    ]);

    db.exec("DROP TRIGGER lane_merge_failpoint");
    runWriteTransaction(db, () => mergeLaneTag(db, segmentId, "lane-a", "lane-b", NOW));

    expect(tagsOf(t1)).toEqual(["home", "lane-b"]);
    expect(tagsOf(t2)).toEqual(["home", "lane-b"]);
    expect(edgeSides(edge)).toEqual({ tailTag: "lane-b", headTag: "lane-b" });
    expect(getLane(db, segmentId, "lane-a")).toBeNull();
  });

  /**
   * ORDER, pinned from the inside. This test states the invariant the guard
   * enforces — zero members at the moment the lane goes. The MUTATION it
   * answers is moving `undeclareEmptiedLane(db, segmentId, from)` above the
   * member loop in `mergeLaneTag`: every merge test in this file then throws
   * `LaneMergeInvariantError` instead of landing, because the guard is
   * evaluated while the members still carry the tag.
   */
  test("the undeclare answers to undeclare's own guard — zero members BEFORE the lane is taken away", () => {
    const t1 = seedTurn(1, { tags: ["home", "lane-a"] });
    expect(countLaneMemberTurnsInSegment(db, segmentId, "lane-a")).toBe(1);

    mergeLaneTag(db, segmentId, "lane-a", "lane-b", NOW);

    expect(countLaneMemberTurnsInSegment(db, segmentId, "lane-a")).toBe(0);
    expect(tagsOf(t1)).toEqual(["home", "lane-b"]);
    expect(LaneMergeInvariantError.prototype).toBeInstanceOf(Error);
  });

  /**
   * THE TAG WRITE RE-DERIVES MEMBERSHIP. `mergeLaneTag` writes `turns.tags`
   * with a raw UPDATE, which goes around `deriveTurnSegmentMembership` — the
   * function that keeps `tags` and `segment_members` from disagreeing. For an
   * ordinary merge nothing moves, so the call looks redundant; it is not.
   *
   * The state below is constructible today because nothing refuses declaring a
   * lane whose tag is ANOTHER segment's own tag (`insertLane` does not check
   * it, and the facade's `declare` only blocks the SAME segment's curated
   * tags). Fold into that word with the segment tag NOT first in the member's
   * tags, and the turn's derived home changes — drop the derivation call and
   * `segment_members` keeps pointing at the old segment while `tags` says
   * otherwise, which is the one state derivation may never produce.
   */
  test("a fold whose surviving word is another segment's tag re-derives the member's home", () => {
    const other = createSegment(db, { title: "Elsewhere", tags: ["elsewhere"], nowEpoch: NOW }).id;
    insertLane(db, segmentId, "elsewhere", NOW);
    // The segment tag is deliberately NOT first: derivation takes the first
    // tag that names a segment, so this is the ordering where the fold moves
    // the turn rather than leaving it.
    const t1 = seedTurn(1, { tags: ["lane-a", "home"] });

    mergeLaneTag(db, segmentId, "lane-a", "elsewhere", NOW);

    expect(tagsOf(t1)).toEqual(["elsewhere", "home"]);
    expect(
      db
        .query<{ segmentId: number }, [number]>(
          "SELECT segment_id AS segmentId FROM segment_members WHERE turn_id = ?",
        )
        .all(t1)
        .map((row) => row.segmentId),
    ).toEqual([other]);
  });

  test("a DORMANT member is retagged too — merge clears the word, it does not merely stop counting it", () => {
    const skipped = seedTurn(1, { tags: ["home", "lane-a"], status: "skipped" });
    // The Law-8 guard reads zero here, which is exactly why the retag cannot
    // be driven off that count: undeclare REFUSES and leaves, merge CLEARS.
    expect(countLaneMemberTurnsInSegment(db, segmentId, "lane-a")).toBe(0);

    const receipt = mergeLaneTag(db, segmentId, "lane-a", "lane-b", NOW);

    expect(tagsOf(skipped)).toEqual(["home", "lane-b"]);
    expect(receipt.turnsRetagged).toBe(1);
  });
});
