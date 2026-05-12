# Invalidated Turn Detection & Subagent Filter Rename

**Goal**: 让"被用户否决的 turn"（interrupt / rollback）进入记忆 agent 抽取链路，并带上 `was_interrupted` / `was_rolled_back` 硬标注；重构现有 `rollback.ts` 匹配其实际职责（subagent 过滤），扫清语义错位。

**影响范围**: `src/db/schema.ts`（新增两列）、`src/db/turns.ts`（类型 + merge 保证）、`src/shared/transcript-parser.ts`、新增 `src/worker/invalidation.ts`、重命名 `src/worker/rollback.ts → subagent-filter.ts`、`src/worker/server.ts`（envelope + 符号）、`src/worker/query-session.ts`（agent 指令）、`src/hooks/handlers/{stop,session-init}.ts`。

---

## Motivation

三条相互独立的事实，经 JSONL 实测与 CC 源码 `~/Projects/claude-code-main/src/utils/sessionStorage.ts:1451` 及其 3 个 caller（`tools/AgentTool/runAgent.ts:735,794`、`tasks/LocalMainSessionTask.ts:360,416`、`utils/forkedAgent.ts:531,588`）核对：

1. **现模块名错位**。`src/worker/rollback.ts` 检测的 `isSidechain:true` 唯一语义是 **subagent transcript**（Task 子 agent / background task / `--fork-session`），与用户回退**无关**。Tag 名 `rollback:pending` 同样误导。
2. **真·用户回退从未被检测**。用户在 CC UI 里编辑/回滚历史消息时，CC 通过 **parentUuid 树分叉**保留死分支（同一 parent 下多个 user 子、不同 promptId，主链从文件末尾倒着走 parentUuid 可达）。本项目 JSONL 扫描：S38 38 次、S1243 10 次、S1730 2 次——频率远高于 subagent（主 session 中 0 次）。
3. **ESC 中断同样漏检**。用户 ESC 产生 `[Request interrupted by user]` 合成 user 消息、`promptId` 复用被打断请求的 promptId。Parser 的 `startsNewTurn` 看到同 promptId 直接短路；turn 正常抽取但"被打断"的信号永久丢失。S38 29 次、S1243 5 次。

Interrupt 与 rollback 在**用户反馈语义层**等价（"这个方向被否决、下一个 turn 是纠正"），应统一建模并带入 agent 抽取。Subagent 与它们本质不同（CC 内部机制、非用户反馈），应清晰隔离。

---

## Locked Decisions

### 信号分类

**D1**: 三类独立信号、三种处理路径。

| 信号 | 检测 | DB 处理 | 进 agent 抽取链路？ |
|---|---|---|---|
| **interrupt** | `[Request interrupted by user]` + 同 promptId | `was_interrupted=1`；若 `status ∈ {extracted,skipped}` 则 demote 到 `active` | ✅（via `<reminder>` envelope） |
| **rollback** | parentUuid 树分叉的非主链 user 子 | `was_rolled_back=1`；若 `status ∈ {extracted,skipped}` 则 demote 到 `active` | ✅（via `<reminder>` envelope） |
| **subagent** | `isSidechain:true` | `status='undone'` + 删 obs/FTS/queue + `subagent:pending→:notified` tag | ❌（turn 不抽取；只发 `<subagent_invalidated>` envelope 让 agent 撤回已写入记忆） |

`<reminder>` envelope 是 status=`active` turn 的**统一通知通道**：既覆盖新 turn，也覆盖被 invalidation demote 回来的 turn。Agent 凭 was_* flag 区分"首次抽取"还是"invalidation 修订"。

### Schema 扩展

**D2 — 两个新列**:

```sql
ALTER TABLE turns ADD COLUMN was_interrupted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE turns ADD COLUMN was_rolled_back INTEGER NOT NULL DEFAULT 0;
```

