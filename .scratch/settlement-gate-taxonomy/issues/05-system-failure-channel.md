# 05 — The third channel: system / projection failure fails closed

**What to build:** the outcomes that are neither "you have work to do" nor "here is something to know" get their own channel, visible to the operator and never dressed up as a repairable finding.

**Blocked by:** 03 — the evaluator and its scope descriptor decide when a projection is unconstructible.

**Status:** ready-for-agent

Spec: `.scratch/settlement-gate-taxonomy/spec.md` — "The third channel" governs.

- [ ] A typed SYSTEM / PROJECTION FAILURE result, distinct from both errors and warnings, on both surfaces. It FAILS CLOSED: the run is told it cannot proceed on this check, and is NOT handed a list that pretends to be repairable.
- [ ] Its cases: missing production provenance; an unconstructible projection; a self-contradicting shared evaluator; and a result that cannot be expressed inside the protocol — today's `result (N characters across M lines) exceeds maximum allowed tokens`, which occurred 35 times in 7 days and silently spilled to a file the agent then paid to read back.
- [ ] Operator-visible: it reaches the worker log, not only the agent's transcript.
- [ ] Fixture per case, each red-capable on its own condition. In particular: an over-protocol render is a system failure, never a truncated report and never a warning.
- [ ] `npx tsc --noEmit` clean; touched suites green; full `bun test` once; bundles rebuilt, stale-bundle guard green.
