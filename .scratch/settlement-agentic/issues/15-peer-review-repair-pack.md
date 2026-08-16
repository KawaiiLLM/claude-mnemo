# 15 — The final review pass, repaired

**What to build:** Nine findings from the peer review of `e588b7f^..HEAD`, four of them confirmed defects, and the one design hole they share.

**Blocked by:** 11 (all thirteen tickets are landed; this is the repair round on top of them)

**Status:** ready-for-agent

The review was static — no commands run, no tests executed. Findings 1-5 were then independently verified here and hold. Findings 6-9 are the reviewer's own "plausible, unverified"; verify each before changing anything, and if one turns out not to be real, say so in this file instead of writing code for it.

## The hole findings 1-3 share

A segment's `type` and `tags` are derived (spec K5a), and ticket 14 placed the recomputation at exactly one point: `addSegmentMembers`. That claim was stated as "one invariant point, so no writer can land members and leave the FTS facet describing a membership that no longer exists" — which is **true and incomplete**. Facets derive from the members' *content*, not only from *membership*, and `recomputeSegmentFacets` has exactly one production caller: nothing on the turn-write path touches it.

So the invariant to restore is: **a segment's facets follow its members' current type and tags, not the values they happened to hold when membership was recorded.**

- [ ] **1 (HIGH).** A member turn's `type`/`tags` changing after membership leaves the segment's stored facets and FTS row stale. Two reachable routes: staging order (`segment(create, members=[T1])` replayed before `note(T1, type=…)`, which the prompt's duty order discourages but nothing enforces), and a later window revising an earlier turn's type — which duty 1 explicitly invites. Completion still passes, so nothing surfaces it
- [ ] **2 (MED-HIGH).** Deleting a member turn or session cascades `segment_members` but never recomputes the surviving segment, which keeps facets only the deleted turn contributed and stays searchable by them. **The existing test asserts the stale state and then calls `recomputeSegmentFacets` by hand**, so a missing production repair passes it — fix the test as well as the code
- [ ] **3 (MEDIUM).** The K5a migration adds `segments.insight` but never rederives `type`/`tags` for segments that already exist, and `rebuildSearchIndex` reads the stored fields. The 42 existing segments keep model-stated facets that may contradict every member — the exact A6 violation K5a exists to end — indefinitely. A one-time backfill belongs in the same migration

## The rest, each on its own

- [ ] **4 (MED-HIGH, confirmed).** Both `turns` table rebuilds run `PRAGMA foreign_key_check` **after** their transaction has closed. SQLite's 12-step procedure runs it at step 10 and commits at step 11; the code comment claims conformance to that procedure while inverting those two steps. A violation therefore throws over an already-durable swap, and the next reload's migration predicate reads false and skips, so there is no repair path. Move the check inside the transaction
- [x] **5 (MEDIUM, confirmed premise).** `previewCommit` runs through the ordinary `runWriteTransaction`, not `runHookWriteTransaction`, which exists for exactly this case and carries a time budget. Under a writer lock a Stop callback can wait out the busy timeout across retries and then propagate `SQLITE_BUSY` instead of returning a bounded hook decision. `blocksIssued` increments only after preview returns, so the cap does not leak — that part is fine

  Fixed (`src/worker/note-settlement-staging.ts`): `previewCommit`'s replay now runs through `runHookWriteTransaction` with this connection's own `busy_timeout` turned down for the one attempt (`runPreviewTransaction`) — otherwise a single blocked `BEGIN IMMEDIATE` can silently eat the whole hook budget on the production connection (measured: ~5.3s on one attempt at the 5s default vs. ~2.5s honoring the budget once busy_timeout is lowered) before the budget's own clock gets a turn. If the budget still runs out, `attemptCommit` catches `SQLITE_BUSY` and returns `{ kind: "indeterminate" }` instead of letting it escape. Deliberate choice among the three options: the Stop hook (`src/worker/note-settlement-stop-hook.ts`) BLOCKS with an honest "the check could not run" message (`renderCheckFailedStopReason`) rather than letting the stop through (would hide the exact staged-work loss this hook exists to catch) or retrying in-hook (would just repeat the wait already paid). Counts toward the existing `blocksIssued` cap unchanged. A real (non-preview) `commit` is untouched — still `runWriteTransaction`, still propagates `SQLITE_BUSY` as a tool error, out of this finding's scope.
- [x] **6 (LOW-MED, unverified).** `segment` `exclude` validates address syntax and row existence but not membership of the current job window, so it can persist an exclusion for an unrelated real turn. Completion still checks the frozen window, so this cannot make a job complete falsely — confirm that before deciding how hard to fail

  Confirmed both halves. Read `db/note-settlement-completion.ts`: `computeNoteSettlementSegmentationGaps` filters exclusions by `job_id AND turn_id IN (this job's window turn ids)`, so an exclusion recorded for a turn outside this job's own window is never read back by this job's own gate — completion cannot be falsely satisfied. The gap is real: `exclude` had no `context.reviewableTurnIds` check, so it could record a job-scoped "reviewed, belongs to no segment" verdict for a turn this dispatch never showed the model — a false provenance claim. Fixed (`src/worker/note-settlement-segment-facade.ts`): `exclude` now refuses a turn outside `context.reviewableTurnIds`, mirroring the same scope `evaluateSettlementTurnWrite` already enforces for a review verdict.
- [ ] **7 (LOW, unverified).** `assertNoUnexpectedTurnsColumns` reads `PRAGMA table_info`, which omits generated and hidden columns that `table_xinfo` reports. The current schema has none, so this is a guard against the guard's own blind spot
- [ ] **8 (LOW-MED, unverified).** Standalone `addSegmentMembers` can insert some memberships, fail a later FK, and throw before recomputing, with no local transaction. The settlement path wraps it in an outer transaction, so confirm whether any caller is actually exposed
- [x] **9 (LOW, unverified).** `renderBoundedSessionStateOutput` keeps the truncation pointer even when the budget is smaller than the pointer, so a tiny budget exceeds the caller's ceiling. No production caller passes one — decide whether to bound it or to document that the floor is the caller's job

  Confirmed the premise (an existing test already pinned it at `budget: 5`, unasserted) and confirmed no production caller passes a budget that small: both callers of `renderMainAgentSessionInjection` (`hooks/handlers/context.ts`, `worker/note-settlement-context.ts`) use the ~2,000-token default, dozens of tokens above the pointer. Decision: documented, not fixed — dropping the pointer to respect an absurdly small budget would silently cut the one line whose job is to not be silent, which is the exact defect ticket 04 requirement 6 exists to prevent; that tradeoff was already implicit in the code's own comment ("the pointer alone is still the right answer") but not stated as a budget-ceiling contract. Strengthened doc comments in `src/mcp/session-output.ts` (`renderBoundedSessionStateOutput`) and `src/hooks/session-injection.ts` (`tokenBudget` field + the `stateTokenBudget` computation) to state the floor explicitly as the caller's responsibility. Added an explicit assertion to the existing `tests/mcp/session-output.test.ts` extreme-budget test making the ceiling-exceeding fact checked, not just implied.
- [ ] Full suite green

## Follow-up this pack surfaced, recorded rather than silently fixed

**`runHookWriteTransaction`'s budget is decorative on any connection whose
`busy_timeout` exceeds it.** The helper checks its budget only AFTER
`txn.immediate()` throws, so at the worker connection's 5s default a single
blocked `BEGIN IMMEDIATE` burns ~5.3s inside SQLite before the JS clock gets a
turn. Finding 5 fixed this at the call site — `runPreviewTransaction` turns the
timeout down for one attempt and restores it in a `finally`, which is safe only
because every call in that region is synchronous, so nothing can interleave on
the single JS thread.

That leaves the helper's own contract misleading for the next caller: it is
named and documented as a bounded wait and is not one unless the caller happens
to have tuned the connection. Today's other hook callers use `hook-command.ts`'s
dedicated 800ms connection and are fine by accident of configuration, not by the
helper's guarantee. The fix belongs in the helper — clamping the connection's
`busy_timeout` to the budget for the duration is the same one-liner, applied
where the promise is made — but changing a shared concurrency primitive is not a
repair-pack decision. Recorded here for its own change.

## Confirmed clean by the same review, do not re-audit

Frozen/current relation intersection; `topic:` rejection at the settlement write boundary; keyed staging; the `global-view` field split and normal one-budget rendering; G9 histogram invisibility to the agent; legacy `insight` rendering.
