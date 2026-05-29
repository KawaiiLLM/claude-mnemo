# Large Turn Streaming (mini-turn extraction unit)

**Goal**: 把"单个超长 turn 撑爆记忆 agent 上下文"这条唯一的失控路径堵上。引入 **mini-turn** 作为记忆抽取的原子单位，**实时流式**投递：turn 进行中,每当其 buffered obs 凑够 `maxMiniTurnChars` 就**立即** flush 一个流式 mini-turn（`slice="n"`,只带 prompt + 本段 obs）；turn-stop 时 flush **final** mini-turn（`final="true"`,补 response/files）。agent 每片**动态重写**同一条 T 记录。短 turn 从不凑够阈值 → turn-stop 一次 flush（= 今天行为）。存储仍以 turn 为单位,obs 仍折进 mini-turn 当上下文并自动 skip。

**影响范围**: **前置重构** `src/worker/invalidation.ts`（reminder reason 通用化，D0，行为保持）；`src/shared/config.ts`（两个新 knob）、`src/worker/processors.ts`（`buildMiniTurn` 单片渲染）、`src/worker/server.ts`（**流式触发**：drain 路径凑够阈值即 flush + per-turn 流式状态、BatchEntry 判别式联合、flush 重试/丢弃、delivery-dropped reason 接入、`buildReminderEnvelope` grammar 化）、`src/worker/query-session.ts`（系统提示新增流式章节 + 不变量豁免）。**无 schema 迁移、无 tag 改名**。

**实现顺序**: D0（独立 commit，shipped invalidation 测试全绿）→ 流式各项（D1–D10）。

**关键可行性**：worker **每次工具调用就被唤醒**（`post-tool-use.ts:114` 每个 PostToolUse insert obs + enqueue + `notifyWorkerWake`），obs 在 turn 进行中已实时进 per-session buffer。改成流式**只需把 flush 触发从"只在 turn-stop"变成"buffer 凑够阈值就 flush"**，底层管道不动。

---

## Motivation

经上一轮链路审计确认：逐字段截断（obs in/out 300、prompt/response 1000、`processors.ts:160-200`）只压**宽度**不压**数量**；一个 turn 内联的 obs 块数无上限（`buildTurnPayload` 全量映射 `processors.ts:449-463`）。`/goal` 这类单 prompt 跑数百上千工具调用的长程任务，会在 turn_stop 时把全部 obs 折进**一条**消息：500 次调用 ≈ 500 个 ~700 字符 obs ≈ 350KB ≈ ~87K token，挤在单条 push 里。

`mergeThresholdChars=1000` 在此完全失效——它只阻止**多个小 turn 合并**，对单个超大 turn 自成一批不设上限（`enqueueCompletedTurnLocked` 的检查针对运行中批次 size，`server.ts:821-833`）。后果分三档：

1. **中等**：单条消息几十 K token，成本尖峰；消息永久留在 resumed SDK 会话历史里，把对话推向窗口。
2. **偏大（响应 >30s）**：`STALLED_QUERY_MS=30s` watchdog（`server.ts:60`）`abortStalledSessions` 关掉会话 → `sendPrompt` reject → `flushOneBatchLocked` catch 释放 claim（`server.ts:784-790`）→ 下次重组同样的大批次 → 再超时 → **重试循环**。
3. **超窗（单 turn obs 量 > Sonnet 200K）**：push 直接被 API 拒 → 同样重试 → 这个 turn **永远拼不进窗口**、静默丢失抽取。

切片保全部 obs、不丢信息，是比"封顶 + 采样"更彻底的解法。**流式**（而非 turn-stop 一次性切）还顺带摊平负载：长 turn 进行中就增量抽取、buffer 峰值低、cache 持续热、turn-stop 时只剩 final 片——避免"30 分钟空转后爆发连发 ~15 条消息"。

---

## Locked Decisions

### Reminder 通用化（前置重构、行为保持）

**D0 — reminder reason 做成一等概念**

delivery-dropped 不能塞进闭合的 `InvalidationKind`（代码检查发现：`invalidation.ts:40` 硬编码两 kind、`:255` 焊死 `status != active`、`:323` 只翻 `pendingKinds`）。加第 3 个 reason 必然开第 2 条平行 track → 屎山。先把 reminder 机制通用化，**行为完全不变**，slicing 再注册一个 reason。

**reason descriptor**（descriptor 拥有该 reason 的**选择 + 通知 + 渲染片段 + 私有数据**，避免半截抽象，Codex audit #1）：

```ts
interface ReminderReason<D = unknown> {
  key: string;
  pendingTag: string;   // 沿用现有字面量，不改名、不再加 migration
  notifiedTag: string;
  qualifies(turn: TurnRecord): boolean;          // 各 reason 自己的 status 策略，不再焊死在选择器里
  // 渲染片段：descriptor 贴自己的 flag token 和（可选）clause；buildReminderEnvelope 只管行 grammar
  data(turn: TurnRecord, ctx: ReminderCtx): D;    // reason 私有渲染数据，不展平到 ReminderItem
  flagToken(turn: TurnRecord, d: D): string;      // 进 (...) 的 flag，如 "was_rolled_back"
  parenExtra?(turn: TurnRecord, d: D): string | null;  // 进 (...) 的额外子句，如 "replaced by T43"（rollback 专属，保格式）
  tail?(turn: TurnRecord, d: D): string | null;   // 进 "-- ..." 的尾注，如 delivery-dropped 的 incomplete 文案
}

const REMINDER_REASONS: ReminderReason[] = [
  { key:"interrupt", pendingTag:"invalidated:notify-pending:interrupt", notifiedTag:"invalidated:notified:interrupt", qualifies: t => t.status==="extracted"||t.status==="skipped", flagToken: ()=> "was_interrupted", /* parenExtra/tail 无 */ ... },
  { key:"rollback",  pendingTag:"invalidated:notify-pending:rollback",  notifiedTag:"invalidated:notified:rollback",  qualifies: t => t.status==="extracted"||t.status==="skipped", flagToken: ()=> "was_rolled_back", parenExtra: (_,d)=> d.replacement ? `replaced by T${d.replacement}` : null, ... },
  // delivery-dropped 由 D9 注册（qualifies: t => t.status !== "undone"）
];
```

