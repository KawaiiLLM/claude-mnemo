# 06 — closed batch 立即消费

**Parent:** ../spec.md

**What to build:** 不可能再合并的 batch 不再在队列白等 keepalive 或溢出——排空收尾处统一 flush 所有非尾部 batch，以及「尾部但累计尺寸已达合并阈值」的 batch；开放尾部 batch 继续等待下一个短 turn 合并（现状语义）。队列稳态只保留一个等待合并的开放 batch，且慢 LLM 调用不发生在逐 turn 的 enqueue 路径上。

**Blocked by:** None — can start immediately.

**Status:** implemented

- [x] 排空收尾统一 flush：非尾部 batch 全部消费；尾部 batch 若 size ≥ 合并阈值也消费
- [x] 开放尾部 batch（size < 阈值）保留等待合并，短 turn 合并行为与合并阈值不变，既有测试不回退
- [x] flush 不在逐 turn 的 enqueue 路径上同步发生：突发多 turn 时，后续 turn 的入队与 obs 流式处理不被单批推理阻塞
- [x] maxQueuedBatches 溢出保险保留；retryLater 时排空收尾的 flush 同样停在队头（不烧 attempts 热循环）
- [x] cold session（从未 push 过）的 closed batch 不再依赖 keepalive 才被消费

## Comments

- 在 `drainQueue` 无更多可 claim 项时增加统一 tail policy：FIFO 消费所有非尾部 batch；队列只剩一个 batch 时，仅在 `size >= mergeThresholdChars` 或超过 `maxQueuedBatches` 保险线时继续消费。成功稳态因此至多保留一个小于阈值的开放尾批。
- 从 `processTurnStopLocked` 移除了同步 overflow push；普通 short/final turn 只负责构建并入队，整波 queue 的后续 turn 与未越过 streaming 阈值的 obs 会先完成 claim/buffer，再在排空收尾进入慢 query。`maxQueuedBatches` 未删除，而是由同一 tail policy 在排空边界执行，测试用 `maxQueuedBatches=0` 覆盖开放尾批的保险 flush。
- streaming mid-slice 的既有即时推送语义保持不变：它是单 turn 尺寸预算/渐进提取路径，不属于本票新增的 closed-batch eager flush。普通 obs 若尚未形成 streaming slice，不会为了检查一个无需消费的开放尾批而等待 session processing lock。
- eager tail 复用票 01 的 `flushOneBatchLocked` 状态机：`retryLater` 只尝试一次并停在 FIFO 队头，后续 batch 与 claims 保留；`suspended` 立即清空内存批次、释放该 session 全部 claims 并在轻量退避内跳过后续 drain，不产生热循环或 dropped。
- `finishSession`/compact 的全量 `flushAllBatchesLocked` 语义未改；compacting session 会跳过通用 tail policy，由 compact 自己的有界全量 drain 负责，避免并发全局排空排队或认领其工作。
- 新增 cold session 非尾批/开放尾批、达阈值尾批、burst 先完整入队、overflow 保险、retryLater 队头停止、connection suspend 六组回归；同步更新旧 overflow/keepalive/re-prime 测试，使其分别显式使用 full tail 或开放 tail 场景，短 turn 合并与 keepalive 仍有覆盖。
- 验证：`bun run typecheck` 通过；相关 server 回归 94 pass / 0 fail；全量 `bun test` 919 pass / 1 fail，相对接受基线 913 pass / 1 fail 无回退。唯一失败仍为预期的 `tests/shared/release-artifacts.test.ts` stale-bundle guard；未重建或触碰 release 产物。
