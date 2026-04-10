# Worker 架构 + 实时 Obs 提取

Date: 2026-04-10

## 动机

当前 mnemo 架构的三个痛点：

1. **Stop 时批量提取** —— session 结束才处理，崩溃丢数据，无实时性
2. **上下文膨胀** —— Stop 提取把整个 transcript 塞进 prompt，长 session 浪费 token
3. **Obs 表冗余** —— 14 列有一半从未使用（narrative / facts / concepts / description...）

改造目标：引入常驻 worker 进程，PostToolUse 触发实时 obs 提取，精简 schema，去掉代码和数据的历史包袱。

**不保留 fallback，不保留兼容层。** 老数据直接清掉重建。

---

## 整体架构

```
┌─ Hooks (短命进程) ──────────────────────────────┐
│                                                  │
│  UserPromptSubmit  → INSERT session + turn       │
│                      (纯 DB 写入，不通知 worker)    │
│                                                  │
│  PostToolUse       → 事务(INSERT obs + enqueue)   │
│                    → POST /wake                    │
│                                                  │
│  Stop (每个 turn 结束) → 事务(UPDATE turn + enqueue) │
│                        → POST /wake              │
│                                                  │
│  PreCompact        → POST /compact                │
└──────────────────────────────────────────────────┘

**重要**: Claude Code 的 Stop hook 在**每次 assistant 响应结束**触发，不是 session 结束。
这是天然的 turn 边界，每个 turn 都会触发一次 Stop。

**对称性原则**:
- obs 创建 (PostToolUse) → obs 提取 (PostToolUse)  ← 实时
- turn 创建 (UserPromptSubmit) + turn 完成 (Stop) → turn 提取 (Stop)  ← 边界

**原则**: UserPromptSubmit 只负责记录元数据，不触发记忆 Agent。
只有 PostToolUse / Stop / PreCompact 三类 hook 需要调用 worker。
Worker 处理 obs 时从 DB 查询最新 turn_id，不依赖事件通知。
            │ HTTP localhost:37778
            ▼
┌─ Worker (Bun 常驻进程) ─────────────────────────┐
│                                                  │
│  per-session 状态：                                │
│    query: Query         长生命周期 query() 会话    │
│    pushQueue: Queue     待发送给 Mnemosyne 的消息   │
│    initialized: bool    是否已发送初始化消息        │
│                                                  │
│  流水线：                                          │
│    obs → push to queue → yield to query() →     │
│    parse remember() calls → UPDATE obs            │
│                                                  │
│  重置时机：                                        │
│    PreCompact / Stop / 硬阈值                     │
│                                                  │
└──────────────────────────────────────────────────┘
            │
            ▼
┌─ SQLite (~/.claude-mnemo/claude-mnemo.db) ──────┐
│  sessions / turns / observations / memories      │
└──────────────────────────────────────────────────┘
```

---

## Schema 变更

**所有变更是 DROP + CREATE，不做 migration**（当前只有 3 个 session，可接受数据丢失）。

### SQLite 配置（必须）

Hook 和 worker 开 DB 时都要设置 WAL 模式 + busy timeout。这是多写者并发的**强制**要求——不开 WAL，hook 和 worker 的写入会被全库锁串行化，叠加 hook 5 秒 timeout，PostToolUse 在 worker 忙时会超时失败。

```typescript
function initDatabaseConnection(dbPath: string): Database {
  const db = new Database(dbPath);
  db.exec(`PRAGMA journal_mode = WAL`);
  db.exec(`PRAGMA busy_timeout = 3000`);    // 锁冲突时等最多 3 秒，不要立刻 SQLITE_BUSY
  db.exec(`PRAGMA synchronous = NORMAL`);   // WAL 下够用，比 FULL 快
  db.exec(`PRAGMA foreign_keys = ON`);
  return db;
}
```

所有打开 DB 的位置（hook handlers、worker、MCP server）都必须走这个初始化函数。

### turns 表

```sql
CREATE TABLE turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    prompt_number INTEGER NOT NULL,
    content_prompt_id TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    -- 状态流转: active → extracted / skipped / undone
    -- "queued" 和 "extracting" 中间态放在 pending_queue 表里
    user_prompt TEXT,
    assistant_response TEXT,
    title TEXT,                              -- LLM
    content TEXT,                            -- LLM
    insight TEXT,                            -- LLM
    type TEXT,                               -- LLM: bugfix|feature|refactor|change|discovery|decision
    tags TEXT,                               -- LLM: JSON array
    files_read TEXT,                         -- 自动聚合自 obs
    files_modified TEXT,                     -- 自动聚合自 obs
    tool_call_count INTEGER,                 -- 自动 COUNT obs
    created_at_epoch INTEGER NOT NULL,
    updated_at_epoch INTEGER,
    UNIQUE(session_id, prompt_number)
);
```

**删除字段**：`description`

**新增字段**：`type`, `tags`

**Status 语义**：业务状态保留 `active` / `extracted` / `skipped` / `undone`——`active` 是初始态（UserPromptSubmit 创建时），其余是终态。"正在排队等处理"和"worker 正在处理"这两个中间态不在业务表里，由 `pending_queue` 表达。

### observations 表

```sql
CREATE TABLE observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    turn_id INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
    tool_name TEXT NOT NULL,                -- 自动
    tool_input TEXT,                        -- 自动: JSON 字符串
    tool_result TEXT,                       -- 自动: JSON 字符串或纯文本
    title TEXT,                             -- LLM (PostToolUse 实时)
    content TEXT,                           -- LLM (PostToolUse 实时)
    status TEXT NOT NULL DEFAULT 'pending', -- pending → extracted / skipped
    created_at_epoch INTEGER NOT NULL
);
```

**删除字段**：`type`, `description`, `insight`, `narrative`, `facts`, `tags`, `concepts`, `files_read`, `files_modified`

**新增字段**：`tool_name`, `tool_input`, `tool_result`, `status`

**Status 语义**：业务状态保留 `pending` / `extracted` / `skipped`——`pending` 是初始态（从未被 LLM 处理），`extracted` / `skipped` 是终态。"正在处理"状态在 `pending_queue` 表里表达（`claimed_at_epoch IS NOT NULL`），不混入业务 status。

### sessions 表

```sql
-- 只删除 description 字段，其他不变
```

### memories 表

不变。

### pending_queue 表（新增）

统一的持久化处理队列。**所有 worker 处理任务都走这张表**，用 AUTOINCREMENT 主键作为单调 FIFO 序列号：

```sql
CREATE TABLE pending_queue (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,   -- 持久化 FIFO 序列号
    kind TEXT NOT NULL,                      -- 'obs' | 'turn-stop'
    target_id INTEGER NOT NULL,              -- obs.id 或 turn.id
    session_db_id INTEGER NOT NULL,
    claimed_at_epoch INTEGER,                -- NULL = 未认领；非 NULL = worker 正在处理
    enqueued_at_epoch INTEGER NOT NULL
);

CREATE INDEX idx_pending_queue_unclaimed
    ON pending_queue(seq) WHERE claimed_at_epoch IS NULL;

CREATE INDEX idx_pending_queue_session
    ON pending_queue(session_db_id, seq);
```

**为什么需要独立的队列表**：
- 秒级时间戳无法区分同一秒内的 obs 和 turn-stop 顺序
- `created_at_epoch` (obs) 和 `updated_at_epoch` (turn) 来自两张表，合并排序不可靠
- AUTOINCREMENT 主键天然单调，是 SQLite 里最简单的持久化全序键
- 避免把队列状态混入业务表的 status 字段

---

## remember() 工具重设计

### 路由（只按 id 前缀分发，废弃 parent）

| id 格式 | 路由 | 说明 |
|---|---|---|
| `O{id}` | obs 回填 | 只接受 title, content, status |
| `T{id}` | turn 更新 | 接受 title, content, insight, type, tags, status |
| `S{id}` | session 更新 | 接受 title, content, insight, next_steps |
| `M{id}` | memory 更新 | 接受 type, scope, title, content, reasoning, application, tags, status |
| (无 id) | memory 创建 | 必需 type, scope, title, content |

### 参数精简

```typescript
export const rememberInputShape = {
  id: z.string().optional(),                 // O{id} | T{id} | S{id} | M{id}
  title: z.string().optional(),
  content: z.string().optional(),
  insight: z.string().optional(),
  type: z.string().optional(),               // turn 分类 / memory 分类
  tags: z.array(z.string()).optional(),
  status: z.enum(["skipped", "undone", "active", "superseded", "archived"]).optional(),
  next_steps: z.string().optional(),         // session only
  scope: z.string().optional(),              // memory only
  reasoning: z.string().optional(),          // memory only
  application: z.string().optional(),        // memory only
  source: z.string().optional(),             // memory only, "T{id}" 格式
};
```

