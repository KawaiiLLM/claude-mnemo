# 00 — Gate changes: every outgoing-row mutator stamps, delivered suffices, 20/20 caps

**What to build:** `checkRelationsGate` keeps its promise — a stage-2 edge write is refused when the citing turn's OUTGOING rows changed under the writer by ANY path — and stops asking for more than the user ruled: having SEEN the turn's relations in this run is enough, and no node ever carries more than 20 outgoing or 20 incoming edges. Spec D0 (`../spec.md`).

**Blocked by:** None — ships first; blocks 01–07.

**Status:** ready-for-agent

- [ ] `mergeLaneTag`, `clearLane`, compact occupied-turn repair stamp `stampTurnRelationsRevision` for every citing turn whose outgoing rows they rewrite or delete, in the same transaction.
- [ ] The prune trigger `memory_edges_prune_deleted_turn` itself advances the relations revision of every surviving citer of the deleted turn with a reserved writer id (`trigger:prune`), so direct SQL and cascade deletes cannot bypass the stamp. Test: delete a cited turn by direct SQL → the surviving citer's stale grant is refused naming `trigger:prune`. A task merge does NOT stale a grant (qualifiers are advisory).
- [ ] Delivered-not-complete, on the EXISTING completeness row: `complete` → row(true); `cut` → row(false) and GRANTS; empty set actually evaluated → row(true); `dropped` (field never rendered a byte) → NO row; envelope cut before the item's delivery offset → no row. The gate requires a row with a sequence after the last stamp and ignores `complete`; staleness unchanged; an older post-stamp row is not withdrawn by a later drop. The relations-specific cut/dropped recorder ships HERE, never the relaxation alone. Tests: cut grants; dropped refuses; empty grants; cut then another writer's stamp → stale.
- [ ] Degree caps enforced ONCE in the shared `attachTurnRelations` on prospective post-call counts (after dedupe, after the same call's retractions, excluding stored restatements; relation-carrying atoms only, bare rows do not count); any citer or cited turn that would exceed 20 refuses the WHOLE call by name with zero writes. Pinned: 19 outgoing + 2 → refused; 20 + restatement → no-op success; retract 1 + attach 1 → success; cited 19 incoming + 2 → refused. Production has no violator (max out 18, max in 7).

## Constraints

- `~/.claude-mnemo/` is production data and STRICTLY READ-ONLY. Measure on a `cp -c` clone of the scratchpad copy.
- NEVER `git stash` / `checkout` / `checkout-index` / `restore` / `reset` / `clean` in the shared tree. Restore from your own `cp` copies, md5-verified.
- Explicit pathspecs on every `git add`. No raw control bytes in source. `grep -c anthropic-ai plugin/scripts/worker.cjs` stays `0`.
- Every teaching sentence added or removed is pinned by a test a mutation drives red. At least three mutation probes of your own, RED, md5-restored.
- [ ] `npx tsc --noEmit` clean (excludes `tests/`; typecheck new tests separately); full `bun test` once (account for every delta against the baseline in your brief); `npm run build`; stale-bundle and release-artifacts guards green; `git diff --check` clean. Do NOT bump any version and do NOT push.
