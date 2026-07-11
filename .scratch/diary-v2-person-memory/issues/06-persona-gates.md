# 06 — persona 结构门与预算门

**What to build:** persona 产物在发布前过三道代码门：项目块结构校验、引用/路径双 allow-set 校验、生产 render 预算门；失败重试时下一 attempt 携带结构化纠错反馈。malformed 或超预算的 persona 永远无法成为 CURRENT。

**Blocked by:** 05 — persona 产物切换 experience.md。

**Status:** done

规范：`../spec.md`（「persona 文档」节的结构校验/预算提交门/重试纠错反馈条款）。

- [ ] 项目块 shape 校验：恰一首行、恰一行 `路径：`（合法 JSON 字符串数组、元素为绝对路径）、恰一行 `进度：`、`反馈：` 0–2 行、印象行匹配 `- [YYYY-MM] ` 前缀；无未知缩进层级或游离子项；归档形态（首行+路径行+归档进度行）通过校验
- [ ] 引用组沿用票 01 的语法定义（日期前缀不计组）；每个 bullet（路径行除外）恰好一个引用组、组内全角逗号分隔
- [ ] 引用 allow-set 五行矩阵、与 `read_turn` 共用同一 per-request 集合：fold = 旧 persona ∪ 本篇日记；rebase 批 1 = baseline ∪ 本批；rebase/rebuild 后续批 = accumulator ∪ 本批；rebuild 批 1 = 本批；rebuild 永不含旧 CURRENT。用例：rebuild 批 2 引用 accumulator 中批 1 的引用必须通过、引用旧 CURRENT 必须失败
- [ ] `allowedProjectPaths` 按同一矩阵构造；输出全部规范化路径 ⊆ 集合；规范化 = 绝对路径 lexical normalize（`~` 展开、消解 `.`/`..`、去尾部 `/`、不 realpath、大小写原样）
- [ ] 任意两个项目条目的规范化路径集不相交
- [ ] 预算提交门用生产 render 函数：profile 渲染块（含标题包装）≤1K token、experience 渲染正文 ≤1.4K token（预留近期 0.6K）；超限 = 操作失败重试
- [ ] 重试纠错反馈：下一 attempt prompt 附版本化 validator feedback（错误代码、超限 token 数、违规条目索引），禁止未清洗完整失败输出；用例断言第二次请求包含反馈且可修正成功
- [ ] tests/worker/persona-maintenance.test.ts 补齐上述用例并全绿
