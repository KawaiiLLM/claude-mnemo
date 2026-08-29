# 08 — The representative can always be read, and a justification can go stale

**What to build:** the tenth review round (mnemo review, 2026-08-29) found that
ticket 07's central ruling rests on a FALSE FACT, and that the artifact the
whole evidence ceremony produces is never re-checked. Both were reproduced by
the reviewer before this ticket was written.

1. **P1 — the out-of-era representative waiver has no ground.** Ticket 07's
   reviewer ruling ([S15069/T1965]) waived the full-content grant when the other
   representative is out of era, on the belief that "no recall can ever deliver
   an out-of-era turn whole". That is false: era filtering applies to
   SEGMENT/LANE MEMBERSHIP reads, not to explicit turn addressing.
   `applyTurnSelector` (`recall.ts:1523`) loads `S<n>/T<m>` straight from the
   session with no era predicate. The reviewer ran the decisive probe inside the
   ticket-07 fixture — with the representative pushed out of era,
   `recall(id="S<n>/T3", filter={fields:["content"]}, turn=4000)` returned its
   content in full. The escape hatch therefore swallows the rule for exactly the
   old lanes the rule was written for, and it need not: direct recall is the
   narrow path through the era boundary.
2. **P1 — a justification is fresh for one instant and then durable forever.**
   `hasLaneDispositionJustification` (`db/lane-disposition.ts:232`) accepts on
   `(segment_id, lane_tag, component_fingerprint)` alone — no job scope, no
   freshness. So: read B whole, justify A↔B, edit B's content (topology
   unchanged), commit — the gate passes on evidence that no longer describes B.
   A LATER job inherits the same justification permanently. Ticket 05's settled
   "fingerprint strength" ruling covers membership changes that preserve
   representatives; it never authorized the semantic input changing underneath a
   persistent judgment. Ticket 07 itself argued freshness matters *because* the
   artifact is persistent, then bound freshness only to the write.
3. **P1 — the receipt-table migration can throw or delete live rows under the
   repo's own concurrency model.** `ensureLaneReadMemberCoverageReceipts`
   (`db/schema.ts:3999`) does check-shape-then-unconditional-`DROP TABLE`. Two
   hook processes initializing in parallel (the model documented at
   `schema.ts:6590`) can both see the legacy `page_coverage` shape: one drops and
   the other throws `no such table`, or the late one drops a table the early one
   already recreated and is writing into.
4. **P2 — a zero-member lane page still writes a receipt.** The lane route can
   produce an empty ordinal page (`recall.ts:2033`) and records a receipt
   unconditionally, while `hasAnyLaneReadReceipt` asks only whether a row exists.
   Worse, `resolveSegmentMembersByOrdinal` treats an empty ordinal list as ALL
   members (`segment-card.ts:91`), so an out-of-range lane page can render
   unrelated task members and record them as this lane's coverage.
5. **P2 — receipts are written eagerly while every other authorization fact is
   deferred.** Read grants and completeness go through `RecallDelivery`'s pending
   ledger, committed by `deliverRecall` once the whole render returned and the
   envelope is known (`recall.ts:100-223`). Lane receipts are written during
   `recallMemoryBody`, so in a comma list the first survives a later item's
   throw, and the offset guard is a second, weaker copy of a decision the ledger
   already makes properly.
6. **Stale teaching.** The settlement tool description
   (`note-settlement-sdk-query.ts:249`) still tells the agent a justify requires
   paging the WHOLE lane. The obligation is now the other island's era-visible
   members plus the representative's own full-content read.

**Blocked by:** none — 07 has landed.

**Status:** resolved — landed as `0882e8e` (mcp half) + `43013dd` (settlement
half, carrying the single bundle rebuild); every criterion re-checked per-item
by the reviewer; suite 4088/0, tsc clean, no `Bin` lines. The worker re-ran the
premise probe itself before building on it rather than taking the ticket's word
for it. Nine worker mutations, none un-reddable, plus one of the reviewer's own
(disabling the drift comparison in `checkLaneDispositionJustification` → 5 red,
restored byte-identical, green).

