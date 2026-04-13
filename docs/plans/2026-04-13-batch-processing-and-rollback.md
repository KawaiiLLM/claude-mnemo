# Batch Processing & Rollback Detection

**Goal**: 优化记忆 agent 的队列处理策略——将逐条处理改为批量处理，减少 agent call 次数和 output tokens；同时建立三层回退检测机制，确保 sidechain turns 的 observations 不会污染记忆。

**影响范围**: `src/worker/server.ts`（队列调度）、`src/worker/processors.ts`（prompt 构建）、hooks（回退检测）。

**动机**: 当前 678 个 agent turns 花费 $22.85，其中 output tokens $2.02（9%）、cache creation $2.51（11%）可通过减少 agent call 次数显著压缩。同时，sidechain turns 的 observations 在 compact 之前无法被清理，导致记忆 agent 可能基于无效数据生成 observations。

---

## Locked Decisions

### 批量处理

**D1**: **所有 obs 一律进入 per-session buffer**，不立即发给 agent。只有以下事件触发处理：
- **(a) Stop hook（turn-stop）** — 将 buffer 中所有 obs + turn info 合并为**一个 batch prompt** 发给 agent。这是主要处理路径，大多数 obs 在此批量消化。缓存建立/过期后的首次请求也在此触发——不需要提前保温。
- **(b) SessionEnd hook** — 将 buffer 中所有剩余 obs 批量处理。CC 在 session 关闭时触发 `SessionEnd` 事件（claude-mem 已使用此 hook）。确保 session 结束前不丢 obs。
- **(c) Compact（`drainSessionCompletely`）** — 强制 flush buffer 中所有剩余 obs。兜底路径，确保 compact 前记忆完整。

不设 keepalive timer，不设"首个 obs 立即处理"特殊路径。缓存可能在长 turn 中过期（> 5min），但 turn-stop 时的 batch 调用会重建缓存，一次性 cache creation 成本可接受。

**D2**: 批量 prompt 格式：

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

**D3**: **Queue/buffer 交接语义**：
- obs 被 `claimNextItem()` 从 queue 取出后，**保持 claimed 状态**，加入内存 buffer
- batch 成功（`pushMessage` 返回 + agent response 收到）后，**批量 `deleteQueueItem(seq)`** 删除所有 buffer 中的 items
- batch 失败（超时、crash、agent error）时，**批量 `releaseQueueClaim(seq)`** 放回 queue
- Worker crash 时 `recoverFromCrash()` 调用 `resetClaimedQueueItems()`，将所有 claimed items 放回未 claimed 状态。后续 `/wake` 会重新 claim 它们进 buffer，等待下一个 flush trigger（turn-stop / SessionEnd / compact）正常批量处理
- 这确保 obs 在 batch 成功前不会从 queue 中消失，crash 恢复承诺成立。

**D4**: `drainSessionCompletely`（compact 路径）跳过批量逻辑，**立即 flush** 所有 buffer 中的 obs + 所有 pending_queue 中的 item，确保 compact 前记忆完整。

**D5**: 批量处理不改变 `processingLock` 的串行语义。一个 batch prompt 等同于一次 `pushMessage` 调用，在 lock 保护下执行。

### 回退检测

**架构约束**: Hook 进程（session-init、stop）和 worker 进程是独立进程。Hook 只能读写 DB，无法直接操作 worker 的 in-memory buffer 或 rollbackPending 队列。因此回退检测分为两步：(1) hook 写 DB signal；(2) worker drain path 消费 signal。

**D7**: **UserPromptSubmit 层**（DB signal）— 新的 UserPromptSubmit 到达时，session-init hook 扫描 JSONL 检测 `isSidechain` turns：
- 使用 `parseReplayTranscript` 的 `isSidechain` 字段做链式检测（chain-walk from newest leaf）
- 将新发现的 sidechain turns 在 DB 中标记为 `status = 'undone'`
- **清理 sidechain turns 的 observations 和 FTS 索引**：`DELETE FROM observations WHERE turn_id IN (...)` + 对应 FTS 清理，确保污染数据不残留。复用 DB 层已有的 undone 清理路径（`tests/db/turns.test.ts:164` 验证的语义）。
- 删除 `pending_queue` 中属于这些 turns 的条目（obs 和 turn-stop）
- 在 sidechain turns 的 tags 中记录 `rollback:pending`
- **不操作 worker 内存**。Buffer 清理和 rollback 通知由 worker drain path 消费（见 D12）。
- **不使用"缺少 Stop/turn-stop"作为回退推断**。原因：Stop hook 可能丢失或延迟，`stop.ts` 已有 orphan active turns 补救机制，这是正常流程而非回退信号。
- 此检测同时覆盖单 obs sidechain turns（被 D1 立即处理的），因为不依赖 buffer 状态，而是直接读 JSONL 判断。

