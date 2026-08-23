# 03 — Both timeline views elect through the module; renderer learns elected-only ↳

**What to build:** the session view's milestone selection and the segment
view's (the SessionStart-injected milestones included) both delegate to ticket
02's module, and the old chain retires:

- always-keep (endpoints ∪ correctors ∪ reversed ∪ era-G4), effGrade spine
  admission, era gating and the pulled-antecedent machinery all leave the
  election path, with retirement grep-guards;
- elected rows keep rendering in TIME order;
- the `↳` line under an elected row lists only its cited turns that are
  themselves elected, omitting the rest, its budget cost attributed to the
  citing row;
- edgeless windows degrade to recent-N under the renderer's existing budget.

**Blocked by:** 02 — Election core module.

**Status:** done (mutation-verified: elected-only ↳ filter → 1 red, kept time re-sort → 11 red)

- [ ] S-view and E-view (segment/injection) integration tests show the new
      election's output end to end; the fixture window renders the golden nine
- [ ] Grep-guards pin the retirements (no effGrade/always-keep symbols on the
      election path); grading/settlement pipelines untouched
- [ ] ↳ behavior unit-tested: unelected cited turns omitted, budget attributed
      to the citer, no pulled-antecedent resurrection
- [ ] Full lane/timeline test files green; typecheck clean; load-bearing
      properties declared per criterion
