# Extraction stall recovery + bounded shutdown drain

**Status:** draft · ready-for-agent

## Problem Statement

The memory-agent's extraction flushes are being killed and retried in a loop, burning cache-creation cost with almost no output to show for it. On 2026-07-19 the agent cost ~$99 (baseline ~$15-20/day); ~$47 was cache creation, of which ~$38 was 60 large cold prefix re-creations, and ~$36 of those landed in exactly the sessions that were being aborted repeatedly by the stall-watchdog (S13743 aborted 31×, S1730 22×). Output was only ~$5 — the money bought re-caching, not memories.

Three defects compound:

1. **The stall-watchdog is not a stall detector.** It reads a timestamp frozen at send-start (`lastPushAt`, set once before the flush is dispatched and never updated during streaming), so `now - lastPushAt` is really the current turn's total elapsed time. Since the 0.6.1→0.6.2 change (commit `9c50359`, issue 02) narrowed what counts as progress, the first recognized progress permanently disables the watchdog for the rest of the turn — so in practice it fires on any turn that takes >30s to produce its *first* substantive output, regardless of whether the turn is healthy. A slow-first-token flush on a large batch is a false positive.

2. **A genuine stall has no bounded escalation.** A `stall-watchdog` `WorkerAbortError` is classified as a *connection* error, which routes it onto the 0.6.2 "non-terminal, retry on every turn-stop, resume (not fresh)" path. So a session that always stalls loops forever: resume → stall at 30s → abort → resume → …, and because Claude Code cannot reuse a prior process's prompt cache on resume, every iteration cold-recreates the whole transcript prefix. The `forceFresh` (T3) and 3-strike skip machinery that would break this loop already exists, but is wired only to the *derailment* state machine (wrong-output strikes), never to stalls.

3. **Worker shutdown has no hard time bound.** The worker already exits proactively once no query/global work remains, and each ending session drains its tail under a per-session budget. But there is no *worker-level* ceiling: if a drain hangs (e.g. a stall that keeps re-suspending), nothing guarantees the process exits within a bounded time after the last session closes.

## Solution

Make the watchdog measure real inactivity, give genuine stalls a bounded escalation that reuses the existing fresh-session and skip machinery, and time-box the worker's final drain when all sessions have exited.

1. **Real-activity stall detection.** Track a real "last agent output" timestamp that advances whenever the extraction agent streams *any* content (text, tool call, or tool result), and abort only when it has been silent for 60s — a sliding no-progress window, not a total-turn cap and not a to-first-progress gate. Network errors and quota/billing limits keep their existing dedicated classification paths untouched.

2. **Bounded stall escalation.** A true stall is no longer treated as an unbounded connection error. It consumes an attempt and escalates: 1st stall → suspend and retry (resume) on the next turn-stop; 2nd stall → retry with a brand-new session (`forceFresh`, no resume) so the loop can't re-stall on the same poisoned/oversized transcript and can't cold-recreate it; 3rd stall → mark the turn extraction-failed and skip it, so one pathological turn can never block the queue. Backoff applies between attempts. Real network/quota failures still retry indefinitely — they are not stalls.

3. **Hard shutdown deadline.** When the worker detects that all content sessions have closed, it must exit within ~70 seconds no matter what (60s drain/stall window + 10s watchdog-sweep slack). The existing per-session drains run as they already do; a single hard-exit backstop timer guarantees the process does not linger. When the deadline fires, every still-in-flight extraction query is aborted, its turn released back to the queue via the existing suspend/"shutdown" path (no strike), and the process exits. A turn left unprocessed this way is orphaned until some later flush re-scans the queue — the same accepted degradation already carried by the per-session-env design (an already-ended session cannot re-announce, so its stray work ages out). No new env mechanism is needed: live agents already carry their env in the subprocess (it is baked in at spawn, not re-read per flush), and the deadline path aborts rather than spawns.

   *Deferred to a follow-up spec (owner decision):* a shared-deadline parallel drain coordinator, a shutdown admission barrier that rejects new `/wake`/`/trigger`/`/flush`/`/compact` mid-window, and a guaranteed resume-on-next-start rescan. This spec only guarantees the worker exits on time; it does not guarantee the leftover turn is drained before exit.

## User Stories

