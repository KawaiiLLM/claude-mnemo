# 02 — Stranded repair stops taking sidechain turns as completion evidence (peer P1-2)

**What to build:** `src/worker/turn-liveness.ts` (~77-92) treats ANY
higher prompt_number as proof an earlier turn finished, while the formal
settlement predicate (`src/db/turn-settlement.ts:56-74`) already
excludes born-undone sidechain rows via `realPromptPredicate("later")`.
A still-running root with an in-flight subagent can therefore be
prematurely finalized by the closed-day repair — and since the response
floor now lands response-carrying holes as `extracted`, the root gets a
terminal status while its children still write. Reuse the SAME predicate
(one home, no copy) in the stranded repair's completion-evidence query.

Regression fixture the 5c3187e follow-through missed: a root turn plus a
LATER born-undone sidechain row — the repair must NOT finalize the root;
a later REAL prompt still does.

**Blocked by:** None.

**Status:** ready-for-agent

- [ ] Sidechain-only successor → root stays unfinalized; real successor →
      finalized as before
- [ ] The predicate is imported/shared, not restated
- [ ] Territory: src/worker/turn-liveness.ts, tests/worker/
      turn-liveness.test.ts (+ the predicate's export site in
      src/db/turn-settlement.ts if visibility needs widening)
- [ ] Load-bearing properties declared for mutation acceptance
