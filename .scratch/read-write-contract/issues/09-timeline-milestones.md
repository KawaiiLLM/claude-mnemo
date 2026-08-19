# 09 — timeline 两视图 + 里程碑选择 + SessionStart 注入

**What to build:** timeline 支持段选择器;里程碑视图按字典序信号自动选重要 turn;SessionStart 注入里程碑视图作全局索引。

规范:spec「timeline」「里程碑」。

- 段选择器(新能力):数据范围=段成员 turn 跨 session 时序;输出一律 `S<n>/T<m>` 回指;分页语义与会话视图同构;`timeline(id="E31/T1...")` ≡ `timeline(id="E31")`。
- turn 视图与里程碑视图仅差 pageSize 驱动的重要性选择。
- 里程碑选择=字典序:**第 0 键 overridden 除名**;encodes 降序;refines 超额入度降序(**decision 桶先于 delivery 桶**);时近。填满 pageSize;选择是唯一显示权威;无边图安全退化(平铺时序)。信号消费 edge-signals,不重算。
- 旧纪元 turn 整体退出里程碑渲染(既有裁决,勿回退)。
- SessionStart 注入里程碑视图。

**Blocked by:** 07(渲染器内核)。

**Status:** done (scoped — see judgment call 1 below)

- [x] 段选择器跨 session 时序+S/T 回指+分页 — was already largely in place
      pre-ticket (`buildSegmentTimelineView`/`renderSegmentTimeline`,
      `chronologicalSegmentMembers` already cross-session); this ticket added
      the `E<n>/T...` ≡ `E<n>` equivalence.
- [x] 字典序四键构造性测试(含 overridden 除名与桶序)
- [x] 无边图退化;旧纪元退出
- [x] SessionStart 注入块渲染

## Implementation record (2026-08-19)

New pure function `selectSegmentMilestonesByEdgeSignals` (src/mcp/timeline.ts),
consuming `getTurnEdgeSignals` (never recomputing): candidates = era-eligible
members (`isTaskCausalityEra`, param `taskCausalityEraCutoffEpoch`) minus any
with a live `override` edge; ranked by encodesCount desc → refinesExcess
.decision desc → refinesExcess.delivery desc → recency desc → turnId desc;
top `pageSize` admitted; KEPT rows always DISPLAY in event/chronological
order regardless of ranking order (ranking decides membership only). Wired
into `buildSegmentTimelineView`'s milestones branch (the standalone `E<n>`
route), replacing the old `selectSegmentMilestoneRows` (state-citation +
token-budget demotion) call there. `SegmentTimelineInput` gained
`taskCausalityEraCutoffEpoch?: number` (era override for tests/callers) and
its milestones branch now reads `pageSize` (item count) instead of
`pageBudget` (tokens) as the admission driver — matching the spec line "turn
视图与里程碑视图仅差 pageSize 驱动的重要性选择".

`parseSegmentTimelineId` now matches `E<n>(/T...)?` — any trailing selector
is accepted and ignored, making `timeline(id="E31/T1...")` byte-identical to
`timeline(id="E31")` (proven by a new equivalence test). `E*`/`E1..9` still
reject (those are range/wildcard forms on the segment id itself).

SessionStart's existing `segment{1,2,3}-milestones` hook slots
(`hook-command.ts` + `plugin/hooks/hooks.json`, wired before this ticket)
call `timelineQuery(id="E<n>", view="milestones")` for each attached segment
— once `buildSegmentTimelineView` switched algorithms, this plumbing
automatically renders the new selection with NO wiring changes needed. A new
test in `tests/hooks/context-segments.test.ts` proves an overridden member is
excluded from the actual injected block end to end.

**Judgment calls (flagged — please review)**:
1. **Scoping**: the lexicographic edge-signal algorithm was wired ONLY into
   the standalone `E<n>` route (`buildSegmentTimelineView`). The `S<n>`
   session view's own NESTED per-segment milestone rows
   (`renderEraMilestoneLines`, inside `renderTimeline`) still call the OLD
   `selectSegmentMilestoneRows` (state-citation + token-budget), unchanged.
   `selectSegmentMilestoneRows` itself and its ~9 pure-function unit tests
   are untouched (that mechanism is still correct for its remaining
   consumer). Reasoning: the pinned decision text reads as a flat "ticket 09
   milestone selection IS lexicographic", but the huge pre-existing
   effGrade/correction-graph session-level milestone system
   (`selectMilestoneTurns`, a SEPARATE, deeply-tested mechanism from the
   0.8.4 arc-spine redesign) is out of one ticket's safe blast radius to
   replace wholesale, and project memory names its retirement as a distinct
   future ticket ("P2 将废止 0.8.4 弧脊柱的评分半壁"). The segment-scoped
   view is where ticket 09's own bullets ("段选择器", new capability) live.
   **If this scoping is wrong, the alternative reading (replace
   `selectMilestoneTurns` too) is a materially larger, separate task — flag
   back to the parent rather than silently expanding scope.**
2. `demotedCount` counts only era-eligible, non-overridden candidates the
   pageSize cap could not admit — a legacy-era-excluded or overridden turn is
   never counted as "demoted" (it was never a candidate).
3. Default milestones `pageSize` reuses `DEFAULT_TIMELINE_PAGE_SIZE` (30, the
   turns view's own default) — no ticket-specified different constant.

**Re-check commands**:
- `bun test tests/mcp/timeline.segment-views.test.ts`
- `bun test tests/hooks/context-segments.test.ts`
