# 08 — ADR 修订与消费者同步,批次收口

**What to build:** 决策史读起来是连续的:四份 ADR 与本批的实际契约一致,教学面
说的话与接口实际接受的东西一致。

**Ruling base:** spec D15。

**Blocked by:** 05、06、07(契约定型后才写文档,否则写的是草稿)。

**Status:** blocked

## Pinned decisions

- **ADR-0008 要修订,不是补注。** 它现行文字是全量 grant 语义
  (「Rendering IS how a grant gets earned」),不涵盖 `write` 的未截断要求,也
  不涵盖逐字段完整性。只挂补注会让后来的实现者按基线把两种模式重新拉平。
- ADR-0001 补注:字段编辑动词从 `append`/`replace` 换成 `write`/`edit`,行列表
  的内容形态不变。
- ADR-0002 补注两处:writer 表里的动词列;节奏条款——「太频繁」退役,
  `decisions` 的豁免随之消失(不是被裁掉,是失去了存在的前提)。
- ADR-0007 补注:结算不再是「不同 facade」,工具与主 agent 一致,差集为
  `{commit}`。
- 消费者清单以**实际教学源**为准:`definitions.ts` 的工具描述、结算的提示词与
  SDK 工具描述、以及签入的 `plugin/scripts/*.cjs`——那是 `plugin/.mcp.json` 指
  向的运行时入口。
- **Memory Rubric 与 mnemo-recall skill 当前没有写模式教学,不要凭空往里加。**
  spec 初稿曾声称它们需要更新,已核实为错。
- `CONTEXT.md` 已在 spec 阶段更新(Read grant、Complete read、Stale、Write
  mode 四条),本票只核对措辞与最终契约一致,不重写。

## Acceptance criteria

- [ ] 四份 ADR 与实际契约一致;ADR-0008 是修订过的基线而非叠加的补注。
- [ ] 工具描述、结算提示词与 SDK 描述里没有旧词汇残留(全仓搜
      `overwrite`/`append`/`replace` 的写模式义项,逐一确认)。
- [ ] `CONTEXT.md` 四条词条与最终契约一致。
- [ ] 报告里明确列出**签入的 bundle 需要重建**,以及在重建并 reload 之前,已发
      布插件仍在教旧词汇这一窗口期。
- [ ] typecheck 干净;全套绿,只余既定的陈旧包守卫红。

## Ground rules

- NO git write commands。报出改动文件清单,主会话提交。
- **不要自行重建 bundle。** `node scripts/build.js` 只在发版流程里跑;本票只负
  责标注需要重建。
- 不碰 `~/.claude-mnemo/`、版本号。
- 自己文件之外的瞬时红:窄范围重跑,绝不回滚工作树。
