# Dream retry: event-driven, unified cap, regen debounce

**Status:** ready-for-agent

## Problem Statement

The nightly dream agent's failure-and-retry behavior is time-driven and unevenly bounded, which is the last open cost-tail after the 0.6.5 extraction-stall fix. Three defects compound:

1. **Wall-clock retry, not event-driven.** A failed dream is re-scheduled by a class-specific wall-clock delay (`connection` 15 min, `blocked` 24 h, `deterministic` 60 s) written into `next_attempt_epoch`, and only becomes claimable once that clock passes. This contradicts the retry model the user established for extraction stalls ("retries follow turn-stop, unified event-driven"): dream retries should ride the same turn-stop events, not a private timer.

2. **`connection` failures have no attempt cap.** In `recordDreamFailure`, the `connection` branch (`countAttempt === false`) only rewrites `next_attempt_epoch` — it never increments `attempt_count` and never trips `terminal`. Only `deterministic`/`blocked` count toward `DREAM_MAX_AUTO_ATTEMPTS`. A dream that keeps aborting is classified `connection` (idle-watchdog / timeout aborts land there) and therefore respins forever. Each respin is a full opus generation that re-reads the day's material — the mechanism behind the observed 5–21 dream runs on a single day and the associated spend spikes.

3. **Regen churn while a day's extraction straggles.** After a dream commits and settles, it recomputes the day's watermark and, if the day's material changed during the run, re-enqueues the day (`markDayStaleAndEnqueue`); `markSettledDiaryDayStaleForTurn` likewise re-marks a settled day stale on every qualifying turn-stop. When a day's extraction is still draining (turns for that content-day landing after the dream started), the day gets dreamed repeatedly — one re-dream per straggling batch — instead of once after the day's material is complete. Observed 2026-07-20: content-day 07-19 committed twice (11:51 and 12:53) because its extraction ran until ~13:05, straddling the 11:51 dream.

4. **The automatic dream is triggered from SessionStart, not from end-of-activity.** The dream backlog reconcile runs in the SessionStart Context hook, so it fires once per new Claude session regardless of activity. This is the wrong signal on two counts: semantically it is a "beginning" event driving work about *past* activity, and operationally its per-session frequency is unbounded — any budget granted there scales with sessions opened, not with work done. The dream retry drain already rides end-of-activity events (turn-stop); the automatic dream *trigger* is the one that still hangs off SessionStart.

## Solution

Make dream retry ride events and be bounded by an attempt cap rather than a clock, unify all error classes under that cap with auto-recovery for transient causes, and hold a day's (re-)dream until its extraction has quiesced.

1. **Event-driven retry with minimal backoff.** Drop the class-specific 15 min / 24 h / 60 s wall-clock delays. A failed dream retries on the next turn-stop event (already the drain trigger), gated only by a small uniform backoff that prevents thrash between two close turn-stops. The attempt cap — not the clock — is what bounds total retries.

2. **Unified attempt cap across all classes, with recovery for transient failures.** Every failed dream attempt — `connection` included — increments the day's attempt count; reaching the cap trips `terminal`, tagged with its cause. A **transient** terminal (`connection`/`blocked`) is recovered by exactly one event: another day completing a dream that **actually invoked the remote agent and succeeded** — proof connectivity/quota is back — which clears the terminal and re-enqueues it with a fresh budget. A quiet-day or already-committed **no-op settle does NOT count**: those paths commit without ever calling the remote agent, so they prove nothing about the outage and must not re-grant budget. Recovery is deliberately tied to *remote-verified progress*, not to any *trigger* event — neither reconcile nor an end-event re-grants a terminal day's budget. This matters because reconcile now runs on every end-event (§4); if recovery rode the trigger, a persistent outage would re-grant budget on every turn-stop and restore the unbounded cost this spec removes. A **permanent** terminal (any day whose failure history includes a `deterministic` cause, plus backlog-evicted days) recovers only via manual `POST /dream`, exactly as today. A **shutdown** abort is not a failure at all: it re-enqueues the day without consuming an attempt, so ordinary restarts never terminalize a day. An isolated transient-terminal day (no other day queued) is not orphaned: the next content-day's dream succeeds and clears it; if the whole system is down, cost stays bounded (each day gets its cap once, no re-grant) and the first later success clears every transient terminal.

