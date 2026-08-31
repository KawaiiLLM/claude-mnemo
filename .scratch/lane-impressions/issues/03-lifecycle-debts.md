# 03 — Lifecycle debts: manual operations leave durable maintenance obligations

**What to build:** every manual container operation that can invalidate an impression leaves a durable, routable debt: remember's lane declare/rename/merge and task merge/retag insert a qualified-key debt ATOMICALLY with the operation; a lane merge sets the survivor lane's STALE flag and a task merge sets the surviving task-tier STALE flag in the same transaction; a settlement run whose session is attached to the debt's task CLAIMS its debts at run start, folds them into the touched set (ticket 02's seam), and ACKS them only in its successful terminal commit — a failed run releases its claims.

**Blocked by:** 01 (schema), 02 (the run path that claims/consumes).

**Status:** implemented — awaiting review. `npx tsc --noEmit` clean; full `bun test` 4638 pass / 0 fail; bundles rebuilt, stale-bundle guard green; `git diff --check` clean. 17 red-capable mutation probes run, every source file restored byte-identical (md5-verified).

Landed shapes:
- WRITE SIDE at the manual-operation layer (`src/mcp/remember.ts`): lane declare, lane rename, lane merge and task retag each write their debt INSIDE the handler's own `writeTransaction`. Task merge is the one exception and it is forced: its debt block lives in `mergeSegments` (`src/db/segments.ts`, step 6a2), because the source segment's cascade fires at step 6b and after it there is nothing left to re-key. `mergeSegments` has exactly one caller (`handleMergeTask`), so "in the operation's own transaction" holds either way.
- The debt writers are NOT in `db/lanes.ts`'s primitives, deliberately: `insertLane`/`mergeLaneTag` are also settlement's own (`note-settlement-membership-facade.ts`), and the spec scopes debts to MANUAL remember operations. A settlement-initiated declare/merge needs no debt — the container is already in that run's touch ledger, so the same run judges it.
- New storage helpers: `markLaneImpressionStale` (db/impressions.ts), `markSegmentTaskImpressionStale` (db/segments.ts), `rekeyImpressionDebtsToSegment`, `listClaimedImpressionDebtsForJob`.
- CLAIM SIDE: `createAttachedImpressionDebtClaimer` (worker/note-settlement-impressions.ts) fills ticket 02's seam as the DEFAULT (the seam stays the override) in both query builders, and the resume dispatch claims before rendering its prompt.
- RELEASE SIDE inside the job transitions themselves — `failNoteSettlementJob` (all three branches, `abandoned` included) and `releaseNoteSettlementJobClaim` — so no worker call site can forget.

Design calls the spec left open (all reported to the caller):
1. The merge-family STALE mark BUMPS `impression_revision` on both tiers. Without it the fence only catches a `retain` (ticket 02 refuses those), and an in-flight run that already decided `replace` over the pre-merge text would land it. The spec's own fixture list demands "a manual lifecycle write between a run's read and commit likewise rejects it", which only a moved coordinate makes true.
2. A TASK merge re-keys the source's open debts onto the survivor (`rekeyImpressionDebtsToSegment`) instead of letting the `segments` cascade eat them. Every one of `from`'s lanes SURVIVES a task merge (relocated, or folded into the twin), so their obligations are not extinct — only their address moved. The spec's "a MERGE leaves only the survivor's key" applied one tier up.
3. The claimer re-asserts its claim on every call rather than memoizing. A refused commit rolls back the terminal transaction the seam is called inside, so a closure that remembered "already claimed" would answer from an undone lease. Consequence, and it is the spec's own answer rather than a concession: a debt born mid-run joins the touched set at the next call and refuses that commit for coverage — re-read-re-decide — instead of being acked without a judgment.
4. A lane RENAME does not carry the impression TEXT across. `renameLane` is mint-then-fold, so the old row (and its text) is deleted and the new one starts empty; the `rename` debt is what obliges settlement to write the successor. NOT a decision this ticket made — it is the pre-existing primitive's behaviour, and the spec does not rule on it. Flagged because the spec's "non-merge debts do not falsify existing prose" reads as if the prose survives a rename. If it must, that is a text-carry the rename primitive owes and a later ticket should rule it.
5. `remember(clear)` and `remember(delete)` write NO debt: the spec's enumeration (declare/rename/merge, task merge/retag) is closed and neither verb is in it. A lane `delete` destroys the impression with the row, and a debt left keyed to the vanished tag is harmless (the touched set drops absent lanes, so the run acks it with no container to judge). A lane `clear`, which keeps the row and its prose while un-homing every member, is the one case worth a later ruling.
6. `impression_debts.lane_tag` carries no FK onto `lanes`, so a lane-row delete takes the IMPRESSION but not the debts. The cascade the ticket asks to assert is the `segments` one, and it is asserted end to end.

UNVERIFIED: nothing. Every rule added here has a fixture that goes red when that specific rule is disabled — including the two production wirings (the SDK query builders' default claimer and the resume dispatch's claim), probed by reverting each to ticket 02's "claim nothing" shape.

Spec: `.scratch/lane-impressions/spec.md` (Rev 8 READY) — "Lifecycle debts" and "Merge staleness" govern.

- [x] Debt insertion is atomic with the remember operation (fixture: the operation's transaction fails → no debt; succeeds → debt present); rename re-keys existing debts; merge leaves only the survivor key; a deleted source row's impression and debts die with it.
- [x] STALE set in the merge transaction: lane merge → survivor lane row; task merge → segment task-tier; force-merge folded lanes → each folded survivor lane, own debt.
- [x] Claim/ack: attached-only eligibility (an unattached run cannot claim — fixture); ack only in the successful terminal commit; a failed run's claims release for the next eligible run; consumption is never read-and-delete.
- [x] A debt with no eligible run waits durably (no reader-surface marker unless merge-family STALE).
- [x] A qualified CAS-rewrite clears STALE (fixture: merge → STALE → eligible run replaces → flag clear; the rewrite is a required replace that compress-only regeneration may not demote).
- [x] `npx tsc --noEmit` clean; touched suites green; full `bun test` once; bundles rebuilt, stale-bundle guard green.
