---
name: mnemo
description: Search structured memory from past sessions. Use when user asks "did we already do this?", "what happened last time?", "how did we fix X?", or needs context from previous conversations.
---

# Mnemo

Search and replay past work across all sessions. Two tools: `recall` (structured memory) and `replay` (raw transcript).

## When to Use

Use when users ask about PREVIOUS sessions (not current conversation):

- "Did we already fix this?"
- "How did we solve X last time?"
- "What happened last week?"
- "Show me the exact conversation about auth"

## Data Model

```
Session (one per conversation)  →  [S12]
  Turn (one per QA round)       →  [T2]
    Observation (notable event) →  [O7]
```

Output IDs `[S12]` and `[O7]` can be used directly in follow-up `recall` calls. Turn IDs are session-scoped promptNumbers, so both `recall(scope="turns", session=12, turn=2)` and `replay(session=12, turn=2)` refer to `[T2]`. Undone turns (user-reverted work) appear with `[undone]` markers in replay.
Observation IDs are global database IDs, so `[O7]` maps to `recall(scope="observations", obs=7)`.

## Progressive Workflow

**Start broad, drill into detail. Never fetch full transcripts without narrowing first.**

### Step 1: Browse or Search

```
recall(scope="sessions")                                    → recent sessions (~15 tokens each)
recall(scope="sessions", query="auth race")                 → FTS5 search across sessions
recall(scope="observations", type="bugfix", file="src/auth.ts") → filter by type and file
recall(scope="sessions", time="-7d")                        → recent sessions by date
```

### Step 2: Drill Into a Session

```
recall(scope="turns", session=12)                          → turns in session
recall(scope="turns", session=12, depth="expanded")       → turns + observations inline
```

### Step 3: Full Detail

```
recall(scope="observations", session=12, turn=2)          → observations for turn [T2]
recall(scope="observations", obs=7)                       → single observation, all fields
```

### Step 4: Raw Transcript (when exact wording matters)

```
replay(session=12)                          → turn overview
replay(session=12, turn=2)                  → full QA: prompt + response + tools
replay(session=12, turn=2, tool=1)          → single tool call detail
replay(session=12, turn=2, full=true)       → no truncation on tool results
```

## Parameter Reference

### recall

| Parameter | Type | Description |
|-----------|------|-------------|
| `scope` | string | Required on the new API: `sessions`, `turns`, or `observations` |
| `query` | string | FTS5 keyword search within the selected scope |
| `session` | int/int[]/string | Session selector (DB id from `[S12]`) |
| `turn` | int/int[]/string | Turn selector (promptNumber from `[T2]`, requires `session`) |
| `obs` | int/int[]/string | Observation selector (uses DB id from `[O7]`) |
| `depth` | string | `collapsed`, `expanded`, or `full` |
| `type` | string | Filter by observation type |
| `file` | string | Filter by file path |
| `time` | string | Date syntax sugar, e.g. `"-7d"` or `"2026-04-01..2026-04-07"` |
| `project` | string | Filter by project |

### replay

| Parameter | Type | Description |
|-----------|------|-------------|
| `session` | int | Required. Session DB id |
| `turn` | int | Turn promptNumber (the `#N` in output, not the DB id) |
| `tool` | int | Tool call index within the turn (1-based) |
| `full` | bool | Disable truncation on tool results |

**Turn lookup**: turn references are session-scoped. Use `recall(scope="turns", session=12, turn=2)` or `replay(session=12, turn=2)` for turn `[T2]`.

## Guidance

- **Prefer `recall`** for fast structured navigation and search.
- **Prefer `replay`** when exact prompt/response wording or tool I/O matters.
- **Observation** entries are the most specific durable memory unit.
- **Undone turns** appear in replay with `[undone]` markers — these represent reverted work, not current state.
