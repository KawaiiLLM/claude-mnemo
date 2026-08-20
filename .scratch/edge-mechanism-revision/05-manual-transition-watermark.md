# 05 — 过渡水位线:更新时点存量零自动结算

**What to build:** 插件更新(迁移运行)那一刻已完结的 turn,永不进入自动结算
计划;它们唯一的结算通道是手动 backfill。新纪元 turn 照常自动触发。

**Ruling base:** spec D8;[S15069/T1124]「插件更新时所有已经完成的 turn 不需要
自动结算,全部走手动结算」。

**Blocked by:** 01(迁移的家;水位线随同一迁移落库)。

**Status:** blocked

## Pinned decisions

- 迁移时落一个持久水位(实现形态自选:纪元时间戳或 turn id 高水位,工作时定并
  报告);所有自动规划器(consecutive/compact/residual/sessionend)跳过水位前
  完结的 turn——窗口起点直接从水位后算,不产生覆盖水位前的自动作业。
- 手动 backfill(既有 `backfill` trigger_type,唯一豁免单调窗底的通道)不受水
  位约束:可显式指定任意范围,含水位前。
- 已入队未跑的旧自动作业在迁移中按终态弃置放行先例处理(沿用 read-write-
  contract 迁移的既有做法),不留悬作业。
- 水位是一次性过渡设施,不是每次更新重打:仅本迁移落,后续版本迁移不追加新水
  位(下次再裁)。

## Acceptance criteria

- [ ] 迁移后,水位前完结的 turn 不被任何自动触发器纳入窗口;夹具含跨水位混合
      形态。
- [ ] 水位后新完结 turn 照常按 50/compact/sessionend 触发。
- [ ] 手动 backfill 可覆盖水位前任意范围并正常执行。
- [ ] 迁移对已入队旧作业的处置有测试钉住。
- [ ] typecheck 干净;全套绿,只余既定的陈旧包守卫红。

## Ground rules

- NO git write commands。报出改动文件清单,主会话提交。
- 不碰 `~/.claude-mnemo/`、`plugin/scripts/`、版本号。规划器若在 `src/worker/`
  内,仅限触达规划逻辑本身,不越界改 facade(那是票 04 的地盘)。
- 不自行重建 bundle。变异候选:水位过滤谓词。
