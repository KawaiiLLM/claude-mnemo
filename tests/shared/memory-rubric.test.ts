import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";

import { renderRubricBlock } from "../../src/hooks/session-composition";
import { MNEMO_TOOL_DESCRIPTIONS, noteInputShape } from "../../src/mcp/definitions";
import {
  MEMORY_RUBRIC_HASH,
  MEMORY_RUBRIC_TEXT,
  MEMORY_RUBRIC_VERSION,
  renderMemoryRubricBlock,
} from "../../src/shared/memory-rubric";

/**
 * Ticket 11 (edge-ownership-impl, "统一 Memory Rubric") — the rubric's own
 * guard tests. Full byte-identity between the SessionStart injection and the
 * settlement prompt is pinned in tests/worker/note-settlement-prompt.test.ts
 * (which already carries the settlement fixture); this file covers what
 * needs no database fixture at all: the hash itself, the shared block's
 * budget/incomplete-marker discipline, and the single-home grep guard over
 * every describe() this ticket migrated judgment prose OUT of.
 */

describe("MEMORY_RUBRIC_HASH — self-consistency", () => {
  test("is a deterministic hash of MEMORY_RUBRIC_TEXT, independently recomputed", () => {
    const recomputed = createHash("sha256")
      .update(MEMORY_RUBRIC_TEXT, "utf8")
      .digest("hex")
      .slice(0, 12);
    expect(MEMORY_RUBRIC_HASH).toBe(recomputed);
  });

  test("renderMemoryRubricBlock wraps the verbatim text with a version/hash header line", () => {
    const block = renderMemoryRubricBlock();
    expect(block).toContain(`version="${MEMORY_RUBRIC_VERSION}"`);
    expect(block).toContain(`hash="${MEMORY_RUBRIC_HASH}"`);
    expect(block).toContain(MEMORY_RUBRIC_TEXT);
    // The wrapper does not mutate the source text — it appears whole, once.
    expect(block.indexOf(MEMORY_RUBRIC_TEXT)).toBe(block.lastIndexOf(MEMORY_RUBRIC_TEXT));
  });

  test("the rubric's own sections are present verbatim (ticket's own normative text)", () => {
    expect(MEMORY_RUBRIC_TEXT).toContain("# Memory Rubric v3");
    expect(MEMORY_RUBRIC_TEXT).toContain("## type");
    expect(MEMORY_RUBRIC_TEXT).toContain("## tags");
    expect(MEMORY_RUBRIC_TEXT).toContain("## 关系(turn→turn;从引用方记向被引方)");
    expect(MEMORY_RUBRIC_TEXT).toContain("## 归属");
    // The six discriminator sub-questions the note tool's own description
    // used to inline (ticket 11 migration).
    expect(MEMORY_RUBRIC_TEXT).toContain("evidence-for / evidence-against");
    expect(MEMORY_RUBRIC_TEXT).toContain("grounded-on");
    expect(MEMORY_RUBRIC_TEXT).toContain("override");
    expect(MEMORY_RUBRIC_TEXT).toContain("只点名可推出最终结论的最小集");
    expect(MEMORY_RUBRIC_TEXT).toContain("depends-on");
  });

  // Ticket 13 (spec "节奏与建段指导"): v2→v3's own addition — the "建段"
  // section, verbatim from the ticket's three ruled lines.
  test("v3 carries the 建段 section, verbatim, ticket 13's own three lines", () => {
    expect(MEMORY_RUBRIC_VERSION).toBe("v3");
    expect(MEMORY_RUBRIC_TEXT).toContain("## 建段");
    expect(MEMORY_RUBRIC_TEXT).toContain(
      "琐碎、短时闲聊等组不成可命名工作流的 turn 无须建段;无归属是合法状态",
    );
    expect(MEMORY_RUBRIC_TEXT).toContain(
      "需要建段时,先查 roster 有无合适的已有段——挂靠优先于新建",
    );
    expect(MEMORY_RUBRIC_TEXT).toContain(
      "无合适段才新建;以任务实际形状命名,开场臆测的名字会锚定错误",
    );
  });
});

