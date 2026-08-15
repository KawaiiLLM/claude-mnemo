# 06 — A body owns its citations, including when they leave

**What to build:** Writing `[S/T]` in a note, segment or session field creates the edge. Rewriting that body without the reference removes it. No caller can create an edge out of nothing.

**Blocked by:** 01, 05

**Status:** ready-for-agent

Edges are additive-only today with no delete path anywhere, so a segment whose content is overwritten leaves its old edges behind forever.

- [x] A bare `[S/T]` in any citation-bearing field creates an unattributed pair
- [x] Writing a node re-reads all its citation-bearing fields after the write, recomputes that node's pair set, and deletes pairs no field supports any more
- [x] A rewrite that drops a reference drops its pair and any relation on it
- [x] The generic body-free structured edge write is removed, not inherited by the merged tool
- [x] A test reproduces the rewrite-drops-citation sequence rather than asserting the delete exists
- [x] **`cites_recorded` stops being able to hide a stored edge.** Measured on the live database: 353 turns hold edges in `memory_edges` while carrying `cites_recorded = 0`, and 350 of those have no inline `[T<n>]` in their prose either — so the effective-citations reader consults neither source and reports them as citing nothing. All 383 such edges are `judged`, i.e. settlement-written, and `cites_recorded = 1` is set in exactly one place in the codebase, the main-agent citation path. Settlement's edges are therefore write-only today
- [x] Full suite green

## Resolved: the gate is gone, both sources union

User ruling. `getEffectiveCitations` and its batched form now always read the edge table AND always parse the prose, unioned by target id, and `cites_recorded` participates in nothing. Restoring a setter was rejected: the flag conflates "a writer enumerated this turn's citations" with "this turn has structured edges", so any setter would eventually lie, and after this ticket both sources derive from the same body — the union cannot invent a pair, and a rewrite that drops a reference removes it from both at once. Correctness now follows from what is in the tables at read time rather than from a bit somebody had to remember to set. The column survives as inert history.

One capability is deliberately given up: a writer can no longer retract prose by recording an authoritative empty set. Nothing needs it once bodies own pairs.

Measured before landing, correcting a claim that this was a no-op — it is not. Of 838 historical flagged turns, **135 gain citations, 185 ids in all**. Sampling three showed them to be real prose links the structured writer had failed to record (T212→T211, T216→T212 and similar), so the union recovers causal edges rather than adding noise. The pre-segment arc golden fixture gained a `↳ T13` row for exactly this reason.

## The `cites_recorded` conflation, stated before it is designed away

The flag answers "did a writer enumerate this turn's citations authoritatively", and the reader treats `1` as "the edge set is complete, an empty set means genuinely no citations". Flipping it to `1` whenever any edge is written would be the wrong repair: a turn whose prose cites three targets and whose settlement pass recorded one would then read as citing exactly one, silently losing two. The flag cannot express "some structured edges, plus prose that may hold more", and that gap is what this ticket removes by making the body the source of truth. Whatever replaces the flag has to answer for both populations — the 785 turns the main-agent path enumerated, and the 353 it never spoke for.

Found while triaging an independent review's adjacent false positive (a claim that the legacy fold-in strands `cites_recorded`; it does not — 0 of 785 citing turns are in that state, because the legacy writer set the flag in the same transaction).
