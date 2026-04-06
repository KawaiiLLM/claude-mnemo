# Enrich Output Format and SessionStart Context Design

## Goal

Unify the output format across `recall`, `replay`, and the SessionStart context hook. Introduce emoji stats, emoji observation types, markdown list structure, and a consistent three-layer field specification. Add a `next_steps` field to sessions and a `tool_call_count` field to turns. Enrich the SessionStart context hook with graduated depth injection anchored on the current session.

## Scope

In scope:
- `format.ts` rewrite (recall default output)
- `FormattedTurn`, `FormattedSession`, `FormattedObservation` interface changes
- `recall.ts` output (inherits from format.ts)
- `replay.ts` turn overview format
- context hook output enrichment with truncation
- `next_steps` column on sessions table
- `tool_call_count` column on turns table
- schema migration safety
- `update_session` MCP tool schema
- Mnemosyne prompt guidance for `next_steps`
- tests and docs

Out of scope:
- semantic/vector search injection (future)
- per-prompt context injection at UserPromptSubmit
- Mnemosyne extraction logic changes (beyond `next_steps` guidance)
- replay turn detail format (raw transcript display)

## Three-Layer Field Specification

### Layer 1: Session

Collapsed (shown in `recall()`, context hook collapsed sessions):

```
- [Sx] title | 💬n 💡n | yyyy-mm-dd | project
  - desc: ...
```

Expanded (shown in `recall(session=x)`, context hook primary session):

```
- [Sx] title | 💬n 💡n | yyyy-mm-dd | project
  - desc: ...
  - insight:
    - ...
  - next_steps:
    - ...
  - turns...
```

### Layer 2: Turn

Collapsed (shown inside session view):

```
- [Tx] title | 💡n 📖n ✏️n 🔧n
  - desc: ...
```

Zero-value stats are omitted. For example, a turn with no modified files omits `✏️`.

Expanded (shown via `expand_turns` or `recall(session=x, turn=y)`):

```
- [Tx] title | 💡n 📖n ✏️n 🔧n
  - desc: ...
  - prompt: "..."
  - response: "..."
  - insight:
    - ...
  - observations...
```

### Layer 3: Observation

Collapsed (shown inside expanded turns):

```
- [Ox] 🔵 title
  - desc: ...
```

Expanded (shown via `recall(observation=x)`):

```
- [Ox] 🔵 title
  - desc: ...
  - narrative: ...
  - facts:
    - ...
  - concepts: ...
  - files: 📖 path/a.ts ✏️ path/b.ts
```

### Emoji Reference

Observation types:

| type | emoji |
|------|-------|
| bugfix | 🔴 |
| feature | 🟣 |
| refactor | 🔄 |
| change | ✅ |
| discovery | 🔵 |
| decision | ⚖️ |

Stats:

| stat | emoji | meaning |
|------|-------|---------|
| turns | 💬 | conversation rounds |
| observations | 💡 | notable events |
| files read | 📖 | files read |
| files modified | ✏️ | files modified |
| tool calls | 🔧 | tool call count |

### Field Visibility Rules

`desc` is always visible (part of collapsed form). All other detail fields (`insight`, `next_steps`, `prompt`, `response`, `narrative`, `facts`, `concepts`, `files`) are only visible when the entity is expanded.

## Recall Output Examples

### `recall()`

```
- [S42] Fix auth race condition | 💬4 💡6 | 2026-04-05 | claude-mnemo
  - desc: mutex + regression tests
- [S41] Investigate auth 401 errors | 💬3 💡4 | 2026-04-04 | claude-mnemo
  - desc: auth failures under load
- [S40] Add FTS5 search | 💬2 💡2 | 2026-04-03 | claude-mnemo
  - desc: full-text search across memory layers
```

### `recall(session=42)`

```
- [S42] Fix auth race condition | 💬4 💡6 | 2026-04-05 | claude-mnemo
  - desc: mutex + regression tests
  - insight:
    - parallel requests trigger overlapping refresh calls
  - next_steps:
    - deploy to staging, monitor error rate
  - [T1] Diagnose 401 errors | 💡2 📖2 🔧5
    - desc: verify issue persists
  - [T2] Trace refresh flow | 💡1 📖1 🔧3
    - desc: confirm race path
  - [T3] Fix auth race | 💡2 📖2 ✏️1 🔧12
    - desc: add mutex lock
  - [T4] Add tests | 💡1 📖1 ✏️1 🔧6
    - desc: parallel load coverage
```

