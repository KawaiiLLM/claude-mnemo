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
import { laneEdge } from "../support/lane-edge-fixtures";

/**
 * A turn, and THE lanes it belongs to (lane-model-v12 ticket 10):
 * `design(2, "x")` is turn 2 claiming lane `x` in its own tags. Membership
 * comes from here and nowhere else — an edge no longer makes a member, so a
 * fixture that names a tag on an edge and not on its endpoints is asserting
 * something quite different from what the same fixture asserted under v11.
 */
const design = (id: number, ...laneTags: string[]): LaneTurnInput => ({
  id,
  type: ["design"],
  laneTags,
});
const edge = (
  citingId: number,
  relation: string,
  citedId: number,
  tags: string[] = [],
  sides?: { tailTag: string; headTag: string },
): LaneEdgeInput =>
  laneEdge({ citingId, relation, citedId, tags, ...(sides ?? {}) });

function laneOf(
  derivation: ReturnType<typeof deriveLaneInterpretation>,
  tag: string,
  segment: string = DEFAULT_SEGMENT,
) {
  return derivation.laneByToken.get(laneToken(segment, tag));
}

// ------------------------------------------------------------------------
// MEMBERSHIP COMES FROM THE NODE'S OWN TAGS (lane-model-v12 D5, ticket 10).
// This block is the replacement itself: what enumerates a lane, what joins
// one, and the counter-example the ticket is built on.
// ------------------------------------------------------------------------

describe("membership is a NODE fact — the source of enumeration (ticket 10)", () => {
  // THE MUTATION SENTINEL for the enumeration source. Under v11 this input
  // produced lane `x` with members [1, 2] — enumerated from the endpoints of
  // the tagged edge. A lane is a set of members, and an edge is not a member:
  // with no node claiming `x`, there is no lane `x` for the edge to join.
  test("an edge naming a lane NO node claims enumerates nothing — the edge joins no lane at all", () => {
    const turns = [design(1), design(2)];
    const derivation = deriveLaneInterpretation(turns, [edge(2, "extends", 1, ["x"])]);
    expect(derivation.lanes).toEqual([]);
  });

  test("one turn's own tag is enough to enumerate the lane — with no edge anywhere", () => {
    const derivation = deriveLaneInterpretation([design(1, "x")], []);
    const lane = laneOf(derivation, "x");
    expect(lane?.members).toEqual([{ id: 1 }]);
    expect(lane?.taggedEdges).toEqual([]);
    expect(lane?.latestMember).toBe(1);
  });

  // The two halves are independent: a turn claims the lane, an edge is
  // attributed to it. A member that no edge touches is still a member.
  test("a member that carries the tag and has NO edge sits in `members` beside the wired-up ones", () => {
    const turns = [design(1, "x"), design(2, "x"), design(3, "x")];
    const lane = laneOf(deriveLaneInterpretation(turns, [edge(2, "extends", 1, ["x"])]), "x");
    expect(lane?.members.map((m) => m.id)).toEqual([1, 2, 3]);
    expect(lane?.taggedEdges).toHaveLength(1);
    expect(lane?.latestMember).toBe(3);
  });

  // The inverse of the rule, kept explicit: an edge's tag does not confer
  // membership on its endpoints. (`lane-checker.ts`'s E4 is what reports this
  // shape; the interpretation core simply does not invent the member.)
  test("an edge tagged for a lane does NOT make its endpoints members — only their own tags do", () => {
    const turns = [design(1, "x"), design(2)];
    const lane = laneOf(deriveLaneInterpretation(turns, [edge(2, "extends", 1, ["x"])]), "x");
    expect(lane?.members).toEqual([{ id: 1 }]);
    // Still ATTRIBUTED to the lane — attribution and membership are two
    // questions, and this edge answers only the first.
    expect(lane?.taggedEdges).toHaveLength(1);
  });

  // v12 D3: a freshly declared lane may hold 0 or 1 members, declaration
  // fixes no timepoint, and the connectivity principle does not apply to it.
  // A 1-member provisional lane is a lane like any other and reports no
  // defect of any kind here; a 0-member one is not enumerated at all (it
  // lives in the `lanes` REGISTRY, which this pure module never reads —
  // `lane-checker.ts`'s `LaneSegmentFacts.emptyLaneTags` is where it shows).
  test("a PROVISIONAL lane is legal: one member, no edge, no defect — and a zero-member one simply does not enumerate", () => {
    const derivation = deriveLaneInterpretation([design(1, "fresh"), design(2)], []);
    expect(derivation.lanes).toHaveLength(1);
    const lane = laneOf(derivation, "fresh");
    expect(lane?.members).toEqual([{ id: 1 }]);
    expect(lane?.declaration).toEqual({ state: "undeclared", terminus: null });
    expect(derivation.warnings).toEqual([]);
    // The zero-member case: nobody claims `unused`, so no lane object exists
    // to carry a verdict about — never an enumerated lane with no members.
    expect(laneOf(derivation, "unused")).toBeUndefined();
  });
});

