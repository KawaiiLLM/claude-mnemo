# 10 — `shadow_notes.writer_model` is empty for some notes

**What to build:** the peer's fork experiment (S15069/T2430) found `writer_model = ''` on all three fork-written notes and 353 empty rows corpus-wide; the `note` result carried no `writer_model:` field for those. Find where the model attribution is derived, why it is empty (subagent context? missing env? a code path that skips it), fix it, and decide whether the 353 legacy rows are backfilled (from the session's transcript model) or left with a receipt.

**Blocked by:** None. Independent of the batch.

**Status:** ready-for-agent

## Constraints

- `~/.claude-mnemo/` is production data and STRICTLY READ-ONLY; measure on a `cp -c` clone of the scratchpad copy.
- NEVER `git stash` / `checkout` / `checkout-index` / `restore` / `reset` / `clean`. Restore from your own `cp` copies, md5-verified.
- Explicit pathspecs on every `git add`. No raw control bytes. `grep -c anthropic-ai plugin/scripts/worker.cjs` stays `0`.
- Every teaching sentence added or removed is pinned by a test a mutation drives red. ≥3 mutation probes of your own, RED, md5-restored — and a probe whose mutation did not apply is not a probe.
- Dispose of every applicable line of `../acceptance-matrix.md` in your report.
- [ ] `npx tsc --noEmit` clean (excludes `tests/`; typecheck new tests separately); full `bun test` once with every delta accounted; `npm run build`; stale-bundle and release-artifacts guards green; `git diff --check` clean. No version bump, no push.
