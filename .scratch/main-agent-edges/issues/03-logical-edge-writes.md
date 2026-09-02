# 03 — Logical-edge writes: declare in place, promote in place, retract by class, cap by pair

**What to build:** spec D4 + D5 + the read-once 00 addendum. `declareEdgeSides` (three-state patch, cardinality < 2 refused, in place, one stamp, lane touches); `attachTurnRelations` precedence (most specific; same-call full+partial refuses the call; stronger promotes in place; weaker no-op; never a second row); retraction resolves by materialized class; 20/20 caps count logical edges; the fresh-turn gate exception (zero outgoing relation atoms → no relations read required, writer-agnostic, in the write transaction, bare rows not counted); the public `note` entry union (strings for verify/use, `{turn, coverage}` for correct; two-sided entries refused) split from the settlement shape (R10-5); declaration addressed by pair with class as a CAS precondition.

**Blocked by:** None (works on the current schema; must stop writing the `relation` word — write class/coverage only — and stop producing bare rows: R10-2's producers/restorers deleted here).

**Status:** ready-for-agent

- [ ] Every rule above pinned; retraction of a promoted edge by its NEW class succeeds and by the old fails by name; caps count pairs.
- [ ] Wordless-row producers and restorers (`recomputeTurnCitedPairs`, `reconcileCitedPairs`, `restoreBareRowsForEmptiedPairs`, `relation: null` writes, the "Cites N pair(s)" receipt line) deleted; the prose-mention lint recomputed from text or deleted by call-site sweep.

## Constraints

- `~/.claude-mnemo/` is production data and STRICTLY READ-ONLY; measure on a `cp -c` clone of the scratchpad copy.
- NEVER `git stash` / `checkout` / `checkout-index` / `restore` / `reset` / `clean`. Restore from your own `cp` copies, md5-verified.
- Explicit pathspecs on every `git add`. No raw control bytes. `grep -c anthropic-ai plugin/scripts/worker.cjs` stays `0`.
- Every teaching sentence added or removed is pinned by a test a mutation drives red. ≥3 mutation probes of your own, RED, md5-restored — and a probe whose mutation did not apply is not a probe.
- Dispose of every applicable line of `../acceptance-matrix.md` in your report.
- [ ] `npx tsc --noEmit` clean (excludes `tests/`; typecheck new tests separately); full `bun test` once with every delta accounted; `npm run build`; stale-bundle and release-artifacts guards green; `git diff --check` clean. No version bump, no push.
