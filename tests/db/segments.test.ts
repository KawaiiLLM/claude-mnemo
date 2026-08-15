import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { getOutgoingEdges, writeMemoryEdges } from "../../src/db/memory-edges";
import { initializeSchema } from "../../src/db/schema";
import {
  addSegmentMembers,
  applySegmentWrites,
  createSegment,
  findTopic,
  getSegment,
  getSegmentMemberTurnIds,
  getSegmentsForTurn,
  listOpenSegments,
  listTopics,
  upsertTopic,
} from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { normalizeTypeValues } from "../../src/shared/type-vocabulary";

describe("segments, topics and membership", () => {
  let db: Database;
  let sessionId: number;

  function addTurn(promptNumber: number, createdAtEpoch = 100): number {
    return db
      .query<{ id: number }, [number, number, number]>(
        `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch)
         VALUES (?, ?, 'extracted', ?)
         RETURNING id`,
      )
      .get(sessionId, promptNumber, createdAtEpoch)!.id;
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

  describe("topic registry", () => {
    test("resolves a name through its aliases instead of minting a twin", () => {
      const created = upsertTopic(db, {
        name: "extraction-redesign",
        aliases: ["提取管线重设计"],
        nowEpoch: 100,
      });

      const viaAlias = upsertTopic(db, {
        name: "提取管线重设计",
        aliases: ["extraction pipeline"],
        nowEpoch: 200,
      });

      expect(viaAlias.id).toBe(created.id);
      expect(viaAlias.aliases).toContain("extraction pipeline");
      expect(listTopics(db)).toHaveLength(1);
      expect(findTopic(db, "EXTRACTION-REDESIGN")?.id).toBe(created.id);
      expect(findTopic(db, "unrelated")).toBeNull();
    });

    test("carries a status the settlement pass can retire", () => {
      const topic = upsertTopic(db, { name: "arc-spine", nowEpoch: 100 });
      expect(topic.status).toBe("active");

      upsertTopic(db, { name: "arc-spine", status: "retired", nowEpoch: 200 });
      expect(listTopics(db, "retired")).toHaveLength(1);
      expect(listTopics(db, "active")).toHaveLength(0);
    });
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
            status: "delivered",
          },
        ],
        { nowEpoch: 200 },
      );
      expect(closed.applied[0]?.status).toBe("delivered");

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
