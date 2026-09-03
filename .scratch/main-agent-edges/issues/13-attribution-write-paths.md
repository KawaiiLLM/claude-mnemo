# 13 — Every attribution write goes through the one rule and the one seam

**What to build:** repairs from the whole-batch peer review (S15069/T2461, P1-3, P1-6, P1-7, P1-9). After it, a pair collision anywhere resolves by `selectLogicalEdgeRow` (most specific class, then lowest id); creating a lane is an attribution mutation that runs the seam; a membership veto is honoured by every caller before it changes anything else; the claim scope is replaced atomically under a generation CAS.

**Blocked by:** None.

**Status:** LANDED

## Findings, verified at 36af9878

- **P1-3 — two write paths pick a collision survivor by the wrong rule.** `mergeLaneTag` (lanes.ts ~729–816) changed its identity key to pair+side but still picks the survivor by provenance/creation time; `normalizeIncidentAttribution`'s clear-collision path (normalize-incident-attribution.ts ~260–357) DELETES the current row outright. Both can delete a `correct/full` and keep a `use`, contradicting `selectLogicalEdgeRow` (memory-edges.ts ~420–455) which the fold and the writer use. Ticket 01 recorded the first as a divergence; the peer classified it as a defect. It is.
- **P1-6 — `create lane` bypasses the seam.** `remember.ts` ~783–833 and `note-settlement-membership-facade.ts` ~445–475 call `insertLane` directly. Turns already carrying the word become members of the new lane; a blank side on such an endpoint goes `derived` → `ambiguous` with no normalisation, no PRE record, no invalidation.
- **P1-7 — claim scope replace is neither transactional nor CAS'd.** `persistNoteSettlementClaimScope` (settlement-job-invalidation.ts ~119–136) does DELETE + INSERT without a transaction or a generation check; a stale generation N dispatch can overwrite generation N+1's scope, and readers can see it empty in between.
- **P1-9 — two callers ignore the membership veto after already mutating the turn.** `turns.ts` ~456–505 (reset clears extraction fields, then calls `writeMembershipTags` without reading `.ok`) and `hooks/capture-repair.ts` ~203–253 (marks compact, deletes outgoing edges, ignores `.ok`). A lane-stranding refusal leaves old tags/membership beside the already-applied change.

## What to change

- [x] ONE survivor rule: both collision sites call `selectLogicalEdgeRow` (import it; no local rule) and the loser is deleted with the existing receipt. A test on each path seeds `correct/full` (higher id) vs `use` (lower id) and asserts the `correct/full` row survives; the revert probe (provenance/time rule restored; delete-current restored) names the red test.
- [x] Lane creation runs `normalizeIncidentAttribution` for every turn that already carries the word, inside the same transaction as `insertLane` — one seam (P2). AMENDED BY RULING (S15069/T2465, mid-ticket): an ambiguous side is a warning only now, no repair authority — `onAmbiguous` is pinned to a constant `"keep"` at both call sites rather than the live-job branch the ticket originally asked for (that branch is now dead weight the seam's own default still carries for OTHER callers, out of this ticket's scope to touch). Test, redesigned after the ruling made the original scenario unprovable (see report): a stray, unrelated invalid declaration on the SAME conscripted turn is cleared as a side effect of the re-resolution, proving the seam ran over every incident side, not just the new lane's own edge.
- [ ] SUPERSEDED BY RULING (S15069/T2465): `persistNoteSettlementClaimScope`'s transaction + generation CAS. The claim-scope table and its invalidation machinery are expected to be retired by ticket 14; `persistNoteSettlementClaimScope` is untouched. See report.
- [x] The membership judgment and the caller's own turn mutation run in ONE transaction, and a refusal leaves ZERO fields changed — not a preflight followed by a separate write. `writeMembershipTags`'s `.ok` is honoured and the refusal surfaced (thrown `MembershipWriteRefusedError`, matching every existing "thrown, not returned" caller in this codebase). Tests for both callers assert every field unchanged after a lane-stranding refusal.

