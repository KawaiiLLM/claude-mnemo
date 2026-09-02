import { describe, expect, test } from "bun:test";

import { MAX_PAGE_BUDGET, MAX_TURN_BUDGET } from "../../src/mcp/definitions";
import {
  renderNode,
  RENDER_INDENT_STEP,
  TURN_TITLE_RENDER_CAP_CHARS,
  type FormattedTurn,
  type TurnRenderFields,
} from "../../src/mcp/format";
import type { RecallTurnField } from "../../src/mcp/memory-filter";
import { estimateTokens } from "../../src/utils/token-estimate";
import {
  SETTLEMENT_BOUNDED_FIELDS,
  SETTLEMENT_READ_FIELD_BUDGETS,
  SETTLEMENT_READ_FIELDS,
  SETTLEMENT_READ_PAGE_BUDGET,
  SETTLEMENT_READ_TURN_BUDGET,
  SETTLEMENT_READ_TURNS_PER_PAGE,
} from "../../src/worker/note-settlement-read-budgets";

/**
 * SETTLEMENT-READ-ONCE TICKET 01 — THE BUDGET CONTRACT, EXECUTED (spec D1).
 *
 * The p95s behind `content`/`insight`/`metadata` are a measurement against
 * production and cannot be re-run here (that data is read-only and out of this
 * repo — the numbers and their window are recorded in the module's own doc).
 * What CAN be re-run, and is, is the arithmetic those numbers feed: does a
 * turn carrying every field at its cap actually fit inside the `turn` budget
 * the contract derived, and do `SETTLEMENT_READ_TURNS_PER_PAGE` of them fit
 * inside a page?
 *
 * That is the half a comment cannot keep honest. A renderer change — one more
 * structural line, a wider footer vocabulary, a bigger title cap — moves the
 * real cost and leaves the constant behind, and this file is what notices.
 */
