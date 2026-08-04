Verdict: fix first

## BLOCKER

None found.

## MAJOR

### MAJOR — concurrent backfill runs can corrupt the repair ledger

Evidence: `src/db/transcript-path-backfill.ts:186` reads the ledger, and
`:239-246` selects the next NULL rows, outside the write transaction at
`:282-305`. The transaction unconditionally writes `cursor_id` and increments
the three counters at `:291-304`, while each session write is guarded by
`transcript_path IS NULL` at `:284-288`.

`initializeDatabase` is reachable from the hook process at
`src/hooks/hook-command.ts:117-119` and from the long-lived worker at
`src/worker/server.ts:4089-4096`. Two initializers can therefore select the
same rows before either ledger transaction commits. The second run may update
zero session rows but still increments `filled_count` by `picks.length` and
advances the ledger as if it wrote them. A stale runner can also commit a
smaller `cursor_id` after another runner has advanced it, causing re-selection
and further double-counting. A concurrent registration can produce the same
zero-row-update/counting error.

This violates the locked ledger requirements in the contract (no repeated
counting, no cursor regression, and crash/resume correctness). The sequential
tests do not exercise competing initializers or a guarded update that changes
zero rows.

### MAJOR — backfill work is synchronous and its filesystem scan is unbounded

Evidence: `src/hooks/hook-command.ts:117-119` calls `initializeDatabase`
synchronously before handlers are returned. `src/db/schema.ts:872-884` catches
backfill exceptions, but does not put a time or work budget around the call.
`src/db/transcript-path-backfill.ts:105-141` enumerates the complete transcript
root and every project directory, while `maxRows` only limits database rows at
`:236-246`; it does not limit directory entries or filesystem latency.

Thus a large `~/.claude/projects` tree, slow filesystem, or many project
directories can delay every hook’s database initialization. The catch prevents
an exception from escaping, but it cannot prevent this synchronous critical
path from being slow or wedged.

### MAJOR — unreadable transcript roots retry forever across hook initializations

Evidence: `src/db/transcript-path-backfill.ts:208-221` returns `deferred` before
creating a ledger row or moving the cursor whenever the root cannot be read.
That preserves the one-shot repair, but there is no persistent retry suppression,
backoff, or terminal state. Every later `initializeDatabase` call repeats the
full root-read attempt; the hook entry point invokes it synchronously as shown
at `src/hooks/hook-command.ts:117-119`. A root that remains unavailable can
therefore cause unbounded repeated initialization work. The code avoids burning
the repair, but it does not satisfy the requirement that a deferred unreadable
root cannot loop forever.

## MINOR

### MINOR — singleton candidate resolution still performs `statSync`

Evidence: `src/db/transcript-path-backfill.ts:257-266` calls
`orderTranscriptCandidates` for every non-empty candidate list, including one
candidate. `orderTranscriptCandidates` maps every candidate through
`mtimeOf`/`statSync` at `:158-163`. The locked tie-break requirement says stat
should happen only when there is more than one candidate. This does not change
the selected path, but adds avoidable filesystem work for the common unique-hit
case.

### MINOR — tests do not exercise a real crash window or the worker reader seam

Evidence: `tests/db/transcript-path-backfill.test.ts:140-172` labels a
`run({ maxRows: 1 })` return as a “Crash simulation”. It is a normal successful
return followed by another normal invocation; no injected failure occurs after
row selection, inside the batch transaction, or between the final batch commit
and the separate completion statement at
`src/db/transcript-path-backfill.ts:319-327`. Therefore it proves sequential
high-water behavior, not rollback/resume behavior under an actual crash.

The added reader tests cover real recall/timeline and SessionEnd seams, but
there is no worker-server regression test for the new `SessionState.transcriptPath`
field/fallback path, and the context tests assert the stored DB field rather
than the `buildSessionView` output at `src/hooks/handlers/context.ts:197`.
This leaves two acceptance-critical reader branches without direct seam
coverage even though the implementation wiring is present.

## Confirmed-clean

- Reader sweep found the six DB-derived readers claimed by the implementer:
  `src/mcp/recall.ts:330,442`, `src/mcp/timeline.ts:1770`,
  `src/hooks/handlers/context.ts:197`,
  `src/hooks/handlers/session-end.ts:117`, and
  `src/worker/server.ts:1212-1216`. No other source site deriving from a
  `sessions` row was missed. `src/worker/query-session.ts:310`,
  `src/worker/server.ts:810-812`, and `src/worker/cache-ttl.ts:55` resolve the
  worker’s own transcript under `DATA_DIR`, not a session transcript. The
  capture-repair path uses explicit hook transcript paths in
  `src/hooks/transcript-scan.ts:89-105` and `src/hooks/capture-repair.ts:703-711`.
- First-non-NULL behavior is correct in the single-writer case:
  `src/db/sessions.ts:117` uses
  `COALESCE(sessions.transcript_path, excluded.transcript_path)`, and
  `:410-423` uses `WHERE ... transcript_path IS NULL`. Both registration paths
  write the value (`src/hooks/handlers/context.ts:340-365` and
  `src/hooks/handlers/session-init.ts:101-108`). `project` remains latest-cwd
  state, and `stop.ts:201-211` omitting `transcriptPath` cannot clear an already
  set value because of the COALESCE expression.
- `src/db/sessions.ts:64-89`, `:127-149`, and `:229-251` all carry
  `transcript_path`; the other full session readers reuse `SESSION_SELECT`.
  Search/recent-session project behavior remains unchanged.
- In a single backfill runner, the ascending NULL-only query, zero-hit cursor
  advancement, and session/counter/cursor writes are in the same transaction
  (`src/db/transcript-path-backfill.ts:239-305`). The separate completion
  statement at `:319-327` is written last; a crash before it leaves `running`
  and the next single runner can safely observe exhaustion and mark it done.
  The concurrency defect above means this guarantee is not global.
- Tie ordering resolves candidates before comparison and sorts by mtime
  descending then normalized absolute path ascending
  (`src/db/transcript-path-backfill.ts:158-173`). Multi-hit logs contain all
  ordered candidates and the selected path (`:268-274`), so tied picks are
  deterministic.
- Schema migration is idempotent and NULL-safe
  (`src/db/schema.ts:496-502`); `repair_ledger` is created in the schema and
  dropped by reset. `resolveSessionTranscriptPath` preserves the legacy NULL
  fallback without throwing (`src/shared/paths.ts:43-61`).
- Verification completed read-only: `npm run typecheck` passed; the eight
  changed test files passed with `378 pass / 0 fail`; the full suite passed with
  `1432 pass / 0 fail`; and `git diff --check 669f2b9` passed. No git write
  operation was run. Generated `plugin/scripts/*.cjs` files were excluded.

## Summary

The reader wiring, first-non-NULL schema behavior, fallback semantics, tie
ordering, and single-run ledger arithmetic are sound. The work is not safe to
commit because the resumable repair is not serialized across the concurrent
hook/worker initializers, and it is hosted as an unbounded synchronous scan on
the hook database-init path. The singleton-stat and crash/worker-test gaps are
smaller but should also be addressed before treating the locked acceptance
criteria as complete.
