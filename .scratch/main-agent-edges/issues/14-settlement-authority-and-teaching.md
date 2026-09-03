# 14 — Authority that reaches the gate, invalidation that keeps repair possible, and teaching that matches the code

**What to build:** repairs from the whole-batch peer review (S15069/T2461, P1-4, P1-5, P1-8, P1-10, P2-C, P2-D, P2-F). After it, a `derived-side-citer` grant is admitted by `lane_check` and `commit`; an invalidated job can still repair the edge that invalidated it; a job at its attempt cap is not wedged forever by a structural reset; the tool descriptions describe what the code does; finalize output is bounded; the unreachable `removed-side-citer` is deleted.

**Blocked by:** None (ticket 13's seam change is independent; merge main before starting if it lands first).

**Status:** ready-for-agent

## Findings, verified at 36af9878

- **P1-4 — derived authority enters the snapshot and leaves at the gate.** `note-settlement-snapshots.ts` ~488–518 adds `derived-side-citer` to the writable set, but `note-settlement-sdk-query.ts` ~1074–1083 defines `judged` as "anchors in judgment OR authored", so the remote E6/E4 findings on that citer are filtered out of `lane_check` and `commit`. The grant is delivered and unusable.
- **P1-5 — invalidation keeps the bad edge and deletes what the re-run needs to earn authority over it.** The default `onAmbiguous` (normalize-incident-attribution.ts ~245–253) keeps the edge when a job was invalidated; the invalidation (settlement-job-invalidation.ts ~330–349) clears PRE + writable snapshots. The re-run records PRE-bad, the closure skips it, and the remote citer is never writable. Existing tests stop at "edge kept / job pending".
- **P1-8 — a capped job is wedged by a structural reset.** Reset (~289–311) keeps `attempts`; claim requires `attempts < max` (note-settlement.ts ~1851–1861); the cursor treats capped failed/abandoned as terminal (~2200–2214) — a pending-at-cap job has no due, cursor 0. (Ticket 04 stated "no refund" as a ruling; the peer showed the consequence.)
- **P1-10 — the retraction contract describes the old behaviour.** `definitions.ts` ~530–565 says a two-sided entry retracts "only that lane placement"; `citations.ts` ~1014–1102 correctly deletes the pair's ONE edge and ignores sides. A model trying to clear stale attribution deletes a valid node fact.
- **P2-C — E4/E6 repair teaching is the stored-side model** (`note-settlement-sdk-query.ts` ~494–518, ~644–663, ~1372–1394: "add the tag", "place both sides", "either empty"); stage 2 cannot write tags and a derived side refuses `declare`.
- **P2-D — unified finalize output is unbounded** (~3667–3712): full writable set, deltas, lane members, homeless list, repeated; a large lane can evict the worklist before the first read.
- **P2-F — `removed-side-citer` is unreachable** (stage-1 post-normalisation clears the declaration in the same transaction; `tests/db/settlement-read-deltas.test.ts` ~332–344 proves debts=[]); `note-settlement-snapshots.ts` ~483–486, ~617–683 keeps a second debt/provenance/teaching set for it.

## What to change

- [ ] `judged` admits every turn in the job's FINAL writable set (including `derived-side-citer`), for `lane_check`, preview and `commit` alike — one predicate. Test: a remote citer granted by the closure sees its E6 in `lane_check` and can commit its repair; revert probe names the red test.
- [ ] Invalidation and ambiguity, one consistent rule (user rulings T2419/T2421 — subtract, delete unattributable): **when a structural change makes an incident side ambiguous, the edge is DELETED with a receipt, live job or not; the job is still invalidated (its worklist changed).** No kept-bad-edge, so no repair authority is needed and PRE/writable can be cleared safely. If you find a reason the delete is wrong for a live job, STOP and report it rather than building a keep+repair channel.
- [ ] A structural invalidation refunds `attempts` (reset to 0) and clears `retry_at_epoch` — an invalidation is not an attempt. Test: a job at cap, invalidated, is claimable.
- [ ] `definitions.ts` retraction text states the pair rule (sides ignored, one edge per pair); E4/E6 teaching states the resolved-side model (E6 → `declare` the side on a multi-lane endpoint; E4 → `declare` a valid lane or retract; never "add the tag"); pinned by tests a mutation drives red; the retired sentences absent from rendered text.
- [ ] Finalize output bounded: the three set lines and the lane roster obey a budget (reuse the worklist rendering's existing budget/pager; no new mechanism), overflow named with a count, never silently cut.
- [ ] Delete `removed-side-citer`: provenance value, debt table/rows, snapshot code, teaching, tests — with a one-line reason each in the report. If any CHECK constraint names the value, migrate it the way ticket 04 migrated its own.

## What to prove

- [ ] Revert probe per predicate, red test named; ≥5, verified applied, md5-restored.

## Constraints

- `~/.claude-mnemo/` STRICTLY READ-ONLY. NEVER `git stash`/`checkout`/`checkout-index`/`restore`/`reset`/`clean`; restore from your own `cp` copies, md5-verified.
- Explicit pathspecs; never stage `plugin/scripts/*.cjs`; nothing under `.scratch/` but this ticket. No control bytes; `anthropic-ai` in worker.cjs = 0. No subagents. No version bump, no push.
- `npx tsc --noEmit` clean; `npm run typecheck:tests` no new errors in touched files; full `bun test` once with every delta accounted (baseline 4785/0/274 at 36af9878); `npm run build`; guards green; `git diff --check` clean.
