# 07 — 捕获修复

**Status: done** — 8661f9e（含 codex 审查轮 11 项修复、逐项 mutation 验证；门禁 1307/0。遗留：session-init 既有全文件读取不受新 cap 约束→后续优化票；>5MB 单行记录会永久卡住该会话游标，逃生口=有界换行搜索→后续票）

**What to build:** compact 边界与链接的捕获闭环：UserPromptSubmit 在创建新 turn 前做增量补扫（字节偏移＋最后完整行游标、绝不越半行、5000 行/5MB 上限余量顺延）；按 transcript 序幂等认领全部未认领 compact 边界（边界 UUID 唯一键、新 marker 取 MAX+1、trigger/preCompactTokenCount 读自 transcript compactMetadata）；promptId 抢注时同事务改型（全列 preserve/set/clear 处置、观测置 skipped、队列项删除）；link-only reconcile（只填 NULL 的 content_prompt_id/transcript_line_start，候选集与「transcript 序 × prompt 序」精确配对，歧义/占用/错位跳过记日志）；SessionEnd 兜底（活动门快照先于修复写入、≤500 行有界、余量下次 resume 恢复）；PostCompact handler 整体移除（hooks 注册与测试同步）。完成后以真实形态 fixture（9 边界 2 marker）演示一次补齐全部缺口、无废稿复活。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] 多边界一次认领、UUID 幂等重入、新 marker 编号正确
- [ ] 改型全行断言（每列符合 preserve/set/clear 清单）；后续提取不覆盖 marker
- [ ] link-only 字节不变断言；重复文本/已占用 promptId/次序错位跳过并记日志；不建任何新普通 turn
- [ ] 字节游标崩溃恢复、半行不越、上限顺延与 resume 恢复
- [ ] SessionEnd 活动门快照序（修复类写入不触发 orphan 误判，glance 回归保持）、2s 有界
- [ ] PostCompact 移除后注册矩阵与既有测试同步更新；全量套件绿＋rebuild

详见 spec §F。
