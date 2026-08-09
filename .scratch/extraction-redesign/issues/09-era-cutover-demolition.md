# 09 — era 切换与旧机构拆除（P2 收尾）

**What to build:** 切换与净化（spec D10/D12/D13）。设定 era cutoff epoch；cutoff 后新 turn 的笔记成为正式记录（影子期存量仅留作对比，不转正）。按 D13 清单执行拆除：常驻提取 agent 会话机构（compact 管理、resume 指针、stall watchdog、extraction_stall 列）、obs LLM 摘要管线、独立 per-session summary agent、SessionEnd tail 结算作业、新 era 路径的里程碑评分器（legacy 模块保留只读）、旧 remember 形态在新 era 的 grade/regrade/cites 强制。明确不动：claim_generation（transcript 修复账本）、rules/persona/diary 本体、legacy 渲染全套。worker 端到端验证无 LLM 宿主。按项目惯例完成版本号六处与发布检查。

**Blocked by:** 07 — 结算调用本体；08 — 渲染层。另需用户对 P1→P2 切换的最终裁决。

**Status:** ready-for-agent

- [ ] D13 继承/废止清单逐项勾验，「明确不动」三项回归测试保绿
- [ ] cutoff 后新 turn 走正式笔记写路，cutoff 前数据只读不回填
- [ ] worker 任何路径不再创建 SDK 会话（测试断言 + 全库 grep 双重验证）
- [ ] 全量测试绿；拆除净减代码行数记录在发布说明
- [ ] 版本号六处一致，构建产物守卫通过
- [ ] 追加（票 06 实现发现）：切换时跑一次 `migrateTurnCitationsToEdges(db)` 追平迁移（幂等，已导出）——memory_edges 一次性迁移后 legacy remember 仍在写 turn_citations，增量不自动传播，拆除前必须追平