- **通用选择** `collectReminderItems(db, sessionId)`：一遍扫 turn，`hits = REMINDER_REASONS.filter(r => turn.tags.includes(r.pendingTag) && r.qualifies(turn))`；有 hits 即成 item（天然按 turnId 合并），按 recency 排序，`REMINDER_LIMIT=10` 截断；溢出走 silenced。**取代** `selectPendingReminderItems` 里写死的 kind 列表 + status 过滤。
- **通用通知** `markReminderItemsNotified`：对 item 的每个命中 reason 翻 `pendingTag → notifiedTag`，一次 `updateTurnById({ status: turn.status, replaceTags })`（**显式 status 防自动升格**，`turns.ts:173-175`）。取代写死 `pendingKinds` 的翻转。
- **`ReminderItem` 不再展平 per-reason 字段**（Codex audit #1）：只持 `turnId` / `promptNumber` / `reasons: {reason, data}[]` / 共享的 `priorTitle` / `priorContent`。rollback 的 `replacement`、delivery-dropped 的 `notExtracted`/`prompt` 都装进各自 reason 的 `data`，不污染顶层。加第 4 个 reason 只新增一个 descriptor，**不**给 `ReminderItem` 加字段。
- **`buildReminderEnvelope` 只拥有行 grammar，不认识具体 reason**（Codex audit #1）：`flags = reasons.map(r => r.flagToken(...))`，`(...)` 内拼 `flags.join("+")` + `reasons.map(parenExtra).filter(Boolean)`；行尾拼 `: "<priorTitle>" -- <priorContent>` 或 `reasons.map(tail).filter(Boolean)`。**保持现有 envelope 文案逐字不变**（rollback 的 `replaced by` 仍在括号内、不挪位置——否则破坏 D0 行为保持），新 reason 的 tail 走 `-- ` 位置。
- **`applyInvalidation` 的写入侧**：`addPendingKind`/`markKindsNotified` 改为按 reason descriptor 操作（`addPendingReason(tags, reason)` / `markReasonsNotified(tags, reasons)`），interrupt/rollback 仍写**原字面量** tag。
- **Tag namespace 不变量（钉死隐含契约）**：`turns.tags` 列**同时装**内部追踪 tag 与 agent 自由主题 tag。两者靠命名风格隔离,**必须保持**：
  - 内部 reminder tag **一律冒号命名空间** `reason:sub:kind`（如 `invalidated:notify-pending:interrupt`、`delivery:dropped:notify-pending`、已 ship 的 `compact:*` / `subagent:*`）。**严禁**用连字符命名内部 tag——agent 自由 tag 就是小写连字符关键词（实测 DB 里已有 `delivery-dropped`、`api-delivery`、`delivery-model` 等 agent 主题词,与"delivery"内部概念撞词但靠冒号 vs 连字符不相交）。
  - reason 的 `key`（如 `"delivery-dropped"`）**仅作 registry 标识**：进 `ReminderItem.reasons`、驱动渲染分组;**永不写入 `tags` 列、永不与 tag 比较**。写进 tags 的只有 `pendingTag`/`notifiedTag`（冒号串）。`tags.includes(...)` 永远匹配冒号串,连字符的 agent 主题 tag 不会误触发 reminder。
  - 选 reason key 时**不要**假设它和某个 tag 字面量相等——它们是两个独立标识。

**验收：保持的是"可观察行为",不是内部类型（Codex 点 1 纠正）**。`ReminderItem` 从扁平字段改成 `reasons: {reason, data}[]`（audit #1）会**改变内部返回形状**,而 shipped `invalidation.apply.test.ts:208`（及 reminder 测试）**断言旧扁平字段** `wasInterrupted`/`wasRolledBack`/`priorTitle`/`priorContent`/`replacementPromptNumber`。所以**不能宣称"一行不改"**。正确口径：
- **行为保持 = envelope 输出逐字节相同 + tag 迁移相同 + DB 写入相同**——由新 `reminder-reasons.test.ts` 的 envelope 逐字等价 + tag-flip 断言保证。
- **断言内部 `ReminderItem` 形状**的 shipped 测试（apply/reminder 里 `expect.objectContaining({wasInterrupted,...})`）**需更新成 `reasons[]` 形状**——这是**类型变更,非行为回归**。
- rollback/schema 等不碰 `ReminderItem` 形状的测试仍一行不改。
- envelope 文案（含 `replaced by` 的括号内位置）、tag 字面量、status 语义全不变。

### 概念模型

**D1 — mini-turn = 抽取原子单位，turn = 存储单位**

- 一个 turn **流式发出 ≥1 个 mini-turn**：进行中每凑够 `maxMiniTurnChars` 发一个**流式片**（`slice="n"`），turn-stop 发一个 **final 片**（`final="true"`,带 response/files）。
- **短 turn**（全程没凑够阈值）→ 只在 turn-stop 发**一个** mini-turn,无 `slice`/`final` 属性,**渲染等价今天、可与别的短 turn 合并**（行为零变化）。
- 一个 turn ↔ **多个** mini-turn；存储始终是**一条** T 记录。recall / timeline / replay 全部不感知 mini-turn，渲染层零改动。
- obs 仍折进 mini-turn 当上下文、push 后自动标 `skipped`（沿用现状），**不**做 obs 级独立抽取。

### 流式触发与切块

**D2 — 流式触发（buffer 凑够阈值就 flush，不等 turn-stop）**

- 新 config knob `maxMiniTurnChars`（默认 `24000`，约 6K token/片）。
- **触发在 drain 路径**：`scanAndDrainQueue` 把 obs 推进 per-session buffer 后（每工具一次 wake，已存在），检查**当前 in-progress turn**（= 最新 turn）已 buffer 的 obs **完整渲染字符数**；一旦 ≥ `maxMiniTurnChars - reserve` → 在 `withSessionProcessingLock` 内 peel 一个 ≤budget 的 obs chunk、`buildMiniTurn(streaming)` flush 一个**流式片**、把该 chunk 移出 buffer。剩余 obs 继续留 buffer 等下次。
- **turn-stop**：flush **final 片** = buffer 里该 turn剩余 obs + response + files + tool_count（`final="true"`）。若 `剩余 obs + tail` 仍 > budget,先 peel 出流式片、再发只含 tail 的 final（复用 peel 逻辑）。
- **K 未知**（流式时 turn 没结束,不知道总片数）→ 编号用开放式 `slice="n"`（无 `/K`）,final 片额外带 `final="true"`。短 turn 不带任何属性。
- **per-turn 流式状态**（`SessionState` 新增 `streamedParts: Map<turnId, nextPartIndex>`）：记某 turn 是否已流式过、下一个 partIndex。turn-stop 时据此决定 final 片是 `slice`（流式过 → solo）还是普通可合并 mini-turn（从没流式 → merged 路径,D6）。
- **预算针对"完整渲染后的 mini-turn 字符串"**（Codex 点 2）。流式片固定开销 = `prompt`（每片重复 ≤1000）+ `slice` 标记 + `<prior_turn>`（非首片 ≤~500 预留,D4）；**流式片无 tail**（response/files 只在 final）。final 片固定开销额外含 tail（`response` ≤1000 + capped `files_*` + `tool_call_count`）。obs chunk 占 `maxMiniTurnChars - 该片固定开销`。
- **prior_turn 按固定 `PRIOR_TURN_RESERVE`（~500）预留,不在 sizing 时渲染实际内容**——流式天然在 flush 时构建每片,prior_turn 此刻现读即最新（D4）。
- **每个组成字段都必须有界**（Codex round-2 点 1）：obs 块 `truncateMiddle` 截死（≤~720 字符），prompt/response ≤1000，prior_turn ≤~500。**唯一没截断的是 `renderFileTree`（`file-tree.ts:71`）**——final 片的 `files_*` 是唯一超预算来源。
- **文件树 char cap**：final 片 `files_*` 各截到 `FILE_TREE_CAP=1500`,超出尾随 `\n  ...(+N more files)`。final 固定开销有界（prompt 1000 + prior 500 + response 1000 + files 1500×2 + 结构 ~300 ≈ 5800）。
- 由此**每条发出的消息渲染后 ≤ maxMiniTurnChars 是按构造成立的不变量**：所有字段有界 + D10 floor（≥ 8192）保证"固定开销 ~5800 + 至少一个 ≤720 obs"恒容下,**永不因尺寸丢弃 obs**。留一条防御性断言（构建出 > budget 则 `log()`），设计上不触发。
- **watchdog 兜底**：长 turn 末尾残余 obs 不足阈值、又久无新 obs 时,靠 turn-stop 收尾即可;无需额外 timer flush（turn-stop 必到）。
- **与 `mergeThresholdChars` 共存且正交**（见 D6）：短 turn（从不流式）仍合并;流式过的 turn 的每片 solo。`mergeThresholdChars=1000` 保持原值。

