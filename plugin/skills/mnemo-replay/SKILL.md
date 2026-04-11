---
name: mnemo-replay
description: Read raw Claude Code session transcripts and the mnemo SQLite database directly. Use when recall output is truncated, when you need exact user wording or full tool output, or when you want to reconstruct a session from the source bytes.
---

# Mnemo Replay

Raw access to the source data behind claude-mnemo. This is a skill, not an MCP tool. Use normal file and shell tools to inspect the JSONL transcript and the SQLite database directly.

Use this only after `recall` has already narrowed you to a specific session, turn, or observation. `mnemo-replay` is for raw reads, not broad search.

## Two data sources

| Source | Contents | How to read it |
|---|---|---|
| JSONL transcript | Exact Claude session bytes: user prompts, assistant responses, tool calls, tool results, summary markers | `Read`, `Grep` |
| SQLite database | Indexed mirror: sessions, turns, observations, memories | `sqlite3` in read-only mode |

Use JSONL for exact wording and full payloads. Use SQLite for joined lookups and aggregates.

## JSONL transcripts

### Where they live

Claude Code stores transcripts under:

```text
~/.claude/projects/<encoded-project-path>/<content-session-id>.jsonl
```

The encoded project path replaces `/` with `-`. Example:

```text
/Users/alice/code/my-app
→ ~/.claude/projects/-Users-alice-code-my-app/<uuid>.jsonl
```

For mnemo worker sessions, the project path is `~/.claude-mnemo`, so those transcripts live under the dedicated pseudo-project directory for that path.

The easiest handoff is from:

```text
recall(id="S12", depth="expanded")
```

Expanded session output includes a `raw:` line with the absolute JSONL path.

### Useful patterns

**Open the transcript directly**

```text
Read(<absolute jsonl path>)
```

**Find user-message boundaries**

```text
Grep(pattern='"type":"user"', path='<jsonl path>')
```

**Find tool calls for one tool**

```text
Grep(pattern='"name":"Bash"', path='<jsonl path>')
```

**Find compact boundaries**

```text
Grep(pattern='"type":"summary"', path='<jsonl path>')
```

Summary lines mark compact boundaries in the raw transcript.

## SQLite database

### Where it lives

Default path:

```text
~/.claude-mnemo/claude-mnemo.db
```

If the install uses a custom data dir, adjust accordingly.

### Read-only usage

```bash
sqlite3 ~/.claude-mnemo/claude-mnemo.db -cmd ".mode column" -cmd ".headers on" "<query>"
```

Do not write through `sqlite3`. Writes still go through `remember`.

### Relevant tables

| Table | Row = | Useful columns |
|---|---|---|
| `sessions` | One Claude Code conversation | `id`, `content_session_id`, `project`, `title`, `content`, `insight`, `next_steps`, `last_compact_turn` |
| `turns` | One user prompt in a session | `id`, `session_id`, `prompt_number`, `status`, `title`, `content`, `type`, `tags`, `files_read`, `files_modified`, `tool_call_count` |
| `observations` | One tool call in a turn | `id`, `turn_id`, `tool_name`, `tool_input`, `tool_result`, `status`, `title`, `content` |
| `memories` | Durable cross-session knowledge | `id`, `type`, `scope`, `title`, `content`, `reasoning`, `application`, `tags`, `status` |

### Useful queries

**Map session id to transcript metadata**

```sql
SELECT project, content_session_id
FROM sessions
WHERE id = 12;
```

**List turns in one session**

```sql
SELECT prompt_number, type, title, status
FROM turns
WHERE session_id = 12
ORDER BY prompt_number;
```

**Recent turns that touched a file**

```sql
SELECT s.id AS session, t.prompt_number AS turn, t.title
FROM turns t
JOIN sessions s ON s.id = t.session_id
WHERE (t.files_read LIKE '%src/auth.ts%' OR t.files_modified LIKE '%src/auth.ts%')
ORDER BY t.created_at_epoch DESC
LIMIT 20;
```

**Recent active memories by tag**

```sql
SELECT id, type, scope, title
FROM memories
WHERE tags LIKE '%"feedback"%'
  AND status = 'active'
ORDER BY COALESCE(updated_at_epoch, created_at_epoch) DESC
LIMIT 20;
```

## When to use which source

| Situation | Use |
|---|---|
| Exact user prompt wording | JSONL |
| Full, untruncated tool output | JSONL |
| Pre/post-compact transcript reconstruction | JSONL |
| Aggregates or cross-session joins | SQLite |
| Tag / type / file filtering | SQLite |
| High-level search or browsing | `recall`, not this skill |

## Guidance

- Always narrow with `recall` first.
- Use the `raw:` line from expanded session output as the copy-paste handoff.
- Treat SQLite as read-only unless you are going through `remember`.
- If you need exact bytes, prefer the JSONL over the indexed mirror.
