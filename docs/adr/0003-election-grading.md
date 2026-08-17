# ADR-0003 — Grading is a three-tier election at settlement, seats as ceilings

**Status:** accepted · 2026-08-17 · source: S15069 T816–T818

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
