# Fresh Session Context in Batch Prompts

**Goal:** Replace the stale `firstUserPrompt` in the worker's `<session>` header with context that reflects the session's current state, so the Mnemosyne agent understands what the user is actually doing — not what they said on turn 1.

---

## Problem

`processBatch` in `src/worker/processors.ts:518-528` queries:

```sql
SELECT user_prompt FROM turns
WHERE session_id = ? ORDER BY prompt_number ASC LIMIT 1
```

This value is injected as `user_request` in every batch prompt for the lifetime of the worker session. Observed in production: worker session `bc9f55c9` processed 39 turns of S931 (spanning code review → version bumping → job description analysis → project documentation writing), but every batch prompt said `user_request: 你上下文里有什么` — the session's very first prompt.

The agent can still extract observations correctly (obs content is self-contained), but its ability to judge **relevance and priority** is degraded: it cannot distinguish a turn that advances the session's main goal from a tangential aside, because it has no visibility into the session's evolving intent.

---

## Design

Replace the single `firstUserPrompt` field with a two-tier context:

1. **`session.title`** — one-line session summary (updated by the agent itself via `remember`). When present, this is the best single-line description of what the session is about.
2. **Batch-local latest prompt** — the `user_prompt` of the highest-`prompt_number` turn in the current batch. This shows the user's most recent intent at the time of this specific batch.

### New `<session>` header format

```xml
<session id="S931">
  project: /Users/zhaoqixuan/Projects/claude-mnemo
  title: v0.2.8: recall-first docs + token economics
  current_prompt: 版本号更新了吗，更新了提交
</session>
```

- `title` — from `session.title`. Omit the line entirely if null (session hasn't been summarized yet).
- `current_prompt` — `user_prompt` of the last turn in the batch (highest `prompt_number` among `turnStopItems`). If the batch contains no completed turns, emit no `current_prompt` line. Do **not** reintroduce the old `firstTurn` query for a fallback; under D12 this path should not be needed, and if it ever happens we prefer omission over reviving stale session-wide context.
- `user_request` field is **removed**.

When `priorTitle`/`priorContent` are injected (after `sessionUpdated`), the `<prior_session>` block continues to work as-is — it carries the full summary. The `<session>` header's `title` field is the compact one-liner; `<prior_session>` is the full context. They complement, not duplicate.

---

## Changes

### `buildBatchPrompt` (`src/worker/processors.ts`)

| Current | New |
|---------|-----|
| `firstUserPrompt: string \| null` param | **Remove.** Replace with `sessionTitle: string \| null` and `currentPrompt: string \| null`. |
| Template: `user_request: ${args.firstUserPrompt ?? ""}` | Template: conditionally emit `title:` and `current_prompt:` lines (omit each if null). |

### `processBatch` (`src/worker/processors.ts`)

| Current | New |
|---------|-----|
| Queries `ORDER BY prompt_number ASC LIMIT 1` for `firstTurn` | **Remove the firstTurn query entirely.** |
| Passes `firstUserPrompt: firstTurn?.user_prompt` | Pass `sessionTitle: session.title` and `currentPrompt` derived from the batch's turn-stop items (see below). |

Deriving `currentPrompt`:

```typescript
// The last completed turn in this batch (highest prompt_number).
const lastTurnInBatch = (options?.turnStopItems ?? [])
  .map((item) => getTurnById(db, item.targetId))
  .filter((t): t is NonNullable<typeof t> => t !== null)
  .sort((a, b) => b.promptNumber - a.promptNumber)[0];

const currentPrompt = lastTurnInBatch?.userPrompt ?? null;
```

### `buildBatchPrompt` template

```typescript
export function buildBatchPrompt(args: {
  sessionId: number;
  project: string;
  sessionTitle: string | null;      // was firstUserPrompt
  currentPrompt: string | null;     // new
  priorTitle: string | null;
  priorContent: string | null;
  priorInsight: string | null;
  priorNextSteps: string | null;
  sessionUpdated?: boolean;
  completedTurnBlocks: string[];
}): string {
  // ...existing sessionUpdatedBlock and priorSessionBlock logic...

  const titleLine = args.sessionTitle
    ? `\n  title: ${args.sessionTitle}`
    : "";
  const promptLine = args.currentPrompt
    ? `\n  current_prompt: ${truncateMiddle(args.currentPrompt, 200)}`
    : "";

  return `<session id="S${args.sessionId}">
  project: ${args.project}${titleLine}${promptLine}
</session>
${sessionUpdatedBlock}
${priorSessionBlock}
<batch>
${body}
</batch>`;
}
```

Truncate `current_prompt` to 200 chars via the existing `truncateMiddle` helper — the full prompt is already in the `<turn>` block inside `<batch>`.

---

## Tests

Existing tests in `tests/worker/` that call `buildBatchPrompt` or `processBatch` need to update the param name from `firstUserPrompt` to `sessionTitle` + `currentPrompt`. The primary test surfaces are:

- `tests/worker/processors.test.ts` — prompt template and `processBatch` rendering.
- `tests/worker/server.test.ts` — batch queue integration, especially merged multi-turn batches and `sessionUpdated` propagation.

Verify:

1. **Title present** — `<session>` block includes `title:` line.
2. **Title null** — `title:` line omitted (not `title: null`).
3. **Current prompt present** — `current_prompt:` line present, truncated if > 200 chars.
4. **Current prompt null** — `current_prompt:` line omitted, with no `firstTurn` fallback query.
5. **Merged batch picks latest turn** — when one batch contains multiple completed turns, `current_prompt` comes from the highest `prompt_number`.
6. **`sessionUpdated` still stable** — only the flagged batch gets `<prior_session>`, even when `title` and `current_prompt` are both present.
7. **Old `user_request` absent** — no test or output references `user_request`.

---

## Non-goals

- Injecting the full session `content`/`insight` on every batch. That's what `<prior_session>` does on `sessionUpdated`.
- Tracking session phase changes or topic shifts. The `title` field already captures the high-level summary; the agent itself decides when to update it.
- Changing `<prior_session>` injection logic (D4, D14 from the adaptive-batch-queue spec remain in force).
