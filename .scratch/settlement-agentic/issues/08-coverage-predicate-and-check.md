# 08 — One coverage predicate, and the agent can ask it

**What to build:** An agent can ask what it still owes before it believes it has finished, instead of discovering it at the moment it tries to stop.

**Blocked by:** 02

**Status:** ready-for-agent

One predicate, three callers, decreasing trust: the `check` tool pulled by the agent, the Stop hook pushed at stop, the completion gate server-side. Three implementations would drift, and drift resolves toward whichever is loosest.

- [ ] The predicate is a pure function: database in, gap list out
- [ ] An eligible turn with an empty field is a gap
- [ ] A skipped turn counts as covered — skip is itself a verdict, and a turn that cannot yield a type is a skip rather than a kept empty row
- [ ] Compact markers and slash commands needing no model reply are excluded; sidechain rows are included
- [ ] The predicate is exposed as a `check` tool reporting what is missing, never why
- [ ] The per-grade histogram is NOT in anything the grading agent can see, at any point in its run (spec G9)
- [ ] Full suite green
