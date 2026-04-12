# Context Timeline Injection

**Goal**: SessionStart hook 注入当前 session 的 timeline，使 agent 在 startup / compact 后立即拥有完整的决策弧视图，无需手动调 `timeline()`。

**触发**: `startup | clear | compact`（从 hooks.json matcher 中移除 `resume`）。

**依赖**: timeline v1（已实现）。

---

## Locked Decisions

**D1**: 注入时 timeline 窗口默认取**最后一页**（last N turns），不是第一页。理由：compact 恢复和 session 续接时，最近的决策上下文比最早的更有价值。

**D2**: prompt 列截断从 200 chars 缩短到 **80 chars**（注入场景）。timeline MCP tool 调用保持 200。理由：system context 宽度有限，200 char prompt 加上 padding 会浪费大量 token。通过新增 `renderTimeline(view, options)` 的 `promptCap` 选项实现，不改全局常量。

**D3**: Header 格式变更——把当前分散的 session expanded + format legend + stats 替换为紧凑的 header + timeline 融合视图。`current: S<n>` 显式标注在 header 第一行。

**D4**: 当 session turns = 0 时跳过 timeline 注入，只输出 header + memories + recent sessions。

**D5**: `renderTimeline` 的 session header 已包含 project/duration/types/tz/raw。注入时不再重复渲染 session expanded 中的同类字段。只保留 session 的 `title` 和 `insight`（timeline 自身不含这些语义摘要）。不展示 `content`——content 是 100-300 chars 的 session 概述，和 timeline 的 phases + turn table 高度重叠，注入时属于冗余。

**D6**: hooks.json matcher 从 `startup|resume|clear|compact` 改为 `startup|clear|compact`。resume 不注入。

**D7**: turn table 底部增加 `earlier:` 提示行（当窗口不是从 first 开始时），格式：`earlier: timeline(id="S<n>/T<first>..<windowStart-1>")` 或 `recall(id="S<n>")`。

**D9**: Context handler 在 startup 时提前 upsert session，确保 `current: S<n>` 准确。当 `getSessionByContentId(db, input.sessionId)` 找不到时，调用 `upsertSession` 创建最小记录（contentSessionId + project + createdAtEpoch）。后续 UserPromptSubmit 的 session-init 补全字段。如果 `input.sessionId` 为空，不显示 `current:` 标签。**副作用**：用户打开 session 但未发送任何 prompt 时，DB 中也会留下一条空 session 记录（title=null, 0 turns）。这是可接受的——`getRecentSessions` 排序时这些空 session 会自然排到底部（无 updatedAtEpoch），不影响 recent sessions 展示质量。如果未来空 session 积累过多，可在 worker 定期清理 `title IS NULL AND (SELECT COUNT(*) FROM turns WHERE session_id = s.id) = 0` 的记录。

**D10**: startup 时不注入 timeline，只展示 `current: S<n>` + memories + recent sessions（折叠）。Timeline 只在 `compact | clear` 时注入（此时 session 有历史 turns，timeline 有价值）。理由：startup 时当前 session 0 turns，注入 timeline 无意义；上一个 session 的 timeline 不是当前 session 的上下文。

**D8**: 注入模式下 phases 和 shape signals 都 scoped 到当前窗口，不是 session-wide。理由：注入的 turn table 只显示最后一页，如果 phases 覆盖了 agent 看不到的早期 turns，会产生困惑。timeline MCP tool 保持当前行为（phases session-wide，signals window-scoped）。通过 `renderTimeline(view, { windowPhasesOnly: true })` 实现：注入时用 `segmentPhases(view.windowTurns)` 替代 `segmentPhases(allTurns)`，label 从 `phases (session-wide)` 改为 `phases (window)`。

---

## Output Format

### 完整示例（session 有 40 turns，T100-T139）

