# 02 — Milestone grading retires whole: no display, no machinery, no debt

**What to build:** the G0–G4 task-causality grading leaves the system as ruled
at [S15069/T1035] ("里程碑分级都是旧时代的产物了,不要留历史债") — not merely
hidden from rendering (ticket 01 strips the display) but the machinery itself:
milestone election runs on edge-signal lexicographic keys alone, settlement
stops grading, and nothing downstream reads a grade.

**Blocked by:** 01 (display strip lands first so this ticket is pure
machinery), and a SCOPING pass before final cut — the blast radius below is
from memory, unverified against HEAD.

**Status:** needs-scoping

## Known blast-radius candidates (verify each at scoping)

- Settlement: the grading duty in the settlement prompt, the mandatory regrade
  discipline, `gradeHistogram` in commit metrics/log lines.
- Selection: any `effGrade`/grade tie-break remnant in timeline election
  (the ruled keys are overridden-exclusion → encodes desc → refines bucket →
  recency — grade should already be absent; verify, don't assume).
- Schema: `significance_grade`/grade columns — follow the `supersedes`
  precedent: frozen-readable, stop writing; physical drop is a later pure
  subtraction if ever.
- Docs: task-causality rubric artifacts, ADR references, anchoring-eval
  channel wording (the eval's milestone channel tests selection keys, not
  grades — confirm no grade dependency).
- Era logic: legacy pre-era grade semantics readers (the era floor already
  fences settlement; check read surfaces).

## Acceptance (draft — final after scoping)

- [ ] Settlement runs grade nothing; commit metrics carry no histogram.
- [ ] Election provably grade-free (test: grades scrambled in a fixture,
      selection unchanged).
- [ ] Stored grade columns frozen-readable, never written by any live path.
- [ ] Full suite green modulo the standing stale-bundle guard.
