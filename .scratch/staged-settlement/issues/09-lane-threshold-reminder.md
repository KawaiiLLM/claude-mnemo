# 09 — The lane-count pressure reminder

**What to build:** spec Rev 5 §Lane threshold (USER RULING [S15069/T1998]): when a task's declared-lane count is at/over 50, every message in sessions attached to that task carries an injected reminder naming the task and the count and instructing the main agent to propose merge plans to the user via AskUserQuestion — and explicitly forbidding autonomous consolidation. Settlement is never constrained by the count.

**Blocked by:** None — can start immediately.

**Status:** resolved — 4eef88a, 82/82 owned tests, boundary mutation (>= to >) killed exactly 3 tests. Reviewer re-ran all three test files and the settlement-purity grep (zero hits in worker/settlement paths). ACCEPTED DEVIATION: the reminder is a third additive block beside relief + remember-check, not exclusive — coexistence is correct, the exclusivity rule is scoped to field-freshness vs cadence. Reminder measures 257 chars at threshold.

## File territory (BOTH ways)

- YOURS: the UserPromptSubmit-side maintenance/reminder rendering module (locate it — the same surface that renders the segment-maintenance nudges) and its tests.
- NOT YOURS: the Memory Rubric constant (ticket 01 owns that file NOW — the teaching lives in your reminder TEXT, not the rubric), `src/db/turn-tag-gate.ts`, `src/db/schema.ts`, all worker/settlement files (ticket 03 live in them), new tables (ticket 02).

## Acceptance criteria

- [x] A session attached to a task with ≥50 declared lanes gets the reminder on every message; under 50, nothing renders; exactly-50 renders (at/over).
- [x] The reminder names the task address, the current lane count and the threshold, instructs an AskUserQuestion merge proposal, and states 禁自行整理 in its English equivalent (no autonomous consolidation).
- [x] Settlement paths are untouched — no count check anywhere in the settlement write path (state in the report how you verified this is still true).
- [x] The block respects the injection budget conventions of its surface (one hook slot, one block — the collapse trap is standing law); measure and report its rendered size at 50+ lanes.
- [x] Cheap when idle: sessions with no attached task at/over threshold pay one indexed count query at most (describe the query).
- [x] `npx tsc --noEmit` clean; owned tests green; full `bun test` once at the end — account for every delta.

## Notes

Production DB strictly read-only (fixtures on temp DBs). Mutation discipline per standing law (backup after implement, needle-assert + PRINT, red, restore, green). Report per-item; do not tick boxes. Stage explicit paths only; no `git restore`/`checkout`; `Bin` diff line = hard stop; no bundle rebuilds; python control-byte scan.
