# ADR-0003 — Grading is a three-tier election at settlement, seats as ceilings

**Status:** superseded 2026-08-19 (was accepted · 2026-08-17) · source: S15069 T816–T818

> **Superseded** by the ownership-and-note-cadence spec + the turn-edge-
> mechanism spec (edge-ownership-impl tickets 05/06). Settlement's duty 1
> (election/grading) retired outright — settlement no longer assigns a tier
> OR a grade to any turn (ticket 05, "所有权归位": settlement's structured-
> field authority is exactly type/tags/membership/edges, none of them a
> value judgement). The election storage half (the `turns.election_tier`
> column, `src/election.ts`, `src/election-era.ts`, the seat-ceiling
> completion check) is deleted (ticket 06, "选举机器拆除") — the era cutoff
> was never pinned in production, so the tier this ADR designed never
> carried real data. `significance_grade` and its legacy rendering are
> UNRELATED to this ADR's own tier mechanism and stay exactly as they were,
> byte-identical — see `.scratch/turn-edge-mechanism/spec.md`'s "Legacy 政
> 策". Importance, where it is judged at all going forward, comes from the
> turn-edge mechanism (`.scratch/turn-edge-mechanism/spec.md`) — edges, not
> an election.

## Context

Absolute in-band scoring measurably carries no ordering signal: the 2026-08-04
null-result experiments found production scores taking 3–15 distinct values with
93–100% of rows in tie groups — time order was doing the real ranking. Extraction-
era grading drifted (grades 2/3 at 2× baseline, grade 1 starved) until a
discriminator plus mandatory regrade contained it. Main-agent self-grading adds a
juror-in-own-case bias, and the grade parameter's description never contained the
rubric at all.

## Decision

- The grade parameter **leaves the note tool**. The writer records facts; the
  settlement subagent assigns value.
- Grading is a **差额选举**: three tiers A/B/C per settlement window, at most
  `floor(10%·N)` A and `floor(30%·N)` B seats (5 and 15 at N=50). **Seats are
  ceilings, not targets** — a flat window elects fewer. Ranking criterion, one
  line: how much does this task's future depend on this turn?
- Third grading semantics, so **era-gated** like the last change: A/B/C never
  mixes with legacy 0–4 reads.
- Partition decouples from grades (ADR-0001): election ranks importance only.
- **Citation-derived grading** (grade = highest state field citing the turn, over
  `memory_edges`) runs as a zero-cost parallel experiment arm: settlement elects
  while the maintained Working State accrues citations; compare A-tier agreement,
  eyeball the disagreement set leakage-aware (judges never see the other arm's
  output — the 2026-08-04 annotation-leak lessons apply).

## Consequences

- Distribution constraints need no external quota machinery in the citation arm:
  state budgets make citations scarce by construction.
- Turns between write and settlement carry no tier; importance is retrospective by
  design.
