# 21 — 归属策略统一,新建段/lane 必须先问用户

**What to build:** 写段 tag 与写 lane tag 是同一条策略;而**没有合适的可写时,不许静默新建** —— 用 AskUserQuestion 问。

**Blocked by:** None。

**Status:** ready-for-agent

## 裁决(用户,2026-08-26)

> 归属段本质类似归属 lane,**策略一样,都是有合适的就写,没有就不写**。可以加个功能,如果没有合适的段/lane tag **可以用 AskUserQuestion 工具询问是否新建段/lane tag,不能静默新建**。结算侧补 memory policy。

## 三件事

### (a) 一条策略,不是两条

rubric 现在把段归属与 lane 归属讲成两件事。合并成一条:**tags 从当前段的 tag 与段内已声明的 lane 里选,有合适的就写,没有就留空。留空是常态,不是失败。** 段与 lane 只是同一条规则的两级词表。

- [ ] `rubric-v12-main-actions.md` 与 `rubric-v12-concepts.md` 同步改,`src/shared/memory-rubric.ts` 常量与 `.scratch` 源逐字节相等(已有测试)。

### (b) 新建必须过用户,不得静默

- [ ] 主 agent 发现**没有合适的段 tag 或 lane tag** 时,可以用 **AskUserQuestion** 问用户是否新建;**不能静默 `remember(create)` 或 `remember(declare)`**。
- [ ] 这是**行动原则**,写进主 agent 那半;工具描述同步(`create`/`declare` 的描述要说明这个前置)。
- [ ] **结算不能问**(headless)。所以结算侧的规则是:没有合适的就留空,把新建留给主 agent —— 结算仍保有 `declare`/`undeclare`/`merge` 的能力用于**已经定下的**词表维护,但不得因为「找不到合适的」而自行造词。这一条要在结算 prompt 里写明。
- [ ] 测试:一条断言主 agent 侧的教学面确实带这个前置;一条断言结算 prompt 带的是「留空」而不是「去建」。

### (c) 结算侧补 memory policy

票 12 把行动原则整块只发给主 agent,于是结算丢了读取策略,而它是会调 `recall`/`timeline` 的。

- [ ] 结算 prompt 补回 memory policy。
- [ ] **注意 peer 提过的冲突**:「只在记忆可能改变当前判断时才读」这条泛化启发式与结算「必须审完整 writable set」是抵触的 —— 补的时候要把两者的边界写清楚(读**记忆**是选择性的,审**本窗口的 writable set** 是强制的),不要照抄主 agent 那份。