### `recall(session=42, turn=3)`

```
- [T3] Fix auth race | 💡2 📖2 ✏️1 🔧12
  - desc: add mutex lock
  - prompt: "Fix the race condition in auth, use a mutex approach..."
  - response: "I've added a mutex lock to prevent concurrent token refresh calls..."
  - insight:
    - shared promise prevents overlapping calls
  - [O5] 🔴 Mutex added
    - desc: refreshToken now uses shared promise
  - [O6] ⚖️ Choose mutex over queue
    - desc: lower latency for the common case
```

### `recall(observation=5)`

```
- [O5] 🔴 Mutex added
  - desc: refreshToken now uses shared promise
  - narrative: Refresh now uses a shared promise so parallel requests wait for the first refresh...
  - facts:
    - mutex added to auth.ts:42
    - race window was ~200ms under load
  - concepts: problem-solution, gotcha
  - files: 📖 src/auth.ts ✏️ src/auth.ts
```

### `recall(query="auth")` (cross-session search)

```
- [S42][T3] Fix auth race | 💡2 📖2 ✏️1 🔧12
  - desc: add mutex lock
- [S41][T2] Profile token refresh | 💡2 📖3 ✏️1 🔧8
  - desc: trace refresh under parallel load
- [O5] 🔴 Mutex added
  - desc: refreshToken now uses shared promise
```

Cross-session turn results use `[Sx][Ty]` prefix per the unified turn identifier design.

## Replay Output Changes

### Turn overview (`replay(session=42)`)

```
- [T1] Why am I getting 401 errors | 🔧5
- [T2] Fix the race condition in auth | 🔧12
- [T3] ⏪ Revert changes | 🔧3
- [T4] Add regression tests | 🔧6
```

Changes from current format:
- Add `- ` markdown list prefix
- Remove `#N` suffix (redundant with `[TN]`)
- Add `🔧n` tool call count
- Replace `[undone]` with `⏪` emoji

### Turn detail (`replay(session=42, turn=2)`)

No format change. Turn detail displays raw transcript content (prompt, response, tool I/O) and reformatting it would lose fidelity.

## Context Hook Output

### Header

```
claude-mnemo: 42 sessions, 312 observations
Types: 🔴bugfix 🟣feature 🔄refactor ✅change 🔵discovery ⚖️decision
Stats: 💬turns 💡observations 📖read ✏️modified 🔧tools
Format:
  - [Sx] title | 💬n 💡n | yyyy-mm-dd | project
  - [Tx] title | 💡n 📖n ✏️n 🔧n
  - [Ox] 🔵 title
Expand: recall(session=x, turn=y) | Raw: replay(session=x, turn=y)
```

### Current session priority

The context hook receives `NormalizedHookInput.sessionId` (the Claude Code `content_session_id` for the session being started or resumed). The **current session** is always the one matching this `sessionId`, regardless of `started_at_epoch` ordering.

When resuming an older session, the current session may not be the most recently started one. The graduated depth must anchor on the current session, not on `getRecentSessions()[0]`.

Lookup rule:

1. Resolve `input.sessionId` → DB session via `getSessionByContentId(db, input.sessionId)`.
2. If found, that session is the primary session: session expanded (with `insight`, `next_steps`), all turns listed, last 3 turns expanded with observations.
3. The remaining 4 sessions come from `getRecentSessions(db, { limit: 5 })`, excluding the current session, and render at reduced depth.
4. If `input.sessionId` is missing or resolves to no DB session (brand-new session with no prior data), fall back to `getRecentSessions()[0]` as the primary and render 4 more at reduced depth.

### Graduated depth

| Position | Depth | Turn limit |
|----------|-------|------------|
| Primary session | Session expanded + last 3 turns expanded (with observations), rest collapsed | Show all turns, expand last 3 |
| Next 2 sessions | Session collapsed + last 5 turns collapsed | Max 5 collapsed turns |
| Next 2 sessions | Session collapsed only | No turns |

### Turn budget

Primary session: expand `min(3, total_turns)` turns from the end. All other turns in the primary session render as collapsed one-liners (with `desc:`).

