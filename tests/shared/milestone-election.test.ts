import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  electMilestones as runElectMilestones,
  type LaneEdgeInput,
  type MilestoneTurnInput,
} from "../../src/shared/milestone-election";
import { laneEdge, withEdgeClaimedLaneTags } from "../support/lane-edge-fixtures";

/**
 * `electMilestones`, with every fixture turn first given the lane tags ITS
 * OWN SIDE of the fixture's edges names (`withEdgeClaimedLaneTags`).
 *
 * Tier ② seats a CLOSED lane's terminus, and since lane-model-v12 ticket 10 a
 * lane's members — and therefore its closed/open verdict — come from the
 * TURNS' own tags, never from the endpoints of tagged edges. Fixtures that
 * state their lanes on the edges alone would enumerate no lane at all and
 * seat nobody at tier ②; this projects the E4-clean membership each one
 * always implied. A test about MEMBERSHIP itself states `laneTags` directly.
 */
function electMilestones(
  turns: readonly MilestoneTurnInput[],
  edges: readonly LaneEdgeInput[],
  budget: number,
  rolledBackCiterIds?: readonly number[],
): ReturnType<typeof runElectMilestones> {
  return runElectMilestones(
    withEdgeClaimedLaneTags(turns, edges),
    edges,
    budget,
    rolledBackCiterIds,
  );
}

const turn = (id: number, extra: Partial<MilestoneTurnInput> = {}): MilestoneTurnInput => ({
  id,
  type: ["design"],
  ...extra,
});
const edge = (
  citingId: number,
  relation: string,
  citedId: number,
  tags: string[] = [],
  sides?: { tailTag: string; headTag: string },
): LaneEdgeInput =>
  laneEdge({ citingId, relation, citedId, tags, ...(sides ?? {}) });

function tierOf(result: ReturnType<typeof electMilestones>, id: number) {
  return result.candidates.find((c) => c.id === id);
}

// ---------------------------------------------------------------- golden fixture

interface FixtureTurn {
  id: number;
  type: string[];
}
interface FixtureEdge {
  citingId: number;
  relation: string;
  citedId: number;
  tags: string[];
}
interface Fixture {
  turns: FixtureTurn[];
  edges: FixtureEdge[];
}

const fixture: Fixture = JSON.parse(
  readFileSync(
    join(process.cwd(), ".scratch/rubric-v10/fixtures/t900-1001-lane-sim.json"),
    "utf8",
  ),
);
const fixtureTurns: MilestoneTurnInput[] = fixture.turns.map((t) => ({ id: t.id, type: t.type }));
const fixtureEdges: LaneEdgeInput[] = fixture.edges.map((e) =>
  laneEdge({
    citingId: e.citingId,
    relation: e.relation,
    citedId: e.citedId,
    tags: e.tags,
  }),
);

const GOLDEN_NINE = [922, 929, 939, 946, 981, 984, 990, 998, 1001];

