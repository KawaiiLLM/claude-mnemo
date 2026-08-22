import { describe, expect, test } from "bun:test";

import {
  DEFAULT_SEGMENT,
  deriveLaneInterpretation,
  laneToken,
  type LaneEdgeInput,
  type LaneTurnInput,
} from "../../src/shared/lane-interpretation";

const design = (id: number): LaneTurnInput => ({ id, type: ["design"] });
const edge = (
  citingId: number,
  relation: string,
  citedId: number,
  tags: string[] = [],
): LaneEdgeInput => ({ citingId, relation, citedId, tags });

function laneOf(
  derivation: ReturnType<typeof deriveLaneInterpretation>,
  tags: string[],
  segment: string = DEFAULT_SEGMENT,
) {
  return derivation.laneByToken.get(laneToken(segment, tags));
}

describe("lane enumeration", () => {
  test("coexisting untagged/{A}/{B}/{A,B} rows on one pair enumerate THREE distinct lanes; the untagged row forms none", () => {
    const turns = [design(1), design(2)];
    const edges = [
      edge(2, "extends", 1, []),
      edge(2, "extends", 1, ["A"]),
      edge(2, "extends", 1, ["B"]),
      edge(2, "extends", 1, ["A", "B"]),
    ];
    const derivation = deriveLaneInterpretation(turns, edges);
    expect(derivation.lanes.length).toBe(3);

    const laneA = laneOf(derivation, ["A"]);
    const laneB = laneOf(derivation, ["B"]);
    const laneAB = laneOf(derivation, ["A", "B"]);
    expect(laneA?.taggedEdges.length).toBe(1);
    expect(laneB?.taggedEdges.length).toBe(1);
    expect(laneAB?.taggedEdges.length).toBe(1);
    // {A}+{B} (two rows) is a DIFFERENT fact from {A,B} (one row) — three
    // independent lanes, none unioned, matching the draft's "不同事实".
    expect(laneA?.members.map((m) => m.id)).toEqual([1, 2]);
    expect(laneAB?.members.map((m) => m.id)).toEqual([1, 2]);
  });

  test("a tag set with no tagged edge never enumerates — untagged edges alone produce zero lanes", () => {
    const turns = [design(1), design(2), design(3)];
    const edges = [edge(2, "extends", 1), edge(3, "consume", 2)];
    const derivation = deriveLaneInterpretation(turns, edges);
    expect(derivation.lanes).toEqual([]);
  });
});

describe("event reduction — the four override cases", () => {
  test("tagged override of the CURRENT terminus reopens the lane and marks the target dead-in-lane", () => {
    const turns = [design(101), design(102), design(103)];
    const edges = [
      edge(102, "extends", 101, ["x"]),
      edge(102, "indexes", 101, ["x"]),
      edge(103, "override", 102, ["x"]),
    ];
    const lane = laneOf(deriveLaneInterpretation(turns, edges), ["x"]);
    expect(lane?.declaration).toEqual({ state: "reopened", terminus: null, latestEventTurn: 103 });
    expect(lane?.members.find((m) => m.id === 102)?.dead).toBe(true);
    expect(lane?.members.find((m) => m.id === 101)?.dead).toBe(false);
  });

  test("untagged override GLOBALLY kills the target — dead in every lane it belongs to, not just the one it terminates", () => {
    const turns = [design(201), design(202), design(203), design(204)];
    const edges = [
      edge(202, "extends", 201, ["y"]),
      edge(202, "indexes", 201, ["y"]),
      edge(203, "override", 202, []), // untagged: global kill of 202
      edge(204, "extends", 202, ["z"]), // 202 is ALSO a {z} member, via a different lane
    ];
    const derivation = deriveLaneInterpretation(turns, edges);
    const laneY = laneOf(derivation, ["y"]);
    const laneZ = laneOf(derivation, ["z"]);
    // {y}: 202 WAS its terminus -> reopened.
    expect(laneY?.declaration).toEqual({ state: "reopened", terminus: null, latestEventTurn: 203 });
    expect(laneY?.members.find((m) => m.id === 202)?.dead).toBe(true);
    // {z}: 202 is a member but never that lane's terminus (no indexes for z at
    // all) — {z} itself stays undeclared and untouched by the kill's OWN
    // bookkeeping, yet 202 shows dead here too: "dead node everywhere".
    expect(laneZ?.declaration).toEqual({ state: "undeclared", terminus: null, latestEventTurn: null });
    expect(laneZ?.members.find((m) => m.id === 202)?.dead).toBe(true);
  });

  test("an override tagged with a DIFFERENT lane's tag is indifferent — the untouched lane keeps its terminus and a clean member", () => {
    const turns = [design(301), design(302), design(303)];
    const edges = [
      edge(302, "extends", 301, ["p"]),
      edge(302, "indexes", 301, ["p"]),
      edge(303, "override", 302, ["q"]), // a DIFFERENT lane's business entirely
    ];
    const derivation = deriveLaneInterpretation(turns, edges);
    const laneP = laneOf(derivation, ["p"]);
    expect(laneP?.declaration).toEqual({ state: "declared", terminus: 302, latestEventTurn: 302 });
    expect(laneP?.members.find((m) => m.id === 302)?.dead).toBe(false);
    // {q} itself auto-vivifies from this one tagged (override) edge — an
    // override CAN be a lane's sole tagged edge.
    const laneQ = laneOf(derivation, ["q"]);
    expect(laneQ?.declaration.state).toBe("undeclared");
    expect(laneQ?.members.find((m) => m.id === 302)?.dead).toBe(true);
  });

  test("a lane with no reduction event at all (pure continuation) is undeclared with latestEventTurn null — distinct from an override-touched-but-never-declared lane", () => {
    const turns = [design(401), design(402), design(403)];
    const edges = [edge(402, "extends", 401, ["silent"]), edge(403, "extends", 402, ["silent"])];
    const lane = laneOf(deriveLaneInterpretation(turns, edges), ["silent"]);
    expect(lane?.declaration).toEqual({ state: "undeclared", terminus: null, latestEventTurn: null });
  });
});

