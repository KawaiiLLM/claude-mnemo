# 13 — An edge annotates; it does not move a grade

**What to build:** A turn whose one sub-conclusion was overturned stops losing its whole grade to a mechanical rule, and the grader's judgement stands.

**Blocked by:** 05

**Status:** ready-for-agent

The mechanical rule existed to compensate for a grader that could not see the arc. Removing it changes rendered output, so this is a behaviour change with a wide observable surface, not a refactor.

- [ ] Victim demotion and corrector promotion are removed, along with the two selection branches that made a victim ineligible to anchor
- [ ] The `supersededBy` back-link rendering survives — edges drive display, not score
- [ ] The derived grade layer SURVIVES: collapsing it into the stored grade is out of scope, because 67% of turns have no stored grade and pre-cutoff turns are scored through a type map instead
- [ ] The one ranking key that reads the retired `rolled-back` type value moves to an inbound-edge test
- [ ] Rendered output changes are stated in the ticket's closing note, not discovered by a reader
- [ ] Full suite green