- `0/1` 布尔，单向迁移（一旦置 1 永不清零——永久观察记录）。
- 两列独立，同 turn 两个 flag 可并存。
- 不加索引——查询主字段是 `status`，was_* 仅在 reminder 渲染时读。

### Status 语义 & delivery flag

**D3**: `status` 是**权威生命周期**字段。Invalidation delivery 采用 **双通道 + tag-based tracking**。

| 值 | 含义 | Delivery 通道 |
|---|---|---|
| `active` | 未被 agent 完整处理 | Active turn 走 inline `invalidated` 属性（D9a），不进 reminder |
| `extracted` | agent 调 `remember({id,title,content,...})` 写过完整内容 | 若有 pending tag → 进 `<reminder>` envelope |
| `skipped` | agent 调 `remember({id,status:"skipped"})` 明确跳过 | 若有 pending tag → 进 `<reminder>` envelope |
| `undone` | subagent 过滤掉，永不抽取 | ❌（独立生命周期） |

**D3a — Agent 接口不变**: agent 仍通过 `remember({id,status:"skipped"})` 明确跳过、`remember({id,title,content,...})` 完成抽取（server 此时自动 set `status='extracted'`）。保留现有 `query-session.ts:287` 接口。

**D3b — Status 保持 + tag 标注**: stop hook 检测到 turn 新命中 invalidation 时：

```sql
-- was_* 按 MAX 合并（一旦置 1 不清零），status 保持原值
UPDATE turns
SET was_interrupted = MAX(was_interrupted, <new_i>),
    was_rolled_back  = MAX(was_rolled_back, <new_r>),
    tags = <追加 invalidated:notify-pending:{kind} tag>,
    updated_at_epoch = ?
WHERE id = ?
```

- Status **不 demote**。`active` 的 turn 保持 `active`（走 D9a inline 属性首次抽取）；`extracted`/`skipped` 的 turn 保持原 status（走 `<reminder>` envelope 通知 agent 修订）。
- `undone` 不动（subagent 生命周期独立）。
- 幂等：已有 `notify-pending:{kind}` 或 `notified:{kind}` tag 的不重复添加。

**D3c — Tag-based delivery tracking**: 每种 invalidation kind 有一对 delivery tag：

| Tag | 含义 |
|---|---|
| `invalidated:notify-pending:{kind}` | 检测到 invalidation，尚未通知 agent |
| `invalidated:notified:{kind}` | 已通过 `<reminder>` envelope 通知 agent |

Agent 调 `remember()` 后 status 转终态（D12b），同时 `markReminderItemsNotified` 将 pending tag 转为 notified tag。双重条件（status 终态 + 无 pending tag）保证不重复通知。

### 检测算法

**D4 — interrupt（parser 级）**: `src/shared/transcript-parser.ts` 新 export

```ts
export function detectInterruptedPromptIds(transcriptPath: string): Set<string>;
```

遍历所有 entries，凡 `role='user'` 且首个 text block 以 `[Request interrupted by user` 开头、`promptId` 非空 → 将其 promptId 加入 set。`startsNewTurn` 现有短路行为不变（同 promptId 不开新 turn，marker 被丢弃不影响 turn 结构）。

**附带改动**：给 `ParsedReplayTurn` 加 `wasInterrupted: boolean` 字段，`parseReplayTranscript` 组装时查 set 填充——这个字段对 replay skill、timeline 显示层也有用（`invalidation.ts` 不依赖此字段，它自己调 `detectInterruptedPromptIds`）。

**D5 — rollback（树拓扑）**: 新模块 `src/worker/invalidation.ts`

```ts
export function detectRolledBackPromptIds(transcriptPath: string): Set<string>;
```

**输入**必须是 `readAllTranscriptEntries(transcriptPath)` 的返回（见 `src/shared/transcript-parser.ts:161`）——该函数按 `uuid` 做 dedup，过滤 `--resume` / snapshot replay 的重复节点。**不可**直接按行扫 raw JSONL。

