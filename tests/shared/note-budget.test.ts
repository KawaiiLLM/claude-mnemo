import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  BUDGET_WARNING_MULTIPLE,
  NOTE_TOKEN_BUDGET,
  formatBudgetWarning,
  formatNoteBudget,
} from "../../src/shared/note-budget";
import { NOTE_TAKING_INSTRUCTIONS } from "../../src/hooks/handlers/context-note-taking";
import { noteInputSchema } from "../../src/mcp/definitions";

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
    // Two surfaces say these numbers now: the receipt and each budgeted
    // parameter's own `.describe()` (title/content/insight) — the T586
    // single-home split removed them from the session-start block entirely,
    // which must therefore NOT mention them (a budget stated there would be a
    // second copy, the exact drift this test exists to prevent). Ticket 01
    // moved the numbers out of the tool description's own prose and onto each
    // field's parameter — spliced from the same constant, not restated as a
    // literal, so changing NOTE_TOKEN_BUDGET would have left the agent told
    // one budget and measured against another. Asserted on the source text
    // because the rendered strings agree either way — the literals are
    // exactly what a value check cannot see.
    const source = readFileSync("src/mcp/definitions.ts", "utf8");
    expect(source).toContain("NOTE_TOKEN_BUDGET.title");
    expect(source).toContain("NOTE_TOKEN_BUDGET.content");
    expect(source).toContain("NOTE_TOKEN_BUDGET.insight");

    const shape = noteInputSchema.shape;
    expect(shape.title.description).toContain(`~${NOTE_TOKEN_BUDGET.title} tok`);
    expect(shape.content.description).toContain(`~${NOTE_TOKEN_BUDGET.content} tok`);
    expect(shape.insight.description).toContain(`~${NOTE_TOKEN_BUDGET.insight} tok`);

    expect(NOTE_TAKING_INSTRUCTIONS).not.toContain("tokens)");
  });
});

// Ticket 01 (field-semantics spec): the 2× hard-rejection check
// (`budgetOverageRejection`/`BUDGET_REJECTION_MULTIPLE`) is retired outright.
// `formatBudgetWarning` is what replaces it — a receipt-only signal, never a
// gate, that fires on every call whose current field state lands over
// `BUDGET_WARNING_MULTIPLE`, with nothing remembered between calls.
describe("note budget warning (1.5×, ticket 01)", () => {
  test("is 1.5", () => {
    expect(BUDGET_WARNING_MULTIPLE).toBe(1.5);
  });

  test("null when every field is within 1.5× its own budget", () => {
    expect(
      formatBudgetWarning({ title: "t".repeat(80), content: "c".repeat(400) }),
    ).toBeNull();
  });

  test("names a single field over the line", () => {
    const warning = formatBudgetWarning({
      title: "t",
      content: "c".repeat(604), // 151 tok, one over 1.5x of the 100 tok budget
    });
    expect(warning).toBe(
      "content is over 1.5× budget — an occasional overage is fine, a standing pattern of it is not.",
    );
  });

  test("names every field over the line, not just the first", () => {
    const warning = formatBudgetWarning({
      title: "t".repeat(124), // 31 tok, over 1.5x of the 20 tok budget
      content: "c".repeat(604), // 151 tok, over 1.5x of the 100 tok budget
    });
    expect(warning).toBe(
      "title, content are over 1.5× budget — an occasional overage is fine, a standing pattern of it is not.",
    );
  });

  test("insight only counts when one was written", () => {
    expect(
      formatBudgetWarning({ title: "t", content: "c", insight: undefined }),
    ).toBeNull();
    expect(
      formatBudgetWarning({ title: "t", content: "c", insight: "" }),
    ).toBeNull();
    expect(
      formatBudgetWarning({ title: "t", content: "c", insight: "i".repeat(364) }), // 91 tok, over 1.5x of the 60 tok budget
    ).toBe(
      "insight is over 1.5× budget — an occasional overage is fine, a standing pattern of it is not.",
    );
  });

  // The exact line this test exists to enforce: called again with the same
  // oversized field, the warning fires again — no memory of the earlier call.
  test("fires on every call, not just the first — no suppression state", () => {
    const oversized = { title: "t", content: "c".repeat(604) };
    expect(formatBudgetWarning(oversized)).not.toBeNull();
    expect(formatBudgetWarning(oversized)).not.toBeNull();
    expect(formatBudgetWarning(oversized)).not.toBeNull();
  });
});
