# 04 — 四读取入口统一标脏

**What to build:** 无效日记文件（含 `format` 非法、哈希/节结构不符）无论被哪个消费方先碰到，都走同一条 validate-and-mark-stale 路径标 `needs_regen` 回队列，而不是各入口各自裸抛。

**Blocked by:** 01 — 日记 v2 格式与删除制（typed failure）。

**Status:** done

规范：`../spec.md`（「日记格式 v2」的校验失败统一处置条款）。

- [ ] canonical validator 返回 typed failure；四个读取入口统一经 validate-and-mark-stale：SessionStart 补写/完整性巡检、persona 操作输入装载、`read_diary` 工具、verify CLI
- [ ] persona 操作装载到无效日记 → 标脏后操作 **deferred**（非 terminal），等该日重新结算
- [ ] 四个入口各至少一个「无效文件 → 标脏 + needs_regen」用例（分布于 tests/hooks/context.diary.test.ts、tests/worker/persona-maintenance.test.ts、tests/worker/diary-agent-tools.test.ts、tests/diary/verify.test.ts）
