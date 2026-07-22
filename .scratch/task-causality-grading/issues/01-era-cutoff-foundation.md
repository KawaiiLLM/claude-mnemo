# 01 — Era cutoff constant and era predicate

**What to build:** A single code-level epoch constant marking the task-causality grading era, plus a predicate that answers "is this turn task-causality era?" from the turn's creation epoch. Pure foundation: no production behavior changes in this ticket — later tickets (pool gating, skeleton trust) consume the predicate. The constant's final value is set at release time (ticket 07); until then it carries a placeholder value and must be overridable/injectable for tests.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [x] Exactly one constant defines the cutoff; the era predicate is the only way other code asks the era question.
- [x] Seeded tests place turns on both sides of the cutoff and assert the predicate flips exactly at the boundary.
- [x] `regrade` has no interaction with era: a re-graded turn's era is still determined solely by its creation epoch (assert in a test).
- [x] Full existing suite stays green with zero rendering/selection diffs.
