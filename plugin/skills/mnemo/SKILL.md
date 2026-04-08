---
name: mnemo
description: Search structured memory from past sessions. Use when user asks "did we already do this?", "what happened last time?", "how did we fix X?", or needs context from previous conversations.
---

# Mnemo

Search and write knowledge across past sessions. Current tool set:
- `recall` for structured reads
- `replay` for raw transcript reads
- `remember` for writes

Legacy write tools `save_turn` and `update_session` still exist for compatibility, but `remember` is the primary write path.

## When to Use

Use when users ask about PREVIOUS sessions or durable project knowledge:

- "Did we already fix this?"
- "How did we solve X last time?"
- "What happened last week?"
- "Show me the exact conversation about auth"
- "What do we already know about this project?"

## Data Model

```
Session (one per conversation)  →  [S12]
  Turn (one per QA round)       →  [T2]
    Observation (notable event) →  [O7]
Memory (durable knowledge)      →  [M1]
```

Output IDs `[S12]`, `[O7]`, and `[M1]` can be used directly in follow-up `recall` calls.
Turn IDs are session-scoped promptNumbers, so use `recall(scope="turns", session=12, turn=2)` or `replay(session=12, turn=2)` for `[T2]`.
Observation IDs are global database IDs, so `[O7]` maps to `recall(scope="observations", obs=7)`.
Memory IDs are global database IDs, so `[M1]` maps to `recall(scope="memories", id="M1")`.

## Progressive Workflow

**Start broad, drill into detail. Never fetch full transcripts without narrowing first.**

### Step 1: Browse or Search

```
recall(scope="sessions")                                         → recent sessions
recall(scope="sessions", query="auth race")                      → FTS5 search across sessions
recall(scope="observations", type="bugfix", file="src/auth.ts")  → filter by type and file
recall(scope="memories")                                         → active global + project memories
recall(scope="memories", type="feedback")                        → memory type filter
recall(scope="sessions", time="-7d")                             → recent sessions by date
```

### Step 2: Drill Into a Session

```
recall(scope="turns", session=12)                         → turns in session
recall(scope="turns", session=12, depth="expanded")      → turns + observations inline
```

### Step 3: Full Detail

```
recall(scope="observations", session=12, turn=2)          → observations for turn [T2]
recall(scope="observations", obs=7)                      → single observation, all fields
recall(scope="memories", id="M1")                       → single memory, all fields
```

### Step 4: Raw Transcript / Rewrite

```
replay(session=12)                          → turn overview
replay(session=12, turn=2)                  → full QA: prompt + response + tools
replay(session=12, turn=2, tool=1)          → single tool call detail
replay(session=12, turn=2, full=true)       → no truncation on tool results
remember({ parent: "S12", title: "...", content: "..." })      → write turn
remember({ parent: "S12/T2", type: "bugfix", title: "..." })    → write observation
remember({ type: "feedback", scope: "global", title: "..." })   → write memory
```

## Parameter Reference

### recall

| Parameter | Type | Description |
|-----------|------|-------------|
| `scope` | string | Preferred selector: `sessions`, `turns`, `observations`, or `memories` |
| `query` | string | FTS5 keyword search within the selected scope |
| `session` | int/int[]/string | Session selector (DB id from `[S12]`) |
| `turn` | int/int[]/string | Turn selector (promptNumber from `[T2]`, requires `session`) |
| `obs` | int/int[]/string | Observation selector (uses DB id from `[O7]`) |
| `depth` | string | `collapsed`, `expanded`, or `full` |
| `type` | string | Filter by observation or memory type |
| `file` | string | Filter by file path |
| `time` | string | Date syntax sugar, e.g. `"-7d"` or `"2026-04-01..2026-04-07"` |
| `project` | string | Filter by project / memory scope |

### replay

| Parameter | Type | Description |
|-----------|------|-------------|
| `session` | int | Required. Session DB id |
| `turn` | int | Turn promptNumber (the `#N` in output, not the DB id) |
| `tool` | int | Tool call index within the turn (1-based) |
| `full` | bool | Disable truncation on tool results |

### remember

| Parameter | Type | Description |
|-----------|------|-------------|
| `parent` | string | Optional parent selector: `S12` for a turn, `S12/T2` for an observation |
| `id` | string | Optional update target: `S12` for session, `M1` for memory |
| `type` | string | Memory / observation classification |
| `scope` | string | Memory scope, usually `global` or the current project |
| `title` | string | Short title for the record |
| `content` | string | Primary content / summary |
| `insight` | string | Extra reasoning or key points |
| `reasoning` | string | Memory rationale |
| `application` | string | When to use the memory |

## Guidance

- Prefer `recall` for fast structured navigation and search.
- Prefer `replay` when exact prompt/response wording or tool I/O matters.
- Prefer `remember` when writing new turns, observations, session summaries, or durable memories.
- Use `save_turn` and `update_session` only when preserving legacy compatibility matters.
- Observation entries are the most specific durable chronicle unit.
- Memory entries are the durable knowledge layer for cross-session recall.
- Undone turns appear in replay with `[undone]` markers — these represent reverted work, not current state.
