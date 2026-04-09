# Extraction Context Optimization Design

## Goal

Optimize the context injected into the Mnemosyne extraction agent for cache efficiency, correctness, and concurrency safety. Separate extraction context building from the general-purpose recall API.

## Problems

### 1. Concurrent extraction causes duplicate processing

Two stop hooks firing in quick succession can each fork a Mnemosyne agent. The claim mechanism (`extracting_pending`) prevents double-claiming the same turn, but `formatDisplayStatus` maps `extracting_pending` → `[pending]` in the context. The second agent sees already-claimed turns as `[pending]` and processes them via `remember()` (UPSERT), overwriting the first agent's results.

### 2. All turns expanded regardless of status

`buildStopPrompt` calls `recallMemory({ view: "turns", session, depth: "expanded" })`, which expands all surviving turns equally. Extracted/skipped turns don't need prompt/response/insight — only pending/stale turns do. This wastes tokens and reduces cache efficiency.

### 3. Extraction context coupled to recall API

The stop hook uses `recallMemory()` to build context, but extraction context has different requirements than memory queries: it needs status markers, status-aware fold/expand, and doesn't need the full recall routing/search/selector logic. Mixing these concerns makes both harder to evolve.

### 4. Prompt cache underutilized

After moving CONVERSATION CONTEXT to the prompt suffix (already done), the static prompt prefix (~11.5k tokens) caches well. But the context itself is rebuilt from scratch on every hook invocation, even though most of it hasn't changed.

### 5. No cache continuity across extractions

Within a session, each extraction rebuilds the full turn list. But earlier turns (extracted/skipped) don't change — they form a stable prefix in the context. This stable portion could be reused across API calls if positioned correctly.

### 6. Extraction context grows unboundedly

Each extraction appends a new collapsed turn to the context. Over a long session with many turns, the Layer 2 collapsed prefix grows without bound. Even though each collapsed turn is small (~30 tokens), a session with 100+ turns accumulates significant context overhead with diminishing dedup value.

## Design

### 1. Atomic concurrency guard in `claimTurnsForExtraction`

Add a `NOT EXISTS` guard to the existing claim SQL so it only succeeds when no other extraction is in progress for the session:

```sql
UPDATE turns
SET status = CASE status
    WHEN 'pending' THEN 'extracting_pending'
    WHEN 'stale' THEN 'extracting_stale'
END,
updated_at_epoch = ?
WHERE session_id = ?
  AND status IN ('pending', 'stale')
  AND NOT EXISTS (
    SELECT 1 FROM turns
    WHERE session_id = ?
    AND status IN ('extracting_pending', 'extracting_stale')
  )
```

Single atomic statement. If another extraction is running, `claimedCount = 0`, no fork. Pending turns stay pending and are picked up by the next hook invocation. No new functions, tables, or columns.

Recovery via existing `recoverStalledExtractions()` handles crash cases (extracting turns older than 300s are reverted).

### 2. Status-aware context builder

Replace `recallMemory()` in stop/compact hooks with a dedicated `buildExtractionContext()` that uses format primitives directly:

```typescript
function buildExtractionContext(db: Database, sessionId: number): string {
  const session = getSession(db, sessionId);
  const turns = getTurnsForSession(db, sessionId);

  const lines: string[] = [];

  // Turns first (collapsed prefix is cacheable)
  // After claim, actionable turns are extracting_pending/extracting_stale.
  // Use isActionable() to match both pre-claim (pending/stale) and
  // post-claim (extracting_pending/extracting_stale) statuses.
  for (const turn of turns) {
    const view = buildTurnView(db, turn);
    if (isActionableStatus(turn.status)) {
      // Expand: show prompt, response, insight for extraction
      lines.push(formatTurnExpanded(view, { sessionId }));
      // Include observations for stale re-evaluation
      for (const obs of view.observations ?? []) {
        lines.push(formatObservationCollapsed(obs, {
          indent: "    ", sessionId, turnPromptNumber: turn.promptNumber,
        }));
      }
    } else {
      // Collapse: title + status only
      lines.push(formatTurnCollapsed(view, { sessionId }));
    }
  }

  // Session header last (updated each extraction, doesn't break prefix cache)
  lines.push(formatSessionExpanded(buildSessionView(db, session)));

  return lines.join("\n");
}
```