3. **Regen debounce until the content-day is complete.** A stale/re-enqueued dream day is claimable only once its content-day is *complete*: the content-day has ended (now is past its boundary) AND the day has no non-finalized turns (`status IN ('active','provisional')`, and none of its turns still awaiting extraction). An empty extraction queue is a necessary-but-insufficient signal — because `drainQueue` already drains extraction before claiming a dream, queue-emptiness holds trivially at claim time and cannot fence out a straggler that finalizes moments later. Gating on "content-day ended + no non-finalized turns" is what actually holds the (re-)dream until the day's material is done, collapsing straggler re-dreams into one.

4. **Automatic dream is enqueued/run only by end-of-activity events, never SessionStart.** The automatic dream trigger — the backlog reconcile that enumerates due content-days and enqueues them — moves from the SessionStart Context hook onto the same end-event drain path (turn-stop / session-end / compact) that already carries extraction flush and the dream retry drain. Today it runs once per new Claude session regardless of activity, and that per-session frequency is what makes a naive budget re-grant unbounded. After the move, SessionStart no longer enumerates or triggers any automatic dream. (SessionStart still does its own unrelated work — env capture, run marker — and streaming extraction still has its PostToolUse path; this spec does not touch those. The scope is narrowly the *automatic dream* trigger.) A day the worker owes is picked up on the first turn-stop / session-end / compact after it becomes complete — exactly when its turns finalize — so there is no catch-up gap. Manual `POST /dream` is unchanged.

## User Stories

1. As the worker operator, I want a dream that keeps failing on connection errors to stop after a bounded number of attempts, so that one bad night cannot silently burn dozens of full opus runs.
2. As the worker operator, I want dream retries to fire on turn-stop events rather than on a 15-minute timer, so that the retry cadence matches the rest of the worker's event-driven model and never polls the clock.
3. As the worker operator, I want `connection`, `blocked`, and `deterministic` dream failures to all count toward one cap, so that no error class has an unbounded retry loop.
4. As the worker operator, I want a day that terminalized because of a transient outage to recover on its own once dreams start succeeding again, so that a temporary network or quota problem does not permanently lose that day's diary.
5. As the worker operator, I want a day that terminalized because of a deterministic failure to stay manual-only, so that a genuine bug is not retried forever and surfaces for inspection.
6. As the worker operator, I want a content-day dreamed only after it has ended and has no non-finalized (`active`/`provisional`/un-extracted) turns, so that a day whose extraction straggles is not re-dreamed once per straggling batch.
7. As the worker operator, I want the second, third, … re-dream of the same day suppressed until that day is complete again, so that the watermark race produces at most one dream per genuine material change after completeness.
7a. As the worker operator, I want a shutdown/restart abort of a dream to re-enqueue the day without consuming an attempt, so that routine restarts never terminalize a day.
8. As the worker operator, I want a small backoff between dream retries, so that two turn-stops seconds apart do not trigger two full opus runs back-to-back.
9. As a user reading my diary, I want each day dreamed once against its complete material, so that the committed diary reflects the whole day rather than a mid-extraction snapshot.
10. As a user, I want a transient outage during the nightly dream to self-heal, so that I do not have to manually re-trigger a day whose only problem was a network blip.
11. As the worker operator, I want the manual `POST /dream` path to still force a terminal (including deterministic-terminal) day to run, so that I retain an explicit override.
12. As the worker operator, I want the attempt cap and backoff to be configurable constants, so that I can tune the bound without a code change to the state machine.
13. As a developer, I want the retry policy (which class counts, how terminal is tagged) to live at the dream-queue-processor seam and the counting/gating to live at the diary-state-store seam, so that the behavior is testable without spinning a real agent.
14. As a developer, I want the debounce predicate expressed in the claim/ready query, so that an un-quiesced day is simply never handed out, with no extra scheduling layer.
15. As the worker operator, I want reconcile to keep excluding ALL terminal days — transient and permanent alike — so that a fresh attempt budget is never re-granted by a trigger event, which would re-open unbounded cost during a persistent outage.
15a. As the worker operator, I want a transient-terminal day recovered only by another day's remote-verified successful dream (or manual trigger), so that recovery is driven by proof the outage cleared, not by a quiet-day/no-op settle or by session/turn churn.
15b. As the worker operator, I want no automatic dream to be enqueued or run by SessionStart, so that opening a session cannot kick off dream work or its cost.
15c. As the worker operator, I want the automatic dream backlog reconcile to run on turn-stop / session-end / compact instead of SessionStart, so that a day the worker owes is picked up on the first end-of-activity event after it becomes complete, with no per-session amplification.
15d. As a user, I want opening a Claude session to never kick off an automatic dream, so that session startup stays fast and predictable.
16. As the worker operator, I want the diary agent's own non-dream behavior untouched, so that this change is scoped to the dream failure/retry/regen path.
17. As a developer, I want the schema change to be a forward-safe additive migration, so that an existing database upgrades without a rebuild.
18. As the worker operator, I want no wall-clock timer armed for dream retry, so that a dream never wakes the worker on a schedule — only events do.

