import { describe, expect, test } from "bun:test";

import {
  ELECTION_A_SEAT_SHARE,
  ELECTION_B_SEAT_SHARE,
  ELECTION_RANKING_CRITERION,
  ELECTION_RANKING_RUBRIC,
  ELECTION_TIERS,
  electionSeatCeiling,
  isElectionTier,
} from "../src/election";
import { ELECTION_ERA_CUTOFF_EPOCH, isElectionEra } from "../src/election-era";

describe("electionSeatCeiling — ceilings, never targets (ADR-0003)", () => {
  test("N=50 gives 5 A seats and 15 B seats, matching the ADR's own worked example", () => {
    expect(electionSeatCeiling(ELECTION_A_SEAT_SHARE, 50)).toBe(5);
    expect(electionSeatCeiling(ELECTION_B_SEAT_SHARE, 50)).toBe(15);
  });

  test("a sparse window can floor to zero seats — a ceiling of zero is legal, not a bug", () => {
    expect(electionSeatCeiling(ELECTION_A_SEAT_SHARE, 5)).toBe(0);
    expect(electionSeatCeiling(ELECTION_A_SEAT_SHARE, 9)).toBe(0);
    expect(electionSeatCeiling(ELECTION_A_SEAT_SHARE, 10)).toBe(1);
  });

  test("N=0 gives a zero ceiling on both tiers", () => {
    expect(electionSeatCeiling(ELECTION_A_SEAT_SHARE, 0)).toBe(0);
    expect(electionSeatCeiling(ELECTION_B_SEAT_SHARE, 0)).toBe(0);
  });

  test("floors rather than rounds — 6% of 39 is 2.34, not 2 by rounding but by truncation", () => {
    expect(electionSeatCeiling(ELECTION_A_SEAT_SHARE, 39)).toBe(3);
    expect(Math.floor(0.1 * 39)).toBe(3);
  });
});

describe("isElectionTier", () => {
  test("accepts exactly A/B/C", () => {
    for (const tier of ELECTION_TIERS) {
      expect(isElectionTier(tier)).toBe(true);
    }
  });

  test("rejects anything else, including a legacy grade number or a lowercase tier", () => {
    expect(isElectionTier("a")).toBe(false);
    expect(isElectionTier("D")).toBe(false);
    expect(isElectionTier(2)).toBe(false);
    expect(isElectionTier(null)).toBe(false);
    expect(isElectionTier(undefined)).toBe(false);
  });
});

describe("the prompt rubric text carries the criterion and the live ceiling numbers", () => {
  test("the one-liner and both percentages appear, computed from the same shares the code enforces", () => {
    expect(ELECTION_RANKING_RUBRIC).toContain(ELECTION_RANKING_CRITERION);
    expect(ELECTION_RANKING_RUBRIC).toContain("floor(10%·N)");
    expect(ELECTION_RANKING_RUBRIC).toContain("floor(30%·N)");
    expect(ELECTION_RANKING_RUBRIC).toContain("Seats are CEILINGS, never");
  });
});

describe("isElectionEra — a turn's creation epoch decides grade vs tier (ADR-0003, mirrors task-causality-era.ts)", () => {
  const cutoffEpoch = 200;

  test("flips exactly at the injected cutoff", () => {
    expect(isElectionEra(cutoffEpoch - 1, cutoffEpoch)).toBe(false);
    expect(isElectionEra(cutoffEpoch, cutoffEpoch)).toBe(true);
    expect(isElectionEra(cutoffEpoch + 1, cutoffEpoch)).toBe(true);
  });

  test("defaults to the placeholder constant, which sits above every settlement fixture's NOW (~1.8B)", () => {
    expect(isElectionEra(1_800_000_000)).toBe(false);
    expect(isElectionEra(ELECTION_ERA_CUTOFF_EPOCH)).toBe(true);
  });
});
