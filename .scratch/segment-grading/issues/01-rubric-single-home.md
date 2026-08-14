# 01 — Task-causality rubric recovered to a single home

**What to build:** The task-causality G0–G4 rubric exists in the codebase again, as one importable block whose wording is byte-identical to the version deleted when the extraction agent was retired. Anyone who needs to state the grading standard reads it from that one place — no caller keeps its own copy, and nothing paraphrases it. The calibration targets the rubric was written against travel with it, and its token cost is measured so the next ticket can budget the settlement prompt against a real number.

This is a prefactor: it makes the change easy before the change is made. It is deliberately not demoable on its own, and its value is entirely in the first acceptance criterion — historical grades were assigned under these exact words, so a reworded rubric silently forks the semantics that make an old milestone and a new one comparable.

**Blocked by:** None — can start immediately.

**Status:** done — `298be49`

- [ ] The restored text is byte-identical to the version recovered from the commit preceding the extraction-agent retirement, verified by diff rather than by reading
- [ ] Exactly one module exports it; a repo-wide search finds no second copy and no paraphrase of any grade's definition
- [ ] The calibration targets the rubric was written against are recovered with it and live beside it
- [ ] The rubric's token cost is measured and recorded as a delta against the settlement prompt's current size
- [ ] A test pins the text, so a later edit cannot reword the standard without failing
- [ ] Nothing else changes behaviour; full suite green
