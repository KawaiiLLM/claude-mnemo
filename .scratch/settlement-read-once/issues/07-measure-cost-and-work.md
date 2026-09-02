# 07 — Measure: cost AND the same settlement work, on the reset window

**What to build:** the number that says whether this batch did what it claimed — a before/after on identical material through the shadow harness already built for v13 ticket 06 (`scratchpad/v13ab/`, `round2_reset.sh`) — reported honestly as n=1.

**Blocked by:** 01–06.

**Status:** ready-for-agent (after 01–06)

- [ ] Before/after on the same reset window (S18993/T101–150 or a current one, stated): round trips per stage, `recall` calls per stage, finalize-delta page calls, `cut`/`dropped` re-reads, peak context, cache read/creation, dollars at the verified price sheet.
- [ ] Work equivalence against the baseline run: commit succeeds; title/type/tags audit coverage equal; lanes, members, edges, E4/E6 counts equal or explained; one-placement-per-pair held.
- [ ] Report n=1 as directional; the spec's −40–50% is the hypothesis under test, not a claim; if the go/no-go in 01 reported fewer turns/page than 15, restate the hypothesis from the measured figure.
- [ ] Kill every arm worker at the end; production untouched (clone only).

## Constraints

- `~/.claude-mnemo/` is production data and STRICTLY READ-ONLY. Measure on a `cp -c` clone of the scratchpad copy.
- NEVER `git stash` / `checkout` / `checkout-index` / `restore` / `reset` / `clean` in the shared tree. Restore from your own `cp` copies, md5-verified.
- Explicit pathspecs on every `git add`. No raw control bytes in source. `grep -c anthropic-ai plugin/scripts/worker.cjs` stays `0`.
- Every teaching sentence added or removed is pinned by a test a mutation drives red. At least three mutation probes of your own, RED, md5-restored.
- [ ] `npx tsc --noEmit` clean (excludes `tests/`; typecheck new tests separately); full `bun test` once (account for every delta against the baseline in your brief); `npm run build`; stale-bundle and release-artifacts guards green; `git diff --check` clean. Do NOT bump any version and do NOT push.
