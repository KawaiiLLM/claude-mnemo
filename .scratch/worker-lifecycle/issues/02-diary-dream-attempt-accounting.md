# 02 — diary/dream 尝试计数接入分类器

**Parent:** ../spec.md

**What to build:** 瞬态网络错误不再把 dream 的一天打成 terminal——diary/dream 的失败记账经过错误分类器：连接类失败不递增 attempt 计数、不推进 terminal 判定；确定性失败维持 dream-retry-policy（一次自动重试 → terminal）的既有语义。修复 2026-07-15 型「两次 ECONNRESET → 永久卡死」。

**Blocked by:** 01 — 错误分类器 + flush 网络挂起。

**Status:** implemented

- [x] dream/diary 失败路径经分类器分流：`connection` 类不递增 attempt_count、不写 terminal，仅推迟下次尝试时刻
- [x] `deterministic` 类维持既有语义（初次 + 一次自动重试 → terminal），dream-retry-policy 既有测试不回退
- [x] 回归场景：模拟同一天两次连接类失败后网络恢复，该日仍被自动补跑完成，全程无 terminal
- [x] 手动触发 `POST /dream` 的重置语义不受影响

## Comments

- `createDreamQueueProcessor` 在失败入口调用票 01 的分类器，并把分类结果传给 `recordDreamFailure`；DB/state seam 继续拥有 attempt/terminal/retry 的完整状态机。
- `recordDreamFailure` 新增向后兼容的 `countAttempt` 选项：connection 分支保留既有 `attempt_count`、`terminal` 与 `last_error`，只设置 `needs_regen`、`next_attempt_epoch` 并释放 diary queue claim；默认/确定性分支仍执行原有 `attempt_count + 1`、第二次失败 terminal 的 SQL。
- dream idle watchdog 现在保留原错误文案并携带 `stall-watchdog` 标记，因此进入 connection 分支；总 wall-clock timeout 与未知错误仍按保守规则归为 deterministic。
- 新增同一天连续两次 `ECONNRESET`、第三次恢复成功的回归，断言两次失败均为 0 attempts / 非 terminal，随后自动 claim 并 settle。既有 deterministic retry cap 与手动 `POST /dream` terminal 重置测试均通过。
- 验证：相关定向测试 90 pass / 0 fail；`bunx tsc --noEmit` 通过；全量 `bun test` 901 pass / 1 fail，相对接受基线 900 pass / 1 fail 无回退。唯一失败仍为预期的 `tests/shared/release-artifacts.test.ts` stale-bundle guard；未重建或触碰 release 产物。
- 调用方验收加固：connection 类的 dream 重试间隔由 +60s 提高到 +15min。connection 不计次后，重试频率成为成本的唯一约束——若失败形态是「烧完 token 才被 idle watchdog 掐死」（打了 stall-watchdog 标即归 connection），60 秒节拍会把 0.4.0 的烧钱模式对 stall 形态重新打开；快失败型断网多等 15 分钟无损，dream 不紧急。deterministic 类保持 +60s。回归测试的间隔断言已同步。
