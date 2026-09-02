import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  convergenceDeclarationPredicate,
  countsTowardInDegree,
  electionInEdgeWeight,
  electionOutEdgeWeight,
  type ElectionRelationParameters,
  FROZEN_ELECTION_RELATION_PARAMETERS,
  isCorrectionEdge,
  isUseEdge,
  RETIRED_USE_WORD_WEIGHTS,
} from "../../src/shared/election-relation-weights";
import type { LaneEdgeInput, MilestoneTurnInput } from "../../src/shared/milestone-election";
import { electMilestones } from "../../src/shared/milestone-election";
import { INTERIM_LEGACY_RELATION } from "../../src/shared/relation-class";
import { EDGE_RELATIONS } from "../../src/shared/turn-phase";
import { laneEdge, withEdgeClaimedLaneTags } from "../support/lane-edge-fixtures";

/**
 * relation-vocabulary-v13 ticket 05a — the frozen election weights re-keyed
 * from the seven retired words onto `(class, coverage)`.
 *
 * The load-bearing claim is EQUIVALENCE, not improvement: at the frozen
 * parameters every stored row scores exactly what the word-keyed tables gave
 * it, so the interim fill (`INTERIM_LEGACY_RELATION`) can be deleted by a
 * later commit without moving a single election. The two keys the re-key could
 * NOT force — what a `use` edge weighs, what declares a convergence — are
 * parameters, and the tests below pin BOTH that their defaults reproduce today
 * and that a non-default value actually bites (so a silently-inert parameter
 * cannot pass as a measured null result).
 */

/** The word-keyed tables as they stood at HEAD (d06f4cc3), restated so the re-key is checked against a value, not against itself. */
const FROZEN_WORD_WEIGHTS: Record<string, { out: number; in: number }> = {
  override: { out: 2, in: 0 },
  narrows: { out: 1, in: 1 },
  verifies: { out: 1, in: 2 },
  extends: { out: 0, in: 0 },
  consume: { out: 0, in: 0 },
  grounds: { out: 1, in: 2 },
  indexes: { out: 2, in: 1 },
};

/** HEAD's `IN_DEGREE_RELATIONS` — the "six words", i.e. everything but `override`. */
const FROZEN_IN_DEGREE_WORDS = ["narrows", "extends", "consume", "indexes", "grounds", "verifies"];

const legacyRow = (relation: string) => ({ relation });

describe("re-key equivalence — every retired word scores what it scored at HEAD", () => {
  for (const word of EDGE_RELATIONS) {
    test(`\`${word}\` keeps its frozen out/in weights under the default parameters`, () => {
      expect(electionOutEdgeWeight(legacyRow(word))).toBe(FROZEN_WORD_WEIGHTS[word]!.out);
      expect(electionInEdgeWeight(legacyRow(word))).toBe(FROZEN_WORD_WEIGHTS[word]!.in);
    });
  }

  test("the in-degree domain is exactly HEAD's six words — and `override` alone stays out", () => {
    for (const word of EDGE_RELATIONS) {
      expect(countsTowardInDegree(legacyRow(word))).toBe(FROZEN_IN_DEGREE_WORDS.includes(word));
    }
  });

  test("the corrector key is exactly `override`", () => {
    for (const word of EDGE_RELATIONS) {
      expect(isCorrectionEdge(legacyRow(word))).toBe(word === "override");
    }
  });

  test("a bare row (no relation at all) and an out-of-vocabulary word score nothing and enter no key — the absent-table-key behaviour, preserved", () => {
    for (const row of [{ relation: null }, { relation: "refutes" }, { relation: "" }]) {
      expect(electionOutEdgeWeight(row)).toBe(0);
      expect(electionInEdgeWeight(row)).toBe(0);
      expect(countsTowardInDegree(row)).toBe(false);
      expect(isCorrectionEdge(row)).toBe(false);
      expect(isUseEdge(row)).toBe(false);
    }
  });

  test("a SWEPT legacy row (ticket 03 filled its class columns) answers identically to the same row before the sweep — the sweep is a materialization, so the re-key cannot make it a semantic change", () => {
    const swept = [
      { relation: "override", relationClass: "correct" as const, relationCoverage: "full" as const },
      { relation: "narrows", relationClass: "correct" as const, relationCoverage: "partial" as const },
      { relation: "verifies", relationClass: "verify" as const, relationCoverage: "" as const },
      { relation: "grounds", relationClass: "use" as const, relationCoverage: "" as const },
      { relation: "indexes", relationClass: "use" as const, relationCoverage: "" as const },
      { relation: "consume", relationClass: "use" as const, relationCoverage: "" as const },
      { relation: "extends", relationClass: "use" as const, relationCoverage: "" as const },
    ];
    for (const row of swept) {
      expect(electionOutEdgeWeight(row)).toBe(electionOutEdgeWeight(legacyRow(row.relation)));
      expect(electionInEdgeWeight(row)).toBe(electionInEdgeWeight(legacyRow(row.relation)));
      expect(countsTowardInDegree(row)).toBe(countsTowardInDegree(legacyRow(row.relation)));
      expect(isCorrectionEdge(row)).toBe(isCorrectionEdge(legacyRow(row.relation)));
    }
  });
});

