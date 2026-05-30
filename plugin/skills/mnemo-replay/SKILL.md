---
name: mnemo-replay
description: Read raw Claude Code session transcripts and the mnemo SQLite database directly. Use when recall output is truncated, when you need exact user wording, the full assistant response, or full tool output, or when you want to reconstruct a session from the source bytes.
---

# Mnemo Replay

Raw access to the source transcript behind claude-mnemo. This is a skill, not an MCP tool.

Use this only after `recall` or `timeline` has already narrowed you to a specific session or turn. `mnemo-replay` is for raw reads, not broad search.

## Preferred path

Use the bundled parser script first:

```bash
bun "$CLAUDE_PLUGIN_ROOT/scripts/replay-parse.cjs" schema <jsonl-path>
```

It understands resumed transcripts, promptId turn boundaries, compact markers, tool results, and malformed-line skips the same way claude-mnemo itself does.

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

### Script entrypoints

**Inspect available fields**

```bash
bun "$CLAUDE_PLUGIN_ROOT/scripts/replay-parse.cjs" schema <jsonl-path>
```

**Query selected columns**

```bash
bun "$CLAUDE_PLUGIN_ROOT/scripts/replay-parse.cjs" query <jsonl-path> -f "promptNumber,localTime,userPrompt:80" --last 30
```

**Show one turn**

```bash
bun "$CLAUDE_PLUGIN_ROOT/scripts/replay-parse.cjs" show <jsonl-path> T12
```

**Search raw transcript content while selecting fields**

```bash
bun "$CLAUDE_PLUGIN_ROOT/scripts/replay-parse.cjs" query <jsonl-path> -f "promptNumber,assistantText:160" --grep "auth race"
```

### When to fall back to direct reads

Use raw `Read`/`Grep` only when the script output is still insufficient, for example:
- inspecting bytes the formatter truncated
- verifying an exact JSON field that `show` or `query` does not print
- checking transcript corruption by line number

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
| `turns` | One user prompt in a session | `id`, `session_id`, `prompt_number`, `status`, `title`, `content`, `user_prompt`, `assistant_response`, `type`, `tags`, `files_read`, `files_modified`, `tool_call_count` |
| `observations` | One tool call in a turn | `id`, `turn_id`, `tool_name`, `tool_input`, `tool_result`, `status`, `title`, `content` |

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

**Full prompt + response for one turn** (these columns hold the complete text; `recall` and the memory agent only ever see a truncated view of them)

```sql
SELECT user_prompt, assistant_response
FROM turns
WHERE session_id = 12 AND prompt_number = 3;
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

## Guidance

- Always narrow with `recall` first.
- Use the `raw:` line from expanded session output as the copy-paste handoff.
- Prefer `replay-parse.cjs schema/query/show` over hand-written `Read`/`Grep` flows.
- Treat SQLite as read-only unless you are going through `remember`.
- For the full assistant response (or user prompt): the `turns.assistant_response` / `turns.user_prompt` columns hold the complete text — `recall` and the memory agent only see a capped slice. Read the column directly, or for the verbatim original use the JSONL `assistantText` field without a `:N` cap.
- If you need exact bytes, prefer the JSONL over the indexed mirror.