Next 2 sessions: show at most 5 collapsed turns (the most recent 5). The session header uses collapsed form (title + stats + date, no `insight` / `next_steps`). If the session has more than 5 turns, append `  - ... and N more turns`.

Last 2 sessions: session collapsed only (one line with `desc:`).

### Content truncation

Context injection applies truncation to **all visible fields across all depth levels** (these do NOT apply to `recall` or `replay` output):

Primary session (expanded):
- `desc` (session, turn, observation): truncate to 60 chars
- `prompt`: truncate to 120 chars
- `response`: truncate to 200 chars
- `insight` / `next_steps` items: truncate to 80 chars each
- Observations per expanded turn: show at most 3; if more, append `  - ... and N more observations`

Next 2 sessions (collapsed + turns):
- Session `desc`: truncate to 60 chars
- Turn `desc`: truncate to 60 chars
- Turns capped at 5 (per turn budget above)

Last 2 sessions (collapsed):
- Session `desc`: truncate to 60 chars

All truncation uses `...` suffix.

### Full context example

User resumes session S41 (not the most recently started session):

```
claude-mnemo: 42 sessions, 312 observations
Types: 🔴bugfix 🟣feature 🔄refactor ✅change 🔵discovery ⚖️decision
Stats: 💬turns 💡observations 📖read ✏️modified 🔧tools
Format:
  - [Sx] title | 💬n 💡n | yyyy-mm-dd | project
  - [Tx] title | 💡n 📖n ✏️n 🔧n
  - [Ox] 🔵 title
Expand: recall(session=x, turn=y) | Raw: replay(session=x, turn=y)

## Current Session

- [S41] Investigate auth 401 errors | 💬3 💡4 | 2026-04-04 | claude-mnemo
  - desc: auth failures under load
  - insight:
    - 401 errors correlate with high concurrency
  - next_steps:
    - implement mutex fix based on findings
  - [T1] Check error logs | 💡1 📖1 🔧3
    - desc: grep auth errors in prod
  - [T2] Profile token refresh | 💡2 📖3 ✏️1 🔧8
    - desc: trace refresh under parallel load
    - prompt: "Profile the token refresh flow under parallel requests"
    - response: "Found that parallel requests each trigger independent refresh calls. The race window i..."
    - [O2] 🔵 Parallel requests share single refresh
      - desc: no synchronization between callers
    - [O3] 🔵 Race window is ~200ms under load
      - desc: timing confirmed with instrumentation
  - [T3] Document findings | 💡1 📖2 ✏️1 🔧4
    - desc: summarize root cause
    - prompt: "Summarize what we found about the auth issue"
    - response: "The root cause is that refreshToken() has no mutual exclusion. Under concurrent load, ..."
    - [O4] ⚖️ Mutex approach over queue
      - desc: lower latency for the common case

## Recent Sessions

- [S42] Fix auth race condition | 💬4 💡6 | 2026-04-05 | claude-mnemo
  - desc: mutex + regression tests
  - [T1] Diagnose 401 errors | 💡2 📖2 🔧5
    - desc: verify issue persists
  - [T2] Trace refresh flow | 💡1 📖1 🔧3
    - desc: confirm race path
  - [T3] Fix auth race | 💡2 📖2 ✏️1 🔧12
    - desc: add mutex lock
  - [T4] Add tests | 💡1 📖1 ✏️1 🔧6
    - desc: parallel load coverage

- [S40] Add FTS5 search | 💬2 💡2 | 2026-04-03 | claude-mnemo
  - desc: full-text search across memory layers
  - [T1] Design FTS5 schema | 💡1 📖1 ✏️1 🔧4
    - desc: virtual table layout
  - [T2] Build index pipeline | 💡1 📖2 ✏️1 🔧7
    - desc: index on save

- [S39] Initial schema design | 💬3 💡4 | 2026-04-02 | claude-mnemo
  - desc: sessions/turns/obs tables
- [S38] Project setup | 💬2 💡1 | 2026-04-01 | claude-mnemo
  - desc: init repo + deps

Note: S42 and S40 (next 2 sessions) show collapsed session header + up to 5 collapsed turns. S39 and S38 (last 2) show collapsed session only with `desc:`.
```

## Database Changes

### `next_steps` column on sessions

```sql
ALTER TABLE sessions ADD COLUMN next_steps TEXT;
```

