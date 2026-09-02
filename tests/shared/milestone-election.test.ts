import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { ELECTION_WEIGHTS } from "../../src/shared/election-weights";
import {
  electMilestones as runElectMilestones,
  type LaneEdgeInput,
  type MilestoneTurnInput,
} from "../../src/shared/milestone-election";
import { laneEdge, withEdgeClaimedLaneTags } from "../support/lane-edge-fixtures";

/**
 * `electMilestones` — the HEURISTIC SCORE (main-agent-edges spec D2, ruling
 * S15069/T2421).
 *
 * WHAT THIS FILE REPLACED. Until this ticket it tested a six-tier ladder:
 * which tier each node seated in, which retired relation word seated it, and
 * how a `budget` bounded the tier-④ two-stage fill. Every one of those
 * questions is gone with the tiers — three classes cannot carry them, because
 * `indexes` (the sole feeder of tiers ①/②/④) has no successor. What is tested
 * instead is ONE number per node, its four terms, and the order they produce.
 *
 * Every fixture turn is still first given the lane tags ITS OWN SIDE of the
 * fixture's edges names (`withEdgeClaimedLaneTags`). That projection is no
 * longer load-bearing for anything here — the score reads no lane at all —
 * but the wrapper keeps this file's fixtures byte-identical to the lane
 * checker's, which is what makes a cross-module comparison meaningful.
 */
function electMilestones(
  turns: readonly MilestoneTurnInput[],
  edges: readonly LaneEdgeInput[],
): ReturnType<typeof runElectMilestones> {
  return runElectMilestones(withEdgeClaimedLaneTags(turns, edges), edges);
}

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
): LaneEdgeInput => laneEdge({ citingId, relation, citedId, tags, ...(sides ?? {}) });

const rank = (result: ReturnType<typeof electMilestones>): number[] =>
  result.candidates.map((candidate) => candidate.id);
const candidateOf = (result: ReturnType<typeof electMilestones>, id: number) =>
  result.candidates.find((candidate) => candidate.id === id);

// ---------------------------------------------------------------- the four terms

describe("S(n) — the four terms, one fixture per term", () => {
  test("out-degree counts every outgoing edge, whatever it claims — self-edges included", () => {
    const turns = [turn(1), turn(2), turn(3)];
    // Two out-edges from 3, one of which reads a class the table prices at 0.5.
    const result = electMilestones(turns, [edge(3, "extends", 1), edge(3, "extends", 2)]);
    expect(candidateOf(result, 3)!.outDegree).toBe(2);
    expect(candidateOf(result, 1)!.outDegree).toBe(0);
  });

  test("the class sum prices each outgoing edge by what it claims — a full correction is worth four `use` edges", () => {
    const turns = [turn(1), turn(2), turn(3), turn(4)];
    const result = electMilestones(turns, [
      edge(2, "override", 1), // correct(full) = 2.0
      edge(3, "narrows", 1), // correct(partial) = 1.5
      edge(4, "verifies", 1), // verify = 1.0
    ]);
    expect(candidateOf(result, 2)!.classScore).toBe(ELECTION_WEIGHTS.class["correct(full)"]);
    expect(candidateOf(result, 3)!.classScore).toBe(ELECTION_WEIGHTS.class["correct(partial)"]);
    expect(candidateOf(result, 4)!.classScore).toBe(ELECTION_WEIGHTS.class.verify);
    const use = electMilestones([turn(1), turn(2)], [edge(2, "extends", 1)]);
    expect(candidateOf(use, 2)!.classScore).toBe(ELECTION_WEIGHTS.class.use);
    expect(ELECTION_WEIGHTS.class["correct(full)"]).toBe(4 * ELECTION_WEIGHTS.class.use);
  });

  test("a row that resolves to NO class scores 0 for the class term but still counts toward out-degree", () => {
    // `supersedes` is frozen-legacy: outside the class table entirely.
    const result = electMilestones([turn(1), turn(2)], [edge(2, "supersedes", 1)]);
    expect(candidateOf(result, 2)!.classScore).toBe(0);
    expect(candidateOf(result, 2)!.outDegree).toBe(1);
  });

  test("`rank_age` is ZERO-BASED (R10-4): the newest candidate scores the full recency weight, the oldest keeps 1/|pool|", () => {
    const turns = [turn(1), turn(2), turn(3), turn(4)];
    const result = electMilestones(turns, []);
    expect(candidateOf(result, 4)!.recency).toBe(1);
    expect(candidateOf(result, 1)!.recency).toBe(1 / 4);
    expect(candidateOf(result, 3)!.recency).toBe(1 - 1 / 4);
    expect(candidateOf(result, 2)!.recency).toBe(1 - 2 / 4);
  });

  test("the type term is the MAX over the node's own words, never their sum", () => {
    const turns = [
      turn(1, { type: ["design", "ops"] }), // max(1.5, 0.25)
      turn(2, { type: ["ops", "delegate"] }), // max(0.25, 0.25)
      turn(3, { type: ["unheard-of"] }),
      turn(4, { type: [] }),
    ];
    const result = electMilestones(turns, []);
    expect(candidateOf(result, 1)!.typeWeight).toBe(1.5);
    expect(candidateOf(result, 2)!.typeWeight).toBe(0.25);
    expect(candidateOf(result, 3)!.typeWeight).toBe(0);
    expect(candidateOf(result, 4)!.typeWeight).toBe(0);
  });

  test("`score` is exactly the four terms summed under the table's own coefficients", () => {
    const turns = [turn(1), turn(2, { type: ["design"] })];
    const result = electMilestones(turns, [edge(2, "override", 1)]);
    const two = candidateOf(result, 2)!;
    expect(two.score).toBeCloseTo(
      ELECTION_WEIGHTS.outDegree * two.outDegree +
        two.classScore +
        ELECTION_WEIGHTS.recency * two.recency +
        ELECTION_WEIGHTS.type * two.typeWeight,
      10,
    );
  });
});

