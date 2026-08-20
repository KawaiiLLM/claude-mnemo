# 02 — 长度随产出,结论先行

**What to build:** 写笔记的 agent 读到一条明确原则:**笔记长度跟着这一轮的实际
产出走,不跟着花的力气走**;并且 `content` 必须结论先行,因为尾巴会被读者的预算
切掉。

**Ruling base:** [S15069/T1085]。

**Blocked by:** none。field-semantics 01 已落地(`22b6261`),本票是在它建好的
`## Fields` 块上追加。

**Status:** ready-for-agent

## 为什么需要这一条

票 01 把 `content` 定成「必须含这一轮产生的**所有有用决策**」,同轮又把 2× 硬拒
换成 1.5× 提醒。两条叠在一起很容易被读成「写得越长越安全」。本票是那条的**对
重**:完整性只约束**决策**,不约束过程。

`结论先行` 不是文风建议,是**机制承诺**:它决定截断发生时丢掉的是支撑而不是裁
决。

## Pinned decisions

- 下面这段**逐字使用,一个字都不要改**。有异议回来报告,不要「改进」。

```
Length tracks OUTPUT, not effort. A turn that produced nothing is a skip; one
that produced a lot may run long; one that produced little must be terse.
Process detail belongs to replay — a summary cannot hold it, and trying makes
it hold nothing. Content leads with its conclusions: a reader's budget cuts
the tail, so whatever merely supports a decision comes after the decision.
```

- **落点两处**,沿用票 01 已建立的分层:
  1. 注入的 rubric `## Fields` 块——接在三个 turn 字段的定义之后,段字段之前。
  2. `note` 工具的 `title` 与 `content` 两条 describe——按各自视角落到位,不是
     整段照抄两遍(title 那条只需要「长度随产出」的一半;结论先行属于
     content)。
- **不要动 1.5× 提醒的阈值或措辞**——那是票 01 刚定的,本票只加原则,不改机制。
- **不要动 `skip` 的判定逻辑。** 「无产出即 skip」是写作原则,skip 的既有判据
  (工具描述里那条「删掉它是否损失决策、进展或连贯性」)不变。
- 注入体积再报一次数:票 01 之后是 3343 字符 / 上限 9500。本票加完给出新数与余
  量。

## Acceptance criteria

- [ ] rubric `## Fields` 块含上面那段,逐字一致,位置在 turn 字段之后、段字段之
      前。
- [ ] `note` 的 `title` describe 含「长度随产出」的相应半边。
- [ ] `note` 的 `content` describe 同时含「长度随产出」与「结论先行」。
- [ ] 1.5× 提醒的阈值、触发条件与措辞逐字节不变(既有测试不改而绿)。
- [ ] `skip` 的既有判据文字不变。
- [ ] 报告给出注入块新的字节数与上限余量。
- [ ] typecheck 干净;全套绿,只余既定的陈旧包守卫红。

## Ground rules

- NO git write commands。报出改动文件清单,主会话提交。
- 不碰 `~/.claude-mnemo/`、`plugin/scripts/`、版本号、`src/worker/`。
- **不碰 `src/mcp/timeline.ts`**——另一张票的 worker 正在其中。
- 不要自行重建 bundle。
