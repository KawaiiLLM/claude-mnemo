---
name: mnemo
description: Use recall and replay to inspect Claude-Mnemo memory before re-reading old transcripts.
---

# Mnemo Skill

Claude-Mnemo provides two MCP tools:

- `recall`: structured memory across sessions, turns, and observations
- `replay`: raw transcript playback for the original conversation details

## Workflow

1. Start with `recall()` to see recent sessions.
2. Use `recall(query="keyword")` for search, or `recall(session=ID)` to drill into one session.
3. Use `recall(turn=ID)` or `recall(observation=ID)` for deeper detail.
4. Use `replay(session=ID, turn=N)` when you need the raw QA transcript.

## Examples

```text
recall()
recall(query="auth race")
recall(session=12, expand_turns=[1, 3])
recall(type="bugfix", file="src/auth.ts")
replay(session=12)
replay(session=12, turn=2)
replay(session=12, turn=2, tool=1, full=true)
```

## Guidance

- Prefer `recall` for fast navigation.
- Prefer `replay` when exact prompt/response wording matters.
- Treat `observation` entries as the most specific durable memory unit.
