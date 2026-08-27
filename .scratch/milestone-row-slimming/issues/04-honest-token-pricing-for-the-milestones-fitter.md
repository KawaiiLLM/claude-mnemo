# 04 — The milestones fitter prices tokens honestly

**What to build:** the timeline milestones budget fitter stops pricing text
with the diary conservative estimator (Han 1.1 / other 0.6 per char, ×1.2 —
i.e. English at 0.72 tok/char, ~3× real) and adopts `estimateTokens` semantics
(`src/utils/token-estimate.ts`: CJK Han/kana/Hangul 1 tok/char, everything
else 1/4). Budgets keep their VALUES (2000/2500/1000) and start buying real
tokens.

**Blocked by:** 03 — same fitter, serialize behind the split.

**Status:** resolved — landed as `8b09f15`; every criterion re-checked per-item
from the worker's report and independently spot-verified (`tsc` clean, suite
3931/0 = 3926 + 5 new, and a reviewer-run mutation narrowing `CJK_CHARACTER`
back to Han-only turned the kana/Hangul test red, restored byte-identical by
md5, green). Real E70 card, measured by the reviewer with `estimateTokens`:
**60 rows** (was 17 under the split at the old currency, 23 unsplit),
6833 chars, **1804 / 2000 honest tokens = 90.2%** — the utilization figure is
now real rather than inflated. The fitter's cheap gate is an EXACT
reconstruction of `estimateTokens` (integer quarter-tokens), exported as
`milestoneFitterTokenEstimate` so white-box tests can probe it directly; the
`×1.2` multiplier and the tenths scheme are gone.

Reserve (decision 5): `HEADER_AND_POINTER_RESERVE_TOKENS` re-derived 150 → 120
(worst case 100-char Han title + 6-digit id + 4-digit demoted count = 108
honest tokens, +12 margin). The legend half needed no re-derivation — it was
already a live `estimateTokens(...)` call, so it recomputed itself. Charged
**per-side** under ticket 03's split, which is correct: each side is a
self-contained render emitting its own header and its own legend.

