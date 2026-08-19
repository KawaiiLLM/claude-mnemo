---
name: mnemo-recall
description: Search past sessions for the *why* behind this project's code — design rationale, rejected alternatives, decisions, and user corrections that source never records. Use when asked why something is designed the way it is, before reconstructing a rationale from code (which produces confident-but-wrong stories), or for prior work ("did we already do this?", "how did we fix X last time?"). For what the code does now, read the source first.
---

# Mnemo Recall

`recall` is the structured read index over past sessions. It returns a paginated
render from SQLite — session headers, turn titles, observation summaries, segment
cards — bounded by two token budgets rather than a fixed character truncation. For
exact prompts, full responses, full tool output, or raw transcript reconstruction,
switch to the `mnemo-replay` skill.

**Three axes of read access**:
- `recall` — content index: what happened, where, and what to inspect next
- `timeline` — temporal narrative: how a single session unfolded
- `mnemo-replay` skill — raw truth: direct SQLite and JSONL reads

**Rule of thumb**: start broad, then narrow. The default field set (`title` +
`content`) is the cheap browsing mode. Widen `filter.fields` and raise `turn` only
once you have a target. If a `recall` result is good enough, stop there.

## Memory Policy

- The injected SessionStart blocks are an index, not the memory — a fact absent
  from every injected block may still be one recall away. Never conclude
  "unrecorded" from "not injected".
- **Materialization rule**: when writing a durable artifact (spec, ticket, doc,
  summary) from earlier rulings, any detail you cannot quote verbatim —
  especially one from behind a compact boundary — must come from recall/replay
  of the ruling turns, never from summary memory. (Real loss: a ruling whose
  entire text was a bare "可以" — its meaning lived in the question it answered
  — was orphaned by compaction and silently dropped from the spec, while the
  settled record had retained it in self-contained form the whole time.)
- Recalled content is a point-in-time record: the current request, repository
  files, and tool outputs override it; when they conflict, say so rather than
  silently picking a side.
- Do not recall for generic questions, one-off content, or explanations durable
  memory cannot help.

Scene → entry point:

| Scene | Entry |
|---|---|
| Design rationale, "why is X like this" | `recall(query=...)`, narrow with `filter.time`/`filter.tag` |
| A ruling's exact wording, user-given examples | mnemo-replay skill on the ruling turns |
| Prior fix / error seen before | `recall(query=<error terms>)` |
| How a session or arc unfolded | timeline |
| Whether a task was already done | roster / `recall()` segments, `[delivered]` vs `[open]` |

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

A segment's own members can also be addressed by their in-segment chronological
position — `E47/T3` — but that ordinal is a **navigation handle only, never a
citation**: a member that settles into the segment later shifts every ordinal
after it. Cite the rendered `S<session>/T<prompt>` address instead; `E<n>/T<m>`
is only for picking a member out while you are looking at the card.

A turn marked **rewound** (`⤺ rewound (transcript pointer stale — do not trust
replay)`) had its branch undone — treat its content as an abandoned path, and do
not hand its transcript pointer to `mnemo-replay`: the pointer is a stale
coordinate once a turn has been rewound.

## Browse vs Search

`recall` has exactly two output shapes, selected by whether `query` is set:

- **Browse** (`id` and `query` both omitted): a global, chronological feed
  across every session — not one session's worth. A session's title renders
  only the first time its turns appear in the feed; later turns from the same
  session in the same page omit the repeated header. Segments list before
  sessions.
- **Search** (`query` set): results rank by relevance (bm25). Every matched
  term is **bolded**, with a word-boundary neighborhood shown around the hit
  instead of a fixed truncation window — you see the evidence, not an
  arbitrary slice.

`filter` narrows either shape the same way; it is not what selects between them.

## Progressive Workflow

### Step 1 — Browse or search

