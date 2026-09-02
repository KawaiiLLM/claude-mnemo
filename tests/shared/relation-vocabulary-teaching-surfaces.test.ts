import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { MNEMO_TOOL_DESCRIPTIONS, noteInputShape, settlementNoteInputShape } from "../../src/mcp/definitions";
import {
  MEMORY_RUBRIC_CONCEPTS_TEXT,
  MEMORY_RUBRIC_MAIN_ACTIONS_TEXT,
} from "../../src/shared/memory-rubric";
import { RELATION_CLASSES } from "../../src/shared/relation-class";
import { EDGE_RELATIONS } from "../../src/shared/turn-phase";
import { SETTLEMENT_NOTE_TOOL_DESCRIPTION } from "../../src/worker/note-settlement-sdk-query";

/**
 * The stale-teacher sweep for the RELATION VOCABULARY, built on
 * `tag-mandate-teaching-surfaces.test.ts`'s design (enumerated surfaces, a
 * calibrated phrase detector, a positive half).
 *
 * RELATION-VOCABULARY-V13 TICKET 02 re-aimed it a second time. It began as
 * lane-model v12 ticket 02's eight-words-and-phase sweep; v13 replaces the
 * SEVEN words with THREE CLASSES (`correct` carrying a full/partial coverage
 * bit, `verify`, `use`), so every seven-word enumeration joins the retired list
 * beside the eight-word ones. The failure mode is identical and is the whole
 * reason this is a test rather than a review item: a surface still teaching
 * `override` sends a run to write a parameter the schema now refuses, and the
 * refusal reads as a bug rather than a rule.
 *
 * Two rules retired together and both leave the same failure mode behind. A
 * surface still teaching EIGHT words sends a run to write `refutes`, which the
 * schema now rejects — the rejection reads as a bug rather than a rule. A
 * surface still teaching the PHASE rule is worse than wrong: it makes a run
 * withhold an edge the gate would happily accept, and nothing ever reports the
 * edge that was not written. This project has been bitten by a cached teaching
 * surface twice, which is why the sweep is a test rather than a review item.
 *
 * HOW EACH SURFACE IS READ. A surface is read AS THE MODEL RECEIVES IT: the
 * rendered string where one exists, the file where the file IS the artifact.
 * `src/shared/memory-rubric.ts` and `src/mcp/definitions.ts` are therefore
 * read through their exports, not their bytes — both carry a long version
 * history in doc comments that legitimately records what earlier versions
 * taught, and a guard that could not tell a changelog from a lesson would
 * force that history to be falsified. Markdown docs and the settlement prompt
 * source have no such changelog and are read whole.
 *
 * WHAT IS DELIBERATELY NOT BANNED: the bare token `refutes`. It is still a
 * legal, necessary word on the RETRACTION surface (`retractRefutes`, the
 * mirror that keeps a stored legacy row deletable — `db/citations.ts`'s
 * `RETRACTION_ONLY_RELATIONS`), so banning the token would ban the one
 * sentence that has to name it. The phrases below name the ASSERTION
 * teachings instead.
 */

const SKILL_DOCS_ROOT = "plugin/skills";

/** A teaching surface: a name for the failure message, and the text a reader actually gets. */
interface TeachingSurface {
  name: string;
  text: string;
}

function renderedSurfaces(): TeachingSurface[] {
  const surfaces: TeachingSurface[] = [
    // Lane-model-v12 ticket 12: the rubric is two injected constants now
    // (concepts + main-agent actions), so BOTH are swept — a stale teaching
    // that moved from one half to the other must not fall out of the net.
    { name: "MEMORY_RUBRIC_CONCEPTS_TEXT", text: MEMORY_RUBRIC_CONCEPTS_TEXT },
    { name: "MEMORY_RUBRIC_MAIN_ACTIONS_TEXT", text: MEMORY_RUBRIC_MAIN_ACTIONS_TEXT },
    { name: "SETTLEMENT_NOTE_TOOL_DESCRIPTION", text: SETTLEMENT_NOTE_TOOL_DESCRIPTION },
  ];
  for (const [tool, description] of Object.entries(MNEMO_TOOL_DESCRIPTIONS)) {
    surfaces.push({ name: `MNEMO_TOOL_DESCRIPTIONS.${tool}`, text: description });
  }
  for (const [field, schema] of Object.entries(noteInputShape)) {
    surfaces.push({ name: `noteInputShape.${field}`, text: schema.description ?? "" });
  }
  for (const [field, schema] of Object.entries(settlementNoteInputShape)) {
    surfaces.push({
      name: `settlementNoteInputShape.${field}`,
      text: schema.description ?? "",
    });
  }
  return surfaces;
}

