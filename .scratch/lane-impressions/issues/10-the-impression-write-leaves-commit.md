# 10 — The impression write leaves `commit`. `remember` writes; `commit` checks the duty.

**What to build:** settlement writes an impression when it decides one, through the verb that already owns containers — not as a payload smuggled through the terminal gate. `commit` keeps a check, and the object of that check changes from the PAYLOAD to the DUTY.

**Blocked by:** 09 (it rebuilds bundles; do not run these concurrently).

**Status:** LANDED. The write is `remember(action: "impression")`, one container per call, validated and refused at the call; `commit` takes no impression argument and checks the DUTY. All four “must not get wrong” points implemented and each pinned by a test a mutation probe drives RED. The 256 KiB payload ceiling and its regeneration budget RETIRED with the payload — reasoning below. `npx tsc --noEmit` clean; full `bun test` 4610 pass / 0 fail / 253 files (baseline 4592, delta accounted below); bundles rebuilt; release-artifacts guard green. Original ruling: S15069/T2346 (「印象修改应该用 remember 工具,commit 只做检查和提交报告」).

## Why

`remember` already owns the container verbs — `create`, `write`, `edit`, `merge`, `retag`, `clear`, `delete`. An impression IS container state. Carrying it instead as an array argument on the terminal gate is a misplacement, and it has a measured cost: a single malformed entry in the `impressions` payload refuses the ENTIRE commit, which is the same family as the livelock that burned job 166 (81 minutes, 21 refused commits, window abandoned terminal).

The fix is not "make commit lenient". It is to move the write to where a failure is LOCAL — one bad impression fails its own call, is reported to the writer, and is retried by that writer, while everything already written stands.

## Four things this must not get wrong

The design review found each of these; none may be waved through.

**1. `remember` is a PUBLIC tool. The impression write is not public.** Settlement is the sole writer of impressions (spec user story 9) and that must stay mechanically true, not merely taught. The new operation is settlement-only: it requires the run's lease and rejects any other principal, naming why. Do NOT open impression writing to the ordinary `remember` caller.

**2. A durable write plus a lazy commit does not prove coverage.** Today the payload is checked against the run's touched set inside the terminal transaction — that is what stops a run rewriting a container it never looked at, and what binds the impression to the membership generation the cap was taken over. Writing text durably at `remember` time loses both unless they are re-established. Use a **job-scoped pending-decision ledger**: `remember` records a decision against this job; `commit` atomically re-verifies coverage of the touched set and the membership coordinates, promotes the pending rows, acknowledges the debts, and clears STALE.

**3. The isolation comes from per-call validation, not from a weaker terminal gate.** There is a real tension between "a malformed impression no longer refuses the whole commit" and "commit checks that every touched container carries a valid decision". If a pending decision is invalid at commit time, commit must STILL refuse — otherwise the duty check has no content. Resolve it the only way that works: `remember` validates fully at write time and refuses THERE, so nothing invalid ever becomes pending. The terminal obligation is not removed; it is made unreachable in the normal case.

**4. Clearing STALE rides the COMMIT, never the write.** `impression_stale` means "this container must be rewritten". If `remember` clears it and the run's commit then fails, a run that produced nothing has discharged an obligation and the next run will not know the container is owed. The flag clears in the terminal transaction, with the promotion.

## Acceptance

- [x] A settlement-only impression operation on `remember` writes one container's decision — `retain` or `replace` with the whole text, same CAS fence on `baseRevision`, same validator, same cap. A non-settlement principal is refused, naming the reason.
- [x] The write is validated at the call and refused at the call. A malformed or over-cap impression fails only its own `remember`, reports its violations, and leaves every previously-written decision standing. **Prove it with a test that writes three impressions where the second is invalid, and asserts the first and third survive and the run can still commit after the second is repaired.**
- [x] Decisions are PENDING until `commit`. `commit` re-verifies the touched set and the membership coordinates against the pending ledger, promotes atomically, acknowledges lifecycle debts, and clears STALE — all in the terminal transaction. A commit that fails leaves no promoted impression and no cleared flag.
- [x] `commit` no longer takes an `impressions` argument. Its check is the DUTY: every container this run touched carries a current decision. A touched container with no decision refuses, naming it.
- [x] The settlement prompt and teaching say the new shape — write as you decide, not as one batch at the end — and no retired argument is named anywhere in shipped text.
- [x] The 256 KiB payload ceiling and its validation surface go with the payload, or the ticket says why they are still needed.

