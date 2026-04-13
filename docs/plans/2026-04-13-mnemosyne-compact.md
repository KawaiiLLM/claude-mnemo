# Mnemosyne Agent Compact & Context Optimization

**Goal**: 主 agent compact 时同步 compact Mnemosyne agent 的上下文，避免 (1) context 无限增长 (2) close+resume 导致缓存失效 (3) 重复注入 session context 浪费 token。

**动机**:
1. 当前 `handleCompact` 在 drain 后 `closeSessionQuery` 杀掉 CC subprocess。下次 obs 进来 resume → 全量 JSONL transcript 重新发 API → 缓存已过期 → 付完整 cache creation。
2. Mnemosyne agent 的对话历史通过 resume 持续增长，无 compact 机制。
3. `buildBatchPrompt` 每次都注入 `<prior_session>`（~200-350 tokens），累积加速 context 压力。

**前置**: 依赖 `2026-04-13-cache-keepalive-timer.md`（Cold/Warm 状态机）和已实现的 deferred-batch 模型。

---

## Locked Decisions

**D1**: **通过 prompt stream 发送 `/compact` 触发 CC subprocess 内部 compact**。Agent SDK 没有 compact 控制接口，但 CC subprocess 会从用户消息文本中解析 slash command。`/compact` 作为 `SDKUserMessage` 推入 prompt stream，CC 当作 slash command 执行。

完成信号：监听消息循环中的 `SDKCompactBoundaryMessage`（`type: 'system', subtype: 'compact_boundary'`）。

`compact()` 不走 `sendPrompt`（compact 不产生 `result` 消息，`sendPrompt` 会永久等待）。需要在 `WorkerQuerySession` 新增专用方法。

**D2**: **`handleCompact` 不再 close session，改为 compact + reset**。新流程：

```
drainSessionCompletely
→ pushSessionSummaryPrompt  （Mnemosyne 更新 session record）
→ querySession.compact()    （CC subprocess 内部 compact）
→ reset state to Cold       （initialized=false, lastPushAt=0）
// 不 closeSessionQuery — subprocess 保活，缓存不断
```

idle timeout（`IDLE_QUERY_SESSION_MS = 30min`）兜底清理。

**D3**: **Compact 后恢复 Cold 状态**。`lastPushAt = 0` 触发 Cold 逻辑：
- 不做保温
- 累积 >3 个已完成 turn 后才发出首次 batch → `lastPushAt` 更新 → 进入 Warm
- 与正常 Cold 流程完全一致，无特殊路径

**D4**: **Session context 按需注入，决策在 `processBatch`，渲染在 `buildBatchPrompt`**。

注入决策由 `processBatch` 负责，基于 `state` 上的跟踪字段计算 `needsSessionContext` 和 `sessionUpdated`，然后将结果作为参数传给 `buildBatchPrompt`。`buildBatchPrompt` 只负责按参数渲染，不做判断。

这一规则同时适用于 `processBatch` 内的所有路径：completed-turn batch 和 partial-turn keepalive batch。两者共享同一个 `processBatch` 入口，注入决策只做一次。

注入条件：
1. **首次**（`!state.initialized`）：`needsSessionContext = true`
2. **Session summary 被更新**（`session.summaryUpdatedAtEpoch > state.lastInjectedSummaryEpoch`）：`needsSessionContext = true`, `sessionUpdated = true`
3. **其他**：`needsSessionContext = false`，`buildBatchPrompt` 只带 `<session id="S...">` header，不带 `<prior_session>`

**变更信号必须用专用字段 `summaryUpdatedAtEpoch`，不能用 `updatedAtEpoch`**。`updatedAtEpoch` 被 SessionInit、Stop 等生命周期操作频繁更新，不代表 summary 内容变化。`summaryUpdatedAtEpoch` 只在 `remember({ id: "S...", title/content/insight/next_steps })` 真正修改 summary 字段时才更新。

新增：
- sessions 表新增 `summary_updated_at_epoch INTEGER` 列
- `remember.ts` 中 session summary 更新路径同时写入 `summaryUpdatedAtEpoch`
- `SessionState` 新增 `lastInjectedSummaryEpoch: number`（初始 0）

跟踪时序：`processBatch` 在 `pushMessage` **成功后重新读取 session**，用 post-push 的 `summaryUpdatedAtEpoch` 更新 `state.lastInjectedSummaryEpoch`。不能用 pre-push 快照的 epoch——`pushMessage` 期间 Mnemosyne 可能通过 `remember()` 刷新了 summary，此时 DB 中的 `summaryUpdatedAtEpoch` 已变大。如果存 pre-push 值，下一批会误判为"summary 变了"并重复注入。

