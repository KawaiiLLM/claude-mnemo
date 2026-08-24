# 12 — A lane's own graph is defined by its tag, not by a list of relation words

**What to build:** every lane-shaped question — membership, component, path, chain — asks "does this edge carry THIS lane's tag", not "is this relation word in some set". Adding the three cross-phase words to three string sets does not work: the checker treats `grounds` as an external bridge and `timeline` filters it out of chains, so a lane made of tagged `grounds` edges renders severed while untagged cross-phase edges would start polluting components.

**Blocked by:** 03 (shipped).

**Status:** done — mutation-verified on acceptance (five mutations, five distinct reds)

Peer finding P1-7. Spec Rev 3, D2's last paragraph.

- [x] An edge-level predicate replaces the relation-set membership test in the lane's own graph. **Membership turned out never to have been broken**: `deriveLaneInterpretation`'s grouping loop already keyed on `edge.tags` alone and never on `edge.relation`, so it was the predicate all along — untested at that layer, though, so the gap was a test not a fix.
- [x] The EXTERNAL structure keeps its own domain. **Two predicates, ORed, never one widened word-set**: `LANE_COMPONENT_RELATIONS` stays tag-agnostic and unwidened; the new clause at its call site is "carries some lane's tag AND is not indexes/override". Widening the constant instead is the naive move the ticket rejects, and it reddens five tests.
- [x] The three constants and the SQL loader re-derived rather than extended by three strings. `LANE_PATH_RELATIONS`/`LANE_CHAIN_RELATIONS` are literally `EDGE_RELATIONS` minus exclusions. **The loader needed no change** — `loadTaggedEdgesTouching`/`loadEdgesForTag` filter on the tag column and never on the relation word — verified with a regression test rather than assumed.
- [x] `indexes` still does not participate in connectivity, now pinned on BOTH halves (a gap: only the path side had a test).
- [x] Failure case pinned at four seams: membership, component, path, declared-path.
- [x] Timeline chain admits a tagged cross-phase edge as an ordinary hop. **Arrow: the plain `->`** — `=>` stays reserved for `indexes`, the declaration, which is the one thing the arrow shape is carrying meaning about.

**File ownership:** `src/shared/lane-checker.ts`, `src/shared/lane-interpretation.ts`, `src/db/lane-checker-load.ts`, `src/mcp/timeline.ts`, and their tests. NOT `src/shared/milestone-election.ts` or `src/worker/console-*` (ticket 11, parallel), NOT `src/mcp/note.ts` / `remember.ts` / `definitions.ts` (ticket 02, later).
