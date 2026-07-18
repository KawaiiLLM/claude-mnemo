# 连接错误弹性：抽取 agent 不再无限挂起 / 不再误杀 turn

**Status:** ready-for-agent

## Problem Statement

一次**瞬时**的网络中断（记忆 agent 打到 API 时 `ECONNRESET`）会把整条抽取流水线**永久性焊死**，直到人工 kill 进程。用户视角：

- 网络下午抖了一次、傍晚已恢复，但**恢复后 4 小时抽取仍停在中断那一刻**（最后一次成功抽取冻结在 14:36，其后所有会话零抽取）。
- 某个记忆 agent 子进程撞 `ECONNRESET` 后**挂起在 0% CPU 十几分钟**，既不超时自杀、也不释放它 claim 的队列项——后续 turn 全堆积成 `active`，缓冲区「稳态只留 1 个 turn」的不变量被打破，一路涨到几十个未认领。
- 更糟：中断那一刻**正在被处理**的 turn 被标成 terminal `failed` 并**移出队列**（本次事故里 S11231 的 T459–462），网络恢复后也不会自愈——**4 个只是网络受害者、内容完全正常的 turn 被永久丢弃**。而当时还躺在队列里未认领的 turn（T463+）在网络恢复后正常重试成功。**区别只在于中断那一刻它是否正在飞。**

现有代码其实**已有**一条正确的连接错误处理链（`suspendSessionAfterConnectionError`：释放 claim、关 agent、时间退避后重试），但三处缺口让它在本次事故中整体失效。

## Solution

用户视角：**瞬时网络错误只应造成瞬时延迟，绝不应造成永久停摆或数据丢失。** 网络一恢复，抽取就应在下一个自然触发点自动追平，无需任何人工干预；期间没有任何 turn 因网络原因被判死。

具体到行为：

1. **永不因连接错误挂起**：agent 撞连接错误后若卡住不 throw，看门狗必须能识别并中止它。
2. **永不因连接错误丢 turn**：连接类失败一律释放 claim、把 turn 留在可重抽态，绝不进入把 turn 标 terminal `failed` 的路径。
3. **恢复由事件驱动**：每当有新 turn 入队（或其他 flush 触发），就对被连接错误搁置的 turn 重试一次——而不是（仅）等一个固定的时间退避。空闲会话不空转重试；活跃会话下一个 turn 就带着把积压追平。

## User Stories

1. 作为用户，当我的网络瞬时抖动时，我希望记忆抽取只是暂缓而非永久停摆，这样网络恢复后记忆能自动补齐。
2. 作为用户，我希望网络恢复后**无需手动 kill 任何进程**，抽取就能在下一个 turn 到来时自动继续。
3. 作为用户，我希望**内容完全正常、只是撞上网络中断的 turn 不被丢弃**，这样我的会话摘要不会无声缺条。
4. 作为用户，当某个记忆 agent 因连接错误卡死在 0% CPU 时，我希望系统能自动检测并回收它，而不是让它无限占着 claim 把队列焊死。
5. 作为用户，我希望连接错误**不消耗 turn 的确定性重试配额**（不把网络问题算作 3-strike 里的一击），因为网络问题不是 turn 本身的问题。
6. 作为用户，当网络长时间（数小时）中断时，我希望重试按 turn 到来的节奏进行、不打紧循环、不刷屏日志，同时中断一结束就能立刻恢复。
7. 作为用户，如果会话在网络中断期间**结束**了（没有新 turn 来触发重试），我希望这些被搁置的 turn 在我下次开会话时被自动补收，而不是永久搁浅。
8. 作为运维（我自己），我希望连接错误与确定性内容错误在日志里可区分，这样我一眼能判断「抽取停了是网络问题还是 turn 有毒」。
9. 作为运维，我希望一次连接错误留下的痕迹是「turn 仍可重抽 + claim 已释放」，而不是「turn terminal failed + 已出队」，这样我不必手动救。
10. 作为下游的里程碑/画像消费者，我希望抽取只是延迟而非丢数据，这样打分与摘要在网络恢复后仍然完整。
11. 作为用户，我希望确定性的内容错误（agent 反复不 remember 必需 ID）**仍然**走现有的 derailment floor 终态路径——这次改动**只**放宽连接类错误，不削弱对真·毒 turn 的兜底。
12. 作为用户，我希望这套弹性对 summary/抽取 agent 与 dream agent 行为一致（连接错误不烧 attempt），不再是「dream 有看门狗、抽取没有」的割裂。