## Constraints

- `~/.claude-mnemo/` is production data and STRICTLY READ-ONLY.
- NEVER `git stash` / `checkout` / `checkout-index` / `restore` / `reset` / `clean` — the whole class of working-tree rewrite is banned. Restore from your own `cp` copies, md5-verified.
- Explicit pathspecs on every `git add`. No raw control bytes in source. `grep -c anthropic-ai plugin/scripts/worker.cjs` stays `0`.
- The impression TEXT FORM is ticket 09's business and is out of scope here. This ticket moves where the write happens, not what is written.
- [x] `npx tsc --noEmit` clean (it excludes `tests/`; typecheck new tests separately); full `bun test` once; `npm run build`; stale-bundle and release-artifacts guards green; `git diff --check` clean. Do NOT bump any version and do NOT push.


---

## What landed

### The shape

- **The write** is `remember(action: "impression", id, baseRevision, decision, text?)`, one
  container per call, on BOTH dispatch shapes. `SETTLEMENT_REMEMBER_ACTIONS` =
  `SETTLEMENT_LANE_ACTIONS` + `impression`, deliberately a superset rather than a fourth registry
  verb: the registry vocabulary is dispatched into lane rows by
  `evaluateSettlementMembershipWrite` and an impression touches no registry row at all. The two
  vocabularies meet on one tool and nowhere else.
- **`remember` came back to `SETTLEMENT_ALLOWED_TOOLS`.** Settlement-gate-taxonomy ticket 06 had
  removed it from the edge-only pass because its every input was a refusal; the edge pass now has
  container state of its own to write. Its registry verbs are refused there by one shared,
  unconditional predicate (`settlementRegistryClosedRefusal`), so ticket 06's finding is intact.
  The topic pass refuses `impression` for a mechanical reason, not a policy one: the coordinates a
  decision is fenced on are born in that run's own `finalize` transaction.
- **`commit` takes `{ report }` and nothing else.** `retiredImpressionsArgument` answers a caller
  that still sends the array, naming it and its replacement, following `mcp/remember.ts`'s own
  precedent for a retired input (schema stops accepting it; the hand-rolled path gets a message).

### The pending ledger: in memory, job-scoped, held by the run that made the decisions

`createSettlementImpressionMaintainer` holds `Map<address, PendingImpressionDecision>`; each entry
carries the container ref, the verdict, the validated text, and the two coordinates it was decided
against (`baseRevision`, `membershipGeneration`) plus its cap.

A durable table was rejected. A pending decision is a claim about a VERSION, and those coordinates
are only meaningful to the run that read them. A table outlives the process that filled it, so the
next attempt would inherit judgments made against text it never saw over a window it has not read
— and would then either re-verify all of them (in which case the table bought nothing) or trust
them (in which case the fence is gone). It would also be incoherent with the advisory ledger it is
fenced against, which is in memory for the same reason. A run that dies before its commit promotes
nothing, acks nothing and clears no flag; its successor re-reads and re-decides, which is the
spec's own re-read-re-decide discipline reached by construction rather than by a cleanup path.

### Where each of the four points lands

1. **Settlement-only, on the lease.** `maintainer.decide()` calls
   `assertNoteSettlementJobClaimed(db, jobId, claimGeneration, readStage())` BEFORE the decision is
   even parsed — the same `(job, generation, stage)` tuple every other settlement write asserts.
   `claimGeneration` and `readStage` are REQUIRED maintainer options, so a caller cannot construct
   an unfenced maintainer. The public `mcp/remember.ts` refuses the verb by name through
   `SETTLEMENT_ONLY_REMEMBER_VERB_REASON`, an authority refusal rather than a vocabulary one.
2. **Pending ledger + terminal re-verification.** `settleImpressions` runs inside `commit`'s write
   transaction (unchanged position: after the lease fence, before the completion CAS) and does, in
   order: coverage of the touched set (missing → refuse by name; strangers → refuse by name),
   the coordinates over the FULL set before any write (revision, projection offenders, membership
   generation, STALE-retain, overridden-anchor retain), the validator on every pending replacement,
   then the promotion + debt ack. The membership fence now compares the DECISION's own digest, so
   the retired payload's "never shown, no generation to compare" exemption is gone — every pending
   decision was necessarily made against a loaded advisory.