describe("golden fixture — S15069 T900-1001 lane simulation, budget 9", () => {
  const result = electMilestones(fixtureTurns, fixtureEdges, 9);

  test("the top nine by election rank are exactly the golden set, and read back in ASCENDING time order (the spec's display rule) as the pinned sequence", () => {
    const topNine = result.candidates.slice(0, 9).map((c) => c.id);
    expect(new Set(topNine)).toEqual(new Set(GOLDEN_NINE));
    const displayOrder = [...topNine].sort((a, b) => a - b);
    expect(displayOrder).toEqual(GOLDEN_NINE);
  });

  test("998 and 1001 are the two tier-1 releases (untagged-indexes writers), ranking above every tier-2 terminus regardless of degree", () => {
    expect(tierOf(result, 998)?.tier).toBe(1);
    expect(tierOf(result, 998)?.reason).toBe("release");
    expect(tierOf(result, 1001)?.tier).toBe(1);
  });

  test("922/929/939/946/981/984/990 are the seven closed-lane termini seated at tier 2", () => {
    for (const id of [922, 929, 939, 946, 981, 984, 990]) {
      expect(tierOf(result, id)?.tier).toBe(2);
      expect(tierOf(result, id)?.reason).toBe("closed-terminus");
    }
  });

  // TICKET 04 RE-BASELINES THIS FIXTURE FACT, and it is the golden-corpus
  // half of the "18 turns re-enter" change. 925 (cited by an untagged
  // override) and 935 (cited by 941's untagged refutes) used to vanish from
  // candidacy outright as global-repudiation victims. There is no global
  // repudiation any more, so both are ordinary candidates again — no edge
  // removes anyone from candidacy now, and `excluded` is empty for a fixture
  // whose turns are all live.
  test("925 (untagged override victim) and 935 (untagged refutes victim) RE-ENTER candidacy — no edge excludes anyone", () => {
    for (const id of [925, 935]) {
      expect(tierOf(result, id)).toBeDefined();
      expect(result.excluded).not.toContain(id);
    }
    expect(result.excluded).toEqual([]);
  });

  // Ticket 11 re-baselines this ONE fixture fact — the ticket's own
  // acceptance bar ("any tier that changes is listed"): under the OLD
  // (retired) uniform rule, 957 (cited by 958's TAGGED `override{write-gate}`)
  // left candidacy just like 925/935. Under the fix, only an UNTAGGED
  // override/refutes is the global repudiation; a tagged one is lane-local
  // and no longer removes the cited node from candidacy at all. 957's own
  // `write-gate` lane was never declared (no tier-2 seat for anyone in it —
  // see the "write-gate reads open with no declarer" test below, unchanged),
  // so with no OTHER qualifying signal 957 now simply surfaces at tier 5.
  test("957 (TAGGED override{write-gate} victim) is NOT excluded — its lane was never declared either way, so it now reads as an ordinary tier-5 candidate instead of vanishing from candidacy", () => {
    expect(result.excluded).not.toContain(957);
    expect(tierOf(result, 957)?.tier).toBe(5);
    expect(tierOf(result, 957)?.reason).toBe("other");
  });

  test("write-gate reads open with no declarer — none of its members hold a tier-2 seat for that lane; its own tagged-override writer (958) is a tier-4 corrector instead", () => {
    for (const id of [950, 951, 952, 953, 954, 955]) {
      const candidate = tierOf(result, id);
      expect(candidate?.tier).not.toBe(2);
    }
    expect(tierOf(result, 958)?.tier).toBe(4);
    expect(tierOf(result, 958)?.reason).toBe("corrector");
  });

  test("913 (ownership's terminus) IS a legitimate closed-lane tier-2 candidate but loses the top-9 cut — its own in-degree is 0 because the lane's one cross-phase adoption (T936 grounds T910) lands mid-lane, not on the terminus (spec's stated non-goal)", () => {
    const candidate = tierOf(result, 913);
    expect(candidate?.tier).toBe(2);
    expect(candidate?.reason).toBe("closed-terminus");
    expect(candidate?.inDegree).toBe(0);
    expect(result.candidates.slice(0, 9).some((c) => c.id === 913)).toBe(false);
  });
});

// ---------------------------------------------------------------- candidacy exclusion

describe("candidacy exclusion — step 1 (ticket 04): only an INVALID NODE leaves; no edge excludes anything", () => {
  // THE DELETION, PINNED. `override`/`refutes` used to remove their cited
  // node from candidacy whenever they carried no tag — the reading that an
  // untagged override was a GLOBAL REPUDIATION that killed the node outright.
  // v12 has no node death, so the rule lost its basis and is deleted whole.
  // Measured on the live database when the arm was cut: 21 live turns re-enter
  // candidacy through exactly this change (the v12 spec's D5 said 18; the
  // corpus grew between that measurement and the ticket).
  test("an untagged override victim STAYS a candidate — the global-repudiation arm is deleted", () => {
    const turns = [turn(1), turn(2)];
    const edges = [edge(2, "override", 1, [])];
    const result = electMilestones(turns, edges, 5);
    expect(result.excluded).toEqual([]);
    expect(tierOf(result, 1)?.tier).toBe(5);
    expect(tierOf(result, 1)?.reason).toBe("other");
    // The override's own writer is still a tier-4 corrector — an unrelated,
    // unconditional rule this ticket leaves untouched.
    expect(tierOf(result, 2)?.tier).toBe(4);
  });

  test("an untagged refutes victim STAYS a candidate too — the arm was word-blind, and so is its deletion", () => {
    const turns = [turn(1), turn(2)];
    const edges = [edge(2, "refutes", 1, [])];
    const result = electMilestones(turns, edges, 5);
    expect(result.excluded).toEqual([]);
    expect(tierOf(result, 1)?.tier).toBe(5);
  });

  test("a TAGGED override victim stays a candidate as well — the tag state never mattered once the arm was gone", () => {
    const turns = [turn(1), turn(2)];
    const edges = [edge(2, "override", 1, ["x"])];
    const result = electMilestones(turns, edges, 5);
    expect(result.excluded).toEqual([]);
    expect(tierOf(result, 1)?.tier).toBe(5);
    expect(tierOf(result, 2)?.tier).toBe(4);
  });

  // The SURVIVING arm. rubric-v12 keeps 无效节点 ("a skipped / rewound turn,
  // all of whose edges are void"), so these two exclusions stay — deleting
  // them would seat a turn the model calls invalid.
  test("a rolled-back turn leaves candidacy even with no edges touching it at all", () => {
    const turns = [turn(1, { wasRolledBack: true })];
    const result = electMilestones(turns, [], 5);
    expect(tierOf(result, 1)).toBeUndefined();
    expect(result.excluded).toEqual([1]);
  });

  test("a skipped turn leaves candidacy even with no edges touching it at all", () => {
    const turns = [turn(1, { skipped: true })];
    const result = electMilestones(turns, [], 5);
    expect(tierOf(result, 1)).toBeUndefined();
    expect(result.excluded).toEqual([1]);
  });

  test("an excluded node's OWN out-edges still count toward another node's in-degree — exclusion prunes candidacy, not the graph", () => {
    const turns = [turn(1), turn(2), turn(3, { wasRolledBack: true })];
    // 3 is rolled-back (excluded) but still grounds 1 — 1's in-degree must see it.
    const edges = [edge(3, "grounds", 1, [])];
    const result = electMilestones(turns, edges, 5);
    expect(tierOf(result, 1)?.inDegree).toBe(1);
  });
});