The waiver is gone with everything that referenced it: `grep -rn
"grantWaivedOutOfEra" src tests plugin` is empty, and the only surviving
mentions of "deliver an out-of-era turn whole" are the three sites that label
the belief FALSE. `hasLaneDispositionJustification` was DELETED rather than kept
beside a freshness-aware twin — `checkLaneDispositionJustification` returns
`none | fresh | stale{moved}`, so no unsafe entry point survives for a future
caller to reach for. Receipts now ride the SAME pending-delivery ledger as the
read grants, judged by the ledger's own `endOffset > deliveredChars`.

DEVIATION the worker flagged and the reviewer confirms: moving receipts onto the
ledger means `recallMemory` — the main agent's uncut audience, which delivers
every character — now credits a lane render over 100K, where ticket 07's
in-route guard had refused a receipt for a delivery it never truncated. That is
strictly fewer FALSE refusals and no new credit for any actually-cut delivery,
because the ledger commits against the delivered length the handler really
passes. Ticket 07's envelope test moved to `recallMemoryDelivery` +
`commitDelivered(WORKER_TOOL_RESULT_CONTENT_LIMIT)` accordingly; the true
end-to-end worker envelope stays pinned unchanged at the settlement seam.

Three more judgment calls accepted. (a) Legacy justification rows read as
sequence 0 (`INTEGER NOT NULL DEFAULT 0`), so a pre-ticket row whose
representatives were never content-stamped stays valid and one whose
representative now carries a stamp fails closed — the NULL-means-unknown
alternative would invalidate every existing row for a staleness that never
happened. (b) "A later job does not inherit" is proven with a second RUN of the
same job, because the touch ledger is job-scoped and a genuinely different job
would never reach the gate at all; the job-scope-free half is pinned separately
in unit tests. (c) `ensureLaneReadMemberCoverageReceipts` is exported for the
race fixture alone, documented as test-only, because going through
`initializeSchema` parks the racer on DDL far above the window under test.

CORRECTION to this Status, from the eleventh round: the sentence above saying
the drop and recreate run in ONE transaction is wrong. The shape re-check and
the `DROP TABLE IF EXISTS` run under `BEGIN IMMEDIATE`; the RECREATE is the
`MEMORY_EDGE_ENDPOINT_TRIGGERS_DDL` exec that follows, outside it. Both original
failure shapes are genuinely gone (a loser sees the new or absent table and does
not drop; nothing throws), and the peer ran the real legacy migration to confirm
the table IS recreated — but the mechanism is "re-check under lock", not "one
transaction", and the next reader should be told the true one.

TWO EVIDENCE DEBTS, recorded rather than closed (the eleventh round called both
non-blocking and the reviewer agrees; neither weakens the shipped code, both
weaken the PROOF): (a) the concurrency fixture's ready marker is written before
the migration call and the parent waits on a `sleep`, so the claimed interleaving
is not strictly pinned and the parent's own drop/create/write is more atomic
than production's; (b) the legacy-row test writes sequence 0 by hand into the
NEW schema instead of building a genuinely old two-column-less table and running
the additive migration over it, so `DEFAULT`/`NOT NULL`/backfill are asserted by
construction rather than observed. Fix these when this area is next opened.

FOLLOW-UP LANDED as `ef44bf2` (eleventh round's only blocker):
`accumulateMembershipWriteCounts` still had the catch-all default from when
three lane verbs existed, so `justify` — a fourth action that moves no lane row
— reported `1 merged` into the DURABLE commit metrics the dispatch layer logs.
All four actions are now enumerated with a `never` exhaustiveness check and a
justification has its own `lanesJustified` bucket. Reviewer mutation (counting a
justify as a merge again) → 1 red, restored byte-identical, green. Adding the
field broke four exhaustive `toEqual` count assertions, which is the right kind
of failure and is how a fifth bucket will announce itself too.

Worth keeping: the worker's first concurrency fixture would have been VACUOUS
and it said so — a blind double-spawn essentially never hits a microseconds-wide
pre-check window, and mutation M4 would have stayed green. The shipped fixture
pins the interleaving with SQLite's own lock (parent takes `BEGIN IMMEDIATE`
BEFORE spawning, so the racer provably reads the legacy shape and provably
waits); taking the lock after spawning proves nothing, which it hit on the first
attempt. Bundle placement is stated for bisectors: one rebuild, in `43013dd`, so
`0882e8e` alone would fail the stale-bundle guard.

## Decisions (settled — do not re-litigate)

