# 03 — One evaluator, evaluated twice; no escape hatches

**What to build:** `lane_check` becomes an honest preview of the verdict `commit` will reach, by construction rather than by convention — and the two ways the two could drift apart are removed.

**Blocked by:** 02 — the scope roles must exist to be shared.

**Status:** ready-for-agent

Spec: `.scratch/settlement-gate-taxonomy/spec.md` — the same section. NOTE the rejected design: a literally shared, computed-once snapshot goes stale under the run's own writes. One DEFINITION, two evaluations.

- [ ] One evaluator and one scope descriptor, consumed by the `lane_check` preview and by the terminal transaction's own fresh recomputation. `commit`'s refusal becomes a RENDERING of that result, not a second computation of it.
- [ ] `remember(justify)`'s independent whole-lane projection is NOT reconciled — it is retired by ticket 06 (user ruling S15069/T2278). Leave it untouched and unreferenced by the new evaluator; do not spend work making a doomed path agree. If ticket 06 has not landed when you build this, say so and leave the old path running beside the new one rather than half-migrating it.
- [ ] The agent-facing `scope: "all"` widening is REMOVED.
- [ ] Missing production provenance FAILS CLOSED. The current whole-history fail-open goes. A test seam that needs a legacy fallback must not reach the production tool path (fixture: a call with no provenance yields the system-failure channel, never a report).
- [ ] Fixture: preview and terminal verdict agree on a moving database too — a write between the two changes both, in the same direction, with no third answer possible.
- [ ] `npx tsc --noEmit` clean; touched suites green; full `bun test` once; bundles rebuilt, stale-bundle guard green.
