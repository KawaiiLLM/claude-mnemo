# Failed-Turn Re-Extraction on Resume — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reliable "this turn should be extracted but isn't" signal and re-extract such turns when a session resumes.

**Architecture:** Extend the turn state machine (`provisional`, `failed`), gate `extracted` on substantive content to prevent phantom rows, mark the derailment floor `failed` (terminal), and add a SessionStart-triggered scan that re-enqueues stranded turns of the resuming session in `prompt_number` order.

**Tech Stack:** Bun + TypeScript. Tests: `bun test`. Typecheck: `bun run typecheck`. Bundle: `node scripts/build.js`.

**Spec:** `docs/plans/2026-06-02-failed-turn-reextraction.md` (read it for rationale; this plan is self-contained for code).

**Sequencing rationale:** Tasks 1–8 deliver the core recovery (`active` + legacy phantom) and the clean `failed` signal — low risk, no change to the 0.2.22 slicing core. Task 9 (`provisional` + finalizer) touches the 0.2.22 streaming/role-detection machinery and is the highest-risk task; it is decoupled (the recovery scan's `provisional` branch is simply inert until Task 9 lands) and sequenced last. Task 10 bumps the version and rebuilds.

**Standing constraint for executors:** Reviewer/fix subagents must use **read-only git** (never `checkout`/`restore`/`stash`/`reset`); the only tree-mutating git is each task's final `add`/`commit`. Verify `git status` after each subagent. Commit locally per task on a feature branch; **do not push** unless explicitly told.

---

### Task 1: Extend `TurnStatus` with `provisional` and `failed`

**Files:**
- Modify: `src/db/turns.ts:5`
- Modify: `tests/worker/server.test.ts:2402` (test-helper status union)
- Test: `tests/db/turns.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/db/turns.test.ts`, add:

```typescript
test("updateTurnById accepts the new provisional and failed statuses", () => {
  const db = createTestDb();
  const sessionId = insertSession(db);
  const turnId = insertTurn(db, sessionId, 1, { status: "active" });

  expect(updateTurnById(db, turnId, { status: "provisional" })?.status).toBe("provisional");
  expect(updateTurnById(db, turnId, { status: "failed" })?.status).toBe("failed");
});
```

Use the same `createTestDb`/`insertSession`/`insertTurn` helpers the existing tests in this file already use (copy their import/setup block).

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/db/turns.test.ts`
Expected: FAIL — TypeScript rejects `"provisional"`/`"failed"` as not assignable to `TurnStatus`.

- [ ] **Step 3: Extend the type**

`src/db/turns.ts:5` — change:

```typescript
export type TurnStatus = "active" | "extracted" | "skipped" | "undone";
```

to:

```typescript
export type TurnStatus =
  | "active"
  | "provisional"
  | "extracted"
  | "skipped"
  | "failed"
  | "undone";
```

In `tests/worker/server.test.ts:2402`, widen the test-helper status union to match:

```typescript
    status: "active" | "provisional" | "extracted" | "skipped" | "failed" | "undone",
```

Do **not** change `TURN_REMEMBER_STATUSES` in `src/mcp/remember.ts:24` — the agent must not be able to set `provisional`/`failed`.

- [ ] **Step 4: Run test + typecheck**

Run: `bun test tests/db/turns.test.ts && bun run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/db/turns.ts tests/db/turns.test.ts tests/worker/server.test.ts
git commit -m "feat(turns): add provisional and failed turn statuses"
```

---

### Task 2: Content gate — tighten `deriveTurnStatus` (no phantom from `remember`)

**Files:**
- Modify: `src/mcp/remember.ts:115`–`138`
- Test: `tests/mcp/remember.test.ts`

Context: `deriveTurnStatus` currently returns `"extracted"` when *any* of `title|content|insight|type|tags` is set, so `remember({ id:"T5", type:"bugfix" })` produces an `extracted` turn with null title/content — a phantom. The gate requires `title || content`.

- [ ] **Step 1: Write the failing test**

In `tests/mcp/remember.test.ts`, mirror the existing turn-remember tests' setup (find how they build the handler/db and call a turn `remember`). Add:

```typescript
test("turn remember with only type/tags (no title/content) is skipped, not extracted", async () => {
  const { db, remember } = setupRemember(); // use this file's existing harness
  const sessionId = insertSession(db);
  const turnId = insertTurn(db, sessionId, 1, { status: "active" });

  await remember({ id: `T${turnId}`, type: "bugfix", tags: ["auth"] });

  expect(getTurnById(db, turnId)?.status).toBe("skipped");
});

test("turn remember with content is extracted", async () => {
  const { db, remember } = setupRemember();
  const sessionId = insertSession(db);
  const turnId = insertTurn(db, sessionId, 1, { status: "active" });

  await remember({ id: `T${turnId}`, title: "Fixed auth race", content: "..." });

  expect(getTurnById(db, turnId)?.status).toBe("extracted");
});
```

(Match the real harness names in `tests/mcp/remember.test.ts`; the assertion `status === "skipped"` is what must fail today.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/mcp/remember.test.ts`
Expected: FAIL — first test gets `"extracted"`, expected `"skipped"`.

- [ ] **Step 3: Tighten the predicate**

`src/mcp/remember.ts:138` — change:

```typescript
  return input.title || input.content || input.insight || input.type || (input.tags?.length ?? 0) > 0
    ? "extracted"
    : "skipped";
```

to:

```typescript
  return input.title || input.content ? "extracted" : "skipped";
```

- [ ] **Step 4: Run test + typecheck**

Run: `bun test tests/mcp/remember.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/remember.ts tests/mcp/remember.test.ts
git commit -m "fix(remember): require title or content for extracted (no phantom)"
```

---

### Task 3: Content gate — guard the `updateTurnById` auto-promote

**Files:**
- Modify: `src/db/turns.ts:173`–`175`
- Test: `tests/db/turns.test.ts`

Context: `nextStatus = input.status ?? (existing.status === "active" ? "extracted" : existing.status)` auto-promotes an `active` turn to `extracted` whenever a caller omits `status` — even a metadata-only update with no content. All current callers dodge this by passing `status: turn.status` explicitly; this guard closes the trap permanently.

- [ ] **Step 1: Write the failing test**

In `tests/db/turns.test.ts`:

```typescript
test("metadata-only update on an active turn with no content stays active", () => {
  const db = createTestDb();
  const sessionId = insertSession(db);
  const turnId = insertTurn(db, sessionId, 1, { status: "active" });

  // No status, no title/content — only mechanical metadata.
  const updated = updateTurnById(db, turnId, { toolCallCount: 3 });

  expect(updated?.status).toBe("active");
});

test("auto-promote still fires when title is provided", () => {
  const db = createTestDb();
  const sessionId = insertSession(db);
  const turnId = insertTurn(db, sessionId, 1, { status: "active" });

  const updated = updateTurnById(db, turnId, { title: "Did a thing" });

  expect(updated?.status).toBe("extracted");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/db/turns.test.ts`
Expected: FAIL — first test gets `"extracted"`, expected `"active"`.

- [ ] **Step 3: Guard the auto-promote**

`src/db/turns.ts:173` — change:

```typescript
  const nextStatus =
    input.status ??
    (existing.status === "active" ? "extracted" : existing.status);
```

to:

```typescript
  const mergedTitle = input.title ?? existing.title;
  const mergedContent = input.content ?? existing.content;
  const hasSubstance = mergedTitle !== null || mergedContent !== null;
  const nextStatus =
    input.status ??
    (existing.status === "active" && hasSubstance
      ? "extracted"
      : existing.status);
```

- [ ] **Step 4: Run test + full suite**

Run: `bun test tests/db/turns.test.ts && bun run typecheck`
Expected: PASS. (If any existing test relied on content-less auto-promote, it was asserting the phantom bug — inspect and fix the assertion, do not weaken the guard.)

- [ ] **Step 5: Commit**

```bash
git add src/db/turns.ts tests/db/turns.test.ts
git commit -m "fix(turns): auto-promote to extracted only with substantive content"
```

---

### Task 4: `getStrandedTurns(db, sessionId)` query helper

**Files:**
- Modify: `src/db/turns.ts` (add export near `getTurnsForSession`)
- Test: `tests/db/turns.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
test("getStrandedTurns selects re-extractable failures in prompt_number order", () => {
  const db = createTestDb();
  const s = insertSession(db);
  const active = insertTurn(db, s, 1, { status: "active", assistantResponse: "r" });
  const provisional = insertTurn(db, s, 2, { status: "provisional", assistantResponse: "r" });
  const phantom = insertTurn(db, s, 3, { status: "extracted", title: null, content: null, assistantResponse: "r" });
  insertTurn(db, s, 4, { status: "extracted", title: "ok", content: "c", assistantResponse: "r" }); // valid
  insertTurn(db, s, 5, { status: "skipped", assistantResponse: "r" });                               // deliberate
  insertTurn(db, s, 6, { status: "failed", assistantResponse: "r" });                                // terminal
  insertTurn(db, s, 7, { status: "active", assistantResponse: null });                               // no response
  insertTurn(db, s, 8, { status: "extracted", title: "t", content: null, assistantResponse: "r" });  // title-only = valid

  const ids = getStrandedTurns(db, s).map((t) => t.id);
  expect(ids).toEqual([active, provisional, phantom]);
});
```

(Ensure `insertTurn` supports `assistantResponse` and null `title`/`content`; extend the test helper if needed.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/db/turns.test.ts`
Expected: FAIL — `getStrandedTurns` is not defined.

- [ ] **Step 3: Implement**

Add to `src/db/turns.ts` (after `getTurnsForSession`):

```typescript
export function getStrandedTurns(
  db: Database,
  sessionId: number,
): TurnRecord[] {
  return db
    .query<TurnRow, [number]>(
      `${TURN_SELECT}
       WHERE session_id = ?
         AND assistant_response IS NOT NULL
         AND ( status IN ('active','provisional')
               OR (status = 'extracted' AND title IS NULL AND content IS NULL) )
       ORDER BY prompt_number ASC`,
    )
    .all(sessionId)
    .map((row) => mapTurnRow(row))
    .filter((turn): turn is TurnRecord => turn !== null);
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `bun test tests/db/turns.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/turns.ts tests/db/turns.test.ts
git commit -m "feat(turns): add getStrandedTurns recovery query"
```

---

### Task 5: `resetTurnExtractionFields(db, turnId, updatedAtEpoch)` helper

**Files:**
- Modify: `src/db/turns.ts` (add export)
- Test: `tests/db/turns.test.ts`

Context: `updateTurnById`'s `?? existing` merge cannot null fields, and `turns.tags` mixes agent freeform (hyphenated) tags with internal colon-namespaced reminder tags that must survive a re-extraction. A direct `UPDATE` is required.

- [ ] **Step 1: Write the failing test**

```typescript
test("resetTurnExtractionFields clears agent output, keeps internal tags, drops FTS", () => {
  const db = createTestDb();
  const s = insertSession(db);
  const turnId = insertTurn(db, s, 1, {
    status: "provisional",
    title: "partial",
    content: "half",
    insight: "x",
    type: "note",
    assistantResponse: "r",
  });
  // freeform topic tag + internal colon-namespaced reminder tag
  updateTurnById(db, turnId, { replaceTags: ["auth", "delivery:dropped:notify-pending"] });

  resetTurnExtractionFields(db, turnId, 1234);

  const t = getTurnById(db, turnId)!;
  expect(t.status).toBe("active");
  expect(t.title).toBeNull();
  expect(t.content).toBeNull();
  expect(t.insight).toBeNull();
  expect(t.type).toBeNull();
  expect(t.tags).toEqual(["delivery:dropped:notify-pending"]); // freeform dropped, internal kept
  expect(t.assistantResponse).toBe("r");                       // source kept
  const fts = db.query("SELECT COUNT(*) AS n FROM memory_fts WHERE layer='turn' AND source_id=?").get(turnId) as { n: number };
  expect(fts.n).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/db/turns.test.ts`
Expected: FAIL — `resetTurnExtractionFields` is not defined.

- [ ] **Step 3: Implement**

Add to `src/db/turns.ts`:

```typescript
export function resetTurnExtractionFields(
  db: Database,
  turnId: number,
  updatedAtEpoch: number,
): void {
  const existing = getTurnById(db, turnId);
  if (!existing) {
    return;
  }
  // Keep colon-namespaced internal reminder tags; drop agent freeform tags.
  const keptTags = existing.tags.filter((tag) => tag.includes(":"));
  db.query(
    `UPDATE turns
       SET status = 'active',
           title = NULL,
           content = NULL,
           insight = NULL,
           type = NULL,
           tags = ?,
           updated_at_epoch = ?
       WHERE id = ?`,
  ).run(stringifyArray(keptTags), updatedAtEpoch, turnId);
  db.query(
    "DELETE FROM memory_fts WHERE layer = 'turn' AND source_id = ?",
  ).run(turnId);
}
```

(`stringifyArray` is already defined in this file.)

- [ ] **Step 4: Run test + typecheck**

Run: `bun test tests/db/turns.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/turns.ts tests/db/turns.test.ts
git commit -m "feat(turns): add resetTurnExtractionFields for fresh re-extraction"
```

---

### Task 6: Derailment floor stamps `failed` (was `skipped`)

**Files:**
- Modify: `src/worker/server.ts:1046` (`applyFloor`)
- Modify: `tests/worker/server.test.ts` (floor assertions near `:2505`/`:2544`)
- Test: `tests/worker/server.test.ts`

- [ ] **Step 1: Update the failing assertion(s)**

In `tests/worker/server.test.ts`, find the floor test(s) that assert a floored never-extracted turn becomes `"skipped"` (around `:2505` and the `// finalized` case at `:2544`). For the assertion that corresponds to the **derailment floor** finalizing a never-extracted turn, change the expectation to `"failed"`:

```typescript
    expect(getTurnById(db, turnId)?.status).toBe("failed");
```

Leave assertions for *deliberate* `remember({status:"skipped"})` turns as `"skipped"`. Read each test's setup to classify it; only the floor-driven one changes.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/worker/server.test.ts`
Expected: FAIL — floor still writes `"skipped"`, test now expects `"failed"`.

- [ ] **Step 3: Change `applyFloor`**

`src/worker/server.ts:1046` — change:

```typescript
        updateTurnById(deps.db, turnId, { status: "skipped" });
```

to:

```typescript
        updateTurnById(deps.db, turnId, { status: "failed" });
```

Also update the adjacent log line text from `"derailment floor: turn skipped (no extraction)"` to `"derailment floor: turn failed (no extraction)"` for accuracy.

- [ ] **Step 4: Run test + typecheck**

Run: `bun test tests/worker/server.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/worker/server.ts tests/worker/server.test.ts
git commit -m "fix(worker): derailment floor marks turns failed (terminal), not skipped"
```

---

### Task 7: `queueItemExistsForTurn` dedup helper

**Files:**
- Modify: `src/db/pending-queue.ts`
- Test: `tests/db/pending-queue.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
test("queueItemExistsForTurn detects an existing item of a kind for a target", () => {
  const db = createTestDb();
  enqueueQueueItem(db, { kind: "turn-stop", targetId: 42, sessionDbId: 1, enqueuedAtEpoch: 1 });

  expect(queueItemExistsForTurn(db, "turn-stop", 42)).toBe(true);
  expect(queueItemExistsForTurn(db, "turn-stop", 99)).toBe(false);
  expect(queueItemExistsForTurn(db, "obs", 42)).toBe(false);
});
```

(Use this file's existing `createTestDb` helper.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/db/pending-queue.test.ts`
Expected: FAIL — `queueItemExistsForTurn` is not defined.

- [ ] **Step 3: Implement**

Add to `src/db/pending-queue.ts`:

```typescript
export function queueItemExistsForTurn(
  db: Database,
  kind: PendingQueueKind,
  targetId: number,
): boolean {
  const row = db
    .query<{ n: number }, [PendingQueueKind, number]>(
      "SELECT COUNT(*) AS n FROM pending_queue WHERE kind = ? AND target_id = ?",
    )
    .get(kind, targetId);
  return (row?.n ?? 0) > 0;
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `bun test tests/db/pending-queue.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/pending-queue.ts tests/db/pending-queue.test.ts
git commit -m "feat(queue): add queueItemExistsForTurn dedup helper"
```

---

### Task 8: `recoverStrandedTurns(db, sessionDbId, nowEpoch)` orchestrator

**Files:**
- Create: `src/db/recover-stranded.ts`
- Test: `tests/db/recover-stranded.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/db/recover-stranded.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { recoverStrandedTurns } from "../../src/db/recover-stranded";
import { enqueueQueueItem, listPendingQueueItems } from "../../src/db/pending-queue";
import { getTurnById } from "../../src/db/turns";
// reuse the same test-db + insert helpers the other db tests use:
import { createTestDb, insertSession, insertTurn } from "../support/db"; // adjust import to the real helper location

describe("recoverStrandedTurns", () => {
  test("resets + enqueues stranded turns in prompt_number order, deduped", () => {
    const db = createTestDb();
    const s = insertSession(db);
    const t1 = insertTurn(db, s, 1, { status: "active", assistantResponse: "r" });
    const t2 = insertTurn(db, s, 2, { status: "extracted", title: null, content: null, assistantResponse: "r" });
    insertTurn(db, s, 3, { status: "extracted", title: "ok", content: "c", assistantResponse: "r" }); // valid, ignored
    const t4 = insertTurn(db, s, 4, { status: "active", assistantResponse: "r" });
    enqueueQueueItem(db, { kind: "turn-stop", targetId: t4, sessionDbId: s, enqueuedAtEpoch: 1 }); // already queued

    const count = recoverStrandedTurns(db, s, 5000);

    expect(count).toBe(2); // t1, t2 (t4 deduped, t3 valid)
    expect(getTurnById(db, t2)?.status).toBe("active"); // phantom reset
    const queued = listPendingQueueItems(db).filter((i) => i.kind === "turn-stop").map((i) => i.targetId);
    expect(queued).toEqual([t4, t1, t2]); // t4 pre-existing, then t1 then t2 by prompt_number
  });
});
```

If `tests/support` lacks shared `createTestDb`/`insertSession`/`insertTurn`, copy the inline helpers used at the top of `tests/db/turns.test.ts` instead of importing.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/db/recover-stranded.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/db/recover-stranded.ts`:

```typescript
import type { Database } from "bun:sqlite";

import { enqueueQueueItem, queueItemExistsForTurn } from "./pending-queue";
import { getStrandedTurns, resetTurnExtractionFields } from "./turns";

/**
 * Scan the session for turns that should have been extracted but weren't
 * (`active` / `provisional` / legacy phantom `extracted`), reset each to a
 * fresh `active` state, and re-enqueue a `turn-stop` item in prompt_number
 * order. Idempotent: a turn that already has a queued `turn-stop` is skipped.
 * Returns the number of turns re-enqueued.
 */
export function recoverStrandedTurns(
  db: Database,
  sessionDbId: number,
  nowEpoch: number,
): number {
  const stranded = getStrandedTurns(db, sessionDbId); // prompt_number ASC
  let recovered = 0;
  for (const turn of stranded) {
    if (queueItemExistsForTurn(db, "turn-stop", turn.id)) {
      continue;
    }
    resetTurnExtractionFields(db, turn.id, nowEpoch);
    enqueueQueueItem(db, {
      kind: "turn-stop",
      targetId: turn.id,
      sessionDbId,
      enqueuedAtEpoch: nowEpoch,
    });
    recovered += 1;
  }
  return recovered;
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `bun test tests/db/recover-stranded.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/recover-stranded.ts tests/db/recover-stranded.test.ts
git commit -m "feat(recovery): add recoverStrandedTurns orchestrator"
```

---

### Task 9: Wire recovery into SessionStart (`resume`/`compact`)

**Files:**
- Modify: `src/hooks/handlers/context.ts` (`buildContextOutput`)
- Test: `tests/hooks/context.test.ts`

Context: `buildContextOutput` already performs a synchronous DB side effect (`upsertSession`) and reads `input.source`. Add the recovery scan as a sibling synchronous side effect — **no `asyncWork`** (that would suppress the context output; `src/hooks/hook-command.ts:141`). The worker drains on the next natural wake.

- [ ] **Step 1: Write the failing test**

In `tests/hooks/context.test.ts` (follow the file's existing handler-construction pattern):

```typescript
test("resume runs stranded-turn recovery and still returns context output", async () => {
  const db = createTestDb();
  const handler = createContextHandler({ db });
  const session = upsertSession(db, { contentSessionId: "sess-1", project: "/p", title: null, content: null, insight: null, createdAtEpoch: 1, updatedAtEpoch: null, completedAtEpoch: null });
  insertTurn(db, session.id, 1, { status: "active", assistantResponse: "r" });

  const result = await handler({ sessionId: "sess-1", cwd: "/p", source: "resume", transcriptPath: null, prompt: null } as any);

  // recovery enqueued the stranded turn
  expect(listPendingQueueItems(db).some((i) => i.kind === "turn-stop")).toBe(true);
  // context output is still produced (not suppressed)
  expect(typeof result.hookSpecificOutput).toBe("string");
  expect(result.asyncWork).toBeUndefined();
});

test("startup does NOT run recovery", async () => {
  const db = createTestDb();
  const handler = createContextHandler({ db });
  const session = upsertSession(db, { contentSessionId: "sess-2", project: "/p", title: null, content: null, insight: null, createdAtEpoch: 1, updatedAtEpoch: null, completedAtEpoch: null });
  insertTurn(db, session.id, 1, { status: "active", assistantResponse: "r" });

  await handler({ sessionId: "sess-2", cwd: "/p", source: "startup", transcriptPath: null, prompt: null } as any);

  expect(listPendingQueueItems(db).filter((i) => i.kind === "turn-stop").length).toBe(0);
});
```

Adjust the input shape to the real `NormalizedHookInput` fields used elsewhere in this test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/hooks/context.test.ts`
Expected: FAIL — no `turn-stop` enqueued on resume.

- [ ] **Step 3: Implement**

In `src/hooks/handlers/context.ts`, import:

```typescript
import { recoverStrandedTurns } from "../../db/recover-stranded";
```

Inside `buildContextOutput`, after `primarySessionRecord` is resolved (and is non-null), before building output:

```typescript
  if (
    (input.source === "resume" || input.source === "compact") &&
    primarySessionRecord
  ) {
    recoverStrandedTurns(
      db,
      primarySessionRecord.id,
      Math.floor(Date.now() / 1000),
    );
  }
```

(Place it where `primarySessionRecord` is known to be non-null — i.e., after the `if (!primarySessionRecord) return EMPTY_CONTEXT_FALLBACK;` guard. This keeps recovery from firing for sessions with no record yet.)

- [ ] **Step 4: Run test + typecheck**

Run: `bun test tests/hooks/context.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/handlers/context.ts tests/hooks/context.test.ts
git commit -m "feat(hooks): run stranded-turn recovery on resume/compact SessionStart"
```

---

### Task 10: `provisional` slice status + completion finalizer (HIGH-RISK — touches 0.2.22 slicing)

**Files:**
- Modify: `src/worker/server.ts` (`enqueueAndFlushStreamingSliceLocked` ~`:1320`, slice peel loop ~`:1418`, `processTurnStopLocked` final/short path, `hadPriorDelivery` ~`:1433`)
- Test: `tests/worker/server.streaming.test.ts`

> **Dispatch with the most capable model and review most carefully.** This is the only task that changes the recently-shipped 0.2.22 streaming/role-detection core. The recovery scan's `provisional` branch is inert until this lands, so a regression here cannot break Tasks 1–9.

Goal: a streamed turn is `provisional` (not `extracted`) from its first slice until the final-slice completion point, so that (a) skipping a mid-slice does not mark the turn `skipped`, and (b) an interruption mid-stream leaves it `provisional` (re-extraction target). A short / single-shot turn must **never** become `provisional` before role detection (or `hadPriorDelivery` at `:1433` would misclassify it `final`).

- [ ] **Step 1: Write the failing tests**

In `tests/worker/server.streaming.test.ts` (reuse this file's worker-core harness):

```typescript
test("a streamed turn is provisional after a mid-slice, extracted only at the final slice", async () => {
  // drive a turn large enough to peel >=1 streaming slice, then the final slice.
  // after the first mid-slice flush + remember: turn status === "provisional"
  // after the final turn-stop completes with content: status === "extracted"
});

test("a short single-shot turn is never provisional and finalizes extracted", async () => {
  // drive a small turn (no streaming slices).
  // it must be classified `short` (not `final`) and end `extracted`, never passing through `provisional`.
});

test("a worker stop mid-stream leaves the turn provisional (recoverable)", async () => {
  // after a mid-slice but before the final turn-stop, the turn status === "provisional".
});
```

Fill these in against the streaming harness already used in this file (it knows how to feed obs that exceed `maxMiniTurnChars` to force slicing). The assertions above are the contract.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/worker/server.streaming.test.ts`
Expected: FAIL — today a mid-slice turn is `extracted`, not `provisional`.

- [ ] **Step 3: Implement the provisional hold + finalizer**

In `enqueueAndFlushStreamingSliceLocked` (`src/worker/server.ts:1320`), after the slice is delivered and `state.streamedParts.set(turn.id, …)` (`:1346`), set the turn to `provisional` so a mid-slice `remember`'s auto-`extracted` is demoted and an interruption leaves it `provisional`:

```typescript
  updateTurnById(deps.db, turnId, { status: "provisional" });
```

This is safe for `hadPriorDelivery` (`:1433`): a `provisional` turn satisfies `status !== "active"` (→ `final`), and a short turn never reaches this code so it stays `active` (→ `short`).

At the **final-slice / short completion** in `processTurnStopLocked`, the agent's final `remember` resolves the turn via `deriveTurnStatus` (content → `extracted` gated by Task 2/3; content-less deliberate skip → `skipped`); the existing floor path handles a no-remember derailment → `failed` (Task 6). No extra finalizer code is needed beyond ensuring the final completion path does **not** leave the turn `provisional` — verify a completed final slice ends `extracted`/`skipped`/`failed`, never `provisional`.

- [ ] **Step 4: Run streaming tests + FULL suite + typecheck**

Run: `bun test && bun run typecheck`
Expected: PASS. Pay attention to existing 0.2.22 streaming/floor tests — if any asserted a mid-slice turn is `extracted`, update it to `provisional` only if that matches the new contract; otherwise investigate a real regression.

- [ ] **Step 5: Commit**

```bash
git add src/worker/server.ts tests/worker/server.streaming.test.ts
git commit -m "feat(worker): provisional status for in-flight slices, finalize at completion"
```

---

### Task 11: Version bump + rebuild bundle

**Files:**
- Modify: `package.json` (`version`)
- Modify: built bundle (via `node scripts/build.js`)

- [ ] **Step 1: Bump version**

`package.json` — change `"version": "0.2.22"` to `"version": "0.2.23"`.

- [ ] **Step 2: Run the full suite + typecheck**

Run: `bun test && bun run typecheck`
Expected: all green, typecheck clean.

- [ ] **Step 3: Rebuild the bundle**

Run: `node scripts/build.js`
Expected: prints a `BUILD_ID` like `0.2.23-<base36>`; bundle regenerated.

- [ ] **Step 4: Commit**

```bash
git add package.json $(git status --porcelain | awk '{print $2}' | grep -i dist || true)
git commit -m "chore: rebuild 0.2.23 bundle (failed-turn re-extraction on resume)"
```

(Stage whatever build artifacts `node scripts/build.js` regenerates — check `git status` and add the changed bundle file(s).)

---

## Self-Review

**Spec coverage:**
- Component 1 (state machine) → Task 1 (`provisional`/`failed`), Task 6 (`failed` from floor), Task 10 (`provisional` lifecycle).
- Component 2 (content gate) → Task 2 (`deriveTurnStatus`), Task 3 (auto-promote guard).
- Component 3 (`provisional` for slices) → Task 10.
- Component 4 (`failed` from floor only; drop unchanged) → Task 6 (drop path deliberately untouched — no task, by design).
- Component 5 (recovery scan: detect → reset → enqueue, ordering, dedup, exclusions) → Task 4 (`getStrandedTurns`), Task 5 (`resetTurnExtractionFields`), Task 7 (dedup), Task 8 (orchestrator), Task 9 (SessionStart trigger).
- Version/build → Task 11.

**Placeholder scan:** every code step has real code; test steps for Task 10 give the contract assertions with explicit instructions to fill against the existing streaming harness (its mechanics are file-local and not reproducible verbatim here without the harness).

**Type consistency:** `TurnStatus` (Task 1) is used by `getStrandedTurns`/`resetTurnExtractionFields` (Tasks 4–5), `recoverStrandedTurns` (Task 8), and `applyFloor` (Task 6). `PendingQueueKind` `"turn-stop"` and `enqueueQueueItem({kind,targetId,sessionDbId,enqueuedAtEpoch})` match `src/db/pending-queue.ts`. `recoverStrandedTurns(db, sessionDbId, nowEpoch)` signature is identical in Task 8 and Task 9.

**Risk note:** Tasks 1–9 + 11 are independent of the 0.2.22 streaming core. Task 10 is the sole high-risk change and is gated behind a full-suite run; its absence does not break the rest (the `provisional` scan branch is simply never populated).
