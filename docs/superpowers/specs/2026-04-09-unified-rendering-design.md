# Unified Rendering Design

## Goal

Unify recall, replay, and Mnemosyne extraction context into one rendering system. Simplify tool parameters, establish consistent output format, and enable extraction context to include tool call details from JSONL transcripts.

## Problems

### 1. Two parallel rendering paths

`format.ts` renders DB data (recall, context injection). `replay.ts` has its own `formatTurnDetail`/`formatToolBlock`. Different truncation rules, different output shapes, two places to maintain.

### 2. Extraction context lacks tool calls

`buildExtractionContext` uses `formatTurnExpanded` which only has prompt + response (200-char truncated) and a `🔧N` count. Mnemosyne agent cannot see what tools did — it extracts from summaries, producing shallow observations.

### 3. Inconsistent truncation

| Source | prompt | response | tool input | tool result |
|--------|--------|----------|------------|-------------|
| format.ts (recall) | 200 | 200 | - | - |
| replay.ts | ∞ | ∞ | ∞ | 500 |

### 4. recall API complexity

14 parameters with overlapping functionality: `id` vs `session`/`turn`/`obs`, `after`/`before` vs `time`, `depth` vs `expand_turns`. Agents frequently call recall with wrong parameter combinations.

### 5. replay is disconnected

Separate tool, separate parameters (`full`, `tool`), separate rendering. Conceptually it's "view raw experience" but shares no code with recall's "view structured memory".

## Design

### Concepts

- **recall** = memory — structured data from DB (sessions, turns, observations, memories)
- **replay** = experience — raw transcript from JSONL (prompts, responses, tool calls), with DB metadata for ancestor context
- Both use the same rendering format, differ only in data source and child types

### Data source rules

recall and replay both render trees with ancestors. Their data sources differ:

| Layer | recall | replay |
|-------|--------|--------|
| Session header (ancestor) | DB | DB if available, else infer from JSONL `cwd` field |
| Turn header (ancestor/target) | DB | DB if available, else fallback to JSONL prompt |
| Turn content (prompt/response) | DB | JSONL |
| Children | Observations (DB) | Tool calls (JSONL) |

**replay fallback when DB has no record:**

```
Session: "[S?] Untitled | {cwd from JSONL}"     ← no title, no stats, project from cwd
Turn:    "[T3] "raw prompt text" | 🔧6"          ← prompt as title, tool count from JSONL
```

This is a degraded but functional output. In practice, DB records exist for any session that ran hooks (SessionStart creates the session, UserPromptSubmit creates turns). The fallback covers edge cases like orphaned JSONL files or DB corruption.

### Node types

Four entity types form a tree:

```
Session
  └─ Turn
       └─ Observation (recall — from DB, extracted)
       └─ Tool Call   (replay — from JSONL, raw)
Memory (flat, no parent)
```

### Unified node format

Every node has two states:

**Collapsed** — one header line + optional desc:

```
[ID] Title | Date | Stats | Project    ← project only for Session
  desc: ...
```

**Expanded** — header + desc + all remaining fields.

Field set per node type:

| Node | Collapsed | Expanded adds |
|------|-----------|---------------|
| Session | title, date, stats (💬/💡), project, [current] | insight, next_steps |
| Turn | title or "prompt", date+time, stats (🔧), [pending]/[stale]/[undone] | prompt, response, insight, files_read, files_modified |
| Observation | type emoji + title | desc, insight, tags, files |
| Tool Call | 🔧 name + key param | in (JSON), out (result text) |
| Memory | type/scope: title, date, [superseded]/[archived] | content, reasoning, application, tags, source |

### Title fallback

Turns without a title (pending, not yet extracted) fall back to the user prompt in quotes:

```
- [T2] Fix auth race | 2026-04-09 17:23 | 🔧6          ← has title
- [T3] "测试一下" | 2026-04-09 17:30 | 🔧3 [pending]   ← fallback to prompt
```

