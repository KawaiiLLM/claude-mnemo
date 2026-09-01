# 02 — Three named scopes, bound at the loader

**What to build:** the projection stops being one undifferentiated id set and stops dragging whole lanes into memory. A settlement run's check surface loads only what its judgment, its evidence and its one boundary witness require.

**Blocked by:** 01 — RESOLVED at `53597ffc`, and it changed this ticket's job. Read its Status before starting.

**THE DEFECT TICKET 01 FOUND, which this ticket now owns:** `loadLaneCheckScope` does two asymmetric things in one pass — it resolves MEMBERSHIP for every turn in the projection, but WIDENS EDGES only for seed-discovered lanes. So any lane in a touched segment materialises with FULL membership and a PARTIAL edge set, and reads as over-fractured. On E60's `execution-repair` the window projection kept 33 edges and lost all 20 `indexes` edges — the very relation an index/convergence turn uses to declare its lane. That is what makes phantom fractures, and narrowing the scope WITHOUT closing the asymmetry reproduces it exactly. `memberIdList` freezes at `lane-checker-load.ts:984`, BEFORE the segment-graph pass at `:1028-1043`, so no supplementary pass can repair it after the fact.

**Status:** ready-for-agent

Spec: `.scratch/settlement-gate-taxonomy/spec.md` — "One evaluator, one scope definition, two evaluations" and "Bound at the loader" govern.

- [ ] Three roles, named in the type system, never collapsed: **judgment anchors** = the window's 50 prompt numbers plus the 50 immediately preceding prompt numbers of the same session; **evidence closure** = the remote endpoints needed to explain those anchors, readable but never a source of reported findings; **boundary witness** = for each component the window touches, exactly ONE nearest out-of-window component.
- [ ] **The asymmetry closes: membership resolution and edge widening cover the SAME lane set.** A lane that is reported must be a lane whose edges were widened; a lane whose edges were not widened must not be reported at all. Fixture: ticket 01's `tests/worker/lane-fracture-agreement.test.ts` second case must pass by CONSTRUCTION, not by scope luck.
- [ ] The narrowing reaches `loadLaneCheckScope`. Its WIDEN step must stop materialising every involved lane's full membership and full tagged edge set unconditionally. Report the before/after on E60's largest lane (rows loaded, wall clock, rendered characters).
- [ ] The boundary witness may scan the lane to find its one target and may emit only that one — a fixture with a lane holding N components asserts exactly one out-of-window entry, not N−1.
- [ ] Findings anchored in the evidence closure appear in NO report and in NO gate (fixture: an old error on a lookback turn is invisible and non-blocking).
- [ ] "Preceding 50 prompt numbers of the same session", not the lane's own preceding 50 members — a fixture with a sparse lane pins the difference.
- [ ] `npx tsc --noEmit` clean; touched suites green; full `bun test` once; bundles rebuilt, stale-bundle guard green.
