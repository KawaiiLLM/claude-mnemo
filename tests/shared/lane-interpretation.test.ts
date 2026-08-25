import { describe, expect, test } from "bun:test";

import {
  compareOrderKeyAcrossSessions,
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
  tag: string,
  segment: string = DEFAULT_SEGMENT,
) {
  return derivation.laneByToken.get(laneToken(segment, tag));
}

describe("lane enumeration", () => {
  // REPLACES the old pin (v10) that {A}, {B}, {A,B} enumerate THREE
  // independent lanes, none unioned — lane-declaration spec Rev 2, D5: the
  // user ruled MERGE. A lane is now (segment, ONE tag), so {A,B} is not a
  // third lane at all; it is a second membership for the SAME lane A and the
  // SAME lane B the {A} and {B} rows already formed.
  test("coexisting untagged/{A}/{B}/{A,B} rows on one pair enumerate TWO lanes — A and B — with the {A,B} row a member of BOTH (the merge, D5)", () => {
    const turns = [design(1), design(2)];
    const edges = [
      edge(2, "extends", 1, []),
      edge(2, "extends", 1, ["A"]),
      edge(2, "extends", 1, ["B"]),
      edge(2, "extends", 1, ["A", "B"]),
    ];
    const derivation = deriveLaneInterpretation(turns, edges);
    expect(derivation.lanes.length).toBe(2);

    const laneA = laneOf(derivation, "A");
    const laneB = laneOf(derivation, "B");
    // Each lane's own tagged edges include BOTH its single-tag row and the
    // multi-tag {A,B} row — the {A,B} edge is one of lane A's own tagged
    // edges AND one of lane B's own tagged edges at once, not a third
    // lane's private fact.
    expect(laneA?.taggedEdges.length).toBe(2);
    expect(laneB?.taggedEdges.length).toBe(2);
    expect(laneA?.members.map((m) => m.id)).toEqual([1, 2]);
    expect(laneB?.members.map((m) => m.id)).toEqual([1, 2]);
  });

  // Lane-declaration ticket 12 (P1-7): the grouping loop keys on `edge.tags`
  // alone, never `edge.relation` — pinning this at the CORE interpretation
  // layer (independent of `lane-checker.ts`'s own reports) since it is the
  // foundation the checker's fix depends on, and no existing test named a
  // cross-phase relation at all before this ticket.
  test("a tagged CROSS-PHASE edge (grounds) enumerates and groups membership exactly like a tagged same-phase edge", () => {
    const turns = [design(1), design(2)];
    const edges = [edge(2, "grounds", 1, ["x"])];
    const derivation = deriveLaneInterpretation(turns, edges);
    const lane = laneOf(derivation, "x");
    expect(lane?.members.map((m) => m.id)).toEqual([1, 2]);
    expect(lane?.taggedEdges).toEqual([{ citingId: 2, citedId: 1, relation: "grounds", tags: ["x"] }]);
  });

  test("a tag set with no tagged edge never enumerates — untagged edges alone produce zero lanes", () => {
    const turns = [design(1), design(2), design(3)];
    const edges = [edge(2, "extends", 1), edge(3, "consume", 2)];
    const derivation = deriveLaneInterpretation(turns, edges);
    expect(derivation.lanes).toEqual([]);
  });
});