### Status display

Only non-default states shown:

| Entity | Default (hidden) | Shown |
|--------|-----------------|-------|
| Session | completed | `[current]` |
| Turn | extracted | `[pending]` `[stale]` `[undone]` |
| Memory | active | `[superseded]` `[archived]` |

### Tool call collapsed format

One line: tool name + key parameter extracted from input:

```
🔧 Edit src/auth.ts
🔧 Bash bun test auth
🔧 Read src/config.ts
🔧 Grep "pattern" src/
🔧 Glob **/*.ts
🔧 Write src/new-file.ts
🔧 Agent "research task"
```

Key parameter extraction rules:
- Edit/Read/Write/Glob: `file_path` or `path`
- Bash: `command` (truncated)
- Grep: `pattern` + `path`
- Agent: `description`
- Other: first string-valued parameter

### Truncation

One limit per depth level, applied uniformly to all text fields:

| Depth | Truncation limit |
|-------|-----------------|
| collapsed | 120 |
| expanded | 300 |
| full | 1000 |

All fields — desc, prompt, response, insight, tool input, tool result — use the same limit. No per-field exceptions.

Truncated text appends `...` suffix. No `[use replay(...)]` hints — the caller knows how to drill down via id.

### Tree rendering rules

1. **Ancestors**: collapsed detail fields (header + desc only), but always render the path to the target — the selected child is shown even though the ancestor itself is collapsed
2. **Target nodes**: rendered according to `depth`
3. **Children of target**: collapsed → not shown; expanded → shown collapsed; full → shown expanded recursively
4. **Siblings of target**: not shown (only the target among its siblings is rendered)

"Collapsed ancestor" means the ancestor's own detail fields (prompt, response, insight, etc.) are omitted. It does NOT mean its children are hidden — the ancestor acts as a **shell** that contains the path to the target.

```
recall(id="S1/T2", depth="expanded")
- [S1] Auth race fix | 2026-04-09 | 💬5 💡4 | /path    ← ancestor shell: header + desc, no other fields
    - desc: 修复 token refresh 竞争条件...
    - [T2] Fix auth race | 2026-04-09 17:23 | 🔧6        ← target, expanded
        - desc: Serialized token refresh...
        - prompt: "Fix the auth race condition"
        - response: "I'll add a mutex to serialize..."
        - [O2] 🔵 scope 碰撞 bug                         ← child, collapsed
            - desc: context.ts:186 用 basename...
        - [O3] 🔵 prompt 无 XML 边界
            - desc: ...

replay(id="S1/T2/Tool3", depth="expanded")
- [S1] Auth race fix | 2026-04-09 | /path               ← ancestor shell
    - desc: ...
    - [T2] "Fix the auth race" | 2026-04-09 17:23 | 🔧6  ← ancestor shell (not expanded, but Tool3 hangs here)
        - desc: ...
        - 🔧 Bash bun test auth                           ← target (Tool3), expanded
            in: {"command":"bun test auth"}
            out: ✓ 12 tests passed...
```

The rule applies recursively at any depth: `S → T → Tool`, `S → T → O`, etc. Each ancestor on the path is a shell; only the leaf target gets `depth` applied.

### Turn children: observations vs tool calls

A turn can have observations (from DB) and tool calls (from JSONL). Which to show:

| Scenario | Children shown |
|----------|---------------|
| recall — extracted turn | Observations |
| recall — pending turn | Tool calls (from JSONL if available, else none) |
| replay — any turn | Tool calls |
| extraction context — extracted turn | Observations |
| extraction context — pending turn | Tool calls (from JSONL) |

Rule: **recall shows obs when available, falls back to tool calls. replay always shows tool calls.**

### recall parameters

5 parameters:

```
id:     string   — node selector with glob/range (default: "S*")
query:  string   — FTS search with prefix filters
time:   string   — temporal filter
depth:  enum     — collapsed | expanded | full (default: collapsed)
limit:  number   — max results (default: 50)
```

