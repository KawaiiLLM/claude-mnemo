# Unified Pagination for Timeline & Recall

**Goal**: 统一 timeline 和 recall 的分页风格——page/pageSize 是纯渲染层，只在候选集超过 pageSize 时分页展示 `page X / Y (total Z)`。选择/过滤层（range、id、query、time）独立于分页。

**动机**: 当前 timeline 用 range 窗口 + `TIMELINE_WINDOW_CAP` 硬编码截断，输出 `T1-T30 of 45 (next: T31..T45)` 风格的提示。Recall 用 `page X / Y (total Z)` 风格。两者不一致，且 timeline 无法控制窗口大小。

**影响范围**: `src/mcp/timeline.ts`、`src/mcp/definitions.ts`、`src/mcp/handlers.ts`、recall 的 `formatShowingLine` 替换。

---

## Locked Decisions

**D1**: **page/pageSize 是渲染层，不是选择层**。两层正交：

| 层 | Timeline | Recall |
|----|----------|--------|
| 选择 | `id="S1/T20..40"` (range) | `id="S1"` / `query="auth"` / `time="today"` |
| 渲染 | `page` + `pageSize` | `page` + `pageSize` |

Range 确定候选 turns，page/pageSize 对候选集分页展示。Recall 的 id/query/time 确定候选集，page/pageSize 对结果分页展示。逻辑不变。

**D2**: **只在候选集超过 pageSize 时分页**。如果选出的元素 ≤ pageSize，不显示分页 header，直接展示全部。超过时显示 `page 1 / 3 (total 45)`。

```
# 候选集 15 项, pageSize 30 → 不分页，无 header
# 候选集 45 项, pageSize 30 → page 1 / 2 (total 45)
```

**D3**: **Timeline 的 `id` 参数保留 range 语法不变**。`S<n>`、`S<n>/T<start>..<end>`、`S<n>/T<start>..`、`S<n>/T..<end>` 全部保留。Range 决定"看哪些 turns"，page/pageSize 决定"一次展示多少"。

**D4**: **Timeline 新增 `page` 和 `pageSize` 参数**。默认 `page=1`，`pageSize=30`（当前 `TIMELINE_WINDOW_CAP` 的值）。`TIMELINE_WINDOW_CAP` 常量改为 `DEFAULT_TIMELINE_PAGE_SIZE`。

**D5**: **Timeline 的 `showing` 行统一为 recall 风格**。

当前：
```
showing: T1-T30 of 45 (next: T31..T45)
```

改为：
```
showing: page 1 / 2 (total 45)
```

保留 `earlier` hint（`timeline(id="S1/T1..19")`）用于 range 导航，与分页无关。

**D6**: **Recall 的分页逻辑不变**。Recall 已经是 page/pageSize 风格，只需确保"候选集 ≤ pageSize 时不显示分页 header"（D2）。当前 recall 始终显示 header，需要调整。

**D7**: **`resolveWindow` 简化**。去掉 `TIMELINE_WINDOW_CAP` 对 range 的截断。Range 选出的所有 turns 都是候选集，由 page/pageSize 分页。当前 `resolveWindow` 将 `S1/T1..100` 截断为 30 条——这不再需要，range 应该如实返回 T1-T100，然后分页层展示前 30 条（page 1）。

`resolveWindow` 不再需要 `requestedEnd` 字段（用于标记被截断的 range）。Window 如实反映 range 选择，分页是独立的后续步骤。

**D8**: **`buildContextTimelineView` 保留 last-page 语义**。SessionStart 注入的 timeline 使用 `buildContextTimelineView`，当前取最后 `TIMELINE_WINDOW_CAP` 条 turns，设置 `hasEarlier`，context handler 用 `windowPhasesOnly: true` + `showEarlierHint: true` 渲染。

改为取最后 `DEFAULT_TIMELINE_PAGE_SIZE` 条 turns（值不变），底层可复用 page/pageSize 分页机制（相当于取最后一页），但 `buildContextTimelineView` 仍然：
- 显式返回 last-page 的 view（不是通用的 page=1）
- 继续设置 `hasEarlier = firstPromptNumber !== allTurns[0].promptNumber`
- Context handler 继续用 `windowPhasesOnly` + `showEarlierHint` 渲染

page/pageSize 是底层机制，不替代 context 注入的"last page + earlier hint"语义。

