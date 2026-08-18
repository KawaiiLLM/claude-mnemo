# 04 — session 六列退役与会话卡块移除

**What to build:** session 只剩 title+content 两个语义面;SessionStart 无会话卡块。

规范:`.scratch/ownership-and-note-cadence/spec.md`「session 字段」节([S15069/T910]–[T913])。

- `insight`/`next_steps`/`decision`/`done`/`current`/`reference` 六列退出**全部读写面**:注入、recall 渲染、summary 查询、工具面。物理删列可押后(历史数据保留无害),但任何 reader 不得再渲染它们。
- **会话卡注入块不设**(v1):current-session 区块从 SessionStart 组合移除;resume/compact 的再锚定由 CC 自身的 compact 摘要与挂靠段块覆盖。
- recall 的 session 头 = title + content(episodic 叙事)。
- `content` 列**保留存储**——票 09 的结算写者启用它;本票不动任何写路径。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] 六列不再出现在任何渲染/注入输出
- [ ] SessionStart 组合无会话卡块
- [ ] recall 的 session 头只渲染 title 与 content
- [ ] content 的存储与既有读取不破坏(为 09 留路)
