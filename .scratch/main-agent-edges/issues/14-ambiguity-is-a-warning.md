# 14 — Ambiguity is a warning: the repair machinery goes, the teaching says what the code does, finalize is bounded

**What to build:** the user's ruling (S15069/T2465–T2466): a side that resolves `ambiguous` is a WARNING and nothing more — kept, not deleted, no job reset, no repair authority, no mechanism. This ticket SUBTRACTS everything that existed only to hand an ambiguous side a repair channel (ticket 04's second half and its ticket-06 consumers), demotes E6 from an error to a warning, fixes the two teaching defects the peer found (P1-10, P2-C), bounds finalize output (P2-D), and deletes `removed-side-citer` (P2-F). Peer findings P1-4, P1-5, P1-7 and P1-8 are dissolved by the deletion, not fixed.

**Blocked by:** 13 (its lane-creation item touches the same seam; merge `main` after 13 lands). Ticket 12 owns the cutover's transform 5 change (keep ambiguous edges) — not this ticket.

**Status:** LANDED

## Delete (each with a one-line reason in the report; CHECK constraints that name a value are migrated the way ticket 04 migrated its own)

- [x] `invalidateOverlappingSettlementJobs` and everything only it uses: `note_settlement_claim_scope` (+ `persistNoteSettlementClaimScope`, both dispatch call sites), the cancellation arming/claim monitor added for it in both dispatch shapes (keep whatever the resume shape needed BEFORE ticket 04 for its own claim loss — check ticket 04's report: "the resume dispatch gained the claim monitor it lacked" — if that monitor is needed for ordinary claim loss, keep it and say so), the `onAmbiguous` default in `normalizeIncidentAttribution` (a side becoming ambiguous is a no-op; `clearLane`'s attribution-only behaviour unchanged; redundant/invalid clears unchanged).
- [x] `note_settlement_pre_side_resolutions`, `enumerateDerivedSideCiters`, the PRE write in the seam, `derived-side-citer` and `removed-side-citer` provenances (+ their debts, the removed-side debt table if separate, `RELATIONS_ONLY_PROVENANCES` if empty afterwards), and `writableDelta` in `computeSettlementReadDeltas` / snapshot #4's dependence on them: `finalWritableIds = initialWritableIds`; `contextDelta` stays (lane members added by stage 1 ∪ declaration endpoints of writable citers − initial). Update ticket 06's teaching lines that name the writable delta.
- [x] The tests of the deleted machinery go with it; a test that pinned a now-false rule ("a newly ambiguous side invalidates the job / deletes the edge") is REPLACED by its opposite: the edge is kept, the job is untouched, the read renders `ambiguous`.

## Change

- [x] E6 is a WARNING class: `lane-checker.ts` moves it from `LaneErrorClass` to the warnings; `lane_check`/preview/`commit` never refuse on it; the three-layer audit still reports it. E4 stays an error. Renderers unchanged (they already print `ambiguous`).
- [x] Teaching says what the code does (P1-10, P2-C): `definitions.ts` retraction text states the pair rule (sides ignored, one edge per pair, a two-sided entry is not "only that placement"); the E4/E6 teaching in `note-settlement-sdk-query.ts` (~494–518, ~644–663, ~1372–1394) states the resolved-side model — E6: may `declare` the side on a multi-lane endpoint, may leave it, never blocks; E4: `declare` a valid lane or retract; never "add the tag"/"place both sides"/"either empty". Every added sentence pinned, every retired sentence absent from RENDERED text.
- [x] Finalize output bounded (P2-D): the set lines and the lane roster obey the worklist rendering's existing budget/pager (no new mechanism); overflow named with a count, never silently cut.

## What to prove

