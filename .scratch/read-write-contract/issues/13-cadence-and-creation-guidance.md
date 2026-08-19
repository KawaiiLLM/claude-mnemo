# 13 — 节奏统一与建段指导

**What to build:** 所有会话每 20 turn 收到一次 remember 检查提醒(不分有无挂靠);建段判断原则入 rubric;remember 工具描述补时机。

规范:spec「节奏与建段指导」节([S15069/T978] 裁决)。

- **统一提醒**:UserPromptSubmit 通道渲染一行 remember 检查提醒,计数=自上次 remember 调用起 20 turn;note 积压 >5 的 backlog-relief 行为保持(阈值核对为 5,不符则调)。段卡片头的 `MAINTENANCE_CADENCE` nudge 后缀退役(职能并入统一提醒;`segment-cadence.ts` 常量随消费者处置)。
- **rubric v2→v3**,增「建段」节(正式文本,verbatim 入 `MEMORY_RUBRIC_TEXT`):
  - 琐碎、短时闲聊等组不成可命名工作流的 turn 无须建段;无归属是合法状态
  - 需要建段时,先查 roster 有无合适的已有段——挂靠优先于新建
  - 无合适段才新建;以任务实际形状命名,开场臆测的名字会锚定错误
  哈希守卫/双渲染自动跟随,单一家园 grep 守卫保持绿。
- **remember 描述**补时机行(20 轮提醒到达时检查归属/Working State/是否建段挂靠),判断原则指向 rubric,不复述。

**Blocked by:** 11(definitions.ts 领地)。

**Status:** ready-for-agent

- [ ] 零挂靠会话第 20 turn 收到 remember 提醒(构造性测试);挂靠会话同样
- [ ] 卡片头 nudge 无功能性残留(grep)
- [ ] rubric v3 双渲染字节同一、grep 守卫绿;建段三条 verbatim
- [ ] remember 描述含时机行且不复述判断