### mini-turn 消息格式

**D3 — 流式片 / final 片 / 短 turn 三种渲染**

流式片（turn 进行中）—— 只带本片 obs + 重复 prompt + 开放序号（`isFirstSlice` 判定见 D6）:

```
  <turn id="T7" slice="2">
    prompt: <≤1000，每片重复>
    <obs id="O...">…</obs>     ← 本片的 obs 子集
    ...
  </turn>
```

final 片（turn-stop,turn 流式过）—— 补 response + capped files + tool_call_count + `final`:

```
  <turn id="T7" slice="5" final="true">
    prompt: <≤1000>
    <obs id="O...">…</obs>     ← 最后一段 obs（可能为空,见 D2 tail 溢出）
    response: <≤1000>
    files_read:                ← 全 turn 聚合,capped FILE_TREE_CAP
      ...
    files_modified:
      ...
    tool_call_count: <全 turn 总数>
  </turn>
```

短 turn（从不流式）—— 今天的 `<turn id="T7">`,**无** `slice`/`final` 属性,带 response/files。

- `slice="n"` **开放序号无 `/K`**（K 未知）;`final="true"` 标记 turn 完整。短 turn 两者都不带。
- **prompt 每片重复**（≤1000）,保证每片自带"这是哪个 turn 的工作"。
- `response` / `files_*` / `tool_call_count` 是 turn 终态字段,**只在 final 片**渲染。
- 复用 `buildBatchTurnBlock` 的缩进与 obs 渲染;新增 `slice`/`final` 属性与"final 才带 response/files"的条件分支。

**D4 — 非首片注入 T7 当前状态（prior_*）**

非首片（`needsPriorTurn = !isFirstSlice`）在 `<turn>` 块后附 `<prior_turn>` 块，复用 session 已有的 `prior_*` 机制：

```
  <prior_turn id="T7">
    title: <T7 当前 title>
    content: <T7 当前 content>
    insight: <T7 当前 insight>
  </prior_turn>
```

- 让 agent 基于"**持久化的 T7 现状 + 本片新 obs**"精修，而非依赖 SDK 对话历史还在——抗 auto-compact。
- 仅 `needsPriorTurn`（首片 T7 还没内容,不注入）。
- **flush 时现读 T7**（流式天然满足,但仍须明确）：每个流式片在**它被触发 flush 的那一刻**构建,此刻 `getTurnById(turnId)` 拿到的就是前序片 `remember` 写入的最新 T7（流式片串行 flush,slice n 的 push 在 slice n-1 的结果之后）。`MiniTurnPayload` **不**烘进 prior_turn 内容,只带 `needsPriorTurn` 标志,渲染时 `processMiniTurn` 现读。（这条在流式下是自然结果,但写明以防实现者预烘。）

### 动态更新语义

**D5 — 每片动态重写 T7 + 系统提示豁免**

- 每个 mini-turn，agent **可以**调 `remember({id:"T7", title, content, insight, type, tags})` 用截至本片的累积理解**更新** T7。复用既有字段级 merge 语义（指定字段覆盖、tags 追加；见 invalidated-turn-detection spec D12）。
- 首个成功 `remember` 把 `status` 从 `active` 升 `extracted`（既有自动升格 `turns.ts:173-175`，代码检查确认存在）；后续片是对 `extracted` 记录的更新——`updateTurnById` 的字段级 merge（`input.X ?? existing.X`）令 content 后写覆盖前写、未给字段保留，**这正是想要的"动态精修"**，final 片自然产出最完整版本。中途某片失败，T7 仍留着上一片写好的连贯版本（优雅降级）。
- **已知小代价**：每片成功 `remember` 都触发一次 `indexTurnToFTS`（`turns.ts:261-262`，status=extracted 时）。即同一 T7 在多片里被重复 re-index 多次——幂等、开销小，可接受，不优化。
- **agent 自主决定是否更新**（用户决策 4）：某片 obs 没带来新信息时，agent **不调用任何工具**（空响应 = "保持现状"），沿用 `query-session.ts:256` 既有语义。
- **`final="true"` 语义**：标记 turn 已完整（response/files 已到）。agent 在 final 片产出最完整的 T7。流式片（`slice="n"` 无 final）= "同一 turn 的第 n 段,继续精修,后面还有"。
- **系统提示不变量豁免**（必须明确写）：现行提示写死 *"Never revisit records from earlier messages"* 与 *"Never update other turns"*。流式场景正面违反第一条。新章节须开口子：**仅当当前 `<turn>` 带 `slice` 属性（流式 turn）时，允许跨多条消息重复 `remember()` 同一个 T 记录**；无 `slice` 属性的普通 turn 仍严禁 revisit。与 invalidation reminder 的"已抽取 turn 修订"是两套独立机制，提示里划清边界。

### 缓存 / 调度

**D6 — Flush-unit 模型（钉死 BatchEntry 粒度）+ 调度**

**Flush-unit 不变量 = 判别式联合，不用运行时谓词**（Codex 点 1 + audit #4）：`BatchEntry` = **一次 flush = 一条发出的消息**，用 `kind` 字段判别两形态：

```ts
type BatchEntry =
  | { kind: "merged"; miniTurns: MiniTurnPayload[]; attempts: number; sessionUpdated: boolean; size: number; oldestTurnEpoch: number }   // 多个短 turn（从不流式）的 mini-turn，可按 mergeThresholdChars 合并
  | { kind: "slice";  miniTurn:  MiniTurnPayload;   attempts: number; sessionUpdated: boolean; size: number; oldestTurnEpoch: number };  // 流式过的 turn 的一片（流式片或 final 片），恒 solo、永不合并
```

