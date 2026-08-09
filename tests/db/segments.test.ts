import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
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
import {
  draftTypeFromTitle,
  normalizeTypeValues,
  RestrictedTypeError,
} from "../../src/shared/type-vocabulary";

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

  describe("type draft from the title prefix", () => {
    test("resolves a matching prefix to its enum value", () => {
      expect(draftTypeFromTitle("修复 worker 的重试竞态")).toBe("fix");
      expect(draftTypeFromTitle("Investigate the stall watchdog")).toBe("research");
      expect(draftTypeFromTitle("发版 0.9.0")).toBe("ops");
      expect(draftTypeFromTitle("review the extraction spec")).toBe("review");
    });

    test("falls to unknown rather than guessing", () => {
      expect(draftTypeFromTitle("竞态问题的三个候选")).toBe("unknown");
      expect(draftTypeFromTitle("addendum to the plan")).toBe("unknown");
      expect(draftTypeFromTitle("")).toBe("unknown");
      expect(draftTypeFromTitle(null)).toBe("unknown");
    });

    test("cannot mint the rolled-back value from a title", () => {
      expect(draftTypeFromTitle("rolled-back the mutex change")).toBe("unknown");
      expect(draftTypeFromTitle("回退 mutex 改动")).toBe("unknown");
    });

    test("a segment born without an explicit type carries the draft", () => {
      const drafted = createSegment(db, {
        title: "实现 段成员边表",
        nowEpoch: 100,
      });
      const unmatched = createSegment(db, {
        title: "竞态问题的三个候选",
        nowEpoch: 100,
      });

      expect(drafted.type).toEqual(["implement"]);
      expect(unmatched.type).toEqual([]);
    });
  });

  describe("the rolled-back type is settlement-only", () => {
    test("normalizeTypeValues refuses it from the mechanical path", () => {
      expect(() => normalizeTypeValues(["fix", "rolled-back"])).toThrow(
        RestrictedTypeError,
      );
      expect(normalizeTypeValues(["fix", "rolled-back"], "settlement")).toEqual([
        "fix",
        "rolled-back",
      ]);
      expect(() => normalizeTypeValues(["invented"])).toThrow("unknown type value");
    });

    test("creation rejects it from a draft writer and accepts it from settlement", () => {
      expect(() =>
        createSegment(db, {
          title: "A reversed decision",
          type: ["design", "rolled-back"],
          nowEpoch: 100,
        }),
      ).toThrow(RestrictedTypeError);

      const settled = createSegment(db, {
        title: "A reversed decision",
        type: ["design", "rolled-back"],
        typeSource: "settlement",
        nowEpoch: 100,
      });
      expect(settled.type).toEqual(["design", "rolled-back"]);
    });

    test("an open-segment write rejects it without touching the row", () => {
      const segment = createSegment(db, { title: "设计 段结算流程", nowEpoch: 100 });

      const result = applySegmentWrites(
        db,
        [
          {
            segmentId: segment.id,
            expectedRevision: segment.revision,
            type: ["rolled-back"],
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
            type: ["design", "rolled-back"],
          },
        ],
        { nowEpoch: 300, source: "settlement" },
      );
      expect(settled.applied[0]?.type).toEqual(["design", "rolled-back"]);
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
});
