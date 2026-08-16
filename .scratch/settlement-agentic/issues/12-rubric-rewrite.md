# 12 — The grading rubric stops naming mechanisms that no longer exist

**What to build:** A grader following the rubric literally can carry out what it says.

**Blocked by:** 10c

**Status:** done

The recovered rubric still orders the grader to tag a casualty `rolled-back` and lower its grade through a `regrade` verb. Neither exists: the word left the vocabulary and grades are stated directly.

- [x] The correction clause says to write a `supersedes` edge to the overturned turn and grade it by its surviving task-causal consequence
- [x] It keeps the constraint that this happens only on witnessed disproof or rollback evidence, never from a guess
- [x] Grade definitions and calibration targets are unchanged
- [x] The rubric is imported from its single home, never restated
- [x] Full suite green

## Closed

The ticket's premise was half-stale: the rubric no longer ORDERED tagging a
casualty `rolled-back` — a prior ticket had already flipped that clause into a
prohibition. Only the `regrade` verb was still a live impossible instruction,
in three places (the downgrade bullet, both Bridge-Grade-4 mentions, the
closing call-syntax paragraph).

**One over-correction, reverted.** The implementing acceptance criterion read
"no `rolled-back` tag remains in the rubric" and was carried out as a token
hunt, deleting the prohibition sentence along with the word. That was a
weakening, not a cleanup: `REVERSED_ROLE_TAGS` in `mcp/timeline.ts` still reads
the tag as a reversal role, the tag field carries no vocabulary check, and 537
production turns already hold it. The rubric sentence is the only thing between
a grader and that write, so the prohibition is restored and must NAME the word
— a grader carrying the old habit needs something to recognise. The `regrade`
verb is genuinely inert (no call-site counterpart) and stays deleted.

The two retirements are not the same kind of thing, and the pinning test now
says so.
