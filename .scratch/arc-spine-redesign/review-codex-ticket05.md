Verdict: fix first

## BLOCKER

- `src/worker/query-session.ts:474-485` still tells a corrective resend to use `remember({status:"skipped"})`. This contradicts the new skip contract at `src/worker/query-session.ts:396` (turn id, `grade: 0`, and minimal `title`) and the same prompt's no-id prohibition at `src/worker/query-session.ts:485`. The active retry copy is duplicated in `src/worker/derailment.ts:83-93`, and `src/worker/server.ts:1483-1490` / `1504-1511` actually sends it. `src/mcp/remember.ts:557-567` rejects a missing id, while `src/worker/derailment.ts:29-36` requires the current turn id before a work unit resolves. A no-extraction corrective resend therefore cannot persist the skipped row or resolve the required turn; it burns the reminder attempts and can reach the extraction floor. `tests/worker/derailment.test.ts:148-154` currently locks this bad guidance in. Update the corrective-resend wording and its test together.

## MINOR

- The new prompt pins are strong deletion sentinels but over-brittle and incomplete as behavior guards. `tests/worker/query-session.test.ts:663-747` asserts many long, punctuation-sensitive sentences, while the new coverage only captures the default `options.systemPrompt` at `tests/worker/query-session.test.ts:548-584`; it does not send a real sliced turn. The source wiring itself is correct: the one system prompt is installed at `src/worker/query-session.ts:340-353` and both ordinary and sliced messages use the same `promptStream` at `src/worker/query-session.ts:573-583`. The test also does not pin the Rev-4 reconciliation clause (`.scratch/arc-spine-redesign/spec.md:110` vs `src/worker/query-session.ts:391`) or the complete-knowledge-answer part of the new skip condition (`src/worker/query-session.ts:396`), so a rewording that reintroduces the item-3/item-4 tension could pass.

- Rounding direction is not directly regression-tested. `src/worker/processors.ts:281-283` uses nearest-integer `Math.round`; `tests/worker/processors.test.ts:534-641` covers the small-window branch, denominator, and strict boundary, but the 15% render assertion only checks absence/presence of `Deviation:` and never asserts a non-integral cell such as 7/40 → 18% or 6/40 → 15%. This is a coverage gap, not a current implementation failure.

## Confirmed clean

- Prompt/spec consistency: `src/worker/query-session.ts:383-391` preserves the deletion test, chain landing rule, troubleshooting cap, one-G4/re-foundation rule, and the amended “discovery rises only when it invalidates the arc’s own conclusions” exception. The latter agrees with `.scratch/arc-spine-redesign/spec.md:108-111`; the eval-validity discovery is the stated exception, not a contradiction.
- Cites guidance matches the implemented contract: `src/worker/query-session.ts:373-379` has the bare integer id, exact four-relation enum, empty-array meaning, replace-set, and mandatory `supersedes`/`implements`; `src/worker/query-session.ts:428` carries the complete-edge-set rule for slices. The server-side omitted/empty distinction and per-edge self/dangling drop are implemented at `src/mcp/remember.ts:379-383` and `src/db/citations.ts:220-239` (the prompt need not expose that sanitization).
- Calibration is correctly separated: pure rendering/gating is at `src/worker/processors.ts:244-323`; extraction-only 10-turn cadence and trailing-100 SQL remain in `src/worker/processors.ts:326-352`, with no status filter so skipped and NULL-grade rows stay in the denominator (`src/worker/processors.ts:340-348`). The tests cover `<30`, exact/above 15%, and all-row denominator semantics at `tests/worker/processors.test.ts:585-641`.
- No production or prompt density-alarm residue remains. The only `rg` hits are intentional negative assertions at `tests/worker/processors.test.ts:579-582`. The two new release sentinels at `tests/shared/release-artifacts.test.ts:146-147` are valid: one catches the calibration helper and one catches the prompt rubric in a stale worker bundle.
- Prompt growth is approximately 4,544 runtime characters / 775 whitespace-delimited words, or about 1.1k tokens at four characters per token; the default prompt grows about 22%. That is material for every turn but proportionate to the citation, grade, skip, and calibration rubric package, not disproportionate enough to be a finding.
- Verification: `bun test` passed 1,323 tests / 4,591 expectations; focused changed-file tests passed 67 tests; citation/derailment and remember tests passed 84 and 48 tests respectively; `git diff --check HEAD` passed. Generated bundles and the modified `.scratch` spec were not reviewed as diff scope.

## Summary

- Fix the corrective-resend skip call before commit; it is rejected by the real remember route and cannot satisfy the work-unit id gate.
- Prompt text otherwise agrees with Rev 4, including the newly amended discovery exception.
- Cites, calibration purity/cadence, denominator, strict boundary, and density-alarm removal are correct.
- Fresh and streamed flows share the assembled system prompt; streamed replace-set wording matches the write path.
- Test guards are useful but sentence-brittle and omit a real streamed slice and the reconciliation clause.
- Rounding direction lacks a direct assertion, but the current `Math.round` behavior is consistent.
- Prompt growth is ~1.1k tokens / ~22%, judged proportionate to the requested rubric.
- Full verification is green; only the corrective-resend finding blocks commit.
