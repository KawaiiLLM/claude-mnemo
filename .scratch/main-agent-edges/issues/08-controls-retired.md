# 08 — Lane controls C1, C3, C4 are retired

**What to build:** spec D10. Delete `src/cli/lane-controls-cli.ts`'s C1 (blank sides), C3 (lane-less endpoints) and C4 (sampled side audit) with their tests and any documentation that teaches them; nothing replaces them (E6 accounting lives in `lane_check`; lane-less edges are legal; declarations are validated at write).

**Blocked by:** None.

**Status:** LANDED **VERIFIED S15069/T2435 at a2ea1c61 (merged abdbb7ba)**: tsc 0, 4803/0/266 (−14 = the deleted C1/C3/C4 tests, +sentinel block, net as reported), guards clean; my own grep over src/, plugin/skills/, docs/ finds no control identifier or "C1"/"C3"/"C4" literal outside the sentinel test; C2 remains (6 references). Deletion ticket: verification is grep + green + the surviving control, no mutation probe of my own beyond the agent's three sentinel probes.

- [x] Grep proves no reference remains in `src/`, `plugin/skills/`, docs; the CLI's remaining controls (if any) still run.

## Constraints

- `~/.claude-mnemo/` is production data and STRICTLY READ-ONLY; measure on a `cp -c` clone of the scratchpad copy.
- NEVER `git stash` / `checkout` / `checkout-index` / `restore` / `reset` / `clean`. Restore from your own `cp` copies, md5-verified.
- Explicit pathspecs on every `git add`. No raw control bytes. `grep -c anthropic-ai plugin/scripts/worker.cjs` stays `0`.
- Every teaching sentence added or removed is pinned by a test a mutation drives red. ≥3 mutation probes of your own, RED, md5-restored — and a probe whose mutation did not apply is not a probe.
- Dispose of every applicable line of `../acceptance-matrix.md` in your report.
- [x] `npx tsc --noEmit` clean (excludes `tests/`; typecheck new tests separately); full `bun test` once with every delta accounted; `npm run build`; stale-bundle and release-artifacts guards green; `git diff --check` clean. No version bump, no push.

## Report

**Branch:** `worktree-agent-adfca3554ee4ff113`, fast-forwarded onto `main` at `a75b95c5` before starting.

**What changed.** `src/cli/lane-controls-cli.ts`: deleted C1 (`controlUnsettledSides`, the `''`-sentinel unsettled-side control), C3 (`LaneLanelessNode`/`computeLanelessNodes`/`controlLanelessNodes`, the lane-less-endpoint control) and C4 (the whole gold-sample audit: `LaneGoldVerdict`, `LaneGoldSampleEdgeId`, `LaneGoldSampleRow`, `LaneGoldSample`, `LaneGoldStratumScore`, `LaneGoldScore`, `fnv1a`, `goldEdgeIdentity`, `drawGoldSample`, `isDecided`, `scoreGoldSample`, `controlGoldSample`, `readGradedSample`, and the `--sample`/`--export`/`--graded` CLI flags with their `writeFileSync`/`readFileSync` plumbing). `LaneControlId` narrowed from `"C1"|"C2"|"C3"|"C4"` to `"C2"`; `LaneControlsReport` lost `sample`/`exportPath`/`gradedPath`; the CAUSAL_MATRIX (the "judge C1-C3 before C4" doc block) and the "Sample artifacts" render section were removed since they only made sense across four controls; USAGE/help text trimmed to the one remaining control. C2 (`controlSideAttribution`, per-side declaration/subset violations on settled edges) and its shared plumbing (`addressLookup`, `edgeAddress`, `tailLaneOf`/`headLaneOf`, `cap`, `unmeasurable`, `missingCapabilityReason`, the capability probe) are untouched and still run. `src/db/lane-checker-load.ts`: only its doc comment updated ("The four reads..." → "The reads..., C1/C3/C4 retired..., only C2 remains"); no loader deleted, since `loadLaneControlCapability`/`loadLaneControlEdges`/`loadDeclaredLaneRegistry` still serve C2 and `loadLaneTagsForTurns` is a broadly shared loader used by `mcp/recall.ts` and `mcp/timeline.ts` (not C1/C3/C4-exclusive, left in place). Pre-existing dead imports in `lane-controls-cli.ts` (`loadDownstreamTurns`, `loadLaneCheckScope`, `loadSegmentsWithDeclaredLanes`, `checkLanes`, `formatLaneKey`, `DEFAULT_SEGMENT`, `laneToken`, the `downstreamLimit`/`--downstream` option) predate this ticket (leftover from the already-retired "terminus sample", lane-state-retirement ticket 01) and are out of scope — left untouched.

`tests/cli/lane-controls-cli.test.ts`: removed all C1/C3/C4-specific tests (14 of the original 33 `test()` blocks: the C1/C3/C4 quantity assertions, the C1-finding-address test, the causal-matrix-in-output describe, the gold-sample-stratification describe, the scoring/unmeasurable-gold describe, the export/graded round-trip describe, and the standalone `drawGoldSample`-is-pure describe). Kept and adapted: argument parsing (dropped `--sample`), the C2 quantity/finding tests, the pre-migration "never a zero" tests, the two loader-law tests (dropped the C3 half of the unparseable-tags test), and the read-only end-to-end tests (dropped the `--export` byte-identical run, replaced with a plain no-flags byte-identical run; the "ONE file write is --export's" test became "the tool writes no file at all", since `writeFileSync` is gone from both files entirely). Added a new sentinel describe block, `main-agent-edges ticket 8 — C1, C3 and C4 stay retired`, in the grep-sentinel style of `tests/shared/lane-state-retirement-deletions.test.ts`: pins that no C1/C3/C4 symbol, control id literal, or gold-sample machinery name appears in either source file; that `--sample`/`--export`/`--graded` are rejected as unrecognized flags; and that a built report carries no `sample`/`exportPath`/`gradedPath` field.

