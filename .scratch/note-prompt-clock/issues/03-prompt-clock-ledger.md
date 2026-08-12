# 03 — prompt 时钟台账与注入

**What to build:** 欠账集合变为 prompt hook 内的派生查询(spec D1),并在同一事务渲染注入:current-turn 行追加 owed 形态(0 静默 / 1 地址 / ≥2 地址+计数,spec D3),≥5 时追加泄压块并逐 prompt 重渲染(spec D4)。compact 标记行按标记过滤,不入册、不可写(补齐 01 留下的拒绝;spec D2 —— 机械命令不建行,无需 prompt 解析)。笔记路径删除 Stop 分类、工具计数、干燥计数、泄压 CAS 认领(完成证据已随 02 迁走);pending 行不再产生。存量迁移与读者退役归 06 票,本票只保证运行时路径不再产生或依赖 pending。

**Blocked by:** 01 — 资格塌缩;02 — turn 结算迁出(分类删除以其完成为前提)。

**Status:** ready-for-agent

- [ ] 欠账为派生查询,口径 = spec D1 谓词;切换后历史界外 turn 不复活
- [ ] 注入四形态字节级匹配 spec D3(0 条时现有行原样不变);owed 行与泄压块复用 formatPromptPrefix 转义
- [ ] 泄压唯一条件 ≥5,逐 prompt 重现直至 <5;正文无一次性措辞
- [ ] compact 标记行不入册、不可写;skill 型斜杠命令 turn 照常入册可写
- [ ] sidechain(undone)与 rolled-back turn 不出现在 owed 中
- [ ] skip(declined) 新旧记录都压制对应 turn 的 owed
- [ ] countSubstantiveToolCalls、NOTE_RELIEF_DRY_TURNS、分类游标推进与泄压 CAS 从笔记路径源码删除;pending 行零新增
- [ ] session-init / prompt-dispatch 双 UserPromptSubmit 进程的职责与 N/N-1 竞态经测试核对
- [ ] 全量测试绿
