# 02 — A tagged edge must name a declared lane at every endpoint, and membership writes must keep it true

**What to build:** writing a tagged edge consults the registry: the tag must be declared in the segment of EVERY endpoint turn. A cross-segment edge is legal exactly when both segments declared that tag; a homeless endpoint is never legal. The same check runs on every path that MOVES a turn between segments, in the same transaction, so an edge cannot become illegal without an edge write.

**Blocked by:** 01.

**Status:** ready-for-agent

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