## Implementation Decisions

涉及模块：`src/worker/server.ts`（flush/work-unit 状态机、stall-watchdog、连接错误挂起/恢复）、`src/worker/error-classifier.ts`（connection/deterministic 分类）、`src/worker/query-session.ts`（agent 流消费）。不含 schema 变更。

### 1. 复用既有的连接错误挂起链，而非新建机制

现有 `suspendSessionAfterConnectionError` 已经做了正确的事：`resetClaimedQueueItemsForSession`（释放该会话所有 claim，turn 行不动）、清 buffer/batch、关 agent query、登记退避。**本 spec 不新建释放/重试机制，而是修复「什么情况能进入这条链」与「怎么恢复」。**

### 2. 修复 gap 1 —— 挂起不 throw 也能被回收

根因：agent 子进程撞 `ECONNRESET` 后内部重试再干等，**不向 worker throw**；worker 一直 `await`，永不进入 `flushOneBatchLocked` 的 catch，`suspendSessionAfterConnectionError` 永不触发。

- **stall-watchdog 必须能识别这种卡死。** 现有 watchdog 依据 `state.lastMessageAt`/`lastActivity` 判活跃，但 `onMessage` 对**每条**流消息（含 `system subtype=api_error`）都刷新这两个时间戳——于是 agent 一边刷 api_error 一边被判为「活跃」，watchdog 的停滞计时被反复重置、13 分钟没触发。**决定：api_error（连接类）流消息不计入「有进展」的活跃信号**——活跃应以「产出了抽取进展（assistant 文本 / remember 工具调用）」为准，而非「流上有任何字节」。
- watchdog 触发后中止 agent 时，**必须把该中止归类为 connection 并路由到挂起链**（释放 claim + 可重抽），而不是走确定性中止路径。

### 3. 修复 gap 2 —— 连接错误绝不进 derailment floor

根因：分类器保守（未识别的错误一律 deterministic），部分连接错误以 `server_error`/`stop_sequence` 形态浮现，被判 deterministic → 走 work-unit 状态机 → 撞 `DerailmentFloorError` → `applyFloor` 把无内容 turn 标 terminal `failed` 并出队（= T459–462 永久丢失）。

- **决定：把 agent 流上的 `system subtype=api_error`（connection 类）作为一等连接信号纳入分类**，使这类失败在到达 derailment floor **之前**就被识别为 connection、走挂起链。
- **derailment floor 只对确定性内容失败生效**（agent 反复不 remember 必需 ID）。连接类失败永不 finalize 成 `failed`。

### 4. 修复 gap 3 —— 恢复改为事件驱动

现状：`suspendedUntilBySession` 是固定时间退避（`CONNECTION_RETRY_BACKOFF_MS`），`drainQueue` 每次先删除到期的挂起项。

- **决定：被挂起的会话在「有新 turn-stop 入队」时即解除挂起并重试一次**（每次入队恰好一次尝试，天然按 turn 节奏限速——无紧循环、不烧确定性 attempt）。时间退避可保留为空闲会话的兜底下限，但活跃会话的恢复主路径改为事件驱动。
- 语义：连接错误 → 释放 claim + 会话进入「待下一个触发重试」态；下一个 turn-stop 的 scan 重新认领被释放的项、重跑一次；再失败则再释放、再等下一个触发。

### 5. 边界 —— 会话在中断期间结束

若网络中断期间会话结束（没有新 turn 来触发重试），事件驱动主路径不再有触发点。**兜底：`SessionStart` 的 `recoverStrandedTurns` 必须能重新入队「因连接错误被释放但未抽取」的 turn。** 需确认其覆盖「claim 已释放、status 仍非终态」的 turn（正常路径下这类 turn 不该是 `failed`，因为连接错误不再标 failed）。

### 6. 不改动的部分