**Chain participant 定义**：对齐 CC 源码 `sessionStorage.ts:154 isChainParticipant = m.type !== 'progress'`——除 `progress` 外所有 type 都参与 parentUuid 链。**不可**缩成 `{user, assistant}`（尾部常有 `attachment` / `system(stop_hook_summary)` leaf，在主链上；人为排除会丢 tip）。

**主链 tip**：**最新 non-sidechain chain-participant leaf**，对齐 CC `conversationRecovery.ts:424`。Leaf = 没有任何其它 entry 以它为 `parentUuid` 的节点；取其中非 sidechain、chain-participant 者，按 `timestamp` 最大（tie-break: entry 数组 index 最大）。

**算法**：
1. `entries = readAllTranscriptEntries(path)`（deduped）。
2. 一遍扫：建 `uuid → entry`、`parentUuid → children[]`；收集 `parentSet = { e.parentUuid | e.parentUuid !== null }`。
3. **Leaf 集合**：`leafUuids = { e.uuid | e.uuid ∉ parentSet, e.type !== 'progress', e.isSidechain !== true }`。保留 `attachment` / `system` / `file-history-snapshot` 等；仅排除 `progress` 与 sidechain。
4. **主链 tip**：`leafUuids` 中 `timestamp` 最大者（tie-break: index 最大）。集合空返回空 set。
5. 从 tip 倒走 `parentUuid`，收集 `mainChainUuids: Set<uuid>`，直到 `parentUuid === null` 或 uuid 不在索引（compact boundary 会让链断，正常）。
6. 对 `parentUuid → children[]` 每个 parent：枚举其 `type='user'` 且 `promptId` 非空的 chain-participant 子；凡 `uuid ∉ mainChainUuids` → `promptId` 加入结果 set。

**Helper 约定**：在 `src/shared/transcript-parser.ts` export `isChainParticipant(entry): boolean` 对齐 CC 语义，供 D5 和未来 leaf 分析复用，不内联。

**D6**: 两个 set 不互斥、不去重。同一 turn 既命中 interruptedSet 又命中 rolledBackSet 时，`was_interrupted` 和 `was_rolled_back` 同时置 1。

### Stop hook 集成

**D7**: `src/hooks/handlers/stop.ts` 在既有 `backfillFromTranscript` 之后、orphan 扫描之前新增：

```ts
// 伪码
backfillFromTranscript(...);
applyInvalidation(db, session.id, input.transcriptPath, epoch);  // ← 新增
// ... orphan turn loop, upsertSession ...
detectAndCleanSubagentTurns(...);  // 原 detectAndCleanSidechainTurns 改名
```

`applyInvalidation(db, sessionDbId, transcriptPath, epoch)` 内部：

1. 调 `detectInterruptedPromptIds` + `detectRolledBackPromptIds` 得到两个 Set<promptId>。
2. `getTurnsForSession(db, sessionDbId)`，对每个 turn：
   - `newInterrupt = interruptedSet.has(turn.contentPromptId) && !turn.wasInterrupted`
   - `newRollback  = rolledBackSet.has(turn.contentPromptId)  && !turn.wasRolledBack`
   - 都无新增 → skip。
   - 否则单次 `updateTurnById` 按 D3b 规则更新 was_* + status。
3. 不动 `status='undone'` 的 turn（`undone` 不 demote，参见 D3b）。

**D8**: Session-init hook 同步调 `applyInvalidation`（在 `session-init.ts:60` 处 `detectAndCleanSidechainTurns`→改名 `detectAndCleanSubagentTurns` 相同位置），保证 resume/compact 路径也覆盖。

### Agent 通知 (`<reminder>` envelope)

**D9a — Inline `invalidated` 属性（active turn 首次抽取通道）**: 当 `status='active'` 的 turn 被送入 batch 时，若 `was_interrupted` 或 `was_rolled_back` 为真，`buildBatchTurnBlock` 在 `<turn>` 开标签渲染 `invalidated="interrupt"` / `"rollback"` / `"interrupt+rollback"` 属性。Agent 在首次抽取时即可知晓 turn 已被否决。

