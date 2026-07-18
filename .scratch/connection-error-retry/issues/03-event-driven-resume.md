# 03 — 挂起会话「入队即重试」

**What to build:** 因连接错误被挂起的会话，在**下一个 turn-stop 入队**时即解除挂起并重试一次——网络一恢复，活跃会话的下一个 turn 就带着把积压追平，无需等一个固定的时间退避、也无需人工介入。每次入队恰好触发一次尝试（天然按 turn 节奏限速：无紧循环、不烧确定性 attempt）。

**Blocked by:** 01（需要连接错误确实 suspend+释放，才有东西可恢复）。

**Status:** implemented

## 设计要点（见 ../spec.md 「Implementation Decisions §4」）

- 现状：`suspendedUntilBySession` 是固定时间退避（`CONNECTION_RETRY_BACKOFF_MS`），`drainQueue` 每次先删到期挂起项。
- **决定：新 turn-stop 入队即解除该会话挂起并驱动一次重试。** 时间退避可保留为**空闲会话的兜底下限**，但活跃会话的恢复主路径改为事件驱动。
- 语义：连接错误 → 释放 claim + 会话待触发；下一个 turn-stop 的 scan 重新认领被释放项、重跑一次；再失败则再释放、再等下一个触发。

## 关键文件

- `src/worker/server.ts` — `suspendedUntilBySession` 的解挂起时机、`drainQueue` 的挂起过滤、turn-stop 入队路径
- `tests/worker/server.test.ts` — 队列入队 + drain 断言的先例

## Acceptance criteria

- [x] 会话因连接错误挂起后，注入一个新的 turn-stop 入队 → 下一次 drain 解除挂起、重新认领被释放项并重试一次；mock agent 这次成功 → 涉及 turn 变 `extracted`。
- [x] 空闲（无新入队）时，挂起仍受时间退避兜底解除（不永久挂起）。
- [x] 每次入队只触发一次尝试，不出现紧循环重试。
- [x] `bunx tsc --noEmit` 通过；`bun test` 相对基线不回退。

## 约束

- 不执行任何 git 命令；只编辑文件。
- 不做版本号变更、不重建 `plugin/scripts/*.cjs`（stale-bundle 守卫 1 fail 是预期基线）。
- 不触碰 `~/.claude-mnemo` 下的任何线上数据。

## Comments

- suspend 状态现同时记录退避到期时间与挂起时最新 turn-stop queue seq；后续扫描发现更大 seq 时立即解挂起。
- 再次连接失败会用当前最新 seq 重建门槛，因此同一入队事件只触发一次尝试；固定时间退避仍保留为空闲兜底。
- 验证：`bunx tsc --noEmit` 通过；`bun test` 为 964 pass / 1 fail，唯一失败仍是预期的 stale-bundle guard。
