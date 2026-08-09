# 08 — 渲染层：段脊柱 timeline 与 recall E 选择器（P2）

**What to build:** 读端切换到段结构（spec D8/D11）。timeline 新 era 默认视图 = 段脊柱（段行：主 type glyph + tag + title + status + 成员数/跨度 + 相位轨迹）+ 孤儿锚点行（未归段但机械信号强的 turn）；段内下钻 = anchor 优先占位 + 派生 rank（词典序 ORDER BY 事实列，(citing,cited) 跨 provenance 去重）补齐渲染预算；按天视图在新 era 移除。era 按 turn 级 epoch cutoff 分路（R2#7）：同一会话内旧 turn 走 legacy 渲染路径（全套保留只读），新 turn 走段脊柱。recall 新增段选择器 `E`（`[E47]`），段记录以同 schema 进入命中集与 type:/tag: 过滤；obs 行渲染机械字段。SessionStart 弧骨架注入改查段表，预算沿用现有合同。

**Blocked by:** 06 — 段/主题/边 schema 与机械层（07 完成前用 fixture 数据验收）。

**Status:** ready-for-agent

- [ ] 跨 era 会话双路渲染正确：旧 turn legacy 视图、新 turn 段脊柱，同屏无混读
- [ ] `recall(id="E47")` 往返可用；`tag:` / `type:` 过滤同时命中段与成员 turn
- [ ] 段内下钻顺序确定且可解释：固定信号列的 fixture 断言完整排序
- [ ] 孤儿锚点（高机械信号、无段归属）独立成行
- [ ] 注入的段骨架不超既有预算合同
- [ ] replay 原文轴零改动（回归断言）
- [ ] 追加（票 06 实现发现）：FTS 解耦后 `queryTurnsByScope`（src/db/search.ts）无 turn status 谓词，skipped/在飞 turn 已可被检索命中——本票补渲染侧状态过滤（D11：status 只影响渲染）；obs 读路径已有 `status='extracted'` 过滤，不需动
