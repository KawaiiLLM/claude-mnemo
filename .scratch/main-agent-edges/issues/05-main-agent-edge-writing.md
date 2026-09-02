# 05 — The main agent writes edges

**What to build:** spec D3. The Memory Rubric's main-agent actions half gains the edge duty in two sentences (what this turn used, corrected or verified — the cited turn's principal result, not a detail; correct > verify > use; one edge per pair; the caps); the public `note` accepts bare three-class entries (03's union) and refuses two-sided ones; the tool description teaches the form; the rubric's byte-pinned source under `.scratch/lane-model-v12/` is updated with it (that file may be staged for this reason only).

**Blocked by:** 03.

**Status:** ready-for-agent (after 03)

- [ ] Rubric sentences pinned; a mutation that drops the duty is red; the settlement teaching's "边由结算书写" sentence and its relatives revised to the new division (settlement declares, fills, reviews).

## Constraints

- `~/.claude-mnemo/` is production data and STRICTLY READ-ONLY; measure on a `cp -c` clone of the scratchpad copy.
- NEVER `git stash` / `checkout` / `checkout-index` / `restore` / `reset` / `clean`. Restore from your own `cp` copies, md5-verified.
- Explicit pathspecs on every `git add`. No raw control bytes. `grep -c anthropic-ai plugin/scripts/worker.cjs` stays `0`.
- Every teaching sentence added or removed is pinned by a test a mutation drives red. ≥3 mutation probes of your own, RED, md5-restored — and a probe whose mutation did not apply is not a probe.
- Dispose of every applicable line of `../acceptance-matrix.md` in your report.
- [ ] `npx tsc --noEmit` clean (excludes `tests/`; typecheck new tests separately); full `bun test` once with every delta accounted; `npm run build`; stale-bundle and release-artifacts guards green; `git diff --check` clean. No version bump, no push.