```text
recall()                                            # global chronological feed
recall(query="auth race")                           # full-text search, relevance-ranked
recall(query="cookie", filter={session: "S12"})      # full-text search within one session
recall(filter={type: "fix", file: "src/auth.ts"})    # structured scoping, no query
recall(filter={time: "-7d"})                         # last 7 days
```

**`query` is pure full-text search — it has no in-string dialect.** There is no
`type:`/`tag:`/`project:`/`session:` prefix inside the query string any more; a
query containing the literal text `tag:foo` searches those characters, it does
not scope by tag. This retirement fails **silently** — a stale `type:bugfix`
habit inside `query` will not error, it will just search for the substring
`"type:bugfix"` and likely match nothing. Use the structured `filter` object
below for every scoping need query prefixes used to cover.

These return a paginated feed by default. Use `page` to move through large result sets.

### Step 2 — Drill into a session

```text
recall(id="S12")                                          # session summary + turn preview + raw: pointer
recall(id="S12/T*")                                        # all turns in a session
recall(id="S12/T3..7")                                     # turn range
recall(id="S12", filter={fields: ["content", "insight"]})  # widen which turn fields render
```

`recall(id="S12")` always includes its turn preview and a `raw:` path pointing
at the source JSONL — there is no separate detail mode to opt into. `mnemo-replay`
reads a turn's full text and tool I/O straight from the database; that `raw:`
path is the hand-off only when you need exact bytes the database does not
mirror.

### Step 3 — Read the arc, not the session

```text
recall(id="E47")                                # one segment: body, insight, members
recall(id="E*")                                 # every segment
recall(id="E5..9")                              # segment range
recall(id="E31, E32")                           # multiple segments, one call
```

A segment row leads with its title, `[open]`/`[delivered]` status and member
count, then its conclusion and the member turns that carry it. Drill into a
member with the ordinary `S12/T3` form (not the segment's own `E47/T3`
ordinal — see Data Model above). Segments also come back from `query=`
search alongside sessions and turns, and `filter.tag`/`filter.type` apply to
them too.

### Step 4 — Turn detail and observations

```text
recall(id="S12/T3", filter={fields: ["prompt", "response", "files"]})   # widen the field set
recall(id="S12/T3/O*")                          # observations for one turn
recall(id="S12/T*/O*")                          # observations across the session
recall(id="O87")                                # one observation, every stored field
```

Observation content is always capped by the `turn` token budget — there is no
field-selection knob for observations the way there is for turns; raise `turn`
to see more of a tool call's input/output.

### Step 5 — Escalate only when needed

If a rendered field looks cut off, raise `turn` (the per-item token budget)
first:

```text
recall(id="S12/T3", filter={fields: ["prompt", "response"]}, turn=400)
```

If a whole page is cut short rather than one field, that is `pageBudget`
overflow — ask for the next `page` of the same call; overflow always produces
another page, it never silently drops content mid-block.

If the result still is not enough, or you need exact wording, the full response, or full tool output, switch to the `mnemo-replay` skill. There is no unlimited `recall` mode.

## `recall` Parameter Reference

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Selector. Supports wildcards (`*`), ranges (`5..10` — the second endpoint may repeat the kind letter, `T3..T7` ≡ `T3..7`), nested paths (`S12/T3/O*`), and a comma-separated list of same-kind addresses (`"E31, E32"`, `"S12, S15"`). |
| `query` | string | Pure full-text search — no in-string dialect. A literal `tag:foo` inside `query` searches those characters; it does not scope. Use `filter` instead. |
| `filter` | object | Structured scoping: `{type, tag, session, time, file, fields}`, AND-composed with each other, with `id`, and with `query`. See below. |
| `page` | number | 1-indexed page number for the target level. Default `1`. |
| `pageSize` | number | Item count for the target level page. Default `10`. |
| `pageBudget` | number | Token budget for a segment card (default `1000`). Overflow paginates — ask for the next `page`, never truncated silently. |
| `turn` | number | Per-item token cap on every rendered session/turn/observation block (default `150`, word-boundary cut). Raise it when `filter.fields` selects more fields than the default. |

