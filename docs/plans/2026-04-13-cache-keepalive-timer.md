# Deferred Batch with Cache State Machine

**Goal**: 替代当前 turn-stop 立即 flush 的模型，改为基于缓存状态的延迟批量处理——减少 agent call 次数，合并短 turn，并在缓存活跃期间自动保温。

**前置**: 此 spec 是 `2026-04-13-batch-processing-and-rollback.md` 的增量修正。原 spec 的 D1 在讨论中遗漏了用户要求的 keepalive timer 设计（T205-T206），并且 turn-stop 作为立即 flush 触发器导致短 turn 无法合并。

**动机**:
1. **短 turn 开销过高**: 连续 3 个短 turn（各 1-2 obs）= 3 次 agent call，每次都有固定 output token + 可能的 cache creation 成本。合并为 1 次 batch 可省 2/3。
2. **缓存浪费**: 当前 turn-stop 立即 flush，但下一个 turn 可能 5 分钟后才来，cache 白建了。
3. **缓存保温缺失**: 长 turn（>5min）期间无请求，cache 过期，turn-stop batch 付完整 cache creation。

**影响范围**: `src/worker/server.ts`（buffer 管理 + scanAndDrainQueue + timer）、`src/worker/processors.ts`（multi-turn batch prompt 格式）。

---

## Cache State Machine

```
                   第4个turn完成
                   (首次batch,付cache creation)
    ┌──────┐  ────────────────────────────>  ┌──────┐
    │ Cold │                                  │ Warm │
    └──────┘  <───────────────────────────── └──────┘
                   保温材料耗尽
                   (reserve=0, obs=0, 过期)
```

**Cold（无缓存）**: `lastPushAt === 0` 或 cache 已过期（`now - lastPushAt >= CACHE_TTL_MS`）
- 不做保温操作
- 已完成 turn <= 3 → 纯 buffer，等待

**Warm（缓存活跃）**: `lastPushAt > 0` 且 `now - lastPushAt < CACHE_TTL_MS`
- 已完成 turn <= 3 → 4min mark 保温（见 D3）
- 保温材料耗尽且无新 item → cache 过期 → Cold

**共享规则（Cold/Warm 均适用）**:
- 已完成 turn > 3 → 立即 batch 多余的 turns，保留 3 个 reserve

---

## Locked Decisions

**D1**: **Turn-stop 不再是立即 flush 触发器**。Turn-stop 和 obs 一样进入 buffer。Buffer 中以 turn 为单位组织：每个已完成 turn = 该 turn 的 obs items + turn-stop item。进行中的 turn = 只有 obs items，无 turn-stop。

**D2**: **Buffer 溢出即时 flush** — 当 buffer 中已完成 turn 数 > `RESERVE_TURNS`（3）时，立即 batch 多余的 turns（按 turn 分组，每个 turn 含其 obs），保留 3 个最新的作为 reserve。此规则在 Cold 和 Warm 状态下行为一致：
- Cold 下的首次 flush = 首次 agent 请求 → 付 cache creation → 进入 Warm
- Warm 下的 flush = cache read，低成本

**D3**: **Warm 状态保温（4min mark）** — Warm 状态下，`now - lastPushAt` 进入 `[KEEPALIVE_MS, CACHE_TTL_MS)` 窗口（4~5 分钟）时，按以下降级链保温：
1. Buffer 中有 reserve turn → 取 1 个已完成 turn（含其 obs）发送
2. Reserve 耗尽 → 取进行中 turn 的 obs 的**一半**（`ceil(count / 2)`，至少 1 个），附加 `<partial-turn>` 上下文，batch 发送
3. 都没有 → 不发送 → cache 过期 → 回到 Cold

保温成功后 `lastPushAt` 刷新，窗口重置。

**降级到 obs 时取一半的理由**：reserve turn 耗尽意味着当前 turn 已执行超过 12 分钟（3 × 4min），大概率是长程任务，可能已积累几十个 obs。逐个发送保温效率太低；全部发送又失去了 reserve 的缓冲作用。取一半在保温的同时逐步消化积压，避免 turn-stop 时大量 obs 一次涌入。

**D4**: **Timer 实现** — 复用现有 `WATCHDOG_INTERVAL_MS`（10s）定时器。每次 tick 遍历有 buffer 的 session，检查 D3 条件。不新增 per-session timer。

**D5**: **Multi-turn batch prompt 格式**:

已完成 turn：
```xml
<batch>
  <turn id="T12" title="Fix auth race">
    <obs id="O71">...</obs>
    <obs id="O72">...</obs>
    userPrompt: "fix the auth race"
    filesModified: [src/auth.ts]
  </turn>
  <turn id="T13" title="Add test">
    <obs id="O73">...</obs>
    userPrompt: "add a test"
  </turn>
</batch>
```