该通道仅覆盖**尚未抽取**的 active turn。已 extracted/skipped 的 turn 走 `<reminder>` envelope（D10）。两个通道不重叠：active turn 不进 reminder，终态 turn 不带 inline 属性。

**D10 — `<reminder>` envelope（已抽取 turn 修订通道）**: `src/worker/server.ts` 的 `buildReminderEnvelope` + `invalidation.ts` 的 `getReminderItems`。

```ts
interface ReminderItem {
  turnId: number;
  promptNumber: number;
  wasInterrupted: boolean;
  wasRolledBack: boolean;
  priorTitle: string | null;               // turn.title（已 extracted 的 turn 有）
  priorContent: string | null;             // turn.content（截至 120 字符渲染在 envelope 中）
  replacementPromptNumber: number | null;  // rollback 时从 parentUuid 树拓扑直接识别的 main-chain sibling
                                           // interrupt-only turn 此字段始终为 null（interrupt 无树分叉，无法确定 replacement）
  pendingKinds: InvalidationKind[];        // 本次通知的 kind(s)
}
```

**查询**: `getReminderItems(db, sessionDbId, transcriptPath?)` 拉 `status NOT IN ('active','undone')` 且有 `invalidated:notify-pending:*` tag 的 turn，按 `updated_at_epoch DESC` 排序，**上限 10 条**（`REMINDER_LIMIT`）。超出部分由 `getSilencedReminderItems` 返回，用于 `markReminderItemsNotified` 静默清理。

**Replacement 派生**：rollback turn 的 replacement 从 `detectRollbackTopology().replacementByPromptId` 获取——即 parentUuid 树中同 parent 的 main-chain user sibling 的 promptId，再通过 DB 映射到 promptNumber。不走 SQL 扫描。Interrupt-only turn 固定 `null`。

**Envelope 文案**：

```xml
<reminder>
  The following turns were invalidated and need one-time attention.
  - T42 (was_interrupted, replaced by T43): "Review Codex branch" -- user pressed ESC mid-response
  - T55 (was_rolled_back, replaced by T58): "Write session-init spec" -- user navigated back
  - T61 (was_interrupted+was_rolled_back, replaced by T62): "Draft sample"
  - T77 (was_interrupted): "Compare MCP tools"
</reminder>
```

行级格式：`T<promptNumber> (<flags>[, replaced by T<m>])[: "<priorTitle>" -- <priorContent truncated>]`

- `<flags>`：`was_interrupted` / `was_rolled_back` / `was_interrupted+was_rolled_back`（不再有 `fresh`——active turn 走 D9a inline 属性，不进 reminder）。
- `, replaced by T<m>`：仅在 `replacementPromptNumber !== null` 时出现。
- `: "<priorTitle>" -- <content>`：仅在有 priorTitle/priorContent 时出现（截至 120 字符）。

**Drain 集成点**（`server.ts` 的 `pushMessage`）：

- 与现有 `getPendingSubagentTurns`（subagent envelope 驱动）**并列**，新增 `getReminderItems(db, sessionDbId, transcriptPath)` 调用。
- 两个 envelope 独立拼接（subagent 在前、reminder 在后）放到 prompt 前。
- **Notification cleanup**: `markReminderItemsNotified` 在 push 成功后将 `notify-pending:{kind}` tag 转为 `notified:{kind}`，包括超出 REMINDER_LIMIT 的静默条目。Agent 调 `remember()` 后 status 转终态（D12b），与 notified tag 共同保证不重复通知。

### Agent 指令

**D11**: `src/worker/query-session.ts` 新增 `## Reminder envelope` 章节：

