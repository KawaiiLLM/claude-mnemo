import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { noteInputShape, settlementNoteInputShape } from "../../src/mcp/definitions";

/**
 * tag-mandate spec, "The mandate reaches every teaching surface" (ruled
 * T1452, assertion/retraction split from the T1455 peer round).
 *
 * A write gate that refuses a bare `extends`/`narrows` while some teaching
 * surface still SHOWS one is worse than no gate: the surface is what the
 * model imitates, so a stale example produces a call the gate then rejects,
 * and the rejection reads as a bug rather than a rule. This file is the
 * whole-set guard the spec asks for — the enumerated surfaces (rubric text,
 * assertion describes, settlement prompt, skill docs) are checked TOGETHER,
 * because the failure mode is one surface lagging the rest, not any single
 * one being wrong in isolation.
 *
 * Two halves:
 *
 *   1. POSITIVE — the assertion describes say tagged-form-only, and the
 *      retraction mirrors are NOT captioned by that rewrite (a legacy
 *      untagged row must stay deletable by its bare address).
 *   2. NEGATIVE — the stale-example grep: no surface still shows a bare
 *      extends/narrows ASSERTION example.
 *
 * `src/shared/memory-rubric.ts` is READ here and never written: the rubric
 * text is its own ticket's deliverable, and this guard's job is to notice if
 * that text and this gate ever disagree, not to repair either.
 */

// ---------------------------------------------------------------------------
// The stale-example detector
// ---------------------------------------------------------------------------

/**
 * The teaching surfaces, in the spec's own enumeration. Paths are repo-root
 * relative (bun test's cwd), the same convention
 * `tests/shared/release-artifacts.test.ts` already uses for in-repo files.
 */
const SKILL_DOCS_ROOT = "plugin/skills";

function teachingSurfaceFiles(): string[] {
  const files = [
    // Tool descriptions and every relation/retraction `.describe()`.
    "src/mcp/definitions.ts",
    // The settlement prompt (checklist + call-shape teaching).
    "src/worker/note-settlement-prompt.ts",
    // The rubric text — read-only here (see this file's header).
    "src/shared/memory-rubric.ts",
  ];
  for (const entry of readdirSync(SKILL_DOCS_ROOT, { withFileTypes: true })) {
    const doc = join(SKILL_DOCS_ROOT, entry.name, "SKILL.md");
    if (entry.isDirectory() && existsSync(doc)) {
      files.push(doc);
    }
  }
  return files;
}

/**
 * A WRITE position for one of the two mandated words: the field name followed
 * by `:` or `=`. This is what an EXAMPLE looks like; a word merely NAMED in
 * prose ("never written beside an extends"), or rendered as a read-side
 * annotation (timeline's `T811(extends)`), never takes this shape.
 */
const WRITE_POSITION = /\b(extends|narrows)\b\s*[:=]\s*/g;

/**
 * A turn address literal in any spelling a doc uses — `S15069/T1412`,
 * `[T1412]`, `S<session>/T<prompt>`. Requiring one is what separates an
 * EXAMPLE from a schema declaration (`extends: z.array(...)`) or a shape
 * re-export (`narrows: noteInputShape.narrows`), neither of which is teaching
 * a caller what to send.
 */
const ADDRESS_LITERAL = /\[?(?:S(?:\d+|<[A-Za-z]+>)\/)?T(?:\d+|<[A-Za-z]+>)/;

/**
 * How far past the field name an example's own address may sit. Wide enough
 * for `extends: [{ turn: "S1/T2", tags: [...] }]`, narrow enough that an
 * unrelated address two sentences later is not attributed to this word.
 */
const EXAMPLE_WINDOW = 80;

/**
 * Every bare (untagged) extends/narrows ASSERTION example in one file's text.
 *
 * The tagged form is recognised by a `{` reaching the address first — that is
 * the `{turn, tags}` entry object, the only legal assertion shape left. An
 * address reached with no brace before it is a bare address example, which is
 * exactly the stale teacher this guard exists to catch.
 */
function findBareAssertionExamples(text: string): string[] {
  const hits: string[] = [];
  WRITE_POSITION.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WRITE_POSITION.exec(text)) !== null) {
    const window = text.slice(WRITE_POSITION.lastIndex, WRITE_POSITION.lastIndex + EXAMPLE_WINDOW);
    const address = ADDRESS_LITERAL.exec(window);
    if (!address) {
      continue;
    }
    const brace = window.indexOf("{");
    if (brace !== -1 && brace < address.index) {
      continue;
    }
    const line = text.slice(0, match.index).split("\n").length;
    hits.push(`line ${line}: ${match[0]}${window.split("\n")[0]}`);
  }
  return hits;
}

