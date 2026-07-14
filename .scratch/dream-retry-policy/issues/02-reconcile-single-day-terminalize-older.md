# 02 — reconcile 只做最新一天 + 更早转 terminal

**What to build:** reconcile 不再一次性拉起最近 7 天。它只把「应做区间内最近的一天」（通常是昨天）入队；候选中所有更早的未完成日一律标 `terminal` 并删除其 pending_queue 行，当作「自动重试已失败、需手动触发」。terminal 日不进候选、不被下一次 reconcile 复活。worker 停机后回来只自动做最近一天。

**Blocked by:** 01（需要 terminal 列与其自动路径排除语义）。

**Status:** done — reconcile 先从候选剔除 terminal 日，再 `keep = sorted.slice(-maxDays)`（最近 N）、`terminalize = 其余更早日`（INSERT/UPSERT terminal=1 + next_attempt=NULL + 删 pending_queue 行）；`dreamAgentBacklogLimit` 默认 7→1。改写两个 reconcile 测试为「keep 最新/demote 更早/terminal 不复活」，config 默认测试同步。tsc 0、882 pass（仅 stale-bundle guard）。

reconcile 选择逻辑（定稿语义）：

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

- [ ] `dreamAgentBacklogLimit` 默认由 7 改为 1，语义转为「自动只做最近 N 天，更早的转 terminal」，仍作为 config 安全阀保留
- [ ] 多天候选下 reconcile 只 enqueue 最近一天；其余更早候选 `terminal = 1` 且其 pending_queue 行被删除
- [ ] 已是 `terminal = 1` 的日不进候选、不被 reconcile 复活
- [ ] `reconcileBacklog` 返回值只含实际入队的（最新）日
- [ ] 测试落在 `tests/db/diary-state.test.ts`，覆盖：单天候选、跨多天候选的 keep/terminalize 划分、terminal 日不复活
