# Dream trigger becomes turn-stop-driven, not worker-liveness-driven

**Status:** ready-for-agent

## Problem Statement

The nightly dream agent (one ~14-minute opus run that writes the day's diary + curates hot memory, then commits) runs a wildly different number of times depending on the day: 07-19 ran it once (~$4), but 07-17 aborted-and-retried it 8 times and 07-18 ~5 times. Multi-run days burn several times the quota for the same one night's output.

Root cause: the dream's **drain** is triggered by **worker-liveness events**, not by real work. Concretely, the dream only runs at the tail of a *global* `scanAndDrainQueue` (sessionFilter === undefined), and a global scan is fired by: worker-start recovery, `POST /wake`, a standalone time-based `persistentRetryTimer` that re-fires whenever a `next_attempt_epoch` comes due while the worker is alive, and the SessionStart `reconcileBacklog`. A turn-stop drain is *session-scoped* and deliberately skips diary work, so genuine active work does NOT drive the dream at all.

The failure amplifies because the dream is force-aborted on graceful shutdown when the last live session closes (`checkForLastAgentShutdown` aborts the in-flight dream — the sole exception to "let queue work finish"). So a dream that starts, runs partway, then loses its session gets aborted; it is re-enqueued with a retry epoch; and every subsequent worker-start / wake / retry-timer beat re-picks it. On a churny day (07-18 had 37 worker starts) the same night's dream is restarted from scratch again and again. On a calm day where one session happens to stay alive the full ~14 minutes (07-19, because an interactive session was held open), it completes in one run — but that is luck, not design.

## Solution

Make the dream event-driven like the rest of the post-0.5.0 / 0.6.2 worker: it fires **only when a new turn-stop is enqueued** (genuine active work), never merely because the worker came alive, a session resumed, or a timer elapsed. A session that is actively producing turns is exactly the session most likely to stay alive for the ~14 minutes the dream needs, so the dream tends to complete in a single run, and the worker-liveness re-fire storm disappears. Retry follows the same rule already shipped for connection-error resume in 0.6.2: an aborted or failed dream stays enqueued and is retried on the *next* turn-stop, not by a standalone clock.

This is scope 1 of the diagnosis. It does not change the shutdown-abort behaviour itself (scope 2, deferred).

## User Stories

1. As the user, I want the dream to run about once per completed day, so that my 5-hour quota is not spent restarting the same night's job several times.
2. As the user, I want the dream to fire while I am actively working (turns flowing), so that it runs inside a session that will stay alive long enough to finish.
3. As the user, I want a churny/incident day with many worker restarts to NOT multiply dream runs, so that worker instability does not become quota cost.
4. As the user, I want resuming a session (SessionStart) to enqueue a due dream but not immediately drain it, so that a resume that is not followed by real work does not start a dream that will be orphaned.
5. As the user, I want an idle worker (alive but no new turns) to NOT re-fire the dream, so that background liveness is not a trigger.
6. As the dream agent, I want to be started only when there is genuine turn activity, so that I get a stable window to reach my commit.
7. As the dream agent, I want a retry after an abort/failure to wait for the next turn-stop, so that I am not restarted into the same doomed no-session window.
8. As the dream agent, I want an existing `next_attempt_epoch` backoff to still be respected as a floor, so that I do not retry faster than the backoff even when turns are flowing.
9. As the worker, I want one scheduling model (turn-stop drives everything: extraction, connection-resume, and now the dream), so that the dream is no longer a special time-driven exception.
10. As a future maintainer, I want the standalone `persistentRetryTimer` removed, so that there is no second, clock-based path that can re-fire the dream behind the event-driven model's back.
11. As the user, I want at-most-one dream per drain and session work still buffered first, so that the existing diary-vs-session fairness is unchanged.
12. As the user, I want a completed/terminal day to stay done, so that turn activity does not re-run an already-committed or 3-strike-terminal day.
13. As the user, I want the manual `POST /dream` trigger to keep working (reset + enqueue + prompt drain), so that I can still force a specific day.
14. As the user, I want a day that becomes due while I am mid-session to be picked up by my next turn-stop, so that I do not have to restart to get it.
15. As a maintainer, I want the change confined to the worker's queue-drain scheduling, so that the diary/dream job logic, staging, and commit transaction are untouched.

## Implementation Decisions

- **Trigger inversion.** The global diary drain (the dream) moves off worker-liveness events and onto the turn-stop path. After a session-scoped turn-stop drain settles its session work, the worker kicks a global diary drain (the existing "at most one diary per global drain, session work buffered first" fairness is preserved — only *what invokes it* changes).
- **Remove the standalone retry timer.** `schedulePersistentRetry` / `persistentRetryTimer` (the clock-based re-fire that runs purely on worker-liveness) is deleted. Retry becomes event-driven: an aborted/failed dream stays enqueued (as today) and is re-drained on the next turn-stop. This mirrors the 0.6.2 connection-error "enqueue-to-resume" decision — reuse that shape, do not invent a second one.
- **Keep the backoff as a floor, not a timer.** The `next_attempt_epoch` on `diary_day_state` may remain as data and gate "do not retry before this epoch" *inside* the turn-stop-driven drain, exactly as 0.6.2 kept a time-backoff floor under event-driven resume. It no longer schedules its own callback.
- **Enqueue on SessionStart stays; drain does not.** `reconcileBacklog` on SessionStart continues to mark completed days due and enqueue diary items (enqueue only). Resume no longer drives the dream's drain; the first turn-stop does.
- **Worker-start / `/wake` no longer drain the dream.** A global scan triggered purely by liveness (crash recovery, wake) must not run the diary tail. Only a turn-stop-originated global diary drain runs the dream. (Turn/obs recovery on worker-start is unaffected.)
- **Terminal/idempotency guards unchanged.** The existing `readLastSuccessfulDate` early-return, 3-strike `terminal`, and `claimNextDiaryItem` claim semantics are untouched — a done or terminal day is never re-run by turn activity.
- **Manual `POST /dream` unchanged.** It still resets to a retryable state, enqueues, and schedules a prompt drain; after this change that prompt drain is the manual analogue of a turn-stop trigger.
- **Scope confinement.** Only the queue-drain scheduling in the worker server changes. `dream-job` / `diary-runtime` (the job that runs the agent, staging, commit transaction) are not touched.

## Testing Decisions

- **Seam (single, highest existing).** Drive the worker core / server `main()` with injected deps — `processDiaryItem` mock, injectable clock (`setTimeoutImpl` / `now`), and a real `diary-state` store — and assert on whether `processDiaryItem` is invoked. This is the same seam the diary-fairness tests (`tests/worker/server.test.ts`, "dispatches diary work before touching session state" / "global drain buffers session work before processing at most one diary") and the 0.6.2 connection-resume tests already use. No new seam is introduced.
- **Good tests assert external behaviour**, not timer internals: whether the dream (`processDiaryItem`) runs or not for a given sequence of events — not which timer handle was set.
- Behaviours to cover:
  1. A turn-stop enqueue for a live session, with a due diary item present, drives exactly one `processDiaryItem` call.
  2. Worker-start / wake / clock-advance with a due diary item but NO new turn-stop does NOT call `processDiaryItem` (the removed liveness trigger).
  3. Advancing the mock clock past a former `next_attempt_epoch` does NOT re-fire the dream on its own (the timer is gone).
  4. After a `processDiaryItem` that throws (aborted/failed dream), the NEXT turn-stop re-drains it (event-driven retry); the mock succeeds and the day settles.
  5. A `next_attempt_epoch` in the future is respected as a floor: a turn-stop before that epoch does not retry; a turn-stop after it does.
  6. Fairness preserved: within one turn-stop-driven global drain, session work is buffered/processed before at most one diary item.
  7. A day already at `last-successful` (done) or `terminal` is not re-run by turn activity.
- Regression: the existing diary-fairness and manual-`/dream` tests must stay green (adjusted only where they asserted the old liveness-drain trigger).

## Out of Scope

- **Scope 2 — finish-before-shutdown.** Not force-aborting an in-flight dream on graceful shutdown (`checkForLastAgentShutdown`) is a separate, complementary change and is explicitly deferred. Scope 1 alone reduces the storm to at most one wasted run (a single-turn-then-idle session can still start-then-abort once, self-healing on the next active session); zero-waste needs scope 2.
- The legacy `persona/CURRENT` migration log noise ("Legacy persona CURRENT is missing… from empty documents") — confirmed a benign red herring (a 7-line burst per SessionStart reconcile scanning a retired layout, no agent spawn, no rebuild). Not touched.
- The dream budget / trim behaviour and the turn-significance grading rubric — already shipped in 0.6.3.
- The dream's ~14-minute duration, its model (opus), staging, and commit transaction.
- The older 0.4.0-era multi-run mechanism (120s idle-watchdog killing opus mid-reasoning; the 07-11/12/14 `empty{}` storms) — already fixed by the 0.4.1 10-minute idle watchdog.

## Further Notes

- **Root-cause evidence.** Diary-failure signatures: `shutdown` ×8 on 07-17 (target 07-15) and ×1 on 07-19 (target 07-18); worker starts 39 vs 2. The 07-19 single run coincided with an interactive session held open the full ~14 minutes — luck, not design. The persona/CURRENT theory from an earlier turn was disproven here.
- **Conceptual integrity.** Post-0.5.0 the worker is event-driven on turn-stop (extraction) and 0.6.2 made connection-error resume event-driven too. The dream's standalone time-based `persistentRetryTimer` is the lone clock-driven exception; folding the dream onto turn-stop unifies the model rather than adding a mechanism.
- **Standing constraints for the implementer (Codex or otherwise):** never run any git command; no version bump; do not rebuild `plugin/scripts/*.cjs` (the stale-bundle guard failing by 1 is the expected baseline until Claude rebuilds); do not touch live data under `~/.claude-mnemo`.
- Fold the resolved diagnosis into memory `project_dream_agent_0_4_0` (correcting the persona/CURRENT note already written this session) once shipped.
