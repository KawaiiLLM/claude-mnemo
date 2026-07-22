# 04 — Era-gated milestone pool gating

**What to build:** For task-causality-era turns only (per the ticket-01 predicate), the milestone content-bonus path (insight / pure-spec / tag) no longer lifts grade-0/1 turns over the milestone pool threshold; the bonus continues to apply to G2+ turns for ranking among candidates. Legacy-era turns keep the current behavior verbatim, so historical daily timelines render exactly as before this change. Grade base scores, citation in-degree caps, structural always-keeps, corrector promotion, and the adaptive daily budget are all untouched.

**Blocked by:** 01 — Era cutoff constant and era predicate.

**Status:** ready-for-agent

- [x] Seeded day with a post-cutoff G1-with-insight turn: that turn is excluded from the ordinary milestone pool.
- [x] Same day with a post-cutoff G2 turn: included, and content bonus still affects its ranking.
- [x] Seeded day with a pre-cutoff G1-with-insight turn: still included (legacy behavior byte-identical).
- [x] Boundary test: two otherwise-identical G1-with-insight turns straddling the cutoff flip pool membership exactly at the boundary.
- [x] Structural always-keep rows (correctors, outcomes, endpoints, compact boundaries) unaffected in both eras; existing timeline selection suite green.