**删除参数**：`parent`, `prompt_number`, `files_read`, `files_modified`, `source_turn_id`

从 16 个参数精简到 12 个。LLM 不再需要填任何可自动推导的字段。

---

## Worker 进程

### 启动与端口

- **端口**：`37778`（避开 claude-mem 的 37777）
- **启动触发**：任何 hook 发请求前先 `GET /health`，不可达则 spawn worker
- **启动方式**：**必须通过 `bun-runner.js`**，复用其 Bun 路径发现逻辑（覆盖"Bun 刚装好还没进 PATH"的场景）：

```typescript
function spawnWorker() {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || resolvePluginRoot();
  const bunRunnerPath = join(pluginRoot, 'scripts/bun-runner.js');
  const workerPath = join(pluginRoot, 'scripts/worker.cjs');
  
  const child = spawn('node', [bunRunnerPath, workerPath], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
}
```

**绝不**直接 `spawn('bun', ...)`——bun-runner.js 已经处理了 `~/.bun/bin/bun`、`/usr/local/bin/bun`、`/opt/homebrew/bin/bun` 等多个 fallback 路径。Worker 走 `stdio: 'inherit'`（bun-runner.js 检测到非 `hook-command.cjs` 时自动不做 stdin buffering）。

- **退出**：30 分钟无活动则自动退出（通过最后一次 HTTP 请求时间跟踪）

### 单例保证（跨平台）

**不用 `flock`**——`flock` 是 Linux CLI，macOS 没有 CLI（只有系统调用），Windows 完全不支持。改用三步：

1. **Hook 层**先 `GET /health` 探活，成功直接用，失败才 spawn worker
2. **Worker 启动冷却**防止短时间内多次 spawn
3. **Worker 真实 bind 端口**，不做 test-bind（避免 TOCTOU）
4. **bind 成功后才写 pid 文件**（避免虚假活进程）

```typescript
async function acquireWorkerSingleton(): Promise<"acquired" | "already-running"> {
  const pidFile = join(homedir(), '.claude-mnemo', 'worker.pid');
  const startingFile = join(homedir(), '.claude-mnemo', 'worker.starting');
  
  // 1. 启动冷却：另一个进程正在启动（近 10 秒内），让路
  if (existsSync(startingFile)) {
    const startingAt = statSync(startingFile).mtimeMs;
    if (Date.now() - startingAt < 10_000) {
      return "already-running";
    }
    // 陈旧 starting，清掉
    try { unlinkSync(startingFile); } catch {}
  }
  
  // 2. PID 判活：pid 文件存在且进程还活着 → 已有实例
  if (existsSync(pidFile)) {
    const pid = parseInt(readFileSync(pidFile, 'utf-8'), 10);
    if (!isNaN(pid) && isProcessAlive(pid)) {
      return "already-running";
    }
    // 陈旧 pid，清掉
    try { unlinkSync(pidFile); } catch {}
  }
  
  // 3. 写 starting 标记
  writeFileSync(startingFile, String(process.pid));
  return "acquired";
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);  // 信号 0 = 探活
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
```

Worker 主入口：

```typescript
async function main() {
  const result = await acquireWorkerSingleton();
  if (result === "already-running") {
    process.exit(0);
  }
  
  const pidFile = join(homedir(), '.claude-mnemo', 'worker.pid');
  const startingFile = join(homedir(), '.claude-mnemo', 'worker.starting');
  
  let server: Server;
  try {
    // 真实 bind —— 如果端口被抢走会抛 EADDRINUSE（TOCTOU 安全）
    server = Bun.serve({
      port: 37778,
      fetch: handleRequest,
    });
  } catch (err) {
    try { unlinkSync(startingFile); } catch {}
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      // 别人抢先 bind 了，正常退出
      process.exit(0);
    }
    throw err;
  }
  
  // bind 成功之后才写 pid（保证 pid 文件对应的进程一定在监听端口）
  try {
    writeFileSync(pidFile, String(process.pid));
  } finally {
    try { unlinkSync(startingFile); } catch {}
  }
  
  registerShutdownCleanup(pidFile);
  
  // 执行崩溃恢复 + 启动 watchdog + 开始消费队列
  recoverFromCrash();
  startWatchdog();
  scanAndDrainQueue();
}

function registerShutdownCleanup(pidFile: string): void {
  const cleanup = async () => {
    try {
      await shutdownGracefully();  // 关闭所有 session 的 query subprocess
    } finally {
      try { unlinkSync(pidFile); } catch {}
      process.exit(0);
    }
  };
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);
  process.on('beforeExit', cleanup);
}
```

**关键点**：
- **不做 test-bind + stop + 真 bind**：两次 bind 之间的 TOCTOU 窗口会让别人抢占端口
- **实 bind 成功之后才写 pid**：如果 bind 失败，pid 文件不会指向一个"没在监听端口的活进程"，避免 hook 探活时误以为 worker 活着但 /health 打不通

### Hook / Worker 启动流程总览

```
Hook 进程（PostToolUse / Stop / PreCompact）
  ├─ 事务写入 DB（obs/turn + pending_queue）
  ├─ POST /wake (或 /compact)
  │   ├─ 200 → 完成，hook 返回
  │   └─ 失败（connection refused / timeout）
  │       └─ spawn('node', ['bun-runner.js', 'worker.cjs'], { detached: true }).unref()
  │           └─ 不等待结果，不重试 POST
  │           └─ 数据已在 pending_queue，下次 /wake 或 worker 启动时处理
  
Worker 进程
  ├─ acquireWorkerSingleton()
  │   ├─ "already-running" → exit 0
  │   └─ "acquired" → 写 starting 标记
  ├─ Bun.serve({ port: 37778 })
  │   ├─ EADDRINUSE → 清 starting → exit 0
  │   └─ 成功 → 写 pid 文件 → 清 starting
  ├─ 崩溃恢复（重置 claimed_at_epoch）
  ├─ 启动 watchdog
  └─ 首次扫描队列
```

双层防护：hook 先探活（避免重复 spawn），worker 自己再做 singleton 检查（防止 race condition 下的双启动）。

### HTTP 端点

```
GET  /health              → 200 OK
POST /wake                { }                                    → 200 OK (fire-and-forget 唤醒)
POST /compact             { session_id, transcript_path }         → 200 OK (同步 flush)
```

**没有 `/turn-created` 端点**。UserPromptSubmit 只写 DB。

**`/wake` 取代原计划的 `/obs` 和 `/turn-stop`**。因为 hook 已经把任务写进 `pending_queue` 表，HTTP 请求只是唤醒 worker 立即扫描队列的信号，不需要携带任何 id。PostToolUse 和 Stop hook 都调 `POST /wake`。

Worker 的 /wake handler 逻辑：

```typescript
async function handleWake(req: Request): Promise<Response> {
  // 唤醒扫描循环（不等待处理完成）
  scanAndDrainQueue();  // fire-and-forget
  return new Response(null, { status: 200 });
}
```

Worker 内部 `scanAndDrainQueue()` 是幂等的：重复调用只会触发一次扫描，正在处理的任务不受影响。

### 同步语义差异

| 端点 | 返回时机 | 崩溃恢复依据 |
|---|---|---|
| `/wake` | 触发扫描 → 立即返回 | `pending_queue` 表 |
| `/compact` | **等 worker 处理完队列** → 返回 | 无需恢复（同步完成） |

**为什么 `/compact` 必须同步**：

主 Agent 的 compact 一旦发生就**无法回退**——原始对话历史会被压缩成摘要，新的 session context 从摘要开始。如果 worker 还在处理 pending 任务时主 Agent 已经 compact，下次 session 恢复时 session summary 会落后一个 cycle。

对比 `/wake`：它的持久化状态在 `pending_queue` 表里，worker 崩溃或延迟处理都可恢复，所以可以 fire-and-forget。

### `/compact` 的 flush 流程

```
POST /compact { session_id } → worker:
  1. 检测并自动标记 sidechain undone turns，清理对应的 queue 条目
  2. 调用 scanAndDrainQueue(session_id) 消费该 session 所有未处理任务
  3. Push 最终 session summary 提取 prompt
  4. 关闭 query session，清理状态
  5. 返回 200
```

具体实现在下文"全局扫描循环"章节的 `handleCompact()`，复用统一的 `scanAndDrainQueue()` 和原子 `claimNextItem()`，不另起查询循环。

**超时保护**：hook 侧给 `/compact` 25 秒超时（PreCompact hook 总 timeout 是 30 秒）：

```typescript
const response = await fetch('http://localhost:37778/compact', {
  method: 'POST',
  body: JSON.stringify({ session_id, transcript_path }),
  signal: AbortSignal.timeout(25000),
});
```

