# 13 — An edge whose tag no normalization can read must still be disposed of

**What to build:** the migration leaves nothing behind that can never become legal. Today an edge whose tags yield NO canonical tag is recorded in M0's `rejected` bucket and then touched by nothing — it keeps its tag column and its `memory_edge_tags` rows, so the checker still derives a lane from it that no one can ever declare, use or remove.

**Blocked by:** None — 04 shipped; this repairs it.

**Status:** done — 11 mutations by the implementer, 2 re-run independently on acceptance

Peer finding, verified at HEAD. The chain: `classifyTaggedEdges` pushes such an edge to `rejected` and `continue`s, so it enters neither `placeable` (M2's input) nor `notPlaceable` (M4's input). Meanwhile the checker's own loader matches on `memory_edge_tags` and never consults the registry, so the tag becomes a live derived lane. That lane cannot be declared — D1 refuses a non-canonical tag — so every tagged write naming it refuses, and `undeclare` does not apply because it was never declared. Attribution (ticket 09) then reads both endpoints as attributed, so the warning that exists to surface exactly this debt stays silent about it.

Measured read-only on production: **zero such rows today** (441 tagged turn-edges, none carrying interior whitespace, uppercase, padding or an empty tag). This is a latent defect, not a live one — but D6's own text promises "nothing vanishes from the receipt the later phases consume", and nothing consumes this bucket.

- [x] M4 disposes of the FULLY rejected edges the same way it disposes of `notPlaceable` ones: downgrade to untagged, merging into a pre-existing untagged row for the same (pair, relation) when one exists, with `memory_edge_tags` maintained in the same transaction.
- [x] **The trap to avoid:** `rejected` holds TWO different shapes and today they are indistinguishable — a full rejection (no canonical tag survived; the edge `continue`s and appears in no other bucket) and a PARTIAL loss (some tags survived; the edge still classifies and appears in `placeable` or `notPlaceable` too). Both currently carry `reason: "no-canonical-tag"`. Disposing the partial ones would strip legitimate surviving tags. Give the two shapes a discriminator that a reader of the receipt can also see, rather than relying on set arithmetic at the call site.
- [x] A `malformed-tags-column` edge — `tags` is not even a readable JSON array — is disposed of too, since no reader can act on it either. Say in the receipt which shape each disposal repaired.
- [x] The receipt keeps naming what was lost. A downgrade here destroys the only record of the original tag string, so the receipt entry carries `rawTags` verbatim.
- [x] Tests: a full rejection is downgraded and its tag index cleared; a partial loss keeps its surviving tags and is NOT downgraded; a malformed column is downgraded; the receipt distinguishes the shapes; a second run is a no-op.
- [x] Mutation-verify each declared property before finishing.

## Decisions taken

- **The discriminator is a third `reason` value, not a `survivingTags` field.** `no-canonical-tag` now means a FULL rejection only and `partial-canonical-loss` is its own name, so the receipt says which shape each entry is without anyone cross-referencing buckets. A partial entry's survivors are already readable off its `placeable`/`notPlaceable` twin by edge id — one source of truth.
- **`rawTags` rides on EVERY downgrade entry, not only the rejected ones.** One entry shape, and every downgrade destroys a column worth recording verbatim. It is load-bearing for the malformed case, where the parsed `tags` render is necessarily `[]`.
- **Disjointness by edge id is load-bearing, not cosmetic.** A repeated id in M4 would make the second pass find the first pass's own now-untagged row through `findUntaggedRow` and delete the row it had just repaired. The `partial-canonical-loss` skip is what guarantees disjointness, which is why no dedupe set was added — the property is pinned by its own test instead.
- **Left as an asymmetry, not fixed:** M3's parallel vocabulary splits invalid-JSON from valid-but-not-array (`malformed-tags-column` / `non-array-tags-column`); M0 deliberately does not, since the disposition is identical. Symmetry across phases would be a follow-up.

## Found while implementing — a latent crash, not a skip

The filter this ticket widened was `json_array_length(me.tags) > 0`. SQLite's JSON functions **raise** `malformed JSON` rather than returning NULL, and a raise inside a WHERE fails the whole statement — so a single pre-CHECK unreadable row would have aborted M0, and with it `initializeSchema`, for **every process opening that database**. `CASE` (whose arms are guaranteed lazy, unlike a bare `AND` chain) is what makes the malformed shape reachable at all rather than fatal. Without it the ticket's malformed requirement is not merely unmet but unimplementable.

Production re-verified read-only: 441 tagged turn-edges, 0 unreadable columns, 0 rows the widened filter newly admits, 0 full rejections. M4's new disposal set is empty on production, so unlike ticket 04's M4 this one is release-order-neutral.
