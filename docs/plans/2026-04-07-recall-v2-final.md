# Recall V2 + SessionStart 统一设计

## 动机

当前 recall 有 13 个参数，职责混杂。`buildExtractionContext`（Mnemosyne）和 `formatPrimarySession`（SessionStart）各自维护独立的渲染逻辑，与 recall 大量重复。

V2 目标：**三个消费者（recall MCP tool、Mnemosyne、SessionStart）共用同一个 `recallMemory()` 函数和同一套渲染格式**，消除独立渲染层。

## Recall V2 参数

```typescript
interface RecallInput {
  scope: "sessions" | "turns" | "observations";  // 必填，展示层级
  session?: number | number[] | string;   // session 选择器
  turn?: number | number[] | string;      // turn 选择器（prompt_number）
  obs?: number | number[] | string;       // observation 选择器（全局 DB id）
  query?: string;         // 全文搜索
  type?: string;          // observation 类型过滤
  file?: string;          // 文件过滤
  after?: number;         // epoch 下限
  before?: number;        // epoch 上限
  time?: string;          // 日期语法糖
  depth?: "collapsed" | "expanded" | "full";  // 子级渲染深度
}
```

### `scope`（必填）

展示粒度——每条结果是一个 session、一个 turn 还是一个 observation。

选中的实体本身始终展开，`depth` 控制**子级**的渲染深度。

**父级 header**：当 `scope` 低于选择器层级时，输出自动带父级 header。例如 `recall(scope="turns", session=42)` 在 turn 列表前输出 session 42 的 header。

### `session`、`turn`、`obs`

三个独立选择器，各自支持：

| 格式 | 类型 | 示例 |
|------|------|------|
| 单值 | `number` | `session=42` |
| 数组 | `number[]` | `turn=[3,5,7]` |
| 范围 | `string` | `turn="3..7"` |

**层级校验**：每个选择器必须属于其父级。不匹配时返回 parameter error。

### `after`、`before`、`time`

| 参数 | 类型 | 用途 | 示例 |
|------|------|------|------|
| `after` | `number` | epoch 下限 | `1712448000` |
| `before` | `number` | epoch 上限 | `1712534400` |
| `time` | `string` | 日期语法糖 | `"-7d"`、`"2026-04-07"`、`"2026-04-01..2026-04-07"` |

同时指定取交集。

### `depth`

| depth | 子级行为 | 递归 | 自动省略 |
|-------|---------|------|---------|
| `collapsed` | 标题 + 统计 | 否 | 是 |
| `expanded` | 直接子级展开，孙级 collapsed | 否 | 是 |
| `full` | 所有后代递归展开 | 是 | 是 |

## 渲染格式

### 时间格式

| 层级 | 格式 | 示例 |
|------|------|------|
| Session | `YYYY-MM-DD HH:MM ~ HH:MM`（started ~ updated） | `2026-04-07 14:30 ~ 15:30` |
| Session（跨天） | `YYYY-MM-DD HH:MM ~ MM-DD HH:MM` | `2026-04-06 23:50 ~ 04-07 00:30` |
| Turn | `MM-DD HH:MM` | `04-07 14:30` |

### Session

**Collapsed**

```
- [S42] Auth race fix | 💬9 💡5 | 2026-04-07 14:30 ~ 15:30 | claude-mnemo
  - desc: Diagnosed and fixed the refresh race
```

**Expanded** = collapsed + insight + next_steps

```
- [S42] Auth race fix | 💬9 💡5 | 2026-04-07 14:30 ~ 15:30 | claude-mnemo
  - desc: Diagnosed and fixed the refresh race
  - insight:
    - durable memory extracted
  - next_steps:
    - add integration test coverage
```

### Turn

**Collapsed**

```
  - [T1] Diagnose auth | 💡1 📖1 🔧2 [extracted] | 04-07 14:30
    - desc: Captured the race condition
```

**Expanded** = collapsed + prompt + response + insight

```
  - [T1] Diagnose auth | 💡1 📖1 🔧2 [extracted] | 04-07 14:30
    - desc: Captured the race condition
    - prompt: "Fix the auth bug"
    - response: "Added mutex to token refresh"
    - insight:
      - refresh races under parallel load
```

### Observation

**Collapsed**

```
- [O7] 🔴 Mutex added
  - desc: Refresh is serialized
```

**Expanded** = collapsed + narrative + facts + concepts + files

```
- [O7] 🔴 Mutex added
  - desc: Refresh is serialized
  - narrative: A shared promise now serializes refresh work.
  - facts:
    - mutex added
    - test added
  - concepts: problem-solution
  - files_read: src/auth.ts
  - files_modified: src/auth.ts, tests/auth.test.ts
```

## 内建自动行为

| 规则 | 条件 | 行为 |
|------|------|------|
| 自动省略 | 单层级 > 50 项 | head 5 + 中间均匀采样 5 + tail 10。pending/stale 始终保留，不参与省略 |
| 字段截断 | 所有模式，200 字符 | 超出截断 + `[use replay(session=S, turn=T) for full content]` |
| 状态标签 | 始终 | 每个 turn 显示 `[pending]`/`[stale]`/`[extracted]`/`[skipped]`/`[undone]` |