## What to prove

- [x] Revert probe per predicate, red test named; ≥4 (one per finding), verified applied, md5-restored. Six probes landed (both P1-3 sites, both P1-6 sites, both P1-9 sites) — see report.

## Constraints

- `~/.claude-mnemo/` STRICTLY READ-ONLY. NEVER `git stash`/`checkout`/`checkout-index`/`restore`/`reset`/`clean`; restore from your own `cp` copies, md5-verified.
- Explicit pathspecs; never stage `plugin/scripts/*.cjs`; nothing under `.scratch/` but this ticket. No control bytes; `anthropic-ai` in worker.cjs = 0. No subagents. No version bump, no push.
- `npx tsc --noEmit` clean; `npm run typecheck:tests` no new errors in touched files; full `bun test` once with every delta accounted (baseline 4785/0/274 at 36af9878); `npm run build`; guards green; `git diff --check` clean.

## Report (LANDED)

Branch `worktree-agent-a8e60a775aab1524c`, worktree fast-forwarded onto `main` at `62cb3f94` before work started (`git merge --ff-only main` — clean, no conflicts).

**Mid-ticket ruling (S15069/T2465, delivered by the coordinator after item 1 landed):** an ambiguous side is a warning only now — no deletion, no job invalidation, no repair authority. Consequences applied here: item 3 dropped entirely (see below); item 2's `onAmbiguous` pinned to a constant `"keep"` at both call sites instead of the live-job branch the ticket text asked for.

### Item 1 — ONE survivor rule (P1-3)

