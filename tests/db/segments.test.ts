import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { getOutgoingEdges, writeMemoryEdges } from "../../src/db/memory-edges";
import { initializeSchema } from "../../src/db/schema";
import {
  addSegmentMembers,
  applySegmentWrites,
  countLiveSegments,
  createSegment,
  getSegment,
  getSegmentMemberTurnIds,
  getSegmentsForTurn,
  isLiveSegmentEra,
  listLiveSegmentsByActivity,
  SEGMENT_CONTAINER_ERA_CUTOFF_EPOCH,
  listOpenSegments,
  listRecentSegments,
  repairStaleSegmentFacets,
  toggleSegmentStatus,
} from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { resetTurnExtractionFields, updateTurnById } from "../../src/db/turns";
import { normalizeTypeValues } from "../../src/shared/type-vocabulary";

describe("segments and membership", () => {
  let db: Database;
  let sessionId: number;

  function addTurn(
    promptNumber: number,
    createdAtEpoch = 100,
    facets: { type?: string[]; tags?: string[] } = {},
  ): number {
    return db
      .query<{ id: number }, [number, number, number, string, string]>(
        `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch, type, tags)
         VALUES (?, ?, 'extracted', ?, ?, ?)
         RETURNING id`,
      )
      .get(
        sessionId,
        promptNumber,
        createdAtEpoch,
        JSON.stringify(facets.type ?? []),
        JSON.stringify(facets.tags ?? []),
      )!.id;
  }

  /** The search facet as stored — what a `tag:`/`type:` query actually reads. */
  function readSegmentFtsExtra(segmentId: number): string {
    return (
      db
        .query<{ extra: string | null }, [number]>(
          "SELECT extra FROM memory_fts WHERE layer = 'segment' AND source_id = ?",
        )
        .get(segmentId)?.extra ?? ""
    );
  }

  /** Ticket 15: the storage-level record that a derivation is owed. */
  function readFacetsStale(segmentId: number): number {
    return db
      .query<{ facetsStale: number }, [number]>(
        "SELECT facets_stale AS facetsStale FROM segments WHERE id = ?",
      )
      .get(segmentId)!.facetsStale;
  }

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "session-segments",
      project: "/tmp/project",
      title: null,
      content: null,
      insight: null,
      nextSteps: null,
      createdAtEpoch: 100,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  // ticket 02 (spec B1/B5): the mechanical title-to-type derivation is
  // retired, not kept as a fallback — a segment's `type` is exactly what the
  // caller states, multi-valued, and empty when omitted.
  describe("normalizeTypeValues (spec B2/B7)", () => {
    test("validates against the current 11-word vocabulary, deduping and preserving order", () => {
      expect(normalizeTypeValues(["review", "ops", "review"])).toEqual([
        "review",
        "ops",
      ]);
      expect(() => normalizeTypeValues(["invented"])).toThrow("unknown type value");
    });

    test("rolled-back left the vocabulary; correction is an ordinary peer, no restriction", () => {
      expect(() => normalizeTypeValues(["rolled-back"])).toThrow(
        "unknown type value",
      );
      expect(normalizeTypeValues(["correction"])).toEqual(["correction"]);
    });
  });

  // Ticket 14 (spec K5a) narrowed what this describe covers: `type` is still
  // exactly what a DIRECT caller of these storage functions states (a fixture,
  // a repair), but no production writer states it any more — the settlement
  // tool cannot, and `addSegmentMembers` overwrites it from the members. The
  // derivation has its own describe below.
  describe("a segment's type is exactly what the caller states", () => {
    test("an explicit multi-valued type lands as given", () => {
      const segment = createSegment(db, {
        title: "实现 段成员边表",
        type: ["implement", "review"],
        nowEpoch: 100,
      });

      expect(segment.type).toEqual(["implement", "review"]);
    });

    test("an omitted type is empty — never a guess derived from the title", () => {
      const segment = createSegment(db, {
        title: "竞态问题的三个候选",
        nowEpoch: 100,
      });

      expect(segment.type).toEqual([]);
    });

    test("an open-segment write rejects an unrecognised word without touching the row", () => {
      const segment = createSegment(db, {
        title: "设计 段结算流程",
        type: ["design"],
        nowEpoch: 100,
      });

      const result = applySegmentWrites(
        db,
        [
          {
            segmentId: segment.id,
            expectedRevision: segment.revision,
            type: ["invented"],
          },
        ],
        { nowEpoch: 200 },
      );

      expect(result.applied).toHaveLength(0);
      expect(result.excluded[0]?.reason).toBe("invalid-type");
      expect(getSegment(db, segment.id)?.revision).toBe(segment.revision);
      expect(getSegment(db, segment.id)?.type).toEqual(["design"]);

      const settled = applySegmentWrites(
        db,
        [
          {
            segmentId: segment.id,
            expectedRevision: segment.revision,
            type: ["design", "correction"],
          },
        ],
        { nowEpoch: 300 },
      );
      expect(settled.applied[0]?.type).toEqual(["design", "correction"]);
    });
  });

  describe("membership", () => {
    test("is many-to-many, idempotent, and ordered by turn time", () => {
      const early = addTurn(1, 100);
      const late = addTurn(2, 900);
      const first = createSegment(db, { title: "实现 检索边", nowEpoch: 100 });
      const second = createSegment(db, { title: "评审 检索边", nowEpoch: 100 });

      expect(addSegmentMembers(db, first.id, [late, early], 100)).toHaveLength(2);
      expect(addSegmentMembers(db, first.id, [late], 200)).toHaveLength(0);
      addSegmentMembers(db, second.id, [late], 200);

      expect(getSegmentMemberTurnIds(db, first.id)).toEqual([early, late]);
      expect(getSegmentsForTurn(db, late).map((segment) => segment.id)).toEqual([
        first.id,
        second.id,
      ]);
    });

    test("a deleted turn takes its membership with it", () => {
      const turnId = addTurn(1);
      const segment = createSegment(db, { title: "实现 X", nowEpoch: 100 });
      addSegmentMembers(db, segment.id, [turnId], 100);

      db.query("PRAGMA foreign_keys = ON").run();
      db.query("DELETE FROM turns WHERE id = ?").run(turnId);

      expect(getSegmentMemberTurnIds(db, segment.id)).toEqual([]);
      expect(getSegment(db, segment.id)).not.toBeNull();
    });
  });

  describe("revision CAS on open segments", () => {
    test("the second concurrent writer is excluded and gets the latest body back", () => {
      const segment = createSegment(db, {
        title: "实现 结算写回",
        content: "first draft",
        nowEpoch: 100,
      });
      // Both writers read the same revision — the classic lost-update race.
      const readByA = segment.revision;
      const readByB = segment.revision;

      const writerA = applySegmentWrites(
        db,
        [
          {
            segmentId: segment.id,
            expectedRevision: readByA,
            content: "A's rewrite",
          },
        ],
        { nowEpoch: 200 },
      );
      const writerB = applySegmentWrites(
        db,
        [
          {
            segmentId: segment.id,
            expectedRevision: readByB,
            content: "B's rewrite",
          },
        ],
        { nowEpoch: 300 },
      );

      expect(writerA.applied[0]?.content).toBe("A's rewrite");
      expect(writerA.applied[0]?.revision).toBe(readByA + 1);
      expect(writerB.applied).toHaveLength(0);
      expect(writerB.excluded[0]?.reason).toBe("revision-conflict");
      // The rejected writer gets the row as it stands, so it can replay just
      // this segment's judgement instead of redoing its whole window.
      expect(writerB.excluded[0]?.latest?.content).toBe("A's rewrite");
      expect(writerB.excluded[0]?.latest?.revision).toBe(readByA + 1);
      expect(getSegment(db, segment.id)?.content).toBe("A's rewrite");
    });

    test("a conflict excludes only its own segment; the batch's other writes commit", () => {
      const conflicted = createSegment(db, { title: "实现 A", nowEpoch: 100 });
      const untouched = createSegment(db, { title: "实现 B", nowEpoch: 100 });
      const staleRevision = conflicted.revision;

      applySegmentWrites(
        db,
        [{ segmentId: conflicted.id, expectedRevision: staleRevision, content: "moved on" }],
        { nowEpoch: 150 },
      );

      const batch = applySegmentWrites(
        db,
        [
          { segmentId: conflicted.id, expectedRevision: staleRevision, content: "late" },
          { segmentId: untouched.id, expectedRevision: untouched.revision, content: "kept" },
          { segmentId: 9999, expectedRevision: 1, content: "nowhere" },
        ],
        { nowEpoch: 200 },
      );

      expect(batch.applied.map((segment) => segment.id)).toEqual([untouched.id]);
      expect(batch.excluded.map((entry) => entry.reason)).toEqual([
        "revision-conflict",
        "missing",
      ]);
      expect(getSegment(db, untouched.id)?.content).toBe("kept");
      expect(getSegment(db, conflicted.id)?.content).toBe("moved on");
    });

    test("a closed segment is frozen against rewrites", () => {
      const segment = createSegment(db, { title: "实现 收口段", nowEpoch: 100 });
      const closed = applySegmentWrites(
        db,
        [
          {
            segmentId: segment.id,
            expectedRevision: segment.revision,
            status: "closed",
          },
        ],
        { nowEpoch: 200 },
      );
      expect(closed.applied[0]?.status).toBe("closed");

      const rewrite = applySegmentWrites(
        db,
        [
          {
            segmentId: segment.id,
            expectedRevision: closed.applied[0]!.revision,
            content: "history rewritten",
          },
        ],
        { nowEpoch: 300 },
      );

      expect(rewrite.applied).toHaveLength(0);
      expect(rewrite.excluded[0]?.reason).toBe("frozen");
      expect(getSegment(db, segment.id)?.content).toBeNull();
      expect(listOpenSegments(db)).toHaveLength(0);
    });
  });

  // Spec C6: a segment's title/content is its whole citation-bearing surface.
  // Creation and `applySegmentWrites`' rewrite both reconcile `memory_edges`
  // against it — a bare `[S<session>/T<n>]`/`[E<n>]` creates the pair, and a
  // rewrite that stops naming it drops the pair.
  describe("insight is a segment field with its own citation surface (spec K5/K7, ticket 14)", () => {
    test("a create stores it, and an extend rewrites it under the same present/omitted rule", () => {
      const segment = createSegment(db, {
        title: "lease fencing",
        content: "the working state",
        insight: "a generation check beats a timestamp",
        nowEpoch: 100,
      });
      expect(segment.insight).toBe("a generation check beats a timestamp");
      expect(getSegment(db, segment.id)?.insight).toBe(
        "a generation check beats a timestamp",
      );

      // Omitted leaves it alone...
      const untouched = applySegmentWrites(
        db,
        [{ segmentId: segment.id, expectedRevision: segment.revision, title: "renamed" }],
        { nowEpoch: 200 },
      );
      expect(untouched.applied[0]?.insight).toBe("a generation check beats a timestamp");

      // ...present overwrites whole, and null clears.
      const rewritten = applySegmentWrites(
        db,
        [
          {
            segmentId: segment.id,
            expectedRevision: untouched.applied[0]!.revision,
            insight: "the timestamp route was ruled out: clocks are not fences",
          },
        ],
        { nowEpoch: 300 },
      );
      expect(rewritten.applied[0]?.insight).toBe(
        "the timestamp route was ruled out: clocks are not fences",
      );
      const cleared = applySegmentWrites(
        db,
        [
          {
            segmentId: segment.id,
            expectedRevision: rewritten.applied[0]!.revision,
            insight: null,
          },
        ],
        { nowEpoch: 400 },
      );
      expect(cleared.applied[0]?.insight).toBeNull();
    });

    test("a citation written in insight becomes a real pair — the whole point of admitting it to the scan in the same change (spec K7)", () => {
      const cited = addTurn(7);

      const segment = createSegment(db, {
        title: "lease fencing",
        content: "no citation here",
        insight: `The retry route was ruled out by [S${sessionId}/T7].`,
        nowEpoch: 100,
      });

      const edges = getOutgoingEdges(db, { kind: "segment", id: segment.id });
      expect(edges).toHaveLength(1);
      expect(edges[0]?.cited).toEqual({ kind: "turn", id: cited });
      expect(edges[0]?.relation).toBeNull();
      expect(edges[0]?.provenance).toBe("text-ref");
    });

    test("a rewrite that drops the insight citation drops its pair, same as title/content", () => {
      const cited = addTurn(7);
      const segment = createSegment(db, {
        title: "lease fencing",
        insight: `Ruled out by [S${sessionId}/T7].`,
        nowEpoch: 100,
      });
      expect(getOutgoingEdges(db, { kind: "segment", id: segment.id })).toHaveLength(1);

      applySegmentWrites(
        db,
        [
          {
            segmentId: segment.id,
            expectedRevision: segment.revision,
            insight: "Ruled out, and the reason no longer names a turn.",
          },
        ],
        { nowEpoch: 200 },
      );

      expect(getOutgoingEdges(db, { kind: "segment", id: segment.id })).toHaveLength(0);
      expect(cited).toBeGreaterThan(0);
    });

    test("insight is indexed, so a segment is findable by what it concluded", () => {
      const segment = createSegment(db, {
        title: "lease fencing",
        insight: "clocks are not fences",
        nowEpoch: 100,
      });

      const extra = db
        .query<{ extra: string | null }, [number]>(
          "SELECT extra FROM memory_fts WHERE layer = 'segment' AND source_id = ?",
        )
        .get(segment.id)!.extra;
      expect(extra).toContain("clocks are not fences");
    });
  });

  describe("type and tags are DERIVED from the members (spec K5a, ticket 14)", () => {
    test("type is the members' union, tags are frequency-ordered, both recomputed on membership change", () => {
      const first = addTurn(1, 100, { type: ["design"], tags: ["lease", "fencing"] });
      const second = addTurn(2, 200, { type: ["implement"], tags: ["lease"] });
      const third = addTurn(3, 300, { type: ["implement"], tags: ["lease"] });
      const segment = createSegment(db, { title: "lease fencing", nowEpoch: 100 });

      // No members yet: nothing to derive from, and nothing invented.
      expect(getSegment(db, segment.id)?.type).toEqual([]);
      expect(getSegment(db, segment.id)?.tags).toEqual([]);

      addSegmentMembers(db, segment.id, [first, second], 100);
      expect(getSegment(db, segment.id)?.type).toEqual(["design", "implement"]);
      // lease on both members, fencing on one.
      expect(getSegment(db, segment.id)?.tags).toEqual(["lease", "fencing"]);

      // A third member moves implement ahead of design by frequency — the
      // recomputation is what makes this a fact about membership rather than
      // about the order the members happened to arrive in.
      addSegmentMembers(db, segment.id, [third], 200);
      expect(getSegment(db, segment.id)?.type).toEqual(["implement", "design"]);
    });

    test("ties break deterministically: vocabulary order for type, the tag itself for tags", () => {
      const only = addTurn(1, 100, {
        type: ["fix", "research"],
        tags: ["zulu", "alpha"],
      });
      const segment = createSegment(db, { title: "tie", nowEpoch: 100 });
      addSegmentMembers(db, segment.id, [only], 100);

      // research precedes fix in MEMORY_TYPES; alpha precedes zulu.
      expect(getSegment(db, segment.id)?.type).toEqual(["research", "fix"]);
      expect(getSegment(db, segment.id)?.tags).toEqual(["alpha", "zulu"]);
    });

    test("a colon-namespaced tag is bookkeeping and never becomes what a segment is about", () => {
      const turnId = addTurn(1, 100, {
        type: ["ops"],
        tags: ["release", "compact:boundary", "topic:retired"],
      });
      const segment = createSegment(db, { title: "release", nowEpoch: 100 });
      addSegmentMembers(db, segment.id, [turnId], 100);

      expect(getSegment(db, segment.id)?.tags).toEqual(["release"]);
    });

    test("a legacy type word a pre-vocabulary member still carries does not propagate upward", () => {
      const legacy = addTurn(1, 100, { type: ["bugfix"] });
      const current = addTurn(2, 200, { type: ["fix"] });
      const segment = createSegment(db, { title: "legacy", nowEpoch: 100 });
      addSegmentMembers(db, segment.id, [legacy, current], 100);

      // `normalizeTypeValues` would refuse `bugfix` on the next write, so a
      // segment that stored it would be unwritable.
      expect(getSegment(db, segment.id)?.type).toEqual(["fix"]);
    });

    test("the FTS facet is rewritten with the derived tags, never left describing the old membership", () => {
      const first = addTurn(1, 100, { tags: ["lease"] });
      const second = addTurn(2, 200, { tags: ["fencing"] });
      const segment = createSegment(db, { title: "lease fencing", nowEpoch: 100 });
      addSegmentMembers(db, segment.id, [first], 100);

      const readFacet = () =>
        db
          .query<{ extra: string | null }, [number]>(
            "SELECT extra FROM memory_fts WHERE layer = 'segment' AND source_id = ?",
          )
          .get(segment.id)!.extra ?? "";

      expect(readFacet()).toContain("lease");
      expect(readFacet()).not.toContain("fencing");

      addSegmentMembers(db, segment.id, [second], 200);
      expect(readFacet()).toContain("fencing");
    });

    test("recomputation follows a member LEAVING too — a deleted turn is a membership change", () => {
      const kept = addTurn(1, 100, { type: ["design"], tags: ["lease"] });
      const removed = addTurn(2, 200, { type: ["ops"], tags: ["release"] });
      const segment = createSegment(db, { title: "lease fencing", nowEpoch: 100 });
      addSegmentMembers(db, segment.id, [kept, removed], 100);
      expect(getSegment(db, segment.id)?.type).toEqual(["design", "ops"]);

      db.query("PRAGMA foreign_keys = ON").run();
      db.query("DELETE FROM turns WHERE id = ?").run(removed);

      // Ticket 15 finding 2. This test used to assert the STALE state here and
      // then hand-call `recomputeSegmentFacets`, which made it pass over a
      // production path that never recomputed at all. Nothing is hand-called
      // now: the deletion cascades `segment_members`, the trigger records the
      // debt, and the production sweep — the same one `initializeSchema` runs
      // — is the only repair invoked.
      expect(readFacetsStale(segment.id)).toBe(1);
      expect(repairStaleSegmentFacets(db)).toBe(1);

      expect(getSegment(db, segment.id)?.type).toEqual(["design"]);
      expect(getSegment(db, segment.id)?.tags).toEqual(["lease"]);
      expect(readFacetsStale(segment.id)).toBe(0);
      // The search facet, not just the stored row: a segment left findable by
      // the deleted member's tag is half the bug.
      expect(readSegmentFtsExtra(segment.id)).toContain("lease");
      expect(readSegmentFtsExtra(segment.id)).not.toContain("release");
    });

    test("a deleted SESSION reaches the debt the same way, through two cascades", () => {
      const other = upsertSession(db, {
        contentSessionId: "session-doomed",
        project: "/tmp/project",
        title: null,
        content: null,
        insight: null,
        nextSteps: null,
        createdAtEpoch: 100,
        updatedAtEpoch: null,
        completedAtEpoch: null,
      }).id;
      const doomed = db
        .query<{ id: number }, [number]>(
          `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch, type, tags)
           VALUES (?, 1, 'extracted', 200, '["ops"]', '["release"]') RETURNING id`,
        )
        .get(other)!.id;
      const kept = addTurn(1, 100, { type: ["design"], tags: ["lease"] });
      const segment = createSegment(db, { title: "lease fencing", nowEpoch: 100 });
      addSegmentMembers(db, segment.id, [kept, doomed], 100);
      expect(getSegment(db, segment.id)?.tags).toEqual(["lease", "release"]);

      db.query("PRAGMA foreign_keys = ON").run();
      db.query("DELETE FROM sessions WHERE id = ?").run(other);

      expect(repairStaleSegmentFacets(db)).toBe(1);
      expect(getSegment(db, segment.id)?.type).toEqual(["design"]);
      expect(getSegment(db, segment.id)?.tags).toEqual(["lease"]);
    });

    test("nothing owed is nothing done — the sweep is a no-op on a settled database", () => {
      const member = addTurn(1, 100, { type: ["design"], tags: ["lease"] });
      const segment = createSegment(db, { title: "lease fencing", nowEpoch: 100 });
      addSegmentMembers(db, segment.id, [member], 100);

      expect(readFacetsStale(segment.id)).toBe(0);
      expect(repairStaleSegmentFacets(db)).toBe(0);
    });
  });

  /**
   * Ticket 15 finding 1: the facets follow the members' CURRENT type and tags,
   * not the values they held when the membership was recorded.
   *
   * Every test here writes the member's facets AFTER membership exists, which
   * is the order the prompt's duty order discourages and nothing enforces —
   * a staged `segment(create, members=[T1])` replayed before the `note` that
   * types T1, and a later settlement window revising an earlier turn's type,
   * which duty 1 explicitly invites.
   */
  describe("a member's facets moving after membership (ticket 15 finding 1)", () => {
    test("a type written after the membership reaches the segment and its FTS row", () => {
      const member = addTurn(1, 100);
      const segment = createSegment(db, { title: "lease fencing", nowEpoch: 100 });
      addSegmentMembers(db, segment.id, [member], 100);
      // The member had no type at all when it joined — the vacuous segment A6's
      // duty ordering exists to prevent.
      expect(getSegment(db, segment.id)?.type).toEqual([]);

      updateTurnById(db, member, {
        type: ["design", "implement"],
        tags: ["lease", "fencing"],
        updatedAtEpoch: 200,
      });

      expect(getSegment(db, segment.id)?.type).toEqual(["design", "implement"]);
      expect(getSegment(db, segment.id)?.tags).toEqual(["fencing", "lease"]);
      expect(readSegmentFtsExtra(segment.id)).toContain("fencing");
      expect(readFacetsStale(segment.id)).toBe(0);
    });

    test("a REVISED type replaces the old one rather than accumulating, in every segment holding the turn", () => {
      const revised = addTurn(1, 100, { type: ["ops"], tags: ["release"] });
      const other = addTurn(2, 200, { type: ["design"], tags: ["lease"] });
      const first = createSegment(db, { title: "first", nowEpoch: 100 });
      const second = createSegment(db, { title: "second", nowEpoch: 100 });
      addSegmentMembers(db, first.id, [revised, other], 100);
      addSegmentMembers(db, second.id, [revised], 100);

      // The later window's verdict on an earlier turn (settlement duty 1).
      updateTurnById(db, revised, {
        type: ["correction"],
        tags: ["fencing"],
        updatedAtEpoch: 300,
      });

      expect(getSegment(db, first.id)?.type).toEqual(["design", "correction"]);
      expect(getSegment(db, first.id)?.tags).toEqual(["fencing", "lease"]);
      expect(getSegment(db, second.id)?.type).toEqual(["correction"]);
      expect(getSegment(db, second.id)?.tags).toEqual(["fencing"]);
      expect(readSegmentFtsExtra(second.id)).not.toContain("release");
    });

    test("a member reset back to no extraction empties what only it contributed", () => {
      const member = addTurn(1, 100, { type: ["ops"], tags: ["release"] });
      const segment = createSegment(db, { title: "release", nowEpoch: 100 });
      addSegmentMembers(db, segment.id, [member], 100);
      expect(getSegment(db, segment.id)?.type).toEqual(["ops"]);

      resetTurnExtractionFields(db, member, 300);

      expect(getSegment(db, segment.id)?.type).toEqual([]);
      expect(getSegment(db, segment.id)?.tags).toEqual([]);
      expect(readSegmentFtsExtra(segment.id)).not.toContain("release");
    });

    test("a raw-SQL facet write leaves the debt on file for the sweep to pay", () => {
      // The writers that do not go through `updateTurnById` —
      // hooks/capture-repair.ts claiming a compact boundary, the tag-namespace
      // migration — are out of reach of any call site, so the trigger is what
      // stands between them and a permanently stale facet.
      const member = addTurn(1, 100, { type: ["ops"], tags: ["release"] });
      const segment = createSegment(db, { title: "release", nowEpoch: 100 });
      addSegmentMembers(db, segment.id, [member], 100);

      db.query("UPDATE turns SET type = '[\"design\"]', tags = '[\"lease\"]' WHERE id = ?").run(
        member,
      );
      expect(readFacetsStale(segment.id)).toBe(1);

      expect(repairStaleSegmentFacets(db)).toBe(1);
      expect(getSegment(db, segment.id)?.type).toEqual(["design"]);
      expect(getSegment(db, segment.id)?.tags).toEqual(["lease"]);

      // …and a write that restates the same facets raises no debt at all: the
      // trigger's WHEN clause asks the same question db/turns.ts gates its own
      // recomputation on, so the two never disagree about whether one is owed.
      db.query("UPDATE turns SET type = '[\"design\"]', tags = '[\"lease\"]' WHERE id = ?").run(
        member,
      );
      expect(readFacetsStale(segment.id)).toBe(0);
    });
  });

  describe("the anti-fragmentation surface (ticket 14)", () => {
    test("listRecentSegments returns the most recently active first, whatever their status", () => {
      const oldest = createSegment(db, { title: "oldest", nowEpoch: 100 });
      const middle = createSegment(db, {
        title: "middle",
        status: "closed",
        nowEpoch: 200,
      });
      const newest = createSegment(db, { title: "newest", nowEpoch: 300 });

      const recent = listRecentSegments(db, 2);
      expect(recent.map((segment) => segment.id)).toEqual([newest.id, middle.id]);
      expect(listRecentSegments(db, 10).map((segment) => segment.id)).toEqual([
        newest.id,
        middle.id,
        oldest.id,
      ]);
    });
  });

  // Ticket 02: the roster's freeze judgement is a recorded fact
  // (created_at_epoch against a pinned cutoff), never an inference from
  // `status`. Most tests here use an explicit `eraCutoffEpoch` override —
  // fixtures across this whole file seed small epochs (100, 200, …), so the
  // real production constant would classify every one of them as legacy.
  describe("the live-segment freeze judgement (ticket 02)", () => {
    const CUTOFF = 1_000;

    test("isLiveSegmentEra: >= cutoff is live, < cutoff is legacy", () => {
      expect(isLiveSegmentEra(999, CUTOFF)).toBe(false);
      expect(isLiveSegmentEra(1_000, CUTOFF)).toBe(true);
      expect(isLiveSegmentEra(1_001, CUTOFF)).toBe(true);
    });

    test("status = 'open' alone does NOT make a pre-cutoff segment live — the exact bug ticket 02 fixes", () => {
      // A legacy arc-segment: status 'open' (the old write path's default
      // too), created BEFORE the cutoff.
      const legacyOpen = createSegment(db, {
        title: "measure+legacy-pipeline: old arc, still status open",
        nowEpoch: 500,
      });
      // A genuinely new container, created AFTER the cutoff.
      const liveOpen = createSegment(db, { title: "new container", nowEpoch: 1_500 });

      const roster = listLiveSegmentsByActivity(db, 10, CUTOFF);
      expect(roster.map((segment) => segment.id)).toEqual([liveOpen.id]);
      expect(roster.map((segment) => segment.id)).not.toContain(legacyOpen.id);

      expect(countLiveSegments(db, CUTOFF)).toBe(1);
    });

    test("a closed post-cutoff segment also leaves the roster (ticket 05's axis, same predicate)", () => {
      const closedNew = createSegment(db, { title: "closed new container", nowEpoch: 1_500 });
      toggleSegmentStatus(db, closedNew.id, 1_600);
      expect(getSegment(db, closedNew.id)?.status).toBe("closed");

      expect(listLiveSegmentsByActivity(db, 10, CUTOFF)).toHaveLength(0);
      expect(countLiveSegments(db, CUTOFF)).toBe(0);
    });

    test("the candidate set and the overflow count never disagree about the total (acceptance criterion 3)", () => {
      for (let index = 0; index < 5; index += 1) {
        createSegment(db, { title: `live ${index}`, nowEpoch: 1_000 + index });
      }
      for (let index = 0; index < 3; index += 1) {
        createSegment(db, { title: `legacy ${index}`, nowEpoch: 500 + index });
      }

      expect(listLiveSegmentsByActivity(db, 100, CUTOFF)).toHaveLength(5);
      expect(countLiveSegments(db, CUTOFF)).toBe(5);

      // …and a LIMIT-truncated candidate set still agrees with the total —
      // the count is never derived from the (possibly truncated) list length.
      expect(listLiveSegmentsByActivity(db, 2, CUTOFF)).toHaveLength(2);
      expect(countLiveSegments(db, CUTOFF)).toBe(5);
    });

    // hooks/session-composition.ts's renderSegmentRoster is this ticket's one
    // production caller, and it is outside this ticket's file scope (a
    // different worker owns it) — it calls both functions with NO third
    // argument. `eraCutoffEpoch` therefore defaults to `null`, the SAME
    // inert-by-default idiom `computeSegmentMemberFacetCounts` above and
    // `isSegmentEra` (segment-era.ts) already use: status-only, byte-for-byte
    // what both functions did before this ticket. This is what keeps that
    // file's own test suite (session-composition.test.ts, small fixture
    // epochs, unmodified by this ticket) passing unchanged; wiring the real
    // cutoff into ITS call sites is the one-line follow-up this ticket
    // cannot make on that file's behalf.
    test("defaults to null (inert) — status-only, unchanged from before this ticket", () => {
      createSegment(db, { title: "test-epoch segment", nowEpoch: 100 });
      expect(listLiveSegmentsByActivity(db, 10)).toHaveLength(1);
      expect(countLiveSegments(db)).toBe(1);
    });

    // The other half of the same story: passing the REAL pinned constant
    // explicitly (the follow-up wiring session-composition.ts needs) DOES
    // correctly separate legacy from live, using this file's own epoch
    // convention (100/200/…) as the "legacy" side and the real cutoff's
    // neighbourhood as the "live" side — proves the production constant
    // itself, not just an arbitrary test CUTOFF.
    test("the pinned production constant, passed explicitly, classifies correctly", () => {
      const legacy = createSegment(db, { title: "old test-era segment", nowEpoch: 100 });
      const live = createSegment(db, {
        title: "new container",
        nowEpoch: SEGMENT_CONTAINER_ERA_CUTOFF_EPOCH + 1,
      });

      const roster = listLiveSegmentsByActivity(db, 10, SEGMENT_CONTAINER_ERA_CUTOFF_EPOCH);
      expect(roster.map((segment) => segment.id)).toEqual([live.id]);
      expect(roster.map((segment) => segment.id)).not.toContain(legacy.id);
      expect(countLiveSegments(db, SEGMENT_CONTAINER_ERA_CUTOFF_EPOCH)).toBe(1);
    });
  });

  describe("cited pairs from a segment body (spec C6)", () => {
    test("a bare qualified reference in a NEW segment's content creates an unattributed pair", () => {
      const target = addTurn(1);

      const segment = createSegment(db, {
        title: "spine work",
        content: `Builds on [S${sessionId}/T1].`,
        nowEpoch: 100,
      });

      expect(
        getOutgoingEdges(db, { kind: "segment", id: segment.id }),
      ).toEqual([
        {
          citing: { kind: "segment", id: segment.id },
          cited: { kind: "turn", id: target },
          relation: null,
          provenance: "text-ref",
          createdAtEpoch: 100,
        },
      ]);
    });

    // Acceptance criterion 2 (segment side): the same grammar in the TITLE,
    // and the segment-address `[E<n>]` form.
    test("a title citation and a segment-to-segment [E<n>] citation both create pairs", () => {
      const target = addTurn(1);
      const other = createSegment(db, { title: "the older chapter", nowEpoch: 90 });

      const segment = createSegment(db, {
        title: `continues [S${sessionId}/T1]`,
        content: `See also [E${other.id}].`,
        nowEpoch: 100,
      });

      const citedKey = (node: { kind: string; id: number }) => `${node.kind}:${node.id}`;
      expect(
        getOutgoingEdges(db, { kind: "segment", id: segment.id })
          .map((edge) => citedKey(edge.cited))
          .sort(),
      ).toEqual(
        [citedKey({ kind: "turn", id: target }), citedKey({ kind: "segment", id: other.id })].sort(),
      );
    });

    // Acceptance criterion 3 (segment side): the rewrite-drops-citation
    // sequence, relation included.
    test("a rewrite that drops a reference drops its pair and any relation it carried", () => {
      const kept = addTurn(1);
      const dropped = addTurn(2);
      const segment = createSegment(db, {
        title: "spine work",
        content: `Cites [S${sessionId}/T1] and [S${sessionId}/T2].`,
        nowEpoch: 100,
      });
      // A relation lands on the surviving pair from elsewhere (settlement).
      writeMemoryEdges(
        db,
        [
          {
            citing: { kind: "segment", id: segment.id },
            cited: { kind: "turn", id: kept },
            relation: "supersedes",
            provenance: "judged",
          },
        ],
        150,
        { eligibleForRelation: "unrestricted" },
      );
      expect(
        getOutgoingEdges(db, { kind: "segment", id: segment.id }),
      ).toHaveLength(2);

      applySegmentWrites(
        db,
        [
          {
            segmentId: segment.id,
            expectedRevision: segment.revision,
            content: `Only [S${sessionId}/T1] now.`,
          },
        ],
        { nowEpoch: 200 },
      );

      const surviving = getOutgoingEdges(db, { kind: "segment", id: segment.id });
      expect(surviving.map((edge) => edge.cited.id)).toEqual([kept]);
      expect(surviving[0]?.relation).toBe("supersedes");
      expect(surviving.some((edge) => edge.cited.id === dropped)).toBe(false);
    });

    test("a rewrite that still cites a pair does not disturb its relation", () => {
      const target = addTurn(1);
      const segment = createSegment(db, {
        title: "spine work",
        content: `Cites [S${sessionId}/T1].`,
        nowEpoch: 100,
      });
      writeMemoryEdges(
        db,
        [
          {
            citing: { kind: "segment", id: segment.id },
            cited: { kind: "turn", id: target },
            relation: "evidence-for",
            provenance: "judged",
          },
        ],
        150,
        { eligibleForRelation: "unrestricted" },
      );

      applySegmentWrites(
        db,
        [
          {
            segmentId: segment.id,
            expectedRevision: segment.revision,
            content: `Restating [S${sessionId}/T1] once more.`,
          },
        ],
        { nowEpoch: 200 },
      );

      const surviving = getOutgoingEdges(db, { kind: "segment", id: segment.id });
      expect(surviving).toHaveLength(1);
      expect(surviving[0]?.relation).toBe("evidence-for");
    });

    test("a reference naming no real row is dropped, not written", () => {
      const segment = createSegment(db, {
        title: "spine work",
        content: `Cites [S${sessionId}/T999] and [E999999].`,
        nowEpoch: 100,
      });

      expect(
        getOutgoingEdges(db, { kind: "segment", id: segment.id }),
      ).toEqual([]);
    });
  });
});
