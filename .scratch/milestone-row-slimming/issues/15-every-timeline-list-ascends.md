# 15 — Every timeline list ascends

**What to build:** user ruling 2026-08-28 [S15069/T1925] ("timeline应该都是
时间升序吧"): the timeline is the narrative axis, and every list it renders
reads oldest-first. Two lists were still descending — the declared-lane
listing (`E<n>/L*`, newest-first since D8) and the per-lane island trees
(newest-root-first, ticket 13 decision 1, a convention leaked in from the
lane list). Both flip to ascending.

**Blocked by:** 13 (landed).

**Status:** resolved — implemented INLINE by the reviewer (small comparator
flip; landed as `d892205`) rather than dispatched. Both comparators ascend;
`[L<n>]` ordinals shift, which is legal — they were always render positions,
never stable addresses. Four order-pinning tests flipped to the new ruling;
suite 3970/0 after rebuild; reviewer mutation reverting the island comparator
to descending turned 3 tests red, restored byte-identical (md5), green.

**Side effect that dissolved the ticket-13 residue:** a lane's zero-edge
singleton islands (freshly noted turns settlement has not reached) are its
newest members, so ascending sinks them to the BOTTOM and the real trees
lead — the milestone-design wall of ~30 one-line islands ahead of its
38-member tree is gone without a dedicated `unlinked:` fold. The fold idea
is retired unless the flood reappears in some other shape.

## Acceptance criteria

- [x] Lane list `E<n>/L*` orders oldest-first by newest-member epoch,
      memberless lanes by declaration epoch, tag tiebreak — asserted
      (flipped test in timeline.lane-view.test.ts).
- [x] Islands within a lane ascend by root order — asserted (flipped
      two-island test; crossing-edge tests' island indices flipped).
- [x] Real-DB render: L1 is now the OLDEST lane (rule-ledger 07-28);
      milestone-design's singletons render after its main tree.
- [x] Mutation-verified (descending revert → 3 red, restore → green).
- [x] `tsc` clean, rebuild, suite 3970/0.
