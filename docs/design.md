# Claude-Mnemo Design Document

## Overview

Claude-Mnemo is a Claude Code plugin that gives Claude persistent, structured memory across sessions. After each conversation, a forked agent named **Mnemosyne** reviews the dialogue and extracts memories into a 3-layer data model. Future sessions retrieve these memories via two MCP tools: `recall` (structured memory tree) and `replay` (raw transcript playback).

### Design Principles

1. **Memory is refined, anchored by raw previews.** The database stores extracted insights (title, description, insight, narrative) plus raw `user_prompt` / `assistant_response` per turn for anchoring and preview. Full transcripts live in session `.jsonl` files and are accessible via `replay`.
2. **Progressive disclosure.** Memory is organized as a tree (session → turn → observation) that can be expanded on demand. Each level provides just enough to decide whether to drill deeper.
3. **Cache-preserving extraction.** Mnemosyne inherits the main agent's full tool set to maximize prompt cache hits from `forkSession`. Tool constraints are enforced via prompt, not `disallowedTools`.
4. **Separation of concerns.** UserPromptSubmit only inserts pending turns. Stop reconciles (backfill, undo detection) and extracts via Mnemosyne. PreCompact provides a safety net before context compression. SessionStart only injects context (no LLM calls). Each hook has one clear responsibility.
5. **Zero external dependencies.** No vector DB, no Python, no HTTP Worker. SQLite + FTS5 + Bun only.

---

## Data Model

### 3-Layer Hierarchy

```
Session (one per Claude Code conversation)
  └─ Turn (one per QA round — user prompt + agent response)
       └─ Observation (one per notable tool call or event within a turn)
```

### Schema

```sql
CREATE TABLE sessions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  content_session_id  TEXT UNIQUE NOT NULL,  -- Claude Code session UUID → JSONL filename
  project             TEXT NOT NULL,
  title               TEXT,                  -- 10-20 chars: what this session was about
  description         TEXT,                  -- 30-60 chars: what was accomplished
  insight             TEXT,                  -- markdown list: cross-turn learnings
  started_at_epoch    INTEGER NOT NULL,
  updated_at_epoch    INTEGER,               -- set on resume/re-extraction
  completed_at_epoch  INTEGER
);

CREATE TABLE turns (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id          INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  prompt_number       INTEGER NOT NULL,      -- Nth user prompt in this session
  status              TEXT NOT NULL DEFAULT 'pending',
    -- pending:   known but not yet extracted
    -- extracted: memory extracted successfully
    -- skipped:   evaluated, deemed not worth recording
    -- stale:     extracted but user undid changes, needs re-evaluation
  user_prompt         TEXT,                  -- full user prompt text, stored at turn creation
  assistant_response  TEXT,                  -- full assistant response text, stored by hook via JSONL parsing
  title               TEXT,                  -- 10-25 chars
  description         TEXT,                  -- 40-80 chars
  insight             TEXT,                  -- markdown list
  files_read          TEXT,                  -- JSON array
  files_modified      TEXT,                  -- JSON array
  created_at_epoch    INTEGER NOT NULL,
  updated_at_epoch    INTEGER,
  UNIQUE(session_id, prompt_number)
);

CREATE TABLE observations (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id             INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  type                TEXT NOT NULL,         -- bugfix|feature|refactor|change|discovery|decision
  title               TEXT NOT NULL,         -- 10-20 chars
  description         TEXT,                  -- 15-30 chars
  narrative           TEXT,                  -- 50-150 chars: full context (most valuable for search)
  facts               TEXT,                  -- JSON array of concise statements
  concepts            TEXT,                  -- JSON array: how-it-works|why-it-exists|what-changed|problem-solution|gotcha|pattern|trade-off
  files_read          TEXT,                  -- JSON array
  files_modified      TEXT,                  -- JSON array
  created_at_epoch    INTEGER NOT NULL
);
```

### Field Length Guidelines

Derived from real Claude Code session data (~2,600 chars/turn average, ~5% compression ratio):