1. **The waiver is DELETED, not narrowed.** The full-content grant on the other
   representative is required unconditionally, era or no era, because a direct
   `S<n>/T<m>` recall can always supply it. Remove the waiver branch, the
   `grantWaivedOutOfEra` outcome field and the receipt clause `436525a` added,
   and REVERSE the test that pins the acceptance — it pins wrong behaviour and
   its comment asserts a false fact. Reversing it is this ticket's own act; say
   so where it lives. The refusal must point at the move that clears it: recall
   the representative by its `S<n>/T<m>` address, which works regardless of era.
2. **The USER RULING [S15069/T1964] stands and is untouched by this**: the
   MEMBERSHIP obligation remains the other island's ERA-VISIBLE members, because
   that obligation is earned through the lane route, which *is* era-filtered. Do
   not extend member coverage to direct turn reads — a receipt is a fact about a
   LANE-selector read, and ticket 02's whole reason for existing is that a turn
   read is indistinguishable from a lane read.
3. **A durable justification carries the evidence it was granted on.** Store,
   with the justification row, the `content` write sequence of BOTH
   representatives as of acceptance, and have the disposition gate re-check that
   neither has been written since. A justification whose evidence moved is not a
   disposition any more — it must fail closed, sending the run back through
   read-and-justify. Additive columns; follow the `phase_retype_audits`
   precedent. If a cleaner equivalent exists (e.g. deleting matching
   justifications when a representative's content is stamped), take it and say
   why — what may NOT stand is the current "granted once, honoured forever".
4. **The migration serializes and re-checks.** Do the shape check and the drop
   inside one write transaction, re-checking the shape after the lock is held,
   and use `DROP TABLE IF EXISTS` so a lost race cannot throw. The row loss
   itself remains acceptable for the reason the function's own doc already
   gives (receipts are claim-scoped; the worst case is one re-read) — what is
   not acceptable is a throw during schema init or a drop of a table another
   process is already writing.
5. **A page that emitted no member of the lane writes no receipt** — and the
   "empty ordinals means all members" sentinel must not be reachable from the
   lane route with an out-of-range page. Fix the sentinel rather than
   special-casing the caller if both are possible.
6. **Receipts join the delivery ledger** (decision 5's own defect): record the
   lane receipt as a pending delivery fact committed by `deliverRecall`
   alongside the grants, not as an eager side effect. The envelope-offset guard
   from ticket 07 stays only if the ledger does not already subsume it; if it
   does, delete it and say so.
7. **The tool description is updated to the shipped obligation.**
8. **Out of scope:** the release version identity (the reviewer's call, taken at
   push time — nothing is published, so nothing is "spent"); arming phase
   connectivity; anything in ticket 04's durable touch ledger.

## Acceptance criteria

- [x] A justify whose other representative is out of era is REFUSED without a
      full-content grant, and ACCEPTED after `recall(id="S<n>/T<m>",
      filter={fields:["content"]})` — the probe that proved the premise false,
      turned into the test that keeps it dead.
- [x] The `grantWaivedOutOfEra` field, its receipt clause and the test pinning
      the waiver are gone; nothing in the tree still claims an out-of-era turn
      cannot be read whole.
- [x] Editing a representative's `content` after a justify and before commit
      makes the commit REFUSE, naming the fracture and the moved evidence; a
      later job does not inherit a justification whose evidence has moved.
- [x] Two concurrent initializations over a legacy-shaped `lane_read_receipts`
      neither throw nor drop a table the other is writing — asserted with a
      genuinely concurrent fixture, not a serial one (the existing migration
      test at `tests/db/lane-disposition.test.ts` is serial).
- [x] A lane page that emits zero members of that lane records NO receipt, and
      an out-of-range lane page cannot render the task's other members.
- [x] A comma-list recall whose later item throws leaves NO receipt from its
      earlier items.
- [x] The settlement tool description states the obligation that actually ships.
- [x] Every new/changed test mutation-verified (backup after implement,
      needle-assert + print, red, md5 restore, green).
- [x] `npx tsc --noEmit` clean, `node scripts/build.js` succeeds, `bun test`
      green; baseline 4078/0 — account for every delta.

## Notes

Production DB strictly read-only. Do not tick your own boxes — report
per-item; the reviewer ticks. You own this tree. Treat any `Bin` line in
`git diff --stat` on a `.ts` file as a hard stop.
