# 06 — Settlement's edge pass: declare, fill, review — and the delta formulas

**What to build:** spec D6's teaching; replaces read-once ticket 05. Stage 2 finds the main agent's edges present; it declares ambiguous sides, fills what was missed, reviews (retract, `lane_check`, debts, impressions, commit). `finalize` computes and prints, inside the transition transaction after all stage-1 writes: `finalWritableIds = frozenWritableIds ∪ derivedDebtCiters`; `writableDelta = finalWritableIds − initialWritableIds` (relation-only authority for derived-side citers); `declarationEndpointIds = endpoints(live outgoing rows whose citer ∈ finalWritableIds)`; `contextDelta = (⋃ laneMembers(post-write) ∪ declarationEndpointIds) − initialWritableIds − writableDelta` — one hop. Stage 2 reads the union once (paginated), then nothing until the gate names a changed turn. The old "recall members with relations" / "before any edge write recall the citing turn" / stage-2 "batches of ten" sentences go (`note-settlement-prompt.ts` included). Multi-lane citing turns: one placement per pair, both sides named, decided once over the worklist.

**Blocked by:** None — 04 landed on main (735666db).

**Status:** ready-for-agent

- [ ] Delta tests: an initial-set address never appears in a delta; a lane member added by stage 1 and a remote cited endpoint each appear in `contextDelta` once and are read once; a `contextDelta` member refuses a relation write; a `writableDelta` member accepts one and refuses a note-field write.
- [ ] Teaching pinned; retired sentences absent from rendered text.

- [ ] **Revert probe (standing acceptance step for this batch):** for every teaching sentence you replace and every formula you implement, revert it to the pre-ticket text/behaviour, run the suite, and name in the report WHICH test went red. A `toContain` on a sentence is not a pin of the behaviour it teaches. Verify each mutation applied before trusting its output; md5-restore after.

## Constraints

- `~/.claude-mnemo/` is production data and STRICTLY READ-ONLY; measure on a `cp -c` clone of the scratchpad copy.
- NEVER `git stash` / `checkout` / `checkout-index` / `restore` / `reset` / `clean`. Restore from your own `cp` copies, md5-verified.
- Explicit pathspecs on every `git add`. No raw control bytes. `grep -c anthropic-ai plugin/scripts/worker.cjs` stays `0`.
- Every teaching sentence added or removed is pinned by a test a mutation drives red. ≥3 mutation probes of your own, RED, md5-restored — and a probe whose mutation did not apply is not a probe.
- Dispose of every applicable line of `../acceptance-matrix.md` in your report.
- [ ] `npx tsc --noEmit` clean (excludes `tests/`; typecheck new tests separately); full `bun test` once with every delta accounted; `npm run build`; stale-bundle and release-artifacts guards green; `git diff --check` clean. No version bump, no push.

**Ticket-03 escape (peer review, S15069/T2438, F1):** `note-settlement-prompt.ts` ~1197–1198 still teaches, under HOMELESS RETRACTION, that "when it was the pair's last relation the bare citation comes back" — `restoreBareRowsForEmptiedPairs` was deleted by ticket 03 and `tests/worker/note-settlement-prompt.test.ts` ~2593 pins the false sentence with a shallow `toContain`. Remove the sentence and its pin here; also the pre-existing false "prose mention warning" teaching at ~1050–1058 (nothing implements it).
