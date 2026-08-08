import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import {
  anonymizeNoteText,
  anonymizeNoteTitle,
  collectPairCandidates,
  exportBlindPairs,
  hasStructuralTitlePrefix,
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
      ],
      key,
    );

    expect(tally).toMatchObject({
      scored: 2,
      shadowWins: 1,
      legacyWins: 1,
      ties: 0,
      complete: true,
    });
    expect(tally.shadowWinRate).toBeCloseTo(0.5, 10);
  });

  test("an incomplete or malformed verdict set yields no win rate", () => {
    const { key } = exportBlindPairs(db, { seed: 1 });
    const first = key[0]!.pairId;

    // One key pair unanswered, one verdict for a pair that is not in the key,
    // the same pair judged twice, and a row that is not a verdict at all. Each
    // is a different hole; none of them may produce a number.
    const tally = unblindVerdicts(
      [
        { pairId: first, winner: "A" },
        { pairId: first, winner: "B" },
        { pairId: "p9999", winner: "tie" },
        { pairId: key[1]!.pairId, winner: "maybe" },
        "not an object",
      ],
      key,
    );

    expect(tally.complete).toBe(false);
    expect(tally.shadowWinRate).toBeNull();
    expect(tally.duplicates).toEqual([first]);
    expect(tally.unmatched).toEqual(["p9999"]);
    expect(tally.missing).toEqual([key[1]!.pairId]);
    expect(tally.invalid).toEqual(["line 4", "line 5"]);
  });

  test("a key file with a duplicate pairId is a hard error, not a silently collapsed row", () => {
    // `new Map(key.map(...))` would keep only the last of two rows sharing a
    // pairId — possibly naming a different turn — and report `complete: true`
    // as long as the surviving row got scored. The pairId space in a key file
    // has to be a set before it is trusted as one.
    const { key } = exportBlindPairs(db, { seed: 1 });
    const corruptKey = [...key, key[0]!];

    expect(() => unblindVerdicts([], corruptKey)).toThrow(
      new RegExp(`${key[0]!.pairId}.*more than once`, "u"),
    );
  });

  test("a complete set of well-formed verdicts scores and reports a rate", () => {
    const { key } = exportBlindPairs(db, { seed: 1 });

    const tally = unblindVerdicts(
      key.map((row) => ({
        pairId: row.pairId,
        winner: row.a === "shadow" ? "A" : "B",
      })),
      key,
    );

    expect(tally.complete).toBe(true);
    expect(tally.missing).toEqual([]);
    expect(tally.shadowWinRate).toBe(1);
  });

  test("the prescribed title prefix is stripped, so no regex sorts the sides", () => {
    // The note-taking instructions prescribe "<activity>+<topic>: …" for the
    // agent's titles and nothing at all for the legacy pipeline's, so the shape
    // alone would name the author before a judge read a word.
    expect(anonymizeNoteTitle("implement+note-debt: closed the ledger loop")).toBe(
      "closed the ledger loop",
    );
    // Matched by shape, not by the instructions' activity vocabulary: an agent
    // that invents an activity word produces the same tell.
    expect(anonymizeNoteTitle("refactor+cache:  warmed the prefix")).toBe(
      "warmed the prefix",
    );
    // A full-width colon is the same structure in the bilingual corpus.
    expect(anonymizeNoteTitle("fix+recall：修好了检索")).toBe("修好了检索");
    // An ordinary title is left alone. A title that is nothing but the prefix
    // is emptied, not kept: keeping it would hand the judge the exact
    // source-structure tell the strip exists to remove.
    expect(anonymizeNoteTitle("Recall returns zero for CJK bigrams")).toBe(
      "Recall returns zero for CJK bigrams",
    );
    expect(anonymizeNoteTitle("design+arc-spine:")).toBe("");
    expect(anonymizeNoteTitle("fix+cache: ")).toBe("");

    const { pairs } = exportBlindPairs(db, { seed: 1 });
    for (const pair of pairs) {
      for (const side of [pair.a, pair.b]) {
        expect(hasStructuralTitlePrefix(side.title)).toBe(false);
      }
    }
  });

  test("no anonymised title is a bare '<word>+<word>:' shell — the reviewer's fingerprint regex finds nothing", () => {
    // The exact detection regex the review round used to name this bug: a
    // title that is the structural prefix and nothing else, colon to end of
    // string. Run over every title this module actually produces, plus the
    // pure-prefix shapes that used to fall back to the untouched original.
    const REVIEWER_FINGERPRINT =
      /^[\p{L}\p{N}_-]{1,24}\s*\+\s*[^:：\n]{1,48}[:：]\s*$/u;

    for (const seed of [1, 2, 3]) {
      const { pairs } = exportBlindPairs(db, { seed });
      for (const pair of pairs) {
        expect(pair.a.title).not.toMatch(REVIEWER_FINGERPRINT);
        expect(pair.b.title).not.toMatch(REVIEWER_FINGERPRINT);
      }
    }

    for (const sample of [
      "design+arc-spine:",
      "fix+cache:",
      "refactor+cache：",
      "implement+note-debt: ",
    ]) {
      expect(anonymizeNoteTitle(sample)).not.toMatch(REVIEWER_FINGERPRINT);
    }
  });

  test("the export declares what it normalised and what it could not", () => {
    const exported = exportBlindPairs(db, { seed: 3 });

    expect(exported.header).toMatchObject({
      kind: "blind-pairs-header",
      seed: 3,
      pairCount: exported.pairs.length,
    });
    expect(exported.header.residualFingerprints.join(" ")).toContain(
      "length distribution",
    );
    // Per-source measurements belong to the operator's report, never to the
    // file a judge is handed.
    expect(JSON.stringify(exported.header)).not.toContain("shadow");
    expect(exported.stats.shadowContentMedianCharacters).toBeGreaterThan(0);
    expect(exported.stats.legacyContentMedianCharacters).toBeGreaterThan(0);
  });
});
