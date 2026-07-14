# Spec: Dream retry cap, single-day backfill & manual trigger

**Status:** ready-for-agent

## Problem Statement

自 0.4.0 起，dream agent 的调度存在两个会烧钱且会误导的缺陷：

1. **无重试上限，永久重试。** 一个 dream 失败后，`recordDreamFailure` 只把 `next_attempt_epoch` 设为「失败时刻 + 60 秒」，永远 60 秒一轮重试，没有任何 terminal 判定（0.4.0 删旧 persona 机制时把 terminal 逻辑一起删掉了，`diary_day_state.terminal` 在 live DB 里是从不写入的空壳）。观察到的后果：2026-06-28 与 2026-06-29 两天各被重试 4 次、全部在 commit 前被 idle watchdog 掐死、无一成功，一天空烧约 $19，且会持续烧下去。

2. **每次 SessionStart 都自动补算最近 7 天。** `reconcileBacklog(maxDays = dreamAgentBacklogLimit = 7)` 会把最多 7 天未完成日一次性入队。worker 停机后回来、或某几天卡住时，它会反复把整周 backlog 拉起来重跑，放大了缺陷 1 的空烧，也让「哪天真需要重做」淹没在批量里。

底层根因（连带）：dream 之所以 commit 不了，是 **120s 的 idle watchdog** 太紧——opus 的静默推理一段就能到 286 秒。ticket 09 抬高的是 request timeout（30 分钟），管不到 idle watchdog，所以失败模式没被修掉。

## Solution

从用户视角，dream 调度改为「克制自动、显式手动」：

- **最多自动重试一次。** 一天失败后自动重试一次；再失败即转为 `terminal`（仅手动），停止一切自动重试与自动补算，`last_error` 保留供排查。
- **冷启动/日常只做最近一个未完成日。** reconcile 只把「应做范围内最新的那一天」（通常是昨天）入队；所有更早的未完成日一律标 terminal，当作「自动重试已失败、需手动触发」，不再自动拉起。
- **新增手动触发入口。** worker 暴露 `POST /dream {date}`，把指定日重置为可做状态（清 terminal、attempt 计数归零、重新入队），terminal 的日子靠它重跑。
- **放宽 idle watchdog 并入 config。** 把 idle watchdog 从写死的 120 秒改为可配置、默认放宽（如 10 分钟），让 dream 真的能跑到 commit——否则重试上限只是「更快地放弃一件永远做不成的事」。

## User Stories

1. 作为系统运营者，我希望一天的 dream 失败后最多自动重试一次，这样一个卡死的日子不会无限重试、无限烧 token。
2. 作为系统运营者，我希望重试两次都失败的日子被标记为 terminal 并停止自动重试，这样我能从 `last_error` 看到它为什么失败、由我决定是否重跑。
3. 作为系统运营者，我希望 terminal 的日子不再被任何自动路径（claim、reconcile）拉起，这样它彻底安静直到我手动触发。
4. 作为系统运营者，我希望 worker 冷启动后只自动做最近一个未完成日，而不是把最近 7 天全部拉起，这样停机后回来不会引发一轮批量空烧。
5. 作为系统运营者，我希望日常每晚也只自动做「昨天」这一天，这样稳态调度是可预测的单日推进。
6. 作为系统运营者，我希望 reconcile 在只入队最新一天的同时，把更早的未完成日全部标 terminal，这样 backlog 不会悄悄堆积、也不会被下一次 reconcile 重新拉起。
7. 作为系统运营者，我希望能通过 `POST /dream {date}` 手动触发任意一天的 dream，这样我能按需补做被标 terminal 的历史日。
8. 作为系统运营者，我希望手动触发会把该日的 attempt 计数归零、清掉 terminal 标记，这样它获得两次全新的自动尝试机会（一次初次 + 一次重试）。
9. 作为系统运营者，我希望手动触发对非法日期（格式错误、未来日、早于 cutover）返回明确的 4xx 错误，这样我不会误触发一个无意义的日子。
10. 作为系统运营者，我希望 idle watchdog 的时长可通过 config 调整、默认放宽到分钟级，这样 opus 的长段静默推理不会在 commit 前把 dream 掐死。
11. 作为系统运营者，我希望 idle watchdog 的 config 值有合理的上下限钳制，这样一个手滑的配置不会把 watchdog 设成 0 或无穷。
12. 作为系统运营者，我希望已经卡在无限重试里的 6/28、6/29（及其它 needs_regen 历史日）在升级后被自然收敛为 terminal，这样部署本身就止住当前的空烧。
13. 作为开发者，我希望重试上限、terminal 排除、reconcile 单日策略都能在 `DiaryStateStore` 这一层用纯 DB 状态断言测试，这样不必启动真实 agent 就能验证调度语义。
14. 作为开发者，我希望手动触发端点能在 worker server 测试里用 HTTP 请求验证，这样端点契约有回归保护。
15. 作为运营者，我希望 dream 的稳态成本回到「每晚约一次、约 $2.4」，而不是一天 8 次的失败重试。