Where `isActionableStatus` is:
```typescript
function isActionableStatus(status: string | null): boolean {
  return status === "pending" || status === "stale"
      || status === "extracting_pending" || status === "extracting_stale";
}
```

`formatDisplayStatus` already maps `extracting_pending` → `pending` and `extracting_stale` → `stale` in the rendered output, so the agent sees `[pending]`/`[stale]` regardless of whether context is built before or after claim.

Key differences from `recallMemory()`:
- Status markers always present (agent needs them to decide what to process)
- Actionable turns (pending/stale/extracting_*) expanded, all others collapsed
- No sampling/omission logic (extraction must see all turns for dedup context)
- No search/selector/routing overhead

### 3. Apply to both stop and compact hooks

Both `buildStopPrompt()` and compact's `buildPrompt()` currently call `recallMemory()`. Replace both with `buildExtractionContext()`:

**stop.ts:**
```typescript
function buildStopPrompt(db: Database, sessionDbId: number): string {
  return buildMnemosynePrompt(buildExtractionContext(db, sessionDbId));
}
```

**compact.ts:**
```typescript
function buildPrompt(db: Database, sessionDbId: number): string {
  return buildMnemosynePrompt(buildExtractionContext(db, sessionDbId));
}
```

### 4. Reorder stop hook: claim before context

Move `claimTurnsForExtraction` before `buildStopPrompt` so the context reflects post-claim state. Claimed turns become `extracting_pending`/`extracting_stale`; the context builder shows them as `[pending]`/`[stale]` (via displayStatus mapping). Since concurrent extraction is blocked by the NOT EXISTS guard, no other agent will see these turns.

```
recover → backfill → stale detection → markStale → claim → (skip if 0) → build context → fork
```

### 5. Context layout for cache-friendly turn append

The extraction context places stable content first (cacheable prefix) and dynamic content last:

```
[Static Mnemosyne prompt]              ← cached across all sessions (~1,200 tokens)
[Turns in chronological order]
  [T1 collapsed] ← stable, extends cacheable prefix
  [T2 collapsed] ← stable, extends cacheable prefix
  ...
  [TN expanded]  ← new pending turn, fresh content
[Session header (latest from DB)]      ← updated each extraction, at the tail
```

The session header is placed AFTER turns, not before. This is because:
1. Session summary changes after each extraction (agent calls `remember({ id: "S{id}", ... })`)
2. Placing it before turns would invalidate the entire turn prefix cache on every update
3. Collapsed turns already carry title + status — the agent can process them without the session header
4. The agent reads the latest session summary last, then decides whether to update it

Earlier turns (extracted/skipped) are collapsed (~30 tokens each) and don't change between extractions. They form a monotonically growing cacheable prefix. Each new extraction adds one collapsed turn to this prefix, and only the tail (new pending turn + session header) is fresh.

### 6. Compact as context trim point

Compact doesn't delete old turns from DB, and `buildExtractionContext` renders all turns. To keep context from growing without bound, use compact as an anchor: record the compact point and only include turns after it in Layer 2.

**Storage**: Add `last_compact_turn INTEGER` column to the sessions table. Default `NULL` (no anchor, include all turns). This is a persistent column, not a derived signal — compact anchors must survive process restarts.

**Timing**: The anchor is written **only after the compact extraction succeeds** (async `forkMnemosyne` returns without error). This ensures the session summary has absorbed the pre-anchor history before those turns are filtered out. If the extraction crashes or fails, the anchor is not advanced and the next hook will see all turns including the pre-anchor ones.

Compact hook flow:
```
recover → backfill → claim → (skip if 0) → build context → fork async:
  await forkMnemosyne(...)          // extraction must succeed
  updateCompactAnchor(db, session)  // only then advance anchor
```