**超时退化**：罕见情况下 25 秒不够（大量积压的 obs），hook 超时返回但 worker 内部继续处理。这会导致 session summary 落后一个 compact cycle——**可接受的退化**，因为：
- Turn 级数据仍然正确（`pending_queue` 里已有条目，worker 会继续处理）
- 只有 session-level 摘要有短暂滞后
- 下次 compact 或 session end 会追上

`/compact` 超时是已知的容忍损失，不是 bug。

**端点语义回顾**：`/wake` 是 fire-and-forget 的扫描唤醒信号（worker 从 `pending_queue` 读取，HTTP 请求不携带数据）；`/compact` 是同步 flush，等 worker 处理完队列才返回。

### Per-session 状态

```typescript
interface SessionState {
  sessionDbId: number;
  contentSessionId: string;
  query: Query | null;                    // 当前活跃的 query() 会话
  pushMessage: (msg: SDKUserMessage) => void;  // 向 generator 推消息
  priorTitles: string[];                  // 当前 query 会话内已提取的 obs titles
  cumulativeTokens: number;               // 用于硬阈值检测
  lastPushAt: number;                     // 最后一次向 query 推消息的时间（watchdog 用）
  lastMessageAt: number;                  // 最后一次收到 Mnemosyne 响应的时间（watchdog 用）
  lastActivity: number;                   // 最后一次有入站请求的时间（空闲超时用）
  queryPid?: number;                      // Claude Code 子进程 PID（zombie 清理用）
  queryAbortController: AbortController;  // 强制中止 query() 的控制器
  processingLock: Promise<void>;          // 串行锁（链式 Promise）
  closing?: Promise<void>;                // closeSessionQuery 幂等保护
}

const sessions = new Map<number, SessionState>();  // key = sessionDbId
```

**lastPushAt vs lastMessageAt 的区别**：
- `lastPushAt` = 最后一次向 Mnemosyne 发消息的时间
- `lastMessageAt` = 最后一次收到 Mnemosyne 响应的时间
- `lastPushAt > lastMessageAt` 表示有 in-flight 请求未响应
- `lastPushAt <= lastMessageAt` 表示当前空闲（所有已发的都回了）

Watchdog 只杀真正僵死的 session（push 了但 30 秒不响应），不杀空闲 session（用户在思考）。

### query() 生命周期契约

创建 query session 时必须通过 `spawnClaudeCodeProcess` 回调捕获子进程 PID，用于 watchdog 和关闭时的 SIGKILL 兜底：

```typescript
function createMnemoQuery(state: SessionState): Query {
  return query({
    prompt: createPushableGenerator(state),
    options: {
      model: "claude-sonnet-4-6",
      abortController: state.queryAbortController,
      spawnClaudeCodeProcess: (opts) => {
        const child = spawn(opts.command, opts.args, opts);
        state.queryPid = child.pid;  // 捕获 PID
        return child;
      },
      pathToClaudeCodeExecutable: resolveClaudeCodeExecutablePath(),
      mcpServers: { mnemo: createMnemoMcpServer(db, state.sessionDbId) },
    },
  });
}
```

**`closeSessionQuery(sessionDbId)` 契约** —— 返回后**必须保证**：
1. `query.abortController.abort()` 已调用
2. Generator 已消费完所有剩余消息
3. 子进程 exit（exitCode !== null），超时则 SIGKILL
4. `SessionState` 从 Map 中删除

```typescript
async function closeSessionQuery(sessionDbId: number): Promise<void> {
  const state = sessions.get(sessionDbId);
  if (!state) return;
  
  // 幂等保护：watchdog 和 handleCompact 可能并发触发关闭
  if (state.closing) {
    return state.closing;
  }
  
  state.closing = (async () => {
    try {
      // 1. 通知 query 停止接收新消息
      state.queryAbortController.abort();
      
      // 2. 等待 query generator 自然结束（最多 5 秒）
      await Promise.race([
        drainQuery(state.query),
        sleep(5000),
      ]);
      
      // 3. 如果子进程还活着，强制 SIGKILL
      if (state.queryPid && isProcessAlive(state.queryPid)) {
        try {
          process.kill(state.queryPid, 'SIGKILL');
        } catch {}
      }
    } finally {
      sessions.delete(sessionDbId);
    }
  })();
  
  return state.closing;
}
```

### Watchdog：检测僵死的 query session

全局 watchdog 每 10 秒扫一次，**只杀真正僵死的**——推了消息但 30 秒没收到响应。空闲 session（push 和 message 对齐）不动，由 30 分钟全局空闲超时处理。

```typescript
setInterval(() => {
  const now = Date.now();
  for (const state of sessions.values()) {
    // 僵死判定：
    // 1. 有活跃 query
    // 2. 最后一次 push 的消息没收到响应（lastPushAt > lastMessageAt）
    // 3. 这个 in-flight 请求超过 30 秒
    if (
      state.query &&
      state.lastPushAt > state.lastMessageAt &&
      now - state.lastPushAt > 30_000
    ) {
      logger.warn("query session stalled, aborting", { 
        sessionDbId: state.sessionDbId,
        lastPushAt: state.lastPushAt,
        lastMessageAt: state.lastMessageAt,
        queryPid: state.queryPid,
      });
      closeSessionQuery(state.sessionDbId).catch(err => {
        logger.error("watchdog closeSessionQuery failed", { 
          sessionDbId: state.sessionDbId, 
          err,
        });
      });
    }
  }
}, 10_000);
```

**空闲 session 不受 watchdog 影响**。一个 session 处理完一批 obs 后，`lastPushAt <= lastMessageAt`，无论空闲多久 watchdog 都不会杀它。空闲清理由独立的 30 分钟全局超时负责，那是预期的懒惰回收，不是强制中止。

### Worker 退出时的清理

```typescript
async function shutdownGracefully(): Promise<void> {
  // 1. 停止接收新请求
  server.stop();
  
  // 2. 关闭所有活跃 session
  const closings = Array.from(sessions.keys()).map(id => closeSessionQuery(id));
  await Promise.allSettled(closings);
  
  // 3. 清理 pid 文件
  try { unlinkSync(pidFile); } catch {}
  
  process.exit(0);
}
```

### 全局扫描循环

Worker 的所有队列消费（`/wake` 触发的后台扫描 + `/compact` 触发的同步 flush）**都走同一条扫描/claim 路径**。不允许另起查询循环。

