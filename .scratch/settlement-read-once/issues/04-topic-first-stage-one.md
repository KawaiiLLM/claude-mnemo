# 04 — Stage 1 works topic-first

**What to build:** after the one read, the settlement writer lists the window's topics, declares a lane where no synonymous lane exists, tags each topic's turns in one call per topic, corrects the few titles/types/tags the audit caught, and finalizes. Spec D3.

**Blocked by:** 02.

**Status:** LANDED (branch `worktree-agent-a943632d96407d296`) — tsc 0; 4787/0/263 (+7 tests, +0 files); 6 mutation probes RED, md5-restored. Report below.

- [x] The stage-1 teaching in the unified prompt says the order: topics → `remember(create, id="E<n>/#tag")` for a missing lane (optionally with `members`) → the batch tag write per topic → per-turn `note` only for corrections → `finalize`. The audit (title, type, tags) is stated as a duty of the read; edits as the exception.
- [x] Multi-lane membership stated: a turn serving two topics is hit by both batch writes (additive union); each membership is judged on the turn's PRINCIPAL result, not a mention.
- [x] The retired per-turn tagging instruction and the "batches of ten" instruction are gone from shipped text; grep proves it.
- [x] Every added/removed sentence pinned; the golden samples (if any teach the old flow) rewritten.

## Constraints

- `~/.claude-mnemo/` is production data and STRICTLY READ-ONLY. Measure on a `cp -c` clone of the scratchpad copy.
- NEVER `git stash` / `checkout` / `checkout-index` / `restore` / `reset` / `clean` in the shared tree. Restore from your own `cp` copies, md5-verified.
- Explicit pathspecs on every `git add`. No raw control bytes in source. `grep -c anthropic-ai plugin/scripts/worker.cjs` stays `0`.
- Every teaching sentence added or removed is pinned by a test a mutation drives red. At least three mutation probes of your own, RED, md5-restored.
- [x] `npx tsc --noEmit` clean (excludes `tests/`; typecheck new tests separately); full `bun test` once (account for every delta against the baseline in your brief); `npm run build`; stale-bundle and release-artifacts guards green; `git diff --check` clean. Do NOT bump any version and do NOT push.

---

## Report (LANDED)

**Branch** `worktree-agent-a943632d96407d296`, ff-merged onto main at `3de2e897`
("build(read-once): rebuild bundles after ticket 02; adjudicate it").
Baseline reproduced before any edit: **4780 pass / 0 fail / 263 files**.
Final: **4787 pass / 0 fail / 263 files** — +7 tests, +0 files, all seven in the
one new `describe` appended to `tests/worker/note-settlement-unified-prompt.test.ts`.

### What the teaching now says

`renderNoteSettlementUnifiedPrompt` (`src/worker/note-settlement-unified-prompt.ts`).

**Procedure, PHASE 1** — the order, as steps, unchanged in count (1-4), so
PHASE 2 keeps its numbering 5-9:

- step 2 keeps its first sentence and gains the audit framing: the audit is a
  duty of the READ, judged on material the read already delivered, in the one
  pass that sees it; most turns take no write; edits are the EXCEPTION.
- step 3 now says LIST the topics and DECLARE a lane for every line no
  declared lane is a synonym for (it used to say only "do the WINDOW-SCOPE
  work (duties 3-6)").
- step 4 replaces "Write the final projection (duty 7), then call `finalize`
  (duty 8)" with the write order: ONE batch tag call per topic (duty 7) → the
  per-turn corrections (duty 8) → `finalize` (duty 9), plus the two ordering
  reasons (declare before tag; corrections after the batch).

**Duties** — duty 5 gains "BEFORE anything is tagged with that word … the
batch write in duty 7 refuses an undeclared word"; duty 7 is replaced whole;
duty 8 is new (corrections + removal); FINALIZE renumbers 8 → 9.

### The retired sentences

| retired | where | replaced by |
|---|---|---|
| `"7. WRITE the final projection, one \`note\` call per turn whose tags change."` | duty 7 | `"7. TAG each topic's turns in ONE call: \`note(turns:[…], task:"E<n>", addTags:["<lane>"])\`…"` |
| `"it is why the projection is written whole rather than patched."` | duty 7 tail | duty 8's removal path (the whole-set write survives as the CORRECTION/REMOVAL form, not the normal one) |
| `"in chronological batches of ten turns"` + `"Batches bound working memory and nothing else — they are never a line boundary."` + `"a full batch, or the whole writable set,"` | step 1 | `"in chronological order"` / `"the whole writable set in one page"` — a minimal hunk inside step 1, coordinated with ticket 01 (below) |

Grep over `src/` for the retired strings returns only two DOC-COMMENT
citations in `note-settlement-unified-prompt.ts`'s own header (the standing
convention: the header records what retired and why) — never rendered text.
The rendered-text proof is the `not.toContain` test, which a probe drives red.

### Multi-lane membership

Stated in duty 7, where the batch write is taught: a turn two topics run
through is named in BOTH calls, the union is the outcome, no special call and
nothing to reconcile; each membership judged on its own by the same test — the
turn's PRINCIPAL result serves that topic, a MENTION does not; multi-lane is
legitimate, tagging by mention is over-tagging.

### Two deliberate deviations from the acceptance wording