1. As the worker's owner, I want a slow-but-healthy extraction turn to be left alone, so that I am not billed to re-cache a transcript for a turn that was making progress.
2. As the worker's owner, I want a truly hung extraction turn to be detected within ~60s of real inactivity, so that a dead agent is reclaimed promptly without false positives.
3. As the worker's owner, I want a stall to consume a bounded number of attempts, so that no session can loop on resume→stall→resume indefinitely.
4. As the worker's owner, I want the second stall attempt to open a fresh session instead of resuming, so that a re-stall does not cold-recreate the same large prefix and the loop actually breaks.
5. As the worker's owner, I want a turn that stalls three times to be marked extraction-failed and skipped, so that one pathological turn cannot wedge the whole queue.
6. As the worker's owner, I want genuine network errors and quota limits to keep retrying on their existing paths, so that a transient outage never causes a turn to be permanently skipped.
7. As the worker's owner, I want a stall abort to be reclassified out of the connection bucket, so that stalls and network blips are handled by the mechanism appropriate to each.
8. As the worker's owner, I want the watchdog to keep watching after the first output, so that a turn that hangs *after* producing some output is still caught.
9. As the worker's owner, I want per-attempt backoff on stalls, so that escalation does not hammer the API in a tight loop.
10. As a session that is still live, I want my own tail turns to keep draining at leisure while other sessions are active, so that ending one session does not force a rushed drain.
11. As the worker's owner, I want the worker to exit within ~70 seconds of all content sessions closing, so that it never lingers holding resources after work is done.
12. As the worker, I want a hard-exit backstop timer independent of whether a drain hangs, so that a stuck extraction can never keep the process alive indefinitely.
13. As the worker, I want to arm that timer off the "all content sessions closed" signal (the session-env registry emptying), not off "a query subprocess exists", so that the trigger is correct.
14. As the worker, I want any turn still in flight when the hard-exit fires to be aborted and released to the queue with no strike, so that the shutdown itself never marks a turn failed.
15. As the worker's owner, I want to rely on the existing per-session env with no new mechanism, so that shutdown adds no env-handling complexity.
17. As a maintainer, I want the stall count, the fresh-session escalation, and the shutdown requeue to be observable in the log, so that a future cost spike can be diagnosed from the log alone.
18. As the worker's owner, I want the 60s stall threshold and the 60s shutdown budget to be configurable, so that they can be tuned without a code change.

## Implementation Decisions

- **Modules touched:** the worker core state machine (session state, the stall watchdog, the flush/retry routing, the finish/shutdown path) and the error classifier. Configuration gains the new thresholds. No schema change; the queue and turn-status tables already carry everything needed (queued turns, `suspend`, turn status).

- **Real-activity timestamp replaces the frozen send-timestamp for stall purposes.** Introduce a monotonically-advancing "last agent activity" signal, distinct from the send-start timestamp, updated on every streamed unit from the agent — assistant text (including partial), `mcp__mnemo__remember` and `recall` tool use, tool results, and thinking/tool-progress events. Explicitly do NOT count `api_error` events as activity (that was the 07-18 failure mode: a watchdog fed by error events never fires). The watchdog predicate becomes "an in-flight request exists AND now - lastActivity > stall threshold". Keep the existing send-start timestamp only for whatever else consumes it (keepalive/cache-TTL logic); do not overload it for stall detection.

- **Partial-stream events must be enabled at the SDK boundary.** The agent query options do not currently surface partial assistant messages, so a single long text generation produces no callback until the whole message assembles — which a naive "any streamed content" watchdog would still misread as silence. `query-session.ts` must enable and parse partial stream events, and that wiring is in scope and under test. (Corrects the original seam list, which omitted `query-session.ts`.)

- **Stall threshold = 60s (configurable); effective detection is ~60–70s.** The watchdog sweeps on a ~10s cadence, so a 60s threshold detects at 60–70s wall-clock — acceptable, but stated so tests assert the band, not an exact 60s. Distinct from `sessionEndTailTimeoutMs` (per-session tail) and `TURN_STOP_TIMEOUT_MS`.

- **Scope correction on "disables for the rest of the turn".** The first recognized progress disables the watchdog only for the *current* `sendPrompt`; a corrective resend writes a fresh send-timestamp and is watched again. The real defect is the to-first-progress gate per send, not a whole-turn latch — the sliding-window fix (above) addresses both a slow first token and a hang after early output.

- **Extraction stalls get their own abort class — do NOT globally reclassify `stall-watchdog`.** The classifier currently sets `hasConnectionSignal` for `workerAbortReason === "stall-watchdog"`, but the **diary agent uses the same reason** with different retry accounting; a global reclassification would silently change diary behavior (violating "diary out of scope"). Introduce an extraction-specific stall abort reason/class so only the extraction flush path escalates; `shutdown` and the diary's `stall-watchdog` are untouched.

