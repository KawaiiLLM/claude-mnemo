# Claude-Mnemo

Structured memory system for Claude Code. Automatically extracts, stores, and retrieves durable observations from every conversation — so future sessions start with context, not from scratch.

## How It Works

Claude-Mnemo hooks into four points of the Claude Code lifecycle:

| Hook | Trigger | What it does |
|------|---------|--------------|
| **UserPromptSubmit** | Every user message | Initializes or resumes the session in the database |
| **Stop** | Agent finishes | Forks Mnemosyne (the observer agent) to extract structured observations from the conversation |
| **PreCompact** | Context compaction | Backfills pending turns before the transcript is compressed |
| **SessionStart** | Session begins/resumes | Injects recent memory context so the agent has continuity |

At the core is **Mnemosyne**, an observer agent built on the Claude Agent SDK. It reads the conversation transcript and extracts a three-layer data model:

```
Session (one per conversation)  →  [S12]
  Turn (one per QA round)       →  [T2]
    Observation (notable event) →  [O7]
```

Observations are typed: 🔴 bugfix, 🟣 feature, 🔄 refactor, ✅ change, 🔵 discovery, ⚖️ decision.

## Installation

In Claude Code, add the marketplace and install:

```
/plugin marketplace add KawaiiLLM/claude-mnemo
/plugin install claude-mnemo
```

Bun is the only runtime dependency — `bun-runner.js` auto-installs it if missing.
Marketplace and source installs ship with prebuilt `plugin/scripts/*.cjs` entrypoints, so hooks and MCP can run without a post-install build.

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

Once installed, Claude-Mnemo works automatically. No manual invocation needed — hooks fire on every session.

### Recall: Structured Memory Search

Browse and drill into past work through the `recall` MCP tool:

```
recall(scope="sessions")                                        → recent sessions
recall(scope="sessions", query="auth race")                     → full-text search
recall(scope="turns", session=12)                               → turns in a session
recall(scope="turns", session=12, depth="expanded")             → session turns with prompt/response
recall(scope="observations", session=12, turn=2)                → observations for a turn
recall(scope="observations", obs=7)                             → full detail for one observation
recall(scope="observations", type="bugfix", file="src/auth.ts") → filter by type and file
```

Observation IDs are global SQLite row IDs. Use `[O7]` directly in follow-up `recall(scope="observations", obs=7)` calls.

Legacy aliases like `observation`, `from_epoch`, `to_epoch`, `expand_turns`, and `around` still resolve during migration, but `scope`-based calls are the canonical API.

### Replay: Raw Transcript Playback

When exact wording matters, use `replay`:

```
replay(session=12)                → turn overview
replay(session=12, turn=2)        → full prompt + response + tool calls
replay(session=12, turn=2, full=true) → no truncation
```

### SessionStart Context

On every session start, Claude-Mnemo injects a graduated-depth summary:

- **Current session** — fully expanded, last 3 turns with observations
- **Next 2 recent sessions** — collapsed headers with up to 5 turns each
- **Last 2 sessions** — header only

## Project Structure

```
src/
├── db/            # SQLite schema, sessions, turns, observations, FTS5
├── hooks/         # Hook handlers (session-init, stop, compact, context)
├── mcp/           # MCP server, recall, replay, format renderer
├── mnemosyne/     # Observer agent prompt and fork logic
├── shared/        # Transcript parser, logger, paths, constants
└── utils/         # Hashing, token estimation, worktree detection

plugin/            # Built artifacts installed into Claude Code
├── hooks/         # hooks.json (lifecycle bindings)
├── scripts/       # bun-runner.js, hook-command.cjs, mcp-server.cjs
├── skills/        # /mnemo skill for interactive memory search
└── CLAUDE.md      # Plugin-level instructions injected into context

tests/             # Mirrors src/ structure
docs/              # Design specs and implementation plans
```

## Development

```bash
# Run all tests
bun test

# Run a specific test file
bun test tests/mcp/format.test.ts

# Type check
npm run typecheck

# Build plugin artifacts
npm run build
```

### Data Model

The SQLite database lives at `~/.claude-mnemo/claude-mnemo.db` with three core tables:

| Table | Key fields | Purpose |
|-------|-----------|---------|
| `sessions` | `content_session_id`, `title`, `description`, `insight`, `next_steps` | One row per conversation |
| `turns` | `session_id`, `prompt_number`, `user_prompt`, `assistant_response`, `tool_call_count` | One row per QA round |
| `observations` | `turn_id`, `type`, `title`, `narrative`, `facts`, `concepts` | Notable events within a turn |

Full-text search is powered by an FTS5 virtual table (`memory_fts`) indexing across all three layers.

### Architecture Decisions

- **Bun runtime** — hooks and MCP server run under Bun for native SQLite and fast startup. A `bun-runner.js` shim auto-installs Bun if missing.
- **esbuild bundling** — TypeScript source is bundled to CJS for Node.js compatibility in the plugin environment.
- **Replay-compatible backfill** — a single `parseReplayTranscript` pass handles both Stop and PreCompact, ensuring consistent turn numbering even with sidechain (undo) history.
- **Observer isolation** — Mnemosyne runs as a forked Claude Agent SDK process, separate from the main conversation agent. It reads the transcript but never interferes with the user's session.

## License

MIT