## Implementation Decisions

**模块与改动落点（三条测试缝）**

- `DiaryStateStore`（`src/db/diary-state.ts`）：承载绝大部分行为，单一高缝。
- worker HTTP server（`src/worker/server.ts`）：新增手动触发端点。
- config（`src/shared/config.ts`）+ diary agent runner（`src/worker/diary-agent-runner.ts`）：idle watchdog 可配置化。

**Schema**

- `diary_day_state` 增加 `terminal INTEGER NOT NULL DEFAULT 0` 列（当前 src schema 无此列；live DB 存在一个从不写入的同名空壳列，实现时需核对：若存在且类型兼容则复用，否则用幂等的 `ADD COLUMN` 迁移补上）。语义：`1` = 仅手动，排除于所有自动路径。

**重试上限状态机**（源自本次讨论的定稿语义，非工作原型）

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

- `maxAutoAttempts = 2` 表示「一次初次 + 一次自动重试」；上限判定放在 `recordDreamFailure` 内部，使其在 `DiaryStateStore` 缝可测。
- `next_attempt_epoch = NULL` 原语义是「立即可 claim」，因此 terminal 不能只靠 NULL 表达——必须由 `terminal = 1` 列 + claim 侧过滤共同实现。

**claim 侧过滤**

- `claimNextDiaryItem` 与 `hasReadyDiaryItem` 的查询增加 `AND d.terminal = 0`，terminal 日永不被自动 claim。

**reconcile 单日 + terminal 更早**

```
候选 = (应做区间 lastSuccessful+1 .. today-1) ∪ (needs_regen 且 < today 的日)
       并排除 terminal = 1 的日
候选按日期升序
keep         = 候选的最近 N 天  (N = dreamAgentBacklogLimit, 默认改为 1)
terminalize  = 候选中其余更早的日
for keep:        enqueueDay
for terminalize: set terminal = 1, next_attempt_epoch = NULL, 删除其 pending_queue 行
return keep
```

- `dreamAgentBacklogLimit` 默认由 7 改为 1，语义从「补算最近 N 天」转为「自动只做最近 N 天，更早的转 terminal」。保留为 config 以留安全阀。
- terminal 日不进候选，reconcile 不会复活它们。

**手动触发端点**

- `POST /dream`，body `{ "date": "YYYY-MM-DD" }`。
- 校验：格式合法、`date < today`、`date >= cutover_date`；不合法返回 4xx（`400` 格式错误 / 未来日；`422` 或 `400` 早于 cutover），成功 `200 { "enqueued": "<date>" }`。
- 行为：把该日重置为可做——`needs_regen = 1, attempt_count = 0, next_attempt_epoch = NULL, terminal = 0, last_error = NULL`，随后 enqueue，并触发一次 flush/tick 让 worker 尽快拾取。
- 复用/扩展 `markDayStaleAndEnqueue`：其内部 `markDayStale` 需同时把 `terminal` 清 0（当前不清）。

