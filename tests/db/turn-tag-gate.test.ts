import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { insertLane } from "../../src/db/lanes";
import { initializeSchema } from "../../src/db/schema";
import {
  createSegment,
  getSegmentMemberTurnIds,
  setSegmentTag,
} from "../../src/db/segments";
import { updateTurnById } from "../../src/db/turns";
import { checkTurnTagWrite } from "../../src/db/turn-tag-gate";
import { upsertSession } from "../../src/db/sessions";

/**
 * The TAGS write gate and the membership derivation it protects
 * (lane-model-v12 ticket 14, spec D3b/D3e).
 *
 * Three refusals, each naming the gap, plus the one positive rule: a turn
 * belongs to whichever segment's tag it carries.
 */
describe("the tags write gate (ticket 14)", () => {
  let db: Database;
  let sessionId: number;
  let turnId: number;
  let segmentA: number;
  let segmentB: number;

  function seedTurn(promptNumber: number): number {
    return db
      .query<{ id: number }, [number, number, number]>(
        `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch)
         VALUES (?, ?, 'extracted', ?) RETURNING id`,
      )
      .get(sessionId, promptNumber, 100)!.id;
  }

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "tag-gate-session",
      project: "claude-mnemo",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 100,
      completedAtEpoch: null,
    }).id;
    turnId = seedTurn(1);
    segmentA = createSegment(db, { title: "A", tags: ["seg-a"], nowEpoch: 100 }).id;
    segmentB = createSegment(db, { title: "B", tags: ["seg-b"], nowEpoch: 100 }).id;
    insertLane(db, segmentA, "lane-one", 100);
    insertLane(db, segmentB, "lane-two", 100);
  });

  afterEach(() => {
    db.close();
  });

  // -------------------------------------------------------------------------
  // The two vocabularies
  // -------------------------------------------------------------------------

  test("a segment tag alone is legal, and names the segment the write derives into", () => {
    const check = checkTurnTagWrite(db, { nextTags: ["seg-a"], priorTags: [] });
    expect(check.ok).toBe(true);
    expect(check.ok && check.segmentId).toBe(segmentA);
  });

  test("a lane tag beside its own segment's tag is legal", () => {
    const check = checkTurnTagWrite(db, {
      nextTags: ["seg-a", "lane-one"],
      priorTags: [],
    });
    expect(check.ok).toBe(true);
    expect(check.ok && check.segmentId).toBe(segmentA);
  });

  test("no tags at all is legal and unowned — tags is an optional field", () => {
    const check = checkTurnTagWrite(db, { nextTags: [], priorTags: [] });
    expect(check.ok).toBe(true);
    expect(check.ok && check.segmentId).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Refusal 1: a second segment tag, naming BOTH segments
  // -------------------------------------------------------------------------

  test("a second segment tag is refused, naming both segments", () => {
    const check = checkTurnTagWrite(db, {
      nextTags: ["seg-a", "seg-b"],
      priorTags: [],
    });
    expect(check.ok).toBe(false);
    const message = !check.ok ? check.message : "";
    expect(message).toContain(`"seg-a" (E${segmentA})`);
    expect(message).toContain(`"seg-b" (E${segmentB})`);
    expect(message).toContain("at most one segment");
  });

  // -------------------------------------------------------------------------
  // Refusal 2: a lane tag without its own segment's tag, naming the missing one
  // -------------------------------------------------------------------------

  test("a lane tag with NO segment tag is refused, naming the segment tag that is missing", () => {
    const check = checkTurnTagWrite(db, { nextTags: ["lane-one"], priorTags: [] });
    expect(check.ok).toBe(false);
    const message = !check.ok ? check.message : "";
    expect(message).toContain(`E${segmentA}`);
    expect(message).toContain('segment tag "seg-a" is not in these tags');
  });

  test("a lane tag beside the WRONG segment's tag is refused, naming the right segment", () => {
    const check = checkTurnTagWrite(db, {
      nextTags: ["seg-b", "lane-one"],
      priorTags: [],
    });
    expect(check.ok).toBe(false);
    expect(!check.ok && check.message).toContain(`E${segmentA}`);
  });

  test("no segment tag therefore means no lane tags — the invariant closes", () => {
    for (const tag of ["lane-one", "lane-two"]) {
      expect(checkTurnTagWrite(db, { nextTags: [tag], priorTags: [] }).ok).toBe(false);
    }
  });

  // -------------------------------------------------------------------------
  // Refusal 3: outside both vocabularies, listing what is legal
  // -------------------------------------------------------------------------

  test("a word in neither vocabulary is refused, listing the currently legal set", () => {
    const check = checkTurnTagWrite(db, {
      nextTags: ["seg-a", "not-a-lane"],
      priorTags: [],
    });
    expect(check.ok).toBe(false);
    const message = !check.ok ? check.message : "";
    expect(message).toContain('"not-a-lane"');
    expect(message).toContain(`E${segmentA} is this turn's segment`);
    expect(message).toContain('"seg-a" and "lane-one"');
  });

  test("with no segment tag present the legal set is the segment tags themselves", () => {
    const check = checkTurnTagWrite(db, { nextTags: ["whatever"], priorTags: [] });
    expect(check.ok).toBe(false);
    const message = !check.ok ? check.message : "";
    expect(message).toContain('"seg-a" and "seg-b"');
  });

  test("a machine-namespaced value an AGENT introduces is refused like any other non-vocabulary word", () => {
    const check = checkTurnTagWrite(db, { nextTags: ["compact:boundary"], priorTags: [] });
    expect(check.ok).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Legacy values: not cleared, only new writes refused (spec D3b)
  // -------------------------------------------------------------------------

  test("a legacy free-form value the turn already carries survives being restated", () => {
    const check = checkTurnTagWrite(db, {
      nextTags: ["legacy-word", "seg-a"],
      priorTags: ["legacy-word"],
    });
    expect(check.ok).toBe(true);
    expect(check.ok && check.segmentId).toBe(segmentA);
  });

  test("but a NEW free-form value beside the same legacy one is still refused", () => {
    const check = checkTurnTagWrite(db, {
      nextTags: ["legacy-word", "brand-new"],
      priorTags: ["legacy-word"],
    });
    expect(check.ok).toBe(false);
    expect(!check.ok && check.message).toContain('"brand-new"');
  });

  test("the STRUCTURAL refusals judge the resulting set, inherited values included", () => {
    // Both segment tags already stored (only reachable from a pre-ticket-14
    // database): a write that merely restates them is still refused, because
    // derivation cannot read that state at all.
    const check = checkTurnTagWrite(db, {
      nextTags: ["seg-a", "seg-b"],
      priorTags: ["seg-a", "seg-b"],
    });
    expect(check.ok).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Derivation: membership follows the tag, with no verb
  // -------------------------------------------------------------------------

  describe("membership is derived from the stored tags", () => {
    test("carrying a segment's tag IS joining it; dropping the tag IS leaving", () => {
      updateTurnById(db, turnId, { tags: ["seg-a"], updatedAtEpoch: 200 });
      expect(getSegmentMemberTurnIds(db, segmentA)).toEqual([turnId]);

      updateTurnById(db, turnId, { tags: ["seg-b"], updatedAtEpoch: 300 });
      expect(getSegmentMemberTurnIds(db, segmentA)).toEqual([]);
      expect(getSegmentMemberTurnIds(db, segmentB)).toEqual([turnId]);

      updateTurnById(db, turnId, { tags: [], updatedAtEpoch: 400 });
      expect(getSegmentMemberTurnIds(db, segmentB)).toEqual([]);
    });

    test("an UNNAMED segment takes no members, however a turn is tagged", () => {
      const unnamed = createSegment(db, { title: "unnamed", nowEpoch: 100 }).id;
      updateTurnById(db, turnId, { tags: ["anything"], updatedAtEpoch: 200 });
      expect(getSegmentMemberTurnIds(db, unnamed)).toEqual([]);
    });

    test("renaming a segment does not re-derive its existing members", () => {
      updateTurnById(db, turnId, { tags: ["seg-a"], updatedAtEpoch: 200 });
      const renamed = setSegmentTag(db, segmentA, "seg-a-renamed", 300);
      expect(renamed.ok).toBe(true);
      // Grandfathered, exactly as the one-tag migration grandfathers the rest.
      expect(getSegmentMemberTurnIds(db, segmentA)).toEqual([turnId]);
    });
  });

  // -------------------------------------------------------------------------
  // Global uniqueness — a schema fact, not a convention
  // -------------------------------------------------------------------------

  describe("two segments cannot share a tag", () => {
    test("the write face refuses, naming the segment already holding the word", () => {
      const result = setSegmentTag(db, segmentB, "seg-a", 200);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.message).toContain(`E${segmentA}`);
      expect(!result.ok && result.message).toContain("globally unique");
    });

    test("and the unique index refuses even a caller that skipped the write face", () => {
      expect(() =>
        db
          .query<unknown, [string, number]>("UPDATE segments SET tags = ? WHERE id = ?")
          .run(JSON.stringify(["seg-a"]), segmentB),
      ).toThrow(/UNIQUE constraint failed/);
    });
  });
});
