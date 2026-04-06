# Claude-Mnemo Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Claude Code plugin that extracts structured memories from conversations via a forked "Mnemosyne" agent, stores them in a 3-layer SQLite schema (sessions -> turns -> observations), and provides `recall` / `replay` MCP tools for retrieval.

**Architecture:** Hooks trigger Mnemosyne (a forkSession agent) to extract memories incrementally per QA turn. Mnemosyne uses MCP tool calls (`save_turn`, `update_session`, `recall`, `replay`) to read/write memory — no XML parsing. The tool set is kept identical to the main agent's to preserve prompt cache hits. Memories are stored in SQLite with FTS5 indexing. No Worker service — hooks and MCP server interact with SQLite directly. All scripts run via Bun (bun-runner.js wrapper handles detection/installation).

**Tech Stack:** TypeScript (ESM), esbuild (bundling), bun:sqlite, @anthropic-ai/claude-agent-sdk (forkSession), @modelcontextprotocol/sdk (MCP server), FTS5 (full-text search)

**Key Design Decisions:**
- **Mnemosyne tool mechanism**: Mnemosyne uses the same MCP tools as the main agent (recall, replay) plus two write tools (save_turn, update_session) exposed via the same MCP server. Tool set is NOT changed via `disallowedTools` — tools are constrained via prompt only — to preserve prompt cache hits from forkSession.
- **Prompt caching**: Cache key = `hash(tools + system + messages_prefix)`. forkSession inherits the main session's message prefix. Keeping the tool set identical means cache hit on the full conversation context (~free input tokens). Changing `disallowedTools` would break all cache (~$0.75/fork for a 50k token session).
- **Compact handling**: `PreCompact` hook (matcher: `manual|auto`) triggers extraction of pending turns BEFORE context is compressed. Known bug: `transcript_path` may be empty in PreCompact (Issue #13668) — fallback to constructing path from `session_id`. Mnemosyne can also call `replay()` to recover original transcript if needed.
- **Hook re-entry prevention**: forkSession subprocess loads the same plugins/hooks. Guard in `hook-command.ts`: `if (process.env.CLAUDE_CODE_ENTRYPOINT === 'sdk-ts') process.exit(0)`. Mnemosyne's `env.ts` strips `CLAUDECODE` and sets `CLAUDE_CODE_ENTRYPOINT=sdk-ts`.
- **Resume recovery**: `SessionStart[resume]` context handler scans for orphaned pending turns from prior interrupted sessions (where Stop didn't fire, or StopFailure fired instead) and triggers recovery extraction. `StopFailure` is intentionally not handled — recovery is deferred to resume.
- **Re-extraction semantics**: `save_turn` on stale/extracted turns does DELETE-then-INSERT for observations + FTS rows within one transaction. No duplicate observations.
- **SQLite concurrency**: WAL mode + `busy_timeout=5000` + all writes in transactions. No external retry/backoff needed — single-writer contention is bounded by busy_timeout.
- **Prompt number tracking**: Claude Code's hook stdin does NOT provide `prompt_number`. We track it internally by counting `UserPromptSubmit` calls per `session_id` in the DB.
- **Bun runtime**: All compiled scripts (.cjs) use `bun:sqlite` and must run via Bun. A `bun-runner.js` wrapper auto-detects/installs Bun and invokes scripts.
- **FTS5 sync**: FTS indexing is integrated into `saveTurn()` and `upsertSession()` — not via triggers, not as a separate step.
- **save_turn skip convention**: Calling `save_turn` with no title/description/observations = skip (status='skipped'). No separate `skip_turn` tool needed.
- **Mnemosyne prompt**: English, following claude-mem patterns (observer role, verb-focused recording, explicit skip conditions). Instructs agent to only use save_turn, update_session, recall, replay — never Read/Write/Edit/Bash. Extraction status uses prompt previews (first ~80 chars of `user_prompt`) as anchors, not titles.
- **Raw data in turns**: `user_prompt` stored at turn creation (from hook stdin). `assistant_response` backfilled by hook via JSONL parsing (UserPromptSubmit/compact) or `last_assistant_message` from stdin (Stop). These fields are populated by hook layer, NOT by Mnemosyne.
- **Transcript parsing**: Linear backwards scan of JSONL, filter `isSidechain`/`isApiErrorMessage`, extract only `text` blocks from assistant content. Matches claude-mem's approach (no DAG traversal, no compact_boundary handling).

---

## File Structure

```
claude-mnemo/
├── package.json
├── tsconfig.json
├── scripts/
│   └── build.js                    # esbuild bundler
├── src/
│   ├── db/
│   │   ├── database.ts             # SQLite connection, WAL, migrations
│   │   ├── schema.ts               # CREATE TABLE statements + FTS5
│   │   ├── sessions.ts             # Session CRUD
│   │   ├── turns.ts                # Turn CRUD (save_turn with skip convention)
│   │   ├── observations.ts         # Observation CRUD
│   │   └── search.ts               # FTS5 search + filter queries
│   ├── hooks/
│   │   ├── hook-command.ts         # Central hook dispatcher
│   │   ├── adapters/
│   │   │   ├── index.ts            # Platform adapter registry
│   │   │   └── claude-code.ts      # Claude Code adapter
│   │   ├── handlers/
│   │   │   ├── context.ts          # SessionStart: inject memory context
│   │   │   ├── compact.ts          # PreCompact: extract pending turns before compression
│   │   │   ├── session-init.ts     # UserPromptSubmit: init session + trigger prev turn extraction
│   │   │   └── stop.ts             # Stop: extract last turn + update session
│   │   └── types.ts                # NormalizedHookInput, HookResult
│   ├── mnemosyne/
│   │   ├── fork.ts                 # forkSession wrapper (Agent SDK query)
│   │   ├── prompt.ts               # Mnemosyne system prompt + status injection
│   │   └── env.ts                  # Blocklist-based env isolation
│   ├── mcp/
│   │   ├── server.ts               # MCP server entry (stdio transport)
│   │   ├── recall.ts               # recall tool: tree drill-down, search, filter, timeline
│   │   ├── replay.ts               # replay tool: raw JSONL transcript playback
│   │   ├── save-turn.ts            # save_turn tool: write/skip turn + observations (Mnemosyne write)
│   │   ├── update-session.ts       # update_session tool: upsert session summary (Mnemosyne write)
│   │   └── format.ts               # Indented tag format renderer
│   ├── shared/
│   │   ├── paths.ts                # DB path, session JSONL path resolution
│   │   ├── transcript-parser.ts    # JSONL parser (turn extraction, tool indexing)
│   │   ├── tag-stripping.ts        # <private>, <claude-mnemo-context> stripping
│   │   ├── hook-constants.ts       # Timeouts, exit codes
│   │   └── logger.ts               # Structured logger (stderr, component tags)
│   └── utils/
│       ├── worktree.ts             # Git worktree detection
│       ├── token-estimate.ts       # ~4 chars/token heuristic
│       └── hash.ts                 # Content hash for dedup
├── plugin/
│   ├── .claude-plugin/
│   │   └── plugin.json             # Plugin metadata
│   ├── .mcp.json                   # MCP server registration
│   ├── hooks/
│   │   └── hooks.json              # Hook definitions
│   ├── scripts/                    # (build output) compiled .cjs bundles + bun-runner.js
│   ├── skills/
│   │   └── mnemo/
│   │       └── SKILL.md            # recall/replay usage guide for Claude
│   └── CLAUDE.md                   # Plugin-level context injection
└── tests/
    ├── db/
    │   ├── schema.test.ts
    │   ├── sessions.test.ts
    │   ├── turns.test.ts
    │   └── search.test.ts
    ├── hooks/
    │   ├── session-init.test.ts
    │   └── stop.test.ts
    ├── mcp/
    │   ├── recall.test.ts
    │   ├── replay.test.ts
    │   └── format.test.ts
    └── shared/
        ├── transcript-parser.test.ts
        └── tag-stripping.test.ts
```

---

## Phase 1: Project Scaffold + Database

### Task 1: Project Initialization

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`

- [ ] **Step 1: Initialize project**

```bash
cd /Users/zhaoqixuan/Projects/claude-mnemo
git init
```

- [ ] **Step 2: Create package.json**

```json
{
  "name": "claude-mnemo",
  "version": "0.1.0",
  "type": "module",
  "description": "Structured memory system for Claude Code — powered by Mnemosyne",
  "license": "MIT",
  "scripts": {
    "build": "node scripts/build.js",
    "test": "bun test",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "esbuild": "^0.27.2",
    "typescript": "^5.8.0"
  },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^0.1.76",
    "@modelcontextprotocol/sdk": "^1.25.1"
  }
}
```

- [ ] **Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "node",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "declaration": true,
    "sourceMap": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests", "plugin"]
}
```

- [ ] **Step 4: Create .gitignore**

```
node_modules/
dist/
plugin/scripts/*.cjs
*.db
*.db-wal
*.db-shm
.DS_Store
```

- [ ] **Step 5: Install dependencies and commit**

```bash
cd /Users/zhaoqixuan/Projects/claude-mnemo && npm install
git add package.json tsconfig.json .gitignore package-lock.json
git commit -m "chore: initialize claude-mnemo project"
```

---

### Task 2: SQLite Schema

**Files:**
- Create: `src/db/database.ts`
- Create: `src/db/schema.ts`
- Test: `tests/db/schema.test.ts`

- [ ] **Step 1: Write schema test**

Test: creates sessions/turns/observations tables, creates FTS5 virtual table, enforces UNIQUE(session_id, prompt_number) on turns, cascades delete session→turns→observations, is idempotent.

Note: sessions table uses `started_at_epoch` (not `created_at_epoch`).

- [ ] **Step 2: Run test — expect FAIL**

- [ ] **Step 3: Implement database.ts**

Use `import { existsSync, mkdirSync } from 'node:fs'` (ESM import, not `require`). Default DB path: `~/.claude-mnemo/claude-mnemo.db`. Set WAL mode, synchronous=NORMAL, foreign_keys=ON, mmap_size=256MB, cache_size=10000, busy_timeout=5000.

- [ ] **Step 4: Implement schema.ts**

Three tables + indexes + FTS5. FTS5 table is regular (not contentless) so DELETE/UPDATE by column values work correctly:

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  layer,        -- 'session' | 'turn' | 'observation'
  source_id,    -- original table id (not UNINDEXED — needed for DELETE)
  title,
  description,
  extra          -- session/turn: insight; observation: narrative+facts+concepts
);
```

- [ ] **Step 5: Run tests — expect PASS**

- [ ] **Step 6: Commit**

```bash
git add src/db/database.ts src/db/schema.ts tests/db/schema.test.ts
git commit -m "feat: SQLite schema with sessions/turns/observations + FTS5"
```

---

### Task 3: Session CRUD

**Files:**
- Create: `src/db/sessions.ts`
- Test: `tests/db/sessions.test.ts`

- [ ] **Step 1: Write tests** — upsert creates new, upsert updates existing (title/description/insight), getRecentSessions ordered by started_at_epoch DESC, filter by project.

- [ ] **Step 2: Run test — expect FAIL**

- [ ] **Step 3: Implement sessions.ts** — `upsertSession()` (with `indexSessionToFTS` call), `getSession()`, `getSessionByContentId()`, `getRecentSessions()`.

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/db/sessions.ts tests/db/sessions.test.ts
git commit -m "feat: session CRUD with upsert + FTS sync"
```

