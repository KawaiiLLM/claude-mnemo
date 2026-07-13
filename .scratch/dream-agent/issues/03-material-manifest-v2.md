# 03 — 材料清单 v2（纯渲染）

**What to build:** 当天 turn 材料渲染给 dream agent。每个 turn 贡献 user prompt，外加：extracted turn 给其摘要（title＋content 合为一个字段、去掉冗余 title 前缀），unextracted turn 给其 response。每个字段封顶约 200 token（CJK 感知），在句读或词边界截断并补省略号。extraction 文本里内嵌的内部 DB turn id 改写成 [S/T] 引用。skipped turn 的 response 标记为低信任。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] extracted turn 渲染 prompt＋合并摘要（无重复 title 前缀），每字段 ≤ 约 200 token
- [ ] unextracted turn 渲染 prompt＋response，每字段 ≤ 约 200 token
- [ ] 截断落在句读/词边界并补省略号，绝不断在词中
- [ ] 内嵌内部 turn id 转成合法 [S/T] 引用
- [ ] skipped turn 材料被标记低信任
- [ ] 计量使用项目现有 CJK token 估算函数；纯函数单测覆盖各分支
