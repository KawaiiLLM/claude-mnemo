# Unified Turn Identifiers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `recall` and `replay` use the same public turn identifier: `(session_id, promptNumber)`.

**Architecture:** Keep the database schema unchanged and treat `turn.id` as an internal primary key only. Change `recall` validation, lookup, and formatting so turn navigation is session-scoped and matches `replay`, while observation ids stay globally addressable.

**Tech Stack:** TypeScript, Bun, SQLite, Zod, bun:test

---

### Task 1: Red Tests For Unified Turn Semantics

**Files:**
- Modify: `tests/mcp/recall.test.ts`
- Modify: `tests/mcp/write-tools.test.ts` (only if schema-level validation coverage belongs here)

- [ ] **Step 1: Write failing recall behavior tests**

```ts
test("shows observations for a session-scoped turn prompt number", () => {
  const output = recallMemory(db, { session: authSessionId, turn: 1 });

  expect(output).toContain("[T1] Diagnose auth race | 2 obs");
  expect(output).toContain("[O1] bugfix: Auth mutex");
});

test("rejects turn lookup without session context", () => {
  const output = recallMemory(db, { turn: 1 });

  expect(output).toBe(
    "Parameter error: turn requires session; use recall(session=142, turn=3).",
  );
});

test("rejects expand_turns without session context", () => {
  const output = recallMemory(db, { expandTurns: [1] });

  expect(output).toBe(
    "Parameter error: expand_turns requires session; use recall(session=142, expand_turns=[1]).",
  );
});

test("renders session turns with promptNumber-only labels", () => {
  const output = recallMemory(db, { session: authSessionId });

  expect(output).toContain("[T1] Diagnose auth race | 2 obs");
  expect(output).not.toContain("#1");
});

test("renders search turn hits with session and promptNumber context", () => {
  const output = recallMemory(db, { query: "race" });

  expect(output).toContain("[S2][T1] Diagnose auth race | 2 obs");
});
```

- [ ] **Step 2: Run targeted tests to verify failure**

Run: `~/.bun/bin/bun test tests/mcp/recall.test.ts`
Expected: FAIL because `recall` still uses DB turn ids, still accepts bare `turn`, silently ignores bare `expand_turns`, and still prints `[T<db id>] #<promptNumber>`.

- [ ] **Step 3: Commit red-test checkpoint only if work requires handoff**

```bash
git add tests/mcp/recall.test.ts
git commit -m "test: define unified turn identifier behavior"
```

Skip this commit if implementation follows immediately in the same session.

### Task 2: Implement Session-Scoped Recall Lookup And Formatting

**Files:**
- Modify: `src/mcp/recall.ts`
- Modify: `src/mcp/format.ts`
- Modify: `src/mcp/server.ts`
- Read: `src/db/turns.ts`

- [ ] **Step 1: Add minimal validation helper in `src/mcp/recall.ts`**

```ts
function validateRecallInput(input: RecallInput): string | null {
  if (input.observation !== undefined) {
    const hasOtherSelector =
      input.session !== undefined ||
      input.turn !== undefined ||
      (input.expandTurns?.length ?? 0) > 0;

    if (hasOtherSelector) {
      return "Parameter error: observation cannot be combined with session, turn, or expand_turns.";
    }
  }

  if (input.turn !== undefined && input.session === undefined) {
    return "Parameter error: turn requires session; use recall(session=142, turn=3).";
  }

  if ((input.expandTurns?.length ?? 0) > 0 && input.session === undefined) {
    return "Parameter error: expand_turns requires session; use recall(session=142, expand_turns=[1]).";
  }

  return null;
}
```

- [ ] **Step 2: Change turn lookup in `src/mcp/recall.ts` to use `getTurn(db, sessionId, promptNumber)`**

```ts
function formatTurnObservations(
  db: Database,
  sessionId: number,
  promptNumber: number,
): string {
  const turn = getTurn(db, sessionId, promptNumber);

  if (!turn) {
    return "Turn not found.";
  }

  // existing expanded formatting logic
}
```

