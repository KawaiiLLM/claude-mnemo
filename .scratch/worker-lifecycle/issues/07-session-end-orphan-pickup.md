# 07 — SessionEnd 孤儿 turn 补收

**Parent:** ../spec.md

**What to build:** 被打断（interrupt）的 turn 不触发 Stop hook，其 turn-stop 依赖同 session 的下一次 Stop 补挂；若用户打断后直接关闭且再不 resume，该 turn 永远停在 `active`、其 obs 成为无配对孤儿。SessionEnd 在门控通过后执行与 Stop 相同的孤儿检查（`active` + 无 assistant_response + 无 pending turn-stop），补挂 turn-stop 后由既有 60 秒收尾排空立即消费。

**Blocked by:** 03 — turn-stop 门控（复用其 SessionEnd 门控）；04 — SessionEnd 60 秒收尾（消费的执行者）。

**Status:** implemented

- [x] 孤儿判据与 Stop hook 完全一致，抽取为共享模块（stop 与 session-end 单一事实源）
- [x] 补挂发生在门控之后、flush 通知之前：glance 场景（无新 turn）不触发任何补挂
- [x] 已有 pending turn-stop 的 turn 不重复入队
- [x] 回退／打断的 turn 不做入队侧过滤——invalidation 标记语义不变（milestone corrector 依赖撤销记录）
- [x] 消费走既有 finishSession 60 秒预算，无新增超时机制

## Comments

- 新增 `src/db/orphan-turns.ts`：`getOrphanTurns(db, sessionDbId, beforeTurnId?)` + `enqueueOrphanTurnStops`。`beforeTurnId` 供 Stop 路径排除当前 turn；SessionEnd 省略该参数扫全 session。
- stop.ts 的私有实现替换为共享模块，查询时点保持在 backfill 之前（backfill 可能给被打断 turn 回填 assistant_response，若查询后置这些 turn 会漏出孤儿判据、又不满足 stranded 判据而永久滞留）。
- session-end.ts 仅在孤儿非空时开写事务；门控（`hasNewTurnSinceSessionRunStart`）先于孤儿查询，glance 不产生任何读写以外的动作。
- 崩溃／强杀路径（SessionEnd 未触发）不在本票范围：下次 resume 该 session 的首个 Stop 自然补收。
- 回归：SessionEnd 补挂被打断的末 turn 并 flush；已入队不重复；glance 下旧孤儿保持沉默。定向 23 pass / 0 fail；全量 `bun test` 922 pass / 1 fail（唯一失败为预期的 stale-bundle 守卫，未重建产物）。
