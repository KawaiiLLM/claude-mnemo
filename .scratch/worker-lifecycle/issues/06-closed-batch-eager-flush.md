# 06 — closed batch 立即消费

**Parent:** ../spec.md

**What to build:** 不可能再合并的 batch 不再在队列白等 keepalive 或溢出——排空收尾处统一 flush 所有非尾部 batch，以及「尾部但累计尺寸已达合并阈值」的 batch；开放尾部 batch 继续等待下一个短 turn 合并（现状语义）。队列稳态只保留一个等待合并的开放 batch，且慢 LLM 调用不发生在逐 turn 的 enqueue 路径上。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] 排空收尾统一 flush：非尾部 batch 全部消费；尾部 batch 若 size ≥ 合并阈值也消费
- [ ] 开放尾部 batch（size < 阈值）保留等待合并，短 turn 合并行为与合并阈值不变，既有测试不回退
- [ ] flush 不在逐 turn 的 enqueue 路径上同步发生：突发多 turn 时，后续 turn 的入队与 obs 流式处理不被单批推理阻塞
- [ ] maxQueuedBatches 溢出保险保留；retryLater 时排空收尾的 flush 同样停在队头（不烧 attempts 热循环）
- [ ] cold session（从未 push 过）的 closed batch 不再依赖 keepalive 才被消费
