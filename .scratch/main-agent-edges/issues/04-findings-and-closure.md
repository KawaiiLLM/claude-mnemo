# 04 — Findings (E6 ambiguous blank, E4 invalid-declaration), the derived closure, and post-normalisation

**What to build:** spec D6 + the post-normalisation contract (R9-2, R10-6). E6 = blank side on an endpoint with ≥2 lanes; E4 = `invalid-declaration`; both on the three-layer audit (context / admit / project; actionable = outgoing rows of writable citers; preview and commit share the predicate). `derived-side-citer`: PRE resolutions recorded first-write-wins per `(job, edge, side)` in the attribution-mutation transaction, closure at finalize against POST facts granting only PRE-good → POST-bad, provenance in schema and permission union as relations-only, claim-time scope persisted, finalize continuation reads the final snapshot (R10-7). Post-normalisation on the shared membership seam: after any change to an endpoint's lane set, re-resolve every incident side in the same transaction — cardinality < 2 clears, invalid clears, newly ambiguous invalidates a live overlapping job (`invalidateOverlappingSettlementJobs`: pending|claimed|failed, stage reset, snapshots/worklists/debts/homeless records/pending impressions cleared, cancellation armed for both dispatch shapes; R9-7, R10-9) or DELETES the edge with a receipt; side index, citer stamps, old/new lane touches updated in that transaction.

**Blocked by:** 02, 03.

**Status:** LANDED

- [x] E6/E4 tests on both faces; an external citer's incident row never becomes a finding; a window of undeclared edges on unique endpoints commits.
- [x] Derived closure: ambiguous and invalid paths; a pre-existing bad side is NOT granted; PRE survives a repeated stage-1 call; a remote citer enters the persisted final writable snapshot.
- [x] Post-normalisation: alpha+beta declaring alpha becomes derived when beta goes; a stale grant is refused after a structural verb changed the edge set; a DONE window's newly ambiguous edge is deleted and receipted.

## Constraints

- `~/.claude-mnemo/` is production data and STRICTLY READ-ONLY; measure on a `cp -c` clone of the scratchpad copy.
- NEVER `git stash` / `checkout` / `checkout-index` / `restore` / `reset` / `clean`. Restore from your own `cp` copies, md5-verified.
- Explicit pathspecs on every `git add`. No raw control bytes. `grep -c anthropic-ai plugin/scripts/worker.cjs` stays `0`.
- Every teaching sentence added or removed is pinned by a test a mutation drives red. ≥3 mutation probes of your own, RED, md5-restored — and a probe whose mutation did not apply is not a probe.
- Dispose of every applicable line of `../acceptance-matrix.md` in your report.
- [x] `npx tsc --noEmit` clean (excludes `tests/`; typecheck new tests separately); full `bun test` once with every delta accounted; `npm run build`; stale-bundle and release-artifacts guards green; `git diff --check` clean. No version bump, no push.

**Pinned (T2432, P1/P2):** consume, do not re-derive — declaration is pair-addressed with class as an optional CAS precondition (ticket 03); post-normalisation is ticket 02's `normalizeIncidentAttribution` seam, and this ticket only adds the live-job branch (`invalidateOverlappingSettlementJobs`) in front of its `onAmbiguous` delete-and-receipt hook.

---

## Report (LANDED)

### What shipped

**`src/db/note-settlement-pre-resolutions.ts` (new)** — the derived-side closure's two halves.
`note_settlement_pre_side_resolutions` keyed `(job_id, edge_row_id, side)`, written with
`INSERT OR IGNORE` so FIRST-WRITE-WINS is a primary key rather than a convention a crash can lose.
`recordPreSideResolutions` writes both sides of every incident row; `enumerateDerivedSideCiters` is
the closure, run at finalize against POST facts, granting only a PRE-GOOD (`declared`/`derived`/
`none`) → POST-BAD (`ambiguous`/`invalid`) transition, over live class-bearing turn→turn rows only —
so an edge the run retracted between the record and the finalize contributes nothing.

