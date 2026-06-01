# Timeline milestone / phases parameters

**Status:** approved design, plan pending
**Date:** 2026-06-01
**Scope:** `timeline()` MCP tool + the SessionStart embedded timeline render

## Motivation

The SessionStart hook injects a timeline render (`buildContextTimelineView` →
`renderTimeline`) on every resume/compact. It emits a full per-turn table for
the last 30 turns plus a phases block plus shape signals. Empirically (S1730,
last-30 window) that table is the lowest value-per-token part of the injection:
~24 rows / ~1529 chars of per-turn detail, much of it routine `discovery`
turns, when the resume reader only needs the *milestones* — where work shipped,
where decisions were made, where the big work happened, and where they left
off. The phases block already summarizes the arc, so the full table is largely
redundant for the resume use case.

We want the timeline to be able to render only milestone turns, with the
phases block toggleable, while keeping `timeline()`'s on-demand full-detail
view intact by default.

### Empirical basis (S1730, last-30 window)

Four selection strategies were prototyped against the real DB
(`scripts/proto-timeline-keynodes.ts`, throwaway):

| Strategy | rows | chars | verdict |
|---|---|---|---|
| Baseline (all live turns) | 24 | 1529 | full |
| decisions-only (`⚖️`) | 2 | 136 | wrong axis — drops every ship/build turn |
| decide/build/fix + last | 9 | 584 | drops `✅` ships (delivery-blind) |
| **milestones (chosen)** | 15 | 939 | keeps ships, features, decisions, the 🔧596 burst, and the true stopping point |
| phases-only | 15+3 | 505 | most compact but loses per-turn titles (the value) |

`decisions-only` was rejected: it kept two design-discussion turns and dropped
the turns showing 0.2.18/0.2.19 were built, merged, and pushed — including
`T166 committed, merged, pushed`, the actual stopping point.

## Goals

- Add `milestones` and `phases` boolean parameters to the `timeline()` tool.
- Default behavior of `timeline()` is unchanged *except* the `⏭` skipped-turn
  summary line is removed (skipped turns are filtered out of the timeline).
- SessionStart's embedded timeline renders in milestone mode with the phases
  block off.
- No additional milestone cap beyond the existing window/page selection.

## Non-goals

- No keyword-based sub-filtering of `✅ change` turns (see Decision 3).
- No *additional* cap on milestone output beyond the existing window/page
  selection (pagination still applies; milestone mode does not cap further).
- No change to recall, remember, or the timeline view-building / pagination
  math (`buildTimelineView`, `resolveWindow`).
- Cross-page milestone coherence is not pursued. Milestone selection operates
  entirely on the **rendered page** (`view.pageTurns`); a phase that straddles
  a page boundary has its lead recomputed per page, so the first turn of a page
  always reads as a phase-lead. The primary consumer (SessionStart) is
  single-page (`pageTurns === windowTurns`), so this edge is harmless.

## Decisions

### D1 — Two boolean parameters, defaults preserve current output

| Parameter | Default | Effect |
|---|---|---|
| `milestones` | `false` | when `true`, the per-turn table renders only milestone turns (D2); when `false`, the full live-turn table (current behavior) |
| `phases` | `true` | when `false`, the phases block is omitted; when `true`, included (current behavior) |

A bare `timeline(id=...)` call returns the same output as today, minus the
`⏭` line (D4). The on-demand full-detail temporal axis is preserved.

### D2 — Milestone selection (when `milestones: true`)

**Candidate turns come only from the rendered page** (`view.pageTurns`) — no
turn from outside the page is ever selected. The one window-scoped input is the
burst *threshold* scalar (`view.windowSignals.toolBurstThreshold`), reused for
calibration; membership is still decided per page. A turn is a milestone if it
is **live** (not `skipped`/`undone`) AND satisfies any of:

- it is the **start turn of a non-discovery phase** — compute
  `segmentPhases(view.pageTurns)` and keep each phase's `startPromptNumber`
  where `type !== null && type !== "discovery"`, or
- it is a **tool-burst turn** — **re-scan** the page's live turns for
  `toolCallCount > view.windowSignals.toolBurstThreshold` (the existing
  `2× median` scalar). Do **not** use `view.windowSignals.toolBursts`: that list
  is `.slice(0, TOOL_BURST_TOP_N=3)`-truncated (`timeline.ts:644`) and would
  silently drop a 4th+ burst, or
- it is a **compact boundary** (`view.compactBoundaries`) that falls within the
  page, or
- it is one of the **last 3 live turns** of the page.

The keep-set is the union of prompt numbers; rows render in prompt-number
order. No cap beyond the page (Non-goals). Row count scales with real milestone
density (a long single-type grind yields few rows; a window that shipped three
versions yields the ship points).

Implement as a pure helper `selectMilestoneTurns(view): Set<number>` so it is
unit-testable in isolation from rendering.

### D3 — `✅ change` turns: no special-casing

`change` turns enter the milestone set the same way every other type does —
via "non-discovery phase-lead". We do **not** keyword-match titles for
commit/merge/push. Rationale: most `change` phase-leads are ships, and
keyword-matching titles is brittle (a reworded title silently drops a real
ship). With no row cap, keeping a non-ship `change` phase-lead (e.g. a
spec-patching phase) costs one line and is strictly safer than risking a missed
ship.

