# Remove Durable Memory (M-layer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove mnemo's durable cross-session "memory" feature (the `memories` table / `M<n>` surface) entirely; CC native file memory owns that role.

**Architecture:** Strip the M-layer from the bottom up while keeping the build and test suite green at every commit. Order: remove *consumers* before the *definitions* they import, remove the FTS `memory` layer before dropping the table (the rebuild check runs after the migration), and delete `src/db/memories.ts` only once nothing imports it. The session/turn/observation pipeline and the `memory_fts` global search index are untouched.

**Tech Stack:** TypeScript, bun:sqlite, bun test, esbuild (`node scripts/build.js`). Source spec: `docs/plans/2026-05-30-remove-durable-memory.md`.

---

## Conventions for this plan

- **Branch first.** Repo policy forbids working on `main`. Start with `git switch -c remove-durable-memory`.
- **Deletions vs additions.** For *removals*, the step names the exact symbols/blocks to delete; the typecheck + test + `grep` gates at the end of each task prove they're gone (pasting full stale before/after blocks would drift on the first edit). For *additions* (the migration, new error paths, new test assertions), the full code is shown inline.
- **Per-task verification.** Every task ends with `bun run typecheck` + the touched test file(s) green, then a commit. Commit cadence is the repo owner's call at execution time — confirm before the first commit, or batch at the end if preferred.
- **Commands.** Per-file test: `bun test <path>`. Full suite: `bun test`. Types: `bun run typecheck`.

---

## File map

| File | Responsibility | Change |
|---|---|---|
| `src/mcp/remember.ts` | Routed write tool (O/T/S/M) | Drop M routes + no-`id` route; narrow status union |
| `src/mcp/definitions.ts` | Zod input shapes + tool descriptions | Drop memory-only fields; narrow `status` enum; fix `remember` description |
| `src/mcp/recall.ts` | Routed read tool | Drop `M*`/`M<n>` routes, `tag:` filter, local `buildMemoryView` |
| `src/mcp/format.ts` | Render-node formatting | Drop `FormattedMemory(Source)`, `"memory"` render variant, `formatMemory*` |
| `src/hooks/handlers/context.ts` | SessionStart context injection | Drop `## Memories` block + helpers |
| `src/db/search.ts` | FTS index + cross-layer search | Drop `memory` layer (index + rebuild + scope + unions) |
| `src/db/schema.ts` | Schema + migrations + rebuild gate | Drop table/indexes, fix `sourceLayers`, add drop migration |
| `src/db/memories.ts` | `memories` table accessor | **Delete file** |
| `src/worker/query-session.ts` | Mnemosyne prompt | Strip M-memory framing (`:281`/`:333`/`:339`) |
| `src/worker/processors.ts` | Worker summary prompt | Strip M-memory framing (`:441`) |
| `plugin/skills/mnemo-remember/` | Durable-memory skill | **Delete directory** |
| `plugin/skills/mnemo-recall/SKILL.md` | Recall skill docs | Drop `M*`/`M<n>`/`tag:` selectors |
| `plugin/skills/mnemo-replay/SKILL.md` | Replay skill docs | Drop `memories` schema row + tag SQL |
| `README.md` | Project readme | Drop durable-memory feature mention |
| version files + bundles | Release | Bump `0.2.17`→`0.2.18`, rebuild |

---

## Task 1: Narrow the `remember` write surface

**Files:**
- Modify: `src/mcp/remember.ts`
- Modify: `src/mcp/definitions.ts`
- Test: `tests/mcp/remember.test.ts`, `tests/mcp/write-tools.test.ts`

- [ ] **Step 1: Write the failing test** — append to `tests/mcp/write-tools.test.ts` (inside the existing `describe`):

```ts
test("remember without an id returns a parameter error (memory creation removed)", () => {
  const result = rememberTool(db, { title: "x", content: "y" });
  expect(result.content[0]?.text).toContain("Parameter error");
});

test("remember rejects the removed memory-only statuses", () => {
  // `superseded` / `archived` only ever applied to M-layer memories.
  const result = rememberTool(db, { id: "T1", status: "superseded" as never });
  expect(result.content[0]?.text).toContain("Parameter error");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/mcp/write-tools.test.ts`
