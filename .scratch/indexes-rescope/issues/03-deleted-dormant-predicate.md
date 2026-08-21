# 03 — one shared deleted/dormant node predicate

**What to build:** the graph's read sides agree on which turns exist (spec law
8): a rolled-back turn (`was_rolled_back`) is DELETED — it contributes no node
and no edge to any derivation, signal, or citation surface, ever; a
`status='skipped'` turn is DORMANT — absent while skipped, restored WHOLE
(edges included, no re-judgment) when a late note promotes it back to
`extracted`. Today three read sides filter inconsistently; afterwards they
consume one predicate. Spec: `.scratch/indexes-rescope/spec.md`.

**Blocked by:** None — can start immediately (parallel with 01).

**Status:** ready-for-agent

- [ ] One predicate with the two-tier semantics lives in exactly one module;
      flows, citations, and edge-signals read sides all consume it (grep
      proves no local variant survives).
- [ ] First document the CURRENT three-way inconsistency (what each site
      filters today) in the ticket/commit message — it is the motivating bug.
- [ ] Tests: a rolled-back turn's edges never appear in flow derivation,
      citation listings, or edge signals; a skipped turn's contributions
      vanish while skipped and return after promotion (write the
      skip→note→promoted round trip against the real promotion path, not a
      hand-set status).
- [ ] Behavior parity elsewhere: surfaces that already excluded rolled-back
      turns keep identical output on a fixture with none skipped/rolled back.
- [ ] Full suite green except the standing stale-bundle guard red.
- [ ] Report the one load-bearing property for mutation verification.

Ownership: yours — src/db/flows.ts, src/db/citations.ts,
src/db/edge-signals.ts, the new predicate module, their tests. NOT yours —
src/shared/turn-phase.ts, src/shared/flows.ts, src/mcp/*, src/db/schema.ts,
src/worker/* (ticket 01 edits several of these in parallel). If a change
seems to require crossing that line, stop and report instead of editing.