```typescript
interface QueueItem {
  seq: number;
  kind: "obs" | "turn-stop";
  target_id: number;
  session_db_id: number;
}

interface ClaimOptions {
  sessionFilter?: number;          // 限定本次 claim 的 session（/compact 用）
  excludeSessions?: Set<number>;   // 排除这些 session（全局 /wake 遇到 compacting session 时用）
  skippedSeqs?: Set<number>;       // 本次 drain 内已失败的任务，跳过
}

// 单条原子 claim：SELECT 最早的未认领任务 + CAS UPDATE
// 事务保证 SELECT 和 UPDATE 之间不会有别的写入
// UPDATE 的 AND claimed_at_epoch IS NULL 防止 race
// changes === 1 检查防止"别人已认领"
const claimNextItem = db.transaction((opts: ClaimOptions = {}): QueueItem | null => {
  const filters: string[] = ['claimed_at_epoch IS NULL'];
  const params: unknown[] = [];
  
  if (opts.sessionFilter !== undefined) {
    filters.push('session_db_id = ?');
    params.push(opts.sessionFilter);
  }
  
  if (opts.excludeSessions && opts.excludeSessions.size > 0) {
    const placeholders = Array.from(opts.excludeSessions).map(() => '?').join(',');
    filters.push(`session_db_id NOT IN (${placeholders})`);
    params.push(...opts.excludeSessions);
  }
  
  if (opts.skippedSeqs && opts.skippedSeqs.size > 0) {
    const placeholders = Array.from(opts.skippedSeqs).map(() => '?').join(',');
    filters.push(`seq NOT IN (${placeholders})`);
    params.push(...opts.skippedSeqs);
  }
  
  const where = filters.join(' AND ');
  
  const item = db.prepare(`
    SELECT seq, kind, target_id, session_db_id FROM pending_queue
    WHERE ${where}
    ORDER BY seq ASC LIMIT 1
  `).get(...params) as QueueItem | undefined;
  
  if (!item) return null;
  
  const result = db.prepare(`
    UPDATE pending_queue SET claimed_at_epoch = ?
    WHERE seq = ? AND claimed_at_epoch IS NULL
  `).run(now(), item.seq);
  
  // 事务内 changes 必然 = 1，不等于 1 说明有并发 bug
  if (result.changes !== 1) {
    throw new Error(`unexpected claim race on seq=${item.seq}`);
  }
  return item;
});

// 唯一的队列消费入口
// sessionFilter 为空 = 消费所有 session（/wake 路径），同时排除 compactingSessions
// sessionFilter 非空 = 只消费特定 session（/compact 路径）
async function scanAndDrainQueue(sessionFilter?: number): Promise<void> {
  // 本次调用内失败的任务，跳过不再重试（避免无限循环）
  // 失败的任务 claimed_at_epoch 已重置为 NULL，下次 /wake 会重新尝试
  const skippedSeqs = new Set<number>();
  
  while (true) {
    const opts: ClaimOptions = {
      sessionFilter,
      skippedSeqs,
      // 全局扫描跳过 compacting session，让 /compact 独占 drain
      excludeSessions: sessionFilter === undefined ? compactingSessions : undefined,
    };
    
    const item = claimNextItem(opts);
    if (!item) return;  // 队列空或本次全部被 skip
    
    try {
      await processClaimedItem(item);
      // 成功：删除 queue 条目
      db.prepare(`DELETE FROM pending_queue WHERE seq = ?`).run(item.seq);
    } catch (error) {
      // 失败：重置 claim 让后续 drain/wake 重试
      db.prepare(`
        UPDATE pending_queue SET claimed_at_epoch = NULL WHERE seq = ?
      `).run(item.seq);
      skippedSeqs.add(item.seq);
      logger.error("queue item failed, skipping for this drain", { 
        seq: item.seq, 
        kind: item.kind, 
        target_id: item.target_id, 
        error,
      });
      // 不 throw —— 继续处理后续任务，保证 /compact 的完整性
    }
  }
}

async function processClaimedItem(item: QueueItem): Promise<void> {
  const state = getOrCreateSessionState(item.session_db_id);
  
  // 串行锁：同一 session 内任务严格串行
  const myTurn = state.processingLock;
  let release!: () => void;
  state.processingLock = new Promise(r => { release = r; });
  await myTurn;
  
  // per-item 软超时：防止一条坏任务卡死整个 session
  // obs 15s, turn-stop 30s（turn 提取需要看完上下文，更耗时）
  const timeoutMs = item.kind === "obs" ? 15_000 : 30_000;
  
  try {
    await withTimeout(
      item.kind === "obs"
        ? processObs(state, item.target_id)
        : processTurnStop(state, item.target_id),
      timeoutMs,
      `${item.kind} ${item.target_id} timeout after ${timeoutMs}ms`,
    );
  } catch (err) {
    logger.error("item processing failed or timed out", { 
      seq: item.seq, 
      kind: item.kind, 
      target_id: item.target_id, 
      err 
    });
    // 重新抛出，让 scanAndDrainQueue 重置 claim 或结束循环
    throw err;
  } finally {
    release();
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => 
      setTimeout(() => reject(new Error(message)), ms)
    ),
  ]);
}
```

**per-item 超时 vs 全局 abort 的区别**：
- mem 当前做法是全局 `abortController.abort()`，粒度太粗，一条坏 obs 会把整个 query session 干掉，丢掉整条对话史缓存
- mnemo 的 per-item 超时只影响当前任务，query session 本身不中止，下一个任务继续处理
- 超时后任务通过 `scanAndDrainQueue` 的错误处理被重置 `claimed_at_epoch=NULL`，但本次 drain 内跳过（`skippedSeqs`）不重试，由下次 `/wake` 触发重试
- 连续超时的条目可能最终堆积——可以后续加"超过 N 次重试就 mark skipped"的逻辑，v1 先不做

### 更新 lastPushAt / lastMessageAt

`processObs` / `processTurnStop` 必须正确维护这两个时间戳：

```typescript
async function processObs(state: SessionState, obsId: number): Promise<void> {
  const obs = getObservation(db, obsId);
  if (!obs) return;
  
  const prompt = buildCompactObsPrompt(obs);
  
  // 1. 推消息前更新 lastPushAt
  state.lastPushAt = Date.now();
  await state.pushMessage({
    type: "user",
    message: { role: "user", content: prompt },
    session_id: state.contentSessionId,
    parent_tool_use_id: null,
    isSynthetic: true,
  });
  
  // 2. 等 Mnemosyne 调 remember() 并完成本轮（由 query loop 里的消息处理函数更新 lastMessageAt）
  await waitForRememberCallForObs(state, obsId);
  
  // 3. 追加到 priorTitles
  const updated = getObservation(db, obsId);
  if (updated?.title) {
    state.priorTitles.push(`- ${updated.title}`);
  }
}
```

Query loop 里处理 Mnemosyne 响应时同步更新 `lastMessageAt`：

```typescript
for await (const message of state.query) {
  state.lastMessageAt = Date.now();
  // ... 处理 message ...
}
```

这样 watchdog 能精确区分"刚推了一条消息等响应"和"所有消息都响应完进入空闲"。

### 去重机制

`/wake` handler 是幂等的：多次并发调用不会并发执行多个 `scanAndDrainQueue`，但会标记"处理完当前扫描后再扫一轮"：

```typescript
let globalScanInFlight: Promise<void> | null = null;
let scanPending = false;

async function handleWake(): Promise<Response> {
  if (globalScanInFlight) {
    // 已有扫描在跑，标记"完成后再扫一轮"
    // 防止 drain 快结束时新到达的任务被漏掉
    scanPending = true;
    return new Response(null, { status: 200 });
  }
  
  globalScanInFlight = (async () => {
    do {
      scanPending = false;
      await scanAndDrainQueue();
    } while (scanPending);  // 扫描期间有新 /wake 请求到达 → 再扫一轮
  })().finally(() => {
    globalScanInFlight = null;
  });
  
  // 不 await，立即返回（fire-and-forget 语义）
  return new Response(null, { status: 200 });
}
```

**为什么需要 scanPending flag**：
- drain 的 while 循环退出后，`globalScanInFlight` 的 Promise 还没走完 `.finally`（微任务队列）
- 这个窗口内如果有新 hook INSERT 了 pending_queue 条目并发起 `/wake`
- 不做任何处理的话，这条任务会等到下一次 hook 触发 `/wake` 才被处理
- 实际延迟通常 < 1 秒（hook 触发频率很高），但 defense-in-depth 仍有价值

`/compact` handler 独立于全局扫描：

```typescript
const compactingSessions = new Set<number>();

async function handleCompact(req: Request): Promise<Response> {
  const { session_id, transcript_path } = await req.json();
  
  // 独占本 session 的 drain 权 —— 防止全局 /wake 扫描在 compact 期间
  // 认领本 session 的任务，导致 drainSessionCompletely 看不到 in-flight 的那条
  compactingSessions.add(session_id);
  
  try {
    // 1. sidechain 自动检测
    if (transcript_path) {
      markSidechainTurnsUndone(db, session_id, transcript_path);
      cleanupUndoneTurnTasks(db, session_id);
    }
    
    // 2. 完整 drain（含 in-flight 等待 + 稳态检查）
    try {
      await drainSessionCompletely(session_id);
    } catch (err) {
      logger.error("drainSessionCompletely failed during compact", { session_id, err });
      // 继续往下走
    }
    
    // 3. 最终 session summary
    try {
      await pushSessionSummaryPrompt(session_id);
    } catch (err) {
      logger.error("session summary push failed", { session_id, err });
    }
    
    return new Response(null, { status: 200 });
  } finally {
    compactingSessions.delete(session_id);
    
    // 4. 无论成功失败都要关闭 query session（释放子进程）
    await closeSessionQuery(session_id).catch(err => {
      logger.error("closeSessionQuery failed", { session_id, err });
    });
  }
}

/**
 * 完整 drain 一个 session 的队列。保证返回后：
 * 1. pending_queue 里该 session 无剩余条目（无论 claimed 还是未 claimed），或
 * 2. 剩余条目全部是持续失败的"毒丸"（本次 compact 放弃处理）
 * 
 * 这个函数处理 race：
 * - /wake 全局扫描可能在 compact 启动前已 claim 本 session 的任务
 * - 这些 in-flight 任务通过 processingLock 排队
 * - 我们需要等它们全部完成 + 可能释放回 pending 的条目也处理完
 * 
 * 无进展保护：如果一轮下来 pending 数量没变，说明剩余任务都是持续失败的（scanAndDrainQueue 里的
 * skippedSeqs 是 per-call 的，跨轮重置，所以持续失败的任务会被反复 claim-fail-skip）。
 * 这种情况下直接放弃本次 drain，避免无限循环卡死 /compact 的 25 秒预算。
 */
async function drainSessionCompletely(sessionDbId: number): Promise<void> {
  let prevCount = Number.POSITIVE_INFINITY;
  
  while (true) {
    // 1. 处理所有未 claimed 的本 session 任务
    await scanAndDrainQueue(sessionDbId);
    
    // 2. 等 processingLock 达到稳态
    // processingLock 是链式 Promise，每个新任务会替换它
    // "稳态" = await 之后链没有前进（没有新任务在排队）
    const state = sessions.get(sessionDbId);
    if (state) {
      while (true) {
        const lockBefore = state.processingLock;
        await lockBefore;
        if (lockBefore === state.processingLock) break;
        // 有新任务 push 到 lock 链上，继续等
      }
    }
    
    // 3. 检查队列是否真的空
    const remaining = (db.prepare(`
      SELECT COUNT(*) as c FROM pending_queue WHERE session_db_id = ?
    `).get(sessionDbId) as { c: number }).c;
    
    if (remaining === 0) return;
    
    // 4. 无进展保护：本轮没减少 pending 数 → 剩下的是持续失败的任务 → 放弃
    if (remaining >= prevCount) {
      logger.warn("drainSessionCompletely: no progress, giving up", {
        sessionDbId,
        remaining,
      });
      return;
    }
    prevCount = remaining;
  }
}
```

