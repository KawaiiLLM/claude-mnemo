# 01 — observation 队列通道拆除

**What to build:** 工具调用的完整生命周期收敛为两步——捕获时写一行、进检索索引。此外不再有任何环节。

现状是票 15 拆除提取管线的残留：每次工具调用仍然入 `pending_queue`、并唤醒 worker；而队列那头的消费者只剩两个动作——把该 observation 标成 `skipped`、删掉队列行。提取 agent 删掉之后，这条通道搬运的东西已经为零，但每次工具调用仍要付一次入队、一次跨进程唤醒、一次出队、一次删除。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

范围（用户已拍板，含第三条）：

1. 捕获路径不再把 observation 入队。
2. worker 队列消费里针对 observation 的那段分支删除。
3. PostToolUse 不再唤醒 worker。

关于第 3 条的安全性判断：worker 的存活与会话环境注册会收敛到 turn 边界（UserPromptSubmit / Stop / compact / SessionEnd）。这几个入口本来就在注册环境，且 worker 是按需拉起的，因此判断安全——但它确实改动了 worker 生命周期，实现时要把这一点当作主要风险面对待。

**Status 更新：done。** 实现记录见文末。

- [x] 每次工具调用不再产生队列行，也不再触发 worker 唤醒
- [ ] observation 在 turn 完结时由结算统一退役（现有行为），不依赖队列
- [ ] 升级前遗留在队列里的 observation 行仍会被排空，不会永久滞留
- [ ] worker 仍能在 turn 边界被正常拉起；会话环境注册不丢
- [ ] 拆除后不留死代码：为这条通道存在的清理语句一并处理
- [ ] `observation.status` 若在拆除后失去全部意义，在票里说明现状而非顺手改语义（不扩大范围）
- [ ] 全量测试绿

## Comments

**实现记录（落地时的取舍）**

- **票里的安全性判断点错了 hook**：`action:"capture"` 来自 **SessionStart**，不是 UserPromptSubmit——真正的 UserPromptSubmit 处理器根本不触发 worker。结论本身仍然成立（`/trigger` 端点对**任何** action 都会注册会话环境，因此 SessionStart + 每个 Stop + PreCompact + SessionEnd 共同覆盖），但票里那句话是错的，记在这里免得下次照抄。
- **`wake` 有一份没写下来的第二职责**：除了触发队列排空，它还让每次工具调用都重新注册一次会话环境。删掉之后，一个 turn 之内只在其起点注册一次。环境在进程存续期内不会变，所以无影响——但如果将来出现「turn 中途环境陈旧」类的报告，先看这里。
- **worker 空闲退出的相互作用**：worker 在 30 分钟无 HTTP 后退出，此前每次工具调用都会刷新这个计时器。现在只有 turn 边界会刷新，因此**超过 30 分钟的单个 turn 会让 worker 中途退出**，并在该 turn 的 Stop 处被重新拉起。不是正确性问题（状态全在库里，worker 随时可重启是既定设计），但冷启动会变多。
- **保留了四处 obs 队列清理语句**（`skipOrphanTurns`、`finalizeUnreachableStrandedTurns`、`convertOccupiedTurnToMarker`、`cleanSubagentTurns`）。它们对新 turn 已永久空转，但仍在为各自所属的终态化流程清理升级前遗留的行。判断是：为零功能收益去改四条互不相关的终态化路径，风险大于收益。**这是有意保留的残留，等遗留行排空后应当再清一次**——记在这里而不是让它无声地留着。
- **一处可观测行为变化**：某个 turn 若经由上述四条路径以外的方式抵达终态，它的 observation 会停在 `pending` 而不再被队列顺手标成 `skipped`。实测只能用裸 SQL 构造出来，生产路径均已自带 blanket 退役语句。
- **`observation.status` 的现状**：拆除后它的读者只剩检索的纪元感知过滤，以及 legacy 回写路径的一句回执文案。本票按要求只陈述现状，未改语义、未删列。
