# 09 — Completion is proven, not attested

**What to build:** A window that wrote every field but crashed before segmenting stays incomplete, and a settlement attempt that lost its lease stops being able to write.

**Blocked by:** 08

**Status:** ready-for-agent

A `segmentation_complete` flag would be the agent's own claim, and the completion gate is specified to trust nobody. Segment membership is already persisted and add-only; the only fact the model cannot express is the negative one.

- [ ] A job-scoped exclusion record states that a turn was reviewed and belongs to no segment
- [ ] Completion is an anti-join over the frozen window: every segmentation-eligible turn is a member, or excluded for this job, or skipped
- [ ] The anti-join runs inside the same transaction as the completion compare-and-set
- [ ] Job id and claim generation are injected by the server, never passed by the model, and claimed ownership is verified inside each settlement write tool's own transaction
- [ ] A test reproduces the crash-after-membership sequence and shows the window stays incomplete
- [ ] The exclusion is job-scoped, not a column on the turn
- [ ] Full suite green
