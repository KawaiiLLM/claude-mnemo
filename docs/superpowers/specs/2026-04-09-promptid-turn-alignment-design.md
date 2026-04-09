# PromptId Turn Alignment Design

## Goal

Use Claude Code's `promptId` (from session JSONL) as the correlation key between DB turns and transcript entries. This eliminates fragile position-based counting and fixes a bug where string-format user messages are skipped by `isCountedUserPrompt()`.

## Problem

### Counting bug

`countUserPromptsInTranscript()` uses `isCountedUserPrompt()` which only finds `content: [{ type: "text" }]` array-format messages. But real user prompts in the JSONL are often `content: "string"` format. These are invisible to the counter, causing `prompt_number` to be too low on resume.

### Position fragility

`parseReplayTranscript()` and `backfillFromTranscript()` match DB turns to transcript entries by position (Nth user message = prompt_number N). This breaks if the counting logic and the transcript structure diverge.

### Undo detection fragility

`detectUndoPromptNumbers()` matches DB turns to transcript by `promptNumber` position. If counting is wrong, undo detection matches the wrong turns.

## Key Constraint

**`promptId` is only in the JSONL, not in hook inputs.** Claude Code's hook input schema (`BaseHookInput`) does not include `promptId`. It's a transcript-level metadata field on each JSONL entry.

Therefore: `content_prompt_id` must be backfilled from the transcript at Stop/Compact time, not captured at UserPromptSubmit time.

## Design

### DB Change

Add `content_prompt_id TEXT` to turns table:

```sql
ALTER TABLE turns ADD COLUMN content_prompt_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_turns_session_prompt_id
  ON turns(session_id, content_prompt_id) WHERE content_prompt_id IS NOT NULL;
```

Nullable. Old turns stay NULL and use position-based fallback. The partial unique index ensures one `promptId` maps to at most one turn per session — duplicate backfill or concurrency bugs surface as constraint violations instead of silent data corruption.

### JSONL Entry Structure

`promptId` is at the top level of each JSONL entry (not inside `message`):

```json
{
  "promptId": "0c4867fc-f9c1-472b-a658-abcba2ec51ed",
  "type": "user",
  "message": { "role": "user", "content": "你好" },
  ...
}
```

Multiple entries share the same `promptId` (user prompt, caveats, slash commands, tool results within the same interaction cycle). Assistant responses that follow do NOT have `promptId`.

**`promptId` generation rules** (observed from real transcripts):

