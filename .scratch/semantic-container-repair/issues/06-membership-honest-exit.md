# 06 — 归属门要有诚实出口，空转 assign 不算数

**What to build:** 三处改动同批落地，顺序不可拆：`propose` 地址下限降到 1；活动记录跟随 `added` 而非无条件记录；归属门改读 `isEligibleCoverageTurn`。

**用户裁决：** T819「允许 turn 无归属的情况」；后续确认 propose ≥1 即可、以及「按设计，skip 的 turn／非 skill 斜杠命令，是不会进入结算的」。

**三处证据：**
- `src/worker/note-settlement-membership-facade.ts:201-208` 硬性要求 ≥2 个地址，错误文案还写着「a lone homeless turn simply stays homeless」。于是只要窗口里**恰好只有一个**无家可归的 turn：assign 是撒谎、propose 结构上不可能、门永远判 `segmentation-incomplete`，三次 attempt 后转 terminal。
  > 票 10 把最小结算窗口提到 10 turn 之后，「1 个 turn 的 sessionend 窗口」这个极端例子消失，但本条不受影响——10 turn 的窗口里同样可以只有一个 turn 不属于任何挂靠段。
- `src/worker/note-settlement-membership-facade.ts:169-174` 在 apply 分支无条件调用 `recordNoteSettlementMembershipActivity`，`added` 算了却不用。对早已是成员的 turn 再 assign 一次是空转，门却过了。
- `src/db/note-settlement-completion.ts:177-187` 只查「有挂靠 + 无活动」，不查窗口里有没有合格 turn。而 `src/db/coverage.ts:95` 的 `isEligibleCoverageTurn`（spec G4）已经定义了「排除 compact 标记与无回复斜杠命令」，覆盖检查一直在用它，归属门没用。

**顺序约束（务必写进实现）：** 第二条是第一条的事实上泄压阀——只要窗口里还有已是成员的 turn，一次空转 assign 就能过门。**先修第二条而不同时给第一条出口，会把静默空转直接变成硬死锁。**

**Blocked by:** None

**Status:** ready-for-agent

- [ ] `propose` 接受单个地址
- [ ] 空转 assign（`added=false`）不再满足门
- [ ] 门在窗口无合格 turn 时放行，判据复用 `isEligibleCoverageTurn`
- [ ] 构造「1 个 turn、属于新任务、会话已挂靠」的窗口，证明它能诚实完成

> **⚠ 部分失效**：`.scratch/ownership-and-note-cadence/spec.md` 把归属与笔记重建移出结算，本票的立论已被取代，实施前先读该 spec 的 Further Notes。
