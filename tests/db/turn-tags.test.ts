import { describe, expect, test } from "bun:test";

import { MalformedTurnTagsError, readTurnTags } from "../../src/db/turn-tags";

/**
 * THE ONE PARSER for `turns.tags` (main-agent-edges spec D9 transform 1;
 * R9-8 / R10-10). Every reader and writer of the column goes through it; the
 * storage trigger refuses what it refuses, so a malformed value is a defect to
 * surface by name, never a state to coerce.
 */
describe("readTurnTags", () => {
  test("a JSON array of strings reads back as-is; NULL (deferral-window stock) reads as no tags", () => {
    expect(readTurnTags('["alpha","beta"]')).toEqual(["alpha", "beta"]);
    expect(readTurnTags("[]")).toEqual([]);
    expect(readTurnTags(null)).toEqual([]);
    expect(readTurnTags(undefined)).toEqual([]);
  });

  test("anything else THROWS by name — invalid JSON, a non-array, a non-string member — instead of coercing", () => {
    expect(() => readTurnTags("{not json")).toThrow(MalformedTurnTagsError);
    expect(() => readTurnTags('{"a":1}')).toThrow(/not an array/);
    expect(() => readTurnTags('"alpha"')).toThrow(/not an array/);
    expect(() => readTurnTags('["alpha", 7]')).toThrow(/a member is not a string/);
    try {
      readTurnTags('["alpha", 7]');
    } catch (error) {
      expect(error).toBeInstanceOf(MalformedTurnTagsError);
      expect((error as MalformedTurnTagsError).raw).toBe('["alpha", 7]');
    }
  });
});
