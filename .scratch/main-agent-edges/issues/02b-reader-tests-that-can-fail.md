# 02b — Two rewritten readers get a test that goes red when they are reverted

**What to build:** the two ticket-02 rewrites the peer's implementation review (S15069/T2442, findings F2 and F4) showed to be indistinguishable from what they replaced each gain a test that a revert to the pre-ticket-02 behaviour drives RED; the dead legacy branch that made one of them indistinguishable is DELETED, not covered.

**Blocked by:** None — 02 and 04 have both landed on main.

**Status:** ready-for-agent

## The two findings, verified at `4c4f4c81`

- **F2 — a dead fallback branch hides the narrowed E6 predicate from its own unit suite.** `computeDraftEdgeErrors` in `src/shared/lane-checker.ts` gates the narrowed predicate on `edge.tailOutcome !== undefined || edge.headOutcome !== undefined` and otherwise runs the pre-ticket-02 blank-tag logic. The shared fixture builder (`tests/support/lane-edge-fixtures.ts`) carries no outcome fields and `tests/shared/lane-checker.test.ts` mentions `tailOutcome` zero times, so that file's whole E3/E4/E6 suite exercises the OLD predicate and stays green if the narrowing breaks. Real coverage exists only through the loader tests.
- **F4 — `loadSegmentFacts` / `emptyLaneTags` in `src/db/lane-checker-load.ts` resolves attribution instead of reading the declaration index, but every fixture in the ticket-14 block declares a tag that is also the endpoint's ONLY lane, so `declared` and `derived` are byte-identical.** The peer patched the function back to reading `tailTag`/`headTag` verbatim and 64 of 65 tests stayed green.

## What to change

- [ ] **Delete the fallback branch in `computeDraftEdgeErrors`** (user ruling S15069/T2419: subtract, do not accommodate). The checker's edge input carries resolved outcomes, full stop; every caller that reaches it without outcomes is fixed at the caller or in the fixture builder, whichever is the real source. Do not add outcome fields to fixtures as a way of keeping the branch alive.
- [ ] `tests/shared/lane-checker.test.ts`'s E3/E4/E6 suite exercises the NARROWED predicate: at least one E6 case where the blank side sits on an endpoint in TWO lanes (a finding) and one where it sits on a unique endpoint (NOT a finding).
- [ ] `loadSegmentFacts` gets a fixture where declared ≠ derived: an endpoint in two lanes of its task with one side DECLARED to the second lane, so a reader that fell back to the stored tag would place the edge differently from one that resolves it — and a case where the stored tag is stale/invalid and resolution says so.

- [ ] **A third one, found at ticket 04's integration:** `createUnifiedNoteSettlementDispatch` persists the job's claim scope (`persistNoteSettlementClaimScope`, `note-settlement-dispatch.ts` ~978) and dropping that call keeps the whole suite green; the sibling shape's call (~526) is pinned. Give the unified shape a test that reads `note_settlement_claim_scope` after dispatch and goes red when the call is removed.

## What to prove

- [ ] **The revert probe, named per rewrite.** For each of the two readers, revert it to the pre-ticket-02 behaviour (F2: restore the blank-tag branch as the only path; F4: read `tailTag`/`headTag` verbatim), run the suite, and record in the report WHICH test went red. A disposition that cannot name that test has not been proven. This is the standing acceptance step for every remaining ticket in this batch; it is written here first because this batch already produced three tests that read as coverage but could not fail (F2, F4, and ticket 03's duplicate-key test).
- [ ] The mutation must be verified applied (diff or exit code) before its test output is trusted; md5-restore afterwards.

## Constraints

- `~/.claude-mnemo/` is production data and STRICTLY READ-ONLY (`sqlite3 -readonly`).
- NEVER `git stash` / `checkout` / `checkout-index` / `restore` / `reset` / `clean` — the whole class. Restore from your own `cp` copies, md5-verified.
- Work in your worktree: `git merge --ff-only main` first (the worktree base is stale), `cp -Rc` the main tree's `node_modules` in, never stage `plugin/scripts/*.cjs`. Explicit pathspecs on every `git add`; stage nothing under `.scratch/` except this ticket.
- `npx tsc --noEmit` clean; `npm run typecheck:tests` adds no NEW errors in touched files (358 pre-existing on main); full `bun test` once with every delta accounted (baseline 4770/0/269 at main after ticket 04); `npm run build`; guards green; `git diff --check` clean. No version bump, no push. Results go in your FINAL REPORT; send nothing.