- `kind:"slice"` 持**单数 `miniTurn`**（类型上钉死"恰好一片"，消灭"往切片批里塞第二个 turn"的 footgun）。`attempts` 在两 variant 上都有（合并批也会 drop，见 D8）。所有 `batchQueue` 站点（`enqueueCompletedTurnLocked` `:821`、`pruneBatchQueueLocked` `:470`、`recalculateBatchSize` `:426`、keepalive `:1005`）`switch(batch.kind)`，不再各自重推谓词。
- **判别来源 = "该 turn 是否已有过 delivery"（重启安全，Codex 点 2）**：`hadPriorDelivery = streamedParts.has(turnId) || turn.status !== "active"`。**不能只看内存 map**——若 slice 1 已成功（obs skipped、T 已 `extracted`）但 worker 在 turn-stop 前重启,`streamedParts` 清空,只看 map 会把 final 误判成短 turn、丢 `slice`/`final`/`<prior_turn>` 语义。turn-stop 时 `turn.status !== "active"` 是"流式已写入过"的**持久信号**（短 turn 在它自己的 turn-stop 仍是 `active`,只有被流式片 `remember` 过的 turn 才非 active）。流式片 flush → `slice`；turn-stop → `hadPriorDelivery` 则 `slice`（final 片）、否则当短 turn 进 `merged`。
- `MiniTurnPayload` 带**派生角色布尔**（Codex audit #5，构建时一次算定）：`partIndex (n)` / `isFirstSlice (= !hadPriorDelivery)` / `isFinal` / `needsPriorTurn (= hadPriorDelivery)`。**无 `sliceTotal`**（K 未知）。重启后 `streamedParts` 丢失但 `status≠active` → `isFirstSlice=false`、`needsPriorTurn=true`、`partIndex` 从 1 重起（开放序号,cosmetic,prior_turn 现读带回累积状态）。
- `flushOneBatchLocked` 每次 flush 一个 BatchEntry；`sendPrompt` 逐个 await，天然串行 + 有序。
- `cacheTtlMs` / keepalive 自动**以 BatchEntry 为粒度**运作（流式每片是一次 push、刷新 `lastPushAt`，长 turn 期间 cache 持续热）。
- **同 turn 的片有序**：流式片在 turn 进行中**增量入队**、final 片 turn-stop 入队,`state.batchQueue` FIFO;一个 session 同时只有一个 in-progress turn,故同 turn 的片天然相邻、按 partIndex 顺序 flush。
- **Envelope / session-context = "首个成功 delivery 携带,一次"（Codex 点 4，删掉 isFirstSlice 门）**：**不**给 `pushMessage` 加 `includeEnvelopes` 门、不绑 `isFirstSlice`。沿用 shipped 机制即天然正确：`pushMessage` 每次按当前 pending 计算 envelope,**push 成功后** `markReminderItemsNotified`/`markSubagentTurnsNotified` 把它们翻 notified（`server.ts:596,608`）→ 后续片 `getReminderItems` 返空、不重复;若首片 **dropped**(失败),没翻 notified → 下一片仍带,**直到首个成功片**。session-context 同理:`sessionUpdated` 失败时由 `flushOneBatchLocked` catch 把 `nextBatchNeedsSessionContext` 复原（`server.ts:791-792`）→ 顺延到下一片。envelope 很小(≤10 reminder 行),不构成"重复 K 次"问题。**这条同时取代之前 audit #5 的 includeEnvelopes 接口**（那个门正是 Codex 点 4 的 bug 源）。
- **inline `invalidated` 属性**（沿用 invalidated-turn-detection spec 的 D9a，非本 spec 的 D9）：invalidation 在 turn-stop 才检测（`applyInvalidation`），**晚于流式片**——故流式片通常**不**带 `invalidated`（检测时还没发生）;若 turn-stop 时已置 `was_*`,final 片渲染 `invalidated="..."`,其余靠 reminder 通道修订。这与"流式片已抽 T7、turn-stop 检测到 invalidation 打 tag → reminder 修订"一致,无需特殊处理。

### obs / turn-stop 生命周期

**D7 — peel-and-skip，final 片删 turn-stop**

- **流式片 push 成功后**，把该片 peel 出的 obs 标 `skipped` 并从 buffer 移除（已在 peel 时移出 buffer;push 成功后落 `skipped`）。注意现有 `processBatch` 的 obs-skip（`processors.ts:638-653`）**只对 `completedTurnIds` 生效**;流式片没有 turn-stop,必须改为**无条件标记本片 obs skipped**。
- **turn-stop queue item 只在 final 片 push 成功后删除**——流式片不持有 turn-stop item。
- **单一渲染器，不留双路（Codex audit #3）**：现版 `processBatch` 是 turn-stop 驱动——`completedTurnBlocks` 全从 `options.turnStopItems` 构建、`if (completedTurnBlocks.length === 0) return`（`:617`）会让无 turn-stop 的流式片**什么都不 push**、obs-skip gate 在 `completedTurnIds`。**统一方案（强制）**：
  - 流式片与短 turn 的 mini-turn 都过**同一**渲染原语 `renderMiniTurn(payload): string`：吃完全解析好的 `MiniTurnPayload`（`turnId` / obs 子集 / 角色布尔 / `priorTurn` 已现读）,turn 块从 `turnId` 渲染、与 turn-stop 无关。`merged` 批就是 `miniTurns.map(renderMiniTurn)`。
  - 唯一副作用器 `applyMiniTurnSideEffects(payload)`：obs-skip（**无条件**标记本片 obs）+ turn-stop 删除（仅 `isFinal`）。
  - `currentPrompt` 推导、files 聚合等**只对合并/final 有意义的逻辑**（`processors.ts:579-599`）移进 payload 构建,**不**留渲染器。
  - **不**保留 `processMiniTurn` vs `processBatch` 双函数。
- 一个 turn 的所有 obs 跑完（skipped）+ final 片完成（turn-stop 删除）→ 该 turn 彻底离开队列;`SessionState.streamedParts` 里该 turnId 的条目也清掉。

### 失败处理

**D8 — 重试 N 次后丢弃该片（结果态机，不与 drain 循环冲突）**

