# Async Worker-Signaling Hooks

**Goal**: 恢复 `Stop`、`PostToolUse`、`SessionEnd` 的 async hook 语义。Hook 在完成**必要的同步 DB 落盘**后立即向 Claude Code 返回 async sentinel；worker 唤醒 / flush 信号在后台继续执行，不再阻塞前台交互。

**影响范围**:
- `src/hooks/handlers/stop.ts`
- `src/hooks/handlers/post-tool-use.ts`
- `src/hooks/handlers/session-end.ts`
- `src/hooks/hook-command.ts`（只复用现有 async sentinel 机制，不改协议）
- 对应 hook tests

**动机**: `7ea05f5` 时期的 `Stop` hook 曾通过 `asyncWork` 让 Claude Code 立即恢复控制。`0f966c6` 的 queue-backed worker 改造把 extraction 挪到后台 worker，但同时把 `notifyWorkerWake()` / `notifyWorkerFlush()` 放回同步路径，导致：
- `Stop` 虽然不再直接做 Mnemosyne extraction，仍然阻塞在 worker compatibility / wake 流程上
- `PostToolUse` 和 `SessionEnd` 也一样
- UI 再次出现 `running stop hooks...` 的前台等待感

这个等待**不是 correctness 必需**。真正必须同步完成的只是 durable DB 更新；worker 信号发送本身可以放到 async sentinel 之后继续执行。

---

## Locked Decisions

**D1**: **`Stop` / `PostToolUse` / `SessionEnd` 全部恢复为 async hook**。  
三者的 handler 返回：

```ts
return {
  continue: true,
  exitCode: HOOK_SUCCESS_EXIT_CODE,
  asyncWork: async () => {
    await notifyWorkerWake(...); // 或 notifyWorkerFlush(...)
  },
};
```

Claude Code 在收到 async sentinel 后恢复控制；hook 进程继续在后台执行 `asyncWork`。

**D2**: **`hook-command` 的 async sentinel 协议保持不变**。  
已有实现已经支持：

```ts
stdout.write(`${JSON.stringify({ async: true })}\n`);
await result.asyncWork();
```

本 spec 不修改协议，不引入新 sentinel，不改 exit code 语义。只让生产 handler 真正返回 `asyncWork`。

**D3**: **同步边界只覆盖 durable DB work，不覆盖 worker 通知**。

- `PostToolUse` 同步部分：
  - 解析输入
  - 插入 `observations`
  - 插入 `pending_queue(kind='obs')`
  - 返回 `asyncWork(() => notifyWorkerWake(...))`

- `SessionEnd` 同步部分：
  - 解析 content session id
  - 解析到 `session.id`
  - 返回 `asyncWork(() => notifyWorkerFlush(session.id, ...))`

- `Stop` 同步部分：
  - 恢复 orphan active turns 的 `assistant_response`
  - 更新当前 turn 的 `assistant_response`
  - enqueue `turn-stop`
  - 更新 session `completedAtEpoch`
  - `detectAndCleanSidechainTurns(...)`
  - 返回 `asyncWork(() => notifyWorkerWake(...))`

换句话说：**先把 DB 写对，再异步通知 worker**。

**D4**: **`Stop` 不做“完全异步化”**。  
`Stop` 的 sidechain cleanup 和 queue 入队仍然必须在 sentinel 前完成，原因有两个：

1. 这些是 durability / correctness 边界，不能依赖后台 best-effort  
2. 若先发 async sentinel 再做 cleanup，worker 可能先处理到尚未清理的 sidechain queue items

所以本 spec 不追求“`Stop` 内什么都不做”，只把**worker signal** 移出同步路径。

**D5**: **后台 `asyncWork` 失败不回滚已完成的同步 DB 写入**。  
如果 `notifyWorkerWake()` / `notifyWorkerFlush()` 失败：
- 继续沿用当前 non-blocking hook 原则
- 已经写入的 `pending_queue` / turn/session 更新保持不变
- 下一个 hook 或显式 worker 唤醒继续兜底

这和现有 queue-backed 设计一致：队列是持久化的，signal 是 best-effort。

**D6**: **`SessionEnd` 仍保持 fire-and-forget 语义，只是 sentinel 更早发出**。  
当前 `SessionEnd` 设计已经要求“不等待 flush 完成”。本 spec 不改变这一点，只把：

```ts
await notifyWorkerFlush(...)
```

改成：

```ts
asyncWork: async () => {
  await notifyWorkerFlush(...);
}
```

**D7**: **本 spec 不改变 `PreCompact`、`SessionStart`、`UserPromptSubmit` 的同步语义**。  
范围只限：
- `Stop`
- `PostToolUse`
- `SessionEnd`

