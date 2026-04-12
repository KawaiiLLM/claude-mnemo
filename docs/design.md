# Claude-Mnemo Design Document

## Overview

Claude-Mnemo is a Claude Code plugin that gives Claude persistent, structured memory across sessions.

The current architecture has four core pieces:

1. **SQLite chronicle + knowledge store**
   - Chronicle: `sessions -> turns -> observations`
   - Knowledge: standalone `memories`
2. **Queue-backed worker runtime**
   - Hooks write durable work into `pending_queue`
   - A local worker drains that queue and runs the memory agent
3. **Isolated Mnemosyne query sessions**
   - The worker opens isolated Claude SDK sessions
   - Mnemosyne writes only through `remember` and reads through `recall`
4. **Structured + raw retrieval**
   - `recall` renders the SQLite memory tree
   - `mnemo-replay` skill points the main agent at raw Claude JSONL and SQLite when byte-accurate reads are needed

This is no longer the old “hook directly forks Mnemosyne” design. Extraction is now worker-driven, queue-backed, and crash-recoverable.

---

## Design Principles

1. **Durable queue before async work**
   - Hooks persist business rows and queue rows before returning.
   - HTTP wakeup is only a hint; the durable source of truth is SQLite.

2. **Chronicle first, knowledge second**
   - Turns and observations preserve what happened in a session.
   - Memories capture reusable durable knowledge derived from that chronicle.

3. **Raw transcript remains authoritative**
   - Full conversation history stays in Claude JSONL files.
   - `mnemo-replay` is the raw-history path.
   - `recall` is the structured-memory path.

4. **Single write tool**
   - `remember` is the only public write tool.
   - Legacy `save_turn` / `update_session` paths are gone.

5. **Minimal external surface**
   - SQLite + FTS5 + Bun only.
   - No Python, no vector DB, no external worker service.

---

## Runtime Architecture

### High-Level Flow

```text
UserPromptSubmit
  -> session-init
  -> upsert session
  -> insert active turn

PostToolUse
  -> insert observation(status='pending')
  -> enqueue pending_queue(kind='obs')
  -> POST /wake

Stop
  -> backfill assistant_response + promptId
  -> enqueue pending_queue(kind='turn-stop')
  -> POST /wake

PreCompact
  -> POST /compact
  -> worker synchronously drains that session
  -> pushes final session summary
  -> closes query session
```

### Worker Model

The worker is a local HTTP process started via:

```text
node plugin/scripts/bun-runner.js plugin/scripts/worker.cjs
```

Endpoints:

- `POST /wake`
  - fire-and-forget
  - triggers queue scanning
- `POST /compact`
  - synchronous flush for one session
  - used because compaction needs a strong “flush-before-continue” boundary
- `GET /health`
  - readiness probe

The worker keeps one in-memory `SessionState` per active session and serializes work per session via a promise chain. Different sessions may progress independently; the same session is strictly serialized.

### Mnemosyne Agent Session Storage

The worker runs Claude Agent SDK query sessions with `cwd = ~/.claude-mnemo` (`DATA_DIR`), not the user's real project path.

That causes the SDK to write Mnemosyne transcripts to a dedicated pseudo-project directory:

```text
~/.claude/projects/<encodeProjectPath(~/.claude-mnemo)>/<agent-session-id>.jsonl
```

On a typical macOS install this resolves to:

```text
~/.claude/projects/-Users-<username>-.claude-mnemo/<agent-session-id>.jsonl
```

This does not remove Mnemosyne from the `.claude/projects` tree entirely, but it does isolate all Mnemosyne transcripts into one dedicated directory so they no longer collide with real user project session directories.

The old post-write archive shuttle into `~/.claude-mnemo/sessions/` is gone. Query sessions now stay at the SDK-native path, which enables native SDK resume.

The worker persists the most recent agent session id in `sessions.last_agent_session_id`. On the next wake for that session, `ensureQuerySession()` best-effort resumes by:

1. Reading `last_agent_session_id` from SQLite
2. Checking whether the expected SDK jsonl file still exists at the `DATA_DIR`-based transcript path
3. Passing `resume: <agent-session-id>` only when that file is present

If the file is missing, the worker silently falls back to a fresh query session and overwrites the DB field when the next SDK session id is observed.

### Debugging With Agent Transcripts

The dedicated pseudo-project directory is also the first debugging surface for Mnemosyne behavior.

Each transcript file contains:

