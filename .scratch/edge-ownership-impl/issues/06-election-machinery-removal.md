# 06 — 选举机器拆除(存储半)

**What to build:** 评分的 db/模块层残骸清除;旧 grade 数据保留可读。

规范:`.scratch/turn-edge-mechanism/spec.md` Legacy 政策([S15069/T926])。

- election 模块、election-era 模块、turns 的 election_tier 列(纪元从未钉值,生产零 tier 数据)、结算的 grade/tier 写面删除。
- tier 读支(timeline 段视角的 tier 消费)作**死码清理**——不是渲染重设计,tier 从未在生产渲染过。
- `significance_grade` 列与旧读法**保留**——「旧纪元退出里程碑」是视图 spec 的验收,本票不碰里程碑准入。
- ADR-0003 标 superseded(正文注记,指向边 spec)。

**Blocked by:** 05(结算停写 grade/tier 后才能删存储)。

**Status:** done

**Implementation record:** `src/election.ts`/`src/election-era.ts` 删除,`turns.election_tier` 从 `SCHEMA_SQL`、`ensureTurnElectionTierColumn`(整函数删除)、`db/turns.ts`(TurnRecord/TurnRow/UpdateTurnByIdInput/UPDATE 语句)、`db/segment-rank.ts`(RANK_FACT_COLUMNS)全面移除。两处 turns 表 12 步重建(`ensureTurnTypeMultiValueColumn`/`retireTurnCitesRecordedColumn`)的列清单同步瘦身,并把 `election_tier` 加入各自的 `droppedColumns` 白名单,使孤儿列(既有装机可能仍物理携带)被 `assertNoUnexpectedTurnsColumns` 判定为"已知的有意丢弃"而非未知列异常——已用 mutation demo 验证该白名单确实是必要条件(见下)。结算写面(`note-settlement-turn-facade.ts`)的 tier 字段、`isElectionEra`、era-gating 分支删除,`grade` 保持不变。`mcp/definitions.ts`(`settlementNoteInputShape`)、`note-settlement-sdk-query.ts`(工具描述、`ELECTION_ERA_CUTOFF_EPOCH` threading)、`note-settlement-staging.ts`(`tierCounts`/`ElectionTier`)同步清空。`mcp/timeline.ts`'s `selectSegmentMilestoneRows` 的 A/B-tier 准入分支删除(仅剩 state-cited 准入 + 原有溢出淘汰循环)——死码清理,tier 因纪元从未钉值而在生产恒为 null,输出字节不变;两个消费该函数的既有测试文件(`timeline.segment-views.test.ts`、`timeline.era-milestones.test.ts`)相应改写 fixture(A/B-tier 场景改为多条 state-cited 场景)。`task-causality-rubric.ts` 核实零消费者且内容属 grade(非 election)语义,予以保留未删。`significance_grade` 列、`TASK_CAUSALITY_GRADE_RUBRIC` 未触碰。ADR-0003 加 superseded 状态行 + 正文注记,指向 ownership-and-note-cadence + turn-edge-mechanism 两份 spec。

- [x] tier 列与 election/era 模块无任何引用残留(grep 断言进测试或报告) — `grep -rn "electionTier\|election_tier" src/ tests/` 与 `grep -rln 'election-era\|from ".*election"' src/ tests/` 仅剩历史性文档注释与本票自身的孤儿列回归测试,无功能性引用;`bunx tsc --noEmit` 零错误
- [x] 旧 grade 的渲染字节不变 — `significance_grade`/`TASK_CAUSALITY_GRADE_RUBRIC`/legacy milestone 渲染代码路径未改动,`bun test tests/task-causality-rubric.test.ts tests/mcp/timeline.era-milestones.test.ts`(legacy block 断言）全绿
- [x] ADR-0003 带 superseded 注记 — `docs/adr/0003-election-grading.md` 首行 Status + 正文引述块