避免把 `PreCompact fire-and-forget`、context 注入、session-init adopt 这些不同问题混到一份 spec 里。

**D8**: **成功标准是“前台不再等待 worker signal”，不是“完全看不到后台 hook 状态”**。  
Claude Code 仍可能显示后台 hook 正在运行；这不是失败。  
本 spec 真正保证的是：
- async sentinel 在 durable DB work 之后、worker signal 之前发出
- 用户交互不会被 `notifyWorkerWake()` / `notifyWorkerFlush()` 的等待路径挡住

---

## 不需要改的

- `src/worker/client.ts`  
  `notifyWorkerWake()` / `notifyWorkerFlush()` 的行为保持不变。本 spec 只改变**调用时机**，不改变 signal 逻辑。

- `src/worker/server.ts`  
  worker 的 `/wake`、`/flush`、queue drain 行为不变。

- `src/hooks/hook-command.ts` 的 async sentinel 协议  
  当前实现已经足够。

- `PreCompact`  
  它已经通过 `/compact` fire-and-forget 解决了主要阻塞问题，不属于这份 spec。

---

## Implementation

### Task 1: `PostToolUse` 改为 async sentinel

`src/hooks/handlers/post-tool-use.ts`

将：

```ts
await notifyWorkerWake(...);
return { continue: true };
```

改为：

```ts
return {
  continue: true,
  asyncWork: async () => {
    await notifyWorkerWake(...);
  },
};
```

约束：
- observation insert + queue enqueue 必须发生在 return 之前
- handler 本体不再等待 worker compatibility / wake

### Task 2: `SessionEnd` 改为 async sentinel

`src/hooks/handlers/session-end.ts`

将：

```ts
await notifyWorkerFlush(session.id, ...);
return { continue: true };
```

改为：

```ts
return {
  continue: true,
  asyncWork: async () => {
    await notifyWorkerFlush(session.id, ...);
  },
};
```

约束：
- session lookup 仍同步完成
- 不改变 `/flush` 本身的 fire-and-forget worker 语义

### Task 3: `Stop` 改为“同步落盘 + 异步 wake”

`src/hooks/handlers/stop.ts`

将当前同步末尾：

```ts
await notifyWorkerWake(...);
return {
  continue: true,
  exitCode: HOOK_SUCCESS_EXIT_CODE,
};
```

改为：

```ts
return {
  continue: true,
  exitCode: HOOK_SUCCESS_EXIT_CODE,
  asyncWork: async () => {
    await notifyWorkerWake(...);
  },
};
```

但必须保留以下同步顺序：

1. orphan turn `assistant_response` 回填
2. 当前 turn `assistant_response` 更新
3. enqueue `turn-stop`
4. session `completedAtEpoch` 更新
5. `detectAndCleanSidechainTurns(...)`
6. **然后** 返回 `asyncWork`

### Task 4: Tests

#### `PostToolUse`

新增 / 修改测试，验证：
1. handler 返回 `asyncWork`
2. observation row 和 `pending_queue` row 在 `asyncWork` 执行前已经存在
3. `notifyWorkerWake()` 不在 handler 主体里被提前调用
4. 执行 `asyncWork()` 后才调用 `notifyWorkerWake()`

#### `SessionEnd`

新增 / 修改测试，验证：
1. handler 返回 `asyncWork`
2. 只要 session 解析成功，就不会同步等待 `notifyWorkerFlush()`
3. 执行 `asyncWork()` 后调用 `notifyWorkerFlush(session.id, ...)`

#### `Stop`

新增 / 修改测试，验证：
1. handler 返回 `asyncWork`
2. `turn-stop` queue item、session completion、assistant response 更新在返回前已经完成
3. sidechain cleanup 也在返回前完成
4. `notifyWorkerWake()` 不在 handler 主体里被提前调用
5. 执行 `asyncWork()` 后才调用 `notifyWorkerWake()`

#### `hook-command`

补一个真实 handler 路径测试，验证 `stop` / `tool-use` / `session-end` 经过 `runHookCommand()` 时：
1. stdout 先写出 `{"async": true}`
2. 不写同步 hook result JSON
3. `asyncWork` 仍在后台被执行

---

## Expected Outcome

实现完成后：

- `PostToolUse` 不再因 worker wake 阻塞前台
- `SessionEnd` 更快发出 async sentinel，不再把 flush signal 放在同步路径
- `Stop` 仍保证 DB 状态正确，但不会再同步等待 worker wake
- queue-backed worker 的 durability 语义不变
- 用户恢复控制的时间由“DB 落盘 + transcript cleanup”决定，而不再叠加 `notifyWorkerWake()` / readiness wait
