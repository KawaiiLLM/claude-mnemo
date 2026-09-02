# 06 — Settlement's edge pass: declare, fill, review — and the delta formulas

**What to build:** spec D6's teaching; replaces read-once ticket 05. Stage 2 finds the main agent's edges present; it declares ambiguous sides, fills what was missed, reviews (retract, `lane_check`, debts, impressions, commit). `finalize` computes and prints, inside the transition transaction after all stage-1 writes: `finalWritableIds = frozenWritableIds ∪ derivedDebtCiters`; `writableDelta = finalWritableIds − initialWritableIds` (relation-only authority for derived-side citers); `declarationEndpointIds = endpoints(live outgoing rows whose citer ∈ finalWritableIds)`; `contextDelta = (⋃ laneMembers(post-write) ∪ declarationEndpointIds) − initialWritableIds − writableDelta` — one hop. Stage 2 reads the union once (paginated), then nothing until the gate names a changed turn. The old "recall members with relations" / "before any edge write recall the citing turn" / stage-2 "batches of ten" sentences go (`note-settlement-prompt.ts` included). Multi-lane citing turns: one placement per pair, both sides named, decided once over the worklist.

**Blocked by:** None — 04 landed on main (735666db).

**Status:** LANDED

- [x] Delta tests: an initial-set address never appears in a delta; a lane member added by stage 1 and a remote cited endpoint each appear in `contextDelta` once and are read once; a `contextDelta` member refuses a relation write; a `writableDelta` member accepts one and refuses a note-field write.
- [x] Teaching pinned; retired sentences absent from rendered text.

- [x] **Revert probe (standing acceptance step for this batch):** for every teaching sentence you replace and every formula you implement, revert it to the pre-ticket text/behaviour, run the suite, and name in the report WHICH test went red. A `toContain` on a sentence is not a pin of the behaviour it teaches. Verify each mutation applied before trusting its output; md5-restore after.

## Constraints

- `~/.claude-mnemo/` is production data and STRICTLY READ-ONLY; measure on a `cp -c` clone of the scratchpad copy.
- NEVER `git stash` / `checkout` / `checkout-index` / `restore` / `reset` / `clean`. Restore from your own `cp` copies, md5-verified.
- Explicit pathspecs on every `git add`. No raw control bytes. `grep -c anthropic-ai plugin/scripts/worker.cjs` stays `0`.
- Every teaching sentence added or removed is pinned by a test a mutation drives red. ≥3 mutation probes of your own, RED, md5-restored — and a probe whose mutation did not apply is not a probe.
- Dispose of every applicable line of `../acceptance-matrix.md` in your report.
- [x] `npx tsc --noEmit` clean (excludes `tests/`; typecheck new tests separately); full `bun test` once with every delta accounted; `npm run build`; stale-bundle and release-artifacts guards green; `git diff --check` clean. No version bump, no push.

**Ticket-03 escape (peer review, S15069/T2438, F1):** `note-settlement-prompt.ts` ~1197–1198 still teaches, under HOMELESS RETRACTION, that "when it was the pair's last relation the bare citation comes back" — `restoreBareRowsForEmptiedPairs` was deleted by ticket 03 and `tests/worker/note-settlement-prompt.test.ts` ~2593 pins the false sentence with a shallow `toContain`. Remove the sentence and its pin here; also the pre-existing false "prose mention warning" teaching at ~1050–1058 (nothing implements it).

---

## Report (2026-09-03)

Worktree branch `worktree-agent-afa81dcee7c7d3e69`, fast-forwarded to main `b8c5dbd8` before work. Baseline `bun test` at that base: **4770 pass / 0 fail / 269 files** (matches the brief).

### What shipped