Omit both `id` and `query` to get the global browse feed.

Child collections are always shown as a fixed preview with a `+N more` hint. To inspect more children, narrow the selector to that child level.

### Selector Grammar

| Form | Meaning |
|---|---|
| `S*` / `S12` / `S5..10` | Sessions |
| `S12/T*` / `S12/T3` / `S12/T3..7` (or `T3..T7`) | Turns in a session |
| `S12/T3/O*` | Observations for one turn |
| `S12/T*/O*` | Observations for an entire session |
| `O87` | Single observation (global DB id) |
| `T418` | Single turn (global DB id) |
| `E*` / `E47` / `E5..9` | Segments — one arc of work, not a session |
| `E47/T3` | One segment member, by in-segment ordinal (selection only — see Data Model) |

In the `S12/T3` form the turn id is a session-scoped prompt number. Bare `T418` is the global DB id; prefer the `S/T` form unless you already hold a DB id.

**Comma lists**: `id` accepts a comma-separated list of addresses, e.g.
`id="E31, E32"` or `id="S12, S15"` — every item must parse and every item must
be the **same address kind**; a mixed-kind list or any one invalid item rejects
the whole call rather than silently skipping the bad one. Items render in
order and share this call's `page`/`pageBudget`/`turn` budgets.

### `filter` — Structured Scoping

`filter` replaces the retired in-query prefix dialect. All five scoping members are AND-composed with each other, with `id`, and with `query`:

| Field | Applies to | Notes |
|---|---|---|
| `type` | turns, segments | Exact match against one stored `type` value. A turn's type is a list, so this matches a turn that carries the word among others. A segment's is the union of its members'. |
| `tag` | sessions, turns, segments | Exact match against one whole `tags` array element, either namespace (bare, or a legacy `topic:`-prefixed one) — a prefix does not partial-match, so `tag: "svg"` does NOT match `svg-filter`. |
| `session` | turns, observations | Scope to one session: `"S12"` or bare `"12"`/`12`. |
| `time` | turns | `-7d`/`-2w` (relative), `YYYY-MM-DD` (one UTC day), or `YYYY-MM-DD..YYYY-MM-DD` (inclusive UTC range). |
| `file` | turns, observations | Substring match against `files_read` + `files_modified`. |

`filter.fields` is a **display-only** sixth member — not a scoping criterion, so setting it alone does not switch bare `recall()` off the browse path:

| Field | Meaning |
|---|---|
| `fields` | Any combination of `title`, `content`, `prompt`, `response`, `insight`, `observations`, `files` — which turn fields to render. Default `title` + `content`. |

## Common Patterns

**"Did we already fix the auth race?"**
```text
recall(query="auth race")
# → sees [S12/T3] "Fixed auth mutex"
recall(id="S12/T3", filter={fields: ["prompt", "response"]})
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
recall(filter={file: "src/login.ts", time: "2026-04-03"})
# → picks out [S8/T2]
recall(id="S8")
# → session shows raw: /Users/...jsonl
# → switch to mnemo-replay for exact transcript bytes
```

## Guidance

- Prefer `recall` for search, browsing, and structured answers.
- Before starting a task that may already have been done, look for its segment: `[delivered]` says it was finished, `[open]` says it is in flight and gives you its working state.
- Narrow with `id`, `query`, or `filter` before raising `pageSize`, `pageBudget`, or `turn`.
- Never rely on prefixes inside `query` — they do not scope, and the failure is silent. Reach for `filter` instead.
- When `recall` shows a `raw:` path, or a page-overflow hint, that `raw:` path is your signal to switch to `mnemo-replay`; the overflow hint is your signal to ask for the next `page`.
- A `⤺ rewound` turn's transcript pointer is stale — do not hand it to `mnemo-replay`.