ACCEPTED SCOPE CALL (worker's finding 4, reviewer-confirmed as defensible):
`MILESTONE_UNIT_TOKEN_CAP` = 150 and its `truncateToTokens`/`fitUnitTrim`
per-row hard cap still measure in `estimateDiaryTokens`, as do the segment
`turns`-view pagination and the lane view. None of these is "the milestones
budget fitter" this ticket named. The consequence is real but small: a row's
150-token hard cap is ~3× tighter in honest terms than its number suggests,
so it binds earlier than intended on rows carrying many `↳` antecedents.
Re-currencying it is NOT mechanical — 150 was calibrated under the old
weights, so the fix requires deciding what a row's cap should now BE, which is
a user-facing rendering decision. Recorded as a follow-up candidate, not a
defect here.

## Why

User challenge 2026-08-28 [S15069/T1894] ("怎么可能这么多中文") exposed the
misattribution: E70's card is 96% non-CJK (101 Han / 2626 chars), yet the
fitter billed it 1942 "tokens" where the honest estimate is ~729. The
"96.5% utilization at 2000" was paid in inflated currency; the conservative
weights were calibrated for CJK-heavy diary blocks, and milestone rows are
English by rule. `token-estimate.ts`'s own doc names the defect: "reads about
three times high on English prose". The sibling FIELDS card (recall.ts) has
always priced with `estimateTokens` — the two cards in one hook slot pool
currently pay in different currencies. The user ordered this ticket
[S15069/T1895].

## Decisions (settled — implement as given)

1. **Reprice the milestones fitter** (`HAN_WEIGHT_TENTHS`/`OTHER_WEIGHT_TENTHS`
   scheme in `src/mcp/timeline.ts`): CJK — Han AND kana AND Hangul, matching
   `estimateTokens`'s character class, not Han-only — at 1 tok/char, everything
   else at 1/4; the ×1.2 multiplier (`tokensFromWeightTenths`'s ×12/100)
   retires. Whether by calling `estimateTokens` directly or by integer-scaled
   weights (e.g. fortieths) is the worker's call, BUT the fitter's measure and
   `estimateTokens` must agree on an assembled block within rounding — asserted.
2. **One currency for every consumer of this fitter:** the S-view render
   (settlement-agent arc via `renderSessionMilestoneInjection`) and the E-view
   segment card alike. This aligns the milestones card with the fields card's
   existing `estimateTokens` pricing — removing an inconsistency, not creating
   a new estimator.
3. **Budget constants unchanged** (2500 session-arc, 2000 E-card, 1000 MCP
   default, ticket 03's halves). Expected effect on real data: E70's card
   seats roughly 2.5-3× more rows at the same budget.
4. **The hard guard is untouched and remains the safety story:**
   `MAX_INJECTED_BLOCK_CHARS` (9500 chars) + the demote ladder
   (2000→1000→500) in session-composition.ts. Sanity-check in the report that
   a full-budget English card (~60 rows) stays under the char guard, and that
   a CJK-heavy fixture is still priced ≈1/char so the guard's assumptions hold.
5. **Ticket 02's fixed header/legend reserve (150+157 tokens) re-derives in
   the new currency** — those numbers were computed under the old weights;
   recompute them the same way ticket 02 did (worst-case titleCap Han title)
   and state the new values.
6. **`token-estimate.ts`'s doctrine comment updates** to stay true: it
   currently says "one estimator per audience: this one for what an agent
   writes, that one for what the injector spends" — the milestones fitter is
   an injector that now deliberately prices honestly because its content is
   English-by-rule and the char-ladder carries the hard cap; say that there,
   in one sentence, so the next reader doesn't "fix" it back.
7. **Out of scope:** the diary's own `estimateDiaryTokens` and every diary/
   persona surface (their audience is unchanged); budget constant values;
   election tiers and sort keys (ADR-0013); the console; recall/fields
   surfaces (already honest).

## Acceptance criteria

- [x] Fitter measure vs `estimateTokens` agree within rounding (≤1 token) on
      an assembled mixed CJK/English milestone body — asserted.
- [x] On the E70-shaped real-DB smoke (/tmp copy) or an equivalent fixture:
      row count at budget 2000 is ≥2× the pre-ticket 23, and the report states
      utilization in REAL tokens (estimateTokens of the emitted block ÷ 2000).
- [x] A CJK-heavy fixture: fitter prices its rows ≈1 tok/char and the
      composed block still respects the 9500-char hard guard — asserted.
- [x] The settlement-arc S-view render provably uses the same currency (shared
      function or constant, probed by a test that would fail if the two
      diverge).
- [x] The re-derived header/legend reserve produces no overshoot: fitter-kept
      rows + header + legend measured by `estimateTokens` ≤ budget on the real
      E70 smoke — asserted with the numbers.
- [x] Kana/Hangul characters price at 1 tok/char (the old Han-only regex is
      gone) — asserted on a fixture title containing kana.
- [x] Every new/changed test mutation-verified: name the observable, backup
      AFTER the implementation lands, assert the needle matched and PRINT that
      it applied, red, restore byte-identical, green.
- [x] `npx tsc --noEmit` clean, `node scripts/build.js` succeeds, `bun test`
      green; report the number and account for every delta.

## Out of scope

See decision 7. No version bump, no push.

## Notes

Production database read-only (`sqlite3 -readonly`); real-DB smoke on a /tmp
copy. Do not tick your own acceptance boxes — report per-item; the reviewer
ticks. NB: this directory was deleted and recreated on 2026-08-28 — tickets
01/02 were restored from the reviewer's context with their resolved statuses;
if git history and these files disagree, the mnemo notes
[S15069/T1878][S15069/T1893] are the authority.
