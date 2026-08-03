Verdict: NOT SAFE TO COMMIT — lease reclaim is not ownership-fenced, so an expired worker can overwrite a newer claim and publish an incorrect settlement.

## Review basis

Reviewed the uncommitted source/test diff against `641863fe40bdf74c54041bff8d623083a40b6f48` (also the current `HEAD`). Generated `plugin/scripts/*.cjs` files were excluded from scope; `.scratch` was read only as contract context.

## Findings

### BLOCKER

#### 1. A stale lease owner can commit after the row has been reclaimed

`src/db/settlement.ts:365-428` reclaims an expired `claimed` row and lets another worker claim the same row, but the row has no claim token/generation. `failSettlementJob` and `markSettlementJobDone` update only `WHERE id = ?` (`src/db/settlement.ts:439-452`, `src/db/settlement.ts:504-514`). The success path then performs grades, supersession tagging, status, cursor, and summary writes using that un-fenced job (`src/worker/settlement.ts:430-494`).

If worker A runs past ten minutes, worker B reclaims and claims attempt 2, and A returns, A can apply its stale model result and mark B's claim done (or fail it). B can subsequently do the same. The claim CAS prevents two live claims only until lease expiry; completion/failure is not CAS-safe. This violates the single-claimed-worker and atomic-success invariants and can produce last-writer-wins grades/cursor state.

### MAJOR

#### 2. A crash on attempt 3 is reclaimed as attempt 4

The lease-recovery update has no `attempts < maxAttempts` predicate (`src/db/settlement.ts:367-372`), and the pending candidate query also has no attempt cap (`src/db/settlement.ts:397-400`). Thus a claimed row at `attempts = 3` is reset to pending when its lease expires and then claimed with `attempts = 4`, despite `SETTLEMENT_MAX_ATTEMPTS = 3` and the documented terminal rule (`src/db/settlement.ts:40-41`). A direct in-memory state-machine probe reproduced `attempts: 4`.

#### 3. An exhausted failed gap is bypassed on the next pass

The current pass correctly stops after a failed job (`src/worker/server.ts:2234-2241`), but a later pass asks for any `pending` job and skips `failed` rows, including terminal `attempts = 3` rows (`src/db/settlement.ts:374-400`). That lets boundary 100 settle after boundary 50 is terminally failed, even though `advanceSettlementCursor` remains stopped at the gap (`src/db/settlement.ts:470-497`). A direct probe with boundary 50 failed three times returned boundary 100 from the next claim. This is exactly the half-provisional arc the per-session stop is meant to prevent.

#### 4. SessionEnd freezes the tail before orphan turns become terminal

The handler enqueues the tail job at `src/hooks/handlers/session-end.ts:192-213`, then converts fenced orphan turns to `skipped` at `src/hooks/handlers/session-end.ts:215-226`. Both the terminal count and frozen cohort are computed before that conversion (`src/db/settlement.ts:115-153`, `src/db/settlement.ts:316-330`).

For example, with 37 extracted turns plus one active orphan, the tail job freezes only 37; the later orphan skip makes the count 38 but no new event crosses or enqueues boundary 38. With 49 extracted turns plus one orphan, the helper can enqueue boundary 49 and still omit the orphan. The pre-repair activity snapshot itself is correct; the ordering means the actual SessionEnd terminal population is not what the tail gate settles. The added handler tests seed only already-extracted rows (`tests/hooks/session-end.test.ts:452-545`) and do not exercise this case.

#### 5. The finish timeout is not a hard tail budget and changes the lease-reclaim outcome

`drainSessionCompletely` now includes settlement (`src/worker/server.ts:3009-3015`). On timeout, `finishSession` suspends/closes the query but then unconditionally awaits the original drain (`src/worker/server.ts:3040-3069`). A settlement `sendPrompt` that does not settle after close can therefore keep SessionEnd waiting beyond `sessionEndTailTimeoutMs` (or indefinitely for a non-cooperating injected/runtime session). There is no settlement-specific cancellation boundary.

