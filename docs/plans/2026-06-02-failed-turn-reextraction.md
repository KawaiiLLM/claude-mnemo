# Failed-Turn Re-Extraction on Resume — Design

**Goal:** Give the extraction pipeline a reliable, self-healing signal for "this turn was supposed to be extracted but isn't," and re-extract those turns when their session is resumed.

**Architecture:** Replace the overloaded `status` flag (which today conflates deliberate skips, mid-slice work, give-ups, and phantom successes) with a precise turn state machine, gate `extracted` on real content, and add a resume-time scan that re-enqueues every still-unextracted turn of the resuming session in `prompt_number` order.

**Scope (this spec):** Within-session recovery — the resuming session scans *itself*. This covers same-session-id resume and in-place compaction.

**Out of scope (deferred to a separate lineage sub-project):** Cross-fork recovery (a parent session's stranded tail when work continues in a `--fork-session` child), `parent_session_id` / turn-DAG lineage, and read-model stitching across forked sessions. See [Deferred work](#deferred-work).

---

## Motivation

Inspecting a real, long, derailed session (S4589, game-demo, 210 turns) and the whole database revealed that "extraction failed" is not one state — it is three, and the current `status` flag cannot tell them apart.

| Failure mode | DB signature today | Count (S4589 / DB-wide) | Cause |
|---|---|---|---|
| Never extracted | `status='active'` | 2 / 34 | Worker stopped before draining the tail; queue item dropped |
| Marked skipped | `status='skipped'`, no title | 57 / 852 | Derailment/give-up casualties **mixed with** legitimate skips — indistinguishable |
| Phantom extraction | `status='extracted'`, title/content NULL but `assistant_response` present | 30 / 83 | Promoted to "extracted" without content ever being written |

Two structural problems follow:

1. **`status` is not a reliable "did we extract?" signal.** A scan over `active` alone misses all 83 phantom-extracted turns (their status says *done*) and cannot separate skip-casualties from real skips. The reliable signal is *content presence* (`title`/`content` NULL while `assistant_response` is present), not the flag.
2. **The 0.2.22 derailment floor collapses "deliberately skipped" and "gave up" into the same `skipped`** (`applyFloor`, `src/worker/server.ts:1032`), destroying the signal needed to ever recover the casualties.

**Scope note on legacy `skipped` casualties.** This spec does **not** auto-recover the existing `skipped`/no-title casualties (the 57/852) — they are indistinguishable from legitimate skips in current data, so any blanket re-extraction would also clobber genuine skips. The fix here is forward-only: from now on, give-ups become `failed` (Component 4), not `skipped`, so the casualty/skip signal is never destroyed again. Reclaiming the *existing* casualties would need a separate manual/heuristic backfill (e.g. prompt-length thresholds) and is out of scope. The auto-recovered classes are strictly `active` / `provisional` / phantom-`extracted` (Component 5).

Turns left unextracted are **never automatically retried**: a turn row is never re-enqueued; only outstanding `pending_queue` items are re-processed on reboot (`recoverFromCrash` → `resetClaimedQueueItems`). Once a turn's queue item is gone (dropped after `maxFlushAttempts`, or pruned after a floor), an `active`/phantom turn is stranded permanently.

The recovered turns are worth the work: S4589's stranded tail is `T209 "KAPPA 是什么参数"` and `T210 "为什么是 1 − e^(−0.15)"` — short *why* questions whose rationale is exactly what mnemo exists to keep, and both are re-extractable (each has an 838/850-char `assistant_response` and a `content_prompt_id`).

---

## Component 1 — Turn state machine

Extend `TurnStatus` (`src/db/turns.ts:5`) from four values to six.

| status | Meaning | Written by | Re-extraction target |
|---|---|---|---|
| `active` | Created; extractor has not processed it | `createPendingTurn` (`session-init.ts:15`) | **yes** |
| `provisional` | Extractor is processing the turn as mini-turn slices; not yet finalized | worker, at first streaming-slice delivery | **yes** |
| `extracted` | Finalized **and** `title`/`content` are non-null | completion point (gated) | no |
| `skipped` | Extractor deliberately decided the turn warrants no record (trivial prompt), at the turn level | completion point | no |
| `failed` | Terminal give-up: derailment floor reached with no usable content (content-less `active`/`provisional` turn) | `applyFloor` (derailment floor) | no (terminal — never re-scanned) |
| `undone` | Rolled back | `invalidation` | no |

**Transitions:**

- create → `active`
- extractor delivers the **first streaming slice** → `active` → `provisional` (a short / single-shot turn never enters `provisional` — see Component 3)
- completion point, content written → `provisional`|`active` → `extracted`
- completion point, deliberate turn-level skip → `provisional`|`active` → `skipped`
- derailment floor (terminal, content-keyed): an unresolved turn with partial content (`title`/`content` — including a `provisional` turn that streamed slices before derailing) → `extracted` (keeps the partial); a content-less `active`/`provisional` turn → `failed`. (The drop path stays `active` and is recovered — see Component 4.)
- worker stops before completion → stays `provisional` (re-scanned on resume)
- rollback → any → `undone`

`provisional` is a new value only — `status` is `TEXT`, so no schema migration is required; existing rows keep their values.

## Component 2 — `extracted` requires substantive content (phantom prevention)

A turn may become `extracted` only if it has a non-null `title` **or** `content`. The gate **prevents** phantom extraction — it does **not** relabel anything `failed`. `failed` comes solely from the derailment floor (Component 4). There are exactly two write paths to harden:

1. **`deriveTurnStatus` (`src/mcp/remember.ts:115`–`138`)** — the live phantom source. It currently returns `extracted` when *any* of `title|content|insight|type|tags` is set, so `remember({ id:"T5", type:"bugfix" })` with no title/content yields `extracted` with both null. Tighten the predicate to require `title || content`; `type`/`tags`/`insight` alone → `skipped` (nothing substantive was extracted). A content-less `remember` thus becomes `skipped`, never a phantom.
2. **`updateTurnById` auto-promote (`src/db/turns.ts:173`)** — `nextStatus = input.status ?? (existing.status === "active" ? "extracted" : existing.status)`. Harden so the `active → extracted` auto-promote fires only when `title || content` is present after the merge; otherwise the turn stays `active`. Every current metadata-only caller already dodges this by passing `status: turn.status` explicitly (`src/worker/processors.ts:632`, `src/worker/invalidation.ts:361`/`388`/`482`, with comments naming the "auto-promote trap"), so this is defense-in-depth that closes the trap permanently for future callers.

The agent cannot force the issue from the other side: `status:"extracted"` is not in `TURN_REMEMBER_STATUSES` (`["skipped","undone","active"]`, `src/mcp/remember.ts:24`), so an explicit content-less `extracted` is impossible. `status:"skipped"`/`"undone"` are honored as-is (a deliberate skip is content-less by design).

Net effect: no new turn can reach `extracted` without `title`/`content`. The **83 legacy phantom rows** (`extracted` + both null, created before the metadata-caller guards existed) are reclaimed lazily by the recovery scan (Component 5) — not by a global migration.

**Rejected alternative:** a background job that rewrites all phantom rows. Out of scope — the user chose lazy, on-revisit cleanup; a global sweep was explicitly declined.

## Component 3 — `provisional` for slices

A turn under slice processing (`large-turn-slicing`, `docs/plans/2026-05-29-large-turn-slicing.md`) becomes `provisional` and stays there until a completion point resolves it.

**Write timing — only at genuine streaming-slice delivery, never "when extraction begins."** The worker sets `provisional` when it delivers a streaming slice (`enqueueAndFlushStreamingSliceLocked`), replacing today's auto-promotion of a sliced turn to `extracted` after its first slice's `remember(T)`. A mid-slice `remember(T)` writes content but the worker **holds** the status at `provisional`; only the completion point promotes it. This precision matters because of the existing role detector.

**Interaction with `hadPriorDelivery` (`src/worker/server.ts:1433`).** Role detection (`final` vs `short`) keys on `state.streamedParts.has(turn.id) || turn.status !== "active" || hasSkippedObservationsForTurn(...)`. `provisional` is *consistent* with the `status !== "active"` proxy: a `provisional` turn has by definition already streamed a slice, so `final` is correct. The danger is the reverse — marking a turn `provisional` *before* role detection would make a short turn read `!== "active"` and be misclassified `final`. Restricting the write to slice delivery prevents this: a short/single-shot turn is still `active` when its `turn-stop` is processed, so it is correctly built as `short` and finalizes `active → extracted/skipped/failed` without ever passing through `provisional`.

**Explicit finalizer.** The completion point resolves `provisional` (or `active`, for short turns) to a terminal status: a `remember` with content → `extracted` (Component 2 gate); a deliberate skip or content-less `remember` → `skipped` (`deriveTurnStatus`); **no** valid `remember` at all (derailment) → the floor escalates and, unrecovered, stamps `failed`. There is no path that silently leaves a *completed* turn `provisional`.

**Skip semantics.** Skipping one mini-turn slice is **not** a turn-level skip — the turn stays `provisional`, not `skipped`. Only the finalizer, on a deliberate whole-turn decision, yields `skipped`. This keeps `skipped` a clean "deliberate, content-less by design" signal.

A turn left in `provisional` because the worker stopped mid-slice never reached the finalizer, so it is genuinely unfinished and is a re-extraction target (Component 5).

## Component 4 — `failed` for the derailment floor

The derailment floor is the genuinely terminal give-up. `applyFloor` (`src/worker/server.ts:1032`) finalizes each unresolved turn **by content** (not by status), so it terminates both never-extracted `active` turns and streamed-then-derailed `provisional` turns:

- A turn with `title || content` (a partial extraction — including a `provisional` turn whose mid-slices wrote content before the final derailed) → `extracted` (terminal, keeps the partial; consistent with the content gate).
- A content-less turn (`active`, or a `provisional` turn that produced nothing) → `failed` (terminal).

A `session-summary` floor still abandons with no turn touched. Keying on content rather than `status === "active"` is essential: without it, a `provisional` turn at the floor would fall through unchanged and `getStrandedTurns` would re-enqueue it on every resume — re-derailing forever and defeating the termination guarantee below.

`failed` is **terminal**: the recovery scan never re-enqueues it. This is the cross-resume termination guarantee — a turn that genuinely derails reaches the floor once and is closed, so it cannot re-derail the extractor on every resume. (`T209`/`T210`-style imperative prompts are exactly why: without a terminal state they would re-hijack the agent forever — though 0.2.22's `tools:[]` + `<source_prompt>` framing now makes re-extraction itself safe.)

**The drop path is deliberately *not* changed to `failed`.** A flush dropped after `maxFlushAttempts` (`src/worker/server.ts:1230`–`1246`) is a *delivery* failure, not a content-level give-up — it is plausibly transient. It keeps its current behavior: side effects applied, queue items removed, `flagDeliveryDropped` raised, turn left `active`/partial. That `active` status is exactly what the recovery scan re-enqueues on the next resume, so a dropped turn self-heals. Leaving it `active` also preserves the delivery-dropped reminder, whose `notExtracted` branch keys on `status === "active"` (`src/worker/invalidation.ts:142`) to emit the turn's prompt and the "not yet extracted" notice — setting `failed` there would silently downgrade that reminder to "record may be incomplete" and drop the prompt. Net: the floor is the only producer of `failed`; the drop path feeds recovery through `active`.

## Component 5 — Resume re-extraction scan

**Trigger:** the SessionStart hook handler (`createContextHandler`, `src/hooks/handlers/context.ts`). It already runs at session start/resume, has `db` access, and is `source`-aware. At resume, the worker is *not* mid-processing this session, so re-enqueuing prior turns cannot collide with live work — this is why SessionStart is chosen over the per-prompt `session-init` handler.

A new function `recoverStrandedTurns(db, sessionDbId)` runs when `input.source` is `resume` or `compact` (skipped for `startup`), for the resolved current session, as a **synchronous DB side effect** — the same shape as the existing `upsertSession` side effect inside `buildContextOutput` (`context.ts:191`).

**Worker wake — do not use `asyncWork`.** The hook runner is mutually exclusive: when a handler returns `asyncWork`, `runHookCommand` writes only `{"async":true}` and *skips* `writeHookResult` (`src/hooks/hook-command.ts:141`–`147`), so the SessionStart context injection would be lost. The scan therefore enqueues *synchronously* (fast SQLite inserts) and does **not** wake the worker itself. Recovered items drain on the **next natural worker wake** — whichever fires first among `PostToolUse` (on the first tool call, `src/hooks/handlers/post-tool-use.ts:113`) and `Stop` (`src/hooks/handlers/stop.ts:204`), both of which call `notifyWorkerWake`. The exact wake does not matter: `scanAndDrainQueue` claims FIFO by `seq` (`src/worker/server.ts:1476`), and because the recovered `turn-stop` items are enqueued first they hold lower `seq` than the resumed session's new turn — so they are always drained ahead of it, in `prompt_number` order. Recovery is a background catch-up, not latency-sensitive, so deferring the drain to the first post-resume wake is acceptable and avoids any change to the hook protocol.

**Detection condition** (single indexed query over `idx_turns_status`):

```sql
SELECT id, prompt_number FROM turns
WHERE session_id = ?
  AND assistant_response IS NOT NULL          -- only turns that CAN be re-extracted
  AND ( status IN ('active','provisional')
        OR (status = 'extracted' AND title IS NULL AND content IS NULL) )  -- legacy phantom
ORDER BY prompt_number ASC
```

The phantom predicate is `title IS NULL AND content IS NULL` (**both** null), matching the Component 2 gate (`extracted` requires `title || content`): a turn with a title but no content is a valid minimal extraction, not a phantom, and must not be re-extracted.

`assistant_response IS NOT NULL` is mandatory: a turn with no captured response (created but never completed) has nothing to extract, and the renderer would emit an empty response (`src/worker/processors.ts:556`). Without the filter, such a turn would be re-enqueued, fail to produce content, and churn toward `failed` on every resume. It matches the reliable signal from [Motivation](#motivation) (response present, title/content absent). These turns are left inert (`active`, never enqueued); the cheap indexed scan simply skips them each resume.

**Action, per matched turn (in `prompt_number` order):**

1. Reset to a genuinely un-started state via a **new dedicated helper `resetTurnExtractionFields(db, turnId)`** — a direct `UPDATE` that sets `status='active'` and **nulls the agent-authored extraction output** (`title`, `content`, `insight`, `type` → `NULL`). This *cannot* be done through `updateTurnById`: its fields are merged with `?? existing` (`src/db/turns.ts:243`), so passing `null` keeps the old value — hence a purpose-built reset. A status-only reset would let a `provisional` turn's stale slice-produced `title`/`content` pollute re-extraction (or linger after a later skip). **Tags are filtered, not wiped:** `turns.tags` mixes the agent's freeform (hyphenated) topic tags with internal **colon-namespaced reminder tags** (`reason:sub:kind` — e.g. `delivery:dropped:*`, interrupt/rollback markers; `src/worker/invalidation.ts:19`). The reset strips only the freeform tags and **preserves the colon-namespaced internal tags**, because they track a notification lifecycle orthogonal to extraction content that a re-extraction must not erase. The helper must also drop the stale FTS row (`DELETE FROM memory_fts WHERE layer='turn' AND source_id=?`, mirroring `src/db/turns.ts:264`). Kept: source material (`user_prompt`, `assistant_response`), identity/anchors (`content_prompt_id`, `transcript_line_start`), re-derivable mechanical metadata (`files_*`, `tool_call_count`), and internal reminder tags.
2. Enqueue a `turn-stop` `pending_queue` item (`enqueueQueueItem`, `src/db/pending-queue.ts:47`). The extractor reads the turn's `user_prompt`/`assistant_response` from the DB, so re-extraction works even when the original observations are gone (re-attached observations are best-effort). With status back at `active` and slice fields cleared, the re-extraction is treated as a fresh `short`/`merged` turn (not a slice continuation).

**Ordering:** ascending `prompt_number` insertion means FIFO `seq` order matches conversation order, so re-extraction (and any resulting session-summary refresh) advances along the real timeline — the skew the user flagged cannot occur.

**Exclusions / safety:**

- Never touches `failed` (terminal), `skipped`, `undone`, or `extracted`-with-content.
- Dedup against existing `pending_queue` rows for the turn, so a turn that still has a live queue item is not double-enqueued.
- The current in-flight turn does not exist yet at SessionStart (the new prompt has not been submitted), so the scan only ever targets prior turns.

**Termination:** `active`/`provisional` turns that were merely interrupted retry until they succeed (or the user stops resuming); turns that truly derail hit the floor → `failed` → terminal. The within-session floor bounds the per-attempt work; `failed` bounds the cross-resume retries.

---

## Data flow

```
resume session
  → SessionStart hook (context.ts)  [returns context output AS USUAL]
      → recoverStrandedTurns(db, sessionDbId)   [synchronous side effect, no asyncWork]
          → scan (assistant_response present AND (active|provisional|extracted-empty)), prompt_number ASC
          → reset matched → active
          → enqueue turn-stop per match (deduped)   [low seq → ahead of the new turn]
  → next natural wake: PostToolUse (first tool call, post-tool-use.ts:113) or Stop (stop.ts:204) → notifyWorkerWake
  → worker /wake → claimNextQueueItem (FIFO seq → recovered turns first, prompt_number order)
      → extractor processes turn (active → provisional → completion point)
          → content written → extracted
          → deliberate skip   → skipped
          → derail/floor      → failed (terminal)
```

## Error handling & edge cases

- **No transcript / fresh session:** scan finds nothing (no prior turns or all `extracted`-with-content) → no-op. Cost is one indexed `SELECT`.
- **Worker offline at resume:** items sit in `pending_queue`; the next `/wake` drains them (normal queue lifecycle).
- **Re-extraction derails again:** bounded by the 0.2.22 floor → `failed`; not re-scanned.
- **Observations already deleted:** re-extraction proceeds on `user_prompt` + `assistant_response`; obs re-attachment is best-effort, not required.
- **Turn with no captured response:** excluded by `assistant_response IS NOT NULL`; stays inert `active`, never enqueued (nothing to extract).
- **Double resume in quick succession:** dedup against `pending_queue` makes the scan idempotent.

## Testing strategy

- **`recoverStrandedTurns` unit tests:** seed a session with each status (`active`, `provisional`, `extracted`-empty, `extracted`-full, `skipped`, `failed`, `undone`); assert exactly the three target classes are reset + enqueued, in `prompt_number` order, and `failed`/`skipped`/`extracted`-full/`undone` are untouched. Assert dedup against a pre-existing queue row.
- **No-response exclusion:** an `active`/`provisional` turn with `assistant_response IS NULL` is **not** reset or enqueued.
- **Content gate (`deriveTurnStatus`):** `remember` with `title` or `content` → `extracted`; `remember` with only `type`/`tags`/`insight` (no title/content) → `skipped`, **not** `extracted` (no phantom); `remember({status:"skipped"})` → `skipped`.
- **Content gate (auto-promote):** a metadata-only `updateTurnById` (no `status`) on an `active` turn with no `title`/`content` keeps it `active`, not `extracted`.
- **`applyFloor` (content-keyed):** content-less `active` turn → `failed` (not `skipped`); partial-with-content turn → `extracted`; **a `provisional` turn at the floor is terminated, never left `provisional`** — with partial content → `extracted`, content-less → `failed` (regression guard for the cross-task gap); `session-summary` floor touches no turn.
- **Drop path:** a dropped batch leaves the turn `active`/partial (**not** `failed`) with `flagDeliveryDropped`; the delivery-dropped reminder still emits `prompt="…"` + "not yet extracted"; the resume scan re-enqueues the `active` turn.
- **`provisional` write timing:** a short / single-shot turn is **never** marked `provisional` before role detection, so `hadPriorDelivery` classifies it `short` (not `final`); a streamed turn reads `provisional` and classifies `final`.
- **`provisional` hold + finalizer:** a mid-slice `remember(T)` leaves the turn `provisional` (not `extracted`); the completion-point finalizer resolves it to `extracted`/`skipped`/`failed`.
- **Recovery clears partial fields, keeps internal tags:** recovering a `provisional` turn with partial `title`/`content` resets it to `active` with those fields nulled; agent freeform tags are stripped but colon-namespaced internal tags (e.g. `delivery:dropped:*`) survive the reset.
- **SessionStart wiring:** `source='resume'`/`'compact'` invokes the scan; `source='startup'` does not — **and in all cases the handler still returns its `additionalContext` output** (regression guard: the scan must not suppress context injection).
- **Drain ordering (integration):** after a resume enqueues recovered `turn-stop` items, a subsequent `PostToolUse` wake (not just `Stop`) drains the recovered items, and FIFO `seq` means they are processed before the current turn's `turn-stop`.

## File-touch map

- `src/mcp/remember.ts` — tighten `deriveTurnStatus` (`:115`): require `title || content` for `extracted`; `type`/`tags`/`insight` alone → `skipped`.
- `src/db/turns.ts` — extend `TurnStatus` (`:5`); guard the `updateTurnById` auto-promote (`:173`) so `active → extracted` needs `title || content` (else stays `active`); add a status-scan helper (`getStrandedTurns` or equivalent); add `resetTurnExtractionFields(db, turnId)` (direct `UPDATE` nulling `title`/`content`/`insight`/`type`, setting `status='active'`, **filtering `tags` to keep only colon-namespaced internal tags**, plus the `memory_fts` delete) — `updateTurnById`'s `?? existing` merge cannot null fields.
- `src/worker/server.ts` — `applyFloor` finalizes by content (`title||content` → `extracted`, else → `failed`), terminating both `active` and `provisional` turns (the **only** new `failed` producer; the drop path is unchanged); set `provisional` at streaming-slice delivery (`enqueueAndFlushStreamingSliceLocked`, replacing the slice auto-promote to `extracted`) and hold it across mid-slices; add the completion-point finalizer (`provisional`/`active` → `extracted` with the gate / `skipped` / `failed`); verify the `hadPriorDelivery` proxy (`:1433`) still classifies short turns correctly.
- `src/hooks/handlers/context.ts` — invoke `recoverStrandedTurns` on `resume`/`compact` as a synchronous side effect (alongside the existing `upsertSession` side effect); context output unchanged.
- New `recoverStrandedTurns(db, sessionDbId)` (location: a worker/recovery module or `src/db`), wired from the SessionStart handler.
- `src/db/pending-queue.ts` — reuse `enqueueQueueItem`; add a "queue item exists for turn" check for dedup if not already present.
- **Deliberately *not* touched:** `src/hooks/hook-command.ts` + `src/worker/client.ts` (synchronous-enqueue + drain-on-next-natural-wake avoids `asyncWork`, preserving context output — the failure mode at `hook-command.ts:141`); and `src/worker/invalidation.ts` (the drop path stays `active`, so the delivery-dropped `notExtracted` branch at `:142` still fires correctly — no reminder change needed).

## Deferred work

Cross-fork recovery is **not** in this spec. When a session is continued via `claude --resume <id> --fork-session`, Claude Code spawns a new session id; the parent's pre-compact tail strands and is never revisited under its own id. SessionStart provides only `session_id` (the new one), `source`, and `transcript_path` — **no parent/forked-from id** — so lineage must be reconstructed. The agreed direction (chosen but deferred) is the forward-breadcrumb model: store per-turn `parent_uuid` (CC `parentUuid`) plus a `uuid → session` map including `compact_boundary` uuids, so a child's first-turn `parent_uuid` resolves to its parent (e.g. S6106 → S4589 via `compact_boundary 80295d73`), letting recovery walk ancestors. That is a separate sub-project (it also unlocks read-model lineage stitching) and will get its own spec.
