# 01 — Unified event-driven dream retry

**What to build:** A failing nightly dream stops burning unbounded cost. Every dream failure — `connection` included, not just `deterministic`/`blocked` — counts toward one attempt cap and, on reaching it, trips `terminal` tagged with its cause. Retries ride the existing turn-stop drain with a single small backoff instead of the class-specific 15 min / 24 h / 60 s wall-clock delays, so the attempt cap (not a clock) is what bounds retries. A shutdown/restart abort re-enqueues the day without consuming an attempt, so ordinary restarts never terminalize a day. A `transient`-terminal day (`connection`/`blocked`) recovers only when another day completes a dream that actually reached the remote agent and succeeded; a `permanent`-terminal day (any history with a `deterministic` cause, plus backlog eviction) recovers only via manual `POST /dream`.

**Blocked by:** None — can start immediately.

**Status:** implemented

- [x] Every non-shutdown dream failure increments the day's attempt count; reaching the unified cap (single tunable constant, propose 3) trips `terminal`. The `connection`/`countAttempt === false` exemption is removed.
- [x] A new forward-safe `diary_day_state.retry_disposition` column (`null` | `'transient'` | `'permanent'`) tracks the current retry cycle's disposition and MAY hold `'permanent'` before the day is terminal (it is independent of the `terminal` boolean). Idempotent `hasColumn`-guarded `ALTER`, same pattern as the 0.6.5 `extraction_stall_*` columns. Existing `terminal = 1` rows backfill `'permanent'`; non-terminal rows backfill `null`.
- [x] Disposition is deterministic-sticky: a `permanent` (any `deterministic`) failure sets `'permanent'`; a `transient` (`connection`/`blocked`) failure sets `'transient'` only if not already `'permanent'`. The sequence deterministic → transient → transient-hits-cap terminalizes as `'permanent'`, not transient.
- [x] A `shutdown` outcome re-enqueues the day, does NOT increment the attempt count, and never sets `terminal` (backoff 0). Repeated shutdowns do not terminalize.
- [x] The record-failure interface takes the failure's **outcome** (`transient` | `permanent` | `shutdown`) rather than a `countAttempt` boolean; the queue processor classifies each error into that outcome.
- [x] Class-specific retry delays are replaced by one uniform minimal backoff constant for every counted class (`next_attempt_epoch = failedAt + backoff`); the removed 15 min / 24 h / 60 s constants are gone. Readiness stays "turn-stop event fires AND `next_attempt_epoch <= now`" — no wall-clock timer is armed for dream retry.
- [x] `processDreamDate` reports whether the run invoked the remote agent (e.g. returns `{ remoteAttemptSucceeded: boolean }`); it is `false` for the quiet-day direct-commit path and the already-committed no-op early-return, `true` for a real agent success.
- [x] Transient resurrection fires only after a settle whose run reported `remoteAttemptSucceeded === true`: it clears `terminal` + `retry_disposition` and re-enqueues every OTHER day with `terminal = 1 AND retry_disposition = 'transient'` on a fresh budget. A quiet-day / no-op settle does NOT resurrect. Reconcile does not resurrect. `'permanent'` days are never auto-resurrected.
- [x] `terminal` + `retry_disposition` are cleared to their non-terminal state on `settleDreamDay` success, `markDayStale`, and manual `POST /dream` (which may still override a `'permanent'` day). Backlog eviction sets `retry_disposition = 'permanent'`.
- [x] Manual `POST /dream` and the diary agent's own non-dream retry/watchdog behavior are unchanged.
- [x] Tests at `tests/db/diary-state.test.ts` (unified counting, sticky disposition across non-terminal attempts, shutdown exemption, remote-verified vs quiet-day resurrection, backfill migration, minimal-backoff readiness) and `tests/worker/diary-runtime.test.ts` (class→outcome routing, resurrection only on `remoteAttemptSucceeded`). Drive the real store + injected clock + fake `processDreamDate`; never spin a real agent.
- [x] `bun test`, `tsc`, `bun run build` green. Read-only git. No version bump, no `.cjs` hand-edit, no touching live `~/.claude-mnemo` data. Migration forward-safe against an existing DB.

## Comments

- Unified automatic cap is 3 attempts; the uniform event floor is 10 seconds.
- Resurrection is atomic with settlement and is gated by `remoteAttemptSucceeded`; local quiet/no-op settles cannot re-grant budget.
- Verification: `bun run build` passed; `bunx tsc --noEmit` passed; `bun test` passed with 1038 pass, 0 fail, 3328 assertions across 87 files.
- Scope stayed within ticket 01: no completeness-gate/debounce or SessionStart trigger changes.
