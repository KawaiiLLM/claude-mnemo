# 13 — An edge whose tag no normalization can read must still be disposed of

**What to build:** the migration leaves nothing behind that can never become legal. Today an edge whose tags yield NO canonical tag is recorded in M0's `rejected` bucket and then touched by nothing — it keeps its tag column and its `memory_edge_tags` rows, so the checker still derives a lane from it that no one can ever declare, use or remove.

**Blocked by:** None — 04 shipped; this repairs it.

**Status:** ready-for-agent

Peer finding, verified at HEAD. The chain: `classifyTaggedEdges` pushes such an edge to `rejected` and `continue`s, so it enters neither `placeable` (M2's input) nor `notPlaceable` (M4's input). Meanwhile the checker's own loader matches on `memory_edge_tags` and never consults the registry, so the tag becomes a live derived lane. That lane cannot be declared — D1 refuses a non-canonical tag — so every tagged write naming it refuses, and `undeclare` does not apply because it was never declared. Attribution (ticket 09) then reads both endpoints as attributed, so the warning that exists to surface exactly this debt stays silent about it.

Measured read-only on production: **zero such rows today** (441 tagged turn-edges, none carrying interior whitespace, uppercase, padding or an empty tag). This is a latent defect, not a live one — but D6's own text promises "nothing vanishes from the receipt the later phases consume", and nothing consumes this bucket.

- [ ] M4 disposes of the FULLY rejected edges the same way it disposes of `notPlaceable` ones: downgrade to untagged, merging into a pre-existing untagged row for the same (pair, relation) when one exists, with `memory_edge_tags` maintained in the same transaction.
- [ ] **The trap to avoid:** `rejected` holds TWO different shapes and today they are indistinguishable — a full rejection (no canonical tag survived; the edge `continue`s and appears in no other bucket) and a PARTIAL loss (some tags survived; the edge still classifies and appears in `placeable` or `notPlaceable` too). Both currently carry `reason: "no-canonical-tag"`. Disposing the partial ones would strip legitimate surviving tags. Give the two shapes a discriminator that a reader of the receipt can also see, rather than relying on set arithmetic at the call site.
- [ ] A `malformed-tags-column` edge — `tags` is not even a readable JSON array — is disposed of too, since no reader can act on it either. Say in the receipt which shape each disposal repaired.
- [ ] The receipt keeps naming what was lost. A downgrade here destroys the only record of the original tag string, so the receipt entry carries `rawTags` verbatim.
- [ ] Tests: a full rejection is downgraded and its tag index cleared; a partial loss keeps its surviving tags and is NOT downgraded; a malformed column is downgraded; the receipt distinguishes the shapes; a second run is a no-op.
- [ ] Mutation-verify each declared property before finishing.