- 新 config knob `maxFlushAttempts`（默认 `3`）。
- attempts **记在内存里**（`BatchEntry.attempts`），不落库——避免给 `pending_queue` 加列做迁移。worker 重启时 `recoverFromCrash` 重置 claim、obs 重新入 buffer、**重新流式、attempts 归零、`streamedParts` 清空**（重启 = 干净重试），可接受。
- **`flushOneBatchLocked` 改为返回结果态、不再 throw 给上层做控制流**（Codex 点 3，解决与 `flushAllBatchesLocked` 的 `while` 连续 flush 冲突）：

  ```ts
  type FlushOutcome = "flushed" | "retryLater" | "dropped";
  ```

  - 成功 → `"flushed"`：`applyMiniTurnSideEffects`（obs skip + 若 `isFinal` 删 turn-stop;merged 批删批内所有 turn-stop）,shift off,继续。
  - push 失败且 `++attempts < maxFlushAttempts` → `"retryLater"`：**保留该 BatchEntry 在队首**（不 shift off、不 release claim）。
  - push 失败且 `attempts >= maxFlushAttempts` → `"dropped"`：**跑与 `flushed` 相同的 `applyMiniTurnSideEffects`**（obs skip + 若 `isFinal` 删 turn-stop;merged 批删批内**所有** turn-stop）—— 否则 final/merged 的 turn-stop 留在队列会卡死 drain 或 recover 后重复处理（Codex 点 3）。**额外**给该 turn 打 `delivery:dropped:notify-pending`（D9,显式 `status: turn.status`）。shift off,继续后续片。`dropped` 与 `flushed` 的唯一差别 = 没成功送达 agent（故打 tag）,队列生命周期**完全一致**。
- **打 tag 必须显式传 `status: turn.status`（代码检查发现的陷阱）**：`updateTurnById`（`turns.ts:173-175`）在 `status` 省略时会把 `active` 自动升 `extracted`。给一个 **flush 单元（切片或合并批）被丢弃、turn 仍未抽取**（status 仍 `active`）的 turn 打 `delivery:dropped` 标记时，若不显式传 `status: turn.status`，会被误升为 `extracted` —— 既污染状态，又让 D9 的"not yet extracted"分支永不触发。用 `updateTurnById(db, id, { status: turn.status, tags: [DELIVERY_DROPPED_PENDING], updatedAtEpoch })`（照 `applyInvalidation:230` / `markReminderItemsNotified:322` 的写法）。
- **`flushAllBatchesLocked` 循环按结果态分支**：`"flushed"` / `"dropped"` → 继续 while；**`"retryLater"` → `break`（立即停止本次 drain）**，避免在同一次 drain 内把 attempts 一路烧到上限的热循环。队首那个 retry-pending 的 BatchEntry 把后续 FIFO 也挡住，符合"有序"语义。
- **重试触发**：在 10s 的 watchdog tick（`setInterval(WATCHDOG_INTERVAL_MS)` → 现有 `runKeepaliveTick` 旁）新增一条逻辑，给 retry-pending 批一个 ≥10s 间隔的可靠重试节拍（不依赖偶发 wake / cache 到期）。
- **锁语义（Codex round-2 点 2，必须照抄 `tryKeepaliveSession` 的并发纪律）**：retry tick 对每个 session：
  1. **先 skip `compactingSessions.has(sessionDbId)` 的 session**（compact 期间不碰其队列）。
  2. **`await withSessionProcessingLock(sessionDbId, ...)`**——所有判断与 flush 都在锁内，**绝不在锁外读写 `batchQueue` / attempts**，避免与 `processTurnStop`、keepalive、compact 并发碰队列。
  3. 锁内：`pruneBatchQueueLocked` 后看队首 BatchEntry，若 `attempts ∈ (0, maxFlushAttempts)` 则**绕过 keepalive 的 cache-age gate**调一次 `flushOneBatchLocked`；否则不动。
  既不热循环也不饿死。
- 丢弃是**片级**：T7 第 3 片丢了，第 4、5 片照跑，T7 最终是"缺一段 obs"的部分记录。
- **注**：结果态同样适用于合并批——一个小 turn 合并批连续失败到上限也会被 `"dropped"`（今天是无限重试），并给其中每个 turn 打 `delivery:dropped` tag。这顺带堵掉了现有的"巨 batch 无限重试"footgun，是有意的统一。

**D9 — delivery-dropped 注册为一个 reminder reason（基于 D0）**

"delivery-dropped" = **一个 flush 单元（切片或合并批）连续失败到 `maxFlushAttempts` 被丢弃**，turn 的记忆可能不完整。语义对切片（少一段 obs）和合并批（整个小 turn 没送达）统一，故名 delivery-neutral。D0 通用化后塌缩成**一个 descriptor**（含 D0 的 flagToken/tail 渲染片段），不再有平行 track：

```ts
{ key:"delivery-dropped",
  pendingTag:"delivery:dropped:notify-pending", notifiedTag:"delivery:dropped:notified",
  qualifies: t => t.status !== "undone",        // 保留 active —— 全 flush 单元失败、从未抽取的 turn 也要进
  data: (t) => ({ notExtracted: t.status === "active",
                  prompt: t.status === "active" ? truncate(t.userPrompt, 200) : null }),
  flagToken: () => "delivery_dropped",
  tail: (t, d) => d.notExtracted
    ? `one or more parts of this turn could not be delivered; record intent if possible`
    : `record may be incomplete, one or more parts could not be delivered after repeated failures` }
```

- 加进 `REMINDER_REASONS` 即获得 collect / merge / notify / limit / silenced + 渲染全部通用行为。`qualifies` 覆盖 `active` 是它与 invalidation 唯一的策略差异。
- **渲染行**（由 D0 的 grammar + 此 descriptor 的 flagToken/tail 组合，无需改 `buildReminderEnvelope` 主体）：
  - 已部分抽取（有 priorTitle）：
    `- T7 (delivery_dropped): "Run /goal migration" -- record may be incomplete, one or more parts could not be delivered after repeated failures`
  - 从未抽取（`notExtracted`）：
    `- T7 (delivery_dropped, not yet extracted): prompt="<≤200 字符>" -- one or more parts of this turn could not be delivered; record intent if possible`
- **不渲染精确 chunk 数**（Codex 点 4）：boolean tag 算不出 `N`、attempts 内存态重启即丢，无可靠计数源。措辞用"one or more parts"。
- 一个 turn 同时命中 invalidation + delivery-dropped → `reasons` 含两者，一行里两个 flag 都出现（D0 的 merge 天然处理）。
- **写入侧**（D8）：flush 丢弃时 `addPendingReason(turn.tags, deliveryDroppedReason)` + `updateTurnById({ status: turn.status, ... })`。

### 配置

**D10 — 两个新 knob**

```ts
export interface MnemoConfig {
  mergeThresholdChars: number;   // 不变，1000
  maxQueuedBatches: number;      // 不变，3
  keepaliveLeadMs: number;       // 不变
  cacheMode: "5m" | "1h" | "auto"; // 不变
  maxMiniTurnChars: number;      // 新增，默认 24000
  maxFlushAttempts: number;      // 新增，默认 3
}
```

