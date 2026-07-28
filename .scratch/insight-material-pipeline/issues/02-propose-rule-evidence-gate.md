# 02 — propose_rule 证据硬校验（C）

**What to build:** dream 提出新规则时，工具端机械拒收证据不足的提案。新建规则（无 add_evidence_to）强制：evidence ≥2 项；ref 匹配 `^S\d+/T\d+$`；每个 ref 解析到真实存在的 turn（session 存在且该 prompt_number 的 turn 归属于它，悬空引用拒收）；去重后 ≥2 个不同 turn；全局 scope 须跨 ≥2 个不同真实 session。拒收沿用判重先例的结构化返回 `{ status: "rejected", reason: "insufficient_evidence", detail: <缺什么> }`，不 throw。

校验只加在 propose_rule 处理器的新输入边界（独立的更严输入校验），不收紧共享的 evidence 持久化 schema——存量 evidence 与既有事件重放必须继续可解析。处理顺序固定：既有边界检查（目标规则存在、tombstone、event uid——语义与现状完全一致，不改 throw 行为）→ 新增证据校验（结构化拒绝）→ 判重（结构化拒绝）→ 写入。`add_evidence_to` 豁免数量/跨 session 门槛，但逐项校验 ref 格式与真实存在。

**Blocked by:** None — can start immediately.

**Status:** done (2026-07-28, codex; 验货通过)

- [ ] 0/1 条 evidence → 结构化拒绝（reason: insufficient_evidence）
- [ ] 2 条 ref 指向同一 turn → 拒绝
- [ ] 全局 scope + 2 个不同 turn 但同一 session → 拒绝；跨 2 个 session → 接受
- [ ] 非法 ref 格式 → 拒绝且 detail 指明格式问题
- [ ] 悬空引用（格式合法但 session/turn 不存在或归属不符）→ 拒绝
- [ ] 证据不足且与既有规则相似 → 先收到 insufficient_evidence（处理顺序测死）
- [ ] add_evidence_to 带 1 条真实 evidence → 仍接受（门槛豁免，但格式/存在性仍校验）
- [ ] 存量已持久化的 evidence（含非规范 ref）在读取与事件重放路径仍可解析（回归保护）
- [ ] 全量 bun test 绿（HOME 沙箱内）
