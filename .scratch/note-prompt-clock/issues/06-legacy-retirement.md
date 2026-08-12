# 06 — 存量迁移与读者退役

**What to build:** note_debt 的历史包袱一次出清(spec D8):全部存量 pending 行注销(status='skipped', reason='closed',以迁移当刻实数为准,不删行);全仓 note_debt 读者清点 —— settlement decided-prefix 已由 05 改边界推导,其余(residual claim、P1 合规指标等)逐一改派生口径或宣告随台账退役,防止畸形分母。运行时路径(03/05)已不产生也不依赖 pending,本票是卫生收尾,与 04 平行。

**Blocked by:** 03 — prompt 时钟台账;05 — settlement 兜底(decided-prefix 迁移先行)。

**Status:** ready-for-agent

- [ ] 迁移后 `status='pending'` 全库计数为 0;注销行保留可审计(reason='closed')
- [ ] 全仓 grep note_debt 的每个读者:或改派生口径,或有退役声明;无残留 pending 依赖
- [ ] 指标类读者(residual claim、合规统计)在新口径下分母正确
- [ ] 01 落地后的已知滞留:对 aged/rolled-back/closed 终态债务 turn 的后补笔记会成功但不改债务行(closeNoteDebtAsNoted 只认 pending/declined)——读者退役时以 shadow_notes 存在性为准,不以债务状态为准
- [ ] 全量测试绿
