Verdict: fix first — not safe to commit; both Rev 4 rulings are still violated, with additional downstream and conservation defects.

## Blocker

1. **Unit hard cap is still 100, not the amended 150.** Rev 4 requires 150 tokens in `.scratch/arc-spine-redesign/spec.md:103`, but `MILESTONE_UNIT_TOKEN_CAP` remains 100 at `src/mcp/timeline.ts:117-122`, and the fitter/backstop consume that value at `src/mcp/timeline.ts:2360-2367`. The blast radius is the cap plus trim outcomes, comments/sentinels, and frozen expectations: `tests/mcp/timeline.test.ts:3749-3760` and `:3793-3843` still describe/assert 100, while the four-Han test derives its expectation from the wrong constant and therefore cannot catch this defect; the frozen body-shape fixture at `tests/mcp/timeline.test.ts:4264-4287` filters out desc/trim lines. Rebaseline the 150-token behavior, including the four-Han case and units with two pulled rows.

2. **Slash-command prompts still collapse to `⟨notify⟩`.** Rev 4 says to extract the command name at `.scratch/arc-spine-redesign/spec.md:102`. `isKnownSystemInjectedContent` classifies `<command-name>` as injected at `src/shared/transcript-parser.ts:147-155`, and `milestonePromptPrefix` returns the notification marker before calling `cleanPromptForLabel` at `src/mcp/timeline.ts:2136-2144`; the command-name extractor that turns the same envelope into `/review-pr` is at `src/mcp/timeline.ts:555-562`. A read-only probe renders `<command-name>/review-pr</command-name>...` as `⟨notify⟩`. The added test covers only task notifications (`tests/mcp/timeline.test.ts:3599-3627`), so the required exception is unguarded.

## Major

1. **SessionStart milestone injection changes before ticket 04.** The unchanged hook's default renderer is the new `renderTimeline` at `src/hooks/milestone-injection.ts:28-30`, and it calls it with the old options at `src/hooks/milestone-injection.ts:149-153`. The new renderer now emits unified spine rows/desc/files through `src/mcp/timeline.ts:2208-2221` and dispatches them from `src/mcp/timeline.ts:2920-2931`; a live read-only probe showed grades, prompt prefixes, desc lines, and file tails in the default injection. The old HEAD path was title-only milestone rows (`HEAD:src/mcp/timeline.ts:2062-2089`). Existing hook tests inject fake renderers (`tests/hooks/milestone-injection.test.ts:49-111`) and do not protect the default old-style output, so they pass while the downstream contract is already changed.

2. **`+N more` conservation loses orphaned antecedents on days with no rendered day group.** `renderMilestoneBody` keys an orphaned pulled turn by its own date at `src/mcp/timeline.ts:2425-2452`, but drains that map only while iterating `view.milestoneDayGroups` at `src/mcp/timeline.ts:2455-2497`; those groups are constructed only from paged main rows at `src/mcp/timeline.ts:1879-1925`. The earlier overflow calculation also excludes pulled turns at `src/mcp/timeline.ts:1551-1559`. Trigger: a skipped G2 antecedent on an earlier day, cited by two removable main rows on a later day, with no kept main row on the antecedent day; after both citers are removed, the antecedent has neither a `↳` row nor a `+N` count. This was reproduced read-only; the output counted the removed citers but omitted the antecedent.

3. **The 900-turn budget path is still quadratic in the page milestone count.** Each desc-removal and unit-removal step at `src/mcp/timeline.ts:2540-2562` rerenders the whole body and remeasures the whole assembled output; `renderMilestoneBody` also rebuilds homing maps at `src/mcp/timeline.ts:2410-2453`. The cache described at `src/mcp/timeline.ts:2375-2381` avoids repeated unit fitting, but not those full-body traversals or `estimateDiaryTokens` scans. A synthetic 900-main-row full-page view took about 1.64s for `renderTimeline(..., {tokenBudget: 2500})` and about 2.81s through the unchanged injection wrapper; there is no 900-turn regression/performance test.

## Minor

1. **The final trim ladder silently adds an un-specified file-drop step.** The file count is capped, but basename length is not, at `src/mcp/timeline.ts:2118-2126`. After title trimming and the sanctioned prompt-prefix step, `fitUnitTrim` sets `showFiles = false` at `src/mcp/timeline.ts:2326-2348`, then the unconditional backstop truncates the entire head line at `src/mcp/timeline.ts:2365-2367`. Thus termination is safe, but pathological file tails can silently disappear and the backstop can cut prompt/title text; the prompt trim itself does not guarantee the cap. Add a long-basename adversarial case and make the file-tail policy explicit.

2. **Required-change test coverage is incomplete.** The unit-cap assertions inherit the incorrect source constant (`tests/mcp/timeline.test.ts:3750-3758`, `:3835-3843`), and no test asserts a slash-command name on a milestone row. The frozen fixtures intentionally collect only body rows (`tests/mcp/timeline.test.ts:4264-4273`), so they do not exercise desc trimming, pathological file tails, or the default SessionStart path. The release sentinel comment also still says “100-token” at `tests/shared/release-artifacts.test.ts:167-176`.

## Verified clean

- `RenderTimelineOptions` exposes `titleCap`/`tokenBudget` without adding them to the strict public schema (`src/mcp/timeline.ts:73-91`, `src/mcp/definitions.ts:84-93`); the budget measure includes the assembled header/body/signals/hints (`src/mcp/timeline.ts:2911-2939`).
- Post-demotion grades propagate through `effGradeByTurnId`/`turnEffGrades` (`src/mcp/timeline.ts:1572-1577`, `:1805-1809`); page size remains main-row-only (`src/mcp/timeline.ts:1752-1762`), and phases, shape signals, and day headers remain on their existing paths.
- Rehoming carries all citer prompt numbers (`src/mcp/timeline.ts:1509-1515`) and recomputes against retained rows (`src/mcp/timeline.ts:2431-2437`); the cache key includes the ordered pulled IDs (`src/mcp/timeline.ts:2472-2478`), so no separate key-collision/stale-after-rehome defect was found.
- No live source path reads the deleted `CitedReference`/`resolveMilestoneReferences` mechanism; the remaining `parseContentReferences` caller supplies the required cap (`src/mcp/task-skeleton.ts:117-123`), and the updated release-artifact sentinels passed.

## Verification

- `bun test`: 1344 pass, 0 fail.
- `bunx tsc --noEmit`: pass.
- `git diff --check`: pass.

## Summary

Two explicit Rev 4 blockers remain: cap=100 and slash-command notify collapse.
Additional major defects are premature SessionStart output change, orphaned `+N` loss, and quadratic 900-turn fitting.
The hard-cap backstop terminates, but the exact trim ladder can drop unbounded file-tail text before clamping the head.
API/schema, grade propagation, page-size/phase/shape preservation, deletion cleanup, parser caller, and release sentinels otherwise checked clean.
Verification: `bun test` 1344/0, `bunx tsc --noEmit` pass, `git diff --check` pass.
