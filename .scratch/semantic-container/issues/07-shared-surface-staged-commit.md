# 07 — Shared tool surface with staged apply

**What to build:** The settlement subagent uses the main agent's quartet — note, remember, timeline, recall — with write staging: nothing applies until `commit`, which replaces the retired `check` as the closing act. The existing staged-commit machinery widens from settlement-only facades to the general subagent write contract; the dedicated facades retire. Reads are live; writes stage; a commit applies atomically or reports what failed. ADR-0007.

**Blocked by:** 02 — remember tool (the surface being staged); 06 — settlement election (the writes that ride the batch).

**Status:** ready-for-agent

- [ ] A subagent note/remember write is invisible to a parallel reader until commit, then fully visible
- [ ] check no longer exists as a tool; commit closes the batch and returns per-write results
- [ ] The retired facade surfaces are gone; one contract change now edits one tool definition
- [ ] Mutation check: removing the staging interception makes the isolation test fail