### `tool_call_count` column on turns

```sql
ALTER TABLE turns ADD COLUMN tool_call_count INTEGER;
```

`tool_call_count` is populated during backfill in the Stop handler. Backfill must use a single `parseReplayTranscript` pass to extract both `assistantResponse` and `toolCallCount` for each turn, ensuring both values come from the same replay-compatible turn resolver. See the Backfill Changes section for the unified extraction pattern.

### Migration safety

SQLite `ALTER TABLE ADD COLUMN` is not idempotent — executing it twice throws an error. The current `initializeSchema` uses `CREATE TABLE IF NOT EXISTS` which runs safely on every startup, but `ALTER TABLE ADD COLUMN` does not have an `IF NOT EXISTS` guard.

Required approach: check whether columns already exist before altering.

```typescript
function migrateSchema(db: Database): void {
  const sessionColumns = db.query<{ name: string }, []>(
    "SELECT name FROM pragma_table_info('sessions')"
  ).all().map(r => r.name);

  if (!sessionColumns.includes("next_steps")) {
    db.exec("ALTER TABLE sessions ADD COLUMN next_steps TEXT");
  }

  const turnColumns = db.query<{ name: string }, []>(
    "SELECT name FROM pragma_table_info('turns')"
  ).all().map(r => r.name);

  if (!turnColumns.includes("tool_call_count")) {
    db.exec("ALTER TABLE turns ADD COLUMN tool_call_count INTEGER");
  }
}
```

Call `migrateSchema(db)` after `initializeSchema(db)` wherever the database is initialized. This keeps `initializeSchema` unchanged (pure `CREATE TABLE IF NOT EXISTS`) and puts additive migrations in a separate function that is safe to run repeatedly.

New databases get both columns via the `CREATE TABLE` statement directly (add `next_steps TEXT` to sessions and `tool_call_count INTEGER` to turns in `schema.ts`). The `ALTER TABLE` migration path is only needed for existing on-disk databases.

## API Changes

### update_session

Add `next_steps` to the MCP tool schema:

```typescript
const updateSessionInputSchema = z.object({
  session_id: z.number().int(),
  title: z.string().optional(),
  description: z.string().optional(),
  insight: z.string().optional(),
  next_steps: z.string().optional(),       // new
  updated_at_epoch: z.number().int().optional(),
  completed_at_epoch: z.number().int().optional(),
});
```

### SessionRecord / UpsertSessionInput

Add `nextSteps: string | null` to both interfaces.

### upsertSession

Add COALESCE pattern for `next_steps`, matching existing nullable fields:

```sql
next_steps = COALESCE(excluded.next_steps, sessions.next_steps)
```

### TurnRecord

Add `toolCallCount: number | null` to the interface.

### FormattedTurn

Add `toolCallCount?: number | null` and `filesReadCount?: number` and `filesModifiedCount?: number` to the interface. These are populated by `buildFormattedSession` for stats display without requiring full file lists in collapsed views.

### FormattedSession

Add `nextSteps?: string | null` and `turnCount?: number` and `observationCount?: number` to the interface.

## Format Changes (`format.ts`)

### formatEpoch

Change from `MM-DD HH:mm` to `YYYY-MM-DD`:

```typescript
function formatEpoch(epoch: number): string {
  const date = new Date(epoch * 1000);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}
```

### Observation type emoji map

```typescript
const TYPE_EMOJI: Record<string, string> = {
  bugfix: "🔴",
  feature: "🟣",
  refactor: "🔄",
  change: "✅",
  discovery: "🔵",
  decision: "⚖️",
};

function typeEmoji(type: string): string {
  return TYPE_EMOJI[type] ?? type;
}
```

### Stats formatting helpers

```typescript
function formatTurnStats(turn: FormattedTurn): string {
  const parts: string[] = [];

  if (turn.observationCount > 0) parts.push(`💡${turn.observationCount}`);

  const readCount = turn.filesReadCount ?? turn.filesRead?.length ?? 0;
  const modCount = turn.filesModifiedCount ?? turn.filesModified?.length ?? 0;
  if (readCount > 0) parts.push(`📖${readCount}`);
  if (modCount > 0) parts.push(`✏️${modCount}`);
  if (turn.toolCallCount) parts.push(`🔧${turn.toolCallCount}`);

  return parts.join(" ");
}

function formatSessionStats(session: FormattedSession): string {
  const parts: string[] = [];
  if (session.turnCount) parts.push(`💬${session.turnCount}`);
  if (session.observationCount) parts.push(`💡${session.observationCount}`);
  return parts.join(" ");
}
```

