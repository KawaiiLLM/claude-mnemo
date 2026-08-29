# 05 — The per-provenance terminal gate and stage-scoped authorization

**What to build:** spec Rev 5 §Identity and authorization + §Per-provenance gate filter: read grants, field completeness, relation grants and lane-read receipts key on the full `(job, claimGeneration, stage)` tuple — stage 2 authorizes every write with its own reads and inherits nothing from stage 1; the `lane_run_touches` ledger stays job-scoped. The terminal gate blocks per provenance: window/lookback/closure anchors block E3/E4/E6 as today; a turn whose ONLY provenance is `removed-side-citer` blocks E4/E6 and never E3 (type debt belongs to the window owning the turn's fields); dual provenance takes the UNION of authorities and blocks all three. Relation-writes-only authority on removed-side citers is enforced at the write gate (note fields refused).

**Blocked by:** 03, 04.

**Status:** resolved — 943d6a0, 16 files (the extra test files are the fixture sweep the stage-keyed identity forced — territory follows assertions), +12 tests. Reviewer re-ran the three core test files (188 tests, 0 fail). ADJUDICATIONS: derived E-class->authority mapping accepted (retraction is the guaranteed legal repair; no spec change); identity keyed as claim:<job>:<gen>:<stage> with no migration accepted (old rows read as never-read = conservative, re-earned by one recall); absent-index/entry = full authority accepted (mutation M5 proved it load-bearing). KNOWN DEBT logged: lane_check's actionable preview is not provenance-aware (a relation-only citer's E3 prints actionable while the gate ignores it) — teaching mitigation assigned to ticket 07, renderer model rework deferred. WARNING propagated to 06/07 briefs: tests are NOT typechecked (tsconfig excludes tests/), so required-field additions to context/request types need a manual fixture sweep.

**Handoff from ticket 04:** `settlementWritePermissions` in `src/db/note-settlement-snapshots.ts` IS the provenance-union rule — the gate calls it, never re-derives (reviewer guardrail 1's implementation seat). Snapshot readers exist there too; consume, don't reimplement.

**Handoff from ticket 03 (accepted deviation to close here):** `assertNoteSettlementJobClaimed`'s `expectedStage` argument exists but is UNMOUNTED at the one production call site (`note-settlement-sdk-query.ts:1032`), and `completeNoteSettlementJob`/`touchNoteSettlementJobLease` are deliberately stage-agnostic under the stub. When this ticket keys authorization on the full tuple, mount `expectedStage` at the sdk-query seam; stage 1's inability to reach `commit` is bounded by its TOOLSET (ticket 06), not by those two CASes.

- [x] A grant earned by stage 1 does not authorize a stage-2 write (test: stage-1 read, transition, stage-2 write refused until its own read).
- [x] `lane_run_touches` visible across the transition (disposition gate at stage 2 sees stage-1 lane mutations).
- [x] Reviewer guardrail 1: the provenance model supports permission UNION — the existing mutually-exclusive three-way helper is NOT reused as-is; a turn with window+removed-side provenance takes the union and blocks on E3/E4/E6.
- [x] The manufactured-E4 probe: stage 1 removes a lane word from an in-window cited endpoint; the out-of-window citer's E4 blocks the terminal commit until stage 2 repairs it; an unrelated E3 on that relation-only citer does NOT block this job; an unrelated E6 there DOES.
- [x] A removed-side citer's note-field write is refused (relation writes only).
- [x] `npx tsc --noEmit` clean; full `bun test` at the end, deltas accounted.

Territory: write-gate / lane-checker projection / commit-gate files + their tests; not the agent prompts (06/07), not snapshot storage internals (04's, read-only consumption). Standing footer: prod DB read-only; mutation discipline; report per-item; explicit-path staging; Bin-line stop; no bundle rebuilds; python byte scan.
