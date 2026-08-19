# 04 — 触发与窗口重定标

**What to build:** 结算窗口变为 [25,50];compact/sessionend 不再触发;前序注入与窗口等量且 prompt 统一渲染;backfill 无前序、上限 100。

规范:spec「触发与窗口」([S15069/T963] 裁决)。

- 门槛 25 个连续已定型 turn;单次窗口上限 50(攒 60 → 切 50 留 10)。
- **唯一自动触发=turn-stop 规划**:compact/sessionend 的触发路径降级移除(理由入码注:结算读库不读活上下文);残余搭车通道保持、只挂 turn-stop;era 开关不动。
- 已接受后果(入码注/测试):会话终止时不足 25 的尾巴不结算。
- 前序注入数量=本窗口 turn 数;**prompt 删「Preceding turns (context only)/Window turns (settle exactly these)」两节结构,统一渲染统一语义**——窗口边界只是作业记账。reviewableTurnIds 机制保留(=全部渲染 turn),门落地(05)后被授权吸收。
- backfill(手动 /settle):无前序注入,单次上限 100 turn。
- 领地:规划层+结算 context/prompt;**不碰写 facade/staging**(05 领地)。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] 24 个 turn 不成窗、25 成窗、60 切 50 留 10
- [ ] compact/sessionend 事件不再产生作业(既有对应测试改写)
- [ ] prompt 无两节之分,前序=窗口等量;25 窗渲 50 个 turn(25+25)
- [ ] backfill 无前序、101 个被拒或截到 100(择一,报文说明)
