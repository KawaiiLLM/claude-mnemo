# 12 — Migration integrity: tags normalised first, a rollback boundary that is real, receipts that count right

**What to build:** repairs from the whole-batch peer review (S15069/T2461, P1-1, P1-2, P2-A, P2-B, P3). After it, a database with malformed `turns.tags` opens and migrates; the rollback tool refuses whenever ANY receipt-owned state moved after the cutover; the fold receipt counts what it folded.

**Blocked by:** None — ticket 01 landed (45e23404).

**Status:** ready-for-agent

## Findings, verified at 36af9878

- **P1-1 — the cutovers self-block.** `cutoverNamedTaskMembershipTags` (schema.ts ~6024, ~6197–6232) runs BEFORE the D9 one-shot, parses `turns.tags` leniently (malformed → `[]`) and then writes through `writeMembershipTags`, whose `readTurnTags` (segments.ts ~1349, turn-tags.ts:35–54) THROWS on invalid JSON / non-array. D9's tags normalisation (transform 1) never runs for such a row. If the earlier receipt already exists, a row can be left with `tags=[]` beside a `segment_members` row — two facts.
- **P2-B — the deferral window reads strictly too.** While the fence blocks, ordinary reads are allowed on the old schema, but `loadEndpointLaneFacts` (edge-side-resolution.ts ~241–255) uses the same strict reader, so a malformed row makes every lane read throw until D9 runs.
- **P1-2 — the rollback boundary is not the receipt-owned boundary.** `rollbackMainAgentEdgesCutover` (schema.ts ~5733–5817) checks only relations/tags stamps and edge ids above the archive max. Reproduced by the peer: a citing turn deleted after cutover → rollback restores a DANGLING edge; a forced-detach that leaves tags unchanged → silently restored; the cutover's own reset of pending `stage='edges'` jobs (~5438–5449: stage/generation/scratch) is neither archived nor restored.
- **P2-A — `resetNoteSettlementJobToStageOne`'s no-stage compatibility SQL reads `NULL AS stage AS stage`** (settlement-job-invalidation.ts ~278–305): a syntax error on the older additive shape.
- **P3 — `foldedPairs` reports 0 for a pair whose rows are one wordless + one class-bearing** (schema.ts ~5154–5183); the fold result is right, the receipt count is not.

## What to change

- [ ] Tags normalisation is the FIRST migration step, before any membership cutover: NULL → `[]`, non-array/invalid → `[]`, non-string members dropped, receipted — the same rule D9 transform 1 states, applied once, early. `cutoverNamedTaskMembershipTags` then reads through the strict reader and cannot throw. (Subtraction, not accommodation: the lenient parse in the membership cutover goes.)
- [ ] The rollback boundary is ANY movement of receipt-owned state since the recorded sequence: the global `write_gate_sequence` unchanged, every archived citing/cited turn still present, `segment_members` unchanged for archived turns (compare a digest recorded in the receipt), and the pending-edges job reset either archived-and-restored or made a refusal condition. Simplest rule wins; a rollback that cannot prove the world is as it left it REFUSES, naming what moved. Restoring a dangling edge must be impossible by construction.
- [ ] `resetNoteSettlementJobToStageOne` compat SQL is valid on both shapes; a test runs it against the additive (no-stage) shape.
- [ ] `foldedPairs` counts every pair the fold touched, including wordless+class pairs; the clone report re-run states the new number beside the old.

## What to prove

- [ ] A fixture DB with three malformed tags rows (`null`, `"not json"`, `{"a":1}`) inside a named task opens, migrates, and ends with `tags='[]'` rows and correct membership — and a revert probe (normalisation moved back after the membership cutover) drives it red.
- [ ] Three rollback refusals pinned: deleted citing turn, membership-only change, job reset — each RED when its check is removed.
- [ ] Revert probe per predicate, red test named; ≥3, verified applied, md5-restored.

## Constraints

- `~/.claude-mnemo/` STRICTLY READ-ONLY; clone runs on `cp -c` clones of `scratchpad/repro/copy.db`.
- NEVER `git stash`/`checkout`/`checkout-index`/`restore`/`reset`/`clean`; restore from your own `cp` copies, md5-verified.
- Explicit pathspecs; never stage `plugin/scripts/*.cjs`; nothing under `.scratch/` but this ticket. No control bytes; `grep -c anthropic-ai plugin/scripts/worker.cjs` = 0. No subagents. No version bump, no push.
- `npx tsc --noEmit` clean; `npm run typecheck:tests` no new errors in touched files; full `bun test` once with every delta accounted (baseline 4785/0/274 at 36af9878); `npm run build`; guards green; `git diff --check` clean.
