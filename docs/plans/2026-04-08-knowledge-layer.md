# Knowledge Layer: Chronicle + Knowledge Architecture

Date: 2026-04-08

## Motivation

Based on analysis of Claude Code's built-in memory system (extractMemories / autoDream / sessionMemory), we identified key limitations:

1. **No cross-project memory** — user preferences locked in per-project directories
2. **No structured knowledge** — flat .md files with description-only recall
3. **No feedback loop** — no tracking of memory usefulness
4. **Fragile format compliance** — two-step write (file + index) often not followed

Mnemo's current 3-layer chronicle (sessions → turns → observations) records **what happened** but not **what was learned**. This plan adds a knowledge layer to distill durable insights.

## Architecture

```
Chronicle Layer (what happened — project-scoped, existing)
  Session → Turn → Observation

Knowledge Layer (what was learned — global or project-scoped, new)
  Memory
```

## Schema Changes

### Field Renames (all tables)

| Before | After | Reason |
|--------|-------|--------|
| `description` | `content` | "description" implies metadata; "content" is the thing itself |
| `narrative` (observations) | `insight` | Unified with session/turn `insight` field |
| `facts` (observations) | merged into `insight` | Redundant with insight |
| `concepts` (observations) | `tags` | These are classification labels, not content |
| `started_at_epoch` (sessions) | `created_at_epoch` | Consistent naming across all tables |

### New Table: memories

```sql
CREATE TABLE memories (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Classification
  type                TEXT NOT NULL,          -- user|feedback|project|reference
  scope               TEXT NOT NULL,          -- 'global' | project name

  -- Content
  title               TEXT NOT NULL,          -- 10-30 chars
  content             TEXT NOT NULL,          -- core knowledge
  reasoning           TEXT,                   -- why this matters
  application         TEXT,                   -- when/how to apply
  tags                TEXT,                   -- JSON array

  -- Lifecycle
  status              TEXT NOT NULL DEFAULT 'active',  -- active|superseded|archived
  superseded_by       INTEGER REFERENCES memories(id),
  expires_at_epoch    INTEGER,               -- NULL = never; project type may have deadlines

  -- Provenance
  source_turn_id      INTEGER REFERENCES turns(id),

  -- Timestamps
  created_at_epoch    INTEGER NOT NULL,
  updated_at_epoch    INTEGER
);

CREATE INDEX idx_memories_scope ON memories(scope);
CREATE INDEX idx_memories_type ON memories(type);
CREATE INDEX idx_memories_status ON memories(status);
```

### Updated Schema: observations

```sql
CREATE TABLE observations (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id             INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  type                TEXT NOT NULL,         -- bugfix|feature|refactor|change|discovery|decision
  title               TEXT NOT NULL,         -- 10-20 chars
  content             TEXT,                  -- 15-30 chars (was: description)
  insight             TEXT,                  -- 50-150 chars (was: narrative + facts merged)
  tags                TEXT,                  -- JSON array (was: concepts)
  files_read          TEXT,
  files_modified      TEXT,
  created_at_epoch    INTEGER NOT NULL
);
```

### Updated FTS5

```sql
CREATE VIRTUAL TABLE memory_fts USING fts5(
  layer,          -- 'session' | 'turn' | 'observation' | 'memory'
  source_id,
  title,
  content,        -- was: description
  extra           -- session/turn: insight; observation: insight+tags; memory: reasoning+application
);
```

### Field Conventions

All layers use consistent vocabulary:

```
session:     title, content, insight
turn:        title, content, insight, status
observation: type, title, content, insight, tags, files_read, files_modified
memory:      type, scope, title, content, reasoning, application, tags, status, expires_at_epoch
```

### Memory Types (from Claude Code)

| Type | Purpose | Scope bias |
|------|---------|------------|
| `user` | User profile, preferences, knowledge level | global |
| `feedback` | Behavioral rules, corrections, confirmations | global |
| `project` | Deadlines, decisions, architecture context | project |
| `reference` | External system pointers (URLs, tools) | project |

## Tool Redesign: 3 Tools

Current: `recall`, `replay`, `save_turn`, `update_session` (4 tools)
Target: `recall`, `replay`, `remember` (3 tools)

### recall — Read any layer (unchanged concept, extended)

```
# ID-based drill-down (new: prefix routing)
recall(id="S142")         → session detail + turns collapsed
recall(id="S142/T3")      → turn detail + observations
recall(id="O7")           → observation detail
recall(id="M1")           → memory detail

# Scope-based listing (new: memories scope)
recall(scope="sessions")
recall(scope="memories")                    → global + current project active memories
recall(scope="memories", type="feedback")

# Search (unchanged)
recall(query="auth竞态")                    → FTS5 across all layers
recall(scope="observations", type="bugfix", file="auth.ts")

# Time (unchanged)
recall(scope="sessions", time="-7d")
```

### remember — Write any layer (replaces save_turn + update_session + new memory writes)