**D8**: **Stop/turn-stop 层**（DB signal）— 处理 turn-stop 时（或 Stop hook 触发时），同样扫描 JSONL 检测 `isSidechain`：
- 逻辑与 D7 相同：标记 undone + 清理 observations/FTS + 清理 queue + 记录 `rollback:pending`
- 作为 D7 的补充：如果 UserPromptSubmit 恰好在 JSONL 写入 sidechain 标记之前触发，turn-stop 时有机会再检测一次

**D9**: **Compact 层**（兜底）— 保留现有 `markSidechainTurnsUndone` + `cleanupUndoneTurnTasks` 逻辑，但**增加 observations/FTS 清理**。当前 `markSidechainTurnsUndone`（`server.ts:216-223`）只做裸 `UPDATE turns SET status='undone'`，不清理 observations。修改为同时执行 `DELETE FROM observations WHERE turn_id IN (...)`。

**D10**: 回退通知使用**两阶段交付**，全部基于 DB 持久化：
- 发现 sidechain 时（D7/D8/D9），在 turn tags 中记录 `rollback:pending`
- 当任意携带 `<rollback>` 的 agent prompt（batch、单 obs、keepalive 均可）成功返回后，升级为 `rollback:notified`
- 只有 `rollback:notified` 的 turns 才跳过通知

**D12**: **Worker drain path 消费 DB signal** — worker 在**每次 `processBatch` / `pushMessage` 之前**（turn-stop batch、SessionEnd flush、或 compact flush），执行以下检查：
- 扫描当前 session 的 buffer，丢弃 `status = 'undone'` 的 turns 对应的 obs items
- 查询 DB：`SELECT * FROM turns WHERE session_id = ? AND status = 'undone' AND tags LIKE '%rollback:pending%'`
- 如果有 pending rollbacks，在当前 prompt 前附加 `<rollback>` 元素（prompt 级 envelope）
- Agent response 成功后，升级为 `rollback:notified`
- **Worker 重启恢复**：此逻辑不依赖内存状态，完全从 DB 读取。Worker crash 后重启，下次 drain 时自动从 DB 扫到 `rollback:pending` 并重新通知。

回退通知格式：

```xml
<rollback>
  T12, T13 were rolled back (sidechain). Observations extracted from
  these turns should be considered invalid.
</rollback>
```

Agent 可据此修正之前基于这些 turn 生成的 observations（调用 `remember` 更新或标记失效）。

### Buffer 持久化

**D11**: Buffer 是纯内存结构（`Map<sessionDbId, BufferState>`），**不持久化**。Worker 重启时 buffer 丢失，但 obs 仍以 claimed 状态保留在 `pending_queue` 中。`recoverFromCrash` → `resetClaimedQueueItems` 将它们恢复为未 claimed。后续 `/wake` 将它们重新 claim 进 buffer，等待下一个 flush trigger（turn-stop / SessionEnd / compact）正常批量处理。不存在单独的逐条降级路径——crash 恢复后仍走批量模型。

---

## 预期收益

假设平均每 turn 产生 5 个 obs：

| 指标 | 当前（逐条） | 批量处理 | 节省 |
|------|-------------|---------|------|
| Agent calls / turn | 5 + 1 turn-stop = 6 | **1**（turn-stop batch） | ~83% |
| Output tokens / turn | 6 × 198 = 1188 | ~400（单次 batch response） | ~66% |
| Cache creation / turn | 6 次增量 | 1 次（可能 cache miss） | ~83% |
| 每 turn 成本 | ~$0.034 × 6 = $0.20 | ~$0.06 | ~70% |

---

## Implementation Tasks

### Task 1: Buffer 数据结构

新增 `BufferState` 接口和 per-session buffer 管理：

```typescript
interface BufferState {
  items: PendingQueueItem[];       // 累积的 obs items
}
```

在 `createWorkerCore` 中新增 `buffers: Map<number, BufferState>`。

### Task 2: 修改 scanAndDrainQueue

将 claim → process 循环改为 claim → buffer → conditional-flush：

1. `claimNextItem` 获取 item
2. 如果是 obs → 加入 buffer
3. 如果是 turn-stop → 触发 `processBatch`（buffer 中所有 obs + turn-stop）
4. `/wake` 调用不再逐条处理 obs，只负责把 queue items 搬入 buffer

### Task 3: SessionEnd flush

**Hook 侧**（fire-and-forget）：
- `plugin/hooks/hooks.json`：新增 `SessionEnd` hook entry，调用 worker 的 `/flush` endpoint，timeout 设为 2 秒
- `src/hooks/types.ts`：`HookEventName` 新增 `"SessionEnd"`
- `src/hooks/adapters/claude-code.ts`：`resolveEventName()` 新增 `"session-end"` → `"SessionEnd"` 映射
- `src/hooks/hook-command.ts`：新增 `SessionEnd` handler，只发 HTTP POST `/flush` 给 worker **然后立即返回**（不等待 flush 完成）。CC 对 SessionEnd 的 timeout 预算只有 ~1500ms，必须是 fire-and-forget。

