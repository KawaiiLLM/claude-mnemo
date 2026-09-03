# 14b — E6 is a warning on every surface: unified prompt, note tool description, shared renderer

**What to build:** the three places the peer's second pass (S15069/T2474, P1) found still teaching or rendering E6 as an error after ticket 14 demoted it (ruling S15069/T2465–T2466: an ambiguous side is a warning — reported, never blocking, never "must fix"). After this ticket no production text says E6 blocks, and the shared renderer prints E6 under a warnings heading, not under "ERRORS — grammar forbids; commit refuses".

**Blocked by:** None (14 landed, 29e18985).

**Status:** LANDED

## Findings, verified at b8a80ddf

1. `src/worker/note-settlement-unified-prompt.ts` ~468–483 still tells the unified run that E4 and E6 anchored on its turns both block its commit; `tests/worker/note-settlement-unified-prompt.test.ts` ~364–383 pins the old sentence.
2. `src/worker/note-settlement-sdk-query.ts` ~362–368: the production `SETTLEMENT_NOTE_TOOL_DESCRIPTION` says "It is error E6 … and commit refuses while one remains in your writable set: `declare` it, or retract the row" (registered at ~2216).
3. `src/shared/lane-checker-render.ts` ~545–568, ~781–789 puts every E6 in `result.errors`'s "## ERRORS — grammar forbids; commit refuses" block (the header comment at ~47–58 calls that deliberate); the CLI (`src/cli/lane-check-cli.ts` ~234) and the console (`src/worker/console-api.ts` ~1538) use this renderer; `tests/shared/lane-checker-render.test.ts` ~402–440 asserts E6 in the ERRORS block. Note `src/shared/lane-checker.ts` already types E6 as `LaneWarningClass` — the renderer is reading the class from the wrong list.

## What to change

- [x] Unified prompt: E6 is described as a warning the run MAY declare and may leave; only E4 (and E3) block. Retired sentence absent from rendered text; new one pinned.
- [x] `SETTLEMENT_NOTE_TOOL_DESCRIPTION`: same — "warning E6 … you may `declare` it; it never refuses commit"; E4 keeps its wording. Pinned; retired wording absent from the registered description (assert on the string the server registers, not only the constant).
- [x] Renderer: E6 rows print under a WARNINGS heading (reuse the existing warnings block if one exists; do not add a third block), never under ERRORS; the D9 unattributed-cluster subject may still name them. CLI and console outputs follow by construction; update `lane-checker-render.test.ts` to assert E6 under warnings and E3/E4 under ERRORS, and one CLI/console rendering test each if they pin the block text.

## What to prove

- [x] `grep -rn "E6" src/worker/note-settlement-unified-prompt.ts src/worker/note-settlement-sdk-query.ts src/shared/lane-checker-render.ts` — every remaining mention reads as a warning; quote them in the report.
- [x] Revert probes: each of the three changes reverted → its pin red; ≥3, verified applied by diff, md5-restored.

## Constraints

- NEVER `git stash`/`checkout`/`checkout-index`/`restore`/`reset`/`clean`; restore from `cp` copies, md5-verified. Explicit pathspecs; never stage `plugin/scripts/*.cjs`; nothing under `.scratch/` but this ticket. No control bytes; `grep -c anthropic-ai plugin/scripts/worker.cjs` = 0. No subagents. No version bump, no push. `~/.claude-mnemo/` read-only.
- `npx tsc --noEmit` clean; `npm run typecheck:tests` no new errors in touched files; full `bun test` once with every delta accounted (baseline 4801/0/276 at b8a80ddf); `npm run build`; guards green; `git diff --check` clean. The raw-word gate (`tests/shared/relation-word-release-gate.test.ts`) keys its allowlist on exact literals — if you edit a literal it names (two `verifies` sentences in `note-settlement-sdk-query.ts`), update that entry's literal in the same commit.

## Report (LANDED)

Branch `worktree-agent-af1feadaae3502c51`, worktree fast-forwarded onto `main` at `de1fc813` before work started (`git merge --ff-only main` — a huge but clean fast-forward, the worktree had been stale since well before ticket 14). Baseline confirmed at 4801/0/276.

### Item 1 — unified prompt (`note-settlement-unified-prompt.ts` ~481–485)

The sentence "E4 and E6 anchored on that same turn ARE yours — both are relation grammar, both are repaired by a `declare` entry or a retraction, and both block your `commit`" is retired. Replacement: E4 alone is stated to block; E6 is named a WARNING the run MAY `declare` (where the material it already holds says which lane) and MAY leave. `tests/worker/note-settlement-unified-prompt.test.ts`'s "the stored-side teaching is absent from the RENDERED prompt" test now retires the old sentence (3 new absence pins) and asserts the new one present (4 new pins), each checked against the RENDERED text, not the source constant.

