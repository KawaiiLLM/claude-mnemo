# 05 — 全 agent 关闭即停 worker + dream 中断护栏

**Parent:** ../spec.md

**What to build:** 最后一个记忆 agent 关闭后 worker 立即退出，建立不变量「CC 关闭约 1 分钟后零残留 Claude 请求」。退出判定四守卫：无存活 query session、无全局排空在途、无 HTTP 请求在途、dream 未在跑或已按护栏中断。dream 若在跑则中断且不计尝试次数——「恰好在补跑时关 CC」不得累积成 terminal。30 分钟空闲定时器保留为崩溃路径兜底；新 turn 入队时既有懒启动自动拉起。

**Blocked by:** 02 — diary/dream 尝试计数接入分类器；04 — SessionEnd 60 秒收尾 + 立即关闭记忆 agent。

**Status:** implemented

- [x] 退出判定同时满足四守卫才触发既有优雅退出（pid 文件清理等语义不变）；「无全局排空在途」为硬守卫（/flush 是 fire-and-forget，HTTP 计数早已归零）
- [x] dream 在跑时被中断：attempt_count 不变、next_attempt_epoch 重置为立即可做、staging 半成品无任何提交残留（staged-commit 原子性）
- [x] 被中断的 dream 在下一次 turn-stop 排空的 reconcile / 继续调度中自动补跑
- [x] 30 分钟空闲兜底保留：SessionEnd 未触发（崩溃、强杀）时 worker 仍会退出
- [x] 端到端形态：最后一个 session 正常结束 → 约 1 分钟内 worker 进程退出；随后新 turn 入队 → worker 与对应记忆 agent 按需拉起并正常提取

## Comments

- 新增最后 agent 生命周期判定：10 秒 watchdog tick 先检查存活 query session、后台排空屏障、HTTP 在途与 dream 状态，四守卫最终同时满足后复用既有 `createShutdownCleanup`，因此 server stop、pid 文件清理与退出码语义不变；原 30 分钟 HTTP idle 检查仍作为同一 tick 的兜底路径保留。
- `createWorkerFetchHandler` 现在把 `/wake`、`/flush` 与 `/compact` 的 fire-and-forget 工作聚合进 `globalScanInFlight` 生命周期屏障；并保留独立 wake 合并状态，故并发 wake 的既有全局排空/遗留积压语义不变。worker-down 的 startup flush 也经同一 handler 发起，关闭了“HTTP 已归零但 SessionEnd tail 尚在跑”的退出竞态。
- dream runner/runtime 新增受管的运行态与 shutdown abort：活跃请求以票 01 的 `shutdown` 标记中断；若 shutdown 落在 staging 播种与 query 启动之间，则预置中断会阻止下一条 Claude 请求启动。runtime 等待整个 dream job 的 `finally` 与队列记账完成后才放行退出。
- shutdown 标记在 dream queue 中单独映射为 0 秒推迟：沿用 connection 分支的不计 attempt、不推进 terminal、不改 `last_error`，仅把 `next_attempt_epoch` 设为当前时刻并释放 claim。普通 connection 失败仍保持票 02 加固后的 +15 分钟语义，deterministic 仍为 +60 秒及两次后 terminal。
- staged-commit 未改写：中断发生在 commit 前时，`dream-job` 既有 `finally` 删除 `.dream-staging/<date>`，线上 success marker 与记忆文件不变；测试随后以一次新的全局 drain 重新认领同一天并成功 settle，覆盖下次 turn-stop wake 的自动补跑形态。
- 回归覆盖：四守卫逐项阻止退出、运行中 dream 中断后等待全局排空再退出、fire-and-forget `/flush` 硬守卫、真实 `main` 的 SessionEnd tail 关闭最后 agent 后在下一生命周期 tick 停 server/退出，以及既有 `notifyWorkerWake` worker-down 懒启动测试。生命周期 tick 为 10 秒，因此加上票 04 默认 60 秒 tail，正常关闭上界约 70 秒。
- 验证：`bun run typecheck` 通过；定向回归 103 pass / 0 fail；全量 `bun test` 913 pass / 1 fail，相对接受基线 908 pass / 1 fail 无回退。唯一失败仍是预期的 `tests/shared/release-artifacts.test.ts` stale-bundle guard；未重建或触碰 release 产物。
