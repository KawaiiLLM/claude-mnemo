# 22 — 会话结算回到结算职责里

**What to build:** 结算顺便维护会话本身的字段 —— 它一直有这个能力,票 15 只删掉了指令。

**Blocked by:** None。

**Status:** ready-for-agent

## 裁决(用户,2026-08-26)

> dream agent 已经废止,不用管;**session 结算也可以顺便维护了**,好像就一个 title 吧。

## 一处事实订正

不止 title。`src/worker/note-settlement-turn-facade.ts:514` 显示 session 分支写的是 **`title` 与 `content` 两个字段**(`sessionFields = ["title","content"]`)。裁决按「顺便维护会话字段」执行,两个字段都在内。

## 背景

票 15 把结算收成「exactly two duties」,于是我让 worker 连**第三条 SESSION NARRATIVE** 一起删了 —— 能力还在(`note(session=…)` 仍然接受),指令没了,成了一条只写不读的通道。本票把它补回来。

- [ ] 结算 prompt 恢复会话维护那一段;职责数从「两件」改为**三件**(turn 字段 / lane 词表 / 会话字段),措辞与另外两条同一风格。
- [ ] 描述与 prompt 一致:`note(session=…)` 写 title 与 content。
- [ ] 票 15 曾把 `## Session summary (the block the main agent is shown at SessionStart)` 这个标题判为**事实错误**(会话摘要不在 D3f 的五个注入块里)—— 恢复时**不要把那个错标题一起带回来**。
- [ ] `propose_rule` / 规则台账**不动**:dream agent 已废止,那条通道不再是问题,也不必清理。把这个结论写进票 16 留下的那个未决项,让它闭合。
- [ ] 测试:一条断言结算 prompt 带会话维护职责;一条断言那个错标题没有回来。
