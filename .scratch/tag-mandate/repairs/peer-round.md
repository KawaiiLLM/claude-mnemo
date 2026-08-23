# The single peer cross-review round (T1466) — findings ledger

Scope reviewed: b172321..0787e09. Verdict: not ready; 8 P1, 9 P2. This file
is the repair spec; tickets RA/RB/RC partition it. Confirmed-clean
dimensions (do not re-litigate): rubric text & R1-R4/C1-C3; E5 instance
semantics; E1/E3 seed repair itself; E4; writable-set freeze/transport;
writer identity & lease fencing; timeline zero-grant; pushed session
context's session-only grant; relations read rendering; verbatim
integration; field order; shape echo; thinking-config; console focus fix.

## P1

1. commit/lane_check PROJECTION smaller than the immutable writable set:
   checkWindowLanes seeds the checker with windowStart..windowEnd only and
   filters anchors afterwards — errors living in lookback/closure but not
   edge-connected to the window never LOAD, so filtering cannot recover
   them (lookback E1/E3 invisible; E2 whose external endpoint never joins
   allTurnIds invisible). FIX: loader gains an explicit turn-id seed;
   settlement lane_check and commit build the SAME projection from the
   frozen writableTurnIds; real-handler tests for lookback E1/E3 and
   external-endpoint E2.
2. E2 on frozen `supersedes` is unrepairable — no retraction tool exists
   outside the eight current words → permanent commit deadlock. FIX: a
   RETRACTION-ONLY `retractSupersedes` on both write paths; never restore
   the assertion; test refuse→delete→same-run commit.
3. An E5 extra-SOURCE anchor owns no repairable edge (a source has no
   outgoing row; the deletable row belongs to a possibly-unwritable
   citer). FIX RULING (T1466): E5 anchors move to the EDGE-OWNING CITER —
   an extra sink anchors at itself (it cites); an extra source anchors at
   the deterministic earliest citing side among its incoming in-lane
   edges. Anchor = repair power BY CONSTRUCTION, same principle as
   E1/E2/E4's citing anchors. Spec + render wording sync.
4. Block A's coverage fields omitted title and insight (explicit fields
   REPLACE the defaults) — authored text already amended (T1466); sync
   the production prompt and the verbatim pins.
5. The prompt allowed a no-op exit without commit, colliding with the
   job's only done-transition; "exactly one commit" also let a gate
   refusal read as the spent commit. Authored text amended: exit only
   through ONE SUCCESSFUL commit; a refusal never counts. Sync production.
6. recall records grants/completeness BEFORE the worker envelope's 100K
   truncation — undelivered tail entities/fields still license whole-field
   overwrite. FIX: grants/completeness derive from the FINAL delivery
   envelope, only for entities and complete fields the delivered bytes
   actually contain.
7. A stale `complete:true` reactivates via any unrelated-field recall
   (grant sequence refreshes, completeness boolean survives; gate never
   compares completeness sequence to the field's write sequence). FIX:
   completeness.sequence >= fieldStamp.writeSequence; bind
   grant/completeness to one render generation.
8. Relation mutations have no dedicated read-grant/completeness/revision:
   attach/retract borrow the type gate and stamp nothing — the pull
   story's "relations recall earns the write" is not consumed by the
   gate. FIX: a citing-turn-level relations gate + revision stamp;
   relations render records completeness/revision; every attach/retract
   stamps; mutation requires the current claim to have read the latest
   relation set.

## P2

1. Non-empty type/tags whole replacement should require a COMPLETE
   metadata read (today an entity grant from a content-only read
   suffices — silent lane/identity tag deletion).
2. Settlement's generic-recall paths still grant beyond delivery:
   session detail grants previewed turns; an empty observation page
   grants parent turn/session before pagination. Settlement grant policy:
   session detail → session only; observation route grants only what the
   final envelope delivers; empty/error pages grant nothing.
3. Turn-targeted mutations don't re-check turn liveness inside the
   mutation transaction (a turn skipped/rolled back mid-run still takes
   writes; commit loader then ignores the dead node). One shared live-turn
   check inside the transaction for note writes, proposals, reassigns.
4. The settlement top-level note description still teaches "bare or
   tagged" for all eight words — split assertion (mandatory tags for
   extends/narrows) from bare legacy retraction; add to the
   teaching-surface guard.
5. Block B step 4 lacked verifies/refutes routing — authored text amended
   (a check THIS turn produced routes to verifies/refutes, never
   extends); sync production + pins.
6. A malformed mode.* rejection passes address=null even when
   rawInput.turn is valid — the consecutive-loop escalation never fires
   for repeated malformed edits. Derive the label from the raw turn before
   mode parsing; null only when genuinely unaddressable.
7. The E5 repair copy calls proper-superset unconditionally "branch" —
   independent chains take independent exact sets; proper-superset is a
   BRANCH only when rooted at a parent-lane node. Fix the copy.
8. lane_check's settlement text caps at 50 errors while commit judges the
   uncapped list — the same-list teaching breaks at 51+. Settlement
   surface renders uncapped (CLI may keep its cap with the true-total
   count line).
9. The exact-set loader compares `canonicalTagSet(...).join("")` —
   delimiter collision can pull another exact set's edges into
   checker/commit. Use the shared collision-free lane token / canonical
   JSON compare.
