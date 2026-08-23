import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { loadLaneCheckScope } from "../../src/db/lane-checker-load";
import { writeMemoryEdges } from "../../src/db/memory-edges";
import { initializeSchema } from "../../src/db/schema";
import { addSegmentMembers, createSegment } from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { checkLanes } from "../../src/shared/lane-checker";
import { DEFAULT_SEGMENT } from "../../src/shared/lane-interpretation";

/**
 * The lane checker DB adapter (rubric-v10 ticket 06). These tests exercise
 * `loadLaneCheckScope` against a real (in-memory) schema, then feed the
 * projection through the REAL core (`checkLanes`) to prove the shape is
 * something the core actually accepts and interprets correctly — a test
 * that only inspected the projection's raw fields could pass while still
 * handing the core garbage.
 *
 * LOAD-BEARING PROPERTY: every edge this adapter returns has BOTH endpoints
 * present among the turns it also returns — the adapter's own answer to
 * "declare coverage when it cannot [widen]" is that it structurally CANNOT
 * emit a dangling edge (`loadEdgesForExactTagSet`/`loadEdgesByRelationTouching`
 * INNER JOIN both endpoints against `turns` with the law-8 predicate before
 * an edge is ever admitted, and the final turn load is exactly the union of
 * every admitted edge's own endpoints) — so `checkLanes`'s own report 1
 * `coverage` is "whole" for everything this adapter loads. The invariant
 * test below asserts this directly, across every scope kind; a mutation
 * that narrows the final turn-id set independently of the edge set (e.g.
 * swapping `allTurnIds` for `memberIdList` in `loadLaneCheckScope`) breaks
 * it immediately.
 */

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
  initializeSchema(db);
});

afterEach(() => {
  db.close();
});

const NOW = 1_800_000_000;

function seedSession(label = "lane-load"): number {
  return upsertSession(db, {
    contentSessionId: `${label}-${Math.random()}`,
    project: `/tmp/${label}`,
    title: label,
    content: null,
    insight: null,
    createdAtEpoch: NOW,
    updatedAtEpoch: NOW,
    completedAtEpoch: null,
  }).id;
}

