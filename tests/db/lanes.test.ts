import { afterEach, beforeEach, expect, describe, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  checkCanonicalLaneTag,
  countDeclaredLanesForSegment,
  countLaneMemberTurnsInSegment,
  deleteLane,
  getLane,
  insertLane,
} from "../../src/db/lanes";
import { deriveSideTags, writeMemoryEdges } from "../../src/db/memory-edges";
import { initializeSchema } from "../../src/db/schema";
import { addSegmentMembers, createSegment } from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";

/**
 * `checkCanonicalLaneTag`'s charset (container-unification ticket 01, spec
 * D2 second half). Tightened from "no interior whitespace / lowercase / NFC
 * / no `:` prefix" to a full allow-list, `[a-z0-9-]` — because `recall`
 * splits its `id` parameter on `,` to support address lists, and the next
 * ticket's `E<n>/#<tag>` address form reserves `/` and `#` (with `*` and `.`
 * already selector syntax elsewhere in that grammar). A tag holding any of
 * them had no usable address — this is what closes that.
 */
describe("checkCanonicalLaneTag — charset tightened to [a-z0-9-] (ticket 01, spec D2)", () => {
  test("a tag drawn entirely from a-z, 0-9, and interior '-' is canonical", () => {
    expect(checkCanonicalLaneTag("write-gate")).toEqual({ ok: true });
    expect(checkCanonicalLaneTag("a1-b2-c3")).toEqual({ ok: true });
    expect(checkCanonicalLaneTag("plain")).toEqual({ ok: true });
  });

  // One case per selector separator the ticket names, each naming the exact
  // offending character rather than a generic "non-canonical".
  const SELECTOR_SEPARATORS = [",", "/", "#", "*", "."];
  for (const separator of SELECTOR_SEPARATORS) {
    test(`rejects "${separator}" — a selector separator, and the message names it`, () => {
      const tag = `write${separator}gate`;
      const result = checkCanonicalLaneTag(tag);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.violation).toBe("invalid-character");
        expect(result.message).toContain(JSON.stringify(separator));
      }
    });
  }

  test("rejects a tag starting with '-'", () => {
    const result = checkCanonicalLaneTag("-write-gate");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violation).toBe("edge-hyphen");
      expect(result.message).toContain("starts or ends");
    }
  });

  test("rejects a tag ending with '-'", () => {
    const result = checkCanonicalLaneTag("write-gate-");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violation).toBe("edge-hyphen");
    }
  });

  test("rejects a bare '-'", () => {
    expect(checkCanonicalLaneTag("-")).toEqual({
      ok: false,
      violation: "edge-hyphen",
      message: expect.stringContaining("starts or ends"),
    });
  });

  // A colon still gets its OWN, richer refusal (the hooks'-namespace
  // message) rather than folding into the generic invalid-character
  // reason — the "prefixed" check runs first and reports first.
  test("a ':' is still reported as a namespace prefix, not as a generic invalid character", () => {
    const result = checkCanonicalLaneTag("compact:boundary");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violation).toBe("prefixed");
      expect(result.message).toContain("namespace prefix");
    }
  });

  // Order sentinel: a value failing an EARLIER rule (mixed-case) still gets
  // that rule's reason, even though it would also fail the charset check
  // for the same reason ("A" is outside [a-z0-9-]). `tests/shared/
  // turn-phase.test.ts` pins this exact wording verbatim.
  test("mixed case is still reported as mixed-case, not invalid-character", () => {
    const result = checkCanonicalLaneTag("Lane-A");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violation).toBe("mixed-case");
      expect(result.message).toBe('tag "Lane-A" is not lowercase — canonical form is "lane-a".');
    }
  });
});

