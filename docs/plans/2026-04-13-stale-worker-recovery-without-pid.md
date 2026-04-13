# Stale Worker Recovery Without PID

**Goal**: 修复 worker 升级时的一个卡死路径：旧 build 的 worker 仍在监听 `37778`，但 `~/.claude-mnemo/worker.pid` 丢失，导致新 hook 识别到 `stale` 却无法终止旧进程，也无法拉起新 worker。

**动机**: 2026-04-13 的线上现象已经复现：

- `pending_queue` 持续积压，hook 仍在正常入队
- `127.0.0.1:37778/health` 返回 `buildId = 0.2.0-mnvgs2ee`
- 本地 marketplace 脚本已经是 `0.2.1-mnwnvwxp`
- `~/.claude-mnemo/worker.pid` 和 `worker.starting` 都不存在

当前 `notifyWorkerWake()` / `notifyWorkerCompact()` 的 stale 路径只会调用 `killStaleWorker()`，而它只依赖 `worker.pid`。当 pid 文件缺失时：

1. `isWorkerCompatible()` 返回 `stale`
2. `killStaleWorker()` 无事可做
3. `spawnWorkerProcess()` 尝试启动新 worker
4. 新 worker 因 `EADDRINUSE` 立刻退出
5. `waitForCompatibleWorker()` 一直看到 `stale`
6. 不会发送 `/wake` 或 `/compact`
7. 队列持续堆积，记忆 agent 不再消费

这不是路径编码问题，也不是安装缓存问题，而是 **stale-worker eviction 过度依赖 pid 文件**。

---

## Locked Decisions

**D1**: **`/health` 返回 `pid`**。worker 的 health payload 从：

```json
{ "ok": true, "buildId": "0.2.1-..." }
```

扩展为：

```json
{ "ok": true, "buildId": "0.2.1-...", "pid": 12345 }
```

`pid` 是本地 worker 进程自己的 `process.pid`。这是本 spec 的核心修复基础：stale 检测不再只依赖 `worker.pid` 文件。

**D2**: **stale-worker 终止优先使用 `/health` 返回的 `pid`，`worker.pid` 只做 fallback**。客户端侧终止顺序固定为：

1. 如果 `/health` 返回了 `pid`，直接 `SIGTERM` 这个 pid
2. 否则再尝试读取 `worker.pid`
3. 两者都没有时，不再盲目 `spawn + wait`

理由：

- `/health` 的 `pid` 来自真实监听 `37778` 的进程，是最可靠的 handle
- `worker.pid` 可能缺失、过期，或被清理逻辑提前删除

**D3**: **stale 且无法获得终止 handle 时，不再假装能自动恢复**。如果出现：

- `/health` 返回 `stale`
- body 中没有 `pid`
- `worker.pid` 也不存在或不可解析

则客户端应：

- 记录明确日志：`stale worker detected but no pid handle is available`
- 直接返回失败 / 放弃本次自动升级尝试
- 不做 `spawnWorkerProcess()`，因为这只会稳定撞上 `EADDRINUSE`

这比当前“无意义地 spawn 再 timeout”更可诊断。

> 说明：这意味着 **已经在运行的老版本 worker** 如果既不在 `/health` 里暴露 `pid`，又没有 `worker.pid` 文件，仍需要一次手动恢复。  
> 本 spec 的目标是修复 **未来版本** 的升级自恢复链路，而不是引入一套跨平台的“按端口查 pid 并强杀”的 OS 级逻辑。

**D4**: **`notifyWorkerWake` / `notifyWorkerFlush` / `notifyWorkerCompact` 统一走同一条 stale-restart 路径**。不要在三个入口（wake / flush / compact）分别复制 stale 逻辑。抽成共享 helper，例如：

```ts
async function ensureCompatibleWorker(
  mode: "wake" | "compact" | "flush",
  deps: WorkerClientDeps,
  env: NodeJS.ProcessEnv,
): Promise<"compatible" | "unrecoverable-stale" | "down">;
```

最小要求：

- `wake`、`flush`、`compact` 都先走统一 stale resolution
- `flush` 保持现有 fire-and-forget 语义，但 stale restart 也必须复用同一 helper
- `flush` 不能再保留自己的一套“先 POST、失败再 kill/spawn”的旧分支；stale / down / compatible 必须和 `wake` / `compact` 走同一个前置判定
- `flush` 与 `wake/compact` 的差异只体现在“是否等待 compatible”：
  - `wake` / `compact`：spawn 后等待 `compatible`
  - `flush`：spawn 后不等待，只把 `CLAUDE_MNEMO_FLUSH_SESSION_ID` 注入 startup env，然后立即返回

**D5**: **stale termination 不再依赖固定 `sleep(300ms)`，改为显式等待 `down` 再 spawn**。当前实现里：

```ts
SIGTERM -> sleep(300ms) -> spawnWorkerProcess() -> waitForCompatibleWorker()
```

这依赖“旧 worker 在 300ms 内一定退出”，但不成立。worker 可能：

- 正在处理 inflight agent 请求
- 正在执行 shutdown cleanup
- 因 event-loop / IO 延迟晚于 300ms 释放端口

因此新流程必须拆成两个阶段：

1. `SIGTERM` stale pid
2. poll `/health` 直到返回 `down`（或超时）
3. 只有确认 `down` 后才 `spawnWorkerProcess()`
4. `wake` / `compact` 再继续等 `compatible`
5. `flush` 直接返回（不等 compatible）

建议抽成显式 helper：

```ts
async function waitForWorkerDown(
  deps: WorkerClientDeps = {},
): Promise<boolean>;
```

**D6**: **server 端不改 worker singleton / pid 文件协议**。这份修复不试图解释“为什么某次运行中 pid 文件消失”，只解决“pid 文件缺失时 stale restart 彻底失能”的问题。