- `maxMiniTurnChars` 权衡：偏小 → 切片多、agent round-trip 多（500 调用 / 24000 ≈ 15 片）；偏大 → 单片 blast radius 大、失败重试更贵。24000 是保守起点，用户可在 `~/.claude-mnemo/config.json` 调。
- **下限钳制**：`loadConfig` 把 `maxMiniTurnChars` clamp 到 `≥ 8192`（用户配更小值时取 8192 并 `log()` 一次），保证 final 片固定开销（prompt + prior_turn + tail 含 capped 文件树 ≈ 5800）加至少一个 ≤~720 字符 obs 总能容下——使 D2 的"≤ budget"按构造成立。`maxFlushAttempts` clamp 到 `≥ 1`。
- `DEFAULT_CONFIG` + `loadConfig` 的 `...DEFAULT_CONFIG, ...raw` spread 自动让老 config 文件拿到新默认值，无需迁移；clamp 在 spread 之后执行。

---

## Changes

### `src/shared/config.ts`
- `MnemoConfig` 加 `maxMiniTurnChars` / `maxFlushAttempts`；`DEFAULT_CONFIG` 填 `24000` / `3`（D10）。
- `loadConfig` 在 spread 后 clamp：`maxMiniTurnChars ≥ 8192`、`maxFlushAttempts ≥ 1`（D10）。

### `src/shared/file-tree.ts`
- `renderFileTree(paths, opts?: { maxChars?: number })`：传 `maxChars` 时把输出截到该长度，并尾随 `\n  ...(+N more files)`（D2 文件树 cap，`FILE_TREE_CAP=1500`）。无 `maxChars` 时行为不变（其它调用点不受影响）。

### `src/worker/processors.ts`
- 新 `buildMiniTurn(turnId, obsItems, opts: { partIndex, isFirstSlice, isFinal }, config): MiniTurnPayload`——构建**一片**（流式或 final）。`MiniTurnPayload { turnId, partIndex, isFirstSlice, isFinal, needsPriorTurn, obsItems(子集), turnStopItem | null, size }`（**角色布尔此处算定**,D6 #5;**不**存 prior_turn 内容,D4）。`isFinal` 控制是否渲染 response/files/tool_count;final 的 files 用 `renderFileTree(..., {maxChars: FILE_TREE_CAP})`（D2）。
- 新 `peelMiniTurnObs(bufferedObs, opts, config): { chunk, rest }`——按 D2 预算从 buffered obs 头部 peel 一个完整渲染 ≤budget 的 chunk（扣固定开销 + 仅 final 扣 tail）;`currentPrompt`/files 聚合在构建片时算定,不留渲染器。
- `buildBatchTurnBlock` 扩参：`partIndex`（渲染 `slice="n"`,流式/ final 时）、`isFinal`（渲染 `final="true"` + response/files/tool_count,D3）、可选 `priorTurn`（`needsPriorTurn` 时注入,D4）。短 turn 不传这些 → 渲染等价今天。
- **单一渲染路径（D7，Codex audit #3，无双路）**：流式片与短 turn mini-turn 都走唯一渲染原语 `renderMiniTurn(payload)` + 唯一副作用器 `applyMiniTurnSideEffects(payload)`（obs-skip 无条件标记本片 obs,不再 gate `completedTurnIds`/`:638-653`;turn-stop 仅 `isFinal` 删）。去掉 `:617` 对流式片的误 return。**不**保留 `processMiniTurn` vs `processBatch` 双函数。
- **flush 侧在 push 前现读 `prior_turn`**（D4）：`needsPriorTurn` 时 `getTurnById(turnId)` 取 T7 最新 title/content/insight 传 `buildBatchTurnBlock` 的 `priorTurn`;payload 不存其内容。

### `src/worker/server.ts`
- **流式触发（D2，核心新增）**：`scanAndDrainQueue` 把 obs 推进 buffer 后,在 `withSessionProcessingLock` 内检查 in-progress turn 的 buffered obs 渲染尺寸;≥ 阈值则 `peelMiniTurnObs` + `buildMiniTurn(streaming)` + 入队一个 `slice` BatchEntry + flush,并更新 `SessionState.streamedParts`（记 turnId → 下一 partIndex）。
- **`SessionState` 新增 `streamedParts: Map<number, number>`**（turnId → nextPartIndex）。turn 彻底处理完清该条目。重启会丢（内存态）——故 turn-stop 判别**不只看它**（见下）。
- **Flush-unit 判别式联合（D6，Codex audit #4 + 点 2 重启安全）**：`BatchEntry = { kind:"merged"; miniTurns[] } | { kind:"slice"; miniTurn }`,两 variant 都带 `attempts`。turn-stop 路径（`enqueueCompletedTurnLocked`）判 `hadPriorDelivery = streamedParts.has(turnId) || getTurnById(turnId).status !== "active"`：true → final 片成 `slice` BatchEntry（`isFinal`、`needsPriorTurn`）;false → 短 turn mini-turn 进 `merged`。**`status !== active` 是重启后仍可靠的"流式已写入"持久信号**。流式片走触发路径直接成 `slice`。所有 `batchQueue` 站点 `switch(batch.kind)`。
- **`flushOneBatchLocked` 返回 `FlushOutcome = "flushed" | "retryLater" | "dropped"`，不再用 throw 做控制流（D8 点 3）**。`flushAllBatchesLocked` 按结果态分支：`flushed`/`dropped` 续 while、`retryLater` `break`。**`flushed` 与 `dropped` 都跑 `applyMiniTurnSideEffects`**（obs skip + `isFinal` 删 turn-stop / merged 删全部 turn-stop,Codex 点 3）;`dropped` 额外打 delivery-dropped tag。
- **新增 retry 节拍**：watchdog `setInterval` 里对队首 `attempts ∈ (0, max)` 的 session 绕过 cache-age gate 调一次 flush（D8）。
- **`pushMessage` 不加 `includeEnvelopes` 门（Codex 点 4,撤销之前 audit #5 的接口）**：沿用 shipped 行为——每次 push 按当前 pending 算 envelope,**成功后** `markReminderItemsNotified`/`markSubagentTurnsNotified` 翻 notified（`:596,608`）→ 自然"首个**成功**片携带一次";失败片不翻 notified,顺延到下个成功片。session-context 靠 catch 复原 `nextBatchNeedsSessionContext`（`:791-792`）同样顺延。`getReminderItems`/`getSilencedReminderItems`/`markReminderItemsNotified` **公开名保留**;`buildReminderEnvelope` 重构成**只拥行 grammar、按 descriptor `flagToken`/`parenExtra`/`tail` 组合**（audit #1），不硬编码各 reason。

