# 09 — Measure by provenance

**What to build:** spec D8; replaces read-once ticket 07. On the reset window through the v13 harness (`scratchpad/v13ab/`): edges per window by provenance; previous-turn share and mean gap by provenance (baseline settlement 47.9%, main-agent era 37.7%); attribution outcomes per side; E6/E4 counts; settlement round trips and dollars vs the 0.29.0 baseline ($3.45 edge pass); work equivalence (commit succeeds; audit coverage equal; lanes/members/edges equal or explained). Success stated up front: edge-pass cost falls; previous-turn share ≤ 48%; ambiguous and invalid at commit both 0. n=1 reported as directional.

**Blocked by:** 01–08.

**Status:** ready-for-agent (after all)

## Constraints

- `~/.claude-mnemo/` is production data and STRICTLY READ-ONLY; measure on a `cp -c` clone of the scratchpad copy.
- NEVER `git stash` / `checkout` / `checkout-index` / `restore` / `reset` / `clean`. Restore from your own `cp` copies, md5-verified.
- Explicit pathspecs on every `git add`. No raw control bytes. `grep -c anthropic-ai plugin/scripts/worker.cjs` stays `0`.
- Every teaching sentence added or removed is pinned by a test a mutation drives red. ≥3 mutation probes of your own, RED, md5-restored — and a probe whose mutation did not apply is not a probe.
- Dispose of every applicable line of `../acceptance-matrix.md` in your report.
- [ ] `npx tsc --noEmit` clean (excludes `tests/`; typecheck new tests separately); full `bun test` once with every delta accounted; `npm run build`; stale-bundle and release-artifacts guards green; `git diff --check` clean. No version bump, no push.
