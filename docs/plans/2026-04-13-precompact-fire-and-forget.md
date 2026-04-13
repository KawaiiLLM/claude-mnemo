# PreCompact: Fire-and-Forget

**Goal**: 消除 PreCompact hook 超时——将 `/compact` 请求从阻塞式改为 fire-and-forget，hook 只负责发信号，worker 异步完成 drain + summary。

**动机**: `handleCompact()` 包含 `drainSessionCompletely()`（循环 flush + agent call）和 `pushSessionSummaryPrompt`（agent call），总耗时可达数十秒。当前 PreCompact hook 的 30s timeout 不足以覆盖，导致超时。但 PreCompact **不需要阻塞等待**——JSONL 和 pending_queue 都是持久化的，compact 不会破坏任何 worker 需要的数据。

**影响范围**: `src/worker/server.ts`（`/compact` endpoint）、`src/worker/client.ts`（`notifyWorkerCompact`）。

---

## Locked Decisions

**D1**: **`/compact` endpoint 立即响应，异步处理**。Worker 收到 `/compact` 请求后：
- 立即返回 200（确认信号收到）
- 在后台异步执行 `handleCompact()`（sidechain cleanup → drain → anchor → summary）
- 与 `/flush` endpoint（SessionEnd）的 fire-and-forget 模式一致

```typescript
// Before:
await handleCompactImpl(payload.session_id, payload.transcript_path);
return new Response(null, { status: 200 });

// After:
handleCompactImpl(payload.session_id, payload.transcript_path).catch((err) => {
  logger.error?.("handleCompact failed", { error: err });
});
return new Response(null, { status: 200 });
```

**D2**: **`notifyWorkerCompact` 给 `/compact` fetch 加 timeout 安全网**。D1 让 worker 响应变快，但 fetch 之前还有两段开销：health check（`HOOK_HEALTH_TIMEOUT_MS = 3s`）和 `waitForCompatibleWorker()`（`HOOK_READINESS_TIMEOUT_MS = 30s`，worker down/stale 时触发）。这些不受 fetch timeout 约束。

给 fetch 加 5s timeout，只保护"worker 收到信号"这一步：

```typescript
const response = await fetchImpl(`${WORKER_BASE_URL}/compact`, {
  method: "POST",
  signal: AbortSignal.timeout(5000),
  body: JSON.stringify({ session_id, transcript_path }),
});
```

最坏路径：3s health check + 30s readiness wait + 5s fetch = 38s。PreCompact 的 30s hook timeout 不足以覆盖 worker 冷启动场景。但这与 fire-and-forget 无关——当前阻塞模型下 worker 冷启动同样会超时。冷启动是独立问题，本 spec 不解决。

**D3**: **不改变 `handleCompact` 内部逻辑**。`drainSessionCompletely` + `pushSessionSummaryPrompt` 保持原样——它们仍然有价值（确保 summary 完整），只是不再阻塞 hook。

**D4**: **不改变 `compactingSessions` 语义**。`compactingSessions.add()` 在 `handleCompact` 入口处调用，`delete()` 在 finally 中。由于 `handleCompact` 仍然完整执行（只是异步），`scanAndDrainQueue` 的 skip 逻辑不受影响。

**D5**: **`updateCompactAnchor` 移到 `handleCompact` 入口，在 drain 之前执行**。

竞态分析：PostCompact 插入 `type='compact', status='extracted'` 的 turn。`updateCompactAnchor()` 用 `MAX(prompt_number) WHERE status != 'active'` 计算锚点。在阻塞模型下，PostCompact 总在 `handleCompact` 之后跑，anchor 锚到 compact 前最后一个 finalized turn。

Fire-and-forget 后，PostCompact 可能在 `updateCompactAnchor()` 之前插入 compact turn，导致 `MAX(prompt_number)` 把 compact turn 也算进去——anchor 语义从"compact 前最后一个 turn"变成"compact turn 本身"。

修复：将 `updateCompactAnchor()` 从 drain 之后移到 `handleCompact` 入口处（sidechain cleanup 之后、drain 之前）。此时 PostCompact 的 compact turn 尚未插入，anchor 语义不变。Drain 产生的新 observations 不影响 anchor（anchor 基于 turns，不是 observations）。

```typescript
async function handleCompact(sessionDbId, transcriptPath) {
  compactingSessions.add(sessionDbId);
  try {
    if (transcriptPath) {
      detectAndCleanSidechainTurns(...);
    }
    updateCompactAnchor(deps.db, sessionDbId);  // ← 移到 drain 之前
    await drainSessionCompletely(sessionDbId);
    await pushSessionSummaryPromptImpl(state, sessionDbId);
  } finally {
    compactingSessions.delete(sessionDbId);
  }
}
```

---

## 不需要改的

- **PreCompact timeout (30s)** — 保留。正常路径（worker 已运行）下 D1 + D2 让 hook 在数秒内完成。冷启动超时是独立问题。
- **PostCompact handler** — 纯 DB 操作，无变化。
- **`/flush` endpoint** — 已经是 fire-and-forget。

---

## Implementation

### Task 1: `/compact` endpoint 异步化

`src/worker/server.ts`，`/compact` handler：

```typescript
// 当前（阻塞）:
await handleCompactImpl(payload.session_id, payload.transcript_path);
return new Response(null, { status: 200 });

// 修改为（fire-and-forget）:
handleCompactImpl(payload.session_id, payload.transcript_path).catch(
  (err) => {
    logger.error?.("background handleCompact failed", {
      session_id: payload.session_id,
      error: err,
    });
  },
);
return new Response(null, { status: 200 });
```

### Task 2: `notifyWorkerCompact` 加 timeout

`src/worker/client.ts`，`notifyWorkerCompact()`：

```typescript
const response = await fetchImpl(`${WORKER_BASE_URL}/compact`, {
  method: "POST",
  signal: AbortSignal.timeout(5000),
  body: JSON.stringify({
    session_id: sessionDbId,
    transcript_path: transcriptPath ?? null,
  }),
});
```

### Task 3: `updateCompactAnchor` 移位

`src/worker/server.ts`，`handleCompact()`：将 `updateCompactAnchor()` 从 `drainSessionCompletely()` 之后移到之前（`detectAndCleanSidechainTurns` 之后）。

### Task 4: Tests

1. `/compact` endpoint 立即返回 200，`handleCompact` 在后台执行
2. `handleCompact` 后台失败不影响 response（已返回 200）
3. `notifyWorkerCompact` 在 worker 响应慢时 5s 超时
4. `compactingSessions` 在异步 handleCompact 执行期间正确阻止 scanAndDrainQueue
5. `updateCompactAnchor` 在 PostCompact 插入 compact turn 之前执行——anchor 不包含 compact turn
