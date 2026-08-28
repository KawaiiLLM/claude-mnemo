# 14 — Whitespace runs price as one token

**What to build:** `estimateTokens` (src/utils/token-estimate.ts) stops
charging indentation at ¼ token per space: a run of TWO OR MORE consecutive
spaces prices as ONE token total; single spaces keep flowing through the
general ¼ rule (the 4-chars-per-token English average already accounts for
word-separating spaces, which BPE folds into the following word token).
The milestones fitter's exact-reconstruction twin
(`milestoneFitterTokenEstimate` / the quarters scheme in src/mcp/timeline.ts)
changes in lockstep — ticket 04's equality assertion must keep passing.

**Blocked by:** 11 — the arrow format shifts row costs; retune once, on top.

**Status:** resolved — landed as `647246f`; every criterion re-checked
per-item and independently spot-verified. Suite **3956/0** (3947 + 1 ticket-11
test + 8 new estimator tests), tsc clean. Real E70: 73 → **77 rows** (+4, as
predicted), 7970 chars / 1965 honest tokens; overshoot sweep 0/3920, worst
99.7%, max card 8476 chars vs the 9500 guard (headroom shrunk from 1900 to
~1000 — the guard is now the binding constraint to watch as segments grow).
The fitter's quarters scheme now matches `estimateTokens` EXACTLY, not just
within rounding.

Worker finding worth keeping: the repricing RIPPLES to short marker strings —
`capRenderToTokenBudget`'s two-space+ellipsis truncation marker went 1 → 2
tokens (carving the space run out of the ¼ pool loses fractional-ceiling
benefits), breaking a recall-segment-card test far from the milestones fitter.
Any future estimator change: sweep ALL consumers' tests, not the fitter's.
Budget windows post-both-tickets recorded in the worker report (golden-nine
420-443, folded-day legend 231-233, fitter-probe c2 663-692, c3 ≤662).

## Why

User challenge 2026-08-28 [S15069/T1915] ("不是4个空格对应一个token吧"),
confirmed by BPE behavior: space runs of any common length are single
vocabulary tokens. Measured on the real E70 card: 74 rows × 8-space indent
(est 2 tok, real ~1) + 16 `↳` × 12-space (est 3, real ~1) ≈ **110 phantom
tokens ≈ 5.5% of the 2000 budget ≈ 4-5 rows** left unseated. The error's
direction is conservative (under-fill, never overshoot), which is why this is
a refinement, not an emergency.

## Decisions (settled — implement as given)

1. **Rule: a maximal run of ≥2 consecutive space characters (U+0020) = 1
   token.** Tabs and other whitespace are untouched (not used by these
   renderers); the newline keeps its current ¼ pricing — `\n`+indent often
   merges to one real token, so the estimate stays deliberately a touch
   conservative. State this bias in the doctrine comment.
2. **Both measures change together**: `estimateTokens` and the fitter's
   quarters scheme, with ticket 04's within-rounding equality assertion
   still green. If exact quarters cannot express the run rule, restructure
   the fitter's cheap gate as needed — the EQUALITY is the invariant, not
   the quarters representation.
3. **Consumers all float on the shared function** — fields card, composition
   ladder, milestone fitter. No per-surface exceptions. `estimateDiaryTokens`
   is OUT of scope (different audience, ticket 04 decision 7 stands).
4. **Fixtures retune once.** Budget-sensitive tests (fitter thresholds, the
   CJK reserve-starvation fixtures ticket 10 retuned) shift again; re-measure
   empirically, don't hand-derive.

## Acceptance criteria

- [x] `estimateTokens("        ")` (8 spaces) === 1; a single space inside
      prose prices unchanged; a CJK string prices unchanged — asserted.
- [x] Fitter measure vs `estimateTokens` still agree within rounding on an
      assembled indented card body — the ticket-04 assertion, still green,
      cited by test name.
- [x] Real E70 card at 2000 (read-only): report rows/honest tokens before
      and after — expect roughly +4-5 rows.
- [x] Overshoot sweep (`/tmp/overshoot-probe.ts`): zero overshoots, worst
      utilization reported. NOTE: utilization is measured in the NEW
      currency; if the sweep script itself prices with the old rule, update
      the copy you run and say so.
- [x] The demote-ladder char guard still holds: max card chars over the
      sweep reported against MAX_INJECTED_BLOCK_CHARS 9500 (rows grew, chars
      grow — confirm headroom remains).
- [x] Every new/changed test mutation-verified (backup after implement,
      needle-assert + print, red, md5 restore, green).
- [x] `npx tsc --noEmit` clean, build succeeds, `bun test` green; account for
      every delta.

## Notes

Production DB strictly read-only. Do not tick your own boxes — report
per-item; the reviewer ticks.
