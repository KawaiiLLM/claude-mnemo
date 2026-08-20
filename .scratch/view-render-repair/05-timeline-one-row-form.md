# 05 — timeline 只有一种行式:time、type、title

**What to build:** timeline 的每一行都是 `[T821] 08-17 18:19 ⚖️ title`,底下按需
跟一行 `↳` 前驱地址。没有 metadata 行,没有 `- content:`,没有 `- prompt:`。
`milestones` 与 `turns` 两个视图的差别**只剩选谁上榜**,行式完全共用。

**Ruling base:** [S15069/T1067]——用户重新给出当初的设计与样例,并指出
「timeline 不展示 content 字段,只有 time types title,没有其他渲染器」。行标签
取 title 还是 prompt 由 [S15069/T1068] 依实测裁定。

**Blocked by:** none。与写模式那批(`.scratch/write-mode-edit-semantics/`)无依
赖,可并行。

**Status:** ready-for-agent

## 金样例(用户原文,逐字保存,禁止转写)

`timeline(id="E31/T1...")`

```markdown
[E31] title
    [S15069]
        [T821] 08-17 18:19 ⚖️ title
            ↳ T811, T812
        [T822] 08-17 18:20 ⚖️ title
    [S15088]
        [T21] 08-18 18:19 ⚖️ title
        [T22] 08-19 18:19 ⚖️ title
    [S15069]
        [T823] 08-20 10:19 ⚖️ title
```

`timeline(id="S15069/T1...")`

```markdown
[S15069] title
    [T821] 08-17 18:19 ⚖️ title
        ↳ T811, T812
    [T822] 08-17 18:20 ⚖️ title
```

## Pinned decisions

- **删除,不是调和。** 现状有三个 turn 渲染器,其中里程碑渲染器
  (`renderSegmentMilestoneRow`)已经与样例逐字符吻合;S 视图的 `renderTurnRow`
  与 E 视图的 `renderSegmentTurnRow` 各自多出一个 metadata 行加一个字段行,而且
  两者标签互相矛盾(一个 `- prompt:`,一个 `- content:`,喂进去的都是 prompt;
  前者的文档注释还写着 `- content:`)。两个都删,turn 视图改用里程碑那一个。
- **行标签取 title,无题时才回退 prompt。** 实测依据:压缩前窗口 40 个 turn 里
  15 个的 prompt 完全不说明发生了什么(`<task-notification>` ×6、
  `<cross-session-message>` ×4、`可以` ×2、`1 修复`、`/to-spec`、`/to-tickets`),
  而 T956/T957 两行 prompt **逐字相同**、结论相反,只有 title 能区分。回退规则与
  recall 的行标签一致,不是新机制。
- E 视图保留 `[S<n>]` 过渡行,同一会话跨段重现时按样例再次出现(见样例里
  `[S15069]` 出现两次)。
- `↳` 前驱行在两个视图都保留——样例两处都有。它此前是里程碑独有的,随渲染器合
  并自然扩及 turn 视图。
- 已有的 `⚑`(自身是纠正者)与 `[rewind]` 标记随渲染器保留,不在本票重议。
- gap 与 stats 随 metadata 行一起退出 turn 行。行内只留样例给出的时间戳。

## Out of scope

- **会话头块与尾部的 shape signals**(project/turns/types/showing/tz/raw 那几行,
  以及 fastest gap / tool bursts / compact boundary 汇总)。用户给的样例只覆盖正
  文层级,没有裁头块。**不要顺手删,也不要顺手改**;要动另开票。
- recall 的 turn 行不动:它保留 metadata 槽与 `- content:`,那是另一个面的金样
  例([S15069/T1035] 裁定),本票不得波及。
- 与 `.scratch/write-mode-edit-semantics/` 票 06 的交叉:type 在本票之后确实被渲
  染出来(作为字形),这**可能**影响那张票关于 type/tags 完整读记录的待裁事项。
  仅作交叉引用,本票不裁。

## Acceptance criteria

- [ ] 上面两段金样例作为字节夹具通过。
- [ ] 同一个 turn,`view: "turns"` 与 `view: "milestones"` 渲染出的行**逐字节相
      同**——差别只在谁被选中。
- [ ] 无题 turn 的行标签回退显示 prompt;有题时不显示 prompt。
- [ ] timeline 的任何输出里都不再出现 `- content:`、`- prompt:` 或 metadata 行。
- [ ] recall 的金样例夹具不改而绿(它的 metadata 槽与 content 行照旧)。
- [ ] 会话头块与 shape signals 逐字节不变。
- [ ] typecheck 干净;全套绿,只余既定的陈旧包守卫红。

## Ground rules

- NO git write commands。报出改动文件清单,主会话提交。
- 不碰 `~/.claude-mnemo/`、`plugin/scripts/`、版本号、`src/worker/`。
- 不要自行重建 bundle。
- 自己文件之外的瞬时红:窄范围重跑,绝不回滚工作树。
