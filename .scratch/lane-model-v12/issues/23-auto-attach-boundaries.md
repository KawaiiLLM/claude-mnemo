# 23 — 自动挂靠保留,边界钉死

**What to build:** 自动挂靠留下来;但「什么时候挂」「detach 之后还挂不挂」必须有确定答案。

**Blocked by:** None。

**Status:** done(未发版)

## 裁决(用户,2026-08-26)

> 可以自动挂靠。

保留。但 peer 指出**现在的实现不是票面写的那个**,有两处边界没定,本票钉死。

## 现状与票面不符

票面写的是「**第一次**把某个段 tag 写进 `tags` 时挂靠」。实际实现(`src/mcp/note.ts:972-1001`)是:**任何一次写完后该 turn 属于某段、且会话尚未挂靠,就挂靠** —— 而且 **detach 之后再写会重新挂上**。

## 两处边界(按 peer 建议实现,除非另有裁决)

- [x] **只对 caller 自己当前会话的 turn 自动挂靠。** 跨会话 `note` 不得把 caller 会话挂到 target turn 所属的段上 —— 否则维护一条历史 turn 会改变当前会话的注入面。
      —— `src/mcp/note.ts` 自动挂靠那个 if 里加 `!isCrossSessionWrite(callerSessionId, turn.sessionId)`。turn 自己的会话也不挂:它没有发起这次调用。
- [x] **显式 detach 在该会话内是 sticky 的**:detach 之后,后续归属写**不再**自动重挂;要回来走菜单或 `remember(attach)`。理由:detach 若不 sticky 就没有稳定语义,等于没有这个动词。
      —— 记账落在新表 `segment_detachments(session_id, segment_id)`,与 `segment_attachments` 同键同级联;**只有自动挂靠读它**,所以既有的绑定读者(注入、卡片、结算 scope)一个都不用加过滤条件。两张表按 pair 互斥:attach 删拒绝行,detach 删绑定行并写拒绝行。
- [x] 票面措辞同步成实际语义(「首次归属写」→「归属写且尚未挂靠且未被显式 detach」)。—— 票 17 的自动挂靠一节。
- [x] 测试:跨会话 note 不挂靠;detach 后重写不重挂;菜单/`attach` 仍能挂回来。
      —— `tests/hooks/session-attach-flow.test.ts` 的 `ticket 23 — auto-attach's two boundaries`(5 条);存储侧契约在 `tests/mcp/remember.test.ts` 的 `detach` 块(5 条)。
- [x] 突变验证:去掉 sticky、去掉 caller-session 限制,各有点名的测试变红。

## 两处裁量(实现时定的,记在这里而不是藏在代码里)

1. **拒绝按 (会话, 段) 记,不是按会话开关。** 动词的宾语是段;一个会话级「自动挂靠 off」会连用户从没点过名的段一起否掉,而票 17 之所以要自动挂靠,就是为了化解「要看 lane 得先有卡片、要卡片得先挂靠」的循环 —— 对没被拒绝的段,这个理由依然成立。detach E5 不说明 E9 的任何事。
2. **带 `id` 的 detach 即使当时没有绑定也记账**;不带 `id` 的裸 detach 只对它真正删掉的那些 pair 记账。裸形式没有点名任何段,而拒绝必须是关于某个段的 —— 所以「一个绑定都没有时的裸 detach」是真正的空操作,不是一个常驻的「永远别自动挂我」开关(本票没有要这个开关)。
