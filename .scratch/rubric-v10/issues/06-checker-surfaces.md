# 06 — Checker surfaces: CLI digraph for humans, tool entry for settlement

**What to build:** two thin renderers over the ticket-05 core, deriving nothing themselves. (a) A CLI that prints the four reports plus a git-log-graph-style text digraph (turn order top-down, one-level branch wiring, deeper crossings as reference lines; glyphs for member/terminus/dead/finding) — human-only. (b) A tool entry handed to the settlement agent returning the numeric reports (no digraph); the settlement prompt gains one line: run the checker over the settled scope AFTER first-pass writes, findings enter the existing supply/correct/propose judgment; the runtime notes a missing checker call as a reminder, never a block.

**Blocked by:** 05 — Interpretation core and the four-report checker (prompt wording references ticket 03's rubric language where applicable).

**Status:** ready-for-agent

- [ ] CLI renders all four reports and the digraph for a segment scope and for named lanes; output stays within terminal width.
- [ ] The settlement tool returns compact numeric reports; the digraph never reaches the agent.
- [ ] The settlement prompt carries the post-first-pass call instruction; a run without the call logs a reminder and completes normally.
- [ ] Both surfaces call the identical core; a semantic change in the core needs no renderer change to propagate.