/**
 * `undeclare`'s guard — `countLaneMemberTurnsInSegment`.
 *
 * LANE-MODEL-V12 TICKET 10 CHANGED ITS CONDITION, from "an edge in this
 * segment still carries the tag" to "a MEMBER NODE still carries the tag in
 * its own tags". Membership comes from the node's own tags now, so the old
 * condition read zero for a PROVISIONAL lane — declared, tagged onto a turn
 * or two, no edge written yet (v12 D3 makes that legal and fixes no timepoint
 * by which an edge must appear) — and would have let that lane be undeclared
 * out from under its own members, leaving turns whose tags point at a lane
 * that does not exist. The two blocks below are the two halves of that
 * change: what now holds a lane open, and what now does not.
 *
 * TICKET 14's law-8 asymmetry is carried over unchanged, because it closes
 * the same deadlock on the new condition: a lane whose whole membership was
 * later SKIPPED must still be undeclarable, or it is held open forever by
 * turns that exist in no graph any reader can see and that are dormant, so
 * nothing can retag them either.
 */
describe("undeclare's guard — a MEMBER NODE holds the lane open (ticket 10)", () => {
  let db: Database;
  let sessionId: number;
  let segmentId: number;

  const NOW = 1_800_000_000;

  function open(): void {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "lanes-guard-session",
      project: "/tmp/project-lanes-guard",
      title: null,
      insight: null,
      createdAtEpoch: NOW,
      updatedAtEpoch: NOW,
      completedAtEpoch: null,
    }).id;
    segmentId = createSegment(db, { title: "Guard", nowEpoch: NOW }).id;
  }

  function seedTurn(
    promptNumber: number,
    options: { status?: string; wasRolledBack?: boolean; tags?: string[] | string } = {},
  ): number {
    const tags =
      options.tags === undefined
        ? null
        : typeof options.tags === "string"
          ? options.tags
          : JSON.stringify(options.tags);
    return db
      .query<{ id: number }, [number, number, string, number, number, string | null]>(
        `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch, was_rolled_back, tags)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        sessionId,
        promptNumber,
        options.status ?? "active",
        NOW,
        options.wasRolledBack ? 1 : 0,
        tags,
      )!.id;
  }

  function tagEdge(citingId: number, citedId: number, tags: readonly string[]): void {
    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: citingId },
          cited: { kind: "turn", id: citedId },
          relation: "extends" as never,
          provenance: "asserted",
          ...deriveSideTags(tags),
        },
      ],
      NOW,
    );
  }

  function kill(turnId: number, how: "skipped" | "rolled-back"): void {
    if (how === "skipped") {
      db.query<unknown, [number]>("UPDATE turns SET status = 'skipped' WHERE id = ?").run(turnId);
    } else {
      db.query<unknown, [number]>("UPDATE turns SET was_rolled_back = 1 WHERE id = ?").run(turnId);
    }
  }

  beforeEach(open);

  afterEach(() => {
    db.close();
  });

  test("a live member turn carrying the tag holds the lane open — the guard is not vacuous", () => {
    const t1 = seedTurn(1, { tags: ["write-gate"] });
    addSegmentMembers(db, segmentId, [t1], NOW);
    insertLane(db, segmentId, "write-gate", NOW);

    expect(countLaneMemberTurnsInSegment(db, segmentId, "write-gate")).toBe(1);
  });

  // THE TICKET'S OWN CASE, and the mutation sentinel for the condition
  // change: zero edges anywhere, two members. Restore the edge-counting
  // guard and this reads 0 — the provisional lane is undeclared out from
  // under the two turns whose tags name it.
  test("ticket 10: a PROVISIONAL lane with members and ZERO edges still refuses — the old edge condition read zero here", () => {
    const t1 = seedTurn(1, { tags: ["write-gate"] });
    const t2 = seedTurn(2, { tags: ["write-gate"] });
    addSegmentMembers(db, segmentId, [t1, t2], NOW);
    insertLane(db, segmentId, "write-gate", NOW);

    expect(
      db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM memory_edges").get()!.n,
    ).toBe(0);
    expect(countLaneMemberTurnsInSegment(db, segmentId, "write-gate")).toBe(2);
  });

  // The other half of the same change, and the sentinel that the guard is
  // not merely counting BOTH things: an edge whose endpoints do not carry
  // the tag holds nothing open. (Such a row is E4's business — an edge side
  // naming a lane its own endpoint does not claim — not a reason to keep a
  // memberless lane alive.)
  test("ticket 10: an edge carrying the tag whose endpoints do NOT carry it holds NOTHING open", () => {
    const t1 = seedTurn(1);
    const t2 = seedTurn(2);
    addSegmentMembers(db, segmentId, [t1, t2], NOW);
    insertLane(db, segmentId, "write-gate", NOW);
    tagEdge(t2, t1, ["write-gate"]);

    expect(countLaneMemberTurnsInSegment(db, segmentId, "write-gate")).toBe(0);
    // …and the `undeclare` that count gates therefore goes through.
    expect(deleteLane(db, segmentId, "write-gate")).toBe(true);
    expect(getLane(db, segmentId, "write-gate")).toBeNull();
  });

  test("ticket 14 (carried over): a SKIPPED member holds nothing open — a lane whose membership all died can be undeclared", () => {
    const t1 = seedTurn(1, { tags: ["write-gate"] });
    const t2 = seedTurn(2, { tags: ["write-gate"] });
    addSegmentMembers(db, segmentId, [t1, t2], NOW);
    insertLane(db, segmentId, "write-gate", NOW);
    expect(countLaneMemberTurnsInSegment(db, segmentId, "write-gate")).toBe(2);

    kill(t1, "skipped");
    kill(t2, "skipped");

    expect(countLaneMemberTurnsInSegment(db, segmentId, "write-gate")).toBe(0);
    expect(deleteLane(db, segmentId, "write-gate")).toBe(true);
  });

  test("ticket 14 (carried over): a ROLLED-BACK member holds nothing open either", () => {
    const t1 = seedTurn(1, { tags: ["write-gate"] });
    addSegmentMembers(db, segmentId, [t1], NOW);
    insertLane(db, segmentId, "write-gate", NOW);
    kill(t1, "rolled-back");

    expect(countLaneMemberTurnsInSegment(db, segmentId, "write-gate")).toBe(0);
  });

  test("a dead member does not mask a live one — the guard still refuses while any live member carries the tag", () => {
    const live = seedTurn(1, { tags: ["write-gate"] });
    const doomed = seedTurn(2, { tags: ["write-gate"] });
    addSegmentMembers(db, segmentId, [live, doomed], NOW);
    insertLane(db, segmentId, "write-gate", NOW);
    kill(doomed, "skipped");

    expect(countLaneMemberTurnsInSegment(db, segmentId, "write-gate")).toBe(1);
  });

  // Identity is `(segment, tag)`: the same word declared in two segments is
  // TWO lanes, and each is held open only by ITS OWN members. Under the edge
  // condition one cross-segment edge counted for BOTH segments; under the
  // node condition a turn has exactly one owning segment, so it can only
  // ever hold one of the two lanes open.
  test("the same word in two segments: each lane is held open by its OWN members only", () => {
    const otherSegmentId = createSegment(db, { title: "Other", nowEpoch: NOW }).id;
    const here = seedTurn(1, { tags: ["shared-lane"] });
    const there = seedTurn(2, { tags: ["shared-lane"] });
    addSegmentMembers(db, segmentId, [here], NOW);
    addSegmentMembers(db, otherSegmentId, [there], NOW);
    insertLane(db, segmentId, "shared-lane", NOW);
    insertLane(db, otherSegmentId, "shared-lane", NOW);
    tagEdge(there, here, ["shared-lane"]);

    expect(countLaneMemberTurnsInSegment(db, segmentId, "shared-lane")).toBe(1);
    expect(countLaneMemberTurnsInSegment(db, otherSegmentId, "shared-lane")).toBe(1);

    // One side goes dormant and only ITS OWN lane is released.
    kill(there, "skipped");
    expect(countLaneMemberTurnsInSegment(db, segmentId, "shared-lane")).toBe(1);
    expect(countLaneMemberTurnsInSegment(db, otherSegmentId, "shared-lane")).toBe(0);
  });

  // OWNERSHIP, not mere membership: `MIN(segment_id)` is `getOwningSegmentId`'s
  // own tie-break, and the same rule `db/lane-checker-load.ts` resolves
  // `laneTags` by — so a legacy multi-membership turn is a member of exactly
  // the lane the checker would also count it in.
  test("a turn in two segments counts only for its OWNING (lowest-id) segment", () => {
    const otherSegmentId = createSegment(db, { title: "Other", nowEpoch: NOW }).id;
    const shared = seedTurn(1, { tags: ["write-gate"] });
    addSegmentMembers(db, segmentId, [shared], NOW);
    addSegmentMembers(db, otherSegmentId, [shared], NOW);
    insertLane(db, segmentId, "write-gate", NOW);
    insertLane(db, otherSegmentId, "write-gate", NOW);

    expect(segmentId).toBeLessThan(otherSegmentId);
    expect(countLaneMemberTurnsInSegment(db, segmentId, "write-gate")).toBe(1);
    expect(countLaneMemberTurnsInSegment(db, otherSegmentId, "write-gate")).toBe(0);
  });

  // `turns.tags` carries no `json_valid` CHECK, and SQLite's `json_each`
  // RAISES on a malformed value rather than returning zero rows — inside a
  // WHERE clause that fails the WHOLE statement. One unreadable column must
  // not make `undeclare` un-runnable for the entire segment.
  test("a malformed tags column claims no lane and does not take the guard down", () => {
    const broken = seedTurn(1, { tags: "{not json" });
    const nonArray = seedTurn(2, { tags: '"write-gate"' });
    const real = seedTurn(3, { tags: ["write-gate"] });
    addSegmentMembers(db, segmentId, [broken, nonArray, real], NOW);
    insertLane(db, segmentId, "write-gate", NOW);

    expect(countLaneMemberTurnsInSegment(db, segmentId, "write-gate")).toBe(1);
  });

  // A homeless turn (no `segment_members` row) belongs to no segment, so it
  // can belong to no lane either (D3e) — it holds nothing open, whatever its
  // tags say.
  test("a homeless turn carrying the word holds nothing open", () => {
    const homeless = seedTurn(1, { tags: ["write-gate"] });
    expect(homeless).toBeGreaterThan(0);
    insertLane(db, segmentId, "write-gate", NOW);

    expect(countLaneMemberTurnsInSegment(db, segmentId, "write-gate")).toBe(0);
  });
});

/**
 * `countDeclaredLanesForSegment` (staged-settlement ticket 09, spec §Lane
 * threshold) — the count `session-init`'s lane-threshold reminder gates on.
 * Currently-declared, not ever-declared: `deleteLane`/`clearLane` physically
 * remove the row, so no liveness filter sits on top the way the member-turn
 * counts above need one.
 */
describe("countDeclaredLanesForSegment (staged-settlement ticket 09)", () => {
  let db: Database;
  let segmentId: number;
  let otherSegmentId: number;

  const NOW = 1_800_000_000;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    segmentId = createSegment(db, { title: "Lane count", nowEpoch: NOW }).id;
    otherSegmentId = createSegment(db, { title: "Other", nowEpoch: NOW }).id;
  });

  afterEach(() => {
    db.close();
  });

  test("zero for a segment with no declared lanes", () => {
    expect(countDeclaredLanesForSegment(db, segmentId)).toBe(0);
  });

  test("counts exactly the lanes declared in THIS segment, not another segment's", () => {
    insertLane(db, segmentId, "alpha", NOW);
    insertLane(db, segmentId, "beta", NOW);
    insertLane(db, otherSegmentId, "gamma", NOW);

    expect(countDeclaredLanesForSegment(db, segmentId)).toBe(2);
    expect(countDeclaredLanesForSegment(db, otherSegmentId)).toBe(1);
  });

  test("drops back down when a lane is deleted", () => {
    insertLane(db, segmentId, "alpha", NOW);
    insertLane(db, segmentId, "beta", NOW);
    deleteLane(db, segmentId, "alpha");

    expect(countDeclaredLanesForSegment(db, segmentId)).toBe(1);
  });
});
