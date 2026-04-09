# Async Extraction Hooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Mnemosyne extraction agent non-blocking. Currently Stop and PreCompact hooks `await forkMnemosyne(...)`, blocking the user until the extraction agent finishes. Use Claude Code's async hook protocol to return immediately and run extraction in the background.

**Architecture:** Claude Code supports an async hook protocol: if a hook process outputs `{"async": true}` as its first stdout line, Claude Code backgrounds the process immediately and the user can continue. The hook process stays alive and runs extraction in the background.

**Tech Stack:** TypeScript, Bun test, Claude Agent SDK (`query()`), Claude Code hook protocol

---

## Background

### Current flow (blocking)

```
User sends prompt → Claude responds → Stop hook fires
  → backfill turns (sync, fast)
  → mark stale turns (sync, fast)
  → await forkMnemosyne (BLOCKS 5-20s)  ← user waits here
  → upsert session completedAtEpoch
  → write stderr message
  → return { continue: true }
  → process.exit()
```

### Target flow (async)

```
User sends prompt → Claude responds → Stop hook fires
  → recover stalled extractions (extracting_pending→pending, extracting_stale→stale)
  → backfill turns (sync, fast, includes recovered turns)
  → mark stale turns (sync, fast)
  → build prompt (sees [pending]/[stale] — correct routing semantics)
  → claimTurnsForExtraction (pending→extracting_pending, stale→extracting_stale)
  → if claimed > 0:
      → upsert session completedAtEpoch
      → write stderr message             ← Claude Code captures this
      → write {"async": true} to stdout   ← Claude Code releases user
      → forkMnemosyne runs in background (uses pre-built prompt)
      → agent calls remember() → saveTurn() sets extracted/skipped/undone
      → process exits naturally when done
  → if claimed = 0:
      → upsert session completedAtEpoch
      → return { continue: true }
```

### Claude Code async protocol (from source: `src/utils/hooks.ts`)

1. Hook process stdout is parsed line-by-line
2. First line checked: if it parses as `{"async": true}`, process is backgrounded
3. stderr collected up to that point is returned to caller
4. Process stays alive, Claude Code does not wait for exit
5. Optional: `asyncRewake` mode sends task notification on exit code 2

### Concurrency concern

Multiple Stop hooks can fire in quick succession (user sends prompts rapidly). With async extraction, multiple `forkMnemosyne` calls could overlap across separate processes. In-memory locks don't help because each hook invocation is a separate process.

**What overlapping extractions can duplicate:**
- Turn writes via `saveTurn()` UPSERT on `(session_id, prompt_number)` — these **merge** safely, no duplicates.
- Observation writes via `remember({ parent: "S{id}/T{n}", ... })` → `createObservation()` — these are **INSERT** (append) semantics (`src/mcp/remember.ts:170-182`). Overlapping extractions produce duplicate O* records.
- Memory writes via `remember({ type: "feedback", ... })` → `createMemory()` — also **INSERT** (`src/db/memories.ts:168-220`). Overlapping extractions produce duplicate M* records.

**Mitigation: dual extracting statuses that preserve origin.** Instead of a single `extracting` status (which loses the `pending` vs `stale` distinction) or a new column, use two transient statuses:

- `pending` → `extracting_pending`
- `stale` → `extracting_stale`

`getPendingTurns()` only returns `pending`/`stale`, so `extracting_*` turns are invisible to the next hook. The prompt is built BEFORE locking, so the Mnemosyne agent sees original `[pending]`/`[stale]` with correct routing semantics.

`updated_at_epoch` records lock acquisition time for crash recovery. Recovery reverses the mapping precisely:

- `extracting_pending` → `pending`
- `extracting_stale` → `stale`

No new columns. No semantic loss. The "build prompt → then lock" race is harmless: a concurrent hook that reads the same turns will get `count=0` from `claimTurnsForExtraction()` and skip extraction.

**Decision:** Use `extracting_pending`/`extracting_stale` as cross-process locks. No new columns, file locks, or daemons needed.

---

### Task 1: Add extraction lock functions using dual statuses

