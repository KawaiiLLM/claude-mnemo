# 02 — A turn states its own type, and a turn may have more than one

**What to build:** The writing agent names what a turn did when it writes the note, and a turn that did two things says both. The timeline shows real activity words again instead of the placeholder every row has carried since the extraction agent was retired.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

Vocabulary is eleven peers: `discuss`, `research`, `design`, `implement`, `refactor`, `fix`, `measure`, `review`, `ops`, `delegate`, `correction`. `write` and `chat` and `rolled-back` leave; see spec B2-B4 for each word's definition and the boundaries that measurement showed failing.

- [x] `turns.type` holds a list, as a segment's already does; a single value still round-trips
- [x] The write tool accepts `type` and `tags` from the caller
- [x] The mechanical title-to-type derivation is gone, not kept as a fallback
- [x] An illegal or absent activity word leaves the type empty; empty is never a claim
- [x] ~~Tags are bare topic words — no `topic:` prefix is applied to new writes; existing prefixed rows are left alone~~ **Amended mid-ticket (spec B6):** the `topic:` namespace is retired outright and the 6427 existing prefixed values are stripped in a migration. Leaving them would have meant a read side matching two spellings of every subject forever
- [x] The timeline renders a turn's activity, and a multi-valued turn renders sensibly
- [x] recall's `type:` filter matches within the list
- [x] Full suite green — 1718 pass, 0 fail

## Closed

### Rendered-output changes

Written down here because the ticket requires it rather than leaving a reader to discover them:

- **Timeline glyphs now cover all eleven words**, not the old six-word legacy map. A turn typed `review` used to render `•` and now renders its own glyph; a golden-fixture test in `segment-spine.test.ts` had to be updated to match.
- **A multi-valued type renders as its glyphs joined with no separator** (`["review","ops"]` → `✅⚙️`), in the turn table, the milestone and phase rows, and the segment spine's phase trace.
- **Phase grouping is ordered-list equality**, not scalar equality. Two turns whose type lists hold the same words in a different order are now two phases, not one. Applies identically to the timeline's phases and the spine's phase trace.
- **`type:` and the segment facets match within the array** via `json_each`, the pattern `tag:` already used — strictly more permissive than before.
- **`tag:` queries lose the `topic:` spelling.** `tag:topic:svg-filter` matched before this ticket and matches nothing after it; the query is now `tag:svg-filter`.

### Write semantics, corrected after review

The first pass shipped two per-field mechanisms — `type` cleared on omission, `tags` merged additively — and both were reverted. Omission is silence for every field; a stated value overwrites whole. The full `overwrite`/`append` vocabulary is ticket 03's (spec D5a), and this ticket leaves every field on a strict subset of it.

### Two seams left open on purpose

- **`task-causality-rubric.ts` is internally inconsistent.** Its correction clause still tells the settlement model to tag a casualty `rolled-back` through a `regrade` verb, neither of which exists now. Spec section I owns the rewrite — ticket 12. Live consequence until then: a settlement reply that follows the stale instruction emits a type the validator rejects, failing the whole window visibly rather than corrupting it silently. **Ticket 12 should land before settlement writes through tools.**
- **`segment-rank`'s `isRolledBack` ranking key is now permanently false.** Its scalar `COALESCE(t.type,'') = 'rolled-back'` cannot match a JSON array under any content. It was already inert before the migration, since the value was segment-only. Moving it to an inbound-`supersedes` test is spec B4's direction and belongs to ticket 13.
