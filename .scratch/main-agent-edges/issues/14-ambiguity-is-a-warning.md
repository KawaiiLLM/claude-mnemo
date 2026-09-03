# 14 — Ambiguity is a warning: the repair machinery goes, the teaching says what the code does, finalize is bounded

**What to build:** the user's ruling (S15069/T2465–T2466): a side that resolves `ambiguous` is a WARNING and nothing more — kept, not deleted, no job reset, no repair authority, no mechanism. This ticket SUBTRACTS everything that existed only to hand an ambiguous side a repair channel (ticket 04's second half and its ticket-06 consumers), demotes E6 from an error to a warning, fixes the two teaching defects the peer found (P1-10, P2-C), bounds finalize output (P2-D), and deletes `removed-side-citer` (P2-F). Peer findings P1-4, P1-5, P1-7 and P1-8 are dissolved by the deletion, not fixed.

**Blocked by:** 13 (its lane-creation item touches the same seam; merge `main` after 13 lands). Ticket 12 owns the cutover's transform 5 change (keep ambiguous edges) — not this ticket.

**Status:** ready-for-agent (after 13)

## Delete (each with a one-line reason in the report; CHECK constraints that name a value are migrated the way ticket 04 migrated its own)

- [ ] `invalidateOverlappingSettlementJobs` and everything only it uses: `note_settlement_claim_scope` (+ `persistNoteSettlementClaimScope`, both dispatch call sites), the cancellation arming/claim monitor added for it in both dispatch shapes (keep whatever the resume shape needed BEFORE ticket 04 for its own claim loss — check ticket 04's report: "the resume dispatch gained the claim monitor it lacked" — if that monitor is needed for ordinary claim loss, keep it and say so), the `onAmbiguous` default in `normalizeIncidentAttribution` (a side becoming ambiguous is a no-op; `clearLane`'s attribution-only behaviour unchanged; redundant/invalid clears unchanged).
- [ ] `note_settlement_pre_side_resolutions`, `enumerateDerivedSideCiters`, the PRE write in the seam, `derived-side-citer` and `removed-side-citer` provenances (+ their debts, the removed-side debt table if separate, `RELATIONS_ONLY_PROVENANCES` if empty afterwards), and `writableDelta` in `computeSettlementReadDeltas` / snapshot #4's dependence on them: `finalWritableIds = initialWritableIds`; `contextDelta` stays (lane members added by stage 1 ∪ declaration endpoints of writable citers − initial). Update ticket 06's teaching lines that name the writable delta.
- [ ] The tests of the deleted machinery go with it; a test that pinned a now-false rule ("a newly ambiguous side invalidates the job / deletes the edge") is REPLACED by its opposite: the edge is kept, the job is untouched, the read renders `ambiguous`.

## Change

- [ ] E6 is a WARNING class: `lane-checker.ts` moves it from `LaneErrorClass` to the warnings; `lane_check`/preview/`commit` never refuse on it; the three-layer audit still reports it. E4 stays an error. Renderers unchanged (they already print `ambiguous`).
- [ ] Teaching says what the code does (P1-10, P2-C): `definitions.ts` retraction text states the pair rule (sides ignored, one edge per pair, a two-sided entry is not "only that placement"); the E4/E6 teaching in `note-settlement-sdk-query.ts` (~494–518, ~644–663, ~1372–1394) states the resolved-side model — E6: may `declare` the side on a multi-lane endpoint, may leave it, never blocks; E4: `declare` a valid lane or retract; never "add the tag"/"place both sides"/"either empty". Every added sentence pinned, every retired sentence absent from RENDERED text.
- [ ] Finalize output bounded (P2-D): the set lines and the lane roster obey the worklist rendering's existing budget/pager (no new mechanism); overflow named with a count, never silently cut.

## What to prove

- [ ] `grep -rn "derived-side-citer\|removed-side-citer\|note_settlement_claim_scope\|note_settlement_pre_side_resolutions\|invalidateOverlappingSettlementJobs" src tests` → 0 hits.
- [ ] A structural change (task move / lane merge) that makes a side ambiguous under a live claimed job: edge kept, job status/generation/snapshots unchanged, relations read shows `ambiguous`; revert probe (old invalidate/delete behaviour restored) red, test named.
- [ ] `commit` with an outstanding E6 succeeds; with an E4 refuses; probe: E6 back in the error set → red.
- [ ] Closure of the deletion (the peer's second-round checklist, S15069/T2467): no half-mechanism survives in schema (tables, CHECKs, migrations), dispatch (both shapes), the claim monitor, `clearSettlementJobTransitionScratch`/scratch cleanup, tool teaching, receipts/reports, or tests — list every site removed. E4 stays an ERROR and is still cleared automatically by write validation and the structural seam; a test proves E4 alone still refuses commit after E6's demotion.
- [ ] Revert probe per predicate, ≥4, verified applied, md5-restored.

## Constraints

- `~/.claude-mnemo/` STRICTLY READ-ONLY. NEVER `git stash`/`checkout`/`checkout-index`/`restore`/`reset`/`clean`; restore from your own `cp` copies, md5-verified.
- Explicit pathspecs; never stage `plugin/scripts/*.cjs`; nothing under `.scratch/` but this ticket. No control bytes; `anthropic-ai` in worker.cjs = 0. No subagents. No version bump, no push.
- `npx tsc --noEmit` clean; `npm run typecheck:tests` no new errors in touched files; full `bun test` once with every delta accounted; `npm run build`; guards green; `git diff --check` clean.
