# 02 — 日记管线接入 v2

**What to build:** 日记 job 端到端产出 v2 日记：第一人称三节 prompt、`format: 2` 文件落盘、校验报告持久化、超阈值失败重试。假 runQuery 喂 V2 envelope 可全链路验证。

**Blocked by:** 01 — 日记 v2 格式与删除制。

**Status:** done

规范：`../spec.md`（「日记格式 v2」「引用校验：删除制」；报告列语义见「发布」前各节）。

- [ ] `diary_day_state` 新增列 `validation_report_json TEXT`：成功结算总是覆写（含 `deleted=0` 报告）；tombstone 置 NULL；失败 attempt 走既有 `last_error`，不占该列
- [ ] job prompt 改 v2：第一人称；三节；人物节带信号类型清单（偏好、品味、生活面、对 AI 的纠正与认可）；反思节 ≤5 条、推测须带不确定措辞
- [ ] job 产出 front-matter `format: 2` + V2 envelope；map/merge partial 哨兵同步 V2
- [ ] 删除阈值触发 → 本次生成失败走既有重试通道
- [ ] tests/worker/diary-job.test.ts、tests/db/diary-state.test.ts、tests/db/schema.test.ts 更新并全绿
