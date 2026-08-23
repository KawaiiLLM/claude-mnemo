# 05 — Teaching sweep: tool descriptions, skill docs, CONTEXT, ADR closure

**What to build:** every teaching surface describes the shipped election and
lane states, so no cached doc teaches the retired chain:

- the timeline tool description and the plugin's mnemo-timeline skill doc
  describe the lane-first election (identity tiers, elected-only ↳, recent-N
  degradation) instead of effGrade selection;
- CONTEXT.md gains/updates: lane (v2 definition), closed/open/valid, election;
- ADR-0009's open scoring-trio item closes with the ruled outcome;
  scoring-rulings.md gets a closure note naming the supersessions (consume
  credits, narrows credits, override/refutes = candidacy kill, out-degree =
  tie-break only).

**Blocked by:** 03 — views integration (teaching follows shipped behavior).

**Status:** done (sweep grep re-run clean by the main agent; 43 guard tests green)

- [ ] No teaching surface mentions effGrade-based milestone selection or the
      always-keep chain as live behavior (grep sweep evidence in the report)
- [ ] CONTEXT.md entries match the spec's definitions verbatim where they are
      definitions
- [ ] ADR + scoring-rulings closure notes cite the ruling turns