---

### Task 4: Turn CRUD

**Files:**
- Create: `src/db/turns.ts`
- Test: `tests/db/turns.test.ts`

- [ ] **Step 1: Write tests** — saves turn+observations atomically, skip convention (save_turn with empty fields → status='skipped'), re-extraction of stale turns, FTS sync. Verify `user_prompt` and `assistant_response` fields stored and retrieved correctly.

- [ ] **Step 2: Run test — expect FAIL**

- [ ] **Step 3: Implement turns.ts** — `saveTurn()` with skip detection (`hasContent ? 'extracted' : 'skipped'`), atomic transaction wrapping turn upsert + observation insert + FTS indexing. For re-extraction (stale/extracted turns): DELETE existing observations + FTS rows before INSERT within the same transaction. `getTurn()`, `getTurnsForSession()`, `getPendingTurns()`, `markTurnsStale(sessionId, promptNumbers[])`.

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/db/turns.ts tests/db/turns.test.ts
git commit -m "feat: turn CRUD with atomic save + skip convention + FTS sync"
```

---

### Task 5: Observation Queries + FTS5 Search

**Files:**
- Create: `src/db/observations.ts`
- Create: `src/db/search.ts`
- Test: `tests/db/search.test.ts`

- [ ] **Step 1: Write search tests** — finds by keyword across layers, filters by project (join back to sessions), filters by type/file/date, returns recent sessions when no query.

- [ ] **Step 2: Run test — expect FAIL**

- [ ] **Step 3: Implement observations.ts** — `getObservationsForTurn()`, `getObservation()`.

- [ ] **Step 4: Implement search.ts** — `indexSessionToFTS()`, `indexTurnToFTS()`, `indexObservationToFTS()`, `searchMemory()` with FTS5 MATCH + post-filter by project/type/file/date.

- [ ] **Step 5: Run tests — expect PASS**

- [ ] **Step 6: Commit**

```bash
git add src/db/observations.ts src/db/search.ts tests/db/search.test.ts
git commit -m "feat: observation queries + FTS5 search across all layers"
```

---

## Phase 2: Shared Utilities

### Task 6: Logger, Constants, Paths, Transcript Parser

**Files:**
- Create: `src/shared/logger.ts`, `src/shared/hook-constants.ts`, `src/shared/paths.ts`, `src/shared/transcript-parser.ts`, `src/shared/tag-stripping.ts`
- Create: `src/utils/hash.ts`, `src/utils/token-estimate.ts`, `src/utils/worktree.ts`
- Test: `tests/shared/transcript-parser.test.ts`, `tests/shared/tag-stripping.test.ts`

- [ ] **Step 1: Write transcript parser tests** — extracts turns from JSONL, skips system/empty messages, counts prompt numbers correctly, extracts tool_use blocks within turns. Verify `isSidechain` and `isApiErrorMessage` entries are filtered out. Verify assistant text extraction (only `text` blocks, strips `<system-reminder>` tags).

- [ ] **Step 2: Run test — expect FAIL**

- [ ] **Step 3: Implement all shared utilities**

Key files:
- `transcript-parser.ts`: JSONL → `Turn[]` with `promptNumber`, `userPrompt`, `assistantText`, `toolCalls[]`. Must correctly identify QA turn boundaries (non-empty, non-tool-result user messages). Filter out `isSidechain: true` and `isApiErrorMessage: true` entries. Extract assistant text from `content` array: only `type: 'text'` blocks (skip thinking/tool_use/image), join with `\n`, strip `<system-reminder>` tags, collapse `\n{3,}` to `\n\n`. Provide `extractAssistantResponse(transcriptPath, userPromptPrefix)` for matching a specific turn's response by prompt prefix. **Returns empty string (never throws) when no matching assistant entry found** — handles interrupted turns gracefully.
- `paths.ts`: DB path resolution (env → settings → default). Session JSONL path: `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`.
- `tag-stripping.ts`: Strip `<private>` and `<claude-mnemo-context>` tags. ReDoS-safe with tag counting (max 100).
- `logger.ts`: stderr-based, component tags (HOOK/MCP/DB/MNEMOSYNE), lazy init.
- `hook-constants.ts`: Timeouts (health=3s, readiness=30s, stop=120s), exit codes (0=success, 1=non-blocking, 2=blocking), WINDOWS_MULTIPLIER=1.5.
- `worktree.ts`: Parse `.git` file to detect worktrees, extract parent repo path.
- `hash.ts`: SHA256 content hash for dedup.
- `token-estimate.ts`: `estimateTokens(text)` ≈ `Math.ceil(text.length / 4)`.

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/shared/ src/utils/ tests/shared/
git commit -m "feat: shared utilities — logger, transcript parser, tag stripping, paths"
```

