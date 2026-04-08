# Schema Simplification Design

## Goal

Strip all legacy compatibility layers from the MCP schema, DB layer, and extraction agent. Remove dual-write columns, deprecated tool aliases, and superseded tools to produce a clean, minimal interface.

## Problem

Field renames introduced during v10–v11 left every layer carrying compatibility baggage:

| Layer | Baggage |
|-------|---------|
| DB writes | Every INSERT dual-writes old+new columns (`description`+`content`, `narrative`+`insight`, `concepts`+`tags`) |
| DB reads | Every SELECT uses `COALESCE(content, description)` fallback chains |
| DB schema | `sessions.started_at_epoch` vs `created_at_epoch` on all other tables |
| MCP recall | Legacy aliases: `observation`, `from_epoch`, `to_epoch`, `around` |
| MCP recall | `scope` conflicts with `remember.scope` (different semantics) |
| MCP recall | No `limit` parameter (hardcoded: search=20, memories=200, sessions=1000) |
| MCP remember | Exposes `description`, `user_prompt`, `assistant_response`, epoch fields that agents never need to fill |
| MCP tools | `save_turn` and `update_session` fully superseded by `remember` but still registered |
| Observations | Dead field `facts`, dead fallback functions `combineLegacyInsight()`, `resolveObservationTags()`, `resolveObservationInsight()` |

## Constraints

- **Don't drop DB columns.** SQLite `ALTER TABLE DROP COLUMN` is fragile. Old columns stay in the table but are no longer read or written.
- **Keep migration code.** Old databases still need `description→content`, `narrative→insight`, `concepts→tags` data migration on upgrade.
- **Migration runs before reads.** `initializeDatabase()` calls `migrateSchema()` before any SELECT, so COALESCE fallbacks are safe to remove.
- **`expand_turns` is active.** It controls turn expansion in session views — keep it.

## Changes

### 1. DB Layer — Stop Dual-Writing

#### `src/db/schema.ts`

- SCHEMA_SQL: rename `started_at_epoch` → `created_at_epoch` in sessions table definition, update index name to `idx_sessions_project_created_at`
- New migration step:

```ts
if (hasColumn(db, "sessions", "started_at_epoch") && !hasColumn(db, "sessions", "created_at_epoch")) {
  db.exec("ALTER TABLE sessions RENAME COLUMN started_at_epoch TO created_at_epoch");
  db.exec("DROP INDEX IF EXISTS idx_sessions_project_started_at");
}
```

- Keep existing `content`/`insight`/`tags` migration for old databases

#### `src/db/sessions.ts`

- `SessionRecord`: remove `description`, rename `startedAtEpoch` → `createdAtEpoch`
- `UpsertSessionInput`: same
- Delete `resolveSessionContent()`
- SELECT: `content` directly (drop COALESCE, drop description alias)
- INSERT/UPDATE: stop writing `description`, use `created_at_epoch`

#### `src/db/turns.ts`

- `SaveTurnInput`: remove `description`
- `TurnRecord`: remove `description`
- `ObservationInput`: remove `description`, `narrative`, `facts`, `concepts`
- Delete `resolveTurnContent()`, `resolveObservationContent()`, `resolveObservationTags()`, `resolveObservationInsight()`
- SELECT: drop COALESCE, drop description alias
- INSERT/UPDATE: stop writing `description`
- Observation loop in `saveTurn()`: pass `content`, `insight`, `tags` directly

#### `src/db/observations.ts`

- `CreateObservationInput`: remove `description`, `narrative`, `facts`, `concepts`
- `ObservationRecord`: same
- Delete `combineLegacyInsight()`
- Simplify `mapObservationRow()`: no cross-field resolution
- SELECT: drop COALESCE, stop selecting `narrative`/`facts`/`concepts`
- INSERT: only write `content`, `insight`, `tags`

#### `src/db/search.ts`

- `SearchMemoryResult` / `SearchRow`: `description` → `content`
- All queries: `s.content`/`t.content`/`o.content` replacing `s.description`/`t.description`/`o.description`
- `rebuildSearchIndex()`: drop COALESCE wrappers

### 2. MCP Schema — Remove Legacy Fields and Tools

#### `src/mcp/definitions.ts`

- Delete `saveTurnInputShape`, `updateSessionInputShape` and their Zod schemas
- Delete `save_turn`, `update_session` from `MNEMO_TOOL_DESCRIPTIONS`
- `MNEMO_ALLOWED_TOOLS`: remove `mcp__mnemo__save_turn`, `mcp__mnemo__update_session`
- `recallInputShape`:
  - Remove: `observation`, `from_epoch`, `to_epoch`, `around`
  - Rename: `scope` → `view`
  - Add: `limit: z.number().int().positive().optional()`
- `rememberInputShape`:
  - Remove: `description`, `user_prompt`, `assistant_response`, `created_at_epoch`, `updated_at_epoch`, `completed_at_epoch`, `expires_at_epoch`

