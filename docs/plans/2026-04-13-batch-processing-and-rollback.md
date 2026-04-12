# Batch Processing & Rollback Detection

**Goal**: 优化记忆 agent 的队列处理策略——将逐条处理改为批量处理，减少 agent call 次数和 output tokens；同时建立三层回退检测机制，确保 sidechain turns 的 observations 不会污染记忆。

**影响范围**: `src/worker/server.ts`（队列调度）、`src/worker/processors.ts`（prompt 构建）、hooks（回退检测）。

**动机**: 当前 678 个 agent turns 花费 $22.85，其中 output tokens $2.02（9%）、cache creation $2.51（11%）可通过减少 agent call 次数显著压缩。同时，sidechain turns 的 observations 在 compact 之前无法被清理，导致记忆 agent 可能基于无效数据生成 observations。

---

## Locked Decisions

### 批量处理

**D1**: 每个 turn 的**第一个 obs 立即处理**。理由：建立/刷新 agent kv-cache，确保两个 turn 之间不会出现过长的 agent 空闲（避免 cache 过期）。

**D2**: 第一个 obs 之后的 obs 进入 **per-session buffer**，不立即发给 agent。等待以下任一条件触发批量处理：
- **(a)** buffer 中累积 **≥ 3 个 obs** — 立即批量处理全部
- **(b)** 距上次处理 **≥ 4 分钟** — 处理 **1 个 obs**（cache keepalive，< 5 分钟 TTL）
- **(c)** **turn-stop 到达** — 将 buffer 中所有剩余 obs + turn-stop 合并为**一个 prompt** 发给 agent

**D3**: 批量 prompt 格式：

```xml
<batch>
  <obs id="O71">🔧 Bash in: {"command":"git log ..."} ...</obs>
  <obs id="O72">🔧 Read in: {"file_path":"src/auth.ts"} ...</obs>
  <obs id="O73">🔧 Edit in: {"file_path":"src/auth.ts", ...} ...</obs>
  <turn id="T12" status="extracted" title="Fix auth race condition">
    userPrompt: "fix the auth race"
    filesRead: [src/auth.ts]
    filesModified: [src/auth.ts]
    toolCallCount: 3
  </turn>
</batch>
```

Agent 在一个 response 中处理所有 obs + turn，调用多次 `remember` 工具。

**D4**: 缓存保温（D2b）的 timer 通过 `setInterval` 实现，周期 **60 秒**，检查各 session buffer 的 `lastProcessedAt`。当 `now - lastProcessedAt ≥ 4min` 且 buffer 非空时，处理 buffer 中最旧的 1 个 obs。

**D5**: `drainSessionCompletely`（compact 路径）跳过批量逻辑，**立即 flush** 所有 buffer 中的 obs + 所有 pending_queue 中的 item，确保 compact 前记忆完整。

**D6**: 批量处理不改变 `processingLock` 的串行语义。一个 batch prompt 等同于一次 `pushMessage` 调用，在 lock 保护下执行。

### 回退检测

**D7**: **Buffer 层**（零成本）— 新的 UserPromptSubmit 到达时，如果同 session 的 buffer 中有前一个 turn 的未处理 obs：
- 丢弃这些 obs（从 buffer 移除）
- 删除对应的 `pending_queue` 条目
- 在 DB 中将对应 turn 标记为 `status = 'undone'`
- 理由：正常流程是 Stop → turn-stop → 新 UserPromptSubmit；如果 Stop/turn-stop 没到就来了新 UserPromptSubmit，说明前一个 turn 被回退。

**D8**: **Stop/turn-stop 层**（及时检测）— 处理 turn-stop 时（或 Stop hook 触发时），读取 session JSONL 末尾，检查最近是否有 `isSidechain` 的 turn：
- 使用 `parseReplayTranscript` 的 `isSidechain` 字段检测
- 将新发现的 sidechain turns 在 DB 中标记为 `status = 'undone'`
- 在**下一次 batch prompt** 中附加回退通知：

```xml
<rollback>
  T12, T13 were rolled back (sidechain). Observations extracted from
  these turns should be considered invalid.
</rollback>
```

Agent 可据此修正之前基于这些 turn 生成的 observations（调用 `remember` 更新或标记失效）。

**D9**: **Compact 层**（兜底）— 保留现有 `markSidechainTurnsUndone` + `cleanupUndoneTurnTasks` 逻辑不变。作为 D7/D8 的兜底：crash、hook 未触发等异常情况下，compact 时最终一致。

**D10**: 回退通知只发送**一次**。通过在 turn 的 tags 中记录 `rollback:notified` 标记，避免重复通知 agent。

### Buffer 持久化

