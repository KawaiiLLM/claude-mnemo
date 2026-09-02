# 04 — Stage 1 works topic-first

**What to build:** after the one read, the settlement writer lists the window's topics, declares a lane where no synonymous lane exists, tags each topic's turns in one call per topic, corrects the few titles/types/tags the audit caught, and finalizes. Spec D3.

**Blocked by:** 02.

**Status:** ready-for-agent (after 02)

- [ ] The stage-1 teaching in the unified prompt says the order: topics → `remember(create, id="E<n>/#tag")` for a missing lane (optionally with `members`) → the batch tag write per topic → per-turn `note` only for corrections → `finalize`. The audit (title, type, tags) is stated as a duty of the read; edits as the exception.
- [ ] Multi-lane membership stated: a turn serving two topics is hit by both batch writes (additive union); each membership is judged on the turn's PRINCIPAL result, not a mention.
- [ ] The retired per-turn tagging instruction and the "batches of ten" instruction are gone from shipped text; grep proves it.
- [ ] Every added/removed sentence pinned; the golden samples (if any teach the old flow) rewritten.

## Constraints

- `~/.claude-mnemo/` is production data and STRICTLY READ-ONLY. Measure on a `cp -c` clone of the scratchpad copy.
- NEVER `git stash` / `checkout` / `checkout-index` / `restore` / `reset` / `clean` in the shared tree. Restore from your own `cp` copies, md5-verified.
- Explicit pathspecs on every `git add`. No raw control bytes in source. `grep -c anthropic-ai plugin/scripts/worker.cjs` stays `0`.
- Every teaching sentence added or removed is pinned by a test a mutation drives red. At least three mutation probes of your own, RED, md5-restored.
- [ ] `npx tsc --noEmit` clean (excludes `tests/`; typecheck new tests separately); full `bun test` once (account for every delta against the baseline in your brief); `npm run build`; stale-bundle and release-artifacts guards green; `git diff --check` clean. Do NOT bump any version and do NOT push.
