# 02 — diary/dream 尝试计数接入分类器

**Parent:** ../spec.md

**What to build:** 瞬态网络错误不再把 dream 的一天打成 terminal——diary/dream 的失败记账经过错误分类器：连接类失败不递增 attempt 计数、不推进 terminal 判定；确定性失败维持 dream-retry-policy（一次自动重试 → terminal）的既有语义。修复 2026-07-15 型「两次 ECONNRESET → 永久卡死」。

**Blocked by:** 01 — 错误分类器 + flush 网络挂起。

**Status:** ready-for-agent

- [ ] dream/diary 失败路径经分类器分流：`connection` 类不递增 attempt_count、不写 terminal，仅推迟下次尝试时刻
- [ ] `deterministic` 类维持既有语义（初次 + 一次自动重试 → terminal），dream-retry-policy 既有测试不回退
- [ ] 回归场景：模拟同一天两次连接类失败后网络恢复，该日仍被自动补跑完成，全程无 terminal
- [ ] 手动触发 `POST /dream` 的重置语义不受影响
