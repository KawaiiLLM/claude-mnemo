# 12 — 会话视图里程碑并轨(0.8.4 弧脊柱评分半壁退役)

**What to build:** 会话视图(S 路由)的嵌套段里程碑行与独立段路由用同一套字典序边信号选择;旧 effGrade/state-citation 选择机制退役。

规范:spec「里程碑」bullet;既有裁决「P2 废止 0.8.4 弧脊柱的评分半壁」。

- `S<n>` 会话视图的嵌套段里程碑行改用 09 的 `selectSegmentMilestonesByEdgeSignals`(overridden 除名→encodes→refines decision>delivery→时近);token-budget demotion 语义由 pageSize 语义替代。
- 旧机制(state-citation+token-budget 的段行选择、effGrade 词典序的会话级选择)及其独立测试退役——留读法不留选择权威。
- 旧纪元退出里程碑渲染的既有行为不回退。
- 09 票判断记录里的划界(「独立段路由先行」)由本票闭环。

**Blocked by:** 09(字典序选择器,已 done)。

**Status:** done (scoped — see judgment call 1 below)

- [x] 会话视图嵌套段行与独立段路由同一选择结果(同 fixture 双断言) — `tests/mcp/timeline.era-milestones.test.ts`'s
      "dual assertion" test.
- [x] 旧选择机制无功能性引用(grep 断言) — `selectSegmentMilestoneRows` retired
      (grep below). `selectMilestoneTurns` deliberately NOT retired — see
      judgment call 1.
- [x] 旧纪元退出、无边退化行为保持 — inherited unchanged from
      `selectSegmentMilestonesByEdgeSignals` (ticket 09), now also exercised
      through the `S<n>` route.

## Implementation record (2026-08-19)

`renderEraMilestoneLines` (the `S<n>` era spine's nested per-segment
milestone rows, inside `renderTimeline`) now consumes
`TimelineView.segmentMilestoneSelection` — a `ReadonlyMap<number,
SegmentMilestoneEdgeSelection>` computed EAGERLY in `buildTimelineView`
(which has `db`) via `selectSegmentMilestonesByEdgeSignals`, the SAME
function ticket 09 wired into the standalone `E<n>` route
(`buildSegmentTimelineView`). Per-segment admission uses
`DEFAULT_TIMELINE_PAGE_SIZE` (30) — a fixed default, not threaded from the
`S<n>` call's own top-level `pageSize` (see judgment call 2) — and
`input.taskCausalityEraCutoffEpoch`, newly threaded through to this path
(previously E<n>-route-only, per that field's now-updated doc comment).
`renderEraMilestoneLines` itself is now a pure renderer with no admission
logic — the same "selection happens in `buildTimelineView`, rendering stays
pure" discipline every other `TimelineView` field already follows.

The old state-citation/token-budget rule (`selectSegmentMilestoneRows`,
`SegmentMilestoneSelection`, `sumRowTokens`) lost its only production caller
and was deleted outright, along with its ~9 dedicated pure-function unit
tests (`tests/mcp/timeline.segment-views.test.ts`). `TimelineView`'s
`segmentMilestoneMaterial` field (raw members + `citedTurnIds`) was replaced
by `segmentMilestoneSelection` (the pre-computed selection); the now-unused
`getSegmentCitedTurnIds` (`src/db/segment-rank.ts`, out of this ticket's
territory) has no remaining callers anywhere in the codebase — flagged as
dangling dead code for whoever owns `src/db/`, not removed here.

`RenderTimelineOptions.pageBudget` / `TimelineInput.pageBudget` are now
inert for the `S<n>` route's nested rows (no code path reads them for that
purpose any more) — kept on both types for schema stability with existing
callers, doc comments updated to say so. A regression test confirms the
no-op (`tests/mcp/timeline.era-milestones.test.ts`).

**Judgment calls (flagged — please review)**:

1. **Scoping (STOP-clause invocation, per this ticket's own brief)**: the
   effGrade/correction-graph SESSION-LEVEL selection (`selectMilestoneTurns`,
   feeding the LEGACY pre-era milestone body — a different render region from
   the era spine's nested rows this ticket unifies) is **NOT retired**. Two
   independent reasons, either alone sufficient:
   - It feeds a surface beyond "the session view's milestone rows": the
     TURNS view's `G` grade column (`TimelineView.turnEffGrades` ←
     `MilestoneSelection.effGradeByTurnId`) — a different `view` entirely
     (`view="turns"`, not `"milestones"`).
   - Retiring it would break `tests/mcp/timeline.test.ts`'s existing
     integration-test surface for the legacy milestone body — budget
     degradation, tie-breaks, always-keep endpoints, correction-graph
     reversal markers, day-group folding — none of which are "dedicated
     unit tests of `selectMilestoneTurns`" (those are the six direct-call
     sites the ticket's "dedicated tests retire" bullet targets) but which
     DO test the exact behavior retiring the call site would delete. That
     is a materially larger blast radius than one ticket, matching what
     ticket 09's own scoping note anticipated and this ticket's brief
     explicitly gates on ("STOP at the session-view unification, leave the
     extra consumers on the old machinery, and flag exactly what remains").
   - Production impact of leaving it in place is low: every real MCP
     `timeline` call resolves a live, non-null `eraCutoffEpoch`
     (`src/mcp/handlers.ts`'s `eraCutoff()` → `resolveEraCutoff`), so
     `selectMilestoneTurns` only ever sees genuinely pre-segment-era turns
     in practice — current/recent sessions render their milestones entirely
     through the (now-unified) era spine.
2. Per-segment nested-row `pageSize` is a fixed constant
   (`DEFAULT_TIMELINE_PAGE_SIZE`), not threaded from the `S<n>` call's own
   `TimelineInput.pageSize` (which governs the UNRELATED top-level
   `pagedMilestones`/turns-view pagination). Reusing that field would have
   let `renderSessionMilestoneInjection`'s `pageSize: Number.MAX_SAFE_INTEGER`
   call (settlement's own wide-view injection, `src/worker/
   note-settlement-context.ts`) disable per-segment admission entirely,
   risking one oversized segment block the outer token-budget shedding can
   only drop wholesale, not trim. No ticket-specified per-segment knob
   exists on `TimelineInput`, and `definitions.ts` is out of this ticket's
   territory to extend — matches ticket 09's own "no ticket-specified
   different constant" call for the `E<n>` route's own default.
3. `tests/mcp/segment-spine.test.ts` and `tests/hooks/milestone-injection.test.ts`
   were read and re-run (not edited) to confirm no regression — neither
   depends on the retired admission mechanism's specifics (spine HEADER line
   text and whole-segment/orphan shedding are unaffected by which function
   selects a segment's NESTED rows).

**Re-check commands**:
- `bun test tests/mcp/timeline.era-milestones.test.ts` (dual-assertion +
  edge-signal admission + edge-free degradation + legacy-body untouched)
- `bun test tests/mcp/timeline.segment-views.test.ts` (E<n> route unaffected;
  old dedicated tests gone)
- `grep -rn "selectSegmentMilestoneRows" --include="*.ts" .` → one hit, a
  comment in `src/mcp/timeline.ts` explaining the retirement; zero calls.
- `bun test tests/mcp/timeline.test.ts tests/mcp/segment-spine.test.ts tests/hooks/milestone-injection.test.ts tests/hooks/context-segments.test.ts tests/db/edge-signals.test.ts`
