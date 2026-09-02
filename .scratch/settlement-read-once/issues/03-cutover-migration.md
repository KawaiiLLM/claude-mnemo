# 03 — Cutover: the 98 tag-less members of named tasks receive their tag

**What to build:** after cutover, every member of a NAMED task carries that task's tag on the turn, idempotently and once; unnamed tasks' rows stay exactly as they are — frozen, readable, never extended — and the roster still shows `(unnamed)`. Spec D5.

**Blocked by:** 02.

**Status:** ready-for-agent (after 02)

- [ ] A receipt-guarded one-shot in `initializeSchema` (the `migration_receipts` idiom, double-checked outside and inside the write transaction) that, through the ticket-02 primitive, adds the task tag to every member turn of a named task that lacks it. Production (read-only, 2026-09-02): 98 such members; 0 foreign-task conflicts. Report before/after counts on a clone and elapsed.
- [ ] Unnamed tasks (66; 185 members) untouched: assert row counts before/after are identical for them.
- [ ] Idempotent: a second open changes nothing and writes no second receipt.
- [ ] Fixtures: a named task with tag-less members gains the tags; an unnamed task keeps its rows; a member already tagged is untouched.

## Constraints

- `~/.claude-mnemo/` is production data and STRICTLY READ-ONLY. Measure on a `cp -c` clone of the scratchpad copy.
- NEVER `git stash` / `checkout` / `checkout-index` / `restore` / `reset` / `clean` in the shared tree. Restore from your own `cp` copies, md5-verified.
- Explicit pathspecs on every `git add`. No raw control bytes in source. `grep -c anthropic-ai plugin/scripts/worker.cjs` stays `0`.
- Every teaching sentence added or removed is pinned by a test a mutation drives red. At least three mutation probes of your own, RED, md5-restored.
- [ ] `npx tsc --noEmit` clean (excludes `tests/`; typecheck new tests separately); full `bun test` once (account for every delta against the baseline in your brief); `npm run build`; stale-bundle and release-artifacts guards green; `git diff --check` clean. Do NOT bump any version and do NOT push.