---

## Phase 3: MCP Server (recall + replay + write tools)

### Task 7: MCP Server Skeleton + Format Renderer

**Files:**
- Create: `src/mcp/server.ts`
- Create: `src/mcp/format.ts`
- Test: `tests/mcp/format.test.ts`

- [ ] **Step 1: Write format renderer tests** — test indented-tag output for each layer (session/turn/observation, collapsed/expanded). Verify token-efficient output.

- [ ] **Step 2: Run test — expect FAIL**

- [ ] **Step 3: Implement format.ts** — `formatSessionCollapsed()`, `formatSessionExpanded()`, `formatTurnCollapsed()`, `formatTurnExpanded()`, `formatObservationCollapsed()`, `formatObservationExpanded()`, `formatTree()`.

- [ ] **Step 4: Implement server.ts skeleton** — MCP server with stdio transport, parent heartbeat (ppid check every 30s), tool registration for all 4 tools (handlers stubbed). Register: `recall`, `replay`, `save_turn`, `update_session`.

- [ ] **Step 5: Run tests — expect PASS**

- [ ] **Step 6: Commit**

```bash
git add src/mcp/ tests/mcp/format.test.ts
git commit -m "feat: MCP server skeleton + indented-tag format renderer"
```

---

### Task 8: recall Tool