**The delta formulas, inside the transition transaction after every stage-1 write** (`src/db/note-settlement-snapshots.ts`). `writeNoteSettlementTransitionSnapshots` already computed `finalWritableIds` (its `writable` map = frozen ∪ `derived-side-citer` rows, ticket 04's closure) and `laneMembers` post-write; what it lacked was the fourth input. Added:

- snapshot #4, `note_settlement_declaration_endpoints (job_id, turn_id)` — `enumerateDeclarationEndpoints`: the cited end of every LIVE, class-bearing, turn→turn row whose citer ∈ `finalWritableIds`, taken AFTER both closures so a derived-side citer's own edges count. Persisted, because it is the one delta input the three snapshots do not already hold; cleared with them in `clearSettlementJobTransitionScratch` (`settlement-job-invalidation.ts`).
- `computeSettlementReadDeltas({writable, laneMembers, declarationEndpointIds})`, PURE over the persisted rows: `initialWritableIds` = ids carrying an ordinary class (window/lookback/closure — exactly the claim-time set stage 1's prompt printed); `writableDelta = finalWritableIds − initialWritableIds` (relations-only by construction: no ordinary class ⇒ `settlementWritePermissions` grants no field); `contextDelta = (⋃ laneMembers ∪ declarationEndpointIds) − initial − writableDelta`, one hop (a context turn's own edges are not followed). Returned on `NoteSettlementSnapshot` as `readDeltas` + `declarationEndpointIds`.
- `readSettlementFrozenScope` (shape-numbers) reads #4 and recomputes `readDeltas` from the persisted four, so the finalize result, the resume prompt and any retry print the SAME lists; `SettlementEdgesScope` carries `readDeltas` (empty until a transition); `buildSettlementWorklistRendering` gains `writableDelta`/`contextDelta` as addresses.
- Printed: `renderUnifiedFinalizeDataResult` (exported for its test) adds two DATA lines — `writable delta — relations only, not in the initial set (N): …` and `context delta — read-only, one hop, not in the initial set (N): …`; the resume prompt's `renderStageTwoWorklist` prints the same two under the homeless list. `UNIFIED_FINALIZE_TOOL_DESCRIPTION` names them.

**Where ticket 04's code and this ticket meet:** the union is 04's `writable` map as it stands at the end of `writeNoteSettlementTransitionSnapshots`; this ticket adds nothing to the union and computes the deltas over it. `removed-side-citer` provenance is still in the union but see "false at HEAD" below.

**The teaching, ONCE** (`src/worker/note-settlement-edge-pass-teaching.ts`, new — `renderEdgePassTeaching()`, the impression-teaching precedent): READ ONCE (the two deltas by authority, set differences, the union read once with the first read's own field list/budgets rendered from `note-settlement-read-budgets.ts`, then nothing until a refused write names a turn; CUT licenses / DROPPED reads once), DECLARE (resolution model; E6 = blank side on a ≥2-lane endpoint, E4 = stored side not among the endpoint's lanes; blank on unique/none never a finding; `declare` entry with both sides named, omit/`null`/`class` three-state; one placement per pair decided once over the whole worklist, a second visit never re-places), FILL (bare addresses, coverage on `correct`, one edge per pair, caps from `MAX_TURN_RELATION_DEGREE`, the two measured traps; the class judgment defers to the rubric's 三个关系类 entry), REVIEW (pair-addressed retraction with the mirror's class as precondition; `lane_check`; DEBT DISCHARGE over the writable delta; HOMELESS RETRACTION without "the bare citation comes back"). Both prompts render it verbatim:

- `note-settlement-prompt.ts` (cold resume): Block A's batch loop (batches of ten / BATCH STEP 1-3 / the ledger / "before any edge write, run this call sequence" / `turn=2000`) → one resume read sentence + the block; duty 1's Block B (two-sided draft-and-E6 entry, DISPOSE / JUDGE AND WRITE / CHECK AND REPAIR, DRAFT RECONCILIATION, "the bare citation comes back", the "prose … WARNING only" sentence) → the call shapes, `lane_check` as the review's repair queue, the surviving severed-lane and phase-connectivity teachings, the 原则/耦合 half of the settlement rubric. The frame and the E4/E6 repair sentence updated.
- `note-settlement-unified-prompt.ts`: steps 5-7 ("recall that lane's members with … relations", "PLACE EVERY EDGE AT WRITE" + `{turn, tailTag, headTag}`, "Before any edge write, recall the citing turn", "reconcile pre-existing bare drafts") → step 5 names the deltas, step 6 hands over to the block; steps renumbered 5-8; frame and E4/E6 repair sentence updated.
- `SETTLEMENT_NOTE_TOOL_DESCRIPTION`: "taught not to reach for them" (false since ticket 05), the draft-and-E6-for-any-blank-side paragraph, "Step 0's own field list", and the placement-addressed retraction sentence → the D2/D3/D4 facts; `declare` named. `UNIFIED_NOTE_TOOL_DESCRIPTION`: "six edge fields" + `declare`.
- `note-settlement-turn-facade.ts`: the RELATIONS-ONLY refusal named "re-place its sides with a {turn, tailTag, headTag} entry" (an attach never re-places a stored side since ticket 03) → "declare its side with a `declare` entry", and its cause names both closures.

### FALSE AT HEAD — found, fixed, and pinned

**`declare` was refused by the live edge-pass tool.** `STAGE_TWO_TURN_NOTE_FIELDS` (`note-settlement-sdk-query.ts`) allowlisted only the six relation/retraction keys; both registered `note` handlers (resume ~2196, unified ~3134) answered every `declare` entry with "Parameter error: declare is refused on the edge pass". Ticket 03b's F2 route test drove the facade BELOW that allowlist, so it never saw it. Spec D6 ("settlement declares ambiguous sides") was therefore not executable on the production route. Added `"declare"` to the allowlist; pinned at the registered handler (`note-settlement-sdk-query.test.ts`, "`declare` on a turn address passes the edge-pass allowlist"); probe M5 drives it red.

### FALSE AT HEAD — stated, not built on

- **The removed-side closure finds nothing through the batch tag write.** `writeMembershipTags` post-normalises in its own transaction (P2): a declaration naming a lane the projection removed is cleared to `''` before `writeNoteSettlementTransitionSnapshots` looks for `head_tag = <removed>`, and the side then reads `ambiguous` — the DERIVED closure's case, which grants the same relations-only authority. So `removed-side-citer` is unreachable from stage 1's real write path; the writable delta's members all arrive as `derived-side-citer`. Recorded in the delta test with the fixture that shows it (`scope.debts` empty, provenance `derived-side-citer`). Not removed here — the removed-side machinery is ticket 04's/02's and deleting it is a ruling.
- The rubric's own 充分引用 sentence (`memory-rubric.ts`, byte-pinned user-authored source) says the lint「只作为警告出现,从不阻止写入」— the same nonexistent lint the prompt sentence claimed. Out of this ticket's surface (the rubric is the user's text); named for adjudication.
- `mcp/definitions.ts`'s settlement field describes (`RELATION_TAG_FORM_LINE`: "both sides unsettled — the draft an edge starts as", "Place BOTH or NEITHER"; `RETRACTION_TAG_FORM_LINE`: "a two-sided one retracts exactly that lane placement") still describe the stored-side model and the pre-03 retraction address. Not touched (they are the shape's describes, ticket 03/07 territory); named.

### Per-box disposition

- Delta tests — DONE, `tests/db/settlement-read-deltas.test.ts` (7): an initial-set address (window/lookback, also a lane member, a cited endpoint and a removed-side cited end) appears in neither delta and the deltas are disjoint; a lane member ADDED by stage 1's batch write and a remote cited endpoint each appear in `contextDelta` exactly once, a turn qualifying both ways once, a one-hop endpoint through a writable-delta citer once, and each prints once across the three set lines of the finalize result and on the resume rendering; a `contextDelta` member's relation write is refused through the real direct-write engine ("outside this dispatch's reviewable window", zero rows); a `writableDelta` member accepts a relation write ("Landed 1 relation") and refuses `title` (RELATIONS ONLY, no shadow note). Plus: #4 frozen at the transition (a later edge changes nothing a retry reads), cleared by invalidation, empty deltas for a never-transitioned job.
- Teaching pinned; retired sentences absent from rendered text — DONE, `tests/worker/note-settlement-edge-pass-teaching.test.ts` (15): every load-bearing sentence of the block, numbers asserted against the constants, the block present ONCE in each rendered prompt, and 22 retired needles asserted absent from the RENDERED text of both hosts. Host-side pins in `note-settlement-prompt.test.ts` (new procedure + duty-1 describes; Block A/B verbatim guards retired with a note, C/D kept) and `note-settlement-unified-prompt.test.ts`.
- Ticket-03 escape — DONE: "the bare citation comes back" and its shallow `toContain("the bare citation")` pin removed (the pin is now an absence); the "prose … WARNING only" sentence removed and pinned absent.
- Revert probe — DONE, table below.
- tsc / typecheck:tests / bun test / build / guards / diff --check — DONE, numbers below.

### Probe table (every mutation verified applied by md5 before the run; every file md5-restored from a `cp` backup after)

| # | file | mutation | red |
|---|---|---|---|
| M1 | `db/note-settlement-snapshots.ts` | `contextDelta` no longer subtracts `writableDelta` | "an initial-set address never appears in a delta" (disjointness) |
| M2 | same | every id counted as initial (closures swallowed) | that test + "a writableDelta member accepts a relation write…" |
| M3 | same | `enumerateDeclarationEndpoints` returns nothing | 4: "…contextDelta once, and print once", "a contextDelta member refuses…", "frozen at the transition", "an invalidation clears snapshot #4" |
| M4 | same | snapshot #4 computed but not persisted | the same 4 |
| M5 | `worker/note-settlement-sdk-query.ts` | `declare` dropped from `STAGE_TWO_TURN_NOTE_FIELDS` | "`declare` on a turn address passes the edge-pass allowlist" |
| M6 | `worker/note-settlement-edge-pass-teaching.ts` | "A blank side on an endpoint in ONE lane or in NO lane is never a finding…" dropped | "states the resolution model and what E6 and E4 are under it" |
| M7 | `worker/note-settlement-unified-prompt.ts` | `renderEdgePassTeaching()` removed from PHASE 2 | "the block is in both rendered prompts, once each" + "step 5 names the two read deltas… step 6 hands over" |
| M8 | `worker/note-settlement-prompt.ts` | resume worklist omits the context-delta addresses | "the worklist is declared with its lanes, frozen members, debts and homeless dispositions" |
| M9 | same | resume read sentence back to "ten-turn batches" | "the resume read is ONE sweep over the writable set plus the context delta…" |
| M10 | `worker/note-settlement-sdk-query.ts` | finalize prints the writable delta under the context label | "…contextDelta once, and print once" |
| R1 (revert) | `note-settlement-prompt.ts` → HEAD text | 18 red, incl. "no retired sentence renders in either prompt", "the block is in both rendered prompts", the procedure/duty-1 describes |
| R2 (revert) | `note-settlement-unified-prompt.ts` → HEAD text | 5 red: both host tests, "the stored-side teaching is absent from the RENDERED prompt", the step-5/6 pin, the renumbered commit-duty pin |
| R3 (revert) | `note-settlement-sdk-query.ts` → HEAD text | 8 red: the four description pins (tag-mandate), the THREE-CLASSES surface pin, the `declare` allowlist pin, the delta tests importing the renderer |
| R4 (revert) | `note-settlement-turn-facade.ts` → HEAD text | "a writableDelta member accepts a relation write and refuses a note-field write" (the refusal no longer names `declare`) |
| R6 (revert) | `db/note-settlement-snapshots.ts` → HEAD text | both test files fail to load (the delta API is gone) — coarse; M1-M4 are the fine-grained formula probes |

### Acceptance-matrix dispositions

- **R9-9 / R10-7** (`derived-side-citer` executable; finalize result/continuation read the final snapshot) — CONSUMED: this ticket's deltas are computed over ticket 04's final union inside the same transaction and read back from the persisted snapshot by both renderers; the closure itself is untouched. R10-7's "finalize result reads the final snapshot" is now also what prints the deltas.
- **R10-5** (public entry union; declaration by pair with class as CAS) — TAUGHT, not implemented: the block teaches the bare form and `declare`'s `class` precondition exactly as ticket 03 built them; and the live route now admits `declare` (the HEAD bug above).
- **R9-2, R10-6** (post-normalisation maintains "stored means several lanes") — NOT APPLICABLE to build; NAMED as the reason the removed-side closure is unreachable (above).
- **R9-1, R9-3, R9-4, R9-5, R9-6, R9-7, R9-8, R10-1, R10-2, R10-3, R10-4, R10-8, R10-9, R10-10** — NOT APPLICABLE (cutover, election, raw-word retirement, tag invariant, invalidation, console).

### Verification

`npx tsc --noEmit` 0 errors. `npm run typecheck:tests`: **358** errors, the same 358 as main — none new in any touched or new file (the two pre-existing ones in `note-settlement-prompt.test.ts` — the duplicate import at lines 27/42 and the two 4-arg calls — are ticket 05's recorded find, untouched). `bun test`: **4787 pass / 0 fail / 271 files** against 4770/0/269; delta +17 tests / +2 files accounted by test-definition count: `settlement-read-deltas` +7 (new), `edge-pass-teaching` +15 (new), `sdk-query` +1, `unified-prompt` +1 (−1 +2), `prompt.test` −7 (−20: Block A describe 7, edges-bullet describe 7, call-sequence describe 3, verbatim A/B 2, batch-loop `lane_check` 1; +13: procedure describe 5, duty-1 describe 8), `tag-mandate` 0 (−3 +3), `relation-vocabulary` 0, `call.test` 0 (one test re-aimed). One full run showed 4786/1 before the `call.test` re-aim; the run after it is the number above. `npm run build` clean; `tests/shared/release-artifacts.test.ts` 11/0; `grep -c anthropic-ai plugin/scripts/worker.cjs` = 0; the bundles carry `note_settlement_declaration_endpoints`; `git diff --check` clean; 0 control bytes across the 16 touched/new files (python sweep). Bundles rebuilt and left UNSTAGED. No version bump, no push.

### Shared-file hunks (for the integrator)

- `src/shared/lane-checker.ts`, `src/db/lane-checker-load.ts`, `src/worker/note-settlement-dispatch.ts` (02b's) — NOT touched.
- `src/worker/note-settlement-sdk-query.ts` — four hunks: `STAGE_TWO_TURN_NOTE_FIELDS` + `declare`; `SETTLEMENT_NOTE_TOOL_DESCRIPTION` (three clauses); `UNIFIED_NOTE_TOOL_DESCRIPTION` / `UNIFIED_FINALIZE_TOOL_DESCRIPTION` one clause each; `renderUnifiedFinalizeDataResult` exported + two lines.
- `src/worker/note-settlement-turn-facade.ts` — one hunk, the RELATIONS-ONLY refusal text (~1415).
- `src/db/settlement-job-invalidation.ts` — one line (the scratch-clear table list).
- `tests/worker/note-settlement-sdk-query.test.ts` — one test appended inside the ticket-17 describe (~790) and one two-line pin re-aim (~1052).
- `tests/shared/tag-mandate-teaching-surfaces.test.ts` — the retired-verb detector matches `declare` in verb form only (it is `note`'s live entry field since ticket 03); three description pins re-aimed.

### UNVERIFIED

- No production measurement (D8 is ticket 09's); the delta sizes on a real window are not known.
- `renderStageTwoWorklist`'s two delta lines and the resume prompt's read sentence are exercised by the resume dispatch's own render path in tests, not by a live resume run.
