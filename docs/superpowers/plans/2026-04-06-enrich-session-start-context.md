# Enrich SessionStart Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify the enriched emoji/list output across `recall`, `replay`, and the SessionStart context hook while adding `next_steps` and `tool_call_count` persistence.

**Architecture:** Keep the existing SQLite-backed data model and MCP surface, but extend the schema with additive columns and route all rendering through a rewritten `src/mcp/format.ts`. Move transcript backfill to one shared replay-compatible resolver so Stop, PreCompact, replay, and adoption all use the same turn numbering semantics.

**Tech Stack:** TypeScript, Bun, bun:sqlite, Bun test

---

## File Structure

- Modify: `src/db/schema.ts`
  - Add new columns to fresh-schema SQL and a repeatable `migrateSchema()` for existing DBs.
- Modify: `src/db/sessions.ts`
  - Add `nextSteps` to records and upsert logic.
- Modify: `src/db/turns.ts`
  - Add `toolCallCount` to records and DB writes.
- Modify: `src/mcp/update-session.ts`
  - Accept and persist `next_steps`.
- Modify: `src/mcp/server.ts`
  - Extend `update_session` schema with `next_steps`.
- Modify: `src/mcp/format.ts`
  - Rewrite formatting around emoji stats, markdown list structure, and collapsed/expanded field visibility.
- Modify: `src/mcp/recall.ts`
  - Populate the new format model: counts, `nextSteps`, expanded/collapsed views.
- Modify: `src/mcp/replay.ts`
  - Update overview lines to `- [Tx] ... | 🔧n` with `⏪` for undone.
- Create: `src/hooks/backfill.ts`
  - Shared replay-compatible transcript backfill for Stop and PreCompact.
- Modify: `src/hooks/handlers/stop.ts`
  - Replace inline backfill with shared helper.
- Modify: `src/hooks/handlers/compact.ts`
  - Replace inline backfill, remove `extractAssistantResponse` dependency.
- Modify: `src/hooks/handlers/context.ts`
  - Build enriched SessionStart output, anchor on current session, enforce truncation budgets.
- Modify: `src/mnemosyne/prompt.ts`
  - Add `next_steps` guidance to `update_session`.
- Modify: `tests/db/schema.test.ts`
  - Add migration and additive-column coverage.
- Modify: `tests/db/sessions.test.ts`
  - Add `next_steps` upsert coverage.
- Modify: `tests/db/turns.test.ts`
  - Add `tool_call_count` mapping coverage if needed.
- Modify: `tests/mcp/format.test.ts`
  - Rewrite expected strings for new output contract.
- Modify: `tests/mcp/recall.test.ts`
  - Cover enriched session/turn/observation output.
- Modify: `tests/mcp/replay.test.ts`
  - Cover replay overview formatting and tool-call counts.
- Modify: `tests/hooks/context.test.ts`
  - Cover current-session anchoring, graduated depth, truncation, and header counts.
- Modify: `tests/hooks/stop.test.ts`
  - Cover shared backfill writing `tool_call_count`.
- Modify: `tests/hooks/compact.test.ts`
  - Cover shared backfill use in PreCompact and dependency cleanup.

---