**Files:**
- Modify: `src/db/turns.ts`
- Test: `tests/db/turns.test.ts`

No schema changes needed — uses existing `status` and `updated_at_epoch` columns.

- [ ] **Step 1: Add `claimTurnsForExtraction()` function**

```ts
export function claimTurnsForExtraction(
  db: Database,
  sessionId: number,
  now?: number,
): number {
  const epoch = now ?? Math.floor(Date.now() / 1000);
  return db.query(
    `UPDATE turns SET
       status = CASE status
         WHEN 'pending' THEN 'extracting_pending'
         WHEN 'stale' THEN 'extracting_stale'
       END,
       updated_at_epoch = ?
     WHERE session_id = ? AND status IN ('pending', 'stale')`,
  ).run(epoch, sessionId).changes;
}
```

Single atomic UPDATE with CASE — both status transitions happen in one statement. SQLite holds a write lock for the entire UPDATE, so no interleaving between concurrent hook processes. `updated_at_epoch` records lock acquisition time.

- [ ] **Step 2: Add `recoverStalledExtractions()` function**

```ts
export function recoverStalledExtractions(
  db: Database,
  sessionId: number,
  maxAgeSeconds: number = 300,
  now?: number,
): void {
  const epoch = now ?? Math.floor(Date.now() / 1000);
  const cutoff = epoch - maxAgeSeconds;
  db.query(
    `UPDATE turns SET
       status = CASE status
         WHEN 'extracting_pending' THEN 'pending'
         WHEN 'extracting_stale' THEN 'stale'
       END,
       updated_at_epoch = ?
     WHERE session_id = ?
       AND status IN ('extracting_pending', 'extracting_stale')
       AND updated_at_epoch < ?`,
  ).run(epoch, sessionId, cutoff);
}
```

Single atomic UPDATE with precise reversal: `extracting_pending` → `pending`, `extracting_stale` → `stale`. Stale turns that crashed mid-extraction retain their re-evaluate semantics.

- [ ] **Step 3: Add tests**

Test:
- `claimTurnsForExtraction`: pending → extracting_pending, stale → extracting_stale, extracted/skipped unchanged
- `claimTurnsForExtraction`: already-claimed (extracting_*) turns not double-claimed
- `recoverStalledExtractions`: old extracting_pending → pending, old extracting_stale → stale, recent locks untouched
- `getPendingTurns`: does NOT return extracting_pending or extracting_stale (already true — filters on `pending`/`stale` only)

### Task 2: Restructure hook-command to support async output

**Files:**
- Modify: `src/hooks/hook-command.ts`
- Modify: `src/hooks/types.ts`

- [ ] **Step 1: Extend HookResult with an async extraction callback**

In `src/hooks/types.ts`, add an optional field to `HookResult`:

```ts
export interface HookResult {
  continue: boolean;
  exitCode?: number;
  suppressOutput?: boolean;
  hookSpecificOutput?: string;
  // If provided, hook-command writes {"async": true} as the FIRST stdout line
  // and awaits this callback. No sync hook result is written to stdout.
  asyncWork?: () => Promise<void>;
}
```

- [ ] **Step 2: Update runHookCommand to handle asyncWork**

In `src/hooks/hook-command.ts`, the async path must write `{"async": true}` as the **first and only** stdout line. The sync `writeHookResult()` must NOT be called when asyncWork is present:

```ts
const result = await handler(normalizedInput);

if (result.asyncWork) {
  // FIRST line on stdout — Claude Code backgrounds the process immediately
  process.stdout.write(JSON.stringify({ async: true }) + "\n");
  await result.asyncWork();
  return HOOK_SUCCESS_EXIT_CODE;
}

writeHookResult(result);
return result.exitCode ?? HOOK_SUCCESS_EXIT_CODE;
```

Critical design rule: when `asyncWork` is set, `{"async": true}` must be the first stdout line. `writeHookResult` is skipped entirely. This is not a "first write nothing, then write async" hack — it's the only valid protocol. If a future hook needs both sync output AND async work, it must be split into two separate hooks or the sync output moved to stderr.

