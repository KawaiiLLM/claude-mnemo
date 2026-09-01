import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { getLane, insertLane } from "../../src/db/lanes";
import { writeMemoryEdges } from "../../src/db/memory-edges";
import { searchMemory } from "../../src/db/search";
import { initializeSchema } from "../../src/db/schema";
import {
  addSegmentMembers,
  appendSegmentWorkingStateRows,
  attachSegmentToSession,
  createSegment,
  getAttachedSegmentIds,
  getSegment,
  getSegmentMemberTurnIds,
  mergeSegments,
  replaceSegmentTaskImpression,
  SegmentMergeInvariantError,
  writeSegmentWorkingStateField,
} from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import {
  checkFieldGate,
  recordFieldCompleteness,
  recordReadGrant,
  sessionWriterId,
  snapshotWriteGateSequence,
  stampField,
} from "../../src/db/write-gate";

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
    expect(outcome.receipt).toEqual({
      from,
      into,
      membersMoved: 1,
      lanesMoved: 1,
      stillCarrying: [],
    });

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

  // ===========================================================================
  // Fields, derived state, write authorization (ticket 09, spec D6 pop. 3/5, D7)
  // ===========================================================================

  function seedTurnWithType(promptNumber: number, tags: string[], type: string[]): number {
    const id = seedTurn(promptNumber, tags);
    db.query<unknown, [string, number]>("UPDATE turns SET type = ? WHERE id = ?").run(
      JSON.stringify(type),
      id,
    );
    return id;
  }

  function writeGateRowCount(table: string, entityId: number): number {
    return (
      db
        .query<{ n: number }, [number]>(
          `SELECT COUNT(*) AS n FROM ${table} WHERE entity_type = 'segment' AND entity_id = ?`,
        )
        .get(entityId)?.n ?? 0
    );
  }

  function ftsRowCount(segmentId: number): number {
    return (
      db
        .query<{ n: number }, [number]>(
          `SELECT COUNT(*) AS n FROM memory_fts WHERE layer = 'segment' AND source_id = ?`,
        )
        .get(segmentId)?.n ?? 0
    );
  }

  test("D7: row-list fields append+dedupe, prose fields blank-line-append, title stays `into`'s", () => {
    const from = createSegment(db, { title: "From title", tags: ["from-seg7"], nowEpoch: NOW }).id;
    const into = createSegment(db, { title: "Into title", tags: ["into-seg7"], nowEpoch: NOW }).id;

    appendSegmentWorkingStateRows(db, into, "goal", ["shared goal", "into-only goal"], NOW);
    appendSegmentWorkingStateRows(db, from, "goal", ["shared goal", "from-only goal"], NOW);
    // The content slot is the TASK-TIER IMPRESSION (lane-impressions ticket
    // 05) — settlement's write, not a Working State field — and it folds by
    // the impression join (ONE newline), never the blank-line prose merge.
    replaceSegmentTaskImpression(db, {
      segmentId: into,
      baseRevision: 0,
      text: "Into content.",
      nowEpoch: NOW,
    });
    replaceSegmentTaskImpression(db, {
      segmentId: from,
      baseRevision: 0,
      text: "From content.",
      nowEpoch: NOW,
    });
    writeSegmentWorkingStateField(db, from, "insight", "From insight only.", NOW);

    const outcome = mergeSegments(db, from, into, NOW);
    expect(outcome.kind).toBe("merged");

    const merged = getSegment(db, into)!;
    expect(merged.title).toBe("Into title");
    expect(merged.goal).toBe("- shared goal\n- into-only goal\n- from-only goal");
    expect(merged.content).toBe("Into content.\nFrom content.");
    // `into.insight` was never written (null) — the one-sided carry takes
    // `from`'s bytes verbatim, no gratuitous blank line.
    expect(merged.insight).toBe("From insight only.");
  });

  test("D6 pop. 2: `into`'s `type` is recomputed from ALL its members after the merge, never frozen", () => {
    const from = createSegment(db, { title: "From", tags: ["from-seg8"], nowEpoch: NOW }).id;
    const into = createSegment(db, { title: "Into", tags: ["into-seg8"], nowEpoch: NOW }).id;
    const t1 = seedTurnWithType(1, ["from-seg8"], ["fix"]);
    const t2 = seedTurnWithType(2, ["into-seg8"], ["design"]);
    addSegmentMembers(db, from, [t1], NOW);
    addSegmentMembers(db, into, [t2], NOW);
    expect(getSegment(db, into)!.type).toEqual(["design"]);

    const outcome = mergeSegments(db, from, into, NOW);
    expect(outcome.kind).toBe("merged");

    expect([...getSegment(db, into)!.type].sort()).toEqual(["design", "fix"]);
  });

  /**
   * THE MEASURED BEFORE/AFTER (ticket 09's own acceptance line): `into`'s
   * `type` recompute in step 2 reindexes once, before step 3 lands the field
   * text — this asserts the FINAL projection, after step 5's reindex, is the
   * one a reader actually sees. The MUTATION this answers is deleting step
   * 5's `indexSegment(db, mergedFields)` call: with it gone, `before` still
   * finds `from` (nothing changed there) but `after` finds NEITHER — `from`
   * is gone and `into`'s projection was never corrected — so this test reds.
   */
  test("D6 pop. 5: `into` is reindexed AFTER fields settle — the source's FTS hit disappears, the destination's appears", () => {
    const from = createSegment(db, { title: "From FTS", tags: ["from-seg9"], nowEpoch: NOW }).id;
    const into = createSegment(db, { title: "Into FTS", tags: ["into-seg9"], nowEpoch: NOW }).id;
    replaceSegmentTaskImpression(db, {
      segmentId: from,
      baseRevision: 0,
      text: "zzzmarkersource content",
      nowEpoch: NOW,
    });

    const before = searchMemory(db, { query: "zzzmarkersource", scope: "segments" }).filter(
      (r) => r.layer === "segment",
    );
    expect(before.map((r) => r.sourceId)).toEqual([from]);

    const outcome = mergeSegments(db, from, into, NOW);
    expect(outcome.kind).toBe("merged");

    const after = searchMemory(db, { query: "zzzmarkersource", scope: "segments" }).filter(
      (r) => r.layer === "segment",
    );
    expect(after.map((r) => r.sourceId)).toEqual([into]);
  });

  test("D6 pop. 5: `from`'s memory_fts row and its three write_gate_* rows do not survive the merge", () => {
    const from = createSegment(db, { title: "From WG", tags: ["from-seg10"], nowEpoch: NOW }).id;
    const into = createSegment(db, { title: "Into WG", tags: ["into-seg10"], nowEpoch: NOW }).id;

    stampField(db, "segment", from, "content", "session:1", NOW);
    recordReadGrant(db, "session:1", "segment", from, NOW, 1);
    recordFieldCompleteness(
      db,
      "session:1",
      [{ entityType: "segment", entityId: from, field: "content", complete: true }],
      NOW,
      1,
    );

    expect(ftsRowCount(from)).toBe(1);
    expect(writeGateRowCount("write_gate_reads", from)).toBe(1);
    expect(writeGateRowCount("write_gate_stamps", from)).toBe(1);
    expect(writeGateRowCount("write_gate_field_completeness", from)).toBe(1);

    const outcome = mergeSegments(db, from, into, NOW);
    expect(outcome.kind).toBe("merged");

    expect(ftsRowCount(from)).toBe(0);
    expect(writeGateRowCount("write_gate_reads", from)).toBe(0);
    expect(writeGateRowCount("write_gate_stamps", from)).toBe(0);
    expect(writeGateRowCount("write_gate_field_completeness", from)).toBe(0);
  });

  /**
   * The scenario D6/ticket 09 population 5 names by name: a writer who read
   * `into.insight` whole BEFORE the merge still holds a grant afterward.
   * Without the stamp this function's own doc comment describes, that grant
   * would still admit ("stamp.writeSequence > grant.readSequence" would be
   * false), and the writer could silently land the PRE-merge text back over
   * what the merge just imported.
   *
   * `insight` rather than `content` since lane-impressions ticket 05: the
   * content slot is settlement's, not a gated main-agent field, so there is no
   * grant to invalidate there.
   */
  test("D6 pop. 5: a grant taken before the merge cannot silently overwrite the field it changed", () => {
    const from = createSegment(db, { title: "From Stamp", tags: ["from-seg11"], nowEpoch: NOW }).id;
    const into = createSegment(db, { title: "Into Stamp", tags: ["into-seg11"], nowEpoch: NOW }).id;
    writeSegmentWorkingStateField(db, into, "insight", "into original insight", NOW);
    writeSegmentWorkingStateField(db, from, "insight", "from insight to import", NOW);

    const readerWriter = sessionWriterId(42);
    const grantSequence = snapshotWriteGateSequence(db);
    recordReadGrant(db, readerWriter, "segment", into, NOW, grantSequence);

    const mergeWriter = sessionWriterId(7);
    const outcome = mergeSegments(db, from, into, NOW, { writer: mergeWriter });
    expect(outcome.kind).toBe("merged");

    const verdict = checkFieldGate(db, readerWriter, "segment", into, "insight", `E${into}`);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe("stale");
    }
  });

  test("D6 pop. 5: a field this merge did not change is NOT stamped — no false staleness for an untouched field", () => {
    const from = createSegment(db, { title: "From Stamp2", tags: ["from-seg11b"], nowEpoch: NOW }).id;
    const into = createSegment(db, { title: "Into Stamp2", tags: ["into-seg11b"], nowEpoch: NOW }).id;
    // `goal`/`constraints`/`reference` hold nothing on either side — merging
    // produces `null` again, so nothing about them changed. `insight` is
    // written on `into` ONLY, and a one-sided carry leaves `into`'s own bytes
    // untouched, so it is not stamped either.
    writeSegmentWorkingStateField(db, into, "insight", "into insight", NOW);
    // The write above stamps `insight` itself; clear the ledger so the merge
    // is the only writer this assertion can be measuring.
    db.query("DELETE FROM write_gate_stamps WHERE entity_type = 'segment' AND entity_id = ?").run(
      into,
    );

    const outcome = mergeSegments(db, from, into, NOW, { writer: sessionWriterId(7) });
    expect(outcome.kind).toBe("merged");

    expect(writeGateRowCount("write_gate_stamps", into)).toBe(0);
  });

  // ===========================================================================
  // The same-name lane collision and `force` (ticket 10, spec D6 pop. 1/6a, D8)
  // ===========================================================================

  test("force: without it, refusal names only the colliding lanes; with it, colliding lanes fold and the free lane still relocates", () => {
    const from = createSegment(db, { title: "From", tags: ["from-seg12"], nowEpoch: NOW }).id;
    const into = createSegment(db, { title: "Into", tags: ["into-seg12"], nowEpoch: NOW }).id;
    insertLane(db, from, "alpha", NOW);
    insertLane(db, from, "beta", NOW);
    insertLane(db, from, "gamma", NOW);
    insertLane(db, into, "alpha", NOW);
    insertLane(db, into, "beta", NOW);

    const refused = mergeSegments(db, from, into, NOW);
    expect(refused).toEqual({ kind: "lane-collision", tags: ["alpha", "beta"] });
    // Refused: nothing moved, `gamma` (the free lane) is untouched too.
    expect(getSegment(db, from)).not.toBeNull();
    expect(getLane(db, from, "gamma")).not.toBeNull();

    const outcome = mergeSegments(db, from, into, NOW, { force: true });
    expect(outcome.kind).toBe("merged");
    if (outcome.kind !== "merged") throw new Error("unreachable");
    expect(outcome.receipt.lanesMoved).toBe(3);

    expect(getSegment(db, from)).toBeNull();
    // `from`'s copies of the colliding names are gone; `into`'s survive.
    expect(getLane(db, from, "alpha")).toBeNull();
    expect(getLane(db, from, "beta")).toBeNull();
    expect(getLane(db, into, "alpha")).not.toBeNull();
    expect(getLane(db, into, "beta")).not.toBeNull();
    // The free lane relocated onto `into`, same as the non-colliding path.
    expect(getLane(db, from, "gamma")).toBeNull();
    expect(getLane(db, into, "gamma")).not.toBeNull();
  });

  /**
   * D6/D8's own explanation for why the branch takes no new primitive: once
   * step 2 moves the member, the edge's bare side tag resolves to `into`
   * through the endpoint's OWNING segment — `into`'s own pre-existing
   * "contested2" lane, never `from`'s, which this test's OWN mutation
   * (removing the branch and directly relocating `from`'s row instead)
   * would hit `UNIQUE(segment_id, tag)` trying to declare a second time.
   */
  test("force: a lane-tagged edge on the colliding lane survives with NEITHER side rewritten", () => {
    const from = createSegment(db, { title: "From", tags: ["from-seg13"], nowEpoch: NOW }).id;
    const into = createSegment(db, { title: "Into", tags: ["into-seg13"], nowEpoch: NOW }).id;
    insertLane(db, from, "contested2", NOW);
    insertLane(db, into, "contested2", NOW);
    const t1 = seedTurn(1, ["from-seg13", "contested2"]);
    const t2 = seedTurn(2, ["from-seg13", "contested2"]);
    addSegmentMembers(db, from, [t1, t2], NOW);
    const written = writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: t2 },
          cited: { kind: "turn", id: t1 },
          relation: "extends",
          provenance: "asserted",
          tailTag: "contested2",
          headTag: "contested2",
        },
      ],
      NOW,
    );
    const edgeId = written.written[0]!.id;

    const outcome = mergeSegments(db, from, into, NOW, { force: true });
    expect(outcome.kind).toBe("merged");

    const sides = db
      .query<{ tailTag: string; headTag: string }, [number]>(
        "SELECT tail_tag AS tailTag, head_tag AS headTag FROM memory_edges WHERE id = ?",
      )
      .get(edgeId)!;
    expect(sides).toEqual({ tailTag: "contested2", headTag: "contested2" });
    expect(getLane(db, from, "contested2")).toBeNull();
    expect(getLane(db, into, "contested2")).not.toBeNull();
    expect(owningSegments(t1)).toEqual([into]);
    expect(owningSegments(t2)).toEqual([into]);
  });

  test("force is only a warning override — a caller may send it on the FIRST call, before any refusal ever rendered the list", () => {
    const from = createSegment(db, { title: "From", tags: ["from-seg14"], nowEpoch: NOW }).id;
    const into = createSegment(db, { title: "Into", tags: ["into-seg14"], nowEpoch: NOW }).id;
    insertLane(db, from, "delta", NOW);
    insertLane(db, into, "delta", NOW);

    // No prior refused call — `force: true` on the very first attempt.
    const outcome = mergeSegments(db, from, into, NOW, { force: true });
    expect(outcome.kind).toBe("merged");
    expect(getLane(db, from, "delta")).toBeNull();
    expect(getLane(db, into, "delta")).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // `stillCarrying` — lane-merge-skip-receipt ticket 01, criterion 4. The
  // SAME hole as `db/lanes.ts`'s `mergeLaneTag`, reviewed here and fixed the
  // same way: population 2's member SELECT keys off `segment_members` alone,
  // so a turn whose own `tags` name `from`'s task tag without a membership
  // row disagrees with it and is never moved — silently, until now.
  // -------------------------------------------------------------------------
  describe("stillCarrying — turns the fold never reached", () => {
    test("a turn tagged with `from`'s task tag but never added as a member is reported, while an actual member is not", () => {
      const from = createSegment(db, { title: "From", tags: ["from-seg"], nowEpoch: NOW }).id;
      const into = createSegment(db, { title: "Into", tags: ["into-seg"], nowEpoch: NOW }).id;
      const member = seedTurn(1, ["from-seg"]);
      addSegmentMembers(db, from, [member], NOW);
      // No `addSegmentMembers` call — tagged with `from-seg` but no
      // `segment_members` row, the exact shape the incident measured.
      const orphan = seedTurn(2, ["from-seg"]);

      const outcome = mergeSegments(db, from, into, NOW);

      expect(outcome.kind).toBe("merged");
      if (outcome.kind !== "merged") throw new Error("unreachable");
      expect(tagsOf(member)).toEqual(["into-seg"]);
      expect(tagsOf(orphan)).toEqual(["from-seg"]);
      expect(outcome.receipt.membersMoved).toBe(1);
      expect(outcome.receipt.stillCarrying).toEqual([`S${sessionId}/T2`]);
    });

    test("the zero case stays quiet: an ordinary merge with no orphan reports an empty list", () => {
      const from = createSegment(db, { title: "From", tags: ["from-seg2"], nowEpoch: NOW }).id;
      const into = createSegment(db, { title: "Into", tags: ["into-seg2"], nowEpoch: NOW }).id;
      const member = seedTurn(1, ["from-seg2"]);
      addSegmentMembers(db, from, [member], NOW);

      const outcome = mergeSegments(db, from, into, NOW);

      expect(outcome.kind).toBe("merged");
      if (outcome.kind !== "merged") throw new Error("unreachable");
      expect(outcome.receipt.stillCarrying).toEqual([]);
    });

    test("an orphan surfaces even when `from` has NO registered member at all", () => {
      const from = createSegment(db, { title: "From", tags: ["from-seg3"], nowEpoch: NOW }).id;
      const into = createSegment(db, { title: "Into", tags: ["into-seg3"], nowEpoch: NOW }).id;
      const orphan = seedTurn(1, ["from-seg3"]);
      void orphan;

      const outcome = mergeSegments(db, from, into, NOW);

      expect(outcome.kind).toBe("merged");
      if (outcome.kind !== "merged") throw new Error("unreachable");
      expect(outcome.receipt.membersMoved).toBe(0);
      expect(outcome.receipt.stillCarrying).toEqual([`S${sessionId}/T1`]);
    });
  });
});
