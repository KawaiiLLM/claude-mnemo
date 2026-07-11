# 08 — 注入 v2

**What to build:** SessionStart 注入改为两块：profile 块 + 经历块（experience 正文与代码渲染的「近期」段拼接，原独立 Diary Index 块移除）；最终渲染串过 1K/2K/3K 硬门；超预算按 AST 整单元裁剪，永不产生孤儿子项。

**Blocked by:** 05 — persona 产物切换 experience.md。

**Status:** done

规范：`../spec.md`（「注入」节为权威定义）。

- [ ] 独立 Diary Index 块移除；经历块 = experience.md 正文 + `## 近期` 段（沿用近 14 天逐日 + 月摘要行渲染）
- [ ] 最终渲染门作用于实际注入字符串（含块标题、包装、空行）：profile ≤1K、经历块 ≤2K、合计 ≤3K token；profile 注入时仍超限属异常 → 按损坏处理（跳过注入 + 置 rebuild），不做 bullet 级裁剪
- [ ] AST 整单元裁剪顺序：① 月摘要行（最旧先）→ ② 日摘要行（最旧先）→ ③ 印象事件 bullet（连延续行）→ ④ 通用条目 → ⑤ 整项目块；③④⑤ 时间 = 单元引用指向 turn 的最大 `created_at_epoch`（注入侧查 DB；解析失败视为最旧；同时间按文档顺序在前者先裁；⑤ 以进度行时间为准）
- [ ] 裁剪后无孤儿子项（项目首行被裁则整块消失）
- [ ] persona 缺失/损坏 → 跳过注入 + 自愈置位（与票 07 联动）
- [ ] tests/hooks/context.diary.test.ts 更新并全绿
