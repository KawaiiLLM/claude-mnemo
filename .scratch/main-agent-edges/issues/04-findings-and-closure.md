# 04 — Findings (E6 ambiguous blank, E4 invalid-declaration), the derived closure, and post-normalisation

**What to build:** spec D6 + the post-normalisation contract (R9-2, R10-6). E6 = blank side on an endpoint with ≥2 lanes; E4 = `invalid-declaration`; both on the three-layer audit (context / admit / project; actionable = outgoing rows of writable citers; preview and commit share the predicate). `derived-side-citer`: PRE resolutions recorded first-write-wins per `(job, edge, side)` in the attribution-mutation transaction, closure at finalize against POST facts granting only PRE-good → POST-bad, provenance in schema and permission union as relations-only, claim-time scope persisted, finalize continuation reads the final snapshot (R10-7). Post-normalisation on the shared membership seam: after any change to an endpoint's lane set, re-resolve every incident side in the same transaction — cardinality < 2 clears, invalid clears, newly ambiguous invalidates a live overlapping job (`invalidateOverlappingSettlementJobs`: pending|claimed|failed, stage reset, snapshots/worklists/debts/homeless records/pending impressions cleared, cancellation armed for both dispatch shapes; R9-7, R10-9) or DELETES the edge with a receipt; side index, citer stamps, old/new lane touches updated in that transaction.

**Blocked by:** 02, 03.

**Status:** ready-for-agent (after blockers)

- [ ] E6/E4 tests on both faces; an external citer's incident row never becomes a finding; a window of undeclared edges on unique endpoints commits.
- [ ] Derived closure: ambiguous and invalid paths; a pre-existing bad side is NOT granted; PRE survives a repeated stage-1 call; a remote citer enters the persisted final writable snapshot.
- [ ] Post-normalisation: alpha+beta declaring alpha becomes derived when beta goes; a stale grant is refused after a structural verb changed the edge set; a DONE window's newly ambiguous edge is deleted and receipted.

## Constraints

- `~/.claude-mnemo/` is production data and STRICTLY READ-ONLY; measure on a `cp -c` clone of the scratchpad copy.
- NEVER `git stash` / `checkout` / `checkout-index` / `restore` / `reset` / `clean`. Restore from your own `cp` copies, md5-verified.
- Explicit pathspecs on every `git add`. No raw control bytes. `grep -c anthropic-ai plugin/scripts/worker.cjs` stays `0`.
- Every teaching sentence added or removed is pinned by a test a mutation drives red. ≥3 mutation probes of your own, RED, md5-restored — and a probe whose mutation did not apply is not a probe.
- Dispose of every applicable line of `../acceptance-matrix.md` in your report.
- [ ] `npx tsc --noEmit` clean (excludes `tests/`; typecheck new tests separately); full `bun test` once with every delta accounted; `npm run build`; stale-bundle and release-artifacts guards green; `git diff --check` clean. No version bump, no push.
