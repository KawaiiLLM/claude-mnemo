# Remove durable memory (M-layer)

- **Date**: 2026-05-30
- **Status**: Approved design — ready for implementation plan
- **Scope**: Delete mnemo's durable cross-session "memory" feature; CC native file memory owns that role.

## Motivation

mnemo shipped a durable-memory feature (`memories` table, surfaced as `M<n>`) before
Claude Code had native file-based memory. Now that CC ships per-project file memory
(`memory/MEMORY.md` + typed `.md` files, loaded into context every session), the two
overlap almost completely — both store durable cross-session facts under the same
taxonomy (feedback / decision / project / reference).

The overlap is not just conceptual; the mnemo side is **dead weight**:

- Across **59 sessions / 16,408 observations**, the `memories` table holds **1 row**.
- That single row is scoped to a *different* project (`KawaiiLLM`) — claude-mnemo itself has **0**.
- Meanwhile CC's `MEMORY.md` is actively maintained (7+ live entries).

Durable knowledge already migrated to CC native memory by usage. mnemo's irreplaceable
value is the part CC memory does **not** do: automatic session / turn / observation
capture plus the `recall` / `timeline` / `mnemo-replay` read axes. Removing the M-layer
sharpens that separation of concerns and deletes an unused, parallel storage system.

## Goals

- Remove durable-memory storage, write paths, read paths, and context injection.
- Keep the session / turn / observation pipeline and the three read axes untouched.
- Keep the global FTS index (`memory_fts`) — it serves sessions/turns/observations and
  is unrelated to the `memories` data table despite the shared name.
- Converge existing installs via a guarded migration (drop the table, purge its FTS layer).

## Non-goals

- **Not** migrating the 1 existing record into CC file memory — discarded with the table.
- **Not** touching the session/turn/observation extraction pipeline.
- **Not** rewriting historical specs under `docs/plans/`.
- **Not** un-exposing the `remember` MCP tool from the main agent (see Decision 1).

## Decisions

1. **Keep `remember` exposed to the main agent.** The worker (Mnemosyne) still needs the
   tool to write turn (`T`) and session (`S`) records, and it shares the MCP surface. The
   tool stays; only its memory routes are removed. The main-agent-facing `mnemo-remember`
   skill is deleted, so nothing prompts the main agent to call it. *Un-exposing `remember`
   from the main agent is a possible later cleanup, gated on confirming the worker's tool
   channel; out of scope here.*
2. **Remove the `tag:` query filter.** It is a memory-only post-filter (`recall` skill:
   "memories only"). With memories gone it has no target, so it is removed from `recall`.
3. **Fully remove `"memory"` from the `layer` type unions** in `search.ts` rather than
   leaving a vestigial member — matches the "complete removal" intent.
4. **Spec lives at `docs/plans/`** (repo convention), not the brainstorming default
   `docs/superpowers/specs/`.

## Removal surface

| File | Change |
|---|---|
| `src/db/memories.ts` | Delete entire file (the `memories` table accessor). |
| `src/db/schema.ts` | Drop `CREATE TABLE memories` + `idx_memories_{scope,type,status}` from `SCHEMA_SQL`. Remove the `{ table: "memories", layer: "memory" }` entry from `shouldRebuildSearchIndex`'s `sourceLayers` (`:232`) — otherwise its `SELECT 1 FROM memories` throws `no such table` right after the migration drops it. Add a guarded `ensure*`-style migration in `initializeSchema`: `DROP TABLE IF EXISTS memories` + `DELETE FROM memory_fts WHERE layer='memory'`. **Keep** the `memory_fts` virtual table; `resetSchema`'s existing legacy drop (`:303`) may stay (harmless `IF EXISTS`). |
| `src/db/search.ts` | Remove `indexMemoryToFTS`, the `memories` rebuild loop, the `searchMemory` `"memories"` scope, and `"memory"` from every `layer` union. `searchMemory` itself stays (global FTS). |
| `src/mcp/remember.ts` | Remove `handleMemoryCreate`, `handleMemoryUpdate`, `parseMemoryId`, `MEMORY_REMEMBER_STATUSES`, and the memory-only input fields (`scope`, `reasoning`, `application`, `source`). Narrow the `RememberStatus` union to `pending \| extracted \| skipped \| undone \| active` (drop the memory-only `superseded` / `archived`). No-`id` now returns a parameter error (was: create memory). Keep `type`, `tags`, `insight`, `status`, and the session-summary fields. Update `handleObservationRemember`'s rejection guard to drop references to removed fields. |
| `src/mcp/recall.ts` | Remove the `M*` / `M<n>` selector routes, the `tag:` query filter, the local `buildMemoryView`, and the `getMemory` / `FormattedMemory` imports. A `tag:` prefix in `query` now returns a parameter error — **not** a silent fallback to plain FTS text. `searchMemory` stays for cross-layer FTS. |
| `src/mcp/format.ts` | Remove the `FormattedMemory` / `FormattedMemorySource` interfaces (defined here), the `{ type: "memory"; value: FormattedMemory }` `RenderNode` variant and its `renderNode` `case "memory"`, and the `formatMemoryLabel` / `formatMemoryCollapsed(WithMode)` / `formatMemoryExpanded(WithMode)` exports. |
| `src/mcp/definitions.ts` | `remember` description: drop "or memories". Trim `rememberInputShape` to drop the memory-only fields (`scope`, `reasoning`, `application`, `source`) and narrow the `status` enum to `pending`, `extracted`, `skipped`, `undone`, `active`. |
| `src/hooks/handlers/context.ts` | Remove `buildMemoriesOutput`, `buildMemoryView`, `mergeMemoryLists`, the `listMemories` import, and the `## Memories` injection block. |
| `src/worker/query-session.ts` | Strip the M-memory framing from the Mnemosyne prompt at `:281` ("Never create memories"), `:333`, and `:339` ("the main agent's M-level memories" / the no-`id` guard). Keep the substantive "don't put durable cross-project lessons in session summaries" guidance, reworded without referencing the removed M-layer. |
| `src/worker/processors.ts` | Same M-memory framing at `:441` ("those are the main agent's M-level memories") — reword to drop the M-layer reference. |
| `plugin/skills/mnemo-remember/` | Delete the skill (100% durable-memory). |
| `plugin/skills/mnemo-recall/SKILL.md` | Remove `M*` / `M<n>` / `tag:` selectors and memory examples from the data model and selector grammar. |
| `plugin/skills/mnemo-replay/SKILL.md` | Remove the `memories` row from the schema table (`:109`) and the "Recent active memories by tag" SQL example (`:149`). |
| `README.md` | Remove durable memory from the feature description. |