## 消费者模型

三个消费者都调用 `recallMemory()`，共用同一套渲染格式：

| 消费者 | 调用 |
|--------|------|
| recall MCP tool | `recallMemory(db, input)` |
| Mnemosyne | `recallMemory(db, { scope: "turns", session: id, depth: "expanded" })`，输出包在 `buildMnemosynePrompt()` 里 |
| SessionStart | 多次 `recallMemory()` 调用（见下方），加 header + session 锚定逻辑 |

## SessionStart 注入设计

### 流程

1. 通过 `content_session_id` 锚定当前 session
2. 调用 `recallMemory()` 组装输出
3. 通过 `hookSpecificOutput` 注入

### 输出结构

```
{header}

## Current Session

{wrapper: formatSessionExpanded(primary) + recallMemory(scope="turns", session=current, depth="collapsed", skipParentHeader=true)}

## Recent Sessions

{wrapper: recentSessions.filter(s => s.id !== primaryId).slice(0, 4) → recallMemory per session}
```

**Current Session 是 wrapper 组合，不是两次 recallMemory 拼接。** `recallMemory(scope="sessions", depth="expanded")` 会输出 expanded session header + expanded turns，再调 `scope="turns"` 会重复 turns。正确做法：wrapper 自行调用 `formatSessionExpanded()` 产出 session header（含 insight/next_steps），然后调用 `recallMemory(scope="turns", session=current, depth="collapsed")` 产出 collapsed turn 列表（跳过 parent header，因为 wrapper 已输出）。

**Recent Sessions 是 wrapper 基于 ID 过滤，不依赖时间边界。** `before=current_start_epoch` 会错误排除"比当前 session 更新但不是当前 session"的会话。正确做法：wrapper 调 `getRecentSessions(db, { limit: 5 })`，按 `id !== primaryId` 过滤，取前 4 条，对每条调 `recallMemory(scope="sessions", session=id, depth="collapsed")`。与现有 `buildRecentSessions` 的 `filter(s => s.id !== primaryId).slice(0, 4)` 一致（`context.ts:193-195`）。

### 示例输出

```
claude-mnemo: 5 sessions, 47 observations
Types: 🔴bugfix 🟣feature 🔄refactor ✅change 🔵discovery ⚖️decision
Stats: 💬turns 💡observations 📖read ✏️modified 🔧tools
Expand: recall(scope="turns", session=x, turn=y) | Raw: replay(session=x, turn=y)

## Current Session

- [S3] Auth race fix | 💬4 💡5 | 2026-04-07 14:30 ~ 15:30 | claude-mnemo
  - desc: Diagnosed and fixed the refresh race
  - insight:
    - durable memory extracted
  - next_steps:
    - Implement the mutex fix
  - [T1] Prep cache | 🔧1 [extracted] | 04-07 14:30
    - desc: Set up the cache state
  - [T2] Investigate timeout | 💡1 📖1 🔧2 [extracted] | 04-07 14:45
    - desc: Trace the timeout path under parallel load
  - [T3] Validate fix | 📖1 🔧3 [extracted] | 04-08 09:10
    - desc: Confirm the mutex patch removes the race
  - [T4] Document findings | 💡4 📖2 🔧4 [extracted] | 04-08 09:30
    - desc: Document the durable outcome

## Recent Sessions

- [S1] Most recent session | 💬6 | 2026-04-07 16:00 ~ 17:30 | claude-mnemo
  - desc: Most recent session description...
- [S2] Secondary session | 💬2 | 2026-04-06 10:00 ~ 10:30 | claude-mnemo
  - desc: Secondary session description...
- [S4] Older session | 💬1 | 2026-04-05 09:00 ~ 09:15 | claude-mnemo
  - desc: Older session description...
- [S5] Oldest session | 💬1 | 2026-04-04 14:00 ~ 14:20 | claude-mnemo
  - desc: Oldest session description...
```

### 与现有实现的差异

| | 现有实现 | V2 |
|---|---------|-----|
| 渲染格式 | 独立渲染层（`formatPrimarySession` 等） | wrapper 调 `formatSessionExpanded` + `recallMemory` 组合 |
| Current session header | session expanded（有 insight，无 next_steps） | session expanded（含 insight + next_steps） |
| Current session turns | 最后 3 展开 + 其余 collapsed + observations | 全部 collapsed（无 prompt/response/obs） |
| Recent sessions | next 2 带 5 collapsed turns + last 2 header only | 全部 collapsed，无 turns，wrapper 按 ID 过滤 + 限 4 条 |
| 截断预算 | desc 60、prompt 120、response 200、insight 80 | 统一 200 字符 |
| Session 时间 | `YYYY-MM-DD` | `YYYY-MM-DD HH:MM ~ HH:MM` |
| Turn 时间 | 无 | `MM-DD HH:MM` |

