# 11 — prompt 与 parser 的 wire-format 契约对齐

**What to build:** 修复票 10 引入的 prompt/parser 冲突：日记 prompt 的项目引导行示例与 parser 语法不符、persona prompt 缩进与结构门不符；并把 prompt contract 测试升级为「嵌入示例必须通过生产 parser」。

**Blocked by:** 10。

**Status:** done

- [ ] **日记 prompt**：项目引导行示例改为 parser canonical 形态 `**<项目名>**`（整行，无 `### 项目：` 字样）；删除「空节可写 `- 无`」的允许（`- 无` 无引用组必被删除制误杀）——空节直接不输出 bullet
- [ ] **persona prompt**：`路径/进度/反馈/[YYYY-MM]` 子项示例全部四空格缩进，文字规则明确「exactly four ASCII spaces」
- [ ] **canonical fixture 共用**：导出 canonical wire-format 示例常量（diary 一份、persona 一份），prompt 模板嵌入与 contract 测试共用同一来源
- [ ] **contract 测试升级**：diary prompt 内嵌示例经生产 envelope parser + 引用校验全通过（配合示例引用构造 allow-set）；persona prompt 内嵌示例经生产结构门全通过；另断言 prompt 不含 `### 项目`、不含无引用 `- 无`、persona 子项无两空格缩进
- [ ] 全量 `bun test` 0 失败；`bunx tsc --noEmit` 通过
