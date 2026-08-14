# 05 — The settlement subagent reviews every turn, then segments

**What to build:** The settlement subagent stops being a segmenter that happens to see turn facts, and becomes a review pass that segments last. Over its context — the previous 50 turns plus the turns pending settlement — it performs three ordered steps:

1. Review and label every turn's `grade`, `type` and `tags`: confirming or overriding the mechanical draft, and grading against the recovered task-causality rubric stated in full.
2. Backfill notes for the turns in its window that have none.
3. Only then assign segment membership by topic, over turns whose facts are now settled.

The order is the point. A segment's type is the union of its members' real activities, which is vacuous while members have no activities — segmenting first is what made it so.

It may revise any turn it can see, including turns settled in an earlier window. That is not a loophole but the mechanism the rubric already assumes: it tells its grader that a Grade 4 is provisional because settlement will re-read the arc and demote it by the arc's actual scale. The 50-turn lookback is where that happens, so a grade assigned before an arc's length was visible gets corrected when it is.

The job's structured log gains a per-grade histogram. Grading drift has bitten before — after a model swap the middle grades ran near double their baseline share while the lowest starved and the highest went unused — and the rubric's calibration targets now sit beside it, so drift is a comparison rather than an investigation.

## Three things found while building the tickets before this one

**A race, and it is real.** Lifting the era write refusal also removed the read-decide-write that used to make a concurrently-committed `note` unclobberable. The main agent writes notes *while its turn is still running*, so the interleave is not hypothetical: the worker reads a row, the agent commits a note, the worker writes its older view over it. Revising a turn deliberately is in scope; overwriting a note that landed after the read is stale-data clobber and is not. This needs a fence — re-read inside the write, or a compare-and-set on the row's updated timestamp — not a judgement call at implementation time.

**A stale type can survive a corrected title.** The insert-time draft only writes when the title parses. Correct a title from a parsing shape to a non-parsing one and the old type stays. The explicit-clear expression now exists (`null` means clear, `undefined` means omit), so this is closable.

**The prompt shows a draft that is not the stored one.** The per-turn `type_draft` rendered into the prompt is computed by a loose prefix scan, while the value actually stored comes from a stricter shape check. They disagree on titles like `review the extraction spec`. The subagent believes it is reviewing what is stored; it must be.

**Blocked by:** 01 — rubric recovered (done, `298be49`); 02 and 04 — drafting and per-field writes (done, `a207794`).

**Status:** done

- [ ] The response carries a per-turn array of grade, type and tags, separate from note directives — notes cover only the turns needing backfill, review covers every turn
- [ ] Every turn in the window receives a per-turn directive, including turns that already have agent-written notes
- [ ] The prompt presents the mechanical draft *as a draft* to confirm or override, rather than as an unexplained fact on the turn line
- [ ] The draft shown in the prompt is the same value that is stored — one derivation, not a loose one for display and a strict one for the row
- [ ] The prompt states the rubric in full by importing its single home, never by restating it
- [ ] The prompt states the three steps in order, and that segmentation is last and consumes reviewed facts
- [ ] A turn from an earlier window that is still in context can be revised, and the revision lands
- [ ] **A note committed after the worker read the row is not overwritten by the worker's older view** — fenced, with a test that reproduces the interleave rather than asserting the fence exists
- [ ] A corrected title that no longer parses clears the stale type rather than leaving it
- [ ] Re-running the same window converges to the same values rather than oscillating
- [ ] A malformed directive, an out-of-range grade, or an unknown turn address fails the whole window rather than committing fragments
- [ ] The job's structured log line carries a per-grade histogram
- [ ] Segment membership is assigned from reviewed per-turn facts, and a segment's type is the union of its members' reviewed activities
- [ ] Tests at the settlement writeback seam, extending the existing fixtures rather than adding a seam
- [ ] Full suite green

## Watch, but not this ticket's job

An `undone` sidechain row is refused by `note` — "a sidechain row is not part of this session's arc" — and is not refused by `remember`. Legacy always had that gap and never exercised it. If this review pass's window can ever contain a sidechain row, it becomes reachable and needs its own decision. Report whether it can; do not fix it here.

**Answer: it can.** The window is a plain `prompt_number` range over the session's turns with no status filter. A sidechain row borrowing a `prompt_number` inside the range is classified `skipped` — excluded from *owed*, so no note is reconstructed for it — but it is still rendered as a window turn and still resolves as a legal `turn_review` address, and duty 1 asks for a verdict on *every* window turn. So the review pass grades and types rows that `note` refuses to touch. Needs its own decision; not decided here.

## What the fence turned out to be

The first implementation read the row fresh immediately before writing and called that the fence. It is half of one. Freshness protects a *merged* value (the non-topic tag slice) from a stale copy of the list; it does nothing for a *verdict*. `type` and `tag` are facts about the note — derived from its title on every other write path — so a review of a turn whose note arrived during the model call is a review of a document that no longer exists, and re-reading the row only writes the stale judgement onto fresh data more accurately.

The missing half: when the current note is `agent`-origin and its `updated_at_epoch` is at or after the job's claim, the note-derived verdict stands down and only `grade` lands. Grade judges what the turn did, off raw material no later note can change, and no other writer competes for the column. The reconstruction loop one level up had already ruled the same way — `WHERE writer_origin != 'agent'` makes the agent's account win — so without this the review would have overturned that ruling inside the same transaction that made it.

A cross-review then found three more, all fixed: the boundary was the job's *claim* rather than the context read (nullable, and a note arriving between the two was misjudged as late); an omitted `type`/`tag` was read as an explicit clear, so a lazy or truncated reply silently wiped those columns across a window and its lookback — absent is now a schema violation, `null` still clears; and `turn_review` addresses resolved through the session-lifetime exposure ledger, letting a hallucinated address land a destructive write on a turn from an older window — they are now gated on what this prompt actually rendered.

The first test was green against an unfenced implementation: it watched `title`/`content`, which the write-back never names and which therefore survive by construction. The columns the two writers actually contend for are `type` and `tags`; pinning those makes the same interleave go red.
