# 08 — Lane controls C1, C3, C4 are retired

**What to build:** spec D10. Delete `src/cli/lane-controls-cli.ts`'s C1 (blank sides), C3 (lane-less endpoints) and C4 (sampled side audit) with their tests and any documentation that teaches them; nothing replaces them (E6 accounting lives in `lane_check`; lane-less edges are legal; declarations are validated at write).

**Blocked by:** None.

**Status:** ready-for-agent

- [ ] Grep proves no reference remains in `src/`, `plugin/skills/`, docs; the CLI's remaining controls (if any) still run.

## Constraints

- `~/.claude-mnemo/` is production data and STRICTLY READ-ONLY; measure on a `cp -c` clone of the scratchpad copy.
- NEVER `git stash` / `checkout` / `checkout-index` / `restore` / `reset` / `clean`. Restore from your own `cp` copies, md5-verified.
- Explicit pathspecs on every `git add`. No raw control bytes. `grep -c anthropic-ai plugin/scripts/worker.cjs` stays `0`.
- Every teaching sentence added or removed is pinned by a test a mutation drives red. ≥3 mutation probes of your own, RED, md5-restored — and a probe whose mutation did not apply is not a probe.
- Dispose of every applicable line of `../acceptance-matrix.md` in your report.
- [ ] `npx tsc --noEmit` clean (excludes `tests/`; typecheck new tests separately); full `bun test` once with every delta accounted; `npm run build`; stale-bundle and release-artifacts guards green; `git diff --check` clean. No version bump, no push.