| Message type | New `promptId`? |
|---|---|
| Real user prompt | Yes |
| Slash command / caveat / command output | No (shares parent prompt's id) |
| Tool result (`type: "tool_result"`) | No (shares parent prompt's id) |
| Task notification (subagent return) | **Yes** (gets own `promptId`) |

Task notifications produce new `promptId`s. To avoid position drift that would break fallback matching for old turns (without `content_prompt_id`), **only real user prompts should be counted as turns**. 

Detection uses the `permissionMode` field on the JSONL entry as the primary signal — only real user prompts that require Claude to respond carry this field. Content-prefix checks serve as a secondary fallback for robustness:

```ts
function isRealUserPrompt(entry: TranscriptEntry): boolean {
  // Primary: permissionMode is set only on prompts that trigger Claude processing
  if (entry.permissionMode) return true;
  // Secondary fallback: exclude known system-injected prefixes
  if (typeof entry.content === "string") {
    if (entry.content.startsWith("<task-notification>")) return false;
    if (entry.content.startsWith("<local-command-")) return false;
    if (entry.content.startsWith("<command-name>")) return false;
  }
  // Default: count as real if it has text content (conservative for unknown formats)
  return extractUserPrompt(entry) !== "";
}
```

`permissionMode` is observed on all real user prompts in tested transcripts (verified across 9169 entries). It is NOT present on task notifications, slash commands, caveats, or command output. The content-prefix fallback handles any edge case where `permissionMode` is absent but the entry is clearly system-injected.

This keeps `countUserPromptsInTranscript` and `parseReplayTranscript` numbering aligned with actual user prompts, preventing position drift in sessions with subagents.

### Transcript Parser Changes

**Critical prerequisite: fix JSONL structure parsing.** The current parser reads `entry.role` and `entry.content` at the top level, but real JSONL entries use `entry.type` for role and nest content under `entry.message`:

```json
{
  "type": "user",                              ← parser reads entry.role (doesn't exist)
  "message": { "role": "user", "content": ... }, ← actual role and content are here
  "promptId": "...",
  "isSidechain": false
}
```

Verified: in 9169 entries across a real session, 0 have top-level `role`, 7363 have `message.role`. The current parser returns `entry.role === undefined` for every entry, making `isCountedUserPrompt()` always return false and `parseReplayTranscript()` return empty. This has been masked because most code paths avoid transcript parsing (DB-tracked sessions use `getTurnsForSession().length + 1`).

**`readAllTranscriptEntries()`** must normalize the nested structure:

```ts
interface TranscriptEntry {
  type?: string;          // top-level: "user", "assistant", "system", etc.
  role?: string;          // resolved from entry.type or entry.message.role
  content?: TranscriptContentBlock[] | string;  // from entry.message.content (may be string or array)
  promptId?: string;      // top-level
  permissionMode?: string; // top-level, present only on real user prompts
  isSidechain?: boolean;  // top-level
  isApiErrorMessage?: boolean;
}
```

The parsing step should map `entry.message.role` → `entry.role` and `entry.message.content` → `entry.content` so downstream functions work without further changes:

```ts
function normalizeEntry(raw: Record<string, unknown>): TranscriptEntry {
  const message = raw.message as Record<string, unknown> | undefined;
  return {
    type: raw.type as string | undefined,
    role: message?.role as string ?? raw.role as string ?? raw.type as string,
    content: message?.content ?? raw.content,
    promptId: raw.promptId as string | undefined,
    permissionMode: raw.permissionMode as string | undefined,
    isSidechain: Boolean(raw.isSidechain),
    isApiErrorMessage: Boolean(raw.isApiErrorMessage),
  };
}
```

**`extractUserPrompt()`** must handle `content` as string (not just array):

```ts
function extractUserPrompt(entry: TranscriptEntry): string {
  if (typeof entry.content === "string") {
    return entry.content.trim();
  }
  // existing array logic
  return getContentBlocks(entry)
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n")
    .trim();
}
```

**`parseReplayTranscript()`** — return `promptId` on each `ParsedReplayTurn`:

```ts
export interface ParsedReplayTurn {
  promptNumber: number;      // positional, for display
  promptId: string | null;   // from JSONL entry, for correlation
  userPrompt: string;
  assistantText: string;
  toolCalls: ReplayToolCall[];
  isSidechain: boolean;
}
```

Turn boundary detection changes from `isCountedUserPrompt()` (broken for string content) to **new `promptId` appearing on a real user prompt entry**:

```
for each entry:
  if entry.role === "user" and entry.promptId exists
     and entry.promptId differs from current promptId
     and isRealUserPrompt(entry):
    → new turn boundary
    → capture promptId on the ParsedReplayTurn
```

This naturally handles:
- String-format content (has `promptId`, normalized from `message.content`)
- Array-format content (has `promptId`)
- Tool result entries (same `promptId` as parent, not a new turn)
- Sidechain entries (same `promptId` logic, `isSidechain` from entry)
- Task notifications (new `promptId` but no `permissionMode` — not counted as turns)
- Slash commands / caveats / command output (same `promptId` as parent, no `permissionMode`)

**`countUserPromptsInTranscript()`** — count distinct `promptId` values from real user prompts only:

```ts
export function countUserPromptsInTranscript(transcriptPath: string): number {
  const seen = new Set<string>();
  for (const entry of readAllTranscriptEntries(transcriptPath)) {
    if (entry.promptId && entry.role === "user" && isRealUserPrompt(entry)) {
      seen.add(entry.promptId);
    }
  }
  return seen.size;
}
```

The same `isRealUserPrompt` filter applies to `parseReplayTranscript` turn boundary detection — a new `promptId` from a non-real entry does not start a new turn.

### Backfill at Stop/Compact

After parsing the transcript (which already happens for response backfill), match each pending turn to its `ParsedReplayTurn` and write `content_prompt_id`.

**Matching strategy — ordered, one-to-one consumption:**

Iterate `pendingTurns` in `prompt_number` order. For each pending turn, find the **first unconsumed** transcript turn that matches, then mark that transcript turn as consumed:

1. **Primary: by prompt text** — find the first unconsumed `ParsedReplayTurn` where `userPrompt === pendingTurn.userPrompt`
2. **Fallback: by position** — find the first unconsumed `ParsedReplayTurn` where `promptNumber === pendingTurn.promptNumber`

"Unconsumed" means no prior pending turn in this batch has already claimed it. This prevents duplicate matching when the same prompt text appears multiple times (e.g., repeated "continue" / "继续"):

```ts
const consumed = new Set<number>(); // indices into transcriptTurns

for (const pendingTurn of pendingTurns) {
  // Primary: match by prompt text (first unconsumed)
  let matchIndex = transcriptTurns.findIndex((t, i) =>
    !consumed.has(i) && t.userPrompt === pendingTurn.userPrompt
  );
  // Fallback: match by position (first unconsumed)
  if (matchIndex < 0) {
    matchIndex = transcriptTurns.findIndex((t, i) =>
      !consumed.has(i) && t.promptNumber === pendingTurn.promptNumber
    );
  }
  if (matchIndex >= 0) {
    consumed.add(matchIndex);
    // backfill contentPromptId, assistantResponse, toolCallCount from transcriptTurns[matchIndex]
  }
}
```

Update `backfillFromTranscript()` to also write `content_prompt_id` when found.

### Replay Lookup

**Current**: `replay(session=X, turn=N)` → parse entire JSONL, count to Nth user prompt

**New**: 
1. Look up turn in DB → get `content_prompt_id`
2. If `content_prompt_id` is set → scan JSONL to find the turn's start entry (first entry with matching `promptId`), then read forward collecting all entries until the next counted turn boundary or EOF — this includes assistant entries that follow (which have no `promptId`)
3. If NULL → fallback to position-based (old turns, backward compat)

Important: assistant responses do NOT carry `promptId`. A turn's content in the JSONL spans from the first entry with the target `promptId` through all subsequent entries (including assistant, tool_use, tool_result) until the next turn boundary (next new non-system-injected `promptId` on a user entry). The replay function must collect this full span, not just entries with matching `promptId`.

### Undo Detection

`detectUndoPromptNumbers()` currently matches by `turn.promptNumber` → `transcriptTurn.promptNumber` (position). With the new parser returning `promptId`, matching becomes:

1. For turns with `content_prompt_id`: match by `promptId` directly
2. For old turns without it: fallback to position matching

### UserPromptSubmit (Counting Fix Only)

`UserPromptSubmit` cannot know the `promptId` for the current turn — it's not in the hook input, and the current prompt may or may not have been flushed to the JSONL at hook time (Claude Code does not guarantee this).

This design fixes **counting rules** (the `isCountedUserPrompt` bug that skips string-format messages) but does NOT fix the **flush timing ambiguity**. If the current prompt is already in the JSONL when the hook fires, `countUserPromptsInTranscript` (even the fixed version using distinct `promptId`) returns a count that includes it, producing `prompt_number = count + 1` which is 1 too high. This edge case exists in the current implementation and is unchanged by this design.

What changes:
- `countUserPromptsInTranscript` switches from broken `isCountedUserPrompt()` to distinct `promptId` counting — fixes string-format misses
- `content_prompt_id` is set to NULL at creation time — backfilled later at Stop/Compact

What does NOT change:
- The flush-timing ambiguity remains (would require Claude Code to pass `promptId` in hook input to fully resolve)

### prompt_number Semantics

`prompt_number` remains the user-facing integer for `recall(turn=N)`, `remember({ prompt_number: N })`, and `[TN]` display. With `isRealUserPrompt` filtering, task notifications, slash commands, and command output are excluded from counting. Numbering closely tracks real user prompts. Minor gaps may still occur if a filtered entry has a unique `promptId` that happens to be the first entry Claude Code writes for a real prompt cycle (unlikely in practice).

## Files to Modify

| File | Change |
|------|--------|
| `src/db/schema.ts` | Add `content_prompt_id` column + migration + index |
| `src/db/turns.ts` | Add `contentPromptId` to `TurnRecord`/`SaveTurnInput`/`TurnRow`, update queries |
| `src/shared/transcript-parser.ts` | Add `promptId` to `TranscriptEntry`, change turn boundary detection from `isCountedUserPrompt` to `promptId` change, return `promptId` on parsed turns |
| `src/hooks/backfill.ts` | Write `content_prompt_id` when backfilling from transcript |
| `src/mcp/replay.ts` | Add `promptId`-based JSONL lookup path |
| `src/hooks/handlers/stop.ts` | Pass `contentPromptId` through backfill |
| `src/hooks/handlers/compact.ts` | Same |
| Tests | Update transcript-parser, backfill, replay, stop, compact tests |

## Verification

1. `bun test` — all pass
2. Create a session with slash commands interleaved with real prompts → verify `prompt_number` gaps are harmless, `content_prompt_id` is backfilled correctly
3. `replay(session=X, turn=N)` returns correct data when `content_prompt_id` is set
4. Resume an untracked session → verify `countUserPromptsInTranscript` counts correctly using `promptId`
5. Undo a turn → verify detection works via `promptId` matching
