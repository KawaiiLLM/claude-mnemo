# Query Dedup Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove repeated transcript parsing and repeated DB queries introduced during the enrich-session-start-context work, and clean up low-risk test debt without changing behavior.

**Architecture:** Keep all public behavior, output, and lifecycle semantics unchanged. This cleanup only restructures internal data flow so functions query once and pass results down, then tidies tests to restore type checking and remove small defects.

**Tech Stack:** TypeScript, Bun, bun:sqlite, Bun test

---

## File Structure

- Modify: `src/hooks/backfill.ts`
  - Allow Stop to reuse one parsed replay transcript result instead of reparsing.
- Modify: `src/hooks/handlers/stop.ts`
  - Parse replay transcript once and share it with backfill + undo detection.
- Modify: `src/hooks/handlers/context.ts`
  - Query recent sessions once, build primary session once, avoid duplicate `buildFormattedSession()` calls.
- Modify: `src/mcp/recall.ts`
  - Stop querying `getTurnsForSession()` twice for the same session search result.
- Modify: `tests/mcp/format.test.ts`
  - Remove unnecessary `as any` where possible, fix indentation drift.
- Modify: `tests/hooks/context.test.ts`
  - Remove unused local variable.
- Test: `tests/hooks/stop.test.ts`
  - Lock the single-parse / shared-transcript data flow if needed.
- Test: `tests/hooks/context.test.ts`
  - Ensure refactor preserves output behavior.
- Test: `tests/mcp/recall.test.ts`
  - Ensure session search output is unchanged.
- Test: `tests/mcp/format.test.ts`
  - Keep formatter expectations intact after test cleanup.

---

### Task 1: Deduplicate Stop Transcript Parsing

**Files:**
- Modify: `src/hooks/backfill.ts`
- Modify: `src/hooks/handlers/stop.ts`
- Test: `tests/hooks/stop.test.ts`

- [ ] **Step 1: Write a failing regression test**
  - Add a stop-hook test that spies on transcript parsing or otherwise proves the stop path does not need to fully parse the transcript twice for one event.
  - If spying is awkward, add a narrow unit around helper boundaries so Stop passes pre-parsed transcript turns into both backfill and undo detection.

- [ ] **Step 2: Run test to verify it fails**

Run: `~/.bun/bin/bun test tests/hooks/stop.test.ts`
Expected: FAIL because Stop currently parses replay transcript once in backfill and once in undo detection.

- [ ] **Step 3: Implement the minimal refactor**
  - In `src/hooks/backfill.ts`, accept pre-parsed replay turns or a lookup map.
  - In `src/hooks/handlers/stop.ts`, parse replay transcript once per hook event and pass the result to both:
    - shared backfill
    - undo detection
  - Preserve:
    - `lastAssistantMessage` shortcut
    - stale detection behavior
    - queued-turn prompt construction

- [ ] **Step 4: Run test to verify it passes**

Run: `~/.bun/bin/bun test tests/hooks/stop.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/hooks/backfill.ts src/hooks/handlers/stop.ts tests/hooks/stop.test.ts
git commit -m "refactor: share replay transcript parsing in stop hook"
```

---

### Task 2: Deduplicate Context Queries

**Files:**
- Modify: `src/hooks/handlers/context.ts`
- Test: `tests/hooks/context.test.ts`

- [ ] **Step 1: Write a failing regression test**
  - Add a focused test around the internal data flow, or use small helper extraction, so the context builder can be verified to:
    - query recent sessions once
    - construct the primary session once
  - If direct call counting is awkward, extract helpers that accept already-fetched data and test those boundaries.

- [ ] **Step 2: Run test to verify it fails**

Run: `~/.bun/bin/bun test tests/hooks/context.test.ts`
Expected: FAIL because context currently queries recent sessions twice and builds the primary session twice.

- [ ] **Step 3: Implement the minimal refactor**
  - Fetch `getRecentSessions(db, { limit: 5 })` once in the top-level context path.
  - Resolve the primary session from that data + `getSessionByContentId`.
  - Build the primary formatted session once, then derive last-3 turn numbers from the already-loaded turns instead of rebuilding the same session.
  - Keep all output formatting and truncation behavior unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `~/.bun/bin/bun test tests/hooks/context.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/hooks/handlers/context.ts tests/hooks/context.test.ts
git commit -m "refactor: reduce duplicate context queries"
```

---

### Task 3: Deduplicate Recall Session Search Stats

**Files:**
- Modify: `src/mcp/recall.ts`
- Test: `tests/mcp/recall.test.ts`

- [ ] **Step 1: Write a failing regression test**
  - Add a small test or helper-boundary assertion proving session search result formatting derives turn and observation counts from one fetched turn list per session search hit, not repeated `getTurnsForSession()` calls.

- [ ] **Step 2: Run test to verify it fails**

Run: `~/.bun/bin/bun test tests/mcp/recall.test.ts`
Expected: FAIL because session search result formatting currently calls `getTurnsForSession()` twice.

- [ ] **Step 3: Implement the minimal refactor**
  - In the session-search branch of `formatSearchResults`, fetch `getTurnsForSession(db, session.id)` once.
  - Derive both `turnCount` and `observationCount` from that one array.
  - Keep all rendered output identical.

- [ ] **Step 4: Run test to verify it passes**

Run: `~/.bun/bin/bun test tests/mcp/recall.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp/recall.ts tests/mcp/recall.test.ts
git commit -m "refactor: reuse session turns in recall search formatting"
```

---

### Task 4: Test Cleanup

**Files:**
- Modify: `tests/mcp/format.test.ts`
- Modify: `tests/hooks/context.test.ts`

- [ ] **Step 1: Clean up tests without changing behavior**
  - Remove unnecessary `as any` where the formatter types already allow the fixture shape.
  - Fix the indentation drift in `tests/mcp/format.test.ts`.
  - Remove the unused local variable in `tests/hooks/context.test.ts`.

- [ ] **Step 2: Run focused tests**

Run: `~/.bun/bin/bun test tests/mcp/format.test.ts tests/hooks/context.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add tests/mcp/format.test.ts tests/hooks/context.test.ts
git commit -m "test: clean up formatter and context test fixtures"
```

---

### Task 5: Full Verification

**Files:**
- Modify: all files touched above as needed

- [ ] **Step 1: Run focused suites**

Run: `~/.bun/bin/bun test tests/hooks/stop.test.ts tests/hooks/context.test.ts tests/mcp/recall.test.ts tests/mcp/format.test.ts`
Expected: PASS

- [ ] **Step 2: Run full test suite**

Run: `~/.bun/bin/bun test tests`
Expected: PASS

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Run build**

Run: `npm run build`
Expected: PASS

- [ ] **Step 5: Commit final polish only if verification exposed a real issue**

```bash
git add src tests
git commit -m "chore: finalize query dedup cleanup"
```
