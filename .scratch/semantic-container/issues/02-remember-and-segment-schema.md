# 02 — remember tool + segment state schema

**What to build:** The main agent can create a segment, attach it, append a decision row and replace a stale one — end to end. Schema: six Working State columns on segments (goal, constraints, decisions, done, next_steps, reference — markdown row lists, rows carrying [S/T] citations), plus the session↔segment binding table (rows accumulate, no detach, consulted-only legal), following the repo's 12-step SQLite rebuild discipline. Tool: `remember` with `create` (accepts seed member addresses from an approved proposal), `attach` (returns the segment's fields; provisional plain render until ticket 03 swaps in the canonical card), `append`, `replace(old,new)` (ambiguous or vanished old_string rejects loudly). Receipts report turns-since-last-maintenance both ways (under-10 reminder, single nudge at 20); decisions appends exempt. ADR-0001/0002/0005.

**Blocked by:** 01 — Note contract revision (shared definitions surface).

**Status:** ready-for-agent

- [ ] Migration adds the six columns and binding table; migration test proves existing production-shaped data survives the rebuild
- [ ] create/attach/append/replace round-trip at the MCP seam; replace with a non-unique or missing old_string rejects with a readable error
- [ ] create with seed addresses records membership for exactly those turns
- [ ] Receipts carry turns-since-last-maintenance; a decisions append is exempt from the cadence reminder
- [ ] Mutation checks on the replace guards and the seed-member write