**D9**: **Timeline tool description 同步更新**。`definitions.ts` 的 timeline 描述当前写 "30-turn hard cap"，改为反映 page/pageSize 可配置语义，去掉 hard cap 措辞。

---

## Implementation

### Task 1: `definitions.ts` — Timeline input 新增 page/pageSize

```typescript
export const timelineInputShape = {
  id: z.string().min(1),
  page: z.number().int().positive().optional(),
  pageSize: z.number().int().positive().optional(),
};
```

### Task 1b: `definitions.ts` — Timeline tool description 去掉 hard cap

```typescript
// 当前:
timeline: "Render the temporal/decision shape of a past session — phases, gaps, tool bursts, compact boundary, broken-prompt candidates. Single-session view with range-based pagination (30-turn hard cap).",

// 改为:
timeline: "Render the temporal/decision shape of a past session — phases, gaps, tool bursts, compact boundary, broken-prompt candidates. Single-session view; supports range selection via id and page/pageSize pagination.",
```

### Task 2: `handlers.ts` — 传入 page/pageSize

```typescript
timeline: (args) =>
  textResult(timelineQuery(database, {
    id: args.id as string,
    page: args.page as number | undefined,
    pageSize: args.pageSize as number | undefined,
  })),
```

### Task 3: `timeline.ts` — 分页化

1. `TimelineInput` 新增 `page?: number`、`pageSize?: number`
2. `TIMELINE_WINDOW_CAP` 重命名为 `DEFAULT_TIMELINE_PAGE_SIZE`（值保持 30）
3. `resolveWindow` 简化：去掉 `TIMELINE_WINDOW_CAP` 截断，range 如实返回全部匹配范围。去掉 `requestedEnd` 字段
4. `buildTimelineView` 返回全部候选 turns（由 range 决定），新增 `page`/`pageSize` 字段到 `TimelineView`
5. `renderTimeline` 内部对 `windowTurns` 用 `paginateItems` 分页，只渲染当前页的 turns
6. `formatShowingLine` 改为 `page X / Y (total Z)` 格式，候选集 ≤ pageSize 时不输出
7. `phases` 保持 session-wide 计算（当前默认行为，`segmentPhases(allTurns)`），`windowPhasesOnly` 选项仍按局部 turns 计算——分页不改变 phases。`renderShapeSignals` 基于**候选集**（range 选出的全部 turns）计算，不随翻页变化。分页只影响 turn table 的行数，不影响分析结果。这确保 page 是纯渲染层（D1）

### Task 4: Recall — 候选集 ≤ pageSize 时不显示分页 header

将"pageCount ≤ 1 时不显示 header"收敛到 `joinPage` helper 内部：

```typescript
function joinPage(page: number, pageCount: number, total: number, body: string): string {
  const header = pageCount > 1 ? formatPageHeader(page, pageCount, total) : null;
  return header ? `${header}\n${body}` : body;
}
```

所有调用点（7 处）统一走 `joinPage`，无需逐个修改：
- `recall.ts:1067`（renderRoutedId sessions）
- `recall.ts:1086`（renderRoutedId turns）
- `recall.ts:1115`（renderRoutedId turn observations）
- `recall.ts:1142`（renderRoutedId observations）
- `recall.ts:1160`（renderRoutedId memories）
- `recall.ts:1186`（renderSessionList）
- `recall.ts:1274`（search results）

### Task 5: `buildContextTimelineView` 适配

底层复用 page/pageSize 分页取最后一页 turns，但保留 last-page 专用语义：
- 仍返回最后 `DEFAULT_TIMELINE_PAGE_SIZE` 条 turns
- 继续设置 `hasEarlier`
- Context handler（`context.ts:151`）的 `windowPhasesOnly: true` + `showEarlierHint: true` 调用不变

### Task 6: Tests

1. Timeline: 候选集 ≤ pageSize → 无分页 header，全部展示
2. Timeline: 候选集 > pageSize → 显示 `page 1 / N (total M)`，只展示前 pageSize 条 turns
3. Timeline: page=2 展示第二页 turns
4. Timeline: range + page 组合 — `S1/T20..50` 选出 31 条，pageSize=10，page=2 展示 T30-T39
5. Timeline: pageSize 自定义覆盖默认值 30
6. Recall: 候选集 ≤ pageSize → 无分页 header
7. Recall: 候选集 > pageSize → 行为不变（已有测试覆盖）
8. `buildContextTimelineView` 仍取最后一页 turns