## Implementation Decisions

**Modules touched (both are existing test seams — no new seam):**
- **Diary state store** (`createDiaryStateStore`): the *state machine* — unified attempt counting, terminal-with-disposition, the claim/ready predicates (backoff gate + completeness gate), transient resurrection on settle, and the `retry_disposition` write paths. The debounce lives **entirely here**, in `claimNextDiaryItem`/`hasReadyDiaryItem` — the processor only ever sees an already-claimed item, so it cannot gate a claim.
- **Dream queue processor** (`createDreamQueueProcessor`): the *policy only* — classify the failure into `transient` / `permanent` / `shutdown` and call record-failure accordingly, and on a successful settle perform the transient resurrection only when the run's `remoteAttemptSucceeded` is true. It runs no claim-time gating.
- **Dream job** (`processDreamDate`): return whether the run invoked the remote agent (`remoteAttemptSucceeded`), so the processor can distinguish a real success from a quiet-day / no-op settle.
- **Trigger wiring** (Context hook + a new runtime-owned reconcile seam called from the worker end-event drain): move the automatic dream backlog reconcile off SessionStart. The `DiaryStateStore.reconcileBacklog` method itself is unchanged; a new `DiaryRuntime.reconcileDreamBacklog(nowEpoch)` owns the orchestration and is invoked from the drain path.

**Trigger source — end-events only (new runtime seam).**
- Add a runtime-owned seam `reconcileDreamBacklog(nowEpoch): Promise<void>` on `DiaryRuntime`. The runtime already holds the `DreamMemoryStore`, config, and state store, so this seam runs `initializeBootstrap`, reads the last-successful marker via the store, applies the trigger-hour gate, and calls the existing `DiaryStateStore.reconcileBacklog`. Prototype signature (encodes the ownership decision):
  ```ts
  interface DiaryRuntime { reconcileDreamBacklog(nowEpoch: number): Promise<void>; /* ...existing */ }
  ```
- Remove the `reconcileBacklog` + `initializeBootstrap` calls from the SessionStart Context hook. **Correcting an earlier claim:** `initializeBootstrap` is currently invoked only from SessionStart and from `POST /dream` — NOT from worker startup — so the bootstrap responsibility must be carried by the new seam (which runs on every end-event), not assumed to exist elsewhere.
- Invoke `reconcileDreamBacklog` from the end-event drain path (turn-stop / session-end / compact), before the diary drain and after extraction has drained — the same `scanAndDrainGlobalQueue` → drain sequence that already carries the retry drain. The trigger-hour gate lives inside the seam so a still-open content-day is not enqueued prematurely (the completeness gate is the backstop).
- reconcile stays cheap and idempotent (INSERT-ON-CONFLICT enqueue + terminal demotion, no attempt reset), so running it on every end-event is fine; it never re-grants budget to a terminal day.

**Unified attempt cap.**
- Remove the `countAttempt === false` exemption in `recordDreamFailure`. Every non-shutdown failure increments `attempt_count`; `terminal` trips when `attempt_count` reaches the cap. Keep a single cap constant (currently `DREAM_MAX_AUTO_ATTEMPTS`); its value is a tunable — propose 3 (was effectively 2 for counted classes, ∞ for connection).
- The record-failure interface drops the `countAttempt` boolean and instead takes the failure's **outcome** — `transient` | `permanent` | `shutdown` — so the store can both count and tag terminal.
- **`shutdown` is exempt from the cap:** it re-enqueues the day and does NOT increment `attempt_count` or set `terminal` (backoff 0). This is the one case that must not consume budget — the processor already distinguishes a shutdown abort; that distinction now drives the exemption instead of a delay of 0.

