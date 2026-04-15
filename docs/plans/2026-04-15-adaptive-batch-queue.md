# Adaptive Batch Queue with Dynamic Cache TTL

**Goal:** Replace the existing reserve-turns buffer model with a batch queue that merges tiny consecutive turns, consumes one batch per cache-keepalive event, and dynamically detects whether the API gave the agent a 5-minute or 1-hour cache TTL. All thresholds become configurable.

---

## Context

This spec supersedes **D1 (turn-stop is buffer entry, not flush trigger)**, **D2 (buffer overflow at 3 reserve turns)**, **D3 (warm state keepalive degradation chain)**, and **D5 (multi-turn batch prompt format wrt partial-turn fallback)** of `2026-04-13-cache-keepalive-timer.md`. The other decisions of that spec (D4 timer reuse, D6 release semantics, D7 undone handling, D8 SessionEnd/Compact flush-all, D10 buffer concurrency) remain in force.

The simplification: **only completed turns ever reach the agent; in-progress obs are buffered locally but never pushed standalone**. The "first obs immediate push" path and the "send half of in-progress obs as keepalive" fallback are both removed.

Clarification: this also applies to `SessionEnd`. `SessionEnd` flushes all queued **completed-turn batches** for the session, but does **not** synthesize or flush in-progress-only buffers. This spec intentionally resolves the older D8 ambiguity in favor of the completed-turn-only model above.

Three motivations:

1. **Tiny turn overhead.** Mnemo agent transcript analysis shows median push payload is ~1K chars (~250 tokens), and 25% of pushes are <762 chars. Each tiny push still costs at least one cache_creation refresh if it crosses the 5-min boundary.
2. **Hardcoded 5-min TTL is wrong post-2.1.108.** Claude Code 2.1.108 added `ENABLE_PROMPT_CACHING_1H=1`. With 1-hour cache, the existing 4-min keepalive fires 12x too often. The keepalive interval must adapt to whatever TTL the API actually used for the last response.
3. **Configuration is hardcoded.** `RESERVE_TURNS=3`, `KEEPALIVE_MS=240_000`, `CACHE_TTL_MS=300_000`, and the cache TTL choice itself should all be configurable.

---

## Locked decisions