function insertTurn(
  sessionId: number,
  promptNumber: number,
  options: {
    type?: string[];
    wasRolledBack?: boolean;
    status?: string;
    /** tag-mandate ticket 03: `turns.tags` verbatim. `undefined` leaves the column NULL (the pre-tag-era shape); a raw string lets a test store the malformed JSON the column has no CHECK against. */
    tags?: string[] | string;
  } = {},
): number {
  const tags =
    options.tags === undefined
      ? null
      : typeof options.tags === "string"
        ? options.tags
        : JSON.stringify(options.tags);
  return db
    .query<{ id: number }, [number, number, string, string, number, string, number, string, string | null]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         tool_call_count, created_at_epoch, was_rolled_back, type, tags
       ) VALUES (?, ?, ?, 'p', 'r', 1, ?, ?, ?, ?)
       RETURNING id`,
    )
    .get(
      sessionId,
      promptNumber,
      options.status ?? "active",
      NOW + promptNumber,
      options.wasRolledBack ? 1 : 0,
      JSON.stringify(options.type ?? ["design"]),
      tags,
    )!.id;
}

function tagEdge(citingId: number, citedId: number, relation: string, tags: readonly string[]): void {
  writeMemoryEdges(
    db,
    [
      {
        citing: { kind: "turn", id: citingId },
        cited: { kind: "turn", id: citedId },
        relation: relation as never,
        provenance: "asserted",
        tags,
      },
    ],
    NOW,
  );
}

/** The invariant every scenario below must satisfy: no edge points at a turn absent from the projection. */
function assertNoDanglingEdges(projection: { turns: { id: number }[]; edges: { citingId: number; citedId: number }[] }): void {
  const turnIds = new Set(projection.turns.map((turn) => turn.id));
  for (const edge of projection.edges) {
    expect(turnIds.has(edge.citingId)).toBe(true);
    expect(turnIds.has(edge.citedId)).toBe(true);
  }
}

describe("range scope", () => {
  test("widens beyond the requested prompt range to the lane's full live edges", () => {
    const sessionId = seedSession();
    const t1 = insertTurn(sessionId, 1);
    const t2 = insertTurn(sessionId, 2);
    // Far outside the requested [1,2] range, but the SAME lane.
    const t10 = insertTurn(sessionId, 10);

    tagEdge(t2, t1, "extends", ["ownership"]);
    tagEdge(t10, t1, "indexes", ["ownership"]);

    const projection = loadLaneCheckScope(db, {
      kind: "range",
      sessionId,
      promptStart: 1,
      promptEnd: 2,
    });

    const turnIds = projection.turns.map((turn) => turn.id).sort((a, b) => a - b);
    expect(turnIds).toEqual([t1, t2, t10].sort((a, b) => a - b));
    expect(
      projection.edges.some((edge) => edge.citingId === t10 && edge.citedId === t1 && edge.relation === "indexes"),
    ).toBe(true);
    assertNoDanglingEdges(projection);

    const result = checkLanes(projection.turns, projection.edges);
    expect(result.lanes).toHaveLength(1);
    expect(result.lanes[0]!.coverage).toEqual({ status: "whole", missingTurnIds: [] });
    expect(result.lanes[0]!.members.map((member) => member.id).sort((a, b) => a - b)).toEqual(
      [t1, t2, t10].sort((a, b) => a - b),
    );
  });

  test("a range with no tagged edges returns an empty projection (no lane, nothing to widen)", () => {
    const sessionId = seedSession();
    insertTurn(sessionId, 1);
    insertTurn(sessionId, 2);

    const projection = loadLaneCheckScope(db, {
      kind: "range",
      sessionId,
      promptStart: 1,
      promptEnd: 2,
    });

    expect(projection.involvedLaneKeys).toEqual([]);
    expect(projection.edges).toEqual([]);
  });
});

describe("segment scope", () => {
  test("loads a whole segment's members and their lane's edges", () => {
    const sessionId = seedSession();
    const t1 = insertTurn(sessionId, 1);
    const t2 = insertTurn(sessionId, 2);
    const t3 = insertTurn(sessionId, 3);
    const segment = createSegment(db, { title: "the segment", nowEpoch: NOW });
    addSegmentMembers(db, segment.id, [t1, t2, t3], NOW);

    tagEdge(t2, t1, "extends", ["decision"]);
    tagEdge(t3, t2, "indexes", ["decision"]);

    const projection = loadLaneCheckScope(db, { kind: "segment", segmentId: segment.id });

    expect(projection.involvedLaneKeys).toEqual([
      { segment: String(segment.id), tagSet: ["decision"] },
    ]);
    assertNoDanglingEdges(projection);

    const result = checkLanes(projection.turns, projection.edges);
    expect(result.lanes).toHaveLength(1);
    expect(result.lanes[0]!.declaration).toEqual({
      state: "declared",
      terminus: t3,
      latestEventTurn: t3,
    });
  });

  test("a segment's own scope does not pull in an unrelated segment's same-tag lane", () => {
    const sessionId = seedSession();
    const [t1, t2] = [insertTurn(sessionId, 1), insertTurn(sessionId, 2)];
    const [u1, u2] = [insertTurn(sessionId, 3), insertTurn(sessionId, 4)];
    const segmentA = createSegment(db, { title: "A", nowEpoch: NOW });
    const segmentB = createSegment(db, { title: "B", nowEpoch: NOW });
    addSegmentMembers(db, segmentA.id, [t1, t2], NOW);
    addSegmentMembers(db, segmentB.id, [u1, u2], NOW);

    // Same tag set, different segments -- two DISTINCT lanes.
    tagEdge(t2, t1, "extends", ["shared-tag"]);
    tagEdge(u2, u1, "extends", ["shared-tag"]);

    const projection = loadLaneCheckScope(db, { kind: "segment", segmentId: segmentA.id });

    const turnIds = new Set(projection.turns.map((turn) => turn.id));
    expect(turnIds.has(t1)).toBe(true);
    expect(turnIds.has(t2)).toBe(true);
    expect(turnIds.has(u1)).toBe(false);
    expect(turnIds.has(u2)).toBe(false);
  });
});

describe("named-lanes scope", () => {
  test("loads exactly the named lane, ignoring a same-tag lane in a different segment", () => {
    const sessionId = seedSession();
    const [t1, t2] = [insertTurn(sessionId, 1), insertTurn(sessionId, 2)];
    const [u1, u2] = [insertTurn(sessionId, 3), insertTurn(sessionId, 4)];
    const segmentA = createSegment(db, { title: "A", nowEpoch: NOW });
    const segmentB = createSegment(db, { title: "B", nowEpoch: NOW });
    addSegmentMembers(db, segmentA.id, [t1, t2], NOW);
    addSegmentMembers(db, segmentB.id, [u1, u2], NOW);

    tagEdge(t2, t1, "extends", ["shared-tag"]);
    tagEdge(u2, u1, "extends", ["shared-tag"]);

    const projection = loadLaneCheckScope(db, {
      kind: "lanes",
      laneKeys: [{ segment: String(segmentA.id), tagSet: ["shared-tag"] }],
    });

    const turnIds = new Set(projection.turns.map((turn) => turn.id));
    expect(turnIds.has(t1)).toBe(true);
    expect(turnIds.has(t2)).toBe(true);
    expect(turnIds.has(u1)).toBe(false);
    expect(turnIds.has(u2)).toBe(false);
    expect(projection.edges).toHaveLength(1);
  });

  test("the default-segment sentinel names a homeless lane", () => {
    const sessionId = seedSession();
    const t1 = insertTurn(sessionId, 1);
    const t2 = insertTurn(sessionId, 2);
    tagEdge(t2, t1, "extends", ["homeless-lane"]);

    const projection = loadLaneCheckScope(db, {
      kind: "lanes",
      laneKeys: [{ segment: DEFAULT_SEGMENT, tagSet: ["homeless-lane"] }],
    });

    expect(projection.edges).toHaveLength(1);
    expect(projection.turns.map((turn) => turn.id).sort((a, b) => a - b)).toEqual(
      [t1, t2].sort((a, b) => a - b),
    );
  });

  test("an unmatched lane (no edge carries that exact tag set) resolves empty, not an error", () => {
    const projection = loadLaneCheckScope(db, {
      kind: "lanes",
      laneKeys: [{ segment: DEFAULT_SEGMENT, tagSet: ["nothing-tagged-this"] }],
    });

    expect(projection.turns).toEqual([]);
    expect(projection.edges).toEqual([]);
  });

  // Round-5 review #13: the WIDEN pass used to filter candidates by the
  // CITING turn's segment only. For a cross-segment tagged edge (citing turn
  // in segment B, cited turn in segment A), naming the lane by the CITED
  // side's own segment (A) resolved EMPTY — the row exists, carries the
  // exact tag set, but its citingId's segment (B) never matches laneKey.segment
  // (A), so the old `.filter` dropped it. Both endpoints must be able to
  // match.
  test("a named lane keyed by the CITED side's segment still resolves a cross-segment tagged edge written from the citing side's segment", () => {
    const sessionId = seedSession();
    const t1 = insertTurn(sessionId, 1); // cited turn, will own segment A
    const t2 = insertTurn(sessionId, 2); // citing turn, will own segment B
    const segmentA = createSegment(db, { title: "A", nowEpoch: NOW });
    const segmentB = createSegment(db, { title: "B", nowEpoch: NOW });
    addSegmentMembers(db, segmentA.id, [t1], NOW);
    addSegmentMembers(db, segmentB.id, [t2], NOW);

    tagEdge(t2, t1, "extends", ["cross-seg"]);

    const projection = loadLaneCheckScope(db, {
      kind: "lanes",
      laneKeys: [{ segment: String(segmentA.id), tagSet: ["cross-seg"] }],
    });

    expect(projection.edges).toHaveLength(1);
    const turnIds = new Set(projection.turns.map((turn) => turn.id));
    expect(turnIds.has(t1)).toBe(true);
    expect(turnIds.has(t2)).toBe(true);
  });
});

describe("cited-side discovery — both endpoints' owning segments yield a lane key (round-5 review #13)", () => {
  test("a segment's own range/segment scan discovers its OWN copy of a cross-segment lane even when only the CITED turn is in scope", () => {
    const sessionId = seedSession();
    const t1 = insertTurn(sessionId, 1); // cited turn, segment A -- the ONLY member of A's scan
    const t2 = insertTurn(sessionId, 2); // citing turn, segment B
    const segmentA = createSegment(db, { title: "A", nowEpoch: NOW });
    const segmentB = createSegment(db, { title: "B", nowEpoch: NOW });
    addSegmentMembers(db, segmentA.id, [t1], NOW);
    addSegmentMembers(db, segmentB.id, [t2], NOW);

    tagEdge(t2, t1, "extends", ["x"]);

    const projection = loadLaneCheckScope(db, { kind: "segment", segmentId: segmentA.id });

    // Discovery must register segment A's OWN copy of this lane (the dual
    // appearance the pure core itself produces), not only segment B's --
    // the old citing-side-only discovery reported involvedLaneKeys as
    // [{segment: B, tagSet: ["x"]}], mislabelling A's own scan.
    expect(projection.involvedLaneKeys).toEqual(
      expect.arrayContaining([{ segment: String(segmentA.id), tagSet: ["x"] }]),
    );
    expect(projection.edges).toHaveLength(1);
  });
});

describe("law 8 -- rolled-back excluded, skipped dormant", () => {
  test("an edge whose CITING turn was rolled back never reaches the projection", () => {
    const sessionId = seedSession();
    const t1 = insertTurn(sessionId, 1);
    const t2 = insertTurn(sessionId, 2, { wasRolledBack: true });
    tagEdge(t2, t1, "extends", ["ownership"]);

    const projection = loadLaneCheckScope(db, {
      kind: "range",
      sessionId,
      promptStart: 1,
      promptEnd: 2,
    });

    expect(projection.edges).toEqual([]);
    expect(projection.turns.map((turn) => turn.id)).not.toContain(t2);
  });

  test("an edge whose CITED turn is skipped never reaches the projection", () => {
    const sessionId = seedSession();
    const t1 = insertTurn(sessionId, 1, { status: "skipped" });
    const t2 = insertTurn(sessionId, 2);
    tagEdge(t2, t1, "extends", ["ownership"]);

    const projection = loadLaneCheckScope(db, {
      kind: "range",
      sessionId,
      promptStart: 1,
      promptEnd: 2,
    });

    expect(projection.edges).toEqual([]);
    expect(projection.turns.map((turn) => turn.id)).not.toContain(t1);
  });

  test("a dead-but-live (in-lane overridden) member is NOT law-8 excluded -- law 8 is about was_rolled_back/status, not lane-local dead flags", () => {
    const sessionId = seedSession();
    const t1 = insertTurn(sessionId, 1);
    const t2 = insertTurn(sessionId, 2);
    const t3 = insertTurn(sessionId, 3);
    tagEdge(t2, t1, "extends", ["ownership"]);
    tagEdge(t3, t2, "override", ["ownership"]);

    const projection = loadLaneCheckScope(db, {
      kind: "range",
      sessionId,
      promptStart: 1,
      promptEnd: 3,
    });

    const result = checkLanes(projection.turns, projection.edges);
    const lane = result.lanes[0]!;
    expect(lane.members.find((member) => member.id === t2)!.dead).toBe(true);
    // t2 is still a MEMBER (present), just marked dead -- law 8 never hid it.
    expect(projection.turns.map((turn) => turn.id)).toContain(t2);
  });
});

describe("supplementary widening: cross-phase citedness, override, and the component neighbourhood", () => {
  test("an external grounds citation into a lane member is loaded (report 1 citedness)", () => {
    const sessionId = seedSession();
    const t1 = insertTurn(sessionId, 1, { type: ["design"] });
    const t2 = insertTurn(sessionId, 2, { type: ["design"] });
    const outside = insertTurn(sessionId, 3, { type: ["implement"] });
    tagEdge(t2, t1, "extends", ["ownership"]);
    tagEdge(outside, t1, "grounds", []);

    const projection = loadLaneCheckScope(db, {
      kind: "range",
      sessionId,
      promptStart: 1,
      promptEnd: 2,
    });

    const result = checkLanes(projection.turns, projection.edges);
    expect(result.lanes[0]!.citedness.groundsFromNonMembers).toEqual([
      { citingId: outside, citedId: t1 },
    ]);
    assertNoDanglingEdges(projection);
  });

  // milestone-election ticket 04 — no NEW adapter plumbing was needed for
  // `used[]`: an external same-phase `consume` citation already reaches the
  // checker through the SAME component-neighbourhood widening report 4a's
  // bypass count already depends on (the homeless-lane fixpoint closure,
  // `widenComponentClosure`, for this default-segment scenario) — `consume`
  // has been in `LANE_COMPONENT_RELATIONS_SQL` since ticket 06. This test
  // proves the existing widening already carries it end to end into
  // `citedness.usedFromNonMembers`, the same way the grounds test above
  // proves it for `citedness.groundsFromNonMembers`.
  test("an external consume citation into a lane member is loaded (report 1 used[])", () => {
    const sessionId = seedSession();
    const t1 = insertTurn(sessionId, 1, { type: ["design"] });
    const t2 = insertTurn(sessionId, 2, { type: ["design"] });
    const outside = insertTurn(sessionId, 3, { type: ["design"] });
    tagEdge(t2, t1, "extends", ["ownership"]);
    tagEdge(outside, t1, "consume", []);

    const projection = loadLaneCheckScope(db, {
      kind: "range",
      sessionId,
      promptStart: 1,
      promptEnd: 2,
    });

    const result = checkLanes(projection.turns, projection.edges);
    expect(result.lanes[0]!.citedness.usedFromNonMembers).toEqual([
      { citingId: outside, citedId: t1 },
    ]);
    assertNoDanglingEdges(projection);
  });

  test("an untagged global-kill override touching a member is loaded", () => {
    const sessionId = seedSession();
    const t1 = insertTurn(sessionId, 1);
    const t2 = insertTurn(sessionId, 2);
    const killer = insertTurn(sessionId, 3);
    tagEdge(t2, t1, "extends", ["ownership"]);
    tagEdge(killer, t1, "override", []);

    const projection = loadLaneCheckScope(db, {
      kind: "range",
      sessionId,
      promptStart: 1,
      promptEnd: 2,
    });

    const result = checkLanes(projection.turns, projection.edges);
    expect(result.lanes[0]!.members.find((member) => member.id === t1)!.dead).toBe(true);
    assertNoDanglingEdges(projection);
  });
});

describe("load-bearing property: no edge ever points at a turn absent from the projection", () => {
  test("holds across a combined multi-widening fixture", () => {
    const sessionId = seedSession();
    const t1 = insertTurn(sessionId, 1, { type: ["design"] });
    const t2 = insertTurn(sessionId, 2, { type: ["design"] });
    const t10 = insertTurn(sessionId, 10, { type: ["design"] });
    const outside = insertTurn(sessionId, 11, { type: ["implement"] });
    const killer = insertTurn(sessionId, 12, { type: ["design"] });
    const dead = insertTurn(sessionId, 13, { wasRolledBack: true, type: ["design"] });

    tagEdge(t2, t1, "extends", ["ownership"]);
    tagEdge(t10, t1, "indexes", ["ownership"]);
    tagEdge(outside, t2, "grounds", []);
    tagEdge(killer, t10, "override", []);
    // A rolled-back turn's own edge must never surface at all.
    tagEdge(dead, t1, "extends", ["ownership"]);

    for (const scope of [
      { kind: "range", sessionId, promptStart: 1, promptEnd: 2 } as const,
      { kind: "lanes", laneKeys: [{ segment: DEFAULT_SEGMENT, tagSet: ["ownership"] }] } as const,
    ]) {
      const projection = loadLaneCheckScope(db, scope);
      assertNoDanglingEdges(projection);
      const result = checkLanes(projection.turns, projection.edges);
      for (const lane of result.lanes) {
        expect(lane.coverage.status).toBe("whole");
        expect(lane.coverage.missingTurnIds).toEqual([]);
      }
      expect(projection.turns.map((turn) => turn.id)).not.toContain(dead);
    }
  });
});

describe("turn-order key (round-4 review #2) — reduction follows (session, prompt_number), never row id", () => {
  test("a backfilled turn's larger row id does not make its declaration 'later' — the adapter supplies the true prompt-number order", () => {
    const sessionId = seedSession();
    // Inserted in REVERSE prompt-number order — prompt 2 gets the SMALLEST
    // row id, prompt 0 the LARGEST — simulating a backfill: an id ordering
    // that inverts the turns' true conversational position.
    const promptTwo = insertTurn(sessionId, 2);
    const promptOne = insertTurn(sessionId, 1);
    const promptZero = insertTurn(sessionId, 0);
    tagEdge(promptTwo, promptZero, "indexes", ["lane"]);
    tagEdge(promptOne, promptZero, "indexes", ["lane"]);

    const projection = loadLaneCheckScope(db, {
      kind: "range",
      sessionId,
      promptStart: 0,
      promptEnd: 2,
    });
    const turnOrders = new Map(projection.turns.map((turn) => [turn.id, turn.order]));
    // The adapter's own `order` is a `[session_id, prompt_number]` tuple
    // (round-5 review #10 — never a scalar encoding of the pair): it must
    // rank strictly by prompt_number, not id, compared lexicographically.
    // promptTwo (smallest id) must carry the LARGEST order.
    const compare = (a: readonly [number, number], b: readonly [number, number]) => a[0] - b[0] || a[1] - b[1];
    expect(compare(turnOrders.get(promptTwo)!, turnOrders.get(promptOne)!)).toBeGreaterThan(0);
    expect(compare(turnOrders.get(promptOne)!, turnOrders.get(promptZero)!)).toBeGreaterThan(0);
    // And exactly the direct, unencoded pair — no scalar formula anywhere.
    expect(turnOrders.get(promptTwo)!).toEqual([sessionId, 2]);
    expect(turnOrders.get(promptOne)!).toEqual([sessionId, 1]);
    expect(turnOrders.get(promptZero)!).toEqual([sessionId, 0]);

    const result = checkLanes(projection.turns, projection.edges);
    // A reducer that (incorrectly) sorted by raw id would process promptOne
    // (id 2) before promptTwo (id 1) is false here since ids run
    // promptTwo < promptOne < promptZero — sorting by id would process
    // promptTwo FIRST and promptOne LAST, landing terminus=promptOne. True
    // prompt-number order processes promptOne (prompt 1) before promptTwo
    // (prompt 2), so promptTwo's declaration must win.
    expect(result.lanes[0]!.declaration.terminus).toBe(promptTwo);
  });
});

describe("segment-global component widening (round-4 review #4a)", () => {
  test("R2 reaches a member two hops away through the segment's OTHER members, not just a one-hop neighbourhood", () => {
    const sessionId = seedSession();
    const h1 = insertTurn(sessionId, 1);
    const h2 = insertTurn(sessionId, 2);
    const h3 = insertTurn(sessionId, 3);
    const h4 = insertTurn(sessionId, 4);
    const segment = createSegment(db, { title: "hop segment", nowEpoch: NOW });
    addSegmentMembers(db, segment.id, [h1, h2, h3, h4], NOW);

    // Lane members are h1/h4 only (the sole tagged edge). h1 and h4 are
    // connected to each other ONLY through two untagged `consume` hops via
    // h2 and h3 — a one-hop-from-a-member load would see h2 (touches h1)
    // and h3 (touches h4) but never the h3->h2 edge between them, since
    // neither h2 nor h3 is itself a lane member.
    tagEdge(h4, h1, "indexes", ["lane"]);
    tagEdge(h2, h1, "consume", []);
    tagEdge(h3, h2, "consume", []);
    tagEdge(h4, h3, "consume", []);

    const projection = loadLaneCheckScope(db, {
      kind: "lanes",
      laneKeys: [{ segment: String(segment.id), tagSet: ["lane"] }],
    });
    expect(
      projection.edges.some((edge) => edge.citingId === h3 && edge.citedId === h2 && edge.relation === "consume"),
    ).toBe(true);

    const result = checkLanes(projection.turns, projection.edges);
    expect(result.components[0]!.componentCount).toBe(1);
  });
});

describe("createdAtEpoch is plumbed onto the loaded turn shape (rubric-v10 ticket 08)", () => {
  test("each loaded turn carries its own created_at_epoch, matching what was inserted", () => {
    const sessionId = seedSession();
    const t1 = insertTurn(sessionId, 1);
    const t2 = insertTurn(sessionId, 2);
    tagEdge(t2, t1, "extends", ["ownership"]);

    const projection = loadLaneCheckScope(db, {
      kind: "range",
      sessionId,
      promptStart: 1,
      promptEnd: 2,
    });
    const epochs = new Map(projection.turns.map((turn) => [turn.id, turn.createdAtEpoch]));
    // `insertTurn` sets `created_at_epoch = NOW + promptNumber` (see this
    // file's own helper above) — the ONE reader of this field is
    // `lane-checker.ts`'s report-4(c) time-order check, for cross-session
    // comparisons; this test only proves the adapter carries the real DB
    // value through unchanged, not that any check runs on it here.
    expect(epochs.get(t1)).toBe(NOW + 1);
    expect(epochs.get(t2)).toBe(NOW + 2);
  });
});

describe("homeless-lane fixpoint component widening (round-5 review #12)", () => {
  test("a default-segment lane reaches a member two hops away via a bridge chain, not just a one-hop neighbourhood", () => {
    const sessionId = seedSession();
    const h1 = insertTurn(sessionId, 1);
    const h2 = insertTurn(sessionId, 2);
    const h3 = insertTurn(sessionId, 3);
    const h4 = insertTurn(sessionId, 4);
    // No segment created at all -- this lane is DEFAULT_SEGMENT/homeless, so
    // it has no `segment_members` rows to widen from and depended solely on
    // the old one-hop "touching" load, which lost the h3->h2 bridge edge
    // exactly like the segment-scoped test above (neither h2 nor h3 is a
    // lane member, so a one-hop load from {h1,h4} sees h2 (touches h1) and
    // h3 (touches h4) but never discovers the h3->h2 edge between them).
    tagEdge(h4, h1, "indexes", ["bridge"]);
    tagEdge(h2, h1, "consume", []);
    tagEdge(h3, h2, "consume", []);
    tagEdge(h4, h3, "consume", []);

    const projection = loadLaneCheckScope(db, {
      kind: "lanes",
      laneKeys: [{ segment: DEFAULT_SEGMENT, tagSet: ["bridge"] }],
    });
    expect(
      projection.edges.some((edge) => edge.citingId === h3 && edge.citedId === h2 && edge.relation === "consume"),
    ).toBe(true);

    const result = checkLanes(projection.turns, projection.edges);
    // The true graph is ONE component (h1-h2-h3-h4 all bridged); the old
    // one-hop floor reported 2 (h1/h2 severed from h3/h4).
    expect(result.components[0]!.componentCount).toBe(1);
  });

  test("the fixpoint closure is bounded to the lane's own sessions — a same-shape bridge chain in a DIFFERENT session is never traversed", () => {
    const sessionId = seedSession();
    const otherSessionId = seedSession("lane-load-other");
    const h1 = insertTurn(sessionId, 1);
    const h4 = insertTurn(sessionId, 2);
    // h2/h3 live in a DIFFERENT session -- structurally reachable only if
    // the closure ignored the session bound entirely.
    const h2 = insertTurn(otherSessionId, 1);
    const h3 = insertTurn(otherSessionId, 2);
    tagEdge(h4, h1, "indexes", ["isolated"]);
    tagEdge(h2, h1, "consume", []);
    tagEdge(h3, h2, "consume", []);
    tagEdge(h4, h3, "consume", []);

    const projection = loadLaneCheckScope(db, {
      kind: "lanes",
      laneKeys: [{ segment: DEFAULT_SEGMENT, tagSet: ["isolated"] }],
    });

    const result = checkLanes(projection.turns, projection.edges);
    // Bounded to the lane's own session: h1/h4 never reach h2/h3 at all, so
    // the honest report is 2 severed components, not a false-healthy 1.
    expect(result.components[0]!.componentCount).toBe(2);
  });
});

describe("out-of-vocabulary edges (semantic-conformance ticket 02): the loader surfaces a frozen-legacy relation as a fact, never widening the graph", () => {
  test("a supersedes edge between two turns already in scope reaches the checker's vocabulary-conformance report, never the lane's own edge tally", () => {
    const sessionId = seedSession();
    const t1 = insertTurn(sessionId, 1);
    const t2 = insertTurn(sessionId, 2);
    tagEdge(t2, t1, "extends", ["ownership"]);
    tagEdge(t2, t1, "indexes", ["ownership"]);
    tagEdge(t2, t1, "supersedes", []); // frozen-legacy, never in EDGE_RELATIONS

    const projection = loadLaneCheckScope(db, {
      kind: "range",
      sessionId,
      promptStart: 1,
      promptEnd: 2,
    });
    // None of the OTHER passes ever surface `supersedes` on their own (they
    // filter to specific IN-vocabulary relation lists, or require tags,
    // which a frozen-legacy relation never carries), and it is deliberately
    // kept off `projection.edges` itself (that field's own doc comment) —
    // this projection carries it ONLY on its own separate field.
    expect(projection.outOfVocabularyEdges).toEqual([{ citingId: t2, citedId: t1, relation: "supersedes", tags: [] }]);
    expect(
      projection.edges.some((edge) => edge.citingId === t2 && edge.citedId === t1 && edge.relation === "supersedes"),
    ).toBe(false);
    assertNoDanglingEdges(projection);

    const result = checkLanes(projection.turns, projection.edges, projection.outOfVocabularyEdges);
    expect(result.vocabularyConformance.outOfVocabularyEdges).toEqual({
      count: 1,
      entries: [{ citingId: t2, citedId: t1, relation: "supersedes" }],
    });
    // Never admitted: the lane's own tagged-edge tally is exactly the
    // extends+indexes pair, no `supersedes` key at all.
    expect(result.lanes[0]!.edgeCountsByRelation).toEqual({ extends: 1, indexes: 1 });
  });

  // T1466 (finding P1-1) narrowed this claim rather than dropping it: a
  // seed-scoped pass now DOES widen for a row written FROM the scope (see
  // "turn-id seed scope" below). The direction is the anchor rule — this
  // case, whose CITING side is the out-of-scope turn, anchors outside and
  // stays unloaded, which is what the test has always actually pinned.
  test("a supersedes edge whose CITING side is outside the scope is never surfaced — it anchors outside and blocks a different window", () => {
    const sessionId = seedSession();
    const t1 = insertTurn(sessionId, 1);
    const t2 = insertTurn(sessionId, 2);
    const outside = insertTurn(sessionId, 3); // never referenced by any tagged edge
    tagEdge(t2, t1, "extends", ["ownership"]);
    tagEdge(t2, t1, "indexes", ["ownership"]);
    tagEdge(outside, t1, "supersedes", []); // cites FROM `outside`, which is never in scope

    const projection = loadLaneCheckScope(db, {
      kind: "range",
      sessionId,
      promptStart: 1,
      promptEnd: 2,
    });
    expect(projection.turns.map((turn) => turn.id)).not.toContain(outside);
    expect(projection.outOfVocabularyEdges).toEqual([]);

    const result = checkLanes(projection.turns, projection.edges, projection.outOfVocabularyEdges);
    expect(result.vocabularyConformance.outOfVocabularyEdges).toEqual({ count: 0, entries: [] });
  });

  // NB (pre-existing, out of this ticket's scope): a TAGGED out-of-vocabulary
  // relation (e.g. a hypothetically tagged `supersedes`) is NOT excluded from
  // `projection.edges` — the DISCOVER/WIDEN passes above (`loadTaggedEdges
  // Touching`/`loadEdgesForExactTagSet`) admit ANY relation carrying a
  // non-empty tag, with no relation-word filter of their own; only an
  // UNTAGGED out-of-vocabulary edge is naturally absent from `edges` today
  // (no pass here ever selects it). `checkLanes` itself is unaffected either
  // way — it partitions its own `edges` argument regardless of source (see
  // `shared/lane-checker.test.ts`'s "a TAGGED supersedes edge still never
  // joins the lane" case) — but `mcp/note.ts`'s Gate C terminus check reduces
  // `projection.edges` directly with `deriveLaneInterpretation`, with no such
  // partition of its own, so a tagged legacy-relation edge would still reach
  // it. In practice this is inert: `supersedes` predates the tag model and is
  // documented as always-untagged. Not fixed here — closing it would mean
  // teaching DISCOVER/WIDEN a relation-word filter, a wider change than this
  // ticket's "report, don't enforce" scope; flagged for a follow-up ticket.

  test("a legacy-typed turn already in scope reaches the checker's type-violation report through the SAME loaded projection — no separate loader query needed for this half", () => {
    const sessionId = seedSession();
    const t1 = insertTurn(sessionId, 1, { type: ["bugfix"] });
    const t2 = insertTurn(sessionId, 2, { type: ["design"] });
    tagEdge(t2, t1, "extends", ["ownership"]);
    tagEdge(t2, t1, "indexes", ["ownership"]);

    const projection = loadLaneCheckScope(db, {
      kind: "range",
      sessionId,
      promptStart: 1,
      promptEnd: 2,
    });
    const result = checkLanes(projection.turns, projection.edges);
    expect(result.vocabularyConformance.typeViolations).toEqual({
      count: 1,
      entries: [{ id: t1, types: ["bugfix"], outsideVocabulary: ["bugfix"] }],
    });
  });
});

