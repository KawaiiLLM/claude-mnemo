import { describe, expect, test } from "bun:test";

import {
  deriveFlows,
  settlementsOfTurn,
  type FlowEdgeInput,
  type FlowTurnInput,
} from "../../src/shared/flows";
import { FLOW_WINDOW_EDGES, FLOW_WINDOW_TURNS } from "./flow-window-fixture";

const decision = (id: number): FlowTurnInput => ({ id, type: ["design"] });
const delivery = (id: number): FlowTurnInput => ({ id, type: ["implement"] });
const evidence = (id: number): FlowTurnInput => ({ id, type: ["measure"] });
const edge = (citingId: number, relation: string, citedId: number): FlowEdgeInput => ({
  citingId,
  relation,
  citedId,
});

describe("branch structure", () => {
  test("a chain of extends is ONE flow settling at its newest node", () => {
    const result = deriveFlows([decision(1), decision(2), decision(3)], [
      edge(2, "extends", 1),
      edge(3, "narrows", 2),
    ]);
    expect(result.flows).toEqual([{ id: 3, members: [1, 2, 3], settlement: 3 }]);
    expect(result.homeless).toEqual([]);
  });

  test("a fork splits into separate flows, not one component", () => {
    // 1 <- 2, 1 <- 3 <- 4: two branches sharing their origin.
    const result = deriveFlows([decision(1), decision(2), decision(3), decision(4)], [
      edge(2, "extends", 1),
      edge(3, "extends", 1),
      edge(4, "extends", 3),
    ]);
    expect(result.flows.map((flow) => flow.id)).toEqual([2, 4]);
    expect(result.flowById.get(2)?.members).toEqual([1, 2]);
    expect(result.flowById.get(4)?.members).toEqual([1, 3, 4]);
    expect(result.flowsByTurn.get(1)).toEqual([2, 4]);
    expect(settlementsOfTurn(result, 1)).toEqual([2, 4]);
  });

  test("a decision turn with no stance edge is its own flow AND its own settlement", () => {
    const result = deriveFlows([decision(7), delivery(8)], []);
    expect(result.flows).toEqual([{ id: 7, members: [7], settlement: 7 }]);
    expect(result.homeless).toEqual([8]);
  });

  test("only decision turns hold a branch: a stance edge on a delivery turn is ignored", () => {
    const result = deriveFlows([delivery(1), delivery(2)], [edge(2, "extends", 1)]);
    expect(result.flows).toEqual([]);
    expect(result.homeless).toEqual([1, 2]);
  });
});

describe("override terminates a branch", () => {
  test("an overridden terminus leaves the flow with an EMPTY settlement, members intact", () => {
    const result = deriveFlows([decision(1), decision(2), decision(3)], [
      edge(2, "extends", 1),
      edge(3, "override", 2),
    ]);
    const dead = result.flowById.get(2);
    expect(dead).toEqual({ id: 2, members: [1, 2], settlement: null });
    expect(settlementsOfTurn(result, 1)).toEqual([]);
    // The overrider is flow-free: it holds its own one-node branch instead of
    // joining (or settling) the branch it killed.
    expect(result.flowById.get(3)).toEqual({ id: 3, members: [3], settlement: 3 });
    expect(result.homeless).toEqual([]);
  });

  test("an override MID-branch does not kill a flow a later extends carried on", () => {
    // 3 overrides 2, but 4 extends 2 anyway: the branch moved past the override.
    const result = deriveFlows([decision(1), decision(2), decision(3), decision(4)], [
      edge(2, "extends", 1),
      edge(3, "override", 2),
      edge(4, "extends", 2),
    ]);
    expect(result.flowById.get(4)).toEqual({ id: 4, members: [1, 2, 4], settlement: 4 });
  });
});

