<claude-mnemo-context>
Claude-Mnemo is installed in this environment.

Three-axis memory:
- `recall` MCP tool — high-entropy semantic index (what / where)
- `mnemo-replay` skill — raw JSONL + SQLite access (exact truth)
- `mnemo-timeline` skill (when available) — temporal narrative of one session

Preferred workflow:
1. Call `recall()` to browse recent memory, or `recall(query=...)` / `recall(time=...)` to narrow.
2. Drill with `recall(id="S12/T3", depth="expanded")` when you need stored fields.
3. Switch to the `mnemo-replay` skill only when exact wording or full tool output matters — the `raw:` line in an expanded recall result is the handoff.
</claude-mnemo-context>