- `resetClaimedQueueItemsForSession` 的释放语义、turn/observation 持久行不动的保证。
- 确定性内容错误的 3-strike / T2 corrective resend / T3 fresh-session / derailment floor 全链路。
- dream agent 的连接错误处理（已经「connection 不烧 attempt」，本 spec 使抽取 agent 与之对齐）。
- 分类器「未知错误默认 deterministic」的保守缺省——只**新增**对 api_error 流信号的 connection 识别，不放宽默认。

## Testing Decisions

好的测试只验外部可观察行为，不锁实现细节。此处的外部行为 = **给定一个「撞连接错误」的 agent，抽取流水线对 turn 行 / 队列 claim / 会话挂起态做了什么**。

**首选 seam（唯一、最高）**：`server.ts` 的 `main({ db, env, BunServeImpl, <injectable agent query> })`。既有 `tests/worker/server.test.ts` 已用 mock 驱动 `main()`，且 SDK query 可注入——本特性全部行为都能在这一个 seam 上驱动。

用可注入的 mock agent 模拟三种 agent 行为，断言外部结果：

1. **连接错误后挂起不 throw（gap 1）**：mock agent 发若干 `system subtype=api_error` 后**永不产出 assistant/remember**。断言：watchdog 在阈值内中止它、`resetClaimedQueueItemsForSession` 被调用（claim 释放）、turn 行**不**变 `failed`、会话进入待重试态。
2. **连接错误不进 floor（gap 3）**：mock agent 以 `server_error` 形态浮现连接错误。断言：turn **不**被 finalize 成 terminal `failed`、未出队。
3. **事件驱动恢复（gap 2）**：会话因连接错误挂起后，注入一个新的 turn-stop 入队；断言下一次 drain 重新认领被释放的项并重试一次（mock agent 这次成功 → turn 变 `extracted`）。
4. **确定性错误不受影响（回归）**：mock agent 反复不 remember 必需 ID → 断言仍走 corrective resend → floor → 无内容 turn 仍 `failed`（现有行为不回退）。
5. **stranded 兜底（边界）**：连接错误释放后会话结束，`SessionStart` 触发 `recoverStrandedTurns` → 断言被释放未抽取的 turn 重新入队。

**单元测试**：`error-classifier.ts` 已有测试——**扩展**其覆盖到「api_error 流信号 → connection」，不改「未知 → deterministic」缺省。

**Prior art**：`tests/worker/server.test.ts`（mock 驱动 main + 断言队列/turn 行）、`error-classifier` 现有单测、diary-runtime 连接错误不计 attempt 的既有测试。

## Out of Scope

- **救本次已丢的 T459–462**：用户明确不救，接受这 4 条损失。本 spec 只防未来。
- 队列孤儿陈垢清理（~2300 个旧 obs claimed 项）——独立的队列卫生工作。
- 任何 schema 变更 / 版本号变更 / 产物重建（由发布流程另行处理）。
- 网络本身的稳定性（用户自建代理栈）——那是环境问题，本 spec 只让 mnemo 对瞬时网络错误有弹性，不负责网络不断。
- dream agent 逻辑改动（已合规，仅作为对齐参照）。

## Further Notes

- **本质 vs 偶然复杂度**：连接错误的正确处理（释放 + 退避重试）**已存在**，本 spec 是修补三处「进不去 / 进错门 / 恢复太钝」的缺口，不是新增第二套机制——刻意避免再造轮子。
- **一句话根因**：`onMessage` 把「流上有字节」当「有进展」，使 api_error 洪流反而喂饱了 watchdog；叠加保守分类器把部分连接错误判成确定性、送进只会标 failed 的 floor。两者合力，把一次瞬时网络抖动放大成永久停摆 + 4 个 turn 永久丢失。
- 本事故的完整诊断链（挂起 agent 焊死队列 / kill 子 agent 触发 worker 自替换 / `ANTHROPIC_BASE_URL=proxy.moedb.moe` 是失效残留环境变量的红鲱鱼）值得同步进 `reference_worker_health_check` 运维记忆。
- 约束（沿用本项目惯例）：实现者不执行任何 git 命令、不改版本号、不重建 `plugin/scripts/*.cjs`、不触碰 `~/.claude-mnemo` 线上数据；`bunx tsc --noEmit` 通过、`bun test` 相对基线不回退。
