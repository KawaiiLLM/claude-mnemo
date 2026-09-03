import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { createDatabase } from "../../src/db/database";
import { clearLane, insertLane, mergeLaneTag, renameLane } from "../../src/db/lanes";
import { writeMemoryEdges } from "../../src/db/memory-edges";
import { initializeSchema } from "../../src/db/schema";
import {
  addSegmentMembers,
  checkMembershipTagWrite,
  clearSegmentMembers,
  createSegment,
  deriveTurnSegmentMembership,
  frozenOwnerSegmentIds,
  getSegment,
  getSegmentMemberTurnIds,
  getSegmentsForTurn,
  mergeSegments,
  MembershipFrozenOwnerError,
  MembershipWriteRefusedError,
  setSegmentTags,
  writeMembershipTags,
} from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { resetTurnExtractionFields, updateTurnById } from "../../src/db/turns";
import { getFieldStamp } from "../../src/db/write-gate";
import { rememberTool } from "../../src/mcp/remember";
import { wordEdgeClass } from "../support/edge-row-fixtures";

/**
 * ONE MEMBERSHIP PRIMITIVE (settlement-read-once spec D4 + D5, ticket 02).
 *
 * Every path that moves membership writes TAGS through `writeMembershipTags`
 * and lets `deriveTurnSegmentMembership` decide the rows. The three explicit
 * operations — `normal`, `thaw-owner`, `forced-detach` — are what make frozen
 * legacy ownership expressible: an unnamed task's `segment_members` rows are
 * invisible to derivation in both directions, and only one operation converts
 * them and one deletes them.
 */
