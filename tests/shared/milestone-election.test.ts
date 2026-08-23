import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  electMilestones,
  type LaneEdgeInput,
  type MilestoneTurnInput,
} from "../../src/shared/milestone-election";

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
): LaneEdgeInput => ({ citingId, relation, citedId, tags });

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
const fixtureEdges: LaneEdgeInput[] = fixture.edges.map((e) => ({
  citingId: e.citingId,
  relation: e.relation,
  citedId: e.citedId,
  tags: e.tags,
}));

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

  test("922/929/939/946/981/984/990 are the seven closed-valid termini seated at tier 2", () => {
    for (const id of [922, 929, 939, 946, 981, 984, 990]) {
      expect(tierOf(result, id)?.tier).toBe(2);
      expect(tierOf(result, id)?.reason).toBe("closed-valid-terminus");
    }
  });

  test("925 (untagged override victim), 957 (tagged override victim), and 935 (refuted by 941) are excluded from candidacy entirely — never in `candidates`, always in `excluded`", () => {
    for (const id of [925, 957, 935]) {
      expect(tierOf(result, id)).toBeUndefined();
      expect(result.excluded).toContain(id);
    }
  });

  test("write-gate reads open with no declarer — none of its members hold a tier-2 seat for that lane; its own tagged-override writer (958) is a tier-4 corrector instead", () => {
    for (const id of [950, 951, 952, 953, 954, 955]) {
      const candidate = tierOf(result, id);
      expect(candidate?.tier).not.toBe(2);
    }
    expect(tierOf(result, 958)?.tier).toBe(4);
    expect(tierOf(result, 958)?.reason).toBe("corrector");
  });

  test("913 (ownership's terminus) IS a legitimate closed-valid tier-2 candidate but loses the top-9 cut — its own in-degree is 0 because the lane's one cross-phase adoption (T936 grounds T910) lands mid-lane, not on the terminus (spec's stated non-goal)", () => {
    const candidate = tierOf(result, 913);
    expect(candidate?.tier).toBe(2);
    expect(candidate?.reason).toBe("closed-valid-terminus");
    expect(candidate?.inDegree).toBe(0);
    expect(result.candidates.slice(0, 9).some((c) => c.id === 913)).toBe(false);
  });
});

// ---------------------------------------------------------------- candidacy exclusion

describe("candidacy exclusion — step 1, uniform regardless of tag state", () => {
  test("an untagged override victim leaves candidacy", () => {
    const turns = [turn(1), turn(2)];
    const edges = [edge(2, "override", 1, [])];
    const result = electMilestones(turns, edges, 5);
    expect(tierOf(result, 1)).toBeUndefined();
    expect(result.excluded).toEqual([1]);
  });

  test("a TAGGED override victim leaves candidacy just as fully as an untagged one", () => {
    const turns = [turn(1), turn(2)];
    const edges = [edge(2, "override", 1, ["x"])];
    const result = electMilestones(turns, edges, 5);
    expect(tierOf(result, 1)).toBeUndefined();
    expect(result.excluded).toEqual([1]);
  });

  test("an untagged refutes victim leaves candidacy", () => {
    const turns = [turn(1), turn(2)];
    const edges = [edge(2, "refutes", 1, [])];
    const result = electMilestones(turns, edges, 5);
    expect(tierOf(result, 1)).toBeUndefined();
    expect(result.excluded).toEqual([1]);
  });

  test("a refutes victim leaves candidacy even carrying tags (this module does not validate relation legality — that is turn-phase.ts's business, not this one's)", () => {
    const turns = [turn(1), turn(2)];
    const edges = [edge(2, "refutes", 1, ["x"])];
    const result = electMilestones(turns, edges, 5);
    expect(tierOf(result, 1)).toBeUndefined();
    expect(result.excluded).toEqual([1]);
  });

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

// ---------------------------------------------------------------- identity tiers

describe("tier 1 — untagged-indexes writers (releases)", () => {
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
});

describe("tier 2 — closed-valid termini and open lanes' last declarer", () => {
  test("a closed-valid lane's terminus is tier 2", () => {
    const turns = [turn(30), turn(31)];
    const edges = [edge(31, "extends", 30, ["v"]), edge(31, "indexes", 30, ["v"])];
    const result = electMilestones(turns, edges, 5);
    expect(tierOf(result, 31)?.tier).toBe(2);
    expect(tierOf(result, 31)?.reason).toBe("closed-valid-terminus");
  });

  test("an OPEN lane's last declarer (still open because structural activity continued past its own declaration, no re-declaration) is tier 2 with reason open-last-declarer, not closed-valid-terminus", () => {
    const turns = [turn(20), turn(21), turn(22)];
    const edges = [
      edge(21, "extends", 20, ["cont"]),
      edge(21, "indexes", 20, ["cont"]), // declares at 21
      edge(22, "extends", 21, ["cont"]), // continuation past the declaration -> lane reads OPEN
    ];
    const result = electMilestones(turns, edges, 5);
    expect(tierOf(result, 21)?.tier).toBe(2);
    expect(tierOf(result, 21)?.reason).toBe("open-last-declarer");
  });

  test("an override-REOPENED lane's last declarer never actually seats at tier 2 — the node the reopening override targeted is EXACTLY the pre-override last declarer, and step-1 excludes any override target outright, whatever tag state; reopening structurally always self-excludes its own candidate", () => {
    const turns = [turn(101), turn(102), turn(103)];
    const edges = [
      edge(102, "extends", 101, ["x"]),
      edge(102, "indexes", 101, ["x"]),
      edge(103, "override", 102, ["x"]), // reopens; 102 is BOTH the pre-override last declarer AND the override's own target
    ];
    const result = electMilestones(turns, edges, 5);
    expect(tierOf(result, 102)).toBeUndefined();
    expect(result.excluded).toContain(102);
  });

  test("an invalid closed lane's terminus holds NO tier-2 seat — the entire declared core is dead (repudiate-then-declare: kill 11, then 13 declares closure indexing the dead core)", () => {
    const turns = [turn(10), turn(11), turn(12), turn(13)];
    const edges = [
      edge(11, "extends", 10, ["dead"]),
      edge(12, "override", 11, ["dead"]), // kill the wrong conclusion first
      edge(13, "indexes", 11, ["dead"]), // then declare closure indexing the now-dead core
    ];
    const result = electMilestones(turns, edges, 5);
    expect(tierOf(result, 13)?.tier).not.toBe(2);
    expect(tierOf(result, 13)?.tier).toBe(5);
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

  test("override/refutes targeting a node exclude it from candidacy outright — a node touched only by those two words never appears among `candidates` to have an in-degree at all", () => {
    const turns = [turn(1), turn(2), turn(3)];
    const edges = [edge(2, "override", 1, []), edge(3, "refutes", 1, [])];
    const result = electMilestones(turns, edges, 5);
    expect(tierOf(result, 1)).toBeUndefined();
    expect(result.excluded).toEqual([1]);
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