// ---------------------------------- tag-mandate ticket 03: turn tags + the skip exemption

/**
 * LOAD-BEARING PROPERTY (tag-mandate ticket 03). Error class E3 (empty or
 * out-of-vocabulary turn `type`) must never fire on a legally-SKIPPED or
 * rolled-back turn, and error class E4 (the subset invariant over stock)
 * needs each turn's own `tags` on BOTH endpoints of every tagged edge.
 *
 * Both properties live HERE, not in the checker: the exemption is LAW 8
 * (`liveTurnSql` on every query in `db/lane-checker-load.ts`, both turn rows
 * and both endpoints of every edge), and the tags are a column only this
 * adapter reads. A future load path that bypasses `liveTurnSql` would
 * silently re-admit skipped turns as commit-blocking errors anchored at rows
 * the agent is never even shown.
 */
describe("tag-mandate ticket 03 — turn tags reach the checker, skipped turns never do", () => {
  test("a turn's own tags ride the projection, so the subset invariant (E4) is judged rather than skipped", () => {
    const sessionId = seedSession();
    const t1 = insertTurn(sessionId, 1, { tags: ["ownership"] });
    const t2 = insertTurn(sessionId, 2, { tags: ["ownership"] });
    tagEdge(t2, t1, "extends", ["ownership"]);
    tagEdge(t2, t1, "indexes", ["ownership"]);

    const projection = loadLaneCheckScope(db, { kind: "range", sessionId, promptStart: 1, promptEnd: 2 });
    expect(projection.turns.map((turn) => turn.tags)).toEqual([["ownership"], ["ownership"]]);
    expect(checkLanes(projection.turns, projection.edges).errors).toEqual([]);
  });

  test("an endpoint whose tags no longer carry the edge's tag is an E4 error anchored at the citing turn — the tag-EDIT orphan the write gate cannot catch", () => {
    const sessionId = seedSession();
    const t1 = insertTurn(sessionId, 1, { tags: ["ownership"] });
    const t2 = insertTurn(sessionId, 2, { tags: ["ownership"] });
    tagEdge(t2, t1, "extends", ["ownership"]);
    tagEdge(t2, t1, "indexes", ["ownership"]);
    // The edit the write gate can never see: the CITED endpoint drops the tag
    // long after the edge that depends on it landed.
    db.query(`UPDATE turns SET tags = '[]' WHERE id = ?`).run(t1);

    const projection = loadLaneCheckScope(db, { kind: "range", sessionId, promptStart: 1, promptEnd: 2 });
    const errors = checkLanes(projection.turns, projection.edges).errors;
    expect(errors.map((error) => `${error.class}@${error.anchorId}`)).toEqual([`E4@${t2}`, `E4@${t2}`]);
  });

  test("a NULL tags column reads as the empty set (a real verdict), a malformed one as not-loaded (no verdict)", () => {
    const sessionId = seedSession();
    const nullTags = insertTurn(sessionId, 1); // column left NULL
    const malformed = insertTurn(sessionId, 2, { tags: "{not json array" });

    const projection = loadLaneCheckScope(db, { kind: "range", sessionId, promptStart: 1, promptEnd: 2 });
    const byId = new Map(projection.turns.map((turn) => [turn.id, turn]));
    expect(byId.get(nullTags)!.tags).toEqual([]);
    expect(byId.get(malformed)!.tags).toBeUndefined();
  });

  test("a legally-SKIPPED turn with an empty type never reaches the checker, so it can never raise E3", () => {
    const sessionId = seedSession();
    const live = insertTurn(sessionId, 1, { type: [] }); // same defect, live
    const skipped = insertTurn(sessionId, 2, { type: [], status: "skipped" });
    const rolledBack = insertTurn(sessionId, 3, { type: [], wasRolledBack: true });

    const projection = loadLaneCheckScope(db, { kind: "range", sessionId, promptStart: 1, promptEnd: 3 });
    const loadedIds = projection.turns.map((turn) => turn.id);
    expect(loadedIds).toContain(live);
    expect(loadedIds).not.toContain(skipped);
    expect(loadedIds).not.toContain(rolledBack);

    // The exemption is doing real work: the identical defect on the LIVE turn
    // is an error, so the two dormant rows are excluded by liveness alone.
    const errors = checkLanes(projection.turns, projection.edges).errors;
    expect(errors.map((error) => `${error.class}@${error.anchorId}`)).toEqual([`E3@${live}`]);
  });

  test("an untagged extends among the loaded edges is an E1 error anchored at its citing turn", () => {
    const sessionId = seedSession();
    const t1 = insertTurn(sessionId, 1, { tags: ["ownership"] });
    const t2 = insertTurn(sessionId, 2, { tags: ["ownership"] });
    const t3 = insertTurn(sessionId, 3, { tags: ["ownership"] });
    tagEdge(t2, t1, "extends", ["ownership"]);
    tagEdge(t2, t1, "indexes", ["ownership"]);
    tagEdge(t3, t2, "extends", []); // the stock defect the mandate forces open

    const projection = loadLaneCheckScope(db, { kind: "range", sessionId, promptStart: 1, promptEnd: 3 });
    const errors = checkLanes(projection.turns, projection.edges, projection.outOfVocabularyEdges).errors;
    expect(errors).toEqual([
      { class: "E1", anchorId: t3, citingId: t3, citedId: t2, relation: "extends" },
    ]);
  });
});

