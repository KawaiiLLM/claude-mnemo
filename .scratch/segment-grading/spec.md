# Settlement review pass — per-turn grade, type and tags, then segments

**Status:** ready-for-agent
**Slug:** `segment-grading` (historical — the scope grew past grading)
**Revision:** 2

## Problem Statement

Three per-turn fields are empty for every segment-era turn: `grade`, `type`, `tags`. Two different causes, one shared consequence.

`grade` was written by the resident extraction agent and went out with it when that agent was retired. `type` and `tags` were never wired at all: the settlement context computes a per-turn `type_draft` from the note title and renders it onto the turn line in the prompt, but no instruction tells the subagent what it is, and the response schema has no per-turn slot to return it. Producer and consumer arrived in the same commit; only the producer was built.

The consequences compound. The arc view's turn table hid every unreviewed turn's title (fixed separately, since a title should never have needed a type to be shown). The spine admits nothing, because admission keys on a grade nobody writes. And segmentation, which the subagent performs first, is told that a segment's type is "the union of its members' real activities" — a union over members that carry no activities.

Underneath all three is an ordering mistake. The subagent segments first and treats per-turn facts as inputs it happens to see, when segmentation is the step that depends on those facts being settled.

## Solution

Two halves.

**Mechanically, at insert time**, a turn's `type` and `tags` are derived from its note title, whose format already carries both: `<activity>+<topic>: <what this turn covered>`. The activity half yields the type, the topic half the tag. The derivation is a draft, not an answer — it is right often enough to be worth having and wrong often enough to need review.

**In the settlement subagent**, that review happens. The subagent's context is the previous 50 turns plus the turns pending settlement, and it may revise any turn it can see. Its task is three ordered steps:

1. Review and label every turn's `grade`, `type` and `tags` — confirming or overriding the mechanical draft, and grading against the recovered task-causality rubric.
2. Backfill notes for the turns in its window that have none, from their raw material.
3. Only then, assign segment membership by topic, over turns whose facts are now settled.

The order is the design. Segmentation consumes reviewed per-turn data; running it first is what made the union semantics vacuous.

## User Stories

1. As a reader of a recent session, I want each turn to show what kind of work it was, so that I can scan an arc without reading every title.
2. As a reader, I want a turn's type to be right rather than merely present, so that a `type:` filter returns what it claims.
3. As a reader, I want the milestone rows in a segment to reflect grades a model actually judged, so that the spine shows load-bearing turns rather than positional ones.
4. As a reader of a long arc, I want a turn graded early and later shown to be minor to be demoted, so that the spine does not accumulate false peaks.
5. As a reader, I want a segment's type to be the union of its members' real activities, so that the segment line summarises rather than guesses.
6. As the subagent, I want the mechanical draft presented as a draft, so that I know I am reviewing rather than reading trivia.
7. As the subagent, I want the rubric stated in full, so that I grade by the standard historical grades were assigned under.
8. As the subagent, I want to revise turns from earlier windows that are still in my context, so that a grade assigned before the arc's scale was visible can be corrected.
9. As the subagent, I want to settle per-turn facts before assigning segments, so that my segmentation reads settled data.
10. As the operator, I want the review to ride the settlement call that already runs, so that no new model call and no resident agent appears.
11. As the operator, I want a re-run over the same window to converge rather than oscillate, so that retries are safe.
12. As the operator, I want per-grade counts in the settlement job log, so that grading drift is visible without a query.
13. As a caller of `remember`, I want to correct one field without restating the rest, so that a targeted fix is a targeted write.
14. As a caller of `remember`, I want to clear a field, so that a wrong value can be removed rather than only replaced.
15. As a caller of `remember`, I want era turns writable, so that the review pass has a write path at all.
16. As a maintainer, I want an illegal type to leave the column empty rather than write an unknown word, so that the closed vocabulary stays closed.
17. As a maintainer, I want the rubric to have one home, so that the prompt and any calibration read the same words.
18. As a maintainer, I want an out-of-range grade or unknown turn address rejected at schema parse, so that a malformed response fails loudly.
19. As a maintainer, I want the mechanical derivation to be a pure function of the title, so that it can be re-run anywhere without a model.

## Implementation Decisions

**D1 — The review rides the existing settlement call.** No new model call, no second pass, no resident agent. This is the constraint the extraction-agent retirement established, and it is preserved: model work happens only inside a per-job structured call that already exists.