#### id syntax

```
S*              all sessions
S1              session 1 (DB id)
S1..5           sessions 1–5 (DB id range)
S1/T*           all turns in session 1
S1/T2           turn 2 in session 1 (prompt_number, stable)
S1/T2..4        turns 2–4 in session 1 (prompt_number range)
S1/T2/O*        list observations under turn 2 (parent-scoped listing)
O7              observation 7 (global DB id, stable across re-extraction)
M*              all memories
M1              memory 1 (DB id)
```

`S1/T2/O*` lists all observations belonging to T2 — the `S1/T2/` prefix is a parent filter, not an identity namespace. Individual observations are always addressed by global DB id: `O7`, not `S1/T2/O3`. The form `S1/T2/O7` is NOT supported — use `O7` directly.

No id defaults to `S*`.

**Observation identity**: Observations use **global DB id** (`O7`), not per-turn ordinal. Per-turn ordinals are unstable — re-extraction may change the number and order of observations within a turn. `S1/T2/O*` is a parent-scoped listing (all observations belonging to T2), not a namespace. To access a specific observation, always use the global form `O7`. The path prefix `S1/T2/` in `S1/T2/O*` acts as a filter constraint, not an identity scheme.

**Tool call identity** (replay only): Tool calls use per-turn ordinal (`S1/T2/Tool3` = 3rd tool call in the turn) because they come from JSONL and have no DB id. This is acceptable — JSONL content is immutable once written.

#### Multi-target rendering

Wildcard (`*`) and range (`..`) selectors produce multiple targets. Rules:

1. **Shared ancestors rendered once.** All targets under the same session/turn are merged into one tree. The common ancestor is a shell (collapsed, shown once).
2. **Each matched target rendered individually by `depth`.** Targets are siblings under their shared ancestor, each following the `depth` parameter independently.
3. **Ordering**: targets rendered in natural order (sessions by id, turns by prompt_number, observations by id).
4. **`limit` caps total target count**, not ancestor count.

```
recall(id="S1/T*", depth="expanded")
- [S1] Auth race fix | 2026-04-09 | 💬5 💡4 | /path     ← shared ancestor shell, once
    - desc: ...
    - [T1] 初始化 | 2026-04-09 09:00 | 🔧1                ← target 1, expanded
        - desc: ...
        - prompt: "测试"
        - response: "正常运行..."
    - [T2] Fix auth race | 2026-04-09 09:15 | 🔧6          ← target 2, expanded
        - desc: ...
        - prompt: "Fix the auth race"
        - response: "I'll add a mutex..."
        - [O2] 🔵 scope 碰撞 bug                           ← child, collapsed
            - desc: ...
    - [T3] "测试一下" | 2026-04-09 09:30 | 🔧3 [pending]   ← target 3, expanded
        - desc: ...
        - prompt: "测试一下"
        - response: "所有测试通过..."

recall(id="S1..3", depth="collapsed")
- [S1] Auth race fix | 2026-04-09 | 💬5 💡4 | /path       ← target, collapsed
    - desc: ...
- [S2] Schema cleanup | 2026-04-09 | 💬3 | /path          ← target, collapsed
    - desc: ...
- [S3] Prompt hardening | 2026-04-08 | 💬7 💡2 | /path    ← target, collapsed
    - desc: ...
```

This rule also applies to query results (defined in "query result rendering" section): hits are grouped by session, shared ancestors shown once.

#### query prefix syntax

```
recall(query="auth race")                    FTS full-text search
recall(query="type:bugfix")                  filter by observation/memory type
recall(query="file:auth.ts")                 filter by file
recall(query="project:/path/to/project")     filter by project
recall(query="tag:concurrency")              filter by tag
recall(query="type:bugfix auth race")        combined FTS + filter
```

#### time syntax