// ---------------------------------------------------------------- order and ties

describe("order — score desc, then event order desc, then id desc", () => {
  test("a higher score outranks a newer turn: one full correction beats two positions of recency", () => {
    const turns = [turn(1), turn(2), turn(3)];
    const result = electMilestones(turns, [edge(1, "override", 3)]);
    expect(rank(result)[0]).toBe(1);
  });

  test("equal scores break by the LATER turn, then by the larger id", () => {
    const turns = [
      turn(10, { order: [1, 1] as const }),
      turn(11, { order: [1, 2] as const }),
    ];
    // Same everything except position; 11 is later, so it leads.
    expect(rank(electMilestones(turns, []))).toEqual([11, 10]);

    // A true tie on order falls to id desc.
    const tied = [turn(20, { order: [1, 5] as const }), turn(21, { order: [1, 5] as const })];
    expect(rank(electMilestones(tied, []))).toEqual([21, 20]);
  });

  test("a CROSS-SESSION pair orders by `createdAtEpoch` first (R10-4) — a session id carries no wall-clock meaning", () => {
    const turns = [
      turn(1, { order: [9, 1] as const, createdAtEpoch: 100 }), // higher session id, OLDER clock
      turn(2, { order: [2, 1] as const, createdAtEpoch: 900 }),
    ];
    // Tuple order alone would put 1 first; the epoch says 2 is newer.
    expect(rank(electMilestones(turns, []))).toEqual([2, 1]);
  });

  test("the whole candidacy is returned, never truncated — there is no budget argument any more", () => {
    const turns = Array.from({ length: 40 }, (_, index) => turn(index + 1));
    expect(electMilestones(turns, []).candidates).toHaveLength(40);
    expect(runElectMilestones).toHaveLength(2);
  });
});

// ---------------------------------------------------------- candidacy boundaries

describe("candidacy — step 0's eligibility boundary and step 1's invalid nodes", () => {
  test("a rolled-back or skipped turn leaves candidacy, and its own edges still price everyone else", () => {
    const turns = [turn(1), turn(2, { wasRolledBack: true }), turn(3, { skipped: true })];
    const result = electMilestones(turns, [edge(2, "override", 1), edge(3, "override", 1)]);
    expect(result.excluded).toEqual([2, 3]);
    expect(rank(result)).toEqual([1]);
  });

  test("NO edge removes a node from candidacy — an overridden node stays an ordinary candidate", () => {
    const turns = [turn(1), turn(2)];
    const result = electMilestones(turns, [edge(2, "override", 1)]);
    expect(result.excluded).toEqual([]);
    expect(rank(result).sort((a, b) => a - b)).toEqual([1, 2]);
  });

  test("an `eligible: false` node never seats, but its edges still price a window member (R10-4: the edge universe includes external endpoints)", () => {
    const turns = [turn(1), turn(2), turn(99, { eligible: false })];
    const result = electMilestones(turns, [edge(99, "override", 1)]);
    expect(rank(result)).not.toContain(99);
    // 1 is CITED by the external node, which prices nothing on 1 directly —
    // but 99's own out-degree is real, and the proof it was counted is that
    // the external node's candidate row does not exist while the edge did
    // reach the tally: 1 and 2 both stay candidates and the pool is 2, so
    // recency is measured over the window, not over the graph.
    expect(result.candidates).toHaveLength(2);
    expect(candidateOf(result, 2)!.recency).toBe(1);
  });

  test("a node absent from `turns[]` entirely is a graph node and never a candidate", () => {
    const result = electMilestones([turn(1)], [edge(500, "override", 1)]);
    expect(rank(result)).toEqual([1]);
  });
});

