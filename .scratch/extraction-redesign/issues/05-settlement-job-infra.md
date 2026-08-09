# 05 — 结算作业基建：触发、durable job、派发（P2）

**What to build:** 结算的调度骨架（spec D9），本票用桩载荷（no-op 子进程）打通，真实结算调用在票 07。触发器恰为两个：**会话内连续 50 已提取 turn 攒满**（自游标起 prompt_number 连续前缀全部 extracted/skipped）与 **compact**（以捕获修复后的 boundary marker 为准；双触发并发到期先到先得，同一 turn 只属一个窗口）。显式不触发：sessionEnd、resume、worker 启动、定时器。**compact 最小窗口门**：到期时未结算连续前缀 <20 turn（建议值，与残留谓词共用，试运行校准）不派发，窗口攒到下次触发；连续 50 自带阈值不受影响。作业落库先行：identity=(session, 窗口起点, 触发类型) 唯一，claim/lease/generation，attempts+retry_at 指数回退（时间戳比较，无定时器，下次任意触发顺带检查），lease 逾期回收即消耗一次 attempt，封顶 3 次后终态、游标照走。优雅退出窗口（60s）内只落作业不派发。残留会话附带结算：已关闭判据 = 无活跃注册且最后活动 >24h；**派发另需残留 ≥20 turn——低于阈值不派发也不写任何终态标记（现算谓词：会话重开即回活会话路径续攒），其 pending 不做额外清扫**；认领时先将其全部 pending 转 skipped(reason=closed)，其中「中间洞」交票 07 补写；每触发至多 2 个残留会话、最老优先、每会话单独派发（裁决 11/18/19）。

**Blocked by:** 03（需要笔记与状态数据使窗口有意义）。开工前提：P1 三指标过门槛、用户裁决进入 P2。

**Status:** ready-for-agent

- [ ] fake-clock 测试断言：恰在 {连续50, compact} 派发，sessionEnd/resume/启动/退出路径零派发
- [ ] 回退时刻表、lease 回收消耗 attempt、3 次封顶终态跳过，全部可测
- [ ] 残留会话：24h 判据、残留 ≥20 才派发（<20 零派发零状态写入，重开后回活路径）、认领清 pending、每触发上限 2、单会话单作业
- [ ] compact 最小窗口门：前缀 <20 不派发、跨触发累积后一次结算（fake-clock 断言）
- [ ] 迟到子进程结果因 generation 不符被拒（桩载荷模拟）
- [ ] worker 全生命周期无 LLM 调用（含本票新增路径）
