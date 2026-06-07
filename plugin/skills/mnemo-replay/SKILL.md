---
name: mnemo-replay
description: Read a past turn's full content — the user prompt, the complete assistant narration, and every tool call's raw input/output — directly from the mnemo SQLite database, which stores them uncapped (recall and timeline only show a truncated slice). Use after recall/timeline has pointed you at a session or turn. The raw JSONL transcript is a fallback only for exact bytes or message metadata the database does not mirror.
---

# Mnemo Replay

Raw, uncapped access to what happened in a past turn. This is a skill, not an MCP tool.

Use it only after `recall` or `timeline` has already narrowed you to a specific session or turn — `mnemo-replay` reads a known target, it is not for broad search.

**Read from the SQLite database first.** It holds the full text that `recall` and the memory agent only ever see truncated: the user prompt, the complete assistant narration, and every tool call's raw input/output — all uncapped. Reach for the raw JSONL transcript only for the few things the database does not mirror (exact bytes, message metadata).

## SQLite database (primary)

### Where it lives

```text
~/.claude-mnemo/claude-mnemo.db
```

(If the install uses a custom data dir, adjust accordingly.)

### Read-only usage

```bash
sqlite3 ~/.claude-mnemo/claude-mnemo.db -cmd ".mode column" -cmd ".headers on" "<query>"
```

Do not write through `sqlite3`. Writes still go through `remember`.

### Relevant tables

| Table | Row = | Useful columns |
|---|---|---|
| `sessions` | One Claude Code conversation | `id`, `content_session_id`, `project`, `title`, `content`, `insight`, `next_steps`, `last_compact_turn` |
| `turns` | One user prompt in a session | `id`, `session_id`, `prompt_number`, `status`, `title`, `content`, `user_prompt`, `assistant_response`, `assistant_transcript`, `type`, `tags`, `files_read`, `files_modified`, `tool_call_count` |
| `observations` | One tool call in a turn | `id`, `turn_id`, `tool_name`, `tool_input`, `tool_result`, `status`, `title`, `content` |

### Reconstruct an entire turn

Prompt, complete assistant narration, and every tool call's raw input/output — entirely from the database, no JSONL:

```sql
SELECT user_prompt, assistant_transcript
FROM turns
WHERE session_id = 12 AND prompt_number = 3;

SELECT tool_name, tool_input, tool_result, status
FROM observations
WHERE turn_id = (SELECT id FROM turns WHERE session_id = 12 AND prompt_number = 3)
ORDER BY id;
```

- `assistant_transcript` is the **full interleaved narration** — every assistant text block of the turn. `assistant_response` is only the **final** block (what the extractor and the `recall` preview see). Populated for turns recorded since the column was added; older turns leave it `NULL` — fall back to the JSONL for those.
- `observations.tool_input` / `tool_result` are stored **uncapped**, even for `skipped` rows.

### Other useful queries

**Map session id to transcript metadata** (also gives you the JSONL location if you need the fallback)

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

## JSONL transcript (fallback)

Go here only for what the database does not store: exact verbatim bytes, the precise text/tool interleaving order, thinking blocks, per-message usage/model metadata, compact summaries, or turns predating the `assistant_transcript` column.

### Where it lives

```text
~/.claude/projects/<encoded-project-path>/<content-session-id>.jsonl
```

The encoded project path replaces `/` with `-` (e.g. `/Users/alice/code/my-app` → `~/.claude/projects/-Users-alice-code-my-app/<uuid>.jsonl`); mnemo worker sessions use the project path `~/.claude-mnemo`. The exact absolute path is the `raw:` line in `recall(id="S12", depth="expanded")` output — copy-paste it.

### Parse it with the bundled script

Prefer the parser over hand-written `Read`/`Grep` — it understands resumed transcripts, promptId turn boundaries, compact markers, tool results, and malformed-line skips the same way claude-mnemo does:

```bash
bun "$CLAUDE_PLUGIN_ROOT/scripts/replay-parse.cjs" schema <jsonl-path>           # available fields
bun "$CLAUDE_PLUGIN_ROOT/scripts/replay-parse.cjs" show <jsonl-path> T12          # one turn
bun "$CLAUDE_PLUGIN_ROOT/scripts/replay-parse.cjs" query <jsonl-path> -f "promptNumber,assistantText:160" --grep "auth race"
```

Use raw `Read`/`Grep` only when even the script's output is insufficient — inspecting bytes it truncated, verifying an exact JSON field it does not print, or checking transcript corruption by line number.

> On compacted sessions the JSONL's `T<n>` (promptNumber) can drift from the database's `prompt_number` (the DB also counts compact-continuation and superseded forked turns), so the same `T12` may land on a different turn. When in doubt, anchor by `--grep` content rather than the turn number.

## Guidance

- Always narrow with `recall` / `timeline` first; `mnemo-replay` reads a known target.
- For a turn's full content — prompt, complete assistant narration, every tool call's raw I/O — query the **database**: `turns.user_prompt` + `turns.assistant_transcript` + `observations.tool_input`/`tool_result`, all uncapped. This is the default path.
- Treat SQLite as read-only; writes go through `remember`.
- Go to the **JSONL** only for what the DB does not store (exact bytes, message metadata, interleaving order, or `NULL` `assistant_transcript` on older turns), and prefer `replay-parse.cjs` over hand-parsing.
