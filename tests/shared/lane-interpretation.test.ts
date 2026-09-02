import { describe, expect, test } from "bun:test";

import {
  compareOrderKey,
  compareOrderKeyAcrossSessions,
  DEFAULT_SEGMENT,
  deriveLaneInterpretation,
  laneMembershipClaims,
  laneToken,
  UNSETTLED_LANE_TAG,
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
  });

  // The two halves are independent: a turn claims the lane, an edge is
  // attributed to it. A member that no edge touches is still a member.
  test("a member that carries the tag and has NO edge sits in `members` beside the wired-up ones", () => {
    const turns = [design(1, "x"), design(2, "x"), design(3, "x")];
    const lane = laneOf(deriveLaneInterpretation(turns, [edge(2, "extends", 1, ["x"])]), "x");
    expect(lane?.members.map((m) => m.id)).toEqual([1, 2, 3]);
    expect(lane?.taggedEdges).toHaveLength(1);
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
    expect(lane?.taggedEdges).toEqual([]);
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
      {
        citingId: 2,
        citedId: 1,
        relation: "use",
        relationClass: "use",
        relationCoverage: "",
        tailTag: "x",
        headTag: "x",
      },
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

// ------------------------------------------------------------------------
// DELETED WITH LANE STATE (lane-state-retirement ticket 01).
//
// Two whole describe blocks stood here and one more below: the override
// cases ("an in-lane override leaves the declared terminus INTACT"), the
// turn-order reduction ("a backfilled turn's larger id does not make it
// later"), and the tail-alone convergence rule ("a cross-segment `indexes`
// closes the TAIL's own lane"). Every one of them asserted something about
// `Lane.declaration` / `Lane.latestMember` / `laneClosureClaim` / a lane's
// closed-open state, and all four of those are deleted — not narrowed, so
// there is no surviving weaker assertion to keep.
//
// What replaced them, and where it is pinned:
//   - the SHAPE of a stateless lane -> the key-list test just below;
//   - that the retired symbols are really gone ->
//     `tests/shared/lane-state-retirement-deletions.test.ts`;
//   - reduction ORDERING, which the declaration fold was this module's only
//     consumer of -> `compareOrderKey`/`compareOrderKeyAcrossSessions`,
//     tested directly below rather than through a fold that no longer runs.
// ------------------------------------------------------------------------

describe("a lane is its members and its claiming edges — and carries no state (ticket 01)", () => {
  test("Lane has exactly three keys: key, members, taggedEdges", () => {
    const turns = [design(1, "a"), design(2, "a")];
    const derivation = deriveLaneInterpretation(turns, [edge(2, "indexes", 1, ["a"])]);
    const lane = laneOf(derivation, "a");
    expect(lane).toBeDefined();
    // A re-added state field — a closure verdict, a terminus, a newest-member
    // seat — arrives as a fourth key and reddens here before anything reads it.
    expect(Object.keys(lane!).sort()).toEqual(["key", "members", "taggedEdges"]);
  });

  test("an `indexes` edge is attributed by the SAME rule as every other word — no second predicate", () => {
    const turns = [design(1, "a"), design(2, "a")];
    // Internal on both sides: joins the lane, exactly like an `extends` would.
    const internal = deriveLaneInterpretation(turns, [edge(2, "indexes", 1, ["a"])]);
    expect(laneOf(internal, "a")?.taggedEdges).toHaveLength(1);
    // A CROSSING joins neither lane — and since ticket 01 there is no longer
    // any second reading under which it "closes" the tail's lane either.
    const crossingTurns = [design(1, "b"), design(2, "a")];
    const crossing = deriveLaneInterpretation(crossingTurns, [
      edge(2, "indexes", 1, [], { tailTag: "a", headTag: "b" }),
    ]);
    expect(laneOf(crossing, "a")?.taggedEdges).toEqual([]);
    expect(laneOf(crossing, "b")?.taggedEdges).toEqual([]);
  });
});


describe("order key is a lexicographically-compared tuple, never a scalar encoding (round-5 review #10)", () => {
  // This property used to be observed THROUGH the declaration fold — the only
  // ordered pass this module had. Ticket 01 deleted the fold, so the property
  // is asserted on the comparator itself, which is where it always lived and
  // which `milestone-election.ts` still ranks by.
  test("a huge minor component never outweighs a larger major component", () => {
    // `[0, 999_999]` must sort strictly BEFORE `[1, 0]`: a scalar encoding
    // (`major * SPAN + minor`) inverts exactly this pair once `minor` exceeds
    // `SPAN`, which is the failure mode the tuple exists to make impossible.
    expect(compareOrderKey([0, 999_999], [1, 0])).toBeLessThan(0);
    expect(compareOrderKey([1, 0], [0, 999_999])).toBeGreaterThan(0);
    expect(compareOrderKey([2, 5], [2, 5])).toBe(0);
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

  // REPLACED BY TICKET 19. This test used to assert that a cross-segment
  // `indexes` declares NEITHER lane — the "两边都不关" reading, which came from
  // the reducer borrowing `laneMembershipClaims` (an INTERNAL-edge predicate)
  // to answer a convergence question. Convergence is the TAIL's unilateral
  // declaration: the citing turn closes the lane its OWN side names, in its
  // own segment, whatever the head names. Everything the old assertion was
  // really protecting — no connectivity, no core membership, the warning —
  // survives below, unchanged and now stated separately from closure.
  // Ticket 19 used to give this edge a SECOND reading — it "closed" the lane
  // its own tail named, in the citing turn's segment, while joining neither
  // lane's edge list. Lane-state-retirement ticket 01 deleted that reading
  // with the state it wrote, so the edge is now attributed exactly like any
  // other cross-segment row: it joins NOTHING and is warned.
  test("a cross-segment `indexes` joins NEITHER lane and is warned — it has no second reading left", () => {
    const turns: LaneTurnInput[] = [
      { id: 10, type: ["design"], segment: "A", laneTags: ["z"] },
      { id: 11, type: ["design"], segment: "B", laneTags: ["z"] },
    ];
    const edges = [edge(11, "indexes", 10, ["z"])];
    const derivation = deriveLaneInterpretation(turns, edges);
    // Both lanes exist (each has its own member) and neither holds the edge.
    expect(laneOf(derivation, "z", "A")?.members).toEqual([{ id: 10 }]);
    expect(laneOf(derivation, "z", "B")?.members).toEqual([{ id: 11 }]);
    expect(laneOf(derivation, "z", "A")?.taggedEdges).toEqual([]);
    expect(laneOf(derivation, "z", "B")?.taggedEdges).toEqual([]);
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