describe("inherited membership", () => {
  test("a delivery turn inherits through the grounds edge it wrote (reverse direction)", () => {
    const result = deriveFlows([decision(1), delivery(2)], [edge(2, "grounds", 1)]);
    expect(result.flowsByTurn.get(2)).toEqual([1]);
    expect(settlementsOfTurn(result, 2)).toEqual([1]);
    expect(result.homeless).toEqual([]);
  });

  // Indexes-rescope spec (ticket 01, [S15069/T1231]): `indexes` joins
  // `INHERITING_RELATIONS` — the renamed, widened `collects` — so a
  // release-like delivery turn that INDEXES the artifacts it ships (rather
  // than consuming them) still reaches the flows it ships. Same shape as the
  // grounds test above, `indexes` in place of `grounds`.
  test("indexes joins the inheritance set — a release-like delivery turn inherits through the indexes edge it wrote", () => {
    const result = deriveFlows([decision(1), delivery(2)], [edge(2, "indexes", 1)]);
    expect(result.flowsByTurn.get(2)).toEqual([1]);
    expect(settlementsOfTurn(result, 2)).toEqual([1]);
    expect(result.homeless).toEqual([]);
  });

  test("inheritance is transitive to a fixpoint, and never runs backwards", () => {
    // 3 consumes 2 consumes (grounds) 1: membership reaches 3, and nothing
    // flows from a citing turn back down to the turn it cited.
    const result = deriveFlows([decision(1), delivery(2), delivery(3)], [
      edge(2, "grounds", 1),
      edge(3, "consume", 2),
    ]);
    expect(result.flowsByTurn.get(3)).toEqual([1]);
    expect(result.flowById.get(1)?.members).toEqual([1]);
  });

  test("verifies/refutes confer NO membership — an evidence turn stays homeless", () => {
    const result = deriveFlows([decision(1), evidence(2), evidence(3)], [
      edge(2, "verifies", 1),
      edge(3, "refutes", 1),
    ]);
    expect(result.homeless).toEqual([2, 3]);
  });

  test("a decision turn that also delivers keeps its own flow AND inherits", () => {
    const result = deriveFlows(
      [decision(1), { id: 2, type: ["design", "implement"] }],
      [edge(2, "grounds", 1)],
    );
    expect(result.flowsByTurn.get(2)).toEqual([1, 2]);
  });

  test("unknown relations and dangling endpoints are inert", () => {
    const result = deriveFlows([decision(1), delivery(2)], [
      edge(2, "collects", 1),
      edge(2, "sponsors", 1),
      edge(2, "grounds", 99),
      edge(99, "grounds", 1),
    ]);
    expect(result.homeless).toEqual([2]);
    expect(result.flows.map((flow) => flow.id)).toEqual([1]);
  });
});

describe("derived view, never cached", () => {
  const turns = [decision(1), decision(2), delivery(3)];
  const edges = [edge(2, "extends", 1), edge(3, "grounds", 2)];

  test("two derivations of the same input agree, and the snapshot does not alias its input", () => {
    const first = deriveFlows(turns, edges);
    const second = deriveFlows(turns, edges);
    expect(first.flows).toEqual(second.flows);
    expect(first.flows[0]?.members).not.toBe(second.flows[0]?.members);
  });

  test("removing an edge changes the next derivation — no view survives an edge change", () => {
    const before = deriveFlows(turns, edges);
    expect(before.flowsByTurn.get(3)).toEqual([2]);
    const after = deriveFlows(turns, [edges[0]!]);
    expect(after.homeless).toEqual([3]);
    // The earlier snapshot is untouched by the later derivation.
    expect(before.flowsByTurn.get(3)).toEqual([2]);
  });
});

