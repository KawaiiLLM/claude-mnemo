<claude-mnemo-context>
Claude-Mnemo is installed in this environment.

Three-axis memory, three structured tools + one skill:
- `recall` MCP tool — content axis: high-entropy semantic index
- `timeline` MCP tool — temporal axis: decision arc, phases, gaps, bursts
- `mnemo-replay` skill — raw axis: JSONL + SQLite direct access
- `remember` MCP tool — the single write path

**Priority rule**: if prior sessions exist and the question involves past implementation, changes, or decisions, query mnemo first (recall → timeline → mnemo-replay). Reading source is second-best; speculation is last.

Preferred workflow:
1. `recall()` to browse recent memory or `recall(query=...)` / `recall(time=...)` to narrow.
2. `timeline(id="S<n>")` to see the session's shape - decision arc, gaps, phases.
3. `recall(id="S<n>/T<m>", depth="expanded")` to zoom into a specific turn's content.
4. Use the `mnemo-replay` skill only when exact wording or full tool output matters - the `raw:` line in an expanded recall or timeline result is your hand-off.
</claude-mnemo-context>
