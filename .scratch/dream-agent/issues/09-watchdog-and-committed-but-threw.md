# 09 — Dream agent 看门狗调高＋committed-but-threw 一致性

**What to build:** 修复冒烟缺口 3——dream agent 请求在 600000ms（10 分钟）看门狗超时，但 commit 其实已成功（last-successful marker＋history 快照＋文档都已落盘）。dream agent 比旧日记 agent 干得多（读全天素材＋多轮 recall/Grep＋curate 两份文档＋写日记＋索引），600s 太低。同时，一个「commit 已成功但随后 agent 请求超时/抛错」的日期，必须被当作**已处理**（以 last-successful marker 为准），不被触发器当失败重跑；若被再次触发，须幂等 no-op。

**Blocked by:** None.

**Status:** done（codex 落地，reviewer 亲自验货：880 pass / tsc 0 / build 0）

- [x] dream agent 的请求看门狗/超时调高到匹配其重负载的值（可配）：`DEFAULT_DREAM_AGENT_TIMEOUT_MS = 30min`（旧 600s 的 3 倍），经 config `dreamAgentTimeoutMs` 可调、钳位 60s–24h
- [x] 核实并保证：commit 成功（marker 已写）但 process()/agent 之后抛错的日期，被识别为已完成——`dream-job.ts` catch 块在 `wasCommitted() && marker >= date` 时吞掉错误、不外抛；marker 是权威来源
- [x] 若已提交日期被再次 process，须幂等——`process()` 开头 `existingMarker >= date && !regenerate` 直接 no-op 返回
- [x] 测试覆盖：看门狗取值；committed-but-threw → 日期判为已完成；已提交日期重跑幂等
- [x] bun test / tsc / build 全绿；不 commit/push；只读 git
