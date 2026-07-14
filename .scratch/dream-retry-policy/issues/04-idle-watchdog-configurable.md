# 04 — idle watchdog 可配置化

**What to build:** dream agent 的 idle watchdog 从写死的 120 秒改为可配置、默认放宽到分钟级，让 opus 的长段静默推理（观测到 286 秒空窗）不会在 commit 前把 dream 掐死。这是「让 dream 真能跑到 commit」的根因修复。

**Blocked by:** None — can start immediately（与 01 并行，可最先落）。

**Status:** done — `dreamAgentIdleWatchdogMs` 入 config（默认 `DEFAULT_DREAM_AGENT_IDLE_WATCHDOG_MS=600_000`，clamp 30_000–3_600_000），`diary-agent-runner` 写死 120_000 改取该默认，`diary-runtime` 用 `config.dreamAgentIdleWatchdogMs` 建 runner。config.test 加默认+override+clamp 断言，runner 契约测试同步。tsc 0、882 pass（仅剩 stale-bundle guard）。

- [ ] config 新增 `dreamAgentIdleWatchdogMs`，默认 `600_000`，clamp 合理区间（建议 `30_000 .. 3_600_000`），与既有 `dreamAgentTimeoutMs`（request，30 分钟）并列
- [ ] `diary-agent-runner` 的 idle watchdog 从写死 `120_000` 改为「显式入参优先，否则取 config 默认」；loadConfig 值经 runtime 一路传入
- [ ] idle watchdog 默认值小于 request timeout（10 分钟 < 30 分钟）
- [ ] 测试落在 `tests/shared/config.test.ts`（默认值 + clamp 边界）与 `tests/worker/diary-agent-runner.test.ts`（接受显式 `watchdogMs` 覆盖，既有先例已传该参数）