### `src/worker/invalidation.ts`（前置重构 D0 + D9 注册）
- **D0 通用化（独立 commit;可观察行为保持,但 `ReminderItem` 形状变 → apply/reminder 的 shape 断言需更新,Codex 点 1）**：
  - 引入 `ReminderReason` descriptor（`key`/`pendingTag`/`notifiedTag`/`qualifies` + 渲染片段 `data`/`flagToken`/`parenExtra?`/`tail?`，Codex audit #1）+ `REMINDER_REASONS` 数组（interrupt / rollback 沿用原 tag 字面量与原 envelope 文案）。
  - `selectPendingReminderItems` → `collectReminderItems`：registry 驱动，per-reason `qualifies` 取代写死的 `status != active`；`ReminderItem` 改 `reasons: {reason, data}[]` + 共享 `priorTitle`/`priorContent`，**不展平** per-reason 字段（rollback 的 `replacement`、delivery-dropped 的 `notExtracted`/`prompt` 进各自 `data`）。
  - `addPendingKind`/`markKindsNotified` → `addPendingReason`/`markReasonsNotified`（按 descriptor）。`markReminderItemsNotified` 按 `item.reasons` 翻 tag，仍显式 `status: turn.status`。
  - 删除 `InvalidationKind` 闭合 union、`PENDING_TAGS`/`NOTIFIED_TAGS` 的 `Record<InvalidationKind,...>`、`getPendingKinds` 硬编码。
- **D9 注册 delivery-dropped reason**：`REMINDER_REASONS` 加一项（`qualifies: status != undone`，自带 `data`/`flagToken`/`tail`）。加 reason **只动数组**，不碰 collect/notify/envelope 主体。**不加 chunk 计数**（点 4）。

### `src/worker/query-session.ts`
- 新增 `## Streamed turns (mini-turns)` 系统提示章节（D3/D5）：解释 `slice="n"`（流式片,更多在后）、`final="true"`（turn 完整,产出最终 T7）、`<prior_turn>`、动态更新、"无新信息可空响应"、以及**带 `slice` 属性时允许** revisit 同一 T 的不变量豁免。
- 保留现有 `## Turn messages` 章节；明确豁免只对带 `slice` 属性的（流式）turn 生效,普通 turn 仍禁 revisit。

### 无 schema 改动
- attempts 内存态（D8），delivery-dropped 复用现有 `tags` 列（D9），config 走 spread 默认值（D10）。`pending_queue` / `turns` 表结构不变。

---

## Tests

### 前置（D0，可观察行为保持）

- **行为保持验收（Codex 点 1 纠正,非"一行不改"）**：
  - rollback / schema 及不碰 `ReminderItem` 形状的测试**一行不改、全绿**。
  - `invalidation.apply.test.ts:208` / reminder 测试里**断言旧扁平 `ReminderItem` 字段**（`wasInterrupted`/`wasRolledBack`/`priorTitle`/`priorContent`/`replacementPromptNumber`）的 `expect.objectContaining(...)` **更新成 `reasons[]` 形状**——类型变更,非行为回归。
  - envelope 输出逐字节、tag 迁移、DB 写入**不变**,由下方 `reminder-reasons.test.ts` 保证。
- `tests/worker/reminder-reasons.test.ts`（新）
  - registry 驱动的 `collectReminderItems` 在纯 interrupt / 纯 rollback / 两者并存 turn 上，与旧 `selectPendingReminderItems` 输出等价（同样的 `status != active` 排除、同样的排序、同样的 `REMINDER_LIMIT`/silenced 切分）。
  - **渲染逐字等价（Codex audit #1）**：descriptor 的 `flagToken`/`parenExtra` 组合出的 envelope 行与旧 `buildReminderEnvelope` **逐字符相同**——尤其 rollback 的 `replaced by T<m>` 仍在 `(...)` 内、位置不变（守住 D0 行为保持）。
  - `markReminderItemsNotified` 按 `reasons` 翻原字面量 tag（`invalidated:notify-pending:* → :notified:*`），显式 `status` 不升格。
  - 新 reason 加进 `REMINDER_REASONS` 即被 collect/notify/渲染接管，无需改 envelope 主体（加一个 fake reason 验证扩展点：只给数组加一项就能出现在 envelope 行里）。
  - **Tag namespace 隔离（D0 不变量）**：一个 turn 只带 agent 自由连字符 tag `delivery-dropped`（无冒号内部 tag）→ `collectReminderItems` **不**把它当 delivery-dropped reminder（断言不进 reminder）;只有带冒号 `delivery:dropped:notify-pending` 才进。reason `key="delivery-dropped"` 与该自由 tag 字面相同但互不影响。

### 新增

- `tests/worker/processors.mini-turn.test.ts`
  - `peelMiniTurnObs`：从 buffered obs 头部 peel 一个 ≤budget chunk,rest 留;obs 按 seq 升序、不重不漏、chunk+rest = 输入。
  - `buildMiniTurn` 流式片（`isFinal=false`）：渲染 `slice="n"`、**不**带 response/files/tool_count;final 片（`isFinal=true`）：带 `final="true"` + response/files/tool_count。短 turn（无 partIndex）：渲染等价旧 `buildTurnPayload`（回归保护,无 slice/final 属性）。
  - **完整渲染验收（Codex 点 2）**：对构建出的每片调实际 block builder,断言**渲染后字符串长度 ≤ maxMiniTurnChars**;构造 obs 刚好顶满 + prompt 又长的 case 仍不超。
  - final tail 放不下 → **先 peel 流式片、final 只剩 tail**（可 `obsItems.length===0`）,断言仍 ≤ budget。
  - `needsPriorTurn`（非首片）带 `<prior_turn>` 注入;首片不带。
  - **文件树 cap（Codex round-2 点 1 正解）**：碰几百文件的 turn → final 片 `files_*` 各截到 `FILE_TREE_CAP`、带 `(+N more files)`、final 仍 ≤ budget;"≤ budget"对所有片无条件成立。
  - `slice="3"`（开放序号,无 `/K`）/ `final="true"` 属性文本精确。

- `tests/shared/file-tree.test.ts`（扩）
  - 传 `maxChars` → 输出 ≤ maxChars 且尾随 `(+N more files)`，N 为被省略文件数。
  - 不传 `maxChars` → 输出逐字不变（现有调用点回归保护）。