// ---------------------------------- ticket 11's own pinned failure case ----

describe("ticket 11 failure case (peer): a lane-local repair on ONE lane must not cost a shared terminus its standing in the OTHERS", () => {
  test("R declares indexes{a}/{b}/{c} (terminus of all three); X writes a TAGGED override{a} -> R. Lane a's own reopening does not exclude R from candidacy — R keeps its election seat on account of b/c", () => {
    const turns = [turn(1), turn(2), turn(3), turn(10), turn(20)];
    const edges = [
      edge(10, "indexes", 1, ["a"]), // R declares lane a's core (turn 1)
      edge(10, "indexes", 2, ["b"]), // R declares lane b's core (turn 2)
      edge(10, "indexes", 3, ["c"]), // R declares lane c's core (turn 3)
      edge(20, "override", 10, ["a"]), // X repairs ONLY lane a — tagged, lane-local
    ];
    const result = electMilestones(turns, edges, 5);

    // Before this ticket's fix, ANY tag state on the override wholesale-
    // excluded R (id 10) from candidacy — the exact bug this test pins.
    expect(result.excluded).not.toContain(10);
    // R still holds a tier-2 seat: lanes b and c are both still CLOSED with
    // R as terminus, and lane a's own reopening costs R only that one lane.
    expect(tierOf(result, 10)?.tier).toBe(2);
    // X, the repair's own writer, is a tier-4 corrector regardless — an
    // unconditional, tag-independent rule this ticket leaves untouched.
    expect(tierOf(result, 20)?.tier).toBe(4);
  });
});

// ---------------------------------------------------------------- identity tiers

describe("tier 1 — UNSETTLED-indexes writers (releases)", () => {
  test("a node writing an untagged indexes edge is tier 1", () => {
    const turns = [turn(1), turn(2)];
    const edges = [edge(2, "indexes", 1, [])];
    const result = electMilestones(turns, edges, 5);
    expect(tierOf(result, 2)?.tier).toBe(1);
    expect(tierOf(result, 2)?.reason).toBe("release");
  });

  test("a node writing only a TAGGED indexes edge is not tier 1 (tagged indexes acts on the lane, not global aggregation)", () => {
    const turns = [turn(1), turn(2)];
    const edges = [edge(2, "indexes", 1, ["x"])];
    const result = electMilestones(turns, edges, 5);
    expect(tierOf(result, 2)?.tier).not.toBe(1);
  });

  // lane-model-v12 ticket 07 — the SOURCE this tier reads. The two fixtures
  // below disagree between `tags` and the side columns, so exactly one
  // implementation can satisfy both: reverting the predicate to
  // `canonicalTagSet(edge.tags).length === 0` reddens the first, and reading
  // only ONE side reddens the second.
  test("SETTLED sides beat an empty `tags`: an indexes whose two sides name a lane is NOT tier 1, however empty its tag set", () => {
    const turns = [turn(1), turn(2)];
    const edges = [edge(2, "indexes", 1, [], { tailTag: "x", headTag: "x" })];
    const result = electMilestones(turns, edges, 5);
    expect(tierOf(result, 2)?.tier).not.toBe(1);
  });

  test("a HALF-settled indexes is not tier 1 either — the tier needs BOTH sides unsettled, not just one", () => {
    const onlyTail = electMilestones(
      [turn(1), turn(2)],
      [edge(2, "indexes", 1, [], { tailTag: "x", headTag: "" })],
      5,
    );
    expect(tierOf(onlyTail, 2)?.tier).not.toBe(1);
    const onlyHead = electMilestones(
      [turn(1), turn(2)],
      [edge(2, "indexes", 1, [], { tailTag: "", headTag: "x" })],
      5,
    );
    expect(tierOf(onlyHead, 2)?.tier).not.toBe(1);
  });

  // The complement: a MULTI-tag row projects to both sides unsettled
  // (`db/memory-edges.ts`'s `deriveSideTags` — the two-sided model has no
  // single-valued form for one), so it now reads as the cross-lane
  // aggregation this tier seats. Under the retired `tags` predicate its
  // two-element set made it "tagged" and it seated nothing. Stored rows of
  // this shape were split by M-A; a fresh one is possible until ticket 08
  // closes the write surface.
  test("a MULTI-tag indexes reads as unsettled and DOES seat tier 1 — the one behaviour the source swap changes", () => {
    const turns = [turn(1), turn(2)];
    const edges = [edge(2, "indexes", 1, ["x", "y"])];
    const result = electMilestones(turns, edges, 5);
    expect(edges[0]!.tailTag).toBe("");
    expect(edges[0]!.headTag).toBe("");
    expect(tierOf(result, 2)?.tier).toBe(1);
  });
});

