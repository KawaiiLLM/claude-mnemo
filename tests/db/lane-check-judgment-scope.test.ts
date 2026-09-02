import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { loadLaneCheckScope, JUDGMENT_LOOKBACK_PROMPTS } from "../../src/db/lane-checker-load";
import { insertLane } from "../../src/db/lanes";
import { deriveSideTags, writeMemoryEdges } from "../../src/db/memory-edges";
import { initializeSchema } from "../../src/db/schema";
import { addSegmentMembers, createSegment } from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { checkLanes } from "../../src/shared/lane-checker";
import { laneToken } from "../../src/shared/lane-interpretation";
import { wordEdgeClass } from "../support/edge-row-fixtures";

/**
 * SETTLEMENT-GATE-TAXONOMY TICKET 02 — THE THREE SCOPES, AT THE LOADER.
 *
 * Three rules live here, and each has a fixture that goes red if THAT rule
 * alone is disabled:
 *
 *   1. REPORTED IMPLIES WIDENED. Membership resolution and edge widening cover
 *      the same lane set, so a lane the seed never discovered is reported by
 *      nobody instead of materialising with full membership and a partial edge
 *      set. Disable it by restoring `laneTags: laneTagsFor(segmentId,
 *      row.tags)` in `db/lane-checker-load.ts` in place of
 *      `emittedLaneTagsFor(...)`.
 *   2. THE BOUNDARY WITNESS. Per component the judgment anchors touch, exactly
 *      ONE nearest component they do not — never N-1 of them. Disable it by
 *      keeping every component in the WIDEN block's `kept` map.
 *   3. THE LOOKBACK IS IN PROMPT NUMBERS. The window's prompts plus the 50
 *      immediately preceding prompts of the SAME session, never the lane's own
 *      preceding 50 members. Disable it by seeding the judgment set from the
 *      lane's membership instead of `loadJudgmentAnchorTurnIds`.
 *
 * Every assertion reads the projection or the REAL core's verdict over it
 * (`checkLanes`), never an evaluator internal.
 */

const NOW = 1_800_000_000;

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
  initializeSchema(db);
});

afterEach(() => {
  db.close();
});

function seedSession(label: string): number {
  return upsertSession(db, {
    contentSessionId: `${label}-session`,
    project: `/tmp/project-${label}`,
    title: label,
    content: null,
    insight: null,
    createdAtEpoch: NOW - 10_000,
    updatedAtEpoch: NOW - 10_000,
    completedAtEpoch: null,
  }).id;
}

