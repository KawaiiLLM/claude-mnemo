import { describe, expect, test } from "bun:test";

import { countTokens } from "../../src/shared/token-count";

/**
 * Calibration pins for the frontier-injection runtime tokenizer (ticket 01;
 * spec "Budget arithmetic", USER RULED S15069/T2218). Every count here is
 * EXACT against the pinned ranks (js-tiktoken@1.0.21, o200k_base) — the same
 * measurements that drove the design, reproduced as fixtures. If any of these
 * ever fails, the rank table changed underneath the budgets: that is a
 * design-recalibration event, not a number to update casually.
 */
describe("countTokens — o200k_base calibration pins", () => {
  test("reproduces the design measurements exactly", () => {
    // One English word with its leading space is ONE token — the 4-chars-per-
    // token heuristic would price " extends" at 2.
    expect(countTokens(" extends")).toBe(1);
    // An emoji glyph costs ~3 tokens — the reason the spec retires emoji for
    // type words on these surfaces (user story 17).
    expect(countTokens("⚖️")).toBe(3);
    // A bare T-address is 3 tokens ("T" + digit-chunked number)…
    expect(countTokens("T2151")).toBe(3);
    // …and a FULL-FORM address is 6: address-dominance — jump targets, not
    // prose, dominate a row's budget, which is why pointer fields are omitted
    // whole rather than string-truncated.
    expect(countTokens("S15069/T2218")).toBe(6);
    // A relation arrow rides nearly free next to its word: " ->" is 1 more.
    expect(countTokens(" extends ->")).toBe(2);
  });

  test("prices a full elected row and a full digest line exactly", () => {
    // Elected-row form: `T<n> <MM-DD> <type words> <title>`.
    expect(
      countTokens(
        "T2151 08-12 design correction milestone corrector promotion ships",
      ),
    ).toBe(14);
    // Digest-line form with a cross-address override pointer.
    expect(
      countTokens(
        "#lane · 12 settled · 34 edges · islands 2+1 · latest override S15069/T2218 -> S15069/T2186 · frontier 5",
      ),
    ).toBe(36);
  });

  test("counts special-token text as ordinary bytes instead of throwing", () => {
    // Rendered memory content is MEASURED, never interpreted: a title quoting
    // "<|endoftext|>" prices as the bytes a model would read (7 BPE tokens),
    // not as one special id (which would under-price it) and not as a crash
    // (js-tiktoken's default disallowedSpecial="all" throws here).
    expect(countTokens("<|endoftext|>")).toBe(7);
  });

  test("empty input costs nothing", () => {
    expect(countTokens("")).toBe(0);
  });
});
