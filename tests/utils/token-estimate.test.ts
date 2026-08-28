import { describe, expect, test } from "bun:test";

import { estimateTokens } from "../../src/utils/token-estimate";

/**
 * Whitespace-runs-price-as-one-token ticket 14: a maximal run of TWO OR MORE
 * consecutive U+0020 spaces prices as ONE token total, not `run.length / 4`
 * — BPE reality, confirmed against the user's own challenge
 * [S15069/T1915] ("不是4个空格对应一个token吧"). A single space (no run)
 * keeps flowing through the general 1/4-per-char "rest" rate unchanged; CJK
 * pricing is untouched — the rule only ever touches U+0020 runs.
 */
describe("estimateTokens: whitespace-runs-price-as-one-token (ticket 14)", () => {
  test("an 8-space indent prices as exactly 1 token, not 2", () => {
    expect(estimateTokens("        ")).toBe(1);
  });

  test("every run length from 2 up prices as exactly 1 token — 'a run', not a length bracket", () => {
    expect(estimateTokens(" ".repeat(2))).toBe(1);
    expect(estimateTokens(" ".repeat(12))).toBe(1);
    expect(estimateTokens(" ".repeat(40))).toBe(1);
  });

  test("a single space inside prose still prices on the general 1/4-per-char rate, unchanged", () => {
    expect(estimateTokens("abc")).toBe(1); // ceil(3/4)
    // The one interior space is NOT a run (needs >=2) — it still adds its
    // own 1/4, same as any other non-CJK character, which is what tips this
    // string's ceiling from 1 token ("abc" alone) to 2.
    expect(estimateTokens("abc d")).toBe(2); // ceil(5/4)
  });

  test("two ISOLATED single spaces (not adjacent, so neither is a run) price identically to two ordinary characters in the same positions", () => {
    expect(estimateTokens("a b c")).toBe(estimateTokens("abcde"));
  });

  test("a run's characters are priced ONCE, as the run — not double-counted against the general rest pool", () => {
    // 10 chars total (8 in the run + 2 plain) — the naive per-char rule
    // would price this at ceil(10/4) = 3; the run rule instead backs the
    // 8 run-chars out of the 1/4 pool and adds their own flat 1 token.
    expect(estimateTokens("xx" + " ".repeat(8))).toBe(2); // ceil(0(cjk) + 1(run) + 2/4) = 2
  });

  test("a CJK string with no space run prices unchanged — 1 token per Han character", () => {
    expect(estimateTokens("卷号锚定")).toBe(4);
  });

  test("a CJK string carrying an interior space run prices the Han characters at 1/char AND the run at its own flat token", () => {
    expect(estimateTokens("卷号  锚定")).toBe(5); // 4 (Han, 1 each) + 1 (the 2-space run)
  });

  test("tabs and other whitespace are untouched by the space-run rule", () => {
    // A tab run is NOT collapsed — it still prices on the general rate, same
    // as before this ticket (decision 1: "Tabs and other whitespace are
    // untouched").
    expect(estimateTokens("\t\t\t\t")).toBe(1); // ceil(4/4), the plain rate — coincidentally also 1, but via the UNCHANGED path
    expect(estimateTokens("\t\t\t\t\t")).toBe(2); // ceil(5/4) — a 5th tab tips it, proving no run-collapse happened
  });
});
