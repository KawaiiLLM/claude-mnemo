# 05 — Settlement commit refuses while in-scope errors remain, judged against an immutable writable set

**What to build:** the settlement `commit` tool runs the checker's error
computation over the job's scope and REFUSES to commit while any error
anchors inside the job's IMMUTABLE WRITABLE SET, naming each offending
row, its rule, and its anchor. Spec: `.scratch/tag-mandate/spec.md`
sections "The commit gate", "Anchoring and repairability", and the pull
architecture's "writable set is IMMUTABLE and declared" bullet.

- The writable set is computed at dispatch time — window + declared
  lookback — and the declared lookback closes over the external endpoints
  of every edge anchored in-window (the deadlock guard). The set is data
  on the job/dispatch (ticket 06 will print it into the prompt).
- Errors anchored OUTSIDE the set never block this commit.
- A commit refusal is not an attempt failure; attempts exhaust only on the
  existing failure paths. The refusal payload is the repair list.
- Exemptions flow from the checker (compact, legal skips) — no second
  exemption logic here.

**Blocked by:** 03 (the error computation with anchors). E5 instances flow
in automatically once 04 lands — no change here.

**Status:** done (mutation-verified: anchor filter neutered → 1 red; closure liveness dropped → 1 red; one-hop closure ruling accepted — fixpoint cascade would contradict window-by-window cleaning)

- [ ] A window with one in-scope-anchored error refuses commit naming it;
      repair then commit succeeds; the same error anchored outside the set
      commits clean
- [ ] Writable-set computation pinned: lookback closure includes external
      endpoints of in-window-anchored edges
- [ ] Refusal consumes no attempt (pinned); real-handler discipline (the
      note-settlement-sdk-query test style)
- [ ] Load-bearing properties declared for mutation acceptance
