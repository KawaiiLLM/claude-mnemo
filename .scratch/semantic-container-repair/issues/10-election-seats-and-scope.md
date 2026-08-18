# 10 — 席位在小窗口归零，且窗口外晋升不受校验

**What to build:** 决定小窗口的席位规则，并让天花板校验覆盖本次运行实际写到的所有 turn。**本票含两个需要用户裁决的选项，不得由实现方自行选定。**

**用户裁决：** T818「只能在 50 turn 里选出 5 个作为 A 级、15 个作为 B 级」——这是对 50 turn 窗口的分布上限。

**偏差一：上限在小窗口变成禁令。** `src/election.ts:33` 是 `Math.floor(share * windowTurns)`，而 `src/db/note-settlement.ts:469` 允许 sessionend 窗口小到 1 个 turn（豁免 20 轮下限）。于是任何小于 10 turn 的窗口 **A 席位为 0**，小于 4 turn 时 B 也为 0——每个会话的末尾窗口永远全 C，而 tier 只在窗口内分配。这是零下限，不是上限。
> 需裁决：会话级滚动配额 / `max(1, floor(share·N))` 且设最小 N / 小窗口不参与选举。

**偏差二：窗口外晋升不受校验。** duty 1 明确授权修订在先的 turn（`src/worker/note-settlement-prompt.ts:181-187`），写入范围是窗口加 50 个先前 turn（`src/worker/note-settlement-context.ts:348-351`），而 `computeElectionCeilingViolations` 只统计 `job.windowStart..windowEnd`（`src/db/note-settlement-completion.ts:320-350`，注释 `:267-275` 自陈并搁置）。一次运行可以把任意多个先前 turn 提为 A，无任何校验。
> 需裁决：拒绝窗口外的 `tier` / 重新校验被触及的每个窗口。

**偏差三：B 档填充无裁决支撑。** T830 的原话是「里程碑只取段引用过或则等级 A 的 turn」；spec:116-117 自行加了「B-tier rows fill remaining budget in election order」。T831「timeline 装不下直接根据等级等评分过滤低分 turn」讲的是**溢出**，不是准入。实现在 `src/mcp/timeline.ts:3792-3818`。spec 自己的 Out of Scope 也写着「B-tier semantics beyond budget filler」未定。
> 需裁决：保留 B 填充（则补 spec 依据）/ 去掉 `keptB` 一段。

**Blocked by:** 01（纪元未钉值时三条都不显形）

**Status:** blocked-on-user

- [ ] 小窗口席位规则由用户裁定并落进 ADR-0003
- [ ] 天花板校验覆盖本次运行写到的全部 turn，或明确拒绝窗口外 tier
- [ ] B 档填充的去留有明确依据，spec 与实现一致