**Files:**
- Create: `src/mcp/recall.ts`
- Test: `tests/mcp/recall.test.ts`

- [ ] **Step 1: Write recall tests** — all modes: `recall()` → recent sessions, `recall(query="auth")` → FTS5 search, `recall(session=1)` → turns, `recall(turn=1)` → observations, `recall(observation=1)` → full detail, `recall(session=1, expand_turns=[1])` → tree expansion, `recall(around="S1", before=2, after=2)` → cross-session timeline, `recall(file="auth.ts")` → file filter, `recall(type="bugfix")` → type filter.

- [ ] **Step 2: Run test — expect FAIL**

- [ ] **Step 3: Implement recall.ts** — route parameters to DB queries + format renderer. Cross-session timeline via `around` parameter queries sessions by epoch offset.

- [ ] **Step 4: Wire into server.ts** with full inputSchema.

- [ ] **Step 5: Run tests — expect PASS**

- [ ] **Step 6: Commit**

```bash
git add src/mcp/recall.ts tests/mcp/recall.test.ts src/mcp/server.ts
git commit -m "feat: recall tool — tree drill-down, search, filter, timeline"
```

---

### Task 9: replay Tool

**Files:**
- Create: `src/mcp/replay.ts`
- Test: `tests/mcp/replay.test.ts`