### formatSessionCollapsed

```typescript
export function formatSessionCollapsed(session: FormattedSession): string {
  const stats = formatSessionStats(session);
  const statsSegment = stats ? ` | ${stats}` : "";
  return `- [S${session.id}] ${session.title ?? "Untitled"}${statsSegment} | ${formatEpoch(session.startedAtEpoch)} | ${session.project}`;
}
```

### formatSessionExpanded

```typescript
export function formatSessionExpanded(session: FormattedSession): string {
  const lines = [formatSessionCollapsed(session)];

  if (session.description) {
    lines.push(`  - desc: ${session.description}`);
  }

  if (session.insight && session.insight.length > 0) {
    lines.push("  - insight:");
    for (const bullet of session.insight) {
      lines.push(`    - ${bullet}`);
    }
  }

  if (session.nextSteps) {
    lines.push("  - next_steps:");
    lines.push(`    - ${session.nextSteps}`);
  }

  return lines.join("\n");
}
```

### formatTurnCollapsed

```typescript
export function formatTurnCollapsed(
  turn: FormattedTurn,
  options: TurnFormatOptions = {},
): string {
  const { indent = "  ", sessionId } = options;
  const prefix = sessionId === undefined
    ? `${indent}- [T${turn.promptNumber}]`
    : `${indent}- [S${sessionId}][T${turn.promptNumber}]`;

  const stats = formatTurnStats(turn);
  const statsSegment = stats ? ` | ${stats}` : "";
  const titleLine = `${prefix} ${turn.title ?? "Untitled"}${statsSegment}`;

  if (turn.description) {
    return `${titleLine}\n${indent}  - desc: ${turn.description}`;
  }

  return titleLine;
}
```

### formatTurnExpanded

```typescript
export function formatTurnExpanded(
  turn: FormattedTurn,
  options: TurnFormatOptions = {},
): string {
  const { indent = "  " } = options;
  const detailIndent = `${indent}  `;
  const lines = [formatTurnCollapsed(turn, options)];

  if (turn.promptPreview) {
    lines.push(`${detailIndent}- prompt: "${turn.promptPreview}"`);
  }

  if (turn.responsePreview) {
    lines.push(`${detailIndent}- response: "${turn.responsePreview}"`);
  }

  if (turn.insight && turn.insight.length > 0) {
    lines.push(`${detailIndent}- insight:`);
    for (const bullet of turn.insight) {
      lines.push(`${detailIndent}  - ${bullet}`);
    }
  }

  return lines.join("\n");
}
```

### formatObservationCollapsed

```typescript
export function formatObservationCollapsed(
  observation: FormattedObservation,
): string {
  const emoji = typeEmoji(observation.type);
  const lines = [`    - [O${observation.id}] ${emoji} ${observation.title}`];

  if (observation.description) {
    lines.push(`      - desc: ${observation.description}`);
  }

  return lines.join("\n");
}
```

### formatObservationExpanded

```typescript
export function formatObservationExpanded(
  observation: FormattedObservation,
): string {
  const lines = [formatObservationCollapsed(observation)];

  if (observation.narrative) {
    lines.push(`      - narrative: ${observation.narrative}`);
  }

  if (observation.facts && observation.facts.length > 0) {
    lines.push("      - facts:");
    for (const fact of observation.facts) {
      lines.push(`        - ${fact}`);
    }
  }

  if (observation.concepts && observation.concepts.length > 0) {
    lines.push(`      - concepts: ${observation.concepts.join(", ")}`);
  }

  const filesParts: string[] = [];
  if (observation.filesRead && observation.filesRead.length > 0) {
    filesParts.push(`📖 ${observation.filesRead.join(", ")}`);
  }
  if (observation.filesModified && observation.filesModified.length > 0) {
    filesParts.push(`✏️ ${observation.filesModified.join(", ")}`);
  }
  if (filesParts.length > 0) {
    lines.push(`      - files: ${filesParts.join(" ")}`);
  }

  return lines.join("\n");
}
```