Routing: `parent` → create child, `id` → update existing, neither → create memory.

```
# Create turn (parent is session)
remember(parent="S142", title="补充单测", content="覆盖并发场景",
         insight="- 10并发稳定通过")

# Skip turn
remember(parent="S142", status="skipped")

# Create observation (parent is turn)
remember(parent="S142/T3", type="bugfix", title="refreshToken 竞态",
         content="auth.ts:42 缺少锁", insight="并发请求互相覆盖 token",
         tags=["concurrency", "auth"])

# Update session
remember(id="S142", title="auth中间件重构", content="修复竞态+补测试",
         insight="- mutex 是并发安全的关键")

# Create memory (no parent, no id)
remember(type="feedback", scope="global", title="测试禁用 DB mock",
         content="集成测试连真实数据库，不要 mock",
         reasoning="mock/prod 差异导致竞态 bug 漏检",
         application="编写涉及 DB 的测试代码时")

# Update memory
remember(id="M1", content="updated content")

# Archive memory
remember(id="M3", status="archived")
```

### replay — Raw transcript (unchanged)

## Display Format Updates

### Timestamps with year

```
[S142] auth中间件重构 | 2026-04-05 14:30 | claude-mem | 4 turns, 9 obs
```

### Child counts on all collapsed nodes

```
[S142] auth中间件重构 | 2026-04-05 14:30 | claude-mem | 4 turns, 9 obs
  [T1] 诊断401错误 | 3 obs
  [T2] 修复 token 竞态 | 2 obs
[M1] feedback/global: 测试禁用 DB mock | 2026-04-07 | 2 sources
```

### Memory display

```
# Collapsed
[M1] feedback/global: 测试禁用 DB mock | 2026-04-07 | 2 sources

# Expanded
[M1] feedback/global: 测试禁用 DB mock | 2026-04-07
  content: 集成测试连真实数据库，不要 mock
  reasoning: mock/prod 差异导致竞态 bug 漏检
  application: 编写涉及 DB 的测试代码时
  tags: [testing, database]
  source: [S142/T3] 补并发测试 | 2026-04-07
```

### Cross-layer search

```
recall(query="竞态")
Found 5 results for "竞态":
[M1] feedback/global: 测试禁用 DB mock | 2026-04-07
[O7] bugfix: refreshToken竞态 | S142/T1
[T1] 诊断401错误 | S142
[O3] decision: 选 mutex 弃 debounce | S142/T1
[S142] auth中间件重构 | 2026-04-05
```

## Mnemosyne Changes

### Extended Workflow (3 phases)

```
Phase 1 — Chronicle extraction (existing, uses remember)
  For each pending turn:
    remember(parent="S{id}", title=..., content=..., insight=...)
    remember(parent="S{id}/T{n}", type="bugfix", ...)      → observations
    or: remember(parent="S{id}", status="skipped")
  For each stale turn:
    remember(parent="S{id}", status="undone")
    or: re-extract

Phase 2 — Knowledge distillation (new)
  recall(scope="memories") to check existing
  New knowledge → remember(type="feedback", scope="global", ...)
  Contradicts existing → remember(id="M{old}", status="archived") + create new
  No new knowledge → skip (most common)

Phase 3 — Session summary (existing, uses remember)
  remember(id="S{id}", title=..., content=..., insight=...)
```

### Updated Allowed Tools

```typescript
allowedTools: ["mcp__mnemo__recall", "mcp__mnemo__replay", "mcp__mnemo__remember"]
```

### Token Budget

```
Input:  ~session tree from recall + ~150 tokens instructions
Output: ~200 tokens/turn + ~200 tokens/memory (rare) + ~150 tokens session update
Total:  ~750-1150 tokens output for a 4-turn session
```

## Hook Changes

### SessionStart

Matcher: `startup|clear` (drop `resume` and `compact` — both already have context)

Context injection budget: ~2000 tokens

| Block | Budget | Content |
|-------|--------|---------|
| Header | ~100 | Stats + format legend |
| Memories | ~600 | All global + current project active memories (collapsed) |
| Recent sessions | ~1100 | Last 5 sessions |
| Buffer | ~200 | Headroom |

Priority on truncation: memories never cut, recent sessions reduce count.

## SKILL.md Changes

Update to reflect 3-tool API, add memory layer to data model, add `remember` parameter reference, add fields-by-layer table.

## Implementation Order

1. Schema migration: add `memories` table, rename fields (`description` → `content`, etc.)
2. Implement `remember` tool (unified write), deprecate `save_turn` + `update_session`
3. Extend `recall` with `scope="memories"` and `id` prefix routing (`S142`, `M1`, etc.)
4. Extend FTS5 index with `layer='memory'`
5. Update Mnemosyne prompt for Phase 2 (knowledge distillation)
6. Update context handler for SessionStart (memories block + reduced matcher)
7. Update SKILL.md
8. Update display format (year in timestamps, child counts, memory rendering)
