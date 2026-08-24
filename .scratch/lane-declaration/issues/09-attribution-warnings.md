# 09 — The checker pressures attribution instead of mandating tags

**What to build:** with the per-edge tag mandate gone, the checker is what keeps lanes from either disappearing or multiplying. It reports two facts — never refuses — and settlement reads them as its own workload.

**Blocked by:** 03.

**Status:** ready-for-agent

Rulings: [S15069/T1547], [S15069/T1548].

- [ ] **Unattributed component warning:** a connected component of **4 or more** turns in which no member carries any lane tag is reported, naming the component's turns. Three or fewer is silence — a short exchange is not a workflow.
- [ ] **Proliferation warning:** a segment whose declared lane count exceeds **0.05 × its member turn count** is reported with both numbers. The constant stays 0.05 even though today's E60 sits under it at 63/1637 = 0.038 — the ruling is explicit that E60 is not yet fully settled, so the line is drawn for the steady state, not for today's snapshot.
- [ ] Both are WARNINGS in the existing report vocabulary, never errors, and neither blocks a commit.
- [ ] `lane_check` prints both, so settlement sees its own attribution debt in the same surface it already reads.
- [ ] Tests: a 3-turn unattributed component is silent and a 4-turn one warns (the boundary, both sides); a segment at exactly the ratio is silent and one over it warns; a component with ONE tagged member is silent (attribution is per-component, not per-turn).