- every worker-pushed `<obs>`, `<turn>`, and standalone `<session>` block
- every `remember()` and `recall()` tool call with full input payloads
- any assistant free-text response
- SDK `queue-operation` records for input enqueue/dequeue timing

This is the authoritative record for questions like:

- did compact actually reach Mnemosyne?
- what exact prompt did an observation or turn-stop use?
- did Mnemosyne choose a status-only `remember()` update?
- was the worker session resumed or started fresh?

The README’s `Debugging Mnemosyne` section documents copy-paste `jq` queries for these investigations. The SDK-native jsonl path under `.claude/projects/<encodeProjectPath(~/.claude-mnemo)>/` is the canonical location.

### Queue Semantics

`pending_queue` is the durable FIFO for async work:

```sql
CREATE TABLE pending_queue (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,              -- 'obs' | 'turn-stop'
  target_id INTEGER NOT NULL,
  session_db_id INTEGER NOT NULL,
  claimed_at_epoch INTEGER,
  enqueued_at_epoch INTEGER NOT NULL
);
```

Key properties:

- `seq` is the global queue order
- queue rows are persisted in the same transaction as hook writes
- worker claim is atomic
- crash recovery resets `claimed_at_epoch` and rescans from SQLite

This is the durable boundary that replaced the old “turn.status = pending/stale/extracting” queue semantics.

---

## Data Model

### Chronicle + Knowledge Hierarchy

```text
Session
  └─ Turn
       └─ Observation

Memory
```

### Current Schema

```sql
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_session_id TEXT UNIQUE NOT NULL,
  project TEXT NOT NULL,
  title TEXT,
  content TEXT,
  insight TEXT,
  next_steps TEXT,
  last_compact_turn INTEGER,
  last_agent_session_id TEXT,
  created_at_epoch INTEGER NOT NULL,
  updated_at_epoch INTEGER,
  completed_at_epoch INTEGER
);

CREATE TABLE turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  prompt_number INTEGER NOT NULL,
  content_prompt_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  user_prompt TEXT,
  assistant_response TEXT,
  title TEXT,
  content TEXT,
  insight TEXT,
  type TEXT,
  tags TEXT,
  files_read TEXT,
  files_modified TEXT,
  tool_call_count INTEGER,
  created_at_epoch INTEGER NOT NULL,
  updated_at_epoch INTEGER,
  UNIQUE(session_id, prompt_number)
);

CREATE TABLE observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  tool_name TEXT,
  tool_input TEXT,
  tool_result TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  title TEXT,
  content TEXT,
  created_at_epoch INTEGER NOT NULL
);

CREATE TABLE memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  scope TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  reasoning TEXT,
  application TEXT,
  tags TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  superseded_by INTEGER REFERENCES memories(id),
  expires_at_epoch INTEGER,
  source_turn_id INTEGER REFERENCES turns(id),
  created_at_epoch INTEGER NOT NULL,
  updated_at_epoch INTEGER
);
```

### Business Statuses

Turns keep business state only:

- `active`
- `extracted`
- `skipped`
- `undone`

Observations keep business state only:

- `pending`
- `extracted`
- `skipped`

Queue/processing state is not stored in business tables anymore. It lives in `pending_queue`.

### Compact Anchor

`sessions.last_compact_turn` is the durable compact anchor.

It is used to trim old finalized turns from Mnemosyne extraction context after a compact drain. The anchor advances after `drainSessionCompletely()` finalizes queued work, even if the subsequent session-summary prompt fails.

### Legacy Schema Policy

Current implementation follows the reset policy:

- detect legacy schemas
- `DROP TABLE` old runtime tables
- recreate current schema

There is no longer an in-place compatibility migration path for old `description` / old observation columns.

---

## Search and Indexing

Claude-Mnemo uses a single FTS5 table:

```sql
CREATE VIRTUAL TABLE memory_fts USING fts5(
  layer,
  source_id,
  title,
  content,
  extra
);
```

Indexed fields:

- `sessions`: `title`, `content`, `insight`
- `turns`: `title`, `content`, `insight`
- `observations`: `title`, `content`
- `memories`: `title`, `content`, `reasoning`, `application`, `tags`

Observations are indexed only when their status becomes `extracted`.

---

## Public Tool Surface

### Tool surface

Claude-Mnemo exposes **three structured MCP tools** plus a raw-access skill:

