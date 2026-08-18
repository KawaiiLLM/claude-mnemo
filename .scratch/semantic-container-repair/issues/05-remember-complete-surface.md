# 05 — remember 补齐字段与 close 动词

**What to build:** `remember` 能编辑段的 `content`/`insight`，并有一个把段移出花名册的 `close` 动词。状态词表初版就两个值，不做状态机。

**用户裁决：** T821「段本身字段的维护交给主 agent，用一个 remember 工具专门用来更新段信息」——**所有**段字段由主 agent 维护。用户后续确认：「所有字段都是主 agent 维护，remember 工具支持所有字段的不同模式的编辑，不理解为什么不能写。status 初版不需要搞复杂，和以后用不用状态机无关」。

**实现现状：**
- `src/shared/segment-fields.ts` 只列六个 Working State 字段，其自身注释写着「beside its summary trio (title/content/insight)」——摘要三件套被排除在 `remember` 的 `field` 枚举之外，而该列表同时是枚举的唯一来源。
- `src/mcp/remember.ts:41-47` 动词只有 `create/attach/append/replace`，无 `close`。
- `src/db/schema.ts:423-425` 状态词表仍是 `open/delivered/abandoned`——ADR-0005 明写这套是 arc 语义、随 arc 退役。
- `src/mcp/remember.ts:446-450` 与 `:526-530` 对非 `open` 段硬拒写；由于没有任何动词能把段移出 `open`，这条闸永远不可能被合法触发。
- `applySegmentWrites`（`src/db/segments.ts:913`）是唯一能写 content/insight/status 的 CAS，`src/` 内无生产调用方。

**后果：** 花名册只增不减；两个死字段；一套已退役词汇被升级成用户从未要求的硬约束。

**Blocked by:** None

**Status:** ready-for-agent

- [ ] `content`/`insight` 可通过 `remember` 的编辑模式写入
- [ ] `close` 动词存在，close 后的段离开花名册、仍可 recall
- [ ] 状态词表收敛为 `open`/`closed`，退役词不再出现在 schema 约束里
- [ ] 写入闸只对 closed 段生效，并在拒绝时给出重开的出口