describe("the INTERIM equivalence, stated as a test so deleting the interim fill is provably safe", () => {
  // `shared/relation-class.ts`'s INTERIM table is what keeps a three-class
  // write visible to word-keyed readers. Once this holds for every entry, a
  // later commit can delete the fill and no election moves.
  for (const entry of INTERIM_LEGACY_RELATION) {
    test(`a class-written ${entry.relationClass}${entry.relationCoverage === "" ? "" : `(${entry.relationCoverage})`} row scores exactly what its interim word \`${entry.legacy}\` scores`, () => {
      const classWritten = {
        relation: null,
        relationClass: entry.relationClass,
        relationCoverage: entry.relationCoverage,
      };
      expect(electionOutEdgeWeight(classWritten)).toBe(electionOutEdgeWeight(legacyRow(entry.legacy)));
      expect(electionInEdgeWeight(classWritten)).toBe(electionInEdgeWeight(legacyRow(entry.legacy)));
      expect(countsTowardInDegree(classWritten)).toBe(countsTowardInDegree(legacyRow(entry.legacy)));
      expect(isCorrectionEdge(classWritten)).toBe(isCorrectionEdge(legacyRow(entry.legacy)));
    });
  }

  test("and it holds with the interim word still stored, too — a new row carrying BOTH scores the same either way", () => {
    for (const entry of INTERIM_LEGACY_RELATION) {
      const both = {
        relation: entry.legacy,
        relationClass: entry.relationClass,
        relationCoverage: entry.relationCoverage,
      };
      const classOnly = {
        relation: null,
        relationClass: entry.relationClass,
        relationCoverage: entry.relationCoverage,
      };
      expect(electionOutEdgeWeight(both)).toBe(electionOutEdgeWeight(classOnly));
      expect(electionInEdgeWeight(both)).toBe(electionInEdgeWeight(classOnly));
    }
  });
});

describe("the `use` weight is a PARAMETER, and it bites", () => {
  test("the four retired sources really did disagree — which is why nothing forces this key", () => {
    expect(RETIRED_USE_WORD_WEIGHTS).toEqual({
      extends: { out: 0, in: 0 },
      consume: { out: 0, in: 0 },
      grounds: { out: 1, in: 2 },
      indexes: { out: 2, in: 1 },
    });
  });

  test("a uniform weighting overrides every retired word inside `use`, and touches no other class", () => {
    const parameters: ElectionRelationParameters = {
      use: { kind: "uniform", out: 5, in: 7 },
      convergence: { kind: "retired-indexes" },
    };
    for (const word of ["extends", "consume", "grounds", "indexes"]) {
      expect(electionOutEdgeWeight(legacyRow(word), parameters)).toBe(5);
      expect(electionInEdgeWeight(legacyRow(word), parameters)).toBe(7);
    }
    for (const word of ["override", "narrows", "verifies"]) {
      expect(electionOutEdgeWeight(legacyRow(word), parameters)).toBe(FROZEN_WORD_WEIGHTS[word]!.out);
      expect(electionInEdgeWeight(legacyRow(word), parameters)).toBe(FROZEN_WORD_WEIGHTS[word]!.in);
    }
  });

  test("a class-written `use` row takes the uniform value too — the parameter is about the CLASS, not about a stored word", () => {
    const parameters: ElectionRelationParameters = {
      use: { kind: "uniform", out: 5, in: 7 },
      convergence: { kind: "retired-indexes" },
    };
    const classWritten = { relation: null, relationClass: "use" as const, relationCoverage: "" as const };
    expect(electionOutEdgeWeight(classWritten, parameters)).toBe(5);
    expect(electionOutEdgeWeight(classWritten)).toBe(0);
  });
});