> Messages may be prefixed with a `<reminder>` block listing recently invalidated turns that need one-time attention. Each line:
>
> `- T<n> (<flags>[, replaced by T<m>])[: "<priorTitle>"]`
>
> `<flags>` is one of: `fresh`, `was_interrupted`, `was_rolled_back`, `was_interrupted+was_rolled_back`.
>
> For each listed `T<n>`:
>
> 1. Check if a `<turn id="T<n>">` block appears in this batch:
>    - **Present**: process normally. For `fresh`, standard first-time extraction. For `was_*`, the turn was invalidated — extract as user-feedback (what was attempted, why rejected).
>    - **Absent**: the turn was previously extracted and has been demoted due to newly-detected invalidation. Prior content likely still in your conversation cache; if not, call `recall({id:"T<n>"})` to fetch. Then `remember({id:"T<n>", ...})`.
> 2. For `was_*` turns: you MAY revise `title` / `content` / `type` to reflect that the turn represents a rejected direction. Prefer `type: discovery` or `type: decision` even if code changed — the change was invalidated. Do NOT mark `bugfix` / `feature`.
> 3. `remember({id:"T<n>", ...})` on an existing T record performs **field-level merge** — unspecified fields preserved, tags appended (not replaced). You only need to set fields you're changing.
> 4. Envelope reappears until you call `remember()` (status → `extracted`) or `remember({status:"skipped"})`.
>
> Do NOT invent a replacement turn number not present in the envelope. If the line omits `replaced by`, do not guess.

保留现有 `## Turn messages` 章节的 `remember({status:"skipped"})` 指令。

### Server merge 语义

**D12 — `remember()` on existing T record = 字段级 merge**（不变量）:

- `remember({id:"T<n>", title:X})` 只更新 `title`；`content` / `insight` / `type` / `tags` / `files_*` / `tool_call_count` 保持原值。
- `remember({id:"T<n>", tags:[X]})` **追加**而非**替换** tags（DB 里存 `UNION(旧 tags, 新 tags)`），防止 agent 误删 server 写入的 `subagent:*` 等内部 tag。
- `remember({id:"T<n>", status:"skipped"})` 只改 status。
- 新建场景（first `remember` on a turn）不受影响——仍是 INSERT-like 写入全部显式字段。

**D12b — Status 自动升格**（delivery flag 语义的依赖条件）:

D3c 要求"agent 调 `remember()` 后 turn 自然移出 reminder"。这条依赖一条 server 端规则：**对 `status='active'` 的现有 T 记录，任何显式不带 `status` 字段或带 `status` 非 `"skipped"` 值的成功 `remember({id,...})` 更新，server 必须把 `status` 置为 `"extracted"`**。

具体规则（在"对 existing T record"路径里执行，顺序：字段级 merge → 按此规则决定 status）：

| 现 status | payload 里 `status` 字段 | 合并后 status |
|---|---|---|
| `active` | 未提供 | `extracted`（升格） |
| `active` | `"skipped"` | `skipped` |
| `active` | `"extracted"` | `extracted`（同义于升格） |
| `extracted` / `skipped` | 未提供 | 不变 |
| `extracted` / `skipped` | 任意合法值 | 取 payload 值（agent 重抽取后可能保持 extracted） |
| `undone` | 任何 | 不变（`undone` 受 subagent 管线独占） |

**为什么要钉死**：如果 agent 只传 `tags:["invalidated"]` 做 invalidation 修订，按纯 merge 语义 status 不会动，turn 会永远留在 `active` → reminder 无限重发。D3c 的正确性依赖此规则。

**落地步骤**：
- 先写测试 `tests/db/turns.merge.test.ts` 覆盖 D12 + D12b，验证当前 server 行为。
- 行为吻合 → 测试作为回归保护。
- 行为不吻合 → 补修；D12b 的升格逻辑很可能是必须新写的（现行逻辑应该只在 agent 显式传 status 时才改 status）。

### 模块重命名

**D13 — 文件**: `src/worker/rollback.ts → src/worker/subagent-filter.ts`（纯重命名 + 注释改写）。

