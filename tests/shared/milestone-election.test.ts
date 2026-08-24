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

  test("925 (untagged override victim) and 935 (untagged refutes victim, by 941) are excluded from candidacy entirely — never in `candidates`, always in `excluded`", () => {
    for (const id of [925, 935]) {
      expect(tierOf(result, id)).toBeUndefined();
      expect(result.excluded).toContain(id);
    }
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

  test("913 (ownership's terminus) IS a legitimate closed-valid tier-2 candidate but loses the top-9 cut — its own in-degree is 0 because the lane's one cross-phase adoption (T936 grounds T910) lands mid-lane, not on the terminus (spec's stated non-goal)", () => {
    const candidate = tierOf(result, 913);
    expect(candidate?.tier).toBe(2);
    expect(candidate?.reason).toBe("closed-valid-terminus");
    expect(candidate?.inDegree).toBe(0);
    expect(result.candidates.slice(0, 9).some((c) => c.id === 913)).toBe(false);
  });
});

// ---------------------------------------------------------------- candidacy exclusion

describe("candidacy exclusion — step 1, lane-scoped (ticket 11): untagged excludes globally, tagged does not exclude at all", () => {
  test("an untagged override victim leaves candidacy — a global repudiation", () => {
    const turns = [turn(1), turn(2)];
    const edges = [edge(2, "override", 1, [])];
    const result = electMilestones(turns, edges, 5);
    expect(tierOf(result, 1)).toBeUndefined();
    expect(result.excluded).toEqual([1]);
  });

  test("a TAGGED override victim does NOT leave candidacy at all (ticket 11) — only an untagged override is the global repudiation; with no other qualifying signal it falls to tier 5, and its own lane (undeclared) grants it no tier-2 seat either", () => {
    const turns = [turn(1), turn(2)];
    const edges = [edge(2, "override", 1, ["x"])];
    const result = electMilestones(turns, edges, 5);
    expect(result.excluded).not.toContain(1);
    expect(tierOf(result, 1)?.tier).toBe(5);
    expect(tierOf(result, 1)?.reason).toBe("other");
    // The override's own writer is still a tier-4 corrector — candidacy
    // exclusion of the CITED side is unrelated to that unconditional rule.
    expect(tierOf(result, 2)?.tier).toBe(4);
  });

  test("an untagged refutes victim leaves candidacy — a global repudiation", () => {
    const turns = [turn(1), turn(2)];
    const edges = [edge(2, "refutes", 1, [])];
    const result = electMilestones(turns, edges, 5);
    expect(tierOf(result, 1)).toBeUndefined();
    expect(result.excluded).toEqual([1]);
  });

  test("a refutes victim carrying tags does NOT leave candidacy either (ticket 11) — refutes carries no lane-state event of its own in lane-interpretation.ts (only indexes/override do), so a tagged victim's tier is decided purely by whatever OTHER signal it independently qualifies for (here, none — tier 5)", () => {
    const turns = [turn(1), turn(2)];
    const edges = [edge(2, "refutes", 1, ["x"])];
    const result = electMilestones(turns, edges, 5);
    expect(result.excluded).not.toContain(1);
    expect(tierOf(result, 1)?.tier).toBe(5);
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
    // R still holds a tier-2 seat (via lane b or c's closed-valid terminus,
    // or lane a's own now-open last-declarer — whichever the tier-②
    // dedup-by-first-lane happens to label; the SEAT is what this ticket
    // guarantees, not which specific lane's reason wins the label).
    expect(tierOf(result, 10)?.tier).toBe(2);
    // X, the repair's own writer, is a tier-4 corrector regardless — an
    // unconditional, tag-independent rule this ticket leaves untouched.
    expect(tierOf(result, 20)?.tier).toBe(4);
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

  // Ticket 11 re-baselines this fixture too: under the OLD (retired) uniform
  // rule, step 1 excluded 102 outright (it is the reopening override's own
  // target), so this never surfaced. Under the fix, a TAGGED override is
  // lane-local and no longer excludes its target from candidacy at all — 102
  // now reaches tier 2 as lane `x`'s own `lastDeclarer` (`deriveLaneStates`,
  // lane-interpretation.ts). Note this is a genuine latent quirk the fix
  // exposes, not one it resolves: `LaneState.lastDeclarer` does not itself
  // consult `LaneMember.dead`, so 102 seats via the SAME lane that just
  // marked it dead — that computation belongs to lane-interpretation.ts
  // (out of this ticket's file ownership), not this module.
  test("ticket 11: an override-REOPENED lane's last declarer is no longer wholesale-excluded when the override is TAGGED — it now seats at tier 2 as the lane's own open-last-declarer, even though it is also dead in that same lane", () => {
    const turns = [turn(101), turn(102), turn(103)];
    const edges = [
      edge(102, "extends", 101, ["x"]),
      edge(102, "indexes", 101, ["x"]),
      edge(103, "override", 102, ["x"]), // reopens; 102 is BOTH the pre-override last declarer AND the override's own (lane-local) target
    ];
    const result = electMilestones(turns, edges, 5);
    expect(result.excluded).not.toContain(102);
    expect(tierOf(result, 102)?.tier).toBe(2);
    expect(tierOf(result, 102)?.reason).toBe("open-last-declarer");
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

  // THE MERGE (lane-declaration spec Rev 2, D5) RE-BASELINES A TIER — the
  // ticket's own acceptance bar ("any tier that changes is listed... a
  // quietly updated expectation is a failed acceptance"). Same
  // repudiate-then-declare shape as the test above, but the repudiating
  // override is tagged `{a,c}`, not the bare `{a}` its own declaration uses.
  //
  //   - OLD (retired) exact-set identity: `{a,c}` is a third, INDEPENDENT
  //     lane from `{a}` — the override never touches `{a}` at all, T1 stays
  //     alive there, T4's later `indexes{a}` declares a CLOSED-VALID
  //     terminus -> **tier 2** ("closed-valid-terminus"), verified by
  //     running this exact fixture with the override retagged to a
  //     genuinely unrelated tag (`["ac"]`, isolating it the way `{a,c}`
  //     used to be isolated): T4 reads tier 2 there.
  //   - NEW (merge): the override carries tag `a`, so it ALSO fires in lane
  //     `{a}` — T1 dies in-lane before T4's declaration ever runs, T4's
  //     declared core is `[T1]`, entirely dead -> closed-INVALID, no tier-2
  //     seat. T4 falls through to **tier 5** ("other"): not an
  //     untagged-indexes writer (tier 1), no elected node indexes it (tier
  //     3), and it wrote no override and cites no rolled-back turn (tier 4).
  //
  // T3 (the override's own writer) is tier 4 in BOTH readings — candidacy
  // exclusion and the corrector tier are raw edge-relation facts, unrelated
  // to lane identity, so this fixture isolates the ONE thing that actually
  // moved.
  // Ticket 11 re-baselines this fixture's LAST assertion: T1's own
  // override{a,c} is TAGGED, so (unlike when this test was first written)
  // it no longer wholesale-excludes T1 from candidacy — it acts only on
  // lanes `a`/`c`. T1 gets no tier-2 seat from EITHER (lane `a` is
  // closed-invalid — its own declared core, T1, is dead; lane `c` is
  // undeclared, "open, no declarer, no seat"), and nothing else qualifies
  // it, so it now surfaces as an ordinary tier-5 candidate instead of
  // vanishing into `excluded`. The tier-4/tier-5 facts about T3/T4 (the
  // actual "merge" this fixture demonstrates) are untouched.
  test("the merge: a multi-tag override that used to name an unrelated lane now invalidates a lane it shares only one tag with, and a terminus drops from tier 2 to tier 5", () => {
    const turns = [turn(1), turn(3), turn(4)];
    const edges = [
      edge(3, "override", 1, ["a", "c"]), // repudiate T1 first — shares tag `a` with the lane below
      edge(4, "indexes", 1, ["a"]), // then declare closure, indexing the now-dead-in-{a} T1
    ];
    const result = electMilestones(turns, edges, 5);
    expect(tierOf(result, 4)?.tier).toBe(5);
    expect(tierOf(result, 4)?.reason).toBe("other");
    expect(tierOf(result, 3)?.tier).toBe(4);
    expect(tierOf(result, 3)?.reason).toBe("corrector");
    expect(result.excluded).not.toContain(1);
    expect(tierOf(result, 1)?.tier).toBe(5);
    expect(tierOf(result, 1)?.reason).toBe("other");
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
    expect(tierOf(result, 2)?.reason).toBe("closed-valid-terminus");
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
