# 04 — The two repair migrations: tagless membership, and edges that can never be legal

**What to build:** the upgrade repairs the two illegal states the new rules expose, and leaves an auditable record of every disposition.

**Blocked by:** 01.

**Status:** ready-for-agent

Spec: `.scratch/lane-declaration/spec.md` (Rev 2) — D6/M3 and M4, both rewritten after peer findings P1-3 and P1-4.

- [ ] M3 stamps a segment's curated tags onto members lacking them ONLY for pairs on a hard-coded, reviewed allowlist — today exactly `(E60, ["claude-mnemo"])`. Rev 1's "≤ 2 curated tags" heuristic is gone: a count is not provenance. On the live shape this stamps 1085 members.
- [ ] Every other segment with tagless members is REPORTED in the receipt and left untouched — E53/E58/E59 (29/21/18 derived-tag lists) must come out with their turns unchanged, and that is an explicit test.
- [ ] A member whose `tags` column is malformed or non-array is reported and skipped, never coerced to `[]` and overwritten.
- [ ] M4 disposes of edges that can never satisfy the new rules, BY RELATION CLASS: `extends`/`narrows` are DELETED (an untagged continuation edge is itself rejected by the checker, so stripping is not a repair), recording both addresses, the relation and the tags in the receipt. Other relations downgrade to untagged — but only after checking for an existing untagged row for the same (pair, relation), merging into it rather than colliding with the `(pair, relation, tags)` UNIQUE key, and rebuilding `memory_edge_tags` in the same transaction.
- [ ] Both phases write durable receipt rows and are no-ops on a second run.
- [ ] Fixture mirrors the live shapes: homeless endpoint, cross-segment edge, multi-tag edge, an `extends` with no legal placement, a member lacking the segment tag, a 29-tag legacy segment, a malformed `tags` column.
