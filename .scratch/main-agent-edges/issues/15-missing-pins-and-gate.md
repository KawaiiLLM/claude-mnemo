# 15 — The three lane readers get a blank-side pin, the merge survivor gets one, and the grep gate grows teeth

**What to build:** the pins the whole-batch peer review found missing (S15069/T2461) and the strengthened P3 gate (P2-E). Tests only, plus the gate.

**Blocked by:** 13 (the merge-survivor pin asserts ticket 13's rule).

**Status:** LANDED — report below.

## Findings, verified at 36af9878

- **DISCOVER** (`lane-checker-load.ts` ~1151–1175): resolved-side lane discovery has no fixture where the discovering side is DERIVED and not also re-discovered through the seed turn's tags.
- **WIDEN** (~1233–1249, ~1263–1310): resolved attribution deciding the judgment component has only stored-side fixtures; the supplementary pass masks a revert.
- **timeline shared loader** (`timeline.ts` ~4770–4859): every timeline edge fixture forces a non-empty side; no `tests/mcp/timeline*.test.ts` has a blank-side edge. One blank/blank edge between two turns that are unique members of one lane must pin the digest, the lane page and the adjacency at once.
- **Merge survivor** (ticket 13): after 13 lands, a pin that `mergeLaneTag` keeps `correct/full` over `use` on collision.
- **P2-E — the grep gate matches only a quoted literal that IS a relation word, and allowlists whole files** (`tests/shared/relation-word-release-gate.test.ts` ~42–49, ~92–105): `"write override edges"` in prose and a re-added `"override"` inside `schema.ts`/`lanes.ts` both pass.

## What to change

- [ ] One fixture per reader above where the resolved outcome and the stored tag DISAGREE (derived with blank stored side; a stored tag the resolver calls invalid), asserting the reader's output; for each, the revert probe (reader back to the stored tag) names the red test.
- [ ] The merge-survivor pin.
- [ ] The gate matches a relation word as a WORD inside any string literal or template (`\boverride\b`, `\bnarrows?\b`, `\bextends?\b`, `\bconsumes?\b`, `\bgrounds?\b`, `\bindexes\b`, `\bverif(y|ies)\b`, `\brefutes?\b`), the allowlist is per OCCURRENCE (file + exact literal) with a reason each, and a test injects one prose sentence into a teaching file in a temp copy and shows the gate red. Report what the per-occurrence allowlist admits.

## Constraints

- NEVER `git stash`/`checkout`/`checkout-index`/`restore`/`reset`/`clean`; restore from your own `cp` copies, md5-verified. Explicit pathspecs; never stage `plugin/scripts/*.cjs`; nothing under `.scratch/` but this ticket. No control bytes. No subagents. No version bump, no push.
- `npx tsc --noEmit` clean; `npm run typecheck:tests` no new errors in touched files; full `bun test` once with every delta accounted; `npm run build`; guards green; `git diff --check` clean.

## Report (LANDED)

Worktree `worktree-agent-aba382356b0ffab8b`, `git merge --ff-only main` clean (pulled in tickets 02b/13 and the rest of the batch). Baseline measured fresh at that point: **4793 pass / 1 fail / 276 files** — the 1 fail is `release-artifacts.test.ts`'s stale-bundle guard, pre-existing at the merge (the shipped `.cjs` bundles predate this whole batch); NOT the 4794/0/276 the brief assumed. Tests only, plus the gate — no production `.ts`/`.html` file differs from the merge base (every mutation used for a revert probe was applied, run, then restored from a `cp` backup and md5-verified byte-identical).

### (1) Reader fixtures — DISCOVER, WIDEN, timeline shared loader

- **DISCOVER** — `tests/db/lane-checker-load.test.ts`, describe "DISCOVER/WIDEN resolve a BLANK stored side to its DERIVED lane", test "DISCOVER: a lane is discovered through an unstored side on a NON-seed endpoint — reverting to the stored tag finds nothing". Fixture: a seed turn with an edge to a NON-seed turn that is the sole current member of one lane; the edge's side on that endpoint is stored blank. Asserts `projection.involvedLaneKeys` names the lane. Revert probe: `loadLaneCheckScope`'s discovery loop (~1170) mutated to read `row.tailTag`/`row.headTag` verbatim instead of `sideResolver.resolve(...).lane` — RED (`involvedLaneKeys` comes back `[]`), md5-restored.
- **WIDEN** — same file, test "WIDEN: the edge `toEdgeInput` hands the core carries the DERIVED tag, never the blank stored one — reverting to the stored tag blanks it out again". A candidate edge incident to a lane's sole member, undeclared on that side; asserts `named.edges[0]` carries the RESOLVED `headTag`/`headOutcome` (`"widen-derived-only"`/`"derived"`), not the blank stored one. Revert probe: `toEdgeInput` (the ONE place both the final `edges` array and `componentsOfLane`'s claim-check read a side's tag from) mutated to `tailTag: row.tailTag, headTag: row.headTag` — RED, 4 tests total (mine plus 3 pre-existing ones that also depend on `toEdgeInput`), md5-restored. NOTE: the WIDEN loop's own per-lane FILTER (~1244–1249) turned out NOT to be independently observable — a later unconditional "neighbourhood" pass (module comment: "one pass over every class-carrying edge touching a member") re-adds any edge touching a member regardless of that filter's decision, so a first attempt at this fixture (asserting on `named.edges` membership alone) stayed green under the filter's own revert. `toEdgeInput` is the real single point of truth downstream.
- **Timeline shared loader** (`loadFrontierEdges`, `src/mcp/timeline.ts`) — ONE fixture, THREE test files, per the ticket's "pin the digest, the lane page and the adjacency at once": a blank/blank edge between two turns that are each the sole current member of one lane.
  - `tests/mcp/timeline.frontier-section.test.ts`, describe "frontier section: a BLANK/BLANK edge between two SOLE lane members still counts", asserts the digest line `"#derived-only · 2 settled · 1 edges · islands 1+0"`.
  - `tests/mcp/timeline.lane-view.test.ts`, describe "E<n>/#<tag> route: …", asserts the CANONICAL-address route (`timelineQuery`) reports `"2 settled · 1 forward"`.
  - `tests/mcp/timeline.lane-adjacency.test.ts`, describe "ruled adjacency table: …", asserts the parsed header: `settled=2, forward=1, islands=1, singletons=0`.
  - Revert probe: `loadFrontierEdges`'s `tailTag: sides.tail.lane?.tag ?? ""` / `headTag: sides.head.lane?.tag ?? ""` mutated to `row.tailTag`/`row.headTag` — all THREE named tests RED simultaneously (digest → `0 edges · islands 0+2`; route → `0 forward`; adjacency → `forward=0`), md5-restored.

**Scope decision (flagged):** all three reader fixtures use the DERIVED-with-blank-stored-side scenario, not the "stored tag the resolver calls invalid" scenario the ticket's summary bullet also names. Reasoning kept in each finding's own text (DISCOVER: "no fixture where the discovering side is DERIVED"; WIDEN: same; timeline: "no blank-side edge") — all three findings are written in terms of the DERIVED case specifically. Structurally, an "invalid" stored tag cannot land on a candidate edge's OWN endpoint without contradicting that endpoint's current lane membership (an endpoint whose stored side is `invalid` w.r.t. lane L means L is NOT among its current tags, so it is never a "scanned member" of L to begin with) — every construction I tried collapsed back to a case already indistinguishable from `declared`/`none` at the OUTPUT level. If the parent wants an explicit `invalid` pin too, `tests/db/edge-side-resolution.test.ts` already carries the resolver-level one (ticket 02's probe #1); this ticket's readers did not get a second one.

### (2) Merge-survivor pin

Already landed by ticket 13: `tests/db/lanes.merge.test.ts`, describe "mergeLaneTag — one lane folded into another (ticket 15)", test "the MORE SPECIFIC class survives even at a HIGHER row id — specificity outranks id order" — `use` at the LOWER id, `correct/full` at the HIGHER id collide; `correct/full` survives. My OWN revert probe (not reusing ticket 13's report as evidence): `mergeLaneTag`'s collision loop (`src/db/lanes.ts` ~854) mutated from `selectLogicalEdgeRow(candidates)` back to the retired provenance/age rule (`sortLaneModelV12MergeGroup`, still live in-file for the unrelated v12 vocabulary migration) — RED (2 tests: the named one plus "EQUAL provenance keeps the LOWEST id", whose fixture also has mixed provenance), md5-restored.

### (3) The gate — `tests/shared/relation-word-release-gate.test.ts`, fully rewritten

- Matches each of the 8 patterns (`\boverride\b`, `\bnarrows?\b`, `\bextends?\b`, `\bconsumes?\b`, `\bgrounds?\b`, `\bindexes\b`, `\bverif(y|ies)\b`, `\brefutes?\b`) as a WORD anywhere inside any string/template literal in `src/**/*.{ts,html}` (comments stripped first), not just a literal whose ENTIRE contents equal one word. `refutes` (pre-v13, folded into `override` by lane-model-v12) is added to the word list — same shape of defect, same gate.
- Allowlist is now PER OCCURRENCE. **Deviation, flagged:** keyed on `(file, line)` rather than the literal text itself — two of the legitimate hits (`src/mcp/definitions.ts` lines 138/140, the `recall`/`timeline` tool descriptions) are 4.7–5.9KB single-line string literals that cannot practically be retyped into this test file as a match key. A `(file, line)` pair is unambiguous today (verified: no two hits share one) and, like a text key, goes stale — and fails the "still earning its place" test — the moment an unrelated edit moves the line, forcing a human back to the literal that moved.
- **92 occurrences admitted**, by reason class (full per-line table is in the test file itself):
  - **CURRENT class token** (`verify`, one of `correct|verify|use`) in teaching/tool-description prose and enumerations — 33 occurrences across `mcp/definitions.ts`, `mcp/note.ts`, `mcp/relations-view.ts`, `mcp/relation-tree.ts`, `shared/relation-class.ts`, `db/citations.ts`, and the settlement teaching modules (`note-settlement-prompt.ts`, `note-settlement-edge-pass-teaching.ts`, `note-settlement-turn-facade.ts`, `note-settlement-sdk-query.ts`).
  - **Ordinary English, unrelated to the vocabulary** — 33 occurrences: `narrow`/`narrows` as the verb "scope down" (tool error messages, schema DDL comments) — 17; `verify`/`verifies` as the ordinary verb "confirms/checks" (job-lease/decision language in settlement prompts) — 8; `ground truth` as the ordinary noun phrase — 8.
  - **schema.ts migration/legacy literal** (frozen word lists, DDL CHECK text for pre-cutover tables, legacy-word translation tables) — 24 occurrences, all in `src/db/schema.ts`.
  - **schema.ts CURRENT CHECK text** (the live `relation_class` column's own constraint, which legitimately enumerates `verify`) — 2 occurrences.
  - **Named single-purpose exceptions, one each:** `lanes.ts`'s `LANE_MODEL_V12_MERGE_TARGET`; `schema.ts`'s RULES-store refusal text (`'refute'`, an unrelated subsystem); `topic-tag.ts`'s stopword list (`"verify"`, `"verifies"`, two separate literals); `token-count.ts`'s tokenizer self-test string (`" extends"`, two occurrences — the word is arbitrary, chosen only because the smoke-test needs SOME real English word); `timeline.ts`'s `"latest override"` display label (kept BY NAME for the `correct/full` pointer per ticket 02's own disposition); `console-shell.html`'s `CLASSES`/`--rel-verify` (current class vocabulary published to the console UI, ticket 02's disposition).
- **Ticket 14 overlap (as warned):** several `CURRENT class token`/`ordinary English verify` entries sit in `note-settlement-sdk-query.ts` (lines 218, 229, 411, 418, 436) and `mcp/definitions.ts` (lines 138, 140, 212, 545, 709, 754, 1160, 1192, 1221) — files ticket 14 is editing in parallel to remove teaching sentences. If any of those sentences move or are deleted, the corresponding allowlist line(s) go stale and the "still earning its place" test catches it; the integrator reconciles by deleting the stale entry (or re-adding it at the sentence's new line, if the sentence survives elsewhere).
- **Injection test** (new): `describe("P2-E reproduction…")` copies `note-settlement-edge-pass-teaching.ts` into a temp `src/worker/…` tree, appends `export const TICKET_15_PROBE_SENTENCE = "write override edges";`, and runs the REAL gate predicate (`quotedRawWordHits` + the real `ALLOWLIST`) against the copy. Asserts: the OLD exact-literal regex does NOT match `"write override edges"` (reproducing the finding); the NEW word-boundary regex DOES; and the resulting `outside` list (hits minus allowlist) is non-empty — i.e., the gate goes RED on this tree. Test name: "`write override edges` injected into a temp copy of a teaching file is caught by the WORD regex and reds out the REAL gate predicate".
- Kept from the original: the whole-file-vs-per-occurrence stale-entry check (now per `(file,line)`), the comment-stripper sanity test; added a "no duplicate `(file,line)`" sanity test and a "bare word still matches" superset check.

### Probe table

| # | reader/predicate | file | mutation | applied? | red test(s) | restored (md5) |
|---|---|---|---|---|---|---|
| 1 | DISCOVER | `src/db/lane-checker-load.ts` | discovery loop reads `row.tailTag`/`row.headTag` verbatim | yes (diff shown, reverted) | "DISCOVER: a lane is discovered through an unstored side…" | `4fa1e971e060ad6389e03b70e7798916` |
| 2 | WIDEN | `src/db/lane-checker-load.ts` | `toEdgeInput` reads `row.tailTag`/`row.headTag` verbatim | yes | "WIDEN: the edge `toEdgeInput` hands the core carries the DERIVED tag…" (+3 pre-existing) | `4fa1e971e060ad6389e03b70e7798916` |
| 3 | timeline shared loader | `src/mcp/timeline.ts` | `loadFrontierEdges` reads `row.tailTag`/`row.headTag` verbatim | yes | digest + route + adjacency tests, all 3 | `2ce43fb999e3753539fc1fe948f21b46` |
| 4 | merge survivor | `src/db/lanes.ts` | collision winner picked by `sortLaneModelV12MergeGroup` (retired provenance/age rule) instead of `selectLogicalEdgeRow` | yes | "the MORE SPECIFIC class survives…" (+1 sibling) | `d25978643a94d82b5b77cc0072ff16cf` |
| 5 | gate injection | temp copy only, no `src/` mutation | `"write override edges"` appended to a copied teaching file | yes (temp, self-cleaning) | "…injected into a temp copy of a teaching file is caught by the WORD regex…" | n/a (no `src/` file touched) |

### Verification

`npx tsc --noEmit`: 0. `npm run typecheck:tests`: **326** total (identical to the ticket-13-landed baseline; the one error inside a touched file, `lane-checker-load.test.ts(97,6)`, is on an untouched pre-existing line — `insertTurn`'s own `.get(...)` call — confirmed by `git diff --stat` showing only insertions in that file). `npm run build`: clean. `bun test`: **4802 pass / 0 fail / 276 files** (baseline 4793/1/276 — the 1 was the pre-existing stale-bundle guard, fixed by `npm run build`; delta **+8** tests, 0 new files, fully accounted: `lane-checker-load.test.ts` +2, `timeline.frontier-section.test.ts` +1, `timeline.lane-view.test.ts` +1, `timeline.lane-adjacency.test.ts` +1, `relation-word-release-gate.test.ts` +3 net (3→6)). `bun test tests/shared/release-artifacts.test.ts`: 11/11. `git diff --check`: clean. Control-byte sweep over every touched diff: clean. `grep -c anthropic-ai plugin/scripts/worker.cjs`: 0. No `.scratch/` file touched outside this ticket. `plugin/scripts/*.cjs` rebuilt on disk (required for the release-artifacts guard) but never `git add`ed. No version bump, no push.

UNVERIFIED: whether the 326 `typecheck:tests` baseline is itself expected to the parent — inherited, not caused by this ticket, flagged rather than fixed (none of it is in a file this ticket owns).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017wgBfgUE6NJuqgHWpbVi2B
