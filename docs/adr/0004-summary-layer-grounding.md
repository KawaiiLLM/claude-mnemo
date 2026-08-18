# ADR-0004 — The summary layer is grounded by citations and flagged by settlement

**Status:** amended 2026-08-19 (flagging half retired, see below) · accepted 2026-08-17 · source: S15069 T824 (grill round 1)

## Context

ADR-0002 gives the main agent every segment field; ADR-0001 makes `content`/`insight`
the layer outsiders read. The combination lets the worker write its own report card
with no correction path — settlement no longer touches segment fields, so nothing
would stop a `content` claiming "revision complete and verified" that no turn
supports.

## Decision

Two guards, neither adds a writer:

1. **Citation floor** — every claim row in the summary layer carries an [S/T]
   citation, mechanically checked by the same machinery as turn notes (C6).
   Self-praise must point at a real turn to exist.
2. **Settlement flagging** — the settlement pass, which already reads the window's
   turns, checks attached segments' summary layers against their member turns and
   **flags** contradictions or unsupported claims in its report; it never rewrites.

## Consequences

- The citation discipline becomes load-bearing for three systems at once: summary
  grounding, the citation-derived grading arm (ADR-0003), and decisions-row
  staleness via `supersedes` edges.
- A flagged summary is repaired by the main agent through `remember` — the single
  writer stands.

## Amendment (2026-08-19)

Decision 2 (settlement flagging) is **retired** by the edge-ownership redesign
([S15069/T906]): settlement now reads only the segment roster (id/title/topic),
never a segment's summary layer, so it has nothing to check `content`/`insight`
against. Decision 1 (the citation floor) stands, mechanically enforced as before.
Note ADR-0003's grading arm is itself superseded — the citation discipline's
remaining load is summary grounding and edge-derived staleness.
