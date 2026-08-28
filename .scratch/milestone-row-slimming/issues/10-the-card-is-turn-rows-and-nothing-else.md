# 10 — The milestones card is turn rows and nothing else

**What to build:** the injected segment milestones card stops rendering its
chrome. User ruling 2026-08-28 [S15069/T1907]: "timeline里程碑不要渲染标题/
会话行/Legend，只需展示turn". Gone from the card body: the per-side
`[E<n>] <segment title>` header line, every `[S<n>] <session title>`
transition line, and the whole Legend paragraph. What remains: turn rows,
their `↳` sub-rows, and the `… +N more` overflow pointer.

**Blocked by:** 08 (landed, `c4c8219`). Supersedes ticket 05 (the ruling
answers its open question: the parts get no labels at all) and is expected to
dissolve ticket 09 (the per-side reserve shrinks to almost nothing, so both
sides can afford rows at every ladder rung — measure and confirm).

**Status:** resolved — landed as `0fa7741`; every criterion re-checked per-item
and independently spot-verified. Suite 3947/0 (3942 + 5 net-new), `tsc` clean.
Real E70 card: 60 rows / 6833 chars / 1804 tokens → **74 rows / 7620 chars /
1975 tokens**. Overshoot sweep 0/3920 with worst utilization now 99.7% (the
freed reserve is being spent almost to the last token); max card 7982 chars
against the 9500 guard. Reserve: `CARD_POINTER_RESERVE_TOKENS = 10` (worst
6-digit demoted-count pointer measures 6), legend reserve 0. Reviewer mutation
changing the marker rule from per-run to once-ever turned the interleave test
red (restored byte-identical, green) — the trap the worker itself reported
(cross-side seam is a string join, so the interleave fixture must live within
one side) is real and the test guards it.

**TICKET 09 CONFIRMED DISSOLVED**, measured on the live rung set: E60@500 now
16 rows reaching 08-28 (was 8 rows fossilized at 08-24); E60@1000 30 rows;
E60@2000 63 rows — every rung reaches today. Closed without ever being ruled,
as its option 3 predicted.

Worker findings accepted: (1) the mid-flight amendment arrived AFTER full
qualification was implemented; that shape was discarded per instruction;
(2) shared-renderer coupling resolved via an opt-in `cardMode` flag threaded
through `selectSegmentMilestonesByEdgeSignals` — the MCP view and S-view
spine callers stay byte-identical by defaulting it unset; (3) ticket 03's
"≤200-member byte-identity to the MCP view" is DESIGNEDLY retired — two
tests now assert divergence plus turn-set equivalence; (4) ASCII fixtures
stopped exercising reserve starvation under the honest currency (~0.25
tok/char) — five fixtures retuned to CJK with empirically measured budgets;
(5) `renderTurnAddress`'s `includeSessionPrefix` produces `[S<n>][T<m>]`,
NOT the rubric's `[S<n>/T<m>]` — recorded as a trap for any future
per-row-qualification revisit.

## Why

The ruling followed a live read of the first 0.24.0-rendered card
[S15069/T1906]: the chrome was measured at 215 honest tokens of 692 pre-04
(99 of them duplicated per side), the session line was amplifying a
five-week-stale session title into every injection, and the Legend repeats
per side. The user's answer deletes the category rather than deduplicating it.

## Decisions (settled — implement as given)

1. **Scope: the injected segment card only** (`buildSplitSegmentMilestoneCard`
   and the side renderer it uses). The MCP query surface
   `timeline(id="E<n>", view="milestones")` keeps its render — ticket 03
   decision 7's precedent: an injection-card decision, not a query-surface
   one. The settlement-agent context (`renderSessionMilestoneInjection`) is
   untouched. The S-view is untouched.
2. **The one-line slot header `[E<n>] · milestones` stays.** It is added by
   `renderAttachedSegmentBlock` outside the card body and is the block's
   identity in the hook slot; without it the list is unattributable. It is
   not the banned segment-title line.