```typescript
function updateCompactAnchor(db: Database, sessionId: number): void {
  // Anchor covers all non-pending turns — any turn that has been
  // processed (extracted, skipped, undone) or is no longer actionable.
  db.query(
    `UPDATE sessions SET last_compact_turn = (
       SELECT MAX(prompt_number) FROM turns
       WHERE session_id = ?
         AND status NOT IN ('pending', 'stale', 'extracting_pending', 'extracting_stale')
     ) WHERE id = ?`,
  ).run(sessionId, sessionId);
}
```

On subsequent extractions, `buildExtractionContext` filters:
```typescript
const anchor = session.lastCompactTurn ?? 0;
const turns = getTurnsForSession(db, sessionId)
  .filter(t => t.promptNumber > anchor || isActionableStatus(t.status));
```

Turns at or before the anchor are excluded from Layer 2 — their information is already captured in the session summary (Layer 1). This keeps context compact after long sessions.

Over a long session the cycle is:
```
[turns accumulate in Layer 2] → [compact: extract, then set anchor] → [Layer 2 resets to post-anchor turns only]
```

Note: the session summary (title/content/insight/next_steps) is the compressed representation of all pre-anchor history. The agent relies on Layer 1 for historical context and Layer 2 only for recent/actionable turns.

## Files Changed

| File | Change |
|------|--------|
| `src/db/turns.ts` | Add NOT EXISTS guard to `claimTurnsForExtraction` SQL |
| `src/db/schema.ts` | Add `last_compact_turn` column to sessions table |
| `src/db/sessions.ts` | Support reading/writing `lastCompactTurn` |
| `src/mnemosyne/context.ts` | New file: `buildExtractionContext()` with `isActionableStatus`, compact anchor filter |
| `src/hooks/handlers/stop.ts` | Use `buildExtractionContext`, reorder claim before context build |
| `src/hooks/handlers/compact.ts` | Use `buildExtractionContext`, record compact anchor after extraction |
| `tests/hooks/stop.test.ts` | Test concurrent claim returns 0; test context fold/expand by status |
| `tests/mnemosyne/context.test.ts` | Test actionable turns expanded (including extracting_*), others collapsed; test compact anchor filtering |

## Cache Behavior Analysis

**Within a session (stop hook N → stop hook N+1):**
```
Cached prefix:  [static prompt] + [T1..T(N-1) collapsed]
New content:    [TN expanded] + [session header v(N)]
```
Each extraction adds one collapsed turn to the prefix. The cacheable prefix grows monotonically. Session header is always fresh at the tail — it doesn't break the prefix.

**Across sessions (different user sessions):**
```
Cached prefix:  [static prompt] only (~1,200 tokens)
New content:    [all turns] + [session header]
```
Turns and session header differ per session, but the static prompt is shared.

**After compact:**
```
Cached prefix:  [static prompt]
New content:    [post-anchor turns only] + [session header]
```
Compact anchor trims pre-anchor turns. Cache prefix restarts from the static prompt, growing again as new turns accumulate.

## What Does NOT Change

- `recallMemory()` — stays as-is for agent/user memory queries, no extraction logic
- `formatTurnCollapsed/Expanded` — reused as-is, no modifications
- `buildMnemosynePrompt()` — still wraps context with static instructions
- `formatDisplayStatus` — still maps extracting_* for display (safe now because concurrent extraction is blocked)

## Verification

1. `bun test` — all existing tests pass
2. New test: two sequential `claimTurnsForExtraction` calls for same session — second returns 0
3. New test: `buildExtractionContext` output has pending turns expanded, extracted turns collapsed
4. New test: `buildExtractionContext` expands `extracting_pending`/`extracting_stale` turns (post-claim)
5. New test: compact anchor filters out pre-anchor turns from context
6. Manual test: rapid consecutive prompts — only one Mnemosyne agent forks per session
7. Manual test: after compact, context only contains post-anchor turns
