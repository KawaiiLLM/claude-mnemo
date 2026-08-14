# 06 — Verify on a real window and measure drift

**What to build:** The pieces meet on real data. A genuine settlement window — the next natural one, or one triggered through the existing operator endpoint — runs the review pass, and the arc view for that session is read back showing nested milestone rows built from grades the subagent actually assigned and glyphs from types it actually confirmed.

Three measurements come out of it. The grade distribution against the rubric's calibration targets. The share of mechanical type drafts the subagent overrode, which is the only evidence of whether the draft is worth presenting at all. And a read-by-eye sample checking whether the admitted milestone rows are in fact the arc's load-bearing turns.

This ticket exists because every other slice is testable alone but they only ever meet in production, and that meeting point is exactly where grading drift appeared last time. The deliverable is a written finding; anything it turns up gets its own decision.

**Blocked by:** 05 — The settlement subagent reviews every turn, then segments.

**Status:** ready-for-agent

- [ ] A real settlement window runs and per-turn grade, type and tags land
- [ ] The arc view for that session shows nested milestone rows produced from those grades
- [ ] The observed grade distribution is stated against the calibration targets, with the delta named and any starved or unused tier called out
- [ ] The override rate of the mechanical type draft is measured and reported — how often the subagent disagreed with the parse
- [ ] A sample of reviewed turns is read by eye against the rubric, and every disagreement with the assigned grade is listed
- [ ] The rendered spine is judged for whether its admitted rows are the arc's load-bearing turns, with counter-examples named
- [ ] Findings are written up; no fix lands under this ticket
