# 19 — 收敛只看弧尾

**What to build:** 一条 `index` 宣告哪条 lane 收敛,**只由弧尾侧的 lane tag 决定**,与它指向谁无关。

**Blocked by:** None。

**Status:** done — landed, not released

## 裁决(用户,2026-08-26)

> 弧尾是主体、引用者。**所有边都应视为弧尾侧节点运用弧头侧节点。** 收尾 index 不考虑它指向的是不是自己 lane 的节点,只看弧尾侧 lane tag 是谁,就代表哪个 lane 宣告收敛。

这同时确立了一条更一般的读法:**每条边都读作「弧尾用弧头」**。收敛是弧尾单方面的宣告。

## 三个谓词必须分开(现在被合并成了一个)

| 谓词 | 定义 | 只决定 |
|---|---|---|
| `internal(e,L)` | 两侧 LaneKey 都 = L | 内部连通、chain、target 是否 L 的 internal core |
| `closes(e,L)` | `relation=index` **且弧尾 LaneKey = L** | 哪条 lane 宣告收敛 —— **弧头不参与** |
| `coreTarget(e,L)` | = `internal(e,L)` | |

现在 `laneMembershipClaims` 正确实现了第一个,却被归约循环复用来实现第二个。后果:同段 `A→B` 的 index 与跨段同名 tag 的 index **都不关闭弧尾那条 lane**,于是「我这条线收工,成果并进主线」这个最自然的收尾姿势直接失效,tier②/checker/card 一起漏掉那个终点。

- [x] index 事件改为**从 settled 弧尾的 `(citing segment, tailTag)` 入队**,与弧头无关。
- [x] **internal grouping 不动** —— 连通性仍要求两侧同为该 lane。跨段的 index 同样:不建立连通、不把 target 算 core,**但关闭弧尾侧自己的 lane**。
- [x] 替换 `tests/shared/lane-interpretation.test.ts:519-530` 的「两边都不关」断言;补一条同段 `A→B` 用例(A closed、B 无 terminus、A 的连通性不含这条边)。
- [x] election / checker / card 各补一条消费同一 projection 的钉桩。
- [x] **把结论写回 normative `rubric-v12-concepts.md`** —— 现行文本只写「通过 index 宣告收敛」,没说哪一侧,所以「一个属于多条 lane 的节点,它的一条 index 关闭哪条」原本没有权威答案。`src/shared/memory-rubric.ts` 的常量与 `.scratch` 源文件必须同步(有逐字节相等测试)。
- [x] 突变验证:改回「两侧都要同意」必须让点名的测试变红。