- [x] `grep -rn "derived-side-citer\|removed-side-citer\|note_settlement_claim_scope\|note_settlement_pre_side_resolutions\|invalidateOverlappingSettlementJobs" src tests` → 0 hits.
- [x] A structural change (task move / lane merge) that makes a side ambiguous under a live claimed job: edge kept, job status/generation/snapshots unchanged, relations read shows `ambiguous`; revert probe (old invalidate/delete behaviour restored) red, test named.
- [x] `commit` with an outstanding E6 succeeds; with an E4 refuses; probe: E6 back in the error set → red.
- [x] Closure of the deletion (the peer's second-round checklist, S15069/T2467): no half-mechanism survives in schema (tables, CHECKs, migrations), dispatch (both shapes), the claim monitor, `clearSettlementJobTransitionScratch`/scratch cleanup, tool teaching, receipts/reports, or tests — list every site removed. E4 stays an ERROR and is still cleared automatically by write validation and the structural seam; a test proves E4 alone still refuses commit after E6's demotion.
- [x] Revert probe per predicate, ≥4, verified applied, md5-restored.

## Constraints

- `~/.claude-mnemo/` STRICTLY READ-ONLY. NEVER `git stash`/`checkout`/`checkout-index`/`restore`/`reset`/`clean`; restore from your own `cp` copies, md5-verified.
- Explicit pathspecs; never stage `plugin/scripts/*.cjs`; nothing under `.scratch/` but this ticket. No control bytes; `anthropic-ai` in worker.cjs = 0. No subagents. No version bump, no push.
- `npx tsc --noEmit` clean; `npm run typecheck:tests` no new errors in touched files; full `bun test` once with every delta accounted; `npm run build`; guards green; `git diff --check` clean.


---

## Report (LANDED)

### What shipped

**E6 IS A WARNING CLASS.** `shared/lane-checker.ts`: `LaneErrorClass = "E3" | "E4"`, new
`LaneWarningClass = "E6"` and `LaneFindingClass` for the sites that carry either.
`LaneDraftEdgeError.class` is typed `LaneWarningClass`, so the class cannot rejoin the error union
without a compile error. The INSTANCE still travels in `result.errors` — that list is "the grammar
findings, each naming its anchor", and E3 has ridden it as a non-blocking member since
settlement-gate-taxonomy ticket 04 demoted it — so the three-layer audit, the render and the
per-instance split are all unchanged in shape.

**Where the demotion actually bites:** `worker/note-settlement-finding-class.ts`'s CONDITION 1
(`violatesStagePostStateInvariant`) answers `false` for E6. Chosen over condition 3 deliberately and
stated at the site: the repair is perfectly bounded, legal and honest (settlement may `declare` the
side); what changed is that the state it repairs is no longer forbidden. The rule's own header
already says "repairable but not compelled simply IS a warning". Every consumer — `lane_check`'s
preview, the commit gate, the render's blocking/informational split — asks that one rule, so no
second gate needed touching. E4 still blocks; E3 still demotes on condition 3.

**The seam's ambiguous outcome is a no-op.** `db/normalize-incident-attribution.ts` loses
`onAmbiguous`, `AmbiguousDisposition`, `ctx.settlementJobId`, `ctx.previousLaneFacts`,
`result.invalidatedJobIds`, the post-clear re-resolve and the DELETE-and-receipt arm. The two clears
(invalid, redundant) and the collision fold are untouched. Ticket 13's two `onAmbiguous: () =>
"keep"` overrides are gone from `mcp/remember.ts` and `worker/note-settlement-membership-facade.ts`
— with no hook there is no default to correct. `db/segments.ts` loses
`WriteMembershipTagsInput.settlementJobId`, the pre-state capture (and peer finding F3b's whole
ordering trap with it) and `SegmentMergeReceipt.invalidatedJobIds`; the three attribution counts
ticket 04 added SURVIVE, and `edgesDeleted` now counts the collision fold alone.
`worker/note-settlement-turn-facade.ts`'s stage-1 batch write names no job.

**Deleted, as a set** (each with its reason):

| site | reason |
|---|---|
| `src/db/settlement-job-invalidation.ts` (whole module) | its only trigger was a side becoming ambiguous, which is now a no-op |
| `invalidateOverlappingSettlementJobs`, `expandToIncidentCiters`, the four overlap sources | ditto |
| `note_settlement_claim_scope` + `persistNoteSettlementClaimScope` + both dispatch call sites | existed so a lane verb could invalidate rather than delete; nothing deletes now |
| `src/db/note-settlement-pre-resolutions.ts` (whole module) | PRE resolutions had one reader, the derived closure |
| `note_settlement_pre_side_resolutions` (table DROPPED on open) | ditto |
| `enumerateDerivedSideCiters`, `DerivedSideDebt`, `isGoodSideOutcome` | ditto |
| `derived-side-citer` + `removed-side-citer` provenances | relations-only grants that existed only to hand an ambiguous side a repair channel |
| `RELATIONS_ONLY_PROVENANCES` | empty afterwards |
| `enumerateRemovedSideCiters`, `NoteSettlementRemovedSideDebt`, `NoteSettlementRemovedLane` | the removed-side closure and its debt shape |
| `note_settlement_removed_side_debts` (table DROPPED on open) | ditto |
| `NoteSettlementSnapshotInput.removedLanes`, `StageOneProjection.removedLanes`, the pre-run tag snapshot in `note-settlement-sdk-query.ts`, the `removedLanes` stage-1 metric | the diff's only reader was the removed-side closure |
| `SettlementReadDeltas.writableDelta`, `SettlementWorklistRendering.writableDelta`, both `writable delta` render lines | `finalWritableIds = initialWritableIds`, so the difference is empty by construction |
| `SettlementFrozenScope.debts`, `SettlementEdgesScope.debts`, `NoteSettlementWorklistSnapshot.debts`, `NoteSettlementSnapshot.debts`/`derivedSideDebts` | the debt list travelled with the closure |
| the `writable delta` / DEBT DISCHARGE teaching in `note-settlement-edge-pass-teaching.ts`, `note-settlement-prompt.ts`, `note-settlement-unified-prompt.ts`, `note-settlement-sdk-query.ts` | the debt they name no longer exists |
| `tests/db/settlement-derived-side-closure.test.ts` (13 tests) | the machinery it pinned |

**CHECK-constraint migration, the way ticket 04 built it up.** `widenWritableProvenanceCheck` becomes
`narrowWritableProvenanceCheck`: a snapshot table still carrying the five-value CHECK is rebuilt
copy/drop/rename, and the copy is FILTERED to the three surviving classes. A turn whose only
authority was the retired repair channel loses its writable row — which IS the ruling — while a turn
that also held an ordinary class keeps its. The two retired scratch tables are `DROP TABLE IF
EXISTS`ed in the same ensure path rather than left as inert stock (T2419's subtract ruling). Pinned
by `tests/db/ambiguity-is-a-warning.test.ts`'s legacy-database test.

**THE CLAIM MONITOR IS KEPT, ON BOTH SHAPES, and this is the one item the ticket asked me to judge.**
Structural invalidation was never its only cause. ORDINARY CLAIM LOSS is: a lease that expires while
a run's query is still going is reaped by `reclaimExpiredNoteSettlementClaims`, which bumps
`claim_generation` and lets another worker take the job — leaving the first run writing against a
claim it no longer holds. That is what the unified shape's monitor was built for
(settlement-execution-repair ticket 07), it is unaffected by the ruling, and the resume shape is
exposed to it identically. Only the comments that attributed the monitor to invalidation changed.

**`resetNoteSettlementJobToStageOne` IS KEPT and RELOCATED, and this is the second judgment call.**
It lives in the deleted module but has a caller with a live purpose beyond ambiguity repair: the
CUTOVER FENCE (`db/schema.ts`, spec D9/R10-8) resets every pending/failed job stuck at
`stage='edges'` before the one-shot rewrites `memory_edges`, because its frozen worklist was computed
over the unfolded table. Nothing about that is attribution. The ticket's Delete line reads
"`invalidateOverlappingSettlementJobs` and everything ONLY IT USES", so keeping it is inside the
instruction rather than a deviation. Moved to `db/note-settlement.ts` (the job lifecycle it belongs
to) with `clearSettlementJobTransitionScratch` as a private helper minus the two dead tables;
`InvalidatedSettlementJob` renamed `SettlementJobStageOneReset` because the old name named a deleted
concept. `tests/db/settlement-job-invalidation.test.ts` → `tests/db/settlement-job-reset.test.ts`,
retargeted.

**Teaching (P1-10, P2-C).** `mcp/definitions.ts`'s `RETRACTION_TAG_FORM_LINE` retired
"a bare entry retracts the unsettled row, a two-sided one retracts exactly that lane placement" —
true only under the pre-cutover model where one pair held several physical rows — for the PAIR rule
("the ADDRESS IS THE PAIR… Side tags are ignored here"). `lane_check`'s description retired
"a DRAFT edge with either side still empty (E6)", "A draft is a legal row to WRITE" and "not a legal
row to LEAVE" for the resolved-side model plus "An E6 is a WARNING… never retract an edge merely to
silence one". `commit`'s description retired "an edge left with an empty side inside your writable
set is unfinished settlement" and "place both sides or retract it" for "A BLANK SIDE NEVER REFUSES
YOU" and "there is exactly ONE such state". `describeCommitGateError`'s E4 line retired "Add the tag
to that turn" (P1-10 — the edge pass holds no pen for a note field on any provenance) for "Declare a
lane that endpoint carries, or retract the edge"; its E6 line retired "Place both sides with a
{turn, tailTag, headTag} entry" for "leaving it is legal and blocks nothing". `lane-checker-render.ts`
retired "DRAFT edge -- neither side names a lane" for "AMBIGUOUS side -- neither endpoint answers
which lane", and "missing from the … turn's tags" for "is not among the … turn's own lanes". Both
prompts and the shared edge-pass block state E6-as-warning and E4-as-the-one-that-blocks. Every
added sentence is pinned; the 8 retired needles are asserted ABSENT from the RENDERED text of both
prompts (`note-settlement-edge-pass-teaching.test.ts`'s needle list).

**Finalize bounded (P2-D).** `renderAddressList` in `note-settlement-prompt.ts` gains
`SETTLEMENT_ADDRESS_LIST_BUDGET = 200` and an overflow line naming the true total
("… and N more (M total, not all shown — `lane_check` pages the full set)"). It is EXPORTED as
`renderSettlementAddressList` and the unified `finalize` DATA result imports it rather than
reimplementing a bound — one mechanism, two hosts, so a set cut in the prompt is cut identically in
the data result. The finalize result's frozen writable set, context delta, lane rosters and homeless
groups all print through it instead of `join(", ")` onto one line.

### The peer's closure checklist (S15069/T2467), site by site

- **Schema** — `note_settlement_claim_scope`, `note_settlement_pre_side_resolutions` and
  `note_settlement_removed_side_debts` gone; the writable-turns CHECK narrowed to three values with a
  copy/drop/rename migration and a filtered copy; no migration left that names a retired value.
- **Dispatch, both shapes** — `persistNoteSettlementClaimScope` removed at
  `createNoteSettlementDispatch` (~526) and `createUnifiedNoteSettlementDispatch` (~978); the import
  is gone; both absences are pinned (`note-settlement-call.test.ts`, including the shape ticket 02b
  found unpinned).
- **The claim monitor** — KEPT on both shapes, for ordinary claim loss. Stated above.
- **Scratch cleanup** — `clearSettlementJobTransitionScratch` survives as a private helper of the
  cutover fence's reset, minus the two dropped tables; the claim-scope "deliberately not cleared"
  clause is gone with the table.
- **Tool teaching** — every surface listed above; nothing in `src/` names a live side-citer class.
- **Receipts / reports** — `SegmentMergeReceipt.invalidatedJobIds` gone; the stage-1
  `removedLanes` metric gone; `NormalizeIncidentAttributionResult.invalidatedJobIds` gone.
- **Tests** — every test of the deleted machinery replaced by its opposite (table below).
- **E4 stays an ERROR**, still cleared automatically by write validation (the gate refuses a side
  naming a lane its endpoint lacks) and by the structural seam's invalid-declaration clear.
  `settlement-finding-class.test.ts` proves E4 alone still refuses commit after E6's demotion.

### Replaced tests (a false rule swapped for its opposite, never merely deleted)

| was | is |
|---|---|
| `settlement-derived-side-closure.test.ts` (13) | `tests/db/ambiguity-is-a-warning.test.ts` (9): edge kept, job status/generation/stage/transitionSeq/snapshots unchanged, read renders `ambiguous`, no authority minted, CHECK narrowed, tables dropped, legacy DB migrated with the retired rows dropped, the two clears unchanged, merge receipt keeps its three counts |
| "a side that resolves AMBIGUOUS … is deleted and receipted" + the `onAmbiguous: keep` test | "a side that resolves AMBIGUOUS is KEPT, unreceipted, with nothing to configure" |
| "`clearLane` deletes only what it makes UNATTRIBUTABLE" | "`clearLane` clears the declaration and KEEPS the edge" |
| "a removed-side citer joins the set…" ×3 | "only the three ordinary classes reach the snapshot" + "the worklist snapshot carries lanes alone" |
| "a writableDelta member accepts a relation write and refuses a note-field write" | "a citer stage 1 left owing a side is NOT writable" |
| "E3 and E6 on the SAME anchor split" | "E3 and E6 … are BOTH warnings, and commit succeeds" + a NEW "an E4 on that same anchor STILL refuses commit" |
| "commit refuses while a DRAFT edge anchors inside the writable set" | "an AMBIGUOUS side … is reported and commits", with the edge still present afterwards |
| "an unrelated E6 on the same relation-only citer DOES block" | "an E6 on that same citer does NOT block, and with the E4 gone the gate is silent" |
| "relation-only authority on a removed-side citer" (4) | "the per-provenance field gate, with no relations-only class left" (4) |
| "the citer gains relation-only authority once finalize freezes the closure" | "the citer gains NO authority" — see FALSE-AT-HEAD below |
| the E6-vehicle fixtures in `settlement-evidence-closure`, `settlement-system-failure`, `settlement-one-evaluator`, and the sdk-query origin-partition / TOCTOU tests | re-aimed at E4, the one remaining blocking edge class, with the subject (where a finding anchors / where the gates run) untouched |

### Revert probes (each verified applied, run, named red, md5-restored)

| # | file | mutation | result |
|---|---|---|---|
| P1 | `worker/note-settlement-finding-class.ts` | condition 1 back to `return true` (E6 into the blocking set) | RED ×5 — "E3 and E6 on the SAME anchor are BOTH warnings…", "an E4 on that same anchor STILL refuses…", "an ambiguous side inside the range is named by `lane_check` as a warning…", "an E6 on that same citer does NOT block…", "a run whose writable set owns both citers…" |
| P2 | `db/normalize-incident-attribution.ts` | the seam's OLD delete-and-receipt arm restored | RED ×4 — "a side that resolves AMBIGUOUS is KEPT…", "`clearLane` clears the declaration and KEEPS the edge…", "the edge is KEPT, the job is UNTOUCHED…", "no repair authority is minted…" |
| P3 | `db/note-settlement-snapshots.ts` | a relations-only provenance set PARTIALLY re-added to `settlementWritePermissions` | RED ×2 — "every surviving provenance carries BOTH authorities…", "every ordinary provenance carries FIELD authority…" |
| P4 | `mcp/definitions.ts` | the P1-10 retraction sentence reverted | RED ×2 — "retractUse/retractCorrect still documents the bare-address form, and states the PAIR rule" |
| P5 | `worker/note-settlement-prompt.ts` | the finalize/worklist address-list bound removed | RED ×2 — "a list at the budget prints whole; one address over it is cut…", "the stage-2 prompt's own lane roster obeys the same bound" |
| P6 | `shared/lane-checker.ts` | `LaneErrorClass` back to `"E3" \| "E4" \| "E6"` | RED ×1 — "no error class named E5 exists in the checker…" (the literal sentinel) |

### One test that was FALSE AT HEAD

`staged-settlement-unified-run.test.ts`'s "the citer gains relation-only authority through the SAME
handler registry once finalize freezes the closure" asserted the retraction did NOT match
`/refused|not in your writable set/i`. The range gate's real refusal says "outside this dispatch's
reviewable window" — so the assertion was green at HEAD whether or not the grant existed, i.e. it
could not fail either way. Replaced with the refusal's own words plus a direct assertion on the
frozen snapshot's contents.

### One half-mechanism SURVIVES, deliberately, and is flagged

`settlementWritePermissions` / `settlementTurnPermissions` and the field gate in
`note-settlement-turn-facade.ts` (~1370) now have no input that can answer `fields: false`: every
surviving provenance carries both authorities, so the refusal branch is unreachable by construction.
The ticket's own Delete line scoped this ("`RELATIONS_ONLY_PROVENANCES` **if empty afterwards**"),
which is what I deleted; the permission function's SHAPE is kept because it is the one place a class
declares its authority, and re-adding a gate to admit the next class is exactly how the rule and its
enforcement came apart before. Deleting it as well would reach `db/write-gate.ts`,
`note-settlement-finding-class.ts`'s condition 3 and their suites — outside this ticket. Flagged for
the parent to rule.

### Verification

`npx tsc --noEmit` clean. `npm run typecheck:tests`: **326** (was 330 before this ticket's last two
dead-reference fixes; every error in a touched file is pre-existing — the duplicate
`SETTLEMENT_NOTE_TOOL_DESCRIPTION` import at `note-settlement-prompt.test.ts:27/44`, the arity errors
in `note-settlement-call.test.ts`, `LaneCheckerError.citedId` in `lane-checker.test.ts:1662` — all of
them ticket 03's recorded escape "no tests typecheck"). `npm run build` clean.

`bun test`: **4791 pass / 0 fail / 276 files**, from a baseline of **4794 / 0 / 276** at `7473f24b`
(measured after `npm run build`; the one pre-build failure was the stale-bundle guard). Delta −3,
every unit accounted: −13 (`settlement-derived-side-closure.test.ts`, deleted) +9
(`ambiguity-is-a-warning.test.ts`, new) −1 (`note-settlement-snapshots.test.ts` 10→9) −1
(`normalize-incident-attribution.test.ts` 16→15) +1 (`settlement-finding-class.test.ts` 2→3) +2
(`note-settlement-prompt.test.ts` 70→72, the P2-D block). File count unchanged: one deleted, one
added, one renamed.

`bun test tests/shared/release-artifacts.test.ts` 11/0. `git diff --check` clean. Control-byte sweep
over every touched non-bundle file: none. `grep -c anthropic-ai plugin/scripts/worker.cjs` = 0. No
version bump, no push. `~/.claude-mnemo/` untouched.

`grep -rn "derived-side-citer\|removed-side-citer\|note_settlement_claim_scope\|note_settlement_pre_side_resolutions\|invalidateOverlappingSettlementJobs\|persistNoteSettlementClaimScope\|enumerateDerivedSideCiters" src tests` → no live reference. The surviving hits are, exhaustively:
comments stating the absence (`note-settlement-snapshots.ts` 57/58/226/251,
`note-settlement.ts` 2238/2326, `note-settlement-dispatch.ts` 519,
`note-settlement-turn-facade.ts` 1372, `note-settlement-stage1.ts` 57, and the "what this replaces"
headers in the six replaced test files), the `DROP TABLE IF EXISTS` statements themselves
(`note-settlement-snapshots.ts` 236), and the legacy-DDL literals inside the two tests that PROVE the
absence (`ambiguity-is-a-warning.test.ts`'s CHECK-migration fixture and its dropped-tables query,
`note-settlement-call.test.ts`'s `sqlite_master` probes).

### Shared-file hunks (for the integrator)

- `src/shared/lane-checker.ts` — type-level only: `LaneErrorClass` narrowed, `LaneWarningClass` /
  `LaneFindingClass` added, `LaneDraftEdgeError.class` retyped, three doc paragraphs. No predicate
  changed; ticket 02b's narrowed E6/E4 predicates consumed as found.
- `src/shared/lane-checker-render.ts` — one import swap (`LaneErrorClass` → `LaneFindingClass`), the
  E6 and E4 instance lines' wording, two identical section-header strings, one doc paragraph.
- `src/db/note-settlement.ts` — one appended block at EOF (the relocated reset + its two private
  helpers) and one doc-comment edit at ~550.
- `src/db/schema.ts` — the `resetNoteSettlementJobToStageOne` import moved from the deleted module to
  `./note-settlement`. No logic change.
- `tests/db/lane-checker-load.test.ts`, `tests/mcp/timeline*.test.ts`, `tests/db/lanes.merge.test.ts`,
  `tests/shared/relation-word-release-gate.test.ts` — NOT touched (ticket 15's files).

---

## Integrator adjudication (main, 2026-09-03)

Merged `e2669f64` no-ff, clean beside ticket 15 (the gate's literal-keyed allowlist survived the
teaching edits untouched). Bundles rebuilt. `npx tsc --noEmit` 0; guards green. Full `bun test`
**4801 / 0 / 276**: 4802 (after 15) + 2 (the integrator's gate rewrite, `fa1207d4`) − 3 (this ticket's
net) = 4801, accounted. Closure grep over `src/` for the seven deleted names: 0 live hits (absence
comments and the `DROP TABLE IF EXISTS` statements only).

My probes, on sites the worker's six did not use:

| # | mutation | result |
|---|---|---|
| I1 | `narrowWritableProvenanceCheck`: the filtered copy keeps every row (retired provenances survive the rebuild) | RED — "the CHECK migration rebuilds an old snapshot table and drops the retired rows" |
| I2 | the bounded address list reports the shown count instead of the remainder | RED ×2 (the P2-D bound tests) |

Restored by `cp`, md5 verified. Accepted. The worker's two keeps are right and inside the ticket's
"only it uses" line: the claim monitor on both dispatch shapes serves ordinary lease loss (not
invalidation), and `resetNoteSettlementJobToStageOne` is the cutover fence's own tool (relocated to
`note-settlement.ts`, renamed). One half-mechanism it named survives and needs a later subtraction:
`settlementWritePermissions`/`settlementTurnPermissions` and the facade's field gate can no longer
answer `fields: false` — every surviving provenance carries both authorities — so the refusal branch is
unreachable; deleting it reaches `write-gate.ts` and the finding-class rule's condition 3. Recorded as
follow-up 16, not built here. The six suites that used a draft edge as their generic "blocking finding"
were re-aimed at E4 rather than left vacuous — the right call; one byte-shape fixture keeps its `[E6]`
text for its measured length.