Expected: FAIL — the no-`id` call currently returns "Created memory M…", and `superseded` is still an accepted enum value.

- [ ] **Step 3: Edit `src/mcp/definitions.ts`**
  - In `rememberInputShape`: delete the `scope`, `reasoning`, `application`, and `source` fields.
  - Narrow the `status` enum to exactly `["pending", "extracted", "skipped", "undone", "active"]`.
  - Change the `remember` description (`definitions.ts:6`) from `"… or memories …"` to: `"Persist sessions, turns, or observations through one routed write tool."`

- [ ] **Step 4: Edit `src/mcp/remember.ts`**
  - Delete the import of `createMemory, updateMemory` from `../db/memories`.
  - Delete `handleMemoryCreate`, `handleMemoryUpdate`, `parseMemoryId`, `parseTurnSource`, and the `MEMORY_REMEMBER_STATUSES` constant.
  - Narrow the `RememberStatus` type union to `"pending" | "extracted" | "skipped" | "undone" | "active"`.
  - Remove `scope`, `reasoning`, `application`, `source` from the `RememberToolInput` interface (keep `type`, `tags`, `insight`, `status`, and the session-summary fields).
  - In `handleObservationRemember`, delete the `input.scope`/`input.reasoning`/`input.application`/`input.source` clauses from the rejection guard.
  - In `rememberTool`, replace the no-`id` branch and the trailing `parseMemoryId` branch with a parameter error:

```ts
export function rememberTool(
  db: Database,
  input: RememberToolInput,
): ToolTextResult {
  if (!input.id) {
    return parameterError(
      "id is required: O<n> (observation), T<n> (turn), or S<n> (session). Durable memory creation was removed.",
    );
  }

  const observationId = parseObservationId(input.id);
  if (observationId !== null) {
    return handleObservationRemember(db, observationId, input);
  }

  const turnId = parseTurnId(input.id);
  if (turnId !== null) {
    return handleTurnRemember(db, turnId, input);
  }

  const sessionId = parseSessionId(input.id);
  if (sessionId !== null) {
    return handleSessionRemember(db, sessionId, input);
  }

  return textResult(`Unsupported id selector: ${input.id}`);
}
```

