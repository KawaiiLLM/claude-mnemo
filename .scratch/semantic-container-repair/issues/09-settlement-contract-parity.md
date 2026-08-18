# 09 — 结算侧写入受同一套契约约束

**What to build:** 结算 subagent 的笔记写入走主 agent 的字段卫生与预算规则；结算提示里的 tags 教法换成已裁决的词汇表。

**用户裁决：** T808「≥2× 直接拒绝」；T830「subagent 用同一套注入和工具」；T820「turn 的 tags 字段，应该至少有一个粗粒度标签，例如项目本身的名字 claude-mnemo，然后才是一些细粒度标签…不需要表达和 type 重叠的部分，如 xxx-design」。

**三处偏差：**
- **预算不约束结算**：2× 硬拒收只在 `src/mcp/note.ts:901,909,917`（turn）与 `:1154`（session title）生效；`src/worker/note-settlement-turn-facade.ts:383-403` 只检查非空，而结算的重建职责（`note-settlement-prompt.ts:291+`）同样在写 title/content/insight，无上限、无收据。
- **边界差一**：`src/shared/note-budget.ts:98` 是 `if (count <= limit) return null`，所以**恰好 2×** 会通过。裁决是「≥2× 直接拒绝」。
- **tags 教法冲突**：主 agent 面写对了（`src/mcp/definitions.ts:243-248`），但 `src/worker/note-settlement-prompt.ts:180-181` 教结算的是「tags are bare topic words」——粗粒度项目标签、名词规则、活动词禁令全缺。而结算给每个窗口的每个 turn 写 tags，提案又靠粗粒度标签路由。

**顺带**：`src/worker/note-settlement-sdk-query.ts:116/122` 的 commit 描述仍让子 agent「fill the gap with more `note`/`segment` calls」，而 `segment` 工具已退役。

**Blocked by:** None

**Status:** ready-for-agent

- [ ] 结算的笔记写入调用与主 agent 相同的字段卫生与 2× 拒收
- [ ] 恰好 2× 被拒绝
- [ ] 结算提示的 tags 段落引用同一份词汇表文本，不再自己复述
- [ ] 已退役的 `segment` 工具名从所有提示文案中清除

> **⚠ 部分失效**：`.scratch/ownership-and-note-cadence/spec.md` 把归属与笔记重建移出结算，本票的立论已被取代，实施前先读该 spec 的 Further Notes。