// ------------------------- peer round T1466: collision-free exact-set match (P2-9)

/**
 * LOAD-BEARING PROPERTY. The WIDEN pass decides which rows belong to a lane by
 * comparing canonical tag SETS. It used to compare a U+0001-delimited JOIN of
 * the set, which collides exactly the way round-5 review #14 already found for
 * the lane token: a tag that CONTAINS the delimiter character merges into its
 * neighbour, so the three-tag set {a, b, c} and the two-tag set {a, "b<SEP>c"}
 * produce the identical string. The `memory_edge_tags` prefilter cannot rule
 * this out — both sets share the tag "a", so both rows are candidates — and a
 * hit pulls ANOTHER lane's edges into this lane's projection, and from there
 * into the commit gate's verdict. The compare is a canonical JSON array now,
 * self-delimiting through its own quoting.
 */
describe("exact tag-SET matching is collision-free (T1466 P2-9)", () => {
  // Built rather than written as a literal so this file carries no control
  // byte of its own.
  const SEP = String.fromCharCode(1);

  test("two DIFFERENT tag arrays that join identically stay two lanes — neither pulls the other's edges", () => {
    const sessionId = seedSession("tag-collision");
    // Each turn carries its edge's own tags, so the fixture is clean under
    // E4 too and the only thing left that could raise an error is the
    // collision itself.
    const a1 = insertTurn(sessionId, 1, { tags: ["a", "b", "c"] });
    const a2 = insertTurn(sessionId, 2, { tags: ["a", "b", "c"] });
    const b1 = insertTurn(sessionId, 3, { tags: ["a", "b" + SEP + "c"] });
    const b2 = insertTurn(sessionId, 4, { tags: ["a", "b" + SEP + "c"] });
    tagEdge(a2, a1, "extends", ["a", "b", "c"]);
    tagEdge(b2, b1, "extends", ["a", "b" + SEP + "c"]);

    // Naming the three-tag lane must load ITS edge only.
    const three = loadLaneCheckScope(db, {
      kind: "lanes",
      laneKeys: [{ segment: DEFAULT_SEGMENT, tagSet: ["a", "b", "c"] }],
    });
    expect(three.edges).toEqual([
      { citingId: a2, citedId: a1, relation: "extends", tags: ["a", "b", "c"] },
    ]);
    expect(three.turns.map((turn) => turn.id).sort((x, y) => x - y)).toEqual([a1, a2]);

    // And the colliding two-tag lane loads only its own.
    const two = loadLaneCheckScope(db, {
      kind: "lanes",
      laneKeys: [{ segment: DEFAULT_SEGMENT, tagSet: ["a", "b" + SEP + "c"] }],
    });
    expect(two.edges).toEqual([
      { citingId: b2, citedId: b1, relation: "extends", tags: ["a", "b" + SEP + "c"] },
    ]);
    expect(two.turns.map((turn) => turn.id).sort((x, y) => x - y)).toEqual([b1, b2]);

    // End to end: a scope holding both still reports TWO lanes with disjoint
    // members, never one merged lane (which would then report a shape error
    // it never earned).
    const both = loadLaneCheckScope(db, { kind: "turns", turnIds: [a1, a2, b1, b2] });
    const result = checkLanes(both.turns, both.edges, both.outOfVocabularyEdges);
    expect(result.lanes.map((lane) => lane.key.tagSet)).toEqual([
      ["a", "b", "c"],
      ["a", "b" + SEP + "c"],
    ]);
    expect(result.lanes.map((lane) => lane.members.map((member) => member.id))).toEqual([
      [a1, a2],
      [b1, b2],
    ]);
    expect(result.errors).toEqual([]);
  });
});

