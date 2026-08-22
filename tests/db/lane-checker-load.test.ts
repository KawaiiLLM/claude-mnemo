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
  options: { type?: string[]; wasRolledBack?: boolean; status?: string } = {},
): number {
  return db
    .query<{ id: number }, [number, number, string, string, number, string, number, string]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         tool_call_count, created_at_epoch, was_rolled_back, type
       ) VALUES (?, ?, ?, 'p', 'r', 1, ?, ?, ?)
       RETURNING id`,
    )
    .get(
      sessionId,
      promptNumber,
      options.status ?? "active",
      NOW + promptNumber,
      options.wasRolledBack ? 1 : 0,
      JSON.stringify(options.type ?? ["design"]),
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
