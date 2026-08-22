# 02 — Write surface and the three hard gates

**What to build:** the note tool's relation parameters accept an optional lane-tag set per cited target (address-only entries stay legal and mean untagged); retraction parameters address assertion rows. Exactly three write-time hard gates, everything else advisory: (1) phase domains — narrows/extends WIDEN from decision-only to same-phase (the decision cage retires with the flow model), cross-phase words unchanged, verifies/refutes keep the evidence-source rule; (2) tag legality — tags only on same-phase words, and the SUBSET INVARIANT: every edge tag must already exist on both endpoint turns' tags, violation rejects with a receipt naming the missing tag, no co-write of anything; (3) the self-citation gate validates against the post-transaction graph — one call may write the tagged-indexes declaration that makes the turn a terminus AND the self-grounds, in either order. Flow-era machinery in receipts retires: the mid-flow "cite the settlement instead" warning goes away with the flow concept.

**Blocked by:** 01 — Edge tag-set storage.

**Status:** ready-for-agent

- [ ] A relation entry with tags stores a tagged assertion; without tags an untagged one; both forms coexist on one pair/relation.
- [ ] A tag on a cross-phase word rejects; a tag missing from either endpoint's turn tags rejects, receipt names the tag and the endpoint.
- [ ] narrows/extends between two evidence-phase or two delivery-phase turns now store (previously rejected); the validator's decision-only constant is gone.
- [ ] A single call carrying a tagged-indexes declaration plus self-grounds passes; the same self-grounds without any terminus-declaring edge in the post-transaction graph still rejects.
- [ ] Mid-flow warnings no longer appear in any receipt; the receipt suite is green without them.
- [ ] Mutation check: the subset invariant and the post-transaction self-gate each have a test that fails when the gate is disabled.
