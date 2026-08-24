# 01 — The lane registry, its two verbs, and a graph that arrives already seeded

**What to build:** a lane becomes an object you create before you use it. `remember(verb="declare", id="E60", tag="write-gate")` mints one; `remember(verb="undeclare", ...)` removes one that nothing cites. After the upgrade the registry is NOT empty: it already holds every lane the live graph uses, seeded by migration, so nothing that used to work stops working.

**Blocked by:** None — can start immediately.

**Status:** done (shipped earlier in this batch — see the commit that closes each box)

Spec: `.scratch/lane-declaration/spec.md` (Rev 2) — D1, D4, D6/M0–M2, and the canonical-tag and two-vocabulary rules.

- [ ] `lanes(id, segment_id → segments(id) ON DELETE CASCADE, tag, created_at_epoch, UNIQUE(segment_id, tag))` exists, plus a `migration_receipts` table (name, applied_at_epoch, payload) that each migration phase writes ONE row to.
- [ ] A lane tag is stored only in canonical form: NFC-normalized, trimmed, lowercase, non-empty, no interior whitespace runs. `declare` REFUSES a non-canonical value naming what is wrong — it never silently canonicalizes, so `write-gate` / `Write-Gate` / `" write-gate "` can never become three lanes.
- [ ] `declare` refuses: a duplicate tag in that segment (naming the existing lane), a tag that is already one of that segment's curated `tags`, a non-existent or closed segment.
- [ ] `retag` on a segment refuses a tag that is already one of that segment's declared lanes, naming it. (The two vocabularies are separated by an enforced invariant, not by intent.)
- [ ] `undeclare` refuses while any edge in that segment still carries the tag, naming the count.
- [ ] Migration M0 (read-only) classifies every existing tagged edge as placeable or not, and PERSISTS that classification as a receipt row — ticket 04 consumes it; M2 seeds lanes only from the placeable set, so it never mints a lane for a tag that is about to be stripped.
- [ ] A phase is skipped only when its OWN receipt row exists — never inferred from the `lanes` table existing. Running the migration twice is a no-op, proven by test.
- [ ] Seeding receipt names the per-segment counts. On the live shape that is ~63 lanes for E60, 7 for E67, 3 for E65.
- [ ] Tests at the `remember` tool boundary for every refusal above, plus canonical-form cases: interior whitespace, mixed case, NFC vs NFD, empty string.
