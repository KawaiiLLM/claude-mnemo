# 05 — Edges live in one table, keyed by the pair

**What to build:** A citation without a stated relation can exist, a relation can be corrected rather than duplicated, and one relation stops yielding two different answers depending on which consumer asks.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

Today `relation` is NOT NULL, sits inside both the primary key and the upsert conflict key, and is CHECK-constrained to the retired four values — so an unattributed edge cannot be stored and a correction inserts a second row. Two tables also hold edges with different deletion semantics, and two consumers read different ones. This blocks 06 and 13.

- [ ] Edge identity is `(citing node, cited node)`; `relation` is a nullable attribute and a pair carries at most one
- [ ] The relation vocabulary is `evidence-for`, `evidence-against`, `supersedes`, `depends-on`
- [ ] `citing_kind` admits `session`
- [ ] One truth table: either the two layers collapse or the older is explicitly retired — both alive on an insert-only migration is not an outcome
- [ ] Existing rows survive the change with their meaning intact, or their loss is a stated decision
- [ ] Both consumers — the timeline's correction graph and the segment ranking key — read the same table afterwards
- [ ] Full suite green