describe("tier 2 — a CLOSED lane's terminus, and nothing else (ticket 04)", () => {
  test("a closed lane's terminus is tier 2", () => {
    const turns = [turn(30), turn(31)];
    const edges = [edge(31, "extends", 30, ["v"]), edge(31, "indexes", 30, ["v"])];
    const result = electMilestones(turns, edges, 5);
    expect(tierOf(result, 31)?.tier).toBe(2);
    expect(tierOf(result, 31)?.reason).toBe("closed-terminus");
  });

  // THE SEAT'S DELETION, PINNED. An OPEN lane used to seat its most recent
  // declaring turn at tier 2 under the reason `open-last-declarer`. v12 has
  // no reopen mechanism for a lost declaration to be recovered from — a lane
  // is open exactly when its newest member is not an index, which says
  // nothing about any earlier declaration — so the seat is deleted outright.
  // 21 keeps its declaration edge and still gets NOTHING from tier 2.
  test("an OPEN lane (structural activity continued past its own declaration) seats NOBODY — the second tier-2 seat is deleted", () => {
    const turns = [turn(20), turn(21), turn(22)];
    const edges = [
      edge(21, "extends", 20, ["cont"]),
      edge(21, "indexes", 20, ["cont"]), // declares at 21
      edge(22, "extends", 21, ["cont"]), // continuation past the declaration -> lane reads OPEN
    ];
    const result = electMilestones(turns, edges, 5);
    expect(tierOf(result, 21)?.tier).not.toBe(2);
    expect(tierOf(result, 21)?.tier).toBe(5);
    // No candidate anywhere in this election holds a tier-2 seat at all.
    expect(result.candidates.filter((c) => c.tier === 2)).toEqual([]);
  });

  test("an override-REOPENED lane seats nobody either — its pre-override declarer has no seat to fall back to", () => {
    const turns = [turn(101), turn(102), turn(103)];
    const edges = [
      edge(102, "extends", 101, ["x"]),
      edge(102, "indexes", 101, ["x"]),
      edge(103, "override", 102, ["x"]), // reopens
    ];
    const result = electMilestones(turns, edges, 5);
    expect(result.excluded).toEqual([]);
    expect(tierOf(result, 102)?.tier).not.toBe(2);
    expect(result.candidates.filter((c) => c.tier === 2)).toEqual([]);
  });

  // THE OTHER HALF OF TIER ②'s DELETION. This is the old "repudiate the wrong
  // conclusion, THEN declare closure indexing it" ritual: the lane used to
  // read closed-INVALID (its entire declared core was dead) and seat nobody.
  // Node death is gone, so there is no invalidity for the lane to have — it
  // is CLOSED, and 13 takes the ordinary tier-2 seat.
  test("the lane that used to read closed-INVALID now seats its terminus like any other closed lane", () => {
    const turns = [turn(10), turn(11), turn(12), turn(13)];
    const edges = [
      edge(11, "extends", 10, ["dead-core"]),
      edge(12, "override", 11, ["dead-core"]), // the old "kill the wrong conclusion" move
      edge(13, "indexes", 11, ["dead-core"]), // then declare closure over it
    ];
    const result = electMilestones(turns, edges, 5);
    expect(tierOf(result, 13)?.tier).toBe(2);
    expect(tierOf(result, 13)?.reason).toBe("closed-terminus");
  });

  // THE MERGE (lane-declaration spec Rev 2, D5) still holds, with node death
  // removed from its consequences: the override tagged `{a,c}` fires in lane
  // `{a}` too (it carries tag `a`), so it is lane `a`'s own event — but since
  // T4's later `indexes{a}` re-declares the lane and IS its newest member,
  // lane `a` reads CLOSED and T4 seats. What the merge changes is which lanes
  // the row participates in; what ticket 04 changed is that participation no
  // longer produces a per-node verdict.
  test("the merge: a multi-tag override fires in a lane it shares only one tag with, and the later re-declaration still closes that lane", () => {
    const turns = [turn(1), turn(3), turn(4)];
    const edges = [
      edge(3, "override", 1, ["a", "c"]), // shares tag `a` with the lane below
      edge(4, "indexes", 1, ["a"]), // then declare closure over T1
    ];
    const result = electMilestones(turns, edges, 5);
    expect(tierOf(result, 4)?.tier).toBe(2);
    expect(tierOf(result, 4)?.reason).toBe("closed-terminus");
    expect(tierOf(result, 3)?.tier).toBe(4);
    expect(tierOf(result, 3)?.reason).toBe("corrector");
    expect(result.excluded).toEqual([]);
    // T1 is indexed by the elected T4, so it seats at tier 3 — under the old
    // reading it was the override's victim and had no seat at all.
    expect(tierOf(result, 1)?.tier).toBe(3);
  });

  // TICKET 19, AT THE ELECTION. "My line is finished, its result folds into
  // the main one" is an `indexes` written FROM lane `a` INTO lane `b`, and
  // until this ticket the reducer answered "which lane converged" with the
  // INTERNAL-edge predicate, so it closed NEITHER and the terminus lost its
  // tier-2 seat entirely. Convergence is the tail's unilateral declaration:
  // turn 2 closes `a`, whatever it points at. Restoring "both sides must
  // agree" drops turn 2 to tier 5 and empties tier 2 here.
  test("a terminus that indexes ACROSS into a sibling lane still takes its tier-2 seat — closure follows the tail (ticket 19)", () => {
    const turns = [turn(1), turn(2)];
    // Per SIDE (`withEdgeClaimedLaneTags`): turn 2 carries `a`, turn 1 `b`.
    const edges = [edge(2, "indexes", 1, [], { tailTag: "a", headTag: "b" })];
    const result = electMilestones(turns, edges, 5);
    expect(tierOf(result, 2)?.tier).toBe(2);
    expect(tierOf(result, 2)?.reason).toBe("closed-terminus");
    // Both sides settled, so this is no tier-① cross-lane aggregation either.
    expect(tierOf(result, 2)?.reason).not.toBe("release");
    // Lane `b` was only pointed AT, so it declares nothing and turn 1 holds
    // no tier-2 seat — it seats at tier 3, indexed by the elected turn 2.
    expect(tierOf(result, 1)?.tier).toBe(3);
    expect(result.candidates.filter((c) => c.tier === 2).map((c) => c.id)).toEqual([2]);
  });

  test("an undeclared lane (only structural continuation, no indexes ever) seats no one at tier 2 — 'open, no declarer, no seat'", () => {
    const turns = [turn(401), turn(402), turn(403)];
    const edges = [edge(402, "extends", 401, ["silent"]), edge(403, "extends", 402, ["silent"])];
    const result = electMilestones(turns, edges, 5);
    for (const id of [401, 402, 403]) {
      expect(tierOf(result, id)?.tier).not.toBe(2);
    }
  });
});

