# 02 — The homeless record layer with a per-member active view

**What to build:** spec Rev 5 §Homeless record as a self-contained DB layer: group records, member rows, member-level supersessions, the event-reduction active view as the SOLE consumer entry, and the retraction audit table. Everything demoable through seam tests without any settlement wiring.

**Blocked by:** None — can start immediately.

**Status:** resolved — bf47635, 17/17 tests, mutation-verified (comparator needle: red on exactly its 2 targets, restored green). ACCEPTED DEVIATION: created_at → created_at_epoch (repo-wide suffix convention). Reviewer re-ran the suite file and verified the commit's 2-file scope. Handoff (schema wiring line) passed to ticket 01 live; transition_seq consumption note passed to ticket 04.

## File territory (BOTH ways)

- YOURS: NEW `src/db/homeless-record.ts` (module name yours), NEW `tests/db/homeless-record.test.ts`.
- NOT YOURS: `src/db/schema.ts` (ticket 01 owns it NOW) — export an `ensureHomelessRecordTables(db)` and call it from your tests directly; REPORT the one-line init-chain wiring as a handoff, do not write it. No worker files (ticket 03 is live in them), no gate files.

## Acceptance criteria

- [x] Tables per spec: `homeless_groups(id, job_id, task_scope_id INTEGER NOT NULL /* 0 = taskless */, canonical_label, member_fingerprint, reason, transition_seq, created_at)` with UNIQUE `(job_id, task_scope_id, canonical_label)`; `homeless_members(group_id, turn_id)`; `homeless_supersessions(old_group_id, turn_id, successor_kind homed|regrouped, successor_group_id NULLABLE, transition_seq)`.
- [x] The NULL trap is closed by construction: two taskless groups with the same (job, label) CONFLICT (test proves the second insert hits the unique key, not a silent second row).
- [x] Immutability contract: same key + same member fingerprint = no-op; same key + different fingerprint or reason = REFUSED with a named error. No UPDATE path exists.
- [x] Supersession constraints: at most one live successor per `(old_group_id, turn_id)`; all mappings one transition writes for one turn agree on the outcome; a `regrouped` successor group carries the SAME `transition_seq` as the mapping (enforced or asserted).
- [x] The ACTIVE VIEW reduces events, not groups: one exported function/view, the sole entry point. Tests: a turn homed by a later transition yields NO active homeless state; partial overlap re-disposes exactly the covered members (uncovered members keep the old group's disposition); highest `transition_seq` wins regardless of job id order.
- [x] Retraction audit table: full composite identity of a deleted relation row (edge row id, citing kind+id, cited kind+id, relation word, tail tag, head tag) + cause group id, job, epoch; a write helper that must be called inside the deleting transaction; the "relation retracted, bare restored" outcome representable and tested.
- [x] `npx tsc --noEmit` clean; your test file green; full `bun test` once at the end — account for every delta.

## Notes

Production DB strictly read-only; all tests on temp DBs (bunfig HOME sandbox exists — pass dataRoot where needed). Prepared `.run()` statements for multi-row writes, never multi-statement `db.exec` (its constraint-swallowing is a documented repo trap). Mutation discipline per standing law (backup after implement, needle-assert + PRINT, red, restore, green). Report per-item; do not tick boxes. Stage explicit paths only; no `git restore`/`checkout`; `Bin` diff line = hard stop; no bundle rebuilds; python control-byte scan.
