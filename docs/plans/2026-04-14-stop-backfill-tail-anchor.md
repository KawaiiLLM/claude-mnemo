# Stop Backfill Tail Anchor

**Goal:** Replace the current per-turn heuristic prompt matching in the stop handler with a simpler transcript-tail anchoring rule that stops `content_prompt_id` drift and avoids `UNIQUE(session_id, content_prompt_id)` collisions.

---

## Context

Today `backfillFromTranscript()` tries to guess which replay turn belongs to each pending DB turn by:

1. matching `promptNumber`
2. then falling back to `userPrompt`

This is fragile for repeated prompts such as `测试`, `继续`, `改`, and it breaks badly when an older orphan turn is still missing `content_prompt_id`.

The concrete failure mode is:

- an older DB turn has `content_prompt_id = NULL`
- a different earlier DB turn already owns a prompt with the same `userPrompt`
- stop backfill matches the orphan to the old prompt text first
- the handler tries to write an already-used `content_prompt_id`
- SQLite raises `UNIQUE constraint failed: turns.session_id, turns.content_prompt_id`

This spec deliberately does **not** attempt to reconstruct all missing historical turns. It only aims to stop further drift and make the current/latest turn anchor deterministic.

---

## Locked decisions

| # | Decision |
|---|---|
| **D1** | **Transcript tail is the source of truth for new prompt anchors.** When the stop handler needs to backfill a turn without `content_prompt_id`, it does not globally guess across all replay turns. It reads the replay transcript, finds the latest **DB-eligible** replay turn, and uses that replay turn's `promptId`, `promptNumber`, and `transcriptLineStart` as the current anchor. |
| **D2** | **Existing `content_prompt_id` rows are trusted anchors.** If a DB turn already has `content_prompt_id`, that turn is considered anchored and is never re-guessed. Existing anchored rows define the already-consumed replay prompt ids for the session. |
| **D3** | **This spec does not rebuild missing historical turns.** If a session has replay turns that never created DB rows, stop backfill will not synthesize those missing DB turns. The only responsibility here is to anchor the current/latest DB turn correctly and prevent future drift. |
| **D4** | **Only DB-created turn classes are eligible for binding.** A replay turn is eligible only if it is a real user prompt under the existing replay parser rules. System-injected transcript entries such as `<task-notification>`, `<command-name>`, `<command-args>`, `<command-message>`, `⏺ Ran ...` remain excluded. User-entered slash commands still count, because they do trigger `UserPromptSubmit` and do create DB turns today. |
| **D5** | **Tail-first means newest unmatched replay turn, not oldest text match.** When a turn is unanchored, backfill chooses from the replay tail. It does not scan from the start of the transcript and does not reuse first textual matches. |
| **D6** | **Hard uniqueness guard before write.** Before writing `content_prompt_id`, check whether another turn in the same session already owns that id. If yes, do not write `content_prompt_id` for this turn and do not fail the hook. Still allow safe fields such as `assistantResponse`, `toolCallCount`, and `transcriptLineStart` to be updated if available. |
| **D7** | **Do not rewrite DB `prompt_number` from replay.** `content_prompt_id` is the durable anchor in scope for this fix. `prompt_number` keeps its existing locally-derived value. This avoids introducing a second collision surface on `UNIQUE(session_id, prompt_number)`. |
| **D8** | **`lastAssistantMessage` precedence is unchanged.** Stop hook's `lastAssistantMessage` remains more authoritative than replay-parsed assistant text for the current/latest turn. This spec only changes prompt anchoring, not current assistant-response precedence. |
| **D9** | **Initial no-anchor sessions are handled by one-way anchoring, not full alignment.** If a session has DB turns but none of them have `content_prompt_id`, stop backfill may still anchor the current/latest turn from the replay tail. It does not attempt to align every historical unanchored turn in one pass. |
| **D10** | **Older orphan turns use promptNumber-only replay matching for safe fields.** For non-latest orphan turns in the same stop call, replay lookup may populate only non-unique fields (`assistantResponse`, `toolCallCount`, `transcriptLineStart`) and must use `promptNumber` only. There is no `userPrompt` textual fallback for orphans in this spec. If `promptNumber` does not match a replay turn, the orphan simply remains partially unbackfilled. |

---

## Non-goals

- **Reconstructing missing DB turns from transcript.** If `UserPromptSubmit` failed and no DB turn exists, this spec does not create one.
- **Repairing all historical orphan turns in one stop call.** This spec is intentionally incremental.
- **Changing replay parser eligibility rules.** The existing "real user prompt" logic remains the filter.
- **Adding upstream Claude Code hook fields.** Hook input still does not expose `promptId`.

---

## Design

### Terminology

- **Anchored turn:** a DB turn with non-null `content_prompt_id`
- **Unanchored turn:** a DB turn with null `content_prompt_id`
- **DB-eligible replay turn:** a parsed replay turn that corresponds to a real user prompt under the current parser rules

### Anchor selection algorithm

For the stop handler's current/latest DB turn:

