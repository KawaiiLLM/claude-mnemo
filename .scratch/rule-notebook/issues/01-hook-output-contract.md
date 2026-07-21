# 01 — Prefactor：hook 输出契约按事件参数化

**What to build:** hook 命令的输出层能为任意 hook 事件产出正确的 `hookSpecificOutput.hookEventName`，不再硬编码 SessionStart。这是纯 prefactor：所有既有 hook 行为（SessionStart 注入、PreCompact 等）保持逐字节不变，为后续三个分发器（UserPromptSubmit / PreToolUse / PostToolUse）铺平输出通道。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] 输出层接受事件名参数，产出的 JSON 中 `hookEventName` 与调用事件一致
- [ ] 既有 SessionStart / PreCompact / PostCompact 路径回归测试全绿，输出无任何变化
- [ ] 新事件名（UserPromptSubmit / PreToolUse / PostToolUse）在既有 hook 契约缝（stdin fixture → stdout 断言）下有单元测试覆盖
- [ ] 不修改 hooks.json 注册（属票 03）

## Comments
