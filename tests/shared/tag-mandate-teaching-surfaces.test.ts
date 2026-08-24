import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { relationsReadRemedy } from "../../src/db/write-gate";
import { noteInputShape, settlementNoteInputShape } from "../../src/mcp/definitions";
import { EDGE_RELATIONS } from "../../src/shared/turn-phase";
import { SETTLEMENT_NOTE_TOOL_DESCRIPTION } from "../../src/worker/note-settlement-sdk-query";

/**
 * lane-declaration ticket 02 ([S15069/T1548]/[T1562]) — the same whole-set
 * guard, pointed at the rule that now holds.
 *
 * It was built for the tag mandate: a gate that refused a bare
 * `extends`/`narrows` while some surface still SHOWED one produced calls the
 * gate then rejected, and the rejection read as a bug rather than a rule. The
 * mandate is withdrawn, so the failure mode INVERTS — a surface still teaching
 * "extends/narrows accept only the tagged form" now makes a run avoid a call
 * the gate would happily accept, and (worse) teaches the main agent it owes
 * lane tags it does not. The file keeps its enumerated-surface design and
 * swaps what it looks for, so a reader learns the current rule where they used
 * to learn the old one.
 *
 * Two halves, mirrored from the original:
 *
 *   1. POSITIVE — every relation describe offers BOTH entry forms, says the
 *      tag is never required, and states the registry precondition; the
 *      retraction mirrors are untouched.
 *   2. NEGATIVE — the stale-teacher grep: no surface still states the mandate.
 *
 * `src/shared/memory-rubric.ts`, `src/worker/note-settlement-prompt.ts` and
 * `plugin/skills/**` are READ here and never written: their text is ticket
 * 08's deliverable, and this guard's job is to notice if that text and this
 * gate ever disagree, not to repair either.
 */

// ---------------------------------------------------------------------------
// The stale-teacher detector
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
    // The settlement TOOL descriptions (peer round T1466, finding P2-4). The
    // facade registers its own `note` description rather than reusing
    // `MNEMO_TOOL_DESCRIPTIONS.note`, so it is a fourth independently-editable
    // teacher. It carries the commit gate's own refusal copy too, which is the
    // surface a settlement run reads most often.
    "src/worker/note-settlement-sdk-query.ts",
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
 * The retired mandate's own sentences, in every spelling the surfaces used
 * while it stood. A phrase list rather than a shape regex because the mandate
 * was always stated in PROSE — there was never a bare-vs-tagged syntax to
 * detect on this side, only an assertion about which form is legal.
 *
 * `E1` is here too: the checker class the mandate's stock half produced. A
 * description still promising a commit refusal over an untagged extends sends
 * a run hunting for a repair the checker no longer asks for.
 */
const MANDATE_PHRASES = [
  "continuation names its lane",
  "accept ONLY the tagged",
  "a bare address is REFUSED",
  "bare address is refused",
  "MUST be the tagged",
  "an untagged extends/narrows (E1)",
  "untagged extends/narrows (E1)",
  "cross-phase words never carry lane tags",
];

function findStaleMandateClaims(text: string): string[] {
  const hits: string[] = [];
  for (const phrase of MANDATE_PHRASES) {
    let index = text.indexOf(phrase);
    while (index !== -1) {
      const line = text.slice(0, index).split("\n").length;
      hits.push(`line ${line}: ${phrase}`);
      index = text.indexOf(phrase, index + phrase.length);
    }
  }
  return hits;
}