| Layer | title | description | insight | narrative |
|-------|-------|-------------|---------|-----------|
| Session | 10-20 chars | 30-60 chars | 3-5 bullet points | — |
| Turn | 10-25 chars | 40-80 chars | 2-4 bullet points | — |
| Observation | 10-20 chars | 15-30 chars | — | 50-150 chars |

### Status Transitions

```
pending ──→ extracted    (save_turn with content)
pending ──→ skipped      (save_turn with empty fields)
extracted ─→ stale       (undo detected, transient)
skipped ──→ stale        (undo detected, transient)
stale ────→ extracted    (Mnemosyne re-evaluated: still valid)
stale ────→ skipped      (Mnemosyne re-evaluated: still not worth recording)
stale ────→ undone       (Mnemosyne confirmed: undone historical branch)
```

`stale` is a transient queue state (like `pending`) — it only appears after undo detection and must be resolved by Mnemosyne. `undone` is a stable archive state — the turn was part of an undone branch but is preserved for history. Undone turns retain their `promptNumber` and remain in the DB, ensuring DB numbering always matches the JSONL transcript sequence (which includes sidechain entries).

### Raw Data Fields

`user_prompt` and `assistant_response` store the original conversation text per turn. They are populated by the hook layer (not Mnemosyne) via JSONL parsing:

| Field | Source | Timing |
|-------|--------|--------|
| `user_prompt` | Hook stdin `prompt` field | session-init creates turn |
| `assistant_response` | Parsed from `transcript_path` JSONL | Stop/PreCompact backfill from JSONL; Stop uses `last_assistant_message` for final turn |

These fields serve two purposes:
1. **Anchor for Mnemosyne** — extraction status includes prompt preview so Mnemosyne can match turns to conversation context
2. **Preview in recall** — turn display includes truncated prompt/response, full content via `replay`

### ID Mapping to Raw Data

```
sessions.content_session_id  →  ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl
turns.prompt_number          →  Nth user message in the JSONL file
```

The JSONL file is immutable after session end. Memories are permanent; raw data is ephemeral.

---

## Search

### FTS5 Unified Index

A single FTS5 virtual table indexes all three layers:

```sql
CREATE VIRTUAL TABLE memory_fts USING fts5(
  layer,          -- 'session' | 'turn' | 'observation'
  source_id,      -- original table id
  title,
  description,
  extra           -- session/turn: insight; observation: narrative+facts+concepts
);
```

FTS indexing is integrated into `saveTurn()` and `upsertSession()` — atomic with the data write, not a separate sync step.

### Search Modes

| Mode | Query | Backend |
|------|-------|---------|
| Browse | `recall()` | `SELECT FROM sessions ORDER BY started_at_epoch DESC` |
| Keyword search | `recall(query="auth竞态")` | `FTS5 MATCH` across all layers |
| Filter | `recall(type="bugfix")`, `recall(file="auth.ts")` | SQL WHERE + LIKE |
| Date range | `recall(from="2026-04-01", to="2026-04-05")` | SQL WHERE on epoch |
| Cross-session timeline | `recall(around="S142", before=3, after=3)` | SQL offset from anchor epoch |

No vector DB. No Chroma. No Python dependency.

---

## MCP Tools

Four tools exposed via a single MCP server (stdio transport):

### Read Tools (used by main agent and Mnemosyne)

**`recall`** — Progressive memory tree

```
recall()                                    → recent sessions
recall(query="auth竞态")                    → FTS5 search
recall(session=142)                         → turns in session
recall(session=142, turn=3)                 → observations in turn 3
recall(observation=7)                       → full detail
recall(session=142, expand_turns=[1,3])     → tree expansion
recall(around="2026-04-03", before=3)       → cross-session timeline
recall(type="bugfix", file="auth.ts")       → filters
```

Output format — indented tags, optimized for LLM consumption:

```
[S142] auth中间件重构 | 04-05 14:30 | claude-mem
  description: 修复竞态+补测试
  insight:
  - forkSession可复用完整上下文
  - 记忆粒度应提升到per-QA-turn

  [T1] 诊断401错误 | 3 obs
    prompt: "Why am I getting 401 errors on the /api/auth endp..."
    response: "I found the issue - there's a race condition in ref..."
    description: 发现refreshToken竞态
    insight:
    - 并发请求互相覆盖token
    files: [R] auth.ts, config.ts
    [O1] bugfix: refreshToken竞态 — auth.ts:42缺少锁
    [O2] discovery: 并发请求触发多次刷新 — Promise.all场景复现

  [T2] 修复竞态条件 | 4 obs
    prompt: "Fix the race condition in auth..."
    response: "I've added a mutex lock to prevent concurrent token..."
    description: 加mutex+重试逻辑
```

**`replay`** — Raw transcript playback

```
replay(session=142)                → turn overview (includes undone turns marked [undone])
replay(session=142, turn=3)        → full QA transcript for turn 3
replay(session=142, turn=3, tool=2) → single tool call detail
replay(session=142, turn=3, full=true) → no truncation on tool_result
```

Replay includes sidechain (undo'd) entries from the JSONL — it does NOT filter `isSidechain`. This ensures `promptNumber` in the replay output always matches the DB's `promptNumber`. The `[undone]` marker is determined by the DB turn's `status` field (not by `isSidechain` in the JSONL — a sidechain entry may still be re-extracted as valid). This is intentional: replay is raw transcript playback, and undo history is part of that record.

### Write Tools (used by Mnemosyne only)

**`save_turn`** — Write or skip one turn

```
// Extract memory
save_turn({ session_id: 1, prompt_number: 3, title: "补充单测",
            description: "覆盖并发场景", insight: "- 10并发稳定通过",
            observations: [{ type: "feature", title: "并发测试",
              description: "...", narrative: "...", facts: [...],
              concepts: [...], files_read: [...], files_modified: [...] }] })

// Skip (empty fields → status='skipped')
save_turn({ session_id: 1, prompt_number: 4 })

// Mark undone (explicit status, no content)
save_turn({ session_id: 1, prompt_number: 2, status: "undone" })
```

**`update_session`** — Update session-level summary

```
update_session({ session_id: 1, title: "auth中间件重构",
                 description: "修复竞态+补测试",
                 insight: "- mutex是并发安全的关键\n- forkSession可复用上下文" })
```

---

## Mnemosyne: The Memory Agent

### Identity

Mnemosyne (Μνημοσύνη) — the Greek goddess of memory. She reviews completed conversations and decides what is worth remembering.

### Invocation

Mnemosyne is a Claude Code subprocess created via `forkSession`:

```typescript
query({
  prompt: mnemosynePrompt,
  options: {
    resume: sessionId,
    forkSession: true,  // inherits full context, writes to separate .jsonl
    cwd: projectCwd,
    maxTurns: 15,
  }
  // NO disallowedTools — same tool set as main agent → cache hit
})
```

### Why No `disallowedTools`

Prompt cache key = `hash(tools + system + messages_prefix)`. Tools are at the TOP of the cache hierarchy. Removing any tool changes the hash and invalidates ALL cached layers.

For a 20-turn session (~50k tokens), cache miss costs ~$0.75 per fork. By keeping the tool set identical and constraining via prompt, forkSession gets the full conversation context essentially free.

### Hook Re-entry Prevention

The `forkSession` subprocess is a full `claude` CLI process that loads plugins and hooks. Without guards, Mnemosyne's prompt submission would trigger `UserPromptSubmit` → `session-init` → infinite recursion.

**Solution**: Multi-layer isolation (borrowing from claude-mem's proven approach):

1. **Environment isolation** (`mnemosyne/env.ts`):
   - Strip `CLAUDECODE` env var (prevents "cannot launch inside another Claude Code session" error)
   - Set `CLAUDE_CODE_ENTRYPOINT=sdk-ts` (marks process as SDK-originated)

2. **Hook dispatcher guard** (`hook-command.ts` entry point):
   ```typescript
   if (process.env.CLAUDE_CODE_ENTRYPOINT === 'sdk-ts') {
     process.exit(0); // SDK subprocess — skip all hook processing
   }
   ```

3. **Tool set preservation**: `settingSources` is passed to load the same plugins/MCP servers (identical tool set → cache hit), but hooks are short-circuited by the guard above.

This gives both cache hits (same tools) and re-entry safety (hooks exit immediately).

### Prompt Design

English, following claude-mem's observer pattern:

```
You are Mnemosyne, the memory guardian for Claude Code.
You have just inherited the full context of a conversation.
You are NOT the agent who did the work — you are observing and recording.

EXTRACTION STATUS
-----------------
#1 [extracted]: "Why am I getting 401 errors on..."
#2 [stale]: "Fix the race condition in auth..."
#3 [pending]: "Add unit tests for the mutex..."

Rules:
- Process [pending] and [stale] turns — match by prompt preview above
- Skip [extracted], [skipped], and [undone] turns
- For [stale] turns: determine if it was undone (sidechain branch) or still valid
  - If undone: call save_turn with explicit status: "undone" (no title/description/observations)
  - If still valid: re-extract normally with updated content
- Use save_turn() to record, skip, or mark undone each turn
- Call update_session() if the session summary needs updating
  (new topic, significant progress, or session ending)
- If context was compacted, use replay() to recover detail
- Do NOT use Read, Write, Edit, Bash
- Never record content inside <private>...</private> tags
```

Status summary is injected by the hook from a DB query (~100 tokens), not from a `recall` call. Each turn's `user_prompt` prefix (first ~80 chars) serves as an anchor so Mnemosyne can locate the corresponding turn in the inherited conversation context, rather than relying on counting user messages.

### When to Call `update_session`

Mnemosyne decides whether to call `update_session()` based on context, not a fixed rule:

| Trigger | update_session? |
|---------|----------------|
| Stop hook (session ending) | Almost always — final summary |
| Mid-session, topic shifted | Yes — keep summary current |
| Mid-session, same topic continues | Optional — minor progress update |
| All pending turns skipped | No — nothing new to summarize |

Cost is ~150 tokens per call. Giving the agent judgment avoids both stale summaries (never updating mid-session) and wasted calls (always updating even when nothing changed).

### Token Budget

```
Input:  ~free (forkSession prompt cache hit on full conversation)
        + ~150 tokens (status prompt with prompt previews)
Output: ~200 tokens per turn (save_turn tool call)
        + ~150 tokens (update_session, when called)
Total:  ~750-950 tokens output for a 4-turn session
```

---

## Hook Lifecycle

### Events and Handlers

| Hook Event | Matcher | Handler | Timeout | Purpose |
|------------|---------|---------|---------|---------|
| PreCompact | `manual\|auto` | `compact` | 30s | Extract pending turns BEFORE context compression |
| SessionStart | `startup\|resume\|clear\|compact` | `context` | 10s | Inject recent memories (no extraction, no LLM calls) |
| UserPromptSubmit | `*` | `session-init` | 10s | Upsert session + insert pending turn (no extraction) |
| Stop | `*` | `stop` | 120s | Backfill all turns + undo detection + await Mnemosyne extraction |

`StopFailure` is intentionally not handled — failed turns stay `pending` and are recovered at the next session's Stop.

`SessionEnd` is intentionally not handled — at session end the prompt cache is cold, making Mnemosyne forks expensive (~$0.75 per fork for a 50k token session). Stop already handles extraction at session end. If Stop didn't fire (crash/force-quit), pending turns are recovered at the next session's Stop.

Note: `PreCompact` fires **before** compaction (with `trigger: "manual"|"auto"`), unlike `SessionStart[compact]` which fires after. Known bug: `transcript_path` may be empty in PreCompact (Issue #13668) — fallback to constructing path from `session_id`.

SessionStart does NOT trigger Mnemosyne or any LLM API calls — at startup there is no prompt cache, and the user may just be browsing. Orphaned pending turns from prior crashed sessions are handled when the session ends normally via Stop.

### Extraction Timeline

**Principle**: UserPromptSubmit only inserts. Stop reconciles and extracts. PreCompact is a safety net for long sessions. Orphaned pending turns from crashes are recovered at the next session's Stop.

```
User prompt #1  → session-init: create session, insert turn #1 (pending, user_prompt from stdin)
  Agent works...
User prompt #2  → session-init: insert turn #2 (pending, user_prompt from stdin)
  Agent works...
User prompt #3  → session-init: insert turn #3 (pending, user_prompt from stdin)
  Agent works...
PreCompact      → compact handler: backfill assistant_response for all pending turns from JSONL
                   fork Mnemosyne for pending turns (before context compressed)
  Agent works (compacted context)...
User prompt #4  → session-init: insert turn #4 (pending, user_prompt from stdin)
  Agent works...
User exits      → stop handler: backfill all pending turns' assistant_response
                   detect undos → mark stale
                   await Mnemosyne (extract pending/stale + update_session)
```

This means extraction is batched to PreCompact and Stop, not incremental per-turn. For typical sessions (3-8 turns), Stop handles everything. For long sessions that hit compaction, PreCompact prevents data loss before context is compressed.

### Prompt Number Tracking

Claude Code does not provide `prompt_number` in hook stdin. We track it by counting existing turns per session:

```sql
SELECT COUNT(*) + 1 FROM turns WHERE session_id = ?
```

### Undo Detection and Stale Marking

When the Stop hook fires, it compares the current conversation state against extracted turns. If a user undid changes from a previously extracted turn, the stop handler marks those turns as `stale` before forking Mnemosyne:

```sql
-- Stop handler: mark turns stale if their assistant_response changed
UPDATE turns SET status = 'stale', updated_at_epoch = ?
WHERE session_id = ? AND status IN ('extracted', 'skipped')
  AND prompt_number IN (/* turns whose context changed due to undo */)
```

`stale` is a **transient** queue state — Mnemosyne must resolve every stale turn to one of:
- `extracted` — re-evaluated, turn is still valid with updated content
- `skipped` — re-evaluated, still not worth recording
- `undone` — confirmed as an undone historical branch

Mnemosyne makes this judgment by examining the inherited conversation context. If the turn's prompt is part of a sidechain (undo'd branch), it calls `save_turn` with `status: "undone"`. Undone turns are preserved in the DB with their original `promptNumber`, maintaining alignment with the JSONL transcript sequence.

### Re-extraction Semantics

When `save_turn` is called for a `stale` or already-`extracted` turn, it performs a **replace** (not append):

1. DELETE existing observations for the turn
2. DELETE existing FTS rows for the turn and its observations
3. INSERT new observations (if status is `extracted`)
4. INSERT new FTS rows (if status is `extracted`)
5. UPDATE turn fields (title, description, insight, status)

All within a single transaction. This prevents duplicate observations and stale search results.

When the resulting status is `undone`, steps 3-4 are skipped — the turn has no observations and is excluded from FTS. The turn row is retained with its original `promptNumber` to preserve DB↔JSONL alignment.

### Edge Cases

#### Interrupted / Partial Response

If the user interrupts Claude before it responds (or mid-response), the JSONL may contain no assistant entry or a partial one for that turn. The transcript parser returns an empty string when no matching assistant entry is found — never throws. `assistant_response` is stored as empty or partial.

Mnemosyne handles this via its skip guidance ("Aborted work with no outcome"). For partial responses where some tool calls completed, Mnemosyne may still extract useful observations from the partial context.

#### StopFailure (API Error)

When Claude encounters an API error, `StopFailure` fires instead of `Stop`. We do NOT add a `StopFailure` handler — the failed turn stays `pending` and is recovered at the next session's Stop. This avoids duplicating Stop logic for a rare case.

#### /clear Mid-Session

`/clear` resets the conversation context. `SessionStart[clear]` fires the context handler, which injects recent memories. Pending turns from before the clear lose their conversation context in the fork, but Mnemosyne can call `replay()` to recover the original transcript from the JSONL file (which is unaffected by clear).

#### Fork Failure (Timeout / Error)

Mnemosyne forks (at PreCompact or Stop) may fail silently (network error, timeout, MCP server crash). The affected turn stays `pending`. It will be retried at:
- `PreCompact` (extracts all pending turns before compression)
- `Stop` (extracts all remaining turns at session end)

If both fail (session crashes without Stop firing), pending turns are carried over to the next session and processed at the next Stop. No turn is permanently lost — at worst, extraction is delayed to the next session's end.

#### Concurrent Mnemosyne Forks

Fire-and-forget extraction means two forks could run simultaneously (e.g., rapid prompts where the first fork hasn't finished when the second fires). SQLite WAL mode + `busy_timeout=5000ms` handles write contention. Each fork operates on different turns (different `prompt_number`), so there is no logical conflict — only potential lock waiting.

---

## Display Format

### Design Rationale

Compared alternatives for LLM-readable output:

| Format | Token cost | LLM readability |
|--------|-----------|-----------------|
| JSON | ~450 tokens | Verbose (braces, quotes, commas) |
| YAML | ~320 tokens | Medium (repeated keys) |
| Tree decorators (├─└─) | ~280 tokens | Multi-byte Unicode waste |
| **Indented tags** | **~250 tokens** | **Best: clear hierarchy, self-describing** |

### Indented Tag Format

Hierarchy encoded by indentation depth:
- 0 indent = session
- 2 indent = turn
- 4 indent = observation
- 6 indent = observation detail

Each node has a consistent pattern:
- **Collapsed**: one-line with `[ID] title | metadata`
- **Expanded**: multi-line with `key: value` fields + child nodes

IDs (`[S142]`, `[T3]`, `[O7]`) are directly referenceable in follow-up tool calls. Turn references are session-scoped prompt numbers, so turn detail uses `recall(session=142, turn=3)`.

### Token Budget for Typical Retrieval

```
recall(session=142, expand_turns=[1,3], expand_observations=[2])

Session header                ~15 tokens
  description + insight       ~60 tokens
  Turn 1 expanded (3 obs)     ~90 tokens
    Observation 2 expanded    ~100 tokens
  Turn 2 collapsed            ~15 tokens
  Turn 3 expanded (2 obs)     ~70 tokens
                              ─────────
                        Total ~350 tokens

vs. raw conversation: ~15,000 tokens → 97% compression
```

---

## Transcript Parsing

### JSONL File Format

Each Claude Code session is recorded as a JSONL file at `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`. Every line is a JSON object with a `type` field:

| type | Content |
|------|---------|
| `user` | `message.content` = string or ContentItem[] |
| `assistant` | `message.content` = ContentItem[] (text, thinking, tool_use blocks) |
| `tool_result` | `toolUseResult` with tool output |
| `system` | System messages, including `compact_boundary` |
| `summary` | Compact-generated summary (synthetic, not real conversation) |

### Assistant Response Extraction

Extract only `text` blocks from assistant message content, matching claude-mem's approach:

```typescript
entry.message.content
  .filter(block => block.type === 'text')   // skip thinking, tool_use, image
  .map(block => block.text)
  .join('\n')
  .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
  .replace(/\n{3,}/g, '\n\n')
  .trim();
```

### Data Sources by Hook

| Hook | `user_prompt` source | `assistant_response` source |
|------|---------------------|---------------------------|
| UserPromptSubmit | stdin `prompt` field (current turn) | — (insert only, no backfill) |
| PreCompact | Already in DB | Parse JSONL backwards for current turn (note: `transcript_path` may be empty — fallback to constructed path) |
| Stop | Already in DB | stdin `last_assistant_message` (v2.1.47+), fallback to JSONL |

### Edge Case Handling

| Edge Case | Strategy |
|-----------|----------|
| `isSidechain: true` | Filter out for `extractAssistantResponse` (backfill only wants current response). **Include** in `parseReplayTranscript` (replay shows full history, preserves numbering alignment with DB). |
| `isApiErrorMessage: true` | Filter out — not real assistant responses |
| `compact_boundary` | No special handling needed — we parse backwards from end |
| `parentUuid` DAG | No DAG traversal — linear backwards scan is sufficient |

**Why replay includes sidechain entries**: DB assigns `promptNumber` at UserPromptSubmit time via `count + 1`. If an undo occurs, the undo'd prompt still has a DB turn (marked `stale` → `undone`). The JSONL retains the entry as `isSidechain: true`. By including sidechain entries in replay's transcript parsing, promptNumbers naturally align between DB and JSONL — no mapping layer needed. Undone turns are displayed with an `[undone]` marker based on DB turn `status` (not JSONL `isSidechain`).

### Matching Turn to JSONL Entry

When backfilling `assistant_response` for turn N, the hook:
1. Reads JSONL backwards
2. Skips entries with `isSidechain: true` or `isApiErrorMessage: true`
3. Finds the assistant entry whose preceding user message matches `turns[N].user_prompt`
4. Extracts text blocks as above
5. **If no matching assistant entry found → returns empty string** (never throws). This handles interrupted turns where Claude never responded.

For the Stop hook's final turn, `last_assistant_message` from stdin is preferred (no JSONL parsing needed). If `last_assistant_message` is undefined (interrupted session), falls back to JSONL parsing, which may also return empty.

---

## Privacy

### `<private>` Tags

Users wrap sensitive content in `<private>...</private>` tags. Mnemosyne's prompt instructs it to never record tagged content. No hook-layer stripping needed — the agent makes the judgment.

### `<claude-mnemo-context>` Tags

Injected memories are wrapped in `<claude-mnemo-context>` tags to prevent recursion — memories about memories. The context handler adds these tags; Mnemosyne's prompt can reference them to understand what context was previously injected.

---

## Differences from Claude-Mem

| Aspect | Claude-Mem | Claude-Mnemo |
|--------|-----------|--------------|
| Memory granularity | Per tool call (observation) | Per QA turn (turn + observations) |
| Extraction trigger | PostToolUse hook (every tool call) | PreCompact + Stop (batch extraction via Mnemosyne) |
| Agent architecture | Separate Worker HTTP API + SDK Agent | forkSession directly from hooks |
| LLM invocation | Dedicated SDK Agent with disallowedTools | Mnemosyne via forkSession, same tool set |
| Cache efficiency | Separate session, no cache sharing | Same tool set → prompt cache hit |
| Search backend | Chroma (Python) + FTS5 (deprecated) | FTS5 only, no external dependencies |
| Data model | sdk_sessions + observations + session_summaries | sessions → turns → observations (3-layer tree) |
| Display format | Markdown tables | Indented tags (~30% fewer tokens) |
| Retrieval tools | search + timeline + get_observations (3 tools) | recall + replay (2 tools, progressive disclosure) |
| Worker service | Express HTTP server on port 37777 | None |
| Message queue | pending_messages table + claim-confirm | Direct SQLite writes via MCP tools |
| Compact handling | Not handled | Dedicated compact hook for pre-compression extraction |
| Platform support | Claude Code, Cursor, Windsurf, Gemini, OpenCode | Claude Code (extensible via adapters) |

### Patterns Borrowed from Claude-Mem

- **Observer role separation** in agent prompt ("you are NOT the one doing the work")
- **Verb-focused recording guidance** (implemented, fixed, deployed, not "analyzed" or "tracked")
- **WAL mode + transaction discipline** for concurrent SQLite access (busy_timeout=5000ms)
- **Parent heartbeat** (ppid check) to prevent orphaned MCP server processes
- **Platform adapter layer** for multi-IDE support
- **Content hash deduplication** (30-second window)
- **Exit code strategy** (0=success, 1=non-blocking, 2=blocking)
- **Worktree detection** via `.git` file parsing
- **Tag stripping with ReDoS protection** (max 100 tags)
- **Batch extraction** at natural checkpoints (PreCompact before compression, Stop at session end)
