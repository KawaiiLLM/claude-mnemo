import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

import {
  MAX_INJECTED_BLOCK_CHARS,
  renderRubricBlock,
} from "../../src/hooks/session-composition";
import {
  MNEMO_TOOL_DESCRIPTIONS,
  noteInputShape,
  rememberInputShape,
} from "../../src/mcp/definitions";
import { EDGE_RELATIONS, TAGGABLE_RELATIONS } from "../../src/shared/turn-phase";
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
    expect(MEMORY_RUBRIC_TEXT).toContain("# Memory Rubric v11");
    expect(MEMORY_RUBRIC_TEXT).toContain("## Fields");
    // Ticket 03's four-section regroup survives translation: type/tags stay
    // unheaded sub-blocks of `## Fields`, and the four H2s carry the v6
    // English titles (relation-matrix spec, full-English ruling). v7 replaces
    // §Relations' BODY wholesale; all four headings, this one included, are
    // untouched.
    expect(MEMORY_RUBRIC_TEXT).toContain("type — a closed vocabulary, one meaning per word:");
    expect(MEMORY_RUBRIC_TEXT).toContain("tags — nouns, naming things");
    expect(MEMORY_RUBRIC_TEXT).toContain(
      "## Relations (turn→turn; recorded from the citing turn toward the cited)",
    );
    expect(MEMORY_RUBRIC_TEXT).toContain("## Segments (membership and creation)");
    expect(MEMORY_RUBRIC_TEXT).toContain("## Policy (when to read)");
  });

  // v11 (lane-declaration spec, .scratch/lane-declaration/spec.md Rev 3,
  // ticket 08; rulings [S15069/T1524]-[T1562], peer-repaired): §Relations'
  // lane sections replace WHOLESALE with the text the user authored, checked
  // in verbatim at .scratch/lane-declaration/rubric-v11-lane-sections.md —
  // reproduced here rather than paraphrased, in the user's own language (see
  // this file's own v10→v11 history comment in src/shared/memory-rubric.ts
  // for the full rationale). Pinned as whole paragraphs, not sampled
  // substrings, since this IS the ticket's normative text.
  test("v11 carries the lane definition, membership and state, verbatim", () => {
    expect(MEMORY_RUBRIC_VERSION).toBe("v11");

    expect(MEMORY_RUBRIC_TEXT).toContain(
      "**lane**: 段任务下明显可分离、会跨越当前交付继续的子任务，例如 #release / " +
        "#rubric-design；随本轮或本批做完即结束的事务不是 lane，例如 " +
        "#ticket-06-implement / #rubric-v5-design。身份是 `(段, 一个 tag)`：" +
        "**先声明，再使用**；tag 须为 canonical 形式（NFC、去空白、小写、非空），且不得" +
        "与该段的 curated tag 同名。一条带 tag 的边要求**两个端点各自所属的段都已声明该 " +
        "tag**——无段的 turn 不得带 tag，跨段的边两侧都要声明。",
    );
    expect(MEMORY_RUBRIC_TEXT).toContain(
      "**成员资格**：只来自**带该 tag 的边**——节点自身的 tags 含该 tag 只是准入的必要" +
        "条件，不构成成员；无 tag 的边既不建立也不延续 lane。lane 图中每个节点自身的 " +
        "tags 都必须包含该 lane tag。lane 至少两个节点；一条边可带多个 tag，表示这几条 " +
        "lane 共用它。",
    );
    // Lane-model v12 ticket 02: the 相位配对 paragraph is GONE — the write
    // gate does not pair phases any more, so a rubric teaching the exists-rule
    // would teach a check that cannot fire. Pinned as an ABSENCE where the
    // verbatim pin used to sit, so a future edit cannot quietly restore it.
    expect(MEMORY_RUBRIC_TEXT).not.toContain("**相位配对**");
    expect(MEMORY_RUBRIC_TEXT).not.toContain("满足该词同/异相位要求的配对");
    expect(MEMORY_RUBRIC_TEXT).toContain(
      "**状态**：lane 的所有事件按 **turn 顺序**归约。",
    );
    expect(MEMORY_RUBRIC_TEXT).toContain(
      "closed 的 lane 在其被索引的**核心节点**尚有存活者时 **valid**，全部死亡则 " +
        "**invalid**。**核心节点** = 终点的结果仍然保留并代表其内容的成员；存活只是必要" +
        "条件。",
    );
  });

  // The SEVEN-word vocabulary (lane-model v12 ticket 02). Two rules retire
  // together here, and both are pinned by their absence below: `refutes` as a
  // word of its own (merged into `override`, whose bullet now names all four
  // cases it covers), and the 同相位/异相位 domain marker every bullet used to
  // carry. Every word MAY carry a tag and none MUST — the older tag-mandate
  // MUST/MAY split retired at v11 and stays gone.
  test("v11 carries all SEVEN words verbatim, with no phase marker and no refutes bullet", () => {
    for (const bullet of [
      "- **override** → 其主要结果被本节点否决、撤回、替换——反证、撤回、放弃、取代同用" +
        "此词。带 tag = lane 内纠正，lane 重开待新宣告；无 tag = 对该结论的全局否决，" +
        "所有以它为现任终点的 lane 一并失去终点。",
      "- **narrows** → 其部分结果不再适用，本节点作出纠正。",
      "- **extends** → 其结果仍然适用，本节点拓展、补充。",
      "- **consume** → 使用其产出，不为其正确性担责。",
      "- **grounds** → 本节点的成立依赖其成立，它若倒下，本节点随之倒下。有独立 " +
        "spec 轮时由 spec 承担 grounds、其余工件 consume 该承担者；无 spec 时工件直接 " +
        "grounds。",
      "- **verifies** → 以本轮产出的检验结果支持其结论；检验结果与其相悖时写 override，" +
        "不另设反驳词。",
    ]) {
      expect(MEMORY_RUBRIC_TEXT).toContain(bullet);
    }
    expect(MEMORY_RUBRIC_TEXT).toContain(
      "**七词**（非自引边均可带 tag；词义与两端的相位无关）:",
    );
    expect(MEMORY_RUBRIC_TEXT).not.toContain("**八词**");
    // No word bullet carries a phase domain any more, and the merged word is
    // not taught as a separate one.
    expect(MEMORY_RUBRIC_TEXT).not.toContain("→ 同相位");
    expect(MEMORY_RUBRIC_TEXT).not.toContain("→ 异相位");
    expect(MEMORY_RUBRIC_TEXT).not.toContain("refutes");
    expect(MEMORY_RUBRIC_TEXT).not.toContain("须含取证相位");
    // The retired v10 mandate header — one MUST for two words, MAY for
    // three, never for the cross-phase trio — must not survive.
    expect(MEMORY_RUBRIC_TEXT).not.toContain("MUST carry lane tags");
    expect(MEMORY_RUBRIC_TEXT).not.toContain("MAY, cross-phase words never do");
  });

  // Self-citation, skip/rewind, the three worked examples (release ritual,
  // the cross-phase line, the shared-edge/confluence idiom) and the three
  // judgment principles — all verbatim from the same v11 source file.
  test("v11 states self-citation, skip/rewind, the worked examples and the three principles, verbatim", () => {
    expect(MEMORY_RUBRIC_TEXT).toContain(
      "**自引**：只允许裸 `grounds`，且本 turn 须含落地相位、并在本次写入后仍是自己" +
        "以带 tag 的 `indexes` 宣告的某条 lane 的当前终点；其余七词不得自引。自引边一律" +
        "不带 tag——带 tag 意味着点名一条 lane，而单节点自环不构成 lane。",
    );
    expect(MEMORY_RUBRIC_TEXT).toContain(
      "**skip/rewind**：被 skip 或 rewind 的 turn 不是节点，不得作为边的端点。",
    );
    // #release: the D11 membership-discrimination ruling ([S15069/T1552]-
    // [T1560]) folded into this one worked example — a standing, permanently
    // open release lane plus one tagged indexes per landed lane.
    expect(MEMORY_RUBRIC_TEXT).toContain(
      "- **#release**：每次发布做三件事——`consume{release}` 串起上一次发布" +
        "（这条 lane 永不收敛）；无 tag 的 `indexes` 聚合本次所运工件；对本批落地的" +
        "每条 lane 各写一条 `indexes{该 lane}`，索引它自己的核心节点。没有「一次宣告" +
        "涵盖多条 lane」这种写法。",
    );
    expect(MEMORY_RUBRIC_TEXT).toContain(
      "- **跨相位的一条线**：`实现 —consume{rubric-design}→ spec " +
        "—grounds{rubric-design}→ 设计终点`。同一个 tag 贯穿决策与落地，不拆成两条 " +
        "lane。",
    );
    // The confluence/membership-discriminator idiom [S15069/T1552]: a shared
    // edge carries every lane it genuinely serves; a correction on one names
    // only that one.
    expect(MEMORY_RUBRIC_TEXT).toContain(
      "- **共用边**：只有当**这一条边**的语义确实同时服务 A/B/C 时，它才带 " +
        "`{A,B,C}`；批次里各自只服务一条 lane 的边只带自己的 tag。针对其中一条的纠正写" +
        "**只点名那条**的 `override{B}`。",
    );
    expect(MEMORY_RUBRIC_TEXT).toContain(
      "**原则**（判断性，不强制；在**段的全图**上考察，路径可经过 lane 外的节点）:",
    );
    expect(MEMORY_RUBRIC_TEXT).toContain("- **有效性**：无有效产出、重复的 turn 应该 skip。");
    expect(MEMORY_RUBRIC_TEXT).toContain(
      "- **连通性**：lane 的所有成员应连成一体；indexes 不参与连通性计算。",
    );
    expect(MEMORY_RUBRIC_TEXT).toContain(
      "- **最小连通**：任意两个节点之间的路径应该只有一条，除非多出的那条路径带来了必要" +
        "信息。",
    );
  });

  // Retirement guard: the five ideas ticket 08 is REQUIRED to purge, verified
  // absent from the WHOLE rendered text (grepped, not trusted to a section
  // replacement) — a stray survivor anywhere would teach a lane shape the
  // checker no longer recognises (lane-declaration ticket 03/D5, already
  // shipped, re-derives every verdict around a single declared tag).
  test("the five retired v10 lane ideas do not survive anywhere in the rubric", () => {
    for (const retired of [
      "exact SET of tags scoped to that segment", // lane identity as an exact set
      "exact set names ONE lane",
      "BRANCHES lane A when B starts inside A", // BRANCH by proper superset
      "PROPER SUPERSET of A's tags",
      "REOPENS a closed", // REOPEN by inheriting a closed lane's set
      "phase-local", // the phase-local lane
      "MUST carry lane tags", // the continuation-word tag mandate
    ]) {
      expect(
        MEMORY_RUBRIC_TEXT,
        `retired v10 lane idea must not survive: ${retired}`,
      ).not.toContain(retired);
    }
  });

  // The eight-word bullet list is exhaustive against EDGE_RELATIONS, parsed
  // out of the v11 bullet shape ("- **word** → ..." / "- **word / word** →
  // ..."), the same drift guard v10 ran against its old "· word — " bullets.
  //
  // The cross-check this block used to defer is now made (ticket 02 landed:
  // TAG_MANDATORY_RELATIONS is deleted rather than emptied, and
  // TAGGABLE_RELATIONS covers all eight). It is the one assertion binding the
  // rubric's own bullet list to the gate's vocabulary, so a future narrowing
  // on either side surfaces here rather than as a settlement run refused for
  // doing exactly what it was taught.
  const rubricBulletWords = () =>
    [
      ...MEMORY_RUBRIC_TEXT.matchAll(/^- \*\*([a-z]+)(?:\s*\/\s*([a-z]+))?\*\* →/gm),
    ].flatMap((m) => (m[2] ? [m[1], m[2]] : [m[1]]));

  test("the eight-word bullet list is exhaustive against EDGE_RELATIONS", () => {
    expect([...rubricBulletWords()].sort()).toEqual([...EDGE_RELATIONS].sort());
  });

  test("every word the rubric teaches as taggable is taggable at the gate — the two vocabularies agree", () => {
    // v11: "八词（非自引边均可带 tag）". No word requires one, which is why
    // there is no TAG_MANDATORY_RELATIONS left to compare against.
    for (const word of rubricBulletWords()) {
      expect(TAGGABLE_RELATIONS.has(word as (typeof EDGE_RELATIONS)[number])).toBe(true);
    }
  });

  // v11 retires the standalone "Convergence never happens by silence" /
  // "SUBSET INVARIANT" paragraph (and the older two-pass PRECURSORS/
  // AGGREGATION procedure it had already replaced) — both facts fold into the
  // 状态 (state) paragraph and the lane definition's own subset clause,
  // pinned by the whole-paragraph tests above. This test pins the retirement
  // side only, so a future edit cannot reintroduce the old English framing
  // alongside the new Chinese one.
  test("v11 states convergence and the subset invariant inline, not as a separate English procedure", () => {
    expect(MEMORY_RUBRIC_TEXT).not.toContain("Convergence never happens by silence");
    expect(MEMORY_RUBRIC_TEXT).not.toContain("SUBSET INVARIANT:");
    expect(MEMORY_RUBRIC_TEXT).not.toContain("Every finished turn makes two passes");
    expect(MEMORY_RUBRIC_TEXT).not.toContain("PRECURSORS");
    expect(MEMORY_RUBRIC_TEXT).not.toContain("AGGREGATION —");
    expect(MEMORY_RUBRIC_TEXT).toContain(
      "lane 图中每个节点自身的 tags 都必须包含该 lane tag。",
    );
  });

  // No ghost of the flow-model's cite-through-settlement or mid-flow receipt
  // teaching (retired at v10) survives the v11 rewrite either.
  test("no ghost of the flow-model's cite-through-settlement or mid-flow receipt teaching survives", () => {
    expect(MEMORY_RUBRIC_TEXT).not.toContain("mid-flow");
    expect(MEMORY_RUBRIC_TEXT).not.toContain("SETTLEMENT. ");
    expect(MEMORY_RUBRIC_TEXT).not.toContain("the receipt names");
  });

  // The v1 division of labor ([S15069/T1238], reversed at v10 by T1277): the
  // three principles are a GENERATIVE aspiration, not enforcement — the
  // checker reports facts and never blocks — and checker mechanics (scan
  // algorithms, debt, coverage) must never leak into this file. v11 restates
  // the same three principles in the user's own terser Chinese; this test
  // moves with the language.
  test("the three principles read as judgment aspirations, and checker mechanics stay out", () => {
    expect(MEMORY_RUBRIC_TEXT).toContain(
      "**原则**（判断性，不强制；在**段的全图**上考察，路径可经过 lane 外的节点）:",
    );
    expect(MEMORY_RUBRIC_TEXT).toContain("- **有效性**：");
    expect(MEMORY_RUBRIC_TEXT).toContain("- **连通性**：");
    expect(MEMORY_RUBRIC_TEXT).toContain("- **最小连通**：");
    for (const toolOnly of ["lint", "unreachable member", "coverage", "debt", "scanner"]) {
      expect(
        MEMORY_RUBRIC_TEXT,
        `checker mechanics must not be taught in the rubric: ${toolOnly}`,
      ).not.toContain(toolOnly);
    }
  });

  // The retired vocabulary, as a residue guard: every one of these words was
  // load-bearing in some earlier §Relations and none may survive anywhere in
  // the document — a leftover would teach a word the write gate no longer
  // accepts. The first six are v6's; `collects` joins them at v8, where it
  // renamed to `indexes` (indexes-rescope spec) — the note parameter of that
  // name is gone from the schema, so a rubric still naming it would teach a
  // call that cannot parse.
  test("no retired relation word survives anywhere in the rubric", () => {
    for (const retired of [
      "refines",
      "encodes",
      "depends-on",
      "grounded-on",
      "evidence-for",
      "evidence-against",
      "collects",
    ]) {
      expect(
        MEMORY_RUBRIC_TEXT,
        `retired v6 relation word must not survive: ${retired}`,
      ).not.toContain(retired);
    }
  });

  // v6 (relation-matrix spec, full-English ruling): ticket 13's three ruled
  // segment-creation lines survive translation inside `## Segments
  // (membership and creation)` — pinned at the English renderings approved
  // through the three-round peer review of the v6 draft. §Segments is
  // UNTOUCHED by the v10→v11 lane rewrite (ticket 08's scope is §Relations
  // only), so every pin here still holds; only the version string moves.
  test("v11 still carries the Segments creation lines, per the approved translation", () => {
    expect(MEMORY_RUBRIC_VERSION).toBe("v11");
    // Ticket 07's one Segments-side addition: manual segment tags gate
    // membership; lane tags are a disjoint vocabulary.
    expect(MEMORY_RUBRIC_TEXT).toContain(
      "- A segment's tags are hand-curated identity: a member turn carries ALL of\n" +
        "  them. Lane tags are separate and never include them.",
    );
    expect(MEMORY_RUBRIC_TEXT).toContain("## Segments (membership and creation)");
    expect(MEMORY_RUBRIC_TEXT).toContain(
      "Trivia and short chatter that form no nameable workflow need no segment.",
    );
    // Compressed for the T1360 lane-definition budget pass; the two semantics
    // (reuse-before-new, name by actual shape not opening guess) survive.
    expect(MEMORY_RUBRIC_TEXT).toContain(
      "Check the roster first — attach to a fitting segment; create only when\n" +
        "  nothing fits, named after the task's actual shape (an opening guess\n" +
        "  anchors it wrong).",
    );
  });

  // v11's release ritual, the retraction line and the pre-registration clause.
  //
  // The old English "Axiom:" framing retires — the SAME three facts
  // (untagged indexes over shipped artifacts, consume chaining the previous
  // release, no blanket declaration) now live inside the v11 text's own
  // worked #release example (pinned in full above), extended with the
  // per-lane tagged indexes the [S15069/T1552]-[T1562] membership-
  // discrimination ruling added. Retraction ([S15069/T1130]) and
  // pre-registration (T1190 ⑦a) are unrelated to lane identity and carry
  // over untouched — trailing the reproduced Chinese block now, in the same
  // relative order, rather than trailing the old Axiom paragraph.
  //
  // Two v10 sentences this pass drops rather than carries forward, named here
  // so they are never rediscovered as accidents: the R1 dead-node/
  // tagged-override-stays-live pair (redundant with the v11 text's own
  // 核心节点 definition, which states the same content-preservation test for
  // every member, not only an override's victim) and the ADOPTED-evidence
  // sentence (no v11 counterpart at all — a deliberate content loss, flagged
  // in this ticket's own report for the delegator to confirm rather than
  // silently re-added).
  test("v11 carries the release ritual inside its own worked example, and the retraction/pre-registration trailer survives in order", () => {
    expect(MEMORY_RUBRIC_VERSION).toBe("v11");
    expect(MEMORY_RUBRIC_TEXT).not.toContain("Axiom: a release indexes");

    const releaseExample =
      "- **#release**：每次发布做三件事——`consume{release}` 串起上一次发布";
    const retraction =
      "Delete an edge found false and rewrite as needed — retraction and\n" +
      "re-judgment are both acts of judgment, never tidying.";
    const preRegistration =
      "A prediction made\nbefore its test lives in insight, not in the graph.";
    expect(MEMORY_RUBRIC_TEXT).toContain(releaseExample);
    expect(MEMORY_RUBRIC_TEXT).toContain(retraction);
    expect(MEMORY_RUBRIC_TEXT).toContain(preRegistration);
    expect(MEMORY_RUBRIC_TEXT.indexOf(releaseExample)).toBeLessThan(
      MEMORY_RUBRIC_TEXT.indexOf(retraction),
    );
    expect(MEMORY_RUBRIC_TEXT.indexOf(retraction)).toBeLessThan(
      MEMORY_RUBRIC_TEXT.indexOf(preRegistration),
    );
    expect(MEMORY_RUBRIC_TEXT.indexOf(preRegistration)).toBeLessThan(
      MEMORY_RUBRIC_TEXT.indexOf("## Segments (membership and creation)"),
    );

    expect(MEMORY_RUBRIC_TEXT).not.toContain("kills, leaving a dead node");
    expect(MEMORY_RUBRIC_TEXT).not.toContain("ADOPTED is a living judgment");
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
  // The tag-mandate budget pass (ticket 01) touched this block for the first
  // time since ticket 02 wrote it, and only where nothing is asserted: the
  // three continuation lines lose their 12-space alignment indent (the label
  // column keeps its padding — "title   — the INDEX" is pinned by
  // tests/hooks/context-note-taking.test.ts), `title` reads "One sentence on
  // what this turn is doing" instead of "saying what", and the length
  // paragraph drops "— a summary cannot hold it" while keeping the ruling it
  // justified (process detail belongs to replay, content leads with its
  // conclusions, length tracks output). Every definition is word-for-word.
  test("the turn-field definitions stay in the rubric, byte-for-byte (tickets 01+02)", () => {
    const fieldsOpening =
      "## Fields\n" +
      "\n" +
      "Turn note — three fields, three jobs:\n" +
      "- title   — the INDEX. One sentence on what this turn is doing, enough to\n" +
      "  recognise it among titles alone. Not the conclusion.\n" +
      "- content — the CONCLUSIONS. Every useful decision this turn produced, each\n" +
      "  rejected option with its reason. Assumes the title was just read.\n" +
      "- insight — REUSABLE experience. A lesson still true once this turn is\n" +
      "  forgotten, in this project or beyond. Not a conclusion of this turn.\n" +
      "\n" +
      "Length tracks OUTPUT, not effort: nothing produced is a skip, little produced\n" +
      "is terse. Process detail belongs to replay. Content leads with its\n" +
      "conclusions: a reader's budget cuts the tail, so support comes after the\n" +
      "decision.";

    expect(MEMORY_RUBRIC_TEXT).toContain(fieldsOpening);

    // The turn fields stay HERE because the settlement surface has no
    // `title`/`content` describe at all (settlementNoteInputShape omits them),
    // so this block is that agent's only source for what those fields are.
    // Deleting it as "duplicated with the note describes" would have silently
    // stripped the settlement agent — the reason this comment exists.
  });

  // The segment-field definitions LEFT this file (user ruling, S15069/T1264:
  // compress them into the tool describes, losing no information). They were
  // duplicated for the main agent, which reads the same definitions on
  // `remember`'s standing `field` describe, and dead weight for the settlement
  // agent, whose membership surface has no `field` parameter at all. This test
  // is the no-information-lost guarantee, made mechanical: every fact the
  // removed block carried must be findable on a describe, and must NOT have
  // grown a second home back in the rubric.
  test("every segment-field fact the rubric dropped now lives on a remember describe", () => {
    const field = rememberInputShape.field.description ?? "";
    const title = rememberInputShape.title.description ?? "";

    // The six Working State fields and the two Summary fields, each with the
    // discriminator that made it distinguishable from its neighbours.
    for (const fact of [
      "goal: what this task is trying to achieve",
      "constraints: how the work must be done — norms, habits, standing preferences",
      "decisions: concrete rulings about the task itself, settled and binding",
      "done: what is finished and verified",
      "next_steps: what is waiting to be done",
      "reference: durable pointers — source locations, specs, PRs, URLs; not plans",
      "content: the impression this arc leaves, what it is about and how it went",
      "insight: reusable experience this task has settled",
    ]) {
      expect(field).toContain(fact);
    }

    // The two framings — who each group of fields is written FOR — and the arc
    // discriminator on content. These three were the parts the describe did
    // NOT already carry before the migration.
    expect(field).toContain("Working State, what a resuming session needs to continue");
    expect(field).toContain("Summary, what an outsider browsing the task reads");
    expect(field).toContain("(the arc, not per-turn conclusions)");

    // The derivation rule, which lived ONLY in the rubric: it explains why this
    // shape has no type parameter, so it belongs beside the identity fields a
    // caller does write. Ticket 07 SPLIT the old claim: type stays derived,
    // tags became hand-curated (create/retag) and gate membership — the pin
    // follows the split, not the retired both-derived wording.
    expect(title).toContain("set once, here");
    expect(title).toContain(
      "A segment's type is never written by hand: it is DERIVED from its member turns",
    );

    // And the rubric must not re-grow a copy: two homes for one definition is
    // the drift this file's own header exists to prevent.
    for (const orphan of [
      "Segment, Working State",
      "Segment, Summary layer",
      "next_steps  —",
      "never written by hand",
    ]) {
      expect(MEMORY_RUBRIC_TEXT).not.toContain(orphan);
    }
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

  // The rubric has no demote ladder of its own — it renders whole (above) and
  // then meets `enforceHardCharLimit`, a SILENT governor: one character over
  // the cap and the block is sliced with a marker appended, so the tail
  // (Policy first, then §Segments, then §Relations' own last bullets) simply
  // stops reaching either consumer while every verbatim assertion above still
  // passes against the untruncated CONSTANT. Nothing else in the suite fails
  // on that. v6 compressed prose to stay under this line and v8 spent 62% of
  // what v6 left (443 → 167 chars of headroom), so the version that finally
  // crosses it is not hypothetical — this makes it fail loudly instead.
  test("the rendered block fits the injection cap untruncated", () => {
    const block = renderRubricBlock();
    expect(block.length).toBeLessThan(MAX_INJECTED_BLOCK_CHARS);
    // The governor never had to touch it: injected bytes === rendered bytes.
    expect(block).toBe(renderMemoryRubricBlock());
    expect(block).not.toContain("block truncated");
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
    expect(block).toContain("## Policy (when to read)");
    expect(block).toContain("Injected blocks are an index, not the memory itself");
    expect(block).toContain("recall or replay the original turn before writing");
    // The shared constant both consumers render now carries Policy directly.
    expect(MEMORY_RUBRIC_TEXT).toContain("## Policy (when to read)");
    expect(MEMORY_RUBRIC_TEXT).toContain("recall or replay");
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
    expect(renderRubricBlock()).toContain("Materialization moments");
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

  test("override/grounds/note each point at the Memory Rubric instead of restating judgment", () => {
    expect(MNEMO_TOOL_DESCRIPTIONS.note.toLowerCase()).toContain("memory rubric");
    expect(noteInputShape.override.description?.toLowerCase()).toContain("memory rubric");
    expect(noteInputShape.grounds.description?.toLowerCase()).toContain("memory rubric");
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