**Failure disposition tagging + resurrection (schema change).**
- Add one forward-safe column to `diary_day_state`: `retry_disposition TEXT` (null | `'transient'` | `'permanent'`). It tracks the **current retry cycle's** disposition and is deliberately allowed to hold `'permanent'` even before the day is terminal — the `terminal` boolean and the disposition are independent. Idempotent `hasColumn`-guarded `ALTER`, same pattern as the 0.6.5 `extraction_stall_*` columns.
- **Why a cycle-scoped field, not a terminal-only tag:** deterministic-stickiness must survive attempts that have not yet reached the cap. Example: attempt 1 `deterministic`, 2 `transient`, 3 `transient` → without a persisted disposition, nothing would remember attempt 1 and the day would wrongly recover as transient. `retry_disposition` records `'permanent'` at attempt 1 and holds it.
- **Deterministic-sticky write rule:** a `permanent` (any `deterministic`) failure sets `retry_disposition = 'permanent'`; a `transient` (`connection`/`blocked`) failure sets `'transient'` only if not already `'permanent'`. Once `'permanent'`, it stays permanent for the cycle regardless of later transient failures.
- **Migration backfill:** existing `terminal = 1` rows (deterministic/blocked failures or backlog eviction — all already manual-only) backfill `retry_disposition = 'permanent'`, preserving current behavior. Non-terminal existing rows backfill NULL.
- **Backlog eviction** (reconcile demoting old due days) sets `retry_disposition = 'permanent'` — manual-only, same class as deterministic.
- **Disposition is cleared to NULL** whenever the retry cycle ends: `settleDreamDay` success, `markDayStale`, and the manual `POST /dream` reset `terminal = 0` (where set) and `retry_disposition = NULL`. The manual path may override even a `'permanent'` day, unchanged.
- **Transient resurrection — one event, gated on a remote-verified success:** resurrection fires only when another day completes a dream that **actually invoked the remote agent and succeeded**; it clears `terminal` + `retry_disposition` and re-enqueues every OTHER day whose `terminal = 1 AND retry_disposition = 'transient'`, with a fresh budget. A **quiet-day** commit (no material → `commitNight` without the agent) and an **already-committed no-op** early-return both settle WITHOUT proving recovery and must NOT resurrect. This requires `processDreamDate` to surface whether the run hit the remote — e.g. return `{ remoteAttemptSucceeded: boolean }` (false for quiet-day and early-return) — and the queue processor performs the resurrection only on `remoteAttemptSucceeded === true` after settle. Reconcile does NOT resurrect (it runs on every end-event); it continues to exclude every terminal day (transient and permanent alike), unchanged from today.

**Event-driven retry + minimal backoff.**
- Replace the class-specific delays (`DREAM_CONNECTION_RETRY_MS` 15 min, `DREAM_BLOCKED_RETRY_FLOOR_MS` 24 h, deterministic 60 s) with one small uniform backoff constant used for every counted class's `next_attempt_epoch = failedAt + backoff`; `shutdown` uses 0.
- The turn-stop-driven `scanAndDrainGlobalQueue` remains the sole drain trigger; no wall-clock timer is armed for dream retry. Readiness stays "event fires AND `next_attempt_epoch <= now`", where `next_attempt_epoch` is now only the minimal-backoff floor. This mirrors the extraction-stall "event AND backoff" gate.
- Manual `POST /dream` keeps its zero-delay continuation and its terminal-override.