1. **`remember`** — the single routed write tool.
2. **`recall`** — the semantic content index. Paginated (`page` + `pageSize`), truncated (`truncate`), depth-controlled (`collapsed` / `expanded`).
3. **`timeline`** — the temporal shape renderer. Single-session; range-based pagination with a 30-turn hard cap. No depth, no `pageSize`.
4. **`mnemo-replay` skill** — not a tool; a skill that points agents at the raw JSONL transcript and the SQLite database for byte-accurate reads.

**Three read axes** map cleanly:

| Axis | Surface | Answers |
|---|---|---|
| Content | `recall` | What is this session about? |
| Temporal | `timeline` | How did this session unfold over time? |
| Raw | `mnemo-replay` skill | What were the exact transcript bytes and raw tool payloads? |

Mnemosyne's extraction agent sees only `remember` + `recall`.

### `recall`

Public input:

```ts
{
  id?: string;
  query?: string;
  time?: string;
  depth?: "collapsed" | "expanded";
  page?: number;
  pageSize?: number;
  truncate?: number;
}
```

Examples:

```text
recall()
recall(query="auth mutex")
recall(id="S12")
recall(id="S12/T3")
recall(id="S12/T*")
recall(id="S12/T*/O*")
recall(id="O7")
recall(id="M4")
```

Semantics:

- `id` is the structured selector path
- `query` is FTS-backed search
- `time` is day-level filtering
- `depth` is `collapsed` or `expanded`
- `page` / `pageSize` paginate the target level
- `truncate` caps field rendering uniformly

When exact wording or full tool output matters, `recall` hands off to the `mnemo-replay` skill via the expanded session `raw:` path.

### `remember`

`remember` is the single routed write tool:

```text
remember({ id: "O7", title, content })
remember({ id: "O7", status: "skipped" })
remember({ id: "T3", title, content, insight, type, tags })
remember({ id: "T3", status: "skipped" })
remember({ id: "T3", status: "undone" })
remember({ id: "S12", title, content, insight, next_steps })
remember({ type: "feedback", scope: "global", title, content })
remember({ id: "M4", status: "archived" })
```

There is no public `save_turn` / `update_session` anymore.

---

## Mnemosyne Runtime

### Current Role

Mnemosyne is still the memory agent, but it is now worker-managed instead of hook-forked directly.

The worker opens isolated Claude SDK query sessions and injects an in-process SDK MCP server exposing:

- `remember`
- `recall`

Allowed tools are restricted to those two.

### Observation Processing

`PostToolUse` writes an observation row with raw tool payload:

- `tool_name`
- `tool_input`
- `tool_result`
- `status='pending'`

The worker then sends either:

- an initial observation prompt with `<prior_session>` and the session’s first user request
- or a simple follow-up observation prompt

Mnemosyne is instructed to either:

- `remember({ id: "O{id}", title, content })`
- or `remember({ id: "O{id}", status: "skipped" })`

### Turn-Stop Processing

When a turn ends, `Stop` backfills:

- `assistant_response`
- `tool_call_count`
- `content_prompt_id`

Then it enqueues a `turn-stop` queue item.

The worker later aggregates observation-derived file paths and asks Mnemosyne to:

- extract the turn with `remember({ id: "T{id}", ... })`
- optionally refresh the session summary with `remember({ id: "S{id}", ... })`
- or skip the turn with `remember({ id: "T{id}", status: "skipped" })`

### Session Summary Flush

`/compact` is synchronous. The worker:

1. drains all queued work for that session
2. pushes a final summary-refresh prompt
3. updates the compact anchor
4. closes the query session

That synchronous boundary is intentional so the next compacted/resumed session sees fresh session summary state.

### Query Session Lifecycle

Worker query sessions have two idle protections:

- stalled in-flight request timeout: 30s
- idle session close: 30 minutes

The worker process itself also self-terminates after 30 minutes without HTTP traffic.

---

## Hook Lifecycle

### Current Hook Responsibilities

| Hook | Responsibility |
|------|----------------|
| `SessionStart` | inject structured context only |
| `UserPromptSubmit` | upsert session + insert active turn |
| `PostToolUse` | persist observation + enqueue queue row + `/wake` |
| `Stop` | backfill current turn + enqueue `turn-stop` + `/wake` |
| `PreCompact` | synchronously flush one session through `/compact` |

This is the current separation:

- hooks persist and enqueue
- worker drains and runs Mnemosyne

### SessionStart Context

`SessionStart` does not call any LLM.

It injects:

- a small header with counts and format help
- current session summary
- recent sessions
- relevant memories