describe("event reduction — the override cases (v12: no node death)", () => {
  // lane-model-v12 ticket 04 deleted `LaneMember.dead` and, with it, both
  // ways a node used to die: the in-lane kill a TAGGED override wrote, and
  // the global repudiation an UNTAGGED one wrote. What a tagged override
  // still does is unseat the terminus it names; what an untagged one still
  // does is NOTHING at all in lane space.
  test("tagged override of the CURRENT terminus reopens the lane — and marks no node", () => {
    const turns = [design(101), design(102), design(103)];
    const edges = [
      edge(102, "extends", 101, ["x"]),
      edge(102, "indexes", 101, ["x"]),
      edge(103, "override", 102, ["x"]),
    ];
    const lane = laneOf(deriveLaneInterpretation(turns, edges), "x");
    expect(lane?.declaration).toEqual({ state: "reopened", terminus: null, latestEventTurn: 103 });
    // Every member is a plain `{ id }` — no status field survives on either
    // the override's target or anyone else.
    expect(lane?.members).toEqual([{ id: 101 }, { id: 102 }, { id: 103 }]);
  });

  // THE MERGE (lane-declaration spec Rev 2, D5) — pinned. Under the OLD
  // exact-set identity, `{a,b}` was a third, untouched lane, so lane `a`
  // stood undisturbed by an override naming `{a,b}`. Under the merge, an
  // override tagged with a SUPERSET of a lane's own tag still reaches that
  // lane and REOPENS it.
  test("the merge: an override tagged {a,b} reopens lane {a} it only partially names, and is simultaneously lane {b}'s own first event", () => {
    const turns = [design(1), design(2), design(3)];
    const edges = [
      edge(2, "indexes", 1, ["a"]), // T2 declares lane a, terminus = T2
      edge(3, "override", 2, ["a", "b"]), // multi-tag override
    ];
    const derivation = deriveLaneInterpretation(turns, edges);
    const laneA = laneOf(derivation, "a");
    const laneB = laneOf(derivation, "b");
    expect(laneA?.declaration).toEqual({ state: "reopened", terminus: null, latestEventTurn: 3 });
    // The identical row is simultaneously lane `b`'s own first-ever event —
    // an override touching a lane nobody had declared yet, which creates no
    // terminus to reopen FROM.
    expect(laneB?.declaration.state).toBe("undeclared");
    expect(laneB?.declaration.latestEventTurn).toBe(3);
  });

  // TICKET 04, THE DELETION ITSELF. An untagged override used to be the
  // rubric's GLOBAL REPUDIATION: it killed the cited turn in every lane and
  // unseated every terminus that turn held. v12 has no such thing — an
  // untagged edge is UNSETTLED, and rubric-v12 says an unsettled edge takes
  // no part in any connectivity, convergence or coupling computation.
  test("untagged override is inert in lane space — the lane it used to reopen stays CLOSED, and no node is marked", () => {
    const turns = [design(201), design(202), design(203), design(204)];
    const edges = [
      edge(202, "extends", 201, ["y"]),
      edge(202, "indexes", 201, ["y"]), // {y} declares, terminus 202
      edge(203, "override", 202, []), // untagged: formerly a global kill of 202
      edge(204, "extends", 202, ["z"]), // 202 is ALSO a {z} member
    ];
    const derivation = deriveLaneInterpretation(turns, edges);
    const laneY = laneOf(derivation, "y");
    const laneZ = laneOf(derivation, "z");
    // {y} keeps its terminus: the untagged override pushed no event at all,
    // so it did not even advance `latestEventTurn`.
    expect(laneY?.declaration).toEqual({ state: "declared", terminus: 202, latestEventTurn: 202 });
    expect(laneY?.members).toEqual([{ id: 201 }, { id: 202 }]);
    // {z} is untouched too, and 202 carries no status there either.
    expect(laneZ?.declaration).toEqual({ state: "undeclared", terminus: null, latestEventTurn: null });
    expect(laneZ?.members).toEqual([{ id: 202 }, { id: 204 }]);
  });

  test("an override tagged with a lane's OWN tag absent is indifferent — the untouched lane keeps its terminus", () => {
    const turns = [design(301), design(302), design(303)];
    const edges = [
      edge(302, "extends", 301, ["p"]),
      edge(302, "indexes", 301, ["p"]),
      edge(303, "override", 302, ["q"]), // a DIFFERENT lane's business entirely — no shared tag
    ];
    const derivation = deriveLaneInterpretation(turns, edges);
    const laneP = laneOf(derivation, "p");
    expect(laneP?.declaration).toEqual({ state: "declared", terminus: 302, latestEventTurn: 302 });
    // {q} itself auto-vivifies from this one tagged (override) edge — an
    // override CAN be a lane's sole tagged edge.
    const laneQ = laneOf(derivation, "q");
    expect(laneQ?.declaration.state).toBe("undeclared");
    expect(laneQ?.declaration.latestEventTurn).toBe(303);
  });

  test("a lane with no reduction event at all (pure continuation) is undeclared with latestEventTurn null — distinct from an override-touched-but-never-declared lane", () => {
    const turns = [design(401), design(402), design(403)];
    const edges = [edge(402, "extends", 401, ["silent"]), edge(403, "extends", 402, ["silent"])];
    const lane = laneOf(deriveLaneInterpretation(turns, edges), "silent");
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

    const lane = laneOf(deriveLaneInterpretation(turns, [e1, e2, e3, e4]), "m");
    // A reducer sorting by raw id (100 < 500 < 999) would process
    // citingId=100 BEFORE citingId=500, landing terminus=500 — the old,
    // wrong reading. Correct order-key reduction processes order=2 (id 500)
    // before order=3 (id 100), so 100's declaration wins.
    expect(lane?.declaration.terminus).toBe(100);
    expect(lane?.declaration.state).toBe("declared");

    // Sanity: shuffling the ARRAY order of the exact same edges agrees —
    // the result depends only on `order`, never on array position either.
    const reordered = [e4, e3, e2, e1];
    const laneReordered = laneOf(deriveLaneInterpretation(turns, reordered), "m");
    expect(laneReordered?.declaration.terminus).toBe(100);
  });

  test("with no explicit `order`, `id` is the order key — plain fixtures (id already in true order) are unaffected", () => {
    const turns = [design(401), design(402), design(403), design(404)];
    const e1 = edge(404, "indexes", 403, ["m"]); // latest declaration, turn 404
    const e2 = edge(402, "indexes", 401, ["m"]); // earlier declaration, turn 402
    const scrambled = [e1, e2]; // array order does not match id order either
    const lane = laneOf(deriveLaneInterpretation(turns, scrambled), "m");
    expect(lane?.declaration.terminus).toBe(404);
  });

  test("structural continuations advance latestEventTurn once a lane has been declared — silence does not, but living past a declaration does", () => {
    const turns = [design(20), design(21), design(22)];
    const edges = [
      edge(21, "extends", 20, ["cont"]),
      edge(21, "indexes", 20, ["cont"]), // declares at 21
      edge(22, "extends", 21, ["cont"]), // continuation past the declaration
    ];
    const lane = laneOf(deriveLaneInterpretation(turns, edges), "cont");
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
    const lane = laneOf(deriveLaneInterpretation(turns, edges), "c");
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
    const lane = laneOf(deriveLaneInterpretation([base, early, late], edges), "ord");
    // `late` (order [2,0]) must win regardless of array/id position — id 3 >
    // id 2 here too, so this alone would not distinguish a correct
    // lexicographic-tuple reducer from a buggy id-fallback one; the real
    // proof is the companion DB-adapter test where id order is INVERTED
    // relative to true (session, prompt) order.
    expect(lane?.declaration.terminus).toBe(3);
  });
});

