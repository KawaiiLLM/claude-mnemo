import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  checkLanes,
  type LaneEdgeInput,
  type LaneTurnInput,
} from "../../src/shared/lane-checker";

const design = (id: number, type: string[] = ["design"]): LaneTurnInput => ({ id, type });
const edge = (
  citingId: number,
  relation: string,
  citedId: number,
  tags: string[] = [],
): LaneEdgeInput => ({ citingId, relation, citedId, tags });

const tagSetSignature = (tags: readonly string[]) => [...new Set(tags)].sort().join("");

function findLaneStats(result: ReturnType<typeof checkLanes>, tagSet: string[]) {
  const signature = tagSetSignature(tagSet);
  return result.lanes.find((lane) => tagSetSignature(lane.key.tagSet) === signature);
}
function findComponent(result: ReturnType<typeof checkLanes>, tagSet: string[]) {
  const signature = tagSetSignature(tagSet);
  return result.components.find((c) => tagSetSignature(c.key.tagSet) === signature);
}
function findPath(result: ReturnType<typeof checkLanes>, tagSet: string[]) {
  const signature = tagSetSignature(tagSet);
  return result.paths.find((p) => tagSetSignature(p.key.tagSet) === signature);
}

// ---------------------------------------------------------------- golden fixture

interface FixtureTurn {
  id: number;
  type: string[];
  tags: string[];
  title: string;
}
interface FixtureEdge {
  citingId: number;
  relation: string;
  citedId: number;
  tags: string[];
  simulated?: boolean;
}
interface Fixture {
  meta: { window: [number, number] };
  lanes: { tag: string; kind: string; members: number[] }[];
  turns: FixtureTurn[];
  edges: FixtureEdge[];
}

const fixture: Fixture = JSON.parse(
  readFileSync(
    join(process.cwd(), ".scratch/rubric-v10/fixtures/t900-1001-lane-sim.json"),
    "utf8",
  ),
);
const fixtureTurns: LaneTurnInput[] = fixture.turns.map((t) => ({ id: t.id, type: t.type }));
const fixtureEdges: LaneEdgeInput[] = fixture.edges.map((e) => ({
  citingId: e.citingId,
  relation: e.relation,
  citedId: e.citedId,
  tags: e.tags,
}));
const declaredLaneTags = fixture.lanes.map((l) => l.tag).filter((tag) => tag !== "write-gate");

