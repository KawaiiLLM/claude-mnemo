# 11 — The settlement agent is told what it still owes, and sees what the main agent sees

**What to build:** An agent that tries to stop with gaps is handed the list and continues; and changing the main agent's injected context no longer requires a second, divergent edit for the subagent.

**Blocked by:** 10

**Status:** ready-for-agent

- [ ] A Stop hook runs the coverage predicate and blocks with the gap list, at most twice
- [ ] The job-completion gate re-checks independently and leaves the job claimed when it fails
- [ ] The main agent's injection is assembled by one entry point that both the SessionStart hook and the settlement agent call
- [ ] The settlement context renders window turns through recall's collapsed view rather than a private renderer
- [ ] Full suite green