**Worker 侧**（异步执行）：
- `src/worker/server.ts`：新增 `/flush` endpoint，接收 `{ session_id }` 参数
- Worker 收到后**异步**对该 session 执行 `processBatch`（flush buffer 中所有剩余 obs），不阻塞 HTTP response
- 如果 worker 在 flush 过程中被终止，buffered obs 仍以 claimed 状态保留在 queue 中，由 `recoverFromCrash` 恢复（D3）

**Batch 成功/失败的 queue 清理**（适用于所有触发路径：turn-stop、SessionEnd、compact）：
- 成功：批量 `deleteQueueItem(seq)` 删除 buffer 中所有 items 的 queue rows
- 失败（超时/error）：批量 `releaseQueueClaim(seq)` 放回 queue，清空内存 buffer

### Task 4: 批量 prompt 构建

新增 `buildBatchPrompt(items: PendingQueueItem[], turnStopItem?: PendingQueueItem): string`：
- 将多个 obs prompt 包裹在 `<batch>` 标签中
- 如果有 turn-stop，附加 `<turn>` 元素
- 如果有 pending rollback（D12），附加 `<rollback>` 元素
- 返回合并后的单个 prompt 字符串

### Task 5: 共享 sidechain 检测 + DB 清理函数

新增 `detectAndCleanSidechainTurns(db, sessionDbId, transcriptPath)` 共享函数：
1. 调用 `parseReplayTranscript` 获取所有 turns
2. 筛选 `isSidechain === true` 且 DB 中 status 不是 `'undone'` 的 turns
3. 对新发现的 sidechain turns（turn IDs = undone_turn_ids），按以下顺序执行：
   1. `UPDATE turns SET status = 'undone'` WHERE id IN (undone_turn_ids)
   2. `SELECT id FROM observations WHERE turn_id IN (undone_turn_ids)` → obs_ids
   3. `DELETE FROM pending_queue WHERE session_db_id = ? AND kind = 'turn-stop' AND target_id IN (undone_turn_ids)`
   4. `DELETE FROM pending_queue WHERE session_db_id = ? AND kind = 'obs' AND target_id IN (obs_ids)`
   5. `DELETE FROM observations WHERE turn_id IN (undone_turn_ids)`（含 FTS 清理）
   6. 在 turn tags 中记录 `rollback:pending`
4. 返回新发现的 sidechain turn promptNumbers（用于通知）

在 session-init hook 和 stop hook 中均调用此函数（D7 + D8）。

### Task 6: Worker drain path 消费 rollback signal（D12）

在**每次 `processBatch` / `pushMessage` 之前**（turn-stop batch、SessionEnd flush、或 compact flush）：
1. 扫描 buffer，丢弃 `status = 'undone'` turns 的 obs items
2. 查询 DB：`turns WHERE session_id = ? AND status = 'undone' AND tags LIKE '%rollback:pending%'`
3. 如果有 pending rollbacks，在当前 prompt 前附加 `<rollback>` 元素（prompt 级 envelope，不是 batch 专属结构）
4. Agent response 成功后，将 `rollback:pending` 升级为 `rollback:notified`
5. 此逻辑不依赖内存状态，worker restart 后自动恢复

### Task 7: drainSessionCompletely 适配

Compact 路径下，在 drain 前先 flush 当前 session 的 buffer：
- 将 buffer.items 全部立即处理（逐条或 batch）
- 清空 buffer
- 继续现有 drain 逻辑

### Task 8: Tests

1. 所有 obs 进入 buffer（claimed 状态保留在 queue），不立即处理
2. Turn-stop 触发 batch flush（buffer 中所有 obs + turn info → 一次 pushMessage）
3. SessionEnd 触发 batch flush（buffer 中剩余 obs）
4. Batch 成功 → 批量 deleteQueueItem；失败 → 批量 releaseQueueClaim
5. Compact drain 先 flush buffer（Task 7）
5. `detectAndCleanSidechainTurns` 标记 undone + 清理 observations/FTS + 清理 pending_queue（按 kind 分别处理） + 记录 `rollback:pending`
6. UserPromptSubmit 调用检测函数，worker drain path 消费 DB signal 并附加 `<rollback>`（D7 + D12）
7. 单 obs sidechain turn（obs 在 buffer 中未发送）：检测函数发现，buffer 中 obs 被丢弃
8. 单 obs sidechain turn（turn-stop 已 batch 发送）：检测函数发现，observations 被清理，rollback 通知排队
9. Stop hook 丢失/延迟不触发误杀——orphan turn 不被标记为 undone
10. Turn-stop 时检测 sidechain 并附加 `<rollback>`（D8）
11. D9 compact 层也清理 observations/FTS，不只是裸 UPDATE status
12. Worker 重启后 buffer 为空，resetClaimedQueueItems 恢复 obs，重新 claim 进 buffer 等待下一个 flush trigger（D11）
13. Worker 重启后从 DB 扫到 `rollback:pending`，自动重新通知（D12 恢复路径）
14. `rollback:pending` → agent 成功响应 → `rollback:notified`（D10 两阶段）
15. `rollback:pending` + agent call 失败 → tag 不升级，下次重新通知