describe("golden fixture — S15069 T900-1001 lane simulation (12 lanes, hand-judged)", () => {
  const result = checkLanes(fixtureTurns, fixtureEdges);

  test("every declared lane has component count 1 and (unfolded) path count 1", () => {
    expect(declaredLaneTags.length).toBe(11);
    for (const tag of declaredLaneTags) {
      const stats = findLaneStats(result, [tag]);
      const component = findComponent(result, [tag]);
      const path = findPath(result, [tag]);
      expect(stats?.declaration.state).toBe("declared");
      expect(component?.componentCount).toBe(1);
      expect(path?.status).toBe("ok");
      expect(path?.pathCount).toBe(1);
    }
  });

  // Round-4 review #3 corrected the fold direction (see lane-checker.ts's
  // module header): the folded count now sums `countPaths` from EVERY
  // zero-indegree node in the merged graph (the terminus AND each external
  // citer), not the terminus alone — so an external `grounds` citation into
  // a MID-CHAIN member (which keeps the terminus its own independent,
  // still-zero-indegree root) GROWS the count, while one that lands
  // directly ON THE TERMINUS itself (giving the terminus an incoming edge,
  // so it stops being a source and the citer's own count subsumes it)
  // leaves the total unchanged. Recomputed by running the real
  // implementation against the fixture (`/tmp/dump-golden.ts`-style probe),
  // not hand-guessed:
  //   - cadence (citers 985->978, 989->978 mid-chain; 992->981 terminus
  //     itself): 1 -> 3
  //   - ownership (citers 936->910, 946->912, both mid-chain): 1 -> 3
  //   - relation-vocabulary (citers 940/942/945, mid-chain): 1 -> 3
  //   - turn-edge-mechanism (citer 930->929, lands ON the terminus): stays 1
  //   - view-spec (citer 923->922, lands ON the terminus): stays 1
  //   - every lane with no external grounds citer at all (contract-repair,
  //     contract-verify, rewind-marking, segment-audit, settlement-scope,
  //     spec-design): stays 1 (folded === base when there is nothing to fold)
  test("folded path counts recomputed under the corrected fold semantics (round-4 review #3)", () => {
    const expectedFolded: Record<string, number> = {
      "spec-design": 1,
      "settlement-scope": 1,
      ownership: 3,
      "rewind-marking": 1,
      "view-spec": 1,
      "turn-edge-mechanism": 1,
      "relation-vocabulary": 3,
      cadence: 3,
      "segment-audit": 1,
      "contract-repair": 1,
      "contract-verify": 1,
    };
    expect(Object.keys(expectedFolded).sort()).toEqual([...declaredLaneTags].sort());
    for (const tag of declaredLaneTags) {
      const path = findPath(result, [tag]);
      expect(path?.folded?.pathCount).toBe(expectedFolded[tag]);
    }
  });

  test("{write-gate} reports undeclared — no `indexes` ever tagged write-gate, only a same-tag override of its latest structural node", () => {
    const stats = findLaneStats(result, ["write-gate"]);
    expect(stats?.declaration.state).toBe("undeclared");
    expect(stats?.declaration.terminus).toBe(null);
    expect(stats?.declaration.latestEventTurn).toBe(958); // T958's override of T957
    expect(stats?.members.find((m) => m.id === 957)?.dead).toBe(true);
    const path = findPath(result, ["write-gate"]);
    expect(path?.status).toBe("skipped");
    expect(path?.skipReason).toBe("undeclared");
  });

  test("report 3 yields EXACTLY two multi-lane components (7-lane and 4-lane groups)", () => {
    expect(result.multiLaneComponents.length).toBe(2);
    const sizes = result.multiLaneComponents.map((c) => c.lanes.length).sort((a, b) => a - b);
    expect(sizes).toEqual([4, 7]);
  });

  test("{ownership}'s cited-ness shows MID-MEMBER grounds (T936->T910, T946->T912) — a terminus-only reading would show none, since nothing cites T913 directly", () => {
    const stats = findLaneStats(result, ["ownership"]);
    const pairs = stats?.citedness.groundsFromNonMembers.map((f) => `${f.citingId}->${f.citedId}`).sort();
    expect(pairs).toEqual(["936->910", "946->912"]);
    // Confirm the terminus itself really is never directly cited — the
    // lane-wide reading is doing real work here, not just being permissive.
    const directlyOnTerminus = stats?.citedness.groundsFromNonMembers.some((f) => f.citedId === 913);
    expect(directlyOnTerminus).toBe(false);
  });

  test("{ownership}'s phases include delivery too (T900 is typed design+ops — ops is delivery-phase), edge counts by word tally the lane's own 7 tagged edges", () => {
    const stats = findLaneStats(result, ["ownership"]);
    // Not a single "decision" phase: T900 carries both design (decision) and
    // ops (delivery) types, and phases are unioned across ALL members
    // (dead included) — a real anomaly signal report 1 is meant to surface,
    // not a bug in this test's expectation.
    expect(stats?.phases.slice().sort()).toEqual(["decision", "delivery"]);
    const total = Object.values(stats?.edgeCountsByRelation ?? {}).reduce((a, b) => a + b, 0);
    expect(total).toBe(7);
    expect(stats?.edgeCountsByRelation).toEqual({ extends: 3, indexes: 3, narrows: 1 });
  });

  test("input is whole for the fixture — coverage never reports partial when every referenced turn is present", () => {
    for (const lane of result.lanes) {
      expect(lane.coverage.status).toBe("whole");
      expect(lane.coverage.missingTurnIds).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------- synthetic checks

describe("cited-ness self-cite exclusion", () => {
  test("a self-grounds edge (settlement+implementer turn) never inflates its own lane's cited-ness", () => {
    const turns = [design(501, ["design", "implement"]), design(502)];
    const edges = [
      edge(502, "extends", 501, ["s"]),
      edge(502, "indexes", 501, ["s"]),
      edge(501, "grounds", 501, []), // self-cite: citer IS a member
    ];
    const result = checkLanes(turns, edges);
    const stats = findLaneStats(result, ["s"]);
    expect(stats?.citedness.groundsFromNonMembers).toEqual([]);
  });
});

describe("partial-input coverage", () => {
  test("a lane whose edges reach a turn missing from the input is reported WHOLE (members/terminus/path all computed) with coverage flagged partial", () => {
    const turns = [design(601)]; // 602 deliberately absent
    const edges = [edge(602, "extends", 601, ["w"]), edge(602, "indexes", 601, ["w"])];
    const result = checkLanes(turns, edges);
    const stats = findLaneStats(result, ["w"]);
    expect(stats?.members.map((m) => m.id)).toEqual([601, 602]);
    expect(stats?.coverage).toEqual({ status: "partial", missingTurnIds: [602] });
    // still reported WHOLE: terminus/path resolve despite the missing turn object.
    expect(stats?.declaration.terminus).toBe(602);
    const path = findPath(result, ["w"]);
    expect(path?.status).toBe("ok");
    expect(path?.pathCount).toBe(1);
    // phase only reflects the resolvable member (601); 602 contributes nothing unmapped.
    expect(stats?.phases).toEqual(["decision"]);
  });
});

describe("path counting — fork, merge, and one cross-phase fold, hand-computed", () => {
  // Fork: 2 and 3 both extend 1 (shared origin). Merge: 4 consumes BOTH 2 and
  // 3. Structural graph: 2->1, 3->1, 4->2, 4->3. starts={1}.
  // count(4) = count(2) + count(3) = 1 + 1 = 2 — two distinct start->terminus
  // routes (4-2-1 and 4-3-1).
  const turns = [design(1), design(2), design(3), design(4), design(5, ["implement"])];
  const edges = [
    edge(2, "extends", 1, ["f"]),
    edge(3, "extends", 1, ["f"]),
    edge(4, "consume", 2, ["f"]),
    edge(4, "consume", 3, ["f"]),
    edge(4, "indexes", 2, ["f"]),
    // cross-phase fold: an external (non-member) delivery turn grounds a
    // MID-chain member (3), not the terminus.
    edge(5, "grounds", 3, []),
  ];
  const result = checkLanes(turns, edges);
  const path = findPath(result, ["f"]);

  test("unfolded path count is 2 (fork+merge)", () => {
    expect(path?.status).toBe("ok");
    expect(path?.starts).toEqual([1]);
    expect(path?.terminus).toBe(4);
    expect(path?.pathCount).toBe(2);
  });

  // Round-4 review #3, the mutation-detecting property: the merged graph is
  // structural (2->1, 3->1, 4->2, 4->3) PLUS the fold edge 5->3. Node 3
  // keeps its own incoming edge from 4 (it is mid-chain, not the terminus),
  // so the terminus (4) stays an independent zero-indegree source with its
  // OWN unchanged count of 2 — but 5 is now ALSO a zero-indegree source
  // (nothing cites the external citer), contributing its own route
  // (5->3->1, count 1) on top. Folded = 2 (from 4) + 1 (from 5) = 3. A
  // reducer that (incorrectly) counts paths from the terminus alone — the
  // pre-fix reading — would report 2 here, unchanged from base; this test
  // fails under that old behaviour.
  test("folded path count GROWS to 3 — the external citer's own route to the lane's starts is summed alongside the terminus's own count, not walked from the terminus", () => {
    expect(path?.folded?.citingTurnsFolded).toEqual([5]);
    expect(path?.folded?.pathCount).toBe(3);
  });
});

describe("reports 2/3 build from stance+consume+grounds only — override is excluded", () => {
  test("two members connected ONLY by an override edge do not share a component — the same edge WOULD union them if override were mistakenly included", () => {
    // 10 and 11 share no narrows/extends/consume/grounds edge at all, only a
    // same-tag override — R2/R3's graph must NOT union them.
    const turns = [design(10), design(11), design(12)];
    const edges = [
      edge(11, "extends", 10, ["ov"]), // gives {ov} a terminus candidate to declare
      edge(11, "indexes", 10, ["ov"]),
      edge(12, "override", 11, ["ov"]), // the ONLY edge touching 12 at all
    ];
    const result = checkLanes(turns, edges);
    const component = findComponent(result, ["ov"]);
    // {ov} members are {10,11,12}; 12 is connected to NOTHING via
    // stance/consume/grounds, so it is its own island — component count 2.
    expect(component?.componentCount).toBe(2);
    const islandReps = component?.islands.map((i) => i.representative).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(islandReps).toEqual([10, 12]);
  });
});

describe("R1 edge counts, R4 excludes indexes from the structural graph", () => {
  test("a lane with ONLY an indexes declaration (no narrows/extends/consume) has zero structural edges — path count 0, not 1", () => {
    const turns = [design(701), design(702)];
    const edges = [edge(702, "indexes", 701, ["lone"])];
    const result = checkLanes(turns, edges);
    const stats = findLaneStats(result, ["lone"]);
    expect(stats?.declaration.state).toBe("declared");
    expect(stats?.edgeCountsByRelation).toEqual({ indexes: 1 });
    const path = findPath(result, ["lone"]);
    expect(path?.status).toBe("ok");
    expect(path?.starts).toEqual([]);
    // indexes is excluded from the path graph entirely — no structural chain
    // connects the declared terminus to any start, so the honest count is 0.
    expect(path?.pathCount).toBe(0);
  });
});

describe("R2/R3 union-find is PARTITIONED BY SEGMENT (round-4 review #4b)", () => {
  test("a segment-B node can never bridge two segment-A members, even via a legal cross-segment grounds citation", () => {
    // 30/31 are the ONLY tagged-edge pair in segment A ({seg}); nothing else
    // structurally connects them within their own segment. 32 (segment B)
    // legally grounds BOTH of them cross-phase -- the OLD (buggy) global
    // union-find would let 32 bridge 30 and 31 into one false-healthy
    // component. The fix must refuse that union: 30 and 31 stay separate
    // islands, correctly surfacing that {seg}'s members are severed within
    // their own segment.
    const turns = [
      { id: 30, type: ["design"], segment: "A" },
      { id: 31, type: ["design"], segment: "A" },
      { id: 32, type: ["implement"], segment: "B" },
    ];
    const edges = [
      edge(31, "indexes", 30, ["seg"]),
      edge(32, "grounds", 30),
      edge(32, "grounds", 31),
    ];
    const result = checkLanes(turns, edges);
    const component = findComponent(result, ["seg"]);
    expect(component?.componentCount).toBe(2);
    const islandReps = component?.islands.map((i) => i.representative).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(islandReps).toEqual([30, 31]);
  });

  test("a same-segment stance/consume/grounds edge still unions normally — the segment gate only blocks CROSS-segment unions", () => {
    const turns = [
      { id: 40, type: ["design"], segment: "A" },
      { id: 41, type: ["design"], segment: "A" },
      { id: 42, type: ["design"], segment: "A" },
    ];
    const edges = [edge(41, "extends", 40, ["seg2"]), edge(41, "indexes", 40, ["seg2"]), edge(42, "grounds", 40)];
    const result = checkLanes(turns, edges);
    const component = findComponent(result, ["seg2"]);
    expect(component?.componentCount).toBe(1);
  });
});

describe("sameLaneKey uses collision-safe canonical serialization (round-4 review #6)", () => {
  test("{a,bc} and {ab,c} are DISTINCT lane keys, not merged by a delimiter-free join", () => {
    const turns = [design(1), design(2), design(3)];
    const edges = [
      edge(2, "extends", 1, ["a", "bc"]),
      edge(2, "indexes", 1, ["a", "bc"]),
      edge(3, "extends", 1, ["ab", "c"]),
      edge(3, "indexes", 1, ["ab", "c"]),
    ];
    const result = checkLanes(turns, edges);
    // Both lanes' members reach turn 1 via `extends` (a stance relation), so
    // they share one global component -- report 3 must see BOTH distinct
    // lane keys there, not collapse the second into the first via a
    // `tagSet.join("")` collision ("a"+"bc" === "ab"+"c").
    expect(result.multiLaneComponents).toHaveLength(1);
    const shared = result.multiLaneComponents[0]!;
    const tagSets = shared.lanes.map((key) => key.tagSet.slice().sort().join(","));
    expect(tagSets.sort()).toEqual(["a,bc", "ab,c"]);
  });
});

describe("report 3 gains shared-node sets with a designed-shape annotation (round-4 review #7a)", () => {
  test("a shared fork root cited by stance from TWO distinct lanes is annotated designedShape: true", () => {
    const turns = [design(10), design(11), design(12)];
    const edges = [
      edge(11, "extends", 10, ["left"]),
      edge(11, "indexes", 10, ["left"]),
      edge(12, "extends", 10, ["right"]),
      edge(12, "indexes", 10, ["right"]),
    ];
    const result = checkLanes(turns, edges);
    expect(result.multiLaneComponents).toHaveLength(1);
    const shared = result.multiLaneComponents[0]!;
    expect(shared.sharedNodes).toHaveLength(1);
    const node = shared.sharedNodes[0]!;
    expect(node.id).toBe(10);
    expect(node.designedShape).toBe(true);
    expect(node.citingLanesByStance.map((key) => key.tagSet)).toEqual(
      expect.arrayContaining([["left"], ["right"]]),
    );
  });

  test("a shared node with fewer than two stance citers is surfaced for judgment (designedShape: false)", () => {
    // 10 is shared by {left} and {right} again, but ONLY {left} cites it via
    // a stance edge -- {right}'s own tagged edge is `consume`, which never
    // reads as a "designed fork" citation.
    const turns = [design(10), design(11), design(12)];
    const edges = [
      edge(11, "extends", 10, ["left"]),
      edge(11, "indexes", 10, ["left"]),
      edge(12, "consume", 10, ["right"]),
      edge(12, "indexes", 10, ["right"]),
    ];
    const result = checkLanes(turns, edges);
    const shared = result.multiLaneComponents[0]!;
    const node = shared.sharedNodes.find((n) => n.id === 10);
    expect(node?.designedShape).toBe(false);
    expect(node?.citingLanesByStance.map((key) => key.tagSet)).toEqual([["left"]]);
  });
});

describe("report 4 gains fork/join node lists (round-4 review #7b)", () => {
  test("the fork+merge fixture names its fork root and its join/merge node", () => {
    // Reuses the fork(1)+merge(4) shape from "path counting" above:
    // 2->1, 3->1 (1 is cited by two children -> fork), 4->2, 4->3 (4 cites
    // two predecessors -> join/merge).
    const turns = [design(1), design(2), design(3), design(4)];
    const edges = [
      edge(2, "extends", 1, ["fj"]),
      edge(3, "extends", 1, ["fj"]),
      edge(4, "consume", 2, ["fj"]),
      edge(4, "consume", 3, ["fj"]),
      edge(4, "indexes", 2, ["fj"]),
    ];
    const result = checkLanes(turns, edges);
    const path = findPath(result, ["fj"]);
    expect(path?.pathCount).toBe(2);
    expect(path?.forkNodes).toEqual([1]);
    expect(path?.joinNodes).toEqual([4]);
  });

  test("a plain chain (pathCount 1) has no fork/join nodes", () => {
    const turns = [design(801), design(802), design(803)];
    const edges = [
      edge(802, "extends", 801, ["chain"]),
      edge(803, "extends", 802, ["chain"]),
      edge(803, "indexes", 802, ["chain"]),
    ];
    const result = checkLanes(turns, edges);
    const path = findPath(result, ["chain"]);
    expect(path?.pathCount).toBe(1);
    expect(path?.forkNodes).toEqual([]);
    expect(path?.joinNodes).toEqual([]);
  });
});

describe("LaneCheckerResult.warnings passes through cross-segment tagged edges (round-4 review #5)", () => {
  test("a cross-segment tagged edge is named in the top-level `warnings` field", () => {
    const turns = [
      { id: 1, type: ["design"], segment: "A" },
      { id: 2, type: ["design"], segment: "B" },
    ];
    const edges = [edge(2, "extends", 1, ["x"])];
    const result = checkLanes(turns, edges);
    expect(result.warnings).toEqual([
      { citingId: 2, citedId: 1, tagSet: ["x"], citingSegment: "B", citedSegment: "A" },
    ]);
  });

  test("no cross-segment edges means an empty `warnings` array, not an absent field", () => {
    const result = checkLanes([design(1), design(2)], [edge(2, "extends", 1, ["y"])]);
    expect(result.warnings).toEqual([]);
  });
});