**Grep proof (the acceptance checkbox).**
```
$ grep -rln "lane-controls-cli" src/ tests/ plugin/ docs/
src/shared/lane-checker-render.ts     (doc-comment cross-reference only)
src/cli/lane-controls-cli.ts
src/db/lane-checker-load.ts           (doc-comment cross-reference only)
tests/shared/lane-state-retirement-deletions.test.ts   (unrelated grep sentinel, scans this file for OTHER retired symbols)
tests/cli/lane-controls-cli.test.ts
```
No hits at all in `plugin/skills/` or `docs/` for `lane-controls`, `LaneControl`, `drawGoldSample`, `goldSample`, `controlUnsettledSides`, `controlLanelessNodes`, `controlGoldSample`, or `sampled side audit` — nothing there ever taught these controls. Within `src/` and `tests/`, `controlUnsettledSides`, `controlLanelessNodes`, `controlGoldSample`, `computeLanelessNodes`, `LaneLanelessNode`, `drawGoldSample`, `scoreGoldSample`, `readGradedSample`, `goldEdgeIdentity`, `LaneGoldSample*`, `LaneGoldScore`, `LaneGoldVerdict` and the `"C1"`/`"C3"`/`"C4"` string literals appear nowhere — pinned by the new sentinel test (verified RED by 3 mutation probes below). The remaining control, C2, still runs end to end (19/19 tests pass in the CLI's own test file).

**Mutation probes (≥3, RED, md5-restored, no `git checkout`).** Baseline md5 of `src/cli/lane-controls-cli.ts`: `1385e11839f3d4a2953d7aa4cea830b3`.
1. Reintroduced `export function controlUnsettledSides(): void {}` → sentinel test failed (`must not contain "controlUnsettledSides"`) → removed via `Edit` → md5 back to `1385e11839f3d4a2953d7aa4cea830b3`.
2. Reintroduced `export interface LaneLanelessNode { id: number; }` → sentinel test failed (5 assertions, including this one) → removed via `Edit` → md5 back to `1385e11839f3d4a2953d7aa4cea830b3`.
3. Reintroduced `export function drawGoldSample(): void {}` → sentinel test failed (`must not contain "drawGoldSample"`) → removed via `Edit` → md5 back to `1385e11839f3d4a2953d7aa4cea830b3`.

All three probes were confirmed applied (the failure message quoted the exact mutated source) and each restore was verified against the pre-mutation hash, never via `git checkout`/`restore`/`reset`.

**Acceptance-matrix disposition (R9-1..9, R10-1..10).** None apply directly to this ticket. The matrix's lines are entirely about D9 (cutover), D2 (resolution/election), D6 (findings/derived closure), D1 (wordless-row retirement), tag normalisation, and settlement-job invalidation — none of it touches `lane-controls-cli.ts`, C1/C3/C4, or the gold-sample machinery this ticket retires. Confirmed by reading both round-9 and round-10 lists in full: no line names this file, D10, or the three retired controls.

**Test delta.** Baseline (main at `a75b95c5`, before this ticket): 4817 pass / 0 fail / 266 files. After: 4803 pass / 0 fail / 266 files. Delta = −14, exactly matching the 33→19 `test()` count drop in `tests/cli/lane-controls-cli.test.ts` (33 − 19 = 14). No other file's test count changed.

**Gates.** `npx tsc --noEmit` clean. `npm run build` clean (regenerates `plugin/scripts/*.cjs` — BUILD_ID drift only, per project convention; NOT staged, per instruction). `bun test tests/shared/release-artifacts.test.ts` — 11/11 pass. `git diff --check` — clean. `grep -c anthropic-ai plugin/scripts/worker.cjs` → `0`.

**Pre-existing, out of scope, noted but not fixed:** the fixture-construction code in `tests/cli/lane-controls-cli.test.ts` (verbatim from HEAD, untouched by this ticket) has several strict-`tsc` type errors — a raw-SQL `.get()` argument-count/type mismatch on the `T10`/`T11` inserts, and the `edge()` helper's `relation: string` not narrowing to `WriteEdgeInput`'s literal union. Confirmed present identically at HEAD (diffed a `git show HEAD:...` copy against the standalone strict-tsc run) — not introduced by this ticket, and `tests/` is excluded from the project's own `tsconfig.json` so `bun test` never caught them. Also pre-existing and untouched: dead imports/option (`loadDownstreamTurns`, `loadLaneCheckScope`, `loadSegmentsWithDeclaredLanes`, `checkLanes`, `formatLaneKey`, `DEFAULT_SEGMENT`, `laneToken`, `--downstream`) left over from the lane-state-retirement ticket 01's terminus-sample deletion — unrelated to C1/C3/C4, left as found.