#### `src/mcp/recall.ts`

- `RecallInput` interface: `scope` → `view`, remove `observation`/`fromEpoch`/`toEpoch`/`around`, add `limit`
- `normalizeRecallInput()`: delete legacy alias mapping, keep only scope inference (renamed to view inference)
- Remove `around` handling from `legacyRecallMemory()`
- Pass `limit` through to `searchMemory()` and `getRecentSessions()` calls
- Rename all `input.scope` → `input.view` (map to `scope` at `searchMemory()` call boundary since the DB search layer uses `scope` for its own concept)
- Update Formatted* type usage: `description` → `content`, `startedAtEpoch` → `createdAtEpoch`

#### `src/mcp/format.ts`

- `FormattedObservation`: remove `description`, `narrative`, `facts`, `concepts`; add `content`, `insight`, `tags`
- `FormattedTurn`: `description` → `content`
- `FormattedSession`: `description` → `content`, `startedAtEpoch` → `createdAtEpoch`
- Rendering functions: source from new field names, keep display labels (e.g. `desc:`) unchanged to minimize output churn

#### `src/mcp/handlers.ts`

- `MnemoToolHandlers`: remove `save_turn`, `update_session`
- `createDatabaseBackedHandlers()`: remove their wiring
- Recall handler: drop `observation`/`fromEpoch`/`toEpoch`/`around` mappings, `scope` → `view`

#### `src/mcp/remember.ts`

- `RememberToolInput`: remove `description`, `user_prompt`, `assistant_response`, all epoch fields
- Delete `resolveContent()` — use `input.content` directly
- Inline `updateSessionTool()` logic into the `id: "S{id}"` branch (get session → upsert with merged fields)
- `handleTurnRemember()`: remove `userPrompt`, `assistantResponse`, epoch passthrough
- `handleObservationRemember()`: remove legacy field passthrough

#### Delete `src/mcp/save-turn.ts`

#### Delete `src/mcp/update-session.ts`

After inlining session-update logic into `remember.ts`.

#### `src/mcp/server.ts`

- Remove `save_turn` and `update_session` tool registrations and imports

### 3. Mnemosyne + Hooks

#### `src/mnemosyne/fork.ts`

- `createMnemoSdkServer()`: remove `save_turn` and `update_session` tool registrations (2 fewer tools in the array)
- Remove imports of `saveTurnInputShape`, `updateSessionInputShape`

#### `src/mnemosyne/prompt.ts`

- Remove all `save_turn`/`update_session` references and "compatibility fallback" language
- Tool list: `"Only use: remember, recall, replay"`

#### `src/hooks/handlers/session-init.ts`

- `startedAtEpoch` → `createdAtEpoch`, `description` → `content`

#### `src/hooks/handlers/stop.ts`

- Same renames in `upsertSession()` call

#### `src/hooks/handlers/context.ts`

- Update `FormattedSession` field access if needed

### 4. Tests

All test files using legacy names need mechanical updates:

| Change | Affected tests |
|--------|----------------|
| `upsertSession({ description })` → `content` | sessions, turns, search, hooks, recall, format, write-tools, remember, e2e |
| `startedAtEpoch` → `createdAtEpoch` | sessions, hooks, format, recall, context |
| Observation inputs: remove `narrative`/`facts`/`concepts` | turns, observations, search, recall, format, write-tools, remember |
| Remove save_turn/update_session tests | write-tools, fork, prompt, e2e |
| `scope` → `view` in recall calls | recall |
| Remove `observation`/`fromEpoch`/`toEpoch`/`around` tests | recall |
| FormattedObservation/Session/Turn fixture updates | format, recall, context |
| Fork tool list: 3 tools not 5 | fork |

### 5. Build

- `npm run build` to rebuild plugin artifacts (`.cjs` files)

## Execution Order

```
Phase 1: DB layer
  schema.ts (migration) → sessions.ts → turns.ts → observations.ts → search.ts

Phase 2: MCP schema + tools
  definitions.ts → format.ts → recall.ts → handlers.ts → remember.ts → server.ts → delete save-turn.ts/update-session.ts

Phase 3: Mnemosyne + hooks
  fork.ts → prompt.ts → session-init.ts → stop.ts → context.ts

Phase 4: Tests
  Update all test files

Phase 5: Build + verify
  bun test → grep for remnants → rebuild plugin artifacts
```

## Verification

1. `bun test` — all tests pass
2. Grep confirms no remnants in `src/` (excluding migration code in `schema.ts`):

```bash
grep -rE "startedAtEpoch|\.narrative|\.concepts|from_epoch|to_epoch|save_turn|update_session" src/ \
  --include='*.ts' -l
```

3. Migration test: create DB with old schema columns, run `initializeDatabase()`, verify data migrates and reads correctly
