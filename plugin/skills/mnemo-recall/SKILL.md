---
name: mnemo-recall
description: Search past sessions for the *why* behind this project's code — design rationale, rejected alternatives, decisions, and user corrections that source never records. Use when asked why something is designed the way it is, before reconstructing a rationale from code (which produces confident-but-wrong stories), or for prior work ("did we already do this?", "how did we fix X last time?"). For what the code does now, read the source first.
---

# Mnemo Recall

`recall` is the structured read index over past sessions. It returns paginated, truncated summaries from SQLite: session headers, turn titles, and observation summaries. For exact prompts, full responses, full tool output, or raw transcript reconstruction, switch to the `mnemo-replay` skill.

**Three axes of read access**:
- `recall` — content index: what happened, where, and what to inspect next
- `timeline` — temporal narrative: how a single session unfolded
- `mnemo-replay` skill — raw truth: direct JSONL and SQLite reads

**Rule of thumb**: start broad, then narrow. `collapsed` is the cheap browsing mode. Use `expanded` only once you have a target. If a `recall` result is good enough, stop there.

## When to Use

Use when the user asks about PREVIOUS sessions rather than the current turn:

- "Did we already solve this?"
- "How did we fix X last time?"
- "What happened in last week's work?"
- "What do we already know about this project?"

Also use it proactively before answering questions that may already be covered by prior work.

**Especially for "how does X work / why is X done this way" in a codebase where prior sessions exist**: before re-deriving from source, check if a past spec-review or design session already enumerated the rules. Implementation rationale (why a threshold is 1000, why a hook fires on event X not Y) lives in session summaries, not code comments. Re-deriving from code alone produces self-consistent but wrong stories when the why is lost.

## Data Model

```text
Session  [S12]   one per Claude Code conversation
  Turn     [T3]   one per user prompt (promptNumber-scoped to session)
    Observation [O87]   one per tool call
```

Output IDs map directly to selectors:

- `[S12]` → `recall(id="S12")`
- `[S12/T3]` → `recall(id="S12/T3")`
- `[O87]` → `recall(id="O87")`

## Progressive Workflow

### Step 1 — Browse or search

```text
recall()                                        # recent sessions
recall(query="auth race")                       # FTS across all layers
recall(query="type:bugfix file:src/auth.ts")    # typed filters
recall(time="-7d")                              # last 7 days
```

These return paginated, collapsed results by default. Use `page` to move through large result sets.

### Step 2 — Drill into a session

```text
recall(id="S12")                                # session summary + collapsed turn preview
recall(id="S12/T*")                             # all turns in a session
recall(id="S12/T3..7")                          # turn range
recall(id="S12", depth="expanded")              # session content + raw transcript path
```

At expanded session depth, the output includes a `raw:` path pointing at the source JSONL. That is the handoff point to `mnemo-replay` when exact bytes matter.

### Step 3 — Turn detail and observations

```text
recall(id="S12/T3", depth="expanded")           # one turn with prompt + response + file lists
recall(id="S12/T3/O*")                          # observations for one turn
recall(id="S12/T*/O*")                          # observations across the session
recall(id="O87", depth="expanded")              # one observation with full stored fields
```

### Step 4 — Escalate only when needed

If a field is truncated, raise `truncate` first:

```text
recall(id="S12/T3", depth="expanded", truncate=2000)
```

If the result still is not enough, or you need exact wording, the full response, or full tool output, switch to the `mnemo-replay` skill. There is no unlimited `recall` mode.

## `recall` Parameter Reference

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Selector. Supports wildcards (`*`), ranges (`5..10`), and nested paths (`S12/T3/O*`). |
| `query` | string | Free text + optional prefixes `type:` / `file:` / `project:`. Tokens are ANDed. |
| `time` | string | `-7d` / `-2w` (relative), `YYYY-MM-DD` (single UTC day), `YYYY-MM-DD..YYYY-MM-DD` (inclusive UTC range). |
| `depth` | string | `collapsed` (default) or `expanded`. |
| `page` | number | 1-indexed page number for the target level. Default `1`. |
| `pageSize` | number | Item count for the target level page. |
| `truncate` | number | Character cap per rendered field. Default `200`, max `2000`. |

Omit both `id` and `query` to get recent sessions.

Child collections are always shown as a fixed preview with a `+N more` hint. To inspect more children, narrow the selector to that child level.

### Selector Grammar

| Form | Meaning |
|---|---|
| `S*` / `S12` / `S5..10` | Sessions |
| `S12/T*` / `S12/T3` / `S12/T3..7` | Turns in a session |
| `S12/T3/O*` | Observations for one turn |
| `S12/T*/O*` | Observations for an entire session |
| `O87` | Single observation (global DB id) |
| `T418` | Single turn (global DB id) |

In the `S12/T3` form the turn id is a session-scoped prompt number. Bare `T418` is the global DB id; prefer the `S/T` form unless you already hold a DB id.

### Query Filters

| Prefix | Applies to | Notes |
|---|---|---|
| `type:bugfix` | turns, observations | Matches stored type tags. |
| `file:src/auth.ts` | turns, observations | Substring match against `files_read` + `files_modified`. |
| `project:/abs/path` | sessions, turns, observations | Exact match against `session.project`. |

Free words become an FTS query over indexed text.

## Depth Guidance

| Depth | Use when |
|---|---|
| `collapsed` | Browsing and list navigation. |
| `expanded` | You have a specific target and need stored fields inline. |

There is no `full` depth anymore.

## Common Patterns

**"Did we already fix the auth race?"**
```text
recall(query="auth race")
# → sees [S12/T3] "Fixed auth mutex"
recall(id="S12/T3", depth="expanded")
```

**"Show me the exact edit to login.ts last Thursday"**
```text
recall(query="file:src/login.ts", time="2026-04-03")
# → picks out [S8/T2]
recall(id="S8", depth="expanded")
# → session shows raw: /Users/...jsonl
# → switch to mnemo-replay for exact transcript bytes
```

## Guidance

- Prefer `recall` for search, browsing, and structured answers.
- Narrow with `id`, `query`, or `time` before raising `depth`, `pageSize`, or `truncate`.
- Use `project:<path>` when the question is project-local.
- When `recall` shows a `raw:` path or a truncation hint, that is your signal to switch to `mnemo-replay`.
