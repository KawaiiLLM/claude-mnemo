import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  DECISION_TIER_SHARE_WARN_THRESHOLD,
  electMilestones as runElectMilestones,
  type LaneEdgeInput,
  type MilestoneTurnInput,
} from "../../src/shared/milestone-election";
import { laneEdge, withEdgeClaimedLaneTags } from "../support/lane-edge-fixtures";

/**
 * `electMilestones`, with every fixture turn first given the lane tags ITS
 * OWN SIDE of the fixture's edges names (`withEdgeClaimedLaneTags`).
 *
 * HISTORICAL NOTE, kept accurate rather than deleted: this projection used to
 * matter because tier ② read lane MEMBERSHIP (a CLOSED lane's terminus).
 * Lane state is gone (lane-state-retirement ticket 01) and tier ②'s
 * replacement (ticket 02) reads `edges` directly — this node declares an
 * `index`, no membership lookup involved — so `electMilestones` itself no
 * longer reads `MilestoneTurnInput.laneTags` at all (see the module's own
 * "which is also why `laneTags` currently feeds nothing" note). The wrapper
 * is harmless to keep calling (every fixture below still routes through it)
 * but it is no longer load-bearing for any tier; a test about MEMBERSHIP
 * itself still states `laneTags` directly where that matters elsewhere
 * (`tests/shared/lane-interpretation.test.ts`).
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

// phase-connectivity ticket 03 (arm C): `type` used to be inert everywhere
// in this module, so the pre-ticket default of `["design"]` here was an
// arbitrary placeholder. It is no longer inert (a design/correction type now
// seats tier ③ on its own), so the default moves to `[]` — every test below
// that does not care about type keeps its pre-ticket tier, and only the
// handful of tests that ARE about the type-decision tier opt in explicitly
// via `extra.type`.
const turn = (id: number, extra: Partial<MilestoneTurnInput> = {}): MilestoneTurnInput => ({
  id,
  type: [],
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

  // RE-BASELINED AGAIN BY TICKET 02, and — measured, not chosen — it lands
  // back on the SAME nine ids the fixture carried before lane-state-retirement
  // ticket 01 ever touched it: [922, 929, 939, 946, 981, 984, 990, 998, 1001].
  // The structure is identical too (two tier-① releases, seven tier-② seats):
  // on THIS fixture, every node that used to win "closed lane terminus" is
  // also a node that itself writes an `indexes` edge, so the node-level rule
  // recovers the same set the lane-level rule found — for a different reason
  // (`declares-index`, never `closed-terminus`). Ticket 01's interim baseline
  // — [945, 946, 970, 972, 982, 989, 992, 998, 1001], the two releases padded
  // out by SIX tier-③ nodes those releases indexed while tier ② sat empty —
  // is superseded; six of those six now fall out of the top nine because the
  // seven real declarers now outrank them, and 946 (present in both sets)
  // moves from a tier-③ "indexed-by-elected" seat to its own tier-② seat.
  const GOLDEN_NINE = [922, 929, 939, 946, 981, 984, 990, 998, 1001];

  test("the top of the election is the two releases plus the seven index-declaring tier-2 seats", () => {
    const top = result.candidates.slice(0, 9);
    expect(top.filter((c) => c.tier === 1).map((c) => c.id).sort((a, b) => a - b)).toEqual([998, 1001]);
    expect(top.filter((c) => c.tier === 2).length).toBe(7);
    expect(top.filter((c) => c.tier === 3)).toEqual([]);
    expect(new Set(top.map((c) => c.id)).size).toBe(9);
    expect(top.map((c) => c.id).sort((a, b) => a - b)).toEqual(GOLDEN_NINE);
  });

  test("every tier-2 seat's reason is `declares-index`; no candidate anywhere carries the retired `closed-terminus` reason", () => {
    // The WHOLE fixture carries ELEVEN index declarers (measured), not just
    // the seven that make the budget-9 cut — 913/915/906/901 also declare,
    // rank below the seven above, and simply don't fit the budget. Tier 2's
    // own population is a candidacy fact, independent of `budget`.
    const tier2 = result.candidates.filter((c) => c.tier === 2);
    expect(tier2.length).toBe(11);
    for (const candidate of tier2) {
      expect(candidate.reason).toBe("declares-index");
    }
    for (const candidate of result.candidates) {
      expect(candidate.reason).not.toBe("closed-terminus");
    }
  });

  // The seven turns the OLD (pre-ticket-01) tier ② seated as lane termini,
  // named individually so a regression reddens here rather than only in the
  // aggregate above. Under ticket 02 each one seats again — same ids, new
  // reason — because each one is ITSELF the writer of the fixture's `indexes`
  // edge for its lane, independent of whether that lane had later members.
  test("922/929/939/946/981/984/990 — the seven index declarers — each hold a tier-2 seat, reason declares-index", () => {
    for (const id of [922, 929, 939, 946, 981, 984, 990]) {
      expect(tierOf(result, id)?.tier).toBe(2);
      expect(tierOf(result, id)?.reason).toBe("declares-index");
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
  // phase-connectivity ticket 03 (arm C): 957 carries `type: ["design"]` in
  // the real fixture data, so it now seats tier ③ (type-decision) on that
  // account alone — the pre-ticket tier ⑤ ("other") landing spot no longer
  // applies. The property this test exists for (NOT excluded, despite being
  // a tagged-override victim) still holds unchanged.
  test("957 (TAGGED override{write-gate} victim) is NOT excluded — its lane was never declared either way, and its own `design` type now seats it at tier ③ (type-decision) rather than the pre-ticket tier ⑤", () => {
    expect(result.excluded).not.toContain(957);
    expect(tierOf(result, 957)?.tier).toBe(3);
    expect(tierOf(result, 957)?.reason).toBe("type-decision");
  });

  // phase-connectivity ticket 03 (arm C): 958 carries `type: ["design",
  // "correction"]` in the real fixture data. Under "highest wins" this now
  // outranks the corrector signal its own untagged-lane override writes —
  // it seats tier ③ (type-decision), not the pre-ticket tier-4 corrector
  // seat. The property this test exists for (none of 950-955 hold a tier-2
  // seat — the write-gate lane was never declared) still holds unchanged.
  test("write-gate reads open with no declarer — none of its members hold a tier-2 seat for that lane; its own tagged-override writer (958) seats tier ③ (type-decision) instead, its `design`+`correction` type outranking the corrector signal its own override edge would otherwise earn", () => {
    for (const id of [950, 951, 952, 953, 954, 955]) {
      const candidate = tierOf(result, id);
      expect(candidate?.tier).not.toBe(2);
    }
    expect(tierOf(result, 958)?.tier).toBe(3);
    expect(tierOf(result, 958)?.reason).toBe("type-decision");
  });

  // 913 is tier ②'s own worked example of the within-tier ordering question
  // the spec's "Open" section names and this ticket must NOT resolve: it
  // writes FIVE `indexes` edges (a genuine large-batch convergence, the
  // largest out-degree of any tier-2 node in this fixture) yet its in-degree
  // is 0 (the lane's one cross-phase adoption lands mid-lane, never citing
  // 913 back). Leading with in-degree, it is the FIRST tier-2 node that
  // misses the budget-9 cut — one seat later and it would have displaced one
  // of the seven above. Leading with out-degree instead would rank it near
  // the top of tier 2, not the bottom; this is measured, not fixed — the key
  // stays in-degree-first, per ticket 02's own scope.
  test("913 holds a tier-2 seat (it declares five `indexes` edges) but is the first tier-2 node to miss the budget-9 cut — in-degree 0 despite out-degree 5", () => {
    const candidate = tierOf(result, 913);
    expect(candidate?.tier).toBe(2);
    expect(candidate?.reason).toBe("declares-index");
    expect(candidate?.inDegree).toBe(0);
    expect(candidate?.outDegree).toBe(5);
    expect(result.candidates.findIndex((c) => c.id === 913)).toBe(9); // rank 10 (0-indexed 9) — one past the budget-9 cut
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
    expect(tierOf(result, 1)?.tier).toBe(6);
    expect(tierOf(result, 1)?.reason).toBe("other");
    // The override's own writer is still a tier-5 corrector (phase-
    // connectivity ticket 03 renumbers this from tier 4) — an unrelated,
    // unconditional rule this ticket leaves untouched.
    expect(tierOf(result, 2)?.tier).toBe(5);
  });

  test("an untagged refutes victim STAYS a candidate too — the arm was word-blind, and so is its deletion", () => {
    const turns = [turn(1), turn(2)];
    const edges = [edge(2, "refutes", 1, [])];
    const result = electMilestones(turns, edges, 5);
    expect(result.excluded).toEqual([]);
    expect(tierOf(result, 1)?.tier).toBe(6);
  });

  test("a TAGGED override victim stays a candidate as well — the tag state never mattered once the arm was gone", () => {
    const turns = [turn(1), turn(2)];
    const edges = [edge(2, "override", 1, ["x"])];
    const result = electMilestones(turns, edges, 5);
    expect(result.excluded).toEqual([]);
    expect(tierOf(result, 1)?.tier).toBe(6);
    expect(tierOf(result, 2)?.tier).toBe(5);
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

    // Before ticket 11's own fix, ANY tag state on the override wholesale-
    // excluded R (id 10) from candidacy — the exact bug this test pins.
    expect(result.excluded).not.toContain(10);
    expect(tierOf(result, 10)).toBeDefined();
    // TICKET 02, decision 3 (no override gate): R declares THREE `indexes`
    // edges, so it seats at tier 2 on that account alone — and this fixture
    // gives it an INCOMING override besides (from X, tagged to lane a only).
    // No gate reads that incoming edge at all: R still seats. Deleting this
    // gate is deliberate — the rubric says an overridden node stays valid, and
    // version progression means every version node is overridden by its
    // successor, so a gate here would delete exactly the nodes that must not
    // go missing.
    expect(tierOf(result, 10)?.tier).toBe(2);
    expect(tierOf(result, 10)?.reason).toBe("declares-index");
    // X, the repair's own writer, is a tier-5 corrector regardless (phase-
    // connectivity ticket 03 renumbers this from tier 4) — an unconditional,
    // tag-independent rule this ticket leaves untouched.
    expect(tierOf(result, 20)?.tier).toBe(5);
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

// ------------------------------------------------------------------------
// TIER ② — this node declares an `index` edge (lane-state-retirement ticket
// 02, replacing the emptied tier ticket 01 left behind).
//
// Re-based on the NODE, not the lane: qualification no longer asks anything
// about lane membership or "newest member" — it reads `edges` directly for
// ANY `indexes` edge, any tag state, and seats its WRITER. Two consequences
// pinned individually below: (a) a lane the writer's own index is followed
// by MORE members still seats that writer — there is no more "last member"
// question (this IS the ticket's whole point, per its own acceptance
// criteria); (b) there is no override gate — an incoming `override` on the
// declaring node changes nothing (decision 3, pinned separately above by the
// "ticket 11 failure case" test, reused for this ticket's own acceptance bar
// too).
//
// EVERY SHAPE below is the same fixture ticket 01 kept as a "seats nobody"
// pin, now asserting the POSITIVE: each shape's own `indexes` WRITER holds a
// tier-2 seat, reason `declares-index`, and nobody else in the shape does.
// ------------------------------------------------------------------------

describe("tier 2 — this node declares an `index` edge (lane-state-retirement ticket 02)", () => {
  const shapes: readonly (readonly [string, MilestoneTurnInput[], LaneEdgeInput[], readonly number[]])[] = [
    [
      "a lane whose newest member wrote the index (the old plain closed-terminus seat) — 31 still seats, on its own account now",
      [turn(30), turn(31)],
      [edge(31, "extends", 30, ["v"]), edge(31, "indexes", 30, ["v"])],
      [31],
    ],
    [
      // THE TICKET'S WHOLE POINT (acceptance criterion 1): a fixture where the
      // lane has LATER members. 22 extends past 21's index — under the OLD
      // closed-terminus rule 21 would never qualify (it is not the lane's
      // newest member); under this ticket's rule it seats regardless, because
      // qualification reads 21's OWN edge, not "is 21 still the newest".
      "a lane that lives ON past its own index — 21 seats though 22 extends past it; a task that converges more than once shows more than one wrap-up",
      [turn(20), turn(21), turn(22)],
      [
        edge(21, "extends", 20, ["cont"]),
        edge(21, "indexes", 20, ["cont"]),
        edge(22, "extends", 21, ["cont"]),
      ],
      [21],
    ],
    [
      "the lane that used to read closed-INVALID (override, then index over it) — 13, the index writer, seats; 11 and 12 do not, neither ever writes an `indexes` edge itself",
      [turn(10), turn(11), turn(12), turn(13)],
      [
        edge(11, "extends", 10, ["dead-core"]),
        edge(12, "override", 11, ["dead-core"]),
        edge(13, "indexes", 11, ["dead-core"]),
      ],
      [13],
    ],
    [
      "the MERGE: a multi-tag override, then a later re-declaration of the same lane — 4, the writer, seats; 1 (the CITED node, target of both the override and the index) never seats tier 2 on its own account",
      [turn(1), turn(3), turn(4)],
      [edge(3, "override", 1, ["a", "c"]), edge(4, "indexes", 1, ["a"])],
      [4],
    ],
    [
      "ticket 19's crossing: an index written FROM lane a INTO lane b — 2, the writer, seats regardless of the cross-lane tag mismatch",
      [turn(1), turn(2)],
      [edge(2, "indexes", 1, [], { tailTag: "a", headTag: "b" })],
      [2],
    ],
    [
      "a lane with no index anywhere in it — still not one tier-2 seat; the rule needs an actual `indexes` edge, no fallback",
      [turn(401), turn(402), turn(403)],
      [edge(402, "extends", 401, ["silent"]), edge(403, "extends", 402, ["silent"])],
      [],
    ],
  ];

  for (const [name, turns, edges, expectedTier2Ids] of shapes) {
    test(`${name}`, () => {
      const result = electMilestones(turns, edges, 5);
      const tier2Ids = result.candidates
        .filter((c) => c.tier === 2)
        .map((c) => c.id)
        .sort((a, b) => a - b);
      expect(tier2Ids).toEqual([...expectedTier2Ids].sort((a, b) => a - b));
      for (const id of expectedTier2Ids) {
        expect(tierOf(result, id)?.reason).toBe("declares-index");
      }
    });
  }

  // The REASON word is gone too, from the type and from every output — ticket
  // 02's acceptance depends on no `closed-terminus` surviving anywhere.
  test("no candidate anywhere carries the retired `closed-terminus` reason", () => {
    for (const [, turns, edges] of shapes) {
      const result = electMilestones(turns, edges, 5);
      for (const candidate of result.candidates) {
        expect(candidate.reason).not.toBe("closed-terminus");
      }
    }
  });

  // TIER ④'s RULE IS UNCHANGED (decision 2; phase-connectivity ticket 03
  // renumbers this tier from ③ to ④ — arm C inserts type-decision ahead of
  // it): it still reads the `indexes` edges of whichever tier-①/② nodes made
  // the stage-1 "elected" cut. The crossing above seats 2 at tier 2, and 2
  // is elected (budget 5 comfortably covers a field of one), so 1 — the node
  // 2 indexes — now gets its tier-4 seat back. This is tier 4's population
  // GROWING because tier 2's did, not an edit to tier 4's own rule.
  test("tier 4's population follows tier 2's — an ELECTED tier-2 indexer grants its indexed node a tier-4 seat", () => {
    const result = electMilestones(
      [turn(1), turn(2)],
      [edge(2, "indexes", 1, [], { tailTag: "a", headTag: "b" })],
      5,
    );
    expect(tierOf(result, 2)?.tier).toBe(2);
    expect(tierOf(result, 2)?.reason).toBe("declares-index");
    expect(tierOf(result, 1)?.tier).toBe(4);
    expect(tierOf(result, 1)?.reason).toBe("indexed-by-elected");
  });
});

describe("'highest wins' — a node qualifying for BOTH tier 1 and tier 2 shows tier 1", () => {
  test("a lane terminus that ALSO writes an unrelated untagged indexes edge is tier 1, not tier 2", () => {
    const turns = [turn(1), turn(2), turn(3)];
    const edges = [
      edge(2, "extends", 1, ["x"]),
      edge(2, "indexes", 1, ["x"]), // tier-2 qualifying: 2 itself writes this TAGGED indexes edge
      edge(2, "indexes", 3, []), // tier-1 qualifying: untagged-indexes writer
    ];
    const result = electMilestones(turns, edges, 5);
    expect(tierOf(result, 2)?.tier).toBe(1);
    expect(tierOf(result, 2)?.reason).toBe("release");
  });
});

describe("tier 4 — indexed by an ELECTED tier-1/2 node, a genuine two-stage fill gated by `budget` (phase-connectivity ticket 03 renumbers this tier from ③ to ④)", () => {
  test("a node indexed by a tier-1 writer that MAKES the stage-1 cut becomes tier 4", () => {
    const turns = [turn(1), turn(2), turn(5), turn(6)];
    const edges = [
      edge(1, "indexes", 5, []), // untagged: 1 is tier 1, indexes 5
      edge(2, "indexes", 6, []), // untagged: 2 is also tier 1, indexes 6
      edge(3, "grounds", 1, []), // boosts 1's in-degree above 2's so 1 wins the budget-1 cut deterministically
    ];
    const result = electMilestones(turns, edges, 1); // budget 1: only ONE of {1,2} is "elected"
    expect(tierOf(result, 1)?.tier).toBe(1); // 1 wins the cut (higher in-degree)
    expect(tierOf(result, 5)?.tier).toBe(4);
    expect(tierOf(result, 5)?.reason).toBe("indexed-by-elected");
  });

  test("a node indexed ONLY by a tier-1/2 node that LOSES the stage-1 cut (budget exhausted) does NOT become tier 4 — the boundary is the elected SUBSET, not tier-1/2 qualification alone", () => {
    const turns = [turn(1), turn(2), turn(5), turn(6)];
    const edges = [
      edge(1, "indexes", 5, []),
      edge(2, "indexes", 6, []),
      edge(3, "grounds", 1, []), // 1 outranks 2
    ];
    const result = electMilestones(turns, edges, 1); // budget 1: 2 does NOT make the cut
    expect(tierOf(result, 2)?.tier).toBe(1); // 2 is still legitimately tier 1 itself...
    expect(tierOf(result, 6)?.tier).not.toBe(4); // ...but its OWN indexing grants no tier-4 seat, since 2 was not elected
  });

  // Ticket 02's own acceptance bar: tier 4's RULE is unchanged, so the same
  // two-stage-fill guarantee must hold with tier-② CANDIDATES feeding stage 1
  // instead of tier-①'s. Both edges here are TAGGED (not tier 1) so tier 2 is
  // the only qualification in play.
  test("a node indexed by a tier-2 writer that MAKES the stage-1 cut becomes tier 4", () => {
    const turns = [turn(1), turn(2), turn(5), turn(6)];
    const edges = [
      edge(1, "indexes", 5, ["a"]), // tagged: 1 is tier 2, indexes 5
      edge(2, "indexes", 6, ["b"]), // tagged: 2 is also tier 2, indexes 6
      edge(3, "grounds", 1, []), // boosts 1's in-degree above 2's so 1 wins the budget-1 cut deterministically
    ];
    const result = electMilestones(turns, edges, 1); // budget 1: only ONE of {1,2} is "elected"
    expect(tierOf(result, 1)?.tier).toBe(2); // 1 wins the cut (higher in-degree)
    expect(tierOf(result, 1)?.reason).toBe("declares-index");
    expect(tierOf(result, 5)?.tier).toBe(4);
    expect(tierOf(result, 5)?.reason).toBe("indexed-by-elected");
  });

  test("a node indexed ONLY by a tier-2 writer that LOSES the stage-1 cut (budget exhausted) does NOT become tier 4 — a tier-2 candidate that qualifies but is not elected grants no tier-4 seat to anyone", () => {
    const turns = [turn(1), turn(2), turn(5), turn(6)];
    const edges = [
      edge(1, "indexes", 5, ["a"]),
      edge(2, "indexes", 6, ["b"]),
      edge(3, "grounds", 1, []), // 1 outranks 2
    ];
    const result = electMilestones(turns, edges, 1); // budget 1: 2 does NOT make the cut
    expect(tierOf(result, 2)?.tier).toBe(2); // 2 is still legitimately tier 2 itself...
    expect(tierOf(result, 6)?.tier).not.toBe(4); // ...but its OWN indexing grants no tier-4 seat, since 2 was not elected
  });
});

describe("tier 5 — correctors: override writers, or citers of a rolled-back turn (phase-connectivity ticket 03 renumbers this tier from ④ to ⑤)", () => {
  test("a node writing an override edge (any tags) is a corrector, absent a higher tier", () => {
    const turns = [turn(1), turn(2)];
    const edges = [edge(2, "override", 1, [])];
    const result = electMilestones(turns, edges, 5);
    expect(tierOf(result, 2)?.tier).toBe(5);
    expect(tierOf(result, 2)?.reason).toBe("corrector");
  });

  test("a node citing (any relation) a turn marked wasRolledBack is a corrector, absent a higher tier", () => {
    const turns = [turn(50, { wasRolledBack: true }), turn(51)];
    const edges = [edge(51, "grounds", 50, [])];
    const result = electMilestones(turns, edges, 5);
    expect(tierOf(result, 50)).toBeUndefined(); // 50 itself is excluded (rolled-back)
    expect(tierOf(result, 51)?.tier).toBe(5);
    expect(tierOf(result, 51)?.reason).toBe("corrector");
  });
});

describe("tier 6 — everything else (phase-connectivity ticket 03 renumbers this tier from ⑤ to ⑥)", () => {
  test("a node with no qualifying signal at all is tier 6", () => {
    const turns = [turn(1), turn(2)];
    const edges = [edge(2, "consume", 1, [])];
    const result = electMilestones(turns, edges, 5);
    expect(tierOf(result, 2)?.tier).toBe(6);
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
  // from candidacy either, so the node now surfaces at tier 6 (phase-
  // connectivity ticket 03 renumbers "other" from ⑤ to ⑥) with in-degree 0
  // rather than vanishing.
  test("override/refutes contribute no in-degree, and no longer exclude their target — it surfaces at tier 6 with in-degree 0", () => {
    const turns = [turn(1), turn(2), turn(3)];
    const edges = [edge(2, "override", 1, []), edge(3, "refutes", 1, [])];
    const result = electMilestones(turns, edges, 5);
    expect(result.excluded).toEqual([]);
    expect(tierOf(result, 1)?.tier).toBe(6);
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
  test("with zero edges and no design/correction-typed turn, every surviving turn is tier 6 with zero degree, and the later-turn tiebreak alone produces pure recency order", () => {
    const turns = [turn(1), turn(2), turn(3)];
    const result = electMilestones(turns, [], 5);
    expect(result.candidates.every((c) => c.tier === 6 && c.inDegree === 0 && c.outDegree === 0)).toBe(
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
    // the now-elected T1) becomes tier 4 (phase-connectivity ticket 03
    // renumbers "indexed-by-elected" from ③ to ④). T3's only indexers are
    // external and can never be "elected" (they never enter stage 1 at
    // all), so T3 gets no tier-4 seat and falls to tier 6 ("other",
    // renumbered from ⑤) — though its in-degree still counts both external
    // edges, proving they stayed graph nodes.
    expect(tierOf(result, 1)?.tier).toBe(1);
    expect(tierOf(result, 2)?.tier).toBe(4);
    expect(tierOf(result, 2)?.reason).toBe("indexed-by-elected");
    expect(tierOf(result, 3)?.tier).toBe(6);
    expect(tierOf(result, 3)?.inDegree).toBe(2);

    expect(result.candidates.slice(0, 2).map((c) => c.id)).toEqual([1, 2]);
  });
});

describe("R1 #1(b) — an external node never becomes a candidate no matter what it declares, though its edges still shape degree (pinned counterexample)", () => {
  // Tier 2 is re-based on the NODE (ticket 02): there is no more "which
  // declaration wins the lane" question for an external competitor to win —
  // T2 seats on its OWN account regardless of what any other node, external
  // or not, also declares. What this pair still pins is the ELIGIBILITY half
  // of R1 #1: T99 (eligible:false) is a graph node only — it never becomes a
  // candidate, so it can never be "elected" either, however qualifying its
  // own edge looks, and however much later its (real, supplied) order is.
  test("window member T2 (real order [5,10]) declares an index; external LATER T99, supplied with its REAL order [5,20] and eligible:false, declares the identical index — T2 still seats at tier 2 on its own account, and T99 seats nowhere", () => {
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
    expect(tierOf(result, 2)?.tier).toBe(2);
    expect(tierOf(result, 2)?.reason).toBe("declares-index");
    expect(tierOf(result, 99)).toBeUndefined();
    // T1 is indexed by the ELECTED T2 — tier 4 (phase-connectivity ticket 03
    // renumbers "indexed-by-elected" from ③ to ④). T99's identical edge
    // grants no tier-4 seat to anyone: T99 is never a candidate, so it can
    // never be "elected" either (step 0's eligibility boundary, R1 #1) — but
    // its edge still counts toward T1's in-degree below.
    expect(tierOf(result, 1)?.tier).toBe(4);
    expect(tierOf(result, 1)?.inDegree).toBe(2);
  });

  test("contrast — WITHOUT T99 supplied in turns[] at all (the adapter omitting the external-metadata fetch): T99 is still never a candidate, and T2's own declaration still seats it at tier 2 exactly as above", () => {
    const turns = [turn(1), turn(2, { order: [5, 10] })]; // T99 never supplied
    const edges = [
      edge(2, "indexes", 1, ["x"]),
      edge(99, "indexes", 1, ["x"]), // T99 touches the graph only via this edge
    ];
    const result = electMilestones(turns, edges, 5);
    // This is the documented caveat, not a fix: the CORE'S eligibility
    // boundary alone cannot recover a real order the caller never supplied
    // — `mcp/timeline.ts`'s `fetchExternalElectionTurns` is what closes
    // this gap in production (R1 #1's adapter half). It makes no difference
    // here, because tier 2 no longer asks any lane-declaration-fold question
    // T99's order could have won or lost — T2 seats on its own account either
    // way, and T99 was never eligible regardless of what its order says.
    expect(tierOf(result, 2)?.tier).toBe(2);
    expect(tierOf(result, 99)).toBeUndefined();
    expect(tierOf(result, 1)?.tier).toBe(4);
    expect(tierOf(result, 1)?.inDegree).toBe(2);
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
  test("an id in rolledBackCiterIds tiers 5 (corrector, renumbered from ④ by phase-connectivity ticket 03) even with zero edges naming it at all", () => {
    const turns = [turn(1), turn(2)];
    const result = electMilestones(turns, [], 5, [2]);
    expect(tierOf(result, 2)?.tier).toBe(5);
    expect(tierOf(result, 2)?.reason).toBe("corrector");
  });

  test("'highest wins' still applies: an id in rolledBackCiterIds that independently earns a higher tier is NOT demoted to corrector", () => {
    const turns = [turn(1), turn(2)];
    const edges = [edge(2, "indexes", 1, [])]; // untagged indexes -> tier-1 release
    const result = electMilestones(turns, edges, 5, [2]);
    expect(tierOf(result, 2)?.tier).toBe(1);
  });
});

// ------------------------------------------------ phase-connectivity ticket 03

describe("type-decision tier — phase-connectivity ticket 03, arm C of the round-2 ablation", () => {
  test("a design/correction-typed turn with no qualifying edge seats tier ③, between declares-index (②) and indexed-by-elected (④) — the SAME turn with a neutral type would land tier ⑥ instead", () => {
    const turns = [turn(1), turn(2, { type: ["design"] }), turn(5)];
    // 1 declares a TAGGED index -> tier 2; grants 5 a tier-4 seat once 1 is elected.
    const edges = [edge(1, "indexes", 5, ["x"])];
    const result = electMilestones(turns, edges, 5);

    expect(tierOf(result, 1)?.tier).toBe(2);
    expect(tierOf(result, 1)?.reason).toBe("declares-index");
    expect(tierOf(result, 2)?.tier).toBe(3);
    expect(tierOf(result, 2)?.reason).toBe("type-decision");
    expect(tierOf(result, 5)?.tier).toBe(4);
    expect(tierOf(result, 5)?.reason).toBe("indexed-by-elected");

    // The returned ranking order IS ①②③④ — id 2 seats strictly between the
    // declarer and the indexed-by-elected node.
    const rankOf = (id: number) => result.candidates.findIndex((c) => c.id === id);
    expect(rankOf(1)).toBeLessThan(rankOf(2));
    expect(rankOf(2)).toBeLessThan(rankOf(5));

    // The counterfactual this test exists to pin: WITHOUT the design type,
    // turn 2 has no qualifying signal at all and lands tier ⑥ ("other") — the
    // pre-ticket tier ⑤ landing spot, renumbered by this ticket's insertion.
    const baseline = electMilestones([turn(1), turn(2), turn(5)], edges, 5);
    expect(tierOf(baseline, 2)?.tier).toBe(6);
    expect(tierOf(baseline, 2)?.reason).toBe("other");
  });

  test("`correction` alone also qualifies — the predicate is a set intersection, not a `design`-only check", () => {
    const turns = [turn(1, { type: ["correction"] })];
    const result = electMilestones(turns, [], 5);
    expect(tierOf(result, 1)?.tier).toBe(3);
    expect(tierOf(result, 1)?.reason).toBe("type-decision");
  });

  // phase-connectivity ticket 01's own language: "a genuine compound entering
  // the [C decision] tier is a correct outcome, not pollution" — a landing
  // word (implement/fix/refactor) alongside design/correction still seats
  // tier ③ on the SAME account as any other qualifying node.
  test("a compound type (a landing word plus a basis word together) qualifies exactly like any other design/correction turn", () => {
    const turns = [turn(1, { type: ["implement", "design"] })];
    const result = electMilestones(turns, [], 5);
    expect(tierOf(result, 1)?.tier).toBe(3);
    expect(tierOf(result, 1)?.reason).toBe("type-decision");
  });

  test("neither design nor correction: ops/implement alone do not qualify", () => {
    const turns = [turn(1, { type: ["ops", "implement"] })];
    const result = electMilestones(turns, [], 5);
    expect(tierOf(result, 1)?.tier).toBe(6);
    expect(tierOf(result, 1)?.reason).toBe("other");
  });
});

describe("decisionTierShare — the share sentinel's own pure computation (phase-connectivity ticket 03, decision 2)", () => {
  test("denominator is the RANKED candidate set (eligible, non-excluded) — an excluded (rolled-back) turn is not counted on either side", () => {
    const turns = [
      turn(1, { type: ["design"] }),
      turn(2, { type: ["design"] }),
      turn(3, { wasRolledBack: true, type: ["design"] }),
    ];
    const result = electMilestones(turns, [], 5);
    // 3 turns, 1 excluded -> 2 ranked candidates, both design -> share 1.
    expect(result.candidates.length).toBe(2);
    expect(result.decisionTierShare).toBeCloseTo(1, 6);
  });

  test("an eligible:false graph-only entry is never counted in the denominator either — it never reaches candidateIds", () => {
    const turns = [turn(1, { type: ["design"] }), turn(99, { type: ["design"], eligible: false })];
    const result = electMilestones(turns, [], 5);
    expect(result.candidates.length).toBe(1);
    expect(result.decisionTierShare).toBeCloseTo(1, 6);
  });

  // phase-connectivity ticket 01's own language: "a genuine compound entering
  // the tier is a correct outcome, not pollution" — decision 2 pins the
  // consequence for the SHARE specifically: a compound counts in the
  // numerator like any other qualifying node, nothing discounts it.
  test("a compound (landing + basis) turn counts in the numerator like any other qualifying node", () => {
    const turns = [
      turn(1, { type: ["implement", "design"] }), // compound: landing word + basis word
      turn(2, { type: ["ops"] }),
    ];
    const result = electMilestones(turns, [], 5);
    expect(result.decisionTierShare).toBeCloseTo(0.5, 6);
  });

  test("straddling the 45% guard rail: 2 of 5 (0.40) sits at/under threshold, 3 of 5 (0.60) sits over it — the module itself never compares against the threshold, it only reports the ratio", () => {
    const under = electMilestones(
      [
        turn(1, { type: ["design"] }),
        turn(2, { type: ["design"] }),
        turn(3),
        turn(4),
        turn(5),
      ],
      [],
      5,
    );
    expect(under.decisionTierShare).toBeCloseTo(0.4, 6);
    expect(under.decisionTierShare).toBeLessThanOrEqual(DECISION_TIER_SHARE_WARN_THRESHOLD);

    const over = electMilestones(
      [
        turn(1, { type: ["design"] }),
        turn(2, { type: ["design"] }),
        turn(3, { type: ["correction"] }),
        turn(4),
        turn(5),
      ],
      [],
      5,
    );
    expect(over.decisionTierShare).toBeCloseTo(0.6, 6);
    expect(over.decisionTierShare).toBeGreaterThan(DECISION_TIER_SHARE_WARN_THRESHOLD);
  });

  test("zero candidates -> share is 0, not NaN", () => {
    const result = electMilestones([], [], 5);
    expect(result.decisionTierShare).toBe(0);
  });
});
