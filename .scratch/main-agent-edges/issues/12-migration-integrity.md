# 12 — Migration integrity: tags normalised first, a rollback boundary that is real, receipts that count right

**What to build:** repairs from the whole-batch peer review (S15069/T2461, P1-1, P1-2, P2-A, P2-B, P3). After it, a database with malformed `turns.tags` opens and migrates; the rollback tool is deleted and the receipt tables alone carry the pre-cutover state; the fold receipt counts what it folded.

**Blocked by:** None — ticket 01 landed (45e23404).

**Status:** LANDED

## Findings, verified at 36af9878

- **P1-1 — the cutovers self-block.** `cutoverNamedTaskMembershipTags` (schema.ts ~6024, ~6197–6232) runs BEFORE the D9 one-shot, parses `turns.tags` leniently (malformed → `[]`) and then writes through `writeMembershipTags`, whose `readTurnTags` (segments.ts ~1349, turn-tags.ts:35–54) THROWS on invalid JSON / non-array. D9's tags normalisation (transform 1) never runs for such a row. If the earlier receipt already exists, a row can be left with `tags=[]` beside a `segment_members` row — two facts.
- **P2-B — the deferral window reads strictly too.** While the fence blocks, ordinary reads are allowed on the old schema, but `loadEndpointLaneFacts` (edge-side-resolution.ts ~241–255) uses the same strict reader, so a malformed row makes every lane read throw until D9 runs.
- **P1-2 — the rollback boundary is not the receipt-owned boundary.** `rollbackMainAgentEdgesCutover` (schema.ts ~5733–5817) checks only relations/tags stamps and edge ids above the archive max. Reproduced by the peer: a citing turn deleted after cutover → rollback restores a DANGLING edge; a forced-detach that leaves tags unchanged → silently restored; the cutover's own reset of pending `stage='edges'` jobs (~5438–5449: stage/generation/scratch) is neither archived nor restored.
- **P2-A — `resetNoteSettlementJobToStageOne`'s no-stage compatibility SQL reads `NULL AS stage AS stage`** (settlement-job-invalidation.ts ~278–305): a syntax error on the older additive shape.
- **P3 — `foldedPairs` reports 0 for a pair whose rows are one wordless + one class-bearing** (schema.ts ~5154–5183); the fold result is right, the receipt count is not.

## What to change

- [x] Tags normalisation is the FIRST migration step, before any membership cutover: NULL → `[]`, non-array/invalid → `[]`, non-string members dropped, receipted — the same rule D9 transform 1 states, applied once, early. `cutoverNamedTaskMembershipTags` then reads through the strict reader and cannot throw. (Subtraction, not accommodation: the lenient parse in the membership cutover goes.)
- [x] **RULED (user, S15069/T2464): option B — DELETE the rollback tool.** `rollbackMainAgentEdgesCutover`, its outcome/refusal types, its tests and any teaching that names it go; the six archive/receipt tables and the state marker STAY (they are the receipt; recovery, if ever needed, is a hand-written one-shot from them). The `written-since` checks go with the function. Update `main-agent-edges-cutover.ts`'s doc comment and the spec's D9 wording to say receipt-only. The pending-edges job reset at cutover stays as is (it is recorded in the receipt counts).
- [x] `resetNoteSettlementJobToStageOne` compat SQL is valid on both shapes; a test runs it against the additive (no-stage) shape.
- [x] `foldedPairs` counts every pair the fold touched, including wordless+class pairs; the clone report re-run states the new number beside the old.

## What to prove

