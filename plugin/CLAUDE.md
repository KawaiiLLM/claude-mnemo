<claude-mnemo-context>
Claude-Mnemo is installed in this environment.

Three-axis memory, three structured tools + one skill:
- `recall` MCP tool — content axis: high-entropy semantic index
- `timeline` MCP tool — temporal axis: decision arc, turns, milestones, gaps, bursts
- `mnemo-replay` skill — raw axis: SQLite + JSONL direct access

Two write tools, one each: `note` writes a turn's own note (title, content, insight, type, tags), `remember` maintains a segment and its lanes. Edges are written by settlement, never by hand.

**Priority rule** (split by question type):
- **What / how it works now** (current behavior, mechanism) → if the source exists, read the source first; it is ground truth.
- **Why it was built this way** (design rationale, rejected alternatives, what feedback shaped it) → recall first (recall → timeline → mnemo-replay). Source records *what*, never *why*; re-deriving rationale from code yields a self-consistent but wrong story you cannot detect.
- Speculation is always last.

Preferred workflow:
1. `recall()` to browse recent memory or `recall(query=...)` / `recall(time=...)` to narrow.
2. `timeline(id="S<n>")` to see the turn rows, or `timeline(id="S<n>", view="milestones")` for the key-turn digest.
3. `recall(id="S<n>/T<m>")` to zoom into a specific turn's content — raise the `turn` token budget for more of it.
4. Use the `mnemo-replay` skill for a turn's full text and tool I/O, read straight from the SQLite database; the `raw:` line in a recall or timeline result is the hand-off for the rarer case of exact JSONL bytes.
</claude-mnemo-context>
