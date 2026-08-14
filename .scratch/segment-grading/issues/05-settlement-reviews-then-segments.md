# 05 — The settlement subagent reviews every turn, then segments

**What to build:** The settlement subagent stops being a segmenter that happens to see turn facts, and becomes a review pass that segments last. Over its context — the previous 50 turns plus the turns pending settlement — it performs three ordered steps:

1. Review and label every turn's `grade`, `type` and `tags`: confirming or overriding the mechanical draft, and grading against the recovered task-causality rubric stated in full.
2. Backfill notes for the turns in its window that have none.
3. Only then assign segment membership by topic, over turns whose facts are now settled.

The order is the point. A segment's type is the union of its members' real activities, which is vacuous while members have no activities — segmenting first is what made it so.

It may revise any turn it can see, including turns settled in an earlier window. That is not a loophole but the mechanism the rubric already assumes: it tells its grader that a Grade 4 is provisional because settlement will re-read the arc and demote it by the arc's actual scale. The 50-turn lookback is where that happens, so a grade assigned before an arc's length was visible gets corrected when it is.

The job's structured log gains a per-grade histogram. Grading drift has bitten before — after a model swap the middle grades ran near double their baseline share while the lowest starved and the highest went unused — and the rubric's calibration targets now sit beside it, so drift is a comparison rather than an investigation.

**Blocked by:** 01 — Task-causality rubric recovered to a single home (done); 02 — Type and tags are drafted the moment a note lands; 04 — `remember` can correct a single field, on any turn.

**Status:** ready-for-agent

- [ ] The response carries a per-turn array of grade, type and tags, separate from note directives — notes cover only the turns needing backfill, review covers every turn
- [ ] Every turn in the window receives a per-turn directive, including turns that already have agent-written notes
- [ ] The prompt presents the mechanical draft *as a draft* to confirm or override, rather than as an unexplained fact on the turn line
- [ ] The prompt states the rubric in full by importing its single home, never by restating it
- [ ] The prompt states the three steps in order, and that segmentation is last and consumes reviewed facts
- [ ] A turn from an earlier window that is still in context can be revised, and the revision lands
- [ ] Re-running the same window converges to the same values rather than oscillating
- [ ] A malformed directive, an out-of-range grade, or an unknown turn address fails the whole window rather than committing fragments
- [ ] The job's structured log line carries a per-grade histogram
- [ ] Segment membership is assigned from reviewed per-turn facts, and a segment's type is the union of its members' reviewed activities
- [ ] Tests at the settlement writeback seam, extending the existing fixtures rather than adding a seam
- [ ] Full suite green