## Replay Changes (`replay.ts`)

### formatTurnOverviewLine

```typescript
function formatTurnOverviewLine(
  promptNumber: number,
  userPrompt: string,
  toolCallCount: number,
  status?: string,
): string {
  const undoneMarker = status === "undone" ? " ⏪" : "";
  const toolStats = toolCallCount > 0 ? ` | 🔧${toolCallCount}` : "";

  return `- [T${promptNumber}]${undoneMarker} ${userPrompt}${toolStats}`;
}
```

Changes:
- Add `- ` markdown list prefix
- Remove `#N` suffix (redundant with `[TN]`)
- Add `🔧n` tool call count from `turn.toolCalls.length`
- Replace `[undone]` with `⏪` emoji

### formatTurnDetail

No format change. Turn detail displays raw transcript content.

## Context Hook Changes (`context.ts`)

### Handler signature

```typescript
function buildContextOutput(db: Database, sessionId?: string): string {
```

### Current session resolution

```typescript
const currentSession = sessionId
  ? getSessionByContentId(db, sessionId)
  : null;

const recentSessions = getRecentSessions(db, { limit: 5 });
const primarySession = currentSession ?? recentSessions[0] ?? null;
const otherSessions = currentSession
  ? recentSessions.filter(s => s.id !== currentSession.id).slice(0, 4)
  : recentSessions.slice(1, 5);
```

### Context header

```typescript
function buildContextHeader(db: Database): string {
  const sessionCount = /* total session count query */;
  const observationCount = /* total observation count query */;

  return [
    `claude-mnemo: ${sessionCount} sessions, ${observationCount} observations`,
    "Types: 🔴bugfix 🟣feature 🔄refactor ✅change 🔵discovery ⚖️decision",
    "Stats: 💬turns 💡observations 📖read ✏️modified 🔧tools",
    "Format:",
    "  - [Sx] title | 💬n 💡n | yyyy-mm-dd | project",
    "  - [Tx] title | 💡n 📖n ✏️n 🔧n",
    "  - [Ox] 🔵 title",
    "Expand: recall(session=x, turn=y) | Raw: replay(session=x, turn=y)",
  ].join("\n");
}
```

### Context-specific truncation

```typescript
function truncateForContext(text: string | null | undefined, maxLen: number): string | null {
  if (!text) return null;
  return text.length <= maxLen ? text : text.slice(0, maxLen - 3) + "...";
}
```

Applied to expanded turns in the primary session:
- `prompt`: truncate to 120 chars
- `response`: truncate to 200 chars
- `desc`: truncate to 60 chars
- Observations per turn: show at most 3; if more, append `  - ... and N more observations`

These truncation rules apply only to the context hook, not to `recall` or `replay`.

## Mnemosyne Prompt Changes

Add `next_steps` guidance to the `update_session` section:

```
- Call update_session if the session summary needs updating.
- Include next_steps when the session has a clear trajectory or planned follow-up.
- next_steps: what was actively being worked on or planned next (not speculative future work).
- Skip update_session if nothing meaningful changed.
```

## Backfill Changes (Stop and PreCompact handlers)

### Unified transcript resolver

The current backfill uses `extractAssistantResponse` (which calls `parseTranscript`, filtering out sidechain entries) to get assistant responses, while undo detection uses `parseReplayTranscript` (which includes sidechain entries). This dual-resolver pattern causes numbering drift for sessions with sidechain turns, as documented in the adopt-untracked-session design spec.

**Both Stop and PreCompact must switch to the same unified resolver.** Currently:
- `stop.ts` `backfillPendingTurns` calls `extractAssistantResponse` per turn
- `compact.ts` line 62 calls `dependencies.extractAssistantResponse` per turn
- Neither writes `tool_call_count`

After this change, both handlers use a single `parseReplayTranscript` pass that provides `assistantText`, `toolCalls.length`, and replay-compatible `promptNumber` for each turn:

```typescript
// Shared backfill logic used by both Stop and PreCompact
function backfillFromTranscript(
  db: Database,
  pendingTurns: TurnRecord[],
  transcriptPath: string,
  lastAssistantMessage?: string,
): void {
  const replayTurns = new Map(
    parseReplayTranscript(transcriptPath).map(t => [t.promptNumber, t]),
  );

  const lastPromptNumber = pendingTurns[pendingTurns.length - 1]?.promptNumber;

  for (const pendingTurn of pendingTurns) {
    if (pendingTurn.assistantResponse || !pendingTurn.userPrompt) {
      continue;
    }

    const replayTurn = replayTurns.get(pendingTurn.promptNumber);

    // Use lastAssistantMessage shortcut for the final turn when available (Stop only)
    const assistantResponse =
      pendingTurn.promptNumber === lastPromptNumber && lastAssistantMessage !== undefined
        ? lastAssistantMessage
        : replayTurn?.assistantText ?? "";

    const toolCallCount = replayTurn?.toolCalls.length ?? 0;

    db.query(
      "UPDATE turns SET assistant_response = ?, tool_call_count = ? WHERE id = ?"
    ).run(assistantResponse, toolCallCount, pendingTurn.id);
  }
}
```

This shared function replaces both:
- `backfillPendingTurns` in `stop.ts`
- The inline backfill loop in `compact.ts` (lines 56-68)

The `extractAssistantResponse` dependency in `CompactHandlerDependencies` is removed. Both handlers import the shared backfill function instead.

This change also resolves the pre-existing backfill numbering drift noted in the adopt-untracked-session spec review: `parseTranscript` and `parseReplayTranscript` assign different `promptNumber` values to sessions with sidechain turns. After this change, Stop, PreCompact, and undo detection all use the same replay-compatible numbering.

## Implementation Outline

1. Add `next_steps TEXT` to `CREATE TABLE sessions` and `tool_call_count INTEGER` to `CREATE TABLE turns` in `schema.ts`.
2. Add `migrateSchema` function with column-existence checks for both tables.
3. Update `SessionRecord`, `UpsertSessionInput`, `upsertSession` in `src/db/sessions.ts`.
4. Update `TurnRecord` in `src/db/turns.ts` to include `toolCallCount`.
5. Update `UpdateSessionToolInput` and `updateSessionTool` in `src/mcp/update-session.ts`.
6. Update `updateSessionInputSchema` in `src/mcp/server.ts`.
7. Rewrite `format.ts`: emoji types, emoji stats, markdown list structure, `desc` as collapsed field, `- ` prefixes, `YYYY-MM-DD` dates.
8. Update `FormattedTurn`, `FormattedSession`, `FormattedObservation` interfaces.
9. Update `recall.ts` to populate new stats fields in `buildFormattedSession`.
10. Update `replay.ts` `formatTurnOverviewLine` with markdown list, `⏪`, `🔧n`, remove `#N`.
11. Rewrite `context.ts` with header, current-session resolution, graduated depth, and truncation.
12. Extract shared `backfillFromTranscript` function. Update both Stop and PreCompact handlers to use it. Remove `extractAssistantResponse` dependency from `CompactHandlerDependencies`.
13. Update Mnemosyne prompt with `next_steps` guidance.
14. Update tests and docs.

## Testing Strategy

Required behavioral tests:

### Format tests
1. `formatSessionCollapsed` renders `- [Sx] title | 💬n 💡n | yyyy-mm-dd | project`.
2. `formatSessionExpanded` renders `desc:`, `insight:` (sub-list), `next_steps:` (sub-list).
3. `formatTurnCollapsed` renders `- [Tx] title | 💡n 📖n ✏️n 🔧n` with zero-value omission.
4. `formatTurnCollapsed` includes `desc:` on the next line.
5. `formatTurnExpanded` adds `prompt:`, `response:`, `insight:` as `- ` list items.
6. `formatObservationCollapsed` renders `- [Ox] 🔵 title` with emoji type.
7. `formatObservationCollapsed` includes `desc:` on the next line.
8. `formatObservationExpanded` renders `narrative:`, `facts:` (sub-list), `concepts:`, `files:` with emoji.
9. Cross-session search results render `- [Sx][Ty] title | stats`.

### Recall tests
10. `recall()` returns sessions with `desc:` lines.
11. `recall(session=x)` shows session expanded with turns collapsed (each with `desc:`).
12. `recall(session=x, turn=y)` shows turn expanded with observations collapsed.
13. `recall(observation=x)` shows observation expanded with `narrative`, `facts`, `concepts`, `files`.

