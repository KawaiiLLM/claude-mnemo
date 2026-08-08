# 10 — stranded-turn 修复与 dream 解耦（P1 补票，源自交叉审查 P2-3）

**What to build:** end-event 上的 stranded-turn-stop 修复目前只在 dream reconcile 返回到期日期时运行——dream 停运（P0 默认态）期间该清扫恒不运行，缺 turn-stop 的 active/provisional turn 会长期悬置、pending 观测不终态。要求：修复的候选日期改由**只读查询从 DB 派生**（存在完成证据且非终态 turn 的内容日），修复在 end-event 上无条件可运行，与 dreamAgentEnabled 完全解耦；dream 开启时行为不回归（reconcile 返回的日期与派生日期并集或等价）。

**Blocked by:** 03 — 笔记债台账与批次提醒（串行化，避免 worker 侧同文件冲突）。

**Status:** ready-for-agent

- [ ] dream 关闭时，end-event 仍执行 stranded 修复与 completion floor（fake-clock 测试断言）
- [ ] 候选日期只读派生，零 dream 依赖
- [ ] dream 开启态下现有全部测试绿，修复不重复执行
- [ ] 修复窗口内的 compact 序列化语义保持不变（compactingSessions 的排除与例外行为）
