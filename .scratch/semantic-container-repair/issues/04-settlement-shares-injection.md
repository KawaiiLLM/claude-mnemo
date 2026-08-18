# 04 — 结算子 agent 用同一套注入，而不是手搓的一行标题

**What to build:** 结算提示里的挂靠段部分改用主 agent 的段块渲染器（`renderAttachedSegmentBlock` 的 fields 与 milestones），删掉已退役的两个块。

**用户裁决：** T830「subagent 用同一套注入和工具，但是 commit 提交才应用修改」。ADR-0007 进一步写明「the same injection and the same tool quartet as the main agent … **not a dedicated facade set**」，spec:128-129「no dedicated injection renderer」。

**实现现状：**
- `src/worker/note-settlement-context.ts:332` 仍喂 `renderSessionMilestoneInjection`——正是票 10 要消灭的 2500 token 旧里程碑块；`:343` 仍喂票 09 已退役的会话状态块（且仍渲染 ADR-0006 已退役的 session `content`/`insight`）。
- `src/worker/note-settlement-prompt.ts:131-147` 是手搓渲染器，每个挂靠段只输出 `[E<n>] [status] title` 加 content/insight 预览，**六个 Working State 字段一个都没有**。
- `:272` 的注释称之为「the block the main agent is shown at SessionStart」，该描述现在两头都不成立。

**后果：** 结算 agent 判断成员归属时对段的 goal/constraints/decisions 完全不可见，而归属判断正是它仅存的段权限。叠加 `content`/`insight` 无写入者，它实际只看到一行标题。

**Blocked by:** None（票 10 的渲染器已在 `src/hooks/session-composition.ts`）

**Status:** ready-for-agent

- [ ] 挂靠段部分由 `renderAttachedSegmentBlock` 组装，不存在第二个段渲染器
- [ ] `milestoneRendering` 与 `sessionStateRendering` 两个已退役块从结算上下文移除
- [ ] 结算 agent 能看到段的 decisions/next_steps/constraints
- [ ] 描述性注释与实际组装一致，不再声称与 SessionStart 相同而实际不同

> **⚠ 部分失效**：`.scratch/ownership-and-note-cadence/spec.md` 把归属与笔记重建移出结算，本票的立论已被取代，实施前先读该 spec 的 Further Notes。
