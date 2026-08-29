# 07 — A receipt for what was delivered, and an obligation that can be discharged

**What to build:** the three defects the ninth peer round found in ticket 05's
receipt/justification repair, plus two P2s and one documentation correction.
Each was reproduced against source by the reviewer before this ticket was
written; none is a hypothesis.

1. **P1 — the receipt credits members nobody saw.** `recordLaneReadReceiptForRoute`
   computes `paginateItems(membershipTurnIds, page, pageSize).items` itself and
   writes the receipt BEFORE `renderRoutedId` runs. What the render actually
   emits can be smaller (its own page/turn budgets pack items and push the rest
   to the next page), and the worker envelope then cuts the response to a
   100,000-character prefix. Ticket 05's rule was "the member ids this call
   actually RENDERED"; the code records the ids it SELECTED.
2. **P1 — the obligation can be impossible to discharge.** `loadLaneCheckScope`
   applies NO era filter (grep: zero era references in `db/lane-checker-load.ts`),
   so the checker's island membership can contain pre-cutoff turns; recall's lane
   membership IS era-scoped (`chronologicalSegmentMembers(db, segment, eraCutoffEpoch)`)
   and settlement's handler forces the cutoff; the era grant lands at COMMIT,
   which the disposition gate precedes. A lane whose other island holds an
   ungranted pre-cutoff member therefore owes a justify that no sequence of
   calls can satisfy. The old page arithmetic laundered this by accident;
   member-id coverage is correct and is what exposed it.
3. **P1 — the full-content grant is never checked for freshness.** `evaluateJustify`
   tests `grant.complete` alone. This codebase's own whole-field authorization
   compares the completeness sequence against the field's write stamp
   (`db/write-gate.ts:756`, `completeness.sequence < stamp.writeSequence`) —
   forty lines from the function justify calls. Another writer changing the
   representative's content inside the same claim leaves the stale grant
   accepted, and the justification it authorizes is persistent. The reviewer's
   earlier "claim scoping already bounds this" rejection was wrong on the
   argument: claim scoping stops cross-claim reuse, not intra-claim staleness.
4. **P2 — comma-list lane recalls earn no receipt.** The single-id branch records
   one; the comma-list branch calls `renderRoutedId` directly, so
   `recall(id="E1/#a,E1/#b")` visibly delivers both lanes and credits neither.
   This under-credits (it refuses justifies that should pass), which is the safe
   direction, but it is still wrong.
5. **P2 — the two walks disagree at exactly 500 hops.** The pure walk accepts a
   basis discovered on hop 500; the loader runs 500 frontier batches and so loads
   types only through distance 499, discovering the distance-500 node without its
   type. Pure graph says REACHED, loader says UNKNOWN. Conservative, but twins
   that disagree are a defect.

**Blocked by:** none — 04, 05 and 06 have all landed.

**Status:** ready-for-agent

## Decisions (settled — do not re-litigate)

1. **USER RULING [S15069/T1964]: the read obligation is over the era-VISIBLE
   members of the other island.** A member the reader is structurally forbidden
   to see is not part of what the reader owes. The alternatives were put to the
   user and rejected: extending settlement's read reach through the era filter
   (it moves era semantics, whose blast radius is larger than this rule), and
   retiring the receipt obligation altogether (it would discard the half of
   [S15069/T1948] the user actually asked for — that a resuming run USE recall to
   find its distant predecessor instead of shrugging). Compute visibility the
   same way the lane render does, from the same cutoff and the same grant column;
   do not invent a second notion of visible. The refusal must say when members
   were excluded as out-of-era, so a reader is never silently let off.
2. **The receipt records what the RENDERER emitted.** Plumb a collector through
   the lane render path and write the receipt from it. Do NOT re-derive the
   emitted set in the receipt function — a second computation of the same
   packing drifts from the first, which is how this defect got in. The earlier
   worker's "threading a parameter through five render layers for one
   side-effect" objection is overruled: with member-id coverage, what was
   rendered IS the fact the receipt exists to state.
3. **A truncated delivery credits nothing.** If the rendered payload would be
   cut by the worker envelope, no receipt is written for that call at all
   (rather than a partial one), and the caller pages smaller. Judge this against
   the same constant the envelope uses, inside the lane route, where the text
   length is already known — do not plumb a second decision out to the handler.
4. **Grant freshness follows the existing pattern**, not a new one: the
   comparison at `db/write-gate.ts:756` is normative. If a shared helper can be
   extracted so justify and the write path cannot drift, prefer that; if the
   extraction touches more than the two call sites, leave them separate and say
   so.
5. **Comma-list lane recalls record a receipt per lane**, on the same terms as
   the single-id branch (decisions 2 and 3 apply per item).
6. **The loader loads one batch further** so both implementations resolve a
   basis at exactly 500 hops. The ceiling stays 500 hops of REACH; it is the
   loader's own batch count that was off, not the cap.
7. **Out of scope:** arming phase connectivity (its own future ticket, with the
   concurrency fence); the fingerprint's strength (ticket 05 decision 4, upheld
   by the peer as a coherent explicit policy); anything in ticket 04's durable
   ledger (the peer reviewed it in full and found it correct).

## Acceptance criteria

- [ ] A lane page whose render emits fewer members than the page selected
      credits only the emitted ones — a following justify still names the
      unseen members as unread.
- [ ] A lane page big enough to be cut by the worker envelope writes NO receipt,
      and the refusal that follows says so intelligibly.
- [ ] A justify whose other island contains an out-of-era, ungranted member is
      ACCEPTED once every era-visible member has been rendered — the deadlock is
      gone. The refusal path, when it still fires, distinguishes "unread" from
      "excluded as out-of-era".
- [ ] A full-content grant taken before another writer changed that field is
      REFUSED as stale, naming the field; a grant taken after is accepted.
      Assert against the write-gate's own sequence semantics, not a re-derived
      notion of freshness.
- [ ] `recall(id="E<n>/#a,E<n>/#b")` records a receipt for each lane, on the same
      terms as the single-id route.
- [ ] A basis at exactly 500 hops resolves REACHED through the real loader, not
      just through the pure walk; the 501-hop case still reports
      unresolved-at-cap.
- [ ] Ticket 04's Status is corrected: the "a severing tag removal ALWAYS meets
      an E4 first" claim is false as stated. The peer's counterexample is
      `A -> V <- B` with only the cut vertex `V` writable — E4 anchors at the
      CITING turn and the gate blocks only anchors inside the writable set, so
      both E4s fall outside and the disposition gate speaks first. The ticket's
      GUARANTEE still holds, and now for the right reason: the durable
      `(segment, tag)` removal touch is what refuses. Record the correction as a
      correction, not a rewording.
- [ ] Every new/changed test mutation-verified (backup after implement,
      needle-assert + print, red, md5 restore, green).
- [ ] `npx tsc --noEmit` clean, `node scripts/build.js` succeeds, `bun test`
      green; baseline 4070/0 — account for every delta.

## Notes

Production DB strictly read-only. Do not tick your own boxes — report
per-item; the reviewer ticks. No sibling worker is running in this tree for
this ticket, so rebuild bundles and commit them with the code. Treat any `Bin`
line in `git diff --stat` on a `.ts` file as a hard stop.
