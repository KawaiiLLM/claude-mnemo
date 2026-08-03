# 03 — 统一行渲染器与单元预算（工具视图）

**Status: done** — 见 feat(renderer) 提交（含 codex 审查轮 2 blocker＋3 major＋2 minor 修复；门禁 1353/0；900 行预算路径 ≥3.0s→0.27s）。**给 04 的硬要求**：注入的旧四档循环在新渲染器下 O(n²)×20 倍常数（320 行 7.8s / 900 行 ~57s），删循环是上线前置条件非清理项；04 的调用 = `renderTimeline(view, {titleCap:100, tokenBudget:2500, showEarlierHint:false})`（tokenBudget 约束整个输出，勿叠预算）。**待 04 顺手落地的裁决**：trim 阶梯次序改为 ① desc ② 折 ↳ ③ **文件尾** ④ ↳ 标题 ⑤ spine 标题 ⑥ prompt 前缀 → clamp（装饰先于承重文本牺牲）。已知边界：无候选保留行的日期不渲染其自身 overflow（预置行为，与孤儿前件守恒修复无关）。

**What to build:** 三表面共用的行渲染器先在 MCP 视图落地：等级列（milestones 与 turns 都渲染）、脊柱行（prompt 前缀→title＋desc＋files）与 ↳ 拉入行（title-only、🚫 带「→被 T<n> 推翻」反链）、task-notification 前缀塌缩；渲染单元（脊柱＋其 ↳，↳ 上限 4 超出折 `+N 前件`）预算硬帽 100 token（终止规则：截 desc → 折 ↳ → token 级截标题）；全局预算按分数降级（desc→title→移除整单元、共享前件重归属至不动点、`+N more` 守恒）；锚集合是唯一允许的超预算残量（附注记）；视图契约保全矩阵（view 名、pageSize 主行计数、turns 列集、phases、shape signals 不变）。完成后三种会话形态的渲染快照测试可对照。

**Blocked by:** 02 — effGrade 词典序选择与拉入。

**Status:** ready-for-agent

- [ ] 行格式与两档密度符合 spec §D 原型；desc 不重述 title 由渲染侧透传（措辞纪律在票 05）
- [ ] 单元硬帽终止规则可强制：四条满长汉字标题用例通过（token 级标题截断）
- [ ] 降级顺序、重归属不动点、`+N more` 守恒、锚超预算注记、等分 tie 稳定序全有测试
- [ ] 保全矩阵逐项断言；titleCap/tokenBudget 不进公开 MCP schema
- [ ] token 计量用 estimateDiaryTokens；超大单行截 desc 不移除
- [ ] release-artifacts 守卫哨兵随机制替换同步更新；全量套件绿＋rebuild

详见 spec §D。