`processBatch` 内的决策流程：
```ts
const needsSessionContext = !state.initialized ||
  (session.summaryUpdatedAtEpoch ?? 0) > state.lastInjectedSummaryEpoch;
const sessionUpdated = state.initialized && needsSessionContext;

await state.pushMessage(
  buildBatchPrompt({
    // ...
    priorTitle: needsSessionContext ? session.title : null,
    priorContent: needsSessionContext ? session.content : null,
    priorInsight: needsSessionContext ? session.insight : null,
    priorNextSteps: needsSessionContext ? session.nextSteps : null,
    sessionUpdated,
  }),
);

// 重新读取 session，捕获 pushMessage 期间 Mnemosyne 可能触发的 summary 更新
const freshSession = getSession(db, sessionId);
state.lastInjectedSummaryEpoch = freshSession?.summaryUpdatedAtEpoch ?? 0;
state.initialized = true;
```

`buildBatchPrompt` 新增 `sessionUpdated?: boolean` 参数。当 `sessionUpdated` 为 true 时，在 `<prior_session>` 前输出：
```xml
<session-updated>
Session summary was refreshed since your last message.
</session-updated>
```

**D5**: **Compact 后 `state.initialized = false` + `lastInjectedSummaryEpoch = 0`**。下次 batch（无论是 completed-turn flush 还是 partial-turn keepalive）自动走首次路径，注入完整 session context。这与正常初始化路径复用同一逻辑，不引入 post-compact 特殊消息。

**D6**: **`compact()` 方法设计**。

```ts
interface WorkerQuerySession {
  // 已有
  sendPrompt(promptText: string): Promise<SDKResultMessage>;
  close(): Promise<void>;
  // 新增
  compact(): Promise<void>;
}
```

实现要点：
- 推送 `createUserMessage("/compact", sessionId)` 到 prompt stream
- 不创建 `pendingResults` deferred（compact 不产生 `result` 消息）
- 创建 `pendingCompact` deferred，监听消息循环中 `subtype === "compact_boundary"` 时 resolve
- 超时：复用 `COMPACT_TIMEOUT_MS`（当前 worker 的 compact 请求超时，建议提高或使用独立常量，因为 CC compact 可能比 HTTP 请求慢）
- 超时后 reject，`handleCompact` catch 并 log（不阻塞后续流程）

消息循环新增分支：
```ts
if (message.type === "system" && "subtype" in message && message.subtype === "compact_boundary") {
  pendingCompact?.resolve();
  pendingCompact = null;
}
```

**D7**: **`handleCompact` 中 query session 不存在时跳过 compact**。如果 `state.querySession === null`（没有处理过任何 item），没有 CC subprocess 可 compact，直接跳过。

**D8**: **`abortStalledSessions` 在 compact 期间跳过该 session**。`compact()` 的建议超时是 120s，远超 `STALLED_QUERY_MS`（30s）。如果不豁免，compact 发出 `/compact` 后 30s 内未收到响应就会被 watchdog 当作 stalled 关掉 subprocess。

`handleCompact` 已经在入口处 `compactingSessions.add(sessionDbId)`，所以 `abortStalledSessions` 只需在遍历时检查 `compactingSessions.has(state.sessionDbId)` 并跳过。这与 `scanAndDrainQueue` 用 `excludeSessions: compactingSessions` 跳过 compacting session 的模式一致。

**D9**: **compact 失败：保守重同步，不宣称等价于成功 compact**。如果 `querySession.compact()` 超时或失败：
- log 错误
- 重置本地 scheduling/injection state（`initialized = false`, `lastPushAt = 0`, `lastInjectedSummaryEpoch = 0`）
- 不 close session（subprocess 可能仍然可用）
- 下次 batch 注入完整 session context

注意：这只是本地 state 的保守重同步。compact 失败意味着 subprocess 内部 context **没有被缩短**，与成功 compact 后的状态不等价。但从功能正确性角度：
- 重置 `lastPushAt = 0` 使 keepalive timer 不再为一个可能未缩短的 context 做保温（Cold 不保温）
- 重置 `initialized = false` 确保下次 batch 重新注入完整 session context，与 subprocess 内部状态重新对齐
- subprocess 继续存活，后续 API 调用可能触发 CC 内置 auto-compact 兜底

---

## 不做的事

- **不修改 CC Agent SDK**：不添加 compact 控制接口，复用 slash command 路径。
- **不改 Mnemosyne 系统提示词**：CC compact 保留 system prompt，不需要重新注入。
- **不实现 Mnemosyne 的 keepalive timer**：Mnemosyne 的缓存保温复用主 agent 的 turn 驱动节奏，不独立保温。

---

## Implementation

### Task 1: `WorkerQuerySession.compact()` 方法

**Files**: `src/worker/query-session.ts`

1. 新增 `pendingCompact: Deferred<void> | null` 状态
2. 消息循环新增 `compact_boundary` 分支
3. 新增 `compact()` 方法：push `/compact` 到 prompt stream，await pendingCompact
4. 超时处理（建议 120s，CC compact 含 summarization）

### Task 2: `handleCompact` 改为 compact + reset，watchdog 豁免

**Files**: `src/worker/server.ts`

`abortStalledSessions` 新增跳过条件：
```ts
if (compactingSessions.has(state.sessionDbId)) {
  return;
}
```

