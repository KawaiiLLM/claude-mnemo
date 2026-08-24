# 01 — SessionStart milestone injection splits into two half-budget timeline calls

**What to build:** the SessionStart-injected milestones section (user ruling
S15069/T1487) renders as TWO timeline calls per session, splitting the block
token budget evenly: one over the milestones OLDER than the session's most
recent 200 turns, one over the milestones WITHIN those 200. Today
`renderSessionMilestoneInjection` makes one whole-session call under
`MILESTONE_INJECTION_TOKEN_BUDGET` (2500) and the renderer's score-based
fitter lets long-lived old anchors starve everything recent — the live E60
block shows T900-1076 rows and swallows the newest ~700 turns in a "+676
more" tail. Recency gets a guaranteed half.

Mechanics:

- Boundary per session: prompt_number > max(prompt_number) − 200 is the
  RECENT side; the rest is the OLD side. A milestone row partitions by its
  own turn's prompt number and its `↳` sub-rows follow their parent.
- Two `buildTimelineView` calls scoped to the two ranges (add a range knob
  to the view builder if none exists — check for an existing internal
  filter first), each rendered through `renderMilestoneInjection` with
  floor(budget/2). If one side yields NO milestone rows, the other side
  runs with the full budget instead of wasting the half.
- The result stays ONE attachment (old part then recent part concatenated;
  the one-slot-one-block rule [S15069/T990] is about independently growing
  blocks, not sub-renders): don't repeat the session title line in the
  second part if the renderer makes that reachable cheaply.
- The `eraCutoffEpoch` plumbing (spec D11) passes through both calls
  unchanged; `showEarlierHint: false` stays on both.

**Blocked by:** None — can start immediately (address-form ticket 03 runs
concurrently on lane-checker/console/recall-dbid territory; no shared file).

**Status:** ready-for-agent

- [ ] Partition pinned at the boundary (a milestone at max−200 vs max−199
      lands on the documented side; sub-rows travel with their parent)
- [ ] Budget split pinned: each side's render fits floor(budget/2); an
      empty side reallocates the whole budget to the other
- [ ] A fixture whose recent-200 milestones previously lost the fitter now
      shows them (the recency guarantee — the reason this ticket exists)
- [ ] Era-cutoff behavior and no-earlier-hint behavior unchanged on both
      calls
- [ ] Territory: src/hooks/milestone-injection.ts, src/mcp/timeline.ts
      (range knob only), their tests. NOT lane-checker*/console*/recall/
      format/segment-card/definitions (ticket 03's, in flight), NOT
      db/turn-completion.ts, NOT db/sessions.ts
- [ ] Load-bearing properties declared for mutation acceptance
