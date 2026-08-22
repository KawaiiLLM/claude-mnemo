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

  test("every declared lane has component count 1 and path count 1, folded included", () => {
    expect(declaredLaneTags.length).toBe(11);
    for (const tag of declaredLaneTags) {
      const stats = findLaneStats(result, [tag]);
      const component = findComponent(result, [tag]);
      const path = findPath(result, [tag]);
      expect(stats?.declaration.state).toBe("declared");
      expect(component?.componentCount).toBe(1);
      expect(path?.status).toBe("ok");
      expect(path?.pathCount).toBe(1);
      expect(path?.folded?.pathCount).toBe(1);
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

  test("folded path count is UNCHANGED at 2 — the external citer is recorded but structurally unreachable from the terminus (see lane-checker.ts's PROVABLE INVARIANT note)", () => {
    expect(path?.folded?.citingTurnsFolded).toEqual([5]);
    expect(path?.folded?.pathCount).toBe(2);
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