3. **Full validation at the call.** `recordImpressionDecision` runs every check the terminal
   transaction runs, for that one container, and refuses there with its violations. The terminal
   validator is KEPT and is unreachable in the normal case — proven by a test where an anchor stops
   resolving between the decision and the commit (a non-member witness turn, so no membership or
   revision coordinate moves and only the validator can see it).
4. **STALE clears on the COMMIT.** `recordImpressionDecision` writes nothing at all;
   `replaceLaneImpression` clears `impression_stale` as part of the UPDATE, and that UPDATE runs
   only in the terminal transaction. Pinned by a test asserting the flag still stands between the
   decision and the commit.

### The 256 KiB payload ceiling: RETIRED, with the regeneration budget

`IMPRESSION_PAYLOAD_MAX_BYTES` and `IMPRESSION_REGENERATION_RETRY_BUDGET` are gone. The ceiling
bounded a BATCH and there is no batch. What binds one container's text is its own token cap
(≤500 lane, 500 flat task tier), enforced by the deterministic validator at the `remember` call —
a strictly tighter bound reached a strictly earlier moment. The compress-only regeneration budget
existed only to stop a stubborn writer resending the same oversized batch forever; a writer that
cannot fit one container inside its cap is refused per call, never reaches a commit, and the
dispatch's own attempt accounting answers it — which is the ordinary operator-visible path rather
than a special-cased one.

### Test delta (baseline 4592 → 4610, +18, all accounted)

`tests/mcp/remember.test.ts` +2 (the public verb's authority refusal, direct and schema paths).
`tests/worker/note-settlement-impressions.test.ts` +16 net: −2 payload-cap tests retired with the
payload cap, +18 added — 3 principal/lease, 2 coverage (a container that LEAVES the touched set;
the by-name refusal), 3 STALE (write-time refusal, post-decision refusal, clears-on-commit), 1
post-decision override refusal, 1 retain-fence split, 4 isolation (the mandated three-impression
test, last-decision-wins, the still-owed receipt, the commit-side validator), 6 teaching pins
(including "NO SHIPPED TEXT names the retired argument" and the retired-argument refusal).
No other test file changed its count.

### Mutation probes (each restored from a `cp` copy, md5 re-verified identical)

| mutation | tests RED |
| --- | --- |
| `decide` skips `assertNoteSettlementJobClaimed` | 3 (stale generation / wrong stage / not-claimed) |
| `recordImpressionDecision` clears `impression_stale` at write time | 3 (unit, claims lifecycle, e2e whole-life) |
| `settleImpressions` skips the coverage re-verification | 6 (unit ×4, unified run, e2e) |
| `settleImpressions` skips the commit-side validator | 1 (anchor stops resolving after the decision) |
| `retiredImpressionsArgument` always returns null | 3 (unit, unified run, resume dispatch) |

### Premises that turned out false at HEAD

- **The ticket says "`remember` already owns the container verbs (`create`/`write`/`edit`/`merge`/
  `retag`/`clear`/`delete`)".** That is the MAIN AGENT's `remember` (`mcp/remember.ts`). The
  settlement run's `remember` is a different tool on a different facade whose vocabulary was
  `create`/`delete`/`merge` — and on the EDGE pass it did not exist at all, having been retired
  wholesale by settlement-gate-taxonomy ticket 06. So "move the write to `remember`" required
  re-registering the tool on the resume dispatch and re-opening it in the unified run's edge pass,
  not just adding an action.
- **"A non-settlement principal is refused, naming the reason" had no reachable caller.** The
  settlement facade is only registered by a leased dispatch, so no other principal can reach the
  action there. The refusal that discharges this is on the PUBLIC tool, which now names the verb
  and the authority; the lease assertion covers the other real case, a stale settlement claimant.
- **Ticket 02's landed-shape note that "`commit` takes `impressions`" is now false**, as intended;
  its own record is left as history.

### UNVERIFIED

- **No live settlement run.** `~/.claude-mnemo/` is production data and read-only here, and the
  running worker does not carry this bundle. Everything above is verified at the shipped handlers
  and the shipped write engine, never against a real model driving a real window. Whether a writer
  actually calls `remember(action: "impression")` as it decides — rather than batching the calls
  into its last message, which the mechanism permits and only the teaching discourages — is
  UNVERIFIED and needs a live run to observe.
- **Token cost of the new shape is UNMEASURED.** One tool call per container replaces one array on
  an existing call; for a wide job touched set that is more round trips. No measurement was taken.