function fileSurfacePaths(): string[] {
  const files = [
    // The settlement prompt's own authored text (Block A/B/C).
    "src/worker/note-settlement-prompt.ts",
    // The settlement tool descriptions the facade registers, including the
    // commit gate's refusal copy — the surface a settlement run reads most.
    "src/worker/note-settlement-sdk-query.ts",
    // The repo's living domain model, which agents read before the source.
    "CONTEXT.md",
  ];
  for (const entry of readdirSync(SKILL_DOCS_ROOT, { withFileTypes: true })) {
    const doc = join(SKILL_DOCS_ROOT, entry.name, "SKILL.md");
    if (entry.isDirectory() && existsSync(doc)) {
      files.push(doc);
    }
  }
  return files;
}

function allSurfaces(): TeachingSurface[] {
  return [
    ...renderedSurfaces(),
    ...fileSurfacePaths().map((file) => ({ name: file, text: readFileSync(file, "utf8") })),
  ];
}

/**
 * The retired teachings, in every spelling the surfaces used while they stood.
 * A phrase list rather than a regex for the same reason the tag-mandate guard
 * uses one: both rules were stated in PROSE, so there is no syntactic shape to
 * detect — only assertions about which words exist and which pairings are
 * legal.
 */
const RETIRED_TEACHING_PHRASES = [
  // The eighth word, as every surface listed it.
  "verifies/refutes",
  "verifies / refutes",
  "grounds/verifies/refutes",
  "override/refutes",
  "`override`/`refutes`",
  // The size of the vocabulary.
  "eight-word",
  "eight words",
  "ALL EIGHT",
  "all eight words",
  "outside the eight",
  "八词",
  // relation-vocabulary-v13 ticket 02: the SEVEN-word vocabulary, in every
  // spelling the surfaces used while it stood. Phrases, never bare tokens —
  // two of these surfaces are read as whole FILES and their comments have to
  // stay free to explain the migration by name.
  "override/narrows/extends/indexes/consume/grounds/verifies",
  "override/narrows/extends/consume/indexes/grounds/",
  "七个关系词",
  "七个词都不改变",
  "ALL SEVEN words",
  "the seven relation fields",
  "the seven relations and their seven retract",
  "the seven words could not express",
  "any of the seven relations",
  "any of the seven relation words",
  // The phase rule, in each surface's own words.
  "同相位",
  "异相位",
  "相位配对",
  "须含取证相位",
  "evidence-phase source",
  "an evidence-phase requirement",
  "phase and lane-tag legality",
  "cross-phase only",
  "phase-illegal",
  "phase domains",
  "Same phase is the whole check",
];

function findStaleTeaching(text: string): string[] {
  const hits: string[] = [];
  for (const phrase of RETIRED_TEACHING_PHRASES) {
    let index = text.indexOf(phrase);
    while (index !== -1) {
      const line = text.slice(0, index).split("\n").length;
      hits.push(`line ${line}: ${phrase}`);
      index = text.indexOf(phrase, index + phrase.length);
    }
  }
  return hits;
}

