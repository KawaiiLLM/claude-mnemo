# 03 — The staged job machinery, behavior-equivalent under a stub stage 1

**What to build:** spec Rev 5 §State machine and ownership: the `stage` column, the `(job, claimGeneration, stage)` ownership tuple, the monotonic transition sequence, the transition verdict, the post-hoc truth rule, same-drain chaining and stop-hook stage resume — with a STUB stage 1 (a no-op transition writer) and the CURRENT settlement run mounted as stage 2, so every existing window settles exactly as today and the suite stays green. This is the expand step: machinery live, behavior unchanged.

**Blocked by:** None — can start immediately.

**Status:** resolved — 2a9e0c6, 16/16 tests, 5 mutation needles each red on its own assertions. Full status-comparison audit in the worker report (all positive-list comparisons, cursor cannot walk past claimed+edges). ACCEPTED DEVIATIONS: heartbeat + complete CAS stay stage-agnostic under the stub (expectedStage exists, unmounted at sdk-query — closing assigned to ticket 05; stage-1 commit-unreachability bounded by toolset — ticket 06); phantom-transition verdict recorded as deterministic failure (spec amended to say so). Reviewer re-ran the suite file and verified the 5-path commit scope.

## File territory (BOTH ways)

- YOURS: `src/db/note-settlement.ts`, `src/worker/note-settlement.ts`, `src/worker/note-settlement-dispatch.ts`, `src/worker/note-settlement-stop-hook.ts`, their test files (`tests/db/note-settlement*.test.ts`, `tests/worker/note-settlement*.test.ts` — scheduler/job-table portions).
- NOT YOURS: `src/db/schema.ts` (ticket 01 owns it NOW — if the jobs DDL lives there, add the `stage` column via an additive `ensure*` in `src/db/note-settlement.ts` instead), `src/db/turn-tag-gate.ts`, new tables (ticket 02), the settlement agent prompts/facades beyond the minimal dispatch mounting.

## Acceptance criteria

- [x] `note_settlement_jobs` gains `stage` (`topics`|`edges`) additively; **grep and audit EVERY status comparison** in the codebase for assumptions a claimed+`edges` job breaks (the `status != 'active'` lesson is standing law) — list what you audited in the report.
- [x] Ownership tuple `(job, claimGeneration, stage)`: the claim assert takes the stage; a context asserting `topics` after the transition is refused; generation does NOT change at the transition.
- [x] The stage transition is ONE fenced write transaction writing stage-1 outcome metrics (stub: empty), `stage='edges'`, and the next value of a monotonic transition sequence; job REMAINS `claimed`; it does NOT touch done/cursor/era-grant/final-metrics.
- [x] Scheduler transition verdict: a stage-1 dispatch returning it launches stage 2 in the same drain — no completion, no failure record, no re-claim, no attempt increment (tests assert attempts unchanged).
- [x] Post-hoc truth rule on EVERY stage-1 dispatch return (verdict, failure, throw): re-read the row first; same (job, generation) claimed + stage advanced `topics`→`edges` ⇒ discard the outcome, launch stage 2, zero failure accounting; generation/status mismatch = preemption as today; stage still `topics` = handle as reported. Test the lost-verdict shape: transition lands, dispatch throws, stage 2 still runs, no attempt spent.
- [x] Stop-hook recovery resumes by stage: reclaim spends an attempt per standing law; a job reclaimed in `topics` re-runs stage 1 (stub), in `edges` re-runs stage 2.
- [x] Retry law untouched and re-proven: deterministic 1+1=2 with abandonment + debt row; transient refund uncapped; attempts job-level (existing tests still green, plus one test through the staged path).
- [x] Behavior equivalence: with the stub stage 1, an ordinary window settles end to end exactly as today — full `bun test` green, every delta accounted.
- [x] `npx tsc --noEmit` clean.

## Notes

Production DB strictly read-only; never restart the live worker. Mutation discipline per standing law (backup after implement, needle-assert + PRINT, red, restore, green). Report per-item; do not tick boxes. Stage explicit paths only; no `git restore`/`checkout`; `Bin` diff line = hard stop; no bundle rebuilds (ticket 08 owns them); python control-byte scan.
