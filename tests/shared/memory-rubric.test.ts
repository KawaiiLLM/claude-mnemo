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
    expect(MEMORY_RUBRIC_TEXT).toContain("# Memory Rubric v5");
    expect(MEMORY_RUBRIC_TEXT).toContain("## Fields");
    // Ticket 03's four-section regroup: `## type`/`## tags` fold into
    // `## Fields` as unheaded sub-blocks (no more standalone `## type`/
    // `## tags` H2s), and `## 归属`/`## 建段` merge into one `## 段` section.
    expect(MEMORY_RUBRIC_TEXT).toContain("type — 词表,每词一义:");
    expect(MEMORY_RUBRIC_TEXT).toContain("tags — 名词,命名物");
    expect(MEMORY_RUBRIC_TEXT).toContain("## 关系(turn→turn;从引用方记向被引方)");
    expect(MEMORY_RUBRIC_TEXT).toContain("## 段(归属与新建)");
    expect(MEMORY_RUBRIC_TEXT).toContain("## Policy(何时去读)");
    // The six discriminator sub-questions the note tool's own description
    // used to inline (ticket 11 migration).
    expect(MEMORY_RUBRIC_TEXT).toContain("evidence-for / evidence-against");
    expect(MEMORY_RUBRIC_TEXT).toContain("grounded-on");
    expect(MEMORY_RUBRIC_TEXT).toContain("override");
    expect(MEMORY_RUBRIC_TEXT).toContain("只点名可推出最终结论的最小集");
    expect(MEMORY_RUBRIC_TEXT).toContain("depends-on");
  });

  // Ticket 03 (edge-mechanism-revision spec "03 — Rubric v5 定稿入库,Policy
  // 并入"): the old `## 建段` H2 (ticket 13's own three ruled lines) merges
  // into the new `## 段(归属与新建)` section alongside `## 归属`. The first
  // of the three lines drops its now-redundant ";无归属是合法状态" suffix
  // (already stated by the 归属 bullet immediately above it in the same
  // section — v4→v5 changelog item 4); the other two lines carry over
  // verbatim.
  test("v5 carries the 段 section's 建段 sub-part, verbatim, ticket 13's ruled lines (minus the v5-deduped suffix)", () => {
    expect(MEMORY_RUBRIC_VERSION).toBe("v5");
    expect(MEMORY_RUBRIC_TEXT).toContain("## 段(归属与新建)");
    expect(MEMORY_RUBRIC_TEXT).toContain(
      "琐碎、短时闲聊等组不成可命名工作流的 turn 无须建段",
    );
    expect(MEMORY_RUBRIC_TEXT).not.toContain(
      "无须建段;无归属是合法状态",
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
  // 那份定义表,逐字一致").
  //
  // Ticket 02 (field-semantics spec "02 — 长度随产出,结论先行") appended one
  // more paragraph to this same block, after the three turn field
  // definitions and before the segment fields.
  //
  // Ticket 03's four-section regroup folds `## type`/`## tags` INTO `## Fields`
  // as sub-blocks sitting between the two halves pinned below, so the tickets
  // 01+02 table is no longer one contiguous run start-to-end — it is pinned
  // here as its two now-separated contiguous halves (opening through the
  // length paragraph; the segment fields through the closing sentence), with
  // an ordering check standing in for the single old contiguous assertion.
  test("v5 carries the Fields section, byte-for-byte, tickets 01+02's own definition table (now split by the type/tags sub-blocks between)", () => {
    const fieldsOpening =
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
      "the tail, so whatever merely supports a decision comes after the decision.";

    const fieldsClosing =
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

    expect(MEMORY_RUBRIC_TEXT).toContain(fieldsOpening);
    expect(MEMORY_RUBRIC_TEXT).toContain(fieldsClosing);
    expect(MEMORY_RUBRIC_TEXT.indexOf(fieldsOpening)).toBeLessThan(
      MEMORY_RUBRIC_TEXT.indexOf(fieldsClosing),
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

  // Ticket 03 (edge-mechanism-revision spec "03 — Rubric v5 定稿入库,Policy
  // 并入"): the old sibling `MEMORY_POLICY_TEXT` block ([S15069/T1028]'s "和
  // rubric 一个块" cohabitation) retires — Policy is now the rubric's own
  // `## Policy` section, so it rides inside `MEMORY_RUBRIC_TEXT` itself and
  // reaches BOTH the SessionStart injection and the settlement prompt (which
  // has no recall tool) alike; there is no longer a second, rubric-only-
  // consumer distinction to police here.
  test("Policy is the rubric's own section — no more sibling policy block or tag", () => {
    const block = renderRubricBlock();
    expect(block).toContain("## Policy(何时去读)");
    expect(block).toContain("注入块只是索引,不是记忆本身");
    expect(block).toContain("先 recall/replay 原回合再落笔");
    // The shared constant both consumers render now carries Policy directly.
    expect(MEMORY_RUBRIC_TEXT).toContain("## Policy(何时去读)");
    expect(MEMORY_RUBRIC_TEXT).toContain("recall/replay");
    // The retired sibling block's own tag must never appear anywhere in the
    // injected output.
    expect(block).not.toContain("<mnemo-memory-policy");
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