Day-level precision for user/agent queries. Internal code that needs epoch-level filtering (e.g., compact anchor in `buildExtractionContext`) queries the DB directly without going through recall parameters.

```
-7d                          last 7 days
-2w                          last 2 weeks
2026-04-09                   specific date
2026-04-01..2026-04-09       date range
```

**Breaking simplification**: `after`/`before` epoch parameters are removed. The `time` parameter only supports day-level granularity. This is intentional — sub-day filtering is an internal concern, not an agent-facing need.

### query result rendering

When `query` is provided, results may span multiple sessions and node types. Rendering rules:

**1. Results are always rooted at session level.** Every hit is shown within its session tree. Ancestors of the hit are collapsed.

**2. Grouping by session.** Multiple hits in the same session are merged into one tree. Hits in different sessions produce separate trees.

**3. `limit` limits hit count, not group count.** `limit=10` means at most 10 matching nodes (turns, observations, or memories), regardless of how many sessions they span.

**4. Memory hits are flat.** Memories have no parent — they render as a flat list, not nested in a session tree.

**5. Hit nodes rendered by `depth`.** Non-hit ancestors/siblings are collapsed. The hit node itself follows the `depth` parameter.

```
recall(query="type:bugfix", depth="expanded", limit=10)

# Observation hits, grouped by session
- [S31] 评审记忆系统... | 2026-04-09 | ...         ← ancestor, collapsed
    - desc: ...
    - [T2] 上下文注入设计评审 | ... | 🔧6            ← ancestor, collapsed
        - desc: ...
        - [O2] 🔵 scope 碰撞 bug                     ← hit, expanded
            - desc: context.ts:186 用 basename...
            - insight: ...
            - tags: ...
- [S1] Auth race fix | 2026-04-09 | ...             ← another session
    - desc: ...
    - [T3] Fix auth race | ... | 🔧6
        - desc: ...
        - [O5] 🔴 Mutex added                        ← hit, expanded
            - desc: ...

# Memory hits (flat, no parent)
- [M3] feedback/project: No DB mocks | 2026-04-01
    - desc: Integration tests must hit real DB...
```

**6. Mixed-type query results.** When a query matches across sessions, turns, observations, and memories, all hits are rendered — sessions and memories as top-level entries, turns and observations nested under their session ancestor.

### replay parameters

2 parameters:

```
id:     string   — node selector (required)
depth:  enum     — collapsed | expanded | full (default: collapsed)
```

#### id syntax

```
S1              session 1 (target = session node)
S1/T*           all turns in session 1
S1/T2           turn 2 (prompt_number)
S1/T2..4        turns 2–4
S1/T2/Tool*     all tool calls in turn 2
S1/T2/Tool3     tool call #3 in turn 2 (per-turn ordinal, JSONL is immutable)
```

No wildcard defaults, no query/time/limit — replay is precise navigation. Multi-target rules (shared ancestor once, each target by depth) apply identically to replay.

### Extraction context

Mnemosyne extraction context reuses the rendering system but applies depth per turn status. Split into two parts for cache prefix optimization:

**Part 1 — stable prefix (cacheable across API calls):**

```
[Extracted/skipped turns — collapsed]
[Pending/stale turns — expanded with tool calls from JSONL]
```

Extracted turns: `renderNode(turn, depth="collapsed")`
Pending turns: `renderNode(turn, depth="expanded")` with tool calls populated from transcript

**Part 2 — dynamic suffix (updated each injection):**

```
[Session summary — expanded]
```

Session summary placed last so Part 1 prefix remains stable.

**After main conversation compact:** prune extracted turns before the compact anchor from Part 1 (existing `last_compact_turn` mechanism). Only keep post-anchor turns + pending turns.

```
Pre-compact:  [T1 collapsed][T2 collapsed][T3 collapsed][T4 expanded][Session]
Post-compact: [T3 collapsed][T4 expanded][Session]
                             ↑ anchor at T2, T1-T2 pruned
```

