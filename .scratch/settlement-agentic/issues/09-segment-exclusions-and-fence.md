# 09 — Completion is proven, not attested

**What to build:** A window that wrote every field but crashed before segmenting stays incomplete, and a settlement attempt that lost its lease stops being able to write.

**Blocked by:** 08

**Status:** ready-for-agent

A `segmentation_complete` flag would be the agent's own claim, and the completion gate is specified to trust nobody. Segment membership is already persisted and add-only; the only fact the model cannot express is the negative one.

- [x] A job-scoped exclusion record states that a turn was reviewed and belongs to no segment
- [x] Completion is an anti-join over the frozen window: every segmentation-eligible turn is a member, or excluded for this job, or skipped
- [x] The anti-join runs inside the same transaction as the completion compare-and-set
- [x] Job id and claim generation are injected by the server, never passed by the model, and claimed ownership is verified inside each settlement write tool's own transaction
- [x] A test reproduces the crash-after-membership sequence and shows the window stays incomplete
- [x] The exclusion is job-scoped, not a column on the turn
- [x] Full suite green

## Closed

`note_settlement_segment_exclusions(job_id, turn_id, created_at_epoch)` plus
`src/db/note-settlement-completion.ts`. 440366c, 1733 pass.

Eligibility is ticket 08's `isEligibleCoverageTurn` reused, not re-derived. The
fence, the anti-join, the coverage recheck and the compare-and-set share one
`BEGIN IMMEDIATE`, and crash-after-membership then falls out rather than being
designed: membership written and the exclusion not yet leaves the turn absent
from both sets, which is exactly a gap, and the job stays claimed so a retry
re-adjudicates the remainder.

**The generation race is not what the same-transaction rule buys.**
`completeNoteSettlementJob`'s own compare-and-set re-verifies
`claim_generation` at the instant of the write regardless of transaction
boundaries, so a stale generation is caught either way. What the shared
transaction closes is a *lazy* CAS — ownership checked once at the top, then a
generation-blind `UPDATE` — and a coverage-regressing write landing between
check and write in a real multi-process deployment. The interleave test targets
that failure, not the one the correct CAS already prevents.

**Judgement calls made, neither settled by the documents.** The cursor advance
is inside the gate, because the existing write-back always pairs it with
completion in the same transaction and a cursor that does not move with
completion wedges every later window. And the fence throws while the gate
returns a discriminated result: a lost lease is exceptional, "segmentation
incomplete" is routine.

`assertNoteSettlementJobClaimed` is the reusable primitive; ticket 10 wires it
into the settlement write tools. **The gate has no production caller until
then.** Also added the new table to `resetSchema`'s drop list, which the
implementation missed.
