# 03 — 段的 Working State 必须可检索，否则语义记忆只有注入一条路

**What to build:** `remember` 写进段的六个 Working State 字段进入全文索引，并在 append/replace 成功后重建该段的索引行。

**证据（两层同时缺失）：**
- 索引列不含它们：`src/db/segments.ts:452-461` 的 `indexSegment` 只传 `title/content/insight/type/tags`；全量重建 `src/db/search.ts:613-619` 同样只 SELECT 这五列。
- 写入路径不重建索引：`appendSegmentWorkingStateRows`（`segments.ts:1038-1069`）与 `replaceInSegmentWorkingStateField`（`:1096-1139`）都不调用 `indexSegment`；唯一在写后重建的那处在 `applySegmentWrites`（`:913`，重建在 `:993`），而该函数在 `src/` 内**没有任何生产调用方**。

**叠加效应：** 结合票 05（`content`/`insight` 目前无任何写入者），新纪元段在检索层实际只剩标题与派生 facet。整个重设计的立论是「recall 按任务键控、跨会话加载相关语义记忆」，加载有注入与检索两条路，检索这条现在是断的。

**依据：** spec.md:55「segment field rows as first-class search hits beside turns, so that one query returns the distilled claim and its provenance scene」。**注意证据等级**：此句出自 spec user story，审计未能在用户原话中找到对应句子，故这是 document→implementation 偏差，不是 ruling→implementation。若认为该 story 本身不该存在，请改 spec 而不是改实现。

**Blocked by:** 05（`content`/`insight` 有了写入者，索引才有完整对象）

**Status:** done

- [x] 六个 Working State 字段进入段的 FTS 行 — `SegmentFtsRecord`（`db/search.ts`）新增 goal/constraints/decisions/done/nextSteps/reference；`indexSegmentToFTS` 把它们与 insight、facets 一并拼进 `extra` 槽
- [x] append/replace 成功后该段索引行同步更新 — `appendSegmentWorkingStateRows`/`replaceInSegmentWorkingStateField`（`db/segments.ts`）在 `reconcileSegmentCitedPairs` 之后各加一次 `indexSegment(db, updated)` 调用
- [x] 全量重建路径与增量路径索引同一组列 — `db/segments.ts` 的 `indexSegment` 私有帮助函数是 `SegmentRecord → SegmentFtsRecord` 的唯一转换点，`rebuildSearchIndex`（`db/search.ts`）的 SELECT 语句显式取同一组列（title/content/insight/goal/constraints/decisions/done/next_steps AS nextSteps/reference/type/tags），两条路径不可能各自漂移
- [x] 用 `recall(query=…)` 命中一条只出现在 `decisions` 里的措辞 — 用 `searchMemory(scope:"segments")` 在 `tests/db/search.test.ts` 验证（`recall` 本身走同一 `searchMemory`，未改动、未新增依赖）；复验命令见交付报告