describe("'highest wins' — a node qualifying for BOTH tier 1 and tier 2 shows tier 1", () => {
  test("a lane terminus that ALSO writes an unrelated untagged indexes edge is tier 1, not tier 2", () => {
    const turns = [turn(1), turn(2), turn(3)];
    const edges = [
      edge(2, "extends", 1, ["x"]),
      edge(2, "indexes", 1, ["x"]), // tier-2 qualifying: closed-valid terminus of {x}
      edge(2, "indexes", 3, []), // tier-1 qualifying: untagged-indexes writer
    ];
    const result = electMilestones(turns, edges, 5);
    expect(tierOf(result, 2)?.tier).toBe(1);
    expect(tierOf(result, 2)?.reason).toBe("release");
  });
});

describe("tier 3 — indexed by an ELECTED tier-1/2 node, a genuine two-stage fill gated by `budget`", () => {
  test("a node indexed by a tier-1 writer that MAKES the stage-1 cut becomes tier 3", () => {
    const turns = [turn(1), turn(2), turn(5), turn(6)];
    const edges = [
      edge(1, "indexes", 5, []), // untagged: 1 is tier 1, indexes 5
      edge(2, "indexes", 6, []), // untagged: 2 is also tier 1, indexes 6
      edge(3, "grounds", 1, []), // boosts 1's in-degree above 2's so 1 wins the budget-1 cut deterministically
    ];
    const result = electMilestones(turns, edges, 1); // budget 1: only ONE of {1,2} is "elected"
    expect(tierOf(result, 1)?.tier).toBe(1); // 1 wins the cut (higher in-degree)
    expect(tierOf(result, 5)?.tier).toBe(3);
    expect(tierOf(result, 5)?.reason).toBe("indexed-by-elected");
  });

  test("a node indexed ONLY by a tier-1/2 node that LOSES the stage-1 cut (budget exhausted) does NOT become tier 3 — the boundary is the elected SUBSET, not tier-1/2 qualification alone", () => {
    const turns = [turn(1), turn(2), turn(5), turn(6)];
    const edges = [
      edge(1, "indexes", 5, []),
      edge(2, "indexes", 6, []),
      edge(3, "grounds", 1, []), // 1 outranks 2
    ];
    const result = electMilestones(turns, edges, 1); // budget 1: 2 does NOT make the cut
    expect(tierOf(result, 2)?.tier).toBe(1); // 2 is still legitimately tier 1 itself...
    expect(tierOf(result, 6)?.tier).not.toBe(3); // ...but its OWN indexing grants no tier-3 seat, since 2 was not elected
  });
});

