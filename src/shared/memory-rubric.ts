import { createHash } from "node:crypto";

/**
 * The Memory Rubric — the single canonical home for JUDGMENT (ticket 11,
 * edge-ownership-impl: "判断规则的唯一规范入口"; [S15069/T933], [T937]–[T939]
 * peer discussion).
 *
 * Three-way split settled by the peer discussion this ticket closes out:
 * FORMAT lives on each MCP parameter's own `.describe()` (mcp/definitions.ts),
 * TIMING/FREQUENCY lives on the note tool's own description (and the
 * SessionStart note-taking block, hooks/handlers/context-note-taking.ts —
 * unrelated to this file, a different split entirely), and JUDGMENT — which
 * word, which relation, which owner a fact actually deserves — lives HERE,
 * nowhere else. Before this ticket, judgment text was duplicated onto the
 * note tool's own description (the six-question relation ladder) and onto
 * two parameter `.describe()`s (`override`'s refines/override discriminator,
 * `encodes`' minimal-set rule) — two homes for the same decision, the exact
 * drift shape [S15069] measured settlement's own scoring/relation prompts
 * suffering from repeatedly. Every one of those sites now states only a
 * call-level POINTER at this file; the judgment prose itself lives only
 * here.
 *
 * TEXT BELOW IS VERBATIM (ticket 11's own "Rubric 定稿" section) — do not
 * paraphrase, reformat or "improve" it without a new ticket. It renders
 * BYTE-IDENTICAL in two places: the SessionStart injection (main agent,
 * `hooks/session-composition.ts`'s `renderRubricAndRosterBlock`) and the
 * settlement prompt (`worker/note-settlement-prompt.ts`) — a hash guard test
 * (tests/shared/memory-rubric.test.ts) asserts both renderings hash to
 * `MEMORY_RUBRIC_HASH`, computed from this same constant, so the two can
 * never quietly diverge into two different rubrics.
 */
export const MEMORY_RUBRIC_VERSION = "v2";

export const MEMORY_RUBRIC_TEXT = `# Memory Rubric v2

## type
- 词表,每词一义:
  - discuss — 探讨问题与方案,产生理解但未落裁决;倾向/暂定而未承诺,仍是 discuss
  - research — 查外部资料/源码/文献,产出「世界/代码现状是什么」的事实
  - measure — 本轮跑出的可复核结果:实验、统计、查数
  - design — 做出或修订一个此后要遵守的承诺:机制、契约、阈值
  - correction — 纠正此前错误的结论或方向;错的是判断(代码缺陷归 fix;实现偏离设计而改码 = correction+fix)
  - implement — 把已定设计写成新工件:代码、文档、测试
  - refactor — 减法与重整:删除能力、迁移形态,不新增行为承诺(顺手修缺陷 = refactor+fix)
  - fix — 修复缺陷,让既有承诺重新成立
  - delegate — 派工给 subagent 或外部执行者(同轮验收返回 = delegate+review)
  - review — 核查工作产物是否达标;仅当否定了既有设计裁决才 +design/correction
  - ops — 交付(发布/提交/发 spec/开票)与运维(探活/重启/修数据);纯转写 spec = ops,兼有新裁决 = design+ops
- 阶段:取证 = research/measure · 决策 = design/discuss/correction · 落地 = 其余
- 跨阶段动摇必须双 type;多 type 的阶段是集合,存在合法对即可写边
- 没有词适配就留空,不硬贴

## tags
- 名词,命名物:项目优先,再子系统/工件;活动词属 type
- 小写连字符;优先复用既有 tag;发现同义分裂,归并到先到的词

## 关系(turn→turn;从引用方记向被引方)
每个完结 turn 过三步:
1. 有直接前驱吗?前驱 = 直接引起这一轮的节点;跳级指向弧起点是错标。
   没有 → 孤儿仅两类合法:未曾设想的子任务起点 / 无决策闲杂;不为消灭孤儿编边。
2. 有 → 哪条关系?判别问句,先中先得:
   ① 我检验了那条主张? → evidence-for / evidence-against
   ② 我的决策靠那个发现立足(它假则我塌)? → grounded-on
   ③ 被引结论整体是错的? → override;只是继续或改其中一段? → refines
   ④ 本轮工件承载那条决策? → encodes,只点名可推出最终结论的最小集
   ⑤ 纯工序因果,无决策内容? → depends-on
   ⑥ 都不是 → 不记
3. 被拒?合法性由校验器机器检查,拒绝信息说明缺哪一半 → 补足最小缺失的 type,或改判关系。
- override/encodes 是软断言:拿不准 override,用 refines。

## 归属
- turn 属于其内容服务的任务段,至多一个;闲杂无归属是合法状态
- (结算侧)值域 = 该会话已挂靠段 ∪ 无归属;只纠显性失配,存疑不动
  - 正例:turn 通篇修改 A 段的模块,却挂在 B 段 → 改派 A
  - 反例:标题与 A 段相关,但内容看不出服务它 → 不动
`;

function computeHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
}

/** A short content hash of `MEMORY_RUBRIC_TEXT` alone — the guard test's own independent recomputation compares against this. */
export const MEMORY_RUBRIC_HASH = computeHash(MEMORY_RUBRIC_TEXT);

const MEMORY_RUBRIC_OPEN_TAG = `<mnemo-memory-rubric version="${MEMORY_RUBRIC_VERSION}" hash="${MEMORY_RUBRIC_HASH}">`;
const MEMORY_RUBRIC_CLOSE_TAG = "</mnemo-memory-rubric>";

/**
 * The ONE render function both consumers call — never a copy-pasted inline
 * string at either call site. Wraps `MEMORY_RUBRIC_TEXT` (untouched) with a
 * version/hash header line (ticket 11: "头部带 version/hash 行") so a stray
 * mismatch between the two renderings is visible on sight, without needing
 * the guard test to catch it. Byte-identical by construction: both callers
 * hold a reference to the same function, not to two copies of its output.
 */
export function renderMemoryRubricBlock(): string {
  return `${MEMORY_RUBRIC_OPEN_TAG}\n${MEMORY_RUBRIC_TEXT}${MEMORY_RUBRIC_CLOSE_TAG}`;
}
