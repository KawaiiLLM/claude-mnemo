import { describe, expect, test } from "bun:test";

import {
  IMPRESSION_LINE1_TOKEN_CAP,
  IMPRESSION_LINE_TOKEN_CAP,
  IMPRESSION_MAX_LINES,
  TASK_IMPRESSION_TOKEN_CAP,
  anchorResolverFromResolvedSet,
  impressionCapForLane,
  validateImpression,
  type ImpressionRejectionRule,
} from "../../src/shared/lane-impressions";
import { countTokens } from "../../src/shared/token-count";

/**
 * Lane-impressions ticket 01 — the deterministic foundation, one property per
 * fixture, accept AND reject shapes for every rule (spec "Validator" +
 * Testing Decisions seam 1's deterministic-tier list).
 */

const resolveAll = () => true;
const resolveNone = () => false;

function rules(result: {
  rejections: Array<{ rule: ImpressionRejectionRule }>;
}): ImpressionRejectionRule[] {
  return result.rejections.map((rejection) => rejection.rule);
}

/** Roughly `n` tokens of plain prose (self-verified where a bound matters). */
function words(n: number): string {
  return Array.from({ length: n }, () => "lane").join(" ");
}

// ---------------------------------------------------------------------------
// Cap formula (USER RULED T2259-T2261): clamp(10 × n, 100, 500).
// ---------------------------------------------------------------------------

