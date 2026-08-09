# 05 — 结算作业基建：触发、durable job、派发（P2）

**What to build:** 结算的调度骨架（spec D9），本票用桩载荷（no-op 子进程）打通，真实结算调用在票 07。触发器恰为两个：**会话内连续 50 已提取 turn 攒满**（自游标起 prompt_number 连续前缀全部 extracted/skipped）与 **compact**（以捕获修复后的 boundary marker 为准；双触发并发到期先到先得，同一 turn 只属一个窗口）。显式不触发：sessionEnd、resume、worker 启动、定时器。作业落库先行：identity=(session, 窗口起点, 触发类型) 唯一，claim/lease/generation，attempts+retry_at 指数回退（时间戳比较，无定时器，下次任意触发顺带检查），lease 逾期回收即消耗一次 attempt，封顶 3 次后终态、游标照走。优雅退出窗口（60s）内只落作业不派发。残留会话附带结算：已关闭判据 = 无活跃注册且最后活动 >24h；认领时先将其全部 pending 转 skipped(reason=closed)；每触发至多 2 个残留会话、最老优先、每会话单独派发（裁决 11）。

**修订（实现期用户裁决，具约束力）：**

1. **整块功能挂 `settlementEnabled` 旗标，默认 false**（须进 `clampConfig`，否则静默丢弃）。关时零行为差：不落作业、不派发、不动笔记台账——P1 影子试运行不因合入本票受任何扰动。
2. **本票只有桩载荷**：派发是一个可注入的空函数，缝形状固定为「接收冻结窗口 → 返回裁决」，票 07 换实现不动作业机器。
3. **最小窗口闸门**：compact 触发时若未结算连续前缀 < 20 turn 则不建作业，窗口继续累积到下一次触发。20 是建议值，**导出常量而非 config**。
4. **残留派发谓词**：未结算残留 ≥ 20 turn 才派；低于阈值不建作业、**不写任何状态**（会话重开后重新注册，自然回到活路径继续累积）。
5. **内部空洞由查询派生**：被清空的 turn 在窗口内又有更晚的 noted turn（interior hole），由票 07 装配调用时查询派生，**不加存储标志或列**。
6. 不动 `turns` 表 status 语义（P1 影子隔离）；本票写入面 = 新作业表 + note_debt 状态流转。

**Blocked by:** 03（需要笔记与状态数据使窗口有意义）。开工前提：P1 三指标过门槛、用户裁决进入 P2。

**Status:** done

- [x] fake-clock 测试断言：恰在 {连续50, compact} 派发，sessionEnd/resume/启动/退出路径零派发
- [x] 回退时刻表、lease 回收消耗 attempt、3 次封顶终态跳过，全部可测
- [x] 残留会话：24h 判据、认领清 pending、每触发上限 2、单会话单作业
- [x] 迟到子进程结果因 generation 不符被拒（桩载荷模拟）
- [x] worker 全生命周期无 LLM 调用（含本票新增路径）
- [x] 最小窗口闸门：compact 下 <20 不建作业、跨多次触发继续累积（fake-clock 断言窗口起点仍为 1）
- [x] 残留 <20：零派发且零状态写入；会话重开后回到活路径

**实现落点：** `src/db/note-settlement.ts`（作业表读写、窗口规划、残留查询、claim/lease/generation/回退/游标）、`src/worker/note-settlement.ts`（触发调度与派发缝）、`src/worker/server.ts`（仅 `handleTurnStop` 与 `handleCompact` 两处调用）、`src/db/schema.ts`（`note_settlement_jobs` / `note_settlement_cursors` 两表 + note_debt reason 词表加 `closed` 的重建迁移）、`src/shared/config.ts`（`settlementEnabled`）。测试：`tests/worker/note-settlement.test.ts`、`tests/worker/server.note-settlement-triggers.test.ts`、`tests/db/schema.note-debt-migration.test.ts`。

**实现期决定（需下游知晓）：**

- 「已提取/skipped 连续前缀」在 P1 隔离下**按笔记债台账判定**（`noted`/`skipped`/无债行=已决），不读 `turns.status`；上界是 `note_debt_cursor` 的分类水位（未分类的 turn 与琐碎 turn 一样没有台账行，不加此界会把在飞 turn 误判为已决）。
- 窗口起点 = `max(游标, 已入队最大 window_end) + 1`。只看游标不够：游标要等窗口**解决**才动，双触发并发到期时第二个窗口会盖住在飞窗口的 turn。
- 新表**不复用** `settlement_jobs`：那是 0.8.4 两阶段评分结算（D13 在 P2 废止的对象），仍跑在 legacy 路径上，共表会把「被废止的机器」和「废止它的机器」绑死。