**`src/db/settlement-job-invalidation.ts` (new)** — `invalidateOverlappingSettlementJobs(db, turnIds,
{nowEpoch, excludeJobId})`. Overlap is decided by FOUR durable sources: the job row's own window,
`note_settlement_writable_turns`, `note_settlement_lane_members`, and the NEW
`note_settlement_claim_scope` (R10-7's hole: a topics-stage job's writable set was process-local, so
no other process could see it). The affected id set is expanded to "the ids given plus the CITING
turn of every live class-bearing incident row", so a caller may pass endpoints or citers and get the
same answer. `pending | claimed | failed` reset (generation++, status pending, stage topics,
`transition_seq`/`stage1_metrics` nulled, `claimed_at_epoch` nulled); `done` and `abandoned`
untouched. `clearSettlementJobTransitionScratch` deletes the three snapshots + the removed-side debt
list + the PRE scratch + `homeless_groups` (members and supersessions cascade) +
`homeless_retraction_audits`, and RELEASES the impression-debt lease. The claim scope is deliberately
NOT cleared — it is the only durable pointer to the job until the next claim writes its own.

**`src/db/normalize-incident-attribution.ts`** — the live-job branch, IN FRONT of the delete (pinned
P2). The default `onAmbiguous` now calls `invalidateOverlappingSettlementJobs` first and answers
`keep` when a live job was found or when the acting job is itself the writer; only with nobody left
to ask does it fall through to ticket 02's DELETE + receipt. New `ctx.settlementJobId` does two
things: records PRE resolutions to that job's scratch, and exempts that job from its own
invalidation. `NormalizeIncidentAttributionResult` gains `invalidatedJobIds`.

**`src/db/note-settlement-snapshots.ts`** — `derived-side-citer` added to
`SettlementWritableProvenance`, to the table CHECK, and to the permission union as RELATIONS-ONLY
exactly like `removed-side-citer` (one shared `RELATIONS_ONLY_PROVENANCES` set, so the rule is stated
once). `widenWritableProvenanceCheck` REBUILDS an existing `note_settlement_writable_turns` whose
CHECK predates the fifth value — copy/drop/rename, never a drop, because those rows are a live job's
frozen authority. `writeNoteSettlementTransitionSnapshots` runs the closure inside the transition
transaction and returns `derivedSideDebts`; the FINAL union is therefore persisted before stage 2,
and the `installSettlementEdgesScope` re-install the finalize handler already performs is what puts
it into the range gate, `lane_check`, `commit` and the finalize DATA result — the submitted prompt is
never rewritten (R10-7).

**`src/db/segments.ts`** — `WriteMembershipTagsInput.settlementJobId`, forwarded to the seam. The
pre-state capture is now taken ONLY when that field is present (see F3b below).
`SegmentMergeReceipt` gains `declarationsCleared` / `edgesDeleted` / `citersStamped` /
`invalidatedJobIds`, read off the primitive's own `attribution` result.

**`src/worker/note-settlement-turn-facade.ts`** — stage 1's batch tag write names its job, which is
where the PRE state is recorded and where the acting run's exemption comes from.

**`src/worker/note-settlement-dispatch.ts`** — BOTH shapes persist the claim scope the instant
`writableTurnIds` resolves; the RESUME dispatch gains the claim monitor the unified one has had since
settlement-execution-repair ticket 07 (abort + a loss promise that races the await), so a generation
bump is a real cancellation on both shapes and not only on one.

### The two carried peer findings

**F3 — the touch ledger was unreachable. DELETED, per T2419's subtract ruling.** `ctx.jobId`,
`touchedLanes`, the `touch()` helper and the `recordLaneTouch` call are gone from the seam; no
structural verb ever had a job id to give them, and the invalidation rule subsumes what they were
for — a change inside a live run's reach resets that run to stage 1, which rebuilds the worklist from
the finished state, and a change outside every run's reach is owed to nobody. `previousLaneFacts`
SURVIVES, repurposed and now genuinely load-bearing: it is the "before" half of the derived-side
closure. `db/lanes.ts`'s two now-dead capture sites went with it. The seam's own touch test is
replaced by one that pins the SUBTRACTION — a task move writes zero rows into `lane_run_touches`.

**F3b — closed by construction, and the trap is named in the code.** The pre-state snapshot is now
taken only when `settlementJobId` is present, and the one caller that mutates the lane registry
before calling the primitive (`mergeSegments`, ~1a) names no job — so there is no stale snapshot left
to misfire. A comment at the capture site says what a future caller that DOES name a job must do
(capture above its own registry write and pass it in). The second half is fixed rather than
deferred: `moved.attribution` now reaches `SegmentMergeReceipt`, pinned by a new merge test whose
move clears a redundant declaration.

### Acceptance-matrix dispositions