### FormattedTurn extension

Add tool calls to the shared data model:

```typescript
export interface FormattedToolCall {
  name: string;
  keyParam: string;      // extracted key parameter for collapsed display
  input: string;         // JSON.stringify for expanded
  result: string;        // tool result text for expanded
}

export interface FormattedTurn {
  // ...existing fields...
  toolCalls?: FormattedToolCall[];
}
```

### Rendering function changes

Replace the current two-function-per-depth pattern (`formatTurnCollapsed`/`formatTurnExpanded`) with a single `renderNode` dispatcher:

```typescript
function renderNode(node: FormattedNode, depth: Depth, role: "target" | "ancestor" | "child"): string
```

- `role="ancestor"` → always collapsed
- `role="target"` → use `depth`
- `role="child"` → collapsed if parent depth is expanded, expanded if parent depth is full, not shown if parent depth is collapsed

Truncation limit determined by depth, applied uniformly via `truncateText(text, depth)`.

## Layer responsibilities

```
transcript-parser.ts   → raw data: name, input (unknown), result (string)
format.ts              → rendering: extractKeyParam(name, input), renderNode(), truncation
recall.ts / replay.ts  → routing: parse params, fetch data, call renderNode()
definitions.ts         → schema: parameter shapes for MCP tools
```

`extractKeyParam()` belongs in `format.ts` (render layer), not `transcript-parser.ts`. The parser returns raw `{ name, input, result }` — the render layer decides how to display it. This keeps parsing and presentation independent, allowing different render profiles (extraction context vs replay vs future UI) for the same tool call data.

## Execution phases

The migration is split into two phases to avoid a big-bang that breaks hooks, Mnemosyne prompt, and runtime simultaneously.

### Phase 1: Unified rendering internals

**Goal**: All rendering goes through `renderNode`. Existing public API parameters unchanged. No prompt/handler/shim changes.

| File | Change |
|------|--------|
| `src/mcp/format.ts` | Add `FormattedToolCall`, `extractKeyParam()`, `renderNode()` dispatcher, unified `truncateText(text, depth)`. Keep old `formatTurnCollapsed`/`formatTurnExpanded`/etc. as thin wrappers calling `renderNode` internally — existing callers don't break. |
| `src/mcp/replay.ts` | Replace `formatTurnDetail`/`formatToolBlock` with `renderNode`. Keep existing `ReplayInput` parameter shape (`session`, `turn`, `tool`, `full`). Map `full=true` → `depth="full"` internally. |
| `src/mnemosyne/context.ts` | Populate `FormattedTurn.toolCalls` from JSONL for pending turns. Render via `renderNode`. |
| `src/hooks/handlers/context.ts` | Switch SessionStart context injection to use `renderNode`. |
| Tests | Update format/context/replay tests for new output shape. No parameter-level test changes. |

After Phase 1:
- `recall(session=1, turn=2, depth="expanded")` still works — old params, new rendering
- `replay(session=1, turn=2, full=true)` still works — old params, new rendering
- Extraction context now includes tool calls for pending turns
- All output goes through one renderer

### Phase 2: Simplified public API

**Goal**: Consolidate parameters. Update prompts, handlers, and tool descriptions.

| File | Change |
|------|--------|
| `src/mcp/definitions.ts` | Replace `recallInputShape` (5 params: id, query, time, depth, limit), replace `replayInputShape` (2 params: id, depth). Remove `expand_turns`, `full`, `tool`, `view`, `session`, `turn`, `obs`, `after`, `before`, `project`, `type`, `file`. |
| `src/mcp/recall.ts` | Rewrite routing: parse id patterns (`S*`, `S1/T2`, `O7`, `M*`, ranges), parse query prefixes (`type:`, `file:`, `tag:`, `project:`). Remove old selector/routing/normalization logic. |
| `src/mcp/replay.ts` | Rewrite routing: parse id patterns (`S1/T2`, `S1/T2/Tool3`). Remove old `tool`/`full` params. |
| `src/mcp/handlers.ts` | Update handler mappings for new input shapes. Remove compatibility shims. |
| `src/mnemosyne/prompt.ts` | Update tool examples to new parameter syntax. |
| `src/mnemosyne/fork.ts` | Update `MNEMO_ALLOWED_TOOLS` if tool names change. |
| Tests | Rewrite recall/replay parameter tests. Update prompt assertion tests. |

