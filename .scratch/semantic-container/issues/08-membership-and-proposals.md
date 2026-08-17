# 08 — Membership assignment + homeless proposals

**What to build:** During settlement the subagent assigns each substantive turn to one of the session's attached segments, tags as the primary signal; turns fitting nothing stay homeless (legal). When a homeless cluster looks like one task, the subagent emits a text proposal — turn addresses + a suggested title + a reminder to ask the user — stored for the next session's injection; never a database segment, never auto-adopted. At most three proposals surface, newest first.

**Blocked by:** 06 (the settlement pass it rides); 07 (the write surface it uses).

**Status:** ready-for-agent

- [ ] Assignment only ever targets the session's attached segments; a turn matching nothing stays homeless
- [ ] A proposal stores addresses + title + reminder as text, renders at most three, and creates no segment row
- [ ] remember(create) with the proposal's addresses seeds exactly those members (adoption path, from ticket 02)
- [ ] System-namespaced tag values never influence assignment
- [ ] The settlement report flags summary-layer claims contradicting member turns, never rewriting them (ADR-0004 — criterion added at review; a ticket-drafting omission, the spec always carried it)
