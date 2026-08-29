# 04 — A touch ledger as durable as the writes it guards

**What to build:** the mandatory-disposition gate's `touched` set stops being
derivable-away. Two holes, both confirmed against source by the reviewer after
the eighth peer round (Codex, 2026-08-29, Standards P1-1 + Spec P1-1/P1-2):

1. **Destructive topology changes register no touch.** `laneTouches` is pushed
   in exactly two places: a landed `tags` write (the NEW set) and an ATTACHED
   edge's two lane sides. So a run that **retracts** the sole bridging edge, or
   **removes** a bridge member's lane tag, severs the lane while leaving it
   "untouched" — and `commit` passes with neither stitch nor justify. That is
   the exact guarantee ticket 02 sold.
2. **The touch set does not survive an attempt.** Direct writes commit
   immediately; the touch sets are in-memory on the engine instance. Attempt A
   lands a severing write and dies; attempt B rebuilds empty sets and sees an
   untouched fracture. Settlement caps attempts at 3, so retry is an ordinary
   path, not an exotic one.

**Blocked by:** none. Serialize AGAINST ticket 05 only in the sense that both
touch `src/db/lane-disposition.ts` — 05 is dispatched to the same worker, do 04
first and 05 second.

**Status:** resolved — landed as `29c29ee` (+ reviewer follow-up `565d359`);
every criterion re-checked per-item by the reviewer; suite 4070/0, tsc clean,
no `Bin` lines. Five touch sources now, constructive and destructive alike: an
attached edge's two lane sides, a RETRACTED edge's two lane sides, a landed
tags write's new set, the tags that write REMOVED, and a `justify`. The
ledger (`lane_run_touches`, job-scoped, `INSERT OR IGNORE`) is written INSIDE
the write's own transaction and `getRunLaneTouches()` returns durable ∪
in-memory. Reviewer mutation (deleting the retraction push loop, needle-
asserted, printed) turned 3 tests red; restored byte-identical, green.

DEVIATION on criterion 2, accepted as STRUCTURAL after the reviewer verified
the mechanism independently: the instant a bridge member's lane tag goes,
every edge side naming that lane on that turn is an **E4**
(`shared/lane-checker.ts`: "an edge one of whose SIDE tags is absent from that
side's own endpoint turn's tags"). `checkWindowLanes`'s gate runs before the
disposition gate and returns on first refusal. The worker asserted the touch
through `lane_check`'s disposition preview — the same
`evaluateLaneDispositionGate` call at the same seam — and pinned the E4
pre-emption so the next reader meets the reasoning rather than a puzzle. Any
future ticket wanting the disposition gate to LEAD here must reorder the
commit gates, not add a fixture.

CORRECTION (ticket 07, ninth peer round — recorded as a correction, not a
rewording). The sentence this paragraph used to carry — "a severing tag
removal ALWAYS meets an E4 first… no fixture shape avoids it" — is FALSE as
stated, and the argument for it was wrong twice over. It reasoned that the
removed-from turn "is by definition a cut vertex, so it carries ≥2 edge sides
naming the lane": a cut vertex of the lane's tagged-edge graph, not
necessarily an endpoint of the edges that make it one. The peer's
counterexample is `A -> V <- B` with only the cut vertex `V` inside the
writable set. Removing `V`'s lane tag severs `{A}` from `{B}`, and both edges'
violated sides anchor at their CITING turns (`A` and `B`) — the gate blocks
only anchors inside the writable set, so both E4s fall outside it and the
DISPOSITION gate is what speaks. The ticket's GUARANTEE (a tag removal cannot
sever and commit silently) still holds, and now for the right reason: the
durable `(segment, tag)` removal touch this ticket added is what refuses,
directly, with no E4 standing in front of it. The E4 pre-emption is a common
case, not a law.

HONEST GAP recorded, not laundered: the non-severing-retraction test cannot
be turned red by any mutation of this ticket's own diff — the worker verified
this rather than assuming it (mutating `computeLaneFractures` to emit a
fracture for a whole 1-island lane left it green, because the gate's
`componentCount <= 1` skip short-circuits first, and that skip is in a file
this ticket could not touch). It is a regression guard, not a
mutation-verified test.

Reviewer follow-up `565d359` took the worker's flagged naming debt: the
lane-addressed set was still called `justifiedLaneKeys` after gaining the
removal source, and the module comment still taught the pre-ticket-04 list of
three sources. Renamed `laneKeys`, comment rewritten.

## Decisions (settled — do not re-litigate)

1. **Touch = this run's LANDED engagement with a lane, in EITHER direction.**
   The three sources from ticket 02 stand and gain their destructive twins:
   - an edge side (attach) — unchanged;
   - a **retracted** edge's two lane sides — NEW;
   - a landed `tags` write's new set — unchanged;
   - the tags a landed `tags` write **removed** (previous set minus landed
     set) — NEW;
   - a `justify` — unchanged.
   `create`/`delete`/`merge` remain NON-sources (ticket 02's own list).
2. **The ledger is durable and job-scoped.** Touches persist as rows at the
   moment the write lands, inside the SAME transaction as the write (the
   engine already wraps every call in one — a touch that outlives a rolled-back
   write would be a new lie in the other direction). `getRunLaneTouches()`
   returns the union of the durable rows for this `jobId` and whatever this
   instance accumulated. Key the rows by job, NOT by claim generation: a
   reclaimed claimant inherits the obligation its predecessor created, which is
   the whole point.
3. **Storage follows the `phase_retype_audits` precedent** — an additive table,
   migration in the same place, no reuse of an existing table's columns.
4. **Out of scope:** the receipt-binding defects (ticket 05); anything about
   phase connectivity (ticket 06); changing WHICH fractures are computed.

## Acceptance criteria

- [x] Retracting the sole bridging edge of an otherwise-whole lane leaves that
      lane touched — `commit` refuses without a stitch or justify. Asserted at
      the settlement seam, not by unit-testing the push site.
- [x] Removing a bridge member's lane tag (a landed `tags` write whose new set
      drops the tag) leaves that lane touched — same refusal.
- [x] A retraction that does NOT sever (the lane stays whole) still refuses
      nothing — touch is not by itself an obligation.
- [x] Touches survive across engine instances for the same job: a fixture that
      lands a severing write on one engine, discards it, and builds a second
      engine on the same DB and job still refuses the commit.
- [x] A rolled-back write leaves NO touch row (drive a refusal inside the
      write transaction and assert the table is empty).
- [x] Touch rows are job-scoped, not claim-scoped: a claim-generation bump
      inherits the obligation.
- [x] The lookback non-blocking property from `e655cd8` still holds — the two
      pinned lookback-only tests stay green.
- [x] Every new/changed test mutation-verified (backup after implement,
      needle-assert + print, red, md5 restore, green).
- [x] `npx tsc --noEmit` clean, `node scripts/build.js` succeeds, `bun test`
      green; baseline 4052/0 — account for every delta.

## Notes

Production DB strictly read-only. Do not tick your own boxes — report
per-item; the reviewer ticks. Do NOT edit
`src/worker/note-settlement-sdk-query.ts` (ticket 06's territory) — if the
gate call site genuinely needs a change, say so in the report and stop.
Treat any `Bin` line in `git diff --stat` on a `.ts` file as a hard stop.
