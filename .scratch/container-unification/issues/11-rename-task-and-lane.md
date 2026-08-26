# 11 — 更名:任务 / 泳道

**What to build:** 读者在 rubric、工具描述、console 和报表里看到的是「任务」和「泳道」,
不再是「段」和没翻译的 lane。

对应 spec:D1。**放最后**,因为它和 04–10 改同一批描述文本,提前做会让每张票改两遍文案。

**Blocked by:** 04, 05, 06, 07, 08, 09, 10

**Status:** ready-for-agent

- [ ] 改:rubric 两份正文、四个工具的描述、console 图例与面板、校验器报表、CONTEXT.md 词条
- [ ] **不改**:表名、列名、TypeScript 标识符、`E<n>` 地址前缀、库里任何数据
- [ ] rubric 注入预算守卫重跑——改名会改变字节数
- [ ] console 文案走既有的 DOM-rule 字段表,重新生成 shell 并让陈旧守卫过
- [ ] CONTEXT.md 的 Lane 词条今天仍描述 v10/v11 的 exact-set 身份,一并订正,
      不是叠一层新词条上去
- [ ] 「任务」与本环境的 subagent task 撞词,读者-facing 文本靠上下文区分
