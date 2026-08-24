# 06 — A segment card lists the lanes that live in it

**What to build:** the injected segment card gains a `lanes` row, so a writer sees which lanes already exist before inventing a duplicate — the whole reason the duplicates multiplied.

**Blocked by:** 03.

**Status:** ready-for-agent

Spec: `.scratch/lane-declaration/spec.md` (Rev 2) — D7.

- [ ] Rendered as `tag ◎<addr>` for a declared terminus and `tag <addr>` (the lane's newest node) when undeclared — the absence of `◎` carries "undeclared" without spending a word on it.
- [ ] `→<addr>` is appended ONLY when the terminus is no longer the newest node.
- [ ] Addresses use the segment form `E<segment>/T<globalTurnId>`.
- [ ] Newest-lane-first, truncated against the card's own budget with a `+N 条` tail. On today's E60 (63 lanes ≈ 1449 injector-tokens at full length) the cap must actually bite — a test pins that the row respects the budget rather than blowing the card.
- [ ] Tests cover the three row shapes and the truncation tail.

**File ownership:** `src/mcp/segment-card.ts` and its tests.
