# 02 — indexes scores into the curation key

**What to build:** being INDEXED credits the target: the election/milestone
curation signal that today reads `grounds` in-degree also counts `indexes`
in-degree (ruled S15069/T1240 — aggregation credits its targets, the
encodes-curation lineage). A settlement's carried members and a release's
shipped artifacts gain the signal; every other key (override zeroing, extends
excess, recency) is untouched. Spec: `.scratch/indexes-rescope/spec.md`.

**Blocked by:** 01 (the word must exist).

**Status:** ready-for-agent

- [ ] The scored-relation table marks `indexes` scored; the compile-time
      exhaustiveness stays.
- [ ] The curation in-degree signal counts grounds + indexes together; a turn
      cited only by `indexes` now carries the signal (test proves it), and a
      turn cited by both does not double-count per citing pair beyond the two
      real edges.
- [ ] Milestone/election consumers need no code change beyond the signal
      (verify by test, not assumption); unscored words still score nothing.
- [ ] Full suite green except the standing stale-bundle guard red.
- [ ] Report the one load-bearing property for mutation verification.

Ownership: yours — src/db/edge-signals.ts (coordinate: ticket 03 may have
landed a shared liveness predicate there; build on landed HEAD, do not revert
it), the scored-relation constant's home, their tests. NOT yours — flows,
citations, note surface, rubric.
