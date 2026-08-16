# 14 — A segment is one arc of work, and it carries the impression rather than a retelling

**What to build:** A segment stops being an unbounded chapter and becomes one arc of work, anchored where the grading already says the arc begins, carrying what reading its member turns would not give you.

**Blocked by:** 10c

**Status:** ready-for-agent

Spec **section K** is the whole ticket. Read it before anything else; it also records what was deliberately left out and what would reopen each.

This is an **MVP to be run and looked at**, not a finished mechanism (user ruling). Granularity cannot be tuned yet: 699 of 11,673 turns carry a segment, and the project whose interleaved threads motivated the partition question has none at all.

- [ ] The partition is stated as the arc: a Grade 4 opens a segment, the next Grade 4 closes it, a Grade 3 attaches to its nearest preceding Grade 4. The prompt says this in the rubric's own terms rather than inventing a second vocabulary for it
- [ ] `insight` joins the segment's fields, with the segment semantics of K5 — the most reusable conclusion, including the routes ruled out and why — and **is added to `reconcileSegmentCitedPairs`'s scan in the same change**, or a citation written there looks real and produces no edge
- [ ] The no-retelling rule reaches the prompt in a checkable form: anything readable from the member turns does not go in the segment
- [ ] A segment whose task is still live is **not closed at window end**. Today 32 of 42 segments are `delivered` and only 1 of 42 spans a session boundary, which is why nothing accumulates across sessions
- [ ] The prompt distinguishes the two roles a segment plays by lifecycle: an open segment is the task's working state, a delivered one is its impression
- [ ] The prompt states that members are exhaustive attention allocation while body citations are the load-bearing few — the existing "cite the turns that carry the conclusion, not every member" rule, kept and made explicit
- [ ] Full suite green

## Not in this ticket, and why

Splitting, merging and member removal are unnecessary while membership is many-to-many — a mis-cut segment is abandoned and re-created, and its turns belong to both. A segment-level `continues` relation, and a mechanical coupling check over shared files and turn-to-turn citations, are both deferred with their reopening conditions written into K8.

## How it gets judged

By eye, on real sessions with genuinely interleaved work — not by a proxy metric:

**Recalling one task must not drag another task's memory along with it.**

The first honest check is `action-roleplay`, whose card-extraction and harness lines run interleaved and which has zero segments today.
