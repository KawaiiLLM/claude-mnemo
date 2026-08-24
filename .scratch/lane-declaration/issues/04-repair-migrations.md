# 04 — The two repair migrations: tagless membership, and edges that can never be legal

**What to build:** the upgrade repairs the two illegal states the new rules expose, and leaves an auditable record of every disposition.

**Blocked by:** 01.

**Status:** done (16db8c2, repaired by the commit carrying this line)

Spec: `.scratch/lane-declaration/spec.md` — D6/M3 and M4, both rewritten after peer findings P1-3 and P1-4, M4 again after P1-1.

- [x] M3 stamps a segment's curated tags onto members lacking them ONLY for pairs on a hard-coded, reviewed allowlist — today exactly `(E60, ["claude-mnemo"])`. Rev 1's "≤ 2 curated tags" heuristic is gone: a count is not provenance. On the live shape this stamps 1085 members.
- [x] Every other segment with tagless members is REPORTED in the receipt and left untouched — E53/E58/E59 (29/21/18 derived-tag lists) must come out with their turns unchanged, and that is an explicit test.
- [x] A member whose `tags` column is malformed or non-array is reported and skipped, never coerced to `[]` and overwritten.
- [x] M4 disposes of edges that can never satisfy the new rules by downgrading EVERY one of them to untagged — the relation-class branch is retired by the repair below — recording both addresses, the relation and the tags in the receipt, and merging into an existing untagged row for the same (pair, relation) rather than colliding with the `(pair, relation, tags)` UNIQUE key. `memory_edge_tags` is maintained in the same transaction: targeted, since the rebuild helper opens its own transaction and does not nest.
- [x] Both phases write durable receipt rows and are no-ops on a second run.
- [x] Fixture mirrors the live shapes: homeless endpoint, cross-segment edge, multi-tag edge, an `extends` with no legal placement, a member lacking the segment tag, a 29-tag legacy segment, a malformed `tags` column.

## Repair, added by [S15069/T1566] (peer P1-1) — do this BEFORE any release

- [x] M4 no longer DELETES `extends`/`narrows`. Its deletion rationale was "an untagged continuation edge is itself illegal", and the mandate that made that true is withdrawn: all eight words have a legal untagged form now. Every relation class downgrades to untagged and merges into a pre-existing untagged row for the same (pair, relation) when one exists.
- [x] The receipt's `deleted` bucket disappears with the behaviour, or stays only for a shape that genuinely cannot be expressed — say which and why. **Disappears entirely**: the downgrade path is now total over the input, so no shape is left that cannot be expressed untagged.
- [x] No recovery phase is needed: the migration runs at first open of a RELEASED build and no release has happened, so no deletion has ever executed. State that check in the report rather than assuming it. **Checked read-only**: `lanes` and `migration_receipts` are both absent from `~/.claude-mnemo/claude-mnemo.db`, so M4 has never run on production.
- [x] **Release order**, discovered here: downgrading a continuation edge produces a fresh E1 violation against the CURRENTLY live checker, which still refuses untagged `extends`/`narrows`. Ticket 04 ships with ticket 02 or not at all — recorded in spec D6.
