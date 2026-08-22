# 04 — Flow-era read-side retirement

**What to build:** the system core stops identifying lanes: production consumers of the decision-flow derivation (the flows read surface, timeline flow annotations, and any renderer deriving branch/settlement state) either retire or fall back to plain edge rendering. Interpretation will live solely in the checker (ticket 05); nothing in the core read path derives 起点/终点/lane. The law-8 read-side checklist (deleted/dormant turns hidden from graph surfaces, content index untouched) stays green throughout.

**Blocked by:** 02 — Write surface and the three hard gates.

**Status:** ready-for-agent

- [ ] No production read surface calls the flow derivation; the module is either deleted or demoted to checker-internal use only.
- [ ] Timeline and recall render edges (with tags where present) without flow/settlement badges; snapshots updated deliberately, not incidentally.
- [ ] The law-8 read-side checklist suite passes unmodified.
- [ ] Mutation check: reintroducing a flow-derived badge in a read surface fails a test.
