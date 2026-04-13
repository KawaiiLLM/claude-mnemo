# Stop Handler Backfill Wiring

**Goal:** Wire `backfillFromTranscript` into the stop handler so that every turn accumulates `transcript_line_start` from the JSONL transcript. As a side effect, eliminate per-orphan `extractAssistantResponse` calls that redundantly re-parse the entire transcript.

---

## Context — why this spec exists

`2026-04-11-compact-turn-and-line-anchors.md` D2 says:

> Population path: the existing `backfill.ts` flow. `updateTurnBackfill` accepts `transcriptLineStart` and writes it.

All infrastructure is in place:

| Layer | Status | Location |
|---|---|---|
| Schema column `transcript_line_start` | Exists | `src/db/schema.ts` |
| `ParsedReplayTurn.transcriptLineStart` | Populated by parser | `src/shared/transcript-parser.ts:504` |
| `backfillFromTranscript` | Defined & tested | `src/hooks/backfill.ts:9` |
| `updateTurnBackfill` accepts the field | Yes | `src/db/turns.ts:248` |
| Timeline/recall renders `L<n>` | Yes | `src/mcp/timeline.ts:942`, `src/mcp/format.ts:466` |

**But `backfillFromTranscript` is never called by any handler.** The stop handler (`src/hooks/handlers/stop.ts`) does its own orphan-turn processing (lines 122–149) using `extractAssistantResponse`, which:

1. Parses the entire JSONL once per orphan turn via `parseTranscript` (not `parseReplayTranscript`)
2. Only extracts `assistantText` — never touches `transcriptLineStart`
3. Doesn't write `tool_call_count` or `content_prompt_id`

Result: `transcript_line_start` is NULL for every non-compact turn in the database. Timeline's `line` column shows `—` universally.

---

## Locked decisions

| # | Decision |
|---|---|
| **D1** | **Parse once, backfill all.** Replace the per-orphan `extractAssistantResponse` loop (stop.ts:122–149) with a single `backfillFromTranscript` call that processes all pending turns (orphans + current) in one pass. The `parseReplayTranscript` inside backfill runs once and populates `assistantResponse`, `toolCallCount`, `contentPromptId`, and `transcriptLineStart` for every matched turn. |
| **D2** | **Current turn gets backfill too.** The current turn (from `getLatestTurn`) also needs `transcriptLineStart`. Today's stop handler only writes `assistantResponse` for it (line 151–160). After D1, `backfillFromTranscript` handles all turns uniformly, then the stop handler applies the `lastAssistantMessage` override for the current turn (which is more authoritative than the transcript parse, since it comes directly from the CC hook payload). |
| **D3** | **Preserve `updated_at_epoch` and `turn-stop` enqueue.** `backfillFromTranscript` → `updateTurnBackfill` doesn't set `updated_at_epoch` or enqueue `turn-stop` tasks. The stop handler must still do these after backfill. The orphan loop and current-turn update remain for these two side effects, but no longer need to compute `assistantResponse` themselves. |
| **D4** | **`backfillFromTranscript` needs all session turns, not just orphans.** Current `getOrphanTurns` returns a narrow projection `{ id, promptNumber, userPrompt }`. `backfillFromTranscript` takes `TurnRecord[]`. Use an existing query like `getTurnsForSession` to get all turns, then let backfill's internal `pendingTurn.assistantResponse` guard skip already-populated ones. |
| **D5** | **`lastAssistantMessage` takes precedence.** For the current (latest) turn, the hook payload's `lastAssistantMessage` is more authoritative than what the transcript parser extracts (transcript may be incomplete at stop time if writes are buffered). After `backfillFromTranscript` runs, the stop handler overwrites the current turn's `assistant_response` with `lastAssistantMessage` if present — same as today's line 151–160. |
| **D6** | **Remove `extractAssistantResponse` import.** After D1, stop handler no longer calls it. Remove the import to prevent dead-code drift. `extractAssistantResponse` remains in `transcript-parser.ts` for any other callers (grep confirms no other `src/` callers, but the function is exported and may be used externally). |

---

## Non-goals

