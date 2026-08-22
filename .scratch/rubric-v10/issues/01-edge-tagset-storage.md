# 01 — Edge tag-set storage: assertions with immutable lane-tag identity

**What to build:** an edge write lands as an assertion whose identity is (citing, cited, relation, immutable canonical tag set) with a surrogate row id. One pair/relation legally holds several rows — an untagged row, an {A} row and a {B} row coexist as independent facts, and two singleton rows are never the merged {A,B} row. Sets are canonicalized (sorted, deduped) at write and never unioned across rows. A tag-keyed index table serves queries only, never semantics. The migration gives every existing row the empty set with ZERO data change (existing untagged indexes rows retroactively mean free aggregation), and is rehearsed twice on a /tmp copy of the production DB before it may ship.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] An edge write carrying tags stores them as an immutable canonical set on the row; identity includes the set; a second write of the same pair/relation with a different set creates a second row, same set is idempotent restatement.
- [ ] Retraction addresses one row (pair + relation + set) and deletes only it.
- [ ] Existing rows migrate to the empty set; row count, integrity check, and every existing read surface's output are byte-identical before/after on the rehearsal copy.
- [ ] The query index table stays consistent under insert/retract; dropping it entirely loses no semantics (rebuildable).
- [ ] Mutation check: corrupting canonicalization (e.g. unsorted set) is caught by a test; unioning two rows' sets is caught by a test.
