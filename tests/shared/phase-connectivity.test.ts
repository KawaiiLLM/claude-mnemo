import { describe, expect, test } from "bun:test";

import {
  BASIS_TYPES,
  LANDING_TYPES,
  detectCompoundRetype,
  evaluatePhaseConnectivity,
  evaluateTurnPhaseConnectivity,
  isBasisTypeSet,
  isLandingTypeSet,
  type PhaseConnectivityGraph,
  type PhaseConnectivityTypeLookup,
} from "../../src/shared/phase-connectivity";

/**
 * Phase-connectivity ticket 01's pure predicate — the property-test list the
 * ticket names as the minimum, over a hand-built graph (turnId -> types,
 * turnId -> out-edges). No database, no lane, no window: those are the
 * loader's own domain (`tests/db/basis-reachability-load.test.ts`).
 */

function graph(edges: Record<number, Array<{ citedId: number; relation: string }>>): PhaseConnectivityGraph {
  return new Map(Object.entries(edges).map(([id, out]) => [Number(id), out]));
}

function types(byId: Record<number, string[]>): PhaseConnectivityTypeLookup {
  return new Map(Object.entries(byId).map(([id, t]) => [Number(id), t]));
}

describe("evaluateTurnPhaseConnectivity — directed walk", () => {
  test("a directed two-hop chain passes (I2 -> I1 -> D, no redundant I2 -> D edge needed)", () => {
    const t = types({ 1: ["implement"], 2: ["implement"], 3: ["design"] });
    const g = graph({ 2: [{ citedId: 1, relation: "extends" }], 1: [{ citedId: 3, relation: "grounds" }] });
    const finding = evaluateTurnPhaseConnectivity(2, t, g);
    expect(finding.outcome).toBe("reached");
    expect(finding.hops).toBe(2);
    expect(finding.basisTurnId).toBe(3);
    expect(finding.path).toEqual([2, 1, 3]);
  });

  test("a REVERSE-only edge (basis cites the landing turn, verifies/override INTO it) does not carry the walk", () => {
    // D =verifies=> L: the arc runs the wrong way for L's own out-edge walk.
    const t = types({ 1: ["implement"], 2: ["design"] });
    const g = graph({ 2: [{ citedId: 1, relation: "verifies" }] }); // D -> L, not L -> D
    const finding = evaluateTurnPhaseConnectivity(1, t, g);
    expect(finding.outcome).toBe("unreached");
  });

  for (const relation of ["override", "narrows", "extends", "indexes", "consume", "grounds", "verifies"]) {
    test(`each of the seven words carries the walk (${relation})`, () => {
      const t = types({ 1: ["implement"], 2: ["design"] });
      const g = graph({ 1: [{ citedId: 2, relation }] });
      const finding = evaluateTurnPhaseConnectivity(1, t, g);
      expect(finding.outcome).toBe("reached");
      expect(finding.basisTurnId).toBe(2);
    });
  }

  test("implement+discuss does NOT self-pass (discuss is neither landing nor basis)", () => {
    const t = types({ 1: ["implement", "discuss"] });
    const finding = evaluateTurnPhaseConnectivity(1, t, graph({}));
    expect(finding.outcome).toBe("unreached");
  });

  test("ops+fix does NOT self-pass (ops contributes no basis word; fix alone is landing-only)", () => {
    const t = types({ 1: ["ops", "fix"] });
    const finding = evaluateTurnPhaseConnectivity(1, t, graph({}));
    expect(finding.outcome).toBe("unreached");
  });

  for (const basis of ["design", "correction", "measure", "research", "review"]) {
    test(`a landing turn compounded with "${basis}" passes at zero hops`, () => {
      const t = types({ 1: ["implement", basis] });
      const finding = evaluateTurnPhaseConnectivity(1, t, graph({}));
      expect(finding.outcome).toBe("compound");
      expect(finding.hops).toBe(0);
      expect(finding.basisTurnId).toBe(1);
      expect(finding.basisWord).toBe(basis);
    });
  }

  test("a cycle in the graph terminates (cycle-safe BFS) rather than looping forever", () => {
    const t = types({ 1: ["implement"], 2: ["implement"], 3: ["implement"] });
    const g = graph({
      1: [{ citedId: 2, relation: "consume" }],
      2: [{ citedId: 3, relation: "consume" }],
      3: [{ citedId: 1, relation: "consume" }], // closes the cycle, no basis anywhere
    });
    const finding = evaluateTurnPhaseConnectivity(1, t, g);
    expect(finding.outcome).toBe("unreached");
  });

  test("a dead end (no out-edges, no basis word) is unreached, not compound", () => {
    const t = types({ 1: ["implement"] });
    const finding = evaluateTurnPhaseConnectivity(1, t, graph({}));
    expect(finding.outcome).toBe("unreached");
    expect(finding.hops).toBeNull();
    expect(finding.basisTurnId).toBeNull();
  });
});

describe("evaluatePhaseConnectivity — every landing turn, ascending", () => {
  test("returns one finding per input id, sorted ascending regardless of input order", () => {
    const t = types({ 5: ["implement"], 2: ["implement", "design"] });
    const findings = evaluatePhaseConnectivity([5, 2], t, graph({}));
    expect(findings.map((f) => f.turnId)).toEqual([2, 5]);
    expect(findings[0]!.outcome).toBe("compound");
    expect(findings[1]!.outcome).toBe("unreached");
  });
});

describe("type-set membership — raw types only, never TYPE_PHASE/phasesForTypes", () => {
  test("landing/basis sets match the ticket's own word lists exactly", () => {
    expect([...LANDING_TYPES].sort()).toEqual(["fix", "implement", "refactor"]);
    expect([...BASIS_TYPES].sort()).toEqual(["correction", "design", "measure", "research", "review"]);
  });

  test("review counts as basis (settled affirmatively, [S15069/T1951])", () => {
    expect(isBasisTypeSet(["review"])).toBe(true);
  });

  test("discuss/ops/delegate alone neither trigger nor satisfy", () => {
    for (const word of ["discuss", "ops", "delegate"]) {
      expect(isLandingTypeSet([word])).toBe(false);
      expect(isBasisTypeSet([word])).toBe(false);
    }
  });
});

describe("detectCompoundRetype — the write-path retype audit trigger", () => {
  test("a landing-only turn gaining a basis word is a retype, naming the ACCURATE word", () => {
    const retype = detectCompoundRetype(["fix"], ["fix", "measure"]);
    expect(retype).toEqual({ basisWord: "measure" });
  });

  test("a turn that was already compound gains no NEW audit obligation from a no-op reassert", () => {
    expect(detectCompoundRetype(["fix", "design"], ["fix", "design"])).toBeNull();
  });

  test("a landing turn retyped with NO new basis word is not a retype", () => {
    expect(detectCompoundRetype(["fix"], ["fix", "refactor"])).toBeNull();
  });

  test("a non-landing turn gaining a basis word is not this predicate's concern", () => {
    expect(detectCompoundRetype(["discuss"], ["discuss", "design"])).toBeNull();
  });

  test("multiple basis words added at once name the alphabetically-first as the audited word", () => {
    expect(detectCompoundRetype(["fix"], ["fix", "research", "measure"])).toEqual({
      basisWord: "measure",
    });
  });
});