### Task 3: Make Stop handler async with extraction lock

**Files:**
- Modify: `src/hooks/handlers/stop.ts`
- Test: `tests/hooks/stop.test.ts`

- [ ] **Step 1: Move forkMnemosyne into asyncWork with extraction lock**

In `src/hooks/handlers/stop.ts`, the handler must:
1. Recover stalled locks FIRST (self-healing, makes crashed turns eligible again)
2. Backfill and mark stale (operates on recovered + new pending turns)
3. Build prompt while turns are still `[pending]`/`[stale]` — full routing semantics
4. Claim turns: `claimTurnsForExtraction()` — atomic lock via status transition
5. Check claim count — if 0, another process already claimed, skip extraction
6. Complete remaining sync work (upsert completedAtEpoch, stderr)
7. Return `asyncWork` wrapping forkMnemosyne

```ts
// 1. Self-healing: unlock crashed extractions so they re-enter the candidate pool
recoverStalledExtractions(dependencies.db, session.id);

// 2. Backfill and detect undone turns (now includes recovered turns)
backfillFromTranscript(...);
markTurnsStale(...);

// 3. Build prompt while statuses are [pending]/[stale] — correct routing semantics
const prompt = buildStopPrompt(dependencies.db, session.id);

// 4. Atomic claim: pending → extracting_pending, stale → extracting_stale
const claimedCount = claimTurnsForExtraction(dependencies.db, session.id);

upsertSession(dependencies.db, { ... completedAtEpoch: now() });
stderr.write(`Mnemosyne: ${claimedCount} turns queued for extraction\n`);

// 5. Only proceed if WE claimed turns — count=0 means another process got them
if (claimedCount > 0) {
  return {
    continue: true,
    exitCode: HOOK_SUCCESS_EXIT_CODE,
    asyncWork: () =>
      dependencies.forkMnemosyne({
        cwd: input.cwd,
        prompt,
        database: dependencies.db,
      }).then(() => {}),
  };
}

return { continue: true, exitCode: HOOK_SUCCESS_EXIT_CODE };
```

Key ordering: **recover → backfill → prompt → claim → async**. The prompt is built while turns have their original statuses. The claim is atomic — if a concurrent hook already claimed the same turns, `claimTurnsForExtraction` returns 0 and we skip. The only wasted work in the race case is one `recallMemory()` call (pure DB read, microseconds).

- [ ] **Step 2: Update stop tests**

The handler now returns immediately with `asyncWork`. Tests should verify:

- `asyncWork` is defined when there are pending turns
- `asyncWork` is undefined when there are no pending turns
- `claimTurnsForExtraction` is called before returning (claimed turns are no longer returned by `getPendingTurns()`)
- Sync work (upsertSession, stderr) completes before asyncWork
- Calling `await result.asyncWork()` invokes forkMnemosyne

### Task 4: Make Compact handler async with extraction lock

**Files:**
- Modify: `src/hooks/handlers/compact.ts`
- Test: `tests/hooks/compact.test.ts`

- [ ] **Step 1: Move forkMnemosyne into asyncWork with extraction lock**

Same recover → refetch pending turns → backfill → prompt → claim → async pattern as Stop handler:

```ts
recoverStalledExtractions(dependencies.db, session.id);
const pendingTurns = getPendingTurns(dependencies.db, session.id);
backfillFromTranscript(dependencies.db, pendingTurns, transcriptPath);

const prompt = buildPrompt(dependencies.db, session.id);
const claimedCount = claimTurnsForExtraction(dependencies.db, session.id);

if (claimedCount > 0) {
  return {
    continue: true,
    asyncWork: () =>
      dependencies.forkMnemosyne({
        cwd: input.cwd,
        prompt,
        database: dependencies.db,
      }).then(() => {}),
  };
}

return { continue: true };
```

Important: `pendingTurns` must be fetched AFTER `recoverStalledExtractions()`. Reusing a pre-recovery pending-turn snapshot would skip turns that were just unlocked from a crashed extraction.

- [ ] **Step 2: Update compact tests**