`scanAndDrainQueue(session_id)` 和全局 `scanAndDrainQueue()` 可能并发运行：
- 两者都通过 `claimNextItem()` 获取下一个任务
- `claimNextItem` 是原子的，每条 row 只会被一个 caller 成功 claim
- 没 claim 到的 caller 继续循环或返回空
- 同一 session 的任务仍通过 `processingLock` 串行

### 串行约束

- **同一 session 内 obs 和 turn-stop 处理严格串行**：通过 `processingLock` 链式 Promise 实现
- **不同 session 并发**：每个 session 有独立的 query() 子进程和 lock
- **扫描循环幂等**：多次 `/wake` 唤醒只会触发一次实际扫描

### 崩溃恢复

Worker 重启时的恢复逻辑由 `pending_queue` 单表驱动：

```sql
-- 1. 重置所有 claimed 但未完成的任务
UPDATE pending_queue SET claimed_at_epoch=NULL WHERE claimed_at_epoch IS NOT NULL;

-- 2. 按 seq 序扫描（AUTOINCREMENT 保证 FIFO）
SELECT pq.seq, pq.kind, pq.target_id, pq.session_db_id, s.content_session_id
FROM pending_queue pq
  JOIN sessions s ON pq.session_db_id = s.id
WHERE pq.claimed_at_epoch IS NULL
ORDER BY pq.seq ASC;
```

**关键不变式**：`/wake` 返回（以及 hook 返回）之前，对应的 `pending_queue` 行必须已通过事务提交。这由 hook 层的事务保证。Worker 崩溃不会丢任务，原始 FIFO 顺序通过 seq 单调序列精确恢复。

---

## Mnemosyne 会话管理

### query() 会话生命周期

```
第一个 PostToolUse 到达
  → worker 创建 SessionState
  → 开启 query()，注入 init prompt + 第一个 obs（合并在首条消息里）
  → pushQueue 模式：后续消息通过 async generator yield

后续 PostToolUse
  → push 一条 obs 消息到 queue
  → query() 的 generator yield 出去
  → Mnemosyne 回复 remember() 调用
  → worker 更新 obs 表 + 追加到 priorTitles

每个 Stop (turn 结束)
  → 等待该 turn 的 pending obs 处理完
  → push 一条 turn 提取 prompt（只针对刚结束的这一个 turn）
  → Mnemosyne 回复 remember({ id: "T{n}", ... })
  → LLM 自行判断是否需要同时更新 session
  → query() 不关闭，继续接收下一个 turn 的 obs

PreCompact
  → 消费该 session 在 pending_queue 里的所有剩余任务
  → push 最终 session summary 提取 prompt
  → 关闭当前 query()
  → 清空 priorTitles
  → 下次 obs 来时用带摘要的新 init prompt 开新 query

硬阈值（cumulativeTokens > 150k）
  → 强制执行一次 PreCompact 同款流程
```

### 初始化消息（首条用户消息）

```
<system>
  你是 Mnemosyne，观察 Claude Code 会话的记忆 agent。
  
  你的工具：
  - remember(id, title, content, ...) 写入记录
  - recall(query) 查询已有记忆（仅限 Stop 阶段）
  - replay(id) 获取完整工具调用详情（仅当 obs 截断导致无法理解时）
  
  你将通过 <obs> 标签接收工具调用，通过 <turn>/<session> 标签接收 turn 和 session 提取请求。
</system>

<session id="S{id}">
  project: {cwd}
  user_request: {first user prompt}
</session>

<obs id="O{id}">
  🔧 {tool_name}
  in: {truncated input}
  out: {truncated output}
</obs>
```

Mnemosyne 回复：

```
remember({ id: "O42", title: "读取 auth 模块", content: "查看 token refresh 函数" })
```

### 增量 obs 消息

后续 obs 消息只带工具调用内容，**不重复 instruction**。规则已经在初始化消息里声明过了，Mnemosyne 会记住。

```
<obs id="O43">
  🔧 Grep "token" in src/
  in: {"pattern":"token","path":"src/"}
  out: "12 matches..."
</obs>
```

规则写在初始化消息的 system prompt 里：

```
obs 提取规则（每次 <obs> 消息都按此处理）：
- 只调用 remember({ id: "O{n}", title, content })
- 不要调用 recall() 或 replay()
- 如果工具调用不值得记录（例如重复的 Read），调用 remember({ id: "O{n}", status: "skipped" })
```

这样 250 次 obs 只需要在第一条消息声明一次规则，后续每条只有 ~100 tokens 工具调用数据，节省 ~25k tokens 上下文预算。

### Stop 提取消息（单个 turn）

每次 Stop 触发时，worker push 一条消息，只针对刚结束的那个 turn：

```
<turn id="T5">
  prompt: "修复 auth 竞态条件...
           [...truncated...]
           ...不影响登录流程"
  response: "已修复，加了 mutex...
             [...truncated...]
             ...测试通过"
</turn>

<session id="S1">
  project: /Users/.../claude-mnemo
  prior_title: "worker 架构设计"
  prior_content: "讨论了 worker 方案，正在敲定 schema..."
  prior_insight: ["..."]
  prior_next_steps: "写 spec"
</session>

<instruction>
  提取这个 turn，调用 remember({ id: "T5", title, content, insight, type, tags })。
  如果这个 turn 带来了实质变化（重大实现/发现/决策），同时调用 remember({ id: "S1", ... }) 更新 session。
  如果只是微小进展或过程性工作，不要更新 session。
  
  你现在可以调用 recall(query) 查已有 memories 避免重复创建 —— 但只在确实要创建 memory 时才查。
  replay() 仅在工具调用上下文被严重截断导致无法理解时使用，99% 的 turn 不需要。
</instruction>
```

注意：prompt 里不写 `status="..."`。turn 的业务状态（active/extracted/skipped/undone）对 LLM 没有意义——LLM 看到这条消息意味着 worker 已经从 `pending_queue` 里把它作为 turn-stop task 取出来让 LLM 处理。

**工具 gating 约束**：通过 prompt 里的 `<instruction>` 软约束 —— obs 阶段禁止 recall/replay，turn 阶段允许 recall、限制 replay。不在 MCP server 层面做动态开关（复杂度太高），依赖 LLM 遵循 instruction。

Mnemosyne 回复：

```
remember({ id: "T5", title: "修复 auth 竞态", content: "...", type: "bugfix", tags: ["concurrency"], insight: "..." })
```

或带 session 更新：

```
remember({ id: "T5", ... })
remember({ id: "S1", title: "worker 架构设计 → 首个实现", content: "...", next_steps: "..." })
```

### PreCompact 流程

PreCompact 通过 `handleCompact(sessionDbId)` 实现（代码见上文"全局扫描循环"章节）。流程：

1. **sidechain 自动检测**（数据源驱动，不经过 LLM）：扫 transcript 找到 sidechain 撤销的 turns，UPDATE `turns.status='undone'`，并删除对应的 `pending_queue` 条目
2. **复用 `scanAndDrainQueue(sessionDbId)`** 消费该 session 所有剩余任务
   - 每个 obs 任务走正常的 obs 提取
   - 每个 turn-stop 任务走正常的 turn 提取（和 Stop hook 触发时一模一样的路径）
3. **Push 最终 session summary prompt**（只含 `<session>` 标签）
4. **关闭 query session**，清空 priorTitles

**关键**：PreCompact 不做"批量 turns"的特殊 prompt。每个 turn 都通过 `pending_queue` 里的 turn-stop 任务被独立处理，和 Stop hook 触发时走同一代码路径。PreCompact 唯一特殊的是最后那条 session summary prompt。

### Session 更新策略

- **默认不更新**：LLM 自己判断是否有重大变化
- **Prior state 注入**：构造 prompt 时把当前 session 状态作为 `<prior_*>` 放进去
- **长度约束**：在 prompt 里明确指导
  - `title`: 20-50 字
  - `content`: 100-300 字
  - `insight`: 2-5 条 bullet，每条 ≤50 字
  - `next_steps`: 50-150 字
  - 总长度 <500 字
  - 不涉及文件/代码/工具调用细节