- [ ] **Step 1: Write replay tests** — `replay(session=1)` → turn overview, `replay(session=1, turn=1)` → full QA, `replay(session=1, turn=1, tool=2)` → single tool call, `replay(session=1, turn=1, full=true)` → no truncation, missing JSONL → graceful error.

- [ ] **Step 2: Run test — expect FAIL**

- [ ] **Step 3: Implement replay.ts** — resolve JSONL path via `paths.ts`, parse with `transcript-parser.ts`, format for display. Default: truncate tool_result to 500 chars.

- [ ] **Step 4: Wire into server.ts**

- [ ] **Step 5: Run tests — expect PASS**

- [ ] **Step 6: Commit**

```bash
git add src/mcp/replay.ts tests/mcp/replay.test.ts src/mcp/server.ts
git commit -m "feat: replay tool — raw transcript playback with truncation"
```

---

### Task 10: save_turn + update_session Write Tools

**Files:**
- Create: `src/mcp/save-turn.ts`
- Create: `src/mcp/update-session.ts`

- [ ] **Step 1: Implement save-turn.ts** — MCP tool handler that calls `saveTurn()` from `db/turns.ts`. Input: `{ session_id, prompt_number, title?, description?, insight?, files_read?, files_modified?, observations?[{ type, title, description?, narrative?, facts?[], concepts?[], files_read?[], files_modified?[] }] }`. Empty title+description+observations → skip (status='skipped'). For re-extraction (turn already has status extracted/stale): DELETE existing observations + FTS rows, then INSERT new ones — all within `saveTurn()`'s transaction. Returns confirmation text.

- [ ] **Step 2: Implement update-session.ts** — MCP tool handler that calls `upsertSession()` with updated title/description/insight. FTS indexing is handled inside `upsertSession()` (not called separately). Returns confirmation text.

- [ ] **Step 3: Wire both into server.ts**

- [ ] **Step 4: Commit**

```bash
git add src/mcp/save-turn.ts src/mcp/update-session.ts src/mcp/server.ts
git commit -m "feat: save_turn + update_session MCP write tools for Mnemosyne"
```

---

## Phase 4: Hook System + Mnemosyne Agent

### Task 11: Hook Dispatcher + Platform Adapter

**Files:**
- Create: `src/hooks/hook-command.ts`
- Create: `src/hooks/adapters/index.ts`
- Create: `src/hooks/adapters/claude-code.ts`
- Create: `src/hooks/types.ts`

- [ ] **Step 1: Implement hook dispatcher** — reads stdin, normalizes via platform adapter, routes to handler by event name (context, compact, session-init, stop). Exit code strategy: 0/1/2. **Re-entry guard at entry point**: `if (process.env.CLAUDE_CODE_ENTRYPOINT === 'sdk-ts') process.exit(0)` — prevents hooks from firing in Mnemosyne's forkSession subprocess.

- [ ] **Step 2: Implement Claude Code adapter** — map `session_id`, `cwd`, `prompt`, `tool_name`, `tool_input`, `tool_response`, `transcript_path`, `last_assistant_message`, `stop_hook_active` to `NormalizedHookInput`. Check `stop_hook_active` at Stop handler entry to prevent infinite loops. Fallback chains for field names.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/
git commit -m "feat: hook dispatcher + Claude Code platform adapter"
```

---

### Task 12: Mnemosyne Agent (forkSession wrapper)

**Files:**
- Create: `src/mnemosyne/fork.ts`
- Create: `src/mnemosyne/prompt.ts`
- Create: `src/mnemosyne/env.ts`

- [ ] **Step 1: Implement env.ts** — blocklist `ANTHROPIC_API_KEY` and `CLAUDECODE`, set `CLAUDE_CODE_ENTRYPOINT=sdk-ts`, pass everything else including `CLAUDE_PLUGIN_ROOT`. Use `import { spawn } from 'node:child_process'` (ESM). This ensures the forkSession subprocess's hooks are short-circuited by the guard in hook-command.ts.

- [ ] **Step 2: Implement prompt.ts** — build Mnemosyne's English prompt. Key design:

**Extraction status uses prompt previews as anchors** (not titles), so Mnemosyne can match turns to conversation context:
```
EXTRACTION STATUS
-----------------
#1 [extracted]: "Why am I getting 401 errors on..."
#2 [stale]: "Fix the race condition in auth..."
#3 [pending]: "Add unit tests for the mutex..."
```

**update_session is agent-judged** — not "call once at the end", but "call if the session summary needs updating (new topic, significant progress, or session ending)".

Full prompt template:
```
You are Mnemosyne, the memory guardian for Claude Code.