**D14 — 符号**:

| Old | New |
|---|---|
| `ROLLBACK_PENDING_TAG` = `"rollback:pending"` | `SUBAGENT_PENDING_TAG` = `"subagent:pending"` |
| `ROLLBACK_NOTIFIED_TAG` = `"rollback:notified"` | `SUBAGENT_NOTIFIED_TAG` = `"subagent:notified"` |
| `detectAndCleanSidechainTurns` | `detectAndCleanSubagentTurns` |
| `resolveSidechainTurns` | `resolveSubagentTurns` |
| `getPendingRollbackTurns` | `getPendingSubagentTurns` |
| `getPendingRollbackPromptNumbers` | `getPendingSubagentPromptNumbers` |
| `markRollbackTurnsNotified` | `markSubagentTurnsNotified` |
| `addRollbackPendingTag` | `addSubagentPendingTag` |
| `markRollbackNotifiedTags` | `markSubagentNotifiedTags` |

**D15 — Subagent envelope**: `src/worker/server.ts:217-223`
- `buildRollbackEnvelope` → `buildSubagentInvalidationEnvelope`
- XML `<rollback>` → `<subagent_invalidated>`
- 文案改为 "T5, T6 originated from a Task subagent transcript and are out-of-scope for session memory."

### Migration

**D16 — Schema migration**: 写在 `src/db/schema.ts` 现有 migration 链里。SQLite `ALTER TABLE ADD COLUMN` 不幂等，用 `PRAGMA table_info(turns)` 先探测再 add（或依赖 migration 版本号机制，按项目现有约定）：

```sql
ALTER TABLE turns ADD COLUMN was_interrupted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE turns ADD COLUMN was_rolled_back INTEGER NOT NULL DEFAULT 0;
```

**D17 — Tag 数据迁移**：一次性脚本 `scripts/migrate-subagent-tags.ts`：

```sql
UPDATE turns
SET tags = replace(replace(tags, '"rollback:pending"', '"subagent:pending"'),
                   '"rollback:notified"', '"subagent:notified"')
WHERE tags LIKE '%rollback:%';
```

幂等、可重复运行。README 提醒运行一次。

---

## Changes

### `src/db/schema.ts`
- 新增 migration 加两列 `was_interrupted` / `was_rolled_back`（D16）

### `src/db/turns.ts`
- `TurnRecord` 加 `wasInterrupted: boolean` / `wasRolledBack: boolean`
- SELECT 语句增加两列别名映射
- `updateTurnById` 接受两个新字段（optional）
- 实现 / 验证 `remember()` 对已存在 T 记录走字段级 merge（D12）
- Tag 合并改为 union（不是 replace）

### `src/shared/transcript-parser.ts`
- `ParsedReplayTurn` 加 `wasInterrupted: boolean`
- 新 export `detectInterruptedPromptIds(path): Set<string>`
- 新 export `isChainParticipant(entry): boolean`（对齐 CC `sessionStorage.ts:154`）
- `parseReplayTranscript` 内部调 `detectInterruptedPromptIds` 填 `wasInterrupted`

### `src/worker/invalidation.ts`（新）
- `detectRolledBackPromptIds(path): Set<string>`（D5）
- `applyInvalidation(db, sessionDbId, path, epoch): void`（D7）
- `getReminderItems(db, sessionDbId): ReminderItem[]`（D10）
- 不 import `subagent-filter.ts`，纯新逻辑

### `src/worker/subagent-filter.ts`（原 `rollback.ts`）
- 文件 + 符号重命名（D13 / D14）
- 注释更新：描述它做的是 subagent（Task/bg-task/fork-session）过滤
- 逻辑 0 改动

### `src/worker/processors.ts`
- `buildBatchTurnBlock` 加 `invalidatedKinds` 参数，渲染 `invalidated="..."` inline 属性（D9a）
- `formatInlineInvalidationKinds` helper 将 `was_*` flag 转为 `"interrupt"` / `"rollback"` / `"interrupt+rollback"` / `null`

