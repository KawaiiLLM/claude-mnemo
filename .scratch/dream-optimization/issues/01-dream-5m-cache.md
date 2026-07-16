# 01 — dream 强制 5 分钟缓存

**What to build:** dream agent 改用 5 分钟提示缓存，不再落到 CC 默认的 1 小时缓存；summary agent 保持 1 小时不变。上线后一次真实 dream 的 transcript 应报告 5 分钟缓存创建，使该次 dream 的 cacheWrite 从 2× 单价降回 1.25×（按 07-16 实测约省 $0.40 / 次、约 18%）。

**Blocked by:** 无 — 可立即开始。

**Status:** done — dream 的 SDK query options 注入 `env: { ...buildIsolatedEnv(), FORCE_PROMPT_CACHING_5M: "1" }`（SDK sdk.mjs:8592 确认 `options.env` 完整替换式生效）；summary 路径不动。测试加 `options.env` 断言，通过；tsc 干净；唯一 fail 是 stale-bundle guard（待 04 重打包）。

- [ ] dream 的 SDK query 现在完全不传环境变量、因而继承无缓存 flag 的 worker 环境；改为注入一份以隔离环境为底、叠加强制 5 分钟缓存 flag 的环境。
- [ ] dream 走硬编码 5m，不复用 summary 的缓存模式配置、不新增缓存旋钮（两者策略解耦，一个 5m 一个 1h）。
- [ ] summary 路径的缓存模式与行为零改动。
- [ ] 现有 dream SDK query 的 query-options 测试新增一条断言：注入环境含强制 5 分钟缓存 flag。
- [ ] 端到端可验证：部署后一份真实 dream transcript 的 `ephemeral_5m_input_tokens` > 0、`ephemeral_1h_input_tokens` 为 0（可复用现有 TTL 探测逻辑）。
- [ ] 全量 `bun test` 与 `tsc` 干净。
