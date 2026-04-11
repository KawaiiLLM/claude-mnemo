# Claude-Mnemo

Structured memory system for Claude Code. Captures every tool call in real time, extracts durable observations and turn summaries via a background agent, and feeds them back into future sessions — so conversations start with context, not from scratch.

## How It Works

Claude-Mnemo hooks into five points of the Claude Code lifecycle:

| Hook | Trigger | What it does |
|------|---------|--------------|
| **SessionStart** | Session begins / resumes / clears / post-compact | Injects recent session summaries, turn highlights, and active memories into context |
| **UserPromptSubmit** | Every user message | Creates (or resumes) the session + a new turn row in SQLite |
| **PostToolUse** | Every tool call | Writes a raw observation (tool_name + input + result), enqueues it for extraction, wakes the worker |
| **Stop** | Agent finishes a turn | Backfills the assistant response + tool counts, enqueues a turn-stop job |
| **PreCompact** | Main agent is about to compact | Synchronously flushes the worker queue for this session and pushes a final session summary |

Extraction does not run inside the hook process. Hooks write to SQLite and return; a **long-lived worker** (Bun HTTP server on `127.0.0.1:37778`) picks up the work asynchronously, sends it to **Mnemosyne** (an isolated Claude Agent SDK query session), and writes the extracted titles, content, insights, tags, and types back into the same database.

### Data Model

```
Session  [S12]        one per conversation
  Turn     [T3]        one per user prompt (promptNumber scoped to session)
    Observation [O87]   one per tool call
Memory   [M4]         durable cross-session knowledge
```

Turns carry a type tag: 🔴 bugfix · 🟣 feature · 🔄 refactor · ✅ change · 🔵 discovery · ⚖️ decision.

Memories are the durable layer — user feedback, project decisions, gotchas, and patterns — with `scope` either `global` or an absolute project path.

### Queue + Crash Safety

All pending extraction work lives in a single `pending_queue` table keyed by a monotonic `seq` (AUTOINCREMENT). Hooks write to `pending_queue` inside the same SQLite transaction as the observation or turn-stop update, so a crashed worker or killed hook never drops work — the next worker boot resumes from the queue in FIFO order.

## Installation

In Claude Code, add the marketplace and install:

```
/plugin marketplace add KawaiiLLM/claude-mnemo
/plugin install claude-mnemo
```

Bun is the only runtime dependency — `bun-runner.js` auto-installs it if missing. Marketplace and source installs ship with prebuilt `plugin/scripts/*.cjs` entrypoints, so hooks, MCP, and the worker run without a post-install build.

### From Source

```bash
git clone https://github.com/KawaiiLLM/claude-mnemo.git
cd claude-mnemo
npm install
npm run build
```

Then symlink the built plugin:

```bash
ln -s "$(pwd)/plugin" ~/.claude/plugins/claude-mnemo
```

For contributors, `npm run build` refreshes the committed release artifacts in `plugin/scripts/`.

## Usage

Once installed, Claude-Mnemo works automatically — hooks fire on every session, the worker extracts in the background, and `SessionStart` injects context on the next launch.

Two skills expose the read and write paths to the main agent:

### `mnemo-recall` — Reading Past Work

Auto-loaded when the user asks questions like *"did we already do this?"*, *"how did we fix X last time?"*, or *"show me the exact tool calls from last Thursday"*. Documents the full `recall` + `replay` API.

Quick reference:

```
recall()                                            # recent sessions
recall(query="auth race")                           # FTS across all layers
recall(query="type:bugfix file:src/auth.ts")        # typed filters
recall(time="-7d")                                  # relative time window
recall(id="S12")                                    # session summary
recall(id="S12/T3")                                 # turn by promptNumber
recall(id="S12/T3..7", depth="expanded")            # turn range with content
recall(id="S12/T3/O*")                              # observations in a turn
recall(id="O87", depth="expanded")                  # specific observation
recall(id="M*")                                     # all active memories

replay(id="S12")                                    # transcript turn overview
replay(id="S12/T3", depth="expanded")               # exact prompt + response + tool I/O
replay(id="S12/T3/Tool2", depth="full")             # single tool call, untruncated
```

- **Selectors**: `S*` / `S12` / `S5..10` (sessions), `S12/T*` / `S12/T3..7` (turns by promptNumber), `S12/T3/O*` (observation list), `O7` (single observation, global id), `M*` / `M4` / `M1..20` (memories, global id).
- **Query prefixes**: `type:` / `file:` / `project:` / `tag:` (memory-only). Free words become an FTS phrase.
- **Time**: `-7d` / `-2w` (relative), `YYYY-MM-DD` (single UTC day), `YYYY-MM-DD..YYYY-MM-DD` (inclusive UTC range).
- **Depth**: `collapsed` (default) / `expanded` / `full`. `full` on `replay` disables tool-result truncation.

### `mnemo-remember` — Writing Durable Memory

Auto-loaded when the user says *"remember this"*, *"save as feedback"*, or when the agent notices a non-obvious fact worth preserving. Only documents `remember` for **memory creation** — turn / observation / session records are managed automatically by the worker and are not main-agent concerns.