`selectLogicalEdgeRow` (`src/db/memory-edges.ts`) widened from `(rows: readonly MemoryEdge[])` to a generic `<T extends { id: number; relationClass: string }>` — the function only ever reads `id` and `relationClass` (coverage is deliberately NOT part of the rank; see the module's own comment), so every caller's own raw-SQL row shape satisfies the bound without a cast. Existing callers (`schema.ts`'s cutover fold, `citations.ts`) infer `T = MemoryEdge` exactly as before — zero behavior change there.

- `src/db/lanes.ts`'s `mergeLaneTag` collision loop: replaced `sortLaneModelV12MergeGroup`/`laneModelV12MergeRule` (provenance-then-age) with `selectLogicalEdgeRow` over `{id, relationClass, relationCoverage}` candidates built from the bucket. `LaneMergeEdgeRow` gained a `relationCoverage` column (added to its SELECT); `LaneMergeCollision.rule`'s type changed from the historical `LaneModelV12MergeRule` (`"provenance"|"earlier"`, still used unmodified by the UNRELATED one-time v12 vocabulary migration at the bottom of the same file) to a new `LogicalEdgeCollisionRule` (`"specificity"|"lowest-id"`).
- `src/db/normalize-incident-attribution.ts`'s `collidingSibling` clear-collision path: was unconditional "delete the row currently being cleared, keep the lowest-id sibling found by the SQL join." Now computes the winner via `selectLogicalEdgeRow([{id: row.id, relationClass: row.relationClass}, sibling])` and deletes whichever one loses — including a new branch where `row` (the one being cleared) survives and the pre-existing `sibling` is deleted instead, with its own `delete-edge` receipt.

Tests: `tests/db/lanes.merge.test.ts` — the two pre-existing collision tests (`"asserted survives..."`, `"EQUAL provenance keeps..."`) retitled and re-asserted for the new rule (both rows shared class `use` in both fixtures, so the new tie-break is "lowest id," not provenance/age; one test's OUTCOME changed because its lower-id row was the `judged`/earlier one, which used to lose and now wins). A new test seeds `correct/full` at the HIGHER id vs `use` at the LOWER id and asserts `correct/full` survives with `rule: "specificity"`. `tests/db/normalize-incident-attribution.test.ts` gained one new test doing the equivalent at the seam's own collision site, using `downgradeToPreCutoverShape`/`seedPreCutoverEdge` to seed two legacy rows on one pair.

`grep -n selectLogicalEdgeRow src/db/lanes.ts src/db/normalize-incident-attribution.ts` shows the import and the call at each site (verbatim re-check below).

### Item 2 — lane creation through the seam (P1-6), amended by the ruling

Both callers (`src/mcp/remember.ts`'s `create` lane-tier branch, `src/worker/note-settlement-membership-facade.ts`'s `create` action) now call `normalizeIncidentAttribution(db, turnIdsCarryingTagInSegment(db, tag, segmentId), { writer: LANE_CREATE_WRITER, nowEpoch, onAmbiguous: () => "keep" })` immediately after a successful `insertLane`, inside the same already-open write transaction (`remember.ts`'s own `writeTransaction(...)`; the facade's caller, `note-settlement-direct-write.ts`, already wraps every evaluation in one transaction — stated in the facade's own module doc). New helper `turnIdsCarryingTagInSegment` (`src/db/lanes.ts`) is the row-returning twin of the existing `countTurnsCarryingTag`'s `inSegment` count. New writer id `LANE_CREATE_WRITER = "lane:create"` (`src/db/write-gate.ts`), matching `LANE_MERGE_WRITER`/`LANE_CLEAR_WRITER`'s own pattern and reasoning (never stamp under the caller's own writer id, or the caller could keep writing against a set its own structural verb just rewrote).

**Deviation from the ticket's literal text, and why:** the ticket asks for "the live-job branch" (i.e., `normalizeIncidentAttribution`'s DEFAULT `onAmbiguous`, which tries `invalidateOverlappingSettlementJobs` first). Ruling T2465 forbids exactly that default's two effects (deletion, job invalidation) for an ambiguous side. Passing `onAmbiguous: () => "keep"` at these two call sites — rather than editing the seam's shared default, which tickets 02/04 already shipped and whose own large test suites (`normalize-incident-attribution.test.ts`, `settlement-derived-side-closure.test.ts`, `lanes.merge.test.ts`, `segments.merge.test.ts`) assert the OLD default's delete/invalidate behavior — is a judgment call: changing the shared default is squarely ticket 02/04/14 territory and would cascade into dozens of tests this ticket has no mandate to rewrite. **Flagging this for the parent to confirm**: if the intent was for the SHARED default itself to become a no-op project-wide, that is a substantially larger change than ticket 13's four items and should be its own ticket.

**A real gap found and fixed while writing the test.** My first draft of the test asserted "the edge stays `ambiguous`, is kept, and gets no delete receipt" — and it PASSED even with the seam call deleted outright, because minting a lane can only ever ADD cardinality to an endpoint, never remove it or invalidate an existing tag; combined with the ruling's own no-op default, there is NO reachable state in which the seam call's absence changes anything observable for that scenario. Both tests were redesigned around a second, unrelated edge on the SAME conscripted turn that already carries a stale, out-of-tags declaration (`tailTag: "stray-lane"`, never in the turn's own tags) — `normalizeIncidentAttribution` re-resolves EVERY incident side of the turns it's given, so that stray declaration gets cleared as a side effect of the conscription's own re-resolution pass. Verified load-bearing: removing the wiring makes this assertion fail (probes 3/4 below); the original "kept, unreceipted" assertions are still checked in the same test as a correctness statement, just not the part that is independently provable.

### Item 3 — SUPERSEDED (P1-7)

Not implemented. `src/db/settlement-job-invalidation.ts`'s `persistNoteSettlementClaimScope` is byte-identical to HEAD. Per the ruling, the claim-scope table and its invalidation are expected to be retired by ticket 14; work here would be waste.

### Item 4 — membership veto atomicity (P1-9)

- `src/db/turns.ts`'s `resetTurnExtractionFields`: reordered and wrapped in `runWriteTransaction`. `writeMembershipTags` now runs FIRST (its own refusal check is over the whole batch before its first `UPDATE`, so on refusal nothing has been written by the time it returns); on `!ok` it throws a new `MembershipWriteRefusedError` (added to `src/db/segments.ts`, wrapping the `{ok:false, refusals, message}` result), which the transaction unwinds. The turn's own `UPDATE`, the FTS reindex and the facet recompute all run after, inside the same transaction.
- `src/hooks/capture-repair.ts`'s `convertOccupiedTurnToMarker`: same shape — `writeMembershipTags` moved to the top of the function, `.ok` checked, throws `MembershipWriteRefusedError` on refusal before the turn's own `UPDATE`/edge deletion/stamp run. This function has no transaction of its own (`applyCaptureRepair`'s doc comment: "Caller owns the surrounding transaction") — production wraps it in `runHookWriteTransaction`; the reordering alone (not the absent transaction) is what makes the unit test's non-transactional call also see zero side effects on refusal.

Tests: `tests/db/membership-primitive.test.ts` (new test, alongside the existing `resetTurnExtractionFields` coverage) and `tests/hooks/capture-repairs.test.ts` (new test, alongside the existing "occupied-promptId conversion" describe block) each seed a declared lane whose sole remaining declaration would be stranded by the reset/conversion's own tag rewrite, assert the call throws `MembershipWriteRefusedError`, and assert the turn row and every `memory_edges` row are byte-identical (`toEqual`) to a snapshot taken before the call.

### Revert probe table (6, all verified applied — diff stat shown — then md5-restored)

| # | finding | file | mutation | red test | restored (md5) |
|---|---|---|---|---|---|
| 1 | P1-3 site 1 | `src/db/lanes.ts` | survivor picked by `sortLaneModelV12MergeGroup` (provenance/age) again | `mergeLaneTag — one lane folded into another (ticket 15) > the MORE SPECIFIC class survives even at a HIGHER row id — specificity outranks id order` | `d25978643a94d82b5b77cc0072ff16cf` |
| 2 | P1-3 site 2 | `src/db/normalize-incident-attribution.ts` | `collidingSibling` branch back to unconditionally deleting `row` | `normalizeIncidentAttribution > a collision the clear causes folds through selectLogicalEdgeRow: correct/full survives a lower-id use sibling (ticket 13, P1-3)` | `0cb3bf56b23f412dacbbb4da66b3dfc2` |
| 3 | P1-6 site 1 | `src/mcp/remember.ts` | seam call after `insertLane` removed | `remember tool (ticket 02) > create (lane tier) / delete (ticket 01/06) > create — lane tier (ticket 05) > conscripting a turn into a new lane re-resolves EVERY incident side, clearing a stale invalid declaration, and leaves the newly-ambiguous side kept, unreceipted` | `6a5aeea2342fdd895669e4ec96a8b7e3` |
| 4 | P1-6 site 2 | `src/worker/note-settlement-membership-facade.ts` | seam call after `insertLane` removed | `create (lane tier) / delete — settlement's half of the lane registry (ticket 02) > conscripting a turn into a new lane re-resolves EVERY incident side, clearing a stale invalid declaration, and leaves the newly-ambiguous side kept, unreceipted` | `a4e7875c328d5138f4b1b73b847a8f51` |
| 5 | P1-9 site 1 | `src/db/turns.ts` | back to unconditional `UPDATE` first, no transaction, `.ok` unread | `the membership primitive > every routed path > \`resetTurnExtractionFields\` refuses ATOMICALLY when the reset would strand a declared lane — every field left byte-identical` | `867af85a116019ca4a24816970193151` |
| 6 | P1-9 site 2 | `src/hooks/capture-repair.ts` | back to unconditional `UPDATE` first, `.ok` unread | `capture repairs > occupied-promptId conversion > refuses ATOMICALLY when the conversion's tag rewrite would strand a declared lane — no field of the turn or its edges changes` | `8ad4d8440de3487bf0c4a4cb5e60f1c6` |

### Verification

`npx tsc --noEmit`: 0. `npm run typecheck:tests`: pre-existing baseline errors only (326 total across the tree, none newly introduced by this ticket) — fixed the ONE error this ticket's own type change caused (`tests/worker/note-settlement-membership-facade.test.ts:735`, a pre-existing literal `rule: "provenance"` in a receipt-render fixture, updated to `"lowest-id"`); every other error is at an unrelated line/file (verified by line number against every file this ticket touched) and pre-dates this ticket — inherited from the `git merge --ff-only main` fast-forward, which pulled in a large amount of concurrent in-flight work (tsconfig.tests.json, main-agent-edges tickets 01-12, relation-vocabulary-v13, etc.) whose test-only typing hasn't been reconciled yet. UNVERIFIED: whether that 326-error baseline is itself expected/known to the parent — flagging rather than fixing, since none of it is in this ticket's four files.

Full `bun test`: **4791 pass / 0 fail / 274 files**, baseline **4785/0/274** at `62cb3f94`. Delta is exactly `+6`, one new test per touched test file: `tests/db/lanes.merge.test.ts` (+1, the specificity test — the other two collisions in that file were retitled/re-asserted, not added), `tests/db/normalize-incident-attribution.test.ts` (+1), `tests/mcp/remember.test.ts` (+1), `tests/worker/note-settlement-membership-facade.test.ts` (+1), `tests/db/membership-primitive.test.ts` (+1), `tests/hooks/capture-repairs.test.ts` (+1).

`npm run build`: clean. `bun test tests/shared/release-artifacts.test.ts`: 11/11 (failed once, pre-build, on the stale-bundle guard — expected, since the bundles hadn't been rebuilt yet at that point; rebuilt with `npm run build`, then green). `git diff --check -- src/ tests/`: clean. Control-byte sweep over the diff: clean. `grep -c anthropic-ai plugin/scripts/worker.cjs`: 0. No `.scratch/` file touched outside this ticket. No `plugin/scripts/*.cjs` staged (rebuilt on disk only, as required for the release-artifacts guard to pass, but never `git add`ed). No version bump, no push.

### Shared-file hunks (for the integrator)

- `src/db/memory-edges.ts` — `selectLogicalEdgeRow`'s signature widened (generic, narrower field bound). Backward compatible; every existing caller's inferred type is unchanged.
- `src/db/write-gate.ts` — one new exported constant, `LANE_CREATE_WRITER`, added beside `LANE_MERGE_WRITER`/`LANE_CLEAR_WRITER`. No existing export touched.
- `src/db/segments.ts` — one new exported error class, `MembershipWriteRefusedError`, added beside `MembershipWriteRefusal`/`MembershipWriteResult`. No existing behavior of `writeMembershipTags` itself changed.
- `src/db/lanes.ts` — `mergeLaneTag`'s collision loop rewritten (survivor rule); `sortLaneModelV12MergeGroup`/`laneModelV12MergeRule`/`rankLaneModelV12MergeProvenance` left INTACT and still used by the unrelated `runLaneModelV12VocabularyMerge` one-time migration later in the same file. New export `turnIdsCarryingTagInSegment`. If ticket 12 or another concurrent ticket also touches this file, the collision-loop region (~line 800) and the new function near `countTurnsCarryingTag` (~line 247) are the hunks to watch for.
- `tests/worker/note-settlement-membership-facade.test.ts` — one pre-existing test's fixture literal (`rule: "provenance"` → `"lowest-id"`) plus one new test in the `create` describe block. If ticket 12 or 14 also touches this file, both are small, localized hunks.

### FALSE-at-HEAD / premises checked

None of the four items' premises were false at HEAD as originally stated in the ticket — all four findings (P1-3 both sites, P1-6 both sites, P1-9 both sites) were verified present and reproducible via the revert probes above before item 3 was superseded by the mid-ticket ruling.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017wgBfgUE6NJuqgHWpbVi2B
