# 02 — 预备重构:turn 结算迁出笔记分类

**What to build:** settleCompletedTurn 及其走查从 reconcileNoteDebt 迁出为独立的 turn 结算通道(spec D10)。它是 turn 终态、files_read/files_modified/tool_call_count、observation 退休的唯一写者,现嵌在笔记分类内被 Stop/PostToolUse/worker 队列间接调用 —— 03 删除笔记分类前必须先完成本迁移,否则终态写入路径被顺手删掉。新通道**无游标**:未结算集合自识别(status ∈ active/provisional 且完成证据在:下一 prompt 已存在或 turn-stop 在队),不依赖 note_debt_cursor(03 会删它),也不做全表扫描;三个调用点共用这一个候选谓词。行为对外零变化。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] turn 终态、文件/工具计数、observation 退休的写入时机与迁移前逐一对应(零行为变化)
- [ ] reconcileNoteDebt 不再是任何 turn 终态写入的必经点
- [ ] Stop/PostToolUse/worker 三个现有调用点全部改走新通道,各自事件形态下的候选来源 = 同一个自识别谓词
- [ ] 新通道零处读 note_debt_cursor;候选查询有界(以未结算集合为界,非全表)
- [ ] stranded turn(无完成证据)不被结算,照旧留给 liveness
- [ ] 全量测试绿