describe("tier 4 — correctors: override writers, or citers of a rolled-back turn", () => {
  test("a node writing an override edge (any tags) is a corrector, absent a higher tier", () => {
    const turns = [turn(1), turn(2)];
    const edges = [edge(2, "override", 1, [])];
    const result = electMilestones(turns, edges, 5);
    expect(tierOf(result, 2)?.tier).toBe(4);
    expect(tierOf(result, 2)?.reason).toBe("corrector");
  });

  test("a node citing (any relation) a turn marked wasRolledBack is a corrector, absent a higher tier", () => {
    const turns = [turn(50, { wasRolledBack: true }), turn(51)];
    const edges = [edge(51, "grounds", 50, [])];
    const result = electMilestones(turns, edges, 5);
    expect(tierOf(result, 50)).toBeUndefined(); // 50 itself is excluded (rolled-back)
    expect(tierOf(result, 51)?.tier).toBe(4);
    expect(tierOf(result, 51)?.reason).toBe("corrector");
  });
});

describe("tier 5 — everything else", () => {
  test("a node with no qualifying signal at all is tier 5", () => {
    const turns = [turn(1), turn(2)];
    const edges = [edge(2, "consume", 1, [])];
    const result = electMilestones(turns, edges, 5);
    expect(tierOf(result, 2)?.tier).toBe(5);
    expect(tierOf(result, 2)?.reason).toBe("other");
  });
});

// ---------------------------------------------------------------- within-tier ranking