### Task 1: Add Schema, Records, and MCP Surface

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/db/sessions.ts`
- Modify: `src/db/turns.ts`
- Modify: `src/mcp/update-session.ts`
- Modify: `src/mcp/server.ts`
- Test: `tests/db/schema.test.ts`
- Test: `tests/db/sessions.test.ts`

- [ ] **Step 1: Write failing schema and session tests**
  - Add a schema test that:
    - creates an in-memory DB with old tables missing `next_steps` / `tool_call_count`
    - runs `initializeSchema(db)` and `migrateSchema(db)`
    - asserts both columns now exist
    - reruns `migrateSchema(db)` and expects no throw
  - Add a session test that:
    - writes `next_steps`
    - updates the same session without `next_steps`
    - asserts the original value is preserved

- [ ] **Step 2: Run tests to verify they fail**

Run: `~/.bun/bin/bun test tests/db/schema.test.ts tests/db/sessions.test.ts`
Expected: FAIL because `next_steps`, `tool_call_count`, and `migrateSchema()` are not implemented yet.

- [ ] **Step 3: Implement additive schema and record changes**
  - In `src/db/schema.ts`:
    - add `next_steps TEXT` to `sessions`
    - add `tool_call_count INTEGER` to `turns`
    - export `migrateSchema(db)` that checks `pragma_table_info` before `ALTER TABLE`
  - In `src/db/sessions.ts`:
    - add `nextSteps` to `SessionRecord` / `UpsertSessionInput`
    - preserve it with `COALESCE(excluded.next_steps, sessions.next_steps)`
  - In `src/db/turns.ts`:
    - add `toolCallCount` to row mapping
  - In `src/mcp/update-session.ts` and `src/mcp/server.ts`:
    - accept `next_steps`
    - pass it through to `upsertSession`

- [ ] **Step 4: Run tests to verify they pass**

Run: `~/.bun/bin/bun test tests/db/schema.test.ts tests/db/sessions.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts src/db/sessions.ts src/db/turns.ts src/mcp/update-session.ts src/mcp/server.ts tests/db/schema.test.ts tests/db/sessions.test.ts
git commit -m "feat: add session next steps and tool call count fields"
```

---

### Task 2: Rewrite Format Renderer

**Files:**
- Modify: `src/mcp/format.ts`
- Test: `tests/mcp/format.test.ts`

- [ ] **Step 1: Write failing format tests**
  - Replace old assertions with explicit expectations for:
    - `- [Sx] title | 💬n 💡n | yyyy-mm-dd | project`
    - `- [Tx] title | 💡n 📖n ✏️n 🔧n`
    - `- [Ox] 🔵 title`
    - `desc:` always visible in collapsed form
    - `narrative`, `facts`, `concepts`, `files` only in expanded observation form
    - cross-session turn prefix `- [Sx][Ty] ...`
    - zero-value stat omission

- [ ] **Step 2: Run tests to verify they fail**

Run: `~/.bun/bin/bun test tests/mcp/format.test.ts`
Expected: FAIL because current format still uses `[Sx] ... | 2 obs`, `description:`, and non-emoji output.

- [ ] **Step 3: Rewrite `src/mcp/format.ts`**
  - Add `TYPE_EMOJI` map and `typeEmoji()`
  - Change `formatEpoch()` to `YYYY-MM-DD`
  - Extend formatted interfaces with:
    - `FormattedSession.nextSteps`, `turnCount`, `observationCount`
    - `FormattedTurn.toolCallCount`, `filesReadCount`, `filesModifiedCount`
  - Rewrite session, turn, and observation formatters to the markdown list structure from the spec
  - Keep one shared `formatTree()` path for recall/context to minimize drift

- [ ] **Step 4: Run tests to verify they pass**

Run: `~/.bun/bin/bun test tests/mcp/format.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp/format.ts tests/mcp/format.test.ts
git commit -m "feat: rewrite memory output formatter"
```

---

### Task 3: Update Recall and Replay Output

**Files:**
- Modify: `src/mcp/recall.ts`
- Modify: `src/mcp/replay.ts`
- Test: `tests/mcp/recall.test.ts`
- Test: `tests/mcp/replay.test.ts`

- [ ] **Step 1: Write failing recall and replay tests**
  - In `tests/mcp/recall.test.ts`, add expectations that:
    - `recall()` returns collapsed sessions with `desc:`
    - `recall(session=x)` renders `insight`, `next_steps`, and collapsed turns with stats
    - `recall(session=x, turn=y)` renders expanded turn fields and collapsed observations
    - `recall(observation=x)` renders expanded observation fields
  - In `tests/mcp/replay.test.ts`, add expectations that:
    - overview lines use `- [Tx] prompt | 🔧n`
    - undone turns use `⏪`
    - `#N` no longer appears in overview

- [ ] **Step 2: Run tests to verify they fail**

Run: `~/.bun/bin/bun test tests/mcp/recall.test.ts tests/mcp/replay.test.ts`
Expected: FAIL because recall/replay still emit the old format model.

- [ ] **Step 3: Implement recall/replay integration**
  - In `src/mcp/recall.ts`:
    - populate `turnCount`, `observationCount`, `nextSteps`, `toolCallCount`, file counts
    - keep turn lookup semantics unchanged (`session + promptNumber`)
  - In `src/mcp/replay.ts`:
    - update overview formatter to use `- ` prefix, `⏪`, and `🔧n`
    - leave detailed replay output unchanged

- [ ] **Step 4: Run tests to verify they pass**

Run: `~/.bun/bin/bun test tests/mcp/recall.test.ts tests/mcp/replay.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp/recall.ts src/mcp/replay.ts tests/mcp/recall.test.ts tests/mcp/replay.test.ts
git commit -m "feat: enrich recall and replay output"
```

---

### Task 4: Introduce Shared Replay-Compatible Backfill

