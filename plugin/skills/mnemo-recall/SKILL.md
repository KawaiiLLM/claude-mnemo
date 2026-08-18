---
name: mnemo-recall
description: Search past sessions for the *why* behind this project's code — design rationale, rejected alternatives, decisions, and user corrections that source never records. Use when asked why something is designed the way it is, before reconstructing a rationale from code (which produces confident-but-wrong stories), or for prior work ("did we already do this?", "how did we fix X last time?"). For what the code does now, read the source first.
---

# Mnemo Recall

`recall` is the structured read index over past sessions. It returns paginated, truncated summaries from SQLite: session headers, turn titles, and observation summaries. For exact prompts, full responses, full tool output, or raw transcript reconstruction, switch to the `mnemo-replay` skill.

**Three axes of read access**:
- `recall` — content index: what happened, where, and what to inspect next
- `timeline` — temporal narrative: how a single session unfolded
- `mnemo-replay` skill — raw truth: direct SQLite and JSONL reads

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

Segment  [E47]   one arc of work, spanning whatever sessions it took
```

A session is a container; a **segment** is a task. It collects the turns of one
arc of work wherever they happened, so recalling a task does not mean replaying
every session it touched. Its status says which of two things you are reading:
`[open]` is that task's still-live working state, `[delivered]` is its settled
impression — what was concluded and which routes were ruled out. Check for one
before redoing a task.

Output IDs map directly to selectors:

- `[S12]` → `recall(id="S12")`
- `[S12/T3]` → `recall(id="S12/T3")`
- `[O87]` → `recall(id="O87")`
- `[E47]` → `recall(id="E47")`

## Progressive Workflow

### Step 1 — Browse or search

```text
recall()                                        # recent sessions
recall(query="auth race")                       # FTS across all layers
recall(query="type:bugfix file:src/auth.ts")    # typed filters
recall(query="cookie session:S12")              # full-text search within one session
recall(time="-7d")                              # last 7 days
```

These return paginated, collapsed results by default. Use `page` to move through large result sets.

### Step 2 — Drill into a session

```text
recall(id="S12")                                # session summary + collapsed turn preview
recall(id="S12/T*")                             # all turns in a session
recall(id="S12/T3..7")                          # turn range
recall(id="S12", view="expanded")              # session content + raw transcript path
```

At expanded session view, the output includes a `raw:` path pointing at the source JSONL. `mnemo-replay` reads a turn's full text and tool I/O straight from the database; that `raw:` path is the handoff only when you need exact bytes the database does not mirror.

### Step 3 — Read the arc, not the session

```text
recall(id="E47")                                # one segment: body, insight, members
recall(id="E*")                                 # every segment
recall(id="E5..9")                              # segment range
```

A segment row leads with its title, `[open]`/`[delivered]` status and member
count, then its conclusion and the member turns that carry it. Drill into a
member with the ordinary `S12/T3` form. Segments also come back from `query=`
search alongside sessions and turns, and answer `tag:` and `type:` there.

### Step 4 — Turn detail and observations

```text
recall(id="S12/T3", view="expanded")           # one turn with prompt + response + file lists
recall(id="S12/T3/O*")                          # observations for one turn
recall(id="S12/T*/O*")                          # observations across the session
recall(id="O87", view="expanded")              # one observation with full stored fields
```

### Step 5 — Escalate only when needed

If a field is truncated, raise `truncate` first:

```text
recall(id="S12/T3", view="expanded", truncate=2000)
```

If the result still is not enough, or you need exact wording, the full response, or full tool output, switch to the `mnemo-replay` skill. There is no unlimited `recall` mode.

## `recall` Parameter Reference

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Selector. Supports wildcards (`*`), ranges (`5..10`), and nested paths (`S12/T3/O*`). |
| `query` | string | Free text + optional prefixes `type:` / `file:` / `tag:` / `project:` / `session:`. Free-text terms are OR'd and ranked by relevance (bm25); the typed filters are AND'd with the text and each other. |
| `time` | string | `-7d` / `-2w` (relative), `YYYY-MM-DD` (single UTC day), `YYYY-MM-DD..YYYY-MM-DD` (inclusive UTC range). |
| `view` | string | `collapsed` (default) or `expanded`. |
| `page` | number | 1-indexed page number for the target level. Default `1`. |
| `pageSize` | number | Item count for the target level page. Default `10`. |
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
| `E*` / `E47` / `E5..9` | Segments — one arc of work, not a session |

In the `S12/T3` form the turn id is a session-scoped prompt number. Bare `T418` is the global DB id; prefer the `S/T` form unless you already hold a DB id.

### Query Filters

| Prefix | Applies to | Notes |
|---|---|---|
| `type:fix` | turns, observations, segments | Matches a stored activity word. A turn's type is a list, so this matches a turn that carries the word among others. A segment's is the union of its members'. |
| `file:src/auth.ts` | turns, observations | Substring match against `files_read` + `files_modified`. |
| `tag:svg-filter` | sessions, turns, segments | Exact-match a stored tag; a segment's tags are its members', most frequent first. A **bare** tag is what the turn was about; a **prefixed** one (`compact:`, `invalidated:`, `delivery:`) is bookkeeping. The match is anchored to a whole tag, so `tag:svg` does NOT match `svg-filter`. |
| `project:/abs/path` | sessions, turns, observations | Exact match against `session.project`. |
| `session:S12` | sessions, turns, observations | Restrict a full-text search to one session. Accepts `S12` or bare `12`; a malformed id is ignored. |

Free words become an FTS query (terms OR'd, bm25-ranked) over indexed text. Use `session:` to scope that search to a single session — the one thing the `id` selector cannot combine with free text.

## View Guidance

| View | Use when |
|---|---|
| `collapsed` | Browsing and list navigation. |
| `expanded` | You have a specific target and need stored fields inline. |

There is no `full` view anymore.

## Common Patterns

**"Did we already fix the auth race?"**
```text
recall(query="auth race")
# → sees [S12/T3] "Fixed auth mutex"
recall(id="S12/T3", view="expanded")
```

**"Did we already try X, and why did it not work?"**
```text
recall(query="X")
# → sees [E47] "..." [delivered]
recall(id="E47")
# → the arc's conclusion and the routes it ruled out, without replaying its sessions
```

**"Show me the exact edit to login.ts last Thursday"**
```text
recall(query="file:src/login.ts", time="2026-04-03")
# → picks out [S8/T2]
recall(id="S8", view="expanded")
# → session shows raw: /Users/...jsonl
# → switch to mnemo-replay for exact transcript bytes
```

## Guidance

- Prefer `recall` for search, browsing, and structured answers.
- Before starting a task that may already have been done, look for its segment: `[delivered]` says it was finished, `[open]` says it is in flight and gives you its working state.
- Narrow with `id`, `query`, or `time` before raising `view`, `pageSize`, or `truncate`.
- Use `project:<path>` when the question is project-local.
- When `recall` shows a `raw:` path or a truncation hint, that is your signal to switch to `mnemo-replay`.