**简化理由**：Current session 不需要展开 turns——agent 有完整的会话历史可回溯，collapsed turns 足够提供"之前做了什么"的索引。需要详情时用 `recall(scope="turns", session=x, turn=y)` 钻入。

## Mnemosyne 提取上下文

```python
recall(scope="turns", session=42, depth="expanded")
```

直接调用 `recallMemory()`，输出包在 `buildMnemosynePrompt()` 里。不再维护独立的 `buildExtractionContext`。

与现有实现的差异（deliberate behavior change）：

| | 现有实现 | V2 |
|---|---------|-----|
| 分档渲染 | head 3 collapsed + 中间 omitted + tail 3 expanded | 统一自动省略（>50 项） |
| 字段截断 | 1500 字符 | 200 字符（刻意收紧） |
| pending/stale bypass | 自有实现 | 内建于自动省略规则 |

## 实现计划

### 已完成

以下阶段已在代码中落地，不再作为待办：

- **Recall V2 核心**（`src/mcp/recall.ts`）：scope/selector/time/depth、自动省略、200 字符截断、父级 header、`normalizeRecallInput` 兼容层
- **Mnemosyne 接入**（`src/mnemosyne/prompt.ts`）：`buildExtractionContext` 已删除，改为调用 `recallMemory()`
- **兼容迁移**（`src/mcp/handlers.ts`）：旧参数运行时映射 + deprecation 日志
- **文档同步**：`SKILL.md`、`README.md`、`docs/design.md`、unify-turn-identifiers spec 已更新
- **测试**：recall 选择器/时间/scope×depth、legacy alias 测试、smoke test

### 剩余工作：SessionStart 统一

- [ ] `src/hooks/handlers/context.ts`：重写 `buildContextOutput`
  - [ ] Current Session：wrapper 调 `formatSessionExpanded()` 产出 session header，再调 `recallMemory(scope="turns", session=current, depth="collapsed")` 产出 turn 列表（跳过 parent header）
  - [ ] Recent Sessions：wrapper 调 `getRecentSessions` → 按 ID 过滤 primary → 取前 4 → 对每条调 collapsed session 渲染
  - [ ] 删除 `formatPrimarySession`、`formatRecentSession`、独立截断函数
  - [ ] 保留 header 和 `content_session_id` 锚定逻辑
- [ ] `tests/hooks/context.test.ts`：更新断言匹配新的渲染格式（expanded session header + collapsed turns，无 observations）
- [ ] 确认 `recallMemory` 的 turn-scope 渲染支持 `skipParentHeader` 选项（或 wrapper 直接裁剪输出）

## 迁移策略

### 兼容映射

| 旧参数 | 映射 |
|--------|------|
| `session=42` | `session=42`（无变化） |
| `session=42, turn=3` | `session=42, turn=3`（无变化） |
| `observation=7` | `obs=7`（重命名） |
| `from_epoch=X, to_epoch=Y` | `after=X, before=Y`（重命名） |

### Breaking changes

| 旧功能 | 替代方案 |
|--------|---------|
| `around="S12", before=2, after=2` | 先 `recall(scope="sessions")` 查时间，再用 `after`/`before` |
| `expand_turns=[1,3]` | 先 `recall(scope="turns", session=42)` 浏览，再 `recall(scope="observations", session=42, turn=1)` 钻入 |

### Observation ID

保留 `[O7]` 全局 DB id。per-turn 序号在重提取后静默漂移，全局 DB id 至少 loud fail。

## 设计决策记录

1. **`scope` 必填**：消除隐式层级推断。
2. **独立选择器取代 `id` 路径**：`session`/`turn`/`obs` 支持单值、数组、范围。比路径语法更灵活，层级校验更自然。
3. **`after`/`before` + `time`**：epoch 精确控制 + 日期语法糖，同时指定取交集。
4. **状态标签默认显示**：不需要开关。
5. **自动省略（50 项）**：head 5 + 采样 5 + tail 10。pending/stale 始终保留。
6. **统一字段截断 200 字符**：不再按字段类型分预算。
7. **`depth` 三档**：collapsed / expanded（一层）/ full（递归）。三档均有省略和截断。
8. **Observation ID 保留全局 DB id**：稳定性优先于语义一致性。
9. **SessionStart wrapper 组合 recall 格式**：Current Session 由 wrapper 自行调 `formatSessionExpanded` 产出 session header，再调 `recallMemory(scope="turns")` 产出 collapsed turn 列表。Recent Sessions 由 wrapper 基于 ID 过滤（非时间边界）再渲染。保留 header 和 session 锚定逻辑，删除 `formatPrimarySession`/`formatRecentSession` 等独立渲染函数。
10. **Mnemosyne 直接调 `recallMemory()`**：不维护独立的 `buildExtractionContext`。
11. **Turn 加日期**：`MM-DD HH:MM`，Session 改为 `YYYY-MM-DD HH:MM ~ HH:MM`。
12. **`around` 和 `expand_turns` 是 breaking removal**：前者基于条目数滑窗无法用时间替代；后者混合选择和渲染，V2 的 `turn`（选择器）和 `depth`（渲染）正交，无法复现"全部列出+部分展开"。
