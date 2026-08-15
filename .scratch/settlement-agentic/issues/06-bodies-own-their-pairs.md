# 06 — A body owns its citations, including when they leave

**What to build:** Writing `[S/T]` in a note, segment or session field creates the edge. Rewriting that body without the reference removes it. No caller can create an edge out of nothing.

**Blocked by:** 01, 05

**Status:** ready-for-agent

Edges are additive-only today with no delete path anywhere, so a segment whose content is overwritten leaves its old edges behind forever.

- [ ] A bare `[S/T]` in any citation-bearing field creates an unattributed pair
- [ ] Writing a node re-reads all its citation-bearing fields after the write, recomputes that node's pair set, and deletes pairs no field supports any more
- [ ] A rewrite that drops a reference drops its pair and any relation on it
- [ ] The generic body-free structured edge write is removed, not inherited by the merged tool
- [ ] A test reproduces the rewrite-drops-citation sequence rather than asserting the delete exists
- [ ] Full suite green
