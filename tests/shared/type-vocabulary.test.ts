import { describe, expect, test } from "bun:test";

import {
  COMPACT_TYPE_GLYPH,
  isMemoryType,
  LEGACY_TYPE_GLYPH,
  MEMORY_TYPES,
  normalizeTypeValues,
  TYPE_GLYPH,
  typeListGlyph,
  typeListsEqual,
  typeWordGlyph,
} from "../../src/shared/type-vocabulary";

/**
 * Ticket 02 (spec B1/B2/B5/B7) — the mechanical title-to-type derivation
 * (`draftTypeFromTitle`/`draftTurnFactsFromTitle`/`withDraftedTopicTag`) is
 * retired, not kept as a fallback. What survives is the closed vocabulary
 * itself, multi-value validation, and glyph resolution across both the
 * current and legacy word sets.
 */
describe("MEMORY_TYPES (spec B2)", () => {
  test("is exactly the eleven current-vocabulary peers", () => {
    expect(MEMORY_TYPES).toEqual([
      "discuss",
      "research",
      "design",
      "implement",
      "refactor",
      "fix",
      "measure",
      "review",
      "ops",
      "delegate",
      "correction",
    ]);
  });

  test("write, chat and rolled-back left the vocabulary", () => {
    for (const retired of ["write", "chat", "rolled-back"]) {
      expect(isMemoryType(retired)).toBe(false);
    }
  });

  test("isMemoryType recognises every current word and rejects everything else", () => {
    for (const word of MEMORY_TYPES) {
      expect(isMemoryType(word)).toBe(true);
    }
    expect(isMemoryType("bugfix")).toBe(false);
    expect(isMemoryType("")).toBe(false);
    expect(isMemoryType(42)).toBe(false);
  });
});

describe("normalizeTypeValues (spec B5/B7)", () => {
  test("validates, dedupes, and preserves the caller's order", () => {
    expect(normalizeTypeValues(["review", "ops", "review"])).toEqual([
      "review",
      "ops",
    ]);
    expect(normalizeTypeValues(["ops", "review"])).toEqual(["ops", "review"]);
  });

  test("drops blank entries but throws on an unrecognised word", () => {
    expect(normalizeTypeValues(["fix", "  ", ""])).toEqual(["fix"]);
    expect(() => normalizeTypeValues(["invented"])).toThrow(
      "unknown type value: invented",
    );
  });

  test("no word is restricted to a particular writer — correction included", () => {
    // Unlike the retired `rolled-back`, `correction` is an ordinary peer any
    // writer may state (spec B2: a turn declares it reversed a position
    // itself, at the moment it knows).
    expect(normalizeTypeValues(["correction"])).toEqual(["correction"]);
  });

  test("an empty list normalizes to an empty list — the writer stated nothing", () => {
    expect(normalizeTypeValues([])).toEqual([]);
  });
});

describe("typeListsEqual (the timeline's phase-grouping rule)", () => {
  test("equal only when both lists are the same length and order", () => {
    expect(typeListsEqual(["review", "ops"], ["review", "ops"])).toBe(true);
    expect(typeListsEqual(["review", "ops"], ["ops", "review"])).toBe(false);
    expect(typeListsEqual(["review"], ["review", "ops"])).toBe(false);
    expect(typeListsEqual([], [])).toBe(true);
  });
});

describe("glyph resolution (spec B5: the timeline renders real activity words again)", () => {
  test("every current-vocabulary word has its own glyph", () => {
    for (const word of MEMORY_TYPES) {
      expect(TYPE_GLYPH[word]).toBeTruthy();
      expect(typeWordGlyph(word)).toBe(TYPE_GLYPH[word]);
    }
  });

  test("a legacy word reachable through an old row resolves to its own glyph, compact included", () => {
    for (const legacy of ["bugfix", "feature", "refactor", "change", "discovery", "decision"]) {
      expect(typeWordGlyph(legacy)).toBe(LEGACY_TYPE_GLYPH[legacy]);
    }
    expect(typeWordGlyph("compact")).toBe(COMPACT_TYPE_GLYPH);
  });

  test("an unrecognised word (current or legacy) falls back to the placeholder glyph", () => {
    expect(typeWordGlyph("nonsense")).toBe("•");
  });

  test("typeListGlyph joins a multi-valued list into more than one glyph", () => {
    expect(typeListGlyph(["review", "ops"])).toBe(
      `${TYPE_GLYPH.review}${TYPE_GLYPH.ops}`,
    );
  });

  test("empty is never a claim (spec B7): the placeholder glyph, same as null/undefined", () => {
    expect(typeListGlyph([])).toBe("•");
    expect(typeListGlyph(null)).toBe("•");
    expect(typeListGlyph(undefined)).toBe("•");
  });
});