### Replay tests
14. `replay(session=x)` overview uses `- [Tx] prompt | 🔧n` format.
15. `replay(session=x)` shows `⏪` for undone turns instead of `[undone]`.
16. `replay(session=x)` omits `#N` suffix.

### Context tests
17. Context hook with 0 sessions returns fallback message.
18. Context hook with 1 session returns header + expanded session with last turns expanded.
19. Context hook with 5 sessions returns graduated depth.
20. Resumed older session: context anchors on the resumed session, not the most recently started one.
21. Missing `sessionId`: falls back to most recent session as primary.
22. Current session with 15 turns: only last 3 expanded, rest collapsed.
23. Current session with 2 turns: both expanded.
24. Truncation: prompt >120 chars renders truncated with `...` suffix.
25. Truncation: response >200 chars renders truncated with `...` suffix.
26. Truncation: turn with 5 observations shows 3 + "... and N more observations".
27. Context header shows global session/observation counts.
28. Next 2 sessions: session with 12 turns shows only last 5 collapsed + "... and 7 more turns".
29. Next 2 sessions: no `insight` or `next_steps` rendered (collapsed header only).
30. Last 2 sessions: no turns rendered, only collapsed session with `desc:`.
31. Secondary session with long desc (>60 chars) is truncated to 60 with `...`.
32. Secondary session collapsed turn with long desc (>60 chars) is truncated to 60 with `...`.

### Schema tests
28. `update_session` with `next_steps` persists the value.
29. `update_session` without `next_steps` preserves existing value (COALESCE).
30. `migrateSchema` adds both columns to existing database.
31. `migrateSchema` is idempotent — running twice does not error.
32. Stop handler backfill populates `tool_call_count` from transcript.
33. PreCompact handler backfill populates `tool_call_count` from transcript.
34. PreCompact handler no longer depends on `extractAssistantResponse`.

Regression checks:
- existing recall parameter validation unchanged
- existing replay turn detail format unchanged
- existing update_session calls without next_steps still work

## Risks

### Context output too large

Even with the 3-turn expansion cap on the primary session, individual fields and secondary sessions can be long.

Mitigation: multi-layer budget controls with truncation at every level.
- Primary session: expand last 3 turns only, truncate prompt (120), response (200), desc (60), insight items (80), cap observations at 3 per turn.
- Next 2 sessions: collapsed header (desc truncated to 60) + max 5 collapsed turns (desc truncated to 60, ~120 chars per turn max). If >5 turns, show "... and N more turns".
- Last 2 sessions: collapsed header only (desc truncated to 60, ~140 chars each).
- Worst case: header ~400 + primary ~1.5k + 2 × 5 × 120 = ~1.2k + 2 × ~140 = ~3.4k chars.

### Format change is breaking

All existing tests that assert on output strings will fail. This is a deliberate format overhaul.

Mitigation: update all format/recall/replay tests in the same change. The format change is additive (more information, not less).

### buildFormattedSession needs new stats fields

`buildFormattedSession` currently populates `observationCount` but not `filesReadCount`, `filesModifiedCount`, or `toolCallCount` for collapsed turns. Adding these requires loading turn records with the new field and computing file counts without loading full file lists.

Mitigation: `toolCallCount` comes from the new DB column. File counts can be computed from the JSON arrays already stored in the turn record (`JSON.parse(filesRead).length`). No additional queries needed.

### Schema migration on existing databases

SQLite `ALTER TABLE ADD COLUMN` is not idempotent.

Mitigation: `migrateSchema` checks `pragma_table_info` before altering. New databases get columns via `CREATE TABLE`. Migration only runs for existing on-disk databases.

### next_steps staleness

`next_steps` reflects trajectory at session end.

Mitigation: context only shows `next_steps` for the primary session. Mnemosyne updates it at each extraction pass.

### tool_call_count not available for historical turns

Turns backfilled before this change will have `tool_call_count = NULL`. Stats rendering treats null as 0 (omits `🔧`).

Mitigation: acceptable degradation. New turns get the count automatically. A backfill migration for historical turns is a non-goal.

## Non-Goals

- Do not add semantic/vector search to the context hook.
- Do not inject context at UserPromptSubmit (per-prompt injection).
- Do not change replay turn detail format (raw transcript display).
- Do not add session-level `investigated` or `learned` fields.
- Do not backfill `tool_call_count` for historical turns.