---

## 上下文管理

### Obs 消息压缩

每条 obs 消息只放摘要，不放完整 tool_input / tool_result：

```typescript
function buildCompactObsPrompt(obs: ObsRecord): string {
  const input = truncateMiddle(obs.toolInput, 500);
  const result = truncateMiddle(obs.toolResult, 500);
  return `<obs id="O${obs.id}">
  🔧 ${obs.toolName}
  in: ${input}
  out: ${result}
</obs>`;
}

function truncateMiddle(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const keep = Math.floor((limit - 20) / 2);
  return text.slice(0, keep) + 
         `\n[...${text.length - keep * 2} chars truncated...]\n` + 
         text.slice(-keep);
}
```

### Turn 消息压缩

Stop/PreCompact 时的 turn 提取 prompt **只包含 user_prompt 和 assistant_response**（中间截断），不重复注入 obs 信息——因为 obs 已经在对话上下文里了。

```typescript
function buildTurnExtractionPrompt(turn: TurnRecord): string {
  return `<turn id="T${turn.id}" status="${turn.status}">
  prompt: ${truncateMiddle(turn.userPrompt, 1000)}
  response: ${truncateMiddle(turn.assistantResponse, 1000)}
</turn>`;
}
```

### 上下文增长估算

单次 obs round trip（push + response）：
- 用户消息：~100 tokens（压缩后的 tool call）
- 助手消息：~60 tokens（remember tool_use + result）
- 合计：**~160 tokens / obs**

单次 turn 提取（每个 Stop）：
- 用户消息：~400 tokens（prompt + response 截断 + session prior + instruction）
- 助手消息：~200 tokens（1-2 个 remember tool_use + results）
- 合计：**~600 tokens / turn**

典型 session（50 turns，每 turn 平均 5 obs）：
- 250 obs × 160 = 40k tokens
- 50 turns × 600 = 30k tokens
- 系统 prompt + 初始化：~2k tokens
- **总计：~72k tokens**

远低于 200k 窗口。主 Agent 通常在这个长度之前已经 compact 了，query 会被重置一次，实际单个 query 很少超过 50k。

### 上下文重置时机

1. **PreCompact**：主 Agent 要 compact 了，worker flush 残留 pending + 关闭 query，下次 obs 来时用带摘要的 init prompt 开新 query
2. **硬阈值**：`cumulativeTokens > 150k` 强制执行 PreCompact 同款流程
3. **Stop 不重置 query**：每次 Stop 只是 push 一条 turn 提取消息到同一个 query，不关闭 session

### query 重置后的延续

新 query 的 init prompt 里注入：

```
<prior_session>
  已经处理过 {N} 条 obs 和 {M} 个 turns。
  
  Session 当前状态（来自上次提取）:
  title: {sessionState.title}
  content: {sessionState.content}
  insight: {sessionState.insight}
  
  继续观察后续工具调用。
</prior_session>
```

priorTitles 不注入——它们属于上一个 query 会话，已经被写入 DB 了。新 query 从干净状态开始累积。

---

## Hook 改动

### UserPromptSubmit

**不改动**。只负责 DB 写入，不通知 worker：

```typescript
// 现有逻辑完全保留
upsertSession(...)
createPendingTurn(...)
// 不调用 worker
```

Worker 需要 turn_id 时从 DB 按 `session_id` 查最新 turn。

### PostToolUse（新增）

```typescript
// 在 hooks.json 注册
{
  "PostToolUse": [{
    "matcher": "*",
    "hooks": [{
      "type": "command",
      "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/bun-runner.js ${CLAUDE_PLUGIN_ROOT}/scripts/hook-command.cjs post-tool-use",
      "timeout": 5
    }]
  }]
}
```

Handler 逻辑：

```typescript
export function createPostToolUseHandler(deps: { db: Database }) {
  return async function handle(input: NormalizedHookInput): Promise<HookResult> {
    if (!input.sessionId || !input.toolName) return { continue: true };
    
    const session = getSessionByContentId(deps.db, input.sessionId);
    if (!session) return { continue: true };
    
    const latestTurn = getLatestTurnForSession(deps.db, session.id);
    if (!latestTurn) return { continue: true };
    
    const toolInput = stripPrivateTags(JSON.stringify(input.toolInput));
    const toolResult = stripPrivateTags(stringifyToolResult(input.toolResponse));
    const now = Math.floor(Date.now() / 1000);
    
    // 事务：INSERT obs + INSERT pending_queue
    deps.db.transaction(() => {
      const obsId = insertObservation(deps.db, {
        turnId: latestTurn.id,
        toolName: input.toolName,
        toolInput,
        toolResult,
        status: "pending",
        createdAtEpoch: now,
      });
      deps.db.exec(`
        INSERT INTO pending_queue (kind, target_id, session_db_id, enqueued_at_epoch)
        VALUES ('obs', ?, ?, ?)
      `, [obsId, session.id, now]);
    })();
    
    // 唤醒 worker（fire-and-forget）
    await notifyWorkerWake();
    
    return { continue: true };
  };
}
```

### Stop

Stop hook 在每个 turn 结束时触发。只处理**当前刚结束的那个 turn**：

```typescript
const session = getSessionByContentId(db, input.sessionId);
if (!session) return { continue: true };

const latestTurn = getLatestTurnForSession(db, session.id);
if (!latestTurn) return { continue: true };

const now = Math.floor(Date.now() / 1000);
const cleanedResponse = stripPrivateTags(input.lastAssistantMessage ?? "");

// 事务：UPDATE turn + INSERT pending_queue
db.transaction(() => {
  db.exec(`
    UPDATE turns SET assistant_response=?, updated_at_epoch=? WHERE id=?
  `, [cleanedResponse, now, latestTurn.id]);
  db.exec(`
    INSERT INTO pending_queue (kind, target_id, session_db_id, enqueued_at_epoch)
    VALUES ('turn-stop', ?, ?, ?)
  `, [latestTurn.id, session.id, now]);
})();

// 唤醒 worker（fire-and-forget）
await notifyWorkerWake();

return { continue: true, exitCode: HOOK_SUCCESS_EXIT_CODE };
```

关键保证：
- **事务 + pending_queue 是崩溃恢复的唯一依据**。即使 worker 永远不来，下次启动会扫到这条 queue 条目
- **pending_queue.seq 保证 FIFO**：obs 和 turn-stop 在同一秒写入也能正确排序

### PreCompact

**同步等待** worker 完成 flush。这是唯一需要同步的 hook：

```typescript
// 删除 forkMnemosyne() 调用和 updateCompactAnchor
const session = getSessionByContentId(db, input.sessionId);
if (!session) return { continue: true };

try {
  await fetch("http://localhost:37778/compact", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ 
      session_id: session.id, 
      transcript_path: input.transcriptPath 
    }),
    signal: AbortSignal.timeout(25000),  // 留 5 秒给 hook 总 30 秒 timeout
  });
} catch (error) {
  // 超时或 worker 不可达 —— 放行 compact，接受 session summary 落后一个 cycle
  // 此时 turn 级数据仍然正确（pending_queue 条目会被下次 worker 扫到）
  logger.warn("compact flush timeout or unreachable, continuing", error);
}

return { continue: true };
```

PreCompact hook 在 `hooks.json` 的 timeout 保持 30 秒。Worker 的 25 秒预算是硬上限，不要超过。

### Worker 不可达时的退化行为

**`/wake`**（fire-and-forget）：
- 数据已经在 `pending_queue` 里，POST 只是加速处理的信号
- 失败就 spawn worker 一次，不等待，不重试
- 下次 hook 触发时 worker 已经在跑了

```typescript
async function notifyWorkerWake(): Promise<void> {
  try {
    await fetch("http://localhost:37778/wake", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(500),   // 数据已落 DB，wake 只是信号，等不起 2 秒
    });
  } catch {
    spawnWorker();  // 不等待，不重试
  }
}
```

**为什么 500ms 而不是 2000ms**：数据已经通过 hook 事务写入 `pending_queue`，`/wake` 只是加速处理的信号，延迟唤醒不影响正确性。PostToolUse hook 的总 timeout 是 5 秒，要留时间给 DB 事务（hook 事务在 worker busy 时可能卡 1-2 秒）、tag stripping、JSON 序列化等工作。`/wake` 等不起 2 秒。

**`/compact`**（同步）：
- 失败即放行，接受 session summary 落后一个 cycle
- 不 spawn worker（太晚了，compact 立刻要发生）
- Turn 级数据仍正确（`pending_queue` 里有条目，下次 worker 启动会处理）

不引入 inline fallback extraction。

---

## 文件路径聚合