1. **`remember(create, id="E<n>/#tag")` is NOT taught.** The SETTLEMENT
   `remember` facade takes `id="E<n>"` + `tag`, and its `resolveOpenSegment`
   (`note-settlement-membership-facade.ts` ~345-357) refuses a lane address by
   name; the facade has no `members` parameter at all
   (`settlementMembershipWriteInputShape` is `action`/`tag`/`into`/`id`,
   `.strict()`). D3's form is the PUBLIC `remember`'s. Duty 5 therefore keeps
   the facade's own shape — teaching the spec's literal form would teach a
   call this run's tool refuses. Recorded in the module header too.
2. **`note-settlement-prompt.ts`'s "batches of ten" is left standing.** That
   file is the stage-`edges` RESUME prompt and its batch loop is stage 2's own
   read shape (BATCH STEP 1/2/3), which spec D6 and ticket 05 rewrite. It
   carries no stage-1 teaching at all — its BATCH STEP 1 says in terms "what
   you are NOT doing here is auditing the note, the type or the tags — the
   first pass settled those". Touching it here would collide head-on with
   ticket 05.

### The `note` tool description

`UNIFIED_NOTE_TOOL_DESCRIPTION` (`note-settlement-sdk-query.ts`) opened its
tag teaching with "Tags are the projection: a whole-set `tags` write …",
i.e. the retired shape at the point of use. It now leads with LANES ARE
ASSIGNED IN BATCHES (the call form, additive, all-or-nothing, a turn serving
two topics named in both calls) and keeps the whole-set write as the
CORRECTION and REMOVAL path. Pinned.

### `note-settlement-stage1.ts` — checked, untouched, and why

Its `NOTE_SETTLEMENT_STAGE_ONE_ALLOWED_TOOLS`, `STAGE_ONE_NOTE_TOOL_DESCRIPTION`,
`STAGE_ONE_REMEMBER_TOOL_DESCRIPTION` and `STAGE_ONE_FINALIZE_TOOL_DESCRIPTION`
have **zero consumers** in `src/` or `tests/` and **zero occurrences in the
shipped bundle** (`grep -c "TAGS ARE THE PROJECTION" plugin/scripts/worker.cjs`
→ 0) — dead exports left by settlement-execution-repair ticket 04's removal of
the stage-1-only registration site. Nothing retired ships from there ("one
`note` call per turn" never appears in them; the whole-set projection sentence
they carry is still TRUE of a per-turn write). Deleting them is a real cleanup
but an unpinned deletion outside this ticket's surface, so it is left as a
named follow-up rather than done silently.

### Golden samples

The only golden samples in this prompt are the two IMPRESSION samples
(`note-settlement-impression-teaching.ts`, `IMPRESSION_GOLDEN_SAMPLE_FULL` /
`_THIN`). Neither teaches tagging or the write flow — they are impression
prose — so none needed rewriting. There is no worked `note(...)` tagging
sample anywhere in the settlement prompts.

### Probes (6, all RED, all md5-restored)

| # | mutation | red test |
|---|---|---|
| 1 | duty 7's heading reinstates "WRITE the final projection, one `note` call per turn whose tags change" | 3 red (order, batch-write, retired-gone) |
| 2 | the multi-lane / PRINCIPAL-result block deleted from duty 7 | 1 red |
| 3 | step 4 swapped to corrections-then-per-turn-projection | 1 red (order) |
| 4 | step 1 reinstates "chronological batches of ten turns" | 1 red (retired-gone) |
| 5 | duty 8 loses "these calls run AFTER duty 7 … restate the lane words" | 1 red |
| 6 | `UNIFIED_NOTE_TOOL_DESCRIPTION` reverted to "Tags are the projection: …" | 1 red |

md5 after restore: `note-settlement-unified-prompt.ts`
`755ac0bdd4bb98da8fb81a0ad66d8ec3`, `note-settlement-sdk-query.ts`
`1200cb08a3b3c1254cc9ecf8527481a8` — both matching the pre-probe snapshot.

### Guards

`npx tsc --noEmit` → 0 (src). The edited test file typechecked separately
under a temporary tsconfig, then removed → 0. Full `bun test` 4787/0/263.
`npm run build` then `bun test tests/shared/release-artifacts.test.ts` → 11/0
(the stale-bundle guard was the single pre-build failure, as expected).
`git diff --check` clean; no control bytes;
`grep -c anthropic-ai plugin/scripts/worker.cjs` → 0. No version bump, no push.

### For the integrator

- **`src/worker/note-settlement-unified-prompt.ts` step 1** is shared with
  ticket 01. My hunk touches ONLY the first sentence (the batching clause and
  the "full batch" phrasing). I deliberately left ticket 01's read-shape
  sentences alone, including two surviving uses of the word "batch" —
  `"ADDRESS THE BATCH, NEVER SEARCH FOR IT"` and the YIELD-REPAIR clause
  `"THAT address alone, never the whole batch again"`. With the batching gone,
  "batch" there has no antecedent: **ticket 01's rewrite should absorb both.**
- **`tests/worker/note-settlement-unified-prompt.test.ts`**: three slice
  anchors were shortened from `"1. READ the writable set in chronological
  batches"` to `"1. READ the writable set in chronological"`, and the finalize
  anchor from `"8. FINALIZE."` to `"9. FINALIZE."`. Ticket 01 will touch the
  same three anchors.
- **`src/worker/note-settlement-sdk-query.ts`**: one edited sentence inside
  `UNIFIED_NOTE_TOOL_DESCRIPTION` only.
- `plugin/scripts/*.cjs` are rebuilt in the worktree but **NOT staged** — the
  integrator rebuilds after the merge.
