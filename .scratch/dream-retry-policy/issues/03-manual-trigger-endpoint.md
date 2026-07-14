# 03 — 手动触发端点 `POST /dream {date}`

**What to build:** 运营者能通过 worker 的 `POST /dream`（body `{ "date": "YYYY-MM-DD" }`）手动重跑任意一天的 dream——terminal 或历史日靠它补做。触发把该日重置为可做状态并重新入队，随后触发一次 tick 让 worker 尽快拾取；非法日期返回明确的 4xx。

**Blocked by:** 01（需要 terminal 列；重置必须清掉 01 里 cap 设置的 terminal 标记）。

**Status:** done — `POST /dream {date}` 端点：格式/真实日/未来日/早于 cutover 校验 → 400，合法 → `markDayStaleAndEnqueue` + `scheduleDiaryContinuation` + 200 `{enqueued}`。逻辑放在 `createWorkerCore.triggerManualDream`（有 now/config/diaryStateStore/tick 作用域），经 `WorkerCore` 接口暴露、handler 用注入 dep `handleDreamImpl` 调用（镜像 handleFlushImpl）。`markDayStale` 补清 `terminal=0`。server.test 加 HTTP 映射 + triggerManualDream 逻辑两测。tsc 0、884 pass（仅 stale-bundle guard）。

- [ ] `POST /dream` 接受 `{ "date": "YYYY-MM-DD" }`，只接受日期、不接受任何路径
- [ ] 校验：格式合法、`date < today`、`date >= cutover_date`；不合法返回 4xx（格式错误/未来日/早于 cutover），合法返回 `200 { "enqueued": "<date>" }`
- [ ] 触发把该日重置为可做：`needs_regen = 1, attempt_count = 0, next_attempt_epoch = NULL, terminal = 0, last_error = NULL`，随后 enqueue
- [ ] `markDayStale` 补上清 `terminal = 0`（当前不清），使重置后的日重新获得两次自动尝试
- [ ] 触发后 worker 会尽快拾取（复用既有 flush/tick 机制）
- [ ] 测试落在 `tests/worker/server.test.ts`（既有先例），断言合法日 200 + 状态重置与入队、非法日 4xx