进行中 turn 的 partial flush（D3 降级链第 2 级）：
```xml
<batch>
  <partial-turn id="T14" status="in-progress">
    <obs id="O74">...</obs>
    <obs id="O75">...</obs>
    <obs id="O76">...</obs>
    userPrompt: "refactor the entire auth module"
    filesRead: [src/auth.ts, src/middleware.ts]
    filesModified: [src/auth.ts]
    note: "turn still in progress, 3 of ~6 obs included"
  </partial-turn>
</batch>
```

`<partial-turn>` 包含当前已知的 turn 级信息（promptNumber、userPrompt、已读/已改文件列表），告诉 agent 此 turn 尚未完成。Turn-stop 到来时只处理剩余 obs + 完整 turn info。

**partial-turn 上下文来源**：`userPrompt` 从 DB turns 表读取（session-init 时已写入）。`filesRead`/`filesModified` **不能从 turns 表读**——这些字段只在 `processTurnStop()`/`processBatch()` 时才聚合回写，in-progress turn 的 DB 行通常为空。因此从 observations 表按 `targetId`（obs item 的 observation id）查询 `toolName`/`toolInput`，复用 `aggregateTurnFiles()`（`processors.ts:179`）的完整映射规则现算：
- Read/Grep/Glob → filesRead（含 `file_path` 和 `path` 两个字段）
- Write/Edit/MultiEdit → filesModified（含 `file_path` 字段）

必须与 canonical `aggregateTurnFiles()` 保持一致，否则 partial-turn 和 completed-turn 会出现两套文件语义（如少报 Grep/Glob 读过的路径或 MultiEdit 改过的路径）。

**D6**: **保温失败语义** — 无论是 reserve turn 还是半数 obs batch，失败时统一：`releaseQueueClaim` 所有相关 items，从 buffer 移除（不放回）。Items 回到 queue 未 claimed 状态，下次 `scanAndDrainQueue` 重新 claim。不可 release 后又放回 buffer（重复状态风险）。

**D7**: **Undone turns 处理**:
- Buffer 中的 undone items → flush 前丢弃。**不能沿用现有 `pruneBufferedUndoneItems`**——该函数假设 buffer 中只有 obs items（`getObservation(db, item.targetId)`），新模型中 buffer 含 turn-stop items（`targetId` = turn id），会被误判为"无效 obs"并错误删除 queue row。需要新建 mixed-item prune：
  - `item.kind === "obs"` → 按 observation → turn 判定 status
  - `item.kind === "turn-stop"` → 直接按 `getTurnById(db, item.targetId).status` 判定
  - status === "undone" → 从 buffer 移除 + `deleteQueueItem`
- 已消费的 undone turns → 下次 batch 附加 `<rollback>`（现有 D12 机制不变）

**D8**: **SessionEnd / Compact** — 任何状态下立即 flush 全部（含 reserve + 进行中 obs）。不保留 reserve。

**D10**: **Buffer 并发安全** — 新模型中 buffer 操作从"整批 clear"变成"选择子集并移除"，与 `scanAndDrainQueue` 的并发 push 存在竞态风险。

`scanAndDrainQueue` 的 obs → `buffer.items.push(item)` 不拿 lock（`server.ts:507`）。`tryKeepaliveSession` / `flushExcessTurns` 在 lock 内会 `await processBatchImpl(...)`，这段 await 期间 event loop 可以调度其他工作，`scanAndDrainQueue` 完全可能继续往同一个 buffer 里 push 新 obs。

正确性依赖 **snapshot + seq-based removal**，不依赖"不会并发"：

1. **选集时拍快照**：keepalive / flush 进入 lock 后，先从 buffer 中选出要发送的 items，记录 `sentSeqs: Set<number>`。
2. **成功/失败后按 seq 精确移除**：`buffer.items = buffer.items.filter(i => !sentSeqs.has(i.seq))`。并发期间新 push 的 items 的 seq 不在快照中，不会被误删。
3. **不再使用 `clearBuffer(sessionDbId)`**。旧模型的整批 clear 在新模型下会误删并发追加的 items。

**D9**: **常量**:
- `RESERVE_TURNS = 3` — buffer 中保留的已完成 turn 数
- `KEEPALIVE_MS = 240_000` — 4 分钟，保温窗口起点
- `CACHE_TTL_MS = 300_000` — 5 分钟，Anthropic prompt cache TTL

---

## Implementation Tasks

### Task 1: 修改 scanAndDrainQueue

Turn-stop 不再触发 `flushBufferedItems`。改为：

1. `claimNextItem` 获取 item
2. obs → 加入 buffer（不变）
3. turn-stop → 加入 buffer（**变化**：之前是触发 flush）
4. 每次 turn-stop 入 buffer 后，检查已完成 turn 数：
   - 已完成 turn > `RESERVE_TURNS` → 调用 `flushExcessTurns(sessionDbId)`

### Task 2: 新增 flushExcessTurns

```typescript
async function flushExcessTurns(sessionDbId: number): Promise<void>
```