describe("within-tier ranking — in-degree, then out-degree, then the later turn wins", () => {
  test("positive in-degree over the six words, self-edges included (T1180: a self-grounds prices a real declared convergence)", () => {
    const turns = [turn(1)];
    const edges = [edge(1, "grounds", 1, [])]; // self-citation
    const result = electMilestones(turns, edges, 5);
    expect(tierOf(result, 1)?.inDegree).toBe(1);
    expect(tierOf(result, 1)?.outDegree).toBe(1);
  });

  test("positive in-degree counts EXACTLY the six words — one incoming edge per word tallies to 6, no more, no less", () => {
    const turns = [turn(10), turn(11), turn(12), turn(13), turn(14), turn(15), turn(16)];
    const edges = [
      edge(11, "narrows", 10, []),
      edge(12, "extends", 10, []),
      edge(13, "consume", 10, []),
      edge(14, "indexes", 10, []),
      edge(15, "grounds", 10, []),
      edge(16, "verifies", 10, []),
    ];
    const result = electMilestones(turns, edges, 5);
    expect(tierOf(result, 10)?.inDegree).toBe(6);
  });

  // Ticket 04: override/refutes still contribute NO in-degree (they are
  // corrections, not endorsements) — but they no longer remove their target
  // from candidacy either, so the node now surfaces at tier 5 with in-degree
  // 0 rather than vanishing.
  test("override/refutes contribute no in-degree, and no longer exclude their target — it surfaces at tier 5 with in-degree 0", () => {
    const turns = [turn(1), turn(2), turn(3)];
    const edges = [edge(2, "override", 1, []), edge(3, "refutes", 1, [])];
    const result = electMilestones(turns, edges, 5);
    expect(result.excluded).toEqual([]);
    expect(tierOf(result, 1)?.tier).toBe(5);
    expect(tierOf(result, 1)?.inDegree).toBe(0);
  });

  test("ties on tier and in-degree break by out-degree (all eight relation words)", () => {
    const turns = [turn(1), turn(2), turn(3), turn(4)];
    // 1 and 2 both tier 5, both in-degree 0; 1 has two outgoing edges, 2 has one.
    const edges = [edge(1, "consume", 3, []), edge(1, "consume", 4, []), edge(2, "consume", 3, [])];
    const result = electMilestones(turns, edges, 5);
    const rank1 = result.candidates.findIndex((c) => c.id === 1);
    const rank2 = result.candidates.findIndex((c) => c.id === 2);
    expect(tierOf(result, 1)?.outDegree).toBe(2);
    expect(tierOf(result, 2)?.outDegree).toBe(1);
    expect(rank1).toBeLessThan(rank2);
  });

  test("the LATER turn wins the remaining tie, read from the `order` key — never raw `id` alone (a backfilled turn's larger id does not make it 'later')", () => {
    const turns: MilestoneTurnInput[] = [
      { id: 999, type: ["design"], order: [0, 1] }, // true order 1st, but the LARGEST id
      { id: 100, type: ["design"], order: [0, 2] }, // true order 2nd (latest), but the SMALLEST id
    ];
    const result = electMilestones(turns, [], 5);
    // Both tier 5, both zero degree — order alone decides: 100 (order [0,2]) is
    // later and must rank first despite id 100 < id 999.
    expect(result.candidates.map((c) => c.id)).toEqual([100, 999]);
  });
});

// ---------------------------------------------------------------- degradation

describe("edgeless-window degradation to recency — no special-cased branch, an emergent property of the general ranking rule", () => {
  test("with zero edges, every surviving turn is tier 5 with zero degree, and the later-turn tiebreak alone produces pure recency order", () => {
    const turns = [turn(1), turn(2), turn(3)];
    const result = electMilestones(turns, [], 5);
    expect(result.candidates.every((c) => c.tier === 5 && c.inDegree === 0 && c.outDegree === 0)).toBe(
      true,
    );
    expect(result.candidates.map((c) => c.id)).toEqual([3, 2, 1]);
  });
});

// ------------------------------------------------ pre-release repairs — R1

describe("R1 #1(a) — an edge-only external endpoint never seats and never steals a stage-1 budget slot (pinned counterexample)", () => {
  test("window {T1,T2,T3} budget 2; T1 writes untagged indexes T2 (release); external T90/T91 (never in turns[]) each write untagged indexes T3 — correct election is {T1,T2}, not {T1,T3}", () => {
    const turns = [turn(1), turn(2), turn(3)];
    const edges = [
      edge(1, "indexes", 2, []), // T1: tier-1 release, indexes T2
      edge(90, "indexes", 3, []), // external T90: untagged indexes T3
      edge(91, "indexes", 3, []), // external T91: untagged indexes T3
    ];
    const result = electMilestones(turns, edges, 2);

    // T90/T91 are graph nodes only — never candidates, never excluded (they
    // were never eligible to begin with).
    expect(tierOf(result, 90)).toBeUndefined();
    expect(tierOf(result, 91)).toBeUndefined();
    expect(result.excluded).not.toContain(90);
    expect(result.excluded).not.toContain(91);

    // T1 is the sole real tier-1 candidate and is elected; T2 (indexed by
    // the now-elected T1) becomes tier 3. T3's only indexers are external
    // and can never be "elected" (they never enter stage 1 at all), so T3
    // gets no tier-3 seat and falls to tier 5 — though its in-degree still
    // counts both external edges, proving they stayed graph nodes.
    expect(tierOf(result, 1)?.tier).toBe(1);
    expect(tierOf(result, 2)?.tier).toBe(3);
    expect(tierOf(result, 2)?.reason).toBe("indexed-by-elected");
    expect(tierOf(result, 3)?.tier).toBe(5);
    expect(tierOf(result, 3)?.inDegree).toBe(2);

    expect(result.candidates.slice(0, 2).map((c) => c.id)).toEqual([1, 2]);
  });
});

