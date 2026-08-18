# 10 — 最小结算窗口、两级分布、跨窗口总分布

**What to build:** 按 T868 的三条裁决重做席位与校验范围。

## 裁决一：小窗口不结算，最小结算窗口 10 turn

**用户原话（T868）：** 「小窗口不需要结算，限制最小结算窗口为 10 turn」。

现状：`src/db/note-settlement.ts:469` 让 `sessionend` 的余数窗口下限为 **1**（豁免 `minWindowTurns`）。于是任何小于 10 turn 的窗口 A 席位为 `floor(10%·N)=0`，末尾窗口永远全 C。

**⚠ 这条与一条更早的裁决冲突，需要你确认覆盖范围。** `sessionend` 的豁免正是 T570 定的，理由记在 spec D7：「a session may end after a single turn, and without the exemption the tail would never be settled at all」。而结算窗口同时承担**两项职责**：笔记覆盖（每个 turn 都要有笔记）与选举。把下限提到 10 会让两项一起停——不足 10 turn 就结束的会话，其尾部 turn 连笔记都不再补。

> 两个选项：(a) 下限对两项职责一律生效，接受短会话尾部不留笔记；(b) 下限只约束选举，窗口仍照旧结算笔记，只是不评级。**实现方不得自行选定。**

## 裁决二：分布分两级，超上限拒绝 commit

**用户原话（T868）：** 「A B 分布指导为 10% 20%，上限为 20% 40%，超出上限拒绝 commit」。

现状：`src/election.ts:33` 只有单级 `floor(share·N)`，A=10%/B=30%，且被当作硬上限。

改为：
- **指导值** A 10%、B 20% —— 告知模型的目标，不校验；
- **硬上限** A 20%、B 40% —— 在 commit 处校验，超出即拒绝并报出算术，**仍然只拒不降**（这条既有行为正确，保留）。

注意 B 的指导值从 30% 降到 20%。最小窗口 10 turn 时，上限给出 2 个 A、4 个 B 席位，不再有零席位窗口。

## 裁决三：先前 turn 合法，按总分布校验

**用户原话（T868）：** 「对先前 turn 的修改也是合法的，分布看待结算+先前的总分布」。

现状：duty 1 授权修订在先的 turn（`src/worker/note-settlement-prompt.ts:181-187`），写入范围是窗口加 50 个先前 turn（`src/worker/note-settlement-context.ts:348-351`），但 `computeElectionCeilingViolations` 只统计 `job.windowStart..windowEnd`（`src/db/note-settlement-completion.ts:320-350`）。一次运行可把任意多先前 turn 提为 A 而不受校验。

**实现方按此理解落地，若与本意不符请在实现前纠正：** 校验范围 = 本窗口 ∪ 本次运行实际写到的窗口外 turn；分母 N 取该并集的 turn 总数，计数取该并集内的 A/B 数（含这些 turn 原有的档位）。未被本次运行触及的先前 turn 不进分母。

**Blocked by:** 01（纪元未钉值时三条都不显形）

**Status:** ready-for-agent（裁决一的覆盖范围待用户确认）

- [ ] 最小结算窗口 10 turn，`sessionend` 余数不再豁免
- [ ] 指导值 10%/20% 出现在结算提示里，不参与校验
- [ ] 硬上限 20%/40% 在 commit 处校验，超出拒绝并报出算术，不做机械降级
- [ ] 校验范围覆盖本次运行写到的全部 turn，而非仅窗口内
- [ ] 10 turn 窗口能选出至少 1 个 A，不再出现零席位窗口

> **⚠ 已失效**：席位、上限、分布校验、纪元范围全是评分机制的配套，`.scratch/turn-edge-mechanism/spec.md` 取消评分后本票无对象。