**Regen debounce — content-day completeness gate (state-store predicate).**
- Add a completeness gate to `claimNextDiaryItem`/`hasReadyDiaryItem` (NOT the processor): a dream day is claimable only when its content-day is *complete*. Completeness = the content-day has ended (now past its boundary end, using the persisted timezone + `dream_hour` boundary already used by `markSettledDiaryDayStaleForTurn`) AND the day has no non-finalized turns. **The non-finalized turn statuses are EXACTLY `active` and `provisional`** (`turns.ts` already uses `status IN ('active','provisional')` for this); every other status — `extracted`, `skipped`, and any future terminal status — is finalized and must NOT block. Do not implement this as `status != 'extracted'`, which would let `skipped` (or `failed`/`undone`, if added) block a day forever. Sketch (decision-encoding, not final SQL):

  ```
  claimable(day) :=
        pending_queue row kind='diary', target_id=day, unclaimed
    AND diary_day_state.terminal = 0
    AND (next_attempt_epoch IS NULL OR next_attempt_epoch <= now)     -- minimal backoff
    AND now >= boundary_end(day)                                      -- content-day ended
    AND NOT EXISTS (                                                  -- no non-finalized turns
          turn t where content_date(t) = day
                   AND t.status IN ('active','provisional')
        )
  ```
  Queue-emptiness is subsumed (a still-queued extraction turn for the day is non-finalized); it is not the primary signal.
- Keep the existing post-settle watermark race-close (`markDayStaleAndEnqueue`): a turn that finalizes mid-dream still re-enqueues the day, but the completeness gate holds the re-claim until the day is done again, collapsing repeated straggler re-dreams into one.

**Out-of-band interactions preserved.** `settleDreamDay`, `markDayStale`, `markDayStaleAndEnqueue`, `initializeBootstrap`, the content-day boundary bucketing, and the idle-watchdog per-attempt kill are unchanged except where the above explicitly amends them.

## Testing Decisions

**What a good test asserts here:** external state transitions of the dream day and the claim/ready decisions — not internal call sequencing. Drive the real `createDiaryStateStore` against an in-memory DB and the `createDreamQueueProcessor` with an injected clock + fake `processDreamDate`; never spin a real agent.

**Diary state store (`tests/db/diary-state.test.ts` — existing prior art):**
- A `connection` failure now increments `attempt_count` and trips `terminal` with `retry_disposition='transient'` at the cap (proves the exemption is gone).
- Mixed classes count toward one cap: `connection` + `connection` + `deterministic` terminalize at the unified cap, not by any single class's private budget.
- **Deterministic-sticky across non-terminal attempts:** the sequence `deterministic` (below cap, not yet terminal) → `transient` → `transient`-that-hits-cap terminalizes with `retry_disposition='permanent'`, NOT transient (proves the disposition persisted from attempt 1). A `transient`-only history yields `'transient'`.
- **Shutdown exemption:** a `shutdown` outcome re-enqueues the day, leaves `attempt_count` unchanged, and never sets `terminal` — repeated shutdowns do not terminalize.
- **Transient resurrection — remote-verified success only:** a settle whose run reports `remoteAttemptSucceeded=true` clears + re-enqueues another day's `'transient'` terminal with a fresh budget and leaves a `'permanent'` terminal untouched. A **quiet-day** settle and an **already-committed no-op** settle (`remoteAttemptSucceeded=false`) do NOT resurrect. **Reconcile does NOT resurrect:** a reconcile pass leaves a `'transient'` terminal terminal and re-grants no budget — asserts the unbounded-per-trigger cost is closed.
- **Completeness gate:** `hasReadyDiaryItem`/`claimNextDiaryItem` withhold a day while its content-day has not ended, or while it has a turn bucketed to it with `status IN ('active','provisional')`; the day becomes claimable once ended AND all its turns are finalized. A day with only `extracted`/`skipped` turns is NOT blocked (guards against a `status != 'extracted'` misread).
- `next_attempt_epoch` reflects only the minimal backoff, not a class delay; the item is claimable on the next event once the small backoff has elapsed.
- **Forward-safe migration + backfill:** an existing DB with `terminal = 1` rows and no `retry_disposition` column upgrades via the idempotent ALTER; those rows read back as `'permanent'` and non-terminal rows as NULL.
- **Backlog eviction** demotes an old due day to `terminal` with `retry_disposition='permanent'`.

**Dream queue processor (`tests/worker/diary-runtime.test.ts` — existing prior art, injected clock + fake processDreamDate):**
- Each error class routes to the unified record-failure with the correct outcome (`transient`/`permanent`/`shutdown`); no class takes an unbounded path.
- The post-settle watermark race still re-enqueues a day whose material changed mid-run, but a subsequent claim is withheld until the day is complete (debounce end-to-end through the store).
- Manual `POST /dream` still overrides a terminal day (including `'permanent'`).
- Regression: the diary agent's non-dream retry/watchdog behavior is unchanged.

