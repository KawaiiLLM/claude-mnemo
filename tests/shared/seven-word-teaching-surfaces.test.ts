import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { MNEMO_TOOL_DESCRIPTIONS, noteInputShape, settlementNoteInputShape } from "../../src/mcp/definitions";
import {
  MEMORY_RUBRIC_CONCEPTS_TEXT,
  MEMORY_RUBRIC_MAIN_ACTIONS_TEXT,
} from "../../src/shared/memory-rubric";
import { EDGE_RELATIONS } from "../../src/shared/turn-phase";
import { SETTLEMENT_NOTE_TOOL_DESCRIPTION } from "../../src/worker/note-settlement-sdk-query";

/**
 * Lane-model v12 ticket 02 — the stale-teacher sweep for the SEVEN-word
 * vocabulary, built on `tag-mandate-teaching-surfaces.test.ts`'s design
 * (enumerated surfaces, a calibrated phrase detector, a positive half).
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

describe("no teaching surface still names eight words or the phase rule", () => {
  // The detector's own calibration. A phrase list that silently stopped
  // matching would pass forever while every surface rotted, so the shapes it
  // must catch and the shapes it must NOT are pinned rather than trusted.
  describe("the stale-teacher detector itself", () => {
    test("catches each spelling the two retired rules were stated in", () => {
      expect(findStaleTeaching("override/narrows/extends/indexes/consume/grounds/verifies/refutes: address lists")).toHaveLength(2);
      expect(findStaleTeaching("- **verifies / refutes** → 异相位：以本轮产出的检验结果")).toHaveLength(2);
      expect(findStaleTeaching("a relation word outside the eight-word vocabulary (E2)")).toHaveLength(2);
      expect(findStaleTeaching("ALL EIGHT words accept either a bare address")).toHaveLength(1);
      expect(findStaleTeaching("**八词**（非自引边均可带 tag）:")).toHaveLength(1);
      expect(findStaleTeaching("Requires an evidence-phase source.")).toHaveLength(1);
      expect(findStaleTeaching("**相位配对**：一个节点可有多个 type")).toHaveLength(1);
      expect(findStaleTeaching("- **override** → 同相位：其主要结果不再适用")).toHaveLength(1);
      expect(findStaleTeaching("cross-phase only (a decision on a finding)")).toHaveLength(1);
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
      expect(
        findStaleTeaching("No type requirement on either end — a check that came out AGAINST the cited claim is an override"),
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
    // Every relation field's describe is in the set, by construction — on the
    // SETTLEMENT shape, which is where lane-model-v12 ticket 08 left them
    // (ruling [S15069/T1651]: the main agent's `note` has no relation field).
    for (const relation of EDGE_RELATIONS) {
      expect(rendered.map((surface) => surface.name)).toContain(
        `settlementNoteInputShape.${relation}`,
      );
      expect(rendered.map((surface) => surface.name)).not.toContain(
        `noteInputShape.${relation}`,
      );
    }
  });

  test("no surface still teaches eight words or a phase requirement", () => {
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

  test("the vocabulary is seven words on every surface that enumerates it", () => {
    expect(EDGE_RELATIONS).toHaveLength(7);
    // The main agent's own description enumerates the seven only to say they
    // are NOT its parameters — a run that reads it must not go looking.
    expect(MNEMO_TOOL_DESCRIPTIONS.note).toContain(
      "override/narrows/extends/indexes/consume/grounds/verifies and their retract… mirrors",
    );
    expect(MNEMO_TOOL_DESCRIPTIONS.note).toContain("are settlement's whole business");
    expect(SETTLEMENT_NOTE_TOOL_DESCRIPTION).toContain(
      "override/narrows/extends/indexes/consume/grounds/verifies:",
    );
    expect(SETTLEMENT_NOTE_TOOL_DESCRIPTION).toContain("ALL SEVEN words accept either");
    // v12 states the vocabulary in base-verb form and calls it 七个关系词;
    // the inflected parameter names stay the write surface's own spelling.
    // tests/shared/memory-rubric.test.ts holds the map between the two.
    expect(MEMORY_RUBRIC_CONCEPTS_TEXT).toContain("**七个关系词**");
  });

  test("override carries the merged meaning, and verifies routes a contrary result to it", () => {
    // The merge is only real if the surviving word SAYS it covers the merged
    // cases — otherwise a run that disproved a claim has no word it trusts and
    // reaches for `extends`, the failure T1466 already measured once.
    expect(settlementNoteInputShape.override.description).toContain(
      "OVERTURNS, WITHDRAWS or REPLACES",
    );
    expect(settlementNoteInputShape.override.description).toContain("disproof included");
    expect(settlementNoteInputShape.verifies.description).toContain(
      "is an override, not this word",
    );
    // v12's own wording of the same merge: `override` names 否决/撤回/替换 in
    // one bullet and `verify` is the support-only word beside it. The "write
    // override when the check goes against it" routing sentence moved to the
    // settlement prompt's step 3, which is where the word is now chosen.
    expect(MEMORY_RUBRIC_CONCEPTS_TEXT).toContain(
      "- **override** —— 被引节点的主要结果被本节点否决、撤回、替换。",
    );
    expect(MEMORY_RUBRIC_CONCEPTS_TEXT).toContain(
      "- **verify** —— 被引节点的主要结果被本节点验证、支持。",
    );
  });

  test("no relation describe states a type or phase requirement on either end", () => {
    for (const relation of EDGE_RELATIONS) {
      const description = settlementNoteInputShape[relation].description ?? "";
      expect(description, relation).not.toContain("same phase");
      expect(description, relation).not.toContain("cross-phase");
      expect(description, relation).not.toContain("evidence-phase");
      // There is no second copy to drift FROM: the main agent's shape has no
      // relation field at all (ticket 08).
      expect(relation in noteInputShape, relation).toBe(false);
    }
  });
});
