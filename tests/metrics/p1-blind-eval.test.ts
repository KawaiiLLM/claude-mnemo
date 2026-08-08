import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import {
  anonymizeNoteText,
  collectPairCandidates,
  exportBlindPairs,
  unblindVerdicts,
  type PairKeyRow,
} from "../../src/metrics/p1/blind-pairs";
import { openReadOnlyDatabase } from "../../src/metrics/p1/database";
import { createFixtureDatabase, type FixtureIds } from "./p1-fixture";

describe("P1 blind evaluation pairs", () => {
  let fixture: FixtureIds;
  let db: Database;

  beforeAll(() => {
    fixture = createFixtureDatabase();
    db = openReadOnlyDatabase(fixture.path);
  });

  afterAll(() => {
    db.close();
  });

  test("pairs only the turns that carry both summaries", () => {
    const { candidates, stats } = collectPairCandidates(db);

    expect(candidates.map((candidate) => candidate.turnId)).toEqual([
      fixture.turns.a1!,
      fixture.turns.b1!,
    ]);
    expect(stats).toMatchObject({
      shadowNotes: 4,
      candidates: 2,
      droppedMissingLegacy: 1,
      droppedEmptyField: 1,
    });
  });

  test("the judged payload carries nothing that names the author", () => {
    const { pairs } = exportBlindPairs(db, { seed: 1 });

    for (const pair of pairs) {
      expect(Object.keys(pair).sort()).toEqual([
        "a",
        "b",
        "pairId",
        "prompt",
        "tools",
      ]);

      for (const side of [pair.a, pair.b]) {
        expect(Object.keys(side).sort()).toEqual(["content", "title"]);
        // Citation syntax is an author fingerprint: the agent writes the
        // fully-qualified form, the legacy pipeline wrote the bare one.
        expect(side.content).not.toMatch(/\[S\d+\/T\d+\]/u);
        expect(side.content).not.toMatch(/\[T\d+\]/u);
        // Layout is the other fingerprint.
        expect(side.content).not.toContain("\n");
        expect(side.title).not.toContain("\n");
      }
    }

    const first = pairs[0]!;
    expect(`${first.a.content} ${first.b.content}`.match(/\[ref\]/gu)).toHaveLength(2);
  });

  test("insight never reaches the judge but is kept in the key", () => {
    const { pairs, key } = exportBlindPairs(db, { seed: 1 });

    expect(JSON.stringify(pairs)).not.toContain("readonly URI beats");
    expect(key.some((row) => row.shadowInsight?.includes("readonly URI beats"))).toBe(
      true,
    );
  });

  test("A and B are randomised, reproducibly, and the key records which is which", () => {
    const first = exportBlindPairs(db, { seed: 1 });
    const again = exportBlindPairs(db, { seed: 1 });

    expect(again.key.map((row) => row.a)).toEqual(first.key.map((row) => row.a));

    for (const row of first.key) {
      expect(row.a).not.toBe(row.b);
      expect(["shadow", "legacy"]).toContain(row.a);
    }

    const assignments = new Set(
      Array.from({ length: 24 }, (_, seed) =>
        exportBlindPairs(db, { seed: seed + 1 })
          .key.map((row) => row.a)
          .join(","),
      ),
    );
    expect(assignments.size).toBeGreaterThan(1);
  });

  test("anonymisation keeps the words and drops the formatting", () => {
    expect(anonymizeNoteText("a [S1/T3] b\n\n- c  d")).toBe("a [ref] b - c d");
  });

  test("verdicts are scored through the key, not the payload", () => {
    const { key } = exportBlindPairs(db, { seed: 1 });
    const shadowSide = (row: PairKeyRow): "A" | "B" =>
      row.a === "shadow" ? "A" : "B";

    const tally = unblindVerdicts(
      [
        { pairId: key[0]!.pairId, winner: shadowSide(key[0]!) },
        { pairId: key[1]!.pairId, winner: shadowSide(key[1]!) === "A" ? "B" : "A" },
        { pairId: "p9999", winner: "tie" },
      ],
      key,
    );

    expect(tally).toMatchObject({
      scored: 2,
      shadowWins: 1,
      legacyWins: 1,
      ties: 0,
      unmatched: ["p9999"],
    });
    expect(tally.shadowWinRate).toBeCloseTo(0.5, 10);
  });
});
