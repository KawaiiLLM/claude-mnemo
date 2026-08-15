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

## Reopened after cross-review

The first pass landed as `b7cba25` and two findings sent it back. Both are consequences of this ticket rather than gaps for a later one — retiring the foreign-key-backed table is what made the first load-bearing, and the second was introduced here.

- [ ] **No provenance ordering gates the relation column.** The first pass ranked sources and let the rank decide whether a relation could be overwritten, which made a main-agent relation permanently immune to settlement's correction and so made C7 unimplementable. An authorised write replaces the relation and the provenance recording its source, with no rank test between them; eligibility belongs to the write paths (ticket 07), not to a global ordering.
- [ ] **A write carrying no relation never clears or relabels an existing one.** A citation in prose says the pair exists and says nothing about its relation.
- [ ] **Deleting an endpoint deletes its edges**, by kind-aware delete triggers covering both directions for turns and segments and the outgoing direction for sessions — at the storage layer, because cascades and direct SQL bypass the deletion APIs. Not tests that pin orphaning as accepted; the two that currently do must go.
- [ ] A test shows the segment ranking key's cited-by count is unaffected by a deleted citer, since that is where the orphan was observable rather than merely untidy

## Second review round — two more, both verified

- [ ] **An unattributed pair must be readable, not merely storable.** Both pair readers filter `relation IS NOT NULL`, so a pair with no relation returns nothing and a turn recorded as having citations falls through to no inline fallback either — it leaves the timeline's in-degree and pull-through entirely. That empties C5 of its content: the whole point of pair identity is that a citation without a stated relation exists. Generic pair readers must include relationless rows; only relation-specific logic such as the `supersedes` branch may filter on relation.
- [ ] **The fold-in has an unstated precedence rule, and in production shape it is a no-op.** The migration inserts with `ON CONFLICT DO NOTHING`, and every citation pair already exists in the edge table, so the citation's relation never participates before the table is dropped. The existing tests delete the edge table before migrating, so the real overlap is never exercised. A test with genuinely conflicting relations on an overlapping pair is required, and whichever side wins must be a written rule rather than a consequence of clause order.
