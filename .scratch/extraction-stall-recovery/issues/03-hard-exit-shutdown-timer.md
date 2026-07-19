# 03 — Hard-exit shutdown backstop timer

**What to build:** The worker is guaranteed to exit within a bounded time after all content sessions close, even if a drain hangs. Today the worker exits proactively when no query/global work remains, but nothing bounds how long it lingers if an extraction keeps re-suspending. Add a hard-exit backstop: once all content sessions have closed, arm a configurable ~70s timer; if the worker has not already exited gracefully when it fires, abort every in-flight extraction query, release its turn back to the queue (no strike), and exit the process.

**Blocked by:** None — can start immediately. (Touches the lifecycle/shutdown region; dispatched serially with 01/02 only because they share `server.ts`.)

**Status:** ready-for-agent

- [ ] "All content sessions closed" is detected via the session-env registry emptying — NOT `hasLiveQuerySessions()`, which only means an extraction subprocess still exists and cannot identify the last main session ending.
- [ ] On that signal, a configurable hard-exit timer is armed (default ~70s = 60s drain/stall window + 10s watchdog-sweep slack); it is a separate knob from `sessionEndTailTimeoutMs`.
- [ ] If the worker exits gracefully (existing no-work exit path) before the timer fires, the timer is cancelled — the happy path is unchanged.
- [ ] When the timer fires, every in-flight extraction query is aborted via the existing `createWorkerAbortError("shutdown")` → suspend → close path (no stall/derailment strike), and the process exits. Not-yet-started queued rows need no per-turn abort (they are already unclaimed).
- [ ] A new content session / turn-stop arriving after the timer was armed but before it fires re-cancels the shutdown (there is still work); the guarantee is only "exit ~70s after the LAST session closes and stays closed".
- [ ] No new env mechanism: the path aborts rather than spawns, and in-flight agents already carry their env in-subprocess, so a cleared registry does not block it.
- [ ] Accepted degradation documented in code: a turn left in flight at hard exit is requeued but may be orphaned until a later flush re-scans (same degradation as the per-session-env design); this ticket does NOT add the resume-on-next-start rescan (deferred).
- [ ] Tests (injected clock + fake sessions + `shutdownGracefullyImpl`/coordinator seam): all-sessions-closed arms the timer; worker exits within the cap when a fake flush hangs; the in-flight turn is requeued with no strike; a late turn-stop cancels the pending hard exit.
- [ ] `bun test`, `tsc`, `bun run build` green. Read-only git. No version bump, no `.cjs` hand-edit, no touching live `~/.claude-mnemo` data.