// ------------------------------- peer round T1466: the turn-id seed scope (P1-1)

/**
 * LOAD-BEARING PROPERTIES of `{ kind: "turns" }` (mutation acceptance).
 *
 * The finding: the settlement window's writable set is an immutable, enumerated
 * turn-id list (window ∪ declared lookback ∪ closure) that no prompt-number
 * RANGE can express. Seeding on `windowStart..windowEnd` alone means a
 * lookback turn's E1/E3 stock never LOADS, so filtering errors by anchor
 * afterwards cannot recover it — the projection, not the filter, is where the
 * loss happens. Four properties, each with its own test below:
 *
 *   1. PROJECTION COMPLETENESS. Every seeded id is judged: an untagged
 *      stance edge, a legacy type, and an out-of-vocabulary relation all
 *      fire for a seed no range would have covered. Narrow any pass back to
 *      a subset of the seed and one of these goes silent.
 *   2. THE EXEMPTIONS ARE NOT RE-IMPLEMENTED. A skipped or rolled-back id in
 *      the frozen set loads NOTHING (`loadLiveTurns` + `liveTurnSql`), so
 *      the caller may hand over its writable set verbatim without first
 *      re-deriving liveness — and no commit can be blocked by a row its
 *      agent is never shown.
 *   3. SET SEMANTICS. The projection is a pure function of the id SET:
 *      duplicates and caller order change nothing.
 *   4. E2's CITING-SIDE REACH. An out-of-vocabulary edge written FROM a seed
 *      is loaded even when its cited turn is outside every other pass, and
 *      that endpoint JOINS the projection (no dangling edge). The reverse —
 *      cited side in scope, citing side outside — stays unloaded: it anchors
 *      elsewhere and blocks a different window.
 */