- [x] A fixture DB with three malformed tags rows (`null`, `"not json"`, `{"a":1}`) inside a named task opens, migrates, and ends with `tags='[]'` rows and correct membership — and a revert probe (normalisation moved back after the membership cutover) drives it red.
- [x] The archive tables still hold byte-exact pre-cutover rows after the one-shot (pin the DDL, the row count and one row's full content against the clone) — that is what replaces the rollback test.
- [x] Revert probe per predicate, red test named; ≥3, verified applied, md5-restored.

## Constraints

- `~/.claude-mnemo/` STRICTLY READ-ONLY; clone runs on `cp -c` clones of `scratchpad/repro/copy.db`.
- NEVER `git stash`/`checkout`/`checkout-index`/`restore`/`reset`/`clean`; restore from your own `cp` copies, md5-verified.
- Explicit pathspecs; never stage `plugin/scripts/*.cjs`; nothing under `.scratch/` but this ticket. No control bytes; `grep -c anthropic-ai plugin/scripts/worker.cjs` = 0. No subagents. No version bump, no push.
- [x] `npx tsc --noEmit` clean; `npm run typecheck:tests` no new errors in touched files; full `bun test` once with every delta accounted (baseline 4785/0/274 at 36af9878); `npm run build`; guards green; `git diff --check` clean.

---

# REPORT (LANDED)

Branch `agent-a9e3b247dff3e2fc0`, commit see below. Baseline at `62cb3f94`
4785 pass / 0 fail / 274 files; after: **4788 pass / 0 fail / 276 files**.

## What changed

- `src/db/schema.ts` — new exported `normaliseTurnTagsInvariant` (D9 transform
  1, lifted out of the one-shot, own receipt `main-agent-edges-turn-tags`,
  called in `initializeSchema` immediately before `retireTopicRegistry`);
  `rollbackMainAgentEdgesCutover` DELETED with its `relax` rebuild mode and the
  archive-wipe loop; `cutoverNamedTaskMembershipTags` now parses with
  `readTurnTags`; `planMainAgentEdgesCutover` counts `foldedPairs` over the RAW
  pair population and no longer deletes for an ambiguous side.
- `src/db/main-agent-edges-cutover.ts` — receipt-only doc header;
  `MainAgentEdgesRollback{Outcome,Refusal}` deleted; state marker narrowed to
  `status = 'complete'` with `rolled_back_at_epoch` dropped;
  `TurnTagsNormalisationReceipt` added; `ambiguousDeleted` and the
  `deleted-ambiguous` disposition removed.
- `src/db/settlement-job-invalidation.ts` — `NULL AS stage AS stage` -> `NULL AS stage`.
- `.scratch/main-agent-edges/spec.md` — D9 rollback paragraph -> receipt-only;
  D9 gains transform 1's new position; the clone-report list drops "DELETED
  ambiguous edges".
- Tests: `tests/db/schema.turn-tags-normalisation.test.ts` (new, 3),
  `tests/db/settlement-job-invalidation.test.ts` (new, 2),
  `tests/db/schema.main-agent-edges-cutover.test.ts` (17 -> 15: three rollback
  tests out, one archive-is-the-receipt test in),
  `tests/db/membership-primitive.test.ts`, `tests/support/pre-cutover-edge-shape.ts`.

## Clone re-run (cp -c clone of `scratchpad/repro/copy.db`; production never opened)

| number | ticket 01 | now |
| --- | --- | --- |
| tags normalised | 21 turns (NULL) | 21 turns (NULL), own receipt |
| `foldedPairs` | 241 | **241** |
| by class / by sides only | 64 / 177 | 64 / 177 |
| redundant / invalid cleared | 4,944 / 0 | 4,944 / 0 |
| ambiguous deleted | 176 | **0 — the count no longer exists** |
| wordless deleted | 1,883 | 1,883 |
| rows before -> after | 5,682 -> 3,367 | 5,682 -> **3,543** |
| citers stamped | 2,133 | **2,064** |
| side-index rows | 696 | 696 |
| timing | open 6,681 ms / cutover 2,131 ms / 2nd open 22 ms | open 6,963 ms / cutover 2,057 ms / 2nd open 22 ms |

`foldedPairs` is UNCHANGED at 241 because the corpus has no wordless+class pair
at all (measured on a fenced clone: mixed pairs 0, all-wordless multi-row pairs
0). The old and the new predicate agree here; the fix is a receipt-correctness
fix whose population on this snapshot is empty.

The +176 rows are exactly the ambiguous-side edges transform 5 used to delete —
counted independently on the post-cutover clone (blank side, endpoint in >= 2
lanes: 176). Citers stamped falls by 69 for the same reason: those deletions
were stamping their citers and no longer happen.

Archive pinned against the clone: 5,682 edge rows / 21 tags rows / 0 membership
rows / 2,085 stamps / 13 DDL rows / 2 sequences; `segment_members` byte-identical
before and after; archived `memory_edges` DDL is the pre-cutover text verbatim;
lowest archived row reproduced in full in the worker report.

## Revert probes (5, each applied, red, md5-restored)

| # | mutation | red test |
| --- | --- | --- |
| 1 | `NULL AS stage` -> `NULL AS stage AS stage` | both of `resetNoteSettlementJobToStageOne on the additive (no-stage) shape` |
| 2 | `normaliseTurnTagsInvariant` moved after `cutoverNamedTaskMembershipTags` | `THE ORDER: three malformed tags rows inside a NAMED TASK ...` (throws `MalformedTurnTagsError`) |
| 3 | `foldedPairs` counted off the class-bearing group | `planMainAgentEdgesCutover names the fold population by its predicate ...` |
| 4 | transform 5's delete restored | 4 red, incl. `TRANSFORMS 3/4: ... leaves the edge STANDING` |
| 5 | tags counts taken from `run().changes` again | `THE ORDER: ...` |

Probe 2 is also what pins the strict-reader subtraction: with the lenient parse
still in `cutoverNamedTaskMembershipTags` the moved order would pass silently.

## Findings

- **The tags counts were inflated at ticket 01.** `run().changes` on `turns`
  includes the segment-facet stale triggers' own UPDATEs, so a member turn
  counted twice. Counts now come from the id sets read before the updates.
- **A citer whose only lost row was WORDLESS is still not stamped**, by the
  pinned teaching in `D1: every wordless row is DELETED into the receipt`
  ("deleting a wordless row is not a change to any citer's relation set").
  Left as is; flagged because `foldedPairs` now counts such a pair.
- `spec.md` line 123 (the Tests checklist) still says the receipt "restores
  every changed row byte-for-byte within the rollback boundary and refuses
  outside it". It is outside D9 and outside this ticket's pathspec allowance.

---

## Integrator adjudication (main, 2026-09-03)

Merged `0ff832cd` no-ff, clean; bundles rebuilt. `npx tsc --noEmit` 0; guards green. Full `bun test`
**4788 / 0 / 276** against 4785/0/274 — the worker's +3/+2/−2 exactly. Deletion closure grep for the
rollback tool and the ambiguous-delete disposition: one hit, a comment stating their absence.

My probes, on the normaliser's own predicates (the worker's five were order, counts, compat SQL and
transform 5):

| # | mutation in `schema.ts` `normaliseTurnTagsInvariant` | result |
|---|---|---|
| I1 | non-array JSON no longer coerced to `[]` (only invalid JSON) | RED ×2 (THE ORDER; TRANSFORM 1) |
| I2 | non-string members no longer dropped (EXISTS clause made unsatisfiable) | RED ×1 (TRANSFORM 1) — first attempt hit the wrong line and was discarded as not-a-probe; re-run with the applied diff shown |

Restored by `cp`, md5 verified. Accepted. The worker's flagged spec sentence (Tests checklist still
promising a byte-for-byte rollback) is annotated SUPERSEDED in this commit. Its other rulings stand as
stated: the normalisation commits in its own transaction before the one-shot (the deferral window
needs the value legal even when the one-shot never runs); `foldedPairs` did not move on this corpus
because the mixed wordless+class population is 0; a citer whose only lost row was wordless is still not
stamped (D1 teaching) — left as is.