You have just inherited the full context of a conversation.
Your role is to extract structured memories for future retrieval.
You are NOT the agent who did the work — you are observing and recording.

EXTRACTION STATUS
-----------------
{statusSummary with prompt previews}

Rules:
- Process turns marked [pending] — match by prompt preview above
- Re-evaluate turns marked [stale] — user undid changes
- Do NOT re-process [extracted] or [skipped] turns

WHAT TO RECORD
--------------
Focus on durable technical signal:
- What the system NOW DOES differently
- What was built, fixed, deployed, or configured
- Concrete debugging findings
- Architectural decisions with rationale
Use verbs: implemented, fixed, deployed, configured, discovered, traced

WHEN TO SKIP
------------
Call save_turn with NO title/description/observations for:
- Empty or trivial prompts
- Routine checks with no findings
- Repetitive operations already documented
- Aborted work with no outcome

HOW TO EXTRACT
--------------
For each pending/stale turn, call save_turn with:
- title: 10-25 chars, what was done
- description: 40-80 chars, how/what achieved
- insight: markdown list of key discoveries (omit if none)
- observations: array of notable events:
  - type: bugfix|feature|refactor|change|discovery|decision
  - title/description/narrative/facts/files_read/files_modified
  - concepts (from fixed vocabulary): how-it-works|why-it-exists|what-changed|problem-solution|gotcha|pattern|trade-off

After processing all turns, call update_session if the session summary
needs updating (new topic, significant progress, or session ending).
Skip update_session if nothing meaningful changed.
If context was compacted and detail is missing, use replay() to recover.
Do NOT use Read, Write, Edit, Bash, or any file operation tools.
Only use: save_turn, update_session, recall, replay.
Never output prose — only tool calls.
Content inside <private>...</private> tags must NOT be recorded.
```

- [ ] **Step 3: Implement fork.ts** — `forkMnemosyne()` using `query()` from Agent SDK with `resume: sessionId, forkSession: true`. No `disallowedTools` — tool constraint via prompt only (preserves cache). Use `import { spawn } from 'node:child_process'` with `buildIsolatedEnv()`.

- [ ] **Step 4: Commit**

```bash
git add src/mnemosyne/
git commit -m "feat: Mnemosyne agent — forkSession, English prompt, env isolation"
```

---

### Task 13: SessionStart Context Handler + Compact Handler

**Files:**
- Create: `src/hooks/handlers/context.ts`
- Create: `src/hooks/handlers/compact.ts`

- [ ] **Step 1: Implement context.ts** — query recent sessions from DB, format as compact context string, return as `hookSpecificOutput`. This is how Claude learns memory tools exist. On `source=resume`: also scan for orphaned pending turns from prior interrupted sessions (where Stop didn't fire) and trigger recovery extraction via fire-and-forget Mnemosyne fork.

- [ ] **Step 2: Implement compact.ts** — triggered by `PreCompact` hook (fires BEFORE compaction, with `trigger: "manual"|"auto"`). Query pending turns for current session, if any exist → backfill assistant_response from JSONL → fork Mnemosyne to extract them before context is compressed. **Note**: PreCompact's `transcript_path` may be empty (Bug #13668) — fallback to constructing path from `session_id` via `paths.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/handlers/context.ts src/hooks/handlers/compact.ts
git commit -m "feat: SessionStart context + compact handler for pre-compression extraction"
```

---

### Task 14: UserPromptSubmit Handler

**Files:**
- Create: `src/hooks/handlers/session-init.ts`
- Test: `tests/hooks/session-init.test.ts`

- [ ] **Step 1: Write tests** — first prompt creates session+pending turn (no extraction), second prompt creates pending turn and fire-and-forget extracts previous, existing extracted turn skipped.

- [ ] **Step 2: Run test — expect FAIL**

- [ ] **Step 3: Implement session-init.ts**

```
1. Parse input (sessionId, cwd, prompt, transcriptPath)
2. Upsert session in DB
3. Determine promptNumber: COUNT turns for this session + 1
4. Insert turn row (status='pending', user_prompt from stdin prompt)
5. If promptNumber > 1:
   a. Query previous turn (N-1) status
   b. If 'pending':
      i.  Parse transcriptPath JSONL → extract assistant_response for turn N-1
          (backwards scan, filter isSidechain/isApiErrorMessage, match by user_prompt prefix)
      ii. UPDATE turns SET assistant_response = ? WHERE id = prev_turn_id
      iii. Fire-and-forget forkMnemosyne
           (Mnemosyne calls save_turn/update_session via MCP tools)