**idle watchdog 可配置**

- config 新增 `dreamAgentIdleWatchdogMs`，默认放宽（建议 `600_000`），clamp 合理区间（建议 `30_000 .. 3_600_000`），与既有 `dreamAgentTimeoutMs`（request，30 分钟）并列。
- `diary-agent-runner` 的 `watchdogMs` 从写死 `120_000` 改为「显式入参优先，否则取 config 默认」；loadConfig 值经 runtime 一路传入。
- 约束：idle watchdog 应小于 request timeout（10 分钟 < 30 分钟）。
- 备注（非本 spec 硬性）：若放宽后仍偶发超长单段生成，后续可在 curate 提示词层引导「分步写入 vs 一次性交超大 commit payload」，但不在本次范围内强制。

**版本与发布**

- 属行为变更，收尾做一次版本 bump（patch，`0.4.1`），按既有 7 处 bump 清单同步并 `bun run build` 重打包。

## Testing Decisions

好的测试只断言外部可观测行为（DB 状态、HTTP 响应），不耦合实现细节。

- **`DiaryStateStore`（缝 1，主）** — 先例 `tests/db/diary-state.test.ts`。用内存/临时 DB 直接断言状态转移：
  - 首次失败 → `attempt_count = 1`、`next_attempt_epoch` 有值、`terminal = 0`。
  - 二次失败 → `attempt_count = 2`、`terminal = 1`、`next_attempt_epoch = NULL`。
  - terminal 日不被 `claimNextDiaryItem` / `hasReadyDiaryItem` 拾取。
  - reconcile：多天候选下只 enqueue 最新一天，其余更早日 `terminal = 1` 且其 pending_queue 行被删；terminal 日不被 reconcile 复活。
  - markDayStale/手动重置把 `terminal` 清 0、`attempt_count` 归零。
- **worker server（缝 2）** — 先例 `tests/worker/server.test.ts`、`server.flush-retry.test.ts`。用 HTTP 请求断言 `POST /dream`：合法日 `200` + 入队与状态重置；非法日 4xx；断言不越权（不接受路径、只接受日期）。
- **config（缝 3）** — 先例 `tests/shared/config.test.ts`。断言 `dreamAgentIdleWatchdogMs` 默认值与 clamp 边界；`diary-agent-runner` 接受显式 `watchdogMs` 覆盖（先例 `tests/worker/diary-agent-runner.test.ts`、`diary-sdk-query.test.ts` 已传 `watchdogMs`）。
- **release-artifacts** — 版本 bump 后 `tests/shared/release-artifacts.test.ts` 的版本断言随之更新。

不做的测试：不用真实 SDK/agent 跑端到端验证 watchdog 计时（计时器行为脆弱），只验证 config 值与入参传递这一可观测契约。

## Out of Scope

- **curate 提示词/画像质量**（画像退化回项目清单反模式）——独立问题，另开。
- **commit payload 分步写入**以彻底根治超长单段生成——本次只放宽 watchdog，不改 commit 交付方式。
- **CLI 命令**：本次只做 HTTP 端点；如需 `dream --date` CLI，可作为薄封装另议（可先用 `curl` 打端点）。
- **remember/session-summary agent 的失控大 run**（单次 450–500 轮、千万级 cache read）——与 dream 无关，另查。
- **对 terminal 日的 UI/注入提示**（让用户知道有多少天待手动触发）——可后续加。

## Further Notes

- 部署后收敛路径：升级 + worker 冷重启 → 下一次 reconcile 把 6/28、6/29、7/10、7/13 等历史 needs_regen 日收敛为 terminal（因为都比最新应做日更早）→ 当前无限重试的空烧自然止住；放宽后的 watchdog 让手动触发能真正跑到 commit。
- worker singleton 版本盲：0.4.1 需冷重启全部会话才生效（同 0.3.3/0.4.0 的老坑）。
- 下一步：`/to-tickets` 拆成竖切工单，交由 codex 实现。