describe("lane enumeration", () => {
  // The v10 pin was "{A}, {B}, {A,B} are THREE independent lanes"; v11's
  // MERGE made {A,B} a second membership of A and of B. lane-model-v12 D1
  // retires the question: an edge carries ONE tag PER SIDE, so no row can
  // name two lanes as a member of both. What CAN coexist on one pair is the
  // shape below — the identity key is (citing, cited, relation, tail, head),
  // so an unsettled row, an A-internal row, a B-internal row and a CROSS-LANE
  // A->B row are four distinct rows, and only two lanes come out.
  test("coexisting unsettled/{A}/{B}/cross-lane rows on one pair enumerate TWO lanes — and the cross-lane row joins NEITHER", () => {
    const turns = [design(1, "A", "B"), design(2, "A", "B")];
    const edges = [
      edge(2, "extends", 1, []),
      edge(2, "extends", 1, ["A"]),
      edge(2, "extends", 1, ["B"]),
      edge(2, "extends", 1, [], { tailTag: "A", headTag: "B" }),
    ];
    const derivation = deriveLaneInterpretation(turns, edges);
    expect(derivation.lanes.length).toBe(2);

    const laneA = laneOf(derivation, "A");
    const laneB = laneOf(derivation, "B");
    // ONE claiming edge each: its own internal row. The cross-lane row NAMES
    // both lanes and is INTERNAL to neither — it is the A<->B coupling, not
    // a membership, so it appears in no lane's own edge list.
    expect(laneA?.taggedEdges.length).toBe(1);
    expect(laneB?.taggedEdges.length).toBe(1);
    expect(laneA?.taggedEdges[0]?.headTag).toBe("A");
    expect(laneB?.taggedEdges[0]?.tailTag).toBe("B");
    expect(laneA?.members.map((m) => m.id)).toEqual([1, 2]);
    expect(laneB?.members.map((m) => m.id)).toEqual([1, 2]);
  });

  // The attribution half of the same rule, isolated — and retargeted by
  // ticket 10. Both lanes here genuinely exist (each endpoint claims its own
  // in its own tags), so this is no longer a statement about enumeration at
  // all: it is that the crossing is INTERNAL to neither lane. Before ticket
  // 10 the same fixture proved it by the lanes not existing, which proved
  // rather less.
  test("a cross-lane edge joins NEITHER lane's own edge list, even when both lanes exist", () => {
    const turns = [design(1, "B"), design(2, "A")];
    const derivation = deriveLaneInterpretation(turns, [
      edge(2, "extends", 1, [], { tailTag: "A", headTag: "B" }),
    ]);
    expect(derivation.lanes).toHaveLength(2);
    expect(laneOf(derivation, "A")?.members).toEqual([{ id: 2 }]);
    expect(laneOf(derivation, "B")?.members).toEqual([{ id: 1 }]);
    expect(laneOf(derivation, "A")?.taggedEdges).toEqual([]);
    expect(laneOf(derivation, "B")?.taggedEdges).toEqual([]);
  });

  // Lane-declaration ticket 12 (P1-7): the grouping loop keys on the edge's
  // LANES alone, never `edge.relation` — pinning this at the CORE interpretation
  // layer (independent of `lane-checker.ts`'s own reports) since it is the
  // foundation the checker's fix depends on, and no existing test named a
  // cross-phase relation at all before this ticket.
  test("a tagged CROSS-PHASE edge (grounds) is attributed exactly like a tagged same-phase edge", () => {
    const turns = [design(1, "x"), design(2, "x")];
    const edges = [edge(2, "grounds", 1, ["x"])];
    const derivation = deriveLaneInterpretation(turns, edges);
    const lane = laneOf(derivation, "x");
    expect(lane?.members.map((m) => m.id)).toEqual([1, 2]);
    // ONE tag surface since ticket 09: the two SIDE tags, which a same-lane
    // edge repeats on both ends (lane-model-v12 D1).
    expect(lane?.taggedEdges).toEqual([
      { citingId: 2, citedId: 1, relation: "grounds", tailTag: "x", headTag: "x" },
    ]);
  });

  // THE BACKSTOP `settledSide` exists for. `tsconfig.json` excludes `tests/`,
  // so an object literal that predates ticket 07's two REQUIRED side fields
  // still compiles and still runs — and left raw, `undefined === undefined`
  // would make both sides compare EQUAL and mint a lane whose tag is
  // `undefined`, silently. Normalized, such a row is simply unsettled: no
  // lane, and the stale fixture's own assertions go red instead.
  test("an edge object built WITHOUT the two side fields joins NO lane — never a lane named `undefined`", () => {
    const stale = {
      citingId: 2,
      citedId: 1,
      tags: ["x"],
      relation: "extends",
    } as unknown as LaneEdgeInput;
    // The lane genuinely exists here (both turns claim it), so a stale edge
    // read as `tail === head === undefined` would have a real group to fall
    // into — which is exactly what makes the backstop observable.
    const derivation = deriveLaneInterpretation([design(1, "x"), design(2, "x")], [stale]);
    expect(derivation.lanes).toHaveLength(1);
    expect(laneOf(derivation, "x")?.taggedEdges).toEqual([]);
    expect(derivation.warnings).toEqual([]);
  });

  test("untagged edges alone produce zero lanes", () => {
    const turns = [design(1), design(2), design(3)];
    const edges = [edge(2, "extends", 1), edge(3, "consume", 2)];
    const derivation = deriveLaneInterpretation(turns, edges);
    expect(derivation.lanes).toEqual([]);
  });
});

