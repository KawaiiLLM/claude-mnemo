# 05 — Finalize names its two deltas; stage 2 reads them once and re-reads nothing

**What to build:** `finalize` tells the writer exactly which addresses were NOT in its mandated initial sweep, split by authority; stage 2 reads that union in one paginated sweep and then writes edges without any further read, placing each pair once. Spec D6.

**Blocked by:** 01.

**Status:** ready-for-agent (after 01)

- [ ] `finalize` computes and prints `writableDelta = frozenWritableIds − initialWritableIds` (relation writes only — removed-side citers not already writable) and `contextDelta = ⋃ laneMembers − initialWritableIds − writableDelta`, deduplicated across lanes, as pasteable address lists. Tests: an address in the initial set never appears in either; a `contextDelta` member is read and a relation write on it is REFUSED; a `writableDelta` member accepts a relation write and refuses a note-field write.
- [ ] The stage-2 teaching: read the union in one paginated sweep with the field union, each address once; then no read until the gate names a changed turn. The sentences "recall that lane's members with fields […relations]" and "before any edge write, recall the citing turn with relations" are removed; grep proves it.
- [ ] Multi-lane citing turns: the teaching names BOTH sides — `tailTag` = the lane the citing claim belongs to, `headTag` = the lane where the cited principal result is used — decided ONCE per pair over the whole worklist before writing; a second visit never re-places. Tests: a fixture with one citing turn in two worklist lanes → exactly one qualified row in the DB; the same fixture with the lanes' worklist order swapped → the same `(tailLane, headLane)`. Stated as a teaching rule (`lane_check` has no duplicate-pair finding).

## Constraints

- `~/.claude-mnemo/` is production data and STRICTLY READ-ONLY. Measure on a `cp -c` clone of the scratchpad copy.
- NEVER `git stash` / `checkout` / `checkout-index` / `restore` / `reset` / `clean` in the shared tree. Restore from your own `cp` copies, md5-verified.
- Explicit pathspecs on every `git add`. No raw control bytes in source. `grep -c anthropic-ai plugin/scripts/worker.cjs` stays `0`.
- Every teaching sentence added or removed is pinned by a test a mutation drives red. At least three mutation probes of your own, RED, md5-restored.
- [ ] `npx tsc --noEmit` clean (excludes `tests/`; typecheck new tests separately); full `bun test` once (account for every delta against the baseline in your brief); `npm run build`; stale-bundle and release-artifacts guards green; `git diff --check` clean. Do NOT bump any version and do NOT push.