describe("declaration/override/continuation ordering by turn — the mutation-detecting property", () => {
  // Load-bearing property: reduction is sorted by CITING-TURN id, never by
  // the position an edge happens to occupy in the input array. Edges below
  // are handed in DESCENDING/scrambled array order on purpose; a reducer
  // that (incorrectly) folded events in array order would let e1 (T404's
  // declaration) get overwritten by e2 (T402's declaration, processed
  // SECOND in the array despite being chronologically EARLIER), landing
  // terminus=402. Correct turn-order reduction must land terminus=404 (the
  // higher citing-turn id — "later wins").
  test("turn-order reduction wins over edge ARRAY order — shuffled input still finds the LATEST-by-turn declaration", () => {
    const turns = [design(401), design(402), design(403), design(404)];
    const e1 = edge(404, "indexes", 403, ["m"]); // latest declaration, turn 404
    const e2 = edge(402, "indexes", 401, ["m"]); // earlier declaration, turn 402
    const e3 = edge(403, "extends", 402, ["m"]);
    const e4 = edge(402, "extends", 401, ["m"]);
    const e5 = edge(404, "extends", 403, ["m"]);
    const scrambled = [e1, e2, e3, e4, e5]; // array order: 404, 402, 403, 402, 404
    const lane = laneOf(deriveLaneInterpretation(turns, scrambled), ["m"]);
    expect(lane?.declaration.terminus).toBe(404);
    expect(lane?.declaration.state).toBe("declared");

    // Sanity: a DIFFERENT array ordering of the exact same edge set agrees —
    // the result depends only on citingId, never on array position.
    const reordered = [e4, e3, e5, e2, e1];
    const laneReordered = laneOf(deriveLaneInterpretation(turns, reordered), ["m"]);
    expect(laneReordered?.declaration.terminus).toBe(404);
  });

  test("continuation after a declaration does not retroactively move it — only a NEW indexes event does", () => {
    const turns = [design(501), design(502), design(503)];
    const edges = [
      edge(502, "extends", 501, ["c"]),
      edge(502, "indexes", 501, ["c"]), // declares at 502
      edge(503, "extends", 502, ["c"]), // plain continuation, no re-declaration
    ];
    const lane = laneOf(deriveLaneInterpretation(turns, edges), ["c"]);
    expect(lane?.declaration.terminus).toBe(502);
    expect(lane?.declaration.state).toBe("declared");
    // 503 is a member (endpoint of the lane's own tagged edge) but never
    // became the terminus — silence never establishes convergence.
    expect(lane?.members.map((m) => m.id)).toEqual([501, 502, 503]);
  });
});
