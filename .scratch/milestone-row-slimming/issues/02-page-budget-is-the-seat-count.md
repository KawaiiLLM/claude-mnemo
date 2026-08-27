# 02 — The milestones view has no pagination; the page budget IS the seat count

**What to build:** retire the two fixed admission clamps
(`Math.min(pageSize, DEFAULT_TIMELINE_PAGE_SIZE)` — `src/mcp/timeline.ts`
S-view call site and `selectSegmentMilestonesByEdgeSignals`) and every
pagination semantic on the `milestones` view. Election ranks ALL candidates;
the token budget (`pageBudget`/`tokenBudget`), enforced by the existing
budget fitter, decides how many render — cut strictly in election-rank order,
lowest first. Seats stop being a constant and become whatever the budget fits.

**Blocked by:** 01 — same renderer, same file; serialize.

**Status:** resolved — landed as `761de40`; every criterion re-checked per-item from the worker's report and spot-verified (clamp grep 0, real-DB E70 card 23 rows @1929/2000 tokens, both central test files 215/0, suite 3917/0). KEY FINDINGS accepted: (1) the E-view milestones route had NEVER consumed its pageBudget — the 30-cap was the only limiter, so the old 30-row card was silently overrunning an honest 2000; (2) with honest accounting E70 fits 23 rows at 2000 (real row cost ~75 FITTER-tokens — later audit [S15069/T1894] showed this is the diary conservative estimator billing English at ~3x, NOT CJK weight; see ticket 04) — crossing 30 needs ~2500-2600, budget constant change is a pending USER decision; (3) electMilestones' internal tier-③ fill boundary pinned at the 30 constant, decoupled from budget (flagged design call, accepted — avoids coupling into ADR-0013 territory); (4) buildContextTimelineView found dead in production, milestoneTail retired with it; (5) overflowByDay left dead-but-present, cleanup candidate.

## Why

User ruling 2026-08-28 [S15069/T1873]: "timeline 的里程碑不该有分页机制,
分页预算此时就是选举席位". The design was always budget-sized — the
SessionStart injection passes `pageSize: Number.MAX_SAFE_INTEGER` and its own
comment says "the token budget, not pagination, is what sizes the injection" —
but a pre-0.17.0 repair round (R1 #5) added the clamp, promoting the generic
pagination default 30 into a semantic admission cap without a ruling. Measured
consequence [S15069/T1868]: E70's card renders exactly 30 rows at ~44% of its
2000-token budget; the newest ~280 turns of a 1027-turn session cannot seat at
any budget.

## Decisions (settled — implement as given)

1. **Both clamps retire.** No numeric admission cap anywhere on the milestones
   path: not in `buildTimelineView`'s S-view election, not in
   `selectSegmentMilestonesByEdgeSignals` (E-card + spine-nested rows). The
   R1 #5 "unbounded cut defeats curation" concern is answered by the fitter:
   every milestones render already runs under some token budget
   (`DEFAULT_MILESTONE_PAGE_BUDGET` 1000 default, injection 2000/2500), so
   curation IS the budget cut. No replacement engineering ceiling — the fitter
   bounds output; if candidate-set size ever becomes a compute problem that is
   its own ticket, not a silent cap here.
2. **Pagination semantics leave the milestones view.** `page`/`pageSize` keep
   their meaning on the `turns` view and lane view, but have NO effect on
   milestone rows. Survey `milestoneTail` (tail-mode slicing): if its only
   remaining purpose is pagination-flavored slicing of kept rows, retire it
   with the pagination it belonged to; if a live caller depends on it for
   something else, keep it and say so in the report.
3. **Budget cuts follow election rank.** Under a tight budget the surviving
   rows must be exactly the election ranking's prefix (top-k by rank, k = max
   that fits) — display stays chronological, but MEMBERSHIP is rank-ordered.
   If the fitter's current unit score does not already equal election rank,
   align it; that alignment is in scope.
4. **Always-keep anchors keep their existing semantics** — degrade before
   disappearing — unchanged by this ticket.
5. **A `↳` sub-row may only reference rows rendered in the same output.**
   Today "elected" and "rendered" coincide; once admission is everyone and
   the fitter decides survival, the citation scoping must key on the
   SURVIVING set, not the admitted set — a `↳` pointing at a row the budget
   dropped is a defect.
6. **Overflow accounting follows.** `demotedCount` / "+N more" hints count
   budget-dropped rows now, not cap-dropped rows; the hint text stays honest.
7. **Out of scope:** the console's `ELECTION_PREVIEW_BUDGET` (a different
   surface with its own preview semantics); ticket 01's row format (already
   landed by then); election tier definitions and within-tier sort keys
   (ADR-0013, pending user ruling); `DEFAULT_TIMELINE_PAGE_SIZE` itself stays
   for the `turns` view.
8. **Tests that used a small `pageSize` to force a small election** (e.g. the
   golden-nine fixture, budget 9) re-express their intent through a small
   `pageBudget`/`tokenBudget`; the expectation they pin — a small curated
   election — survives, the knob changes.

## Acceptance criteria

- [x] On a fixture with >30 viable candidates and a generous budget, the
      milestones view renders MORE than 30 rows — the old cap's exact
      failure, asserted.
- [x] On a tight budget, the surviving rows equal the election ranking's
      top-k prefix; asserted by naming the ranking and the cut point.
- [x] `page`/`pageSize` have no effect on milestone rows — asserted by
      rendering the same view with different values.
- [x] No `↳` sub-row references a row the budget dropped — asserted on a
      fixture where the fitter actually drops the cited row.
- [x] The `turns` view's pagination is byte-identical on a fixture exercising
      `page`/`pageSize` — asserted.
- [x] Both `Math.min(pageSize, DEFAULT_TIMELINE_PAGE_SIZE)` clamp sites are
      gone; `grep -n "DEFAULT_TIMELINE_PAGE_SIZE" src/mcp/timeline.ts` output
      quoted in the report, every remaining use accounted for as turns-view.
- [x] Every new/changed test mutation-verified: name the observable, backup
      AFTER the implementation lands, assert the mutation needle matched and
      PRINT that it applied, red, restore byte-identical, green.
- [x] `npx tsc --noEmit` clean, `node scripts/build.js` succeeds, `bun test`
      green; report the number and account for every delta.

## Out of scope

See decision 7. Also: any change to injection budget constants (2000/2500/1000
stay), the roster, recall surfaces, or the settlement side.

## Notes

Production database read-only (`sqlite3 -readonly`). Do not tick your own
acceptance boxes — report per-item; the reviewer ticks. The E70 card replay
(`renderAttachedSegmentBlock(db, "milestones", {id:70}, cutoff)` against a
COPY of the production DB, or a fixture shaped like it) is the natural
end-to-end smoke: expect the row count to rise above 30 and the budget
utilization to approach 2000.
