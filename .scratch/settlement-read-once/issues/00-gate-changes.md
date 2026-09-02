# 00 — Gate changes: every outgoing-row mutator stamps, delivered suffices, 20/20 caps

**What to build:** `checkRelationsGate` keeps its promise — a stage-2 edge write is refused when the citing turn's OUTGOING rows changed under the writer by ANY path — and stops asking for more than the user ruled: having SEEN the turn's relations in this run is enough, and no node ever carries more than 20 outgoing or 20 incoming edges. Spec D0 (`../spec.md`).

**Blocked by:** None — ships first; blocks 01–07.

**Status:** LANDED **VERIFIED S15069/T2411 at f294ee22 (merged ff)**: tsc 0, 4706/0/259 on the branch; my probes RED — outgoing cap counting bare rows (1), clearLane stamping nothing (1), evaluated-empty relations recording no row (1). Design note accepted: structural verbs stamp with RESERVED writer ids (`lane:merge`, `lane:clear`, `compact:repair`, `trigger:prune`) so a caller cannot keep writing on a set its own verb moved.

- [x] `mergeLaneTag`, `clearLane`, compact occupied-turn repair stamp `stampTurnRelationsRevision` for every citing turn whose outgoing rows they rewrite or delete, in the same transaction.
- [x] The prune trigger `memory_edges_prune_deleted_turn` itself advances the relations revision of every surviving citer of the deleted turn with a reserved writer id (`trigger:prune`), so direct SQL and cascade deletes cannot bypass the stamp. Test: delete a cited turn by direct SQL → the surviving citer's stale grant is refused naming `trigger:prune`. A task merge does NOT stale a grant (qualifiers are advisory).
- [x] Delivered-not-complete, on the EXISTING completeness row: `complete` → row(true); `cut` → row(false) and GRANTS; empty set actually evaluated → row(true); `dropped` (field never rendered a byte) → NO row; envelope cut before the item's delivery offset → no row. The gate requires a row with a sequence after the last stamp and ignores `complete`; staleness unchanged; an older post-stamp row is not withdrawn by a later drop. The relations-specific cut/dropped recorder ships HERE, never the relaxation alone. Tests: cut grants; dropped refuses; empty grants; cut then another writer's stamp → stale.
- [x] Degree caps enforced ONCE in the shared `attachTurnRelations` on prospective post-call counts (after dedupe, after the same call's retractions, excluding stored restatements; relation-carrying atoms only, bare rows do not count); any citer or cited turn that would exceed 20 refuses the WHOLE call by name with zero writes. Pinned: 19 outgoing + 2 → refused; 20 + restatement → no-op success; retract 1 + attach 1 → success; cited 19 incoming + 2 → refused. Production has no violator (max out 18, max in 7).

## Constraints

- `~/.claude-mnemo/` is production data and STRICTLY READ-ONLY. Measure on a `cp -c` clone of the scratchpad copy.
- NEVER `git stash` / `checkout` / `checkout-index` / `restore` / `reset` / `clean` in the shared tree. Restore from your own `cp` copies, md5-verified.
- Explicit pathspecs on every `git add`. No raw control bytes in source. `grep -c anthropic-ai plugin/scripts/worker.cjs` stays `0`.
- Every teaching sentence added or removed is pinned by a test a mutation drives red. At least three mutation probes of your own, RED, md5-restored.
- [x] `npx tsc --noEmit` clean (excludes `tests/`; typecheck new tests separately); full `bun test` once (account for every delta against the baseline in your brief); `npm run build`; stale-bundle and release-artifacts guards green; `git diff --check` clean. Do NOT bump any version and do NOT push.


## Report (LANDED)

Branch `worktree-agent-a2a6841ae18ac9ddd`, fast-forwarded to `main` (`4dd91a52`) before any work — the worktree was created from `2f7a2b8c`, which does not contain `5a8f636c`, so the brief's 4676/0/256 baseline did not reproduce until the merge (4569/0/251 before it).

### What shipped, per box

**Every outgoing-row mutator stamps.** `mergeLaneTag` collects the citing turn of every collision casualty AND every survivor whose sides it rewrites; `clearLane` collects the citing turn of every deleted row (before the D5b bare-row restore, so one revision per event); the compact occupied-turn repair stamps when its `DELETE` actually removed rows. Each stamps a RESERVED writer id — `lane:merge`, `lane:clear`, `compact:repair` (`db/write-gate.ts`) — not the acting caller's own, because under the gate's rule 1 a caller-owned stamp would let that caller keep writing on the set its own structural verb just moved. No signature changed, so `remember.ts` and the settlement membership facade are untouched.

**The prune trigger stamps.** `memory_edges_prune_deleted_turn` now bumps `write_gate_sequence` once and stamps `relations` on every SURVIVING citer of `OLD.id` under `trigger:prune`, BEFORE its own `DELETE`. Its body moved into one shared constant that the two `turns`-rebuild migrations now reuse instead of carrying a second literal copy. `CREATE TRIGGER IF NOT EXISTS` cannot replace an installed trigger, so `ensureMemoryEdgesPruneStampsRelations` (last in `initializeSchema`, after both rebuilds) DROPs and recreates when `sqlite_master` shows the old body. A task merge stamps nothing and is pinned NOT to stale.

**Delivered, not complete.** `checkRelationsGate` no longer reads `complete` — a row after the last stamp is the grant. The recorder that makes the relaxation safe ships with it: `formatTurnBody` now reports where the field landed (`absent`/`empty`/`elided`/`atoms`) and `capRenderToTokenBudget` gained an internal outcome carrying how many source lines survived, so `renderNode` can tell a `cut` field from a `dropped` one. A dropped field pushes NO row, which also means an older post-stamp row is never withdrawn by a later drop. The `- relations:` header alone is not delivery: an atom line must survive.

**Degree caps.** `MAX_TURN_RELATION_DEGREE = 20`, enforced once in `attachTurnRelations` on prospective post-call counts — after dedupe, after the call's retractions (free: both faces retract first), excluding restatements, counting relation-carrying atoms only. Two new rejection reasons name the offending node; the check returns before `writeMemoryEdges`, so a refusal writes nothing.

### Verification

`npx tsc --noEmit` clean; new tests typechecked under a temp tsconfig extending the project's (deleted afterwards). Full `bun test`: **4706 pass / 0 fail / 259 files** against the 4676/0/256 baseline — +30 tests in +3 new files (12 + 10 + 8), nothing else moved. `npm run build`, the stale-bundle guard and `tests/shared/release-artifacts.test.ts` green. `git diff --check` clean; zero raw control bytes; `grep -c anthropic-ai plugin/scripts/worker.cjs` -> 0.

Six mutation probes, each RED then md5-restored: gate re-demands `complete=true` (2 red); recorder writes a row for a dropped field (3 red); trigger stamps the deleted turn instead of the survivors (3 red); cap computed but not enforced (3 red); `mergeLaneTag` stamps nothing (2 red); compact repair stamps nothing (1 red).
