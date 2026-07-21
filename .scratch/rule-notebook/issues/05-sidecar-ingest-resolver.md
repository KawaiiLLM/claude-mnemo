# 05 — sidecar 摄入 + hit→turn 解析器

**What to build:** hit 从 sidecar 到事件账本的零丢失、不重复通道，以及从 hit 身份信息到具体 turn 的解析。摄入协议照 spec 五步：原子 rotate（绝不原地清空）→ 单事务内按 `hit_id` 幂等 upsert → checkpoint → 删除 rotated 文件 → 崩溃后重放安全。解析器以身份信息为准（session + 工具名 + input 前缀摘要 / prompt 摘要匹配），时间戳仅作同值裁决；无法解析的 hit 标记 `unresolved` 保留并计数。

**Blocked by:** 02（事件账本）、03（sidecar 格式落地）

**Status:** ready-for-agent

- [ ] rotate 期间的并发追加不丢失（rotate 后新 hit 落新文件）
- [ ] 同一 rotated 文件重复摄入，事件账本结果不变（幂等）
- [ ] 模拟摄入中途崩溃：rotated 文件保留，重放后账本正确
- [ ] 解析器：tool hit 与 prompt hit 各自正确落到 turn；同秒多 turn 场景由身份摘要消歧
- [ ] unresolved hit 保留且可查询，不静默丢弃

## Comments
