# 01 — 重试上限 + terminal 状态

**What to build:** dream 的一天在失败两次（一次初次尝试 + 一次自动重试）后转为 `terminal`，从此不再被任何自动路径拾取——`claimNextDiaryItem` 与 `hasReadyDiaryItem` 都跳过 terminal 日，`last_error` 保留供排查。这引入 `diary_day_state` 的 `terminal` 列及其「排除于自动 claim」语义，是后续工单的基座。

**Blocked by:** None — can start immediately.

**Status:** done — `DREAM_MAX_AUTO_ATTEMPTS=2`，cap 用 SQL CASE 原子实现（`attempt_count+1 >= 上限` 时 terminal=1 + next_attempt=NULL），claim/hasReady 加 `d.terminal = 0`；`recordDreamFailure` 入参 `nextAttemptEpoch`→`retryAtEpoch`。5 项验收测试全绿，tsc 0。schema 列测试同步（schema.test.ts）。唯一红：stale-bundle guard（待 05 重打包）。

重试上限状态机（本次讨论定稿语义，非工作原型）：

```
recordDreamFailure(date, error, retryDelaySec, maxAutoAttempts = 2):
  attempt_count += 1
  needs_regen = 1
  last_error   = error
  if attempt_count >= maxAutoAttempts:
     terminal = 1
     next_attempt_epoch = NULL        # 停止自动重试，仅手动
  else:
     next_attempt_epoch = failedAt + retryDelaySec   # 唯一一次自动重试
  release queue claim (claimed_at_epoch = NULL)
```

- [ ] `diary_day_state` 有 `terminal INTEGER NOT NULL DEFAULT 0` 列；核对 live DB 已存在的同名空壳列，兼容则复用、否则用幂等 `ADD COLUMN` 迁移补上，旧行默认 0
- [ ] 首次失败后 `attempt_count = 1`、`next_attempt_epoch` 有值、`terminal = 0`
- [ ] 二次失败后 `attempt_count = 2`、`terminal = 1`、`next_attempt_epoch = NULL`
- [ ] `terminal = 1` 的日不被 `claimNextDiaryItem` 拾取、也不被 `hasReadyDiaryItem` 计入
- [ ] 上限判定在 `recordDreamFailure` 内部完成，可在 `DiaryStateStore` 缝用纯 DB 状态断言（`terminal = NULL` 的旧语义「立即可 claim」不被误用为 terminal 表达）
- [ ] 测试落在 `tests/db/diary-state.test.ts`（既有先例），断言上述状态转移与 claim 排除