```
claude-mnemo: 3 sessions, 180 observations | current: S5
Axes: recall (content) · timeline (temporal) · mnemo-replay (raw)

## Memories

[M1] feedback/global: Prefer bundled PRs for refactors | 2026-04-10 | S3/T12
[M2] project/mnemo: Auth middleware rewrite driven by compliance | 2026-04-11 | S4/T8

## Current Session

[S5] Implement token refresh and fix auth middleware
  insight:
  - Rate limiting requires exponential backoff, not fixed retry
  - Auth token refresh must happen before middleware check

- [S5] 2026-04-12 09:00 → 11:24 (2h 24m)
  /Users/zhaoqixuan/Projects/myapp | 40 turns | 180 tool_calls
  types: 🔴5 🟣8 🔄3 🔵15 ⚖️2 (session-wide)
  showing: T110-T139 of 40 (end)
  tz: GMT+8 (+08:00)
  raw: /Users/zhaoqixuan/.claude/projects/...jsonl

  T#     line   time    gap        stats        prompt                                                                           title
  ───    ────   ─────   ───────    ──────────   ───────────────────────────────────────────────────────────────────────────        ──────────────────────────────────────
  T110   L450  10:30   +3m        🔧5 📖2     重构认证模块                                                                         🔄 Extract auth middleware
  T111   L470  10:34   +4m        🔧12 📖3    实现新的 token 刷新逻辑                                                                🟣 Implement token refresh
  ...
  T139   L890  11:24   +2m        🔧3         看看最终效果                                                                         ⏳

  phases (window T110-T139):
    1. 🟣 feature    T110-T125  ~35m   16 turns 📖25 ✏️10 🔧70
    2. 🔴 bugfix     T126-T130  ~15m   5 turns  📖8 ✏️5 🔧25
    3. 🔄 refactor   T131-T133  ~10m   3 turns  📖6 ✏️4 🔧18
    4. 🟣 feature    T134-T139  ~12m   6 turns  📖10 ✏️3 🔧14

  shape signals (window T110-T139):
    - fastest gap:   after T120 (+30s)
    - longest gap:   after T125 (+8m)
    - tool bursts:   T118 🔧15, T129 🔧12   [median 🔧5, threshold >🔧10]
    - undone turns:  T127

  earlier: timeline(id="S5/T100..109") or recall(id="S5")

## Recent Sessions

[S4] Auth middleware rewrite | 💬25 💡90 | 2026-04-11 | /myapp
[S3] Initial project setup | 💬15 💡45 | 2026-04-10 | /myapp
```

### startup（新 session，0 turns — 无 timeline）

```
claude-mnemo: 3 sessions, 180 observations | current: S6
Axes: recall (content) · timeline (temporal) · mnemo-replay (raw)

## Memories

[M1] feedback/global: Prefer bundled PRs for refactors | 2026-04-10 | S3/T12

## Recent Sessions

[S5] Implement token refresh | 💬40 💡180 | 2026-04-12 | /myapp
[S4] Auth middleware rewrite | 💬25 💡90 | 2026-04-11 | /myapp
```

无 `## Current Session` 块。`current: S6` 告知 agent 本次 session 的 id。

### compact / clear（有 turns — 注入 timeline）

见上方完整示例。

### Session 少于 30 turns（显示全部）

不展示 `earlier:` 行。`showing:` 行显示 `(end)`。

---

## Implementation

### Task 1: `renderTimeline` 支持注入模式

**文件**: `src/mcp/timeline.ts`

1. 新增 `RenderTimelineOptions` interface：

```typescript
export interface RenderTimelineOptions {
  promptCap?: number;           // default: PROMPT_COLUMN_CAP (200)
  lastPage?: boolean;           // default: false — 为 true 时窗口取最后 N turns
  windowPhasesOnly?: boolean;   // default: false — 为 true 时 phases 只覆盖窗口内 turns
}
```

2. `renderTimeline(view, options?)` 签名不变，增加可选 options 参数。`promptCap` 传递到 `renderTurnRow` 控制截断宽度。

3. `renderTurnTable` 和 `renderTurnRow` 接受 `promptCap` 参数，替代硬编码的 `PROMPT_COLUMN_CAP`。table header 的 `───` 分隔线宽度也根据 `promptCap` 调整。

4. 新增 `buildContextTimelineView(db, sessionId)` 函数：
   - 查询 session 的所有 turns，按 `promptNumber` 排序
   - 取最后 `TIMELINE_WINDOW_CAP` 条 turns 的 `promptNumber` 范围作为窗口（row-count 语义，不是 prompt-span 语义——即使 prompt number 不连续，也严格取最后 N 条记录）
   - 构造 `TimelineInput` with `id: "S<sessionId>/T<startPromptNumber>..<lastPromptNumber>"`
   - 调用 `buildTimelineView(db, input)` 并返回 view
   - 如果窗口不是从 first 开始，在 view 上标记 `hasEarlier: true`

   **注意**：不能用 `bounds.last - cap + 1` 作为 start（prompt-span 语义），因为 prompt number 可能不连续（跨 compact 后从 136 开始、中间有 skipped turns 等）。必须从排序后的 turn 列表倒数第 N 条取 `promptNumber`。