- **The stall counter must be durable and separate — this requires a schema change (owner-approved).** The existing in-memory `BatchEntry.attempts` counts thrown *deterministic delivery* failures, resets to 0 on suspension, and drives `delivery-dropped` — NOT an unextracted-turn `failed`. It cannot survive a stall suspension (the suspend path clears `batchQueue` and rebuilds later batches with `attempts: 0`), and sharing it would let, e.g., two delivery errors plus one stall terminalize a turn immediately; merged batches (one flush, several turns) muddy ownership further. So add a **durable per-turn stall counter** (a new column on `turns` or `pending_queue`) that survives suspension, batch rebuild, and worker restart. This is the only way to honor the "can never loop" guarantee; it consciously overrides the earlier "no schema change" note.

- **Stall escalation state machine** (the resume/fresh/skip primitives — `ensureQuerySession`, `reopenQuerySessionFresh`/`forceFresh`, and the derailment-floor skip — already exist; the durable counter, the trigger, and the fresh-retry plumbing are new):

  ```
  onExtractionStall(turn):
    turn.stallAttempts += 1        // DURABLE, per-turn
    if   turn.stallAttempts == 1: suspend(nextMode = resume)
    elif turn.stallAttempts == 2: suspend(nextMode = forceFresh)
    else                        : markExtractionFailedAndSkip(turn)
    // retry fires on the next turn-stop AND only after backoff has elapsed
  ```

- **`forceFresh` must be reachable from the suspend→resume path.** Today only the derailment machine calls `reopenQuerySessionFresh`; a resumed suspension always reconstructs from `lastAgentSessionId`. The suspension record must carry a stable **next-retry mode** (resume vs forceFresh) and the work identity, and that mode must be consulted before the first send after resume. Escalating to fresh on the 2nd stall is also the cheaper path: a fresh session cold-starts from the bounded SessionStart re-prime, not the full accumulated transcript.

- **Backoff is required and gated on both signals.** Current suspension lifts on `newer turn-stop OR backoff-expiry` — a new turn-stop bypasses backoff. For stalls specifically, require **both** an event and elapsed backoff, so an active session cannot hammer a re-stalling flush every turn.

- **Network/quota paths are unchanged.** Connection-class (transient) errors keep retrying with no strike; blocked-class (billing/402) keeps its gate. Only genuine extraction stalls move to the bounded, durable path.

