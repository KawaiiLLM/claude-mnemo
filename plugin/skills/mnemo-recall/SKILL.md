---
name: mnemo-recall
description: Search and read structured memory from past sessions in this project. Use when the user asks "did we already do this?", "how did we fix X last time?", "what happened last week?", or when you need context from a previous conversation before answering.
---

# Mnemo Recall

Read past work across sessions. Two tools:

- `recall` — structured search over sessions / turns / observations / memories
- `replay` — raw transcript content from the source JSONL (exact prompts, responses, tool I/O)

**Rule of thumb**: start broad, drill into detail. Never fetch full turns or tool calls without narrowing the selector first — the default `collapsed` depth is 5-10× cheaper.

## When to Use

Use when the user asks about PREVIOUS sessions (not the current one):

- "Did we already solve this?"
- "How did we fix X last time?"
- "What happened in last week's work?"
- "Show me the exact tool calls for the auth refactor"
- "What do we already know about this project?"

Also use *proactively* before answering anything that depends on earlier decisions — you may already have the answer in memory.

## Data Model

```
Session  [S12]   one per Claude Code conversation
  Turn     [T3]   one per user prompt (promptNumber-scoped to session)
    Observation [O87]   one per tool call
Memory   [M4]   durable cross-session knowledge
```

Output IDs map directly to selectors:

- `[S12]` → `recall(id="S12")`
- `[S12/T3]` → `recall(id="S12/T3")` (turn = session-scoped promptNumber)
- `[O87]` → `recall(id="O87")` (observation = global DB id)
- `[M4]` → `recall(id="M4")` (memory = global DB id)

## Progressive Workflow

### Step 1 — Browse or search

```
recall()                                        # recent sessions (collapsed)
recall(query="auth race")                       # FTS across all layers
recall(query="type:bugfix file:src/auth.ts")    # typed filters
recall(query="tag:feedback")                    # memory tag filter
recall(time="-7d")                              # last 7 days
recall(id="M*")                                 # all active memories
```

Returns a list of sessions / turns / observations / memories with titles only (~30-80 tokens each).

### Step 2 — Drill into a session

```
recall(id="S12")                                # session summary + collapsed turn list
recall(id="S12/T*")                             # all turns in session, collapsed
recall(id="S12/T3..7")                          # turns 3-7 only
recall(id="S12", depth="expanded")              # session + turn content inline
```

### Step 3 — Turn detail and observations

```
recall(id="S12/T3", depth="expanded")           # single turn with prompt + response + files
recall(id="S12/T3/O*")                          # all observations for one turn
recall(id="S12/T*/O*")                          # all observations across a session
recall(id="O87", depth="expanded")              # single observation, full content
```

### Step 4 — Raw transcript (when exact wording matters)

```
replay(id="S12")                                # turn overview from transcript
replay(id="S12/T3", depth="expanded")           # full QA: user prompt + assistant response + tool calls
replay(id="S12/T3", depth="full")               # same, no truncation on tool I/O
replay(id="S12/T3/Tool2", depth="expanded")     # single tool call detail
replay(id="S12/T3/Tool*", depth="full")         # every tool in that turn, untruncated
```

Prefer `recall` when the structured title/content is enough. Switch to `replay` only when:

- You need the exact user prompt wording
- The observation was truncated and you need the full tool result
- The recall output references a tool call by position (e.g. "the second Edit") and you need its args

## `recall` Parameter Reference

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Selector. Wildcards (`*`), ranges (`5..10`), and paths (`S12/T3/O*`) supported. See *Selector Grammar* below. |
| `query` | string | Free text + optional prefixes `type:` / `file:` / `project:` / `tag:`. Space-separated tokens, ANDed. |
| `time` | string | `-7d` / `-2w` (relative), `2026-04-01` (single UTC day), `2026-04-01..2026-04-07` (inclusive UTC range). |
| `depth` | string | `collapsed` (default) / `expanded` / `full`. |
| `limit` | number | Max results. Default `50`. |

Omit `id` **and** `query` to get recent sessions.

### Selector Grammar

| Form | Meaning |
|---|---|
| `S*` / `S12` / `S5..10` | Sessions |
| `S12/T*` / `S12/T3` / `S12/T3..7` | Turns in a session (promptNumber) |
| `S12/T3/O*` | Observations for one turn |
| `S12/T*/O*` | Observations for an entire session |
| `O87` | Single observation (global DB id) |
| `M*` / `M4` / `M1..20` | Memories |

Turn IDs in `S12/T3` are **session-scoped promptNumbers**, not global DB ids. Use the form exactly as it appears in output headers.

### Query Filters

| Prefix | Applies to | Notes |
|---|---|---|
| `type:bugfix` | turns, observations, memories | Matches the `type` field. Turn types: `bugfix` / `feature` / `refactor` / `change` / `discovery` / `decision`. |
| `file:src/auth.ts` | turns, observations | Substring match against `files_read` + `files_modified`. |
| `project:/abs/path` | sessions, turns, observations | Exact match against `session.project` (absolute path). |
| `tag:foo` | memories only | Post-filter; ignores non-memory results. Combine with text terms to narrow. |

Free words become an FTS phrase (each word is quoted and ANDed). Example: `query="token refresh"` → matches rows containing both "token" AND "refresh".

## `replay` Parameter Reference

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Required. `S12` / `S12/T3` / `S12/T3..7` / `S12/T3/Tool2` / `S12/T3/Tool*`. |
| `depth` | string | `collapsed` (default) / `expanded` / `full`. `full` disables truncation on tool results — use only when you need the exact payload. |

`replay` reads the original JSONL transcript from disk, so it's accurate to the byte. It works even for turns that were never fully extracted.

## Depth Guidance

| Depth | Use when |
|---|---|
| `collapsed` | Browsing / listing. Titles + counts only. Default. |
| `expanded` | You have a specific target (one session, turn, or observation) and need content. |
| `full` | Rare. Only for `replay` when you need untruncated tool I/O. |

Do NOT pass `depth="full"` on a multi-turn `recall` — it expands every nested record and blows context.

## Common Patterns

**"Did we already fix the auth race?"**
```
recall(query="auth race")
# → sees [S12/T3] "Fixed auth mutex"
recall(id="S12/T3", depth="expanded")
# → reads the turn content + insight
```

**"Show me the exact edit to login.ts last Thursday"**
```
recall(query="file:src/login.ts", time="2026-04-03")
# → picks out [S8/T2]
replay(id="S8/T2", depth="expanded")
# → exact user prompt, assistant response, edit diff
```

**"What feedback has the user given about testing?"**
```
recall(query="tag:feedback testing")
# → list of M-level memories tagged feedback containing "testing"
recall(id="M4", depth="expanded")
# → full memory content + reasoning + application
```

**"What are we working on this week?"**
```
recall(time="-7d")
# → recent sessions
```

## Undone Turns

Turns reverted via sidechain appear with `[undone]` markers in `replay` output. They represent abandoned work — treat them as historical, not current state. The main `recall` path filters most undone turns out of rollups, but `replay` is faithful to the transcript and shows everything.

## Guidance

- Prefer `recall` for structured navigation and FTS — it's cheaper and deduped.
- Prefer `replay` when exact wording, tool arguments, or untruncated results matter.
- Narrow with `id` / `query` / `time` **before** raising `depth`.
- Use `project:<path>` to scope to the current repo when the user's question is project-local.
- Omit parameters you don't need — defaults are tuned for browsing.