5. `renderPhases`：当 `options.windowPhasesOnly` 时，用 `segmentPhases(view.windowTurns)` 替代 `view.phases`，label 从 `phases (session-wide)` 改为 `phases (window T<start>-T<end>)`。

6. `renderShapeSignals` 末尾：当 `options.lastPage && hasEarlier` 时，追加一行：
   ```
   earlier: timeline(id="S<n>/T<first>..<windowStart-1>") or recall(id="S<n>")
   ```

### Task 2: 重构 `buildContextOutput`

**文件**: `src/hooks/handlers/context.ts`

1. `buildHeader(db, primarySessionId?)` 变更：
   - 删除 Format 4 行和 Stats 行
   - 添加 `current: S<n>` 到第一行（当 primarySessionId 有值时）
   - 添加 `Axes:` 行

   Before:
   ```
   claude-mnemo: 3 sessions, 180 observations
   Types: 🔴bugfix 🟣feature ...
   Stats: 💬turns 💡observations ...
   Format:
     - [Sx] ...
     - [Tx] ...
     - [Ox] ...
     - [Mx] ...
   Expand: recall(id="Sx/Ty", depth="expanded") | Raw: mnemo-replay skill
   ```

   After:
   ```
   claude-mnemo: 3 sessions, 180 observations | current: S5
   Axes: recall (content) · timeline (temporal) · mnemo-replay (raw)
   ```

2. `buildCurrentSessionOutput` 重写：
   - 输入从 `(session, turns)` 改为 `(db, session, sessionRecord)`
   - 渲染 session title + insight（2-3 行），不渲染 content/project/dates（timeline header 会包含）
   - 调用 `buildContextTimelineView(db, sessionRecord.id)` 获取 view
   - 调用 `renderTimeline(view, { promptCap: 80, lastPage: true })` 获取 timeline 文本
   - 拼接 session summary + timeline

3. 删除 `buildCollapsedTurnViews` 函数（不再需要 last 5 turns collapsed）。

4. 删除 `getObservationCountByTurnId` 函数（不再需要 per-turn obs count for collapsed rendering）。

5. 当 session 有 0 turns 时，跳过整个 `## Current Session` 块。

### Task 3: 修改 hooks.json matcher

**文件**: `plugin/hooks/hooks.json`

SessionStart matcher 从 `startup|resume|clear|compact` 改为 `startup|clear|compact`。

### Task 4: 测试

**文件**: `tests/hooks/context.test.ts`

1. 现有测试更新：调整期望输出格式（header 变更、无 last 5 turns collapsed）。

2. 新增测试：
   - `context output includes timeline turn table for session with turns` — 验证注入包含 turn table header 和至少一个 turn row
   - `context output uses last page when session exceeds window cap` — seed 40 turns，验证 `showing:` 行显示最后 30 个，且有 `earlier:` 提示
   - `context output skips Current Session when session has 0 turns` — 验证无 `## Current Session` 块
   - `context output includes current: S<n> in header` — 验证 header 第一行包含 `current: S<n>`
   - `context timeline uses 80-char prompt cap` — 验证 prompt 列不超过 80 chars

**文件**: `tests/mcp/timeline.test.ts`

3. 新增测试：
   - `renderTimeline respects promptCap option` — 验证 prompt 列截断到指定宽度
   - `buildContextTimelineView returns last-page window` — seed 40 turns，验证 window 从 T11 开始（假设 1-based）
   - `renderTimeline shows earlier hint when lastPage and not at start` — 验证 `earlier:` 行存在

### Task 5: Rebuild

`npm run build` 重新构建 bundles。

---

## Files Modified

| File | Change |
|---|---|
| `src/mcp/timeline.ts` | `RenderTimelineOptions`, `buildContextTimelineView`, `renderTimeline` options, `promptCap` threading |
| `src/hooks/handlers/context.ts` | `buildHeader` 简化, `buildCurrentSessionOutput` 重写, 删除 `buildCollapsedTurnViews` + `getObservationCountByTurnId` |
| `plugin/hooks/hooks.json` | SessionStart matcher 移除 `resume` |
| `tests/hooks/context.test.ts` | 现有测试更新 + 5 条新测试 |
| `tests/mcp/timeline.test.ts` | 3 条新测试 |
| `plugin/scripts/*.cjs` | rebuild |

---

## Non-goals

- 不改 `timeline()` MCP tool 的默认行为（仍然从 first 开始，200 char prompt cap）
- 不改 recall 的注入内容
- 不添加 per-prompt semantic injection（claude-mem 有这个，mnemo 暂不需要）
- 不为 `resume` 触发注入（用户明确排除）