After Phase 2:
- Old parameter forms no longer accepted — no compatibility shims, no fallback parsing
- Prompt examples use new `id=` syntax
- Clean public API: recall(5 params) + replay(2 params)
- Phase 1 thin wrappers (`formatTurnCollapsed`, `formatTurnExpanded`, etc.) deleted — all callers migrated to `renderNode`
- Verification: `grep -r "session.*turn.*depth\|view.*sessions\|expand_turns\|full.*true\|formatTurnCollapsed\|formatTurnExpanded\|formatObservationCollapsed\|formatObservationExpanded" src/` — zero hits outside of test fixtures

## Migration

### recall parameter mapping

| Old | New |
|-----|-----|
| `view="sessions"` | `id="S*"` |
| `view="turns", session=1` | `id="S1/T*"` |
| `view="turns", session=1, turn=2` | `id="S1/T2"` |
| `view="observations", session=1` | `id="S1/T*/O*"` (list all obs in session); specific obs: `id="O7"` (global DB id) |
| `id="S1"` | `id="S1"` (unchanged) |
| `id="S1/T2"` | `id="S1/T2"` (unchanged) |
| `session=1, turn=2, depth="expanded"` | `id="S1/T2", depth="expanded"` |
| `type="bugfix"` | `query="type:bugfix"` |
| `file="auth.ts"` | `query="file:auth.ts"` |
| `project="/path"` | `query="project:/path"` |
| `after=N, before=M` | `time="date1..date2"` (breaking: day-level only, epoch precision dropped) |
| `expand_turns=[2,3]` | Multiple calls or `id="S1/T2..3", depth="expanded"` |
| `limit=10` | `limit=10` (unchanged) |

### replay parameter mapping

| Old | New |
|-----|-----|
| `session=1` | `id="S1"` |
| `session=1, turn=2` | `id="S1/T2"` |
| `session=1, turn=2, tool=3` | `id="S1/T2/Tool3"` |
| `session=1, turn=2, full=true` | `id="S1/T2", depth="full"` |

### Prompt update

`src/mnemosyne/prompt.ts` tool references update to match new parameter shapes in examples.

## Examples

### recall

```
# Default: recent sessions
recall()
- [S31] 评审记忆系统上下文注入设计 | 2026-04-09 | 💬5 💡4 | /Users/.../claude-mnemo
    - desc: 用户验证上下文注入正常后...
- [S22] 用户身份确认与记忆查询对话 | 2026-04-09 | 💬3 | /Users/.../claude-mnemo
    - desc: 用户用中文询问 Claude Code 身份...

# Drill into a turn
recall(id="S31/T2", depth="expanded")
- [S31] 评审记忆系统上下文注入设计 | 2026-04-09 | 💬5 💡4 | /Users/.../claude-mnemo
    - desc: 用户验证上下文注入正常后...
    - [T2] 上下文注入设计评审 | 2026-04-09 17:23 | 🔧6
        - desc: 用户问"注入方式是否合理？"...
        - prompt: "注入方式是否合理？"
        - response: "让我再看一下注入的上游实现..."
        - [O2] 🔵 scope 碰撞 bug
            - desc: context.ts:186 用 basename(cwd)...
        - [O3] 🔵 prompt 无 XML 边界
            - desc: prompt.ts:65 将 context 直接拼接...

# Search — hits grouped by session, ancestors collapsed
recall(query="type:bugfix auth", time="-7d", depth="expanded")
- [S31] 评审记忆系统... | 2026-04-09 | 💬5 💡4 | /Users/.../claude-mnemo
    - desc: 用户验证上下文注入正常后...
    - [T2] 上下文注入设计评审 | 2026-04-09 17:23 | 🔧6
        - desc: 用户问"注入方式是否合理？"...
        - [O2] 🔵 scope 碰撞 bug                        ← hit, expanded
            - desc: context.ts:186 用 basename(cwd)...
            - insight: ...
            - tags: [architecture, scope]

# Memories
recall(id="M*")
- [M1] user/global: 用户使用中文交流 | 2026-04-09
    - desc: ...
```

