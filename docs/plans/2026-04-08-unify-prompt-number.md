# Unify prompt_number: JSONL-Derived Turn Numbering

Date: 2026-04-08

## Problem

`session-init.ts:54` derives `prompt_number` from DB count:

```typescript
const promptNumber = getTurnsForSession(db, session.id).length + 1;
```

This breaks for adopted/untracked sessions (started before mnemo was installed): DB has fewer turns than the JSONL, so `prompt_number` drifts from the actual Nth user message. `replay(session=X, turn=N)` then locates the wrong turn.

Backfill, replay, and undo detection already parse the JSONL and use real turn numbers. Only the turn creation entry point is still DB-based.

## Goal

All paths that produce or consume `prompt_number` agree on the same numbering, derived from the JSONL transcript.

## Implementation

### Step 1: Add `countUserPromptsInTranscript` to `transcript-parser.ts`

Lightweight counter — only counts entries, no assistant/tool parsing:

```typescript
export function countUserPromptsInTranscript(transcriptPath: string): number {
  let count = 0;
  for (const entry of readAllTranscriptEntries(transcriptPath)) {
    if (entry.role === 'user' && extractUserPrompt(entry) !== '') {
      count++;
    }
  }
  return count;
}
```

Key rules (must align with `parseReplayTranscript`, NOT `parseTranscript`):

- **Include** `isSidechain` — replay includes them, DB keeps them as `undone`
- **Exclude** `isApiErrorMessage` — already filtered by `readAllTranscriptEntries`
- **Exclude** empty user prompts — same check as `parseReplayTranscript`

Uses `readAllTranscriptEntries` (same entry point as replay), not `readTranscriptEntries` (which filters sidechain for backfill).

### Step 2: Update `session-init.ts`

```typescript
import { countUserPromptsInTranscript } from "../../shared/transcript-parser";

// Replace:
const promptNumber = getTurnsForSession(db, session.id).length + 1;

// With:
const promptNumber = input.transcriptPath
  ? countUserPromptsInTranscript(input.transcriptPath) + 1
  : getTurnsForSession(db, session.id).length + 1;
```

Fallback to DB count when `transcriptPath` is unavailable (defensive).

### Step 3: Add tests

```
tests/shared/transcript-parser.test.ts:
  - countUserPromptsInTranscript with normal session → matches parseReplayTranscript turn count
  - countUserPromptsInTranscript with sidechain entries → includes them in count
  - countUserPromptsInTranscript with empty/missing file → returns 0

tests/hooks/handlers/session-init.test.ts:
  - adopted session (DB has 0 turns, JSONL has 3) → prompt_number = 4
  - normal session (DB has 2 turns, JSONL has 2) → prompt_number = 3 (same either way)
  - no transcriptPath → falls back to DB count
```

### Step 4: Verify alignment

Confirm that `countUserPromptsInTranscript` and `parseReplayTranscript` produce the same count for the same JSONL file:

```typescript
// These must always be equal:
countUserPromptsInTranscript(path)
parseReplayTranscript(path).length
```

Add this as an assertion in the test suite — if someone changes one parser's rules, the test catches the divergence.

### Step 5 (optional): Historical repair

For adopted sessions with existing wrong `prompt_number` values:

```typescript
// In stop handler, after backfill:
function repairPromptNumbers(db: Database, sessionId: number, transcriptPath: string): void {
  const replayTurns = parseReplayTranscript(transcriptPath);
  const dbTurns = getTurnsForSession(db, sessionId);

  for (const dbTurn of dbTurns) {
    const replayTurn = replayTurns.find(t =>
      t.userPrompt.startsWith(dbTurn.userPrompt?.slice(0, 80) ?? '')
    );
    if (replayTurn && replayTurn.promptNumber !== dbTurn.promptNumber) {
      db.query('UPDATE turns SET prompt_number = ? WHERE id = ?')
        .run(replayTurn.promptNumber, dbTurn.id);
    }
  }
}
```

Only needed if adopted sessions already exist with drifted numbers. Skip if no such sessions exist yet.

## Files Changed

| File | Change |
|------|--------|
| `src/shared/transcript-parser.ts` | Add `countUserPromptsInTranscript` |
| `src/hooks/handlers/session-init.ts` | Use JSONL-derived prompt_number |
| `tests/shared/transcript-parser.test.ts` | New tests for counter + alignment assertion |
| `tests/hooks/handlers/session-init.test.ts` | New tests for adopted session scenario |
| `src/hooks/handlers/stop.ts` | Optional: historical repair in backfill path |

## Not Changed

- `parseTranscript` / `parseReplayTranscript` — unchanged, already correct
- `backfill.ts` — uses `parseReplayTranscript`, already JSONL-based
- `replay.ts` — uses `parseReplayTranscript`, already JSONL-based
- `stop.ts` undo detection — uses `parseReplayTranscript`, already JSONL-based