It renders through the same shared formatting layer used by `recall`.

---

## Transcript Parsing

### Current Transcript Assumptions

Claude JSONL entries are normalized from real Claude Code transcript shape:

- `message.role`
- `message.content`
- `promptId`
- `permissionMode`
- `isSidechain`
- `isApiErrorMessage`
- `uuid`

### Resume Replay Deduplication

Claude Code `--resume` / `--continue` may append prior transcript entries again.

Current parser behavior:

1. normalize raw JSONL entries
2. filter `isApiErrorMessage`
3. deduplicate by `uuid`
4. filter derived/system-injected user entries
5. use `promptId` change as turn boundary

This fixes two separate issues:

- **Problem 1:** resume replay duplicates entire entry sequences
- **Problem 2:** slash-command / hook-derived user entries share or fragment turn boundaries

Derived entries currently filtered by prompt text prefix include:

- `<task-notification>`
- `<local-command-...>`
- `<command-name>`
- `<command-args>`
- `<command-message>`
- `⏺ Ran ...`

### Replay vs Normal Parse

- `parseTranscript()` filters sidechain entries
- `parseReplayTranscript()` keeps sidechain entries

That distinction is intentional:

- backfill wants current turn view
- replay wants raw historical sequence

### Prompt Number Alignment

`session-init` computes prompt numbers from transcript parsing:

```ts
countUserPromptsInTranscript(transcriptPath) + 1
```

That count follows replay semantics:

- includes real sidechain turns
- excludes API-error entries
- excludes derived/system-injected user entries
- excludes resume-appended duplicates via `uuid`

`content_prompt_id` is also backfilled onto turns and used by replay/undo alignment when prompt numbering drifts.

---

## Display and Rendering

Current rendering is unified across:

- `recall`
- SessionStart context
- `timeline`

The shared renderer produces:

- collapsed node shells
- expanded node bodies
- grouped search results
- consistent truncation hints that hand off to `mnemo-replay` for raw reads

Current rendering rules:

- `depth` is only `collapsed` or `expanded`
- `page` / `pageSize` paginate the target level
- child collections use a fixed 5-item preview with a `+N more` marker
- `truncate` is a single global cap per rendered field (default 200, max 2000)
- there is no `depth="full"` path and no hidden `limit` sampling mode

Observation identity is global:

- `O7` is the stable detail id
- `S1/T2/O*` is only a parent-scoped list selector

#### Timeline rendering

Timeline uses its own renderer in `src/mcp/timeline.ts`, not the shared `format.ts` `renderNode` path. The output shape is a 6-line session header, a two-column turn table, a phases block, and a shape-signals block, so it does not fit the hierarchical renderer used by recall.

Timeline's turn table has two label columns: `prompt` (200 chars, cleaned raw user prompt) and `title` (40 chars, `<type_emoji> <Mnemosyne title>`). The split is intentional: the prompt column preserves the user's ask, while the title column shows Mnemosyne's compressed turn summary.

`TYPE_EMOJI` in `src/mcp/format.ts` is still mirrored by a local `TYPE_EMOJI_MAP` copy inside timeline. The shared export is not wired into the timeline renderer yet.

---

## Privacy and Tag Stripping

- `<private>...</private>` content is stripped from memory-facing paths
- injected context may be wrapped to avoid memory recursion
- assistant text normalization strips `<system-reminder>`

---

## Differences From Earlier Claude-Mnemo Designs

The implementation has moved away from several earlier ideas:

- no direct hook-time Mnemosyne fork path
- no `save_turn` / `update_session` public write API
- no hook-side pending/stale/extracting status queue on turns
- no old observation narrative/facts/concepts schema
- no in-place legacy schema migration

The current system is instead:

- queue-backed
- worker-driven
- `remember`-only for writes
- transcript-deduped by `uuid`
- reset-on-legacy-schema rather than migrate-in-place

---

## Current Tradeoffs

1. **Legacy DB reset**
   - Simpler and safer than supporting many historical column layouts
   - But old incompatible local data is dropped on schema reset

2. **Queue-backed async extraction**
   - Stronger crash recovery and lower hook latency
   - But adds a local worker process and queue bookkeeping

3. **Transcript parser as single source of truth**
   - Fixes resume replay centrally
   - But correctness now depends heavily on Claude transcript shape assumptions

4. **Unified rendering**
   - Consistent output between `recall`, hook context, and future read surfaces
   - But selector semantics are stricter than older compatibility forms
