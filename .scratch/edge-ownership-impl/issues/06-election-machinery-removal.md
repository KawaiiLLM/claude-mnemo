# 06 — 选举机器拆除(存储半)

**What to build:** 评分的 db/模块层残骸清除;旧 grade 数据保留可读。

规范:`.scratch/turn-edge-mechanism/spec.md` Legacy 政策([S15069/T926])。

- election 模块、election-era 模块、turns 的 election_tier 列(纪元从未钉值,生产零 tier 数据)、结算的 grade/tier 写面删除。
- tier 读支(timeline 段视角的 tier 消费)作**死码清理**——不是渲染重设计,tier 从未在生产渲染过。
- `significance_grade` 列与旧读法**保留**——「旧纪元退出里程碑」是视图 spec 的验收,本票不碰里程碑准入。
- ADR-0003 标 superseded(正文注记,指向边 spec)。

**Blocked by:** 05(结算停写 grade/tier 后才能删存储)。

**Status:** ready-for-agent

- [ ] tier 列与 election/era 模块无任何引用残留(grep 断言进测试或报告)
- [ ] 旧 grade 的渲染字节不变
- [ ] ADR-0003 带 superseded 注记