**Trigger wiring (`tests/hooks/context.diary.test.ts` + `tests/worker/server.test.ts` — existing prior art):**
- **SessionStart no longer triggers automatic dream:** the Context hook no longer calls `reconcileBacklog`/`initializeBootstrap`; a SessionStart with a due content-day enqueues nothing. (SessionStart's env/marker capture is left in place — not asserted away.)
- **`reconcileDreamBacklog` seam does its own bootstrap:** with no prior `initializeBootstrap` call, invoking the seam initializes the cutover and reconciles — proving the bootstrap gap left by removing the SessionStart call is closed.
- **End-events trigger reconcile:** a turn-stop / session-end / compact runs `reconcileDreamBacklog` (after the trigger hour) and a complete, due content-day is enqueued and drained from that path.
- A due day that becomes complete only after SessionStart is still picked up on the next end-event (no catch-up gap).

## Out of Scope

- The shared-deadline parallel drain coordinator / shutdown admission barrier (deferred from the extraction-stall spec) — unrelated to dream retry.
- The extraction-side SessionEnd-tail `connection` retry (a separate straggler source that delays extraction; only relevant here as a *cause* of late-landing turns, not fixed by this spec).
- Tuning the exact cap value and backoff duration beyond exposing them as constants.
- Any change to how the dream agent generates content, the 4am content-day boundary, or the memory/history snapshot/commit transaction.
- The unresolved-but-harmless forensic curiosity from 2026-07-20 (a second `commitNight` whose output differed from its pre-state with no second agent transcript); debounce removes the double-commit trigger regardless of that detail.

## Further Notes

- **Why the cap, not the clock, is the real fix.** The 0.6.5 extraction-stall spike and the dream multi-run days share one shape: an abort misrouted onto an uncapped retry that cold-rebuilds an expensive prefix each time. 0.6.5 capped extraction stalls; this caps dream. After both, no worker retry path is bounded only by a wall-clock cadence.
- **Blocked (quota) under a minimal backoff.** Dropping the 24 h floor means a quota block retries within a few turn-stops then terminalizes as `transient` — recovering on the next other-day success (i.e., once quota returns and some day dreams). This bounds quota-retry cost by the cap instead of parking the day for a day; acceptable because a dream is never urgent and the day self-heals at the next success.
- **Debounce vs the day boundary.** The completeness gate makes "dream a day once, after it's done" fall out without a separate scheduler: the day is not claimable until it has ended AND all its turns are finalized. The `pending_queue`-empty condition alone could not express this (extraction drains before dream claim, so it is trivially satisfied); the gate reads turn `status` and the content-day boundary directly.
- **Why transient recovery is not an unbounded loop.** Recovery resets the failed day to a fresh attempt budget, but the sole recovery event — a *different* day's successful settle — is proof of forward progress, not a timer or a session event. It cannot fire against a persistent outage (nothing succeeds), so a persistent outage leaves each transient-terminal day terminal after its one capped budget; cost stays bounded. This is why recovery is deliberately NOT on the reconcile/SessionStart path, which fires regardless of progress and would re-grant budget every session.
- **Completeness gate reads turn `status`.** It depends on `active`/`provisional` being the non-finalized statuses (see the turn-status audit note); a future new turn status must be classified finalized-or-not here, or a straggler in the new status would slip past the gate.
- **Uniform automatic-dream trigger (concept integrity).** After this change the automatic dream — both its backlog enqueue and its retry drain — hangs off exactly one class of signal: end-of-activity (turn-stop / session-end / compact); nothing automatic-dream-related hangs off SessionStart. This closes the per-session unbounded-cost hazard at its root rather than patching budget arithmetic. Scope note: this does not claim SessionStart is fully read-only (it still captures env + writes a run marker) nor that all extraction is end-event-driven (streaming extraction still fires on PostToolUse) — those are out of scope and unchanged.
- Corrects the prior root-cause note that blamed dream multi-runs on the from-empty migration path; the real amplifier is the uncapped wall-clock `connection` retry. The from-empty path is currently dormant (migration settled, all memory docs present).