describe("the settlement read budget contract holds against the real renderer", () => {
  const FIELDS: TurnRenderFields = new Set<RecallTurnField>(SETTLEMENT_READ_FIELDS);
  const BUDGETS = SETTLEMENT_READ_FIELD_BUDGETS as Record<string, number>;

  /** ASCII filler costing exactly `tokens` under `estimateTokens`. */
  function fillerOfTokens(tokens: number): string {
    const words: string[] = [];
    while (estimateTokens(words.join(" ")) < tokens) {
      words.push("abcd");
    }
    while (estimateTokens(words.join(" ")) > tokens) {
      words.pop();
    }
    return words.join(" ");
  }

  /** Forty atoms — spec D0's 20-out + 20-in cap — spending the whole relations budget. */
  function worstCaseRelations(): string[] {
    let width = 60;
    let atoms = Array.from({ length: 40 }, () => "e".repeat(width));
    while (estimateTokens(atoms.join("\n")) < BUDGETS.relations!) {
      width += 1;
      atoms = Array.from({ length: 40 }, () => "e".repeat(width));
    }
    while (estimateTokens(atoms.join("\n")) > BUDGETS.relations!) {
      width -= 1;
      atoms = Array.from({ length: 40 }, () => "e".repeat(width));
    }
    return atoms;
  }

  function worstCaseTurn(): FormattedTurn {
    return {
      id: 1,
      promptNumber: 1234,
      // The label enters the contract at its RENDER cap, not at an observed
      // p100 — that is what makes the overhead a bound rather than a guess.
      title: "T".repeat(TURN_TITLE_RENDER_CAP_CHARS),
      metadata: fillerOfTokens(BUDGETS.metadata!),
      content: fillerOfTokens(BUDGETS.content!),
      promptPreview: fillerOfTokens(BUDGETS.prompt!),
      responsePreview: null,
      insight: [fillerOfTokens(BUDGETS.insight!)],
      relations: worstCaseRelations(),
      status: "extracted",
    };
  }

  function renderWorstCase(turnBudget: number): string {
    return renderNode(
      { type: "turn", value: worstCaseTurn() },
      {
        indent: RENDER_INDENT_STEP,
        fields: FIELDS,
        sessionId: 1,
        turnBudget,
        fieldBudgets: SETTLEMENT_READ_FIELD_BUDGETS,
        boundedFields: new Set<RecallTurnField>(SETTLEMENT_BOUNDED_FIELDS),
      },
    );
  }

  test("`turn` holds a turn whose every field is at its cap — nothing cut, nothing dropped", () => {
    const rendered = renderWorstCase(SETTLEMENT_READ_TURN_BUDGET);

    // The proof is the report itself: a turn budget too small for the worst
    // case would name what it lost.
    expect(rendered).not.toContain("truncated:");
    expect(rendered.split("\n").filter((line) => line.trim().startsWith("e".repeat(20)))).toHaveLength(
      40,
    );
    expect(estimateTokens(rendered)).toBeLessThanOrEqual(SETTLEMENT_READ_TURN_BUDGET);
  });

  test("`turn` is Σ budgets + overhead + about 10%, and stays under MAX_TURN_BUDGET", () => {
    const uncapped = renderWorstCase(1_000_000);
    const sumOfBudgets =
      BUDGETS.metadata! + BUDGETS.content! + BUDGETS.prompt! + BUDGETS.insight! +
      BUDGETS.relations!;
    const rendered = estimateTokens(uncapped);

    // Structural overhead — the capped label, the field labels, the per-line
    // indentation, the forty atom rows' own indents — is what the budget pays
    // for beyond the fields themselves. It is small, and it is REAL.
    const overhead = rendered - sumOfBudgets;
    expect(overhead).toBeGreaterThan(0);
    expect(overhead).toBeLessThan(200);

    // At least the 10% the spec asks for, and not a budget invented far above
    // the measurement.
    expect(SETTLEMENT_READ_TURN_BUDGET).toBeGreaterThanOrEqual(Math.ceil(rendered * 1.1));
    expect(SETTLEMENT_READ_TURN_BUDGET).toBeLessThan(Math.ceil(rendered * 1.25));
    // Under the public ceiling, so spec D1's "content takes the remainder"
    // clause never fires and `content` keeps its measured p95 target.
    expect(SETTLEMENT_READ_TURN_BUDGET).toBeLessThan(MAX_TURN_BUDGET);
  });

  test("GO/NO-GO: the stated turns/page fits, and one more does not", () => {
    // The spec's own conservative test, against the CEILING each turn may
    // claim rather than against what a particular page happened to render.
    const framing = 19; // measured: `page x / y (total z)` + one session line
    const fits = SETTLEMENT_READ_TURNS_PER_PAGE * SETTLEMENT_READ_TURN_BUDGET + framing;
    const oneMore = (SETTLEMENT_READ_TURNS_PER_PAGE + 1) * SETTLEMENT_READ_TURN_BUDGET + framing;

    expect(fits).toBeLessThanOrEqual(MAX_PAGE_BUDGET);
    expect(oneMore).toBeGreaterThan(MAX_PAGE_BUDGET);
  });

  test("a page of worst-case turns fits BOTH ceilings — the token budget and the character envelope", () => {
    const block = renderWorstCase(SETTLEMENT_READ_TURN_BUDGET);
    const page = Array.from({ length: SETTLEMENT_READ_TURNS_PER_PAGE }, () => block).join("\n");

    expect(estimateTokens(page)).toBeLessThanOrEqual(SETTLEMENT_READ_PAGE_BUDGET);
    // The two ceilings do not agree: this render prices at over four characters
    // per estimated token (indentation folds into space-run tokens), so the
    // page budget is derived from the 100,000-character worker envelope rather
    // than from MAX_PAGE_BUDGET, which would translate past it.
    expect(page.length).toBeLessThanOrEqual(100_000);
    expect(SETTLEMENT_READ_PAGE_BUDGET).toBeLessThanOrEqual(MAX_PAGE_BUDGET);
    expect(SETTLEMENT_READ_PAGE_BUDGET * (block.length / estimateTokens(block))).toBeLessThan(
      100_000,
    );
  });

  test("`prompt` is the only bounded field, and every bounded field carries a cap", () => {
    expect([...SETTLEMENT_BOUNDED_FIELDS]).toEqual(["prompt"]);
    for (const field of SETTLEMENT_BOUNDED_FIELDS) {
      expect(SETTLEMENT_READ_FIELD_BUDGETS[field]).toBeGreaterThan(0);
      expect(SETTLEMENT_READ_FIELDS).toContain(field);
    }
    // `relations` is delivery-gated and can never be declared intentional.
    expect(SETTLEMENT_BOUNDED_FIELDS).not.toContain("relations");
  });

  test("the field union is what BOTH stages need — the edge pass adds no field of its own", () => {
    // Stage 2's own read (insight for judgment, relations for the gate) is
    // already inside stage 1's list: that is the whole "read once" claim.
    for (const field of ["title", "metadata", "content", "prompt", "insight", "relations"]) {
      expect(SETTLEMENT_READ_FIELDS).toContain(field as RecallTurnField);
    }
  });
});