- `tests/worker/server.streaming.test.ts`
  - **流式触发（D2 核心）**：往一个 in-progress turn 喂 obs,buffered 渲染尺寸跨过阈值 → **立即** flush 一个流式片(`slice="1"`),该 chunk 移出 buffer、标 skipped、`streamedParts` 记 turnId→2;继续喂 → `slice="2"`;turn-stop → `final="true"` 片(带 response/files)。**未跨阈值前不 flush**。
  - **短 turn 不流式**：obs 从没跨阈值 → turn-stop 一次 flush、无 slice/final 属性、进 `merged`、可与别的短 turn 合并（= 今天行为）。
  - **Flush-unit 判别式联合（Codex 点 1 + audit #4）**：`kind:"slice"` 持单数 `miniTurn`、`kind:"merged"` 持 `miniTurns[]`;`switch(kind)` 无运行时谓词。
  - **重启续流式（Codex 点 2）**：slice 1 成功（obs skipped、T `extracted`）后清空 `streamedParts` 模拟重启 → turn-stop 仍据 `status !== "active"` 判为 final 片（带 `slice`/`final`/`<prior_turn>`,partIndex 从 1 重起）,**不**被误当短 turn 进 `merged`。
  - 同 turn 的片按 partIndex 顺序 flush（FIFO,session 内单 turn 进行,天然相邻）。
  - 每片成功后仅本片 obs 标 skipped；turn-stop 仅 final 片删 turn-stop item。
  - **Envelope 首个成功片携带、一次（Codex 点 4）**：slice 1 成功 → 带 reminder envelope、随后 `markReminderItemsNotified` → slice 2 envelope 为空。**slice 1 dropped（首片失败到上限）→ reminder 未 notified → slice 2 仍带 envelope**（断言 envelope 不因首片丢弃而丢失）。session-context 同理顺延。
  - **prior_turn 现读时序**：让 slice 1 的 push 写入 T7,断言 slice 2 push 前渲染的 `<prior_turn>` **反映 slice 1 写入的内容**(非空);`MiniTurnPayload` 不含 prior_turn 内容。
  - **inline `invalidated`**：流式片(invalidation 未检测)不带;turn-stop 后 `was_*` 已置则 final 片带。
  - 缓存：每片独立刷新 `lastPushAt`(长 turn cache 持续热)。

- `tests/worker/server.flush-retry.test.ts`
  - **结果态（Codex 点 3）**：`flushOneBatchLocked` 首次失败返回 `"retryLater"`、attempts=1、BatchEntry 留队首、claim 未释放。
  - **`flushAllBatchesLocked` 遇 `"retryLater"` 立即 `break`**，同一次 drain 内**不**把 attempts 烧到上限（断言只 +1）。
  - 连续失败到 `maxFlushAttempts` → 返回 `"dropped"`、丢弃本片 obs（标 skipped）、turn 打 `delivery:dropped:notify-pending`、后续片照跑。
  - **dropped 跑全套 side effects（Codex 点 3）**：`isFinal` 片 dropped → **turn-stop item 被删除**（断言队列不卡、recover 不重复处理）;merged 批 dropped → **批内所有 turn-stop 都删**。即 dropped 与 flushed 的队列生命周期一致,差别仅是打了 delivery-dropped tag。
  - **Retry 节拍**：watchdog tick 对队首 `attempts ∈ (0,max)` 的 session 绕过 cache-age gate 触发一次 flush（断言 cache 未到期也会重试）。
  - **Retry 锁语义（Codex round-2 点 2）**：retry tick skip `compactingSessions` 中的 session；flush 在 `withSessionProcessingLock` 内进行（断言 compacting session 不被 retry tick 触碰、且不在锁外改 `batchQueue`）。
  - 丢弃后该 turn 的 final 片仍能完成、turn-stop 删除。
  - attempts 内存态：模拟 recoverFromCrash → claim 重置、`streamedParts` 清空、重新流式、attempts 归零。

- `tests/worker/invalidation.delivery-dropped.test.ts`
  - `getReminderItems` 拉 `delivery:dropped:notify-pending` turn，含 status=active（从未抽取）与 status=extracted（部分抽取）两种。
  - 排除 `undone`。
  - **自动升格陷阱（代码检查发现）**：给 status=`active` 的 turn 打 delivery-dropped tag 时显式传 `status: turn.status` → status **保持 active**（断言**没有**被 `updateTurnById` 自动升 extracted），`notExtracted=true` 分支正确触发。
  - 部分抽取行格式：`- T7 (delivery_dropped): "<title>" -- ... one or more parts could not be delivered ...`（**无精确数字**，Codex 点 4）。
  - 未抽取行格式：`- T7 (delivery_dropped, not yet extracted): prompt="<≤200>" -- one or more parts of this turn could not be delivered ...`。
  - push 后 `markReminderItemsNotified` 把 `delivery:dropped:notify-pending` → `notified`，不重复发。
  - delivery-dropped 与 invalidation 同 turn 并存 → **合并成一行**（`reasons=["rollback","delivery-dropped"]`），invalidation flag 与 delivery_dropped clause 都出现、互不吞没（D0 按 turnId merge）。

- `tests/shared/config.test.ts`（扩）
  - 老 config 文件（无新字段）→ `loadConfig` 回填 `maxMiniTurnChars=24000` / `maxFlushAttempts=3`。
  - 显式覆盖值生效。
  - **下限钳制**：配 `maxMiniTurnChars=500` → clamp 到 `8192`；配 `maxFlushAttempts=0` → clamp 到 `1`（Codex round-2 点 1）。

### 系统提示

- `tests/worker/query-session.prompt.test.ts`（若存在则扩，否则新增快照）：系统提示含流式章节、含 `slice` 属性 revisit 豁免措辞、含 `final="true"` 语义、无 `slice` 属性的普通 turn revisit 仍禁止。

---

## Non-goals

- **不做 obs 级独立抽取**。obs 仍折进 mini-turn 当上下文、自动 skip；切片只切"喂给 agent 的上下文窗口"，不改变"obs 不单独成 O 记录"的现状。
- **不持久化 attempts**。内存态，worker 重启 = 干净重试。给 `pending_queue` 加列做迁移的收益不抵成本（重启重试在实践中无害）。
- **不切 prompt / response 本身**。它们 ≤1000 截断，从来不是膨胀源；膨胀来自 obs 数量（切片解决）与未截断的文件树（D2 cap 解决）。
- **不改 recall / timeline / replay 渲染**。存储仍是单条 T 记录，mini-turn 对读路径完全透明。
- **不改 hook 的 wake 频率**。流式完全依赖现有 `post-tool-use.ts:114` 的 per-tool `notifyWorkerWake`,不新增 wake、不加 timer-based flush（turn-stop 必到,残余 obs 由 final 片收尾）。
- **不在 turn 进行中检测 invalidation**。`applyInvalidation` 仍只在 turn-stop / session-init 跑;流式片可能漏标 `invalidated`(检测时还没发生),由 turn-stop 的 final 片 + reminder 通道兜底修订（D6）。
- **不做 map-reduce 持久化 partial（Model C）**。动态更新 + `<prior_turn>` 注入已足够抗 compaction；独立 partial 存储是更激进的硬化，留待将来若实测仍丢失再单独 spec。
- **不统一 `mergeThresholdChars` 与 `maxMiniTurnChars`**。两个 knob 各管一端（合并小 turn / 切大 turn），共存正交；强行合一会大改批处理行为、放大 blast radius。
- **不给丢弃的 obs 做二次召回**。obs 一旦因 `maxFlushAttempts` 丢弃即不可恢复（本就太大送不进窗口）；delivery-dropped reminder 是**告知不完整**，非"稍后重试"。