describe("event reduction — the override cases (v12: override writes NO declaration state)", () => {
  // lane-model-v12 ticket 04 deleted `LaneMember.dead` and, with it, both ways
  // a node used to die. The peer's cross-review of the v12 batch found the
  // half that survived: an in-lane `override` citing the terminus still
  // CLEARED it (`terminusOf.set(token, null)`), which `deriveLaneStates` then
  // read as open. That is a lane REOPENING driven by `override`, and
  // rubric-v12's concepts text refuses it twice — 「七个词里只有 index 参与
  // open / closed 的判定」, and the other six 「也不改变任何 lane 的状态」.
  //
  // THE INVERSION. This test asserted `{ state: "reopened", terminus: null }`
  // under v11 and asserts the terminus INTACT now. Both halves of the old
  // expectation were v11: the third declaration state, and the cleared
  // terminus that was the only way to reach it.
  test("an in-lane override of the CURRENT terminus leaves the declared terminus INTACT — only `indexes` writes declaration state", () => {
    const turns = [design(101, "x"), design(102, "x"), design(103, "x")];
    const edges = [
      edge(102, "extends", 101, ["x"]),
      edge(102, "indexes", 101, ["x"]),
      edge(103, "override", 102, ["x"]),
    ];
    const lane = laneOf(deriveLaneInterpretation(turns, edges), "x");
    expect(lane?.declaration).toEqual({ state: "declared", terminus: 102 });
    // Every member is a plain `{ id }` — no status field survives on either
    // the override's target or anyone else.
    expect(lane?.members).toEqual([{ id: 101 }, { id: 102 }, { id: 103 }]);
  });

  // THE MECHANISM DOING THE DELETED SPECIAL CASE'S WORK, at the core layer
  // (the closure half is pinned in the state-helper block below). T103 wrote
  // the override, so T103 carries the lane's tag, so T103 — not the terminus —
  // is the lane's newest member. Nothing had to clear anything.
  test("the overriding turn is the lane's LATEST MEMBER, which is what makes the lane open — no terminus clearing needed", () => {
    const turns = [design(101, "x"), design(102, "x"), design(103, "x")];
    const edges = [edge(102, "indexes", 101, ["x"]), edge(103, "override", 102, ["x"])];
    const lane = laneOf(deriveLaneInterpretation(turns, edges), "x");
    expect(lane?.latestMember).toBe(103);
    expect(lane?.declaration.terminus).toBe(102);
  });

  // THE SHARP DISCRIMINATOR between the two readings, and the reason the
  // deleted special case was not merely redundant but WRONG. Here the citing
  // side of the override names lane {x} while T103's own tags do not (the
  // inconsistency `lane-checker.ts`'s E4 reports), so T103 is not a member and
  // T102 is still the latest one. v11 nulled the terminus and called the lane
  // open; v12 leaves the declaration standing and the lane CLOSED — an edge
  // written by a non-member never joined the lane and cannot converge or
  // un-converge it.
  test("an override whose CITING turn does not carry the lane's tag leaves the lane CLOSED — a non-member moves nothing", () => {
    const turns = [design(101, "x"), design(102, "x"), design(103)];
    const edges = [edge(102, "indexes", 101, ["x"]), edge(103, "override", 102, ["x"])];
    const derivation = deriveLaneInterpretation(turns, edges);
    const lane = laneOf(derivation, "x");
    expect(lane?.members).toEqual([{ id: 101 }, { id: 102 }]);
    expect(lane?.declaration).toEqual({ state: "declared", terminus: 102 });
    expect(deriveLaneStates(derivation.lanes).get(laneToken(DEFAULT_SEGMENT, "x"))?.closure).toBe(
      "closed",
    );
  });

  // v11's MERGE let ONE multi-tag override act in every lane its set named.
  // v12 D1 has no multi-tag row (spec M-A splits each into one row per tag),
  // so the same intent is TWO rows on the same pair and relation — distinct
  // rows under the identity key. What each row does is now the same NOTHING,
  // which is what makes the per-lane outcome trivially lossless.
  test("a many-lane override is TWO rows (spec M-A) and NEITHER writes declaration state — {a} keeps its terminus, {b} stays undeclared", () => {
    const turns = [design(1, "a"), design(2, "a"), design(3, "a", "b")];
    const edges = [
      edge(2, "indexes", 1, ["a"]), // T2 declares lane a, terminus = T2
      edge(3, "override", 2, ["a"]),
      edge(3, "override", 2, ["b"]),
    ];
    const derivation = deriveLaneInterpretation(turns, edges);
    const laneA = laneOf(derivation, "a");
    const laneB = laneOf(derivation, "b");
    // v11 asserted `{ state: "reopened", terminus: null }` here.
    expect(laneA?.declaration).toEqual({ state: "declared", terminus: 2 });
    // T3 carries {a}, so lane a reads OPEN anyway — the correction is visible
    // as membership, not as a lost declaration.
    expect(laneA?.latestMember).toBe(3);
    // Lane `b` was never declared and an override does not declare it.
    expect(laneB?.declaration).toEqual({ state: "undeclared", terminus: null });
  });

  // The v12 shape v11 could not write, and the rule that governs it: an
  // override whose two ends name DIFFERENT lanes moves NEITHER terminus.
  // Closure is convergence, and an edge that establishes no connectivity
  // cannot establish convergence — the same predicate the grouping loop uses.
  test("a CROSS-LANE override unseats nothing — the lane it points at keeps its terminus, and the lane it points from is untouched", () => {
    const turns = [design(1, "a"), design(2, "a", "b"), design(3, "b")];
    const edges = [
      edge(2, "indexes", 1, ["a"]), // lane a declared, terminus = T2
      edge(3, "extends", 2, ["b"]),
      edge(3, "indexes", 2, ["b"]), // lane b declared, terminus = T3
      edge(3, "override", 2, [], { tailTag: "b", headTag: "a" }),
    ];
    const derivation = deriveLaneInterpretation(turns, edges);
    expect(laneOf(derivation, "a")?.declaration).toEqual({
      state: "declared",
      terminus: 2,
    });
    expect(laneOf(derivation, "b")?.declaration.terminus).toBe(3);
    // …and it is a member of neither lane's own edge list.
    expect(laneOf(derivation, "a")?.taggedEdges).toHaveLength(1);
    expect(laneOf(derivation, "b")?.taggedEdges).toHaveLength(2);
  });

  // TICKET 04, THE DELETION ITSELF. An untagged override used to be the
  // rubric's GLOBAL REPUDIATION: it killed the cited turn in every lane and
  // unseated every terminus that turn held. v12 has no such thing — an
  // untagged edge is UNSETTLED, and rubric-v12 says an unsettled edge takes
  // no part in any connectivity, convergence or coupling computation.
  test("untagged override is inert in lane space — the lane it used to reopen stays CLOSED, and no node is marked", () => {
    const turns = [design(201, "y"), design(202, "y", "z"), design(203), design(204, "z")];
    const edges = [
      edge(202, "extends", 201, ["y"]),
      edge(202, "indexes", 201, ["y"]), // {y} declares, terminus 202
      edge(203, "override", 202, []), // untagged: formerly a global kill of 202
      edge(204, "extends", 202, ["z"]), // 202 is ALSO a {z} member
    ];
    const derivation = deriveLaneInterpretation(turns, edges);
    const laneY = laneOf(derivation, "y");
    const laneZ = laneOf(derivation, "z");
    // {y} keeps its terminus AND stays closed: 202 is still its latest member
    // (203 carries no lane tag), and the untagged override pushed no event.
    expect(laneY?.declaration).toEqual({ state: "declared", terminus: 202 });
    expect(laneY?.latestMember).toBe(202);
    expect(laneY?.members).toEqual([{ id: 201 }, { id: 202 }]);
    // {z} is untouched too, and 202 carries no status there either.
    expect(laneZ?.declaration).toEqual({ state: "undeclared", terminus: null });
    expect(laneZ?.members).toEqual([{ id: 202 }, { id: 204 }]);
  });

  test("an override tagged with a lane's OWN tag absent is indifferent — the untouched lane keeps its terminus", () => {
    const turns = [design(301, "p"), design(302, "p"), design(303, "q")];
    const edges = [
      edge(302, "extends", 301, ["p"]),
      edge(302, "indexes", 301, ["p"]),
      edge(303, "override", 302, ["q"]), // a DIFFERENT lane's business entirely — no shared tag
    ];
    const derivation = deriveLaneInterpretation(turns, edges);
    const laneP = laneOf(derivation, "p");
    expect(laneP?.declaration).toEqual({ state: "declared", terminus: 302 });
    // {q} itself enumerates from T303's own tag; its one tagged edge being an
    // override declares nothing.
    const laneQ = laneOf(derivation, "q");
    expect(laneQ?.declaration).toEqual({ state: "undeclared", terminus: null });
    expect(laneQ?.taggedEdges).toHaveLength(1);
  });

  // v11 distinguished TWO undeclared sub-cases through `latestEventTurn`
  // (`null` = nothing ever touched the lane; a turn id = an override touched
  // it without declaring it). With override writing no state, the two cases
  // are one: undeclared is undeclared. The FIELD is deleted with the
  // distinction, and this test now pins the object's whole key list — a third
  // key here is how the deleted edge-activity fact comes back.
  test("declaration carries exactly two keys — a lane with no declaration is `{ undeclared, null }` and nothing more", () => {
    const turns = [design(401, "silent"), design(402, "silent"), design(403, "silent")];
    const edges = [edge(402, "extends", 401, ["silent"]), edge(403, "extends", 402, ["silent"])];
    const lane = laneOf(deriveLaneInterpretation(turns, edges), "silent");
    expect(lane?.declaration).toEqual({ state: "undeclared", terminus: null });
    expect(Object.keys(lane!.declaration).sort()).toEqual(["state", "terminus"]);
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
    const earlyBackfilled: LaneTurnInput = { id: 999, type: ["design"], laneTags: ["m"], order: [0, 1] }; // true order 1st, but the LARGEST id
    const middle: LaneTurnInput = { id: 500, type: ["design"], laneTags: ["m"], order: [0, 2] };
    const late: LaneTurnInput = { id: 100, type: ["design"], laneTags: ["m"], order: [0, 3] }; // true order 3rd (latest), but the SMALLEST id
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
    const turns = [design(401, "m"), design(402, "m"), design(403, "m"), design(404, "m")];
    const e1 = edge(404, "indexes", 403, ["m"]); // latest declaration, turn 404
    const e2 = edge(402, "indexes", 401, ["m"]); // earlier declaration, turn 402
    const scrambled = [e1, e2]; // array order does not match id order either
    const lane = laneOf(deriveLaneInterpretation(turns, scrambled), "m");
    expect(lane?.declaration.terminus).toBe(404);
  });

  // v11 had this fixture prove that a continuation advanced the lane's
  // freshest-EDGE-activity field while leaving the terminus alone. That field
  // is deleted, so what survives is the half that still matters: a lane living
  // past its declaration moves its LATEST MEMBER and not its terminus — the
  // two facts closure compares.
  test("a continuation past a declaration moves the latest MEMBER and never the terminus", () => {
    const turns = [design(20, "cont"), design(21, "cont"), design(22, "cont")];
    const edges = [
      edge(21, "extends", 20, ["cont"]),
      edge(21, "indexes", 20, ["cont"]), // declares at 21
      edge(22, "extends", 21, ["cont"]), // continuation past the declaration
    ];
    const lane = laneOf(deriveLaneInterpretation(turns, edges), "cont");
    expect(lane?.declaration.terminus).toBe(21); // continuation never moves the terminus
    expect(lane?.latestMember).toBe(22); // …but the lane has visibly lived on
  });

  test("continuation after a declaration does not retroactively move it — only a NEW indexes event does", () => {
    const turns = [design(501, "c"), design(502, "c"), design(503, "c")];
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
    const base: LaneTurnInput = { id: 1, type: ["design"], laneTags: ["ord"] };
    // Major=1 with an enormous minor vs major=2 with a minor of 0 — a scalar
    // encoding with any fixed span collides or misorders pairs like this;
    // lexicographic tuple compare never does, regardless of magnitude.
    const early: LaneTurnInput = { id: 2, type: ["design"], laneTags: ["ord"], order: [1, 100_000_000] };
    const late: LaneTurnInput = { id: 3, type: ["design"], laneTags: ["ord"], order: [2, 0] };
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

// RETARGETED by lane-model-v12 ticket 06. These tests used to pin DUAL
// APPEARANCE: a cross-segment edge carrying tag `x` registered in BOTH
// segments' copies of lane `x`, with identical members and an identically
// reduced declaration on each side. That behaviour is GONE, and the rule
// that replaced it is the one these tests now pin:
//
//   a lane's identity is the PAIR `(segment, tag)`, so the same literal word
//   in two segments is TWO lanes — and an edge whose ends sit in different
//   segments therefore points FROM one lane TO another. It is a CROSS-LANE
//   edge and claims NEITHER: no membership, no terminus, no connectivity.
//   The `warnings` entry is the only trace it leaves, which is why the
//   warning is now load-bearing rather than a duplicate of the dual
//   registration.
//
// Production measurement at the switch: 1 such edge among 507 tagged ones.
describe("cross-segment edges — a crossing between two lanes, warned and unregistered (v12 ticket 06)", () => {
  test("a cross-segment edge carrying ONE literal tag registers in NEITHER segment's lane, and is named in `warnings`", () => {
    // Both turns CLAIM the word in their own tags, so both lanes exist —
    // (A,"x") and (B,"x"), two lanes, one member each (ticket 10 sharpened
    // this fixture: it used to prove the rule by neither lane existing).
    const turns: LaneTurnInput[] = [
      { id: 1, type: ["design"], segment: "A", laneTags: ["x"] },
      { id: 2, type: ["design"], segment: "B", laneTags: ["x"] },
    ];
    const edges = [edge(2, "extends", 1, ["x"])]; // citing turn 2 in segment B cites turn 1 in segment A
    const derivation = deriveLaneInterpretation(turns, edges);

    // The edge names both and joins NEITHER: identity is the PAIR, so the
    // same literal word in two segments is two lanes and this edge crosses
    // between them.
    expect(laneOf(derivation, "x", "A")?.members).toEqual([{ id: 1 }]);
    expect(laneOf(derivation, "x", "B")?.members).toEqual([{ id: 2 }]);
    expect(laneOf(derivation, "x", "A")?.taggedEdges).toEqual([]);
    expect(laneOf(derivation, "x", "B")?.taggedEdges).toEqual([]);

    // The fact survives HERE, and only here.
    expect(derivation.warnings).toEqual([
      { citingId: 2, citedId: 1, tagSet: ["x"], citingSegment: "B", citedSegment: "A" },
    ]);
  });

  test("a same-segment tagged edge never warns and enumerates exactly one lane", () => {
    const turns = [design(1, "y"), design(2, "y")];
    const edges = [edge(2, "extends", 1, ["y"])];
    const derivation = deriveLaneInterpretation(turns, edges);
    expect(derivation.warnings).toEqual([]);
    expect(derivation.lanes.filter((lane) => lane.key.tag === "y")).toHaveLength(1);
  });

  test("a cross-segment declaration (indexes) declares NO lane — a terminus needs a lane to be the terminus OF", () => {
    const turns: LaneTurnInput[] = [
      { id: 10, type: ["design"], segment: "A", laneTags: ["z"] },
      { id: 11, type: ["design"], segment: "B", laneTags: ["z"] },
    ];
    const edges = [edge(11, "indexes", 10, ["z"])];
    const derivation = deriveLaneInterpretation(turns, edges);
    // Both lanes exist (each turn claims the word where it lives) and NEITHER
    // is declared: the crossing declares no terminus in either direction.
    expect(laneOf(derivation, "z", "A")?.declaration.terminus).toBeNull();
    expect(laneOf(derivation, "z", "B")?.declaration.terminus).toBeNull();
    expect(derivation.warnings).toHaveLength(1);
  });

  test("the SEGMENT half of the identity is load-bearing: the same two turns in ONE segment DO form the lane", () => {
    // The control for the two tests above — identical edge, identical tag,
    // only the cited turn's segment differs. If the grouping ever dropped the
    // segment from the claim test, this pair and the pair above would produce
    // the SAME answer and neither test would mean anything.
    const turns: LaneTurnInput[] = [
      { id: 1, type: ["design"], segment: "A", laneTags: ["x"] },
      { id: 2, type: ["design"], segment: "A", laneTags: ["x"] },
    ];
    const derivation = deriveLaneInterpretation(turns, [edge(2, "extends", 1, ["x"])]);
    expect(laneOf(derivation, "x", "A")?.members.map((m) => m.id)).toEqual([1, 2]);
    // ONE lane, and the edge is INTERNAL to it — the control that the segment
    // half of the claim test is doing real work above.
    expect(laneOf(derivation, "x", "A")?.taggedEdges).toHaveLength(1);
    expect(derivation.warnings).toEqual([]);
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
    const turns = [design(20, "cont"), design(21, "cont"), design(22, "cont")];
    const edges = [
      edge(21, "extends", 20, ["cont"]),
      edge(21, "indexes", 20, ["cont"]), // declares at 21
      edge(22, "extends", 21, ["cont"]), // continuation past the declaration
    ];
    const state = stateOf(turns, edges, "cont");
    expect(state?.closure).toBe("open");
    expect(state?.terminus).toBe(21);
  });

  // THE ACCEPTANCE PAIR'S CLOSURE HALF (peer cross-review A1). v11 asserted
  // `terminus: null` here — the lane was open BECAUSE the override had cleared
  // the declaration. v12 has no clearing: the lane is open because T103, the
  // overriding turn, carries {x} and is therefore a newer member than the
  // terminus. Same verdict, different mechanism, and the terminus survives as
  // the historical fact it always was. A mutation that restores the clearing
  // reddens the `terminus` assertion; a mutation that reads closure off
  // anything but `latestMember` reddens the `closure` one.
  test("an in-lane override of the terminus leaves the lane OPEN with its terminus still named — the newer MEMBER is the whole mechanism", () => {
    const turns = [design(101, "x"), design(102, "x"), design(103, "x")];
    const edges = [
      edge(102, "extends", 101, ["x"]),
      edge(102, "indexes", 101, ["x"]),
      edge(103, "override", 102, ["x"]),
    ];
    const state = stateOf(turns, edges, "x");
    expect(state?.closure).toBe("open");
    expect(state?.terminus).toBe(102);
  });

  test("an undeclared lane (only structural continuation, no `indexes` ever) reads OPEN", () => {
    const turns = [design(401, "silent"), design(402, "silent"), design(403, "silent")];
    const edges = [edge(402, "extends", 401, ["silent"]), edge(403, "extends", 402, ["silent"])];
    const state = stateOf(turns, edges, "silent");
    expect(state?.closure).toBe("open");
    expect(state?.terminus).toBeNull();
  });

  test("a plain closed lane reads CLOSED with its terminus", () => {
    const turns = [design(30, "v"), design(31, "v")];
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
    const turns = [design(10, "dead-core"), design(11, "dead-core"), design(12, "dead-core"), design(13, "dead-core")];
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

  // ----------------------------------------------------------------------
  // TICKET 10's OWN COUNTER-EXAMPLE, verbatim from the ticket: "T1/T2 属于
  // lane L 且 T2 index→T1,T3 也属于 L 但还没有边 —— 新模型说 L 是 open,现
  // 投影看不见 T3,仍判 closed."
  //
  // This pair is the mutation sentinel for BOTH halves of the change. Restore
  // edge-derived membership and T3 leaves the lane; restore
  // `terminus === latestEventTurn` as the closure test and T3 stops counting
  // even while it is a member. Either mutation lands "closed" here.
  // ----------------------------------------------------------------------
  test("ticket 10 counter-example: a member that carries the tag and has NO edge keeps the lane OPEN", () => {
    const turns = [design(1, "L"), design(2, "L"), design(3, "L")];
    const edges = [edge(2, "indexes", 1, ["L"])];
    const state = stateOf(turns, edges, "L");
    expect(state?.closure).toBe("open");
    // The declaration itself is untouched — T2 is still the terminus. What
    // moved is the LATEST MEMBER, and closure reads that.
    expect(state?.terminus).toBe(2);
  });

  test("ticket 10 counter-example, the control: with T3 absent the identical lane is CLOSED", () => {
    const turns = [design(1, "L"), design(2, "L")];
    const edges = [edge(2, "indexes", 1, ["L"])];
    const state = stateOf(turns, edges, "L");
    expect(state?.closure).toBe("closed");
    expect(state?.terminus).toBe(2);
  });

  test("ticket 10: the edgeless member SHOWS as the lane's latestMember, while the declaration stays where it was declared", () => {
    const turns = [design(1, "L"), design(2, "L"), design(3, "L")];
    const lane = laneOf(deriveLaneInterpretation(turns, [edge(2, "indexes", 1, ["L"])]), "L");
    expect(lane?.latestMember).toBe(3);
    // The declaration is untouched — a member arriving is not a lane event.
    // The two fields answer different questions, which is why closure reads
    // the membership one.
    expect(lane?.declaration.terminus).toBe(2);
  });

  // A tagged, edgeless member is a member wherever it lives, and "latest" is
  // resolved cross-session-safely (`compareOrderKeyAcrossSessions`): the
  // order tuple's session-id half carries no wall-clock meaning across
  // sessions, so a comparator using the raw tuple would call session 1's
  // prompt 9 "later" than session 2's prompt 1 and report this lane CLOSED.
  test("latest member across SESSIONS is resolved by wall-clock epoch, not the order tuple's session half", () => {
    const turns: LaneTurnInput[] = [
      { id: 1, type: ["design"], laneTags: ["L"], order: [2, 1], createdAtEpoch: 100 },
      { id: 2, type: ["design"], laneTags: ["L"], order: [2, 9], createdAtEpoch: 200 },
      // A LATER turn that lives in an EARLIER-numbered session.
      { id: 3, type: ["design"], laneTags: ["L"], order: [1, 1], createdAtEpoch: 300 },
    ];
    const state = stateOf(turns, [edge(2, "indexes", 1, ["L"])], "L");
    expect(state?.closure).toBe("open");
  });

  // A provisional lane never reports a closure defect of its own: with one
  // member and nothing declared it is simply OPEN, which is the honest
  // reading of "nobody has converged yet", not a finding.
  test("a PROVISIONAL lane (one member, no edge, no declaration) reads OPEN with a null terminus", () => {
    const state = stateOf([design(1, "fresh")], [], "fresh");
    expect(state?.closure).toBe("open");
    expect(state?.terminus).toBeNull();
  });
});
