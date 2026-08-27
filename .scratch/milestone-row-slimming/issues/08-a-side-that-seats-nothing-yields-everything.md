# 08 — A side that seats nothing yields everything

**What to build:** close the hole ticket 06 opened. When a side of the split
milestones card renders **zero rows**, the other side gets the WHOLE card
budget — unconditionally, before any hungry/yielding pairing is considered.
Today that only happens when exactly one side yields, so two simultaneously
yielding sides leave the card emptier than it was before ticket 06 landed.
Also fix a reversed word in ticket 07's new comment.

**Blocked by:** 06 and 07 (both landed: `fbcff6e`, `27f6375`).

**Status:** resolved — landed as `c4c8219`; every criterion re-checked per-item
and independently spot-verified. The differential the ticket exists for is
clean: **0 regressions (was 262), 75 improvements, 3360 comparable cases**,
re-run by the reviewer against `8b09f15` with byte-identical restore (md5).
Suite 3942/0, `tsc` clean, overshoot sweep still 0/3920 at 95.3% worst
utilization, cliff still 63/62/63, E70 still 60 rows. Reviewer mutation
swapping the both-empty branch to try OLD before RECENT turned decision 2's
test red; restored byte-identical, green.

Worker finding accepted and worth keeping: the `satisfied + reserve-starved`
row of the decision table is **provably output-identical** across buggy,
fixed, and pre-06 code — decision 1 only ever boosts the OTHER side, and a
satisfied side's output is invariant to more budget, so nothing visibly
changes. It needed a second, differently-aimed mutation to give that test any
teeth.

**RESIDUE — see ticket 09.** That invariance is exactly the problem: the row
is restored to pre-06 parity, not fixed. Verified live on E60 at budget 500
(a real demote-ladder rung): the card renders ONLY the OLD side, rows dated
08-19..08-24, while E60's newest 200 members are from today. The starved
RECENT side is never rescued. This ticket did what it was asked and introduces
no regression; closing the residue needs a user ruling, not more code.

## Why

Second GPT peer review, 2026-08-28, finding 1 — reproduced and quantified by
the reviewer as a **regression against pre-ticket-06 behaviour**.

`buildSplitSegmentMilestoneCard` computes `oldYields` and `recentYields`, then
re-elects only under `oldYields && !recentYields` or `recentYields &&
!oldYields`. Both flags can be true at once — an empty side always yields, and
a side whose half cannot cover the fixed header/pointer/legend reserve also
yields while seating nothing. When both are true, neither branch fires, the
reserve-starved side keeps its useless half, and the card renders zero rows
where the full budget would have rendered several.

Ticket 06 decision 5 required the old "one side empty → the other gets the
full budget" branch to be absorbed as the extreme case of the general rule.
It was deleted, but the general rule does not cover it. The peer's decision
table:

| OLD / RECENT | outcome |
|---|---|
| both satisfied (`demotedCount === 0`) | correct |
| empty + satisfied | equivalent to before |
| empty + reserve-starved | **broken** |
| satisfied + reserve-starved | **broken** |
| both reserve-starved | **broken / undefined** |

Reviewer's measurement — every live segment × 8 budgets × 6 boundary
positions, HEAD against `8b09f15` (pre-ticket-06), production DB read-only:

```
262 cases where ticket 06 renders FEWER rows than pre-06
   budget 400 → 88 cases      worst: E67  8 rows → 0
   budget 300 → 90 cases              E70  7 rows → 0
   budget 250 → 84 cases              E53  7 rows → 0
   budget 500 →  0 cases   (the lowest rung the live demote ladder uses)
 48 cases where ticket 06 correctly renders MORE — the fix itself works
```

No production path reaches a regressing budget today, because the demote
ladder's rungs are 2000 → 1000 → 500 and the regression starts below 500. That
is an accident of the current constants, not a property of the code, and a
CJK-heavy segment could bring it up to 500 without any code changing.

## Decisions (settled — implement as given)

1. **`kept.length === 0` outranks everything.** Before the yield/hungry
   pairing is evaluated: if a side seated zero rows, the other side elects at
   the FULL `pageBudget` — the zero-row side contributes no tokens, so there is
   nothing to subtract. This restores pre-ticket-06 behaviour exactly for every
   row of the table above, and it is what decision 5 of ticket 06 asked for.
2. **When BOTH sides seated zero, RECENT is tried first.** The split exists to
   guarantee recency a share it cannot be outbid for; when the budget can only
   serve one side, recency is the side it should serve. After RECENT re-elects
   at the full budget, OLD may re-elect at `pageBudget` minus RECENT's actual
   cost — so a budget that turns out to fit both still shows both.
3. **The partial case keeps ticket 06's rule unchanged.** Both sides seated
   rows, exactly one is hungry → the hungry one re-elects at `pageBudget` minus
   the other's actual rendered cost. Both hungry → both keep their guaranteed
   halves. This ticket adds a precedence rule in front; it does not revise what
   ticket 06 decided.
4. **At most one re-election per side** still holds — decision 2's sequence is
   one for RECENT and then one for OLD, not a loop.
5. **Fix the reversed word in ticket 07's comment.** `src/mcp/timeline.ts`
   around the fitter's binary search says a too-small `bestK` "underestimates
   `demotedCount`". Since `demotedCount = candidates − bestK`, a too-small
   `bestK` **over**estimates it. The ticket 07 file says this correctly; the
   comment inverted it. A comment written to be honest that states the
   direction backwards is worse than no comment.
6. **Out of scope:** the demote ladder's rung values; the half-budget split
   itself; election tiers and sort keys (ADR-0013); the duplicated chrome
   (ticket 05); `PROBE_WINDOW`; any version bump or push.

## Acceptance criteria

- [x] The differential is clean: re-run the reviewer's sweep (every live
      segment × budgets 1000/700/500/400/300/250/200/150 × recentMemberCount
      1/3/10/200/831/10000) against `8b09f15`, and report **zero** cases where
      HEAD renders fewer rows than pre-ticket-06. Report the count of cases
      where HEAD renders more. The reviewer's probe is at
      `/tmp/lowbudget-probe.ts`; adapt it rather than rebuilding it.
- [x] Each broken row of the decision table above is asserted as its own test:
      empty + reserve-starved, satisfied + reserve-starved, both
      reserve-starved. Name in each which side ends up rendering and why.
- [x] Both-sides-seated-zero prefers RECENT — asserted on a fixture where the
      full budget fits exactly one side's row.
- [x] Both-sides-seated-zero but the budget fits BOTH after re-election → both
      render — asserted.
- [x] Ticket 06's own guarantees still hold: hungry side never yields, the
      830-boundary cliff stays gone (63/62/63 on the real card), a ≤200-member
      segment still renders byte-identical — all three re-asserted, not assumed.
- [x] No card exceeds its budget: re-run the reviewer's overshoot sweep (all
      segments × 7 budgets × 8 boundary positions = ~3920 cases,
      `/tmp/overshoot-probe.ts`) and report zero overshoots and the worst
      utilization.
- [x] The `demotedCount` comment states the direction correctly — quoted in
      the report.
- [x] Every new/changed test mutation-verified: name the observable, back up
      AFTER the implementation lands, assert the needle matched and PRINT that
      it applied, red, restore byte-identical (md5), green.
- [x] `npx tsc --noEmit` clean, `node scripts/build.js` succeeds, `bun test`
      green; baseline is 3938/0 — report the number and account for every delta.

## Notes

Production database strictly read-only. Do not tick your own acceptance boxes —
report per-item; the reviewer ticks.
