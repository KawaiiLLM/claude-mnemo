# 14b — E6 is a warning on every surface: unified prompt, note tool description, shared renderer

**What to build:** the three places the peer's second pass (S15069/T2474, P1) found still teaching or rendering E6 as an error after ticket 14 demoted it (ruling S15069/T2465–T2466: an ambiguous side is a warning — reported, never blocking, never "must fix"). After this ticket no production text says E6 blocks, and the shared renderer prints E6 under a warnings heading, not under "ERRORS — grammar forbids; commit refuses".

**Blocked by:** None (14 landed, 29e18985).

**Status:** ready-for-agent

## Findings, verified at b8a80ddf

1. `src/worker/note-settlement-unified-prompt.ts` ~468–483 still tells the unified run that E4 and E6 anchored on its turns both block its commit; `tests/worker/note-settlement-unified-prompt.test.ts` ~364–383 pins the old sentence.
2. `src/worker/note-settlement-sdk-query.ts` ~362–368: the production `SETTLEMENT_NOTE_TOOL_DESCRIPTION` says "It is error E6 … and commit refuses while one remains in your writable set: `declare` it, or retract the row" (registered at ~2216).
3. `src/shared/lane-checker-render.ts` ~545–568, ~781–789 puts every E6 in `result.errors`'s "## ERRORS — grammar forbids; commit refuses" block (the header comment at ~47–58 calls that deliberate); the CLI (`src/cli/lane-check-cli.ts` ~234) and the console (`src/worker/console-api.ts` ~1538) use this renderer; `tests/shared/lane-checker-render.test.ts` ~402–440 asserts E6 in the ERRORS block. Note `src/shared/lane-checker.ts` already types E6 as `LaneWarningClass` — the renderer is reading the class from the wrong list.

## What to change

- [ ] Unified prompt: E6 is described as a warning the run MAY declare and may leave; only E4 (and E3) block. Retired sentence absent from rendered text; new one pinned.
- [ ] `SETTLEMENT_NOTE_TOOL_DESCRIPTION`: same — "warning E6 … you may `declare` it; it never refuses commit"; E4 keeps its wording. Pinned; retired wording absent from the registered description (assert on the string the server registers, not only the constant).
- [ ] Renderer: E6 rows print under a WARNINGS heading (reuse the existing warnings block if one exists; do not add a third block), never under ERRORS; the D9 unattributed-cluster subject may still name them. CLI and console outputs follow by construction; update `lane-checker-render.test.ts` to assert E6 under warnings and E3/E4 under ERRORS, and one CLI/console rendering test each if they pin the block text.

## What to prove

- [ ] `grep -rn "E6" src/worker/note-settlement-unified-prompt.ts src/worker/note-settlement-sdk-query.ts src/shared/lane-checker-render.ts` — every remaining mention reads as a warning; quote them in the report.
- [ ] Revert probes: each of the three changes reverted → its pin red; ≥3, verified applied by diff, md5-restored.

## Constraints

- NEVER `git stash`/`checkout`/`checkout-index`/`restore`/`reset`/`clean`; restore from `cp` copies, md5-verified. Explicit pathspecs; never stage `plugin/scripts/*.cjs`; nothing under `.scratch/` but this ticket. No control bytes; `grep -c anthropic-ai plugin/scripts/worker.cjs` = 0. No subagents. No version bump, no push. `~/.claude-mnemo/` read-only.
- `npx tsc --noEmit` clean; `npm run typecheck:tests` no new errors in touched files; full `bun test` once with every delta accounted (baseline 4801/0/276 at b8a80ddf); `npm run build`; guards green; `git diff --check` clean. The raw-word gate (`tests/shared/relation-word-release-gate.test.ts`) keys its allowlist on exact literals — if you edit a literal it names (two `verifies` sentences in `note-settlement-sdk-query.ts`), update that entry's literal in the same commit.
