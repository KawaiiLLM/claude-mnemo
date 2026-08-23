import { describe, expect, test } from "bun:test";

import {
  DEFAULT_SEGMENT,
  deriveLaneInterpretation,
  deriveLaneStates,
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
  // Load-bearing property (round-4 review #2): reduction is sorted by the
  // TURN-ORDER KEY (`LaneTurnInput.order`, defaulting to `id` only when
  // omitted), never by edge ARRAY position, and — this is the corrected
  // half — never by raw `id` either once `order` diverges from it. A
  // backfill-inserted earlier turn can carry a LATER row id than turns that
  // chronologically follow it, so a reducer that (incorrectly) sorted by
  // `id` would let the truly-later declaration lose to the truly-earlier
  // one whenever backfill inverted their id order. The fixture below gives
  // every turn an `order` that is the EXACT REVERSE of its `id` — a reducer
  // that silently fell back to `id`-based sorting (the pre-fix behaviour)
  // would land terminus=500 here; correct order-key reduction lands 100.
  test("turn-order reduction uses the explicit `order` key, never raw `id` — a backfilled turn's larger id does not make it 'later'", () => {
    const earlyBackfilled: LaneTurnInput = { id: 999, type: ["design"], order: [0, 1] }; // true order 1st, but the LARGEST id
    const middle: LaneTurnInput = { id: 500, type: ["design"], order: [0, 2] };
    const late: LaneTurnInput = { id: 100, type: ["design"], order: [0, 3] }; // true order 3rd (latest), but the SMALLEST id
    const turns = [earlyBackfilled, middle, late];
    const e1 = edge(500, "indexes", 999, ["m"]); // order 2 declares terminus=500
    const e2 = edge(100, "indexes", 999, ["m"]); // order 3 declares terminus=100 -- must win
    const e3 = edge(500, "extends", 999, ["m"]);
    const e4 = edge(100, "extends", 500, ["m"]);

    const lane = laneOf(deriveLaneInterpretation(turns, [e1, e2, e3, e4]), ["m"]);
    // A reducer sorting by raw id (100 < 500 < 999) would process
    // citingId=100 BEFORE citingId=500, landing terminus=500 — the old,
    // wrong reading. Correct order-key reduction processes order=2 (id 500)
    // before order=3 (id 100), so 100's declaration wins.
    expect(lane?.declaration.terminus).toBe(100);
    expect(lane?.declaration.state).toBe("declared");

    // Sanity: shuffling the ARRAY order of the exact same edges agrees —
    // the result depends only on `order`, never on array position either.
    const reordered = [e4, e3, e2, e1];
    const laneReordered = laneOf(deriveLaneInterpretation(turns, reordered), ["m"]);
    expect(laneReordered?.declaration.terminus).toBe(100);
  });

  test("with no explicit `order`, `id` is the order key — plain fixtures (id already in true order) are unaffected", () => {
    const turns = [design(401), design(402), design(403), design(404)];
    const e1 = edge(404, "indexes", 403, ["m"]); // latest declaration, turn 404
    const e2 = edge(402, "indexes", 401, ["m"]); // earlier declaration, turn 402
    const scrambled = [e1, e2]; // array order does not match id order either
    const lane = laneOf(deriveLaneInterpretation(turns, scrambled), ["m"]);
    expect(lane?.declaration.terminus).toBe(404);
  });

  test("structural continuations advance latestEventTurn once a lane has been declared — silence does not, but living past a declaration does", () => {
    const turns = [design(20), design(21), design(22)];
    const edges = [
      edge(21, "extends", 20, ["cont"]),
      edge(21, "indexes", 20, ["cont"]), // declares at 21
      edge(22, "extends", 21, ["cont"]), // continuation past the declaration
    ];
    const lane = laneOf(deriveLaneInterpretation(turns, edges), ["cont"]);
    expect(lane?.declaration.terminus).toBe(21); // continuation never moves the terminus
    expect(lane?.declaration.latestEventTurn).toBe(22); // but it IS the freshest activity
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

describe("order key is a lexicographically-compared tuple, never a scalar encoding (round-5 review #10)", () => {
  // The defect: a PRIOR version of the DB adapter encoded `(session_id,
  // prompt_number)` as `sessionId * 1e8 + promptNumber`, which both COLLIDES
  // (`1*1e8 + 1e8 === 2*1e8 + 0`) and loses precision. The core's own fix is
  // to never accept a scalar at all — `LaneTurnInput.order` is a two-element
  // tuple, compared element-wise. This test proves the core does real
  // lexicographic comparison (major element dominates regardless of how
  // large the minor element gets), not some derived scalar that could still
  // collide the same way internally.
  test("a turn whose order tuple has a huge minor component still sorts strictly BEFORE a turn with a larger major component and a tiny minor one", () => {
    const base: LaneTurnInput = { id: 1, type: ["design"] };
    // Major=1 with an enormous minor vs major=2 with a minor of 0 — a scalar
    // encoding with any fixed span collides or misorders pairs like this;
    // lexicographic tuple compare never does, regardless of magnitude.
    const early: LaneTurnInput = { id: 2, type: ["design"], order: [1, 100_000_000] };
    const late: LaneTurnInput = { id: 3, type: ["design"], order: [2, 0] };
    const edges = [
      edge(2, "indexes", 1, ["ord"]),
      edge(3, "indexes", 1, ["ord"]),
    ];
    const lane = laneOf(deriveLaneInterpretation([base, early, late], edges), ["ord"]);
    // `late` (order [2,0]) must win regardless of array/id position — id 3 >
    // id 2 here too, so this alone would not distinguish a correct
    // lexicographic-tuple reducer from a buggy id-fallback one; the real
    // proof is the companion DB-adapter test where id order is INVERTED
    // relative to true (session, prompt) order.
    expect(lane?.declaration.terminus).toBe(3);
  });
});

describe("laneToken never collides a differently-split tag set with one containing the delimiter literally (round-5 review #14)", () => {
  test("['a','b'] and a single tag whose text literally contains the old U+0001 join character are distinct lane tokens", () => {
    // The defect: the old join was `canonicalTagSet(tags).join(\"\\u0001\")`
    // then `segment + \"\\u0000\" + tagSetKey`. A tag whose own text CONTAINS
    // that join character collides with a differently-split tag set that
    // joins to the identical string: `[\"a\",\"b\"]` joined on U+0001
    // produces \"a\\u0001b\", and the single tag `[\"a\\u0001b\"]` (one
    // element, no separator emitted) joins to the SAME string.
    const tokenSplit = laneToken(DEFAULT_SEGMENT, ["a", "b"]);
    const tokenLiteral = laneToken(DEFAULT_SEGMENT, ["a\u0001b"]);
    expect(tokenSplit).not.toBe(tokenLiteral);
  });

  test("a segment name containing the old U+0000 separator does not collide two different (segment, tagSet) pairs", () => {
    const a = laneToken("x\u0000y", ["z"]);
    const b = laneToken("x", ["y\u0000z"]);
    expect(a).not.toBe(b);
  });
});

describe("cross-segment tagged edges — dual appearance and warnings (round-4 review #5)", () => {
  test("a cross-segment tagged edge enumerates its lane from BOTH sides' segments, and is named in `warnings`", () => {
    const turns: LaneTurnInput[] = [
      { id: 1, type: ["design"], segment: "A" },
      { id: 2, type: ["design"], segment: "B" },
    ];
    const edges = [edge(2, "extends", 1, ["x"])]; // citing turn 2 in segment B cites turn 1 in segment A
    const derivation = deriveLaneInterpretation(turns, edges);

    const laneA = laneOf(derivation, ["x"], "A");
    const laneB = laneOf(derivation, ["x"], "B");
    expect(laneA).toBeDefined();
    expect(laneB).toBeDefined();
    // Both sides see the SAME members/tagged edges — it is the same fact,
    // filed under two segment scans.
    expect(laneA?.members.map((m) => m.id)).toEqual([1, 2]);
    expect(laneB?.members.map((m) => m.id)).toEqual([1, 2]);
    expect(derivation.lanes).toHaveLength(2);

    expect(derivation.warnings).toEqual([
      { citingId: 2, citedId: 1, tagSet: ["x"], citingSegment: "B", citedSegment: "A" },
    ]);
  });

  test("a same-segment tagged edge never warns and enumerates only once", () => {
    const turns = [design(1), design(2)];
    const edges = [edge(2, "extends", 1, ["y"])];
    const derivation = deriveLaneInterpretation(turns, edges);
    expect(derivation.warnings).toEqual([]);
    expect(derivation.lanes.filter((lane) => lane.key.tagSet.join("") === "y")).toHaveLength(1);
  });

  test("a cross-segment declaration (tagged indexes) is reduced identically on both sides", () => {
    const turns: LaneTurnInput[] = [
      { id: 10, type: ["design"], segment: "A" },
      { id: 11, type: ["design"], segment: "B" },
    ];
    const edges = [edge(11, "indexes", 10, ["z"])];
    const derivation = deriveLaneInterpretation(turns, edges);
    const laneA = laneOf(derivation, ["z"], "A");
    const laneB = laneOf(derivation, ["z"], "B");
    expect(laneA?.declaration).toEqual({ state: "declared", terminus: 11, latestEventTurn: 11 });
    expect(laneB?.declaration).toEqual({ state: "declared", terminus: 11, latestEventTurn: 11 });
  });
});

// ------------------------------------------------------------------------
// Lane-state helper (milestone-election spec, ticket 02): closed/open,
// valid/invalid, lastDeclarer — derived ADDITIVELY from the reduction above,
// never a second reduction pass.
// ------------------------------------------------------------------------

function stateOf(
  turns: readonly LaneTurnInput[],
  edges: readonly LaneEdgeInput[],
  tags: string[],
  segment: string = DEFAULT_SEGMENT,
) {
  const derivation = deriveLaneInterpretation(turns, edges);
  const states = deriveLaneStates(derivation.lanes, turns);
  return states.get(laneToken(segment, tags));
}

describe("lane-state helper — closed/open, valid/invalid, lastDeclarer", () => {
  test("the mutation-detecting property: a DECLARED lane that keeps living past its own declaration (a continuation, no re-declaration) reads OPEN here, even though the raw reduction still reports state 'declared' — 'closed' means the lane's LATEST node IS the terminus, not merely that a terminus currently exists", () => {
    const turns = [design(20), design(21), design(22)];
    const edges = [
      edge(21, "extends", 20, ["cont"]),
      edge(21, "indexes", 20, ["cont"]), // declares at 21
      edge(22, "extends", 21, ["cont"]), // continuation past the declaration
    ];
    // Sanity: the raw reduction (companion test above) reports this lane
    // "declared" with terminus 21 and latestEventTurn 22 — a naive helper
    // reading only `state === "declared"` would (wrongly) call this closed.
    const state = stateOf(turns, edges, ["cont"]);
    expect(state?.closure).toBe("open");
    expect(state?.validity).toBeNull();
    expect(state?.terminus).toBe(21);
    expect(state?.lastDeclarer).toBe(21); // still the only indexes writer
  });

  test("a lane reopened by a later override (terminus nulled) reads OPEN, and lastDeclarer recovers the pre-override winner declaration.terminus no longer names", () => {
    const turns = [design(101), design(102), design(103)];
    const edges = [
      edge(102, "extends", 101, ["x"]),
      edge(102, "indexes", 101, ["x"]),
      edge(103, "override", 102, ["x"]), // reopens
    ];
    const state = stateOf(turns, edges, ["x"]);
    expect(state?.closure).toBe("open");
    expect(state?.validity).toBeNull();
    expect(state?.terminus).toBeNull(); // the raw declaration.terminus is null...
    expect(state?.lastDeclarer).toBe(102); // ...but lastDeclarer still names 102
  });

  test("an undeclared lane (only structural continuation, no `indexes` ever) reads OPEN with lastDeclarer null — 'open, no declarer, no seat'", () => {
    const turns = [design(401), design(402), design(403)];
    const edges = [edge(402, "extends", 401, ["silent"]), edge(403, "extends", 402, ["silent"])];
    const state = stateOf(turns, edges, ["silent"]);
    expect(state?.closure).toBe("open");
    expect(state?.validity).toBeNull();
    expect(state?.terminus).toBeNull();
    expect(state?.lastDeclarer).toBeNull();
  });

  test("a plain closed lane with a living core reads CLOSED/valid, and lastDeclarer equals the terminus", () => {
    const turns = [design(30), design(31)];
    const edges = [edge(31, "extends", 30, ["v"]), edge(31, "indexes", 30, ["v"])];
    const state = stateOf(turns, edges, ["v"]);
    expect(state?.closure).toBe("closed");
    expect(state?.validity).toBe("valid");
    expect(state?.terminus).toBe(31);
    expect(state?.lastDeclarer).toBe(31);
  });

  test("the abandonment ritual — repudiate (kill the wrong conclusion), THEN declare closure indexing the now-dead core — reads CLOSED/invalid: the entire indexed core is dead", () => {
    const turns = [design(10), design(11), design(12), design(13)];
    const edges = [
      edge(11, "extends", 10, ["dead"]),
      edge(12, "override", 11, ["dead"]), // repudiate 11 first
      edge(13, "indexes", 11, ["dead"]), // then declare closure indexing the dead core
    ];
    const state = stateOf(turns, edges, ["dead"]);
    expect(state?.closure).toBe("closed");
    expect(state?.validity).toBe("invalid");
    expect(state?.terminus).toBe(13);
    expect(state?.lastDeclarer).toBe(13);
  });

  test("a closed lane's core with at least one living member alongside a dead one still reads valid — 'at least one living node' is the test, not 'all living'", () => {
    const turns = [design(40), design(41), design(42), design(43)];
    const edges = [
      edge(41, "extends", 40, ["mix"]),
      edge(42, "extends", 41, ["mix"]),
      edge(43, "override", 41, ["mix"]), // 41 dies in-lane, but is not the terminus
      edge(43, "indexes", 41, ["mix"]),
      edge(43, "indexes", 42, ["mix"]), // 42 (living) joins the declared core too
    ];
    const state = stateOf(turns, edges, ["mix"]);
    expect(state?.closure).toBe("closed");
    expect(state?.validity).toBe("valid");
  });
});
