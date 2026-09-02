# 02b — Two rewritten readers get a test that goes red when they are reverted

**What to build:** the two ticket-02 rewrites the peer's implementation review (S15069/T2442, findings F2 and F4) showed to be indistinguishable from what they replaced each gain a test that a revert to the pre-ticket-02 behaviour drives RED; the dead legacy branch that made one of them indistinguishable is DELETED, not covered.

**Blocked by:** None — 02 and 04 have both landed on main.

**Status:** LANDED — report below.

## The two findings, verified at `4c4f4c81`

- **F2 — a dead fallback branch hides the narrowed E6 predicate from its own unit suite.** `computeDraftEdgeErrors` in `src/shared/lane-checker.ts` gates the narrowed predicate on `edge.tailOutcome !== undefined || edge.headOutcome !== undefined` and otherwise runs the pre-ticket-02 blank-tag logic. The shared fixture builder (`tests/support/lane-edge-fixtures.ts`) carries no outcome fields and `tests/shared/lane-checker.test.ts` mentions `tailOutcome` zero times, so that file's whole E3/E4/E6 suite exercises the OLD predicate and stays green if the narrowing breaks. Real coverage exists only through the loader tests.
- **F4 — `loadSegmentFacts` / `emptyLaneTags` in `src/db/lane-checker-load.ts` resolves attribution instead of reading the declaration index, but every fixture in the ticket-14 block declares a tag that is also the endpoint's ONLY lane, so `declared` and `derived` are byte-identical.** The peer patched the function back to reading `tailTag`/`headTag` verbatim and 64 of 65 tests stayed green.

## What to change

- [x] **Delete the fallback branch in `computeDraftEdgeErrors`** (user ruling S15069/T2419: subtract, do not accommodate). The checker's edge input carries resolved outcomes, full stop; every caller that reaches it without outcomes is fixed at the caller or in the fixture builder, whichever is the real source. Do not add outcome fields to fixtures as a way of keeping the branch alive.
- [x] `tests/shared/lane-checker.test.ts`'s E3/E4/E6 suite exercises the NARROWED predicate: at least one E6 case where the blank side sits on an endpoint in TWO lanes (a finding) and one where it sits on a unique endpoint (NOT a finding).
- [x] `loadSegmentFacts` gets a fixture where declared ≠ derived: an endpoint in two lanes of its task with one side DECLARED to the second lane, so a reader that fell back to the stored tag would place the edge differently from one that resolves it — and a case where the stored tag is stale/invalid and resolution says so.

- [x] **A third one, found at ticket 04's integration:** `createUnifiedNoteSettlementDispatch` persists the job's claim scope (`persistNoteSettlementClaimScope`, `note-settlement-dispatch.ts` ~978) and dropping that call keeps the whole suite green; the sibling shape's call (~526) is pinned. Give the unified shape a test that reads `note_settlement_claim_scope` after dispatch and goes red when the call is removed.

## What to prove

