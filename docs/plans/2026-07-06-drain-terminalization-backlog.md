# 0.2.40 — Backlog reconciliation for never-reopened sessions

**Goal:** clear the ~40 turns stuck in non-terminal status, and stop new residue accumulating — without breaking the existing retry / drop / floor terminalization.

**Root cause:** recovery of stranded turns already exists, but every path is triggered by the session being reopened or continued. A session that is simply abandoned never fires either handler, so its non-terminal backlog sits forever.

**Scope:** worker startup + drain path (`src/worker/server.ts`), stranded recovery (`src/db/recover-stranded.ts`, `src/db/turns.ts`), one gated DB reconcile. NOT the role-tag scoring channel (T546) — separate 0.2.40 candidate.

> **Correction vs. the first draft of this plan:** an earlier version claimed A2 turns (response written, un-extracted) are *not* recovered by resuming their own session, and proposed a new Stop-time hook to fix it. That is wrong — the `context` SessionStart handler already recovers same-session stranded turns on resume/compact (`context.ts:240`). The real gap is narrower: sessions that are never reopened.

---

## Problem: recovery is real, but reopen-gated

The exit path is weak on its own. `SessionEnd → notifyWorkerFlush → POST /flush → core.flushSession` (`server.ts:2100/2292`) runs a single pass (`server.ts:1707`), and the `/flush` route is fire-and-forget — `void handleFlushImpl(...); return 200` (`server.ts:2179`). The exhaustive `drainSessionCompletely` loop (`server.ts:1651`) runs only from `/compact` (`server.ts:1831`). So an imperfect exit routinely leaves a turn `active`.

But three recovery mechanisms already exist to mop that up on the next interaction:

- **SessionStart recovers A2.** The `context` handler, on `source === "resume" || "compact"`, calls `recoverStrandedTurns(db, currentSession.id, …)` (`context.ts:240`). `getStrandedTurns` selects `assistant_response IS NOT NULL` + status `active`/`provisional` + legacy half-`extracted`, and re-enqueues each after `resetTurnExtractionFields` (`turns.ts:332`). A test pins this: a resume with a stranded `active` turn that has a response enqueues a `turn-stop` (`context.test.ts:986`).
- **Stop recovers A1 + fork ancestors.** The Stop handler re-enqueues this session's `active` turns with `assistant_response IS NULL` (`getOrphanTurns`, `stop.ts:144`) and walks `parentSessionId` upward for forked lineages (`recoverStrandedAncestors`, `recover-stranded.ts:45` — it seeds `visited` with the current session, so it does *not* re-cover self; that is SessionStart's job).
- **Delivery + derailment already terminalize.** A failed batch retries (`retryLater`, keeps batch + claims at head) until `maxFlushAttempts`, then `dropped` applies side effects + `flagDeliveryDropped` (`server.ts:1314`). Extractor derailment routes through `applyFloor` to `extracted`/`failed`.

**The gap:** every one of these fires only when the session is reopened (`resume`/`compact`) or continued (a new `Stop`), or when the worker restarts (`resetClaimedQueueItems`). A session nobody touches again — the old April sessions — never triggers any of them, so its stranded turns are stuck not because recovery is missing but because nothing wakes it.

## Taxonomy: who recovers each, and why the stuck ones are stuck

The ~40 stuck turns, by which existing handler *would* recover them if the session were touched. Turn-id ordering is a non-factor in every claim path: `claimNextItem` is `seq ASC`, `getOrphanTurns` filters `id < currentTurn`, `getStrandedTurns` has no id filter.

| Bucket | State | ~count | Recovered by (on reopen) | Why still stuck |
|---|---|---|---|---|
| **A1** | no queue row, `assistant_response IS NULL` | ~9 | Stop `getOrphanTurns`, on next turn | session not continued |
| **A2** | no queue row, `assistant_response` present | ~21 | **SessionStart `recoverStrandedTurns`, on resume/compact** | session not reopened |
| **B** | has queue row, but `claimed` | ~9 | worker restart (`resetClaimedQueueItems`) then re-drain | between restarts; then re-fails on unprocessable obs |