// ------------------------------------------------------------------ degradation

describe("an edgeless, typeless window degrades to recency with no special case", () => {
  test("every score is exactly the recency term, so the order IS newest-first", () => {
    const turns = [turn(1), turn(2), turn(3), turn(4)];
    const result = electMilestones(turns, []);
    expect(rank(result)).toEqual([4, 3, 2, 1]);
    for (const candidate of result.candidates) {
      expect(candidate.score).toBe(candidate.recency);
    }
  });

  test("an empty window is an empty candidacy, not a division by zero", () => {
    const result = electMilestones([], []);
    expect(result.candidates).toEqual([]);
    expect(result.excluded).toEqual([]);
  });
});

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
  readFileSync(join(process.cwd(), ".scratch/rubric-v10/fixtures/t900-1001-lane-sim.json"), "utf8"),
);
const fixtureTurns: MilestoneTurnInput[] = fixture.turns.map((t) => ({ id: t.id, type: t.type }));
const fixtureEdges: LaneEdgeInput[] = fixture.edges.map((e) =>
  laneEdge({ citingId: e.citingId, relation: e.relation, citedId: e.citedId, tags: e.tags }),
);

/**
 * THE SCORE'S OWN TOP NINE on the recorded production graph
 * (S15069/T900-1001), and the EXPECTED delta from the tier ladder's — listed
 * as a change, never as an equivalence (spec D2).
 *
 * The tiers' nine were [922, 929, 939, 946, 981, 984, 990, 998, 1001]. Seven
 * of them survive. `922` leaves — it seated on a tier predicate, and under a
 * magnitude its two out-edges do not reach the cut — and `913` enters, which
 * is the shape the ladder structurally could not seat: five out-edges, 3.5 of
 * class weight, and a `design` type, all of it below the first tier key that
 * discriminated.
 */
const SCORED_NINE = [998, 913, 939, 981, 990, 929, 1001, 946, 984];

describe("golden fixture — S15069 T900-1001, the score's own ranking", () => {
  const result = electMilestones(fixtureTurns, fixtureEdges);

  test("the top nine, in score order", () => {
    expect(rank(result).slice(0, 9)).toEqual(SCORED_NINE);
  });

  test("seven of the tier ladder's nine survive; the two that move are named", () => {
    const TIERED_NINE = [922, 929, 939, 946, 981, 984, 990, 998, 1001];
    const kept = TIERED_NINE.filter((id) => SCORED_NINE.includes(id));
    expect(kept).toEqual([929, 939, 946, 981, 984, 990, 998, 1001]);
    expect(SCORED_NINE.filter((id) => !TIERED_NINE.includes(id))).toEqual([913]);
    expect(TIERED_NINE.filter((id) => !SCORED_NINE.includes(id))).toEqual([922]);
  });

  test("the leader is the corpus's own hub — 17 out-edges, 8.5 of class weight — and it leads by a wide margin", () => {
    const leader = result.candidates[0]!;
    expect(leader.id).toBe(998);
    expect(leader.outDegree).toBe(17);
    expect(leader.classScore).toBe(8.5);
    expect(leader.score).toBeGreaterThan(2 * result.candidates[1]!.score);
  });

  test("every candidate is a real fixture turn, and the ranking is a total order (no duplicate ids)", () => {
    const ids = rank(result);
    expect(new Set(ids).size).toBe(ids.length);
    const fixtureIds = new Set(fixtureTurns.map((t) => t.id));
    for (const id of ids) {
      expect(fixtureIds.has(id)).toBe(true);
    }
  });
});