describe("renderRubricBlock — its own block, no shared budget (ticket 14 roster rebuild)", () => {
  // Ticket 14: the rubric no longer cohabits an injection block with the
  // segment roster — ticket 11's shared-budget/INCOMPLETE-marker discipline
  // retires along with that cohabitation (`hooks/session-composition.ts`'s
  // `renderRubricBlock` and `renderSegmentRosterBlock` are now two
  // independent renders; see `tests/hooks/session-composition.test.ts` for
  // the roster's own coverage).
  test("renders the rubric whole, with no roster text and no budget/INCOMPLETE mechanism at all", () => {
    const block = renderRubricBlock();
    expect(block).toContain(MEMORY_RUBRIC_TEXT);
    expect(block).not.toContain("## Segment roster");
    expect(block).not.toContain("INCOMPLETE");
  });

  // [S15069/T1028]: the Memory Policy rides the SAME slot as the rubric — one
  // hook payload, two static tags — but must never leak into the rubric's
  // OTHER consumer: the settlement prompt belongs to an agent with no recall
  // tool, and retrieval policy there would teach a tool that does not exist.
  test("the memory policy rides the rubric slot but never the shared rubric constant", () => {
    const block = renderRubricBlock();
    expect(block).toContain('<mnemo-memory-policy version="v1">');
    expect(block).toContain("注入块只是索引,不是记忆本身");
    expect(block).toContain("先 recall/replay 原回合再落笔");
    // The shared constant both consumers render stays policy-free.
    expect(MEMORY_RUBRIC_TEXT).not.toContain("Memory Policy");
    expect(MEMORY_RUBRIC_TEXT).not.toContain("recall/replay");
  });
});

describe("single-home grep guard — judgment prose lives ONLY in the Memory Rubric (ticket 11)", () => {
  // The exact discriminator phrases that used to sit on the note tool's own
  // description and on `override`/`encodes`' `.describe()`s, before this
  // ticket moved the judgment itself into the rubric. If any of these
  // reappear on the describes, judgment has drifted back into two homes —
  // the same shape the ticket's own "0.11.1 incident" precedent warns about.
  const JUDGMENT_SIGNATURE_PHRASES = [
    "Six ordered questions",
    "if the predecessor's any sub-conclusion still holds",
    "name only the minimal set that can derive the final conclusion",
    "Did it test the claim, for or against?",
    "Overturns the cited decision whole?",
  ];

  test("none of the retired judgment phrases survive on MNEMO_TOOL_DESCRIPTIONS.note", () => {
    const note = MNEMO_TOOL_DESCRIPTIONS.note;
    for (const phrase of JUDGMENT_SIGNATURE_PHRASES) {
      expect(note, `note description must not restate: ${phrase}`).not.toContain(phrase);
    }
  });

  test("none of the retired judgment phrases survive on any noteInputShape describe()", () => {
    for (const [key, field] of Object.entries(noteInputShape)) {
      const description = (field as { description?: string }).description;
      if (!description) continue;
      for (const phrase of JUDGMENT_SIGNATURE_PHRASES) {
        expect(
          description,
          `${key}'s describe() must not restate: ${phrase}`,
        ).not.toContain(phrase);
      }
    }
  });

  test("override/encodes/note each point at the Memory Rubric instead of restating judgment", () => {
    expect(MNEMO_TOOL_DESCRIPTIONS.note.toLowerCase()).toContain("memory rubric");
    expect(noteInputShape.override.description?.toLowerCase()).toContain("memory rubric");
    expect(noteInputShape.encodes.description?.toLowerCase()).toContain("memory rubric");
  });

  // Ticket 13 (spec "节奏与建段指导"): `remember`'s own timing line points at
  // the rubric's new 建段 section rather than restating its three ruled
  // lines — the same discipline ticket 11 already pinned for note/override/
  // encodes above, extended to the one describe() ticket 13 touches.
  test("remember points at the Memory Rubric for 建段 judgment instead of restating its three lines", () => {
    const remember = MNEMO_TOOL_DESCRIPTIONS.remember;
    expect(remember.toLowerCase()).toContain("memory rubric");
    expect(remember).not.toContain(
      "琐碎、短时闲聊等组不成可命名工作流的 turn 无须建段",
    );
    expect(remember).not.toContain("先查 roster 有无合适的已有段");
    expect(remember).not.toContain("以任务实际形状命名");
  });
});