- [ ] **Step 5: Scrub `tests/mcp/write-tools.test.ts`**
  - Delete the `getMemory, listMemories` import from `../../src/db/memories`.
  - Delete the `"rememberTool creates and updates memories"` test (superseded by Step 1's no-`id` test).

- [ ] **Step 6: Scrub `tests/mcp/remember.test.ts`**
  - Delete the `getMemory, listMemories` import from `../../src/db/memories`.
  - Delete any memory-creation / `M<n>` update / `recallMemory(M…)` cases.
  - **Keep** the `searchMemory` import and the `memory_fts WHERE layer='turn'` / `layer='observation'` assertions (`:185`, `:192`) — that is the global index, unaffected. If `searchMemory` becomes unused after the scrub, drop its import too.

- [ ] **Step 7: Run tests + typecheck**

Run: `bun test tests/mcp/write-tools.test.ts tests/mcp/remember.test.ts && bun run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 8: Commit**

```bash
git add src/mcp/remember.ts src/mcp/definitions.ts tests/mcp/write-tools.test.ts tests/mcp/remember.test.ts
git commit -m "refactor(mcp): drop remember M-routes, memory-only fields, and statuses"
```

---

## Task 2: Remove the `recall` read path for memories

**Files:**
- Modify: `src/mcp/recall.ts`
- Test: `tests/mcp/recall.test.ts`, `tests/mcp/handlers.test.ts`

- [ ] **Step 1: Write the failing test** — append to `tests/mcp/recall.test.ts` (inside the `describe`):

```ts
test("recall rejects a tag: filter (removed with durable memory)", () => {
  expect(recallMemory(db, { query: "tag:feedback" })).toContain("Parameter error");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/mcp/recall.test.ts`
Expected: FAIL — `tag:` is currently parsed as a memory filter and returns results, not an error.

- [ ] **Step 3: Edit `src/mcp/recall.ts`**
  - Delete the `getMemory` import (from `../db/memories`) and the `FormattedMemory` import (from `./format`). Keep `searchMemory` / `SearchMemoryResult`.
  - Delete the `{ kind: "memories"; … }` and `{ kind: "memory"; … }` members of `RoutedRecallId`.
  - Delete the `memoryListMatch` (`M*`/`M1..n`) and `memoryMatch` (`M<n>`) branches in the selector parser (`:237`–`:254`).
  - Delete the local `buildMemoryView` function (`:482`+) and any `case "memory"` routing that dispatches to it.
  - Remove `tag` from the `QueryFilters` interface (`:46`) and delete the `token.startsWith("tag:")` branch in `parseQueryFilters` (`:296`).
  - At the top of `recallMemory`, before parsing, reject a `tag:` prefix:

```ts
if (input.query && /(^|\s)tag:/.test(input.query)) {
  return formatParameterError(
    "tag: filtering was removed with durable memory; use type:/file:/project: or free-text search.",
  );
}
```

- [ ] **Step 4: Scrub `tests/mcp/recall.test.ts`**
  - Delete the `createMemory` import from `../../src/db/memories`.
  - Delete the `globalMemoryId` / `projectMemoryId` fields and their `createMemory(...)` setup.
  - Delete any `recallMemory(db, { id: "M…" })` / `query: "tag:…"`-returns-results cases. Keep all session/turn/observation recall coverage.

- [ ] **Step 5: Scrub `tests/mcp/handlers.test.ts`**
  - Delete the `createMemory` import from `../../src/db/memories` and the two `createMemory(...)` seeds + any assertion that the handler surfaces a memory.

- [ ] **Step 6: Run tests + typecheck**

Run: `bun test tests/mcp/recall.test.ts tests/mcp/handlers.test.ts && bun run typecheck`
Expected: PASS. (`format.ts` still exports `FormattedMemory`, now used only by `context.ts` — build stays green.)

- [ ] **Step 7: Commit**

```bash
git add src/mcp/recall.ts tests/mcp/recall.test.ts tests/mcp/handlers.test.ts
git commit -m "refactor(mcp): drop recall M-selectors and tag: filter"
```

---

## Task 3: Remove the `## Memories` context injection

**Files:**
- Modify: `src/hooks/handlers/context.ts`
- Test: `tests/hooks/context.test.ts`

- [ ] **Step 1: Edit `src/hooks/handlers/context.ts`**
  - Delete the `listMemories, type MemoryRecord` import (from `../../db/memories`) and the `FormattedMemory` import (from the format module).
  - Delete `buildMemoryView` (`:258`), `mergeMemoryLists` (`:275`), and `buildMemoriesOutput` (`:304`).
  - Delete the call site that appends the `## Memories` section to the assembled context, so SessionStart output no longer contains it.

- [ ] **Step 2: Scrub `tests/hooks/context.test.ts`**
  - Delete the `createMemory` import from `../../src/db/memories`.
  - Delete the `createMemory(...)` seeds (`:180`, `:196`, `:212`) and any assertion that a `## Memories` block / project-scoped memory appears in the context.

- [ ] **Step 3: Run tests + typecheck**

Run: `bun test tests/hooks/context.test.ts && bun run typecheck`
Expected: PASS. (`FormattedMemory` is now referenced only inside `format.ts`.)

- [ ] **Step 4: Commit**

```bash
git add src/hooks/handlers/context.ts tests/hooks/context.test.ts
git commit -m "refactor(hooks): drop the ## Memories context injection"
```

---

## Task 4: Remove memory rendering from `format.ts`

**Files:**
- Modify: `src/mcp/format.ts`
- Test: `tests/mcp/format.test.ts`

- [ ] **Step 1: Edit `src/mcp/format.ts`**
  - Delete the `FormattedMemorySource` (`:27`) and `FormattedMemory` (`:41`) interfaces.
  - Delete the `{ type: "memory"; value: FormattedMemory }` member of the `RenderNode` union (`:129`).
  - Delete the `case "memory":` branch in `renderNode` (`:915`).
  - Delete `formatMemoryLabel`, `formatMemoryCollapsedWithMode`, `formatMemoryExpandedWithMode`, and the exported `formatMemoryCollapsed` / `formatMemoryExpanded`.

- [ ] **Step 2: Scrub `tests/mcp/format.test.ts`**
  - Delete the `type FormattedMemory`, `formatMemoryCollapsed`, `formatMemoryExpanded` imports.
  - Delete the `"formats memory collapsed and expanded views with source counts"` test (`:352`).

- [ ] **Step 3: Run tests + typecheck**

Run: `bun test tests/mcp/format.test.ts && bun run typecheck`
Expected: PASS. No remaining references to `FormattedMemory` outside deleted code.

- [ ] **Step 4: Verify the symbol is gone**

Run: `grep -rn "FormattedMemory\|formatMemory" src/ || echo "clean"`
Expected: `clean`.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/format.ts tests/mcp/format.test.ts
git commit -m "refactor(mcp): drop FormattedMemory render node and formatters"
```

---

## Task 5: Remove the `memory` FTS layer from `search.ts`

**Files:**
- Modify: `src/db/search.ts`
- Test: `tests/db/search.test.ts`, `tests/db/search-query.test.ts`

- [ ] **Step 1: Edit `src/db/search.ts`**
  - Delete `indexMemoryToFTS` (`:285`) and the `MemoryFtsRecord` interface (`:28`).
  - Delete the `memories` rebuild block in the index rebuild (`:390`–`:418`) — the `SELECT … FROM memories` loop and its `indexMemoryToFTS` calls.
  - Remove `"memory"` from every `layer` union (`:49`, `:65`, `:206`, and the `mapSearchRow` result type) and `"memories"` from the `SearchMemoryOptions.scope` union (`:38`) plus its scope clause handling.
  - Keep `searchMemory`, `memory_fts`, and the session/turn/observation indexing intact.

- [ ] **Step 2: Scrub the search tests**
  - In `tests/db/search.test.ts` and `tests/db/search-query.test.ts`: delete any `createMemory` import/seed, `scope: "memories"` searches, and assertions on `layer: "memory"` results. Keep session/turn/observation FTS coverage.

- [ ] **Step 3: Run tests + typecheck**

Run: `bun test tests/db/search.test.ts tests/db/search-query.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/db/search.ts tests/db/search.test.ts tests/db/search-query.test.ts
git commit -m "refactor(db): drop the memory FTS layer (keep memory_fts global index)"
```

---

## Task 6: Drop the table, fix the rebuild gate, add the migration

**Files:**
- Modify: `src/db/schema.ts`
- Test: `tests/db/schema.test.ts`

- [ ] **Step 1: Write the failing migration test** — append to `tests/db/schema.test.ts`:

```ts
test("initializeSchema drops a legacy memories table and purges its FTS layer", () => {
  const db = createDatabase(":memory:");
  db.exec(
    `CREATE TABLE memories (id INTEGER PRIMARY KEY, type TEXT, scope TEXT,
       title TEXT, content TEXT, created_at_epoch INTEGER NOT NULL);`,
  );
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(layer, source_id, title, content, extra);`,
  );
  db.exec(
    `INSERT INTO memory_fts (layer, source_id, title, content, extra)
       VALUES ('memory', 1, 't', 'c', ''), ('turn', 9, 't', 'c', '');`,
  );

  initializeSchema(db);

  const table = db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='memories'")
    .get();
  expect(table).toBeNull();

  const memRows = db
    .query<{ n: number }, []>("SELECT count(*) AS n FROM memory_fts WHERE layer='memory'")
    .get()!;
  expect(memRows.n).toBe(0);

  const turnRows = db
    .query<{ n: number }, []>("SELECT count(*) AS n FROM memory_fts WHERE layer='turn'")
    .get()!;
  expect(turnRows.n).toBe(1);

  db.close();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/db/schema.test.ts`
Expected: FAIL — `initializeSchema` does not yet drop the table; the `memories` table survives.

- [ ] **Step 3: Edit `src/db/schema.ts` — schema + rebuild gate**
  - In `SCHEMA_SQL`: delete the `CREATE TABLE IF NOT EXISTS memories (...)` block and the three `CREATE INDEX … idx_memories_{scope,type,status}` statements.
  - In `shouldRebuildSearchIndex`, delete the `{ table: "memories", layer: "memory" }` entry from `sourceLayers` (`:236`). *(Required: `shouldRebuildSearchIndex` runs after the migration in `initializeDatabase` — leaving the entry makes `SELECT 1 FROM memories` throw `no such table`.)*

- [ ] **Step 4: Edit `src/db/schema.ts` — add the migration**
  - Add the function (next to the other `ensure*` migrations):

```ts
function dropLegacyMemoriesTable(db: Database): void {
  db.exec("DROP TABLE IF EXISTS memories");
  db.exec("DELETE FROM memory_fts WHERE layer = 'memory'");
}
```

  - Call it at the end of `initializeSchema`, after the existing `ensure*` calls:

```ts
export function initializeSchema(db: Database): void {
  db.exec(SCHEMA_SQL);
  ensureSessionLastAgentSessionIdColumn(db);
  ensureSessionSummaryUpdatedAtEpochColumn(db);
  ensureSessionSummaryFieldColumns(db);
  ensureTurnTranscriptLineStartColumn(db);
  ensureTurnInvalidationColumns(db);
  ensureSessionProjectIndex(db);
  ensureTurnPromptIdIndex(db);
  dropLegacyMemoriesTable(db);
}
```

  - `resetSchema`'s `DROP TABLE IF EXISTS memories` (`:303`) may stay (harmless legacy reset).

- [ ] **Step 5: Scrub `tests/db/schema.test.ts`**
  - Delete any assertion that the `memories` table or `idx_memories_*` indexes exist after init.

- [ ] **Step 6: Run tests + typecheck**

Run: `bun test tests/db/schema.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.ts tests/db/schema.test.ts
git commit -m "feat(db): drop memories table + guarded migration; fix rebuild gate"
```

---

## Task 7: Delete `memories.ts` and remaining test refs

**Files:**
- Delete: `src/db/memories.ts`
- Delete: `tests/db/memories.test.ts`
- Test: `tests/e2e/smoke.test.ts`

- [ ] **Step 1: Confirm there are no importers left**

Run: `grep -rn "db/memories" src/ tests/`
Expected: no matches (all importers removed in Tasks 1–6). If any remain, remove them before deleting.

- [ ] **Step 2: Delete the files**

```bash
git rm src/db/memories.ts tests/db/memories.test.ts
```

- [ ] **Step 3: Scrub `tests/e2e/smoke.test.ts`**
  - Remove any memory-create / `M<n>` recall steps from the end-to-end flow; keep the session/turn/observation path.

- [ ] **Step 4: Run the full suite + typecheck**

Run: `bun test && bun run typecheck`
Expected: PASS across all files.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/smoke.test.ts
git commit -m "refactor(db): delete the memories accessor and its tests"
```

---

## Task 8: Strip M-memory framing from worker prompts

**Files:**
- Modify: `src/worker/query-session.ts`
- Modify: `src/worker/processors.ts`

These are runtime prompt strings for the Mnemosyne worker — no unit test asserts their text, so the typecheck gate confirms the edits still compile.

- [ ] **Step 1: Edit `src/worker/query-session.ts`**
  - `:281` — delete `"Never create memories."` from the "Never update other turns … Never update observations …" line (the no-`id` route already errors; nothing to forbid).
  - `:333` — reword `"Do not record durable cross-project lessons here; those are the main agent's M-level memories."` to `"Do not record durable cross-project lessons here — keep summaries scoped to this session's work."`
  - `:339` — replace the `"- Never call \`remember()\` without an \`id\` field — that creates an M-level memory …"` bullet with `"- Always call \`remember()\` with an \`id\` (T<n> / S<n>); the no-id route is rejected."`

- [ ] **Step 2: Edit `src/worker/processors.ts`**
  - `:441` — reword `"Do NOT record durable cross-project lessons here — those are the main agent's M-level memories."` to `"Do NOT record durable cross-project lessons here — keep summaries scoped to this session's work."`

- [ ] **Step 3: Verify no M-layer framing remains**

Run: `grep -rniE "m-level|\bmemories\b" src/worker || echo "clean"`
Expected: `clean` (incidental `memory` / `memory_fts` / `in-memory` are fine; no `memories` or `M-level` should remain).

- [ ] **Step 4: Typecheck + commit**

```bash
bun run typecheck
git add src/worker/query-session.ts src/worker/processors.ts
git commit -m "refactor(worker): strip M-memory framing from Mnemosyne prompts"
```

---

## Task 9: Update skills, docs, and README

**Files:**
- Delete: `plugin/skills/mnemo-remember/`
- Modify: `plugin/skills/mnemo-recall/SKILL.md`, `plugin/skills/mnemo-replay/SKILL.md`, `README.md`

- [ ] **Step 1: Delete the remember skill**

```bash
git rm -r plugin/skills/mnemo-remember
```

- [ ] **Step 2: Edit `plugin/skills/mnemo-recall/SKILL.md`**
  - Remove `M*` / `M<n>` / `M1..20` rows from the data model and selector grammar tables.
  - Remove the `tag:` row from the query-filters table and any `recall(query="tag:…")` examples.
  - Remove the `Memory [M4]` line from the data-model diagram.

- [ ] **Step 3: Edit `plugin/skills/mnemo-replay/SKILL.md`**
  - Remove the `memories` row from the schema table (`:109`).
  - Remove the `**Recent active memories by tag**` SQL example (`:149`).

- [ ] **Step 4: Edit `README.md`**
  - Remove durable cross-session memory from the feature list / description; leave the recall/timeline/replay description intact.

- [ ] **Step 5: Verify no skill teaches the dropped surface**

Run: `grep -ri "memories" plugin/skills || echo "clean"`
Expected: `clean`.

- [ ] **Step 6: Commit**

```bash
git add plugin/skills README.md
git commit -m "docs: drop durable-memory skill, selectors, and README mention"
```

---

## Task 10: Version bump and bundle rebuild

**Files:**
- Modify: `package.json`, `plugin/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`
- Rebuild: `plugin/scripts/{worker,mcp-server,hook-command}.cjs`

- [ ] **Step 1: Bump version `0.2.17` → `0.2.18`** in `package.json`, `plugin/.claude-plugin/plugin.json`, and both version fields in `.claude-plugin/marketplace.json`.

- [ ] **Step 2: Drop `mnemo-remember` from any plugin skill listing**
  - If `plugin/.claude-plugin/plugin.json` (or the marketplace manifest) enumerates skills, remove the `mnemo-remember` entry. If skills are auto-discovered, skip.

- [ ] **Step 3: Rebuild bundles**

Run: `node scripts/build.js`
Expected: refreshed `plugin/scripts/*.cjs` with a new `BUILD_ID` (`0.2.18-…`).

- [ ] **Step 4: Final full verification**

Run: `bun test && bun run typecheck && grep -rn "db/memories" src/ tests/ || echo "no memories module refs"`
Expected: all tests pass, no type errors, no `db/memories` imports.

- [ ] **Step 5: Commit**

```bash
git add package.json plugin/.claude-plugin/plugin.json .claude-plugin/marketplace.json plugin/scripts
git commit -m "chore: remove durable memory, bump 0.2.18"
```

---

## Acceptance gate (run after Task 10)

- [ ] No `memories` table in a fresh DB; existing DBs drop it on next `initializeSchema`.
- [ ] `recall` no longer resolves `M*` / `M<n>`; a `tag:` prefix returns a parameter error (not a silent FTS search).
- [ ] SessionStart context has no `## Memories` section.
- [ ] `remember` with no `id` errors; `O` / `T` / `S` routes unchanged.
- [ ] `grep -ri "memories\b" src/` → only `memory_fts` + the migration/reset SQL (`DROP TABLE IF EXISTS memories`) + incidental prose.
- [ ] `grep -ri "memories" plugin/skills` → nothing.
- [ ] `bun test` and `bun run typecheck` both clean.
