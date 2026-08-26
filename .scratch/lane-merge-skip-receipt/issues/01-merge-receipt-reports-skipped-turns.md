# 01 — A lane merge's receipt reports the turns it skipped

**What to build:** when `remember(merge)` folds a lane away, an operator reading the
receipt can tell whether any turn still carries the folded word. Today the receipt
reports only what it moved, so a merge that leaves a dead tag behind on some member
turns reads exactly like one that moved everything.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

## Why

Observed live on 2026-08-27 while folding E60's twelve name-root lane families
(23 merges). `lane-declaration` carried 20 turns; the receipt said
`member turns retagged: 9` and nothing else. Eleven turns still hold
`lane-declaration`, a word whose lane row no longer exists.

The cause is a disagreement between two definitions of membership:

- `mergeLaneTag` (`src/db/lanes.ts`, the member query at the top of the function)
  selects turns by `segment_members` — specifically `MIN(sm.segment_id) = <segment>`.
- The rubric, and the `note` tool's own receipt ("Now belongs to E60, derived from
  its tags"), say a turn belongs to the task whose tag it carries.

When the two disagree the merge silently skips the turn. Measured at the time:
1890 turns carry `claude-mnemo`, 1801 have an E60 `segment_members` row, and **89
have no membership row at all** (63 in S15069, 15 in S21460, the rest scattered
across older sessions). No turn had a `MIN()` owner other than 60, so the tie-break
was not involved — the gap is turns with a tag and no row.

The existing receipt already argues for itself in a comment: *"a bare `done` would
hide a lane that turned out to be empty, or a collision that deleted a row."* It
names dedup and collisions and stops there. A skipped turn is the same class of
hidden outcome and is missing from the list.

## Scope

**This ticket does not decide which definition of membership wins.** Reconciling the
89 drifted turns is separate and needs a ruling first (tags as truth, or the
membership table as truth). Here the merge only has to *say* what it did not touch.

## Acceptance criteria

- [x] The merge receipt names, as its own line, how many turns still carry the folded
      tag after the merge — turns that match the tag but fell outside the member query.
      Zero is the ordinary case; the line may be omitted when the count is zero, but a
      non-zero count must never be silent.
- [x] The non-zero line is specific enough to act on: it says the count and enough to
      find them (the addresses, or the addresses up to a stated cap with the remainder
      counted).
- [x] The count is computed from the same tag predicate the member query uses, minus
      the member restriction — not a second hand-written tag test that could drift from
      the first.
- [x] The task-tier merge (`verb=merge` without `tag`) is reviewed for the same hole
      and either fixed the same way or shown not to have it, with the reason recorded.
- [x] A test drives a merge where one tagged turn has no `segment_members` row and
      asserts the receipt reports it. Mutation-verify it: remove the reporting line and
      the test must go red.
- [x] A test asserts the zero case stays quiet, so the new line cannot become noise on
      every ordinary merge.
- [x] `npx tsc --noEmit` clean, `node scripts/build.js` succeeds, `bun test` green.

## Resolution (2026-08-27)

- `LaneMergeReceipt.stillCarrying` and `SegmentMergeReceipt.stillCarrying` (both
  `readonly string[]` of `S<session>/T<prompt>` addresses) carry the population;
  `handleMergeLane`/`handleMergeTask` (mcp/remember.ts) only render it, capped at 10
  addresses + `… +N more`, omitted entirely at zero.
- Lane tier (`mergeLaneTag`, db/lanes.ts): the stillCarrying query is the member
  SELECT's own tag `CASE`, its `MIN(segment_id) = ?` restriction dropped, read
  immediately after the member retag loop (population "1b"). A captured member's
  `from` is gone from its `tags` by the time this runs, so a match is definitionally
  outside the member query, never a prediction.
- Task tier (`mergeSegments`, db/segments.ts) HAD THE SAME HOLE and is fixed the same
  way (population "2b"): population 2's member SELECT is purely `segment_members`-
  shaped with no tag predicate to subtract, so this is a fresh query over
  `fromTag` (the source task's own tag, `segmentTagOf`), read after the retag loop.
  Unlike the lane tier, no cross-segment false positive is possible here — a segment
  tag is GLOBALLY unique (`idx_segments_tag_unique`) — so every task-tier hit is a
  genuine orphan.
- Judgment call, flagged rather than silently resolved: the lane tier's predicate can
  surface a turn that legitimately belongs to a DIFFERENT segment's own
  identically-named lane (lane tags are NOT globally unique — only lane-vs-segment-tag
  collisions are refused). Decision 3 ("same predicate minus the member restriction,
  not a second hand-written test") was read literally rather than adding a second
  ownership check; the wording in decision 4 ("not members of E<id>") stays factually
  true either way. Locked down by its own test:
  `tests/db/lanes.merge.test.ts` — "a turn belonging to a DIFFERENT segment's
  identically-named lane also surfaces here".
- Tests: `tests/db/lanes.merge.test.ts` (4 new, `describe("stillCarrying …")`),
  `tests/db/segments.merge.test.ts` (3 new), `tests/mcp/remember.test.ts` (5 new,
  both tiers, including a >10-address cap test). All four mutation-verified (receipt
  field forced to `[]` / render guard forced to `false`; confirmed red, restored from
  a post-implementation backup, confirmed green).
- `bun test`: 3884 pass / 0 fail (baseline 3872 + 12 new tests).

## Notes

The eleven live orphans from the incident are still in the production database. They
are evidence, not a cleanup target for this ticket — do not write to
`~/.claude-mnemo/` from this work.
