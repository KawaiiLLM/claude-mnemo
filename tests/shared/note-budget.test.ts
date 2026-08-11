import { describe, expect, test } from "bun:test";

import {
  NOTE_TOKEN_BUDGET,
  formatNoteBudget,
} from "../../src/shared/note-budget";

describe("note budget line", () => {
  test("reports each field against its own budget, then the total", () => {
    expect(
      formatNoteBudget({
        title: "t".repeat(80),
        content: "c".repeat(400),
        insight: "i".repeat(240),
      }),
    ).toBe("title 20/20 · content 100/100 · insight 60/60 → 180/180 (1.0×).");
  });

  test("an absent insight leaves the denominator alone", () => {
    // Empty is the documented default for insight. Counting its budget anyway
    // would make every ordinary note look 33% under, which is the opposite of
    // the signal this line exists to give.
    const withoutInsight = formatNoteBudget({
      title: "t".repeat(80),
      content: "c".repeat(400),
    });

    expect(withoutInsight).toBe("title 20/20 · content 100/100 → 120/120 (1.0×).");
    expect(formatNoteBudget({ title: "t", content: "c", insight: "" })).not.toContain(
      "insight",
    );
  });

  test("an over-budget write reads as a multiple, not just a count", () => {
    // The number that has to survive a skim is "how far over", so it is stated
    // outright rather than left to be divided out of the two totals.
    expect(
      formatNoteBudget({
        title: "t".repeat(80),
        content: "c".repeat(1000),
      }),
    ).toContain("→ 270/120 (2.3×).");
  });

  test("the budget the receipt measures is the one the instructions state", () => {
    expect(NOTE_TOKEN_BUDGET).toEqual({ title: 20, content: 100, insight: 60 });
  });
});