describe("no teaching surface still names a retired relation vocabulary or the phase rule", () => {
  // The detector's own calibration. A phrase list that silently stopped
  // matching would pass forever while every surface rotted, so the shapes it
  // must catch and the shapes it must NOT are pinned rather than trusted.
  describe("the stale-teacher detector itself", () => {
    test("catches each spelling the two retired rules were stated in", () => {
      // Three hits now, not two: v13 added the SEVEN-word enumeration to the
      // retired list, and the eight-word spelling contains it.
      expect(findStaleTeaching("override/narrows/extends/indexes/consume/grounds/verifies/refutes: address lists")).toHaveLength(3);
      expect(findStaleTeaching("- **verifies / refutes** → 异相位：以本轮产出的检验结果")).toHaveLength(2);
      expect(findStaleTeaching("a relation word outside the eight-word vocabulary (E2)")).toHaveLength(2);
      expect(findStaleTeaching("ALL EIGHT words accept either a bare address")).toHaveLength(1);
      expect(findStaleTeaching("**八词**（非自引边均可带 tag）:")).toHaveLength(1);
      expect(findStaleTeaching("Requires an evidence-phase source.")).toHaveLength(1);
      expect(findStaleTeaching("**相位配对**：一个节点可有多个 type")).toHaveLength(1);
      expect(findStaleTeaching("- **override** → 同相位：其主要结果不再适用")).toHaveLength(1);
      expect(findStaleTeaching("cross-phase only (a decision on a finding)")).toHaveLength(1);
      // v13's own additions, each in the spelling a surface actually carried.
      expect(
        findStaleTeaching("edges: `note`'s override/narrows/extends/indexes/consume/grounds/verifies fields"),
      ).toHaveLength(1);
      expect(findStaleTeaching("**七个关系词**(读到时这样理解):")).toHaveLength(1);
      expect(findStaleTeaching("two entry forms and ALL SEVEN words accept either")).toHaveLength(1);
      expect(
        findStaleTeaching("RELATIONS ARE NOT YOURS: the seven relation fields and their retract"),
      ).toHaveLength(1);
    });

    test("passes the CURRENT teaching, which names the same words legitimately", () => {
      // The retraction mirror HAS to name the merged word.
      expect(
        findStaleTeaching(
          "Addresses whose frozen-legacy refutes edge FROM this turn is deleted; retraction only",
        ),
      ).toEqual([]);
      // A lane spanning design and delivery is still a real, teachable fact —
      // what retired is the phase as a WORD-LEVEL gate, not the phases.
      expect(
        findStaleTeaching(
          "A lane is not phase-local: a decision→delivery arc may be ONE lane, continued across that boundary by any TAGGED edge.",
        ),
      ).toEqual([]);
      expect(findStaleTeaching("**七词**（非自引边均可带 tag）")).toEqual([]);
      // v13's CURRENT teaching passes: the three classes, the coverage bit and
      // the precedence name none of the retired phrases.
      expect(findStaleTeaching("**三个关系类**(读到时这样理解)")).toEqual([]);
      expect(
        findStaleTeaching("edges: `note`'s correct/verify/use fields — the three-class vocabulary."),
      ).toEqual([]);
      expect(
        findStaleTeaching("two entry forms and ALL THREE classes accept either"),
      ).toEqual([]);
    });
  });

  // A path typo would make the sweep vacuous — it would scan nothing and pass
  // forever. The enumeration is asserted first, so the guard's own reach is a
  // checked fact rather than an assumption.
  test("the enumerated surface set resolves, and every surface has text", () => {
    const files = fileSurfacePaths();
    expect(files).toContain("src/worker/note-settlement-prompt.ts");
    expect(files).toContain("src/worker/note-settlement-sdk-query.ts");
    expect(files).toContain("CONTEXT.md");
    expect(files.filter((file) => file.startsWith(SKILL_DOCS_ROOT)).length).toBeGreaterThan(0);
    for (const file of files) {
      expect(existsSync(file), `${file} should exist`).toBe(true);
    }
    const rendered = renderedSurfaces();
    for (const half of ["MEMORY_RUBRIC_CONCEPTS_TEXT", "MEMORY_RUBRIC_MAIN_ACTIONS_TEXT"]) {
      expect(rendered.find((surface) => surface.name === half)?.text.length).toBeGreaterThan(0);
    }
    // Every relation field's describe is in the set, by construction — on
    // BOTH shapes now (main-agent-edge-capability ticket 01, ruling
    // [S15069/T1651]: `noteInputShape` is the owning declaration again,
    // `settlementNoteInputShape` borrows the same objects).
    for (const relationClass of RELATION_CLASSES) {
      expect(rendered.map((surface) => surface.name)).toContain(
        `settlementNoteInputShape.${relationClass}`,
      );
      expect(rendered.map((surface) => surface.name)).toContain(
        `noteInputShape.${relationClass}`,
      );
    }
  });

  test("no surface still teaches the retired vocabulary or a phase requirement", () => {
    const offenders: string[] = [];
    for (const surface of allSurfaces()) {
      for (const hit of findStaleTeaching(surface.text)) {
        offenders.push(`${surface.name} ${hit}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // The positive half: the surfaces state the rule that replaced them.
  // -------------------------------------------------------------------------

  test("the vocabulary is THREE CLASSES on every surface that enumerates it", () => {
    expect(RELATION_CLASSES).toHaveLength(3);
    expect([...RELATION_CLASSES]).toEqual(["correct", "verify", "use"]);
    // The seven STORAGE words are untouched — they are what a stored row's
    // `relation` column says, and ticket 03 migrates them additively.
    expect(EDGE_RELATIONS).toHaveLength(7);
    // The main agent's own description enumerates the three only to say they
    // are NOT its ordinary business — a run that reads it must not go looking.
    expect(MNEMO_TOOL_DESCRIPTIONS.note).toContain(
      "correct/verify/use and their retract… mirrors",
    );
    expect(MNEMO_TOOL_DESCRIPTIONS.note).toContain("are settlement's whole business");
    expect(SETTLEMENT_NOTE_TOOL_DESCRIPTION).toContain("correct/verify/use:");
    expect(SETTLEMENT_NOTE_TOOL_DESCRIPTION).toContain("ALL THREE classes accept either");
    expect(MEMORY_RUBRIC_CONCEPTS_TEXT).toContain("**三个关系类**");
  });

  test("the rubric states the precedence, the principal-result rule, and FULL versus PARTIAL", () => {
    // THE PRECEDENCE, not a partition — the spec's own restatement after peer
    // review. Without it a writer reads the three classes as mutually
    // exclusive and has no answer for "corrected it AND built on it".
    expect(MEMORY_RUBRIC_CONCEPTS_TEXT).toContain("判定是一个**优先级**,不是一个划分");
    expect(MEMORY_RUBRIC_CONCEPTS_TEXT).toContain("**correct 与 verify 是 use 的子集**");
    expect(MEMORY_RUBRIC_CONCEPTS_TEXT).toContain("槽位存最具体的那一类");
    // PRINCIPAL RESULT at both ends, and the SET form of it (a turn may hold
    // several parallel principals; the dominant action wins on collision).
    expect(MEMORY_RUBRIC_CONCEPTS_TEXT).toContain("边的两端都是节点的**主结果**");
    expect(MEMORY_RUBRIC_CONCEPTS_TEXT).toContain("细节不挣边");
    expect(MEMORY_RUBRIC_CONCEPTS_TEXT).toContain("**占主导的那个动作胜出**");
    // FULL vs PARTIAL, defined by whether anything survives AS A PREMISE —
    // never by whether some true sentence about the turn survives.
    expect(MEMORY_RUBRIC_CONCEPTS_TEXT).toContain("**前提**,它只作为历史留存");
    expect(MEMORY_RUBRIC_CONCEPTS_TEXT).toContain("确定的、非空的实质部分作为前提站得住");
    // VERIFY is narrow, USE is DIRECT input only.
    expect(MEMORY_RUBRIC_CONCEPTS_TEXT).toContain("散文里写着「确认」但指向的是细节,不构成 verify");
    expect(MEMORY_RUBRIC_CONCEPTS_TEXT).toContain("祖先不算");
    // The sufficiency law is a WRITING law and its lint is a WARNING only
    // (user ruling S15069/T2300, CONDITIONAL).
    expect(MEMORY_RUBRIC_CONCEPTS_TEXT).toContain("**充分引用**");
    expect(MEMORY_RUBRIC_CONCEPTS_TEXT).toContain("这是**写作法则**,不是机器判决");
    expect(MEMORY_RUBRIC_CONCEPTS_TEXT).toContain("只作为警告出现,从不阻止写入");
    // ARM B KEEPS THE SPARSITY RULE (ticket 04 is DEFERRED, user ruling
    // S15069/T2391). A future edit that deletes it here is ticket 04's work,
    // not this one's.
    expect(MEMORY_RUBRIC_CONCEPTS_TEXT).toContain("已经能经由既有边读到的路径,不重复画");
    // Ruling 2 (S15069/T2332): ONE row per pair, at the honest placement.
    expect(MEMORY_RUBRIC_CONCEPTS_TEXT).toContain("同一对节点之间只有一条边");
  });

  test("correct carries the merged meaning and its bit, and verify routes a contrary result to it", () => {
    // The merge is only real if the surviving class SAYS it covers the merged
    // cases — otherwise a run that disproved a claim has no class it trusts and
    // reaches for `use`, the failure T1466 already measured once.
    expect(settlementNoteInputShape.correct.description).toContain(
      "negates, limits or re-scopes",
    );
    expect(settlementNoteInputShape.correct.description).toContain("REQUIRES the coverage bit");
    expect(settlementNoteInputShape.verify.description).toContain("is `correct`");
    // The rubric's own wording of the same merge.
    expect(MEMORY_RUBRIC_CONCEPTS_TEXT).toContain(
      "- **correct** —— 被引节点的主结果被本节点否决、撤回、替换,或被修正、限缩。",
    );
    expect(MEMORY_RUBRIC_CONCEPTS_TEXT).toContain(
      "**三个类都不改变节点的有效性 —— 被 correct 的节点依然有效。**",
    );
  });

  test("no relation describe states a type or phase requirement on either end", () => {
    for (const relation of RELATION_CLASSES) {
      const description = settlementNoteInputShape[relation].description ?? "";
      expect(description, relation).not.toContain("same phase");
      expect(description, relation).not.toContain("cross-phase");
      expect(description, relation).not.toContain("evidence-phase");
      // There is no second copy to drift FROM: main-agent-edge-capability
      // ticket 01 restored the main agent's field, but as the SAME object
      // settlement's shape reads — one description, not two.
      expect(relation in noteInputShape, relation).toBe(true);
      expect((noteInputShape as Record<string, unknown>)[relation], relation).toBe(
        settlementNoteInputShape[relation],
      );
    }
  });
});
