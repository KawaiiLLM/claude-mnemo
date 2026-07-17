# 01 — 错误分类器 + flush 网络挂起

**Parent:** ../spec.md

**What to build:** 断网时 mini-turn flush 不再把提取烧成 dropped——连接类错误让该 session 的工作释放回队列挂起（不消耗重试预算），网络恢复后任意 session 的 turn-stop 排空自动继续；确定性错误维持现行 3 次 → dropped + reminder。核心是一个新的错误分类器纯函数模块，作为后续 diary/dream 计数（02）与 SessionEnd 收尾（04）的公共依赖。

**Blocked by:** None — can start immediately.

**Status:** implemented

- [x] 分类器纯函数：SDK 连接错误（APIConnectionError）、Node 错误码（ECONNRESET / ENOTFOUND / ETIMEDOUT / EAI_AGAIN）、fetch failed、打标的 stall / shutdown 中断 → `connection`；API 状态错误、derailment floor、无法识别的错误 → `deterministic`（保守归类）
- [x] stall-watchdog 中断在抛出处打标，分类器可识别为 `connection`
- [x] flush 遇 `connection` 类：批次 attempts 不递增，该 session 全部批次的队列 claims 释放、内存批次清空、query session 关闭（per-session 崩溃恢复语义）；不产生 delivery-dropped tag
- [x] `deterministic` 类维持现行 retryLater / dropped 状态机，既有 flush-retry 测试不回退
- [x] 挂起的 session 记录轻量退避时刻，退避期内的 wake 不对该 session 重试
- [x] 注入「先连接失败、后成功」的推送：恢复后的全局排空重新认领并成功提取，无任何 turn 丢失

## Comments

- 新增纯函数错误分类器；由于 claude-agent-sdk 不导出其内部错误类，SDK 连接错误按稳定的 `name` / `constructor.name` 识别，并递归检查 `cause`。带 HTTP `status` 的 API 错误优先归为 deterministic，未知错误保守归为 deterministic。
- mini-turn flush 遇 connection 错误时执行 session 级恢复：释放该 session 的全部 claims、丢弃 buffer/batch/streaming 内存状态、关闭 query session，并记录 10 秒退避；退避到期后的任意全局 drain 可重新认领。deterministic 的 retryLater → dropped 路径未改。
- watchdog 关闭现在携带 `stall-watchdog` 标记；query-session 会用该标记拒绝在途 prompt，使 flush 进入 connection suspension。shutdown 标记由同一分类器支持，留给后续生命周期票接线。
- 验证：定向 worker 测试 89 pass / 0 fail；`bunx tsc --noEmit` 通过。全量 `bun test` 为 900 pass / 1 fail（基线 896 / 0）：唯一失败是 `tests/shared/release-artifacts.test.ts` 的 stale-bundle guard，因源码已变化而 `plugin/scripts/worker.cjs` 按明确禁令未重建。未削弱该 guard，也未触碰任何 release 产物。
