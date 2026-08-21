# 03 — CHECK 收缩与生产演练

**What to build:** The contract half: memory_edges' CHECK narrows to the
eight words + supersedes (machine-only) once no old word remains; and the
FULL migration (02's renames + both CHECK phases) rehearses on a /tmp copy
of the production database under the 0.13.0 incident protocol — this
migration UPDATEs data, so the stakes are higher than 0.13.0's.

Protocol, verbatim from the standing rules: snapshot via sqlite3 .backup;
any write-opening script HARDCODES an assertion that its resolved target
path starts with /tmp/ (never from argv/env/config); production is opened
with `sqlite3 -readonly` only.

**Blocked by:** 02.

**Status:** ready-for-agent

- [ ] Contract migration: CHECK = 8 words + supersedes; staleness keyed on
      DDL text; idempotent.
- [ ] Rehearsal on a fresh production copy: run twice (idempotence — second
      run byte-no-op); the whole-DB diff is EXACTLY the expected shape —
      relation values changed per the mapping table with per-word counts
      matching the spec's numbers (302/222/6/26/59/52), row counts
      identical everywhere, every other byte identical; PRAGMA quick_check
      ok, foreign_key_check empty.
- [ ] The 9 known mid-flow-target edges survive unchanged (P1: valid as of
      write time).
- [ ] Read-path smoke on the migrated copy: recall/timeline render without
      error; renamed words display.
- [ ] Full `bun test` green except the sanctioned stale-bundle guard.