也就是说：

- `acquireWorkerSingleton()`
- `createShutdownCleanup()`
- `worker.starting`

这些现有协议先不重构。本 spec 只补足客户端的 stale termination handle。

---

## 不做的事

- **不实现按端口查 pid 并 kill 的 OS 特定逻辑**  
  如 `lsof` / `netstat` / `Get-NetTCPConnection`。这会引入平台分支和额外权限问题。

- **不解决“为什么 pid 文件会缺失”这个更深层问题**  
  这是另一个调试题。当前已知现象足以做出更稳的恢复逻辑。

- **不改变 hook 的同步 / 异步边界**  
  这和 `async-worker-signaling-hooks` 是另一份 spec。

---

## Implementation

### Task 1: 扩展 `/health` 返回 `pid`

**Files**

- Modify: `src/worker/server.ts`
- Test: `tests/worker/server.test.ts`

改动：

```ts
return new Response(
  JSON.stringify({ ok: true, buildId: BUILD_ID, pid: process.pid }),
  {
    status: 200,
    headers: { "content-type": "application/json" },
  },
);
```

测试覆盖：

1. `/health` 返回 `pid`
2. `pid` 为当前 worker 进程 pid

### Task 2: 客户端引入 health-pid stale termination

**Files**

- Modify: `src/worker/client.ts`
- Test: `tests/worker/client.test.ts`

新增 helper，建议形态：

```ts
interface WorkerHealthBody {
  ok?: boolean;
  buildId?: string;
  pid?: number;
}

async function readWorkerHealth(
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<
  | { status: "down" }
  | { status: "compatible"; pid?: number }
  | { status: "stale"; pid?: number }
>;
```

以及：

```ts
function killWorkerPid(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // no-op
  }
}
```

然后将 `killStaleWorker()` 改成：

1. 优先使用 `health.pid`
2. 无 `health.pid` 时 fallback 到 `worker.pid`
3. 两者都没有时返回 `false`

### Task 3: 统一 stale-restart 控制流

**Files**

- Modify: `src/worker/client.ts`
- Test: `tests/worker/client.test.ts`

目标行为：

- `status = compatible` → 正常继续
- `status = down`
  - `wake` / `compact`：`spawnWorkerProcess()` → `waitForCompatibleWorker()`
  - `flush`：`spawnWorkerProcess(flushEnv)` → 立即返回
- `status = stale`
  - 若拿到 pid handle：
    1. `SIGTERM`
    2. `waitForWorkerDown()`
    3. 若确认 `down`
       - `wake` / `compact`：`spawnWorkerProcess()` → `waitForCompatibleWorker()`
       - `flush`：`spawnWorkerProcess(flushEnv)` → 立即返回
    4. 若未在预算内变成 `down`：视为 `unrecoverable stale`
  - 若拿不到 pid handle → 明确报 `unrecoverable stale`，**不 spawn**

对 `notifyWorkerWake()`：

- 如果是 `unrecoverable stale`，直接返回，不发 `/wake`

对 `notifyWorkerFlush()`：

- 前置 stale/down 检测也复用同一 helper
- 如果是 `compatible`，直接 fire-and-forget `POST /flush`
- 如果是 `down`，spawn 携带 `CLAUDE_MNEMO_FLUSH_SESSION_ID` 的 worker，然后立即返回
- 如果是 `stale` 且拿到 pid，先 `SIGTERM` + `waitForWorkerDown()`，再 spawn 携带 flush env 的 worker，然后立即返回
- 如果是 `unrecoverable stale`，直接返回，不做盲目 spawn
- `flush` 保持 fire-and-forget，不引入 `waitForCompatibleWorker()`

对 `notifyWorkerCompact()`：

- 如果是 `unrecoverable stale`，抛出可诊断错误：
  - `Stale worker detected but no pid handle is available for restart.`

### Task 4: 回归测试

**Files**

- Modify: `tests/worker/client.test.ts`
- Modify: `tests/worker/server.test.ts`

至少补这些测试：

1. `/health` 包含 `pid`
2. stale worker 且 `health.pid` 存在时，即使 `worker.pid` 缺失，也会 kill + respawn
3. stale worker 且 `health.pid` 缺失，但 `worker.pid` 存在时，仍走旧 fallback
4. stale worker 且两者都缺失时：
   - `notifyWorkerWake()` 不再盲目 spawn
   - `notifyWorkerFlush()` 不再盲目 spawn
   - `notifyWorkerCompact()` 抛出明确错误
5. stale worker 在 `SIGTERM` 后仍未 `down` 时，不会提前 spawn 新 worker
6. `notifyWorkerFlush()` 的 stale 路径会 `waitForWorkerDown()` 后再 spawn startup-flush worker
7. down 路径不受影响
8. compatible 路径不受影响

---

## Verification

最少验证：

```bash
bun test tests/worker/client.test.ts
bun test tests/worker/server.test.ts
npm run typecheck
npm run build
claude plugins validate plugin
```

建议再做一次手动验证：

1. 启动旧 build worker
2. 人工删掉 `~/.claude-mnemo/worker.pid`
3. 运行新 build 的 `notifyWorkerWake()`
4. 断言：
   - 旧 worker 被终止
   - 新 worker `/health` 返回当前 `BUILD_ID`
   - `pending_queue` 开始继续消费

---

## Expected Outcome

修复完成后，升级场景会变成：

- 旧 worker 仍在运行也没关系
- 只要它还能响应 `/health`，新 hooks 就能拿到它的 `pid`
- stale restart 不再被 `worker.pid` 文件缺失卡死
- 不会再出现“新版本已安装、队列持续积压、日志不再更新，但端口上仍挂着旧 worker”的半死状态
