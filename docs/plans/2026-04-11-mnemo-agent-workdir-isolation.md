# Spec: Mnemosyne Agent Workdir Isolation + Native Resume

Date: 2026-04-11

Prerequisite: none. This spec ships **before** `docs/plans/2026-04-11-compact-anchor-and-debug-docs.md` so that the follow-up spec's README/design.md updates can use the final paths from the start.

## Context

### Finding 1 — Current `cwd` choice causes real data pollution 🔴

`src/worker/query-session.ts:205` passes `cwd: input.project` (the user's real project directory) to the Claude Agent SDK `query()`. The SDK then derives its session storage path from `cwd` using the encoding `/` → `-` applied to the full absolute path, and writes the Mnemosyne agent transcript to:

```
~/.claude/projects/<encodeProjectPath(input.project)>/<agent-session-id>.jsonl
```

**Observation on a real machine** (2026-04-11 `ls ~/.claude/projects/`):

```
-Users-zhaoqixuan                            ← user's sessions when running `claude` from ~
-Users-zhaoqixuan-Downloads                  ← user's sessions from ~/Downloads
-Users-zhaoqixuan-Projects-claude-mnemo      ← user's sessions from the claude-mnemo project
-Users-zhaoqixuan-Projects-KawaiiLLM         ← user's sessions from KawaiiLLM project
...
```

When the user runs Claude Code from home and that session triggers claude-mnemo, `input.project` is `/Users/zhaoqixuan` and the Mnemosyne agent jsonl lands in `~/.claude/projects/-Users-zhaoqixuan/` — **the same directory that contains the user's real Claude Code sessions**. Evidence: the archived Mnemosyne session at `~/.claude-mnemo/sessions/01ee24f0-6ac5-4764-b1c5-985582677d18.jsonl` has `cwd: "/Users/zhaoqixuan"` recorded in every user entry, and that jsonl was temporarily written to `~/.claude/projects/-Users-zhaoqixuan/01ee24f0-....jsonl` before being rename'd out by `moveAgentSession()`.

**`moveAgentSession()` (`src/worker/agent-session.ts:144-168`) is a post-write rename shuttle** that moves the jsonl from the SDK's default location into `~/.claude-mnemo/sessions/`. It works, but:

1. **There is a short pollution window** between SDK write and rename. If the rename fails for any reason (disk full, EPERM, worker crash between write and rename, rename interrupted by SIGKILL) the Mnemosyne jsonl is **permanently left** in `~/.claude/projects/-Users-zhaoqixuan/` as an orphan, indistinguishable from the user's real sessions to any tool that walks that directory (e.g. `claude --resume`, third-party dashboards, session browsers).
2. **The rename is the sole reason Mnemosyne cannot natively resume its conversation history.** The SDK's `query({ resume: <agent-session-id> })` expects the jsonl at the SDK's default location, but `moveAgentSession` has already moved it to `~/.claude-mnemo/sessions/`. Resume would require shuttling the file back before `query()` and then moving it out again on close — race-prone and complex.

### Finding 2 — The SDK is not hardcoded to `~/.claude/projects/`

During investigation of Finding 1 I initially claimed the SDK hard-codes session storage under `~/.claude/projects/`. **This was wrong.** Reading the SDK's bundled CLI (`node_modules/@anthropic-ai/claude-agent-sdk/cli.js`) reveals:

```javascript
function yQ() {
  return process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude");
}
```

The `~/.claude` base directory is configurable via the `CLAUDE_CONFIG_DIR` environment variable. Setting `CLAUDE_CONFIG_DIR=~/.claude-mnemo` would redirect session storage to `~/.claude-mnemo/projects/<encoded-cwd>/<id>.jsonl`, bypassing the pollution problem entirely.

**However, `CLAUDE_CONFIG_DIR` is not usable for claude-mnemo.** The same cli.js contains a function `bl()` that computes the OAuth keychain entry name:

```javascript
function bl(A = "") {
  let Q = yQ();
  let G = !process.env.CLAUDE_CONFIG_DIR ? "" : `-${sha256(Q).substring(0, 8)}`;
  return `Claude Code${OAUTH_FILE_SUFFIX}${G}${A}`;
}
```

When `CLAUDE_CONFIG_DIR` is set, the OAuth keychain entry name gets suffixed with `-<sha256 of config dir>`. Since `src/mnemosyne/env.ts:1` explicitly blocks `ANTHROPIC_API_KEY`, Mnemosyne subprocesses rely entirely on OAuth credentials from the user's main Claude Code login — stored under the unsuffixed `"Claude Code<suffix>"` keychain entry. Setting `CLAUDE_CONFIG_DIR` would point the subprocess at a non-existent keychain entry and break authentication.

See the "Rejected alternatives" section for the full analysis.

### The correct fix

The minimal change that **eliminates collision with real project directories** without touching authentication is to **change `cwd` to the claude-mnemo data directory** (`DATA_DIR` = `~/.claude-mnemo`):

1. SDK writes to `~/.claude/projects/-Users-zhaoqixuan-.claude-mnemo/<agent-session-id>.jsonl`
2. This is a **dedicated pseudo-project directory** — the encoded path `-Users-zhaoqixuan-.claude-mnemo` can only be produced by `cwd = ~/.claude-mnemo`, and no real user project has that cwd (home-level dotfile directories aren't valid Claude Code session roots). Any Mnemosyne jsonl found under this directory is unambiguously a Mnemosyne agent transcript, not a user session.
3. The directory name is **stable across all user projects** — every Mnemosyne session, regardless of which user project triggered it, lands in the same `-Users-zhaoqixuan-.claude-mnemo` folder
4. `moveAgentSession` becomes unnecessary — Mnemosyne jsonl can live permanently at the SDK default location, since the SDK default location IS the dedicated Mnemosyne workdir
5. Removing `moveAgentSession` **unlocks native SDK resume**: `query({ resume: lastAgentSessionId })` finds the file at the expected SDK path

**Honest scope caveat**: this does **not** remove Mnemosyne's footprint from `~/.claude/projects/` entirely — the pseudo-project directory is still a direct child of `~/.claude/projects/`, and any tool that enumerates the full projects tree (e.g. a session browser that walks every subdirectory) will still see an extra entry named `-Users-zhaoqixuan-.claude-mnemo`. The fix **isolates Mnemosyne sessions into a dedicated pseudo-project directory** so they never collide with real user projects; it does not make them invisible to tree-walking tools. Escaping the `~/.claude/projects/` tree entirely would require `CLAUDE_CONFIG_DIR` (rejected — see Rejected alternatives) or a self-managed jsonl writer (rejected — loses resume).

### Token / latency impact

Native resume restores Mnemosyne's KV cache between worker restarts. Previously, every worker idle-close (30 min watchdog) or worker crash started a fresh query() with an empty conversation history. With resume:

- **Cold boot after idle close** (currently ~1 per day in typical use): SDK replays the prior jsonl and warm-starts the KV cache. The first message after resume re-pays a small cache-miss on the initial system prompt and the most recent messages that weren't cached, but avoids re-sending the full history (which would otherwise go in as a fresh init message).
- **Mnemosyne's "I already saw obs O5, T3, ..." memory** is preserved in conversation history, not just via the DB's structured records. This lets future refinements reference earlier decisions without needing `recall()`/`replay()` round trips.
- No change during a single warm runtime (resume only affects reconnection behavior).

Expected saving: ~3-5k tokens per resume event, plus the soft benefit of continuity. Not the primary motivation (which is pollution fix) but a real bonus.

---

## Non-goals / Out of scope

- **Updating existing orphan files under `~/.claude/projects/`** — if the user has orphan Mnemosyne jsonl files left over from failed `moveAgentSession` calls, this spec does not automatically detect and clean them. Users with known orphans can manually inspect and `rm` them. Detecting orphans reliably would require parsing every jsonl under `~/.claude/projects/` and checking the `cwd` field for `claude-mnemo` — heavy, out of scope.
- **Preserving existing archived sessions at `~/.claude-mnemo/sessions/`** — the spec directs users to `rm -rf ~/.claude-mnemo/sessions/` manually after the upgrade. The one file currently there (134KB, 2026-04-10 test session) has no structured downstream consumer; users who want to keep it as a historical artifact should `mv` it somewhere before rm'ing the directory. A migration script is not worth 30+ lines of code for a single file.
- **`CLAUDE_CONFIG_DIR` redirection** — rejected due to OAuth keychain coupling (see Rejected alternatives).
- **Fallback to fresh session when the archive file is deleted mid-flight** — the spec implements a pre-check (`existsSync` on the expected path) before passing `resume`, but does not implement mid-stream recovery (if SDK fails during resume, the error propagates as-is). Mid-stream recovery is a future hardening item.
- **Settings file loading through `CLAUDE_CONFIG_DIR`-related paths** — not applicable since we don't use `CLAUDE_CONFIG_DIR`.
- **Retention / auto-cleanup of the new `~/.claude/projects/-Users-zhaoqixuan-.claude-mnemo/` directory** — will grow unbounded, same as the old `~/.claude-mnemo/sessions/` did. Out of scope.

---

## Core constraints

- **Do not touch authentication**: `CLAUDE_CONFIG_DIR` must remain unset for the Mnemosyne subprocess. The only env changes allowed are what `buildIsolatedEnv()` already does.
- **`cwd` must be a directory that exists** — treat this as an **implementation requirement**, not an inherited guarantee. The worker query path must explicitly `mkdirSync(DATA_DIR, { recursive: true })` before constructing the SDK `query()` call. Other callers (e.g., `src/shared/logger.ts:14-17`) do create `DATA_DIR` incidentally, but (1) load order is not guaranteed — the worker could in principle initialize before any logger write, and (2) relying on side effects from unrelated modules is fragile. The explicit `mkdirSync` is cheap (single syscall, `{ recursive: true }` is idempotent) and makes the invariant local to the code that depends on it.
- **`input.project` stays meaningful**: it continues to be passed as `defaultProject` to `createMnemoSdkServer` (for DB filter semantics) and as the `project` field in prompt builders (for the `<session id="S..."><project>` data block). Only the SDK-level `cwd` decouples.
- **Resume must be best-effort, not all-or-nothing**: if the stored `lastAgentSessionId` points at a file that no longer exists, fall back to fresh (no `resume` in `query()` options). Never block session startup because of a missing archive.
- **`last_agent_session_id` is persisted on first observed SDK session id**, not on close. This ensures crash recovery works: even if the worker crashes mid-query, the next wake can attempt resume from the ID that was already persisted.
- **Schema migration must be non-destructive**: add the column via `ALTER TABLE ... ADD COLUMN` guarded by `hasColumn()` check, consistent with the project's existing incremental-column pattern (`ensureSessionProjectIndex`, `ensureTurnPromptIdIndex` in `src/db/schema.ts`).
- **All existing tests stay green** — no regressions.

---

## Changes

### 1. `src/db/schema.ts` — Add `last_agent_session_id` column

**Location**: `SCHEMA_SQL` constant (lines 5-18, sessions table definition) and `initializeSchema()` function (line 112).

**1a. Add column to the canonical CREATE TABLE**

**Current** (lines 5-18):

```typescript
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_session_id TEXT UNIQUE NOT NULL,
    project TEXT NOT NULL,
    title TEXT,
    content TEXT,
    insight TEXT,
    next_steps TEXT,
    last_compact_turn INTEGER,
    created_at_epoch INTEGER NOT NULL,
    updated_at_epoch INTEGER,
    completed_at_epoch INTEGER
  );
  ...
```

**New**:

```typescript
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS sessions (
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
  ...
```

**1b. Add incremental migration helper**

**Location**: new function placed next to `ensureSessionProjectIndex` (around line 118).

**Add**:

```typescript
function ensureSessionLastAgentSessionIdColumn(db: Database): void {
  if (hasColumn(db, "sessions", "last_agent_session_id")) {
    return;
  }
  db.exec("ALTER TABLE sessions ADD COLUMN last_agent_session_id TEXT");
}
```

**1c. Wire the helper into `initializeSchema`**

**Current** (lines 112-116):

```typescript
export function initializeSchema(db: Database): void {
  db.exec(SCHEMA_SQL);
  ensureSessionProjectIndex(db);
  ensureTurnPromptIdIndex(db);
}
```

**New**:

```typescript
export function initializeSchema(db: Database): void {
  db.exec(SCHEMA_SQL);
  ensureSessionProjectIndex(db);
  ensureTurnPromptIdIndex(db);
  ensureSessionLastAgentSessionIdColumn(db);
}
```

**Why this pattern, not `resetSchema`**: `hasLegacySchema` is based on specific historical column names (e.g. `description`, `started_at_epoch`) and will not fire on a forward-compat missing column. Triggering a reset for the new column would wipe all of the user's existing memory data, which is unacceptable. The `ensure*` pattern already exists in the file for the `content_prompt_id` column and `idx_sessions_project_created_at` index — we reuse it.

### 2. `src/db/sessions.ts` — Read and write the new column

**Location**: `SessionRecord` interface (lines 5-17), `SESSION_SELECT` constant (lines 37-51), and a new `updateLastAgentSessionId` function.

**2a. Extend the DTO**

**Current** (lines 5-17):

```typescript
export interface SessionRecord {
  id: number;
  contentSessionId: string;
  project: string;
  title: string | null;
  content: string | null;
  insight: string | null;
  nextSteps: string | null;
  lastCompactTurn: number | null;
  createdAtEpoch: number;
  updatedAtEpoch: number | null;
  completedAtEpoch: number | null;
}
```

**New**:

```typescript
export interface SessionRecord {
  id: number;
  contentSessionId: string;
  project: string;
  title: string | null;
  content: string | null;
  insight: string | null;
  nextSteps: string | null;
  lastCompactTurn: number | null;
  lastAgentSessionId: string | null;
  createdAtEpoch: number;
  updatedAtEpoch: number | null;
  completedAtEpoch: number | null;
}
```

**2b. Extend the SELECT clause**

**Current** (lines 37-51):

```typescript
const SESSION_SELECT = `
  SELECT
    id,
    content_session_id AS contentSessionId,
    project,
    title,
    content,
    insight,
    next_steps AS nextSteps,
    last_compact_turn AS lastCompactTurn,
    created_at_epoch AS createdAtEpoch,
    updated_at_epoch AS updatedAtEpoch,
    completed_at_epoch AS completedAtEpoch
  FROM sessions
`;
```

**New**:

```typescript
const SESSION_SELECT = `
  SELECT
    id,
    content_session_id AS contentSessionId,
    project,
    title,
    content,
    insight,
    next_steps AS nextSteps,
    last_compact_turn AS lastCompactTurn,
    last_agent_session_id AS lastAgentSessionId,
    created_at_epoch AS createdAtEpoch,
    updated_at_epoch AS updatedAtEpoch,
    completed_at_epoch AS completedAtEpoch
  FROM sessions
`;
```

**2c. Also extend the `RETURNING` clause of `upsertSession`**

**Location**: lines 82-94 (and again at lines ~100-115 if there's a second SELECT via `getSession`, which there is — update both RETURNING/SELECT column lists to match).

**New column to add in each place**:

```sql
last_agent_session_id AS lastAgentSessionId,
```

Positioned after `last_compact_turn AS lastCompactTurn,` and before `created_at_epoch AS createdAtEpoch,`.

**Note**: `upsertSession` does not need to write `last_agent_session_id` — this column is only written by the worker on first SDK message receive (see §4b). `upsertSession`'s INSERT/UPDATE statements can leave the column as its default NULL. Do NOT add `last_agent_session_id` to the INSERT column list or the `ON CONFLICT DO UPDATE` clause — those paths are called from `session-init.ts` with hook-side data that has no knowledge of the agent session id.

**2d. Add `updateLastAgentSessionId` function**

**Location**: new exported function, placed next to `updateCompactAnchor` (around line 161).

**Add**:

```typescript
export function updateLastAgentSessionId(
  db: Database,
  sessionId: number,
  agentSessionId: string,
): void {
  db.query(
    `UPDATE sessions
     SET last_agent_session_id = ?
     WHERE id = ?`,
  ).run(agentSessionId, sessionId);
}
```

Idempotent by construction — writing the same value twice is a no-op. Callers in §4 do not need to pre-check whether the value changed.

### 3. `src/worker/query-session.ts` — Sentinel cwd + resume support

**Location**: imports (lines 1-22), `WorkerQuerySessionInput` interface (line 35), `createWorkerQuerySession` body (line ~180), and the `query()` call (line 201).

**3a. Update imports**

**Current** (lines 1-22):

```typescript
import { spawn } from "node:child_process";

import type { Database } from "bun:sqlite";

import {
  createSdkMcpServer,
  query,
  tool,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { MNEMO_ALLOWED_TOOLS } from "../mcp/definitions";
import {
  createMnemoSdkServer,
  moveAgentSession,
  resolveClaudeCodeExecutablePath,
} from "./agent-session";
import { getSession } from "../db/sessions";
import { buildIsolatedEnv } from "../mnemosyne/env";
```

**New**:

```typescript
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";

import type { Database } from "bun:sqlite";

import {
  createSdkMcpServer,
  query,
  tool,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { MNEMO_ALLOWED_TOOLS } from "../mcp/definitions";
import {
  createMnemoSdkServer,
  resolveClaudeCodeExecutablePath,
} from "./agent-session";
import { getSession } from "../db/sessions";
import { buildIsolatedEnv } from "../mnemosyne/env";
import { DATA_DIR, resolveTranscriptPath } from "../shared/paths";
```

Note: `moveAgentSession` import is removed. `DATA_DIR` and `resolveTranscriptPath` are added. `existsSync` and `mkdirSync` are added (for the resume pre-check and to ensure `DATA_DIR` exists before using it as `cwd` — see 3e below).

**3b. Add resume option to `WorkerQuerySessionInput`**

**Current** (lines 35-41):

```typescript
export interface WorkerQuerySessionInput {
  db: Database;
  sessionDbId: number;
  contentSessionId: string;
  project: string;
  systemPrompt?: string;
}
```

**New**:

```typescript
export interface WorkerQuerySessionInput {
  db: Database;
  sessionDbId: number;
  contentSessionId: string;
  project: string;
  /**
   * Previously-closed Mnemosyne agent session id to resume. When provided AND
   * the expected jsonl file exists at the SDK default path, the SDK will reload
   * the prior conversation history. When the file is missing, the worker falls
   * back to a fresh query silently.
   */
  resumeAgentSessionId?: string | null;
  systemPrompt?: string;
}
```

**3c. Remove `moveAgentSessionImpl` from deps**

**Current** (lines 43-53):

```typescript
export interface WorkerQuerySessionDeps {
  queryImpl?: typeof query;
  createSdkMcpServerImpl?: typeof createSdkMcpServer;
  toolImpl?: typeof tool;
  spawnImpl?: typeof spawn;
  moveAgentSessionImpl?: typeof moveAgentSession;
  killImpl?: typeof process.kill;
  isProcessAliveImpl?: (pid: number) => boolean;
  onMessage?: (message: SDKMessage) => void;
  onPid?: (pid: number | undefined) => void;
}
```

**New**:

```typescript
export interface WorkerQuerySessionDeps {
  queryImpl?: typeof query;
  createSdkMcpServerImpl?: typeof createSdkMcpServer;
  toolImpl?: typeof tool;
  spawnImpl?: typeof spawn;
  killImpl?: typeof process.kill;
  isProcessAliveImpl?: (pid: number) => boolean;
  onMessage?: (message: SDKMessage) => void;
  onPid?: (pid: number | undefined) => void;
}
```

**3d. Remove the default `moveAgentSessionImpl` wiring**

**Current** (around line 182):

```typescript
  const toolImpl = deps.toolImpl ?? tool;
  const spawnImpl = deps.spawnImpl ?? spawn;
  const moveAgentSessionImpl = deps.moveAgentSessionImpl ?? moveAgentSession;
  const killImpl = deps.killImpl ?? process.kill;
```

**New**:

```typescript
  const toolImpl = deps.toolImpl ?? tool;
  const spawnImpl = deps.spawnImpl ?? spawn;
  const killImpl = deps.killImpl ?? process.kill;
```

**3e. Compute resume eligibility and change cwd**

**Location**: inside `createWorkerQuerySession`, immediately before the `query()` call (line ~201).

**Current** (lines 196-209):

```typescript
  let sessionId: string | null = null;
  let queryPid: number | undefined;
  let closed = false;
  let closePromise: Promise<void> | null = null;

  const execution: Query = queryImpl({
    prompt: promptStream,
    options: {
      model: "claude-sonnet-4-6",
      cwd: input.project,
      allowedTools: [...MNEMO_ALLOWED_TOOLS],
      mcpServers,
      pathToClaudeCodeExecutable,
      abortController,
```

**New**:

```typescript
  // Ensure DATA_DIR exists before using it as the SDK cwd. Idempotent; cheap
  // (single syscall). Required even though other modules incidentally create
  // the directory — see "Core constraints" above.
  mkdirSync(DATA_DIR, { recursive: true });

  const resumeCandidate = input.resumeAgentSessionId ?? null;
  const resumeTarget =
    resumeCandidate &&
    existsSync(resolveTranscriptPath(DATA_DIR, resumeCandidate))
      ? resumeCandidate
      : null;

  let sessionId: string | null = resumeTarget;
  let queryPid: number | undefined;
  let closed = false;
  let closePromise: Promise<void> | null = null;

  const execution: Query = queryImpl({
    prompt: promptStream,
    options: {
      model: "claude-sonnet-4-6",
      cwd: DATA_DIR,
      ...(resumeTarget ? { resume: resumeTarget } : {}),
      allowedTools: [...MNEMO_ALLOWED_TOOLS],
      mcpServers,
      pathToClaudeCodeExecutable,
      abortController,
```

**Rationale for `sessionId` initialization** (critical — do not change the order):

The `sessionId` variable is **not just a status getter** — `sendPrompt()` at `src/worker/query-session.ts:328` uses it to fill the `session_id` field of every pushed `SDKUserMessage`:

```typescript
promptStream.push(
  createUserMessage(promptText, sessionId ?? input.contentSessionId),
);
```

This means the initial value of `sessionId` **propagates into the first user message's metadata** before the SDK has a chance to overwrite it via the message loop. If we initialize `sessionId` to the raw `input.resumeAgentSessionId` unconditionally:

- **Resume hit** (file exists, `resume` passed to SDK): first message carries `resumeAgentSessionId` → consistent with the resumed query → SDK accepts → OK
- **Resume miss** (file missing, `resume` NOT passed to SDK): first message carries `resumeAgentSessionId` → inconsistent with the fresh query that the SDK is actually spawning → SDK sees a user message claiming to be from a nonexistent prior session → undefined behavior (at best, internal state corruption; at worst, the message is rejected)

The fix is to initialize `sessionId` to `resumeTarget`, NOT `resumeCandidate`:

- **Resume hit**: `resumeTarget` equals `resumeCandidate`, so `sessionId` pre-fills with the resume id and the first message's metadata matches the SDK's resumed session — consistent.
- **Resume miss**: `resumeTarget` is `null`, so `sessionId` starts `null`, and `sendPrompt()` falls back to `input.contentSessionId` for the first message's `session_id` field. The SDK then assigns a fresh agent session id via the message loop (line 290: `sessionId = message.session_id`), and `onMessage` in server.ts picks up the new id and persists it to the DB.
- **Cold boot** (no `resumeAgentSessionId`): `resumeTarget` is `null`, same fallback path as resume miss. Unchanged from current behavior.

**Ordering constraint**: `resumeTarget` must be computed **before** `sessionId` is declared, because `sessionId`'s initializer reads it. The block order is therefore:

1. `const resumeCandidate = ...`
2. `const resumeTarget = ... existsSync ...`
3. `let sessionId: string | null = resumeTarget;`
4. `let queryPid`, `let closed`, `let closePromise`

**Rationale for `existsSync` check**:

- The SDK's resume behavior on a missing file is not specified in the public types. Rather than risk a mid-stream failure, we pre-check: if the file isn't there, skip resume. This is the only safe place to do the check because we know the exact path (`resolveTranscriptPath(DATA_DIR, resumeCandidate)` matches the SDK's internal encoding since `DATA_DIR` is our cwd).
- `existsSync` is synchronous and cheap (single stat call), acceptable at session init time.
- **The `existsSync` check is load-bearing for correctness, not just graceful degradation.** Without it, the stale-id leak described above is unavoidable: we'd have no way to distinguish "resume will succeed" from "resume will silently fail" before pushing the first message.

**3f. Remove the `moveAgentSession` call in close()**

**Current** (lines 342-365):

```typescript
      closePromise = (async () => {
        try {
          await Promise.race([
            loopPromise,
            new Promise<void>((resolve) => {
              setTimeout(resolve, 5_000);
            }),
          ]);
        } catch {
          // close remains best-effort
        } finally {
          if (sessionId) {
            moveAgentSessionImpl(input.project, sessionId);
          }
          if (queryPid && isProcessAliveImpl(queryPid)) {
            try {
              killImpl(queryPid, "SIGKILL");
            } catch {}
          }
          queryPid = undefined;
        }
      })();
```

**New**:

```typescript
      closePromise = (async () => {
        try {
          await Promise.race([
            loopPromise,
            new Promise<void>((resolve) => {
              setTimeout(resolve, 5_000);
            }),
          ]);
        } catch {
          // close remains best-effort
        } finally {
          if (queryPid && isProcessAliveImpl(queryPid)) {
            try {
              killImpl(queryPid, "SIGKILL");
            } catch {}
          }
          queryPid = undefined;
        }
      })();
```

The entire `if (sessionId) { moveAgentSessionImpl(...); }` block is removed. The SDK writes the jsonl directly to `~/.claude/projects/-Users-zhaoqixuan-.claude-mnemo/<sessionId>.jsonl` and it stays there.

### 4. `src/worker/server.ts` — Wire resume into session creation and persist agent id

**Location**: `ensureQuerySession` (around line 298) and `getOrCreateSessionState`'s `pushMessage` closure (around line 283).

**4a. Read `lastAgentSessionId` in `ensureQuerySession`**

**Current** (lines 298-333):

```typescript
  function ensureQuerySession(state: SessionState): WorkerQuerySession {
    if (state.querySession) {
      return state.querySession;
    }

    const session = getSession(deps.db, state.sessionDbId);
    if (!session) {
      throw new Error(`Missing session ${state.sessionDbId} for worker query setup.`);
    }

    state.contentSessionId = session.contentSessionId;
    state.project = session.project;
    state.querySession = createWorkerQuerySessionImpl(
      deps.db,
      state.sessionDbId,
      session.project,
      {
        onMessage: (message) => {
          state!.lastMessageAt = nowMs();
          state!.lastActivity = nowMs();
          if (
            "session_id" in message &&
            typeof message.session_id === "string" &&
            message.session_id !== ""
          ) {
            state!.agentSessionId = message.session_id;
          }
        },
        onPid: (pid) => {
          state!.queryPid = pid;
        },
      },
    );

    return state.querySession;
  }
```

**New**:

```typescript
  function ensureQuerySession(state: SessionState): WorkerQuerySession {
    if (state.querySession) {
      return state.querySession;
    }

    const session = getSession(deps.db, state.sessionDbId);
    if (!session) {
      throw new Error(`Missing session ${state.sessionDbId} for worker query setup.`);
    }

    state.contentSessionId = session.contentSessionId;
    state.project = session.project;
    if (session.lastAgentSessionId) {
      state.agentSessionId = session.lastAgentSessionId;
    }
    state.querySession = createWorkerQuerySessionImpl(
      {
        db: deps.db,
        sessionDbId: state.sessionDbId,
        contentSessionId: session.contentSessionId,
        project: session.project,
        resumeAgentSessionId: session.lastAgentSessionId,
      },
      {
        onMessage: (message) => {
          state!.lastMessageAt = nowMs();
          state!.lastActivity = nowMs();
          if (
            "session_id" in message &&
            typeof message.session_id === "string" &&
            message.session_id !== ""
          ) {
            const newAgentSessionId = message.session_id;
            const isFirstObservation =
              state!.agentSessionId !== newAgentSessionId;
            state!.agentSessionId = newAgentSessionId;
            if (isFirstObservation) {
              try {
                updateLastAgentSessionId(
                  deps.db,
                  state!.sessionDbId,
                  newAgentSessionId,
                );
              } catch (error) {
                logger.error?.("updateLastAgentSessionId failed", {
                  sessionDbId: state!.sessionDbId,
                  error,
                });
              }
            }
          }
        },
        onPid: (pid) => {
          state!.queryPid = pid;
        },
      },
    );

    return state.querySession;
  }
```

**Call form**: `createWorkerQuerySession` already has a dual overload defined at `src/worker/query-session.ts:146-161` — an object-args form `(input: WorkerQuerySessionInput, deps?)` and a legacy positional form `(db, sessionDbId, project, deps?)`. The current server.ts call uses the 4-arg positional form. This spec **switches the call site to the object-args form** so that `resumeAgentSessionId` (a field on `WorkerQuerySessionInput`) can be passed through cleanly. No overload changes are needed — we just consume the existing object-args signature.

The positional overload remains available for any call sites that don't need resume (e.g. tests that explicitly avoid the DB path). If no other call sites remain after this change, consider removing the positional overload in a future cleanup — not required here.

**4b. Persist logic inside the `onMessage` callback**

Already included in §4a above. The `isFirstObservation` guard uses `state.agentSessionId !== newAgentSessionId` to detect the transition:

- **Fresh query** (no resume): `state.agentSessionId` starts `undefined` → first observation always triggers the DB write
- **Resume hit** (file exists): `state.agentSessionId` was pre-set to `session.lastAgentSessionId` → first SDK message carries the same id → `state.agentSessionId !== newAgentSessionId` is `false` → **no redundant DB write**
- **Resume miss** (file deleted): `state.agentSessionId` was pre-set to stale id → SDK issues a fresh id → mismatch → write new id

This gives crash-recovery correctness without redundant writes in the happy resume case.

**4c. Add the new import**

**Location**: `src/worker/server.ts` top imports.

**Current** (somewhere in the import block):

```typescript
import { getSession } from "../db/sessions";
```

**New**:

```typescript
import { getSession, updateLastAgentSessionId } from "../db/sessions";
```

### 5. `src/worker/agent-session.ts` — Delete `moveAgentSession` and all its deps

**Location**: lines 116-168 (the entire move block).

**Delete**:

- Lines 1-3 imports: remove `copyFileSync`, `renameSync`, `unlinkSync` from the `node:fs` import. Keep `existsSync` and `mkdirSync` if still referenced elsewhere in the file (they are — by `createMnemoSdkServer`). The `spawnSync` and `dirname` imports remain for `resolveClaudeCodeExecutablePath`.
- Line 23: remove `resolveAgentSessionPath` from the paths import. Keep `resolveTranscriptPath` (still used by `src/mcp/replay.ts` for user session lookup).
- Lines 116-134: the entire `MoveAgentSessionDeps` interface and `defaultMoveDeps` constant.
- Lines 136-142: `isExdevError` helper.
- Lines 144-168: the entire `moveAgentSession` function.

**After the delete**, the file should contain only:

- `findClaudeOnPath`, `resolveClaudeCodeExecutablePath` (lines 30-64)
- `createMnemoSdkServer`, `missingHandler` (lines 66-114)

Total file length after cleanup: ~114 lines (down from 168).

### 6. `src/shared/paths.ts` — Delete the `SESSIONS_DIR` constant and helper

**Location**: lines 23, 38-40.

**Delete**:

```typescript
// Line 23:
export const SESSIONS_DIR = join(DATA_DIR, "sessions");

// Lines 38-40:
export function resolveAgentSessionPath(sessionId: string): string {
  return join(SESSIONS_DIR, `${sessionId}.jsonl`);
}
```

**Keep**: `resolveTranscriptPath` (used by MCP replay), `encodeProjectPath` (used by `resolveTranscriptPath`), `DATA_DIR`, `WORKER_PID_PATH`, `WORKER_STARTING_PATH`, `resolveDatabasePath`.

**After the delete**, the file should be ~35 lines (down from 41).

### 7. `tests/worker/agent-session.test.ts` — Delete the file

This file tests `moveAgentSession` exclusively (`describe("moveAgentSession", ...)` as its only block per `tests/worker/agent-session.test.ts:49`). With `moveAgentSession` gone, the file has no reason to exist.

**Action**: `rm tests/worker/agent-session.test.ts`

**Note**: if this file also contains tests for other exports from `src/worker/agent-session.ts` (e.g. `resolveClaudeCodeExecutablePath`), keep those tests and delete only the `describe("moveAgentSession", ...)` block. Verify by reading the file before deletion.

### 8. `tests/worker/query-session.test.ts` — Remove `moveAgentSession` references

**Location**: line 8 (import), around line 196 (injection), line 219 (type assertion).

**8a. Remove import**

**Current** (line 8):

```typescript
import {
  createWorkerQuerySession,
  moveAgentSession,
  // ... other imports
} from "../../src/worker/query-session";
```

**New**:

```typescript
import {
  createWorkerQuerySession,
  // ... other imports
} from "../../src/worker/query-session";
```

**8b. Remove the `moveAgentSessionImpl` mock injection**

**Location**: around line 196 — the test that injects `moveAgentSessionImpl` to verify it gets called on close.

**Action**: delete the entire test block that asserts `moveAgentSessionImpl` was called. The behavior being tested no longer exists.

**8c. Remove the `typeof moveAgentSession` assertion**

**Location**: line 219.

**Action**: delete the single line `expect(typeof moveAgentSession).toBe("function");`.

### 9. Add resume-path tests to `tests/worker/query-session.test.ts`

**Location**: append to the existing `describe("createWorkerQuerySession", ...)` block.

**Add**:

```typescript
  test("passes resume option to query() when the archive file exists", async () => {
    const existingArchiveDir = await Bun.$`mktemp -d`.text();
    const archiveFile = join(existingArchiveDir.trim(), "resume-target.jsonl");
    await Bun.write(archiveFile, "");

    // Mock resolveTranscriptPath(DATA_DIR, ...) by mocking existsSync instead
    const existsCalls: string[] = [];
    const mockExistsSync = mock((path: string) => {
      existsCalls.push(path);
      return path.endsWith("resume-target.jsonl");
    });

    // NOTE: This test requires a way to inject existsSync. If the current
    // createWorkerQuerySession doesn't expose that as a dep, add
    // `existsSyncImpl?: (path: string) => boolean` to WorkerQuerySessionDeps
    // and default it to node:fs existsSync. The injection is minimal and
    // mirrors the pattern already in moveAgentSession's deps.

    let observedOptions: unknown;
    const queryImpl = mock((args: { options: unknown }) => {
      observedOptions = args.options;
      return (async function* () {})() as unknown as Query;
    }) as unknown as typeof query;

    createWorkerQuerySession(
      {
        db: inMemoryDb,
        sessionDbId: 1,
        contentSessionId: "content-1",
        project: "/tmp/project",
        resumeAgentSessionId: "resume-target",
      },
      { queryImpl, existsSyncImpl: mockExistsSync },
    );

    expect((observedOptions as { resume?: string }).resume).toBe("resume-target");
    expect((observedOptions as { cwd?: string }).cwd).toBe(DATA_DIR);
  });

  test("omits resume option when the archive file is missing", async () => {
    const mockExistsSync = mock(() => false);
    let observedOptions: unknown;
    const queryImpl = mock((args: { options: unknown }) => {
      observedOptions = args.options;
      return (async function* () {})() as unknown as Query;
    }) as unknown as typeof query;

    createWorkerQuerySession(
      {
        db: inMemoryDb,
        sessionDbId: 1,
        contentSessionId: "content-1",
        project: "/tmp/project",
        resumeAgentSessionId: "stale-id-whose-file-was-deleted",
      },
      { queryImpl, existsSyncImpl: mockExistsSync },
    );

    expect(observedOptions as { resume?: string }).not.toHaveProperty("resume");
    expect((observedOptions as { cwd?: string }).cwd).toBe(DATA_DIR);
  });

  test("omits resume option when no resumeAgentSessionId is provided", async () => {
    let observedOptions: unknown;
    const queryImpl = mock((args: { options: unknown }) => {
      observedOptions = args.options;
      return (async function* () {})() as unknown as Query;
    }) as unknown as typeof query;

    createWorkerQuerySession(
      {
        db: inMemoryDb,
        sessionDbId: 1,
        contentSessionId: "content-1",
        project: "/tmp/project",
      },
      { queryImpl },
    );

    expect(observedOptions as { resume?: string }).not.toHaveProperty("resume");
    expect((observedOptions as { cwd?: string }).cwd).toBe(DATA_DIR);
  });
```

**Implementation note for the test author**: these tests assume `createWorkerQuerySession` can accept `existsSyncImpl` as an injected dep. If the current implementation doesn't have it, add it to `WorkerQuerySessionDeps`:

```typescript
export interface WorkerQuerySessionDeps {
  // ... existing fields
  existsSyncImpl?: (path: string) => boolean;
}
```

And inside the function:

```typescript
const existsSyncImpl = deps.existsSyncImpl ?? existsSync;
// ...
const resumeTarget =
  resumeCandidate &&
  existsSyncImpl(resolveTranscriptPath(DATA_DIR, resumeCandidate))
    ? resumeCandidate
    : null;
```

This is a minimal dep addition — same pattern as `queryImpl` / `spawnImpl` / `killImpl` elsewhere in the file.

### 10. Add `last_agent_session_id` tests to `tests/db/sessions.test.ts`

**Location**: append to the existing `describe("sessions db", ...)` block.

**Add**:

```typescript
  test("fresh session defaults lastAgentSessionId to null, updateLastAgentSessionId writes and getSession reads it back", () => {
    const session = upsertSession(db, {
      contentSessionId: "content-resume-1",
      project: "claude-mnemo",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    // Default-NULL guard: verify SESSION_SELECT returns the new column
    // with a null default on freshly-inserted sessions. This also implicitly
    // guards the RETURNING clause in upsertSession against divergence —
    // if RETURNING and SELECT disagree on shape, the existing `toEqual(session)`
    // round-trip test at tests/db/sessions.test.ts:40-41 will also fail.
    expect(session.lastAgentSessionId).toBeNull();

    const before = getSession(db, session.id);
    expect(before?.lastAgentSessionId).toBeNull();

    updateLastAgentSessionId(db, session.id, "agent-session-xyz");

    const after = getSession(db, session.id);
    expect(after?.lastAgentSessionId).toBe("agent-session-xyz");
  });

  test("updateLastAgentSessionId overwrites a previous value", () => {
    const session = upsertSession(db, {
      contentSessionId: "content-resume-2",
      project: "claude-mnemo",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    updateLastAgentSessionId(db, session.id, "first-id");
    expect(getSession(db, session.id)?.lastAgentSessionId).toBe("first-id");

    updateLastAgentSessionId(db, session.id, "second-id");
    expect(getSession(db, session.id)?.lastAgentSessionId).toBe("second-id");
  });
```

Remember to add `updateLastAgentSessionId` to the import list at the top of the file.

### 11. Add schema migration test to `tests/db/schema.test.ts`

**Location**: append to the existing schema test suite.

**Add**:

```typescript
  test("ensureSessionLastAgentSessionIdColumn adds the column on legacy DBs missing it", () => {
    // Simulate a pre-migration DB by dropping the column after initial schema creation
    db.exec("ALTER TABLE sessions DROP COLUMN last_agent_session_id");

    const beforeColumns = db
      .query<{ name: string }, []>("SELECT name FROM pragma_table_info('sessions')")
      .all()
      .map((row) => row.name);
    expect(beforeColumns).not.toContain("last_agent_session_id");

    initializeSchema(db);

    const afterColumns = db
      .query<{ name: string }, []>("SELECT name FROM pragma_table_info('sessions')")
      .all()
      .map((row) => row.name);
    expect(afterColumns).toContain("last_agent_session_id");
  });

  test("ensureSessionLastAgentSessionIdColumn is idempotent", () => {
    // Running initializeSchema twice must not throw
    initializeSchema(db);
    expect(() => initializeSchema(db)).not.toThrow();
  });
```

**Note**: SQLite `ALTER TABLE ... DROP COLUMN` is supported since 3.35.0. Bun's bundled SQLite is newer than that. If the drop-column step fails in CI for environmental reasons, substitute it with a raw `CREATE TABLE` that omits the column, then copy rows over — same effect, more verbose.

### 12. `README.md` — Update debug path references

**Location**: the "Debugging Mnemosyne" section that will be added by the compact-anchor spec (`docs/plans/2026-04-11-compact-anchor-and-debug-docs.md` §3). Because **this spec ships first**, the compact-anchor spec's README section will be written with the new paths from the start — see §14 below for the coordination.

If there are **existing** README references to `~/.claude-mnemo/sessions/` predating this change, update them here. Search pattern: `grep -n '.claude-mnemo/sessions' README.md` — if any matches, replace them with `~/.claude/projects/-Users-zhaoqixuan-.claude-mnemo/` (parameterize the `-Users-zhaoqixuan-` part as `<encoded-home>` in docs since it varies by user).

### 13. `docs/design.md` — Update architecture description

**Location**: any existing text referencing `moveAgentSession`, `~/.claude-mnemo/sessions/`, or the old rename shuttle.

**Action**: replace with a description of the new direct-write architecture:

```markdown
### Mnemosyne agent session archive

Every `createWorkerQuerySession` spawns a fresh Claude Agent SDK `query()` session with `cwd` set to `~/.claude-mnemo` (the claude-mnemo data directory). The SDK writes a full JSONL transcript to `~/.claude/projects/<encodeProjectPath(~/.claude-mnemo)>/<agent-session-id>.jsonl` — on a typical macOS install, that path resolves to `~/.claude/projects/-Users-<username>-.claude-mnemo/<agent-session-id>.jsonl`.

**Why cwd is the data directory, not the user's project**:

- Previously, `cwd` was set to the user's real project path (`session.project`), which caused the SDK to write Mnemosyne transcripts into the same `~/.claude/projects/<encoded-real-project>/` directory that holds the user's own Claude Code sessions. This created a pollution window between SDK write and the `moveAgentSession` rename: any interruption during that window left an orphan Mnemosyne jsonl that was indistinguishable from a real user session.
- Setting `cwd` to `~/.claude-mnemo` directs the SDK to write into a dedicated, claude-mnemo-exclusive subdirectory of `~/.claude/projects/`. No real user project can collide (home-level dotfile directories aren't valid user projects), so the rename shuttle becomes unnecessary.
- The `~/.claude-mnemo/sessions/` directory that existed in earlier versions as the rename destination has been removed. Its contents were purely debug archives with no runtime consumer; users upgrading from a prior version should `rm -rf ~/.claude-mnemo/sessions/` manually.

**Why the move enables native resume**:

With the jsonl living permanently at the SDK's default path, `query({ resume: <agent-session-id> })` finds the file and replays the prior conversation history into the new query session's KV cache. The worker persists the most recent agent session id to `sessions.last_agent_session_id`, and on next wake reads it back in `ensureQuerySession()` to pass as `resumeAgentSessionId` to `createWorkerQuerySession`. The worker does a best-effort pre-check (`existsSync` on the expected path) before passing `resume` to the SDK; if the file is missing, it silently falls back to a fresh session.

**Why `CLAUDE_CONFIG_DIR` was not used**:

The SDK's CLI honors `CLAUDE_CONFIG_DIR` to relocate the entire `.claude/` base, which would let Mnemosyne write to `~/.claude-mnemo/projects/<encoded-cwd>/` directly and avoid the `~/.claude/projects/` tree entirely. However, the SDK's OAuth keychain entry name includes a hash suffix derived from `CLAUDE_CONFIG_DIR` when it is set, which would cause the Mnemosyne subprocess to look for credentials under a keychain entry that doesn't exist. Since `src/mnemosyne/env.ts:1` blocks `ANTHROPIC_API_KEY` as an alternative auth path, `CLAUDE_CONFIG_DIR` would break authentication for all Mnemosyne sessions. See `docs/plans/2026-04-11-mnemo-agent-workdir-isolation.md` Rejected alternatives section for details.
```

### 14. Interaction with `docs/plans/2026-04-11-compact-anchor-and-debug-docs.md`

This spec **must land before** the compact-anchor spec. The compact-anchor spec's §3 (README) and §4 (design.md) sections reference `~/.claude-mnemo/sessions/<session-id>.jsonl` in multiple places. Those references must be updated to use the new path **as part of the compact-anchor spec** — the compact-anchor spec has already been drafted with the old paths and will need a one-pass find-and-replace:

- Find: `~/.claude-mnemo/sessions/`
- Replace: `~/.claude/projects/-Users-<username>-.claude-mnemo/` (or `$(~/.claude/projects/$(encode-path $HOME/.claude-mnemo))/` as a shell-compatible form)

The compact-anchor spec's acceptance criterion #5 (every jq query runs cleanly against a real jsonl) remains valid — the jq queries only depend on the jsonl format, not its location.

---

## Rejected alternatives

### Alternative A: `CLAUDE_CONFIG_DIR` environment variable redirection

**The idea**: set `CLAUDE_CONFIG_DIR=~/.claude-mnemo` in the Mnemosyne subprocess env (via `buildIsolatedEnv`), so the SDK writes to `~/.claude-mnemo/projects/<encoded-cwd>/<id>.jsonl` and avoids `~/.claude/projects/` entirely.

**Why it doesn't work**: the SDK's CLI (`cli.js`, function `bl()`) computes the OAuth keychain entry name as `"Claude Code" + OAUTH_FILE_SUFFIX + (CLAUDE_CONFIG_DIR ? "-" + sha256(CLAUDE_CONFIG_DIR).slice(0, 8) : "")`. Setting `CLAUDE_CONFIG_DIR` appends an 8-char hash suffix to the keychain entry name, so the Mnemosyne subprocess would look for credentials under an entry that doesn't exist (the user's main Claude Code login stores credentials under the unsuffixed name). `src/mnemosyne/env.ts:1` blocks `ANTHROPIC_API_KEY`, so API key fallback isn't available either.

**Workarounds considered and rejected**:

1. Duplicate OAuth credentials under the hash-suffixed keychain entry. Requires platform-specific keychain manipulation (macOS `security` CLI, Linux `secret-tool`, Windows Credential Manager). Fragile and outside claude-mnemo's scope.
2. Un-block `ANTHROPIC_API_KEY` and require users to set one. Adds a required configuration step that defeats the "works out of the box" design principle.
3. Automate `claude login` into the alternate `CLAUDE_CONFIG_DIR`. Requires interactive browser flow — not viable for a silent background worker.

Sentinel cwd (this spec) achieves the same isolation goal at zero auth cost.

### Alternative B: Keep `moveAgentSession` and add resume via reverse-shuttle

**The idea**: before calling `query({ resume })`, copy the archived jsonl from `~/.claude-mnemo/sessions/<id>.jsonl` back to `~/.claude/projects/<encoded-cwd>/<id>.jsonl` so the SDK can find it. On close, `moveAgentSession` moves it back.

**Why it was rejected**:

1. **Timing races**: during the reverse-shuttle window, the file lives in the user's project directory and could be observed by concurrent `claude --resume` commands.
2. **Failure handling complexity**: what if the reverse-shuttle succeeds but the query() crashes mid-session? The file would remain in the wrong directory until the next close.
3. **cwd drift**: if the user renames or moves their project between sessions, `encodeProjectPath(project)` changes and the reverse-shuttle doesn't know where to put the file.
4. **It's strictly more code**: ~50 lines of shuttle logic + error recovery vs. ~5 lines for sentinel cwd.
5. **No upside**: both approaches support resume; sentinel cwd also eliminates the pollution window.

### Alternative C: `persistSession: false` + self-managed jsonl write

**The idea**: tell the SDK not to persist sessions, then pipe the `query()` stream to a file we write ourselves at `~/.claude-mnemo/sessions/<id>.jsonl`.

**Why it was rejected**:

1. **Loses resume permanently**: the SDK cannot resume from a file we wrote — it only knows its own format and location.
2. **Potential data loss**: the SDK may write internal events (like `queue-operation` entries observed in the actual jsonl) that are not emitted through the `query()` stream as `SDKMessage` objects. We would be writing a subset of what the SDK writes natively.
3. **More code for a worse archive**: the whole point of the archive is to be a complete, SDK-native debug trace. A self-managed write loses both completeness and resumability.

### Alternative D: Keep status quo, defer fix to a future spec

**The idea**: document the pollution risk as a known issue, ship nothing.

**Why it was rejected**: the pollution is real and ongoing — every Mnemosyne run briefly writes into `~/.claude/projects/-Users-zhaoqixuan/` (or whatever the user's cwd encodes to), and any `moveAgentSession` failure leaves an orphan. The fix is ~10 lines of net code. Not fixing it is technical debt compounding on every session.

---

## Tests

| File | Test | What it guards |
|---|---|---|
| `tests/db/sessions.test.ts` | `fresh session defaults lastAgentSessionId to null, updateLastAgentSessionId writes and getSession reads it back` | DB round-trip **and default-NULL on insert** (the `session.lastAgentSessionId` assertion before any write catches RETURNING/SELECT shape divergence early) |
| `tests/db/sessions.test.ts` | `updateLastAgentSessionId overwrites a previous value` | Idempotent overwrite semantics |
| `tests/db/schema.test.ts` | `ensureSessionLastAgentSessionIdColumn adds the column on legacy DBs missing it` | Non-destructive migration path |
| `tests/db/schema.test.ts` | `ensureSessionLastAgentSessionIdColumn is idempotent` | Safe to run on already-migrated DBs |
| `tests/worker/query-session.test.ts` | `passes resume option to query() when the archive file exists` | Happy resume path |
| `tests/worker/query-session.test.ts` | `omits resume option when the archive file is missing` | Fallback on missing archive |
| `tests/worker/query-session.test.ts` | `omits resume option when no resumeAgentSessionId is provided` | Cold boot path |
| `tests/worker/server.test.ts` (optional) | `ensureQuerySession persists first-observed agent session id to DB` | End-to-end persist flow |

**Explicit DTO-shape guard** — the existing `expect(getSession(db, session.id)).toEqual(session)` round-trip test at `tests/db/sessions.test.ts:40-41` implicitly guards against `upsertSession`'s `RETURNING` list and `getSession`'s `SESSION_SELECT` drifting out of sync. This test is **load-bearing** during this spec's implementation: if only one of the two column lists gets updated with `last_agent_session_id AS lastAgentSessionId`, this existing test will fail and catch the mistake. Do not delete or weaken it. (Any other test that constructs a partial `SessionRecord` literal for comparison would also need updating — grep `tests/` for hand-written `SessionRecord`-shaped object literals before running the suite.)

Existing tests that must remain green unchanged:

- All tests in `tests/db/sessions.test.ts` except the new additions
  - In particular, the `toEqual(session)` round-trip tests (e.g. line 40-41) must continue to pass — they are the DTO-shape guard above
- All `handleCompact`-related tests in `tests/worker/server.test.ts`
- All MCP tool tests (`tests/mcp/*.test.ts`) — no changes to recall/replay/remember semantics
- All hook handler tests (`tests/hooks/*.test.ts`) — no changes to hook surface

Tests that are **deleted**:

- `tests/worker/agent-session.test.ts` (entire file, or just the `describe("moveAgentSession", ...)` block if other exports are tested there)
- The `moveAgentSessionImpl` injection test and assertion in `tests/worker/query-session.test.ts`

Test baseline at HEAD `82b027c` is **183 pass**. After this spec: **net delta +6 to +8 tests** (add ~10, delete ~2-4). The invariant is `0 fail` and a net positive count; verify delta, not absolute.

---

## Implementation order

1. **Schema migration** (§1): edit `src/db/schema.ts` to add the column to `SCHEMA_SQL` and add `ensureSessionLastAgentSessionIdColumn`. Wire into `initializeSchema`.
2. **DB DTO + helper** (§2): extend `SessionRecord`, `SESSION_SELECT`, and all `RETURNING` clauses in `src/db/sessions.ts`. Add `updateLastAgentSessionId` function.
3. **Schema tests** (§11): add the two migration tests to `tests/db/schema.test.ts`. Run `bun test tests/db/schema.test.ts` — expect all pass.
4. **DB helper tests** (§10): add the two `updateLastAgentSessionId` tests to `tests/db/sessions.test.ts` (the first test also asserts `session.lastAgentSessionId === null` immediately after `upsertSession` — this is the default-NULL + RETURNING-shape guard). Before running, `grep` the test file for any hand-written `SessionRecord`-shaped object literals that might need the new field. Run `bun test tests/db/sessions.test.ts` — expect all pass, including the pre-existing `toEqual(session)` round-trip test at line 40-41 which implicitly guards RETURNING/SELECT consistency.
5. **Query-session rewrite** (§3): refactor `src/worker/query-session.ts`:
   - Update imports (remove `moveAgentSession`, add `existsSync`, `mkdirSync`, `DATA_DIR`, `resolveTranscriptPath`)
   - Add `resumeAgentSessionId` to `WorkerQuerySessionInput`
   - Add `existsSyncImpl` to `WorkerQuerySessionDeps`
   - Remove `moveAgentSessionImpl` dep
   - Add `mkdirSync(DATA_DIR, { recursive: true })` immediately before the `resumeCandidate`/`resumeTarget` computation
   - Compute `resumeTarget` with `existsSync` check
   - Change `cwd: input.project` → `cwd: DATA_DIR`
   - Conditionally spread `resume: resumeTarget` into options
   - Remove the `moveAgentSessionImpl(input.project, sessionId)` call in the close finally
6. **Query-session test cleanup** (§8): update `tests/worker/query-session.test.ts` — remove `moveAgentSession` import, remove injection test, remove type assertion.
7. **Query-session resume tests** (§9): add the three new resume-path tests. Run `bun test tests/worker/query-session.test.ts` — expect all pass.
8. **agent-session.ts cleanup** (§5): delete the move block from `src/worker/agent-session.ts`. Verify the file still compiles: `npm run typecheck`.
9. **paths.ts cleanup** (§6): delete `SESSIONS_DIR` and `resolveAgentSessionPath`. Verify no other code references them: `rg 'SESSIONS_DIR|resolveAgentSessionPath' src/` should return zero hits.
10. **agent-session.test.ts cleanup** (§7): delete the file (or just the `describe("moveAgentSession", ...)` block).
11. **Server wiring** (§4): edit `src/worker/server.ts`:
    - Add `updateLastAgentSessionId` to the `db/sessions` import
    - In `ensureQuerySession`, read `session.lastAgentSessionId` and pre-set `state.agentSessionId`
    - Wire `resumeAgentSessionId` into the `createWorkerQuerySessionImpl` call
    - Add the `isFirstObservation` guard and `updateLastAgentSessionId` call in the `onMessage` callback
12. **Full test run**: `bun test` — expect `0 fail` and a net positive test count vs baseline (183 pass + ~6-8 new − ~2-4 deleted = ~187-189 pass).
13. **Typecheck**: `npm run typecheck` — expect clean.
14. **Build**: `npm run build` — expect `plugin/scripts/worker.cjs` / `hook-command.cjs` / `mcp-server.cjs` to be refreshed.
15. **Verify bundle**: `grep -c 'DATA_DIR' plugin/scripts/worker.cjs` (expect a reasonable number), `grep -c 'moveAgentSession' plugin/scripts/worker.cjs` (expect 0), `grep -c 'last_agent_session_id' plugin/scripts/worker.cjs` (expect ≥ 3).
16. **Manual data cleanup** (one-time): `rm -rf ~/.claude-mnemo/sessions/`. Any orphans in `~/.claude/projects/-Users-zhaoqixuan/` that are actually Mnemosyne sessions can be identified by grepping their jsonl content for `"mcp__mnemo__"` and removed manually; automatic detection is out of scope.
17. **Docs updates** (§13): apply the design.md changes.
18. **Live smoke test**:
    - Build and install: `npm run build && <install command>`
    - Delete prior DB field state: manually `UPDATE sessions SET last_agent_session_id = NULL;` in the DB (or just let the new column start NULL for existing rows)
    - Trigger a real Mnemosyne session by running Claude Code with some tool use
    - Verify: `ls ~/.claude/projects/-Users-<username>-.claude-mnemo/` should contain a new `<agent-session-id>.jsonl`
    - Verify: `sqlite3 ~/.claude-mnemo/claude-mnemo.db "SELECT last_agent_session_id FROM sessions WHERE id = (SELECT MAX(id) FROM sessions);"` should return a matching agent session id
    - Wait for the worker idle watchdog to close the query session (or manually `pkill -TERM -f 'worker\.cjs'` and restart)
    - Trigger another message in the same main Claude Code session
    - Verify the new query session resumes: the `~/.claude/projects/-Users-<username>-.claude-mnemo/<id>.jsonl` file grows (appended to) rather than a new jsonl appearing
19. **Commit**: single commit titled `fix(worker): isolate Mnemosyne agent workdir and enable native resume`. Include design.md updates in the same commit.

---

## Acceptance criteria

- `bun test` → `0 fail`, net positive delta vs baseline 183
- `npm run typecheck` → clean (no output)
- `npm run build` → success, all three plugin scripts refreshed
- `grep -c moveAgentSession plugin/scripts/worker.cjs` → **0** (completely removed from bundle)
- `grep -c last_agent_session_id plugin/scripts/worker.cjs` → **≥ 3** (schema definition + SELECT + UPDATE)
- `grep -c DATA_DIR plugin/scripts/worker.cjs` → baseline + **≥ 1** (new reference in query-session.ts)
- After live smoke test:
  - New Mnemosyne jsonl files appear at `~/.claude/projects/-Users-<username>-.claude-mnemo/`, NOT at `~/.claude/projects/-Users-<username>/` or any user-project-encoded directory
  - `sessions.last_agent_session_id` is non-NULL for any session that has run Mnemosyne at least once
  - After forced query session close, subsequent messages in the same main session **resume** the existing agent session jsonl (file grows, no new file created under a different agent id)
- Manual inspection of `~/.claude-mnemo/sessions/` confirms it has been removed or is empty
- No new test failures in previously-green test files

---

## Risk notes

- **Schema migration on existing DBs**: the `ensureSessionLastAgentSessionIdColumn` helper uses `ALTER TABLE ADD COLUMN` which is SQLite-native and fast even on large tables (metadata-only operation). Users with years of accumulated memory data will not experience noticeable migration time.
- **First-run after upgrade**: sessions that existed before this spec have `last_agent_session_id = NULL`. On the first wake after upgrade, `ensureQuerySession` sees NULL → no resume attempted → fresh query session spawned. This is correct behavior — there's no prior Mnemosyne conversation to restore, only DB state. From the second wake onward, resume engages normally.
- **Orphans under `~/.claude/projects/<encoded-real-project>/`**: any Mnemosyne jsonl files that were moved-successfully-then-this-spec-broke-the-expectation (i.e., written before upgrade, never migrated) remain under their old paths and may be seen by `claude --resume` from those project directories. Cleaning them requires greping their content for `"mcp__mnemo__"` and removing matches — documented as a manual post-upgrade step but not automated here.
- **Loss of `~/.claude-mnemo/sessions/` historical archive**: users who were relying on that directory for human analysis (e.g., for the jq queries in the compact-anchor spec's README section) need to redirect their queries to the new path. The compact-anchor spec will ship with the new path from the start — there is no period where the documentation is stale.
- **Resume failing silently on stale DB + missing file**: if a user manually deletes a jsonl file from `~/.claude/projects/-Users-<username>-.claude-mnemo/` but leaves the DB row intact, the next wake will silently fall back to fresh (because of the `existsSync` pre-check). The DB row's `last_agent_session_id` will be overwritten by the next observed SDK message id. This is the intended behavior — log a warning but don't surface as an error. If deep diagnostics ever become needed, add a log line at the pre-check site.
- **SDK changes to resume format**: if a future SDK release changes the jsonl format incompatibly, existing archives may not be resumable. This is an upstream risk outside this spec's control. The `existsSync` pre-check is not deep validation — if the SDK rejects a file at parse time, the error will propagate. Mid-stream recovery is explicitly out of scope.
- **cwd affects `gitBranch` metadata in the jsonl**: currently Mnemosyne's jsonl entries include a `gitBranch` field reflecting the cwd project's git state. With cwd changed to `~/.claude-mnemo` (not a git repo), `gitBranch` becomes undefined. **No claude-mnemo code reads this field** (verified via `rg gitBranch src/`), so this is purely cosmetic. If any future tooling depends on it, extract branch info from `input.project` separately and record it elsewhere.
