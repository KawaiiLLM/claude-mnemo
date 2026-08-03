Verdict: NOT SAFE TO COMMIT — safe to commit after the ruled day-frame change/fix first.

Review basis: uncommitted worktree against HEAD `cbc71dd8c2f5b8c12ef7c24c9d0ae8c11a7e18ca`; generated `plugin/scripts/*.cjs` and `.scratch/` docs were ignored as requested. Focused changed-file tests: 231 pass; matrix/context follow-up tests: 24 pass; typecheck: pass; `git diff --check`: pass.

## Standards

No documented coding-standard violation was found; `docs/agents/issue-tracker.md` only documents local Markdown issue conventions. One minor judgement call is duplicated long-session fixture setup between `tests/hooks/context-milestones.test.ts:95-128` and `tests/hooks/milestone-injection.test.ts:48-81`; it can drift, but it is not a production defect.

## Spec — findings ranked

### BLOCKER — required day-frame degradation is absent, so the 2,500-token contract still fails

Rev 4 §D explicitly requires consecutive dates with zero retained units to collapse to one combined hint (`.scratch/arc-spine-redesign/spec.md:103`); ticket 04 also requires a bounded 2,500-token injection (`.scratch/arc-spine-redesign/issues/04-injection-swap.md:3,9-13`). The current body model prices frames (`src/mcp/timeline.ts:2462-2474,2671-2677`) but cannot degrade them: `sectionFrameLines` always emits one header and one hint per state (`src/mcp/timeline.ts:2634-2668`), while the fitter only disables descriptions and removes units (`src/mcp/timeline.ts:2819-2852`).

The exact 31-day fixture in `tests/hooks/context-milestones.test.ts:94-161` currently renders 3,053 tokens, including 31 headers and 31 `+N` hints; a read-only reproduction measured 588 tokens only after those frame lines were filtered. The resulting `MILESTONE_OVER_BUDGET_NOTE` is therefore a false explanation of the overrun: the note is documented as the anchors-alone residue (`src/mcp/timeline.ts:2804-2808`), but the unremovable per-day frames are what consume the budget.

The follow-up needs a frame state/model, dynamic frame token accounting, and a collapse transition when a state loses its last row. The post-fix test must measure the full assembled injection (`estimateDiaryTokens(injected) <= 2_500`) without deleting headers/hints, assert one combined line for the zero-row run, and assert that the combined `+N` total conserves every hidden turn.

### MAJOR — the day inventory cannot yet conserve overflow-only days, and the synthetic-day branch is unsafe for them

`buildMilestoneDayGroups` constructs groups only from paged/all kept milestones (`src/mcp/timeline.ts:1898-1944`); `createMilestoneBodyModel` adds synthetic sections only for pulled antecedent dates (`src/mcp/timeline.ts:2546-2568`). Thus a calendar day with candidate turns in `overflowByDay` but no kept row has no section at all, so its `+N` count has nowhere to render. A read-only three-day probe with kept T1/T3 and low-grade T2 produced groups for only the first and third dates and no `+1 more` hint.

When the follow-up materializes such a day, the current `group === null` header path is also invalid for a base overflow with no `extraPrompts`: it computes `Math.min(...extraPrompts)` and `Math.max(...extraPrompts)` (`src/mcp/timeline.ts:2644-2648`) instead of using `OverflowHint.firstPrompt/lastPrompt`. Preserve and merge the base count, `droppedPrompts`, and `orphanPrompts`; do not double-count an orphaned antecedent. The existing synthetic/orphan repair path (`src/mcp/timeline.ts:2697-2705`, covered by `tests/mcp/timeline.test.ts:4358-4391`) must remain in the same collapse/conservation ledger.

### MAJOR — the rewritten injection test masks the known violation

`tests/hooks/context-milestones.test.ts:137-148` deliberately removes every day header and `+N` hint before checking the budget, then requires the over-budget note at `:149`. That makes the test pass while the actual hook output is over 2,500; after frame collapse, the expected note may disappear because the anchors can fit. The test should instead pin full-output budget, one collapsed frame line, collapsed-day coverage, and the summed `+N` conservation. The new injection pin at `tests/hooks/milestone-injection.test.ts:253-271` is a useful byte-identity check, but its four-row fixture is not budget-pressured; the real long fixture is the one currently hiding the defect.

The 900-row performance test is otherwise valid for the unit-budget path: `tests/hooks/milestone-injection.test.ts:378-403` creates more than 140 always-keep anchors and expects the default 2,500 run to traverse the removal ladder. Its 300-second row spacing (`:208-243`) spans only about 3–4 days, so it does not test the amended multi-day frame behavior.

### MINOR — literal legacy wording remains in test comments, though old behavior is gone

The old seam/helpers and pointer have zero code hits in `src/`, tests, and the inspected bundles. The release-artifact guard checks the new fitter and the old symbol’s absence (`tests/shared/release-artifacts.test.ts:129-136`), and the injection test negatively asserts the old pointer (`tests/hooks/milestone-injection.test.ts:285-289`). A raw `REDUCED` search still finds explanatory comments at `tests/hooks/context-milestones.test.ts:156-157` and `tests/hooks/milestone-injection.test.ts:188,309-310`, plus the intentional negative-sentinel string at `tests/shared/release-artifacts.test.ts:136`; remove or explicitly exempt that wording only if the acceptance check means zero textual hits rather than zero old implementation residue.

## Confirmed clean

- Injection wrapper is the prescribed direct call: `DEFAULT_TITLE_CAP`, 2,500, and `showEarlierHint: false` are passed at `src/hooks/milestone-injection.ts:31-41`; there is no second budget check.
- Empty/missing-session and source guards remain in the untouched handler seam at `src/hooks/handlers/context-milestones.ts:26-47`; the other four sections and source matrix are unchanged and covered by `tests/hooks/injection-matrix.test.ts:16-160`.
- The shared per-unit ladder is ordered desc → pulled fold → files tail → pulled-title truncation → spine-title truncation → prompt-prefix truncation, with head clamp backstop (`src/mcp/timeline.ts:2310-2389`). The pathological files-tail case is directly pinned at `tests/mcp/timeline.test.ts:3931-3968`; the changed frozen row is the expected sole shape change.
- Anchor-note behavior is covered from the injection side at `tests/hooks/milestone-injection.test.ts:352-374` and on the default 900-row path at `:378-403`.

## Summary

- Required day-frame collapse is missing; current SessionStart output can exceed 2,500 on the stated 31-day fixture.
- Frame accounting and overflow-only/synthetic-day conservation are the main follow-up hazards.
- The current context test hides the violation by removing frame lines before measuring.
- Injection identity, guards/matrix, 2500/title-cap semantics, ladder reorder, deletion, and anchor path otherwise pass review.
- Commit only after the frame implementation and full-output conservation assertions are fixed.