### replay

```
# Turn with tool calls
replay(id="S1/T3", depth="expanded")
- [S1] Auth race fix | 2026-04-09 | /Users/.../claude-mnemo
    - desc: ...
    - [T3] "Fix the auth race" | 2026-04-09 17:23 | 🔧3
        - prompt: "Fix the auth race condition"
        - response: "I'll add a mutex to serialize..."
        - 🔧 Edit src/auth.ts
            in: {"file_path":"src/auth.ts","old_string":"const tok..."}
            out: File edited successfully.
        - 🔧 Bash bun test auth
            in: {"command":"bun test auth"}
            out: ✓ 12 tests passed...
        - 🔧 Read src/auth.ts
            in: {"file_path":"src/auth.ts"}
            out: import { refreshToken } from...

# Single tool call
replay(id="S1/T3/Tool1", depth="expanded")
- [S1] Auth race fix | 2026-04-09 | /Users/.../claude-mnemo
    - desc: ...
    - [T3] "Fix the auth race" | 2026-04-09 17:23 | 🔧3
        - 🔧 Edit src/auth.ts
            in: {"file_path":"src/auth.ts","old_string":"const tok..."}
            out: File edited successfully.
```

### Extraction context

```
# Part 1: stable prefix
- [T1] 初始化 | 2026-04-09 09:00 | 🔧1
    - desc: 单轮测试...
- [T2] Fix auth race | 2026-04-09 09:15 | 🔧6
    - desc: Serialized token refresh...
- [T3] "测试一下" | 2026-04-09 09:30 | 🔧3 [pending]
    - desc: ...
    - prompt: "测试一下"
    - response: "所有测试通过..."
    - 🔧 Bash bun test
        in: {"command":"bun test"}
        out: ✓ 12 tests passed...

# Part 2: dynamic suffix
- [S1] Auth race fix | 2026-04-09 | 💬3 💡2 | /Users/.../claude-mnemo
    - desc: 修复 token refresh 竞争条件...
    - insight: ...
    - next_steps: ...
```

## Verification

1. `bun test` — all tests pass
2. `recall()` returns collapsed session list with limit=50
3. `recall(id="S1/T2", depth="expanded")` shows S1 as collapsed ancestor, T2 expanded with children
4. `recall(id="S1/T2", depth="full")` recursively expands T2's children
5. `replay(id="S1/T2", depth="expanded")` shows tool calls instead of observations
6. `replay` with no DB record falls back to JSONL-only metadata (cwd as project, prompt as title)
7. `recall(query="type:bugfix")` groups hits by session, ancestors collapsed, hits rendered by depth
8. `recall(query="...", limit=5)` limits to 5 hit nodes regardless of session count
9. Extraction context: extracted turns collapsed, pending turns expanded with tool calls from JSONL
10. Truncation uniform per depth: 120/300/1000 applied to all text fields
11. `grep -r "formatTurnCollapsed\|formatTurnExpanded\|formatObservationCollapsed\|formatObservationExpanded" src/` — replaced by `renderNode`
12. `grep -r "full.*true\|expand_turns\|after.*before" src/mcp/definitions` — removed
13. `grep -r "after\|before" src/mcp/recall.ts` — no epoch params in public API (internal use in context.ts is OK)