- **R9-2** (the "stored means several lanes" invariant is MAINTAINED) — COMPLETED here. Ticket 02
  shipped the clears and the DELETE default; this ticket adds the missing arm, "newly ambiguous →
  invalidate a live job", and makes it the DEFAULT rather than an opt-in, so every attribution-
  changing verb gets it without a call-site change.
- **R9-7** (structural invalidation in the REAL vocabulary) — IMPLEMENTED. `pending|claimed|failed`
  invalidated, `done|abandoned` untouched, stage a separate column reset to `topics`; the `pending`
  job that kept `stage='edges'` and its snapshots after a lease loss is explicitly the case the reset
  exists for and is pinned by name. Same-transaction: the function opens none of its own and runs
  inside the caller's verb transaction.
- **R9-9** (`derived-side-citer` executable) — IMPLEMENTED: PRE recorded at the mutation, closure at
  finalize, provenance in the schema CHECK and in the permission union as relations-only; both the
  ambiguous and the invalid path have their own test.
- **R10-6** (post-normalisation is ONE atomic mutation contract on the shared seam) — COMPLETED. The
  contract is `normalizeIncidentAttribution` on `writeMembershipTags`; this ticket adds job
  invalidation to it and REMOVES the old/new lane touches from it (F3 — they were unreachable). The
  side index, the citer stamps and the receipted deletion are unchanged and still in the caller's
  transaction. R10-6's "old/new lane touches" clause is the one line of the matrix this ticket
  answers with a subtraction rather than an implementation; the reasoning is under F3 above.
- **R10-7** (`derived-side-citer` PRE lifecycle) — IMPLEMENTED in full: grant only PRE-good →
  POST-bad; PRE durable first-write-wins per `(job, edge, side)` across repeated stage-1 calls;
  claim-time scope persisted by both dispatch shapes (the topics-stage overlap that was
  process-local); the finalize result and the continuation read the FINAL snapshot through the
  existing `installSettlementEdgesScope` re-install, and the submitted prompt is untouched.
  Invalidation rebase: an invalidated job's PRE scratch is DELETED with the rest of its transition
  scratch — a run that is going back to stage 1 inherits no "before" from the run it replaces.
- **R10-9** (invalidation includes `failed`; clears homeless records; overlap through affected
  incident citers) — IMPLEMENTED. `failed` is in the eligible set with its own assertion;
  `homeless_groups` (cascading to members and supersessions) and `homeless_retraction_audits` are
  cleared; overlap is defined through the affected incident citers against the durable scope
  available at each stage, which is exactly what the fourth (claim-time) source exists to complete.
- **R9-1 / R9-3 / R9-4 / R9-5 / R9-6 / R9-8 / R10-1 / R10-2 / R10-3 / R10-4 / R10-5 / R10-8 /
  R10-10** — NOT APPLICABLE to this ticket: the cutover and its fence (01), the election and the
  raw-word retirement (02), the public entry union and the CAS precondition (03), the tag invariant
  and the receipt classification (01).

### Mutation probes (every one verified applied before the run, every one md5-restored after)

| # | file | mutation | result |
|---|------|----------|--------|
| 1 | `db/note-settlement-pre-resolutions.ts` | `isGoodSideOutcome` always true (grant PRE-bad too) | RED — "a PRE-BAD side is NOT granted" |
| 2 | `db/note-settlement-pre-resolutions.ts` | `INSERT OR IGNORE` → `INSERT OR REPLACE` | RED — "PRE is FIRST-WRITE-WINS" |
| 3 | `db/settlement-job-invalidation.ts` | `done`/`abandoned` added to the eligible statuses | RED ×2 — the status table, and "a DONE window's is DELETED and receipted" |
| 4 | `db/normalize-incident-attribution.ts` | default `onAmbiguous` always `"delete"` | RED ×4 — the LIVE-window keep, plus three closure tests whose edge the delete removed |
| 5 | `db/note-settlement-snapshots.ts` | `derived-side-citer` dropped from `RELATIONS_ONLY_PROVENANCES` | RED — the relations-only assertion |
| 6 | `db/settlement-job-invalidation.ts` | `expandToIncidentCiters` returns only the ids given | RED — "overlap reaches through the affected turn's INCIDENT CITERS" |
| 7 | `worker/note-settlement-dispatch.ts` | resume dispatch stops persisting the claim scope | RED — "the writable set is persisted as this job's claim scope" |
| 8 | `worker/note-settlement-dispatch.ts` | resume dispatch's monitor observes the loss and returns | RED (timeout at 5s) — "a generation bump … ends the await" |
| 9 | `shared/lane-checker.ts` | E6 widened back to admit `derived` alongside `ambiguous` | RED — "uniquely-laned endpoints commits" (E6 ×2 in the preview) |
| 10 | `worker/note-settlement-sdk-query.ts` | `judged` → `true`, **or** the scope projection dropped | **SURVIVED, each alone** — see below |
| 10d | `worker/note-settlement-sdk-query.ts` | BOTH dropped together | RED — "an EXTERNAL citer's incident row is never a finding" |
| 11 | `db/segments.ts` | merge receipt's four attribution counts hardcoded to 0 | RED — the new F3b receipt test |