When the push does reject during shutdown, `runSettlementJobLocked` catches it and explicitly marks the job `failed` (`src/worker/server.ts:2127-2143`), rather than leaving the claimed row for ten-minute lease reclaim as required by the contract. No test exercises finish timeout with an in-flight settlement request.

#### 6. The citation snapshot is read more than once per settlement session

`computeSettlementSignals` reads `getSessionEffectiveCitations` at `src/worker/settlement.ts:101-105`, while the arc rendering path calls `buildTimelineView` at `src/worker/settlement.ts:186-195`; even with preloaded cohort turns, `buildTimelineView` unconditionally reads the session citation map again (`src/mcp/timeline.ts:1766-1775`). Each boundary therefore rereads the full session, and the mechanical signals and arc can come from different citation snapshots if a citation write races between those reads. The settlement comment claims one read for the session (`src/worker/settlement.ts:88-90`), but the worker does not reuse that map for the arc view.

### MINOR

#### 7. Mechanical signal labels leave the DB-id/prompt-number distinction ambiguous

The roster explicitly distinguishes `turnId=<DB id>` from `P<prompt number>` (`src/worker/settlement.ts:203-219`), and the parser/write path correctly uses DB ids (`src/worker/settlement.ts:362-387`, `src/worker/settlement.ts:433-446`). However, `renderMechanicalSignals` formats every signal as bare `T<n>` (`src/worker/settlement.ts:165-166`, `src/worker/settlement.ts:229-244`), while arc rows use prompt numbers (`src/mcp/timeline.ts:3156-3159`). A model can therefore copy a signal's `T<n>` as a prompt number rather than the required DB id; the roster reduces but does not eliminate that ambiguity. The prompt test uses fixture ids that track prompt numbers and would not expose it (`tests/worker/settlement.test.ts:444-550`).

#### 8. Rule exemption resolution does not enforce the required multi-evidence cardinality

`getRuleExemptTurnIds` selects any rule with a `proposed` or `evidence_added` event and adds every individually resolvable evidence ref (`src/db/rules.ts:201-227`). It does not require at least two distinct resolved refs. The normal `propose_rule` writer enforces that for initial proposals, but the resolver can over-exempt a malformed, legacy, or one-item `evidence_added` record. The judgment path correctly follows `source_event_id` (`src/db/rules.ts:230-239`) and dangling refs correctly resolve to nothing (`src/db/rules.ts:178-197`).

#### 9. The text parser accepts a response the output contract explicitly forbids

The parser correctly enforces exact two-key objects, frozen-window membership, uniqueness, integer grades 0–4, empty arrays, and partial coverage (`src/worker/settlement.ts:320-390`), and the write transaction is atomic (`src/worker/settlement.ts:423-496`). But `stripCodeFence` deliberately accepts Markdown-fenced JSON (`src/worker/settlement.ts:305-308`), while the settlement contract says “no code fence” (`src/worker/settlement.ts:285-296`); the test cements the permissive behavior (`tests/worker/settlement.test.ts:264-270`). This is a literal strict-protocol deviation, not a half-write issue.

#### 10. The critical failure-mode tests do not all exercise the real state machine

The cursor out-of-order test mutates statuses directly with SQL instead of completing jobs through claim, success transaction, and cursor update (`tests/worker/settlement.test.ts:230-245`). Lease coverage checks only the normal first-expiry reclaim (`tests/worker/settlement.test.ts:192-212`), and retry coverage checks explicit failures only (`tests/worker/settlement.test.ts:214-228`). There are no tests for stale-owner completion, a third-attempt crash, a terminal failed gap followed by a later claim, orphan-before-tail ordering, or finish-timeout settlement cancellation. These gaps are why the defects above remain invisible despite the green suite.

## Confirmed-clean

- Boundary enumeration is correct: terminal `extracted` and `skipped` rows are counted, the trailing cohort is frozen at enqueue, and a jump such as 49→151 creates 50/100/150 (`src/db/settlement.ts:115-153`, `src/db/settlement.ts:250-285`). Compact markers are inserted as `status='extracted'`, so they use the same K/H denominator and cohort path.

