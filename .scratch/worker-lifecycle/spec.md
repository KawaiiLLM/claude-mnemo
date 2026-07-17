# Spec: Worker 事件驱动生命周期与错误分类

**Status:** ready-for-agent

## Problem Statement

worker 的后台生命周期与错误处理有三个问题，共同导致「关掉 CC 之后系统在做什么」不可预期：

1. **网络错误被升级为永久失败。** flush 的重试预算只数次数、不分错误类别：断网时队头批次约 1–2 分钟烧完 3 次尝试即 dropped（提取永久丢失，仅剩 reminder 补偿），随后下一批继续烧——持续断网会把积压顺序丢光。这与 2026-07-15 的 dream 被两次瞬态 ECONNRESET 打成 `terminal=1` 是同一根因：瞬态环境故障被计入与确定性失败相同的重试预算。
2. **worker 生命周期与 CC 使用脱钩。** 关闭 CC 后 worker 与各记忆 agent 还挂 30 分钟才退出；resume 看一眼 session（不产生任何 turn）就关闭，SessionEnd flush 会 spawn worker、触发 boot 全局排空、为只看了一眼的 session 重建记忆 agent 上下文。用户无法确信「CC 关了 = 没有任何后台 Claude 请求」。0.4.0 的 $19/天事故（idle watchdog 重试循环）证明了失控后台 agent 的爆炸半径。
3. **已关闭的 batch 在队列白等。** 只有尾部 batch 是合并目标；非尾部 batch 永远不可能再合并，却要等溢出（>3）或 keepalive（缓存到期前 60 秒窗口）才被消费。cold session（从未 push 过）的 keepalive 永不触发，closed batch 可能一直趴到 session end。单个 ≥ 合并阈值的非流式 turn 会独占一个名义开放、实际不可能再合并的尾部 batch 白等。

事实澄清（动机校准）：空闲 worker 本身烧零 token（keepalive 空队列即返回）。本改动不减少 token 总量，动机是**爆炸半径控制**（死掉的 worker 不可能失控）、**行为不变量**（关闭即静默）与**网络错误不再丢提取**。

## Solution

从用户视角，建立一条可证的不变量：**CC 关闭约 1 分钟后，系统不再发出任何 Claude API 请求；网络故障只导致提取延迟，永不导致提取丢失。**

- **错误分两类。** 连接类（网络断开、连接重置、stall 中断、shutdown 中断）→ 释放工作回队列挂起，不消耗任何重试预算，恢复后任意 wake 自动继续；确定性（API 4xx/5xx 状态错误、derailment floor）→ 维持现行有界重试 + dropped reminder。
- **消费只由 turn-stop 驱动。** SessionStart 与 glance-resume 不触发任何排空、不建任何记忆 agent；记忆 agent 的缓存热度天然跟随主 agent。
- **SessionEnd 60 秒收尾。** 正常退出后限期消费该 session 剩余 turn，完成即关闭其记忆 agent；超时或遇连接类错误直接中断，turn 回到未提取状态，不重试，等下次使用时顺带处理。
- **全部记忆 agent 关闭即停 worker。** dream 在跑则中断（不计尝试次数）；30 分钟空闲定时器保留为崩溃路径的兜底。
- **不可能再合并的 batch 立即消费。** 队列稳态只保留一个等待合并的开放尾部 batch。

## User Stories