Same pattern as stop tests:
- Handler returns immediately with `asyncWork` when pending turns exist
- `asyncWork` is undefined when no pending turns
- `claimTurnsForExtraction` prevents duplicate extraction

### Task 5: Map `extracting_*` statuses to display names in recall/format

**Files:**
- Modify: `src/mcp/recall.ts` or `src/mcp/format.ts`
- Review: `src/mnemosyne/prompt.ts`

- [ ] **Step 1: Add display mapping for transient lock statuses**

During async extraction, turns have `extracting_pending`/`extracting_stale` status in the DB. If a user calls `recall` or the SessionStart context hook fires during this window, these internal lock statuses would be visible as `[extracting_pending]`/`[extracting_stale]` in the output.

Add a display mapping in the format layer so they render as `[pending]`/`[stale]`:

```ts
function displayStatus(status: string): string {
  if (status === "extracting_pending") return "pending";
  if (status === "extracting_stale") return "stale";
  return status;
}
```

Apply this in `formatTurnCollapsed` and `formatTurnExpanded` where `turn.status` is rendered.

- [ ] **Step 2: Confirm Mnemosyne prompt compatibility**

The prompt is built BEFORE `claimTurnsForExtraction()`, so the Mnemosyne agent sees original `[pending]`/`[stale]` statuses. No prompt changes needed.

Verify:
- `buildStopPrompt()` / `buildPrompt()` are called before claim
- The Mnemosyne agent writes back via `remember()` → `saveTurn()`, which sets final statuses (`extracted`/`skipped`/`undone`), replacing the `extracting_*` transient status

### Task 6: Rebuild artifacts and verify

**Files:**
- Generated: `plugin/scripts/hook-command.cjs`
- Generated: `plugin/scripts/mcp-server.cjs`

- [ ] **Step 1: Run tests**

```bash
bun test
```

- [ ] **Step 2: Rebuild plugin artifacts**

```bash
npm run build
```

- [ ] **Step 3: Manual smoke test**

1. Start a Claude Code session with claude-mnemo installed
2. Send a prompt, observe that the Stop hook returns instantly (no delay after Claude responds)
3. Check `~/.claude-mnemo/sessions/` for the extraction session JSONL appearing shortly after
4. Check DB: turns should be marked `extracted`/`skipped` after extraction completes

---

## Notes for Execution

- **Async protocol rule:** When `asyncWork` is present, `{"async": true}` must be the first and only stdout line. `writeHookResult()` is NOT called. This is not optional — Claude Code only checks the first line for async detection. Writing sync JSON before `{"async": true}` produces invalid output.
- **stderr before async:** stderr written before the `{"async": true}` line is captured by Claude Code and displayed to the user. This is confirmed in Claude Code source (`hooks.ts:1145-1150`).
- **Process lifecycle:** `process.exit()` in `hook-command.ts` runs AFTER `runHookCommand()` resolves. Since we `await result.asyncWork()` inside `runHookCommand`, the process stays alive until extraction completes, then exits normally.
- **Status preservation:** Locking uses `extracting_pending`/`extracting_stale` transient statuses, preserving the `pending` vs `stale` distinction. The Mnemosyne prompt sees original statuses because it's built before claim.
- **Crash recovery:** `recoverStalledExtractions()` reverses the mapping precisely: `extracting_pending` → `pending`, `extracting_stale` → `stale`. Lock age is measured by `updated_at_epoch` (set during claim), threshold 5 minutes.
- **Ordering: recover → backfill → prompt → claim → async.** Recovery runs first so crashed turns re-enter the backfill pool. Prompt is built while turns are `pending`/`stale`. Claim is atomic — `count=0` means another process got them, skip extraction.
- **Lock release (normal):** The extraction agent calls `remember()` → `saveTurn()`, which sets final status (`extracted`/`skipped`/`undone`), replacing the `extracting_*` transient status.
- **No new columns, file locks, or daemons.** Uses existing `status` and `updated_at_epoch` columns. SQLite write serialization ensures `claimTurnsForExtraction()` is atomic.