1. 统计 buffer 中已完成 turn 数（有 turn-stop 的）
2. 如果 <= `RESERVE_TURNS`，返回
3. 按 turn 时序排列，取前 `completedCount - RESERVE_TURNS` 个 turn（保留最新 3 个）
4. 收集这些 turns 的 obs items + turn-stop items
5. 调用 `processBatchImpl`（multi-turn batch）
6. 成功 → `deleteQueueItem` 所有已发送 items，按 seq 从 buffer 精确移除（D10）
7. 失败 → `releaseQueueClaim` 所有 items，按 seq 从 buffer 精确移除（D10）

整个流程在 `withSessionProcessingLock` 内执行。

### Task 3: 保温 timer 集成

在 watchdog tick 中新增 `tryKeepaliveSession(sessionDbId)`：

1. 检查 Warm 状态：`lastPushAt > 0` 且 `now - lastPushAt < CACHE_TTL_MS`
2. 检查保温窗口：`now - lastPushAt >= KEEPALIVE_MS`
3. 检查无 inflight：`lastPushAt <= lastMessageAt`
4. 检查非 compacting
5. 降级链：
   - Buffer 有已完成 reserve turn → 取最旧的 1 个 turn（含 obs），batch 发送
   - 无 reserve turn → buffer 有进行中 obs → 取一半（`ceil(count / 2)`，至少 1），附加 `<partial-turn>` 上下文，batch 发送
   - 都没有 → 不操作（cache 将过期，回到 Cold）
6. 成功 → `deleteQueueItem` 所有已发送 items，按 seq 从 buffer 精确移除（D10）
7. 失败 → `releaseQueueClaim` 所有 items，按 seq 从 buffer 精确移除（D10）

整个流程在 `withSessionProcessingLock` 内执行。

### Task 4: 修改 flushBufferedItems

SessionEnd / Compact 路径调用的 `flushBufferedItems` 保持"flush 全部"语义，但需要适配 multi-turn 格式：将 buffer 中所有 items 按 turn 分组后发送。

### Task 5: Multi-turn batch prompt 构建

修改 `buildBatchPrompt` 支持多个 turn 和 partial-turn：

```typescript
interface TurnGroup {
  turnStopItem: PendingQueueItem;
  obsItems: PendingQueueItem[];
}

interface PartialTurnGroup {
  obsItems: PendingQueueItem[];
  turnContext: {
    promptNumber: number;
    userPrompt?: string;        // 从 DB turns 表（session-init 时已写入）
    filesRead?: string[];       // 从 observations 表查 toolName/toolInput，复用 aggregateTurnFiles() 规则
    filesModified?: string[];   // 同上：Read/Grep/Glob → filesRead，Write/Edit/MultiEdit → filesModified
  };
}

function buildBatchPrompt(
  turnGroups: TurnGroup[],
  partialTurn?: PartialTurnGroup,
): string
```

`partialTurn` 用于 D3 降级链第 2 级（reserve 耗尽时的半数 obs flush）。

### Task 6: Tests

1. Turn-stop 进 buffer 不立即 flush
2. 已完成 turn <= 3 → 不 flush（Cold 下纯 buffer）
3. 第 4 个 turn 完成 → 立即 batch 第 1 个 turn，保留 3 个 reserve
4. 第 5、6 个 turn 快速完成 → batch 多余的，始终保留 3
5. Cold 首次 batch → lastPushAt 更新 → 进入 Warm
6. Warm + 4min mark + 有 reserve → 发 1 个 turn 保温
7. Warm + 4min mark + reserve 耗尽 + 有 6 个 in-progress obs → 发 3 个 obs（ceil(6/2)）+ partial-turn 上下文
8. Warm + 4min mark + reserve 耗尽 + 有 1 个 in-progress obs → 发 1 个 obs + partial-turn 上下文
9. Warm + 4min mark + 无 reserve + 无 obs → 不操作 → 过期后回到 Cold
10. 连续 partial flush — 第一次发一半，下次 4min 再发剩余的一半，逐步消化
11. Cold 状态不做保温（即使 buffer 非空且"超时"）
12. SessionEnd / Compact → flush 全部（含 reserve + 进行中 obs）
13. Buffer 中 undone turns → flush 前丢弃
14. 保温失败 → releaseQueueClaim，不放回 buffer
15. 保温与 flush 互斥（共享 processingLock）
16. Multi-turn batch prompt 格式正确，turn 边界清晰
17. Partial-turn prompt 包含已知 turn 上下文（userPrompt、filesRead 从 observations 表现算）
18. Turn-stop 到来时只处理剩余 obs + 完整 turn info，不重复处理已 partial flush 的 obs
19. Buffer 选集 + 移除按 seq 精确匹配，不影响期间新追加的 items（D10）
20. Keepalive 期间 scanAndDrainQueue 并发 push 新 obs → 新 obs 不被误删（D10 snapshot + seq-based removal）
