# 06 — A body owns its citations, including when they leave

**What to build:** Writing `[S/T]` in a note, segment or session field creates the edge. Rewriting that body without the reference removes it. No caller can create an edge out of nothing.

**Blocked by:** 01, 05

**Status:** ready-for-agent

Edges are additive-only today with no delete path anywhere, so a segment whose content is overwritten leaves its old edges behind forever.

- [ ] A bare `[S/T]` in any citation-bearing field creates an unattributed pair
- [ ] Writing a node re-reads all its citation-bearing fields after the write, recomputes that node's pair set, and deletes pairs no field supports any more
- [ ] A rewrite that drops a reference drops its pair and any relation on it
- [ ] The generic body-free structured edge write is removed, not inherited by the merged tool
- [ ] A test reproduces the rewrite-drops-citation sequence rather than asserting the delete exists
- [ ] **`cites_recorded` stops being able to hide a stored edge.** Measured on the live database: 353 turns hold edges in `memory_edges` while carrying `cites_recorded = 0`, and 350 of those have no inline `[T<n>]` in their prose either — so the effective-citations reader consults neither source and reports them as citing nothing. All 383 such edges are `judged`, i.e. settlement-written, and `cites_recorded = 1` is set in exactly one place in the codebase, the main-agent citation path. Settlement's edges are therefore write-only today
- [ ] Full suite green

## The `cites_recorded` conflation, stated before it is designed away

The flag answers "did a writer enumerate this turn's citations authoritatively", and the reader treats `1` as "the edge set is complete, an empty set means genuinely no citations". Flipping it to `1` whenever any edge is written would be the wrong repair: a turn whose prose cites three targets and whose settlement pass recorded one would then read as citing exactly one, silently losing two. The flag cannot express "some structured edges, plus prose that may hold more", and that gap is what this ticket removes by making the body the source of truth. Whatever replaces the flag has to answer for both populations — the 785 turns the main-agent path enumerated, and the 353 it never spoke for.

Found while triaging an independent review's adjacent false positive (a claim that the legacy fold-in strands `cites_recorded`; it does not — 0 of 785 citing turns are in that state, because the legacy writer set the flag in the same transaction).