## Migration

Existing installs run `initializeSchema` on every worker start. Add an idempotent,
guarded step (alongside the existing `ensure*` migrations):

```sql
DROP TABLE IF EXISTS memories;
DELETE FROM memory_fts WHERE layer = 'memory';
```

The 1 existing `KawaiiLLM`-scoped row is discarded (per Non-goals). `memory_fts` is
otherwise preserved, so session/turn/observation search is unaffected.

**Ordering hazard.** `initializeDatabase` calls `shouldRebuildSearchIndex` *after*
`initializeSchema` (which now runs the drop). The `memories` entry must be removed from
`sourceLayers` in the same change, or the post-migration rebuild check immediately throws
`no such table: memories`.

## Test strategy

- Delete `tests/db/memories.test.ts`.
- Scrub memory assertions from `tests/db/{search,search-query,schema}.test.ts` and
  `tests/e2e/smoke.test.ts` (table existence, `layer:"memory"` results, `M*` recall).
- Scrub the MCP / hook tests that import memory symbols:
  - `tests/mcp/format.test.ts` — drop the `FormattedMemory` import and the
    "formats memory collapsed and expanded" test.
  - `tests/mcp/handlers.test.ts` and `tests/hooks/context.test.ts` — drop the
    `createMemory` setup and the memory-injection / project-scope assertions.
  - `tests/mcp/recall.test.ts` — remove memory-creation and `M*` / `M<n>` recall
    cases; keep the non-memory recall coverage; add an assertion that
    `recall(query="tag:x")` returns a parameter error.
  - `tests/mcp/remember.test.ts` — remove the `getMemory` / `listMemories` /
    `searchMemory` memory cases, but **keep** the `memory_fts` checks for
    `layer='turn'` / `layer='observation'` (global index, unaffected).
  - `tests/mcp/write-tools.test.ts` — remove "rememberTool creates and updates
    memories"; it is superseded by the no-`id` error test below.
- Add a migration test: given a DB with a populated `memories` table + `memory_fts`
  `memory` rows, after `initializeSchema` the table is gone and no `memory` layer rows
  remain, while session/turn/observation FTS rows survive.
- Add a `remember` test: a no-`id` call returns a parameter error (not a created memory).
- Full suite must stay green.

## Acceptance criteria

- No `memories` table in a freshly initialized DB; existing DBs drop it on next start.
- `recall` no longer resolves `M*` / `M<n>` selectors, and a `tag:` prefix in `query` returns a parameter error (not a silent FTS-text search).
- SessionStart context contains no `## Memories` section.
- `remember` with no `id` errors; `O` / `T` / `S` routes unchanged.
- `grep -ri "memories\b"` over `src/` returns only `memory_fts` (the global index), the
  guarded migration / legacy-reset SQL (`DROP TABLE IF EXISTS memories`), and incidental prose.
- `grep -ri "memories" plugin/skills` returns nothing — no skill teaches the dropped table or `M`-layer selectors.
- All tests pass.

## Rollout

- Version bump (`0.2.17` → `0.2.18`) across `package.json`, `plugin/.claude-plugin/plugin.json`,
  and `.claude-plugin/marketplace.json` (×2).
- Rebuild bundles (`node scripts/build.js`) → refresh `plugin/scripts/*.cjs`.
- If `plugin/.claude-plugin/plugin.json` enumerates skills, remove `mnemo-remember` there too.
