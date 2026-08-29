# 04 — The three transition snapshots and the removed-side-citer closure

**What to build:** spec Rev 5 §Persisted snapshots + §Stage-1 final projection (mechanism half): the transition transaction atomically persists (1) the exact writable turn-id set with provenance classes (window / lookback / closure / removed-side-citer), (2) the ordered `(task, lane)` worklist including zero-mutation synonym-reused lanes plus the removed-side debt list, (3) per-worklist-lane member snapshots whose rule is era-INCLUSIVE for the job's own window members (final-projection members regardless of era ∪ historical members already era-visible) — the era grant itself stays at the terminal commit. The removed-side-citer enumeration (edges whose side references a lane the projection removed from an in-window cited endpoint → their citing turns join the writable set, relation-writes-only) happens in the SAME transaction.

**Blocked by:** 03 (the transition transaction and stage column exist — `transitionNoteSettlementJobToEdges` in `src/db/note-settlement.ts`, columns via `ensureNoteSettlementStageSchema`).

**Status:** resolved — 3a308a7, 3 files explicit-pathspec, +10 tests, 7 mutations (one survivor correctly re-targeted and accepted with its reason). Reviewer re-ran the test file (10/10) and the control-byte sweep repo-wide (clean; the worker's own NUL find was already fixed). ADJUDICATIONS: 'writable window' read as the whole writable set (window+lookback+closure, removed-side-citer excluded from the member pool) ACCEPTED — spec amended to say so; head-direction-only closure pinned by test accepted; no-FK-on-turn_id (frozen records must not shrink under cascades) accepted. HANDOFFS: removedLanes is a hard input contract for stage 1 (empty array = no debts, not unknown) -> ticket 06; settlementWritePermissions is the union rule for the gate -> ticket 05.

**Handoffs from tickets 02/03:** wire `ensureHomelessRecordTables(db)` consumption via stage-1 writes reading `job.transitionSeq` OFF THE ROW — never re-derive via `MAX(transition_seq)` (jobs cascade-delete with sessions, a MAX re-issues values). The transition sequence is a counter row already; use it.

- [x] All three snapshots written in the transition's single fenced transaction; stage 2 and its retries READ them and re-derive nothing (a retry after a concurrent external edge write sees identical snapshots).
- [x] Provenance classes stored per writable id; `removed-side-citer` ids enumerated per the spec rule; the debt list carries (edge id, removed lane, citing turn).
- [x] Member snapshots: an `allow_pre_era` window's freshly-laned pre-era members ARE in the snapshot; ordinary lane recall does NOT show them before the terminal commit and DOES after (the T1964-shape test from the spec).
- [x] Worklist includes a synonym-reused lane with zero stage-1 mutations (test).
- [x] `npx tsc --noEmit` clean; full `bun test` at the end, deltas accounted.

Territory: the transition/facade layer files ticket 03 landed plus new snapshot storage (own module or note-settlement.ts additive); coordinate with the tree — no gate files (05), no agent prompts (06/07). Standing footer: prod DB read-only; mutation discipline; report per-item; explicit-path staging; Bin-line stop; no bundle rebuilds; python byte scan.