3. **Rows keep bare `[T<m>]` addresses; a bare session marker line `[S<n>]`
   (address only, NO title) opens each run of consecutive same-session rows**,
   re-emitted at every session switch. AMENDED by user ruling 2026-08-28
   [S15069/T1910], choosing the cheaper of the two forms rendered side by
   side in [S15069/T1909] (~2 tok per switch vs ~1.75 tok per row; E60's
   card interleaves sessions 3 times, so 4 markers ≈ 8 tok against ~84).
   The T1907 ban is on TITLE-carrying session lines; the bare marker is not
   one. Accepted trade-off, stated so nobody relitigates it: citing a row
   means joining the nearest marker above with the row
   (`[S15069]` + `[T1898]` → `S15069/T1898`) — the pasteability of full
   per-row qualification was offered and declined on cost.
4. **`↳` sub-row addresses keep their existing convention** — bare `T<m>`
   means the parent row's session, cross-session cites are already
   qualified. The group's `[S<n>]` marker supplies the session, so the
   convention is still locally readable.
5. **The two sides concatenate with no separator and no boundary marker.**
   OLD's members are strictly earlier than RECENT's, so the result reads as
   one chronological list. The ruling says only turns; the boundary is a
   selection mechanism the reader does not need to see.
6. **The reserves re-derive.** The legend reserve goes to zero; the
   header/pointer reserve covers only the `… +N more` pointer (and whatever
   worst case that line has). State the new numbers and the arithmetic.
   The freed budget buys rows — report the new E70 row count at 2000.
7. **Ticket 09's scenario re-measures.** E60 at budget 500 currently renders
   only the OLD side because the reserve ate the RECENT half. With the
   reserve near zero, both sides should afford rows at every rung
   (2000/1000/500). Run the probe; if the starvation is gone, say so — that
   closes 09 as dissolved; if any budget still starves a side, report which.
8. **Out of scope:** the MCP views; settlement context; election tiers and
   sort keys (ADR-0013); the demote ladder; the recent/old boundary value;
   the fitter's search; session-title maintenance (a separate pending
   ruling); any version bump or push.

## Acceptance criteria

- [x] The card body contains no segment-title line, no title-carrying
      session line, no Legend — asserted on a fixture spanning two sessions;
      the bare `[S<n>]` marker is the only session artifact present.
- [x] Rows keep bare `[T<m>]`; a bare `[S<n>]` marker opens every run of
      same-session rows and re-appears at each switch — asserted on a fixture
      whose sessions interleave (marker count == switch count + 1), and on a
      single-session segment (exactly one marker, at the top).
- [x] `↳` sub-rows still resolve: bare `T<m>` under a parent row, qualified
      for cross-session — asserted on a fixture exercising both.
- [x] One `[E<n>] · milestones` slot header, zero other headers — asserted.
- [x] The `… +N more` pointer still renders when rows are demoted — asserted.
- [x] New reserve numbers stated with their worst-case arithmetic; no card
      exceeds its budget on the full overshoot sweep
      (`/tmp/overshoot-probe.ts`, ~3920 cases) — zero overshoots reported
      with the worst utilization.
- [x] Real E70 card at 2000: report rows/chars/honest tokens before and
      after (before: 60 rows / 6833 chars / 1804 tokens).
- [x] E60 at budgets 2000/1000/500: report per-side row presence; state
      whether ticket 09's starvation case still exists.
- [x] MCP `timeline(id="E<n>", view="milestones")` output byte-identical to
      pre-ticket — asserted.
- [x] Settlement context byte-identical — asserted by non-modification plus
      its test file staying green.
- [x] Every new/changed test mutation-verified: name the observable, back up
      AFTER the implementation lands, assert the needle matched and PRINT
      that it applied, red, restore byte-identical (md5), green.
- [x] `npx tsc --noEmit` clean, `node scripts/build.js` succeeds, `bun test`
      green; baseline is 3942/0 — report the number and account for every
      delta.

## Notes

Production database strictly read-only (`sqlite3 -readonly` or
`new Database(path, {readonly: true})`). Do not tick your own acceptance
boxes — report per-item; the reviewer ticks.
