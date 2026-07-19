# 01 — Dream fires on turn-stop, not on worker-liveness

**What to build:** The dream (the global diary drain that runs the nightly opus job) fires **only when a new turn-stop is enqueued** — genuine active work. Worker-start recovery, `POST /wake`, session resume (SessionStart), and clock elapse no longer trigger or retry it. The standalone time-based retry timer (`persistentRetryTimer` / `schedulePersistentRetry`) is removed; an aborted or failed dream stays enqueued and is retried on the **next turn-stop**, with the existing `next_attempt_epoch` kept as a backoff floor (mirrors the 0.6.2 connection-error "enqueue-to-resume + time-backoff floor" shape — reuse it, do not invent a second mechanism). SessionStart's `reconcileBacklog` still marks completed days due and enqueues them (enqueue only, no drain). Diary-vs-session fairness (session work buffered first, at most one diary per drain), the terminal/idempotency guards (`readLastSuccessfulDate` early-return, 3-strike terminal, claim semantics), and manual `POST /dream` are unchanged.

**Blocked by:** None — can start immediately.

**Status:** implemented

## Design pointers (see ../spec.md for full rationale)

- Today the dream only runs at the tail of a *global* `scanAndDrainQueue` (sessionFilter === undefined); a turn-stop drain is *session-scoped* and deliberately skips diary. So the fix is a **trigger inversion**: after a session-scoped turn-stop drain settles its session work, kick a global diary drain — and stop firing that global diary drain from pure worker-liveness events.
- Remove `schedulePersistentRetry` / `persistentRetryTimer` entirely. Retry is event-driven on the next turn-stop; `next_attempt_epoch` gates "do not retry before this epoch" *inside* the turn-stop-driven drain rather than scheduling its own callback.
- Worker-start / `/wake` global scans must not run the diary tail (turn/obs crash recovery is unaffected). Only a turn-stop-originated global diary drain runs the dream.
- Confine the change to the worker server's queue-drain scheduling. Do NOT touch `dream-job` / `diary-runtime` (the agent job, staging, commit transaction).

## Key files

- `src/worker/server.ts` — `scanAndDrainQueue` diary tail, `schedulePersistentRetry`/`persistentRetryTimer`, `scheduleDiaryContinuation`, the turn-stop drain path, worker-start/wake scan callers.
- `tests/worker/server.test.ts` — prior art: the diary-fairness tests ("dispatches diary work before touching session state", "global drain buffers session work before processing at most one diary") and the 0.6.2 event-driven-resume tests. Same seam: worker core / `main()` with injected `processDiaryItem`, injectable clock (`setTimeoutImpl`/`now`), real `diary-state` store; assert on whether `processDiaryItem` is invoked.

## Acceptance criteria

- [x] A turn-stop enqueue for a live session, with a due diary item present, drives exactly one `processDiaryItem` call.
- [x] Worker-start / `/wake` / clock-advance with a due diary item but NO new turn-stop does NOT call `processDiaryItem`.
- [x] Advancing the mock clock past a former `next_attempt_epoch` does NOT re-fire the dream on its own (the timer is gone).
- [x] After a `processDiaryItem` that throws (aborted/failed dream), the NEXT turn-stop re-drains it; a succeeding mock settles the day.
- [x] A future `next_attempt_epoch` is respected as a floor: a turn-stop before it does not retry; a turn-stop after it does.
- [x] Fairness preserved: within one turn-stop-driven global drain, session work is buffered/processed before at most one diary item.
- [x] A day already at `last-successful` (done) or `terminal` is not re-run by turn activity.
- [x] Manual `POST /dream` still resets + enqueues + drains the specified day.
- [x] `bunx tsc --noEmit` passes; `bun test` does not regress vs baseline (the single stale-bundle-guard failure is the expected baseline).

## Constraints

- Do NOT run any git command; only edit files.
- Do NOT bump the version or rebuild `plugin/scripts/*.cjs` (the stale-bundle guard failing by 1 is the expected baseline until Claude rebuilds).
- Do NOT touch any live data under `~/.claude-mnemo`.

## Comments

- Implemented the trigger inversion in `src/worker/server.ts`: queue scans now report whether they processed turn-stop work; a session-scoped turn-stop drain requests one global diary claim after session work, while pure worker-liveness scans with no new turn-stop leave due diary work queued.
- Removed `persistentRetryTimer` / `schedulePersistentRetry` completely. `next_attempt_epoch` remains enforced by the existing diary-state claim query as a backoff floor, and failed/aborted work retries only after a later turn-stop. The zero-delay diary continuation is now reserved for explicit manual `POST /dream` requests; automatic backlog no longer self-continues.
- Preserved global fairness by globally buffering remaining session work before claiming at most one diary item. The global drain request teardown also clears its in-flight marker atomically so a concurrent turn-stop/manual request cannot be stranded.
- Added external-behaviour coverage in `tests/worker/server.test.ts` for turn-stop triggering, worker-start/`/wake`/clock non-triggering, event-driven retry and floor behavior, fairness/at-most-one, settled/terminal guards, and manual `POST /dream`. Updated the two server-scheduling integration expectations in `tests/worker/diary-runtime.test.ts` to drive diary work with a turn-stop; no diary-runtime production code changed.
- Verification: `bunx tsc --noEmit` passed. `bun test` completed with `971 pass / 1 fail` across 84 files; the sole failure is the expected stale-bundle guard in `tests/shared/release-artifacts.test.ts`. No version was bumped and `plugin/scripts/*.cjs` was not rebuilt.
