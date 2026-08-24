import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { MNEMO_TOOL_DESCRIPTIONS, recallInputShape } from "../../src/mcp/definitions";

/**
 * One-address-grammar spec (ticket 10): `E<n>/T<m>` — a segment-scoped
 * 1-based EVENT-ORDER ordinal — retired outright, replaced by the segment's
 * members carrying their ordinary `S<session>/T<prompt>` address, scoped by
 * `E<n>/` in front (`E<n>/S<a>/T<b>`, or `E<n>/S<a>/T<b>..S<c>/T<d>` for a
 * range). Project memory names this project as having been bitten TWICE by a
 * cached skill doc teaching a retired read surface — this file is the guard
 * against a third: the teaching surfaces named by the ticket (the `recall`
 * and `timeline` tool descriptions, and the two plugin skill docs) must not
 * show the retired form as a LIVE example, and must show the replacement.
 *
 * A bare mention of the retired form IN PROSE explaining that it retired
 * (`"the retired E47/T3 form..."`) is not the failure this guards against —
 * only an unqualified example is, the shape a reader would imitate. The
 * detector below tells the two apart by a "retired" qualifier in the nearby
 * preceding text, the same window-based technique
 * `tag-mandate-teaching-surfaces.test.ts` already uses for its own
 * bare-vs-tagged distinction.
 */

const TEACHING_SURFACES: Record<string, string> = {
  "src/mcp/definitions.ts (recall description)": MNEMO_TOOL_DESCRIPTIONS.recall,
  "src/mcp/definitions.ts (timeline description)": MNEMO_TOOL_DESCRIPTIONS.timeline,
  "src/mcp/definitions.ts (recallInputShape.id describe)": recallInputShape.id.description ?? "",
  "plugin/skills/mnemo-recall/SKILL.md": readFileSync("plugin/skills/mnemo-recall/SKILL.md", "utf8"),
  "plugin/skills/mnemo-timeline/SKILL.md": readFileSync(
    "plugin/skills/mnemo-timeline/SKILL.md",
    "utf8",
  ),
};

// ---------------------------------------------------------------------------
// The stale-example detector
// ---------------------------------------------------------------------------

/**
 * `E<segment digits>/T<ordinal digits>` — the retired form's own shape,
 * concrete digits on both sides (a placeholder spelling like `E<n>/T<m>`
 * never matches, so explanatory prose using placeholders is automatically
 * exempt without needing the "retired" qualifier check at all). This also
 * catches the retired RANGE form (`E47/T3..7`) — the range's own opening
 * `E47/T3` is itself the single form's exact shape, so one pattern covers
 * both. It does NOT match the new grammar: `E47/S12/T3` has `S12` (not a
 * digit) directly after `E47/`, so the `T\d+` half never lines up against
 * the segment digits the way it does in the retired form.
 */
const RETIRED_ORDINAL_EXAMPLE = /E\d+\/T\d+/g;

/** How far back to look for a "retired" qualifier before a match — wide enough for "The retired `E47/T3` form", narrow enough that an unrelated retirement mentioned a paragraph earlier is not credited to this match. */
const RETIRED_QUALIFIER_WINDOW = 60;

function findLiveRetiredOrdinalExamples(text: string): string[] {
  const hits: string[] = [];
  RETIRED_ORDINAL_EXAMPLE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = RETIRED_ORDINAL_EXAMPLE.exec(text)) !== null) {
    const before = text.slice(Math.max(0, match.index - RETIRED_QUALIFIER_WINDOW), match.index);
    if (/retired/i.test(before)) {
      continue;
    }
    const line = text.slice(0, match.index).split("\n").length;
    hits.push(`line ${line}: ${match[0]}`);
  }
  return hits;
}

describe("the one-address grammar reaches every teaching surface (ticket 10)", () => {
  describe("the stale-example detector itself", () => {
    test("catches an unqualified retired-ordinal example, single and range", () => {
      expect(findLiveRetiredOrdinalExamples("Drill in with `E47/T3`.")).toHaveLength(1);
      expect(findLiveRetiredOrdinalExamples("A range: E47/T3..7 selects three members.")).toHaveLength(
        1,
      );
    });

    test("passes a mention that names the form as retired, the new grammar, and a placeholder spelling", () => {
      expect(findLiveRetiredOrdinalExamples("The retired `E47/T3` form refuses.")).toEqual([]);
      expect(
        findLiveRetiredOrdinalExamples("this project has retired the old E47/T3 ordinal outright"),
      ).toEqual([]);
      // New grammar: S<session> sits between E<segment> and T<prompt>, so the
      // digits never line up the way the retired form's do.
      expect(findLiveRetiredOrdinalExamples("`E47/S12/T3` addresses one member.")).toEqual([]);
      // A placeholder spelling (`<n>`/`<m>`) carries no digits at all.
      expect(findLiveRetiredOrdinalExamples("the retired `E<n>/T<m>` form")).toEqual([]);
    });
  });

  test("the enumerated surface set resolves and is non-empty", () => {
    for (const [name, text] of Object.entries(TEACHING_SURFACES)) {
      expect(text.length, `${name} should be non-empty`).toBeGreaterThan(0);
    }
  });

  test("no teaching surface still shows the retired E<n>/T<ordinal> form as a live example", () => {
    const offenders: string[] = [];
    for (const [name, text] of Object.entries(TEACHING_SURFACES)) {
      for (const hit of findLiveRetiredOrdinalExamples(text)) {
        offenders.push(`${name} ${hit}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("every teaching surface states the one address, S<session>/T<prompt> (placeholder or concrete)", () => {
    const ONE_ADDRESS_SHAPE = /S(?:\d+|<[A-Za-z]+>)\/T(?:\d+|<[A-Za-z]+>)/;
    for (const [name, text] of Object.entries(TEACHING_SURFACES)) {
      expect(ONE_ADDRESS_SHAPE.test(text), `${name} should state the S<session>/T<prompt> address`).toBe(
        true,
      );
    }
  });

  test("the recall-side surfaces additionally teach the E<n>/S<a>/T<b> segment-scoped selector", () => {
    // Timeline's own `E<n>` route treats a trailing selector as inert (ticket
    // 09's "no separate meaning on this route", unchanged by ticket 10) — it
    // is not this shape's teacher, so it is excluded here rather than folded
    // into the blanket check above.
    const SEGMENT_SCOPED_SELECTOR_SHAPE = /E\S*\/S\S*\/T/;
    for (const name of [
      "src/mcp/definitions.ts (recall description)",
      "src/mcp/definitions.ts (recallInputShape.id describe)",
      "plugin/skills/mnemo-recall/SKILL.md",
    ]) {
      expect(
        SEGMENT_SCOPED_SELECTOR_SHAPE.test(TEACHING_SURFACES[name]!),
        `${name} should teach E<n>/S<a>/T<b>`,
      ).toBe(true);
    }
  });

  test("the recall tool description explicitly retires the old ordinal form and names a refusal", () => {
    expect(MNEMO_TOOL_DESCRIPTIONS.recall).toContain("retired ordinal form");
    expect(MNEMO_TOOL_DESCRIPTIONS.recall).toContain("refuses");
  });
});
