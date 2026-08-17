# ADR-0005 — Attachment injects the segment; the roster has no state machine; legacy freezes

**Status:** accepted · 2026-08-17 · source: S15069 T824 (grill round 2)

## Context

Attachment needed exact semantics (working set or lifecycle object?), the roster
needed an answer to unbounded container growth, and 47 legacy arc-segments with
893 members and 0–4 grades needed a disposition. Old segment statuses
(`open`/`delivered`) are arc semantics, retired with the arc (ADR-0001).

## Decision

- **Attachment** is the session referencing segments as its working memory —
  binding rows accumulate, no detach, no expiry. Attaching **injects the
  segment's fields** into the session's context. Membership stays a content
  question (tags the primary signal); settlement assigns within the loaded set
  and proposes only when nothing fits.
- **Within a segment, member turns are ordered by event time** — the segment is a
  renderable axis: recall and timeline can render one task's member turns
  chronologically across sessions.
- **Roster:** no status machine. Ordered by recency of last member or state edit,
  budget-truncated, overflow reachable via recall. A finished task is manually
  `close`d through `remember` and leaves the roster. Zero new parameters, zero
  automatic transitions.
- **Migration:** legacy arc-segments freeze as-is — readable via recall, absent
  from the roster. New containers start empty; tasks worth continuing are adopted
  selectively by the user/main agent via `remember(create)` with seed addresses.
  Fragmented legacy topics never pollute the new layer. Legacy 0–4 grades stay
  era-gated (ADR-0003).

## Consequences

- The session's own semantic fields lose their last consumer; their redesign is a
  follow-on decision (grill round 3).
- Injection composition on attach (which layers, what budget) is spec detail:
  attach-time tool results are cache-safe by construction; SessionStart re-injection
  for existing bindings must fit a budget.
