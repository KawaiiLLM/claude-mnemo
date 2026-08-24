# 05 — The console shows an edge in every lane it belongs to

**What to build:** with an edge now able to belong to several lanes, the console stops picking one. Focusing a lane highlights every edge that carries its tag, including edges shared with another lane.

**Blocked by:** 03.

**Status:** ready-for-agent

Spec: `.scratch/lane-declaration/spec.md` (Rev 2) — D9's withdrawal and peer finding P1-6.

- [ ] The shell reads `laneTokens` (plural) and indexes each edge under every one of them.
- [ ] Focusing lane `a` highlights an `{a,b}` edge; focusing `b` highlights the same edge; clearing focus restores both.
- [ ] The lane strip's counts and the panel's per-turn lane chips reflect set membership, not the first tag.
- [ ] No regression in the existing focus/highlight/strip tests; the ones that assumed one token per edge are rewritten to the set reading rather than deleted.

**File ownership:** `src/worker/console-shell.html` (regenerate `console-shell.ts` via `bun scripts/generate-console-shell.ts`) and its tests. `src/worker/console-api.ts` belongs to ticket 03 — read it, do not edit it.
