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

**Status:** done

- [x] `content`/`insight` 可通过 `remember` 的编辑模式写入 — 新增 `SEGMENT_EDITABLE_FIELDS`（`shared/segment-fields.ts`，六个 Working State 字段 + `content`/`insight`；`title` 仍 create-only），`appendSegmentWorkingStateRows`/`replaceInSegmentWorkingStateField` 的 `field` 参数类型随之放宽，`remember` 的 `field` 枚举与描述同步更新
- [x] `close` 动词存在，close 后的段离开花名册、仍可 recall — `db/segments.ts` 新增 `toggleSegmentStatus`；`remember(close)` 调用它。**裁量**：`close` 做成两值间的 TOGGLE（再次调用即复位为 `open`），不是单向动词——票面只要求「一个 close 动词」且最后一条验收标准要求「拒绝时给出重开的出口」，toggle 让「出口」就是同一个动词再调一次，不必新增 `reopen` 动词
- [x] 状态词表收敛为 `open`/`closed`，退役词不再出现在 schema 约束里 — **裁量（超出票面字面）**：TypeScript 层（`SEGMENT_STATUSES`/`SegmentStatus`，`db/segments.ts`）严格收敛为两值，`createSegment`/`applySegmentWrites`/`toggleSegmentStatus` 均只能写 `open`/`closed`。但**物理 SQL CHECK 约束保持宽松**（`open`/`delivered`/`abandoned`/`closed` 四值，fresh install 与既有库一致）——起初按字面把 fresh-install DDL 收窄到两值，导致 `tests/mcp/segment-spine.test.ts`、`tests/mcp/recall.segments.test.ts`、`tests/db/segment-rank.test.ts`、`tests/hooks/session-composition.test.ts` 等（全部在我的改动范围之外）里构造 `status: "delivered"` 的既有 fixture 全部因 CHECK 冲突报错（bun:test 不对测试代码做 tsc 类型检查，这些字面量绕过了 TS 层收敛）。收窄物理约束纯粹是文档/纯净性诉求，不收窄也不会让任何生产代码路径产生新的 `delivered`/`abandoned` 行（`applySegmentWrites` 本就无生产调用方）；两权相较，选择让物理 CHECK 保持宽松，把「收敛到两值」这件事完全交给 TypeScript 层强制。`ensureSegmentStatusVocabulary`（schema.ts）仍按 12-step 迁移把既有库的 CHECK 从三值宽到四值，逻辑不变
- [x] 写入闸只对 closed 段生效，并在拒绝时给出重开的出口 — `remember.ts` 的 `handleAppend`/`handleReplace` 判据由 `status !== "open"` 改为 `status === "closed"`；拒绝文案含 `remember(close, id="E<n>")` 提示