describe("real data — the S15069 T900-T1001 window", () => {
  const result = deriveFlows(FLOW_WINDOW_TURNS, FLOW_WINDOW_EDGES);
  const settled = result.flows.filter((flow) => flow.settlement !== null);

  test("branch semantics: 24 branches, 23 of them settled", () => {
    // Union-find over the same 24 stance edges counts 22 components. Branch
    // semantics adds T900's fork (+2 — three termini share one component), and
    // splits the gate component in two: T958's override does NOT join the
    // branch it killed, so the overrider holds a one-node branch of its own.
    // The peer's headline "23 flows" is exactly the SETTLED count (the dead
    // T950..T957 branch is the 24th); their 21-component baseline had folded
    // the override edge into the component pass, which is where the last unit
    // of the 21 -> 23 recount went missing.
    expect(result.flows.length).toBe(24);
    expect(settled.length).toBe(23);
    expect(result.flows.filter((flow) => flow.settlement === null).map((flow) => flow.id)).toEqual([
      957,
    ]);
  });

  test("T900 forks into three settlements", () => {
    expect(result.flowsByTurn.get(900)).toEqual([901, 906, 913]);
    expect(settlementsOfTurn(result, 900)).toEqual([901, 906, 913]);
  });

  test("T954's branch died of T958's override — its settlement set is EMPTY", () => {
    expect(result.flowsByTurn.get(954)).toEqual([957]);
    expect(result.flowById.get(957)).toEqual({
      id: 957,
      members: [950, 951, 952, 953, 954, 955, 957],
      settlement: null,
    });
    expect(settlementsOfTurn(result, 954)).toEqual([]);
    // T959 encodes(->grounds) both T954 and T958: the dead branch gives it
    // nothing to settle on, T958's own branch does. That asymmetry is the
    // spec's pinned special case (T954 is reached by collects instead).
    expect(settlementsOfTurn(result, 959)).toEqual([958, 959]);
  });

  test("the homeless set is exactly {918, 925, 941, 977, 987}", () => {
    const edgeBearing = new Set<number>();
    for (const relationEdge of FLOW_WINDOW_EDGES) {
      edgeBearing.add(relationEdge.citingId);
      edgeBearing.add(relationEdge.citedId);
    }
    expect(edgeBearing.size).toBe(85);
    expect(result.homeless.filter((id) => edgeBearing.has(id))).toEqual([918, 925, 941, 977, 987]);

    // The same assertion over the peer's own universe — the 85 edged turns,
    // which is what "5 of 85 unassigned" was measured on. Restricting the turn
    // list only drops the 4 edge-free decision turns' one-node flows (24 -> 20);
    // no edge can move, since every endpoint is edge-bearing by construction.
    const edgedOnly = deriveFlows(
      FLOW_WINDOW_TURNS.filter((turn) => edgeBearing.has(turn.id)),
      FLOW_WINDOW_EDGES,
    );
    expect(edgedOnly.homeless).toEqual([918, 925, 941, 977, 987]);
    expect(edgedOnly.flows.length).toBe(20);

    // The remaining homeless turns of the full window carry no edge at all and
    // no decision type — nothing to hold a flow with, nothing to inherit
    // through. Homelessness is a property of the graph, not of the window.
    for (const id of result.homeless) {
      if (edgeBearing.has(id)) continue;
      const turn = FLOW_WINDOW_TURNS.find((candidate) => candidate.id === id);
      expect(turn?.type.some((word) => ["design", "discuss", "correction"].includes(word))).toBe(
        false,
      );
    }
  });

  test("every flow is a DECISION flow — P2 defers the delivery layer whole", () => {
    const decisionTypes = new Set(["design", "discuss", "correction"]);
    const byId = new Map(FLOW_WINDOW_TURNS.map((turn) => [turn.id, turn]));
    for (const flow of result.flows) {
      for (const member of flow.members) {
        expect(byId.get(member)?.type.some((word) => decisionTypes.has(word))).toBe(true);
      }
    }
    // …and every decision turn in the window belongs to at least one, dead
    // branch included: a decision turn is never homeless.
    const decisionTurns = FLOW_WINDOW_TURNS.filter((turn) =>
      turn.type.some((word) => decisionTypes.has(word)),
    );
    expect(decisionTurns.length).toBe(46);
    for (const turn of decisionTurns) {
      expect(result.flowsByTurn.get(turn.id)?.length ?? 0).toBeGreaterThan(0);
    }
  });

  test("recomputing the whole window stays cheap enough to run on every read", () => {
    const iterations = 50;
    const started = Bun.nanoseconds();
    for (let index = 0; index < iterations; index += 1) {
      deriveFlows(FLOW_WINDOW_TURNS, FLOW_WINDOW_EDGES);
    }
    const perDerivation = (Bun.nanoseconds() - started) / iterations / 1_000_000;
    // Reference: the peer's Python prototype ran the FULL database (12304
    // turns, 849 edges) in 2.4 ms. A 102-turn window has room to spare; the
    // budget is a regression door against an accidental quadratic, not a
    // benchmark.
    expect(perDerivation).toBeLessThan(5);
  });
});
