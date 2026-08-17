# ADR-0006 — The session keeps one field; attachment injects Working State first

**Status:** accepted · 2026-08-17 · source: S15069 T824 (grill round 3)

The session's seven semantic fields reduce to `title` — a one-line episodic label,
lazily written by the main agent, auto-draftable from the first attached segment.
Everything else a browser needs is composed from the attached-segment list, the
turns, and computed statistics. The per-session summary agent — the system's
largest cost sink — retires with the fields. Alternative kept open and rejected: a
free-form `desc` for taskless chat sessions was judged another citation-free text
with no reader.

Injection: `remember(attach)` returns the segment's full fields as its tool result
(cache-safe by construction — no floating channels, per the hook-channel red line).
At SessionStart a session with existing bindings gets **one block per attached
segment, 2000 tokens each** — and the block is not a dedicated renderer but the
composition of the two readers' own outputs: `recall(id="E<n>")` collapsed for the
segment's fields (1000) plus `timeline(id="E<n>", view="milestones")` for the
member spine (1000). Milestone rows admit only turns the segment's state cites or
A-tier turns; the turn view stays every member in event order. **RecentSessions and the diary index retire from
SessionStart** — the task axis replaces the session axis there. Roster follows the
segment blocks, proposals last. Context cost scales with the attachment count, so
the user throttles it by attaching narrowly. The rejected alternatives —
summary-only at start, or everything on demand — reintroduce "not knowing to ask"
exactly where passivity is the point.