### D4 — Skipped turns are filtered out (all modes), gaps stay real

The `⏭ T137, T146-148…` skipped-turn summary line is removed from
`renderTurnTable` in all modes. Skipped turns were never rendered as rows; this
removes the residual summary too. This is the one intentional change to the
default (`milestones:false`) output.

**Gap tracking is preserved.** `renderTurnTable` currently advances
`prevEpoch = turn.createdAtEpoch` *before* the skipped `continue`
(`timeline.ts:905-911`), so the gap shown on the next rendered row spans the
hidden turn. Keep this. In milestone mode, non-milestone live turns that are
suppressed must **also** advance `prevEpoch` (treat them like skipped for gap
purposes) — only rendering is filtered, so displayed gaps remain true
inter-turn deltas.

**Test impact:** `tests/mcp/timeline.test.ts` "keeps skipped turns in gap
tracking while collapsing them to a trailing summary" (line ~1377) asserts both
`| +50s |` (gap) and `⏭ T20` (summary). Update it: keep the `| +50s |` and
`not.toContain("T20 |")` assertions; replace `toContain("⏭ T20")` with
`expect(output).not.toContain("⏭")`. Rename to reflect the new behavior
("keeps skipped turns in gap tracking without a trailing summary").

### D5 — SessionStart renders milestone mode, phases off

`buildContextTimelineView`'s render call site (in `context.ts`) passes
`{ milestones: true, phases: false }` alongside the existing
`{ promptCap: 80, showEarlierHint: true }`. The embedded timeline becomes:
session header + milestone turn table + shape signals + earlier hint. The
phases block is dropped because milestone selection (phase-leads + extras)
overlaps it.

## Parameter plumbing

`milestones` and `phases` are pure render concerns; they do not affect view
building. They flow:

1. **`src/mcp/definitions.ts`** — `timelineInputShape` gains
   `milestones: z.boolean().optional()` and `phases: z.boolean().optional()`.
   `timelineInputSchema` stays `.strict()`.
2. **`src/mcp/handlers.ts`** — the `timeline` handler reads
   `args.milestones` / `args.phases` (as `boolean | undefined`) and forwards
   them into `timelineQuery`.
3. **`src/mcp/timeline.ts`**
   - `RenderTimelineOptions` gains `milestones?: boolean` and `phases?: boolean`.
   - `timelineQuery(db, input)` forwards the two flags into the
     `renderTimeline(view, options)` options object. `buildTimelineView`
     ignores them.
   - New pure helper `selectMilestoneTurns(view): Set<number>` implementing D2
     (returns the set of milestone prompt numbers for the rendered page).
   - `renderTurnTable(view, promptCap, milestones)` — when `milestones` is
     true, skip live turns not in the milestone set; always drop the `⏭`
     summary (D4).
   - `renderTimeline` — when `options.phases === false`, omit `renderPhases`.
     Default (`undefined`/`true`) includes it.
4. **`src/hooks/handlers/context.ts`** — render with
   `{ milestones: true, phases: false, promptCap: 80, showEarlierHint: true }`.

### Docs

- `MNEMO_TOOL_DESCRIPTIONS.timeline` (definitions.ts): mention the two flags.
- `plugin/skills/mnemo-timeline/SKILL.md`: document `milestones` and `phases`
  params and the milestone definition.

## Test strategy

- **`selectMilestoneTurns`** (unit): synthetic page with known
  types/bursts/compact/tail → assert keep-set equals expected; assert a
  `discovery` non-lead turn is excluded and a `change` phase-lead is included
  (D3); assert a page with **≥4 burst turns keeps all of them** (guards against
  reusing the top-3-truncated `windowSignals.toolBursts`, F2).
- **`renderTurnTable`**: `milestones:true` filters to the keep-set;
  `milestones:false` renders all live turns (unchanged); output never contains
  `⏭` in either mode even when skipped turns are present (D4); in milestone
  mode, a milestone row immediately after a suppressed non-milestone turn shows
  a gap spanning that suppressed turn (gap preservation, D4).
- **`renderTimeline`**: `phases:false` omits the phases block; default includes
  it; `milestones`/`phases` compose.
- **`timelineQuery` / handler**: flags pass through from args to render;
  defaults reproduce current output minus the `⏭` line.
- **schema**: `timelineInputSchema` accepts boolean `milestones`/`phases`,
  rejects non-boolean and unknown keys (strict).
- **SessionStart (`context.ts`)**: `buildContextTimelineView` render emits
  milestone rows and no phases block.

## Acceptance

- `timeline(id=...)` output equals pre-change output except the `⏭` line is
  gone.
- `timeline(id=..., milestones=true)` renders only milestone turns, with no
  additional milestone cap beyond the existing page/window selection.
- `timeline(id=..., phases=false)` omits the phases block.
- SessionStart embedded timeline is the milestone table + signals (no full
  table, no phases block); on S1730's last-30 window it is ~939 chars vs the
  prior ~2030 (table+phases).
- `bun test` green; `bun run typecheck` clean.

## Rollout

- Patch bump (0.2.19 → 0.2.20) across `package.json`,
  `plugin/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`.
- Rebuild bundles via `node scripts/build.js`.
- Worker/MCP pick up the new build on next plugin reload (standard reload
  pattern).
