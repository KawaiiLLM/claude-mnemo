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
- [ ] **`type` and `tags` are derived from the members, and the segment tool stops accepting them** (spec K5a): type is the union of member activities, tags are the member tags ordered by frequency. This finally enforces A6, which asserted the union as the reason the three duties are ordered and was never checked — the tool accepted a stated type that could contradict every member. Recomputed on membership change, because segments are FTS-indexed with their tags
- [ ] The settlement context shows the **50 most recently active segments with their topics**, and renders the topic registry **ordered by frequency** — how many segments carry each — so an established name is visibly established and a one-off is visibly a one-off. This is the anti-fragmentation surface D9's `noCandidateReason` gate has always assumed and never actually provided
- [x] **`recall` can query segments.** Design is the implementer's to make: no selector grammar, output shape or ranking is prescribed here beyond the one requirement below
- [ ] Full suite green

## The only thing `recall`'s segment query must satisfy

It is judged by the acceptance test at the bottom of this file, not by a
selector grammar. Recalling one task must not drag another task's memory
along. Everything else — how a segment is addressed, what a collapsed segment
row looks like, whether members are previewed, how results rank — is yours to
decide, and worth deciding against how `recall` already renders sessions and
turns rather than inventing a third shape.

## Not in this ticket, and why

**Segment-asserted relations** (spec K7a, user ruling): the segment tool gets no relation fields. A segment still gains bare pairs from its own body citations, and the link between two arcs is carried by the turn edges crossing their boundary — derived from members rather than restated a level up.

Splitting, merging and member removal are unnecessary while membership is many-to-many — a mis-cut segment is abandoned and re-created, and its turns belong to both. A segment-level `continues` relation, and a mechanical coupling check over shared files and turn-to-turn citations, are both deferred with their reopening conditions written into K8.

## How it gets judged

By eye, on real sessions with genuinely interleaved work — not by a proxy metric:

**Recalling one task must not drag another task's memory along with it.**

## Half closed: `recall`'s segment query already existed, and nobody could find it

The capability was built and shipped under an older spec section (D11, since
reorganised into K): `recall.ts`'s `E<n>` / `E*` / `E5..9` route, the segment
layer in `search.ts`'s `searchMemory`, and `segment-spine.ts`'s header
rendering with its `[open]` / `[delivered]` tag. **Eighteen tests already
covered it and all passed at baseline** — verified against `HEAD` before the
claim was accepted.

The only real gap was that `MNEMO_TOOL_DESCRIPTIONS.recall`, the text the
calling agent actually reads, never said segments existed. So a working
capability was undiscoverable by the one reader K1 built it for — this
effort's recurring defect class arriving inverted: not storage written where
nothing reads, but a read path nothing was told about.

The isolation the acceptance test asks for is **structural, not incidental**:
`rankSegmentMembers` scopes every member lookup by `segment_id`, and
`querySegmentsByScope` scopes every tag, type and text filter by the
segment's own id. Both were shown to discriminate by injecting a scoping leak
and watching the tests go red.

**The acceptance test passes on a constructed fixture and is NOT claimed on
production.** The corpus has no genuine two-interleaved-threads example to
check against: the one multi-segment session is chapter succession with soft
boundary overlap, not sustained alternation — K8a's own admission, reached
from the other direction. Four production turns do belong to two segments
each, which is K6's many-to-many working rather than dragging.

### Follow-up this surfaced

`plugin/skills/mnemo-recall/SKILL.md` — the skill document that teaches the
three read axes — still does not mention segments or the `E` selector at all.
The same defect as the tool description, one surface over. Belongs with this
ticket's remaining half.

The first honest check is `action-roleplay`, whose card-extraction and harness lines run interleaved and which has zero segments today.