describe("impressionCapForLane", () => {
  test("integer edges: 0 members floors at 100 with no special case; 10 → 100; 11 → 110; 50 → 500", () => {
    expect(impressionCapForLane(0)).toBe(100);
    expect(impressionCapForLane(10)).toBe(100);
    expect(impressionCapForLane(11)).toBe(110);
    expect(impressionCapForLane(50)).toBe(500);
  });

  test("interior and ceiling: 12 → 120, 49 → 490, 51 and 1000 clamp to 500", () => {
    expect(impressionCapForLane(12)).toBe(120);
    expect(impressionCapForLane(49)).toBe(490);
    expect(impressionCapForLane(51)).toBe(500);
    expect(impressionCapForLane(1000)).toBe(500);
  });

  test("a non-integer or negative member count is a programmer error, not a clamp input", () => {
    expect(() => impressionCapForLane(1.5)).toThrow(TypeError);
    expect(() => impressionCapForLane(-1)).toThrow(TypeError);
    expect(() => impressionCapForLane(Number.NaN)).toThrow(TypeError);
  });

  test("the task tier is a flat 500", () => {
    expect(TASK_IMPRESSION_TOKEN_CAP).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Structure.
// ---------------------------------------------------------------------------

describe("validator: structure", () => {
  test("reject: empty and whitespace-only text", () => {
    for (const text of ["", "   ", "\n"]) {
      const result = validateImpression({ text, cap: 500, resolveAnchor: resolveAll });
      expect(result.accepted).toBe(false);
      expect(rules(result)).toContain("structure");
    }
  });

  test("reject: a blank interior line, and a trailing newline (a blank last line)", () => {
    const interior = validateImpression({
      text: "The lane's law (S1/T2).\n\nBinding: none.",
      cap: 500,
      resolveAnchor: resolveAll,
    });
    expect(interior.accepted).toBe(false);
    expect(interior.rejections).toContainEqual(
      expect.objectContaining({ rule: "structure", line: 2 }),
    );

    const trailing = validateImpression({
      text: "The lane's law (S1/T2).\n",
      cap: 500,
      resolveAnchor: resolveAll,
    });
    expect(trailing.accepted).toBe(false);
    expect(rules(trailing)).toContain("structure");
  });

  test("accept: newline-delimited prose lines with no blanks", () => {
    const result = validateImpression({
      text: "The lane's law (S1/T2).\nBinding: exact bytes (S1/T3).",
      cap: 500,
      resolveAnchor: resolveAll,
    });
    expect(result.accepted).toBe(true);
    expect(result.rejections).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Line count.
// ---------------------------------------------------------------------------

describe("validator: line count", () => {
  test("reject: 9 lines; accept: exactly 8", () => {
    const line = (i: number) => `Claim ${i} holds (S1/T${i}).`;
    const nine = Array.from({ length: 9 }, (_, i) => line(i + 1)).join("\n");
    const eight = Array.from({ length: 8 }, (_, i) => line(i + 1)).join("\n");

    const rejected = validateImpression({ text: nine, cap: 500, resolveAnchor: resolveAll });
    expect(rejected.accepted).toBe(false);
    expect(rules(rejected)).toContain("line-count");

    const accepted = validateImpression({ text: eight, cap: 500, resolveAnchor: resolveAll });
    expect(accepted.accepted).toBe(true);
    expect(IMPRESSION_MAX_LINES).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// Token caps (priced through the runtime tokenizer, never a char guess).
// ---------------------------------------------------------------------------

describe("validator: token caps", () => {
  test("line 1 caps at 150 when the lane cap is larger", () => {
    const long = `${words(170)} (S1/T2).`;
    expect(countTokens(long)).toBeGreaterThan(IMPRESSION_LINE1_TOKEN_CAP);

    const rejected = validateImpression({ text: long, cap: 500, resolveAnchor: resolveAll });
    expect(rejected.accepted).toBe(false);
    expect(rejected.rejections).toContainEqual(
      expect.objectContaining({ rule: "line-1-cap", line: 1 }),
    );

    const short = `${words(100)} (S1/T2).`;
    expect(countTokens(short)).toBeLessThanOrEqual(IMPRESSION_LINE1_TOKEN_CAP);
    expect(
      validateImpression({ text: short, cap: 500, resolveAnchor: resolveAll }).accepted,
    ).toBe(true);
  });

  test("line 1 caps at the LANE cap where that binds tighter than 150", () => {
    const line1 = `${words(120)} (S1/T2).`;
    const tokens = countTokens(line1);
    expect(tokens).toBeGreaterThan(100);
    expect(tokens).toBeLessThanOrEqual(150);

    const result = validateImpression({ text: line1, cap: 100, resolveAnchor: resolveAll });
    expect(result.accepted).toBe(false);
    expect(rules(result)).toContain("line-1-cap");
  });

  test("lines 2+ cap at 60 tokens each, reported with their line number", () => {
    const overLine3 = `${words(70)} (S1/T4).`;
    expect(countTokens(overLine3)).toBeGreaterThan(IMPRESSION_LINE_TOKEN_CAP);
    const text = `Global law (S1/T2).\nBinding (S1/T3).\n${overLine3}`;

    const result = validateImpression({ text, cap: 500, resolveAnchor: resolveAll });
    expect(result.accepted).toBe(false);
    expect(result.rejections).toContainEqual(
      expect.objectContaining({ rule: "line-cap", line: 3 }),
    );

    const ok = `Global law (S1/T2).\n${words(50)} (S1/T3).`;
    expect(
      validateImpression({ text: ok, cap: 500, resolveAnchor: resolveAll }).accepted,
    ).toBe(true);
  });

  test("total text over the cap rejects; the same text under a grown cap accepts", () => {
    const text = [
      `Global law of the lane (S1/T2).`,
      `${words(50)} (S1/T3).`,
      `${words(50)} (S1/T4).`,
    ].join("\n");
    const total = countTokens(text);
    expect(total).toBeGreaterThan(100);
    expect(total).toBeLessThanOrEqual(200);

    const rejected = validateImpression({ text, cap: 100, resolveAnchor: resolveAll });
    expect(rejected.accepted).toBe(false);
    expect(rules(rejected)).toContain("total-cap");

    expect(
      validateImpression({ text, cap: 200, resolveAnchor: resolveAll }).accepted,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Anchor format (qualified fold) and resolvability.
// ---------------------------------------------------------------------------

describe("validator: anchor format", () => {
  test("reject: a bare T<m> with no preceding full anchor on its line", () => {
    const result = validateImpression({
      text: "The parser moved to trigram scoring (T149).",
      cap: 500,
      resolveAnchor: resolveAll,
    });
    expect(result.accepted).toBe(false);
    expect(result.rejections).toContainEqual(
      expect.objectContaining({ rule: "anchor-format", line: 1 }),
    );
  });

  test("accept: full-then-folded on one line; the fold binds to the nearest preceding session", () => {
    const result = validateImpression({
      text: "Diamond tiles locked (S18993/T125, T149) and roads connected (S18993/T160, T168).",
      cap: 500,
      resolveAnchor: resolveAll,
    });
    expect(result.accepted).toBe(true);
    expect(result.anchors).toEqual([
      expect.objectContaining({ sessionId: 18993, promptNumber: 125 }),
      expect.objectContaining({ sessionId: 18993, promptNumber: 149, raw: "T149" }),
      expect.objectContaining({ sessionId: 18993, promptNumber: 160 }),
      expect.objectContaining({ sessionId: 18993, promptNumber: 168, raw: "T168" }),
    ]);
  });

  test("the fold does NOT cross lines: line 2's bare anchor rejects even after line 1's full one", () => {
    const result = validateImpression({
      text: "Law (S1/T2).\nBinding held (T3).",
      cap: 500,
      resolveAnchor: resolveAll,
    });
    expect(result.accepted).toBe(false);
    expect(result.rejections).toContainEqual(
      expect.objectContaining({ rule: "anchor-format", line: 2 }),
    );
  });

  test("repeating the full form for the same session is legal — folding is permitted, never required (the golden sample's own shape)", () => {
    const result = validateImpression({
      text: "Stats from the package (S18993/T133), elevation decoded (S18993/T198).",
      cap: 500,
      resolveAnchor: resolveAll,
    });
    expect(result.accepted).toBe(true);
  });
});

describe("validator: anchor resolvability", () => {
  test("reject: a well-formed anchor that resolves to no turn, naming its line and written form", () => {
    const result = validateImpression({
      text: "Law (S1/T2).\nDetail (S1/T3, T9).",
      cap: 500,
      resolveAnchor: anchorResolverFromResolvedSet(new Set(["S1/T2", "S1/T3"])),
    });
    expect(result.accepted).toBe(false);
    expect(result.rejections).toEqual([
      expect.objectContaining({
        rule: "anchor-unresolvable",
        line: 2,
        message: expect.stringContaining('S1/T9 (written "T9")'),
      }),
    ]);
  });

  test("accept: every anchor (full and folded) resolves through the set-backed resolver", () => {
    const result = validateImpression({
      text: "Law (S1/T2, T3).",
      cap: 500,
      resolveAnchor: anchorResolverFromResolvedSet(new Set(["S1/T2", "S1/T3"])),
    });
    expect(result.accepted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Delivery-class words.
// ---------------------------------------------------------------------------

describe("validator: delivery-class word requires a same-line anchor", () => {
  test("reject: shipped/landed/committed/released with no anchor on the line, case-insensitive", () => {
    for (const line of [
      "The look is shipped through ticket 004.",
      "The fix landed in the worker.",
      "The batch is committed.",
      "Released to production.",
      "SHIPPED at last.",
    ]) {
      const result = validateImpression({ text: line, cap: 500, resolveAnchor: resolveAll });
      expect(result.accepted).toBe(false);
      expect(rules(result)).toContain("delivery-anchor");
    }
  });

  test("a malformed bare anchor does not satisfy the delivery rule (the line has no usable address)", () => {
    const result = validateImpression({
      text: "The fix landed (T42).",
      cap: 500,
      resolveAnchor: resolveAll,
    });
    expect(result.accepted).toBe(false);
    expect(rules(result)).toContain("delivery-anchor");
    expect(rules(result)).toContain("anchor-format");
  });

  test("accept: a delivery word whose line carries a well-formed anchor; the anchor's SUFFICIENCY stays semantic and is not judged here", () => {
    const result = validateImpression({
      text: "The look is locked and shipped through ticket 004 (S18993/T125).",
      cap: 500,
      resolveAnchor: resolveAll,
    });
    expect(result.accepted).toBe(true);
  });

  test("accept: an inflection that is not one of the four class words (committing) does not trigger", () => {
    const result = validateImpression({
      text: "The committing window carries the payload.",
      cap: 500,
      resolveAnchor: resolveAll,
    });
    expect(result.accepted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sequence-word lint: warns, never rejects.
// ---------------------------------------------------------------------------

describe("validator: sequence-word soft lint", () => {
  test("warning only: then/later/subsequently/finally/eventually are named per line, and the text still accepts", () => {
    const result = validateImpression({
      text: "Law (S1/T2).\nIt then moved and finally settled (S1/T3).",
      cap: 500,
      resolveAnchor: resolveAll,
    });
    expect(result.accepted).toBe(true);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        rule: "sequence-word",
        line: 2,
        message: expect.stringContaining('"then"'),
      }),
    ]);
    expect(result.warnings[0]!.message).toContain('"finally"');
  });

  test("no sequence words, no warnings", () => {
    const result = validateImpression({
      text: "Law (S1/T2).",
      cap: 500,
      resolveAnchor: resolveAll,
    });
    expect(result.warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The explicit non-check, and the all-rejections posture.
// ---------------------------------------------------------------------------

describe("validator: boundaries", () => {
  test("line 1 semantic self-containment is NOT checked — a vacuous but well-formed line 1 accepts (the state ceiling is the teaching tier's duty)", () => {
    const result = validateImpression({
      text: "Some things happened (S1/T2).",
      cap: 500,
      resolveAnchor: resolveAll,
    });
    expect(result.accepted).toBe(true);
  });

  test("every violation reports in one pass, never one at a time", () => {
    const text = ["Bare fold (T9), and the fix landed.", words(70)].join("\n");
    const result = validateImpression({ text, cap: 500, resolveAnchor: resolveNone });
    const found = rules(result);
    expect(found).toContain("anchor-format");
    expect(found).toContain("delivery-anchor");
    expect(found).toContain("line-cap");
  });

  test("a non-positive or non-integer cap is a programmer error", () => {
    expect(() =>
      validateImpression({ text: "x", cap: 0, resolveAnchor: resolveAll }),
    ).toThrow(TypeError);
    expect(() =>
      validateImpression({ text: "x", cap: 99.5, resolveAnchor: resolveAll }),
    ).toThrow(TypeError);
  });

  test("the golden sample's dense lane validates under a 500 cap", () => {
    const golden = [
      "The SAN11 visual-fidelity lane: the look is locked and shipped through ticket 004 — 2:1 isometric with diagonal-brick diamond tiles (S18993/T125, T149), connected road tiles (S18993/T160, T168), officer stats and portraits from the 萌战 package (S18993/T133) — and the original's elevation data is decoded (S18993/T198) but its client integration and combat meaning remain open.",
      "Causal law: top-down misreading is geometry, not style — oblique feel needs diagonal gridlines; diagonal-brick diamonds give SAN11's stagger with unmodified 2:1 isometric assets (S18993/T124, T125).",
      "Render fidelity: nearest+mipmap integer zoom fixed the 32x16 blur (S18993/T196).",
    ].join("\n");
    const result = validateImpression({ text: golden, cap: 500, resolveAnchor: resolveAll });
    expect(result.accepted).toBe(true);
  });
});