6. Return { continue: true, suppressOutput: true }
```

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/hooks/handlers/session-init.ts tests/hooks/session-init.test.ts
git commit -m "feat: UserPromptSubmit — session init + incremental extraction"
```

---

### Task 15: Stop Handler

**Files:**
- Create: `src/hooks/handlers/stop.ts`
- Test: `tests/hooks/stop.test.ts`

- [ ] **Step 1: Write tests** — extracts remaining pending/stale turns, marks undo'd turns as stale, updates session, outputs progress to stderr, handles missing transcript, guards `stop_hook_active` to prevent infinite loops.

- [ ] **Step 2: Run test — expect FAIL**

- [ ] **Step 3: Implement stop.ts**

```
1. Parse input (sessionId, transcriptPath, lastAssistantMessage, stopHookActive)
2. If stopHookActive → exit 0 immediately (prevent infinite loop)
3. For the last pending turn: backfill assistant_response
   - Prefer last_assistant_message from Stop hook stdin (no JSONL parsing needed)
   - Fallback: parse transcriptPath JSONL if last_assistant_message unavailable
4. Detect undo: compare current JSONL state against extracted turns
   - If any extracted turn's context changed → markTurnsStale(sessionId, promptNumbers)
5. Query all turns with status='pending' or 'stale'
6. Build Mnemosyne prompt with status summary (prompt previews as anchors)
7. Fork Mnemosyne (await completion, within 120s timeout)
   (Mnemosyne calls save_turn + update_session via MCP tools)
8. Output to stderr: "Mnemosyne: 2 turns extracted, 1 skipped (1.2s)"
9. Mark session as completed
10. Return { continue: true, exitCode: 0 }
```

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/hooks/handlers/stop.ts tests/hooks/stop.test.ts
git commit -m "feat: Stop handler — final extraction + session summary"
```

---

## Phase 5: Plugin Distribution + Build

### Task 16: Build Script (esbuild)

**Files:**
- Create: `scripts/build.js`

- [ ] **Step 1: Implement build script** — two targets:
  1. `hook-command.cjs` ← `src/hooks/hook-command.ts` (CJS, executable, chmod 755)
  2. `mcp-server.cjs` ← `src/mcp/server.ts` (CJS, executable, chmod 755)

  Externals: `bun:sqlite`, `@anthropic-ai/claude-agent-sdk`. Inject `__DEFAULT_PACKAGE_VERSION__`.

- [ ] **Step 2: Test build** — verify both .cjs exist and are executable.

- [ ] **Step 3: Commit**

```bash
git add scripts/build.js
git commit -m "feat: esbuild script — hook + MCP server bundles"
```

---

### Task 17: Plugin Configuration

**Files:**
- Create: `plugin/.claude-plugin/plugin.json`
- Create: `plugin/.mcp.json`
- Create: `plugin/hooks/hooks.json`
- Create: `plugin/skills/mnemo/SKILL.md`
- Create: `plugin/scripts/bun-runner.js`
- Create: `plugin/CLAUDE.md`

- [ ] **Step 1: Create plugin.json**

```json
{
  "name": "claude-mnemo",
  "version": "0.1.0",
  "description": "Structured memory for Claude Code — powered by Mnemosyne"
}
```

- [ ] **Step 2: Create .mcp.json**

```json
{
  "mcpServers": {
    "mnemo": {
      "type": "stdio",
      "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/bun-runner.js ${CLAUDE_PLUGIN_ROOT}/scripts/mcp-server.cjs"
    }
  }
}
```

- [ ] **Step 3: Create hooks.json**

```json
{
  "description": "Claude-mnemo memory hooks — powered by Mnemosyne",
  "hooks": {
    "PreCompact": [{
      "matcher": "manual|auto",
      "hooks": [{
        "type": "command",
        "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/bun-runner.js ${CLAUDE_PLUGIN_ROOT}/scripts/hook-command.cjs compact",
        "timeout": 30
      }]
    }],
    "SessionStart": [{
      "matcher": "startup|resume|clear|compact",
      "hooks": [{
        "type": "command",
        "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/bun-runner.js ${CLAUDE_PLUGIN_ROOT}/scripts/hook-command.cjs context",
        "timeout": 10
      }]
    }],
    "UserPromptSubmit": [{
      "matcher": "*",
      "hooks": [{
        "type": "command",
        "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/bun-runner.js ${CLAUDE_PLUGIN_ROOT}/scripts/hook-command.cjs session-init",
        "timeout": 10
      }]
    }],
    "Stop": [{
      "matcher": "*",
      "hooks": [{
        "type": "command",
        "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/bun-runner.js ${CLAUDE_PLUGIN_ROOT}/scripts/hook-command.cjs stop",
        "timeout": 120
      }]
    }]
  }
}
```

- [ ] **Step 4: Create SKILL.md** — recall/replay usage guide, 3-layer workflow, parameter reference, example invocations.

- [ ] **Step 5: Create bun-runner.js** — detect Bun, auto-install if missing, invoke target script. Reference: `claude-mem/plugin/scripts/bun-runner.js`.

- [ ] **Step 6: Create plugin/CLAUDE.md** — context injection template with `<claude-mnemo-context>` tags.

- [ ] **Step 7: Commit**

```bash
git add plugin/
git commit -m "feat: plugin config — hooks, MCP, skill, bun-runner, CLAUDE.md"
```

---

## Phase 6: Integration Testing

### Task 18: End-to-End Smoke Test

**Files:**
- Create: `tests/e2e/smoke.test.ts`

- [ ] **Step 1: Write E2E test** — simulate full lifecycle:
  1. Create in-memory DB
  2. Call session-init handler (prompt #1) → session + pending turn created
  3. Call session-init handler (prompt #2) → pending turn created, prev turn extracted
  4. Call stop handler → last turn extracted + session updated
  5. Use recall() → verify sessions returned
  6. Use recall(session=N) → verify turns returned
  7. Use recall(turn=N) → verify observations returned
  8. Use replay with mock JSONL → verify transcript returned

- [ ] **Step 2: Run and iterate**

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/
git commit -m "test: end-to-end smoke test for full memory lifecycle"
```