Stop/PreCompact 时，worker 聚合每个 turn 的 files_read / files_modified：

```typescript
function aggregateFiles(db: Database, turnId: number): {
  filesRead: string[];
  filesModified: string[];
} {
  const obs = getObservationsForTurn(db, turnId);
  const read = new Set<string>();
  const modified = new Set<string>();
  
  for (const o of obs) {
    const input = safeJsonParse(o.toolInput);
    if (!input) continue;
    
    switch (o.toolName) {
      case "Read":
      case "Glob":
        if (input.file_path) read.add(input.file_path);
        break;
      case "Edit":
      case "Write":
        if (input.file_path) modified.add(input.file_path);
        break;
      case "Grep":
        if (input.path) read.add(input.path);
        break;
      case "Bash":
        // 正则提取路径（可选，v1 先不做）
        break;
    }
  }
  
  return { filesRead: [...read], filesModified: [...modified] };
}
```

写入 `turns.files_read` / `files_modified` 后，LLM 不需要再填这两个字段。

---

## Sidechain Undone 自动处理

Worker 在 `handleCompact()` 中从 transcript 检测 sidechain 撤销，直接更新 `turns.status='undone'` 并删除对应的 `pending_queue` 条目：

```typescript
function markSidechainTurnsUndone(
  db: Database,
  sessionDbId: number,
  transcriptPath: string,
): void {
  const stalePromptNumbers = detectSidechainPromptNumbers(db, sessionDbId, transcriptPath);
  if (stalePromptNumbers.length === 0) return;
  
  const placeholders = stalePromptNumbers.map(() => '?').join(',');
  db.prepare(`
    UPDATE turns SET status = 'undone'
    WHERE session_id = ? AND prompt_number IN (${placeholders})
  `).run(sessionDbId, ...stalePromptNumbers);
}

function cleanupUndoneTurnTasks(db: Database, sessionDbId: number): void {
  // 已被标记为 undone 的 turn，对应的 turn-stop 任务从队列里删除
  // 因为没必要让 LLM 处理一个已撤销的 turn
  db.prepare(`
    DELETE FROM pending_queue
    WHERE session_db_id = ? AND kind = 'turn-stop'
      AND target_id IN (
        SELECT id FROM turns 
        WHERE session_id = ? AND status = 'undone'
      )
  `).run(sessionDbId, sessionDbId);
}
```

调用时机在 `handleCompact()` 的第一步（见上一节 PreCompact 流程）。Stop hook 触发的单 turn 提取不做 sidechain 检测——sidechain 撤销只有在用户回撤之后才能被识别，而回撤后续的操作会产生新的 Stop 事件。用 PreCompact 统一处理足够。

---

## MCP 工具作用域决策

Mnemosyne 访问的 3 个 MCP 工具，保留/限制决策：

| 工具 | 决策 | 原因 |
|---|---|---|
| `remember` | 保留，所有阶段可用 | 核心写入工具 |
| `recall` | 保留，**仅 turn/session 提取阶段允许** | 用于 memory 去重查询 |
| `replay` | 保留，**仅作为截断信息的 fallback** | 99% 的 obs 不需要，但遇到极长 tool_result 被中间截断时有用 |

**不做动态 setMcpServers()** —— 通过 prompt 软约束。obs 消息的 `<instruction>` 明确写"不要调用 recall/replay"，turn 消息的 `<instruction>` 明确写"可以 recall，非必要不 replay"。

---

## 模型与认证

- **模型**：`claude-sonnet-4-6`（Agent SDK query() 的默认路径）
- **认证**：Claude Code 订阅额度（`query()` 自动使用）
- **不引入**：Messages API / Haiku / 单独的 API key
- 所有 Mnemosyne 推理走同一条路径，最小化认证复杂度

---

## 删除的代码和字段

### 代码

- **`src/mnemosyne/fork.ts` 全删** —— 不"移入"不"改写"。它的范式是"session 结束一次性跑完就销毁"，跟新的"长生命周期 query + 流水线 yield"范式完全不兼容。Worker 里的 query 管理代码从零写，复用 `resolveClaudeCodeExecutablePath` / `createMnemoSdkServer` 这两个小工具函数就够了
- **`src/mnemosyne/context.ts` 全删** —— `buildExtractionContext` 是为批量提取设计的，新架构里 prompt 构造是增量 yield，没有"一次性构造整个 context"的需求
- **`src/mnemosyne/prompt.ts` 全删** —— `buildMnemosynePrompt` 同理，worker 里有新的 prompt builders（init / obs / turn-stop / session-summary）
- `src/hooks/handlers/stop.ts` 精简至只剩 backfill + 事务写入 + POST
- `src/hooks/handlers/compact.ts` 精简至只剩 POST
- `src/hooks/backfill.ts` 精简，只保留 assistant_response backfill（删掉 user_prompt 补齐，新架构里 UserPromptSubmit 已经写了）
- `src/db/turns.ts` 的 `claimTurnsForExtraction` / `recoverStalledExtractions` 全删（队列逻辑现在在 `pending_queue` 表 + worker 里）
- `src/mcp/remember.ts` 删除 parent 路由和相关代码
- `src/mcp/definitions.ts` 的 `rememberInputShape` 删除 5 个参数

### Schema 字段

- `turns.description`
- `observations`: 几乎全部旧字段 DROP + CREATE
- `sessions.description`

### Hooks 配置

- `hooks.json` 新增 PostToolUse matcher
- 其他保持结构不变，handler 内部行为改变

---

## 实施顺序

1. **Schema 重建** —— DROP obs + CREATE 新 schema，新增 pending_queue 表，turns 加字段，sessions 删字段。所有 DB 连接接入 WAL + busy_timeout 初始化函数
2. **Hook 侧事务写入** —— PostToolUse 和 Stop 的事务逻辑（INSERT obs/UPDATE turn + INSERT pending_queue），不依赖 worker 先跑通
3. **Worker 骨架** —— Bun.serve + singleton acquire（PID + port + starting marker）+ graceful shutdown + pid 文件清理
4. **扫描循环和并发原语** —— `claimNextItem` / `scanAndDrainQueue` / `drainSessionCompletely` / `compactingSessions` 集合 / `processingLock`，先用 mock processObs 验证并发正确性（模拟慢任务 + 失败任务）
5. **remember() 重设计** —— 支持 O/T/S/M 前缀路由，废弃 parent
6. **query() 生命周期管理先于接入** —— `queryPid` 捕获、`closeSessionQuery` 契约、watchdog 空转验证（不接真实 query，用 mock 验证不会误杀空闲 session）
7. **Worker 接入真实 query()** —— 单 session 跑通：扫 queue → push obs → yield → remember → DELETE queue。验证 `lastPushAt`/`lastMessageAt` 维护正确
8. **Hook 通过 bun-runner.js spawn worker** —— 实现 `notifyWorkerWake` + spawn 回退 + 500ms timeout
9. **Sidechain 自动处理** —— worker 内部检测 + `cleanupUndoneTurnTasks`
10. **PreCompact 同步 flush** —— `handleCompact` + `drainSessionCompletely` + try/finally 兜底 + session summary push
11. **文件路径聚合** —— Stop 时（或 PreCompact 时）从 obs 聚合到 turns.files_read/files_modified
12. **Backfill 精简** —— 删掉 user_prompt 补齐，保留 assistant_response
13. **崩溃恢复演练** —— kill -9 worker + 重启，验证 pending_queue 被正确恢复，无任务丢失/重复

**关键并发测试用例**（第 4 和第 10 步必做）：
- 场景 1：同 session 10 条 obs，第 3 条处理超时 → 验证 4~10 继续处理，3 被 skipped
- 场景 2：/wake 处理中 A1 时 /compact 到达 → 验证 `drainSessionCompletely` 等 A1 完成后才 push summary
- 场景 3：PostToolUse 高频触发（~10/s）+ 空闲检查 → 验证 watchdog 不杀活跃 session
- 场景 4：session 处理完一批 obs 后闲置 2 分钟 → 验证 watchdog 不杀空闲 session
- 场景 5：/compact 时某条 obs 持续失败（mock processObs 永远抛）→ 验证 `drainSessionCompletely` 在无进展时有限轮次内退出，不会卡死 hook 的 25 秒预算
- 场景 6：`/wake` drain 快结束时（微任务队列内）新 POST `/wake` 到达 → 验证 scanPending flag 触发二次扫描，不丢任务

每一步都是可独立验证的小步骤。

---

## Status 转换原则

**Worker 只在有数据源依据时改 status，语义判断全部交给 LLM**。

### 业务状态机

业务表只保留必要状态——初始态 + 终态，处理中状态不在业务表里：

```
turn:  active (初始) → extracted / skipped / undone (终态)
obs:   pending (初始) → extracted / skipped (终态)
```

