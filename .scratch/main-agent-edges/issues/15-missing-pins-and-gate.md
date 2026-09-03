# 15 — The three lane readers get a blank-side pin, the merge survivor gets one, and the grep gate grows teeth

**What to build:** the pins the whole-batch peer review found missing (S15069/T2461) and the strengthened P3 gate (P2-E). Tests only, plus the gate.

**Blocked by:** 13 (the merge-survivor pin asserts ticket 13's rule).

**Status:** ready-for-agent (after 13)

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