- [x] **The revert probe, named per rewrite.** For each of the two readers, revert it to the pre-ticket-02 behaviour (F2: restore the blank-tag branch as the only path; F4: read `tailTag`/`headTag` verbatim), run the suite, and record in the report WHICH test went red. A disposition that cannot name that test has not been proven. This is the standing acceptance step for every remaining ticket in this batch; it is written here first because this batch already produced three tests that read as coverage but could not fail (F2, F4, and ticket 03's duplicate-key test).
- [x] The mutation must be verified applied (diff or exit code) before its test output is trusted; md5-restore afterwards.

## Constraints

- `~/.claude-mnemo/` is production data and STRICTLY READ-ONLY (`sqlite3 -readonly`).
- NEVER `git stash` / `checkout` / `checkout-index` / `restore` / `reset` / `clean` — the whole class. Restore from your own `cp` copies, md5-verified.
- Work in your worktree: `git merge --ff-only main` first (the worktree base is stale), `cp -Rc` the main tree's `node_modules` in, never stage `plugin/scripts/*.cjs`. Explicit pathspecs on every `git add`; stage nothing under `.scratch/` except this ticket.
- `npx tsc --noEmit` clean; `npm run typecheck:tests` adds no NEW errors in touched files (358 pre-existing on main); full `bun test` once with every delta accounted (baseline 4770/0/269 at main after ticket 04); `npm run build`; guards green; `git diff --check` clean. No version bump, no push. Results go in your FINAL REPORT; send nothing.

## Report (LANDED)

Worktree branch `worktree-agent-ac41a730f9b7803e9`, base `b8c5dbd8` (main, fast-forwarded before work). Baseline measured at that base: **4770 pass / 0 fail / 269 files**; `npm run typecheck:tests` 358 errors.

### Files

- `src/shared/lane-checker.ts` — F2. New `LaneCheckerEdgeInput` (extends `LaneEdgeInput`; `tailOutcome`/`headOutcome`/`storedTailTag`/`storedHeadTag` REQUIRED). `checkLanes`, `partitionEdgesByVocabulary`, `subsetObligations`, `computeSubsetInvariantErrors`, `computeDraftEdgeErrors` take it. The blank-tag fallback branch is DELETED from `computeDraftEdgeErrors` AND from `subsetObligations` (the same dead branch; E4's half of the same finding). E4's `tags` now names the STORED side tags (`storedEdgeTags`) — the resolved set is empty for exactly the side an `invalid` finding is about. Header and function docs rewritten; the E6 doc names the two mutations and which block each reds.
- `src/shared/lane-interpretation.ts` — doc only: the outcome fields stay optional on the BASE shape solely for the election feed (`getRelationEdgesAmongTurns` hands stored columns; the election reads neither side); no reader falls back any more.
- `src/db/lane-checker-load.ts` — `toEdgeInput` and `LaneCheckProjection.edges`/`outOfVocabularyEdges` typed `LaneCheckerEdgeInput` (no logic change; `loadSegmentFacts` untouched).
- `src/worker/console-reader.ts`, `src/worker/console-api.ts` — `ConsoleLaneCheckRun.edges` typed `LaneCheckerEdgeInput`; the console payload's `supplied ?? (tag === "" ? "none" : "declared")` fallback DELETED — `how` is the edge's outcome, full stop.
- `tests/support/lane-edge-fixtures.ts` — `resolveLaneEdges(turns, edges)`: resolves a pure fixture's STORED sides through the real `resolveEdgeSide` against the fixture turns' `laneTags`/`segment` (segment labels interned to numbers). Deliberately not a `laneEdge` parameter: a stateable outcome is coverage that cannot fail. `withEdgeClaimedLaneTags` now claims an edge tag onto a turn only if the turn's loaded raw `tags` carry it (membership = tags ∩ declared; a turn cannot be in a lane its column lacks) — this is what lets an E4 fixture resolve `invalid` instead of a projected `declared`.
- `tests/shared/lane-checker.test.ts` — the wrapper resolves every edge; E3/E4/E6 suite rewritten to the narrowed predicate (`twoLaned` helper; two NEW not-a-finding cases: unique endpoint → `derived`, lane-less endpoint → `none`, each with a per-side mirror); report-2/report-3/ticket-12/cluster fixtures whose "unsettled" edges now DERIVE a lane under D2 restated as derived-vs-ambiguous pairs; golden re-measured (below).
- `tests/worker/console-api.test.ts` — the fake reader resolves fixture edges against the fake run's OWN `result.lanes` membership; the `none`-expecting test restated (undeclared edge between two one-lane members is `derived`, a lane-less third turn's side is `none`); `FakeLaneCheckRun`/`FakeReaderOverrides` types so fixtures type against what they write (removes 14 pre-existing typecheck errors in that file).
- `tests/db/lane-checker-load.test.ts` — F4: two fixtures + `halfDeclaredEdge` helper (below).
- `tests/worker/note-settlement-call.test.ts` — the unified dispatch's claim-scope test (below).

### Per-item disposition

- **F2 — DONE, by deletion.** Both fallback branches gone; the checker's input type makes an outcome-less edge a type error at every `src/` call site (`tsc` clean) and the only test callers that build edges by hand (`lane-checker.test.ts`, `console-api.test.ts`) resolve them through the real resolver. One remaining hand-built caller, `tests/shared/relation-class.test.ts:327` (`checkLanes(turns as never, edges as never)`), asserts only the out-of-vocabulary count and never reaches E4/E6 — left as is.
- **E6 suite exercises the narrowed predicate — DONE.** Finding cases sit on `twoLaned` endpoints; the not-a-finding cases are the ones the widening mutation reds (probe table).
- **F4 — DONE.** (1) `alpha`/`beta`/`gamma` declared; X in {alpha, beta}, Y in {beta}; Y→X with tail blank (derives beta) and head declared alpha → `emptyLaneTags: ["gamma"]`; a stored-tag reader reports beta empty too. (2) X, Y in {alpha}; Y→X head declared `beta` (X does not carry it) → `invalid`, `emptyLaneTags: ["beta"]`, and the checker names it E4 with `tags: ["alpha","beta"]`; a stored-tag reader would count the stale word as beta's edge.
- **Unified dispatch claim scope — DONE.** Reads `note_settlement_claim_scope` INSIDE `runQuery` and asserts it equals both the fixture window and the request's own `writableTurnIds`.

### Revert-probe table (every mutation shown as a `diff` hunk before the run; every file md5-restored from my own `cp` copy)

| # | file | mutation (pre-ticket-02 / pre-04 behaviour) | RED |
|---|------|-----------|-----|
| 1 | `src/shared/lane-checker.ts` | E6 back to "any blank side" (`edge.tailTag === ''`) — the blank-tag branch as the only path | 19 across 4 files: **"E6 — a blank side on a UNIQUE endpoint is NOT a finding"**, **"E6 — a blank side on a LANE-LESS endpoint is NOT a finding"**, the golden error test + errors-render golden, the E4 block (7 — extra E6 rows beside E4), "an untagged extends/narrows…", "errors sort…" in `lane-checker.test.ts`; 4 in `lane-checker-load.test.ts` (incl. the new F4 stale-declaration test); 3 in `note-settlement-sdk-query.test.ts` |
| 2 | `src/shared/lane-checker.ts` | E4 back to the tag comparison (obligation from the resolved `tailTag`/`headTag`, not `invalid`) | 10: every E4 test in `lane-checker.test.ts` (7), "errors sort…", the tag-mandate E4 orphan test in `lane-checker-load.test.ts`, and the new F4 stale-declaration test |
| 3 | `src/db/lane-checker-load.ts` | `loadSegmentFacts` reads the stored side tag verbatim (the peer's patch) | 3: **both new F4 tests**, plus the pre-existing per-side cross-segment empty-lane test (the "1 of 65" the peer saw) |
| 4 | `src/worker/note-settlement-dispatch.ts` | delete `persistNoteSettlementClaimScope` in `createUnifiedNoteSettlementDispatch` (~975) | 1: **"the writable set is persisted as this job's claim scope before the unified query runs"** — and nothing else, which is the finding |

### The golden fixture, re-measured

With membership projected from each turn's own edges (the existing convention), resolution turns 76 of the corpus's 77 blank-sided edges into `derived`/`none` sides (side outcomes over 125 edges: declared 96, derived 31, none 122, ambiguous 1). ONE finding survives: T902 `consume` T900, head side, T900 being the corpus's only multi-lane endpoint. The test now computes the expected list from the endpoint facts independently of the checker. Consequences recorded in the byte-stable baseline: the 54-turn unattributed cluster becomes 36 turns (edges that derive a lane on either side leave the debt graph), the 5-turn cluster loses T990, and six lanes gain a `use` crossing (undeclared rows between two one-lane memberships, now the cross-lane edges they always were). I also measured the alternative membership (`tags ∩ the 12 lanes`): it severs 7 of 12 hand-judged lanes (the raw tags name lanes the hand judgment did not seat those turns in), so it is NOT the golden's membership and was not adopted.

### Verification

`npx tsc --noEmit` clean. `npm run typecheck:tests`: **344** (baseline 358; touched files: `lane-checker.test.ts` 1→1, `lane-edge-fixtures.ts` 0→0, `lane-checker-load.test.ts` 1→1, `note-settlement-call.test.ts` 6→6, `console-api.test.ts` 24→10 with no error message absent from the baseline). `npm run build` clean; `bun test` **4775 pass / 0 fail / 269 files** — delta +5 accounted: +2 `lane-checker.test.ts` (the two not-a-finding E6 cases), +2 `lane-checker-load.test.ts` (F4), +1 `note-settlement-call.test.ts` (claim scope). `bun test tests/shared/release-artifacts.test.ts` 11/0; `grep -c anthropic-ai plugin/scripts/worker.cjs` = 0; `git diff --check` clean; no control bytes in any touched file. No version bump, no push. `~/.claude-mnemo/` untouched.

### Found at HEAD

- Production `E4.tags` printed the RESOLVED set, i.e. `{}` for an edge whose only tagged side was `invalid` — the finding's own subject vanished from the `{...}` in the render. Fixed here (`storedEdgeTags`); no test had pinned the old string because the fixture path never reached it.
- `subsetObligations` carried the SAME dead fallback the ticket named for `computeDraftEdgeErrors`; deleted with it (same ruling, same finding).
- Nothing else found FALSE. **UNVERIFIED:** none — every claim above is a probe or a count in this report.

### Shared-file hunks for the integrator

- `src/shared/lane-checker.ts`: header comment (the `laneEdgeTags` paragraph), new exported `LaneCheckerEdgeInput` after `LaneCheckerTurnInput`, `checkLanes` signature, `partitionEdgesByVocabulary`, `subsetObligations` + new `storedEdgeTags`, `computeSubsetInvariantErrors` (`tags:`), `computeDraftEdgeErrors` (body + doc). Anyone adding a `checkLanes` caller must pass resolved edges.
- `tests/support/lane-edge-fixtures.ts`: `withEdgeClaimedLaneTags` generic widened to `LaneTurnInput & { tags?: … }`; new export `resolveLaneEdges`.
- `tests/worker/console-api.test.ts`: imports (`DEFAULT_SEGMENT`, `resolveLaneEdges`), two new types above `makeFakeReader`, the `runLaneCheck` seam, three fixture builders retyped, one test rewritten.
- `tests/worker/note-settlement-call.test.ts`: one describe appended at the end. `tests/db/lane-checker-load.test.ts`: helper + two tests appended inside the "D9 segment facts" describe.
