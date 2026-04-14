# Session-Init Prompt Number: DB-Authoritative

**Goal:** Stop session-init from depending on transcript parser count for `prompt_number` generation. Use DB `MAX(prompt_number)` as the sole incrementing source, with a one-time transcript count fallback for cold-start sessions.

---

## Context

`session-init.ts:68-70` currently derives `prompt_number` from:

```ts
const promptNumber = input.transcriptPath
  ? countUserPromptsInTranscript(input.transcriptPath) + 1
  : getTurnsForSession(db, session.id).length + 1;
```

This breaks when the transcript parser and `UserPromptSubmit` hook disagree on what counts as a turn. Observed failure in S675 (KawaiiLLM):

- User typed `/markdown-writing 在审查一下文档`
- `UserPromptSubmit` fired and created DB T47
- But `countUserPromptsInTranscript` returned 46 (one less than DB's max prompt_number)
- Next `UserPromptSubmit` tried to insert `prompt_number = 47` again
- SQLite raised `UNIQUE(session_id, prompt_number)` failure

Root cause: **`UserPromptSubmit` hook trigger granularity and transcript parser's "real user prompt" counting granularity can disagree.** The hook created a DB turn, but `countUserPromptsInTranscript` did not count it as an independent prompt. The exact upstream mechanism is unconfirmed; the fix should not depend on why the count diverges, only that it can.

---

## Locked decisions

| # | Decision |
|---|---|
| **D1** | **DB `MAX(prompt_number) + 1` is the primary source for new turn numbering.** Session-init queries `SELECT MAX(prompt_number) FROM turns WHERE session_id = ?` and adds 1. This is monotonically increasing and cannot collide with existing rows. |
| **D2** | **Cold-start fallback uses `countUserPromptsInTranscript` once.** When DB has no turns for a session (new session or pre-mnemo session being resumed), fall back to `countUserPromptsInTranscript(transcriptPath) + 1` to produce a reasonable starting ordinal. This is a one-time cost; subsequent turns use D1. |
| **D3** | **`prompt_number` is a DB-local ordinal, not a transcript-aligned sequence.** It may diverge from the transcript's promptId count when hook and parser granularity disagree. This is acceptable because `content_prompt_id` is the durable cross-system anchor, not `prompt_number`. |
| **D4** | **Turns without their own `promptId` stay unanchored.** If stop's tail-anchor finds that the transcript tail's `promptId` is already owned by another turn, the D6 guard in the tail-anchor spec skips writing `content_prompt_id`. The turn keeps `content_prompt_id = NULL`. No special status, no merge logic. |
| **D5** | **`countUserPromptsInTranscript` is no longer called on every `UserPromptSubmit`.** It only runs in the cold-start path (D2). This eliminates a full JSONL scan from the hot path. |
| **D6** | **No `prompt_number` rewrite at stop time.** Stop/backfill anchors `content_prompt_id` and `transcript_line_start` only. `prompt_number` keeps the value assigned at session-init. Consistent with tail-anchor spec D7. |

---

## Non-goals

- **Rewriting existing `prompt_number` values in the DB.** Historical turns keep their current ordinals.
- **Removing `countUserPromptsInTranscript` entirely.** It's still needed for the cold-start path and may be used by other consumers.
- **Merging or deleting unanchored skill-expansion turns.** They stay in the DB as a record of user action; they just have no transcript anchor.

---

## Implementation

### Task 1: Add `getMaxPromptNumber` query

**Files:**
- Modify: `src/db/turns.ts`

```ts
export function getMaxPromptNumber(
  db: Database,
  sessionId: number,
): number | null {
  const row = db
    .query<{ max: number | null }, [number]>(
      `SELECT MAX(prompt_number) AS max FROM turns WHERE session_id = ?`,
    )
    .get(sessionId);
  return row?.max ?? null;
}
```

### Task 2: Change session-init prompt number generation

**Files:**
- Modify: `src/hooks/handlers/session-init.ts`

Replace:

```ts
const promptNumber = input.transcriptPath
  ? countUserPromptsInTranscript(input.transcriptPath) + 1
  : getTurnsForSession(dependencies.db, session.id).length + 1;
```

With:

```ts
const dbMax = getMaxPromptNumber(dependencies.db, session.id);
const promptNumber = dbMax !== null
  ? dbMax + 1
  : input.transcriptPath
    ? countUserPromptsInTranscript(input.transcriptPath) + 1
    : 1;
```

Remove the `getTurnsForSession` import if it is no longer used elsewhere in this file.

### Task 3: Tests

**Files:**
- Modify: `tests/hooks/session-init.test.ts`
- Modify: `tests/db/turns.test.ts`

Test cases:

| # | Case | Assert |
|---|---|---|
| 1 | Normal increment | DB has turns T1-T5, new turn gets `prompt_number = 6` |
| 2 | Cold-start with transcript | DB has no turns, transcript has 10 prompts, new turn gets `prompt_number = 11` |
| 3 | Cold-start without transcript | DB has no turns, no transcript path, new turn gets `prompt_number = 1` |
| 4 | Unanchored turn gap | DB has T1-T47 (T47 has no `content_prompt_id`), next turn gets `prompt_number = 48`, not 47 |
| 5 | `getMaxPromptNumber` returns null for empty session | No turns in session, returns `null` |
| 6 | `getMaxPromptNumber` returns correct max | Turns with non-sequential prompt_numbers, returns the highest |
| 7 | Hot path does not scan transcript | DB has turns, `transcriptPath` is provided, `prompt_number` equals `dbMax + 1` regardless of transcript content (transcript is not read) |

---

## Verification

- `bun test tests/hooks/session-init.test.ts tests/db/turns.test.ts`
- `npm run typecheck`
- Manual: in a session with prior skill expansion turns, submit a new prompt and confirm no `UNIQUE(session_id, prompt_number)` failure
