# 04 — 补齐 UserPromptSubmit / PostToolUse 分发器

**What to build:** 同一分发器扩展到其余两个事件：用户 prompt 命中 `kind:"prompt"` 关键词（any/all 语义、每词 ≥3 字符）注入任务型提醒；工具结果头部 8KB 内命中 `kind:"result"` 固定子串注入诊断型经验。三事件的 `hookEventName` 各自正确，节流与 sidecar 行为与票 03 一致。

**Blocked by:** 03

**Status:** ready-for-agent

- [ ] prompt 关键词 any/all 两种语义的命中/不命中测试
- [ ] result 匹配只扫结果头部 8KB（超长结果构造用例证明尾部不触发）
- [ ] 三事件 stdin fixture 各自产出正确 `hookEventName`
- [ ] prompt 事件的 hit 身份摘要为 prompt 前 200 字符摘要
- [ ] hooks.json 注册两事件；p95 基准对三事件仍成立

## Comments
