# 01 — Grants die with the context, not with the process: wipe at compact, survive exit

**What to build:** the read-grant lifecycle tracks what the conversation's
model can actually still see (user ruling S15069/T1505: 「应该改为compact后
才清空一次授权」). Today it is exactly backwards, in both directions:

- SessionEnd wipes the session writer's grants (`session-end.ts:229`) —
  but a plain resume reloads the FULL transcript, so the model still sees
  every read it made; the wipe destroys sound authorization for nothing.
- PreCompact (`hooks/handlers/compact.ts`) wipes NOTHING — but compact is
  the event that actually destroys the context the grants were earned on;
  a post-compact session keeps whole-field write licenses over text it
  can no longer see. That is a soundness hole, not just friction.

Changes:

1. The PreCompact handler calls
   `clearReadGrantsForWriter(sessionWriterId(session.id))` once — grants
   AND field-completeness records go together (the existing function
   already clears both). Post-compact, the first foreign-field or
   relation write correctly demands a fresh read.
2. SessionEnd stops clearing. The janitor
   (`sweepReadGrantsForCompletedSessions`) re-keys from "session
   completed" to AGE: sweep grant rows untouched for 30+ days (pure
   table hygiene — a dead session's grants license nothing, and an aged
   resume that somehow returns after that simply re-reads). With age as
   the key, the sticky `completed_at_epoch` marker (never cleared on
   resume — a separate latent defect) stops affecting grants entirely;
   clearing that marker on resume stays OUT of this ticket's scope.
3. Freshness and delivery-atomicity are untouched: a surviving grant
   still only licenses overwrites of fields unchanged since the read
   (`writeSequence` comparison), which is exactly right when the resumed
   context genuinely contains that read.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] PreCompact wipes the session writer's grants + completeness; pinned
      through the real hook handler
- [ ] SessionEnd no longer clears; a simulated exit + same-writer
      continuation keeps its pre-exit grants and a whole-field overwrite
      of an unchanged foreign field succeeds without a re-read
- [ ] The freshness guard still refuses when the field changed after the
      pre-exit read (grant survival never bypasses staleness)
- [ ] The janitor sweeps by age only: a completed-but-recent writer's
      grants survive another session's SessionEnd; 30-day-stale rows go
- [ ] Relations gate consistency: post-compact, an edge write without a
      fresh relations read refuses; pre-compact-earned relations
      completeness does not survive the wipe
- [ ] Territory: src/hooks/handlers/compact.ts,
      src/hooks/handlers/session-end.ts, src/db/write-gate.ts (sweep
      re-key only), their tests. NOT recall/note surfaces (grant
      RECORDING is untouched)
- [ ] Load-bearing properties declared for mutation acceptance