describe("turn-id seed scope — the frozen writable set as the projection's seed (T1466 P1-1)", () => {
  test("a LOOKBACK turn's untagged extends fires E1 under the turn-id seed, and is invisible to the window's own range", () => {
    const sessionId = seedSession("seed-lookback");
    const lookbackCited = insertTurn(sessionId, 1, { type: ["design"] });
    const lookbackCiting = insertTurn(sessionId, 2, { type: ["design"] });
    const windowA = insertTurn(sessionId, 8, { type: ["design"] });
    const windowB = insertTurn(sessionId, 9, { type: ["design"] });
    tagEdge(lookbackCiting, lookbackCited, "extends", []); // the stock defect, in the lookback

    // The defect the RANGE cannot see: the window is prompts 8-9.
    const rangeOnly = loadLaneCheckScope(db, {
      kind: "range",
      sessionId,
      promptStart: 8,
      promptEnd: 9,
    });
    expect(
      checkLanes(rangeOnly.turns, rangeOnly.edges, rangeOnly.outOfVocabularyEdges).errors.filter(
        (error) => error.class === "E1",
      ),
    ).toEqual([]);

    // The same defect, under the writable set the commit gate actually froze.
    const projection = loadLaneCheckScope(db, {
      kind: "turns",
      turnIds: [lookbackCited, lookbackCiting, windowA, windowB],
    });
    assertNoDanglingEdges(projection);
    const e1 = checkLanes(projection.turns, projection.edges, projection.outOfVocabularyEdges).errors.filter(
      (error) => error.class === "E1",
    );
    expect(e1.map((error) => error.anchorId)).toEqual([lookbackCiting]);
  });

  test("an EDGE-LESS seed still loads: a legacy type anywhere in the frozen set fires E3", () => {
    const sessionId = seedSession("seed-edgeless");
    const legacy = insertTurn(sessionId, 1, { type: ["discovery"] });
    const windowTurn = insertTurn(sessionId, 7, { type: ["design"] });

    const projection = loadLaneCheckScope(db, { kind: "turns", turnIds: [legacy, windowTurn] });
    expect(projection.edges).toEqual([]);
    const e3 = checkLanes(projection.turns, projection.edges, projection.outOfVocabularyEdges).errors.filter(
      (error) => error.class === "E3",
    );
    expect(e3.map((error) => error.anchorId)).toEqual([legacy]);
  });

  test("an out-of-vocabulary edge whose CITED endpoint is outside the seed is still surfaced, and that endpoint joins the projection", () => {
    const sessionId = seedSession("seed-e2-external");
    const seedTurn = insertTurn(sessionId, 5, { type: ["design"] });
    const external = insertTurn(sessionId, 1, { type: ["design"] }); // in no lane, in no seed
    tagEdge(seedTurn, external, "supersedes", []); // frozen-legacy, anchors at seedTurn

    const projection = loadLaneCheckScope(db, { kind: "turns", turnIds: [seedTurn] });

    expect(projection.outOfVocabularyEdges).toEqual([
      { citingId: seedTurn, citedId: external, relation: "supersedes", tags: [] },
    ]);
    // The endpoint is JOINED IN rather than left dangling — the same
    // invariant every other pass holds. (It becomes a judgable row in its own
    // right; any error it earns anchors at ITSELF, i.e. outside this
    // window's writable set, so the commit gate still ignores it.)
    expect(projection.turns.map((turn) => turn.id)).toContain(external);
    assertNoDanglingEdges(projection);

    const e2 = checkLanes(projection.turns, projection.edges, projection.outOfVocabularyEdges).errors.filter(
      (error) => error.class === "E2",
    );
    expect(e2.map((error) => error.anchorId)).toEqual([seedTurn]);
  });

  test("the CITING side is the direction: an out-of-vocabulary edge INTO a seed from outside anchors elsewhere and is not loaded", () => {
    const sessionId = seedSession("seed-e2-inbound");
    const seedTurn = insertTurn(sessionId, 5, { type: ["design"] });
    const external = insertTurn(sessionId, 9, { type: ["design"] });
    tagEdge(external, seedTurn, "supersedes", []); // anchors at `external`, not at the seed

    const projection = loadLaneCheckScope(db, { kind: "turns", turnIds: [seedTurn] });
    expect(projection.outOfVocabularyEdges).toEqual([]);
    expect(projection.turns.map((turn) => turn.id)).not.toContain(external);
  });

  test("DISCOVER/WIDEN seed from the FULL set: a lane touched only by a lookback seed still resolves whole", () => {
    const sessionId = seedSession("seed-widen");
    const laneStart = insertTurn(sessionId, 1, { tags: ["ownership"] });
    const laneMiddle = insertTurn(sessionId, 2, { tags: ["ownership"] });
    const laneEnd = insertTurn(sessionId, 20, { tags: ["ownership"] }); // far outside any window
    const windowTurn = insertTurn(sessionId, 9, { type: ["design"] });
    tagEdge(laneMiddle, laneStart, "extends", ["ownership"]);
    tagEdge(laneEnd, laneMiddle, "indexes", ["ownership"]);

    // Only the lookback half of the frozen set touches the lane at all.
    const projection = loadLaneCheckScope(db, {
      kind: "turns",
      turnIds: [laneStart, laneMiddle, windowTurn],
    });
    expect(projection.involvedLaneKeys).toEqual([{ segment: DEFAULT_SEGMENT, tagSet: ["ownership"] }]);
    expect(projection.turns.map((turn) => turn.id)).toContain(laneEnd);

    const result = checkLanes(projection.turns, projection.edges, projection.outOfVocabularyEdges);
    expect(result.lanes[0]!.coverage).toEqual({ status: "whole", missingTurnIds: [] });
    expect(result.lanes[0]!.declaration.terminus).toBe(laneEnd);
  });

  test("liveness/skip stays the loader's law, not the caller's: a skipped or rolled-back id in the frozen set loads nothing", () => {
    const sessionId = seedSession("seed-liveness");
    const live = insertTurn(sessionId, 1, { type: [] }); // the same defect, live
    const skipped = insertTurn(sessionId, 2, { type: [], status: "skipped" });
    const rolledBack = insertTurn(sessionId, 3, { type: [], wasRolledBack: true });

    const projection = loadLaneCheckScope(db, {
      kind: "turns",
      turnIds: [live, skipped, rolledBack],
    });
    const loadedIds = projection.turns.map((turn) => turn.id);
    expect(loadedIds).toContain(live);
    expect(loadedIds).not.toContain(skipped);
    expect(loadedIds).not.toContain(rolledBack);

    const errors = checkLanes(projection.turns, projection.edges, projection.outOfVocabularyEdges).errors;
    expect(errors.map((error) => `${error.class}@${error.anchorId}`)).toEqual([`E3@${live}`]);
  });

  test("SET semantics: duplicates and caller order never change the projection", () => {
    const sessionId = seedSession("seed-set");
    const t1 = insertTurn(sessionId, 1, { tags: ["ownership"] });
    const t2 = insertTurn(sessionId, 2, { tags: ["ownership"] });
    tagEdge(t2, t1, "extends", ["ownership"]);

    const ascending = loadLaneCheckScope(db, { kind: "turns", turnIds: [t1, t2] });
    const shuffled = loadLaneCheckScope(db, { kind: "turns", turnIds: [t2, t1, t2, t1] });
    expect(shuffled.turns).toEqual(ascending.turns);
    expect(shuffled.edges).toEqual(ascending.edges);
    expect(shuffled.involvedLaneKeys).toEqual(ascending.involvedLaneKeys);
    expect(shuffled.outOfVocabularyEdges).toEqual(ascending.outOfVocabularyEdges);
  });

  test("an empty frozen set resolves empty rather than loading the database", () => {
    const sessionId = seedSession("seed-empty");
    const t1 = insertTurn(sessionId, 1, { tags: ["ownership"] });
    const t2 = insertTurn(sessionId, 2, { tags: ["ownership"] });
    tagEdge(t2, t1, "extends", ["ownership"]);

    const projection = loadLaneCheckScope(db, { kind: "turns", turnIds: [] });
    expect(projection.turns).toEqual([]);
    expect(projection.edges).toEqual([]);
    expect(projection.involvedLaneKeys).toEqual([]);
    expect(projection.outOfVocabularyEdges).toEqual([]);
  });
});

