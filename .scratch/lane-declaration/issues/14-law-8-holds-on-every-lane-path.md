# 14 — A skipped or rewound turn is not a node, on the registry paths too

**What to build:** the rubric's Law 8 — "被 skip 或 rewind 的 turn 不是节点，不得作为边的端点" — holds wherever lane facts are produced, not only where they are read. Today the checker's loader filters dead endpoints on every pass while the migration and the undeclare guard do not, so the two sides disagree about which edges exist.

**Blocked by:** None — 01/04/09 shipped; this repairs them.

**Status:** done — mutation-verified per path, 3 re-run independently on acceptance

Peer finding, verified at HEAD. Three asymmetries, all in the same direction:

1. `classifyTaggedEdges` (M0) selects every tagged turn-edge with no join to `turns` and no liveness predicate, and M2 seeds the registry from what it classifies. An edge whose endpoint is skipped or rolled back therefore mints a real `lanes` row whose members no reader can see.
2. The proliferation warning counts the numerator as `COUNT(*) FROM lanes` and the denominator as LIVE members only. A lane with zero visible members inflates the ratio it is measured by and can trip a warning about work nobody can find.
3. `getEdgesByTag` — the `undeclare` guard's only source, and its only production caller — has no liveness filter, so an edge that exists in no graph still refuses the `undeclare` that would clear the lane. The repair path for the lane in (1) is blocked by the same edge that created it.

Measured read-only on production: **zero tagged edges with a dead endpoint today** (0 of 441). But (3) is not a migration-timing problem — it is a permanent runtime path. A lane declared and used normally, whose turns are later skipped, deadlocks the same way at any point after release.

- [x] M0 classifies only edges both of whose endpoints are live, by the same predicate the checker's loader uses — one shared predicate, not a second hand-written copy of it.
- [x] The `undeclare` guard consults only edges the checker can see. Decide whether the liveness filter belongs in `getEdgesByTag` itself or at the guard, and say why; the query has exactly one production caller today, so either is defensible and the reason is what matters.
- [x] Proliferation and the registry agree on what counts. State the rule you chose and its consequence: a lane with no live member is either excluded from the numerator, or reported as its own removable fact — silently inflating a ratio with invisible lanes is the one option that is out.
- [x] Tests: a tagged edge with a skipped endpoint seeds no lane; the same with a rolled-back endpoint; a lane whose members all died can be undeclared; the proliferation numerator behaves as your chosen rule says at the boundary.
- [x] Mutation-verify each declared property. The liveness predicate in particular: reverting it on each path must redden a test naming that path, not just the shared one.

## Decisions taken

- **The numerator stays `COUNT(*)`; empty lanes are NAMED instead.** Declare-before-use makes "no member yet" a lane's normal birth state, so excluding the memberless would exempt exactly the accumulation the budget exists to catch. The inflation is answered by naming the removable tags on the warning itself, which the undeclare repair (asymmetry 3) has only now made actually clearable. Reported only THROUGH the proliferation warning, never as a standing fact — an always-on empty-lane report would fire on every fresh `declare`.
- **The liveness filter sits at the guard, not in `getEdgesByTag`.** That query is the tag index's own read-back — its tests and `rebuildMemoryEdgeTagsIndex`'s round-trip read it that way — and it is kind-agnostic, so the filter could not be a plain join to `turns` without dropping every non-turn-endpoint row and mismatching a note id against a turn id. The graph question belongs one layer above the index.
- **Accepted consequence: a dead-endpoint tagged edge now enters NO M0 bucket, so M4 no longer disposes of it.** `skipped` is DORMANT and reversible, and `promoteTurnFromNote` restores a turn with its edges intact, so stripping the tag would destroy permanently what a reversible condition merely hid. See the open question below for what this leaves unanswered.
- **Found and left alone:** the `undeclare` guard has no `relation IS NOT NULL` filter while every checker pass requires one, so a bare relation-NULL row carrying tags could hold a lane open while appearing in no graph. Production has zero. The new empty-lane pass does require it.

## Open — needs a ruling before it becomes a ticket

Nothing reports a DERIVED lane the registry never declared. After this ticket a dormant illegal edge survives migration untouched; if its turn resurrects, its tag becomes a live derived lane with no declaration and no surface says so. The same hole covers ticket 13's un-canonicalizable tags and any pre-gate legacy row. One report — "this lane exists in the graph but not in the registry" — would subsume all three, and is a new report class rather than a patch.
