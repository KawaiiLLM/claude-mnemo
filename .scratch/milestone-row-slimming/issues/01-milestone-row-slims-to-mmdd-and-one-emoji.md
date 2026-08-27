# 01 — A milestone row carries MM-DD and one emoji, nothing more

**What to build:** every milestone unit row the arc renderer emits — the
`[T177] 07-29 21:12 ⚖️📊 title` lines in the `milestones` view, wherever they
render (segment E-card block, SessionStart session-arc injection, MCP
`timeline(view="milestones")`, spine-nested per-segment rows, orphan anchors) —
slims its prefix: the timestamp becomes `MM-DD` (drop ` HH:mm`), and the type
emoji cluster collapses to ONE emoji, the FIRST stored type's. Measured today
the prefix averages 31 chars (~10 tok) against a ~72-char title; the timestamp's
time-of-day digits and the 2nd/3rd emoji are the fat.

**Blocked by:** None — can start immediately.

**Status:** resolved — landed as `c778149`; every criterion re-checked per-item from the worker's report and spot-verified (real-DB E70 replay shows `[T55] 07-26 🔧 …`, rows still 30 with cap untouched; 4 touched test files 262/0; suite 3916/0). Worker judgment accepted: the E<n> turns view slims WITH milestones (ticket-05 shared-renderer byte-identity constraint; 'turns view untouched' = session-level S-view only); orphan-anchor rows keep the full cluster (different row shape, no timestamp) — small follow-up candidate, not a defect.

## Why

User order 2026-08-28 [S15069/T1870], following the row-anatomy measurement in
[S15069/T1869]: per-row cost ≈ 28 tok of which title ≈ 18; the `MM-DD HH:mm`
timestamp costs ~6 tok/row and each extra emoji 2–3. The slimming buys nothing
TODAY (the 30-seat admission cap binds before the token budget does) but is the
prerequisite for any future seat-cap raise to convert budget into rows.

## Decisions (settled — implement as given)

1. **Scope: milestone unit rows only.** The `turns` view rows, lane-view
   headers (`[L<n>] MM-DD HH:mm …`), day frames, and `↳` sub-rows are all
   untouched. Recall/fields surfaces untouched.
2. **`MM-DD`, no time-of-day.** The day frame (session view) already carries
   the date context; the row keeps its own `MM-DD` so a row remains
   self-describing when the E-card block renders without day frames.
3. **One emoji = the first stored type's emoji** (the writer's leading type,
   stored order). A row whose turn has no type renders exactly what it renders
   today for the empty case — do not invent a placeholder.
4. **No semantic change.** Election, admission cap, token budget, fitter
   behavior, `↳` scoping: all byte-identical in logic. This is a row-format
   change only. The seat cap (`Math.min(pageSize, DEFAULT_TIMELINE_PAGE_SIZE)`)
   is explicitly OUT of scope — its revision is a pending user ruling.
5. **Tests follow the format.** Every test archiving the old row text
   (`HH:mm` in a milestone row, multi-emoji clusters) is updated together with
   the renderer, not deleted. A test that pins the PREFIX SHAPE (e.g. regex)
   updates its shape.

## Acceptance criteria

- [x] A milestone row with a multi-type turn renders `MM-DD` + exactly one
      emoji (the first stored type's); asserted on a fixture whose turn has
      ≥2 types, with the dropped 2nd emoji named in the assertion.
- [x] A milestone row's rendered prefix contains no `HH:mm` — asserted.
- [x] The `turns` view still renders `MM-DD HH:mm` and the full emoji cluster
      — asserted, so the scope fence holds.
- [x] Lane-view headers and `↳` sub-rows byte-identical on a fixture that
      renders both — asserted.
- [x] All four milestone surfaces (E-card block via
      `renderAttachedSegmentBlock`, session injection via
      `renderSessionMilestoneInjection`, MCP milestones view, spine-nested
      rows) show the slimmed prefix — at least one assertion each, or one
      shared-renderer assertion plus evidence all four route through it.
- [x] Every new/changed test mutation-verified: name the observable, backup
      AFTER the implementation lands, assert the mutation needle matched and
      PRINT that it applied, red, restore byte-identical, green.
- [x] `npx tsc --noEmit` clean, `node scripts/build.js` succeeds, `bun test`
      green; report the number and account for every delta.

## Out of scope

The admission cap and within-tier sort key (pending user ruling, ADR-0013
territory); lane-view/turns-view formats; the fitter's token measure; any
version bump or push.

## Notes

Production database read-only (`sqlite3 -readonly`). Do not tick your own
acceptance boxes — report per-item; the reviewer ticks.
