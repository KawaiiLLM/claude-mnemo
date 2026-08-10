# 15 — 旧机构拆除

**What to build:** 切换的第三阶段（spec D10/D13）。按 D13 清单拆掉被新体系替代的机构：常驻提取 agent 的会话机构（compact 管理、resume 指针、stall watchdog、extraction_stall 列）、obs LLM 摘要管线、独立 per-session summary agent、SessionEnd tail 结算作业、新 era 路径的里程碑评分器（legacy 模块保留只读）、新 era 里旧 remember 形态的 grade/regrade/cites 强制、以及 dormant 的 tool/result 规则类工厂（裁决 22 挂账于本票）。明确不动：`claim_generation`、rules/persona/diary 本体、legacy 渲染全套。

**Blocked by:** 14 — 结算上线（拆除前必须有活的替代品）。

**Status:** ready-for-agent

- [ ] D13 继承／废止清单逐项勾验，「明确不动」三项回归测试保绿
- [ ] worker 任何路径不再创建 SDK 会话（测试断言 + 全库 grep 双重验证），生命周期全程无 LLM
- [ ] 切换时跑一次 `migrateTurnCitationsToEdges(db)` 追平迁移（幂等，已导出）——memory_edges 一次性迁移后 legacy remember 仍在写 turn_citations，增量不自动传播，拆除前必须追平
- [ ] 拆除净减代码行数记录在发布说明
- [ ] 版本号六处一致，构建产物守卫通过
- [ ] 全量测试绿