describe("no teaching surface still states the retired tag mandate", () => {
  // The detector's own calibration. A guard whose phrase list silently stopped
  // matching would pass forever while every surface rotted, so the shapes it
  // must catch and the shapes it must not are pinned here rather than trusted.
  describe("the stale-teacher detector itself", () => {
    test("catches each spelling the mandate was stated in", () => {
      expect(
        findStaleMandateClaims("continuation names its lane, so name it"),
      ).toHaveLength(1);
      expect(
        findStaleMandateClaims("extends/narrows accept ONLY the tagged `{turn, tags}` entry"),
      ).toHaveLength(1);
      expect(findStaleMandateClaims("a bare address is REFUSED, because")).toHaveLength(1);
      expect(
        findStaleMandateClaims("Entries are bare addresses only — cross-phase words never carry lane tags."),
      ).toHaveLength(1);
      expect(
        findStaleMandateClaims("an untagged extends/narrows (E1), a relation word outside"),
      ).toHaveLength(2); // both the long and short spellings overlap on purpose
    });

    test("passes the CURRENT teaching, which names the same words legitimately", () => {
      expect(
        findStaleMandateClaims(
          "Each entry is a bare address (untagged — acts on the cited turn itself) or `{turn, tags}`",
        ),
      ).toEqual([]);
      expect(
        findStaleMandateClaims("a lane tag is NEVER required of you — settlement owns tagging"),
      ).toEqual([]);
      expect(findStaleMandateClaims("never written beside an extends on the same pair")).toEqual([]);
    });
  });

  // A path typo would make the grep below vacuous — it would scan nothing and
  // pass forever. The enumeration is asserted first, so the guard's own reach
  // is a checked fact rather than an assumption.
  test("the enumerated surface set is the spec's, and every path resolves", () => {
    const files = teachingSurfaceFiles();
    expect(files).toContain("src/mcp/definitions.ts");
    expect(files).toContain("src/worker/note-settlement-prompt.ts");
    expect(files).toContain("src/worker/note-settlement-sdk-query.ts");
    expect(files).toContain("src/shared/memory-rubric.ts");
    expect(files.filter((file) => file.startsWith(SKILL_DOCS_ROOT)).length).toBeGreaterThan(0);
    for (const file of files) {
      expect(existsSync(file), `${file} should exist`).toBe(true);
      expect(readFileSync(file, "utf8").length).toBeGreaterThan(0);
    }
  });

  test("no in-repo teaching surface still states the mandate or its E1 refusal", () => {
    const offenders: string[] = [];
    for (const file of teachingSurfaceFiles()) {
      for (const hit of findStaleMandateClaims(readFileSync(file, "utf8"))) {
        offenders.push(`${file} ${hit}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // The assertion describes (shared zod objects — both write surfaces inherit)
  // -------------------------------------------------------------------------

  describe("assertion describes offer both entry forms for ALL EIGHT words", () => {
    for (const field of EDGE_RELATIONS) {
      test(`${field}'s describe offers the untagged form and says the tag is never required`, () => {
        const description = noteInputShape[field].description ?? "";
        expect(description).toContain("untagged — acts on the cited turn itself");
        expect(description).toContain("NEVER required of");
        // The registry precondition replaces the mandate as the thing a caller
        // must know before sending a tagged entry.
        expect(description).toContain("DECLARED in the segment");
        expect(description).toContain("both turns' own tags");
        // And the mandate's own words are gone from this word's caption.
        expect(description).not.toContain("MUST be the tagged");
        expect(description).not.toContain("continuation names its lane");
      });

      test(`the settlement facade inherits ${field}'s describe object identically`, () => {
        expect(settlementNoteInputShape[field]).toBe(noteInputShape[field]);
      });
    }
  });

  // -------------------------------------------------------------------------
  // The settlement facade's OWN note description (peer round T1466, P2-4)
  // -------------------------------------------------------------------------

  describe("the settlement note description teaches the registry gate, not the mandate", () => {
    test("all eight words take either form, and no word requires a tag", () => {
      expect(SETTLEMENT_NOTE_TOOL_DESCRIPTION).toContain(
        "ALL EIGHT words accept either: a bare address acts on the cited turn itself",
      );
      expect(SETTLEMENT_NOTE_TOOL_DESCRIPTION).toContain("NO word requires a tag");
    });

    test("the three per-tag checks and the two structural refusals are stated in order", () => {
      const text = SETTLEMENT_NOTE_TOOL_DESCRIPTION;
      expect(text).toContain("the tag must be canonical");
      expect(text).toContain("DECLARED (remember declare) in the segment of BOTH endpoint turns");
      expect(text).toContain("a homeless endpoint is refused naming the turn");
      expect(text).toContain("cross-segment edge needs the declaration on both sides");
      expect(text).toContain("a SELF edge never carries a tag");
      expect(text).toContain("may not share a tag with one already stored");
      // Order is the contract, not just presence: a caller repairs in the
      // order the refusals arrive.
      expect(text.indexOf("the tag must be canonical")).toBeLessThan(
        text.indexOf("DECLARED (remember declare)"),
      );
      expect(text.indexOf("DECLARED (remember declare)")).toBeLessThan(
        text.indexOf("must already be on both this turn's and the target's own tags"),
      );
    });

    test("retraction keeps the bare form and names the retraction-only ninth word", () => {
      expect(SETTLEMENT_NOTE_TOOL_DESCRIPTION).toContain("RETRACTION is the other half");
      expect(SETTLEMENT_NOTE_TOOL_DESCRIPTION).toContain("keeps the BARE form for legacy stock");
      expect(SETTLEMENT_NOTE_TOOL_DESCRIPTION).toContain("`retractSupersedes`");
      expect(SETTLEMENT_NOTE_TOOL_DESCRIPTION).toContain("no assertion field");
    });

    // RB's hand-off: the relations gate refuses an edge write whose run never
    // read the citing turn's current set, and the remedy it names is one exact
    // recall. A description that mentioned the requirement without the call
    // would leave the model guessing which read satisfies it.
    test("the relations-read requirement names the exact recall filter that satisfies it", () => {
      expect(SETTLEMENT_NOTE_TOOL_DESCRIPTION).toContain(
        "Writing an edge also needs THIS run's own current read of the citing turn's relations",
      );
      // The SAME read the gate's own rejection prescribes. Pinned as the
      // shared fragment rather than the whole clause: the rejection addresses
      // one turn and this description addresses any of them, so the sentences
      // differ by design while the CALL must not.
      const sharedRead = 'filter={fields:["relations"]}';
      expect(relationsReadRemedy("S1/T2")).toContain(sharedRead);
      expect(SETTLEMENT_NOTE_TOOL_DESCRIPTION).toContain(`\`${sharedRead}\``);
    });
  });

  describe("retraction mirrors are unchanged by the withdrawal", () => {
    for (const field of ["retractExtends", "retractNarrows"] as const) {
      test(`${field} still documents the bare-address form`, () => {
        const description = noteInputShape[field].description ?? "";
        // The retraction line's own words: an untagged entry retracts the
        // bare row. A legacy untagged row must stay deletable, whatever the
        // assertion side does.
        expect(description).toContain("an untagged entry retracts the bare row");
        expect(description).not.toContain("MUST");
        expect(description).not.toContain("continuation names its lane");
      });
    }
  });
});
