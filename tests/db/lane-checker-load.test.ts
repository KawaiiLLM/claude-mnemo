import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { loadLaneCheckScope as realLoadLaneCheckScope } from "../../src/db/lane-checker-load";
import { deleteLane, insertLane } from "../../src/db/lanes";
import { deriveSideTags, writeMemoryEdges } from "../../src/db/memory-edges";
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
 * emit a dangling edge (`loadEdgesForTag`/`loadEdgesByRelationTouching`
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
  pendingLaneClaims.length = 0;
  fixtureSegmentId = null;
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

/**
 * MEMBERSHIP CLAIMS, RECORDED NOW AND APPLIED AT LOAD TIME (lane-model-v12
 * ticket 10). A turn belongs to the lanes ITS OWN tags name, and only if that
 * lane is DECLARED in the turn's owning segment — so a fixture that writes a
 * tagged edge and nothing else describes a lane with no members at all.
 *
 * These helpers therefore also record "this endpoint claims this tag", and
 * `loadLaneCheckScope` below stamps every recorded claim onto the turn's own
 * `tags` column and declares the lane, JUST BEFORE the projection loads. The
 * deferral is what makes it safe: a test typically writes its edges first and
 * calls `addSegmentMembers` afterwards, and a lane can only be declared once
 * its member's owning segment is known.
 *
 * An endpoint that still owns no segment by then joins ONE shared fixture
 * segment, created at that moment so its id is the HIGHEST — `MIN(segment_id)`
 * (the owning-segment tie-break everywhere in this codebase) therefore still
 * picks whatever segment the test assigned itself. A test that means to
 * exercise a genuinely homeless endpoint passes `{ homeless: true }` and gets
 * neither the claim nor the segment.
 */
const pendingLaneClaims: Array<{ turnId: number; tag: string }> = [];
let fixtureSegmentId: number | null = null;

function recordLaneClaims(turnIds: readonly number[], tags: readonly string[]): void {
  for (const turnId of turnIds) {
    for (const tag of tags) {
      if (tag !== "") pendingLaneClaims.push({ turnId, tag });
    }
  }
}

function owningSegmentOf(turnId: number): number | null {
  return (
    db
      .query<{ id: number | null }, [number]>(
        "SELECT MIN(segment_id) AS id FROM segment_members WHERE turn_id = ?",
      )
      .get(turnId)?.id ?? null
  );
}

function applyPendingLaneClaims(): void {
  for (const { turnId, tag } of pendingLaneClaims.splice(0)) {
    const row = db
      .query<{ tags: string | null }, [number]>("SELECT tags FROM turns WHERE id = ?")
      .get(turnId);
    if (row === null) continue;
    let stored: string[] = [];
    try {
      const parsed = JSON.parse(row.tags ?? "[]") as unknown;
      if (Array.isArray(parsed)) stored = parsed.filter((t): t is string => typeof t === "string");
    } catch {
      stored = [];
    }
    if (!stored.includes(tag)) {
      db.query<unknown, [string, number]>("UPDATE turns SET tags = ? WHERE id = ?").run(
        JSON.stringify([...stored, tag]),
        turnId,
      );
    }
    let segmentId = owningSegmentOf(turnId);
    if (segmentId === null) {
      if (fixtureSegmentId === null) {
        fixtureSegmentId = createSegment(db, { title: "fixture home", nowEpoch: NOW }).id;
      }
      addSegmentMembers(db, fixtureSegmentId, [turnId], NOW);
      segmentId = owningSegmentOf(turnId);
    }
    if (segmentId !== null) insertLane(db, segmentId, tag, NOW);
  }
}

/** `loadLaneCheckScope`, with every recorded membership claim settled first (see `recordLaneClaims`). */
function loadLaneCheckScope(
  database: typeof db,
  scope: Parameters<typeof realLoadLaneCheckScope>[1],
): ReturnType<typeof realLoadLaneCheckScope> {
  applyPendingLaneClaims();
  return realLoadLaneCheckScope(database, scope);
}

function tagEdge(
  citingId: number,
  citedId: number,
  relation: string,
  tags: readonly string[],
  options: { homeless?: boolean } = {},
): void {
  writeMemoryEdges(
    db,
    [
      {
        citing: { kind: "turn", id: citingId },
        cited: { kind: "turn", id: citedId },
        relation: relation as never,
        provenance: "asserted",
        ...deriveSideTags(tags),
      },
    ],
    NOW,
  );
  if (options.homeless !== true) {
    recordLaneClaims([citingId, citedId], deriveSideTags(tags).tailTag === "" ? [] : tags);
  }
}

/**
 * A row carrying a relation word the CURRENT vocabulary does not have — the
 * only shape E2 (out-of-vocabulary) has ever been about.
 *
 * Since lane-model-v12 ticket 03 no such row can be WRITTEN: `memory_edges`'
 * CHECK is now exactly the seven-word write vocabulary, and both frozen-legacy
 * words were migrated onto `override` and removed from it. So the fixture has
 * to say what it actually means — "a row a build older than that migration
 * left behind" — and `ignore_check_constraints` is the narrowest way to write
 * one. Going through `writeMemoryEdges` would not do: its own
 * `isCitationRelation` gate refuses the word before the table is reached.
 */
function legacyOutOfVocabularyEdge(citingId: number, citedId: number, relation: string): void {
  db.exec("PRAGMA ignore_check_constraints = ON");
  try {
    db.query<unknown, [number, number, string]>(
      `INSERT INTO memory_edges
         (citing_kind, citing_id, cited_kind, cited_id, relation, provenance, created_at_epoch)
       VALUES ('turn', ?, 'turn', ?, ?, 'asserted', ${NOW})`,
    ).run(citingId, citedId, relation);
  } finally {
    db.exec("PRAGMA ignore_check_constraints = OFF");
  }
}

/**
 * A CROSS-LANE edge — `tail_tag !== head_tag`, both settled (the merged set
 * ticket 09 retired had no form for two different ends; spec problem 2).
 *
 * A direct INSERT rather than `writeMemoryEdges` because this fixture predates
 * the two-sided write surface and keeps working the same way for the tests
 * below; the side-index rows are written here too, because that index is what
 * the WIDEN pass selects on.
 */
function crossLaneEdge(
  citingId: number,
  citedId: number,
  relation: string,
  tailTag: string,
  headTag: string,
): void {
  const row = db
    .query<{ id: number }, [number, number, string, string, string]>(
      `INSERT INTO memory_edges
         (citing_kind, citing_id, cited_kind, cited_id, relation, provenance, tail_tag, head_tag, created_at_epoch)
       VALUES ('turn', ?, 'turn', ?, ?, 'asserted', ?, ?, ${NOW})
       RETURNING id`,
    )
    .get(citingId, citedId, relation, tailTag, headTag)!;
  const insertSide = db.query<unknown, [number, string, string]>(
    `INSERT INTO memory_edge_side_tags (edge_row_id, side, tag) VALUES (?, ?, ?)`,
  );
  insertSide.run(row.id, "tail", tailTag);
  insertSide.run(row.id, "head", headTag);
  // PER SIDE: the citing turn claims the TAIL's lane, the cited turn the
  // HEAD's — never both to both (v12 D2 rule 3).
  recordLaneClaims([citingId], [tailTag]);
  recordLaneClaims([citedId], [headTag]);
}

/** One segment owning the given turns — v12 membership needs an owner (D3e: an unowned turn joins no lane), so a fixture whose lane facts are read through the CHECKER has to place its turns somewhere. */
function seedHomeSegment(turnIds: readonly number[], title = "home"): number {
  const segment = createSegment(db, { title, nowEpoch: NOW });
  addSegmentMembers(db, segment.id, [...turnIds], NOW);
  return segment.id;
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

/**
 * MEMBERSHIP IS A NODE FACT, RESOLVED HERE (lane-model-v12 ticket 10). Three
 * properties of the resolution, each written so that removing the pass it
 * names gives a different answer:
 *
 *   - the projection WIDENS to a lane's tagged-but-EDGELESS members (phase 4);
 *   - a seed turn's own tags DISCOVER its lane even with no edge (phase 2b);
 *   - `laneTags` is the stored column INTERSECTED with the segment's DECLARED
 *     lanes, so an undeclared legacy word joins nothing.
 */
describe("membership from the node's own tags (ticket 10)", () => {
  test("the ticket's counter-example, end to end: a tagged, EDGELESS member outside the range keeps the lane OPEN", () => {
    const sessionId = seedSession("edgeless-member");
    const t1 = insertTurn(sessionId, 1, { tags: ["ownership"] });
    const t2 = insertTurn(sessionId, 2, { tags: ["ownership"] });
    // Carries the lane's tag, has no edge at all, and sits OUTSIDE the
    // requested range — reachable only through the member widen.
    const t3 = insertTurn(sessionId, 9, { tags: ["ownership"] });
    const segmentId = seedHomeSegment([t1, t2, t3], "edgeless-member");
    insertLane(db, segmentId, "ownership", NOW);
    tagEdge(t2, t1, "indexes", ["ownership"]);

    const projection = loadLaneCheckScope(db, {
      kind: "range",
      sessionId,
      promptStart: 1,
      promptEnd: 2,
    });
    expect(projection.turns.map((turn) => turn.id)).toContain(t3);

    const lane = checkLanes(projection.turns, projection.edges).lanes[0]!;
    expect(lane.members.map((member) => member.id)).toEqual([t1, t2, t3]);
    // T2 is still the terminus; T3 is the newest MEMBER, so the lane is open.
    expect(lane.declaration.terminus).toBe(t2);
    expect(lane.state.closure).toBe("open");
    assertNoDanglingEdges(projection);
  });

  test("the control: with the edgeless member gone, the identical lane reads CLOSED", () => {
    const sessionId = seedSession("edgeless-member-control");
    const t1 = insertTurn(sessionId, 1, { tags: ["ownership"] });
    const t2 = insertTurn(sessionId, 2, { tags: ["ownership"] });
    const segmentId = seedHomeSegment([t1, t2], "edgeless-member-control");
    insertLane(db, segmentId, "ownership", NOW);
    tagEdge(t2, t1, "indexes", ["ownership"]);

    const projection = loadLaneCheckScope(db, {
      kind: "range",
      sessionId,
      promptStart: 1,
      promptEnd: 2,
    });
    expect(checkLanes(projection.turns, projection.edges).lanes[0]!.state.closure).toBe("closed");
  });

  test("a seed that carries a lane tag and has NO edge discovers its own lane, and widens to the lane's other members", () => {
    const sessionId = seedSession("seed-claims-lane");
    const edgeless = insertTurn(sessionId, 5, { tags: ["ownership"] });
    const elsewhere = insertTurn(sessionId, 20, { tags: ["ownership"] });
    const segmentId = seedHomeSegment([edgeless, elsewhere], "seed-claims-lane");
    insertLane(db, segmentId, "ownership", NOW);

    const projection = loadLaneCheckScope(db, { kind: "turns", turnIds: [edgeless] });
    expect(projection.involvedLaneKeys).toEqual([
      { segment: String(segmentId), tag: "ownership" },
    ]);
    expect(projection.turns.map((turn) => turn.id).sort((a, b) => a - b)).toEqual(
      [edgeless, elsewhere].sort((a, b) => a - b),
    );
    const lane = checkLanes(projection.turns, projection.edges).lanes[0]!;
    expect(lane.members.map((member) => member.id).sort((a, b) => a - b)).toEqual(
      [edgeless, elsewhere].sort((a, b) => a - b),
    );
  });

  test("an UNDECLARED word in a turn's tags joins no lane — the registry is the vocabulary, and the segment's own tag is not a lane either", () => {
    const sessionId = seedSession("undeclared-word");
    const t1 = insertTurn(sessionId, 1, { tags: ["ownership", "legacy-topic", "claude-mnemo"] });
    const t2 = insertTurn(sessionId, 2, { tags: ["ownership", "legacy-topic"] });
    const segmentId = seedHomeSegment([t1, t2], "undeclared-word");
    insertLane(db, segmentId, "ownership", NOW); // …and NOT `legacy-topic`

    const projection = loadLaneCheckScope(db, {
      kind: "range",
      sessionId,
      promptStart: 1,
      promptEnd: 2,
    });
    // The raw column rides through untouched (E4 judges the stored value);
    // membership sees only the declared word.
    expect(projection.turns.map((turn) => turn.laneTags)).toEqual([["ownership"], ["ownership"]]);
    expect(projection.turns[0]!.tags).toEqual(["claude-mnemo", "legacy-topic", "ownership"]);
    const result = checkLanes(projection.turns, projection.edges);
    expect(result.lanes.map((lane) => lane.key.tag)).toEqual(["ownership"]);
  });

  test("a HOMELESS turn joins no lane however it is tagged (D3e: an unowned turn cannot join one)", () => {
    const sessionId = seedSession("homeless-claim");
    const homeless = insertTurn(sessionId, 1, { tags: ["ownership"] });
    const owned = insertTurn(sessionId, 2, { tags: ["ownership"] });
    const segmentId = seedHomeSegment([owned], "homeless-claim");
    insertLane(db, segmentId, "ownership", NOW);

    const projection = loadLaneCheckScope(db, {
      kind: "range",
      sessionId,
      promptStart: 1,
      promptEnd: 2,
    });
    const byId = new Map(projection.turns.map((turn) => [turn.id, turn]));
    expect(byId.get(homeless)!.laneTags).toEqual([]);
    expect(byId.get(owned)!.laneTags).toEqual(["ownership"]);
    expect(checkLanes(projection.turns, projection.edges).lanes[0]!.members).toEqual([
      { id: owned },
    ]);
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
      { segment: String(segment.id), tag: "decision" },
    ]);
    assertNoDanglingEdges(projection);

    const result = checkLanes(projection.turns, projection.edges);
    expect(result.lanes).toHaveLength(1);
    expect(result.lanes[0]!.declaration).toEqual({
      state: "declared",
      terminus: t3,
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
      laneKeys: [{ segment: String(segmentA.id), tag: "shared-tag" }],
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
    // `homeless: true` keeps the endpoints out of any segment, which is what
    // makes this the DEFAULT_SEGMENT case at all. Since ticket 10 such a lane
    // can have no MEMBERS (D3e), so what is asserted here is the loader's own
    // reach — which rows the sentinel resolves — not a checker verdict.
    tagEdge(t2, t1, "extends", ["homeless-lane"], { homeless: true });

    const projection = loadLaneCheckScope(db, {
      kind: "lanes",
      laneKeys: [{ segment: DEFAULT_SEGMENT, tag: "homeless-lane" }],
    });

    expect(projection.edges).toHaveLength(1);
    expect(projection.turns.map((turn) => turn.id).sort((a, b) => a - b)).toEqual(
      [t1, t2].sort((a, b) => a - b),
    );
  });

  test("an unmatched lane (no edge carries that exact tag set) resolves empty, not an error", () => {
    const projection = loadLaneCheckScope(db, {
      kind: "lanes",
      laneKeys: [{ segment: DEFAULT_SEGMENT, tag: "nothing-tagged-this" }],
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
      laneKeys: [{ segment: String(segmentA.id), tag: "cross-seg" }],
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
    // [{segment: B, tag: "x"}], mislabelling A's own scan.
    expect(projection.involvedLaneKeys).toEqual(
      expect.arrayContaining([{ segment: String(segmentA.id), tag: "x" }]),
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

  // lane-model-v12 ticket 04 deleted the per-member `dead` flag this test was
  // originally contrasting law 8 against. The contrast still holds and is
  // still worth pinning: an overridden turn is a full, present member of the
  // projection, because law 8 is about `was_rolled_back`/`status` and nothing
  // an edge says has ever hidden a turn from the loader.
  test("an in-lane overridden member is NOT law-8 excluded -- law 8 is about was_rolled_back/status, never anything an edge says", () => {
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
    // t2 is a full member, carrying no status of its own -- law 8 never hid
    // it, and v12 has no per-member flag left to mark it with.
    expect(lane.members.find((member) => member.id === t2)).toEqual({ id: t2 });
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
    // The citer is outside the LANE, inside the SEGMENT — the shape report 1
    // means by "from non-members" now that every lane's members share one
    // segment (ticket 10).
    seedHomeSegment([t1, t2, outside], "consume-citedness");
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

  // Formerly "an untagged GLOBAL-KILL override touching a member is loaded".
  // Global repudiation is deleted (lane-model-v12 ticket 04) — an untagged
  // override is an ordinary unsettled edge now — but the LOADER'S widening is
  // unchanged and still the point: an override written from OUTSIDE the range
  // is pulled in, and its cited member stays whole.
  test("an untagged override reaching in from outside the range is loaded", () => {
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
    expect(result.lanes[0]!.members.find((member) => member.id === t1)).toEqual({ id: t1 });
    // The widening itself, which is what this test guards: the out-of-range
    // override's own citing turn came along, so no edge dangles.
    expect(projection.turns.map((turn) => turn.id)).toContain(killer);
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
      { kind: "lanes", laneKeys: [{ segment: DEFAULT_SEGMENT, tag: "ownership" }] } as const,
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
      laneKeys: [{ segment: String(segment.id), tag: "lane" }],
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

/**
 * THE HOMELESS-LANE FIXPOINT CLOSURE IS DELETED (v12 ticket 11).
 *
 * `widenComponentClosure` walked `SEGMENT_GRAPH_RELATIONS_SQL` outward from a
 * DEFAULT_SEGMENT lane's own edge endpoints, one BFS round (and one query) at a
 * time, because a homeless lane had no `segment_members` rows to widen from.
 * Ticket 10 made membership a NODE fact resolved against the OWNING segment's
 * registry, and a homeless turn has no owning segment — so it claims no lane
 * and the pure core never enumerates a DEFAULT_SEGMENT lane at all. The closure
 * was loading edges for a lane no report can reach.
 *
 * Ticket 10 already retargeted the two tests that lived here to
 * projection-level assertions; this pair replaces them with the deletion's own
 * observable consequences, so a reintroduction fails rather than passing
 * silently.
 */
describe("a homeless (default-segment) lane is unreachable, and nothing widens for one", () => {
  test("a lanes-scoped load for a homeless tag produces no lane, no member and no component", () => {
    const sessionId = seedSession();
    const h1 = insertTurn(sessionId, 1);
    const h2 = insertTurn(sessionId, 2);
    const h3 = insertTurn(sessionId, 3);
    const h4 = insertTurn(sessionId, 4);
    // No segment created at all — every one of these turns is homeless.
    tagEdge(h4, h1, "indexes", ["bridge"], { homeless: true });
    tagEdge(h2, h1, "consume", []);
    tagEdge(h3, h2, "consume", []);
    tagEdge(h4, h3, "consume", []);

    const projection = loadLaneCheckScope(db, {
      kind: "lanes",
      laneKeys: [{ segment: DEFAULT_SEGMENT, tag: "bridge" }],
    });
    // The tagged edge's own endpoints still load (the WIDEN pass reaches
    // them), so the projection is not empty — but no turn claims the lane.
    for (const turn of projection.turns) {
      expect(turn.laneTags ?? []).toEqual([]);
    }
    const result = checkLanes(projection.turns, projection.edges);
    expect(result.lanes).toEqual([]);
    expect(result.components).toEqual([]);
    assertNoDanglingEdges(projection);
  });

  test("the deleted closure no longer drags a two-hop bridge chain in", () => {
    // The chain the closure existed to reach: neither h2 nor h3 is an endpoint
    // of the tagged edge, so only a fixpoint walk could discover the h3->h2
    // link. It is not discovered, and nothing about a homeless lane needs it.
    const sessionId = seedSession();
    const h1 = insertTurn(sessionId, 1);
    const h2 = insertTurn(sessionId, 2);
    const h3 = insertTurn(sessionId, 3);
    const h4 = insertTurn(sessionId, 4);
    tagEdge(h4, h1, "indexes", ["bridge2"], { homeless: true });
    tagEdge(h2, h1, "consume", []);
    tagEdge(h3, h2, "consume", []);
    tagEdge(h4, h3, "consume", []);

    const projection = loadLaneCheckScope(db, {
      kind: "lanes",
      laneKeys: [{ segment: DEFAULT_SEGMENT, tag: "bridge2" }],
    });
    expect(
      projection.edges.some((edge) => edge.citingId === h3 && edge.citedId === h2),
    ).toBe(false);
    assertNoDanglingEdges(projection);
  });
});

describe("out-of-vocabulary edges (semantic-conformance ticket 02): the loader surfaces a frozen-legacy relation as a fact, never widening the graph", () => {
  test("a supersedes edge between two turns already in scope reaches the checker's vocabulary-conformance report, never the lane's own edge tally", () => {
    const sessionId = seedSession();
    const t1 = insertTurn(sessionId, 1);
    const t2 = insertTurn(sessionId, 2);
    tagEdge(t2, t1, "extends", ["ownership"]);
    tagEdge(t2, t1, "indexes", ["ownership"]);
    legacyOutOfVocabularyEdge(t2, t1, "supersedes"); // pre-migration stock, never in EDGE_RELATIONS

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
    expect(projection.outOfVocabularyEdges).toEqual([
      { citingId: t2, citedId: t1, relation: "supersedes", tailTag: "", headTag: "" },
    ]);
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
    // Settle the fixture's own membership claims BEFORE the edit, so the edit
    // is the last word on this turn's tags (see `recordLaneClaims`).
    applyPendingLaneClaims();
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

  // lane-declaration ticket 02: this used to assert the untagged `extends`
  // fires E1. The mandate is withdrawn, so it asserts the same projection
  // reports NOTHING — and it still pins the LOADER's own job, which outlived
  // E1: the untagged stance row must reach the projection at all (it is a
  // component bridge, and ticket 09's unattributed-cluster warning is defined
  // over exactly these rows), so the assertion below is on the EDGE SET as
  // well as on the empty error list.
  test("an untagged extends still LOADS and is E6, never a word-specific class — the mandate's stock half is retired", () => {
    const sessionId = seedSession();
    const t1 = insertTurn(sessionId, 1, { tags: ["ownership"] });
    const t2 = insertTurn(sessionId, 2, { tags: ["ownership"] });
    const t3 = insertTurn(sessionId, 3, { tags: ["ownership"] });
    tagEdge(t2, t1, "extends", ["ownership"]);
    tagEdge(t2, t1, "indexes", ["ownership"]);
    tagEdge(t3, t2, "extends", []);

    const projection = loadLaneCheckScope(db, { kind: "range", sessionId, promptStart: 1, promptEnd: 3 });
    // Not vacuous: the untagged row IS in the projection, so an error class
    // over it would have had the row to fire on.
    expect(
      projection.edges.some(
        (edge) => edge.citingId === t3 && edge.citedId === t2 && edge.relation === "extends",
      ),
    ).toBe(true);
    const errors = checkLanes(projection.turns, projection.edges, projection.outOfVocabularyEdges).errors;
    // E1 fired on the WORD; ticket 20's E6 fires on the SHAPE (an empty side),
    // so the untagged row is an error again — but as a DRAFT anchored at its
    // citing turn, identically for all seven words, and the two TAGGED rows
    // beside it stay clean.
    expect(errors.map((e) => `${e.class}:${e.anchorId}`)).toEqual([`E6:${t3}`]);
  });
});

// ------------------------- WIDEN matches ONE tag on ONE SIDE (v12 D1, ticket 06)

/**
 * WHAT THIS BLOCK GUARDS, and how it changed twice.
 *
 * v10 matched an exact tag SET through a delimiter-joined comparison, which
 * collided a three-tag set with a differently-split two-tag one (peer round
 * T1466, P2-9). v11 (D5) replaced it with `memory_edge_tags WHERE tag = ?` —
 * one tag, no join, nothing left to collide through. lane-model-v12 D1 moves
 * it once more, onto `memory_edge_side_tags`: a tag is now carried BY A SIDE.
 *
 * The load-bearing property is unchanged in spirit — naming ONE tag loads
 * every row carrying it and never a row that merely shares a DIFFERENT tag —
 * but the FIXTURES here moved to the post-M-A shape, because `deriveSideTags`
 * maps a MULTI-TAG write to two unsettled sides (the two-sided model has no
 * single-valued form for one), which makes such a row lane-INVISIBLE the
 * moment the pass selects by side. Spec M-A splits every multi-tag row into
 * one row per tag, and that is what these fixtures now write: two single-tag
 * rows on the same pair AND relation, distinct rows under the identity key
 * `(citing, cited, relation, tail_tag, head_tag)`. Every PER-LANE number
 * below is identical to the multi-tag version's; only the raw ROW count
 * differs, which is the fixture's shape, not a regression.
 */
describe("WIDEN loads exactly the rows carrying a lane's ONE tag on a SIDE (v12 D1)", () => {
  test("naming lane {a} loads the {a} row of a pair that also carries a {b} row, never an edge tagged only {x}", () => {
    const sessionId = seedSession("tag-widen-precision");
    const a1 = insertTurn(sessionId, 1, { tags: ["a", "b"] });
    const a2 = insertTurn(sessionId, 2, { tags: ["a", "b"] });
    const x1 = insertTurn(sessionId, 3, { tags: ["x"] });
    const x2 = insertTurn(sessionId, 4, { tags: ["x"] });
    const segmentId = seedHomeSegment([a1, a2], "tag-widen-precision");
    // The unrelated {x} lane lives in its OWN segment: identity is
    // `(segment, tag)`, and keeping it elsewhere is what makes "never leaks
    // into lane {a}" a statement about the tag rather than about proximity.
    seedHomeSegment([x1, x2], "tag-widen-unrelated");
    // Post-M-A: one row per lane, same pair and relation.
    tagEdge(a2, a1, "extends", ["a"]);
    tagEdge(a2, a1, "extends", ["b"]);
    tagEdge(x2, x1, "extends", ["x"]); // an unrelated lane entirely — shares nothing with {a}

    const laneA = loadLaneCheckScope(db, {
      kind: "lanes",
      laneKeys: [{ segment: String(segmentId), tag: "a" }],
    });
    // WIDEN's own answer is the {a} row, with both sides settled to `a`.
    expect(laneA.edges).toContainEqual({
      citingId: a2,
      citedId: a1,
      relation: "extends",
      tailTag: "a",
      headTag: "a",
    });
    // The unrelated {x} lane never leaks in — the precision property this
    // block exists for. (The sibling {b} row on the SAME pair DOES appear,
    // but not through WIDEN: it is a stance edge between two turns already
    // loaded, so the segment-global component pass picks it up like any
    // other neighbourhood edge. Membership still separates the two lanes —
    // asserted end to end below.)
    expect(laneA.edges.some((e) => e.citingId === x2 || e.citedId === x1)).toBe(false);
    expect(laneA.turns.map((turn) => turn.id).sort((x, y) => x - y)).toEqual([a1, a2]);

    // End to end: a scope holding every edge reports lane {a}, lane {b} and
    // the unrelated {x} — three, with the same memberships the single
    // multi-tag row produced, and never {a}/{x} cross-contaminating.
    const both = loadLaneCheckScope(db, { kind: "turns", turnIds: [a1, a2, x1, x2] });
    const result = checkLanes(both.turns, both.edges, both.outOfVocabularyEdges);
    expect(result.lanes.map((lane) => lane.key.tag).sort()).toEqual(["a", "b", "x"]);
    expect(
      result.lanes.find((lane) => lane.key.tag === "a")!.members.map((m) => m.id).sort((x, y) => x - y),
    ).toEqual([a1, a2]);
    expect(
      result.lanes.find((lane) => lane.key.tag === "b")!.members.map((m) => m.id).sort((x, y) => x - y),
    ).toEqual([a1, a2]);
    expect(result.errors).toEqual([]);
  });

  // DISCOVER's own fan-out: a seed range touching only the two rows on one
  // pair must discover BOTH lanes they name, then WIDEN each out to its full
  // edge set — including the parts of each lane sitting far OUTSIDE the
  // requested range. Neither lane's own additional edge shares a tag with the
  // other.
  test("a range scope seeded on a pair carrying two lanes' rows discovers AND widens BOTH lanes", () => {
    const sessionId = seedSession("multi-tag-discover");
    const t1 = insertTurn(sessionId, 1, { tags: ["a", "b"] });
    const t2 = insertTurn(sessionId, 2, { tags: ["a", "b"] });
    // Far outside the requested [1,2] range — each lane's OWN other member.
    const t10 = insertTurn(sessionId, 10, { tags: ["a"] });
    const t11 = insertTurn(sessionId, 11, { tags: ["a"] });
    const t20 = insertTurn(sessionId, 20, { tags: ["b"] });
    const t21 = insertTurn(sessionId, 21, { tags: ["b"] });
    tagEdge(t2, t1, "extends", ["a"]); // the seed pair's lane-{a} row
    tagEdge(t2, t1, "extends", ["b"]); // …and its lane-{b} row (post-M-A shape)
    tagEdge(t11, t10, "extends", ["a"]); // lane {a}'s other edge, far outside the range
    tagEdge(t21, t20, "extends", ["b"]); // lane {b}'s other edge, far outside the range

    const projection = loadLaneCheckScope(db, {
      kind: "range",
      sessionId,
      promptStart: 1,
      promptEnd: 2,
    });

    expect(projection.involvedLaneKeys.map((k) => k.tag).sort()).toEqual(["a", "b"]);
    // FOUR rows, not the three the single multi-tag row produced — the only
    // number this fixture's migration moves, and it is a ROW count, never a
    // per-lane one (both lanes' members below are unchanged).
    expect(projection.edges).toHaveLength(4);
    const turnIds = new Set(projection.turns.map((turn) => turn.id));
    for (const id of [t1, t2, t10, t11, t20, t21]) {
      expect(turnIds.has(id)).toBe(true);
    }
    assertNoDanglingEdges(projection);

    const result = checkLanes(projection.turns, projection.edges);
    expect(result.lanes.map((lane) => lane.key.tag).sort()).toEqual(["a", "b"]);
    const laneA = result.lanes.find((lane) => lane.key.tag === "a")!;
    const laneB = result.lanes.find((lane) => lane.key.tag === "b")!;
    expect(laneA.members.map((m) => m.id).sort((x, y) => x - y)).toEqual([t1, t2, t10, t11]);
    expect(laneB.members.map((m) => m.id).sort((x, y) => x - y)).toEqual([t1, t2, t20, t21]);
  });

  // The same fan-out under the scope the CONSOLE actually asks for. The range
  // case above was the only two-lanes-on-one-pair discovery test, and a
  // per-scope-kind regression would leave one whole reader under-discovering
  // silently — the segment scope is where this is most visible, since a
  // segment's lanes are exactly what the card and the graph render.
  test("a segment scope discovers BOTH lanes carried on one pair, and widens each past the roster", () => {
    const sessionId = seedSession("multi-tag-segment-discover");
    const t1 = insertTurn(sessionId, 1, { tags: ["a", "b"] });
    const t2 = insertTurn(sessionId, 2, { tags: ["a", "b"] });
    const t10 = insertTurn(sessionId, 10, { tags: ["a"] });
    const t11 = insertTurn(sessionId, 11, { tags: ["a"] });
    const t20 = insertTurn(sessionId, 20, { tags: ["b"] });
    const t21 = insertTurn(sessionId, 21, { tags: ["b"] });
    tagEdge(t2, t1, "extends", ["a"]);
    tagEdge(t2, t1, "extends", ["b"]);
    tagEdge(t11, t10, "extends", ["a"]);
    tagEdge(t21, t20, "extends", ["b"]);
    const segment = createSegment(db, { title: "multi-tag segment", nowEpoch: NOW });
    // Only the two-lane pair is a MEMBER; the two far pairs are reached by the
    // lane widening alone.
    addSegmentMembers(db, segment.id, [t1, t2, t10, t11, t20, t21], NOW);

    const projection = loadLaneCheckScope(db, { kind: "segment", segmentId: segment.id });

    expect(projection.involvedLaneKeys.map((k) => k.tag).sort()).toEqual(["a", "b"]);
    const result = checkLanes(projection.turns, projection.edges);
    expect(result.lanes.map((lane) => lane.key.tag).sort()).toEqual(["a", "b"]);
    const laneA = result.lanes.find((lane) => lane.key.tag === "a")!;
    const laneB = result.lanes.find((lane) => lane.key.tag === "b")!;
    expect(laneA.members.map((m) => m.id).sort((x, y) => x - y)).toEqual([t1, t2, t10, t11]);
    expect(laneB.members.map((m) => m.id).sort((x, y) => x - y)).toEqual([t1, t2, t20, t21]);
    assertNoDanglingEdges(projection);
  });
});

// Ticket 12 (lane-declaration spec, P1-7): DISCOVER (`loadTaggedEdgesTouching`)
// and WIDEN (`loadEdgesForTag`) were already relation-word-agnostic — neither
// filters on `me.relation`, only on `me.tags != '[]'` / tag-index membership
// — so no loader code changes for this ticket. This test pins that directly,
// since `lane-checker.ts`'s own fix (`unionsLaneComponentGraph`,
// `LANE_PATH_RELATIONS`) depends on a tagged cross-phase edge actually
// reaching `checkLanes` in the first place.
describe("ticket 12 — DISCOVER/WIDEN load a tagged cross-phase edge exactly like a tagged same-phase one", () => {
  test("a segment scope discovers and widens a lane whose ONLY tagged edge is a cross-phase grounds", () => {
    const sessionId = seedSession("cross-phase-widen");
    const t1 = insertTurn(sessionId, 1, { tags: ["x"] });
    const t2 = insertTurn(sessionId, 2, { tags: ["x"], type: ["research"] });
    tagEdge(t2, t1, "grounds", ["x"]);
    const segment = createSegment(db, { title: "cross-phase seg", nowEpoch: NOW });
    addSegmentMembers(db, segment.id, [t1, t2], NOW);

    const projection = loadLaneCheckScope(db, { kind: "segment", segmentId: segment.id });
    expect(projection.involvedLaneKeys.map((k) => k.tag)).toEqual(["x"]);
    expect(projection.edges).toContainEqual({
      citingId: t2,
      citedId: t1,
      relation: "grounds",
      tailTag: "x",
      headTag: "x",
    });

    const result = checkLanes(projection.turns, projection.edges, projection.outOfVocabularyEdges);
    const lane = result.lanes.find((l) => l.key.tag === "x")!;
    expect(lane.members.map((m) => m.id).sort((a, b) => a - b)).toEqual([t1, t2]);
    assertNoDanglingEdges(projection);
  });
});

// ------------------------------- peer round T1466: the turn-id seed scope (P1-1)

/**
 * LOAD-BEARING PROPERTIES of `{ kind: "turns" }` (mutation acceptance).
 *
 * The finding: the settlement window's writable set is an immutable, enumerated
 * turn-id list (window ∪ declared lookback ∪ closure) that no prompt-number
 * RANGE can express. Seeding on `windowStart..windowEnd` alone means a
 * lookback turn's E2/E3 stock never LOADS, so filtering errors by anchor
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
  // lane-declaration ticket 02 retired E1 and v12 ticket 11 deleted E2 as a
  // CLASS, so the DEFECT this test carries is now an out-of-vocabulary relation
  // reported as a WARNING (`vocabularyConformance.outOfVocabularyEdges`). What
  // is under test is unchanged and is the LOADER's, not the class's: a defect
  // sitting in the LOOKBACK is invisible to the window's own prompt range and
  // visible to the frozen turn-id seed. The untagged stance edge stays in the
  // fixture as the loader probe it always doubled as — its pass outlived E1
  // (it is a segment-graph edge and ticket 11's cluster domain), so this test
  // still fails if that pass is dropped.
  test("a LOOKBACK turn's edge defect fires under the turn-id seed, and is invisible to the window's own range", () => {
    const sessionId = seedSession("seed-lookback");
    const lookbackCited = insertTurn(sessionId, 1, { type: ["design"] });
    const lookbackCiting = insertTurn(sessionId, 2, { type: ["design"] });
    const windowA = insertTurn(sessionId, 8, { type: ["design"] });
    const windowB = insertTurn(sessionId, 9, { type: ["design"] });
    tagEdge(lookbackCiting, lookbackCited, "extends", []); // legal stock; the loader probe
    legacyOutOfVocabularyEdge(lookbackCiting, lookbackCited, "supersedes"); // the defect, in the lookback

    // The defect the RANGE cannot see: the window is prompts 8-9.
    const rangeOnly = loadLaneCheckScope(db, {
      kind: "range",
      sessionId,
      promptStart: 8,
      promptEnd: 9,
    });
    expect(
      checkLanes(rangeOnly.turns, rangeOnly.edges, rangeOnly.outOfVocabularyEdges)
        .vocabularyConformance.outOfVocabularyEdges.entries,
    ).toEqual([]);

    // The same defect, under the writable set the commit gate actually froze.
    const projection = loadLaneCheckScope(db, {
      kind: "turns",
      turnIds: [lookbackCited, lookbackCiting, windowA, windowB],
    });
    assertNoDanglingEdges(projection);
    // The untagged stance pass still reaches the lookback row.
    expect(
      projection.edges.some(
        (edge) =>
          edge.citingId === lookbackCiting &&
          edge.citedId === lookbackCited &&
          edge.relation === "extends",
      ),
    ).toBe(true);
    const outOfVocabulary = checkLanes(
      projection.turns,
      projection.edges,
      projection.outOfVocabularyEdges,
    ).vocabularyConformance.outOfVocabularyEdges.entries;
    expect(outOfVocabulary).toEqual([
      { citingId: lookbackCiting, citedId: lookbackCited, relation: "supersedes" },
    ]);
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
    legacyOutOfVocabularyEdge(seedTurn, external, "supersedes"); // pre-migration stock, anchors at seedTurn

    const projection = loadLaneCheckScope(db, { kind: "turns", turnIds: [seedTurn] });

    expect(projection.outOfVocabularyEdges).toEqual([
      { citingId: seedTurn, citedId: external, relation: "supersedes", tailTag: "", headTag: "" },
    ]);
    // The endpoint is JOINED IN rather than left dangling — the same
    // invariant every other pass holds. (It becomes a judgable row in its own
    // right; any error it earns anchors at ITSELF, i.e. outside this
    // window's writable set, so the commit gate still ignores it.)
    expect(projection.turns.map((turn) => turn.id)).toContain(external);
    assertNoDanglingEdges(projection);

    // v12 ticket 11: reported as a WARNING rather than error class E2 — the
    // LOADER contract this test guards (the far endpoint joins in) is unchanged.
    const reported = checkLanes(projection.turns, projection.edges, projection.outOfVocabularyEdges)
      .vocabularyConformance.outOfVocabularyEdges.entries;
    expect(reported).toEqual([{ citingId: seedTurn, citedId: external, relation: "supersedes" }]);
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
    const segmentId = seedHomeSegment([laneStart, laneMiddle, laneEnd, windowTurn], "seed-widen");
    tagEdge(laneMiddle, laneStart, "extends", ["ownership"]);
    tagEdge(laneEnd, laneMiddle, "indexes", ["ownership"]);

    // Only the lookback half of the frozen set touches the lane at all.
    const projection = loadLaneCheckScope(db, {
      kind: "turns",
      turnIds: [laneStart, laneMiddle, windowTurn],
    });
    expect(projection.involvedLaneKeys).toEqual([{ segment: String(segmentId), tag: "ownership" }]);
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

describe("tag-mandate ticket 05 acceptance repair — laneless stock still loads", () => {
  // The ticket-05 probe: every discovery/supplementary pass seeds from
  // DISCOVERED lane members, so a neighbourhood holding ONLY untagged
  // stance edges loaded nothing at all.
  //
  // lane-declaration ticket 02 retired the ERROR that probe was written for
  // (E1, the untagged extends), but not the LOADER property: an untagged
  // stance edge is a `LANE_COMPONENT_RELATIONS` bridge and is ticket 09's
  // unattributed-cluster domain, so it must still reach the projection. This
  // test now asserts exactly that, plus WHICH error the row raises: since
  // ticket 20 it is E6, the draft class, which fires on the empty SIDE rather
  // than on the word — the loader property is what makes it reachable at all.
  test("a pure untagged extends among laneless, tagless turns still reaches the projection, and raises E6", () => {
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
    // Ticket 20: the row raises E6 (a DRAFT edge) and nothing else — no E1
    // successor, no E4, and the turns themselves stay clean.
    expect(result.errors.map((e) => `${e.class}:${e.anchorId}`)).toEqual([`E6:${b}`]);
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

// ---------------------------------------------------------------------------
// D9 proliferation's segment-wide facts (lane-declaration ticket 09)
// ---------------------------------------------------------------------------

/**
 * `LaneCheckProjection.segmentFacts` is the ONE place the proliferation
 * warning's two numbers come from, and the reason it exists is peer P1-11:
 * inferred from a window's projection, the SAME segment yields a different
 * verdict from a 4-turn settlement window than from a 100-turn one. Every
 * test below is a statement about that independence, about the registry
 * being the source of the lane count (not the tags this projection loaded),
 * or about the live filter on the denominator.
 */
describe("D9 segment facts — the registry and the membership table, never the window", () => {
  function seedSegment(memberCount: number, laneTags: readonly string[]): { segmentId: number; turnIds: number[] } {
    const sessionId = seedSession("d9");
    const segment = createSegment(db, { title: "d9", nowEpoch: NOW });
    const turnIds = Array.from({ length: memberCount }, (_, index) =>
      insertTurn(sessionId, index + 1, { tags: ["ownership"] }),
    );
    addSegmentMembers(db, segment.id, turnIds, NOW);
    for (const tag of laneTags) {
      insertLane(db, segment.id, tag, NOW);
    }
    return { segmentId: segment.id, turnIds };
  }

  test("the counts come from `lanes` + `segment_members`, and a 4-turn window reads exactly what a whole-segment scan reads", () => {
    const { segmentId, turnIds } = seedSegment(30, ["ownership", "release", "rubric-design"]);
    // One tagged edge, so the narrow window discovers a lane at all — the
    // window sees ONE of the three declared lanes and 4 of the 30 members.
    tagEdge(turnIds[1]!, turnIds[0]!, "extends", ["ownership"]);

    const narrow = loadLaneCheckScope(db, { kind: "turns", turnIds: turnIds.slice(0, 4) });
    const whole = loadLaneCheckScope(db, { kind: "segment", segmentId });

    // ticket 14: the two lanes no edge carries are NAMED (they still count in
    // `declaredLaneCount` — see `LaneSegmentFacts.emptyLaneTags`), and that
    // naming is window-independent for the same reason the counts are.
    const expected = [
      {
        segment: String(segmentId),
        declaredLaneCount: 3,
        memberTurnCount: 30,
        emptyLaneTags: ["release", "rubric-design"],
      },
    ];
    expect(narrow.segmentFacts).toEqual(expected);
    expect(whole.segmentFacts).toEqual(expected);
    // Not vacuous: the narrow window really did resolve fewer lanes than the
    // segment declared — one of three — even though ticket 10's member widen
    // now pulls that ONE lane's whole membership in, so the two projections
    // agree on turn count. The facts above come from the registry and the
    // membership table; the projection's own shape is a separate question.
    expect(narrow.involvedLaneKeys).toHaveLength(1);
    expect(narrow.segmentFacts[0]!.declaredLaneCount).toBe(3);
  });

  test("a DECLARED lane no edge ever carried still counts — the registry is the source, not the loaded tags", () => {
    const { segmentId, turnIds } = seedSegment(10, ["ownership", "unused-a", "unused-b"]);
    tagEdge(turnIds[1]!, turnIds[0]!, "extends", ["ownership"]);
    const projection = loadLaneCheckScope(db, { kind: "segment", segmentId });
    expect(projection.involvedLaneKeys).toHaveLength(1);
    expect(projection.segmentFacts[0]!.declaredLaneCount).toBe(3);
  });

  test("the member count is LIVE-filtered: a skipped or rolled-back member never inflates the denominator", () => {
    const sessionId = seedSession("d9-live");
    const segment = createSegment(db, { title: "d9-live", nowEpoch: NOW });
    const live = insertTurn(sessionId, 1);
    const skipped = insertTurn(sessionId, 2, { status: "skipped" });
    const rolledBack = insertTurn(sessionId, 3, { wasRolledBack: true });
    addSegmentMembers(db, segment.id, [live, skipped, rolledBack], NOW);

    const projection = loadLaneCheckScope(db, { kind: "segment", segmentId: segment.id });
    expect(projection.segmentFacts).toEqual([
      { segment: String(segment.id), declaredLaneCount: 0, memberTurnCount: 1, emptyLaneTags: [] },
    ]);
  });

  test("the warning fires end to end from a real segment: 6 declared over 100 members", () => {
    const { segmentId } = seedSegment(100, ["a", "b", "c", "d", "e", "f"]);
    const projection = loadLaneCheckScope(db, { kind: "segment", segmentId });
    const result = checkLanes(
      projection.turns,
      projection.edges,
      projection.outOfVocabularyEdges,
      projection.segmentFacts,
    );
    expect(result.laneProliferation).toEqual([
      {
        segment: String(segmentId),
        declaredLaneCount: 6,
        memberTurnCount: 100,
        allowance: 5,
        // ticket 14: no edge carries any of the six, so all six are the
        // removable remainder of the count that just tripped.
        emptyLaneTags: ["a", "b", "c", "d", "e", "f"],
      },
    ]);
    // And exactly at the ratio it is silent, from the same real load path.
    deleteLane(db, segmentId, "f");
    const atRatio = loadLaneCheckScope(db, { kind: "segment", segmentId });
    expect(
      checkLanes(atRatio.turns, atRatio.edges, atRatio.outOfVocabularyEdges, atRatio.segmentFacts)
        .laneProliferation,
    ).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // ticket 14 — the numerator and the registry agree on what counts
  // -------------------------------------------------------------------------

  test("ticket 14: a lane whose only carrying edge has a SKIPPED endpoint is reported empty — law 8 gates the empty-lane pass on both endpoints", () => {
    const sessionId = seedSession("d9-empty-skipped");
    const segment = createSegment(db, { title: "d9-empty-skipped", nowEpoch: NOW });
    const live = insertTurn(sessionId, 1, { tags: ["ownership"] });
    const skipped = insertTurn(sessionId, 2, { tags: ["ownership"], status: "skipped" });
    addSegmentMembers(db, segment.id, [live, skipped], NOW);
    insertLane(db, segment.id, "ownership", NOW);
    tagEdge(skipped, live, "extends", ["ownership"]);

    const projection = loadLaneCheckScope(db, { kind: "segment", segmentId: segment.id });
    // The edge exists in the table and carries the tag; it is in NO graph, so
    // the lane it would have populated has no member the reader can see.
    expect(projection.segmentFacts).toEqual([
      { segment: String(segment.id), declaredLaneCount: 1, memberTurnCount: 1, emptyLaneTags: ["ownership"] },
    ]);
  });

  test("ticket 14: a lane whose only carrying edge has a ROLLED-BACK endpoint is reported empty too", () => {
    const sessionId = seedSession("d9-empty-rolled-back");
    const segment = createSegment(db, { title: "d9-empty-rolled-back", nowEpoch: NOW });
    const live = insertTurn(sessionId, 1, { tags: ["ownership"] });
    const rolledBack = insertTurn(sessionId, 2, { tags: ["ownership"], wasRolledBack: true });
    addSegmentMembers(db, segment.id, [live, rolledBack], NOW);
    insertLane(db, segment.id, "ownership", NOW);
    tagEdge(rolledBack, live, "extends", ["ownership"]);

    const projection = loadLaneCheckScope(db, { kind: "segment", segmentId: segment.id });
    expect(projection.segmentFacts[0]!.emptyLaneTags).toEqual(["ownership"]);
  });

  test("ticket 14: a lane WITH a live carrying edge is not reported empty (the pass filters rather than reporting everything)", () => {
    const { segmentId, turnIds } = seedSegment(10, ["used", "unused"]);
    tagEdge(turnIds[1]!, turnIds[0]!, "extends", ["used"]);
    const projection = loadLaneCheckScope(db, { kind: "segment", segmentId });
    expect(projection.segmentFacts[0]!.emptyLaneTags).toEqual(["unused"]);
  });

  test("ticket 14: a cross-segment edge keeps the lane non-empty on BOTH sides — the empty-lane pass matches from EITHER endpoint's owning segment", () => {
    const sessionId = seedSession("d9-empty-cross");
    const segmentA = createSegment(db, { title: "d9-cross-a", nowEpoch: NOW });
    const segmentB = createSegment(db, { title: "d9-cross-b", nowEpoch: NOW });
    const here = insertTurn(sessionId, 1, { tags: ["shared"] });
    const there = insertTurn(sessionId, 2, { tags: ["shared"] });
    addSegmentMembers(db, segmentA.id, [here], NOW);
    addSegmentMembers(db, segmentB.id, [there], NOW);
    insertLane(db, segmentA.id, "shared", NOW);
    insertLane(db, segmentB.id, "shared", NOW);
    // The edge is written FROM B's turn TO A's turn: A owns only the CITED
    // side, so a citing-side-only match would call A's lane empty.
    tagEdge(there, here, "extends", ["shared"]);

    const fromA = loadLaneCheckScope(db, { kind: "segment", segmentId: segmentA.id });
    const fromB = loadLaneCheckScope(db, { kind: "segment", segmentId: segmentB.id });
    expect(fromA.segmentFacts.find((f) => f.segment === String(segmentA.id))!.emptyLaneTags).toEqual([]);
    expect(fromB.segmentFacts.find((f) => f.segment === String(segmentB.id))!.emptyLaneTags).toEqual([]);
  });

  test("ticket 14: an empty lane STILL COUNTS in the numerator — the boundary case where the rule is decided", () => {
    // 40 live members, 2 declared lanes, ONE of which no edge carries.
    const { segmentId, turnIds } = seedSegment(40, ["used", "unused"]);
    tagEdge(turnIds[1]!, turnIds[0]!, "extends", ["used"]);

    // Exactly AT the line: 2 declared, 2 * 20 == 40 members -> silent.
    const atLine = loadLaneCheckScope(db, { kind: "segment", segmentId });
    expect(atLine.segmentFacts[0]!).toEqual({
      segment: String(segmentId),
      declaredLaneCount: 2,
      memberTurnCount: 40,
      emptyLaneTags: ["unused"],
    });
    expect(
      checkLanes(atLine.turns, atLine.edges, atLine.outOfVocabularyEdges, atLine.segmentFacts)
        .laneProliferation,
    ).toEqual([]);

    // One member skipped -> 39 members, and the SAME 2 declared lanes now
    // exceed max(1, 39/20). This is the assertion that decides the rule: had
    // the empty lane been excluded from the numerator, `declaredLaneCount`
    // would be 1 and the max(1, …) floor would keep this silent forever.
    db.query<unknown, [number]>("UPDATE turns SET status = 'skipped' WHERE id = ?").run(turnIds[39]!);
    const overLine = loadLaneCheckScope(db, { kind: "segment", segmentId });
    expect(
      checkLanes(overLine.turns, overLine.edges, overLine.outOfVocabularyEdges, overLine.segmentFacts)
        .laneProliferation,
    ).toEqual([
      {
        segment: String(segmentId),
        declaredLaneCount: 2,
        memberTurnCount: 39,
        allowance: 1.95,
        // …and the inflation is never silent: the lane no reader can see is
        // named, and `undeclare` (ticket 14's guard repair) can remove it.
        emptyLaneTags: ["unused"],
      },
    ]);
  });

  test("a homeless (segment-less) window asks about no segment at all, so it gets no facts", () => {
    const sessionId = seedSession("d9-homeless");
    const t1 = insertTurn(sessionId, 1);
    const t2 = insertTurn(sessionId, 2);
    tagEdge(t2, t1, "extends", []);
    const projection = loadLaneCheckScope(db, { kind: "range", sessionId, promptStart: 1, promptEnd: 2 });
    expect(projection.involvedLaneKeys.every((key) => key.segment === DEFAULT_SEGMENT)).toBe(true);
    expect(projection.segmentFacts).toEqual([]);
  });

  test("a database whose `lanes` registry does not exist yet reports zero declared lanes instead of throwing", () => {
    // The live database is exactly this shape — the registry ships but has
    // never been created there, and `scripts/lane-check.ts` opens it hard
    // read-only, so it cannot create the table on the way in. Zero declared
    // lanes can never trip `> max(1, …)`, so the safe answer is also the
    // honest one.
    const { segmentId } = seedSegment(10, ["a", "b", "c"]);
    db.run("DROP TABLE lanes");
    const projection = loadLaneCheckScope(db, { kind: "segment", segmentId });
    expect(projection.segmentFacts).toEqual([
      // ticket 14: no registry means zero declared lanes, so it also means
      // zero EMPTY ones — the empty-lane pass reads `lanes` too and is inside
      // the same existence guard.
      { segment: String(segmentId), declaredLaneCount: 0, memberTurnCount: 10, emptyLaneTags: [] },
    ]);
  });

  test("an unattributed cluster survives the real load path — untagged stance stock reaches the checker as a cluster", () => {
    // The pass `db/lane-checker-load.ts` deliberately KEPT when E1 retired
    // (its "UNTAGGED STANCE PASS" comment): without it a neighbourhood of
    // purely untagged stance edges loads nothing and this warning is
    // structurally starved, which would look exactly like silence.
    const sessionId = seedSession("d9-cluster");
    const ids = [1, 2, 3, 4].map((prompt) => insertTurn(sessionId, prompt));
    for (let index = 1; index < ids.length; index += 1) {
      tagEdge(ids[index]!, ids[index - 1]!, "extends", []);
    }
    const projection = loadLaneCheckScope(db, { kind: "range", sessionId, promptStart: 1, promptEnd: 4 });
    const result = checkLanes(projection.turns, projection.edges, projection.outOfVocabularyEdges);
    expect(result.unattributedClusters.entries).toEqual([{ turnIds: ids, turnCount: 4 }]);
  });
});

// ------------------- v12 ticket 06: the passes read the SIDE columns

/**
 * THE SWITCH THIS TICKET IS. DISCOVER used to select on `me.tags != '[]'`,
 * WIDEN on `memory_edge_tags`, and `loadSegmentFacts`' empty-lane pass on
 * `memory_edge_tags` too — three readers of a column that, under v12, answers
 * a DIFFERENT question than the one being asked. Each test below is written
 * so that the pre-switch predicate gives a different answer.
 */
describe("DISCOVER/WIDEN/segment-facts select on the SIDE columns, not on `tags`", () => {
  test("a CROSS-LANE row (`tags = '[]'`) is discovered and names TWO lanes — a `tags`-keyed discovery pass would not see it at all", () => {
    const sessionId = seedSession("v12-cross-lane-discover");
    const t1 = insertTurn(sessionId, 1, { tags: ["b"] });
    const t2 = insertTurn(sessionId, 2, { tags: ["a"] });
    crossLaneEdge(t2, t1, "extends", "a", "b");

    const projection = loadLaneCheckScope(db, { kind: "turns", turnIds: [t1, t2] });
    // `me.tags != '[]'` is FALSE for this row: discovery finds it only
    // because `tail_tag <> '' OR head_tag <> ''` is TRUE.
    expect(projection.involvedLaneKeys.map((k) => k.tag).sort()).toEqual(["a", "b"]);
    expect(projection.edges).toEqual([
      { citingId: t2, citedId: t1, relation: "extends", tailTag: "a", headTag: "b" },
    ]);
    assertNoDanglingEdges(projection);

    // …and the core's own answer to the same row: it NAMES two lanes and
    // JOINS neither. Both lanes exist — each endpoint carries its own side's
    // tag, and membership is a node fact (ticket 10) — but the crossing is
    // INTERNAL to neither, and no subset error fires (each side's tag sits on
    // its own endpoint).
    const result = checkLanes(projection.turns, projection.edges, projection.outOfVocabularyEdges);
    expect(result.lanes.map((lane) => lane.key.tag).sort()).toEqual(["a", "b"]);
    expect(result.lanes.flatMap((lane) => lane.edgeCountsByRelation.extends ?? [])).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  test("WIDEN finds the cross-lane row by EITHER side's tag — `memory_edge_tags` holds nothing for it", () => {
    const sessionId = seedSession("v12-cross-lane-widen");
    const t1 = insertTurn(sessionId, 1, { tags: ["b"] });
    const t2 = insertTurn(sessionId, 2, { tags: ["a"] });
    const segmentId = seedHomeSegment([t1, t2], "v12-cross-lane-widen");
    crossLaneEdge(t2, t1, "extends", "a", "b");

    for (const tag of ["a", "b"]) {
      const named = loadLaneCheckScope(db, {
        kind: "lanes",
        laneKeys: [{ segment: String(segmentId), tag }],
      });
      expect(named.edges).toHaveLength(1);
      expect(named.edges[0]).toEqual({
        citingId: t2,
        citedId: t1,
        relation: "extends",
        tailTag: "a",
        headTag: "b",
      });
    }
  });

  test("DISCOVER's two keys are PER SIDE: the tail key takes the CITING turn's segment, the head key the CITED turn's", () => {
    const sessionId = seedSession("v12-discover-per-side");
    const segmentA = createSegment(db, { title: "v12-disc-a", nowEpoch: NOW });
    const segmentB = createSegment(db, { title: "v12-disc-b", nowEpoch: NOW });
    const cited = insertTurn(sessionId, 1, { tags: ["onlyB"] });
    const citing = insertTurn(sessionId, 2, { tags: ["onlyA"] });
    addSegmentMembers(db, segmentA.id, [citing], NOW);
    addSegmentMembers(db, segmentB.id, [cited], NOW);
    crossLaneEdge(citing, cited, "extends", "onlyA", "onlyB");

    const projection = loadLaneCheckScope(db, { kind: "turns", turnIds: [citing, cited] });
    // Exactly two keys, each pairing a side's tag with ITS OWN endpoint's
    // segment. Crossing the two — (B,"onlyA") / (A,"onlyB") — would name two
    // lanes this edge has nothing to do with, and would then widen from them.
    expect(
      [...projection.involvedLaneKeys]
        .map((k) => `${k.segment}:${k.tag}`)
        .sort(),
    ).toEqual([`${segmentA.id}:onlyA`, `${segmentB.id}:onlyB`].sort());
  });

  test("WIDEN's segment filter is PER SIDE: the tail speaks for the citing turn's segment and the head for the cited turn's, never the other way round", () => {
    const sessionId = seedSession("v12-widen-per-side");
    const segmentA = createSegment(db, { title: "v12-side-a", nowEpoch: NOW });
    const segmentB = createSegment(db, { title: "v12-side-b", nowEpoch: NOW });
    const cited = insertTurn(sessionId, 1, { tags: ["onlyB"] });
    const citing = insertTurn(sessionId, 2, { tags: ["onlyA"] });
    addSegmentMembers(db, segmentB.id, [cited], NOW);
    addSegmentMembers(db, segmentA.id, [citing], NOW);
    // tail `onlyA` belongs to the CITING turn (segment A); head `onlyB` to
    // the CITED turn (segment B).
    crossLaneEdge(citing, cited, "extends", "onlyA", "onlyB");

    const rightSide = loadLaneCheckScope(db, {
      kind: "lanes",
      laneKeys: [{ segment: String(segmentA.id), tag: "onlyA" }],
    });
    expect(rightSide.edges).toHaveLength(1);

    // The tag IS on the row and the segment IS one of the row's two — but
    // not on the SAME side. The pre-switch "either endpoint's segment"
    // filter would load this; the per-side one must not.
    const wrongSide = loadLaneCheckScope(db, {
      kind: "lanes",
      laneKeys: [{ segment: String(segmentB.id), tag: "onlyA" }],
    });
    expect(wrongSide.edges).toEqual([]);
  });

  test("the empty-lane pass matches per side too: a declared lane whose tag appears only on the OTHER segment's side is EMPTY", () => {
    const sessionId = seedSession("v12-empty-per-side");
    const segmentA = createSegment(db, { title: "v12-empty-a", nowEpoch: NOW });
    const segmentB = createSegment(db, { title: "v12-empty-b", nowEpoch: NOW });
    const cited = insertTurn(sessionId, 1, { tags: ["onlyB"] });
    const citing = insertTurn(sessionId, 2, { tags: ["onlyA"] });
    addSegmentMembers(db, segmentB.id, [cited], NOW);
    addSegmentMembers(db, segmentA.id, [citing], NOW);
    crossLaneEdge(citing, cited, "extends", "onlyA", "onlyB");
    // All four (segment, tag) combinations declared, so the ONLY thing that
    // can separate them is which side each tag sits on.
    for (const segment of [segmentA, segmentB]) {
      for (const tag of ["onlyA", "onlyB"]) {
        insertLane(db, segment.id, tag, NOW);
      }
    }

    const projection = loadLaneCheckScope(db, {
      kind: "lanes",
      laneKeys: [
        { segment: String(segmentA.id), tag: "onlyA" },
        { segment: String(segmentB.id), tag: "onlyB" },
      ],
    });
    const factsFor = (id: number) => projection.segmentFacts.find((f) => f.segment === String(id))!;
    // A owns the CITING turn, so only the TAIL tag makes a lane of A's
    // non-empty; B owns the CITED turn, so only the HEAD tag does.
    expect(factsFor(segmentA.id).emptyLaneTags).toEqual(["onlyB"]);
    expect(factsFor(segmentB.id).emptyLaneTags).toEqual(["onlyA"]);
  });
});