- **Shutdown = a hard-exit backstop timer, nothing more (scope cut by owner).** Per-session drain is unchanged (each session's tail still drains under `sessionEndTailTimeoutMs`). The single new guarantee: once all content sessions have closed, the worker exits within a configurable ~70s hard cap. The happy path already exits proactively when no query/global work remains; the backstop timer only covers the case where a drain hangs. When it fires, abort every in-flight extraction query, release its turn via the existing `createWorkerAbortError("shutdown")` → `suspendSessionAfterRetryableError` → `closeSessionQuery` path (no strike), and `process.exit`. Not-yet-started rows are already queued/unclaimed and need no per-turn abort.

- **"All content sessions closed" detection.** `hasLiveQuerySessions()` means "an extraction query subprocess still exists", not "the last main session ended", so it cannot be the sole trigger. Use the session-env registry emptying (every ended session clears its captured env in the finish `.finally()`) as the "all content sessions closed" signal to arm the hard-exit timer; the existing no-work exit guards still gate the graceful path.

- **No new env mechanism.** Env is baked into each agent subprocess at spawn and is not re-read from the registry per flush, so an in-flight drain keeps working after its env is cleared; and the hard-exit path aborts rather than spawns, so it never needs a cleared session's env. The 0.6.4 per-session env registry is sufficient as-is.

- **Configurable hard-exit cap, separate knob.** Default ~70s (60s drain/stall window + 10s watchdog-sweep slack). Do not reuse `sessionEndTailTimeoutMs`; a per-session tail budget and a worker-level hard-exit cap are different knobs.

- **Observability.** Log, at minimum: a stall abort with its attempt number and the escalation taken (resume / fresh / skip); the all-sessions-exited shutdown-drain start with the count of remaining turns; and each shutdown requeue. These make a future spike diagnosable from `claude-mnemo.log` without needing the agent transcripts.

## Testing Decisions

- **Good test = external behavior at the worker-core seam, driven by an injected clock and fake query sessions — never wall-clock sleeps or real subprocesses.** Assert on outcomes: was the session aborted, was the retry a resume or a fresh session, was the turn skipped, was the item requeued, did the worker exit. Do not assert on internal timestamp fields.

- **Primary seam (existing, reuse it):** the worker core built via its dependency-injection factory with `nowMs`/`setTimeoutImpl` overrides, fake `createWorkerQuerySession`, and injected `shutdownGracefullyImpl`. The watchdog is already driven in tests by calling `abortStalledSessions(nowMsOverride)` directly (`abortStalledSessions closes only sessions with an overdue in-flight request`, `... skips sessions that are compacting`). The dream shutdown/requeue shape is prior art (`shutdown interruption preserves … retries on the next turn-stop`).

- **New seam needed:** `query-session.ts` must be tested for partial-stream liveness (the fake query session must be able to emit a partial-assistant-text event that counts as activity, and an `api_error` event that does NOT). The current fake covers whole-message callbacks only. `shutdownGracefullyImpl` is presently a zero-arg cleanup; the hard-exit timer needs either an expanded contract or a small dedicated seam driven by the injected clock.

- **Modules under test:** the worker core stall/escalation path, the finish + hard-exit path, the durable stall counter (survives suspension/rebuild/restart), and the error classifier's extraction-stall-vs-connection split (pure-function test).

- **Behaviors to cover:** (1) a fake session streaming output steadily past 60s (via partial events) is NOT aborted; (2) a fake session silent >60s after some output IS aborted, detected in the 60–70s band; (3) `api_error` events do not count as liveness; (4) durable stall escalation: 1st stall → resume retry, 2nd → fresh-session construction (assert resume-vs-fresh on the fake), 3rd → turn marked failed/skipped — with the counter persisted across a simulated suspension and a simulated worker restart; (5) a connection-class error still retries unboundedly with no strike, and stall attempts do NOT collide with deterministic delivery attempts; (6) the diary's own `stall-watchdog` handling is unchanged after the classifier split; (7) all-content-sessions-closed arms the hard-exit timer and the worker exits within the ~70s cap even when a fake flush hangs, with the in-flight turn requeued and no strike; (8) merged-batch stall ownership (one flush, several turns) attributes the stall correctly.

## Out of Scope

- **The shared-deadline parallel shutdown drain coordinator** (owner-deferred to a follow-up spec): a coordinator that drains all sessions' leftover queues concurrently under one shared deadline, a shutdown admission barrier rejecting new `/wake`/`/trigger`/`/flush`/`/compact` mid-window, and a guaranteed resume-on-next-start queue rescan. This spec's shutdown scope is ONLY the hard-exit-within-~70s guarantee; it does not guarantee the leftover turn is drained before exit — an unfinished turn is orphaned until a later flush re-scans (accepted degradation, same as the per-session-env design).
- Bounding or compacting the extraction agent's transcript growth to reduce per-resume cache cost. A real independent lever (even a legitimate fresh start pays to prime context) but a separate change; this spec only stops the *pathological* re-creation loops.
- Changing the cache TTL / keepalive strategy.
- The dream/diary runtime's own shutdown, retry, and `stall-watchdog` handling — explicitly preserved unchanged; the extraction-specific stall class exists precisely so the diary is not touched.
- Any change to how `powerline` or other tools attribute cost.
- The 30-minute HTTP-idle exit path remains as a backstop.

## Further Notes

- Root-cause chain, confirmed this session: watchdog false-positive (0.6.2 regression `9c50359`) → stall abort misclassified as connection → unbounded resume retry → Claude Code resume cannot reuse the prior process's prompt cache (owner-confirmed) → each iteration cold-recreates the ~200-500K-token transcript prefix. Independently corroborated by Codex (verdict: refined the "flat 30s cap" framing to "30s-to-first-progress gate", confirmed the `9c50359` regression, flagged the design gap that first-progress disables the watchdog for the rest of the turn — folded into decision "keep watching after first output").
- The `forceFresh` escalation is also the cheaper path on its own: a fresh session cold-starts from the bounded SessionStart re-prime (recent-turn index), not the full accumulated transcript, so escalating to fresh early both breaks the loop and lowers per-turn cost.
- Codex review (2026-07-20, session 019f7b16) corrected three original assumptions, all folded in above: (a) the existing in-memory `BatchEntry.attempts` cannot be reused for stalls (it resets on suspension and counts a different failure), so the stall counter is durable and separate; (b) `stall-watchdog` is shared with the diary agent, so extraction uses its own stall class rather than a global reclassification; (c) the worker already exits proactively, so shutdown scope collapsed to a hard-exit backstop timer. The shared-deadline parallel drain coordinator and its admission/resume guarantees were deferred by the owner to a follow-up spec.
