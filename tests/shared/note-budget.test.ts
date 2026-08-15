import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  NOTE_TOKEN_BUDGET,
  formatNoteBudget,
} from "../../src/shared/note-budget";
import { NOTE_TAKING_INSTRUCTIONS } from "../../src/hooks/handlers/context-note-taking";
import { MNEMO_TOOL_DESCRIPTIONS } from "../../src/mcp/definitions";

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

  test("a write well under budget does not read as nothing written", () => {
    // A one-decimal ratio prints "(0.0×)" for anything under 5% of the budget,
    // which reads as "your note is empty" rather than "you have room". The
    // decimal exists for the over-budget case, so the under-budget floor is
    // stated as an inequality instead of rounded away.
    expect(formatNoteBudget({ title: "fix", content: "done" })).toContain(
      "→ 2/120 (<0.1×).",
    );
  });

  test("quoted CJK is not counted at a quarter of its size", () => {
    // The instructions require English fields but explicitly allow quoted user
    // phrases in their original language, and four-characters-per-token reports
    // 80 Chinese characters as 20 tokens — a note that is 4x over budget reads
    // as inside it, which is the one thing this line exists to prevent.
    const han = "词".repeat(80);

    expect(formatNoteBudget({ title: "t", content: han })).toContain(
      "content 80/100",
    );
  });

  test("the budget the receipt measures is the one the instructions state", () => {
    expect(NOTE_TOKEN_BUDGET).toEqual({ title: 20, content: 100, insight: 60 });
  });

  test("every surface that states the budget reads it from the constant", () => {
    // Two surfaces say these numbers now: the receipt and the `note` tool
    // description — the T586 single-home split removed them from the
    // session-start block entirely, which must therefore NOT mention them (a
    // budget stated there would be a second copy, the exact drift this test
    // exists to prevent). The description once held them as literal prose, so
    // changing NOTE_TOKEN_BUDGET would have left the agent told one budget
    // and measured against another. Asserted on the source text because the
    // rendered strings agree either way — the literals are exactly what a
    // value check cannot see.
    const source = readFileSync("src/mcp/definitions.ts", "utf8");
    expect(source).toContain("NOTE_TOKEN_BUDGET.title");
    expect(source).toContain("NOTE_TOKEN_BUDGET.content");
    expect(source).toContain("NOTE_TOKEN_BUDGET.insight");

    expect(MNEMO_TOOL_DESCRIPTIONS.note).toContain(
      `(~${NOTE_TOKEN_BUDGET.title} tok)`,
    );
    expect(MNEMO_TOOL_DESCRIPTIONS.note).toContain(
      `(~${NOTE_TOKEN_BUDGET.content} tok)`,
    );
    expect(MNEMO_TOOL_DESCRIPTIONS.note).toContain(
      `(~${NOTE_TOKEN_BUDGET.insight} tok`,
    );

    expect(NOTE_TAKING_INSTRUCTIONS).not.toContain("tokens)");
  });
});