describe("R1 #1(b) — an external node's REAL order (never the [0,id] fallback) decides which declaration wins a lane (pinned counterexample)", () => {
  test("window member T2 (real order [5,10]) declares lane {x}; external LATER T99, supplied with its REAL order [5,20] and eligible:false, re-declares — T2's declaration is superseded (loses its tier-2 seat) and T99 seats nowhere (external)", () => {
    const turns = [
      turn(1),
      turn(2, { order: [5, 10] }),
      turn(99, { order: [5, 20], eligible: false }),
    ];
    const edges = [
      edge(2, "indexes", 1, ["x"]),
      edge(99, "indexes", 1, ["x"]),
    ];
    const result = electMilestones(turns, edges, 5);
    expect(tierOf(result, 2)?.tier).not.toBe(2);
    expect(tierOf(result, 99)).toBeUndefined();
  });

  test("contrast — WITHOUT T99 supplied at all (the adapter omitting the external-metadata fetch), the [0,id] fallback collapses T99 into session '0', which sorts before any real session, so T2 WRONGLY keeps the terminus", () => {
    const turns = [turn(1), turn(2, { order: [5, 10] })]; // T99 never supplied
    const edges = [
      edge(2, "indexes", 1, ["x"]),
      edge(99, "indexes", 1, ["x"]), // T99 touches the graph only via this edge
    ];
    const result = electMilestones(turns, edges, 5);
    // This is the documented caveat, not a fix: the CORE'S eligibility
    // boundary alone cannot recover a real order the caller never supplied
    // — `mcp/timeline.ts`'s `fetchExternalElectionTurns` is what closes
    // this gap in production (R1 #1's adapter half).
    expect(tierOf(result, 2)?.tier).toBe(2);
    expect(tierOf(result, 2)?.reason).toBe("closed-terminus");
  });
});

describe("R1 #6 — cross-session rank tie-break falls back to createdAtEpoch, not the [sessionId, promptNumber] tuple (pinned counterexample)", () => {
  test("same lane, S1/T1 epoch=200 vs S2/T1 epoch=100, budget 1 — S1/T1 is truly LATER (bigger epoch) and must win despite the SMALLER session id", () => {
    const turns: MilestoneTurnInput[] = [
      { id: 1, type: ["design"], order: [1, 1], createdAtEpoch: 200 }, // S1/T1
      { id: 2, type: ["design"], order: [2, 1], createdAtEpoch: 100 }, // S2/T1 — bigger session id, but EARLIER by epoch
    ];
    const result = electMilestones(turns, [], 1);
    // Both tier 5, zero degree: the order tie-break alone decides, and it
    // must read wall-clock epoch across sessions, not the tuple's
    // session-id half (the exact trap `lane-checker.ts`'s report-4(c)
    // `computeTimeOrderViolations` already avoids).
    expect(result.candidates.map((c) => c.id)).toEqual([1, 2]);
  });

  test("same-session pairs are unaffected — the tuple alone still decides, epoch never consulted", () => {
    const turns: MilestoneTurnInput[] = [
      { id: 1, type: ["design"], order: [1, 1], createdAtEpoch: 999 }, // huge epoch, but SAME session, EARLIER prompt
      { id: 2, type: ["design"], order: [1, 2], createdAtEpoch: 1 },
    ];
    const result = electMilestones(turns, [], 1);
    expect(result.candidates.map((c) => c.id)).toEqual([2, 1]);
  });
});

describe("R1 #7 — rolledBackCiterIds: the adapter-supplied fact for a citer of a rolled-back turn that getRelationEdgesAmongTurns structurally cannot surface as an edge", () => {
  test("an id in rolledBackCiterIds tiers 4 (corrector) even with zero edges naming it at all", () => {
    const turns = [turn(1), turn(2)];
    const result = electMilestones(turns, [], 5, [2]);
    expect(tierOf(result, 2)?.tier).toBe(4);
    expect(tierOf(result, 2)?.reason).toBe("corrector");
  });

  test("'highest wins' still applies: an id in rolledBackCiterIds that independently earns a higher tier is NOT demoted to corrector", () => {
    const turns = [turn(1), turn(2)];
    const edges = [edge(2, "indexes", 1, [])]; // untagged indexes -> tier-1 release
    const result = electMilestones(turns, edges, 5, [2]);
    expect(tierOf(result, 2)?.tier).toBe(1);
  });
});