1. 作为系统运营者，我希望断网时 flush 失败不消耗重试次数、不产生 dropped，这样持续断网不会把积压的提取顺序丢光。
2. 作为系统运营者，我希望网络恢复后任意 session 的 turn-stop 都会让挂起的工作自动继续，这样恢复不依赖某个特定 session 重新打开。
3. 作为系统运营者，我希望确定性错误（API 4xx 等）仍走 3 次上限并打 delivery-dropped reminder，这样毒批次不会永久阻塞队头。
4. 作为系统运营者，我希望 stall-watchdog 对卡死请求的中断被归为连接类，这样一次静默网络故障不会计入重试预算。
5. 作为系统运营者，我希望 diary/dream 的 attempt 计数共用同一错误分类（连接类不计入），这样 2026-07-15 型的瞬态 ECONNRESET 不再把一天打成 terminal。
6. 作为系统运营者，我希望 SessionStart（含 resume）不触发排空、不重建记忆 agent，这样打开看一眼不产生任何 API 消费。
7. 作为系统运营者，我希望 glance-resume 后关闭不 spawn worker，这样 SessionEnd 只在本次运行产生过新 turn 时才有后续动作。
8. 作为系统运营者，我希望遗留的未提取 turn 在下一次任意 session 的 turn-stop 时顺带处理，这样延迟提取不需要专门的恢复入口。
9. 作为系统运营者，我希望 SessionEnd 后 60 秒内完成剩余提取并关闭该 session 的记忆 agent，这样正常退出有一个有界的收尾。
10. 作为系统运营者，我希望收尾超时或遇连接类错误时直接中断并把 turn 重置为未提取状态，这样 CC 关闭约 1 分钟后没有任何残留请求。
11. 作为系统运营者，我希望部分完成的批次可以安全重投递，这样收尾中断不产生半提取的脏状态。
12. 作为系统运营者，我希望所有记忆 agent 关闭、且无排空与 HTTP 在途时 worker 立即退出，这样 worker 的存活期与实际工作严格对齐。
13. 作为系统运营者，我希望 worker 退出时若 dream 在跑则中断且不计 attempt、不写失败记录，这样「恰好在补跑时关 CC」不会累积成 terminal。
14. 作为系统运营者，我希望被中断的 dream 只丢弃 staging 半成品、线上记忆零污染，且下次 turn-stop 时自动重新补跑。
15. 作为系统运营者，我希望 30 分钟空闲兜底定时器保留，这样 SessionEnd 未触发（崩溃、强杀）时 worker 仍会退出。
16. 作为系统运营者，我希望新 turn 入队时 worker 与对应记忆 agent 按需自动拉起，这样关停不需要任何手动恢复。
17. 作为系统运营者，我希望多 session 并存时一个 session 的结束只关闭它自己的记忆 agent，这样其余 session 的处理不受影响。
18. 作为系统运营者，我希望不可能再合并的 batch（非尾部、或单批已达合并阈值）在排空收尾立即消费，这样提取延迟不再依赖 keepalive 时机。
19. 作为系统运营者，我希望慢 LLM 调用不发生在逐 turn 的排空路径上，这样突发多 turn 时后续 turn 的处理不被串行阻塞。
20. 作为系统运营者，我希望断网挂起的 session 有轻量退避，这样断网期间的反复 wake 不会每次都白试一次连接。
21. 作为开发者，我希望错误分类器是一个可独立单测的纯函数，这样三个消费方（flush、diary、dream）的分类语义有单一事实源。
22. 作为开发者，我希望生命周期语义（挂起、收尾、退出）能在 worker core 层用注入依赖与内存数据库断言，这样不启动真实 agent 就能回归。

## Implementation Decisions

