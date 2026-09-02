# 07 — The `relations` field shows resolved attribution

**What to build:** spec D2/D8 marks on top of read-once ticket 06's direct-edge renderer (landed): each side rendered as declared / derived / ambiguous / none / invalid (`invalid (stored #old)`), replacing raw-side grouping and `[unplaced]`; the class word is the only relation word rendered; `timeline(id="S/T")` keeps its tree but renders class words; the tool description and the legend say qualifiers are the endpoints' CURRENT tasks and advisory.

**Blocked by:** 02.

**Status:** ready-for-agent (after 02)

- [ ] Fixtures for all five outcomes; a two-placement legacy pair is NOT a case any more after 01 — until 01 lands, such a pair renders one row per physical row with its raw declaration (no `legacy` mark machinery beyond that).

## Constraints

- `~/.claude-mnemo/` is production data and STRICTLY READ-ONLY; measure on a `cp -c` clone of the scratchpad copy.
- NEVER `git stash` / `checkout` / `checkout-index` / `restore` / `reset` / `clean`. Restore from your own `cp` copies, md5-verified.
- Explicit pathspecs on every `git add`. No raw control bytes. `grep -c anthropic-ai plugin/scripts/worker.cjs` stays `0`.
- Every teaching sentence added or removed is pinned by a test a mutation drives red. ≥3 mutation probes of your own, RED, md5-restored — and a probe whose mutation did not apply is not a probe.
- Dispose of every applicable line of `../acceptance-matrix.md` in your report.
- [ ] `npx tsc --noEmit` clean (excludes `tests/`; typecheck new tests separately); full `bun test` once with every delta accounted; `npm run build`; stale-bundle and release-artifacts guards green; `git diff --check` clean. No version bump, no push.
