# 03 — The segment milestone card splits recent-200 from everything earlier, half budget each

**What to build:** the SessionStart segment milestones card (the `[E<n>] ·
milestones` block) runs TWO independent elections instead of one: the segment's
most recent 200 member turns (by member time, across sessions) are the RECENT
side, every earlier member the OLD side; each side elects and renders under
half the card's 2000-token budget. One side without milestone rows → the other
renders alone under the full budget. The result stays ONE block in ONE hook
slot.

**Blocked by:** 02 — the budget-is-the-seat-count mechanics this rides on;
same territory, serialize.

**Status:** resolved — landed as `1317d61`; every criterion re-checked per-item
from the worker's report and independently spot-verified (three central test
files 50/0, suite 3926/0, `tsc` clean, and a reviewer-run mutation of
`half = Math.floor(pageBudget/2)` → `pageBudget` turned the recency-guarantee
test red, restored byte-identical, green). Real-DB E70 smoke: 17 rows in two
parts, OLD 07-29→08-10 (9 rows) + RECENT 08-12→08-15 (8 rows), one
`[E70] · milestones` header, 2504 chars / 692 honest tokens. FINDINGS
accepted: (1) the newest visible row reaches 08-15, not the ticket's
speculated 08-2x — the worker read this as the election still burying newer
work inside the recent window, and the reviewer repeated it; a read-only
histogram of E70's newest 200 members REFUTES that framing: they span
08-11..08-14 (199 turns) plus exactly ONE stray member on 08-26. There is
almost no post-08-15 work in this segment to seat. The split does what it
claims; 08-15 is the honest edge of the data, not a starvation symptom. What
remains true and unproven either way is the weaker statement: a single newest
turn is not guaranteed a seat, because it still competes on rank within its
own side; (2) row count DROPS 23→17 because the
fixed chrome is now paid twice — see the follow-up below; (3) removing the
`timelineQuery` call from session-composition made the whole S-view fitter
branch unreachable from `hook-command.cjs`'s bundle graph, so the
release-artifacts stale-bundle sentinel re-pins to `buildSplitSegmentMilestoneCard`
(expected consequence, not a regression); (4) within-tier tiebreak is
recency-DESC, so a budget cut admits the LATEST-created candidate of a tier
first — fixture-writing trap, recorded.

**Follow-up (not a defect against this ticket):** the two parts each re-render
the segment title line, the session line and the whole Legend paragraph — 99
honest tokens of pure duplication (23 + 22 + 54) out of 692, and roughly 2.5×
that against the fitter's inflated budget, which is most of why 23 rows became
17. Criterion 4 asked for one `[E<n>] · milestones` header and got it; the
chrome BELOW that header was never in scope. Candidate ticket 05.

## Why

User rulings 2026-08-28 [S15069/T1880][S15069/T1881]: injected milestones
should guarantee recency its own half rather than letting old high-in-degree
anchors starve the newest work — the same disease the session-arc renderer was
cured of (`MILESTONE_INJECTION_RECENT_TURNS`, the E60 "+676 more" regression)
— and the segment card is now the ONLY milestone surface the main agent
receives (the session-arc injection to the main agent is already retired; its
renderer survives solely as settlement-agent context, kept). Evidence: E70's
card seats zero of S15440's newest ~280 turns.

## Decisions (settled — implement as given)

1. **Boundary = the segment's newest 200 member turns**, ordered by the same
   member time the card's rows already use. Cross-session: a segment spanning
   sessions counts members, not prompt numbers. Reuse the 200 constant's
   VALUE; whether by importing the existing constant or a segment-side twin,
   state which and why.
2. **Half budget each (1000/1000)**, one-side-empty → full 2000 to the other
   (byte-identical to a segment under 200 members total, which must render
   exactly as today). Same fallback shape as `renderSessionMilestoneInjection`.
3. **Two elections, independent** — a candidate competes only within its side.
   Post-ticket-02 semantics apply within each side: rank orders, the half
   budget seats. `↳` sub-rows stay scoped to rows rendered in the SAME output.
4. **One block, one hook slot.** The two renders concatenate under the single
   `[E<n>] · milestones` header — never a second hook slot (the one-slot-one-
   block rule is a hard constraint; two independently sized blocks in one slot
   was the delayed-detonation bug of 2026-08-19).
5. **The demote ladder still governs the whole block** (2000 → 1000 → 500 char
   re-render on size breach, then hard truncation) — it wraps the composed
   two-part render, not each part.
6. **Settlement-agent context untouched.** `renderSessionMilestoneInjection`
   and its constants keep serving `note-settlement-context.ts`; if the 200
   constant is shared, the sharing must not couple the two renderers' budgets.
7. **MCP `timeline(id="E<n>", view="milestones")` untouched** — the split is
   an injection-card decision, not a query-surface one. If the card stops
   being byte-identical to the MCP view's output, that is EXPECTED and the
   test pinning their equality (if any) updates to pin each surface's own
   shape; say so in the report.

## Acceptance criteria

- [x] On a fixture segment with >200 members where all high-in-degree anchors
      are OLD: the card still shows recent-side rows — the starvation case,
      asserted on both sides' presence.
- [x] A segment with ≤200 members renders byte-identical to the pre-split
      card — asserted.
- [x] One side with zero milestone rows → the other side renders under the
      full budget — asserted.
- [x] The block stays ONE hook-slot payload with ONE `[E<n>] · milestones`
      header — asserted (header count == 1).
- [x] `↳` sub-rows reference only rows rendered in the same output — asserted
      across the split boundary (a recent-side row citing an old-side-dropped
      turn must not produce a dangling ↳).
- [x] Settlement context rendering byte-identical on a fixture — asserted.
- [x] Every new/changed test mutation-verified: name the observable, backup
      AFTER the implementation lands, assert the needle matched and PRINT that
      it applied, red, restore byte-identical, green.
- [x] `npx tsc --noEmit` clean, `node scripts/build.js` succeeds, `bun test`
      green; report the number and account for every delta.

## Out of scope

The session-arc renderer's own split (already exists, settlement-only); the
fields card; the roster; election tiers and sort keys (ADR-0013); injection
budget constants' values; any version bump or push.

## Notes

Production database read-only (`sqlite3 -readonly`); use fixtures or a /tmp
copy for end-to-end smoke. Do not tick your own acceptance boxes — report
per-item; the reviewer ticks. Natural smoke: E70 card on a /tmp copy — expect
recent-side rows from S15440's newest ~280 turns to appear for the first time.