```
remember({
  type: "feedback",
  scope: "global",
  title: "Prefer terse commit messages",
  content: "User prefers 1-2 sentence commit bodies focused on why, not what.",
  reasoning: "Corrected me twice when I wrote long commits.",
  application: "Apply when drafting any git commit message.",
  tags: ["git", "style"]
})
```

Required: `type`, `scope`, `title`, `content`. Optional: `reasoning`, `application`, `tags`, `source` (e.g. `"T5"` to link back to the triggering turn), `status` (defaults to `active`).

Common types: `feedback` / `decision` / `pattern` / `gotcha` / `lesson` / `context`. Free-form string — not an enum.

### SessionStart Context Injection

On every session start, `SessionStart` injects:

- A header with session and observation counts plus the type legend
- A graduated view: current session expanded, recent sessions collapsed
- Active memories for the current project scope (plus all `global`-scoped memories)
- Expansion hints pointing to `recall(id="Sx/Ty", depth="expanded")` for drill-down

## Project Structure

```
src/
├── db/            # SQLite schema, sessions, turns, observations, memories, pending_queue, FTS5
├── hooks/         # Hook handlers (session-init, post-tool-use, stop, compact, context)
├── mcp/           # MCP server — recall, replay, remember, format renderer, selectors
├── worker/        # Long-lived Bun worker — HTTP server, queue loop, agent sessions, processors
├── mnemosyne/     # env isolation helpers for Mnemosyne subprocess
├── shared/        # Transcript parser, logger, paths, constants
└── utils/         # Hashing, token estimation, worktree detection

plugin/            # Built artifacts installed into Claude Code
├── hooks/         # hooks.json (lifecycle bindings)
├── scripts/       # bun-runner.js, hook-command.cjs, mcp-server.cjs, worker.cjs
├── skills/        # mnemo-recall + mnemo-remember
└── CLAUDE.md      # Plugin-level instructions injected into context

tests/             # Mirrors src/ structure
docs/              # Design specs and implementation plans
```

## Development

```bash
# Run all tests
bun test

# Run a specific test file
bun test tests/shared/transcript-parser.test.ts

# Type check
npm run typecheck

# Build plugin artifacts
npm run build
```

### Database

SQLite at `~/.claude-mnemo/claude-mnemo.db` (WAL mode, 3s busy timeout):

| Table | Purpose |
|-------|---------|
| `sessions` | One row per conversation. Fields: `title`, `content`, `insight`, `next_steps`, `project`, `last_agent_session_id`, timestamps. |
| `turns` | One row per user prompt. Fields: `user_prompt`, `assistant_response`, `title`, `content`, `insight`, `type`, `tags`, `files_read`, `files_modified`, `tool_call_count`, `status` (`active` → `extracted` / `skipped` / `undone`). |
| `observations` | One row per tool call. Fields: `tool_name`, `tool_input`, `tool_result`, `title`, `content`, `status` (`pending` → `extracted` / `skipped`). |
| `memories` | Durable cross-session knowledge. Fields: `type`, `scope`, `title`, `content`, `reasoning`, `application`, `tags`, `source_turn_id`, `status`. |
| `pending_queue` | FIFO extraction queue. Fields: `seq` (monotonic), `kind` (`obs` / `turn-stop`), `target_id`, `session_db_id`, `claimed_at_epoch`. |
| `memory_fts` | FTS5 virtual table indexing sessions / turns / observations / memories. |

### Architecture Decisions

- **Worker-backed extraction** — a long-lived Bun worker (`src/worker/server.ts`, port 37778) owns the Mnemosyne query sessions. Hooks never block on the LLM; they write to SQLite + `pending_queue` and fire-and-forget a `/wake` request. Replaces the old fork-per-hook model.
- **Dedicated Mnemosyne transcript directory** — worker query sessions run with `cwd = ~/.claude-mnemo`, so Claude Agent SDK transcripts land under `~/.claude/projects/-Users-<username>-.claude-mnemo/` instead of the user's real project directories. `sessions.last_agent_session_id` stores the latest agent session id so the worker can best-effort resume the prior query session when the transcript file still exists.
- **Per-session processing lock** — within one session, observation and turn-stop jobs run strictly serially through a chained-Promise lock in `src/worker/agent-session.ts`. Different sessions process in parallel.
- **Synchronous `/compact`** — PreCompact is the one hook that waits. It drains the session's queue and pushes a final summary prompt before returning, so the main agent's compact anchor is accurate.
- **UUID-based transcript dedup** — resume / `--continue` append the full history again; the parser dedupes by `entry.uuid` before computing turn boundaries, so tool call counts don't inflate on resumed sessions.
- **Bun runtime** — hooks, MCP server, and worker all run under Bun for native SQLite and fast startup. `bun-runner.js` shim auto-installs Bun if missing and strips `ANTHROPIC_API_KEY` / `CLAUDECODE` from the Mnemosyne subprocess environment.
- **esbuild bundling** — TypeScript source is bundled to CJS for Node.js compatibility in the plugin environment.

## License

MIT
