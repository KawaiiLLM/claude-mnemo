# 14 — 结算上线

**What to build:** 切换的第二阶段（spec D9/D11，裁决 27）。把 `settlementEnabled` 打开，让已合入但一直暗着的结算机器进生产：{连续 50、compact} 两个触发器、段归属与成员边、type/tag 复核、session summary 维护、残留会话附带结算（含裁决 18/19 的阈值与 20 的中间洞补写）。timeline 在新 era 默认渲染段脊柱 + 孤儿锚点。

**Blocked by:** 09 — era 转正写路（没有正式笔记就没有可结算的窗口）。

**Status:** ready-for-review

- [x] `note_settlement_cursors` 在 era 边界初始化，结算不磨 era 之前的历史窗口
- [x] 触发器恰为两个（连续 50 / compact），sessionEnd、resume、worker 启动、定时器一律不触发——测试断言 + 全库 grep 双重验证
- [x] 段、边、type/tag、session summary、游标推进在单一成功事务内提交，带 job generation 校验
- [x] 残留派发遵守 ≥20 阈值、不写终态标记；认领时先清空 pending，中间洞按裁决 20 补写并带结算侧 provenance
- [ ] 生产首个窗口人工验收：段粒度合理、引用抽查准确、开放段留 open 正确 — **blocked**：需要生产库真跑一个窗口，而 `eraCutoffEpoch` 按本票纪律仍为 null（运维翻），本票内无法完成
- [x] 全量测试绿（1816 pass / 0 fail / 137 files）

## Comments

**实现记录（本票落地时的取舍，票 15 需知）**

- **唯一切换开关 = `eraCutoffEpoch`**，`settlementEnabled` 降为 kill switch 且默认 true。理由：没有 era 就没有「turn 自己写的记录」，legacy turn 的记录是提取 agent 写的，结算它等于结算别人的笔记。故每个结算入口都同时看两个值，而**只翻 cutoff 就能把新 era 整体拉起**（`tests/worker/server.note-settlement-triggers.test.ts` 的「the era cutoff alone brings settlement up」用 `{...DEFAULT_CONFIG, eraCutoffEpoch}` 断言这一点）。产品默认仍 cutoff=null → 全库零行为差。
- **era 底线是「会话最后一个 era 前 prompt_number」**（`getEraFloorPromptNumber`），不是逐 turn 过滤：窗口是连续区间，把区间下界钉在该值才能保证「窗口内没有一个 era 前 turn」。live 路径（`getNoteSettlementWindowStart`）与残留扫描 SQL 各带一份同一表达式——残留是全库派生查询，没有会话游标可读，只能内联。
- **游标行在「结算第一次为该会话落作业时」出生**（`insertJob` 里 `ensureNoteSettlementCursor`，值 = era 底线）。没有挂在计划阶段：计划是纯读，未到阈值的 turn-stop 至今零写入，加一次 `INSERT OR IGNORE` 会把最常见事件变成每次一把写锁。被拒的窗口也不写游标行——「不够格不留痕」（裁决 18）对新表同样成立。
- **`planNoteSettlementWindows` / `enqueue*` / 残留扫描的 `eraCutoffEpoch` 参数是必填 `number`**（不是 `number | null`）：类型即不变量，调用方拿不到 era 就根本不能规划窗口。
- 全库 grep 复核触发面：`src/` 内 `noteSettlement.on*` 只在 `runNoteSettlementTrigger` 出现，其调用点恰两处——`handleTurnStop`（server.ts:3292）与 `handleCompact`（server.ts:3634）；HTTP 侧对应 `action=turn-stop` / `action=compact` / `POST /compact`。sessionEnd（`finishSession`）、resume（`registerSessionEnv`）、启动（`recoverFromCrash`）、三个 tick 全部零调用，测试从模块外断言。
- **票 15 拆除提取 agent 时要注意的一条**：`server.note-settlement-triggers.test.ts` 里 agent session 计数是**跨触发比较**而非绝对零，因为 legacy 提取 agent 仍会从同一次 drain 里开会话；拆掉提取 agent 后这条可以收紧成绝对零。
- 残留认领仍清空**整会话**的 pending（含 era 前的），与裁决 19 的「唯一清账点」一致；era 前的洞不会被补写，因为中间洞集合是从窗口派生的，而窗口从不含 era 前 turn。
