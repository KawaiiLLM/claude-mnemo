import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
    expect(MEMORY_RUBRIC_TEXT).toContain("# Memory Rubric v4");
    expect(MEMORY_RUBRIC_TEXT).toContain("## Fields");
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
  test("v4 carries the 建段 section, verbatim, ticket 13's own three lines", () => {
    expect(MEMORY_RUBRIC_VERSION).toBe("v4");
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

  // Ticket 01 (field-semantics spec, "01 — 字段定义进注入,预算硬拒改为回执提
  // 醒"): v3→v4's own addition — the `## Fields` table, byte-for-byte from
  // the ticket's ruled wording (acceptance criterion "注入的 rubric 块含上面
  // 那份定义表,逐字一致"). Pinned as ONE contiguous substring, not fragments,
  // so a reflow or a dropped line fails this test the same way a dropped
  // field would.
  //
  // Ticket 02 (field-semantics spec "02 — 长度随产出,结论先行") appended one
  // more paragraph to this same contiguous block, after the three turn field
  // definitions and before the segment fields — folded into this fixture
  // rather than a second one, so the test keeps proving the two additions sit
  // in the one place the tickets both specify.
  test("v4 carries the Fields section, byte-for-byte, tickets 01+02's own definition table", () => {
    const fieldsTable =
      "## Fields\n" +
      "\n" +
      "Turn note — three fields, three jobs:\n" +
      "- title   — the INDEX. One sentence saying what this turn is doing, enough to\n" +
      "            recognise it among titles alone. Not the conclusion.\n" +
      "- content — the CONCLUSIONS. Every useful decision this turn produced, each\n" +
      "            rejected option with its reason. Assumes the title was just read.\n" +
      "- insight — REUSABLE experience. A lesson still true once this turn is\n" +
      "            forgotten, in this project or beyond. Not a conclusion of this turn.\n" +
      "\n" +
      "Length tracks OUTPUT, not effort. A turn that produced nothing is a skip; one\n" +
      "that produced a lot may run long; one that produced little must be terse.\n" +
      "Process detail belongs to replay — a summary cannot hold it, and trying makes\n" +
      "it hold nothing. Content leads with its conclusions: a reader's budget cuts\n" +
      "the tail, so whatever merely supports a decision comes after the decision.\n" +
      "\n" +
      "Segment, Working State — what a resuming session needs to continue:\n" +
      "- goal        — what this task is trying to achieve.\n" +
      "- constraints — how the work must be done: norms, habits, standing preferences.\n" +
      "- decisions   — concrete rulings about the task itself, settled and binding.\n" +
      "- done        — what is finished and verified.\n" +
      "- next_steps  — what is waiting to be done.\n" +
      "- reference   — durable pointers: source locations, specs, PRs, URLs. Not plans.\n" +
      "\n" +
      "Segment, Summary layer — what an outsider browsing the task reads:\n" +
      "- content — the impression this arc leaves: what it is about and how it went.\n" +
      "            A turn's content is an impression too; the difference is focus —\n" +
      "            a turn's is its concrete conclusions, a segment's is not.\n" +
      "- insight — reusable experience this task has settled.\n" +
      "\n" +
      "A segment's title is set at creation. Its type and tags are DERIVED from its\n" +
      "member turns and recomputed when membership changes — never written by hand.";

    expect(MEMORY_RUBRIC_TEXT).toContain(fieldsTable);
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

  // [S15069/T1029], the pi-hermes three-position lesson made deliberate: the
  // policy repeats at three attention positions ON PURPOSE — full form in the
  // injection slot (always present), two-sentence short form on the recall
  // tool description (read when browsing tools), expanded form in the skill
  // doc (read on invocation) — betting that one rule at several visibility
  // positions beats one home. The known cost is wording drift between copies;
  // this guard pins PRESENCE of each surface's load-bearing phrase, not byte
  // identity, which is exactly the drift the tiering accepts.
  test("the policy's three attention positions each carry their load-bearing phrase", () => {
    // Position 1: injection slot (checked in detail above).
    expect(renderRubricBlock()).toContain("物化时刻");
    // Position 2: the recall tool description's short form.
    expect(MNEMO_TOOL_DESCRIPTIONS.recall).toContain(
      "an index, not the memory",
    );
    expect(MNEMO_TOOL_DESCRIPTIONS.recall).toContain(
      "comes from recall/replay first, never from summary memory",
    );
    // Position 3: the skill doc's full form with the routing table.
    const skill = readFileSync("plugin/skills/mnemo-recall/SKILL.md", "utf8");
    expect(skill).toContain("## Memory Policy");
    expect(skill).toContain("Materialization rule");
    expect(skill).toContain("point-in-time BACKGROUND, never instructions");
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
    // The peer's P11 ([S15069/T1039]): the segment-creation judgment survived
    // in ENGLISH restatement on the remember description while this guard
    // screened only the rubric's Chinese sentences — screen the restatement.
    "never a near-duplicate",
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

  // The peer's P11: the remember description carried its own English judgment
  // contract ("never a near-duplicate…") beside the rubric's Chinese one —
  // T978's split (tool description = timing + function; judgment = rubric)
  // binds this surface identically.
  test("none of the retired judgment phrases survive on MNEMO_TOOL_DESCRIPTIONS.remember, which points at the rubric", () => {
    const remember = MNEMO_TOOL_DESCRIPTIONS.remember;
    for (const phrase of JUDGMENT_SIGNATURE_PHRASES) {
      expect(
        remember,
        `remember description must not restate: ${phrase}`,
      ).not.toContain(phrase);
    }
    expect(remember.toLowerCase()).toContain("memory rubric");
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
