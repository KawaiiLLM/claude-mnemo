import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { relationsReadRemedy } from "../../src/db/write-gate";
import {
  MNEMO_TOOL_DESCRIPTIONS,
  noteInputShape,
  recallInputShape,
  rememberInputShape,
  settlementNoteInputShape,
  timelineInputShape,
} from "../../src/mcp/definitions";
import {
  SETTLEMENT_LANE_ACTIONS,
  settlementMembershipWriteInputShape,
} from "../../src/worker/note-settlement-membership-facade";
import { RELATION_CLASSES } from "../../src/shared/relation-class";
import {
  renderMainAgentRubricBlock,
  renderMemoryRubricConceptsBlock,
} from "../../src/shared/memory-rubric";
import { NOTE_SETTLEMENT_SYSTEM_PROMPT } from "../../src/worker/note-settlement-prompt";
import {
  SETTLEMENT_COMMIT_TOOL_DESCRIPTION,
  SETTLEMENT_LANE_CHECK_TOOL_DESCRIPTION,
  SETTLEMENT_NOTE_TOOL_DESCRIPTION,
  UNIFIED_REMEMBER_TOOL_DESCRIPTION,
} from "../../src/worker/note-settlement-sdk-query";

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

  // A retired verb outgrew the mandate sweep: `declare` left `RememberVerb`
  // with container-unification ticket 05, yet surfaces kept teaching the call.
  // The mandate list above is prose and could never catch it.
  //
  // The first attempt scanned SOURCE for call shapes (`remember(declare`,
  // `verb: "declare"`) and had to spare the bare word, because a comment
  // recording the retirement is legitimate — peer review [S15069/T1771] then
  // found the live false negative that hole guaranteed: `lane_check` told
  // settlement the repair was "a `declare` plus settling both sides", and no
  // call-shape list would ever have matched an imperative. Widening the
  // patterns cannot close it; the surface being scanned is wrong.
  //
  // So scan the RENDERED artifacts instead. A model sees no comments, so in
  // rendered text the bare backticked verb IS the bug and needs no shape
  // guessing — which also covers every spelling the source scan missed
  // (`action: "declare"`, single quotes, `remember (declare)`). The one
  // legitimate rendered mention is a retirement NOTICE, so a hit is spared
  // only when its own sentence says so.
  const RETIRED_VERBS = ["declare", "undeclare", "append", "replace", "assign"];

  /**
   * The STATIC model-visible strings — every prompt, tool description, skill
   * body and parameter describe that can be produced without a database.
   *
   * Not "everything a model receives", which the first version of this comment
   * claimed (peer review [S15069/T1772]). Knowingly outside: the lane-checker
   * report, which needs scope rows to render; recall/timeline result bodies;
   * runtime refusal and error text; the settlement Stop-hook's messages. Those
   * can instruct a call too — widening to them needs fixtures, and until it
   * happens this guard's reach is what this function returns and no more.
   */
  function renderedTeachingArtifacts(): Record<string, string> {
    const artifacts: Record<string, string> = {
      "rubric (main agent)": renderMainAgentRubricBlock(),
      "rubric (concepts)": renderMemoryRubricConceptsBlock(),
      "settlement prompt": NOTE_SETTLEMENT_SYSTEM_PROMPT,
      "settlement note tool": SETTLEMENT_NOTE_TOOL_DESCRIPTION,
      // TICKET 06: the EDGE pass has no `remember` tool at all now, so the
      // artifact under scan is the UNIFIED dispatch's — the one surviving
      // description of this facade a model actually reads.
      "unified remember tool": UNIFIED_REMEMBER_TOOL_DESCRIPTION,
      "settlement lane_check tool": SETTLEMENT_LANE_CHECK_TOOL_DESCRIPTION,
      "settlement commit tool": SETTLEMENT_COMMIT_TOOL_DESCRIPTION,
    };
    for (const [name, text] of Object.entries(MNEMO_TOOL_DESCRIPTIONS)) {
      artifacts[`${name} tool description`] = text;
    }
    // A SKILL.md is rendered whole when its skill runs — no comment layer, so
    // it belongs on this side of the line rather than the source sweep's.
    for (const file of teachingSurfaceFiles()) {
      if (file.startsWith(SKILL_DOCS_ROOT)) {
        artifacts[file] = readFileSync(file, "utf8");
      }
    }
    const shapes: Record<string, Record<string, { description?: string }>> = {
      remember: rememberInputShape,
      note: noteInputShape,
      recall: recallInputShape,
      timeline: timelineInputShape,
      "settlement note": settlementNoteInputShape,
      // Settlement `remember`'s own parameters — the shape carrying the
      // `action` enum, and the one omission the peer round found in this net.
      "settlement remember": settlementMembershipWriteInputShape,
    };
    for (const [shapeName, shape] of Object.entries(shapes)) {
      for (const [field, schema] of Object.entries(shape)) {
        const description = schema?.description;
        if (typeof description === "string") {
          artifacts[`${shapeName}.${field} describe`] = description;
        }
      }
    }
    return artifacts;
  }

  /**
   * A retirement NOTICE names the dead verb on purpose. The first exemption
   * spared any hit sharing a period-delimited sentence with /retire/i, which
   * the peer round showed is an executable hole — "Although `declare` retired,
   * call `declare` for repairs" is one sentence and both hits vanish — and
   * which never saw a Chinese 。 or ; as a boundary at all.
   *
   * A notice puts the retirement immediately BEFORE the word ("Retired with
   * the `assign` verb", "ticket 05 retired `declare`"). So: exempt only when
   * /retire/ appears in the 40 characters before the match with no sentence
   * boundary in between. The stale imperative then has nothing in front of it
   * and is reported, which is all the guard needs to fail.
   */
  function isRetirementNotice(text: string, index: number): boolean {
    const before = text.slice(Math.max(0, index - 40), index);
    const lastBoundary = Math.max(
      before.lastIndexOf("."),
      before.lastIndexOf("。"),
      before.lastIndexOf(";"),
      before.lastIndexOf("；"),
    );
    return /retire/i.test(before.slice(lastBoundary + 1));
  }

  /**
   * MAIN-AGENT-EDGES TICKET 06: `declare` is a LIVE `note` parameter again
   * (ticket 03, spec D4 — `declareEdgeSides`, the edge pass's own act), so a
   * bare backticked `declare` no longer identifies the retired `remember`
   * verb. For that one word only the VERB forms are the needle
   * (`remember(declare)`, `action: "declare"`); every other retired verb keeps
   * the bare-backtick match.
   */
  const VERB_FORM_ONLY = new Set(["declare"]);

  function findRetiredVerbTeaching(text: string): string[] {
    const hits: string[] = [];
    for (const verb of RETIRED_VERBS) {
      const pattern = new RegExp(
        (VERB_FORM_ONLY.has(verb) ? "" : `\`${verb}\`|`) +
          `\\b(?:remember|verb|action)\\s*[(:]\\s*["'\`]?${verb}\\b`,
        "g",
      );
      for (const match of text.matchAll(pattern)) {
        if (isRetirementNotice(text, match.index)) continue;
        hits.push(`${match[0]} — "${text.slice(match.index, match.index + 70).trim()}"`);
      }
    }
    return hits;
  }

  test("the retired-verb detector reads instruction and notice apart", () => {
    expect(findRetiredVerbTeaching("the repair is an `undeclare` plus settling both sides")).toHaveLength(1);
    expect(findRetiredVerbTeaching("remember(declare) is for a lane you judged")).toHaveLength(1);
    expect(findRetiredVerbTeaching('send { action: "declare", id: "E1" }')).toHaveLength(1);
    expect(findRetiredVerbTeaching("remember (declare) still works")).toHaveLength(1);
    // The peer's counter-example: one sentence, a notice AND an imperative.
    // The imperative is what must be reported; sparing the notice half is fine.
    expect(
      findRetiredVerbTeaching("Although `undeclare` retired, call `undeclare` for repairs."),
    ).toHaveLength(1);
    // A notice ending its sentence no longer exempts the next instruction.
    expect(findRetiredVerbTeaching("The verb was retired. Call `undeclare` for repairs")).toHaveLength(1);
    expect(findRetiredVerbTeaching("该动词已 retired。调用 `undeclare` 修复")).toHaveLength(1);
    // Spared: the notice itself, and every ordinary use of the same words.
    expect(findRetiredVerbTeaching("Retired with the `assign` verb — a turn's task is derived from its own tags")).toEqual([]);
    expect(findRetiredVerbTeaching("ticket 05 retired `declare` into the lane tier")).toEqual([]);
    // main-agent-edges ticket 06: `note`'s `declare` ENTRY is live teaching,
    // not the retired `remember` verb — only the verb form is a hit.
    expect(findRetiredVerbTeaching("declare it with a `declare` entry on the citing turn")).toEqual([]);
    expect(findRetiredVerbTeaching("lane tags DECLARED in that task")).toEqual([]);
    expect(findRetiredVerbTeaching("lanes otherwise being settlement's to declare")).toEqual([]);
    expect(findRetiredVerbTeaching("`write` replaces one field's value whole")).toEqual([]);
  });

  test("no rendered artifact still instructs a retired remember verb", () => {
    const offenders: string[] = [];
    for (const [name, text] of Object.entries(renderedTeachingArtifacts())) {
      for (const hit of findRetiredVerbTeaching(text)) {
        offenders.push(`${name}: ${hit}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // The THIRD verb source of truth (peer review [S15069/T1772]): settlement's
  // lane vocabulary is deliberately NOT the main agent's ten, so equating the
  // two would be wrong — but its enum, its tool description and the prompt's
  // call list were three independent literals, which is exactly how
  // `remember(declare)` outlived the verb once already.
  // The prompt is the THIRD teacher of this inventory and cannot be rendered
  // without a seeded database, so its half of this pin lives beside the
  // fixture that already renders it, in tests/worker/note-settlement-prompt.
  test("settlement's action inventory is one tuple, and its tool description names every word", () => {
    expect([...settlementMembershipWriteInputShape.action.options]).toEqual([
      ...SETTLEMENT_LANE_ACTIONS,
    ]);
    // SETTLEMENT-GATE-TAXONOMY TICKET 06: the tuple is three words, not four —
    // `justify` retired with the commit gate it discharged (user ruling
    // S15069/T2278) — and the description that has to name them is the UNIFIED
    // dispatch's, because the edge-only dispatch no longer registers this tool
    // at all. A word the enum accepts and no description mentions is exactly
    // how `remember(declare)` outlived its own verb once already.
    expect(UNIFIED_REMEMBER_TOOL_DESCRIPTION).toContain('"create"');
    expect(UNIFIED_REMEMBER_TOOL_DESCRIPTION).toContain('"delete"');
    expect(UNIFIED_REMEMBER_TOOL_DESCRIPTION).toContain("`merge` is");
    for (const action of SETTLEMENT_LANE_ACTIONS) {
      expect(UNIFIED_REMEMBER_TOOL_DESCRIPTION).toContain(action);
    }
    // And no fourth word is advertised that the enum will refuse.
    for (const retired of ["justify", "declare", "undeclare", "propose", "reassign"]) {
      expect([...settlementMembershipWriteInputShape.action.options]).not.toContain(retired);
      expect(UNIFIED_REMEMBER_TOOL_DESCRIPTION).not.toContain(retired);
    }
  });

  /**
   * PHASE-CONNECTIVITY TICKET 08, decision 7 pinned that this description
   * taught the read obligation that actually ships — an era-scoped membership
   * read plus an unconditional full-content grant on the other representative.
   * SETTLEMENT-GATE-TAXONOMY TICKET 06 retired the obligation with the write
   * it guarded, so the pin inverts: NO read obligation is taught here, because
   * there is no longer a call that imposes one. What the description owes
   * instead is the withdrawal itself, said where a caller meets it on retry.
   */
  test("the surviving remember description teaches no disposition obligation at all", () => {
    expect(UNIFIED_REMEMBER_TOOL_DESCRIPTION).not.toContain("era-visible member");
    expect(UNIFIED_REMEMBER_TOOL_DESCRIPTION).not.toContain("full-content");
    expect(UNIFIED_REMEMBER_TOOL_DESCRIPTION).not.toContain("in full (every");
    // The withdrawal, stated rather than left silent.
    expect(UNIFIED_REMEMBER_TOOL_DESCRIPTION).toContain(
      "A severed lane owes you nothing there",
    );
    expect(UNIFIED_REMEMBER_TOOL_DESCRIPTION).toContain("there is no disposition to file");
  });

  // -------------------------------------------------------------------------
  // The assertion describes (shared zod objects — both write surfaces inherit)
  // -------------------------------------------------------------------------

  // main-agent-edge-capability ticket 01 (ruling [S15069/T1651]) had the two
  // surfaces sharing ONE field object per class, so reading either surface's
  // describe read the same text. MAIN-AGENT-EDGES D3 / R10-5 SPLIT THEM: the
  // main agent writes a node fact and no lane sides, settlement additionally
  // DECLARES an ambiguous side, so the ENTRY SHAPES differ and the two surfaces
  // declare their own fields.
  //
  // What is still one thing, and what these tests moved to pinning, is the
  // VOCABULARY: both surfaces derive their parameter names from
  // `db/citations.ts`'s `RELATION_FIELD_ENTRIES`, and each class means the same
  // thing on both. The two-sided admission test below is asserted on the
  // SETTLEMENT surface only, because it is the only surface that can place a
  // side at all — asserting it on `note` would be pinning teaching the main
  // agent must not act on.
  describe("assertion describes offer both entry forms for ALL THREE classes", () => {
    for (const field of RELATION_CLASSES) {
      test(`${field}'s describe offers the draft form and states the two-sided admission test`, () => {
        const description = settlementNoteInputShape[field].description ?? "";
        expect(description).toContain("both sides unsettled");
        expect(description).toContain("Place BOTH or NEITHER");
        // The registry precondition, per side, replaces the mandate as the
        // thing a caller must know before placing an edge in a lane.
        expect(description).toContain("DECLARED in that endpoint's task");
        expect(description).toContain("that endpoint turn's own tags");
        // And the mandate's own words are gone from this word's caption.
        expect(description).not.toContain("MUST be the tagged");
        expect(description).not.toContain("continuation names its lane");
      });

      test(`the main agent's \`note\` has the ${field} field, with its own PUBLIC entry shape`, () => {
        expect(field in noteInputShape).toBe(true);
        const retractField = `retract${field.charAt(0).toUpperCase()}${field.slice(1)}`;
        expect(retractField in noteInputShape).toBe(true);

        // NOT the same object any more (D3 / R10-5), and the difference is
        // asserted rather than merely allowed: the public arm REFUSES a
        // two-sided entry, the settlement arm accepts it. Pinning both
        // directions is what catches an accidental re-merge of the two shapes
        // — which would either hand the main agent lane parameters it must not
        // use, or take settlement's declaration form away.
        const publicField = (noteInputShape as Record<string, unknown>)[field] as {
          safeParse: (value: unknown) => { success: boolean };
        };
        const settlementField = settlementNoteInputShape[field] as unknown as {
          safeParse: (value: unknown) => { success: boolean };
        };
        const twoSided = [{ turn: "S1/T2", tailTag: "#a", headTag: "#a" }];
        expect(publicField.safeParse(twoSided).success).toBe(false);
        expect(settlementField.safeParse(twoSided).success).toBe(true);

        // The public arm still takes what the main agent actually writes.
        const bare = field === "correct" ? [{ turn: "S1/T2", coverage: "full" }] : ["S1/T2"];
        expect(publicField.safeParse(bare).success).toBe(true);
      });
    }
  });

  // -------------------------------------------------------------------------
  // The settlement facade's OWN note description (peer round T1466, P2-4)
  // -------------------------------------------------------------------------

  describe("the settlement note description teaches the registry gate, not the mandate", () => {
    // MAIN-AGENT-EDGES TICKET 06 (spec D3/D6): ONE entry form, and the
    // division of labour as it stands — the main agent writes its own turn's
    // edges routinely (ticket 05), so "taught not to reach for them" was
    // FALSE at HEAD from ticket 05 on, and the two-sided draft form described
    // a model the resolver (D2) retired. Both pinned absent.
    test("all three classes take the bare form, and the main agent is named as the routine writer", () => {
      expect(SETTLEMENT_NOTE_TOOL_DESCRIPTION).toContain(
        "ASSERTION is a bare address and ALL THREE classes accept it",
      );
      expect(SETTLEMENT_NOTE_TOOL_DESCRIPTION).toContain(
        "writes them ROUTINELY on its own turn, so most edges here are already written",
      );
      expect(SETTLEMENT_NOTE_TOOL_DESCRIPTION).toContain(
        "a stored side is written only through `declare`",
      );
      expect(SETTLEMENT_NOTE_TOOL_DESCRIPTION).not.toContain("is taught not to reach for them");
      expect(SETTLEMENT_NOTE_TOOL_DESCRIPTION).not.toContain("leaves both sides UNSETTLED");
      expect(SETTLEMENT_NOTE_TOOL_DESCRIPTION).not.toContain("has no relation field at all");
    });

    test("E6 is taught as the several-lanes case only, and the per-side checks of a declaration are stated in order", () => {
      const text = SETTLEMENT_NOTE_TOOL_DESCRIPTION;
      // The resolution model (main-agent-edges D2): a blank side derives from a
      // unique lane and is legal; E6 is exactly the ambiguous endpoint. A
      // description still calling every blank side a DRAFT that commit refuses
      // would send a run declaring sides the gate refuses as derivable.
      expect(text).not.toContain("PLACE BOTH OR NEITHER");
      expect(text).not.toContain("A DRAFT — either side left empty, or both — is ACCEPTED here");
      expect(text).not.toContain("every edge inside your writable set with an empty side is error E6");
      expect(text).toContain("A BLANK SIDE IS LEGAL wherever the endpoint sits in ONE lane or in none");
      // MAIN-AGENT-EDGES TICKET 14b (E6 warning closure, ruling
      // S15069/T2465-T2466): E6 is a warning, never a refusal — the sentence
      // that used to say "commit refuses ... declare it, or retract the row"
      // is retired.
      expect(text).toContain("warning E6 where the");
      expect(text).toContain("endpoint sits in SEVERAL lanes and no side is declared");
      expect(text).toContain(
        "you may `declare` it where the material you are already holding says which lane",
      );
      expect(text).toContain("it never refuses commit");
      expect(text).not.toContain("error E6 only where the");
      expect(text).not.toContain("while one remains in your writable set: `declare` it, or retract the row");
      expect(text).toContain("`{turn, class?, tailTag?, headTag?}`");
      expect(text).toContain("the tag must be canonical");
      expect(text).toContain(
        "DECLARED (remember create) in the task THAT endpoint belongs to",
      );
      expect(text).toContain("an endpoint carrying no task tag is refused naming the turn");
      expect(text).toContain("an endpoint");
      expect(text).toContain("in exactly one lane is refused as derivable");
      expect(text).toContain("A side omitted is left alone");
      expect(text).toContain("`null` clears it");
      // The crossing is legal and the description has to say so, or a run will
      // avoid a call the gate accepts.
      expect(text).toContain("two different words is a legal CROSSING");
      expect(text).toContain("the same word in two different tasks is a crossing too");
      expect(text).toContain("a SELF edge is refused outright whatever its lanes");
      // Order is the contract, not just presence: a caller repairs in the
      // order the refusals arrive.
      expect(text.indexOf("the tag must be canonical")).toBeLessThan(
        text.indexOf("DECLARED (remember create)"),
      );
      expect(text.indexOf("DECLARED (remember create)")).toBeLessThan(
        text.indexOf("the tag must already be on that endpoint turn's own tags"),
      );
      expect(text.indexOf("the tag must already be on that endpoint turn's own tags")).toBeLessThan(
        text.indexOf("in exactly one lane is refused as derivable"),
      );
    });

    test("retraction addresses the pair with the mirror's class as precondition, and no longer names a retraction-only word", () => {
      expect(SETTLEMENT_NOTE_TOOL_DESCRIPTION).toContain("RETRACTION is the other half");
      // main-agent-edges ticket 03 (T2432 P1): side tags left the retraction
      // address. "A bare entry deletes the UNSETTLED row and a two-sided one
      // deletes exactly that lane placement" described the old identity.
      expect(SETTLEMENT_NOTE_TOOL_DESCRIPTION).toContain("A retraction addresses the PAIR");
      expect(SETTLEMENT_NOTE_TOOL_DESCRIPTION).toContain(
        "the mirror's own class is the precondition",
      );
      expect(SETTLEMENT_NOTE_TOOL_DESCRIPTION).not.toContain("A bare entry deletes the UNSETTLED row");
      expect(SETTLEMENT_NOTE_TOOL_DESCRIPTION).not.toContain("deletes exactly that lane placement");
      // Lane-model v12 ticket 03 deleted both frozen-legacy mirrors with the
      // rows they addressed. This surface is the one that actually MET such a
      // row, so it is the one a stale parameter name would mislead most.
      expect(SETTLEMENT_NOTE_TOOL_DESCRIPTION).not.toContain("retractSupersedes");
      expect(SETTLEMENT_NOTE_TOOL_DESCRIPTION).not.toContain("retractRefutes");
    });

    // RB's hand-off: the relations gate refuses an edge write whose run never
    // read the citing turn's current set, and the remedy it names is one exact
    // recall. A description that mentioned the requirement without the call
    // would leave the model guessing which read satisfies it.
    test("the relations-read requirement names the exact recall filter that satisfies it", () => {
      expect(SETTLEMENT_NOTE_TOOL_DESCRIPTION).toContain(
        "Writing an edge also needs THIS run's own current read of the citing turn's relations",
      );
      // main-agent-edges ticket 06 (read-once D6): the ONE read already
      // delivered it; the filter below is the REPAIR for a refused write, on
      // that turn alone — never a read taught in front of every edge write.
      expect(SETTLEMENT_NOTE_TOOL_DESCRIPTION).toContain(
        "Your one read's field list already delivered it",
      );
      expect(SETTLEMENT_NOTE_TOOL_DESCRIPTION).toContain("on that turn alone, never the batch again");
      expect(SETTLEMENT_NOTE_TOOL_DESCRIPTION).not.toContain("Step 0");
      expect(SETTLEMENT_NOTE_TOOL_DESCRIPTION).not.toContain("so recall the turn with");
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
    for (const field of ["retractUse", "retractCorrect"] as const) {
      test(`${field} still documents the bare-address form, and states the PAIR rule`, () => {
        const description = settlementNoteInputShape[field].description ?? "";
        // MAIN-AGENT-EDGES TICKET 14 (peer finding P1-10). The retired sentence
        // was "a bare entry retracts the unsettled row, a two-sided one
        // retracts exactly that lane placement" — true only under the
        // pre-cutover model where one pair could hold several physical rows.
        // Retraction is pair-addressed and a pair holds one row, so a two-sided
        // entry narrows nothing.
        expect(description).not.toContain("a bare entry retracts the unsettled row");
        expect(description).not.toContain("retracts exactly that lane placement");
        expect(description).toContain("the ADDRESS IS THE PAIR");
        expect(description).toContain("Side tags are ignored here");
        expect(description).toContain("bare-address-or-`{turn, tailTag, headTag}` form");
        expect(description).not.toContain("MUST");
        expect(description).not.toContain("continuation names its lane");
      });
    }
  });
});
