# Schema Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove legacy compatibility baggage from the DB access layer, MCP schemas, and Mnemosyne tooling so the runtime only reads/writes canonical fields and only exposes the current tool surface.

**Architecture:** Keep DB migrations so old databases still upgrade correctly, but stop dual-writing and stop reading legacy columns outside migration code. Rename recall's public selector field from `scope` to `view`, remove deprecated recall aliases and superseded write tools, and make Mnemosyne use the simplified tool contract (`remember`, `recall`, `replay`) only.

**Tech Stack:** TypeScript, Bun test, SQLite, esbuild, committed plugin build artifacts

---

### Task 1: Simplify session/turn/observation DB reads and writes

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/db/sessions.ts`
- Modify: `src/db/turns.ts`
- Modify: `src/db/observations.ts`
- Modify: `src/db/search.ts`
- Test: `tests/db/sessions.test.ts`
- Test: `tests/db/turns.test.ts`
- Test: `tests/db/observations.test.ts`
- Test: `tests/db/search.test.ts`
- Test: `tests/db/schema.test.ts`

- [ ] **Step 1: Update sessions schema naming and migration**

In `src/db/schema.ts`:
- change the sessions table definition to use `created_at_epoch`
- rename the sessions timestamp index to `idx_sessions_project_created_at`
- add a migration that renames `started_at_epoch` to `created_at_epoch` when needed
- keep old content/insight/tags migration code intact

Important:
- migration must be idempotent
- migration must run before any SELECT path depends on canonical columns

- [ ] **Step 2: Stop dual-writing session compatibility fields**

In `src/db/sessions.ts`:
- rename `startedAtEpoch` to `createdAtEpoch`
- remove `description` from `SessionRecord` and `UpsertSessionInput`
- delete fallback helpers such as `resolveSessionContent()`
- remove `COALESCE(content, description)` from reads
- only write `content` and `created_at_epoch`

- [ ] **Step 3: Simplify turns and observations in the turn write path**

In `src/db/turns.ts`:
- remove `description` from turn input/output types
- remove `description`, `narrative`, `facts`, `concepts` from observation input/output types
- delete fallback helpers that merge legacy observation fields
- stop selecting or writing legacy compatibility columns
- pass canonical observation fields (`content`, `insight`, `tags`) directly through `saveTurn()`

- [ ] **Step 4: Simplify standalone observations DB helpers**

In `src/db/observations.ts`:
- remove legacy observation fields from types and SQL
- simplify `mapObservationRow()` to canonical columns only
- delete `combineLegacyInsight()` and related fallback logic

- [ ] **Step 5: Simplify search queries and rebuild logic**

In `src/db/search.ts`:
- switch result types and queries from `description` to `content`
- remove `COALESCE(...)` wrappers in search and FTS rebuild paths
- keep external search behavior unchanged

- [ ] **Step 6: Add/adjust migration and round-trip tests**

Cover:
- old DBs migrate and still read correctly after dropping fallbacks
- sessions read/write `created_at_epoch`
- turns/observations round-trip with canonical fields only
- search index rebuild still works after schema cleanup

### Task 2: Remove deprecated MCP schema fields and legacy tool registrations

**Files:**
- Modify: `src/mcp/definitions.ts`
- Modify: `src/mcp/format.ts`
- Modify: `src/mcp/recall.ts`
- Modify: `src/mcp/handlers.ts`
- Modify: `src/mcp/remember.ts`
- Modify: `src/mcp/server.ts`
- Delete: `src/mcp/save-turn.ts`
- Delete: `src/mcp/update-session.ts`
- Test: `tests/mcp/recall.test.ts`
- Test: `tests/mcp/format.test.ts`
- Test: `tests/mcp/write-tools.test.ts`
- Test: `tests/mcp/remember.test.ts`

- [ ] **Step 1: Simplify MCP definitions**

In `src/mcp/definitions.ts`:
- delete `saveTurnInputShape` and `updateSessionInputShape`
- remove `save_turn` and `update_session` from tool descriptions and allowed tool lists
- rename recall input field `scope` to `view`
- add `limit`
- remove deprecated recall aliases: `observation`, `from_epoch`, `to_epoch`, `around`
- remove unused remember input fields: legacy content aliases and epoch passthrough fields

- [ ] **Step 2: Update formatter types to canonical fields**

In `src/mcp/format.ts`:
- rename formatted structures to `content` / `createdAtEpoch`
- remove `narrative`, `facts`, `concepts`
- keep rendered labels stable where possible to avoid avoidable output churn

- [ ] **Step 3: Update recall V2 internals to the simplified schema**

In `src/mcp/recall.ts`:
- rename public input `scope` to `view`
- keep view inference, but delete legacy alias mapping for removed fields
- pass `limit` through to search and recent-session selection
- preserve current defaults when `limit` is omitted:
  - search: `20`
  - memories: `200`
  - sessions: `1000`
- update formatter calls/types to canonical field names
- make sure any internal DB-search-layer `scope` concept remains separate from recall's public `view`

- [ ] **Step 4: Remove deprecated tool wiring**

In `src/mcp/handlers.ts` and `src/mcp/server.ts`:
- remove `save_turn` / `update_session` handler registration
- keep only current tool surface
- update the recall handler mapping so:
  - `scope` maps to `view`
  - `expand_turns` still maps to `expandTurns`
  - removed aliases (`observation`, `fromEpoch`, `toEpoch`, `around`) are no longer forwarded

- [ ] **Step 5: Inline old session-update logic into remember**

In `src/mcp/remember.ts`:
- remove legacy passthrough fields
- inline the remaining session update branch directly under `id: "S{id}"`
- make `remember` the only write tool entry point

- [ ] **Step 6: Delete superseded tool modules**

Delete:
- `src/mcp/save-turn.ts`
- `src/mcp/update-session.ts`

- [ ] **Step 7: Update MCP tests**

Cover:
- new `view` input contract
- removed aliases now fail validation
- `remember` remains the sole write path
- removed tools are no longer registered

### Task 3: Simplify Mnemosyne and hook integrations to the new tool contract

**Files:**
- Modify: `src/mnemosyne/fork.ts`
- Modify: `src/mnemosyne/prompt.ts`
- Modify: `src/hooks/handlers/session-init.ts`
- Modify: `src/hooks/handlers/stop.ts`
- Modify: `src/hooks/handlers/compact.ts`
- Modify: `src/hooks/handlers/context.ts`
- Test: `tests/hooks/session-init.test.ts`
- Test: `tests/mnemosyne/fork.test.ts`
- Test: `tests/mnemosyne/prompt.test.ts`
- Test: `tests/hooks/stop.test.ts`
- Test: `tests/hooks/compact.test.ts`
- Test: `tests/hooks/context.test.ts`
- Test: `tests/e2e/smoke.test.ts`

- [ ] **Step 1: Remove deprecated tool injection from Mnemosyne**

In `src/mnemosyne/fork.ts`:
- stop registering `save_turn` and `update_session`
- keep only `remember`, `recall`, `replay`
- update any allowlist assertions accordingly

- [ ] **Step 2: Rewrite Mnemosyne prompt contract**

In `src/mnemosyne/prompt.ts`:
- remove all compatibility fallback wording
- update examples and rules to use `remember` as the only write tool
- keep prompt-number guidance for turn writes

- [ ] **Step 3: Update hooks to canonical session field names**

In `src/hooks/handlers/session-init.ts`, `src/hooks/handlers/stop.ts`, and `src/hooks/handlers/compact.ts`:
- use `content`
- use `createdAtEpoch`
- rename internal `recallMemory({ scope: ... })` calls to `recallMemory({ view: ... })`

- [ ] **Step 4: Adjust context hook type usage if required**

In `src/hooks/handlers/context.ts`:
- update any `FormattedSession` field access after `startedAtEpoch` → `createdAtEpoch`
- keep behavior unchanged aside from field rename compatibility cleanup

- [ ] **Step 5: Update integration tests**

Cover:
- fork tool list shrinks from 5 to 3 tools
- prompt mentions only `remember`, `recall`, `replay`
- hooks still backfill/extract correctly under the simplified schema

### Task 4: Sweep tests and fixtures for canonical field names

**Files:**
- Modify test files under `tests/` that still reference old names

- [ ] **Step 1: Mechanical fixture renames**

Update all affected tests:
- `description` → `content`
- `startedAtEpoch` → `createdAtEpoch`
- remove observation fixture fields `narrative`, `facts`, `concepts`
- update recall calls from `scope` to `view`

This task is the cross-task mechanical sweep. Task 1-3 should keep focused tests near their own changes; Task 4 should handle broad fixture churn and cross-cutting syntax cleanup.

- [ ] **Step 2: Remove obsolete legacy-tool tests**

Delete or rewrite tests that assume:
- `save_turn`
- `update_session`
- recall aliases `observation`, `from_epoch`, `to_epoch`, `around`

- [ ] **Step 3: Add focused migration regression**

Add one explicit migration regression that:
- creates an old-schema DB
- runs `initializeDatabase()`
- verifies canonical reads succeed with no fallback code in the DB access layer

### Task 5: Rebuild artifacts and verify no legacy runtime paths remain

**Files:**
- Generated: `plugin/scripts/hook-command.cjs`
- Generated: `plugin/scripts/mcp-server.cjs`

- [ ] **Step 1: Rebuild plugin artifacts**

Run:

```bash
npm run build
```

- [ ] **Step 2: Run full verification**

Run:

```bash
~/.bun/bin/bun test tests
npm run typecheck
npm run build
claude plugins validate plugin
```

- [ ] **Step 3: Grep for unexpected remnants**

Run:

```bash
rg -n "startedAtEpoch|\\.narrative|\\.concepts|from_epoch|to_epoch|save_turn|update_session" src tests
```

Expected:
- matches only in migration code, historical docs, or explicit compatibility tests intentionally retained

---

## Notes for Execution

- Do **not** drop legacy DB columns in SQLite. This plan removes reads/writes, not physical columns.
- Migration code is the only place that should still understand old column names once implementation is done.
- Prefer landing Task 1 before Task 2 so MCP code can assume canonical DB records.
- Be careful with `scope` renaming: recall's public `view` is not the same concept as memory `scope`.
- Keep `expand_turns` support intact; it is still active behavior, not a deprecated alias.