- **Changing `backfillFromTranscript` internals.** The function works correctly as-is. We're just calling it.
- **Adding `updated_at_epoch` or enqueue logic to `updateTurnBackfill`.** Backfill is a data-population concern; lifecycle management (`updated_at_epoch`, `turn-stop` queue) stays in the stop handler.
- **Backfilling from other hooks.** Only the stop handler is in scope. PostCompact already writes `transcript_line_start` directly via its `INSERT` statement.
- **Removing `extractAssistantResponse` from `transcript-parser.ts`.** Other external consumers may exist.

---

## Implementation

### Task 1: Wire backfill into stop handler

**Files:**
- Modify: `src/hooks/handlers/stop.ts`
- Modify: `tests/hooks/stop.test.ts`

**Changes to `stop.ts`:**

1. Replace import: `extractAssistantResponse` → `backfillFromTranscript` from `../../hooks/backfill`
2. Add import: `getTurnsForSession` from `../../db/turns`
3. Inside the transaction, before the orphan loop:
   ```
   // Parse transcript once, populate assistantResponse + transcriptLineStart for all turns
   if (input.transcriptPath) {
     const allTurns = getTurnsForSession(dependencies.db, session.id);
     backfillFromTranscript(dependencies.db, allTurns, input.transcriptPath, input.lastAssistantMessage);
   }
   ```
4. Simplify the orphan loop: remove the `extractAssistantResponse` call and the per-orphan `UPDATE turns SET assistant_response` query. Keep only the `updated_at_epoch` update and `enqueueQueueItem` call.
5. For the current turn: keep the `UPDATE turns SET assistant_response = COALESCE(?, ...)` for `lastAssistantMessage` override (D5), but add `transcript_line_start` backfill awareness — actually, `backfillFromTranscript` already handled it, so just keep the `lastAssistantMessage` override as-is.

**Resulting stop handler flow:**

```
1. Get session, latest turn, orphan turns
2. Transaction:
   a. backfillFromTranscript(db, allTurns, transcriptPath, lastAssistantMessage)
      → populates assistantResponse, toolCallCount, contentPromptId, transcriptLineStart
   b. For each orphan: UPDATE updated_at_epoch, enqueue turn-stop
   c. For current turn: UPDATE assistant_response = COALESCE(lastAssistantMessage, ...), updated_at_epoch
   d. Enqueue turn-stop for current turn if not already queued
3. upsertSession (completedAtEpoch)
4. detectAndCleanSidechainTurns
```

**Key concern:** `backfillFromTranscript` skips turns where `assistantResponse` is already truthy (`pendingTurn.assistantResponse` check at backfill.ts:28). This means it won't re-backfill turns from prior stop calls. That's correct — we only want to populate newly pending turns. But it also means turns already stopped in a prior stop call won't get `transcriptLineStart` retroactively. This is acceptable: those turns were created before this fix; going forward, every turn gets backfilled on its first stop.

**Tests:**

Add to `tests/hooks/stop.test.ts`:

```
test("stop handler populates transcriptLineStart for the current turn", ...)
test("stop handler populates transcriptLineStart for orphan turns", ...)
```

Seed a session with 1-2 turns, write a JSONL transcript with known line numbers, invoke the stop handler, assert `transcriptLineStart` is non-null and matches expected line numbers.

### Task 2: Verify

- `bun test` — all pass
- Check a real session's turns after stop: `transcript_line_start` should be populated
- Timeline `line` column should show `L<n>` instead of `—`

---

## Test cases

| # | Case | Assert |
|---|---|---|
| 1 | Stop with transcript → current turn | `transcriptLineStart` matches JSONL line of the user prompt |
| 2 | Stop with transcript → orphan turns | Each orphan's `transcriptLineStart` is populated |
| 3 | Stop without transcript | `transcriptLineStart` remains NULL (no crash) |
| 4 | Stop with `lastAssistantMessage` | Current turn's `assistantResponse` = `lastAssistantMessage` (not transcript parse), but `transcriptLineStart` still populated |
| 5 | Idempotent: second stop on same turn | `transcriptLineStart` unchanged (COALESCE in updateTurnBackfill preserves first value) |
