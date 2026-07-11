# 01 — 日记 v2 格式与删除制（domain 层）

**What to build:** 日记文档的 v2 格式核心：解析器/校验器/序列化器支持三节第一人称日记，非法引用的 bullet 被删除并记入结构化报告，index hook 永不概括已删内容。完成后 domain 层测试可独立验证全部新格式行为。

**Blocked by:** None — can start immediately.

**Status:** done

规范：`../spec.md`（「日记格式 v2」「引用校验：删除制」两节为本票权威定义；v1 代码路径直接删除，无迁移）。

- [ ] 节清单改为 `## 工作`、`## 人物`、`## 反思`（顺序固定）；v1 四节常量与降级校验器（`[引用待核]`/`[背景]` 机制）删除
- [ ] envelope 哨兵升级 `===DIARY_V2_BEGIN/END===`（partial 同步 V2）；INDEX_HOOK 哨兵不变
- [ ] 正文语法封闭：bullet 匹配 `^- `（顶格不嵌套）；项目引导行整行匹配 `^\*\*[^*\r\n]+\*\*$`、仅限工作节、其后必须紧跟 ≥1 bullet（之间出现其他行 = envelope 非法）；人物/反思节标题与首 bullet 间非空行非法；其余行为延续行归属上方最近 bullet
- [ ] 引用组语法定义：仅内容以 `S<n>/T` 起始的方括号是引用组；`[YYYY-MM]` 等其他方括号是正文，不计组数（该定义导出供 persona 侧复用）
- [ ] front-matter `format` 严格校验：canonical serializer 输出 JSON 整数 `2`；缺失/重复/`1`/字符串/其他值 → typed failure（不裸抛）
- [ ] 删除制：分母 = 三节内全部 bullet（延续行随删；节标题/front-matter/引导行不计）；违规 =引用组缺失、非恰好一组、含 allow-set 外引用、或去引用去空白后正文 <1 code point；删空的项目块连引导行清理；`deleted*3 > total` 或 `total==0` → 生成失败
- [ ] 校验报告 `{version:1, total, deleted, items:[{section, sha256, preview}]}`：items ≤20、preview 隐私剥离后截 80 code point、sha256 输入 = 删除前完整 bullet（含延续行）UTF-8 bytes
- [ ] hook 污染防护：`deleted==0` 用 agent hook；否则确定性生成——依次取工作/人物/反思各块首条存活 bullet 正文（去引用去换行）以「；」连接截 160 code point
- [ ] 隐私剥离统一走 fail-closed 的 `stripDiaryPrivateContent()`，禁用 fail-open 的 shared `stripPrivateTags()`；测试覆盖不配对标签与 >100 标签
- [ ] tests/diary/domain.test.ts 更新并全绿（含：`[YYYY-MM]`+单引用组合法、双引用组非法、仅日期无引用非法、空正文 bullet 删除、引导行整行/限节/引导后无 bullet 非法）