describe("compareOrderKeyAcrossSessions — the tuple's session-id half never stands in for wall-clock time (pre-release repair R1 #6)", () => {
  test("cross-session pair: falls back to createdAtEpoch, ignoring order[0] entirely", () => {
    const earlierSessionLaterEpoch = { order: [1, 1] as const, createdAtEpoch: 200 };
    const laterSessionEarlierEpoch = { order: [2, 1] as const, createdAtEpoch: 100 };
    expect(
      compareOrderKeyAcrossSessions(earlierSessionLaterEpoch, laterSessionEarlierEpoch),
    ).toBeGreaterThan(0);
  });

  test("same-session pair: compares the tuple directly, epoch never consulted even when wildly different", () => {
    const a = { order: [1, 1] as const, createdAtEpoch: 999 };
    const b = { order: [1, 2] as const, createdAtEpoch: 1 };
    expect(compareOrderKeyAcrossSessions(a, b)).toBeLessThan(0);
  });

  test("cross-session pair with a missing epoch on either side: falls back to the tuple compare as a last resort (never silently equal)", () => {
    const withEpoch = { order: [1, 5] as const, createdAtEpoch: 100 };
    const withoutEpoch = { order: [2, 1] as const };
    expect(compareOrderKeyAcrossSessions(withEpoch, withoutEpoch)).toBeLessThan(0);
  });
});

describe("laneToken (D5, v11: segment + ONE tag) never collides two different (segment, tag) pairs", () => {
  // v10's own defect (round-5 review #14) was a delimiter JOIN across a tag
  // SET colliding with a differently-split set. D5 retires the tag SET from
  // a lane's identity entirely — `laneToken` now takes exactly ONE tag, so
  // there is no set left to split or join; a tag containing the OLD U+0001
  // join character is simply one ordinary tag string, nothing to collide.
  test("a tag containing the old U+0001 join character round-trips as an ordinary single tag, colliding with nothing", () => {
    const token = laneToken(DEFAULT_SEGMENT, "a\u0001b");
    expect(token).toBe(JSON.stringify([DEFAULT_SEGMENT, "a\u0001b"]));
  });

  test("a segment/tag pair never collides with a differently-split pair carrying the same two characters across the boundary", () => {
    // JSON.stringify's own per-element quoting marks the segment/tag
    // boundary regardless of what either string contains — there is no
    // separate delimiter left for a crafted string to imitate.
    const a = laneToken("ab", "c");
    const b = laneToken("a", "bc");
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

    const laneA = laneOf(derivation, "x", "A");
    const laneB = laneOf(derivation, "x", "B");
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
    expect(derivation.lanes.filter((lane) => lane.key.tag === "y")).toHaveLength(1);
  });

  test("a cross-segment declaration (tagged indexes) is reduced identically on both sides", () => {
    const turns: LaneTurnInput[] = [
      { id: 10, type: ["design"], segment: "A" },
      { id: 11, type: ["design"], segment: "B" },
    ];
    const edges = [edge(11, "indexes", 10, ["z"])];
    const derivation = deriveLaneInterpretation(turns, edges);
    const laneA = laneOf(derivation, "z", "A");
    const laneB = laneOf(derivation, "z", "B");
    expect(laneA?.declaration).toEqual({ state: "declared", terminus: 11, latestEventTurn: 11 });
    expect(laneB?.declaration).toEqual({ state: "declared", terminus: 11, latestEventTurn: 11 });
  });
});