**D11**: Buffer 是纯内存结构（`Map<sessionDbId, BufferState>`），**不持久化**。Worker 重启时 buffer 丢失，但 obs 仍在 `pending_queue` 中（已入库），`recoverFromCrash` → `scanAndDrainQueue` 会按旧模式逐条处理。批量优化是 best-effort——降级为逐条处理不影响正确性。

---

## 预期收益

假设平均每 turn 产生 5 个 obs：

| 指标 | 当前（逐条） | 批量处理 | 节省 |
|------|-------------|---------|------|
| Agent calls / turn | 5 + 1 turn-stop = 6 | 1（首个 obs）+ 1（batch + turn-stop）= 2 | ~67% |
| Output tokens / turn | 6 × 198 = 1188 | 198 + ~400 = ~598 | ~50% |
| Cache creation / turn | 6 次增量 | 2 次增量 | ~67% |
| 每 turn 成本 | ~$0.034 × 6 = $0.20 | ~$0.034 + $0.06 = $0.09 | ~55% |

---

## Implementation Tasks

### Task 1: Buffer 数据结构

新增 `BufferState` 接口和 per-session buffer 管理：

```typescript
interface BufferState {
  items: PendingQueueItem[];       // 累积的 obs items
  turnPromptNumber: number | null; // 当前 turn 的 promptNumber
  firstObsProcessed: boolean;      // 本 turn 的第一个 obs 是否已处理
  lastProcessedAt: number;         // 上次处理时间 (ms)
}
```

在 `createWorkerCore` 中新增 `buffers: Map<number, BufferState>`。

### Task 2: 修改 scanAndDrainQueue

将 claim → process 循环改为 claim → buffer → conditional-process：

1. `claimNextItem` 获取 item
2. 如果是 obs 且 `!buffer.firstObsProcessed` → 立即处理，设 `firstObsProcessed = true`
3. 如果是 obs 且 `buffer.firstObsProcessed` → 加入 buffer
4. 如果 buffer.items.length ≥ 3 → 触发 `processBatch`
5. 如果是 turn-stop → 触发 `processBatch`（含 turn-stop）

### Task 3: 缓存保温 timer

在 `main()` 中新增 `setInterval`（60s），遍历 `buffers`：
- 如果 `now - buffer.lastProcessedAt ≥ 240_000`（4 分钟）且 `buffer.items.length > 0`
- 取 buffer 最旧的 1 个 obs，调用 `processClaimedItem` 处理
- 更新 `lastProcessedAt`

### Task 4: 批量 prompt 构建

新增 `buildBatchPrompt(items: PendingQueueItem[], turnStopItem?: PendingQueueItem): string`：
- 将多个 obs prompt 包裹在 `<batch>` 标签中
- 如果有 turn-stop，附加 `<turn>` 元素
- 如果有回退通知（D8），附加 `<rollback>` 元素
- 返回合并后的单个 prompt 字符串

### Task 5: Buffer 层回退检测（D7）

在 `UserPromptSubmit` handler（session-init）中：
1. 查找当前 session 的 buffer
2. 如果 buffer 有 items 且 `turnPromptNumber` 与新 turn 不同 → 回退发生
3. 丢弃 buffer items，删除对应 pending_queue 条目
4. 标记对应 turn 为 `undone`
5. 重置 buffer 状态

### Task 6: Stop/turn-stop 层回退检测（D8）

在 `processTurnStop`（或 Stop hook handler）中：
1. 读取 session 的 transcriptPath
2. 调用 `parseReplayTranscript` 获取 sidechain turns
3. 筛选尚未标记为 `undone` 的 sidechain turns
4. 标记为 `undone`，记录 `rollback:notified` tag
5. 将回退信息注入下次 batch prompt 的 `<rollback>` 元素

### Task 7: drainSessionCompletely 适配

Compact 路径下，在 drain 前先 flush 当前 session 的 buffer：
- 将 buffer.items 全部立即处理（逐条或 batch）
- 清空 buffer
- 继续现有 drain 逻辑

### Task 8: Tests

1. 首个 obs 立即处理，后续 obs 进入 buffer
2. Buffer ≥ 3 触发 batch 处理
3. Turn-stop 触发 flush（含 buffer 中所有 obs）
4. 4 分钟 keepalive 处理 1 个 obs
5. 新 UserPromptSubmit 丢弃旧 turn 的 buffer obs（D7）
6. Turn-stop 时检测 sidechain 并附加 `<rollback>`（D8）
7. Compact drain 先 flush buffer（Task 7）
8. Worker 重启后 buffer 为空，pending_queue 逐条处理（D11 降级）
9. `<rollback>` 只通知一次（D10）