- [ ] **Step 3: Update recall entrypoint to validate first and route session-scoped turn requests**

```ts
export function recallMemory(db: Database, input: RecallInput): string {
  const validationError = validateRecallInput(input);

  if (validationError) {
    return validationError;
  }

  if (input.observation !== undefined) {
    return formatObservationDetail(db, input.observation);
  }

  if (input.session !== undefined && input.turn !== undefined) {
    return formatTurnObservations(db, input.session, input.turn);
  }

  // existing branches remain
}
```

- [ ] **Step 4: Split turn formatting in `src/mcp/format.ts` into session-scoped and cross-session forms**

```ts
export function formatTurnCollapsed(turn: FormattedTurn): string {
  return `  [T${turn.promptNumber}] ${turn.title ?? "Untitled"} | ${turn.observationCount} obs`;
}

export function formatTurnSearchResult(
  sessionId: number,
  turn: FormattedTurn,
): string {
  return `[S${sessionId}][T${turn.promptNumber}] ${turn.title ?? "Untitled"} | ${turn.observationCount} obs`;
}
```

- [ ] **Step 5: Update search-result formatting in `src/mcp/recall.ts` to use `[Sx][Ty]` for turn hits**

```ts
return formatTurnSearchResult(result.sessionId, {
  promptNumber: turn.promptNumber,
  title: turn.title,
  observationCount: getObservationsForTurn(db, turn.id).length,
});
```

- [ ] **Step 6: Add schema-level guard in `src/mcp/server.ts` if needed**

If the MCP layer already delegates all parameter semantics to `recallMemory`, keep schema shape unchanged and do not add Zod cross-field refinement. If the server has tests for validation behavior, add a `.superRefine()` requiring `session` when `turn` or `expand_turns` is present.

- [ ] **Step 7: Run targeted tests to verify green**

Run: `~/.bun/bin/bun test tests/mcp/recall.test.ts`
Expected: PASS

- [ ] **Step 8: Commit implementation**

```bash
git add src/mcp/recall.ts src/mcp/format.ts src/mcp/server.ts tests/mcp/recall.test.ts
git commit -m "feat: unify recall turn identifiers with replay"
```

### Task 3: Align Docs And Skill Text

**Files:**
- Modify: `plugin/skills/mnemo/SKILL.md`
- Modify: `docs/design.md`
- Modify: `docs/plans/2026-04-05-claude-mnemo.md`

- [ ] **Step 1: Update examples and parameter tables**

Change all `recall(turn=3)` examples to `recall(session=142, turn=3)` and describe turn ids as session-scoped prompt numbers.

- [ ] **Step 2: Update output examples**

Replace session turn labels like:

```text
[T3] #2 Diagnose auth race | 2 obs
```

with:

```text
[T2] Diagnose auth race | 2 obs
```

and ensure cross-session search examples use `[S142][T2]`.

- [ ] **Step 3: Run a docs consistency pass**

Search for stale examples:

Run: `rg -n "recall\\(turn=|#\\d+ .*obs|\\[T\\d+\\] #" docs plugin/skills`
Expected: no stale DB-id turn examples remain

### Task 4: Full Verification

**Files:**
- Test: `tests/mcp/recall.test.ts`
- Test: `tests/mcp/replay.test.ts`
- Test: `tests`

- [ ] **Step 1: Run focused MCP tests**

Run: `~/.bun/bin/bun test tests/mcp/recall.test.ts tests/mcp/replay.test.ts`
Expected: PASS

- [ ] **Step 2: Run full test suite**

Run: `~/.bun/bin/bun test tests`
Expected: PASS

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Review final diff**

Run: `git diff --stat HEAD~1..HEAD`
Expected: recall lookup, formatting, tests, and docs all aligned with the new session-scoped turn API.

- [ ] **Step 5: Final commit for docs alignment if Task 3 was not included earlier**

```bash
git add plugin/skills/mnemo/SKILL.md docs/design.md docs/plans/2026-04-05-claude-mnemo.md
git commit -m "docs: align recall turn references with prompt numbers"
```