### `src/hooks/handlers/stop.ts`
- import `applyInvalidation`，按 D7 位置调用
- import 改 `detectAndCleanSubagentTurns`

### `src/hooks/handlers/session-init.ts`
- 按 D8 调 `applyInvalidation`
- import 改 `detectAndCleanSubagentTurns`

### `src/worker/server.ts`
- D14/D15 符号与 subagent envelope 改名
- `pushMessage` 内：在现有 subagent envelope 相邻位置加 `getReminderItems` + `buildReminderEnvelope`；两个 envelope 顺序拼接（subagent 在前）放到 prompt 前
- Push 成功后调 `markReminderItemsNotified`（含 silenced items），将 `notify-pending` tag 转为 `notified`

### `src/worker/query-session.ts`
- 新增 `## Reminder envelope` 章节（D11）
- 现有 `## Turn messages` 的 `remember({status:"skipped"})` 指令保留

### `scripts/migrate-subagent-tags.ts`（新）
- D17 一次性 SQL 脚本

---

## Tests

### 新增

- `tests/shared/transcript-parser.interrupt.test.ts`
  - `[Request interrupted by user]` + 有 promptId → 命中 set
  - `[Request interrupted by user for tool use]` → 同样命中
  - 无 promptId 的 marker → 不崩
  - 多次 interrupt 同 promptId → set 里仅一次
  - `ParsedReplayTurn.wasInterrupted` 按 set 正确填充

- `tests/worker/invalidation.rollback.test.ts`
  - 单父多 user promptId → 非主链 promptId 入 set
  - 正常线性会话 → 空 set
  - 同父 3 user 子（连续回退两次）→ 两非主链 promptId 都在
  - 同 promptId 下 tool_use/tool_result 共享 parent → 不误报
  - Resume snapshot 重复节点（同 uuid 多次）→ dedup 后不误判
  - 尾部 `attachment` / `system(stop_hook_summary)` leaf → 主链 walk 正确覆盖
  - 尾部唯一 leaf 是 `progress` → 排除，fallback 到前一个
  - 尾部 `isSidechain=true` leaf → 跳过，走主链
  - 多 non-sidechain leaf → tip 取 `timestamp` 最大

- `tests/worker/invalidation.apply.test.ts`
  - `applyInvalidation` 对 `status='active'` + 命中 interrupt → `was_interrupted=1`，status 不变
  - 对 `status='extracted'` + 命中 rollback → `was_rolled_back=1`，status demote 到 `active`
  - 对 `status='skipped'` + 命中 interrupt → `was_interrupted=1`，status demote
  - 对 `status='undone'` + 命中 rollback → `was_rolled_back=1`，**status 不变**（不 demote）
  - 幂等：重复调用不改 was_*、不多次 demote
  - 两 kind 同批：turn 命中两 set → 两列都置 1，单次 DB 写
  - 不动未命中 turn

- `tests/worker/invalidation.reminder.test.ts`
  - `getReminderItems` 只返回 `status='active'` 的 turn
  - 按 `prompt_number` 升序
  - **Replacement 派生**：跳过 `status='undone'`、跳过 `was_*=1` 的 turn；**不**要求 replacement 自己是 `active`——已 `extracted` / `skipped` 的干净 turn 也算有效 replacement（它们是在 invalidation 检测之前就已被 agent 处理完的后继）
  - Replacement fixture：T5 是 invalidated active，后续 T6 `status='extracted' was_*=0` → T5 的 replacement = T6
  - Replacement 无命中（最末 turn）→ `null`
  - `buildReminderEnvelope` 格式：
    - fresh 无 replacement 无 title → `- T80 (fresh)`
    - was_interrupted + replacement + title → `- T42 (was_interrupted, replaced by T43): "Review"`
    - was_rolled_back + replacement + title → `- T55 (was_rolled_back, replaced by T58): "Spec"`
    - 两 flag + replacement + title → `- T61 (was_interrupted+was_rolled_back, replaced by T62): "Draft"`
    - was_interrupted 无 replacement 有 title → `- T77 (was_interrupted): "Compare"`
  - Drain 集成：subagent envelope + reminder envelope 并存 → subagent 在前

