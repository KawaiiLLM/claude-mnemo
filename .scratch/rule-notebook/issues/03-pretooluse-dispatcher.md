# 03 — Tracer bullet：PreToolUse 分发器端到端

**What to build:** 第一条完整闭环的运行时半程：种一条 `kind:"tool"` 规则（如「Bash 无 timeout 参数则提醒」），经索引渲染后，真实的 PreToolUse hook 调用会向当班 agent 注入 additionalContext tip，并向 sidecar 追加一条带唯一 `hit_id` 与身份摘要的 hit 记录。含 hooks.json 注册与发布守卫，装上即可在真实会话演示。

要点（详见 spec「运行时推送」）：

- 分发器为现有 hook 命令入口的新子命令，只读编译索引，不读 DB
- 节流：每规则每会话至多一次（会话级状态文件）、单事件至多两条
- sidecar：O_APPEND 按日文件，hit 记录含 `hit_id`（uuid）、`content_session_id`、事件类型、`ts_ms`、规则 id、工具名 + `tool_input` 前 200 字符摘要（hook 输入含 tool_use_id 则一并记）
- p95 ≤ 50ms：固定 fixture（满额 10 条规则索引）、预热后 100 次采样取 p95 断言
- 发布守卫补入分发器脚本

**Blocked by:** 01（输出契约）、02（索引 renderer）

**Status:** ready-for-agent

- [ ] stdin fixture → stdout 断言：命中注入 / 不命中静默 / 同会话第二次命中不再注入 / 三条命中只出两条
- [ ] sidecar 行内容与格式断言（hit_id、身份摘要齐全）
- [ ] scope 过滤：非本项目规则不进候选池
- [ ] p95 基准按 spec 度量协议通过
- [ ] hooks.json 注册 PreToolUse；发布守卫测试更新并全绿

## Comments
