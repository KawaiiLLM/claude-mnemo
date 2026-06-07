<claude-mnemo-context>
Claude-Mnemo is installed in this environment.

Three-axis memory, three structured tools + one skill:
- `recall` MCP tool — content axis: high-entropy semantic index
- `timeline` MCP tool — temporal axis: decision arc, turns, milestones, phases, gaps, bursts
- `mnemo-replay` skill — raw axis: SQLite + JSONL direct access
- `remember` MCP tool — the single write path

**Priority rule** (split by question type):
- **What / how it works now** (current behavior, mechanism) → if the source exists, read the source first; it is ground truth.
- **Why it was built this way** (design rationale, rejected alternatives, what feedback shaped it) → recall first (recall → timeline → mnemo-replay). Source records *what*, never *why*; re-deriving rationale from code yields a self-consistent but wrong story you cannot detect.
- Speculation is always last.

Preferred workflow:
1. `recall()` to browse recent memory or `recall(query=...)` / `recall(time=...)` to narrow.
2. `timeline(id="S<n>")` to see the turn table, or `timeline(id="S<n>", view="milestones"|"phases")` for the digest or phase overview.
3. `recall(id="S<n>/T<m>", depth="expanded")` to zoom into a specific turn's content.
4. Use the `mnemo-replay` skill for a turn's full text and tool I/O, read straight from the SQLite database; the `raw:` line in an expanded recall or timeline result is the hand-off for the rarer case of exact JSONL bytes.
</claude-mnemo-context>