Also fixed a second, un-cited stale mention in the same file's module-doc header (~200–205): a historical incident paragraph ("The gate is correct — E6 is an ERROR by spec") was true when written (before ticket 14) but reads as current teaching out of context. Reworded to past tense with an explicit "ticket 14 later demoted it to a warning" note. Doc-comment only, never rendered to the model; not gated by any test.

### Item 2 — `SETTLEMENT_NOTE_TOOL_DESCRIPTION` (`note-settlement-sdk-query.ts` ~365–367)

"It is error E6 only where the endpoint sits in SEVERAL lanes and no side is declared, and commit refuses while one remains in your writable set: `declare` it, or retract the row" → "It is warning E6 where the endpoint sits in SEVERAL lanes and no side is declared — you may `declare` it where the material you are already holding says which lane; it never refuses commit." Registered at ~2216 (settlement's own `note` tool; the unified run's `note` tool uses the separate `UNIFIED_NOTE_TOOL_DESCRIPTION`, which never mentioned E6). Asserted BOTH ways per the ticket's instruction to check the registered string, not only the constant: `tests/shared/tag-mandate-teaching-surfaces.test.ts`'s own test on the exported constant, and a new block appended to `note-settlement-sdk-query.test.ts`'s existing "the registered note tool's description teaches the three classes" test (line ~1030), which captures `descriptions.get("note")` from the actual `leasedTool(...)` registration the server makes.

**A second, un-cited stale site found while sweeping the file's own `E6` occurrences**: `SETTLEMENT_COMMIT_TOOL_DESCRIPTION`'s `report`-field friction examples named "(E4/E6)" as things causing "a commit-gate refusal ... you had to route around" — i.e. it taught E6 as a live blocking class, same defect as items 1/2, just in a different exported constant the ticket didn't name. Fixed to "(E4)" alone, mirroring exactly the reasoning the file's own adjacent comment already used for E3's removal ("Ticket 17: E3 left the blocking set ... naming it here would ask for friction that cannot happen"); the same logic now applies to E6. `tests/worker/note-settlement-sdk-query.test.ts`'s "names all four categories" test updated: `.toContain("(E4)")`, `.not.toContain("(E4/E6)")`, comment extended.

### Item 3 — shared renderer (`lane-checker-render.ts`)

