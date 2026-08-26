# 04 — 范围来源投影(前置重构)

**What to build:** 「这条发现来自哪里」这个事实被保留到渲染点。今天它在两处被**故意**丢弃,
于是 06 的「只报可修的」和 07 的三分区都无从谈起。

对应 spec:D0。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] 三个**冻结、互斥**的 id 集合穿过请求:`window` / `base-lookback` / `closure-only`
- [ ] 优先级 `window > base-lookback > closure-only`——一个回看内的 turn 同时是某条边的
      外部端点时,只落一格
- [ ] 断言三集合互斥,且并集等于今天那个扁平集合
- [ ] 注释写明这**不推翻**既有的折叠裁决:折叠说的是「三段同等可写」,这里说的是
      「错误来自哪」,是另一个维度
- [ ] 突变:让两个集合重叠,必须有测试变红