**Files:**
- Create: `src/hooks/backfill.ts`
- Modify: `src/hooks/handlers/stop.ts`
- Modify: `src/hooks/handlers/compact.ts`
- Modify: `src/db/turns.ts`
- Test: `tests/hooks/stop.test.ts`
- Test: `tests/hooks/compact.test.ts`

- [ ] **Step 1: Write failing hook tests**
  - Add a stop test with sidechain history where:
    - pending turn `prompt_number` resolves only through replay-compatible numbering
    - `assistant_response` and `tool_call_count` are both written
  - Add a compact test that:
    - verifies PreCompact also writes `assistant_response` and `tool_call_count`
    - no longer needs an `extractAssistantResponse` dependency

- [ ] **Step 2: Run tests to verify they fail**

Run: `~/.bun/bin/bun test tests/hooks/stop.test.ts tests/hooks/compact.test.ts`
Expected: FAIL because Stop/PreCompact still use separate backfill logic and do not persist `tool_call_count`.

- [ ] **Step 3: Implement shared backfill**
  - Create `src/hooks/backfill.ts` with a helper like:
    - `backfillFromTranscript(db, pendingTurns, transcriptPath, lastAssistantMessage?)`
  - Use one `parseReplayTranscript()` pass keyed by `promptNumber`
  - Update `assistant_response` and `tool_call_count` in one DB write
  - Switch both `stop.ts` and `compact.ts` to this helper
  - Remove `extractAssistantResponse` from `CompactHandlerDependencies`

- [ ] **Step 4: Run tests to verify they pass**

Run: `~/.bun/bin/bun test tests/hooks/stop.test.ts tests/hooks/compact.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/hooks/backfill.ts src/hooks/handlers/stop.ts src/hooks/handlers/compact.ts src/db/turns.ts tests/hooks/stop.test.ts tests/hooks/compact.test.ts
git commit -m "fix: unify transcript backfill across hooks"
```

---

### Task 5: Build Enriched SessionStart Context

**Files:**
- Modify: `src/hooks/handlers/context.ts`
- Modify: `src/db/schema.ts`
- Modify: `src/db/sessions.ts`
- Modify: `src/mcp/recall.ts`
- Modify: `src/mnemosyne/prompt.ts`
- Test: `tests/hooks/context.test.ts`
- Test: `tests/mnemosyne/prompt.test.ts`

- [ ] **Step 1: Write failing context tests**
  - Extend `tests/hooks/context.test.ts` to cover:
    - current-session anchoring by `input.sessionId`
    - primary session expanded with only last 3 turns expanded
    - next 2 sessions collapsed header + max 5 collapsed turns
    - last 2 sessions header only
    - truncation for long `desc`, `prompt`, `response`
    - global header counts
  - Add a prompt test that checks `next_steps` guidance appears in the `update_session` section

- [ ] **Step 2: Run tests to verify they fail**

Run: `~/.bun/bin/bun test tests/hooks/context.test.ts tests/mnemosyne/prompt.test.ts`
Expected: FAIL because the current context hook only lists collapsed recent sessions and the prompt has no `next_steps` guidance.

- [ ] **Step 3: Implement context builder and prompt guidance**
  - In `src/hooks/handlers/context.ts`:
    - accept `NormalizedHookInput`
    - resolve primary session from `getSessionByContentId`
    - build header with global session/observation counts
    - render primary/secondary sessions with graduated depth and truncation rules from the spec
  - In `src/mnemosyne/prompt.ts`:
    - extend the `update_session` section with `next_steps` guidance

- [ ] **Step 4: Run tests to verify they pass**

Run: `~/.bun/bin/bun test tests/hooks/context.test.ts tests/mnemosyne/prompt.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/hooks/handlers/context.ts src/mnemosyne/prompt.ts tests/hooks/context.test.ts tests/mnemosyne/prompt.test.ts
git commit -m "feat: enrich session start context output"
```

---

### Task 6: Full Verification

**Files:**
- Modify: all files touched above as needed

- [ ] **Step 1: Run focused suites**

Run: `~/.bun/bin/bun test tests/db/schema.test.ts tests/db/sessions.test.ts tests/mcp/format.test.ts tests/mcp/recall.test.ts tests/mcp/replay.test.ts tests/hooks/stop.test.ts tests/hooks/compact.test.ts tests/hooks/context.test.ts tests/mnemosyne/prompt.test.ts`
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

- [ ] **Step 5: Commit final polish if needed**

```bash
git add src docs tests
git commit -m "chore: finalize enriched memory output and context hook"
```