**Probe 10 is the honest result worth reading.** The external-citer exclusion is DOUBLY enforced —
`evaluateWindowLanes`'s ADMIT filter (`judged`) and its PROJECT filter
(`projectLaneCheckerResultByScope` against the writable set) each suffice alone — so no single-line
mutation flips that test, and it is not a defect that neither one alone drives it red. Dropping both
turns it red, and not by printing the findings: the self-contradicting-evaluator guard fires first
("SYSTEM / PROJECTION FAILURE"). The test file records this in place of the wrong mutation note it
carried on first writing.

### Verification

`npx tsc --noEmit` clean. New and changed test files typechecked separately under a tests-only
config: no error in `tests/db/settlement-derived-side-closure.test.ts`, none in the ranges this
ticket appended to `note-settlement-call.test.ts` / `note-settlement-sdk-query.test.ts`; the
pre-existing errors elsewhere in those two files and in `segments.merge.test.ts` are ticket 03's
recorded escape F3 ("no tests typecheck") and are untouched here.

`bun test`: **4742 pass / 0 fail / 268 files**, from a baseline of **4723 pass / 2 fail / 267 files**
at `8a7af023`. Every delta accounted: +13 (`tests/db/settlement-derived-side-closure.test.ts`, the
new file), +3 (the E6/E4 audit-face block in `note-settlement-sdk-query.test.ts`), +2 (the resume
dispatch's claim scope and monitor, `note-settlement-call.test.ts`), +1 (the F3b merge receipt) = 19;
the seam's deleted touch test was REPLACED one-for-one by the no-touch test, so it is not in the
count. The two baseline failures were both cleared: the stale-bundle guard by `npm run build`, and
`note-settlement-sdk-query.test.ts`'s shape-number expectation, which had read `edgeCount === 3` from
ticket 02's tip and was left failing at main by ticket 03's ONE PAIR, ONE ROW — corrected to 2 with
the reason recorded at the assertion.

`npm run build` clean; stale-bundle and release-artifacts guards green (11/0); `git diff --check`
clean; no control bytes in the diff; `grep -c anthropic-ai plugin/scripts/worker.cjs` = 0. No version
bump, no push.

### Shared-file hunks (for the integrator)

- `src/shared/lane-checker.ts` — NOT modified. E6/E4's narrowing is ticket 02's and was consumed as
  found; probe 9 only verified it is load-bearing for this ticket's own test.
- `src/db/citations.ts` — NOT modified (ticket 03b's file).
- Settlement PROMPTS and teaching text — NOT modified. Ticket 05 owns them, and nothing E6/E4 or the
  closure required a teaching sentence: the two findings already exist in the checker's vocabulary,
  and `derived-side-citer` is an authority the model never names.
- `tests/worker/note-settlement-sdk-query.test.ts` — appended one describe block at the END of the
  file, plus the one-line shape-number correction at ~5812. If 03b also touches this file, both
  should merge without a conflict.
- `tests/worker/note-settlement-call.test.ts` — one import line and one describe block appended at
  the end.
- `src/db/normalize-incident-attribution.ts`, `src/db/segments.ts`, `src/db/lanes.ts` — ticket 02's
  files, edited per the pinned P2 hand-off and the two carried findings.

### Nothing false at HEAD; two things stated rather than assumed

1. `attempts` and `retry_at_epoch` are NOT touched by an invalidation. The spec's field list does not
   name them, and an invalidation is not an attempt refund: a job that has spent its attempts and is
   then invalidated will abandon, which is the conservative reading. If a later ticket wants an
   invalidated job to get its attempts back, that is a ruling, not an omission.
2. `lane_run_touches` rows belonging to an invalidated job are NOT cleared. They are the durable
   AUTHORSHIP ledger the judgment set re-admits on, and leaving them over-reports what the re-run is
   judged on rather than under-reporting it. Also not in the spec's clear list.
