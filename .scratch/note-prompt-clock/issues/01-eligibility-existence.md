# 01 — 资格塌缩:存在即可写

**What to build:** note 与 skip 对本会话任何已存在的 turn 一律可写,资格判定不再读债务台账。拒绝消息只陈述可验证的事实(turn 不存在 / 属于别的会话)。replace 与 crossSession 守卫行为不变(会话归属锚 = process_session_map 多键映射,已在线,见 spec D5)。compact 标记行的拒绝随 03 的过滤口径落地,本票对这类行暂时放行。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] 零工具调用的已结束 turn(T553/T562 类)可写、可 skip
- [ ] 被打断(无 Stop 事件)的 turn 可写
- [ ] 对不存在 turn 与他会话 turn 的拒绝消息只陈述该事实,不再出现「owes no note」及台账措辞
- [ ] replace(已有笔记需声明覆盖)与 crossSession(跨会话需声明)回归不变
- [ ] skip 对已有笔记的 turn 仍为 no-op
- [ ] 资格路径零处读 note_debt