- `tests/worker/invalidation.schema.test.ts`
  - Migration 运行前：老 turns 行无两列 → migration 后有，默认 0
  - Migration 幂等：重复调用不崩（探测 `PRAGMA table_info` 逻辑）
  - `TurnRecord` / `updateTurnById` 正确读写 `wasInterrupted` / `wasRolledBack`

- `tests/db/turns.merge.test.ts`（D12 + D12b server merge 语义）
  - `remember({id, title: X})` on existing → 只改 title，content/insight/type/tags/files_* 保持
  - `remember({id, tags:[X]})` on existing → 追加而非替换（旧 tags 保留，包括 `subagent:*`）
  - `remember({id, status:"skipped"})` on existing → 只改 status
  - `remember({id, status:"skipped"})` on existing extracted → status 转 skipped、其它字段保持
  - **D12b 升格 #1**：`remember({id, tags:["invalidated"]})` on existing `status='active'` → status 自动升 `extracted`，tags 并入 `invalidated`
  - **D12b 升格 #2**：`remember({id, title:X, content:Y})` on existing `status='active'`（无 status 字段）→ status 自动升 `extracted`
  - **D12b 升格 #3**：`remember({id, status:"skipped"})` on existing `status='active'` → status 明确转 `skipped`（不被"自动升格 extracted"覆盖）
  - **D12b 不误升**：`remember({id, tags:[X]})` on existing `status='extracted'` → status 保持 `extracted`，不重复设
  - **D12b 不改 undone**：`remember({id, title:X})` on existing `status='undone'` → status 保持 `undone`（防止 subagent 生命周期被 agent 写入意外破坏——实际 agent 不应看到 undone turn，但守住不变量）

### 拆分

- 旧 `tests/worker/rollback.test.ts` → `tests/worker/subagent-filter.test.ts`（符号改名，逻辑 fixture 不变）

### 迁移

- 测试中 `rollback:pending` / `rollback:notified` / `<rollback>` 字面量 → 全局替换为 `subagent:*` / `<subagent_invalidated>`
- `tests/hooks/stop.test.ts`：新增 case——interrupt marker 的 transcript → stop hook 后对应 turn 有 `was_interrupted=1`；rollback 分叉的 transcript → 非主链 turn 有 `was_rolled_back=1`

---

## Non-goals

- **不检测 edit-history 的 truncate-rewrite**。当前 CC（2.1.112）保留死分支，D5 足够；若未来 CC 改为 truncate，单独 spec。
- **不精细切分 interrupt 的 partial response**。`backfillFromTranscript` 已把 ESC 前的 assistant text 写入 `assistant_response`；继续切分到"打断停在 tool X step Y"成本高、agent 用不上。
- **不级联 retraction**。D11 允许 agent 改写被 invalidate turn 的 title/content/type，但**不要求**清 FTS、撤回 observation、或改相邻 turn。更激进的走独立 spec。
- **不物化 replacement pointer**。`replacementPromptNumber` 是 envelope 现算的 view，不存 schema 列——replacement 可能随会话推进变化（插入新 turn、自身也被 invalidate），物化会过时。
- **不合并 `detectBrokenPromptPairs` 前缀启发式**。它是 timeline 显示层信号，与 DB 层 was_* 正交，不重复。
- **不向 `<turn>` 块渲染 invalidated 属性**（D9）。所有 invalidation 信号走 `<reminder>` 唯一通道。
- **不扩展 `status` 枚举**。`active | extracted | skipped | undone` 不变；invalidation 标注靠两个独立 boolean 列。