**D2 — The rubric is recovered verbatim and has one home.** Done, and pinned by hash. Historical grades were assigned under those exact words; a paraphrase forks the semantics silently.

**D3 — Per-turn directives are their own array, keyed by turn address, carrying grade, type and tags together.** Not fields on the note directive: notes cover only the turns needing backfill, while review must cover every turn in the window.

**D4 — The subagent may revise any turn in its context.** There is no absent-only rule. An earlier draft of this spec asserted one; it was an implementation-level predicate that had never been decided, and it is withdrawn. Idempotency means a re-run over the same input converges to the same values, not that a value can never change.

**D5 — Grades, types and tags are reviewed only for turns in the subagent's context** — the previous 50 turns plus the pending ones. Turns outside that window are untouched by this pass.

**D6 — The 50-turn lookback is the rubric's confirm-and-demote stage.** The recovered rubric tells its grader that a Grade 4 is provisional because settlement re-reads the arc later and demotes it by the arc's actual scale. Under D4 that promise is kept literally: a turn graded in one window is re-reviewed in the next, when more of its arc is visible. No framing sentence is added to the rubric, because none is needed.

**D7 — Type and tags are derived at insert time from the note title.** The title format `<activity>+<topic>: <text>` carries both. The derivation is a pure function of the title, callable without a model.

**D8 — Type comes from the closed vocabulary; an illegal word leaves the column empty.** Writing an unrecognised word would make a `type:` filter silently lossy; leaving it empty makes the gap visible and reviewable. Tags take the topic half as written.

**D9 — Segmentation is the last step and consumes reviewed facts.** A segment's type is the union of its members' activities, which requires members to have activities and to be allowed to differ from one another.

**D10 — `remember` gains two things**: era turns become writable (the era refusal is lifted), and a field can be explicitly cleared, distinct from being omitted. Its per-field patch semantics already exist and are kept.

**D11 — The printed grade is effGrade**, after victim demotion and corrector promotion, so the era and legacy columns mean the same thing. Done.

**D12 — Milestone selection and rendering reuse the legacy machinery unchanged**, scoped by segment instead of by day, with the segment line as the sole render anchor. Done.

**D13 — The settlement job log carries a per-grade histogram.** Grading drift has bitten before: after a model swap the middle grades ran roughly double their baseline share while the lowest starved and the highest went unused. The rubric's calibration targets ship beside it so drift is a comparison, not an investigation.

**D14 — History is not backfilled by this work.** Existing era turns keep their empty columns until a later unified re-labelling pass, which is out of scope here.

## Testing Decisions

A good test asserts observable behaviour at a boundary a caller uses, and does not re-pin selection internals already covered on the legacy path.

**Derivation** — a pure function over titles: the activity half maps to the vocabulary, an unrecognised activity yields an empty type rather than a written word, the topic half becomes the tag, and a title that does not match the format yields neither. Cheap unit tests, no database.

**`remember` write path** — an era turn is writable; a single field can be patched without restating the others; a field can be cleared and the cleared state is distinguishable from an omitted one; an out-of-range grade is rejected.

**Settlement writeback** — feed a canned structured response with per-turn directives and assert the database outcome: grade, type and tags land; a revision of a turn from an earlier window applies; a second application of the same response converges; a malformed directive fails the whole window rather than committing fragments.

**Arc render** — already covered by the shipped nesting work; extend only if the review pass changes what is rendered.

Prior art in every case is the existing settlement fixtures and the era-cutover fixtures, which already construct sessions straddling the boundary. Extend them rather than adding a seam.

## Out of Scope

- **Re-labelling history.** A later unified pass covers existing era turns; nothing here backfills them.
- **Segment granularity.** A segment's content budget is flat while its membership ranges from 1 to 44 turns, so per-turn fidelity falls as an arc lengthens. Separate ticket.
- **The settlement backfill's note-budget overshoot.** Mechanically reconstructed notes average 254 tokens of content against a 100-token budget, and preserve narration while dropping conclusions. Separate ticket.
- **`rolled-back` as a per-turn tag.** It is a session-arc role belonging to the segment, not an activity; it stays where it is.
- **Re-introducing a resident extraction agent.**

## Further Notes

Two of the three empty columns were never removed by anyone — they were half-built. Reading the presence of a computed draft as evidence that a field had been deliberately dropped inverts the design's intent; the tell is that producer and consumer landed in the same commit, so nothing was ever taken away.

The era cutoff normalises to null, and null means every turn is legacy, so all of this stays inert until an operator sets an epoch — which is also the rollback.
