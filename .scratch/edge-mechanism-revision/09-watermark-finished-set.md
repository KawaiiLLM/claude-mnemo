# 09 — 水位线按「已完结集合」重建模(终审必改 2)

**What to build:** 过渡水位表达的是「迁移瞬间**已完结**的 turn 集合」,不是
「id ≤ 高水位的一切」。迁移时仍在进行的 turn,之后完结照常进自动结算。

**Ruling base:** peer 终审必改 2;spec D8 原文「该时点已完结的 turn」;
[S15069/T1124]。

**Blocked by:** None — can start immediately。注意:生产库当前**没有**水位行
(事故处置删除了它,[S15069/T1138]),所以本票重建模**没有存量数据要迁**——
发版时首打即用新形态。

**Status:** ready-for-agent

## Pinned decisions

- 病灶:`schema.ts` 的 stamp 无 status 条件记全表 MAX(id);
  `note-settlement.ts` 按 `id <= watermark` 折 per-session floor。peer 复现:
  provisional 的 T1 迁移后正常完结,也永久漏出自动窗口。
- 单一全局高水位**表达不了**「低 id 未完结 × 高 id 已完结」的混合,方案二选一
  (工作时定并报告理由):
  (a) per-session 连续已完结 floor(每 session 记一行「≤此 prompt 均已完结」,
      迁移时对每 session 计算);
  (b) 全局高水位 + 一张「迁移时未完结的例外 turn」表,规划器豁免例外集。
  倾向 (a)——例外表会随时间失去自解释性。
- 水位的一次性语义、backfill 豁免、旧队列清扫的既有测试语义全部保持。
- turn-id 形态优先于纪元时间戳的裁决不变(测试夹具的合成纪元问题)。

## Acceptance criteria

- [ ] 迁移时 active/provisional 的 turn,之后完结→进自动窗口;已完结的→仍被
      排除。混合状态 × 多 session 夹具。
- [ ] 手动 backfill 不受任何形态约束,既有测试不改而绿。
- [ ] 一次性语义保持:重开进程不重打、不再清扫迁移后入队的作业(既有回归测试
      不改而绿)。
- [ ] typecheck 干净;全套绿,只余既定的陈旧包守卫红。

## Ground rules

- NO git write commands。报出改动文件清单,主会话提交。
- 只碰 `src/db/schema.ts`(水位段落)、`src/db/note-settlement.ts` 及对应测试
  (`tests/db/schema.note-settlement-migration.test.ts`、
  `tests/worker/note-settlement.test.ts`);其余文件有并行 worker,只读。
  schema.ts 里事故拐杖的 DROP INDEX 行(dd25367)不许动。
- 不碰 `~/.claude-mnemo/`、`plugin/scripts/`、版本号;不重建 bundle。