| # | Decision |
|---|---|
| **D1** | **Queue holds N batches, not N turns.** A "batch" is the unit sent to the agent. The queue length cap (`MAX_QUEUED_BATCHES`, default 3) counts post-merge batches, not raw turns. Many tiny turns can collapse into a single batch and only count as 1 against the cap. |
| **D2** | **Merge rule: combined `.length` < `MERGE_THRESHOLD_CHARS`.** When a new turn arrives, if `lastBatch.size + newTurn.size < MERGE_THRESHOLD_CHARS` (default 1000), append the new turn into `lastBatch` (queue length unchanged). Otherwise create a new batch (queue length +1). Size is measured in JS string `.length` (UTF-16 code units) for simplicity. Future versions may switch to token estimates. |
| **D3** | **Merged turns carry full content.** A merged turn appends its full prompt/response/obs blocks to the existing batch, identical to a standalone batch entry. Merging only collapses transport (one push instead of N), not content. |
| **D4** | **`prior_session` is per-batch state, not per-turn.** A batch includes `<prior_session>` only if the session summary was updated since the batch's first turn was added. If a session update arrives mid-batch, set a `sessionUpdated` flag on the batch and emit `<session-updated>` when the batch is flushed. Subsequent batches do not repeat `<prior_session>` until another update arrives. |
| **D5** | **Queue overflow → await flush oldest before returning.** When a new batch causes `queue.length > MAX_QUEUED_BATCHES`, the enqueue path **awaits** `flushOneBatch` before returning. This makes the cap a hard invariant — caller observes `queue.length <= MAX_QUEUED_BATCHES` after enqueue completes — and bounds worst-case latency at `MAX_QUEUED_BATCHES` worth of turn intervals. Fire-and-forget would only weaken the cap to "eventually", which is incompatible with the latency claim. |
| **D6** | **Keepalive consumes exactly one batch.** When `now - lastPushAt >= cacheTtlMs - KEEPALIVE_LEAD_MS` (default 60_000) and queue is non-empty, flush exactly one batch (the oldest). One batch per keepalive event keeps consumption rate evenly spread across the cache window. |
| **D7** | **Empty queue at keepalive → let cache expire.** If queue is empty when keepalive should fire, do nothing. No partial-turn half-obs fallback. No synthetic keepalive message. The cache expires naturally; the next completed turn that fills a batch will pay cache_creation. |
| **D8** | **Dynamic cache TTL detection.** After each `pushMessage` completes, parse the agent's own JSONL tail for the latest `message.usage.cache_creation` field. The agent JSONL lives at `~/.claude/projects/{encoded-cwd}/{agent-session}.jsonl` where `encoded-cwd` is CC's slug-encoded form of `DATA_DIR` (the worker's `cwd` passed to `query()` — currently encodes to `-Users-zhaoqixuan--claude-mnemo`). The file is **not** under a `subagents/` directory; the worker's query session is the top-level transcript for that project slug. If `ephemeral_1h_input_tokens > 0` set `state.cacheTtlMs = 3_600_000`. If only `ephemeral_5m_input_tokens > 0` set `state.cacheTtlMs = 300_000`. Default to 300_000 until first detection. |
| **D9** | **Cache TTL detection is best-effort and async.** JSONL writes by Claude Code may lag response receipt. Detection runs after `pushMessage` returns but does not block hot path. If the file does not contain a `cache_creation` entry yet, retain previous value. Errors (file missing, parse failure) silently fall back to default. |
| **D10** | **Configuration via `~/.claude-mnemo/config.json`.** New optional config file with these keys (all optional, with documented defaults): `mergeThresholdChars` (1000), `maxQueuedBatches` (3), `keepaliveLeadMs` (60_000), `cacheMode` (`"5m"` \| `"1h"` \| `"auto"`, default `"auto"`). The `cacheMode` setting maps to env vars passed to the agent subprocess: `"5m"` → `FORCE_PROMPT_CACHING_5M=1`, `"1h"` → `ENABLE_PROMPT_CACHING_1H=1`, `"auto"` → no env override (let CC default). |
| **D11** | **`KEEPALIVE_MS` constant is removed.** Replaced by computed `cacheTtlMs - keepaliveLeadMs`. The watchdog timer (10s tick from 2026-04-13 D4) checks against this computed boundary. |
| **D12** | **In-progress obs are never pushed standalone.** All obs accumulate in a local in-progress buffer until the owning turn completes. On turn-stop, the completed turn (with all its obs, prompt, response, files) enters the batch queue per D1/D2. Removes `processObs` standalone-push path, `buildInitialObsPrompt`, and the `state.initialized` flag. The agent only ever sees complete turns. |
| **D13** | **Cold-start and post-expiry are the same path.** First push for a new session, first push after worker restart, and first push after cache expiry all behave identically: the next batch flush (whether triggered by overflow, keepalive, session-end, or compact) pays cache_creation. No special-case "establish cache early" logic. |
| **D14** | **`<prior_session>` is included only when the session summary changed.** Removes the cold-start auto-include. The first batch after cold start does not automatically include `<prior_session>` — it is included only if a real session update happened. This unifies behavior across cold/warm/cold-after-expiry transitions. (Open question: agent may need session context on resume; if so, mark `sessionUpdated=true` on first batch after `state` is created or restored. See **Open question 1** below.) |
| **D15** | **Lock contract: enqueue and flush both run under the caller's session lock.** `enqueueCompletedTurn` is called from `processTurnStop` which already holds `withSessionProcessingLock`. The overflow-triggered `await flushOneBatch(...)` therefore runs **inside the same lock**. To prevent self-deadlock, `flushOneBatch` is implemented as `flushOneBatchLocked(state, ...)` — it assumes the caller holds the session lock and **never** re-acquires it. The same convention applies to keepalive-triggered flushes: `tryKeepaliveSession` already wraps its body in `withSessionProcessingLock`, so it must also call `flushOneBatchLocked`, not a re-locking variant. There is no `flushOneBatch` function that takes the lock itself. Existing helpers like `flushBufferedItems` / `flushExcessTurns` that **do** take the lock should be migrated or renamed to `*Locked` to match. |

---

## Non-goals

- Token-accurate size estimation (D2 uses character count for simplicity).
- Per-session config overrides (single global config in this spec).
- Adapting `MERGE_THRESHOLD_CHARS` based on observed sizes (static threshold).
- Cross-session keepalive (each session's queue is independent).
- Backporting to non-2.1.108+ CC versions (cache TTL choice is a CC feature).
- Real-time observability of in-progress turns from the agent's perspective. Long-running turns remain invisible to the agent until turn-stop arrives.
- Replacing the synchronous full-file `readFileSync` TTL probe with an async / reverse-tail reader. That is a follow-up optimization, not part of this spec.
- Config schema validation / bounds enforcement for `loadConfig`. Invalid values currently fall back only at the JSON parse layer; stricter validation is a separate follow-up.

---

## Open questions

1. **`<prior_session>` on cold-start resume.** When the worker restarts mid-session (or first sees a previously-tracked session), the new agent process has no memory of prior summary. Should the first batch after cold start force `sessionUpdated=true` to re-deliver `<prior_session>`? Defaulting to "yes" is safer; defaulting to "no" is cheaper. Recommendation: yes — mark `sessionUpdated=true` whenever the SessionState is freshly created and a prior session summary exists in DB.

---

## Design

### State additions

```ts
interface SessionState {
  // existing fields...
  cacheTtlMs: number;            // default 300_000, updated by D8 detection
  batchQueue: BatchEntry[];      // replaces buffer[items] for completed turns
}

interface BatchEntry {
  turns: TurnPayload[];          // 1+ turns merged together
  size: number;                  // sum of all turns' .length
  sessionUpdated: boolean;       // D4: whether to emit <session-updated>
  oldestTurnEpoch: number;       // for ordering / debugging
}

interface TurnPayload {
  turnId: number;
  prompt: string;
  response: string | null;
  obsBlocks: string[];           // pre-rendered obs xml blocks
  filesRead: string[];
  filesModified: string[];
  toolCallCount: number;
}
```

Note: in-progress obs are still buffered locally (per turn id) so that on turn-stop, the completed turn can be assembled with all its obs. But these in-progress obs **never** trigger a push by themselves. The keepalive degradation chain ("send half of partial obs") is removed (D7, D12).

### Enqueue path

**Precondition (D15): caller already holds `withSessionProcessingLock` for this session.**

```ts
async function enqueueCompletedTurnLocked(
  state: SessionState,
  turn: TurnPayload,
): Promise<void> {
  const newSize = computeTurnPayloadSize(turn);
  const last = state.batchQueue[state.batchQueue.length - 1];

  if (last && last.size + newSize < config.mergeThresholdChars) {
    last.turns.push(turn);
    last.size += newSize;
  } else {
    state.batchQueue.push({
      turns: [turn],
      size: newSize,
      sessionUpdated: false,
      oldestTurnEpoch: nowMs(),
    });
  }

  // D5: await so the cap is a hard invariant by the time enqueue returns.
  // D15: caller holds the lock; flushOneBatchLocked must NOT re-acquire it.
  if (state.batchQueue.length > config.maxQueuedBatches) {
    await flushOneBatchLocked(state);   // flush oldest, FIFO
  }
}
```

### Keepalive path (replaces 2026-04-13 D3 entirely)

The watchdog tick (10s, 2026-04-13 D4) inspects each session's state without the lock first (cheap pre-check), then enters `withSessionProcessingLock` only if a flush is warranted.

```ts
async function tickKeepalive(state: SessionState, now: number): Promise<void> {
  const age = now - state.lastPushAt;
  const triggerAt = state.cacheTtlMs - config.keepaliveLeadMs;
  if (age < triggerAt || age >= state.cacheTtlMs) return;
  if (state.lastPushAt > state.lastMessageAt) return;  // in-flight
  if (state.batchQueue.length === 0) return;            // D7/D12: let cache expire

  await withSessionProcessingLock(state.sessionDbId, async (lockedState) => {
    // re-check after acquiring the lock
    const ageNow = nowMs() - lockedState.lastPushAt;
    if (ageNow < lockedState.cacheTtlMs - config.keepaliveLeadMs) return;
    if (ageNow >= lockedState.cacheTtlMs) return;
    if (lockedState.lastPushAt > lockedState.lastMessageAt) return;
    if (lockedState.batchQueue.length === 0) return;
    await flushOneBatchLocked(lockedState);
  });
}
```

### Cache TTL detection

**Reuse `src/shared/paths.ts:23` `resolveTranscriptPath(DATA_DIR, agentSessionId)`.** Do **not** re-implement the slug encoding rule in `cache-ttl.ts` — the encoding regression (`/.` → `--`) was already fixed in `paths.ts:19` `encodeProjectPath`, and re-implementing it risks reintroducing the same bug.

```ts
import { DATA_DIR, resolveTranscriptPath } from "../shared/paths";

async function detectCacheTtl(agentSessionId: string): Promise<number | null> {
  const path = resolveTranscriptPath(DATA_DIR, agentSessionId);
  if (!existsSync(path)) return null;
  const tail = await readLastNLines(path, 30);
  for (const line of tail.reverse()) {
    try {
      const entry = JSON.parse(line);
      const cc = entry?.message?.usage?.cache_creation;
      if (!cc) continue;
      if ((cc.ephemeral_1h_input_tokens ?? 0) > 0) return 3_600_000;
      if ((cc.ephemeral_5m_input_tokens ?? 0) > 0) return 300_000;
    } catch { /* skip */ }
  }
  return null;
}
```

Note: there is no `subagents/` directory in this path. The worker's long-lived query session is the top-level transcript for the `DATA_DIR` project slug. Confirmed against the live install at `~/.claude/projects/-Users-zhaoqixuan--claude-mnemo/{uuid}.jsonl`.

Called as fire-and-forget after `state.pushMessage(...)`. On success, updates `state.cacheTtlMs`. On null/error, retains previous value.

### Configuration loader

`src/shared/config.ts` (new file):

```ts
export interface MnemoConfig {
  mergeThresholdChars: number;
  maxQueuedBatches: number;
  keepaliveLeadMs: number;
  cacheMode: "5m" | "1h" | "auto";
}

export const DEFAULT_CONFIG: MnemoConfig = {
  mergeThresholdChars: 1000,
  maxQueuedBatches: 3,
  keepaliveLeadMs: 60_000,
  cacheMode: "auto",
};

export function loadConfig(homePath = process.env.HOME ?? "~"): MnemoConfig {
  const path = `${homePath}/.claude-mnemo/config.json`;
  if (!existsSync(path)) return DEFAULT_CONFIG;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return { ...DEFAULT_CONFIG, ...raw };
  } catch {
    return DEFAULT_CONFIG;
  }
}
```

`cacheMode` → agent subprocess env (in `agent-session.ts`):

```ts
const cacheEnv: NodeJS.ProcessEnv = {};
if (config.cacheMode === "5m") cacheEnv.FORCE_PROMPT_CACHING_5M = "1";
else if (config.cacheMode === "1h") cacheEnv.ENABLE_PROMPT_CACHING_1H = "1";
// "auto" → empty, let CC default (currently 5m)
```

---

## Implementation

### Task 1: Add config loader

**Files:**
- Create: `src/shared/config.ts`
- Create: `tests/shared/config.test.ts`

Defaults match D10. Reads `~/.claude-mnemo/config.json` if present, merges over defaults.

### Task 2: Wire config into worker startup

**Files:**
- Modify: `src/worker/server.ts` (load config at startup, pass into query session creation)
- Modify: `src/worker/query-session.ts` (apply `cacheMode` → inject `FORCE_PROMPT_CACHING_5M` / `ENABLE_PROMPT_CACHING_1H` into the `env` object passed to `query()`, around line 301 where `env: { ...buildIsolatedEnv(), ENABLE_TOOL_SEARCH: "false" }` already exists)

`src/worker/agent-session.ts` is **not** the wiring point — it builds MCP server/tool definitions only. The Claude subprocess env comes from `query-session.ts`.

### Task 3: Replace buffer model with batch queue

**Files:**
- Modify: `src/worker/server.ts` (`SessionState.batchQueue`, `enqueueCompletedTurnLocked`, `flushOneBatchLocked`)
- Modify: `src/worker/processors.ts` (`buildBatchPrompt` handles multi-turn batches with optional `<session-updated>` block per D4; `processTurnStop` calls `enqueueCompletedTurnLocked` instead of immediate push)

Remove `RESERVE_TURNS` constant. `pruneBufferedUndoneItems` and undone-handling (2026-04-13 D7) must work against `batchQueue.turns` instead of flat `buffer.items`.

**Lock contract (D15):**
- All new functions that touch `state.batchQueue` are named `*Locked` and require the caller to hold `withSessionProcessingLock(sessionDbId)`.
- `enqueueCompletedTurnLocked`, `flushOneBatchLocked` never re-acquire the lock.
- The single re-locking entry points are `processTurnStop` (already wraps body in lock) and `tickKeepalive` (acquires lock only after the cheap pre-check passes).
- Existing `flushBufferedItems` and `flushExcessTurns` either already assume locked-caller or take their own lock — audit each call site and rename to `*Locked` if locked, or refactor the caller to pass through the lock if not. Mixed conventions are the root cause of the self-deadlock risk and must be eliminated.

**Removals (D12, D13, D14):**
- Delete `processObs` standalone-push path (obs no longer trigger pushes by themselves)
- Delete `buildInitialObsPrompt` and its caller branch
- Delete `state.initialized` field and all references; cold/warm/cold-after-expiry are unified
- Delete `tryPartialKeepalive` / "send half of in-progress obs" fallback
- `<prior_session>` is now driven only by `sessionUpdated` flag, with one exception: when SessionState is freshly created and a prior summary exists in DB, mark `sessionUpdated=true` on the next batch (Open question 1)

### Task 4: Replace KEEPALIVE_MS with computed boundary

**Files:**
- Modify: `src/worker/server.ts` (`tryKeepaliveSession` reads `state.cacheTtlMs - config.keepaliveLeadMs`)

Remove `KEEPALIVE_MS` and `CACHE_TTL_MS` module constants.

### Task 5: Cache TTL detection

**Files:**
- Create: `src/worker/cache-ttl.ts` (parse JSONL tail for `cache_creation`)
- Modify: `src/worker/server.ts` (call `detectCacheTtl` fire-and-forget after `pushMessage`)
- Create: `tests/worker/cache-ttl.test.ts`

**Path resolution: import `DATA_DIR` and `resolveTranscriptPath` from `src/shared/paths.ts` (lines 4 and 23).** Do not re-implement the slug encoding. `paths.ts:19` `encodeProjectPath` already handles the `/`, `:`, `\\`, `.` replacement correctly (the `/.` → `--` regression was fixed there recently). Re-implementing it in `cache-ttl.ts` would risk reintroducing the same bug.

### Task 6: Tests

| # | Case | Assert |
|---|---|---|
| 1 | Two tiny turns merge | Queue length stays 1 after second turn arrives, batch contains both turns' content |
| 2 | One tiny + one big turn | Queue length grows to 2, big turn becomes its own batch |
| 3 | Three tiny turns at threshold | Last turn that pushes combined size ≥ threshold creates new batch |
| 4 | Queue overflow | 4th batch arriving triggers flush of oldest |
| 5 | Keepalive consumes one batch | At `cacheTtlMs - leadMs`, queue length drops by 1 |
| 6 | Keepalive empty queue | No push; even if in-progress obs exist for some turn, no synthetic flush. Cache expires naturally. |
| 6b | In-progress obs alone | Long-running turn produces 50 obs over 2 hours; no push happens until turn-stop arrives |
| 6c | New session cold start | First turn-stop enters queue; no push until queue overflow or compact/session-end |
| 7 | TTL detection: 5m | After response with `ephemeral_5m_input_tokens > 0`, `cacheTtlMs == 300_000` |
| 8 | TTL detection: 1h | After response with `ephemeral_1h_input_tokens > 0`, `cacheTtlMs == 3_600_000` |
| 9 | TTL detection failure | File missing or no `cache_creation` field → state unchanged |
| 10 | Config defaults | Missing config file → all defaults applied |
| 11 | Config partial override | Only `mergeThresholdChars` set in JSON → other defaults applied |
| 12 | `cacheMode: "1h"` env wiring | Agent subprocess env contains `ENABLE_PROMPT_CACHING_1H=1` |
| 13 | `cacheMode: "5m"` env wiring | Agent subprocess env contains `FORCE_PROMPT_CACHING_5M=1` |
| 14 | `cacheMode: "auto"` env wiring | Neither env var set |
| 15 | `<session-updated>` per batch | Mid-batch session update sets flag, batch emits `<session-updated>` block when flushed; subsequent batch does not |
| 16 | Undone turn in queued batch | Undone turn removed from batch's `turns` array; if batch empty, batch removed from queue |
| 17 | SessionEnd / Compact | All queued batches flushed regardless of merge state (2026-04-13 D8) |

---

## Verification

- `bun test tests/shared/config.test.ts tests/worker/cache-ttl.test.ts tests/worker/server.test.ts tests/worker/processors.test.ts`
- `npm run typecheck`
- Manual: with `cacheMode: "1h"` in config, observe via `ps aux` that worker spawns agent with `ENABLE_PROMPT_CACHING_1H=1` in env, then verify next agent JSONL response shows `ephemeral_1h_input_tokens > 0`
- Manual: with `mergeThresholdChars: 5000`, run a session with many small Edit obs and verify multiple turns merge into single batches in the agent transcript