function insertTurn(sessionId: number, promptNumber: number, tags: readonly string[]): number {
  return db
    .query<{ id: number }, [number, number, string, string, number, string]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         tool_call_count, created_at_epoch, type, tags
       ) VALUES (?, ?, 'active', ?, ?, 2, ?, '["design"]', ?)
       RETURNING id`,
    )
    .get(
      sessionId,
      promptNumber,
      `prompt ${promptNumber}`,
      `response ${promptNumber}`,
      NOW - 100_000 + promptNumber,
      JSON.stringify(tags),
    )!.id;
}

function laneEdge(citingId: number, citedId: number, relation: string, tag: string): void {
  writeMemoryEdges(
    db,
    [
      {
        citing: { kind: "turn", id: citingId },
        cited: { kind: "turn", id: citedId },
        ...wordEdgeClass(relation),
        provenance: "asserted",
        ...deriveSideTags([tag]),
      },
    ],
    NOW,
  );
}

/**
 * A SPARSE lane with FIVE components, four of them long past and one inside
 * the settlement window:
 *
 *   A = prompts 1/2      B = prompts 10/11    C = prompts 20/21
 *   D = prompts 30/31    E = prompts 1000/1001  <- the window
 *
 * Each pair is chained by one `extends` claiming the lane, and nothing crosses
 * between pairs — so `buildComponentReport` sees five islands. The whole lane
 * is EIGHT members outside the window, comfortably fewer than
 * `JUDGMENT_LOOKBACK_PROMPTS`, which is exactly what makes the two candidate
 * lookback rules give different answers: counted in MEMBERS every one of A..D
 * is inside the lookback, counted in PROMPT NUMBERS not one of them is.
 *
 * `carrier` is a second declared lane every one of those turns also claims,
 * chained end to end, so the sparse lane's far components are reachable and a
 * test that finds them missing is finding a narrowing rather than an empty
 * database.
 */
function seedSparseLaneFixture(): {
  sessionId: number;
  segmentId: number;
  componentTurnIds: number[][];
  windowTurnIds: number[];
} {
  const sessionId = seedSession("sparse-lane");
  const prompts = [
    [1, 2],
    [10, 11],
    [20, 21],
    [30, 31],
    [1000, 1001],
  ];
  const componentTurnIds = prompts.map((pair) =>
    pair.map((prompt) => insertTurn(sessionId, prompt, ["sparse-task", "sparse", "carrier"])),
  );
  const flat = componentTurnIds.flat();
  const segmentId = createSegment(db, {
    title: "sparse lane fixture",
    tags: ["sparse-task"],
    nowEpoch: NOW,
  }).id;
  addSegmentMembers(db, segmentId, flat, NOW);
  insertLane(db, segmentId, "sparse", NOW);
  insertLane(db, segmentId, "carrier", NOW);

  for (const [first, second] of componentTurnIds) {
    laneEdge(second!, first!, "indexes", "sparse");
  }
  // The carrier chain — one connected run over every turn, so nothing in this
  // fixture is unreachable for a structural reason.
  for (let index = 1; index < flat.length; index += 1) {
    laneEdge(flat[index]!, flat[index - 1]!, "extends", "carrier");
  }

  return {
    sessionId,
    segmentId,
    componentTurnIds,
    windowTurnIds: componentTurnIds[4]!,
  };
}

/** The reported connectivity for one lane, from the REAL core over this projection. */
function componentsFor(
  projection: ReturnType<typeof loadLaneCheckScope>,
  segmentId: number,
  tag: string,
) {
  const result = checkLanes(
    projection.turns,
    projection.edges,
    projection.outOfVocabularyEdges,
    projection.segmentFacts,
  );
  return result.components.find(
    (component) => component.key.segment === String(segmentId) && component.key.tag === tag,
  );
}

describe("ticket 02 — a lane whose edges were not widened is reported by nobody", () => {
  test("the segment-global pass drags a lane's members in, and the lane is still absent from every report", () => {
    const sessionId = seedSession("undiscovered-lane");
    // `ghost` is claimed by `indexes` rows only — a word no supplementary pass
    // and no segment-global relation carries, so the lane's own edges reach a
    // projection ONLY through `loadEdgesForTag`, i.e. only when the seed
    // discovered it. `carrier` chains the same turns with `extends`, which IS
    // a segment-global word, so the six turns land in the projection either
    // way. That asymmetry is the whole defect.
    const ghostTurns = [1, 2, 3, 4, 5, 6].map((prompt) =>
      insertTurn(sessionId, prompt, ["ghost-task", "ghost", "carrier"]),
    );
    const windowTurns = [7, 8].map((prompt) => insertTurn(sessionId, prompt, ["ghost-task", "window"]));
    const segmentId = createSegment(db, {
      title: "undiscovered lane fixture",
      tags: ["ghost-task"],
      nowEpoch: NOW,
    }).id;
    addSegmentMembers(db, segmentId, [...ghostTurns, ...windowTurns], NOW);
    for (const tag of ["ghost", "carrier", "window"]) {
      insertLane(db, segmentId, tag, NOW);
    }
    for (let index = 1; index < ghostTurns.length; index += 1) {
      laneEdge(ghostTurns[index]!, ghostTurns[index - 1]!, "extends", "carrier");
    }
    // Two `indexes` rows only: truthfully {g1,g2,g3} + {g4,g5,g6} would need a
    // third, so the whole-lane reading is three islands and the phantom
    // reading is six.
    laneEdge(ghostTurns[1]!, ghostTurns[0]!, "indexes", "ghost");
    laneEdge(ghostTurns[4]!, ghostTurns[3]!, "indexes", "ghost");
    laneEdge(windowTurns[1]!, windowTurns[0]!, "extends", "window");

    const projection = loadLaneCheckScope(db, { kind: "turns", turnIds: windowTurns });

    // THE LOAD still reaches them — this is not a test about an empty
    // projection. Every ghost turn is present as a row.
    for (const id of ghostTurns) {
      expect(projection.turns.some((turn) => turn.id === id)).toBe(true);
    }
    // …and not one of them CLAIMS the undiscovered lane.
    expect(projection.involvedLaneKeys.map((key) => key.tag).sort()).toEqual(["window"]);
    for (const turn of projection.turns) {
      expect(turn.laneTags).not.toContain("ghost");
      expect(turn.laneTags).not.toContain("carrier");
    }

    // THE INVARIANT, stated over the REAL core's output: every lane it reports
    // is a lane this projection widened. Restore the unrestricted `laneTags`
    // resolution in the loader and `ghost` appears here with six one-member
    // islands.
    const result = checkLanes(
      projection.turns,
      projection.edges,
      projection.outOfVocabularyEdges,
      projection.segmentFacts,
    );
    const widened = new Set(projection.involvedLaneKeys.map((key) => laneToken(key.segment, key.tag)));
    for (const lane of result.lanes) {
      expect(widened.has(laneToken(lane.key.segment, lane.key.tag))).toBe(true);
    }
    expect(result.components.map((component) => component.key.tag)).not.toContain("ghost");
  });
});

describe("ticket 02 — the boundary witness is ONE component, not N-1", () => {
  test("a five-component lane touched in one place emits that component and exactly one neighbour", () => {
    const fixture = seedSparseLaneFixture();

    const projection = loadLaneCheckScope(db, {
      kind: "turns",
      turnIds: fixture.windowTurnIds,
      judgment: { sessionId: fixture.sessionId, windowStart: 1000, windowEnd: 1001 },
    });

    // The whole-lane truth, for contrast: five islands.
    const whole = componentsFor(
      loadLaneCheckScope(db, {
        kind: "lanes",
        laneKeys: [{ segment: String(fixture.segmentId), tag: "sparse" }],
      }),
      fixture.segmentId,
      "sparse",
    );
    expect(whole?.componentCount).toBe(5);

    // What the window is shown: its own component, plus ONE. Not five, and
    // not the four the pre-ticket loader would have handed the gate as four
    // fractures to dispose of.
    const scoped = componentsFor(projection, fixture.segmentId, "sparse");
    expect(scoped?.componentCount).toBe(2);

    // …and the one is the NEAREST, component D (prompts 30/31), not A/B/C.
    const emitted = new Set(scoped!.islands.flatMap((island) => island.memberIds));
    expect([...emitted].sort((a, b) => a - b)).toEqual(
      [...fixture.componentTurnIds[3]!, ...fixture.componentTurnIds[4]!].sort((a, b) => a - b),
    );
    for (const id of [
      ...fixture.componentTurnIds[0]!,
      ...fixture.componentTurnIds[1]!,
      ...fixture.componentTurnIds[2]!,
    ]) {
      expect(emitted.has(id)).toBe(false);
    }
  });

  test("the three roles partition the projection, and the witness is not an anchor", () => {
    const fixture = seedSparseLaneFixture();
    const projection = loadLaneCheckScope(db, {
      kind: "turns",
      turnIds: fixture.windowTurnIds,
      judgment: { sessionId: fixture.sessionId, windowStart: 1000, windowEnd: 1001 },
    });
    const { judgment, evidence, boundary } = projection.roles;

    // Disjoint and exhaustive over the projection's own turns.
    const total = judgment.size + evidence.size + boundary.size;
    expect(total).toBe(projection.turns.length);
    for (const turn of projection.turns) {
      const memberships = [judgment, evidence, boundary].filter((set) => set.has(turn.id)).length;
      expect(memberships).toBe(1);
    }

    // The window's own turns are the anchors; the witness component is a
    // BOUNDARY, and a finding on it may not be reported.
    for (const id of fixture.windowTurnIds) {
      expect(judgment.has(id)).toBe(true);
    }
    for (const id of fixture.componentTurnIds[3]!) {
      expect(boundary.has(id)).toBe(true);
      expect(judgment.has(id)).toBe(false);
    }
  });
});

describe("ticket 02 — the lookback is 50 PROMPT NUMBERS, not the lane's own preceding 50 members", () => {
  test("a sparse lane's eight earlier members are outside the lookback even though there are far fewer than fifty of them", () => {
    const fixture = seedSparseLaneFixture();
    const earlier = [
      ...fixture.componentTurnIds[0]!,
      ...fixture.componentTurnIds[1]!,
      ...fixture.componentTurnIds[2]!,
      ...fixture.componentTurnIds[3]!,
    ];
    // The discriminator, spelled out: counted in MEMBERS every one of these is
    // inside a 50-deep lookback. Counted in PROMPT NUMBERS none is, because
    // the nearest of them sits 969 prompts before the window starts.
    expect(earlier.length).toBeLessThan(JUDGMENT_LOOKBACK_PROMPTS);
    expect(1000 - 31).toBeGreaterThan(JUDGMENT_LOOKBACK_PROMPTS);

    const projection = loadLaneCheckScope(db, {
      kind: "turns",
      turnIds: fixture.windowTurnIds,
      judgment: { sessionId: fixture.sessionId, windowStart: 1000, windowEnd: 1001 },
    });

    // NOT ONE of them is a judgment anchor. Component D's two turns are LOADED
    // (they are the boundary witness — the assertion above pins that), so this
    // is a statement about the lookback RULE and not about what the projection
    // managed to reach: a member-counted lookback would have made those same
    // two rows anchors.
    for (const id of earlier) {
      expect(projection.roles.judgment.has(id)).toBe(false);
    }
    expect(projection.roles.boundary.has(fixture.componentTurnIds[3]![0]!)).toBe(true);
  });

  test("a turn 50 prompts before the window IS an anchor, and one 51 prompts before is not", () => {
    const sessionId = seedSession("lookback-boundary");
    const inside = insertTurn(sessionId, 950, ["edge-task", "edge"]);
    const outside = insertTurn(sessionId, 949, ["edge-task", "edge"]);
    const windowTurn = insertTurn(sessionId, 1000, ["edge-task", "edge"]);
    const segmentId = createSegment(db, {
      title: "lookback boundary fixture",
      tags: ["edge-task"],
      nowEpoch: NOW,
    }).id;
    addSegmentMembers(db, segmentId, [outside, inside, windowTurn], NOW);
    insertLane(db, segmentId, "edge", NOW);
    laneEdge(inside, outside, "extends", "edge");
    laneEdge(windowTurn, inside, "extends", "edge");

    const projection = loadLaneCheckScope(db, {
      kind: "turns",
      turnIds: [outside, inside, windowTurn],
      judgment: { sessionId, windowStart: 1000, windowEnd: 1000 },
    });

    expect(projection.roles.judgment.has(windowTurn)).toBe(true);
    // 1000 - 50 = 950: the last prompt number the lookback reaches.
    expect(projection.roles.judgment.has(inside)).toBe(true);
    // 949 is one past it — EVIDENCE, loaded and readable, never an anchor.
    expect(projection.roles.judgment.has(outside)).toBe(false);
    expect(projection.turns.some((turn) => turn.id === outside)).toBe(true);
  });
});
