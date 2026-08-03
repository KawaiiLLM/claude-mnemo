# 03 — 统一行渲染器与单元预算（工具视图）

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