describe("tag-mandate ticket 05 acceptance repair — E1/E3 stock loads without any tagged lane nearby", () => {
  // The ticket-05 probe: every discovery/supplementary pass seeds from
  // DISCOVERED lane members, so a neighbourhood holding ONLY untagged
  // stance edges — the exact stock the mandate exists to repair — loaded
  // nothing, and E1 was invisible to lane_check and the commit gate alike.
  test("a pure untagged extends among laneless, tagless turns reaches the projection and fires E1 at the citing turn", () => {
    const sessionId = seedSession("e1-stock");
    const a = insertTurn(sessionId, 1, { type: ["design"] });
    const b = insertTurn(sessionId, 2, { type: ["design"] });
    tagEdge(b, a, "extends", []);

    const projection = loadLaneCheckScope(db, {
      kind: "range",
      sessionId,
      promptStart: 1,
      promptEnd: 2,
    });
    expect(projection.edges.some((e) => e.citingId === b && e.citedId === a && e.relation === "extends")).toBe(true);

    const result = checkLanes(projection.turns, projection.edges, projection.outOfVocabularyEdges);
    const e1 = result.errors.filter((error) => error.class === "E1");
    expect(e1).toHaveLength(1);
    expect(e1[0]!.anchorId).toBe(b);
  });

  test("an edge-less laneless window still loads its own seed turns, so a legacy type fires E3", () => {
    const sessionId = seedSession("e3-stock");
    const legacy = insertTurn(sessionId, 1, { type: ["discovery"] });
    insertTurn(sessionId, 2, { type: ["design"] });

    const projection = loadLaneCheckScope(db, {
      kind: "range",
      sessionId,
      promptStart: 1,
      promptEnd: 2,
    });
    expect(projection.turns.some((t) => t.id === legacy)).toBe(true);

    const result = checkLanes(projection.turns, projection.edges, projection.outOfVocabularyEdges);
    const e3 = result.errors.filter((error) => error.class === "E3");
    expect(e3).toHaveLength(1);
    expect(e3[0]!.anchorId).toBe(legacy);
  });
});
