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
Turn IDs are session-scoped promptNumbers, so use `recall(id="S12/T2", depth="expanded")` or `replay(id="S12/T2", depth="expanded")` for `[T2]`.
Observation IDs are global database IDs, so `[O7]` maps to `recall(id="O7", depth="expanded")`.
Memory IDs are global database IDs, so `[M1]` maps to `recall(id="M1", depth="expanded")`.

## Progressive Workflow

**Start broad, drill into detail. Never fetch full transcripts without narrowing first.**

### Step 1: Browse or Search

```
recall()                                                         → recent sessions
recall(query="auth race")                                        → FTS5 search across sessions
recall(query="type:bugfix file:src/auth.ts")                     → filter by type and file
recall(id="M*")                                                  → all memories
recall(query="type:feedback")                                    → feedback hits across layers
recall(time="-7d")                                               → recent sessions by date
```

### Step 2: Drill Into a Session

```
recall(id="S12/T*")                                      → turns in session
recall(id="S12/T*", depth="expanded")                    → turns + observations inline
```

### Step 3: Full Detail

```
recall(id="S12/T2/O*")                                  → observations for turn [T2]
recall(id="O7", depth="expanded")                       → single observation, all fields
recall(id="M1", depth="expanded")                       → single memory, all fields
```

### Step 4: Raw Transcript / Rewrite

```
replay(id="S12")                                            → turn overview
replay(id="S12/T2", depth="expanded")                       → full QA: prompt + response + tools
replay(id="S12/T2/Tool1", depth="expanded")                 → single tool call detail
replay(id="S12/T2/Tool1", depth="full")                     → no truncation on tool results
remember({ parent: "S12", title: "...", content: "..." })      → write turn
remember({ parent: "S12/T2", type: "bugfix", title: "..." })    → write observation
remember({ type: "feedback", scope: "global", title: "..." })   → write memory
```

## Parameter Reference

### recall

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Selector like `S12`, `S12/T2`, `S12/T2/O*`, `O7`, or `M1` |
| `query` | string | FTS search with optional prefixes like `type:`, `file:`, `project:`, `tag:` |
| `time` | string | Day-level date filter, e.g. `-7d` or `2026-04-01..2026-04-07` |
| `depth` | string | `collapsed`, `expanded`, or `full` |
| `limit` | int | Max result count |

### replay

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Required selector like `S12`, `S12/T2`, or `S12/T2/Tool1` |
| `depth` | string | `collapsed`, `expanded`, or `full` |

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
- Use `O7` for a specific observation. `S12/T2/O*` is list-only, not a detail id.
- Undone turns appear in replay with `[undone]` markers — these represent reverted work, not current state.