All three self-heal the moment the session is reopened or continued. The residue is exactly the **never-reopened** sessions (A2's April sessions) plus **genuinely unprocessable** items (B's dead obs backlog behind 8333's image turns). Fixes therefore split into a session-independent wake (reach the never-reopened) and correct terminalization of the unprocessable (without touching retry/drop/floor).

## Fixes

**1. Session-independent recovery sweep (the real fix), run as a startup orchestrator.** Reach sessions no reopen will wake, and recover each stranded turn by what it already carries — crucially, **never destroy a partial extraction**. `recoverStrandedTurns` calls `resetTurnExtractionFields`, which wipes `title/content/insight/type` (`turns.ts:303`); that is safe only for a turn with nothing extracted yet. A `provisional` turn a mid-slice already partially wrote must instead be floor-finalized exactly as `applyFloor` does — keep the partial, mark `extracted` (`server.ts:1084`; pinned by `server.test.ts:2864`). Do not run `recoverStrandedTurns` blindly over `getStrandedTurns`, which selects every `provisional` regardless of existing content (`turns.ts:332`). Classify each stranded turn instead:

| Turn state | Action | Owner |
|---|---|---|
| has partial `title` or `content` (any status) | floor-finalize → `extracted`, keep the partial — **never reset** | fix 1 |
| `assistant_response` present, no partial content | `recoverStrandedTurns` (reset safe here) → re-extract → extractor/floor decides | fix 1 |
| `assistant_response IS NULL`, transcript backfillable | backfill response from transcript → enqueue → re-extract | fix 3 |
| `assistant_response IS NULL`, no/unreadable transcript, idle | `skipped` | fix 3 |

Rows 1–2 are the sweep; rows 3–4 are the idle reconcile (fix 3). An unprocessable row-2 turn (8333's images) fails only *after* a real extraction attempt, never by blind reconcile.

Do not add a sweep that races the existing startup scan. `main` already fires the `startupFlushSessionId` flush then `scanAndDrainQueue()` (`server.ts:2329`); a parallel per-session `drainSessionCompletely` would contend on the same `pending_queue` and pollute its `remaining >= previousCount` no-progress test (`server.ts:1690`). Instead, after the sync `recoverFromCrash()` (`server.ts:2280`), launch **one** background pipeline that runs sequentially: `startupFlushSessionId` flush → `backlogSweep` (the A2 recovery above) → global `scanAndDrainQueue()`. Spec whether the per-session sweep replaces the global scan for swept sessions or only covers no-queue-row stranded sessions. `recoverFromCrash` stays `void`/sync.

**2. Do NOT terminalize on generic no-progress.** The `drainSessionCompletely` no-progress branch is only `remaining >= previousCount` — a transient queue-count stall that also occurs while a batch is legitimately in `retryLater` (`server.ts:1690`). Terminalizing there would kill turns mid-retry and break the pinned semantics (`server.flush-retry.test.ts:107`: first failure keeps the queue, second drain burns one attempt, no drop before `maxFlushAttempts`). Instead, diagnose the stall and route by cause: delivery `retryLater` → let `maxFlushAttempts`/`dropped` own it; extractor derailment → let `applyFloor` own `extracted`/`failed`; **only items confirmed unprocessable this pass** (a `turn-stop` whose turn is already terminal, or dead `obs` cruft) get cleaned — see fixes 3–4.

**3. Idle reconcile for what the sweep cannot recover (DB write — needs authorization).** Runs strictly *after* the sweep, over rows 3–4 of the table only. It must **exclude every `assistant_response IS NOT NULL` turn** (the sweep's) and every turn with partial `title`/`content` — failing one here would destroy pending or partial extraction (the data-loss boundary). For A1 (`assistant_response IS NULL`), do **not** assume "no response = nothing to extract": the response may simply never have been written to the DB while the transcript still holds it — exactly what Stop's `backfillFromTranscript` recovers (`stop.ts:146`; `stop.test.ts:291` pins a no-response turn getting `"First answer"` from its transcript). So first attempt a transcript backfill via `resolveTranscriptPath(session.project, session.content_session_id)` (`paths.ts:23`; the session row carries both fields but not the path, `schema.ts:19`) and re-enqueue if it yields assistant text. Only then terminalize. Case table:

- `active` + `assistant_response IS NULL` + no partial content + transcript missing/unparseable/no assistant text + idle past threshold → `skipped`
- any turn with partial `title`/`content`, or `provisional` → floor semantics (partial → `extracted`, none → `failed`), never blanket `skipped` — owned by fix 1
- `assistant_response IS NOT NULL` → excluded from reconcile; the sweep owns it

Gate on idle/age throughout so in-flight (11387) and reopenable sessions are excluded. Scope shrinks to the A1 residue that has no backfillable transcript; **no A2, no partial-content turns**.

**4. Dead-obs GC (correct join).** 627 `kind='obs'` rows remain for terminal turns, inflating `countQueueItemsForSession` (8333's 380) and driving its no-progress churn. Note `obs.target_id` is an **observation id**, not a turn id — it is passed to `getObservation` (`server.ts:1600`) and deleted per observation queue item (`processors.ts:716`). GC via the explicit join: `pending_queue q JOIN observations o ON q.kind='obs' AND q.target_id = o.id JOIN turns t ON o.turn_id = t.id WHERE t.status IN ('extracted','skipped','failed','undone')`. `undone` is terminal too — `processTurnStopLocked` deletes an undone turn's queue item and returns (`server.ts:1515`). Do not write `q.target_id = turns.id`.

**5. Consistency invariant (prevents regression).** Add a periodic reconcile / test assertion that no turn sits in a **non-terminal** status (`active`/`provisional`) with no queue row unless its session is live and within an in-flight window. Covers both statuses, not just `active`; makes fixes 3–4 one-time rather than recurring maintenance.

**6. (Demoted) Stop-time same-session recovery — redundant.** Calling `recoverStrandedTurns(db, session.id, …)` from the Stop handler would recover A2 one wake earlier, but SessionStart resume/compact already covers it. Keep only as an optional wake-coupling optimization (recover on continuation, not just on reopen); it is not a primary fix and does not change reconcile scope.

## Verification

- **Retry semantics unbroken:** `server.flush-retry.test.ts` stays green — no terminalization added to the no-progress branch (fix 2).
- **Sweep reaches never-reopened:** seed a stranded A2 (`assistant_response` present, no queue row, `active`) in an idle session, start the worker, assert the sweep re-enqueues and extracts it **without** a `resume`/`compact` SessionStart and without hand-editing the row (fix 1).
- **A2 never destructively reconciled (fix 1 before fix 3):** an idle A2 (`assistant_response` present, no queue row) must not enter the reconcile UPDATE before the sweep runs; after the sweep extracts it, the reconcile selection set is empty. This is the data-loss boundary — the reconcile query must match zero `assistant_response IS NOT NULL` rows.
- **Partial extraction preserved:** a stranded `provisional` turn that already has `title`/`content` is floor-finalized to `extracted` keeping its partial, and is **never** `resetTurnExtractionFields`'d by the sweep (fix 1, `server.test.ts:2864`).
- **A1 with a readable transcript is backfilled, not skipped:** an idle A1 (`assistant_response` NULL) whose transcript holds an assistant answer is excluded from the destructive reconcile (selection = 0) and instead backfilled + enqueued (fix 3, `stop.ts:146`).
- **Obs GC join:** GC deletes only `obs` rows whose parent turn (via `observations.turn_id`) is terminal; a live turn's obs rows survive (fix 4).
- **HTTP exit path, not just core:** a fetch-handler test — `POST /flush` returns `200` immediately, then poll the background drain's final state — kept separate from the core `drainSessionCompletely` unit test (fixes 2/6, finding on `server.ts:2179`).
- **Post-deploy:** global non-terminal count trends to ≈ live in-flight only; `drainSessionCompletely: no progress` stops repeating for the same session id.

## Out of scope

Role-tag scoring channel (T546) — separate 0.2.40 track, unrelated to the backlog fix.