describe("the convergence rule is a PARAMETER, and it bites", () => {
  const edges: (LaneEdgeInput & { citingId: number })[] = [
    laneEdge({ citingId: 1, relation: "extends", citedId: 10 }),
    laneEdge({ citingId: 1, relation: "consume", citedId: 11 }),
    laneEdge({ citingId: 1, relation: "grounds", citedId: 12 }),
    laneEdge({ citingId: 2, relation: "extends", citedId: 13 }),
    laneEdge({ citingId: 3, relation: "indexes", citedId: 14 }),
    laneEdge({ citingId: 4, relation: "verifies", citedId: 15 }),
  ];

  test("frozen: only a stored `indexes` declares — the retired word, and nothing the corpus can grow any more", () => {
    const declares = convergenceDeclarationPredicate(edges, FROZEN_ELECTION_RELATION_PARAMETERS);
    expect(edges.filter(declares).map((edge) => edge.citedId)).toEqual([14]);
  });

  test("the T2306 proxy declares by `use` OUT-degree, so a node with enough use edges declares them ALL and a node below the threshold declares none", () => {
    const declares = convergenceDeclarationPredicate(edges, {
      use: { kind: "retired-words" },
      convergence: { kind: "use-out-degree", threshold: 3 },
    });
    expect(edges.filter(declares).map((edge) => edge.citedId)).toEqual([10, 11, 12]);
  });

  test("a `verifies` edge never declares under the proxy — it is not `use`, whatever its source's fan-out", () => {
    const declares = convergenceDeclarationPredicate(edges, {
      use: { kind: "retired-words" },
      convergence: { kind: "use-out-degree", threshold: 1 },
    });
    expect(edges.filter(declares).every((edge) => isUseEdge(edge))).toBe(true);
    expect(edges.filter(declares).map((edge) => edge.citedId)).not.toContain(15);
  });
});

describe("end to end — `electMilestones` at the frozen parameters versus a proxy", () => {
  const fixture = JSON.parse(
    readFileSync(join(process.cwd(), ".scratch/rubric-v10/fixtures/t900-1001-lane-sim.json"), "utf8"),
  ) as { turns: { id: number; type: string[] }[]; edges: { citingId: number; relation: string; citedId: number; tags: string[] }[] };
  const turns: MilestoneTurnInput[] = fixture.turns.map((row) => ({ id: row.id, type: row.type }));
  const edges: LaneEdgeInput[] = fixture.edges.map((row) =>
    laneEdge({ citingId: row.citingId, relation: row.relation, citedId: row.citedId, tags: row.tags }),
  );
  const elect = (parameters?: ElectionRelationParameters) =>
    electMilestones(withEdgeClaimedLaneTags(turns, edges), edges, 9, [], parameters);

  const GOLDEN_NINE = [922, 929, 939, 946, 981, 984, 990, 998, 1001];

  test("the default argument and an explicitly-frozen one are the same election — the parameter's default is not a second behaviour", () => {
    expect(elect()).toEqual(elect(FROZEN_ELECTION_RELATION_PARAMETERS));
    expect(
      elect().candidates.slice(0, 9).map((candidate) => candidate.id).sort((a, b) => a - b),
    ).toEqual(GOLDEN_NINE);
  });

  test("the `use` WEIGHT cannot move this election at all — `electMilestones` counts in-degree membership and never reads a numeric weight; only the frontier's lane-local scoring does", () => {
    expect(
      elect({ use: { kind: "uniform", out: 9, in: 9 }, convergence: { kind: "retired-indexes" } }),
    ).toEqual(elect());
  });

  test("the T2306 proxy DOES move it — the declaration tiers stop being fed by a retired word and start being fed by fan-out", () => {
    const proxied = elect({
      use: { kind: "retired-words" },
      convergence: { kind: "use-out-degree", threshold: 3 },
    });
    const topAtDefault = elect().candidates.slice(0, 9).map((candidate) => candidate.id);
    const topProxied = proxied.candidates.slice(0, 9).map((candidate) => candidate.id);
    expect(topProxied).not.toEqual(topAtDefault);
    // Tier ② stops meaning "declares an `indexes`". On THIS fixture the proxy
    // is not a superset but a REPLACEMENT — a node that declares an `indexes`
    // edge yet cites fewer than three `use` targets loses the tier, and one
    // that cites three under unsettled sides gains tier ① instead. That is the
    // measurement 05a exists to put in front of a ruling, not a result this
    // test endorses.
    const tier2Of = (result: ReturnType<typeof elect>) =>
      result.candidates.filter((candidate) => candidate.tier === 2).map((candidate) => candidate.id).sort((a, b) => a - b);
    const defaultTier2 = tier2Of(elect());
    const proxiedTier2 = tier2Of(proxied);
    expect(proxiedTier2).not.toEqual(defaultTier2);
    const indexDeclarers = new Set(
      fixture.edges.filter((row) => row.relation === "indexes").map((row) => row.citingId),
    );
    expect(defaultTier2.every((id) => indexDeclarers.has(id))).toBe(true);
    expect(defaultTier2.some((id) => !proxiedTier2.includes(id))).toBe(true);
  });
});