- **错误分类器**：新增单一纯函数模块，输入任意 error，输出 `connection` 或 `deterministic`。连接类涵盖 SDK 的 APIConnectionError、ECONNRESET / ENOTFOUND / ETIMEDOUT / EAI_AGAIN / fetch failed，以及两类内部中断——stall-watchdog abort 与 shutdown abort（两者需在抛出处打标，使分类器可识别）。无法识别的错误归为确定性（保守：宁可有界重试也不无限挂起）。三个消费方：mini-turn flush、diary attempt 计数、dream attempt 计数。不做主动网络探测，分类只基于错误对象。
- **flush 挂起语义**：连接类失败不递增批次 attempts，改为释放该 session 全部批次的队列 claims、清空其内存批次、关闭其 query session（复用崩溃恢复的既有语义，按 session 粒度执行）。条目回到无主状态后，任何全局排空自然重新认领、重建批次、重试。确定性失败维持现行 retryLater / dropped 状态机。per-session 记录下次重试时刻做轻量退避。
- **消费触发权收敛**：SessionStart 的 best-effort wake 不再触发排空；SessionEnd flush 由 hook 侧判定门控——仅当该 session 存在晚于本次运行 start 的新 turn 才通知（一个 SQL 判断）；worker boot 不再无条件全局排空，排空仅由 turn-stop wake 与门控后的 SessionEnd flush 发起。
- **SessionEnd 收尾**：60 秒 wall-clock 预算（入 config，默认 60_000ms），限期执行「排空该 session 队列 + flush 全部批次」；到期或遇连接类错误即中断在途推理（杀 query 子进程）、释放 claims、关闭 agent。实测校准：单批提取中位 6–7 秒、p90 约 20 秒（对两个真实 memory agent 的 46+55 次推送实测），60 秒通常容纳尾部 1–2 批。
- **worker 退出条件**：无存活 query session、无全局排空在途、无 HTTP 请求在途、dream 未在跑（或已按下述规则中断），四条同时满足即触发既有的优雅退出。现行 30 分钟 HTTP 空闲定时器保留为兜底。此前已确认 `/flush` 是 fire-and-forget、HTTP 返回时 activeRequests 已归零，故「无排空在途」守卫为硬性要求。
- **dream 中断**：shutdown 中断不写失败记录、不递增 attempt 计数，重置下次尝试时刻为立即可做；staging 目录半成品直接丢弃（0.4.2 staged-commit 已保证线上记忆零污染）。凌晨 4 点仅为内容日界，dream 本就是排空时机会主义补跑（reconcile 单日 + 继续调度），调度语义不变。
- **closed-batch 立即消费**：排空收尾处统一 flush 所有非尾部 batch，以及「尾部但累计尺寸已达合并阈值」的 batch；开放尾部 batch 继续等待合并（现状）。flush 不在逐 turn 的 enqueue 路径上同步发生。maxQueuedBatches=3 保留为溢出保险，不再是常态停留点。
- **不改的**：合并阈值（1000 字符）与合并逻辑本身；dropped reminder 机制（保留给确定性错误）；dream 的 2 次尝试 → terminal 语义（`.scratch/dream-retry-policy/`，本案只叠加「连接类与 shutdown 中断不计次」）；懒启动 spawn 机制。

## Testing Decisions

- 好测试只断言外部可观察行为：pending_queue 的条目与 claims 状态、turns 的 tags/status、HTTP 端点契约、优雅退出是否被触发、diary_day_state 的 attempt/terminal 字段——不断言内部函数调用序列。
- **错误分类器**：纯函数单测，覆盖 SDK 错误类型、Node 错误码、打标中断、未知错误的保守归类。
- **flush 挂起语义**：以现有 flush-retry 测试为先例（注入 fake 推送使其抛指定类别错误），断言连接类下 claims 被释放、attempts 不变、无 dropped tag；确定性下维持 3 次 → dropped。
- **触发权门控**：以现有 hooks 测试为先例（内存 DB + handler 依赖注入），断言 glance 场景 SessionEnd 不发 flush、有新 turn 场景发。
- **收尾与退出**：以现有 worker server 测试为先例（注入 fetchImpl / spawnImpl / now），断言 60 秒预算到期后 claims 释放、query session 关闭、四条件满足时优雅退出被调用、dream 在跑时被中断且 attempt 不增。
- **dream 中断**：以现有 dream-job 测试为先例，断言 shutdown 中断后 attempt_count 不变、next_attempt_epoch 重置、staging 无残留提交。

## Out of Scope

- STALLED_QUERY_MS、重试节拍等超时常量的可配置化。
- summary agent 本身的成本优化（每 session 数美元级，为另一量级的问题，另案处理）。
- 2026-07-15 terminal 日的手动重触发（运维动作，走既有 `POST /dream`）。
- 基于主动探测（HEAD 请求等）的网络状态判定。
- dropped reminder 机制与 derailment floor 的语义改动。

## Further Notes

- **后果（已与用户确认接受）**：所有延迟工作（断网存量、错过的 dream）集中在下次使用 CC 的首个 turn-stop 处理，总量不变、时段集中；dream 补跑需要一段约 2–5 分钟的连续使用，被关闭中断则等下次。
- resume 场景的记忆 agent 缓存实践中必然是冷的（下次 resume 多在缓存 TTL 之后、且退出前 compact 已重写前缀），故「立即关 agent」无缓存损失。
- 本案与 0.4.1 的 dream-retry-policy 正交叠加：那里定义「尝试几次、何时 terminal」，这里定义「什么算一次尝试」。