1. Parse replay transcript once.
2. Build the set of replay prompt ids already consumed by anchored DB turns in the session.
3. Filter replay turns to DB-eligible turns whose `promptId` is not in the consumed set.
4. Walk that filtered replay list from tail to head.
5. Select the latest remaining replay turn as the candidate anchor.
6. Before writing `content_prompt_id`, re-check whether another DB turn in the same session already owns that id.
7. If the id is still free:
   - write `content_prompt_id`
   - write `transcript_line_start`
   - write `tool_call_count`
   - write transcript assistant text, then allow stop handler to override current turn with `lastAssistantMessage`
8. If the id is already occupied:
   - skip writing `content_prompt_id`
   - do not fail the hook
   - still write any safe non-unique fields

### Why this is intentionally simpler

This design does **not** try to infer a global turn-to-turn mapping across the entire session. It only asserts:

- the transcript tail contains the newest real prompt that just finished
- older anchored turns already reserve their prompt ids
- therefore the newest unmatched replay prompt is the safest anchor for the newest unanchored DB turn

That is enough to stop the repeated collision pattern without introducing a full recovery engine.

---

## Implementation

### Task 1: Add tail-anchor helper

**Files:**
- Modify: `src/hooks/backfill.ts`
- Modify: `src/db/turns.ts`

Add a helper shaped roughly like:

```ts
type ReplayAnchor = {
  promptId?: string;
  promptNumber?: number;
  transcriptLineStart?: number;
  assistantText?: string;
  toolCallCount?: number;
};

function findLatestReplayAnchor(...): ReplayAnchor | undefined
```

Responsibilities:

- parse replay turns once
- gather already-used `content_prompt_id` values for the session
- filter to DB-eligible replay turns not already consumed
- return the latest unmatched replay turn

### Task 2: Stop using global text fallback for prompt-id binding

**Files:**
- Modify: `src/hooks/backfill.ts`
- Modify: `src/hooks/handlers/stop.ts`

Change `backfillFromTranscript()` behavior:

- for the current/latest unanchored turn, use the tail-anchor helper
- do not scan the full replay list from the start and bind by first matching `userPrompt`
- keep `lastAssistantMessage` precedence for the latest turn

For older orphan turns in the same stop call:

- do **not** write `content_prompt_id`
- do **not** use textual fallback
- allow only `promptNumber`-matched replay lookup
- if a `promptNumber` match exists, backfill only non-unique fields:
  - `assistantResponse`
  - `toolCallCount`
  - `transcriptLineStart`
- if no `promptNumber` match exists, leave the orphan untouched

### Task 3: Add uniqueness-safe write path

**Files:**
- Modify: `src/db/turns.ts`
- Modify: `src/hooks/backfill.ts`

Before writing `content_prompt_id`, check:

```sql
SELECT id
FROM turns
WHERE session_id = ?
  AND content_prompt_id = ?
  AND id <> ?
LIMIT 1
```

If occupied:

- skip `content_prompt_id` write
- do not throw

This must make stop hook collisions impossible even if tail inference is wrong.

### Task 4: Keep line-number and assistant backfill behavior

**Files:**
- Modify: `src/hooks/backfill.ts`
- Modify: `tests/hooks/backfill.test.ts`
- Modify: `tests/hooks/stop.test.ts`

Preserve:

- `transcriptLineStart` backfill
- `toolCallCount` backfill
- latest-turn `lastAssistantMessage` override

Only the prompt-id binding strategy changes.

---

## Test cases

| # | Case | Assert |
|---|---|---|
| 1 | Repeated prompt text earlier in session | Latest unanchored turn does not reuse the earlier anchored turn's `content_prompt_id` |
| 2 | Tail-first anchor on latest turn | Latest unanchored turn gets the latest unmatched replay `promptId` and `transcriptLineStart` |
| 3 | Existing anchored turns reserve prompt ids | Replay prompt ids already present in DB are excluded from candidate anchors |
| 4 | Occupied `content_prompt_id` | Stop hook does not throw; `content_prompt_id` write is skipped safely |
| 5 | User-entered slash command | Replay turn remains DB-eligible and can anchor a DB turn |
| 6 | System-injected command wrapper | Non-DB replay entries are not considered anchor candidates |
| 7 | `lastAssistantMessage` override | Latest turn still prefers hook payload assistant text over replay assistant text |
| 8 | No prior anchors in DB, but DB turn exists | Latest DB turn still receives a tail-derived anchor |
| 9 | Session with missing historical DB turns | Stop anchors the current/latest turn only; it does not synthesize missing historical turns |
| 10 | Older orphan with matching `promptNumber` | Orphan backfills only non-unique fields and does not write `content_prompt_id` |
| 11 | Older orphan without matching `promptNumber` | Orphan remains untouched; no textual fallback is used |

---

## Verification

- `bun test tests/hooks/backfill.test.ts tests/hooks/stop.test.ts`
- `npm run typecheck`
- optional manual repro with a real session containing:
  - duplicated prompt text (`测试`)
  - an earlier anchored turn
  - a later unanchored current turn
  - expected result: no `UNIQUE(session_id, content_prompt_id)` failure