"正在排队等处理"和"worker 正在处理" 这两个中间态**不在业务表里**，而是由 `pending_queue` 表表达：
- `pending_queue` 里有该行 + `claimed_at_epoch IS NULL` → 等待处理
- `pending_queue` 里有该行 + `claimed_at_epoch IS NOT NULL` → worker 正在处理
- `pending_queue` 里没有该行 → 已完成（业务 status 是 extracted/skipped/undone）

### 状态变更责任

| 变更 | 触发方 | 时机 |
|---|---|---|
| obs 创建 + enqueue | **Hook**（事务） | PostToolUse |
| turn update + enqueue | **Hook**（事务） | Stop |
| `pending_queue.claimed_at_epoch` 设值 | Worker | 开始处理前 |
| obs/turn 终态（extracted/skipped） | LLM | 调用 remember() |
| `pending_queue` 行删除 | Worker | 处理完成后 |
| `pending_queue.claimed_at_epoch` 清空 | Worker | 崩溃恢复 |
| turn: `active` → `undone` | Worker | sidechain 检测 |

### 关键保证：崩溃安全

**Hook 层的事务是持久化的起点**。PostToolUse 和 Stop 在 POST `/wake` 之前必须完成原子事务：

```typescript
// PostToolUse hook
db.transaction(() => {
  const obsId = insertObservation(db, {
    turnId, toolName, toolInput, toolResult,
    status: "pending",
    createdAtEpoch: now,
  });
  db.exec(`
    INSERT INTO pending_queue (kind, target_id, session_db_id, enqueued_at_epoch)
    VALUES ('obs', ?, ?, ?)
  `, [obsId, sessionDbId, now]);
})();

// POST /wake (fire-and-forget)
// 即使 POST 失败或 worker 崩溃，pending_queue 里已有条目，下次启动会处理
```

```typescript
// Stop hook
db.transaction(() => {
  db.exec(`
    UPDATE turns SET assistant_response=?, updated_at_epoch=? WHERE id=?
  `, [stripPrivateTags(lastAssistantMessage), now, turnId]);
  db.exec(`
    INSERT INTO pending_queue (kind, target_id, session_db_id, enqueued_at_epoch)
    VALUES ('turn-stop', ?, ?, ?)
  `, [turnId, sessionDbId, now]);
})();

// POST /wake (fire-and-forget)
```

### 崩溃恢复

```sql
-- 重置所有 claimed 但未完成的任务
UPDATE pending_queue SET claimed_at_epoch=NULL WHERE claimed_at_epoch IS NOT NULL;

-- 按 seq 序扫描未处理任务（FIFO 保证）
SELECT seq, kind, target_id, session_db_id
FROM pending_queue
WHERE claimed_at_epoch IS NULL
ORDER BY seq ASC;
```

不需要跨表合并排序。`pending_queue.seq` 是单调递增的全序键，完全消除了"同一秒内 obs 和 turn-stop 谁先谁后"的歧义。

Worker 按 seq 顺序处理每个任务，按 session_db_id 路由到对应的 SessionState。同 session 的任务天然保持 FIFO，不同 session 可并行。

### Worker 不做以下判断

- "这个 turn 看起来没内容，跳过吧" → 让 LLM 看完再决定
- "这个 obs 工具不重要，跳过吧" → LLM 判断
- "这个 session 没必要更新" → LLM 判断

Worker 唯一的自动状态变更是 sidechain 撤销（`turn.status='undone'`），因为这是 transcript 数据源客观决定的。

---

## 边界情况处理

### 用户中断（Esc / Ctrl+C）

Stop hook 会正常触发，`lastAssistantMessage` 是已生成的部分文本。视为 turn 的合法结束，按正常流程提取。

### 空 turn（没有工具调用 + 响应极短）

用户发消息后立即 Esc，没有任何 PostToolUse，assistant_response 可能为空。

**处理：仍然推给 Mnemosyne 处理，让 LLM 判断是否 skipped**。Worker 不做语义判断，只是在 prompt 里加一个 `<note>` 提示：

```
<turn id="T5">
  prompt: "用户的问题"
  response: ""
  <note>这个 turn 没有工具调用，响应为空（可能用户中断或仅对话）</note>
</turn>
```

Mnemosyne 通常返回 `remember({ id: "T5", status: "skipped" })`，但如果用户的 prompt 本身有价值（比如提出了重要决策），LLM 仍可能提取。

**原则**：status 由 LLM 决定，worker 不越权。

### 孤儿 turn（Stop 未触发）

硬杀进程、终端关闭等情况下 Stop 不触发，turn 留在 `status='active'` 且 `assistant_response IS NULL` 的半状态，且 `pending_queue` 里没有对应的 turn-stop 任务（因为 Stop hook 从未执行事务）。

处理：**下次 Stop 或 PreCompact 触发时，worker 扫描该 session 的孤儿 turns**，补写 assistant_response 并手动 enqueue：

```typescript
function recoverOrphanTurns(
  db: Database,
  sessionDbId: number,
  currentTurnId: number,
  transcriptPath: string | undefined,
): void {
  const orphans = db.prepare(`
    SELECT t.id, t.prompt_number FROM turns t
    WHERE t.session_id = ?
      AND t.status = 'active'
      AND t.id < ?
      AND t.assistant_response IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM pending_queue q
        WHERE q.kind = 'turn-stop' AND q.target_id = t.id
      )
  `).all(sessionDbId, currentTurnId) as { id: number, prompt_number: number }[];
  
  for (const orphan of orphans) {
    const response = transcriptPath
      ? extractAssistantResponseFromTranscript(transcriptPath, orphan.prompt_number)
      : null;
    
    db.transaction(() => {
      db.prepare(`
        UPDATE turns SET assistant_response = ?, updated_at_epoch = ? WHERE id = ?
      `).run(response ?? "", now(), orphan.id);
      db.prepare(`
        INSERT INTO pending_queue (kind, target_id, session_db_id, enqueued_at_epoch)
        VALUES ('turn-stop', ?, ?, ?)
      `).run(orphan.id, sessionDbId, now());
    })();
  }
}
```

孤儿检测的依据是：
- `turns.status = 'active'`（从未进入终态）
- `assistant_response IS NULL`（从未被 Stop hook 更新）
- **且** `pending_queue` 里没有对应的 turn-stop 任务（否则只是还没处理完，不是孤儿）

### Worker 处理中途 Stop 触发

依赖 `pending_queue.seq` 的天然 FIFO：obs 任务先 enqueue，turn-stop 任务后 enqueue，worker 按 seq 顺序处理。不需要额外同步。

### Worker 崩溃 + 部分任务处理完

Worker 重启后：
- `UPDATE pending_queue SET claimed_at_epoch = NULL WHERE claimed_at_epoch IS NOT NULL` 重置所有已认领但未完成的任务
- 按 seq 序重新消费
- 已成功处理的任务已从 `pending_queue` DELETE，不会重复处理
- 已 `extracted` 的 obs/turn 本体状态已是终态，与队列是否存在无关

---

## 已知特性（非阻塞）

- **query() 子进程启动延迟** —— 冷启动 ~2-5 秒（Claude Code 子进程 + Agent SDK 握手）。因为 PostToolUse 是异步的，主 Agent 看不到这个延迟，只影响 "obs 在 DB 里何时变成 extracted"。可接受。

## 风险与未决

- **Agent SDK 版本依赖** —— `query()` 的 `AsyncIterable` 消息推入模式、`spawnClaudeCodeProcess` 回调在 SDK 更新时可能有 breaking change。需锁定 Agent SDK 版本
- **Windows 兼容** —— `spawn detached` + `unref` + PID 探活在 Windows 上的行为需验证。`process.kill(pid, 0)` 在 Windows 上的语义和 Linux/macOS 有差异
- **硬阈值选值** —— 150k tokens 是经验值，需要真实数据校准
- **PostToolUse hook 的 timeout** —— 5 秒 budget 包含：stripPrivateTags + DB 事务 + fetch（500ms）+ 首次 spawnWorker 失败后的 fire-and-forget。大部分场景充裕，但 worker 繁忙时 DB 事务可能占 1-2 秒，极端情况下可能触发超时
- **Subagent PostToolUse 冒泡** —— 当主 Agent 调用 Task 工具启动 subagent 时，subagent 内部的 PostToolUse 事件是否冒泡到主 session 的 hooks 未验证。如果冒泡，obs 会关联到错误的 turn；如果不冒泡，subagent 的工具使用完全丢失。需要实测
- **前 N 条 obs 重试堆积** —— per-item 超时后重置 claim，但如果 LLM 连续对同一条 obs 超时（例如 Mnemosyne 被一个特殊的 tool_result 拖死），会无限重试。v1 不做重试限制，观察后再加"超过 N 次就 mark skipped"
