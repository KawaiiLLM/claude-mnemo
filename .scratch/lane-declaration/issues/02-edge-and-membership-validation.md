# 02 — A tagged edge must name a declared lane at every endpoint, and membership writes must keep it true

**What to build:** writing a tagged edge consults the registry: the tag must be declared in the segment of EVERY endpoint turn. A cross-segment edge is legal exactly when both segments declared that tag; a homeless endpoint is never legal. The same check runs on every path that MOVES a turn between segments, in the same transaction, so an edge cannot become illegal without an edge write.

**Blocked by:** 01.

**Status:** done — 15 mutations by the implementer, 3 re-run independently on acceptance

## Decisions taken during implementation

- **`TAG_MANDATORY_RELATIONS` is DELETED, not emptied.** An exported empty set plus an `isTagMandatoryRelation` predicate and a `tag-required` branch that can never fire is the same stale-teacher hazard the ticket exists to remove, in constant form. The rubric has no mandate concept to mirror. Accepted.
- **`TAGGABLE_RELATIONS` survives, widened to all eight, and is no longer inert.** It had become a tautology no gate consults — its mutation reddened only its own vocabulary test. It now has a real reader: `tests/shared/memory-rubric.test.ts` asserts every word the rubric teaches as taggable is taggable at the gate, so a narrowing on either side surfaces as a test failure instead of as a settlement run refused for doing what it was taught. Narrowing it back to five words reddens that cross-check.
- **`ReassignSegmentMembersResult` became a discriminated union.** A refusal a caller can ignore by reading `addedTurnIds` off the old shape is a gate in name only; `tsc` then found five call sites, one of which (`remember`'s create-seed) was discarding the result entirely — a silent bypass.
- **The membership gate reports the DELTA, not absolute stranding.** An edge already undeclared before a move does not veto an unrelated reassignment, or legacy stock would deadlock exactly the repair moves that fix it.
- **The gate runs INSIDE `reassignSegmentMembers`, before the delete** — which is why "leaves `segment_members` byte-identical" needs no transaction: there is no partial state to unwind.
- **Left alone deliberately:** `lane-checker-load.ts`'s untagged-stance pass. It was built for E1, but its rows are `LANE_COMPONENT_RELATIONS` bridges that ticket 09's unattributed-cluster domain needs; dropping it would starve 09 while looking like cleanup.
- **`note`'s tool description is at 419/420 estimated tokens.** The lane sentence only fit by trimming unrelated wording. The next teaching addition needs the cap raised or a real cut.

Spec: `.scratch/lane-declaration/spec.md` (Rev 2) — D2, including the "enforced at every membership write, not only at birth" paragraph (peer finding P1-2).

- [ ] Per tag, in order, each refusal naming the gap: (1) canonical form; (2) declared in EVERY endpoint's segment; (3) the existing subset invariant (the tag is on both endpoint turns' own `tags`) — unchanged.
- [ ] A homeless endpoint refuses with a message that says which turn has no segment.
- [ ] A cross-segment edge whose tag is declared on BOTH sides is accepted; declared on only one side is refused, naming the segment that is missing the declaration.
- [ ] Both write paths are covered: the main agent's `note` and settlement's own write facade.
- [ ] `assign`, ownership-clearing, settlement's reassignment and any member-seeding path re-check the incident tagged edges of every turn they move and refuse — whole transaction, nothing left behind — when the move would leave an edge undeclared on some side. The refusal names the edges and the missing declaration.
- [ ] Test: A and B in E60 share a lane edge; moving A to E67 refuses; declaring the same lane in E67 first makes the move succeed.
- [ ] Test: the refusal path leaves `segment_members` byte-identical (no partial move).

**Added by [S15069/T1548] — the tag mandate is withdrawn in the same ticket:**

- [ ] `extends`/`narrows` no longer REQUIRE a lane tag. The bare-address form is accepted for all eight words; the tagged form stays available and keeps every rule above.
- [ ] Lane ownership moves to settlement: the main agent's `note` may carry lane tags but is never required to, and its field descriptions SAY so in those words. Settlement's own facade keeps full authority — including `declare`/`undeclare`, which its `remember` facade must accept.
- [ ] Every teaching surface that currently states the mandate is updated with it (the note tool description, the settlement note description, and any prompt copy that repeats it) — a stale teacher produces calls the gate no longer needs.
- [ ] The tests that pinned the mandate are REPLACED by tests pinning the new permission, in the same place, so a reader learns the current rule where they used to learn the old one.

**Added by [S15069/T1562] — every word may carry a lane tag, and an edge may carry several:**

- [ ] `TAGGABLE_RELATIONS` (shared/turn-phase.ts) widens from the five same-phase words to ALL EIGHT. A lane is no longer a phase-local concept: a tagged `grounds`/`verifies`/`refutes` is how a lane continues across a phase boundary, which is what makes a design→delivery line ONE lane instead of two hinged halves. `TAG_MANDATORY_RELATIONS` becomes empty.
- [ ] Both constants' doc comments are rewritten, not merely re-pointed: they currently argue at length for the retired rule ("a lane is a phase-local concept", "naming the line is what continuing one means"). A comment that argues for the opposite of the code is worse than none.
- [ ] One edge may carry SEVERAL lane tags, meaning the lanes converge there — already true of the storage, now true of the vocabulary. The subset invariant applies per tag, unchanged.
- [ ] The checker's own relation sets follow: a lane's DAG, its chain and its path report admit the cross-phase words when they carry the lane's tag. Name every set you touch in the report, with the reason.
- [ ] The `note` and settlement write facades accept the tagged form for all eight words, and their descriptions say so. The refusal that used to name "cross-phase words never carry lane tags" is deleted, and a test pins its absence.

**Added by [S15069/T1567] and the peer's Rev 3 round:**

- [ ] A SELF edge (citing and cited are the same turn) refuses a tag, naming why: a tag names a lane, and a one-node self-loop is not one (a lane has at least two nodes). This closes the peer's P1-3 — with all eight words taggable, a tagged self-`grounds` would otherwise enter the lane's DAG as a self-loop that the checker's source/sink report reads as 0/0 and passes in silence.
- [ ] Retiring the mandate means retiring the WHOLE E1 chain, not two constants: `lane-checker.ts`'s own `MANDATED_LANE_RELATIONS`, the E1 error's computation and renderer, the settlement commit gate that treats E1 as blocking, the tool descriptions and prompt copy that state the rule, and the tests that pin it. Emptying `TAG_MANDATORY_RELATIONS` alone produces "the write path accepts it and settlement then refuses it" (peer P1-2).
- [ ] Two rows for the same (pair, relation) whose tag sets INTERSECT are refused on write — `extends{a}` then `extends{a,b}` currently both persist under the exact-set unique key, and lane `a` then reads the same logical edge twice, double-counting edge totals, milestone in-degree and console edges (peer P1-4). The way to widen an existing edge's lanes is retract-and-rewrite with the union.