`renderLaneCheckerReports` (used by both the CLI at `lane-check-cli.ts:234` and the console at `console-api.ts:1538`, so both follow by construction) now splits `result.errors` by class before rendering: E3/E4 print under `## ERRORS` exactly as before (kept UNCAPPED, same count-line shape); E6 rows print under the SAME `## WARNINGS` block, right after `LANE_CHECK_WARNING_NOTICE` — no third section — as a `"<n> ambiguous side(s) (E6) -- warning; declare it or leave it, never blocks commit"` line followed by the per-instance `[E6] ...` lines, reusing the identical `renderLaneError`/`errorInstanceLines` helpers ERRORS already used (one fact, one formatter, two possible sections). `renderLaneCheckerReportsPaged` (the settlement `lane_check` tool's own paged surface) was already correct — it takes an explicit `classifyError` predicate from the finding-class module at its real call sites and was untouched; its own test that calls it with no predicate (`buildLargeLaneCheckerFixture`, default `() => "blocking"`) is unaffected by this ticket and stays green.

The module header (~45–66) previously stated "Both surfaces lead with an ERRORS block — E3/E4/E6" and called E6-in-ERRORS "deliberate." Rewritten to name `renderLaneCheckerReports` specifically, state E3/E4 in ERRORS and E6 in WARNINGS, and clarify that E3's FURTHER narrowing (by authority, to informational) is a `renderLaneCheckerReportsPaged`-only behavior this function does not share — `renderLaneCheckerReports` itself keeps every E3 under ERRORS, unchanged, per the ticket's "keep E3/E4 exactly where they are."

`renderLaneDigraph` (CLI-only, human/graph output, gated behind a separate flag, not cited in the ticket's finding and not named in its acceptance grep list) is UNCHANGED — its own `"ERRORS (" + n + ")"` line and inline `✗[...]` marks still include E6. Flagging this as a deliberate scope boundary: the ticket's three citations (~545–568, ~781–789 for the header constants they reference, plus the unified prompt and the note-tool description) never reach the digraph function at ~1487+, and "CLI and console outputs follow by construction" only requires `renderLaneCheckerReports` to be fixed (console never calls the digraph at all). If the digraph's own E6-in-ERRORS presentation should also change, that's a follow-up outside this ticket's stated boundary — not built here.

Tests updated: `tests/shared/lane-checker-render.test.ts`'s "an E6 draft edge renders in the ERRORS block" renamed/rewritten to assert the ERRORS block is `(none)`, the E6 lines sit under WARNINGS, and the count line reads `"3 ambiguous side(s) (E6)"`. `tests/shared/lane-checker.test.ts`'s golden-fixture test (the one real corpus with exactly one E6 and nothing else) similarly rewritten: `## ERRORS` now leads with `(none)`, `"1 ambiguous side(s) (E6)"` and the `[E6]` line appear under `## WARNINGS`. Neither `lane-check-cli.test.ts` nor `console-api.test.ts` pins ERRORS/WARNINGS/E6 block text directly (both call the shared renderer and compare byte-for-byte against its own output), so neither needed an edit — confirmed by grep, zero matches.

### What to prove

`grep -n "E6" src/worker/note-settlement-unified-prompt.ts src/worker/note-settlement-sdk-query.ts src/shared/lane-checker-render.ts` — every remaining mention (quoted below) reads as a warning, a neutral class-taxonomy reference (e.g. "E3/E4/E6" enumerating the type union), or explicit past-tense history. None claim E6 currently blocks `commit`.

Revert probes (3, each `cp`-backed up before the ticket's edits, md5-verified restored after):

| # | file reverted | red test |
|---|---|---|
| P1 | `note-settlement-unified-prompt.ts` E4/E6 sentence reverted to the old wording | `tests/worker/note-settlement-unified-prompt.test.ts` — "the stored-side teaching is absent from the RENDERED prompt" (the new-sentence retired-list assertion, `present: true` vs expected `false`) |
| P2 | `note-settlement-sdk-query.ts` `SETTLEMENT_NOTE_TOOL_DESCRIPTION` E6 sentence reverted | `tests/worker/note-settlement-sdk-query.test.ts` — "the registered note tool's description teaches the three classes..." (`.not.toContain("It is error E6 only where the")` failed) |
| P3 | `lane-checker-render.ts` `renderLaneCheckerReports` split logic reverted | `tests/shared/lane-checker-render.test.ts`'s renamed E6 test AND `tests/shared/lane-checker.test.ts`'s golden-fixture test both went red (ERRORS block held `3 error(s)` / `1 error(s)` instead of `(none)`) |

All three files restored via `cp` from `/tmp/e6-probe-backup/*.new`, md5-matched against the pre-restore backup after each probe.

### Verification

`npx tsc --noEmit` → 0. `npm run typecheck:tests` → 326 pre-existing errors, none in any of the six touched files (three source, three test) at the lines I edited — cross-checked line-by-line; the handful of errors that DO land in two of my touched test files (`note-settlement-sdk-query.test.ts` L4463/4602/4625/4631: `laneTurnIds`/`nowMs` API drift; `lane-checker.test.ts` L1665: a `citedId` narrowing gap) sit far from my edits and are structural fallout of the huge stale-worktree merge, not something I introduced — confirmed by diffing my hunks against those line numbers. Full `bun test` → **4801 pass / 0 fail / 276 files**, exactly the baseline; no test count delta (I only edited assertions inside existing `test()` blocks, added none). `npm run build` → clean, bundles rebuilt (rebuilt a second time after the late "(E4/E6)"→"(E4)" fix, which had gone stale against the first build). `bun test tests/shared/release-artifacts.test.ts` → 11/0. `git diff --check` → clean. `grep -c anthropic-ai plugin/scripts/worker.cjs` → 0. Nothing under `.scratch/` touched but this ticket file. `tests/shared/relation-word-release-gate.test.ts` (the integrator's file) — not edited, still 8/0; my edits never touched either of its two allowlisted `verifies` literals in `note-settlement-sdk-query.ts` (lines 619/626, unrelated "commit verifies your job lease" sentences).

`grep -n "E6" src/worker/note-settlement-unified-prompt.ts src/worker/note-settlement-sdk-query.ts src/shared/lane-checker-render.ts`:

```
note-settlement-unified-prompt.ts:201:   bare addresses; its first `lane_check` returned 39 E6 findings and the run
note-settlement-unified-prompt.ts:203:   them with `tailTag`/`headTag`. The gate was correct then — E6 was an
note-settlement-unified-prompt.ts:430:  // E6 entry, "before any edge write, recall the citing turn", and a
note-settlement-unified-prompt.ts:484:  "entry or a retraction, and it blocks your `commit`. E6 anchored there is",
lane-checker-render.ts:51:  * (connectivity, coupling, bypass candidates, time-order, attribution, E6,
lane-checker-render.ts:52:  * and the stock facts no report admits). E6 is a warning by CLASS
lane-checker-render.ts:61:  * E6 (an AMBIGUOUS side) prints in BOTH the WARNINGS grammar-finding lines
lane-checker-render.ts:131: * the ABSENCE of a lane, and `E60:{}` reads like a lane whose tag is the empty
lane-checker-render.ts:471:   case "E6":
lane-checker-render.ts:556:  // MAIN-AGENT-EDGES TICKET 14b: E6 is a WARNING class (`LaneWarningClass`,
lane-checker-render.ts:559:  const blockingErrors = result.errors.filter((error) => error.class !== "E6");
lane-checker-render.ts:560:  const ambiguousSides = result.errors.filter((error) => error.class === "E6");
lane-checker-render.ts:581:  // E6 reuses this SAME warnings block — no third section — one line per
lane-checker-render.ts:588:    " ambiguous side(s) (E6) -- warning; declare it or leave it, never blocks commit" +
lane-checker-render.ts:657:  "## Attribution ... ALSO listed one by one as E6 above ... neither blocks commit)",
lane-checker-render.ts:901:  *   - `errors` (E3/E4/E6) — `window.has(error.anchorId)`. This is the ONE
lane-checker-render.ts:1196: "## Attribution ... ALSO listed one by one as E6 above ... neither blocks commit)",
note-settlement-sdk-query.ts:153:  *      never on E6 (an ambiguous side is legal; ruling S15069/T2465-T2466) —
note-settlement-sdk-query.ts:349:  // ONLY through `declare` (D4) — the two-sided draft-and-E6 teaching that
note-settlement-sdk-query.ts:365:  "the side derives, and nothing is owed. It is warning E6 where the " +
note-settlement-sdk-query.ts:515:  "or more lanes, so nothing derives which one it means (E6), naming the side. " +
note-settlement-sdk-query.ts:523:  "you one it will not. TWO CLASSES ARE IN THE BLOCK AND NEVER BLOCK. An E6 " +
note-settlement-sdk-query.ts:563:  "E6 above, on purpose and not as a double count: the cluster tells you the " +
note-settlement-sdk-query.ts:564:  "SCALE of what is unattributed, E6 is the per-row list commit judges. " +
note-settlement-sdk-query.ts:664:  "its endpoint sits in several lanes (E6) is a warning you may act on and may " +
note-settlement-sdk-query.ts:1128: * refusal moved into the pre-commit gate sequence (after the E3/E4/E6 lane
note-settlement-sdk-query.ts:1391:   // E6 IS A WARNING (ruling S15069/T2465-T2466). It reaches this renderer
note-settlement-sdk-query.ts:1396:   case "E6":
note-settlement-sdk-query.ts:1398:     `[E6] ${anchor}: ${error.relation} -> ...` — AMBIGUOUS side, ` +
note-settlement-sdk-query.ts:1408: // Exhaustive over the grammar classes today (E3/E4 errors + the E6
note-settlement-sdk-query.ts:1901:   // commit went on to mark the job `done` over the newly minted E6/E4 or the
note-settlement-sdk-query.ts:1971:     // the order they always ran (an E3/E4/E6 grammar error is this window's
```

All pre-existing mentions not touched by items 1–3 above were already warning-worded or neutral from ticket 14's own landing — verified none assert E6 blocks.

---

## Integrator adjudication (main, 2026-09-03)

Merged `b68b5cfe` no-ff, clean; bundles rebuilt. `npx tsc --noEmit` 0; guards green. Full `bun test`
**4802 / 0 / 276** = 4801 + the integrator's one new gate test (`9c3b2750`); the ticket itself adds no
test count. One more stale sentence found by my own grep and fixed here: the D9 cluster teaching in
`note-settlement-sdk-query.ts` still said "E6 is the per-row list commit judges" → "the per-row list you
may declare from" (no pin named the old wording; the surrounding block's tests stay green).

My probe: the renderer's E6 split disabled (`=== "E5"`) → RED, "an E6 draft edge renders under WARNINGS
… and the ERRORS block stays empty". Restored, md5 verified. Accepted, including the two extra sites the
worker found (the commit tool's `(E4/E6)` friction example, the module-doc incident paragraph).
Flagged and left: `renderLaneDigraph` (CLI-only, flag-gated) still prints E6 in its `ERRORS (n)` line —
a one-line follow-up when someone next touches that renderer, not a release matter.