---

### Task 19: Build + Install Test

- [ ] **Step 1: Full build**

```bash
cd /Users/zhaoqixuan/Projects/claude-mnemo && npm run build
```

- [ ] **Step 2: Verify plugin structure**

```bash
ls plugin/scripts/          # hook-command.cjs, mcp-server.cjs, bun-runner.js
ls plugin/hooks/            # hooks.json
ls plugin/.claude-plugin/   # plugin.json
ls plugin/skills/mnemo/     # SKILL.md
```

- [ ] **Step 3: Manual test with Claude Code** — install plugin locally, verify SessionStart/UserPromptSubmit/Stop hooks work, verify recall()/replay() return results.

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "chore: v0.1.0 — claude-mnemo initial release"
```

---

## Summary

| Phase | Tasks | What it delivers |
|-------|-------|-----------------|
| 1 | Tasks 1-5 | SQLite schema + CRUD + FTS5 search |
| 2 | Task 6 | Shared utilities (parser, logger, paths) |
| 3 | Tasks 7-10 | MCP server with recall, replay, save_turn, update_session |
| 4 | Tasks 11-15 | Hook system + Mnemosyne agent (context, compact, session-init, stop) |
| 5 | Tasks 16-17 | Build pipeline + plugin distribution (bun-runner) |
| 6 | Tasks 18-19 | Integration tests + manual verification |

## Key Architecture Diagram

```
Claude Code Main Agent
  │
  ├─ PreCompact[manual|auto] → compact handler → fork Mnemosyne (extract pending before compress)
  ├─ SessionStart[startup|resume|clear|compact] → context handler → inject recent memories + recover orphaned turns
  ├─ UserPromptSubmit → session-init handler → upsert session + fire-and-forget fork Mnemosyne (prev turn)
  └─ Stop → stop handler → mark stale turns + await fork Mnemosyne (remaining turns + session summary)

Mnemosyne (forked agent, same tool set, prompt-constrained)
  │
  ├─ recall()        → read existing memories (avoid duplicates)
  ├─ replay()        → read original transcript (recover compact detail)
  ├─ save_turn()     → write turn + observations to SQLite (or skip if empty)
  └─ update_session() → update session title/description/insight

MCP Server (stdio, shared SQLite)
  │
  ├─ recall   (read)  → tree drill-down, FTS5 search, filters, timeline
  ├─ replay   (read)  → JSONL transcript playback
  ├─ save_turn (write) → turn + observations atomic write + FTS sync
  └─ update_session (write) → session upsert + FTS sync
```