describe("the membership primitive", () => {
  let db: Database;
  let sessionId: number;

  function addTurn(promptNumber: number, tags: string[] = [], type: string[] = []): number {
    return db
      .query<{ id: number }, [number, number, number, string, string]>(
        `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch, type, tags)
         VALUES (?, ?, 'extracted', ?, ?, ?)
         RETURNING id`,
      )
      .get(sessionId, promptNumber, 100 + promptNumber, JSON.stringify(type), JSON.stringify(tags))!
      .id;
  }

  function storedTags(turnId: number): string[] {
    const raw = db
      .query<{ tags: string | null }, [number]>("SELECT tags FROM turns WHERE id = ?")
      .get(turnId)!.tags;
    return raw === null ? [] : (JSON.parse(raw) as string[]);
  }

  function membershipOf(turnId: number): number[] {
    return getSegmentsForTurn(db, turnId).map((segment) => segment.id);
  }

  /** A task nobody has named, owning `turnId` by a bare row — production's 66. */
  function frozenTask(title: string, turnId: number): number {
    const segmentId = createSegment(db, { title, nowEpoch: 100 }).id;
    addSegmentMembers(db, segmentId, [turnId], 100);
    return segmentId;
  }

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "membership-primitive",
      project: "/tmp/project-membership",
      title: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 100,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  // -------------------------------------------------------------------------
  // The three operations (D4)
  // -------------------------------------------------------------------------

  describe("the three operations", () => {
    test("`normal` refuses a write that would put a FROZEN-owned turn into a second task, naming the owner", () => {
      const turnId = addTurn(1);
      const frozen = frozenTask("legacy", turnId);
      const named = createSegment(db, { title: "named", tags: ["fresh-task"], nowEpoch: 100 });

      const result = writeMembershipTags(db, {
        operation: "normal",
        writes: [{ turnId, tags: ["fresh-task"] }],
        nowEpoch: 200,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.refusals).toHaveLength(1);
      expect(result.refusals[0]!.turnId).toBe(turnId);
      expect(result.refusals[0]!.message).toContain(`owned by unnamed E${frozen}`);
      expect(result.refusals[0]!.message).toContain("name it or detach first");
      expect(result.refusals[0]!.message).toContain(`E${named.id}`);

      // Nothing was written — neither the tags nor the rows.
      expect(storedTags(turnId)).toEqual([]);
      expect(membershipOf(turnId)).toEqual([frozen]);
    });

    test("`normal` derivation NEVER deletes a frozen row and never creates one", () => {
      const turnId = addTurn(1, ["some-word"]);
      const frozen = frozenTask("legacy", turnId);

      // A tag set naming NO task at all: before this ticket the derivation
      // deleted every membership row it found.
      expect(deriveTurnSegmentMembership(db, turnId, [], 200)).toBeNull();
      expect(membershipOf(turnId)).toEqual([frozen]);

      // And it never CREATES one either — an unnamed task has no tag to
      // derive from, so there is nothing a tag write could aim at.
      const other = createSegment(db, { title: "other unnamed", nowEpoch: 100 }).id;
      expect(deriveTurnSegmentMembership(db, turnId, ["some-word"], 210)).toBeNull();
      expect(membershipOf(turnId)).toEqual([frozen]);
      expect(getSegmentMemberTurnIds(db, other)).toEqual([]);
    });

    test("`forced-detach` is the ONE operation that removes a frozen row", () => {
      const turnId = addTurn(1);
      const frozen = frozenTask("legacy", turnId);

      const result = writeMembershipTags(db, {
        operation: "forced-detach",
        writes: [{ turnId, tags: [] }],
        nowEpoch: 200,
      });

      expect(result.ok).toBe(true);
      expect(membershipOf(turnId)).toEqual([]);
      expect(getSegmentMemberTurnIds(db, frozen)).toEqual([]);
    });

    test("`thaw-owner` refuses a write that derives into any task but the one being named", () => {
      const turnId = addTurn(1);
      const thawing = createSegment(db, { title: "thawing", nowEpoch: 100 }).id;
      addSegmentMembers(db, thawing, [turnId], 100);
      const elsewhere = createSegment(db, { title: "elsewhere", tags: ["elsewhere"], nowEpoch: 100 });

      const result = writeMembershipTags(db, {
        operation: "thaw-owner",
        writes: [{ turnId, tags: ["elsewhere"] }],
        nowEpoch: 200,
        thawingSegmentId: thawing,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.refusals[0]!.message).toContain(`thaw-owner may only move a member into E${thawing}`);
      expect(result.refusals[0]!.message).toContain(`E${elsewhere.id}`);
    });

    test("the frozen-owner question can be asked without writing (`checkMembershipTagWrite`), and only under `normal`", () => {
      const turnId = addTurn(1);
      const frozen = frozenTask("legacy", turnId);
      createSegment(db, { title: "named", tags: ["fresh-task"], nowEpoch: 100 });

      expect(checkMembershipTagWrite(db, turnId, ["fresh-task"], "normal")).toContain(
        `owned by unnamed E${frozen}`,
      );
      expect(checkMembershipTagWrite(db, turnId, ["fresh-task"], "thaw-owner")).toBeNull();
      expect(checkMembershipTagWrite(db, turnId, ["fresh-task"], "forced-detach")).toBeNull();
      // A write that joins no task at all is never a frozen-owner conflict.
      expect(checkMembershipTagWrite(db, turnId, ["topic:whatever"], "normal")).toBeNull();
    });

    test("the derivation THROWS on the same conflict, so a path that bypasses the primitive still cannot extend legacy ownership", () => {
      const turnId = addTurn(1);
      frozenTask("legacy", turnId);
      createSegment(db, { title: "named", tags: ["fresh-task"], nowEpoch: 100 });

      expect(() => deriveTurnSegmentMembership(db, turnId, ["fresh-task"], 200)).toThrow(
        MembershipFrozenOwnerError,
      );
    });

    test("`frozenOwnerSegmentIds` reports exactly the unnamed owners", () => {
      const turnId = addTurn(1);
      const frozen = frozenTask("legacy", turnId);
      expect(frozenOwnerSegmentIds(db, turnId)).toEqual([frozen]);

      // Naming the task is what un-freezes it — no row moved, the QUESTION
      // changed answer.
      setSegmentTags(db, frozen, ["now-named"], 200);
      expect(frozenOwnerSegmentIds(db, turnId)).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // The primitive's own contract: tags, stamp, derivation, all-or-nothing
  // -------------------------------------------------------------------------

  describe("write tags -> stamp -> derive", () => {
    test("one call writes the tags, STAMPS `tags` for the acting writer, and derives the rows", () => {
      const segment = createSegment(db, { title: "task", tags: ["the-task"], nowEpoch: 100 });
      const a = addTurn(1);
      const b = addTurn(2);

      const result = writeMembershipTags(db, {
        operation: "normal",
        writes: [
          { turnId: a, tags: ["the-task"] },
          { turnId: b, tags: ["the-task"] },
        ],
        writer: "claim:7:1:edges",
        nowEpoch: 200,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.changedTurnIds.sort()).toEqual([a, b].sort());
      expect(result.membership).toEqual([
        { turnId: a, segmentId: segment.id },
        { turnId: b, segmentId: segment.id },
      ]);
      expect(getSegmentMemberTurnIds(db, segment.id).sort()).toEqual([a, b].sort());
      expect(getFieldStamp(db, "turn", a, "tags")?.writer).toBe("claim:7:1:edges");
      expect(getFieldStamp(db, "turn", b, "tags")?.writer).toBe("claim:7:1:edges");
    });

    test("no writer named stamps anonymously — it is the MUTATION that is recorded, not the mutator's standing", () => {
      createSegment(db, { title: "task", tags: ["the-task"], nowEpoch: 100 });
      const turnId = addTurn(1);
      writeMembershipTags(db, {
        operation: "normal",
        writes: [{ turnId, tags: ["the-task"] }],
        nowEpoch: 200,
      });
      expect(getFieldStamp(db, "turn", turnId, "tags")?.writer).toBe("unknown");
    });

    test("a restatement that moves nothing stamps nothing — a no-op must not make another reader's grant stale", () => {
      createSegment(db, { title: "task", tags: ["the-task"], nowEpoch: 100 });
      const turnId = addTurn(1, ["the-task"]);

      const result = writeMembershipTags(db, {
        operation: "normal",
        writes: [{ turnId, tags: ["the-task"] }],
        nowEpoch: 200,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.changedTurnIds).toEqual([]);
      expect(getFieldStamp(db, "turn", turnId, "tags")).toBeNull();
    });

    test("ALL-OR-NOTHING with EVERY failure named: one bad member writes none", () => {
      const good = addTurn(1);
      const bad1 = addTurn(2);
      const bad2 = addTurn(3);
      const frozen1 = frozenTask("legacy one", bad1);
      const frozen2 = frozenTask("legacy two", bad2);
      createSegment(db, { title: "task", tags: ["the-task"], nowEpoch: 100 });

      const result = writeMembershipTags(db, {
        operation: "normal",
        writes: [good, bad1, bad2].map((turnId) => ({ turnId, tags: ["the-task"] })),
        nowEpoch: 200,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.refusals.map((entry) => entry.turnId)).toEqual([bad1, bad2]);
      expect(result.message).toContain(`E${frozen1}`);
      expect(result.message).toContain(`E${frozen2}`);
      expect(result.message).toContain("nothing was written");
      // The GOOD member did not land either.
      expect(storedTags(good)).toEqual([]);
      expect(membershipOf(good)).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Structural readers (D4: "stated plainly, not assumed")
  // -------------------------------------------------------------------------

  describe("structural readers keep returning frozen rows", () => {
    test("`getSegmentMemberTurnIds` and `getSegmentsForTurn` list an unnamed task's frozen members", () => {
      const turnId = addTurn(1);
      const frozen = frozenTask("legacy", turnId);
      expect(getSegmentMemberTurnIds(db, frozen)).toEqual([turnId]);
      expect(membershipOf(turnId)).toEqual([frozen]);
    });

    test("…including the rows of COMPACTED and REWOUND turns — a frozen row is ownership history", () => {
      const compacted = addTurn(1, [], ["compact"]);
      const rewound = addTurn(2);
      db.query<unknown, [number]>("UPDATE turns SET status = 'undone' WHERE id = ?").run(rewound);
      const frozen = createSegment(db, { title: "legacy", nowEpoch: 100 }).id;
      addSegmentMembers(db, frozen, [compacted, rewound], 100);

      expect(getSegmentMemberTurnIds(db, frozen).sort()).toEqual([compacted, rewound].sort());
      expect(membershipOf(compacted)).toEqual([frozen]);
      expect(membershipOf(rewound)).toEqual([frozen]);
    });
  });

  // -------------------------------------------------------------------------
  // Routed paths (D4's own sweep), each with its operation
  // -------------------------------------------------------------------------

  describe("every routed path", () => {
    test("`resetTurnExtractionFields` (normal) strips the task tag, drops the derived row, and PRESERVES a frozen one", () => {
      const segment = createSegment(db, { title: "task", tags: ["the-task"], nowEpoch: 100 });
      const turnId = addTurn(1);
      writeMembershipTags(db, {
        operation: "normal",
        writes: [{ turnId, tags: ["the-task", "compact:x"] }],
        nowEpoch: 200,
      });
      expect(membershipOf(turnId)).toEqual([segment.id]);
      // …and a FROZEN owner beside it, the state the old reset destroyed.
      const frozen = createSegment(db, { title: "legacy", nowEpoch: 100 }).id;
      addSegmentMembers(db, frozen, [turnId], 100);

      resetTurnExtractionFields(db, turnId, 300);

      expect(storedTags(turnId)).toEqual(["compact:x"]);
      expect(membershipOf(turnId)).toEqual([frozen]);
      expect(getSegmentMemberTurnIds(db, segment.id)).toEqual([]);
    });

    // main-agent-edges ticket 13 (P1-9): before this ticket the turn's own
    // `UPDATE` ran first, unconditionally — a lane-stranding refusal left the
    // extraction fields cleared beside tags and membership the veto had just
    // said must not move. Both must now be ONE transaction: a refusal throws
    // and leaves every field byte-identical to what it was on entry.
    test("`resetTurnExtractionFields` refuses ATOMICALLY when the reset would strand a declared lane — every field left byte-identical", () => {
      const segment = createSegment(db, { title: "task", tags: ["the-task"], nowEpoch: 100 });
      insertLane(db, segment.id, "lane-a", 100);
      const cited = addTurn(2, ["the-task"]);
      const turnId = db
        .query<{ id: number }, [number]>(
          `INSERT INTO turns
             (session_id, prompt_number, status, assistant_response, title, content,
              insight, type, tags, created_at_epoch)
           VALUES (?, 1, 'provisional', 'r', 'Old title', 'Old content', 'Old insight',
                   '["feature"]', '["the-task","lane-a"]', 5000)
           RETURNING id`,
        )
        .get(sessionId)!.id;
      addSegmentMembers(db, segment.id, [turnId], 100);
      writeMemoryEdges(
        db,
        [
          {
            citing: { kind: "turn", id: turnId },
            cited: { kind: "turn", id: cited },
            ...wordEdgeClass("extends"),
            provenance: "asserted",
            tailTag: "lane-a",
          },
        ],
        120,
      );

      const before = db.query("SELECT * FROM turns WHERE id = ?").get(turnId);
      const edgesBefore = db.query("SELECT * FROM memory_edges ORDER BY id").all();

      // The reset strips every freeform tag, including `lane-a` — landing the
      // turn in NO task at all, which has not declared `lane-a` either, so the
      // edge's citing side would be stranded.
      expect(() => resetTurnExtractionFields(db, turnId, 300)).toThrow(
        MembershipWriteRefusedError,
      );

      expect(db.query("SELECT * FROM turns WHERE id = ?").get(turnId)).toEqual(before);
      expect(db.query("SELECT * FROM memory_edges ORDER BY id").all()).toEqual(edgesBefore);
      expect(storedTags(turnId)).toEqual(["the-task", "lane-a"]);
      expect(membershipOf(turnId)).toEqual([segment.id]);
    });

    test("task-tier `clear` is `forced-detach`: it removes even a frozen row", () => {
      const turnId = addTurn(1);
      const frozen = frozenTask("legacy", turnId);
      expect(clearSegmentMembers(db, frozen, 300)).toBe(1);
      expect(getSegmentMemberTurnIds(db, frozen)).toEqual([]);
    });

    test("lane merge (normal) rewrites the member's word through the primitive and stamps it", () => {
      const segment = createSegment(db, { title: "task", tags: ["the-task"], nowEpoch: 100 });
      insertLane(db, segment.id, "old-lane", 100);
      insertLane(db, segment.id, "new-lane", 100);
      const turnId = addTurn(1);
      writeMembershipTags(db, {
        operation: "normal",
        writes: [{ turnId, tags: ["the-task", "old-lane"] }],
        writer: "seed",
        nowEpoch: 200,
      });

      mergeLaneTag(db, segment.id, "old-lane", "new-lane", 300);

      expect(storedTags(turnId)).toEqual(["the-task", "new-lane"]);
      // The stamp moved — before this ticket the lane verbs raw-`UPDATE`d
      // `tags` and stamped nothing at all.
      expect(getFieldStamp(db, "turn", turnId, "tags")?.writer).toBe("unknown");
      expect(membershipOf(turnId)).toEqual([segment.id]);
    });

    test("lane retag rides the same primitive (it composes the merge)", () => {
      const segment = createSegment(db, { title: "task", tags: ["the-task"], nowEpoch: 100 });
      insertLane(db, segment.id, "wrong-name", 100);
      const turnId = addTurn(1);
      writeMembershipTags(db, {
        operation: "normal",
        writes: [{ turnId, tags: ["the-task", "wrong-name"] }],
        nowEpoch: 200,
      });

      renameLane(db, segment.id, "wrong-name", "right-name", 300);

      expect(storedTags(turnId)).toEqual(["the-task", "right-name"]);
      expect(getFieldStamp(db, "turn", turnId, "tags")).not.toBeNull();
    });

    test("lane clear (normal) strips the lane word, stamps, and leaves the task membership standing", () => {
      const segment = createSegment(db, { title: "task", tags: ["the-task"], nowEpoch: 100 });
      insertLane(db, segment.id, "doomed", 100);
      const turnId = addTurn(1);
      writeMembershipTags(db, {
        operation: "normal",
        writes: [{ turnId, tags: ["the-task", "doomed"] }],
        nowEpoch: 200,
      });

      const outcome = clearLane(db, segment.id, "doomed", 300, false);
      expect(outcome.kind).toBe("cleared");
      expect(storedTags(turnId)).toEqual(["the-task"]);
      expect(membershipOf(turnId)).toEqual([segment.id]);
      expect(getFieldStamp(db, "turn", turnId, "tags")).not.toBeNull();
    });

    test("task merge with an UNNAMED source refuses: name the source first", () => {
      const turnId = addTurn(1);
      const from = frozenTask("unnamed source", turnId);
      const into = createSegment(db, { title: "into", tags: ["into-task"], nowEpoch: 100 }).id;

      const outcome = mergeSegments(db, from, into, 300);

      expect(outcome.kind).toBe("members-blocked");
      if (outcome.kind !== "members-blocked") return;
      expect(outcome.message).toContain("FROZEN");
      expect(outcome.message).toContain("Name the source first");
      // Nothing moved, and the source still exists.
      expect(getSegmentMemberTurnIds(db, from)).toEqual([turnId]);
      expect(getSegment(db, from)).not.toBeNull();
    });

    test("task merge with a NAMED source moves members by writing the destination's tag", () => {
      const from = createSegment(db, { title: "from", tags: ["from-task"], nowEpoch: 100 }).id;
      const into = createSegment(db, { title: "into", tags: ["into-task"], nowEpoch: 100 }).id;
      const turnId = addTurn(1);
      writeMembershipTags(db, {
        operation: "normal",
        writes: [{ turnId, tags: ["from-task"] }],
        nowEpoch: 200,
      });

      const outcome = mergeSegments(db, from, into, 300);

      expect(outcome.kind).toBe("merged");
      expect(storedTags(turnId)).toEqual(["into-task"]);
      expect(membershipOf(turnId)).toEqual([into]);
    });

    test("the single `note`-shaped tag write through `updateTurnById` derives and refuses a frozen conflict", () => {
      const segment = createSegment(db, { title: "task", tags: ["the-task"], nowEpoch: 100 });
      const plain = addTurn(1);
      updateTurnById(db, plain, { tags: ["the-task"], updatedAtEpoch: 200 });
      expect(membershipOf(plain)).toEqual([segment.id]);

      const owned = addTurn(2);
      frozenTask("legacy", owned);
      expect(() => updateTurnById(db, owned, { tags: ["the-task"], updatedAtEpoch: 200 })).toThrow(
        MembershipFrozenOwnerError,
      );
    });
  });

  // -------------------------------------------------------------------------
  // `remember`'s two `create` tiers and the three `retag` transitions (D5)
  // -------------------------------------------------------------------------

  describe("remember: create at both tiers, retag's three transitions", () => {
    function text(result: { content: Array<{ text: string }> }): string {
      return result.content[0]!.text;
    }

    test("task-tier `create … members` with an EMPTY tag refuses — name before grow", () => {
      addTurn(1);
      const out = text(
        rememberTool(db, {
          verb: "create",
          title: "unnamed with members",
          members: [`S${sessionId}/T1`],
        }),
      );
      expect(out).toStartWith("Parameter error:");
      expect(out).toContain("members needs a tag");
      expect(
        db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM segment_members").get()!
          .count,
      ).toBe(0);
    });

    test("task-tier `create … members` with a tag writes the TASK TAG onto every member", () => {
      const turnId = addTurn(1);
      const out = text(
        rememberTool(db, {
          verb: "create",
          title: "named with members",
          tag: "named-task",
          members: [`S${sessionId}/T1`],
        }),
      );
      const segmentId = Number(/Created E(\d+)/.exec(out)![1]);
      expect(storedTags(turnId)).toEqual(["named-task"]);
      expect(getSegmentMemberTurnIds(db, segmentId)).toEqual([turnId]);
    });

    test("lane-tier `create … members` under an UNNAMED parent refuses", () => {
      addTurn(1);
      const parent = createSegment(db, { title: "unnamed parent", nowEpoch: 100 }).id;

      const out = text(
        rememberTool(db, {
          verb: "create",
          id: `E${parent}/#a-lane`,
          members: [`S${sessionId}/T1`],
        }),
      );

      expect(out).toStartWith("Parameter error:");
      expect(out).toContain("has no task tag");
      expect(out).toContain("Nothing was written");
    });

    test("lane-tier `create … members` under a NAMED parent seeds task tag AND lane tag", () => {
      const turnId = addTurn(1);
      const parent = createSegment(db, {
        title: "named parent",
        tags: ["parent-task"],
        nowEpoch: 100,
      }).id;

      const out = text(
        rememberTool(db, {
          verb: "create",
          id: `E${parent}/#a-lane`,
          members: [`S${sessionId}/T1`],
        }),
      );

      expect(out).toContain("1 member(s) seeded");
      expect(storedTags(turnId)).toEqual(["parent-task", "a-lane"]);
      expect(getSegmentMemberTurnIds(db, parent)).toEqual([turnId]);
    });

    test("retag unnamed → named is `thaw-owner`: every FROZEN member receives the new tag atomically", () => {
      const a = addTurn(1);
      const b = addTurn(2);
      const frozen = createSegment(db, { title: "legacy", nowEpoch: 100 }).id;
      addSegmentMembers(db, frozen, [a, b], 100);

      const out = text(rememberTool(db, { verb: "retag", id: `E${frozen}`, tag: "thawed" }));

      expect(out).toContain('is now "thawed"');
      expect(out).toContain("2 frozen member turn(s) thawed");
      expect(storedTags(a)).toEqual(["thawed"]);
      expect(storedTags(b)).toEqual(["thawed"]);
      expect(frozenOwnerSegmentIds(db, a)).toEqual([]);
      expect(getSegmentMemberTurnIds(db, frozen).sort()).toEqual([a, b].sort());
    });

    test("a THAWED task then accepts an ordinary tag write that would have been refused before", () => {
      const owned = addTurn(1);
      const frozen = createSegment(db, { title: "legacy", nowEpoch: 100 }).id;
      addSegmentMembers(db, frozen, [owned], 100);
      const other = addTurn(2);

      // Before the thaw: joining another task is refused.
      createSegment(db, { title: "elsewhere", tags: ["elsewhere"], nowEpoch: 100 });
      expect(
        writeMembershipTags(db, {
          operation: "normal",
          writes: [{ turnId: owned, tags: ["elsewhere"] }],
          nowEpoch: 200,
        }).ok,
      ).toBe(false);

      rememberTool(db, { verb: "retag", id: `E${frozen}`, tag: "thawed" });

      // After it: the task GROWS, which is the whole point of naming it.
      const grown = writeMembershipTags(db, {
        operation: "normal",
        writes: [{ turnId: other, tags: ["thawed"] }],
        nowEpoch: 300,
      });
      expect(grown.ok).toBe(true);
      expect(getSegmentMemberTurnIds(db, frozen).sort()).toEqual([owned, other].sort());
    });

    test("retag named → new tag replaces the word on every owned member", () => {
      const turnId = addTurn(1);
      const segmentId = createSegment(db, { title: "task", tags: ["old-name"], nowEpoch: 100 }).id;
      writeMembershipTags(db, {
        operation: "normal",
        writes: [{ turnId, tags: ["old-name", "keep-me"] }],
        nowEpoch: 200,
      });

      const out = text(rememberTool(db, { verb: "retag", id: `E${segmentId}`, tag: "new-name" }));

      expect(out).toContain('1 member turn(s) re-tagged from "old-name" to "new-name"');
      expect(storedTags(turnId)).toEqual(["new-name", "keep-me"]);
      expect(getSegmentMemberTurnIds(db, segmentId)).toEqual([turnId]);
    });

    test("retag named → null REFUSES while the task owns a member — clear first, explicitly", () => {
      const turnId = addTurn(1);
      const segmentId = createSegment(db, { title: "task", tags: ["a-name"], nowEpoch: 100 }).id;
      writeMembershipTags(db, {
        operation: "normal",
        writes: [{ turnId, tags: ["a-name"] }],
        nowEpoch: 200,
      });

      const out = text(rememberTool(db, { verb: "retag", id: `E${segmentId}`, tag: null }));

      expect(out).toStartWith("Parameter error:");
      expect(out).toContain("owns 1 member turn(s)");
      expect(out).toContain("frozen legacy ownership");
      expect(getSegment(db, segmentId)!.tags).toEqual(["a-name"]);
      expect(storedTags(turnId)).toEqual(["a-name"]);
    });

    test("retag named → null still works on a task with NO members", () => {
      const segmentId = createSegment(db, { title: "task", tags: ["a-name"], nowEpoch: 100 }).id;
      const out = text(rememberTool(db, { verb: "retag", id: `E${segmentId}`, tag: null }));
      expect(out).toContain("Cleared");
      expect(getSegment(db, segmentId)!.tags).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // The call-site sweep (D4: "`reassignSegmentMembers` is deleted or made
  // private to the migration, proven by a call-site sweep")
  // -------------------------------------------------------------------------

  describe("the second truth is gone", () => {
    function sourceFiles(dir: string, out: string[] = []): string[] {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          sourceFiles(full, out);
        } else if (full.endsWith(".ts")) {
          out.push(full);
        }
      }
      return out;
    }

    test("no file under src/ or tests/ CALLS `reassignSegmentMembers` any more", () => {
      const root = join(import.meta.dir, "..", "..");
      const callers = [...sourceFiles(join(root, "src")), ...sourceFiles(join(root, "tests"))]
        .filter((file) => /reassignSegmentMembers\s*\(/.test(readFileSync(file, "utf8")))
        .map((file) => file.slice(root.length + 1));
      expect(callers).toEqual([]);
    });

    test("`segment_members` is written by db/segments.ts alone — every other module goes through the primitive", () => {
      const root = join(import.meta.dir, "..", "..");
      const writers = sourceFiles(join(root, "src"))
        .filter((file) =>
          /(INSERT INTO segment_members|DELETE FROM segment_members|UPDATE segment_members)/.test(
            readFileSync(file, "utf8"),
          ),
        )
        .map((file) => file.slice(root.length + 1))
        .sort();
      // `db/segments.ts` holds the primitive and is now the ONLY module that
      // writes these rows at all. `db/schema.ts` stood here as a migration
      // writer for the main-agent-edges rollback tool, which restored
      // `segment_members` from the receipt archive; that tool is deleted
      // (ticket 12) and the name went with it. The tags normalisation READS
      // `segment_members` into the archive and never writes it back. A second
      // name here is the regression this case is for.
      expect(writers).toEqual(["src/db/segments.ts"]);
    });
  });
});
