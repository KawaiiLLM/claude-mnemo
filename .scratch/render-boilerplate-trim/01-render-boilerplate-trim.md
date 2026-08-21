# 01 — Render boilerplate trim: bare ellipsis marker, ancestor header without narrative, stale-title ruling

**What to build:** A recall/timeline response spends ~25% of its bytes on repeated
boilerplate — measured over the 13 real recall calls of S15069/T1152–T1155
(~3.3K tokens; single-item drills lose ~50% of the response to fixed overhead).
Three cuts plus one ruling, smallest-value item last:

## 1. Budget marker becomes a bare `…` line

`TURN_BUDGET_TRUNCATION_MARKER` (src/mcp/format.ts:38) shrinks from the 46-char
sentence to a lone `…` line.

- Rationale: a budget-capped block already ends with `…` via
  `truncateTextToTokenBudget`, and `NAVIGATION_LEGEND` explains the ellipsis
  convention once per response — the sentence restates it per item, against the
  same file's own D1 comment (format.ts:58: discoverability is a property of
  the WHOLE response). Fired 55 times in the 13-call baseline (~630 tokens).
- The marker's ONE non-redundant duty survives as the lone line: when the last
  kept line fits whole and the following lines are dropped silently, no `…`
  appears in the kept text — the bare marker line is what still shows a cut
  happened (capRenderToTokenBudget's `remaining <= 0` branch, format.ts:633).
- Keep it charged inside the per-item budget (format.ts:631) — the reservation
  shrinks from ~11 tokens to ~1, returning ~8% of every capped 150-token card
  to payload.
- `tests/mcp/recall.segments.test.ts` pins the sentence — update it.

## 2. Turn-addressed selectors render the session ancestor as id + title only

When a recall selector addresses turns (`id="S<n>/T…"` forms, turn-level query
hits), the session header drops its `- content:` line; a session-addressed
call (`id="S<n>"`) keeps the full render. The narrative line cost ~1400 tokens
across the baseline on calls where nobody asked about the session.

- Check the segment ancestor line for the same pattern while there.
- Field-completeness recording: header content rows simply stop being recorded
  on turn-scoped calls — confirm no gate consumer depended on them (the write
  gate only gates turn/segment note fields; expected no-op).

## 3. Legend slim (optional, least value)

Tighten `NAVIGATION_LEGEND` wording without losing its three duties: the
ellipsis convention, bracketed ids as addresses, `+N more` reachable via
`timeline(view="turns")`. Keep the no-id-shape rule (format.ts:153 comment —
a legend that names a shape goes stale with the renderer).

## 4. Stale-title ruling (verified finding, needs an owner)

`sessions.title` for the standing session froze in the 0.11 era while
settlement keeps `sessions.content` fresh (`sessionNarrativeWritten`,
src/worker/note-settlement-direct-write.ts:152) — the title writer is the
session-end summary path, which a never-ending session never reaches. The
always-rendered header line is the STALE half. Rule where title refresh lives
(settlement's narrative write also refreshes title / a periodic re-summary /
the header falls back to the content lead) and implement it, or record why the
freeze is acceptable.

> **Disposition 2026-08-21: deferred to a settlement-side ticket.** Title
> refresh belongs to the settlement narrative contract — the agent prompt, the
> commit payload and the direct-write path change together, and smuggling a
> settlement-contract change into a render ticket mixes two concepts. Until
> that ticket lands the header renders the stale title; mitigated here by cut
> #2 removing the narrative line from turn-addressed calls. Overrule welcome.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Budget-capped blocks end with a lone `…` line; the sentence "truncated
      to fit the per-item token budget" appears nowhere in src or the rebuilt
      bundles.
- [ ] A test pins the dropped-whole-lines corner: last kept line fits whole,
      following lines dropped → the bare `…` line still appears (this is the
      marker's only non-redundant duty; without the pin, cut #1 could silently
      delete the marker outright and stay green).
- [ ] `recall(id="S<n>/T…")` responses carry no session `- content:` line;
      `recall(id="S<n>")` still does.
- [ ] Legend still appears exactly once per truncated response and not at all
      on an uncut response (TruncationSignal gating untouched).
- [ ] A default 5-item browse call sheds ≥200 tokens against the 0.13.0
      baseline.
- [ ] Stale-title ruling recorded and implemented, or explicitly deferred with
      rationale.
- [ ] Full suite green; plugin/skills docs re-checked (SKILL.md teaches the
      budgets, not the marker sentence — expected unchanged, verify).