describe("the tag mandate reaches every teaching surface", () => {
  // The detector's own calibration. A guard whose regex silently stopped
  // matching would pass forever while every surface rotted, so the shapes it
  // must catch and the shapes it must not are pinned here rather than trusted.
  describe("the stale-example detector itself", () => {
    test("catches a bare assertion example in each spelling a doc might use", () => {
      expect(findBareAssertionExamples('extends: ["S15069/T1412"]')).toHaveLength(1);
      expect(findBareAssertionExamples("narrows: [S15069/T1412]")).toHaveLength(1);
      expect(findBareAssertionExamples("extends=[T42]")).toHaveLength(1);
      expect(findBareAssertionExamples("narrows: `S<session>/T<prompt>`")).toHaveLength(1);
    });

    test("passes the tagged form, and anything that is not an example at all", () => {
      expect(findBareAssertionExamples('extends: [{ turn: "S15069/T1412", tags: ["lane"] }]')).toEqual(
        [],
      );
      // A schema declaration and a shape re-export name no address.
      expect(findBareAssertionExamples("extends: z.array(relationTargetEntryShape)")).toEqual([]);
      expect(findBareAssertionExamples("narrows: noteInputShape.narrows,")).toEqual([]);
      // Prose naming the word, and the read-side render of an existing edge.
      expect(findBareAssertionExamples("never written beside an extends on the same pair")).toEqual(
        [],
      );
      expect(findBareAssertionExamples("↳ T811(extends), T812(consume)")).toEqual([]);
    });

    test("a retraction mirror's bare example is not an assertion example", () => {
      // The mirrors KEEP the bare form, so their examples must never trip the
      // guard — the word boundary in WRITE_POSITION is what carries this.
      expect(findBareAssertionExamples('retractExtends: ["S15069/T1412"]')).toEqual([]);
      expect(findBareAssertionExamples('retractNarrows: ["S15069/T1412"]')).toEqual([]);
    });
  });

  // A path typo would make the grep below vacuous — it would scan nothing and
  // pass forever. The enumeration is asserted first, so the guard's own reach
  // is a checked fact rather than an assumption.
  test("the enumerated surface set is the spec's, and every path resolves", () => {
    const files = teachingSurfaceFiles();
    expect(files).toContain("src/mcp/definitions.ts");
    expect(files).toContain("src/worker/note-settlement-prompt.ts");
    expect(files).toContain("src/shared/memory-rubric.ts");
    expect(files.filter((file) => file.startsWith(SKILL_DOCS_ROOT)).length).toBeGreaterThan(0);
    for (const file of files) {
      expect(existsSync(file), `${file} should exist`).toBe(true);
      expect(readFileSync(file, "utf8").length).toBeGreaterThan(0);
    }
  });

  test("no in-repo teaching surface still shows a bare extends/narrows assertion example", () => {
    const offenders: string[] = [];
    for (const file of teachingSurfaceFiles()) {
      for (const hit of findBareAssertionExamples(readFileSync(file, "utf8"))) {
        offenders.push(`${file} ${hit}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // The assertion describes (shared zod objects — both write surfaces inherit)
  // -------------------------------------------------------------------------

  describe("assertion describes say tagged-form-only", () => {
    for (const field of ["extends", "narrows"] as const) {
      test(`${field}'s describe states the mandate and the subset requirement`, () => {
        const description = noteInputShape[field].description ?? "";
        expect(description).toContain("MUST");
        expect(description).toContain("{turn, tags}");
        expect(description).toContain("bare address is refused");
        expect(description).toContain("continuation names its lane");
        // The subset invariant survives the rewrite — it is the other half of
        // what a caller needs to produce a legal tagged edge.
        expect(description).toContain("both this turn's and the target's own tags");
        // And the OPTIONAL reading is gone: no surface may still offer the
        // bare address as an equal choice for these two words.
        expect(description).not.toContain("untagged — acts on the cited turn itself");
      });

      test(`the settlement facade inherits ${field}'s describe object identically`, () => {
        expect(settlementNoteInputShape[field]).toBe(noteInputShape[field]);
      });
    }

    // The mandate is exactly two words wide on this surface too: the other
    // three taggable words keep offering the bare address as a real option.
    for (const field of ["override", "indexes", "consume"] as const) {
      test(`${field}'s describe still offers the untagged form`, () => {
        const description = noteInputShape[field].description ?? "";
        expect(description).toContain("untagged — acts on the cited turn itself");
      });
    }
  });

  describe("retraction mirrors are not captioned by the mandate", () => {
    for (const field of ["retractExtends", "retractNarrows"] as const) {
      test(`${field} still documents the bare-address form`, () => {
        const description = noteInputShape[field].description ?? "";
        // The retraction line's own words: an untagged entry retracts the
        // bare row. A legacy untagged row must stay deletable, so this text
        // is the one place the bare form is still taught for these words.
        expect(description).toContain("an untagged entry retracts the bare row");
        expect(description).not.toContain("MUST");
        expect(description).not.toContain("continuation names its lane");
      });
    }
  });
});
