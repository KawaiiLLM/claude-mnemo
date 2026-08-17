# 09 — Session retirement

**What to build:** The session keeps one semantic field: `title` (lazily written by the main agent through note, auto-draftable). The other seven session fields stop being written and stop rendering; the per-session summary agent retires entirely — no spawn, no cost. Session browse views compose from title, attached segments, and computed statistics. ADR-0006.

**Blocked by:** None — can start immediately.

**Status:** done — the summary agent was already fully retired in 0.11.0 (ticket 04); this ticket reduced to regression lock-in (spawn-suppression + queue-drain tests) plus the era gate on session semantic-field rendering. Attachments line deferred to tickets 02/10 as planned.

- [ ] The summary agent no longer spawns on any trigger; its schedule/queue entries drain harmlessly (the note(session) title-only parse rule moved to ticket 01 — shared definitions surface)
- [ ] recall(id="S<n>") renders title + attachments + stats with no dead-field gaps
- [ ] Legacy sessions with stored fields still render them behind the era (read-only, never written)
