# 06 — Re-prime payload switch

**What to build:** The extraction worker's re-prime (after compact/reopen/derailment recovery) sends: the bounded session state block, the ticket-05 arc-grouped skeleton, and a bare recent-turn index (title + grade + dbid — no descriptions), replacing today's full milestone timeline plus 30-turn described recall index. The whole payload respects the ticket-05 budget and degradation order. The old re-prime rendering path (full timeline embed + described index) is removed, not left beside the new one. The main-session SessionStart/compact milestone hook and its 2,000-token ladder are untouched.

**Blocked by:** 05 — Arc-grouped task skeleton builder.

**Status:** ready-for-agent

- [x] Server-level test: a seeded session's re-prime contains state block + arc-grouped skeleton + bare index, and contains no per-turn description lines from the old index.
- [x] Re-prime total size for a seeded long session is bounded by the 4,000-token cap plus the state block's own bound.
- [x] The old full-timeline re-prime path is gone (no dead code kept "just in case").
- [x] Main-session milestone hook behavior byte-identical (its tests untouched and green).
- [x] Full suite green.
