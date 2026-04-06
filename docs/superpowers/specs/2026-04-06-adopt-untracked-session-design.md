# Adopt Untracked Session Design

## Goal

Handle resumed Claude Code sessions that already have transcript history but no stored memory rows, without breaking `prompt_number` alignment between the database and `replay`.

## Problem

Current `UserPromptSubmit` numbering uses:

```ts
getTurnsForSession(db, session.id).length + 1
```

This fails when Claude resumes a session that already has prior JSONL history but `claude-mnemo` has never tracked it before.

Example:

- transcript already contains 7 real user turns
- database contains 0 turns for that `contentSessionId`
- user resumes the session and submits a new prompt
- current implementation stores the new turn as `prompt_number = 1`

After that:

- `recall(session=..., turn=1)` refers to the first tracked DB turn
- `replay(session=..., turn=1)` refers to the first transcript turn

Turn numbering diverges immediately.

## Constraints

### SessionStart must stay cheap

`SessionStart` must not trigger Mnemosyne or any LLM work.

### UserPromptSubmit must stay simple

`UserPromptSubmit` should still only create a new pending turn. It may do lightweight transcript inspection, but it should not backfill, extract, or fork Mnemosyne.

### No transcript byte offsets

Do not persist raw JSONL byte offsets or line numbers. They are brittle and unnecessary for this problem.

### No dependence on undocumented hook guarantees

Claude Code documents `UserPromptSubmit` as occurring before Claude processes the prompt. The docs do not guarantee that the current prompt has already been flushed into the transcript JSONL at hook time.

Therefore, prompt numbering must not depend on seeing the current prompt already present in the file.

## Chosen Strategy

When `claude-mnemo` encounters a session with transcript history but no stored turns, it adopts the existing transcript baseline.

The first newly tracked turn is numbered as:

```text
historical_transcript_turn_count + 1
```

After adoption, future turns use:

```text
max_stored_prompt_number + 1
```

This keeps DB numbering aligned with replay numbering without requiring re-import of the full historical transcript.

## What Counts As A Historical Transcript Turn

Use the same logical turn boundary as `replay`.

Count only real user prompts in the main session transcript:

- include non-empty user prompt entries
- include sidechain user prompts if replay includes them

Do not count:

- `queue-operation` entries
- `last-prompt` entries
- user `tool_result` entries with no new prompt text
- subagent transcript files such as `agent-*.jsonl`
- plugin-internal synthetic control messages that are not part of the main user turn stream

The counting rule must be implemented in one shared place so adoption and replay cannot drift apart.

## Numbering Rules

### Case 1: Normal tracked session

If the DB already has one or more turns for the session:

```text
next_prompt_number = max(prompt_number) + 1
```

Do not inspect transcript history to generate future numbers in this case.

### Case 2: Untracked resumed session with transcript history

If:

- the session exists in Claude transcript storage
- the DB session exists or is being created now
- the DB has zero turns for that session

Then:

```text
next_prompt_number = historical_transcript_turn_count + 1
```

This is the one-time adoption path.

### Case 3: Brand-new session

If the transcript has no prior real user turns and the DB has zero turns:

```text
next_prompt_number = 1
```

## Why Not Recompute From Transcript On Every Insert

This was considered and rejected as the primary source of truth.

Reasons:

1. `UserPromptSubmit` may fire before the current prompt is durably present in the transcript.
2. Repeated prompt text makes “is the current prompt already in JSONL?” ambiguous.
3. Once turns are stored, the DB should remain the stable turn identity cache used by hooks, recall, and extraction.

Instead, transcript inspection should be used only to establish the initial baseline for previously untracked sessions.

## Required Refactor

Replace `getTurnsForSession(...).length + 1` with:

1. a DB-path helper for tracked sessions:
   - `getMaxPromptNumber(sessionId)` or equivalent
2. a one-time adoption helper for untracked sessions:
   - count historical turns from the main transcript using replay-compatible rules

The `prompt_number` written into the DB remains the durable source of truth after insertion.

## Shared Counting Logic

To avoid drift, adoption must reuse the same turn-counting semantics as replay.

Recommended shape:

- keep `parseReplayTranscript()` as the transcript truth for replay
- add a small helper that returns:
  - `countReplayTurns(transcriptPath)`
  - or `getReplayTurnCount(transcriptPath)`

The adoption path should use that helper instead of duplicating counting rules inside hooks.

## Data Model

No schema change is required.

Optional future metadata could be useful for diagnostics:

- `sessions.first_tracked_prompt_number`
- `sessions.adopted_from_existing_history`

These are not required for correctness and are out of scope for the first implementation.

## Hook Behavior

### SessionStart

No change:

- do not fork Mnemosyne
- do not import history
- do not mutate turns

### UserPromptSubmit

New behavior:

1. ensure the DB session exists
2. inspect existing DB turns for that session
3. if DB already has turns, use `max(prompt_number) + 1`
4. if DB has no turns and a transcript path is available, count historical replay turns and use `count + 1`
5. insert the new pending turn with that derived `prompt_number`

### Stop

No semantic change.

Once the pending row is created with the correct prompt number, stop/backfill continues to use DB turn identity as it already does.

## Edge Cases

### Missing transcript path on first adoption

If the first tracked prompt of a resumed session has no transcript path, the system cannot reliably adopt the existing baseline.

Chosen behavior:

- fall back to `prompt_number = 1`
- mark this as a degraded alignment path in logs

This should be rare, and replay/recall mismatch is acceptable only in this explicit degraded case.

### Sidechain history

If replay counts sidechain turns, adoption must also count them.

This ensures:

- `replay(session=..., turn=N)` and DB `prompt_number = N` remain aligned
- undo history does not shift future numbering

### Synthetic/plugin-internal prompts

If plugin-generated prompts appear in the main transcript, they must be excluded from adoption counting unless replay also exposes them as normal turns.

This filter must be based on transcript structure, not on brittle text matching where possible.

## Testing Strategy

Required tests:

1. resumed session with 3 historical transcript turns and no DB turns inserts the new pending turn as `prompt_number = 4`
2. tracked session with DB turns `4,5,6` inserts the next pending turn as `7`
3. adoption ignores `queue-operation`, `last-prompt`, and tool-result-only user entries
4. adoption and replay report the same turn count for the same transcript
5. missing transcript path on adoption falls back to `1` and does not crash

## Risks

### Miscounting synthetic user entries

If adoption counts entries that replay does not, numbering will still drift.

Mitigation:

- share counting logic with replay
- add regression tests using real-world transcript fixtures

### First-prompt timing ambiguity

If the current prompt is already present in JSONL before `UserPromptSubmit` runs in some environments but not others, naive “current transcript length” logic will be unstable.

Mitigation:

- only use transcript count as the historical baseline when DB has zero turns
- always add `+1` for the newly submitted prompt
- do not try to infer whether the current prompt is already flushed

## Non-Goals

- Do not backfill old historical turns into DB during adoption
- Do not trigger Mnemosyne at `SessionStart`
- Do not persist transcript offsets
- Do not solve every possible malformed transcript variant in this change