// ------------------------------------------------------------------------
// Lane-state helper (milestone-election spec, ticket 02): closed/open —
// derived ADDITIVELY from the reduction above, never a second reduction pass.
// lane-model-v12 ticket 04 deleted this helper's two other outputs — the
// per-lane validity verdict and an open lane's most-recent-declarer — along
// with the concepts they read.
// ------------------------------------------------------------------------

function stateOf(
  turns: readonly LaneTurnInput[],
  edges: readonly LaneEdgeInput[],
  tag: string,
  segment: string = DEFAULT_SEGMENT,
) {
  const derivation = deriveLaneInterpretation(turns, edges);
  const states = deriveLaneStates(derivation.lanes);
  return states.get(laneToken(segment, tag));
}

describe("lane-state helper — closed/open (v12: the only two states)", () => {
  test("the mutation-detecting property: a DECLARED lane that keeps living past its own declaration (a continuation, no re-declaration) reads OPEN here, even though the raw reduction still reports state 'declared' — 'closed' means the lane's LATEST node IS the terminus, not merely that a terminus currently exists", () => {
    const turns = [design(20), design(21), design(22)];
    const edges = [
      edge(21, "extends", 20, ["cont"]),
      edge(21, "indexes", 20, ["cont"]), // declares at 21
      edge(22, "extends", 21, ["cont"]), // continuation past the declaration
    ];
    const state = stateOf(turns, edges, "cont");
    expect(state?.closure).toBe("open");
    expect(state?.terminus).toBe(21);
  });

  test("a lane reopened by a later override (terminus nulled) reads OPEN", () => {
    const turns = [design(101), design(102), design(103)];
    const edges = [
      edge(102, "extends", 101, ["x"]),
      edge(102, "indexes", 101, ["x"]),
      edge(103, "override", 102, ["x"]), // reopens
    ];
    const state = stateOf(turns, edges, "x");
    expect(state?.closure).toBe("open");
    expect(state?.terminus).toBeNull();
  });

  test("an undeclared lane (only structural continuation, no `indexes` ever) reads OPEN", () => {
    const turns = [design(401), design(402), design(403)];
    const edges = [edge(402, "extends", 401, ["silent"]), edge(403, "extends", 402, ["silent"])];
    const state = stateOf(turns, edges, "silent");
    expect(state?.closure).toBe("open");
    expect(state?.terminus).toBeNull();
  });

  test("a plain closed lane reads CLOSED with its terminus", () => {
    const turns = [design(30), design(31)];
    const edges = [edge(31, "extends", 30, ["v"]), edge(31, "indexes", 30, ["v"])];
    const state = stateOf(turns, edges, "v");
    expect(state?.closure).toBe("closed");
    expect(state?.terminus).toBe(31);
  });

  // TICKET 04, THE DELETION, PINNED AT THE STATE'S OWN SHAPE. The old
  // abandonment ritual — override the wrong conclusion, THEN declare closure
  // indexing the now-overridden core — used to read "closed-INVALID" and seat
  // nobody in the election. There is no validity axis for it to fail on any
  // more: the lane is simply CLOSED. And an open lane no longer reports who
  // declared it last. The key list is the sentinel: a state object with a
  // fourth field would fail here whatever that field were named.
  test("a lane state carries exactly two fields beyond its key — no validity verdict, no most-recent-declarer seat", () => {
    const turns = [design(10), design(11), design(12), design(13)];
    const edges = [
      edge(11, "extends", 10, ["dead-core"]),
      edge(12, "override", 11, ["dead-core"]), // the old "repudiate first" move
      edge(13, "indexes", 11, ["dead-core"]), // then declare closure over it
    ];
    const state = stateOf(turns, edges, "dead-core");
    expect(state?.closure).toBe("closed");
    expect(state?.terminus).toBe(13);
    expect(Object.keys(state!).sort()).toEqual(["closure", "key", "terminus"]);
  });
});