- The success transaction advances the cursor only after marking the current job done and `advanceSettlementCursor` stops at the first non-done row (`src/worker/settlement.ts:475-494`, `src/db/settlement.ts:470-497`). The cursor itself is monotonic and does not advance on enqueue or failure.

- Supersedes remains model-only for grade demotion. The success path writes only the derived `rolled-back` role tag, merges it through the existing deduplicating two-class tag path, preserves other tags, and skips a second tag write when already present (`src/worker/settlement.ts:455-472`, `src/db/turns.ts:337-338`). No mechanical grade demotion is applied.

- Batch validation and rollback behavior are sound for the required matrix: unknown/out-of-window, duplicate, malformed key sets, and invalid grades reject before writes; empty and partial batches are valid; a mid-write SQLite failure rolls back grades, tags, job status, summary, and cursor (`tests/worker/settlement.test.ts:253-290`, `tests/worker/settlement.test.ts:615-652`).

- Calibration reuses `summarizeGradeWindow`/`renderSignificanceCalibration`/`exceedsG3EvidenceGate`, counts every cohort row including skipped and ungraded, and disables percentages/gate below 30 (`src/worker/settlement.ts:147-153`, `src/worker/processors.ts:244-323`). The diary assertion is a real positive control: grade/tag settlement leaves `needs_regen=0`, while a narrative title change flips it to 1 (`tests/worker/settlement.test.ts:672-720`).

- The rule namespace is `S<session>/T<prompt>`, cross-session and dangling refs are ignored, and judgment evidence follows `source_event_id`; those parts match section B (`src/db/rules.ts:140-197`, `src/db/rules.ts:230-240`).

- `withEnvelopes: false` is limited to the settlement push (`src/worker/server.ts:2127-2130`); ordinary push call sites retain the default behavior, and pending reminder/subagent envelopes are not marked notified on the JSON-only exchange (`src/worker/server.ts:1201-1281`, `tests/worker/settlement.test.ts:896-924`).

- The global allowlist change does not currently add a settlement-only tool: section A explicitly gives the extraction agent `timeline` and `recall`, and `timeline` is read-only. The derailment check now recognizes the same three tools passed to the SDK (`src/mcp/definitions.ts:95-102`, `src/worker/query-session.ts:346-365`, `src/worker/server.ts:1400-1412`).

- Settlement renders a preloaded frozen cohort with `showEarlierHint: false`; the production path is bounded by the H=100 cohort and page size rather than querying an unbounded session timeline (`src/worker/settlement.ts:178-219`, `src/mcp/timeline.ts:1716-1744`). SessionEnd only enqueues; it does not inline settlement. The activity snapshot is taken before repair as required (`src/hooks/handlers/session-end.ts:96-111`).

- The schema change adds only `settlement_jobs` and `settlement_cursors`; no `turns` or `sessions` columns were added, so there is no new RETURNING/SELECT parity surface in `src/db/turns.ts` or `src/db/sessions.ts` (`src/db/schema.ts:93-126`). Release-artifact sentinels for the worker settlement mechanisms are present in `tests/shared/release-artifacts.test.ts:149-160`.

## Verification

- `npm run typecheck` — pass.
- Targeted suite (`tests/worker/settlement.test.ts`, `tests/hooks/session-end.test.ts`, `tests/worker/query-session.test.ts`) — 71 passed, 0 failed, 364 assertions.
- Full `bun test` — 1402 passed, 0 failed, 5161 assertions across 103 files.
- `git diff --check` for the scoped tracked diff and no-index whitespace checks for the three new files — clean.
- Build/rebuild was not run because it writes the generated bundles explicitly excluded by the review scope and would violate the one-file/no-git-write constraint.

## Summary

The happy-path settlement implementation is substantial and the required parser, calibration, diary, boundary, tag, envelope, and cursor behaviors are mostly covered. The lease state machine is not safe to commit: stale workers are not fenced, attempt exhaustion can be exceeded, and an exhausted failed gap can be bypassed. SessionEnd can freeze a tail before orphan finalization, and timeout/citation-snapshot handling violate the stated lifecycle contracts. Fix the BLOCKER and MAJOR findings before commit.
