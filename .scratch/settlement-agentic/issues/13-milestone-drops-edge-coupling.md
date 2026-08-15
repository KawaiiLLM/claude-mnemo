# 13 — An edge annotates; it does not move a grade

**What to build:** A turn whose one sub-conclusion was overturned stops losing its whole grade to a mechanical rule, and the grader's judgement stands.

**Blocked by:** 05

**Status:** ready-for-agent

The mechanical rule existed to compensate for a grader that could not see the arc. Removing it changes rendered output, so this is a behaviour change with a wide observable surface, not a refactor.

- [x] Victim demotion and corrector promotion are removed, along with the two selection branches that made a victim ineligible to anchor
- [x] The `supersededBy` back-link rendering survives — edges drive display, not score
- [x] The derived grade layer SURVIVES: collapsing it into the stored grade is out of scope, because 67% of turns have no stored grade and pre-cutoff turns are scored through a type map instead
- [x] The one ranking key that reads the retired `rolled-back` type value moves to an inbound-edge test
- [x] Rendered output changes are stated in the ticket's closing note, not discovered by a reader
- [x] Full suite green

## Closed

### Rendered-output changes

- A superseded turn keeps its stored grade and can anchor: the design-arc golden goes from `T1(G4) / T5(G3) / ↳T2(G2) / ↳🚫T3(G1)→被T5推翻` to `T1(G4) / T3(G3) / ↳T2(G2) / T5(G3)`.
- **A main row now renders the `→被T<n>推翻` back-link.** `KeptMilestone` carried `supersededBy` all along but only the ↳ path rendered it, which was invisible while a victim could reach a main row only through the endpoint bullet. Leaving it would have deleted the back-link from output for the common case — the regression H3 exists to forbid.
- Two extra main rows appear in the mixed-era fixture: `isVictim` gated the WHOLE always-keep function, so removing it also un-suppresses the endpoint, reversed-marker and era-G4 bullets for a victim that independently qualifies.
- A shared antecedent re-homes: pull-through files it under its earliest KEPT citer, so a former victim becoming keepable takes its antecedent with it.
- Inside a grade tier, a victim can now outrank a peer on in-degree tie-break — contention it was structurally excluded from before.

### What survived, and why it looked removable

`graph.correctors → alwaysKeep` is a structural display decision, not a grade move, so it is outside H1's two named branches. `milestoneEffGrade`/`legacyEffGrade` are the surviving derived layer and carry no edge terms. The `supersededBy` map is still built, for rendering. The legacy inline-citation adapter constructs the graph rather than moving grades.
