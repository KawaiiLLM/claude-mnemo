# 05 — The split milestones card pays its chrome twice

**What to build:** NOT YET DECIDED — this ticket records a measured cost and
the design question it raises. It needs a user ruling before it can be
dispatched.

**Blocked by:** 03 (landed, `1317d61`) created the condition; 04 changes the
arithmetic that decides whether it is worth fixing.

**Status:** superseded by ticket 10 — user ruling 2026-08-28 [S15069/T1907]
answered the open question by deleting the category: the card renders no
segment title, no session lines, no Legend at all ("只需展示turn"). The three
sub-questions (labels, wording, Legend ownership) are moot.

## The measurement

Ticket 03 split the segment milestones card into an OLD part and a RECENT
part. Both parts are full `renderSegmentMilestoneSide` renders, so the card
now emits, twice:

```
[E70] Action-as-cosplay: NPC action roleplay — …      23 honest tokens
    [S15440] 从剧本编译转向引擎模拟的NPC动作训练管线      22 honest tokens
Legend: text ending in an ellipsis was truncated — …  54 honest tokens
```

Real E70 card, 2026-08-28, production DB read-only: 2504 chars / **692 honest
tokens**, of which 215 are chrome and **99 are pure duplication**. Against the
fitter's inflated currency (pre-04) that 99 costs roughly 250 budget-tokens —
which is most of the reason the row count fell from 23 (unsplit) to 17
(split). The recency win was real (newest visible row 08-11 → 08-15); it was
bought partly with rows, and part of that price was chrome, not content.

Criterion 4 of ticket 03 asked for exactly ONE `[E<n>] · milestones` hook-slot
header and got it. Everything below that header was never in scope. This is a
follow-up, not a defect against 03.

## The design question (the reason this is not dispatchable)

Deduplicating is not a mechanical edit — it forces a rendering decision the
user has not made:

1. **Do the two parts get labelled at all?** Today a reader sees two blocks
   with identical titles and no explanation of why there are two. Dropping the
   duplicate title makes them one visually-continuous list, which is cheapest
   but silently erases the boundary the whole split exists to create.
2. **If they are labelled, in whose words?** Something like `earlier` /
   `recent`, or a date-range hint, or nothing but a blank line. Any label is a
   new piece of prose the main agent reads every session, so it pays for
   itself only if it is shorter than the 99 tokens it saves.
3. **Does the Legend belong to the card or to the part?** It is a card-level
   instruction ("how to read an ellipsis, how to reach a `+N more`") and reads
   as such — one copy at the foot of the card is almost certainly right, but
   that makes the parts non-self-contained, which matters if a part ever gets
   rendered alone.

The session line (`[S15440] …`) is the one genuinely per-part element: two
parts can span different sessions, and often will.

## What to decide

- Whether to spend a ticket on this at all **after** 04 lands — 04's honest
  repricing roughly triples the seat count at the same budget, so the 99
  tokens go from "most of the missing rows" to a small constant.
- If yes: answers to the three questions above, in the user's own words.