将：
```ts
} finally {
  compactingSessions.delete(sessionDbId);
  await closeSessionQuery(sessionDbId);
}
```

改为：
```ts
  try {
    const state = sessions.get(sessionDbId);
    if (state?.querySession) {
      await state.querySession.compact();
    }
  } catch (error) {
    logger.error?.("mnemosyne compact failed", { sessionDbId, error });
  }
} finally {
  compactingSessions.delete(sessionDbId);
  const state = sessions.get(sessionDbId);
  if (state) {
    state.initialized = false;
    state.lastPushAt = 0;
    state.lastInjectedSummaryEpoch = 0;
  }
}
```

### Task 3: `summaryUpdatedAtEpoch` 字段 + session context 按需注入

**Files**: `src/db/schema.ts`, `src/db/sessions.ts`, `src/mcp/remember.ts`, `src/worker/server.ts`, `src/worker/processors.ts`

DB + 写路径：
1. `src/db/schema.ts`: 新增 `ensureSessionSummaryUpdatedAtEpochColumn()` helper（参照 `ensureSessionLastAgentSessionIdColumn()` 风格），在 `initializeDatabase()` 中调用
2. `src/db/sessions.ts`: `SessionRow` / query 映射新增 `summaryUpdatedAtEpoch`
3. `src/mcp/remember.ts`: `handleSessionRemember()` 在写入前**比较四个 summary 字段（title/content/insight/nextSteps）与现有 session 是否有任一差异**：
   - 有差异：更新变化的字段 + `summaryUpdatedAtEpoch = now()`
   - 完全相同：保留原 `summaryUpdatedAtEpoch`，不推进 epoch
   - 其他写路径（SessionInit、Stop 的 `upsertSession`）不触碰此字段

决策在 `processBatch`，渲染在 `buildBatchPrompt`：
4. `SessionState` 新增 `lastInjectedSummaryEpoch: number`（初始 0）
5. `processBatch` 在构建 prompt 前计算 `needsSessionContext` 和 `sessionUpdated`（见 D4 伪代码），对 completed-turn 和 partial-turn keepalive 路径统一生效
6. 根据决策传 `priorTitle/...` 或 `null` 给 `buildBatchPrompt`
7. `pushMessage` 成功后**重新读取 session**，用 post-push `summaryUpdatedAtEpoch` 更新 `state.lastInjectedSummaryEpoch`，同时设 `state.initialized = true`
8. `buildBatchPrompt` 新增 `sessionUpdated?: boolean` 参数，仅控制是否输出 `<session-updated>` 标签，不做任何判断逻辑

### Task 4: Tests

**DB migration** (`tests/db/schema.test.ts`):
1. `ensureSessionSummaryUpdatedAtEpochColumn()` 对已有 DB 正确添加列
2. 新建 DB 时列已存在

**remember 写路径** (`tests/mcp/remember.test.ts`):
3. `remember({ id: "S...", title/content/insight/next_steps })` 提交与现有完全相同的值 → `summaryUpdatedAtEpoch` 不推进
4. 提交有差异的值 → `summaryUpdatedAtEpoch` 推进为当前时间
5. 仅部分字段有差异（如只改 insight）→ `summaryUpdatedAtEpoch` 推进

**compact** (`tests/worker/query-session.test.ts`, `tests/worker/server.test.ts`):
6. `compact()` 方法：push `/compact`、监听 `compact_boundary`、超时处理
7. `handleCompact` 不再 close session，compact 后 state 重置为 Cold
8. `handleCompact` 在 querySession 不存在时跳过 compact
9. compact 失败后仍 reset state（保守重同步）
10. `abortStalledSessions` 在 `compactingSessions` 中的 session 不被 stalled watchdog 关闭

**session context 注入** (`tests/worker/server.test.ts`):
10. `processBatch` 首次注入完整 session context
11. `processBatch` 后续不注入 `<prior_session>`
12. `summaryUpdatedAtEpoch` 推进 → 下次 batch 注入 `<prior_session>` + `<session-updated>`
13. SessionInit / Stop 的 `upsertSession` 不触发 `<prior_session>` 重注入（只更新 `updatedAtEpoch`，不更新 `summaryUpdatedAtEpoch`）
14. `pushMessage` 期间 Mnemosyne 刷新 summary → post-push re-read 捕获新 epoch → 下次 batch 不重复注入
15. compact 后 `initialized = false` → 下次 batch 重新注入

---

## Verification

```bash
bun test tests/worker/query-session.test.ts
bun test tests/worker/server.test.ts
bun test tests/worker/processors.test.ts
npm run typecheck
npm run build
```

手动验证：
1. 启动长 session，积累 10+ turns
2. 触发主 agent compact
3. 断言 Mnemosyne subprocess 未被杀
4. 断言 Mnemosyne 上下文已 compact（token 减少）
5. 新 obs 进来后，batch prompt 包含完整 `<prior_session>`
6. 后续 batch 不含 `<prior_session>`
7. Mnemosyne 更新 session 后，下次 batch 含 `<session-updated>` + `<prior_session>`
